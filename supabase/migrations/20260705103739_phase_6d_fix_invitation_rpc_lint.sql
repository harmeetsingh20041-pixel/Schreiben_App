-- Phase 6D: fix Supabase db lint ambiguity in invitation RPC helpers.
-- The behavior is unchanged; named constraints avoid ambiguous references to
-- output columns named workspace_id/batch_id/student_id in PL/pgSQL.

create or replace function app_private.invite_student_by_email_internal(
  target_email text,
  target_batch_id uuid default null
)
returns table (
  invitation_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  membership_id uuid,
  batch_student_id uuid,
  invitation_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  clean_email text := lower(btrim(target_email));
  target_workspace_id uuid;
  existing_student_id uuid;
  existing_invitation_id uuid;
  new_invitation_id uuid;
  new_membership_id uuid;
  new_batch_student_id uuid;
  new_status text := 'pending';
begin
  if caller_id is null then
    raise exception 'Authentication required.';
  end if;

  if clean_email is null or clean_email = '' or position('@' in clean_email) <= 1 then
    raise exception 'A valid student email is required.';
  end if;

  if target_batch_id is not null then
    select b.workspace_id
    into target_workspace_id
    from public.batches b
    where b.id = target_batch_id;
  else
    select wm.workspace_id
    into target_workspace_id
    from public.workspace_members wm
    where wm.user_id = caller_id
      and wm.role in ('owner', 'teacher')
    order by wm.created_at
    limit 1;
  end if;

  if target_workspace_id is null then
    raise exception 'Workspace or batch not found.';
  end if;

  if not app_private.is_platform_admin()
    and not app_private.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception 'Permission denied.';
  end if;

  select p.id
  into existing_student_id
  from public.profiles p
  where lower(p.email) = clean_email
  limit 1;

  select si.id
  into existing_invitation_id
  from public.student_invitations si
  where si.workspace_id = target_workspace_id
    and si.email = clean_email
    and si.status = 'pending'
    and (
      (target_batch_id is null and si.batch_id is null)
      or si.batch_id = target_batch_id
    )
  limit 1;

  if existing_invitation_id is not null then
    new_invitation_id := existing_invitation_id;
  else
    insert into public.student_invitations (
      workspace_id,
      batch_id,
      email,
      invited_by,
      status,
      expires_at
    )
    values (
      target_workspace_id,
      target_batch_id,
      clean_email,
      caller_id,
      'pending',
      now() + interval '30 days'
    )
    returning id into new_invitation_id;
  end if;

  if existing_student_id is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (target_workspace_id, existing_student_id, 'student')
    on conflict on constraint workspace_members_workspace_id_user_id_key do nothing
    returning id into new_membership_id;

    if new_membership_id is null then
      select wm.id
      into new_membership_id
      from public.workspace_members wm
      where wm.workspace_id = target_workspace_id
        and wm.user_id = existing_student_id;
    end if;

    if target_batch_id is not null then
      insert into public.batch_students (workspace_id, batch_id, student_id)
      values (target_workspace_id, target_batch_id, existing_student_id)
      on conflict on constraint batch_students_batch_id_student_id_key do nothing
      returning id into new_batch_student_id;

      if new_batch_student_id is null then
        select bs.id
        into new_batch_student_id
        from public.batch_students bs
        where bs.batch_id = target_batch_id
          and bs.student_id = existing_student_id;
      end if;
    end if;

    update public.student_invitations
    set
      status = 'accepted',
      accepted_by = existing_student_id,
      accepted_at = now()
    where id = new_invitation_id;

    new_status := 'accepted';
  end if;

  invitation_id := new_invitation_id;
  workspace_id := target_workspace_id;
  batch_id := target_batch_id;
  student_id := existing_student_id;
  membership_id := new_membership_id;
  batch_student_id := new_batch_student_id;
  invitation_status := new_status;
  return next;
end;
$$;

create or replace function app_private.accept_workspace_invitation_internal(invitation_id uuid)
returns table (
  accepted_invitation_id uuid,
  workspace_id uuid,
  batch_id uuid,
  membership_id uuid,
  batch_student_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  caller_email text := app_private.current_user_email();
  invitation_record public.student_invitations%rowtype;
  new_membership_id uuid;
  new_batch_student_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required.';
  end if;

  select *
  into invitation_record
  from public.student_invitations si
  where si.id = invitation_id;

  if invitation_record.id is null then
    raise exception 'Invitation not found.';
  end if;

  if invitation_record.email <> caller_email then
    raise exception 'This invitation belongs to a different email address.';
  end if;

  if invitation_record.status = 'accepted'
    and invitation_record.accepted_by = caller_id
  then
    accepted_invitation_id := invitation_record.id;
    workspace_id := invitation_record.workspace_id;
    batch_id := invitation_record.batch_id;
    membership_id := null;
    batch_student_id := null;
    return next;
    return;
  end if;

  if invitation_record.status <> 'pending' then
    raise exception 'Invitation is not pending.';
  end if;

  if invitation_record.expires_at is not null and invitation_record.expires_at < now() then
    update public.student_invitations
    set status = 'expired'
    where id = invitation_record.id;

    raise exception 'Invitation has expired.';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (invitation_record.workspace_id, caller_id, 'student')
  on conflict on constraint workspace_members_workspace_id_user_id_key do nothing
  returning id into new_membership_id;

  if new_membership_id is null then
    select wm.id
    into new_membership_id
    from public.workspace_members wm
    where wm.workspace_id = invitation_record.workspace_id
      and wm.user_id = caller_id;
  end if;

  if invitation_record.batch_id is not null then
    insert into public.batch_students (
      workspace_id,
      batch_id,
      student_id
    )
    values (
      invitation_record.workspace_id,
      invitation_record.batch_id,
      caller_id
    )
    on conflict on constraint batch_students_batch_id_student_id_key do nothing
    returning id into new_batch_student_id;

    if new_batch_student_id is null then
      select bs.id
      into new_batch_student_id
      from public.batch_students bs
      where bs.batch_id = invitation_record.batch_id
        and bs.student_id = caller_id;
    end if;
  end if;

  update public.student_invitations
  set
    status = 'accepted',
    accepted_by = caller_id,
    accepted_at = now()
  where id = invitation_record.id;

  accepted_invitation_id := invitation_record.id;
  workspace_id := invitation_record.workspace_id;
  batch_id := invitation_record.batch_id;
  membership_id := new_membership_id;
  batch_student_id := new_batch_student_id;
  return next;
end;
$$;
