-- Postgres Changes publishes the complete row that passes RLS. Never publish
-- the content-bearing source tables directly: their rows contain private
-- feedback drafts, provider errors, student answers, and other fields that are
-- intentionally absent from the browser read models.

-- Attempts predate the shared updated_at convention, but the narrow status
-- feed needs a monotonic, content-free revision timestamp. Keep it on the
-- source row so every status transition and initial backfill use one clock.
alter table public.practice_test_attempts
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists practice_test_attempts_set_updated_at
on public.practice_test_attempts;
create trigger practice_test_attempts_set_updated_at
before update on public.practice_test_attempts
for each row execute function public.set_updated_at();

create table if not exists api.submission_status_events (
  id uuid primary key references public.submissions(id) on delete cascade,
  workspace_id uuid not null,
  student_id uuid not null,
  batch_id uuid,
  evaluation_status text not null,
  release_status text not null,
  release_at timestamptz,
  updated_at timestamptz not null
);

create table if not exists api.practice_assignment_status_events (
  id uuid primary key references public.student_practice_assignments(id) on delete cascade,
  workspace_id uuid not null,
  student_id uuid not null,
  status text not null,
  generation_status text not null,
  practice_test_id uuid,
  latest_attempt_id uuid,
  updated_at timestamptz not null
);

create table if not exists api.practice_attempt_status_events (
  id uuid primary key references public.practice_test_attempts(id) on delete cascade,
  workspace_id uuid not null,
  student_id uuid not null,
  assignment_id uuid,
  status text not null,
  evaluation_status text not null,
  evaluation_started_at timestamptz,
  evaluation_completed_at timestamptz,
  updated_at timestamptz not null
);

alter table api.submission_status_events enable row level security;
alter table api.practice_assignment_status_events enable row level security;
alter table api.practice_attempt_status_events enable row level security;

revoke all on table api.submission_status_events
from public, anon, authenticated, service_role;
revoke all on table api.practice_assignment_status_events
from public, anon, authenticated, service_role;
revoke all on table api.practice_attempt_status_events
from public, anon, authenticated, service_role;

grant select on table api.submission_status_events
to authenticated, service_role;
grant select on table api.practice_assignment_status_events
to authenticated, service_role;
grant select on table api.practice_attempt_status_events
to authenticated, service_role;

drop policy if exists "submission_status_events_active_context"
on api.submission_status_events;
create policy "submission_status_events_active_context"
on api.submission_status_events for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and public.is_workspace_member(workspace_id)
  )
);

drop policy if exists "practice_assignment_status_events_active_context"
on api.practice_assignment_status_events;
create policy "practice_assignment_status_events_active_context"
on api.practice_assignment_status_events for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and public.is_workspace_member(workspace_id)
  )
);

drop policy if exists "practice_attempt_status_events_active_context"
on api.practice_attempt_status_events;
create policy "practice_attempt_status_events_active_context"
on api.practice_attempt_status_events for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and public.is_workspace_member(workspace_id)
  )
);

create or replace function app_private.sync_realtime_status_feed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'submissions' then
    -- Historical draft/abandoned rows deliberately have no evaluation or
    -- release state. They are not active feedback jobs and must not poison
    -- the narrow status feed or block an otherwise safe source-row update.
    if new.evaluation_status is null or new.release_status is null then
      delete from api.submission_status_events status_event
      where status_event.id = new.id;
      return new;
    end if;

    insert into api.submission_status_events (
      id,
      workspace_id,
      student_id,
      batch_id,
      evaluation_status,
      release_status,
      release_at,
      updated_at
    ) values (
      new.id,
      new.workspace_id,
      new.student_id,
      new.batch_id,
      new.evaluation_status,
      new.release_status,
      new.release_at,
      new.updated_at
    )
    on conflict (id) do update
    set workspace_id = excluded.workspace_id,
        student_id = excluded.student_id,
        batch_id = excluded.batch_id,
        evaluation_status = excluded.evaluation_status,
        release_status = excluded.release_status,
        release_at = excluded.release_at,
        updated_at = excluded.updated_at;
  elsif tg_table_name = 'student_practice_assignments' then
    insert into api.practice_assignment_status_events (
      id,
      workspace_id,
      student_id,
      status,
      generation_status,
      practice_test_id,
      latest_attempt_id,
      updated_at
    ) values (
      new.id,
      new.workspace_id,
      new.student_id,
      new.status,
      new.generation_status,
      new.practice_test_id,
      new.latest_attempt_id,
      new.updated_at
    )
    on conflict (id) do update
    set workspace_id = excluded.workspace_id,
        student_id = excluded.student_id,
        status = excluded.status,
        generation_status = excluded.generation_status,
        practice_test_id = excluded.practice_test_id,
        latest_attempt_id = excluded.latest_attempt_id,
        updated_at = excluded.updated_at;
  elsif tg_table_name = 'practice_test_attempts' then
    insert into api.practice_attempt_status_events (
      id,
      workspace_id,
      student_id,
      assignment_id,
      status,
      evaluation_status,
      evaluation_started_at,
      evaluation_completed_at,
      updated_at
    ) values (
      new.id,
      new.workspace_id,
      new.student_id,
      new.assignment_id,
      new.status,
      new.evaluation_status,
      new.evaluation_started_at,
      new.evaluation_completed_at,
      new.updated_at
    )
    on conflict (id) do update
    set workspace_id = excluded.workspace_id,
        student_id = excluded.student_id,
        assignment_id = excluded.assignment_id,
        status = excluded.status,
        evaluation_status = excluded.evaluation_status,
        evaluation_started_at = excluded.evaluation_started_at,
        evaluation_completed_at = excluded.evaluation_completed_at,
        updated_at = excluded.updated_at;
  else
    raise exception using errcode = '22023', message = 'unsupported_realtime_status_source';
  end if;

  return new;
end;
$$;

revoke all on function app_private.sync_realtime_status_feed()
from public, anon, authenticated, service_role;

drop trigger if exists submissions_sync_realtime_status
on public.submissions;
create trigger submissions_sync_realtime_status
after insert or update of
  workspace_id,
  student_id,
  batch_id,
  evaluation_status,
  release_status,
  release_at,
  updated_at
on public.submissions
for each row execute function app_private.sync_realtime_status_feed();

drop trigger if exists practice_assignments_sync_realtime_status
on public.student_practice_assignments;
create trigger practice_assignments_sync_realtime_status
after insert or update of
  workspace_id,
  student_id,
  status,
  generation_status,
  practice_test_id,
  latest_attempt_id,
  updated_at
on public.student_practice_assignments
for each row execute function app_private.sync_realtime_status_feed();

drop trigger if exists practice_attempts_sync_realtime_status
on public.practice_test_attempts;
create trigger practice_attempts_sync_realtime_status
after insert or update of
  workspace_id,
  student_id,
  assignment_id,
  status,
  evaluation_status,
  evaluation_started_at,
  evaluation_completed_at,
  updated_at
on public.practice_test_attempts
for each row execute function app_private.sync_realtime_status_feed();

insert into api.submission_status_events (
  id,
  workspace_id,
  student_id,
  batch_id,
  evaluation_status,
  release_status,
  release_at,
  updated_at
)
select
  submission.id,
  submission.workspace_id,
  submission.student_id,
  submission.batch_id,
  submission.evaluation_status,
  submission.release_status,
  submission.release_at,
  submission.updated_at
from public.submissions submission
where submission.evaluation_status is not null
  and submission.release_status is not null
on conflict (id) do update
set workspace_id = excluded.workspace_id,
    student_id = excluded.student_id,
    batch_id = excluded.batch_id,
    evaluation_status = excluded.evaluation_status,
    release_status = excluded.release_status,
    release_at = excluded.release_at,
    updated_at = excluded.updated_at;

insert into api.practice_assignment_status_events (
  id,
  workspace_id,
  student_id,
  status,
  generation_status,
  practice_test_id,
  latest_attempt_id,
  updated_at
)
select
  assignment.id,
  assignment.workspace_id,
  assignment.student_id,
  assignment.status,
  assignment.generation_status,
  assignment.practice_test_id,
  assignment.latest_attempt_id,
  assignment.updated_at
from public.student_practice_assignments assignment
on conflict (id) do update
set workspace_id = excluded.workspace_id,
    student_id = excluded.student_id,
    status = excluded.status,
    generation_status = excluded.generation_status,
    practice_test_id = excluded.practice_test_id,
    latest_attempt_id = excluded.latest_attempt_id,
    updated_at = excluded.updated_at;

insert into api.practice_attempt_status_events (
  id,
  workspace_id,
  student_id,
  assignment_id,
  status,
  evaluation_status,
  evaluation_started_at,
  evaluation_completed_at,
  updated_at
)
select
  attempt.id,
  attempt.workspace_id,
  attempt.student_id,
  attempt.assignment_id,
  attempt.status,
  attempt.evaluation_status,
  attempt.evaluation_started_at,
  attempt.evaluation_completed_at,
  attempt.updated_at
from public.practice_test_attempts attempt
on conflict (id) do update
set workspace_id = excluded.workspace_id,
    student_id = excluded.student_id,
    assignment_id = excluded.assignment_id,
    status = excluded.status,
    evaluation_status = excluded.evaluation_status,
    evaluation_started_at = excluded.evaluation_started_at,
    evaluation_completed_at = excluded.evaluation_completed_at,
    updated_at = excluded.updated_at;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'submissions'
  ) then
    alter publication supabase_realtime drop table public.submissions;
  end if;
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'student_practice_assignments'
  ) then
    alter publication supabase_realtime drop table public.student_practice_assignments;
  end if;
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'practice_test_attempts'
  ) then
    alter publication supabase_realtime drop table public.practice_test_attempts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'api'
      and tablename = 'submission_status_events'
  ) then
    alter publication supabase_realtime add table api.submission_status_events;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'api'
      and tablename = 'practice_assignment_status_events'
  ) then
    alter publication supabase_realtime add table api.practice_assignment_status_events;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'api'
      and tablename = 'practice_attempt_status_events'
  ) then
    alter publication supabase_realtime add table api.practice_attempt_status_events;
  end if;
end;
$$;

comment on table api.submission_status_events is
  'RLS-protected status-only Realtime feed. Student writing and provider details are deliberately absent.';
comment on table api.practice_assignment_status_events is
  'RLS-protected status-only Realtime feed for durable worksheet generation and assignment transitions.';
comment on table api.practice_attempt_status_events is
  'RLS-protected status-only Realtime feed. Student answers and model reviews are deliberately absent.';

notify pgrst, 'reload schema';
