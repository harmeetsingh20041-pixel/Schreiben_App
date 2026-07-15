-- Phase 11R: close the remaining browser read bypasses and bound paid writing
-- work at the database boundary.
--
-- Historical rows remain intact for teachers and audit. A student can read
-- workspace-scoped history only while an active student membership exists.
-- Browser clients use reviewed RPCs rather than the broad Phase 8B
-- compatibility views.

-- ---------------------------------------------------------------------------
-- Private, transactional writing and worker-kick limits
-- ---------------------------------------------------------------------------

create table app_private.writing_security_limits (
  singleton boolean primary key default true check (singleton),
  max_submissions_per_student_workspace_day smallint not null default 20
    check (max_submissions_per_student_workspace_day between 1 and 200),
  max_authenticated_kicks_per_minute smallint not null default 6
    check (max_authenticated_kicks_per_minute between 1 and 60),
  updated_at timestamptz not null default now()
);

insert into app_private.writing_security_limits (singleton)
values (true)
on conflict (singleton) do nothing;

create table app_private.writing_submission_daily_usage (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  usage_day date not null,
  submission_count integer not null default 0 check (submission_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, student_id, usage_day)
);

create table app_private.writing_processor_kick_windows (
  user_id uuid not null references public.profiles(id) on delete cascade,
  window_started_at timestamptz not null,
  kick_count integer not null default 0 check (kick_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, window_started_at)
);

alter table app_private.writing_security_limits enable row level security;
alter table app_private.writing_submission_daily_usage enable row level security;
alter table app_private.writing_processor_kick_windows enable row level security;

revoke all on table app_private.writing_security_limits
from public, anon, authenticated, service_role;
revoke all on table app_private.writing_submission_daily_usage
from public, anon, authenticated, service_role;
revoke all on table app_private.writing_processor_kick_windows
from public, anon, authenticated, service_role;

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
  consumed_count integer;
  current_usage_day date := (now() at time zone 'UTC')::date;
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

  select limits.max_submissions_per_student_workspace_day
  into daily_limit
  from app_private.writing_security_limits limits
  where limits.singleton;

  if daily_limit is null then
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
  set submission_count = app_private.writing_submission_daily_usage.submission_count + 1,
      updated_at = now()
  where app_private.writing_submission_daily_usage.submission_count < daily_limit
  returning submission_count into consumed_count;

  if consumed_count is null then
    raise exception using
      errcode = '54000',
      message = 'writing_daily_quota_exceeded';
  end if;

  return consumed_count;
end;
$$;

revoke all on function app_private.consume_writing_submission_quota(uuid, uuid)
from public, anon, authenticated, service_role;

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

  select limits.max_authenticated_kicks_per_minute
  into kick_limit
  from app_private.writing_security_limits limits
  where limits.singleton;

  if kick_limit is null then
    return 'unavailable';
  end if;

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

create or replace function api.authorize_writing_processor_kick(
  target_user_id uuid
)
returns text
language sql
security invoker
set search_path = ''
as $$
  select public.authorize_writing_processor_kick_internal(target_user_id);
$$;

revoke all on function api.authorize_writing_processor_kick(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.authorize_writing_processor_kick(uuid)
to service_role;

-- ---------------------------------------------------------------------------
-- Active-membership RLS for every workspace-scoped student read branch
-- ---------------------------------------------------------------------------

drop policy if exists "batch_students_select_members" on public.batch_students;
create policy "batch_students_select_members"
on public.batch_students for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = batch_students.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
  )
);

drop policy if exists "batches_select_assigned_students_or_workspace_teacher"
on public.batches;
create policy "batches_select_assigned_students_or_workspace_teacher"
on public.batches for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or exists (
    select 1
    from public.batch_students assignment
    join public.workspace_members membership
      on membership.workspace_id = assignment.workspace_id
     and membership.user_id = assignment.student_id
     and membership.role = 'student'
    where assignment.batch_id = batches.id
      and assignment.workspace_id = batches.workspace_id
      and assignment.student_id = (select auth.uid())
  )
);

drop policy if exists "questions_select_workspace_members" on public.questions;
create policy "questions_select_workspace_members"
on public.questions for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    is_active
    and exists (
      select 1
      from public.batch_students assignment
      join public.batches batch
        on batch.id = assignment.batch_id
       and batch.workspace_id = assignment.workspace_id
       and batch.is_active
       and batch.level = questions.level
      join public.workspace_members membership
        on membership.workspace_id = assignment.workspace_id
       and membership.user_id = assignment.student_id
       and membership.role = 'student'
      where assignment.workspace_id = questions.workspace_id
        and assignment.student_id = (select auth.uid())
    )
  )
);

drop policy if exists "submissions_select_owner_or_teacher" on public.submissions;
create policy "submissions_select_owner_or_teacher"
on public.submissions for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = submissions.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
  )
);

drop policy if exists "submission_lines_select_released_or_teacher"
on public.submission_lines;
create policy "submission_lines_select_released_or_teacher"
on public.submission_lines for select
to authenticated
using (
  exists (
    select 1
    from public.submissions submission
    where submission.id = submission_lines.submission_id
      and (
        public.is_platform_admin()
        or public.has_workspace_role(
          submission.workspace_id,
          array['owner', 'teacher']
        )
        or (
          submission.student_id = (select auth.uid())
          and submission.release_status = 'released'
          and exists (
            select 1
            from public.workspace_members membership
            where membership.workspace_id = submission.workspace_id
              and membership.user_id = (select auth.uid())
              and membership.role = 'student'
          )
        )
      )
  )
);

drop policy if exists "submission_grammar_topics_select_released_or_teacher"
on public.submission_grammar_topics;
create policy "submission_grammar_topics_select_released_or_teacher"
on public.submission_grammar_topics for select
to authenticated
using (
  exists (
    select 1
    from public.submissions submission
    where submission.id = submission_grammar_topics.submission_id
      and (
        public.is_platform_admin()
        or public.has_workspace_role(
          submission.workspace_id,
          array['owner', 'teacher']
        )
        or (
          submission.student_id = (select auth.uid())
          and submission.release_status = 'released'
          and exists (
            select 1
            from public.workspace_members membership
            where membership.workspace_id = submission.workspace_id
              and membership.user_id = (select auth.uid())
              and membership.role = 'student'
          )
        )
      )
  )
);

drop policy if exists "student_grammar_stats_select_owner_or_teacher"
on public.student_grammar_stats;
create policy "student_grammar_stats_select_owner_or_teacher"
on public.student_grammar_stats for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = student_grammar_stats.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
  )
);

drop policy if exists "student_practice_assignments_select_owner_or_teacher"
on public.student_practice_assignments;
create policy "student_practice_assignments_select_owner_or_teacher"
on public.student_practice_assignments for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = student_practice_assignments.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
  )
);

drop policy if exists "practice_tests_select_assigned_or_teacher"
on public.practice_tests;
create policy "practice_tests_select_assigned_or_teacher"
on public.practice_tests for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or exists (
    select 1
    from public.student_practice_assignments assignment
    join public.workspace_members membership
      on membership.workspace_id = assignment.workspace_id
     and membership.user_id = assignment.student_id
     and membership.role = 'student'
    where assignment.practice_test_id = practice_tests.id
      and assignment.workspace_id = practice_tests.workspace_id
      and assignment.student_id = (select auth.uid())
  )
);

drop policy if exists "practice_test_attempts_select_owner_or_teacher"
on public.practice_test_attempts;
create policy "practice_test_attempts_select_owner_or_teacher"
on public.practice_test_attempts for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = practice_test_attempts.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
  )
);

drop policy if exists "practice_attempt_question_reviews_select_terminal_or_teacher"
on public.practice_attempt_question_reviews;
create policy "practice_attempt_question_reviews_select_terminal_or_teacher"
on public.practice_attempt_question_reviews for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = practice_attempt_question_reviews.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
    and exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.id = practice_attempt_question_reviews.attempt_id
        and attempt.status = 'checked'
        and attempt.evaluation_status in ('completed', 'not_needed')
    )
  )
);

drop policy if exists "teacher_notes_select_submission_visible"
on public.teacher_notes;
create policy "teacher_notes_select_submission_visible"
on public.teacher_notes for select
to authenticated
using (
  exists (
    select 1
    from public.submissions submission
    where submission.id = teacher_notes.submission_id
      and (
        public.is_platform_admin()
        or public.has_workspace_role(
          submission.workspace_id,
          array['owner', 'teacher']
        )
        or (
          submission.student_id = (select auth.uid())
          and exists (
            select 1
            from public.workspace_members membership
            where membership.workspace_id = submission.workspace_id
              and membership.user_id = (select auth.uid())
              and membership.role = 'student'
          )
        )
      )
  )
);

drop policy if exists "usage_events_select_owner_or_teacher"
on public.usage_events;
create policy "usage_events_select_owner_or_teacher"
on public.usage_events for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = usage_events.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
  )
);

-- ---------------------------------------------------------------------------
-- Retire the broad authenticated compatibility-view surface
-- ---------------------------------------------------------------------------

revoke select on table
  api.profiles,
  api.workspaces,
  api.workspace_members,
  api.batches,
  api.batch_students,
  api.questions,
  api.global_questions,
  api.grammar_topics,
  api.submissions,
  api.submission_lines,
  api.submission_grammar_topics,
  api.student_grammar_stats,
  api.batch_join_requests,
  api.student_practice_assignments,
  api.practice_tests,
  api.practice_test_attempts
from authenticated;

-- The practice acknowledgement Edge Function previously read two broad views.
-- This narrow RPC resolves the same state only after the existing assignment
-- summary authorization boundary proves active membership or teacher access.
create or replace function api.get_practice_evaluation_request_state(
  target_assignment_id uuid default null,
  target_attempt_id uuid default null
)
returns table (
  assignment_id uuid,
  attempt_id uuid,
  evaluation_status text
)
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  selected_assignment_id uuid := target_assignment_id;
  selected_attempt_id uuid;
  selected_status text;
  assignment_summary jsonb;
begin
  if target_assignment_id is null and target_attempt_id is null then
    raise exception using errcode = '22023', message = 'practice_context_required';
  end if;

  if selected_assignment_id is null then
    select attempt.assignment_id
    into selected_assignment_id
    from public.practice_test_attempts attempt
    where attempt.id = target_attempt_id;
  end if;

  if selected_assignment_id is null then
    raise exception using errcode = '02000', message = 'practice_attempt_not_found';
  end if;

  assignment_summary := api.get_practice_assignment_summary(selected_assignment_id);
  selected_attempt_id := coalesce(
    target_attempt_id,
    nullif(assignment_summary ->> 'latest_attempt_id', '')::uuid
  );

  if selected_attempt_id is null
    or selected_attempt_id is distinct from
      nullif(assignment_summary ->> 'latest_attempt_id', '')::uuid
  then
    raise exception using errcode = '55000', message = 'practice_attempt_not_current';
  end if;

  select attempt.evaluation_status
  into selected_status
  from public.practice_test_attempts attempt
  where attempt.id = selected_attempt_id
    and attempt.assignment_id = selected_assignment_id;

  if selected_status is null then
    raise exception using errcode = '02000', message = 'practice_attempt_not_found';
  end if;
  if selected_status not in (
    'queued',
    'evaluating',
    'completed',
    'not_needed',
    'failed'
  ) then
    raise exception using errcode = '55000', message = 'practice_feedback_not_queued';
  end if;

  return query
  select selected_assignment_id, selected_attempt_id, selected_status;
end;
$$;

revoke all on function api.get_practice_evaluation_request_state(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function api.get_practice_evaluation_request_state(uuid, uuid)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared quota enforcement for direct and resumable-draft submissions
-- ---------------------------------------------------------------------------

create or replace function public.create_writing_submission(
  target_question_source text,
  target_question_id uuid,
  target_batch_id uuid,
  answer_text text,
  save_as_draft boolean default false
)
returns table (
  submission_id uuid,
  feedback_mode text,
  feedback_scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  created_submission record;
  selected_workspace_id uuid;
  selected_student_id uuid;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if target_batch_id is null then
    raise exception using errcode = '22023', message = 'Select a batch before submitting writing.';
  end if;

  select created.*
  into created_submission
  from app_private.create_writing_submission_internal(
    target_question_source,
    target_question_id,
    target_batch_id,
    answer_text,
    save_as_draft
  ) created;

  if not coalesce(save_as_draft, false) then
    select submission.workspace_id, submission.student_id
    into selected_workspace_id, selected_student_id
    from public.submissions submission
    where submission.id = created_submission.submission_id;

    if selected_workspace_id is null or selected_student_id <> caller_id then
      raise exception using errcode = '42501', message = 'permission_denied';
    end if;

    perform app_private.consume_writing_submission_quota(
      selected_workspace_id,
      selected_student_id
    );

    update public.submissions submission
    set
      evaluation_status = 'queued',
      release_status = case
        when created_submission.feedback_mode = 'automatic_delayed' then 'scheduled'
        else 'held'
      end,
      release_at = case
        when created_submission.feedback_mode = 'automatic_delayed'
          then created_submission.feedback_scheduled_at
        else null
      end,
      evaluation_version = greatest(submission.evaluation_version, 1),
      feedback_started_at = null,
      feedback_completed_at = null,
      feedback_error = null
    where submission.id = created_submission.submission_id;

    perform *
    from app_private.enqueue_async_job(
      'writing_evaluation',
      created_submission.submission_id,
      1,
      format('writing:%s:%s', created_submission.submission_id, 1),
      caller_id,
      0
    );
  end if;

  return query
  select
    created_submission.submission_id,
    created_submission.feedback_mode,
    created_submission.feedback_scheduled_at;
end;
$$;

revoke all on function public.create_writing_submission(
  text, uuid, uuid, text, boolean
)
from public, anon;
grant execute on function public.create_writing_submission(
  text, uuid, uuid, text, boolean
)
to authenticated;

comment on table app_private.writing_security_limits is
  'Private launch defaults: 20 evaluated writings per student/workspace UTC day and 6 authenticated immediate worker kicks per user/minute.';
comment on function api.get_practice_evaluation_request_state(uuid, uuid) is
  'Active-context acknowledgement for the practice-evaluation Edge relay; exposes no answer or provider payload.';

notify pgrst, 'reload schema';
