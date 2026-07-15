begin;

select plan(26);

-- Catalog, RLS, and privilege boundaries for the paid-work controls.
select has_table(
  'app_private',
  'ai_paid_work_limits',
  'paid-work limits are stored outside the exposed API schemas'
);

select has_table(
  'app_private',
  'ai_workspace_daily_usage',
  'workspace paid-work reservations are stored privately'
);

select has_table(
  'app_private',
  'ai_student_daily_usage',
  'student paid-work reservations are stored privately'
);

select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'app_private.ai_paid_work_limits'::regclass)
    and (select relrowsecurity
         from pg_class
         where oid = 'app_private.ai_workspace_daily_usage'::regclass)
    and (select relrowsecurity
         from pg_class
         where oid = 'app_private.ai_student_daily_usage'::regclass),
  'every paid-work control table has RLS defense in depth'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'app_private.ai_paid_work_limits',
    'SELECT,INSERT,UPDATE,DELETE'
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.ai_workspace_daily_usage',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.ai_student_daily_usage',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.ai_workspace_daily_usage',
      'SELECT,INSERT,UPDATE,DELETE'
    ),
  'Data API roles cannot inspect or mutate paid-work reservations directly'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.consume_ai_paid_work_budget(text,uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.enqueue_async_job(text,uuid,integer,text,uuid,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.consume_ai_paid_work_budget(text,uuid)',
      'EXECUTE'
    ),
  'paid-work internals are not callable through a Data API role'
);

-- Every queue message and counter below is attached to the unique Phase 11W
-- fixture identities. Existing operational rows remain untouched, and the
-- final rollback removes the complete fixture graph.

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
    '0b111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase11w-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11W Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '0b222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase11w-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11W Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  '0b333333-3333-4333-8333-333333333333',
  'Phase 11W Workspace',
  'phase-11w-workspace',
  '0b111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '0b111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '0b333333-3333-4333-8333-333333333333',
  '0b111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '0b333333-3333-4333-8333-333333333333',
  '0b222222-2222-4222-8222-222222222222',
  'student'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  is_active,
  feedback_mode
)
values (
  '0b555555-5555-4555-8555-555555555555',
  '0b333333-3333-4333-8333-333333333333',
  'Phase 11W A2',
  'A2',
  true,
  'immediate'
);

insert into public.batch_students (
  id,
  batch_id,
  student_id,
  workspace_id
)
values (
  '0b666666-6666-4666-8666-666666666666',
  '0b555555-5555-4555-8555-555555555555',
  '0b222222-2222-4222-8222-222222222222',
  '0b333333-3333-4333-8333-333333333333'
);

insert into public.submissions (
  id,
  workspace_id,
  student_id,
  batch_id,
  mode,
  question_source,
  original_text,
  status,
  feedback_mode,
  evaluation_status,
  release_status,
  evaluation_version
)
values
  (
    '0b444444-4444-4444-8444-444444444441',
    '0b333333-3333-4333-8333-333333333333',
    '0b222222-2222-4222-8222-222222222222',
    '0b555555-5555-4555-8555-555555555555',
    'free_text',
    'free_text',
    'Ich lerne jeden Tag Deutsch.',
    'submitted',
    'immediate',
    'queued',
    'held',
    1
  ),
  (
    '0b444444-4444-4444-8444-444444444442',
    '0b333333-3333-4333-8333-333333333333',
    '0b222222-2222-4222-8222-222222222222',
    '0b555555-5555-4555-8555-555555555555',
    'free_text',
    'free_text',
    'Heute schreibe ich einen zweiten Text.',
    'submitted',
    'immediate',
    'queued',
    'held',
    1
  ),
  (
    '0b444444-4444-4444-8444-444444444443',
    '0b333333-3333-4333-8333-333333333333',
    '0b222222-2222-4222-8222-222222222222',
    '0b555555-5555-4555-8555-555555555555',
    'free_text',
    'free_text',
    'Morgen schreibe ich noch einen Text.',
    'submitted',
    'immediate',
    'queued',
    'held',
    1
  );

do $$
begin
  perform app_private.capture_writing_evaluation_context(submission.id)
  from public.submissions submission
  where submission.id in (
    '0b444444-4444-4444-8444-444444444441'::uuid,
    '0b444444-4444-4444-8444-444444444442'::uuid,
    '0b444444-4444-4444-8444-444444444443'::uuid
  );
end;
$$;

update app_private.ai_paid_work_limits
set
  max_writing_jobs_per_student_workspace_day = 3,
  max_writing_jobs_per_workspace_day = 10,
  max_manual_writing_requeues_per_submission = 2
where singleton;

create temporary table phase_11w_state (
  singleton boolean primary key default true check (singleton),
  first_job_id uuid,
  first_message_id bigint,
  first_created boolean,
  duplicate_job_id uuid,
  duplicate_message_id bigint,
  duplicate_created boolean,
  future_job_id uuid
) on commit drop;

insert into phase_11w_state default values;

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'writing_evaluation',
    '0b444444-4444-4444-8444-444444444441',
    1,
    'phase11w:idempotent-writing:1',
    '0b222222-2222-4222-8222-222222222222',
    0
  )
)
update phase_11w_state state
set first_job_id = enqueued.job_id,
    first_message_id = enqueued.queue_message_id,
    first_created = enqueued.created
from enqueued
where state.singleton;

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'writing_evaluation',
    '0b444444-4444-4444-8444-444444444441',
    1,
    'phase11w:idempotent-writing:1',
    '0b222222-2222-4222-8222-222222222222',
    0
  )
)
update phase_11w_state state
set duplicate_job_id = enqueued.job_id,
    duplicate_message_id = enqueued.queue_message_id,
    duplicate_created = enqueued.created
from enqueued
where state.singleton;

select is(
  (select first_created from phase_11w_state),
  true,
  'the first idempotent enqueue reserves paid work and creates a job'
);

select is(
  (select duplicate_created from phase_11w_state),
  false,
  'a duplicate idempotency key does not create another paid job'
);

select ok(
  (
    select first_job_id = duplicate_job_id
      and first_message_id = duplicate_message_id
    from phase_11w_state
  ),
  'the duplicate returns the original durable job and queue message'
);

select is(
  (
    select usage.writing_job_count
    from app_private.ai_workspace_daily_usage usage
    where usage.workspace_id = '0b333333-3333-4333-8333-333333333333'
      and usage.usage_day = (now() at time zone 'UTC')::date
  ),
  1,
  'an idempotent duplicate charges the workspace budget exactly once'
);

select is(
  (
    select usage.writing_job_count
    from app_private.ai_student_daily_usage usage
    where usage.workspace_id = '0b333333-3333-4333-8333-333333333333'
      and usage.student_id = '0b222222-2222-4222-8222-222222222222'
      and usage.usage_day = (now() at time zone 'UTC')::date
  ),
  1,
  'an idempotent duplicate charges the student budget exactly once'
);

select is(
  (
    select count(*)::integer
    from pgmq.q_writing_evaluation queue
    where queue.message ->> 'job_id' = (
      select first_job_id::text from phase_11w_state
    )
  ),
  1,
  'an idempotent duplicate leaves exactly one PGMQ message'
);

-- Two manual requeues are allowed after the original job-version reservation.
do $$
begin
  update public.submissions submission
  set evaluation_version = 2
  where submission.id = '0b444444-4444-4444-8444-444444444441';

  perform *
  from app_private.enqueue_async_job(
    'writing_evaluation',
    '0b444444-4444-4444-8444-444444444441',
    2,
    'phase11w:manual-writing:2',
    '0b111111-1111-4111-8111-111111111111',
    0
  );

  update public.submissions submission
  set evaluation_version = 3
  where submission.id = '0b444444-4444-4444-8444-444444444441';

  perform *
  from app_private.enqueue_async_job(
    'writing_evaluation',
    '0b444444-4444-4444-8444-444444444441',
    3,
    'phase11w:manual-writing:3',
    '0b111111-1111-4111-8111-111111111111',
    0
  );
end;
$$;

select is(
  (
    select count(*)::integer
    from app_private.async_jobs job
    where job.job_kind = 'writing_evaluation'
      and job.entity_id = '0b444444-4444-4444-8444-444444444441'
  ),
  3,
  'the original writing evaluation plus two manual requeues are persisted'
);

select is(
  (
    select usage.writing_job_count
    from app_private.ai_student_daily_usage usage
    where usage.workspace_id = '0b333333-3333-4333-8333-333333333333'
      and usage.student_id = '0b222222-2222-4222-8222-222222222222'
      and usage.usage_day = (now() at time zone 'UTC')::date
  ),
  3,
  'each allowed manual requeue consumes one paid-work reservation'
);

select throws_ok(
  $$
    select *
    from app_private.enqueue_async_job(
      'writing_evaluation',
      '0b444444-4444-4444-8444-444444444441',
      4,
      'phase11w:manual-writing:4',
      '0b111111-1111-4111-8111-111111111111',
      0
    )
  $$,
  '54000',
  'writing_manual_retry_limit_exceeded',
  'a third manual writing requeue is rejected'
);

select ok(
  (
    select count(*) = 3
    from app_private.async_jobs job
    where job.job_kind = 'writing_evaluation'
      and job.entity_id = '0b444444-4444-4444-8444-444444444441'
  )
    and (
      select usage.writing_job_count = 3
      from app_private.ai_workspace_daily_usage usage
      where usage.workspace_id = '0b333333-3333-4333-8333-333333333333'
        and usage.usage_day = (now() at time zone 'UTC')::date
    ),
  'a rejected manual requeue creates neither a job nor a budget charge'
);

-- The historical student writing-job value remains visible as telemetry, but
-- it must not undercut an administrator-approved class allowance.
select lives_ok(
  $$
    select *
    from app_private.enqueue_async_job(
      'writing_evaluation',
      '0b444444-4444-4444-8444-444444444442',
      1,
      'phase11w:student-budget-rejection',
      '0b222222-2222-4222-8222-222222222222',
      0
    )
  $$,
  'a new writing job is accepted after crossing the historical student-day value'
);

select ok(
  (
    select usage.writing_job_count = 4
    from app_private.ai_workspace_daily_usage usage
    where usage.workspace_id = '0b333333-3333-4333-8333-333333333333'
      and usage.usage_day = (now() at time zone 'UTC')::date
  )
    and exists (
      select 1
      from app_private.async_jobs job
      where job.idempotency_key = 'phase11w:student-budget-rejection'
    )
    and exists (
      select 1
      from pgmq.q_writing_evaluation queue
      where queue.message ->> 'entity_id' =
        '0b444444-4444-4444-8444-444444444442'
    )
    and (
      select usage.writing_job_count = 4
      from app_private.ai_student_daily_usage usage
      where usage.workspace_id = '0b333333-3333-4333-8333-333333333333'
        and usage.student_id = '0b222222-2222-4222-8222-222222222222'
        and usage.usage_day = (now() at time zone 'UTC')::date
    ),
  'crossing the historical value commits the job, message, and cost telemetry'
);

-- Old operational counters are deleted on the next successful paid enqueue.
insert into app_private.ai_workspace_daily_usage (
  workspace_id,
  usage_day,
  writing_job_count
)
values (
  '0b333333-3333-4333-8333-333333333333',
  (now() at time zone 'UTC')::date - 36,
  1
);

insert into app_private.ai_student_daily_usage (
  workspace_id,
  student_id,
  usage_day,
  writing_job_count
)
values (
  '0b333333-3333-4333-8333-333333333333',
  '0b222222-2222-4222-8222-222222222222',
  (now() at time zone 'UTC')::date - 36,
  1
);

update app_private.ai_paid_work_limits
set max_writing_jobs_per_student_workspace_day = 10
where singleton;

update public.submissions submission
set evaluation_version = 2
where submission.id = '0b444444-4444-4444-8444-444444444442';

do $$
begin
  perform app_private.capture_writing_evaluation_context(
    '0b444444-4444-4444-8444-444444444442'::uuid
  );
end;
$$;

select lives_ok(
  $$
    select *
    from app_private.enqueue_async_job(
      'writing_evaluation',
      '0b444444-4444-4444-8444-444444444442',
      2,
      'phase11w:retention-success',
      '0b222222-2222-4222-8222-222222222222',
      0
    )
  $$,
  'a second writing version runs paid-work retention cleanup'
);

select ok(
  not exists (
    select 1
    from app_private.ai_workspace_daily_usage usage
    where usage.workspace_id = '0b333333-3333-4333-8333-333333333333'
      and usage.usage_day = (now() at time zone 'UTC')::date - 36
  )
    and not exists (
      select 1
      from app_private.ai_student_daily_usage usage
      where usage.workspace_id = '0b333333-3333-4333-8333-333333333333'
        and usage.student_id = '0b222222-2222-4222-8222-222222222222'
        and usage.usage_day = (now() at time zone 'UTC')::date - 36
    ),
  'the fixture reservations beyond the 35-day retention window are removed'
);

select ok(
  (
    select usage.writing_job_count = 5
    from app_private.ai_workspace_daily_usage usage
    where usage.workspace_id = '0b333333-3333-4333-8333-333333333333'
      and usage.usage_day = (now() at time zone 'UTC')::date
  )
    and (
      select usage.writing_job_count = 5
      from app_private.ai_student_daily_usage usage
      where usage.workspace_id = '0b333333-3333-4333-8333-333333333333'
        and usage.student_id = '0b222222-2222-4222-8222-222222222222'
        and usage.usage_day = (now() at time zone 'UTC')::date
    ),
  'the successful post-cleanup enqueue records matching daily reservations'
);

-- Remove only the fixture's preceding due jobs from processor authorization,
-- then create one future retry. It must not wake the writing worker early.
update app_private.async_jobs
set
  status = 'succeeded',
  completed_at = now()
where job_kind = 'writing_evaluation'
  and entity_id in (
    '0b444444-4444-4444-8444-444444444441'::uuid,
    '0b444444-4444-4444-8444-444444444442'::uuid
  );

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'writing_evaluation',
    '0b444444-4444-4444-8444-444444444443',
    1,
    'phase11w:future-writing',
    '0b222222-2222-4222-8222-222222222222',
    3600
  )
)
update phase_11w_state state
set future_job_id = enqueued.job_id
from enqueued
where state.singleton;

insert into app_private.writing_processor_kick_windows (
  user_id,
  window_started_at,
  kick_count
)
values (
  '0b222222-2222-4222-8222-222222222222',
  date_trunc('minute', now()) - interval '20 minutes',
  1
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '0b111111-1111-4111-8111-111111111111',
    'role', 'service_role'
  )::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  api.authorize_writing_processor_kick(
    '0b222222-2222-4222-8222-222222222222'
  ),
  'no_pending_work'::text,
  'a future writing retry does not wake the processor early'
);

reset role;

select ok(
  not exists (
    select 1
    from app_private.writing_processor_kick_windows usage_window
    where usage_window.user_id = '0b222222-2222-4222-8222-222222222222'
      and usage_window.window_started_at = date_trunc('minute', now())
  )
    and exists (
      select 1
      from app_private.async_jobs job
      join pgmq.q_writing_evaluation queue
        on queue.msg_id = job.queue_message_id
      where job.id = (select future_job_id from phase_11w_state)
        and job.available_at > now()
        and queue.vt > now()
    ),
  'a future-only kick consumes no bucket while both durable clocks remain future'
);

update app_private.async_jobs
set available_at = now() - interval '1 second'
where id = (select future_job_id from phase_11w_state);
update pgmq.q_writing_evaluation queue
set vt = now() - interval '1 second'
from app_private.async_jobs job
where job.id = (select future_job_id from phase_11w_state)
  and queue.msg_id = job.queue_message_id;
set local role service_role;

select is(
  api.authorize_writing_processor_kick(
    '0b222222-2222-4222-8222-222222222222'
  ),
  'allowed'::text,
  'the same writing retry can wake the processor once it is due'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.writing_processor_kick_windows usage_window
    where usage_window.user_id = '0b222222-2222-4222-8222-222222222222'
      and usage_window.window_started_at =
        date_trunc('minute', now()) - interval '20 minutes'
  ),
  0,
  'an allowed kick removes the fixture stale kick-window counter'
);

select is(
  (
    select usage_window.kick_count
    from app_private.writing_processor_kick_windows usage_window
    where usage_window.user_id = '0b222222-2222-4222-8222-222222222222'
      and usage_window.window_started_at = date_trunc('minute', now())
  ),
  1,
  'an allowed due kick records the current per-user rate-limit bucket'
);

select * from finish();
rollback;
