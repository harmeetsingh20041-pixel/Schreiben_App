begin;

select plan(11);

select ok(
  to_regnamespace('cron') is not null,
  'pg_cron is installed during a clean migration replay'
);

select is(
  (
    select count(*)::integer
    from cron.job
    where jobname in (
      'reconcile-writing-jobs-every-30-seconds',
      'reconcile-worksheet-generation-every-30-seconds',
      'reconcile-worksheet-evaluation-every-30-seconds',
      'reconcile-ai-spend-reservations-every-30-seconds',
      'drain-practice-cycle-transitions-every-30-seconds',
      'release-due-feedback-every-30-seconds'
    )
  ),
  6,
  'all six V1 database recovery jobs exist exactly once'
);

select ok(
  (
    select bool_and(active and schedule = '30 seconds')
    from cron.job
    where jobname in (
      'reconcile-writing-jobs-every-30-seconds',
      'reconcile-worksheet-generation-every-30-seconds',
      'reconcile-worksheet-evaluation-every-30-seconds',
      'reconcile-ai-spend-reservations-every-30-seconds',
      'drain-practice-cycle-transitions-every-30-seconds',
      'release-due-feedback-every-30-seconds'
    )
  ),
  'every V1 recovery job is active on the required sub-minute cadence'
);

select is(
  (
    select regexp_replace(command, '[[:space:]]+', ' ', 'g')
    from cron.job
    where jobname = 'reconcile-writing-jobs-every-30-seconds'
  ),
  $command$select app_private.reconcile_async_jobs_internal('writing_evaluation');$command$,
  'the writing recovery job invokes only the fixed private writing reconciler'
);

select is(
  (
    select regexp_replace(command, '[[:space:]]+', ' ', 'g')
    from cron.job
    where jobname = 'reconcile-worksheet-generation-every-30-seconds'
  ),
  $command$select app_private.reconcile_async_jobs_internal('worksheet_generation');$command$,
  'the worksheet-generation recovery job invokes only its fixed private reconciler'
);

select is(
  (
    select regexp_replace(command, '[[:space:]]+', ' ', 'g')
    from cron.job
    where jobname = 'reconcile-worksheet-evaluation-every-30-seconds'
  ),
  $command$select app_private.reconcile_async_jobs_internal('worksheet_answer_evaluation');$command$,
  'the answer-evaluation recovery job invokes only its fixed private reconciler'
);

select is(
  (
    select regexp_replace(command, '[[:space:]]+', ' ', 'g')
    from cron.job
    where jobname = 'reconcile-ai-spend-reservations-every-30-seconds'
  ),
  $command$select app_private.reconcile_expired_ai_spend_reservations_internal(100, null);$command$,
  'the spend recovery job invokes only the bounded private estimator'
);

select is(
  (
    select regexp_replace(command, '[[:space:]]+', ' ', 'g')
    from cron.job
    where jobname = 'drain-practice-cycle-transitions-every-30-seconds'
  ),
  $command$select app_private.process_practice_cycle_transition_jobs(50);$command$,
  'the practice transition recovery job invokes only the bounded private outbox processor'
);

select is(
  (
    select regexp_replace(command, '[[:space:]]+', ' ', 'g')
    from cron.job
    where jobname = 'release-due-feedback-every-30-seconds'
  ),
  $command$select app_private.release_due_feedback_internal(100);$command$,
  'the release job invokes only the bounded private scheduled-release function'
);

select ok(
  not exists (
    select 1
    from cron.job
    where jobname in (
      'process-due-feedback-every-5-minutes',
      'process-writing-jobs-every-5-minutes',
      'process-worksheet-jobs-every-5-minutes'
    )
  ),
  'legacy five-minute processors are absent from the final schedule'
);

select ok(
  not exists (
    select 1
    from cron.job
    where jobname in (
      'reconcile-writing-jobs-every-30-seconds',
      'reconcile-worksheet-generation-every-30-seconds',
      'reconcile-worksheet-evaluation-every-30-seconds',
      'reconcile-ai-spend-reservations-every-30-seconds',
      'drain-practice-cycle-transitions-every-30-seconds',
      'release-due-feedback-every-30-seconds'
    )
      and command ~* '(net[.]http|functions/v1|process_recovery_secret|service_role)'
  ),
  'database Cron commands contain no HTTP endpoint or deployment secret'
);

select * from finish(true);
rollback;
