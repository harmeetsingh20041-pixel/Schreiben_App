-- Keep adaptive-practice progression sub-minute even when the immediate
-- answer-worker drain or the broader external recovery scheduler is down.
-- The processor is bounded, idempotent, and uses SKIP LOCKED/advisory locks;
-- this job contains no deployment secret and makes no network request.

create extension if not exists pg_cron;

do $migration$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'drain-practice-cycle-transitions-every-30-seconds'
  ) then
    perform cron.unschedule(
      'drain-practice-cycle-transitions-every-30-seconds'
    );
  end if;

  perform cron.schedule(
    'drain-practice-cycle-transitions-every-30-seconds',
    '30 seconds',
    $command$select app_private.process_practice_cycle_transition_jobs(50);$command$
  );
end;
$migration$;

comment on extension pg_cron is
  'V1 recovery and scheduled-release jobs are installed through migration history.';
