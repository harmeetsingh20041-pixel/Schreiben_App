-- Phase 7B safety/scoring follow-up:
-- - Students must not receive worksheet answer keys or explanations before submission.
-- - Blank/missing answer keys must not be counted as wrong.
-- - Reuse should not blindly prefer the easiest worksheet for A2+ learners.

drop policy if exists "practice_test_questions_select_parent_visible" on public.practice_test_questions;
create policy "practice_test_questions_select_parent_visible"
on public.practice_test_questions for select
to authenticated
using (
  exists (
    select 1
    from public.practice_tests pt
    where pt.id = practice_test_questions.practice_test_id
      and (
        public.is_platform_admin()
        or public.has_workspace_role(pt.workspace_id, array['owner', 'teacher'])
      )
  )
);

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
      ptq.options
    from public.practice_test_questions ptq
    where ptq.practice_test_id = assignment_record.practice_test_id
    order by ptq.question_number asc;
end;
$$;

create or replace function public.get_practice_assignment_questions(target_assignment_id uuid)
returns table (
  id uuid,
  question_number integer,
  question_type text,
  prompt text,
  options jsonb
)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.get_practice_assignment_questions_internal(target_assignment_id);
$$;

revoke all on function app_private.get_practice_assignment_questions_internal(uuid) from public, anon;
grant execute on function app_private.get_practice_assignment_questions_internal(uuid) to authenticated;

revoke all on function public.get_practice_assignment_questions(uuid) from public, anon;
grant execute on function public.get_practice_assignment_questions(uuid) to authenticated;

create or replace function app_private.list_student_practice_assignments_internal(
  target_workspace_id uuid,
  target_student_id uuid
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
begin
  if caller_id is null then
    raise exception 'Authentication required.'
      using errcode = '28000';
  end if;

  if target_workspace_id is null or target_student_id is null then
    raise exception 'Workspace and student are required.'
      using errcode = '22023';
  end if;

  if caller_id <> target_student_id
    and not app_private.is_platform_admin()
    and not app_private.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception 'Permission denied.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = target_student_id
      and wm.role = 'student'
  ) then
    raise exception 'Student is not a member of this workspace.'
      using errcode = '42501';
  end if;

  return query
    select summary.*
    from (
      select spa.id
      from public.student_practice_assignments spa
      where spa.workspace_id = target_workspace_id
        and spa.student_id = target_student_id
      order by spa.updated_at desc
      limit 40
    ) assignments
    cross join lateral app_private.practice_assignment_summary(assignments.id) summary;
end;
$$;

create or replace function public.list_student_practice_assignments(
  target_workspace_id uuid,
  target_student_id uuid
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
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.list_student_practice_assignments_internal(target_workspace_id, target_student_id);
$$;

revoke all on function app_private.list_student_practice_assignments_internal(uuid, uuid) from public, anon;
grant execute on function app_private.list_student_practice_assignments_internal(uuid, uuid) to authenticated;

revoke all on function public.list_student_practice_assignments(uuid, uuid) from public, anon;
grant execute on function public.list_student_practice_assignments(uuid, uuid) to authenticated;

create or replace function app_private.ensure_student_practice_assignment_internal(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid
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
  stats_record public.student_grammar_stats%rowtype;
  selected_practice_test_id uuid;
  selected_level text;
  new_assignment_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required.'
      using errcode = '28000';
  end if;

  if target_workspace_id is null or target_student_id is null or target_grammar_topic_id is null then
    raise exception 'Workspace, student, and grammar topic are required.'
      using errcode = '22023';
  end if;

  if caller_id <> target_student_id
    and not app_private.is_platform_admin()
    and not app_private.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception 'Permission denied.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = target_student_id
      and wm.role = 'student'
  ) then
    raise exception 'Student is not a member of this workspace.'
      using errcode = '42501';
  end if;

  select sgs.*
  into stats_record
  from public.student_grammar_stats sgs
  where sgs.workspace_id = target_workspace_id
    and sgs.student_id = target_student_id
    and sgs.grammar_topic_id = target_grammar_topic_id
    and (
      sgs.practice_unlocked = true
      or sgs.weakness_level = 'unlocked'
    )
  limit 1;

  if stats_record.id is null then
    raise exception 'Practice is not unlocked for this grammar topic.'
      using errcode = '42501';
  end if;

  select spa.*
  into assignment_record
  from public.student_practice_assignments spa
  where spa.workspace_id = target_workspace_id
    and spa.student_id = target_student_id
    and spa.grammar_topic_id = target_grammar_topic_id
    and spa.status in ('unlocked', 'in_progress')
  order by spa.assigned_at desc
  limit 1;

  select
    coalesce(
      case
        when gt.level in ('A1', 'A2', 'B1', 'B2') then gt.level
        else null
      end,
      (
        select b.level
        from public.batch_students bs
        join public.batches b
          on b.id = bs.batch_id
        where bs.workspace_id = target_workspace_id
          and bs.student_id = target_student_id
          and b.workspace_id = target_workspace_id
          and b.is_active = true
        order by bs.created_at desc
        limit 1
      ),
      'A2'
    )
  into selected_level
  from public.grammar_topics gt
  where gt.id = target_grammar_topic_id;

  select pt.id
  into selected_practice_test_id
  from public.practice_tests pt
  where pt.workspace_id = target_workspace_id
    and pt.grammar_topic_id = target_grammar_topic_id
    and pt.level = selected_level
    and pt.visibility = 'workspace'
    and pt.teacher_reviewed = true
    and pt.difficulty in ('easy', 'medium')
  order by
    case
      when selected_level = 'A1' and pt.difficulty = 'easy' then 1
      when selected_level = 'A1' and pt.difficulty = 'medium' then 2
      when selected_level in ('A2', 'B1', 'B2') and pt.difficulty = 'medium' then 1
      when selected_level in ('A2', 'B1', 'B2') and pt.difficulty = 'easy' then 2
      else 3
    end,
    pt.created_at desc
  limit 1;

  if assignment_record.id is not null then
    if assignment_record.practice_test_id is null
      and selected_practice_test_id is not null
    then
      update public.student_practice_assignments spa
      set practice_test_id = selected_practice_test_id
      where spa.id = assignment_record.id
      returning spa.* into assignment_record;
    end if;

    return query
      select *
      from app_private.practice_assignment_summary(assignment_record.id);
    return;
  end if;

  select spa.*
  into assignment_record
  from public.student_practice_assignments spa
  where spa.workspace_id = target_workspace_id
    and spa.student_id = target_student_id
    and spa.grammar_topic_id = target_grammar_topic_id
    and spa.status in ('completed', 'passed', 'failed')
    and coalesce(spa.completed_at, spa.updated_at, spa.assigned_at) >= stats_record.updated_at
  order by coalesce(spa.completed_at, spa.updated_at, spa.assigned_at) desc
  limit 1;

  if assignment_record.id is not null then
    return query
      select *
      from app_private.practice_assignment_summary(assignment_record.id);
    return;
  end if;

  begin
    insert into public.student_practice_assignments (
      workspace_id,
      student_id,
      grammar_topic_id,
      practice_test_id,
      source,
      status,
      assigned_by
    )
    values (
      target_workspace_id,
      target_student_id,
      target_grammar_topic_id,
      selected_practice_test_id,
      'weakness_auto',
      'unlocked',
      case
        when caller_id <> target_student_id then caller_id
        else null
      end
    )
    returning id into new_assignment_id;
  exception
    when unique_violation then
      select spa.id
      into new_assignment_id
      from public.student_practice_assignments spa
      where spa.workspace_id = target_workspace_id
        and spa.student_id = target_student_id
        and spa.grammar_topic_id = target_grammar_topic_id
        and spa.status in ('unlocked', 'in_progress')
      order by spa.assigned_at desc
      limit 1;
  end;

  return query
    select *
    from app_private.practice_assignment_summary(new_assignment_id);
end;
$$;

create or replace function app_private.start_practice_assignment_internal(target_assignment_id uuid)
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
  scored_question_count integer := 0;
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

  select count(*)::integer
  into scored_question_count
  from public.practice_test_questions ptq
  where ptq.practice_test_id = assignment_record.practice_test_id
    and ptq.question_type in ('multiple_choice', 'fill_blank', 'correction', 'short_answer')
    and nullif(btrim(coalesce(ptq.correct_answer, '')), '') is not null;

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
        scored_question_count,
        'in_progress',
        now()
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

  update public.student_practice_assignments spa
  set
    status = 'in_progress',
    started_at = coalesce(spa.started_at, now()),
    latest_attempt_id = in_progress_attempt_id
  where spa.id = assignment_record.id
  returning spa.* into assignment_record;

  return query
    select *
    from app_private.practice_assignment_summary(assignment_record.id);
end;
$$;

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
  objective_question_count integer := 0;
  scored_question_count integer := 0;
  unscored_question_count integer := 0;
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
  local_questions as (
    select
      ptq.id,
      ptq.correct_answer
    from public.practice_test_questions ptq
    where ptq.practice_test_id = assignment_record.practice_test_id
      and ptq.question_type in ('multiple_choice', 'fill_blank', 'correction', 'short_answer')
  ),
  scored as (
    select
      lq.id,
      case
        when regexp_replace(lower(btrim(coalesce(submitted.answer, ''))), '\s+', ' ', 'g')
          = regexp_replace(lower(btrim(lq.correct_answer)), '\s+', ' ', 'g')
        then 1
        else 0
      end as is_correct
    from local_questions lq
    left join submitted
      on submitted.question_id = lq.id
    where nullif(btrim(coalesce(lq.correct_answer, '')), '') is not null
  )
  select
    (select count(*)::integer from local_questions),
    (select count(*)::integer from local_questions where nullif(btrim(coalesce(correct_answer, '')), '') is not null),
    coalesce((select sum(scored.is_correct)::integer from scored), 0)
  into objective_question_count, scored_question_count, correct_answer_count;

  unscored_question_count := greatest(objective_question_count - scored_question_count, 0);

  if scored_question_count = 0 then
    calculated_score_percent := null;
    calculated_passed := null;
    next_attempt_status := 'submitted';
    next_assignment_status := 'completed';
    scoring_mode := 'manual_review_needed';
  elsif unscored_question_count > 0 then
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
      'objective_questions', objective_question_count,
      'scored_questions', scored_question_count,
      'unscored_questions', unscored_question_count,
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
