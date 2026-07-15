begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

create or replace function pg_temp.phase_13s_worksheet_payload(
  topic_slug text,
  topic_name text,
  worksheet_level text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'title', worksheet_level || ' ' || topic_name || ' Regression Worksheet',
    'description',
      'Rollback-only exact-context certified-bank recovery fixture.',
    'level', worksheet_level,
    'grammar_topic', jsonb_build_object(
      'slug', topic_slug,
      'name', topic_name
    ),
    'difficulty', 'easy',
    'visibility', 'workspace',
    'source', 'manual_import',
    'source_label', 'Phase 13S pgTAP fixture',
    'tags', jsonb_build_array(worksheet_level, topic_slug),
    'mini_lesson', jsonb_build_object(
      'short_explanation',
        'Use the target form only where the complete sentence requires it.',
      'key_rule',
        'Read the whole sentence before selecting the target form.',
      'correct_examples', jsonb_build_array(
        'Das ist das richtige Beispiel.',
        'Hier steht ein zweites richtiges Beispiel.'
      ),
      'common_mistake_warning',
        'Do not choose an answer from one isolated word.',
      'what_to_revise',
        'Review the target form and its complete sentence context.'
    ),
    'questions', jsonb_build_array(
      jsonb_build_object(
        'question_number', 1,
        'question_type', 'multiple_choice',
        'prompt', 'Wähle die richtige Form: Das ist ___ richtige Beispiel.',
        'options', jsonb_build_array('das', 'dem', 'den'),
        'correct_answer', 'das',
        'accepted_answers', jsonb_build_array('das'),
        'rubric', null,
        'answer_contract_version', 1,
        'explanation', 'The nominative neuter form is das.',
        'evaluation_mode', 'local_exact'
      ),
      jsonb_build_object(
        'question_number', 2,
        'question_type', 'fill_blank',
        'prompt', 'Nutze die Wortbank [ist, sind, war]: Das Beispiel ___ klar.',
        'options', jsonb_build_array(),
        'correct_answer', 'ist',
        'accepted_answers', jsonb_build_array('ist'),
        'rubric', null,
        'answer_contract_version', 1,
        'explanation', 'The singular subject takes ist.',
        'evaluation_mode', 'local_exact'
      )
    )
  );
$$;

-- This rollback-only matrix covers every closed evaluator topic at every V1
-- class level. It first leaves the canonical bank empty so the thirteen
-- qualified-audit low-CEFR contexts must remain locked. It then publishes one
-- exact certified fixture per hold and proves bounded recovery plus direct
-- attachment make those contexts ready without teacher opt-in or provider work.
create temporary table phase_13s_contexts (
  ordinal integer primary key,
  worksheet_level text not null,
  topic_slug text not null,
  grammar_topic_id uuid not null,
  student_id uuid not null,
  batch_id uuid not null,
  submission_id uuid not null unique,
  feedback_draft_id uuid not null unique,
  unique (worksheet_level, topic_slug)
) on commit drop;

insert into phase_13s_contexts (
  ordinal,
  worksheet_level,
  topic_slug,
  grammar_topic_id,
  student_id,
  batch_id,
  submission_id,
  feedback_draft_id
)
select
  row_number() over (
    order by levels.level_ordinal, contract.slug
  )::integer,
  levels.worksheet_level,
  contract.slug,
  app_private.resolve_worksheet_bank_topic_id(
    contract.slug,
    contract.display_name,
    levels.worksheet_level
  ),
  md5('phase-13s-student-' || lower(levels.worksheet_level))::uuid,
  md5('phase-13s-batch-' || lower(levels.worksheet_level))::uuid,
  md5(
    'phase-13s-submission-' || lower(levels.worksheet_level) || '-' || contract.slug
  )::uuid,
  md5(
    'phase-13s-feedback-' || lower(levels.worksheet_level) || '-' || contract.slug
  )::uuid
from app_private.grammar_topic_contracts contract
cross join (
  values
    (1, 'A1'::text),
    (2, 'A2'::text),
    (3, 'B1'::text),
    (4, 'B2'::text)
) levels(level_ordinal, worksheet_level);

create temporary table phase_13s_expected_gates (
  worksheet_level text not null,
  topic_slug text not null,
  primary key (worksheet_level, topic_slug)
) on commit drop;

insert into phase_13s_expected_gates (worksheet_level, topic_slug)
values
  ('A1', 'adjective-endings'),
  ('A1', 'future-tense'),
  ('A1', 'genitiv'),
  ('A1', 'infinitive-zu'),
  ('A1', 'konjunktiv'),
  ('A1', 'passive-voice'),
  ('A1', 'plusquamperfekt'),
  ('A1', 'praeteritum'),
  ('A1', 'reflexive-verbs'),
  ('A1', 'relative-clauses'),
  ('A1', 'subordinate-clauses'),
  ('A2', 'genitiv'),
  ('A2', 'plusquamperfekt');

select is(
  (select count(*) from app_private.grammar_topic_contracts),
  36::bigint,
  'the evaluator contract still contains exactly 36 closed topics'
);

select is(
  (select count(*) from phase_13s_contexts),
  144::bigint,
  'the regression contains all 144 CEFR/topic contexts'
);

select results_eq(
  $$
    select context.worksheet_level, count(*)::bigint
    from phase_13s_contexts context
    group by context.worksheet_level
    order by context.worksheet_level
  $$,
  $$
    values
      ('A1'::text, 36::bigint),
      ('A2'::text, 36::bigint),
      ('B1'::text, 36::bigint),
      ('B2'::text, 36::bigint)
  $$,
  'each V1 level contributes every closed topic exactly once'
);

select is(
  (
    select count(*)
    from phase_13s_contexts context
    left join app_private.grammar_topic_contracts contract
      on contract.slug = context.topic_slug
    left join public.grammar_topics topic
      on topic.id = context.grammar_topic_id
     and topic.slug = context.topic_slug
     and topic.level in (context.worksheet_level, 'A1_A2')
    where contract.slug is null or topic.id is null
  ),
  0::bigint,
  'all 144 contexts resolve to the same closed topic identity used by feedback materialization'
);

select results_eq(
  $$
    select gate.worksheet_level, topic.slug
    from app_private.practice_topic_level_assignment_gates gate
    join public.grammar_topics topic on topic.id = gate.grammar_topic_id
    order by gate.worksheet_level, topic.slug
  $$,
  $$
    select expected.worksheet_level, expected.topic_slug
    from phase_13s_expected_gates expected
    order by expected.worksheet_level, expected.topic_slug
  $$,
  'the low-CEFR hold remains exactly the thirteen reviewed topic/level contexts'
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
select
  '00000000-0000-0000-0000-000000000000',
  actor.id,
  'authenticated',
  'authenticated',
  actor.email,
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', actor.full_name),
  now(),
  now()
from (
  values
    (
      '51350000-0000-4000-8000-000000000001'::uuid,
      'phase-13s-teacher@example.test'::text,
      'Phase 13S Teacher'::text
    ),
    (
      md5('phase-13s-student-a1')::uuid,
      'phase-13s-a1-student@example.test'::text,
      'Phase 13S A1 Student'::text
    ),
    (
      md5('phase-13s-student-a2')::uuid,
      'phase-13s-a2-student@example.test'::text,
      'Phase 13S A2 Student'::text
    ),
    (
      md5('phase-13s-student-b1')::uuid,
      'phase-13s-b1-student@example.test'::text,
      'Phase 13S B1 Student'::text
    ),
    (
      md5('phase-13s-student-b2')::uuid,
      'phase-13s-b2-student@example.test'::text,
      'Phase 13S B2 Student'::text
    ),
    (
      '51350000-0000-4000-8000-000000000009'::uuid,
      'phase-13s-releaser@example.test'::text,
      'Phase 13S Independent Releaser'::text
    )
) actor(id, email, full_name);

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  revision,
  disabled_at,
  note
)
values (
  '51350000-0000-4000-8000-000000000001'::uuid,
  true,
  1,
  1,
  null,
  'Phase 13S rollback-only teacher entitlement.'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  '51350000-0000-4000-8000-000000000002',
  'Phase 13S all-context workspace',
  'phase-13s-all-level-topic-paths',
  '51350000-0000-4000-8000-000000000001'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '51350000-0000-4000-8000-000000000001',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '51350000-0000-4000-8000-000000000002',
  '51350000-0000-4000-8000-000000000001',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
select distinct
  '51350000-0000-4000-8000-000000000002'::uuid,
  context.student_id,
  'student'
from phase_13s_contexts context;

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
  context.batch_id,
  '51350000-0000-4000-8000-000000000002'::uuid,
  'Phase 13S ' || context.worksheet_level || ' Class',
  context.worksheet_level,
  '51350000-0000-4000-8000-000000000001'::uuid,
  true,
  true,
  true,
  'immediate',
  0,
  0
from phase_13s_contexts context;

insert into public.batch_students (workspace_id, batch_id, student_id)
select distinct
  '51350000-0000-4000-8000-000000000002'::uuid,
  context.batch_id,
  context.student_id
from phase_13s_contexts context;

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
  context.submission_id,
  '51350000-0000-4000-8000-000000000002',
  context.student_id,
  context.batch_id,
  'free_text',
  'free_text',
  'Ich helfen.',
  'Ich helfe.',
  'One released weakness for the complete level/topic matrix.',
  context.worksheet_level,
  'checked',
  'immediate',
  'ready',
  'released',
  now()
from phase_13s_contexts context;

with source_context as (
  select
    context.*,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to('Ich helfen.', 'UTF8')),
      'hex'
    ) as original_text_sha256
  from phase_13s_contexts context
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
  '51350000-0000-4000-8000-000000000002',
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
    '51350000-0000-4000-8000-000000000002',
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
  context.submission_id,
  context.grammar_topic_id,
  1,
  'major',
  'Released Phase 13S canonical weakness.'
from phase_13s_contexts context;

-- This is the real adaptive ingress: each released immutable feedback version
-- creates evidence, a level-bound resolution cycle, grammar stats, and (when
-- allowed) one active assignment.
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
  context.feedback_draft_id,
  context.submission_id,
  1,
  'released',
  'phase_13s_fixture',
  jsonb_build_object(
    'overall_summary', 'One released canonical weakness.',
    'level_detected', context.worksheet_level,
    'corrected_text', 'Ich helfe.',
    'ai_model', 'phase_13s_fixture',
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
        'reason', 'Use the correct form for this transaction fixture.',
        'source_start', 4,
        'source_end', 10,
        'corrected_start', 4,
        'corrected_end', 9
      )),
      'short_explanation', 'Apply the mapped canonical grammar topic.',
      'detailed_explanation', '',
      'grammar_topic', context.topic_slug
    ))
  ),
  now(),
  '51350000-0000-4000-8000-000000000001',
  now(),
  '51350000-0000-4000-8000-000000000001'
from phase_13s_contexts context;

select is(
  (
    select count(*)
    from app_private.practice_weakness_evidence evidence
    where evidence.workspace_id = '51350000-0000-4000-8000-000000000002'
      and evidence.source_kind = 'feedback_draft'
      and evidence.class_context_integrity = 'writing_snapshot'
      and evidence.writing_context_version = 1
  ),
  144::bigint,
  'all 144 released feedback contexts create snapshot-backed weakness evidence'
);

select is(
  (
    select count(*)
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = '51350000-0000-4000-8000-000000000002'
      and cycle.resolved_at is null
      and cycle.class_context_version = 1
      and cycle.class_context_integrity = 'writing_snapshot'
  ),
  144::bigint,
  'all 144 contexts open one immutable level-bound adaptive cycle'
);

select is(
  (
    select count(*)
    from app_private.practice_resolution_cycles cycle
    join phase_13s_contexts context
      on context.student_id = cycle.student_id
     and context.grammar_topic_id = cycle.grammar_topic_id
     and context.batch_id = cycle.batch_id
     and context.worksheet_level = cycle.worksheet_level
    join phase_13s_expected_gates expected
      on expected.worksheet_level = context.worksheet_level
     and expected.topic_slug = context.topic_slug
    where cycle.workspace_id = '51350000-0000-4000-8000-000000000002'
      and cycle.resolved_at is null
      and cycle.state = 'locked'
      and cycle.state_reason = 'level_fit_approval_required'
      and cycle.active_assignment_id is null
  ),
  13::bigint,
  'every restricted low-CEFR context stays locked before teacher opt-in or a qualified bank release'
);

select is(
  (
    select count(*)
    from app_private.practice_resolution_cycles cycle
    join phase_13s_contexts context
      on context.student_id = cycle.student_id
     and context.grammar_topic_id = cycle.grammar_topic_id
     and context.batch_id = cycle.batch_id
     and context.worksheet_level = cycle.worksheet_level
    left join phase_13s_expected_gates expected
      on expected.worksheet_level = context.worksheet_level
     and expected.topic_slug = context.topic_slug
    where cycle.workspace_id = '51350000-0000-4000-8000-000000000002'
      and expected.topic_slug is null
      and cycle.resolved_at is null
      and cycle.state = 'unlocked'
      and cycle.state_reason = 'worksheet_ready'
      and cycle.active_assignment_id is not null
  ),
  131::bigint,
  'all 131 ordinary contexts unlock automatically and own one assignment'
);

select is(
  (
    select count(*)
    from app_private.practice_resolution_cycles cycle
    join phase_13s_contexts context
      on context.student_id = cycle.student_id
     and context.grammar_topic_id = cycle.grammar_topic_id
     and context.batch_id = cycle.batch_id
     and context.worksheet_level = cycle.worksheet_level
    left join phase_13s_expected_gates expected
      on expected.worksheet_level = context.worksheet_level
     and expected.topic_slug = context.topic_slug
    join public.student_practice_assignments assignment
      on assignment.id = cycle.active_assignment_id
     and assignment.resolution_cycle_id = cycle.id
     and assignment.workspace_id = cycle.workspace_id
     and assignment.student_id = cycle.student_id
     and assignment.grammar_topic_id = cycle.grammar_topic_id
     and assignment.batch_id = cycle.batch_id
     and assignment.worksheet_level = cycle.worksheet_level
    where cycle.workspace_id = '51350000-0000-4000-8000-000000000002'
      and expected.topic_slug is null
      and assignment.status = 'unlocked'
      and assignment.source = 'weakness_auto'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'idle'
  ),
  131::bigint,
  'every ordinary context reaches the exact safe no-bank generation assignment'
);

select results_eq(
  $$
    select stats.weakness_level, stats.state_reason, count(*)::bigint
    from public.student_grammar_stats stats
    where stats.workspace_id = '51350000-0000-4000-8000-000000000002'
    group by stats.weakness_level, stats.state_reason
    order by stats.weakness_level, stats.state_reason
  $$,
  $$
    values
      ('locked'::text, 'level_fit_approval_required'::text, 13::bigint),
      ('unlocked'::text, 'worksheet_ready'::text, 131::bigint)
  $$,
  'student-visible adaptive state distinguishes honest holds from ready generation paths'
);

insert into app_private.practice_worksheet_bank_reviewers (
  user_id,
  qualification,
  can_certify,
  can_release,
  verified_by
)
values
  (
    '51350000-0000-4000-8000-000000000001',
    'Qualified German-language worksheet reviewer',
    true,
    false,
    '51350000-0000-4000-8000-000000000001'
  ),
  (
    '51350000-0000-4000-8000-000000000009',
    'Independent qualified worksheet release controller',
    false,
    true,
    '51350000-0000-4000-8000-000000000001'
  );

create temporary table phase_13s_certified_revisions (
  worksheet_level text not null,
  topic_slug text not null,
  grammar_topic_id uuid not null,
  revision_id uuid not null unique,
  content_sha256 text not null,
  primary key (worksheet_level, topic_slug)
) on commit drop;

insert into phase_13s_certified_revisions (
  worksheet_level,
  topic_slug,
  grammar_topic_id,
  revision_id,
  content_sha256
)
select
  context.worksheet_level,
  context.topic_slug,
  context.grammar_topic_id,
  published.revision_id,
  published.content_sha256
from phase_13s_contexts context
join phase_13s_expected_gates expected
  on expected.worksheet_level = context.worksheet_level
 and expected.topic_slug = context.topic_slug
join app_private.grammar_topic_contracts contract
  on contract.slug = context.topic_slug
cross join lateral app_private.publish_certified_worksheet_template(
  format(
    'phase13s.%s.%s',
    lower(context.worksheet_level),
    context.topic_slug
  ),
  pg_temp.phase_13s_worksheet_payload(
    context.topic_slug,
    contract.display_name,
    context.worksheet_level
  ),
  '51350000-0000-4000-8000-000000000001',
  '51350000-0000-4000-8000-000000000009',
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb,
  'Qualified Phase 13S exact-context transaction review.',
  'Independent Phase 13S exact-context transaction release.'
) published;

select is(
  (
    select count(*)
    from phase_13s_certified_revisions certified
    join app_private.practice_worksheet_template_revisions revision
      on revision.id = certified.revision_id
     and revision.content_sha256 = certified.content_sha256
     and revision.state = 'released'
    join app_private.practice_worksheet_templates template
      on template.id = revision.template_id
     and template.grammar_topic_id = certified.grammar_topic_id
     and template.level = certified.worksheet_level
    join app_private.practice_worksheet_template_reviews review
      on review.revision_id = revision.id
     and review.decision = 'approved'
     and review.content_sha256 = certified.content_sha256
    join app_private.practice_worksheet_template_releases release
      on release.revision_id = revision.id
     and release.review_id = review.id
     and release.content_sha256 = certified.content_sha256
  ),
  13::bigint,
  'all thirteen held contexts receive an exact independently released certified-bank revision'
);

create temporary table phase_13s_recovery_result (
  result jsonb not null
) on commit drop;

insert into phase_13s_recovery_result (result)
select app_private.reconcile_eligible_level_fit_cycles(25);

select is(
  (
    select result
    from phase_13s_recovery_result
  ),
  jsonb_build_object(
    'schema_version', 1,
    'attempted', 13,
    'succeeded', 13,
    'failed', 0,
    'deferred', 0,
    'exhausted', 0
  ),
  'the bounded recovery tick automatically reconciles every newly certified exact context'
);

select is(
  (
    select count(*)
    from app_private.practice_level_fit_opt_ins opt_in
    where opt_in.workspace_id = '51350000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'certified-bank recovery creates no teacher opt-in workload'
);

select is(
  (
    select count(*)
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = '51350000-0000-4000-8000-000000000002'
      and cycle.resolved_at is null
      and cycle.state = 'unlocked'
      and cycle.state_reason = 'worksheet_ready'
      and cycle.active_assignment_id is not null
  ),
  144::bigint,
  'after certified recovery, all 144 contexts own an active assignment'
);

select is(
  (
    select count(*)
    from public.student_practice_assignments assignment
    where assignment.workspace_id = '51350000-0000-4000-8000-000000000002'
      and assignment.status = 'unlocked'
  ),
  144::bigint,
  'the matrix creates exactly 144 active assignments and no duplicate active rows'
);

select is(
  (
    select count(*)
    from phase_13s_contexts context
    join app_private.practice_resolution_cycles cycle
      on cycle.workspace_id = '51350000-0000-4000-8000-000000000002'
     and cycle.student_id = context.student_id
     and cycle.grammar_topic_id = context.grammar_topic_id
     and cycle.batch_id = context.batch_id
     and cycle.worksheet_level = context.worksheet_level
     and cycle.resolved_at is null
    join public.student_practice_assignments assignment
      on assignment.id = cycle.active_assignment_id
     and assignment.resolution_cycle_id = cycle.id
     and assignment.workspace_id = cycle.workspace_id
     and assignment.student_id = cycle.student_id
     and assignment.grammar_topic_id = cycle.grammar_topic_id
     and assignment.batch_id = cycle.batch_id
     and assignment.worksheet_level = cycle.worksheet_level
     and assignment.class_context_version = 1
     and assignment.class_context_integrity = 'writing_snapshot'
  ),
  144::bigint,
  'every assignment preserves the exact detected topic, class, level, and writing snapshot'
);

select is(
  (
    select count(*)
    from public.student_practice_assignments assignment
    where assignment.workspace_id = '51350000-0000-4000-8000-000000000002'
      and assignment.status = 'unlocked'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'idle'
      and assignment.generation_error is null
  ),
  144::bigint,
  'all recovered assignments begin content-free before the explicit material request boundary'
);

create temporary table phase_13s_worker_contexts (
  ordinal integer primary key,
  assignment_id uuid not null,
  workspace_id uuid not null,
  grammar_topic_id uuid not null,
  attached_practice_test_id uuid,
  assignment_status text not null,
  batch_id uuid,
  batch_name text,
  worksheet_level text,
  topic_name text not null,
  topic_slug text not null,
  topic_level text not null,
  topic_description text,
  reusable_practice_test_id uuid,
  certified_template_revision_id uuid
) on commit drop;

grant select on phase_13s_contexts to service_role;
grant insert, select on phase_13s_worker_contexts to service_role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

insert into phase_13s_worker_contexts
select
  context.ordinal,
  worker_context.*
from phase_13s_contexts context
join public.student_practice_assignments assignment
  on assignment.workspace_id = '51350000-0000-4000-8000-000000000002'
 and assignment.student_id = context.student_id
 and assignment.grammar_topic_id = context.grammar_topic_id
 and assignment.batch_id = context.batch_id
 and assignment.worksheet_level = context.worksheet_level
 and assignment.status = 'unlocked'
cross join lateral api.get_worksheet_generation_context(
  assignment.id
) worker_context;

reset role;
select set_config('request.jwt.claim.role', '', true);

select is(
  (select count(*) from phase_13s_worker_contexts),
  144::bigint,
  'the service-only worker boundary loads every exact CEFR/topic context'
);

select is(
  (
    select count(*)
    from phase_13s_worker_contexts worker_context
    join phase_13s_contexts context using (ordinal)
    left join phase_13s_certified_revisions certified
      on certified.worksheet_level = context.worksheet_level
     and certified.topic_slug = context.topic_slug
    where worker_context.workspace_id = '51350000-0000-4000-8000-000000000002'
      and worker_context.grammar_topic_id = context.grammar_topic_id
      and worker_context.batch_id = context.batch_id
      and worker_context.worksheet_level = context.worksheet_level
      and worker_context.topic_slug = context.topic_slug
      and worker_context.assignment_status = 'unlocked'
      and nullif(btrim(worker_context.topic_name), '') is not null
      and nullif(btrim(worker_context.topic_description), '') is not null
      and worker_context.attached_practice_test_id is null
      and worker_context.reusable_practice_test_id is null
      and worker_context.certified_template_revision_id
        is not distinct from certified.revision_id
  ),
  144::bigint,
  'every worker input is exact and selects certified material only for release-covered holds'
);

select results_eq(
  $$
    select worker_context.worksheet_level, count(*)::bigint
    from phase_13s_worker_contexts worker_context
    group by worker_context.worksheet_level
    order by worker_context.worksheet_level
  $$,
  $$
    values
      ('A1'::text, 36::bigint),
      ('A2'::text, 36::bigint),
      ('B1'::text, 36::bigint),
      ('B2'::text, 36::bigint)
  $$,
  'safe worker inputs retain all 36 topics at each A1-B2 level'
);

create temporary table phase_13s_bank_request_targets (
  ordinal integer primary key,
  assignment_id uuid not null unique
) on commit drop;

insert into phase_13s_bank_request_targets (ordinal, assignment_id)
select context.ordinal, assignment.id
from phase_13s_contexts context
join phase_13s_expected_gates expected
  on expected.worksheet_level = context.worksheet_level
 and expected.topic_slug = context.topic_slug
join public.student_practice_assignments assignment
  on assignment.workspace_id = '51350000-0000-4000-8000-000000000002'
 and assignment.student_id = context.student_id
 and assignment.grammar_topic_id = context.grammar_topic_id
 and assignment.batch_id = context.batch_id
 and assignment.worksheet_level = context.worksheet_level
 and assignment.status = 'unlocked';

create temporary table phase_13s_bank_requests (
  ordinal integer primary key,
  assignment_id uuid not null unique,
  job_id uuid,
  generation_status text not null
) on commit drop;

grant select on phase_13s_bank_request_targets to authenticated;
grant insert, select on phase_13s_bank_requests to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '51350000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

insert into phase_13s_bank_requests
select target.ordinal, requested.*
from phase_13s_bank_request_targets target
cross join lateral api.request_practice_worksheet(
  target.assignment_id
) requested;

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select is(
  (
    select count(*)
    from phase_13s_bank_requests request
    where request.job_id is null
      and request.generation_status = 'ready'
  ),
  13::bigint,
  'all thirteen release-covered holds return ready synchronously with no provider job'
);

select is(
  (
    select count(*)
    from phase_13s_bank_requests request
    join phase_13s_contexts context using (ordinal)
    join phase_13s_certified_revisions certified
      on certified.worksheet_level = context.worksheet_level
     and certified.topic_slug = context.topic_slug
    join public.student_practice_assignments assignment
      on assignment.id = request.assignment_id
     and assignment.generation_status = 'ready'
     and assignment.generation_error is null
    join public.practice_tests worksheet
      on worksheet.id = assignment.practice_test_id
     and worksheet.worksheet_template_revision_id = certified.revision_id
     and worksheet.created_by_ai = false
     and worksheet.generation_source = 'certified_bank'
     and worksheet.approval_source = 'certified_template_bank'
    join app_private.worksheet_bank_direct_attachment_events event
      on event.assignment_id = assignment.id
     and event.template_revision_id = certified.revision_id
     and event.cloned_practice_test_id = worksheet.id
     and event.requested_by = '51350000-0000-4000-8000-000000000001'
     and event.attachment_source = 'certified_bank_direct'
    where not exists (
      select 1
      from app_private.async_jobs job
      where job.job_kind = 'worksheet_generation'
        and job.entity_id = assignment.id
    )
  ),
  13::bigint,
  'every held context attaches its exact non-AI certified clone with an auditable direct event'
);

select is(
  (
    select count(*)
    from (
      select
        assignment.student_id,
        assignment.grammar_topic_id
      from public.student_practice_assignments assignment
      where assignment.workspace_id = '51350000-0000-4000-8000-000000000002'
        and assignment.status in ('unlocked', 'in_progress', 'completed')
      group by assignment.student_id, assignment.grammar_topic_id
      having count(*) <> 1
    ) duplicate_or_missing
  ),
  0::bigint,
  'the one-active-worksheet-per-student/topic invariant holds across the full matrix'
);

select * from finish(true);
rollback;
