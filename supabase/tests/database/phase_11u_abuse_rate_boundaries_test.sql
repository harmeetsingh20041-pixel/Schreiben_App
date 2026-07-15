begin;

select plan(39);

select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'app_private.abuse_security_limits'::regclass)
    and (select relrowsecurity
         from pg_class
         where oid = 'app_private.practice_processor_kick_windows'::regclass)
    and (select relrowsecurity
         from pg_class
         where oid = 'app_private.batch_join_attempt_windows'::regclass)
    and not has_table_privilege(
      'authenticated',
      'app_private.practice_processor_kick_windows',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.batch_join_attempt_windows',
      'SELECT,INSERT,UPDATE,DELETE'
    ),
  'practice-kick and join-attempt counters are private and RLS protected'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.authorize_practice_processor_kick(uuid,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.authorize_practice_processor_kick(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.authorize_practice_processor_kick(uuid,text)',
      'EXECUTE'
    ),
  'only service_role can authorize a practice worker kick'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.consume_batch_join_attempt(uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'service_role',
      'app_private.consume_batch_join_attempt(uuid)',
      'EXECUTE'
    ),
  'the join-attempt consumer is reachable only through the protected join RPC'
);

select ok(
  to_regclass(
    'app_private.practice_processor_kick_windows_cleanup_idx'
  ) is not null
    and to_regclass(
      'app_private.batch_join_attempt_windows_cleanup_idx'
    ) is not null,
  'both minute-window tables have timestamp indexes for bounded cleanup'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'a1111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase11u-owner@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11U Owner"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a1222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase11u-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11U Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a1333333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'phase11u-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11U Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a1444444-4444-4444-8444-444444444444',
    'authenticated',
    'authenticated',
    'phase11u-inactive@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11U Inactive"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'a1555555-5555-4555-8555-555555555555',
  'Phase 11U Workspace',
  'phase-11u-workspace',
  'a1111111-1111-4111-8111-111111111111'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'a1111111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a1555555-5555-4555-8555-555555555555',
  'a1111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a1555555-5555-4555-8555-555555555555',
  'a1222222-2222-4222-8222-222222222222',
  'teacher'
);

select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  is_active,
  feedback_mode
)
values (
  'a1666666-6666-4666-8666-666666666666',
  'a1555555-5555-4555-8555-555555555555',
  'Phase 11U A2',
  'A2',
  true,
  'teacher_review_only'
);

update app_private.abuse_security_limits
set max_practice_kicks_per_actor_kind_minute = 2,
    max_batch_join_attempts_per_actor_minute = 4,
    updated_at = now()
where singleton;

insert into app_private.practice_processor_kick_windows (
  actor_id,
  worker_kind,
  window_started_at,
  kick_count
)
values
  (
    'a1111111-1111-4111-8111-111111111111',
    'worksheet_generation',
    date_trunc('minute', now()) - interval '30 minutes',
    1
  ),
  (
    'a1111111-1111-4111-8111-111111111111',
    'worksheet_generation',
    date_trunc('minute', now()) - interval '5 minutes',
    1
  ),
  (
    'a1444444-4444-4444-8444-444444444444',
    'worksheet_generation',
    date_trunc('minute', now()) - interval '30 minutes',
    1
  ),
  (
    'a1222222-2222-4222-8222-222222222222',
    'worksheet_answer_evaluation',
    date_trunc('minute', now()) - interval '30 minutes',
    1
  );

insert into app_private.batch_join_attempt_windows (
  actor_id,
  window_started_at,
  attempt_count
)
values
  (
    'a1333333-3333-4333-8333-333333333333',
    date_trunc('minute', now()) - interval '30 minutes',
    1
  ),
  (
    'a1333333-3333-4333-8333-333333333333',
    date_trunc('minute', now()) - interval '5 minutes',
    1
  ),
  (
    'a1444444-4444-4444-8444-444444444444',
    date_trunc('minute', now()) - interval '30 minutes',
    1
  );

create temporary table phase_11u_state (
  singleton boolean primary key default true check (singleton),
  join_code text not null,
  request_id uuid
) on commit drop;

insert into phase_11u_state (join_code)
select private_code.join_code
from app_private.batch_join_codes private_code
where private_code.batch_id = 'a1666666-6666-4666-8666-666666666666';

grant select, update on phase_11u_state to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1111111-1111-4111-8111-111111111111',
    'role', 'service_role'
  )::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  api.authorize_practice_processor_kick(
    'a1111111-1111-4111-8111-111111111111',
    'attacker_selected_kind'
  ),
  'invalid_worker_kind'::text,
  'the service facade rejects non-allowlisted worker kinds without consuming quota'
);

select is(
  api.authorize_practice_processor_kick(
    'a1444444-4444-4444-8444-444444444444',
    'worksheet_generation'
  ),
  'inactive_actor'::text,
  'a profile without an active workspace role cannot authorize a worker kick'
);

select is(
  api.authorize_practice_processor_kick(
    'a1111111-1111-4111-8111-111111111111',
    'worksheet_generation'
  ),
  'allowed'::text,
  'the first legitimate worksheet-generation kick is allowed'
);

select is(
  api.authorize_practice_processor_kick(
    'a1111111-1111-4111-8111-111111111111',
    'worksheet_generation'
  ),
  'allowed'::text,
  'the second generation kick reaches the configured boundary'
);

select is(
  api.authorize_practice_processor_kick(
    'a1111111-1111-4111-8111-111111111111',
    'worksheet_generation'
  ),
  'rate_limited'::text,
  'a replay beyond the generation boundary cannot mint another wakeup'
);

select is(
  api.authorize_practice_processor_kick(
    'a1111111-1111-4111-8111-111111111111',
    'worksheet_answer_evaluation'
  ),
  'allowed'::text,
  'answer evaluation has an independent per-kind recovery allowance'
);

select is(
  api.authorize_practice_processor_kick(
    'a1222222-2222-4222-8222-222222222222',
    'worksheet_generation'
  ),
  'allowed'::text,
  'a second active actor retains an independent generation allowance'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.practice_processor_kick_windows usage_window
    where usage_window.actor_id = 'a1111111-1111-4111-8111-111111111111'
      and usage_window.worker_kind = 'worksheet_generation'
      and usage_window.window_started_at <
        date_trunc('minute', now()) - interval '15 minutes'
  ),
  0,
  'a kick authorization removes only that active actor/kind stale windows'
);

select is(
  (
    select count(*)::integer
    from app_private.practice_processor_kick_windows usage_window
    where usage_window.actor_id = 'a1111111-1111-4111-8111-111111111111'
      and usage_window.worker_kind = 'worksheet_generation'
      and usage_window.window_started_at =
        date_trunc('minute', now()) - interval '5 minutes'
  ),
  1,
  'kick cleanup preserves a fresh retained window'
);

select is(
  (
    select count(*)::integer
    from app_private.practice_processor_kick_windows usage_window
    where usage_window.actor_id = 'a1444444-4444-4444-8444-444444444444'
      and usage_window.worker_kind = 'worksheet_generation'
      and usage_window.window_started_at =
        date_trunc('minute', now()) - interval '30 minutes'
  ),
  1,
  'kick cleanup never scans or deletes another actor windows'
);

select is(
  (
    select count(*)::integer
    from app_private.practice_processor_kick_windows usage_window
    where usage_window.actor_id = 'a1222222-2222-4222-8222-222222222222'
      and usage_window.worker_kind = 'worksheet_answer_evaluation'
      and usage_window.window_started_at =
        date_trunc('minute', now()) - interval '30 minutes'
  ),
  1,
  'kick cleanup never deletes another worker kind for the same active actor'
);

select is(
  (
    select sum(usage_window.kick_count)::integer
    from app_private.practice_processor_kick_windows usage_window
    where usage_window.window_started_at = date_trunc('minute', now())
  ),
  4,
  'the transactional kick windows record only the four allowed wakeups'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1333333-3333-4333-8333-333333333333',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'a1333333-3333-4333-8333-333333333333',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$select * from app_private.batch_join_codes$$,
  '42501',
  'permission denied for schema app_private',
  'a student cannot list or read the private join-code bank'
);

select throws_ok(
  $$
    select *
    from api.list_workspace_batch_join_codes(
      'a1555555-5555-4555-8555-555555555555'
    )
  $$,
  '42501',
  'Permission denied.',
  'the teacher join-code projection remains inaccessible to a student'
);

select is(
  (
    select count(*)::integer
    from api.request_batch_join('ZZZZZZZZZZ')
  ),
  0,
  'an unknown well-formed code returns no identifying batch data'
);

select is(
  (
    select count(*)::integer
    from api.request_batch_join('x')
  ),
  0,
  'a malformed code follows the same non-enumerating empty result contract'
);

with joined as (
  select *
  from api.request_batch_join(
    (select join_code from pg_temp.phase_11u_state where singleton)
  )
)
update pg_temp.phase_11u_state state
set request_id = joined.request_id
from joined
where state.singleton;

select ok(
  (select request_id is not null from phase_11u_state where singleton),
  'a valid code still creates a durable join request'
);

select is(
  (
    select request.status
    from public.batch_join_requests request
    where request.id = (
      select request_id from phase_11u_state where singleton
    )
  ),
  'pending'::text,
  'a valid code still requires teacher approval'
);

select is(
  (
    select joined.request_id
    from api.request_batch_join(
      (select join_code from pg_temp.phase_11u_state where singleton)
    ) joined
  ),
  (select request_id from phase_11u_state where singleton),
  'a pending-request reread remains idempotent within the attempt policy'
);

reset role;

select is(
  (
    select usage_window.attempt_count
    from app_private.batch_join_attempt_windows usage_window
    where usage_window.actor_id = 'a1333333-3333-4333-8333-333333333333'
      and usage_window.window_started_at = date_trunc('minute', now())
  ),
  4,
  'malformed, unknown, new-valid, and pending-reread attempts all consume quota'
);

select is(
  (
    select count(*)::integer
    from app_private.batch_join_attempt_windows usage_window
    where usage_window.actor_id = 'a1333333-3333-4333-8333-333333333333'
      and usage_window.window_started_at <
        date_trunc('minute', now()) - interval '15 minutes'
  ),
  0,
  'a join attempt removes that actor stale windows before code lookup'
);

select is(
  (
    select count(*)::integer
    from app_private.batch_join_attempt_windows usage_window
    where usage_window.actor_id = 'a1333333-3333-4333-8333-333333333333'
      and usage_window.window_started_at =
        date_trunc('minute', now()) - interval '5 minutes'
  ),
  1,
  'join cleanup preserves a fresh retained window'
);

select is(
  (
    select count(*)::integer
    from app_private.batch_join_attempt_windows usage_window
    where usage_window.actor_id = 'a1444444-4444-4444-8444-444444444444'
      and usage_window.window_started_at =
        date_trunc('minute', now()) - interval '30 minutes'
  ),
  1,
  'join cleanup never scans or deletes another actor windows'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1333333-3333-4333-8333-333333333333',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'a1333333-3333-4333-8333-333333333333',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select *
    from api.request_batch_join(
      (select join_code from pg_temp.phase_11u_state where singleton)
    )
  $$,
  'PT429',
  'batch_join_attempt_rate_limited',
  'a fifth replay returns a browser rate limit before another private-code lookup'
);

reset role;

select throws_ok(
  $$
    select *
    from app_private.request_join_batch_by_code_internal(
      (select join_code from pg_temp.phase_11u_state where singleton)
    )
  $$,
  '54000',
  'batch_join_attempt_rate_limited',
  'the private join throttle preserves internal program-limit semantics'
);

select is(
  (
    select count(*)::integer
    from public.batch_join_requests request
    where request.batch_id = 'a1666666-6666-4666-8666-666666666666'
      and request.student_id = 'a1333333-3333-4333-8333-333333333333'
  ),
  1,
  'replays cannot create duplicate join requests'
);

select is(
  (
    select count(*)::integer
    from public.workspace_members membership
    where membership.workspace_id = 'a1555555-5555-4555-8555-555555555555'
      and membership.user_id = 'a1333333-3333-4333-8333-333333333333'
  ),
  0,
  'possessing a valid code does not bypass teacher approval into workspace access'
);

select is(
  (
    select count(*)::integer
    from public.batch_students assignment
    where assignment.batch_id = 'a1666666-6666-4666-8666-666666666666'
      and assignment.student_id = 'a1333333-3333-4333-8333-333333333333'
  ),
  0,
  'possessing a valid code does not create a batch assignment before approval'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'a1111111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $$
    select *
    from api.decide_batch_join(
      (select request_id from pg_temp.phase_11u_state where singleton),
      'approved'
    )
  $$,
  'the teacher can still approve the rate-limited student request atomically'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.workspace_members membership
    where membership.workspace_id = 'a1555555-5555-4555-8555-555555555555'
      and membership.user_id = 'a1333333-3333-4333-8333-333333333333'
      and membership.role = 'student'
  ),
  1,
  'approval still creates the student workspace membership'
);

select is(
  (
    select count(*)::integer
    from public.batch_students assignment
    where assignment.batch_id = 'a1666666-6666-4666-8666-666666666666'
      and assignment.student_id = 'a1333333-3333-4333-8333-333333333333'
  ),
  1,
  'approval still creates exactly one batch assignment'
);

delete from app_private.batch_join_attempt_windows
where actor_id = 'a1333333-3333-4333-8333-333333333333';

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a1333333-3333-4333-8333-333333333333',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'a1333333-3333-4333-8333-333333333333',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  (
    select joined.status
    from api.request_batch_join(
      (select join_code from pg_temp.phase_11u_state where singleton)
    ) joined
  ),
  'approved'::text,
  'an approved-request reread remains available in a fresh policy window'
);

select is(
  (
    select joined.request_id
    from api.request_batch_join(
      (select join_code from pg_temp.phase_11u_state where singleton)
    ) joined
  ),
  (select request_id from phase_11u_state where singleton),
  'approved rereads remain idempotent and do not create new request ids'
);

reset role;

select is(
  (
    select usage_window.attempt_count
    from app_private.batch_join_attempt_windows usage_window
    where usage_window.actor_id = 'a1333333-3333-4333-8333-333333333333'
      and usage_window.window_started_at = date_trunc('minute', now())
  ),
  2,
  'approved rereads remain subject to the same attempt policy'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'app_private'
      and column_info.table_name = 'batch_join_attempt_windows'
      and column_info.column_name in ('join_code', 'batch_id', 'result')
  ),
  'attempt state stores neither submitted codes nor lookup results'
);

select * from finish();
rollback;
