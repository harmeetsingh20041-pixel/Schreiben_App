-- Fix conflict-target ambiguity in the approval helper caused by output
-- columns named workspace_id, batch_id, and student_id.

create or replace function app_private.apply_join_request_approval(
  target_request_id uuid,
  actor_id uuid
)
returns table (
  approved_request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  membership_id uuid,
  batch_student_id uuid,
  status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_record public.batch_join_requests%rowtype;
  new_membership_id uuid;
  new_batch_student_id uuid;
begin
  select *
  into request_record
  from public.batch_join_requests bjr
  where bjr.id = target_request_id;

  if request_record.id is null then
    raise exception 'Join request not found.';
  end if;

  if request_record.status not in ('pending', 'approved') then
    raise exception 'Only pending join requests can be approved.';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (request_record.workspace_id, request_record.student_id, 'student')
  on conflict on constraint workspace_members_workspace_id_user_id_key do nothing
  returning id into new_membership_id;

  if new_membership_id is null then
    select wm.id
    into new_membership_id
    from public.workspace_members wm
    where wm.workspace_id = request_record.workspace_id
      and wm.user_id = request_record.student_id;
  end if;

  insert into public.batch_students (workspace_id, batch_id, student_id)
  values (request_record.workspace_id, request_record.batch_id, request_record.student_id)
  on conflict on constraint batch_students_batch_id_student_id_key do nothing
  returning id into new_batch_student_id;

  if new_batch_student_id is null then
    select bs.id
    into new_batch_student_id
    from public.batch_students bs
    where bs.batch_id = request_record.batch_id
      and bs.student_id = request_record.student_id;
  end if;

  update public.batch_join_requests
  set
    status = 'approved',
    decided_by = coalesce(actor_id, request_record.decided_by),
    decided_at = coalesce(request_record.decided_at, now())
  where id = request_record.id;

  approved_request_id := request_record.id;
  workspace_id := request_record.workspace_id;
  batch_id := request_record.batch_id;
  student_id := request_record.student_id;
  membership_id := new_membership_id;
  batch_student_id := new_batch_student_id;
  status := 'approved';
  return next;
end;
$$;
