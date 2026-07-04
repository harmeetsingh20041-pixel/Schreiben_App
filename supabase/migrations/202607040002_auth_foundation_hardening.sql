-- Phase 3 auth/profile/workspace hardening.
-- Keeps new accounts student-by-default and prevents browser clients from
-- changing authorization fields directly.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email, global_role)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.email, ''),
    'student'
  )
  on conflict (id) do update
  set
    full_name = coalesce(public.profiles.full_name, excluded.full_name),
    email = excluded.email,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

create or replace function public.prevent_profile_role_escalation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if public.is_platform_admin() then
    return new;
  end if;

  if new.id <> old.id then
    raise exception 'Profile id cannot be changed.';
  end if;

  if new.email is distinct from old.email then
    raise exception 'Profile email cannot be changed from the client.';
  end if;

  if new.global_role is distinct from old.global_role then
    raise exception 'Profile role cannot be changed from the client.';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_prevent_role_escalation on public.profiles;

create trigger profiles_prevent_role_escalation
before update on public.profiles
for each row execute function public.prevent_profile_role_escalation();

revoke all on function public.prevent_profile_role_escalation() from public, anon;
grant execute on function public.prevent_profile_role_escalation() to authenticated;

create or replace function public.prevent_workspace_member_escalation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if public.is_platform_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' and new.role = 'owner' then
    raise exception 'Owner memberships must be created through the workspace onboarding function.';
  end if;

  if tg_op = 'UPDATE' then
    if new.workspace_id <> old.workspace_id then
      raise exception 'Workspace membership workspace cannot be changed.';
    end if;

    if new.user_id <> old.user_id then
      raise exception 'Workspace membership user cannot be changed.';
    end if;

    if new.role = 'owner' and old.role <> 'owner' then
      raise exception 'Only platform admins can promote workspace owners.';
    end if;

    if old.role = 'owner' and new.role <> 'owner' then
      raise exception 'Only platform admins can demote workspace owners.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_members_prevent_escalation on public.workspace_members;

create trigger workspace_members_prevent_escalation
before insert or update on public.workspace_members
for each row execute function public.prevent_workspace_member_escalation();

revoke all on function public.prevent_workspace_member_escalation() from public, anon;
grant execute on function public.prevent_workspace_member_escalation() to authenticated;

drop policy if exists "profiles_insert_self" on public.profiles;
drop policy if exists "profiles_update_self" on public.profiles;
drop policy if exists "workspace_members_manage_workspace_teacher" on public.workspace_members;

create policy "profiles_insert_self_student_only"
on public.profiles for insert
to authenticated
with check (
  id = (select auth.uid())
  and global_role = 'student'
);

create policy "profiles_update_own_name_only_or_admin"
on public.profiles for update
to authenticated
using (id = (select auth.uid()) or public.is_platform_admin())
with check (id = (select auth.uid()) or public.is_platform_admin());

create policy "workspace_members_insert_owner_managed"
on public.workspace_members for insert
to authenticated
with check (
  public.is_platform_admin()
  or (
    public.has_workspace_role(workspace_id, array['owner'])
    and role in ('teacher', 'student')
  )
);

create policy "workspace_members_update_owner_managed"
on public.workspace_members for update
to authenticated
using (
  public.is_platform_admin()
  or (
    public.has_workspace_role(workspace_id, array['owner'])
    and role <> 'owner'
  )
)
with check (
  public.is_platform_admin()
  or (
    public.has_workspace_role(workspace_id, array['owner'])
    and role in ('teacher', 'student')
  )
);

create policy "workspace_members_delete_owner_managed"
on public.workspace_members for delete
to authenticated
using (
  public.is_platform_admin()
  or (
    public.has_workspace_role(workspace_id, array['owner'])
    and role <> 'owner'
  )
);

create or replace function public.create_teacher_workspace(workspace_name text default 'My German Class')
returns table (workspace_id uuid, membership_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := (select auth.uid());
  clean_name text := nullif(btrim(workspace_name), '');
  base_slug text;
  new_workspace_id uuid;
  new_membership_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication required.';
  end if;

  clean_name := coalesce(clean_name, 'My German Class');
  base_slug := lower(regexp_replace(clean_name, '[^a-zA-Z0-9]+', '-', 'g'));
  base_slug := trim(both '-' from base_slug);
  base_slug := coalesce(nullif(base_slug, ''), 'my-german-class');
  base_slug := base_slug || '-' || left(replace(current_user_id::text, '-', ''), 8);

  insert into public.workspaces (name, slug, owner_id)
  values (clean_name, base_slug, current_user_id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, current_user_id, 'owner')
  returning id into new_membership_id;

  workspace_id := new_workspace_id;
  membership_id := new_membership_id;
  return next;
end;
$$;

revoke all on function public.create_teacher_workspace(text) from public, anon;
grant execute on function public.create_teacher_workspace(text) to authenticated;
