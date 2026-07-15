-- Phase 12B: keep partial or stale worksheet reviews private until the
-- student's attempt has reached one coherent terminal state. Teachers and
-- platform administrators retain their operational preview for recovery.

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

  if caller_id <> assignment_record.student_id
    and not caller_can_manage_assignment
  then
    raise exception 'Permission denied.'
      using errcode = '42501';
  end if;

  if assignment_record.practice_test_id is null then
    raise exception 'Worksheet is not available yet.'
      using errcode = '22023';
  end if;

  select pta.*
  into attempt_record
  from public.practice_test_attempts pta
  where pta.assignment_id = assignment_record.id
    and pta.status in ('submitted', 'checked')
  order by
    (pta.id = assignment_record.latest_attempt_id) desc,
    pta.submitted_at desc nulls last,
    pta.completed_at desc nulls last,
    pta.created_at desc
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

  review_details_visible :=
    caller_can_manage_assignment
    or (
      caller_id = assignment_record.student_id
      and attempt_record.status = 'checked'
      and attempt_record.evaluation_status in ('completed', 'not_needed')
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
      case when review_details_visible then attempt_record.evaluation_error else null end,
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
  'Returns submitted worksheet review rows. Student review details remain masked until the attempt is checked and semantic evaluation is terminal; teachers and platform administrators retain recovery visibility.';

notify pgrst, 'reload schema';
