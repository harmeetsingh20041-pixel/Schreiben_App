-- Allow the trusted onboarding RPC to create the initial owner membership
-- while keeping direct client owner inserts blocked.

create or replace function public.prevent_workspace_member_escalation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  owner_insert_allowed boolean :=
    coalesce(current_setting('app.allow_workspace_owner_insert', true), '') = 'on';
begin
  if app_private.is_platform_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' and new.role = 'owner' then
    if owner_insert_allowed
      and new.user_id = (select auth.uid())
      and exists (
        select 1
        from public.workspaces w
        where w.id = new.workspace_id
          and w.owner_id = (select auth.uid())
      )
    then
      return new;
    end if;

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

  perform set_config('app.allow_workspace_owner_insert', 'on', true);

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, current_user_id, 'owner')
  returning id into new_membership_id;

  perform set_config('app.allow_workspace_owner_insert', 'off', true);

  workspace_id := new_workspace_id;
  membership_id := new_membership_id;
  return next;
end;
$$;
