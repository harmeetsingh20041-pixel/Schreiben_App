-- Preserve global AI-spend truth while deleting isolated live-browser fixtures.
--
-- The archive is deliberately detached from tenant and job foreign keys so an
-- exact synthetic canary can be removed without retaining student content or
-- weakening production referential integrity. Only terminal reservation
-- evidence may enter this ledger, and every aggregate consumes the active and
-- archived sources through one deduplicating accounting function.

create table app_private.ai_canary_spend_archive (
  original_reservation_id uuid primary key,
  original_job_id uuid not null,
  entity_version integer not null check (entity_version > 0),
  call_key text not null check (
    call_key ~ '^[a-z][a-z0-9._:-]{0,119}$'
  ),
  original_workspace_id uuid not null,
  billing_month date not null,
  provider_name text not null check (provider_name in ('deepseek', 'gemini')),
  model_name text not null check (btrim(model_name) <> ''),
  call_purpose text not null check (btrim(call_purpose) <> ''),
  input_rate_microusd_per_million bigint not null check (
    input_rate_microusd_per_million > 0
  ),
  output_rate_microusd_per_million bigint not null check (
    output_rate_microusd_per_million > 0
  ),
  reserved_microusd bigint not null check (reserved_microusd > 0),
  state text not null check (state in ('finalized', 'released')),
  actual_microusd bigint check (
    actual_microusd is null or actual_microusd >= 0
  ),
  billed_input_tokens bigint check (
    billed_input_tokens is null or billed_input_tokens >= 0
  ),
  billed_output_tokens bigint check (
    billed_output_tokens is null or billed_output_tokens >= 0
  ),
  release_reason text check (
    release_reason is null or release_reason in (
      'provider_not_called',
      'request_failed_unbilled',
      'superseded',
      'job_cancelled'
    )
  ),
  usage_estimated boolean not null,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  finalized_at timestamptz,
  released_at timestamptz,
  archived_at timestamptz not null default now(),
  archive_source text not null default 'writing_live_canary_cleanup' check (
    archive_source = 'writing_live_canary_cleanup'
  ),
  constraint ai_canary_spend_archive_month_start_check check (
    billing_month = date_trunc('month', billing_month)::date
  ),
  constraint ai_canary_spend_archive_state_shape_check check (
    (
      state = 'finalized'
      and actual_microusd is not null
      and actual_microusd <= reserved_microusd
      and billed_input_tokens is not null
      and billed_output_tokens is not null
      and release_reason is null
      and finalized_at is not null
      and released_at is null
      and usage_estimated = (
        actual_microusd = reserved_microusd
        and billed_input_tokens = 0
        and billed_output_tokens = 0
      )
    )
    or (
      state = 'released'
      and actual_microusd is null
      and billed_input_tokens is null
      and billed_output_tokens is null
      and release_reason is not null
      and finalized_at is null
      and released_at is not null
      and not usage_estimated
    )
  )
);

create index ai_canary_spend_archive_global_month_idx
on app_private.ai_canary_spend_archive (
  billing_month,
  state,
  provider_name,
  model_name,
  call_purpose,
  original_reservation_id
);

create index ai_canary_spend_archive_workspace_month_idx
on app_private.ai_canary_spend_archive (
  original_workspace_id,
  billing_month,
  state,
  original_reservation_id
);

create index ai_canary_spend_archive_job_idx
on app_private.ai_canary_spend_archive (
  original_job_id,
  original_reservation_id
);

alter table app_private.ai_canary_spend_archive enable row level security;
revoke all on table app_private.ai_canary_spend_archive
from public, anon, authenticated, service_role;

create function app_private.reject_ai_canary_spend_archive_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'ai_canary_spend_archive_immutable';
end;
$$;

revoke all on function
  app_private.reject_ai_canary_spend_archive_mutation()
from public, anon, authenticated, service_role;

create trigger ai_canary_spend_archive_immutable
before update or delete on app_private.ai_canary_spend_archive
for each row execute function
  app_private.reject_ai_canary_spend_archive_mutation();

create function app_private.ai_spend_accounting_entries()
returns table (
  reservation_id uuid,
  job_id uuid,
  entity_version integer,
  call_key text,
  workspace_id uuid,
  billing_month date,
  provider_name text,
  model_name text,
  call_purpose text,
  reserved_microusd bigint,
  state text,
  actual_microusd bigint,
  billed_input_tokens bigint,
  billed_output_tokens bigint,
  usage_estimated boolean,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    reservation.id,
    reservation.job_id,
    reservation.entity_version,
    reservation.call_key,
    reservation.workspace_id,
    reservation.billing_month,
    reservation.provider_name,
    reservation.model_name,
    reservation.call_purpose,
    reservation.reserved_microusd,
    reservation.state,
    reservation.actual_microusd,
    reservation.billed_input_tokens,
    reservation.billed_output_tokens,
    reservation.usage_estimated,
    reservation.created_at
  from app_private.ai_spend_reservations reservation

  union all

  select
    archived.original_reservation_id,
    archived.original_job_id,
    archived.entity_version,
    archived.call_key,
    archived.original_workspace_id,
    archived.billing_month,
    archived.provider_name,
    archived.model_name,
    archived.call_purpose,
    archived.reserved_microusd,
    archived.state,
    archived.actual_microusd,
    archived.billed_input_tokens,
    archived.billed_output_tokens,
    archived.usage_estimated,
    archived.created_at
  from app_private.ai_canary_spend_archive archived
  where not exists (
    select 1
    from app_private.ai_spend_reservations active
    where active.id = archived.original_reservation_id
  );
$$;

revoke all on function app_private.ai_spend_accounting_entries()
from public, anon, authenticated, service_role;

create function app_private.archive_writing_live_canary_spend(
  target_workspace_id uuid,
  target_workspace_slug text,
  target_batch_id uuid
)
returns table (
  archived_reservation_count bigint,
  newly_archived_count bigint,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_workspace public.workspaces%rowtype;
  expected_suffix text;
  active_reservation_count bigint := 0;
  inserted_count bigint := 0;
  deleted_count bigint := 0;
  total_count bigint := 0;
begin
  perform app_private.assert_service_role();

  if target_workspace_id is null
    or coalesce(target_workspace_slug, '') = ''
    or target_batch_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'writing_live_canary_archive_contract_invalid';
  end if;

  expected_suffix := left(target_workspace_id::text, 8);
  if target_workspace_slug <>
      'e2e-writing-live-' || target_workspace_id::text
  then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_identity_mismatch';
  end if;

  select workspace.*
  into selected_workspace
  from public.workspaces workspace
  where workspace.id = target_workspace_id
  for update;

  if selected_workspace.id is null
    or selected_workspace.slug <> target_workspace_slug
    or selected_workspace.name <> 'V1 writing live ' || expected_suffix
  then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_identity_mismatch';
  end if;

  if (
    select count(*)
    from public.batches batch
    where batch.workspace_id = target_workspace_id
  ) <> 1
    or not exists (
      select 1
      from public.batches batch
      where batch.id = target_batch_id
        and batch.workspace_id = target_workspace_id
        and batch.name = 'Writing live class ' || expected_suffix
        and batch.level = 'A1'
        and batch.feedback_mode = 'immediate'
        and batch.is_active
        and batch.join_requires_approval
        and batch.created_by = selected_workspace.owner_id
    )
    or not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = selected_workspace.owner_id
        and membership.role in ('owner', 'teacher')
    )
    or (
      select count(*)
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
    ) <> 2
    or (
      select count(*)
      from public.batch_students assignment
      where assignment.batch_id = target_batch_id
        and assignment.workspace_id = target_workspace_id
    ) <> 1
    or not exists (
      select 1
      from public.batch_students assignment
      join public.workspace_members membership
        on membership.workspace_id = assignment.workspace_id
       and membership.user_id = assignment.student_id
       and membership.role = 'student'
      where assignment.batch_id = target_batch_id
        and assignment.workspace_id = target_workspace_id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_identity_mismatch';
  end if;

  if (
    select count(*)
    from public.submissions submission
    where submission.workspace_id = target_workspace_id
  ) > 1
    or exists (
      select 1
      from public.submissions submission
      where submission.workspace_id = target_workspace_id
        and submission.batch_id is distinct from target_batch_id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_submission_scope_invalid';
  end if;

  perform submission.id
  from public.submissions submission
  where submission.workspace_id = target_workspace_id
  order by submission.id
  for update;

  -- Reuse the exact paid-job entity lock taken by every writing enqueue/retry.
  -- Together with the workspace/submission row locks, this prevents a phantom
  -- retry job from appearing after the archive has snapshotted terminal work.
  perform pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(
        ':',
        'paid-job-entity',
        'writing_evaluation',
        submission.id
      ),
      0
    )
  )
  from public.submissions submission
  where submission.workspace_id = target_workspace_id
  order by submission.id;

  -- Locks persist until the caller transaction commits. A worker trying to
  -- claim, enqueue, or transition the same job therefore cannot race cleanup.
  perform job.id
  from app_private.async_jobs job
  join public.submissions submission
    on submission.id = job.entity_id
  where submission.workspace_id = target_workspace_id
  order by job.id
  for update of job;

  if exists (
    select 1
    from app_private.async_jobs job
    join public.submissions submission
      on submission.id = job.entity_id
    where submission.workspace_id = target_workspace_id
      and (
        job.job_kind <> 'writing_evaluation'
        or job.queue_name <> 'writing_evaluation'
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_job_scope_invalid';
  end if;

  if exists (
    select 1
    from app_private.async_jobs job
    join public.submissions submission
      on submission.id = job.entity_id
    where submission.workspace_id = target_workspace_id
      and job.status in ('queued', 'processing', 'retry')
  ) then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_job_active';
  end if;

  perform reservation.id
  from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = target_workspace_id
  order by reservation.id
  for update;

  if exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = target_workspace_id
      and not exists (
        select 1
        from app_private.async_jobs job
        join public.submissions submission
          on submission.id = job.entity_id
        where job.id = reservation.job_id
          and submission.workspace_id = target_workspace_id
      )
  ) or exists (
    select 1
    from app_private.ai_spend_reservations reservation
    join app_private.async_jobs job on job.id = reservation.job_id
    join public.submissions submission on submission.id = job.entity_id
    where submission.workspace_id = target_workspace_id
      and reservation.workspace_id <> target_workspace_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_spend_scope_invalid';
  end if;

  if exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = target_workspace_id
      and reservation.state = 'reserved'
  ) then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_spend_not_terminal';
  end if;

  if exists (
    select 1
    from app_private.ai_spend_reservations reservation
    join app_private.ai_canary_spend_archive archived
      on archived.original_reservation_id = reservation.id
    where reservation.workspace_id = target_workspace_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_spend_overlap';
  end if;

  if exists (
    select 1
    from app_private.ai_canary_spend_archive archived
    where archived.original_workspace_id = target_workspace_id
      and not exists (
        select 1
        from app_private.async_jobs job
        join public.submissions submission
          on submission.id = job.entity_id
        where job.id = archived.original_job_id
          and submission.workspace_id = target_workspace_id
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_archive_scope_invalid';
  end if;

  select count(*)
  into active_reservation_count
  from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = target_workspace_id;

  with copied as (
    insert into app_private.ai_canary_spend_archive (
      original_reservation_id,
      original_job_id,
      entity_version,
      call_key,
      original_workspace_id,
      billing_month,
      provider_name,
      model_name,
      call_purpose,
      input_rate_microusd_per_million,
      output_rate_microusd_per_million,
      reserved_microusd,
      state,
      actual_microusd,
      billed_input_tokens,
      billed_output_tokens,
      release_reason,
      usage_estimated,
      expires_at,
      created_at,
      finalized_at,
      released_at
    )
    select
      reservation.id,
      reservation.job_id,
      reservation.entity_version,
      reservation.call_key,
      reservation.workspace_id,
      reservation.billing_month,
      reservation.provider_name,
      reservation.model_name,
      reservation.call_purpose,
      reservation.input_rate_microusd_per_million,
      reservation.output_rate_microusd_per_million,
      reservation.reserved_microusd,
      reservation.state,
      reservation.actual_microusd,
      reservation.billed_input_tokens,
      reservation.billed_output_tokens,
      reservation.release_reason,
      reservation.usage_estimated,
      reservation.expires_at,
      reservation.created_at,
      reservation.finalized_at,
      reservation.released_at
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id = target_workspace_id
    returning 1
  )
  select count(*) into inserted_count from copied;

  if inserted_count <> active_reservation_count then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_archive_copy_incomplete';
  end if;

  perform set_config('app.ai_spend_transition', 'on', true);
  delete from app_private.ai_spend_reservations reservation
  where reservation.workspace_id = target_workspace_id;
  get diagnostics deleted_count = row_count;
  perform set_config('app.ai_spend_transition', 'off', true);

  if deleted_count <> inserted_count then
    raise exception using
      errcode = '55000',
      message = 'writing_live_canary_archive_delete_mismatch';
  end if;

  select count(*)
  into total_count
  from app_private.ai_canary_spend_archive archived
  where archived.original_workspace_id = target_workspace_id;

  return query select
    total_count,
    inserted_count,
    inserted_count = 0 and total_count > 0;
end;
$$;

revoke all on function app_private.archive_writing_live_canary_spend(
  uuid, text, uuid
) from public, anon, authenticated, service_role;

create function public.archive_writing_live_canary_spend(
  target_workspace_id uuid,
  target_workspace_slug text,
  target_batch_id uuid
)
returns table (
  archived_reservation_count bigint,
  newly_archived_count bigint,
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
  from app_private.archive_writing_live_canary_spend(
    target_workspace_id,
    target_workspace_slug,
    target_batch_id
  );
end;
$$;

revoke all on function public.archive_writing_live_canary_spend(
  uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.archive_writing_live_canary_spend(
  uuid, text, uuid
) to service_role;

create function api.archive_writing_live_canary_spend(
  target_workspace_id uuid,
  target_workspace_slug text,
  target_batch_id uuid
)
returns table (
  archived_reservation_count bigint,
  newly_archived_count bigint,
  replayed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.archive_writing_live_canary_spend(
    target_workspace_id,
    target_workspace_slug,
    target_batch_id
  );
$$;

revoke all on function api.archive_writing_live_canary_spend(
  uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function api.archive_writing_live_canary_spend(
  uuid, text, uuid
) to service_role;

comment on table app_private.ai_canary_spend_archive is
  'Content-free immutable spend evidence detached only for exact synthetic writing-live fixtures; never used for normal tenant cleanup.';
comment on function app_private.archive_writing_live_canary_spend(
  uuid, text, uuid
) is
  'Private fail-closed atomic copy-before-delete implementation for terminal spend belonging to one deterministic writing-live staging fixture.';
comment on function api.archive_writing_live_canary_spend(
  uuid, text, uuid
) is
  'Service-only invoker facade for exact terminal writing-live canary spend archival; no browser role can execute it.';

-- Keep detached finalized canary spend inside both workspace and global hard
-- caps. Active reservations and archived rows are deduplicated by the helper.
create or replace function app_private.reserve_ai_spend(
  target_job_id uuid,
  target_entity_version integer,
  call_key text,
  provider_name text,
  model_name text,
  call_purpose text,
  maximum_cost_microusd bigint,
  reservation_ttl_seconds integer default 900
)
returns table (
  reservation_id uuid,
  state text,
  reserved_microusd bigint,
  workspace_remaining_microusd bigint,
  global_remaining_microusd bigint,
  expires_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_policy app_private.ai_model_cost_policies%rowtype;
  global_policy app_private.ai_spend_global_policy%rowtype;
  workspace_budget app_private.ai_workspace_monthly_budgets%rowtype;
  recorded app_private.ai_spend_reservations%rowtype;
  selected_workspace_id uuid;
  selected_billing_month date :=
    date_trunc('month', timezone('UTC', now()))::date;
  workspace_committed bigint := 0;
  global_committed bigint := 0;
begin
  perform app_private.assert_service_role();

  if target_job_id is null
    or target_entity_version is null
    or target_entity_version <= 0
    or coalesce(call_key, '') !~ '^[a-z][a-z0-9._:-]{0,119}$'
    or coalesce(provider_name, '') not in ('deepseek', 'gemini')
    or coalesce(model_name, '') = ''
    or coalesce(call_purpose, '') = ''
    or maximum_cost_microusd is null
    or maximum_cost_microusd <= 0
    or reservation_ttl_seconds is null
    or reservation_ttl_seconds not between 60 and 7200
  then
    raise exception using errcode = '22023', message = 'ai_spend_contract_invalid';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job.id is null then
    raise exception using errcode = '02000', message = 'ai_spend_job_missing';
  end if;
  if selected_job.entity_version <> target_entity_version then
    raise exception using
      errcode = '55000',
      message = 'ai_spend_job_version_mismatch';
  end if;
  if not (
    (
      selected_job.job_kind = 'writing_evaluation'
      and call_purpose in (
        'writing_generation',
        'writing_critique',
        'writing_adjudication',
        'writing_final_critique'
      )
    )
    or (
      selected_job.job_kind = 'worksheet_generation'
      and call_purpose in ('worksheet_generation', 'worksheet_critique')
    )
    or (
      selected_job.job_kind = 'worksheet_answer_evaluation'
      and call_purpose in (
        'worksheet_answer_evaluation',
        'worksheet_answer_adjudication'
      )
    )
  ) then
    raise exception using errcode = '22023', message = 'ai_spend_model_not_allowed';
  end if;

  select policy.*
  into selected_policy
  from app_private.ai_model_cost_policies policy
  where policy.provider_name = reserve_ai_spend.provider_name
    and policy.model_name = reserve_ai_spend.model_name
    and policy.call_purpose = reserve_ai_spend.call_purpose;

  if selected_policy.provider_name is null
    or maximum_cost_microusd <>
      selected_policy.maximum_reservation_microusd
  then
    raise exception using errcode = '22023', message = 'ai_spend_model_not_allowed';
  end if;

  if selected_job.job_kind = 'writing_evaluation' then
    select submission.workspace_id
    into selected_workspace_id
    from public.submissions submission
    where submission.id = selected_job.entity_id;
  elsif selected_job.job_kind = 'worksheet_generation' then
    select assignment.workspace_id
    into selected_workspace_id
    from public.student_practice_assignments assignment
    where assignment.id = selected_job.entity_id;
  else
    select assignment.workspace_id
    into selected_workspace_id
    from public.practice_test_attempts attempt
    join public.student_practice_assignments assignment
      on assignment.id = attempt.assignment_id
    where attempt.id = selected_job.entity_id;
  end if;

  if selected_workspace_id is null then
    raise exception using errcode = '02000', message = 'ai_spend_job_missing';
  end if;

  select reservation.*
  into recorded
  from app_private.ai_spend_reservations reservation
  where reservation.job_id = target_job_id
    and reservation.entity_version = target_entity_version
    and reservation.call_key = reserve_ai_spend.call_key
  for update;

  -- A job can legitimately cross a UTC month boundary during bounded outage
  -- recovery. Exact replay remains attached to its original billing month.
  if recorded.id is not null then
    selected_billing_month := recorded.billing_month;
  end if;

  select policy.*
  into strict global_policy
  from app_private.ai_spend_global_policy policy
  where policy.singleton
  for update;

  insert into app_private.ai_workspace_monthly_budgets (
    workspace_id,
    billing_month,
    monthly_limit_microusd
  ) values (
    selected_workspace_id,
    selected_billing_month,
    global_policy.default_workspace_monthly_limit_microusd
  ) on conflict (workspace_id, billing_month) do nothing;

  select budget.*
  into strict workspace_budget
  from app_private.ai_workspace_monthly_budgets budget
  where budget.workspace_id = selected_workspace_id
    and budget.billing_month = selected_billing_month
  for update;

  select coalesce(sum(case
    when entry.state = 'finalized' then entry.actual_microusd
    when entry.state = 'reserved' then entry.reserved_microusd
    else 0
  end), 0)::bigint
  into workspace_committed
  from app_private.ai_spend_accounting_entries() entry
  where entry.workspace_id = selected_workspace_id
    and entry.billing_month = selected_billing_month;

  select coalesce(sum(case
    when entry.state = 'finalized' then entry.actual_microusd
    when entry.state = 'reserved' then entry.reserved_microusd
    else 0
  end), 0)::bigint
  into global_committed
  from app_private.ai_spend_accounting_entries() entry
  where entry.billing_month = selected_billing_month;

  if recorded.id is not null then
    if recorded.workspace_id <> selected_workspace_id
      or recorded.billing_month <> selected_billing_month
      or recorded.provider_name <> reserve_ai_spend.provider_name
      or recorded.model_name <> reserve_ai_spend.model_name
      or recorded.call_purpose <> reserve_ai_spend.call_purpose
      or recorded.reserved_microusd <> maximum_cost_microusd
    then
      raise exception using
        errcode = '55000',
        message = 'ai_spend_reservation_conflict';
    end if;
    if recorded.state = 'reserved' and recorded.expires_at <= now() then
      raise exception using
        errcode = '55000',
        message = 'ai_spend_reservation_expired';
    end if;
    if recorded.state = 'reserved' and selected_job.status <> 'processing' then
      raise exception using errcode = '55000', message = 'ai_spend_job_not_active';
    end if;
    if recorded.state = 'reserved' and global_policy.emergency_stop then
      raise exception using errcode = '53000', message = 'ai_spend_emergency_stop';
    end if;

    return query select
      recorded.id,
      recorded.state,
      recorded.reserved_microusd,
      greatest(
        workspace_budget.monthly_limit_microusd - workspace_committed,
        0
      ),
      greatest(global_policy.monthly_limit_microusd - global_committed, 0),
      recorded.expires_at,
      true;
    return;
  end if;

  if selected_job.status <> 'processing' then
    raise exception using errcode = '55000', message = 'ai_spend_job_not_active';
  end if;

  if global_policy.emergency_stop then
    raise exception using errcode = '53000', message = 'ai_spend_emergency_stop';
  end if;
  if workspace_committed + maximum_cost_microusd >
      workspace_budget.monthly_limit_microusd
  then
    raise exception using
      errcode = '53000',
      message = 'ai_spend_workspace_budget_exceeded';
  end if;
  if global_committed + maximum_cost_microusd >
      global_policy.monthly_limit_microusd
  then
    raise exception using
      errcode = '53000',
      message = 'ai_spend_global_budget_exceeded';
  end if;

  perform set_config('app.ai_spend_transition', 'on', true);
  insert into app_private.ai_spend_reservations (
    job_id,
    entity_version,
    call_key,
    workspace_id,
    billing_month,
    provider_name,
    model_name,
    call_purpose,
    input_rate_microusd_per_million,
    output_rate_microusd_per_million,
    reserved_microusd,
    expires_at
  ) values (
    target_job_id,
    target_entity_version,
    reserve_ai_spend.call_key,
    selected_workspace_id,
    selected_billing_month,
    reserve_ai_spend.provider_name,
    reserve_ai_spend.model_name,
    reserve_ai_spend.call_purpose,
    selected_policy.input_rate_microusd_per_million,
    selected_policy.output_rate_microusd_per_million,
    maximum_cost_microusd,
    now() + make_interval(secs => reservation_ttl_seconds)
  ) returning * into recorded;
  perform set_config('app.ai_spend_transition', 'off', true);

  return query select
    recorded.id,
    recorded.state,
    recorded.reserved_microusd,
    workspace_budget.monthly_limit_microusd
      - workspace_committed
      - recorded.reserved_microusd,
    global_policy.monthly_limit_microusd
      - global_committed
      - recorded.reserved_microusd,
    recorded.expires_at,
    false;
end;
$$;

revoke all on function app_private.reserve_ai_spend(
  uuid, integer, text, text, text, text, bigint, integer
) from public, anon, authenticated, service_role;
grant execute on function app_private.reserve_ai_spend(
  uuid, integer, text, text, text, text, bigint, integer
) to service_role;

create or replace function app_private.get_ai_spend_health(
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
    coalesce(sum(entry.actual_microusd) filter (
      where entry.state = 'finalized'
        and not entry.usage_estimated
    ), 0)::bigint,
    coalesce(sum(entry.actual_microusd) filter (
      where entry.state = 'finalized'
        and entry.usage_estimated
    ), 0)::bigint,
    count(*) filter (
      where entry.state = 'finalized'
        and entry.usage_estimated
    ),
    coalesce(sum(entry.reserved_microusd)
      filter (where entry.state = 'reserved'), 0)::bigint,
    count(*) filter (where entry.state = 'reserved'),
    count(*) filter (where entry.state = 'released'),
    extract(epoch from (
      now() - min(entry.created_at)
        filter (where entry.state = 'reserved')
    ))::bigint
  into
    scope_actual,
    scope_estimated,
    scope_estimated_count,
    scope_reserved,
    scope_reserved_count,
    scope_released_count,
    scope_oldest_reserved_age
  from app_private.ai_spend_accounting_entries() entry
  where entry.billing_month = selected_month
    and (
      target_workspace_id is null
      or entry.workspace_id = target_workspace_id
    );

  select coalesce(sum(case
    when entry.state = 'finalized' then entry.actual_microusd
    when entry.state = 'reserved' then entry.reserved_microusd
    else 0
  end), 0)::bigint
  into global_committed
  from app_private.ai_spend_accounting_entries() entry
  where entry.billing_month = selected_month;

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
      when entry.state = 'finalized' then entry.actual_microusd
      when entry.state = 'reserved' then entry.reserved_microusd
      else 0
    end), 0)::bigint
    into workspace_committed
    from app_private.ai_spend_accounting_entries() entry
    where entry.billing_month = selected_month
      and entry.workspace_id = target_workspace_id;
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
      entry.provider_name,
      entry.model_name,
      entry.call_purpose,
      count(*) filter (
        where entry.state = 'finalized'
          and not entry.usage_estimated
      ) as finalized_call_count,
      coalesce(sum(entry.billed_input_tokens) filter (
        where entry.state = 'finalized'
          and not entry.usage_estimated
      ), 0)::bigint as finalized_input_tokens,
      coalesce(sum(entry.billed_output_tokens) filter (
        where entry.state = 'finalized'
          and not entry.usage_estimated
      ), 0)::bigint as finalized_output_tokens,
      coalesce(sum(entry.actual_microusd) filter (
        where entry.state = 'finalized'
          and not entry.usage_estimated
      ), 0)::bigint as finalized_actual_microusd,
      count(*) filter (
        where entry.state = 'finalized'
          and entry.usage_estimated
      ) as estimated_call_count,
      coalesce(sum(entry.actual_microusd) filter (
        where entry.state = 'finalized'
          and entry.usage_estimated
      ), 0)::bigint as estimated_maximum_microusd,
      count(*) filter (where entry.state = 'reserved')
        as reserved_call_count,
      coalesce(sum(entry.reserved_microusd)
        filter (where entry.state = 'reserved'), 0)::bigint
        as reserved_microusd,
      count(*) filter (where entry.state = 'released')
        as released_call_count
    from app_private.ai_spend_accounting_entries() entry
    where entry.billing_month = selected_month
      and (
        target_workspace_id is null
        or entry.workspace_id = target_workspace_id
      )
    group by entry.provider_name, entry.model_name, entry.call_purpose
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

comment on function app_private.ai_spend_accounting_entries() is
  'Private content-free accounting union; active evidence wins if an original reservation ID is ever present in both sources.';
