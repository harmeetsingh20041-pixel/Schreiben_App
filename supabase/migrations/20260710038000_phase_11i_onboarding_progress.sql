-- Phase 11I: persistent, role-scoped V1 onboarding checklists.
--
-- Progress content is private. Browser callers use SECURITY INVOKER wrappers
-- in the deliberately exposed api schema; the exact privileged bodies remain
-- in the non-exposed public schema.

create table app_private.onboarding_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role text not null check (role in ('teacher', 'student')),
  completed_steps text[] not null default array[]::text[],
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_id, role),
  constraint onboarding_progress_steps_check check (
    (
      role = 'teacher'
      and completed_steps <@ array[
        'create_class',
        'choose_feedback_mode',
        'share_join_code',
        'review_first_submission'
      ]::text[]
    )
    or (
      role = 'student'
      and completed_steps <@ array[
        'join_class',
        'submit_writing',
        'review_feedback',
        'start_practice'
      ]::text[]
    )
  )
);

create index onboarding_progress_workspace_role_idx
on app_private.onboarding_progress (workspace_id, role, updated_at desc);

alter table app_private.onboarding_progress enable row level security;
revoke all on table app_private.onboarding_progress
from public, anon, authenticated, service_role;

create trigger onboarding_progress_set_updated_at
before update on app_private.onboarding_progress
for each row execute function public.set_updated_at();

create or replace function app_private.assert_onboarding_context(
  target_workspace_id uuid,
  target_role text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_workspace_id is null or target_role not in ('teacher', 'student') then
    raise exception using errcode = '22023', message = 'onboarding_context_invalid';
  end if;

  if target_role = 'teacher' then
    if not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    ) then
      raise exception using errcode = '42501', message = 'teacher_workspace_required';
    end if;
  elsif not exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = caller_id
      and membership.role = 'student'
  ) then
    raise exception using errcode = '42501', message = 'student_workspace_required';
  end if;

  return caller_id;
end;
$$;

revoke all on function app_private.assert_onboarding_context(uuid, text)
from public, anon, authenticated, service_role;

create or replace function public.get_onboarding_progress_internal(
  target_workspace_id uuid,
  target_role text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_id uuid;
  stored_steps text[] := array[]::text[];
  completed text[] := array[]::text[];
  checklist_steps text[];
  selected_revision integer := 0;
  step text;
begin
  caller_id := app_private.assert_onboarding_context(
    target_workspace_id,
    target_role
  );

  select progress.completed_steps, progress.revision
  into stored_steps, selected_revision
  from app_private.onboarding_progress progress
  where progress.user_id = caller_id
    and progress.workspace_id = target_workspace_id
    and progress.role = target_role;

  stored_steps := coalesce(stored_steps, array[]::text[]);
  selected_revision := coalesce(selected_revision, 0);

  if target_role = 'teacher' then
    checklist_steps := array[
      'create_class',
      'choose_feedback_mode',
      'share_join_code',
      'review_first_submission'
    ]::text[];

    if 'create_class' = any(stored_steps) or exists (
      select 1
      from public.batches batch
      where batch.workspace_id = target_workspace_id
    ) then
      completed := array_append(completed, 'create_class');
    end if;

    if 'choose_feedback_mode' = any(stored_steps) or exists (
      select 1
      from public.batches batch
      where batch.workspace_id = target_workspace_id
        and batch.feedback_mode in (
          'immediate',
          'automatic_delayed',
          'teacher_review_only'
        )
    ) then
      completed := array_append(completed, 'choose_feedback_mode');
    end if;

    if 'share_join_code' = any(stored_steps) or exists (
      select 1
      from public.batch_join_requests request
      where request.workspace_id = target_workspace_id
    ) or exists (
      select 1
      from public.batch_students assignment
      where assignment.workspace_id = target_workspace_id
    ) then
      completed := array_append(completed, 'share_join_code');
    end if;

    if 'review_first_submission' = any(stored_steps) or exists (
      select 1
      from app_private.feedback_draft_events event
      join public.submissions submission on submission.id = event.submission_id
      where submission.workspace_id = target_workspace_id
        and event.actor_id = caller_id
        and event.event_type = 'teacher_released'
    ) then
      completed := array_append(completed, 'review_first_submission');
    end if;
  else
    checklist_steps := array[
      'join_class',
      'submit_writing',
      'review_feedback',
      'start_practice'
    ]::text[];

    if 'join_class' = any(stored_steps) or exists (
      select 1
      from public.batch_students assignment
      where assignment.workspace_id = target_workspace_id
        and assignment.student_id = caller_id
    ) then
      completed := array_append(completed, 'join_class');
    end if;

    if 'submit_writing' = any(stored_steps) or exists (
      select 1
      from public.submissions submission
      where submission.workspace_id = target_workspace_id
        and submission.student_id = caller_id
    ) then
      completed := array_append(completed, 'submit_writing');
    end if;

    if 'review_feedback' = any(stored_steps) then
      completed := array_append(completed, 'review_feedback');
    end if;

    if 'start_practice' = any(stored_steps) or exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.workspace_id = target_workspace_id
        and assignment.student_id = caller_id
        and (
          assignment.started_at is not null
          or assignment.latest_attempt_id is not null
          or assignment.status in ('in_progress', 'completed', 'passed', 'failed')
        )
    ) then
      completed := array_append(completed, 'start_practice');
    end if;
  end if;

  return jsonb_build_object(
    'role', target_role,
    'revision', selected_revision,
    'steps', to_jsonb(checklist_steps),
    'completed_steps', to_jsonb(completed),
    'completed_count', cardinality(completed),
    'total_count', cardinality(checklist_steps),
    'all_complete', cardinality(completed) = cardinality(checklist_steps),
    'next_step', (
      select candidate
      from unnest(checklist_steps) with ordinality ordered(candidate, position)
      where not candidate = any(completed)
      order by position
      limit 1
    )
  );
end;
$$;

revoke all on function public.get_onboarding_progress_internal(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.get_onboarding_progress_internal(uuid, text)
to authenticated;

create or replace function public.complete_onboarding_step_internal(
  target_workspace_id uuid,
  target_role text,
  target_step text,
  expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid;
  allowed_steps text[];
  selected_progress app_private.onboarding_progress%rowtype;
begin
  caller_id := app_private.assert_onboarding_context(
    target_workspace_id,
    target_role
  );

  allowed_steps := case target_role
    when 'teacher' then array[
      'create_class',
      'choose_feedback_mode',
      'share_join_code',
      'review_first_submission'
    ]::text[]
    else array[
      'join_class',
      'submit_writing',
      'review_feedback',
      'start_practice'
    ]::text[]
  end;

  if target_step is null or not target_step = any(allowed_steps) then
    raise exception using errcode = '22023', message = 'onboarding_step_invalid';
  end if;
  if expected_revision is null or expected_revision < 0 then
    raise exception using errcode = '22023', message = 'onboarding_revision_invalid';
  end if;

  select progress.*
  into selected_progress
  from app_private.onboarding_progress progress
  where progress.user_id = caller_id
    and progress.workspace_id = target_workspace_id
    and progress.role = target_role
  for update;

  if selected_progress.user_id is null then
    if expected_revision <> 0 then
      raise exception using errcode = '40001', message = 'onboarding_revision_conflict';
    end if;

    insert into app_private.onboarding_progress (
      user_id,
      workspace_id,
      role,
      completed_steps
    ) values (
      caller_id,
      target_workspace_id,
      target_role,
      array[target_step]
    );
  elsif target_step = any(selected_progress.completed_steps) then
    -- A network retry of an already committed step is idempotent even when it
    -- carries the pre-commit revision.
    null;
  elsif selected_progress.revision <> expected_revision then
    raise exception using errcode = '40001', message = 'onboarding_revision_conflict';
  else
    update app_private.onboarding_progress progress
    set completed_steps = array_append(progress.completed_steps, target_step),
        revision = progress.revision + 1
    where progress.user_id = caller_id
      and progress.workspace_id = target_workspace_id
      and progress.role = target_role;
  end if;

  return public.get_onboarding_progress_internal(
    target_workspace_id,
    target_role
  );
end;
$$;

revoke all on function public.complete_onboarding_step_internal(
  uuid, text, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.complete_onboarding_step_internal(
  uuid, text, text, integer
) to authenticated;

create or replace function api.get_onboarding_progress(
  target_workspace_id uuid,
  target_role text
)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.get_onboarding_progress_internal(
    target_workspace_id,
    target_role
  );
$$;

create or replace function api.complete_onboarding_step(
  target_workspace_id uuid,
  target_role text,
  target_step text,
  expected_revision integer
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.complete_onboarding_step_internal(
    target_workspace_id,
    target_role,
    target_step,
    expected_revision
  );
$$;

revoke all on function api.get_onboarding_progress(uuid, text)
from public, anon;
revoke all on function api.complete_onboarding_step(uuid, text, text, integer)
from public, anon;
grant execute on function api.get_onboarding_progress(uuid, text)
to authenticated;
grant execute on function api.complete_onboarding_step(uuid, text, text, integer)
to authenticated;

notify pgrst, 'reload schema';
