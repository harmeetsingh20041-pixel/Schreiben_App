begin;

select plan(6);

select ok(
  to_regprocedure('api.get_async_queue_metrics()') is not null,
  'recovery has a dedicated queue-depth read model'
);

select ok(
  has_function_privilege('service_role', 'api.get_async_queue_metrics()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'api.get_async_queue_metrics()', 'EXECUTE')
    and not has_function_privilege('anon', 'api.get_async_queue_metrics()', 'EXECUTE'),
  'queue depth remains service-only'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.release_due_feedback(integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.release_due_feedback(integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.release_due_feedback(integer)',
      'EXECUTE'
    )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid = 'api.release_due_feedback(integer)'::regprocedure
    ),
  'the independent scheduled-release sweep remains a service-only invoker facade'
);

select ok(
  pg_get_functiondef(
    'app_private.release_due_feedback_internal(integer)'::regprocedure
  ) like '%least(coalesce(batch_size, 100), 500)%',
  'scheduled release honors the requested batch with a 500-row safety cap'
);

select ok(
  pg_get_functiondef(
    'app_private.release_due_feedback_internal(integer)'::regprocedure
  ) not like '%coalesce(batch_size, 25)%',
  'the obsolete 25-row release clamp is absent'
);

select ok(
  (
    select command
    from cron.job
    where jobname = 'release-due-feedback-every-30-seconds'
  ) like '%release_due_feedback_internal(100)%',
  'each 30-second release run requests 100 due drafts'
);

select * from finish();
rollback;
