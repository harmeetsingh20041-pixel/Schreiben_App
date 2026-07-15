-- Make the administrator-approved per-class daily writing limit authoritative.
--
-- The historical 40-submission month, 40 paid-writing-job day, 50 paid-writing-
-- job month, and EUR-denominated student/cohort fair-share limits remain useful
-- telemetry, but they must not undercut a class allowance that a platform
-- administrator explicitly approved. Worksheet-generation and semantic-answer
-- limits are deliberately unchanged. The transactional workspace/global spend
-- ceilings and the global emergency stop remain the final runaway protection.

-- ---------------------------------------------------------------------------
-- Evaluated-writing admission: one class, one India-local day
-- ---------------------------------------------------------------------------

create or replace function app_private.consume_writing_submission_quota(
  target_workspace_id uuid,
  target_batch_id uuid,
  target_student_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  batch_daily_limit integer;
  consumed_batch_count integer;
  current_usage_day date := app_private.india_writing_usage_day(now());
  current_usage_month date :=
    date_trunc('month', now() at time zone 'UTC')::date;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null
    or target_batch_id is null
    or target_student_id is null
    or caller_id <> target_student_id
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if not exists (
    select 1
    from public.batch_students assignment
    join public.batches batch
      on batch.id = assignment.batch_id
     and batch.workspace_id = assignment.workspace_id
    join public.workspace_members membership
      on membership.workspace_id = assignment.workspace_id
     and membership.user_id = assignment.student_id
     and membership.role = 'student'
    where assignment.workspace_id = target_workspace_id
      and assignment.batch_id = target_batch_id
      and assignment.student_id = target_student_id
      and batch.is_active
  ) then
    raise exception using
      errcode = '42501',
      message = 'active_batch_assignment_required';
  end if;

  batch_daily_limit := app_private.current_batch_writing_daily_limit(
    target_workspace_id,
    target_batch_id
  );

  if batch_daily_limit is null then
    raise exception using
      errcode = '55000',
      message = 'writing_quota_unavailable';
  end if;

  insert into app_private.writing_submission_batch_daily_usage as usage (
    workspace_id,
    batch_id,
    student_id,
    usage_day,
    submission_count
  ) values (
    target_workspace_id,
    target_batch_id,
    target_student_id,
    current_usage_day,
    1
  )
  on conflict (workspace_id, batch_id, student_id, usage_day) do update
  set submission_count = usage.submission_count + 1,
      updated_at = now()
  where usage.submission_count < batch_daily_limit
  returning usage.submission_count into consumed_batch_count;

  if consumed_batch_count is null then
    raise exception using
      errcode = '54000',
      message = 'writing_daily_quota_exceeded';
  end if;

  -- Preserve the historical month counter for cost reporting and invoicing.
  -- It is telemetry only: the approved class/day allowance is admission.
  insert into app_private.writing_submission_monthly_usage as usage (
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
  set submission_count = usage.submission_count + 1,
      updated_at = now();

  return consumed_batch_count;
end;
$$;

revoke all on function app_private.consume_writing_submission_quota(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Paid-job accounting: writing counts are telemetry, Practice limits stay hard
-- ---------------------------------------------------------------------------

-- Support the documented V1 maximum of 250 students each using a 10/day class,
-- including the existing maximum of two manual requeues per writing. This is a
-- workspace-level runaway boundary, not a student entitlement.
update app_private.ai_paid_work_limits
set max_writing_jobs_per_workspace_day = 10000,
    updated_at = now()
where singleton
  and max_writing_jobs_per_workspace_day < 10000;

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

  -- Student writing counts remain invoice/anomaly telemetry. The approved
  -- per-class India-day counter has already admitted the writing atomically.
  -- Worksheet-generation and semantic-evaluation student limits are unchanged.
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
    (excluded.generation_job_count = 0
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
      updated_at = now();
  end if;
end;
$$;

revoke all on function app_private.consume_ai_paid_work_budget(text, uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cost targets remain measured; they no longer deny an entitled learner
-- ---------------------------------------------------------------------------

-- Keep the historical function/trigger name for migration and rollback
-- compatibility. It still freezes the student and cached-price context on every
-- immutable reservation and retains the established offboarding lock order.
create or replace function app_private.enforce_ai_spend_fair_share()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job app_private.async_jobs%rowtype;
  selected_policy app_private.ai_model_cost_policies%rowtype;
  selected_student_id uuid;
begin
  if current_setting('app.ai_spend_transition', true) <> 'on' then
    raise exception using errcode = '55000', message = 'ai_spend_evidence_immutable';
  end if;

  select job.*
  into strict selected_job
  from app_private.async_jobs job
  where job.id = new.job_id;

  if selected_job.job_kind = 'writing_evaluation' then
    select submission.student_id
    into selected_student_id
    from public.submissions submission
    where submission.id = selected_job.entity_id;
  elsif selected_job.job_kind = 'worksheet_generation' then
    select assignment.student_id
    into selected_student_id
    from public.student_practice_assignments assignment
    where assignment.id = selected_job.entity_id;
  elsif selected_job.job_kind = 'worksheet_answer_evaluation' then
    select attempt.student_id
    into selected_student_id
    from public.practice_test_attempts attempt
    where attempt.id = selected_job.entity_id;
  end if;

  if selected_student_id is null then
    raise exception using errcode = '02000', message = 'ai_spend_job_missing';
  end if;

  perform pg_advisory_xact_lock(
    app_private.student_month_work_lock_key(
      selected_student_id,
      new.billing_month
    )
  );
  perform pg_advisory_xact_lock(
    app_private.student_workspace_work_lock_key(
      new.workspace_id,
      selected_student_id
    )
  );

  perform membership.id
  from public.workspace_members membership
  where membership.workspace_id = new.workspace_id
    and membership.role = 'student'
  order by membership.id
  for share;

  if not exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = new.workspace_id
      and membership.user_id = selected_student_id
      and membership.role = 'student'
  ) then
    raise exception using errcode = '55000', message = 'ai_spend_student_inactive';
  end if;

  select policy.*
  into strict selected_policy
  from app_private.ai_model_cost_policies policy
  where policy.provider_name = new.provider_name
    and policy.model_name = new.model_name
    and policy.call_purpose = new.call_purpose;

  new.student_id := selected_student_id;
  new.cached_input_rate_microusd_per_million :=
    selected_policy.cached_input_rate_microusd_per_million;
  return new;
end;
$$;

revoke all on function app_private.enforce_ai_spend_fair_share()
from public, anon, authenticated, service_role;

comment on function app_private.consume_writing_submission_quota(
  uuid, uuid, uuid
) is
  'Atomic approved per-class India-day writing admission; workspace-month usage is retained as telemetry only.';

comment on function app_private.consume_ai_paid_work_budget(text, uuid) is
  'Atomic paid-job accounting: writing student day/month counts are telemetry; Practice limits, entity retries, and workspace runaway limits remain enforced.';

comment on function app_private.enforce_ai_spend_fair_share() is
  'Compatibility-named private reservation attribution guard. It freezes student and cached-rate evidence without denying entitled work at a student/cohort cost target.';

comment on table app_private.writing_submission_monthly_usage is
  'Private transactional evaluated-writing telemetry by student, workspace, and UTC month; not an admission limit.';

comment on table app_private.ai_student_monthly_usage is
  'Private transactional paid writing-job telemetry by student, workspace, and UTC month; not an admission limit.';

comment on table app_private.ai_paid_work_limits is
  'Private V1 job controls: writing student counters are telemetry, writing workspace/day and per-entity retries remain runaway guards, and Practice limits remain enforced.';

comment on column app_private.ai_spend_global_policy.operating_target_microeur_per_active_student_month is
  'Planning and monitoring target only; it does not deny an otherwise entitled writing or worksheet.';

comment on column app_private.ai_spend_global_policy.fair_share_reserve_basis_points is
  'Planning reserve for cost projection only; it does not deny an otherwise entitled writing or worksheet.';

notify pgrst, 'reload schema';
