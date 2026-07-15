-- Phase 11W: validated security and paid-work controls.
--
-- This migration closes findings that survived the multi-pass security review:
-- active-membership draft reads, disclosed worksheet reuse, unbounded manual
-- AI requeues, unbounded adaptive failure loops, retained kick buckets, and
-- oversized teacher-edited feedback. Queue payloads remain identifier-only.

-- ---------------------------------------------------------------------------
-- Offboarding immediately revokes resumable-draft reads
-- ---------------------------------------------------------------------------

create or replace function public.get_writing_draft_internal(
  target_draft_id uuid
)
returns table (
  draft_id uuid,
  workspace_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  "text" text,
  revision integer,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    draft.id,
    draft.workspace_id,
    draft.batch_id,
    draft.source_type,
    draft.source_id,
    draft.content,
    draft.revision,
    draft.updated_at
  from app_private.writing_drafts draft
  where draft.id = target_draft_id
    and draft.student_id = (select auth.uid())
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = draft.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
    and exists (
      select 1
      from public.batch_students enrollment
      join public.batches batch
        on batch.id = enrollment.batch_id
       and batch.workspace_id = enrollment.workspace_id
       and batch.is_active = true
      where enrollment.workspace_id = draft.workspace_id
        and enrollment.batch_id = draft.batch_id
        and enrollment.student_id = (select auth.uid())
    );
$$;

revoke all on function public.get_writing_draft_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_writing_draft_internal(uuid)
to authenticated;

create or replace function public.list_my_writing_drafts_internal(
  target_workspace_id uuid,
  page_size integer default 25
)
returns table (
  draft_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  preview text,
  character_count integer,
  revision integer,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    draft.id,
    draft.batch_id,
    draft.source_type,
    draft.source_id,
    left(regexp_replace(draft.content, '[[:space:]]+', ' ', 'g'), 160),
    char_length(draft.content),
    draft.revision,
    draft.updated_at
  from app_private.writing_drafts draft
  where draft.student_id = (select auth.uid())
    and draft.workspace_id = target_workspace_id
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = draft.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
    and exists (
      select 1
      from public.batch_students enrollment
      join public.batches batch
        on batch.id = enrollment.batch_id
       and batch.workspace_id = enrollment.workspace_id
       and batch.is_active = true
      where enrollment.workspace_id = draft.workspace_id
        and enrollment.batch_id = draft.batch_id
        and enrollment.student_id = (select auth.uid())
    )
  order by draft.updated_at desc, draft.id desc
  limit greatest(1, least(coalesce(page_size, 25), 100));
$$;

revoke all on function public.list_my_writing_drafts_internal(uuid, integer)
from public, anon, authenticated, service_role;
grant execute on function public.list_my_writing_drafts_internal(uuid, integer)
to authenticated;

-- ---------------------------------------------------------------------------
-- A scored worksheet is never reused after its answers were disclosed
-- ---------------------------------------------------------------------------

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
  with selected_level as (
    select coalesce(
      case when topic.level in ('A1', 'A2', 'B1', 'B2') then topic.level end,
      (
        select batch.level
        from public.batch_students membership
        join public.batches batch
          on batch.id = membership.batch_id
         and batch.workspace_id = membership.workspace_id
        where membership.workspace_id = target_workspace_id
          and membership.student_id = target_student_id
          and batch.is_active = true
        order by membership.created_at desc, membership.id desc
        limit 1
      ),
      'A2'
    ) as level
    from public.grammar_topics topic
    where topic.id = target_grammar_topic_id
  )
  select worksheet.id
  from public.practice_tests worksheet
  cross join selected_level
  where worksheet.workspace_id = target_workspace_id
    and worksheet.grammar_topic_id = target_grammar_topic_id
    and worksheet.level = selected_level.level
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

-- ---------------------------------------------------------------------------
-- Bound corrected feedback before it reaches any browser diff renderer
-- ---------------------------------------------------------------------------

create or replace function app_private.validate_feedback_draft_size()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  feedback_lines jsonb := coalesce(new.content -> 'lines', '[]'::jsonb);
  corrected_character_count bigint;
begin
  if jsonb_typeof(feedback_lines) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'feedback_corrected_text_limit_exceeded';
  end if;

  if jsonb_array_length(feedback_lines) > 500
    or char_length(coalesce(new.content ->> 'corrected_text', '')) not between 1 and 12000
    or exists (
      select 1
      from jsonb_array_elements(feedback_lines) line_item
      where char_length(coalesce(line_item ->> 'corrected_line', '')) > 12000
    )
  then
    raise exception using
      errcode = '22023',
      message = 'feedback_corrected_text_limit_exceeded';
  end if;

  select coalesce(sum(char_length(coalesce(line_item ->> 'corrected_line', ''))), 0)
  into corrected_character_count
  from jsonb_array_elements(feedback_lines) line_item;

  if corrected_character_count > 12000 then
    raise exception using
      errcode = '22023',
      message = 'feedback_corrected_text_limit_exceeded';
  end if;

  return new;
end;
$$;

revoke all on function app_private.validate_feedback_draft_size()
from public, anon, authenticated, service_role;

drop trigger if exists feedback_drafts_00_validate_size
on app_private.feedback_drafts;
create trigger feedback_drafts_00_validate_size
before insert or update of content on app_private.feedback_drafts
for each row execute function app_private.validate_feedback_draft_size();

-- ---------------------------------------------------------------------------
-- Transactional paid-work budgets and bounded entity requeues
-- ---------------------------------------------------------------------------

create table app_private.ai_paid_work_limits (
  singleton boolean primary key default true check (singleton),
  max_writing_jobs_per_student_workspace_day smallint not null default 60
    check (max_writing_jobs_per_student_workspace_day between 1 and 300),
  max_writing_jobs_per_workspace_day integer not null default 1500
    check (max_writing_jobs_per_workspace_day between 1 and 100000),
  max_generation_jobs_per_student_workspace_day smallint not null default 8
    check (max_generation_jobs_per_student_workspace_day between 1 and 100),
  max_generation_jobs_per_workspace_day integer not null default 300
    check (max_generation_jobs_per_workspace_day between 1 and 10000),
  max_semantic_jobs_per_student_workspace_day smallint not null default 12
    check (max_semantic_jobs_per_student_workspace_day between 1 and 200),
  max_semantic_jobs_per_workspace_day integer not null default 600
    check (max_semantic_jobs_per_workspace_day between 1 and 20000),
  max_manual_writing_requeues_per_submission smallint not null default 2
    check (max_manual_writing_requeues_per_submission between 0 and 10),
  max_manual_generation_requeues_per_assignment smallint not null default 1
    check (max_manual_generation_requeues_per_assignment between 0 and 5),
  max_manual_semantic_requeues_per_attempt smallint not null default 2
    check (max_manual_semantic_requeues_per_attempt between 0 and 10),
  max_failed_assignments_per_resolution_cycle smallint not null default 3
    check (max_failed_assignments_per_resolution_cycle between 1 and 10),
  updated_at timestamptz not null default now()
);

insert into app_private.ai_paid_work_limits (singleton)
values (true)
on conflict (singleton) do nothing;

create table app_private.ai_workspace_daily_usage (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  usage_day date not null,
  writing_job_count integer not null default 0 check (writing_job_count >= 0),
  generation_job_count integer not null default 0 check (generation_job_count >= 0),
  semantic_job_count integer not null default 0 check (semantic_job_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, usage_day)
);

create table app_private.ai_student_daily_usage (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  usage_day date not null,
  writing_job_count integer not null default 0 check (writing_job_count >= 0),
  generation_job_count integer not null default 0 check (generation_job_count >= 0),
  semantic_job_count integer not null default 0 check (semantic_job_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, student_id, usage_day)
);

create index ai_workspace_daily_usage_retention_idx
on app_private.ai_workspace_daily_usage (usage_day);
create index ai_student_daily_usage_retention_idx
on app_private.ai_student_daily_usage (usage_day);
create index ai_student_daily_usage_student_fk_idx
on app_private.ai_student_daily_usage (student_id);

alter table app_private.ai_paid_work_limits enable row level security;
alter table app_private.ai_workspace_daily_usage enable row level security;
alter table app_private.ai_student_daily_usage enable row level security;

revoke all on table app_private.ai_paid_work_limits
from public, anon, authenticated, service_role;
revoke all on table app_private.ai_workspace_daily_usage
from public, anon, authenticated, service_role;
revoke all on table app_private.ai_student_daily_usage
from public, anon, authenticated, service_role;

create or replace function app_private.consume_ai_paid_work_budget(
  target_job_kind text,
  target_entity_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_limits app_private.ai_paid_work_limits%rowtype;
  selected_workspace_id uuid;
  selected_student_id uuid;
  existing_job_count integer;
  current_usage_day date := (now() at time zone 'UTC')::date;
  workspace_consumed integer;
  student_consumed integer;
  writing_increment integer := 0;
  generation_increment integer := 0;
  semantic_increment integer := 0;
begin
  if target_job_kind = 'writing_evaluation' then
    select submission.workspace_id, submission.student_id
    into selected_workspace_id, selected_student_id
    from public.submissions submission
    where submission.id = target_entity_id;
    writing_increment := 1;
  elsif target_job_kind = 'worksheet_generation' then
    select assignment.workspace_id, assignment.student_id
    into selected_workspace_id, selected_student_id
    from public.student_practice_assignments assignment
    where assignment.id = target_entity_id;
    generation_increment := 1;
  elsif target_job_kind = 'worksheet_answer_evaluation' then
    select attempt.workspace_id, attempt.student_id
    into selected_workspace_id, selected_student_id
    from public.practice_test_attempts attempt
    where attempt.id = target_entity_id;
    semantic_increment := 1;
  else
    raise exception using errcode = '22023', message = 'unsupported_paid_job_kind';
  end if;

  if selected_workspace_id is null or selected_student_id is null then
    raise exception using errcode = '55000', message = 'paid_job_context_not_found';
  end if;

  select limits.*
  into selected_limits
  from app_private.ai_paid_work_limits limits
  where limits.singleton;

  if selected_limits.singleton is null then
    raise exception using errcode = '55000', message = 'ai_paid_work_limits_unavailable';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(concat_ws(':', 'paid-job-entity', target_job_kind, target_entity_id), 0)
  );

  select count(*)::integer
  into existing_job_count
  from app_private.async_jobs job
  where job.job_kind = target_job_kind
    and job.entity_id = target_entity_id;

  if target_job_kind = 'writing_evaluation'
    and existing_job_count >= 1 + selected_limits.max_manual_writing_requeues_per_submission
  then
    raise exception using errcode = '54000', message = 'writing_manual_retry_limit_exceeded';
  elsif target_job_kind = 'worksheet_generation'
    and existing_job_count >= 1 + selected_limits.max_manual_generation_requeues_per_assignment
  then
    raise exception using errcode = '54000', message = 'worksheet_generation_retry_limit_exceeded';
  elsif target_job_kind = 'worksheet_answer_evaluation'
    and existing_job_count >= 1 + selected_limits.max_manual_semantic_requeues_per_attempt
  then
    raise exception using errcode = '54000', message = 'practice_manual_retry_limit_exceeded';
  end if;

  -- These compact operational counters retain 35 UTC days. Cleanup uses the
  -- day-first indexes and runs in the same transaction as the next paid job.
  delete from app_private.ai_workspace_daily_usage usage
  where usage.usage_day < current_usage_day - 35;
  delete from app_private.ai_student_daily_usage usage
  where usage.usage_day < current_usage_day - 35;

  insert into app_private.ai_workspace_daily_usage as usage (
    workspace_id,
    usage_day,
    writing_job_count,
    generation_job_count,
    semantic_job_count
  ) values (
    selected_workspace_id,
    current_usage_day,
    writing_increment,
    generation_increment,
    semantic_increment
  )
  on conflict (workspace_id, usage_day) do update
  set
    writing_job_count = usage.writing_job_count + excluded.writing_job_count,
    generation_job_count = usage.generation_job_count + excluded.generation_job_count,
    semantic_job_count = usage.semantic_job_count + excluded.semantic_job_count,
    updated_at = now()
  where
    (excluded.writing_job_count = 0
      or usage.writing_job_count < selected_limits.max_writing_jobs_per_workspace_day)
    and (excluded.generation_job_count = 0
      or usage.generation_job_count < selected_limits.max_generation_jobs_per_workspace_day)
    and (excluded.semantic_job_count = 0
      or usage.semantic_job_count < selected_limits.max_semantic_jobs_per_workspace_day)
  returning 1 into workspace_consumed;

  if workspace_consumed is null then
    raise exception using errcode = '54000', message = 'workspace_ai_daily_budget_exceeded';
  end if;

  insert into app_private.ai_student_daily_usage as usage (
    workspace_id,
    student_id,
    usage_day,
    writing_job_count,
    generation_job_count,
    semantic_job_count
  ) values (
    selected_workspace_id,
    selected_student_id,
    current_usage_day,
    writing_increment,
    generation_increment,
    semantic_increment
  )
  on conflict (workspace_id, student_id, usage_day) do update
  set
    writing_job_count = usage.writing_job_count + excluded.writing_job_count,
    generation_job_count = usage.generation_job_count + excluded.generation_job_count,
    semantic_job_count = usage.semantic_job_count + excluded.semantic_job_count,
    updated_at = now()
  where
    (excluded.writing_job_count = 0
      or usage.writing_job_count < selected_limits.max_writing_jobs_per_student_workspace_day)
    and (excluded.generation_job_count = 0
      or usage.generation_job_count < selected_limits.max_generation_jobs_per_student_workspace_day)
    and (excluded.semantic_job_count = 0
      or usage.semantic_job_count < selected_limits.max_semantic_jobs_per_student_workspace_day)
  returning 1 into student_consumed;

  if student_consumed is null then
    raise exception using errcode = '54000', message = 'student_ai_daily_budget_exceeded';
  end if;
end;
$$;

revoke all on function app_private.consume_ai_paid_work_budget(text, uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.enqueue_async_job(
  target_job_kind text,
  target_entity_id uuid,
  target_entity_version integer,
  target_idempotency_key text,
  target_requested_by uuid default null,
  delay_seconds integer default 0
)
returns table (job_id uuid, queue_message_id bigint, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_queue_name text := app_private.queue_name_for_kind(target_job_kind);
  selected_job app_private.async_jobs%rowtype;
  selected_message_id bigint;
begin
  if selected_queue_name is null then
    raise exception using errcode = '22023', message = 'Unsupported job kind.';
  end if;

  if target_entity_id is null or target_entity_version is null or target_entity_version < 1 then
    raise exception using errcode = '22023', message = 'Invalid job entity.';
  end if;

  if target_idempotency_key is null or length(target_idempotency_key) not between 1 and 240 then
    raise exception using errcode = '22023', message = 'Invalid idempotency key.';
  end if;

  delay_seconds := greatest(0, least(coalesce(delay_seconds, 0), 86400));

  -- The lock makes the idempotency check and quota consumption one operation.
  -- A duplicate request returns the existing job without consuming budget.
  perform pg_advisory_xact_lock(
    hashtextextended('async-job-idempotency:' || target_idempotency_key, 0)
  );

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.idempotency_key = target_idempotency_key;

  if selected_job.id is not null then
    return query
    select selected_job.id, selected_job.queue_message_id, false;
    return;
  end if;

  perform app_private.consume_ai_paid_work_budget(
    target_job_kind,
    target_entity_id
  );

  insert into app_private.async_jobs (
    queue_name,
    job_kind,
    entity_id,
    entity_version,
    idempotency_key,
    status,
    available_at,
    requested_by
  ) values (
    selected_queue_name,
    target_job_kind,
    target_entity_id,
    target_entity_version,
    target_idempotency_key,
    'queued',
    now() + make_interval(secs => delay_seconds),
    target_requested_by
  )
  returning * into selected_job;

  select sent.send
  into selected_message_id
  from pgmq.send(
    selected_queue_name,
    jsonb_build_object(
      'job_id', selected_job.id,
      'job_kind', selected_job.job_kind,
      'entity_id', selected_job.entity_id,
      'entity_version', selected_job.entity_version
    ),
    delay_seconds
  ) sent;

  update app_private.async_jobs job
  set queue_message_id = selected_message_id
  where job.id = selected_job.id;

  return query select selected_job.id, selected_message_id, true;
end;
$$;

revoke all on function app_private.enqueue_async_job(text, uuid, integer, text, uuid, integer)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Stop automatic paid loops after repeated failed practice assignments
-- ---------------------------------------------------------------------------

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

create or replace function app_private.on_practice_assignment_cycle_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  event_type text;
  failed_assignment_count integer := 0;
  max_failed_assignments integer := 3;
  next_state text;
  next_reason text;
begin
  if new.resolution_cycle_id is null
    or new.status is not distinct from old.status
  then
    return new;
  end if;

  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.id = new.resolution_cycle_id
  for update;

  if selected_cycle.id is null or selected_cycle.resolved_at is not null then
    return new;
  end if;

  if new.status in ('in_progress', 'completed') then
    update app_private.practice_resolution_cycles cycle
    set
      active_assignment_id = new.id,
      state = 'in_progress',
      state_reason = case new.status
        when 'completed' then 'feedback_evaluation_pending'
        else 'worksheet_in_progress'
      end
    where cycle.id = selected_cycle.id;

    perform app_private.record_practice_cycle_event(
      selected_cycle.id,
      'assignment_started',
      selected_cycle.state,
      'in_progress',
      new.id,
      new.latest_attempt_id,
      jsonb_build_object('assignment_status', new.status)
    );
  elsif new.status = 'passed' then
    perform app_private.resolve_practice_cycle_internal(new.id, new.latest_attempt_id);
  elsif new.status in ('failed', 'cancelled') then
    event_type := case new.status
      when 'failed' then 'assignment_failed'
      else 'assignment_cancelled'
    end;

    if new.status = 'failed' then
      select limits.max_failed_assignments_per_resolution_cycle
      into max_failed_assignments
      from app_private.ai_paid_work_limits limits
      where limits.singleton;

      select count(*)::integer
      into failed_assignment_count
      from public.student_practice_assignments assignment
      where assignment.resolution_cycle_id = selected_cycle.id
        and assignment.status = 'failed';
    end if;

    next_state := case
      when new.status = 'failed'
        and failed_assignment_count >= coalesce(max_failed_assignments, 3)
      then 'locked'
      else 'unlocked'
    end;
    next_reason := case
      when next_state = 'locked' then 'teacher_support_required'
      when new.status = 'failed' then 'retry_after_failed_assignment'
      else 'replacement_assignment_required'
    end;

    update app_private.practice_resolution_cycles cycle
    set
      active_assignment_id = null,
      state = next_state,
      state_reason = next_reason
    where cycle.id = selected_cycle.id;

    perform app_private.record_practice_cycle_event(
      selected_cycle.id,
      event_type,
      selected_cycle.state,
      next_state,
      new.id,
      new.latest_attempt_id,
      jsonb_build_object(
        'failed_assignment_count', failed_assignment_count,
        'teacher_support_required', next_state = 'locked'
      )
    );

    -- Offboarding cancels assignments before deleting membership. Never create
    -- a replacement from a cancelled transition while that transaction is
    -- still in progress; re-enrollment can reconcile the preserved cycle.
    if next_state = 'unlocked' and new.status = 'failed' then
      perform app_private.reconcile_practice_topic_internal(
        new.workspace_id,
        new.student_id,
        new.grammar_topic_id
      );
    end if;
  end if;

  perform app_private.sync_practice_topic_stats_internal(
    new.workspace_id,
    new.student_id,
    new.grammar_topic_id
  );

  return new;
end;
$$;

revoke all on function app_private.on_practice_assignment_cycle_transition()
from public, anon, authenticated, service_role;

-- A teacher reassignment is the explicit escape hatch from a three-failure
-- hold. Attach that replacement to the preserved resolution cycle, unlock it,
-- and let the existing reconciliation logic maintain the one-active invariant.
create or replace function app_private.on_teacher_practice_reassignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  previous_assignment public.student_practice_assignments%rowtype;
begin
  if new.source <> 'teacher_assigned'
    or new.previous_assignment_id is null
    or new.resolution_cycle_id is not null
    or new.status <> 'unlocked'
  then
    return new;
  end if;

  select assignment.*
  into previous_assignment
  from public.student_practice_assignments assignment
  where assignment.id = new.previous_assignment_id;

  if previous_assignment.resolution_cycle_id is null then
    return new;
  end if;

  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.id = previous_assignment.resolution_cycle_id
    and cycle.resolved_at is null
    and cycle.state = 'locked'
  for update;

  if selected_cycle.id is null then
    return new;
  end if;

  update public.student_practice_assignments assignment
  set
    resolution_cycle_id = selected_cycle.id,
    resolution_cycle_number = selected_cycle.cycle_number,
    evidence_cutoff_sequence = selected_cycle.evidence_through_sequence
  where assignment.id = new.id;

  update app_private.practice_resolution_cycles cycle
  set
    active_assignment_id = new.id,
    state = 'unlocked',
    state_reason = 'teacher_reassignment_ready'
  where cycle.id = selected_cycle.id;

  perform app_private.record_practice_cycle_event(
    selected_cycle.id,
    'assignment_created',
    'locked',
    'unlocked',
    new.id,
    null,
    jsonb_build_object('source', 'teacher_assigned')
  );

  perform app_private.sync_practice_topic_stats_internal(
    new.workspace_id,
    new.student_id,
    new.grammar_topic_id
  );

  return new;
end;
$$;

revoke all on function app_private.on_teacher_practice_reassignment()
from public, anon, authenticated, service_role;

drop trigger if exists student_practice_assignments_teacher_reassignment
on public.student_practice_assignments;
create trigger student_practice_assignments_teacher_reassignment
after insert on public.student_practice_assignments
for each row execute function app_private.on_teacher_practice_reassignment();

-- ---------------------------------------------------------------------------
-- Kick-window retention remains bounded even for dormant one-time users
-- ---------------------------------------------------------------------------

create index if not exists writing_processor_kick_windows_cleanup_idx
on app_private.writing_processor_kick_windows (window_started_at);

create index if not exists async_jobs_pending_writing_authorization_idx
on app_private.async_jobs (job_kind, entity_id, entity_version)
where status in ('queued', 'retry');

create or replace function public.authorize_writing_processor_kick_internal(
  target_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  kick_limit integer;
  current_window timestamptz := date_trunc('minute', now());
  retention_floor timestamptz := current_window - interval '15 minutes';
  consumed_count integer;
begin
  perform app_private.assert_service_role();

  if target_user_id is null or not exists (
    select 1
    from public.profiles profile
    where profile.id = target_user_id
      and (
        profile.global_role = 'platform_admin'
        or exists (
          select 1
          from public.workspace_members membership
          where membership.user_id = target_user_id
            and membership.role in ('owner', 'teacher', 'student')
        )
      )
  ) then
    return 'inactive_user';
  end if;

  -- A verified member may wake the worker only when there is a queued writing
  -- job in a workspace they can currently access. This prevents authenticated
  -- empty global polls while preserving teacher-initiated retries.
  if not exists (
    select 1
    from app_private.async_jobs job
    join public.submissions submission
      on submission.id = job.entity_id
     and submission.evaluation_version = job.entity_version
    where job.job_kind = 'writing_evaluation'
      and job.status in ('queued', 'retry')
      and job.available_at <= now()
      and (
        (
          submission.student_id = target_user_id
          and exists (
            select 1
            from public.workspace_members membership
            where membership.workspace_id = submission.workspace_id
              and membership.user_id = target_user_id
              and membership.role = 'student'
          )
        )
        or exists (
          select 1
          from public.workspace_members membership
          where membership.workspace_id = submission.workspace_id
            and membership.user_id = target_user_id
            and membership.role in ('owner', 'teacher')
        )
        or exists (
          select 1
          from public.profiles profile
          where profile.id = target_user_id
            and profile.global_role = 'platform_admin'
        )
      )
  ) then
    return 'no_pending_work';
  end if;

  select limits.max_authenticated_kicks_per_minute
  into kick_limit
  from app_private.writing_security_limits limits
  where limits.singleton;

  if kick_limit is null then
    return 'unavailable';
  end if;

  delete from app_private.writing_processor_kick_windows usage_window
  where usage_window.window_started_at < retention_floor;

  insert into app_private.writing_processor_kick_windows (
    user_id,
    window_started_at,
    kick_count
  ) values (
    target_user_id,
    current_window,
    1
  )
  on conflict (user_id, window_started_at) do update
  set kick_count = app_private.writing_processor_kick_windows.kick_count + 1,
      updated_at = now()
  where app_private.writing_processor_kick_windows.kick_count < kick_limit
  returning kick_count into consumed_count;

  if consumed_count is null then
    return 'rate_limited';
  end if;
  return 'allowed';
end;
$$;

revoke all on function public.authorize_writing_processor_kick_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.authorize_writing_processor_kick_internal(uuid)
to service_role;

comment on table app_private.ai_paid_work_limits is
  'Private V1 AI job-version reservations: bounded entity requeues, per-student/workspace UTC-day reservations, and a three-failure adaptive support hold. Provider-call telemetry is measured separately.';
comment on function app_private.select_practice_test_for_cycle(uuid, uuid, uuid) is
  'Selects an approved unseen scored worksheet; disclosed material is never reassigned.';

notify pgrst, 'reload schema';
