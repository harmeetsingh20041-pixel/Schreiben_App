begin;

select plan(22);

select ok(
  to_regprocedure('api.get_workspace(uuid)') is not null
    and to_regprocedure('api.list_workspace_batches_page(uuid,integer,timestamptz,uuid)') is not null
    and to_regprocedure('api.create_workspace_batch(uuid,text,text,text,boolean,boolean,text,integer,integer)') is not null
    and to_regprocedure('api.update_workspace_batch(uuid,uuid,text,text,text,boolean,boolean,text,integer,integer)') is not null
    and to_regprocedure('api.list_workspace_questions_page(uuid,integer,timestamptz,uuid)') is not null
    and to_regprocedure('api.list_workspace_students_page(uuid,integer,timestamptz,uuid)') is not null
    and to_regprocedure('api.list_student_practice_assignments_page(uuid,uuid,integer,timestamptz,uuid)') is not null,
  'the browser API read and mutation allowlist has stable signatures'
);

with expected_definers(routine_oid) as (
  values
    (
      'api.complete_worksheet_generation_openai_legacy(uuid,bigint,uuid,jsonb)'::regprocedure
    )
), actual_definers(routine_oid) as (
  select routine.oid
  from pg_proc routine
  join pg_namespace namespace on namespace.oid = routine.pronamespace
  where namespace.nspname = 'api'
    and routine.prosecdef
)
select ok(
  (
    select array_agg(actual.routine_oid order by actual.routine_oid)
    from actual_definers actual
  ) = (
    select array_agg(expected.routine_oid::oid order by expected.routine_oid::oid)
    from expected_definers expected
  )
    and not exists (
      select 1
      from expected_definers expected
      join pg_proc routine on routine.oid = expected.routine_oid
      where not exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
        or has_function_privilege(
          'anon', expected.routine_oid, 'EXECUTE'
        )
        or has_function_privilege(
          'authenticated', expected.routine_oid, 'EXECUTE'
        )
        or has_function_privilege(
          'service_role', expected.routine_oid, 'EXECUTE'
        )
        or exists (
          select 1
          from aclexplode(
            coalesce(routine.proacl, acldefault('f', routine.proowner))
          ) privilege
          where privilege.grantee = 0
            and privilege.privilege_type = 'EXECUTE'
        )
    ),
  'only the exact sealed legacy replay bridges retain definer authority'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    where routine.oid in (
      'api.get_workspace(uuid)'::regprocedure,
      'api.list_workspace_batches_page(uuid,integer,timestamptz,uuid)'::regprocedure,
      'api.create_workspace_batch(uuid,text,text,text,boolean,boolean,text,integer,integer)'::regprocedure,
      'api.list_workspace_questions_page(uuid,integer,timestamptz,uuid)'::regprocedure,
      'api.list_workspace_students_page(uuid,integer,timestamptz,uuid)'::regprocedure,
      'api.get_practice_assignment_summary(uuid)'::regprocedure
    )
      and not exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
  ),
  'browser API routines pin an empty search path'
);

select ok(
  has_function_privilege('authenticated', 'api.get_workspace(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'api.list_workspace_batches_page(uuid,integer,timestamptz,uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'api.create_workspace_batch(uuid,text,text,text,boolean,boolean,text,integer,integer)', 'EXECUTE')
    and has_function_privilege('authenticated', 'api.list_workspace_students_page(uuid,integer,timestamptz,uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'api.get_practice_assignment_summary(uuid)', 'EXECUTE'),
  'authenticated browsers receive only explicit execution grants'
);

select ok(
  not has_function_privilege('anon', 'api.get_workspace(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.list_workspace_batches_page(uuid,integer,timestamptz,uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.create_workspace_batch(uuid,text,text,text,boolean,boolean,text,integer,integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.list_workspace_students_page(uuid,integer,timestamptz,uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.get_practice_assignment_summary(uuid)', 'EXECUTE'),
  'anonymous clients receive no browser application execution grants'
);

select ok(
  (select prosecdef from pg_proc where oid = 'public.list_my_batch_join_requests_secure(uuid)'::regprocedure)
    and has_function_privilege('authenticated', 'public.list_my_batch_join_requests_secure(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.list_my_batch_join_requests_secure(uuid)', 'EXECUTE'),
  'the pending-student display helper is narrow, authenticated, and inaccessible to anonymous callers'
);

select ok(
  to_regprocedure('api.ensure_student_practice_assignment(uuid,uuid,uuid)') is not null
    and to_regprocedure('api.start_practice_assignment(uuid)') is not null
    and to_regprocedure('api.create_next_practice_assignment(uuid)') is not null
    and to_regprocedure('api.get_practice_assignment_questions(uuid)') is not null
    and to_regprocedure('api.get_practice_assignment_review(uuid)') is not null,
  'practice browser operations have API-only wrappers'
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
    'c0111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11c-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11C Teacher"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c0222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase11c-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11C Student"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c0333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase11c-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11C Outsider"}'::jsonb,
    now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  ('c0111111-1111-4111-8111-111111111111', 'Phase 11C Teacher', 'phase11c-teacher@example.test', 'student'),
  ('c0222222-2222-4222-8222-222222222222', 'Phase 11C Student', 'phase11c-student@example.test', 'student'),
  ('c0333333-3333-4333-8333-333333333333', 'Phase 11C Outsider', 'phase11c-outsider@example.test', 'student')
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'c1111111-1111-4111-8111-111111111111',
  'Phase 11C Workspace',
  'phase-11c-workspace',
  'c0111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'c0111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c1111111-1111-4111-8111-111111111111',
  'c0111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.global_questions (
  id,
  title,
  prompt,
  level,
  topic,
  task_type,
  expected_word_min,
  expected_word_max,
  estimated_minutes,
  is_active,
  created_by
) values (
  'c0444444-4444-4444-8444-444444444444',
  'Phase 11C Global Task',
  'Schreibe drei Sätze über deinen Tag.',
  'A2',
  'Alltag',
  'writing',
  20,
  80,
  15,
  true,
  'c0111111-1111-4111-8111-111111111111'
);

create temporary table phase_11c_state (
  singleton boolean primary key default true check (singleton),
  batch_id uuid,
  join_code text,
  request_id uuid,
  question_id uuid
) on commit drop;
insert into phase_11c_state default values;
grant select, update on table phase_11c_state to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c0111111-1111-4111-8111-111111111111', true);
set local role authenticated;

with created as (
  select *
  from api.create_workspace_batch(
    'c1111111-1111-4111-8111-111111111111',
    'Phase 11C A2',
    'A2',
    'Browser API fixture',
    true,
    true,
    'teacher_review_only',
    15,
    180
  )
)
update pg_temp.phase_11c_state state
set batch_id = created.batch_id
from created;

select ok(
  (select batch_id from pg_temp.phase_11c_state) is not null,
  'a teacher creates a batch only through the API command'
);

update pg_temp.phase_11c_state state
set join_code = page.payload -> 'items' -> 0 ->> 'join_code'
from (
  select api.list_workspace_batches_page(
    'c1111111-1111-4111-8111-111111111111', 100, null, null
  ) as payload
) page;

select is(
  (
    api.list_workspace_batches_page(
      'c1111111-1111-4111-8111-111111111111', 100, null, null
    ) ->> 'total_count'
  )::integer,
  1,
  'the batch read model returns an exact server-side count'
);

select is(
  (
    api.list_workspace_batches_page(
      'c1111111-1111-4111-8111-111111111111', 100, null, null
    ) -> 'items' -> 0 ->> 'student_count'
  )::integer,
  0,
  'the batch read model derives enrollment counts server-side'
);

select throws_ok(
  $$select api.list_workspace_batches_page('c1111111-1111-4111-8111-111111111111', 101, null, null)$$,
  '22023',
  'invalid_page_size',
  'invalid browser page sizes fail with a stable code'
);

with created as (
  select *
  from api.create_workspace_question(
    'c1111111-1111-4111-8111-111111111111',
    'Phase 11C Writing Task',
    'Schreibe drei Sätze über deine Schule.',
    'A2',
    'Schule',
    'writing',
    20,
    80,
    15,
    true
  )
)
update pg_temp.phase_11c_state state
set question_id = created.question_id
from created;

select ok(
  (select question_id from pg_temp.phase_11c_state) is not null,
  'a teacher creates a writing task only through the API command'
);

select set_config('request.jwt.claim.sub', 'c0222222-2222-4222-8222-222222222222', true);

select throws_ok(
  $$select api.list_workspace_batches_page('c1111111-1111-4111-8111-111111111111', 50, null, null)$$,
  '42501',
  'permission_denied',
  'a student cannot enumerate the teacher batch read model'
);

with requested as (
  select *
  from api.request_batch_join((select join_code from pg_temp.phase_11c_state))
)
update pg_temp.phase_11c_state state
set request_id = requested.request_id
from requested;

select is(
  (
    api.list_my_batch_join_requests('c0222222-2222-4222-8222-222222222222')
      -> 0 ->> 'status'
  ),
  'pending',
  'a pending student can read only their own safe join-request display model'
);

select throws_ok(
  $$select * from api.list_workspace_batch_join_codes('c1111111-1111-4111-8111-111111111111')$$,
  '42501',
  'Permission denied.',
  'a student still cannot list private class codes'
);

select set_config('request.jwt.claim.sub', 'c0111111-1111-4111-8111-111111111111', true);

select is(
  (
    api.list_workspace_batch_join_requests_page(
      'c1111111-1111-4111-8111-111111111111', 50, null, null
    ) ->> 'total_count'
  )::integer,
  1,
  'the teacher join-request queue is server-paginated without a hidden cap'
);

select is(
  (
    select decision.status
    from api.decide_batch_join(
      (select request_id from pg_temp.phase_11c_state),
      'approved'
    ) decision
  ),
  'approved',
  'the teacher approves the pending request atomically through the API'
);

select is(
  (
    select count(*)::integer
    from public.workspace_members membership
    where membership.workspace_id = 'c1111111-1111-4111-8111-111111111111'
      and membership.user_id = 'c0222222-2222-4222-8222-222222222222'
      and membership.role = 'student'
  ),
  1,
  'approval creates exactly one active student membership'
);

select set_config('request.jwt.claim.sub', 'c0222222-2222-4222-8222-222222222222', true);

select is(
  (
    api.list_my_batch_assignments('c0222222-2222-4222-8222-222222222222')
      -> 0 ->> 'batch_id'
  )::uuid,
  (select batch_id from pg_temp.phase_11c_state),
  'the student assignment model preserves explicit batch context'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      api.list_student_assigned_questions('c0222222-2222-4222-8222-222222222222')
    ) task
    where (task ->> 'id')::uuid = (select question_id from pg_temp.phase_11c_state)
      and (task ->> 'batch_id')::uuid = (select batch_id from pg_temp.phase_11c_state)
  ),
  'student writing tasks always carry an explicit authorized batch context'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      api.list_student_assigned_questions('c0222222-2222-4222-8222-222222222222')
    ) task
    where (task ->> 'id')::uuid = 'c0444444-4444-4444-8444-444444444444'
      and task ->> 'workspace_id' = 'global'
      and (task ->> 'batch_id')::uuid = (select batch_id from pg_temp.phase_11c_state)
  ),
  'workspace and global task branches share a runtime-compatible text workspace identifier'
);

select set_config('request.jwt.claim.sub', 'c0333333-3333-4333-8333-333333333333', true);

select throws_ok(
  format(
    'select * from api.update_workspace_question(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
    'c1111111-1111-4111-8111-111111111111',
    (select question_id from pg_temp.phase_11c_state),
    'Unauthorized edit',
    'This must fail.',
    'A2',
    'Schule',
    'writing',
    20,
    80,
    15,
    true
  ),
  '42501',
  'permission_denied',
  'an unrelated authenticated user cannot mutate another workspace'
);

select set_config('request.jwt.claim.sub', '', true);
reset role;

select * from finish();
rollback;
