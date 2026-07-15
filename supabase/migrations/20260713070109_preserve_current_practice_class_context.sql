-- Keep adaptive practice bound to the learner's current, explicit class
-- context without rewriting immutable writing or worksheet history.
--
-- Two independent drifts are closed here:
-- 1. A batch remains the same row when a teacher edits its CEFR level. An
--    untouched A2 preparation must not remain usable after that batch becomes
--    B1 merely because membership and is_active still match.
-- 2. Before a weakness cycle owns an assignment, later evidence may move the
--    threshold-crossing context to another class. The cycle must follow the
--    newest tamper-valid evidence sequence instead of retaining the first
--    below-threshold class snapshot.

create or replace function app_private.practice_class_context_is_active(
  target_workspace_id uuid,
  target_student_id uuid,
  target_batch_id uuid,
  target_worksheet_level text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.workspace_members workspace_membership
    join public.batches batch
      on batch.id = target_batch_id
     and batch.workspace_id = target_workspace_id
     and batch.is_active
     and batch.level = target_worksheet_level
    join public.batch_students class_membership
      on class_membership.workspace_id = target_workspace_id
     and class_membership.batch_id = target_batch_id
     and class_membership.student_id = target_student_id
    where workspace_membership.workspace_id = target_workspace_id
      and workspace_membership.user_id = target_student_id
      and workspace_membership.role = 'student'
      and target_worksheet_level in ('A1', 'A2', 'B1', 'B2')
  ), false);
$$;

revoke all on function app_private.practice_class_context_is_active(
  uuid, uuid, uuid, text
)
from public, anon, authenticated, service_role;

create or replace function app_private.lock_active_practice_class_context(
  target_workspace_id uuid,
  target_student_id uuid,
  target_batch_id uuid,
  target_worksheet_level text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  selected_role text;
  selected_class_assignment_id uuid;
  selected_batch_active boolean;
  selected_batch_level text;
begin
  if target_workspace_id is null
    or target_student_id is null
    or target_batch_id is null
    or target_worksheet_level not in ('A1', 'A2', 'B1', 'B2')
  then
    return false;
  end if;

  -- Preserve the canonical topic advisory -> cycle -> workspace membership ->
  -- batch -> class membership lock order used by reconciliation and recovery.
  select membership.role
  into selected_role
  from public.workspace_members membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = target_student_id
  for share;

  if selected_role is distinct from 'student' then
    return false;
  end if;

  select batch.is_active, batch.level
  into selected_batch_active, selected_batch_level
  from public.batches batch
  where batch.id = target_batch_id
    and batch.workspace_id = target_workspace_id
  for share;

  if not coalesce(selected_batch_active, false)
    or selected_batch_level is distinct from target_worksheet_level
  then
    return false;
  end if;

  select assignment.id
  into selected_class_assignment_id
  from public.batch_students assignment
  where assignment.workspace_id = target_workspace_id
    and assignment.batch_id = target_batch_id
    and assignment.student_id = target_student_id
  for share;

  return selected_class_assignment_id is not null;
end;
$$;

revoke all on function app_private.lock_active_practice_class_context(
  uuid, uuid, uuid, text
)
from public, anon, authenticated, service_role;

-- The original invariant remains immutable once evidence is frozen or an
-- assignment exists. The only added transition is an exact, database-verified
-- refresh while the open cycle is still unfrozen and assignment-free.
create or replace function app_private.guard_practice_resolution_cycle_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  valid_locked_pass_resolution boolean := false;
  class_context_changed boolean := false;
  valid_unfrozen_context_refresh boolean := false;
  valid_teacher_context_recovery boolean := false;
  expected_resolved_cutoff bigint := 0;
  expected_evidence_start bigint;
  expected_evidence_through bigint;
  expected_minor_issue_count integer := 0;
  expected_major_issue_count integer := 0;
  expected_batch_id uuid;
  expected_worksheet_level text;
  expected_context_integrity text;
begin
  if old.workspace_id <> new.workspace_id
    or old.student_id <> new.student_id
    or old.grammar_topic_id <> new.grammar_topic_id
    or old.cycle_number <> new.cycle_number
    or old.evidence_start_sequence <> new.evidence_start_sequence
  then
    raise exception using errcode = '55000', message = 'Practice cycle identity is immutable.';
  end if;

  class_context_changed := old.class_context_version = 1 and (
    new.class_context_version <> old.class_context_version
    or new.class_context_integrity is distinct from old.class_context_integrity
    or new.batch_id is distinct from old.batch_id
    or new.worksheet_level is distinct from old.worksheet_level
  );

  if class_context_changed then
    select coalesce(max(cycle.resolved_through_sequence), 0)
    into expected_resolved_cutoff
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = old.workspace_id
      and cycle.student_id = old.student_id
      and cycle.grammar_topic_id = old.grammar_topic_id
      and cycle.resolved_at is not null;

    select
      min(evidence.evidence_sequence),
      max(evidence.evidence_sequence),
      coalesce(sum(evidence.minor_issue_count), 0)::integer,
      coalesce(sum(evidence.major_issue_count), 0)::integer
    into
      expected_evidence_start,
      expected_evidence_through,
      expected_minor_issue_count,
      expected_major_issue_count
    from app_private.practice_weakness_evidence evidence
    where evidence.workspace_id = old.workspace_id
      and evidence.student_id = old.student_id
      and evidence.grammar_topic_id = old.grammar_topic_id
      and evidence.evidence_sequence > expected_resolved_cutoff;

    select
      evidence.batch_id,
      evidence.evidence_level,
      evidence.class_context_integrity
    into
      expected_batch_id,
      expected_worksheet_level,
      expected_context_integrity
    from app_private.practice_weakness_evidence evidence
    where evidence.workspace_id = old.workspace_id
      and evidence.student_id = old.student_id
      and evidence.grammar_topic_id = old.grammar_topic_id
      and evidence.evidence_sequence > expected_resolved_cutoff
      and evidence.batch_id is not null
      and evidence.evidence_level in ('A1', 'A2', 'B1', 'B2')
      and evidence.class_context_integrity in (
        'writing_snapshot', 'teacher_verified'
      )
      and (
        (
          evidence.source_kind = 'feedback_draft'
          and evidence.writing_context_version = 1
          and evidence.writing_context_sha256 ~ '^[0-9a-f]{64}$'
        )
        or evidence.source_kind = 'teacher_score_override'
      )
    order by evidence.evidence_sequence desc
    limit 1;

    valid_unfrozen_context_refresh :=
      expected_batch_id is not null
      and expected_worksheet_level is not null
      and expected_context_integrity is not null
      and old.resolved_at is null
      and new.resolved_at is null
      and old.evidence_frozen_at is null
      and new.evidence_frozen_at is null
      and old.active_assignment_id is null
      and new.active_assignment_id is null
      and new.class_context_version = 1
      and new.class_context_integrity = expected_context_integrity
      and new.batch_id = expected_batch_id
      and new.worksheet_level = expected_worksheet_level
      and new.evidence_start_sequence = expected_evidence_start
      and new.evidence_through_sequence = expected_evidence_through
      and new.evidence_through_sequence > old.evidence_through_sequence
      and new.minor_issue_count = expected_minor_issue_count
      and new.major_issue_count = expected_major_issue_count
      and new.state = case
        when expected_major_issue_count >= 1
          or expected_minor_issue_count >= 3
        then 'unlocked'
        else 'locked'
      end
      and new.state_reason = case
        when expected_major_issue_count >= 1
          or expected_minor_issue_count >= 3
        then 'weakness_threshold_reached'
        else 'below_unlock_threshold'
      end
      and exists (
        select 1
        from public.batches batch
        where batch.id = expected_batch_id
          and batch.workspace_id = old.workspace_id
      );

    if valid_unfrozen_context_refresh is not true then
      raise exception using
        errcode = '55000',
        message = 'Practice cycle class context is immutable.';
    end if;
  end if;

  if old.class_context_version = 0 and new.class_context_version = 1 then
    valid_teacher_context_recovery :=
      coalesce(
        nullif(
          current_setting(
            'app.practice_teacher_context_recovery_cycle',
            true
          ),
          ''
        ) = old.id::text,
        false
      )
      and new.active_assignment_id is not distinct from old.active_assignment_id
      and new.class_context_integrity = 'teacher_verified'
      and new.state_reason = 'teacher_class_context_resolved';

    -- An automatic reconciler may never promote only the cycle half of a
    -- legacy cycle/assignment pair. The authenticated teacher-recovery RPC is
    -- the sole atomic path that promotes both rows in one transaction.
    if (
      old.active_assignment_id is not null
      or new.active_assignment_id is not null
    ) and not valid_teacher_context_recovery then
      raise exception using
        errcode = '55000',
        message = 'Practice cycle class context requires atomic teacher recovery.';
    end if;

    if new.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
      or new.batch_id is null
      or new.worksheet_level is null
      or new.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
    then
      raise exception using errcode = '22023', message = 'Practice cycle class context is invalid.';
    end if;
  elsif new.class_context_version <> old.class_context_version then
    raise exception using errcode = '55000', message = 'Practice cycle class context transition is invalid.';
  end if;

  if old.resolved_at is not null and new is distinct from old then
    raise exception using errcode = '55000', message = 'Resolved practice cycles are immutable.';
  end if;

  if new.evidence_through_sequence < old.evidence_through_sequence then
    raise exception using errcode = '55000', message = 'Practice evidence cutoff cannot move backwards.';
  end if;

  if old.evidence_frozen_at is not null and (
    new.evidence_through_sequence <> old.evidence_through_sequence
    or new.minor_issue_count <> old.minor_issue_count
    or new.major_issue_count <> old.major_issue_count
  ) then
    raise exception using errcode = '55000', message = 'Frozen practice evidence cannot change.';
  end if;

  valid_locked_pass_resolution :=
    old.state = 'locked'
    and new.state in ('improving', 'mastered')
    and new.resolved_at is not null
    and new.resolution_outcome = 'passed'
    and new.resolution_assignment_id is not null
    and new.resolution_attempt_id is not null
    and new.resolved_through_sequence is not null
    and new.resolved_through_sequence = new.evidence_through_sequence
    and new.active_assignment_id is null
    and new.evidence_frozen_at is not null
    and new.mastery_pass_number = old.mastery_pass_number + 1
    and new.state = case
      when new.mastery_pass_number >= 2 then 'mastered'
      else 'improving'
    end
    and new.state_reason = case
      when new.mastery_pass_number >= 2 then 'repeated_resolution_passed'
      else 'first_resolution_passed'
    end;

  if old.state = 'locked'
    and new.state not in ('locked', 'unlocked')
    and not valid_locked_pass_resolution
  then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  elsif old.state = 'unlocked'
    and new.state not in ('locked', 'unlocked', 'in_progress', 'improving', 'mastered')
  then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  elsif old.state = 'in_progress'
    and new.state not in ('locked', 'in_progress', 'unlocked', 'improving', 'mastered')
  then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function app_private.guard_practice_resolution_cycle_update()
from public, anon, authenticated, service_role;

create or replace function app_private.reconcile_practice_topic_internal(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_cycle app_private.practice_resolution_cycles%rowtype;
  current_assignment public.student_practice_assignments%rowtype;
  unresolved_start bigint;
  unresolved_through bigint;
  unresolved_minor integer := 0;
  unresolved_major integer := 0;
  resolved_cutoff bigint := 0;
  prior_mastery_passes integer := 0;
  next_cycle_number integer := 1;
  next_state text;
  next_reason text;
  latest_batch_id uuid;
  latest_worksheet_level text;
  latest_context_integrity text;
  previous_batch_id uuid;
  previous_worksheet_level text;
  previous_context_integrity text;
begin
  if target_workspace_id is null
    or target_student_id is null
    or target_grammar_topic_id is null
  then
    raise exception using errcode = '22023', message = 'Practice topic context is required.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(':', target_workspace_id, target_student_id, target_grammar_topic_id),
      0
    )
  );

  select
    coalesce(max(cycle.resolved_through_sequence), 0),
    coalesce(max(cycle.mastery_pass_number), 0),
    coalesce(max(cycle.cycle_number), 0) + 1
  into resolved_cutoff, prior_mastery_passes, next_cycle_number
  from app_private.practice_resolution_cycles cycle
  where cycle.workspace_id = target_workspace_id
    and cycle.student_id = target_student_id
    and cycle.grammar_topic_id = target_grammar_topic_id;

  select
    min(evidence.evidence_sequence),
    max(evidence.evidence_sequence),
    coalesce(sum(evidence.minor_issue_count), 0)::integer,
    coalesce(sum(evidence.major_issue_count), 0)::integer
  into unresolved_start, unresolved_through, unresolved_minor, unresolved_major
  from app_private.practice_weakness_evidence evidence
  where evidence.workspace_id = target_workspace_id
    and evidence.student_id = target_student_id
    and evidence.grammar_topic_id = target_grammar_topic_id
    and evidence.evidence_sequence > resolved_cutoff;

  -- Evidence sequences are immutable and globally unique. The newest
  -- tamper-valid item therefore supplies a deterministic current context for
  -- the still-unfrozen weakness epoch.
  select
    evidence.batch_id,
    evidence.evidence_level,
    evidence.class_context_integrity
  into
    latest_batch_id,
    latest_worksheet_level,
    latest_context_integrity
  from app_private.practice_weakness_evidence evidence
  where evidence.workspace_id = target_workspace_id
    and evidence.student_id = target_student_id
    and evidence.grammar_topic_id = target_grammar_topic_id
    and evidence.evidence_sequence > resolved_cutoff
    and evidence.batch_id is not null
    and evidence.evidence_level in ('A1', 'A2', 'B1', 'B2')
    and evidence.class_context_integrity in (
      'writing_snapshot', 'teacher_verified'
    )
    and (
      (
        evidence.source_kind = 'feedback_draft'
        and evidence.writing_context_version = 1
        and evidence.writing_context_sha256 ~ '^[0-9a-f]{64}$'
      )
      or evidence.source_kind = 'teacher_score_override'
    )
  order by evidence.evidence_sequence desc
  limit 1;

  select cycle.*
  into current_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.workspace_id = target_workspace_id
    and cycle.student_id = target_student_id
    and cycle.grammar_topic_id = target_grammar_topic_id
    and cycle.resolved_at is null
  order by cycle.cycle_number desc
  limit 1
  for update;

  if current_cycle.id is null and unresolved_through is not null then
    next_state := case
      when unresolved_major >= 1 or unresolved_minor >= 3 then 'unlocked'
      else 'locked'
    end;
    next_reason := case next_state
      when 'unlocked' then 'weakness_threshold_reached'
      else 'below_unlock_threshold'
    end;

    insert into app_private.practice_resolution_cycles (
      workspace_id,
      student_id,
      grammar_topic_id,
      cycle_number,
      state,
      state_reason,
      evidence_start_sequence,
      evidence_through_sequence,
      minor_issue_count,
      major_issue_count,
      mastery_pass_number
    ) values (
      target_workspace_id,
      target_student_id,
      target_grammar_topic_id,
      next_cycle_number,
      next_state,
      next_reason,
      unresolved_start,
      unresolved_through,
      unresolved_minor,
      unresolved_major,
      prior_mastery_passes
    )
    returning * into current_cycle;

    perform app_private.record_practice_cycle_event(
      current_cycle.id,
      'cycle_opened',
      null,
      current_cycle.state,
      null,
      null,
      jsonb_build_object(
        'cycle_number', current_cycle.cycle_number,
        'batch_id', current_cycle.batch_id,
        'worksheet_level', current_cycle.worksheet_level
      )
    );
  elsif current_cycle.id is not null
    and current_cycle.evidence_frozen_at is null
    and not (
      current_cycle.class_context_version = 0
      and current_cycle.active_assignment_id is not null
    )
  then
    next_state := case
      when unresolved_major >= 1 or unresolved_minor >= 3 then 'unlocked'
      else 'locked'
    end;
    next_reason := case next_state
      when 'unlocked' then 'weakness_threshold_reached'
      else 'below_unlock_threshold'
    end;

    if current_cycle.evidence_through_sequence is distinct from unresolved_through
      or current_cycle.minor_issue_count is distinct from unresolved_minor
      or current_cycle.major_issue_count is distinct from unresolved_major
      or current_cycle.state is distinct from next_state
      or current_cycle.state_reason is distinct from next_reason
      or (
        latest_batch_id is not null
        and (
          current_cycle.class_context_version <> 1
          or current_cycle.batch_id is distinct from latest_batch_id
          or current_cycle.worksheet_level is distinct from latest_worksheet_level
          or current_cycle.class_context_integrity is distinct from
            latest_context_integrity
        )
      )
    then
      previous_batch_id := current_cycle.batch_id;
      previous_worksheet_level := current_cycle.worksheet_level;
      previous_context_integrity := current_cycle.class_context_integrity;

      update app_private.practice_resolution_cycles cycle
      set
        evidence_start_sequence = coalesce(unresolved_start, cycle.evidence_start_sequence),
        evidence_through_sequence = coalesce(unresolved_through, cycle.evidence_through_sequence),
        minor_issue_count = unresolved_minor,
        major_issue_count = unresolved_major,
        batch_id = case
          when latest_batch_id is not null then latest_batch_id
          else cycle.batch_id
        end,
        worksheet_level = case
          when latest_batch_id is not null then latest_worksheet_level
          else cycle.worksheet_level
        end,
        class_context_version = case
          when latest_batch_id is not null then 1
          else cycle.class_context_version
        end,
        class_context_integrity = case
          when latest_batch_id is not null then latest_context_integrity
          else cycle.class_context_integrity
        end,
        state = next_state,
        state_reason = next_reason
      where cycle.id = current_cycle.id
      returning * into current_cycle;

      perform app_private.record_practice_cycle_event(
        current_cycle.id,
        'evidence_refreshed',
        null,
        current_cycle.state,
        null,
        null,
        jsonb_build_object(
          'minor_issue_count', current_cycle.minor_issue_count,
          'major_issue_count', current_cycle.major_issue_count,
          'previous_batch_id', previous_batch_id,
          'previous_worksheet_level', previous_worksheet_level,
          'previous_class_context_integrity', previous_context_integrity,
          'batch_id', current_cycle.batch_id,
          'worksheet_level', current_cycle.worksheet_level,
          'class_context_integrity', current_cycle.class_context_integrity,
          'class_context_refreshed',
            previous_batch_id is distinct from current_cycle.batch_id
            or previous_worksheet_level is distinct from
              current_cycle.worksheet_level
            or previous_context_integrity is distinct from
              current_cycle.class_context_integrity
        )
      );
    end if;
  end if;

  if current_cycle.id is not null then
    select assignment.*
    into current_assignment
    from public.student_practice_assignments assignment
    where assignment.id = current_cycle.active_assignment_id;

    if current_assignment.id is not null
      and current_assignment.status in ('in_progress', 'completed')
      and current_cycle.state <> 'in_progress'
    then
      update app_private.practice_resolution_cycles cycle
      set state = 'in_progress', state_reason = 'worksheet_in_progress'
      where cycle.id = current_cycle.id
      returning * into current_cycle;
    elsif current_assignment.id is not null
      and current_assignment.status = 'unlocked'
      and current_cycle.state <> 'unlocked'
    then
      update app_private.practice_resolution_cycles cycle
      set state = 'unlocked', state_reason = 'worksheet_ready'
      where cycle.id = current_cycle.id
      returning * into current_cycle;
    end if;

    if current_cycle.state in ('unlocked', 'in_progress')
      and not (
        current_cycle.class_context_version = 0
        and current_cycle.active_assignment_id is not null
      )
    then
      perform app_private.ensure_practice_cycle_assignment_internal(current_cycle.id);
    end if;
  end if;

  perform app_private.sync_practice_topic_stats_internal(
    target_workspace_id,
    target_student_id,
    target_grammar_topic_id
  );

  return current_cycle.id;
end;
$$;

revoke all on function app_private.reconcile_practice_topic_internal(
  uuid, uuid, uuid
)
from public, anon, authenticated, service_role;

-- The historical teacher-recovery RPC already promotes the cycle and its
-- untouched assignment in one transaction. Scope the trigger exception to the
-- exact cycle UUID for only the cycle-update statement; a different private
-- caller, a different cycle, or a partial promotion remains rejected.
do $patch_teacher_context_recovery_scope$
declare
  function_definition text;
  update_anchor text := $old$
    if selected_assignment.resolution_cycle_id is not null then
      update app_private.practice_resolution_cycles cycle
$old$;
  update_replacement text := $new$
    if selected_assignment.resolution_cycle_id is not null then
      perform set_config(
        'app.practice_teacher_context_recovery_cycle',
        selected_assignment.resolution_cycle_id::text,
        true
      );

      update app_private.practice_resolution_cycles cycle
$new$;
  freeze_anchor text := $old$
        class_context_version = 1,
        class_context_integrity = 'teacher_verified',
        state_reason = 'teacher_class_context_resolved'
$old$;
  freeze_replacement text := $new$
        class_context_version = 1,
        class_context_integrity = 'teacher_verified',
        evidence_frozen_at = coalesce(
          cycle.evidence_frozen_at,
          selected_assignment.assigned_at,
          now()
        ),
        state_reason = 'teacher_class_context_resolved'
$new$;
  reset_anchor text := $old$
      if not found then
        raise exception using errcode = '55000', message = 'practice_cycle_context_unavailable';
      end if;
    end if;
$old$;
  reset_replacement text := $new$
      if not found then
        raise exception using errcode = '55000', message = 'practice_cycle_context_unavailable';
      end if;

      perform set_config(
        'app.practice_teacher_context_recovery_cycle',
        '',
        true
      );
    end if;
$new$;
begin
  select pg_get_functiondef(
    'public.resolve_practice_assignment_class_context_internal(uuid,uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(update_anchor in function_definition) = 0
    or position(freeze_anchor in function_definition) = 0
    or position(reset_anchor in function_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'teacher_context_recovery_scope_anchor_changed';
  end if;

  function_definition := replace(
    function_definition,
    update_anchor,
    update_replacement
  );
  function_definition := replace(
    function_definition,
    freeze_anchor,
    freeze_replacement
  );
  function_definition := replace(
    function_definition,
    reset_anchor,
    reset_replacement
  );
  execute function_definition;
end;
$patch_teacher_context_recovery_scope$;

-- Updating a batch level cannot mutate any immutable writing/cycle/assignment
-- snapshot. Instead, cancel only untouched automatic assignments whose stored
-- worksheet level no longer matches. Their durable transition job detaches the
-- assignment and the strengthened locking predicate holds the cycle.
create or replace function app_private.cancel_untouched_practice_level_mismatches(
  target_workspace_id uuid,
  target_batch_id uuid,
  target_current_level text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job record;
  cancelled_count integer := 0;
begin
  if target_workspace_id is null
    or target_batch_id is null
    or target_current_level not in ('A1', 'A2', 'B1', 'B2')
  then
    return 0;
  end if;

  for selected_job in
    select job.id, job.queue_name, job.queue_message_id
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.job_kind = 'worksheet_generation'
      and job.status in ('queued', 'retry', 'processing')
      and assignment.workspace_id = target_workspace_id
      and assignment.batch_id = target_batch_id
      and assignment.worksheet_level is distinct from target_current_level
      and assignment.class_context_version = 1
      and assignment.source in ('weakness_auto', 'adaptive_repeat')
      and assignment.status = 'unlocked'
      and assignment.started_at is null
      and assignment.latest_attempt_id is null
    order by job.id
    for update of job
  loop
    if selected_job.queue_message_id is not null then
      perform pgmq.archive(
        selected_job.queue_name,
        selected_job.queue_message_id
      );
    end if;

    update app_private.async_jobs job
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'class_context_inactive'
    where job.id = selected_job.id;
  end loop;

  update public.student_practice_assignments assignment
  set
    status = 'cancelled',
    completed_at = coalesce(assignment.completed_at, now()),
    generation_status = case
      when assignment.generation_status in ('queued', 'generating')
      then 'failed'
      else assignment.generation_status
    end,
    generation_completed_at = case
      when assignment.generation_status in ('queued', 'generating')
      then now()
      else assignment.generation_completed_at
    end,
    generation_error = case
      when assignment.generation_status in ('queued', 'generating')
      then 'class_context_inactive'
      else assignment.generation_error
    end
  where assignment.workspace_id = target_workspace_id
    and assignment.batch_id = target_batch_id
    and assignment.worksheet_level is distinct from target_current_level
    and assignment.class_context_version = 1
    and assignment.source in ('weakness_auto', 'adaptive_repeat')
    and assignment.status = 'unlocked'
    and assignment.started_at is null
    and assignment.latest_attempt_id is null;
  get diagnostics cancelled_count = row_count;
  return cancelled_count;
end;
$$;

revoke all on function app_private.cancel_untouched_practice_level_mismatches(
  uuid, uuid, text
)
from public, anon, authenticated, service_role;

create or replace function app_private.on_practice_batch_activity_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_student record;
begin
  if old.is_active and not new.is_active then
    for selected_student in
      select distinct assignment.student_id
      from public.student_practice_assignments assignment
      where assignment.workspace_id = new.workspace_id
        and assignment.batch_id = new.id
        and assignment.class_context_version = 1
        and assignment.source in ('weakness_auto', 'adaptive_repeat')
        and assignment.status = 'unlocked'
        and assignment.started_at is null
        and assignment.latest_attempt_id is null
      order by assignment.student_id
    loop
      perform app_private.cancel_untouched_practice_class_assignments(
        new.workspace_id,
        selected_student.student_id,
        new.id,
        'class_inactive'
      );
    end loop;
  elsif new.is_active and old.level is distinct from new.level then
    perform app_private.cancel_untouched_practice_level_mismatches(
      new.workspace_id,
      new.id,
      new.level
    );
  end if;

  if new.is_active and (
    not old.is_active
    or old.level is distinct from new.level
  ) then
    delete from app_private.practice_level_fit_reconciliation_failures failure
    using app_private.practice_resolution_cycles cycle
    where failure.cycle_id = cycle.id
      and cycle.workspace_id = new.workspace_id
      and cycle.batch_id = new.id
      and cycle.worksheet_level = new.level
      and cycle.resolved_at is null
      and cycle.state = 'locked'
      and cycle.state_reason = 'active_class_context_required';
  end if;

  return new;
end;
$$;

revoke all on function app_private.on_practice_batch_activity_changed()
from public, anon, authenticated, service_role;

drop trigger if exists batches_reconcile_practice_activity
on public.batches;
create trigger batches_reconcile_practice_activity
after update of is_active, level on public.batches
for each row
when (
  old.is_active is distinct from new.is_active
  or old.level is distinct from new.level
)
execute function app_private.on_practice_batch_activity_changed();

comment on function app_private.practice_class_context_is_active(
  uuid, uuid, uuid, text
) is
  'Returns true only while workspace role, enrollment, active batch, and the batch current CEFR level all match the immutable practice context.';

comment on function app_private.lock_active_practice_class_context(
  uuid, uuid, uuid, text
) is
  'Locks and validates workspace role, active batch with exact CEFR level, and class enrollment in canonical order.';

comment on function app_private.cancel_untouched_practice_level_mismatches(
  uuid, uuid, text
) is
  'Cancels only untouched automatic preparation made stale by a batch CEFR edit; historical or started work is preserved.';

notify pgrst, 'reload schema';
