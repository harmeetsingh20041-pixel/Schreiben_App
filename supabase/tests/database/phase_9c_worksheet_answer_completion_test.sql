begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(54);

-- Stable worker signature and service-only execution boundary.
select ok(
  to_regprocedure(
    'public.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)'
  ) is not null,
  'worksheet answer completion has the stable worker signature'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    ),
  'only the adjudicated worker facade is service-role callable'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'authenticated')::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select throws_ok(
  $$
    select *
    from public.complete_worksheet_answer_evaluation(
      null::uuid,
      null::bigint,
      null::uuid,
      '{}'::jsonb
    )
  $$,
  '42501',
  'permission denied for function complete_worksheet_answer_evaluation',
  'an authenticated browser caller cannot execute the completion worker'
);
reset role;

-- Phase 12L intentionally revoked the legacy single-provider scorer from the
-- service role. This rollback-only owner wrapper keeps the Phase 9C atomic
-- scoring regression focused on that internal core without reopening its
-- production grant or bypassing the service-role JWT assertion.
create or replace function pg_temp.complete_phase_9c_fixture_answer(
  target_job_id uuid,
  target_queue_message_id bigint,
  target_worker_id uuid,
  result jsonb
)
returns table (
  attempt_id uuid,
  assignment_id uuid,
  evaluation_status text,
  attempt_status text,
  assignment_status text,
  score_points numeric,
  max_score_points numeric,
  score_percent numeric,
  passed boolean
)
language sql
security definer
set search_path = ''
as $$
  select *
  from public.complete_worksheet_answer_evaluation(
    target_job_id,
    target_queue_message_id,
    target_worker_id,
    result
  );
$$;

revoke all on function pg_temp.complete_phase_9c_fixture_answer(
  uuid, bigint, uuid, jsonb
) from public, anon, authenticated;
grant execute on function pg_temp.complete_phase_9c_fixture_answer(
  uuid, bigint, uuid, jsonb
) to service_role;

-- The production claimer intentionally reads the whole queue. A shared-
-- staging regression must not lease or archive unrelated student work, so the
-- rollback-only helper below transitions only an exact fixture job/message
-- pair before the real completion, retry, and offboarding APIs are exercised.
create or replace function pg_temp.claim_phase_9c_fixture_job(
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
      message = 'phase_9c_fixture_claim_required';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_answer_evaluation'
    and job.queue_name = 'worksheet_answer_evaluation'
    and job.queue_message_id = target_queue_message_id
  for update;

  if selected_job.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'phase_9c_fixture_job_not_found';
  end if;

  select queue.message
  into selected_payload
  from pgmq.q_worksheet_answer_evaluation queue
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
      message = 'phase_9c_fixture_message_mismatch';
  end if;

  update pgmq.q_worksheet_answer_evaluation queue
  set
    vt = clock_timestamp() + make_interval(secs => visibility_seconds),
    read_ct = queue.read_ct + 1
  where queue.msg_id = target_queue_message_id
    and queue.vt <= clock_timestamp()
  returning queue.message into selected_payload;

  if selected_payload is null then
    raise exception using
      errcode = '55000',
      message = 'phase_9c_fixture_message_not_visible';
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
      message = 'phase_9c_fixture_job_not_claimable';
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

revoke all on function pg_temp.claim_phase_9c_fixture_job(
  uuid, bigint, uuid, integer
) from public;
grant execute on function pg_temp.claim_phase_9c_fixture_job(
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
    'c9011111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase9c-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9C Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c9022222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase9c-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9C Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'c9033333-3333-4333-8333-333333333333',
  'Phase 9C Workspace',
  'phase-9c-workspace',
  'c9011111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'c9011111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c9033333-3333-4333-8333-333333333333',
  'c9011111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c9033333-3333-4333-8333-333333333333',
  'c9022222-2222-4222-8222-222222222222',
  'student'
);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'c9044444-4444-4444-8444-444444444444',
  'phase-9c-satzbau',
  'Phase 9C Satzbau',
  'A2',
  'A reset-safe topic for worksheet answer completion tests.'
);

-- Validation, maximum-flexible-question, and successful-finalization
-- worksheets are separate so failed calls can reuse an unchanged active job.
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
    'c9100000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9044444-4444-4444-8444-444444444444',
    'A2',
    'medium',
    'Phase 9C validation worksheet',
    'One objective and two flexible questions.',
    false,
    true,
    'workspace',
    'c9011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'c9200000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9044444-4444-4444-8444-444444444444',
    'A2',
    'medium',
    'Phase 9C over-limit worksheet',
    'Four flexible questions exercise the hard completion ceiling.',
    false,
    true,
    'workspace',
    'c9011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'c9300000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9044444-4444-4444-8444-444444444444',
    'A2',
    'medium',
    'Phase 9C success worksheet',
    'One objective and two flexible questions for atomic finalization.',
    false,
    true,
    'workspace',
    'c9011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  );

insert into public.practice_test_questions (
  id,
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
values
  (
    'c9111111-1111-4111-8111-111111111111',
    'c9100000-0000-4000-8000-000000000000',
    1,
    'multiple_choice',
    'local_exact',
    'Welche Antwort ist richtig?',
    '["Heute lerne ich.", "Heute ich lerne."]'::jsonb,
    'Heute lerne ich.',
    '["Heute lerne ich."]'::jsonb,
    null,
    1,
    'Das Verb steht an Position zwei.'
  ),
  (
    'c9122222-2222-4222-8222-222222222222',
    'c9100000-0000-4000-8000-000000000000',
    2,
    'mini_writing',
    'open_evaluation',
    'Schreibe einen Satz mit weil.',
    null,
    'Ich lerne Deutsch, weil ich in Berlin wohne.',
    '[]'::jsonb,
    '{"criteria":["Use weil with a grammatically complete subordinate clause."],"sample_answer":"Ich lerne Deutsch, weil ich in Berlin wohne."}'::jsonb,
    1,
    'Im Nebensatz steht das Verb am Ende.'
  ),
  (
    'c9133333-3333-4333-8333-333333333333',
    'c9100000-0000-4000-8000-000000000000',
    3,
    'mini_writing',
    'open_evaluation',
    'Schreibe einen Satz mit obwohl.',
    null,
    'Obwohl es regnet, gehe ich spazieren.',
    '[]'::jsonb,
    '{"criteria":["Use obwohl with correct verb-final subordinate-clause order."],"sample_answer":"Obwohl es regnet, gehe ich spazieren."}'::jsonb,
    1,
    'Der obwohl-Satz hat Verbendstellung.'
  ),
  (
    'c9211111-1111-4111-8111-111111111111',
    'c9200000-0000-4000-8000-000000000000',
    1,
    'mini_writing',
    'open_evaluation',
    'Flexible Aufgabe eins.',
    null,
    'Beispielantwort eins.',
    '[]'::jsonb,
    '{"criteria":["Produce a grammatically valid response to the stated task."],"sample_answer":"Beispielantwort eins."}'::jsonb,
    1,
    'Offene Bewertung.'
  ),
  (
    'c9222222-2222-4222-8222-222222222222',
    'c9200000-0000-4000-8000-000000000000',
    2,
    'mini_writing',
    'open_evaluation',
    'Flexible Aufgabe zwei.',
    null,
    'Beispielantwort zwei.',
    '[]'::jsonb,
    '{"criteria":["Produce a grammatically valid response to the stated task."],"sample_answer":"Beispielantwort zwei."}'::jsonb,
    1,
    'Offene Bewertung.'
  ),
  (
    'c9233333-3333-4333-8333-333333333333',
    'c9200000-0000-4000-8000-000000000000',
    3,
    'mini_writing',
    'open_evaluation',
    'Flexible Aufgabe drei.',
    null,
    'Beispielantwort drei.',
    '[]'::jsonb,
    '{"criteria":["Produce a grammatically valid response to the stated task."],"sample_answer":"Beispielantwort drei."}'::jsonb,
    1,
    'Offene Bewertung.'
  ),
  (
    'c9244444-4444-4444-8444-444444444444',
    'c9200000-0000-4000-8000-000000000000',
    4,
    'mini_writing',
    'open_evaluation',
    'Flexible Aufgabe vier.',
    null,
    'Beispielantwort vier.',
    '[]'::jsonb,
    '{"criteria":["Produce a grammatically valid response to the stated task."],"sample_answer":"Beispielantwort vier."}'::jsonb,
    1,
    'Offene Bewertung.'
  ),
  (
    'c9311111-1111-4111-8111-111111111111',
    'c9300000-0000-4000-8000-000000000000',
    1,
    'multiple_choice',
    'local_exact',
    'Welche Antwort ist richtig?',
    '["Heute lerne ich.", "Heute ich lerne."]'::jsonb,
    'Heute lerne ich.',
    '["Heute lerne ich."]'::jsonb,
    null,
    1,
    'Das Verb steht an Position zwei.'
  ),
  (
    'c9322222-2222-4222-8222-222222222222',
    'c9300000-0000-4000-8000-000000000000',
    2,
    'mini_writing',
    'open_evaluation',
    'Schreibe einen Satz mit weil.',
    null,
    'Ich lerne Deutsch, weil ich in Berlin wohne.',
    '[]'::jsonb,
    '{"criteria":["Use weil with a grammatically complete subordinate clause."],"sample_answer":"Ich lerne Deutsch, weil ich in Berlin wohne."}'::jsonb,
    1,
    'Im Nebensatz steht das Verb am Ende.'
  ),
  (
    'c9333333-3333-4333-8333-333333333333',
    'c9300000-0000-4000-8000-000000000000',
    3,
    'mini_writing',
    'open_evaluation',
    'Schreibe einen Satz mit obwohl.',
    null,
    'Obwohl es regnet, gehe ich spazieren.',
    '[]'::jsonb,
    '{"criteria":["Use obwohl with correct verb-final subordinate-clause order."],"sample_answer":"Obwohl es regnet, gehe ich spazieren."}'::jsonb,
    1,
    'Der obwohl-Satz hat Verbendstellung.'
  ),
  (
    'c9344444-4444-4444-8444-444444444444',
    'c9300000-0000-4000-8000-000000000000',
    4,
    'mini_writing',
    'open_evaluation',
    'Schreibe einen Satz mit dass.',
    null,
    'Ich weiß, dass du heute arbeitest.',
    '[]'::jsonb,
    '{"criteria":["Use dass with correct verb-final subordinate-clause order."],"sample_answer":"Ich weiß, dass du heute arbeitest."}'::jsonb,
    1,
    'Im dass-Satz steht das Verb am Ende.'
  );

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  source,
  status,
  assigned_by,
  generation_status
)
values
  (
    'c9400000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9022222-2222-4222-8222-222222222222',
    'c9044444-4444-4444-8444-444444444444',
    'c9100000-0000-4000-8000-000000000000',
    'manual',
    'completed',
    'c9011111-1111-4111-8111-111111111111',
    'ready'
  ),
  (
    'c9500000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9022222-2222-4222-8222-222222222222',
    'c9044444-4444-4444-8444-444444444444',
    'c9200000-0000-4000-8000-000000000000',
    'manual',
    'completed',
    'c9011111-1111-4111-8111-111111111111',
    'ready'
  ),
  (
    'c9600000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9022222-2222-4222-8222-222222222222',
    'c9044444-4444-4444-8444-444444444444',
    'c9300000-0000-4000-8000-000000000000',
    'manual',
    'completed',
    'c9011111-1111-4111-8111-111111111111',
    'ready'
  );

insert into public.practice_test_attempts (
  id,
  practice_test_id,
  student_id,
  workspace_id,
  assignment_id,
  answers,
  score,
  max_score,
  score_points,
  max_score_points,
  scoring_version,
  evaluation_status,
  evaluation_version,
  status,
  started_at,
  submitted_at,
  completed_at
)
values
  (
    'c9411111-1111-4111-8111-111111111111',
    'c9100000-0000-4000-8000-000000000000',
    'c9022222-2222-4222-8222-222222222222',
    'c9033333-3333-4333-8333-333333333333',
    'c9400000-0000-4000-8000-000000000000',
    jsonb_build_array(
      jsonb_build_object(
        'question_id', 'c9111111-1111-4111-8111-111111111111',
        'answer', 'Heute lerne ich.'
      ),
      jsonb_build_object(
        'question_id', 'c9122222-2222-4222-8222-222222222222',
        'answer', 'Ich bleibe zu Hause, weil ich krank bin.'
      ),
      jsonb_build_object(
        'question_id', 'c9133333-3333-4333-8333-333333333333',
        'answer', 'Obwohl es kalt ist, gehe ich raus.'
      )
    ),
    0,
    0,
    null,
    null,
    'phase_9c_pending_fixture',
    'queued',
    1,
    'submitted',
    now(),
    now(),
    now()
  ),
  (
    'c9511111-1111-4111-8111-111111111111',
    'c9200000-0000-4000-8000-000000000000',
    'c9022222-2222-4222-8222-222222222222',
    'c9033333-3333-4333-8333-333333333333',
    'c9500000-0000-4000-8000-000000000000',
    jsonb_build_array(
      jsonb_build_object(
        'question_id', 'c9211111-1111-4111-8111-111111111111',
        'answer', 'Antwort eins.'
      ),
      jsonb_build_object(
        'question_id', 'c9222222-2222-4222-8222-222222222222',
        'answer', 'Antwort zwei.'
      ),
      jsonb_build_object(
        'question_id', 'c9233333-3333-4333-8333-333333333333',
        'answer', 'Antwort drei.'
      ),
      jsonb_build_object(
        'question_id', 'c9244444-4444-4444-8444-444444444444',
        'answer', 'Antwort vier.'
      )
    ),
    0,
    0,
    null,
    null,
    'phase_9c_pending_fixture',
    'queued',
    1,
    'submitted',
    now(),
    now(),
    now()
  ),
  (
    'c9611111-1111-4111-8111-111111111111',
    'c9300000-0000-4000-8000-000000000000',
    'c9022222-2222-4222-8222-222222222222',
    'c9033333-3333-4333-8333-333333333333',
    'c9600000-0000-4000-8000-000000000000',
    jsonb_build_array(
      jsonb_build_object(
        'question_id', 'c9311111-1111-4111-8111-111111111111',
        'answer', 'Heute lerne ich.'
      ),
      jsonb_build_object(
        'question_id', 'c9322222-2222-4222-8222-222222222222',
        'answer', 'Ich bleibe zu Hause, weil ich krank bin.'
      ),
      jsonb_build_object(
        'question_id', 'c9333333-3333-4333-8333-333333333333',
        'answer', 'Obwohl es kalt ist gehe ich raus.'
      ),
      jsonb_build_object(
        'question_id', 'c9344444-4444-4444-8444-444444444444',
        'answer', 'Ich weiß, dass du heute arbeitest.'
      )
    ),
    0,
    0,
    null,
    null,
    'phase_9c_pending_fixture',
    'queued',
    1,
    'submitted',
    now(),
    now(),
    now()
  );

update public.student_practice_assignments
set latest_attempt_id = case id
  when 'c9400000-0000-4000-8000-000000000000'::uuid
    then 'c9411111-1111-4111-8111-111111111111'::uuid
  when 'c9500000-0000-4000-8000-000000000000'::uuid
    then 'c9511111-1111-4111-8111-111111111111'::uuid
  when 'c9600000-0000-4000-8000-000000000000'::uuid
    then 'c9611111-1111-4111-8111-111111111111'::uuid
end
where id in (
  'c9400000-0000-4000-8000-000000000000',
  'c9500000-0000-4000-8000-000000000000',
  'c9600000-0000-4000-8000-000000000000'
);

insert into public.student_grammar_stats (
  workspace_id,
  student_id,
  grammar_topic_id,
  weakness_level,
  practice_unlocked
)
values (
  'c9033333-3333-4333-8333-333333333333',
  'c9022222-2222-4222-8222-222222222222',
  'c9044444-4444-4444-8444-444444444444',
  'unlocked',
  true
);

create temporary table phase_9c_state (
  singleton boolean primary key default true check (singleton),
  validation_job_id uuid,
  validation_message_id bigint,
  max_job_id uuid,
  max_message_id bigint,
  success_job_id uuid,
  success_message_id bigint,
  response_attempt_id uuid,
  response_assignment_id uuid,
  response_evaluation_status text,
  response_attempt_status text,
  response_assignment_status text,
  response_score_points numeric,
  response_max_score_points numeric,
  response_score_percent numeric,
  response_passed boolean,
  success_reclaimed_attempt integer,
  success_review_snapshot jsonb
) on commit drop;

insert into phase_9c_state default values;
grant select, update on table phase_9c_state to service_role;

create temporary table phase_9c_payloads (
  name text primary key,
  payload jsonb not null
) on commit drop;
grant select on table phase_9c_payloads to service_role;

insert into phase_9c_payloads (name, payload)
values
  (
    'validation',
    jsonb_build_object(
      'schema_version', 1,
      'mode', 'evaluated',
      'evaluator_model', 'deepseek-v4-flash',
      'reviews', jsonb_build_array(
        jsonb_build_object(
          'question_id', 'c9122222-2222-4222-8222-222222222222',
          'review_status', 'correct',
          'points_awarded', 1,
          'max_points', 1,
          'evaluator_source', 'deepseek',
          'feedback_text', 'Der Satz ist grammatisch passend.',
          'corrected_answer', null,
          'model_answer', 'Ich bleibe zu Hause, weil ich krank bin.',
          'short_reason', 'Die Verbendstellung ist korrekt.'
        ),
        jsonb_build_object(
          'question_id', 'c9133333-3333-4333-8333-333333333333',
          'review_status', 'partially_correct',
          'points_awarded', 0.5,
          'max_points', 1,
          'evaluator_source', 'deepseek',
          'feedback_text', 'Der Satz ist verständlich und fast vollständig.',
          'corrected_answer', 'Obwohl es kalt ist, gehe ich raus.',
          'model_answer', 'Obwohl es kalt ist, gehe ich raus.',
          'short_reason', 'Die Struktur passt; ein kleines Detail wurde verbessert.'
        )
      )
    )
  ),
  (
    'success',
    jsonb_build_object(
      'schema_version', 1,
      'mode', 'evaluated',
      'evaluator_model', 'deepseek-v4-flash',
      'reviews', jsonb_build_array(
        jsonb_build_object(
          'question_id', 'c9322222-2222-4222-8222-222222222222',
          'review_status', 'correct',
          'points_awarded', 1,
          'max_points', 1,
          'evaluator_source', 'deepseek',
          'feedback_text', 'Der Satz ist grammatisch passend.',
          'corrected_answer', null,
          'model_answer', 'Ich bleibe zu Hause, weil ich krank bin.',
          'short_reason', 'Die Verbendstellung ist korrekt.'
        ),
        jsonb_build_object(
          'question_id', 'c9333333-3333-4333-8333-333333333333',
          'review_status', 'partially_correct',
          'points_awarded', 0.5,
          'max_points', 1,
          'evaluator_source', 'deepseek',
          'feedback_text', 'Der Satz ist verständlich und fast vollständig.',
          'corrected_answer', 'Obwohl es kalt ist, gehe ich raus.',
          'model_answer', 'Obwohl es kalt ist, gehe ich raus.',
          'short_reason', 'Die Struktur passt; ein kleines Detail wurde verbessert.'
        ),
        jsonb_build_object(
          'question_id', 'c9344444-4444-4444-8444-444444444444',
          'review_status', 'correct',
          'points_awarded', 1,
          'max_points', 1,
          'evaluator_source', 'deepseek',
          'feedback_text', 'Der dass-Satz ist vollständig korrekt.',
          'corrected_answer', null,
          'model_answer', 'Ich weiß, dass du heute arbeitest.',
          'short_reason', 'Das Verb steht richtig am Satzende.'
        )
      )
    )
  );

-- Derived malformed payloads each isolate one completion contract.
insert into phase_9c_payloads (name, payload)
select
  'status_points_mismatch',
  jsonb_set(payload, '{reviews,0,points_awarded}', '0.5'::jsonb)
from phase_9c_payloads
where name = 'validation';

insert into phase_9c_payloads (name, payload)
select
  'invalid_review',
  jsonb_set(payload, '{reviews,0,unexpected}', 'true'::jsonb, true)
from phase_9c_payloads
where name = 'validation';

insert into phase_9c_payloads (name, payload)
select
  'missing_review',
  jsonb_set(
    payload,
    '{reviews}',
    jsonb_build_array(payload #> '{reviews,0}')
  )
from phase_9c_payloads
where name = 'validation';

insert into phase_9c_payloads (name, payload)
select
  'duplicate_review',
  jsonb_set(
    payload,
    '{reviews}',
    jsonb_build_array(payload #> '{reviews,0}', payload #> '{reviews,0}')
  )
from phase_9c_payloads
where name = 'validation';

insert into phase_9c_payloads (name, payload)
select
  'extra_question_id',
  jsonb_set(
    payload,
    '{reviews,0,question_id}',
    to_jsonb('c9111111-1111-4111-8111-111111111111'::text)
  )
from phase_9c_payloads
where name = 'validation';

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'worksheet_answer_evaluation',
    'c9411111-1111-4111-8111-111111111111',
    1,
    'phase9c:validation:1',
    'c9022222-2222-4222-8222-222222222222',
    0
  )
)
update phase_9c_state state
set validation_job_id = enqueued.job_id,
    validation_message_id = enqueued.queue_message_id
from enqueued
where state.singleton;

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'worksheet_answer_evaluation',
    'c9511111-1111-4111-8111-111111111111',
    1,
    'phase9c:max:1',
    'c9022222-2222-4222-8222-222222222222',
    0
  )
)
update phase_9c_state state
set max_job_id = enqueued.job_id,
    max_message_id = enqueued.queue_message_id
from enqueued
where state.singleton;

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'worksheet_answer_evaluation',
    'c9611111-1111-4111-8111-111111111111',
    1,
    'phase9c:success:1',
    'c9022222-2222-4222-8222-222222222222',
    0
  )
)
update phase_9c_state state
set success_job_id = enqueued.job_id,
    success_message_id = enqueued.queue_message_id
from enqueued
where state.singleton;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from pg_temp.claim_phase_9c_fixture_job(
    (select validation_job_id from pg_temp.phase_9c_state),
    (select validation_message_id from pg_temp.phase_9c_state),
    'c9711111-1111-4111-8111-111111111111',
    180
  )
)
update pg_temp.phase_9c_state state
set validation_job_id = claimed.job_id,
    validation_message_id = claimed.queue_message_id
from claimed
where state.singleton
  and claimed.entity_id = 'c9411111-1111-4111-8111-111111111111';

with claimed as (
  select *
  from pg_temp.claim_phase_9c_fixture_job(
    (select max_job_id from pg_temp.phase_9c_state),
    (select max_message_id from pg_temp.phase_9c_state),
    'c9722222-2222-4222-8222-222222222222',
    180
  )
)
update pg_temp.phase_9c_state state
set max_job_id = claimed.job_id,
    max_message_id = claimed.queue_message_id
from claimed
where state.singleton
  and claimed.entity_id = 'c9511111-1111-4111-8111-111111111111';

with claimed as (
  select *
  from pg_temp.claim_phase_9c_fixture_job(
    (select success_job_id from pg_temp.phase_9c_state),
    (select success_message_id from pg_temp.phase_9c_state),
    'c9733333-3333-4333-8333-333333333333',
    180
  )
)
update pg_temp.phase_9c_state state
set success_job_id = claimed.job_id,
    success_message_id = claimed.queue_message_id
from claimed
where state.singleton
  and claimed.entity_id = 'c9611111-1111-4111-8111-111111111111';

-- Lease, entity-version, and active-membership guards all run before payload
-- persistence and leave the claimed validation job reusable.
select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select validation_job_id from pg_temp.phase_9c_state),
      (select validation_message_id from pg_temp.phase_9c_state),
      'c9799999-9999-4999-8999-999999999999',
      (select payload from pg_temp.phase_9c_payloads where name = 'validation')
    )
  $$,
  '55000',
  'Job lease is no longer active.',
  'completion rejects the wrong worker lease'
);

select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select validation_job_id from pg_temp.phase_9c_state),
      (select validation_message_id + 1 from pg_temp.phase_9c_state),
      'c9711111-1111-4111-8111-111111111111',
      (select payload from pg_temp.phase_9c_payloads where name = 'validation')
    )
  $$,
  '55000',
  'Job lease is no longer active.',
  'completion rejects the wrong queue delivery lease'
);

reset role;
update public.practice_test_attempts
set evaluation_version = 2
where id = 'c9411111-1111-4111-8111-111111111111';
set local role service_role;
select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select validation_job_id from pg_temp.phase_9c_state),
      (select validation_message_id from pg_temp.phase_9c_state),
      'c9711111-1111-4111-8111-111111111111',
      (select payload from pg_temp.phase_9c_payloads where name = 'validation')
    )
  $$,
  '55000',
  'Job lease is no longer active.',
  'completion rejects a superseded attempt version'
);
reset role;
update public.practice_test_attempts
set evaluation_version = 1
where id = 'c9411111-1111-4111-8111-111111111111';

delete from public.workspace_members
where workspace_id = 'c9033333-3333-4333-8333-333333333333'
  and user_id = 'c9022222-2222-4222-8222-222222222222';
set local role service_role;
select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select validation_job_id from pg_temp.phase_9c_state),
      (select validation_message_id from pg_temp.phase_9c_state),
      'c9711111-1111-4111-8111-111111111111',
      (select payload from pg_temp.phase_9c_payloads where name = 'validation')
    )
  $$,
  '55000',
  'Practice attempt is not active.',
  'completion rejects an offboarded student membership'
);
reset role;
insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c9033333-3333-4333-8333-333333333333',
  'c9022222-2222-4222-8222-222222222222',
  'student'
);

-- Review payload validation: fixed status/point mapping, exact object shape,
-- all-and-only flexible IDs, uniqueness, and the maximum of three.
set local role service_role;
select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select validation_job_id from pg_temp.phase_9c_state),
      (select validation_message_id from pg_temp.phase_9c_state),
      'c9711111-1111-4111-8111-111111111111',
      (select payload from pg_temp.phase_9c_payloads where name = 'status_points_mismatch')
    )
  $$,
  '22023',
  'Worksheet answer review is invalid.',
  'completion enforces the fixed review-status and points mapping'
);

select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select validation_job_id from pg_temp.phase_9c_state),
      (select validation_message_id from pg_temp.phase_9c_state),
      'c9711111-1111-4111-8111-111111111111',
      (select payload from pg_temp.phase_9c_payloads where name = 'invalid_review')
    )
  $$,
  '22023',
  'Worksheet answer review is invalid.',
  'completion rejects a review with an invalid object shape'
);

select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select validation_job_id from pg_temp.phase_9c_state),
      (select validation_message_id from pg_temp.phase_9c_state),
      'c9711111-1111-4111-8111-111111111111',
      (select payload from pg_temp.phase_9c_payloads where name = 'missing_review')
    )
  $$,
  '22023',
  'Worksheet answer completion mode is invalid.',
  'completion rejects a missing flexible-question review'
);

select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select validation_job_id from pg_temp.phase_9c_state),
      (select validation_message_id from pg_temp.phase_9c_state),
      'c9711111-1111-4111-8111-111111111111',
      (select payload from pg_temp.phase_9c_payloads where name = 'duplicate_review')
    )
  $$,
  '22023',
  'Worksheet answer reviews contain duplicates.',
  'completion rejects duplicate flexible-question reviews'
);

select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select validation_job_id from pg_temp.phase_9c_state),
      (select validation_message_id from pg_temp.phase_9c_state),
      'c9711111-1111-4111-8111-111111111111',
      (select payload from pg_temp.phase_9c_payloads where name = 'extra_question_id')
    )
  $$,
  '22023',
  'Worksheet answer reviews do not match the worksheet.',
  'completion rejects an extra objective ID and requires every flexible ID'
);

select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select max_job_id from pg_temp.phase_9c_state),
      (select max_message_id from pg_temp.phase_9c_state),
      'c9722222-2222-4222-8222-222222222222',
      '{}'::jsonb
    )
  $$,
  '22023',
  'Flexible question limit exceeded.',
  'completion refuses worksheets containing more than three flexible questions'
);
reset role;

-- Seed a pre-existing semantic review, then fail only when the finalizer tries
-- to move the attempt from evaluating to completed. pgTAP catches the error in
-- a subtransaction, so the completion statement must restore the deleted row,
-- discard the newly inserted rows, and retain the live lease/message.
insert into public.practice_attempt_question_reviews (
  attempt_id,
  assignment_id,
  workspace_id,
  student_id,
  question_id,
  review_status,
  points_awarded,
  max_points,
  evaluator_source,
  feedback_text,
  corrected_answer,
  model_answer,
  short_reason
)
values (
  'c9411111-1111-4111-8111-111111111111',
  'c9400000-0000-4000-8000-000000000000',
  'c9033333-3333-4333-8333-333333333333',
  'c9022222-2222-4222-8222-222222222222',
  'c9122222-2222-4222-8222-222222222222',
  'incorrect',
  0,
  1,
  'manual',
  'Phase 9C sentinel review.',
  null,
  'Sentinel model answer.',
  'This row must survive the forced failure.'
);

set local role service_role;
select throws_ok(
  $test$
    do $body$
    begin
      perform *
      from pg_temp.complete_phase_9c_fixture_answer(
        (select validation_job_id from pg_temp.phase_9c_state),
        (select validation_message_id from pg_temp.phase_9c_state),
        'c9711111-1111-4111-8111-111111111111',
        (select payload from pg_temp.phase_9c_payloads where name = 'validation')
      );

      raise exception using
        errcode = 'P0001',
        message = 'phase 9c forced finalization failure';
    end;
    $body$
  $test$,
  'P0001',
  'phase 9c forced finalization failure',
  'a post-finalization error aborts the whole completion transaction'
);
reset role;

select ok(
  (select count(*) = 1
   from public.practice_attempt_question_reviews
   where attempt_id = 'c9411111-1111-4111-8111-111111111111')
    and exists (
      select 1
      from public.practice_attempt_question_reviews
      where attempt_id = 'c9411111-1111-4111-8111-111111111111'
        and question_id = 'c9122222-2222-4222-8222-222222222222'
        and review_status = 'incorrect'
        and feedback_text = 'Phase 9C sentinel review.'
    )
    and not exists (
      select 1
      from public.practice_attempt_question_reviews
      where attempt_id = 'c9411111-1111-4111-8111-111111111111'
        and question_id = 'c9133333-3333-4333-8333-333333333333'
    ),
  'forced transactional failure restores old reviews and removes new reviews'
);
select ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    join public.student_practice_assignments assignment
      on assignment.id = attempt.assignment_id
    where attempt.id = 'c9411111-1111-4111-8111-111111111111'
      and attempt.evaluation_status = 'evaluating'
      and attempt.status = 'submitted'
      and attempt.evaluation_model is null
      and assignment.status = 'completed'
  ),
  'forced transactional failure rolls back attempt and assignment finalization'
);
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    where job.id = (select validation_job_id from phase_9c_state)
      and job.status = 'processing'
      and job.worker_id = 'c9711111-1111-4111-8111-111111111111'
      and job.queue_message_id = (
        select validation_message_id from phase_9c_state
      )
      and job.completed_at is null
  )
    and exists (
      select 1
      from pgmq.q_worksheet_answer_evaluation queue
      where queue.msg_id = (
        select validation_message_id from phase_9c_state
      )
    )
    and not exists (
      select 1
      from pgmq.a_worksheet_answer_evaluation archive
      where archive.msg_id = (
        select validation_message_id from phase_9c_state
      )
    ),
  'forced transactional failure retains the active job lease and live message'
);

-- Expire only the successful answer fixture's first lease and delivery. The
-- exact fixture claimer then mirrors the production stale-lease transition
-- without reading or mutating any unrelated shared-staging queue row.
update app_private.async_jobs job
set lease_expires_at = now() - interval '1 second'
where job.id = (select success_job_id from phase_9c_state)
  and job.status = 'processing'
  and job.worker_id = 'c9733333-3333-4333-8333-333333333333';
update pgmq.q_worksheet_answer_evaluation queue
set vt = clock_timestamp() - interval '1 second'
where queue.msg_id = (select success_message_id from phase_9c_state)
  and queue.message ->> 'job_id' = (
    select success_job_id::text from phase_9c_state
  );

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
with reclaimed as (
  select *
  from pg_temp.claim_phase_9c_fixture_job(
    (select success_job_id from pg_temp.phase_9c_state),
    (select success_message_id from pg_temp.phase_9c_state),
    'c9744444-4444-4444-8444-444444444444',
    180
  )
)
update pg_temp.phase_9c_state state
set success_reclaimed_attempt = reclaimed.attempt_number
from reclaimed
where state.singleton;
reset role;

select ok(
  (select success_reclaimed_attempt = 2 from phase_9c_state)
    and exists (
      select 1
      from app_private.async_jobs job
      join public.practice_test_attempts attempt
        on attempt.id = job.entity_id
      join pgmq.q_worksheet_answer_evaluation queue
        on queue.msg_id = job.queue_message_id
      where job.id = (select success_job_id from phase_9c_state)
        and job.entity_id = 'c9611111-1111-4111-8111-111111111111'
        and job.status = 'processing'
        and job.attempt_count = 2
        and job.worker_id = 'c9744444-4444-4444-8444-444444444444'
        and job.lease_expires_at > now()
        and attempt.evaluation_status = 'evaluating'
        and attempt.status = 'submitted'
        and queue.message ->> 'job_id' = job.id::text
    ),
  'an expired answer-evaluation lease is reclaimed exactly as attempt two'
);

set local role service_role;
select throws_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select success_job_id from pg_temp.phase_9c_state),
      (select success_message_id from pg_temp.phase_9c_state),
      'c9733333-3333-4333-8333-333333333333',
      (select payload from pg_temp.phase_9c_payloads where name = 'success')
    )
  $$,
  '55000',
  'Job lease is no longer active.',
  'the expired answer worker cannot race the reclaimed lease to completion'
);
reset role;

-- Successful completion must insert exactly the flexible reviews, finalize the
-- local-plus-semantic score, terminalize the job, and archive the delivery.
set local role service_role;
select lives_ok(
  $$
    with completed as (
      select *
      from pg_temp.complete_phase_9c_fixture_answer(
        (select success_job_id from pg_temp.phase_9c_state),
        (select success_message_id from pg_temp.phase_9c_state),
        'c9744444-4444-4444-8444-444444444444',
        (select payload from pg_temp.phase_9c_payloads where name = 'success')
      )
    )
    update pg_temp.phase_9c_state state
    set response_attempt_id = completed.attempt_id,
        response_assignment_id = completed.assignment_id,
        response_evaluation_status = completed.evaluation_status,
        response_attempt_status = completed.attempt_status,
        response_assignment_status = completed.assignment_status,
        response_score_points = completed.score_points,
        response_max_score_points = completed.max_score_points,
        response_score_percent = completed.score_percent,
        response_passed = completed.passed
    from completed
    where state.singleton
  $$,
  'valid reviews, finalization, job completion, and archive commit atomically'
);
reset role;

select ok(
  exists (
    select 1
    from phase_9c_state state
    where state.response_attempt_id = 'c9611111-1111-4111-8111-111111111111'
      and state.response_assignment_id = 'c9600000-0000-4000-8000-000000000000'
      and state.response_evaluation_status = 'completed'
      and state.response_attempt_status = 'checked'
      and state.response_assignment_status = 'passed'
      and state.response_score_points = 3.5
      and state.response_max_score_points = 4
      and state.response_score_percent = 87.5
      and state.response_passed
  ),
  'completion returns the finalized score and terminal states'
);
select ok(
  (select count(*) = 3
   from public.practice_attempt_question_reviews
   where attempt_id = 'c9611111-1111-4111-8111-111111111111')
    and exists (
      select 1
      from public.practice_attempt_question_reviews
      where attempt_id = 'c9611111-1111-4111-8111-111111111111'
        and question_id = 'c9322222-2222-4222-8222-222222222222'
        and review_status = 'correct'
        and points_awarded = 1
        and max_points = 1
        and evaluator_source = 'deepseek'
    )
    and exists (
      select 1
      from public.practice_attempt_question_reviews
      where attempt_id = 'c9611111-1111-4111-8111-111111111111'
        and question_id = 'c9344444-4444-4444-8444-444444444444'
        and review_status = 'correct'
        and points_awarded = 1
        and max_points = 1
        and evaluator_source = 'deepseek'
    )
    and exists (
      select 1
      from public.practice_attempt_question_reviews
      where attempt_id = 'c9611111-1111-4111-8111-111111111111'
        and question_id = 'c9333333-3333-4333-8333-333333333333'
        and review_status = 'partially_correct'
        and points_awarded = 0.5
        and max_points = 1
        and evaluator_source = 'deepseek'
    )
    and not exists (
      select 1
      from public.practice_attempt_question_reviews
      where attempt_id = 'c9611111-1111-4111-8111-111111111111'
        and question_id = 'c9311111-1111-4111-8111-111111111111'
    ),
  'completion accepts and stores exactly the maximum three flexible reviews'
);
select ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    where attempt.id = 'c9611111-1111-4111-8111-111111111111'
      and attempt.evaluation_status = 'completed'
      and attempt.status = 'checked'
      and attempt.evaluation_model = 'deepseek-v4-flash'
      and attempt.score = 3
      and attempt.max_score = 4
      and attempt.score_points = 3.5
      and attempt.max_score_points = 4
      and attempt.score_percent = 87.5
      and attempt.passed
  ),
  'finalization persists objective plus semantic scoring on the attempt'
);
select ok(
  exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.id = 'c9600000-0000-4000-8000-000000000000'
      and assignment.status = 'passed'
      and assignment.latest_attempt_id = 'c9611111-1111-4111-8111-111111111111'
  )
    and exists (
      select 1
      from public.student_grammar_stats stat
      where stat.workspace_id = 'c9033333-3333-4333-8333-333333333333'
        and stat.student_id = 'c9022222-2222-4222-8222-222222222222'
        and stat.grammar_topic_id = 'c9044444-4444-4444-8444-444444444444'
        and stat.weakness_level = 'improving'
        and not stat.practice_unlocked
    ),
  'finalization transitions the assignment and adaptive grammar state'
);
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    where job.id = (select success_job_id from phase_9c_state)
      and job.status = 'succeeded'
      and job.completed_at is not null
      and job.dead_at is null
      and job.worker_id is null
      and job.lease_expires_at is null
  ),
  'successful completion terminalizes and clears the durable job lease'
);
select ok(
  not exists (
    select 1
    from pgmq.q_worksheet_answer_evaluation queue
    where queue.msg_id = (select success_message_id from phase_9c_state)
  )
    and (select count(*) = 1
      from pgmq.a_worksheet_answer_evaluation archive
      where archive.msg_id = (select success_message_id from phase_9c_state)
    ),
  'successful completion archives the queue message exactly once'
);

update phase_9c_state state
set success_review_snapshot = (
  select jsonb_agg(
    jsonb_build_object(
      'question_id', review.question_id,
      'review_status', review.review_status,
      'points_awarded', review.points_awarded,
      'max_points', review.max_points,
      'feedback_text', review.feedback_text
    ) order by review.question_id
  )
  from public.practice_attempt_question_reviews review
  where review.attempt_id = 'c9611111-1111-4111-8111-111111111111'
)
where state.singleton;

-- A worker may safely redeliver after losing the first response. The succeeded
-- branch intentionally ignores a stale lease and malformed replacement body.
set local role service_role;
select lives_ok(
  $$
    select *
    from pg_temp.complete_phase_9c_fixture_answer(
      (select success_job_id from pg_temp.phase_9c_state),
      -1::bigint,
      'c9799999-9999-4999-8999-999999999999',
      '{}'::jsonb
    )
  $$,
  'idempotent redelivery returns the existing terminal result'
);
reset role;

select ok(
  (select success_review_snapshot from phase_9c_state) = (
    select jsonb_agg(
      jsonb_build_object(
        'question_id', review.question_id,
        'review_status', review.review_status,
        'points_awarded', review.points_awarded,
        'max_points', review.max_points,
        'feedback_text', review.feedback_text
      ) order by review.question_id
    )
    from public.practice_attempt_question_reviews review
    where review.attempt_id = 'c9611111-1111-4111-8111-111111111111'
  )
    and (select count(*) = 3
         from public.practice_attempt_question_reviews
         where attempt_id = 'c9611111-1111-4111-8111-111111111111')
    and exists (
      select 1
      from app_private.async_jobs job
      where job.id = (select success_job_id from phase_9c_state)
        and job.status = 'succeeded'
        and job.attempt_count = 2
    ),
  'reclaimed completion redelivery preserves exactly one terminal result'
);

-- -------------------------------------------------------------------------
-- Teacher retry and completed-assignment offboarding regressions
-- -------------------------------------------------------------------------

select ok(
  to_regprocedure('public.retry_practice_attempt_evaluation(uuid)') is not null
    and to_regprocedure('api.retry_practice_attempt_evaluation(uuid)') is not null
    and has_function_privilege(
      'authenticated',
      'public.retry_practice_attempt_evaluation(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.retry_practice_attempt_evaluation(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.retry_practice_attempt_evaluation(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.retry_practice_attempt_evaluation(uuid)',
      'EXECUTE'
    ),
  'public and API retry entrypoints are authenticated-only'
);

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
    'ca011111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase9c-outsider@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9C Outsider"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ca022222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase9c-offboard@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9C Offboard Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c9033333-3333-4333-8333-333333333333',
  'ca022222-2222-4222-8222-222222222222',
  'student'
);

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  source,
  status,
  assigned_by,
  generation_status,
  completed_at
)
values
  (
    'ca500000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9022222-2222-4222-8222-222222222222',
    'c9044444-4444-4444-8444-444444444444',
    'c9100000-0000-4000-8000-000000000000',
    'manual',
    'completed',
    'c9011111-1111-4111-8111-111111111111',
    'ready',
    now()
  ),
  (
    'ca600000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9022222-2222-4222-8222-222222222222',
    'c9044444-4444-4444-8444-444444444444',
    'c9100000-0000-4000-8000-000000000000',
    'manual',
    'passed',
    'c9011111-1111-4111-8111-111111111111',
    'ready',
    now()
  ),
  (
    'ca700000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'ca022222-2222-4222-8222-222222222222',
    'c9044444-4444-4444-8444-444444444444',
    'c9100000-0000-4000-8000-000000000000',
    'manual',
    'completed',
    'c9011111-1111-4111-8111-111111111111',
    'ready',
    now()
  ),
  (
    'ca800000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'ca022222-2222-4222-8222-222222222222',
    'c9044444-4444-4444-8444-444444444444',
    'c9100000-0000-4000-8000-000000000000',
    'manual',
    'completed',
    'c9011111-1111-4111-8111-111111111111',
    'ready',
    now()
  );

with attempt_fixture (
  id,
  assignment_id,
  student_id,
  evaluation_status,
  attempt_status,
  score,
  max_score,
  score_points,
  max_score_points,
  score_percent,
  passed,
  evaluation_error,
  evaluation_model,
  evaluation_finished
) as (
  values
    (
      'ca511111-1111-4111-8111-111111111111'::uuid,
      'ca500000-0000-4000-8000-000000000000'::uuid,
      'c9022222-2222-4222-8222-222222222222'::uuid,
      'failed'::text,
      'submitted'::text,
      1,
      1,
      1::numeric,
      1::numeric,
      100::numeric,
      null::boolean,
      'provider_failed'::text,
      'old-provider-model'::text,
      true
    ),
    (
      'ca611111-1111-4111-8111-111111111111',
      'ca600000-0000-4000-8000-000000000000',
      'c9022222-2222-4222-8222-222222222222',
      'completed',
      'checked',
      3,
      3,
      3,
      3,
      100,
      true,
      null,
      'deepseek-v4-flash',
      true
    ),
    (
      'ca711111-1111-4111-8111-111111111111',
      'ca700000-0000-4000-8000-000000000000',
      'ca022222-2222-4222-8222-222222222222',
      'queued',
      'submitted',
      1,
      1,
      1,
      1,
      100,
      null,
      null,
      null,
      false
    ),
    (
      'ca811111-1111-4111-8111-111111111111',
      'ca800000-0000-4000-8000-000000000000',
      'ca022222-2222-4222-8222-222222222222',
      'queued',
      'submitted',
      1,
      1,
      1,
      1,
      100,
      null,
      null,
      null,
      false
    )
)
insert into public.practice_test_attempts (
  id,
  practice_test_id,
  student_id,
  workspace_id,
  assignment_id,
  answers,
  score,
  max_score,
  score_points,
  max_score_points,
  score_percent,
  passed,
  scoring_version,
  evaluation_status,
  evaluation_version,
  evaluation_started_at,
  evaluation_completed_at,
  evaluation_error,
  evaluation_model,
  status,
  started_at,
  submitted_at,
  completed_at,
  feedback
)
select
  fixture.id,
  'c9100000-0000-4000-8000-000000000000',
  fixture.student_id,
  'c9033333-3333-4333-8333-333333333333',
  fixture.assignment_id,
  jsonb_build_array(
    jsonb_build_object(
      'question_id', 'c9111111-1111-4111-8111-111111111111',
      'answer', 'Heute lerne ich.'
    ),
    jsonb_build_object(
      'question_id', 'c9122222-2222-4222-8222-222222222222',
      'answer', 'Ich bleibe zu Hause, weil ich krank bin.'
    ),
    jsonb_build_object(
      'question_id', 'c9133333-3333-4333-8333-333333333333',
      'answer', 'Obwohl es kalt ist, gehe ich raus.'
    )
  ),
  fixture.score,
  fixture.max_score,
  fixture.score_points,
  fixture.max_score_points,
  fixture.score_percent,
  fixture.passed,
  'phase_9c_retry_offboard_fixture',
  fixture.evaluation_status,
  1,
  case when fixture.evaluation_finished then now() - interval '1 minute' else null end,
  case when fixture.evaluation_finished then now() else null end,
  fixture.evaluation_error,
  fixture.evaluation_model,
  fixture.attempt_status,
  now() - interval '2 minutes',
  now() - interval '1 minute',
  now(),
  jsonb_build_object('history_marker', fixture.id::text)
from attempt_fixture fixture;

update public.student_practice_assignments
set latest_attempt_id = case id
  when 'ca500000-0000-4000-8000-000000000000'::uuid
    then 'ca511111-1111-4111-8111-111111111111'::uuid
  when 'ca600000-0000-4000-8000-000000000000'::uuid
    then 'ca611111-1111-4111-8111-111111111111'::uuid
  when 'ca700000-0000-4000-8000-000000000000'::uuid
    then 'ca711111-1111-4111-8111-111111111111'::uuid
  when 'ca800000-0000-4000-8000-000000000000'::uuid
    then 'ca811111-1111-4111-8111-111111111111'::uuid
end
where id in (
  'ca500000-0000-4000-8000-000000000000',
  'ca600000-0000-4000-8000-000000000000',
  'ca700000-0000-4000-8000-000000000000',
  'ca800000-0000-4000-8000-000000000000'
);

insert into public.practice_attempt_question_reviews (
  attempt_id,
  assignment_id,
  workspace_id,
  student_id,
  question_id,
  review_status,
  points_awarded,
  max_points,
  evaluator_source,
  feedback_text,
  corrected_answer,
  model_answer,
  short_reason
)
values (
  'ca811111-1111-4111-8111-111111111111',
  'ca800000-0000-4000-8000-000000000000',
  'c9033333-3333-4333-8333-333333333333',
  'ca022222-2222-4222-8222-222222222222',
  'c9122222-2222-4222-8222-222222222222',
  'partially_correct',
  0.5,
  1,
  'manual',
  'Phase 9C offboarding history review.',
  'Ich bleibe zu Hause, weil ich krank bin.',
  'Ich bleibe zu Hause, weil ich krank bin.',
  'This stored review must survive offboarding.'
);

create temporary table phase_9c_retry_state (
  singleton boolean primary key default true check (singleton),
  retry_job_id uuid,
  retry_evaluation_status text,
  retry_job_created boolean,
  retry_already_processing boolean,
  repeated_job_id uuid,
  repeated_evaluation_status text,
  repeated_job_created boolean,
  repeated_already_processing boolean,
  evaluating_job_id uuid,
  evaluating_message_id bigint,
  queued_job_id uuid,
  queued_message_id bigint,
  removed_batch_assignments integer,
  cancelled_join_requests integer,
  membership_removed boolean
) on commit drop;

insert into phase_9c_retry_state default values;
grant select, update on table phase_9c_retry_state
to authenticated, service_role;

-- Claim one answer-evaluation job so offboarding is exercised against both a
-- queued delivery and a currently leased/evaluating delivery.
with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'worksheet_answer_evaluation',
    'ca811111-1111-4111-8111-111111111111',
    1,
    'phase9c:offboard:evaluating:1',
    'ca022222-2222-4222-8222-222222222222',
    0
  )
)
update phase_9c_retry_state state
set evaluating_job_id = enqueued.job_id,
    evaluating_message_id = enqueued.queue_message_id
from enqueued
where state.singleton;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
with claimed as (
  select *
  from pg_temp.claim_phase_9c_fixture_job(
    (select evaluating_job_id from pg_temp.phase_9c_retry_state),
    (select evaluating_message_id from pg_temp.phase_9c_retry_state),
    'cb811111-1111-4111-8111-111111111111',
    180
  )
)
update pg_temp.phase_9c_retry_state state
set evaluating_job_id = claimed.job_id,
    evaluating_message_id = claimed.queue_message_id
from claimed
where state.singleton
  and claimed.entity_id = 'ca811111-1111-4111-8111-111111111111';
reset role;

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'worksheet_answer_evaluation',
    'ca711111-1111-4111-8111-111111111111',
    1,
    'phase9c:offboard:queued:1',
    'ca022222-2222-4222-8222-222222222222',
    0
  )
)
update phase_9c_retry_state state
set queued_job_id = enqueued.job_id,
    queued_message_id = enqueued.queue_message_id
from enqueued
where state.singleton;

-- Students cannot retry their own provider failure; only a workspace teacher
-- or platform administrator may create the next evaluation version.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c9022222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c9022222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select throws_ok(
  $$
    select *
    from api.retry_practice_attempt_evaluation(
      'ca511111-1111-4111-8111-111111111111'
    )
  $$,
  '42501',
  'Permission denied.',
  'a student cannot retry their own failed worksheet feedback'
);
reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ca011111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'ca011111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;
select throws_ok(
  $$
    select *
    from public.retry_practice_attempt_evaluation(
      'ca511111-1111-4111-8111-111111111111'
    )
  $$,
  '42501',
  'Permission denied.',
  'an authenticated outsider cannot retry workspace feedback'
);
reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c9011111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c9011111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;
select lives_ok(
  $$
    with retried as (
      select *
      from api.retry_practice_attempt_evaluation(
        'ca511111-1111-4111-8111-111111111111'
      )
    )
    update pg_temp.phase_9c_retry_state state
    set retry_job_id = retried.job_id,
        retry_evaluation_status = retried.evaluation_status,
        retry_job_created = retried.job_created,
        retry_already_processing = retried.already_processing
    from retried
    where state.singleton
  $$,
  'a workspace teacher can retry failed worksheet feedback through the API'
);
reset role;

select ok(
  exists (
    select 1
    from phase_9c_retry_state state
    join public.practice_test_attempts attempt
      on attempt.id = 'ca511111-1111-4111-8111-111111111111'
    where state.retry_job_id is not null
      and state.retry_evaluation_status = 'queued'
      and state.retry_job_created
      and not state.retry_already_processing
      and attempt.evaluation_version = 2
      and attempt.evaluation_status = 'queued'
      and attempt.evaluation_started_at is null
      and attempt.evaluation_completed_at is null
      and attempt.evaluation_error is null
      and attempt.evaluation_model is null
  ),
  'teacher retry increments the failed attempt version and clears stale state'
);
select ok(
  (select count(*) = 1
   from app_private.async_jobs job
   where job.job_kind = 'worksheet_answer_evaluation'
     and job.entity_id = 'ca511111-1111-4111-8111-111111111111'
     and job.entity_version = 2
     and job.status = 'queued'
     and job.requested_by = 'c9011111-1111-4111-8111-111111111111')
    and exists (
      select 1
      from app_private.async_jobs job
      join pgmq.q_worksheet_answer_evaluation queue
        on queue.msg_id = job.queue_message_id
      where job.id = (select retry_job_id from phase_9c_retry_state)
        and queue.message ->> 'job_id' = job.id::text
        and queue.message ->> 'entity_id' = job.entity_id::text
        and queue.message ->> 'entity_version' = '2'
    ),
  'teacher retry enqueues exactly one identifier-only version-two job'
);

-- Repeating the request while that job is active exercises the same branch
-- used after a concurrent teacher retry wins the row lock.
set local role authenticated;
select lives_ok(
  $$
    with retried as (
      select *
      from public.retry_practice_attempt_evaluation(
        'ca511111-1111-4111-8111-111111111111'
      )
    )
    update pg_temp.phase_9c_retry_state state
    set repeated_job_id = retried.job_id,
        repeated_evaluation_status = retried.evaluation_status,
        repeated_job_created = retried.job_created,
        repeated_already_processing = retried.already_processing
    from retried
    where state.singleton
  $$,
  'an active concurrent-style retry returns without creating another job'
);
reset role;

select ok(
  exists (
    select 1
    from phase_9c_retry_state state
    where state.repeated_job_id = state.retry_job_id
      and state.repeated_evaluation_status = 'queued'
      and not state.repeated_job_created
      and state.repeated_already_processing
  ),
  'the active retry response returns the original durable job'
);
select ok(
  (select evaluation_version = 2
   from public.practice_test_attempts
   where id = 'ca511111-1111-4111-8111-111111111111')
    and (select count(*) = 1
         from app_private.async_jobs
         where job_kind = 'worksheet_answer_evaluation'
           and entity_id = 'ca511111-1111-4111-8111-111111111111'
           and status in ('queued', 'retry', 'processing'))
    and (select count(*) = 1
         from pgmq.q_worksheet_answer_evaluation queue
         join app_private.async_jobs job on job.queue_message_id = queue.msg_id
         where job.entity_id = 'ca511111-1111-4111-8111-111111111111'),
  'the active retry is idempotent for version, job row, and queue message'
);

set local role authenticated;
select throws_ok(
  $$
    select *
    from api.retry_practice_attempt_evaluation(
      'ca611111-1111-4111-8111-111111111111'
    )
  $$,
  '55000',
  'Only failed practice feedback can be retried.',
  'a nonfailed practice attempt cannot be retried'
);
reset role;

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.practice_test_attempts attempt on attempt.id = job.entity_id
    where job.id = (select queued_job_id from phase_9c_retry_state)
      and job.status = 'queued'
      and attempt.evaluation_status = 'queued'
  )
    and exists (
      select 1
      from app_private.async_jobs job
      join public.practice_test_attempts attempt on attempt.id = job.entity_id
      where job.id = (select evaluating_job_id from phase_9c_retry_state)
        and job.status = 'processing'
        and job.worker_id = 'cb811111-1111-4111-8111-111111111111'
        and attempt.evaluation_status = 'evaluating'
    ),
  'offboarding fixture contains both queued and actively evaluating feedback'
);

set local role authenticated;
select lives_ok(
  $$
    with offboarded as (
      select *
      from api.offboard_student(
        'ca022222-2222-4222-8222-222222222222',
        'c9033333-3333-4333-8333-333333333333'
      )
    )
    update pg_temp.phase_9c_retry_state state
    set removed_batch_assignments = offboarded.removed_batch_assignments,
        cancelled_join_requests = offboarded.cancelled_join_requests,
        membership_removed = offboarded.membership_removed
    from offboarded
    where state.singleton
  $$,
  'teacher offboarding terminates queued and evaluating answer jobs'
);
reset role;

select ok(
  (select count(*) = 2
   from app_private.async_jobs job
   where job.id in (
       (select queued_job_id from phase_9c_retry_state),
       (select evaluating_job_id from phase_9c_retry_state)
     )
     and job.status = 'dead'
     and job.dead_at is not null
     and job.completed_at is null
     and job.worker_id is null
     and job.lease_expires_at is null
     and job.last_error_code = 'student_offboarded')
    and (select count(*) = 2
         from pgmq.a_worksheet_answer_evaluation archive
         where archive.msg_id in (
           (select queued_message_id from phase_9c_retry_state),
           (select evaluating_message_id from phase_9c_retry_state)
         ))
    and not exists (
      select 1
      from pgmq.q_worksheet_answer_evaluation queue
      where queue.msg_id in (
        (select queued_message_id from phase_9c_retry_state),
        (select evaluating_message_id from phase_9c_retry_state)
      )
    ),
  'offboarding dead-letters and archives both answer-evaluation deliveries'
);
select ok(
  (select count(*) = 2
   from public.practice_test_attempts attempt
   where attempt.id in (
       'ca711111-1111-4111-8111-111111111111',
       'ca811111-1111-4111-8111-111111111111'
     )
     and attempt.evaluation_status = 'failed'
     and attempt.evaluation_completed_at is not null
     and attempt.evaluation_error = 'student_offboarded')
    and (select count(*) = 2
         from public.student_practice_assignments assignment
         join public.practice_test_attempts attempt
           on attempt.id = assignment.latest_attempt_id
           and attempt.assignment_id = assignment.id
         where assignment.id in (
             'ca700000-0000-4000-8000-000000000000',
             'ca800000-0000-4000-8000-000000000000'
           )
           and assignment.status = 'completed'
           and assignment.completed_at is not null),
  'offboarding fails pending feedback without cancelling completed assignments'
);
select ok(
  (select membership_removed
   from phase_9c_retry_state)
    and (select removed_batch_assignments = 0
         and cancelled_join_requests = 0
         from phase_9c_retry_state)
    and not exists (
      select 1
      from public.workspace_members member
      where member.workspace_id = 'c9033333-3333-4333-8333-333333333333'
        and member.user_id = 'ca022222-2222-4222-8222-222222222222'
    )
    and (select count(*) = 2
         from public.practice_test_attempts attempt
         where attempt.id in (
             'ca711111-1111-4111-8111-111111111111',
             'ca811111-1111-4111-8111-111111111111'
           )
           and jsonb_array_length(attempt.answers) = 3
           and attempt.feedback ->> 'history_marker' = attempt.id::text)
    and exists (
      select 1
      from public.practice_attempt_question_reviews review
      where review.attempt_id = 'ca811111-1111-4111-8111-111111111111'
        and review.question_id = 'c9122222-2222-4222-8222-222222222222'
        and review.feedback_text = 'Phase 9C offboarding history review.'
    ),
  'offboarding removes access while preserving attempts, answers, and reviews'
);

-- -------------------------------------------------------------------------
-- Semantic-routing limit and immutable worksheet revision regressions
-- -------------------------------------------------------------------------

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
    'cc100000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9044444-4444-4444-8444-444444444444',
    'A2',
    'medium',
    'Phase 9C legacy semantic worksheet',
    'Legacy local-exact labels must not enable exact scoring.',
    false,
    true,
    'workspace',
    'c9011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'cc200000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9044444-4444-4444-8444-444444444444',
    'A2',
    'medium',
    'Phase 9C semantic limit worksheet',
    'Four semantic questions must be rejected before submission mutation.',
    false,
    true,
    'workspace',
    'c9011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'cc300000-0000-4000-8000-000000000000',
    'c9033333-3333-4333-8333-333333333333',
    'c9044444-4444-4444-8444-444444444444',
    'A2',
    'easy',
    'Phase 9C unused editable worksheet',
    'An unused worksheet revision remains editable.',
    false,
    true,
    'workspace',
    'c9011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  );

-- Seed deliberately mislabeled but versioned rows to verify that flexible
-- question types cannot bypass semantic routing. New application writes cannot
-- bypass the contract trigger. Suppress triggers only in this transaction's
-- session for the exact fixture insert; never alter the shared table trigger.
set local session_replication_role = replica;

insert into public.practice_test_questions (
  id,
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
values
  (
    'cc111111-1111-4111-8111-111111111111',
    'cc100000-0000-4000-8000-000000000000',
    1,
    'multiple_choice',
    'local_exact',
    'Welche Antwort ist richtig?',
    '["Heute lerne ich.", "Heute ich lerne."]'::jsonb,
    'Heute lerne ich.',
    '["Heute lerne ich."]'::jsonb,
    null,
    1,
    'This objective answer remains locally scorable.'
  ),
  (
    'cc112222-2222-4222-8222-222222222222',
    'cc100000-0000-4000-8000-000000000000',
    2,
    'transformation',
    'local_exact',
    'Formuliere den Satz mit weil um.',
    null,
    'Ich bleibe zu Hause, weil ich krank bin.',
    '[]'::jsonb,
    '{"criteria":["Preserve the meaning and use weil with verb-final order."],"sample_answer":"Ich bleibe zu Hause, weil ich krank bin."}'::jsonb,
    1,
    'A flexible local_exact label must still route this semantically.'
  ),
  (
    'cc113333-3333-4333-8333-333333333333',
    'cc100000-0000-4000-8000-000000000000',
    3,
    'word_order',
    'local_exact',
    'Ordne die Wörter zu einem richtigen Satz.',
    null,
    'Obwohl es kalt ist, gehe ich raus.',
    '[]'::jsonb,
    '{"criteria":["Produce a valid ordering with obwohl and verb-final order."],"sample_answer":"Obwohl es kalt ist, gehe ich raus."}'::jsonb,
    1,
    'More than one valid wording or ordering requires semantic review.'
  ),
  (
    'cc211111-1111-4111-8111-111111111111',
    'cc200000-0000-4000-8000-000000000000',
    1,
    'transformation',
    'local_exact',
    'Formuliere Aufgabe eins um.',
    null,
    'Beispielantwort eins.',
    '[]'::jsonb,
    '{"criteria":["Produce a grammatically valid transformation."],"sample_answer":"Beispielantwort eins."}'::jsonb,
    1,
    'Semantic limit fixture.'
  ),
  (
    'cc212222-2222-4222-8222-222222222222',
    'cc200000-0000-4000-8000-000000000000',
    2,
    'word_order',
    'local_exact',
    'Ordne die Wörter aus Aufgabe zwei.',
    null,
    'Beispielantwort zwei.',
    '[]'::jsonb,
    '{"criteria":["Produce a grammatically valid word order."],"sample_answer":"Beispielantwort zwei."}'::jsonb,
    1,
    'Semantic limit fixture.'
  ),
  (
    'cc213333-3333-4333-8333-333333333333',
    'cc200000-0000-4000-8000-000000000000',
    3,
    'sentence_correction',
    'local_exact',
    'Korrigiere den Satz aus Aufgabe drei.',
    null,
    'Beispielantwort drei.',
    '[]'::jsonb,
    '{"criteria":["Correct the sentence without changing its meaning."],"sample_answer":"Beispielantwort drei."}'::jsonb,
    1,
    'Semantic limit fixture.'
  ),
  (
    'cc214444-4444-4444-8444-444444444444',
    'cc200000-0000-4000-8000-000000000000',
    4,
    'rewrite_sentence',
    'local_exact',
    'Schreibe den Satz aus Aufgabe vier neu.',
    null,
    'Beispielantwort vier.',
    '[]'::jsonb,
    '{"criteria":["Rewrite the sentence grammatically while preserving meaning."],"sample_answer":"Beispielantwort vier."}'::jsonb,
    1,
    'Semantic limit fixture.'
  ),
  (
    'cc311111-1111-4111-8111-111111111111',
    'cc300000-0000-4000-8000-000000000000',
    1,
    'multiple_choice',
    'local_exact',
    'Welche Antwort passt?',
    '["eins", "zwei"]'::jsonb,
    'eins',
    '["eins"]'::jsonb,
    null,
    1,
    'This unused question remains editable.'
  );

set local session_replication_role = origin;

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  source,
  status,
  assigned_by,
  generation_status
)
values (
  'cc400000-0000-4000-8000-000000000000',
  'c9033333-3333-4333-8333-333333333333',
  'c9022222-2222-4222-8222-222222222222',
  'c9044444-4444-4444-8444-444444444444',
  'cc100000-0000-4000-8000-000000000000',
  'manual',
  'unlocked',
  'c9011111-1111-4111-8111-111111111111',
  'ready'
);

create temporary table phase_9c_semantic_state (
  singleton boolean primary key default true check (singleton),
  semantic_attempt_id uuid,
  jobs_before_limit bigint,
  messages_before_limit bigint
) on commit drop;

insert into phase_9c_semantic_state default values;
grant select, update on table phase_9c_semantic_state to authenticated;

select ok(
  (select count(*) = 2
   from public.practice_test_questions question
   where question.practice_test_id = 'cc100000-0000-4000-8000-000000000000'
     and question.question_type in ('transformation', 'word_order')
     and question.evaluation_mode = 'local_exact'
     and not app_private.is_practice_question_locally_scorable(
       question.question_type,
       question.correct_answer,
       question.evaluation_mode
     ))
    and app_private.is_practice_question_locally_scorable(
      'multiple_choice',
      'Heute lerne ich.',
      'local_exact'
    ),
  'legacy transformation and word-order rows remain semantic under local_exact'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c9022222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c9022222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select lives_ok(
  $$
    with submitted as (
      select *
      from public.submit_practice_attempt(
        'cc400000-0000-4000-8000-000000000000',
        jsonb_build_array(
          jsonb_build_object(
            'question_id', 'cc111111-1111-4111-8111-111111111111',
            'answer', 'Heute lerne ich.'
          ),
          jsonb_build_object(
            'question_id', 'cc112222-2222-4222-8222-222222222222',
            'answer', 'Ich bleibe zu Hause, weil ich krank bin.'
          ),
          jsonb_build_object(
            'question_id', 'cc113333-3333-4333-8333-333333333333',
            'answer', 'Obwohl es kalt ist, gehe ich raus.'
          )
        )
      )
    )
    update pg_temp.phase_9c_semantic_state state
    set semantic_attempt_id = submitted.latest_attempt_id
    from submitted
    where state.singleton
  $$,
  'student submission routes legacy flexible task types into durable evaluation'
);
reset role;

select ok(
  (select count(*) = 1
   from app_private.async_jobs job
   where job.entity_id = (select semantic_attempt_id from phase_9c_semantic_state)
     and job.job_kind = 'worksheet_answer_evaluation')
    and exists (
    select 1
    from public.practice_test_attempts attempt
    join public.student_practice_assignments assignment
      on assignment.id = attempt.assignment_id
    join app_private.async_jobs job
      on job.entity_id = attempt.id
     and job.job_kind = 'worksheet_answer_evaluation'
     and job.entity_version = attempt.evaluation_version
    join pgmq.q_worksheet_answer_evaluation queue
      on queue.msg_id = job.queue_message_id
    where attempt.id = (select semantic_attempt_id from phase_9c_semantic_state)
      and attempt.evaluation_status = 'queued'
      and attempt.evaluation_version = 1
      and attempt.status = 'submitted'
      and attempt.max_score = 1
      and assignment.status = 'completed'
      and job.status = 'queued'
      and queue.message ->> 'entity_id' = attempt.id::text
  ),
  'legacy semantic answers create one queued versioned answer-evaluation job'
);

-- The prior assignment is now completed, so a second active assignment for
-- the same topic can be created to exercise the pre-mutation limit guard.
insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  source,
  status,
  assigned_by,
  generation_status
)
values (
  'cc500000-0000-4000-8000-000000000000',
  'c9033333-3333-4333-8333-333333333333',
  'c9022222-2222-4222-8222-222222222222',
  'c9044444-4444-4444-8444-444444444444',
  'cc200000-0000-4000-8000-000000000000',
  'manual',
  'unlocked',
  'c9011111-1111-4111-8111-111111111111',
  'ready'
);

update phase_9c_semantic_state
set jobs_before_limit = (
      select count(*)
      from app_private.async_jobs job
      join public.practice_test_attempts attempt on attempt.id = job.entity_id
      where job.job_kind = 'worksheet_answer_evaluation'
        and attempt.assignment_id = 'cc500000-0000-4000-8000-000000000000'
    ),
    messages_before_limit = (
      select count(*)
      from pgmq.q_worksheet_answer_evaluation queue
      join app_private.async_jobs job on job.queue_message_id = queue.msg_id
      join public.practice_test_attempts attempt on attempt.id = job.entity_id
      where job.job_kind = 'worksheet_answer_evaluation'
        and attempt.assignment_id = 'cc500000-0000-4000-8000-000000000000'
    )
where singleton;

set local role authenticated;
select throws_ok(
  $$
    select *
    from public.submit_practice_attempt(
      'cc500000-0000-4000-8000-000000000000',
      jsonb_build_array(
        jsonb_build_object(
          'question_id', 'cc211111-1111-4111-8111-111111111111',
          'answer', 'Antwort eins.'
        ),
        jsonb_build_object(
          'question_id', 'cc212222-2222-4222-8222-222222222222',
          'answer', 'Antwort zwei.'
        ),
        jsonb_build_object(
          'question_id', 'cc213333-3333-4333-8333-333333333333',
          'answer', 'Antwort drei.'
        ),
        jsonb_build_object(
          'question_id', 'cc214444-4444-4444-8444-444444444444',
          'answer', 'Antwort vier.'
        )
      )
    )
  $$,
  '22023',
  'Worksheet exceeds the flexible question limit.',
  'submission rejects more than three semantic questions'
);
reset role;

select ok(
  exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.id = 'cc500000-0000-4000-8000-000000000000'
      and assignment.status = 'unlocked'
      and assignment.latest_attempt_id is null
      and assignment.started_at is null
      and assignment.completed_at is null
  )
    and not exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.assignment_id = 'cc500000-0000-4000-8000-000000000000'
    )
    and (
      select count(*)
      from app_private.async_jobs job
      join public.practice_test_attempts attempt on attempt.id = job.entity_id
      where job.job_kind = 'worksheet_answer_evaluation'
        and attempt.assignment_id = 'cc500000-0000-4000-8000-000000000000'
    ) = (select jobs_before_limit from phase_9c_semantic_state)
    and (
      select count(*)
      from pgmq.q_worksheet_answer_evaluation queue
      join app_private.async_jobs job on job.queue_message_id = queue.msg_id
      join public.practice_test_attempts attempt on attempt.id = job.entity_id
      where job.job_kind = 'worksheet_answer_evaluation'
        and attempt.assignment_id = 'cc500000-0000-4000-8000-000000000000'
    ) = (select messages_before_limit from phase_9c_semantic_state),
  'semantic limit rejection leaves assignment, attempts, jobs, and queue unchanged'
);

-- Any attempt freezes its worksheet revision and question set. The unused
-- fixture below proves the trigger is conditional rather than a blanket ban.
select throws_ok(
  $$
    update public.practice_tests
    set description = 'This mutation must be rejected.'
    where id = 'c9100000-0000-4000-8000-000000000000'
  $$,
  '55000',
  'Used worksheet revisions are immutable.',
  'used worksheet metadata cannot be updated'
);
select throws_ok(
  $$
    delete from public.practice_tests
    where id = 'c9100000-0000-4000-8000-000000000000'
  $$,
  '55000',
  'Used worksheet revisions are immutable.',
  'a used worksheet revision cannot be deleted'
);
select throws_ok(
  $$
    update public.practice_test_questions
    set prompt = 'This mutation must be rejected.'
    where id = 'c9111111-1111-4111-8111-111111111111'
  $$,
  '55000',
  'Used worksheet questions are immutable.',
  'a used worksheet question cannot be updated'
);
select throws_ok(
  $$
    insert into public.practice_test_questions (
      id,
      practice_test_id,
      question_number,
      question_type,
      evaluation_mode,
      prompt,
      options,
      correct_answer,
      explanation
    ) values (
      'cc199999-9999-4999-8999-999999999999',
      'c9100000-0000-4000-8000-000000000000',
      99,
      'multiple_choice',
      'local_exact',
      'This new question must be rejected.',
      '["eins", "zwei"]'::jsonb,
      'eins',
      'Used revisions cannot gain questions.'
    )
  $$,
  '55000',
  'Used worksheet questions are immutable.',
  'a question cannot be inserted into a used worksheet'
);
select throws_ok(
  $$
    delete from public.practice_test_questions
    where id = 'c9111111-1111-4111-8111-111111111111'
  $$,
  '55000',
  'Used worksheet questions are immutable.',
  'a question cannot be deleted from a used worksheet'
);
select lives_ok(
  $$
    with edited_test as (
      update public.practice_tests
      set description = 'Unused revision metadata remains editable.'
      where id = 'cc300000-0000-4000-8000-000000000000'
      returning id
    )
    update public.practice_test_questions question
    set prompt = 'Welche bearbeitete Antwort passt?'
    from edited_test
    where question.practice_test_id = edited_test.id
  $$,
  'an unused worksheet and its question remain editable'
);

select * from finish(true);
rollback;
