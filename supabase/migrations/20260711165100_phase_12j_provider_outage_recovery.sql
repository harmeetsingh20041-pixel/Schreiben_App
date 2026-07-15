-- Phase 12J: bounded automatic recovery when both configured AI providers are
-- transiently unavailable.
--
-- This lane is deliberately separate from the ordinary three delivery
-- attempts. Workers may enter it only after they have classified both provider
-- routes as transport/timeout/rate-limit/5xx failures. Credentials, disabled
-- failover, malformed content, deterministic validation, and quality failures
-- remain on the ordinary bounded path.

alter table app_private.async_jobs
  add column if not exists provider_outage_epoch integer not null default 0,
  add column if not exists provider_outage_recovery_count integer not null default 0,
  add column if not exists provider_outage_started_at timestamptz,
  add column if not exists provider_outage_deadline_at timestamptz,
  add column if not exists provider_outage_retry_at timestamptz,
  add column if not exists provider_outage_recovered_at timestamptz,
  add column if not exists provider_outage_exhausted_at timestamptz,
  add column if not exists provider_outage_last_reason text;

-- These source-row fields expose only a provider-neutral recovery time. They
-- contain no model/provider/error information and let existing authorized
-- read models present a truthful delayed state without reading async_jobs.
alter table public.submissions
  add column if not exists automatic_retry_at timestamptz,
  add column if not exists automatic_retry_exhausted_at timestamptz;

alter table public.student_practice_assignments
  add column if not exists automatic_retry_at timestamptz,
  add column if not exists automatic_retry_exhausted_at timestamptz;

alter table public.practice_test_attempts
  add column if not exists automatic_retry_at timestamptz,
  add column if not exists automatic_retry_exhausted_at timestamptz;

alter table public.submissions
  drop constraint if exists submissions_automatic_retry_shape_check,
  add constraint submissions_automatic_retry_shape_check check (
    not (
      automatic_retry_at is not null
      and automatic_retry_exhausted_at is not null
    )
  );

alter table public.student_practice_assignments
  drop constraint if exists practice_assignments_automatic_retry_shape_check,
  add constraint practice_assignments_automatic_retry_shape_check check (
    not (
      automatic_retry_at is not null
      and automatic_retry_exhausted_at is not null
    )
  );

alter table public.practice_test_attempts
  drop constraint if exists practice_attempts_automatic_retry_shape_check,
  add constraint practice_attempts_automatic_retry_shape_check check (
    not (
      automatic_retry_at is not null
      and automatic_retry_exhausted_at is not null
    )
  );

alter table app_private.async_jobs
  drop constraint if exists async_jobs_provider_outage_shape_check,
  add constraint async_jobs_provider_outage_shape_check check (
    (
      provider_outage_epoch = 0
      and provider_outage_recovery_count = 0
      and provider_outage_started_at is null
      and provider_outage_deadline_at is null
      and provider_outage_retry_at is null
      and provider_outage_recovered_at is null
      and provider_outage_exhausted_at is null
      and provider_outage_last_reason is null
    )
    or (
      provider_outage_epoch = 1
      and provider_outage_recovery_count between 1 and 10
      and provider_outage_started_at is not null
      and provider_outage_deadline_at is not null
      and provider_outage_deadline_at
        = provider_outage_started_at + interval '24 hours'
      and not (
        provider_outage_recovered_at is not null
        and provider_outage_exhausted_at is not null
      )
      and provider_outage_last_reason in (
        'dual_provider_outage_unavailable',
        'dual_provider_outage_rate_limited',
        'dual_provider_outage_timeout'
      )
    )
  );

create index if not exists async_jobs_provider_outage_delayed_idx
on app_private.async_jobs (provider_outage_retry_at, queue_name, created_at)
where status = 'retry' and provider_outage_retry_at is not null;

create index if not exists async_jobs_provider_outage_exhausted_idx
on app_private.async_jobs (provider_outage_exhausted_at desc, queue_name)
where provider_outage_exhausted_at is not null;

create table if not exists app_private.provider_outage_recovery_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null
    references app_private.async_jobs(id) on delete restrict,
  predecessor_job_id uuid
    references app_private.async_jobs(id) on delete restrict,
  event_kind text not null check (
    event_kind in (
      'scheduled',
      'exhausted',
      'recovered',
      'terminated_non_outage',
      'manual_retry'
    )
  ),
  retry_number integer not null check (retry_number between 0 and 10),
  scheduled_for timestamptz,
  reason_code text not null check (
    reason_code in (
      'dual_provider_outage_unavailable',
      'dual_provider_outage_rate_limited',
      'dual_provider_outage_timeout',
      'provider_outage_recovery_exhausted',
      'provider_outage_recovered',
      'provider_outage_terminated_non_outage',
      'provider_outage_manual_retry'
    )
  ),
  actor_id uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint provider_outage_recovery_events_shape_check check (
    (
      event_kind = 'scheduled'
      and retry_number between 1 and 10
      and scheduled_for is not null
      and predecessor_job_id is null
      and actor_id is null
    )
    or (
      event_kind = 'exhausted'
      and scheduled_for is null
      and predecessor_job_id is null
      and actor_id is null
    )
    or (
      event_kind = 'recovered'
      and scheduled_for is null
      and predecessor_job_id is null
      and actor_id is null
    )
    or (
      event_kind = 'terminated_non_outage'
      and scheduled_for is null
      and predecessor_job_id is null
      and actor_id is null
    )
    or (
      event_kind = 'manual_retry'
      and retry_number = 0
      and scheduled_for is null
      and predecessor_job_id is not null
      and actor_id is not null
    )
  ),
  constraint provider_outage_recovery_events_job_kind_retry_key
    unique (job_id, event_kind, retry_number)
);

create index if not exists provider_outage_recovery_events_job_created_idx
on app_private.provider_outage_recovery_events (job_id, created_at, id);

create index if not exists provider_outage_recovery_events_exhausted_idx
on app_private.provider_outage_recovery_events (created_at desc, job_id)
where event_kind = 'exhausted';

alter table app_private.provider_outage_recovery_events enable row level security;

revoke all on table app_private.provider_outage_recovery_events
from public, anon, authenticated, service_role;

drop trigger if exists provider_outage_recovery_events_immutable
on app_private.provider_outage_recovery_events;
create trigger provider_outage_recovery_events_immutable
before update or delete on app_private.provider_outage_recovery_events
for each row execute function app_private.reject_adaptive_history_mutation();

create or replace function app_private.provider_outage_retry_delay_seconds(
  retry_number integer
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case retry_number
    when 1 then 60
    when 2 then 300
    when 3 then 900
    when 4 then 1800
    when 5 then 3600
    when 6 then 7200
    when 7 then 14400
    else 21600
  end
  where retry_number between 1 and 10;
$$;

revoke all on function app_private.provider_outage_retry_delay_seconds(integer)
from public, anon, authenticated, service_role;

create or replace function app_private.set_job_entity_recovery_state(
  target_job_kind text,
  target_entity_id uuid,
  target_entity_version integer,
  target_retry_at timestamptz,
  target_exhausted_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_retry_at is not null and target_exhausted_at is not null then
    raise exception using
      errcode = '22023',
      message = 'automatic_retry_state_invalid';
  end if;

  if target_job_kind = 'writing_evaluation' then
    update public.submissions submission
    set
      automatic_retry_at = target_retry_at,
      automatic_retry_exhausted_at = target_exhausted_at
    where submission.id = target_entity_id
      and submission.evaluation_version = target_entity_version;
  elsif target_job_kind = 'worksheet_generation' then
    update public.student_practice_assignments assignment
    set
      automatic_retry_at = target_retry_at,
      automatic_retry_exhausted_at = target_exhausted_at
    where assignment.id = target_entity_id
      and assignment.generation_version = target_entity_version;
  elsif target_job_kind = 'worksheet_answer_evaluation' then
    update public.practice_test_attempts attempt
    set
      automatic_retry_at = target_retry_at,
      automatic_retry_exhausted_at = target_exhausted_at
    where attempt.id = target_entity_id
      and attempt.evaluation_version = target_entity_version;
  else
    raise exception using
      errcode = '22023',
      message = 'unsupported_job_kind';
  end if;
end;
$$;

revoke all on function app_private.set_job_entity_recovery_state(
  text, uuid, integer, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

create or replace function app_private.normalize_async_job_provider_outage_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'processing'
    and old.status = 'retry'
    and old.provider_outage_epoch = 1
  then
    new.provider_outage_retry_at := null;
    perform app_private.set_job_entity_recovery_state(
      new.job_kind,
      new.entity_id,
      new.entity_version,
      null,
      null
    );
  end if;

  if new.status = 'succeeded' and old.status <> 'succeeded'
    and new.provider_outage_epoch = 1
  then
    new.provider_outage_retry_at := null;
    new.provider_outage_recovered_at := coalesce(
      new.provider_outage_recovered_at,
      now()
    );
  elsif new.status = 'dead' then
    new.provider_outage_retry_at := null;
  end if;

  return new;
end;
$$;

revoke all on function app_private.normalize_async_job_provider_outage_state()
from public, anon, authenticated, service_role;

drop trigger if exists async_jobs_normalize_provider_outage_state
on app_private.async_jobs;
create trigger async_jobs_normalize_provider_outage_state
before update on app_private.async_jobs
for each row execute function app_private.normalize_async_job_provider_outage_state();

create or replace function app_private.record_async_job_provider_outage_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'succeeded' and old.status <> 'succeeded'
    and new.provider_outage_epoch = 1
  then
    perform app_private.set_job_entity_recovery_state(
      new.job_kind,
      new.entity_id,
      new.entity_version,
      null,
      null
    );
    insert into app_private.provider_outage_recovery_events (
      job_id,
      event_kind,
      retry_number,
      reason_code
    ) values (
      new.id,
      'recovered',
      new.provider_outage_recovery_count,
      'provider_outage_recovered'
    )
    on conflict on constraint
      provider_outage_recovery_events_job_kind_retry_key do nothing;
  elsif new.status = 'dead'
    and old.status <> 'dead'
    and new.provider_outage_epoch = 1
    and new.provider_outage_exhausted_at is null
  then
    perform app_private.set_job_entity_recovery_state(
      new.job_kind,
      new.entity_id,
      new.entity_version,
      null,
      null
    );
    insert into app_private.provider_outage_recovery_events (
      job_id,
      event_kind,
      retry_number,
      reason_code
    ) values (
      new.id,
      'terminated_non_outage',
      new.provider_outage_recovery_count,
      'provider_outage_terminated_non_outage'
    )
    on conflict on constraint
      provider_outage_recovery_events_job_kind_retry_key do nothing;
  end if;

  return new;
end;
$$;

revoke all on function app_private.record_async_job_provider_outage_event()
from public, anon, authenticated, service_role;

drop trigger if exists async_jobs_record_provider_outage_event
on app_private.async_jobs;
create trigger async_jobs_record_provider_outage_event
after update on app_private.async_jobs
for each row execute function app_private.record_async_job_provider_outage_event();

create or replace function app_private.record_provider_outage_manual_retry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  predecessor app_private.async_jobs%rowtype;
begin
  if new.requested_by is null then
    return new;
  end if;

  select prior.*
  into predecessor
  from app_private.async_jobs prior
  where prior.job_kind = new.job_kind
    and prior.entity_id = new.entity_id
    and prior.entity_version = new.entity_version - 1
    and prior.status = 'dead'
    and prior.provider_outage_exhausted_at is not null
  order by prior.entity_version desc
  limit 1;

  if predecessor.id is not null then
    perform app_private.set_job_entity_recovery_state(
      new.job_kind,
      new.entity_id,
      new.entity_version,
      null,
      null
    );
    insert into app_private.provider_outage_recovery_events (
      job_id,
      predecessor_job_id,
      event_kind,
      retry_number,
      reason_code,
      actor_id
    ) values (
      new.id,
      predecessor.id,
      'manual_retry',
      0,
      'provider_outage_manual_retry',
      new.requested_by
    )
    on conflict on constraint
      provider_outage_recovery_events_job_kind_retry_key do nothing;
  end if;

  return new;
end;
$$;

revoke all on function app_private.record_provider_outage_manual_retry()
from public, anon, authenticated, service_role;

drop trigger if exists async_jobs_record_provider_outage_manual_retry
on app_private.async_jobs;
create trigger async_jobs_record_provider_outage_manual_retry
after insert on app_private.async_jobs
for each row execute function app_private.record_provider_outage_manual_retry();

create or replace function public.defer_async_job_for_provider_outage(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  outage_reason text
)
returns table (
  job_id uuid,
  status text,
  attempt_count integer,
  next_attempt_at timestamptz,
  outage_retry_count integer,
  outage_deadline_at timestamptz,
  outage_exhausted boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  safe_reason text := lower(btrim(coalesce(outage_reason, '')));
  selected_worker_id uuid := worker_id;
  epoch_started_at timestamptz;
  epoch_deadline_at timestamptz;
  scheduled_at timestamptz;
  next_retry_number integer;
  retry_delay integer;
  remaining_seconds integer;
  next_message_id bigint;
begin
  perform app_private.assert_service_role();

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  if safe_reason not in (
    'dual_provider_outage_unavailable',
    'dual_provider_outage_rate_limited',
    'dual_provider_outage_timeout'
  ) then
    raise exception using
      errcode = '22023',
      message = 'provider_outage_classification_invalid';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job.id is null then
    raise exception using errcode = '02000', message = 'Job not found.';
  end if;

  -- A lost HTTP response may replay the transition. Return the durable state
  -- without archiving/sending another message or duplicating audit evidence.
  if selected_job.status = 'retry'
    and selected_job.provider_outage_epoch = 1
    and selected_job.provider_outage_recovery_count between 1 and 10
    and selected_job.provider_outage_last_reason = safe_reason
  then
    return query
    select
      selected_job.id,
      selected_job.status,
      selected_job.attempt_count,
      case
        when selected_job.status = 'retry' then selected_job.available_at
        else null
      end,
      selected_job.provider_outage_recovery_count,
      selected_job.provider_outage_deadline_at,
      selected_job.provider_outage_exhausted_at is not null;
    return;
  end if;

  if selected_job.status = 'dead'
    and selected_job.provider_outage_exhausted_at is not null
    and selected_job.provider_outage_last_reason = safe_reason
  then
    return query
    select
      selected_job.id,
      selected_job.status,
      selected_job.attempt_count,
      null::timestamptz,
      selected_job.provider_outage_recovery_count,
      selected_job.provider_outage_deadline_at,
      true;
    return;
  end if;

  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> selected_worker_id
  then
    raise exception using
      errcode = '55000',
      message = 'Job lease is no longer active.';
  end if;

  epoch_started_at := coalesce(selected_job.provider_outage_started_at, now());
  epoch_deadline_at := coalesce(
    selected_job.provider_outage_deadline_at,
    epoch_started_at + interval '24 hours'
  );
  remaining_seconds := greatest(
    0,
    floor(extract(epoch from (epoch_deadline_at - now())))::integer
  );

  if selected_job.provider_outage_recovery_count >= 10
    or remaining_seconds <= 0
  then
    update app_private.async_jobs job
    set
      status = 'dead',
      attempt_count = greatest(job.attempt_count - 1, 0),
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'provider_outage_recovery_exhausted',
      provider_outage_epoch = 1,
      provider_outage_started_at = epoch_started_at,
      provider_outage_deadline_at = epoch_deadline_at,
      provider_outage_retry_at = null,
      provider_outage_recovered_at = null,
      provider_outage_exhausted_at = now(),
      provider_outage_last_reason = safe_reason
    where job.id = selected_job.id
    returning job.* into selected_job;

    perform pgmq.archive(
      selected_job.queue_name,
      target_queue_message_id
    );

    perform app_private.set_job_entity_recovery_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      null,
      selected_job.provider_outage_exhausted_at
    );

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'failed',
      'provider_outage_recovery_exhausted'
    );

    insert into app_private.provider_outage_recovery_events (
      job_id,
      event_kind,
      retry_number,
      reason_code
    ) values (
      selected_job.id,
      'exhausted',
      selected_job.provider_outage_recovery_count,
      'provider_outage_recovery_exhausted'
    )
    on conflict on constraint
      provider_outage_recovery_events_job_kind_retry_key do nothing;
  else
    next_retry_number := selected_job.provider_outage_recovery_count + 1;
    retry_delay := least(
      app_private.provider_outage_retry_delay_seconds(next_retry_number),
      remaining_seconds
    );
    retry_delay := greatest(1, retry_delay);
    scheduled_at := now() + make_interval(secs => retry_delay);

    select sent.message_id
    into next_message_id
    from pgmq.send(
      selected_job.queue_name,
      jsonb_build_object(
        'job_id', selected_job.id,
        'job_kind', selected_job.job_kind,
        'entity_id', selected_job.entity_id,
        'entity_version', selected_job.entity_version
      ),
      retry_delay
    ) as sent(message_id);

    perform pgmq.archive(
      selected_job.queue_name,
      selected_job.queue_message_id
    );

    update app_private.async_jobs job
    set
      status = 'retry',
      attempt_count = greatest(job.attempt_count - 1, 0),
      queue_message_id = next_message_id,
      worker_id = null,
      lease_expires_at = null,
      available_at = scheduled_at,
      last_error_code = safe_reason,
      provider_outage_epoch = 1,
      provider_outage_recovery_count = next_retry_number,
      provider_outage_started_at = epoch_started_at,
      provider_outage_deadline_at = epoch_deadline_at,
      provider_outage_retry_at = scheduled_at,
      provider_outage_recovered_at = null,
      provider_outage_exhausted_at = null,
      provider_outage_last_reason = safe_reason
    where job.id = selected_job.id
    returning job.* into selected_job;

    perform app_private.set_job_entity_recovery_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      selected_job.provider_outage_retry_at,
      null
    );

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'queued',
      null
    );

    insert into app_private.provider_outage_recovery_events (
      job_id,
      event_kind,
      retry_number,
      scheduled_for,
      reason_code
    ) values (
      selected_job.id,
      'scheduled',
      next_retry_number,
      scheduled_at,
      safe_reason
    )
    on conflict on constraint
      provider_outage_recovery_events_job_kind_retry_key do nothing;
  end if;

  return query
  select
    selected_job.id,
    selected_job.status,
    selected_job.attempt_count,
    case
      when selected_job.status = 'retry' then selected_job.available_at
      else null
    end,
    selected_job.provider_outage_recovery_count,
    selected_job.provider_outage_deadline_at,
    selected_job.provider_outage_exhausted_at is not null;
end;
$$;

revoke all on function public.defer_async_job_for_provider_outage(
  uuid, bigint, uuid, text
) from public, anon, authenticated;
grant execute on function public.defer_async_job_for_provider_outage(
  uuid, bigint, uuid, text
) to service_role;

create or replace function api.defer_async_job_for_provider_outage(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  outage_reason text
)
returns table (
  job_id uuid,
  status text,
  attempt_count integer,
  next_attempt_at timestamptz,
  outage_retry_count integer,
  outage_deadline_at timestamptz,
  outage_exhausted boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.defer_async_job_for_provider_outage(
    target_job_id,
    target_queue_message_id,
    worker_id,
    outage_reason
  );
$$;

revoke all on function api.defer_async_job_for_provider_outage(
  uuid, bigint, uuid, text
) from public, anon, authenticated;
grant execute on function api.defer_async_job_for_provider_outage(
  uuid, bigint, uuid, text
) to service_role;

-- Missing-message repair must preserve a future outage retry timestamp. An
-- external recovery tick may replace a lost message, but it must not collapse
-- a 24-hour backoff into an immediate provider call.
create or replace function app_private.reconcile_async_job(target_job_id uuid)
returns app_private.async_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  replacement_message_id bigint;
  replacement_delay integer;
  replacement_available_at timestamptz;
begin
  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job.id is null
    or selected_job.status not in ('queued', 'retry', 'processing')
    or (
      selected_job.queue_message_id is not null
      and app_private.queue_message_exists(
        selected_job.queue_name,
        selected_job.queue_message_id
      )
    )
  then
    return selected_job;
  end if;

  if selected_job.attempt_count >= 3 then
    update app_private.async_jobs job
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'queue_message_missing'
    where job.id = selected_job.id
    returning job.* into selected_job;

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'failed',
      'queue_message_missing'
    );
    return selected_job;
  end if;

  replacement_available_at := greatest(now(), selected_job.available_at);
  replacement_delay := greatest(
    0,
    ceil(extract(epoch from (replacement_available_at - now())))::integer
  );

  select sent.message_id
  into replacement_message_id
  from pgmq.send(
    selected_job.queue_name,
    jsonb_build_object(
      'job_id', selected_job.id,
      'job_kind', selected_job.job_kind,
      'entity_id', selected_job.entity_id,
      'entity_version', selected_job.entity_version
    ),
    replacement_delay
  ) as sent(message_id);

  update app_private.async_jobs job
  set
    status = 'retry',
    queue_message_id = replacement_message_id,
    worker_id = null,
    lease_expires_at = null,
    available_at = replacement_available_at,
    provider_outage_retry_at = case
      when job.provider_outage_retry_at is not null
        then replacement_available_at
      else null
    end,
    last_error_code = 'queue_message_reconciled'
  where job.id = selected_job.id
  returning job.* into selected_job;

  perform app_private.set_job_entity_state(
    selected_job.job_kind,
    selected_job.entity_id,
    selected_job.entity_version,
    'queued',
    null
  );

  return selected_job;
end;
$$;

revoke all on function app_private.reconcile_async_job(uuid)
from public, anon, authenticated, service_role;

create or replace function public.get_provider_outage_recovery_metrics()
returns table (
  queue_name text,
  delayed_jobs bigint,
  oldest_retry_at timestamptz,
  exhausted_jobs_24h bigint,
  terminated_non_outage_jobs_24h bigint
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  perform app_private.assert_service_role();

  return query
  with queues(queue_name) as (
    values
      ('writing_evaluation'::text),
      ('worksheet_generation'::text),
      ('worksheet_answer_evaluation'::text)
  )
  select
    queues.queue_name,
    count(job.id) filter (
      where job.status = 'retry'
        and job.provider_outage_retry_at is not null
    )::bigint,
    min(job.provider_outage_retry_at) filter (
      where job.status = 'retry'
        and job.provider_outage_retry_at is not null
    ),
    count(job.id) filter (
      where job.provider_outage_exhausted_at >= now() - interval '24 hours'
    )::bigint,
    count(job.id) filter (
      where exists (
        select 1
        from app_private.provider_outage_recovery_events event
        where event.job_id = job.id
          and event.event_kind = 'terminated_non_outage'
          and event.created_at >= now() - interval '24 hours'
      )
    )::bigint
  from queues
  left join app_private.async_jobs job
    on job.queue_name = queues.queue_name
  group by queues.queue_name
  order by queues.queue_name;
end;
$$;

revoke all on function public.get_provider_outage_recovery_metrics()
from public, anon, authenticated;
grant execute on function public.get_provider_outage_recovery_metrics()
to service_role;

create or replace function api.get_provider_outage_recovery_metrics()
returns table (
  queue_name text,
  delayed_jobs bigint,
  oldest_retry_at timestamptz,
  exhausted_jobs_24h bigint,
  terminated_non_outage_jobs_24h bigint
)
language sql
security invoker
set search_path = ''
stable
as $$
  select * from public.get_provider_outage_recovery_metrics();
$$;

revoke all on function api.get_provider_outage_recovery_metrics()
from public, anon, authenticated;
grant execute on function api.get_provider_outage_recovery_metrics()
to service_role;

create or replace function public.get_async_claimable_queue_metrics()
returns table (
  queue_name text,
  claimable_jobs bigint,
  claimable_messages bigint
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  perform app_private.assert_service_role();

  return query
  with job_counts as (
    select
      job.queue_name,
      count(*) filter (
        where (
          job.status in ('queued', 'retry')
          and job.available_at <= now()
        ) or (
          job.status = 'processing'
          and job.lease_expires_at <= now()
        )
      )::bigint as claimable_jobs
    from app_private.async_jobs job
    group by job.queue_name
  ), message_counts(queue_name, claimable_messages) as (
    values
      (
        'writing_evaluation'::text,
        (select count(*)::bigint from pgmq.q_writing_evaluation message
         where message.vt <= now())
      ),
      (
        'worksheet_generation'::text,
        (select count(*)::bigint from pgmq.q_worksheet_generation message
         where message.vt <= now())
      ),
      (
        'worksheet_answer_evaluation'::text,
        (select count(*)::bigint
         from pgmq.q_worksheet_answer_evaluation message
         where message.vt <= now())
      )
  )
  select
    message_counts.queue_name,
    coalesce(job_counts.claimable_jobs, 0),
    message_counts.claimable_messages
  from message_counts
  left join job_counts using (queue_name)
  order by message_counts.queue_name;
end;
$$;

revoke all on function public.get_async_claimable_queue_metrics()
from public, anon, authenticated;
grant execute on function public.get_async_claimable_queue_metrics()
to service_role;

create or replace function api.get_async_claimable_queue_metrics()
returns table (
  queue_name text,
  claimable_jobs bigint,
  claimable_messages bigint
)
language sql
security invoker
set search_path = ''
stable
as $$
  select * from public.get_async_claimable_queue_metrics();
$$;

revoke all on function api.get_async_claimable_queue_metrics()
from public, anon, authenticated;
grant execute on function api.get_async_claimable_queue_metrics()
to service_role;

comment on table app_private.provider_outage_recovery_events is
  'Immutable content-free audit of bounded dual-provider outage scheduling, exhaustion, recovery, and manual retry.';
comment on function api.defer_async_job_for_provider_outage(
  uuid, bigint, uuid, text
) is
  'Service-only idempotent provider-outage transition. Queue payloads contain identifiers and version only.';
comment on function api.get_provider_outage_recovery_metrics() is
  'Service-only content-free delayed/exhausted provider recovery metrics.';
comment on function api.get_async_claimable_queue_metrics() is
  'Service-only due-job and visible-message counts for bounded recovery fan-out; delayed messages do not wake workers.';

-- Extend the existing actor-authorized JSON projections without creating a
-- second browser request. Fail closed if an earlier migration changes the
-- exact projection anchor: silent omission would make the UI untruthful.
do $phase_12j_patch_submission_detail$
declare
  function_definition text;
  original_fragment text := $old$
    'evaluation_version', selected_submission.evaluation_version,
$old$;
  replacement_fragment text := $new$
    'evaluation_version', selected_submission.evaluation_version,
    'automatic_retry_at', selected_submission.automatic_retry_at,
    'automatic_retry_exhausted_at', selected_submission.automatic_retry_exhausted_at,
$new$;
begin
  select pg_get_functiondef(
    'api.get_submission_detail(uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(original_fragment in function_definition) = 0
    or length(function_definition) - length(replace(
      function_definition,
      original_fragment,
      ''
    )) <> length(original_fragment)
  then
    raise exception using
      errcode = '55000',
      message = 'submission_recovery_projection_anchor_changed';
  end if;

  execute replace(
    function_definition,
    original_fragment,
    replacement_fragment
  );
end;
$phase_12j_patch_submission_detail$;

do $phase_12j_patch_practice_summary$
declare
  function_definition text;
  generation_fragment text := $old$
    'generation_status', assignment.generation_status,
$old$;
  generation_replacement text := $new$
    'generation_status', assignment.generation_status,
    'generation_automatic_retry_at', assignment.automatic_retry_at,
    'generation_automatic_retry_exhausted_at', assignment.automatic_retry_exhausted_at,
$new$;
  evaluation_fragment text := $old$
    'evaluation_status', attempt.evaluation_status,
$old$;
  evaluation_replacement text := $new$
    'evaluation_status', attempt.evaluation_status,
    'evaluation_automatic_retry_at', attempt.automatic_retry_at,
    'evaluation_automatic_retry_exhausted_at', attempt.automatic_retry_exhausted_at,
$new$;
begin
  select pg_get_functiondef(
    'public.get_practice_assignment_summary_internal(uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(generation_fragment in function_definition) = 0
    or position(evaluation_fragment in function_definition) = 0
    or length(function_definition) - length(replace(
      function_definition,
      generation_fragment,
      ''
    )) <> length(generation_fragment)
    or length(function_definition) - length(replace(
      function_definition,
      evaluation_fragment,
      ''
    )) <> length(evaluation_fragment)
  then
    raise exception using
      errcode = '55000',
      message = 'practice_recovery_projection_anchor_changed';
  end if;

  function_definition := replace(
    function_definition,
    generation_fragment,
    generation_replacement
  );
  function_definition := replace(
    function_definition,
    evaluation_fragment,
    evaluation_replacement
  );
  execute function_definition;
end;
$phase_12j_patch_practice_summary$;

notify pgrst, 'reload schema';
