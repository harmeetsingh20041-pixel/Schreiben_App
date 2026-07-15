-- Run after Phase 12J and immediately before Phase 12K in a rollback-only
-- verification transaction. It creates one isolated Phase-12G-style promoted
-- legacy context so the Phase 12K probe can prove quarantine and teacher
-- recovery. Never run this fixture outside a wrapping transaction.

create temporary table phase_12k_legacy_pre_state (
  singleton boolean primary key default true check (singleton),
  teacher_id uuid not null,
  student_id uuid not null,
  workspace_id uuid not null,
  batch_id uuid not null,
  topic_id uuid not null,
  submission_id uuid not null,
  cycle_id uuid,
  assignment_id uuid,
  job_id uuid
) on commit drop;

insert into phase_12k_legacy_pre_state (
  teacher_id, student_id, workspace_id, batch_id, topic_id, submission_id
)
values (
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
);

do $phase_12k_legacy_pre_fixture$
declare
  state_record record;
  requested_job record;
begin
  select * into state_record from pg_temp.phase_12k_legacy_pre_state;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', state_record.teacher_id,
      'authenticated', 'authenticated',
      format('phase12k-legacy-teacher-%s@example.test', state_record.teacher_id),
      '', now(), '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Phase 12K legacy teacher"}'::jsonb, now(), now()
    ),
    (
      '00000000-0000-0000-0000-000000000000', state_record.student_id,
      'authenticated', 'authenticated',
      format('phase12k-legacy-student-%s@example.test', state_record.student_id),
      '', now(), '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Phase 12K legacy student"}'::jsonb, now(), now()
    );

  insert into public.workspaces (id, name, slug, owner_id)
  values (
    state_record.workspace_id,
    'Phase 12K legacy pre-fixture',
    format('phase12k-legacy-%s', replace(state_record.workspace_id::text, '-', '')),
    state_record.teacher_id
  );
  insert into public.workspace_members (workspace_id, user_id, role)
  values
    (state_record.workspace_id, state_record.teacher_id, 'teacher'),
    (state_record.workspace_id, state_record.student_id, 'student');
  insert into public.batches (id, workspace_id, name, level, is_active, feedback_mode)
  values (
    state_record.batch_id, state_record.workspace_id,
    'Legacy inferred A2', 'A2', true, 'immediate'
  );
  insert into public.batch_students (batch_id, student_id, workspace_id)
  values (state_record.batch_id, state_record.student_id, state_record.workspace_id);
  insert into public.grammar_topics (id, slug, name, level, description)
  values (
    state_record.topic_id,
    format('phase12k-legacy-%s', replace(state_record.topic_id::text, '-', '')),
    'Phase 12K legacy topic', 'A2', 'Rollback-only legacy fixture'
  );
  insert into public.submissions (
    id, workspace_id, student_id, batch_id, question_source, mode,
    original_text, status, feedback_mode, evaluation_status, release_status,
    level_detected, checked_at
  ) values (
    state_record.submission_id, state_record.workspace_id,
    state_record.student_id, state_record.batch_id, 'free_text', 'free_text',
    'Legacy writing.', 'checked', 'immediate', 'ready', 'released', 'A2', now()
  );

  insert into app_private.practice_weakness_evidence (
    source_kind, source_release_id, submission_id, workspace_id, student_id,
    grammar_topic_id, minor_issue_count, major_issue_count, released_at
  ) values (
    'legacy_release', state_record.submission_id, state_record.submission_id,
    state_record.workspace_id, state_record.student_id, state_record.topic_id,
    0, 1, now()
  );

  update pg_temp.phase_12k_legacy_pre_state state
  set
    cycle_id = cycle.id,
    assignment_id = assignment.id
  from app_private.practice_resolution_cycles cycle
  join public.student_practice_assignments assignment
    on assignment.resolution_cycle_id = cycle.id
  where state.singleton
    and cycle.workspace_id = state_record.workspace_id
    and cycle.student_id = state_record.student_id
    and cycle.grammar_topic_id = state_record.topic_id;

  select * into state_record from pg_temp.phase_12k_legacy_pre_state;
  if state_record.cycle_id is null or state_record.assignment_id is null
    or not exists (
      select 1
      from app_private.practice_resolution_cycles cycle
      join public.student_practice_assignments assignment
        on assignment.resolution_cycle_id = cycle.id
      where cycle.id = state_record.cycle_id
        and assignment.id = state_record.assignment_id
        and cycle.class_context_version = 1
        and assignment.class_context_version = 1
    )
  then
    raise exception 'Legacy pre-fixture was not promoted by Phase 12G.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', state_record.student_id, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', state_record.student_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  select requested.*
  into requested_job
  from api.request_practice_worksheet(state_record.assignment_id) requested;

  update pg_temp.phase_12k_legacy_pre_state
  set job_id = requested_job.job_id
  where singleton;

  if requested_job.job_id is null then
    raise exception 'Legacy pre-fixture did not create the active job under test.';
  end if;
end;
$phase_12k_legacy_pre_fixture$;
