begin;

-- Shared-staging-safe: all rows and queue messages use fixture IDs and the
-- surrounding transaction rolls them back. No queue is purged or globally
-- claimed.
select plan(31);

select has_table(
  'app_private',
  'provider_outage_recovery_events',
  'provider outage recovery has a private immutable audit ledger'
);

select ok(
  to_regprocedure(
    'api.defer_async_job_for_provider_outage(uuid,bigint,uuid,text)'
  ) is not null
    and to_regprocedure('api.get_async_claimable_queue_metrics()') is not null,
  'service-only outage transition and due-work metrics exist'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.defer_async_job_for_provider_outage(uuid,bigint,uuid,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.defer_async_job_for_provider_outage(uuid,bigint,uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_async_claimable_queue_metrics()',
      'EXECUTE'
    ),
  'browser roles cannot control or inspect provider recovery internals'
);

select is(
  (
    select array_agg(
      app_private.provider_outage_retry_delay_seconds(retry_number)
      order by retry_number
    )
    from generate_series(1, 4) retry_number
  ),
  array[60, 300, 900, 1800],
  'the bounded retry schedule is 1m, 5m, 15m, then 30m'
);

select ok(
  (
    select routine.prosecdef = false
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
    from pg_proc routine
    where routine.oid =
      'api.defer_async_job_for_provider_outage(uuid,bigint,uuid,text)'::regprocedure
  ),
  'the exposed API wrapper is a pinned security invoker'
);

select ok(
  (
    select constraint_row.confdeltype = 'r'::"char"
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.provider_outage_recovery_events'::regclass
      and constraint_row.conname =
        'provider_outage_recovery_events_actor_id_fkey'
  )
    and exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'app_private.provider_outage_recovery_events'::regclass
        and constraint_row.conname =
          'provider_outage_recovery_events_job_kind_retry_key'
        and constraint_row.contype = 'u'
    ),
  'immutable actors and idempotent event inserts use named constraints'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'c1111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12j-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12J Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c2222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12j-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12J Student"}'::jsonb, now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'c3333333-3333-4333-8333-333333333333',
  'Phase 12J Workspace',
  'phase-12j-workspace',
  'c1111111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'c3333333-3333-4333-8333-333333333333',
    'c1111111-1111-4111-8111-111111111111',
    'teacher'
  ),
  (
    'c3333333-3333-4333-8333-333333333333',
    'c2222222-2222-4222-8222-222222222222',
    'student'
  );

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode
)
values (
  'c4444444-4444-4444-8444-444444444444',
  'c3333333-3333-4333-8333-333333333333',
  'Phase 12J A2', 'A2', true, 'immediate'
);

insert into public.batch_students (id, batch_id, student_id, workspace_id)
values (
  'c5555555-5555-4555-8555-555555555555',
  'c4444444-4444-4444-8444-444444444444',
  'c2222222-2222-4222-8222-222222222222',
  'c3333333-3333-4333-8333-333333333333'
);

create temporary table phase_12j_state (
  singleton boolean primary key default true check (singleton),
  main_submission_id uuid,
  main_job_id uuid,
  main_original_message_id bigint,
  generic_submission_id uuid,
  generic_job_id uuid,
  generic_original_message_id bigint,
  version_two_job_id uuid,
  version_three_job_id uuid,
  generic_submission_updated_at timestamptz
) on commit drop;
insert into phase_12j_state default values;
grant select, update on phase_12j_state to authenticated, service_role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c2222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c2222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select * from api.submit_writing(
    'c4444444-4444-4444-8444-444444444444',
    'free_text', null, 'Ich lerne heute Deutsch.'
  )
)
update pg_temp.phase_12j_state state
set main_submission_id = submitted.submission_id
from submitted
where state.singleton;

with submitted as (
  select * from api.submit_writing(
    'c4444444-4444-4444-8444-444444444444',
    'free_text', null, 'Dieser Text prueft eine normale Wiederholung.'
  )
)
update pg_temp.phase_12j_state state
set generic_submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;

update phase_12j_state state
set main_job_id = job.id,
    main_original_message_id = job.queue_message_id
from app_private.async_jobs job
where job.job_kind = 'writing_evaluation'
  and job.entity_id = state.main_submission_id;

update phase_12j_state state
set generic_job_id = job.id,
    generic_original_message_id = job.queue_message_id,
    generic_submission_updated_at = submission.updated_at
from app_private.async_jobs job
join public.submissions submission on submission.id = job.entity_id
where job.job_kind = 'writing_evaluation'
  and job.entity_id = state.generic_submission_id;

select ok(
  (
    select main_job_id is not null
      and generic_job_id is not null
      and main_job_id <> generic_job_id
    from phase_12j_state
  ),
  'fixture submissions create separate durable jobs'
);

-- A generic ordinary retry is never accepted as a replay of the outage RPC.
update app_private.async_jobs job
set status = 'retry',
    attempt_count = 1,
    worker_id = null,
    lease_expires_at = null,
    available_at = now() + interval '5 seconds'
where job.id = (select generic_job_id from phase_12j_state);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  format(
    'select * from api.defer_async_job_for_provider_outage(%L,%L,%L,%L)',
    (select generic_job_id from phase_12j_state),
    (select generic_original_message_id from phase_12j_state),
    'c8888888-8888-4888-8888-888888888888',
    'dual_provider_outage_timeout'
  ),
  '55000',
  'Job lease is no longer active.',
  'a generic retry cannot masquerade as an idempotent outage replay'
);

reset role;

select ok(
  (
    select job.provider_outage_epoch = 0
      and job.provider_outage_recovery_count = 0
      and submission.automatic_retry_at is null
      and submission.automatic_retry_exhausted_at is null
      and submission.updated_at = state.generic_submission_updated_at
    from phase_12j_state state
    join app_private.async_jobs job on job.id = state.generic_job_id
    join public.submissions submission on submission.id = state.generic_submission_id
  ),
  'the rejected generic replay leaves job and public source state unchanged'
);

-- Simulate the exact leased state produced by claim_async_jobs without
-- globally claiming an unrelated shared-staging message.
update app_private.async_jobs job
set status = 'processing',
    attempt_count = 1,
    worker_id = 'c8888888-8888-4888-8888-888888888888',
    lease_expires_at = now() + interval '5 minutes',
    first_started_at = coalesce(job.first_started_at, now()),
    last_started_at = now(),
    available_at = now()
where job.id = (select main_job_id from phase_12j_state);

set local role service_role;
select lives_ok(
  format(
    'select * from api.defer_async_job_for_provider_outage(%L,%L,%L,%L)',
    (select main_job_id from phase_12j_state),
    (select main_original_message_id from phase_12j_state),
    'c8888888-8888-4888-8888-888888888888',
    'dual_provider_outage_timeout'
  ),
  'a classified dual-provider timeout enters bounded recovery'
);
reset role;

select ok(
  (
    select job.status = 'retry'
      and job.attempt_count = 0
      and job.provider_outage_epoch = 1
      and job.provider_outage_recovery_count = 1
      and job.provider_outage_retry_at = job.available_at
      and job.provider_outage_deadline_at
        = job.provider_outage_started_at + interval '24 hours'
      and job.available_at between now() + interval '55 seconds'
        and now() + interval '65 seconds'
    from app_private.async_jobs job
    where job.id = (select main_job_id from phase_12j_state)
  ),
  'outage attempt one is delayed one minute without consuming an ordinary attempt'
);

select ok(
  (
    select submission.automatic_retry_at = job.provider_outage_retry_at
      and submission.automatic_retry_exhausted_at is null
    from phase_12j_state state
    join public.submissions submission on submission.id = state.main_submission_id
    join app_private.async_jobs job on job.id = state.main_job_id
  ),
  'the authorized source row exposes only the safe scheduled retry time'
);

select is(
  (
    select count(*)::integer
    from app_private.provider_outage_recovery_events event
    where event.job_id = (select main_job_id from phase_12j_state)
      and event.event_kind = 'scheduled'
  ),
  1,
  'the first scheduled transition has one immutable audit event'
);

select ok(
  (
    select (
      select count(*)
      from jsonb_object_keys(message.message)
    ) = 4
      and not exists (
        select 1
        from jsonb_object_keys(message.message) payload_key
        where payload_key not in (
          'job_id', 'job_kind', 'entity_id', 'entity_version'
        )
      )
      and message.message::text not like '%Ich lerne heute Deutsch.%'
    from app_private.async_jobs job
    join pgmq.q_writing_evaluation message
      on message.msg_id = job.queue_message_id
    where job.id = (select main_job_id from phase_12j_state)
  ),
  'the delayed queue payload contains IDs/version only and no writing'
);

set local role service_role;
select lives_ok(
  format(
    'select * from api.defer_async_job_for_provider_outage(%L,%L,%L,%L)',
    (select main_job_id from phase_12j_state),
    (select main_original_message_id from phase_12j_state),
    'c8888888-8888-4888-8888-888888888888',
    'dual_provider_outage_timeout'
  ),
  'a lost response can replay the exact outage transition idempotently'
);
reset role;

select is(
  (
    select count(*)::integer
    from app_private.provider_outage_recovery_events event
    where event.job_id = (select main_job_id from phase_12j_state)
      and event.event_kind = 'scheduled'
  ),
  1,
  'idempotent replay does not duplicate the queue transition audit'
);

-- Missing-message repair keeps the future availability time rather than
-- collapsing the delay into an immediate provider call.
delete from pgmq.q_writing_evaluation message
where message.msg_id = (
  select job.queue_message_id
  from app_private.async_jobs job
  where job.id = (select main_job_id from phase_12j_state)
);

select lives_ok(
  format(
    'select app_private.reconcile_async_job(%L)',
    (select main_job_id from phase_12j_state)
  ),
  'a lost delayed message is reconciled transactionally'
);

select ok(
  (
    select job.available_at > now()
      and job.provider_outage_retry_at = job.available_at
      and message.vt > now()
    from app_private.async_jobs job
    join pgmq.q_writing_evaluation message
      on message.msg_id = job.queue_message_id
    where job.id = (select main_job_id from phase_12j_state)
  ),
  'reconciliation preserves both database and PGMQ future visibility'
);

-- The browser projection is truthful but provider-neutral.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c2222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c2222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select ok(
  (
    api.get_submission_detail(
      (select main_submission_id from phase_12j_state)
    ) #>> '{submission,automatic_retry_at}'
  ) is not null
    and (
      api.get_submission_detail(
        (select main_submission_id from phase_12j_state)
      ) #>> '{submission,automatic_retry_exhausted_at}'
    ) is null,
  'the student detail projection exposes scheduled state without internals'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

-- A retry becoming live clears the public delayed marker in the same
-- transaction. Every subsequent deferral writes the new safe timestamp.
update app_private.async_jobs job
set status = 'processing',
    attempt_count = job.attempt_count + 1,
    worker_id = 'c8888888-8888-4888-8888-888888888888',
    lease_expires_at = now() + interval '5 minutes',
    last_started_at = now()
where job.id = (select main_job_id from phase_12j_state);

select is(
  (
    select submission.automatic_retry_at
    from public.submissions submission
    where submission.id = (select main_submission_id from phase_12j_state)
  ),
  null::timestamptz,
  'retry-to-processing atomically clears the source delayed marker'
);

do $phase_12j_schedule_remaining$
declare
  retry_number integer;
  current_message_id bigint;
begin
  for retry_number in 2..4 loop
    select job.queue_message_id
    into current_message_id
    from app_private.async_jobs job
    where job.id = (select main_job_id from phase_12j_state);

    if retry_number > 2 then
      update app_private.async_jobs job
      set status = 'processing',
          attempt_count = job.attempt_count + 1,
          worker_id = 'c8888888-8888-4888-8888-888888888888',
          lease_expires_at = now() + interval '5 minutes',
          last_started_at = now()
      where job.id = (select main_job_id from phase_12j_state);
    end if;

    perform *
    from public.defer_async_job_for_provider_outage(
      (select main_job_id from phase_12j_state),
      current_message_id,
      'c8888888-8888-4888-8888-888888888888',
      case when retry_number = 2
        then 'dual_provider_outage_rate_limited'
        else 'dual_provider_outage_unavailable'
      end
    );
  end loop;
end;
$phase_12j_schedule_remaining$;

select ok(
  (
    select job.status = 'retry'
      and job.attempt_count = 0
      and job.provider_outage_recovery_count = 4
      and job.provider_outage_deadline_at <= now() + interval '24 hours'
      and (
        select count(*)
        from app_private.provider_outage_recovery_events event
        where event.job_id = job.id
          and event.event_kind = 'scheduled'
      ) = 4
    from app_private.async_jobs job
    where job.id = (select main_job_id from phase_12j_state)
  ),
  'four outage retries remain separate from the ordinary attempt budget'
);

update app_private.async_jobs job
set status = 'processing',
    attempt_count = job.attempt_count + 1,
    worker_id = 'c8888888-8888-4888-8888-888888888888',
    lease_expires_at = now() + interval '5 minutes',
    last_started_at = now()
where job.id = (select main_job_id from phase_12j_state);

select lives_ok(
  format(
    'select * from public.defer_async_job_for_provider_outage(%L,%L,%L,%L)',
    (select main_job_id from phase_12j_state),
    (
      select job.queue_message_id
      from app_private.async_jobs job
      where job.id = (select main_job_id from phase_12j_state)
    ),
    'c8888888-8888-4888-8888-888888888888',
    'dual_provider_outage_unavailable'
  ),
  'the bounded lane terminates after its fourth delayed retry'
);

select ok(
  (
    select job.status = 'dead'
      and job.attempt_count = 0
      and job.provider_outage_exhausted_at is not null
      and submission.evaluation_status = 'failed'
      and submission.automatic_retry_at is null
      and submission.automatic_retry_exhausted_at
        = job.provider_outage_exhausted_at
    from phase_12j_state state
    join app_private.async_jobs job on job.id = state.main_job_id
    join public.submissions submission on submission.id = state.main_submission_id
  ),
  'exhaustion is terminal, safe, public, and preserves the original writing'
);

select is(
  (
    select count(*)::integer
    from app_private.provider_outage_recovery_events event
    where event.job_id = (select main_job_id from phase_12j_state)
      and event.event_kind = 'exhausted'
  ),
  1,
  'outage exhaustion is recorded exactly once'
);

-- A later non-outage terminal failure closes, rather than mislabels, an
-- earlier outage epoch.
update app_private.async_jobs job
set status = 'processing',
    attempt_count = 1,
    worker_id = 'c9999999-9999-4999-8999-999999999999',
    lease_expires_at = now() + interval '5 minutes',
    last_started_at = now()
where job.id = (select generic_job_id from phase_12j_state);

select lives_ok(
  format(
    'select * from public.defer_async_job_for_provider_outage(%L,%L,%L,%L)',
    (select generic_job_id from phase_12j_state),
    (
      select job.queue_message_id
      from app_private.async_jobs job
      where job.id = (select generic_job_id from phase_12j_state)
    ),
    'c9999999-9999-4999-8999-999999999999',
    'dual_provider_outage_unavailable'
  ),
  'the second fixture starts one outage epoch'
);

update app_private.async_jobs job
set status = 'processing',
    attempt_count = job.attempt_count + 1,
    worker_id = 'c9999999-9999-4999-8999-999999999999',
    lease_expires_at = now() + interval '5 minutes',
    last_started_at = now()
where job.id = (select generic_job_id from phase_12j_state);

select lives_ok(
  format(
    'select * from public.fail_async_job(%L,%L,%L,%L,false)',
    (select generic_job_id from phase_12j_state),
    (
      select job.queue_message_id
      from app_private.async_jobs job
      where job.id = (select generic_job_id from phase_12j_state)
    ),
    'c9999999-9999-4999-8999-999999999999',
    'provider_validation_failed'
  ),
  'a later validation failure stays outside the outage lane'
);

select ok(
  (
    select job.status = 'dead'
      and job.provider_outage_exhausted_at is null
      and submission.automatic_retry_at is null
      and submission.automatic_retry_exhausted_at is null
      and exists (
        select 1
        from app_private.provider_outage_recovery_events event
        where event.job_id = job.id
          and event.event_kind = 'terminated_non_outage'
      )
    from phase_12j_state state
    join app_private.async_jobs job on job.id = state.generic_job_id
    join public.submissions submission on submission.id = state.generic_submission_id
  ),
  'a non-outage terminal result closes the audit epoch without false exhaustion'
);

-- Teacher retry creates a new version and an immutable actor/predecessor link.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c1111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c1111111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with retried as (
  select * from api.retry_writing_evaluation(
    (select main_submission_id from phase_12j_state)
  )
)
update pg_temp.phase_12j_state state
set version_two_job_id = retried.job_id
from retried
where state.singleton;

reset role;

select ok(
  (
    select version_two_job_id is not null
      and exists (
        select 1
        from app_private.provider_outage_recovery_events event
        where event.job_id = state.version_two_job_id
          and event.predecessor_job_id = state.main_job_id
          and event.event_kind = 'manual_retry'
          and event.actor_id = 'c1111111-1111-4111-8111-111111111111'
      )
    from phase_12j_state state
  ),
  'teacher retry after exhaustion records the exact actor and predecessor'
);

select ok(
  (
    select submission.evaluation_version = 2
      and submission.evaluation_status = 'queued'
      and submission.automatic_retry_at is null
      and submission.automatic_retry_exhausted_at is null
    from public.submissions submission
    where submission.id = (select main_submission_id from phase_12j_state)
  ),
  'manual retry clears the exhausted marker on the new version'
);

-- If version two later fails for a non-outage reason, version three must not
-- fabricate another manual-retry link back to exhausted version one.
select pgmq.archive(
  'writing_evaluation',
  (
    select job.queue_message_id
    from app_private.async_jobs job
    where job.id = (select version_two_job_id from phase_12j_state)
  )
);

update app_private.async_jobs job
set status = 'dead',
    dead_at = now(),
    last_error_code = 'provider_validation_failed'
where job.id = (select version_two_job_id from phase_12j_state);

select app_private.set_job_entity_state(
  'writing_evaluation',
  (select main_submission_id from phase_12j_state),
  2,
  'failed',
  'provider_validation_failed'
);

set local role authenticated;
with retried as (
  select * from api.retry_writing_evaluation(
    (select main_submission_id from phase_12j_state)
  )
)
update pg_temp.phase_12j_state state
set version_three_job_id = retried.job_id
from retried
where state.singleton;
reset role;

select ok(
  (select version_three_job_id is not null from phase_12j_state)
    and not exists (
      select 1
      from app_private.provider_outage_recovery_events event
      where event.job_id = (select version_three_job_id from phase_12j_state)
        and event.event_kind = 'manual_retry'
    ),
  'only the version directly following exhaustion receives a manual-retry event'
);

select throws_ok(
  format(
    'update app_private.provider_outage_recovery_events set reason_code=%L where job_id=%L',
    'provider_outage_recovered',
    (select main_job_id from phase_12j_state)
  ),
  '55000',
  'Adaptive-practice history is immutable.',
  'provider outage audit evidence cannot be rewritten'
);

select * from finish();
rollback;
