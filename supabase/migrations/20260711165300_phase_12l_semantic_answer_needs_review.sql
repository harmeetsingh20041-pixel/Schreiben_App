-- Phase 12L: independent semantic-answer adjudication and a private,
-- teacher-actionable needs-review terminal.
--
-- A flexible worksheet answer is not student-visible merely because one
-- provider returned schema-valid JSON. Automatic completion is reserved for
-- independently adjudicated results. Disagreement and bounded invalid-output
-- exhaustion are held privately; dual transient provider outages continue to
-- use the separate Phase 12J recovery lane.

alter table public.practice_test_attempts
  drop constraint if exists practice_test_attempts_evaluation_status_check;

alter table public.practice_test_attempts
  add constraint practice_test_attempts_evaluation_status_check
  check (
    evaluation_status in (
      'not_needed',
      'pending',
      'queued',
      'evaluating',
      'completed',
      'needs_review',
      'failed'
    )
  );

alter table public.practice_attempt_question_reviews
  drop constraint if exists practice_attempt_question_reviews_evaluator_source_check;

alter table public.practice_attempt_question_reviews
  add constraint practice_attempt_question_reviews_evaluator_source_check
  check (evaluator_source in ('deepseek', 'openai', 'teacher', 'manual', 'system'))
  not valid;

alter table public.practice_attempt_question_reviews
  validate constraint practice_attempt_question_reviews_evaluator_source_check;

-- Phase 12I recorded one provider for the whole completion. Phase 12L may
-- truthfully select DeepSeek for one disputed question and OpenAI for another,
-- so the summary provenance needs an explicit mixed pair as well.
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select constraint_def.conname
    from pg_catalog.pg_constraint constraint_def
    where constraint_def.conrelid =
      'app_private.worksheet_answer_completion_provenance'::regclass
      and constraint_def.contype = 'c'
      and pg_catalog.pg_get_constraintdef(constraint_def.oid)
        ilike '%provider_source%'
  loop
    execute pg_catalog.format(
      'alter table app_private.worksheet_answer_completion_provenance drop constraint %I',
      constraint_row.conname
    );
  end loop;
end;
$$;

alter table app_private.worksheet_answer_completion_provenance
  add constraint worksheet_answer_completion_provider_source_check
    check (
      provider_source in ('deepseek', 'openai', 'mixed')
      or provider_source is null
    ),
  add constraint worksheet_answer_completion_provider_model_check
    check (coalesce((
      (provider_source = 'deepseek' and evaluator_model = 'deepseek-v4-flash')
      or (
        provider_source = 'openai'
        and evaluator_model = 'gpt-5.4-mini-2026-03-17'
      )
      or (
        provider_source = 'mixed'
        and evaluator_model =
          'deepseek-v4-flash+gpt-5.4-mini-2026-03-17'
      )
      or (provider_source is null and evaluator_model is null)
    ), false));

create or replace function app_private.valid_worksheet_answer_source_map(
  selected_sources jsonb,
  expected_question_ids uuid[]
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  source_row jsonb;
  source_question_id uuid;
  seen_question_ids uuid[] := array[]::uuid[];
  normalized_seen uuid[];
  normalized_expected uuid[];
begin
  if selected_sources is null
    or jsonb_typeof(selected_sources) <> 'array'
    or jsonb_array_length(selected_sources) not between 1 and 3
    or jsonb_array_length(selected_sources) <>
      coalesce(cardinality(expected_question_ids), 0)
  then
    return false;
  end if;

  for source_row in
    select value
    from jsonb_array_elements(selected_sources)
  loop
    if jsonb_typeof(source_row) <> 'object'
      or not (source_row ?& array['question_id', 'provider_source'])
      or source_row - array['question_id', 'provider_source']::text[] <>
        '{}'::jsonb
      or coalesce(source_row ->> 'question_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(source_row ->> 'provider_source', '')
        not in ('deepseek', 'openai')
    then
      return false;
    end if;

    source_question_id := (source_row ->> 'question_id')::uuid;
    if source_question_id = any(seen_question_ids) then
      return false;
    end if;
    seen_question_ids := array_append(seen_question_ids, source_question_id);
  end loop;

  select coalesce(array_agg(value order by value), array[]::uuid[])
  into normalized_seen
  from unnest(seen_question_ids) value;

  select coalesce(array_agg(value order by value), array[]::uuid[])
  into normalized_expected
  from unnest(coalesce(expected_question_ids, array[]::uuid[])) value;

  return normalized_seen = normalized_expected;
end;
$$;

revoke all on function app_private.valid_worksheet_answer_source_map(
  jsonb, uuid[]
) from public, anon, authenticated, service_role;

create or replace function app_private.reject_submitted_practice_answer_change()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if new.answers is distinct from old.answers then
    -- The legacy submitter creates an empty in-progress row and fills its
    -- answers in the same transaction that terminalizes the attempt. This is
    -- the only legitimate answer mutation. Once submitted, even service-role
    -- retries must use the immutable result/evidence contracts instead.
    if not (
      old.status = 'in_progress'
      and new.status in ('submitted', 'checked')
      and old.submitted_at is null
      and new.submitted_at is not null
      and old.answers = '[]'::jsonb
      and jsonb_typeof(new.answers) = 'array'
    ) then
      raise exception using
        errcode = '55000',
        message = 'submitted_practice_answers_immutable';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app_private.reject_submitted_practice_answer_change()
from public, anon, authenticated, service_role;

drop trigger if exists practice_attempt_answers_immutable
on public.practice_test_attempts;
create trigger practice_attempt_answers_immutable
before update of answers on public.practice_test_attempts
for each row execute function
  app_private.reject_submitted_practice_answer_change();

-- Preserve the draft revision on the immutable attempt so a lost HTTP response
-- can be retried exactly after the draft was deleted. The replay returns the
-- current actor-authorized read model and never writes the answers again.
alter table public.practice_test_attempts
  add column if not exists submit_draft_revision integer
  check (submit_draft_revision is null or submit_draft_revision > 0);

alter function public.submit_practice_draft_internal(uuid, integer)
  rename to submit_practice_draft_internal_phase_12l_once;

revoke all on function public.submit_practice_draft_internal_phase_12l_once(
  uuid, integer
) from public, anon, authenticated, service_role;

create or replace function public.submit_practice_draft_internal(
  target_assignment_id uuid,
  expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  selected_attempt public.practice_test_attempts%rowtype;
  submitted_result jsonb;
  submitted_attempt_id uuid;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if expected_revision is null or expected_revision <= 0 then
    raise exception using errcode = '22023', message = 'draft_revision_invalid';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
    and assignment.student_id = caller_id
  for update;

  if selected_assignment.id is not null
    and selected_assignment.latest_attempt_id is not null
  then
    select attempt.*
    into selected_attempt
    from public.practice_test_attempts attempt
    where attempt.id = selected_assignment.latest_attempt_id
      and attempt.assignment_id = selected_assignment.id
      and attempt.student_id = caller_id
    for update;

    if selected_attempt.id is not null
      and selected_assignment.status in ('completed', 'passed', 'failed')
      and selected_attempt.status in ('submitted', 'checked')
      and selected_attempt.submitted_at is not null
      and selected_attempt.submit_draft_revision is not null
    then
      if selected_attempt.submit_draft_revision <> expected_revision then
        raise exception using
          errcode = '40001',
          message = 'draft_revision_conflict';
      end if;
      return jsonb_build_object(
        'latest_attempt_id', selected_attempt.id,
        'replayed', true
      );
    end if;
  end if;

  select public.submit_practice_draft_internal_phase_12l_once(
    target_assignment_id,
    expected_revision
  )
  into submitted_result;

  if submitted_result is null
    or coalesce(submitted_result ->> 'latest_attempt_id', '') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    raise exception using errcode = '55000', message = 'practice_submit_failed';
  end if;

  submitted_attempt_id := (submitted_result ->> 'latest_attempt_id')::uuid;
  update public.practice_test_attempts attempt
  set submit_draft_revision = expected_revision
  where attempt.id = submitted_attempt_id
    and attempt.assignment_id = target_assignment_id
    and attempt.student_id = caller_id
    and attempt.status in ('submitted', 'checked')
    and attempt.submitted_at is not null
    and attempt.submit_draft_revision is null;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'practice_submit_receipt_not_persisted';
  end if;

  return submitted_result;
end;
$$;

revoke all on function public.submit_practice_draft_internal(uuid, integer)
from public, anon;
grant execute on function public.submit_practice_draft_internal(uuid, integer)
to authenticated, service_role;

create table app_private.practice_semantic_review_holds (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique
    references app_private.async_jobs(id) on delete restrict,
  attempt_id uuid not null
    references public.practice_test_attempts(id) on delete restrict,
  assignment_id uuid not null
    references public.student_practice_assignments(id) on delete restrict,
  workspace_id uuid not null
    references public.workspaces(id) on delete restrict,
  evaluation_version integer not null check (evaluation_version > 0),
  reason_code text not null check (
    reason_code in (
      'semantic_adjudication_disagreement',
      'semantic_provider_output_invalid',
      'semantic_provider_quality_invalid',
      'semantic_single_provider_incomplete',
      'semantic_adjudicator_not_configured',
      'semantic_provider_authentication_failed',
      'semantic_provider_configuration_failed'
    )
  ),
  ordinary_attempt_count integer not null
    check (ordinary_attempt_count between 1 and 3),
  provider_outage_epoch integer not null check (provider_outage_epoch in (0, 1)),
  provider_outage_recovery_count integer not null
    check (provider_outage_recovery_count between 0 and 10),
  held_at timestamptz not null default now(),
  unique (attempt_id, evaluation_version)
);

create index practice_semantic_review_holds_workspace_held_idx
on app_private.practice_semantic_review_holds (workspace_id, held_at desc, id desc);

alter table app_private.practice_semantic_review_holds enable row level security;

revoke all on table app_private.practice_semantic_review_holds
from public, anon, authenticated, service_role;

create table app_private.worksheet_answer_adjudication_evidence (
  job_id uuid primary key
    references app_private.async_jobs(id) on delete restrict,
  attempt_id uuid not null
    references public.practice_test_attempts(id) on delete restrict,
  deepseek_model text not null
    check (deepseek_model = 'deepseek-v4-flash'),
  openai_model text not null
    check (openai_model = 'gpt-5.4-mini-2026-03-17'),
  adjudication_mode text not null
    check (adjudication_mode in ('agreement', 'pro_resolved')),
  selected_provider_source text not null
    check (selected_provider_source in ('deepseek', 'openai', 'mixed')),
  question_ids uuid[] not null
    check (cardinality(question_ids) between 1 and 3),
  selected_question_sources jsonb not null,
  deepseek_result_sha256 text not null
    check (deepseek_result_sha256 ~ '^[0-9a-f]{64}$'),
  openai_result_sha256 text not null
    check (openai_result_sha256 ~ '^[0-9a-f]{64}$'),
  pro_model text check (pro_model is null or pro_model = 'deepseek-v4-pro'),
  pro_result_sha256 text check (
    pro_result_sha256 is null or pro_result_sha256 ~ '^[0-9a-f]{64}$'
  ),
  final_result_sha256 text not null
    check (final_result_sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz not null default now(),
  constraint worksheet_answer_selected_source_map_check check (
    app_private.valid_worksheet_answer_source_map(
      selected_question_sources,
      question_ids
    )
  ),
  constraint worksheet_answer_adjudication_mode_shape_check check (
    (
      adjudication_mode = 'agreement'
      and selected_provider_source = 'deepseek'
      and pro_model is null
      and pro_result_sha256 is null
    )
    or (
      adjudication_mode = 'pro_resolved'
      and pro_model = 'deepseek-v4-pro'
      and pro_result_sha256 is not null
    )
  )
);

alter table app_private.worksheet_answer_adjudication_evidence
enable row level security;

revoke all on table app_private.worksheet_answer_adjudication_evidence
from public, anon, authenticated, service_role;

create or replace function app_private.reject_semantic_review_audit_mutation()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'semantic_review_audit_immutable';
end;
$$;

revoke all on function app_private.reject_semantic_review_audit_mutation()
from public, anon, authenticated, service_role;

create trigger practice_semantic_review_holds_immutable
before update or delete on app_private.practice_semantic_review_holds
for each row execute function
  app_private.reject_semantic_review_audit_mutation();

create trigger worksheet_answer_adjudication_evidence_immutable
before update or delete on app_private.worksheet_answer_adjudication_evidence
for each row execute function
  app_private.reject_semantic_review_audit_mutation();

-- Extend the existing immutable teacher action ledger without creating a
-- second revision namespace for the same assignment.
alter table app_private.practice_teacher_actions
  drop constraint if exists practice_teacher_actions_action_type_check,
  drop constraint if exists practice_teacher_actions_check;

alter table app_private.practice_teacher_actions
  add constraint practice_teacher_actions_action_type_v2_check check (
    action_type in (
      'score_override',
      'assignment_reassigned',
      'support_resolved',
      'semantic_review_finalized'
    )
  ),
  add constraint practice_teacher_actions_shape_v2_check check (
    (
      action_type = 'score_override'
      and attempt_id is not null
      and resolution is null
      and related_assignment_id is null
    )
    or (
      action_type = 'assignment_reassigned'
      and attempt_id is null
      and resolution is null
      and related_assignment_id is not null
    )
    or (
      action_type = 'support_resolved'
      and resolution is not null
    )
    or (
      action_type = 'semantic_review_finalized'
      and attempt_id is not null
      and resolution is null
      and related_assignment_id is null
    )
  );

create or replace function app_private.hold_worksheet_answer_for_review_internal(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_attempt public.practice_test_attempts%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  existing_hold app_private.practice_semantic_review_holds%rowtype;
  safe_reason text := lower(btrim(coalesce(reason_code, '')));
  selected_worker_id uuid := worker_id;
begin
  perform app_private.assert_service_role();

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'worker_id_required';
  end if;
  if safe_reason not in (
    'semantic_adjudication_disagreement',
    'semantic_provider_output_invalid',
    'semantic_provider_quality_invalid',
    'semantic_single_provider_incomplete',
    'semantic_adjudicator_not_configured',
    'semantic_provider_authentication_failed',
    'semantic_provider_configuration_failed'
  ) then
    raise exception using errcode = '22023', message = 'semantic_hold_reason_invalid';
  end if;

  select hold.*
  into existing_hold
  from app_private.practice_semantic_review_holds hold
  where hold.job_id = target_job_id;

  if existing_hold.id is not null then
    if existing_hold.reason_code <> safe_reason then
      raise exception using errcode = '55000', message = 'semantic_hold_replay_mismatch';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'job_id', existing_hold.job_id,
      'attempt_id', existing_hold.attempt_id,
      'assignment_id', existing_hold.assignment_id,
      'evaluation_status', 'needs_review',
      'reason_code', existing_hold.reason_code,
      'held_at', existing_hold.held_at
    );
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job.id is null
    or selected_job.job_kind <> 'worksheet_answer_evaluation'
  then
    raise exception using errcode = 'P0002', message = 'worksheet_answer_job_not_found';
  end if;
  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> selected_worker_id
  then
    raise exception using errcode = '55000', message = 'job_lease_no_longer_active';
  end if;

  select attempt.*
  into selected_attempt
  from public.practice_test_attempts attempt
  where attempt.id = selected_job.entity_id
  for update;

  if selected_attempt.id is null
    or selected_attempt.evaluation_version <> selected_job.entity_version
    or selected_attempt.evaluation_status <> 'evaluating'
    or selected_attempt.status <> 'submitted'
  then
    raise exception using errcode = '55000', message = 'worksheet_attempt_context_changed';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = selected_attempt.assignment_id
  for update;

  if selected_assignment.id is null
    or selected_assignment.latest_attempt_id <> selected_attempt.id
    or selected_assignment.workspace_id <> selected_attempt.workspace_id
    or selected_assignment.student_id <> selected_attempt.student_id
    or selected_assignment.practice_test_id <> selected_attempt.practice_test_id
    or selected_assignment.status <> 'completed'
  then
    raise exception using errcode = '55000', message = 'worksheet_assignment_context_changed';
  end if;

  -- No provider candidate or partial review survives the hold transition.
  delete from public.practice_attempt_question_reviews review
  where review.attempt_id = selected_attempt.id;

  update public.practice_test_attempts attempt
  set
    evaluation_status = 'needs_review',
    evaluation_started_at = coalesce(attempt.evaluation_started_at, now()),
    evaluation_completed_at = null,
    evaluation_error = safe_reason,
    evaluation_model = null,
    automatic_retry_at = null,
    automatic_retry_exhausted_at = null,
    status = 'submitted'
  where attempt.id = selected_attempt.id;

  insert into app_private.practice_semantic_review_holds (
    job_id,
    attempt_id,
    assignment_id,
    workspace_id,
    evaluation_version,
    reason_code,
    ordinary_attempt_count,
    provider_outage_epoch,
    provider_outage_recovery_count
  ) values (
    selected_job.id,
    selected_attempt.id,
    selected_assignment.id,
    selected_assignment.workspace_id,
    selected_attempt.evaluation_version,
    safe_reason,
    selected_job.attempt_count,
    selected_job.provider_outage_epoch,
    selected_job.provider_outage_recovery_count
  );

  update app_private.async_jobs job
  set
    status = 'dead',
    worker_id = null,
    lease_expires_at = null,
    dead_at = now(),
    last_error_code = safe_reason
  where job.id = selected_job.id;

  perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);

  return jsonb_build_object(
    'schema_version', 1,
    'job_id', selected_job.id,
    'attempt_id', selected_attempt.id,
    'assignment_id', selected_assignment.id,
    'evaluation_status', 'needs_review',
    'reason_code', safe_reason,
    'held_at', now()
  );
end;
$$;

revoke all on function app_private.hold_worksheet_answer_for_review_internal(
  uuid, bigint, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function app_private.hold_worksheet_answer_for_review_internal(
  uuid, bigint, uuid, text
) to service_role;

create or replace function api.hold_worksheet_answer_for_review(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  reason_code text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select app_private.hold_worksheet_answer_for_review_internal(
    target_job_id,
    target_queue_message_id,
    worker_id,
    reason_code
  );
$$;

revoke all on function api.hold_worksheet_answer_for_review(
  uuid, bigint, uuid, text
) from public, anon, authenticated;
grant execute on function api.hold_worksheet_answer_for_review(
  uuid, bigint, uuid, text
) to service_role;

-- One private scoring implementation serves both the service completion path
-- and the authenticated teacher recovery path. The exposed service wrapper
-- retains its original signature and role boundary.
create or replace function app_private.finalize_practice_attempt_evaluation_internal(
  target_attempt_id uuid,
  finalization_source text
)
returns table (
  attempt_id uuid,
  assignment_id uuid,
  evaluation_status text,
  attempt_status text,
  assignment_status text,
  score_points numeric,
  max_score_points numeric,
  score_percent numeric,
  passed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_record public.practice_test_attempts%rowtype;
  assignment_record public.student_practice_assignments%rowtype;
  strict_scoring boolean := false;
  total_question_count integer := 0;
  local_question_count integer := 0;
  semantic_question_count integer := 0;
  reviewed_semantic_question_count integer := 0;
  unreviewed_semantic_question_count integer := 0;
  full_credit_question_count integer := 0;
  local_minor_punctuation_count integer := 0;
  local_capitalization_issue_count integer := 0;
  local_incorrect_question_count integer := 0;
  semantic_correct_count integer := 0;
  semantic_partial_count integer := 0;
  semantic_capitalization_issue_count integer := 0;
  semantic_minor_punctuation_count integer := 0;
  semantic_incorrect_count integer := 0;
  calculated_score_points numeric(6, 2);
  calculated_max_score_points numeric(6, 2);
  calculated_score_percent numeric(5, 2);
  calculated_passed boolean;
  next_attempt_status text;
  next_assignment_status text;
  next_evaluation_status text;
  scoring_mode text;
  scoring_version_name text;
  completed_time timestamptz := now();
begin
  if finalization_source not in ('automatic', 'teacher') then
    raise exception using errcode = '22023', message = 'finalization_source_invalid';
  end if;

  select attempt.*
  into attempt_record
  from public.practice_test_attempts attempt
  where attempt.id = target_attempt_id
  for update;

  if attempt_record.id is null then
    raise exception using errcode = 'P0002', message = 'practice_attempt_not_found';
  end if;
  if attempt_record.status <> 'submitted'
    or (
      finalization_source = 'automatic'
      and attempt_record.evaluation_status <> 'evaluating'
    )
    or (
      finalization_source = 'teacher'
      and attempt_record.evaluation_status <> 'needs_review'
    )
  then
    raise exception using errcode = '55000', message = 'practice_attempt_not_finalizable';
  end if;

  select assignment.*
  into assignment_record
  from public.student_practice_assignments assignment
  where assignment.id = attempt_record.assignment_id
  for update;

  if assignment_record.id is null
    or assignment_record.latest_attempt_id <> attempt_record.id
    or assignment_record.practice_test_id <> attempt_record.practice_test_id
    or assignment_record.workspace_id <> attempt_record.workspace_id
    or assignment_record.student_id <> attempt_record.student_id
    or assignment_record.status <> 'completed'
  then
    raise exception using errcode = '55000', message = 'practice_assignment_not_finalizable';
  end if;

  select app_private.is_practice_topic_strict_scoring(topic.name, topic.slug)
  into strict_scoring
  from public.grammar_topics topic
  where topic.id = assignment_record.grammar_topic_id;
  strict_scoring := coalesce(strict_scoring, false);

  with answer_map as (
    select distinct on ((answer_item ->> 'question_id')::uuid)
      (answer_item ->> 'question_id')::uuid as answer_question_id,
      coalesce(answer_item ->> 'answer', '') as answer
    from jsonb_array_elements(attempt_record.answers) answer_item
    where jsonb_typeof(answer_item) = 'object'
      and (answer_item ->> 'question_id') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    order by (answer_item ->> 'question_id')::uuid
  ),
  questions as (
    select
      question.id,
      question.question_type,
      question.correct_answer,
      question.accepted_answers,
      question.evaluation_mode,
      app_private.is_practice_question_locally_scorable(
        question.question_type,
        question.correct_answer,
        question.evaluation_mode,
        question.accepted_answers
      ) as locally_scorable,
      coalesce(answer.answer, '') as student_answer
    from public.practice_test_questions question
    left join answer_map answer on answer.answer_question_id = question.id
    where question.practice_test_id = attempt_record.practice_test_id
  ),
  local_classified as (
    select
      question.id,
      app_private.practice_answer_review_status_any(
        question.student_answer,
        question.correct_answer,
        question.accepted_answers,
        strict_scoring
      ) as review_status
    from questions question
    where question.locally_scorable
  ),
  local_scored as (
    select
      classified.id,
      classified.review_status,
      app_private.practice_review_status_points(classified.review_status)
        as points_awarded
    from local_classified classified
  ),
  semantic_questions as (
    select question.id
    from questions question
    where not question.locally_scorable
  ),
  semantic_reviews as (
    select
      question.id,
      review.review_status,
      review.points_awarded,
      review.max_points
    from semantic_questions question
    left join public.practice_attempt_question_reviews review
      on review.attempt_id = attempt_record.id
      and review.question_id = question.id
  )
  select
    (select count(*)::integer from questions),
    (select count(*)::integer from local_scored),
    (select count(*)::integer from semantic_questions),
    coalesce((
      select count(*)::integer
      from semantic_reviews
      where review_status is not null
    ), 0),
    coalesce((
      select count(*)::integer
      from semantic_reviews
      where review_status is null
    ), 0),
    coalesce((
      select count(*)::integer
      from local_scored
      where review_status in ('correct', 'minor_punctuation')
    ), 0) + coalesce((
      select count(*)::integer
      from semantic_reviews
      where review_status in ('correct', 'minor_punctuation')
    ), 0),
    coalesce((
      select count(*)::integer from local_scored
      where review_status = 'minor_punctuation'
    ), 0),
    coalesce((
      select count(*)::integer from local_scored
      where review_status = 'capitalization_issue'
    ), 0),
    coalesce((
      select count(*)::integer from local_scored
      where review_status = 'incorrect'
    ), 0),
    coalesce((
      select count(*)::integer from semantic_reviews
      where review_status = 'correct'
    ), 0),
    coalesce((
      select count(*)::integer from semantic_reviews
      where review_status = 'partially_correct'
    ), 0),
    coalesce((
      select count(*)::integer from semantic_reviews
      where review_status = 'capitalization_issue'
    ), 0),
    coalesce((
      select count(*)::integer from semantic_reviews
      where review_status = 'minor_punctuation'
    ), 0),
    coalesce((
      select count(*)::integer from semantic_reviews
      where review_status = 'incorrect'
    ), 0),
    coalesce((select round(sum(points_awarded), 2) from local_scored), 0)
      + coalesce((
        select round(sum(points_awarded), 2)
        from semantic_reviews
        where review_status is not null
      ), 0),
    coalesce((select count(*)::numeric(6, 2) from local_scored), 0)
      + coalesce((
        select round(sum(max_points), 2)
        from semantic_reviews
        where review_status is not null
      ), 0)
  into
    total_question_count,
    local_question_count,
    semantic_question_count,
    reviewed_semantic_question_count,
    unreviewed_semantic_question_count,
    full_credit_question_count,
    local_minor_punctuation_count,
    local_capitalization_issue_count,
    local_incorrect_question_count,
    semantic_correct_count,
    semantic_partial_count,
    semantic_capitalization_issue_count,
    semantic_minor_punctuation_count,
    semantic_incorrect_count,
    calculated_score_points,
    calculated_max_score_points;

  if total_question_count < 1
    or semantic_question_count < 1
    or reviewed_semantic_question_count <> semantic_question_count
    or unreviewed_semantic_question_count <> 0
    or calculated_max_score_points <= 0
  then
    raise exception using errcode = '55000', message = 'semantic_review_incomplete';
  end if;

  calculated_score_percent := round(
    (calculated_score_points * 100) / calculated_max_score_points,
    2
  );
  calculated_passed := calculated_score_percent >= 70;
  next_attempt_status := 'checked';
  next_assignment_status := case when calculated_passed then 'passed' else 'failed' end;
  next_evaluation_status := 'completed';
  scoring_mode := case
    when finalization_source = 'teacher' then 'teacher_semantic_review'
    else 'dual_provider_semantic_adjudication'
  end;
  scoring_version_name := case
    when finalization_source = 'teacher'
      then 'phase_12l_teacher_semantic_review_v1'
    else 'phase_12l_dual_semantic_adjudication_v1'
  end;

  update public.practice_test_attempts attempt
  set
    score = full_credit_question_count,
    max_score = local_question_count + reviewed_semantic_question_count,
    score_points = calculated_score_points,
    max_score_points = calculated_max_score_points,
    score_percent = calculated_score_percent,
    passed = calculated_passed,
    status = next_attempt_status,
    evaluation_status = next_evaluation_status,
    evaluation_completed_at = completed_time,
    evaluation_error = null,
    automatic_retry_at = null,
    automatic_retry_exhausted_at = null,
    scoring_version = scoring_version_name,
    feedback = jsonb_build_object(
      'scoring_version', scoring_version_name,
      'scoring', scoring_mode,
      'total_questions', total_question_count,
      'local_questions', local_question_count,
      'semantic_questions', semantic_question_count,
      'semantic_reviewed_questions', reviewed_semantic_question_count,
      'correct_questions', full_credit_question_count,
      'local_minor_punctuation_questions', local_minor_punctuation_count,
      'local_capitalization_issue_questions', local_capitalization_issue_count,
      'local_incorrect_questions', local_incorrect_question_count,
      'semantic_correct_questions', semantic_correct_count,
      'semantic_partially_correct_questions', semantic_partial_count,
      'semantic_minor_punctuation_questions', semantic_minor_punctuation_count,
      'semantic_capitalization_issue_questions',
        semantic_capitalization_issue_count,
      'semantic_incorrect_questions', semantic_incorrect_count,
      'score_points', calculated_score_points,
      'max_score_points', calculated_max_score_points,
      'score_percent', calculated_score_percent,
      'pass_threshold_percent', 70,
      'strict_scoring', strict_scoring
    )
  where attempt.id = attempt_record.id;

  update public.student_practice_assignments assignment
  set
    status = next_assignment_status,
    completed_at = coalesce(assignment.completed_at, completed_time),
    latest_attempt_id = attempt_record.id,
    automatic_retry_at = null,
    automatic_retry_exhausted_at = null
  where assignment.id = assignment_record.id;

  if calculated_passed then
    update public.student_grammar_stats stats
    set
      weakness_level = 'improving',
      practice_unlocked = false,
      updated_at = completed_time
    where stats.workspace_id = assignment_record.workspace_id
      and stats.student_id = assignment_record.student_id
      and stats.grammar_topic_id = assignment_record.grammar_topic_id;
  end if;

  return query
  select
    attempt_record.id,
    assignment_record.id,
    next_evaluation_status,
    next_attempt_status,
    next_assignment_status,
    calculated_score_points,
    calculated_max_score_points,
    calculated_score_percent,
    calculated_passed;
end;
$$;

revoke all on function app_private.finalize_practice_attempt_evaluation_internal(
  uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.finalize_practice_attempt_evaluation(
  target_attempt_id uuid
)
returns table (
  attempt_id uuid,
  assignment_id uuid,
  evaluation_status text,
  attempt_status text,
  assignment_status text,
  score_points numeric,
  max_score_points numeric,
  score_percent numeric,
  passed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_service_role();
  return query
  select *
  from app_private.finalize_practice_attempt_evaluation_internal(
    target_attempt_id,
    'automatic'
  );
end;
$$;

revoke all on function public.finalize_practice_attempt_evaluation(uuid)
from public, anon, authenticated;
grant execute on function public.finalize_practice_attempt_evaluation(uuid)
to service_role;

create or replace function app_private.complete_worksheet_answer_with_adjudication(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  result jsonb,
  adjudication jsonb
)
returns table (
  attempt_id uuid,
  assignment_id uuid,
  evaluation_status text,
  attempt_status text,
  assignment_status text,
  score_points numeric,
  max_score_points numeric,
  score_percent numeric,
  passed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  translated_result jsonb;
  translated_reviews jsonb;
  normalized_selected_sources jsonb := '[]'::jsonb;
  provider_question_ids uuid[] := array[]::uuid[];
  system_question_ids uuid[] := array[]::uuid[];
  provider_review_count integer := 0;
  system_review_count integer := 0;
  selected_provider_source text;
  expected_evaluator_model text;
  selected_job_status text;
  selected_job_attempt_id uuid;
  canonical_result_sha256 text;
  recorded_provenance app_private.worksheet_answer_completion_provenance%rowtype;
  recorded_evidence app_private.worksheet_answer_adjudication_evidence%rowtype;
  completed_attempt_id uuid;
  completed_assignment_id uuid;
  completed_evaluation_status text;
  completed_attempt_status text;
  completed_assignment_status text;
  completed_score_points numeric;
  completed_max_score_points numeric;
  completed_score_percent numeric;
  completed_passed boolean;
  changed_row_count integer;
begin
  perform app_private.assert_service_role();

  if result is null
    or jsonb_typeof(result) <> 'object'
    or jsonb_typeof(result -> 'reviews') <> 'array'
  then
    raise exception using errcode = '22023', message = 'semantic_completion_invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(result -> 'reviews') review
    where jsonb_typeof(review) <> 'object'
      or coalesce(review ->> 'evaluator_source', '')
        not in ('deepseek', 'openai', 'system')
      or coalesce(review ->> 'question_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception using errcode = '22023', message = 'semantic_completion_source_invalid';
  end if;

  if (
    select count(*) <> count(distinct (review ->> 'question_id')::uuid)
    from jsonb_array_elements(result -> 'reviews') review
  ) then
    raise exception using errcode = '22023', message = 'semantic_completion_duplicates';
  end if;

  select
    count(*) filter (
      where review ->> 'evaluator_source' in ('deepseek', 'openai')
    ),
    count(*) filter (where review ->> 'evaluator_source' = 'system'),
    coalesce(array_agg(
      (review ->> 'question_id')::uuid
      order by (review ->> 'question_id')::uuid
    ) filter (
      where review ->> 'evaluator_source' in ('deepseek', 'openai')
    ), array[]::uuid[]),
    coalesce(array_agg(
      (review ->> 'question_id')::uuid
      order by (review ->> 'question_id')::uuid
    ) filter (where review ->> 'evaluator_source' = 'system'), array[]::uuid[])
  into
    provider_review_count,
    system_review_count,
    provider_question_ids,
    system_question_ids
  from jsonb_array_elements(result -> 'reviews') review;

  if provider_review_count > 3
    or system_review_count > 3
    or provider_review_count + system_review_count > 3
  then
    raise exception using errcode = '22023', message = 'semantic_completion_count_invalid';
  end if;

  if provider_review_count > 0 then
    select case
      when count(*) filter (where review ->> 'evaluator_source' = 'deepseek') > 0
        and count(*) filter (where review ->> 'evaluator_source' = 'openai') > 0
        then 'mixed'
      when count(*) filter (where review ->> 'evaluator_source' = 'openai') > 0
        then 'openai'
      else 'deepseek'
    end
    into selected_provider_source
    from jsonb_array_elements(result -> 'reviews') review
    where review ->> 'evaluator_source' in ('deepseek', 'openai');

    expected_evaluator_model := case selected_provider_source
      when 'deepseek' then 'deepseek-v4-flash'
      when 'openai' then 'gpt-5.4-mini-2026-03-17'
      when 'mixed' then
        'deepseek-v4-flash+gpt-5.4-mini-2026-03-17'
      else null
    end;
  end if;

  if provider_review_count > 0 then
    if (result ->> 'evaluator_model') is distinct from expected_evaluator_model
      or adjudication is null
      or jsonb_typeof(adjudication) <> 'object'
      or not (adjudication ?& array[
        'schema_version',
        'deepseek_model',
        'openai_model',
        'adjudication_mode',
        'selected_provider_source',
        'selected_question_sources',
        'deepseek_result_sha256',
        'openai_result_sha256',
        'pro_model',
        'pro_result_sha256'
      ])
      or exists (
        select 1
        from jsonb_object_keys(adjudication) key
        where key not in (
          'schema_version',
          'deepseek_model',
          'openai_model',
          'adjudication_mode',
          'selected_provider_source',
          'selected_question_sources',
          'deepseek_result_sha256',
          'openai_result_sha256',
          'pro_model',
          'pro_result_sha256'
        )
      )
      or adjudication -> 'schema_version' <> '1'::jsonb
      or (adjudication ->> 'deepseek_model')
        is distinct from 'deepseek-v4-flash'
      or (adjudication ->> 'openai_model')
        is distinct from 'gpt-5.4-mini-2026-03-17'
      or (adjudication ->> 'selected_provider_source')
        is distinct from selected_provider_source
      or not app_private.valid_worksheet_answer_source_map(
        adjudication -> 'selected_question_sources',
        provider_question_ids
      )
      or exists (
        select 1
        from jsonb_array_elements(result -> 'reviews') review
        left join jsonb_array_elements(
          adjudication -> 'selected_question_sources'
        ) source_map
          on source_map ->> 'question_id' = review ->> 'question_id'
        where review ->> 'evaluator_source' in ('deepseek', 'openai')
          and (source_map ->> 'provider_source')
            is distinct from review ->> 'evaluator_source'
      )
      or coalesce(adjudication ->> 'adjudication_mode', '')
        not in ('agreement', 'pro_resolved')
      or coalesce(adjudication ->> 'deepseek_result_sha256', '')
        !~ '^[0-9a-f]{64}$'
      or coalesce(adjudication ->> 'openai_result_sha256', '')
        !~ '^[0-9a-f]{64}$'
      or (
        adjudication ->> 'adjudication_mode' = 'agreement'
        and (
          selected_provider_source <> 'deepseek'
          or exists (
            select 1
            from jsonb_array_elements(
              adjudication -> 'selected_question_sources'
            ) source_map
            where source_map ->> 'provider_source' <> 'deepseek'
          )
          or (adjudication -> 'pro_model') is distinct from 'null'::jsonb
          or (adjudication -> 'pro_result_sha256')
            is distinct from 'null'::jsonb
        )
      )
      or (
        adjudication ->> 'adjudication_mode' = 'pro_resolved'
        and (
          (adjudication ->> 'pro_model') is distinct from 'deepseek-v4-pro'
          or coalesce(adjudication ->> 'pro_result_sha256', '')
            !~ '^[0-9a-f]{64}$'
        )
      )
    then
      raise exception using errcode = '22023', message = 'semantic_adjudication_invalid';
    end if;

    select jsonb_agg(
      jsonb_build_object(
        'question_id', source_map ->> 'question_id',
        'provider_source', source_map ->> 'provider_source'
      )
      order by (source_map ->> 'question_id')::uuid
    )
    into normalized_selected_sources
    from jsonb_array_elements(
      adjudication -> 'selected_question_sources'
    ) source_map;
  elsif adjudication is not null and adjudication <> 'null'::jsonb then
    raise exception using errcode = '22023', message = 'semantic_adjudication_unexpected';
  elsif result -> 'evaluator_model' is distinct from 'null'::jsonb then
    raise exception using errcode = '22023', message = 'semantic_completion_model_invalid';
  end if;

  if system_review_count > 0 and exists (
    select 1
    from jsonb_array_elements(result -> 'reviews') review
    where review ->> 'evaluator_source' = 'system'
      and (
        review ->> 'review_status' <> 'incorrect'
        or review -> 'points_awarded' <> '0'::jsonb
        or review -> 'max_points' <> '1'::jsonb
      )
  ) then
    raise exception using errcode = '22023', message = 'system_blank_review_invalid';
  end if;

  select coalesce(
    jsonb_agg(
      case
        when review ->> 'evaluator_source' = 'system' then
          jsonb_set(review, '{evaluator_source}', to_jsonb('manual'::text))
        else jsonb_set(
          review,
          '{evaluator_source}',
          to_jsonb('deepseek'::text)
        )
      end
      order by ordinal
    ),
    '[]'::jsonb
  )
  into translated_reviews
  from jsonb_array_elements(result -> 'reviews')
    with ordinality as reviewed(review, ordinal);

  translated_result := jsonb_set(
    jsonb_set(result, '{reviews}', translated_reviews),
    '{evaluator_model}',
    case
      when provider_review_count > 0
        then to_jsonb('deepseek-v4-flash'::text)
      else 'null'::jsonb
    end
  );
  canonical_result_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(result::text, 'UTF8')),
    'hex'
  );

  select job.status, job.entity_id
  into selected_job_status, selected_job_attempt_id
  from app_private.async_jobs job
  where job.id = target_job_id
    and job.job_kind = 'worksheet_answer_evaluation'
  for update;

  if not found then
    raise exception using errcode = '02000', message = 'semantic_job_missing';
  end if;

  if selected_job_status = 'succeeded' then
    select provenance.*
    into recorded_provenance
    from app_private.worksheet_answer_completion_provenance provenance
    where provenance.job_id = target_job_id;

    if not found
      or recorded_provenance.attempt_id <> selected_job_attempt_id
      or recorded_provenance.provider_source
        is distinct from selected_provider_source
      or recorded_provenance.evaluator_model
        is distinct from expected_evaluator_model
      or recorded_provenance.result_sha256 <> canonical_result_sha256
      or not exists (
        select 1
        from public.practice_test_attempts attempt
        where attempt.id = selected_job_attempt_id
          and attempt.evaluation_model is not distinct from expected_evaluator_model
      )
      or exists (
        select 1
        from jsonb_array_elements(normalized_selected_sources) source_map
        left join public.practice_attempt_question_reviews review
          on review.attempt_id = selected_job_attempt_id
         and review.question_id = (source_map ->> 'question_id')::uuid
        where review.evaluator_source
          is distinct from source_map ->> 'provider_source'
      )
      or (
        select count(*)
        from public.practice_attempt_question_reviews review
        where review.attempt_id = selected_job_attempt_id
          and review.question_id = any(system_question_ids)
          and review.evaluator_source = 'system'
      ) <> system_review_count
    then
      raise exception using
        errcode = '55000',
        message = 'semantic_completion_replay_mismatch';
    end if;
  end if;

  select
    completed.attempt_id,
    completed.assignment_id,
    completed.evaluation_status,
    completed.attempt_status,
    completed.assignment_status,
    completed.score_points,
    completed.max_score_points,
    completed.score_percent,
    completed.passed
  into strict
    completed_attempt_id,
    completed_assignment_id,
    completed_evaluation_status,
    completed_attempt_status,
    completed_assignment_status,
    completed_score_points,
    completed_max_score_points,
    completed_score_percent,
    completed_passed
  from public.complete_worksheet_answer_evaluation(
    target_job_id,
    target_queue_message_id,
    worker_id,
    translated_result
  ) completed;

  if completed_attempt_id is distinct from selected_job_attempt_id then
    raise exception using errcode = '55000', message = 'semantic_completion_context_changed';
  end if;

  if selected_job_status <> 'succeeded' and system_review_count > 0 then
    update public.practice_attempt_question_reviews review
    set evaluator_source = 'system'
    where review.attempt_id = completed_attempt_id
      and review.question_id = any(system_question_ids)
      and review.evaluator_source = 'manual';

    if (
      select count(*)
      from public.practice_attempt_question_reviews review
      where review.attempt_id = completed_attempt_id
        and review.question_id = any(system_question_ids)
        and review.evaluator_source = 'system'
    ) <> system_review_count then
      raise exception using errcode = '55000', message = 'system_provenance_not_persisted';
    end if;
  end if;

  if selected_job_status <> 'succeeded' and provider_review_count > 0 then
    update public.practice_attempt_question_reviews review
    set evaluator_source = source_map ->> 'provider_source'
    from jsonb_array_elements(normalized_selected_sources) source_map
    where review.attempt_id = completed_attempt_id
      and review.question_id = (source_map ->> 'question_id')::uuid
      and review.evaluator_source = 'deepseek';

    get diagnostics changed_row_count = row_count;
    if changed_row_count <> provider_review_count then
      raise exception using
        errcode = '55000',
        message = 'semantic_provider_provenance_not_persisted';
    end if;
  end if;

  if selected_job_status <> 'succeeded' then
    update public.practice_test_attempts attempt
    set evaluation_model = expected_evaluator_model
    where attempt.id = completed_attempt_id;

    if not found then
      raise exception using
        errcode = '55000',
        message = 'semantic_evaluator_model_not_persisted';
    end if;

    insert into app_private.worksheet_answer_completion_provenance (
      job_id,
      attempt_id,
      provider_source,
      evaluator_model,
      result_sha256
    ) values (
      target_job_id,
      completed_attempt_id,
      selected_provider_source,
      expected_evaluator_model,
      canonical_result_sha256
    );
  end if;

  if provider_review_count > 0 then
    insert into app_private.worksheet_answer_adjudication_evidence (
      job_id,
      attempt_id,
      deepseek_model,
      openai_model,
      adjudication_mode,
      selected_provider_source,
      question_ids,
      selected_question_sources,
      deepseek_result_sha256,
      openai_result_sha256,
      pro_model,
      pro_result_sha256,
      final_result_sha256
    ) values (
      target_job_id,
      completed_attempt_id,
      adjudication ->> 'deepseek_model',
      adjudication ->> 'openai_model',
      adjudication ->> 'adjudication_mode',
      adjudication ->> 'selected_provider_source',
      provider_question_ids,
      normalized_selected_sources,
      adjudication ->> 'deepseek_result_sha256',
      adjudication ->> 'openai_result_sha256',
      adjudication ->> 'pro_model',
      adjudication ->> 'pro_result_sha256',
      canonical_result_sha256
    )
    on conflict (job_id) do nothing;

    select evidence.*
    into strict recorded_evidence
    from app_private.worksheet_answer_adjudication_evidence evidence
    where evidence.job_id = target_job_id;

    if recorded_evidence.attempt_id <> completed_attempt_id
      or recorded_evidence.deepseek_model <> adjudication ->> 'deepseek_model'
      or recorded_evidence.openai_model <> adjudication ->> 'openai_model'
      or recorded_evidence.adjudication_mode
        <> adjudication ->> 'adjudication_mode'
      or recorded_evidence.selected_provider_source
        <> adjudication ->> 'selected_provider_source'
      or recorded_evidence.question_ids <> provider_question_ids
      or recorded_evidence.selected_question_sources <>
        normalized_selected_sources
      or recorded_evidence.deepseek_result_sha256
        <> adjudication ->> 'deepseek_result_sha256'
      or recorded_evidence.openai_result_sha256
        <> adjudication ->> 'openai_result_sha256'
      or recorded_evidence.pro_model
        is distinct from adjudication ->> 'pro_model'
      or recorded_evidence.pro_result_sha256
        is distinct from adjudication ->> 'pro_result_sha256'
      or recorded_evidence.final_result_sha256 <> canonical_result_sha256
    then
      raise exception using errcode = '55000', message = 'semantic_adjudication_replay_mismatch';
    end if;
  end if;

  return query
  select
    completed_attempt_id,
    completed_assignment_id,
    completed_evaluation_status,
    completed_attempt_status,
    completed_assignment_status,
    completed_score_points,
    completed_max_score_points,
    completed_score_percent,
    completed_passed;
end;
$$;

revoke all on function app_private.complete_worksheet_answer_with_adjudication(
  uuid, bigint, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function app_private.complete_worksheet_answer_with_adjudication(
  uuid, bigint, uuid, jsonb, jsonb
) to service_role;

create or replace function api.complete_worksheet_answer_adjudication(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  result jsonb,
  adjudication jsonb
)
returns table (
  attempt_id uuid,
  assignment_id uuid,
  evaluation_status text,
  attempt_status text,
  assignment_status text,
  score_points numeric,
  max_score_points numeric,
  score_percent numeric,
  passed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.complete_worksheet_answer_with_adjudication(
    target_job_id,
    target_queue_message_id,
    worker_id,
    result,
    adjudication
  );
$$;

revoke all on function api.complete_worksheet_answer_adjudication(
  uuid, bigint, uuid, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function api.complete_worksheet_answer_adjudication(
  uuid, bigint, uuid, jsonb, jsonb
) to service_role;

-- Fail a stale Phase 12I worker closed. Only the Phase 12L adjudicated facade
-- may now reach the legacy transactional scorer; the Phase 12L definer calls
-- it internally after validating both independent results.
revoke all on function api.complete_worksheet_answer_evaluation(
  uuid, bigint, uuid, jsonb
) from service_role;
revoke all on function app_private.complete_worksheet_answer_with_provenance(
  uuid, bigint, uuid, jsonb
) from service_role;
revoke all on function public.complete_worksheet_answer_evaluation(
  uuid, bigint, uuid, jsonb
) from service_role;

create or replace function public.finalize_practice_semantic_review_internal(
  target_assignment_id uuid,
  command_id uuid,
  expected_action_revision integer,
  review_reason text,
  reviews jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  selected_attempt public.practice_test_attempts%rowtype;
  selected_hold app_private.practice_semantic_review_holds%rowtype;
  existing_action app_private.practice_teacher_actions%rowtype;
  current_revision integer := 0;
  next_revision integer;
  clean_reason text := btrim(review_reason);
  canonical_reviews jsonb;
  request_sha256 text;
  answers_sha256_before text;
  answers_sha256_after text;
  finalized record;
  result_json jsonb;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_assignment_id is null
    or command_id is null
    or expected_action_revision is null
    or expected_action_revision < 0
    or clean_reason is null
    or length(clean_reason) not between 8 and 1000
    or reviews is null
    or jsonb_typeof(reviews) <> 'array'
    or jsonb_array_length(reviews) not between 1 and 3
  then
    raise exception using errcode = '22023', message = 'semantic_teacher_review_invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(reviews) review
    where jsonb_typeof(review) <> 'object'
      or exists (
        select 1
        from jsonb_object_keys(review) key
        where key not in (
          'question_id',
          'review_status',
          'points_awarded',
          'max_points',
          'feedback_text',
          'corrected_answer',
          'model_answer',
          'short_reason'
        )
      )
      or coalesce(review ->> 'question_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(review ->> 'review_status', '') not in (
        'correct',
        'partially_correct',
        'capitalization_issue',
        'minor_punctuation',
        'incorrect'
      )
      or coalesce(jsonb_typeof(review -> 'points_awarded') <> 'number', true)
      or review -> 'max_points' <> '1'::jsonb
      or review -> 'points_awarded' <> case review ->> 'review_status'
        when 'correct' then '1'::jsonb
        when 'minor_punctuation' then '1'::jsonb
        when 'partially_correct' then '0.5'::jsonb
        when 'capitalization_issue' then '0.5'::jsonb
        when 'incorrect' then '0'::jsonb
        else 'null'::jsonb
      end
      or coalesce(jsonb_typeof(review -> 'feedback_text') <> 'string', true)
      or length(btrim(coalesce(review ->> 'feedback_text', ''))) not between 1 and 500
      or coalesce(jsonb_typeof(review -> 'short_reason') <> 'string', true)
      or length(btrim(coalesce(review ->> 'short_reason', ''))) not between 1 and 240
      or coalesce(
        jsonb_typeof(review -> 'corrected_answer') not in ('string', 'null'),
        true
      )
      or length(btrim(coalesce(review ->> 'corrected_answer', ''))) > 500
      or coalesce(
        jsonb_typeof(review -> 'model_answer') not in ('string', 'null'),
        true
      )
      or length(btrim(coalesce(review ->> 'model_answer', ''))) > 500
      or lower(btrim(coalesce(review ->> 'model_answer', ''))) in (
        'manual_review',
        'manual review',
        'open_review',
        'flexible_review',
        'requires_review'
      )
      or concat_ws(
        ' ',
        review ->> 'feedback_text',
        review ->> 'corrected_answer',
        review ->> 'model_answer',
        review ->> 'short_reason'
      ) ~* '(deepseek|chatgpt|artificial intelligence|language model|internal prompt|automatic correction)'
  ) then
    raise exception using errcode = '22023', message = 'semantic_teacher_review_invalid';
  end if;

  if (
    select count(*) <> count(distinct (review ->> 'question_id')::uuid)
    from jsonb_array_elements(reviews) review
  ) then
    raise exception using errcode = '22023', message = 'semantic_teacher_review_duplicates';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'question_id', (review ->> 'question_id')::uuid,
      'review_status', review ->> 'review_status',
      'points_awarded', (review ->> 'points_awarded')::numeric,
      'max_points', 1,
      'feedback_text', btrim(review ->> 'feedback_text'),
      'corrected_answer', nullif(btrim(review ->> 'corrected_answer'), ''),
      'model_answer', nullif(btrim(review ->> 'model_answer'), ''),
      'short_reason', btrim(review ->> 'short_reason')
    )
    order by (review ->> 'question_id')::uuid
  )
  into canonical_reviews
  from jsonb_array_elements(reviews) review;

  request_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        jsonb_build_object(
          'assignment_id', target_assignment_id,
          'reason', clean_reason,
          'reviews', canonical_reviews
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      selected_assignment.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select action.*
  into existing_action
  from app_private.practice_teacher_actions action
  where action.id = command_id;

  if existing_action.id is not null then
    if existing_action.assignment_id <> selected_assignment.id
      or existing_action.action_type <> 'semantic_review_finalized'
      or existing_action.after_state ->> 'request_sha256' <> request_sha256
      or jsonb_typeof(existing_action.after_state -> 'result') <> 'object'
    then
      raise exception using errcode = '55000', message = 'teacher_command_replay_mismatch';
    end if;
    return existing_action.after_state -> 'result';
  end if;

  select attempt.*
  into selected_attempt
  from public.practice_test_attempts attempt
  where attempt.id = selected_assignment.latest_attempt_id
    and attempt.assignment_id = selected_assignment.id
  for update;

  if selected_attempt.id is null
    or selected_attempt.status <> 'submitted'
    or selected_attempt.evaluation_status <> 'needs_review'
    or selected_assignment.status <> 'completed'
  then
    raise exception using errcode = '55000', message = 'semantic_review_not_open';
  end if;

  select hold.*
  into selected_hold
  from app_private.practice_semantic_review_holds hold
  where hold.attempt_id = selected_attempt.id
    and hold.evaluation_version = selected_attempt.evaluation_version;

  if selected_hold.id is null then
    raise exception using errcode = '55000', message = 'semantic_review_hold_missing';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(canonical_reviews) review
    left join public.practice_test_questions question
      on question.id = (review ->> 'question_id')::uuid
      and question.practice_test_id = selected_attempt.practice_test_id
      and not app_private.is_practice_question_locally_scorable(
        question.question_type,
        question.correct_answer,
        question.evaluation_mode,
        question.accepted_answers
      )
    where question.id is null
  ) or exists (
    select 1
    from public.practice_test_questions question
    where question.practice_test_id = selected_attempt.practice_test_id
      and not app_private.is_practice_question_locally_scorable(
        question.question_type,
        question.correct_answer,
        question.evaluation_mode,
        question.accepted_answers
      )
      and not exists (
        select 1
        from jsonb_array_elements(canonical_reviews) review
        where (review ->> 'question_id')::uuid = question.id
      )
  ) then
    raise exception using errcode = '22023', message = 'semantic_teacher_review_mismatch';
  end if;

  select coalesce(max(action.action_revision), 0)
  into current_revision
  from app_private.practice_teacher_actions action
  where action.assignment_id = selected_assignment.id;

  if current_revision <> expected_action_revision then
    raise exception using errcode = '40001', message = 'teacher_action_revision_conflict';
  end if;
  next_revision := current_revision + 1;

  answers_sha256_before := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(selected_attempt.answers::text, 'UTF8')
    ),
    'hex'
  );

  delete from public.practice_attempt_question_reviews review
  where review.attempt_id = selected_attempt.id;

  insert into public.practice_attempt_question_reviews (
    attempt_id,
    assignment_id,
    workspace_id,
    student_id,
    question_id,
    review_status,
    points_awarded,
    max_points,
    evaluator_source,
    feedback_text,
    corrected_answer,
    model_answer,
    short_reason
  )
  select
    selected_attempt.id,
    selected_assignment.id,
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    (review ->> 'question_id')::uuid,
    review ->> 'review_status',
    (review ->> 'points_awarded')::numeric,
    1,
    'teacher',
    review ->> 'feedback_text',
    review ->> 'corrected_answer',
    review ->> 'model_answer',
    review ->> 'short_reason'
  from jsonb_array_elements(canonical_reviews) review;

  update public.practice_test_attempts attempt
  set evaluation_model = null
  where attempt.id = selected_attempt.id;

  select *
  into strict finalized
  from app_private.finalize_practice_attempt_evaluation_internal(
    selected_attempt.id,
    'teacher'
  );

  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(attempt.answers::text, 'UTF8')),
    'hex'
  )
  into answers_sha256_after
  from public.practice_test_attempts attempt
  where attempt.id = selected_attempt.id;

  if answers_sha256_after <> answers_sha256_before then
    raise exception using errcode = '55000', message = 'submitted_practice_answers_changed';
  end if;

  result_json := jsonb_build_object(
    'schema_version', 1,
    'action_id', command_id,
    'action_revision', next_revision,
    'assignment_id', finalized.assignment_id,
    'attempt_id', finalized.attempt_id,
    'evaluation_status', finalized.evaluation_status,
    'attempt_status', finalized.attempt_status,
    'assignment_status', finalized.assignment_status,
    'score_points', finalized.score_points,
    'max_score_points', finalized.max_score_points,
    'score_percent', finalized.score_percent,
    'passed', finalized.passed
  );

  insert into app_private.practice_teacher_actions (
    id,
    assignment_id,
    attempt_id,
    workspace_id,
    student_id,
    grammar_topic_id,
    actor_id,
    action_revision,
    action_type,
    reason,
    before_state,
    after_state
  ) values (
    command_id,
    selected_assignment.id,
    selected_attempt.id,
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id,
    caller_id,
    next_revision,
    'semantic_review_finalized',
    clean_reason,
    jsonb_build_object(
      'evaluation_status', 'needs_review',
      'hold_id', selected_hold.id,
      'hold_reason_code', selected_hold.reason_code
    ),
    jsonb_build_object(
      'request_sha256', request_sha256,
      'result', result_json
    )
  );

  return result_json;
end;
$$;

revoke all on function public.finalize_practice_semantic_review_internal(
  uuid, uuid, integer, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_practice_semantic_review_internal(
  uuid, uuid, integer, text, jsonb
) to authenticated;

create or replace function api.finalize_practice_semantic_review(
  target_assignment_id uuid,
  command_id uuid,
  expected_action_revision integer,
  review_reason text,
  reviews jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.finalize_practice_semantic_review_internal(
    target_assignment_id,
    command_id,
    expected_action_revision,
    review_reason,
    reviews
  );
$$;

revoke all on function api.finalize_practice_semantic_review(
  uuid, uuid, integer, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function api.finalize_practice_semantic_review(
  uuid, uuid, integer, text, jsonb
) to authenticated;

create or replace function public.get_practice_semantic_review_draft_internal(
  target_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  selected_attempt public.practice_test_attempts%rowtype;
  selected_hold app_private.practice_semantic_review_holds%rowtype;
  current_revision integer := 0;
  question_items jsonb := '[]'::jsonb;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if selected_assignment.id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      selected_assignment.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select attempt.*
  into selected_attempt
  from public.practice_test_attempts attempt
  where attempt.id = selected_assignment.latest_attempt_id
    and attempt.assignment_id = selected_assignment.id;

  if selected_attempt.id is null
    or selected_attempt.status <> 'submitted'
    or selected_attempt.evaluation_status <> 'needs_review'
    or selected_assignment.status <> 'completed'
  then
    raise exception using errcode = '55000', message = 'semantic_review_not_open';
  end if;

  select hold.*
  into selected_hold
  from app_private.practice_semantic_review_holds hold
  where hold.attempt_id = selected_attempt.id
    and hold.evaluation_version = selected_attempt.evaluation_version;

  if selected_hold.id is null then
    raise exception using errcode = '55000', message = 'semantic_review_hold_missing';
  end if;

  select coalesce(max(action.action_revision), 0)
  into current_revision
  from app_private.practice_teacher_actions action
  where action.assignment_id = selected_assignment.id;

  with answer_map as (
    select distinct on ((answer_item ->> 'question_id')::uuid)
      (answer_item ->> 'question_id')::uuid as question_id,
      coalesce(answer_item ->> 'answer', '') as answer
    from jsonb_array_elements(selected_attempt.answers) answer_item
    where jsonb_typeof(answer_item) = 'object'
      and (answer_item ->> 'question_id') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    order by (answer_item ->> 'question_id')::uuid
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'question_id', question.id,
      'question_number', question.question_number,
      'question_type', question.question_type,
      'prompt', question.prompt,
      'student_answer', coalesce(answer.answer, ''),
      'rubric', question.rubric,
      'sample_answer', coalesce(
        nullif(btrim(question.rubric ->> 'sample_answer'), ''),
        nullif(btrim(question.correct_answer), '')
      ),
      'explanation', question.explanation
    )
    order by question.question_number, question.id
  ), '[]'::jsonb)
  into question_items
  from public.practice_test_questions question
  left join answer_map answer on answer.question_id = question.id
  where question.practice_test_id = selected_attempt.practice_test_id
    and not app_private.is_practice_question_locally_scorable(
      question.question_type,
      question.correct_answer,
      question.evaluation_mode,
      question.accepted_answers
    );

  if jsonb_array_length(question_items) not between 1 and 3 then
    raise exception using errcode = '55000', message = 'semantic_review_question_count_invalid';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'assignment_id', selected_assignment.id,
    'attempt_id', selected_attempt.id,
    'evaluation_version', selected_attempt.evaluation_version,
    'hold_reason_code', selected_hold.reason_code,
    'current_action_revision', current_revision,
    'questions', question_items
  );
end;
$$;

revoke all on function public.get_practice_semantic_review_draft_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_practice_semantic_review_draft_internal(uuid)
to authenticated;

create or replace function api.get_practice_semantic_review_draft(
  target_assignment_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.get_practice_semantic_review_draft_internal(
    target_assignment_id
  );
$$;

revoke all on function api.get_practice_semantic_review_draft(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.get_practice_semantic_review_draft(uuid)
to authenticated;

-- Preserve the fully patched Phase 12G queue implementation and compose the
-- new semantic-review row set around it. This avoids reimplementing its class
-- context error sanitization.
alter function public.practice_review_queue_rows_internal(uuid)
rename to practice_review_queue_rows_internal_before_phase_12l;

revoke all on function
  public.practice_review_queue_rows_internal_before_phase_12l(uuid)
from public, anon, authenticated, service_role;

create or replace function public.practice_review_queue_rows_internal(
  target_workspace_id uuid
)
returns table (
  queue_key text,
  assignment_id uuid,
  attempt_id uuid,
  practice_test_id uuid,
  workspace_id uuid,
  student_id uuid,
  student_name text,
  student_email text,
  grammar_topic_name text,
  worksheet_title text,
  action_kind text,
  generation_status text,
  evaluation_status text,
  error_code text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select legacy.*
  from public.practice_review_queue_rows_internal_before_phase_12l(
    target_workspace_id
  ) legacy

  union all

  select
    'semantic_review_required:' || assignment.id::text as queue_key,
    assignment.id as assignment_id,
    attempt.id as attempt_id,
    assignment.practice_test_id,
    assignment.workspace_id,
    assignment.student_id,
    coalesce(student.full_name, 'Student') as student_name,
    student.email as student_email,
    topic.name as grammar_topic_name,
    worksheet.title as worksheet_title,
    'semantic_review_required'::text as action_kind,
    assignment.generation_status,
    attempt.evaluation_status,
    case hold.reason_code
      when 'semantic_adjudication_disagreement'
        then 'semantic_adjudication_disagreement'
      when 'semantic_adjudicator_not_configured'
        then 'semantic_adjudicator_not_configured'
      when 'semantic_provider_authentication_failed'
        then 'semantic_provider_authentication_failed'
      when 'semantic_provider_configuration_failed'
        then 'semantic_provider_configuration_failed'
      else 'semantic_automatic_review_incomplete'
    end as error_code,
    attempt.submitted_at as created_at,
    hold.held_at as updated_at
  from public.student_practice_assignments assignment
  join public.practice_test_attempts attempt
    on attempt.id = assignment.latest_attempt_id
    and attempt.assignment_id = assignment.id
  join app_private.practice_semantic_review_holds hold
    on hold.attempt_id = attempt.id
    and hold.evaluation_version = attempt.evaluation_version
  join public.profiles student on student.id = assignment.student_id
  join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
  left join public.practice_tests worksheet
    on worksheet.id = assignment.practice_test_id
  where assignment.workspace_id = target_workspace_id
    and attempt.evaluation_status = 'needs_review'
    and attempt.status = 'submitted'
    and assignment.status = 'completed'
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = assignment.workspace_id
        and membership.user_id = assignment.student_id
        and membership.role = 'student'
    )
    and (select auth.uid()) is not null
    and (
      public.is_platform_admin()
      or public.has_workspace_role(
        target_workspace_id,
        array['owner', 'teacher']
      )
    );
$$;

revoke all on function public.practice_review_queue_rows_internal(uuid)
from public, anon, authenticated, service_role;

create or replace function public.list_practice_review_queue_page_internal(
  target_workspace_id uuid,
  target_kind text default 'all',
  requested_page_size integer default 25,
  cursor_updated_at timestamptz default null,
  cursor_queue_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_workspace_id is null
    or target_kind not in (
      'all',
      'worksheet_quarantine',
      'generation_failed',
      'evaluation_failed',
      'support_recommended',
      'semantic_review_required'
    )
    or requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 100
    or ((cursor_updated_at is null) <> (cursor_queue_key is null))
  then
    raise exception using errcode = '22023', message = 'invalid_practice_review_page';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into exact_total
  from public.practice_review_queue_rows_internal(target_workspace_id) item
  where target_kind = 'all' or item.action_kind = target_kind;

  with candidate_rows as materialized (
    select item.*
    from public.practice_review_queue_rows_internal(target_workspace_id) item
    where (target_kind = 'all' or item.action_kind = target_kind)
      and (
        cursor_updated_at is null
        or (item.updated_at, item.queue_key) < (
          cursor_updated_at,
          cursor_queue_key
        )
      )
    order by item.updated_at desc, item.queue_key desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select *
    from candidate_rows
    order by updated_at desc, queue_key desc
    limit requested_page_size
  )
  select
    coalesce((
      select jsonb_agg(to_jsonb(page_row)
        order by page_row.updated_at desc, page_row.queue_key desc)
      from page_rows page_row
    ), '[]'::jsonb),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object(
          'updated_at', page_row.updated_at,
          'queue_key', page_row.queue_key
        )
        from page_rows page_row
        order by page_row.updated_at asc, page_row.queue_key asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor;

  return jsonb_build_object(
    'schema_version', 1,
    'items', page_items,
    'total_count', exact_total,
    'returned_count', jsonb_array_length(page_items),
    'page_size', requested_page_size,
    'has_more', page_has_more,
    'next_cursor', page_next_cursor
  );
end;
$$;

revoke all on function public.list_practice_review_queue_page_internal(
  uuid, text, integer, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.list_practice_review_queue_page_internal(
  uuid, text, integer, timestamptz, text
) to authenticated;

-- The direct API view used to expose a provisional local subtotal. Keep the
-- operational state but null every grade field unless the same canonical
-- terminal predicate used by the read models succeeds.
create or replace view api.practice_test_attempts
with (security_invoker = true, security_barrier = true)
as
select
  attempt.id,
  attempt.workspace_id,
  attempt.student_id,
  attempt.practice_test_id,
  attempt.assignment_id,
  attempt.status,
  attempt.started_at,
  attempt.submitted_at,
  attempt.completed_at,
  (case when terminal.visible then attempt.score else null end)::integer as score,
  (case when terminal.visible then attempt.max_score else null end)::integer
    as max_score,
  (case when terminal.visible then attempt.score_percent else null end)::numeric(5, 2)
    as score_percent,
  (case when terminal.visible then attempt.passed else null end)::boolean as passed,
  (case when terminal.visible then attempt.score_points else null end)::numeric(6, 2)
    as score_points,
  (case when terminal.visible then attempt.max_score_points else null end)::numeric(6, 2)
    as max_score_points,
  (case when terminal.visible then attempt.scoring_version else null end)::text
    as scoring_version,
  attempt.evaluation_status,
  attempt.evaluation_started_at,
  attempt.evaluation_completed_at,
  case
    when attempt.evaluation_status = 'failed' then 'evaluation_failed'
    when attempt.evaluation_status = 'needs_review' then 'review_required'
    else null
  end::text as evaluation_error,
  attempt.created_at
from public.practice_test_attempts attempt
left join public.student_practice_assignments assignment
  on assignment.id = attempt.assignment_id
-- Students intentionally cannot read raw worksheet authoring rows directly.
-- Count the terminal per-question review evidence they are authorized to see
-- instead; atomic finalization already enforces exactly one review for every
-- semantic question. Before terminalization RLS exposes no rows, so the score
-- remains masked.
cross join lateral (
  select count(*)::integer as semantic_question_count
  from public.practice_attempt_question_reviews review
  where review.attempt_id = attempt.id
) semantic
cross join lateral (
  select coalesce((
    attempt.status = 'checked'
    and attempt.evaluation_status in ('completed', 'not_needed')
    and attempt.evaluation_completed_at is not null
    and attempt.evaluation_error is null
    and attempt.score is not null
    and attempt.max_score is not null
    and attempt.max_score > 0
    and attempt.score between 0 and attempt.max_score
    and attempt.score_points is not null
    and attempt.max_score_points is not null
    and attempt.max_score_points > 0
    and attempt.score_points between 0 and attempt.max_score_points
    and nullif(btrim(attempt.scoring_version), '') is not null
    and attempt.score_percent is not null
    and attempt.score_percent between 0 and 100
    and abs(
      attempt.score_percent
      - round((attempt.score_points * 100) / attempt.max_score_points, 2)
    ) <= 0.01
    and attempt.passed is not null
    and attempt.passed = (attempt.score_percent >= 70)
    and assignment.status = case
      when attempt.passed then 'passed'
      else 'failed'
    end
    and case attempt.evaluation_status
      when 'completed' then semantic.semantic_question_count > 0
      when 'not_needed' then semantic.semantic_question_count = 0
      else false
    end
  ), false) as visible
) terminal;

revoke all on table api.practice_test_attempts
from public, anon, authenticated, service_role;
grant select on table api.practice_test_attempts
to authenticated, service_role;

comment on table app_private.practice_semantic_review_holds is
  'Private immutable reason-only holds for worksheet semantic evaluations; no answers or provider payloads are stored.';
comment on table app_private.worksheet_answer_adjudication_evidence is
  'Private immutable pinned-model hashes proving independent DeepSeek/OpenAI adjudication without storing student answers.';
comment on function api.hold_worksheet_answer_for_review(uuid,bigint,uuid,text) is
  'Service-only transactional transition from an active semantic job to private needs_review.';
comment on function api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb) is
  'Service-only atomic completion for independently agreed semantic results with pinned dual-provider evidence.';
comment on function api.finalize_practice_semantic_review(uuid,uuid,integer,text,jsonb) is
  'Teacher-only revision-safe, command-idempotent per-question semantic review finalization.';

notify pgrst, 'reload schema';
