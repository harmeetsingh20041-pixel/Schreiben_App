-- pgmq.send returns SETOF bigint. Give the scalar an explicit column alias in
-- both live queue paths so hosted pgmq versions cannot resolve it as sent.send.

create or replace function app_private.enqueue_async_job(
  target_job_kind text,
  target_entity_id uuid,
  target_entity_version integer,
  target_idempotency_key text,
  target_requested_by uuid default null,
  delay_seconds integer default 0
)
returns table (job_id uuid, queue_message_id bigint, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_queue_name text := app_private.queue_name_for_kind(target_job_kind);
  selected_job app_private.async_jobs%rowtype;
  selected_message_id bigint;
begin
  if selected_queue_name is null then
    raise exception using errcode = '22023', message = 'Unsupported job kind.';
  end if;

  if target_entity_id is null or target_entity_version is null or target_entity_version < 1 then
    raise exception using errcode = '22023', message = 'Invalid job entity.';
  end if;

  if target_idempotency_key is null or length(target_idempotency_key) not between 1 and 240 then
    raise exception using errcode = '22023', message = 'Invalid idempotency key.';
  end if;

  delay_seconds := greatest(0, least(coalesce(delay_seconds, 0), 86400));

  perform pg_advisory_xact_lock(
    hashtextextended('async-job-idempotency:' || target_idempotency_key, 0)
  );

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.idempotency_key = target_idempotency_key;

  if selected_job.id is not null then
    return query
    select selected_job.id, selected_job.queue_message_id, false;
    return;
  end if;

  perform app_private.consume_ai_paid_work_budget(target_job_kind, target_entity_id);

  insert into app_private.async_jobs (
    queue_name,
    job_kind,
    entity_id,
    entity_version,
    idempotency_key,
    status,
    available_at,
    requested_by
  ) values (
    selected_queue_name,
    target_job_kind,
    target_entity_id,
    target_entity_version,
    target_idempotency_key,
    'queued',
    now() + make_interval(secs => delay_seconds),
    target_requested_by
  )
  returning * into selected_job;

  select sent.message_id
  into selected_message_id
  from pgmq.send(
    selected_queue_name,
    jsonb_build_object(
      'job_id', selected_job.id,
      'job_kind', selected_job.job_kind,
      'entity_id', selected_job.entity_id,
      'entity_version', selected_job.entity_version
    ),
    delay_seconds
  ) as sent(message_id);

  update app_private.async_jobs job
  set queue_message_id = selected_message_id
  where job.id = selected_job.id;

  return query select selected_job.id, selected_message_id, true;
end;
$$;

revoke all on function app_private.enqueue_async_job(
  text, uuid, integer, text, uuid, integer
) from public, anon, authenticated, service_role;

create or replace function app_private.reconcile_async_job(target_job_id uuid)
returns app_private.async_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  replacement_message_id bigint;
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
    0
  ) as sent(message_id);

  update app_private.async_jobs job
  set
    status = 'retry',
    queue_message_id = replacement_message_id,
    worker_id = null,
    lease_expires_at = null,
    available_at = now(),
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
