begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

select ok(
  (
    select routine.prosecdef
      and position(
        'lock_active_practice_class_context'
        in lower(pg_get_functiondef(routine.oid))
      ) > 0
      and position(
        'selected_active_assignment.status in (''passed'', ''failed'', ''cancelled'')'
        in lower(pg_get_functiondef(routine.oid))
      ) > position(
        'lock_active_practice_class_context'
        in lower(pg_get_functiondef(routine.oid))
      )
      and position(
        'selected_active_assignment.status_revision > 0'
        in lower(pg_get_functiondef(routine.oid))
      ) > 0
      and position(
        'ensure_practice_cycle_assignment_core_internal'
        in lower(pg_get_functiondef(routine.oid))
      ) > position(
        'selected_active_assignment.status_revision > 0'
        in lower(pg_get_functiondef(routine.oid))
      )
    from pg_proc routine
    where routine.oid =
      'app_private.ensure_practice_cycle_assignment_internal(uuid)'::regprocedure
  ),
  'the private selector locks current class context and defers terminal revisions before replacement selection'
);

select ok(
  not has_function_privilege(
    'anon',
    'app_private.ensure_practice_cycle_assignment_internal(uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.ensure_practice_cycle_assignment_internal(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.ensure_practice_cycle_assignment_internal(uuid)',
      'EXECUTE'
    ),
  'the hardened selector remains private behind the established definer call chain'
);

select ok(
  (
    select position('pg_advisory_xact_lock' in lower(pg_get_functiondef(routine.oid))) > 0
      and position(
        'assignment_snapshot.status not in (''passed'', ''failed'', ''cancelled'')'
        in lower(pg_get_functiondef(routine.oid))
      ) > 0
      and position(
        'assignment_snapshot.status not in (''passed'', ''failed'', ''cancelled'')'
        in lower(pg_get_functiondef(routine.oid))
      ) < position('pg_advisory_xact_lock' in lower(pg_get_functiondef(routine.oid)))
      and position(
        'practice_class_context_resolution_pending'
        in lower(pg_get_functiondef(routine.oid))
      ) > position('pg_advisory_xact_lock' in lower(pg_get_functiondef(routine.oid)))
      and position(
        'practice_class_context_resolution_pending'
        in lower(pg_get_functiondef(routine.oid))
      ) < position('for update' in lower(pg_get_functiondef(routine.oid)))
      and position(
        'cycle.active_assignment_id is distinct from assignment_snapshot.id'
        in lower(pg_get_functiondef(routine.oid))
      ) > 0
      and position(
        'current_assignment.class_context_version = 0'
        in lower(pg_get_functiondef(routine.oid))
      ) > 0
      and position('pg_advisory_xact_lock' in lower(pg_get_functiondef(routine.oid)))
        < position('for update' in lower(pg_get_functiondef(routine.oid)))
      and position(
        'lock_active_practice_class_context'
        in lower(pg_get_functiondef(routine.oid))
      ) < position(
        'into selected_assignment'
        in lower(pg_get_functiondef(routine.oid))
      )
      and position(
        'practice_transition_pending'
        in lower(pg_get_functiondef(routine.oid))
      ) > 0
      and position(
        'selected_assignment.batch_id is distinct from assignment_snapshot.batch_id'
        in lower(pg_get_functiondef(routine.oid))
      ) > 0
      and position(
        'selected_assignment.worksheet_levelisdistinctfromassignment_snapshot.worksheet_level'
        in regexp_replace(
          lower(pg_get_functiondef(routine.oid)),
          '[[:space:]]+',
          '',
          'g'
        )
      ) > 0
      and position(
        'selected_assignment.class_context_versionisdistinctfromassignment_snapshot.class_context_version'
        in regexp_replace(
          lower(pg_get_functiondef(routine.oid)),
          '[[:space:]]+',
          '',
          'g'
        )
      ) > 0
      and position(
        'selected_assignment.class_context_integrityisdistinctfromassignment_snapshot.class_context_integrity'
        in regexp_replace(
          lower(pg_get_functiondef(routine.oid)),
          '[[:space:]]+',
          '',
          'g'
        )
      ) > 0
      and position(
        'practice_assignment_cycle_transition_jobs'
        in lower(pg_get_functiondef(routine.oid))
      ) = 0
    from pg_proc routine
    where routine.oid =
      'public.reassign_practice_assignment_internal(uuid,text,integer)'::regprocedure
  ),
  'teacher reassignment uses advisory-cycle-class-assignment order without an MVCC-unsafe job lookup'
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
    '00000000-0000-0000-0000-000000000000'::uuid,
    md5('phase-13j-teacher')::uuid,
    'authenticated',
    'authenticated',
    'phase-13j-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13J Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    md5('phase-13j-student')::uuid,
    'authenticated',
    'authenticated',
    'phase-13j-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13J Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  md5('phase-13j-workspace')::uuid,
  'Phase 13J Workspace',
  'phase-13j-terminal-transition-guard',
  md5('phase-13j-teacher')::uuid
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13j-teacher')::uuid::text,
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13j-workspace')::uuid,
  md5('phase-13j-teacher')::uuid,
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13j-workspace')::uuid,
  md5('phase-13j-student')::uuid,
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
  md5('phase-13j-batch')::uuid,
  md5('phase-13j-workspace')::uuid,
  'Phase 13J B2',
  'B2',
  md5('phase-13j-teacher')::uuid,
  true,
  true,
  true,
  'immediate',
  0,
  0
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  md5('phase-13j-workspace')::uuid,
  md5('phase-13j-batch')::uuid,
  md5('phase-13j-student')::uuid
);

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    md5('phase-13j-topic-pass')::uuid,
    'phase-13j-terminal-pass',
    'Phase 13J Terminal Pass',
    'B2',
    'A private outbox race fixture.'
  ),
  (
    md5('phase-13j-topic-fail')::uuid,
    'phase-13j-terminal-fail',
    'Phase 13J Terminal Fail',
    'B2',
    'A private outbox race fixture.'
  ),
  (
    md5('phase-13j-topic-cancel')::uuid,
    'phase-13j-terminal-cancel',
    'Phase 13J Terminal Cancel',
    'B2',
    'A private outbox race fixture.'
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
values (
  md5('phase-13j-pass-test')::uuid,
  md5('phase-13j-workspace')::uuid,
  md5('phase-13j-topic-pass')::uuid,
  'B2',
  'medium',
  'Phase 13J Pass Worksheet',
  'A transactional pass fixture.',
  false,
  true,
  'workspace',
  md5('phase-13j-teacher')::uuid,
  'manual_import',
  'approved'
);

-- Seed focused, verified cycle snapshots without invoking the writing evidence
-- pipeline already covered by Phase 12G/12K. All changes roll back.
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
  md5('phase-13j-cycle-' || fixture.kind)::uuid,
  md5('phase-13j-workspace')::uuid,
  md5('phase-13j-student')::uuid,
  md5('phase-13j-topic-' || fixture.kind)::uuid,
  1,
  'unlocked',
  'worksheet_ready',
  1,
  1,
  0,
  1,
  md5('phase-13j-batch')::uuid,
  'B2',
  1,
  'teacher_verified'
from (values ('pass'), ('fail'), ('cancel')) as fixture(kind);

set local session_replication_role = origin;

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
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
  md5('phase-13j-assignment-' || fixture.kind)::uuid,
  cycle.workspace_id,
  cycle.student_id,
  cycle.grammar_topic_id,
  case fixture.kind
    when 'pass' then md5('phase-13j-pass-test')::uuid
    else null
  end,
  'weakness_auto',
  'unlocked',
  case fixture.kind when 'pass' then 'ready' else 'idle' end,
  cycle.id,
  cycle.cycle_number,
  cycle.evidence_through_sequence,
  cycle.batch_id,
  cycle.worksheet_level,
  cycle.class_context_version,
  cycle.class_context_integrity
from (values ('pass'), ('fail'), ('cancel')) as fixture(kind)
join app_private.practice_resolution_cycles cycle
  on cycle.id = md5('phase-13j-cycle-' || fixture.kind)::uuid;

update app_private.practice_resolution_cycles cycle
set
  active_assignment_id = assignment.id,
  evidence_frozen_at = now()
from public.student_practice_assignments assignment
where assignment.resolution_cycle_id = cycle.id
  and cycle.workspace_id = md5('phase-13j-workspace')::uuid;

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
values (
  md5('phase-13j-pass-attempt')::uuid,
  md5('phase-13j-pass-test')::uuid,
  md5('phase-13j-student')::uuid,
  md5('phase-13j-workspace')::uuid,
  md5('phase-13j-assignment-pass')::uuid,
  '[]'::jsonb,
  1,
  1,
  1,
  1,
  100,
  true,
  'phase_13j_fixture',
  'not_needed',
  0,
  'checked',
  now(),
  now(),
  now()
);

update public.student_practice_assignments assignment
set
  latest_attempt_id = md5('phase-13j-pass-attempt')::uuid,
  status = 'passed',
  completed_at = now()
where assignment.id = md5('phase-13j-assignment-pass')::uuid;

update public.student_practice_assignments assignment
set status = 'failed', completed_at = now()
where assignment.id = md5('phase-13j-assignment-fail')::uuid;

update public.student_practice_assignments assignment
set status = 'cancelled', completed_at = now()
where assignment.id = md5('phase-13j-assignment-cancel')::uuid;

select results_eq(
  $$
    select
      right(topic.slug, length(topic.slug) - length('phase-13j-terminal-')),
      assignment.status,
      assignment.status_revision,
      job.target_status,
      job.processed_at is null
    from public.student_practice_assignments assignment
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    join app_private.practice_assignment_cycle_transition_jobs job
      on job.assignment_id = assignment.id
     and job.status_revision = assignment.status_revision
    where assignment.workspace_id = md5('phase-13j-workspace')::uuid
    order by topic.slug
  $$,
  $$
    values
      ('cancel'::text, 'cancelled'::text, 1::bigint, 'cancelled'::text, true),
      ('fail'::text, 'failed'::text, 1::bigint, 'failed'::text, true),
      ('pass'::text, 'passed'::text, 1::bigint, 'passed'::text, true)
  $$,
  'each terminal assignment has one current unprocessed authoritative transition'
);

select results_eq(
  $$
    select
      fixture.kind,
      app_private.ensure_practice_cycle_assignment_internal(
        md5('phase-13j-cycle-' || fixture.kind)::uuid
      )
    from (values ('cancel'), ('fail'), ('pass')) as fixture(kind)
  $$,
  $$
    values
      ('cancel'::text, md5('phase-13j-assignment-cancel')::uuid),
      ('fail'::text, md5('phase-13j-assignment-fail')::uuid),
      ('pass'::text, md5('phase-13j-assignment-pass')::uuid)
  $$,
  'reconciliation defers all three terminal revisions to the outbox owner'
);

select results_eq(
  $$
    select
      right(topic.slug, length(topic.slug) - length('phase-13j-terminal-')),
      count(assignment.id)::bigint,
      count(assignment.id) filter (
        where assignment.status in ('unlocked', 'in_progress', 'completed')
      )::bigint,
      bool_and(cycle.active_assignment_id = assignment.id)
    from app_private.practice_resolution_cycles cycle
    join public.grammar_topics topic on topic.id = cycle.grammar_topic_id
    join public.student_practice_assignments assignment
      on assignment.resolution_cycle_id = cycle.id
    where cycle.workspace_id = md5('phase-13j-workspace')::uuid
    group by topic.slug
    order by topic.slug
  $$,
  $$
    values
      ('cancel'::text, 1::bigint, 0::bigint, true),
      ('fail'::text, 1::bigint, 0::bigint, true),
      ('pass'::text, 1::bigint, 0::bigint, true)
  $$,
  'no synchronous terminal path creates a replacement in the old cycle'
);

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  source,
  status,
  assigned_by,
  completed_at,
  generation_status,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity
)
values (
  md5('phase-13j-historical-fail')::uuid,
  md5('phase-13j-workspace')::uuid,
  md5('phase-13j-student')::uuid,
  md5('phase-13j-topic-fail')::uuid,
  'manual',
  'failed',
  md5('phase-13j-teacher')::uuid,
  now() - interval '1 day',
  'idle',
  md5('phase-13j-batch')::uuid,
  'B2',
  1,
  'teacher_verified'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13j-teacher')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13j-teacher')::uuid::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.reassign_practice_assignment(
      md5('phase-13j-assignment-fail')::uuid,
      'Wait for the authoritative failed transition before reassignment.',
      0
    )
  $$,
  '55000',
  'practice_transition_pending',
  'teacher reassignment cannot bypass an unprocessed terminal transition'
);

select throws_ok(
  $$
    select api.reassign_practice_assignment(
      md5('phase-13j-historical-fail')::uuid,
      'An older failure cannot bypass the current authoritative transition.',
      0
    )
  $$,
  '55000',
  'practice_transition_pending',
  'historical reassignment cannot bypass a different current terminal transition'
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
    join app_private.practice_assignment_cycle_transition_jobs job
      on job.assignment_id = assignment.id
     and job.status_revision = assignment.status_revision
    where cycle.id = md5('phase-13j-cycle-fail')::uuid
      and assignment.id = md5('phase-13j-assignment-fail')::uuid
      and assignment.status = 'failed'
      and assignment.status_revision = 1
      and job.processed_at is null
  )
    and not exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.workspace_id = md5('phase-13j-workspace')::uuid
        and assignment.student_id = md5('phase-13j-student')::uuid
        and assignment.grammar_topic_id = md5('phase-13j-topic-fail')::uuid
        and assignment.status in ('unlocked', 'in_progress', 'completed')
    )
    and not exists (
      select 1
      from app_private.practice_teacher_actions action
      where action.assignment_id = md5('phase-13j-historical-fail')::uuid
    ),
  'a rejected historical command leaves the current transition authoritative and creates no replacement or audit action'
);

delete from public.student_practice_assignments assignment
where assignment.id = md5('phase-13j-historical-fail')::uuid;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select set_config(
  'phase_13j.transition_result',
  api.process_practice_cycle_transition_jobs(10)::text,
  true
);

reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.role', '', true);

select is(
  current_setting('phase_13j.transition_result')::jsonb,
  jsonb_build_object(
    'schema_version', 1,
    'attempted', 3,
    'succeeded', 3,
    'failed', 0,
    'deferred', 0,
    'exhausted', 0
  ),
  'one service tick applies pass, fail and cancellation without retries'
);

select is(
  (
    select count(*)::integer
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.workspace_id = md5('phase-13j-workspace')::uuid
      and job.processed_at is not null
      and job.failure_count = 0
      and job.last_error_code is null
  ),
  3,
  'all three authoritative terminal transitions settle successfully'
);

select results_eq(
  $$
    select
      cycle.state,
      cycle.state_reason,
      cycle.resolved_at is not null,
      cycle.active_assignment_id is null,
      count(assignment.id)::bigint
    from app_private.practice_resolution_cycles cycle
    left join public.student_practice_assignments assignment
      on assignment.resolution_cycle_id = cycle.id
    where cycle.id = md5('phase-13j-cycle-pass')::uuid
    group by cycle.state, cycle.state_reason, cycle.resolved_at,
      cycle.active_assignment_id
  $$,
  $$ values ('improving'::text, 'first_resolution_passed'::text, true, true, 1::bigint) $$,
  'a processed pass resolves the old cycle without manufacturing a replacement'
);

select results_eq(
  $$
    select
      right(topic.slug, length(topic.slug) - length('phase-13j-terminal-')),
      cycle.state,
      cycle.state_reason,
      count(assignment.id)::bigint,
      count(assignment.id) filter (
        where assignment.status in ('unlocked', 'in_progress', 'completed')
      )::bigint
    from app_private.practice_resolution_cycles cycle
    join public.grammar_topics topic on topic.id = cycle.grammar_topic_id
    join public.student_practice_assignments assignment
      on assignment.resolution_cycle_id = cycle.id
    where cycle.id in (
      md5('phase-13j-cycle-fail')::uuid,
      md5('phase-13j-cycle-cancel')::uuid
    )
    group by topic.slug, cycle.state, cycle.state_reason
    order by topic.slug
  $$,
  $$
    values
      ('cancel'::text, 'unlocked'::text, 'worksheet_ready'::text, 2::bigint, 1::bigint),
      ('fail'::text, 'unlocked'::text, 'worksheet_ready'::text, 2::bigint, 1::bigint)
  $$,
  'processed failure and cancellation each create exactly one replacement'
);

select ok(
  not exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    join public.student_practice_assignments assignment
      on assignment.id = cycle.active_assignment_id
    where cycle.id in (
      md5('phase-13j-cycle-fail')::uuid,
      md5('phase-13j-cycle-cancel')::uuid
    )
      and (
        assignment.batch_id is distinct from md5('phase-13j-batch')::uuid
        or assignment.worksheet_level is distinct from 'B2'
        or assignment.class_context_version is distinct from 1
        or assignment.class_context_integrity is distinct from 'teacher_verified'
        or assignment.source is distinct from 'adaptive_repeat'
        or assignment.previous_assignment_id is null
      )
  ),
  'worker-created replacements preserve the frozen active B2 class contract'
);

select is(
  (
    select count(*)::integer
    from public.student_practice_assignments assignment
    where assignment.workspace_id = md5('phase-13j-workspace')::uuid
      and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  2,
  'the three topics retain at most one active assignment and only unresolved topics remain active'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13j-teacher')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13j-teacher')::uuid::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select set_config(
  'phase_13j.reassignment_result',
  api.reassign_practice_assignment(
    md5('phase-13j-assignment-fail')::uuid,
    'Use the replacement created by the settled failed transition.',
    0
  )::text,
  true
);

reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select ok(
  (
    current_setting('phase_13j.reassignment_result')::jsonb
      ->> 'replacement_assignment_id'
  )::uuid = (
    select cycle.active_assignment_id
    from app_private.practice_resolution_cycles cycle
    where cycle.id = md5('phase-13j-cycle-fail')::uuid
  )
    and (
      current_setting('phase_13j.reassignment_result')::jsonb
        ->> 'action_revision'
    )::integer = 1
    and exists (
      select 1
      from app_private.practice_teacher_actions action
      where action.assignment_id = md5('phase-13j-assignment-fail')::uuid
        and action.action_revision = 1
        and action.action_type = 'assignment_reassigned'
        and action.related_assignment_id = (
          current_setting('phase_13j.reassignment_result')::jsonb
            ->> 'replacement_assignment_id'
        )::uuid
    ),
  'teacher reassignment reuses the one replacement after the worker settles'
);

-- A historical terminal target can coexist with a different untouched legacy
-- assignment that owns the current open cycle. Class-context recovery locks
-- that current assignment before updating its cycle, so reassignment must fail
-- before taking the inverse cycle -> current-assignment lock chain.
insert into public.grammar_topics (id, slug, name, level, description)
values (
  md5('phase-13j-topic-legacy-context')::uuid,
  'phase-13j-legacy-class-context',
  'Phase 13J Legacy Class Context',
  'B2',
  'A focused legacy class-context lock-order fixture.'
);

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
values (
  md5('phase-13j-cycle-legacy-context')::uuid,
  md5('phase-13j-workspace')::uuid,
  md5('phase-13j-student')::uuid,
  md5('phase-13j-topic-legacy-context')::uuid,
  1,
  'unlocked',
  'worksheet_ready',
  1,
  1,
  0,
  1,
  0,
  'legacy_unverified'
);

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
values (
  md5('phase-13j-assignment-legacy-current')::uuid,
  md5('phase-13j-workspace')::uuid,
  md5('phase-13j-student')::uuid,
  md5('phase-13j-topic-legacy-context')::uuid,
  'weakness_auto',
  'unlocked',
  'failed',
  'worksheet_class_context_required',
  md5('phase-13j-cycle-legacy-context')::uuid,
  1,
  1,
  0,
  'legacy_unverified'
), (
  md5('phase-13j-assignment-legacy-historical')::uuid,
  md5('phase-13j-workspace')::uuid,
  md5('phase-13j-student')::uuid,
  md5('phase-13j-topic-legacy-context')::uuid,
  'manual',
  'failed',
  'idle',
  null,
  null,
  null,
  null,
  0,
  'legacy_unverified'
);

update app_private.practice_resolution_cycles cycle
set
  active_assignment_id = md5('phase-13j-assignment-legacy-current')::uuid,
  evidence_frozen_at = now()
where cycle.id = md5('phase-13j-cycle-legacy-context')::uuid;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', md5('phase-13j-teacher')::uuid,
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13j-teacher')::uuid::text,
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.reassign_practice_assignment(
      md5('phase-13j-assignment-legacy-historical')::uuid,
      'Resolve the current legacy class context before historical reassignment.',
      0
    )
  $$,
  '55000',
  'practice_class_context_resolution_pending',
  'historical reassignment fails safely before a different current legacy assignment can invert class-recovery locks'
);

reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select ok(
  (
    select cycle.class_context_version = 0
      and cycle.class_context_integrity = 'legacy_unverified'
      and cycle.active_assignment_id =
        md5('phase-13j-assignment-legacy-current')::uuid
    from app_private.practice_resolution_cycles cycle
    where cycle.id = md5('phase-13j-cycle-legacy-context')::uuid
  )
    and (
      select count(*)
      from public.student_practice_assignments assignment
      where assignment.workspace_id = md5('phase-13j-workspace')::uuid
        and assignment.grammar_topic_id =
          md5('phase-13j-topic-legacy-context')::uuid
    ) = 2
    and not exists (
      select 1
      from app_private.practice_teacher_actions action
      where action.assignment_id =
        md5('phase-13j-assignment-legacy-historical')::uuid
    ),
  'the safe legacy-context rejection creates no replacement or teacher action and leaves the current owner unchanged'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select set_config(
  'phase_13j.idempotent_result',
  api.process_practice_cycle_transition_jobs(10)::text,
  true
);
reset role;
select set_config('request.jwt.claim.role', '', true);

select is(
  current_setting('phase_13j.idempotent_result')::jsonb,
  jsonb_build_object(
    'schema_version', 1,
    'attempted', 0,
    'succeeded', 0,
    'failed', 0,
    'deferred', 0,
    'exhausted', 0
  ),
  'a second service tick is idempotent'
);

select * from finish(true);
rollback;
