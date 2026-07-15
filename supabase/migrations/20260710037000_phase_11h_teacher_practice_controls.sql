-- Phase 11H: teacher worksheet review, auditable score correction, and support actions.
--
-- Automated attempt results remain immutable in the action history even when a
-- teacher corrects the effective score. If a resolved adaptive pass is changed
-- to a fail, a compensating evidence row opens one new resolution cycle instead
-- of rewriting the already-recorded cycle.

create table app_private.practice_teacher_actions (
  id uuid primary key default gen_random_uuid(),
  action_sequence bigint generated always as identity unique,
  assignment_id uuid not null
    references public.student_practice_assignments(id) on delete restrict,
  attempt_id uuid
    references public.practice_test_attempts(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  grammar_topic_id uuid not null references public.grammar_topics(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action_revision integer not null check (action_revision > 0),
  action_type text not null check (action_type in (
    'score_override',
    'assignment_reassigned',
    'support_resolved'
  )),
  resolution text check (
    resolution is null or resolution in ('reassigned', 'contacted', 'not_needed')
  ),
  reason text not null check (length(reason) between 3 and 1000),
  before_state jsonb not null default '{}'::jsonb
    check (jsonb_typeof(before_state) = 'object'),
  after_state jsonb not null default '{}'::jsonb
    check (jsonb_typeof(after_state) = 'object'),
  related_assignment_id uuid
    references public.student_practice_assignments(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (assignment_id, action_revision),
  check (
    (action_type = 'score_override' and attempt_id is not null and resolution is null)
    or (action_type = 'assignment_reassigned' and resolution is null and related_assignment_id is not null)
    or (action_type = 'support_resolved' and resolution is not null)
  )
);

create index practice_teacher_actions_assignment_sequence_idx
on app_private.practice_teacher_actions (assignment_id, action_revision desc);

create index practice_teacher_actions_workspace_created_idx
on app_private.practice_teacher_actions (workspace_id, created_at desc, id desc);

alter table app_private.practice_teacher_actions enable row level security;

revoke all on table app_private.practice_teacher_actions
from public, anon, authenticated, service_role;
revoke all on all sequences in schema app_private
from public, anon, authenticated, service_role;

drop trigger if exists practice_teacher_actions_immutable
on app_private.practice_teacher_actions;
create trigger practice_teacher_actions_immutable
before update or delete on app_private.practice_teacher_actions
for each row execute function app_private.reject_adaptive_history_mutation();

-- A score correction that changes a previously resolved pass to a fail is new
-- pedagogical evidence. It deliberately has no submission payload or student
-- writing attached to it.
alter table app_private.practice_weakness_evidence
  alter column submission_id drop not null,
  add column teacher_action_id uuid
    references app_private.practice_teacher_actions(id) on delete restrict;

do $drop_old_source_checks$
declare
  constraint_name text;
begin
  for constraint_name in
    select constraint_info.conname
    from pg_constraint constraint_info
    where constraint_info.conrelid = 'app_private.practice_weakness_evidence'::regclass
      and constraint_info.contype = 'c'
      and pg_get_constraintdef(constraint_info.oid) like '%source_kind%'
  loop
    execute format(
      'alter table app_private.practice_weakness_evidence drop constraint %I',
      constraint_name
    );
  end loop;
end;
$drop_old_source_checks$;

alter table app_private.practice_weakness_evidence
  add constraint practice_weakness_evidence_source_kind_v2_check
    check (source_kind in (
      'feedback_draft',
      'legacy_release',
      'teacher_score_override'
    )),
  add constraint practice_weakness_evidence_source_shape_v2_check
    check (
      (
        source_kind = 'feedback_draft'
        and feedback_draft_id = source_release_id
        and submission_id is not null
        and teacher_action_id is null
      )
      or (
        source_kind = 'legacy_release'
        and feedback_draft_id is null
        and submission_id is not null
        and teacher_action_id is null
      )
      or (
        source_kind = 'teacher_score_override'
        and feedback_draft_id is null
        and submission_id is null
        and teacher_action_id = source_release_id
      )
    );

create or replace function public.get_practice_teacher_actions_internal(
  target_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  current_revision integer := 0;
  support_state text;
  result_items jsonb := '[]'::jsonb;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if selected_assignment.id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(
      selected_assignment.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select
    coalesce(max(action.action_revision), 0),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', action.id,
          'action_revision', action.action_revision,
          'action_type', action.action_type,
          'attempt_id', action.attempt_id,
          'resolution', action.resolution,
          'reason', action.reason,
          'before_state', action.before_state,
          'after_state', action.after_state,
          'related_assignment_id', action.related_assignment_id,
          'actor_id', action.actor_id,
          'actor_name', coalesce(actor.full_name, 'Teacher'),
          'created_at', action.created_at
        )
        order by action.action_revision desc
      ),
      '[]'::jsonb
    )
  into current_revision, result_items
  from app_private.practice_teacher_actions action
  join public.profiles actor on actor.id = action.actor_id
  where action.assignment_id = selected_assignment.id;

  support_state := case
    when selected_assignment.status <> 'failed' then 'not_applicable'
    when exists (
      select 1
      from app_private.practice_teacher_actions action
      where action.assignment_id = selected_assignment.id
        and action.action_type = 'support_resolved'
    ) then 'resolved'
    else 'open'
  end;

  return jsonb_build_object(
    'schema_version', 1,
    'assignment_id', selected_assignment.id,
    'current_revision', current_revision,
    'support_status', support_state,
    'items', result_items
  );
end;
$$;

create or replace function public.override_practice_attempt_score_internal(
  target_assignment_id uuid,
  target_score_percent numeric,
  override_reason text,
  expected_action_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  selected_attempt public.practice_test_attempts%rowtype;
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  current_revision integer := 0;
  next_revision integer;
  clean_reason text := btrim(override_reason);
  normalized_percent numeric(5, 2);
  normalized_points numeric(6, 2);
  calculated_passed boolean;
  next_assignment_status text;
  action_id uuid := gen_random_uuid();
  follow_up_assignment_id uuid;
  existing_follow_up_assignment_id uuid;
  existing_follow_up_status text;
  prior_outcome_override_count integer := 0;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_assignment_id is null
    or target_score_percent is null
    or target_score_percent < 0
    or target_score_percent > 100
    or clean_reason is null
    or length(clean_reason) not between 8 and 1000
    or expected_action_revision is null
    or expected_action_revision < 0
  then
    raise exception using errcode = '22023', message = 'invalid_score_override';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      selected_assignment.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select attempt.*
  into selected_attempt
  from public.practice_test_attempts attempt
  where attempt.id = selected_assignment.latest_attempt_id
    and attempt.assignment_id = selected_assignment.id
  for update;

  if selected_attempt.id is null
    or selected_attempt.status <> 'checked'
    or selected_attempt.evaluation_status not in ('completed', 'not_needed')
    or selected_attempt.score_percent is null
    or selected_attempt.passed is null
    or selected_attempt.max_score_points is null
    or selected_attempt.max_score_points <= 0
  then
    raise exception using errcode = '55000', message = 'practice_score_not_terminal';
  end if;

  select
    coalesce(max(action.action_revision), 0),
    count(*) filter (
      where action.action_type = 'score_override'
        and (action.before_state ->> 'passed')
          is distinct from (action.after_state ->> 'passed')
    )
  into current_revision, prior_outcome_override_count
  from app_private.practice_teacher_actions action
  where action.assignment_id = selected_assignment.id;

  if current_revision <> expected_action_revision then
    raise exception using errcode = '40001', message = 'teacher_action_revision_conflict';
  end if;

  normalized_percent := round(target_score_percent, 2);
  normalized_points := round(
    (selected_attempt.max_score_points * normalized_percent) / 100,
    2
  );
  calculated_passed := normalized_percent >= 70;
  next_assignment_status := case when calculated_passed then 'passed' else 'failed' end;

  if normalized_percent = selected_attempt.score_percent then
    raise exception using errcode = '22023', message = 'score_override_unchanged';
  end if;
  if selected_attempt.passed is distinct from calculated_passed
    and prior_outcome_override_count > 0
  then
    raise exception using errcode = '55000', message = 'score_outcome_already_corrected';
  end if;

  if selected_attempt.passed = false
    and calculated_passed = true
    and selected_assignment.resolution_cycle_id is not null
  then
    select assignment.id, assignment.status
    into existing_follow_up_assignment_id, existing_follow_up_status
    from public.student_practice_assignments assignment
    where assignment.resolution_cycle_id = selected_assignment.resolution_cycle_id
      and assignment.id <> selected_assignment.id
      and assignment.status in ('unlocked', 'in_progress', 'completed')
    order by assignment.assigned_at desc, assignment.id desc
    limit 1
    for update;

    if existing_follow_up_status in ('in_progress', 'completed') then
      raise exception using
        errcode = '55000',
        message = 'active_follow_up_in_progress';
    end if;
    if existing_follow_up_assignment_id is not null and (
      exists (
        select 1
        from public.practice_test_attempts attempt
        where attempt.assignment_id = existing_follow_up_assignment_id
      )
      or exists (
        select 1
        from app_private.practice_drafts draft
        where draft.assignment_id = existing_follow_up_assignment_id
      )
    ) then
      raise exception using
        errcode = '55000',
        message = 'active_follow_up_has_saved_work';
    end if;
  end if;

  next_revision := current_revision + 1;

  insert into app_private.practice_teacher_actions (
    id,
    assignment_id,
    attempt_id,
    workspace_id,
    student_id,
    grammar_topic_id,
    actor_id,
    action_revision,
    action_type,
    reason,
    before_state,
    after_state
  ) values (
    action_id,
    selected_assignment.id,
    selected_attempt.id,
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id,
    caller_id,
    next_revision,
    'score_override',
    clean_reason,
    jsonb_build_object(
      'score_points', selected_attempt.score_points,
      'max_score_points', selected_attempt.max_score_points,
      'score_percent', selected_attempt.score_percent,
      'passed', selected_attempt.passed,
      'assignment_status', selected_assignment.status,
      'scoring_version', selected_attempt.scoring_version
    ),
    jsonb_build_object(
      'score_points', normalized_points,
      'max_score_points', selected_attempt.max_score_points,
      'score_percent', normalized_percent,
      'passed', calculated_passed,
      'assignment_status', next_assignment_status,
      'scoring_version', 'teacher_override_v1',
      'superseded_assignment_id', existing_follow_up_assignment_id
    )
  );

  update public.practice_test_attempts attempt
  set
    score_points = normalized_points,
    score_percent = normalized_percent,
    passed = calculated_passed,
    scoring_version = 'teacher_override_v1',
    feedback = coalesce(attempt.feedback, '{}'::jsonb) || jsonb_build_object(
      'teacher_override', jsonb_build_object(
        'action_id', action_id,
        'score_points', normalized_points,
        'max_score_points', selected_attempt.max_score_points,
        'score_percent', normalized_percent,
        'passed', calculated_passed
      )
    )
  where attempt.id = selected_attempt.id;

  update public.student_practice_assignments assignment
  set
    status = next_assignment_status,
    completed_at = coalesce(assignment.completed_at, now())
  where assignment.id = selected_assignment.id;

  -- A failed adaptive attempt may already have produced an untouched unlocked
  -- replacement. Once the teacher corrects that failure to a pass, the cycle
  -- is resolved by the status trigger above; cancel the now-superseded child
  -- afterward so a resolved cycle cannot retain an active worksheet.
  if selected_attempt.passed = false
    and calculated_passed = true
    and existing_follow_up_assignment_id is not null
  then
    update public.student_practice_assignments assignment
    set
      status = 'cancelled',
      adaptive_reason = 'teacher_score_override_superseded'
    where assignment.id = existing_follow_up_assignment_id
      and assignment.status = 'unlocked';
  end if;

  if selected_attempt.passed = true and calculated_passed = false
    and selected_assignment.resolution_cycle_id is not null
  then
    select cycle.*
    into selected_cycle
    from app_private.practice_resolution_cycles cycle
    where cycle.id = selected_assignment.resolution_cycle_id;

    if selected_cycle.id is not null and selected_cycle.resolved_at is not null then
      insert into app_private.practice_weakness_evidence (
        source_kind,
        source_release_id,
        teacher_action_id,
        submission_id,
        workspace_id,
        student_id,
        grammar_topic_id,
        minor_issue_count,
        major_issue_count,
        released_at
      ) values (
        'teacher_score_override',
        action_id,
        action_id,
        null,
        selected_assignment.workspace_id,
        selected_assignment.student_id,
        selected_assignment.grammar_topic_id,
        0,
        1,
        now()
      );
    end if;
  end if;

  select assignment.id
  into follow_up_assignment_id
  from public.student_practice_assignments assignment
  where assignment.workspace_id = selected_assignment.workspace_id
    and assignment.student_id = selected_assignment.student_id
    and assignment.grammar_topic_id = selected_assignment.grammar_topic_id
    and assignment.id <> selected_assignment.id
    and assignment.status in ('unlocked', 'in_progress', 'completed')
  order by assignment.assigned_at desc, assignment.id desc
  limit 1;

  return jsonb_build_object(
    'schema_version', 1,
    'action_id', action_id,
    'action_revision', next_revision,
    'assignment_id', selected_assignment.id,
    'attempt_id', selected_attempt.id,
    'score_points', normalized_points,
    'max_score_points', selected_attempt.max_score_points,
    'score_percent', normalized_percent,
    'passed', calculated_passed,
    'assignment_status', next_assignment_status,
    'follow_up_assignment_id', follow_up_assignment_id
  );
end;
$$;

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
  selected_assignment public.student_practice_assignments%rowtype;
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

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
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
  limit 1;

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
    limit 1;
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
      generation_status
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
      case when selected_test_id is null then 'idle' else 'ready' end
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

create or replace function public.resolve_practice_support_internal(
  target_assignment_id uuid,
  support_resolution text,
  support_notes text,
  expected_action_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  current_revision integer := 0;
  next_revision integer;
  clean_notes text := nullif(btrim(support_notes), '');
  related_assignment uuid;
  action_id uuid;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_assignment_id is null
    or support_resolution is null
    or support_resolution not in ('reassigned', 'contacted', 'not_needed')
    or length(coalesce(clean_notes, support_resolution)) > 1000
    or expected_action_revision is null
    or expected_action_revision < 0
  then
    raise exception using errcode = '22023', message = 'invalid_support_resolution';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      selected_assignment.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;
  if selected_assignment.status <> 'failed' then
    raise exception using errcode = '55000', message = 'support_item_not_open';
  end if;

  select coalesce(max(action.action_revision), 0)
  into current_revision
  from app_private.practice_teacher_actions action
  where action.assignment_id = selected_assignment.id;

  if current_revision <> expected_action_revision then
    raise exception using errcode = '40001', message = 'teacher_action_revision_conflict';
  end if;
  if exists (
    select 1
    from app_private.practice_teacher_actions action
    where action.assignment_id = selected_assignment.id
      and action.action_type = 'support_resolved'
  ) then
    raise exception using errcode = '55000', message = 'support_item_already_resolved';
  end if;

  select assignment.id
  into related_assignment
  from public.student_practice_assignments assignment
  where assignment.workspace_id = selected_assignment.workspace_id
    and assignment.student_id = selected_assignment.student_id
    and assignment.grammar_topic_id = selected_assignment.grammar_topic_id
    and assignment.id <> selected_assignment.id
    and assignment.status in ('unlocked', 'in_progress', 'completed')
  order by assignment.assigned_at desc, assignment.id desc
  limit 1;

  if support_resolution = 'reassigned' and related_assignment is null then
    raise exception using errcode = '55000', message = 'replacement_assignment_required';
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
    resolution,
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
    'support_resolved',
    support_resolution,
    coalesce(clean_notes, replace(support_resolution, '_', ' ')),
    jsonb_build_object('support_status', 'open'),
    jsonb_build_object(
      'support_status', 'resolved',
      'resolution', support_resolution
    ),
    related_assignment
  )
  returning id into action_id;

  return jsonb_build_object(
    'schema_version', 1,
    'action_id', action_id,
    'assignment_id', selected_assignment.id,
    'action_revision', next_revision,
    'support_status', 'resolved',
    'resolution', support_resolution,
    'related_assignment_id', related_assignment
  );
end;
$$;

revoke all on function public.get_practice_teacher_actions_internal(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.override_practice_attempt_score_internal(uuid, numeric, text, integer)
from public, anon, authenticated, service_role;
revoke all on function public.reassign_practice_assignment_internal(uuid, text, integer)
from public, anon, authenticated, service_role;
revoke all on function public.resolve_practice_support_internal(uuid, text, text, integer)
from public, anon, authenticated, service_role;

grant execute on function public.get_practice_teacher_actions_internal(uuid)
to authenticated;
grant execute on function public.override_practice_attempt_score_internal(uuid, numeric, text, integer)
to authenticated;
grant execute on function public.reassign_practice_assignment_internal(uuid, text, integer)
to authenticated;
grant execute on function public.resolve_practice_support_internal(uuid, text, text, integer)
to authenticated;

create or replace function api.get_practice_teacher_actions(target_assignment_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.get_practice_teacher_actions_internal(target_assignment_id);
$$;

create or replace function api.override_practice_attempt_score(
  target_assignment_id uuid,
  target_score_percent numeric,
  override_reason text,
  expected_action_revision integer
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.override_practice_attempt_score_internal(
    target_assignment_id,
    target_score_percent,
    override_reason,
    expected_action_revision
  );
$$;

create or replace function api.reassign_practice_assignment(
  target_assignment_id uuid,
  reassignment_reason text,
  expected_action_revision integer
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.reassign_practice_assignment_internal(
    target_assignment_id,
    reassignment_reason,
    expected_action_revision
  );
$$;

create or replace function api.resolve_practice_support(
  target_assignment_id uuid,
  support_resolution text,
  support_notes text,
  expected_action_revision integer
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.resolve_practice_support_internal(
    target_assignment_id,
    support_resolution,
    support_notes,
    expected_action_revision
  );
$$;

revoke all on function api.get_practice_teacher_actions(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.override_practice_attempt_score(uuid, numeric, text, integer)
from public, anon, authenticated, service_role;
revoke all on function api.reassign_practice_assignment(uuid, text, integer)
from public, anon, authenticated, service_role;
revoke all on function api.resolve_practice_support(uuid, text, text, integer)
from public, anon, authenticated, service_role;

grant execute on function api.get_practice_teacher_actions(uuid) to authenticated;
grant execute on function api.override_practice_attempt_score(uuid, numeric, text, integer)
to authenticated;
grant execute on function api.reassign_practice_assignment(uuid, text, integer)
to authenticated;
grant execute on function api.resolve_practice_support(uuid, text, text, integer)
to authenticated;

comment on function api.get_practice_teacher_actions(uuid) is
  'Teacher-only immutable worksheet action history and support status.';
comment on function api.override_practice_attempt_score(uuid, numeric, text, integer) is
  'Revision-safe teacher score correction with adaptive compensation.';
comment on function api.reassign_practice_assignment(uuid, text, integer) is
  'Revision-safe teacher reassignment that preserves prior attempts.';
comment on function api.resolve_practice_support(uuid, text, text, integer) is
  'Closes an operational teacher-support recommendation without manufacturing mastery.';

notify pgrst, 'reload schema';
