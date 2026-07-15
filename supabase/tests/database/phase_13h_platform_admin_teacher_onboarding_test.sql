begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(64);

select ok(
  to_regclass('app_private.teacher_access_requests') is not null
    and to_regclass('app_private.teacher_access_audit') is not null
    and to_regclass('app_private.teacher_access_workspace_transfers') is not null
    and to_regclass('app_private.teacher_access_requests_global_page_idx') is not null
    and to_regprocedure('api.request_teacher_access(integer)') is not null
    and to_regprocedure('api.get_my_teacher_access_request()') is not null
    and to_regprocedure(
      'api.list_teacher_access_requests(text,integer,timestamp with time zone,uuid)'
    ) is not null
    and to_regprocedure(
      'api.decide_teacher_access(uuid,text,integer,integer)'
    ) is not null
    and to_regprocedure(
      'api.update_teacher_workspace_limit(uuid,integer,integer)'
    ) is not null
    and to_regprocedure('api.disable_teacher_access(uuid,integer)') is not null
    and to_regprocedure('api.get_teacher_onboarding_health()') is not null,
  'the private onboarding state and complete API surface exist'
);

select ok(
  not (
    select procedure.prosecdef
    from pg_proc procedure
    where procedure.oid = 'api.request_teacher_access(integer)'::regprocedure
  )
    and not (
      select procedure.prosecdef
      from pg_proc procedure
      where procedure.oid =
        'api.list_teacher_access_requests(text,integer,timestamp with time zone,uuid)'::regprocedure
    )
    and not (
      select procedure.prosecdef
      from pg_proc procedure
      where procedure.oid =
        'api.decide_teacher_access(uuid,text,integer,integer)'::regprocedure
    )
    and not (
      select procedure.prosecdef
      from pg_proc procedure
      where procedure.oid =
        'api.disable_teacher_access(uuid,integer)'::regprocedure
    )
    and not (
      select procedure.prosecdef
      from pg_proc procedure
      where procedure.oid =
        'api.get_teacher_onboarding_health()'::regprocedure
    )
    and not (
      select procedure.prosecdef
      from pg_proc procedure
      where procedure.oid =
        'api.get_my_teacher_access_request()'::regprocedure
    )
    and not (
      select procedure.prosecdef
      from pg_proc procedure
      where procedure.oid =
        'api.update_teacher_workspace_limit(uuid,integer,integer)'::regprocedure
    ),
  'every deliberately exposed onboarding facade is SECURITY INVOKER'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.request_teacher_access(integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'api.decide_teacher_access(uuid,text,integer,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.get_my_teacher_access_request()',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.update_teacher_workspace_limit(uuid,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.request_teacher_access(integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.decide_teacher_access(uuid,text,integer,integer)',
      'EXECUTE'
    ),
  'only authenticated application callers can enter the onboarding facades'
);

select ok(
  (
    select table_row.relrowsecurity
    from pg_class table_row
    where table_row.oid = 'app_private.teacher_access_requests'::regclass
  )
    and (
      select table_row.relrowsecurity
      from pg_class table_row
      where table_row.oid = 'app_private.teacher_access_audit'::regclass
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.teacher_access_requests',
      'SELECT'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.teacher_access_audit',
      'SELECT'
    )
    and (
      select table_row.relrowsecurity
      from pg_class table_row
      where table_row.oid =
        'app_private.teacher_access_workspace_transfers'::regclass
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.teacher_access_workspace_transfers',
      'SELECT'
    ),
  'both private onboarding tables use RLS and have no browser or service reads'
);

select ok(
  has_table_privilege(
    'service_role',
    'app_private.teacher_entitlements',
    'SELECT'
  )
    and not has_table_privilege(
      'service_role',
      'app_private.teacher_entitlements',
      'INSERT'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.teacher_entitlements',
      'UPDATE'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.teacher_entitlements',
      'SELECT'
    ),
  'trusted entitlements are readable for service diagnostics but not directly writable'
);

select ok(
  pg_get_function_result(
    'api.get_teacher_onboarding_health()'::regprocedure
  ) !~* '(content|payload|error|email|name|user_id)',
  'aggregate onboarding health exposes no content, payload, raw error, or identity field'
);

select ok(
  position(
    'lock_teacher_access_account(caller_id)'
    in pg_get_functiondef(
      'app_private.create_teacher_workspace_internal(text)'::regprocedure
    )
  ) > 0,
  'workspace creation shares the serialized account lock with request and disable'
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
    'aa111111-1111-4111-8111-111111111111'::uuid,
    'authenticated',
    'authenticated',
    'phase13h-admin@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13H Admin"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'ab222222-2222-4222-8222-222222222222'::uuid,
    'authenticated',
    'authenticated',
    'phase13h-admin-two@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13H Admin Two"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'ac333333-3333-4333-8333-333333333333'::uuid,
    'authenticated',
    'authenticated',
    'phase13h-applicant@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13H Applicant","global_role":"platform_admin","account_type":"teacher"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'ad444444-4444-4444-8444-444444444444'::uuid,
    'authenticated',
    'authenticated',
    'phase13h-rejected@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13H Rejected Applicant"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'ae555555-5555-4555-8555-555555555555'::uuid,
    'authenticated',
    'authenticated',
    'phase13h-unconfirmed@example.test',
    '',
    null,
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13H Unconfirmed","account_type":"teacher"}'::jsonb,
    false,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'af777777-7777-4777-8777-777777777777'::uuid,
    'authenticated',
    'authenticated',
    'phase13h-legacy-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13H Legacy Teacher"}'::jsonb,
    false,
    now(),
    now()
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
    'aa811111-1111-4111-8111-111111111111'::uuid,
    'aa111111-1111-4111-8111-111111111111'::uuid,
    'Phase 13H Admin primary TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'JBSWY3DPEHPK3PXP'
  ),
  (
    'aa822222-2222-4222-8222-222222222222'::uuid,
    'aa111111-1111-4111-8111-111111111111'::uuid,
    'Phase 13H Admin backup TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'KRSXG5DSNFXGOIDB'
  ),
  (
    'ab811111-1111-4111-8111-111111111111'::uuid,
    'ab222222-2222-4222-8222-222222222222'::uuid,
    'Phase 13H Admin Two primary TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'MFRGGZDFMZTWQ2LK'
  ),
  (
    'ab822222-2222-4222-8222-222222222222'::uuid,
    'ab222222-2222-4222-8222-222222222222'::uuid,
    'Phase 13H Admin Two backup TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'ONSWG4TFOQXG43Q'
  );

insert into auth.sessions (
  id,
  user_id,
  created_at,
  updated_at,
  not_after
)
values
  (
    'aa999999-9999-4999-8999-999999999999'::uuid,
    'aa111111-1111-4111-8111-111111111111'::uuid,
    now(),
    now(),
    now() + interval '1 day'
  ),
  (
    'ab999999-9999-4999-8999-999999999999'::uuid,
    'ab222222-2222-4222-8222-222222222222'::uuid,
    now(),
    now(),
    now() + interval '1 day'
  ),
  (
    'ac999999-9999-4999-8999-999999999999'::uuid,
    'ac333333-3333-4333-8333-333333333333'::uuid,
    now(),
    now(),
    now() + interval '1 day'
  );

select set_config(
  'request.jwt.claim.session_id',
  'aa999999-9999-4999-8999-999999999999',
  true
);

-- Auth synchronization creates standard student profiles. Replace only the
-- two transaction-owned administrator fixtures, without hardcoded launch IDs.
delete from public.profiles
where id in (
  'aa111111-1111-4111-8111-111111111111'::uuid,
  'ab222222-2222-4222-8222-222222222222'::uuid,
  'af777777-7777-4777-8777-777777777777'::uuid
);

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'aa111111-1111-4111-8111-111111111111'::uuid,
    'Phase 13H Admin',
    'phase13h-admin@example.test',
    'platform_admin'
  ),
  (
    'ab222222-2222-4222-8222-222222222222'::uuid,
    'Phase 13H Admin Two',
    'phase13h-admin-two@example.test',
    'platform_admin'
  ),
  (
    'af777777-7777-4777-8777-777777777777'::uuid,
    'Phase 13H Legacy Teacher',
    'phase13h-legacy-teacher@example.test',
    'teacher'
  );

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  revision,
  note
)
values
  (
    'ab222222-2222-4222-8222-222222222222'::uuid,
    true,
    100,
    1,
    'Phase 13H other-administrator protection fixture.'
  ),
  (
    'af777777-7777-4777-8777-777777777777'::uuid,
    false,
    1,
    1,
    'Phase 13H inactive legacy-teacher fixture.'
  );

select set_config(
  'request.jwt.claim.sub',
  'aa111111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.aal', 'aal2', true);
select set_config(
  'request.jwt.claim.amr',
  jsonb_build_array(
    jsonb_build_object(
      'method',
      'password',
      'timestamp',
      extract(epoch from now() - interval '1 minute')::bigint
    ),
    jsonb_build_object(
      'method',
      'totp',
      'timestamp',
      extract(epoch from now() - interval '30 seconds')::bigint
    )
  )::text,
  true
);
set local role authenticated;

select lives_ok(
  $$select * from api.get_teacher_onboarding_health()$$,
  'an active platform-admin session can read aggregate onboarding health'
);

reset role;

update auth.users account
set banned_until = now() + interval '1 day'
where account.id = 'aa111111-1111-4111-8111-111111111111'::uuid;

set local role authenticated;

select throws_ok(
  $$select * from api.get_teacher_onboarding_health()$$,
  '42501',
  'active_platform_admin_session_required',
  'a banned administrator JWT cannot read applicant or health state'
);

select throws_ok(
  $$select * from api.update_teacher_workspace_limit(
    'af777777-7777-4777-8777-777777777777'::uuid,
    1,
    2
  )$$,
  '42501',
  'active_platform_admin_session_required',
  'a banned administrator JWT cannot mutate a trusted entitlement'
);

reset role;

update auth.users account
set banned_until = null
where account.id = 'aa111111-1111-4111-8111-111111111111'::uuid;

delete from auth.sessions auth_session
where auth_session.id = 'aa999999-9999-4999-8999-999999999999'::uuid;

set local role authenticated;

select throws_ok(
  $$select * from api.get_teacher_onboarding_health()$$,
  '42501',
  'active_platform_admin_session_required',
  'a revoked administrator session cannot use an otherwise valid JWT'
);

reset role;

insert into auth.sessions (
  id,
  user_id,
  created_at,
  updated_at,
  not_after
)
values (
  'aa999999-9999-4999-8999-999999999999'::uuid,
  'aa111111-1111-4111-8111-111111111111'::uuid,
  now(),
  now(),
  now() + interval '1 day'
);

set local role authenticated;

select ok(
  exists (
    select 1
    from api.list_teacher_access_requests('disabled', 25, null, null) inventory
    where inventory.applicant_user_id =
      'af777777-7777-4777-8777-777777777777'::uuid
      and inventory.request_id is null
      and inventory.page_cursor_id = inventory.applicant_user_id
      and inventory.entitlement_revision = 1
      and inventory.entitlement_max_workspaces = 1
  ),
  'entitlement-backed inventory exposes a manageable revision for a backfilled teacher without a request'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  'ae555555-5555-4555-8555-555555555555',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$select * from api.request_teacher_access(0)$$,
  '42501',
  'confirmed_standard_account_required',
  'an unconfirmed account cannot request teacher access even with teacher metadata'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  'ac333333-3333-4333-8333-333333333333',
  true
);
select set_config(
  'request.jwt.claim.session_id',
  'ac999999-9999-4999-8999-999999999999',
  true
);
set local role authenticated;

select is(
  (select request_status from api.request_teacher_access(0)),
  'pending',
  'an email-confirmed standard account can create a pending request'
);

select is(
  (select request_revision from api.request_teacher_access(0)),
  1,
  'lost-response replay returns the same request revision'
);

select is(
  (select request_revision from api.get_my_teacher_access_request()),
  1,
  'an applicant can reload the current private request revision through a self-only facade'
);

reset role;

select ok(
  (
    select profile.global_role = 'student'
    from public.profiles profile
    where profile.id = 'ac333333-3333-4333-8333-333333333333'::uuid
  )
    and not exists (
      select 1
      from app_private.teacher_entitlements entitlement
      where entitlement.user_id =
        'ac333333-3333-4333-8333-333333333333'::uuid
    ),
  'self-supplied role metadata neither changes the trusted profile nor grants access'
);

select is(
  (
    select count(*)::integer
    from app_private.teacher_access_requests request
    where request.user_id = 'ac333333-3333-4333-8333-333333333333'::uuid
  ),
  1,
  'request replay creates no duplicate request row'
);

select is(
  (
    select count(*)::integer
    from app_private.teacher_access_audit audit
    where audit.target_user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
      and audit.action = 'requested'
  ),
  1,
  'request replay creates no duplicate audit row'
);

select set_config(
  'request.jwt.claim.sub',
  'ac333333-3333-4333-8333-333333333333',
  true
);
set local role authenticated;

select throws_ok(
  $$select * from api.request_teacher_access(8)$$,
  '40001',
  'teacher_access_revision_conflict',
  'a stale or invented request revision is rejected'
);

select throws_ok(
  $$select * from api.list_teacher_access_requests(null, 25, null, null)$$,
  '42501',
  'active_platform_admin_session_required',
  'a standard account cannot list teacher requests'
);

select throws_ok(
  $$select * from api.get_teacher_onboarding_health()$$,
  '42501',
  'active_platform_admin_session_required',
  'a standard account cannot inspect aggregate administrator health'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  'aa111111-1111-4111-8111-111111111111',
  true
);
select set_config(
  'request.jwt.claim.session_id',
  'aa999999-9999-4999-8999-999999999999',
  true
);
set local role authenticated;

select ok(
  exists (
    select 1
    from api.list_teacher_access_requests('pending', 25, null, null) request
    where request.applicant_user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
      and request.applicant_email = 'phase13h-applicant@example.test'
      and request.request_revision = 1
      and not request.entitlement_active
  ),
  'the administrator list returns authoritative identity plus both safe revisions'
);

select throws_ok(
  $$select *
    from api.decide_teacher_access(
      (
        select request.request_id
        from api.list_teacher_access_requests('pending', 25, null, null) request
        where request.applicant_user_id =
          'ac333333-3333-4333-8333-333333333333'::uuid
      ),
      null,
      1,
      2
    )$$,
  '22023',
  'teacher_access_decision_invalid',
  'a null decision fails with the stable validation code and cannot become a rejection'
);

select is(
  (
    select decision_result.request_revision
    from api.list_teacher_access_requests('pending', 25, null, null) request
    cross join lateral api.decide_teacher_access(
      request.request_id,
      'approved',
      request.request_revision,
      2
    ) decision_result
    where request.applicant_user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
  ),
  2,
  'an administrator can approve the exact pending revision'
);

reset role;

select ok(
  (
    select entitlement.active
      and entitlement.max_workspaces = 2
      and entitlement.revision = 1
      and entitlement.granted_by =
        'aa111111-1111-4111-8111-111111111111'::uuid
    from app_private.teacher_entitlements entitlement
    where entitlement.user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
  )
    and (
      select profile.global_role = 'student'
      from public.profiles profile
      where profile.id = 'ac333333-3333-4333-8333-333333333333'::uuid
    ),
  'approval activates only the trusted entitlement and never promotes profile metadata'
);

select is(
  (
    select count(*)::integer
    from app_private.teacher_access_audit audit
    where audit.target_user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
      and audit.action = 'approved'
      and audit.request_revision_before = 1
      and audit.request_revision_after = 2
      and audit.entitlement_revision_after = 1
  ),
  1,
  'approval records one immutable revision-bound audit event'
);

select set_config(
  'request.jwt.claim.sub',
  'aa111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select is(
  (
    select decision_result.request_revision
    from api.list_teacher_access_requests('approved', 25, null, null) request
    cross join lateral api.decide_teacher_access(
      request.request_id,
      'approved',
      request.request_revision - 1,
      2
    ) decision_result
    where request.applicant_user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
  ),
  2,
  'approval lost-response replay returns the same revision'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.teacher_access_audit audit
    where audit.target_user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
      and audit.action = 'approved'
  ),
  1,
  'approval replay creates no duplicate entitlement or audit event'
);

select set_config(
  'request.jwt.claim.sub',
  'ac333333-3333-4333-8333-333333333333',
  true
);
select set_config(
  'request.jwt.claim.session_id',
  'ac999999-9999-4999-8999-999999999999',
  true
);

update auth.users account
set banned_until = now() + interval '1 day'
where account.id = 'ac333333-3333-4333-8333-333333333333'::uuid;

set local role authenticated;

select throws_ok(
  $$select * from api.create_teacher_workspace('Blocked Banned Teacher')$$,
  '42501',
  'active_account_session_required',
  'a banned teacher JWT cannot create a workspace'
);

reset role;

update auth.users account
set banned_until = null
where account.id = 'ac333333-3333-4333-8333-333333333333'::uuid;

delete from auth.sessions auth_session
where auth_session.id = 'ac999999-9999-4999-8999-999999999999'::uuid;

set local role authenticated;

select throws_ok(
  $$select * from api.create_teacher_workspace('Blocked Revoked Teacher')$$,
  '42501',
  'active_account_session_required',
  'a revoked teacher session cannot create a workspace'
);

reset role;

insert into auth.sessions (
  id,
  user_id,
  created_at,
  updated_at,
  not_after
)
values (
  'ac999999-9999-4999-8999-999999999999'::uuid,
  'ac333333-3333-4333-8333-333333333333'::uuid,
  now(),
  now(),
  now() + interval '1 day'
);

set local role authenticated;

select lives_ok(
  $$select * from api.create_teacher_workspace('Phase 13H Class One')$$,
  'an approved teacher can create the first entitled workspace'
);

select lives_ok(
  $$select * from api.create_teacher_workspace('Phase 13H Class Two')$$,
  'an approved teacher can create the second entitled workspace'
);

reset role;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'af666666-6666-4666-8666-666666666666'::uuid,
  'Phase 13H Administrator Workspace',
  'phase-13h-administrator-workspace',
  'aa111111-1111-4111-8111-111111111111'::uuid
);

select set_config(
  'request.jwt.claim.sub',
  'aa111111-1111-4111-8111-111111111111',
  true
);
select set_config(
  'request.jwt.claim.session_id',
  'aa999999-9999-4999-8999-999999999999',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'af666666-6666-4666-8666-666666666666'::uuid,
  'aa111111-1111-4111-8111-111111111111'::uuid,
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'af666666-6666-4666-8666-666666666666'::uuid,
  'ac333333-3333-4333-8333-333333333333'::uuid,
  'teacher'
);

insert into public.batches (
  workspace_id,
  name,
  level,
  created_by
)
select
  workspace.id,
  'Phase 13H Historical Batch',
  'A2',
  'ac333333-3333-4333-8333-333333333333'::uuid
from public.workspaces workspace
where workspace.owner_id = 'ac333333-3333-4333-8333-333333333333'::uuid
order by workspace.id
limit 1;

select is(
  (
    select count(*)::integer
    from public.workspace_members membership
    where membership.user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
      and membership.role in ('owner', 'teacher')
  ),
  3,
  'the disable fixture has two owned workspaces plus one teacher membership'
);

select set_config(
  'request.jwt.claim.sub',
  'ac333333-3333-4333-8333-333333333333',
  true
);
select set_config(
  'request.jwt.claim.session_id',
  'ac999999-9999-4999-8999-999999999999',
  true
);
set local role authenticated;

select throws_ok(
  $$select * from api.disable_teacher_access(
    'ac333333-3333-4333-8333-333333333333'::uuid,
    1
  )$$,
  '42501',
  'active_platform_admin_session_required',
  'a teacher cannot disable teacher access'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  'aa111111-1111-4111-8111-111111111111',
  true
);
select set_config(
  'request.jwt.claim.session_id',
  'aa999999-9999-4999-8999-999999999999',
  true
);
set local role authenticated;

select throws_ok(
  $$select * from api.disable_teacher_access(
    'aa111111-1111-4111-8111-111111111111'::uuid,
    1
  )$$,
  '42501',
  'platform_admin_self_disable_forbidden',
  'an administrator cannot disable their own account'
);

select throws_ok(
  $$select * from api.disable_teacher_access(
    'ab222222-2222-4222-8222-222222222222'::uuid,
    1
  )$$,
  '42501',
  'platform_admin_disable_forbidden',
  'an administrator cannot disable another platform administrator'
);

select ok(
  (
    select health.active_entitlement_count >= 1
      and health.pending_request_count >= 0
      and health.owned_workspace_without_active_access_count >= 0
      and health.privileged_membership_without_active_access_count >= 0
      and health.generated_at is not null
    from api.get_teacher_onboarding_health() health
  ),
  'aggregate health returns bounded identity-free counts to the administrator'
);

select ok(
  (
    select disable_result.entitlement_revision = 2
      and disable_result.request_revision = 3
      and disable_result.transferred_workspace_count = 2
      and disable_result.removed_privileged_membership_count = 3
    from api.disable_teacher_access(
      'ac333333-3333-4333-8333-333333333333'::uuid,
      1
    ) disable_result
  ),
  'disable atomically reports entitlement, request, takeover, and membership revisions'
);

reset role;

select ok(
  (
    select count(*) = 2
    from public.workspaces workspace
    where workspace.owner_id =
      'aa111111-1111-4111-8111-111111111111'::uuid
      and workspace.name in ('Phase 13H Class One', 'Phase 13H Class Two')
  )
    and not exists (
      select 1
      from public.workspace_members membership
      where membership.user_id =
        'ac333333-3333-4333-8333-333333333333'::uuid
        and membership.role in ('owner', 'teacher')
    )
    and (
      select count(*) = 2
      from public.workspace_members membership
      join public.workspaces workspace on workspace.id = membership.workspace_id
      where membership.user_id =
        'aa111111-1111-4111-8111-111111111111'::uuid
        and membership.role = 'owner'
        and workspace.name in ('Phase 13H Class One', 'Phase 13H Class Two')
    ),
  'every owned workspace transfers to the acting admin before target privileges disappear'
);

select ok(
  exists (
    select 1
    from public.batches batch
    where batch.name = 'Phase 13H Historical Batch'
      and batch.created_by =
        'ac333333-3333-4333-8333-333333333333'::uuid
  ),
  'disable preserves historical teacher-created class data'
);

select ok(
  (
    select not entitlement.active
      and entitlement.revision = 2
      and entitlement.disabled_by =
        'aa111111-1111-4111-8111-111111111111'::uuid
      and entitlement.disabled_at is not null
    from app_private.teacher_entitlements entitlement
    where entitlement.user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
  )
    and (
      select request.status = 'disabled' and request.revision = 3
      from app_private.teacher_access_requests request
      where request.user_id =
        'ac333333-3333-4333-8333-333333333333'::uuid
    ),
  'disable marks both trusted entitlement and request state inactive'
);

select is(
  (
    select count(*)::integer
    from app_private.teacher_access_audit audit
    where audit.target_user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
      and audit.action = 'disabled'
      and audit.entitlement_revision_before = 1
      and audit.entitlement_revision_after = 2
      and audit.transferred_workspace_count = 2
      and audit.removed_privileged_membership_count = 3
  ),
  1,
  'disable records one content-free immutable takeover audit event'
);

select is(
  (
    select count(*)::integer
    from app_private.teacher_access_workspace_transfers transfer
    join app_private.teacher_access_audit audit
      on audit.id = transfer.audit_id
    where audit.target_user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
      and audit.action = 'disabled'
      and transfer.previous_owner_user_id =
        'ac333333-3333-4333-8333-333333333333'::uuid
      and transfer.new_owner_user_id =
        'aa111111-1111-4111-8111-111111111111'::uuid
  ),
  2,
  'disable retains immutable per-workspace ownership-transfer evidence'
);

select set_config(
  'request.jwt.claim.sub',
  'aa111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select ok(
  (
    select disable_result.entitlement_revision = 2
      and disable_result.request_revision = 3
      and disable_result.transferred_workspace_count = 2
      and disable_result.removed_privileged_membership_count = 3
    from api.disable_teacher_access(
      'ac333333-3333-4333-8333-333333333333'::uuid,
      1
    ) disable_result
  ),
  'disable lost-response replay returns the exact recorded result'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.teacher_access_audit audit
    where audit.target_user_id =
      'ac333333-3333-4333-8333-333333333333'::uuid
      and audit.action = 'disabled'
  ),
  1,
  'disable replay performs no second takeover and writes no duplicate audit'
);

select set_config(
  'request.jwt.claim.sub',
  'ac333333-3333-4333-8333-333333333333',
  true
);
set local role authenticated;

select ok(
  (
    select request.request_status = 'disabled'
      and request.request_revision = 3
      and not request.entitlement_active
      and request.entitlement_revision = 2
    from api.get_my_teacher_access_request() request
  ),
  'after reload a disabled teacher receives the exact revisions needed to reapply'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  'ac333333-3333-4333-8333-333333333333',
  true
);
select set_config(
  'request.jwt.claim.session_id',
  'ac999999-9999-4999-8999-999999999999',
  true
);
set local role authenticated;

select throws_ok(
  $$select * from api.create_teacher_workspace('Forbidden After Disable')$$,
  '42501',
  'Teacher onboarding is not enabled for this account.',
  'a disabled teacher cannot create another workspace'
);

select is(
  (select request_revision from api.request_teacher_access(3)),
  4,
  'a disabled standard account can submit a revision-safe new request'
);

reset role;

select throws_ok(
  $$update app_private.teacher_access_audit
    set occurred_at = occurred_at + interval '1 second'
    where target_user_id = 'ac333333-3333-4333-8333-333333333333'::uuid$$,
  '55000',
  'teacher_access_audit_immutable',
  'teacher-access audit rows cannot be updated'
);

select throws_ok(
  $$delete from app_private.teacher_access_audit
    where target_user_id = 'ac333333-3333-4333-8333-333333333333'::uuid$$,
  '55000',
  'teacher_access_audit_immutable',
  'teacher-access audit rows cannot be deleted'
);

select throws_ok(
  $$delete from app_private.teacher_access_requests
    where user_id = 'ac333333-3333-4333-8333-333333333333'::uuid$$,
  '55000',
  'teacher_access_request_history_immutable',
  'teacher request history cannot be deleted'
);

insert into public.workspace_members (workspace_id, user_id, role)
select
  workspace.id,
  'af777777-7777-4777-8777-777777777777'::uuid,
  'teacher'
from public.workspaces workspace
where workspace.name in ('Phase 13H Class One', 'Phase 13H Class Two');

select set_config(
  'request.jwt.claim.sub',
  'af777777-7777-4777-8777-777777777777',
  true
);
set local role authenticated;

select is(
  (select request_revision from api.request_teacher_access(0)),
  1,
  'an inactive legacy teacher entitlement may enter the trusted request workflow'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  'aa111111-1111-4111-8111-111111111111',
  true
);
select set_config(
  'request.jwt.claim.session_id',
  'aa999999-9999-4999-8999-999999999999',
  true
);
set local role authenticated;

select throws_ok(
  $$select *
    from api.decide_teacher_access(
      (
        select request.request_id
        from api.list_teacher_access_requests('pending', 25, null, null) request
        where request.applicant_user_id =
          'af777777-7777-4777-8777-777777777777'::uuid
      ),
      'approved',
      1,
      1
    )$$,
  '23514',
  'teacher_workspace_limit_below_current_usage',
  'approval cannot set a workspace quota below current privileged memberships'
);

select is(
  (
    select decision_result.request_revision
    from api.list_teacher_access_requests('pending', 25, null, null) request
    cross join lateral api.decide_teacher_access(
      request.request_id,
      'approved',
      request.request_revision,
      2
    ) decision_result
    where request.applicant_user_id =
      'af777777-7777-4777-8777-777777777777'::uuid
  ),
  2,
  'an administrator can approve a legacy inactive entitlement through the same revision-safe path'
);

reset role;

select ok(
  (
    select profile.global_role = 'student'
    from public.profiles profile
    where profile.id = 'af777777-7777-4777-8777-777777777777'::uuid
  )
    and (
      select entitlement.active
        and entitlement.revision = 2
        and entitlement.max_workspaces = 2
      from app_private.teacher_entitlements entitlement
      where entitlement.user_id =
        'af777777-7777-4777-8777-777777777777'::uuid
    ),
  'legacy teacher role is normalized while the private entitlement becomes authoritative'
);

select set_config(
  'request.jwt.claim.sub',
  'aa111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select ok(
  (
    select quota.entitlement_revision = 3
      and quota.entitlement_max_workspaces = 3
      and quota.request_revision = 3
      and quota.current_privileged_workspace_count = 2
    from api.update_teacher_workspace_limit(
      'af777777-7777-4777-8777-777777777777'::uuid,
      2,
      3
    ) quota
  ),
  'the administrator can raise a teacher quota from the exact entitlement revision'
);

select is(
  (
    select quota.entitlement_revision
    from api.update_teacher_workspace_limit(
      'af777777-7777-4777-8777-777777777777'::uuid,
      2,
      3
    ) quota
  ),
  3,
  'quota-update lost-response replay returns the same entitlement revision'
);

select throws_ok(
  $$select * from api.update_teacher_workspace_limit(
    'af777777-7777-4777-8777-777777777777'::uuid,
    3,
    1
  )$$,
  '23514',
  'teacher_workspace_limit_below_current_usage',
  'quota updates cannot undercut current owner or teacher memberships'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.teacher_access_audit audit
    where audit.target_user_id =
      'af777777-7777-4777-8777-777777777777'::uuid
      and audit.action = 'workspace_limit_updated'
      and audit.entitlement_revision_before = 2
      and audit.entitlement_revision_after = 3
      and audit.previous_max_workspaces = 2
      and audit.max_workspaces = 3
  ),
  1,
  'quota update retains one immutable old/new revision audit event'
);

select set_config(
  'request.jwt.claim.sub',
  'ad444444-4444-4444-8444-444444444444',
  true
);
set local role authenticated;

select is(
  (select request_revision from api.request_teacher_access(0)),
  1,
  'a second confirmed applicant receives an independent request revision'
);

reset role;

update auth.users account
set banned_until = now() + interval '1 day'
where account.id = 'ad444444-4444-4444-8444-444444444444'::uuid;

select set_config(
  'request.jwt.claim.sub',
  'aa111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select is(
  (
    select decision_result.request_revision
    from api.list_teacher_access_requests('pending', 25, null, null) request
    cross join lateral api.decide_teacher_access(
      request.request_id,
      'rejected',
      request.request_revision,
      1
    ) decision_result
    where request.applicant_user_id =
      'ad444444-4444-4444-8444-444444444444'::uuid
  ),
  2,
  'an administrator can safely reject a now-banned applicant and close the pending queue row'
);

reset role;

update auth.users account
set banned_until = null
where account.id = 'ad444444-4444-4444-8444-444444444444'::uuid;

select ok(
  not exists (
    select 1
    from app_private.teacher_entitlements entitlement
    where entitlement.user_id =
      'ad444444-4444-4444-8444-444444444444'::uuid
  )
    and exists (
      select 1
      from app_private.teacher_access_requests request
      where request.user_id =
        'ad444444-4444-4444-8444-444444444444'::uuid
        and request.status = 'rejected'
        and request.revision = 2
    ),
  'rejection never creates a teacher entitlement'
);

select set_config(
  'request.jwt.claim.sub',
  'ad444444-4444-4444-8444-444444444444',
  true
);
set local role authenticated;

select is(
  (select request_revision from api.request_teacher_access(2)),
  3,
  'a rejected applicant can resubmit only from the exact current revision'
);

select * from finish();
rollback;
