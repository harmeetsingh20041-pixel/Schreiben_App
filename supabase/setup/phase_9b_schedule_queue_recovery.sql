-- Database-side recovery bookkeeping without pg_net.
--
-- Production must also configure an external scheduler to POST an empty body
-- to /functions/v1/recover-async-jobs every 30 seconds with the header:
--   x-process-recovery-secret: <PROCESS_RECOVERY_SECRET>
-- The deployment preflight treats a missing or stale external heartbeat as a
-- hard launch failure. No student content is sent in this request.

create extension if not exists pg_cron;

do $$
declare
  job_name text;
begin
  foreach job_name in array array[
    'reconcile-writing-jobs-every-30-seconds',
    'reconcile-worksheet-generation-every-30-seconds',
    'reconcile-worksheet-evaluation-every-30-seconds'
  ]
  loop
    if exists (select 1 from cron.job where jobname = job_name) then
      perform cron.unschedule(job_name);
    end if;
  end loop;

  perform cron.schedule(
    'reconcile-writing-jobs-every-30-seconds',
    '30 seconds',
    $cron$select app_private.reconcile_async_jobs_internal('writing_evaluation');$cron$
  );
  perform cron.schedule(
    'reconcile-worksheet-generation-every-30-seconds',
    '30 seconds',
    $cron$select app_private.reconcile_async_jobs_internal('worksheet_generation');$cron$
  );
  perform cron.schedule(
    'reconcile-worksheet-evaluation-every-30-seconds',
    '30 seconds',
    $cron$select app_private.reconcile_async_jobs_internal('worksheet_answer_evaluation');$cron$
  );
end;
$$;
