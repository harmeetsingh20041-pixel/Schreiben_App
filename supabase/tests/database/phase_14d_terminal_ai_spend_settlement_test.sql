begin;

-- Rollback-only regression. Exact fixture IDs and session-local trigger
-- suppression create pre-fix reservation states without provider calls, queue
-- work, student content, or durable shared-staging mutations.
select plan(12);

select ok(
  to_regprocedure(
    'app_private.finalize_terminal_ai_spend_reservations_internal(uuid)'
  ) is not null
    and to_regprocedure(
      'app_private.finalize_ai_spend_on_job_terminal()'
    ) is not null
    and not has_function_privilege(
      'service_role',
      'app_private.finalize_terminal_ai_spend_reservations_internal(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.finalize_terminal_ai_spend_reservations_internal(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.finalize_terminal_ai_spend_reservations_internal(uuid)',
      'EXECUTE'
    )
    and (
      select count(*) = 1
        and bool_and(not trigger.tgisinternal)
        and bool_and(
          pg_get_triggerdef(trigger.oid) ilike
            '%after update of status on app_private.async_jobs%'
        )
      from pg_trigger trigger
      where trigger.tgname = 'async_jobs_finalize_terminal_ai_spend'
        and trigger.tgrelid = 'app_private.async_jobs'::regclass
    ),
  'terminal settlement is a private exact-status trigger boundary'
);

-- Keep every reservation foreign key valid when the terminal trigger updates
-- it. Auth insertion creates the matching rollback-scoped profile rows through
-- the ordinary application trigger; no existing staging identity is reused.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '14d50000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated',
    'phase14d-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14D Student"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '14d60000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated',
    'phase14d-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14D Owner"}'::jsonb,
    now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  '14d40000-0000-4000-8000-000000000001',
  'Phase 14D Terminal Spend',
  'phase-14d-terminal-spend',
  '14d60000-0000-4000-8000-000000000001'
);

-- Seed exact job and spend shapes while ordinary triggers are suppressed. The
-- transaction rollback guarantees no fixture survives even on shared staging.
set local session_replication_role = replica;

insert into app_private.async_jobs (
  id, queue_name, job_kind, entity_id, entity_version, idempotency_key,
  status, attempt_count, completed_at, dead_at
)
values
  (
    '14d10000-0000-4000-8000-000000000001',
    'writing_evaluation', 'writing_evaluation',
    '14d20000-0000-4000-8000-000000000001', 1,
    'phase14d:terminal:succeeded', 'processing', 1, null, null
  ),
  (
    '14d10000-0000-4000-8000-000000000002',
    'writing_evaluation', 'writing_evaluation',
    '14d20000-0000-4000-8000-000000000002', 1,
    'phase14d:terminal:dead', 'processing', 1, null, null
  ),
  (
    '14d10000-0000-4000-8000-000000000003',
    'writing_evaluation', 'writing_evaluation',
    '14d20000-0000-4000-8000-000000000003', 1,
    'phase14d:active:retry', 'retry', 1, null, null
  ),
  (
    '14d10000-0000-4000-8000-000000000004',
    'writing_evaluation', 'writing_evaluation',
    '14d20000-0000-4000-8000-000000000004', 1,
    'phase14d:backfill:succeeded', 'succeeded', 1, now(), null
  );

insert into app_private.ai_spend_reservations (
  id, job_id, entity_version, call_key, workspace_id, student_id,
  billing_month, provider_name, model_name, call_purpose,
  cached_input_rate_microusd_per_million,
  input_rate_microusd_per_million,
  output_rate_microusd_per_million,
  reserved_microusd, state, actual_microusd,
  billed_input_tokens, billed_output_tokens,
  billed_cached_input_tokens, billed_uncached_input_tokens,
  cache_metadata_present, release_reason, usage_estimated,
  expires_at, finalized_at, released_at
)
values
  (
    '14d30000-0000-4000-8000-000000000001',
    '14d10000-0000-4000-8000-000000000001', 1,
    'attempt_1:phase14d:succeeded:unknown',
    '14d40000-0000-4000-8000-000000000001',
    '14d50000-0000-4000-8000-000000000001',
    date_trunc('month', timezone('UTC', now()))::date,
    'gemini', 'gemini-3.1-flash-lite', 'writing_generation',
    1500000, 1500000, 9000000, 300000,
    'reserved', null, null, null, null, null, null, null, false,
    now() + interval '15 minutes', null, null
  ),
  (
    '14d30000-0000-4000-8000-000000000002',
    '14d10000-0000-4000-8000-000000000002', 1,
    'attempt_1:phase14d:dead:unknown',
    '14d40000-0000-4000-8000-000000000001',
    '14d50000-0000-4000-8000-000000000001',
    date_trunc('month', timezone('UTC', now()))::date,
    'deepseek', 'deepseek-v4-pro', 'writing_generation',
    3625, 14500, 16000, 100000,
    'reserved', null, null, null, null, null, null, null, false,
    now() + interval '15 minutes', null, null
  ),
  (
    '14d30000-0000-4000-8000-000000000003',
    '14d10000-0000-4000-8000-000000000003', 1,
    'attempt_1:phase14d:active:unknown',
    '14d40000-0000-4000-8000-000000000001',
    '14d50000-0000-4000-8000-000000000001',
    date_trunc('month', timezone('UTC', now()))::date,
    'gemini', 'gemini-3.1-flash-lite', 'writing_generation',
    1500000, 1500000, 9000000, 300000,
    'reserved', null, null, null, null, null, null, null, false,
    now() + interval '15 minutes', null, null
  ),
  (
    '14d30000-0000-4000-8000-000000000004',
    '14d10000-0000-4000-8000-000000000004', 1,
    'attempt_1:phase14d:backfill:unknown',
    '14d40000-0000-4000-8000-000000000001',
    '14d50000-0000-4000-8000-000000000001',
    date_trunc('month', timezone('UTC', now()))::date,
    'gemini', 'gemini-3.1-flash-lite', 'writing_generation',
    1500000, 1500000, 9000000, 200000,
    'reserved', null, null, null, null, null, null, null, false,
    now() + interval '15 minutes', null, null
  ),
  (
    '14d30000-0000-4000-8000-000000000005',
    '14d10000-0000-4000-8000-000000000004', 1,
    'attempt_1:phase14d:backfill:metered',
    '14d40000-0000-4000-8000-000000000001',
    '14d50000-0000-4000-8000-000000000001',
    date_trunc('month', timezone('UTC', now()))::date,
    'deepseek', 'deepseek-v4-flash', 'writing_critique',
    2800, 140000, 280000, 50000,
    'finalized', 420, 1000, 1000, 0, 1000, false, null, false,
    now() + interval '15 minutes', now(), null
  ),
  (
    '14d30000-0000-4000-8000-000000000006',
    '14d10000-0000-4000-8000-000000000004', 1,
    'attempt_1:phase14d:backfill:unbilled',
    '14d40000-0000-4000-8000-000000000001',
    '14d50000-0000-4000-8000-000000000001',
    date_trunc('month', timezone('UTC', now()))::date,
    'deepseek', 'deepseek-v4-flash', 'writing_critique',
    2800, 140000, 280000, 50000,
    'released', null, null, null, null, null, null,
    'provider_not_called', false,
    now() + interval '15 minutes', null, now()
  );

set local session_replication_role = origin;

select lives_ok(
  $sql$
    update app_private.async_jobs
    set status = 'succeeded', completed_at = now()
    where id = '14d10000-0000-4000-8000-000000000001'
  $sql$,
  'a succeeded transition atomically settles unknown spend'
);

select ok(
  exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.id = '14d30000-0000-4000-8000-000000000001'
      and reservation.state = 'finalized'
      and reservation.actual_microusd = reservation.reserved_microusd
      and reservation.billed_input_tokens = 0
      and reservation.billed_output_tokens = 0
      and reservation.billed_cached_input_tokens = 0
      and reservation.billed_uncached_input_tokens = 0
      and not reservation.cache_metadata_present
      and reservation.usage_estimated
      and reservation.release_reason is null
      and reservation.finalized_at is not null
      and reservation.released_at is null
  ),
  'succeeded unknown usage is estimated at its maximum and never released'
);

select lives_ok(
  $sql$
    update app_private.async_jobs
    set status = 'dead', dead_at = now(), last_error_code = 'phase14d_failure'
    where id = '14d10000-0000-4000-8000-000000000002'
  $sql$,
  'a dead transition atomically settles unknown spend'
);

select ok(
  exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.id = '14d30000-0000-4000-8000-000000000002'
      and reservation.state = 'finalized'
      and reservation.actual_microusd = 100000
      and reservation.usage_estimated
      and reservation.release_reason is null
  ),
  'dead unknown usage is conservatively charged rather than released'
);

select is(
  app_private.finalize_terminal_ai_spend_reservations_internal(
    '14d10000-0000-4000-8000-000000000004'
  ),
  1,
  'the owner-only helper backfills one pre-existing terminal reservation'
);

select ok(
  exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.id = '14d30000-0000-4000-8000-000000000004'
      and reservation.state = 'finalized'
      and reservation.actual_microusd = 200000
      and reservation.usage_estimated
  ),
  'terminal backfill uses the same conservative estimated evidence shape'
);

select ok(
  exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.id = '14d30000-0000-4000-8000-000000000005'
      and reservation.state = 'finalized'
      and reservation.actual_microusd = 420
      and not reservation.usage_estimated
  )
    and exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.id = '14d30000-0000-4000-8000-000000000006'
        and reservation.state = 'released'
        and reservation.release_reason = 'provider_not_called'
    ),
  'known metered and proven-unbilled evidence remains unchanged'
);

select is(
  app_private.finalize_terminal_ai_spend_reservations_internal(
    '14d10000-0000-4000-8000-000000000003'
  ),
  0,
  'the helper refuses to settle an active retry job'
);

select ok(
  exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.id = '14d30000-0000-4000-8000-000000000003'
      and reservation.state = 'reserved'
      and not reservation.usage_estimated
  ),
  'active-job reservation state remains untouched'
);

select is(
  app_private.finalize_terminal_ai_spend_reservations_internal(
    '14d10000-0000-4000-8000-000000000004'
  ),
  0,
  'terminal settlement is idempotent after all rows are settled'
);

select ok(
  (
    select count(*) = 1
      and bool_and(job.schedule = '30 seconds')
      and bool_and(
        job.command =
          'select app_private.reconcile_expired_ai_spend_reservations_internal(100, null);'
      )
      and bool_and(job.active)
    from cron.job job
    where job.jobname =
      'reconcile-ai-spend-reservations-every-30-seconds'
  ),
  'the existing expiry-based recovery Cron remains active and unchanged'
);

select * from finish(true);
rollback;
