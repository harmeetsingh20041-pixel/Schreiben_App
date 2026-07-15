-- A transaction can advance several adaptive-practice transitions at the same
-- PostgreSQL timestamp. Random UUID ordering must never choose an older passed
-- worksheet over the latest failed retry, otherwise the one-repeat-child guard
-- can prevent the next active assignment from being established.

create or replace function app_private.ensure_practice_cycle_assignment_internal(
  target_cycle_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  previous_assignment public.student_practice_assignments%rowtype;
  selected_practice_test_id uuid;
  new_assignment_id uuid;
  new_state text;
  next_repeat_number integer := 0;
begin
  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.id = target_cycle_id
  for update;

  if selected_cycle.id is null
    or selected_cycle.resolved_at is not null
    or selected_cycle.state = 'locked'
  then
    return null;
  end if;

  if not exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = selected_cycle.workspace_id
      and member.user_id = selected_cycle.student_id
      and member.role = 'student'
  ) then
    return null;
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.resolution_cycle_id = selected_cycle.id
    and assignment.status in ('unlocked', 'in_progress', 'completed')
  order by
    assignment.repeat_number desc,
    assignment.assigned_at desc,
    assignment.id desc
  limit 1
  for update;

  if selected_assignment.id is null then
    select assignment.*
    into selected_assignment
    from public.student_practice_assignments assignment
    where assignment.workspace_id = selected_cycle.workspace_id
      and assignment.student_id = selected_cycle.student_id
      and assignment.grammar_topic_id = selected_cycle.grammar_topic_id
      and assignment.status in ('unlocked', 'in_progress', 'completed')
    order by
      assignment.resolution_cycle_number desc nulls last,
      assignment.repeat_number desc,
      assignment.assigned_at desc,
      assignment.id desc
    limit 1
    for update;

    if selected_assignment.id is not null
      and selected_assignment.resolution_cycle_id is null
    then
      update public.student_practice_assignments assignment
      set
        resolution_cycle_id = selected_cycle.id,
        resolution_cycle_number = selected_cycle.cycle_number,
        evidence_cutoff_sequence = selected_cycle.evidence_through_sequence
      where assignment.id = selected_assignment.id
      returning assignment.* into selected_assignment;
    elsif selected_assignment.id is not null
      and selected_assignment.resolution_cycle_id <> selected_cycle.id
    then
      raise exception using
        errcode = '55000',
        message = 'A different practice cycle already has the active assignment.';
    end if;
  end if;

  if selected_assignment.id is null then
    select assignment.*
    into previous_assignment
    from public.student_practice_assignments assignment
    where assignment.workspace_id = selected_cycle.workspace_id
      and assignment.student_id = selected_cycle.student_id
      and assignment.grammar_topic_id = selected_cycle.grammar_topic_id
      and assignment.status in ('passed', 'failed', 'cancelled')
    order by
      case
        when assignment.resolution_cycle_id = selected_cycle.id then 1
        else 0
      end desc,
      assignment.resolution_cycle_number desc nulls last,
      assignment.repeat_number desc,
      coalesce(
        assignment.completed_at,
        assignment.updated_at,
        assignment.assigned_at
      ) desc,
      assignment.id desc
    limit 1;

    select coalesce(max(assignment.repeat_number), -1) + 1
    into next_repeat_number
    from public.student_practice_assignments assignment
    where assignment.workspace_id = selected_cycle.workspace_id
      and assignment.student_id = selected_cycle.student_id
      and assignment.grammar_topic_id = selected_cycle.grammar_topic_id;
    next_repeat_number := greatest(
      next_repeat_number,
      selected_cycle.cycle_number - 1,
      0
    );

    selected_practice_test_id := app_private.select_practice_test_for_cycle(
      selected_cycle.workspace_id,
      selected_cycle.student_id,
      selected_cycle.grammar_topic_id
    );

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
        generation_status,
        resolution_cycle_id,
        resolution_cycle_number,
        evidence_cutoff_sequence
      ) values (
        selected_cycle.workspace_id,
        selected_cycle.student_id,
        selected_cycle.grammar_topic_id,
        selected_practice_test_id,
        case
          when selected_cycle.cycle_number = 1
            and previous_assignment.id is null
          then 'weakness_auto'
          else 'adaptive_repeat'
        end,
        'unlocked',
        null,
        previous_assignment.id,
        previous_assignment.latest_attempt_id,
        next_repeat_number,
        case
          when previous_assignment.status = 'failed'
          then 'failed_previous_worksheet'
          else 'recurring_released_weakness'
        end,
        case
          when selected_cycle.cycle_number = 1
            and previous_assignment.id is null
          then null
          else 'repeat_unlocked'
        end,
        case
          when selected_practice_test_id is null then 'idle'
          else 'ready'
        end,
        selected_cycle.id,
        selected_cycle.cycle_number,
        selected_cycle.evidence_through_sequence
      )
      returning id into new_assignment_id;
    exception
      when unique_violation then
        select assignment.id
        into new_assignment_id
        from public.student_practice_assignments assignment
        where assignment.workspace_id = selected_cycle.workspace_id
          and assignment.student_id = selected_cycle.student_id
          and assignment.grammar_topic_id = selected_cycle.grammar_topic_id
          and assignment.status in ('unlocked', 'in_progress', 'completed')
        order by
          assignment.resolution_cycle_number desc nulls last,
          assignment.repeat_number desc,
          assignment.assigned_at desc,
          assignment.id desc
        limit 1;
    end;

    if new_assignment_id is null then
      raise exception using
        errcode = '55000',
        message = 'Practice cycle could not establish an active assignment.';
    end if;

    select assignment.*
    into selected_assignment
    from public.student_practice_assignments assignment
    where assignment.id = new_assignment_id;

    if selected_assignment.resolution_cycle_id is null then
      update public.student_practice_assignments assignment
      set
        resolution_cycle_id = selected_cycle.id,
        resolution_cycle_number = selected_cycle.cycle_number,
        evidence_cutoff_sequence = selected_cycle.evidence_through_sequence
      where assignment.id = selected_assignment.id
      returning assignment.* into selected_assignment;
    end if;

    perform app_private.record_practice_cycle_event(
      selected_cycle.id,
      'assignment_created',
      selected_cycle.state,
      'unlocked',
      selected_assignment.id,
      null,
      jsonb_build_object('source', selected_assignment.source)
    );
  end if;

  new_state := case selected_assignment.status
    when 'in_progress' then 'in_progress'
    when 'completed' then 'in_progress'
    else 'unlocked'
  end;

  update app_private.practice_resolution_cycles cycle
  set
    active_assignment_id = selected_assignment.id,
    evidence_frozen_at = coalesce(cycle.evidence_frozen_at, now()),
    state = new_state,
    state_reason = case new_state
      when 'in_progress' then 'worksheet_in_progress'
      else 'worksheet_ready'
    end
  where cycle.id = selected_cycle.id;

  return selected_assignment.id;
end;
$$;

revoke all on function app_private.ensure_practice_cycle_assignment_internal(uuid)
from public, anon, authenticated, service_role;
