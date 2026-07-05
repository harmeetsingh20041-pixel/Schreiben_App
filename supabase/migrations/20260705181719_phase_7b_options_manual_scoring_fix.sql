-- Phase 7B final safety follow-up:
-- - Never return raw question options JSON to students.
-- - Do not mark mixed local/manual worksheets passed or failed.

create or replace function app_private.sanitize_practice_question_options(raw_options jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  with candidate as (
    select
      case
        when jsonb_typeof(raw_options) = 'array' then raw_options
        when jsonb_typeof(raw_options) = 'object'
          and jsonb_typeof(raw_options -> 'choices') = 'array'
          then raw_options -> 'choices'
        when jsonb_typeof(raw_options) = 'object'
          and jsonb_typeof(raw_options -> 'options') = 'array'
          then raw_options -> 'options'
        else '[]'::jsonb
      end as option_values
  )
  select coalesce(jsonb_agg(option_value order by option_position), '[]'::jsonb)
  from candidate
  cross join lateral jsonb_array_elements(candidate.option_values)
    with ordinality as option_list(option_value, option_position)
  where jsonb_typeof(option_value) = 'string';
$$;

revoke all on function app_private.sanitize_practice_question_options(jsonb) from public, anon, authenticated;

create or replace function app_private.get_practice_assignment_questions_internal(target_assignment_id uuid)
returns table (
  id uuid,
  question_number integer,
  question_type text,
  prompt text,
  options jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  assignment_record public.student_practice_assignments%rowtype;
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
    return;
  end if;

  return query
    select
      ptq.id,
      ptq.question_number,
      ptq.question_type,
      ptq.prompt,
      app_private.sanitize_practice_question_options(ptq.options) as options
    from public.practice_test_questions ptq
    where ptq.practice_test_id = assignment_record.practice_test_id
    order by ptq.question_number asc;
end;
$$;

revoke all on function app_private.get_practice_assignment_questions_internal(uuid) from public, anon;
grant execute on function app_private.get_practice_assignment_questions_internal(uuid) to authenticated;

create or replace function app_private.submit_practice_attempt_internal(
  target_assignment_id uuid,
  submitted_answers jsonb
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
  score_percent numeric,
  passed boolean,
  question_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  assignment_record public.student_practice_assignments%rowtype;
  in_progress_attempt_id uuid;
  total_question_count integer := 0;
  scored_question_count integer := 0;
  manual_question_count integer := 0;
  correct_answer_count integer := 0;
  calculated_score_percent numeric(5, 2);
  calculated_passed boolean;
  completed_time timestamptz := now();
  next_assignment_status text;
  next_attempt_status text;
  scoring_mode text;
begin
  if caller_id is null then
    raise exception 'Authentication required.'
      using errcode = '28000';
  end if;

  if submitted_answers is null or jsonb_typeof(submitted_answers) <> 'array' then
    raise exception 'Answers must be submitted as a JSON array.'
      using errcode = '22023';
  end if;

  select spa.*
  into assignment_record
  from public.student_practice_assignments spa
  where spa.id = target_assignment_id
  for update;

  if assignment_record.id is null then
    raise exception 'Practice assignment was not found.'
      using errcode = '02000';
  end if;

  if caller_id <> assignment_record.student_id
    and not app_private.is_platform_admin()
  then
    raise exception 'Permission denied.'
      using errcode = '42501';
  end if;

  if assignment_record.practice_test_id is null then
    raise exception 'Worksheet is not available yet.'
      using errcode = '22023';
  end if;

  if assignment_record.status not in ('unlocked', 'in_progress') then
    return query
      select *
      from app_private.practice_assignment_summary(assignment_record.id);
    return;
  end if;

  select pta.id
  into in_progress_attempt_id
  from public.practice_test_attempts pta
  where pta.assignment_id = assignment_record.id
    and pta.status = 'in_progress'
  order by pta.started_at desc nulls last, pta.created_at desc
  limit 1;

  if in_progress_attempt_id is null then
    begin
      insert into public.practice_test_attempts (
        practice_test_id,
        student_id,
        workspace_id,
        assignment_id,
        answers,
        score,
        max_score,
        status,
        started_at
      )
      values (
        assignment_record.practice_test_id,
        assignment_record.student_id,
        assignment_record.workspace_id,
        assignment_record.id,
        '[]'::jsonb,
        0,
        0,
        'in_progress',
        completed_time
      )
      returning id into in_progress_attempt_id;
    exception
      when unique_violation then
        select pta.id
        into in_progress_attempt_id
        from public.practice_test_attempts pta
        where pta.assignment_id = assignment_record.id
          and pta.status = 'in_progress'
        order by pta.started_at desc nulls last, pta.created_at desc
        limit 1;
    end;
  end if;

  with submitted as (
    select distinct on ((answer_item ->> 'question_id')::uuid)
      (answer_item ->> 'question_id')::uuid as question_id,
      answer_item ->> 'answer' as answer
    from jsonb_array_elements(submitted_answers) answer_item
    where (answer_item ->> 'question_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    order by (answer_item ->> 'question_id')::uuid
  ),
  all_questions as (
    select
      ptq.id,
      ptq.question_type,
      ptq.correct_answer
    from public.practice_test_questions ptq
    where ptq.practice_test_id = assignment_record.practice_test_id
  ),
  scorable_questions as (
    select
      aq.id,
      aq.correct_answer
    from all_questions aq
    where aq.question_type in ('multiple_choice', 'fill_blank', 'correction', 'short_answer')
      and nullif(btrim(coalesce(aq.correct_answer, '')), '') is not null
  ),
  scored as (
    select
      sq.id,
      case
        when regexp_replace(lower(btrim(coalesce(submitted.answer, ''))), '\s+', ' ', 'g')
          = regexp_replace(lower(btrim(sq.correct_answer)), '\s+', ' ', 'g')
        then 1
        else 0
      end as is_correct
    from scorable_questions sq
    left join submitted
      on submitted.question_id = sq.id
  )
  select
    (select count(*)::integer from all_questions),
    (select count(*)::integer from scorable_questions),
    coalesce((select sum(scored.is_correct)::integer from scored), 0)
  into total_question_count, scored_question_count, correct_answer_count;

  manual_question_count := greatest(total_question_count - scored_question_count, 0);

  if scored_question_count = 0 then
    calculated_score_percent := null;
    calculated_passed := null;
    next_attempt_status := 'submitted';
    next_assignment_status := 'completed';
    scoring_mode := 'manual_review_needed';
  elsif manual_question_count > 0 then
    calculated_score_percent := round((correct_answer_count::numeric * 100) / scored_question_count, 2);
    calculated_passed := null;
    next_attempt_status := 'submitted';
    next_assignment_status := 'completed';
    scoring_mode := 'partial_local';
  else
    calculated_score_percent := round((correct_answer_count::numeric * 100) / scored_question_count, 2);
    calculated_passed := calculated_score_percent >= 70;
    next_attempt_status := 'checked';
    next_assignment_status := case when calculated_passed then 'passed' else 'failed' end;
    scoring_mode := 'local_objective';
  end if;

  update public.practice_test_attempts pta
  set
    answers = submitted_answers,
    score = correct_answer_count,
    max_score = scored_question_count,
    status = next_attempt_status,
    submitted_at = completed_time,
    completed_at = completed_time,
    score_percent = calculated_score_percent,
    passed = calculated_passed,
    feedback = jsonb_build_object(
      'scoring', scoring_mode,
      'correct_objective_answers', correct_answer_count,
      'total_questions', total_question_count,
      'objective_questions', scored_question_count,
      'scored_questions', scored_question_count,
      'unscored_questions', manual_question_count,
      'manual_review_needed', manual_question_count > 0,
      'pass_threshold_percent', 70
    )
  where pta.id = in_progress_attempt_id;

  update public.student_practice_assignments spa
  set
    status = next_assignment_status,
    started_at = coalesce(spa.started_at, completed_time),
    completed_at = completed_time,
    latest_attempt_id = in_progress_attempt_id
  where spa.id = assignment_record.id
  returning spa.* into assignment_record;

  if scored_question_count > 0 then
    update public.student_grammar_stats sgs
    set
      total_correct_after_practice = sgs.total_correct_after_practice + correct_answer_count,
      weakness_level = case
        when calculated_passed then 'improving'
        else sgs.weakness_level
      end,
      practice_unlocked = case
        when calculated_passed then false
        else sgs.practice_unlocked
      end,
      updated_at = completed_time
    where sgs.workspace_id = assignment_record.workspace_id
      and sgs.student_id = assignment_record.student_id
      and sgs.grammar_topic_id = assignment_record.grammar_topic_id;
  end if;

  return query
    select *
    from app_private.practice_assignment_summary(assignment_record.id);
end;
$$;
