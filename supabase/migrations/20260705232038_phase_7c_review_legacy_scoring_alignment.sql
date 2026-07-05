-- Keep review badges aligned with the scoring rules that produced the stored attempt.
-- Attempts submitted after Phase 7C review use the new scoring_normalization feedback key.

create or replace function app_private.get_practice_assignment_review_internal(target_assignment_id uuid)
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
  review_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  assignment_record public.student_practice_assignments%rowtype;
  attempt_record public.practice_test_attempts%rowtype;
  strict_scoring boolean := false;
  use_current_scoring boolean := false;
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

  if caller_id <> assignment_record.student_id
    and not app_private.is_platform_admin()
    and not app_private.has_workspace_role(assignment_record.workspace_id, array['owner', 'teacher'])
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

  select app_private.is_practice_topic_strict_scoring(gt.name, gt.slug)
  into strict_scoring
  from public.grammar_topics gt
  where gt.id = assignment_record.grammar_topic_id;

  strict_scoring := coalesce(strict_scoring, false);
  use_current_scoring := coalesce(attempt_record.feedback ? 'scoring_normalization', false);

  return query
    with answer_map as (
      select distinct on ((answer_item ->> 'question_id')::uuid)
        (answer_item ->> 'question_id')::uuid as answer_question_id,
        coalesce(answer_item ->> 'answer', '') as answer
      from jsonb_array_elements(attempt_record.answers) answer_item
      where jsonb_typeof(answer_item) = 'object'
        and (answer_item ->> 'question_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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
        ptq.explanation,
        app_private.is_practice_question_locally_scorable(ptq.question_type, ptq.correct_answer) as locally_scorable
      from public.practice_test_questions ptq
      left join answer_map am on am.answer_question_id = ptq.id
      where ptq.practice_test_id = assignment_record.practice_test_id
    ),
    reviewed as (
      select
        q.*,
        case
          when not q.locally_scorable then null
          when use_current_scoring then app_private.practice_answer_is_correct(q.student_answer, q.correct_answer, strict_scoring)
          else regexp_replace(lower(btrim(coalesce(q.student_answer, ''))), '\s+', ' ', 'g')
            = regexp_replace(lower(btrim(q.correct_answer)), '\s+', ' ', 'g')
        end as computed_is_correct
      from questions q
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
      summary.score,
      summary.max_score,
      summary.score_percent,
      summary.passed,
      summary.question_count,
      reviewed.id,
      reviewed.question_number,
      reviewed.question_type,
      reviewed.prompt,
      reviewed.options,
      reviewed.student_answer,
      reviewed.correct_answer,
      reviewed.explanation,
      reviewed.computed_is_correct as is_correct,
      case
        when not reviewed.locally_scorable then 'submitted_for_review'
        when reviewed.computed_is_correct then 'correct'
        else 'incorrect'
      end as review_status
    from app_private.practice_assignment_summary(assignment_record.id) summary
    cross join reviewed
    order by reviewed.question_number asc;
end;
$$;

revoke all on function app_private.get_practice_assignment_review_internal(uuid) from public, anon;
grant execute on function app_private.get_practice_assignment_review_internal(uuid) to authenticated;
