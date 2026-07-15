-- Phase 11L: explicit, atomic class transfer for teachers.
--
-- Moving a student between classes must not be implemented as two browser
-- mutations: a failed second request could otherwise leave duplicate or no
-- current assignment. Historical submissions retain their original batch_id.

create table app_private.batch_transfer_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  source_assignment_id uuid not null,
  source_batch_id uuid not null references public.batches(id) on delete restrict,
  -- Assignment rows are current-access edges and may later be removed during
  -- another transfer or offboarding; retain their opaque IDs as audit facts.
  target_assignment_id uuid not null,
  target_batch_id uuid not null references public.batches(id) on delete restrict,
  target_created boolean not null,
  created_at timestamptz not null default now(),
  check (source_batch_id <> target_batch_id)
);

create index batch_transfer_actions_workspace_created_idx
on app_private.batch_transfer_actions (workspace_id, created_at desc, id desc);

create index batch_transfer_actions_student_created_idx
on app_private.batch_transfer_actions (workspace_id, student_id, created_at desc);

alter table app_private.batch_transfer_actions enable row level security;

revoke all on table app_private.batch_transfer_actions
from public, anon, authenticated, service_role;

drop trigger if exists batch_transfer_actions_immutable
on app_private.batch_transfer_actions;
create trigger batch_transfer_actions_immutable
before update or delete on app_private.batch_transfer_actions
for each row execute function app_private.reject_adaptive_history_mutation();

create or replace function public.transfer_student_class_internal(
  target_workspace_id uuid,
  target_student_id uuid,
  source_assignment_id uuid,
  target_batch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  source_assignment public.batch_students%rowtype;
  selected_target_batch public.batches%rowtype;
  target_assignment_id uuid;
  target_created boolean := false;
  action_id uuid := gen_random_uuid();
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_workspace_id is null
    or target_student_id is null
    or source_assignment_id is null
    or target_batch_id is null
  then
    raise exception using errcode = '22023', message = 'class_transfer_context_required';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select assignment.*
  into source_assignment
  from public.batch_students assignment
  where assignment.id = source_assignment_id
    and assignment.workspace_id = target_workspace_id
    and assignment.student_id = target_student_id
  for update;

  if source_assignment.id is null then
    raise exception using errcode = 'P0002', message = 'source_class_assignment_not_found';
  end if;
  if source_assignment.batch_id = target_batch_id then
    raise exception using errcode = '22023', message = 'class_transfer_target_unchanged';
  end if;
  if not exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = target_student_id
      and membership.role = 'student'
  )
  then
    raise exception using errcode = '55000', message = 'active_student_membership_required';
  end if;

  -- Lock both class rows in deterministic UUID order so opposing transfers do
  -- not acquire class locks in opposite orders.
  perform 1
  from public.batches batch
  where batch.id in (source_assignment.batch_id, target_batch_id)
  order by batch.id
  for update;

  select batch.*
  into selected_target_batch
  from public.batches batch
  where batch.id = target_batch_id
    and batch.workspace_id = target_workspace_id;

  if not exists (
    select 1
    from public.batches source_batch
    where source_batch.id = source_assignment.batch_id
      and source_batch.workspace_id = target_workspace_id
  )
  then
    raise exception using errcode = '55000', message = 'source_class_context_invalid';
  end if;
  if selected_target_batch.id is null then
    raise exception using errcode = '22023', message = 'class_transfer_target_invalid';
  end if;
  if not selected_target_batch.is_active then
    raise exception using errcode = '55000', message = 'active_target_class_required';
  end if;

  select assignment.id
  into target_assignment_id
  from public.batch_students assignment
  where assignment.workspace_id = target_workspace_id
    and assignment.student_id = target_student_id
    and assignment.batch_id = target_batch_id
  for update;

  if target_assignment_id is null then
    insert into public.batch_students (workspace_id, student_id, batch_id)
    values (target_workspace_id, target_student_id, target_batch_id)
    on conflict (batch_id, student_id) do nothing
    returning id into target_assignment_id;
    target_created := target_assignment_id is not null;

    if target_assignment_id is null then
      select assignment.id
      into target_assignment_id
      from public.batch_students assignment
      where assignment.workspace_id = target_workspace_id
        and assignment.student_id = target_student_id
        and assignment.batch_id = target_batch_id
      for update;
    end if;
  end if;

  if target_assignment_id is null then
    raise exception using errcode = '40001', message = 'class_transfer_conflict';
  end if;

  delete from public.batch_students assignment
  where assignment.id = source_assignment.id;

  if not found then
    raise exception using errcode = '40001', message = 'class_transfer_conflict';
  end if;

  insert into app_private.batch_transfer_actions (
    id,
    workspace_id,
    student_id,
    actor_id,
    source_assignment_id,
    source_batch_id,
    target_assignment_id,
    target_batch_id,
    target_created
  ) values (
    action_id,
    target_workspace_id,
    target_student_id,
    caller_id,
    source_assignment.id,
    source_assignment.batch_id,
    target_assignment_id,
    target_batch_id,
    target_created
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action_id', action_id,
    'workspace_id', target_workspace_id,
    'student_id', target_student_id,
    'source_assignment_id', source_assignment.id,
    'source_batch_id', source_assignment.batch_id,
    'target_assignment_id', target_assignment_id,
    'target_batch_id', target_batch_id,
    'target_created', target_created,
    'source_removed', true
  );
end;
$$;

revoke all on function public.transfer_student_class_internal(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.transfer_student_class_internal(
  uuid, uuid, uuid, uuid
) to authenticated;

create or replace function api.transfer_student_class(
  target_workspace_id uuid,
  target_student_id uuid,
  source_assignment_id uuid,
  target_batch_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.transfer_student_class_internal(
    target_workspace_id,
    target_student_id,
    source_assignment_id,
    target_batch_id
  );
$$;

revoke all on function api.transfer_student_class(uuid, uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function api.transfer_student_class(uuid, uuid, uuid, uuid)
to authenticated;

comment on function api.transfer_student_class(uuid, uuid, uuid, uuid)
is 'Atomically moves one active workspace student from an exact source class assignment to an active target class and records immutable audit evidence.';

notify pgrst, 'reload schema';
