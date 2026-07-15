begin;

select plan(43);

select ok(
  to_regprocedure(
    'app_private.reconcile_practice_topic_internal(uuid,uuid,uuid)'
  ) is not null
    and to_regprocedure(
      'app_private.resolve_practice_cycle_internal(uuid,uuid)'
    ) is not null,
  'adaptive resolution and reconciliation functions exist'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.reconcile_practice_topic_internal(uuid,uuid,uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'service_role',
      'app_private.resolve_practice_cycle_internal(uuid,uuid)',
      'EXECUTE'
    ),
  'adaptive state-machine internals are not directly callable'
);

select ok(
  (
    select bool_and(class.relrowsecurity)
    from pg_class class
    where class.oid in (
      'app_private.practice_weakness_evidence'::regclass,
      'app_private.practice_resolution_cycles'::regclass,
      'app_private.practice_resolution_cycle_events'::regclass
    )
  ),
  'all private adaptive-history tables have RLS enabled'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'app_private.practice_weakness_evidence',
    'SELECT'
  )
    and not has_table_privilege(
      'service_role',
      'app_private.practice_resolution_cycles',
      'SELECT'
    ),
  'browser and service roles have no direct adaptive-history table access'
);

select ok(
  exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'api'
      and column_info.table_name = 'student_grammar_stats'
      and column_info.column_name = 'resolution_cycle_number'
  )
    and exists (
      select 1
      from information_schema.columns column_info
      where column_info.table_schema = 'api'
        and column_info.table_name = 'student_practice_assignments'
        and column_info.column_name = 'evidence_cutoff_sequence'
    ),
  'API views expose cycle state without exposing the private ledger'
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
    'eb011111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase11b-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11B Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'eb022222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase11b-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11B Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'eb033333-3333-4333-8333-333333333333',
  'Phase 11B Workspace',
  'phase-11b-workspace',
  'eb011111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'eb011111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'eb033333-3333-4333-8333-333333333333',
  'eb011111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'eb033333-3333-4333-8333-333333333333',
  'eb022222-2222-4222-8222-222222222222',
  'student'
);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by
)
values (
  'eb0b3333-3333-4333-8333-333333333333',
  'eb033333-3333-4333-8333-333333333333',
  'Phase 11B A2 Class',
  'A2',
  true,
  'eb011111-1111-4111-8111-111111111111'
);

insert into public.batch_students (
  batch_id, student_id, workspace_id
)
values (
  'eb0b3333-3333-4333-8333-333333333333',
  'eb022222-2222-4222-8222-222222222222',
  'eb033333-3333-4333-8333-333333333333'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'eb044444-4444-4444-8444-444444444444',
  'phase-11b-word-order',
  'Phase 11B Word Order',
  'A2',
  'A reset-safe resolution-cycle fixture.'
);

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
values
  (
    'eb055555-5555-4555-8555-555555555555',
    'eb033333-3333-4333-8333-333333333333',
    'eb044444-4444-4444-8444-444444444444',
    'A2',
    'easy',
    'Phase 11B approved worksheet 1',
    'A deterministic state-machine fixture.',
    false,
    true,
    'workspace',
    'eb011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'eb055555-5555-4555-8555-555555555556',
    'eb033333-3333-4333-8333-333333333333',
    'eb044444-4444-4444-8444-444444444444',
    'A2',
    'easy',
    'Phase 11B approved worksheet 2',
    'A second deterministic state-machine fixture.',
    false,
    true,
    'workspace',
    'eb011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'eb055555-5555-4555-8555-555555555557',
    'eb033333-3333-4333-8333-333333333333',
    'eb044444-4444-4444-8444-444444444444',
    'A2',
    'easy',
    'Phase 11B approved worksheet 3',
    'A third deterministic state-machine fixture.',
    false,
    true,
    'workspace',
    'eb011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'eb055555-5555-4555-8555-555555555558',
    'eb033333-3333-4333-8333-333333333333',
    'eb044444-4444-4444-8444-444444444444',
    'A2',
    'easy',
    'Phase 11B approved worksheet 4',
    'A fourth deterministic state-machine fixture.',
    false,
    true,
    'workspace',
    'eb011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'eb055555-5555-4555-8555-555555555559',
    'eb033333-3333-4333-8333-333333333333',
    'eb044444-4444-4444-8444-444444444444',
    'A2',
    'easy',
    'Phase 11B approved worksheet 5',
    'A fifth deterministic state-machine fixture.',
    false,
    true,
    'workspace',
    'eb011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  );

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
    'eb066666-6666-4666-8666-666666666661',
    'eb055555-5555-4555-8555-555555555555',
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
  ),
  (
    'eb066666-6666-4666-8666-666666666662',
    'eb055555-5555-4555-8555-555555555556',
    1,
    'multiple_choice',
    'local_exact',
    'Wähle die richtige Form: Du ___ heute Deutsch.',
    '["lerne","lernst","lernt"]'::jsonb,
    'lernst',
    '["lernst"]'::jsonb,
    null,
    1,
    'Du requires the second-person singular form.'
  ),
  (
    'eb066666-6666-4666-8666-666666666663',
    'eb055555-5555-4555-8555-555555555557',
    1,
    'multiple_choice',
    'local_exact',
    'Wähle die richtige Form: Er ___ heute Deutsch.',
    '["lerne","lernst","lernt"]'::jsonb,
    'lernt',
    '["lernt"]'::jsonb,
    null,
    1,
    'Er requires the third-person singular form.'
  ),
  (
    'eb066666-6666-4666-8666-666666666664',
    'eb055555-5555-4555-8555-555555555558',
    1,
    'multiple_choice',
    'local_exact',
    'Wähle die richtige Form: Wir ___ heute Deutsch.',
    '["lernt","lernst","lernen"]'::jsonb,
    'lernen',
    '["lernen"]'::jsonb,
    null,
    1,
    'Wir requires the first-person plural form.'
  ),
  (
    'eb066666-6666-4666-8666-666666666665',
    'eb055555-5555-4555-8555-555555555559',
    1,
    'multiple_choice',
    'local_exact',
    'Wähle die richtige Form: Ihr ___ heute Deutsch.',
    '["lernt","lernst","lernen"]'::jsonb,
    'lernt',
    '["lernt"]'::jsonb,
    null,
    1,
    'Ihr requires the second-person plural form.'
  );

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
  source.id,
  'eb033333-3333-4333-8333-333333333333',
  'eb022222-2222-4222-8222-222222222222',
  'eb0b3333-3333-4333-8333-333333333333',
  'free_text',
  'free_text',
  'Phase 11B source ' || source.ordinal,
  'Phase 11B source ' || source.ordinal,
  'Released test feedback.',
  'A2',
  'checked',
  'immediate',
  'ready',
  'released',
  now()
from (
  values
    ('eb100001-0000-4000-8000-000000000001'::uuid, 1),
    ('eb100002-0000-4000-8000-000000000002'::uuid, 2),
    ('eb100003-0000-4000-8000-000000000003'::uuid, 3),
    ('eb100004-0000-4000-8000-000000000004'::uuid, 4),
    ('eb100005-0000-4000-8000-000000000005'::uuid, 5),
    ('eb100006-0000-4000-8000-000000000006'::uuid, 6),
    ('eb100007-0000-4000-8000-000000000007'::uuid, 7),
    ('eb100008-0000-4000-8000-000000000008'::uuid, 8)
) source(id, ordinal);

-- Phase 12K deliberately refuses to infer adaptive class context from legacy
-- releases. Bind each released fixture to the same immutable writing snapshot
-- used by the live submission path, then represent its release with a real
-- teacher-released feedback version. The worksheet selector can therefore
-- attach an approved immutable revision before any attempt is recorded.
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
  where submission.id in (
    'eb100001-0000-4000-8000-000000000001',
    'eb100002-0000-4000-8000-000000000002',
    'eb100003-0000-4000-8000-000000000003',
    'eb100004-0000-4000-8000-000000000004',
    'eb100005-0000-4000-8000-000000000005',
    'eb100006-0000-4000-8000-000000000006',
    'eb100007-0000-4000-8000-000000000007',
    'eb100008-0000-4000-8000-000000000008'
  )
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
    'overall_summary', 'Released adaptive-practice fixture feedback.',
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
  'phase_11b_fixture',
  now(),
  'eb011111-1111-4111-8111-111111111111',
  now(),
  'eb011111-1111-4111-8111-111111111111'
from public.submissions submission
where submission.id in (
  'eb100001-0000-4000-8000-000000000001',
  'eb100002-0000-4000-8000-000000000002',
  'eb100003-0000-4000-8000-000000000003',
  'eb100004-0000-4000-8000-000000000004',
  'eb100005-0000-4000-8000-000000000005',
  'eb100006-0000-4000-8000-000000000006',
  'eb100007-0000-4000-8000-000000000007',
  'eb100008-0000-4000-8000-000000000008'
);

create temporary table phase_11b_state (
  singleton boolean primary key default true check (singleton),
  first_assignment_id uuid,
  first_cutoff bigint,
  second_assignment_id uuid,
  third_assignment_id uuid
) on commit drop;
insert into phase_11b_state default values;

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
values (
  'feedback_draft',
  'eb100001-0000-4000-8000-000000000001',
  'eb100001-0000-4000-8000-000000000001',
  'eb100001-0000-4000-8000-000000000001',
  'eb033333-3333-4333-8333-333333333333',
  'eb022222-2222-4222-8222-222222222222',
  'eb044444-4444-4444-8444-444444444444',
  1,
  0,
  now()
);

update phase_11b_state state
set
  first_assignment_id = assignment.id,
  first_cutoff = assignment.evidence_cutoff_sequence
from public.student_practice_assignments assignment
where assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
  and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  and assignment.status = 'unlocked';

select is(
  (
    select stats.weakness_level
    from public.student_grammar_stats stats
    where stats.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and stats.student_id = 'eb022222-2222-4222-8222-222222222222'
      and stats.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  ),
  'unlocked'::text,
  'one minor released issue immediately unlocks practice'
);

select is(
  (
    select count(*)::integer
    from public.student_practice_assignments assignment
    where assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
      and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  ),
  1,
  'one minor released issue creates exactly one worksheet assignment'
);

insert into app_private.practice_weakness_evidence (
  source_kind, source_release_id, feedback_draft_id, submission_id,
  workspace_id, student_id,
  grammar_topic_id, minor_issue_count, major_issue_count, released_at
)
values (
  'feedback_draft',
  'eb100002-0000-4000-8000-000000000002',
  'eb100002-0000-4000-8000-000000000002',
  'eb100002-0000-4000-8000-000000000002',
  'eb033333-3333-4333-8333-333333333333',
  'eb022222-2222-4222-8222-222222222222',
  'eb044444-4444-4444-8444-444444444444',
  1, 0, now()
);

select is(
  (
    select (cycle.state, cycle.minor_issue_count)::text
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and cycle.student_id = 'eb022222-2222-4222-8222-222222222222'
      and cycle.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and cycle.resolved_at is null
  ),
  '(unlocked,1)'::text,
  'later evidence cannot move the first worksheet frozen cutoff'
);

insert into app_private.practice_weakness_evidence (
  source_kind, source_release_id, feedback_draft_id, submission_id,
  workspace_id, student_id,
  grammar_topic_id, minor_issue_count, major_issue_count, released_at
)
values (
  'feedback_draft',
  'eb100003-0000-4000-8000-000000000003',
  'eb100003-0000-4000-8000-000000000003',
  'eb100003-0000-4000-8000-000000000003',
  'eb033333-3333-4333-8333-333333333333',
  'eb022222-2222-4222-8222-222222222222',
  'eb044444-4444-4444-8444-444444444444',
  1, 0, now()
);

update phase_11b_state state
set
  first_assignment_id = assignment.id,
  first_cutoff = assignment.evidence_cutoff_sequence
from public.student_practice_assignments assignment
where assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
  and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  and assignment.status = 'unlocked';

select is(
  (
    select stats.weakness_level
    from public.student_grammar_stats stats
    where stats.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and stats.student_id = 'eb022222-2222-4222-8222-222222222222'
      and stats.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  ),
  'unlocked'::text,
  'additional minor evidence keeps the topic visibly available'
);

select is(
  (
    select count(*)::integer
    from public.student_practice_assignments assignment
    where assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
      and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  1,
  'an unlocked topic has exactly one active assignment'
);

select ok(
  (
    select cycle.evidence_frozen_at is not null
      and cycle.evidence_through_sequence = state.first_cutoff
    from phase_11b_state state
    join app_private.practice_resolution_cycles cycle
      on cycle.active_assignment_id = state.first_assignment_id
  ),
  'assignment creation freezes its evidence cutoff'
);

update public.student_practice_assignments assignment
set status = 'in_progress', started_at = now()
where assignment.id = (select first_assignment_id from phase_11b_state);

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

select is(
  (
    select cycle.state
    from app_private.practice_resolution_cycles cycle
    where cycle.active_assignment_id = (
      select first_assignment_id from phase_11b_state
    )
  ),
  'in_progress'::text,
  'starting the worksheet moves the cycle to in_progress'
);

select ok(
  (
    select stats.weakness_level = 'in_progress'
      and not stats.practice_unlocked
    from public.student_grammar_stats stats
    where stats.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and stats.student_id = 'eb022222-2222-4222-8222-222222222222'
      and stats.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  ),
  'student stats mirror in-progress state without claiming another unlock'
);

insert into app_private.practice_weakness_evidence (
  source_kind, source_release_id, feedback_draft_id, submission_id,
  workspace_id, student_id,
  grammar_topic_id, minor_issue_count, major_issue_count, released_at
)
values (
  'feedback_draft',
  'eb100004-0000-4000-8000-000000000004',
  'eb100004-0000-4000-8000-000000000004',
  'eb100004-0000-4000-8000-000000000004',
  'eb033333-3333-4333-8333-333333333333',
  'eb022222-2222-4222-8222-222222222222',
  'eb044444-4444-4444-8444-444444444444',
  1, 0, now()
);

select is(
  (
    select cycle.evidence_through_sequence
    from app_private.practice_resolution_cycles cycle
    where cycle.active_assignment_id = (
      select first_assignment_id from phase_11b_state
    )
  ),
  (select first_cutoff from phase_11b_state),
  'feedback released after assignment cannot move the frozen cutoff'
);

select is(
  (
    select stats.total_minor_issues
    from public.student_grammar_stats stats
    where stats.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and stats.student_id = 'eb022222-2222-4222-8222-222222222222'
      and stats.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  ),
  4,
  'student stats still disclose all unresolved evidence after the frozen cutoff'
);

select throws_ok(
  $$
    update app_private.practice_weakness_evidence
    set minor_issue_count = 99
    where source_release_id = 'eb100001-0000-4000-8000-000000000001'
  $$,
  '55000',
  'Adaptive-practice history is immutable.',
  'weakness evidence cannot be updated'
);

select throws_ok(
  $$
    delete from app_private.practice_weakness_evidence
    where source_release_id = 'eb100001-0000-4000-8000-000000000001'
  $$,
  '55000',
  'Adaptive-practice history is immutable.',
  'weakness evidence cannot be deleted'
);

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id,
  answers, score, max_score, score_points, max_score_points,
  score_percent, passed, scoring_version, evaluation_status,
  evaluation_version, status, started_at, submitted_at, completed_at
)
select
  'eb200001-0000-4000-8000-000000000001',
  assignment.practice_test_id,
  assignment.student_id,
  assignment.workspace_id,
  assignment.id,
  '[]'::jsonb,
  1, 1, 1, 1, 100, true,
  'phase_11b_fixture', 'not_needed', 0, 'checked',
  now(), now(), now()
from public.student_practice_assignments assignment
where assignment.id = (select first_assignment_id from phase_11b_state);

update public.student_practice_assignments assignment
set
  latest_attempt_id = 'eb200001-0000-4000-8000-000000000001',
  status = 'passed',
  completed_at = now()
where assignment.id = (select first_assignment_id from phase_11b_state);

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

select ok(
  (
    select cycle.state = 'improving'
      and cycle.resolution_outcome = 'passed'
      and cycle.resolved_through_sequence = state.first_cutoff
    from phase_11b_state state
    join app_private.practice_resolution_cycles cycle
      on cycle.resolution_assignment_id = state.first_assignment_id
  ),
  'the first pass resolves exactly its frozen evidence and becomes improving'
);

select is(
  (
    select (cycle.cycle_number, cycle.state, cycle.minor_issue_count)::text
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and cycle.student_id = 'eb022222-2222-4222-8222-222222222222'
      and cycle.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and cycle.resolved_at is null
  ),
  '(2,unlocked,3)'::text,
  'post-cutoff minor feedback starts a distinct available recurrence cycle'
);

select ok(
  (
    select stats.weakness_level = 'unlocked'
      and stats.practice_unlocked
      and stats.total_minor_issues = 3
      and stats.mastery_pass_count = 1
      and stats.resolved_through_sequence = state.first_cutoff
    from public.student_grammar_stats stats
    cross join phase_11b_state state
    where stats.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and stats.student_id = 'eb022222-2222-4222-8222-222222222222'
      and stats.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  ),
  'a one-issue recurrence supersedes the display state without resurrecting resolved evidence'
);

select is(
  (
    select count(*)::integer
    from public.student_practice_assignments assignment
    where assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
      and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  1,
  'a one-issue recurrence creates exactly one active worksheet'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'eb022222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'eb022222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $$
    select *
    from public.ensure_student_practice_assignment(
      'eb033333-3333-4333-8333-333333333333',
      'eb022222-2222-4222-8222-222222222222',
      'eb044444-4444-4444-8444-444444444444'
    )
  $$,
  'a student retry reuses the already-unlocked recurrence assignment'
);

reset role;

update phase_11b_state state
set second_assignment_id = assignment.id
from public.student_practice_assignments assignment
where assignment.resolution_cycle_number = 2
  and assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
  and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  and assignment.status = 'unlocked';

select is(
  (
    select count(*)::integer
    from public.student_practice_assignments assignment
    where assignment.resolution_cycle_number = 2
      and assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
      and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  1,
  'one-issue recurrence evidence creates exactly one cycle-two assignment'
);

select ok(
  (
    select assignment.resolution_cycle_id = cycle.id
      and assignment.evidence_cutoff_sequence = cycle.evidence_through_sequence
      and cycle.evidence_frozen_at is not null
    from phase_11b_state state
    join public.student_practice_assignments assignment
      on assignment.id = state.second_assignment_id
    join app_private.practice_resolution_cycles cycle
      on cycle.id = assignment.resolution_cycle_id
  ),
  'the recurring assignment carries an immutable cycle and cutoff contract'
);

select ok(
  (
    select first_assignment.practice_test_id is not null
      and second_assignment.practice_test_id is not null
      and first_assignment.practice_test_id <> second_assignment.practice_test_id
    from phase_11b_state state
    join public.student_practice_assignments first_assignment
      on first_assignment.id = state.first_assignment_id
    join public.student_practice_assignments second_assignment
      on second_assignment.id = state.second_assignment_id
  ),
  'a recurrence never reuses a scored worksheet whose answers were disclosed'
);

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id,
  answers, score, max_score, score_points, max_score_points,
  score_percent, passed, scoring_version, evaluation_status,
  evaluation_version, status, started_at, submitted_at, completed_at
)
select
  'eb200002-0000-4000-8000-000000000002',
  assignment.practice_test_id,
  assignment.student_id,
  assignment.workspace_id,
  assignment.id,
  '[]'::jsonb,
  1, 1, 1, 1, 100, true,
  'phase_11b_fixture', 'not_needed', 0, 'checked',
  now(), now(), now()
from public.student_practice_assignments assignment
where assignment.id = (select second_assignment_id from phase_11b_state);

update public.student_practice_assignments assignment
set
  latest_attempt_id = 'eb200002-0000-4000-8000-000000000002',
  status = 'passed',
  completed_at = now()
where assignment.id = (select second_assignment_id from phase_11b_state);

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

select ok(
  (
    select stats.weakness_level = 'mastered'
      and stats.mastery_pass_count = 2
      and stats.total_minor_issues = 0
      and stats.total_major_issues = 0
      and not stats.practice_unlocked
    from public.student_grammar_stats stats
    where stats.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and stats.student_id = 'eb022222-2222-4222-8222-222222222222'
      and stats.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  ),
  'a second independently resolved cycle reaches mastered'
);

select is(
  (
    select count(*)::integer
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and cycle.student_id = 'eb022222-2222-4222-8222-222222222222'
      and cycle.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and cycle.resolved_at is null
  ),
  0,
  'mastery leaves no unresolved cycle when no later evidence exists'
);

insert into app_private.practice_weakness_evidence (
  source_kind, source_release_id, feedback_draft_id, submission_id,
  workspace_id, student_id,
  grammar_topic_id, minor_issue_count, major_issue_count, released_at
)
values (
  'feedback_draft',
  'eb100006-0000-4000-8000-000000000006',
  'eb100006-0000-4000-8000-000000000006',
  'eb100006-0000-4000-8000-000000000006',
  'eb033333-3333-4333-8333-333333333333',
  'eb022222-2222-4222-8222-222222222222',
  'eb044444-4444-4444-8444-444444444444',
  1, 0, now()
);

select is(
  (
    select (cycle.cycle_number, cycle.state, cycle.mastery_pass_number)::text
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and cycle.student_id = 'eb022222-2222-4222-8222-222222222222'
      and cycle.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and cycle.resolved_at is null
  ),
  '(3,unlocked,2)'::text,
  'new feedback after mastery starts a third independent available cycle'
);

select is(
  (
    select stats.weakness_level
    from public.student_grammar_stats stats
    where stats.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and stats.student_id = 'eb022222-2222-4222-8222-222222222222'
      and stats.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  ),
  'unlocked'::text,
  'a genuine recurrence takes precedence over the historical mastered badge'
);

insert into app_private.practice_weakness_evidence (
  source_kind, source_release_id, feedback_draft_id, submission_id,
  workspace_id, student_id,
  grammar_topic_id, minor_issue_count, major_issue_count, released_at
)
values
  (
    'feedback_draft',
    'eb100007-0000-4000-8000-000000000007',
    'eb100007-0000-4000-8000-000000000007',
    'eb100007-0000-4000-8000-000000000007',
    'eb033333-3333-4333-8333-333333333333',
    'eb022222-2222-4222-8222-222222222222',
    'eb044444-4444-4444-8444-444444444444',
    1, 0, now()
  ),
  (
    'feedback_draft',
    'eb100008-0000-4000-8000-000000000008',
    'eb100008-0000-4000-8000-000000000008',
    'eb100008-0000-4000-8000-000000000008',
    'eb033333-3333-4333-8333-333333333333',
    'eb022222-2222-4222-8222-222222222222',
    'eb044444-4444-4444-8444-444444444444',
    1, 0, now()
  );

update phase_11b_state state
set third_assignment_id = assignment.id
from public.student_practice_assignments assignment
where assignment.resolution_cycle_number = 3
  and assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
  and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  and assignment.status = 'unlocked';

select is(
  (
    select count(*)::integer
    from public.student_practice_assignments assignment
    where assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
      and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  1,
  'threshold recurrence maintains exactly one active worksheet globally'
);

select is(
  (
    select count(*)::integer
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and cycle.student_id = 'eb022222-2222-4222-8222-222222222222'
      and cycle.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and cycle.resolved_at is null
  ),
  1,
  'the partial unique cycle rule leaves one open epoch per topic'
);

select ok(
  (
    select count(distinct assignment.practice_test_id) = 3
      and count(assignment.practice_test_id) = 3
    from phase_11b_state state
    join public.student_practice_assignments assignment
      on assignment.id in (
        state.first_assignment_id,
        state.second_assignment_id,
        state.third_assignment_id
      )
  ),
  'each scored recurrence receives a different unseen worksheet'
);

select throws_ok(
  $$
    update app_private.practice_resolution_cycles
    set state_reason = 'tampered_history'
    where cycle_number = 1
      and workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and student_id = 'eb022222-2222-4222-8222-222222222222'
      and grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  $$,
  '55000',
  'Resolved practice cycles are immutable.',
  'resolved cycles cannot be rewritten'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

select lives_ok(
  $$
    select *
    from public.refresh_student_grammar_stats(
      'eb033333-3333-4333-8333-333333333333',
      'eb022222-2222-4222-8222-222222222222'
    )
  $$,
  'the public refresher reconciles through the immutable evidence ledger'
);

select is(
  (
    select count(*)::integer
    from app_private.practice_resolution_cycle_events event
    join app_private.practice_resolution_cycles cycle on cycle.id = event.cycle_id
    where cycle.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and cycle.student_id = 'eb022222-2222-4222-8222-222222222222'
      and cycle.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and event.event_type in (
        'cycle_opened',
        'evidence_refreshed',
        'assignment_created',
        'assignment_started',
        'cycle_resolved'
      )
  ) >= 5,
  true,
  'the state machine leaves an auditable transition trail'
);

select ok(
  (
    select stats.state_reason is not null
      and stats.resolution_cycle_number = 3
      and stats.resolution_cycle_id = assignment.resolution_cycle_id
    from public.student_grammar_stats stats
    cross join phase_11b_state state
    join public.student_practice_assignments assignment
      on assignment.id = state.third_assignment_id
    where stats.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and stats.student_id = 'eb022222-2222-4222-8222-222222222222'
      and stats.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  ),
  'student state points to the current cycle with a user-facing reason key'
);

select ok(
  (
    select assignment.source = 'adaptive_repeat'
      and assignment.previous_assignment_id = state.second_assignment_id
      and assignment.repeat_number >= 2
    from phase_11b_state state
    join public.student_practice_assignments assignment
      on assignment.id = state.third_assignment_id
  ),
  'a recurring weakness creates a new auditable worksheet revision chain'
);

select ok(
  not exists (
    select 1
    from app_private.practice_resolution_cycles earlier
    join app_private.practice_resolution_cycles later
      on later.workspace_id = earlier.workspace_id
     and later.student_id = earlier.student_id
     and later.grammar_topic_id = earlier.grammar_topic_id
     and later.cycle_number > earlier.cycle_number
    where earlier.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and earlier.student_id = 'eb022222-2222-4222-8222-222222222222'
      and earlier.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and later.evidence_start_sequence <= earlier.evidence_through_sequence
  ),
  'resolution-cycle evidence ranges never overlap'
);

create temporary table phase_11w_failure_state (
  singleton boolean primary key default true check (singleton),
  first_retry_id uuid,
  second_retry_id uuid,
  replacement_id uuid
) on commit drop;
insert into phase_11w_failure_state default values;

-- Exercise the real attempt lifecycle. Each failed worksheet is first started,
-- receives an immutable attempt tied to the assignment's exact revision, and
-- only then enters the terminal failed state that drives bounded retry logic.
update public.student_practice_assignments assignment
set status = 'in_progress', started_at = now()
where assignment.id = (select third_assignment_id from phase_11b_state);

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id,
  answers, score, max_score, score_points, max_score_points,
  score_percent, passed, scoring_version, evaluation_status,
  evaluation_version, status, started_at, submitted_at, completed_at
)
select
  'eb200003-0000-4000-8000-000000000003',
  assignment.practice_test_id,
  assignment.student_id,
  assignment.workspace_id,
  assignment.id,
  '[]'::jsonb,
  0, 1, 0, 1, 0, false,
  'phase_11b_failure_fixture', 'not_needed', 0, 'checked',
  now(), now(), now()
from public.student_practice_assignments assignment
where assignment.id = (select third_assignment_id from phase_11b_state);

update public.student_practice_assignments assignment
set
  latest_attempt_id = 'eb200003-0000-4000-8000-000000000003',
  status = 'failed',
  completed_at = now()
where assignment.id = (select third_assignment_id from phase_11b_state);

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

update phase_11w_failure_state state
set first_retry_id = assignment.id
from public.student_practice_assignments assignment
where assignment.resolution_cycle_number = 3
  and assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
  and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  and assignment.status = 'unlocked';

update public.student_practice_assignments assignment
set status = 'in_progress', started_at = now()
where assignment.id = (
  select first_retry_id from phase_11w_failure_state
);

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id,
  answers, score, max_score, score_points, max_score_points,
  score_percent, passed, scoring_version, evaluation_status,
  evaluation_version, status, started_at, submitted_at, completed_at
)
select
  'eb200004-0000-4000-8000-000000000004',
  assignment.practice_test_id,
  assignment.student_id,
  assignment.workspace_id,
  assignment.id,
  '[]'::jsonb,
  0, 1, 0, 1, 0, false,
  'phase_11b_failure_fixture', 'not_needed', 0, 'checked',
  now(), now(), now()
from public.student_practice_assignments assignment
where assignment.id = (
  select first_retry_id from phase_11w_failure_state
);

update public.student_practice_assignments assignment
set
  latest_attempt_id = 'eb200004-0000-4000-8000-000000000004',
  status = 'failed',
  completed_at = now()
where assignment.id = (
  select first_retry_id from phase_11w_failure_state
);

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

update phase_11w_failure_state state
set second_retry_id = assignment.id
from public.student_practice_assignments assignment
where assignment.resolution_cycle_number = 3
  and assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
  and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
  and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
  and assignment.status = 'unlocked';

update public.student_practice_assignments assignment
set status = 'in_progress', started_at = now()
where assignment.id = (
  select second_retry_id from phase_11w_failure_state
);

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id,
  answers, score, max_score, score_points, max_score_points,
  score_percent, passed, scoring_version, evaluation_status,
  evaluation_version, status, started_at, submitted_at, completed_at
)
select
  'eb200005-0000-4000-8000-000000000005',
  assignment.practice_test_id,
  assignment.student_id,
  assignment.workspace_id,
  assignment.id,
  '[]'::jsonb,
  0, 1, 0, 1, 0, false,
  'phase_11b_failure_fixture', 'not_needed', 0, 'checked',
  now(), now(), now()
from public.student_practice_assignments assignment
where assignment.id = (
  select second_retry_id from phase_11w_failure_state
);

update public.student_practice_assignments assignment
set
  latest_attempt_id = 'eb200005-0000-4000-8000-000000000005',
  status = 'failed',
  completed_at = now()
where assignment.id = (
  select second_retry_id from phase_11w_failure_state
);

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

select is(
  (
    select (cycle.state, cycle.state_reason)::text
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and cycle.student_id = 'eb022222-2222-4222-8222-222222222222'
      and cycle.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and cycle.resolved_at is null
  ),
  '(locked,teacher_support_required)'::text,
  'three failed worksheets stop the automatic paid loop and request teacher support'
);

select is(
  (
    select count(*)::integer
    from public.student_practice_assignments assignment
    where assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
      and assignment.grammar_topic_id = 'eb044444-4444-4444-8444-444444444444'
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  0,
  'the support hold preserves history without creating a fourth active retry'
);

with replacement as (
  insert into public.student_practice_assignments (
    workspace_id,
    student_id,
    grammar_topic_id,
    practice_test_id,
    source,
    status,
    assigned_by,
    previous_assignment_id,
    previous_attempt_id,
    repeat_number,
    adaptive_reason,
    adaptive_status,
    generation_status
  ) values (
    'eb033333-3333-4333-8333-333333333333',
    'eb022222-2222-4222-8222-222222222222',
    'eb044444-4444-4444-8444-444444444444',
    null,
    'teacher_assigned',
    'unlocked',
    'eb011111-1111-4111-8111-111111111111',
    (select second_retry_id from phase_11w_failure_state),
    null,
    5,
    'teacher_reassignment',
    'repeat_unlocked',
    'idle'
  )
  returning id
)
update phase_11w_failure_state state
set replacement_id = replacement.id
from replacement;

select ok(
  (
    select cycle.state = 'unlocked'
      and cycle.active_assignment_id = state.replacement_id
      and replacement.resolution_cycle_id = cycle.id
      and replacement.evidence_cutoff_sequence = cycle.evidence_through_sequence
    from phase_11w_failure_state state
    join public.student_practice_assignments replacement
      on replacement.id = state.replacement_id
    join app_private.practice_resolution_cycles cycle
      on cycle.id = replacement.resolution_cycle_id
  ),
  'an explicit teacher reassignment safely unlocks and reattaches the preserved cycle'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'eb011111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'eb011111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $$
    select *
    from api.offboard_student(
      'eb022222-2222-4222-8222-222222222222',
      'eb033333-3333-4333-8333-333333333333'
    )
  $$,
  'offboarding an adaptive student completes without creating a replacement assignment'
);

reset role;

-- Offboarding commits access removal and assignment cancellation atomically.
-- The private cycle pointer is then cleared by the same durable recovery lane
-- used for every other assignment-status transition.
set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

select ok(
  not exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.workspace_id = 'eb033333-3333-4333-8333-333333333333'
      and assignment.student_id = 'eb022222-2222-4222-8222-222222222222'
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  )
    and not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = 'eb033333-3333-4333-8333-333333333333'
        and membership.user_id = 'eb022222-2222-4222-8222-222222222222'
    )
    and not exists (
      select 1
      from app_private.practice_resolution_cycles cycle
      where cycle.workspace_id = 'eb033333-3333-4333-8333-333333333333'
        and cycle.student_id = 'eb022222-2222-4222-8222-222222222222'
        and cycle.active_assignment_id is not null
    )
    and not exists (
      select 1
      from app_private.practice_assignment_cycle_transition_jobs job
      where job.workspace_id = 'eb033333-3333-4333-8333-333333333333'
        and job.student_id = 'eb022222-2222-4222-8222-222222222222'
        and job.processed_at is null
    ),
  'offboarding and durable recovery leave no active assignment, stale cycle pointer, or pending transition'
);

select * from finish();
rollback;
