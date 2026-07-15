-- Phase 13X: cohort-aware AI fair-share admission and invoice-accurate cache
-- accounting.
--
-- The provider order is unchanged. This migration only narrows whether a
-- service worker may dispatch a paid call and how a completed call is priced.
-- All new evidence is content-free: opaque job/student/workspace identifiers,
-- token counters, rates, and money only.

-- ---------------------------------------------------------------------------
-- Audited EUR-per-active-student policy and bounded FX evidence.
-- ---------------------------------------------------------------------------

alter table app_private.ai_spend_global_policy
  add column operating_target_microeur_per_active_student_month bigint
    not null default 1000000,
  add column fair_share_reserve_basis_points integer not null default 1000,
  add column usd_to_eur_microrate bigint not null default 920000,
  add column stale_exchange_rate_fallback_microrate bigint
    not null default 1500000,
  add column exchange_rate_verified_at date not null default date '2026-07-11',
  add column exchange_rate_source text not null default
    'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A',
  add column maximum_exchange_rate_age_days smallint not null default 7,
  add constraint ai_spend_global_policy_operating_target_check check (
    operating_target_microeur_per_active_student_month between 100000 and 2000000
  ),
  add constraint ai_spend_global_policy_reserve_check check (
    fair_share_reserve_basis_points between 0 and 1500
  ),
  add constraint ai_spend_global_policy_fx_rate_check check (
    usd_to_eur_microrate between 500000 and 1500000
  ),
  add constraint ai_spend_global_policy_stale_fx_fallback_check check (
    stale_exchange_rate_fallback_microrate = 1500000
  ),
  add constraint ai_spend_global_policy_fx_source_check check (
    exchange_rate_source =
      'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A'
  ),
  add constraint ai_spend_global_policy_fx_age_check check (
    maximum_exchange_rate_age_days between 1 and 14
  );

alter table app_private.ai_budget_change_audit
  add column old_operating_target_microeur bigint,
  add column new_operating_target_microeur bigint,
  add column old_fair_share_reserve_basis_points integer,
  add column new_fair_share_reserve_basis_points integer,
  add column old_usd_to_eur_microrate bigint,
  add column new_usd_to_eur_microrate bigint,
  add column old_stale_exchange_rate_fallback_microrate bigint,
  add column new_stale_exchange_rate_fallback_microrate bigint,
  add column old_exchange_rate_verified_at date,
  add column new_exchange_rate_verified_at date,
  add column old_exchange_rate_source text,
  add column new_exchange_rate_source text,
  add column old_maximum_exchange_rate_age_days smallint,
  add column new_maximum_exchange_rate_age_days smallint;

create or replace function app_private.audit_ai_budget_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('app.ai_spend_transition', 'on', true);
  if tg_table_name = 'ai_spend_global_policy' then
    insert into app_private.ai_budget_change_audit (
      scope,
      old_monthly_limit_microusd,
      new_monthly_limit_microusd,
      old_default_workspace_limit_microusd,
      new_default_workspace_limit_microusd,
      old_emergency_stop,
      new_emergency_stop,
      old_operating_target_microeur,
      new_operating_target_microeur,
      old_fair_share_reserve_basis_points,
      new_fair_share_reserve_basis_points,
      old_usd_to_eur_microrate,
      new_usd_to_eur_microrate,
      old_stale_exchange_rate_fallback_microrate,
      new_stale_exchange_rate_fallback_microrate,
      old_exchange_rate_verified_at,
      new_exchange_rate_verified_at,
      old_exchange_rate_source,
      new_exchange_rate_source,
      old_maximum_exchange_rate_age_days,
      new_maximum_exchange_rate_age_days,
      new_revision,
      changed_by_user_id,
      changed_by_database_role
    ) values (
      'global',
      case when tg_op = 'UPDATE' then old.monthly_limit_microusd else null end,
      new.monthly_limit_microusd,
      case when tg_op = 'UPDATE'
        then old.default_workspace_monthly_limit_microusd else null end,
      new.default_workspace_monthly_limit_microusd,
      case when tg_op = 'UPDATE' then old.emergency_stop else null end,
      new.emergency_stop,
      case when tg_op = 'UPDATE'
        then old.operating_target_microeur_per_active_student_month else null end,
      new.operating_target_microeur_per_active_student_month,
      case when tg_op = 'UPDATE'
        then old.fair_share_reserve_basis_points else null end,
      new.fair_share_reserve_basis_points,
      case when tg_op = 'UPDATE' then old.usd_to_eur_microrate else null end,
      new.usd_to_eur_microrate,
      case when tg_op = 'UPDATE'
        then old.stale_exchange_rate_fallback_microrate else null end,
      new.stale_exchange_rate_fallback_microrate,
      case when tg_op = 'UPDATE' then old.exchange_rate_verified_at else null end,
      new.exchange_rate_verified_at,
      case when tg_op = 'UPDATE' then old.exchange_rate_source else null end,
      new.exchange_rate_source,
      case when tg_op = 'UPDATE'
        then old.maximum_exchange_rate_age_days else null end,
      new.maximum_exchange_rate_age_days,
      new.revision,
      (select auth.uid()),
      session_user
    );
  else
    insert into app_private.ai_budget_change_audit (
      scope,
      workspace_id,
      billing_month,
      old_monthly_limit_microusd,
      new_monthly_limit_microusd,
      new_revision,
      changed_by_user_id,
      changed_by_database_role
    ) values (
      'workspace',
      new.workspace_id,
      new.billing_month,
      case when tg_op = 'UPDATE' then old.monthly_limit_microusd else null end,
      new.monthly_limit_microusd,
      new.revision,
      (select auth.uid()),
      session_user
    );
  end if;
  perform set_config('app.ai_spend_transition', 'off', true);
  return new;
end;
$$;

revoke all on function app_private.audit_ai_budget_change()
from public, anon, authenticated, service_role;

create or replace function app_private.ai_fair_share_limit_microusd(
  target_microeur bigint,
  reserve_basis_points integer,
  usd_to_eur_microrate bigint
)
returns bigint
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select floor(
    (
      target_microeur::numeric *
      (10000 + reserve_basis_points)::numeric *
      1000000::numeric
    ) /
    (10000::numeric * usd_to_eur_microrate::numeric)
  )::bigint;
$$;

revoke all on function app_private.ai_fair_share_limit_microusd(
  bigint, integer, bigint
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cache-hit/miss rates and immutable reservation evidence.
-- ---------------------------------------------------------------------------

alter table app_private.ai_model_cost_policies
  add column cached_input_rate_microusd_per_million bigint;

drop trigger ai_model_cost_policies_immutable
on app_private.ai_model_cost_policies;

update app_private.ai_model_cost_policies policy
set cached_input_rate_microusd_per_million = case
  when policy.provider_name = 'deepseek'
    and policy.model_name = 'deepseek-v4-flash' then 2800
  when policy.provider_name = 'deepseek'
    and policy.model_name = 'deepseek-v4-pro' then 3625
  else policy.input_rate_microusd_per_million
end;

create trigger ai_model_cost_policies_immutable
before insert or update or delete on app_private.ai_model_cost_policies
for each row execute function app_private.reject_ai_spend_evidence_mutation();

alter table app_private.ai_model_cost_policies
  alter column cached_input_rate_microusd_per_million set not null,
  add constraint ai_model_cost_policies_cached_input_rate_check check (
    cached_input_rate_microusd_per_million between 1 and 100000000
  );

alter table app_private.ai_spend_reservations
  add column student_id uuid,
  add column cached_input_rate_microusd_per_million bigint,
  add column billed_cached_input_tokens bigint,
  add column billed_uncached_input_tokens bigint,
  add column cache_metadata_present boolean;

select set_config('app.ai_spend_transition', 'on', true);
update app_private.ai_spend_reservations reservation
set
  student_id = coalesce(
    submission.student_id,
    generation_assignment.student_id,
    attempt.student_id
  ),
  cached_input_rate_microusd_per_million = case
    when reservation.provider_name = 'deepseek'
      and reservation.model_name = 'deepseek-v4-flash' then 2800
    when reservation.provider_name = 'deepseek'
      and reservation.model_name = 'deepseek-v4-pro' then 3625
    else reservation.input_rate_microusd_per_million
  end,
  billed_cached_input_tokens = case
    when reservation.state = 'finalized' then 0 else null end,
  billed_uncached_input_tokens = case
    when reservation.state = 'finalized' then reservation.billed_input_tokens
    else null
  end,
  cache_metadata_present = case
    when reservation.state = 'finalized' then false else null end
from app_private.async_jobs job
left join public.submissions submission
  on job.job_kind = 'writing_evaluation'
  and submission.id = job.entity_id
left join public.student_practice_assignments generation_assignment
  on job.job_kind = 'worksheet_generation'
  and generation_assignment.id = job.entity_id
left join public.practice_test_attempts attempt
  on job.job_kind = 'worksheet_answer_evaluation'
  and attempt.id = job.entity_id
where job.id = reservation.job_id;
select set_config('app.ai_spend_transition', 'off', true);

-- Abort with a stable, content-free diagnostic before either NOT NULL change.
-- A historical reservation whose job no longer resolves must be repaired in
-- staging; allowing PostgreSQL to emit a bare constraint failure would hide
-- the migration's actual prerequisite.
do $$
declare
  unresolved_student_count bigint;
  unresolved_cached_rate_count bigint;
begin
  select
    count(*) filter (where reservation.student_id is null),
    count(*) filter (
      where reservation.cached_input_rate_microusd_per_million is null
    )
  into unresolved_student_count, unresolved_cached_rate_count
  from app_private.ai_spend_reservations reservation;

  if unresolved_student_count > 0 or unresolved_cached_rate_count > 0 then
    raise exception using
      errcode = '23502',
      message = 'ai_spend_reservation_backfill_incomplete',
      detail = format(
        'unresolved_student_count=%s; unresolved_cached_rate_count=%s',
        unresolved_student_count,
        unresolved_cached_rate_count
      ),
      hint = 'Repair historical reservation-to-job references before retrying.';
  end if;
end;
$$;

alter table app_private.ai_spend_reservations
  alter column student_id set not null,
  alter column cached_input_rate_microusd_per_million set not null,
  add constraint ai_spend_reservations_student_fk foreign key (student_id)
    references public.profiles(id) on delete restrict,
  add constraint ai_spend_reservations_cached_rate_check check (
    cached_input_rate_microusd_per_million > 0
  ),
  add constraint ai_spend_reservations_cached_tokens_check check (
    billed_cached_input_tokens is null or billed_cached_input_tokens >= 0
  ),
  add constraint ai_spend_reservations_uncached_tokens_check check (
    billed_uncached_input_tokens is null or billed_uncached_input_tokens >= 0
  );

alter table app_private.ai_spend_reservations
  drop constraint ai_spend_reservation_state_shape_check;

alter table app_private.ai_spend_reservations
  add constraint ai_spend_reservation_state_shape_check check (
    (
      state = 'reserved'
      and actual_microusd is null
      and billed_input_tokens is null
      and billed_output_tokens is null
      and billed_cached_input_tokens is null
      and billed_uncached_input_tokens is null
      and cache_metadata_present is null
      and release_reason is null
      and finalized_at is null
      and released_at is null
    )
    or (
      state = 'finalized'
      and actual_microusd is not null
      and actual_microusd <= reserved_microusd
      and billed_input_tokens is not null
      and billed_output_tokens is not null
      and billed_cached_input_tokens is not null
      and billed_uncached_input_tokens is not null
      and billed_cached_input_tokens + billed_uncached_input_tokens =
        billed_input_tokens
      and cache_metadata_present is not null
      and release_reason is null
      and finalized_at is not null
      and released_at is null
    )
    or (
      state = 'released'
      and actual_microusd is null
      and billed_input_tokens is null
      and billed_output_tokens is null
      and billed_cached_input_tokens is null
      and billed_uncached_input_tokens is null
      and cache_metadata_present is null
      and release_reason is not null
      and finalized_at is null
      and released_at is not null
    )
  );

create index ai_spend_reservations_workspace_student_month_idx
on app_private.ai_spend_reservations (
  workspace_id, student_id, billing_month, state, created_at, id
);

create index ai_spend_reservations_global_student_month_idx
on app_private.ai_spend_reservations (
  student_id, billing_month, state, created_at, id
)
where state in ('reserved', 'finalized');

create or replace function app_private.ai_spend_cost_microusd_v2(
  cached_input_tokens bigint,
  uncached_input_tokens bigint,
  output_tokens bigint,
  cached_input_rate_microusd_per_million bigint,
  uncached_input_rate_microusd_per_million bigint,
  output_rate_microusd_per_million bigint
)
returns bigint
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select
    ceil(
      (cached_input_tokens::numeric *
        cached_input_rate_microusd_per_million::numeric) / 1000000
    )::bigint +
    ceil(
      (uncached_input_tokens::numeric *
        uncached_input_rate_microusd_per_million::numeric) / 1000000
    )::bigint +
    ceil(
      (output_tokens::numeric * output_rate_microusd_per_million::numeric) /
        1000000
    )::bigint;
$$;

revoke all on function app_private.ai_spend_cost_microusd_v2(
  bigint, bigint, bigint, bigint, bigint, bigint
) from public, anon, authenticated, service_role;

create or replace function app_private.student_month_work_lock_key(
  target_student_id uuid,
  target_billing_month date
)
returns bigint
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select hashtextextended(
    concat_ws(
      ':',
      'student-month-ai-spend-v1',
      target_student_id::text,
      target_billing_month::text
    ),
    0
  );
$$;

revoke all on function app_private.student_month_work_lock_key(uuid, date)
from public, anon, authenticated, service_role;

create or replace function app_private.student_workspace_work_lock_key(
  target_workspace_id uuid,
  target_student_id uuid
)
returns bigint
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select hashtextextended(
    concat_ws(
      ':',
      'student-workspace-work-v1',
      target_workspace_id::text,
      target_student_id::text
    ),
    0
  );
$$;

revoke all on function app_private.student_workspace_work_lock_key(uuid, uuid)
from public, anon, authenticated, service_role;

-- The reservation function already serializes each workspace/month on the
-- budget row. This earlier-named insert trigger runs inside that same lock,
-- freezes the student/rates on the receipt, and applies the lower of the
-- student, active-cohort, workspace, and global envelopes before dispatch.
create or replace function app_private.enforce_ai_spend_fair_share()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_policy app_private.ai_model_cost_policies%rowtype;
  selected_global app_private.ai_spend_global_policy%rowtype;
  selected_student_id uuid;
  active_student_count bigint := 0;
  student_limit_microusd bigint;
  cohort_limit_microusd bigint;
  workspace_limit_microusd bigint;
  global_student_committed_microusd bigint := 0;
  cohort_committed_microusd bigint := 0;
  current_utc_date date := (timezone('UTC', now()))::date;
  effective_usd_to_eur_microrate bigint;
begin
  if current_setting('app.ai_spend_transition', true) <> 'on' then
    raise exception using errcode = '55000', message = 'ai_spend_evidence_immutable';
  end if;

  select job.*
  into strict selected_job
  from app_private.async_jobs job
  where job.id = new.job_id;

  if selected_job.job_kind = 'writing_evaluation' then
    select submission.student_id
    into selected_student_id
    from public.submissions submission
    where submission.id = selected_job.entity_id;
  elsif selected_job.job_kind = 'worksheet_generation' then
    select assignment.student_id
    into selected_student_id
    from public.student_practice_assignments assignment
    where assignment.id = selected_job.entity_id;
  elsif selected_job.job_kind = 'worksheet_answer_evaluation' then
    select attempt.student_id
    into selected_student_id
    from public.practice_test_attempts attempt
    where attempt.id = selected_job.entity_id;
  end if;

  if selected_student_id is null then
    raise exception using errcode = '02000', message = 'ai_spend_job_missing';
  end if;

  -- The global student/month key prevents two workspaces from multiplying one
  -- learner's allowance. reserve_ai_spend has already locked the async job, so
  -- all reservation/offboarding work follows one order: async job row(s),
  -- global student/month, student/workspace, then membership row(s).
  perform pg_advisory_xact_lock(
    app_private.student_month_work_lock_key(
      selected_student_id,
      new.billing_month
    )
  );
  perform pg_advisory_xact_lock(
    app_private.student_workspace_work_lock_key(
      new.workspace_id,
      selected_student_id
    )
  );

  -- Lock every current student membership in a stable order. Offboarding and
  -- role changes cannot reduce the cohort between the count and this insert;
  -- concurrent joins only make the envelope more conservative for this call.
  perform membership.id
  from public.workspace_members membership
  where membership.workspace_id = new.workspace_id
    and membership.role = 'student'
  order by membership.id
  for share;

  if not exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = new.workspace_id
      and membership.user_id = selected_student_id
      and membership.role = 'student'
  ) then
    raise exception using errcode = '55000', message = 'ai_spend_student_inactive';
  end if;

  select count(*)::bigint
  into active_student_count
  from public.workspace_members membership
  where membership.workspace_id = new.workspace_id
    and membership.role = 'student';

  select policy.*
  into strict selected_global
  from app_private.ai_spend_global_policy policy
  where policy.singleton;

  if selected_global.exchange_rate_verified_at > current_utc_date then
    raise exception using errcode = '22023', message = 'ai_spend_fx_rate_future';
  end if;
  effective_usd_to_eur_microrate := selected_global.usd_to_eur_microrate;
  if selected_global.exchange_rate_verified_at <
      current_utc_date - selected_global.maximum_exchange_rate_age_days
  then
    -- Stale evidence still fails release preflight and monitoring, but it must
    -- not shut off writing or worksheet calls. The maximum allowed EUR-per-USD
    -- denominator is the strictest possible cap: it always admits the same or
    -- fewer micro-USD than the last observed rate.
    effective_usd_to_eur_microrate := greatest(
      selected_global.usd_to_eur_microrate,
      selected_global.stale_exchange_rate_fallback_microrate
    );
  end if;

  student_limit_microusd := app_private.ai_fair_share_limit_microusd(
    selected_global.operating_target_microeur_per_active_student_month,
    selected_global.fair_share_reserve_basis_points,
    effective_usd_to_eur_microrate
  );
  if student_limit_microusd is null or student_limit_microusd < 1 then
    raise exception using errcode = '55000', message = 'ai_spend_contract_invalid';
  end if;
  cohort_limit_microusd := student_limit_microusd * active_student_count;

  select budget.monthly_limit_microusd
  into strict workspace_limit_microusd
  from app_private.ai_workspace_monthly_budgets budget
  where budget.workspace_id = new.workspace_id
    and budget.billing_month = new.billing_month;

  select coalesce(sum(case
    when reservation.state = 'finalized' then reservation.actual_microusd
    when reservation.state = 'reserved' then reservation.reserved_microusd
    else 0
  end), 0)::bigint
  into global_student_committed_microusd
  from app_private.ai_spend_reservations reservation
  where reservation.student_id = selected_student_id
    and reservation.billing_month = new.billing_month
    and reservation.state in ('reserved', 'finalized');

  select coalesce(sum(case
    when reservation.state = 'finalized' then reservation.actual_microusd
    when reservation.state = 'reserved' then reservation.reserved_microusd
    else 0
  end), 0)::bigint
  into cohort_committed_microusd
  from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = new.workspace_id
    and reservation.billing_month = new.billing_month;

  if global_student_committed_microusd + new.reserved_microusd >
      student_limit_microusd
  then
    raise exception using
      errcode = '53000', message = 'ai_spend_student_fair_share_exceeded';
  end if;
  if cohort_committed_microusd + new.reserved_microusd >
      least(cohort_limit_microusd, workspace_limit_microusd)
  then
    raise exception using
      errcode = '53000', message = 'ai_spend_cohort_budget_exceeded';
  end if;

  select policy.*
  into strict selected_policy
  from app_private.ai_model_cost_policies policy
  where policy.provider_name = new.provider_name
    and policy.model_name = new.model_name
    and policy.call_purpose = new.call_purpose;

  new.student_id := selected_student_id;
  new.cached_input_rate_microusd_per_million :=
    selected_policy.cached_input_rate_microusd_per_million;
  return new;
end;
$$;

revoke all on function app_private.enforce_ai_spend_fair_share()
from public, anon, authenticated, service_role;

create trigger ai_spend_reservations_00_fair_share
before insert on app_private.ai_spend_reservations
for each row execute function app_private.enforce_ai_spend_fair_share();

-- Offboarding must use the same row/advisory/membership order as paid-call
-- reservation. The previous membership-first implementation could deadlock a
-- worker that already held its async job row and was waiting for membership.
create or replace function app_private.offboard_student_internal(
  target_student_id uuid,
  target_workspace_id uuid
)
returns table (
  removed_batch_assignments integer,
  cancelled_join_requests integer,
  membership_removed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  target_role text;
  removed_assignments integer := 0;
  cancelled_requests integer := 0;
  removed_memberships integer := 0;
  active_job app_private.async_jobs%rowtype;
  current_billing_month date :=
    date_trunc('month', timezone('UTC', now()))::date;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if not app_private.is_platform_admin()
    and not app_private.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  -- This first read avoids locking student work for a known non-student. The
  -- authoritative role check is repeated under the membership lock below.
  select membership.role
  into target_role
  from public.workspace_members membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = target_student_id;

  if target_role is not null and target_role <> 'student' then
    raise exception using
      errcode = '23514',
      message = 'Only student memberships can be offboarded.';
  end if;

  -- Canonical order starts with every currently active async job in stable ID
  -- order. A concurrent reservation either completes before this lock or waits
  -- here; it can no longer form a job-versus-membership cycle.
  for active_job in
    select job.*
    from app_private.async_jobs job
    where job.status in ('queued', 'retry', 'processing')
      and (
        (
          job.job_kind = 'worksheet_generation'
          and exists (
            select 1
            from public.student_practice_assignments assignment
            where assignment.id = job.entity_id
              and assignment.workspace_id = target_workspace_id
              and assignment.student_id = target_student_id
              and assignment.status in ('unlocked', 'in_progress')
          )
        )
        or (
          job.job_kind = 'worksheet_answer_evaluation'
          and exists (
            select 1
            from public.practice_test_attempts attempt
            join public.student_practice_assignments assignment
              on assignment.id = attempt.assignment_id
            where attempt.id = job.entity_id
              and assignment.workspace_id = target_workspace_id
              and assignment.student_id = target_student_id
              and attempt.evaluation_status in (
                'pending', 'queued', 'evaluating'
              )
          )
        )
      )
    order by job.id
    for update
  loop
    if active_job.queue_message_id is not null then
      perform pgmq.archive(active_job.queue_name, active_job.queue_message_id);
    end if;

    update app_private.async_jobs job
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'student_offboarded'
    where job.id = active_job.id;
  end loop;

  perform pg_advisory_xact_lock(
    app_private.student_month_work_lock_key(
      target_student_id,
      current_billing_month
    )
  );
  perform pg_advisory_xact_lock(
    app_private.student_workspace_work_lock_key(
      target_workspace_id,
      target_student_id
    )
  );

  select membership.role
  into target_role
  from public.workspace_members membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = target_student_id
  for update;

  if target_role is not null and target_role <> 'student' then
    raise exception using
      errcode = '23514',
      message = 'Only student memberships can be offboarded.';
  end if;

  update public.practice_test_attempts attempt
  set
    evaluation_status = 'failed',
    evaluation_completed_at = now(),
    evaluation_error = 'student_offboarded'
  where attempt.assignment_id in (
    select assignment.id
    from public.student_practice_assignments assignment
    where assignment.workspace_id = target_workspace_id
      and assignment.student_id = target_student_id
  )
    and attempt.evaluation_status in ('pending', 'queued', 'evaluating');

  update public.student_practice_assignments assignment
  set
    status = 'cancelled',
    completed_at = coalesce(assignment.completed_at, now()),
    generation_status = case
      when assignment.generation_status in ('queued', 'generating') then 'failed'
      else assignment.generation_status
    end,
    generation_completed_at = case
      when assignment.generation_status in ('queued', 'generating') then now()
      else assignment.generation_completed_at
    end,
    generation_error = case
      when assignment.generation_status in ('queued', 'generating')
        then 'student_offboarded'
      else assignment.generation_error
    end
  where assignment.workspace_id = target_workspace_id
    and assignment.student_id = target_student_id
    and assignment.status in ('unlocked', 'in_progress');

  update public.batch_join_requests request
  set
    status = 'cancelled',
    decided_by = caller_id,
    decided_at = now()
  where request.workspace_id = target_workspace_id
    and request.student_id = target_student_id
    and request.status in ('pending', 'approved');
  get diagnostics cancelled_requests = row_count;

  delete from public.batch_students assignment
  where assignment.workspace_id = target_workspace_id
    and assignment.student_id = target_student_id;
  get diagnostics removed_assignments = row_count;

  delete from public.workspace_members membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = target_student_id
    and membership.role = 'student';
  get diagnostics removed_memberships = row_count;

  removed_batch_assignments := removed_assignments;
  cancelled_join_requests := cancelled_requests;
  membership_removed := removed_memberships > 0;
  return next;
end;
$$;

revoke all on function app_private.offboard_student_internal(uuid, uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cache-aware finalization. Null/null metadata is the only compatibility
-- fallback and is conservatively invoiced as 100% cache miss.
-- ---------------------------------------------------------------------------

create function app_private.finalize_ai_spend_reservation(
  target_reservation_id uuid,
  target_billed_input_tokens bigint,
  target_billed_output_tokens bigint,
  target_billed_cached_input_tokens bigint,
  target_billed_uncached_input_tokens bigint
)
returns table (
  reservation_id uuid,
  state text,
  reserved_microusd bigint,
  actual_microusd bigint,
  billed_input_tokens bigint,
  billed_output_tokens bigint,
  finalized_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  recorded app_private.ai_spend_reservations%rowtype;
  computed_actual_microusd bigint;
  normalized_cached_input_tokens bigint;
  normalized_uncached_input_tokens bigint;
  metadata_present boolean;
begin
  perform app_private.assert_service_role();
  if target_reservation_id is null
    or target_billed_input_tokens is null
    or target_billed_output_tokens is null
    or target_billed_input_tokens not between 0 and 10000000
    or target_billed_output_tokens not between 0 and 10000000
    or (
      (target_billed_cached_input_tokens is null) <>
      (target_billed_uncached_input_tokens is null)
    )
    or (
      target_billed_cached_input_tokens is not null
      and (
        target_billed_cached_input_tokens not between 0 and 10000000
        or target_billed_uncached_input_tokens not between 0 and 10000000
        or target_billed_cached_input_tokens +
          target_billed_uncached_input_tokens <> target_billed_input_tokens
      )
    )
  then
    raise exception using errcode = '22023', message = 'ai_spend_contract_invalid';
  end if;

  metadata_present := target_billed_cached_input_tokens is not null;
  normalized_cached_input_tokens := coalesce(
    target_billed_cached_input_tokens,
    0
  );
  normalized_uncached_input_tokens := coalesce(
    target_billed_uncached_input_tokens,
    target_billed_input_tokens
  );

  select reservation.*
  into recorded
  from app_private.ai_spend_reservations reservation
  where reservation.id = target_reservation_id
  for update;

  if recorded.id is null then
    raise exception using errcode = '02000', message = 'ai_spend_reservation_missing';
  end if;
  if recorded.state = 'released' then
    raise exception using errcode = '55000', message = 'ai_spend_reservation_conflict';
  end if;

  computed_actual_microusd := app_private.ai_spend_cost_microusd_v2(
    normalized_cached_input_tokens,
    normalized_uncached_input_tokens,
    target_billed_output_tokens,
    recorded.cached_input_rate_microusd_per_million,
    recorded.input_rate_microusd_per_million,
    recorded.output_rate_microusd_per_million
  );

  if recorded.state = 'finalized' then
    if recorded.billed_input_tokens <> target_billed_input_tokens
      or recorded.billed_output_tokens <> target_billed_output_tokens
      or recorded.billed_cached_input_tokens <>
        normalized_cached_input_tokens
      or recorded.billed_uncached_input_tokens <>
        normalized_uncached_input_tokens
      or recorded.cache_metadata_present <> metadata_present
      or recorded.actual_microusd <> computed_actual_microusd
    then
      raise exception using errcode = '55000', message = 'ai_spend_reservation_conflict';
    end if;
    return query select
      recorded.id,
      recorded.state,
      recorded.reserved_microusd,
      recorded.actual_microusd,
      recorded.billed_input_tokens,
      recorded.billed_output_tokens,
      recorded.finalized_at,
      true;
    return;
  end if;

  if computed_actual_microusd > recorded.reserved_microusd then
    raise exception using errcode = '55000', message = 'ai_spend_actual_exceeds_reserved';
  end if;

  perform set_config('app.ai_spend_transition', 'on', true);
  update app_private.ai_spend_reservations reservation
  set
    state = 'finalized',
    actual_microusd = computed_actual_microusd,
    billed_input_tokens = target_billed_input_tokens,
    billed_output_tokens = target_billed_output_tokens,
    billed_cached_input_tokens = normalized_cached_input_tokens,
    billed_uncached_input_tokens = normalized_uncached_input_tokens,
    cache_metadata_present = metadata_present,
    finalized_at = now()
  where reservation.id = recorded.id
  returning * into recorded;
  perform set_config('app.ai_spend_transition', 'off', true);

  return query select
    recorded.id,
    recorded.state,
    recorded.reserved_microusd,
    recorded.actual_microusd,
    recorded.billed_input_tokens,
    recorded.billed_output_tokens,
    recorded.finalized_at,
    false;
end;
$$;

revoke all on function app_private.finalize_ai_spend_reservation(
  uuid, bigint, bigint, bigint, bigint
) from public, anon, authenticated, service_role;
grant execute on function app_private.finalize_ai_spend_reservation(
  uuid, bigint, bigint, bigint, bigint
) to service_role;

create or replace function app_private.finalize_ai_spend_reservation(
  target_reservation_id uuid,
  target_billed_input_tokens bigint,
  target_billed_output_tokens bigint
)
returns table (
  reservation_id uuid,
  state text,
  reserved_microusd bigint,
  actual_microusd bigint,
  billed_input_tokens bigint,
  billed_output_tokens bigint,
  finalized_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_service_role();
  return query
  select *
  from app_private.finalize_ai_spend_reservation(
    target_reservation_id,
    target_billed_input_tokens,
    target_billed_output_tokens,
    null,
    null
  );
end;
$$;

revoke all on function app_private.finalize_ai_spend_reservation(
  uuid, bigint, bigint
) from public, anon, authenticated, service_role;
grant execute on function app_private.finalize_ai_spend_reservation(
  uuid, bigint, bigint
) to service_role;

create function api.finalize_ai_spend_reservation(
  target_reservation_id uuid,
  target_billed_input_tokens bigint,
  target_billed_output_tokens bigint,
  target_billed_cached_input_tokens bigint,
  target_billed_uncached_input_tokens bigint
)
returns table (
  reservation_id uuid,
  state text,
  reserved_microusd bigint,
  actual_microusd bigint,
  billed_input_tokens bigint,
  billed_output_tokens bigint,
  finalized_at timestamptz,
  replayed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.finalize_ai_spend_reservation(
    target_reservation_id,
    target_billed_input_tokens,
    target_billed_output_tokens,
    target_billed_cached_input_tokens,
    target_billed_uncached_input_tokens
  );
$$;

revoke all on function api.finalize_ai_spend_reservation(
  uuid, bigint, bigint, bigint, bigint
) from public, anon, authenticated;
grant execute on function api.finalize_ai_spend_reservation(
  uuid, bigint, bigint, bigint, bigint
) to service_role;

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
      and (target_job_id is null or reservation.job_id = target_job_id)
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
    billed_cached_input_tokens = 0,
    billed_uncached_input_tokens = 0,
    cache_metadata_present = false,
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

comment on function app_private.enforce_ai_spend_fair_share() is
  'Service-only fail-closed admission: one student cannot consume another active learner fair share; the lower student, cohort, workspace, and global envelope wins.';
comment on function api.finalize_ai_spend_reservation(
  uuid, bigint, bigint, bigint, bigint
) is
  'Service-only invoice finalization with explicit cache-hit/cache-miss tokens; null/null is conservatively priced as all cache miss.';
comment on table app_private.ai_spend_reservations is
  'Private job/version/call/student-scoped AI reservations with content-free cache-hit/miss invoice evidence; no raw student content or provider payloads.';

notify pgrst, 'reload schema';
