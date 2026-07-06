-- Phase 7E-1 stabilization: failed source assignments may have one adaptive child.
-- Adaptive repeat assignments do not create infinite automatic repeat chains.

create or replace function app_private.create_next_practice_assignment_internal(target_assignment_id uuid)
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
  source_assignment public.student_practice_assignments%rowtype;
  existing_child_assignment_id uuid;
  active_assignment_id uuid;
  new_assignment_id uuid;
  next_repeat_number integer;
begin
  if caller_id is null then
    raise exception 'Authentication required.'
      using errcode = '28000';
  end if;

  if target_assignment_id is null then
    raise exception 'Practice assignment is required.'
      using errcode = '22023';
  end if;

  select spa.*
  into source_assignment
  from public.student_practice_assignments spa
  where spa.id = target_assignment_id
  for update;

  if source_assignment.id is null then
    raise exception 'Practice assignment was not found.'
      using errcode = '02000';
  end if;

  if caller_id <> source_assignment.student_id
    and not app_private.is_platform_admin()
    and not app_private.has_workspace_role(source_assignment.workspace_id, array['owner', 'teacher'])
  then
    raise exception 'Permission denied.'
      using errcode = '42501';
  end if;

  if source_assignment.status not in ('completed', 'passed', 'failed') then
    raise exception 'Next practice is available after worksheet completion.'
      using errcode = '22023';
  end if;

  if source_assignment.status <> 'failed' then
    return query
      select *
      from app_private.practice_assignment_summary(source_assignment.id);
    return;
  end if;

  select spa.id
  into existing_child_assignment_id
  from public.student_practice_assignments spa
  where spa.previous_assignment_id = source_assignment.id
    and spa.source = 'adaptive_repeat'
    and spa.status <> 'cancelled'
  order by spa.assigned_at desc
  limit 1;

  if existing_child_assignment_id is not null then
    return query
      select *
      from app_private.practice_assignment_summary(existing_child_assignment_id);
    return;
  end if;

  if source_assignment.source = 'adaptive_repeat' then
    return query
      select *
      from app_private.practice_assignment_summary(source_assignment.id);
    return;
  end if;

  select spa.id
  into active_assignment_id
  from public.student_practice_assignments spa
  where spa.workspace_id = source_assignment.workspace_id
    and spa.student_id = source_assignment.student_id
    and spa.grammar_topic_id = source_assignment.grammar_topic_id
    and spa.status in ('unlocked', 'in_progress')
  order by spa.assigned_at desc
  limit 1;

  if active_assignment_id is not null then
    return query
      select *
      from app_private.practice_assignment_summary(active_assignment_id);
    return;
  end if;

  next_repeat_number := greatest(coalesce(source_assignment.repeat_number, 0), 0) + 1;

  begin
    insert into public.student_practice_assignments (
      workspace_id,
      student_id,
      grammar_topic_id,
      practice_test_id,
      source,
      status,
      assigned_by,
      previous_assignment_id,
      previous_attempt_id,
      repeat_number,
      adaptive_reason,
      adaptive_status,
      generation_status
    )
    values (
      source_assignment.workspace_id,
      source_assignment.student_id,
      source_assignment.grammar_topic_id,
      null,
      'adaptive_repeat',
      'unlocked',
      case
        when caller_id <> source_assignment.student_id then caller_id
        else null
      end,
      source_assignment.id,
      source_assignment.latest_attempt_id,
      next_repeat_number,
      'failed_previous_worksheet',
      'repeat_unlocked',
      'idle'
    )
    returning id into new_assignment_id;
  exception
    when unique_violation then
      select spa.id
      into new_assignment_id
      from public.student_practice_assignments spa
      where spa.workspace_id = source_assignment.workspace_id
        and spa.student_id = source_assignment.student_id
        and spa.grammar_topic_id = source_assignment.grammar_topic_id
        and spa.status in ('unlocked', 'in_progress')
      order by spa.assigned_at desc
      limit 1;
  end;

  return query
    select *
    from app_private.practice_assignment_summary(new_assignment_id);
end;
$$;

revoke all on function app_private.create_next_practice_assignment_internal(uuid) from public, anon;
grant execute on function app_private.create_next_practice_assignment_internal(uuid) to authenticated;
