-- Phase 12G: freeze the class and CEFR level that caused adaptive practice.
--
-- A student may belong to several classes at different levels. Worksheet
-- generation must therefore never infer a level from the student's current
-- memberships. Released writing evidence captures its source class, a
-- resolution cycle freezes the newest qualifying evidence context when it
-- opens, and every assignment inherits that immutable snapshot.

alter table app_private.practice_weakness_evidence
  add column if not exists batch_id uuid
    references public.batches(id) on delete restrict,
  add column if not exists evidence_level text;

alter table app_private.practice_resolution_cycles
  add column if not exists batch_id uuid
    references public.batches(id) on delete restrict,
  add column if not exists worksheet_level text,
  add column if not exists class_context_version smallint not null default 0;

alter table public.student_practice_assignments
  add column if not exists batch_id uuid
    references public.batches(id) on delete restrict,
  add column if not exists worksheet_level text,
  add column if not exists class_context_version smallint not null default 0;

alter table app_private.practice_weakness_evidence
  drop constraint if exists practice_weakness_evidence_class_context_check,
  add constraint practice_weakness_evidence_class_context_check
    check (
      (batch_id is null and evidence_level is null)
      or (
        batch_id is not null
        and evidence_level is not null
        and evidence_level in ('A1', 'A2', 'B1', 'B2')
      )
    );

alter table app_private.practice_resolution_cycles
  drop constraint if exists practice_resolution_cycles_class_context_check,
  add constraint practice_resolution_cycles_class_context_check
    check (
      (
        class_context_version = 0
        and batch_id is null
        and worksheet_level is null
      )
      or (
        class_context_version = 1
        and batch_id is not null
        and worksheet_level is not null
        and worksheet_level in ('A1', 'A2', 'B1', 'B2')
      )
    );

alter table public.student_practice_assignments
  drop constraint if exists student_practice_assignments_class_context_check,
  add constraint student_practice_assignments_class_context_check
    check (
      (
        class_context_version = 0
        and batch_id is null
        and worksheet_level is null
      )
      or (
        class_context_version = 1
        and batch_id is not null
        and worksheet_level is not null
        and worksheet_level in ('A1', 'A2', 'B1', 'B2')
      )
    );

-- The ledger is immutable after capture. Temporarily remove only its immutable
-- trigger while deriving context for historical rows from their own submission.
drop trigger if exists practice_weakness_evidence_immutable
on app_private.practice_weakness_evidence;

update app_private.practice_weakness_evidence evidence
set
  batch_id = batch.id,
  evidence_level = batch.level
from public.submissions submission
join public.batches batch
  on batch.id = submission.batch_id
 and batch.workspace_id = submission.workspace_id
where submission.id = evidence.submission_id
  and submission.workspace_id = evidence.workspace_id
  and batch.level in ('A1', 'A2', 'B1', 'B2')
  and evidence.batch_id is null;

create trigger practice_weakness_evidence_immutable
before update or delete on app_private.practice_weakness_evidence
for each row execute function app_private.reject_adaptive_history_mutation();

-- Resolved cycles are immutable under the existing guard, so pause that guard
-- only for the evidence-backed historical context backfill.
drop trigger if exists practice_resolution_cycles_guard
on app_private.practice_resolution_cycles;

with cycle_context as materialized (
  select cycle.id, context.batch_id, context.evidence_level
  from app_private.practice_resolution_cycles cycle
  cross join lateral (
    select evidence.batch_id, evidence.evidence_level
    from app_private.practice_weakness_evidence evidence
    where evidence.workspace_id = cycle.workspace_id
      and evidence.student_id = cycle.student_id
      and evidence.grammar_topic_id = cycle.grammar_topic_id
      and evidence.evidence_sequence between
        cycle.evidence_start_sequence and cycle.evidence_through_sequence
      and evidence.batch_id is not null
      and evidence.evidence_level in ('A1', 'A2', 'B1', 'B2')
    order by evidence.evidence_sequence desc
    limit 1
  ) context
  where cycle.class_context_version = 0
)
update app_private.practice_resolution_cycles cycle
set
  batch_id = context.batch_id,
  worksheet_level = context.evidence_level,
  class_context_version = 1
from cycle_context context
where cycle.id = context.id;

-- Do not rewrite completed, used, or already-attached historical assignments.
-- Only a still-untouched row that needs generation receives the proven cycle
-- snapshot in place. Future repeats can inherit the same context from the
-- immutable cycle without changing historical assignment rows.
update public.student_practice_assignments assignment
set
  batch_id = cycle.batch_id,
  worksheet_level = cycle.worksheet_level,
  class_context_version = 1
from app_private.practice_resolution_cycles cycle
where cycle.id = assignment.resolution_cycle_id
  and cycle.class_context_version = 1
  and assignment.class_context_version = 0
  and assignment.status = 'unlocked'
  and assignment.practice_test_id is null
  and assignment.latest_attempt_id is null;

-- Only untouched rows that still need generation are held for an explicit
-- teacher selection. Completed attempts and already attached worksheets keep
-- their historical visibility and scoring exactly as stored.
update public.student_practice_assignments assignment
set
  generation_status = 'failed',
  generation_completed_at = coalesce(assignment.generation_completed_at, now()),
  generation_error = 'worksheet_class_context_required'
where assignment.class_context_version = 0
  and assignment.status = 'unlocked'
  and assignment.practice_test_id is null
  and assignment.latest_attempt_id is null;

-- Stop any already-queued ambiguous job before the worker can generate against
-- stale membership data. The assignment can be queued again after resolution.
do $phase_12g_cancel_ambiguous_jobs$
declare
  selected_job record;
begin
  for selected_job in
    select job.id, job.queue_name, job.queue_message_id
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.job_kind = 'worksheet_generation'
      and job.status in ('queued', 'retry', 'processing')
      and assignment.class_context_version = 0
      and assignment.status = 'unlocked'
      and assignment.practice_test_id is null
      and assignment.latest_attempt_id is null
    for update of job
  loop
    if selected_job.queue_message_id is not null then
      perform pgmq.archive(selected_job.queue_name, selected_job.queue_message_id);
    end if;

    update app_private.async_jobs job
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'worksheet_class_context_required'
    where job.id = selected_job.id;
  end loop;
end;
$phase_12g_cancel_ambiguous_jobs$;

create or replace function app_private.populate_practice_evidence_class_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_batch public.batches%rowtype;
begin
  if new.batch_id is null then
    select batch.*
    into selected_batch
    from public.submissions submission
    join public.batches batch
      on batch.id = submission.batch_id
     and batch.workspace_id = submission.workspace_id
    where submission.id = new.submission_id
      and submission.workspace_id = new.workspace_id;

    -- A teacher may correct a previously passed practice result to a failure.
    -- That recurrence is not a new writing submission, so inherit the exact
    -- immutable class snapshot from the audited assignment behind the action.
    if selected_batch.id is null and new.teacher_action_id is not null then
      select batch.*
      into selected_batch
      from app_private.practice_teacher_actions action
      join public.student_practice_assignments assignment
        on assignment.id = action.assignment_id
       and assignment.workspace_id = action.workspace_id
       and assignment.student_id = action.student_id
       and assignment.grammar_topic_id = action.grammar_topic_id
      join public.batches batch
        on batch.id = assignment.batch_id
       and batch.workspace_id = assignment.workspace_id
       and batch.level = assignment.worksheet_level
      where action.id = new.teacher_action_id
        and action.workspace_id = new.workspace_id
        and action.student_id = new.student_id
        and action.grammar_topic_id = new.grammar_topic_id
        and assignment.class_context_version = 1;
    end if;

    if selected_batch.id is not null then
      new.batch_id := selected_batch.id;
      new.evidence_level := selected_batch.level;
    end if;
  else
    select batch.*
    into selected_batch
    from public.batches batch
    where batch.id = new.batch_id
      and batch.workspace_id = new.workspace_id;

    if selected_batch.id is null
      or selected_batch.level is distinct from new.evidence_level
    then
      raise exception using
        errcode = '22023',
        message = 'Practice evidence class context is invalid.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.populate_practice_evidence_class_context()
from public, anon, authenticated, service_role;

drop trigger if exists practice_weakness_evidence_class_context
on app_private.practice_weakness_evidence;
create trigger practice_weakness_evidence_class_context
before insert on app_private.practice_weakness_evidence
for each row execute function app_private.populate_practice_evidence_class_context();

create or replace function app_private.populate_practice_cycle_class_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_batch public.batches%rowtype;
begin
  if new.batch_id is null then
    select evidence.batch_id, evidence.evidence_level
    into new.batch_id, new.worksheet_level
    from app_private.practice_weakness_evidence evidence
    where evidence.workspace_id = new.workspace_id
      and evidence.student_id = new.student_id
      and evidence.grammar_topic_id = new.grammar_topic_id
      and evidence.evidence_sequence between
        new.evidence_start_sequence and new.evidence_through_sequence
      and evidence.batch_id is not null
      and evidence.evidence_level in ('A1', 'A2', 'B1', 'B2')
    order by evidence.evidence_sequence desc
    limit 1;
  end if;

  if new.batch_id is null then
    new.worksheet_level := null;
    new.class_context_version := 0;
    return new;
  end if;

  select batch.*
  into selected_batch
  from public.batches batch
  where batch.id = new.batch_id
    and batch.workspace_id = new.workspace_id;

  if selected_batch.id is null
    or selected_batch.level is distinct from new.worksheet_level
  then
    raise exception using
      errcode = '22023',
      message = 'Practice cycle class context is invalid.';
  end if;

  new.class_context_version := 1;
  return new;
end;
$$;

revoke all on function app_private.populate_practice_cycle_class_context()
from public, anon, authenticated, service_role;

drop trigger if exists practice_resolution_cycles_populate_class_context
on app_private.practice_resolution_cycles;
create trigger practice_resolution_cycles_populate_class_context
before insert on app_private.practice_resolution_cycles
for each row execute function app_private.populate_practice_cycle_class_context();

create or replace function app_private.guard_practice_resolution_cycle_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.workspace_id <> new.workspace_id
    or old.student_id <> new.student_id
    or old.grammar_topic_id <> new.grammar_topic_id
    or old.cycle_number <> new.cycle_number
    or old.evidence_start_sequence <> new.evidence_start_sequence
  then
    raise exception using errcode = '55000', message = 'Practice cycle identity is immutable.';
  end if;

  if old.class_context_version = 1 and (
    new.class_context_version <> old.class_context_version
    or new.batch_id is distinct from old.batch_id
    or new.worksheet_level is distinct from old.worksheet_level
  ) then
    raise exception using errcode = '55000', message = 'Practice cycle class context is immutable.';
  end if;

  if old.class_context_version = 0 and new.class_context_version = 1 then
    if new.batch_id is null
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

  if old.state = 'locked' and new.state not in ('locked', 'unlocked') then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  elsif old.state = 'unlocked' and new.state not in ('unlocked', 'in_progress', 'improving', 'mastered') then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  elsif old.state = 'in_progress' and new.state not in ('in_progress', 'unlocked', 'improving', 'mastered') then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function app_private.guard_practice_resolution_cycle_update()
from public, anon, authenticated, service_role;

create trigger practice_resolution_cycles_guard
before update on app_private.practice_resolution_cycles
for each row execute function app_private.guard_practice_resolution_cycle_update();

create or replace function app_private.guard_practice_assignment_cycle_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  previous_assignment public.student_practice_assignments%rowtype;
  selected_batch public.batches%rowtype;
begin
  if tg_op = 'UPDATE' and old.resolution_cycle_id is not null and (
    new.resolution_cycle_id is distinct from old.resolution_cycle_id
    or new.resolution_cycle_number is distinct from old.resolution_cycle_number
    or new.evidence_cutoff_sequence is distinct from old.evidence_cutoff_sequence
  ) then
    raise exception using errcode = '55000', message = 'Practice assignment cycle context is immutable.';
  end if;

  if tg_op = 'UPDATE' and old.class_context_version = 1 and (
    new.class_context_version <> old.class_context_version
    or new.batch_id is distinct from old.batch_id
    or new.worksheet_level is distinct from old.worksheet_level
  ) then
    raise exception using errcode = '55000', message = 'Practice assignment class context is immutable.';
  end if;

  if new.resolution_cycle_id is not null then
    select cycle.*
    into selected_cycle
    from app_private.practice_resolution_cycles cycle
    where cycle.id = new.resolution_cycle_id;

    if selected_cycle.id is null
      or selected_cycle.workspace_id <> new.workspace_id
      or selected_cycle.student_id <> new.student_id
      or selected_cycle.grammar_topic_id <> new.grammar_topic_id
      or selected_cycle.cycle_number <> new.resolution_cycle_number
      or selected_cycle.evidence_through_sequence <> new.evidence_cutoff_sequence
    then
      raise exception using errcode = '55000', message = 'Practice assignment cycle context is invalid.';
    end if;

    if selected_cycle.class_context_version = 1 then
      new.batch_id := selected_cycle.batch_id;
      new.worksheet_level := selected_cycle.worksheet_level;
      new.class_context_version := 1;
    else
      new.batch_id := null;
      new.worksheet_level := null;
      new.class_context_version := 0;
      new.generation_status := 'failed';
      new.generation_completed_at := coalesce(new.generation_completed_at, now());
      new.generation_error := 'worksheet_class_context_required';
    end if;

    if current_user in ('anon', 'authenticated')
      and (tg_op = 'INSERT' or old.resolution_cycle_id is null)
    then
      raise exception using errcode = '42501', message = 'Practice cycle context is server managed.';
    end if;
  elsif new.class_context_version = 0
    and new.previous_assignment_id is not null
  then
    select assignment.*
    into previous_assignment
    from public.student_practice_assignments assignment
    where assignment.id = new.previous_assignment_id
      and assignment.workspace_id = new.workspace_id
      and assignment.student_id = new.student_id
      and assignment.grammar_topic_id = new.grammar_topic_id;

    if previous_assignment.class_context_version = 1 then
      new.batch_id := previous_assignment.batch_id;
      new.worksheet_level := previous_assignment.worksheet_level;
      new.class_context_version := 1;
    elsif previous_assignment.resolution_cycle_id is not null then
      select cycle.*
      into selected_cycle
      from app_private.practice_resolution_cycles cycle
      where cycle.id = previous_assignment.resolution_cycle_id;

      if selected_cycle.class_context_version = 1 then
        new.batch_id := selected_cycle.batch_id;
        new.worksheet_level := selected_cycle.worksheet_level;
        new.class_context_version := 1;
      end if;
    end if;
  end if;

  if new.class_context_version = 1 then
    select batch.*
    into selected_batch
    from public.batches batch
    where batch.id = new.batch_id
      and batch.workspace_id = new.workspace_id;

    if selected_batch.id is null
      or selected_batch.level is distinct from new.worksheet_level
    then
      raise exception using errcode = '22023', message = 'Practice assignment class context is invalid.';
    end if;

    if new.resolution_cycle_id is null
      and (tg_op = 'INSERT' or old.class_context_version = 0)
      and not exists (
        select 1
        from public.batch_students membership
        where membership.workspace_id = new.workspace_id
          and membership.batch_id = new.batch_id
          and membership.student_id = new.student_id
      )
    then
      raise exception using errcode = '42501', message = 'Student class assignment is required.';
    end if;
  elsif tg_op = 'INSERT' and new.resolution_cycle_id is null then
    -- Direct table mutation is revoked from browser roles. Preserve legacy
    -- server imports as version-zero shells, but keep them generation-ineligible
    -- until the teacher resolves a class. Every V1 command path supplies or
    -- inherits a version-one context.
    new.batch_id := null;
    new.worksheet_level := null;
    new.class_context_version := 0;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_practice_assignment_cycle_identity()
from public, anon, authenticated, service_role;

drop trigger if exists student_practice_assignments_cycle_identity_guard
on public.student_practice_assignments;
create trigger student_practice_assignments_cycle_identity_guard
before insert or update of
  resolution_cycle_id,
  resolution_cycle_number,
  evidence_cutoff_sequence,
  batch_id,
  worksheet_level,
  class_context_version
on public.student_practice_assignments
for each row execute function app_private.guard_practice_assignment_cycle_identity();

-- New evidence always records the released writing's exact class and level.
create or replace function app_private.capture_released_practice_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state <> 'released' then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.state = 'released' then
    return new;
  end if;

  insert into app_private.practice_weakness_evidence (
    source_kind,
    source_release_id,
    feedback_draft_id,
    submission_id,
    workspace_id,
    student_id,
    grammar_topic_id,
    batch_id,
    evidence_level,
    minor_issue_count,
    major_issue_count,
    released_at
  )
  select
    'feedback_draft',
    new.id,
    new.id,
    submission.id,
    submission.workspace_id,
    submission.student_id,
    topic.grammar_topic_id,
    batch.id,
    batch.level,
    case when topic.severity = 'minor' then topic.count else 0 end,
    case when topic.severity in ('major', 'mixed') then topic.count else 0 end,
    coalesce(new.released_at, now())
  from public.submissions submission
  join public.batches batch
    on batch.id = submission.batch_id
   and batch.workspace_id = submission.workspace_id
  join public.submission_grammar_topics topic
    on topic.submission_id = submission.id
  where submission.id = new.submission_id
    and submission.release_status = 'released'
    and batch.level in ('A1', 'A2', 'B1', 'B2')
    and topic.count > 0
  on conflict (source_kind, source_release_id, grammar_topic_id) do nothing;

  return new;
end;
$$;

revoke all on function app_private.capture_released_practice_evidence()
from public, anon, authenticated, service_role;

-- Approved worksheet reuse now uses the open cycle's frozen level. Current
-- memberships are deliberately absent from this function.
create or replace function app_private.select_practice_test_for_cycle(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid
)
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  with selected_context as (
    select cycle.worksheet_level
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = target_workspace_id
      and cycle.student_id = target_student_id
      and cycle.grammar_topic_id = target_grammar_topic_id
      and cycle.resolved_at is null
      and cycle.class_context_version = 1
    order by cycle.cycle_number desc
    limit 1
  )
  select worksheet.id
  from public.practice_tests worksheet
  cross join selected_context context
  where worksheet.workspace_id = target_workspace_id
    and worksheet.grammar_topic_id = target_grammar_topic_id
    and worksheet.level = context.worksheet_level
    and worksheet.visibility = 'workspace'
    and worksheet.teacher_reviewed = true
    and worksheet.quality_status = 'approved'
    and worksheet.difficulty in ('easy', 'medium')
    and exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = worksheet.id
    )
    and not exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = worksheet.id
        and question.answer_contract_version <> 1
    )
    and not exists (
      select 1
      from public.student_practice_assignments prior_assignment
      where prior_assignment.workspace_id = target_workspace_id
        and prior_assignment.student_id = target_student_id
        and prior_assignment.practice_test_id = worksheet.id
    )
  order by
    case worksheet.difficulty when 'easy' then 1 else 2 end,
    worksheet.created_at desc,
    worksheet.id
  limit 1;
$$;

revoke all on function app_private.select_practice_test_for_cycle(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

-- Service-only generation input contains the immutable assignment snapshot.
-- It no longer aggregates active class levels.
drop function if exists api.get_worksheet_generation_context(uuid);
create function api.get_worksheet_generation_context(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  workspace_id uuid,
  grammar_topic_id uuid,
  attached_practice_test_id uuid,
  assignment_status text,
  batch_id uuid,
  batch_name text,
  worksheet_level text,
  topic_name text,
  topic_slug text,
  topic_level text,
  topic_description text,
  reusable_practice_test_id uuid
)
language plpgsql
security invoker
set search_path = ''
stable
as $$
begin
  if current_user <> 'service_role' then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  return query
  with assignment_context as (
    select
      assignment.id,
      assignment.workspace_id,
      assignment.student_id,
      assignment.grammar_topic_id,
      assignment.practice_test_id,
      assignment.status,
      assignment.batch_id,
      batch.name as batch_name,
      assignment.worksheet_level,
      assignment.class_context_version,
      topic.name,
      topic.slug,
      topic.level,
      topic.description
    from public.student_practice_assignments assignment
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    left join public.batches batch
      on batch.id = assignment.batch_id
     and batch.workspace_id = assignment.workspace_id
    where assignment.id = target_assignment_id
  )
  select
    context.id,
    context.workspace_id,
    context.grammar_topic_id,
    context.practice_test_id,
    context.status,
    context.batch_id,
    context.batch_name,
    context.worksheet_level,
    context.name,
    context.slug,
    context.level,
    context.description,
    reusable.id
  from assignment_context context
  left join lateral (
    select worksheet.id
    from public.practice_tests worksheet
    where context.class_context_version = 1
      and worksheet.workspace_id = context.workspace_id
      and worksheet.grammar_topic_id = context.grammar_topic_id
      and worksheet.level = context.worksheet_level
      and worksheet.visibility = 'workspace'
      and worksheet.quality_status = 'approved'
      and worksheet.generation_source <> 'system_fallback'
      and (context.practice_test_id is null or worksheet.id = context.practice_test_id)
      and exists (
        select 1
        from public.practice_test_questions contract_question
        where contract_question.practice_test_id = worksheet.id
          and contract_question.answer_contract_version = 1
      )
      and not exists (
        select 1
        from public.practice_test_questions contract_question
        where contract_question.practice_test_id = worksheet.id
          and contract_question.answer_contract_version <> 1
      )
      and not exists (
        select 1
        from public.student_practice_assignments prior
        where prior.workspace_id = context.workspace_id
          and prior.student_id = context.student_id
          and prior.practice_test_id = worksheet.id
          and prior.id <> context.id
      )
    order by worksheet.created_at desc, worksheet.id
    limit 1
  ) reusable on true;
end;
$$;

revoke all on function api.get_worksheet_generation_context(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.get_worksheet_generation_context(uuid)
to service_role;

-- A teacher can recover only a historical active row whose class could not be
-- proven. The selected class must be active and must currently contain the
-- student; once set, the snapshot is immutable.
create or replace function public.list_practice_class_context_options_internal(
  target_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  selected_assignment public.student_practice_assignments%rowtype;
  options jsonb := '[]'::jsonb;
begin
  if (select auth.uid()) is null then
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
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'batch_id', batch.id,
        'batch_name', batch.name,
        'worksheet_level', batch.level
      ) order by batch.name, batch.id
    ),
    '[]'::jsonb
  )
  into options
  from public.batch_students membership
  join public.batches batch
    on batch.id = membership.batch_id
   and batch.workspace_id = membership.workspace_id
  where membership.workspace_id = selected_assignment.workspace_id
    and membership.student_id = selected_assignment.student_id
    and batch.is_active
    and batch.level in ('A1', 'A2', 'B1', 'B2');

  return jsonb_build_object(
    'schema_version', 1,
    'assignment_id', selected_assignment.id,
    'items', options
  );
end;
$$;

create or replace function public.resolve_practice_assignment_class_context_internal(
  target_assignment_id uuid,
  target_batch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  selected_batch public.batches%rowtype;
  next_generation_status text;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_assignment_id is null or target_batch_id is null then
    raise exception using errcode = '22023', message = 'practice_class_context_required';
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
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  if selected_assignment.status <> 'unlocked'
    or selected_assignment.practice_test_id is not null
    or selected_assignment.latest_attempt_id is not null
  then
    raise exception using errcode = '55000', message = 'practice_assignment_inactive';
  end if;

  select batch.*
  into selected_batch
  from public.batches batch
  join public.batch_students membership
    on membership.workspace_id = batch.workspace_id
   and membership.batch_id = batch.id
   and membership.student_id = selected_assignment.student_id
  where batch.id = target_batch_id
    and batch.workspace_id = selected_assignment.workspace_id
    and batch.is_active
    and batch.level in ('A1', 'A2', 'B1', 'B2')
  for share of batch, membership;

  if selected_batch.id is null then
    raise exception using errcode = '42501', message = 'student_class_assignment_required';
  end if;

  if selected_assignment.class_context_version = 1 then
    if selected_assignment.batch_id <> selected_batch.id then
      raise exception using errcode = '55000', message = 'practice_class_context_immutable';
    end if;
  else
    if selected_assignment.resolution_cycle_id is not null then
      update app_private.practice_resolution_cycles cycle
      set
        batch_id = selected_batch.id,
        worksheet_level = selected_batch.level,
        class_context_version = 1,
        state_reason = 'teacher_class_context_resolved'
      where cycle.id = selected_assignment.resolution_cycle_id
        and cycle.resolved_at is null
        and cycle.class_context_version = 0;

      if not found then
        raise exception using errcode = '55000', message = 'practice_cycle_context_unavailable';
      end if;
    end if;

    next_generation_status := 'idle';

    update public.student_practice_assignments assignment
    set
      batch_id = selected_batch.id,
      worksheet_level = selected_batch.level,
      class_context_version = 1,
      generation_status = next_generation_status,
      generation_started_at = null,
      generation_completed_at = null,
      generation_error = null
    where assignment.id = selected_assignment.id;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'assignment_id', selected_assignment.id,
    'batch_id', selected_batch.id,
    'batch_name', selected_batch.name,
    'worksheet_level', selected_batch.level,
    'generation_status', 'idle'
  );
end;
$$;

revoke all on function public.list_practice_class_context_options_internal(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.resolve_practice_assignment_class_context_internal(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.list_practice_class_context_options_internal(uuid)
to authenticated;
grant execute on function public.resolve_practice_assignment_class_context_internal(uuid, uuid)
to authenticated;

create or replace function api.list_practice_class_context_options(
  target_assignment_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.list_practice_class_context_options_internal(target_assignment_id);
$$;

create or replace function api.resolve_practice_assignment_class_context(
  target_assignment_id uuid,
  target_batch_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.resolve_practice_assignment_class_context_internal(
    target_assignment_id,
    target_batch_id
  );
$$;

revoke all on function api.list_practice_class_context_options(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.resolve_practice_assignment_class_context(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function api.list_practice_class_context_options(uuid)
to authenticated;
grant execute on function api.resolve_practice_assignment_class_context(uuid, uuid)
to authenticated;

-- Refuse an ambiguous untouched shell before it can create a queue message.
-- Already attached historical worksheets take the earlier ready path and are
-- deliberately preserved.
do $phase_12g_patch_request_context$
declare
  function_definition text;
  original_fragment text := $old$
  if selected_assignment.generation_status = 'needs_review'
$old$;
  replacement_fragment text := $new$
  if selected_assignment.class_context_version <> 1
    or selected_assignment.batch_id is null
    or selected_assignment.worksheet_level is null
    or selected_assignment.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
  then
    raise exception using
      errcode = '55000',
      message = 'Practice assignment class context is required.';
  end if;

  if selected_assignment.generation_status = 'needs_review'
$new$;
begin
  select pg_get_functiondef(
    'public.request_practice_worksheet(uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(original_fragment in function_definition) = 0
    or length(function_definition) - length(replace(function_definition, original_fragment, ''))
      <> length(original_fragment)
  then
    raise exception using
      errcode = '55000',
      message = 'Worksheet request class-context patch precondition failed.';
  end if;

  execute replace(function_definition, original_fragment, replacement_fragment);
end;
$phase_12g_patch_request_context$;

-- The original completion function predates assignment snapshots and has one
-- isolated block that re-derives a level from active classes. Replace exactly
-- that reviewed block and fail migration replay if the upstream body changed.
do $phase_12g_patch_completion_level$
declare
  function_definition text;
  original_fragment text := $old$
  select gt.level
  into target_level
  from public.grammar_topics gt
  where gt.id = selected_assignment.grammar_topic_id;

  if target_level not in ('A1', 'A2', 'B1', 'B2') then
    select count(distinct b.level), min(b.level)
    into active_level_count, target_level
    from public.batch_students bs
    join public.batches b
      on b.id = bs.batch_id
     and b.workspace_id = bs.workspace_id
    where bs.workspace_id = selected_assignment.workspace_id
      and bs.student_id = selected_assignment.student_id
      and b.is_active;

    if active_level_count <> 1 then
      raise exception using errcode = '22023', message = 'Practice level context is ambiguous.';
    end if;
  end if;
$old$;
  replacement_fragment text := $new$
  target_level := selected_assignment.worksheet_level;

  if selected_assignment.class_context_version <> 1
    or selected_assignment.batch_id is null
    or target_level is null
    or target_level not in ('A1', 'A2', 'B1', 'B2')
  then
    raise exception using errcode = '22023', message = 'Practice assignment class context is required.';
  end if;
$new$;
begin
  select pg_get_functiondef(
    'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(original_fragment in function_definition) = 0
    or length(function_definition) - length(replace(function_definition, original_fragment, ''))
      <> length(original_fragment)
  then
    raise exception using
      errcode = '55000',
      message = 'Worksheet completion level patch precondition failed.';
  end if;

  execute replace(function_definition, original_fragment, replacement_fragment);
end;
$phase_12g_patch_completion_level$;

-- Extend the Phase 12F internal read model rather than replacing its exposed
-- wrapper. The canonical coherent-terminal predicate remains the sole source
-- of student score visibility; class metadata does not create another path.
create or replace function public.get_practice_assignment_summary_internal(
  target_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  selected_workspace_id uuid;
  selected_student_id uuid;
  caller_can_manage boolean := false;
  result jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_assignment_id is null then
    raise exception using errcode = '22023', message = 'assignment_required';
  end if;

  select assignment.workspace_id, assignment.student_id
  into selected_workspace_id, selected_student_id
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if selected_workspace_id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  caller_can_manage :=
    app_private.is_platform_admin()
    or app_private.has_workspace_role(
      selected_workspace_id,
      array['owner', 'teacher']
    );

  if actor_id = selected_student_id and not caller_can_manage then
    if not exists (
      select 1 from public.workspace_members membership
      where membership.workspace_id = selected_workspace_id
        and membership.user_id = actor_id
        and membership.role = 'student'
    ) then
      raise exception using errcode = '42501', message = 'active_membership_required';
    end if;
  elsif not caller_can_manage then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  select jsonb_build_object(
    'id', assignment.id,
    'workspace_id', assignment.workspace_id,
    'student_id', assignment.student_id,
    'grammar_topic_id', assignment.grammar_topic_id,
    'grammar_topic_name', topic.name,
    'grammar_topic_slug', topic.slug,
    'grammar_topic_description', topic.description,
    'batch_id', assignment.batch_id,
    'batch_name', batch.name,
    'class_context_version', assignment.class_context_version,
    'practice_test_id', assignment.practice_test_id,
    'worksheet_title', worksheet.title,
    'worksheet_level', coalesce(assignment.worksheet_level, worksheet.level),
    'worksheet_difficulty', worksheet.difficulty,
    'worksheet_mini_lesson', worksheet.mini_lesson,
    'status', assignment.status,
    'source', assignment.source,
    'assigned_at', assignment.assigned_at,
    'started_at', assignment.started_at,
    'completed_at', assignment.completed_at,
    'latest_attempt_id', assignment.latest_attempt_id,
    'latest_attempt_status', attempt.status
  ) || jsonb_build_object(
    'score', case when visibility.result_visible then attempt.score else null end,
    'max_score', case when visibility.result_visible then attempt.max_score else null end,
    'score_points', case
      when visibility.result_visible then attempt.score_points
      else null
    end,
    'max_score_points', case
      when visibility.result_visible then attempt.max_score_points
      else null
    end,
    'scoring_version', case
      when visibility.result_visible then attempt.scoring_version
      else null
    end,
    'evaluation_status', attempt.evaluation_status,
    'evaluation_started_at', attempt.evaluation_started_at,
    'evaluation_completed_at', attempt.evaluation_completed_at,
    'evaluation_error', case
      when caller_can_manage then attempt.evaluation_error
      when attempt.evaluation_status = 'failed' then 'evaluation_failed'
      else null
    end,
    'score_percent', case
      when visibility.result_visible then attempt.score_percent
      else null
    end,
    'passed', case when visibility.result_visible then attempt.passed else null end,
    'question_count', question_stats.question_count,
    'generation_status', assignment.generation_status,
    'generation_started_at', assignment.generation_started_at,
    'generation_completed_at', assignment.generation_completed_at,
    'generation_error', case
      when assignment.generation_error is null then null
      else 'generation_failed'
    end,
    'previous_assignment_id', assignment.previous_assignment_id,
    'previous_attempt_id', assignment.previous_attempt_id,
    'repeat_number', assignment.repeat_number,
    'adaptive_reason', assignment.adaptive_reason,
    'adaptive_status', assignment.adaptive_status,
    'resolution_cycle_id', assignment.resolution_cycle_id,
    'resolution_cycle_number', assignment.resolution_cycle_number,
    'evidence_cutoff_sequence', assignment.evidence_cutoff_sequence,
    'student_name', coalesce(profile.full_name, profile.email),
    'student_email', profile.email
  )
  into result
  from public.student_practice_assignments assignment
  join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
  join public.profiles profile on profile.id = assignment.student_id
  left join public.batches batch
    on batch.id = assignment.batch_id
   and batch.workspace_id = assignment.workspace_id
  left join public.practice_tests worksheet
    on worksheet.id = assignment.practice_test_id
  left join public.practice_test_attempts attempt
    on attempt.id = assignment.latest_attempt_id
    and attempt.assignment_id = assignment.id
    and attempt.workspace_id = assignment.workspace_id
    and attempt.student_id = assignment.student_id
    and attempt.practice_test_id = assignment.practice_test_id
  left join lateral (
    select
      count(*)::integer as question_count,
      count(*) filter (
        where not app_private.is_practice_question_locally_scorable(
          question.question_type,
          question.correct_answer,
          question.evaluation_mode,
          question.accepted_answers
        )
      )::integer as semantic_question_count
    from public.practice_test_questions question
    where question.practice_test_id = assignment.practice_test_id
  ) question_stats on true
  cross join lateral (
    select
      caller_can_manage
      or app_private.practice_attempt_result_is_terminal(
        assignment.status,
        attempt.status,
        attempt.evaluation_status,
        attempt.evaluation_completed_at,
        attempt.evaluation_error,
        attempt.score,
        attempt.max_score,
        attempt.score_points,
        attempt.max_score_points,
        attempt.scoring_version,
        attempt.score_percent,
        attempt.passed,
        question_stats.semantic_question_count
      ) as result_visible
  ) visibility
  where assignment.id = target_assignment_id;

  if result is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  return result;
end;
$$;

revoke all on function public.get_practice_assignment_summary_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_practice_assignment_summary_internal(uuid)
to authenticated, service_role;

comment on function public.get_practice_assignment_summary_internal(uuid) is
  'Actor-authorized practice summary with canonical terminal score visibility and immutable class context metadata.';

-- Let the existing teacher queue distinguish a missing class snapshot from a
-- provider failure without changing its public row shape.
do $phase_12g_patch_review_queue_error$
declare
  function_definition text;
  original_fragment text := $old$
      'worksheet_generation_failed'::text as error_code,
$old$;
  replacement_fragment text := $new$
      case
        when assignment.generation_error = 'worksheet_class_context_required'
          then 'worksheet_class_context_required'
        else 'worksheet_generation_failed'
      end::text as error_code,
$new$;
begin
  select pg_get_functiondef(
    'public.practice_review_queue_rows_internal(uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(original_fragment in function_definition) = 0
    or length(function_definition) - length(replace(function_definition, original_fragment, ''))
      <> length(original_fragment)
  then
    raise exception using
      errcode = '55000',
      message = 'Practice review queue patch precondition failed.';
  end if;

  execute replace(function_definition, original_fragment, replacement_fragment);
end;
$phase_12g_patch_review_queue_error$;

comment on function api.get_worksheet_generation_context(uuid) is
  'Service-only worksheet input using the immutable class and CEFR snapshot captured from released writing evidence.';
comment on function api.list_practice_class_context_options(uuid) is
  'Teacher-only active class choices for recovering an ambiguous historical practice assignment.';
comment on function api.resolve_practice_assignment_class_context(uuid, uuid) is
  'Teacher-only one-time recovery of a missing historical class and CEFR snapshot.';

notify pgrst, 'reload schema';
