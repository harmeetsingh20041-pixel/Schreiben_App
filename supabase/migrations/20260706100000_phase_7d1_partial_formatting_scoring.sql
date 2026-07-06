-- Phase 7D-1: partial credit for punctuation and capitalization issues.
-- DeepSeek answer evaluation remains deferred; this is local exact-answer scoring only.

alter table public.practice_test_attempts
  add column if not exists score_points numeric(6, 2),
  add column if not exists max_score_points numeric(6, 2),
  add column if not exists scoring_version text;

create or replace function app_private.normalize_practice_answer_exact(answer_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select btrim(regexp_replace(btrim(coalesce(answer_value, '')), '\s+', ' ', 'g'));
$$;

revoke all on function app_private.normalize_practice_answer_exact(text) from public, anon, authenticated;

create or replace function app_private.normalize_practice_answer_without_final_punctuation(answer_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select btrim(regexp_replace(app_private.normalize_practice_answer_exact(answer_value), '[.!?]+$', '', 'g'));
$$;

revoke all on function app_private.normalize_practice_answer_without_final_punctuation(text) from public, anon, authenticated;

create or replace function app_private.practice_answer_review_status(
  submitted_answer text,
  correct_answer text,
  strict_scoring boolean
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  with normalized as (
    select
      app_private.normalize_practice_answer_exact(submitted_answer) as submitted_exact,
      app_private.normalize_practice_answer_exact(correct_answer) as correct_exact,
      app_private.normalize_practice_answer_without_final_punctuation(submitted_answer) as submitted_without_punctuation,
      app_private.normalize_practice_answer_without_final_punctuation(correct_answer) as correct_without_punctuation
  )
  select case
    when nullif(btrim(coalesce(correct_answer, '')), '') is null then 'submitted_for_review'
    when submitted_exact = correct_exact then 'correct'
    when submitted_without_punctuation = correct_without_punctuation then 'minor_punctuation'
    when not strict_scoring
      and lower(submitted_without_punctuation) = lower(correct_without_punctuation)
      then 'capitalization_issue'
    else 'incorrect'
  end
  from normalized;
$$;

revoke all on function app_private.practice_answer_review_status(text, text, boolean) from public, anon, authenticated;

create or replace function app_private.practice_review_status_points(review_status text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case review_status
    when 'correct' then 1.00
    when 'minor_punctuation' then 1.00
    when 'capitalization_issue' then 0.50
    when 'incorrect' then 0.00
    else null
  end;
$$;

revoke all on function app_private.practice_review_status_points(text) from public, anon, authenticated;

create or replace function app_private.practice_answer_is_correct(
  submitted_answer text,
  correct_answer text,
  strict_scoring boolean
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select app_private.practice_answer_review_status(submitted_answer, correct_answer, strict_scoring)
    in ('correct', 'minor_punctuation');
$$;

revoke all on function app_private.practice_answer_is_correct(text, text, boolean) from public, anon, authenticated;

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
  minor_punctuation_count integer := 0;
  capitalization_issue_count integer := 0;
  incorrect_question_count integer := 0;
  calculated_score_points numeric(6, 2);
  calculated_max_score_points numeric(6, 2);
  calculated_score_percent numeric(5, 2);
  calculated_passed boolean;
  completed_time timestamptz := now();
  next_assignment_status text;
  next_attempt_status text;
  scoring_mode text;
  strict_scoring boolean := false;
  scoring_version_value text := 'phase_7d1_partial_formatting_v1';
begin
  if caller_id is null then
    raise exception 'Authentication required.'
      using errcode = '28000';
  end if;

  if submitted_answers is null or jsonb_typeof(submitted_answers) <> 'array' then
    raise exception 'Answers must be submitted as a JSON array.'
      using errcode = '22023';
  end if;

  if jsonb_array_length(submitted_answers) > 20 then
    raise exception 'Too many answers were submitted at once.'
      using errcode = '22023';
  end if;

  if octet_length(submitted_answers::text) > 25000 then
    raise exception 'Worksheet answers are too large to submit. Please shorten your answers.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(submitted_answers) answer_item
    where jsonb_typeof(answer_item) <> 'object'
      or not ((answer_item ->> 'question_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      or length(coalesce(answer_item ->> 'answer', '')) > 1000
  ) then
    raise exception 'One or more worksheet answers are too long or invalid.'
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

  select app_private.is_practice_topic_strict_scoring(gt.name, gt.slug)
  into strict_scoring
  from public.grammar_topics gt
  where gt.id = assignment_record.grammar_topic_id;

  strict_scoring := coalesce(strict_scoring, false);

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
        score_points,
        max_score_points,
        scoring_version,
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
        null,
        null,
        scoring_version_value,
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
      left(coalesce(answer_item ->> 'answer', ''), 1000) as answer
    from jsonb_array_elements(submitted_answers) answer_item
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
    where app_private.is_practice_question_locally_scorable(aq.question_type, aq.correct_answer)
  ),
  classified as (
    select
      sq.id,
      app_private.practice_answer_review_status(
        coalesce(submitted.answer, ''),
        sq.correct_answer,
        strict_scoring
      ) as review_status
    from scorable_questions sq
    left join submitted
      on submitted.question_id = sq.id
  ),
  scored as (
    select
      classified.id,
      classified.review_status,
      app_private.practice_review_status_points(classified.review_status) as points_awarded
    from classified
  )
  select
    (select count(*)::integer from all_questions),
    (select count(*)::integer from scorable_questions),
    coalesce((select count(*)::integer from scored where review_status in ('correct', 'minor_punctuation')), 0),
    coalesce((select count(*)::integer from scored where review_status = 'minor_punctuation'), 0),
    coalesce((select count(*)::integer from scored where review_status = 'capitalization_issue'), 0),
    coalesce((select count(*)::integer from scored where review_status = 'incorrect'), 0),
    coalesce((select round(sum(points_awarded), 2) from scored), 0)
  into
    total_question_count,
    scored_question_count,
    correct_answer_count,
    minor_punctuation_count,
    capitalization_issue_count,
    incorrect_question_count,
    calculated_score_points;

  manual_question_count := greatest(total_question_count - scored_question_count, 0);

  if scored_question_count = 0 then
    calculated_score_points := null;
    calculated_max_score_points := null;
    calculated_score_percent := null;
    calculated_passed := null;
    next_attempt_status := 'submitted';
    next_assignment_status := 'completed';
    scoring_mode := 'manual_review_needed';
  elsif manual_question_count > 0 then
    calculated_max_score_points := scored_question_count::numeric(6, 2);
    calculated_score_percent := round((calculated_score_points * 100) / calculated_max_score_points, 2);
    calculated_passed := null;
    next_attempt_status := 'submitted';
    next_assignment_status := 'completed';
    scoring_mode := 'partial_local';
  else
    calculated_max_score_points := scored_question_count::numeric(6, 2);
    calculated_score_percent := round((calculated_score_points * 100) / calculated_max_score_points, 2);
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
    score_points = calculated_score_points,
    max_score_points = calculated_max_score_points,
    scoring_version = scoring_version_value,
    status = next_attempt_status,
    submitted_at = completed_time,
    completed_at = completed_time,
    score_percent = calculated_score_percent,
    passed = calculated_passed,
    feedback = jsonb_build_object(
      'scoring_version', scoring_version_value,
      'scoring', scoring_mode,
      'correct_objective_answers', correct_answer_count,
      'correct_questions', correct_answer_count,
      'minor_punctuation_questions', minor_punctuation_count,
      'capitalization_issue_questions', capitalization_issue_count,
      'incorrect_questions', incorrect_question_count,
      'total_questions', total_question_count,
      'objective_questions', scored_question_count,
      'scored_questions', scored_question_count,
      'unscored_questions', manual_question_count,
      'manual_review_needed', manual_question_count > 0,
      'score_points', calculated_score_points,
      'max_score_points', calculated_max_score_points,
      'score_percent', calculated_score_percent,
      'pass_threshold_percent', 70,
      'strict_scoring', strict_scoring,
      'scoring_normalization', case
        when strict_scoring then 'case_sensitive_trim_spaces_ignore_final_punctuation'
        else 'case_sensitive_exact_then_punctuation_then_case_partial'
      end
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
      total_correct_after_practice = sgs.total_correct_after_practice
        + coalesce(floor(calculated_score_points), 0)::integer,
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

drop function if exists public.get_practice_assignment_review(uuid);
drop function if exists app_private.get_practice_assignment_review_internal(uuid);

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
  score_points numeric,
  max_score_points numeric,
  scoring_version text,
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
  max_points numeric
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
    classified as (
      select
        q.*,
        case
          when q.locally_scorable then app_private.practice_answer_review_status(q.student_answer, q.correct_answer, strict_scoring)
          else 'submitted_for_review'
        end as review_status
      from questions q
    ),
    reviewed as (
      select
        classified.*,
        case
          when classified.locally_scorable then app_private.practice_review_status_points(classified.review_status)
          else null
        end as points_awarded,
        case
          when classified.locally_scorable then 1::numeric
          else null
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
      summary.score,
      summary.max_score,
      attempt_record.score_points,
      attempt_record.max_score_points,
      attempt_record.scoring_version,
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
      reviewed.review_status in ('correct', 'minor_punctuation') as is_correct,
      reviewed.review_status,
      reviewed.points_awarded,
      reviewed.max_points
    from app_private.practice_assignment_summary(assignment_record.id) summary
    cross join reviewed
    order by reviewed.question_number asc;
end;
$$;

create or replace function public.get_practice_assignment_review(target_assignment_id uuid)
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
  max_points numeric
)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.get_practice_assignment_review_internal(target_assignment_id);
$$;

revoke all on function app_private.submit_practice_attempt_internal(uuid, jsonb) from public, anon;
grant execute on function app_private.submit_practice_attempt_internal(uuid, jsonb) to authenticated;

revoke all on function app_private.get_practice_assignment_review_internal(uuid) from public, anon;
grant execute on function app_private.get_practice_assignment_review_internal(uuid) to authenticated;

revoke all on function public.get_practice_assignment_review(uuid) from public, anon;
grant execute on function public.get_practice_assignment_review(uuid) to authenticated;
