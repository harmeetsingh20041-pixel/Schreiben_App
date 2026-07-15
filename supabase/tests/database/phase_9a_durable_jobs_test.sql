begin;

select plan(75);

-- Catalog and privilege contract.
select ok(
  exists (select 1 from pg_extension where extname = 'pgmq'),
  'pgmq is installed for durable background work'
);
select has_table(
  'app_private',
  'async_jobs',
  'the durable job registry lives in the private schema'
);
select has_table(
  'app_private',
  'feedback_drafts',
  'unreleased feedback lives in the private schema'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.async_jobs'::regclass),
  'async jobs have RLS defense in depth'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.feedback_drafts'::regclass),
  'feedback drafts have RLS defense in depth'
);
select ok(
  to_regclass('pgmq.q_writing_evaluation') is not null
    and to_regclass('pgmq.a_writing_evaluation') is not null,
  'the writing evaluation queue and archive exist'
);
select ok(
  to_regclass('pgmq.q_worksheet_generation') is not null
    and to_regclass('pgmq.a_worksheet_generation') is not null,
  'the worksheet generation queue and archive exist'
);
select ok(
  to_regclass('pgmq.q_worksheet_answer_evaluation') is not null
    and to_regclass('pgmq.a_worksheet_answer_evaluation') is not null,
  'the worksheet answer evaluation queue and archive exist'
);
select ok(
  not has_schema_privilege('anon', 'pgmq', 'USAGE')
    and not has_schema_privilege('authenticated', 'pgmq', 'USAGE')
    and not has_schema_privilege('service_role', 'pgmq', 'USAGE'),
  'queue internals are unavailable to every Data API role'
);
select ok(
  not has_table_privilege('anon', 'app_private.async_jobs', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.async_jobs', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.async_jobs', 'SELECT'),
  'the private job registry has no direct Data API reader'
);
select ok(
  to_regprocedure('public.claim_async_jobs(text,uuid,integer,integer)') is not null
    and to_regprocedure('public.fail_async_job(uuid,bigint,uuid,text,boolean)') is not null
    and to_regprocedure('public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)') is not null
    and to_regprocedure('public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)') is not null,
  'the worker lifecycle routines have stable signatures'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_async_jobs(text,uuid,integer,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.fail_async_job(uuid,bigint,uuid,text,boolean)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.complete_writing_evaluation_legacy_internal(uuid,bigint,uuid,jsonb)',
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
    ),
  'legacy writing and worksheet engines are sealed behind their gated API facades'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_async_jobs(text,uuid,integer,integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.fail_async_job(uuid,bigint,uuid,text,boolean)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.claim_async_jobs(text,uuid,integer,integer)',
      'EXECUTE'
    ),
  'students and anonymous callers cannot run workers'
);

-- Preserve shared staging exactly. Every fixture uses a dedicated tenant and
-- transaction-unique negative queue IDs so claims cannot consume unrelated
-- work. The final transaction rollback removes all temporary changes.

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
    '91111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase9a-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9A Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '92222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase9a-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9A Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '92222222-2222-4222-8222-222222222223',
    'authenticated',
    'authenticated',
    'phase9a-scheduled-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9A Scheduled Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  '93333333-3333-4333-8333-333333333333',
  'Phase 9A Workspace',
  'phase-9a-workspace',
  '91111111-1111-4111-8111-111111111111'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '91111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '91111111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    '93333333-3333-4333-8333-333333333333',
    '91111111-1111-4111-8111-111111111111',
    'owner'
  ),
  (
    '93333333-3333-4333-8333-333333333333',
    '92222222-2222-4222-8222-222222222222',
    'student'
  ),
  (
    '93333333-3333-4333-8333-333333333333',
    '92222222-2222-4222-8222-222222222223',
    'student'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  is_active,
  join_code_enabled,
  join_requires_approval,
  feedback_mode,
  feedback_delay_min_minutes,
  feedback_delay_max_minutes
)
values
  (
    '94444444-4444-4444-8444-444444444444',
    '93333333-3333-4333-8333-333333333333',
    'Immediate',
    'A1',
    '91111111-1111-4111-8111-111111111111',
    true,
    true,
    true,
    'immediate',
    0,
    0
  ),
  (
    '95555555-5555-4555-8555-555555555555',
    '93333333-3333-4333-8333-333333333333',
    'Teacher review',
    'A1',
    '91111111-1111-4111-8111-111111111111',
    true,
    true,
    true,
    'teacher_review_only',
    0,
    0
  ),
  (
    '96666666-6666-4666-8666-666666666666',
    '93333333-3333-4333-8333-333333333333',
    'Scheduled due now',
    'A1',
    '91111111-1111-4111-8111-111111111111',
    true,
    true,
    true,
    'automatic_delayed',
    0,
    0
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    '93333333-3333-4333-8333-333333333333',
    '94444444-4444-4444-8444-444444444444',
    '92222222-2222-4222-8222-222222222222'
  ),
  (
    '93333333-3333-4333-8333-333333333333',
    '95555555-5555-4555-8555-555555555555',
    '92222222-2222-4222-8222-222222222222'
  ),
  (
    '93333333-3333-4333-8333-333333333333',
    '96666666-6666-4666-8666-666666666666',
    '92222222-2222-4222-8222-222222222223'
  );

-- The first fixture student creates exactly the launch allowance of three
-- writings. The scheduled case uses a second fixture student, so this test
-- never mutates singleton production quota policy rows.

create temporary table phase_9a_state (
  singleton boolean primary key default true check (singleton),
  response_evaluation_status text,
  response_release_status text,
  response_release_at timestamptz,
  retry_submission_id uuid,
  retry_job_id uuid,
  retry_message_id bigint,
  retry_attempt integer,
  duplicate_first_job_id uuid,
  duplicate_first_message_id bigint,
  duplicate_first_created boolean,
  duplicate_second_job_id uuid,
  duplicate_second_message_id bigint,
  duplicate_second_created boolean,
  stale_submission_id uuid,
  stale_job_id uuid,
  stale_message_id bigint,
  stale_attempt integer,
  held_submission_id uuid,
  held_job_id uuid,
  held_message_id bigint,
  scheduled_submission_id uuid,
  scheduled_job_id uuid,
  scheduled_message_id bigint,
  worksheet_reuse_assignment_id uuid,
  worksheet_reuse_job_id uuid,
  worksheet_reuse_message_id bigint,
  worksheet_reuse_response_status text,
  worksheet_generated_assignment_id uuid,
  worksheet_generated_job_id uuid,
  worksheet_generated_message_id bigint,
  worksheet_generated_test_id uuid,
  worksheet_generated_response_status text,
  worksheet_generated_response_job_id uuid
) on commit drop;

insert into phase_9a_state default values;
grant select, update on table phase_9a_state to authenticated, service_role;

create function pg_temp.phase_9a_fixture_message_id(slot integer)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$
  select -9000000000000000000::bigint
    + ((txid_current() % 1000000000)::bigint * 1000)
    + slot::bigint;
$$;

revoke all on function pg_temp.phase_9a_fixture_message_id(integer)
from public;

create function pg_temp.phase_9a_rekey_fixture_message(
  target_job_id uuid,
  target_message_id bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  updated_count integer;
begin
  if target_message_id >= 0 then
    raise exception 'Fixture queue IDs must be negative.';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job.id is null
    or selected_job.queue_name not in (
      'writing_evaluation',
      'worksheet_generation',
      'worksheet_answer_evaluation'
    )
    or selected_job.queue_message_id is null
  then
    raise exception 'Fixture job is not queue-backed.';
  end if;

  execute pg_catalog.format(
    'with removed as (
       delete from pgmq.%1$I
       where msg_id = $2
         and message ->> ''job_id'' = $3
         and message ->> ''job_kind'' = $4
         and message ->> ''entity_id'' = $5
         and message ->> ''entity_version'' = $6
       returning read_ct, enqueued_at, vt, message, headers
     )
     insert into pgmq.%1$I (
       msg_id, read_ct, enqueued_at, vt, message, headers
     ) overriding system value
     select $1, read_ct, enqueued_at, vt, message, headers
     from removed',
    'q_' || selected_job.queue_name
  )
  using
    target_message_id,
    selected_job.queue_message_id,
    selected_job.id::text,
    selected_job.job_kind,
    selected_job.entity_id::text,
    selected_job.entity_version::text;
  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception 'Fixture queue message was not re-keyed exactly once.';
  end if;

  update app_private.async_jobs job
  set queue_message_id = target_message_id
  where job.id = selected_job.id
    and job.queue_message_id = selected_job.queue_message_id;
  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception 'Fixture job message ID was not updated exactly once.';
  end if;
end;
$$;

revoke all on function pg_temp.phase_9a_rekey_fixture_message(uuid, bigint)
from public;

create function pg_temp.phase_9a_accept_writing_feedback(
  target_submission_id uuid,
  target_feedback jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select target_feedback || jsonb_build_object(
    'evaluation_evidence', jsonb_build_object(
      'schema_version', 2,
      'decision', 'accepted_model_feedback',
      'reason_code', 'critic_approved',
      'context_sha256', context.context_sha256,
      'original_text_sha256', context.original_text_sha256,
      'final_feedback_sha256',
        app_private.canonical_jsonb_sha256(target_feedback),
      'generator_provider', 'deepseek',
      'generator_model', 'deepseek-v4-flash',
      'candidate_feedback_sha256', repeat('d', 64),
      'candidate_release_sha256',
        app_private.canonical_jsonb_sha256(target_feedback),
      'critic_provider', 'gemini',
      'critic_model', 'gemini-3.1-flash-lite',
      'critic_verdict', 'approved',
      'critic_decision_sha256', repeat('e', 64),
      'adjudicator_provider', null,
      'adjudicator_model', null,
      'adjudicator_verdict', null,
      'adjudicator_decision_sha256', null,
      'resolved_feedback_sha256', null,
      'final_critic_provider', null,
      'final_critic_model', null,
      'final_critic_verdict', null,
      'final_critic_decision_sha256', null,
      'accepted_provider', 'deepseek',
      'accepted_model', 'deepseek-v4-flash'
    )
  )
  from app_private.writing_evaluation_contexts context
  where context.submission_id = target_submission_id;
$$;

grant execute on function pg_temp.phase_9a_accept_writing_feedback(uuid, jsonb)
to service_role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $test$
    do $body$
    begin
      begin
        perform *
        from api.submit_writing(
          '94444444-4444-4444-8444-444444444444',
          'free_text',
          null,
          'PHASE9A_FORCED_ROLLBACK'
        );
        raise exception 'phase9a_forced_rollback';
      exception when raise_exception then
        if sqlerrm <> 'phase9a_forced_rollback' then
          raise;
        end if;
      end;
    end;
    $body$
  $test$,
  'a surrounding rollback can undo submission and enqueue together'
);

reset role;
select is(
  (
    select count(*)::integer
    from public.submissions submission
    where submission.workspace_id = '93333333-3333-4333-8333-333333333333'
      and submission.student_id = '92222222-2222-4222-8222-222222222222'
      and submission.batch_id = '94444444-4444-4444-8444-444444444444'
      and submission.original_text = 'PHASE9A_FORCED_ROLLBACK'
  ),
  0,
  'the forced rollback leaves no submission'
);
select is(
  (
    select count(*)::integer
    from app_private.async_jobs job
    join public.submissions submission on submission.id = job.entity_id
    where submission.workspace_id = '93333333-3333-4333-8333-333333333333'
  ),
  0,
  'the forced rollback leaves no durable job in the fixture workspace'
);
select is(
  (
    select count(*)::integer
    from pgmq.q_writing_evaluation queue
    join public.submissions submission
      on submission.id::text = queue.message ->> 'entity_id'
    where submission.workspace_id = '93333333-3333-4333-8333-333333333333'
  ),
  0,
  'the forced rollback leaves no writing queue message in the fixture workspace'
);

set local role authenticated;
select lives_ok(
  $$
    with submitted as (
      select *
      from api.submit_writing(
        '94444444-4444-4444-8444-444444444444',
        'free_text',
        null,
        'Ich lerne jeden Tag Deutsch.'
      )
    )
    update pg_temp.phase_9a_state state
    set retry_submission_id = submitted.submission_id,
        response_evaluation_status = submitted.evaluation_status,
        response_release_status = submitted.release_status,
        response_release_at = submitted.release_at
    from submitted
    where state.singleton
  $$,
  'api.submit_writing acknowledges a durable writing job'
);

reset role;
update phase_9a_state state
set retry_job_id = job.id,
    retry_message_id = job.queue_message_id
from app_private.async_jobs job
where job.job_kind = 'writing_evaluation'
  and job.entity_id = state.retry_submission_id;

select pg_temp.phase_9a_rekey_fixture_message(
  (select retry_job_id from phase_9a_state),
  pg_temp.phase_9a_fixture_message_id(1)
);
update phase_9a_state
set retry_message_id = pg_temp.phase_9a_fixture_message_id(1)
where singleton;

select is(
  (select response_evaluation_status from phase_9a_state),
  'queued'::text,
  'submission acknowledgement reports queued evaluation'
);
select is(
  (select response_release_status from phase_9a_state),
  'held'::text,
  'immediate feedback stays held until a validated result completes'
);
select is(
  (select response_release_at from phase_9a_state),
  null::timestamptz,
  'immediate feedback has no future release timestamp'
);
select is(
  (
    select count(*)::integer
    from app_private.async_jobs job
    where job.entity_id = (select retry_submission_id from phase_9a_state)
      and job.job_kind = 'writing_evaluation'
      and job.entity_version = 1
      and job.status = 'queued'
  ),
  1,
  'submission creation persists exactly one versioned durable job'
);
select is(
  (
    select count(*)::integer
    from pgmq.q_writing_evaluation queue
    where queue.msg_id = (select retry_message_id from phase_9a_state)
      and queue.message ->> 'job_id' = (select retry_job_id::text from phase_9a_state)
      and queue.message ->> 'entity_id' = (select retry_submission_id::text from phase_9a_state)
  ),
  1,
  'the durable job and queue message are linked'
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
      and queue.message::text not like '%Ich lerne jeden Tag Deutsch.%'
    from pgmq.q_writing_evaluation queue
    where queue.msg_id = (select retry_message_id from phase_9a_state)
  ),
  'the queue payload contains identifiers/version only and no student writing'
);

-- The internal enqueue primitive returns the original job/message for the same
-- idempotency key and does not create a second queue message.
insert into public.grammar_topics (id, slug, name, level, description)
values (
  '97666666-6666-4666-8666-666666666666',
  'phase9a-idempotency-contract',
  'Phase 9A idempotency contract',
  'A1',
  'A real assignment context for the queue idempotency fixture.'
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
  generation_version,
  source,
  status,
  assigned_by,
  generation_status
)
values (
  '97777777-7777-4777-8777-777777777777',
  '93333333-3333-4333-8333-333333333333',
  '92222222-2222-4222-8222-222222222222',
  '97666666-6666-4666-8666-666666666666',
  '94444444-4444-4444-8444-444444444444',
  'A1',
  1,
  'teacher_verified',
  1,
  'teacher_assigned',
  'unlocked',
  '91111111-1111-4111-8111-111111111111',
  'queued'
);

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'worksheet_generation',
    '97777777-7777-4777-8777-777777777777',
    1,
    'phase9a:duplicate-contract',
    null,
    0
  )
)
update phase_9a_state state
set duplicate_first_job_id = enqueued.job_id,
    duplicate_first_message_id = enqueued.queue_message_id,
    duplicate_first_created = enqueued.created
from enqueued
where state.singleton;

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'worksheet_generation',
    '97777777-7777-4777-8777-777777777777',
    1,
    'phase9a:duplicate-contract',
    null,
    0
  )
)
update phase_9a_state state
set duplicate_second_job_id = enqueued.job_id,
    duplicate_second_message_id = enqueued.queue_message_id,
    duplicate_second_created = enqueued.created
from enqueued
where state.singleton;

select pg_temp.phase_9a_rekey_fixture_message(
  (select duplicate_first_job_id from phase_9a_state),
  pg_temp.phase_9a_fixture_message_id(40)
);
update phase_9a_state
set
  duplicate_first_message_id = pg_temp.phase_9a_fixture_message_id(40),
  duplicate_second_message_id = pg_temp.phase_9a_fixture_message_id(40)
where singleton;

select is(
  (select duplicate_first_created from phase_9a_state),
  true,
  'the first idempotent enqueue creates a job'
);
select is(
  (select duplicate_second_created from phase_9a_state),
  false,
  'a duplicate idempotency key reuses the existing job'
);
select ok(
  (
    select duplicate_first_job_id = duplicate_second_job_id
      and duplicate_first_message_id = duplicate_second_message_id
    from phase_9a_state
  ),
  'duplicate enqueue returns the same job and queue message'
);
select is(
  (
    select count(*)::integer
    from pgmq.q_worksheet_generation queue
    where queue.message ->> 'job_id' = (
      select duplicate_first_job_id::text from phase_9a_state
    )
  ),
  1,
  'duplicate enqueue leaves exactly one PGMQ message'
);

select pgmq.archive(
  'worksheet_generation',
  (select duplicate_first_message_id from phase_9a_state)
);
delete from app_private.async_jobs
where id = (select duplicate_first_job_id from phase_9a_state);

-- Worker lease/retry contract: a job may be claimed at most three times.
select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'writing_evaluation',
    '98888888-8888-4888-8888-888888888881',
    1,
    180
  )
)
update pg_temp.phase_9a_state state
set retry_job_id = claimed.job_id,
    retry_message_id = claimed.queue_message_id,
    retry_attempt = claimed.attempt_number
from claimed
where state.singleton;

select is(
  (select retry_attempt from pg_temp.phase_9a_state),
  1,
  'the first worker claim is attempt one'
);
select lives_ok(
  $$
    select *
    from public.fail_async_job(
      (select retry_job_id from pg_temp.phase_9a_state),
      (select retry_message_id from pg_temp.phase_9a_state),
      '98888888-8888-4888-8888-888888888881',
      'provider_timeout',
      true
    )
  $$,
  'the first transient failure schedules a retry'
);

reset role;
select pg_temp.phase_9a_rekey_fixture_message(
  (select retry_job_id from phase_9a_state),
  pg_temp.phase_9a_fixture_message_id(2)
);
update phase_9a_state
set retry_message_id = pg_temp.phase_9a_fixture_message_id(2)
where singleton;
update app_private.async_jobs
set available_at = now() - interval '1 second'
where id = (select retry_job_id from phase_9a_state);
update pgmq.q_writing_evaluation
set vt = now() - interval '1 second'
where msg_id = (
  select queue_message_id
  from app_private.async_jobs
  where id = (select retry_job_id from phase_9a_state)
);

set local role service_role;
with claimed as (
  select *
  from public.claim_async_jobs(
    'writing_evaluation',
    '98888888-8888-4888-8888-888888888882',
    1,
    180
  )
)
update pg_temp.phase_9a_state state
set retry_message_id = claimed.queue_message_id,
    retry_attempt = claimed.attempt_number
from claimed
where state.singleton;

select is(
  (select retry_attempt from pg_temp.phase_9a_state),
  2,
  'the retried job is claimed as attempt two'
);
select lives_ok(
  $$
    select *
    from public.fail_async_job(
      (select retry_job_id from pg_temp.phase_9a_state),
      (select retry_message_id from pg_temp.phase_9a_state),
      '98888888-8888-4888-8888-888888888882',
      'provider_timeout',
      true
    )
  $$,
  'the second transient failure schedules the final retry'
);

reset role;
select pg_temp.phase_9a_rekey_fixture_message(
  (select retry_job_id from phase_9a_state),
  pg_temp.phase_9a_fixture_message_id(3)
);
update phase_9a_state
set retry_message_id = pg_temp.phase_9a_fixture_message_id(3)
where singleton;
update app_private.async_jobs
set available_at = now() - interval '1 second'
where id = (select retry_job_id from phase_9a_state);
update pgmq.q_writing_evaluation
set vt = now() - interval '1 second'
where msg_id = (
  select queue_message_id
  from app_private.async_jobs
  where id = (select retry_job_id from phase_9a_state)
);

set local role service_role;
with claimed as (
  select *
  from public.claim_async_jobs(
    'writing_evaluation',
    '98888888-8888-4888-8888-888888888883',
    1,
    180
  )
)
update pg_temp.phase_9a_state state
set retry_message_id = claimed.queue_message_id,
    retry_attempt = claimed.attempt_number
from claimed
where state.singleton;

select is(
  (select retry_attempt from pg_temp.phase_9a_state),
  3,
  'the final worker claim is attempt three'
);
select lives_ok(
  $$
    select *
    from public.fail_async_job(
      (select retry_job_id from pg_temp.phase_9a_state),
      (select retry_message_id from pg_temp.phase_9a_state),
      '98888888-8888-4888-8888-888888888883',
      'provider_timeout',
      true
    )
  $$,
  'a third failure terminates the job instead of scheduling attempt four'
);

reset role;
select is(
  (
    select status
    from app_private.async_jobs
    where id = (select retry_job_id from phase_9a_state)
  ),
  'dead'::text,
  'three failed claims move the job to the dead-letter state'
);
select is(
  (
    select attempt_count
    from app_private.async_jobs
    where id = (select retry_job_id from phase_9a_state)
  ),
  3,
  'the durable registry records exactly three attempts'
);

select is(
  (
    select count(*)
    from app_private.async_jobs job
    where job.id = (select retry_job_id from phase_9a_state)
      and job.status in ('queued', 'retry', 'processing')
      and job.attempt_count < 3
  ),
  0::bigint,
  'the exhausted fixture is no longer eligible for a fourth claim'
);

-- A processing job with an expired lease becomes claimable by a new worker.
reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    '94444444-4444-4444-8444-444444444444',
    'free_text',
    null,
    'Eine verwaiste Lease wird sicher wiederaufgenommen.'
  )
)
update pg_temp.phase_9a_state state
set stale_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;
update phase_9a_state state
set stale_job_id = job.id,
    stale_message_id = job.queue_message_id
from app_private.async_jobs job
where job.entity_id = state.stale_submission_id
  and job.job_kind = 'writing_evaluation';

select pg_temp.phase_9a_rekey_fixture_message(
  (select stale_job_id from phase_9a_state),
  pg_temp.phase_9a_fixture_message_id(10)
);
update phase_9a_state
set stale_message_id = pg_temp.phase_9a_fixture_message_id(10)
where singleton;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'writing_evaluation',
    '99999999-9999-4999-8999-999999999991',
    1,
    180
  )
)
update pg_temp.phase_9a_state state
set stale_message_id = claimed.queue_message_id,
    stale_attempt = claimed.attempt_number
from claimed
where state.singleton;

reset role;
update app_private.async_jobs
set lease_expires_at = now() - interval '1 second'
where id = (select stale_job_id from phase_9a_state);
update pgmq.q_writing_evaluation
set vt = now() - interval '1 second'
where msg_id = (select stale_message_id from phase_9a_state);

set local role service_role;
with claimed as (
  select *
  from public.claim_async_jobs(
    'writing_evaluation',
    '99999999-9999-4999-8999-999999999992',
    1,
    180
  )
)
update pg_temp.phase_9a_state state
set stale_message_id = claimed.queue_message_id,
    stale_attempt = claimed.attempt_number
from claimed
where state.singleton;

reset role;
select is(
  (select stale_attempt from phase_9a_state),
  2,
  'an expired processing lease is reclaimed as the next attempt'
);
select is(
  (
    select worker_id
    from app_private.async_jobs
    where id = (select stale_job_id from phase_9a_state)
  ),
  '99999999-9999-4999-8999-999999999992'::uuid,
  'stale recovery transfers the lease to the new worker'
);
select ok(
  (
    select lease_expires_at > now()
    from app_private.async_jobs
    where id = (select stale_job_id from phase_9a_state)
  ),
  'the recovered job receives a fresh bounded lease'
);

-- Remove the recovered job from the active queue so the feedback lifecycle
-- cases each claim exactly the job they submitted.
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
    from public.fail_async_job(
      (select stale_job_id from pg_temp.phase_9a_state),
      (select stale_message_id from pg_temp.phase_9a_state),
      '99999999-9999-4999-8999-999999999992',
      'stale_recovery_contract_complete',
      false
    )
  $$,
  'the recovered lease can terminate cleanly'
);

-- Teacher-review feedback is completed privately and remains invisible to the
-- student until an explicit teacher release exists in a later milestone.
reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    '95555555-5555-4555-8555-555555555555',
    'free_text',
    null,
    'Ich lerne Deutsch.'
  )
)
update pg_temp.phase_9a_state state
set held_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;
update phase_9a_state state
set held_job_id = job.id,
    held_message_id = job.queue_message_id
from app_private.async_jobs job
where job.entity_id = state.held_submission_id
  and job.job_kind = 'writing_evaluation';

select pg_temp.phase_9a_rekey_fixture_message(
  (select held_job_id from phase_9a_state),
  pg_temp.phase_9a_fixture_message_id(20)
);
update phase_9a_state
set held_message_id = pg_temp.phase_9a_fixture_message_id(20)
where singleton;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'writing_evaluation',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    1,
    180
  )
)
update pg_temp.phase_9a_state state
set held_job_id = claimed.job_id,
    held_message_id = claimed.queue_message_id
from claimed
where state.singleton;

select lives_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select held_job_id from pg_temp.phase_9a_state),
      (select held_message_id from pg_temp.phase_9a_state),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      pg_temp.phase_9a_accept_writing_feedback(
        (select held_submission_id from pg_temp.phase_9a_state),
        jsonb_build_object(
        'overall_summary', 'Der Text ist klar.',
        'level_detected', 'A1',
        'corrected_text', 'Ich lerne Deutsch.',
        'ai_model', 'deepseek-v4-flash',
        'score_summary', jsonb_build_object(
          'correct_lines', 1,
          'acceptable_lines', 0,
          'minor_issues', 0,
          'major_issues', 0,
          'needs_review', 0
        ),
        'lines', jsonb_build_array(
          jsonb_build_object(
            'line_number', 1,
            'source_start', 0,
            'source_end', 18,
            'original_line', 'Ich lerne Deutsch.',
            'corrected_line', 'Ich lerne Deutsch.',
            'status', 'correct',
            'changed_parts', '[]'::jsonb,
            'short_explanation', 'Korrekt.',
            'detailed_explanation', 'Der Satz ist korrekt.',
            'grammar_topic', ''
          )
        ),
        'grammar_topics', '[]'::jsonb
        )
      )
    )
  $$,
  'a validated teacher-review result completes into a private draft'
);

reset role;
select ok(
  (
    select s.evaluation_status = 'ready'
      and s.release_status = 'held'
      and s.corrected_text is null
      and s.overall_summary is null
    from public.submissions s
    where s.id = (select held_submission_id from phase_9a_state)
  ),
  'held feedback exposes only terminal state on the submission row'
);
select is(
  (
    select state
    from app_private.feedback_drafts
    where submission_id = (select held_submission_id from phase_9a_state)
  ),
  'draft'::text,
  'teacher-review content remains in a private feedback draft'
);
select is(
  (
    select count(*)::integer
    from public.submission_lines
    where submission_id = (select held_submission_id from phase_9a_state)
  ),
  0,
  'held feedback materializes no public line fragments'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  api.get_submission_detail(
    (select held_submission_id from pg_temp.phase_9a_state)
  ) #>> '{submission,corrected_text}',
  null::text,
  'the student API cannot read held corrected text'
);
select is(
  jsonb_array_length(coalesce(
    api.get_submission_detail(
      (select held_submission_id from pg_temp.phase_9a_state)
    ) #> '{feedback,lines}',
    '[]'::jsonb
  )),
  0,
  'the student API cannot read held feedback lines'
);
select throws_ok(
  $$select * from app_private.feedback_drafts$$,
  '42501',
  'permission denied for schema app_private',
  'the student cannot bypass the API to read private feedback drafts'
);

-- Scheduled feedback is evaluated now, held privately, and materialized by one
-- atomic due-release operation. A zero-minute deterministic schedule avoids
-- sleeps and wall-clock flakes.
reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222223',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92222222-2222-4222-8222-222222222223',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    '96666666-6666-4666-8666-666666666666',
    'free_text',
    null,
    'Heute schreibe ich einen Satz.'
  )
)
update pg_temp.phase_9a_state state
set scheduled_submission_id = submitted.submission_id,
    response_release_status = submitted.release_status,
    response_release_at = submitted.release_at
from submitted
where state.singleton;

reset role;
update phase_9a_state state
set scheduled_job_id = job.id,
    scheduled_message_id = job.queue_message_id
from app_private.async_jobs job
where job.entity_id = state.scheduled_submission_id
  and job.job_kind = 'writing_evaluation';

select pg_temp.phase_9a_rekey_fixture_message(
  (select scheduled_job_id from phase_9a_state),
  pg_temp.phase_9a_fixture_message_id(30)
);
update phase_9a_state
set scheduled_message_id = pg_temp.phase_9a_fixture_message_id(30)
where singleton;

select is(
  (select response_release_status from phase_9a_state),
  'scheduled'::text,
  'scheduled submission acknowledgement reports its release state'
);
select ok(
  (select response_release_at <= now() from phase_9a_state),
  'the deterministic zero-minute schedule is already due'
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
  from public.claim_async_jobs(
    'writing_evaluation',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    1,
    180
  )
)
update pg_temp.phase_9a_state state
set scheduled_job_id = claimed.job_id,
    scheduled_message_id = claimed.queue_message_id
from claimed
where state.singleton;

select lives_ok(
  $$
    select *
    from api.complete_writing_evaluation(
      (select scheduled_job_id from pg_temp.phase_9a_state),
      (select scheduled_message_id from pg_temp.phase_9a_state),
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      pg_temp.phase_9a_accept_writing_feedback(
        (select scheduled_submission_id from pg_temp.phase_9a_state),
        jsonb_build_object(
        'overall_summary', 'Der Text ist klar.',
        'level_detected', 'A1',
        'corrected_text', 'Heute schreibe ich einen Satz.',
        'ai_model', 'deepseek-v4-flash',
        'score_summary', jsonb_build_object(
          'correct_lines', 1,
          'acceptable_lines', 0,
          'minor_issues', 0,
          'major_issues', 0,
          'needs_review', 0
        ),
        'lines', jsonb_build_array(
          jsonb_build_object(
            'line_number', 1,
            'source_start', 0,
            'source_end', 30,
            'original_line', 'Heute schreibe ich einen Satz.',
            'corrected_line', 'Heute schreibe ich einen Satz.',
            'status', 'correct',
            'changed_parts', '[]'::jsonb,
            'short_explanation', 'Korrekt.',
            'detailed_explanation', 'Der Satz ist korrekt.',
            'grammar_topic', ''
          )
        ),
        'grammar_topics', '[]'::jsonb
        )
      )
    )
  $$,
  'scheduled feedback completes privately before its release worker runs'
);

reset role;
select ok(
  (
    select s.evaluation_status = 'ready'
      and s.release_status = 'scheduled'
      and s.corrected_text is null
      and not exists (
        select 1
        from public.submission_lines sl
        where sl.submission_id = s.id
      )
    from public.submissions s
    where s.id = (select scheduled_submission_id from phase_9a_state)
  ),
  'a completed scheduled result remains private before release'
);

reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
select lives_ok(
  $$
    select app_private.materialize_feedback_draft(
      (select scheduled_submission_id from pg_temp.phase_9a_state),
      (
        select draft.id
        from app_private.feedback_drafts draft
        where draft.submission_id = (
          select scheduled_submission_id from pg_temp.phase_9a_state
        )
          and draft.state in ('draft', 'approved')
      ),
      null
    )
  $$,
  'the fixture-specific release path atomically materializes scheduled feedback'
);

select ok(
  (
    select job.status = 'succeeded'
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'released'
      and submission.status = 'checked'
      and submission.corrected_text = 'Heute schreibe ich einen Satz.'
      and draft.state = 'released'
      and draft.released_at is not null
      and (
        select count(*)
        from public.submission_lines line
        where line.submission_id = submission.id
      ) = 1
    from app_private.async_jobs job
    join public.submissions submission on submission.id = job.entity_id
    join app_private.feedback_drafts draft
      on draft.submission_id = submission.id
     and draft.version = job.entity_version
    where job.id = (select scheduled_job_id from phase_9a_state)
  ),
  'job, parent state, draft, and feedback lines reach the released state together'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222223',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92222222-2222-4222-8222-222222222223',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  api.get_submission_detail(
    (select scheduled_submission_id from pg_temp.phase_9a_state)
  ) #>> '{submission,corrected_text}',
  'Heute schreibe ich einen Satz.'::text,
  'released scheduled feedback becomes visible through the student API'
);
select is(
  jsonb_array_length(coalesce(
    api.get_submission_detail(
      (select scheduled_submission_id from pg_temp.phase_9a_state)
    ) #> '{feedback,lines}',
    '[]'::jsonb
  )),
  1,
  'released scheduled feedback lines become visible together'
);

-- Worksheet generation completion is a single transaction. Reuse accepts
-- approved content only; generated content is quarantined until independent
-- validation; a held request cannot enqueue another paid generation.
reset role;

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    '9c111111-1111-4111-8111-111111111111',
    'phase9a-articles-reuse',
    'Articles',
    'A1',
    'Definite and indefinite article forms.'
  ),
  (
    '9c222222-2222-4222-8222-222222222222',
    'phase9a-articles-generated',
    'Articles in context',
    'A1',
    'Article forms in short A1 sentences.'
  );

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
    '9e111111-1111-4111-8111-111111111111',
    '93333333-3333-4333-8333-333333333333',
    '9c111111-1111-4111-8111-111111111111',
    'A1',
    'easy',
    'Rejected reviewed worksheet',
    'This row proves that teacher_reviewed alone is not approval.',
    false,
    true,
    'workspace',
    '91111111-1111-4111-8111-111111111111',
    'manual',
    'failed'
  ),
  (
    '9e222222-2222-4222-8222-222222222222',
    '93333333-3333-4333-8333-333333333333',
    '9c111111-1111-4111-8111-111111111111',
    'A1',
    'easy',
    'Approved article worksheet',
    'A reviewed and approved reusable worksheet.',
    false,
    true,
    'workspace',
    '91111111-1111-4111-8111-111111111111',
    'manual',
    'approved'
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
  assigned_by
)
values
  (
    '9d111111-1111-4111-8111-111111111111',
    '93333333-3333-4333-8333-333333333333',
    '92222222-2222-4222-8222-222222222222',
    '9c111111-1111-4111-8111-111111111111',
    '94444444-4444-4444-8444-444444444444',
    'A1',
    1,
    'teacher_verified',
    'teacher_assigned',
    'unlocked',
    '91111111-1111-4111-8111-111111111111'
  ),
  (
    '9d222222-2222-4222-8222-222222222222',
    '93333333-3333-4333-8333-333333333333',
    '92222222-2222-4222-8222-222222222222',
    '9c222222-2222-4222-8222-222222222222',
    '94444444-4444-4444-8444-444444444444',
    'A1',
    1,
    'teacher_verified',
    'teacher_assigned',
    'unlocked',
    '91111111-1111-4111-8111-111111111111'
  );

create temporary table phase_9a_worksheet_payloads (
  name text primary key,
  payload jsonb not null
) on commit drop;
grant select on table phase_9a_worksheet_payloads to service_role;

create function pg_temp.phase_9a_add_current_worksheet_critics(
  candidate jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  candidate_sha256 text;
  checks jsonb := jsonb_build_object(
    'ambiguity_free', true,
    'no_answer_leakage', true,
    'duplicate_free', true,
    'level_fit', true,
    'topic_fit', true,
    'type_balance', true,
    'scoring_safe', true
  );
  content_checks jsonb := jsonb_build_object(
    'mini_lesson_scope_accurate', true,
    'learner_cues_semantically_aligned', true,
    'examples_rubrics_consistent', true
  );
  deepseek_critic jsonb;
  gemini_critic jsonb;
begin
  candidate_sha256 := app_private.worksheet_candidate_sha256(candidate);
  deepseek_critic := jsonb_build_object(
    'provider', 'deepseek',
    'model', 'deepseek-v4-flash',
    'candidate_sha256', candidate_sha256,
    'approved', true,
    'checks', checks,
    'content_checks', content_checks,
    'rejection_reasons', '[]'::jsonb
  );
  deepseek_critic := deepseek_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(deepseek_critic)
  );
  gemini_critic := jsonb_build_object(
    'provider', 'gemini',
    'model', 'gemini-3.1-flash-lite',
    'candidate_sha256', candidate_sha256,
    'approved', true,
    'checks', checks,
    'content_checks', content_checks,
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
      'candidate_sha256', candidate_sha256,
      'critics', jsonb_build_object(
        'deepseek', deepseek_critic,
        'gemini', gemini_critic
      ),
      'attempt_count', 1,
      'checks', checks,
      'content_checks', content_checks,
      'rejection_reasons', '[]'::jsonb
    )
  );
end;
$$;

revoke all on function
  pg_temp.phase_9a_add_current_worksheet_critics(jsonb)
from public;

insert into phase_9a_worksheet_payloads (name, payload)
values (
  'valid',
  pg_temp.phase_9a_add_current_worksheet_critics(jsonb_build_object(
    'schema_version', 1,
    'mode', 'generated',
    'generation_source', 'deepseek',
    'generator_model', 'deepseek-v4-pro',
    'title', 'Artikel im Alltag',
    'level', 'A1',
    'difficulty', 'easy',
    'description', 'Practice definite and indefinite articles in short A1 sentences.',
    'mini_lesson', jsonb_build_object(
      'short_explanation', 'Articles change with the role and gender of the noun.',
      'key_rule', 'A masculine direct object uses den or einen.',
      'correct_examples', jsonb_build_array(
        'Ich sehe den Hund.',
        'Er kauft einen Apfel.'
      ),
      'common_mistake_warning', 'Check the noun role before choosing an article.',
      'what_to_revise', 'Review definite and indefinite masculine articles.'
    ),
    'questions', jsonb_build_array(
      jsonb_build_object(
        'question_number', 1,
        'question_type', 'multiple_choice',
        'evaluation_mode', 'local_exact',
        'prompt', 'Choose the correct article: Ich sehe ___ Hund.',
        'options', jsonb_build_array('der', 'den', 'dem'),
        'correct_answer', 'den',
        'accepted_answers', jsonb_build_array('den'),
        'rubric', 'null'::jsonb,
        'explanation', 'Hund is a masculine direct object, so use den.'
      ),
      jsonb_build_object(
        'question_number', 2,
        'question_type', 'multiple_choice',
        'evaluation_mode', 'local_exact',
        'prompt', 'Choose the correct article: Ich helfe ___ Mann.',
        'options', jsonb_build_array('der', 'den', 'dem'),
        'correct_answer', 'dem',
        'accepted_answers', jsonb_build_array('dem'),
        'rubric', 'null'::jsonb,
        'explanation', 'Helfen takes the dative, so use dem.'
      ),
      jsonb_build_object(
        'question_number', 3,
        'question_type', 'fill_blank',
        'evaluation_mode', 'local_exact',
        'prompt', 'Complete with the definite article: Ich sehe ___ Hund.',
        'options', '[]'::jsonb,
        'correct_answer', 'den',
        'accepted_answers', jsonb_build_array('den'),
        'rubric', 'null'::jsonb,
        'explanation', 'The definite masculine accusative article is den.'
      ),
      jsonb_build_object(
        'question_number', 4,
        'question_type', 'fill_blank',
        'evaluation_mode', 'local_exact',
        'prompt', 'Complete with the indefinite article: Er kauft ___ Apfel.',
        'options', '[]'::jsonb,
        'correct_answer', 'einen',
        'accepted_answers', jsonb_build_array('einen'),
        'rubric', 'null'::jsonb,
        'explanation', 'The indefinite masculine accusative article is einen.'
      ),
      jsonb_build_object(
        'question_number', 5,
        'question_type', 'fill_blank',
        'evaluation_mode', 'local_exact',
        'prompt', 'Complete with the conjugated form of lernen: Ich ___ Deutsch.',
        'options', '[]'::jsonb,
        'correct_answer', 'lerne',
        'accepted_answers', jsonb_build_array('lerne'),
        'rubric', 'null'::jsonb,
        'explanation', 'The ich form of lernen is lerne.'
      ),
      jsonb_build_object(
        'question_number', 6,
        'question_type', 'sentence_correction',
        'evaluation_mode', 'open_evaluation',
        'prompt', 'Correct the full sentence: Ich helfe den Mann.',
        'options', '[]'::jsonb,
        'correct_answer', 'Ich helfe dem Mann.',
        'accepted_answers', '[]'::jsonb,
        'rubric', jsonb_build_object(
          'criteria', jsonb_build_array(
            'Use the dative article dem after helfen.'
          ),
          'sample_answer', 'Ich helfe dem Mann.'
        ),
        'explanation', 'The verb helfen requires the dative.'
      ),
      jsonb_build_object(
        'question_number', 7,
        'question_type', 'transformation',
        'evaluation_mode', 'open_evaluation',
        'prompt', 'Rewrite with the time phrase first: Ich lerne heute Deutsch.',
        'options', '[]'::jsonb,
        'correct_answer', 'Heute lerne ich Deutsch.',
        'accepted_answers', '[]'::jsonb,
        'rubric', jsonb_build_object(
          'criteria', jsonb_build_array(
            'Place heute first and keep lerne in position two.'
          ),
          'sample_answer', 'Heute lerne ich Deutsch.'
        ),
        'explanation', 'The conjugated verb remains in position two.'
      ),
      jsonb_build_object(
        'question_number', 8,
        'question_type', 'word_order',
        'evaluation_mode', 'open_evaluation',
        'prompt', 'Build the sentence from: heute - ich - Deutsch - lerne.',
        'options', '[]'::jsonb,
        'correct_answer', 'Heute lerne ich Deutsch.',
        'accepted_answers', '[]'::jsonb,
        'rubric', jsonb_build_object(
          'criteria', jsonb_build_array(
            'Use all words and place the conjugated verb second.'
          ),
          'sample_answer', 'Heute lerne ich Deutsch.'
        ),
        'explanation', 'The time phrase comes first and the verb comes second.'
      )
    ),
    'source_mix', jsonb_build_object(
      'mode', 'deepseek',
      'deepseek_count', 8,
      'gemini_count', 0
    ),
    'validation', jsonb_build_object(
      'deterministic', true,
      'independent_model', true,
      'critic_model', 'deepseek-v4-flash',
      'attempt_count', 1,
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
  ))
);

insert into phase_9a_worksheet_payloads (name, payload)
select
  'ambiguous_blank',
  pg_temp.phase_9a_add_current_worksheet_critics(jsonb_set(
    payload,
    '{questions,2,prompt}',
    to_jsonb('Complete with one article: Ich sehe ___ Hund.'::text),
    false
  ))
from phase_9a_worksheet_payloads
where name = 'valid';

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', '92222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $$
    with requested as (
      select *
      from api.request_practice_worksheet(
        '9d111111-1111-4111-8111-111111111111'
      )
    )
    update pg_temp.phase_9a_state state
    set worksheet_reuse_assignment_id = requested.assignment_id,
        worksheet_reuse_job_id = requested.job_id,
        worksheet_reuse_response_status = requested.generation_status
    from requested
    where state.singleton
  $$,
  'an active student can durably request worksheet preparation'
);
select is(
  (select worksheet_reuse_response_status from pg_temp.phase_9a_state),
  'queued'::text,
  'worksheet preparation acknowledges the queued state'
);

reset role;
update phase_9a_state state
set worksheet_reuse_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.worksheet_reuse_job_id;

select pg_temp.phase_9a_rekey_fixture_message(
  (select worksheet_reuse_job_id from phase_9a_state),
  pg_temp.phase_9a_fixture_message_id(101)
);
update phase_9a_state
set worksheet_reuse_message_id = pg_temp.phase_9a_fixture_message_id(101)
where singleton;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'worksheet_generation',
    '9f111111-1111-4111-8111-111111111111',
    1,
    600
  )
)
update pg_temp.phase_9a_state state
set worksheet_reuse_job_id = claimed.job_id,
    worksheet_reuse_message_id = claimed.queue_message_id
from claimed
where state.singleton;

-- Final-schema workers use only the exposed, provenance-gated facade.

select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select worksheet_reuse_job_id from pg_temp.phase_9a_state),
      (select worksheet_reuse_message_id from pg_temp.phase_9a_state),
      '9f111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'reuse',
        'reusable_practice_test_id', '9e111111-1111-4111-8111-111111111111'
      )
    )
  $$,
  '22023',
  'Reusable worksheet is not eligible.',
  'teacher-reviewed but failed content cannot be reused'
);

reset role;
select ok(
  (
    select job.status = 'processing'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'generating'
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.id = (select worksheet_reuse_job_id from phase_9a_state)
  ),
  'a rejected reuse rolls back without partially attaching content'
);

set local role service_role;
select lives_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select worksheet_reuse_job_id from pg_temp.phase_9a_state),
      (select worksheet_reuse_message_id from pg_temp.phase_9a_state),
      '9f111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'reuse',
        'reusable_practice_test_id', '9e222222-2222-4222-8222-222222222222'
      )
    )
  $$,
  'an approved worksheet completes through the transactional reuse path'
);

reset role;
select ok(
  (
    select assignment.practice_test_id = '9e222222-2222-4222-8222-222222222222'::uuid
      and assignment.generation_status = 'ready'
      and job.status = 'succeeded'
      and not app_private.queue_message_exists(job.queue_name, job.queue_message_id)
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.id = (select worksheet_reuse_job_id from phase_9a_state)
  ),
  'approved reuse atomically attaches content, succeeds the job, and archives the message'
);

set local role service_role;
select lives_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select worksheet_reuse_job_id from pg_temp.phase_9a_state),
      (select worksheet_reuse_message_id from pg_temp.phase_9a_state),
      '9f111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'reuse',
        'reusable_practice_test_id', '9e222222-2222-4222-8222-222222222222'
      )
    )
  $$,
  'redelivery returns the already-completed worksheet result idempotently'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', '92222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $$
    with requested as (
      select *
      from api.request_practice_worksheet(
        '9d222222-2222-4222-8222-222222222222'
      )
    )
    update pg_temp.phase_9a_state state
    set worksheet_generated_assignment_id = requested.assignment_id,
        worksheet_generated_job_id = requested.job_id
    from requested
    where state.singleton
  $$,
  'a second active topic receives its own durable generation job'
);

reset role;
update phase_9a_state state
set worksheet_generated_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.worksheet_generated_job_id;

select pg_temp.phase_9a_rekey_fixture_message(
  (select worksheet_generated_job_id from phase_9a_state),
  pg_temp.phase_9a_fixture_message_id(102)
);
update phase_9a_state
set worksheet_generated_message_id = pg_temp.phase_9a_fixture_message_id(102)
where singleton;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'worksheet_generation',
    '9f222222-2222-4222-8222-222222222222',
    1,
    600
  )
)
update pg_temp.phase_9a_state state
set worksheet_generated_job_id = claimed.job_id,
    worksheet_generated_message_id = claimed.queue_message_id
from claimed
where state.singleton;

select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select worksheet_generated_job_id from pg_temp.phase_9a_state),
      (select worksheet_generated_message_id from pg_temp.phase_9a_state),
      '9f222222-2222-4222-8222-222222222222',
      (select payload from pg_temp.phase_9a_worksheet_payloads where name = 'ambiguous_blank')
    )
  $$,
  '22023',
  'Generated worksheet question constraints are invalid.',
  'a generic one-blank question cannot enter exact scoring'
);

reset role;
select ok(
  (
    select job.status = 'processing'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'generating'
      and not exists (
        select 1
        from public.practice_tests test
        where test.generation_job_id = job.id
      )
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.id = (select worksheet_generated_job_id from phase_9a_state)
  ),
  'invalid generated content rolls back the candidate and parent transition together'
);

set local role service_role;
select lives_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select worksheet_generated_job_id from pg_temp.phase_9a_state),
      (select worksheet_generated_message_id from pg_temp.phase_9a_state),
      '9f222222-2222-4222-8222-222222222222',
      (select payload from pg_temp.phase_9a_worksheet_payloads where name = 'valid')
    )
  $$,
  'a valid eight-question A1 candidate completes transactionally'
);

reset role;
update phase_9a_state state
set worksheet_generated_test_id = test.id
from public.practice_tests test
where test.generation_job_id = state.worksheet_generated_job_id;

select ok(
  (
    select test.quality_status = 'approved'
      and test.visibility = 'workspace'
      and not test.teacher_reviewed
      and assignment.practice_test_id = test.id
      and assignment.generation_status = 'ready'
      and job.status = 'succeeded'
      and not app_private.queue_message_exists(job.queue_name, job.queue_message_id)
      and (
        select count(*)
        from public.practice_test_questions question
        where question.practice_test_id = test.id
      ) = 8
    from public.practice_tests test
    join app_private.async_jobs job on job.id = test.generation_job_id
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where test.id = (select worksheet_generated_test_id from phase_9a_state)
  ),
  'independently validated generated content is complete, approved, and attached automatically'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', '92222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $$
    with requested as (
      select *
      from api.request_practice_worksheet(
        '9d222222-2222-4222-8222-222222222222'
      )
    )
    update pg_temp.phase_9a_state state
    set worksheet_generated_response_status = requested.generation_status,
        worksheet_generated_response_job_id = requested.job_id
    from requested
    where state.singleton
  $$,
  'requesting a held candidate returns state without another generation'
);

reset role;
select is(
  (
    select jsonb_build_object(
      'generation_status', state.worksheet_generated_response_status,
      'response_job_id', state.worksheet_generated_response_job_id,
      'job_count', (
        select count(*)
        from app_private.async_jobs job
        where job.job_kind = 'worksheet_generation'
          and job.entity_id = state.worksheet_generated_assignment_id
      ),
      'assignment_points_to_original', (
        select assignment.practice_test_id = state.worksheet_generated_test_id
        from public.student_practice_assignments assignment
        where assignment.id = state.worksheet_generated_assignment_id
      ),
      'original_test_current',
        app_private.practice_test_canonical_revision_is_current(
          state.worksheet_generated_test_id
        ),
      'unlinked_evidence_current',
        app_private.practice_test_has_current_unlinked_model_evidence(
          state.worksheet_generated_test_id
        ),
      'assignment_original_evidence_current',
        app_private.practice_assignment_has_current_original_model_evidence(
          state.worksheet_generated_assignment_id
        ),
      'withdrawn_unstarted',
        app_private.practice_assignment_has_withdrawn_unstarted_clone(
          state.worksheet_generated_assignment_id
        ),
      'completion_exists', exists (
        select 1
        from app_private.worksheet_generation_completions_v2 completion
        where completion.practice_test_id = state.worksheet_generated_test_id
      ),
      'cache_source_exists', exists (
        select 1
        from app_private.practice_worksheet_model_cache_sources source_link
        where source_link.source_practice_test_id =
          state.worksheet_generated_test_id
      )
    )
    from phase_9a_state state
    where state.singleton
  ),
  '{
    "generation_status":"ready",
    "response_job_id":null,
    "job_count":1,
    "assignment_points_to_original":true,
    "original_test_current":false,
    "unlinked_evidence_current":false,
    "assignment_original_evidence_current":true,
    "withdrawn_unstarted":false,
    "completion_exists":true,
    "cache_source_exists":false
  }'::jsonb,
  'ready generated content is reused without another Pro job or queue message'
);

reset role;

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  '93333333-3333-4333-8333-333333333333',
  '94444444-4444-4444-8444-444444444444',
  '92222222-2222-4222-8222-222222222223'
);

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, batch_id,
  worksheet_level, class_context_version, class_context_integrity,
  source, status, assigned_by
)
values (
  '9d333333-3333-4333-8333-333333333333',
  '93333333-3333-4333-8333-333333333333',
  '92222222-2222-4222-8222-222222222223',
  '9c222222-2222-4222-8222-222222222222',
  '94444444-4444-4444-8444-444444444444',
  'A1', 1, 'teacher_verified', 'teacher_assigned', 'unlocked',
  '91111111-1111-4111-8111-111111111111'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222223',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92222222-2222-4222-8222-222222222223',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $$
    select *
    from api.request_practice_worksheet(
      '9d333333-3333-4333-8333-333333333333'
    )
  $$,
  'another student can request the topic without receiving the original semantic worksheet'
);

reset role;
select ok(
  exists (
    select 1
    from public.student_practice_assignments assignment
    join app_private.async_jobs job
      on job.entity_id = assignment.id
     and job.job_kind = 'worksheet_generation'
     and job.status = 'queued'
    where assignment.id = '9d333333-3333-4333-8333-333333333333'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'queued'
  ),
  'cross-student reuse remains MCQ-only and semantic content takes its own durable path'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '92222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '92222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  (
    with visible_questions as (
      select api.get_practice_assignment_questions(
        '9d222222-2222-4222-8222-222222222222'
      ) as payload
    ), answers as (
      select jsonb_agg(
        jsonb_build_object(
          'question_id', question.value ->> 'id',
          'answer', case (question.value ->> 'question_number')::integer
            when 1 then 'den'
            when 2 then 'dem'
            when 3 then 'den'
            when 4 then 'einen'
            when 5 then 'lerne'
            when 6 then 'Ich helfe dem Mann.'
            when 7 then 'Heute lerne ich Deutsch.'
            when 8 then 'Heute lerne ich Deutsch.'
          end
        )
        order by (question.value ->> 'question_number')::integer
      ) as payload
      from visible_questions
      cross join lateral jsonb_array_elements(visible_questions.payload)
        question(value)
    )
    select jsonb_build_object(
      'type', jsonb_typeof(answers.payload),
      'count', jsonb_array_length(answers.payload),
      'malformed_count', (
        select count(*)
        from jsonb_array_elements(answers.payload) answer_item
        where jsonb_typeof(answer_item) <> 'object'
          or not (answer_item ?& array['question_id', 'answer'])
          or coalesce(answer_item ->> 'question_id', '')
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or jsonb_typeof(answer_item -> 'answer') <> 'string'
      ),
      'duplicate_count', (
        select count(*) - count(distinct answer_item ->> 'question_id')
        from jsonb_array_elements(answers.payload) answer_item
      ),
      'assignment_matches', (
        select assignment.practice_test_id = state.worksheet_generated_test_id
        from public.student_practice_assignments assignment
        cross join pg_temp.phase_9a_state state
        where assignment.id = '9d222222-2222-4222-8222-222222222222'
      )
    )
    from answers
  ),
  '{
    "type":"array",
    "count":8,
    "malformed_count":0,
    "duplicate_count":0,
    "assignment_matches":true
  }'::jsonb,
  'the generated semantic worksheet answers satisfy the resumable draft contract'
);

select lives_ok(
  $$
    with visible_questions as (
      select api.get_practice_assignment_questions(
        '9d222222-2222-4222-8222-222222222222'
      ) as payload
    ), answers as (
      select jsonb_agg(
        jsonb_build_object(
          'question_id', question.value ->> 'id',
          'answer', case (question.value ->> 'question_number')::integer
            when 1 then 'den'
            when 2 then 'dem'
            when 3 then 'den'
            when 4 then 'einen'
            when 5 then 'lerne'
            when 6 then 'Ich helfe dem Mann.'
            when 7 then 'Heute lerne ich Deutsch.'
            when 8 then 'Heute lerne ich Deutsch.'
          end
        )
        order by (question.value ->> 'question_number')::integer
      ) as payload
      from visible_questions
      cross join lateral jsonb_array_elements(visible_questions.payload)
        question(value)
    ), saved as (
      select saved_draft.*
      from answers
      cross join lateral api.save_practice_draft(
        '9d222222-2222-4222-8222-222222222222',
        answers.payload,
        0
      ) saved_draft
    ), submitted as (
      select api.submit_practice_attempt(
        '9d222222-2222-4222-8222-222222222222',
        1
      ) as payload
      from saved
    )
    select payload from submitted
  $$,
  'the original student can autosave and submit all generated semantic questions'
);

reset role;
select ok(
  exists (
    select 1
    from public.student_practice_assignments assignment
    join public.practice_test_attempts attempt
      on attempt.id = assignment.latest_attempt_id
     and attempt.assignment_id = assignment.id
     and attempt.practice_test_id = assignment.practice_test_id
    join app_private.async_jobs job
      on job.entity_id = attempt.id
     and job.job_kind = 'worksheet_answer_evaluation'
     and job.status = 'queued'
    where assignment.id = '9d222222-2222-4222-8222-222222222222'
      and attempt.status = 'submitted'
      and attempt.evaluation_status = 'queued'
  ),
  'semantic worksheet submission reaches the durable answer-evaluation queue'
);

select * from finish();
rollback;
