begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

-- Transaction-only fixtures exercise representative authorization, recovery,
-- and class-context paths from the qualified-source launch gate set through
-- the real released-feedback reconciliation path.
create temporary table phase_13d_cases (
  scenario text primary key,
  topic_slug text not null,
  worksheet_level text not null,
  student_id uuid not null unique,
  batch_id uuid not null,
  submission_id uuid not null unique,
  feedback_draft_id uuid not null unique,
  grammar_topic_id uuid not null
) on commit drop;

insert into phase_13d_cases (
  scenario,
  topic_slug,
  worksheet_level,
  student_id,
  batch_id,
  submission_id,
  feedback_draft_id,
  grammar_topic_id
)
select
  fixture.scenario,
  fixture.topic_slug,
  fixture.worksheet_level,
  md5('phase-13d-student-' || fixture.scenario)::uuid,
  md5('phase-13d-batch-' || fixture.batch_key)::uuid,
  md5('phase-13d-submission-' || fixture.scenario)::uuid,
  md5('phase-13d-feedback-' || fixture.scenario)::uuid,
  topic.id
from (
  values
    ('recovery_alpha'::text, 'genitiv'::text, 'A1'::text, 'recovery'::text),
    ('recovery_beta'::text, 'relative-clauses'::text, 'A1'::text, 'recovery'::text),
    ('inactive_batch'::text, 'plusquamperfekt'::text, 'A1'::text, 'inactive'::text),
    ('missing_enrollment'::text, 'passive-voice'::text, 'A1'::text, 'unenrolled'::text),
    ('audit_transition'::text, 'plusquamperfekt'::text, 'A2'::text, 'audit'::text)
) as fixture(scenario, topic_slug, worksheet_level, batch_key)
join public.grammar_topics topic
  on topic.slug = fixture.topic_slug
 and topic.level = 'A1_A2';

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
  'the migration seeds exactly the thirteen qualified-audit topic and frozen-level gates'
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
  '00000000-0000-0000-0000-000000000000'::uuid,
  fixture.user_id,
  'authenticated',
  'authenticated',
  fixture.email,
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', fixture.full_name),
  now(),
  now()
from (
  values
    (
      md5('phase-13d-teacher-main')::uuid,
      'phase-13d-teacher-main@example.test'::text,
      'Phase 13D Main Teacher'::text
    ),
    (
      md5('phase-13d-teacher-outsider')::uuid,
      'phase-13d-teacher-outsider@example.test'::text,
      'Phase 13D Outsider Teacher'::text
    )
) as fixture(user_id, email, full_name);

-- Teacher authority is entitlement-backed. Seed both actors so the main
-- teacher reaches the active-class guard and the outsider assertion proves
-- cross-workspace isolation rather than merely exercising an unentitled
-- account.
insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  revision,
  disabled_at,
  note
)
values
  (
    md5('phase-13d-teacher-main')::uuid,
    true,
    1,
    1,
    null,
    'Phase 13D rollback-only main-teacher entitlement.'
  ),
  (
    md5('phase-13d-teacher-outsider')::uuid,
    true,
    1,
    1,
    null,
    'Phase 13D rollback-only outsider-teacher entitlement.'
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
  '00000000-0000-0000-0000-000000000000'::uuid,
  fixture.student_id,
  'authenticated',
  'authenticated',
  'phase-13d-' || fixture.scenario || '@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', 'Phase 13D ' || fixture.scenario),
  now(),
  now()
from phase_13d_cases fixture;

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    md5('phase-13d-workspace-main')::uuid,
    'Phase 13D Main Workspace',
    'phase-13d-low-cefr-main',
    md5('phase-13d-teacher-main')::uuid
  ),
  (
    md5('phase-13d-workspace-outsider')::uuid,
    'Phase 13D Outsider Workspace',
    'phase-13d-low-cefr-outsider',
    md5('phase-13d-teacher-outsider')::uuid
  );

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13d-teacher-main')::uuid::text,
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13d-workspace-main')::uuid,
  md5('phase-13d-teacher-main')::uuid,
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
select
  md5('phase-13d-workspace-main')::uuid,
  fixture.student_id,
  'student'
from phase_13d_cases fixture;

select set_config(
  'request.jwt.claim.sub',
  md5('phase-13d-teacher-outsider')::uuid::text,
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13d-workspace-outsider')::uuid,
  md5('phase-13d-teacher-outsider')::uuid,
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
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
    md5('phase-13d-batch-recovery')::uuid,
    md5('phase-13d-workspace-main')::uuid,
    'Phase 13D Recovery A1',
    'A1',
    md5('phase-13d-teacher-main')::uuid,
    true,
    true,
    true,
    'immediate',
    0,
    0
  ),
  (
    md5('phase-13d-batch-inactive')::uuid,
    md5('phase-13d-workspace-main')::uuid,
    'Phase 13D Inactive A1',
    'A1',
    md5('phase-13d-teacher-main')::uuid,
    true,
    true,
    true,
    'immediate',
    0,
    0
  ),
  (
    md5('phase-13d-batch-unenrolled')::uuid,
    md5('phase-13d-workspace-main')::uuid,
    'Phase 13D Unenrolled A1',
    'A1',
    md5('phase-13d-teacher-main')::uuid,
    true,
    true,
    true,
    'immediate',
    0,
    0
  ),
  (
    md5('phase-13d-batch-audit')::uuid,
    md5('phase-13d-workspace-main')::uuid,
    'Phase 13D Audit A2',
    'A2',
    md5('phase-13d-teacher-main')::uuid,
    true,
    true,
    true,
    'immediate',
    0,
    0
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
select
  md5('phase-13d-workspace-main')::uuid,
  fixture.batch_id,
  fixture.student_id
from phase_13d_cases fixture;

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
  md5('phase-13d-workspace-main')::uuid,
  fixture.student_id,
  fixture.batch_id,
  'free_text',
  'free_text',
  'Ich helfen.',
  'Ich helfe.',
  'Phase 13D released weakness.',
  fixture.worksheet_level,
  'checked',
  'immediate',
  'ready',
  'released',
  now()
from phase_13d_cases fixture;

with source_context as (
  select
    fixture.*,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to('Ich helfen.', 'UTF8')),
      'hex'
    ) as original_text_sha256
  from phase_13d_cases fixture
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
  md5('phase-13d-workspace-main')::uuid,
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
    md5('phase-13d-workspace-main')::uuid,
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
  1,
  'major',
  'Phase 13D restricted productive-practice fixture.'
from phase_13d_cases fixture;

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
  'phase_13d_fixture',
  jsonb_build_object(
    'overall_summary', 'Phase 13D released weakness.',
    'level_detected', fixture.worksheet_level,
    'corrected_text', 'Ich helfe.',
    'ai_model', 'phase_13d_fixture',
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
      'grammar_topic', fixture.topic_slug
    ))
  ),
  now(),
  md5('phase-13d-teacher-main')::uuid,
  now(),
  md5('phase-13d-teacher-main')::uuid
from phase_13d_cases fixture;

select results_eq(
  $$
    select
      fixture.scenario,
      cycle.state,
      cycle.state_reason,
      cycle.active_assignment_id is null
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.workspace_id = md5('phase-13d-workspace-main')::uuid
     and cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    order by fixture.scenario
  $$,
  $$
    values
      ('audit_transition'::text, 'locked'::text, 'level_fit_approval_required'::text, true),
      ('inactive_batch'::text, 'locked'::text, 'level_fit_approval_required'::text, true),
      ('missing_enrollment'::text, 'locked'::text, 'level_fit_approval_required'::text, true),
      ('recovery_alpha'::text, 'locked'::text, 'level_fit_approval_required'::text, true),
      ('recovery_beta'::text, 'locked'::text, 'level_fit_approval_required'::text, true)
  $$,
  'all five exercised restricted contexts reach the threshold but stay gated'
);

select is(
  (
    select count(*)
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where not app_private.practice_topic_level_gate_satisfied(
      cycle.grammar_topic_id,
      cycle.worksheet_level,
      cycle.id
    )
  ),
  5::bigint,
  'none of the five exercised restricted contexts is satisfied without opt-in or a qualified release'
);

select is(
  (
    select count(*)
    from public.student_practice_assignments assignment
    where assignment.workspace_id = md5('phase-13d-workspace-main')::uuid
  ),
  0::bigint,
  'no automatic assignment bypasses an unsatisfied restricted gate'
);

-- Editing a class level must not rewrite the immutable writing-time level,
-- and that stale snapshot is no longer considered a currently active class
-- context until the batch level matches it again.
update public.batches batch
set level = 'A2'
where batch.id = md5('phase-13d-batch-recovery')::uuid;

select is(
  (
    select count(*)
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario in ('recovery_alpha', 'recovery_beta')
      and app_private.practice_cycle_has_active_class_context(cycle.id)
  ),
  0::bigint,
  'a current batch-level edit holds frozen contexts whose immutable level no longer matches'
);

update public.batches batch
set level = 'A1'
where batch.id = md5('phase-13d-batch-recovery')::uuid;

update public.batches batch
set is_active = false
where batch.id = md5('phase-13d-batch-inactive')::uuid;

delete from public.batch_students membership
where membership.batch_id = md5('phase-13d-batch-unenrolled')::uuid
  and membership.student_id = (
    select fixture.student_id
    from phase_13d_cases fixture
    where fixture.scenario = 'missing_enrollment'
  );

update app_private.practice_resolution_cycles cycle
set
  state = 'unlocked',
  state_reason = 'phase_13d_active_context_probe'
from phase_13d_cases fixture
where fixture.scenario in ('inactive_batch', 'missing_enrollment')
  and cycle.student_id = fixture.student_id
  and cycle.grammar_topic_id = fixture.grammar_topic_id
  and cycle.resolved_at is null;

select results_eq(
  $$
    select fixture.scenario, cycle.state, cycle.state_reason
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario in ('inactive_batch', 'missing_enrollment')
    order by fixture.scenario
  $$,
  $$
    values
      ('inactive_batch'::text, 'locked'::text, 'active_class_context_required'::text),
      ('missing_enrollment'::text, 'locked'::text, 'active_class_context_required'::text)
  $$,
  'inactive and non-enrolled exact class contexts cannot be unlocked'
);

select is(
  (
    select count(*)
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where app_private.practice_cycle_has_active_class_context(cycle.id)
  ),
  3::bigint,
  'only the two recovery contexts and audit context remain actively enrolled'
);

create or replace function pg_temp.phase_13d_opt_in_error(target_cycle_id uuid)
returns text
language plpgsql
as $$
declare
  error_code text;
  error_message text;
begin
  perform api.opt_in_restricted_practice(
    target_cycle_id,
    'Phase 13D explicit level-fit approval reason.'
  );
  return 'no_error';
exception when others then
  get stacked diagnostics
    error_code = returned_sqlstate,
    error_message = message_text;
  return error_code || ':' || error_message;
end;
$$;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13d-teacher-main')::uuid::text,
  true
);

select is(
  pg_temp.phase_13d_opt_in_error((
    select cycle.id
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario = 'inactive_batch'
  )),
  '42501:active_class_membership_required',
  'teacher opt-in rejects an inactive exact batch'
);

select is(
  pg_temp.phase_13d_opt_in_error((
    select cycle.id
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario = 'missing_enrollment'
  )),
  '42501:active_class_membership_required',
  'teacher opt-in rejects a missing exact batch enrollment'
);

select set_config(
  'request.jwt.claim.sub',
  md5('phase-13d-teacher-outsider')::uuid::text,
  true
);

select is(
  pg_temp.phase_13d_opt_in_error((
    select cycle.id
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario = 'audit_transition'
  )),
  '42501:permission_denied',
  'a teacher from another workspace cannot distinguish or approve the cycle'
);

select is(
  pg_temp.phase_13d_opt_in_error(md5('phase-13d-unknown-cycle')::uuid),
  '42501:permission_denied',
  'an unknown cycle and a cross-workspace cycle return the same safe denial'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

create or replace function pg_temp.phase_13d_mismatched_opt_in_rejected()
returns boolean
language plpgsql
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  error_message text;
begin
  select cycle.*
  into selected_cycle
  from phase_13d_cases fixture
  join app_private.practice_resolution_cycles cycle
    on cycle.student_id = fixture.student_id
   and cycle.grammar_topic_id = fixture.grammar_topic_id
   and cycle.resolved_at is null
  where fixture.scenario = 'audit_transition';

  insert into app_private.practice_level_fit_opt_ins (
    cycle_id,
    workspace_id,
    student_id,
    grammar_topic_id,
    batch_id,
    worksheet_level,
    actor_id,
    reason
  ) values (
    selected_cycle.id,
    selected_cycle.workspace_id,
    selected_cycle.student_id,
    selected_cycle.grammar_topic_id,
    md5('phase-13d-batch-recovery')::uuid,
    selected_cycle.worksheet_level,
    md5('phase-13d-teacher-main')::uuid,
    'Mismatched batch context must be rejected.'
  );

  return false;
exception
  when check_violation then
    get stacked diagnostics error_message = message_text;
    return error_message = 'practice_level_fit_opt_in_context_mismatch';
  when others then
    return false;
end;
$$;

select ok(
  pg_temp.phase_13d_mismatched_opt_in_rejected(),
  'the immutable opt-in ledger rejects context that differs from its cycle'
);

-- Build one pre-policy untouched assignment without firing the new guards,
-- then prove its cancellation event records the state actually stored after
-- the level-fit BEFORE trigger runs.
set local session_replication_role = replica;

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  source,
  status,
  generation_status,
  resolution_cycle_id,
  resolution_cycle_number,
  evidence_cutoff_sequence,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity
)
select
  md5('phase-13d-audit-assignment')::uuid,
  cycle.workspace_id,
  cycle.student_id,
  cycle.grammar_topic_id,
  'weakness_auto',
  'unlocked',
  'idle',
  cycle.id,
  cycle.cycle_number,
  cycle.evidence_through_sequence,
  cycle.batch_id,
  cycle.worksheet_level,
  cycle.class_context_version,
  cycle.class_context_integrity
from phase_13d_cases fixture
join app_private.practice_resolution_cycles cycle
  on cycle.student_id = fixture.student_id
 and cycle.grammar_topic_id = fixture.grammar_topic_id
 and cycle.resolved_at is null
where fixture.scenario = 'audit_transition';

update app_private.practice_resolution_cycles cycle
set
  active_assignment_id = md5('phase-13d-audit-assignment')::uuid,
  evidence_frozen_at = now(),
  state = 'unlocked',
  state_reason = 'worksheet_ready'
from phase_13d_cases fixture
where fixture.scenario = 'audit_transition'
  and cycle.student_id = fixture.student_id
  and cycle.grammar_topic_id = fixture.grammar_topic_id
  and cycle.resolved_at is null;

set local session_replication_role = origin;

update public.student_practice_assignments assignment
set
  status = 'cancelled',
  completed_at = now()
where assignment.id = md5('phase-13d-audit-assignment')::uuid;

-- Status mutations now commit through the durable transition outbox. The
-- service recovery processor applies cycle/event/stat changes after commit in
-- the global advisory -> cycle -> class -> assignment lock order.
set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

select results_eq(
  $$
    select cycle.state, cycle.state_reason, cycle.active_assignment_id is null
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario = 'audit_transition'
  $$,
  $$
    values ('locked'::text, 'level_fit_approval_required'::text, true)
  $$,
  'cancelling an untouched restricted assignment stores the gated cycle state'
);

select results_eq(
  $$
    select event.event_type, event.to_state, event.details ->> 'stored_state_reason'
    from app_private.practice_resolution_cycle_events event
    where event.assignment_id = md5('phase-13d-audit-assignment')::uuid
    order by event.event_sequence desc
    limit 1
  $$,
  $$
    values (
      'assignment_cancelled'::text,
      'locked'::text,
      'level_fit_approval_required'::text
    )
  $$,
  'the immutable transition event records the trigger-rewritten stored state'
);

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
  md5('phase-13d-teacher-main')::uuid,
  'Phase 13D recovery isolation approval.'
from phase_13d_cases fixture
join app_private.practice_resolution_cycles cycle
  on cycle.student_id = fixture.student_id
 and cycle.grammar_topic_id = fixture.grammar_topic_id
 and cycle.resolved_at is null
where fixture.scenario in ('recovery_alpha', 'recovery_beta');

select is(
  (
    select count(*)
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    where fixture.scenario in ('recovery_alpha', 'recovery_beta')
      and app_private.practice_topic_level_gate_satisfied(
        cycle.grammar_topic_id,
        cycle.worksheet_level,
        cycle.id
      )
  ),
  2::bigint,
  'two active restricted cycles become independently recovery-eligible'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.reconcile_eligible_level_fit_cycles(integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.reconcile_eligible_level_fit_cycles(integer)',
      'EXECUTE'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.practice_level_fit_reconciliation_failures',
      'SELECT'
    ),
  'only the service recovery facade can invoke the bounded private sweep'
);

create temporary table phase_13d_poison_student (
  student_id uuid primary key
) on commit drop;

insert into phase_13d_poison_student (student_id)
select cycle.student_id
from phase_13d_cases fixture
join app_private.practice_resolution_cycles cycle
  on cycle.student_id = fixture.student_id
 and cycle.grammar_topic_id = fixture.grammar_topic_id
 and cycle.resolved_at is null
where fixture.scenario in ('recovery_alpha', 'recovery_beta')
order by cycle.id
limit 1;

create or replace function pg_temp.phase_13d_reject_poison_assignment()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from pg_temp.phase_13d_poison_student poison
    where poison.student_id = new.student_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'phase_13d_poison_assignment';
  end if;
  return new;
end;
$$;

create trigger phase_13d_reject_poison_assignment
before insert on public.student_practice_assignments
for each row execute function pg_temp.phase_13d_reject_poison_assignment();

set local role service_role;
select set_config(
  'phase_13d.sweep_one',
  api.reconcile_eligible_level_fit_cycles(1)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'failed')::integer,
      (payload ->> 'deferred')::integer
    from (
      select current_setting('phase_13d.sweep_one')::jsonb as payload
    ) result
  $$,
  $$
    values (1, 0, 1, 0)
  $$,
  'a max-one recovery tick attempts only the first eligible cycle'
);

select results_eq(
  $$
    select
      count(*) filter (where failure.cycle_id is not null)::integer,
      count(*) filter (where cycle.active_assignment_id is not null)::integer
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    left join app_private.practice_level_fit_reconciliation_failures failure
      on failure.cycle_id = cycle.id
    where fixture.scenario in ('recovery_alpha', 'recovery_beta')
  $$,
  $$
    values (1, 0)
  $$,
  'the bounded failure is isolated and the second candidate remains untouched'
);

update app_private.practice_level_fit_reconciliation_failures failure
set next_retry_at = now() - interval '1 second'
where failure.cycle_id in (
  select cycle.id
  from app_private.practice_resolution_cycles cycle
  join phase_13d_poison_student poison on poison.student_id = cycle.student_id
  where cycle.resolved_at is null
);

set local role service_role;
select set_config(
  'phase_13d.sweep_two',
  api.reconcile_eligible_level_fit_cycles(2)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'failed')::integer,
      (payload ->> 'deferred')::integer
    from (
      select current_setting('phase_13d.sweep_two')::jsonb as payload
    ) result
  $$,
  $$
    values (2, 1, 1, 0)
  $$,
  'one poisoned cycle cannot prevent a healthy cycle succeeding in the same sweep'
);

select is(
  (
    select count(*)
    from phase_13d_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.student_id = fixture.student_id
     and cycle.grammar_topic_id = fixture.grammar_topic_id
     and cycle.resolved_at is null
    left join phase_13d_poison_student poison on poison.student_id = fixture.student_id
    join public.student_practice_assignments assignment
      on assignment.id = cycle.active_assignment_id
    where fixture.scenario in ('recovery_alpha', 'recovery_beta')
      and poison.student_id is null
      and cycle.state = 'unlocked'
      and assignment.status = 'unlocked'
      and assignment.source = 'weakness_auto'
      and assignment.batch_id = cycle.batch_id
      and assignment.worksheet_level = cycle.worksheet_level
  ),
  1::bigint,
  'the healthy eligible cycle receives exactly one active assignment'
);

select results_eq(
  $$
    select
      cycle.state,
      cycle.active_assignment_id is null,
      failure.failure_count,
      failure.last_error_code,
      failure.next_retry_at > failure.last_attempt_at
    from app_private.practice_resolution_cycles cycle
    join phase_13d_poison_student poison on poison.student_id = cycle.student_id
    join app_private.practice_level_fit_reconciliation_failures failure
      on failure.cycle_id = cycle.id
    where cycle.resolved_at is null
  $$,
  $$
    values (
      'locked'::text,
      true,
      2,
      'practice_level_fit_reconcile_failed'::text,
      true
    )
  $$,
  'the poisoned cycle remains safely locked with bounded content-free backoff state'
);

select * from finish(true);
rollback;
