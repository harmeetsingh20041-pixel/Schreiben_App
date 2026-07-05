-- Phase 6C scheduled due-feedback setup.
--
-- This file is intentionally secret-free. Before running it, store the same
-- PROCESS_FEEDBACK_SECRET value in:
-- 1. Supabase Edge Function secrets as PROCESS_FEEDBACK_SECRET
-- 2. Supabase Vault as process_due_feedback_secret

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

do $$
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'process_due_feedback_secret'
  ) then
    raise exception 'Missing Vault secret: process_due_feedback_secret';
  end if;

  if exists (
    select 1
    from cron.job
    where jobname = 'process-due-feedback-every-5-minutes'
  ) then
    perform cron.unschedule('process-due-feedback-every-5-minutes');
  end if;

  perform cron.schedule(
    'process-due-feedback-every-5-minutes',
    '*/5 * * * *',
    $cron$
      select net.http_post(
        url := 'https://vzcgalzspdehmnvqczfw.supabase.co/functions/v1/process-due-feedback?limit=3',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-process-feedback-secret', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'process_due_feedback_secret'
          )
        ),
        body := jsonb_build_object(
          'source', 'pg_cron',
          'job', 'process-due-feedback-every-5-minutes',
          'scheduled_at', now()
        ),
        timeout_milliseconds := 120000
      );
    $cron$
  );
end;
$$;
