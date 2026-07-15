-- Install the complete, secret-free database recovery schedule as migration
-- history so a clean production replay cannot omit the queue consumers.
-- Immediate Edge Function kicks remain the primary path. These jobs reconcile
-- expired/missing queue leases and release due feedback every 30 seconds.

create extension if not exists pg_cron;

do $migration$
declare
  scheduled_job record;
begin
  for scheduled_job in
    select *
    from (values
      (
        'reconcile-writing-jobs-every-30-seconds'::text,
        $command$select app_private.reconcile_async_jobs_internal('writing_evaluation');$command$::text
      ),
      (
        'reconcile-worksheet-generation-every-30-seconds'::text,
        $command$select app_private.reconcile_async_jobs_internal('worksheet_generation');$command$::text
      ),
      (
        'reconcile-worksheet-evaluation-every-30-seconds'::text,
        $command$select app_private.reconcile_async_jobs_internal('worksheet_answer_evaluation');$command$::text
      ),
      (
        'release-due-feedback-every-30-seconds'::text,
        $command$select app_private.release_due_feedback_internal(100);$command$::text
      )
    ) as expected(job_name, job_command)
  loop
    if exists (
      select 1
      from cron.job
      where jobname = scheduled_job.job_name
    ) then
      perform cron.unschedule(scheduled_job.job_name);
    end if;

    perform cron.schedule(
      scheduled_job.job_name,
      '30 seconds',
      scheduled_job.job_command
    );
  end loop;
end;
$migration$;

comment on extension pg_cron is
  'V1 recovery and scheduled-release jobs are installed through migration history.';
