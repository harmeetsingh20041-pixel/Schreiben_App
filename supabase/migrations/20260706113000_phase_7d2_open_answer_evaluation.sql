-- Phase 7D-2: DeepSeek evaluation for open/flexible worksheet answers only.
-- Local exact-answer scoring remains the default and is not replaced.

alter table public.practice_test_attempts
  add column if not exists evaluation_status text not null default 'not_needed',
  add column if not exists evaluation_started_at timestamptz,
  add column if not exists evaluation_completed_at timestamptz,
  add column if not exists evaluation_error text,
  add column if not exists evaluation_model text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'practice_test_attempts_evaluation_status_check'
      and conrelid = 'public.practice_test_attempts'::regclass
  ) then
    alter table public.practice_test_attempts
    add constraint practice_test_attempts_evaluation_status_check
    check (evaluation_status in ('not_needed', 'pending', 'evaluating', 'completed', 'failed'));
  end if;
end;
$$;

create index if not exists practice_test_attempts_evaluation_idx
on public.practice_test_attempts (workspace_id, evaluation_status, evaluation_started_at desc);

create table if not exists public.practice_attempt_question_reviews (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.practice_test_attempts(id) on delete cascade,
  assignment_id uuid not null references public.student_practice_assignments(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  question_id uuid not null references public.practice_test_questions(id) on delete cascade,
  review_status text not null,
  points_awarded numeric(6, 2) not null,
  max_points numeric(6, 2) not null default 1,
  evaluator_source text not null default 'deepseek',
  feedback_text text,
  corrected_answer text,
  model_answer text,
  short_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (attempt_id, question_id),
  check (review_status in (
    'correct',
    'partially_correct',
    'capitalization_issue',
    'minor_punctuation',
    'incorrect',
    'submitted_for_review'
  )),
  check (evaluator_source in ('deepseek', 'teacher', 'manual')),
  check (max_points > 0),
  check (points_awarded >= 0 and points_awarded <= max_points)
);

create index if not exists practice_attempt_question_reviews_attempt_idx
on public.practice_attempt_question_reviews (attempt_id, question_id);

create index if not exists practice_attempt_question_reviews_workspace_idx
on public.practice_attempt_question_reviews (workspace_id, created_at desc);

drop trigger if exists practice_attempt_question_reviews_set_updated_at on public.practice_attempt_question_reviews;
create trigger practice_attempt_question_reviews_set_updated_at
before update on public.practice_attempt_question_reviews
for each row execute function public.set_updated_at();

alter table public.practice_attempt_question_reviews enable row level security;

grant select on public.practice_attempt_question_reviews to authenticated;

drop policy if exists "practice_attempt_question_reviews_select_owner_or_teacher" on public.practice_attempt_question_reviews;
create policy "practice_attempt_question_reviews_select_owner_or_teacher"
on public.practice_attempt_question_reviews for select
to authenticated
using (
  student_id = (select auth.uid())
  or app_private.is_platform_admin()
  or app_private.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

create or replace function app_private.is_practice_question_locally_scorable(
  question_type text,
  correct_answer text
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select question_type in (
      'multiple_choice',
      'fill_blank',
      'correction',
      'sentence_correction',
      'word_order',
      'transformation',
      'rewrite_sentence',
      'short_answer'
    )
    and nullif(btrim(coalesce(correct_answer, '')), '') is not null
    and lower(btrim(coalesce(correct_answer, ''))) not in (
      'manual_review',
      'manual review',
      'open_review',
      'flexible_review',
      'requires_review'
    );
$$;

revoke all on function app_private.is_practice_question_locally_scorable(text, text) from public, anon, authenticated;

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
  next_evaluation_status text;
  scoring_mode text;
  strict_scoring boolean := false;
  scoring_version_value text := 'phase_7d2_local_then_open_evaluation_v1';
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
        evaluation_status,
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
        'not_needed',
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

  delete from public.practice_attempt_question_reviews paqr
  where paqr.attempt_id = in_progress_attempt_id;

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
    next_evaluation_status := case when manual_question_count > 0 then 'pending' else 'not_needed' end;
    scoring_mode := case when manual_question_count > 0 then 'open_answer_pending' else 'manual_review_needed' end;
  elsif manual_question_count > 0 then
    calculated_max_score_points := scored_question_count::numeric(6, 2);
    calculated_score_percent := round((calculated_score_points * 100) / calculated_max_score_points, 2);
    calculated_passed := null;
    next_attempt_status := 'submitted';
    next_assignment_status := 'completed';
    next_evaluation_status := 'pending';
    scoring_mode := 'partial_local_open_answer_pending';
  else
    calculated_max_score_points := scored_question_count::numeric(6, 2);
    calculated_score_percent := round((calculated_score_points * 100) / calculated_max_score_points, 2);
    calculated_passed := calculated_score_percent >= 70;
    next_attempt_status := 'checked';
    next_assignment_status := case when calculated_passed then 'passed' else 'failed' end;
    next_evaluation_status := 'not_needed';
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
    evaluation_status = next_evaluation_status,
    evaluation_started_at = null,
    evaluation_completed_at = null,
    evaluation_error = null,
    evaluation_model = null,
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
      'open_answer_questions', manual_question_count,
      'unscored_questions', manual_question_count,
      'open_answer_evaluation_needed', manual_question_count > 0,
      'manual_review_needed', false,
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

create or replace function public.finalize_practice_attempt_evaluation(target_attempt_id uuid)
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
set search_path = public, pg_temp
as $$
declare
  jwt_role text := current_setting('request.jwt.claim.role', true);
  attempt_record public.practice_test_attempts%rowtype;
  assignment_record public.student_practice_assignments%rowtype;
  strict_scoring boolean := false;
  total_question_count integer := 0;
  local_question_count integer := 0;
  open_question_count integer := 0;
  reviewed_open_question_count integer := 0;
  unreviewed_open_question_count integer := 0;
  full_credit_question_count integer := 0;
  local_minor_punctuation_count integer := 0;
  local_capitalization_issue_count integer := 0;
  local_incorrect_question_count integer := 0;
  deepseek_correct_count integer := 0;
  deepseek_partial_count integer := 0;
  deepseek_capitalization_issue_count integer := 0;
  deepseek_minor_punctuation_count integer := 0;
  deepseek_incorrect_count integer := 0;
  calculated_score_points numeric(6, 2);
  calculated_max_score_points numeric(6, 2);
  calculated_score_percent numeric(5, 2);
  calculated_passed boolean;
  next_attempt_status text;
  next_assignment_status text;
  next_evaluation_status text;
  scoring_mode text;
  completed_time timestamptz := now();
begin
  if jwt_role <> 'service_role' then
    raise exception 'Permission denied.'
      using errcode = '42501';
  end if;

  select pta.*
  into attempt_record
  from public.practice_test_attempts pta
  where pta.id = target_attempt_id
  for update;

  if attempt_record.id is null then
    raise exception 'Practice attempt was not found.'
      using errcode = '02000';
  end if;

  select spa.*
  into assignment_record
  from public.student_practice_assignments spa
  where spa.id = attempt_record.assignment_id
  for update;

  if assignment_record.id is null then
    raise exception 'Practice assignment was not found.'
      using errcode = '02000';
  end if;

  select app_private.is_practice_topic_strict_scoring(gt.name, gt.slug)
  into strict_scoring
  from public.grammar_topics gt
  where gt.id = assignment_record.grammar_topic_id;
  strict_scoring := coalesce(strict_scoring, false);

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
      ptq.question_type,
      ptq.correct_answer,
      app_private.is_practice_question_locally_scorable(ptq.question_type, ptq.correct_answer) as locally_scorable,
      coalesce(am.answer, '') as student_answer
    from public.practice_test_questions ptq
    left join answer_map am
      on am.answer_question_id = ptq.id
    where ptq.practice_test_id = attempt_record.practice_test_id
  ),
  local_classified as (
    select
      q.id,
      app_private.practice_answer_review_status(q.student_answer, q.correct_answer, strict_scoring) as review_status
    from questions q
    where q.locally_scorable
  ),
  local_scored as (
    select
      lc.id,
      lc.review_status,
      app_private.practice_review_status_points(lc.review_status) as points_awarded
    from local_classified lc
  ),
  open_questions as (
    select q.id
    from questions q
    where not q.locally_scorable
  ),
  open_reviews as (
    select
      oq.id,
      paqr.review_status,
      paqr.points_awarded,
      paqr.max_points
    from open_questions oq
    left join public.practice_attempt_question_reviews paqr
      on paqr.attempt_id = attempt_record.id
      and paqr.question_id = oq.id
  )
  select
    (select count(*)::integer from questions),
    (select count(*)::integer from local_scored),
    (select count(*)::integer from open_questions),
    coalesce((select count(*)::integer from open_reviews where review_status is not null), 0),
    coalesce((select count(*)::integer from open_reviews where review_status is null), 0),
    coalesce((select count(*)::integer from local_scored where review_status in ('correct', 'minor_punctuation')), 0)
      + coalesce((select count(*)::integer from open_reviews where review_status in ('correct', 'minor_punctuation')), 0),
    coalesce((select count(*)::integer from local_scored where review_status = 'minor_punctuation'), 0),
    coalesce((select count(*)::integer from local_scored where review_status = 'capitalization_issue'), 0),
    coalesce((select count(*)::integer from local_scored where review_status = 'incorrect'), 0),
    coalesce((select count(*)::integer from open_reviews where review_status = 'correct'), 0),
    coalesce((select count(*)::integer from open_reviews where review_status = 'partially_correct'), 0),
    coalesce((select count(*)::integer from open_reviews where review_status = 'capitalization_issue'), 0),
    coalesce((select count(*)::integer from open_reviews where review_status = 'minor_punctuation'), 0),
    coalesce((select count(*)::integer from open_reviews where review_status = 'incorrect'), 0),
    coalesce((select round(sum(points_awarded), 2) from local_scored), 0)
      + coalesce((select round(sum(points_awarded), 2) from open_reviews where review_status is not null), 0),
    coalesce((select count(*)::numeric(6, 2) from local_scored), 0)
      + coalesce((select round(sum(max_points), 2) from open_reviews where review_status is not null), 0)
  into
    total_question_count,
    local_question_count,
    open_question_count,
    reviewed_open_question_count,
    unreviewed_open_question_count,
    full_credit_question_count,
    local_minor_punctuation_count,
    local_capitalization_issue_count,
    local_incorrect_question_count,
    deepseek_correct_count,
    deepseek_partial_count,
    deepseek_capitalization_issue_count,
    deepseek_minor_punctuation_count,
    deepseek_incorrect_count,
    calculated_score_points,
    calculated_max_score_points;

  if calculated_max_score_points = 0 then
    calculated_score_points := null;
    calculated_max_score_points := null;
    calculated_score_percent := null;
    calculated_passed := null;
    next_attempt_status := 'submitted';
    next_assignment_status := 'completed';
    next_evaluation_status := case when open_question_count > 0 then 'pending' else 'not_needed' end;
    scoring_mode := 'manual_review_needed';
  elsif unreviewed_open_question_count > 0 then
    calculated_score_percent := round((calculated_score_points * 100) / calculated_max_score_points, 2);
    calculated_passed := null;
    next_attempt_status := 'submitted';
    next_assignment_status := 'completed';
    next_evaluation_status := 'pending';
    scoring_mode := 'partial_local_open_answer_pending';
  else
    calculated_score_percent := round((calculated_score_points * 100) / calculated_max_score_points, 2);
    calculated_passed := calculated_score_percent >= 70;
    next_attempt_status := 'checked';
    next_assignment_status := case when calculated_passed then 'passed' else 'failed' end;
    next_evaluation_status := case when open_question_count > 0 then 'completed' else 'not_needed' end;
    scoring_mode := case when open_question_count > 0 then 'local_plus_open_answer_evaluation' else 'local_objective' end;
  end if;

  update public.practice_test_attempts pta
  set
    score = full_credit_question_count,
    max_score = local_question_count + reviewed_open_question_count,
    score_points = calculated_score_points,
    max_score_points = calculated_max_score_points,
    score_percent = calculated_score_percent,
    passed = calculated_passed,
    status = next_attempt_status,
    evaluation_status = next_evaluation_status,
    evaluation_completed_at = case
      when next_evaluation_status in ('completed', 'not_needed') then completed_time
      else pta.evaluation_completed_at
    end,
    evaluation_error = case
      when next_evaluation_status in ('completed', 'not_needed') then null
      else pta.evaluation_error
    end,
    scoring_version = 'phase_7d2_local_plus_open_evaluation_v1',
    feedback = jsonb_build_object(
      'scoring_version', 'phase_7d2_local_plus_open_evaluation_v1',
      'scoring', scoring_mode,
      'total_questions', total_question_count,
      'local_questions', local_question_count,
      'open_answer_questions', open_question_count,
      'open_answer_reviewed_questions', reviewed_open_question_count,
      'open_answer_unreviewed_questions', unreviewed_open_question_count,
      'correct_questions', full_credit_question_count,
      'local_minor_punctuation_questions', local_minor_punctuation_count,
      'local_capitalization_issue_questions', local_capitalization_issue_count,
      'local_incorrect_questions', local_incorrect_question_count,
      'deepseek_correct_questions', deepseek_correct_count,
      'deepseek_partially_correct_questions', deepseek_partial_count,
      'deepseek_minor_punctuation_questions', deepseek_minor_punctuation_count,
      'deepseek_capitalization_issue_questions', deepseek_capitalization_issue_count,
      'deepseek_incorrect_questions', deepseek_incorrect_count,
      'score_points', calculated_score_points,
      'max_score_points', calculated_max_score_points,
      'score_percent', calculated_score_percent,
      'pass_threshold_percent', 70,
      'strict_scoring', strict_scoring
    )
  where pta.id = attempt_record.id;

  update public.student_practice_assignments spa
  set
    status = next_assignment_status,
    completed_at = coalesce(spa.completed_at, completed_time),
    latest_attempt_id = attempt_record.id
  where spa.id = assignment_record.id
  returning spa.* into assignment_record;

  if calculated_passed then
    update public.student_grammar_stats sgs
    set
      weakness_level = 'improving',
      practice_unlocked = false,
      updated_at = completed_time
    where sgs.workspace_id = assignment_record.workspace_id
      and sgs.student_id = assignment_record.student_id
      and sgs.grammar_topic_id = assignment_record.grammar_topic_id;
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

revoke all on function public.finalize_practice_attempt_evaluation(uuid) from public, anon, authenticated;
grant execute on function public.finalize_practice_attempt_evaluation(uuid) to service_role;

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
        paqr.review_status as stored_review_status,
        paqr.points_awarded as stored_points_awarded,
        paqr.max_points as stored_max_points,
        paqr.feedback_text,
        paqr.corrected_answer,
        paqr.model_answer,
        paqr.short_reason,
        paqr.evaluator_source,
        case
          when q.locally_scorable then app_private.practice_answer_review_status(q.student_answer, q.correct_answer, strict_scoring)
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
          when classified.locally_scorable then app_private.practice_review_status_points(classified.review_status)
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
      summary.score,
      summary.max_score,
      attempt_record.score_points,
      attempt_record.max_score_points,
      attempt_record.scoring_version,
      attempt_record.evaluation_status,
      attempt_record.evaluation_error,
      summary.score_percent,
      summary.passed,
      summary.question_count,
      reviewed.id,
      reviewed.question_number,
      reviewed.question_type,
      reviewed.prompt,
      reviewed.options,
      reviewed.student_answer,
      case when reviewed.locally_scorable then reviewed.correct_answer else null end,
      case when reviewed.locally_scorable then reviewed.explanation else null end,
      reviewed.review_status in ('correct', 'minor_punctuation') as is_correct,
      reviewed.review_status,
      reviewed.points_awarded,
      reviewed.max_points,
      reviewed.feedback_text,
      reviewed.corrected_answer,
      reviewed.model_answer,
      reviewed.short_reason,
      reviewed.evaluator_source
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
