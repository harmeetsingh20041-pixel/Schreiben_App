begin;

-- Rollback-only shared-staging-safe test. Every job transition, reservation,
-- and successful reconciliation is constrained to the exact fixture job ID;
-- the global facade is checked only through catalog privileges and a denied
-- student call. Unknown usage remains conservatively charged until an
-- auditable maximum-cost estimate replaces the stale reservation. Only an
-- explicitly unbilled call releases.
select plan(18);

select ok(
  to_regprocedure('api.reconcile_expired_ai_spend_reservations(integer)')
      is not null
    and has_function_privilege(
      'service_role',
      'api.reconcile_expired_ai_spend_reservations(integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.reconcile_expired_ai_spend_reservations(integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.reconcile_expired_ai_spend_reservations(integer)',
      'EXECUTE'
    )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'api.reconcile_expired_ai_spend_reservations(integer)'::regprocedure
    )
    and (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'public.reconcile_expired_ai_spend_reservations(integer)'::regprocedure
    )
    and (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'app_private.reconcile_expired_ai_spend_reservations_internal(integer,uuid)'::regprocedure
    ),
  'service-only invoker facade fronts private definer reconciliation'
);

select ok(
  (
    select count(*) = 1
      and bool_and(job.schedule = '30 seconds')
      and bool_and(
        job.command =
          'select app_private.reconcile_expired_ai_spend_reservations_internal(100, null);'
      )
      and bool_and(job.command not ilike '%http%')
    from cron.job job
    where job.jobname =
      'reconcile-ai-spend-reservations-every-30-seconds'
  ),
  'the exact secret-free 30-second reconciliation Cron is installed once'
);

select throws_ok(
  $$select app_private.reconcile_expired_ai_spend_reservations_internal(0, null)$$,
  '22023',
  'ai_spend_reconciliation_batch_invalid',
  'reconciliation rejects an unbounded or empty batch'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'f2111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12v-teacher@example.test', '',
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12V Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'f2222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12v-student@example.test', '',
    now(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12V Student"}'::jsonb, now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'f2333333-3333-4333-8333-333333333333',
  'Phase 12V Workspace', 'phase-12v-workspace',
  'f2111111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'f2333333-3333-4333-8333-333333333333',
    'f2111111-1111-4111-8111-111111111111', 'teacher'
  ),
  (
    'f2333333-3333-4333-8333-333333333333',
    'f2222222-2222-4222-8222-222222222222', 'student'
  );

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode
)
values (
  'f2444444-4444-4444-8444-444444444444',
  'f2333333-3333-4333-8333-333333333333',
  'Phase 12V Immediate A2', 'A2', true, 'immediate'
);

insert into public.batch_students (
  id, batch_id, student_id, workspace_id
)
values (
  'f2555555-5555-4555-8555-555555555555',
  'f2444444-4444-4444-8444-444444444444',
  'f2222222-2222-4222-8222-222222222222',
  'f2333333-3333-4333-8333-333333333333'
);

create temporary table phase_12v_state (
  singleton boolean primary key default true check (singleton),
  submission_id uuid,
  job_id uuid,
  predispatch_reservation_id uuid,
  fourth_reservation_id uuid
) on commit drop;

insert into phase_12v_state default values;
grant select, update on phase_12v_state to authenticated, service_role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f2222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'f2222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'f2444444-4444-4444-8444-444444444444',
    'free_text', null, 'Das ist richtig.'
  )
)
update pg_temp.phase_12v_state state
set submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;
update pg_temp.phase_12v_state state
set job_id = job.id
from app_private.async_jobs job
where job.job_kind = 'writing_evaluation'
  and job.entity_id = state.submission_id
  and job.entity_version = 1
  and state.singleton;

update app_private.async_jobs job
set
  status = 'processing',
  attempt_count = 1,
  worker_id = 'f2666666-6666-4666-8666-666666666666',
  first_started_at = now(),
  last_started_at = now(),
  lease_expires_at = now() + interval '5 minutes'
where job.id = (
  select job_id from pg_temp.phase_12v_state where singleton
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $sql$
    select * from api.reserve_ai_spend(
      (select job_id from phase_12v_state where singleton),
      1, 'attempt_1:writing:stale', 'gemini', 'gemini-3.1-flash-lite',
      'writing_generation', 300000, 60
    )
  $sql$,
  'the first unknown-usage call reserves its maximum cost'
);

reset role;

update app_private.ai_workspace_monthly_budgets budget
set monthly_limit_microusd = 1000000
where budget.workspace_id = 'f2333333-3333-4333-8333-333333333333'
  and budget.billing_month = date_trunc('month', timezone('UTC', now()))::date;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $sql$
    select * from api.reserve_ai_spend(
      (select job_id from phase_12v_state where singleton),
      1, 'attempt_1:writing:stale-second', 'gemini', 'gemini-3.1-flash-lite',
      'writing_generation', 300000, 60
    )
  $sql$,
  'a second unknown-usage call reserves conservatively'
);

select lives_ok(
  $sql$
    with reserved as (
      select * from api.reserve_ai_spend(
        (select job_id from phase_12v_state where singleton),
        1, 'attempt_1:writing:predispatch', 'gemini', 'gemini-3.1-flash-lite',
        'writing_generation', 300000, 60
      )
    )
    update pg_temp.phase_12v_state state
    set predispatch_reservation_id = reserved.reservation_id
    from reserved
    where state.singleton
  $sql$,
  'a fresh pre-dispatch reservation also remains committed'
);

reset role;

select set_config('app.ai_spend_transition', 'on', true);
update app_private.ai_spend_reservations reservation
set expires_at = case reservation.call_key
  when 'attempt_1:writing:stale' then now() - interval '7 minutes'
  when 'attempt_1:writing:stale-second' then now() - interval '6 minutes'
  else reservation.expires_at
end
where reservation.job_id = (
  select job_id from phase_12v_state where singleton
);
select set_config('app.ai_spend_transition', 'off', true);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select * from api.reserve_ai_spend(
      (select job_id from phase_12v_state where singleton),
      1, 'attempt_1:writing:blocked', 'gemini', 'gemini-3.1-flash-lite',
      'writing_generation', 300000, 60
    )
  $sql$,
  '53000',
  'ai_spend_workspace_budget_exceeded',
  'an expired but unreconciled reservation still blocks later budget'
);

reset role;

select is(
  app_private.reconcile_expired_ai_spend_reservations_internal(
    1,
    (select job_id from pg_temp.phase_12v_state where singleton)
  ),
  1,
  'the bounded fixture sweep transitions only the oldest stale row'
);

select ok(
  exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.job_id = (
      select job_id from phase_12v_state where singleton
    )
      and reservation.call_key = 'attempt_1:writing:stale'
      and reservation.state = 'finalized'
      and reservation.actual_microusd = reservation.reserved_microusd
      and reservation.billed_input_tokens = 0
      and reservation.billed_output_tokens = 0
      and reservation.usage_estimated
      and reservation.release_reason is null
      and reservation.finalized_at is not null
  )
    and exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = (
        select job_id from phase_12v_state where singleton
      )
        and reservation.call_key = 'attempt_1:writing:stale-second'
        and reservation.state = 'reserved'
    )
    and exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = (
        select job_id from phase_12v_state where singleton
      )
        and reservation.call_key = 'attempt_1:writing:predispatch'
        and reservation.state = 'reserved'
    ),
  'batch one estimates exactly one row and preserves the remaining rows'
);

select is(
  app_private.reconcile_expired_ai_spend_reservations_internal(
    1,
    (select job_id from pg_temp.phase_12v_state where singleton)
  ),
  1,
  'a repeated bounded batch drains the second stale reservation'
);

select throws_ok(
  $sql$
    update app_private.ai_spend_reservations reservation
    set actual_microusd = 1
    where reservation.job_id = (
      select job_id from pg_temp.phase_12v_state where singleton
    )
      and reservation.usage_estimated
  $sql$,
  '55000',
  'ai_spend_evidence_immutable',
  'estimated settlement evidence remains immutable'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select * from api.reserve_ai_spend(
      (select job_id from phase_12v_state where singleton),
      1, 'attempt_1:writing:still-blocked', 'gemini', 'gemini-3.1-flash-lite',
      'writing_generation', 300000, 60
    )
  $sql$,
  '53000',
  'ai_spend_workspace_budget_exceeded',
  'unknown dispatched usage stays conservatively counted after reconciliation'
);

select lives_ok(
  $sql$
    select * from api.release_ai_spend_reservation(
      (
        select predispatch_reservation_id
        from phase_12v_state
        where singleton
      ),
      'provider_not_called'
    )
  $sql$,
  'a provably pre-dispatch call can be released explicitly'
);

select lives_ok(
  $sql$
    with reserved as (
      select * from api.reserve_ai_spend(
        (select job_id from phase_12v_state where singleton),
        1, 'attempt_1:writing:blocked', 'gemini', 'gemini-3.1-flash-lite',
        'writing_generation', 300000, 60
      )
    )
    update pg_temp.phase_12v_state state
    set fourth_reservation_id = reserved.reservation_id
    from reserved
    where state.singleton
  $sql$,
  'the explicit unbilled transition frees budget for a later call'
);

select lives_ok(
  $sql$
    select * from api.finalize_ai_spend_reservation(
      (select fourth_reservation_id from phase_12v_state where singleton),
      100,
      50
    )
  $sql$,
  'known provider usage still finalizes normally'
);

reset role;

select is(
  app_private.reconcile_expired_ai_spend_reservations_internal(
    100,
    (select job_id from pg_temp.phase_12v_state where singleton)
  ),
  0,
  'reconciliation is idempotent while no additional row is stale'
);

select ok(
  exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.id = (
      select fourth_reservation_id from phase_12v_state where singleton
    )
      and reservation.state = 'finalized'
      and reservation.actual_microusd is not null
      and not reservation.usage_estimated
      and reservation.release_reason is null
  )
    and exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.id = (
        select predispatch_reservation_id
        from phase_12v_state
        where singleton
      )
        and reservation.state = 'released'
        and reservation.release_reason = 'provider_not_called'
    )
    and (
      select count(*)
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = (
        select job_id from phase_12v_state where singleton
      )
        and reservation.state = 'reserved'
    ) = 0
    and not exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.job_id = (
        select job_id from phase_12v_state where singleton
      )
        and reservation.state = 'reserved'
        and reservation.expires_at <= now() - interval '5 minutes'
    ),
  'metered and estimated usage stay counted with no stale reservation left active'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f2222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $sql$
    select api.reconcile_expired_ai_spend_reservations(100)
  $sql$,
  '42501',
  'permission denied for function reconcile_expired_ai_spend_reservations',
  'students cannot invoke spend reconciliation'
);

select * from finish(true);
rollback;
