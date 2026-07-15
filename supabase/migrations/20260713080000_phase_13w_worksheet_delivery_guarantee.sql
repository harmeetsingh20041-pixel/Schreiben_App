-- Phase 13W: close the remaining safe worksheet-delivery gaps.
--
-- Qualified canonical material remains the only provider-independent fallback.
-- This migration does not certify or release any worksheet. It lets the worker
-- and recovery consumer re-check the exact current bank at the last safe moment,
-- aligns teacher approval with the already-supported validated mcq_safe shape,
-- and projects manual retry exhaustion without exposing private job errors.

-- ---------------------------------------------------------------------------
-- Teacher approval: preserve the historical rich mix and accept the same
-- deterministic all-MCQ contract already accepted by the final materializer.
-- ---------------------------------------------------------------------------

do $migration$
declare
  function_definition text;
  patched_definition text;
  declaration_anchor constant text := $fragment$
  expected_question_count integer := 0;
  action_id uuid := gen_random_uuid();
begin
$fragment$;
  declaration_replacement constant text := $fragment$
  expected_question_count integer := 0;
  strict_scoring boolean := false;
  action_id uuid := gen_random_uuid();
begin
$fragment$;
  validation_anchor constant text := $fragment$
  expected_question_count := case when selected_test.level = 'A2' then 9 else 8 end;

  if target_decision = 'approve' and (
    question_count <> expected_question_count
    or multiple_choice_count < 2
    or fill_blank_count < 2
    or open_question_count not between 1 and 3
    or exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
        and question.answer_contract_version <> 1
    )
    or exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
        and question.question_number not between 1 and expected_question_count
    )
    or (
      select count(*) <> count(distinct question.question_number)
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
    )
    or (
      select count(*) <> count(distinct lower(regexp_replace(
        btrim(question.prompt),
        '\s+',
        ' ',
        'g'
      )))
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
    )
  )
  then
    raise exception using errcode = '55000', message = 'worksheet_contract_invalid';
  end if;
$fragment$;
  validation_replacement constant text := $fragment$
  expected_question_count := case when selected_test.level = 'A2' then 9 else 8 end;

  select coalesce(
    app_private.is_practice_topic_strict_scoring(topic.name, topic.slug),
    false
  ) or coalesce(
    app_private.is_practice_topic_punctuation_scoring(topic.name, topic.slug),
    false
  )
  into strict_scoring
  from public.grammar_topics topic
  where topic.id = selected_assignment.grammar_topic_id;

  if target_decision = 'approve' and (
    question_count <> expected_question_count
    or not (
      (
        multiple_choice_count >= 2
        and fill_blank_count >= 2
        and open_question_count between 1 and 3
      )
      or (
        multiple_choice_count = question_count
        and fill_blank_count = 0
        and open_question_count = 0
        and not exists (
          select 1
          from public.practice_test_questions question
          where question.practice_test_id = selected_test.id
            and (
              question.question_type <> 'multiple_choice'
              or question.evaluation_mode <> 'local_exact'
              or question.rubric is distinct from 'null'::jsonb
              or jsonb_typeof(question.options) <> 'array'
              or jsonb_array_length(question.options) not between 3 and 4
              or jsonb_typeof(question.accepted_answers) <> 'array'
              or jsonb_array_length(question.accepted_answers) <> 1
              or jsonb_typeof(question.accepted_answers -> 0) <> 'string'
              or (question.accepted_answers ->> 0)
                is distinct from question.correct_answer
              or exists (
                select 1
                from jsonb_array_elements(question.options) option_value(value)
                where jsonb_typeof(option_value.value) <> 'string'
                  or length(btrim(option_value.value #>> '{}')) = 0
              )
              or (
                select count(*) <> count(distinct
                  app_private.normalize_practice_contract_value(
                    option_value,
                    strict_scoring
                  )
                )
                from jsonb_array_elements_text(question.options) option_value
              )
              or (
                select count(*)
                from jsonb_array_elements_text(question.options) option_value
                where app_private.normalize_practice_contract_value(
                  option_value,
                  strict_scoring
                ) = app_private.normalize_practice_contract_value(
                  question.correct_answer,
                  strict_scoring
                )
              ) <> 1
            )
        )
      )
    )
    or exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
        and question.answer_contract_version <> 1
    )
    or exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
        and question.question_number not between 1 and expected_question_count
    )
    or (
      select count(*) <> count(distinct question.question_number)
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
    )
    or (
      select count(*) <> count(distinct lower(regexp_replace(
        btrim(question.prompt),
        '\s+',
        ' ',
        'g'
      )))
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
    )
  )
  then
    raise exception using errcode = '55000', message = 'worksheet_contract_invalid';
  end if;
$fragment$;
begin
  select pg_get_functiondef(
    'public.decide_quarantined_practice_worksheet_internal(uuid,text,text)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or (
      length(function_definition)
      - length(replace(function_definition, declaration_anchor, ''))
    ) <> length(declaration_anchor)
    or (
      length(function_definition)
      - length(replace(function_definition, validation_anchor, ''))
    ) <> length(validation_anchor)
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_quarantine_mcq_contract_patch_mismatch';
  end if;

  patched_definition := replace(
    replace(
      function_definition,
      declaration_anchor,
      declaration_replacement
    ),
    validation_anchor,
    validation_replacement
  );
  execute patched_definition;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- Active worker rescue: re-select the exact currently qualified revision in the
-- same transaction that would otherwise quarantine or fail the job.
-- ---------------------------------------------------------------------------

create or replace function api.try_complete_current_certified_worksheet_bank_fallback(
  target_job_id uuid,
  target_queue_message_id bigint,
  target_worker_id uuid,
  target_fallback_reason text,
  rejected_candidates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  assignment_snapshot public.student_practice_assignments%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_job app_private.async_jobs%rowtype;
  selected_revision_id uuid;
  completion record;
begin
  perform app_private.assert_service_role();

  if target_job_id is null
    or target_queue_message_id is null
    or target_worker_id is null
    or target_fallback_reason is null
    or rejected_candidates is null
    or target_fallback_reason not in (
      'provider_unavailable', 'provider_exhausted', 'candidates_rejected'
    )
    or jsonb_typeof(rejected_candidates) <> 'array'
    or jsonb_array_length(rejected_candidates) > 2
    or (
      target_fallback_reason = 'candidates_rejected'
      and jsonb_array_length(rejected_candidates) = 0
    )
    or (
      target_fallback_reason <> 'candidates_rejected'
      and jsonb_array_length(rejected_candidates) <> 0
    )
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_terminal_bank_rescue_context_invalid';
  end if;

  -- Resolve only an immutable snapshot before taking locks. The mutable class
  -- context is locked first below, followed by the job and assignment rows.
  -- That is the same class -> job -> assignment order used by every current
  -- worksheet completion path and by offboarding/class-transfer postconditions.
  select assignment.*
  into assignment_snapshot
  from app_private.async_jobs job
  join public.student_practice_assignments assignment
    on assignment.id = job.entity_id
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation';

  if assignment_snapshot.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'worksheet_generation_job_not_found';
  end if;

  -- Both writing-derived and teacher-verified/manual assignments use the same
  -- exact class contract. Source kind is deliberately not an authorization
  -- predicate here; a valid immutable class snapshot is the boundary.
  if assignment_snapshot.class_context_version is distinct from 1
    or assignment_snapshot.class_context_integrity is null
    or assignment_snapshot.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or assignment_snapshot.batch_id is null
    or assignment_snapshot.worksheet_level is null
    or assignment_snapshot.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
    or assignment_snapshot.status not in ('unlocked', 'in_progress')
    or assignment_snapshot.practice_test_id is not null
  then
    return jsonb_build_object(
      'schema_version', 1,
      'rescued', false,
      'assignment_id', assignment_snapshot.id,
      'practice_test_id', null
    );
  end if;

  if not app_private.lock_active_practice_class_context(
    assignment_snapshot.workspace_id,
    assignment_snapshot.student_id,
    assignment_snapshot.batch_id,
    assignment_snapshot.worksheet_level
  ) then
    return jsonb_build_object(
      'schema_version', 1,
      'rescued', false,
      'assignment_id', assignment_snapshot.id,
      'practice_test_id', null
    );
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = assignment_snapshot.id
  for update;

  -- Revalidate every worker and class-context field after the canonical locks.
  -- A timed-out/stolen lease, withdrawal/offboarding race, batch-level change,
  -- or assignment replacement must fail closed before the bank selector runs.
  if selected_job.id is null
    or selected_job.job_kind <> 'worksheet_generation'
    or selected_job.entity_id is distinct from assignment_snapshot.id
    or selected_job.status <> 'processing'
    or selected_job.queue_message_id is distinct from target_queue_message_id
    or selected_job.worker_id is distinct from target_worker_id
    or selected_job.lease_expires_at is null
    or selected_job.lease_expires_at <= now()
    or selected_assignment.id is null
    or selected_job.entity_version is distinct from selected_assignment.generation_version
    or selected_assignment.workspace_id is distinct from assignment_snapshot.workspace_id
    or selected_assignment.student_id is distinct from assignment_snapshot.student_id
    or selected_assignment.grammar_topic_id is distinct from assignment_snapshot.grammar_topic_id
    or selected_assignment.batch_id is distinct from assignment_snapshot.batch_id
    or selected_assignment.worksheet_level is distinct from assignment_snapshot.worksheet_level
    or selected_assignment.class_context_version is distinct from 1
    or selected_assignment.class_context_integrity is null
    or selected_assignment.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or selected_assignment.status not in ('unlocked', 'in_progress')
    or selected_assignment.practice_test_id is not null
  then
    return jsonb_build_object(
      'schema_version', 1,
      'rescued', false,
      'assignment_id', assignment_snapshot.id,
      'practice_test_id', null
    );
  end if;

  selected_revision_id := public.select_released_worksheet_template_internal(
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id,
    selected_assignment.worksheet_level
  );

  if selected_revision_id is null then
    return jsonb_build_object(
      'schema_version', 1,
      'rescued', false,
      'assignment_id', selected_assignment.id,
      'practice_test_id', null
    );
  end if;

  begin
    select result.*
    into strict completion
    from app_private.complete_certified_worksheet_bank_fallback(
      target_job_id,
      target_queue_message_id,
      target_worker_id,
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'certified_bank',
        'template_revision_id', selected_revision_id,
        'fallback_reason', target_fallback_reason,
        'rejected_candidates', rejected_candidates
      )
    ) result;
  exception
    when sqlstate 'P0002' then
      if sqlerrm <> 'worksheet_bank_release_not_found' then raise; end if;
      return jsonb_build_object(
        'schema_version', 1,
        'rescued', false,
        'assignment_id', selected_assignment.id,
        'practice_test_id', null
      );
    when sqlstate '22023' then
      if sqlerrm <> 'worksheet_bank_revision_not_eligible' then raise; end if;
      return jsonb_build_object(
        'schema_version', 1,
        'rescued', false,
        'assignment_id', selected_assignment.id,
        'practice_test_id', null
      );
  end;

  return jsonb_build_object(
    'schema_version', 1,
    'rescued', true,
    'assignment_id', completion.assignment_id,
    'practice_test_id', completion.practice_test_id
  );
end;
$$;

revoke all on function api.try_complete_current_certified_worksheet_bank_fallback(
  uuid, bigint, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function api.try_complete_current_certified_worksheet_bank_fallback(
  uuid, bigint, uuid, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- Recovery rescue: attach newly published exact material to an untouched active
-- assignment even after its paid job has already become terminal.
-- ---------------------------------------------------------------------------

create table app_private.worksheet_bank_terminal_rescue_events (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null
    references public.student_practice_assignments(id) on delete restrict,
  job_id uuid references app_private.async_jobs(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  template_revision_id uuid not null
    references app_private.practice_worksheet_template_revisions(id)
    on delete restrict,
  cloned_practice_test_id uuid not null
    references public.practice_tests(id) on delete restrict,
  prior_generation_status text not null check (
    prior_generation_status in (
      'idle', 'queued', 'generating', 'ready', 'needs_review', 'failed'
    )
  ),
  rescue_source text not null check (rescue_source = 'recovery_sweep'),
  created_at timestamptz not null default now(),
  unique (assignment_id, cloned_practice_test_id)
);

create index worksheet_bank_terminal_rescue_events_created_idx
on app_private.worksheet_bank_terminal_rescue_events (created_at desc, id desc);

alter table app_private.worksheet_bank_terminal_rescue_events enable row level security;
revoke all on table app_private.worksheet_bank_terminal_rescue_events
from public, anon, authenticated, service_role;

-- Content-free operational state for bounded recovery. It records only IDs,
-- timestamps, counters and stable safe codes: never worksheet content, learner
-- answers, provider payloads or raw database error messages.
create table app_private.worksheet_bank_terminal_rescue_failures (
  assignment_id uuid primary key
    references public.student_practice_assignments(id) on delete restrict,
  template_revision_id uuid not null
    references app_private.practice_worksheet_template_revisions(id)
    on delete restrict,
  failure_count integer not null default 0
    check (failure_count between 0 and 5),
  first_failed_at timestamptz,
  last_attempt_at timestamptz not null,
  next_retry_at timestamptz not null,
  last_safe_error_code text not null check (
    last_safe_error_code ~ '^[a-z0-9_]{1,80}$'
  ),
  resolved_at timestamptz,
  check (
    (failure_count = 0 and first_failed_at is null)
    or (failure_count > 0 and first_failed_at is not null)
  ),
  check (resolved_at is null or resolved_at >= last_attempt_at)
);

create index worksheet_bank_terminal_rescue_failures_due_idx
on app_private.worksheet_bank_terminal_rescue_failures (
  next_retry_at,
  assignment_id
)
where resolved_at is null and failure_count < 5;

alter table app_private.worksheet_bank_terminal_rescue_failures
enable row level security;
revoke all on table app_private.worksheet_bank_terminal_rescue_failures
from public, anon, authenticated, service_role;

create or replace function app_private.guard_worksheet_bank_terminal_rescue_failure_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting(
    'app.worksheet_bank_terminal_rescue_failure_write',
    true
  ) is distinct from 'on'
  then
    raise exception using
      errcode = '42501',
      message = 'worksheet_bank_terminal_rescue_failure_write_required';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function
  app_private.guard_worksheet_bank_terminal_rescue_failure_write()
from public, anon, authenticated, service_role;

create trigger worksheet_bank_terminal_rescue_failures_00_guard
before insert or update or delete
on app_private.worksheet_bank_terminal_rescue_failures
for each row execute function
  app_private.guard_worksheet_bank_terminal_rescue_failure_write();

create or replace function
  app_private.resolve_terminal_rescue_failure_if_assignment_ready(
    target_assignment_id uuid
  )
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_assignment public.student_practice_assignments%rowtype;
  resolution_time timestamptz := clock_timestamp();
  previous_write_setting text := current_setting(
    'app.worksheet_bank_terminal_rescue_failure_write',
    true
  );
begin
  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if selected_assignment.id is null
    or selected_assignment.practice_test_id is null
    or selected_assignment.generation_status <> 'ready'
  then
    return false;
  end if;

  perform set_config(
    'app.worksheet_bank_terminal_rescue_failure_write',
    'on',
    true
  );
  update app_private.worksheet_bank_terminal_rescue_failures failure
  set
    last_attempt_at = resolution_time,
    next_retry_at = resolution_time,
    last_safe_error_code = 'worksheet_bank_rescue_resolved',
    resolved_at = resolution_time
  where failure.assignment_id = selected_assignment.id
    and failure.resolved_at is null;
  perform set_config(
    'app.worksheet_bank_terminal_rescue_failure_write',
    coalesce(previous_write_setting, ''),
    true
  );

  return true;
end;
$$;

revoke all on function
  app_private.resolve_terminal_rescue_failure_if_assignment_ready(uuid)
from public, anon, authenticated, service_role;

create or replace function
  app_private.resolve_terminal_rescue_failure_on_assignment_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.practice_test_id is not null
    and new.generation_status = 'ready'
  then
    if tg_op = 'INSERT' then
      perform app_private.resolve_terminal_rescue_failure_if_assignment_ready(
        new.id
      );
    elsif old.practice_test_id is distinct from new.practice_test_id
      or old.generation_status is distinct from new.generation_status
    then
      perform app_private.resolve_terminal_rescue_failure_if_assignment_ready(
        new.id
      );
    end if;
  end if;
  return new;
end;
$$;

revoke all on function
  app_private.resolve_terminal_rescue_failure_on_assignment_ready()
from public, anon, authenticated, service_role;

create trigger student_practice_assignments_resolve_terminal_rescue_failure
after insert or update of practice_test_id, generation_status
on public.student_practice_assignments
for each row execute function
  app_private.resolve_terminal_rescue_failure_on_assignment_ready();

create or replace function app_private.guard_worksheet_bank_terminal_rescue_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.worksheet_bank_terminal_rescue_insert', true)
      is distinct from 'on'
    or not exists (
      select 1
      from public.student_practice_assignments assignment
      join public.practice_tests worksheet
        on worksheet.id = new.cloned_practice_test_id
       and worksheet.workspace_id = assignment.workspace_id
       and worksheet.worksheet_template_revision_id = new.template_revision_id
       and worksheet.quality_status = 'approved'
       and worksheet.teacher_reviewed = true
      where assignment.id = new.assignment_id
        and assignment.workspace_id = new.workspace_id
        and assignment.student_id = new.student_id
        and assignment.practice_test_id = new.cloned_practice_test_id
        and assignment.generation_status = 'ready'
        and app_private.practice_test_canonical_revision_is_current(
          worksheet.id
        )
    )
    or (
      new.job_id is not null
      and not exists (
        select 1
        from app_private.async_jobs job
        where job.id = new.job_id
          and job.job_kind = 'worksheet_generation'
          and job.entity_id = new.assignment_id
          and job.status in ('succeeded', 'dead')
      )
    )
  then
    raise exception using
      errcode = '42501',
      message = 'worksheet_bank_terminal_rescue_required';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_bank_terminal_rescue_insert()
from public, anon, authenticated, service_role;

create trigger worksheet_bank_terminal_rescue_events_00_guard
before insert on app_private.worksheet_bank_terminal_rescue_events
for each row execute function
  app_private.guard_worksheet_bank_terminal_rescue_insert();

create trigger worksheet_bank_terminal_rescue_events_immutable
before update or delete on app_private.worksheet_bank_terminal_rescue_events
for each row execute function app_private.reject_worksheet_bank_history_mutation();

-- Serialize every clone with withdrawal and reviewer-coverage mutations. The
-- immutable topic/level snapshot is resolved before any row lock so every
-- writer takes the coverage advisory first. Reviewer mutations use a
-- non-blocking acquisition of the same advisory and therefore retry rather
-- than deadlock after locking an attester row.
create or replace function app_private.clone_released_worksheet_template(
  target_workspace_id uuid,
  target_revision_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  snapshot_template_id uuid;
  snapshot_grammar_topic_id uuid;
  snapshot_topic_slug text;
  snapshot_level text;
  selected_revision app_private.practice_worksheet_template_revisions%rowtype;
  selected_template app_private.practice_worksheet_templates%rowtype;
  selected_review app_private.practice_worksheet_template_reviews%rowtype;
  selected_release app_private.practice_worksheet_template_releases%rowtype;
  selected_reviewer app_private.practice_worksheet_bank_reviewers%rowtype;
  selected_releaser app_private.practice_worksheet_bank_reviewers%rowtype;
  existing_test public.practice_tests%rowtype;
  cloned_test_id uuid;
  actual_template_hash text;
  actual_clone_hash text;
begin
  if target_workspace_id is null or target_revision_id is null then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_clone_context_required';
  end if;
  if not exists (
    select 1
    from public.workspaces workspace
    where workspace.id = target_workspace_id
  ) then
    raise exception using errcode = 'P0002', message = 'workspace_not_found';
  end if;

  select
    revision.template_id,
    template.grammar_topic_id,
    topic.slug,
    template.level
  into
    snapshot_template_id,
    snapshot_grammar_topic_id,
    snapshot_topic_slug,
    snapshot_level
  from app_private.practice_worksheet_template_revisions revision
  join app_private.practice_worksheet_templates template
    on template.id = revision.template_id
  join public.grammar_topics topic
    on topic.id = template.grammar_topic_id
  join app_private.grammar_topic_contracts contract
    on contract.slug = topic.slug
  where revision.id = target_revision_id;

  if snapshot_template_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'worksheet_bank_release_not_found';
  end if;
  if snapshot_grammar_topic_id is null
    or snapshot_topic_slug is null
    or snapshot_level not in ('A1', 'A2', 'B1', 'B2')
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_clone_context_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat_ws(
      ':',
      'worksheet-bank-withdrawal-coverage',
      snapshot_grammar_topic_id::text,
      snapshot_topic_slug,
      snapshot_level
    ),
    0
  ));

  perform pg_advisory_xact_lock(hashtextextended(
    concat(
      'worksheet-bank-clone:',
      target_workspace_id::text,
      ':',
      target_revision_id::text
    ),
    0
  ));

  select revision.*
  into selected_revision
  from app_private.practice_worksheet_template_revisions revision
  where revision.id = target_revision_id
  for share;

  if selected_revision.id is null
    or selected_revision.state <> 'released'
    or selected_revision.template_id is distinct from snapshot_template_id
  then
    raise exception using
      errcode = 'P0002',
      message = 'worksheet_bank_release_not_found';
  end if;

  select template.*
  into selected_template
  from app_private.practice_worksheet_templates template
  where template.id = selected_revision.template_id
  for share;

  select review.*
  into selected_review
  from app_private.practice_worksheet_template_reviews review
  where review.revision_id = selected_revision.id
    and review.decision = 'approved'
  for share;

  select release.*
  into selected_release
  from app_private.practice_worksheet_template_releases release
  where release.revision_id = selected_revision.id
    and release.review_id = selected_review.id
  for share;

  -- One sorted lock query avoids reviewer/releaser lock inversion when two
  -- revisions use the same attesters in opposite roles.
  perform attester.user_id
  from app_private.practice_worksheet_bank_reviewers attester
  where attester.user_id in (
    selected_review.reviewer_id,
    selected_release.released_by
  )
  order by attester.user_id
  for share;

  select reviewer.*
  into selected_reviewer
  from app_private.practice_worksheet_bank_reviewers reviewer
  where reviewer.user_id = selected_review.reviewer_id;

  select releaser.*
  into selected_releaser
  from app_private.practice_worksheet_bank_reviewers releaser
  where releaser.user_id = selected_release.released_by;

  actual_template_hash :=
    app_private.practice_worksheet_template_revision_sha256(
      selected_revision.id
    );

  if selected_template.id is null
    or selected_template.id is distinct from snapshot_template_id
    or selected_template.grammar_topic_id is distinct from
      snapshot_grammar_topic_id
    or selected_template.level is distinct from snapshot_level
    or selected_review.id is null
    or selected_release.id is null
    or selected_reviewer.user_id is null
    or not selected_reviewer.active
    or not selected_reviewer.can_certify
    or selected_reviewer.verified_at > selected_review.reviewed_at
    or (
      selected_reviewer.expires_at is not null
      and selected_reviewer.expires_at <= greatest(
        selected_review.reviewed_at,
        now()
      )
    )
    or selected_releaser.user_id is null
    or not selected_releaser.active
    or not selected_releaser.can_release
    or selected_releaser.verified_at > selected_release.released_at
    or (
      selected_releaser.expires_at is not null
      and selected_releaser.expires_at <= greatest(
        selected_release.released_at,
        now()
      )
    )
    or exists (
      select 1
      from app_private.practice_worksheet_template_withdrawals withdrawal
      where withdrawal.revision_id = selected_revision.id
    )
    or actual_template_hash is distinct from selected_revision.content_sha256
    or selected_review.content_sha256 is distinct from
      selected_revision.content_sha256
    or selected_release.content_sha256 is distinct from
      selected_revision.content_sha256
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_release_hash_mismatch';
  end if;

  select test.*
  into existing_test
  from public.practice_tests test
  where test.workspace_id = target_workspace_id
    and test.worksheet_template_revision_id = selected_revision.id
  limit 1;

  if existing_test.id is not null then
    actual_clone_hash :=
      app_private.practice_test_content_sha256(existing_test.id);
    if existing_test.worksheet_template_release_id <> selected_release.id
      or existing_test.approval_source <> 'certified_template_bank'
      or existing_test.template_content_sha256 <>
        selected_revision.content_sha256
      or actual_clone_hash is distinct from selected_revision.content_sha256
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_bank_existing_clone_invalid';
    end if;
    return existing_test.id;
  end if;

  perform set_config('app.allow_certified_template_clone_insert', 'on', true);
  insert into public.practice_tests (
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
    quality_status,
    quality_notes,
    reviewed_by,
    reviewed_at,
    generation_metadata,
    worksheet_template_revision_id,
    worksheet_template_release_id,
    approval_source,
    template_content_sha256
  ) values (
    target_workspace_id,
    selected_template.grammar_topic_id,
    selected_template.level,
    selected_revision.difficulty,
    selected_revision.title,
    selected_revision.description,
    false,
    true,
    'workspace',
    selected_revision.created_by,
    selected_revision.mini_lesson,
    'certified_bank',
    'approved',
    concat(
      'certified_template_revision=', selected_revision.id::text,
      '; template_release=', selected_release.id::text,
      '; content_sha256=', selected_revision.content_sha256
    ),
    selected_review.reviewer_id,
    selected_review.reviewed_at,
    jsonb_build_object(
      'schema_version', 1,
      'approval_source', 'certified_template_bank',
      'template_revision_id', selected_revision.id,
      'template_release_id', selected_release.id,
      'content_sha256', selected_revision.content_sha256
    ),
    selected_revision.id,
    selected_release.id,
    'certified_template_bank',
    selected_revision.content_sha256
  ) returning id into cloned_test_id;

  insert into public.practice_test_questions (
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
    cloned_test_id,
    question.question_number,
    question.question_type,
    question.evaluation_mode,
    question.prompt,
    question.options,
    question.correct_answer,
    question.accepted_answers,
    question.rubric,
    question.answer_contract_version,
    question.explanation
  from app_private.practice_worksheet_template_questions question
  where question.revision_id = selected_revision.id
  order by question.question_number;
  perform set_config('app.allow_certified_template_clone_insert', 'off', true);

  actual_clone_hash :=
    app_private.practice_test_content_sha256(cloned_test_id);
  if actual_clone_hash is distinct from selected_revision.content_sha256 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_clone_hash_mismatch';
  end if;

  return cloned_test_id;
end;
$$;

revoke all on function app_private.clone_released_worksheet_template(
  uuid, uuid
)
from public, anon, authenticated, service_role;

create or replace function app_private.attach_current_certified_worksheet_for_recovery(
  target_assignment_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  assignment_snapshot public.student_practice_assignments%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_job app_private.async_jobs%rowtype;
  selected_revision_id uuid;
  cloned_test_id uuid;
  prior_generation_status text;
  clone_attempt integer;
begin
  select assignment.*
  into assignment_snapshot
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if assignment_snapshot.id is null
    or assignment_snapshot.status <> 'unlocked'
    or assignment_snapshot.practice_test_id is not null
    or assignment_snapshot.started_at is not null
    or assignment_snapshot.latest_attempt_id is not null
    or assignment_snapshot.class_context_version is distinct from 1
    or assignment_snapshot.class_context_integrity is null
    or assignment_snapshot.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or assignment_snapshot.batch_id is null
    or assignment_snapshot.worksheet_level is null
    or assignment_snapshot.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
  then
    return false;
  end if;

  if not app_private.lock_active_practice_class_context(
    assignment_snapshot.workspace_id,
    assignment_snapshot.student_id,
    assignment_snapshot.batch_id,
    assignment_snapshot.worksheet_level
  ) then
    return false;
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.job_kind = 'worksheet_generation'
    and job.entity_id = assignment_snapshot.id
    and job.status in ('queued', 'retry', 'processing')
  order by job.entity_version desc
  limit 1
  for update;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = assignment_snapshot.id
  for update;

  if selected_assignment.workspace_id is distinct from assignment_snapshot.workspace_id
    or selected_assignment.student_id is distinct from assignment_snapshot.student_id
    or selected_assignment.grammar_topic_id is distinct from assignment_snapshot.grammar_topic_id
    or selected_assignment.batch_id is distinct from assignment_snapshot.batch_id
    or selected_assignment.worksheet_level is distinct from assignment_snapshot.worksheet_level
    or selected_assignment.class_context_version is distinct from 1
    or selected_assignment.class_context_integrity is null
    or selected_assignment.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or selected_assignment.worksheet_level is null
    or selected_assignment.status <> 'unlocked'
    or selected_assignment.practice_test_id is not null
    or selected_assignment.started_at is not null
    or selected_assignment.latest_attempt_id is not null
    or (
      selected_job.id is not null
      and selected_job.status = 'processing'
      and selected_job.lease_expires_at is not null
      and selected_job.lease_expires_at > now()
    )
  then
    return false;
  end if;

  for clone_attempt in 1..2 loop
    selected_revision_id := public.select_released_worksheet_template_internal(
      selected_assignment.workspace_id,
      selected_assignment.student_id,
      selected_assignment.grammar_topic_id,
      selected_assignment.worksheet_level
    );
    exit when selected_revision_id is null;

    begin
      cloned_test_id := app_private.clone_released_worksheet_template(
        selected_assignment.workspace_id,
        selected_revision_id
      );
      exit;
    exception when sqlstate 'P0002' then
      if sqlerrm <> 'worksheet_bank_release_not_found' then raise; end if;
      selected_revision_id := null;
      cloned_test_id := null;
    end;
  end loop;

  if selected_revision_id is null or cloned_test_id is null then
    return false;
  end if;

  prior_generation_status := selected_assignment.generation_status;

  if selected_job.id is not null then
    if selected_job.queue_message_id is not null then
      perform pgmq.archive(
        selected_job.queue_name,
        selected_job.queue_message_id
      );
    end if;

    update app_private.async_jobs job
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'certified_bank_attached'
    where job.id = selected_job.id;
  end if;

  update public.student_practice_assignments assignment
  set
    practice_test_id = cloned_test_id,
    generation_status = 'ready',
    generation_started_at = null,
    generation_completed_at = now(),
    generation_error = null
  where assignment.id = selected_assignment.id;

  perform set_config('app.worksheet_bank_terminal_rescue_insert', 'on', true);
  insert into app_private.worksheet_bank_terminal_rescue_events (
    assignment_id,
    job_id,
    workspace_id,
    student_id,
    template_revision_id,
    cloned_practice_test_id,
    prior_generation_status,
    rescue_source
  ) values (
    selected_assignment.id,
    coalesce(
      selected_job.id,
      (
        select job.id
        from app_private.async_jobs job
        where job.job_kind = 'worksheet_generation'
          and job.entity_id = selected_assignment.id
          and job.status in ('succeeded', 'dead')
        order by job.entity_version desc
        limit 1
      )
    ),
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_revision_id,
    cloned_test_id,
    prior_generation_status,
    'recovery_sweep'
  ) on conflict (assignment_id, cloned_practice_test_id) do nothing;
  perform set_config('app.worksheet_bank_terminal_rescue_insert', 'off', true);

  return true;
end;
$$;

revoke all on function app_private.attach_current_certified_worksheet_for_recovery(uuid)
from public, anon, authenticated, service_role;

create or replace function api.recover_current_certified_worksheet_assignments(
  max_assignments integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_limit integer := least(greatest(coalesce(max_assignments, 25), 0), 50);
  candidate record;
  attempted_count integer := 0;
  succeeded_count integer := 0;
  failed_count integer := 0;
  deferred_count integer := 0;
  exhausted_count integer := 0;
  failure_sqlstate text;
  failure_message text;
  safe_error_code text;
begin
  perform app_private.assert_service_role();

  for candidate in
    select assignment.id, eligible.template_revision_id
    from public.student_practice_assignments assignment
    cross join lateral (
      select public.select_released_worksheet_template_internal(
        assignment.workspace_id,
        assignment.student_id,
        assignment.grammar_topic_id,
        assignment.worksheet_level
      ) as template_revision_id
    ) eligible
    left join app_private.worksheet_bank_terminal_rescue_failures failure
      on failure.assignment_id = assignment.id
    where assignment.status = 'unlocked'
      and assignment.practice_test_id is null
      and assignment.started_at is null
      and assignment.latest_attempt_id is null
      and assignment.class_context_version = 1
      and assignment.class_context_integrity in (
        'writing_snapshot', 'teacher_verified'
      )
      and assignment.batch_id is not null
      and assignment.worksheet_level in ('A1', 'A2', 'B1', 'B2')
      and app_private.practice_class_context_is_active(
        assignment.workspace_id,
        assignment.student_id,
        assignment.batch_id,
        assignment.worksheet_level
      )
      and eligible.template_revision_id is not null
      -- A live provider owns delivery until its lease expires. Excluding it
      -- before LIMIT means active work cannot consume or starve this batch.
      and not exists (
        select 1
        from app_private.async_jobs active_job
        where active_job.job_kind = 'worksheet_generation'
          and active_job.entity_id = assignment.id
          and active_job.status = 'processing'
          and active_job.lease_expires_at is not null
          and active_job.lease_expires_at > now()
      )
      -- Backoff applies only to the same still-current revision. A later
      -- qualified revision is immediately eligible and starts a fresh cycle.
      and (
        failure.assignment_id is null
        or failure.resolved_at is not null
        or failure.template_revision_id is distinct from eligible.template_revision_id
        or (
          failure.failure_count < 5
          and failure.next_retry_at <= now()
        )
      )
    order by
      case
        when failure.assignment_id is not null
          and failure.resolved_at is null
          and failure.template_revision_id = eligible.template_revision_id
        then 1
        else 0
      end,
      coalesce(failure.failure_count, 0),
      assignment.updated_at,
      assignment.id
    limit clean_limit * 4
  loop
    exit when attempted_count >= clean_limit;

    begin
      if app_private.attach_current_certified_worksheet_for_recovery(
        candidate.id
      ) then
        perform set_config(
          'app.worksheet_bank_terminal_rescue_failure_write',
          'on',
          true
        );
        update app_private.worksheet_bank_terminal_rescue_failures failure
        set
          last_attempt_at = now(),
          next_retry_at = now(),
          last_safe_error_code = 'worksheet_bank_rescue_resolved',
          resolved_at = now()
        where failure.assignment_id = candidate.id;
        perform set_config(
          'app.worksheet_bank_terminal_rescue_failure_write',
          'off',
          true
        );

        attempted_count := attempted_count + 1;
        succeeded_count := succeeded_count + 1;
      else
        -- False means the row became ineligible, an active lease won the race,
        -- or the selected revision changed. It was not executed work, so it is
        -- deferred rather than included in attempted/succeeded/failed.
        -- Re-lock and re-read the assignment before touching the ledger. A
        -- concurrent recovery or active worker may already have delivered;
        -- that winner owns the terminal state and the ledger must stay
        -- resolved rather than being reopened by this loser.
        if app_private.resolve_terminal_rescue_failure_if_assignment_ready(
          candidate.id
        ) then
          deferred_count := deferred_count + 1;
          continue;
        end if;

        perform set_config(
          'app.worksheet_bank_terminal_rescue_failure_write',
          'on',
          true
        );
        insert into app_private.worksheet_bank_terminal_rescue_failures (
          assignment_id,
          template_revision_id,
          failure_count,
          first_failed_at,
          last_attempt_at,
          next_retry_at,
          last_safe_error_code,
          resolved_at
        ) values (
          candidate.id,
          candidate.template_revision_id,
          0,
          null,
          now(),
          now() + interval '15 seconds',
          'worksheet_bank_rescue_deferred',
          null
        )
        on conflict (assignment_id) do update
        set
          template_revision_id = excluded.template_revision_id,
          failure_count = case
            when app_private.worksheet_bank_terminal_rescue_failures.resolved_at
                is null
              and app_private.worksheet_bank_terminal_rescue_failures.template_revision_id
                = excluded.template_revision_id
            then app_private.worksheet_bank_terminal_rescue_failures.failure_count
            else 0
          end,
          first_failed_at = case
            when app_private.worksheet_bank_terminal_rescue_failures.resolved_at
                is null
              and app_private.worksheet_bank_terminal_rescue_failures.template_revision_id
                = excluded.template_revision_id
            then app_private.worksheet_bank_terminal_rescue_failures.first_failed_at
            else null
          end,
          last_attempt_at = now(),
          next_retry_at = now() + interval '15 seconds',
          last_safe_error_code = 'worksheet_bank_rescue_deferred',
          resolved_at = null;
        perform set_config(
          'app.worksheet_bank_terminal_rescue_failure_write',
          'off',
          true
        );

        deferred_count := deferred_count + 1;
      end if;
    exception when others then
      get stacked diagnostics
        failure_sqlstate = returned_sqlstate,
        failure_message = message_text;

      -- An independent winner can complete while this attempt unwinds. Lock
      -- the assignment before recording an error; the ready-state trigger
      -- also resolves any earlier failure after a winner that was waiting on
      -- this lock commits.
      if app_private.resolve_terminal_rescue_failure_if_assignment_ready(
        candidate.id
      ) then
        deferred_count := deferred_count + 1;
        continue;
      end if;

      safe_error_code := case
        when failure_sqlstate = '40001'
          then 'worksheet_bank_rescue_serialization_failure'
        when failure_sqlstate = '40P01'
          then 'worksheet_bank_rescue_deadlock'
        when failure_sqlstate = '55P03'
          then 'worksheet_bank_rescue_lock_unavailable'
        when failure_sqlstate = '57014'
          then 'worksheet_bank_rescue_query_cancelled'
        when failure_sqlstate = '23503'
          then 'worksheet_bank_rescue_reference_conflict'
        when failure_sqlstate = '23505'
          then 'worksheet_bank_rescue_unique_conflict'
        when failure_message = 'worksheet_bank_release_not_found'
          then 'worksheet_bank_rescue_release_not_found'
        when failure_message = 'worksheet_bank_revision_not_eligible'
          then 'worksheet_bank_rescue_revision_not_eligible'
        else 'worksheet_bank_rescue_internal_failure'
      end;

      perform set_config(
        'app.worksheet_bank_terminal_rescue_failure_write',
        'on',
        true
      );
      insert into app_private.worksheet_bank_terminal_rescue_failures (
        assignment_id,
        template_revision_id,
        failure_count,
        first_failed_at,
        last_attempt_at,
        next_retry_at,
        last_safe_error_code,
        resolved_at
      ) values (
        candidate.id,
        candidate.template_revision_id,
        1,
        now(),
        now(),
        now() + interval '30 seconds',
        safe_error_code,
        null
      )
      on conflict (assignment_id) do update
      set
        template_revision_id = excluded.template_revision_id,
        failure_count = case
          when app_private.worksheet_bank_terminal_rescue_failures.resolved_at
              is null
            and app_private.worksheet_bank_terminal_rescue_failures.template_revision_id
              = excluded.template_revision_id
          then least(
            5,
            app_private.worksheet_bank_terminal_rescue_failures.failure_count + 1
          )
          else 1
        end,
        first_failed_at = case
          when app_private.worksheet_bank_terminal_rescue_failures.resolved_at
              is null
            and app_private.worksheet_bank_terminal_rescue_failures.template_revision_id
              = excluded.template_revision_id
            and app_private.worksheet_bank_terminal_rescue_failures.failure_count > 0
          then app_private.worksheet_bank_terminal_rescue_failures.first_failed_at
          else now()
        end,
        last_attempt_at = now(),
        next_retry_at = now() + case
          when app_private.worksheet_bank_terminal_rescue_failures.resolved_at
              is not null
            or app_private.worksheet_bank_terminal_rescue_failures.template_revision_id
              is distinct from excluded.template_revision_id
          then interval '30 seconds'
          when app_private.worksheet_bank_terminal_rescue_failures.failure_count <= 0
          then interval '30 seconds'
          when app_private.worksheet_bank_terminal_rescue_failures.failure_count = 1
          then interval '1 minute'
          when app_private.worksheet_bank_terminal_rescue_failures.failure_count = 2
          then interval '5 minutes'
          when app_private.worksheet_bank_terminal_rescue_failures.failure_count = 3
          then interval '15 minutes'
          else interval '30 minutes'
        end,
        last_safe_error_code = excluded.last_safe_error_code,
        resolved_at = null;
      perform set_config(
        'app.worksheet_bank_terminal_rescue_failure_write',
        'off',
        true
      );

      attempted_count := attempted_count + 1;
      failed_count := failed_count + 1;
    end;
  end loop;

  -- Exhaustion is independent backlog health, not an attempted outcome. Only
  -- the same current qualified revision in an otherwise eligible assignment
  -- counts; withdrawn/expired/replaced material and active leases are omitted.
  select count(*)::integer
  into exhausted_count
  from app_private.worksheet_bank_terminal_rescue_failures failure
  join public.student_practice_assignments assignment
    on assignment.id = failure.assignment_id
  cross join lateral (
    select public.select_released_worksheet_template_internal(
      assignment.workspace_id,
      assignment.student_id,
      assignment.grammar_topic_id,
      assignment.worksheet_level
    ) as template_revision_id
  ) eligible
  where failure.resolved_at is null
    and failure.failure_count >= 5
    and failure.template_revision_id = eligible.template_revision_id
    and assignment.status = 'unlocked'
    and assignment.practice_test_id is null
    and assignment.started_at is null
    and assignment.latest_attempt_id is null
    and assignment.class_context_version = 1
    and assignment.class_context_integrity in (
      'writing_snapshot', 'teacher_verified'
    )
    and assignment.batch_id is not null
    and assignment.worksheet_level in ('A1', 'A2', 'B1', 'B2')
    and app_private.practice_class_context_is_active(
      assignment.workspace_id,
      assignment.student_id,
      assignment.batch_id,
      assignment.worksheet_level
    )
    and eligible.template_revision_id is not null
    and not exists (
      select 1
      from app_private.async_jobs active_job
      where active_job.job_kind = 'worksheet_generation'
        and active_job.entity_id = assignment.id
        and active_job.status = 'processing'
        and active_job.lease_expires_at is not null
        and active_job.lease_expires_at > now()
    );

  return jsonb_build_object(
    'schema_version', 1,
    'attempted', attempted_count,
    'succeeded', succeeded_count,
    'failed', failed_count,
    'deferred', deferred_count,
    'exhausted', exhausted_count
  );
end;
$$;

revoke all on function api.recover_current_certified_worksheet_assignments(integer)
from public, anon, authenticated, service_role;
grant execute on function api.recover_current_certified_worksheet_assignments(integer)
to service_role;

create or replace function api.reset_worksheet_bank_terminal_rescue_failure(
  target_assignment_id uuid,
  expected_template_revision_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_assignment public.student_practice_assignments%rowtype;
  selected_failure
    app_private.worksheet_bank_terminal_rescue_failures%rowtype;
  current_revision_id uuid;
  reset_time timestamptz := clock_timestamp();
  reset_count integer := 0;
begin
  perform app_private.assert_service_role();

  if target_assignment_id is null
    or expected_template_revision_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_rescue_reset_context_required';
  end if;

  -- Canonical lock order is assignment, then operational failure row.
  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if selected_assignment.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'worksheet_bank_rescue_assignment_not_found';
  end if;

  select failure.*
  into selected_failure
  from app_private.worksheet_bank_terminal_rescue_failures failure
  where failure.assignment_id = selected_assignment.id
  for update;

  if selected_assignment.practice_test_id is not null
    and selected_assignment.generation_status = 'ready'
  then
    perform app_private.resolve_terminal_rescue_failure_if_assignment_ready(
      selected_assignment.id
    );
    return jsonb_build_object(
      'schema_version', 1,
      'reset', false,
      'state', 'already_ready'
    );
  end if;

  if selected_failure.assignment_id is null then
    return jsonb_build_object(
      'schema_version', 1,
      'reset', false,
      'state', 'not_found'
    );
  end if;

  if selected_failure.resolved_at is not null then
    return jsonb_build_object(
      'schema_version', 1,
      'reset', false,
      'state', 'already_resolved'
    );
  end if;

  if selected_failure.failure_count < 5
    or selected_failure.template_revision_id is distinct from
      expected_template_revision_id
  then
    raise exception using
      errcode = '40001',
      message = 'worksheet_bank_rescue_reset_revision_conflict';
  end if;

  current_revision_id := public.select_released_worksheet_template_internal(
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id,
    selected_assignment.worksheet_level
  );

  if current_revision_id is distinct from expected_template_revision_id
    or selected_assignment.status <> 'unlocked'
    or selected_assignment.practice_test_id is not null
    or selected_assignment.started_at is not null
    or selected_assignment.latest_attempt_id is not null
    or selected_assignment.batch_id is null
    or selected_assignment.class_context_version is distinct from 1
    or selected_assignment.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or selected_assignment.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
    or not app_private.practice_class_context_is_active(
      selected_assignment.workspace_id,
      selected_assignment.student_id,
      selected_assignment.batch_id,
      selected_assignment.worksheet_level
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_rescue_reset_not_eligible';
  end if;

  perform set_config(
    'app.worksheet_bank_terminal_rescue_failure_write',
    'on',
    true
  );
  update app_private.worksheet_bank_terminal_rescue_failures failure
  set
    failure_count = 0,
    first_failed_at = null,
    last_attempt_at = reset_time,
    next_retry_at = reset_time,
    last_safe_error_code = 'worksheet_bank_rescue_operator_reset',
    resolved_at = null
  where failure.assignment_id = selected_assignment.id
    and failure.template_revision_id = expected_template_revision_id
    and failure.resolved_at is null
    and failure.failure_count >= 5;
  get diagnostics reset_count = row_count;
  perform set_config(
    'app.worksheet_bank_terminal_rescue_failure_write',
    'off',
    true
  );

  if reset_count <> 1 then
    raise exception using
      errcode = '40001',
      message = 'worksheet_bank_rescue_reset_revision_conflict';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'reset', true,
    'state', 'retry_ready',
    'assignment_id', selected_assignment.id,
    'template_revision_id', expected_template_revision_id
  );
end;
$$;

revoke all on function api.reset_worksheet_bank_terminal_rescue_failure(
  uuid, uuid
)
from public, anon, authenticated, service_role;
grant execute on function api.reset_worksheet_bank_terminal_rescue_failure(
  uuid, uuid
)
to service_role;

-- ---------------------------------------------------------------------------
-- Truthful client state: compute retry exhaustion from the immutable job count
-- and private configured cap, while keeping raw job/error details private.
-- ---------------------------------------------------------------------------

do $migration$
declare
  function_definition text;
  return_anchor constant text := $fragment$
  return payload;
$fragment$;
  return_replacement constant text := $fragment$
  payload := payload || jsonb_build_object(
    'generation_retry_exhausted',
    selected_assignment.practice_test_id is null
      and selected_assignment.generation_status = 'failed'
      and coalesce((
        select count(*) >= 1 + limits.max_manual_generation_requeues_per_assignment
        from app_private.ai_paid_work_limits limits
        cross join app_private.async_jobs job
        where limits.singleton
          and job.job_kind = 'worksheet_generation'
          and job.entity_id = selected_assignment.id
        group by limits.max_manual_generation_requeues_per_assignment
      ), false)
  );

  return payload;
$fragment$;
begin
  select pg_get_functiondef(
    'public.get_practice_assignment_summary_internal(uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or (
      length(function_definition)
      - length(replace(function_definition, return_anchor, ''))
    ) <> length(return_anchor)
  then
    raise exception using
      errcode = '55000',
      message = 'practice_generation_retry_projection_patch_mismatch';
  end if;

  execute replace(
    function_definition,
    return_anchor,
    return_replacement
  );
end;
$migration$;

comment on function api.try_complete_current_certified_worksheet_bank_fallback(
  uuid, bigint, uuid, text, jsonb
) is
  'Service-only final worker check. It atomically prefers an exact currently qualified, hash-valid, non-withdrawn canonical revision before a worksheet job becomes terminal.';
comment on function api.recover_current_certified_worksheet_assignments(integer) is
  'Service-only bounded recovery sweep. It attaches exact current canonical material to untouched worksheet-less assignments after terminal or missing worker delivery, with private safe-code backoff and exhaustion visibility.';
comment on function api.reset_worksheet_bank_terminal_rescue_failure(uuid, uuid) is
  'Service-only, revision-safe reset for one still-eligible exhausted bank rescue. Ready or changed assignments cannot be reopened.';
comment on function app_private.clone_released_worksheet_template(uuid, uuid) is
  'Private immutable bank clone serialized with exact topic-level withdrawal and reviewer-qualification changes; revision, attesters, current qualification and hashes remain locked through commit.';
comment on table app_private.worksheet_bank_terminal_rescue_events is
  'Immutable content-free audit for exact certified worksheets attached by terminal recovery; no student answers or provider payloads.';
comment on table app_private.worksheet_bank_terminal_rescue_failures is
  'Private content-free recovery backoff ledger containing only IDs, bounded counters, timestamps and stable safe error codes.';

notify pgrst, 'reload schema';
