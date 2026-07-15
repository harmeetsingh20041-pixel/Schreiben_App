begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(18);

select results_eq(
  $$
    select minor_count, major_count,
      app_private.practice_issue_count_unlocks(minor_count, major_count)
    from (values
      (0, 0), (1, 0), (2, 0), (3, 0), (0, 1), (-1, 0), (0, -1)
    ) counts(minor_count, major_count)
    order by minor_count, major_count
  $$,
  $$
    values
      (-1, 0, false),
      (0, -1, false),
      (0, 0, false),
      (0, 1, true),
      (1, 0, true),
      (2, 0, true),
      (3, 0, true)
  $$,
  'one nonnegative released issue is enough regardless of severity'
);

select ok(
  not has_function_privilege(
    'anon',
    'app_private.practice_issue_count_unlocks(integer,integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.practice_issue_count_unlocks(integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.practice_issue_count_unlocks(integer,integer)',
      'EXECUTE'
    ),
  'the policy predicate remains private'
);

create temporary table phase_13x_cases (
  scenario text primary key,
  student_key text not null,
  batch_key text not null,
  topic_slug text not null,
  worksheet_level text not null,
  minor_count integer not null,
  major_count integer not null,
  submission_id uuid not null unique,
  feedback_draft_id uuid not null unique,
  student_id uuid not null,
  batch_id uuid not null,
  grammar_topic_id uuid not null
) on commit drop;

insert into phase_13x_cases (
  scenario,
  student_key,
  batch_key,
  topic_slug,
  worksheet_level,
  minor_count,
  major_count,
  submission_id,
  feedback_draft_id,
  student_id,
  batch_id,
  grammar_topic_id
)
select
  fixture.scenario,
  fixture.student_key,
  fixture.batch_key,
  fixture.topic_slug,
  'A2',
  fixture.minor_count,
  fixture.major_count,
  md5('phase-13x-submission-' || fixture.scenario)::uuid,
  md5('phase-13x-feedback-' || fixture.scenario)::uuid,
  md5('phase-13x-student-' || fixture.student_key)::uuid,
  md5('phase-13x-batch-' || fixture.batch_key)::uuid,
  topic.id
from (
  values
    ('minor_one', 'minor_one', 'minor_one', 'conjugation', 1, 0),
    ('minor_two', 'minor_two', 'minor_two', 'word-order', 2, 0),
    ('minor_three', 'minor_three', 'minor_three', 'articles', 3, 0),
    ('major_one', 'major_one', 'major_one', 'subject-verb-agreement', 0, 1),
    ('pass_first', 'pass', 'pass', 'prepositions', 1, 0),
    ('pass_second', 'pass', 'pass', 'prepositions', 1, 0),
    ('wrong_class', 'wrong_class', 'wrong_class', 'punctuation', 1, 0),
    ('wrong_level', 'wrong_level', 'wrong_level', 'sentence-structure', 1, 0),
    ('low_cefr_gate', 'low_cefr_gate', 'low_cefr_gate', 'plusquamperfekt', 1, 0)
) fixture(
  scenario,
  student_key,
  batch_key,
  topic_slug,
  minor_count,
  major_count
)
join public.grammar_topics topic
  on topic.slug = fixture.topic_slug
 and topic.level = 'A1_A2';

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
values (
  '00000000-0000-0000-0000-000000000000'::uuid,
  md5('phase-13x-teacher')::uuid,
  'authenticated',
  'authenticated',
  'phase-13x-teacher@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Phase 13X Teacher"}'::jsonb,
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
  md5('phase-13x-teacher')::uuid,
  true,
  1,
  1,
  null,
  'Phase 13X rollback-only teacher entitlement.'
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
select distinct
  '00000000-0000-0000-0000-000000000000'::uuid,
  fixture.student_id,
  'authenticated',
  'authenticated',
  'phase-13x-' || fixture.student_key || '@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', 'Phase 13X ' || fixture.student_key),
  now(),
  now()
from phase_13x_cases fixture;

insert into public.workspaces (id, name, slug, owner_id)
values (
  md5('phase-13x-workspace')::uuid,
  'Phase 13X Workspace',
  'phase-13x-one-issue-practice',
  md5('phase-13x-teacher')::uuid
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13x-teacher')::uuid::text,
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13x-workspace')::uuid,
  md5('phase-13x-teacher')::uuid,
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
select distinct
  md5('phase-13x-workspace')::uuid,
  fixture.student_id,
  'student'
from phase_13x_cases fixture;

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  is_active,
  join_code_enabled,
  join_requires_approval,
  feedback_mode,
  feedback_delay_min_minutes,
  feedback_delay_max_minutes
)
select distinct
  fixture.batch_id,
  md5('phase-13x-workspace')::uuid,
  'Phase 13X ' || fixture.batch_key,
  fixture.worksheet_level,
  md5('phase-13x-teacher')::uuid,
  true,
  true,
  true,
  'immediate',
  0,
  0
from phase_13x_cases fixture;

insert into public.batch_students (workspace_id, batch_id, student_id)
select distinct
  md5('phase-13x-workspace')::uuid,
  fixture.batch_id,
  fixture.student_id
from phase_13x_cases fixture
where fixture.scenario <> 'wrong_class';

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
select distinct on (fixture.grammar_topic_id)
  md5('phase-13x-practice-test-' || fixture.topic_slug)::uuid,
  md5('phase-13x-workspace')::uuid,
  fixture.grammar_topic_id,
  fixture.worksheet_level,
  'easy',
  'Phase 13X ' || fixture.topic_slug,
  'Deterministic one-issue practice fixture.',
  false,
  true,
  'workspace',
  md5('phase-13x-teacher')::uuid,
  'manual_import',
  'approved'
from phase_13x_cases fixture
order by fixture.grammar_topic_id, fixture.scenario;

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
select
  md5('phase-13x-question-' || fixture.topic_slug)::uuid,
  md5('phase-13x-practice-test-' || fixture.topic_slug)::uuid,
  1,
  'multiple_choice',
  'local_exact',
  'Wähle die richtige Form: Ich ___ heute Deutsch.',
  '["lerne","lernst","lernt"]'::jsonb,
  'lerne',
  '["lerne"]'::jsonb,
  null,
  1,
  'Ich requires the first-person singular form.'
from (
  select distinct on (grammar_topic_id) grammar_topic_id, topic_slug
  from phase_13x_cases
  order by grammar_topic_id, scenario
) fixture;

insert into public.submissions (
  id,
  workspace_id,
  student_id,
  batch_id,
  question_source,
  mode,
  original_text,
  corrected_text,
  overall_summary,
  level_detected,
  status,
  feedback_mode,
  evaluation_status,
  release_status,
  checked_at
)
select
  fixture.submission_id,
  md5('phase-13x-workspace')::uuid,
  fixture.student_id,
  fixture.batch_id,
  'free_text',
  'free_text',
  'Ich helfen.',
  'Ich helfe.',
  'Phase 13X released weakness.',
  fixture.worksheet_level,
  'checked',
  'immediate',
  'ready',
  'released',
  now()
from phase_13x_cases fixture;

with source_context as (
  select
    fixture.*,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to('Ich helfen.', 'UTF8')),
      'hex'
    ) as original_text_sha256
  from phase_13x_cases fixture
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
  context.submission_id,
  1,
  md5('phase-13x-workspace')::uuid,
  context.student_id,
  context.batch_id,
  context.worksheet_level,
  'free_text',
  null,
  'free_text',
  '{}'::jsonb,
  context.original_text_sha256,
  app_private.writing_evaluation_context_sha256(
    context.submission_id,
    1::smallint,
    md5('phase-13x-workspace')::uuid,
    context.student_id,
    context.batch_id,
    context.worksheet_level,
    'free_text',
    null,
    'free_text',
    '{}'::jsonb,
    context.original_text_sha256
  )
from source_context context;

insert into public.submission_grammar_topics (
  submission_id,
  grammar_topic_id,
  count,
  severity,
  simple_explanation
)
select
  fixture.submission_id,
  fixture.grammar_topic_id,
  fixture.minor_count + fixture.major_count,
  case when fixture.major_count > 0 then 'major' else 'minor' end,
  'Phase 13X canonical released issue.'
from phase_13x_cases fixture;

insert into app_private.feedback_drafts (
  id,
  submission_id,
  version,
  state,
  provider_model,
  content,
  approved_at,
  approved_by,
  released_at,
  released_by
)
select
  fixture.feedback_draft_id,
  fixture.submission_id,
  1,
  'released',
  'phase_13x_fixture',
  jsonb_build_object(
    'overall_summary', 'Phase 13X released weakness.',
    'level_detected', fixture.worksheet_level,
    'corrected_text', 'Ich helfe.',
    'ai_model', 'phase_13x_fixture',
    'score_summary', '{}'::jsonb,
    'grammar_topics', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 11,
      'original_line', 'Ich helfen.',
      'corrected_line', 'Ich helfe.',
      'status', case when fixture.major_count > 0
        then 'major_issue' else 'minor_issue' end,
      'changed_parts', jsonb_build_array(jsonb_build_object(
        'from', 'helfen',
        'to', 'helfe',
        'reason', 'Use the correct form for this fixture.',
        'source_start', 4,
        'source_end', 10,
        'corrected_start', 4,
        'corrected_end', 9
      )),
      'short_explanation', 'Apply the mapped canonical grammar topic.',
      'detailed_explanation', '',
      'grammar_topic', fixture.topic_slug
    ))
  ),
  now(),
  md5('phase-13x-teacher')::uuid,
  now(),
  md5('phase-13x-teacher')::uuid
from phase_13x_cases fixture
where fixture.scenario <> 'pass_second';

select results_eq(
  $$
    select cycle.state, cycle.minor_issue_count, cycle.major_issue_count,
      cycle.active_assignment_id is not null
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario = 'minor_one'
  $$,
  $$ values ('unlocked'::text, 1, 0, true) $$,
  'one released minor issue unlocks practice and creates an assignment'
);

select results_eq(
  $$
    select cycle.state, cycle.minor_issue_count, cycle.major_issue_count,
      cycle.active_assignment_id is not null
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario = 'minor_two'
  $$,
  $$ values ('unlocked'::text, 2, 0, true) $$,
  'two released minor issues remain available without waiting for a third'
);

select results_eq(
  $$
    select cycle.state, cycle.minor_issue_count, cycle.major_issue_count,
      cycle.active_assignment_id is not null
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario = 'minor_three'
  $$,
  $$ values ('unlocked'::text, 3, 0, true) $$,
  'three released minor issues remain available with their repeated count'
);

select results_eq(
  $$
    select cycle.state, cycle.minor_issue_count, cycle.major_issue_count,
      cycle.active_assignment_id is not null
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario = 'major_one'
  $$,
  $$ values ('unlocked'::text, 0, 1, true) $$,
  'one released major issue remains immediately available'
);

select results_eq(
  $$
    select cycle.state, cycle.state_reason, cycle.active_assignment_id is null
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario = 'wrong_class'
  $$,
  $$ values ('locked'::text, 'active_class_context_required'::text, true) $$,
  'one issue cannot bypass exact active class enrollment'
);

select ok(
  exists (
    select 1
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    join public.student_practice_assignments assignment
      on assignment.id = cycle.active_assignment_id
    where fixture.scenario = 'wrong_level'
      and cycle.batch_id = fixture.batch_id
      and cycle.worksheet_level = fixture.worksheet_level
      and assignment.batch_id = fixture.batch_id
      and assignment.worksheet_level = fixture.worksheet_level
  ),
  'an eligible assignment copies the exact writing-time batch and CEFR level'
);

select results_eq(
  $$
    select cycle.state, cycle.state_reason, cycle.minor_issue_count,
      cycle.active_assignment_id is null
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario = 'low_cefr_gate'
  $$,
  $$ values ('locked'::text, 'level_fit_approval_required'::text, 1, true) $$,
  'a one-minor restricted low-CEFR context remains safely gated'
);

select is(
  (
    select count(*)
    from (
      select assignment.student_id, assignment.grammar_topic_id
      from public.student_practice_assignments assignment
      where assignment.workspace_id = md5('phase-13x-workspace')::uuid
        and assignment.status in ('unlocked', 'in_progress', 'completed')
      group by assignment.student_id, assignment.grammar_topic_id
      having count(*) <> 1
    ) duplicates
  ),
  0::bigint,
  'every available topic keeps exactly one active assignment'
);

select is(
  (
    select count(*)
    from public.student_practice_assignments assignment
    join app_private.practice_resolution_cycles cycle
      on cycle.id = assignment.resolution_cycle_id
    where assignment.workspace_id = md5('phase-13x-workspace')::uuid
      and assignment.status = 'unlocked'
      and (
        assignment.workspace_id is distinct from cycle.workspace_id
        or assignment.student_id is distinct from cycle.student_id
        or assignment.grammar_topic_id is distinct from cycle.grammar_topic_id
        or assignment.batch_id is distinct from cycle.batch_id
        or assignment.worksheet_level is distinct from cycle.worksheet_level
      )
  ),
  0::bigint,
  'available assignments never cross workspace, learner, topic, class, or level context'
);

select is(
  (
    select count(*)
    from public.student_practice_assignments assignment
    join phase_13x_cases fixture
      on fixture.student_id = assignment.student_id
     and fixture.grammar_topic_id = assignment.grammar_topic_id
     and fixture.scenario <> 'pass_second'
    where fixture.scenario in (
      'minor_one', 'minor_two', 'minor_three', 'major_one',
      'pass_first', 'wrong_level'
    )
      and assignment.status = 'unlocked'
      and assignment.practice_test_id =
        md5('phase-13x-practice-test-' || fixture.topic_slug)::uuid
      and assignment.generation_status = 'ready'
  ),
  6::bigint,
  'the existing approved-material fast path is reused before paid generation'
);

insert into app_private.feedback_drafts (
  id,
  submission_id,
  version,
  state,
  provider_model,
  content
)
select
  md5('phase-13x-unreleased-draft')::uuid,
  fixture.submission_id,
  2,
  'draft',
  'phase_13x_fixture',
  released.content
from phase_13x_cases fixture
join app_private.feedback_drafts released
  on released.id = fixture.feedback_draft_id
where fixture.scenario = 'minor_one';

select is(
  (
    select count(*)
    from app_private.practice_weakness_evidence evidence
    where evidence.source_release_id = md5('phase-13x-unreleased-draft')::uuid
  ),
  0::bigint,
  'private or unreleased feedback never becomes practice evidence'
);

update public.batches batch
set level = 'B1'
where batch.id = (
  select fixture.batch_id
  from phase_13x_cases fixture
  where fixture.scenario = 'wrong_level'
);

set local role service_role;
select api.process_practice_cycle_transition_jobs(25);
reset role;

select results_eq(
  $$
    select cycle.state, cycle.state_reason, cycle.active_assignment_id is null,
      assignment.status
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    join public.student_practice_assignments assignment
      on assignment.resolution_cycle_id = cycle.id
    where fixture.scenario = 'wrong_level'
    order by assignment.assigned_at desc
    limit 1
  $$,
  $$ values (
    'locked'::text,
    'active_class_context_required'::text,
    true,
    'cancelled'::text
  ) $$,
  'a later class-level mismatch cancels untouched material and safely relocks the cycle'
);

insert into public.practice_test_attempts (
  id,
  practice_test_id,
  student_id,
  workspace_id,
  assignment_id,
  answers,
  score,
  max_score,
  score_points,
  max_score_points,
  score_percent,
  passed,
  scoring_version,
  evaluation_status,
  evaluation_version,
  status,
  started_at,
  submitted_at,
  completed_at
)
select
  md5('phase-13x-pass-attempt')::uuid,
  assignment.practice_test_id,
  assignment.student_id,
  assignment.workspace_id,
  assignment.id,
  '[]'::jsonb,
  1,
  1,
  1,
  1,
  100,
  true,
  'phase_13x_fixture',
  'not_needed',
  0,
  'checked',
  now(),
  now(),
  now()
from phase_13x_cases fixture
join public.student_practice_assignments assignment
  on assignment.student_id = fixture.student_id
 and assignment.grammar_topic_id = fixture.grammar_topic_id
 and assignment.status = 'unlocked'
where fixture.scenario = 'pass_first';

update public.student_practice_assignments assignment
set
  latest_attempt_id = md5('phase-13x-pass-attempt')::uuid,
  status = 'passed',
  completed_at = now()
from phase_13x_cases fixture
where fixture.scenario = 'pass_first'
  and assignment.student_id = fixture.student_id
  and assignment.grammar_topic_id = fixture.grammar_topic_id
  and assignment.status = 'unlocked';

set local role service_role;
select api.process_practice_cycle_transition_jobs(25);
reset role;

select ok(
  exists (
    select 1
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
    where fixture.scenario = 'pass_first'
      and cycle.cycle_number = 1
      and cycle.state = 'improving'
      and cycle.resolution_outcome = 'passed'
      and cycle.resolved_at is not null
  ),
  'a passing worksheet resolves the one-issue evidence epoch'
);

select is(
  (
    select count(*)
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
    where fixture.scenario = 'pass_first'
      and cycle.resolved_at is null
  ),
  0::bigint,
  'resolved evidence does not reopen itself from historical counts'
);

insert into app_private.feedback_drafts (
  id,
  submission_id,
  version,
  state,
  provider_model,
  content,
  approved_at,
  approved_by,
  released_at,
  released_by
)
select
  fixture.feedback_draft_id,
  fixture.submission_id,
  1,
  'released',
  'phase_13x_fixture',
  jsonb_build_object(
    'overall_summary', 'Phase 13X recurrence.',
    'level_detected', fixture.worksheet_level,
    'corrected_text', 'Ich helfe.',
    'ai_model', 'phase_13x_fixture',
    'score_summary', '{}'::jsonb,
    'grammar_topics', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 11,
      'original_line', 'Ich helfen.',
      'corrected_line', 'Ich helfe.',
      'status', 'minor_issue',
      'changed_parts', jsonb_build_array(jsonb_build_object(
        'from', 'helfen', 'to', 'helfe',
        'reason', 'Use the correct form for this fixture.',
        'source_start', 4, 'source_end', 10,
        'corrected_start', 4, 'corrected_end', 9
      )),
      'short_explanation', 'Apply the mapped canonical grammar topic.',
      'detailed_explanation', '',
      'grammar_topic', fixture.topic_slug
    ))
  ),
  now(),
  md5('phase-13x-teacher')::uuid,
  now(),
  md5('phase-13x-teacher')::uuid
from phase_13x_cases fixture
where fixture.scenario = 'pass_second';

select results_eq(
  $$
    select cycle.cycle_number, cycle.state, cycle.minor_issue_count,
      count(assignment.id)::integer
    from phase_13x_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    left join public.student_practice_assignments assignment
      on assignment.resolution_cycle_id = cycle.id
     and assignment.status in ('unlocked', 'in_progress', 'completed')
    where fixture.scenario = 'pass_first'
    group by cycle.cycle_number, cycle.state, cycle.minor_issue_count
  $$,
  $$ values (2, 'unlocked'::text, 1, 1) $$,
  'one later minor issue starts a new epoch with exactly one active worksheet'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13x-teacher')::uuid::text,
  true
);

create temporary table phase_13x_opt_in_result (payload jsonb not null)
on commit drop;

insert into phase_13x_opt_in_result (payload)
select api.opt_in_restricted_practice(
  cycle.id,
  'Qualified teacher confirms this A2 level-fit exception.'
)
from phase_13x_cases fixture
join app_private.practice_resolution_cycles cycle
  on cycle.student_id = fixture.student_id
 and cycle.grammar_topic_id = fixture.grammar_topic_id
 and cycle.resolved_at is null
where fixture.scenario = 'low_cefr_gate';

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select results_eq(
  $$
    select payload ->> 'state', payload ->> 'approval_source',
      coalesce(payload ->> 'assignment_id', '') ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    from phase_13x_opt_in_result
  $$,
  $$ values ('unlocked'::text, 'teacher_opt_in'::text, true) $$,
  'the audited low-CEFR escape hatch accepts a one-issue cycle without weakening the gate'
);

select * from finish(true);
rollback;
