begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

create or replace function pg_temp.phase_13x_set_actor(
  target_user_id uuid,
  target_session_id uuid,
  target_aal text,
  target_amr jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', target_user_id::text,
      'role', 'authenticated',
      'aal', target_aal,
      'session_id', target_session_id::text,
      'amr', target_amr
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', target_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.aal', target_aal, true);
  perform set_config(
    'request.jwt.claim.session_id',
    target_session_id::text,
    true
  );
  perform set_config('request.jwt.claim.amr', target_amr::text, true);
end;
$$;

select ok(
  to_regprocedure('api.get_my_teacher_start()') is not null
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid = 'api.get_my_teacher_start()'::regprocedure
    )
    and has_function_privilege(
      'authenticated',
      'api.get_my_teacher_start()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_my_teacher_start()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.ensure_teacher_default_workspace_internal(uuid)',
      'EXECUTE'
    ),
  'the self projection is invoker-only and the provisioning helper is private'
);

select ok(
  position(
    'char_length(clean_name) > 120'
    in pg_get_functiondef(
      'app_private.create_teacher_workspace_internal(text)'::regprocedure
    )
  ) > 0
    and position(
      'ensure_teacher_default_workspace_internal'
      in pg_get_functiondef(
        'public.decide_teacher_access_internal(uuid,text,integer,integer)'::regprocedure
      )
    ) > 0
    and position(
      'lock_fresh_platform_admin_session'
      in pg_get_functiondef(
        'public.decide_teacher_access_internal(uuid,text,integer,integer)'::regprocedure
      )
    ) > 0,
  'the stable workspace and approval entry points retain validation and fresh MFA'
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
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'da111111-1111-4111-8111-111111111111'::uuid,
    'authenticated',
    'authenticated',
    'phase13x-admin@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13X Admin"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'db222222-2222-4222-8222-222222222222'::uuid,
    'authenticated',
    'authenticated',
    'phase13x-new-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13X New Teacher"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'dc333333-3333-4333-8333-333333333333'::uuid,
    'authenticated',
    'authenticated',
    'phase13x-existing-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13X Existing Teacher"}'::jsonb,
    false,
    now(),
    now()
  );

insert into auth.sessions (id, user_id, created_at, updated_at, not_after)
values
  (
    'da999999-9999-4999-8999-999999999999'::uuid,
    'da111111-1111-4111-8111-111111111111'::uuid,
    now(),
    now(),
    now() + interval '1 day'
  ),
  (
    'db999999-9999-4999-8999-999999999999'::uuid,
    'db222222-2222-4222-8222-222222222222'::uuid,
    now(),
    now(),
    now() + interval '1 day'
  );

insert into auth.mfa_factors (
  id,
  user_id,
  friendly_name,
  factor_type,
  status,
  created_at,
  updated_at,
  secret
)
values
  (
    'da811111-1111-4111-8111-111111111111'::uuid,
    'da111111-1111-4111-8111-111111111111'::uuid,
    'Phase 13X primary',
    'totp',
    'verified',
    now(),
    now(),
    'JBSWY3DPEHPK3PXP'
  ),
  (
    'da822222-2222-4222-8222-222222222222'::uuid,
    'da111111-1111-4111-8111-111111111111'::uuid,
    'Phase 13X backup',
    'totp',
    'verified',
    now(),
    now(),
    'KRSXG5DSNFXGOIDB'
  );

-- The Auth user hook creates student profiles. Remove those generated rows so
-- this fixture can insert the platform-admin role without exercising the
-- application-facing role-escalation trigger.
delete from public.profiles
where id in (
  'da111111-1111-4111-8111-111111111111'::uuid,
  'db222222-2222-4222-8222-222222222222'::uuid,
  'dc333333-3333-4333-8333-333333333333'::uuid
);

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'da111111-1111-4111-8111-111111111111'::uuid,
    'Phase 13X Admin',
    'phase13x-admin@example.test',
    'platform_admin'
  ),
  (
    'db222222-2222-4222-8222-222222222222'::uuid,
    'Phase 13X New Teacher',
    'phase13x-new-teacher@example.test',
    'student'
  ),
  (
    'dc333333-3333-4333-8333-333333333333'::uuid,
    'Phase 13X Existing Teacher',
    'phase13x-existing-teacher@example.test',
    'student'
  );

insert into app_private.teacher_access_requests (
  id,
  user_id,
  status,
  revision,
  requested_at,
  created_at,
  updated_at
)
values
  (
    'db777777-7777-4777-8777-777777777777'::uuid,
    'db222222-2222-4222-8222-222222222222'::uuid,
    'pending',
    1,
    now(),
    now(),
    now()
  ),
  (
    'dc777777-7777-4777-8777-777777777777'::uuid,
    'dc333333-3333-4333-8333-333333333333'::uuid,
    'pending',
    1,
    now(),
    now(),
    now()
  );

insert into public.workspaces (
  id,
  name,
  slug,
  owner_id
)
values (
  'dc666666-6666-4666-8666-666666666666'::uuid,
  'Existing Teaching Area',
  'phase-13x-existing-teaching-area',
  'dc333333-3333-4333-8333-333333333333'::uuid
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'dc333333-3333-4333-8333-333333333333'::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'dc333333-3333-4333-8333-333333333333',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);
insert into public.workspace_members (workspace_id, user_id, role)
values (
  'dc666666-6666-4666-8666-666666666666'::uuid,
  'dc333333-3333-4333-8333-333333333333'::uuid,
  'owner'
);
select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select pg_temp.phase_13x_set_actor(
  'da111111-1111-4111-8111-111111111111'::uuid,
  'da999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '30 seconds')::bigint
    )
  )
);
set local role authenticated;

select lives_ok(
  $$select * from api.decide_teacher_access(
    'db777777-7777-4777-8777-777777777777'::uuid,
    'approved',
    1,
    2
  )$$,
  'approving a new teacher atomically provisions the default teaching area'
);

reset role;
select is(
  (
    select count(*)::integer
    from public.workspaces workspace
    where workspace.owner_id =
      'db222222-2222-4222-8222-222222222222'::uuid
  ),
  1,
  'approval creates exactly one owned workspace'
);

select is(
  (
    select count(*)::integer
    from public.workspace_members membership
    where membership.user_id =
      'db222222-2222-4222-8222-222222222222'::uuid
      and membership.role = 'owner'
  ),
  1,
  'approval creates exactly one owner membership'
);

select is(
  (
    select count(*)::integer
    from app_private.teacher_access_audit audit
    where audit.target_user_id =
      'db222222-2222-4222-8222-222222222222'::uuid
      and audit.action = 'approved'
  ),
  1,
  'the original approval audit remains singular'
);

select pg_temp.phase_13x_set_actor(
  'da111111-1111-4111-8111-111111111111'::uuid,
  'da999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '30 seconds')::bigint
    )
  )
);
set local role authenticated;

select lives_ok(
  $$select * from api.decide_teacher_access(
    'db777777-7777-4777-8777-777777777777'::uuid,
    'approved',
    1,
    2
  )$$,
  'a lost-response approval replay remains idempotent'
);

reset role;
select is(
  (
    select count(*)::integer
    from public.workspaces workspace
    where workspace.owner_id =
      'db222222-2222-4222-8222-222222222222'::uuid
  ),
  1,
  'approval replay cannot create a second default workspace'
);

select pg_temp.phase_13x_set_actor(
  'db222222-2222-4222-8222-222222222222'::uuid,
  'db999999-9999-4999-8999-999999999999'::uuid,
  'aal1',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from now())::bigint
    )
  )
);
set local role authenticated;

select is(
  (select needs_first_class from api.get_my_teacher_start()),
  true,
  'the approved teacher projection routes to first-class creation'
);

select lives_ok(
  format(
    'select * from api.create_teacher_workspace(%L)',
    repeat('😀', 120)
  ),
  'a 120-code-point teaching-area name is accepted'
);

reset role;
select is(
  (
    select char_length(workspace.name)::integer
    from public.workspaces workspace
    where workspace.owner_id =
      'db222222-2222-4222-8222-222222222222'::uuid
      and workspace.name = repeat('😀', 120)
  ),
  120,
  'the database persists the exact 120 Unicode code points'
);

select pg_temp.phase_13x_set_actor(
  'db222222-2222-4222-8222-222222222222'::uuid,
  'db999999-9999-4999-8999-999999999999'::uuid,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

select throws_ok(
  format(
    'select * from api.create_teacher_workspace(%L)',
    repeat('😀', 121)
  ),
  '22023',
  'workspace_name_invalid',
  'the RPC rejects the 121st Unicode code point before quota handling'
);

select throws_ok(
  $$select * from api.create_teacher_workspace('   ')$$,
  '22023',
  'workspace_name_invalid',
  'the RPC rejects a whitespace-only name'
);

select throws_ok(
  $$select * from api.create_teacher_workspace(E'\t\n\r')$$,
  '22023',
  'workspace_name_invalid',
  'the RPC rejects an ASCII-control-whitespace-only name'
);

select throws_ok(
  $$select * from api.create_teacher_workspace(U&'\00A0\202F\3000')$$,
  '22023',
  'workspace_name_invalid',
  'the RPC rejects a Unicode-whitespace-only name'
);

reset role;
select throws_ok(
  format(
    'insert into public.workspaces (name, slug, owner_id) values (%L, %L, %L::uuid)',
    repeat('x', 121),
    'phase-13x-invalid-direct-name',
    'db222222-2222-4222-8222-222222222222'
  ),
  '23514',
  'new row for relation "workspaces" violates check constraint "workspaces_name_code_point_length"',
  'the table constraint rejects a new overlong name outside the RPC'
);

select throws_ok(
  $$insert into public.workspaces (name, slug, owner_id)
    values (
      U&'\00A0\202F\3000',
      'phase-13x-invalid-direct-whitespace-name',
      'db222222-2222-4222-8222-222222222222'::uuid
    )$$,
  '23514',
  'new row for relation "workspaces" violates check constraint "workspaces_name_code_point_length"',
  'the table constraint rejects Unicode-whitespace-only names outside the RPC'
);

insert into public.batches (
  workspace_id,
  name,
  level,
  created_by
)
select
  workspace.id,
  'First Class',
  'A1',
  'db222222-2222-4222-8222-222222222222'::uuid
from public.workspaces workspace
where workspace.owner_id =
  'db222222-2222-4222-8222-222222222222'::uuid
  and workspace.name = 'My German Class';

select pg_temp.phase_13x_set_actor(
  'db222222-2222-4222-8222-222222222222'::uuid,
  'db999999-9999-4999-8999-999999999999'::uuid,
  'aal1',
  '[]'::jsonb
);
set local role authenticated;

select ok(
  (
    select
      not teacher_start.needs_first_class
      and exists (
        select 1
        from public.workspaces workspace
        where workspace.id = teacher_start.workspace_id
          and workspace.name = 'My German Class'
      )
    from api.get_my_teacher_start() teacher_start
  ),
  'the projection selects the class-bearing workspace and stops reopening the wizard'
);

reset role;
select pg_temp.phase_13x_set_actor(
  'da111111-1111-4111-8111-111111111111'::uuid,
  'da999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '30 seconds')::bigint
    )
  )
);
set local role authenticated;

select lives_ok(
  $$select * from api.decide_teacher_access(
    'dc777777-7777-4777-8777-777777777777'::uuid,
    'approved',
    1,
    2
  )$$,
  'approving a teacher with an existing teaching area does not reprovision'
);

reset role;
select is(
  (
    select count(*)::integer
    from public.workspace_members membership
    where membership.user_id =
      'dc333333-3333-4333-8333-333333333333'::uuid
      and membership.role in ('owner', 'teacher')
  ),
  1,
  'an existing privileged membership suppresses default provisioning'
);

select is(
  (
    select count(*)::integer
    from public.workspaces workspace
    where workspace.name = 'My German Class'
      and workspace.owner_id =
        'dc333333-3333-4333-8333-333333333333'::uuid
  ),
  0,
  'approval never creates a default workspace for an existing teacher'
);

select * from finish(true);
rollback;
