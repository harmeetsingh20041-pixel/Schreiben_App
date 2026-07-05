-- Phase 7B: practice worksheet assignments and local objective attempts.
-- Worksheet generation and open-ended AI evaluation remain intentionally
-- deferred to later phases.

create table if not exists public.student_practice_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  grammar_topic_id uuid not null references public.grammar_topics(id) on delete cascade,
  practice_test_id uuid references public.practice_tests(id) on delete set null,
  source text not null default 'weakness_auto',
  status text not null default 'unlocked',
  assigned_by uuid references public.profiles(id) on delete set null,
  latest_attempt_id uuid references public.practice_test_attempts(id) on delete set null,
  assigned_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'student_practice_assignments_source_check'
      and conrelid = 'public.student_practice_assignments'::regclass
  ) then
    alter table public.student_practice_assignments
    add constraint student_practice_assignments_source_check
    check (source in ('weakness_auto', 'teacher_assigned', 'manual'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'student_practice_assignments_status_check'
      and conrelid = 'public.student_practice_assignments'::regclass
  ) then
    alter table public.student_practice_assignments
    add constraint student_practice_assignments_status_check
    check (status in ('unlocked', 'in_progress', 'completed', 'passed', 'failed', 'cancelled'));
  end if;
end $$;

create unique index if not exists student_practice_assignments_one_active_topic_idx
on public.student_practice_assignments (workspace_id, student_id, grammar_topic_id)
where status in ('unlocked', 'in_progress');

create index if not exists student_practice_assignments_student_topic_idx
on public.student_practice_assignments (workspace_id, student_id, grammar_topic_id, assigned_at desc);

create index if not exists student_practice_assignments_workspace_status_idx
on public.student_practice_assignments (workspace_id, status, updated_at desc);

create index if not exists student_practice_assignments_practice_test_idx
on public.student_practice_assignments (practice_test_id)
where practice_test_id is not null;

drop trigger if exists student_practice_assignments_set_updated_at on public.student_practice_assignments;
create trigger student_practice_assignments_set_updated_at
before update on public.student_practice_assignments
for each row execute function public.set_updated_at();

alter table public.student_practice_assignments enable row level security;

grant select, insert, update on public.student_practice_assignments to authenticated;

drop policy if exists "student_practice_assignments_select_owner_or_teacher" on public.student_practice_assignments;
create policy "student_practice_assignments_select_owner_or_teacher"
on public.student_practice_assignments for select
to authenticated
using (
  public.is_platform_admin()
  or student_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

drop policy if exists "student_practice_assignments_insert_teachers" on public.student_practice_assignments;
create policy "student_practice_assignments_insert_teachers"
on public.student_practice_assignments for insert
to authenticated
with check (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

drop policy if exists "student_practice_assignments_update_teachers" on public.student_practice_assignments;
create policy "student_practice_assignments_update_teachers"
on public.student_practice_assignments for update
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
)
with check (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

alter table public.practice_test_attempts
add column if not exists assignment_id uuid references public.student_practice_assignments(id) on delete set null,
add column if not exists status text not null default 'checked',
add column if not exists started_at timestamptz,
add column if not exists submitted_at timestamptz,
add column if not exists score_percent numeric(5, 2),
add column if not exists passed boolean;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'practice_test_attempts_status_check'
      and conrelid = 'public.practice_test_attempts'::regclass
  ) then
    alter table public.practice_test_attempts
    add constraint practice_test_attempts_status_check
    check (status in ('in_progress', 'submitted', 'checked'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'practice_test_attempts_score_percent_check'
      and conrelid = 'public.practice_test_attempts'::regclass
  ) then
    alter table public.practice_test_attempts
    add constraint practice_test_attempts_score_percent_check
    check (score_percent is null or (score_percent >= 0 and score_percent <= 100));
  end if;
end $$;

update public.practice_test_attempts
set started_at = created_at
where started_at is null;

update public.practice_test_attempts
set submitted_at = completed_at
where submitted_at is null
  and completed_at is not null;

create index if not exists practice_test_attempts_assignment_idx
on public.practice_test_attempts (assignment_id, created_at desc)
where assignment_id is not null;

create unique index if not exists practice_test_attempts_one_in_progress_per_assignment_idx
on public.practice_test_attempts (assignment_id)
where assignment_id is not null
  and status = 'in_progress';

drop policy if exists "practice_test_attempts_insert_student" on public.practice_test_attempts;

create or replace function app_private.practice_assignment_summary(target_assignment_id uuid)
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
security definer
set search_path = public, pg_temp
stable
as $$
  select
    spa.id as assignment_id,
    spa.workspace_id,
    spa.student_id,
    spa.grammar_topic_id,
    gt.name as grammar_topic_name,
    gt.slug as grammar_topic_slug,
    spa.practice_test_id,
    pt.title as worksheet_title,
    pt.level as worksheet_level,
    pt.difficulty as worksheet_difficulty,
    spa.status,
    spa.source,
    spa.assigned_at,
    spa.started_at,
    spa.completed_at,
    spa.latest_attempt_id,
    pta.status as latest_attempt_status,
    pta.score,
    pta.max_score,
    pta.score_percent,
    pta.passed,
    coalesce(question_totals.question_count, 0)::integer as question_count
  from public.student_practice_assignments spa
  join public.grammar_topics gt
    on gt.id = spa.grammar_topic_id
  left join public.practice_tests pt
    on pt.id = spa.practice_test_id
  left join public.practice_test_attempts pta
    on pta.id = spa.latest_attempt_id
  left join lateral (
    select count(*)::integer as question_count
    from public.practice_test_questions ptq
    where ptq.practice_test_id = spa.practice_test_id
  ) question_totals on true
  where spa.id = target_assignment_id;
$$;

revoke all on function app_private.practice_assignment_summary(uuid) from public, anon, authenticated;

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
    case pt.difficulty
      when 'easy' then 1
      when 'medium' then 2
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

create or replace function public.ensure_student_practice_assignment(
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
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.ensure_student_practice_assignment_internal(
    target_workspace_id,
    target_student_id,
    target_grammar_topic_id
  );
$$;

revoke all on function app_private.ensure_student_practice_assignment_internal(uuid, uuid, uuid) from public, anon;
grant execute on function app_private.ensure_student_practice_assignment_internal(uuid, uuid, uuid) to authenticated;

revoke all on function public.ensure_student_practice_assignment(uuid, uuid, uuid) from public, anon;
grant execute on function public.ensure_student_practice_assignment(uuid, uuid, uuid) to authenticated;

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
  objective_question_count integer := 0;
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
  into objective_question_count
  from public.practice_test_questions ptq
  where ptq.practice_test_id = assignment_record.practice_test_id
    and ptq.question_type in ('multiple_choice', 'fill_blank', 'correction', 'short_answer');

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
        objective_question_count,
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

create or replace function public.start_practice_assignment(target_assignment_id uuid)
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
  from app_private.start_practice_assignment_internal(target_assignment_id);
$$;

revoke all on function app_private.start_practice_assignment_internal(uuid) from public, anon;
grant execute on function app_private.start_practice_assignment_internal(uuid) to authenticated;

revoke all on function public.start_practice_assignment(uuid) from public, anon;
grant execute on function public.start_practice_assignment(uuid) to authenticated;

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
  correct_answer_count integer := 0;
  calculated_score_percent numeric(5, 2);
  calculated_passed boolean;
  completed_time timestamptz := now();
  next_assignment_status text;
  next_attempt_status text;
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
    select
      (answer_item ->> 'question_id')::uuid as question_id,
      answer_item ->> 'answer' as answer
    from jsonb_array_elements(submitted_answers) answer_item
    where (answer_item ->> 'question_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  scored as (
    select
      ptq.id,
      case
        when regexp_replace(lower(btrim(coalesce(submitted.answer, ''))), '\s+', ' ', 'g')
          = regexp_replace(lower(btrim(ptq.correct_answer)), '\s+', ' ', 'g')
        then 1
        else 0
      end as is_correct
    from public.practice_test_questions ptq
    left join submitted
      on submitted.question_id = ptq.id
    where ptq.practice_test_id = assignment_record.practice_test_id
      and ptq.question_type in ('multiple_choice', 'fill_blank', 'correction', 'short_answer')
  )
  select
    count(*)::integer,
    coalesce(sum(scored.is_correct), 0)::integer
  into objective_question_count, correct_answer_count
  from scored;

  if objective_question_count > 0 then
    calculated_score_percent := round((correct_answer_count::numeric * 100) / objective_question_count, 2);
    calculated_passed := calculated_score_percent >= 70;
    next_attempt_status := 'checked';
    next_assignment_status := case when calculated_passed then 'passed' else 'failed' end;
  else
    calculated_score_percent := null;
    calculated_passed := null;
    next_attempt_status := 'submitted';
    next_assignment_status := 'completed';
  end if;

  update public.practice_test_attempts pta
  set
    answers = submitted_answers,
    score = correct_answer_count,
    max_score = objective_question_count,
    status = next_attempt_status,
    submitted_at = completed_time,
    completed_at = completed_time,
    score_percent = calculated_score_percent,
    passed = calculated_passed,
    feedback = jsonb_build_object(
      'scoring', case
        when objective_question_count > 0 then 'local_objective'
        else 'manual_review_needed'
      end,
      'correct_objective_answers', correct_answer_count,
      'objective_questions', objective_question_count,
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

  if objective_question_count > 0 then
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

create or replace function public.submit_practice_attempt(
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
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.submit_practice_attempt_internal(target_assignment_id, submitted_answers);
$$;

revoke all on function app_private.submit_practice_attempt_internal(uuid, jsonb) from public, anon;
grant execute on function app_private.submit_practice_attempt_internal(uuid, jsonb) to authenticated;

revoke all on function public.submit_practice_attempt(uuid, jsonb) from public, anon;
grant execute on function public.submit_practice_attempt(uuid, jsonb) to authenticated;
