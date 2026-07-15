begin;

-- Shared-staging-safe: extensions and fixture rows are created only inside this
-- transaction and the final rollback leaves no catalog or tenant residue.
create extension if not exists pgtap with schema extensions;
create extension if not exists plpgsql_check with schema extensions;
set local search_path = public, extensions, pg_catalog;

select plan(11);

select ok(
  (
    select bool_and(routine.provolatile = 's'::"char")
    from pg_proc routine
    where routine.oid in (
      'app_private.assert_onboarding_context(uuid,text)'::regprocedure,
      'public.get_onboarding_progress_internal(uuid,text)'::regprocedure,
      'api.get_onboarding_progress(uuid,text)'::regprocedure
    )
  ),
  'the complete read-only onboarding call chain is STABLE'
);

select ok(
  (
    select bool_and(
      exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
    )
    from pg_proc routine
    where routine.oid in (
      'app_private.assert_onboarding_context(uuid,text)'::regprocedure,
      'public.get_onboarding_progress_internal(uuid,text)'::regprocedure,
      'api.get_onboarding_progress(uuid,text)'::regprocedure
    )
  )
    and (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'app_private.assert_onboarding_context(uuid,text)'::regprocedure
    )
    and (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'public.get_onboarding_progress_internal(uuid,text)'::regprocedure
    )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid = 'api.get_onboarding_progress(uuid,text)'::regprocedure
    ),
  'the repair preserves pinned search paths and definer/invoker boundaries'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.get_onboarding_progress_internal(uuid,text)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'api.get_onboarding_progress(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.assert_onboarding_context(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.get_onboarding_progress_internal(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_onboarding_progress(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.get_onboarding_progress_internal(uuid,text)',
      'EXECUTE'
    ),
  'the repair preserves the exact reviewed execute grants'
);

select is(
  (
    select count(*)::integer
    from (
      select check_row.level
      from extensions.plpgsql_check_function_tb(
        'app_private.assert_onboarding_context(uuid,text)'::regprocedure
      ) check_row
      union all
      select check_row.level
      from extensions.plpgsql_check_function_tb(
        'public.get_onboarding_progress_internal(uuid,text)'::regprocedure
      ) check_row
    ) checks
    where checks.level in ('error', 'warning')
  ),
  0,
  'plpgsql_check reports no error or warning in the repaired call chain'
);

select ok(
  pg_get_functiondef(
    'public.get_onboarding_progress_internal(uuid,text)'::regprocedure
  ) !~ E'(?m)^\\s*step\\s+text\\s*;',
  'the unused step declaration is absent'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'f0111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12o-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12O Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'f0222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12o-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12O Student"}'::jsonb, now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'f0333333-3333-4333-8333-333333333333',
  'Phase 12O Workspace',
  'phase-12o-workspace',
  'f0111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'f0111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'f0333333-3333-4333-8333-333333333333',
  'f0111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'f0333333-3333-4333-8333-333333333333',
  'f0222222-2222-4222-8222-222222222222',
  'student'
);

set local role authenticated;

select ok(
  api.get_onboarding_progress(
    'f0333333-3333-4333-8333-333333333333',
    'teacher'
  ) @> '{
    "role":"teacher",
    "revision":0,
    "completed_steps":[],
    "completed_count":0,
    "total_count":4,
    "next_step":"create_class"
  }'::jsonb,
  'the repaired teacher reader preserves its initial checklist result'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.onboarding_progress progress
    where progress.workspace_id =
      'f0333333-3333-4333-8333-333333333333'
  ),
  0,
  'reading onboarding progress remains side-effect free'
);

set local role authenticated;

select ok(
  api.complete_onboarding_step(
    'f0333333-3333-4333-8333-333333333333',
    'teacher',
    'share_join_code',
    0
  ) @> '{"revision":1,"completed_steps":["share_join_code"]}'::jsonb,
  'the existing completion writer still composes with the STABLE reader'
);

select is(
  (
    api.complete_onboarding_step(
      'f0333333-3333-4333-8333-333333333333',
      'teacher',
      'share_join_code',
      0
    ) ->> 'revision'
  )::integer,
  1,
  'an idempotent completion retry preserves its revision behavior'
);

select set_config(
  'request.jwt.claim.sub',
  'f0222222-2222-4222-8222-222222222222',
  true
);

select ok(
  api.get_onboarding_progress(
    'f0333333-3333-4333-8333-333333333333',
    'student'
  ) @> '{
    "role":"student",
    "revision":0,
    "completed_steps":[],
    "next_step":"join_class"
  }'::jsonb,
  'the repaired reader preserves the student checklist result'
);

select throws_ok(
  $$select api.get_onboarding_progress(
    'f0333333-3333-4333-8333-333333333333',
    'teacher'
  )$$,
  '42501',
  'teacher_workspace_required',
  'the repaired helper preserves cross-role authorization rejection'
);

reset role;

select * from finish();
rollback;
