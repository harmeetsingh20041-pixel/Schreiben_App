begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

create or replace function pg_temp.phase_13h_worksheet_payload(
  topic_slug text,
  topic_name text,
  worksheet_level text,
  worksheet_title text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'title', worksheet_title,
    'description', 'Focused low-CEFR withdrawal-gate regression material.',
    'level', worksheet_level,
    'grammar_topic', jsonb_build_object(
      'slug', topic_slug,
      'name', topic_name
    ),
    'difficulty', 'easy',
    'visibility', 'workspace',
    'source', 'manual_import',
    'source_label', 'Phase 13H pgTAP fixture',
    'tags', jsonb_build_array(worksheet_level, topic_slug),
    'mini_lesson', jsonb_build_object(
      'short_explanation', 'Use the target form only where the sentence requires it.',
      'key_rule', 'Read the whole sentence before selecting the target form.',
      'correct_examples', jsonb_build_array(
        'Das ist das richtige Beispiel.',
        'Hier steht ein zweites richtiges Beispiel.'
      ),
      'common_mistake_warning', 'Do not choose an answer from one word alone.',
      'what_to_revise', 'Review the target form and its sentence context.'
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
      md5('phase-13h-teacher-certifier')::uuid,
      'phase-13h-teacher@example.test'::text,
      'Phase 13H Teacher Certifier'::text
    ),
    (
      md5('phase-13h-releaser')::uuid,
      'phase-13h-releaser@example.test'::text,
      'Phase 13H Release Controller'::text
    ),
    (
      md5('phase-13h-student-sole')::uuid,
      'phase-13h-student-sole@example.test'::text,
      'Phase 13H Sole Student'::text
    ),
    (
      md5('phase-13h-student-alternate')::uuid,
      'phase-13h-student-alternate@example.test'::text,
      'Phase 13H Alternate Student'::text
    ),
    (
      md5('phase-13h-student-opt-in')::uuid,
      'phase-13h-student-opt-in@example.test'::text,
      'Phase 13H Opt-in Student'::text
    )
) as fixture(user_id, email, full_name);

-- Workspace teacher authority is entitlement-backed. This rollback-only
-- fixture must reach the restricted-practice opt-in guard instead of being
-- rejected earlier as an unentitled account.
insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  revision,
  disabled_at,
  note
)
values (
  md5('phase-13h-teacher-certifier')::uuid,
  true,
  1,
  1,
  null,
  'Phase 13H rollback-only teacher entitlement.'
);

insert into public.profiles (id, full_name, email, global_role)
select fixture.user_id, fixture.full_name, fixture.email, 'student'
from (
  values
    (
      md5('phase-13h-teacher-certifier')::uuid,
      'Phase 13H Teacher Certifier'::text,
      'phase-13h-teacher@example.test'::text
    ),
    (
      md5('phase-13h-releaser')::uuid,
      'Phase 13H Release Controller'::text,
      'phase-13h-releaser@example.test'::text
    ),
    (
      md5('phase-13h-student-sole')::uuid,
      'Phase 13H Sole Student'::text,
      'phase-13h-student-sole@example.test'::text
    ),
    (
      md5('phase-13h-student-alternate')::uuid,
      'Phase 13H Alternate Student'::text,
      'phase-13h-student-alternate@example.test'::text
    ),
    (
      md5('phase-13h-student-opt-in')::uuid,
      'Phase 13H Opt-in Student'::text,
      'phase-13h-student-opt-in@example.test'::text
    )
) as fixture(user_id, full_name, email)
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  md5('phase-13h-workspace')::uuid,
  'Phase 13H Workspace',
  'phase-13h-low-cefr-withdrawal-gate',
  md5('phase-13h-teacher-certifier')::uuid
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13h-teacher-certifier')::uuid::text,
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13h-workspace')::uuid,
  md5('phase-13h-teacher-certifier')::uuid,
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    md5('phase-13h-workspace')::uuid,
    md5('phase-13h-student-sole')::uuid,
    'student'
  ),
  (
    md5('phase-13h-workspace')::uuid,
    md5('phase-13h-student-alternate')::uuid,
    'student'
  ),
  (
    md5('phase-13h-workspace')::uuid,
    md5('phase-13h-student-opt-in')::uuid,
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
  created_by
)
values
  (
    md5('phase-13h-batch-a2')::uuid,
    md5('phase-13h-workspace')::uuid,
    'Phase 13H A2',
    'A2',
    true,
    md5('phase-13h-teacher-certifier')::uuid
  ),
  (
    md5('phase-13h-batch-a1')::uuid,
    md5('phase-13h-workspace')::uuid,
    'Phase 13H A1',
    'A1',
    true,
    md5('phase-13h-teacher-certifier')::uuid
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    md5('phase-13h-workspace')::uuid,
    md5('phase-13h-batch-a2')::uuid,
    md5('phase-13h-student-sole')::uuid
  ),
  (
    md5('phase-13h-workspace')::uuid,
    md5('phase-13h-batch-a1')::uuid,
    md5('phase-13h-student-alternate')::uuid
  ),
  (
    md5('phase-13h-workspace')::uuid,
    md5('phase-13h-batch-a1')::uuid,
    md5('phase-13h-student-opt-in')::uuid
  );

insert into app_private.grammar_topic_contracts (slug, display_name)
values
  ('phase-13h-sole-release', 'Phase 13H Sole Release'),
  ('phase-13h-alternate-release', 'Phase 13H Alternate Release'),
  ('phase-13h-teacher-opt-in', 'Phase 13H Teacher Opt-in');

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    md5('phase-13h-topic-sole')::uuid,
    'phase-13h-sole-release',
    'Phase 13H Sole Release',
    'A1_A2',
    'A2 context unlocked by exactly one qualified release.'
  ),
  (
    md5('phase-13h-topic-alternate')::uuid,
    'phase-13h-alternate-release',
    'Phase 13H Alternate Release',
    'A1_A2',
    'A1 context with a surviving alternate release.'
  ),
  (
    md5('phase-13h-topic-opt-in')::uuid,
    'phase-13h-teacher-opt-in',
    'Phase 13H Teacher Opt-in',
    'A1_A2',
    'A1 context unlocked only by explicit teacher opt-in.'
  );

insert into app_private.practice_topic_level_assignment_gates (
  grammar_topic_id,
  worksheet_level,
  reason_code,
  rationale
)
values
  (
    md5('phase-13h-topic-sole')::uuid,
    'A2',
    'level_fit_approval_required',
    'Phase 13H requires an exact A2 release or explicit teacher approval.'
  ),
  (
    md5('phase-13h-topic-alternate')::uuid,
    'A1',
    'level_fit_approval_required',
    'Phase 13H requires an exact A1 release or explicit teacher approval.'
  ),
  (
    md5('phase-13h-topic-opt-in')::uuid,
    'A1',
    'level_fit_approval_required',
    'Phase 13H keeps this exact A1 context behind teacher approval.'
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
    md5('phase-13h-teacher-certifier')::uuid,
    'Qualified German-language worksheet reviewer',
    true,
    false,
    md5('phase-13h-teacher-certifier')::uuid
  ),
  (
    md5('phase-13h-releaser')::uuid,
    'Qualified educational worksheet release controller',
    false,
    true,
    md5('phase-13h-teacher-certifier')::uuid
  );

create temporary table phase_13h_state (
  sole_revision_id uuid,
  sole_revision_number integer,
  sole_content_sha256 text,
  sole_replacement_revision_id uuid,
  sole_initial_clone_id uuid,
  sole_retry_job_id uuid,
  sole_retry_status text,
  sole_workspace_quota_before integer not null default 0,
  sole_student_quota_before integer not null default 0,
  sole_job_count_before bigint not null default 0,
  sole_spend_count_before bigint not null default 0,
  alternate_primary_revision_id uuid,
  alternate_primary_revision_number integer,
  alternate_primary_content_sha256 text,
  alternate_initial_clone_id uuid,
  alternate_survivor_revision_id uuid,
  alternate_replacement_clone_id uuid,
  alternate_retry_job_id uuid,
  alternate_retry_status text,
  alternate_workspace_quota_before integer not null default 0,
  alternate_student_quota_before integer not null default 0,
  opt_in_assignment_id uuid,
  opt_in_job_id uuid,
  opt_in_generation_status text
) on commit drop;

insert into phase_13h_state default values;
grant select, update on phase_13h_state to authenticated, service_role;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13h.a2.sole-release',
    pg_temp.phase_13h_worksheet_payload(
      'phase-13h-sole-release',
      'Phase 13H Sole Release',
      'A2',
      'A2 Sole Qualified Release'
    ),
    md5('phase-13h-teacher-certifier')::uuid,
    md5('phase-13h-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13H sole-release review.',
    'Qualified Phase 13H sole-release approval.'
  )
)
update phase_13h_state state
set sole_revision_id = published.revision_id,
    sole_content_sha256 = published.content_sha256
from published;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13h.a1.alternate-release',
    pg_temp.phase_13h_worksheet_payload(
      'phase-13h-alternate-release',
      'Phase 13H Alternate Release',
      'A1',
      'A1 Primary Qualified Release'
    ),
    md5('phase-13h-teacher-certifier')::uuid,
    md5('phase-13h-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13H primary alternate-path review.',
    'Qualified Phase 13H primary alternate-path approval.'
  )
)
update phase_13h_state state
set alternate_primary_revision_id = published.revision_id,
    alternate_primary_content_sha256 = published.content_sha256
from published;

update phase_13h_state state
set
  sole_revision_number = sole_revision.revision_number,
  alternate_primary_revision_number = alternate_revision.revision_number
from app_private.practice_worksheet_template_revisions sole_revision,
     app_private.practice_worksheet_template_revisions alternate_revision
where sole_revision.id = state.sole_revision_id
  and alternate_revision.id = state.alternate_primary_revision_id;

select ok(
  (
    select count(*) = 1
    from app_private.practice_worksheet_template_revisions revision
    join app_private.practice_worksheet_templates template
      on template.id = revision.template_id
    where template.grammar_topic_id = md5('phase-13h-topic-sole')::uuid
      and template.level = 'A2'
      and revision.state = 'released'
  )
    and app_private.practice_topic_level_gate_satisfied(
      md5('phase-13h-topic-sole')::uuid,
      'A2',
      null
    )
    and app_private.practice_topic_level_gate_satisfied(
      md5('phase-13h-topic-alternate')::uuid,
      'A1',
      null
    )
    and not app_private.practice_topic_level_gate_satisfied(
      md5('phase-13h-topic-opt-in')::uuid,
      'A1',
      null
    ),
  'isolated A1/A2 gates start with one release, one alternate-path release, and no opt-in release'
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
values (
  md5('phase-13h-opt-in-submission')::uuid,
  md5('phase-13h-workspace')::uuid,
  md5('phase-13h-student-opt-in')::uuid,
  md5('phase-13h-batch-a1')::uuid,
  'free_text',
  'free_text',
  'Phase 13H evidence.',
  'Phase 13H evidence.',
  'Restricted topic evidence.',
  'A1',
  'checked',
  'immediate',
  'ready',
  'released',
  now()
);

-- Keep the fixture deterministic: the real evidence-capture path is covered
-- elsewhere, while this regression needs the evidence present before it opens
-- its exact, named opt-in cycle.
set local session_replication_role = replica;

insert into app_private.practice_weakness_evidence (
  source_kind,
  source_release_id,
  submission_id,
  workspace_id,
  student_id,
  grammar_topic_id,
  minor_issue_count,
  major_issue_count,
  released_at
)
values (
  'legacy_release',
  md5('phase-13h-opt-in-evidence')::uuid,
  md5('phase-13h-opt-in-submission')::uuid,
  md5('phase-13h-workspace')::uuid,
  md5('phase-13h-student-opt-in')::uuid,
  md5('phase-13h-topic-opt-in')::uuid,
  0,
  1,
  now()
);

set local session_replication_role = origin;

-- These named cycles are the focused cross-migration fixture. Preserve their
-- already-verified class snapshot exactly; ordinary writing-snapshot capture
-- is covered by the Phase 12K/13D suites.
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
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity
)
select
  fixture.cycle_id,
  md5('phase-13h-workspace')::uuid,
  fixture.student_id,
  fixture.grammar_topic_id,
  1,
  'unlocked',
  'weakness_threshold_reached',
  fixture.evidence_start_sequence,
  fixture.evidence_through_sequence,
  0,
  1,
  fixture.batch_id,
  fixture.worksheet_level,
  1,
  'teacher_verified'
from (
  values
    (
      md5('phase-13h-cycle-sole')::uuid,
      md5('phase-13h-student-sole')::uuid,
      md5('phase-13h-topic-sole')::uuid,
      md5('phase-13h-batch-a2')::uuid,
      'A2'::text,
      1::bigint,
      1::bigint
    ),
    (
      md5('phase-13h-cycle-alternate')::uuid,
      md5('phase-13h-student-alternate')::uuid,
      md5('phase-13h-topic-alternate')::uuid,
      md5('phase-13h-batch-a1')::uuid,
      'A1'::text,
      1::bigint,
      1::bigint
    ),
    (
      md5('phase-13h-cycle-opt-in')::uuid,
      md5('phase-13h-student-opt-in')::uuid,
      md5('phase-13h-topic-opt-in')::uuid,
      md5('phase-13h-batch-a1')::uuid,
      'A1'::text,
      (
        select evidence.evidence_sequence
        from app_private.practice_weakness_evidence evidence
        where evidence.source_release_id = md5('phase-13h-opt-in-evidence')::uuid
      ),
      (
        select evidence.evidence_sequence
        from app_private.practice_weakness_evidence evidence
        where evidence.source_release_id = md5('phase-13h-opt-in-evidence')::uuid
      )
    )
) as fixture(
  cycle_id,
  student_id,
  grammar_topic_id,
  batch_id,
  worksheet_level,
  evidence_start_sequence,
  evidence_through_sequence
);

set local session_replication_role = origin;

-- Exercise the live gate after restoring triggers. With no release or opt-in,
-- the opt-in-only context must be rewritten to the locked state.
update app_private.practice_resolution_cycles cycle
set
  state = 'unlocked',
  state_reason = 'weakness_threshold_reached'
where cycle.id = md5('phase-13h-cycle-opt-in')::uuid;

select results_eq(
  $$
    select cycle.id, cycle.state, cycle.state_reason
    from app_private.practice_resolution_cycles cycle
    where cycle.id in (
      md5('phase-13h-cycle-sole')::uuid,
      md5('phase-13h-cycle-alternate')::uuid,
      md5('phase-13h-cycle-opt-in')::uuid
    )
    order by cycle.id
  $$,
  $$
    values
      (
        md5('phase-13h-cycle-alternate')::uuid,
        'unlocked'::text,
        'weakness_threshold_reached'::text
      ),
      (
        md5('phase-13h-cycle-opt-in')::uuid,
        'locked'::text,
        'level_fit_approval_required'::text
      ),
      (
        md5('phase-13h-cycle-sole')::uuid,
        'unlocked'::text,
        'weakness_threshold_reached'::text
      )
    order by 1
  $$,
  'qualified releases unlock only their exact contexts while the opt-in-only cycle stays gated'
);

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
  fixture.assignment_id,
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
from (
  values
    (
      md5('phase-13h-assignment-sole')::uuid,
      md5('phase-13h-cycle-sole')::uuid
    ),
    (
      md5('phase-13h-assignment-alternate')::uuid,
      md5('phase-13h-cycle-alternate')::uuid
    )
) as fixture(assignment_id, cycle_id)
join app_private.practice_resolution_cycles cycle on cycle.id = fixture.cycle_id;

update app_private.practice_resolution_cycles cycle
set
  active_assignment_id = fixture.assignment_id,
  evidence_frozen_at = now(),
  state_reason = 'worksheet_ready'
from (
  values
    (
      md5('phase-13h-cycle-sole')::uuid,
      md5('phase-13h-assignment-sole')::uuid
    ),
    (
      md5('phase-13h-cycle-alternate')::uuid,
      md5('phase-13h-assignment-alternate')::uuid
    )
) as fixture(cycle_id, assignment_id)
where cycle.id = fixture.cycle_id;

select ok(
  (
    select count(*) = 2
    from public.student_practice_assignments assignment
    join app_private.practice_resolution_cycles cycle
      on cycle.id = assignment.resolution_cycle_id
     and cycle.active_assignment_id = assignment.id
    where assignment.id in (
      md5('phase-13h-assignment-sole')::uuid,
      md5('phase-13h-assignment-alternate')::uuid
    )
      and assignment.source = 'weakness_auto'
      and assignment.status = 'unlocked'
  ),
  'both release-qualified restricted cycles accept exactly one active automatic assignment'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13h-student-sole')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13h-student-sole')::uuid::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select *
from api.request_practice_worksheet(
  md5('phase-13h-assignment-sole')::uuid
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13h-student-alternate')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13h-student-alternate')::uuid::text,
  true
);
set local role authenticated;

select *
from api.request_practice_worksheet(
  md5('phase-13h-assignment-alternate')::uuid
);

reset role;

update phase_13h_state state
set
  sole_initial_clone_id = sole_assignment.practice_test_id,
  alternate_initial_clone_id = alternate_assignment.practice_test_id,
  sole_workspace_quota_before = coalesce((
    select usage.generation_job_count
    from app_private.ai_workspace_daily_usage usage
    where usage.workspace_id = md5('phase-13h-workspace')::uuid
      and usage.usage_day = (now() at time zone 'UTC')::date
  ), 0),
  sole_student_quota_before = coalesce((
    select usage.generation_job_count
    from app_private.ai_student_daily_usage usage
    where usage.workspace_id = md5('phase-13h-workspace')::uuid
      and usage.student_id = md5('phase-13h-student-sole')::uuid
      and usage.usage_day = (now() at time zone 'UTC')::date
  ), 0),
  sole_job_count_before = (
    select count(*)
    from app_private.async_jobs job
    where job.entity_id = md5('phase-13h-assignment-sole')::uuid
  ),
  sole_spend_count_before = (
    select count(*)
    from app_private.ai_spend_reservations reservation
    join app_private.async_jobs job on job.id = reservation.job_id
    where job.entity_id = md5('phase-13h-assignment-sole')::uuid
  )
from public.student_practice_assignments sole_assignment,
     public.student_practice_assignments alternate_assignment
where sole_assignment.id = md5('phase-13h-assignment-sole')::uuid
  and alternate_assignment.id = md5('phase-13h-assignment-alternate')::uuid;

select ok(
  exists (
    select 1
    from phase_13h_state state
    join public.practice_tests sole_clone on sole_clone.id = state.sole_initial_clone_id
    join public.practice_tests alternate_clone
      on alternate_clone.id = state.alternate_initial_clone_id
    where sole_clone.worksheet_template_revision_id = state.sole_revision_id
      and alternate_clone.worksheet_template_revision_id =
        state.alternate_primary_revision_id
  )
    and not exists (
      select 1
      from app_private.async_jobs job
      where job.entity_id in (
        md5('phase-13h-assignment-sole')::uuid,
        md5('phase-13h-assignment-alternate')::uuid
      )
    ),
  'both students receive their initially qualified bank worksheet synchronously without AI work'
);

-- The launch invariant no longer permits withdrawing the final released
-- worksheet for a canonical topic/level. Publish a qualified exact-context
-- replacement before exercising the downstream gate-closure behavior. The
-- reviewer is then revoked independently, which keeps this regression focused
-- on the existing fail-closed gate without violating bank availability at the
-- moment of withdrawal.
with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13h.a2.sole-release-replacement',
    pg_temp.phase_13h_worksheet_payload(
      'phase-13h-sole-release',
      'Phase 13H Sole Release',
      'A2',
      'A2 Qualified Coverage Replacement'
    ),
    md5('phase-13h-teacher-certifier')::uuid,
    md5('phase-13h-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13H coverage-replacement review.',
    'Qualified Phase 13H coverage-replacement approval.'
  )
)
update pg_temp.phase_13h_state state
set sole_replacement_revision_id = published.revision_id
from published;

select *
from app_private.withdraw_released_worksheet_template(
  (select sole_revision_id from phase_13h_state),
  (select sole_revision_number from phase_13h_state),
  (select sole_content_sha256 from phase_13h_state),
  md5('phase-13h-releaser')::uuid,
  'Phase 13H withdraws one release after a qualified replacement exists.'
);

-- Simulate a legacy damaged coverage state so the downstream low-CEFR gate
-- remains regression-tested; normal reviewer updates cannot create it.
alter table app_private.practice_worksheet_bank_reviewers
disable trigger practice_worksheet_bank_reviewers_guard_coverage;
update app_private.practice_worksheet_bank_reviewers reviewer
set active = false
where reviewer.user_id = md5('phase-13h-teacher-certifier')::uuid;
alter table app_private.practice_worksheet_bank_reviewers
enable trigger practice_worksheet_bank_reviewers_guard_coverage;

select ok(
  not app_private.practice_topic_level_gate_satisfied(
    md5('phase-13h-topic-sole')::uuid,
    'A2',
    md5('phase-13h-cycle-sole')::uuid
  ),
  'revoking the replacement certifier closes the exact A2 gate after safe withdrawal'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13h-student-sole')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13h-student-sole')::uuid::text,
  true
);
set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    md5('phase-13h-assignment-sole')::uuid
  )
)
update pg_temp.phase_13h_state state
set sole_retry_job_id = requested.job_id,
    sole_retry_status = requested.generation_status
from requested;

reset role;

select ok(
  (
    select state.sole_retry_job_id is null
      and state.sole_retry_status = 'needs_review'
    from phase_13h_state state
  ),
  'requesting after qualified coverage is revoked returns a safe synchronous hold and no job'
);

select results_eq(
  $$
    select
      assignment.status,
      assignment.practice_test_id,
      assignment.generation_status,
      assignment.generation_error
    from public.student_practice_assignments assignment
    where assignment.id = md5('phase-13h-assignment-sole')::uuid
  $$,
  $$
    values (
      'cancelled'::text,
      null::uuid,
      'needs_review'::text,
      'level_fit_approval_required'::text
    )
  $$,
  'the untouched withdrawn assignment is cancelled, detached, and marked for level-fit review'
);

select results_eq(
  $$
    select job.previous_status, job.target_status, job.processed_at is null
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.assignment_id = md5('phase-13h-assignment-sole')::uuid
    order by job.transition_sequence
  $$,
  $$ values ('unlocked'::text, 'cancelled'::text, true) $$,
  'the cancellation appends exactly one pending durable cycle-transition job'
);

select ok(
  (
    select count(*)
    from app_private.async_jobs job
    where job.entity_id = md5('phase-13h-assignment-sole')::uuid
  ) = (select sole_job_count_before from phase_13h_state)
    and (
      select coalesce((
        select usage.generation_job_count
        from app_private.ai_workspace_daily_usage usage
        where usage.workspace_id = md5('phase-13h-workspace')::uuid
          and usage.usage_day = (now() at time zone 'UTC')::date
      ), 0) = state.sole_workspace_quota_before
        and coalesce((
          select usage.generation_job_count
          from app_private.ai_student_daily_usage usage
          where usage.workspace_id = md5('phase-13h-workspace')::uuid
            and usage.student_id = md5('phase-13h-student-sole')::uuid
            and usage.usage_day = (now() at time zone 'UTC')::date
        ), 0) = state.sole_student_quota_before
      from phase_13h_state state
    )
    and (
      select count(*)
      from app_private.ai_spend_reservations reservation
      join app_private.async_jobs job on job.id = reservation.job_id
      where job.entity_id = md5('phase-13h-assignment-sole')::uuid
    ) = (select sole_spend_count_before from phase_13h_state),
  'the closed withdrawal gate creates zero async jobs, paid quota, or AI spend'
);

select results_eq(
  $$
    select cycle.state, cycle.state_reason, cycle.active_assignment_id
    from app_private.practice_resolution_cycles cycle
    where cycle.id = md5('phase-13h-cycle-sole')::uuid
  $$,
  $$
    values (
      'unlocked'::text,
      'worksheet_ready'::text,
      md5('phase-13h-assignment-sole')::uuid
    )
  $$,
  'the browser request commits only the assignment hold; cycle mutation waits for recovery'
);

set local role service_role;
select set_config(
  'phase_13h.transition_result',
  api.process_practice_cycle_transition_jobs(10)::text,
  true
);
reset role;

select ok(
  (current_setting('phase_13h.transition_result')::jsonb ->> 'succeeded')::integer = 1
    and (current_setting('phase_13h.transition_result')::jsonb ->> 'failed')::integer = 0,
  'the recovery processor settles the deferred cancellation exactly once'
);

select results_eq(
  $$
    select cycle.state, cycle.state_reason, cycle.active_assignment_id
    from app_private.practice_resolution_cycles cycle
    where cycle.id = md5('phase-13h-cycle-sole')::uuid
  $$,
  $$
    values (
      'locked'::text,
      'level_fit_approval_required'::text,
      null::uuid
    )
  $$,
  'after outbox processing the cycle is locked behind the exact level-fit gate'
);

select results_eq(
  $$
    select event.event_type, event.to_state, event.details ->> 'stored_state_reason'
    from app_private.practice_resolution_cycle_events event
    where event.assignment_id = md5('phase-13h-assignment-sole')::uuid
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
  'the immutable cycle event records the fail-closed withdrawal transition'
);

update app_private.practice_worksheet_bank_reviewers reviewer
set active = true
where reviewer.user_id = md5('phase-13h-teacher-certifier')::uuid;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13h.a1.alternate-release',
    pg_temp.phase_13h_worksheet_payload(
      'phase-13h-alternate-release',
      'Phase 13H Alternate Release',
      'A1',
      'A1 Surviving Qualified Release'
    ),
    md5('phase-13h-teacher-certifier')::uuid,
    md5('phase-13h-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13H surviving alternate review.',
    'Qualified Phase 13H surviving alternate approval.'
  )
)
update phase_13h_state state
set alternate_survivor_revision_id = published.revision_id
from published;

select *
from app_private.withdraw_released_worksheet_template(
  (select alternate_primary_revision_id from phase_13h_state),
  (select alternate_primary_revision_number from phase_13h_state),
  (select alternate_primary_content_sha256 from phase_13h_state),
  md5('phase-13h-releaser')::uuid,
  'Phase 13H withdraws the attached revision while a qualified alternate survives.'
);

update phase_13h_state state
set
  alternate_workspace_quota_before = coalesce((
    select usage.generation_job_count
    from app_private.ai_workspace_daily_usage usage
    where usage.workspace_id = md5('phase-13h-workspace')::uuid
      and usage.usage_day = (now() at time zone 'UTC')::date
  ), 0),
  alternate_student_quota_before = coalesce((
    select usage.generation_job_count
    from app_private.ai_student_daily_usage usage
    where usage.workspace_id = md5('phase-13h-workspace')::uuid
      and usage.student_id = md5('phase-13h-student-alternate')::uuid
      and usage.usage_day = (now() at time zone 'UTC')::date
  ), 0);

select ok(
  app_private.practice_topic_level_gate_satisfied(
    md5('phase-13h-topic-alternate')::uuid,
    'A1',
    md5('phase-13h-cycle-alternate')::uuid
  ),
  'withdrawing one revision leaves the exact A1 gate open while a qualified alternate survives'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13h-student-alternate')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13h-student-alternate')::uuid::text,
  true
);
set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    md5('phase-13h-assignment-alternate')::uuid
  )
)
update pg_temp.phase_13h_state state
set alternate_retry_job_id = requested.job_id,
    alternate_retry_status = requested.generation_status
from requested;

reset role;

update phase_13h_state state
set alternate_replacement_clone_id = assignment.practice_test_id
from public.student_practice_assignments assignment
where assignment.id = md5('phase-13h-assignment-alternate')::uuid;

select ok(
  exists (
    select 1
    from phase_13h_state state
    join public.student_practice_assignments assignment
      on assignment.id = md5('phase-13h-assignment-alternate')::uuid
    join public.practice_tests replacement
      on replacement.id = state.alternate_replacement_clone_id
    where state.alternate_retry_job_id is null
      and state.alternate_retry_status = 'ready'
      and assignment.status = 'unlocked'
      and assignment.generation_status = 'ready'
      and state.alternate_replacement_clone_id <>
        state.alternate_initial_clone_id
      and replacement.worksheet_template_revision_id =
        state.alternate_survivor_revision_id
  ),
  'the surviving qualified revision replaces the withdrawn clone synchronously'
);

select ok(
  not exists (
    select 1
    from app_private.async_jobs job
    where job.entity_id = md5('phase-13h-assignment-alternate')::uuid
  )
    and (
      select coalesce((
        select usage.generation_job_count
        from app_private.ai_workspace_daily_usage usage
        where usage.workspace_id = md5('phase-13h-workspace')::uuid
          and usage.usage_day = (now() at time zone 'UTC')::date
      ), 0) = state.alternate_workspace_quota_before
        and coalesce((
          select usage.generation_job_count
          from app_private.ai_student_daily_usage usage
          where usage.workspace_id = md5('phase-13h-workspace')::uuid
            and usage.student_id = md5('phase-13h-student-alternate')::uuid
            and usage.usage_day = (now() at time zone 'UTC')::date
        ), 0) = state.alternate_student_quota_before
      from phase_13h_state state
    )
    and not exists (
      select 1
      from app_private.ai_spend_reservations reservation
      join app_private.async_jobs job on job.id = reservation.job_id
      where job.entity_id = md5('phase-13h-assignment-alternate')::uuid
    ),
  'the surviving-revision replacement also consumes no async job, paid quota, or AI spend'
);

select ok(
  exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    where cycle.id = md5('phase-13h-cycle-alternate')::uuid
      and cycle.state = 'unlocked'
      and cycle.state_reason = 'worksheet_ready'
      and cycle.active_assignment_id =
        md5('phase-13h-assignment-alternate')::uuid
  )
    and not exists (
      select 1
      from app_private.practice_assignment_cycle_transition_jobs job
      where job.assignment_id = md5('phase-13h-assignment-alternate')::uuid
    ),
  'replacement by a surviving revision leaves the active cycle and assignment status unchanged'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13h-teacher-certifier')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13h-teacher-certifier')::uuid::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with approved as (
  select api.opt_in_restricted_practice(
    md5('phase-13h-cycle-opt-in')::uuid,
    'Phase 13H teacher confirms this restricted A1 practice is appropriate.'
  ) as result
)
update pg_temp.phase_13h_state state
set opt_in_assignment_id = (approved.result ->> 'assignment_id')::uuid
from approved;

reset role;

select ok(
  exists (
    select 1
    from phase_13h_state state
    join app_private.practice_resolution_cycles cycle
      on cycle.id = md5('phase-13h-cycle-opt-in')::uuid
    join public.student_practice_assignments assignment
      on assignment.id = state.opt_in_assignment_id
     and assignment.resolution_cycle_id = cycle.id
    join app_private.practice_level_fit_opt_ins opt_in
      on opt_in.cycle_id = cycle.id
    where cycle.state = 'unlocked'
      and cycle.state_reason = 'worksheet_ready'
      and cycle.active_assignment_id = assignment.id
      and assignment.status = 'unlocked'
      and assignment.source = 'weakness_auto'
      and opt_in.actor_id = md5('phase-13h-teacher-certifier')::uuid
  ),
  'an exact teacher opt-in still creates one audited automatic assignment for the restricted cycle'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13h-student-opt-in')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13h-student-opt-in')::uuid::text,
  true
);
set local role authenticated;

with requested as (
  select requested.*
  from pg_temp.phase_13h_state state
  cross join lateral api.request_practice_worksheet(
    state.opt_in_assignment_id
  ) requested
)
update pg_temp.phase_13h_state state
set opt_in_job_id = requested.job_id,
    opt_in_generation_status = requested.generation_status
from requested;

reset role;

select ok(
  exists (
    select 1
    from phase_13h_state state
    join app_private.async_jobs job on job.id = state.opt_in_job_id
    join public.student_practice_assignments assignment
      on assignment.id = state.opt_in_assignment_id
    where state.opt_in_generation_status = 'queued'
      and assignment.generation_status = 'queued'
      and job.job_kind = 'worksheet_generation'
      and job.entity_id = assignment.id
      and job.status = 'queued'
      and job.queue_message_id is not null
  ),
  'after explicit teacher approval the no-bank path remains allowed to queue durable AI generation'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select ok(
  exists (
    select 1
    from phase_13h_state state
    cross join lateral api.get_worksheet_generation_context(
      state.opt_in_assignment_id
    ) context
    where context.assignment_id = state.opt_in_assignment_id
      and context.assignment_status = 'unlocked'
      and context.attached_practice_test_id is null
      and context.certified_template_revision_id is null
  ),
  'the service worker receives the exact teacher-opted-in no-bank provider context'
);

select ok(
  exists (
    select 1
    from pg_temp.phase_13h_state state
    cross join lateral api.get_worksheet_generation_context(
      md5('phase-13h-assignment-sole')::uuid
    ) context
    where context.assignment_id = md5('phase-13h-assignment-sole')::uuid
      and context.attached_practice_test_id is null
      and context.certified_template_revision_id =
        state.sole_replacement_revision_id
  ),
  'the worker sees only the qualified replacement bank revision after coverage returns'
);

reset role;

select ok(
  has_function_privilege(
    'service_role',
    'api.get_worksheet_generation_context(uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.get_worksheet_generation_context(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'app_private.get_worksheet_generation_context_phase_13g(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.get_worksheet_generation_context_phase_13g(uuid)',
      'EXECUTE'
    )
    and (
      select private_helper.prosecdef and not api_facade.prosecdef
      from pg_proc private_helper
      cross join pg_proc api_facade
      where private_helper.oid =
        'app_private.get_worksheet_generation_context_phase_13g(uuid)'::regprocedure
        and api_facade.oid =
          'api.get_worksheet_generation_context(uuid)'::regprocedure
    ),
  'worker context keeps a sealed private definer behind a service-only invoker facade'
);

select * from finish();
rollback;
