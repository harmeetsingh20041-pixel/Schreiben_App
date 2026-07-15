-- Hosted PGMQ returns SETOF bigint from pgmq.send. The retry transition is a
-- third live send path and must name that scalar explicitly, just like enqueue
-- and missing-message reconciliation.

create or replace function public.fail_async_job(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  error_code text,
  retryable boolean default true
)
returns table (
  job_id uuid,
  status text,
  attempt_count integer,
  next_attempt_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  safe_error_code text;
  retry_delay integer;
  next_message_id bigint;
  selected_worker_id uuid := worker_id;
begin
  perform app_private.assert_service_role();

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  safe_error_code := left(
    trim(
      both '_'
      from regexp_replace(
        lower(coalesce(error_code, 'job_failed')),
        '[^a-z0-9_]+',
        '_',
        'g'
      )
    ),
    80
  );
  if safe_error_code = '' then
    safe_error_code := 'job_failed';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job.id is null then
    raise exception using errcode = '02000', message = 'Job not found.';
  end if;

  if selected_job.status in ('succeeded', 'dead', 'retry') then
    return query
    select
      selected_job.id,
      selected_job.status,
      selected_job.attempt_count,
      case
        when selected_job.status = 'retry' then selected_job.available_at
        else null
      end;
    return;
  end if;

  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> selected_worker_id
  then
    raise exception using errcode = '55000', message = 'Job lease is no longer active.';
  end if;

  perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);

  if coalesce(retryable, true) and selected_job.attempt_count < 3 then
    retry_delay := least(
      60,
      5 * (2 ^ greatest(selected_job.attempt_count - 1, 0))::integer
    );

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

    update app_private.async_jobs job
    set
      status = 'retry',
      queue_message_id = next_message_id,
      worker_id = null,
      lease_expires_at = null,
      available_at = now() + make_interval(secs => retry_delay),
      last_error_code = safe_error_code
    where job.id = selected_job.id
    returning job.* into selected_job;

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'queued',
      null
    );
  else
    update app_private.async_jobs job
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = safe_error_code
    where job.id = selected_job.id
    returning job.* into selected_job;

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'failed',
      safe_error_code
    );
  end if;

  return query
  select
    selected_job.id,
    selected_job.status,
    selected_job.attempt_count,
    case
      when selected_job.status = 'retry' then selected_job.available_at
      else null
    end;
end;
$$;

revoke all on function public.fail_async_job(uuid, bigint, uuid, text, boolean)
from public, anon, authenticated;
grant execute on function public.fail_async_job(uuid, bigint, uuid, text, boolean)
to service_role;
