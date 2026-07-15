-- RETIRED OPERATOR ENTRY POINT.
--
-- Scheduled release and queue reconciliation are installed exclusively by
-- migration 20260710191319_install_queue_recovery_cron.sql. Queue consumers
-- are awakened by the separately configured external recovery scheduler.
-- Keeping this file as a fail-closed sentinel prevents an old runbook or saved
-- command from recreating the obsolete network scheduler.

do $retired$
begin
  raise exception using
    errcode = '0A000',
    message = 'This Phase 6C setup entry point is retired.',
    hint = 'Replay the complete migration history and configure the external recover-async-jobs scheduler.';
end;
$retired$;
