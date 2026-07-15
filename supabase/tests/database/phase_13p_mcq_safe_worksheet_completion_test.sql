begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

select ok(
  (
    select routine.prosecdef
      and routine.proconfig @> array['search_path=""']::text[]
    from pg_proc routine
    where routine.oid =
      'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)'::regprocedure
  ),
  'the private materializer remains security definer with an empty search path'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
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
      'anon',
      'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    ),
  'completion permissions remain private-engine plus service-only gated API'
);

-- Shared-staging-safe exact claim helper. It cannot lease or archive any job
-- except the fixture job/message pair supplied by this transaction.
create or replace function pg_temp.phase_13p_claim_fixture_job(
  target_job_id uuid,
  target_queue_message_id bigint,
  target_worker_id uuid
)
returns table (
  job_id uuid,
  queue_message_id bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_payload jsonb;
begin
  perform app_private.assert_service_role();

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation'
    and job.queue_name = 'worksheet_generation'
    and job.queue_message_id = target_queue_message_id
  for update;

  if selected_job.id is null then
    raise exception using errcode = 'P0002', message = 'phase_13p_job_not_found';
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
    raise exception using errcode = '55000', message = 'phase_13p_message_mismatch';
  end if;

  update pgmq.q_worksheet_generation queue
  set
    vt = clock_timestamp() + interval '180 seconds',
    read_ct = queue.read_ct + 1
  where queue.msg_id = target_queue_message_id
    and queue.vt <= clock_timestamp()
  returning queue.message into selected_payload;

  if selected_payload is null then
    raise exception using errcode = '55000', message = 'phase_13p_message_not_visible';
  end if;

  update app_private.async_jobs job
  set
    status = 'processing',
    attempt_count = job.attempt_count + 1,
    worker_id = target_worker_id,
    lease_expires_at = now() + interval '180 seconds',
    first_started_at = coalesce(job.first_started_at, now()),
    last_started_at = now(),
    last_error_code = null
  where job.id = selected_job.id
    and job.available_at <= now()
    and job.status in ('queued', 'retry')
  returning job.* into selected_job;

  if selected_job.id is null then
    raise exception using errcode = '55000', message = 'phase_13p_job_not_claimable';
  end if;

  perform app_private.set_job_entity_state(
    selected_job.job_kind,
    selected_job.entity_id,
    selected_job.entity_version,
    'processing',
    null
  );

  return query select selected_job.id, selected_job.queue_message_id;
end;
$$;

revoke all on function pg_temp.phase_13p_claim_fixture_job(uuid, bigint, uuid)
from public;
grant execute on function pg_temp.phase_13p_claim_fixture_job(uuid, bigint, uuid)
to service_role;

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
    'd1400001-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'phase13p-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13P Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1400002-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'phase13p-rich@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13P Rich Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1400003-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'phase13p-mcq@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13P MCQ Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1400004-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'phase13p-invalid@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13P Invalid Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1400005-0000-4000-8000-000000000005',
    'authenticated',
    'authenticated',
    'phase13p-capitalization@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13P Capitalization Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1400006-0000-4000-8000-000000000006',
    'authenticated',
    'authenticated',
    'phase13p-punctuation@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13P Punctuation Student"}'::jsonb,
    now(),
    now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'd1400001-0000-4000-8000-000000000001',
    'Phase 13P Teacher',
    'phase13p-teacher@example.test',
    'student'
  ),
  (
    'd1400002-0000-4000-8000-000000000002',
    'Phase 13P Rich Student',
    'phase13p-rich@example.test',
    'student'
  ),
  (
    'd1400003-0000-4000-8000-000000000003',
    'Phase 13P MCQ Student',
    'phase13p-mcq@example.test',
    'student'
  ),
  (
    'd1400004-0000-4000-8000-000000000004',
    'Phase 13P Invalid Student',
    'phase13p-invalid@example.test',
    'student'
  ),
  (
    'd1400005-0000-4000-8000-000000000005',
    'Phase 13P Capitalization Student',
    'phase13p-capitalization@example.test',
    'student'
  ),
  (
    'd1400006-0000-4000-8000-000000000006',
    'Phase 13P Punctuation Student',
    'phase13p-punctuation@example.test',
    'student'
  )
on conflict (id) do update
set
  full_name = excluded.full_name,
  email = excluded.email,
  global_role = excluded.global_role;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd1401000-0000-4000-8000-000000000000',
  'Phase 13P Workspace',
  'phase-13p-mcq-safe',
  'd1400001-0000-4000-8000-000000000001'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'd1400001-0000-4000-8000-000000000001',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd1401000-0000-4000-8000-000000000000',
  'd1400001-0000-4000-8000-000000000001',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'd1401000-0000-4000-8000-000000000000',
    'd1400002-0000-4000-8000-000000000002',
    'student'
  ),
  (
    'd1401000-0000-4000-8000-000000000000',
    'd1400003-0000-4000-8000-000000000003',
    'student'
  ),
  (
    'd1401000-0000-4000-8000-000000000000',
    'd1400004-0000-4000-8000-000000000004',
    'student'
  ),
  (
    'd1401000-0000-4000-8000-000000000000',
    'd1400005-0000-4000-8000-000000000005',
    'student'
  ),
  (
    'd1401000-0000-4000-8000-000000000000',
    'd1400006-0000-4000-8000-000000000006',
    'student'
  );

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'd1402000-0000-4000-8000-000000000000',
  'phase-13p-articles',
  'Phase 13P Artikel',
  'A1',
  'Rollback-only materializer coverage for the MCQ-safe fallback.'
);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  is_active,
  created_by
)
values (
  'd1402500-0000-4000-8000-000000000000',
  'd1401000-0000-4000-8000-000000000000',
  'Phase 13P A1 Class',
  'A1',
  true,
  'd1400001-0000-4000-8000-000000000001'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    'd1401000-0000-4000-8000-000000000000',
    'd1402500-0000-4000-8000-000000000000',
    'd1400002-0000-4000-8000-000000000002'
  ),
  (
    'd1401000-0000-4000-8000-000000000000',
    'd1402500-0000-4000-8000-000000000000',
    'd1400003-0000-4000-8000-000000000003'
  ),
  (
    'd1401000-0000-4000-8000-000000000000',
    'd1402500-0000-4000-8000-000000000000',
    'd1400004-0000-4000-8000-000000000004'
  ),
  (
    'd1401000-0000-4000-8000-000000000000',
    'd1402500-0000-4000-8000-000000000000',
    'd1400005-0000-4000-8000-000000000005'
  ),
  (
    'd1401000-0000-4000-8000-000000000000',
    'd1402500-0000-4000-8000-000000000000',
    'd1400006-0000-4000-8000-000000000006'
  );

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity,
  source,
  status,
  assigned_by,
  generation_status
)
values
  (
    'd1403001-0000-4000-8000-000000000001',
    'd1401000-0000-4000-8000-000000000000',
    'd1400002-0000-4000-8000-000000000002',
    'd1402000-0000-4000-8000-000000000000',
    'd1402500-0000-4000-8000-000000000000',
    'A1',
    1,
    'teacher_verified',
    'manual',
    'unlocked',
    'd1400001-0000-4000-8000-000000000001',
    'idle'
  ),
  (
    'd1403002-0000-4000-8000-000000000002',
    'd1401000-0000-4000-8000-000000000000',
    'd1400003-0000-4000-8000-000000000003',
    'd1402000-0000-4000-8000-000000000000',
    'd1402500-0000-4000-8000-000000000000',
    'A1',
    1,
    'teacher_verified',
    'manual',
    'unlocked',
    'd1400001-0000-4000-8000-000000000001',
    'idle'
  ),
  (
    'd1403003-0000-4000-8000-000000000003',
    'd1401000-0000-4000-8000-000000000000',
    'd1400004-0000-4000-8000-000000000004',
    'd1402000-0000-4000-8000-000000000000',
    'd1402500-0000-4000-8000-000000000000',
    'A1',
    1,
    'teacher_verified',
    'manual',
    'unlocked',
    'd1400001-0000-4000-8000-000000000001',
    'idle'
  );

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity,
  source,
  status,
  assigned_by,
  generation_status
)
select
  'd1403004-0000-4000-8000-000000000004',
  'd1401000-0000-4000-8000-000000000000',
  'd1400005-0000-4000-8000-000000000005',
  topic.id,
  'd1402500-0000-4000-8000-000000000000',
  'A1',
  1,
  'teacher_verified',
  'manual',
  'unlocked',
  'd1400001-0000-4000-8000-000000000001',
  'idle'
from public.grammar_topics topic
where topic.slug = 'capitalization';

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity,
  source,
  status,
  assigned_by,
  generation_status
)
select
  'd1403005-0000-4000-8000-000000000005',
  'd1401000-0000-4000-8000-000000000000',
  'd1400006-0000-4000-8000-000000000006',
  topic.id,
  'd1402500-0000-4000-8000-000000000000',
  'A1',
  1,
  'teacher_verified',
  'manual',
  'unlocked',
  'd1400001-0000-4000-8000-000000000001',
  'idle'
from public.grammar_topics topic
where topic.slug = 'punctuation';

create temporary table phase_13p_state (
  fixture text primary key,
  assignment_id uuid not null,
  student_id uuid not null,
  job_id uuid,
  queue_message_id bigint,
  practice_test_id uuid
) on commit drop;

insert into phase_13p_state (fixture, assignment_id, student_id)
values
  (
    'rich',
    'd1403001-0000-4000-8000-000000000001',
    'd1400002-0000-4000-8000-000000000002'
  ),
  (
    'mcq',
    'd1403002-0000-4000-8000-000000000002',
    'd1400003-0000-4000-8000-000000000003'
  ),
  (
    'invalid',
    'd1403003-0000-4000-8000-000000000003',
    'd1400004-0000-4000-8000-000000000004'
  ),
  (
    'capitalization',
    'd1403004-0000-4000-8000-000000000004',
    'd1400005-0000-4000-8000-000000000005'
  ),
  (
    'punctuation',
    'd1403005-0000-4000-8000-000000000005',
    'd1400006-0000-4000-8000-000000000006'
  );

grant select, update on table phase_13p_state to authenticated, service_role;

-- Manual fixtures deliberately use the established legacy request path; no
-- certified-bank selector or adaptive assignment is touched by this test.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd1400002-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd1400002-0000-4000-8000-000000000002',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
with requested as (
  select *
  from api.request_practice_worksheet(
    'd1403001-0000-4000-8000-000000000001'
  )
)
update pg_temp.phase_13p_state state
set job_id = requested.job_id
from requested
where state.fixture = 'rich'
  and requested.generation_status = 'queued';
reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd1400003-0000-4000-8000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd1400003-0000-4000-8000-000000000003',
  true
);
set local role authenticated;
with requested as (
  select *
  from api.request_practice_worksheet(
    'd1403002-0000-4000-8000-000000000002'
  )
)
update pg_temp.phase_13p_state state
set job_id = requested.job_id
from requested
where state.fixture = 'mcq'
  and requested.generation_status = 'queued';
reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd1400004-0000-4000-8000-000000000004',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd1400004-0000-4000-8000-000000000004',
  true
);
set local role authenticated;
with requested as (
  select *
  from api.request_practice_worksheet(
    'd1403003-0000-4000-8000-000000000003'
  )
)
update pg_temp.phase_13p_state state
set job_id = requested.job_id
from requested
where state.fixture = 'invalid'
  and requested.generation_status = 'queued';
reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd1400005-0000-4000-8000-000000000005',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd1400005-0000-4000-8000-000000000005',
  true
);
set local role authenticated;
with requested as (
  select *
  from api.request_practice_worksheet(
    'd1403004-0000-4000-8000-000000000004'
  )
)
update pg_temp.phase_13p_state state
set job_id = requested.job_id
from requested
where state.fixture = 'capitalization'
  and requested.generation_status = 'queued';
reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd1400006-0000-4000-8000-000000000006',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd1400006-0000-4000-8000-000000000006',
  true
);
set local role authenticated;
with requested as (
  select *
  from api.request_practice_worksheet(
    'd1403005-0000-4000-8000-000000000005'
  )
)
update pg_temp.phase_13p_state state
set job_id = requested.job_id
from requested
where state.fixture = 'punctuation'
  and requested.generation_status = 'queued';
reset role;

update phase_13p_state state
set queue_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.job_id;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from pg_temp.phase_13p_claim_fixture_job(
    (select job_id from pg_temp.phase_13p_state where fixture = 'rich'),
    (select queue_message_id from pg_temp.phase_13p_state where fixture = 'rich'),
    'd1404001-0000-4000-8000-000000000001'
  )
)
update pg_temp.phase_13p_state state
set job_id = claimed.job_id,
    queue_message_id = claimed.queue_message_id
from claimed
where state.fixture = 'rich';

with claimed as (
  select *
  from pg_temp.phase_13p_claim_fixture_job(
    (select job_id from pg_temp.phase_13p_state where fixture = 'mcq'),
    (select queue_message_id from pg_temp.phase_13p_state where fixture = 'mcq'),
    'd1404002-0000-4000-8000-000000000002'
  )
)
update pg_temp.phase_13p_state state
set job_id = claimed.job_id,
    queue_message_id = claimed.queue_message_id
from claimed
where state.fixture = 'mcq';

with claimed as (
  select *
  from pg_temp.phase_13p_claim_fixture_job(
    (select job_id from pg_temp.phase_13p_state where fixture = 'invalid'),
    (select queue_message_id from pg_temp.phase_13p_state where fixture = 'invalid'),
    'd1404003-0000-4000-8000-000000000003'
  )
)
update pg_temp.phase_13p_state state
set job_id = claimed.job_id,
    queue_message_id = claimed.queue_message_id
from claimed
where state.fixture = 'invalid';

with claimed as (
  select *
  from pg_temp.phase_13p_claim_fixture_job(
    (select job_id from pg_temp.phase_13p_state where fixture = 'capitalization'),
    (select queue_message_id from pg_temp.phase_13p_state where fixture = 'capitalization'),
    'd1404004-0000-4000-8000-000000000004'
  )
)
update pg_temp.phase_13p_state state
set job_id = claimed.job_id,
    queue_message_id = claimed.queue_message_id
from claimed
where state.fixture = 'capitalization';

with claimed as (
  select *
  from pg_temp.phase_13p_claim_fixture_job(
    (select job_id from pg_temp.phase_13p_state where fixture = 'punctuation'),
    (select queue_message_id from pg_temp.phase_13p_state where fixture = 'punctuation'),
    'd1404005-0000-4000-8000-000000000005'
  )
)
update pg_temp.phase_13p_state state
set job_id = claimed.job_id,
    queue_message_id = claimed.queue_message_id
from claimed
where state.fixture = 'punctuation';

reset role;

create or replace function pg_temp.phase_13p_approved_gemini_candidate(
  candidate jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  candidate_hash text := app_private.worksheet_candidate_sha256(candidate);
  passing_checks jsonb := jsonb_build_object(
    'ambiguity_free', true,
    'no_answer_leakage', true,
    'duplicate_free', true,
    'level_fit', true,
    'topic_fit', true,
    'type_balance', true,
    'scoring_safe', true
  );
  passing_content_checks jsonb := jsonb_build_object(
    'mini_lesson_scope_accurate', true,
    'learner_cues_semantically_aligned', true,
    'examples_rubrics_consistent', true
  );
  deepseek_critic jsonb;
  gemini_critic jsonb;
begin
  deepseek_critic := jsonb_build_object(
    'provider', 'deepseek',
    'model', 'deepseek-v4-flash',
    'candidate_sha256', candidate_hash,
    'approved', true,
    'checks', passing_checks,
    'content_checks', passing_content_checks,
    'rejection_reasons', '[]'::jsonb
  );
  deepseek_critic := deepseek_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(deepseek_critic)
  );

  gemini_critic := jsonb_build_object(
    'provider', 'gemini',
    'model', 'gemini-3.1-flash-lite',
    'candidate_sha256', candidate_hash,
    'approved', true,
    'checks', passing_checks,
    'content_checks', passing_content_checks,
    'rejection_reasons', '[]'::jsonb
  );
  gemini_critic := gemini_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(gemini_critic)
  );

  return jsonb_set(
    candidate,
    '{validation}',
    jsonb_build_object(
      'deterministic', true,
      'independent_model', true,
      'critic_model', 'deepseek-v4-flash',
      'candidate_sha256', candidate_hash,
      'critics', jsonb_build_object(
        'deepseek', deepseek_critic,
        'gemini', gemini_critic
      ),
      'attempt_count', 2,
      'checks', passing_checks,
      'content_checks', passing_content_checks,
      'rejection_reasons', '[]'::jsonb
    )
  );
end;
$$;

revoke all on function pg_temp.phase_13p_approved_gemini_candidate(jsonb)
from public;
grant execute on function pg_temp.phase_13p_approved_gemini_candidate(jsonb)
to service_role;

create temporary table phase_13p_payloads (
  fixture text primary key,
  payload jsonb not null
) on commit drop;

insert into phase_13p_payloads (fixture, payload)
values (
  'rich',
  $json$
  {
    "schema_version": 1,
    "mode": "generated",
    "generation_source": "deepseek",
    "level": "A1",
    "difficulty": "medium",
    "title": "Artikel sicher im Satz verwenden",
    "description": "Acht abwechslungsreiche Aufgaben zu deutschen Artikeln.",
    "generator_model": "deepseek-v4-pro",
    "mini_lesson": {
      "short_explanation": "Der Artikel richtet sich nach Genus, Numerus und Kasus des Nomens.",
      "key_rule": "Prüfe zuerst die Funktion des Nomens und wähle dann die passende Artikelform.",
      "common_mistake_warning": "Verwechsle Nominativ und Akkusativ beim Maskulinum nicht.",
      "what_to_revise": "Wiederhole bestimmte und unbestimmte Artikel.",
      "correct_examples": ["Der Pfleger hilft.", "Ich sehe den Pfleger."]
    },
    "source_mix": {
      "mode": "deepseek",
      "deepseek_count": 8,
      "fallback_count": 0
    },
    "validation": {
      "deterministic": true,
      "independent_model": true,
      "critic_model": "deepseek-v4-flash",
      "attempt_count": 2,
      "checks": {
        "ambiguity_free": true,
        "no_answer_leakage": true,
        "duplicate_free": true,
        "level_fit": true,
        "topic_fit": true,
        "type_balance": true,
        "scoring_safe": true
      },
      "rejection_reasons": []
    },
    "questions": [
      {
        "question_number": 1,
        "question_type": "multiple_choice",
        "evaluation_mode": "local_exact",
        "prompt": "Welcher Artikel ergänzt den Satz korrekt: Ich sehe ___ Pfleger?",
        "options": ["den", "dem", "der"],
        "correct_answer": "den",
        "accepted_answers": ["den"],
        "rubric": null,
        "explanation": "Das maskuline direkte Objekt steht im Akkusativ."
      },
      {
        "question_number": 2,
        "question_type": "multiple_choice",
        "evaluation_mode": "local_exact",
        "prompt": "Welcher Artikel ergänzt den Satz korrekt: ___ Pflegekraft kommt?",
        "options": ["Die", "Den", "Dem"],
        "correct_answer": "Die",
        "accepted_answers": ["Die"],
        "rubric": null,
        "explanation": "Pflegekraft ist feminin und hier das Subjekt."
      },
      {
        "question_number": 3,
        "question_type": "fill_blank",
        "evaluation_mode": "local_exact",
        "prompt": "Ergänze mit dem bestimmten Artikel: Ich besuche ___ Patienten.",
        "options": [],
        "correct_answer": "den",
        "accepted_answers": ["den"],
        "rubric": null,
        "explanation": "Patienten ist hier ein maskulines Akkusativobjekt."
      },
      {
        "question_number": 4,
        "question_type": "fill_blank",
        "evaluation_mode": "local_exact",
        "prompt": "Ergänze mit dem unbestimmten Artikel: Dort liegt ___ Buch.",
        "options": [],
        "correct_answer": "ein",
        "accepted_answers": ["ein"],
        "rubric": null,
        "explanation": "Buch ist neutral und steht hier im Nominativ."
      },
      {
        "question_number": 5,
        "question_type": "fill_blank",
        "evaluation_mode": "local_exact",
        "prompt": "Ergänze mit dem bestimmten Artikel: Sie öffnet ___ Tür.",
        "options": [],
        "correct_answer": "die",
        "accepted_answers": ["die"],
        "rubric": null,
        "explanation": "Das feminine Akkusativobjekt verwendet die."
      },
      {
        "question_number": 6,
        "question_type": "sentence_correction",
        "evaluation_mode": "open_evaluation",
        "prompt": "Korrigiere vollständig: Ich sehe der neue Patient.",
        "options": [],
        "correct_answer": "Ich sehe den neuen Patienten.",
        "accepted_answers": [],
        "rubric": {
          "criteria": ["Setze Artikel, Adjektiv und Nomen in den Akkusativ."],
          "sample_answer": "Ich sehe den neuen Patienten."
        },
        "explanation": "Das maskuline direkte Objekt benötigt Akkusativformen."
      },
      {
        "question_number": 7,
        "question_type": "word_order",
        "evaluation_mode": "open_evaluation",
        "prompt": "Ordne zu einem korrekten Satz: die / Pflegekraft / kommt / heute",
        "options": [],
        "correct_answer": "Die Pflegekraft kommt heute.",
        "accepted_answers": [],
        "rubric": {
          "criteria": ["Bilde einen Hauptsatz mit dem Verb an Position zwei."],
          "sample_answer": "Die Pflegekraft kommt heute."
        },
        "explanation": "Im Hauptsatz steht das finite Verb an Position zwei."
      },
      {
        "question_number": 8,
        "question_type": "transformation",
        "evaluation_mode": "open_evaluation",
        "prompt": "Formuliere mit bestimmtem Artikel um: Eine Ärztin hilft.",
        "options": [],
        "correct_answer": "Die Ärztin hilft.",
        "accepted_answers": [],
        "rubric": {
          "criteria": ["Ersetze nur den unbestimmten durch den bestimmten Artikel."],
          "sample_answer": "Die Ärztin hilft."
        },
        "explanation": "Der bestimmte feminine Nominativartikel lautet die."
      }
    ]
  }
  $json$::jsonb
);

insert into phase_13p_payloads (fixture, payload)
select
  'mcq',
  jsonb_build_object(
    'schema_version', 1,
    'mode', 'generated',
    'generation_source', 'deepseek',
    'level', 'A1',
    'difficulty', 'medium',
    'title', 'Artikel als sichere Auswahlaufgaben',
    'description', 'Acht eindeutig auswertbare Multiple-Choice-Aufgaben.',
    'generator_model', 'deepseek-v4-pro',
    'mini_lesson', jsonb_build_object(
      'short_explanation',
        'Artikel zeigen Genus, Numerus und Kasus eines Nomens.',
      'key_rule',
        'Bestimme die Satzfunktion, bevor du den Artikel auswählst.',
      'common_mistake_warning',
        'Beim Maskulinum unterscheiden sich Nominativ und Akkusativ.',
      'what_to_revise',
        'Wiederhole der, die, das und ihre Akkusativformen.',
      'correct_examples',
        jsonb_build_array('Der Patient wartet.', 'Ich sehe den Patienten.')
    ),
    'source_mix', jsonb_build_object(
      'mode', 'deepseek',
      'deepseek_count', 8,
      'fallback_count', 0
    ),
    'validation', jsonb_build_object(
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
    ),
    'questions', (
      select jsonb_agg(
        jsonb_build_object(
          'question_number', number,
          'question_type', 'multiple_choice',
          'evaluation_mode', 'local_exact',
          'prompt', format(
            'Welche Artikelform passt eindeutig in Beispielsatz Nummer %s?',
            number
          ),
          'options', jsonb_build_array(
            format('Form %sA', number),
            format('Form %sB', number),
            format('Form %sC', number)
          ),
          'correct_answer', format('Form %sA', number),
          'accepted_answers', jsonb_build_array(format('Form %sA', number)),
          'rubric', null,
          'explanation', format(
            'Nur Form %sA erfüllt die im Satz genannte Artikelbedingung.',
            number
          )
        )
        order by number
      )
      from generate_series(1, 8) number
    )
  );

insert into phase_13p_payloads (fixture, payload)
select
  'gemini_mcq',
  pg_temp.phase_13p_approved_gemini_candidate(
    payload || jsonb_build_object(
      'generation_source', 'gemini',
      'generator_model', 'gemini-3.1-flash-lite',
      'source_mix', jsonb_build_object(
        'mode', 'gemini',
        'deepseek_count', 0,
        'gemini_count', 8
      )
    )
  )
from phase_13p_payloads
where fixture = 'mcq';

insert into phase_13p_payloads (fixture, payload)
select
  'gemini_invalid_contract',
  pg_temp.phase_13p_approved_gemini_candidate(
    jsonb_set(
      (payload - 'validation') || jsonb_build_object(
        'generation_source', 'gemini',
        'generator_model', 'gemini-3.1-flash-lite',
        'source_mix', jsonb_build_object(
          'mode', 'gemini',
          'deepseek_count', 0,
          'gemini_count', 8
        )
      ),
      '{questions,0,accepted_answers}',
      '["Form 1A", "Form 1B"]'::jsonb
    )
  )
from phase_13p_payloads
where fixture = 'mcq';

insert into phase_13p_payloads (fixture, payload)
select
  'capitalization',
  jsonb_set(
    payload || jsonb_build_object(
      'title', 'Groß- und Kleinschreibung sicher unterscheiden',
      'description',
        'Acht eindeutige Auswahlaufgaben zur deutschen Großschreibung.',
      'mini_lesson', jsonb_build_object(
        'short_explanation',
          'Deutsche Nomen beginnen mit einem Großbuchstaben.',
        'key_rule',
          'Schreibe Nomen wie Pflege und Patient am Wortanfang groß.',
        'common_mistake_warning',
          'Verwechsle Nomen nicht mit kleingeschriebenen Wortformen.',
        'what_to_revise',
          'Wiederhole die Großschreibung deutscher Nomen.',
        'correct_examples',
          jsonb_build_array('Die Pflege ist wichtig.', 'Der Patient wartet.')
      )
    ),
    '{questions,0}',
    (payload #> '{questions,0}') || jsonb_build_object(
      'prompt',
        'Welche Schreibweise des deutschen Nomens ist genau richtig?',
      'options', jsonb_build_array('Pflege', 'pflege', 'PFLEGE'),
      'correct_answer', 'Pflege',
      'accepted_answers', jsonb_build_array('Pflege'),
      'explanation', 'Das Nomen Pflege beginnt mit einem Großbuchstaben.'
    )
  )
from phase_13p_payloads
where fixture = 'mcq';

insert into phase_13p_payloads (fixture, payload)
select
  'punctuation',
  jsonb_set(
    payload || jsonb_build_object(
      'title', 'Satzzeichen eindeutig auswählen',
      'description',
        'Acht eindeutige Auswahlaufgaben zu deutschen Satzzeichen.',
      'mini_lesson', jsonb_build_object(
        'short_explanation',
          'Aussagesätze, Fragen und Ausrufe enden mit passenden Satzzeichen.',
        'key_rule',
          'Nutze Punkt, Fragezeichen oder Ausrufezeichen nach der Satzart.',
        'common_mistake_warning',
          'Eine direkte Frage endet nicht mit einem Punkt.',
        'what_to_revise',
          'Wiederhole die Satzzeichen am Satzende.',
        'correct_examples',
          jsonb_build_array('Du kommst morgen.', 'Kommst du morgen?')
      )
    ),
    '{questions,0}',
    (payload #> '{questions,0}') || jsonb_build_object(
      'prompt',
        'Welche vollständige direkte Frage hat das richtige Satzzeichen?',
      'options', jsonb_build_array(
        'Kommst du morgen.',
        'Kommst du morgen?',
        'Kommst du morgen!'
      ),
      'correct_answer', 'Kommst du morgen?',
      'accepted_answers', jsonb_build_array('Kommst du morgen?'),
      'explanation', 'Eine direkte Frage endet mit einem Fragezeichen.'
    )
  )
from phase_13p_payloads
where fixture = 'mcq';

grant select on table phase_13p_payloads to service_role;

select lives_ok(
  $$
    with completed as (
      select *
      from public.complete_worksheet_generation(
        (select job_id from pg_temp.phase_13p_state where fixture = 'rich'),
        (select queue_message_id from pg_temp.phase_13p_state where fixture = 'rich'),
        'd1404001-0000-4000-8000-000000000001',
        (select payload from pg_temp.phase_13p_payloads where fixture = 'rich')
      )
    )
    update pg_temp.phase_13p_state state
    set practice_test_id = completed.practice_test_id
    from completed
    where state.fixture = 'rich'
      and completed.generation_status = 'ready'
      and completed.quality_status = 'approved'
  $$,
  'the unchanged historical rich-mix path still completes successfully'
);

select ok(
  (
    select count(*) filter (where question.evaluation_mode = 'open_evaluation')
        between 1 and 3
      and count(*) filter (where question.question_type = 'multiple_choice') >= 2
      and count(*) filter (where question.question_type = 'fill_blank') >= 2
    from public.practice_test_questions question
    where question.practice_test_id = (
      select practice_test_id
      from phase_13p_state
      where fixture = 'rich'
    )
  ),
  'the rich completion persists the established mixed-format contract'
);

set local role service_role;
select lives_ok(
  $$
    with completed as (
      select *
      from api.complete_worksheet_generation(
        (select job_id from pg_temp.phase_13p_state where fixture = 'mcq'),
        (select queue_message_id from pg_temp.phase_13p_state where fixture = 'mcq'),
        'd1404002-0000-4000-8000-000000000002',
        (
          select payload
          from pg_temp.phase_13p_payloads
          where fixture = 'gemini_mcq'
        )
      )
    )
    update pg_temp.phase_13p_state state
    set practice_test_id = completed.practice_test_id
    from completed
    where state.fixture = 'mcq'
      and completed.generation_status = 'ready'
      and completed.quality_status = 'approved'
  $$,
  'a Gemini all-MCQ worksheet completes through the production API facade'
);
reset role;

select ok(
  (
    (
      select count(*) = 8
        and bool_and(question.question_type = 'multiple_choice')
        and bool_and(question.evaluation_mode = 'local_exact')
        and bool_and(jsonb_array_length(question.options) between 3 and 4)
        and bool_and(jsonb_array_length(question.accepted_answers) = 1)
        and bool_and(
          question.accepted_answers #>> '{0}' = question.correct_answer
        )
        and bool_and(question.rubric is null)
      from public.practice_test_questions question
      where question.practice_test_id = (
        select practice_test_id
        from phase_13p_state
        where fixture = 'mcq'
      )
    )
    and exists (
      select 1
      from public.practice_tests worksheet
      join app_private.worksheet_generation_completions_v2 completion
        on completion.practice_test_id = worksheet.id
      where worksheet.id = (
          select practice_test_id
          from phase_13p_state
          where fixture = 'mcq'
        )
        and worksheet.generation_source = 'gemini'
        and worksheet.generator_model = 'gemini-3.1-flash-lite'
        and worksheet.generation_metadata #>> '{source_mix,mode}' = 'gemini'
        and worksheet.generation_metadata #>> '{source_mix,deepseek_count}' = '0'
        and worksheet.generation_metadata #>> '{source_mix,gemini_count}' = '8'
        and completion.provider_source = 'gemini'
        and completion.generator_model = 'gemini-3.1-flash-lite'
        and completion.candidate_sha256 =
          worksheet.generation_metadata #>> '{validation,candidate_sha256}'
    )
  ),
  'the facade preserves eight exact contracts and truthful Gemini provenance'
);

select lives_ok(
  $$
    with completed as (
      select *
      from public.complete_worksheet_generation(
        (select job_id from pg_temp.phase_13p_state where fixture = 'capitalization'),
        (select queue_message_id from pg_temp.phase_13p_state where fixture = 'capitalization'),
        'd1404004-0000-4000-8000-000000000004',
        (
          select payload
          from pg_temp.phase_13p_payloads
          where fixture = 'capitalization'
        )
      )
    )
    update pg_temp.phase_13p_state state
    set practice_test_id = completed.practice_test_id
    from completed
    where state.fixture = 'capitalization'
      and completed.generation_status = 'ready'
      and completed.quality_status = 'approved'
  $$,
  'a capitalization MCQ-safe worksheet accepts case-distinct choices'
);

select ok(
  exists (
    select 1
    from public.practice_test_questions question
    where question.practice_test_id = (
        select practice_test_id
        from phase_13p_state
        where fixture = 'capitalization'
      )
      and question.question_number = 1
      and question.options = '["Pflege", "pflege", "PFLEGE"]'::jsonb
      and question.correct_answer = 'Pflege'
      and question.accepted_answers = '["Pflege"]'::jsonb
  ),
  'capitalization completion preserves the exact case-sensitive MCQ contract'
);

select lives_ok(
  $$
    with completed as (
      select *
      from public.complete_worksheet_generation(
        (select job_id from pg_temp.phase_13p_state where fixture = 'punctuation'),
        (select queue_message_id from pg_temp.phase_13p_state where fixture = 'punctuation'),
        'd1404005-0000-4000-8000-000000000005',
        (
          select payload
          from pg_temp.phase_13p_payloads
          where fixture = 'punctuation'
        )
      )
    )
    update pg_temp.phase_13p_state state
    set practice_test_id = completed.practice_test_id
    from completed
    where state.fixture = 'punctuation'
      and completed.generation_status = 'ready'
      and completed.quality_status = 'approved'
  $$,
  'a punctuation MCQ-safe worksheet accepts punctuation-only distinctions'
);

select ok(
  exists (
    select 1
    from public.practice_test_questions question
    where question.practice_test_id = (
        select practice_test_id
        from phase_13p_state
        where fixture = 'punctuation'
      )
      and question.question_number = 1
      and question.options =
        '["Kommst du morgen.", "Kommst du morgen?", "Kommst du morgen!"]'::jsonb
      and question.correct_answer = 'Kommst du morgen?'
      and question.accepted_answers = '["Kommst du morgen?"]'::jsonb
  ),
  'punctuation completion preserves exact punctuation in options and answer'
);

select throws_ok(
  $$
    select *
    from public.complete_worksheet_generation(
      (select job_id from pg_temp.phase_13p_state where fixture = 'invalid'),
      (select queue_message_id from pg_temp.phase_13p_state where fixture = 'invalid'),
      'd1404003-0000-4000-8000-000000000003',
      jsonb_set(
        (select payload from pg_temp.phase_13p_payloads where fixture = 'mcq'),
        '{questions,0,options}',
        '["Form 1A", "form 1a", "Form 1C"]'::jsonb
      )
    )
  $$,
  '22023',
  'Generated worksheet contains duplicate or unsafe options.',
  'an ordinary-topic MCQ-safe payload rejects case-only duplicate options'
);

select throws_ok(
  $$
    select *
    from public.complete_worksheet_generation(
      (select job_id from pg_temp.phase_13p_state where fixture = 'invalid'),
      (select queue_message_id from pg_temp.phase_13p_state where fixture = 'invalid'),
      'd1404003-0000-4000-8000-000000000003',
      jsonb_set(
        jsonb_set(
          (select payload from pg_temp.phase_13p_payloads where fixture = 'mcq'),
          '{questions,0,correct_answer}',
          '"Form 1a"'::jsonb
        ),
        '{questions,0,accepted_answers}',
        '["Form 1a"]'::jsonb
      )
    )
  $$,
  '22023',
  'Generated worksheet mix is unsafe.',
  'MCQ-safe rejects a case-drift answer absent from the literal option list'
);

set local role service_role;
select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_13p_state where fixture = 'invalid'),
      (select queue_message_id from pg_temp.phase_13p_state where fixture = 'invalid'),
      'd1404003-0000-4000-8000-000000000003',
      (
        select payload
        from pg_temp.phase_13p_payloads
        where fixture = 'gemini_invalid_contract'
      )
    )
  $$,
  '22023',
  'Generated worksheet mix is unsafe.',
  'the API facade rejects a Gemini MCQ with a non-exact answer contract'
);
reset role;

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    join pgmq.q_worksheet_generation queue
      on queue.msg_id = job.queue_message_id
    where job.id = (
        select job_id from phase_13p_state where fixture = 'invalid'
      )
      and job.status = 'processing'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'generating'
      and not exists (
        select 1
        from public.practice_tests test
        where test.generation_job_id = job.id
      )
      and not exists (
        select 1
        from pgmq.a_worksheet_generation archive
        where archive.msg_id = job.queue_message_id
      )
  ),
  'rejected MCQ-safe payloads leave no partial worksheet or queue transition'
);

select * from finish(true);
rollback;
