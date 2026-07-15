-- Phase 12V: auditable AI spend reservation reconciliation.
--
-- Provider dispatches with unknown usage are never treated as free. After the
-- reservation expiry plus a five-minute grace, recovery settles them at the
-- reserved maximum and marks that estimate explicitly. Only a locally proven
-- pre-dispatch failure or provider-documented unbilled response may use the
-- existing released state.

alter table app_private.ai_spend_reservations
  add column usage_estimated boolean not null default false;

alter table app_private.ai_spend_reservations
  add constraint ai_spend_reservations_usage_estimate_shape_check check (
    usage_estimated = coalesce((
      state = 'finalized'
      and actual_microusd = reserved_microusd
      and billed_input_tokens = 0
      and billed_output_tokens = 0
      and release_reason is null
      and finalized_at is not null
      and released_at is null
    ), false)
  );

create index ai_spend_reservations_stale_reserved_idx
on app_private.ai_spend_reservations (expires_at, id)
where state = 'reserved';

create or replace function
  app_private.reconcile_expired_ai_spend_reservations_internal(
    batch_size integer default 100,
    target_job_id uuid default null
  )
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  reconciled_count integer := 0;
begin
  if batch_size is null or batch_size not between 1 and 500 then
    raise exception using
      errcode = '22023',
      message = 'ai_spend_reconciliation_batch_invalid';
  end if;

  perform set_config('app.ai_spend_transition', 'on', true);
  with stale as materialized (
    select reservation.id
    from app_private.ai_spend_reservations reservation
    where reservation.state = 'reserved'
      and reservation.expires_at <= now() - interval '5 minutes'
      and (
        target_job_id is null
        or reservation.job_id = target_job_id
      )
    order by reservation.expires_at, reservation.id
    for update skip locked
    limit batch_size
  )
  update app_private.ai_spend_reservations reservation
  set
    state = 'finalized',
    actual_microusd = reservation.reserved_microusd,
    billed_input_tokens = 0,
    billed_output_tokens = 0,
    finalized_at = now(),
    usage_estimated = true
  from stale
  where reservation.id = stale.id
    and reservation.state = 'reserved';
  get diagnostics reconciled_count = row_count;
  perform set_config('app.ai_spend_transition', 'off', true);

  return reconciled_count;
end;
$$;

revoke all on function
  app_private.reconcile_expired_ai_spend_reservations_internal(integer, uuid)
from public, anon, authenticated, service_role;

create or replace function public.reconcile_expired_ai_spend_reservations(
  batch_size integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_service_role();
  return app_private.reconcile_expired_ai_spend_reservations_internal(
    batch_size,
    null
  );
end;
$$;

revoke all on function public.reconcile_expired_ai_spend_reservations(integer)
from public, anon, authenticated, service_role;
grant execute on function public.reconcile_expired_ai_spend_reservations(integer)
to service_role;

create or replace function api.reconcile_expired_ai_spend_reservations(
  batch_size integer default 100
)
returns integer
language sql
security invoker
set search_path = ''
as $$
  select public.reconcile_expired_ai_spend_reservations(batch_size);
$$;

revoke all on function api.reconcile_expired_ai_spend_reservations(integer)
from public, anon, authenticated;
grant execute on function api.reconcile_expired_ai_spend_reservations(integer)
to service_role;

comment on function
  app_private.reconcile_expired_ai_spend_reservations_internal(integer, uuid)
is
  'Owner/Cron recovery: terminalizes stale unknown-usage reservations at their full reserved maximum; the optional job filter exists only for isolated verification.';
comment on function api.reconcile_expired_ai_spend_reservations(integer) is
  'Service-only bounded recovery facade; unknown provider usage is charged at the reserved maximum and never released as free.';

-- Keep estimated maximums distinct from provider-metered actual usage while
-- retaining both in hard-cap committed totals.
drop function if exists api.get_ai_spend_health(uuid);
drop function if exists app_private.get_ai_spend_health(uuid);

create function app_private.get_ai_spend_health(
  target_workspace_id uuid default null
)
returns table (
  billing_month date,
  workspace_id uuid,
  finalized_actual_microusd bigint,
  estimated_maximum_microusd bigint,
  estimated_call_count bigint,
  reserved_committed_microusd bigint,
  active_reserved_count bigint,
  released_count bigint,
  oldest_reserved_age_seconds bigint,
  global_monthly_limit_microusd bigint,
  global_remaining_microusd bigint,
  workspace_monthly_limit_microusd bigint,
  workspace_remaining_microusd bigint,
  emergency_stop boolean,
  provider_model_purpose_totals jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  selected_month date := date_trunc(
    'month', timezone('UTC', now())
  )::date;
  global_policy app_private.ai_spend_global_policy%rowtype;
  selected_workspace_limit bigint;
  scope_actual bigint := 0;
  scope_estimated bigint := 0;
  scope_estimated_count bigint := 0;
  scope_reserved bigint := 0;
  scope_reserved_count bigint := 0;
  scope_released_count bigint := 0;
  scope_oldest_reserved_age bigint;
  global_committed bigint := 0;
  workspace_committed bigint;
  aggregate_totals jsonb := '[]'::jsonb;
begin
  perform app_private.assert_service_role();

  if target_workspace_id is not null
    and not exists (
      select 1
      from public.workspaces workspace
      where workspace.id = target_workspace_id
    )
  then
    raise exception using errcode = '02000', message = 'ai_spend_workspace_missing';
  end if;

  select policy.*
  into strict global_policy
  from app_private.ai_spend_global_policy policy
  where policy.singleton;

  select
    coalesce(sum(reservation.actual_microusd) filter (
      where reservation.state = 'finalized'
        and not reservation.usage_estimated
    ), 0)::bigint,
    coalesce(sum(reservation.actual_microusd) filter (
      where reservation.state = 'finalized'
        and reservation.usage_estimated
    ), 0)::bigint,
    count(*) filter (
      where reservation.state = 'finalized'
        and reservation.usage_estimated
    ),
    coalesce(sum(reservation.reserved_microusd)
      filter (where reservation.state = 'reserved'), 0)::bigint,
    count(*) filter (where reservation.state = 'reserved'),
    count(*) filter (where reservation.state = 'released'),
    extract(epoch from (
      now() - min(reservation.created_at)
        filter (where reservation.state = 'reserved')
    ))::bigint
  into
    scope_actual,
    scope_estimated,
    scope_estimated_count,
    scope_reserved,
    scope_reserved_count,
    scope_released_count,
    scope_oldest_reserved_age
  from app_private.ai_spend_reservations reservation
  where reservation.billing_month = selected_month
    and (
      target_workspace_id is null
      or reservation.workspace_id = target_workspace_id
    );

  select coalesce(sum(case
    when reservation.state = 'finalized' then reservation.actual_microusd
    when reservation.state = 'reserved' then reservation.reserved_microusd
    else 0
  end), 0)::bigint
  into global_committed
  from app_private.ai_spend_reservations reservation
  where reservation.billing_month = selected_month;

  if target_workspace_id is not null then
    select coalesce(
      (
        select budget.monthly_limit_microusd
        from app_private.ai_workspace_monthly_budgets budget
        where budget.workspace_id = target_workspace_id
          and budget.billing_month = selected_month
      ),
      global_policy.default_workspace_monthly_limit_microusd
    )
    into selected_workspace_limit;

    select coalesce(sum(case
      when reservation.state = 'finalized' then reservation.actual_microusd
      when reservation.state = 'reserved' then reservation.reserved_microusd
      else 0
    end), 0)::bigint
    into workspace_committed
    from app_private.ai_spend_reservations reservation
    where reservation.billing_month = selected_month
      and reservation.workspace_id = target_workspace_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_name', grouped.provider_name,
    'model_name', grouped.model_name,
    'call_purpose', grouped.call_purpose,
    'finalized_call_count', grouped.finalized_call_count,
    'finalized_input_tokens', grouped.finalized_input_tokens,
    'finalized_output_tokens', grouped.finalized_output_tokens,
    'finalized_actual_microusd', grouped.finalized_actual_microusd,
    'estimated_call_count', grouped.estimated_call_count,
    'estimated_maximum_microusd', grouped.estimated_maximum_microusd,
    'reserved_call_count', grouped.reserved_call_count,
    'reserved_microusd', grouped.reserved_microusd,
    'released_call_count', grouped.released_call_count
  ) order by grouped.provider_name, grouped.model_name, grouped.call_purpose),
  '[]'::jsonb)
  into aggregate_totals
  from (
    select
      reservation.provider_name,
      reservation.model_name,
      reservation.call_purpose,
      count(*) filter (
        where reservation.state = 'finalized'
          and not reservation.usage_estimated
      ) as finalized_call_count,
      coalesce(sum(reservation.billed_input_tokens) filter (
        where reservation.state = 'finalized'
          and not reservation.usage_estimated
      ), 0)::bigint as finalized_input_tokens,
      coalesce(sum(reservation.billed_output_tokens) filter (
        where reservation.state = 'finalized'
          and not reservation.usage_estimated
      ), 0)::bigint as finalized_output_tokens,
      coalesce(sum(reservation.actual_microusd) filter (
        where reservation.state = 'finalized'
          and not reservation.usage_estimated
      ), 0)::bigint as finalized_actual_microusd,
      count(*) filter (
        where reservation.state = 'finalized'
          and reservation.usage_estimated
      ) as estimated_call_count,
      coalesce(sum(reservation.actual_microusd) filter (
        where reservation.state = 'finalized'
          and reservation.usage_estimated
      ), 0)::bigint as estimated_maximum_microusd,
      count(*) filter (where reservation.state = 'reserved')
        as reserved_call_count,
      coalesce(sum(reservation.reserved_microusd)
        filter (where reservation.state = 'reserved'), 0)::bigint
        as reserved_microusd,
      count(*) filter (where reservation.state = 'released')
        as released_call_count
    from app_private.ai_spend_reservations reservation
    where reservation.billing_month = selected_month
      and (
        target_workspace_id is null
        or reservation.workspace_id = target_workspace_id
      )
    group by
      reservation.provider_name,
      reservation.model_name,
      reservation.call_purpose
  ) grouped;

  return query select
    selected_month,
    target_workspace_id,
    scope_actual,
    scope_estimated,
    scope_estimated_count,
    scope_reserved,
    scope_reserved_count,
    scope_released_count,
    scope_oldest_reserved_age,
    global_policy.monthly_limit_microusd,
    greatest(global_policy.monthly_limit_microusd - global_committed, 0),
    selected_workspace_limit,
    case when selected_workspace_limit is null then null::bigint
      else greatest(selected_workspace_limit - workspace_committed, 0)
    end,
    global_policy.emergency_stop,
    aggregate_totals;
end;
$$;

revoke all on function app_private.get_ai_spend_health(uuid)
from public, anon, authenticated, service_role;
grant execute on function app_private.get_ai_spend_health(uuid)
to service_role;

create function api.get_ai_spend_health(
  target_workspace_id uuid default null
)
returns table (
  billing_month date,
  workspace_id uuid,
  finalized_actual_microusd bigint,
  estimated_maximum_microusd bigint,
  estimated_call_count bigint,
  reserved_committed_microusd bigint,
  active_reserved_count bigint,
  released_count bigint,
  oldest_reserved_age_seconds bigint,
  global_monthly_limit_microusd bigint,
  global_remaining_microusd bigint,
  workspace_monthly_limit_microusd bigint,
  workspace_remaining_microusd bigint,
  emergency_stop boolean,
  provider_model_purpose_totals jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from app_private.get_ai_spend_health(target_workspace_id);
$$;

revoke all on function api.get_ai_spend_health(uuid)
from public, anon, authenticated;
grant execute on function api.get_ai_spend_health(uuid)
to service_role;

comment on function api.get_ai_spend_health(uuid) is
  'Service-only content-free monthly spend health with provider-metered usage, conservative maximum estimates, active reservations, and releases reported separately.';

-- Database recovery remains available even if the external recovery worker is
-- down. The command is secret-free and can safely race the Edge sweep because
-- the internal function uses row locks plus SKIP LOCKED.
create extension if not exists pg_cron;

do $migration$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'reconcile-ai-spend-reservations-every-30-seconds'
  ) then
    perform cron.unschedule(
      'reconcile-ai-spend-reservations-every-30-seconds'
    );
  end if;

  perform cron.schedule(
    'reconcile-ai-spend-reservations-every-30-seconds',
    '30 seconds',
    $command$select app_private.reconcile_expired_ai_spend_reservations_internal(100, null);$command$
  );
end;
$migration$;

comment on column app_private.ai_spend_reservations.usage_estimated is
  'True only when expired unknown provider usage was conservatively charged at the full reserved maximum.';
comment on table app_private.ai_spend_reservations is
  'Private job/version/call-scoped AI cost evidence; never student text or provider payloads. Unknown dispatched usage terminalizes as a separately reported maximum-cost estimate; only proven unbilled calls are released.';

notify pgrst, 'reload schema';
