begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

select ok(
  to_regprocedure(
    'app_private.practice_class_context_is_active(uuid,uuid,uuid,text)'
  ) is not null
    and to_regprocedure(
      'app_private.lock_active_practice_class_context(uuid,uuid,uuid,text)'
    ) is not null
    and not has_function_privilege(
      'anon',
      'app_private.practice_class_context_is_active(uuid,uuid,uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.practice_class_context_is_active(uuid,uuid,uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.lock_active_practice_class_context(uuid,uuid,uuid,text)',
      'EXECUTE'
    ),
  'class-context predicates remain private least-privilege helpers'
);

create temporary table phase_13u_evidence_fixtures (
  scenario text primary key,
  insertion_order integer not null unique,
  submission_id uuid not null unique,
  feedback_draft_id uuid not null unique,
  batch_id uuid not null,
  worksheet_level text not null,
  grammar_topic_id uuid not null,
  topic_slug text not null,
  severity text not null,
  issue_count integer not null
) on commit drop;

insert into phase_13u_evidence_fixtures (
  scenario,
  insertion_order,
  submission_id,
  feedback_draft_id,
  batch_id,
  worksheet_level,
  grammar_topic_id,
  topic_slug,
  severity,
  issue_count
)
select
  fixture.scenario,
  fixture.insertion_order,
  md5('phase-13u-submission-' || fixture.scenario)::uuid,
  md5('phase-13u-feedback-' || fixture.scenario)::uuid,
  md5('phase-13u-batch-' || fixture.batch_key)::uuid,
  fixture.worksheet_level,
  topic.id,
  fixture.topic_slug,
  fixture.severity,
  1
from (
  values
    (
      'mixed_a1_first'::text,
      1,
      'a1'::text,
      'A1'::text,
      'conjugation'::text,
      'minor'::text
    ),
    (
      'mixed_b2_second'::text,
      2,
      'b2'::text,
      'B2'::text,
      'conjugation'::text,
      'minor'::text
    ),
    (
      'mixed_b2_third'::text,
      3,
      'b2'::text,
      'B2'::text,
      'conjugation'::text,
      'minor'::text
    ),
    (
      'drift_a2_major'::text,
      4,
      'drift'::text,
      'A2'::text,
      'subject-verb-agreement'::text,
      'major'::text
    ),
    (
      'legacy_pair_valid_a1'::text,
      5,
      'a1'::text,
      'A1'::text,
      'articles'::text,
      'major'::text
    ),
    (
      'legacy_pair_later_a1'::text,
      6,
      'a1'::text,
      'A1'::text,
      'articles'::text,
      'minor'::text
    )
) as fixture(
  scenario,
  insertion_order,
  batch_key,
  worksheet_level,
  topic_slug,
  severity
)
join public.grammar_topics topic
  on topic.slug = fixture.topic_slug
 and topic.level = 'A1_A2';

-- Hold the mixed-level topic without an assignment so this test can continue
-- exercising unfrozen A1 -> B2 context refresh under the V1 one-issue policy.
-- The rows are transaction-only and model the same explicit level-fit safety
-- gate used for the qualified-audit launch contexts.
insert into app_private.practice_topic_level_assignment_gates (
  grammar_topic_id,
  worksheet_level,
  reason_code,
  rationale
)
select distinct
  fixture.grammar_topic_id,
  gated_level.worksheet_level,
  'level_fit_approval_required',
  'Phase 13U transaction-only context refresh safety hold.'
from phase_13u_evidence_fixtures fixture
cross join (
  values ('A1'::text), ('B2'::text)
) gated_level(worksheet_level)
where fixture.topic_slug = 'conjugation';

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
    '00000000-0000-0000-0000-000000000000'::uuid,
    md5('phase-13u-teacher')::uuid,
    'authenticated',
    'authenticated',
    'phase-13u-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13U Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    md5('phase-13u-student')::uuid,
    'authenticated',
    'authenticated',
    'phase-13u-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13U Student"}'::jsonb,
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
  md5('phase-13u-teacher')::uuid,
  true,
  1,
  1,
  null,
  'Phase 13U rollback-only teacher entitlement.'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  md5('phase-13u-workspace')::uuid,
  'Phase 13U Workspace',
  'phase-13u-current-practice-context',
  md5('phase-13u-teacher')::uuid
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13u-teacher')::uuid::text,
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13u-workspace')::uuid,
  md5('phase-13u-teacher')::uuid,
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13u-workspace')::uuid,
  md5('phase-13u-student')::uuid,
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
values
  (
    md5('phase-13u-batch-a1')::uuid,
    md5('phase-13u-workspace')::uuid,
    'Phase 13U A1 Class',
    'A1',
    md5('phase-13u-teacher')::uuid,
    true,
    true,
    true,
    'immediate',
    0,
    0
  ),
  (
    md5('phase-13u-batch-b2')::uuid,
    md5('phase-13u-workspace')::uuid,
    'Phase 13U B2 Class',
    'B2',
    md5('phase-13u-teacher')::uuid,
    true,
    true,
    true,
    'immediate',
    0,
    0
  ),
  (
    md5('phase-13u-batch-drift')::uuid,
    md5('phase-13u-workspace')::uuid,
    'Phase 13U A2 Changing Class',
    'A2',
    md5('phase-13u-teacher')::uuid,
    true,
    true,
    true,
    'immediate',
    0,
    0
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    md5('phase-13u-workspace')::uuid,
    md5('phase-13u-batch-a1')::uuid,
    md5('phase-13u-student')::uuid
  ),
  (
    md5('phase-13u-workspace')::uuid,
    md5('phase-13u-batch-b2')::uuid,
    md5('phase-13u-student')::uuid
  ),
  (
    md5('phase-13u-workspace')::uuid,
    md5('phase-13u-batch-drift')::uuid,
    md5('phase-13u-student')::uuid
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
  fixture.submission_id,
  md5('phase-13u-workspace')::uuid,
  md5('phase-13u-student')::uuid,
  fixture.batch_id,
  'free_text',
  'free_text',
  'Ich helfen.',
  'Ich helfe.',
  'Phase 13U released weakness.',
  fixture.worksheet_level,
  'checked',
  'immediate',
  'ready',
  'released',
  now()
from phase_13u_evidence_fixtures fixture;

with source_context as (
  select
    fixture.*,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to('Ich helfen.', 'UTF8')),
      'hex'
    ) as original_text_sha256
  from phase_13u_evidence_fixtures fixture
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
  md5('phase-13u-workspace')::uuid,
  md5('phase-13u-student')::uuid,
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
    md5('phase-13u-workspace')::uuid,
    md5('phase-13u-student')::uuid,
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
  fixture.issue_count,
  fixture.severity,
  'Phase 13U class-context fixture.'
from phase_13u_evidence_fixtures fixture;

-- Each statement commits one released feedback item to the append-only
-- evidence ledger, making the sequence and resulting context transitions
-- explicit and deterministic inside this rollback-only test.
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
  'phase_13u_fixture',
  jsonb_build_object(
    'overall_summary', 'Phase 13U released weakness.',
    'level_detected', fixture.worksheet_level,
    'corrected_text', 'Ich helfe.',
    'ai_model', 'phase_13u_fixture',
    'score_summary', '{}'::jsonb,
    'grammar_topics', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 11,
      'original_line', 'Ich helfen.',
      'corrected_line', 'Ich helfe.',
      'status', case fixture.severity
        when 'minor' then 'minor_issue'
        else 'major_issue'
      end,
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
  md5('phase-13u-teacher')::uuid,
  now(),
  md5('phase-13u-teacher')::uuid
from phase_13u_evidence_fixtures fixture
where fixture.scenario = 'mixed_a1_first';

select ok(
  exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    join phase_13u_evidence_fixtures fixture
      on fixture.scenario = 'mixed_a1_first'
     and fixture.grammar_topic_id = cycle.grammar_topic_id
    where cycle.workspace_id = md5('phase-13u-workspace')::uuid
      and cycle.student_id = md5('phase-13u-student')::uuid
      and cycle.resolved_at is null
      and cycle.state = 'locked'
      and cycle.state_reason = 'level_fit_approval_required'
      and cycle.batch_id = md5('phase-13u-batch-a1')::uuid
      and cycle.worksheet_level = 'A1'
      and cycle.minor_issue_count = 1
      and cycle.active_assignment_id is null
  ),
  'one A1 minor issue is available but remains behind the explicit level-fit safety hold'
);

insert into app_private.feedback_drafts (
  id, submission_id, version, state, provider_model, content,
  approved_at, approved_by, released_at, released_by
)
select
  fixture.feedback_draft_id,
  fixture.submission_id,
  1,
  'released',
  'phase_13u_fixture',
  jsonb_build_object(
    'overall_summary', 'Phase 13U released weakness.',
    'level_detected', fixture.worksheet_level,
    'corrected_text', 'Ich helfe.',
    'ai_model', 'phase_13u_fixture',
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
  md5('phase-13u-teacher')::uuid,
  now(),
  md5('phase-13u-teacher')::uuid
from phase_13u_evidence_fixtures fixture
where fixture.scenario = 'mixed_b2_second';

select ok(
  exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    join phase_13u_evidence_fixtures fixture
      on fixture.scenario = 'mixed_a1_first'
     and fixture.grammar_topic_id = cycle.grammar_topic_id
    where cycle.workspace_id = md5('phase-13u-workspace')::uuid
      and cycle.student_id = md5('phase-13u-student')::uuid
      and cycle.resolved_at is null
      and cycle.state = 'locked'
      and cycle.state_reason = 'level_fit_approval_required'
      and cycle.batch_id = md5('phase-13u-batch-b2')::uuid
      and cycle.worksheet_level = 'B2'
      and cycle.minor_issue_count = 2
      and cycle.active_assignment_id is null
  ),
  'the later B2 evidence deterministically refreshes the still-unfrozen cycle context'
);

select ok(
  exists (
    select 1
    from app_private.practice_resolution_cycle_events event
    join app_private.practice_resolution_cycles cycle
      on cycle.id = event.cycle_id
    join phase_13u_evidence_fixtures fixture
      on fixture.scenario = 'mixed_a1_first'
     and fixture.grammar_topic_id = cycle.grammar_topic_id
    where event.event_type = 'evidence_refreshed'
      and event.details ->> 'previous_worksheet_level' = 'A1'
      and event.details ->> 'worksheet_level' = 'B2'
      and (event.details ->> 'class_context_refreshed')::boolean
  ),
  'the A1-to-B2 unfrozen context refresh is preserved in immutable cycle audit history'
);

insert into app_private.feedback_drafts (
  id, submission_id, version, state, provider_model, content,
  approved_at, approved_by, released_at, released_by
)
select
  fixture.feedback_draft_id,
  fixture.submission_id,
  1,
  'released',
  'phase_13u_fixture',
  jsonb_build_object(
    'overall_summary', 'Phase 13U released weakness.',
    'level_detected', fixture.worksheet_level,
    'corrected_text', 'Ich helfe.',
    'ai_model', 'phase_13u_fixture',
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
  md5('phase-13u-teacher')::uuid,
  now(),
  md5('phase-13u-teacher')::uuid
from phase_13u_evidence_fixtures fixture
where fixture.scenario = 'mixed_b2_third';

insert into app_private.practice_level_fit_opt_ins (
  cycle_id,
  workspace_id,
  student_id,
  grammar_topic_id,
  batch_id,
  worksheet_level,
  actor_id,
  reason
)
select
  cycle.id,
  cycle.workspace_id,
  cycle.student_id,
  cycle.grammar_topic_id,
  cycle.batch_id,
  cycle.worksheet_level,
  md5('phase-13u-teacher')::uuid,
  'Phase 13U confirms the final refreshed B2 practice context.'
from app_private.practice_resolution_cycles cycle
join phase_13u_evidence_fixtures fixture
  on fixture.scenario = 'mixed_a1_first'
 and fixture.grammar_topic_id = cycle.grammar_topic_id
where cycle.workspace_id = md5('phase-13u-workspace')::uuid
  and cycle.student_id = md5('phase-13u-student')::uuid
  and cycle.resolved_at is null;

select app_private.reconcile_practice_topic_internal(
  md5('phase-13u-workspace')::uuid,
  md5('phase-13u-student')::uuid,
  (
    select fixture.grammar_topic_id
    from phase_13u_evidence_fixtures fixture
    where fixture.scenario = 'mixed_a1_first'
  )
);

select ok(
  exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    join public.student_practice_assignments assignment
      on assignment.id = cycle.active_assignment_id
    join phase_13u_evidence_fixtures fixture
      on fixture.scenario = 'mixed_a1_first'
     and fixture.grammar_topic_id = cycle.grammar_topic_id
    where cycle.workspace_id = md5('phase-13u-workspace')::uuid
      and cycle.student_id = md5('phase-13u-student')::uuid
      and cycle.resolved_at is null
      and cycle.minor_issue_count = 3
      and cycle.batch_id = md5('phase-13u-batch-b2')::uuid
      and cycle.worksheet_level = 'B2'
      and cycle.class_context_integrity = 'writing_snapshot'
      and assignment.batch_id = cycle.batch_id
      and assignment.worksheet_level = cycle.worksheet_level
      and assignment.class_context_integrity = cycle.class_context_integrity
      and assignment.status = 'unlocked'
  ),
  'A1 minor plus two later B2 minors unlocks exactly the current B2 context, never A1'
);

select is(
  (
    select count(*)
    from public.student_practice_assignments assignment
    join phase_13u_evidence_fixtures fixture
      on fixture.scenario = 'mixed_a1_first'
     and fixture.grammar_topic_id = assignment.grammar_topic_id
    where assignment.workspace_id = md5('phase-13u-workspace')::uuid
      and assignment.student_id = md5('phase-13u-student')::uuid
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  1::bigint,
  'mixed-level reconciliation preserves the one-active-assignment invariant'
);

insert into app_private.feedback_drafts (
  id, submission_id, version, state, provider_model, content,
  approved_at, approved_by, released_at, released_by
)
select
  fixture.feedback_draft_id,
  fixture.submission_id,
  1,
  'released',
  'phase_13u_fixture',
  jsonb_build_object(
    'overall_summary', 'Phase 13U released weakness.',
    'level_detected', fixture.worksheet_level,
    'corrected_text', 'Ich helfe.',
    'ai_model', 'phase_13u_fixture',
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
  md5('phase-13u-teacher')::uuid,
  now(),
  md5('phase-13u-teacher')::uuid
from phase_13u_evidence_fixtures fixture
where fixture.scenario = 'drift_a2_major';

create temporary table phase_13u_state (
  drift_cycle_id uuid,
  drift_assignment_id uuid
) on commit drop;

insert into phase_13u_state (drift_cycle_id, drift_assignment_id)
select cycle.id, cycle.active_assignment_id
from app_private.practice_resolution_cycles cycle
join phase_13u_evidence_fixtures fixture
  on fixture.scenario = 'drift_a2_major'
 and fixture.grammar_topic_id = cycle.grammar_topic_id
where cycle.workspace_id = md5('phase-13u-workspace')::uuid
  and cycle.student_id = md5('phase-13u-student')::uuid
  and cycle.resolved_at is null;

select ok(
  app_private.practice_class_context_is_active(
    md5('phase-13u-workspace')::uuid,
    md5('phase-13u-student')::uuid,
    md5('phase-13u-batch-drift')::uuid,
    'A2'
  )
    and app_private.lock_active_practice_class_context(
      md5('phase-13u-workspace')::uuid,
      md5('phase-13u-student')::uuid,
      md5('phase-13u-batch-drift')::uuid,
      'A2'
    )
    and exists (
      select 1
      from phase_13u_state state
      join public.student_practice_assignments assignment
        on assignment.id = state.drift_assignment_id
      where assignment.status = 'unlocked'
        and assignment.batch_id = md5('phase-13u-batch-drift')::uuid
        and assignment.worksheet_level = 'A2'
        and assignment.class_context_integrity = 'writing_snapshot'
    ),
  'the untouched A2 preparation starts in an exact active A2 class context'
);

update public.batches batch
set level = 'B1'
where batch.id = md5('phase-13u-batch-drift')::uuid;

select ok(
  not app_private.practice_class_context_is_active(
    md5('phase-13u-workspace')::uuid,
    md5('phase-13u-student')::uuid,
    md5('phase-13u-batch-drift')::uuid,
    'A2'
  )
    and not app_private.lock_active_practice_class_context(
      md5('phase-13u-workspace')::uuid,
      md5('phase-13u-student')::uuid,
      md5('phase-13u-batch-drift')::uuid,
      'A2'
    ),
  'both read and locking predicates reject an A2 snapshot after its batch becomes B1'
);

select ok(
  exists (
    select 1
    from phase_13u_state state
    join public.student_practice_assignments assignment
      on assignment.id = state.drift_assignment_id
    where assignment.status = 'cancelled'
      and assignment.batch_id = md5('phase-13u-batch-drift')::uuid
      and assignment.worksheet_level = 'A2'
      and assignment.class_context_integrity = 'writing_snapshot'
      and assignment.started_at is null
      and assignment.latest_attempt_id is null
  ),
  'the A2-to-B1 edit cancels only untouched preparation while preserving its immutable A2 audit snapshot'
);

select ok(
  exists (
    select 1
    from phase_13u_state state
    join app_private.practice_assignment_cycle_transition_jobs transition_job
      on transition_job.assignment_id = state.drift_assignment_id
    where transition_job.target_status = 'cancelled'
      and transition_job.processed_at is null
  ),
  'the stale preparation cancellation records a durable transition before detachment'
);

select set_config(
  'phase_13u.transition_result',
  app_private.process_practice_cycle_transition_jobs(10)::text,
  true
);

select ok(
  (current_setting('phase_13u.transition_result')::jsonb ->> 'succeeded')::integer >= 1
    and (current_setting('phase_13u.transition_result')::jsonb ->> 'failed')::integer = 0,
  'transition recovery applies the stale-context cancellation without database intervention'
);

select ok(
  exists (
    select 1
    from phase_13u_state state
    join app_private.practice_resolution_cycles cycle
      on cycle.id = state.drift_cycle_id
    where cycle.state = 'locked'
      and cycle.state_reason = 'active_class_context_required'
      and cycle.active_assignment_id is null
      and cycle.batch_id = md5('phase-13u-batch-drift')::uuid
      and cycle.worksheet_level = 'A2'
      and cycle.class_context_integrity = 'writing_snapshot'
  ),
  'recovery detaches the stale preparation and safely holds the immutable A2 cycle'
);

select ok(
  exists (
    select 1
    from phase_13u_state state
    join app_private.practice_resolution_cycle_events event
      on event.cycle_id = state.drift_cycle_id
     and event.assignment_id = state.drift_assignment_id
    where event.event_type = 'assignment_cancelled'
  ),
  'the batch-level drift remains visible in immutable cycle event history'
);

select is(
  (
    select count(*)
    from public.student_practice_assignments assignment
    join phase_13u_evidence_fixtures fixture
      on fixture.scenario = 'drift_a2_major'
     and fixture.grammar_topic_id = assignment.grammar_topic_id
    where assignment.workspace_id = md5('phase-13u-workspace')::uuid
      and assignment.student_id = md5('phase-13u-student')::uuid
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  0::bigint,
  'the held A2-to-B1 cycle exposes no stale or duplicate active worksheet'
);

-- A legacy recovery shell can own one untouched version-zero assignment while
-- newer snapshot-backed evidence arrives. Reconciliation must retain that new
-- evidence for a later epoch without promoting only the cycle half, freezing
-- the shell, or making the existing teacher-recovery RPC unusable.
set local session_replication_role = replica;

insert into app_private.practice_resolution_cycles (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  cycle_number,
  state,
  state_reason,
  evidence_start_sequence,
  evidence_through_sequence,
  minor_issue_count,
  major_issue_count,
  class_context_version,
  class_context_integrity
)
select
  md5('phase-13u-legacy-pair-cycle')::uuid,
  md5('phase-13u-workspace')::uuid,
  md5('phase-13u-student')::uuid,
  fixture.grammar_topic_id,
  1,
  'unlocked',
  'writing_context_snapshot_required',
  1,
  1,
  0,
  1,
  0,
  'legacy_unverified'
from phase_13u_evidence_fixtures fixture
where fixture.scenario = 'legacy_pair_valid_a1';

set local session_replication_role = origin;

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  source,
  status,
  generation_status,
  generation_error,
  resolution_cycle_id,
  resolution_cycle_number,
  evidence_cutoff_sequence,
  class_context_version,
  class_context_integrity
)
select
  md5('phase-13u-legacy-pair-assignment')::uuid,
  md5('phase-13u-workspace')::uuid,
  md5('phase-13u-student')::uuid,
  fixture.grammar_topic_id,
  'weakness_auto',
  'unlocked',
  'failed',
  'worksheet_class_context_required',
  md5('phase-13u-legacy-pair-cycle')::uuid,
  1,
  1,
  0,
  'legacy_unverified'
from phase_13u_evidence_fixtures fixture
where fixture.scenario = 'legacy_pair_valid_a1';

update app_private.practice_resolution_cycles cycle
set active_assignment_id = md5('phase-13u-legacy-pair-assignment')::uuid
where cycle.id = md5('phase-13u-legacy-pair-cycle')::uuid;

insert into app_private.feedback_drafts (
  id, submission_id, version, state, provider_model, content,
  approved_at, approved_by, released_at, released_by
)
select
  fixture.feedback_draft_id,
  fixture.submission_id,
  1,
  'released',
  'phase_13u_fixture',
  jsonb_build_object(
    'overall_summary', 'Phase 13U released weakness.',
    'level_detected', fixture.worksheet_level,
    'corrected_text', 'Ich helfe.',
    'ai_model', 'phase_13u_fixture',
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
  md5('phase-13u-teacher')::uuid,
  now(),
  md5('phase-13u-teacher')::uuid
from phase_13u_evidence_fixtures fixture
where fixture.scenario = 'legacy_pair_valid_a1';

select ok(
  exists (
    select 1
    from app_private.practice_weakness_evidence evidence
    join phase_13u_evidence_fixtures fixture
      on fixture.scenario = 'legacy_pair_valid_a1'
     and fixture.grammar_topic_id = evidence.grammar_topic_id
    where evidence.source_release_id = fixture.feedback_draft_id
      and evidence.class_context_integrity = 'writing_snapshot'
      and evidence.evidence_sequence > 1
  )
    and exists (
      select 1
      from app_private.practice_resolution_cycles cycle
      join public.student_practice_assignments assignment
        on assignment.id = cycle.active_assignment_id
      where cycle.id = md5('phase-13u-legacy-pair-cycle')::uuid
        and cycle.class_context_version = 0
        and cycle.class_context_integrity = 'legacy_unverified'
        and cycle.batch_id is null
        and cycle.worksheet_level is null
        and cycle.evidence_frozen_at is null
        and assignment.id = md5('phase-13u-legacy-pair-assignment')::uuid
        and assignment.class_context_version = 0
        and assignment.class_context_integrity = 'legacy_unverified'
        and assignment.batch_id is null
        and assignment.worksheet_level is null
    )
    and (
      select count(*)
      from public.student_practice_assignments assignment
      join phase_13u_evidence_fixtures fixture
        on fixture.scenario = 'legacy_pair_valid_a1'
       and fixture.grammar_topic_id = assignment.grammar_topic_id
      where assignment.workspace_id = md5('phase-13u-workspace')::uuid
        and assignment.student_id = md5('phase-13u-student')::uuid
        and assignment.status in ('unlocked', 'in_progress', 'completed')
    ) = 1,
  'new valid evidence is retained without promoting, freezing, or duplicating a legacy active pair'
);

select throws_ok(
  $$
    update app_private.practice_resolution_cycles cycle
    set
      batch_id = md5('phase-13u-batch-a1')::uuid,
      worksheet_level = 'A1',
      class_context_version = 1,
      class_context_integrity = 'writing_snapshot'
    where cycle.id = md5('phase-13u-legacy-pair-cycle')::uuid
  $$,
  '55000',
  'Practice cycle class context requires atomic teacher recovery.',
  'a private caller cannot promote only the cycle half of an active legacy pair'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13u-teacher')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13u-teacher')::uuid::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  (
    api.resolve_practice_assignment_class_context(
      md5('phase-13u-legacy-pair-assignment')::uuid,
      md5('phase-13u-batch-a1')::uuid
    ) ->> 'worksheet_level'
  ),
  'A1'::text,
  'the authenticated teacher recovery remains available for the preserved legacy pair'
);

reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select ok(
  exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    join public.student_practice_assignments assignment
      on assignment.id = cycle.active_assignment_id
     and assignment.resolution_cycle_id = cycle.id
    where cycle.id = md5('phase-13u-legacy-pair-cycle')::uuid
      and cycle.class_context_version = 1
      and cycle.class_context_integrity = 'teacher_verified'
      and cycle.batch_id = md5('phase-13u-batch-a1')::uuid
      and cycle.worksheet_level = 'A1'
      and assignment.id = md5('phase-13u-legacy-pair-assignment')::uuid
      and assignment.class_context_version = 1
      and assignment.class_context_integrity = 'teacher_verified'
      and assignment.batch_id = cycle.batch_id
      and assignment.worksheet_level = cycle.worksheet_level
      and cycle.evidence_frozen_at = assignment.assigned_at
      and cycle.evidence_through_sequence = assignment.evidence_cutoff_sequence
  ),
  'teacher recovery atomically freezes one matching version-one pair at its immutable assignment cutoff'
);

insert into app_private.feedback_drafts (
  id, submission_id, version, state, provider_model, content,
  approved_at, approved_by, released_at, released_by
)
select
  fixture.feedback_draft_id,
  fixture.submission_id,
  1,
  'released',
  'phase_13u_fixture',
  jsonb_build_object(
    'overall_summary', 'Phase 13U later released weakness.',
    'level_detected', fixture.worksheet_level,
    'corrected_text', 'Ich helfe.',
    'ai_model', 'phase_13u_fixture',
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
  md5('phase-13u-teacher')::uuid,
  now(),
  md5('phase-13u-teacher')::uuid
from phase_13u_evidence_fixtures fixture
where fixture.scenario = 'legacy_pair_later_a1';

select ok(
  exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    join public.student_practice_assignments assignment
      on assignment.id = cycle.active_assignment_id
    where cycle.id = md5('phase-13u-legacy-pair-cycle')::uuid
      and cycle.class_context_version = 1
      and cycle.evidence_frozen_at = assignment.assigned_at
      and cycle.evidence_through_sequence = 1
      and assignment.evidence_cutoff_sequence = 1
      and exists (
        select 1
        from app_private.practice_weakness_evidence evidence
        join phase_13u_evidence_fixtures fixture
          on fixture.scenario = 'legacy_pair_later_a1'
         and fixture.grammar_topic_id = evidence.grammar_topic_id
        where evidence.source_release_id = fixture.feedback_draft_id
          and evidence.evidence_sequence > cycle.evidence_through_sequence
      )
  ),
  'later reconciliation preserves the frozen assignment cutoff and retains recurrence evidence beyond it'
);

insert into public.practice_tests (
  id,
  workspace_id,
  grammar_topic_id,
  level,
  difficulty,
  title,
  created_by_ai,
  teacher_reviewed,
  visibility,
  created_by,
  generation_source,
  quality_status,
  reviewed_by,
  reviewed_at
)
select
  md5('phase-13u-legacy-pair-test')::uuid,
  md5('phase-13u-workspace')::uuid,
  fixture.grammar_topic_id,
  'A1',
  'easy',
  'Phase 13U recovered-context pass fixture',
  false,
  true,
  'workspace',
  md5('phase-13u-teacher')::uuid,
  'fixture',
  'approved',
  md5('phase-13u-teacher')::uuid,
  now()
from phase_13u_evidence_fixtures fixture
where fixture.scenario = 'legacy_pair_valid_a1';

update public.student_practice_assignments assignment
set
  practice_test_id = md5('phase-13u-legacy-pair-test')::uuid,
  generation_status = 'ready',
  generation_error = null
where assignment.id = md5('phase-13u-legacy-pair-assignment')::uuid;

insert into public.practice_test_attempts (
  id,
  practice_test_id,
  student_id,
  workspace_id,
  assignment_id,
  status,
  answers,
  score,
  max_score,
  score_points,
  max_score_points,
  score_percent,
  passed,
  scoring_version,
  evaluation_status,
  started_at,
  submitted_at,
  completed_at
)
values (
  md5('phase-13u-legacy-pair-attempt')::uuid,
  md5('phase-13u-legacy-pair-test')::uuid,
  md5('phase-13u-student')::uuid,
  md5('phase-13u-workspace')::uuid,
  md5('phase-13u-legacy-pair-assignment')::uuid,
  'checked',
  '[]'::jsonb,
  1,
  1,
  1,
  1,
  100,
  true,
  'phase_13u_fixture',
  'not_needed',
  now() - interval '2 minutes',
  now() - interval '1 minute',
  now()
);

update public.student_practice_assignments assignment
set
  latest_attempt_id = md5('phase-13u-legacy-pair-attempt')::uuid,
  status = 'passed',
  started_at = coalesce(assignment.started_at, now() - interval '2 minutes'),
  completed_at = now()
where assignment.id = md5('phase-13u-legacy-pair-assignment')::uuid;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select set_config(
  'phase_13u.legacy_pass_result',
  api.process_practice_cycle_transition_jobs(10)::text,
  true
);
reset role;
select set_config('request.jwt.claim.role', '', true);

select ok(
  (current_setting('phase_13u.legacy_pass_result')::jsonb ->> 'succeeded')::integer >= 1
    and (current_setting('phase_13u.legacy_pass_result')::jsonb ->> 'failed')::integer = 0,
  'the recovered assignment pass finalizes without a cutoff mismatch'
);

select ok(
  exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    where cycle.id = md5('phase-13u-legacy-pair-cycle')::uuid
      and cycle.resolved_at is not null
      and cycle.resolution_outcome = 'passed'
      and cycle.resolution_assignment_id =
        md5('phase-13u-legacy-pair-assignment')::uuid
      and cycle.resolution_attempt_id =
        md5('phase-13u-legacy-pair-attempt')::uuid
      and cycle.resolved_through_sequence = 1
  )
    and exists (
      select 1
      from app_private.practice_resolution_cycles recurrence
      join phase_13u_evidence_fixtures fixture
        on fixture.scenario = 'legacy_pair_valid_a1'
       and fixture.grammar_topic_id = recurrence.grammar_topic_id
      where recurrence.workspace_id = md5('phase-13u-workspace')::uuid
        and recurrence.student_id = md5('phase-13u-student')::uuid
        and recurrence.id <> md5('phase-13u-legacy-pair-cycle')::uuid
        and recurrence.resolved_at is null
        and recurrence.evidence_start_sequence > 1
        and recurrence.batch_id = md5('phase-13u-batch-a1')::uuid
        and recurrence.worksheet_level = 'A1'
  ),
  'the pass resolves only its frozen cutoff and opens a later recurrence without losing evidence'
);

select * from finish(true);
rollback;
