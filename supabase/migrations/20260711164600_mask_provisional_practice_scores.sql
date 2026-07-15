-- Phase 12F: a mixed worksheet can have a provisional local subtotal while
-- semantic answers are still queued. Keep that operational state available to
-- teachers and platform administrators, but never present it to the student as
-- a final score. One private terminal predicate derives visibility only from
-- persisted assignment, attempt, and worksheet state; callers cannot provide
-- or override the outcome.

create or replace function app_private.practice_attempt_result_is_terminal(
  assignment_status text,
  attempt_status text,
  evaluation_status text,
  evaluation_completed_at timestamptz,
  evaluation_error text,
  score integer,
  max_score integer,
  score_points numeric,
  max_score_points numeric,
  scoring_version text,
  score_percent numeric,
  passed boolean,
  semantic_question_count integer
)
returns boolean
language sql
security invoker
set search_path = ''
immutable
parallel safe
as $$
  select coalesce((
    attempt_status = 'checked'
    and evaluation_status in ('completed', 'not_needed')
    and evaluation_completed_at is not null
    and evaluation_error is null
    and score is not null
    and max_score is not null
    and max_score > 0
    and score between 0 and max_score
    and score_points is not null
    and max_score_points is not null
    and max_score_points > 0
    and score_points between 0 and max_score_points
    and nullif(btrim(scoring_version), '') is not null
    and score_percent is not null
    and score_percent between 0 and 100
    and abs(
      score_percent
      - round((score_points * 100) / max_score_points, 2)
    ) <= 0.01
    and passed is not null
    and passed = (score_percent >= 70)
    and assignment_status = case when passed then 'passed' else 'failed' end
    and case evaluation_status
      when 'completed' then coalesce(semantic_question_count, 0) > 0
      when 'not_needed' then coalesce(semantic_question_count, 0) = 0
      else false
    end
  ), false);
$$;

revoke all on function app_private.practice_attempt_result_is_terminal(
  text, text, text, timestamptz, text, integer, integer,
  numeric, numeric, text, numeric, boolean, integer
)
from public, anon, authenticated, service_role;

comment on function app_private.practice_attempt_result_is_terminal(
  text, text, text, timestamptz, text, integer, integer,
  numeric, numeric, text, numeric, boolean, integer
) is
  'Private pure predicate for a coherent, student-visible practice result. Callers cannot provide a terminal flag to any exposed API.';

create or replace function public.get_practice_assignment_summary_internal(
  target_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  selected_workspace_id uuid;
  selected_student_id uuid;
  caller_can_manage boolean := false;
  result jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_assignment_id is null then
    raise exception using errcode = '22023', message = 'assignment_required';
  end if;

  select assignment.workspace_id, assignment.student_id
  into selected_workspace_id, selected_student_id
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if selected_workspace_id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  caller_can_manage :=
    app_private.is_platform_admin()
    or app_private.has_workspace_role(
      selected_workspace_id,
      array['owner', 'teacher']
    );

  if actor_id = selected_student_id and not caller_can_manage then
    if not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = selected_workspace_id
        and membership.user_id = actor_id
        and membership.role = 'student'
    ) then
      raise exception using errcode = '42501', message = 'active_membership_required';
    end if;
  elsif not caller_can_manage then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  select jsonb_build_object(
    'id', assignment.id,
    'workspace_id', assignment.workspace_id,
    'student_id', assignment.student_id,
    'grammar_topic_id', assignment.grammar_topic_id,
    'grammar_topic_name', topic.name,
    'grammar_topic_slug', topic.slug,
    'grammar_topic_description', topic.description,
    'practice_test_id', assignment.practice_test_id,
    'worksheet_title', worksheet.title,
    'worksheet_level', worksheet.level,
    'worksheet_difficulty', worksheet.difficulty,
    'worksheet_mini_lesson', worksheet.mini_lesson,
    'status', assignment.status,
    'source', assignment.source,
    'assigned_at', assignment.assigned_at,
    'started_at', assignment.started_at,
    'completed_at', assignment.completed_at,
    'latest_attempt_id', assignment.latest_attempt_id,
    'latest_attempt_status', attempt.status
  ) || jsonb_build_object(
    'score', case when visibility.result_visible then attempt.score else null end,
    'max_score', case when visibility.result_visible then attempt.max_score else null end,
    'score_points', case
      when visibility.result_visible then attempt.score_points
      else null
    end,
    'max_score_points', case
      when visibility.result_visible then attempt.max_score_points
      else null
    end,
    'scoring_version', case
      when visibility.result_visible then attempt.scoring_version
      else null
    end,
    'evaluation_status', attempt.evaluation_status,
    'evaluation_started_at', attempt.evaluation_started_at,
    'evaluation_completed_at', attempt.evaluation_completed_at,
    'evaluation_error', case
      when caller_can_manage then attempt.evaluation_error
      when attempt.evaluation_status = 'failed' then 'evaluation_failed'
      else null
    end,
    'score_percent', case
      when visibility.result_visible then attempt.score_percent
      else null
    end,
    'passed', case when visibility.result_visible then attempt.passed else null end,
    'question_count', question_stats.question_count,
    'generation_status', assignment.generation_status,
    'generation_started_at', assignment.generation_started_at,
    'generation_completed_at', assignment.generation_completed_at,
    'generation_error', case
      when assignment.generation_error is null then null
      else 'generation_failed'
    end,
    'previous_assignment_id', assignment.previous_assignment_id,
    'previous_attempt_id', assignment.previous_attempt_id,
    'repeat_number', assignment.repeat_number,
    'adaptive_reason', assignment.adaptive_reason,
    'adaptive_status', assignment.adaptive_status,
    'resolution_cycle_id', assignment.resolution_cycle_id,
    'resolution_cycle_number', assignment.resolution_cycle_number,
    'evidence_cutoff_sequence', assignment.evidence_cutoff_sequence,
    'student_name', coalesce(profile.full_name, profile.email),
    'student_email', profile.email
  )
  into result
  from public.student_practice_assignments assignment
  join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
  join public.profiles profile on profile.id = assignment.student_id
  left join public.practice_tests worksheet
    on worksheet.id = assignment.practice_test_id
  left join public.practice_test_attempts attempt
    on attempt.id = assignment.latest_attempt_id
    and attempt.assignment_id = assignment.id
    and attempt.workspace_id = assignment.workspace_id
    and attempt.student_id = assignment.student_id
    and attempt.practice_test_id = assignment.practice_test_id
  left join lateral (
    select
      count(*)::integer as question_count,
      count(*) filter (
        where not app_private.is_practice_question_locally_scorable(
          question.question_type,
          question.correct_answer,
          question.evaluation_mode,
          question.accepted_answers
        )
      )::integer as semantic_question_count
    from public.practice_test_questions question
    where question.practice_test_id = assignment.practice_test_id
  ) question_stats on true
  cross join lateral (
    select
      caller_can_manage
      or app_private.practice_attempt_result_is_terminal(
        assignment.status,
        attempt.status,
        attempt.evaluation_status,
        attempt.evaluation_completed_at,
        attempt.evaluation_error,
        attempt.score,
        attempt.max_score,
        attempt.score_points,
        attempt.max_score_points,
        attempt.scoring_version,
        attempt.score_percent,
        attempt.passed,
        question_stats.semantic_question_count
      ) as result_visible
  ) visibility
  where assignment.id = target_assignment_id;

  if result is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  return result;
end;
$$;

revoke all on function public.get_practice_assignment_summary_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_practice_assignment_summary_internal(uuid)
to authenticated, service_role;

comment on function public.get_practice_assignment_summary_internal(uuid) is
  'Non-exposed actor-authorized practice summary implementation. It derives manager authority and coherent result visibility from persisted database state.';

create or replace function api.get_practice_assignment_summary(
  target_assignment_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.get_practice_assignment_summary_internal(
    target_assignment_id
  );
$$;

-- The internal submit, draft deletion, and safe readback remain one database
-- transaction. Keep mutation and readback as separate PL/pgSQL statements so
-- the read model observes the command counter advanced by the submit. A
-- same-statement STABLE read would retain the statement's pre-submit snapshot.
create or replace function api.submit_practice_attempt(
  target_assignment_id uuid,
  expected_revision integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  internal_result jsonb;
  safe_result jsonb;
begin
  select public.submit_practice_draft_internal(
    target_assignment_id,
    expected_revision
  )
  into internal_result;

  if internal_result is null then
    raise exception using
      errcode = '55000',
      message = 'practice_submit_failed';
  end if;

  select api.get_practice_assignment_summary(target_assignment_id)
  into safe_result;

  if safe_result is null then
    raise exception using
      errcode = '55000',
      message = 'practice_submit_readback_failed';
  end if;

  return safe_result;
end;
$$;

create or replace function app_private.get_practice_assignment_review_internal(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  workspace_id uuid,
  student_id uuid,
  grammar_topic_id uuid,
  grammar_topic_name text,
  grammar_topic_slug text,
  practice_test_id uuid,
  worksheet_title text,
  worksheet_level text,
  worksheet_difficulty text,
  status text,
  source text,
  assigned_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  score integer,
  max_score integer,
  score_points numeric,
  max_score_points numeric,
  scoring_version text,
  evaluation_status text,
  evaluation_error text,
  score_percent numeric,
  passed boolean,
  question_count integer,
  question_id uuid,
  question_number integer,
  question_type text,
  prompt text,
  options jsonb,
  student_answer text,
  correct_answer text,
  explanation text,
  is_correct boolean,
  review_status text,
  points_awarded numeric,
  max_points numeric,
  feedback_text text,
  corrected_answer text,
  model_answer text,
  short_reason text,
  evaluator_source text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  assignment_record public.student_practice_assignments%rowtype;
  attempt_record public.practice_test_attempts%rowtype;
  strict_scoring boolean := false;
  caller_can_manage_assignment boolean := false;
  review_details_visible boolean := false;
  semantic_question_count integer := 0;
begin
  if caller_id is null then
    raise exception 'Authentication required.'
      using errcode = '28000';
  end if;

  select spa.*
  into assignment_record
  from public.student_practice_assignments spa
  where spa.id = target_assignment_id
  limit 1;

  if assignment_record.id is null then
    raise exception 'Practice assignment was not found.'
      using errcode = '02000';
  end if;

  caller_can_manage_assignment :=
    app_private.is_platform_admin()
    or app_private.has_workspace_role(
      assignment_record.workspace_id,
      array['owner', 'teacher']
    );

  if caller_id = assignment_record.student_id
    and not caller_can_manage_assignment
  then
    if not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = assignment_record.workspace_id
        and membership.user_id = caller_id
        and membership.role = 'student'
    ) then
      raise exception using
        errcode = '42501',
        message = 'active_membership_required';
    end if;
  elsif not caller_can_manage_assignment then
    raise exception using
      errcode = 'P0002',
      message = 'practice_assignment_not_found';
  end if;

  if assignment_record.practice_test_id is null then
    raise exception 'Worksheet is not available yet.'
      using errcode = '22023';
  end if;

  select pta.*
  into attempt_record
  from public.practice_test_attempts pta
  where pta.id = assignment_record.latest_attempt_id
    and pta.assignment_id = assignment_record.id
    and pta.workspace_id = assignment_record.workspace_id
    and pta.student_id = assignment_record.student_id
    and pta.practice_test_id = assignment_record.practice_test_id
    and pta.status in ('submitted', 'checked')
  limit 1;

  if attempt_record.id is null
    or (
      assignment_record.status not in ('completed', 'passed', 'failed')
      and attempt_record.status not in ('submitted', 'checked')
    )
  then
    raise exception 'Worksheet review is available after submission.'
      using errcode = '42501';
  end if;

  select count(*) filter (
    where not app_private.is_practice_question_locally_scorable(
      question.question_type,
      question.correct_answer,
      question.evaluation_mode,
      question.accepted_answers
    )
  )::integer
  into semantic_question_count
  from public.practice_test_questions question
  where question.practice_test_id = assignment_record.practice_test_id;

  review_details_visible :=
    caller_can_manage_assignment
    or app_private.practice_attempt_result_is_terminal(
      assignment_record.status,
      attempt_record.status,
      attempt_record.evaluation_status,
      attempt_record.evaluation_completed_at,
      attempt_record.evaluation_error,
      attempt_record.score,
      attempt_record.max_score,
      attempt_record.score_points,
      attempt_record.max_score_points,
      attempt_record.scoring_version,
      attempt_record.score_percent,
      attempt_record.passed,
      semantic_question_count
    );

  select app_private.is_practice_topic_strict_scoring(gt.name, gt.slug)
  into strict_scoring
  from public.grammar_topics gt
  where gt.id = assignment_record.grammar_topic_id;

  strict_scoring := coalesce(strict_scoring, false);

  return query
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
        ptq.id,
        ptq.question_number,
        ptq.question_type,
        ptq.prompt,
        app_private.sanitize_practice_question_options(ptq.options) as options,
        coalesce(am.answer, '') as student_answer,
        ptq.correct_answer,
        ptq.accepted_answers,
        ptq.explanation,
        app_private.is_practice_question_locally_scorable(
          ptq.question_type,
          ptq.correct_answer,
          ptq.evaluation_mode,
          ptq.accepted_answers
        ) as locally_scorable
      from public.practice_test_questions ptq
      left join answer_map am on am.answer_question_id = ptq.id
      where ptq.practice_test_id = assignment_record.practice_test_id
    ),
    classified as (
      select
        q.*,
        paqr.review_status as stored_review_status,
        paqr.points_awarded as stored_points_awarded,
        paqr.max_points as stored_max_points,
        paqr.feedback_text,
        paqr.corrected_answer,
        paqr.model_answer,
        paqr.short_reason,
        paqr.evaluator_source,
        case
          when q.locally_scorable then
            app_private.practice_answer_review_status_any(
              q.student_answer,
              q.correct_answer,
              q.accepted_answers,
              strict_scoring
            )
          when paqr.review_status is not null then paqr.review_status
          else 'submitted_for_review'
        end as review_status
      from questions q
      left join public.practice_attempt_question_reviews paqr
        on paqr.attempt_id = attempt_record.id
        and paqr.question_id = q.id
    ),
    reviewed as (
      select
        classified.*,
        case
          when classified.locally_scorable then
            app_private.practice_review_status_points(
              classified.review_status
            )
          else classified.stored_points_awarded
        end as points_awarded,
        case
          when classified.locally_scorable then 1::numeric
          else classified.stored_max_points
        end as max_points
      from classified
    )
    select
      summary.assignment_id,
      summary.workspace_id,
      summary.student_id,
      summary.grammar_topic_id,
      summary.grammar_topic_name,
      summary.grammar_topic_slug,
      summary.practice_test_id,
      summary.worksheet_title,
      summary.worksheet_level,
      summary.worksheet_difficulty,
      summary.status,
      summary.source,
      summary.assigned_at,
      summary.started_at,
      summary.completed_at,
      summary.latest_attempt_id,
      summary.latest_attempt_status,
      case when review_details_visible then summary.score else null end,
      case when review_details_visible then summary.max_score else null end,
      case when review_details_visible then attempt_record.score_points else null end,
      case when review_details_visible then attempt_record.max_score_points else null end,
      case when review_details_visible then attempt_record.scoring_version else null end,
      attempt_record.evaluation_status,
      case
        when caller_can_manage_assignment then attempt_record.evaluation_error
        when attempt_record.evaluation_status = 'failed' then 'evaluation_failed'
        else null
      end,
      case when review_details_visible then summary.score_percent else null end,
      case when review_details_visible then summary.passed else null end,
      summary.question_count,
      reviewed.id,
      reviewed.question_number,
      reviewed.question_type,
      reviewed.prompt,
      reviewed.options,
      reviewed.student_answer,
      case
        when review_details_visible and reviewed.locally_scorable
          then reviewed.correct_answer
        else null
      end,
      case
        when review_details_visible and reviewed.locally_scorable
          then reviewed.explanation
        else null
      end,
      case
        when review_details_visible
          then reviewed.review_status in ('correct', 'minor_punctuation')
        else null
      end,
      case
        when review_details_visible then reviewed.review_status
        else 'submitted_for_review'
      end,
      case when review_details_visible then reviewed.points_awarded else null end,
      case when review_details_visible then reviewed.max_points else null end,
      case when review_details_visible then reviewed.feedback_text else null end,
      case when review_details_visible then reviewed.corrected_answer else null end,
      case when review_details_visible then reviewed.model_answer else null end,
      case when review_details_visible then reviewed.short_reason else null end,
      case when review_details_visible then reviewed.evaluator_source else null end
    from app_private.practice_assignment_summary(assignment_record.id) summary
    cross join reviewed
    order by reviewed.question_number asc;
end;
$$;

revoke all on function app_private.get_practice_assignment_review_internal(uuid)
from public, anon, authenticated, service_role;

comment on function app_private.get_practice_assignment_review_internal(uuid) is
  'Returns the exact latest submitted worksheet review. Students see a result only when the canonical persisted-state predicate is coherent; managers retain recovery detail.';

revoke all on function api.get_practice_assignment_summary(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.get_practice_assignment_summary(uuid)
to authenticated, service_role;

revoke all on function api.submit_practice_attempt(uuid, integer)
from public, anon, authenticated, service_role;
grant execute on function api.submit_practice_attempt(uuid, integer)
to authenticated;

comment on function api.get_practice_assignment_summary(uuid) is
  'Actor-authorized practice read model. Student grade fields remain null until the canonical persisted-state predicate proves one coherent terminal result; managers retain recovery detail.';
comment on function api.submit_practice_attempt(uuid, integer) is
  'Atomically locks the saved practice draft, submits it once, deletes that draft, and returns the actor-safe assignment summary.';

notify pgrst, 'reload schema';
