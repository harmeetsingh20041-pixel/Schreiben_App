begin;

select plan(36);

-- This matrix fills the only remaining SEC-010 gap: the same teacher and
-- student are active in two workspaces at once. Every mutation below must use
-- its explicit batch, question, assignment, draft, request, or workspace
-- context rather than whichever membership happens to sort first.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'b7010001-0001-4001-8001-000000000001',
    'authenticated', 'authenticated',
    'phase12y-multi-teacher@fixture.invalid', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12Y Multi Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b7010002-0002-4002-8002-000000000002',
    'authenticated', 'authenticated',
    'phase12y-a-only-teacher@fixture.invalid', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12Y A-only Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b7010003-0003-4003-8003-000000000003',
    'authenticated', 'authenticated',
    'phase12y-stale-teacher@fixture.invalid', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12Y Stale Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b7010004-0004-4004-8004-000000000004',
    'authenticated', 'authenticated',
    'phase12y-multi-student@fixture.invalid', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12Y Multi Student"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b7010005-0005-4005-8005-000000000005',
    'authenticated', 'authenticated',
    'phase12y-joiner-one@fixture.invalid', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12Y Joiner One"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b7010006-0006-4006-8006-000000000006',
    'authenticated', 'authenticated',
    'phase12y-joiner-two@fixture.invalid', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12Y Joiner Two"}'::jsonb, now(), now()
  );

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  note
)
values
  (
    'b7010001-0001-4001-8001-000000000001',
    true,
    2,
    'Phase 12Y multi-workspace mutation fixture.'
  ),
  (
    'b7010002-0002-4002-8002-000000000002',
    true,
    1,
    'Phase 12Y workspace-A teacher fixture.'
  ),
  (
    'b7010003-0003-4003-8003-000000000003',
    true,
    1,
    'Phase 12Y stale-teacher fixture.'
  );

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    'b7020001-0001-4001-8001-000000000001',
    'Phase 12Y Workspace A',
    'phase-12y-multi-workspace-a-20260712',
    'b7010001-0001-4001-8001-000000000001'
  ),
  (
    'b7020002-0002-4002-8002-000000000002',
    'Phase 12Y Workspace B',
    'phase-12y-multi-workspace-b-20260712',
    'b7010001-0001-4001-8001-000000000001'
  );

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b7010001-0001-4001-8001-000000000001',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b7010001-0001-4001-8001-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'b7020001-0001-4001-8001-000000000001',
    'b7010001-0001-4001-8001-000000000001',
    'owner'
  ),
  (
    'b7020002-0002-4002-8002-000000000002',
    'b7010001-0001-4001-8001-000000000001',
    'owner'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '{}'::jsonb::text, true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'b7020001-0001-4001-8001-000000000001',
    'b7010002-0002-4002-8002-000000000002',
    'teacher'
  ),
  (
    'b7020002-0002-4002-8002-000000000002',
    'b7010003-0003-4003-8003-000000000003',
    'teacher'
  ),
  (
    'b7020001-0001-4001-8001-000000000001',
    'b7010004-0004-4004-8004-000000000004',
    'student'
  ),
  (
    'b7020002-0002-4002-8002-000000000002',
    'b7010004-0004-4004-8004-000000000004',
    'student'
  );

insert into public.batches (
  id, workspace_id, name, level, description, is_active, created_by,
  join_code_enabled, join_requires_approval, feedback_mode,
  feedback_delay_min_minutes, feedback_delay_max_minutes
)
values
  (
    'b7030001-0001-4001-8001-000000000001',
    'b7020001-0001-4001-8001-000000000001',
    'Phase 12Y Class A', 'A2', 'Explicit workspace A context.', true,
    'b7010001-0001-4001-8001-000000000001', true, true,
    'immediate', 0, 0
  ),
  (
    'b7030002-0002-4002-8002-000000000002',
    'b7020002-0002-4002-8002-000000000002',
    'Phase 12Y Class B', 'A2', 'Explicit workspace B context.', true,
    'b7010001-0001-4001-8001-000000000001', true, true,
    'immediate', 0, 0
  );

insert into public.batch_students (id, workspace_id, batch_id, student_id)
values
  (
    'b7040001-0001-4001-8001-000000000001',
    'b7020001-0001-4001-8001-000000000001',
    'b7030001-0001-4001-8001-000000000001',
    'b7010004-0004-4004-8004-000000000004'
  ),
  (
    'b7040002-0002-4002-8002-000000000002',
    'b7020002-0002-4002-8002-000000000002',
    'b7030002-0002-4002-8002-000000000002',
    'b7010004-0004-4004-8004-000000000004'
  );

insert into public.questions (
  id, workspace_id, title, prompt, level, topic, task_type, is_active
)
values
  (
    'b7050001-0001-4001-8001-000000000001',
    'b7020001-0001-4001-8001-000000000001',
    'Phase 12Y Writing A',
    'Schreibe zwei Sätze über deinen Arbeitstag in Klasse A.',
    'A2', 'Alltag', 'writing', true
  ),
  (
    'b7050002-0002-4002-8002-000000000002',
    'b7020002-0002-4002-8002-000000000002',
    'Phase 12Y Writing B',
    'Schreibe zwei Sätze über deinen Arbeitstag in Klasse B.',
    'A2', 'Alltag', 'writing', true
  );

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    'b7060001-0001-4001-8001-000000000001',
    'phase-12y-articles-a-20260712',
    'Phase 12Y Articles A', 'A2',
    'Workspace A practice context fixture.'
  ),
  (
    'b7060002-0002-4002-8002-000000000002',
    'phase-12y-prepositions-b-20260712',
    'Phase 12Y Prepositions B', 'A2',
    'Workspace B practice context fixture.'
  ),
  (
    'b7060003-0003-4003-8003-000000000003',
    'phase-12y-word-order-b-20260712',
    'Phase 12Y Word Order B', 'A2',
    'Workspace B stale-practice context fixture.'
  );

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title,
  description, teacher_reviewed, visibility, created_by,
  generation_source, quality_status
)
values
  (
    'b7070001-0001-4001-8001-000000000001',
    'b7020001-0001-4001-8001-000000000001',
    'b7060001-0001-4001-8001-000000000001',
    'A2', 'easy', 'Phase 12Y Worksheet A',
    'Objective workspace A worksheet.', true, 'workspace',
    'b7010001-0001-4001-8001-000000000001',
    'manual_import', 'approved'
  ),
  (
    'b7070002-0002-4002-8002-000000000002',
    'b7020002-0002-4002-8002-000000000002',
    'b7060002-0002-4002-8002-000000000002',
    'A2', 'easy', 'Phase 12Y Worksheet B',
    'Objective workspace B worksheet.', true, 'workspace',
    'b7010001-0001-4001-8001-000000000001',
    'manual_import', 'approved'
  ),
  (
    'b7070003-0003-4003-8003-000000000003',
    'b7020002-0002-4002-8002-000000000002',
    'b7060003-0003-4003-8003-000000000003',
    'A2', 'easy', 'Phase 12Y Stale Worksheet B',
    'Objective workspace B stale-session worksheet.', true, 'workspace',
    'b7010001-0001-4001-8001-000000000001',
    'manual_import', 'approved'
  );

insert into public.practice_test_questions (
  id, practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
values
  (
    'b7080001-0001-4001-8001-000000000001',
    'b7070001-0001-4001-8001-000000000001',
    1, 'multiple_choice', 'local_exact',
    'Welcher Artikel ist in Klasse A richtig?',
    '["der","den","dem"]'::jsonb, 'der', '["der"]'::jsonb,
    null, 1, 'The nominative masculine article is der.'
  ),
  (
    'b7080002-0002-4002-8002-000000000002',
    'b7070002-0002-4002-8002-000000000002',
    1, 'multiple_choice', 'local_exact',
    'Welche Präposition ist in Klasse B richtig?',
    '["auf","an","für"]'::jsonb, 'auf', '["auf"]'::jsonb,
    null, 1, 'Warten is used with auf.'
  ),
  (
    'b7080003-0003-4003-8003-000000000003',
    'b7070003-0003-4003-8003-000000000003',
    1, 'multiple_choice', 'local_exact',
    'Welcher Satz hat die richtige Wortstellung?',
    '["Heute lerne ich Deutsch.","Heute ich lerne Deutsch.","Heute Deutsch ich lerne."]'::jsonb,
    'Heute lerne ich Deutsch.',
    '["Heute lerne ich Deutsch."]'::jsonb,
    null, 1, 'The finite verb is in position two.'
  );

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, generation_status, class_context_version
)
values
  (
    'b7090001-0001-4001-8001-000000000001',
    'b7020001-0001-4001-8001-000000000001',
    'b7010004-0004-4004-8004-000000000004',
    'b7060001-0001-4001-8001-000000000001',
    'b7070001-0001-4001-8001-000000000001',
    'manual', 'unlocked', 'b7010001-0001-4001-8001-000000000001',
    'ready', 0
  ),
  (
    'b7090002-0002-4002-8002-000000000002',
    'b7020002-0002-4002-8002-000000000002',
    'b7010004-0004-4004-8004-000000000004',
    'b7060002-0002-4002-8002-000000000002',
    'b7070002-0002-4002-8002-000000000002',
    'manual', 'unlocked', 'b7010001-0001-4001-8001-000000000001',
    'ready', 0
  ),
  (
    'b7090003-0003-4003-8003-000000000003',
    'b7020002-0002-4002-8002-000000000002',
    'b7010004-0004-4004-8004-000000000004',
    'b7060003-0003-4003-8003-000000000003',
    'b7070003-0003-4003-8003-000000000003',
    'manual', 'unlocked', 'b7010001-0001-4001-8001-000000000001',
    'ready', 0
  );

create temporary table phase_12y_state (
  singleton boolean primary key default true check (singleton),
  submission_b_id uuid,
  writing_draft_b_id uuid,
  writing_draft_b_revision integer,
  draft_submission_b_id uuid,
  stale_writing_draft_b_id uuid,
  stale_writing_draft_b_revision integer,
  practice_b_revision integer,
  practice_b_attempt_id uuid,
  stale_practice_b_revision integer,
  join_code_b text,
  request_one_id uuid,
  request_two_id uuid,
  submission_a_id uuid
) on commit drop;

insert into phase_12y_state (join_code_b)
select code.join_code
from app_private.batch_join_codes code
where code.batch_id = 'b7030002-0002-4002-8002-000000000002';

grant select, update on phase_12y_state to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b7010004-0004-4004-8004-000000000004',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b7010004-0004-4004-8004-000000000004',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'b7030002-0002-4002-8002-000000000002',
    'workspace_question',
    'b7050002-0002-4002-8002-000000000002',
    'Ich arbeite heute in der Klinik.'
  )
)
update pg_temp.phase_12y_state state
set submission_b_id = submitted.submission_id
from submitted
where state.singleton;

select ok(
  (select submission_b_id is not null from phase_12y_state),
  'a multi-workspace student can submit explicitly to workspace B'
);

reset role;

select ok(
  exists (
    select 1
    from public.submissions submission
    join app_private.writing_evaluation_contexts context
      on context.submission_id = submission.id
    where submission.id = (select submission_b_id from phase_12y_state)
      and submission.workspace_id = 'b7020002-0002-4002-8002-000000000002'
      and submission.batch_id = 'b7030002-0002-4002-8002-000000000002'
      and submission.question_id = 'b7050002-0002-4002-8002-000000000002'
      and context.workspace_id = submission.workspace_id
      and context.batch_id = submission.batch_id
  ),
  'writing persistence and immutable evaluation context use the selected B class'
);

set local role authenticated;

select throws_ok(
  $$
    select *
    from api.submit_writing(
      'b7030002-0002-4002-8002-000000000002',
      'workspace_question',
      'b7050001-0001-4001-8001-000000000001',
      'Cross-workspace writing must fail.'
    )
  $$,
  '55000',
  'writing_question_context_invalid',
  'a B batch cannot be combined with an A writing question'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.submissions
    where original_text = 'Cross-workspace writing must fail.'
  ),
  0,
  'the rejected cross-workspace writing leaves no submission or job parent'
);

set local role authenticated;

with saved as (
  select *
  from api.save_writing_draft(
    null,
    'b7030002-0002-4002-8002-000000000002',
    'workspace_question',
    'b7050002-0002-4002-8002-000000000002',
    'Dieser Entwurf gehört ausdrücklich zu Klasse B.',
    0
  )
)
update pg_temp.phase_12y_state state
set writing_draft_b_id = saved.saved_draft_id,
    writing_draft_b_revision = saved.saved_revision
from saved
where state.singleton;

select ok(
  (
    select writing_draft_b_id is not null and writing_draft_b_revision = 1
    from phase_12y_state
  ),
  'writing autosave creates revision one in the explicitly selected class'
);

select ok(
  exists (
    select 1
    from api.get_writing_draft(
      (select writing_draft_b_id from phase_12y_state)
    ) draft
    where draft.workspace_id = 'b7020002-0002-4002-8002-000000000002'
      and draft.batch_id = 'b7030002-0002-4002-8002-000000000002'
      and draft.source_id = 'b7050002-0002-4002-8002-000000000002'
  ),
  'writing draft readback preserves explicit B workspace, batch, and task context'
);

select throws_ok(
  $$
    select *
    from api.save_writing_draft(
      null,
      'b7030002-0002-4002-8002-000000000002',
      'workspace_question',
      'b7050001-0001-4001-8001-000000000001',
      'This mismatched draft must not exist.',
      0
    )
  $$,
  '22023',
  'writing_question_unavailable',
  'writing autosave rejects a B-batch and A-question mismatch'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.writing_drafts
    where student_id = 'b7010004-0004-4004-8004-000000000004'
  ),
  1,
  'the rejected draft context creates no second private draft'
);

set local role authenticated;

with submitted as (
  select *
  from api.submit_writing_draft(
    (select writing_draft_b_id from pg_temp.phase_12y_state),
    1
  )
)
update pg_temp.phase_12y_state state
set draft_submission_b_id = submitted.submission_id
from submitted
where state.singleton;

select ok(
  (select draft_submission_b_id is not null from phase_12y_state),
  'the B writing draft submits through its immutable saved context'
);

reset role;

select ok(
  not exists (
    select 1
    from app_private.writing_drafts draft
    where draft.id = (select writing_draft_b_id from phase_12y_state)
  )
    and exists (
      select 1
      from public.submissions submission
      where submission.id = (select draft_submission_b_id from phase_12y_state)
        and submission.workspace_id = 'b7020002-0002-4002-8002-000000000002'
        and submission.batch_id = 'b7030002-0002-4002-8002-000000000002'
    ),
  'draft deletion and its B-context submission commit atomically'
);

set local role authenticated;

with saved as (
  select *
  from api.save_writing_draft(
    null,
    'b7030002-0002-4002-8002-000000000002',
    'free_text',
    null,
    'Dieser B-Entwurf muss nach dem Offboarding privat erhalten bleiben.',
    0
  )
)
update pg_temp.phase_12y_state state
set stale_writing_draft_b_id = saved.saved_draft_id,
    stale_writing_draft_b_revision = saved.saved_revision
from saved
where state.singleton;

select ok(
  (
    select stale_writing_draft_b_id is not null
      and stale_writing_draft_b_revision = 1
    from phase_12y_state
  ),
  'a second B writing draft records the later stale-session fixture'
);

with saved as (
  select *
  from api.save_practice_draft(
    'b7090002-0002-4002-8002-000000000002',
    '[{"question_id":"b7080002-0002-4002-8002-000000000002","answer":"auf"}]'::jsonb,
    0
  )
)
update pg_temp.phase_12y_state state
set practice_b_revision = saved.saved_revision
from saved
where state.singleton;

select ok(
  (select practice_b_revision = 1 from phase_12y_state),
  'practice autosave selects the explicit B assignment, not the A assignment'
);

select throws_ok(
  $$
    select *
    from api.save_practice_draft(
      'b7090002-0002-4002-8002-000000000002',
      '[{"question_id":"b7080001-0001-4001-8001-000000000001","answer":"der"}]'::jsonb,
      1
    )
  $$,
  '22023',
  'practice_answers_invalid',
  'a B practice assignment rejects an A worksheet question id'
);

select is(
  (
    select revision
    from api.get_practice_draft('b7090002-0002-4002-8002-000000000002')
  ),
  1,
  'the rejected cross-workspace answer leaves the B draft revision unchanged'
);

update pg_temp.phase_12y_state state
set practice_b_attempt_id = (
  api.submit_practice_attempt(
    'b7090002-0002-4002-8002-000000000002',
    1
  ) ->> 'latest_attempt_id'
)::uuid
where state.singleton;

select ok(
  (select practice_b_attempt_id is not null from phase_12y_state),
  'the revision-locked B practice draft submits successfully'
);

select ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    where attempt.id = (select practice_b_attempt_id from phase_12y_state)
      and attempt.workspace_id = 'b7020002-0002-4002-8002-000000000002'
      and attempt.assignment_id = 'b7090002-0002-4002-8002-000000000002'
      and attempt.practice_test_id = 'b7070002-0002-4002-8002-000000000002'
  ),
  'the submitted practice attempt retains the exact B assignment and worksheet'
);

with saved as (
  select *
  from api.save_practice_draft(
    'b7090003-0003-4003-8003-000000000003',
    '[{"question_id":"b7080003-0003-4003-8003-000000000003","answer":"Heute lerne ich Deutsch."}]'::jsonb,
    0
  )
)
update pg_temp.phase_12y_state state
set stale_practice_b_revision = saved.saved_revision
from saved
where state.singleton;

select ok(
  (select stale_practice_b_revision = 1 from phase_12y_state),
  'a second B practice draft records the stale-membership fixture'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b7010005-0005-4005-8005-000000000005',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b7010005-0005-4005-8005-000000000005',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with requested as (
  select *
  from api.request_batch_join(
    (select join_code_b from pg_temp.phase_12y_state)
  )
)
update pg_temp.phase_12y_state state
set request_one_id = requested.request_id
from requested
where state.singleton;

select ok(
  exists (
    select 1
    from public.batch_join_requests request
    where request.id = (select request_one_id from phase_12y_state)
      and request.workspace_id = 'b7020002-0002-4002-8002-000000000002'
      and request.batch_id = 'b7030002-0002-4002-8002-000000000002'
      and request.status = 'pending'
  ),
  'the private B code creates a request with explicit B workspace context'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b7010002-0002-4002-8002-000000000002',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b7010002-0002-4002-8002-000000000002',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select *
    from api.decide_batch_join(
      (select request_one_id from pg_temp.phase_12y_state),
      'approved'
    )
  $$,
  '42501',
  'Permission denied.',
  'a teacher who belongs only to A cannot decide a B join request'
);

reset role;

select is(
  (
    select status
    from public.batch_join_requests
    where id = (select request_one_id from phase_12y_state)
  ),
  'pending'::text,
  'the rejected A-teacher decision leaves the B request pending'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b7010001-0001-4001-8001-000000000001',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b7010001-0001-4001-8001-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select ok(
  exists (
    select 1
    from api.decide_batch_join(
      (select request_one_id from pg_temp.phase_12y_state),
      'approved'
    ) decision
    where decision.workspace_id = 'b7020002-0002-4002-8002-000000000002'
      and decision.batch_id = 'b7030002-0002-4002-8002-000000000002'
      and decision.status = 'approved'
  ),
  'the multi-workspace teacher approves the request in its bound B workspace'
);

reset role;

select ok(
  exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = 'b7020002-0002-4002-8002-000000000002'
      and membership.user_id = 'b7010005-0005-4005-8005-000000000005'
      and membership.role = 'student'
  )
    and exists (
      select 1
      from public.batch_students assignment
      where assignment.workspace_id = 'b7020002-0002-4002-8002-000000000002'
        and assignment.batch_id = 'b7030002-0002-4002-8002-000000000002'
        and assignment.student_id = 'b7010005-0005-4005-8005-000000000005'
    ),
  'approval creates only the B membership and B class assignment'
);

select is(
  (
    select count(*)::integer
    from public.workspace_members membership
    where membership.workspace_id = 'b7020001-0001-4001-8001-000000000001'
      and membership.user_id = 'b7010005-0005-4005-8005-000000000005'
  ) + (
    select count(*)::integer
    from public.batch_students assignment
    where assignment.workspace_id = 'b7020001-0001-4001-8001-000000000001'
      and assignment.student_id = 'b7010005-0005-4005-8005-000000000005'
  ),
  0,
  'B approval never creates inferred access in workspace A'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b7010006-0006-4006-8006-000000000006',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b7010006-0006-4006-8006-000000000006',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with requested as (
  select *
  from api.request_batch_join(
    (select join_code_b from pg_temp.phase_12y_state)
  )
)
update pg_temp.phase_12y_state state
set request_two_id = requested.request_id
from requested
where state.singleton;

select ok(
  (select request_two_id is not null from phase_12y_state),
  'a second B request records the stale-teacher decision fixture'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b7010002-0002-4002-8002-000000000002',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b7010002-0002-4002-8002-000000000002',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select *
    from api.offboard_student(
      'b7010004-0004-4004-8004-000000000004',
      'b7020002-0002-4002-8002-000000000002'
    )
  $$,
  '42501',
  'Permission denied.',
  'an A-only teacher cannot offboard a student from workspace B'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b7010001-0001-4001-8001-000000000001',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b7010001-0001-4001-8001-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select ok(
  (
    select result.membership_removed
      and result.removed_batch_assignments = 1
    from api.offboard_student(
      'b7010004-0004-4004-8004-000000000004',
      'b7020002-0002-4002-8002-000000000002'
    ) result
  ),
  'the multi-workspace teacher offboards only the explicitly selected B context'
);

reset role;

select ok(
  not exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = 'b7020002-0002-4002-8002-000000000002'
      and membership.user_id = 'b7010004-0004-4004-8004-000000000004'
  )
    and not exists (
      select 1
      from public.batch_students assignment
      where assignment.workspace_id = 'b7020002-0002-4002-8002-000000000002'
        and assignment.student_id = 'b7010004-0004-4004-8004-000000000004'
    )
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = 'b7020001-0001-4001-8001-000000000001'
        and membership.user_id = 'b7010004-0004-4004-8004-000000000004'
        and membership.role = 'student'
    )
    and exists (
      select 1
      from public.batch_students assignment
      where assignment.workspace_id = 'b7020001-0001-4001-8001-000000000001'
        and assignment.student_id = 'b7010004-0004-4004-8004-000000000004'
    ),
  'B offboarding removes B access while preserving every A membership and class row'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b7010004-0004-4004-8004-000000000004',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b7010004-0004-4004-8004-000000000004',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select *
    from api.submit_writing(
      'b7030002-0002-4002-8002-000000000002',
      'free_text',
      null,
      'Stale B writing must fail.'
    )
  $$,
  '42501',
  'writing_batch_membership_missing',
  'an offboarded B session cannot submit new B writing'
);

select throws_ok(
  $$
    select *
    from api.submit_writing_draft(
      (select stale_writing_draft_b_id from pg_temp.phase_12y_state),
      (select stale_writing_draft_b_revision from pg_temp.phase_12y_state)
    )
  $$,
  '42501',
  'active_class_membership_required',
  'an offboarded B session cannot submit a preserved B writing draft'
);

select throws_ok(
  $$
    select *
    from api.save_practice_draft(
      'b7090003-0003-4003-8003-000000000003',
      '[{"question_id":"b7080003-0003-4003-8003-000000000003","answer":"Heute lerne ich Deutsch."}]'::jsonb,
      1
    )
  $$,
  '55000',
  'practice_assignment_inactive',
  'an offboarded B session cannot update its cancelled practice draft'
);

select throws_ok(
  $$
    select api.submit_practice_attempt(
      'b7090003-0003-4003-8003-000000000003',
      1
    )
  $$,
  '55000',
  'practice_assignment_inactive',
  'an offboarded B session cannot submit its cancelled practice draft'
);

with submitted as (
  select *
  from api.submit_writing(
    'b7030001-0001-4001-8001-000000000001',
    'free_text',
    null,
    'Mein Zugang zu Klasse A bleibt aktiv.'
  )
)
update pg_temp.phase_12y_state state
set submission_a_id = submitted.submission_id
from submitted
where state.singleton;

select ok(
  (select submission_a_id is not null from phase_12y_state),
  'the same student can still write in explicitly selected workspace A'
);

reset role;

select ok(
  exists (
    select 1
    from public.submissions submission
    join app_private.writing_evaluation_contexts context
      on context.submission_id = submission.id
    where submission.id = (select submission_a_id from phase_12y_state)
      and submission.workspace_id = 'b7020001-0001-4001-8001-000000000001'
      and submission.batch_id = 'b7030001-0001-4001-8001-000000000001'
      and context.workspace_id = submission.workspace_id
      and context.batch_id = submission.batch_id
  ),
  'post-offboarding writing remains bound to A without resurrecting B access'
);

delete from public.workspace_members membership
where membership.workspace_id = 'b7020002-0002-4002-8002-000000000002'
  and membership.user_id = 'b7010001-0001-4001-8001-000000000001'
  and membership.role = 'owner';

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b7010001-0001-4001-8001-000000000001',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'b7010001-0001-4001-8001-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select *
    from api.decide_batch_join(
      (select request_two_id from pg_temp.phase_12y_state),
      'approved'
    )
  $$,
  '42501',
  'Permission denied.',
  'a stale B teacher session cannot fall back to its still-active A ownership'
);

reset role;

select ok(
  exists (
    select 1
    from public.batch_join_requests request
    where request.id = (select request_two_id from phase_12y_state)
      and request.workspace_id = 'b7020002-0002-4002-8002-000000000002'
      and request.status = 'pending'
  )
    and not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = 'b7020002-0002-4002-8002-000000000002'
        and membership.user_id = 'b7010006-0006-4006-8006-000000000006'
    )
    and not exists (
      select 1
      from public.batch_students assignment
      where assignment.batch_id = 'b7030002-0002-4002-8002-000000000002'
        and assignment.student_id = 'b7010006-0006-4006-8006-000000000006'
    ),
  'the stale teacher decision leaves the B request and access state unchanged'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id in (
      (select submission_b_id from phase_12y_state),
      (select draft_submission_b_id from phase_12y_state)
    )
      and submission.workspace_id = 'b7020002-0002-4002-8002-000000000002'
  )
    and exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.id = (select practice_b_attempt_id from phase_12y_state)
        and attempt.workspace_id = 'b7020002-0002-4002-8002-000000000002'
    )
    and exists (
      select 1
      from app_private.writing_drafts draft
      where draft.id = (select stale_writing_draft_b_id from phase_12y_state)
        and draft.workspace_id = 'b7020002-0002-4002-8002-000000000002'
    ),
  'offboarding preserves B writing, draft, and practice history without restoring access'
);

select * from finish();
rollback;
