-- Keep terminal assignment transitions authoritative until the durable outbox
-- processor has applied them to the owning resolution cycle.
--
-- A later writing release can arrive after an assignment commits passed,
-- failed or cancelled but before the transition worker runs. Reconciliation
-- must not interpret that terminal row as a missing assignment and create a
-- replacement inside the still-unresolved old cycle. The worker owns that
-- decision: a pass resolves the cycle before opening any recurrence, while a
-- failure/cancellation clears the active row before selecting one replacement.

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
  selected_active_assignment public.student_practice_assignments%rowtype;
  selected_assignment_id uuid;
  selected_assignment_status text;
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

  if selected_cycle.class_context_version = 1
    and not app_private.lock_active_practice_class_context(
      selected_cycle.workspace_id,
      selected_cycle.student_id,
      selected_cycle.batch_id,
      selected_cycle.worksheet_level
    )
  then
    update app_private.practice_resolution_cycles cycle
    set
      state = 'locked',
      state_reason = 'active_class_context_required',
      active_assignment_id = null
    where cycle.id = selected_cycle.id;
    return null;
  end if;

  -- Preserve the canonical topic-advisory -> cycle -> class-context ->
  -- assignment lock order. status_revision > 0 is the transactionally coupled
  -- proof that this terminal status passed through the durable outbox trigger.
  -- Do not lock/read the job row here: an evidence statement whose snapshot was
  -- taken before the assignment transaction committed may see the new terminal
  -- row through row-lock recheck without seeing that transaction's new outbox
  -- row. A successfully processed transition changes the cycle atomically
  -- before it invokes reconciliation, so a terminal active row at a positive
  -- revision is necessarily still authoritative and must be deferred.
  if selected_cycle.active_assignment_id is not null then
    select assignment.*
    into selected_active_assignment
    from public.student_practice_assignments assignment
    where assignment.id = selected_cycle.active_assignment_id
      and assignment.resolution_cycle_id = selected_cycle.id
      and assignment.workspace_id = selected_cycle.workspace_id
      and assignment.student_id = selected_cycle.student_id
      and assignment.grammar_topic_id = selected_cycle.grammar_topic_id
    for update;

    if selected_active_assignment.id is not null
      and selected_active_assignment.status in ('passed', 'failed', 'cancelled')
      and selected_active_assignment.status_revision > 0
    then
      return selected_active_assignment.id;
    end if;
  end if;

  selected_assignment_id :=
    app_private.ensure_practice_cycle_assignment_core_internal(
      selected_cycle.id
    );

  if selected_assignment_id is not null then
    select assignment.status
    into selected_assignment_status
    from public.student_practice_assignments assignment
    where assignment.id = selected_assignment_id;

    if selected_assignment_status = 'completed' then
      update app_private.practice_resolution_cycles cycle
      set
        state = 'in_progress',
        state_reason = 'feedback_evaluation_pending'
      where cycle.id = selected_cycle.id
        and cycle.resolved_at is null;
    end if;
  end if;

  return selected_assignment_id;
end;
$$;

revoke all on function app_private.ensure_practice_cycle_assignment_internal(uuid)
from public, anon, authenticated, service_role;

comment on function app_private.ensure_practice_cycle_assignment_internal(uuid) is
  'Private cycle selector. Defers replacement while a terminal active assignment revision is still owned by the durable transition outbox.';

-- Teacher reassignment is another replacement entry point. It must use the
-- same topic-advisory -> cycle -> class-context -> assignment order as the
-- transition worker, and it must not race the worker for ownership of a
-- terminal revision.
create or replace function public.reassign_practice_assignment_internal(
  target_assignment_id uuid,
  reassignment_reason text,
  expected_action_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  assignment_snapshot public.student_practice_assignments%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  current_topic_cycle app_private.practice_resolution_cycles%rowtype;
  current_topic_assignment public.student_practice_assignments%rowtype;
  current_revision integer := 0;
  next_revision integer;
  clean_reason text := btrim(reassignment_reason);
  replacement_assignment_id uuid;
  selected_test_id uuid;
  next_repeat_number integer;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_assignment_id is null
    or clean_reason is null
    or length(clean_reason) not between 8 and 1000
    or expected_action_revision is null
    or expected_action_revision < 0
  then
    raise exception using errcode = '22023', message = 'invalid_reassignment';
  end if;

  -- Resolve immutable lock keys without taking the assignment row first.
  select assignment.*
  into assignment_snapshot
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if assignment_snapshot.id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      assignment_snapshot.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  -- Class-context resolution is valid only while an assignment is unlocked and
  -- currently takes its assignment lock before updating the legacy cycle.
  -- Reject that disjoint state before taking this function's topic/cycle locks,
  -- so a stale or malicious reassignment request cannot form a lock inversion
  -- with concurrent v0 -> v1 context promotion.
  if assignment_snapshot.status not in ('passed', 'failed', 'cancelled') then
    raise exception using errcode = '55000', message = 'assignment_not_terminal';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(
        ':',
        assignment_snapshot.workspace_id,
        assignment_snapshot.student_id,
        assignment_snapshot.grammar_topic_id
      ),
      0
    )
  );

  -- Historical reassignment may target an older terminal row while a different
  -- untouched assignment is the current cycle owner. Version-zero class
  -- recovery intentionally locks that current assignment before updating its
  -- cycle. Do not take the inverse cycle -> assignment order here. This
  -- snapshot-only probe runs after the topic advisory but before any cycle row
  -- lock; a concurrent recovery either still appears as version zero and this
  -- command fails safely, or has committed the complete version-one pair and a
  -- retry can continue through the canonical lock chain.
  if exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    join public.student_practice_assignments current_assignment
      on current_assignment.id = cycle.active_assignment_id
     and current_assignment.resolution_cycle_id = cycle.id
     and current_assignment.workspace_id = cycle.workspace_id
     and current_assignment.student_id = cycle.student_id
     and current_assignment.grammar_topic_id = cycle.grammar_topic_id
    where cycle.workspace_id = assignment_snapshot.workspace_id
      and cycle.student_id = assignment_snapshot.student_id
      and cycle.grammar_topic_id = assignment_snapshot.grammar_topic_id
      and cycle.resolved_at is null
      and cycle.active_assignment_id is distinct from assignment_snapshot.id
      and (
        cycle.class_context_version = 0
        or current_assignment.class_context_version = 0
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'practice_class_context_resolution_pending';
  end if;

  -- A teacher may reassign any historical terminal assignment, not only the
  -- terminal row that currently owns the unresolved cycle. Lock the current
  -- topic cycle before either class context or assignment row so an older
  -- target cannot bypass a different active terminal revision whose outbox
  -- transition has not settled yet.
  select cycle.*
  into current_topic_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.workspace_id = assignment_snapshot.workspace_id
    and cycle.student_id = assignment_snapshot.student_id
    and cycle.grammar_topic_id = assignment_snapshot.grammar_topic_id
    and cycle.resolved_at is null
  order by cycle.cycle_number desc, cycle.id desc
  limit 1
  for update;

  if assignment_snapshot.resolution_cycle_id is not null then
    if current_topic_cycle.id = assignment_snapshot.resolution_cycle_id then
      selected_cycle := current_topic_cycle;
    else
      select cycle.*
      into selected_cycle
      from app_private.practice_resolution_cycles cycle
      where cycle.id = assignment_snapshot.resolution_cycle_id
        and cycle.workspace_id = assignment_snapshot.workspace_id
        and cycle.student_id = assignment_snapshot.student_id
        and cycle.grammar_topic_id = assignment_snapshot.grammar_topic_id
      for update;
    end if;

    if selected_cycle.id is null then
      raise exception using errcode = '55000', message = 'practice_cycle_context_invalid';
    end if;
  end if;

  if current_topic_cycle.id is not null
    and current_topic_cycle.class_context_version = 1
    and not app_private.lock_active_practice_class_context(
      current_topic_cycle.workspace_id,
      current_topic_cycle.student_id,
      current_topic_cycle.batch_id,
      current_topic_cycle.worksheet_level
    )
  then
    raise exception using errcode = '42501', message = 'active_membership_required';
  end if;

  if selected_cycle.id is not null
    and selected_cycle.id is distinct from current_topic_cycle.id
    and selected_cycle.class_context_version = 1
    and not app_private.lock_active_practice_class_context(
      selected_cycle.workspace_id,
      selected_cycle.student_id,
      selected_cycle.batch_id,
      selected_cycle.worksheet_level
    )
  then
    raise exception using errcode = '42501', message = 'active_membership_required';
  elsif selected_cycle.id is null
    and assignment_snapshot.class_context_version = 1
    and not app_private.lock_active_practice_class_context(
      assignment_snapshot.workspace_id,
      assignment_snapshot.student_id,
      assignment_snapshot.batch_id,
      assignment_snapshot.worksheet_level
    )
  then
    raise exception using errcode = '42501', message = 'active_membership_required';
  end if;

  if current_topic_cycle.active_assignment_id is not null then
    select assignment.*
    into current_topic_assignment
    from public.student_practice_assignments assignment
    where assignment.id = current_topic_cycle.active_assignment_id
    for update;

    if current_topic_assignment.id is null
      or current_topic_assignment.resolution_cycle_id is distinct from
        current_topic_cycle.id
      or current_topic_assignment.workspace_id is distinct from
        current_topic_cycle.workspace_id
      or current_topic_assignment.student_id is distinct from
        current_topic_cycle.student_id
      or current_topic_assignment.grammar_topic_id is distinct from
        current_topic_cycle.grammar_topic_id
    then
      raise exception using
        errcode = '40001',
        message = 'practice_current_cycle_context_changed';
    end if;

    if current_topic_assignment.status in ('passed', 'failed', 'cancelled')
      and current_topic_assignment.status_revision > 0
    then
      raise exception using errcode = '55000', message = 'practice_transition_pending';
    end if;
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if selected_assignment.id is null
    or selected_assignment.workspace_id is distinct from assignment_snapshot.workspace_id
    or selected_assignment.student_id is distinct from assignment_snapshot.student_id
    or selected_assignment.grammar_topic_id is distinct from
      assignment_snapshot.grammar_topic_id
    or selected_assignment.resolution_cycle_id is distinct from
      assignment_snapshot.resolution_cycle_id
    or selected_assignment.batch_id is distinct from assignment_snapshot.batch_id
    or selected_assignment.worksheet_level is distinct from
      assignment_snapshot.worksheet_level
    or selected_assignment.class_context_version is distinct from
      assignment_snapshot.class_context_version
    or selected_assignment.class_context_integrity is distinct from
      assignment_snapshot.class_context_integrity
  then
    raise exception using errcode = '40001', message = 'practice_assignment_context_changed';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      selected_assignment.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;
  if selected_assignment.status not in ('passed', 'failed', 'cancelled') then
    raise exception using errcode = '55000', message = 'assignment_not_terminal';
  end if;
  if not exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = selected_assignment.workspace_id
      and membership.user_id = selected_assignment.student_id
      and membership.role = 'student'
  ) then
    raise exception using errcode = '42501', message = 'active_membership_required';
  end if;

  -- The positive revision is transactionally coupled to an outbox append. Do
  -- not read or lock the job row here: a concurrent statement can observe the
  -- terminal assignment through row-lock recheck while its older command
  -- snapshot cannot yet see the newly committed job. A successful worker tick
  -- atomically resolves/clears active_assignment_id before teacher reassignment
  -- can obtain the same topic advisory lock.
  if selected_cycle.id is not null
    and selected_cycle.resolved_at is null
    and selected_cycle.active_assignment_id = selected_assignment.id
    and selected_assignment.status_revision > 0
  then
    raise exception using errcode = '55000', message = 'practice_transition_pending';
  end if;

  select coalesce(max(action.action_revision), 0)
  into current_revision
  from app_private.practice_teacher_actions action
  where action.assignment_id = selected_assignment.id;

  if current_revision <> expected_action_revision then
    raise exception using errcode = '40001', message = 'teacher_action_revision_conflict';
  end if;

  select assignment.id
  into replacement_assignment_id
  from public.student_practice_assignments assignment
  where assignment.workspace_id = selected_assignment.workspace_id
    and assignment.student_id = selected_assignment.student_id
    and assignment.grammar_topic_id = selected_assignment.grammar_topic_id
    and assignment.id <> selected_assignment.id
    and assignment.status in ('unlocked', 'in_progress', 'completed')
  order by assignment.assigned_at desc, assignment.id desc
  limit 1
  for update;

  if replacement_assignment_id is null then
    perform app_private.reconcile_practice_topic_internal(
      selected_assignment.workspace_id,
      selected_assignment.student_id,
      selected_assignment.grammar_topic_id
    );

    select assignment.id
    into replacement_assignment_id
    from public.student_practice_assignments assignment
    where assignment.workspace_id = selected_assignment.workspace_id
      and assignment.student_id = selected_assignment.student_id
      and assignment.grammar_topic_id = selected_assignment.grammar_topic_id
      and assignment.id <> selected_assignment.id
      and assignment.status in ('unlocked', 'in_progress', 'completed')
    order by assignment.assigned_at desc, assignment.id desc
    limit 1
    for update;
  end if;

  if replacement_assignment_id is null then
    selected_test_id := app_private.select_practice_test_for_cycle(
      selected_assignment.workspace_id,
      selected_assignment.student_id,
      selected_assignment.grammar_topic_id
    );

    select coalesce(max(assignment.repeat_number), -1) + 1
    into next_repeat_number
    from public.student_practice_assignments assignment
    where assignment.workspace_id = selected_assignment.workspace_id
      and assignment.student_id = selected_assignment.student_id
      and assignment.grammar_topic_id = selected_assignment.grammar_topic_id;

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
      batch_id,
      worksheet_level,
      class_context_version,
      class_context_integrity
    ) values (
      selected_assignment.workspace_id,
      selected_assignment.student_id,
      selected_assignment.grammar_topic_id,
      selected_test_id,
      'teacher_assigned',
      'unlocked',
      caller_id,
      selected_assignment.id,
      selected_assignment.latest_attempt_id,
      greatest(next_repeat_number, 0),
      'teacher_reassignment',
      'repeat_unlocked',
      case when selected_test_id is null then 'idle' else 'ready' end,
      case when selected_assignment.class_context_version = 1
        then selected_assignment.batch_id else null end,
      case when selected_assignment.class_context_version = 1
        then selected_assignment.worksheet_level else null end,
      selected_assignment.class_context_version,
      case when selected_assignment.class_context_version = 1
        then 'teacher_verified' else 'legacy_unverified' end
    )
    returning id into replacement_assignment_id;
  end if;

  next_revision := current_revision + 1;
  insert into app_private.practice_teacher_actions (
    assignment_id,
    workspace_id,
    student_id,
    grammar_topic_id,
    actor_id,
    action_revision,
    action_type,
    reason,
    before_state,
    after_state,
    related_assignment_id
  ) values (
    selected_assignment.id,
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id,
    caller_id,
    next_revision,
    'assignment_reassigned',
    clean_reason,
    jsonb_build_object(
      'assignment_status', selected_assignment.status,
      'latest_attempt_id', selected_assignment.latest_attempt_id
    ),
    jsonb_build_object(
      'replacement_assignment_id', replacement_assignment_id
    ),
    replacement_assignment_id
  );

  return jsonb_build_object(
    'schema_version', 1,
    'assignment_id', selected_assignment.id,
    'action_revision', next_revision,
    'replacement_assignment_id', replacement_assignment_id
  );
end;
$$;

revoke all on function public.reassign_practice_assignment_internal(
  uuid, text, integer
)
from public, anon, authenticated, service_role;
grant execute on function public.reassign_practice_assignment_internal(
  uuid, text, integer
)
to authenticated;

comment on function public.reassign_practice_assignment_internal(
  uuid, text, integer
) is
  'Teacher reassignment serialized behind the adaptive topic transition worker; pending terminal revisions must settle before a replacement can be selected.';
