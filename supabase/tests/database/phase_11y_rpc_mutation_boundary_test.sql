begin;

select plan(54);

with expected_definers(routine_oid) as (
  values (
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
  'only the exact sealed legacy replay bridge retains definer authority'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'api.create_workspace_batch(uuid,text,text,text,boolean,boolean,text,integer,integer)'::regprocedure,
      'api.update_workspace_batch(uuid,uuid,text,text,text,boolean,boolean,text,integer,integer)'::regprocedure,
      'api.set_batch_active(uuid,uuid,boolean)'::regprocedure,
      'api.create_workspace_question(uuid,text,text,text,text,text,integer,integer,integer,boolean)'::regprocedure,
      'api.update_workspace_question(uuid,uuid,text,text,text,text,text,integer,integer,integer,boolean)'::regprocedure,
      'api.set_question_active(uuid,uuid,boolean)'::regprocedure,
      'api.assign_student_to_batch(uuid,uuid,uuid)'::regprocedure,
      'api.remove_student_batch_assignment(uuid,uuid)'::regprocedure
    ]) expected(routine_oid)
    join pg_proc routine on routine.oid = expected.routine_oid
    where routine.prosecdef
      or not has_function_privilege('authenticated', routine.oid, 'EXECUTE')
      or has_function_privilege('anon', routine.oid, 'EXECUTE')
  ),
  'the repaired mutation allowlist stays invoker-only and authenticated-only'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'public.create_workspace_batch_write_internal(uuid,text,text,text,boolean,boolean,text,integer,integer)'::regprocedure,
      'public.update_workspace_batch_write_internal(uuid,uuid,text,text,text,boolean,boolean,text,integer,integer)'::regprocedure,
      'public.create_workspace_question_write_internal(uuid,text,text,text,text,text,integer,integer,integer,boolean)'::regprocedure,
      'public.update_workspace_question_write_internal(uuid,uuid,text,text,text,text,text,integer,integer,integer,boolean)'::regprocedure
    ]) expected(routine_oid)
    where has_function_privilege('anon', expected.routine_oid, 'EXECUTE')
      or has_function_privilege(
        'authenticated',
        expected.routine_oid,
        'EXECUTE'
      )
      or has_function_privilege('service_role', expected.routine_oid, 'EXECUTE')
      or exists (
        select 1
        from pg_proc routine
        cross join lateral aclexplode(
          coalesce(routine.proacl, acldefault('f', routine.proowner))
        ) privilege
        where routine.oid = expected.routine_oid
          and privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE'
      )
  ),
  'raw mutation writers are unreachable by PUBLIC and every API role'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'public.create_workspace_batch_internal(uuid,text,text,text,boolean,boolean,text,integer,integer)'::regprocedure,
      'public.update_workspace_batch_internal(uuid,uuid,text,text,text,boolean,boolean,text,integer,integer)'::regprocedure,
      'public.create_workspace_question_internal(uuid,text,text,text,text,text,integer,integer,integer,boolean)'::regprocedure,
      'public.update_workspace_question_internal(uuid,uuid,text,text,text,text,text,integer,integer,integer,boolean)'::regprocedure
    ]) expected(routine_oid)
    join pg_proc routine on routine.oid = expected.routine_oid
    where not routine.prosecdef
      or not exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
      or not has_function_privilege(
        'authenticated',
        expected.routine_oid,
        'EXECUTE'
      )
      or not has_function_privilege(
        'service_role',
        expected.routine_oid,
        'EXECUTE'
      )
      or has_function_privilege('anon', expected.routine_oid, 'EXECUTE')
      or exists (
        select 1
        from aclexplode(
          coalesce(routine.proacl, acldefault('f', routine.proowner))
        ) privilege
        where privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE'
      )
  ),
  'validated mutation internals retain definer authority, an empty search path, and the intended API-role grants'
);

select ok(
  not exists (
    select 1
    from (
      values
        (
          'api.create_workspace_batch(uuid,text,text,text,boolean,boolean,text,integer,integer)'::regprocedure,
          'public.create_workspace_batch_internal'::text,
          'public.create_workspace_batch_write_internal'::text
        ),
        (
          'api.update_workspace_batch(uuid,uuid,text,text,text,boolean,boolean,text,integer,integer)'::regprocedure,
          'public.update_workspace_batch_internal'::text,
          'public.update_workspace_batch_write_internal'::text
        ),
        (
          'api.create_workspace_question(uuid,text,text,text,text,text,integer,integer,integer,boolean)'::regprocedure,
          'public.create_workspace_question_internal'::text,
          'public.create_workspace_question_write_internal'::text
        ),
        (
          'api.update_workspace_question(uuid,uuid,text,text,text,text,text,integer,integer,integer,boolean)'::regprocedure,
          'public.update_workspace_question_internal'::text,
          'public.update_workspace_question_write_internal'::text
        )
    ) expected(wrapper_oid, validated_name, raw_writer_name)
    cross join lateral (
      select lower(pg_get_functiondef(expected.wrapper_oid)) as definition
    ) wrapper
    where position(expected.validated_name || '(' in wrapper.definition) = 0
      or position(expected.raw_writer_name || '(' in wrapper.definition) > 0
  ),
  'exposed mutation wrappers call only their validated internal boundaries'
);

select ok(
  not exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and (
        has_table_privilege('authenticated', relation.oid, 'INSERT')
        or has_table_privilege('authenticated', relation.oid, 'UPDATE')
        or has_table_privilege('authenticated', relation.oid, 'DELETE')
        or has_table_privilege('authenticated', relation.oid, 'TRUNCATE')
        or has_table_privilege('authenticated', relation.oid, 'REFERENCES')
        or has_table_privilege('authenticated', relation.oid, 'TRIGGER')
      )
  ),
  'authenticated still has no direct public-table mutation privilege'
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
    '1d111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11y-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11Y Teacher"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '1d222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase11y-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11Y Student"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '1d333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase11y-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11Y Outsider"}'::jsonb,
    now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    '1d111111-1111-4111-8111-111111111111',
    'Phase 11Y Teacher',
    'phase11y-teacher@example.test',
    'student'
  ),
  (
    '1d222222-2222-4222-8222-222222222222',
    'Phase 11Y Student',
    'phase11y-student@example.test',
    'student'
  ),
  (
    '1d333333-3333-4333-8333-333333333333',
    'Phase 11Y Outsider',
    'phase11y-outsider@example.test',
    'student'
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    '1d444444-4444-4444-8444-444444444444',
    'Phase 11Y Teacher Workspace',
    'phase-11y-teacher-workspace',
    '1d111111-1111-4111-8111-111111111111'
  ),
  (
    '1d555555-5555-4555-8555-555555555555',
    'Phase 11Y Outsider Workspace',
    'phase-11y-outsider-workspace',
    '1d333333-3333-4333-8333-333333333333'
  );

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '1d111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    '1d444444-4444-4444-8444-444444444444',
    '1d111111-1111-4111-8111-111111111111',
    'owner'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    '1d444444-4444-4444-8444-444444444444',
    '1d222222-2222-4222-8222-222222222222',
    'student'
  );

select set_config(
  'request.jwt.claim.sub',
  '1d333333-3333-4333-8333-333333333333',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    '1d555555-5555-4555-8555-555555555555',
    '1d333333-3333-4333-8333-333333333333',
    'owner'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

create temporary table phase_11y_state (
  singleton boolean primary key default true check (singleton),
  batch_id uuid,
  assignment_id uuid,
  assignment_created boolean
) on commit drop;

insert into phase_11y_state default values;

create temporary table phase_11y_questions (
  task_type text primary key,
  question_id uuid not null
) on commit drop;

grant select, update on table phase_11y_state to authenticated;
grant select on table phase_11y_questions to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '1d111111-1111-4111-8111-111111111111', true);
set local role authenticated;

with created as (
  select *
  from api.create_workspace_batch(
    '1d444444-4444-4444-8444-444444444444',
    'Phase 11Y A2 Class',
    'A2',
    'RPC mutation-boundary fixture',
    true,
    true,
    'teacher_review_only',
    15,
    180
  )
)
update pg_temp.phase_11y_state state
set batch_id = created.batch_id
from created;

select ok(
  (select batch_id from pg_temp.phase_11y_state) is not null,
  'an authorized teacher creates a class through the RPC boundary'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      api.list_workspace_batches_page(
        '1d444444-4444-4444-8444-444444444444',
        100,
        null,
        null
      ) -> 'items'
    ) item
    where (item ->> 'id')::uuid = (
      select batch_id from pg_temp.phase_11y_state
    )
      and item ->> 'name' = 'Phase 11Y A2 Class'
      and (item ->> 'is_active')::boolean
  ),
  'the created class is visible through the teacher read model'
);

select ok(
  (
    select updated.batch_id = state.batch_id
    from pg_temp.phase_11y_state state
    cross join lateral api.update_workspace_batch(
      '1d444444-4444-4444-8444-444444444444',
      state.batch_id,
      'Phase 11Y Updated Class',
      'A2',
      'Updated only through the RPC boundary',
      true,
      true,
      'immediate',
      0,
      0
    ) updated
  ),
  'an authorized teacher updates a class through the RPC boundary'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      api.list_workspace_batches_page(
        '1d444444-4444-4444-8444-444444444444',
        100,
        null,
        null
      ) -> 'items'
    ) item
    where (item ->> 'id')::uuid = (
      select batch_id from pg_temp.phase_11y_state
    )
      and item ->> 'name' = 'Phase 11Y Updated Class'
      and item ->> 'feedback_mode' = 'immediate'
  ),
  'the class update is persisted and returned by the API read model'
);

select throws_ok(
  $$
    select *
    from api.create_workspace_batch(
      '1d444444-4444-4444-8444-444444444444',
      'Phase 11Y null-level class',
      null,
      'This input must fail with the stable API code.',
      true,
      true,
      'teacher_review_only',
      15,
      180
    )
  $$,
  '22023',
  'invalid_batch',
  'a null class level fails with the stable invalid-batch code'
);

select throws_ok(
  format(
    $call$
      select *
      from api.update_workspace_batch(
        '1d444444-4444-4444-8444-444444444444',
        %L::uuid,
        'Phase 11Y null-mode class',
        'A2',
        'This input must fail with the stable API code.',
        true,
        true,
        null,
        15,
        180
      )
    $call$,
    (select batch_id::text from pg_temp.phase_11y_state)
  ),
  '22023',
  'invalid_batch',
  'a null feedback mode fails with the stable invalid-batch code'
);

select throws_ok(
  $$
    select *
    from api.create_workspace_question(
      '1d444444-4444-4444-8444-444444444444',
      'Phase 11Y null-level task',
      'This input must fail with the stable API code.',
      null,
      'RPC boundary',
      'writing',
      20,
      80,
      15,
      true
    )
  $$,
  '22023',
  'invalid_question',
  'a null writing-task level fails with the stable invalid-question code'
);

select throws_ok(
  $$
    select *
    from api.create_workspace_question(
      '1d444444-4444-4444-8444-444444444444',
      'Phase 11Y null-type task',
      'This input must fail with the stable API code.',
      'A2',
      'RPC boundary',
      null,
      20,
      80,
      15,
      true
    )
  $$,
  '22023',
  'invalid_question',
  'a null writing-task type fails with the stable invalid-question code'
);

select lives_ok(
  format(
    $call$
      select *
      from api.create_workspace_question(
        '1d444444-4444-4444-8444-444444444444',
        %L,
        %L,
        'A2',
        'RPC boundary',
        %L,
        20,
        80,
        15,
        true
      )
    $call$,
    'Phase 11Y ' || supported.task_type || ' task',
    'Schreibe einen passenden Text fuer ' || supported.task_type || '.',
    supported.task_type
  ),
  format(
    'an authorized teacher creates the %s task type through RPC',
    supported.task_type
  )
)
from unnest(array[
  'writing',
  'email',
  'free_text',
  'opinion',
  'description',
  'message',
  'apology',
  'invitation',
  'formal_letter'
]::text[]) with ordinality as supported(task_type, sort_order)
order by supported.sort_order;

select ok(
  (
    select count(*) = 9 and count(distinct item ->> 'task_type') = 9
    from jsonb_array_elements(
      api.list_workspace_questions_page(
        '1d444444-4444-4444-8444-444444444444',
        100,
        null,
        null
      ) -> 'items'
    ) item
    where item ->> 'task_type' = any(array[
      'writing',
      'email',
      'free_text',
      'opinion',
      'description',
      'message',
      'apology',
      'invitation',
      'formal_letter'
    ]::text[])
  ),
  'all nine supported task types are persisted and returned by the API'
);

reset role;

insert into pg_temp.phase_11y_questions (task_type, question_id)
select question.task_type, question.id
from public.questions question
where question.workspace_id = '1d444444-4444-4444-8444-444444444444'
  and question.title = 'Phase 11Y ' || question.task_type || ' task';

set local role authenticated;

select lives_ok(
  format(
    $call$
      select *
      from api.update_workspace_question(
        '1d444444-4444-4444-8444-444444444444',
        %L::uuid,
        %L,
        %L,
        'A2',
        'RPC boundary updated',
        %L,
        30,
        90,
        20,
        true
      )
    $call$,
    fixture.question_id::text,
    'Phase 11Y updated ' || fixture.task_type,
    'Aktualisierte Aufgabe fuer ' || fixture.task_type || '.',
    fixture.task_type
  ),
  format(
    'an authorized teacher updates the %s task type through RPC',
    fixture.task_type
  )
)
from pg_temp.phase_11y_questions fixture
order by fixture.task_type;

select ok(
  (
    select count(*) = 9
    from jsonb_array_elements(
      api.list_workspace_questions_page(
        '1d444444-4444-4444-8444-444444444444',
        100,
        null,
        null
      ) -> 'items'
    ) item
    where item ->> 'title' = 'Phase 11Y updated ' || (item ->> 'task_type')
      and item ->> 'topic' = 'RPC boundary updated'
      and (item ->> 'expected_word_min')::integer = 30
      and (item ->> 'expected_word_max')::integer = 90
  ),
  'updates for every supported task type are persisted through the API'
);

select throws_ok(
  format(
    $call$
      select *
      from api.update_workspace_question(
        '1d444444-4444-4444-8444-444444444444',
        %L::uuid,
        'Phase 11Y null-level update',
        'This input must fail with the stable API code.',
        null,
        'RPC boundary',
        'writing',
        20,
        80,
        15,
        true
      )
    $call$,
    (
      select question_id::text
      from pg_temp.phase_11y_questions
      where task_type = 'writing'
    )
  ),
  '22023',
  'invalid_question',
  'a null writing-task update level fails with the stable invalid-question code'
);

select throws_ok(
  format(
    $call$
      select *
      from api.update_workspace_question(
        '1d444444-4444-4444-8444-444444444444',
        %L::uuid,
        'Phase 11Y null-type update',
        'This input must fail with the stable API code.',
        'A2',
        'RPC boundary',
        null,
        20,
        80,
        15,
        true
      )
    $call$,
    (
      select question_id::text
      from pg_temp.phase_11y_questions
      where task_type = 'writing'
    )
  ),
  '22023',
  'invalid_question',
  'a null writing-task update type fails with the stable invalid-question code'
);

select ok(
  (
    select state.question_id = fixture.question_id
      and not state.is_active
    from pg_temp.phase_11y_questions fixture
    cross join lateral api.set_question_active(
      '1d444444-4444-4444-8444-444444444444',
      fixture.question_id,
      false
    ) state
    where fixture.task_type = 'writing'
  ),
  'an authorized teacher deactivates a writing task through RPC'
);

select throws_ok(
  $$
    select *
    from api.create_workspace_question(
      '1d444444-4444-4444-8444-444444444444',
      'Phase 11Y invalid task',
      'This task type must remain rejected.',
      'A2',
      'RPC boundary',
      'unknown_task_type',
      20,
      80,
      15,
      true
    )
  $$,
  '22023',
  'invalid_question',
  'an unsupported task type is rejected with a stable code'
);

with assigned as (
  select *
  from api.assign_student_to_batch(
    '1d444444-4444-4444-8444-444444444444',
    '1d222222-2222-4222-8222-222222222222',
    (select batch_id from pg_temp.phase_11y_state)
  )
)
update pg_temp.phase_11y_state state
set assignment_id = assigned.assignment_id,
    assignment_created = assigned.created
from assigned;

select ok(
  (
    select assignment_id is not null and assignment_created
    from pg_temp.phase_11y_state
  ),
  'an authorized teacher assigns a workspace student through RPC'
);

select set_config(
  'request.jwt.claim.sub',
  '1d222222-2222-4222-8222-222222222222',
  true
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      api.list_my_batch_assignments(
        '1d222222-2222-4222-8222-222222222222'
      )
    ) assignment
    where (assignment ->> 'id')::uuid = (
      select assignment_id from pg_temp.phase_11y_state
    )
      and (assignment ->> 'batch_id')::uuid = (
        select batch_id from pg_temp.phase_11y_state
      )
  ),
  'the student sees the assignment created through the RPC boundary'
);

select set_config(
  'request.jwt.claim.sub',
  '1d111111-1111-4111-8111-111111111111',
  true
);

select ok(
  (
    select removed.assignment_id = state.assignment_id
      and removed.removed
    from pg_temp.phase_11y_state state
    cross join lateral api.remove_student_batch_assignment(
      '1d444444-4444-4444-8444-444444444444',
      state.assignment_id
    ) removed
  ),
  'an authorized teacher removes one class assignment through RPC'
);

select set_config(
  'request.jwt.claim.sub',
  '1d222222-2222-4222-8222-222222222222',
  true
);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(
      api.list_my_batch_assignments(
        '1d222222-2222-4222-8222-222222222222'
      )
    ) assignment
    where (assignment ->> 'id')::uuid = (
      select assignment_id from pg_temp.phase_11y_state
    )
  ),
  'the removed class assignment no longer appears for the student'
);

select set_config(
  'request.jwt.claim.sub',
  '1d333333-3333-4333-8333-333333333333',
  true
);

select throws_ok(
  format(
    $call$
      select *
      from api.update_workspace_batch(
        '1d444444-4444-4444-8444-444444444444',
        %L::uuid,
        'Outsider edit',
        'A2',
        'This mutation must fail.',
        true,
        true,
        'immediate',
        0,
        0
      )
    $call$,
    (select batch_id::text from pg_temp.phase_11y_state)
  ),
  '42501',
  'permission_denied',
  'an unrelated authenticated user cannot mutate the teacher workspace'
);

select throws_ok(
  format(
    $call$
      select *
      from api.set_batch_active(
        '1d555555-5555-4555-8555-555555555555',
        %L::uuid,
        false
      )
    $call$,
    (select batch_id::text from pg_temp.phase_11y_state)
  ),
  'P0002',
  'batch_not_found',
  'a workspace-authorized caller cannot cross the workspace and class boundary'
);

select set_config(
  'request.jwt.claim.sub',
  '1d111111-1111-4111-8111-111111111111',
  true
);

select ok(
  (
    select archived.batch_id = state.batch_id
      and not archived.is_active
    from pg_temp.phase_11y_state state
    cross join lateral api.set_batch_active(
      '1d444444-4444-4444-8444-444444444444',
      state.batch_id,
      false
    ) archived
  ),
  'an authorized teacher archives a class through RPC'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      api.list_workspace_batches_page(
        '1d444444-4444-4444-8444-444444444444',
        100,
        null,
        null
      ) -> 'items'
    ) item
    where (item ->> 'id')::uuid = (
      select batch_id from pg_temp.phase_11y_state
    )
      and not (item ->> 'is_active')::boolean
  ),
  'the archived class state is returned by the API read model'
);

reset role;

delete from public.workspace_members membership
where membership.workspace_id = '1d444444-4444-4444-8444-444444444444'
  and membership.user_id = '1d111111-1111-4111-8111-111111111111';

select set_config(
  'request.jwt.claim.sub',
  '1d111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select throws_ok(
  $$
    select *
    from api.create_workspace_batch(
      '1d444444-4444-4444-8444-444444444444',
      'Stale teacher class',
      'A2',
      'This mutation must fail.',
      true,
      true,
      'teacher_review_only',
      15,
      180
    )
  $$,
  '42501',
  'permission_denied',
  'a stale former teacher cannot create a class'
);

select throws_ok(
  format(
    $call$
      select *
      from api.update_workspace_batch(
        '1d444444-4444-4444-8444-444444444444',
        %L::uuid,
        'Stale teacher class update',
        'A2',
        'This mutation must fail.',
        true,
        true,
        'teacher_review_only',
        15,
        180
      )
    $call$,
    (select batch_id::text from pg_temp.phase_11y_state)
  ),
  '42501',
  'permission_denied',
  'a stale former teacher cannot update a class'
);

select throws_ok(
  format(
    $call$
      select *
      from api.set_batch_active(
        '1d444444-4444-4444-8444-444444444444',
        %L::uuid,
        true
      )
    $call$,
    (select batch_id::text from pg_temp.phase_11y_state)
  ),
  '42501',
  'permission_denied',
  'a stale former teacher cannot change a class state'
);

select throws_ok(
  $$
    select *
    from api.create_workspace_question(
      '1d444444-4444-4444-8444-444444444444',
      'Stale teacher writing task',
      'This mutation must fail.',
      'A2',
      'RPC boundary',
      'writing',
      20,
      80,
      15,
      true
    )
  $$,
  '42501',
  'permission_denied',
  'a stale former teacher cannot create a writing task'
);

select throws_ok(
  format(
    $call$
      select *
      from api.update_workspace_question(
        '1d444444-4444-4444-8444-444444444444',
        %L::uuid,
        'Stale teacher task update',
        'This mutation must fail.',
        'A2',
        'RPC boundary',
        'writing',
        20,
        80,
        15,
        true
      )
    $call$,
    (
      select question_id::text
      from pg_temp.phase_11y_questions
      where task_type = 'writing'
    )
  ),
  '42501',
  'permission_denied',
  'a stale former teacher cannot update a writing task'
);

select throws_ok(
  format(
    $call$
      select *
      from api.set_question_active(
        '1d444444-4444-4444-8444-444444444444',
        %L::uuid,
        true
      )
    $call$,
    (
      select question_id::text
      from pg_temp.phase_11y_questions
      where task_type = 'writing'
    )
  ),
  '42501',
  'permission_denied',
  'a stale former teacher cannot change a writing-task state'
);

select throws_ok(
  format(
    $call$
      select *
      from api.assign_student_to_batch(
        '1d444444-4444-4444-8444-444444444444',
        '1d222222-2222-4222-8222-222222222222',
        %L::uuid
      )
    $call$,
    (select batch_id::text from pg_temp.phase_11y_state)
  ),
  '42501',
  'permission_denied',
  'a stale former teacher cannot assign a student to a class'
);

select throws_ok(
  format(
    $call$
      select *
      from api.remove_student_batch_assignment(
        '1d444444-4444-4444-8444-444444444444',
        %L::uuid
      )
    $call$,
    (select assignment_id::text from pg_temp.phase_11y_state)
  ),
  '42501',
  'permission_denied',
  'a stale former teacher cannot remove a class assignment'
);

select set_config('request.jwt.claim.sub', '', true);
reset role;

select * from finish();
rollback;
