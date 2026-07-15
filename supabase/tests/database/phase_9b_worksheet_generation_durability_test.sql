begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(42);

-- Stable worker/API signatures and service-only completion privileges.
select ok(
  to_regprocedure('public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)') is not null,
  'worksheet generation completion has the stable worker signature'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    ),
  'the service role completes worksheets only through the gated API'
);
select ok(
  to_regprocedure('api.request_practice_worksheet(uuid)') is not null
    and has_function_privilege(
      'authenticated',
      'api.request_practice_worksheet(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.request_practice_worksheet(uuid)',
      'EXECUTE'
    ),
  'authenticated users request worksheets through the API facade only'
);

-- Shared-staging execution must never claim, archive, or delete an unrelated
-- durable job. The production claimer is intentionally queue-wide, so this
-- rollback-only test helper leases only the exact fixture job/message pair
-- before exercising the real completion APIs. It mirrors the claim-side state
-- transition without calling a global consumer.
create or replace function pg_temp.claim_phase_9b_fixture_job(
  target_job_id uuid,
  target_queue_message_id bigint,
  target_worker_id uuid,
  visibility_timeout_seconds integer default 180
)
returns table (
  job_id uuid,
  queue_message_id bigint,
  entity_id uuid,
  entity_version integer,
  attempt_number integer,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_payload jsonb;
  visibility_seconds integer := greatest(
    30,
    least(coalesce(visibility_timeout_seconds, 180), 600)
  );
begin
  perform app_private.assert_service_role();

  if target_job_id is null
    or target_queue_message_id is null
    or target_worker_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'phase_9b_fixture_claim_required';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation'
    and job.queue_name = 'worksheet_generation'
    and job.queue_message_id = target_queue_message_id
  for update;

  if selected_job.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'phase_9b_fixture_job_not_found';
  end if;

  select queue.message
  into selected_payload
  from pgmq.q_worksheet_generation queue
  where queue.msg_id = target_queue_message_id
  for update;

  if selected_payload is distinct from jsonb_build_object(
    'job_id', selected_job.id,
    'job_kind', selected_job.job_kind,
    'entity_id', selected_job.entity_id,
    'entity_version', selected_job.entity_version
  ) then
    raise exception using
      errcode = '55000',
      message = 'phase_9b_fixture_message_mismatch';
  end if;

  update pgmq.q_worksheet_generation queue
  set
    vt = clock_timestamp() + make_interval(secs => visibility_seconds),
    read_ct = queue.read_ct + 1
  where queue.msg_id = target_queue_message_id
    and queue.vt <= clock_timestamp()
  returning queue.message into selected_payload;

  if selected_payload is null then
    raise exception using
      errcode = '55000',
      message = 'phase_9b_fixture_message_not_visible';
  end if;

  update app_private.async_jobs job
  set
    status = 'processing',
    attempt_count = job.attempt_count + 1,
    worker_id = target_worker_id,
    lease_expires_at = now() + make_interval(secs => visibility_seconds),
    first_started_at = coalesce(job.first_started_at, now()),
    last_started_at = now(),
    last_error_code = null
  where job.id = selected_job.id
    and job.available_at <= now()
    and (
      job.status in ('queued', 'retry')
      or (job.status = 'processing' and job.lease_expires_at <= now())
    )
  returning job.* into selected_job;

  if selected_job.id is null then
    raise exception using
      errcode = '55000',
      message = 'phase_9b_fixture_job_not_claimable';
  end if;

  perform app_private.set_job_entity_state(
    selected_job.job_kind,
    selected_job.entity_id,
    selected_job.entity_version,
    'processing',
    null
  );

  return query select
    selected_job.id,
    selected_job.queue_message_id,
    selected_job.entity_id,
    selected_job.entity_version,
    selected_job.attempt_count,
    selected_job.lease_expires_at;
end;
$$;

revoke all on function pg_temp.claim_phase_9b_fixture_job(
  uuid, bigint, uuid, integer
) from public;
grant execute on function pg_temp.claim_phase_9b_fixture_job(
  uuid, bigint, uuid, integer
) to service_role;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'b9111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase9b-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9B Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b9222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase9b-reuse@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9B Reuse Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b9333333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'phase9b-generated@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9B Generated Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b9444444-4444-4444-8444-444444444444',
    'authenticated',
    'authenticated',
    'phase9b-inactive@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9B Inactive Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b9555555-5555-4555-8555-555555555555',
    'authenticated',
    'authenticated',
    'phase9b-offboard@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9B Offboarded Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b9655555-5555-4555-8555-555555555555',
    'authenticated',
    'authenticated',
    'phase9b-stale-generation@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9B Stale Generation Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    'b9666666-6666-4666-8666-666666666666',
    'Phase 9B Primary Workspace',
    'phase-9b-primary-workspace',
    'b9111111-1111-4111-8111-111111111111'
  ),
  (
    'b9777777-7777-4777-8777-777777777777',
    'Phase 9B Other Workspace',
    'phase-9b-other-workspace',
    'b9111111-1111-4111-8111-111111111111'
  );

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'b9111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'b9666666-6666-4666-8666-666666666666',
    'b9111111-1111-4111-8111-111111111111',
    'owner'
  ),
  (
    'b9777777-7777-4777-8777-777777777777',
    'b9111111-1111-4111-8111-111111111111',
    'owner'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'b9666666-6666-4666-8666-666666666666',
    'b9222222-2222-4222-8222-222222222222',
    'student'
  ),
  (
    'b9666666-6666-4666-8666-666666666666',
    'b9333333-3333-4333-8333-333333333333',
    'student'
  ),
  (
    'b9666666-6666-4666-8666-666666666666',
    'b9444444-4444-4444-8444-444444444444',
    'student'
  ),
  (
    'b9666666-6666-4666-8666-666666666666',
    'b9555555-5555-4555-8555-555555555555',
    'student'
  ),
  (
    'b9666666-6666-4666-8666-666666666666',
    'b9655555-5555-4555-8555-555555555555',
    'student'
  );

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by
)
values (
  'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'b9666666-6666-4666-8666-666666666666',
  'Phase 9B A1 Class',
  'A1',
  true,
  'b9111111-1111-4111-8111-111111111111'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
select
  'b9666666-6666-4666-8666-666666666666',
  'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  student.id
from (
  values
    ('b9222222-2222-4222-8222-222222222222'::uuid),
    ('b9333333-3333-4333-8333-333333333333'::uuid),
    ('b9444444-4444-4444-8444-444444444444'::uuid),
    ('b9555555-5555-4555-8555-555555555555'::uuid),
    ('b9655555-5555-4555-8555-555555555555'::uuid)
) student(id);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'b9888888-8888-4888-8888-888888888888',
  'phase-9b-akkusativ',
  'Phase 9B Akkusativ',
  'A1',
  'A reset-safe worksheet generation topic.'
);

-- Four bank entries isolate the reuse eligibility predicates: approved/unseen,
-- already seen, unapproved, and approved but from another workspace.
insert into public.practice_tests (
  id,
  workspace_id,
  grammar_topic_id,
  level,
  difficulty,
  title,
  description,
  created_by_ai,
  teacher_reviewed,
  visibility,
  created_by,
  generation_source,
  quality_status
)
values
  (
    'bb111111-1111-4111-8111-111111111111',
    'b9666666-6666-4666-8666-666666666666',
    'b9888888-8888-4888-8888-888888888888',
    'A1',
    'easy',
    'Approved unseen worksheet',
    'Eligible same-workspace worksheet.',
    false,
    true,
    'workspace',
    'b9111111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'bb222222-2222-4222-8222-222222222222',
    'b9666666-6666-4666-8666-666666666666',
    'b9888888-8888-4888-8888-888888888888',
    'A1',
    'easy',
    'Previously seen worksheet',
    'Approved but already used by this student.',
    false,
    true,
    'workspace',
    'b9111111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'bb333333-3333-4333-8333-333333333333',
    'b9666666-6666-4666-8666-666666666666',
    'b9888888-8888-4888-8888-888888888888',
    'A1',
    'easy',
    'Unapproved worksheet',
    'A structurally present but ineligible worksheet.',
    true,
    false,
    'workspace',
    'b9111111-1111-4111-8111-111111111111',
    'deepseek',
    'passed'
  ),
  (
    'bb444444-4444-4444-8444-444444444444',
    'b9777777-7777-4777-8777-777777777777',
    'b9888888-8888-4888-8888-888888888888',
    'A1',
    'easy',
    'Other workspace worksheet',
    'Approved but isolated to another workspace.',
    false,
    true,
    'workspace',
    'b9111111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  );

insert into public.practice_test_questions (
  practice_test_id,
  question_number,
  question_type,
  evaluation_mode,
  prompt,
  options,
  correct_answer,
  accepted_answers,
  rubric,
  answer_contract_version,
  explanation
)
select
  bank.id,
  1,
  'multiple_choice',
  'local_exact',
  'Welche Antwort passt zu diesem Testsatz?',
  '["den", "dem", "der"]'::jsonb,
  'den',
  '["den"]'::jsonb,
  null,
  1,
  'Der Akkusativ verwendet hier den.'
from public.practice_tests bank
where bank.id in (
  'bb111111-1111-4111-8111-111111111111',
  'bb222222-2222-4222-8222-222222222222',
  'bb333333-3333-4333-8333-333333333333',
  'bb444444-4444-4444-8444-444444444444'
);

-- This durability fixture predates the adaptive-resolution contract. Seed the
-- already-verified immutable class snapshots directly, then exercise every
-- assignment and worker mutation with ordinary triggers restored. The prior
-- completed worksheet belongs to resolved cycle one; the currently unlocked
-- assignment for the same learner/topic belongs to open cycle two.
set local session_replication_role = replica;

insert into app_private.practice_resolution_cycles (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  cycle_number,
  state,
  state_reason,
  evidence_start_sequence,
  evidence_through_sequence,
  minor_issue_count,
  major_issue_count,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity,
  resolution_outcome,
  resolved_through_sequence,
  mastery_pass_number,
  resolved_at
)
values
  (
    'b9c11111-1111-4111-8111-111111111111',
    'b9666666-6666-4666-8666-666666666666',
    'b9222222-2222-4222-8222-222222222222',
    'b9888888-8888-4888-8888-888888888888',
    1,
    'improving',
    'worksheet_passed',
    1,
    0,
    0,
    0,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'passed',
    0,
    1,
    now()
  ),
  (
    'b9c22222-2222-4222-8222-222222222222',
    'b9666666-6666-4666-8666-666666666666',
    'b9222222-2222-4222-8222-222222222222',
    'b9888888-8888-4888-8888-888888888888',
    2,
    'unlocked',
    'weakness_threshold_reached',
    1,
    0,
    0,
    0,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    null,
    null,
    1,
    null
  ),
  (
    'b9c33333-3333-4333-8333-333333333333',
    'b9666666-6666-4666-8666-666666666666',
    'b9333333-3333-4333-8333-333333333333',
    'b9888888-8888-4888-8888-888888888888',
    1,
    'unlocked',
    'weakness_threshold_reached',
    1,
    0,
    0,
    0,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    null,
    null,
    0,
    null
  ),
  (
    'b9c44444-4444-4444-8444-444444444444',
    'b9666666-6666-4666-8666-666666666666',
    'b9444444-4444-4444-8444-444444444444',
    'b9888888-8888-4888-8888-888888888888',
    1,
    'unlocked',
    'weakness_threshold_reached',
    1,
    0,
    0,
    0,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    null,
    null,
    0,
    null
  ),
  (
    'b9c55555-5555-4555-8555-555555555555',
    'b9666666-6666-4666-8666-666666666666',
    'b9555555-5555-4555-8555-555555555555',
    'b9888888-8888-4888-8888-888888888888',
    1,
    'unlocked',
    'weakness_threshold_reached',
    1,
    0,
    0,
    0,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    null,
    null,
    0,
    null
  ),
  (
    'b9c66666-6666-4666-8666-666666666666',
    'b9666666-6666-4666-8666-666666666666',
    'b9655555-5555-4555-8555-555555555555',
    'b9888888-8888-4888-8888-888888888888',
    1,
    'unlocked',
    'weakness_threshold_reached',
    1,
    0,
    0,
    0,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    null,
    null,
    0,
    null
  );

set local session_replication_role = origin;

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity,
  resolution_cycle_id,
  resolution_cycle_number,
  evidence_cutoff_sequence,
  source,
  status,
  assigned_by,
  generation_status
)
values
  (
    'ba111111-1111-4111-8111-111111111111',
    'b9666666-6666-4666-8666-666666666666',
    'b9222222-2222-4222-8222-222222222222',
    'b9888888-8888-4888-8888-888888888888',
    'bb222222-2222-4222-8222-222222222222',
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'b9c11111-1111-4111-8111-111111111111',
    1,
    0,
    'weakness_auto',
    'completed',
    'b9111111-1111-4111-8111-111111111111',
    'ready'
  ),
  (
    'ba222222-2222-4222-8222-222222222222',
    'b9666666-6666-4666-8666-666666666666',
    'b9222222-2222-4222-8222-222222222222',
    'b9888888-8888-4888-8888-888888888888',
    null,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'b9c22222-2222-4222-8222-222222222222',
    2,
    0,
    'weakness_auto',
    'unlocked',
    'b9111111-1111-4111-8111-111111111111',
    'idle'
  ),
  (
    'ba333333-3333-4333-8333-333333333333',
    'b9666666-6666-4666-8666-666666666666',
    'b9333333-3333-4333-8333-333333333333',
    'b9888888-8888-4888-8888-888888888888',
    null,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'b9c33333-3333-4333-8333-333333333333',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'b9111111-1111-4111-8111-111111111111',
    'idle'
  ),
  (
    'ba444444-4444-4444-8444-444444444444',
    'b9666666-6666-4666-8666-666666666666',
    'b9444444-4444-4444-8444-444444444444',
    'b9888888-8888-4888-8888-888888888888',
    null,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'b9c44444-4444-4444-8444-444444444444',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'b9111111-1111-4111-8111-111111111111',
    'idle'
  ),
  (
    'ba555555-5555-4555-8555-555555555555',
    'b9666666-6666-4666-8666-666666666666',
    'b9555555-5555-4555-8555-555555555555',
    'b9888888-8888-4888-8888-888888888888',
    null,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'b9c55555-5555-4555-8555-555555555555',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'b9111111-1111-4111-8111-111111111111',
    'idle'
  ),
  (
    'ba655555-5555-4555-8555-555555555555',
    'b9666666-6666-4666-8666-666666666666',
    'b9655555-5555-4555-8555-555555555555',
    'b9888888-8888-4888-8888-888888888888',
    null,
    'b9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'b9c66666-6666-4666-8666-666666666666',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'b9111111-1111-4111-8111-111111111111',
    'idle'
  );

update app_private.practice_resolution_cycles cycle
set
  active_assignment_id = fixture.assignment_id,
  evidence_frozen_at = now(),
  state_reason = 'worksheet_ready'
from (
  values
    (
      'b9c22222-2222-4222-8222-222222222222'::uuid,
      'ba222222-2222-4222-8222-222222222222'::uuid
    ),
    (
      'b9c33333-3333-4333-8333-333333333333'::uuid,
      'ba333333-3333-4333-8333-333333333333'::uuid
    ),
    (
      'b9c44444-4444-4444-8444-444444444444'::uuid,
      'ba444444-4444-4444-8444-444444444444'::uuid
    ),
    (
      'b9c55555-5555-4555-8555-555555555555'::uuid,
      'ba555555-5555-4555-8555-555555555555'::uuid
    ),
    (
      'b9c66666-6666-4666-8666-666666666666'::uuid,
      'ba655555-5555-4555-8555-555555555555'::uuid
    )
) as fixture(cycle_id, assignment_id)
where cycle.id = fixture.cycle_id;

create temporary table phase_9b_state (
  singleton boolean primary key default true check (singleton),
  reuse_job_id uuid,
  reuse_message_id bigint,
  reuse_request_status text,
  reuse_response_assignment_id uuid,
  reuse_response_test_id uuid,
  reuse_response_generation_status text,
  reuse_response_quality_status text,
  generated_job_id uuid,
  generated_message_id bigint,
  generated_request_status text,
  generated_response_assignment_id uuid,
  generated_response_test_id uuid,
  generated_response_generation_status text,
  generated_response_quality_status text,
  needs_review_job_id uuid,
  needs_review_request_status text,
  inactive_job_id uuid,
  inactive_message_id bigint,
  offboard_job_id uuid,
  offboard_message_id bigint,
  stale_job_id uuid,
  stale_expired_message_id bigint,
  stale_message_id bigint,
  stale_attempt integer
) on commit drop;

insert into phase_9b_state default values;
grant select, update on table phase_9b_state to authenticated, service_role;

create temporary table phase_9b_payloads (
  name text primary key,
  payload jsonb not null
) on commit drop;

insert into phase_9b_payloads (name, payload)
values (
  'generated',
  $json$
  {
    "schema_version": 1,
    "mode": "generated",
    "generation_source": "deepseek",
    "level": "A1",
    "difficulty": "medium",
    "title": "Akkusativ sicher üben",
    "description": "A deterministic eight-question A1 worksheet for Akkusativ practice.",
    "generator_model": "deepseek-v4-pro",
    "mini_lesson": {
      "short_explanation": "Der Akkusativ markiert häufig das direkte Objekt.",
      "key_rule": "Nach vielen Verben steht das direkte Objekt im Akkusativ.",
      "common_mistake_warning": "Achte besonders auf den männlichen Artikel den.",
      "what_to_revise": "Wiederhole die Artikel im Nominativ und Akkusativ.",
      "correct_examples": ["Ich sehe den Hund."]
    },
    "source_mix": {
      "mode": "deepseek",
      "deepseek_count": 8,
      "fallback_count": 0
    },
    "validation": {
      "deterministic": true,
      "independent_model": false,
      "critic_model": "deepseek-v4-flash",
      "attempt_count": 2,
      "checks": {
        "ambiguity_free": false,
        "no_answer_leakage": true,
        "duplicate_free": true,
        "level_fit": true,
        "topic_fit": true,
        "type_balance": true,
        "scoring_safe": true
      },
      "rejection_reasons": ["One exact-scored question is ambiguous."]
    },
    "questions": [
      {
        "question_number": 1,
        "question_type": "multiple_choice",
        "evaluation_mode": "local_exact",
        "prompt": "Welche Form ist in diesem Satz richtig?",
        "options": ["den", "dem", "der"],
        "correct_answer": "den",
        "accepted_answers": ["den"],
        "rubric": null,
        "explanation": "Das männliche direkte Objekt steht im Akkusativ."
      },
      {
        "question_number": 2,
        "question_type": "multiple_choice",
        "evaluation_mode": "local_exact",
        "prompt": "Wähle den passenden Artikel für das Objekt aus.",
        "options": ["einen", "einem", "einer"],
        "correct_answer": "einen",
        "accepted_answers": ["einen"],
        "rubric": null,
        "explanation": "Der unbestimmte männliche Artikel lautet einen."
      },
      {
        "question_number": 3,
        "question_type": "fill_blank",
        "evaluation_mode": "local_exact",
        "prompt": "Ergänze mit dem bestimmten Artikel: Ich sehe ___ Hund.",
        "options": [],
        "correct_answer": "den",
        "accepted_answers": ["den"],
        "rubric": null,
        "explanation": "Hund ist hier das direkte Objekt."
      },
      {
        "question_number": 4,
        "question_type": "fill_blank",
        "evaluation_mode": "local_exact",
        "prompt": "Ergänze mit dem unbestimmten Artikel: Das ist ___ Buch.",
        "options": [],
        "correct_answer": "ein",
        "accepted_answers": ["ein"],
        "rubric": null,
        "explanation": "Das neutrale Wort Buch behält den Artikel ein."
      },
      {
        "question_number": 5,
        "question_type": "sentence_correction",
        "evaluation_mode": "open_evaluation",
        "prompt": "Korrigiere vollständig: Ich sehen den Hund jeden Tag.",
        "options": [],
        "correct_answer": "Ich sehe den Hund jeden Tag.",
        "accepted_answers": [],
        "rubric": {
          "criteria": ["Conjugate sehen for ich and preserve the sentence meaning."],
          "sample_answer": "Ich sehe den Hund jeden Tag."
        },
        "explanation": "Das Verb sehen muss zur ersten Person Singular passen."
      },
      {
        "question_number": 6,
        "question_type": "multiple_choice",
        "evaluation_mode": "local_exact",
        "prompt": "Welche Verbform passt in den vollständigen Satz?",
        "options": ["kaufe", "kaufst", "kauft"],
        "correct_answer": "kaufe",
        "accepted_answers": ["kaufe"],
        "rubric": null,
        "explanation": "Mit ich verwendet man die Form kaufe."
      },
      {
        "question_number": 7,
        "question_type": "fill_blank",
        "evaluation_mode": "local_exact",
        "prompt": "Ergänze mit dem unbestimmten Artikel: Wir besuchen ___ Freund.",
        "options": [],
        "correct_answer": "einen",
        "accepted_answers": ["einen"],
        "rubric": null,
        "explanation": "Freund ist männlich und steht im Akkusativ."
      },
      {
        "question_number": 8,
        "question_type": "multiple_choice",
        "evaluation_mode": "local_exact",
        "prompt": "Welcher Satz verwendet den Akkusativ korrekt?",
        "options": ["Ich sehe den Mann.", "Ich sehe dem Mann.", "Ich sehe der Mann."],
        "correct_answer": "Ich sehe den Mann.",
        "accepted_answers": ["Ich sehe den Mann."],
        "rubric": null,
        "explanation": "Das direkte männliche Objekt verwendet den."
      }
    ]
  }
  $json$::jsonb
);

insert into phase_9b_payloads (name, payload)
select
  'approved_generated',
  jsonb_set(
    payload,
    '{validation}',
    jsonb_build_object(
      'deterministic', true,
      'independent_model', true,
      'critic_model', 'deepseek-v4-flash',
      'attempt_count', 2,
      'checks', jsonb_build_object(
        'ambiguity_free', true,
        'no_answer_leakage', true,
        'duplicate_free', true,
        'level_fit', true,
        'topic_fit', true,
        'type_balance', true,
        'scoring_safe', true
      ),
      'rejection_reasons', '[]'::jsonb
    )
  )
from phase_9b_payloads
where name = 'generated';

grant select on table phase_9b_payloads to service_role;

-- Request and claim the reuse job as the student/service worker respectively.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b9222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b9222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet('ba222222-2222-4222-8222-222222222222')
)
update pg_temp.phase_9b_state state
set reuse_job_id = requested.job_id,
    reuse_request_status = requested.generation_status
from requested
where state.singleton;

reset role;
update phase_9b_state state
set reuse_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.reuse_job_id;

select ok(
  (select reuse_request_status = 'queued' and reuse_job_id is not null from phase_9b_state),
  'the student request creates one durable queued reuse job'
);
select ok(
  (
    select (
        select count(*) = 4
        from jsonb_object_keys(queue.message)
      )
      and not exists (
        select 1
        from jsonb_object_keys(queue.message) payload_key
        where payload_key not in ('job_id', 'job_kind', 'entity_id', 'entity_version')
      )
      and queue.message ->> 'job_kind' = 'worksheet_generation'
      and queue.message ->> 'entity_id' = 'ba222222-2222-4222-8222-222222222222'
      and queue.message::text not like '%phase9b-reuse@example.test%'
    from pgmq.q_worksheet_generation queue
    where queue.msg_id = (select reuse_message_id from phase_9b_state)
  ),
  'worksheet queue payloads contain identifiers/version only'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from pg_temp.claim_phase_9b_fixture_job(
    (select reuse_job_id from pg_temp.phase_9b_state),
    (select reuse_message_id from pg_temp.phase_9b_state),
    'bc111111-1111-4111-8111-111111111111',
    180
  )
)
update pg_temp.phase_9b_state state
set reuse_job_id = claimed.job_id,
    reuse_message_id = claimed.queue_message_id
from claimed
where state.singleton;

reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.id = (select reuse_job_id from phase_9b_state)
      and job.status = 'processing'
      and job.worker_id = 'bc111111-1111-4111-8111-111111111111'
      and assignment.generation_status = 'generating'
  ),
  'claiming the reuse job atomically leases it and marks generation active'
);

-- Final-schema workers cannot execute the legacy engine directly. These
-- Phase 9B transaction regressions invoke it only as the migration/test owner,
-- while the service JWT claim remains set for its internal authorization.
select throws_ok(
  $$
    select *
    from public.complete_worksheet_generation(
      (select reuse_job_id from pg_temp.phase_9b_state),
      (select reuse_message_id from pg_temp.phase_9b_state),
      'bc111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'reuse',
        'reusable_practice_test_id', 'bb444444-4444-4444-8444-444444444444'
      )
    )
  $$,
  '22023',
  'Reusable worksheet is not eligible.',
  'an approved cross-workspace worksheet cannot be reused'
);
reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment on assignment.id = job.entity_id
    where job.id = (select reuse_job_id from phase_9b_state)
      and job.status = 'processing'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'generating'
      and exists (
        select 1 from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
      and not exists (
        select 1 from pgmq.a_worksheet_generation archive
        where archive.msg_id = job.queue_message_id
      )
  ),
  'cross-workspace rejection rolls back assignment, job, and queue changes'
);

select throws_ok(
  $$
    select *
    from public.complete_worksheet_generation(
      (select reuse_job_id from pg_temp.phase_9b_state),
      (select reuse_message_id from pg_temp.phase_9b_state),
      'bc111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'reuse',
        'reusable_practice_test_id', 'bb333333-3333-4333-8333-333333333333'
      )
    )
  $$,
  '22023',
  'Reusable worksheet is not eligible.',
  'an unapproved worksheet cannot be reused'
);
reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment on assignment.id = job.entity_id
    where job.id = (select reuse_job_id from phase_9b_state)
      and job.status = 'processing'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'generating'
      and exists (
        select 1 from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
      and not exists (
        select 1 from pgmq.a_worksheet_generation archive
        where archive.msg_id = job.queue_message_id
      )
  ),
  'unapproved reuse rejection leaves no partial transition'
);

select throws_ok(
  $$
    select *
    from public.complete_worksheet_generation(
      (select reuse_job_id from pg_temp.phase_9b_state),
      (select reuse_message_id from pg_temp.phase_9b_state),
      'bc111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'reuse',
        'reusable_practice_test_id', 'bb222222-2222-4222-8222-222222222222'
      )
    )
  $$,
  '22023',
  'Reusable worksheet is not eligible.',
  'a worksheet already seen by the student cannot be reused'
);
reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment on assignment.id = job.entity_id
    where job.id = (select reuse_job_id from phase_9b_state)
      and job.status = 'processing'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'generating'
      and exists (
        select 1 from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
      and not exists (
        select 1 from pgmq.a_worksheet_generation archive
        where archive.msg_id = job.queue_message_id
      )
  ),
  'seen-worksheet rejection rolls back every completion-side mutation'
);

select lives_ok(
  $$
    with completed as (
      select *
      from public.complete_worksheet_generation(
        (select reuse_job_id from pg_temp.phase_9b_state),
        (select reuse_message_id from pg_temp.phase_9b_state),
        'bc111111-1111-4111-8111-111111111111',
        jsonb_build_object(
          'schema_version', 1,
          'mode', 'reuse',
          'reusable_practice_test_id', 'bb111111-1111-4111-8111-111111111111'
        )
      )
    )
    update pg_temp.phase_9b_state state
    set reuse_response_assignment_id = completed.assignment_id,
        reuse_response_test_id = completed.practice_test_id,
        reuse_response_generation_status = completed.generation_status,
        reuse_response_quality_status = completed.quality_status
    from completed
    where state.singleton
  $$,
  'an approved unseen same-workspace/topic/level worksheet completes successfully'
);
reset role;

select ok(
  (
    select reuse_response_assignment_id = 'ba222222-2222-4222-8222-222222222222'
      and reuse_response_test_id = 'bb111111-1111-4111-8111-111111111111'
      and reuse_response_generation_status = 'ready'
      and reuse_response_quality_status = 'approved'
    from phase_9b_state
  ),
  'reuse completion returns the attached approved worksheet state'
);
select ok(
  exists (
    select 1
    from public.student_practice_assignments assignment
    join app_private.async_jobs job on job.entity_id = assignment.id
    join pgmq.a_worksheet_generation archive on archive.msg_id = job.queue_message_id
    where assignment.id = 'ba222222-2222-4222-8222-222222222222'
      and assignment.practice_test_id = 'bb111111-1111-4111-8111-111111111111'
      and assignment.generation_status = 'ready'
      and assignment.generation_completed_at is not null
      and job.status = 'succeeded'
      and job.completed_at is not null
      and not exists (
        select 1 from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
  ),
  'reuse attaches the worksheet and archives the durable job atomically'
);

-- Generate a fresh worksheet for another active student.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b9333333-3333-4333-8333-333333333333',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b9333333-3333-4333-8333-333333333333',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet('ba333333-3333-4333-8333-333333333333')
)
update pg_temp.phase_9b_state state
set generated_job_id = requested.job_id,
    generated_request_status = requested.generation_status
from requested
where state.singleton;

reset role;
update phase_9b_state state
set generated_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.generated_job_id;

select ok(
  (
    select generated_request_status = 'queued'
      and generated_job_id is not null
      and generated_message_id is not null
    from phase_9b_state
  ),
  'a generated worksheet request is durably queued'
);
select ok(
  (
    select (
        select count(*) = 4 from jsonb_object_keys(queue.message)
      )
      and not exists (
        select 1
        from jsonb_object_keys(queue.message) payload_key
        where payload_key not in ('job_id', 'job_kind', 'entity_id', 'entity_version')
      )
      and queue.message::text not like '%Akkusativ sicher üben%'
      and queue.message::text not like '%questions%'
    from pgmq.q_worksheet_generation queue
    where queue.msg_id = (select generated_message_id from phase_9b_state)
  ),
  'the generation queue stores no worksheet content or student data'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from pg_temp.claim_phase_9b_fixture_job(
    (select generated_job_id from pg_temp.phase_9b_state),
    (select generated_message_id from pg_temp.phase_9b_state),
    'bc222222-2222-4222-8222-222222222222',
    180
  )
)
update pg_temp.phase_9b_state state
set generated_job_id = claimed.job_id,
    generated_message_id = claimed.queue_message_id
from claimed
where state.singleton;

reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment on assignment.id = job.entity_id
    where job.id = (select generated_job_id from phase_9b_state)
      and job.status = 'processing'
      and job.worker_id = 'bc222222-2222-4222-8222-222222222222'
      and assignment.generation_status = 'generating'
  ),
  'the generated worksheet job has one active service lease'
);

-- Force a rollback after a completely valid completion. This proves that the
-- test row, every question, assignment state, job state, and queue archive are
-- one transaction rather than independently visible fragments.
select lives_ok(
  $test$
    do $body$
    begin
      begin
        perform *
        from public.complete_worksheet_generation(
          (select generated_job_id from pg_temp.phase_9b_state),
          (select generated_message_id from pg_temp.phase_9b_state),
          'bc222222-2222-4222-8222-222222222222',
          (select payload from pg_temp.phase_9b_payloads where name = 'approved_generated')
        );
        if not exists (
          select 1
          from public.student_practice_assignments assignment
          join public.practice_tests test
            on test.id = assignment.practice_test_id
          where assignment.id = 'ba333333-3333-4333-8333-333333333333'
            and assignment.generation_status = 'ready'
            and assignment.generation_error is null
            and test.visibility = 'workspace'
            and test.quality_status = 'approved'
            and test.generation_metadata #>> '{validation,independent_model}' = 'true'
        ) then
          raise exception 'phase9b_approved_generated_not_released';
        end if;
        raise exception 'phase9b_forced_rollback';
      exception when raise_exception then
        if sqlerrm <> 'phase9b_forced_rollback' then
          raise;
        end if;
      end;
    end;
    $body$
  $test$,
  'independently approved generation auto-releases atomically and remains rollback-safe'
);
reset role;

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment on assignment.id = job.entity_id
    where job.id = (select generated_job_id from phase_9b_state)
      and job.status = 'processing'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'generating'
      and not exists (
        select 1 from public.practice_tests test
        where test.generation_job_id = job.id
      )
      and exists (
        select 1 from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
      and not exists (
        select 1 from pgmq.a_worksheet_generation archive
        where archive.msg_id = job.queue_message_id
      )
  ),
  'forced rollback leaves no generated worksheet, question, attachment, or archive'
);

select lives_ok(
  $$
    with completed as (
      select *
      from public.complete_worksheet_generation(
        (select generated_job_id from pg_temp.phase_9b_state),
        (select generated_message_id from pg_temp.phase_9b_state),
        'bc222222-2222-4222-8222-222222222222',
        (select payload from pg_temp.phase_9b_payloads where name = 'generated')
      )
    )
    update pg_temp.phase_9b_state state
    set generated_response_assignment_id = completed.assignment_id,
        generated_response_test_id = completed.practice_test_id,
        generated_response_generation_status = completed.generation_status,
        generated_response_quality_status = completed.quality_status
    from completed
    where state.singleton
  $$,
  'a valid generated payload persists through the single completion RPC'
);
reset role;

select ok(
  (
    select generated_response_assignment_id = 'ba333333-3333-4333-8333-333333333333'
      and generated_response_test_id is not null
      and generated_response_generation_status = 'needs_review'
      and generated_response_quality_status = 'needs_review'
    from phase_9b_state
  ),
  'generated completion returns a private needs-review result'
);
select ok(
  exists (
    select 1
    from public.practice_tests test
    where test.id = (select generated_response_test_id from phase_9b_state)
      and test.workspace_id = 'b9666666-6666-4666-8666-666666666666'
      and test.grammar_topic_id = 'b9888888-8888-4888-8888-888888888888'
      and test.level = 'A1'
      and test.visibility = 'private'
      and test.quality_status = 'needs_review'
      and test.created_by_ai
      and not test.teacher_reviewed
      and test.generation_source = 'deepseek'
      and test.generated_from_assignment_id = 'ba333333-3333-4333-8333-333333333333'
      and test.generator_model = 'deepseek-v4-pro'
      and test.generation_job_id = (select generated_job_id from phase_9b_state)
  ),
  'the generated worksheet is private and quarantined for independent review'
);
select ok(
  (
    select count(*) = 8
      and min(question_number) = 1
      and max(question_number) = 8
      and count(*) filter (where evaluation_mode = 'open_evaluation') = 1
      and count(*) filter (where question_type = 'multiple_choice') >= 2
      and count(*) filter (where question_type = 'fill_blank') >= 2
      and count(*) filter (where answer_contract_version = 1) = 8
      and count(*) filter (
        where evaluation_mode = 'local_exact'
          and jsonb_array_length(accepted_answers) >= 1
          and rubric is null
      ) = 7
      and count(*) filter (
        where evaluation_mode = 'open_evaluation'
          and accepted_answers = '[]'::jsonb
          and jsonb_typeof(rubric) = 'object'
      ) = 1
    from public.practice_test_questions question
    where question.practice_test_id = (
      select generated_response_test_id from phase_9b_state
    )
  ),
  'all eight validated questions persist in the same generated revision'
);
select ok(
  exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.id = 'ba333333-3333-4333-8333-333333333333'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'needs_review'
      and assignment.generation_completed_at is not null
      and assignment.generation_error = 'independent_validation_rejected'
  ),
  'independently rejected content is quarantined and not attached to the student'
);
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join pgmq.a_worksheet_generation archive on archive.msg_id = job.queue_message_id
    where job.id = (select generated_job_id from phase_9b_state)
      and job.status = 'succeeded'
      and job.completed_at is not null
      and not exists (
        select 1 from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
  ),
  'generated completion archives the queue message only after durable persistence'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
select lives_ok(
  $$
    select *
    from public.complete_worksheet_generation(
      (select generated_job_id from pg_temp.phase_9b_state),
      (select generated_message_id from pg_temp.phase_9b_state),
      'bc999999-9999-4999-8999-999999999999',
      (select payload from pg_temp.phase_9b_payloads where name = 'generated')
    )
  $$,
  'idempotent redelivery returns the existing generated worksheet'
);
reset role;
select ok(
  (
    select count(*) = 1
    from public.practice_tests test
    where test.generation_job_id = (select generated_job_id from phase_9b_state)
  )
    and (
      select count(*) = 8
      from public.practice_test_questions question
      where question.practice_test_id = (
        select generated_response_test_id from phase_9b_state
      )
    ),
  'idempotent redelivery creates no duplicate worksheet or questions'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b9333333-3333-4333-8333-333333333333',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b9333333-3333-4333-8333-333333333333',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select lives_ok(
  $$
    with requested as (
      select *
      from api.request_practice_worksheet(
        'ba333333-3333-4333-8333-333333333333'
      )
    )
    update pg_temp.phase_9b_state state
    set needs_review_job_id = requested.job_id,
        needs_review_request_status = requested.generation_status
    from requested
    where state.singleton
  $$,
  'requesting a quarantined worksheet returns its current state safely'
);
reset role;
select ok(
  (
    select needs_review_job_id is null
      and needs_review_request_status = 'needs_review'
    from phase_9b_state
  ),
  'api.request_practice_worksheet reports needs_review without a job id'
);
select ok(
  (
    select count(*) = 1
    from app_private.async_jobs job
    where job.job_kind = 'worksheet_generation'
      and job.entity_id = 'ba333333-3333-4333-8333-333333333333'
  )
    and not exists (
      select 1
      from pgmq.q_worksheet_generation queue
      where queue.message ->> 'entity_id' = 'ba333333-3333-4333-8333-333333333333'
    ),
  'needs-review requests enqueue no duplicate durable job or queue message'
);

-- An exact generation fixture proves that a worker crash cannot leave an
-- active assignment in `generating` forever. The first lease is expired only
-- for this fixture, a second worker reclaims it, a transient failure creates
-- one bounded retry, and the final failed claim becomes an actionable terminal
-- assignment state. No queue-wide consumer or purge is used on shared staging.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b9655555-5555-4555-8555-555555555555',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b9655555-5555-4555-8555-555555555555',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
with requested as (
  select *
  from api.request_practice_worksheet('ba655555-5555-4555-8555-555555555555')
)
update pg_temp.phase_9b_state state
set stale_job_id = requested.job_id
from requested
where state.singleton;

reset role;
update pg_temp.phase_9b_state state
set stale_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.stale_job_id
  and job.job_kind = 'worksheet_generation'
  and job.entity_id = 'ba655555-5555-4555-8555-555555555555';

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
with claimed as (
  select *
  from pg_temp.claim_phase_9b_fixture_job(
    (select stale_job_id from pg_temp.phase_9b_state),
    (select stale_message_id from pg_temp.phase_9b_state),
    'bc555555-5555-4555-8555-555555555555',
    180
  )
)
update pg_temp.phase_9b_state state
set stale_attempt = claimed.attempt_number
from claimed
where state.singleton;

reset role;
update app_private.async_jobs job
set lease_expires_at = now() - interval '1 second'
where job.id = (select stale_job_id from phase_9b_state)
  and job.status = 'processing'
  and job.worker_id = 'bc555555-5555-4555-8555-555555555555';
update pgmq.q_worksheet_generation queue
set vt = clock_timestamp() - interval '1 second'
where queue.msg_id = (select stale_message_id from phase_9b_state)
  and queue.message ->> 'job_id' = (
    select stale_job_id::text from phase_9b_state
  );

set local role service_role;
with claimed as (
  select *
  from pg_temp.claim_phase_9b_fixture_job(
    (select stale_job_id from pg_temp.phase_9b_state),
    (select stale_message_id from pg_temp.phase_9b_state),
    'bc666666-6666-4666-8666-666666666666',
    180
  )
)
update pg_temp.phase_9b_state state
set stale_attempt = claimed.attempt_number
from claimed
where state.singleton;

reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    join pgmq.q_worksheet_generation queue
      on queue.msg_id = job.queue_message_id
    where job.id = (select stale_job_id from phase_9b_state)
      and job.entity_id = 'ba655555-5555-4555-8555-555555555555'
      and job.status = 'processing'
      and job.attempt_count = 2
      and job.worker_id = 'bc666666-6666-4666-8666-666666666666'
      and job.lease_expires_at > now()
      and assignment.generation_status = 'generating'
      and queue.message ->> 'job_id' = job.id::text
  )
    and (select stale_attempt = 2 from phase_9b_state),
  'an expired generation lease is reclaimed exactly as attempt two'
);

set local role service_role;
with failed as (
  select *
  from api.fail_async_job(
    (select stale_job_id from pg_temp.phase_9b_state),
    (select stale_message_id from pg_temp.phase_9b_state),
    'bc666666-6666-4666-8666-666666666666',
    'worksheet_generation_stale_recovered',
    true
  )
)
update pg_temp.phase_9b_state state
set stale_attempt = failed.attempt_count
from failed
where state.singleton;

reset role;
update pg_temp.phase_9b_state state
set stale_expired_message_id = state.stale_message_id,
    stale_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.stale_job_id;

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    join pgmq.q_worksheet_generation queue
      on queue.msg_id = job.queue_message_id
    where job.id = (select stale_job_id from phase_9b_state)
      and job.status = 'retry'
      and job.attempt_count = 2
      and job.worker_id is null
      and job.lease_expires_at is null
      and job.available_at > now()
      and job.last_error_code = 'worksheet_generation_stale_recovered'
      and assignment.generation_status = 'queued'
      and assignment.generation_error is null
      and queue.message = jsonb_build_object(
        'job_id', job.id,
        'job_kind', job.job_kind,
        'entity_id', job.entity_id,
        'entity_version', job.entity_version
      )
  )
    and (select count(*) = 1
         from pgmq.a_worksheet_generation archive
         where archive.msg_id = (
           select stale_expired_message_id from phase_9b_state
         ))
    and not exists (
      select 1
      from pgmq.q_worksheet_generation queue
      where queue.msg_id = (
        select stale_expired_message_id from phase_9b_state
      )
    ),
  'the recovered generation failure schedules one durable retry and clears the spinner state'
);

update app_private.async_jobs job
set available_at = now() - interval '1 second'
where job.id = (select stale_job_id from phase_9b_state)
  and job.status = 'retry';
update pgmq.q_worksheet_generation queue
set vt = clock_timestamp() - interval '1 second'
where queue.msg_id = (select stale_message_id from phase_9b_state)
  and queue.message ->> 'job_id' = (
    select stale_job_id::text from phase_9b_state
  );

set local role service_role;
with claimed as (
  select *
  from pg_temp.claim_phase_9b_fixture_job(
    (select stale_job_id from pg_temp.phase_9b_state),
    (select stale_message_id from pg_temp.phase_9b_state),
    'bc777777-7777-4777-8777-777777777777',
    180
  )
)
update pg_temp.phase_9b_state state
set stale_attempt = claimed.attempt_number
from claimed
where state.singleton;

reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    where job.id = (select stale_job_id from phase_9b_state)
      and job.status = 'processing'
      and job.attempt_count = 3
      and job.worker_id = 'bc777777-7777-4777-8777-777777777777'
      and job.lease_expires_at > now()
  )
    and (select stale_attempt = 3 from phase_9b_state),
  'the one scheduled retry is claimable as the bounded final attempt'
);

set local role service_role;
with failed as (
  select *
  from api.fail_async_job(
    (select stale_job_id from pg_temp.phase_9b_state),
    (select stale_message_id from pg_temp.phase_9b_state),
    'bc777777-7777-4777-8777-777777777777',
    'worksheet_generation_attempts_exhausted',
    true
  )
)
update pg_temp.phase_9b_state state
set stale_attempt = failed.attempt_count
from failed
where state.singleton;

reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.id = (select stale_job_id from phase_9b_state)
      and job.status = 'dead'
      and job.attempt_count = 3
      and job.worker_id is null
      and job.lease_expires_at is null
      and job.dead_at is not null
      and job.last_error_code = 'worksheet_generation_attempts_exhausted'
      and assignment.generation_status = 'failed'
      and assignment.generation_completed_at is not null
      and assignment.generation_error = 'worksheet_generation_attempts_exhausted'
  )
    and not exists (
      select 1
      from pgmq.q_worksheet_generation queue
      where queue.msg_id = (select stale_message_id from phase_9b_state)
    )
    and (select count(*) = 1
         from pgmq.a_worksheet_generation archive
         where archive.msg_id = (select stale_message_id from phase_9b_state)),
  'exhausted stale generation reaches one actionable failed assignment and dead job'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok(
  $$
    select *
    from api.fail_async_job(
      (select stale_job_id from pg_temp.phase_9b_state),
      -1::bigint,
      'bc999999-9999-4999-8999-999999999999',
      'ignored_replay',
      true
    )
  $$,
  'a replay after terminal generation failure returns the durable dead state'
);
reset role;

select ok(
  (select count(*) = 1
   from app_private.async_jobs job
   where job.id = (select stale_job_id from phase_9b_state)
     and job.status = 'dead'
     and job.attempt_count = 3
     and job.last_error_code = 'worksheet_generation_attempts_exhausted')
    and (select count(*) = 2
         from pgmq.a_worksheet_generation archive
         where archive.msg_id in (
           select stale_expired_message_id from phase_9b_state
           union all
           select stale_message_id from phase_9b_state
         ))
    and not exists (
      select 1
      from pgmq.q_worksheet_generation queue
      where queue.message ->> 'job_id' = (
        select stale_job_id::text from phase_9b_state
      )
    ),
  'terminal generation replay creates no duplicate job or queue delivery'
);

-- A stale worker cannot complete an assignment that became inactive after its
-- lease was acquired.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b9444444-4444-4444-8444-444444444444',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b9444444-4444-4444-8444-444444444444',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
with requested as (
  select *
  from api.request_practice_worksheet('ba444444-4444-4444-8444-444444444444')
)
update pg_temp.phase_9b_state state
set inactive_job_id = requested.job_id
from requested
where state.singleton;

reset role;
update phase_9b_state state
set inactive_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.inactive_job_id;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
with claimed as (
  select *
  from pg_temp.claim_phase_9b_fixture_job(
    (select inactive_job_id from pg_temp.phase_9b_state),
    (select inactive_message_id from pg_temp.phase_9b_state),
    'bc333333-3333-4333-8333-333333333333',
    180
  )
)
update pg_temp.phase_9b_state state
set inactive_job_id = claimed.job_id,
    inactive_message_id = claimed.queue_message_id
from claimed
where state.singleton;

reset role;
update public.student_practice_assignments
set status = 'cancelled'
where id = 'ba444444-4444-4444-8444-444444444444';

select throws_ok(
  $$
    select *
    from public.complete_worksheet_generation(
      (select inactive_job_id from pg_temp.phase_9b_state),
      (select inactive_message_id from pg_temp.phase_9b_state),
      'bc333333-3333-4333-8333-333333333333',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'reuse',
        'reusable_practice_test_id', 'bb111111-1111-4111-8111-111111111111'
      )
    )
  $$,
  '55000',
  'Practice assignment is not active.',
  'completion rejects an assignment that became inactive after claim'
);
reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment on assignment.id = job.entity_id
    where job.id = (select inactive_job_id from phase_9b_state)
      and job.status = 'processing'
      and assignment.status = 'cancelled'
      and assignment.practice_test_id is null
      and not exists (
        select 1 from public.practice_tests test
        where test.generation_job_id = job.id
      )
      and exists (
        select 1 from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
      and not exists (
        select 1 from pgmq.a_worksheet_generation archive
        where archive.msg_id = job.queue_message_id
      )
  ),
  'inactive completion failure preserves the leased job without partial content'
);

-- Full offboarding cancels the assignment and archives/dead-letters its job;
-- any late worker completion is rejected idempotently.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b9555555-5555-4555-8555-555555555555',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b9555555-5555-4555-8555-555555555555',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
with requested as (
  select *
  from api.request_practice_worksheet('ba555555-5555-4555-8555-555555555555')
)
update pg_temp.phase_9b_state state
set offboard_job_id = requested.job_id
from requested
where state.singleton;

reset role;
update phase_9b_state state
set offboard_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.offboard_job_id;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
with claimed as (
  select *
  from pg_temp.claim_phase_9b_fixture_job(
    (select offboard_job_id from pg_temp.phase_9b_state),
    (select offboard_message_id from pg_temp.phase_9b_state),
    'bc444444-4444-4444-8444-444444444444',
    180
  )
)
update pg_temp.phase_9b_state state
set offboard_job_id = claimed.job_id,
    offboard_message_id = claimed.queue_message_id
from claimed
where state.singleton;

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b9111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b9111111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select lives_ok(
  $$
    select *
    from api.offboard_student(
      'b9555555-5555-4555-8555-555555555555',
      'b9666666-6666-4666-8666-666666666666'
    )
  $$,
  'transactional offboarding terminates the active worksheet job'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
select throws_ok(
  $$
    select *
    from public.complete_worksheet_generation(
      (select offboard_job_id from pg_temp.phase_9b_state),
      (select offboard_message_id from pg_temp.phase_9b_state),
      'bc444444-4444-4444-8444-444444444444',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'reuse',
        'reusable_practice_test_id', 'bb111111-1111-4111-8111-111111111111'
      )
    )
  $$,
  '55000',
  'Job lease is no longer active.',
  'a late worker cannot complete an offboarded student assignment'
);

reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment on assignment.id = job.entity_id
    join pgmq.a_worksheet_generation archive on archive.msg_id = job.queue_message_id
    where job.id = (select offboard_job_id from phase_9b_state)
      and job.status = 'dead'
      and job.dead_at is not null
      and job.last_error_code = 'student_offboarded'
      and assignment.status = 'cancelled'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'failed'
      and assignment.generation_error = 'student_offboarded'
      and not exists (
        select 1
        from public.workspace_members member
        where member.workspace_id = assignment.workspace_id
          and member.user_id = assignment.student_id
      )
      and not exists (
        select 1 from public.practice_tests test
        where test.generation_job_id = job.id
      )
      and not exists (
        select 1 from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
  ),
  'offboarding leaves a dead archived job and no attachable worksheet fragment'
);

select * from finish(true);
rollback;
