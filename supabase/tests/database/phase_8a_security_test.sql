begin;

select plan(60);

-- Catalog-level privilege and exposure assertions.
select has_table(
  'app_private',
  'teacher_entitlements',
  'teacher entitlements live in the private schema'
);
select has_table(
  'app_private',
  'batch_join_codes',
  'batch join codes live in the private schema'
);
select hasnt_column(
  'public',
  'batches',
  'join_code',
  'the student-readable batch row contains no join secret'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.teacher_entitlements'::regclass),
  'teacher entitlements have RLS defense in depth'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.batch_join_codes'::regclass),
  'batch join codes have RLS defense in depth'
);
select ok(
  not has_table_privilege('authenticated', 'app_private.teacher_entitlements', 'SELECT'),
  'authenticated users cannot read teacher entitlements directly'
);
select ok(
  not has_table_privilege('authenticated', 'app_private.batch_join_codes', 'SELECT'),
  'authenticated users cannot read join codes directly'
);
select ok(
  not has_schema_privilege('authenticated', 'app_private', 'USAGE'),
  'authenticated users have no direct access to the private schema'
);
select ok(
  (
    with expected(oid) as (
      values
        ('public.is_platform_admin()'::regprocedure::oid),
        ('public.is_workspace_member(uuid)'::regprocedure::oid),
        ('public.has_workspace_role(uuid,text[])'::regprocedure::oid),
        ('public.prevent_workspace_member_escalation()'::regprocedure::oid),
        ('public.ensure_student_practice_assignment(uuid,uuid,uuid)'::regprocedure::oid),
        ('public.start_practice_assignment(uuid)'::regprocedure::oid),
        ('public.submit_practice_attempt(uuid,jsonb)'::regprocedure::oid),
        ('public.get_practice_assignment_questions(uuid)'::regprocedure::oid),
        ('public.list_student_practice_assignments(uuid,uuid)'::regprocedure::oid),
        ('public.get_practice_assignment_review(uuid)'::regprocedure::oid),
        ('public.create_next_practice_assignment(uuid)'::regprocedure::oid)
    )
    select count(*) = 11 and bool_and(p.prosecdef)
    from expected e
    join pg_proc p on p.oid = e.oid
  ),
  'public compatibility wrappers retain private access without exposing the private schema'
);
select ok(
  (
    with expected(oid) as (
      values
        ('public.is_platform_admin()'::regprocedure::oid),
        ('public.is_workspace_member(uuid)'::regprocedure::oid),
        ('public.has_workspace_role(uuid,text[])'::regprocedure::oid),
        ('public.ensure_student_practice_assignment(uuid,uuid,uuid)'::regprocedure::oid),
        ('public.start_practice_assignment(uuid)'::regprocedure::oid),
        ('public.submit_practice_attempt(uuid,jsonb)'::regprocedure::oid),
        ('public.get_practice_assignment_questions(uuid)'::regprocedure::oid),
        ('public.list_student_practice_assignments(uuid,uuid)'::regprocedure::oid),
        ('public.get_practice_assignment_review(uuid)'::regprocedure::oid),
        ('public.create_next_practice_assignment(uuid)'::regprocedure::oid)
    )
    select bool_and(not has_function_privilege('anon', e.oid, 'EXECUTE'))
    from expected e
  ),
  'the security-definer compatibility wrappers remain unavailable to anonymous callers'
);
select ok(
  not exists (
    select 1
    from pg_policy policy
    where policy.polname in (
      'student_invitations_select_workspace_teacher_or_recipient',
      'practice_attempt_question_reviews_select_owner_or_teacher'
    )
      and pg_get_expr(policy.polqual, policy.polrelid) like '%app_private.%'
  ),
  'RLS policies do not require direct authenticated access to the private schema'
);
select ok(
  not has_table_privilege('authenticated', 'public.submissions', 'INSERT'),
  'authenticated users cannot insert submissions directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.submissions', 'UPDATE'),
  'authenticated users cannot update privileged submission fields directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.workspaces', 'INSERT'),
  'authenticated users cannot bypass teacher entitlement with direct workspace inserts'
);
select ok(
  not has_table_privilege('authenticated', 'public.workspace_members', 'INSERT'),
  'authenticated users cannot create memberships directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.workspace_members', 'DELETE'),
  'authenticated users cannot bypass transactional offboarding'
);
select ok(
  not has_table_privilege('authenticated', 'public.batch_join_requests', 'UPDATE'),
  'authenticated users cannot bypass atomic join decisions'
);
select ok(
  not has_table_privilege('authenticated', 'public.student_invitations', 'INSERT'),
  'the incomplete email invitation mutation path is disabled'
);
select ok(
  not has_function_privilege('anon', 'public.get_auth_context()', 'EXECUTE'),
  'anonymous users cannot read authenticated application context'
);
select ok(
  has_function_privilege('authenticated', 'public.get_auth_context()', 'EXECUTE'),
  'authenticated users can read their trusted application context'
);
select ok(
  has_function_privilege('authenticated', 'public.create_teacher_workspace(text)', 'EXECUTE'),
  'authenticated users can reach the entitlement-gated onboarding RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.create_teacher_workspace_internal(text)',
    'EXECUTE'
  ),
  'authenticated users cannot call the privileged onboarding helper directly'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.request_join_batch_by_code(text)',
    'EXECUTE'
  ),
  'authenticated students can request a batch join by code'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.offboard_student(uuid,uuid)',
    'EXECUTE'
  ),
  'authenticated teachers can reach the authorization-checked offboarding RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.invite_student_by_email(text,uuid)',
    'EXECUTE'
  ),
  'the public email invitation RPC is disabled for V1'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.invite_student_by_email_internal(text,uuid)',
    'EXECUTE'
  ),
  'the internal email invitation helper cannot bypass the V1 enrollment decision'
);

-- Test identities. raw_user_meta_data deliberately claims that both accounts
-- are teachers; authorization must ignore that user-editable value.
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
    '11111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase8a-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"account_type":"teacher","full_name":"Phase 8A Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase8a-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"account_type":"teacher","full_name":"Phase 8A Student"}'::jsonb,
    now(),
    now()
  );

insert into auth.sessions (id, user_id, created_at, updated_at, not_after)
values
  (
    '11111111-1111-4111-8111-111111119999'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    now(),
    now(),
    now() + interval '1 day'
  ),
  (
    '22222222-2222-4222-8222-222222229999'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    now(),
    now(),
    now() + interval '1 day'
  );

create temporary table phase_8a_state (
  singleton boolean primary key default true check (singleton),
  workspace_id uuid,
  membership_id uuid,
  batch_id uuid,
  join_code text,
  first_request_id uuid,
  request_id uuid,
  submission_id uuid
) on commit drop;

insert into phase_8a_state default values;
grant select, update on table phase_8a_state to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '22222222-2222-4222-8222-222222222222',
    'role', 'authenticated',
    'session_id', '22222222-2222-4222-8222-222222229999'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '22222222-2222-4222-8222-222222222222',
  true
);
select set_config(
  'request.jwt.claim.session_id',
  '22222222-2222-4222-8222-222222229999',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  (
    select p.global_role
    from public.profiles p
    where p.id = '22222222-2222-4222-8222-222222222222'
  ),
  'student'::text,
  'user-editable account_type metadata cannot promote a student'
);
select is(
  (select teacher_entitled from public.get_auth_context()),
  false,
  'a metadata-only teacher claim does not create an entitlement'
);
select throws_ok(
  $$select * from public.create_teacher_workspace('Unauthorized Workspace')$$,
  '42501',
  'Teacher onboarding is not enabled for this account.',
  'an unentitled account cannot create a teacher workspace'
);
select throws_ok(
  $$select * from app_private.teacher_entitlements$$,
  '42501',
  'permission denied for schema app_private',
  'the private entitlement rows are unreadable even with a forged teacher claim'
);

reset role;

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  note
)
values (
  '11111111-1111-4111-8111-111111111111',
  true,
  1,
  'pgTAP teacher entitlement'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11111111-1111-4111-8111-111111111111',
    'role', 'authenticated',
    'session_id', '11111111-1111-4111-8111-111111119999'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  true
);
select set_config(
  'request.jwt.claim.session_id',
  '11111111-1111-4111-8111-111111119999',
  true
);
set local role authenticated;

select is(
  (select teacher_entitled from public.get_auth_context()),
  true,
  'the trusted entitlement is visible through authenticated context'
);
select lives_ok(
  $$
    with created as (
      select * from public.create_teacher_workspace('Phase 8A Workspace')
    )
    update pg_temp.phase_8a_state state
    set workspace_id = created.workspace_id,
        membership_id = created.membership_id
    from created
    where state.singleton
  $$,
  'an entitled teacher can create one workspace through the RPC'
);
select is(
  (select can_create_teacher_workspace from public.get_auth_context()),
  false,
  'the entitlement workspace limit is enforced in trusted context'
);
select lives_ok(
  $$
    with created as (
      select *
      from api.create_workspace_batch(
        (select workspace_id from pg_temp.phase_8a_state where singleton),
        'Phase 8A Batch',
        'A1',
        null,
        true,
        true,
        'teacher_review_only',
        15,
        180
      )
    )
    update pg_temp.phase_8a_state state
    set batch_id = created.batch_id
    from created
    where state.singleton
  $$,
  'a teacher can create a batch through the RPC and its private code is generated by trigger'
);

reset role;

select throws_ok(
  $$
    update public.batches
    set join_requires_approval = false
    where id = (select batch_id from pg_temp.phase_8a_state)
  $$,
  '23514',
  'new row for relation "batches" violates check constraint "batches_teacher_approval_only"',
  'the database rejects attempts to enable automatic batch-code approval'
);

set local role authenticated;

update phase_8a_state state
set join_code = (
  select code.join_code
  from public.get_batch_join_code(state.batch_id) code
)
where state.singleton;

select ok(
  (select join_code ~ '^[A-Z0-9]{10}$' from phase_8a_state),
  'the private trigger creates a valid join code'
);
select is(
  (
    select count(*)::integer
    from public.list_workspace_batch_join_codes(
      (select workspace_id from phase_8a_state)
    )
  ),
  1,
  'a workspace teacher can list that workspace join codes'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '22222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '22222222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select throws_ok(
  $$
    select *
    from public.get_batch_join_code(
      (select batch_id from pg_temp.phase_8a_state)
    )
  $$,
  '42501',
  'Batch not found or permission denied.',
  'a student cannot retrieve a private batch code by batch id'
);
select lives_ok(
  $$
    with joined as (
      select *
      from public.request_join_batch_by_code(
        (select join_code from pg_temp.phase_8a_state)
      )
    )
    update pg_temp.phase_8a_state state
    set request_id = joined.request_id,
        first_request_id = joined.request_id
    from joined
    where state.singleton
  $$,
  'a student can submit the private code without reading its storage table'
);
select is(
  (
    select bjr.status
    from public.batch_join_requests bjr
    where bjr.id = (select request_id from phase_8a_state)
  ),
  'pending'::text,
  'approval-required code joining creates a pending request'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select lives_ok(
  $$
    select *
    from public.approve_batch_join_request(
      (select request_id from pg_temp.phase_8a_state)
    )
  $$,
  'the owner can atomically approve the pending request'
);
select is(
  (
    select count(*)::integer
    from public.workspace_members wm
    where wm.workspace_id = (select workspace_id from phase_8a_state)
      and wm.user_id = '22222222-2222-4222-8222-222222222222'
      and wm.role = 'student'
  ),
  1,
  'approval creates the student workspace membership'
);
select is(
  (
    select count(*)::integer
    from public.batch_students bs
    where bs.batch_id = (select batch_id from phase_8a_state)
      and bs.student_id = '22222222-2222-4222-8222-222222222222'
  ),
  1,
  'approval creates the matching batch assignment'
);
select throws_ok(
  $$
    select *
    from public.reject_batch_join_request(
      (select request_id from pg_temp.phase_8a_state)
    )
  $$,
  '23514',
  'Approved join requests cannot be rejected.',
  'a serialized approved decision cannot race into rejected state'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '22222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '22222222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select throws_ok(
  $$
    insert into public.submissions (
      workspace_id,
      student_id,
      batch_id,
      mode,
      original_text,
      status
    )
    select
      workspace_id,
      '22222222-2222-4222-8222-222222222222',
      batch_id,
      'free_text',
      'Direct bypass attempt',
      'submitted'
    from pg_temp.phase_8a_state
  $$,
  '42501',
  'permission denied for table submissions',
  'a student cannot bypass feedback timing with a direct insert'
);
select lives_ok(
  $$
    with submitted as (
      select *
      from public.create_writing_submission(
        'free_text',
        null,
        (select batch_id from pg_temp.phase_8a_state),
        'Ich lerne jeden Tag Deutsch.',
        false
      )
    )
    update pg_temp.phase_8a_state state
    set submission_id = submitted.submission_id
    from submitted
    where state.singleton
  $$,
  'the RPC creates a writing submission using server-derived feedback fields'
);
select throws_ok(
  $$
    select *
    from public.create_writing_submission(
      'free_text',
      null,
      null,
      'Ambiguous batch context',
      false
    )
  $$,
  '22023',
  'Select a batch before submitting writing.',
  'submission creation rejects implicit first-workspace or first-batch selection'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select lives_ok(
  $$
    select *
    from public.offboard_student(
      '22222222-2222-4222-8222-222222222222',
      (select workspace_id from pg_temp.phase_8a_state)
    )
  $$,
  'the workspace owner can transactionally offboard a student'
);
select is(
  (
    select count(*)::integer
    from public.workspace_members wm
    where wm.workspace_id = (select workspace_id from phase_8a_state)
      and wm.user_id = '22222222-2222-4222-8222-222222222222'
  ),
  0,
  'offboarding removes current workspace access'
);
select is(
  (
    select count(*)::integer
    from public.batch_students bs
    where bs.workspace_id = (select workspace_id from phase_8a_state)
      and bs.student_id = '22222222-2222-4222-8222-222222222222'
  ),
  0,
  'offboarding removes every current batch assignment'
);
select is(
  (
    select bjr.status
    from public.batch_join_requests bjr
    where bjr.id = (select first_request_id from phase_8a_state)
  ),
  'cancelled'::text,
  'offboarding closes the approved join request so rejoining can start cleanly'
);
select is(
  (
    select count(*)::integer
    from public.submissions s
    where s.id = (select submission_id from phase_8a_state)
  ),
  1,
  'offboarding preserves historical writing submissions'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '22222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '22222222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select lives_ok(
  $$
    with joined as (
      select *
      from public.request_join_batch_by_code(
        (select join_code from pg_temp.phase_8a_state)
      )
    )
    update pg_temp.phase_8a_state state
    set request_id = joined.request_id
    from joined
    where state.singleton
  $$,
  'an offboarded student can make a fresh join request while the batch is active'
);
select ok(
  (
    select request_id <> first_request_id
    from phase_8a_state
  ),
  'rejoining creates a new request instead of returning a stale approval'
);
select is(
  (
    select bjr.status
    from public.batch_join_requests bjr
    where bjr.id = (select request_id from phase_8a_state)
  ),
  'pending'::text,
  'an offboarded student returns only to the teacher approval queue'
);
select is(
  (
    select count(*)::integer
    from public.workspace_members wm
    where wm.workspace_id = (select workspace_id from phase_8a_state)
      and wm.user_id = '22222222-2222-4222-8222-222222222222'
  ),
  0,
  'a retained code cannot recreate workspace access after offboarding'
);
select is(
  (
    select count(*)::integer
    from public.batch_students bs
    where bs.workspace_id = (select workspace_id from phase_8a_state)
      and bs.student_id = '22222222-2222-4222-8222-222222222222'
  ),
  0,
  'a retained code cannot recreate a batch assignment after offboarding'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '11111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select lives_ok(
  $$
    select *
    from api.set_batch_active(
      (select workspace_id from pg_temp.phase_8a_state),
      (select batch_id from pg_temp.phase_8a_state),
      false
    )
  $$,
  'the owner can archive the batch through the RPC before deciding the new request'
);
select throws_ok(
  $$
    select *
    from public.approve_batch_join_request(
      (select request_id from pg_temp.phase_8a_state)
    )
  $$,
  '23514',
  'Inactive batches cannot accept join requests.',
  'an inactive batch cannot approve a pending join request'
);

reset role;

update auth.users
set email = 'phase8a-teacher-updated@example.test'
where id = '11111111-1111-4111-8111-111111111111';

select is(
  (
    select p.email
    from public.profiles p
    where p.id = '11111111-1111-4111-8111-111111111111'
  ),
  'phase8a-teacher-updated@example.test'::text,
  'a verified Auth email change is synchronized to the application profile'
);

select * from finish();
rollback;
