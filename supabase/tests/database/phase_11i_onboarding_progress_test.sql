begin;

select plan(19);

select ok(
  to_regclass('app_private.onboarding_progress') is not null,
  'persistent onboarding progress lives in the private schema'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.onboarding_progress'::regclass)
    and not has_table_privilege('authenticated', 'app_private.onboarding_progress', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.onboarding_progress', 'INSERT')
    and not has_table_privilege('anon', 'app_private.onboarding_progress', 'SELECT'),
  'onboarding rows are RLS-protected and never directly exposed'
);
select ok(
  not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid = 'api.get_onboarding_progress(uuid,text)'::regprocedure
  )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid = 'api.complete_onboarding_step(uuid,text,text,integer)'::regprocedure
    )
    and (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid = 'public.get_onboarding_progress_internal(uuid,text)'::regprocedure
    )
    and (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid = 'public.complete_onboarding_step_internal(uuid,text,text,integer)'::regprocedure
    ),
  'exposed onboarding wrappers are invokers and privileged bodies remain non-exposed'
);
select ok(
  has_function_privilege(
    'authenticated',
    'api.get_onboarding_progress(uuid,text)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'api.complete_onboarding_step(uuid,text,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_onboarding_progress(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.get_onboarding_progress_internal(uuid,text)',
      'EXECUTE'
    ),
  'only authenticated callers can use the narrow onboarding API'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'ed111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11i-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11I Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ed222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase11i-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11I Student"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ed333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase11i-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11I Outsider"}'::jsonb, now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'ed444444-4444-4444-8444-444444444444',
  'Phase 11I Workspace',
  'phase-11i-workspace',
  'ed111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'ed111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'ed444444-4444-4444-8444-444444444444',
  'ed111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'ed444444-4444-4444-8444-444444444444',
  'ed222222-2222-4222-8222-222222222222',
  'student'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'ed111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select is(
  (api.get_onboarding_progress(
    'ed444444-4444-4444-8444-444444444444',
    'teacher'
  ) ->> 'revision')::integer,
  0,
  'a teacher checklist starts at revision zero without creating a row on read'
);
select is(
  jsonb_array_length(api.get_onboarding_progress(
    'ed444444-4444-4444-8444-444444444444',
    'teacher'
  ) -> 'completed_steps'),
  0,
  'a new teacher checklist begins incomplete'
);
select ok(
  api.complete_onboarding_step(
    'ed444444-4444-4444-8444-444444444444',
    'teacher',
    'share_join_code',
    0
  ) @> '{"revision":1,"completed_steps":["share_join_code"]}'::jsonb,
  'a manual teacher step persists with optimistic revision one'
);
select is(
  (
    api.complete_onboarding_step(
      'ed444444-4444-4444-8444-444444444444',
      'teacher',
      'share_join_code',
      0
    ) ->> 'revision'
  )::integer,
  1,
  'retrying an already committed checklist step is idempotent'
);
select throws_ok(
  $$select api.complete_onboarding_step(
    'ed444444-4444-4444-8444-444444444444',
    'teacher',
    'review_first_submission',
    0
  )$$,
  '40001',
  'onboarding_revision_conflict',
  'a stale checklist revision cannot overwrite newer progress'
);
select throws_ok(
  $$select api.complete_onboarding_step(
    'ed444444-4444-4444-8444-444444444444',
    'teacher',
    'review_feedback',
    1
  )$$,
  '22023',
  'onboarding_step_invalid',
  'teacher and student checklist step sets cannot be mixed'
);

reset role;

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode
)
values (
  'ed555555-5555-4555-8555-555555555555',
  'ed444444-4444-4444-8444-444444444444',
  'Phase 11I A2',
  'A2',
  true,
  'teacher_review_only'
);

insert into public.batch_students (id, batch_id, student_id, workspace_id)
values (
  'ed666666-6666-4666-8666-666666666666',
  'ed555555-5555-4555-8555-555555555555',
  'ed222222-2222-4222-8222-222222222222',
  'ed444444-4444-4444-8444-444444444444'
);

select set_config('request.jwt.claim.sub', 'ed111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select ok(
  api.get_onboarding_progress(
    'ed444444-4444-4444-8444-444444444444',
    'teacher'
  ) @> '{"completed_steps":["create_class","choose_feedback_mode","share_join_code"],"completed_count":3,"total_count":4}'::jsonb,
  'class creation and feedback-mode steps are derived from durable workspace state'
);

reset role;

insert into public.submissions (
  id,
  workspace_id,
  student_id,
  batch_id,
  mode,
  question_source,
  original_text,
  corrected_text,
  overall_summary,
  status,
  feedback_mode,
  evaluation_status,
  release_status,
  checked_at,
  release_at
)
values (
  'ed777777-7777-4777-8777-777777777777',
  'ed444444-4444-4444-8444-444444444444',
  'ed222222-2222-4222-8222-222222222222',
  'ed555555-5555-4555-8555-555555555555',
  'free_text',
  'free_text',
  'Ich lerne Deutsch.',
  'Ich lerne Deutsch.',
  'Keine Korrektur nötig.',
  'checked',
  'immediate',
  'ready',
  'released',
  now(),
  now()
);

select set_config('request.jwt.claim.sub', 'ed111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select ok(
  api.get_onboarding_progress(
    'ed444444-4444-4444-8444-444444444444',
    'teacher'
  ) @> '{"completed_steps":["create_class","choose_feedback_mode","share_join_code","review_first_submission"],"completed_count":4,"all_complete":true}'::jsonb,
  'a safely released automatic result completes the compatibility-named first-result step without manual teacher release'
);

select set_config('request.jwt.claim.sub', 'ed222222-2222-4222-8222-222222222222', true);

select ok(
  api.get_onboarding_progress(
    'ed444444-4444-4444-8444-444444444444',
    'student'
  ) @> '{"revision":0,"completed_steps":["join_class","submit_writing"],"completed_count":2,"next_step":"review_feedback"}'::jsonb,
  'approved enrollment and the existing submission complete both derived student steps'
);
select ok(
  api.complete_onboarding_step(
    'ed444444-4444-4444-8444-444444444444',
    'student',
    'review_feedback',
    0
  ) @> '{"revision":1,"completed_steps":["join_class","review_feedback"]}'::jsonb,
  'student feedback-view progress persists alongside derived enrollment state'
);
select throws_ok(
  $$select api.get_onboarding_progress(
    'ed444444-4444-4444-8444-444444444444',
    'teacher'
  )$$,
  '42501',
  'teacher_workspace_required',
  'a student cannot read the teacher checklist for the same workspace'
);

select set_config('request.jwt.claim.sub', 'ed333333-3333-4333-8333-333333333333', true);

select throws_ok(
  $$select api.get_onboarding_progress(
    'ed444444-4444-4444-8444-444444444444',
    'student'
  )$$,
  '42501',
  'student_workspace_required',
  'an unrelated account cannot read another student workspace checklist'
);

reset role;

select throws_ok(
  $$insert into app_private.onboarding_progress (
    user_id,
    workspace_id,
    role,
    completed_steps
  ) values (
    'ed333333-3333-4333-8333-333333333333',
    'ed444444-4444-4444-8444-444444444444',
    'teacher',
    array['review_feedback']
  )$$,
  '23514',
  'new row for relation "onboarding_progress" violates check constraint "onboarding_progress_steps_check"',
  'the table constraint rejects cross-role checklist steps even from privileged code'
);

select is(
  (
    select count(*)::integer
    from app_private.onboarding_progress progress
    where progress.workspace_id = 'ed444444-4444-4444-8444-444444444444'
  ),
  2,
  'reads remain side-effect free and only explicit manual progress creates rows'
);
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
  'onboarding preserves the exact sealed API definer allowlist'
);

select * from finish();
rollback;
