-- Phase 12T: bounded V1 launch-cost guardrails.
--
-- Historical submissions, jobs, and provider-outage evidence remain intact.
-- New monthly counters are backfilled from the existing transactional daily
-- counters and durable job ledger before the tighter limits become active.

-- ---------------------------------------------------------------------------
-- Evaluated-writing quotas: 3 per UTC day and 40 per UTC month.
-- ---------------------------------------------------------------------------

alter table app_private.writing_security_limits
  add column max_submissions_per_student_workspace_month smallint not null
    default 40;

alter table app_private.writing_security_limits
  add constraint writing_security_limits_monthly_submissions_check check (
    max_submissions_per_student_workspace_month between 1 and 500
  );

create table app_private.writing_submission_monthly_usage (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  usage_month date not null,
  submission_count integer not null default 0 check (submission_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, student_id, usage_month),
  constraint writing_submission_monthly_usage_month_start_check check (
    extract(day from usage_month) = 1
  )
);

insert into app_private.writing_submission_monthly_usage (
  workspace_id,
  student_id,
  usage_month,
  submission_count,
  updated_at
)
select
  usage.workspace_id,
  usage.student_id,
  date_trunc('month', usage.usage_day)::date,
  sum(usage.submission_count)::integer,
  max(usage.updated_at)
from app_private.writing_submission_daily_usage usage
group by
  usage.workspace_id,
  usage.student_id,
  date_trunc('month', usage.usage_day)::date;

alter table app_private.writing_submission_monthly_usage enable row level security;
revoke all on table app_private.writing_submission_monthly_usage
from public, anon, authenticated, service_role;

update app_private.writing_security_limits
set
  max_submissions_per_student_workspace_day = 3,
  max_submissions_per_student_workspace_month = 40,
  updated_at = now()
where singleton;

create or replace function app_private.consume_writing_submission_quota(
  target_workspace_id uuid,
  target_student_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  daily_limit integer;
  monthly_limit integer;
  consumed_daily_count integer;
  consumed_monthly_count integer;
  current_usage_day date := (now() at time zone 'UTC')::date;
  current_usage_month date :=
    date_trunc('month', now() at time zone 'UTC')::date;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_workspace_id is null
    or target_student_id is null
    or caller_id <> target_student_id
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;
  if not exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = target_student_id
      and membership.role = 'student'
  ) then
    raise exception using errcode = '42501', message = 'active_membership_required';
  end if;

  select
    limits.max_submissions_per_student_workspace_day,
    limits.max_submissions_per_student_workspace_month
  into daily_limit, monthly_limit
  from app_private.writing_security_limits limits
  where limits.singleton;

  if daily_limit is null or monthly_limit is null then
    raise exception using errcode = '55000', message = 'writing_quota_unavailable';
  end if;

  insert into app_private.writing_submission_daily_usage (
    workspace_id,
    student_id,
    usage_day,
    submission_count
  ) values (
    target_workspace_id,
    target_student_id,
    current_usage_day,
    1
  )
  on conflict (workspace_id, student_id, usage_day) do update
  set
    submission_count =
      app_private.writing_submission_daily_usage.submission_count + 1,
    updated_at = now()
  where app_private.writing_submission_daily_usage.submission_count < daily_limit
  returning submission_count into consumed_daily_count;

  if consumed_daily_count is null then
    raise exception using
      errcode = '54000',
      message = 'writing_daily_quota_exceeded';
  end if;

  insert into app_private.writing_submission_monthly_usage (
    workspace_id,
    student_id,
    usage_month,
    submission_count
  ) values (
    target_workspace_id,
    target_student_id,
    current_usage_month,
    1
  )
  on conflict (workspace_id, student_id, usage_month) do update
  set
    submission_count =
      app_private.writing_submission_monthly_usage.submission_count + 1,
    updated_at = now()
  where app_private.writing_submission_monthly_usage.submission_count
    < monthly_limit
  returning submission_count into consumed_monthly_count;

  if consumed_monthly_count is null then
    raise exception using
      errcode = '54000',
      message = 'writing_monthly_quota_exceeded';
  end if;

  return consumed_daily_count;
end;
$$;

revoke all on function app_private.consume_writing_submission_quota(uuid, uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Paid writing-job reservations: 5 per UTC day and 50 per UTC month.
-- ---------------------------------------------------------------------------

alter table app_private.ai_paid_work_limits
  add column max_writing_jobs_per_student_workspace_month smallint not null
    default 50;

alter table app_private.ai_paid_work_limits
  add constraint ai_paid_work_limits_writing_month_check check (
    max_writing_jobs_per_student_workspace_month between 1 and 1000
  );

create table app_private.ai_student_monthly_usage (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  usage_month date not null,
  writing_job_count integer not null default 0 check (writing_job_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, student_id, usage_month),
  constraint ai_student_monthly_usage_month_start_check check (
    extract(day from usage_month) = 1
  )
);

insert into app_private.ai_student_monthly_usage (
  workspace_id,
  student_id,
  usage_month,
  writing_job_count,
  updated_at
)
select
  submission.workspace_id,
  submission.student_id,
  date_trunc('month', job.created_at at time zone 'UTC')::date,
  count(*)::integer,
  max(job.updated_at)
from app_private.async_jobs job
join public.submissions submission
  on submission.id = job.entity_id
where job.job_kind = 'writing_evaluation'
group by
  submission.workspace_id,
  submission.student_id,
  date_trunc('month', job.created_at at time zone 'UTC')::date;

alter table app_private.ai_student_monthly_usage enable row level security;
revoke all on table app_private.ai_student_monthly_usage
from public, anon, authenticated, service_role;

update app_private.ai_paid_work_limits
set
  max_writing_jobs_per_student_workspace_day = 5,
  max_writing_jobs_per_student_workspace_month = 50,
  updated_at = now()
where singleton;

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
  current_usage_month date :=
    date_trunc('month', now() at time zone 'UTC')::date;
  workspace_consumed integer;
  student_consumed integer;
  monthly_student_consumed integer;
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
    hashtextextended(
      concat_ws(':', 'paid-job-entity', target_job_kind, target_entity_id),
      0
    )
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

  if writing_increment = 1 then
    insert into app_private.ai_student_monthly_usage as usage (
      workspace_id,
      student_id,
      usage_month,
      writing_job_count
    ) values (
      selected_workspace_id,
      selected_student_id,
      current_usage_month,
      1
    )
    on conflict (workspace_id, student_id, usage_month) do update
    set
      writing_job_count = usage.writing_job_count + 1,
      updated_at = now()
    where usage.writing_job_count
      < selected_limits.max_writing_jobs_per_student_workspace_month
    returning 1 into monthly_student_consumed;

    if monthly_student_consumed is null then
      raise exception using
        errcode = '54000',
        message = 'student_ai_monthly_budget_exceeded';
    end if;
  end if;
end;
$$;

revoke all on function app_private.consume_ai_paid_work_budget(text, uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Teacher-created writing-task prompts are bounded before persistence.
-- Existing longer tasks remain readable/editable until a teacher replaces them.
-- ---------------------------------------------------------------------------

create or replace function public.create_workspace_question_internal(
  target_workspace_id uuid,
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text,
  question_task_type text,
  question_expected_word_min integer default null,
  question_expected_word_max integer default null,
  question_estimated_minutes integer default null,
  question_is_active boolean default true
)
returns table (question_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if question_prompt is not null and length(btrim(question_prompt)) > 4000 then
    raise exception using errcode = '22023', message = 'teacher_task_prompt_too_long';
  end if;
  if question_level is null or question_task_type is null then
    raise exception using errcode = '22023', message = 'invalid_question';
  end if;

  return query
  select *
  from public.create_workspace_question_write_internal(
    target_workspace_id,
    question_title,
    question_prompt,
    question_level,
    question_topic,
    question_task_type,
    question_expected_word_min,
    question_expected_word_max,
    question_estimated_minutes,
    question_is_active
  );
end;
$$;

create or replace function public.update_workspace_question_internal(
  target_workspace_id uuid,
  target_question_id uuid,
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text,
  question_task_type text,
  question_expected_word_min integer default null,
  question_expected_word_max integer default null,
  question_estimated_minutes integer default null,
  question_is_active boolean default true
)
returns table (question_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if question_prompt is not null and length(btrim(question_prompt)) > 4000 then
    raise exception using errcode = '22023', message = 'teacher_task_prompt_too_long';
  end if;
  if question_level is null or question_task_type is null then
    raise exception using errcode = '22023', message = 'invalid_question';
  end if;

  return query
  select *
  from public.update_workspace_question_write_internal(
    target_workspace_id,
    target_question_id,
    question_title,
    question_prompt,
    question_level,
    question_topic,
    question_task_type,
    question_expected_word_min,
    question_expected_word_max,
    question_estimated_minutes,
    question_is_active
  );
end;
$$;

revoke all on function public.create_workspace_question_internal(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.update_workspace_question_internal(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.create_workspace_question_internal(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) to authenticated, service_role;
grant execute on function public.update_workspace_question_internal(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Dual-provider transport recovery: four dispatches inside the existing
-- 24-hour epoch. Historical rows/events with higher counts remain valid.
-- ---------------------------------------------------------------------------

create or replace function app_private.provider_outage_retry_delay_seconds(
  retry_number integer
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case retry_number
    when 1 then 60
    when 2 then 300
    when 3 then 900
    when 4 then 1800
  end
  where retry_number between 1 and 4;
$$;

revoke all on function app_private.provider_outage_retry_delay_seconds(integer)
from public, anon, authenticated, service_role;

create or replace function public.defer_async_job_for_provider_outage(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  outage_reason text
)
returns table (
  job_id uuid,
  status text,
  attempt_count integer,
  next_attempt_at timestamptz,
  outage_retry_count integer,
  outage_deadline_at timestamptz,
  outage_exhausted boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  safe_reason text := lower(btrim(coalesce(outage_reason, '')));
  selected_worker_id uuid := worker_id;
  epoch_started_at timestamptz;
  epoch_deadline_at timestamptz;
  scheduled_at timestamptz;
  next_retry_number integer;
  retry_delay integer;
  remaining_seconds integer;
  next_message_id bigint;
begin
  perform app_private.assert_service_role();

  if selected_worker_id is null then
    raise exception using errcode = '22023', message = 'Worker id is required.';
  end if;

  if safe_reason not in (
    'dual_provider_outage_unavailable',
    'dual_provider_outage_rate_limited',
    'dual_provider_outage_timeout'
  ) then
    raise exception using
      errcode = '22023',
      message = 'provider_outage_classification_invalid';
  end if;

  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.id = target_job_id
  for update;

  if selected_job.id is null then
    raise exception using errcode = '02000', message = 'Job not found.';
  end if;

  -- A lost HTTP response may replay the transition. Counts above four can only
  -- be historical rows created before this guardrail and are exhausted below.
  if selected_job.status = 'retry'
    and selected_job.provider_outage_epoch = 1
    and selected_job.provider_outage_recovery_count between 1 and 4
    and selected_job.provider_outage_last_reason = safe_reason
  then
    return query
    select
      selected_job.id,
      selected_job.status,
      selected_job.attempt_count,
      case
        when selected_job.status = 'retry' then selected_job.available_at
        else null
      end,
      selected_job.provider_outage_recovery_count,
      selected_job.provider_outage_deadline_at,
      selected_job.provider_outage_exhausted_at is not null;
    return;
  end if;

  if selected_job.status = 'dead'
    and selected_job.provider_outage_exhausted_at is not null
    and selected_job.provider_outage_last_reason = safe_reason
  then
    return query
    select
      selected_job.id,
      selected_job.status,
      selected_job.attempt_count,
      null::timestamptz,
      selected_job.provider_outage_recovery_count,
      selected_job.provider_outage_deadline_at,
      true;
    return;
  end if;

  if selected_job.status <> 'processing'
    or selected_job.queue_message_id <> target_queue_message_id
    or selected_job.worker_id <> selected_worker_id
  then
    raise exception using
      errcode = '55000',
      message = 'Job lease is no longer active.';
  end if;

  epoch_started_at := coalesce(selected_job.provider_outage_started_at, now());
  epoch_deadline_at := coalesce(
    selected_job.provider_outage_deadline_at,
    epoch_started_at + interval '24 hours'
  );
  remaining_seconds := greatest(
    0,
    floor(extract(epoch from (epoch_deadline_at - now())))::integer
  );

  if selected_job.provider_outage_recovery_count >= 4
    or remaining_seconds <= 0
  then
    update app_private.async_jobs job
    set
      status = 'dead',
      attempt_count = greatest(job.attempt_count - 1, 0),
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = 'provider_outage_recovery_exhausted',
      provider_outage_epoch = 1,
      provider_outage_started_at = epoch_started_at,
      provider_outage_deadline_at = epoch_deadline_at,
      provider_outage_retry_at = null,
      provider_outage_recovered_at = null,
      provider_outage_exhausted_at = now(),
      provider_outage_last_reason = safe_reason
    where job.id = selected_job.id
    returning job.* into selected_job;

    perform pgmq.archive(
      selected_job.queue_name,
      target_queue_message_id
    );

    perform app_private.set_job_entity_recovery_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      null,
      selected_job.provider_outage_exhausted_at
    );

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'failed',
      'provider_outage_recovery_exhausted'
    );

    insert into app_private.provider_outage_recovery_events (
      job_id,
      event_kind,
      retry_number,
      reason_code
    ) values (
      selected_job.id,
      'exhausted',
      selected_job.provider_outage_recovery_count,
      'provider_outage_recovery_exhausted'
    )
    on conflict on constraint
      provider_outage_recovery_events_job_kind_retry_key do nothing;
  else
    next_retry_number := selected_job.provider_outage_recovery_count + 1;
    retry_delay := least(
      app_private.provider_outage_retry_delay_seconds(next_retry_number),
      remaining_seconds
    );
    retry_delay := greatest(1, retry_delay);
    scheduled_at := now() + make_interval(secs => retry_delay);

    select sent.message_id
    into next_message_id
    from pgmq.send(
      selected_job.queue_name,
      jsonb_build_object(
        'job_id', selected_job.id,
        'job_kind', selected_job.job_kind,
        'entity_id', selected_job.entity_id,
        'entity_version', selected_job.entity_version
      ),
      retry_delay
    ) as sent(message_id);

    perform pgmq.archive(
      selected_job.queue_name,
      selected_job.queue_message_id
    );

    update app_private.async_jobs job
    set
      status = 'retry',
      attempt_count = greatest(job.attempt_count - 1, 0),
      queue_message_id = next_message_id,
      worker_id = null,
      lease_expires_at = null,
      available_at = scheduled_at,
      last_error_code = safe_reason,
      provider_outage_epoch = 1,
      provider_outage_recovery_count = next_retry_number,
      provider_outage_started_at = epoch_started_at,
      provider_outage_deadline_at = epoch_deadline_at,
      provider_outage_retry_at = scheduled_at,
      provider_outage_recovered_at = null,
      provider_outage_exhausted_at = null,
      provider_outage_last_reason = safe_reason
    where job.id = selected_job.id
    returning job.* into selected_job;

    perform app_private.set_job_entity_recovery_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      selected_job.provider_outage_retry_at,
      null
    );

    perform app_private.set_job_entity_state(
      selected_job.job_kind,
      selected_job.entity_id,
      selected_job.entity_version,
      'queued',
      null
    );

    insert into app_private.provider_outage_recovery_events (
      job_id,
      event_kind,
      retry_number,
      scheduled_for,
      reason_code
    ) values (
      selected_job.id,
      'scheduled',
      next_retry_number,
      scheduled_at,
      safe_reason
    )
    on conflict on constraint
      provider_outage_recovery_events_job_kind_retry_key do nothing;
  end if;

  return query
  select
    selected_job.id,
    selected_job.status,
    selected_job.attempt_count,
    case
      when selected_job.status = 'retry' then selected_job.available_at
      else null
    end,
    selected_job.provider_outage_recovery_count,
    selected_job.provider_outage_deadline_at,
    selected_job.provider_outage_exhausted_at is not null;
end;
$$;

revoke all on function public.defer_async_job_for_provider_outage(
  uuid, bigint, uuid, text
) from public, anon, authenticated;
grant execute on function public.defer_async_job_for_provider_outage(
  uuid, bigint, uuid, text
) to service_role;

-- ---------------------------------------------------------------------------
-- Audited global cost ceiling. The existing trigger increments the revision
-- and writes the immutable old/new policy record; the USD 100 workspace default
-- intentionally remains unchanged for the pilot.
-- ---------------------------------------------------------------------------

update app_private.ai_spend_global_policy
set monthly_limit_microusd = 225000000
where singleton
  and monthly_limit_microusd is distinct from 225000000;

comment on table app_private.writing_security_limits is
  'Private launch defaults: 3 evaluated writings per student/workspace UTC day, 40 per UTC month, and 6 authenticated immediate worker kicks per user/minute.';
comment on table app_private.ai_paid_work_limits is
  'Private V1 AI job-version reservations: writing is bounded to 5 jobs per student/workspace UTC day and 50 per UTC month; generation, semantic work, entity requeues, and adaptive support remain independently bounded.';
comment on table app_private.writing_submission_monthly_usage is
  'Private transactional evaluated-writing counts by student, workspace, and UTC month.';
comment on table app_private.ai_student_monthly_usage is
  'Private transactional paid writing-job counts by student, workspace, and UTC month.';

notify pgrst, 'reload schema';
