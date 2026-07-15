begin;

select plan(26);

select ok(
  to_regprocedure('api.get_practice_teacher_actions(uuid)') is not null
    and to_regprocedure(
      'api.override_practice_attempt_score(uuid,numeric,text,integer)'
    ) is not null
    and to_regprocedure(
      'api.reassign_practice_assignment(uuid,text,integer)'
    ) is not null
    and to_regprocedure(
      'api.resolve_practice_support(uuid,text,text,integer)'
    ) is not null,
  'teacher worksheet controls have stable API signatures'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'api'
      and routine.proname in (
        'get_practice_teacher_actions',
        'override_practice_attempt_score',
        'reassign_practice_assignment',
        'resolve_practice_support'
      )
      and routine.prosecdef
  ),
  'every exposed teacher worksheet routine is security invoker'
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
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname in ('api', 'public')
      and routine.proname in (
        'get_practice_teacher_actions',
        'override_practice_attempt_score',
        'reassign_practice_assignment',
        'resolve_practice_support',
        'get_practice_teacher_actions_internal',
        'override_practice_attempt_score_internal',
        'reassign_practice_assignment_internal',
        'resolve_practice_support_internal'
      )
  ),
  'teacher worksheet routines pin an empty search path'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.override_practice_attempt_score(uuid,numeric,text,integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'api.override_practice_attempt_score(uuid,numeric,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.override_practice_attempt_score(uuid,numeric,text,integer)',
      'EXECUTE'
    ),
  'only authenticated application callers can enter the score override wrapper'
);

select ok(
  (
    select class.relrowsecurity
    from pg_class class
    where class.oid = 'app_private.practice_teacher_actions'::regclass
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.practice_teacher_actions',
      'SELECT'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.practice_teacher_actions',
      'SELECT'
    ),
  'the immutable teacher action ledger is private with RLS defense in depth'
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
    'ec111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11h-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11H Teacher"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ec222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase11h-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11H Student"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ec333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase11h-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11H Outsider"}'::jsonb,
    now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'ec111111-1111-4111-8111-111111111111',
    'Phase 11H Teacher',
    'phase11h-teacher@example.test',
    'student'
  ),
  (
    'ec222222-2222-4222-8222-222222222222',
    'Phase 11H Student',
    'phase11h-student@example.test',
    'student'
  ),
  (
    'ec333333-3333-4333-8333-333333333333',
    'Phase 11H Outsider',
    'phase11h-outsider@example.test',
    'student'
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'ec444444-4444-4444-8444-444444444444',
  'Phase 11H Workspace',
  'phase-11h-workspace',
  'ec111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'ec111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'ec444444-4444-4444-8444-444444444444',
  'ec111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'ec444444-4444-4444-8444-444444444444',
  'ec222222-2222-4222-8222-222222222222',
  'student'
);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by
)
values (
  'ec4b4444-4444-4444-8444-444444444444',
  'ec444444-4444-4444-8444-444444444444',
  'Phase 11H A2 Class',
  'A2',
  true,
  'ec111111-1111-4111-8111-111111111111'
);

insert into public.batch_students (batch_id, student_id, workspace_id)
values (
  'ec4b4444-4444-4444-8444-444444444444',
  'ec222222-2222-4222-8222-222222222222',
  'ec444444-4444-4444-8444-444444444444'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

create temporary table phase_11h_state (
  singleton boolean primary key default true check (singleton),
  grammar_topic_id uuid,
  assignment_id uuid,
  attempt_id uuid,
  follow_up_assignment_id uuid,
  follow_up_attempt_id uuid,
  superseded_assignment_id uuid
) on commit drop;
insert into phase_11h_state (grammar_topic_id)
select topic.id
from public.grammar_topics topic
where topic.slug = 'word-order'
limit 1;

grant select on table phase_11h_state to authenticated;

insert into public.practice_tests (
  id,
  workspace_id,
  grammar_topic_id,
  level,
  difficulty,
  title,
  description,
  created_by_ai,
  teacher_reviewed,
  visibility,
  created_by,
  generation_source,
  quality_status
)
select
  worksheet.id,
  'ec444444-4444-4444-8444-444444444444',
  state.grammar_topic_id,
  'A2',
  'easy',
  worksheet.title,
  'Teacher control fixture',
  false,
  true,
  'workspace',
  'ec111111-1111-4111-8111-111111111111',
  'manual_import',
  'approved'
from phase_11h_state state
cross join (
  values
    (
      'ec555555-5555-4555-8555-555555555555'::uuid,
      'Phase 11H approved worksheet one'
    ),
    (
      'ec565656-5656-4656-8656-565656565656'::uuid,
      'Phase 11H approved worksheet two'
    ),
    (
      'ec575757-5757-4757-8757-575757575757'::uuid,
      'Phase 11H approved worksheet three'
    ),
    (
      'ec585858-5858-4858-8858-585858585858'::uuid,
      'Phase 11H approved worksheet four'
    )
) as worksheet(id, title);

-- The final reuse boundary selects only revisions with a validated answer
-- contract, and it never assigns the same revision to a student twice after
-- answers may have been disclosed. This lifecycle exercises the original
-- assignment, a compensating follow-up, its untouched replacement, and an
-- explicit teacher reassignment, so it deliberately provides four distinct
-- approved revisions.
insert into public.practice_test_questions (
  id,
  practice_test_id,
  question_number,
  question_type,
  evaluation_mode,
  prompt,
  options,
  correct_answer,
  accepted_answers,
  rubric,
  answer_contract_version,
  explanation
)
values
  (
    'ec515151-5151-4151-8151-515151515151',
    'ec555555-5555-4555-8555-555555555555',
    1,
    'multiple_choice',
    'local_exact',
    'Which sentence has correct verb-second word order?',
    '["Heute lerne ich Deutsch.","Heute ich lerne Deutsch."]'::jsonb,
    'Heute lerne ich Deutsch.',
    '["Heute lerne ich Deutsch."]'::jsonb,
    null,
    1,
    'The finite verb is in position two.'
  ),
  (
    'ec525252-5252-4252-8252-525252525252',
    'ec565656-5656-4656-8656-565656565656',
    1,
    'multiple_choice',
    'local_exact',
    'Choose the German main clause with correct word order.',
    '["Morgen fährt sie nach Berlin.","Morgen sie fährt nach Berlin."]'::jsonb,
    'Morgen fährt sie nach Berlin.',
    '["Morgen fährt sie nach Berlin."]'::jsonb,
    null,
    1,
    'The finite verb follows the first sentence element.'
  ),
  (
    'ec535353-5353-4353-8353-535353535353',
    'ec575757-5757-4757-8757-575757575757',
    1,
    'multiple_choice',
    'local_exact',
    'Choose the German main clause with correct verb position.',
    '["Am Abend liest er ein Buch.","Am Abend er liest ein Buch."]'::jsonb,
    'Am Abend liest er ein Buch.',
    '["Am Abend liest er ein Buch."]'::jsonb,
    null,
    1,
    'The finite verb remains in position two after the time phrase.'
  ),
  (
    'ec545454-5454-4454-8454-545454545454',
    'ec585858-5858-4858-8858-585858585858',
    1,
    'multiple_choice',
    'local_exact',
    'Choose the German main clause with correct word order.',
    '["Nach der Schule spielt Tom Fußball.","Nach der Schule Tom spielt Fußball."]'::jsonb,
    'Nach der Schule spielt Tom Fußball.',
    '["Nach der Schule spielt Tom Fußball."]'::jsonb,
    null,
    1,
    'The finite verb follows the introductory phrase.'
  );

insert into public.submissions (
  id,
  workspace_id,
  student_id,
  batch_id,
  question_source,
  mode,
  original_text,
  status,
  feedback_mode,
  evaluation_status,
  release_status
)
values (
  'ec666666-6666-4666-8666-666666666666',
  'ec444444-4444-4444-8444-444444444444',
  'ec222222-2222-4222-8222-222222222222',
  'ec4b4444-4444-4444-8444-444444444444',
  'free_text',
  'free_text',
  'Phase 11H evidence fixture.',
  'checked',
  'immediate',
  'ready',
  'released'
);

with source_context as (
  select
    submission.*,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(submission.original_text, 'UTF8')
      ),
      'hex'
    ) as original_text_sha256
  from public.submissions submission
  where submission.id = 'ec666666-6666-4666-8666-666666666666'
)
insert into app_private.writing_evaluation_contexts (
  submission_id,
  context_version,
  workspace_id,
  student_id,
  batch_id,
  cefr_level,
  source_type,
  source_id,
  submission_mode,
  question_metadata,
  original_text_sha256,
  context_sha256
)
select
  context.id,
  1,
  context.workspace_id,
  context.student_id,
  context.batch_id,
  'A2',
  'free_text',
  null,
  'free_text',
  '{}'::jsonb,
  context.original_text_sha256,
  app_private.writing_evaluation_context_sha256(
    context.id,
    1::smallint,
    context.workspace_id,
    context.student_id,
    context.batch_id,
    'A2',
    'free_text',
    null,
    'free_text',
    '{}'::jsonb,
    context.original_text_sha256
  )
from source_context context;

insert into app_private.feedback_drafts (
  id,
  submission_id,
  version,
  state,
  content,
  provider_model,
  approved_at,
  approved_by,
  released_at,
  released_by
)
select
  submission.id,
  submission.id,
  1,
  'released',
  jsonb_build_object(
    'overall_summary', 'Released teacher-control fixture feedback.',
    'level_detected', 'A2',
    'corrected_text', submission.original_text,
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', char_length(submission.original_text),
      'original_line', submission.original_text,
      'corrected_line', submission.original_text,
      'status', 'correct',
      'changed_parts', '[]'::jsonb,
      'short_explanation', '',
      'detailed_explanation', '',
      'grammar_topic', ''
    )),
    'grammar_topics', '[]'::jsonb,
    'score_summary', '{}'::jsonb
  ),
  'phase_11h_fixture',
  now(),
  'ec111111-1111-4111-8111-111111111111',
  now(),
  'ec111111-1111-4111-8111-111111111111'
from public.submissions submission
where submission.id = 'ec666666-6666-4666-8666-666666666666';

insert into app_private.practice_weakness_evidence (
  source_kind,
  source_release_id,
  feedback_draft_id,
  submission_id,
  workspace_id,
  student_id,
  grammar_topic_id,
  minor_issue_count,
  major_issue_count,
  released_at
)
select
  'feedback_draft',
  'ec666666-6666-4666-8666-666666666666',
  'ec666666-6666-4666-8666-666666666666',
  'ec666666-6666-4666-8666-666666666666',
  'ec444444-4444-4444-8444-444444444444',
  'ec222222-2222-4222-8222-222222222222',
  state.grammar_topic_id,
  0,
  1,
  now()
from phase_11h_state state;

update phase_11h_state state
set assignment_id = assignment.id,
    attempt_id = 'ec777777-7777-4777-8777-777777777777'
from public.student_practice_assignments assignment
where assignment.workspace_id = 'ec444444-4444-4444-8444-444444444444'
  and assignment.student_id = 'ec222222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = state.grammar_topic_id
  and assignment.status = 'unlocked';

insert into public.practice_test_attempts (
  id,
  practice_test_id,
  student_id,
  workspace_id,
  answers,
  score,
  max_score,
  completed_at,
  assignment_id,
  status,
  started_at,
  submitted_at,
  score_percent,
  passed,
  evaluation_status,
  evaluation_completed_at,
  score_points,
  max_score_points,
  scoring_version
)
select
  state.attempt_id,
  assignment.practice_test_id,
  assignment.student_id,
  assignment.workspace_id,
  '[]'::jsonb,
  1,
  1,
  now(),
  assignment.id,
  'checked',
  now(),
  now(),
  100,
  true,
  'not_needed',
  now(),
  1,
  1,
  'phase_11h_fixture_v1'
from phase_11h_state state
join public.student_practice_assignments assignment
  on assignment.id = state.assignment_id;

update public.student_practice_assignments assignment
set
  latest_attempt_id = state.attempt_id,
  status = 'passed',
  completed_at = now()
from phase_11h_state state
where assignment.id = state.assignment_id;

-- Assignment status transitions are durable outbox work. Apply the committed
-- pass before asserting the resolution-cycle state this fixture depends on.
set local role service_role;
select set_config(
  'phase_11h.initial_pass_transition',
  api.process_practice_cycle_transition_jobs(50)::text,
  true
);
reset role;

select is(
  (
    select cycle.state
    from app_private.practice_resolution_cycles cycle
    join phase_11h_state state on state.assignment_id = cycle.resolution_assignment_id
  ),
  'improving'::text,
  'the fixture starts from a genuinely resolved adaptive pass'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'ec111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select is(
  api.get_practice_teacher_actions(
    (select assignment_id from pg_temp.phase_11h_state)
  ) ->> 'support_status',
  'not_applicable'::text,
  'teacher worksheet history starts at revision zero without a support item'
);

select is(
  (
    api.override_practice_attempt_score(
      (select assignment_id from pg_temp.phase_11h_state),
      40,
      'The semantic answer was not sufficient for a passing score.',
      0
    ) ->> 'assignment_status'
  ),
  'failed'::text,
  'a teacher can correct a terminal score through the API boundary'
);

reset role;

-- The teacher override above changed a resolved assignment from passed to
-- failed. Settle that historical transition before exercising the new cycle.
set local role service_role;
select set_config(
  'phase_11h.resolved_override_transition',
  api.process_practice_cycle_transition_jobs(50)::text,
  true
);
reset role;

select ok(
  (
    select attempt.score_percent = 40
      and attempt.score_points = 0.40
      and attempt.passed = false
      and attempt.scoring_version = 'teacher_override_v1'
    from public.practice_test_attempts attempt
    join phase_11h_state state on state.attempt_id = attempt.id
  ),
  'score, points, pass state, and scoring version transition together'
);

select is(
  (
    select count(*)::integer
    from app_private.practice_teacher_actions action
    join phase_11h_state state on state.assignment_id = action.assignment_id
    where action.action_type = 'score_override'
  ),
  1,
  'the score correction is recorded once in the immutable audit ledger'
);

select is(
  (
    select count(*)::integer
    from app_private.practice_weakness_evidence evidence
    join phase_11h_state state on state.assignment_id = (
      select action.assignment_id
      from app_private.practice_teacher_actions action
      where action.id = evidence.teacher_action_id
    )
    where evidence.source_kind = 'teacher_score_override'
  ),
  1,
  'a pass-to-fail correction creates one compensating evidence event'
);

select ok(
  (
    select count(*) = 1
    from app_private.practice_resolution_cycles cycle
    join phase_11h_state state
      on state.grammar_topic_id = cycle.grammar_topic_id
    where cycle.workspace_id = 'ec444444-4444-4444-8444-444444444444'
      and cycle.student_id = 'ec222222-2222-4222-8222-222222222222'
      and cycle.resolved_at is null
  )
    and (
      select count(*) = 1
        and bool_and(
          assignment.batch_id = 'ec4b4444-4444-4444-8444-444444444444'
          and assignment.worksheet_level = 'A2'
          and assignment.class_context_version = 1
          and assignment.generation_error is null
        )
      from public.student_practice_assignments assignment
      join phase_11h_state state
        on state.grammar_topic_id = assignment.grammar_topic_id
      where assignment.workspace_id = 'ec444444-4444-4444-8444-444444444444'
        and assignment.student_id = 'ec222222-2222-4222-8222-222222222222'
        and assignment.status in ('unlocked', 'in_progress', 'completed')
    ),
  'the compensating evidence opens exactly one active worksheet with the audited A2 class snapshot'
);

update phase_11h_state state
set
  follow_up_assignment_id = assignment.id,
  follow_up_attempt_id = 'ec888888-8888-4888-8888-888888888888'
from public.student_practice_assignments assignment
where assignment.workspace_id = 'ec444444-4444-4444-8444-444444444444'
  and assignment.student_id = 'ec222222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = state.grammar_topic_id
  and assignment.status = 'unlocked';

insert into public.practice_test_attempts (
  id,
  practice_test_id,
  student_id,
  workspace_id,
  answers,
  score,
  max_score,
  completed_at,
  assignment_id,
  status,
  started_at,
  submitted_at,
  score_percent,
  passed,
  evaluation_status,
  evaluation_completed_at,
  score_points,
  max_score_points,
  scoring_version
)
select
  state.follow_up_attempt_id,
  assignment.practice_test_id,
  assignment.student_id,
  assignment.workspace_id,
  '[]'::jsonb,
  0,
  1,
  now(),
  assignment.id,
  'checked',
  now(),
  now(),
  0,
  false,
  'not_needed',
  now(),
  0,
  1,
  'phase_11h_failure_fixture_v1'
from phase_11h_state state
join public.student_practice_assignments assignment
  on assignment.id = state.follow_up_assignment_id;

update public.student_practice_assignments assignment
set
  latest_attempt_id = state.follow_up_attempt_id,
  status = 'failed',
  completed_at = now()
from phase_11h_state state
where assignment.id = state.follow_up_assignment_id;

-- Failure reconciliation creates the untouched replacement asynchronously.
-- The prior topic head was settled above, so this tick applies this failure.
set local role service_role;
select set_config(
  'phase_11h.follow_up_failure_transition',
  api.process_practice_cycle_transition_jobs(50)::text,
  true
);
reset role;

update phase_11h_state state
set superseded_assignment_id = assignment.id
from public.student_practice_assignments assignment
where assignment.workspace_id = 'ec444444-4444-4444-8444-444444444444'
  and assignment.student_id = 'ec222222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = state.grammar_topic_id
  and assignment.id <> state.follow_up_assignment_id
  and assignment.status = 'unlocked';

insert into app_private.practice_drafts (
  assignment_id,
  workspace_id,
  student_id,
  answers
)
select
  state.superseded_assignment_id,
  'ec444444-4444-4444-8444-444444444444',
  'ec222222-2222-4222-8222-222222222222',
  '[]'::jsonb
from phase_11h_state state;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'ec111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select throws_ok(
  $$select api.override_practice_attempt_score(
    (select follow_up_assignment_id from pg_temp.phase_11h_state),
    80,
    'A saved follow-up draft must never be discarded by correction.',
    0
  )$$,
  '55000',
  'active_follow_up_has_saved_work',
  'fail-to-pass correction refuses to discard saved follow-up work'
);

reset role;

delete from app_private.practice_drafts draft
using phase_11h_state state
where draft.assignment_id = state.superseded_assignment_id;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'ec111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select is(
  (
    api.override_practice_attempt_score(
      (select follow_up_assignment_id from pg_temp.phase_11h_state),
      80,
      'Teacher review confirms that this attempt met the rubric.',
      0
    ) ->> 'assignment_status'
  ),
  'passed'::text,
  'a first teacher correction can change an adaptive fail to a pass'
);

reset role;

-- The successful correction enqueues both the authoritative pass and the
-- cancellation of its untouched replacement. Only one topic head is eligible
-- per processor invocation, so two ticks settle both transitions in order.
set local role service_role;
select set_config(
  'phase_11h.corrected_pass_transition',
  api.process_practice_cycle_transition_jobs(50)::text,
  true
);
select set_config(
  'phase_11h.superseded_cancellation_transition',
  api.process_practice_cycle_transition_jobs(50)::text,
  true
);
reset role;

select ok(
  (
    select attempt.passed = true and attempt.score_percent = 80
    from public.practice_test_attempts attempt
    join phase_11h_state state on state.follow_up_attempt_id = attempt.id
  )
    and (
      select assignment.status = 'cancelled'
      from public.student_practice_assignments assignment
      join phase_11h_state state on state.superseded_assignment_id = assignment.id
    ),
  'the corrected pass and cancellation of its untouched replacement commit together'
);

select ok(
  not exists (
    select 1
    from public.student_practice_assignments assignment
    join phase_11h_state state on state.grammar_topic_id = assignment.grammar_topic_id
    where assignment.workspace_id = 'ec444444-4444-4444-8444-444444444444'
      and assignment.student_id = 'ec222222-2222-4222-8222-222222222222'
      and assignment.resolution_cycle_id = (
        select source_assignment.resolution_cycle_id
        from public.student_practice_assignments source_assignment
        where source_assignment.id = state.follow_up_assignment_id
      )
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  'a teacher-corrected passing cycle retains no active worksheet'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'ec111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select throws_ok(
  $$select api.override_practice_attempt_score(
    (select assignment_id from pg_temp.phase_11h_state),
    45,
    'This stale request must not overwrite a newer teacher action.',
    0
  )$$,
  '40001',
  'teacher_action_revision_conflict',
  'stale score edits are rejected by optimistic revision locking'
);

select throws_ok(
  $$select api.override_practice_attempt_score(
    (select assignment_id from pg_temp.phase_11h_state),
    80,
    'A second outcome reversal would rewrite immutable educational evidence.',
    1
  )$$,
  '55000',
  'score_outcome_already_corrected',
  'a second cross-threshold reversal cannot invalidate immutable evidence'
);

select ok(
  (
    api.reassign_practice_assignment(
      (select assignment_id from pg_temp.phase_11h_state),
      'Assign the active follow-up worksheet for targeted support.',
      1
    ) ->> 'replacement_assignment_id'
  ) is not null,
  'the teacher can explicitly reassign while prior attempt history remains intact'
);

select is(
  (
    api.resolve_practice_support(
      (select assignment_id from pg_temp.phase_11h_state),
      'reassigned',
      'The replacement worksheet is ready and the teacher will follow up.',
      2
    ) ->> 'support_status'
  ),
  'resolved'::text,
  'the teacher can close an operational support recommendation'
);

select ok(
  (
    api.get_practice_teacher_actions(
      (select assignment_id from pg_temp.phase_11h_state)
    ) ->> 'current_revision'
  )::integer = 3
    and api.get_practice_teacher_actions(
      (select assignment_id from pg_temp.phase_11h_state)
    ) ->> 'support_status' = 'resolved',
  'teacher history returns the latest revision and resolved support state'
);

select throws_ok(
  $$select api.resolve_practice_support(
    (select assignment_id from pg_temp.phase_11h_state),
    'contacted',
    'Duplicate support closure.',
    3
  )$$,
  '55000',
  'support_item_already_resolved',
  'a support recommendation cannot be closed twice'
);

select set_config('request.jwt.claim.sub', 'ec222222-2222-4222-8222-222222222222', true);

select throws_ok(
  $$select api.get_practice_teacher_actions(
    (select assignment_id from pg_temp.phase_11h_state)
  )$$,
  '42501',
  'permission_denied',
  'students cannot inspect private teacher action notes'
);

select set_config('request.jwt.claim.sub', 'ec333333-3333-4333-8333-333333333333', true);

select throws_ok(
  $$select api.reassign_practice_assignment(
    (select assignment_id from pg_temp.phase_11h_state),
    'Cross-workspace reassignment must fail.',
    3
  )$$,
  '42501',
  'permission_denied',
  'an unrelated authenticated user cannot mutate another workspace'
);

reset role;

select throws_ok(
  $$update app_private.practice_teacher_actions
    set reason = 'Rewritten history is forbidden.'
    where assignment_id = (select assignment_id from pg_temp.phase_11h_state)$$,
  '55000',
  'Adaptive-practice history is immutable.',
  'teacher action history cannot be updated'
);

select is(
  (
    select count(*)::integer
    from public.practice_test_attempts attempt
    join phase_11h_state state on state.assignment_id = attempt.assignment_id
  ),
  1,
  'score correction and reassignment never replace the historical attempt'
);

select * from finish();
rollback;
