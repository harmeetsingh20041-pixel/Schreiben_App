begin;

select plan(8);

select ok(
  not exists (select 1 from pg_extension where extname = 'pg_net'),
  'the clean database no longer installs pg_net'
);
select ok(
  to_regclass('app_private.recovery_heartbeat') is not null
    and (select relrowsecurity
         from pg_class
         where oid = 'app_private.recovery_heartbeat'::regclass)
    and not has_table_privilege(
      'authenticated',
      'app_private.recovery_heartbeat',
      'SELECT'
    ),
  'recovery heartbeat state is private with RLS defense in depth'
);
select ok(
  to_regprocedure('api.record_recovery_heartbeat(uuid)') is not null
    and to_regprocedure('api.get_recovery_health()') is not null,
  'service recovery health functions have stable signatures'
);
select ok(
  has_function_privilege(
    'service_role',
    'api.record_recovery_heartbeat(uuid)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'api.get_recovery_health()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.record_recovery_heartbeat(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_recovery_health()',
      'EXECUTE'
    ),
  'only the service role can write or inspect recovery health'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$select api.record_recovery_heartbeat('f1111111-1111-4111-8111-111111111111')$$,
  'a successful external recovery cycle can record its heartbeat'
);
select ok(
  (select heartbeat_fresh
     and not pg_net_installed
     and writing_queue_ready
     and worksheet_generation_queue_ready
     and worksheet_answer_queue_ready
   from api.get_recovery_health()),
  'recovery health proves a fresh heartbeat, all queues, and no pg_net'
);
reset role;

select is(
  (
    select last_request_id
    from app_private.recovery_heartbeat
    where singleton
  ),
  'f1111111-1111-4111-8111-111111111111'::uuid,
  'the heartbeat records only an opaque request id'
);
select is(
  (
    select count(*)
    from app_private.recovery_heartbeat
  ),
  1::bigint,
  'heartbeat updates remain a single bounded row'
);

select * from finish();
rollback;
