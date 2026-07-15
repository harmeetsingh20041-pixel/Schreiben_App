-- Immediate certified worksheet-bank attachment.
--
-- A released, qualified canonical worksheet is free deterministic content. It
-- must be attached before any paid-AI quota, queue, Edge worker or provider is
-- involved. Provider generation remains the durable fallback only when the
-- exact frozen topic/CEFR context has no eligible certified revision.

create table app_private.worksheet_bank_direct_attachment_events (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null
    references public.student_practice_assignments(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  template_revision_id uuid not null
    references app_private.practice_worksheet_template_revisions(id)
    on delete restrict,
  cloned_practice_test_id uuid not null
    references public.practice_tests(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  attachment_source text not null default 'certified_bank_direct'
    check (attachment_source = 'certified_bank_direct'),
  created_at timestamptz not null default now()
);

create index worksheet_bank_direct_attachment_events_workspace_created_idx
on app_private.worksheet_bank_direct_attachment_events (
  workspace_id,
  created_at desc,
  id desc
);

alter table app_private.worksheet_bank_direct_attachment_events
enable row level security;

revoke all on table app_private.worksheet_bank_direct_attachment_events
from public, anon, authenticated, service_role;

create or replace function app_private.guard_worksheet_bank_direct_attachment_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.worksheet_bank_direct_attachment', true)
    is distinct from 'on'
    or new.requested_by is distinct from (select auth.uid())
    or not exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.id = new.assignment_id
        and assignment.workspace_id = new.workspace_id
        and assignment.student_id = new.student_id
        and assignment.status in ('unlocked', 'in_progress')
    )
    or not exists (
      select 1
      from public.practice_tests worksheet
      where worksheet.id = new.cloned_practice_test_id
        and worksheet.workspace_id = new.workspace_id
        and worksheet.worksheet_template_revision_id = new.template_revision_id
        and worksheet.quality_status = 'approved'
        and worksheet.teacher_reviewed = true
        and app_private.practice_test_canonical_revision_is_current(
          worksheet.id
        )
    )
  then
    raise exception using
      errcode = '42501',
      message = 'worksheet_bank_direct_attachment_required';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_bank_direct_attachment_insert()
from public, anon, authenticated, service_role;

create or replace function app_private.hold_unapproved_restricted_provider_fallback(
  target_assignment_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_assignment public.student_practice_assignments%rowtype;
begin
  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if selected_assignment.id is null
    or selected_assignment.source not in ('weakness_auto', 'adaptive_repeat')
    or selected_assignment.resolution_cycle_id is null
    or selected_assignment.status <> 'unlocked'
    or selected_assignment.started_at is not null
    or selected_assignment.latest_attempt_id is not null
    or not exists (
      select 1
      from app_private.practice_topic_level_assignment_gates gate
      where gate.grammar_topic_id = selected_assignment.grammar_topic_id
        and gate.worksheet_level = selected_assignment.worksheet_level
    )
    or exists (
      select 1
      from app_private.practice_level_fit_opt_ins opt_in
      where opt_in.cycle_id = selected_assignment.resolution_cycle_id
        and opt_in.grammar_topic_id = selected_assignment.grammar_topic_id
        and opt_in.worksheet_level = selected_assignment.worksheet_level
    )
  then
    return false;
  end if;

  update public.student_practice_assignments assignment
  set
    practice_test_id = null,
    status = 'cancelled',
    completed_at = coalesce(assignment.completed_at, now()),
    generation_status = 'needs_review',
    generation_started_at = null,
    generation_completed_at = now(),
    generation_error = 'level_fit_approval_required'
  where assignment.id = selected_assignment.id;

  return true;
end;
$$;

revoke all on function app_private.hold_unapproved_restricted_provider_fallback(uuid)
from public, anon, authenticated, service_role;

create trigger worksheet_bank_direct_attachment_events_00_guard
before insert on app_private.worksheet_bank_direct_attachment_events
for each row execute function
  app_private.guard_worksheet_bank_direct_attachment_insert();

create trigger worksheet_bank_direct_attachment_events_immutable
before update or delete on app_private.worksheet_bank_direct_attachment_events
for each row execute function app_private.reject_worksheet_bank_history_mutation();

alter function public.request_practice_worksheet(uuid)
rename to request_practice_worksheet_before_phase_13f;

revoke all on function public.request_practice_worksheet_before_phase_13f(uuid)
from public, anon, authenticated, service_role;

create function public.request_practice_worksheet(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  job_id uuid,
  generation_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  assignment_snapshot public.student_practice_assignments%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_job app_private.async_jobs%rowtype;
  caller_workspace_role text;
  caller_global_role text;
  selected_revision_id uuid;
  cloned_test_id uuid;
  clone_attempt integer;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  -- Reuse the mature safe authorization/existence boundary before exposing any
  -- class, bank or withdrawal state.
  perform public.get_practice_assignment_summary_internal(target_assignment_id);

  select profile.global_role
  into caller_global_role
  from public.profiles profile
  where profile.id = caller_id
  for share;

  if caller_global_role is null then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select assignment.*
  into assignment_snapshot
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if assignment_snapshot.id is null then
    raise exception using errcode = '02000', message = 'practice_assignment_not_found';
  end if;

  -- Legacy/manual assignments keep their established request path. The bank
  -- fast path requires the immutable class snapshot introduced for V1.
  if assignment_snapshot.class_context_version <> 1
    or assignment_snapshot.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or assignment_snapshot.batch_id is null
    or assignment_snapshot.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
  then
    return query
    select requested.*
    from public.request_practice_worksheet_before_phase_13f(
      target_assignment_id
    ) requested;
    return;
  end if;

  if caller_id <> assignment_snapshot.student_id
    and caller_global_role <> 'platform_admin'
  then
    select membership.role
    into caller_workspace_role
    from public.workspace_members membership
    where membership.workspace_id = assignment_snapshot.workspace_id
      and membership.user_id = caller_id
    for share;

    if caller_workspace_role is null
      or caller_workspace_role not in ('owner', 'teacher')
    then
      raise exception using errcode = '42501', message = 'permission_denied';
    end if;
  end if;

  -- This function does not touch the adaptive cycle/topic advisory. It locks
  -- the mutable class context before the assignment row, matching offboarding,
  -- transfer and deactivation postconditions and closing the late-request race.
  if not app_private.lock_active_practice_class_context(
    assignment_snapshot.workspace_id,
    assignment_snapshot.student_id,
    assignment_snapshot.batch_id,
    assignment_snapshot.worksheet_level
  ) then
    raise exception using
      errcode = '42501',
      message = 'active_class_membership_required';
  end if;

  -- Match every worker completion path: class context -> async job ->
  -- assignment. Taking the assignment first would invert the worker's
  -- job-before-assignment order and could deadlock a browser request against a
  -- completion transaction.
  select job.*
  into selected_job
  from app_private.async_jobs job
  where job.job_kind = 'worksheet_generation'
    and job.entity_id = assignment_snapshot.id
    and job.status in ('queued', 'retry', 'processing')
  order by job.entity_version desc
  limit 1
  for update;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = assignment_snapshot.id
  for update;

  if selected_assignment.workspace_id is distinct from assignment_snapshot.workspace_id
    or selected_assignment.student_id is distinct from assignment_snapshot.student_id
    or selected_assignment.grammar_topic_id is distinct from assignment_snapshot.grammar_topic_id
    or selected_assignment.batch_id is distinct from assignment_snapshot.batch_id
    or selected_assignment.worksheet_level is distinct from assignment_snapshot.worksheet_level
    or selected_assignment.class_context_version is distinct from 1
    or selected_assignment.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'practice_assignment_context_changed';
  end if;

  if selected_assignment.status not in ('unlocked', 'in_progress') then
    raise exception using
      errcode = '55000',
      message = 'practice_assignment_not_active';
  end if;

  -- A qualified release may be withdrawn or its qualification revoked after
  -- the automatic assignment was opened. Never let that stale approval become
  -- a bridge into paid provider-generated productive practice. Untouched work
  -- is held and its durable cancellation transition moves the cycle back to
  -- level_fit_approval_required; a teacher opt-in or another certified release
  -- makes a later request eligible again.
  if selected_assignment.source in ('weakness_auto', 'adaptive_repeat')
    and selected_assignment.resolution_cycle_id is not null
    and selected_assignment.status = 'unlocked'
    and selected_assignment.started_at is null
    and selected_assignment.latest_attempt_id is null
    and not app_private.practice_topic_level_gate_satisfied(
      selected_assignment.grammar_topic_id,
      selected_assignment.worksheet_level,
      selected_assignment.resolution_cycle_id
    )
  then
    if selected_job.id is not null
      and (
        selected_job.status in ('queued', 'retry')
        or (
          selected_job.status = 'processing'
          and (
            selected_job.lease_expires_at is null
            or selected_job.lease_expires_at <= now()
          )
        )
      )
    then
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
        last_error_code = 'practice_level_fit_provider_generation_not_approved'
      where job.id = selected_job.id;
    end if;

    update public.student_practice_assignments assignment
    set
      practice_test_id = null,
      status = 'cancelled',
      completed_at = coalesce(assignment.completed_at, now()),
      generation_status = 'needs_review',
      generation_started_at = null,
      generation_completed_at = now(),
      generation_error = 'level_fit_approval_required'
    where assignment.id = selected_assignment.id;

    return query
    select selected_assignment.id, null::uuid, 'needs_review'::text;
    return;
  end if;

  if app_private.practice_assignment_has_withdrawn_unstarted_clone(
    selected_assignment.id
  ) then
    update public.student_practice_assignments assignment
    set
      practice_test_id = null,
      generation_status = 'idle',
      generation_started_at = null,
      generation_completed_at = null,
      generation_error = null
    where assignment.id = selected_assignment.id
    returning assignment.* into selected_assignment;
  elsif selected_assignment.practice_test_id is not null then
    update public.student_practice_assignments assignment
    set
      generation_status = 'ready',
      generation_error = null
    where assignment.id = selected_assignment.id;

    return query select selected_assignment.id, null::uuid, 'ready'::text;
    return;
  end if;

  -- Never race an active provider lease. Queued/retry work is kept while no
  -- bank revision exists, but it must not hide a release published later.
  if selected_job.id is not null
    and selected_job.status = 'processing'
    and selected_job.lease_expires_at is not null
    and selected_job.lease_expires_at > now()
  then
    if app_private.hold_unapproved_restricted_provider_fallback(
      selected_assignment.id
    ) then
      return query
      select selected_assignment.id, null::uuid, 'needs_review'::text;
      return;
    end if;

    return query
    select requested.*
    from public.request_practice_worksheet_before_phase_13f(
      target_assignment_id
    ) requested;
    return;
  end if;

  for clone_attempt in 1..2 loop
    selected_revision_id := public.select_released_worksheet_template_internal(
      selected_assignment.workspace_id,
      selected_assignment.student_id,
      selected_assignment.grammar_topic_id,
      selected_assignment.worksheet_level
    );

    exit when selected_revision_id is null;

    begin
      cloned_test_id := app_private.clone_released_worksheet_template(
        selected_assignment.workspace_id,
        selected_revision_id
      );
      exit;
    exception when sqlstate 'P0002' then
      if sqlerrm <> 'worksheet_bank_release_not_found' then
        raise;
      end if;
      selected_revision_id := null;
      cloned_test_id := null;
    end;
  end loop;

  if selected_revision_id is null or cloned_test_id is null then
    if app_private.hold_unapproved_restricted_provider_fallback(
      selected_assignment.id
    ) then
      return query
      select selected_assignment.id, null::uuid, 'needs_review'::text;
      return;
    end if;

    return query
    select requested.*
    from public.request_practice_worksheet_before_phase_13f(
      target_assignment_id
    ) requested;
    return;
  end if;

  -- The exact bank clone now exists in this transaction. Supersede only an
  -- unleased queued/retry job or an expired processing lease, archive its
  -- ID-only message, and retain all already-recorded quota/spend history. No
  -- reservation is released here: a retry or expired lease can represent an
  -- uncertain billed provider dispatch.
  if selected_job.id is not null
    and (
      selected_job.status in ('queued', 'retry')
      or (
        selected_job.status = 'processing'
        and (
          selected_job.lease_expires_at is null
          or selected_job.lease_expires_at <= now()
        )
      )
    )
  then
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
      last_error_code = 'certified_bank_attached'
    where job.id = selected_job.id;
  end if;

  perform set_config('app.worksheet_bank_direct_attachment', 'on', true);
  insert into app_private.worksheet_bank_direct_attachment_events (
    assignment_id,
    workspace_id,
    student_id,
    template_revision_id,
    cloned_practice_test_id,
    requested_by
  ) values (
    selected_assignment.id,
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_revision_id,
    cloned_test_id,
    caller_id
  );
  perform set_config('app.worksheet_bank_direct_attachment', 'off', true);

  update public.student_practice_assignments assignment
  set
    practice_test_id = cloned_test_id,
    generation_status = 'ready',
    generation_started_at = null,
    generation_completed_at = now(),
    generation_error = null
  where assignment.id = selected_assignment.id;

  return query select selected_assignment.id, null::uuid, 'ready'::text;
end;
$$;

revoke all on function public.request_practice_worksheet(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.request_practice_worksheet(uuid)
to authenticated;

create or replace function api.request_practice_worksheet(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  job_id uuid,
  generation_status text
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  select requested.*
  from public.request_practice_worksheet(target_assignment_id) requested;
exception
  when sqlstate '54000' then
    if sqlerrm in (
      'worksheet_generation_retry_limit_exceeded',
      'workspace_ai_daily_budget_exceeded',
      'student_ai_daily_budget_exceeded'
    ) then
      raise exception using errcode = 'PT429', message = sqlerrm;
    end if;
    raise;
end;
$$;

revoke all on function api.request_practice_worksheet(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.request_practice_worksheet(uuid)
to authenticated;

-- A queued job must preserve the same approval boundary after request commit.
-- Bank-derived approval may supply certified content only; it never authorizes
-- a provider call. The immutable teacher opt-in is the sole provider-fallback
-- approval for the thirteen restricted topic/level contexts.
alter function api.get_worksheet_generation_context(uuid)
set schema app_private;
alter function app_private.get_worksheet_generation_context(uuid)
rename to get_worksheet_generation_context_before_phase_13g;

revoke all on function
  app_private.get_worksheet_generation_context_before_phase_13g(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.get_worksheet_generation_context_before_phase_13g(uuid)
to service_role;

create function app_private.get_worksheet_generation_context_phase_13g(
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
  reusable_practice_test_id uuid,
  certified_template_revision_id uuid
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  selected_context record;
begin
  perform app_private.assert_service_role();

  select context.*
  into selected_context
  from app_private.get_worksheet_generation_context_before_phase_13g(
    target_assignment_id
  ) context;

  if selected_context.assignment_id is null then
    return;
  end if;

  if selected_context.certified_template_revision_id is null
    and exists (
      select 1
      from public.student_practice_assignments assignment
      join app_private.practice_topic_level_assignment_gates gate
        on gate.grammar_topic_id = assignment.grammar_topic_id
       and gate.worksheet_level = assignment.worksheet_level
      where assignment.id = selected_context.assignment_id
        and assignment.source in ('weakness_auto', 'adaptive_repeat')
        and assignment.resolution_cycle_id is not null
        and not exists (
          select 1
          from app_private.practice_level_fit_opt_ins opt_in
          where opt_in.cycle_id = assignment.resolution_cycle_id
            and opt_in.grammar_topic_id = assignment.grammar_topic_id
            and opt_in.worksheet_level = assignment.worksheet_level
        )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'practice_level_fit_provider_generation_not_approved';
  end if;

  return query select
    selected_context.assignment_id,
    selected_context.workspace_id,
    selected_context.grammar_topic_id,
    selected_context.attached_practice_test_id,
    selected_context.assignment_status,
    selected_context.batch_id,
    selected_context.batch_name,
    selected_context.worksheet_level,
    selected_context.topic_name,
    selected_context.topic_slug,
    selected_context.topic_level,
    selected_context.topic_description,
    selected_context.reusable_practice_test_id,
    selected_context.certified_template_revision_id;
end;
$$;

revoke all on function
  app_private.get_worksheet_generation_context_phase_13g(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.get_worksheet_generation_context_phase_13g(uuid)
to service_role;

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
  reusable_practice_test_id uuid,
  certified_template_revision_id uuid
)
language sql
security invoker
set search_path = ''
stable
as $$
  select *
  from app_private.get_worksheet_generation_context_phase_13g(
    target_assignment_id
  );
$$;

revoke all on function api.get_worksheet_generation_context(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.get_worksheet_generation_context(uuid)
to service_role;

create function app_private.complete_worksheet_generation_phase_13g(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  worksheet jsonb
)
returns table (
  assignment_id uuid,
  practice_test_id uuid,
  generation_status text,
  quality_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_assignment public.student_practice_assignments%rowtype;
begin
  perform app_private.assert_service_role();

  select assignment.*
  into selected_assignment
  from app_private.async_jobs job
  join public.student_practice_assignments assignment
    on assignment.id = job.entity_id
  where job.id = target_job_id
    and job.job_kind = 'worksheet_generation';

  if selected_assignment.id is not null
    and selected_assignment.source in ('weakness_auto', 'adaptive_repeat')
    and selected_assignment.resolution_cycle_id is not null
    and exists (
      select 1
      from app_private.practice_topic_level_assignment_gates gate
      where gate.grammar_topic_id = selected_assignment.grammar_topic_id
        and gate.worksheet_level = selected_assignment.worksheet_level
    )
    and not exists (
      select 1
      from app_private.practice_level_fit_opt_ins opt_in
      where opt_in.cycle_id = selected_assignment.resolution_cycle_id
        and opt_in.grammar_topic_id = selected_assignment.grammar_topic_id
        and opt_in.worksheet_level = selected_assignment.worksheet_level
    )
    and coalesce(worksheet ->> 'mode', '') <> 'certified_bank'
  then
    raise exception using
      errcode = '55000',
      message = 'practice_level_fit_provider_generation_not_approved';
  end if;

  return query
  select completed.*
  from app_private.complete_worksheet_generation_phase_12r(
    target_job_id,
    target_queue_message_id,
    worker_id,
    worksheet
  ) completed;
end;
$$;

revoke all on function app_private.complete_worksheet_generation_phase_13g(
  uuid, bigint, uuid, jsonb
)
from public, anon, authenticated, service_role;
grant execute on function app_private.complete_worksheet_generation_phase_13g(
  uuid, bigint, uuid, jsonb
)
to service_role;

create or replace function api.complete_worksheet_generation(
  target_job_id uuid,
  target_queue_message_id bigint,
  worker_id uuid,
  worksheet jsonb
)
returns table (
  assignment_id uuid,
  practice_test_id uuid,
  generation_status text,
  quality_status text
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app_private.complete_worksheet_generation_phase_13g(
    target_job_id,
    target_queue_message_id,
    worker_id,
    worksheet
  );
$$;

revoke all on function api.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
)
from public, anon, authenticated, service_role;
grant execute on function api.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
)
to service_role;

comment on table app_private.worksheet_bank_direct_attachment_events is
  'Immutable content-free audit of a qualified canonical worksheet attached synchronously before any paid-AI quota, queue, worker, or provider call.';
comment on function api.request_practice_worksheet(uuid) is
  'Authorized exact-class worksheet request. Attaches a qualified canonical revision immediately and free when available; otherwise returns the established durable AI queue state.';
comment on function api.get_worksheet_generation_context(uuid) is
  'Service-only immutable class snapshot. A restricted context without teacher opt-in may expose certified bank content but never a provider-generation path.';
comment on function api.complete_worksheet_generation(uuid, bigint, uuid, jsonb) is
  'Final transactional worksheet boundary. Restricted automatic practice without immutable teacher opt-in accepts certified-bank completion only.';

notify pgrst, 'reload schema';
