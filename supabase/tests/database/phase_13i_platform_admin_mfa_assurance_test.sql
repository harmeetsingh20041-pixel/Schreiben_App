begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(51);

create or replace function pg_temp.phase_13i_set_actor(
  target_user_id uuid,
  target_session_id uuid,
  target_aal text,
  target_amr jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  claims jsonb := jsonb_build_object(
    'sub', target_user_id::text,
    'role', 'authenticated',
    'aal', target_aal,
    'amr', coalesce(target_amr, '[]'::jsonb)
  );
begin
  if target_session_id is not null then
    claims := claims || jsonb_build_object(
      'session_id', target_session_id::text
    );
  end if;

  perform set_config('request.jwt.claims', claims::text, true);
  perform set_config('request.jwt.claim.sub', target_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.aal', target_aal, true);
  perform set_config(
    'request.jwt.claim.session_id',
    coalesce(target_session_id::text, ''),
    true
  );
  perform set_config(
    'request.jwt.claim.amr',
    coalesce(target_amr, '[]'::jsonb)::text,
    true
  );
end;
$$;

select ok(
  to_regprocedure('app_private.current_totp_amr_epoch()') is not null
    and to_regprocedure(
      'app_private.lock_fresh_platform_admin_session()'
    ) is not null
    and to_regprocedure(
      'app_private.assert_platform_admin_mfa_precondition()'
    ) is not null
    and position(
      'lock_fresh_platform_admin_session'
      in pg_get_functiondef(
        'public.decide_teacher_access_internal(uuid,text,integer,integer)'::regprocedure
      )
    ) > 0
    and position(
      'lock_fresh_platform_admin_session'
      in pg_get_functiondef(
        'public.update_teacher_workspace_limit_internal(uuid,integer,integer)'::regprocedure
      )
    ) > 0
    and position(
      'lock_fresh_platform_admin_session'
      in pg_get_functiondef(
        'public.disable_teacher_access_internal(uuid,integer)'::regprocedure
      )
    ) > 0
    and position(
      'lock_fresh_platform_admin_session'
      in pg_get_functiondef(
        'app_private.create_teacher_workspace_internal(text)'::regprocedure
      )
    ) > 0
    and position(
      'create_teacher_workspace_internal'
      in pg_get_functiondef(
        'public.create_teacher_workspace(text)'::regprocedure
      )
    ) > 0,
  'the central AAL2 helper and every teacher-access mutation step-up wrapper exist'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.decide_teacher_access_aal2_legacy_internal(uuid,text,integer,integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.update_teacher_workspace_limit_aal2_legacy_internal(uuid,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.disable_teacher_access_aal2_legacy_internal(uuid,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.bootstrap_first_platform_admin(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.assert_platform_admin_mfa_precondition()',
      'EXECUTE'
    ),
  'authenticated callers cannot bypass step-up wrappers or invoke first-admin bootstrap'
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
    'ba111111-1111-4111-8111-111111111111'::uuid,
    'authenticated',
    'authenticated',
    'phase13i-admin@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13I Admin"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'bb222222-2222-4222-8222-222222222222'::uuid,
    'authenticated',
    'authenticated',
    'phase13i-incomplete-admin@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13I Incomplete Admin"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'bc333333-3333-4333-8333-333333333333'::uuid,
    'authenticated',
    'authenticated',
    'phase13i-expiring-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13I Expiring Teacher"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'bd444444-4444-4444-8444-444444444444'::uuid,
    'authenticated',
    'authenticated',
    'phase13i-inactive-drift@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13I Inactive Drift"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'be555555-5555-4555-8555-555555555555'::uuid,
    'authenticated',
    'authenticated',
    'phase13i-bootstrap@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13I Bootstrap"}'::jsonb,
    false,
    now(),
    now()
  );

insert into auth.sessions (id, user_id, created_at, updated_at, not_after)
values
  (
    'ba999999-9999-4999-8999-999999999999'::uuid,
    'ba111111-1111-4111-8111-111111111111'::uuid,
    now(),
    now(),
    now() + interval '1 day'
  ),
  (
    'bb999999-9999-4999-8999-999999999999'::uuid,
    'bb222222-2222-4222-8222-222222222222'::uuid,
    now(),
    now(),
    now() + interval '1 day'
  ),
  (
    'bc999999-9999-4999-8999-999999999999'::uuid,
    'bc333333-3333-4333-8333-333333333333'::uuid,
    now(),
    now(),
    now() + interval '1 day'
  ),
  (
    'be999999-9999-4999-8999-999999999999'::uuid,
    'be555555-5555-4555-8555-555555555555'::uuid,
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
    'ba811111-1111-4111-8111-111111111111'::uuid,
    'ba111111-1111-4111-8111-111111111111'::uuid,
    'Phase 13I primary TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'JBSWY3DPEHPK3PXP'
  ),
  (
    'ba822222-2222-4222-8222-222222222222'::uuid,
    'ba111111-1111-4111-8111-111111111111'::uuid,
    'Phase 13I backup TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'KRSXG5DSNFXGOIDB'
  ),
  (
    'bb811111-1111-4111-8111-111111111111'::uuid,
    'bb222222-2222-4222-8222-222222222222'::uuid,
    'Phase 13I incomplete primary TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'MFRGGZDFMZTWQ2LK'
  ),
  (
    'bb822222-2222-4222-8222-222222222222'::uuid,
    'bb222222-2222-4222-8222-222222222222'::uuid,
    'Phase 13I incomplete backup TOTP',
    'totp',
    'unverified',
    now(),
    now(),
    'ONSWG4TFOQXG43Q'
  ),
  (
    'be811111-1111-4111-8111-111111111111'::uuid,
    'be555555-5555-4555-8555-555555555555'::uuid,
    'Phase 13I bootstrap primary TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'GEZDGNBVGY3TQOJQ'
  ),
  (
    'be822222-2222-4222-8222-222222222222'::uuid,
    'be555555-5555-4555-8555-555555555555'::uuid,
    'Phase 13I bootstrap backup TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'HEZDGNBVGY3TQOJQ'
  );

delete from public.profiles
where id in (
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'bb222222-2222-4222-8222-222222222222'::uuid
);

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'ba111111-1111-4111-8111-111111111111'::uuid,
    'Phase 13I Admin',
    'phase13i-admin@example.test',
    'platform_admin'
  ),
  (
    'bb222222-2222-4222-8222-222222222222'::uuid,
    'Phase 13I Incomplete Admin',
    'phase13i-incomplete-admin@example.test',
    'platform_admin'
  );

select throws_ok(
  $$select app_private.assert_platform_admin_mfa_precondition()$$,
  '23514',
  'platform_admin_mfa_precondition_failed',
  'migration preflight rejects an existing administrator without two verified TOTP factors'
);

update auth.mfa_factors factor
set status = 'verified',
    updated_at = now()
where factor.id = 'bb822222-2222-4222-8222-222222222222'::uuid;

select lives_ok(
  $$select app_private.assert_platform_admin_mfa_precondition()$$,
  'migration preflight accepts live administrators with primary and backup TOTP factors'
);

update auth.users account
set banned_until = now() + interval '1 day',
    updated_at = now()
where account.id = 'bb222222-2222-4222-8222-222222222222'::uuid;

select throws_ok(
  $$select app_private.assert_platform_admin_mfa_precondition()$$,
  '23514',
  'platform_admin_mfa_precondition_failed',
  'migration preflight rejects an invalid existing administrator account'
);

update auth.users account
set banned_until = null,
    updated_at = now()
where account.id = 'bb222222-2222-4222-8222-222222222222'::uuid;

select lives_ok(
  $$select app_private.assert_platform_admin_mfa_precondition()$$,
  'migration preflight passes again after account validity is restored'
);

update auth.mfa_factors factor
set status = 'unverified',
    updated_at = now()
where factor.id = 'bb822222-2222-4222-8222-222222222222'::uuid;

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  revision,
  disabled_at,
  note
)
values
  (
    'bc333333-3333-4333-8333-333333333333'::uuid,
    true,
    1,
    1,
    null,
    'Phase 13I expiring teacher.'
  ),
  (
    'bd444444-4444-4444-8444-444444444444'::uuid,
    false,
    1,
    1,
    now() - interval '1 hour',
    'Phase 13I inactive entitlement with residual authority.'
  ),
  (
    'be555555-5555-4555-8555-555555555555'::uuid,
    true,
    1,
    1,
    null,
    'Phase 13I ordinary entitled-teacher workspace probe.'
  );

select pg_temp.phase_13i_set_actor(
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from now() - interval '1 minute')::bigint
    ),
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '30 seconds')::bigint
    )
  )
);

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    'bc666666-6666-4666-8666-666666666666'::uuid,
    'Phase 13I Expiring Workspace',
    'phase-13i-expiring-workspace',
    'bc333333-3333-4333-8333-333333333333'::uuid
  ),
  (
    'bd666666-6666-4666-8666-666666666666'::uuid,
    'Phase 13I Inactive Drift Workspace',
    'phase-13i-inactive-drift-workspace',
    'bd444444-4444-4444-8444-444444444444'::uuid
  ),
  (
    'be666666-6666-4666-8666-666666666666'::uuid,
    'Phase 13I Student Workspace',
    'phase-13i-student-workspace',
    'ba111111-1111-4111-8111-111111111111'::uuid
  );

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'bc666666-6666-4666-8666-666666666666'::uuid,
    'bc333333-3333-4333-8333-333333333333'::uuid,
    'owner'
  ),
  (
    'bd666666-6666-4666-8666-666666666666'::uuid,
    'bd444444-4444-4444-8444-444444444444'::uuid,
    'owner'
  ),
  (
    'be666666-6666-4666-8666-666666666666'::uuid,
    'ba111111-1111-4111-8111-111111111111'::uuid,
    'owner'
  ),
  (
    'be666666-6666-4666-8666-666666666666'::uuid,
    'bc333333-3333-4333-8333-333333333333'::uuid,
    'student'
  );

select pg_temp.phase_13i_set_actor(
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'aal1',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from now())::bigint
    )
  )
);
set local role authenticated;

select throws_ok(
  $$select * from api.get_teacher_onboarding_health()$$,
  '42501',
  'platform_admin_mfa_required',
  'an AAL1 administrator cannot read the control plane'
);

select throws_ok(
  $$select * from api.update_teacher_workspace_limit(
    'bc333333-3333-4333-8333-333333333333'::uuid, 1, 2
  )$$,
  '42501',
  'platform_admin_mfa_required',
  'an AAL1 administrator cannot mutate the control plane'
);

select throws_ok(
  $$select * from api.create_teacher_workspace(
    'Forbidden AAL1 administrator workspace'
  )$$,
  '42501',
  'platform_admin_mfa_required',
  'an AAL1 administrator cannot create a workspace through the admin bypass'
);

reset role;
select pg_temp.phase_13i_set_actor(
  'bb222222-2222-4222-8222-222222222222'::uuid,
  'bb999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now())::bigint
    )
  )
);
set local role authenticated;

select throws_ok(
  $$select * from api.get_teacher_onboarding_health()$$,
  '42501',
  'platform_admin_mfa_required',
  'AAL2 with fewer than two verified TOTP factors is rejected'
);

reset role;
select pg_temp.phase_13i_set_actor(
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '11 minutes')::bigint
    )
  )
);
set local role authenticated;

select lives_ok(
  $$select * from api.get_teacher_onboarding_health()$$,
  'an AAL2 administrator may read after the mutation freshness window'
);

select throws_ok(
  $$select * from api.update_teacher_workspace_limit(
    'bc333333-3333-4333-8333-333333333333'::uuid, 1, 2
  )$$,
  '42501',
  'platform_admin_fresh_authentication_required',
  'a stale TOTP verification cannot authorize an administrator mutation'
);

select throws_ok(
  $$select * from api.create_teacher_workspace(
    'Forbidden stale administrator workspace'
  )$$,
  '42501',
  'platform_admin_fresh_authentication_required',
  'the platform-admin workspace-creation branch also requires fresh TOTP'
);

reset role;
select pg_temp.phase_13i_set_actor(
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_object('method', 'totp', 'timestamp', 1)
);
set local role authenticated;

select throws_ok(
  $$select * from api.update_teacher_workspace_limit(
    'bc333333-3333-4333-8333-333333333333'::uuid, 1, 2
  )$$,
  '42501',
  'platform_admin_fresh_authentication_required',
  'a scalar AMR claim fails closed with the stable step-up error'
);

reset role;
select pg_temp.phase_13i_set_actor(
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object('method', 'totp', 'timestamp', 'not-an-epoch')
  )
);
set local role authenticated;

select throws_ok(
  $$select * from api.update_teacher_workspace_limit(
    'bc333333-3333-4333-8333-333333333333'::uuid, 1, 2
  )$$,
  '42501',
  'platform_admin_fresh_authentication_required',
  'a nonnumeric AMR timestamp fails closed without a cast error'
);

reset role;
select pg_temp.phase_13i_set_actor(
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() + interval '2 minutes')::bigint
    )
  )
);
set local role authenticated;

select throws_ok(
  $$select * from api.update_teacher_workspace_limit(
    'bc333333-3333-4333-8333-333333333333'::uuid, 1, 2
  )$$,
  '42501',
  'platform_admin_fresh_authentication_required',
  'a future AMR timestamp cannot extend the step-up window'
);

reset role;
select pg_temp.phase_13i_set_actor(
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from now())::bigint
    )
  )
);
set local role authenticated;

select throws_ok(
  $$select * from api.update_teacher_workspace_limit(
    'bc333333-3333-4333-8333-333333333333'::uuid, 1, 2
  )$$,
  '42501',
  'platform_admin_fresh_authentication_required',
  'a fresh password AMR entry cannot substitute for fresh TOTP'
);

reset role;
select pg_temp.phase_13i_set_actor(
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from now() - interval '1 minute')::bigint
    ),
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '30 seconds')::bigint
    )
  )
);
set local role authenticated;

select is(
  (
    select entitlement_revision
    from api.update_teacher_workspace_limit(
      'bc333333-3333-4333-8333-333333333333'::uuid, 1, 2
    )
  ),
  2,
  'fresh AAL2 backed by the two-factor TOTP set authorizes a mutation'
);

select lives_ok(
  $$select * from api.create_teacher_workspace(
    'Phase 13I Fresh Admin Workspace'
  )$$,
  'fresh AAL2 authorizes the platform-admin workspace-creation branch'
);

reset role;
select pg_temp.phase_13i_set_actor(
  'be555555-5555-4555-8555-555555555555'::uuid,
  'be999999-9999-4999-8999-999999999999'::uuid,
  'aal1',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from now())::bigint
    )
  )
);
set local role authenticated;

select lives_ok(
  $$select * from api.create_teacher_workspace(
    'Phase 13I Ordinary Teacher Workspace'
  )$$,
  'ordinary entitled-teacher workspace creation does not require administrator step-up'
);

reset role;
select pg_temp.phase_13i_set_actor(
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '30 seconds')::bigint
    )
  )
);
delete from auth.sessions auth_session
where auth_session.id = 'ba999999-9999-4999-8999-999999999999'::uuid;
set local role authenticated;

select throws_ok(
  $$select * from api.update_teacher_workspace_limit(
    'bc333333-3333-4333-8333-333333333333'::uuid, 2, 3
  )$$,
  '42501',
  'active_platform_admin_session_required',
  'revoking the Auth session immediately blocks a fresh AAL2 mutation'
);

reset role;
insert into auth.sessions (id, user_id, created_at, updated_at, not_after)
values (
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'ba111111-1111-4111-8111-111111111111'::uuid,
  now(),
  now(),
  now() + interval '1 day'
);

update app_private.teacher_entitlements entitlement
set granted_at = now() - interval '2 hours',
    expires_at = now() - interval '1 hour',
    updated_at = now()
where entitlement.user_id =
  'bc333333-3333-4333-8333-333333333333'::uuid;

select pg_temp.phase_13i_set_actor(
  'bc333333-3333-4333-8333-333333333333'::uuid,
  'bc999999-9999-4999-8999-999999999999'::uuid,
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
  (select teacher_entitled from public.get_auth_context()),
  false,
  'an expired entitlement becomes ineffective immediately'
);

select is(
  (
    select jsonb_array_length(memberships)
    from public.get_auth_context()
  ),
  1,
  'auth context removes expired privileged memberships but keeps the student membership'
);

select is(
  public.has_workspace_role(
    'bc666666-6666-4666-8666-666666666666'::uuid,
    array['owner', 'teacher']
  ),
  false,
  'an expired entitlement cannot retain owner or teacher authority'
);

select is(
  public.is_workspace_member(
    'bc666666-6666-4666-8666-666666666666'::uuid
  ),
  false,
  'an expired privileged row cannot retain generic workspace-member reads'
);

select is(
  public.has_workspace_role(
    'be666666-6666-4666-8666-666666666666'::uuid,
    array['student']
  ),
  true,
  'entitlement expiry does not remove an ordinary student role'
);

select is(
  public.is_workspace_member(
    'be666666-6666-4666-8666-666666666666'::uuid
  ),
  true,
  'entitlement expiry does not remove ordinary student membership reads'
);

reset role;
update app_private.teacher_entitlements entitlement
set expires_at = null,
    updated_at = now()
where entitlement.user_id =
  'bc333333-3333-4333-8333-333333333333'::uuid;
update auth.users account
set banned_until = now() + interval '1 hour',
    updated_at = now()
where account.id = 'bc333333-3333-4333-8333-333333333333'::uuid;
set local role authenticated;

select ok(
  (
    select not auth_context.teacher_entitled
      and auth_context.teacher_workspace_count = 0
      and jsonb_array_length(auth_context.memberships) = 1
      and auth_context.memberships -> 0 ->> 'role' = 'student'
      and auth_context.memberships -> 0 ->> 'workspace_id' =
        'be666666-6666-4666-8666-666666666666'
      and not (auth_context.memberships @> '[{"role":"owner"}]'::jsonb)
    from public.get_auth_context() auth_context
  ),
  'a banned teacher receives no entitlement or privileged workspace metadata while student membership remains'
);

reset role;
update auth.users account
set banned_until = null,
    email_confirmed_at = null,
    updated_at = now()
where account.id = 'bc333333-3333-4333-8333-333333333333'::uuid;
set local role authenticated;

select ok(
  (
    select not auth_context.teacher_entitled
      and auth_context.teacher_workspace_count = 0
      and jsonb_array_length(auth_context.memberships) = 1
      and auth_context.memberships -> 0 ->> 'role' = 'student'
      and auth_context.memberships -> 0 ->> 'workspace_id' =
        'be666666-6666-4666-8666-666666666666'
      and not (auth_context.memberships @> '[{"role":"owner"}]'::jsonb)
    from public.get_auth_context() auth_context
  ),
  'an unconfirmed teacher receives no entitlement or privileged workspace metadata while student membership remains'
);

reset role;
update auth.users account
set email_confirmed_at = now(),
    deleted_at = now(),
    updated_at = now()
where account.id = 'bc333333-3333-4333-8333-333333333333'::uuid;
set local role authenticated;

select ok(
  (
    select not auth_context.teacher_entitled
      and auth_context.teacher_workspace_count = 0
      and jsonb_array_length(auth_context.memberships) = 1
      and auth_context.memberships -> 0 ->> 'role' = 'student'
      and auth_context.memberships -> 0 ->> 'workspace_id' =
        'be666666-6666-4666-8666-666666666666'
      and not (auth_context.memberships @> '[{"role":"owner"}]'::jsonb)
    from public.get_auth_context() auth_context
  ),
  'a deleted teacher receives no entitlement or privileged workspace metadata while student membership remains'
);

reset role;
update auth.users account
set deleted_at = null,
    updated_at = now()
where account.id = 'bc333333-3333-4333-8333-333333333333'::uuid;
update app_private.teacher_entitlements entitlement
set expires_at = now() - interval '1 hour',
    updated_at = now()
where entitlement.user_id =
  'bc333333-3333-4333-8333-333333333333'::uuid;

select pg_temp.phase_13i_set_actor(
  'ba111111-1111-4111-8111-111111111111'::uuid,
  'ba999999-9999-4999-8999-999999999999'::uuid,
  'aal2',
  jsonb_build_array(
    jsonb_build_object(
      'method', 'totp',
      'timestamp', extract(epoch from now() - interval '30 seconds')::bigint
    )
  )
);
set local role authenticated;

select is(
  (
    select entitlement_revision
    from api.disable_teacher_access(
      'bc333333-3333-4333-8333-333333333333'::uuid, 2
    )
  ),
  3,
  'an active but expired entitlement can be finish-offboarded'
);

select is(
  (
    select transferred_workspace_count
    from api.disable_teacher_access(
      'bc333333-3333-4333-8333-333333333333'::uuid, 2
    )
  ),
  1,
  'expired-entitlement offboarding transfers owned workspaces exactly once'
);

select is(
  (
    select removed_privileged_membership_count
    from api.disable_teacher_access(
      'bc333333-3333-4333-8333-333333333333'::uuid, 2
    )
  ),
  1,
  'expired-entitlement offboarding removes privileged memberships exactly once'
);

select is(
  (
    select transferred_workspace_count
    from api.disable_teacher_access(
      'bc333333-3333-4333-8333-333333333333'::uuid, 2
    )
  ),
  1,
  'a lost-response retry replays the original offboarding result'
);

reset role;
select is(
  (
    select count(*)::integer
    from app_private.teacher_access_audit audit_row
    where audit_row.target_user_id =
      'bc333333-3333-4333-8333-333333333333'::uuid
      and audit_row.action = 'disabled'
  ),
  1,
  'expired-entitlement retry does not duplicate the immutable disable audit'
);
set local role authenticated;

select is(
  (
    select entitlement_revision
    from api.disable_teacher_access(
      'bd444444-4444-4444-8444-444444444444'::uuid, 1
    )
  ),
  2,
  'an inactive entitlement with residual authority is repaired'
);

select is(
  (
    select transferred_workspace_count
    from api.disable_teacher_access(
      'bd444444-4444-4444-8444-444444444444'::uuid, 1
    )
  ),
  1,
  'inactive-state repair transfers the residual owned workspace'
);

select is(
  (
    select entitlement_revision
    from api.disable_teacher_access(
      'bd444444-4444-4444-8444-444444444444'::uuid, 2
    )
  ),
  2,
  'a clean inactive state is an idempotent zero-change success'
);

select is(
  (
    select transferred_workspace_count
    from api.disable_teacher_access(
      'bd444444-4444-4444-8444-444444444444'::uuid, 2
    )
  ),
  0,
  'clean inactive replay does not transfer a workspace again'
);

reset role;
select is(
  (
    select count(*)::integer
    from app_private.teacher_access_audit audit_row
    where audit_row.target_user_id =
      'bd444444-4444-4444-8444-444444444444'::uuid
      and audit_row.action = 'disabled'
  ),
  1,
  'inactive-state repair creates one immutable disable audit'
);

update public.profiles profile
set global_role = 'student'
where profile.id = 'bb222222-2222-4222-8222-222222222222'::uuid;
update public.profiles profile
set global_role = 'student'
where profile.id = 'ba111111-1111-4111-8111-111111111111'::uuid;

-- A linked staging run may already contain the real pilot administrator.
-- Hide any pre-existing administrator inside this rollback-only transaction so
-- the first-admin bootstrap assertions exercise the same isolated state as a
-- fresh local database. Concurrent sessions keep seeing the committed role.
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.session_id', '', true);
select set_config('request.jwt.claim.aal', '', true);
select set_config('request.jwt.claim.amr', '[]', true);

do $$
declare
  existing_admin_id uuid;
begin
  for existing_admin_id in
    select profile.id
    from public.profiles profile
    where profile.global_role = 'platform_admin'
      and profile.id not in (
        'ba111111-1111-4111-8111-111111111111'::uuid,
        'bb222222-2222-4222-8222-222222222222'::uuid
      )
  loop
    perform set_config(
      'app.platform_admin_recovery_demote_target',
      existing_admin_id::text,
      true
    );
    update public.profiles profile
    set global_role = 'student',
        updated_at = now()
    where profile.id = existing_admin_id;
    perform set_config(
      'app.platform_admin_recovery_demote_target',
      '',
      true
    );
  end loop;
end;
$$;

select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.session_id', '', true);
select set_config('request.jwt.claim.aal', '', true);
select set_config('request.jwt.claim.amr', '[]', true);

select lives_ok(
  $$select app_private.bootstrap_first_platform_admin(
    'be555555-5555-4555-8555-555555555555'::uuid
  )$$,
  'the database owner can bootstrap the first administrator only after two verified TOTP factors exist'
);

select is(
  (
    select profile.global_role
    from public.profiles profile
    where profile.id = 'be555555-5555-4555-8555-555555555555'::uuid
  ),
  'platform_admin',
  'first-admin bootstrap promotes exactly the verified standard account'
);

select is(
  (
    select count(*)::integer
    from app_private.platform_admin_security_audit audit_row
    where audit_row.target_user_id =
      'be555555-5555-4555-8555-555555555555'::uuid
      and audit_row.action = 'first_admin_bootstrapped'
      and audit_row.verified_totp_factor_count = 2
  ),
  1,
  'first-admin bootstrap writes one content-free security audit row'
);

select throws_ok(
  $$update app_private.platform_admin_security_audit
    set database_actor = 'changed'$$,
  '55000',
  'platform_admin_security_audit_immutable',
  'first-admin security audit rows cannot be updated'
);

select throws_ok(
  $$delete from app_private.platform_admin_security_audit$$,
  '55000',
  'platform_admin_security_audit_immutable',
  'first-admin security audit rows cannot be deleted'
);

select throws_ok(
  $$select app_private.bootstrap_first_platform_admin(
    'bc333333-3333-4333-8333-333333333333'::uuid
  )$$,
  '42501',
  'first_platform_admin_already_exists',
  'the private bootstrap function cannot create a second administrator'
);

select lives_ok(
  $$select app_private.demote_platform_admin_for_mfa_recovery(
    'be555555-5555-4555-8555-555555555555'::uuid
  )$$,
  'the database owner can immediately demote a lost-factor administrator'
);

select is(
  (
    select profile.global_role
    from public.profiles profile
    where profile.id = 'be555555-5555-4555-8555-555555555555'::uuid
  ),
  'student',
  'lost-factor recovery removes platform authority before factor reset'
);

select lives_ok(
  $$select app_private.restore_platform_admin_after_mfa_recovery(
    'be555555-5555-4555-8555-555555555555'::uuid
  )$$,
  'the database owner can restore the same account after two verified factors exist'
);

select is(
  (
    select profile.global_role
    from public.profiles profile
    where profile.id = 'be555555-5555-4555-8555-555555555555'::uuid
  ),
  'platform_admin',
  'recovery restoration returns platform authority only after factor validation'
);

select is(
  (
    select count(*)::integer
    from app_private.platform_admin_security_audit audit_row
    where audit_row.target_user_id =
      'be555555-5555-4555-8555-555555555555'::uuid
      and audit_row.action in (
        'admin_recovery_demoted',
        'admin_recovery_restored'
      )
  ),
  2,
  'lost-factor demotion and restoration each leave immutable security evidence'
);

select * from finish(true);
rollback;
