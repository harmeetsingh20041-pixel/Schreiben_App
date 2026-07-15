begin;

-- Rollback-only shared-staging-safe verification. The fixture IDs, workspace
-- slug, batch shape, jobs, reservations, and budget override are exact and all
-- mutations disappear with this transaction.
select plan(27);

select ok(
  to_regclass('app_private.ai_canary_spend_archive') is not null
    and to_regprocedure('app_private.ai_spend_accounting_entries()') is not null
    and to_regprocedure(
      'app_private.archive_writing_live_canary_spend(uuid,text,uuid)'
    ) is not null
    and to_regprocedure(
      'public.archive_writing_live_canary_spend(uuid,text,uuid)'
    ) is not null
    and to_regprocedure(
      'api.archive_writing_live_canary_spend(uuid,text,uuid)'
    ) is not null,
  'the private detached canary-spend ledger and exact archive functions exist'
);

select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid = 'app_private.ai_canary_spend_archive'::regclass
  ),
  'the detached archive has RLS defense in depth'
);

select ok(
  not exists (
    select 1
    from unnest(array['anon', 'authenticated', 'service_role']) role_name
    where has_table_privilege(
      role_name,
      'app_private.ai_canary_spend_archive',
      'SELECT'
    )
      or has_table_privilege(
        role_name,
        'app_private.ai_canary_spend_archive',
        'INSERT'
      )
      or has_table_privilege(
        role_name,
        'app_private.ai_canary_spend_archive',
        'UPDATE'
      )
      or has_table_privilege(
        role_name,
        'app_private.ai_canary_spend_archive',
        'DELETE'
      )
  ),
  'browser and service roles have no direct archive-table privileges'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'app_private'
      and column_row.table_name = 'ai_canary_spend_archive'
      and column_row.column_name in (
        'email',
        'full_name',
        'student_id',
        'user_id',
        'original_text',
        'student_text',
        'prompt',
        'response',
        'answer_text',
        'content',
        'worksheet_content',
        'feedback_content'
      )
  )
    and not exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'app_private.ai_canary_spend_archive'::regclass
        and constraint_row.contype = 'f'
    ),
  'the detached archive contains no PII or educational content and no orphaning foreign key'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.ai_canary_spend_archive'::regclass
      and trigger_row.tgname = 'ai_canary_spend_archive_immutable'
      and not trigger_row.tgisinternal
  ),
  'the archive has an immutable update/delete guard'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.archive_writing_live_canary_spend(uuid,text,uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.archive_writing_live_canary_spend(uuid,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.archive_writing_live_canary_spend(uuid,text,uuid)',
      'EXECUTE'
    )
    and (
      select not routine.prosecdef
        and 'search_path=""' = any(routine.proconfig)
      from pg_proc routine
      where routine.oid =
        'api.archive_writing_live_canary_spend(uuid,text,uuid)'::regprocedure
    )
    and (
      select routine.prosecdef
        and 'search_path=""' = any(routine.proconfig)
      from pg_proc routine
      where routine.oid =
        'public.archive_writing_live_canary_spend(uuid,text,uuid)'::regprocedure
    )
    and not has_function_privilege(
      'service_role',
      'app_private.archive_writing_live_canary_spend(uuid,text,uuid)',
      'EXECUTE'
    ),
  'only service role can execute the invoker facade over the fixed-search-path definer boundary'
);

select ok(
  not has_function_privilege(
    'service_role',
    'app_private.ai_spend_accounting_entries()',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.ai_spend_accounting_entries()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.ai_spend_accounting_entries()',
      'EXECUTE'
    )
    and (
      select routine.provolatile = 's'
      from pg_proc routine
      where routine.oid =
        'app_private.ai_spend_accounting_entries()'::regprocedure
    ),
  'the deduplicating accounting helper is private and STABLE'
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
    'c1311111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase13b-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13B Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c1322222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase13b-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13B Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'c1300000-0000-4000-8000-000000000000',
  'V1 writing live c1300000',
  'e2e-writing-live-c1300000-0000-4000-8000-000000000000',
  'c1311111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (
  id,
  workspace_id,
  user_id,
  role
)
values
  (
    'c1333333-3333-4333-8333-333333333331',
    'c1300000-0000-4000-8000-000000000000',
    'c1311111-1111-4111-8111-111111111111',
    'teacher'
  ),
  (
    'c1333333-3333-4333-8333-333333333332',
    'c1300000-0000-4000-8000-000000000000',
    'c1322222-2222-4222-8222-222222222222',
    'student'
  );

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  feedback_mode,
  is_active,
  join_requires_approval
)
values (
  'c1344444-4444-4444-8444-444444444444',
  'c1300000-0000-4000-8000-000000000000',
  'Writing live class c1300000',
  'A1',
  'c1311111-1111-4111-8111-111111111111',
  'immediate',
  true,
  true
);

insert into public.batch_students (
  id,
  batch_id,
  student_id,
  workspace_id
)
values (
  'c1355555-5555-4555-8555-555555555555',
  'c1344444-4444-4444-8444-444444444444',
  'c1322222-2222-4222-8222-222222222222',
  'c1300000-0000-4000-8000-000000000000'
);

create temporary table phase_13b_state (
  singleton boolean primary key default true check (singleton),
  submission_id uuid,
  job_id uuid,
  finalized_reservation_id uuid,
  released_reservation_id uuid,
  metered_reservation_id uuid,
  metered_actual_microusd bigint,
  global_remaining_before bigint,
  global_remaining_after bigint
) on commit drop;
insert into pg_temp.phase_13b_state default values;
grant select, update on pg_temp.phase_13b_state
to authenticated, service_role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c1322222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'c1322222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'c1344444-4444-4444-8444-444444444444',
    'free_text',
    null,
    'Ich arbeite heute im Krankenhaus.'
  )
)
update pg_temp.phase_13b_state state
set submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;

update pg_temp.phase_13b_state state
set job_id = job.id
from app_private.async_jobs job
where job.job_kind = 'writing_evaluation'
  and job.entity_id = state.submission_id
  and job.entity_version = 1
  and state.singleton;

select app_private.capture_writing_evaluation_context(
  (select submission_id from pg_temp.phase_13b_state where singleton)
);

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $sql$
    select *
    from api.archive_writing_live_canary_spend(
      'c1300000-0000-4000-8000-000000000000',
      'e2e-writing-live-c1300000-0000-4000-8000-000000000000',
      'c1344444-4444-4444-8444-444444444444'
    )
  $sql$,
  '42501',
  'permission denied for function archive_writing_live_canary_spend',
  'an authenticated browser cannot invoke canary spend archival'
);

reset role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select *
    from api.archive_writing_live_canary_spend(
      'c1300000-0000-4000-8000-000000000000',
      'e2e-writing-live-not-the-fixture',
      'c1344444-4444-4444-8444-444444444444'
    )
  $sql$,
  '55000',
  'writing_live_canary_identity_mismatch',
  'the service RPC rejects a non-exact synthetic workspace identity'
);

select throws_ok(
  $sql$
    select *
    from api.archive_writing_live_canary_spend(
      'c1300000-0000-4000-8000-000000000000',
      'e2e-writing-live-c1300000-0000-4000-8000-000000000000',
      'c1344444-4444-4444-8444-444444444444'
    )
  $sql$,
  '55000',
  'writing_live_canary_job_active',
  'archival fails closed while a fixture job is queued'
);

reset role;

update app_private.async_jobs job
set
  status = 'processing',
  attempt_count = 1,
  worker_id = 'c1366666-6666-4666-8666-666666666666',
  lease_expires_at = now() + interval '5 minutes',
  first_started_at = now(),
  last_started_at = now()
where job.id = (
  select state.job_id from pg_temp.phase_13b_state state where state.singleton
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with reserved as (
  select *
  from api.reserve_ai_spend(
    (select job_id from pg_temp.phase_13b_state where singleton),
    1,
    'canary.estimated',
    'gemini',
    'gemini-3.1-flash-lite',
    'writing_generation',
    300000,
    900
  )
)
update pg_temp.phase_13b_state state
set finalized_reservation_id = reserved.reservation_id
from reserved
where state.singleton;

with reserved as (
  select *
  from api.reserve_ai_spend(
    (select job_id from pg_temp.phase_13b_state where singleton),
    1,
    'canary.released',
    'gemini',
    'gemini-3.1-flash-lite',
    'writing_generation',
    300000,
    900
  )
)
update pg_temp.phase_13b_state state
set released_reservation_id = reserved.reservation_id
from reserved
where state.singleton;

with reserved as (
  select *
  from api.reserve_ai_spend(
    (select job_id from pg_temp.phase_13b_state where singleton),
    1,
    'canary.metered',
    'gemini',
    'gemini-3.1-flash-lite',
    'writing_generation',
    300000,
    900
  )
)
update pg_temp.phase_13b_state state
set metered_reservation_id = reserved.reservation_id
from reserved
where state.singleton;

with finalized as (
  select *
  from api.finalize_ai_spend_reservation(
    (
      select metered_reservation_id
      from pg_temp.phase_13b_state
      where singleton
    ),
    1000,
    500
  )
)
update pg_temp.phase_13b_state state
set metered_actual_microusd = finalized.actual_microusd
from finalized
where state.singleton;

select *
from api.release_ai_spend_reservation(
  (
    select released_reservation_id
    from pg_temp.phase_13b_state
    where singleton
  ),
  'provider_not_called'
);

reset role;

update app_private.async_jobs job
set
  status = 'succeeded',
  completed_at = now(),
  worker_id = null,
  lease_expires_at = null
where job.id = (
  select state.job_id from pg_temp.phase_13b_state state where state.singleton
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select *
    from api.archive_writing_live_canary_spend(
      'c1300000-0000-4000-8000-000000000000',
      'e2e-writing-live-c1300000-0000-4000-8000-000000000000',
      'c1344444-4444-4444-8444-444444444444'
    )
  $sql$,
  '55000',
  'writing_live_canary_spend_not_terminal',
  'a terminal job cannot archive an unresolved reservation'
);

reset role;

select set_config('app.ai_spend_transition', 'on', true);
update app_private.ai_spend_reservations reservation
set
  state = 'finalized',
  actual_microusd = reservation.reserved_microusd,
  billed_input_tokens = 0,
  billed_output_tokens = 0,
  finalized_at = now(),
  usage_estimated = true
where reservation.id = (
  select finalized_reservation_id
  from pg_temp.phase_13b_state
  where singleton
);
select set_config('app.ai_spend_transition', 'off', true);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

update pg_temp.phase_13b_state state
set global_remaining_before = health.global_remaining_microusd
from api.get_ai_spend_health(null::uuid) health
where state.singleton;

reset role;

create temporary table phase_13b_archive_receipts (
  receipt_kind text primary key,
  archived_reservation_count bigint not null,
  newly_archived_count bigint not null,
  replayed boolean not null
) on commit drop;
grant select, insert on pg_temp.phase_13b_archive_receipts to service_role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $sql$
    insert into pg_temp.phase_13b_archive_receipts
    select 'first', archived.*
    from api.archive_writing_live_canary_spend(
      'c1300000-0000-4000-8000-000000000000',
      'e2e-writing-live-c1300000-0000-4000-8000-000000000000',
      'c1344444-4444-4444-8444-444444444444'
    ) archived
  $sql$,
  'terminal finalized and released spend archives atomically'
);

update pg_temp.phase_13b_state state
set global_remaining_after = health.global_remaining_microusd
from api.get_ai_spend_health(null::uuid) health
where state.singleton;

reset role;

select is(
  (
    select jsonb_build_array(
      receipt.archived_reservation_count,
      receipt.newly_archived_count,
      receipt.replayed
    )
    from pg_temp.phase_13b_archive_receipts receipt
    where receipt.receipt_kind = 'first'
  ),
  '[3,3,false]'::jsonb,
  'the first archive receipt reports every newly detached reservation'
);

select is(
  (
    select count(*)
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id =
      'c1300000-0000-4000-8000-000000000000'
  ),
  0::bigint,
  'copy-before-delete leaves no tenant-bound reservation behind'
);

select ok(
  (
    select count(*) = 3
      and count(*) filter (where archived.state = 'finalized') = 2
      and count(*) filter (where archived.state = 'released') = 1
      and coalesce(sum(archived.actual_microusd), 0) = 300000 + (
        select metered_actual_microusd
        from pg_temp.phase_13b_state
        where singleton
      )
      and count(*) filter (where archived.usage_estimated) = 1
      and count(distinct archived.original_reservation_id) = 3
      and bool_and(
        archived.archive_source = 'writing_live_canary_cleanup'
      )
    from app_private.ai_canary_spend_archive archived
    where archived.original_workspace_id =
      'c1300000-0000-4000-8000-000000000000'
  ),
  'the detached ledger preserves metered, estimated, and released terminal evidence'
);

select ok(
  (
    select count(*) = 3
      and count(*) filter (where entry.state = 'finalized') = 2
      and count(*) filter (where entry.state = 'released') = 1
      and coalesce(sum(entry.actual_microusd), 0) = 300000 + (
        select metered_actual_microusd
        from pg_temp.phase_13b_state
        where singleton
      )
      and (
        select global_remaining_before = global_remaining_after
        from pg_temp.phase_13b_state
        where singleton
      )
    from app_private.ai_spend_accounting_entries() entry
    where entry.workspace_id =
      'c1300000-0000-4000-8000-000000000000'
  ),
  'the exact-once union preserves workspace and global committed spend'
);

create temporary table phase_13b_health (
  finalized_actual_microusd bigint,
  estimated_maximum_microusd bigint,
  estimated_call_count bigint,
  reserved_committed_microusd bigint,
  active_reserved_count bigint,
  released_count bigint,
  workspace_monthly_limit_microusd bigint,
  workspace_remaining_microusd bigint,
  provider_model_purpose_totals jsonb
) on commit drop;
grant insert, select on pg_temp.phase_13b_health to service_role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

insert into pg_temp.phase_13b_health
select
  health.finalized_actual_microusd,
  health.estimated_maximum_microusd,
  health.estimated_call_count,
  health.reserved_committed_microusd,
  health.active_reserved_count,
  health.released_count,
  health.workspace_monthly_limit_microusd,
  health.workspace_remaining_microusd,
  health.provider_model_purpose_totals
from api.get_ai_spend_health(
  'c1300000-0000-4000-8000-000000000000'
) health;

reset role;

select ok(
  (
    select health.finalized_actual_microusd = state.metered_actual_microusd
      and health.estimated_maximum_microusd = 300000
      and health.estimated_call_count = 1
      and health.reserved_committed_microusd = 0
      and health.active_reserved_count = 0
      and health.released_count = 1
      and health.workspace_monthly_limit_microusd
        - health.workspace_remaining_microusd =
          300000 + state.metered_actual_microusd
    from pg_temp.phase_13b_health health
    cross join pg_temp.phase_13b_state state
    where state.singleton
  ),
  'workspace spend health retains archived metered, estimated, released, and committed cost'
);

select ok(
  (
    select provider_total ->> 'provider_name' = 'gemini'
      and provider_total ->> 'model_name' = 'gemini-3.1-flash-lite'
      and provider_total ->> 'call_purpose' = 'writing_generation'
      and (provider_total ->> 'finalized_call_count')::bigint = 1
      and (provider_total ->> 'finalized_input_tokens')::bigint = 1000
      and (provider_total ->> 'finalized_output_tokens')::bigint = 500
      and (provider_total ->> 'finalized_actual_microusd')::bigint =
        state.metered_actual_microusd
      and (provider_total ->> 'estimated_call_count')::bigint = 1
      and (provider_total ->> 'estimated_maximum_microusd')::bigint = 300000
      and (provider_total ->> 'released_call_count')::bigint = 1
    from pg_temp.phase_13b_health health
    cross join pg_temp.phase_13b_state state
    cross join lateral jsonb_array_elements(
      health.provider_model_purpose_totals
    ) provider_total
    where state.singleton
      and provider_total ->> 'provider_name' = 'gemini'
      and provider_total ->> 'model_name' = 'gemini-3.1-flash-lite'
      and provider_total ->> 'call_purpose' = 'writing_generation'
  ),
  'provider reporting preserves archived metered tokens, estimates, and releases'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $sql$
    insert into pg_temp.phase_13b_archive_receipts
    select 'replay', archived.*
    from api.archive_writing_live_canary_spend(
      'c1300000-0000-4000-8000-000000000000',
      'e2e-writing-live-c1300000-0000-4000-8000-000000000000',
      'c1344444-4444-4444-8444-444444444444'
    ) archived
  $sql$,
  'an exact replay before workspace deletion is harmless'
);

reset role;

select is(
  (
    select jsonb_build_array(
      receipt.archived_reservation_count,
      receipt.newly_archived_count,
      receipt.replayed
    )
    from pg_temp.phase_13b_archive_receipts receipt
    where receipt.receipt_kind = 'replay'
  ),
  '[3,0,true]'::jsonb,
  'the replay receipt is explicit and copies no row twice'
);

select is(
  (
    select count(*)
    from app_private.ai_canary_spend_archive archived
    where archived.original_workspace_id =
      'c1300000-0000-4000-8000-000000000000'
  ),
  3::bigint,
  'replay leaves the archive cardinality unchanged'
);

select throws_ok(
  $sql$
    update app_private.ai_canary_spend_archive
    set archived_at = archived_at + interval '1 second'
    where original_workspace_id =
      'c1300000-0000-4000-8000-000000000000'
  $sql$,
  '55000',
  'ai_canary_spend_archive_immutable',
  'archived accounting evidence cannot be updated'
);

select throws_ok(
  $sql$
    delete from app_private.ai_canary_spend_archive
    where original_workspace_id =
      'c1300000-0000-4000-8000-000000000000'
  $sql$,
  '55000',
  'ai_canary_spend_archive_immutable',
  'archived accounting evidence cannot be deleted'
);

select ok(
  (
    select pg_get_functiondef(
      'app_private.reserve_ai_spend(uuid,integer,text,text,text,text,bigint,integer)'::regprocedure
    ) like '%app_private.ai_spend_accounting_entries()%'
  )
    and (
      select pg_get_functiondef(
        'app_private.get_ai_spend_health(uuid)'::regprocedure
      ) like '%app_private.ai_spend_accounting_entries()%'
    )
    and (
      select pg_get_functiondef(
        'app_private.archive_writing_live_canary_spend(uuid,text,uuid)'::regprocedure
      ) like '%pg_advisory_xact_lock%'
        and pg_get_functiondef(
          'app_private.archive_writing_live_canary_spend(uuid,text,uuid)'::regprocedure
        ) like '%paid-job-entity%'
    ),
  'accounting uses the exact-once union and archival serializes with job enqueue'
);

update app_private.ai_workspace_monthly_budgets budget
set monthly_limit_microusd = 1000000
where budget.workspace_id = 'c1300000-0000-4000-8000-000000000000'
  and budget.billing_month = date_trunc('month', timezone('UTC', now()))::date;

update public.submissions submission
set evaluation_version = 2
where submission.id = (
  select submission_id from pg_temp.phase_13b_state where singleton
);

insert into app_private.async_jobs (
  id,
  queue_name,
  job_kind,
  entity_id,
  entity_version,
  idempotency_key,
  status,
  attempt_count,
  worker_id,
  lease_expires_at,
  first_started_at,
  last_started_at
)
values (
  'c1388888-8888-4888-8888-888888888888',
  'writing_evaluation',
  'writing_evaluation',
  (select submission_id from pg_temp.phase_13b_state where singleton),
  2,
  'phase13b-budget-proof',
  'processing',
  1,
  'c1366666-6666-4666-8666-666666666666',
  now() + interval '5 minutes',
  now(),
  now()
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $sql$
    select * from api.reserve_ai_spend(
      'c1388888-8888-4888-8888-888888888888',
      2, 'budget.one', 'gemini', 'gemini-3.1-flash-lite',
      'writing_generation', 300000, 900
    )
  $sql$,
  'the first post-archive reservation fits beside detached spend'
);

select lives_ok(
  $sql$
    select * from api.reserve_ai_spend(
      'c1388888-8888-4888-8888-888888888888',
      2, 'budget.two', 'gemini', 'gemini-3.1-flash-lite',
      'writing_generation', 300000, 900
    )
  $sql$,
  'the second post-archive reservation reaches 900000 committed microusd'
);

select throws_ok(
  $sql$
    select * from api.reserve_ai_spend(
      'c1388888-8888-4888-8888-888888888888',
      2, 'budget.three', 'gemini', 'gemini-3.1-flash-lite',
      'writing_generation', 300000, 900
    )
  $sql$,
  '53000',
  'ai_spend_workspace_budget_exceeded',
  'archived finalized spend still blocks a hard-cap overrun'
);

reset role;

select * from finish();
rollback;
