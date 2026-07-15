begin;

select plan(28);

with expected_selectable_views(relation_oid) as (
  values ('api.practice_test_attempts'::regclass)
), actual_selectable_views(relation_oid) as (
  select relation.oid
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'api'
    and relation.relkind = 'v'
    and has_table_privilege(
      'authenticated', relation.oid, 'SELECT'
    )
)
select ok(
  (
    select array_agg(actual.relation_oid order by actual.relation_oid)
    from actual_selectable_views actual
  ) = (
    select array_agg(expected.relation_oid::oid order by expected.relation_oid::oid)
    from expected_selectable_views expected
  ),
  'only the masked terminal practice-result compatibility view is readable'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'api.authorize_writing_processor_kick(uuid)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'api.authorize_writing_processor_kick(uuid)',
      'EXECUTE'
    ),
  'only the service role can authorize an authenticated processor kick'
);

select ok(
  to_regprocedure(
    'api.get_practice_evaluation_request_state(uuid,uuid)'
  ) is not null
    and has_function_privilege(
      'authenticated',
      'api.get_practice_evaluation_request_state(uuid,uuid)',
      'EXECUTE'
    ),
  'practice evaluation acknowledgement uses a narrow authenticated RPC'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy
    where policy.polname in (
      'batch_students_select_members',
      'batches_select_assigned_students_or_workspace_teacher',
      'questions_select_workspace_members',
      'submissions_select_owner_or_teacher',
      'submission_lines_select_released_or_teacher',
      'submission_grammar_topics_select_released_or_teacher',
      'student_grammar_stats_select_owner_or_teacher',
      'student_practice_assignments_select_owner_or_teacher',
      'practice_tests_select_assigned_or_teacher',
      'practice_test_attempts_select_owner_or_teacher',
      'practice_attempt_question_reviews_select_terminal_or_teacher',
      'teacher_notes_select_submission_visible',
      'usage_events_select_owner_or_teacher'
    )
      and pg_get_expr(policy.polqual, policy.polrelid) like '%workspace_members%'
  ),
  13,
  'every workspace-scoped student read policy requires active membership'
);

select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'app_private.writing_submission_daily_usage'::regclass)
    and (select relrowsecurity
         from pg_class
         where oid = 'app_private.writing_processor_kick_windows'::regclass)
    and not has_table_privilege(
      'authenticated',
      'app_private.writing_submission_daily_usage',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.writing_processor_kick_windows',
      'SELECT,INSERT,UPDATE,DELETE'
    ),
  'quota and kick counters are private and RLS protected'
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
    'f1111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase11r-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11R Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'f1222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase11r-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11R Student"}'::jsonb,
    now(),
    now()
  );

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  revision,
  disabled_at,
  note
)
values (
  'f1111111-1111-4111-8111-111111111111'::uuid,
  true,
  1,
  1,
  null,
  'Phase 11R active owner fixture.'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  'f1333333-3333-4333-8333-333333333333',
  'Phase 11R Workspace',
  'phase-11r-workspace',
  'f1111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'f1111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'f1333333-3333-4333-8333-333333333333',
  'f1111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'f1333333-3333-4333-8333-333333333333',
  'f1222222-2222-4222-8222-222222222222',
  'student'
);

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
  'f1444444-4444-4444-8444-444444444444',
  'f1333333-3333-4333-8333-333333333333',
  'Phase 11R A2',
  'A2',
  true,
  'immediate'
);

insert into public.batch_students (
  id,
  batch_id,
  student_id,
  workspace_id
)
values (
  'f1555555-5555-4555-8555-555555555555',
  'f1444444-4444-4444-8444-444444444444',
  'f1222222-2222-4222-8222-222222222222',
  'f1333333-3333-4333-8333-333333333333'
);

insert into public.questions (
  id,
  workspace_id,
  title,
  prompt,
  level,
  topic,
  task_type,
  is_active
)
values
  (
    'f1666666-6666-4666-8666-666666666661',
    'f1333333-3333-4333-8333-333333333333',
    'Active A2 question',
    'Schreibe zwei kurze Sätze.',
    'A2',
    'Alltag',
    'writing',
    true
  ),
  (
    'f1666666-6666-4666-8666-666666666662',
    'f1333333-3333-4333-8333-333333333333',
    'Inactive A2 question',
    'Diese Aufgabe ist archiviert.',
    'A2',
    'Alltag',
    'writing',
    false
  ),
  (
    'f1666666-6666-4666-8666-666666666663',
    'f1333333-3333-4333-8333-333333333333',
    'Active B1 question',
    'Diese Aufgabe gehört zu einem anderen Niveau.',
    'B1',
    'Alltag',
    'writing',
    true
  );

update app_private.writing_security_limits
set max_submissions_per_student_workspace_day = 2,
    max_authenticated_kicks_per_minute = 2,
    updated_at = now()
where singleton;

create temporary table phase_11r_state (
  singleton boolean primary key default true check (singleton),
  first_submission_id uuid,
  second_submission_id uuid,
  draft_id uuid,
  draft_revision integer
) on commit drop;

insert into phase_11r_state default values;
grant select, update on phase_11r_state to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f1222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'f1222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  (
    select count(*)::integer
    from public.questions question
    where question.workspace_id = 'f1333333-3333-4333-8333-333333333333'
  ),
  1,
  'a student sees only active questions matching an assigned active batch level'
);

with submitted as (
  select *
  from api.submit_writing(
    'f1444444-4444-4444-8444-444444444444',
    'free_text',
    null,
    'Ich lerne heute Deutsch.'
  )
)
update pg_temp.phase_11r_state state
set first_submission_id = submitted.submission_id
from submitted
where state.singleton;

select ok(
  (select first_submission_id is not null from phase_11r_state),
  'the first writing is accepted and durably identified'
);

with submitted as (
  select *
  from api.submit_writing(
    'f1444444-4444-4444-8444-444444444444',
    'free_text',
    null,
    'Morgen schreibe ich noch einen Text.'
  )
)
update pg_temp.phase_11r_state state
set second_submission_id = submitted.submission_id
from submitted
where state.singleton;

select ok(
  (select second_submission_id is not null from phase_11r_state),
  'the second writing reaches the configured daily boundary'
);

select throws_ok(
  $$
    select *
    from api.submit_writing(
      'f1444444-4444-4444-8444-444444444444',
      'free_text',
      null,
      'Dieser dritte Text muss atomar abgelehnt werden.'
    )
  $$,
  'PT429',
  'writing_daily_quota_exceeded',
  'a third normal submission returns a browser rate-limit response'
);

with saved as (
  select *
  from api.save_writing_draft(
    null,
    'f1444444-4444-4444-8444-444444444444',
    'workspace_question',
    'f1666666-6666-4666-8666-666666666661',
    'Dieser Entwurf bleibt nach der abgelehnten Abgabe erhalten.',
    0
  )
)
update pg_temp.phase_11r_state state
set draft_id = saved.saved_draft_id,
    draft_revision = saved.saved_revision
from saved
where state.singleton;

select ok(
  (
    select draft_id is not null and draft_revision = 1
    from phase_11r_state
  ),
  'autosave remains available after the evaluated-writing quota is reached'
);

select throws_ok(
  $$
    select *
    from api.submit_writing_draft(
      (select draft_id from pg_temp.phase_11r_state where singleton),
      (select draft_revision from pg_temp.phase_11r_state where singleton)
    )
  $$,
  'PT429',
  'writing_daily_quota_exceeded',
  'resumable-draft submission returns the same browser rate-limit response'
);

reset role;

select throws_ok(
  $$
    select app_private.consume_writing_submission_quota(
      'f1333333-3333-4333-8333-333333333333',
      'f1222222-2222-4222-8222-222222222222'
    )
  $$,
  '54000',
  'writing_daily_quota_exceeded',
  'the private quota implementation preserves internal program-limit semantics'
);

select is(
  (
    select count(*)::integer
    from public.submissions submission
    where submission.workspace_id = 'f1333333-3333-4333-8333-333333333333'
      and submission.student_id = 'f1222222-2222-4222-8222-222222222222'
  ),
  2,
  'quota rejection leaves no partial submission row'
);

select is(
  (
    select count(*)::integer
    from app_private.async_jobs job
    where job.job_kind = 'writing_evaluation'
      and job.requested_by = 'f1222222-2222-4222-8222-222222222222'
  ),
  2,
  'quota rejection leaves no extra durable queue job'
);

select is(
  (
    select usage.submission_count
    from app_private.writing_submission_batch_daily_usage usage
    where usage.workspace_id = 'f1333333-3333-4333-8333-333333333333'
      and usage.batch_id = 'f1444444-4444-4444-8444-444444444444'
      and usage.student_id = 'f1222222-2222-4222-8222-222222222222'
      and usage.usage_day = (now() at time zone 'Asia/Kolkata')::date
  ),
  2,
  'the atomic class-local quota counter records exactly the committed submissions'
);

select ok(
  exists (
    select 1
    from app_private.writing_drafts draft
    where draft.id = (
      select draft_id from phase_11r_state where singleton
    )
  ),
  'a quota-rejected draft submission does not delete the saved draft'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f1111111-1111-4111-8111-111111111111',
    'role', 'service_role'
  )::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  api.authorize_writing_processor_kick(
    'f1222222-2222-4222-8222-222222222222'
  ),
  'allowed'::text,
  'the first authenticated kick in a minute is allowed'
);

select is(
  api.authorize_writing_processor_kick(
    'f1222222-2222-4222-8222-222222222222'
  ),
  'allowed'::text,
  'the second authenticated kick reaches the configured boundary'
);

select is(
  api.authorize_writing_processor_kick(
    'f1222222-2222-4222-8222-222222222222'
  ),
  'rate_limited'::text,
  'additional authenticated kicks are rate limited'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f1111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'f1111111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $$
    select *
    from api.offboard_student(
      'f1222222-2222-4222-8222-222222222222',
      'f1333333-3333-4333-8333-333333333333'
    )
  $$,
  'teacher offboarding completes transactionally'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f1222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'f1222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is_empty(
  format(
    'select * from api.get_writing_draft(%L::uuid)',
    (select draft_id from pg_temp.phase_11r_state where singleton)
  ),
  'offboarding revokes a known writing-draft id while preserving its private row'
);

select is(
  (
    select count(*)::integer
    from public.submissions submission
    where submission.workspace_id = 'f1333333-3333-4333-8333-333333333333'
  ),
  0,
  'an offboarded student cannot read preserved submissions'
);

select is(
  (
    select count(*)::integer
    from public.questions question
    where question.workspace_id = 'f1333333-3333-4333-8333-333333333333'
  ),
  0,
  'an offboarded student cannot enumerate former-class questions'
);

select throws_ok(
  format(
    'select api.get_submission_detail(%L::uuid)',
    (select first_submission_id from pg_temp.phase_11r_state where singleton)
  ),
  '42501',
  'Submission not found or access denied.',
  'safe detail RPCs also deny stale membership access'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.submissions submission
    where submission.workspace_id = 'f1333333-3333-4333-8333-333333333333'
      and submission.student_id = 'f1222222-2222-4222-8222-222222222222'
  ),
  2,
  'offboarding preserves historical writing records'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f1111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'f1111111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  (
    select count(*)::integer
    from public.submissions submission
    where submission.workspace_id = 'f1333333-3333-4333-8333-333333333333'
  ),
  2,
  'the teacher retains access to offboarded student history'
);

select is(
  (
    select count(*)::integer
    from public.questions question
    where question.workspace_id = 'f1333333-3333-4333-8333-333333333333'
  ),
  3,
  'the teacher can still manage active, inactive, and cross-level questions'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'f1111111-1111-4111-8111-111111111111',
    'role', 'service_role'
  )::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  api.authorize_writing_processor_kick(
    'f1222222-2222-4222-8222-222222222222'
  ),
  'inactive_user'::text,
  'offboarded users cannot wake the paid writing processor'
);

select * from finish();
rollback;
