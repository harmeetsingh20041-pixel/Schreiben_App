begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(46);

select has_column(
  'public',
  'student_practice_assignments',
  'status_revision',
  'practice assignments carry a durable status revision'
);

select has_table(
  'app_private',
  'practice_assignment_cycle_transition_jobs',
  'the private practice transition outbox exists'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.student_practice_assignments'::regclass
      and trigger_row.tgname = 'student_practice_assignments_cycle_transition'
      and not trigger_row.tgisinternal
  )
  and position(
    'insert into app_private.practice_assignment_cycle_transition_jobs'
    in lower(pg_get_functiondef(
      'app_private.on_practice_assignment_cycle_transition()'::regprocedure
    ))
  ) > 0
  and position(
    'pg_advisory'
    in lower(pg_get_functiondef(
      'app_private.on_practice_assignment_cycle_transition()'::regprocedure
    ))
  ) = 0
  and position(
    'practice_resolution_cycles'
    in lower(pg_get_functiondef(
      'app_private.on_practice_assignment_cycle_transition()'::regprocedure
    ))
  ) = 0
  and not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.practice_assignment_cycle_transition_jobs'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confrelid in (
        'app_private.practice_resolution_cycles'::regclass,
        'public.practice_test_attempts'::regclass
      )
  ),
  'the assignment trigger and outbox append acquire no topic, cycle-parent, or attempt-parent lock'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.process_practice_cycle_transition_jobs(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api.process_practice_cycle_transition_jobs(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'api.process_practice_cycle_transition_jobs(integer)',
    'EXECUTE'
  )
  and not has_table_privilege(
    'service_role',
    'app_private.practice_assignment_cycle_transition_jobs',
    'SELECT'
  ),
  'only the service recovery facade can process transition jobs and the outbox remains private'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.reset_practice_cycle_transition_job(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api.reset_practice_cycle_transition_job(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'api.reset_practice_cycle_transition_job(uuid)',
    'EXECUTE'
  ),
  'only the service recovery facade can reset an exhausted transition job'
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
    md5('phase-13f-teacher')::uuid,
    'authenticated',
    'authenticated',
    'phase-13f-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13F Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000'::uuid,
    md5('phase-13f-student')::uuid,
    'authenticated',
    'authenticated',
    'phase-13f-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13F Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  md5('phase-13f-workspace')::uuid,
  'Phase 13F Workspace',
  'phase-13f-transition-outbox',
  md5('phase-13f-teacher')::uuid
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13f-teacher')::uuid::text,
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13f-workspace')::uuid,
  md5('phase-13f-teacher')::uuid,
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13f-workspace')::uuid,
  md5('phase-13f-student')::uuid,
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
  md5('phase-13f-batch')::uuid,
  md5('phase-13f-workspace')::uuid,
  'Phase 13F A1',
  'A1',
  md5('phase-13f-teacher')::uuid,
  true,
  true,
  true,
  'immediate',
  0,
  0
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  md5('phase-13f-workspace')::uuid,
  md5('phase-13f-batch')::uuid,
  md5('phase-13f-student')::uuid
);

-- This focused outbox fixture does not need to recreate the writing evidence
-- pipeline already covered by Phase 12K/13D. Seed its verified immutable class
-- snapshot directly while only the fixture INSERT triggers are disabled.
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
  md5('phase-13f-cycle')::uuid,
  md5('phase-13f-workspace')::uuid,
  md5('phase-13f-student')::uuid,
  topic.id,
  1,
  'unlocked',
  'worksheet_ready',
  1,
  0,
  0,
  0,
  md5('phase-13f-batch')::uuid,
  'A1',
  1,
  'teacher_verified'
from public.grammar_topics topic
where topic.slug = 'articles'
  and topic.level = 'A1_A2';

set local session_replication_role = origin;

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
  md5('phase-13f-assignment')::uuid,
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
from app_private.practice_resolution_cycles cycle
where cycle.id = md5('phase-13f-cycle')::uuid;

update app_private.practice_resolution_cycles cycle
set
  active_assignment_id = md5('phase-13f-assignment')::uuid,
  evidence_frozen_at = now()
where cycle.id = md5('phase-13f-cycle')::uuid;

select results_eq(
  $$
    select assignment.status_revision, count(job.id)::bigint
    from public.student_practice_assignments assignment
    left join app_private.practice_assignment_cycle_transition_jobs job
      on job.assignment_id = assignment.id
    where assignment.id = md5('phase-13f-assignment')::uuid
    group by assignment.status_revision
  $$,
  $$ values (0::bigint, 0::bigint) $$,
  'a new assignment starts at revision zero without a synthetic transition job'
);

update public.student_practice_assignments assignment
set status_revision = 999
where assignment.id = md5('phase-13f-assignment')::uuid;

select results_eq(
  $$
    select assignment.status_revision, count(job.id)::bigint
    from public.student_practice_assignments assignment
    left join app_private.practice_assignment_cycle_transition_jobs job
      on job.assignment_id = assignment.id
    where assignment.id = md5('phase-13f-assignment')::uuid
    group by assignment.status_revision
  $$,
  $$ values (0::bigint, 0::bigint) $$,
  'a same-status update cannot forge the server-managed status revision or append a job'
);

-- Two status commits happen before any recovery tick. The ordered outbox must
-- preserve both transitions instead of collapsing them to the latest state.
update public.student_practice_assignments assignment
set status = 'in_progress', started_at = now()
where assignment.id = md5('phase-13f-assignment')::uuid;

update public.student_practice_assignments assignment
set status = 'completed', completed_at = now()
where assignment.id = md5('phase-13f-assignment')::uuid;

select is(
  (
    select assignment.status_revision
    from public.student_practice_assignments assignment
    where assignment.id = md5('phase-13f-assignment')::uuid
  ),
  2::bigint,
  'each committed status change advances the assignment revision exactly once'
);

select results_eq(
  $$
    select
      job.status_revision,
      job.previous_status,
      job.target_status
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.assignment_id = md5('phase-13f-assignment')::uuid
    order by job.transition_sequence
  $$,
  $$
    values
      (1::bigint, 'unlocked'::text, 'in_progress'::text),
      (2::bigint, 'in_progress'::text, 'completed'::text)
  $$,
  'the rapid transition chain is preserved as two append-only revisioned jobs'
);

select ok(
  (
    select bool_and(job.transition_sequence > coalesce(prior.transition_sequence, 0))
    from app_private.practice_assignment_cycle_transition_jobs job
    left join app_private.practice_assignment_cycle_transition_jobs prior
      on prior.assignment_id = job.assignment_id
     and prior.status_revision = job.status_revision - 1
    where job.assignment_id = md5('phase-13f-assignment')::uuid
  ),
  'transition sequence ordering agrees with assignment revision ordering'
);

select results_eq(
  $$
    select cycle.state, cycle.state_reason, count(event.event_sequence)::bigint
    from app_private.practice_resolution_cycles cycle
    left join app_private.practice_resolution_cycle_events event
      on event.cycle_id = cycle.id
    where cycle.id = md5('phase-13f-cycle')::uuid
    group by cycle.state, cycle.state_reason
  $$,
  $$ values ('unlocked'::text, 'worksheet_ready'::text, 0::bigint) $$,
  'the append-only trigger does not mutate the cycle before service recovery runs'
);

set local role service_role;
select set_config(
  'phase_13f.max_zero',
  api.process_practice_cycle_transition_jobs(0)::text,
  true
);
reset role;

select is(
  current_setting('phase_13f.max_zero')::jsonb,
  jsonb_build_object(
    'schema_version', 1,
    'attempted', 0,
    'succeeded', 0,
    'failed', 0,
    'deferred', 0,
    'exhausted', 0
  ),
  'max_jobs zero is a true no-op with a stable recovery result'
);

select is(
  (
    select count(*)
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.assignment_id = md5('phase-13f-assignment')::uuid
      and job.processed_at is null
  ),
  2::bigint,
  'the max-jobs-zero tick leaves every queued transition untouched'
);

create or replace function pg_temp.phase_13f_reject_transition_event()
returns trigger
language plpgsql
as $$
begin
  if new.assignment_id = md5('phase-13f-assignment')::uuid then
    raise exception using
      errcode = '55000',
      message = 'phase_13f_poison_transition_event';
  end if;
  return new;
end;
$$;

create trigger phase_13f_reject_transition_event
before insert on app_private.practice_resolution_cycle_events
for each row execute function pg_temp.phase_13f_reject_transition_event();

set local role service_role;
select set_config(
  'phase_13f.failure_one',
  api.process_practice_cycle_transition_jobs(2)::text,
  true
);
reset role;

select is(
  current_setting('phase_13f.failure_one')::jsonb,
  jsonb_build_object(
    'schema_version', 1,
    'attempted', 1,
    'succeeded', 1,
    'failed', 0,
    'deferred', 0,
    'exhausted', 0
  ),
  'a superseded head transition settles without invoking poisoned cycle side effects'
);

select results_eq(
  $$
    select
      job.status_revision,
      job.failure_count,
      job.last_error_code,
      job.processed_at is null
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.assignment_id = md5('phase-13f-assignment')::uuid
    order by job.transition_sequence
  $$,
  $$
    values
      (1::bigint, 0, null::text, false),
      (2::bigint, 0, null::text, true)
  $$,
  'the stale head has no failure state and releases the current revision for the next tick'
);

set local role service_role;
select set_config(
  'phase_13f.current_failure_one',
  api.process_practice_cycle_transition_jobs(2)::text,
  true
);
reset role;

select is(
  current_setting('phase_13f.current_failure_one')::jsonb,
  jsonb_build_object(
    'schema_version', 1,
    'attempted', 1,
    'succeeded', 0,
    'failed', 1,
    'deferred', 0,
    'exhausted', 0
  ),
  'the poison applies only when the processor reaches the current revision'
);

update app_private.practice_assignment_cycle_transition_jobs job
set next_retry_at = now() - interval '1 second'
where job.assignment_id = md5('phase-13f-assignment')::uuid
  and job.status_revision = 2;

set local role service_role;
select api.process_practice_cycle_transition_jobs(2);
reset role;

update app_private.practice_assignment_cycle_transition_jobs job
set next_retry_at = now() - interval '1 second'
where job.assignment_id = md5('phase-13f-assignment')::uuid
  and job.status_revision = 2;

set local role service_role;
select set_config(
  'phase_13f.failure_three',
  api.process_practice_cycle_transition_jobs(2)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      job.status_revision,
      job.failure_count,
      job.last_error_code,
      job.processed_at is null
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.assignment_id = md5('phase-13f-assignment')::uuid
    order by job.transition_sequence
  $$,
  $$
    values
      (1::bigint, 0, null::text, false),
      (2::bigint, 3, 'practice_cycle_transition_failed'::text, true)
  $$,
  'only the current revision exhausts after three bounded failures'
);

select is(
  (current_setting('phase_13f.failure_three')::jsonb ->> 'exhausted')::integer,
  1,
  'the recovery result reports one unresolved exhausted transition'
);

set local role service_role;
select set_config(
  'phase_13f.exhausted_barrier',
  api.process_practice_cycle_transition_jobs(2)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'exhausted')::integer
    from (
      select current_setting('phase_13f.exhausted_barrier')::jsonb as payload
    ) result
  $$,
  $$ values (0, 0, 1) $$,
  'an exhausted current job remains a manual barrier until reset or a newer revision exists'
);

select set_config(
  'phase_13f.head_job_id',
  (
    select job.id::text
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.assignment_id = md5('phase-13f-assignment')::uuid
      and job.status_revision = 2
  ),
  true
);

set local role service_role;
select set_config(
  'phase_13f.reset_result',
  api.reset_practice_cycle_transition_job(
    current_setting('phase_13f.head_job_id')::uuid
  )::text,
  true
);
reset role;

select results_eq(
  $$
    select
      current_setting('phase_13f.reset_result')::boolean,
      job.failure_count,
      job.last_error_code,
      job.next_retry_at <= now()
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.assignment_id = md5('phase-13f-assignment')::uuid
      and job.status_revision = 2
  $$,
  $$ values (true, 0, null::text, true) $$,
  'the service reset reopens exactly the unprocessed exhausted head job'
);

drop trigger phase_13f_reject_transition_event
on app_private.practice_resolution_cycle_events;

set local role service_role;
select set_config(
  'phase_13f.recovered_head',
  api.process_practice_cycle_transition_jobs(2)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'failed')::integer
    from (
      select current_setting('phase_13f.recovered_head')::jsonb as payload
    ) result
  $$,
  $$ values (1, 1, 0) $$,
  'after reset and repair the processor settles the head transition first'
);

select results_eq(
  $$
    select job.status_revision, job.processed_at is not null
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.assignment_id = md5('phase-13f-assignment')::uuid
    order by job.transition_sequence
  $$,
  $$ values (1::bigint, true), (2::bigint, true) $$,
  'recovery leaves both the superseded and current rapid transitions settled'
);

set local role service_role;
select set_config(
  'phase_13f.recovered_tail',
  api.process_practice_cycle_transition_jobs(2)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'failed')::integer
    from (
      select current_setting('phase_13f.recovered_tail')::jsonb as payload
    ) result
  $$,
  $$ values (0, 0, 0) $$,
  'no stale transition remains to barrier or replay after the current revision settles'
);

select results_eq(
  $$
    select
      cycle.state,
      cycle.state_reason,
      array_agg(
        (event.details ->> 'status_revision')::bigint
        order by event.event_sequence
      )
    from app_private.practice_resolution_cycles cycle
    join app_private.practice_resolution_cycle_events event
      on event.cycle_id = cycle.id
    where cycle.id = md5('phase-13f-cycle')::uuid
    group by cycle.state, cycle.state_reason
  $$,
  $$
    values (
      'in_progress'::text,
      'feedback_evaluation_pending'::text,
      array[2::bigint]
    )
  $$,
  'only the current rapid transition revision is allowed to create a cycle event'
);

set local role service_role;
select set_config(
  'phase_13f.idempotent_rerun',
  api.process_practice_cycle_transition_jobs(50)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (
        select count(*)::integer
        from app_private.practice_resolution_cycle_events event
        where event.cycle_id = md5('phase-13f-cycle')::uuid
      )
    from (
      select current_setting('phase_13f.idempotent_rerun')::jsonb as payload
    ) result
  $$,
  $$ values (0, 0, 1) $$,
  'rerunning the processor is idempotent and cannot duplicate settled cycle events'
);

set local role service_role;
select set_config(
  'phase_13f.processed_reset',
  api.reset_practice_cycle_transition_job(
    current_setting('phase_13f.head_job_id')::uuid
  )::text,
  true
);
reset role;

select is(
  current_setting('phase_13f.processed_reset')::boolean,
  false,
  'a settled transition cannot be reset and replayed'
);

-- -------------------------------------------------------------------------
-- Definitive superseded-revision semantics across terminal transitions.
-- -------------------------------------------------------------------------

create temporary table phase_13f_terminal_cases (
  scenario text primary key,
  topic_slug text not null,
  cycle_id uuid not null unique,
  assignment_id uuid not null unique,
  practice_test_id uuid not null unique,
  attempt_id uuid not null unique,
  grammar_topic_id uuid not null
) on commit drop;

insert into phase_13f_terminal_cases (
  scenario,
  topic_slug,
  cycle_id,
  assignment_id,
  practice_test_id,
  attempt_id,
  grammar_topic_id
)
select
  fixture.scenario,
  fixture.topic_slug,
  md5('phase-13f-terminal-cycle-' || fixture.scenario)::uuid,
  md5('phase-13f-terminal-assignment-' || fixture.scenario)::uuid,
  md5('phase-13f-terminal-test-' || fixture.scenario)::uuid,
  md5('phase-13f-terminal-attempt-' || fixture.scenario)::uuid,
  topic.id
from (
  values
    ('rapid_pass'::text, 'conjugation'::text),
    ('pass_then_fail'::text, 'word-order'::text),
    ('third_failure_override'::text, 'prepositions'::text)
) as fixture(scenario, topic_slug)
join public.grammar_topics topic
  on topic.slug = fixture.topic_slug
 and topic.level = 'A1_A2';

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
  fixture.practice_test_id,
  md5('phase-13f-workspace')::uuid,
  fixture.grammar_topic_id,
  'A1',
  'easy',
  'Phase 13F ' || fixture.scenario,
  false,
  true,
  'workspace',
  md5('phase-13f-teacher')::uuid,
  'fixture',
  'approved',
  md5('phase-13f-teacher')::uuid,
  now()
from phase_13f_terminal_cases fixture;

-- As above, terminal-transition tests seed the already-verified immutable
-- class snapshot directly instead of duplicating the writing-release suite.
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
  md5('phase-13f-workspace')::uuid,
  md5('phase-13f-student')::uuid,
  fixture.grammar_topic_id,
  1,
  'unlocked',
  'worksheet_ready',
  1,
  0,
  0,
  0,
  md5('phase-13f-batch')::uuid,
  'A1',
  1,
  'teacher_verified'
from phase_13f_terminal_cases fixture;

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
  class_context_integrity,
  completed_at
)
select
  fixture.assignment_id,
  cycle.workspace_id,
  cycle.student_id,
  cycle.grammar_topic_id,
  fixture.practice_test_id,
  'weakness_auto',
  case fixture.scenario
    when 'third_failure_override' then 'completed'
    else 'unlocked'
  end,
  'ready',
  cycle.id,
  cycle.cycle_number,
  cycle.evidence_through_sequence,
  cycle.batch_id,
  cycle.worksheet_level,
  cycle.class_context_version,
  cycle.class_context_integrity,
  case fixture.scenario
    when 'third_failure_override' then now()
    else null
  end
from phase_13f_terminal_cases fixture
join app_private.practice_resolution_cycles cycle
  on cycle.id = fixture.cycle_id;

-- Two earlier failed assignments make the support fixture's current failure
-- the third failure in this exact resolution cycle.
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
  class_context_integrity,
  completed_at
)
select
  md5('phase-13f-support-prior-' || prior.failure_number)::uuid,
  cycle.workspace_id,
  cycle.student_id,
  cycle.grammar_topic_id,
  fixture.practice_test_id,
  'manual',
  'failed',
  'ready',
  cycle.id,
  cycle.cycle_number,
  cycle.evidence_through_sequence,
  cycle.batch_id,
  cycle.worksheet_level,
  cycle.class_context_version,
  cycle.class_context_integrity,
  now()
from phase_13f_terminal_cases fixture
join app_private.practice_resolution_cycles cycle
  on cycle.id = fixture.cycle_id
cross join (values ('one'::text), ('two'::text)) as prior(failure_number)
where fixture.scenario = 'third_failure_override';

update app_private.practice_resolution_cycles cycle
set
  active_assignment_id = fixture.assignment_id,
  evidence_frozen_at = now()
from phase_13f_terminal_cases fixture
where cycle.id = fixture.cycle_id;

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
select
  fixture.attempt_id,
  fixture.practice_test_id,
  md5('phase-13f-student')::uuid,
  md5('phase-13f-workspace')::uuid,
  fixture.assignment_id,
  'checked',
  '[]'::jsonb,
  case fixture.scenario when 'third_failure_override' then 0 else 1 end,
  1,
  case fixture.scenario when 'third_failure_override' then 0.6 else 1 end,
  1,
  case fixture.scenario when 'third_failure_override' then 60 else 100 end,
  fixture.scenario <> 'third_failure_override',
  'phase_13f_fixture',
  'not_needed',
  now() - interval '2 minutes',
  now() - interval '1 minute',
  now()
from phase_13f_terminal_cases fixture;

update public.student_practice_assignments assignment
set latest_attempt_id = fixture.attempt_id
from phase_13f_terminal_cases fixture
where assignment.id = fixture.assignment_id;

update public.student_practice_assignments assignment
set status = 'in_progress', started_at = now()
from phase_13f_terminal_cases fixture
where assignment.id = fixture.assignment_id
  and fixture.scenario = 'rapid_pass';

update public.student_practice_assignments assignment
set status = 'completed', completed_at = now()
from phase_13f_terminal_cases fixture
where assignment.id = fixture.assignment_id
  and fixture.scenario in ('rapid_pass', 'pass_then_fail');

update public.student_practice_assignments assignment
set status = 'passed'
from phase_13f_terminal_cases fixture
where assignment.id = fixture.assignment_id
  and fixture.scenario in ('rapid_pass', 'pass_then_fail');

-- The later failure is authoritative. Mutating the attempt before the current
-- status commit also proves the now-stale pass row does not validate or apply.
update public.practice_test_attempts attempt
set
  score = 0,
  score_points = 0.6,
  score_percent = 60,
  passed = false
from phase_13f_terminal_cases fixture
where attempt.id = fixture.attempt_id
  and fixture.scenario = 'pass_then_fail';

update public.student_practice_assignments assignment
set status = 'failed'
from phase_13f_terminal_cases fixture
where assignment.id = fixture.assignment_id
  and fixture.scenario in ('pass_then_fail', 'third_failure_override');

select results_eq(
  $$
    select
      fixture.scenario,
      job.status_revision,
      job.previous_status,
      job.target_status
    from phase_13f_terminal_cases fixture
    join app_private.practice_assignment_cycle_transition_jobs job
      on job.assignment_id = fixture.assignment_id
    order by fixture.scenario, job.status_revision
  $$,
  $$
    values
      ('pass_then_fail'::text, 1::bigint, 'unlocked'::text, 'completed'::text),
      ('pass_then_fail'::text, 2::bigint, 'completed'::text, 'passed'::text),
      ('pass_then_fail'::text, 3::bigint, 'passed'::text, 'failed'::text),
      ('rapid_pass'::text, 1::bigint, 'unlocked'::text, 'in_progress'::text),
      ('rapid_pass'::text, 2::bigint, 'in_progress'::text, 'completed'::text),
      ('rapid_pass'::text, 3::bigint, 'completed'::text, 'passed'::text),
      ('third_failure_override'::text, 1::bigint, 'completed'::text, 'failed'::text)
  $$,
  'terminal rapid chains preserve every committed revision before recovery'
);

set local role service_role;
select set_config(
  'phase_13f.terminal_tick_one',
  api.process_practice_cycle_transition_jobs(50)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'failed')::integer,
      (payload ->> 'exhausted')::integer
    from (
      select current_setting('phase_13f.terminal_tick_one')::jsonb as payload
    ) result
  $$,
  $$ values (3, 3, 0, 0) $$,
  'the first terminal tick settles two stale heads and applies the current third failure'
);

select results_eq(
  $$
    select
      cycle.state,
      cycle.state_reason,
      cycle.active_assignment_id is null,
      assignment.status,
      (
        select count(*)::integer
        from public.student_practice_assignments failed_assignment
        where failed_assignment.resolution_cycle_id = cycle.id
          and failed_assignment.status = 'failed'
      )
    from phase_13f_terminal_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.id = fixture.cycle_id
    join public.student_practice_assignments assignment
      on assignment.id = fixture.assignment_id
    where fixture.scenario = 'third_failure_override'
  $$,
  $$ values ('locked'::text, 'teacher_support_required'::text, true, 'failed'::text, 3) $$,
  'the real third failure reaches the locked teacher-support state before override'
);

set local role service_role;
select set_config(
  'phase_13f.terminal_tick_two',
  api.process_practice_cycle_transition_jobs(50)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'failed')::integer,
      (payload ->> 'exhausted')::integer
    from (
      select current_setting('phase_13f.terminal_tick_two')::jsonb as payload
    ) result
  $$,
  $$ values (2, 2, 0, 0) $$,
  'the second terminal tick advances both rapid chains without a stale-row barrier'
);

set local role service_role;
select set_config(
  'phase_13f.terminal_tick_three',
  api.process_practice_cycle_transition_jobs(50)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'failed')::integer,
      (payload ->> 'exhausted')::integer
    from (
      select current_setting('phase_13f.terminal_tick_three')::jsonb as payload
    ) result
  $$,
  $$ values (2, 2, 0, 0) $$,
  'only the current pass and current failure apply on the third terminal tick'
);

select results_eq(
  $$
    select
      fixture.scenario,
      array_agg(
        (event.details ->> 'status_revision')::bigint
        order by event.event_sequence
      ) filter (where event.details ? 'status_revision')
    from phase_13f_terminal_cases fixture
    left join app_private.practice_resolution_cycle_events event
      on event.cycle_id = fixture.cycle_id
    where fixture.scenario in ('rapid_pass', 'pass_then_fail')
    group by fixture.scenario
    order by fixture.scenario
  $$,
  $$
    values
      ('pass_then_fail'::text, array[3::bigint]),
      ('rapid_pass'::text, array[3::bigint])
  $$,
  'superseded terminal revisions produce no adaptive-state event side effects'
);

select results_eq(
  $$
    select
      cycle.state,
      cycle.state_reason,
      cycle.active_assignment_id is null,
      cycle.resolution_assignment_id = fixture.assignment_id,
      cycle.resolution_attempt_id = fixture.attempt_id,
      cycle.resolution_outcome,
      cycle.resolved_through_sequence,
      cycle.mastery_pass_number,
      assignment.status
    from phase_13f_terminal_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.id = fixture.cycle_id
    join public.student_practice_assignments assignment
      on assignment.id = fixture.assignment_id
    where fixture.scenario = 'rapid_pass'
  $$,
  $$
    values (
      'improving'::text,
      'first_resolution_passed'::text,
      true,
      true,
      true,
      'passed'::text,
      0::bigint,
      1,
      'passed'::text
    )
  $$,
  'the current rapid pass atomically resolves the cycle with complete pass fields'
);

select results_eq(
  $$
    select
      cycle.resolved_at is null,
      cycle.resolution_outcome is null,
      original_assignment.status,
      replacement.status,
      replacement.previous_assignment_id = original_assignment.id,
      cycle.active_assignment_id = replacement.id
    from phase_13f_terminal_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.id = fixture.cycle_id
    join public.student_practice_assignments original_assignment
      on original_assignment.id = fixture.assignment_id
    join public.student_practice_assignments replacement
      on replacement.id = cycle.active_assignment_id
    where fixture.scenario = 'pass_then_fail'
  $$,
  $$ values (true, true, 'failed'::text, 'unlocked'::text, true, true) $$,
  'the authoritative pass-to-fail revision keeps the cycle open on exactly one replacement'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  md5('phase-13f-teacher')::uuid::text,
  true
);

select set_config(
  'phase_13f.support_override',
  api.override_practice_attempt_score(
    (
      select fixture.assignment_id
      from phase_13f_terminal_cases fixture
      where fixture.scenario = 'third_failure_override'
    ),
    90,
    'Qualified teacher correction of the third failed practice result.',
    0
  )::text,
  true
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select results_eq(
  $$
    select
      (result.payload ->> 'passed')::boolean,
      result.payload ->> 'assignment_status',
      (result.payload ->> 'score_percent')::numeric,
      assignment.status,
      assignment.status_revision,
      attempt.passed,
      attempt.score_percent,
      attempt.scoring_version
    from (
      select current_setting('phase_13f.support_override')::jsonb as payload
    ) result
    join phase_13f_terminal_cases fixture
      on fixture.scenario = 'third_failure_override'
    join public.student_practice_assignments assignment
      on assignment.id = fixture.assignment_id
    join public.practice_test_attempts attempt
      on attempt.id = fixture.attempt_id
  $$,
  $$
    values (
      true,
      'passed'::text,
      90::numeric,
      'passed'::text,
      2::bigint,
      true,
      90::numeric,
      'teacher_override_v1'::text
    )
  $$,
  'the teacher override atomically makes the third-failure attempt and assignment a pass'
);

select results_eq(
  $$
    select
      cycle.state,
      cycle.state_reason,
      cycle.resolved_at is null,
      job.processed_at is null,
      job.failure_count
    from phase_13f_terminal_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.id = fixture.cycle_id
    join app_private.practice_assignment_cycle_transition_jobs job
      on job.assignment_id = fixture.assignment_id
     and job.status_revision = 2
    where fixture.scenario = 'third_failure_override'
  $$,
  $$ values ('locked'::text, 'teacher_support_required'::text, true, true, 0) $$,
  'the score override remains durably queued until service recovery applies it'
);

set local role service_role;
select set_config(
  'phase_13f.support_override_tick',
  api.process_practice_cycle_transition_jobs(50)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'failed')::integer,
      (payload ->> 'exhausted')::integer
    from (
      select current_setting('phase_13f.support_override_tick')::jsonb as payload
    ) result
  $$,
  $$ values (1, 1, 0, 0) $$,
  'service recovery applies the current teacher-override pass without retry or exhaustion'
);

select results_eq(
  $$
    select
      cycle.state,
      cycle.state_reason,
      cycle.active_assignment_id is null,
      cycle.resolution_assignment_id = fixture.assignment_id,
      cycle.resolution_attempt_id = fixture.attempt_id,
      cycle.resolution_outcome,
      cycle.resolved_through_sequence,
      cycle.mastery_pass_number,
      cycle.resolved_at is not null
    from phase_13f_terminal_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.id = fixture.cycle_id
    where fixture.scenario = 'third_failure_override'
  $$,
  $$
    values (
      'improving'::text,
      'first_resolution_passed'::text,
      true,
      true,
      true,
      'passed'::text,
      0::bigint,
      1,
      true
    )
  $$,
  'the locked third-failure cycle resolves with the complete guarded pass shape'
);

select is(
  (
    select count(*)
    from phase_13f_terminal_cases fixture
    join app_private.practice_resolution_cycles cycle
      on cycle.id = fixture.cycle_id
     and cycle.resolved_at is not null
    join public.student_practice_assignments assignment
      on assignment.resolution_cycle_id = cycle.id
     and assignment.status in ('unlocked', 'in_progress', 'completed')
  ),
  0::bigint,
  'no resolved terminal cycle retains an orphan active assignment'
);

select is(
  (
    select count(*)
    from phase_13f_terminal_cases fixture
    join app_private.practice_assignment_cycle_transition_jobs job
      on job.assignment_id = fixture.assignment_id
    where job.processed_at is null
       or job.failure_count <> 0
       or job.last_error_code is not null
  ),
  0::bigint,
  'all current and superseded terminal jobs settle without residual failure or barrier state'
);

select results_eq(
  $$
    select
      fixture.scenario,
      assignment.status,
      cycle.state,
      cycle.resolved_at is not null,
      coalesce(cycle.resolution_assignment_id = assignment.id, false)
    from phase_13f_terminal_cases fixture
    join public.student_practice_assignments assignment
      on assignment.id = fixture.assignment_id
    join app_private.practice_resolution_cycles cycle
      on cycle.id = fixture.cycle_id
    order by fixture.scenario
  $$,
  $$
    values
      ('pass_then_fail'::text, 'failed'::text, 'unlocked'::text, false, false),
      ('rapid_pass'::text, 'passed'::text, 'improving'::text, true, true),
      ('third_failure_override'::text, 'passed'::text, 'improving'::text, true, true)
  $$,
  'each final cycle state matches the assignment revision that was current at processing time'
);

-- An exhausted row is a manual barrier while it is current, but it must not
-- permanently poison a later authoritative revision of the same assignment.
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
  md5('phase-13f-exhausted-superseded-cycle')::uuid,
  md5('phase-13f-workspace')::uuid,
  md5('phase-13f-student')::uuid,
  topic.id,
  1,
  'unlocked',
  'worksheet_ready',
  1,
  0,
  0,
  0,
  md5('phase-13f-batch')::uuid,
  'A1',
  1,
  'teacher_verified'
from public.grammar_topics topic
where topic.slug = 'capitalization'
  and topic.level = 'A1_A2';

set local session_replication_role = origin;

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
  md5('phase-13f-exhausted-superseded-assignment')::uuid,
  cycle.workspace_id,
  cycle.student_id,
  cycle.grammar_topic_id,
  'weakness_auto',
  'unlocked',
  'ready',
  cycle.id,
  cycle.cycle_number,
  cycle.evidence_through_sequence,
  cycle.batch_id,
  cycle.worksheet_level,
  cycle.class_context_version,
  cycle.class_context_integrity
from app_private.practice_resolution_cycles cycle
where cycle.id = md5('phase-13f-exhausted-superseded-cycle')::uuid;

update app_private.practice_resolution_cycles cycle
set
  active_assignment_id = md5('phase-13f-exhausted-superseded-assignment')::uuid,
  evidence_frozen_at = now()
where cycle.id = md5('phase-13f-exhausted-superseded-cycle')::uuid;

update public.student_practice_assignments assignment
set status = 'completed', completed_at = now()
where assignment.id = md5('phase-13f-exhausted-superseded-assignment')::uuid;

create or replace function pg_temp.phase_13f_reject_exhausted_event()
returns trigger
language plpgsql
as $$
begin
  if new.assignment_id = md5('phase-13f-exhausted-superseded-assignment')::uuid then
    raise exception using
      errcode = '55000',
      message = 'phase_13f_exhausted_superseded_poison';
  end if;
  return new;
end;
$$;

create trigger phase_13f_reject_exhausted_event
before insert on app_private.practice_resolution_cycle_events
for each row execute function pg_temp.phase_13f_reject_exhausted_event();

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

update app_private.practice_assignment_cycle_transition_jobs job
set next_retry_at = now() - interval '1 second'
where job.assignment_id = md5('phase-13f-exhausted-superseded-assignment')::uuid;

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

update app_private.practice_assignment_cycle_transition_jobs job
set next_retry_at = now() - interval '1 second'
where job.assignment_id = md5('phase-13f-exhausted-superseded-assignment')::uuid;

set local role service_role;
select api.process_practice_cycle_transition_jobs(1);
reset role;

select results_eq(
  $$
    select
      assignment.status_revision,
      job.status_revision,
      job.failure_count,
      job.processed_at is null,
      job.last_error_code
    from public.student_practice_assignments assignment
    join app_private.practice_assignment_cycle_transition_jobs job
      on job.assignment_id = assignment.id
    where assignment.id = md5('phase-13f-exhausted-superseded-assignment')::uuid
  $$,
  $$
    values (
      1::bigint,
      1::bigint,
      3,
      true,
      'practice_cycle_transition_failed'::text
    )
  $$,
  'a third failure exhausts the transition while revision N remains current'
);

set local role service_role;
select set_config(
  'phase_13f.current_exhausted_barrier',
  api.process_practice_cycle_transition_jobs(2)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'exhausted')::integer
    from (
      select current_setting('phase_13f.current_exhausted_barrier')::jsonb as payload
    ) result
  $$,
  $$ values (0, 0, 1) $$,
  'an exhausted revision that is still current remains a manual recovery barrier'
);

update public.student_practice_assignments assignment
set status = 'failed'
where assignment.id = md5('phase-13f-exhausted-superseded-assignment')::uuid;

drop trigger phase_13f_reject_exhausted_event
on app_private.practice_resolution_cycle_events;

set local role service_role;
select set_config(
  'phase_13f.exhausted_superseded_recovery',
  api.process_practice_cycle_transition_jobs(2)::text,
  true
);
reset role;

select results_eq(
  $$
    select
      (payload ->> 'attempted')::integer,
      (payload ->> 'succeeded')::integer,
      (payload ->> 'failed')::integer,
      (payload ->> 'exhausted')::integer
    from (
      select current_setting('phase_13f.exhausted_superseded_recovery')::jsonb as payload
    ) result
  $$,
  $$ values (2, 2, 0, 0) $$,
  'one bounded tick settles exhausted revision N and applies current revision N plus one'
);

select results_eq(
  $$
    select
      job.status_revision,
      job.failure_count,
      job.processed_at is not null,
      job.last_error_code
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.assignment_id = md5('phase-13f-exhausted-superseded-assignment')::uuid
    order by job.status_revision
  $$,
  $$
    values
      (1::bigint, 3, true, null::text),
      (2::bigint, 0, true, null::text)
  $$,
  'the exhausted stale row remains auditable while both revisions reach terminal delivery state'
);

select results_eq(
  $$
    select
      assignment.status,
      cycle.resolved_at is null,
      cycle.resolution_outcome is null,
      array_agg(
        (event.details ->> 'status_revision')::bigint
        order by event.event_sequence
      ) filter (where event.details ? 'status_revision'),
      (
        select count(*)::integer
        from app_private.practice_assignment_cycle_transition_jobs pending
        where pending.assignment_id = assignment.id
          and pending.processed_at is null
      )
    from public.student_practice_assignments assignment
    join app_private.practice_resolution_cycles cycle
      on cycle.id = assignment.resolution_cycle_id
    left join app_private.practice_resolution_cycle_events event
      on event.cycle_id = cycle.id
    where assignment.id = md5('phase-13f-exhausted-superseded-assignment')::uuid
    group by assignment.id, assignment.status, cycle.id, cycle.resolved_at,
      cycle.resolution_outcome
  $$,
  $$ values ('failed'::text, true, true, array[2::bigint], 0) $$,
  'the exhausted stale revision has no state side effect and only the current failure shapes the cycle'
);

select * from finish();
rollback;
