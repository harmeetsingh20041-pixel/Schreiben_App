-- Move privileged helper logic out of the exposed public schema.
-- Public wrappers remain available for existing policies/RPC names, but the
-- SECURITY DEFINER bodies live in a non-exposed schema.

create schema if not exists app_private;

revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to authenticated;

create or replace function app_private.is_platform_admin()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.global_role = 'platform_admin'
  );
$$;

create or replace function app_private.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = (select auth.uid())
  );
$$;

create or replace function app_private.has_workspace_role(target_workspace_id uuid, allowed_roles text[])
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = (select auth.uid())
      and wm.role = any(allowed_roles)
  );
$$;

revoke all on function app_private.is_platform_admin() from public, anon;
revoke all on function app_private.is_workspace_member(uuid) from public, anon;
revoke all on function app_private.has_workspace_role(uuid, text[]) from public, anon;

grant execute on function app_private.is_platform_admin() to authenticated;
grant execute on function app_private.is_workspace_member(uuid) to authenticated;
grant execute on function app_private.has_workspace_role(uuid, text[]) to authenticated;

create or replace function public.is_platform_admin()
returns boolean
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select app_private.is_platform_admin();
$$;

create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select app_private.is_workspace_member(target_workspace_id);
$$;

create or replace function public.has_workspace_role(target_workspace_id uuid, allowed_roles text[])
returns boolean
language sql
security invoker
set search_path = public, pg_temp
stable
as $$
  select app_private.has_workspace_role(target_workspace_id, allowed_roles);
$$;

create or replace function public.prevent_profile_role_escalation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if app_private.is_platform_admin() then
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

create or replace function public.prevent_workspace_member_escalation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if app_private.is_platform_admin() then
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

create or replace function app_private.create_teacher_workspace_internal(workspace_name text default 'My German Class')
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

revoke all on function app_private.create_teacher_workspace_internal(text) from public, anon;
grant execute on function app_private.create_teacher_workspace_internal(text) to authenticated;

create or replace function public.create_teacher_workspace(workspace_name text default 'My German Class')
returns table (workspace_id uuid, membership_id uuid)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select * from app_private.create_teacher_workspace_internal(workspace_name);
$$;

revoke all on function public.create_teacher_workspace(text) from public, anon;
grant execute on function public.create_teacher_workspace(text) to authenticated;
