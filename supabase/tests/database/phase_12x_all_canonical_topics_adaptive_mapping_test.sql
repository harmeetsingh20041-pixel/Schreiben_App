begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

-- PRACTICE-009: exercise the complete closed grammar-topic set through the
-- released-feedback evidence trigger and into one adaptive assignment per
-- topic. Every fixture row is transaction-local and the outer rollback keeps
-- linked staging unchanged.
create temporary table practice_009_topics (
  ordinal integer primary key,
  slug text not null unique,
  grammar_topic_id uuid not null unique,
  submission_id uuid not null unique,
  feedback_draft_id uuid not null unique,
  practice_test_id uuid not null unique,
  question_id uuid not null unique
) on commit drop;

insert into practice_009_topics (
  ordinal,
  slug,
  grammar_topic_id,
  submission_id,
  feedback_draft_id,
  practice_test_id,
  question_id
)
select
  row_number() over (order by contract.slug)::integer,
  contract.slug,
  topic.id,
  md5('practice-009-submission-' || contract.slug)::uuid,
  md5('practice-009-feedback-' || contract.slug)::uuid,
  md5('practice-009-worksheet-' || contract.slug)::uuid,
  md5('practice-009-question-' || contract.slug)::uuid
from app_private.grammar_topic_contracts contract
join public.grammar_topics topic
  on topic.slug = contract.slug
 and topic.level = 'A1_A2';

select is(
  (select count(*) from practice_009_topics),
  36::bigint,
  'all 36 canonical grammar topics have one exact public topic mapping'
);

select results_eq(
  $$
    select fixture.slug
    from practice_009_topics fixture
    order by fixture.slug
  $$,
  $$
    select contract.slug
    from app_private.grammar_topic_contracts contract
    order by contract.slug
  $$,
  'the parameterized fixture contains the exact closed slug set without loss or extras'
);

select results_eq(
  $$
    select topic.slug, gate.worksheet_level
    from app_private.practice_topic_level_assignment_gates gate
    join public.grammar_topics topic on topic.id = gate.grammar_topic_id
    order by gate.worksheet_level, topic.slug
  $$,
  $$
    values
      ('adjective-endings'::text, 'A1'::text),
      ('future-tense'::text, 'A1'::text),
      ('genitiv'::text, 'A1'::text),
      ('infinitive-zu'::text, 'A1'::text),
      ('konjunktiv'::text, 'A1'::text),
      ('passive-voice'::text, 'A1'::text),
      ('plusquamperfekt'::text, 'A1'::text),
      ('praeteritum'::text, 'A1'::text),
      ('reflexive-verbs'::text, 'A1'::text),
      ('relative-clauses'::text, 'A1'::text),
      ('subordinate-clauses'::text, 'A1'::text),
      ('genitiv'::text, 'A2'::text),
      ('plusquamperfekt'::text, 'A2'::text)
  $$,
  'only the thirteen qualified-audit low-CEFR topic contexts require level-fit approval'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'app_private.practice_topic_level_assignment_gates',
    'SELECT'
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.practice_level_fit_opt_ins',
      'SELECT'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.practice_level_fit_opt_ins',
      'SELECT'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.practice_topic_level_gate_satisfied(uuid,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.opt_in_restricted_practice(uuid,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.opt_in_restricted_practice(uuid,text)',
      'EXECUTE'
    ),
  'policy, approvals, and helper internals stay private behind the teacher-authorized API command'
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
    'c9091111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'practice-009-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"PRACTICE-009 Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c9092222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'practice-009-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"PRACTICE-009 Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'c9093333-3333-4333-8333-333333333333',
  'PRACTICE-009 Workspace',
  'practice-009-all-canonical-topics',
  'c9091111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'c9091111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c9093333-3333-4333-8333-333333333333',
  'c9091111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c9093333-3333-4333-8333-333333333333',
  'c9092222-2222-4222-8222-222222222222',
  'student'
);

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
values (
  'c9094444-4444-4444-8444-444444444444',
  'c9093333-3333-4333-8333-333333333333',
  'PRACTICE-009 A2 Class',
  'A2',
  'c9091111-1111-4111-8111-111111111111',
  true,
  true,
  true,
  'immediate',
  0,
  0
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  'c9093333-3333-4333-8333-333333333333',
  'c9094444-4444-4444-8444-444444444444',
  'c9092222-2222-4222-8222-222222222222'
);

-- Give every canonical topic one independently selectable, answer-contract-v1
-- worksheet. These are fixture-only rows and never survive the rollback.
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
  mini_lesson,
  generation_source,
  quality_status
)
select
  fixture.practice_test_id,
  'c9093333-3333-4333-8333-333333333333',
  fixture.grammar_topic_id,
  'A2',
  'easy',
  'PRACTICE-009 ' || fixture.slug,
  'Transaction-only adaptive mapping fixture for ' || fixture.slug || '.',
  false,
  true,
  'workspace',
  'c9091111-1111-4111-8111-111111111111',
  jsonb_build_object(
    'short_explanation', 'Choose the grammatically correct form.',
    'key_rule', 'Apply the named grammar topic in context.',
    'correct_examples', jsonb_build_array('Ich helfe heute.'),
    'common_mistake_warning', 'Check the complete sentence before answering.',
    'what_to_revise', 'Review ' || fixture.slug || '.'
  ),
  'fixture',
  'approved'
from practice_009_topics fixture;

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
  fixture.question_id,
  fixture.practice_test_id,
  1,
  'multiple_choice',
  'local_exact',
  'Wähle die richtige Form: Ich ___ heute.',
  '["helfe","helfen","hilft"]'::jsonb,
  'helfe',
  '["helfe"]'::jsonb,
  null,
  1,
  'Ich requires the first-person singular form.'
from practice_009_topics fixture;

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
  'c9093333-3333-4333-8333-333333333333',
  'c9092222-2222-4222-8222-222222222222',
  'c9094444-4444-4444-8444-444444444444',
  'free_text',
  'free_text',
  'Ich helfen.',
  'Ich helfe.',
  'One released canonical weakness.',
  'A2',
  'checked',
  'immediate',
  'ready',
  'released',
  now()
from practice_009_topics fixture;

with source_context as (
  select
    fixture.submission_id,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to('Ich helfen.', 'UTF8')),
      'hex'
    ) as original_text_sha256
  from practice_009_topics fixture
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
  'c9093333-3333-4333-8333-333333333333',
  'c9092222-2222-4222-8222-222222222222',
  'c9094444-4444-4444-8444-444444444444',
  'A2',
  'free_text',
  null,
  'free_text',
  '{}'::jsonb,
  context.original_text_sha256,
  app_private.writing_evaluation_context_sha256(
    context.submission_id,
    1::smallint,
    'c9093333-3333-4333-8333-333333333333',
    'c9092222-2222-4222-8222-222222222222',
    'c9094444-4444-4444-8444-444444444444',
    'A2',
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
  1,
  'major',
  'Released canonical PRACTICE-009 weakness.'
from practice_009_topics fixture;

-- Inserting the released versions is the production event that captures the
-- immutable weakness evidence and reconciles the adaptive state machine.
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
  'practice_009_fixture',
  jsonb_build_object(
    'overall_summary', 'One released canonical weakness.',
    'level_detected', 'A2',
    'corrected_text', 'Ich helfe.',
    'ai_model', 'practice_009_fixture',
    'score_summary', '{}'::jsonb,
    'grammar_topics', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 11,
      'original_line', 'Ich helfen.',
      'corrected_line', 'Ich helfe.',
      'status', 'major_issue',
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
      'grammar_topic', fixture.slug
    ))
  ),
  now(),
  'c9091111-1111-4111-8111-111111111111',
  now(),
  'c9091111-1111-4111-8111-111111111111'
from practice_009_topics fixture;

select results_eq(
  $$
    select
      cycle.state,
      cycle.state_reason,
      cycle.active_assignment_id is null as has_no_assignment
    from app_private.practice_resolution_cycles cycle
    join public.grammar_topics topic on topic.id = cycle.grammar_topic_id
    where cycle.workspace_id = 'c9093333-3333-4333-8333-333333333333'
      and cycle.student_id = 'c9092222-2222-4222-8222-222222222222'
      and cycle.worksheet_level = 'A2'
      and cycle.resolved_at is null
      and topic.slug = 'plusquamperfekt'
  $$,
  $$
    values ('locked'::text, 'level_fit_approval_required'::text, true)
  $$,
  'A2 Plusquamperfekt reaches the weakness threshold but stays locked by default'
);

select is(
  (
    select count(*)
    from public.student_practice_assignments assignment
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    where assignment.workspace_id = 'c9093333-3333-4333-8333-333333333333'
      and assignment.student_id = 'c9092222-2222-4222-8222-222222222222'
      and assignment.status in ('unlocked', 'in_progress', 'completed')
      and topic.slug in ('genitiv', 'plusquamperfekt')
  ),
  0::bigint,
  'the two restricted A2 contexts create no ordinary automatic productive assignment'
);

select is(
  (
    select count(*)
    from public.student_practice_assignments assignment
    where assignment.workspace_id = 'c9093333-3333-4333-8333-333333333333'
      and assignment.student_id = 'c9092222-2222-4222-8222-222222222222'
      and assignment.status = 'unlocked'
      and assignment.source = 'weakness_auto'
      and assignment.worksheet_level = 'A2'
  ),
  34::bigint,
  'all ordinary A2 topic contexts still auto-assign without collateral gating'
);

create or replace function pg_temp.practice_009_direct_auto_assignment_rejected()
returns boolean
language plpgsql
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  error_message text;
begin
  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  join public.grammar_topics topic on topic.id = cycle.grammar_topic_id
  where cycle.workspace_id = 'c9093333-3333-4333-8333-333333333333'
    and cycle.student_id = 'c9092222-2222-4222-8222-222222222222'
    and cycle.worksheet_level = 'A2'
    and cycle.resolved_at is null
    and topic.slug = 'plusquamperfekt';

  insert into public.student_practice_assignments (
    id,
    workspace_id,
    student_id,
    grammar_topic_id,
    source,
    status,
    resolution_cycle_id,
    resolution_cycle_number,
    evidence_cutoff_sequence
  ) values (
    md5('practice-009-forbidden-direct-assignment')::uuid,
    selected_cycle.workspace_id,
    selected_cycle.student_id,
    selected_cycle.grammar_topic_id,
    'weakness_auto',
    'unlocked',
    selected_cycle.id,
    selected_cycle.cycle_number,
    selected_cycle.evidence_through_sequence
  );

  return false;
exception
  when check_violation then
    get stacked diagnostics error_message = message_text;
    return error_message = 'practice_level_fit_approval_required';
  when others then
    return false;
end;
$$;

select ok(
  pg_temp.practice_009_direct_auto_assignment_rejected(),
  'the assignment-table trigger blocks a future server path from bypassing the cycle gate'
);

create or replace function pg_temp.practice_009_student_opt_in_rejected(
  target_cycle_id uuid
)
returns boolean
language plpgsql
as $$
declare
  error_message text;
begin
  perform api.opt_in_restricted_practice(
    target_cycle_id,
    'The learner requests advanced productive practice.'
  );
  return false;
exception
  when insufficient_privilege then
    get stacked diagnostics error_message = message_text;
    return error_message = 'permission_denied';
  when others then
    return false;
end;
$$;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'c9092222-2222-4222-8222-222222222222',
  true
);

select ok(
  pg_temp.practice_009_student_opt_in_rejected((
    select cycle.id
    from app_private.practice_resolution_cycles cycle
    join public.grammar_topics topic on topic.id = cycle.grammar_topic_id
    where cycle.workspace_id = 'c9093333-3333-4333-8333-333333333333'
      and cycle.student_id = 'c9092222-2222-4222-8222-222222222222'
      and cycle.worksheet_level = 'A2'
      and cycle.resolved_at is null
      and topic.slug = 'plusquamperfekt'
  )),
  'a student cannot self-approve restricted productive practice'
);

select set_config(
  'request.jwt.claim.sub',
  'c9091111-1111-4111-8111-111111111111',
  true
);

create temporary table practice_009_level_fit_opt_in_result (
  payload jsonb not null
) on commit drop;

insert into practice_009_level_fit_opt_in_result (payload)
select api.opt_in_restricted_practice(
  cycle.id,
  'Teacher explicitly approves this advanced A2 practice for the learner.'
)
from app_private.practice_resolution_cycles cycle
join public.grammar_topics topic on topic.id = cycle.grammar_topic_id
where cycle.workspace_id = 'c9093333-3333-4333-8333-333333333333'
  and cycle.student_id = 'c9092222-2222-4222-8222-222222222222'
  and cycle.worksheet_level = 'A2'
  and cycle.resolved_at is null
  and topic.slug = 'plusquamperfekt';

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select results_eq(
  $$
    select
      payload ->> 'state',
      payload ->> 'approval_source',
      coalesce(payload ->> 'assignment_id', '') ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    from practice_009_level_fit_opt_in_result
  $$,
  $$
    values ('unlocked'::text, 'teacher_opt_in'::text, true)
  $$,
  'an authorized explicit opt-in atomically unlocks and creates the assignment'
);

select is(
  (
    select count(*)
    from app_private.practice_level_fit_opt_ins opt_in
    join public.grammar_topics topic on topic.id = opt_in.grammar_topic_id
    where opt_in.workspace_id = 'c9093333-3333-4333-8333-333333333333'
      and opt_in.student_id = 'c9092222-2222-4222-8222-222222222222'
      and opt_in.actor_id = 'c9091111-1111-4111-8111-111111111111'
      and opt_in.worksheet_level = 'A2'
      and topic.slug = 'plusquamperfekt'
  ),
  1::bigint,
  'the teacher level-fit decision is stored once in immutable private audit history'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'c9091111-1111-4111-8111-111111111111',
  true
);

create temporary table practice_009_level_fit_retry_result (
  payload jsonb not null
) on commit drop;

insert into practice_009_level_fit_retry_result (payload)
select api.opt_in_restricted_practice(
  opt_in.cycle_id,
  'Teacher explicitly approves this advanced A2 practice for the learner.'
)
from app_private.practice_level_fit_opt_ins opt_in
join public.grammar_topics topic on topic.id = opt_in.grammar_topic_id
where opt_in.workspace_id = 'c9093333-3333-4333-8333-333333333333'
  and opt_in.student_id = 'c9092222-2222-4222-8222-222222222222'
  and opt_in.worksheet_level = 'A2'
  and topic.slug = 'plusquamperfekt';

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select is(
  (
    select retry.payload ->> 'assignment_id'
    from practice_009_level_fit_retry_result retry
  ),
  (
    select initial.payload ->> 'assignment_id'
    from practice_009_level_fit_opt_in_result initial
  ),
  'a lost successful opt-in response can be retried without creating a second decision or assignment'
);

-- The all-topic path assertions below require every A2 topic to have an
-- assignment. Explicitly approve the second qualified-audit A2 hold as well;
-- the Plusquamperfekt flow above already proves authorization, audit, and
-- idempotent retry behavior in detail.
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'c9091111-1111-4111-8111-111111111111',
  true
);

select api.opt_in_restricted_practice(
  cycle.id,
  'Teacher explicitly approves this advanced A2 practice for the learner.'
)
from app_private.practice_resolution_cycles cycle
join public.grammar_topics topic on topic.id = cycle.grammar_topic_id
where cycle.workspace_id = 'c9093333-3333-4333-8333-333333333333'
  and cycle.student_id = 'c9092222-2222-4222-8222-222222222222'
  and cycle.worksheet_level = 'A2'
  and cycle.resolved_at is null
  and topic.slug = 'genitiv';

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select is(
  (
    select count(*)
    from app_private.practice_weakness_evidence evidence
    where evidence.workspace_id = 'c9093333-3333-4333-8333-333333333333'
      and evidence.student_id = 'c9092222-2222-4222-8222-222222222222'
      and evidence.source_kind = 'feedback_draft'
  ),
  36::bigint,
  'all 36 released feedback versions create one weakness-evidence row'
);

select ok(
  not exists (
    select 1
    from practice_009_topics fixture
    left join app_private.feedback_drafts draft
      on draft.id = fixture.feedback_draft_id
    left join app_private.practice_weakness_evidence evidence
      on evidence.source_release_id = fixture.feedback_draft_id
     and evidence.grammar_topic_id = fixture.grammar_topic_id
    where draft.state is distinct from 'released'
      or draft.content #>> '{lines,0,grammar_topic}' is distinct from fixture.slug
      or evidence.evidence_sequence is null
      or evidence.submission_id is distinct from fixture.submission_id
      or evidence.feedback_draft_id is distinct from fixture.feedback_draft_id
      or evidence.major_issue_count is distinct from 1
      or evidence.minor_issue_count is distinct from 0
      or evidence.batch_id is distinct from 'c9094444-4444-4444-8444-444444444444'
      or evidence.evidence_level is distinct from 'A2'
      or evidence.class_context_integrity is distinct from 'writing_snapshot'
      or evidence.writing_context_version is distinct from 1
      or evidence.writing_context_sha256 !~ '^[0-9a-f]{64}$'
  ),
  'every canonical slug remains exact in released content and snapshot-backed evidence'
);

select is(
  (
    select count(*)
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = 'c9093333-3333-4333-8333-333333333333'
      and cycle.student_id = 'c9092222-2222-4222-8222-222222222222'
      and cycle.resolved_at is null
      and cycle.state = 'unlocked'
      and cycle.class_context_version = 1
      and cycle.class_context_integrity = 'writing_snapshot'
      and cycle.batch_id = 'c9094444-4444-4444-8444-444444444444'
      and cycle.worksheet_level = 'A2'
      and cycle.active_assignment_id is not null
  ),
  36::bigint,
  'all 36 released weaknesses open one eligible snapshot-backed cycle'
);

select is(
  (
    select count(*)
    from public.student_grammar_stats stats
    where stats.workspace_id = 'c9093333-3333-4333-8333-333333333333'
      and stats.student_id = 'c9092222-2222-4222-8222-222222222222'
      and stats.weakness_level = 'unlocked'
      and stats.practice_unlocked
      and stats.total_major_issues = 1
      and stats.total_minor_issues = 0
  ),
  36::bigint,
  'all 36 canonical weaknesses are eligible in the student grammar state'
);

select is(
  (
    select count(*)
    from public.student_practice_assignments assignment
    join public.practice_tests worksheet
      on worksheet.id = assignment.practice_test_id
     and worksheet.grammar_topic_id = assignment.grammar_topic_id
    where assignment.workspace_id = 'c9093333-3333-4333-8333-333333333333'
      and assignment.student_id = 'c9092222-2222-4222-8222-222222222222'
      and assignment.status = 'unlocked'
      and assignment.source = 'weakness_auto'
      and assignment.generation_status = 'ready'
      and assignment.class_context_version = 1
      and assignment.class_context_integrity = 'writing_snapshot'
      and assignment.batch_id = 'c9094444-4444-4444-8444-444444444444'
      and assignment.worksheet_level = 'A2'
      and assignment.resolution_cycle_id is not null
      and assignment.evidence_cutoff_sequence is not null
      and worksheet.approval_source = 'workspace_human_review'
  ),
  36::bigint,
  'all 36 canonical weaknesses receive one exact-topic ready assignment'
);

select results_eq(
  $$
    select
      fixture.slug,
      draft.content #>> '{lines,0,grammar_topic}' = fixture.slug
        and evidence.evidence_sequence is not null
        and cycle.id is not null
        and stats.id is not null
        and assignment.id is not null
        and worksheet.grammar_topic_id = fixture.grammar_topic_id
        and assignment.practice_test_id = fixture.practice_test_id
        and cycle.active_assignment_id = assignment.id
        and stats.resolution_cycle_id = cycle.id
        and assignment.resolution_cycle_id = cycle.id as complete_path
    from practice_009_topics fixture
    left join app_private.feedback_drafts draft
      on draft.id = fixture.feedback_draft_id
    left join app_private.practice_weakness_evidence evidence
      on evidence.source_release_id = fixture.feedback_draft_id
     and evidence.grammar_topic_id = fixture.grammar_topic_id
    left join app_private.practice_resolution_cycles cycle
      on cycle.workspace_id = 'c9093333-3333-4333-8333-333333333333'
     and cycle.student_id = 'c9092222-2222-4222-8222-222222222222'
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    left join public.student_grammar_stats stats
      on stats.workspace_id = 'c9093333-3333-4333-8333-333333333333'
     and stats.student_id = 'c9092222-2222-4222-8222-222222222222'
     and stats.grammar_topic_id = fixture.grammar_topic_id
    left join public.student_practice_assignments assignment
      on assignment.workspace_id = 'c9093333-3333-4333-8333-333333333333'
     and assignment.student_id = 'c9092222-2222-4222-8222-222222222222'
     and assignment.grammar_topic_id = fixture.grammar_topic_id
     and assignment.status in ('unlocked', 'in_progress', 'completed')
    left join public.practice_tests worksheet
      on worksheet.id = assignment.practice_test_id
    order by fixture.slug
  $$,
  $$
    select fixture.slug, true as complete_path
    from practice_009_topics fixture
    order by fixture.slug
  $$,
  'each named canonical slug completes the released-feedback-to-assignment path without loss'
);

select is(
  (
    select count(*)
    from (
      select assignment.grammar_topic_id
      from public.student_practice_assignments assignment
      where assignment.workspace_id = 'c9093333-3333-4333-8333-333333333333'
        and assignment.student_id = 'c9092222-2222-4222-8222-222222222222'
        and assignment.status in ('unlocked', 'in_progress', 'completed')
      group by assignment.grammar_topic_id
      having count(*) <> 1
    ) duplicate_or_missing
  ),
  0::bigint,
  'the adaptive invariant remains exactly one active assignment per canonical topic'
);

select * from finish(true);
rollback;
