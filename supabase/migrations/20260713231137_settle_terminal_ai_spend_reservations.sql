-- Conservatively settle provider calls whose exact billing outcome is still
-- unknown when their durable job reaches a terminal state. A dispatched call
-- is never released as free: the full reserved maximum remains committed and
-- is marked as estimated evidence. The existing expiry-based Cron remains the
-- independent recovery path for jobs that never reach a terminal transition.

create function app_private.finalize_terminal_ai_spend_reservations_internal(
  target_job_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job_status text;
  finalized_count integer := 0;
begin
  if target_job_id is null then
    raise exception using
      errcode = '22023',
      message = 'ai_spend_terminal_job_invalid';
  end if;

  -- Every live worker transition locks the async job before touching spend
  -- evidence. Preserve that order for the migration backfill and any later
  -- owner-only recovery call; the firing job UPDATE already owns this lock.
  select job.status
  into selected_job_status
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job_status is null
    or selected_job_status not in ('succeeded', 'dead')
  then
    return 0;
  end if;

  perform set_config('app.ai_spend_transition', 'on', true);
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
  where reservation.job_id = target_job_id
    and reservation.state = 'reserved';
  get diagnostics finalized_count = row_count;
  perform set_config('app.ai_spend_transition', 'off', true);

  return finalized_count;
end;
$$;

revoke all on function
  app_private.finalize_terminal_ai_spend_reservations_internal(uuid)
from public, anon, authenticated, service_role;

create function app_private.finalize_ai_spend_on_job_terminal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('succeeded', 'dead')
    and old.status is distinct from new.status
  then
    perform app_private.finalize_terminal_ai_spend_reservations_internal(new.id);
  end if;
  return new;
end;
$$;

revoke all on function app_private.finalize_ai_spend_on_job_terminal()
from public, anon, authenticated, service_role;

create trigger async_jobs_finalize_terminal_ai_spend
after update of status on app_private.async_jobs
for each row execute function app_private.finalize_ai_spend_on_job_terminal();

-- Settle rows left by terminal jobs before this trigger existed. Each helper
-- call takes the job lock before reservation locks, matching live transitions.
do $terminal_ai_spend_backfill$
declare
  selected_job_id uuid;
begin
  for selected_job_id in
    select distinct reservation.job_id
    from app_private.ai_spend_reservations reservation
    join app_private.async_jobs job on job.id = reservation.job_id
    where reservation.state = 'reserved'
      and job.status in ('succeeded', 'dead')
    order by reservation.job_id
  loop
    perform app_private.finalize_terminal_ai_spend_reservations_internal(
      selected_job_id
    );
  end loop;
end;
$terminal_ai_spend_backfill$;

comment on function
  app_private.finalize_terminal_ai_spend_reservations_internal(uuid)
is
  'Owner/trigger-only terminal settlement: unknown dispatched provider usage is charged at its reserved maximum and marked estimated; active jobs and already settled evidence are unchanged.';

comment on function app_private.finalize_ai_spend_on_job_terminal() is
  'Atomically settles any still-reserved AI spend at the conservative maximum when an async job first becomes succeeded or dead.';

notify pgrst, 'reload schema';
