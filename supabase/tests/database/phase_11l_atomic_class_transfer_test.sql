begin;

select plan(20);

select ok(
  to_regprocedure('api.transfer_student_class(uuid,uuid,uuid,uuid)') is not null
    and to_regprocedure(
      'public.transfer_student_class_internal(uuid,uuid,uuid,uuid)'
    ) is not null,
  'atomic class transfer has stable wrapper and implementation signatures'
);

select ok(
  not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid = 'api.transfer_student_class(uuid,uuid,uuid,uuid)'::regprocedure
  )
    and (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid = 'public.transfer_student_class_internal(uuid,uuid,uuid,uuid)'::regprocedure
    ),
  'the exposed class transfer is invoker-only and delegates to a non-exposed definer implementation'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.transfer_student_class(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'api.transfer_student_class(uuid,uuid,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.transfer_student_class(uuid,uuid,uuid,uuid)',
      'EXECUTE'
    ),
  'only authenticated application callers can enter the transfer API'
);

select ok(
  (
    select class.relrowsecurity
    from pg_class class
    where class.oid = 'app_private.batch_transfer_actions'::regclass
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.batch_transfer_actions',
      'SELECT'
    ),
  'class transfer evidence is private with RLS defense in depth'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'fc111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11l-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11L Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fc222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase11l-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11L Student"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fc333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase11l-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11L Outsider"}'::jsonb, now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'fc111111-1111-4111-8111-111111111111',
    'Phase 11L Teacher', 'phase11l-teacher@example.test', 'student'
  ),
  (
    'fc222222-2222-4222-8222-222222222222',
    'Phase 11L Student', 'phase11l-student@example.test', 'student'
  ),
  (
    'fc333333-3333-4333-8333-333333333333',
    'Phase 11L Outsider', 'phase11l-outsider@example.test', 'student'
  )
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  note
)
values
  (
    'fc111111-1111-4111-8111-111111111111',
    true,
    1,
    'Phase 11L teacher fixture.'
  ),
  (
    'fc333333-3333-4333-8333-333333333333',
    true,
    1,
    'Phase 11L outsider-teacher fixture.'
  );

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    'fc444444-4444-4444-8444-444444444444',
    'Phase 11L Workspace', 'phase-11l-workspace',
    'fc111111-1111-4111-8111-111111111111'
  ),
  (
    'fc555555-5555-4555-8555-555555555555',
    'Phase 11L Other Workspace', 'phase-11l-other-workspace',
    'fc333333-3333-4333-8333-333333333333'
  );

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'fc111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'fc444444-4444-4444-8444-444444444444',
    'fc111111-1111-4111-8111-111111111111',
    'owner'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'fc444444-4444-4444-8444-444444444444',
    'fc222222-2222-4222-8222-222222222222',
    'student'
  );

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'fc333333-3333-4333-8333-333333333333',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'fc555555-5555-4555-8555-555555555555',
    'fc333333-3333-4333-8333-333333333333',
    'owner'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by
)
values
  (
    'fc666666-6666-4666-8666-666666666666',
    'fc444444-4444-4444-8444-444444444444',
    'Source Class', 'A1', true,
    'fc111111-1111-4111-8111-111111111111'
  ),
  (
    'fc777777-7777-4777-8777-777777777777',
    'fc444444-4444-4444-8444-444444444444',
    'Target Class', 'A2', true,
    'fc111111-1111-4111-8111-111111111111'
  ),
  (
    'fc888888-8888-4888-8888-888888888888',
    'fc444444-4444-4444-8444-444444444444',
    'Archived Class', 'B1', false,
    'fc111111-1111-4111-8111-111111111111'
  ),
  (
    'fc999999-9999-4999-8999-999999999999',
    'fc555555-5555-4555-8555-555555555555',
    'Other Workspace Class', 'A1', true,
    'fc333333-3333-4333-8333-333333333333'
  );

insert into public.batch_students (
  id, workspace_id, student_id, batch_id
)
values (
  'fca11111-1111-4111-8111-111111111111',
  'fc444444-4444-4444-8444-444444444444',
  'fc222222-2222-4222-8222-222222222222',
  'fc666666-6666-4666-8666-666666666666'
);

insert into public.batch_join_requests (
  id,
  workspace_id,
  batch_id,
  student_id,
  student_email,
  student_name,
  status,
  decided_by,
  decided_at
) values (
  'fca22222-2222-4222-8222-222222222222',
  'fc444444-4444-4444-8444-444444444444',
  'fc666666-6666-4666-8666-666666666666',
  'fc222222-2222-4222-8222-222222222222',
  'phase11l-student@example.test',
  'Phase 11L Student',
  'approved',
  'fc111111-1111-4111-8111-111111111111',
  now()
);

insert into public.submissions (
  id, workspace_id, student_id, batch_id, mode, original_text, status,
  feedback_mode, evaluation_status, release_status
)
values (
  'fcb11111-1111-4111-8111-111111111111',
  'fc444444-4444-4444-8444-444444444444',
  'fc222222-2222-4222-8222-222222222222',
  'fc666666-6666-4666-8666-666666666666',
  'free_text',
  'Historical writing remains attached to the original class.',
  'checked',
  'immediate',
  'ready',
  'released'
);

create temporary table phase_11l_state (
  singleton boolean primary key default true check (singleton),
  transfer_result jsonb not null default '{}'::jsonb
) on commit drop;

insert into phase_11l_state default values;
grant select, update on table phase_11l_state to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fc111111-1111-4111-8111-111111111111', true);
set local role authenticated;

update pg_temp.phase_11l_state
set transfer_result = api.transfer_student_class(
  'fc444444-4444-4444-8444-444444444444',
  'fc222222-2222-4222-8222-222222222222',
  'fca11111-1111-4111-8111-111111111111',
  'fc777777-7777-4777-8777-777777777777'
)
where singleton;

select ok(
  (
    select transfer_result @> jsonb_build_object(
      'schema_version', 1,
      'source_removed', true,
      'target_created', true,
      'target_batch_id', 'fc777777-7777-4777-8777-777777777777'
    )
    from pg_temp.phase_11l_state
  ),
  'an authorized teacher receives the exact atomic transfer result'
);

reset role;

select ok(
  not exists (
    select 1
    from public.batch_students assignment
    where assignment.id = 'fca11111-1111-4111-8111-111111111111'
  )
    and (
      select count(*) = 1
      from public.batch_students assignment
      where assignment.workspace_id = 'fc444444-4444-4444-8444-444444444444'
        and assignment.student_id = 'fc222222-2222-4222-8222-222222222222'
        and assignment.batch_id = 'fc777777-7777-4777-8777-777777777777'
    ),
  'source removal and target assignment commit together without duplicates'
);

select is(
  (
    select submission.batch_id
    from public.submissions submission
    where submission.id = 'fcb11111-1111-4111-8111-111111111111'
  ),
  'fc666666-6666-4666-8666-666666666666'::uuid,
  'historical writing retains its exact original class context'
);

select is(
  (
    select request.status
    from public.batch_join_requests request
    where request.id = 'fca22222-2222-4222-8222-222222222222'
  ),
  'cancelled',
  'removing the source assignment atomically cancels its stale approved join request'
);

select is(
  (
    select count(*)::integer
    from app_private.batch_transfer_actions action
    where action.workspace_id = 'fc444444-4444-4444-8444-444444444444'
      and action.student_id = 'fc222222-2222-4222-8222-222222222222'
      and action.source_batch_id = 'fc666666-6666-4666-8666-666666666666'
      and action.target_batch_id = 'fc777777-7777-4777-8777-777777777777'
  ),
  1,
  'one immutable private transfer audit action is recorded'
);

select throws_ok(
  $$update app_private.batch_transfer_actions
    set target_created = false
    where source_assignment_id = 'fca11111-1111-4111-8111-111111111111'$$,
  '55000',
  'Adaptive-practice history is immutable.',
  'transfer audit actions cannot be changed after the fact'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fc111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select throws_ok(
  $$select api.transfer_student_class(
    'fc444444-4444-4444-8444-444444444444',
    'fc222222-2222-4222-8222-222222222222',
    'fca11111-1111-4111-8111-111111111111',
    'fc777777-7777-4777-8777-777777777777'
  )$$,
  'P0002',
  'source_class_assignment_not_found',
  'a stale duplicate transfer cannot remove or create another assignment'
);

select throws_ok(
  $$select api.transfer_student_class(
    'fc444444-4444-4444-8444-444444444444',
    'fc222222-2222-4222-8222-222222222222',
    (select (transfer_result ->> 'target_assignment_id')::uuid
     from pg_temp.phase_11l_state),
    'fc777777-7777-4777-8777-777777777777'
  )$$,
  '22023',
  'class_transfer_target_unchanged',
  'a transfer to the same class is rejected explicitly'
);

select throws_ok(
  $$select api.transfer_student_class(
    'fc444444-4444-4444-8444-444444444444',
    'fc222222-2222-4222-8222-222222222222',
    (select (transfer_result ->> 'target_assignment_id')::uuid
     from pg_temp.phase_11l_state),
    'fc888888-8888-4888-8888-888888888888'
  )$$,
  '55000',
  'active_target_class_required',
  'an archived target class cannot receive a transfer'
);

select throws_ok(
  $$select api.transfer_student_class(
    'fc444444-4444-4444-8444-444444444444',
    'fc222222-2222-4222-8222-222222222222',
    (select (transfer_result ->> 'target_assignment_id')::uuid
     from pg_temp.phase_11l_state),
    'fc999999-9999-4999-8999-999999999999'
  )$$,
  '22023',
  'class_transfer_target_invalid',
  'a cross-workspace target class is rejected'
);

reset role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fc222222-2222-4222-8222-222222222222', true);
set local role authenticated;

select throws_ok(
  $$select api.transfer_student_class(
    'fc444444-4444-4444-8444-444444444444',
    'fc222222-2222-4222-8222-222222222222',
    (select (transfer_result ->> 'target_assignment_id')::uuid
     from pg_temp.phase_11l_state),
    'fc666666-6666-4666-8666-666666666666'
  )$$,
  '42501',
  'permission_denied',
  'a student cannot transfer their own class assignment'
);

reset role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fc333333-3333-4333-8333-333333333333', true);
set local role authenticated;

select throws_ok(
  $$select api.transfer_student_class(
    'fc444444-4444-4444-8444-444444444444',
    'fc222222-2222-4222-8222-222222222222',
    (select (transfer_result ->> 'target_assignment_id')::uuid
     from pg_temp.phase_11l_state),
    'fc666666-6666-4666-8666-666666666666'
  )$$,
  '42501',
  'permission_denied',
  'an unrelated teacher cannot transfer another workspace student'
);

reset role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fc111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select is(
  (
    select result.membership_removed
    from api.offboard_student(
      'fc222222-2222-4222-8222-222222222222',
      'fc444444-4444-4444-8444-444444444444'
    ) result
  ),
  true,
  'later offboarding can remove a transferred assignment without damaging audit history'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.batch_transfer_actions action
    where action.student_id = 'fc222222-2222-4222-8222-222222222222'
  ),
  1,
  'offboarding preserves the immutable transfer audit record'
);

select ok(
  not exists (
    select 1
    from public.batch_students assignment
    where assignment.student_id = 'fc222222-2222-4222-8222-222222222222'
  )
    and exists (
      select 1
      from public.submissions submission
      where submission.id = 'fcb11111-1111-4111-8111-111111111111'
    ),
  'offboarding after transfer removes current access while retaining historical work'
);

select ok(
  not exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = 'fc444444-4444-4444-8444-444444444444'
      and membership.user_id = 'fc222222-2222-4222-8222-222222222222'
  ),
  'transferred student membership is removed exactly once during offboarding'
);

select * from finish();
rollback;
