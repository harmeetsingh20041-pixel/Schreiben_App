-- Give an approved teacher a usable internal teaching area immediately. The
-- administrator approval, entitlement, default workspace, and owner
-- membership remain one transaction. Teachers therefore continue straight to
-- their first class instead of having to understand workspace setup.

alter table public.workspaces
  add constraint workspaces_name_code_point_length
  check (
    char_length(
      btrim(
        name,
        U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
      )
    ) between 1 and 120
  );

comment on constraint workspaces_name_code_point_length on public.workspaces is
  'Every workspace name contains 1..120 Unicode code points after outer whitespace is removed.';

-- Preserve the reviewed MFA and entitlement implementation, then put the
-- Unicode boundary at the stable internal entry point. The account advisory
-- lock remains visible at this layer for the existing lock-order contract.
alter function app_private.create_teacher_workspace_internal(text)
rename to create_teacher_workspace_name_legacy_internal;

revoke all on function app_private.create_teacher_workspace_name_legacy_internal(text)
from public, anon, authenticated, service_role;

create or replace function app_private.create_teacher_workspace_internal(
  workspace_name text default 'My German Class'
)
returns table (workspace_id uuid, membership_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  workspace_name_trim_chars constant text :=
    U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  clean_name text := btrim(workspace_name, workspace_name_trim_chars);
  caller_is_admin boolean := false;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'authentication_required';
  end if;

  perform app_private.lock_teacher_access_account(caller_id);

  select profile.global_role = 'platform_admin'
  into caller_is_admin
  from public.profiles profile
  where profile.id = caller_id;

  if coalesce(caller_is_admin, false) then
    perform app_private.lock_fresh_platform_admin_session();
  end if;

  if clean_name is null
    or char_length(clean_name) < 1
    or char_length(clean_name) > 120
  then
    raise exception using
      errcode = '22023',
      message = 'workspace_name_invalid';
  end if;

  return query
  select *
  from app_private.create_teacher_workspace_name_legacy_internal(clean_name);
end;
$$;

revoke all on function app_private.create_teacher_workspace_internal(text)
from public, anon, authenticated, service_role;

comment on function app_private.create_teacher_workspace_internal(text) is
  'Creates an entitled teaching workspace with a 1..120 Unicode-code-point name. Platform administrators still require fresh TOTP step-up.';

create or replace function app_private.ensure_teacher_default_workspace_internal(
  target_teacher_user_id uuid
)
returns table (workspace_id uuid, membership_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid;
  entitlement app_private.teacher_entitlements%rowtype;
  privileged_workspace_count integer := 0;
  selected_workspace_id uuid;
  selected_membership_id uuid;
  default_slug text;
begin
  caller_id := app_private.lock_fresh_platform_admin_session();

  if target_teacher_user_id is null
    or target_teacher_user_id = caller_id
    or exists (
      select 1
      from public.profiles profile
      where profile.id = target_teacher_user_id
        and profile.global_role = 'platform_admin'
    )
  then
    raise exception using
      errcode = '42501',
      message = 'teacher_default_workspace_target_invalid';
  end if;

  perform app_private.lock_teacher_access_account(target_teacher_user_id);

  select teacher_entitlement.*
  into entitlement
  from app_private.teacher_entitlements teacher_entitlement
  where teacher_entitlement.user_id = target_teacher_user_id
  for update;

  if entitlement.user_id is null
    or not entitlement.active
    or (entitlement.expires_at is not null and entitlement.expires_at <= now())
  then
    raise exception using
      errcode = '42501',
      message = 'teacher_default_workspace_entitlement_required';
  end if;

  select count(*)::integer
  into privileged_workspace_count
  from public.workspace_members membership
  where membership.user_id = target_teacher_user_id
    and membership.role in ('owner', 'teacher');

  if privileged_workspace_count > 0 then
    select membership.workspace_id, membership.id
    into selected_workspace_id, selected_membership_id
    from public.workspace_members membership
    where membership.user_id = target_teacher_user_id
      and membership.role in ('owner', 'teacher')
    order by
      case membership.role when 'owner' then 0 else 1 end,
      membership.created_at,
      membership.id
    limit 1;

    workspace_id := selected_workspace_id;
    membership_id := selected_membership_id;
    created := false;
    return next;
    return;
  end if;

  if privileged_workspace_count >= entitlement.max_workspaces then
    raise exception using
      errcode = '23514',
      message = 'teacher_workspace_limit_reached';
  end if;

  default_slug := 'my-german-class-'
    || left(replace(gen_random_uuid()::text, '-', ''), 10);

  insert into public.workspaces (name, slug, owner_id)
  values ('My German Class', default_slug, target_teacher_user_id)
  returning id into selected_workspace_id;

  perform set_config('app.allow_workspace_owner_insert', 'on', true);

  insert into public.workspace_members (workspace_id, user_id, role)
  values (selected_workspace_id, target_teacher_user_id, 'owner')
  returning id into selected_membership_id;

  perform set_config('app.allow_workspace_owner_insert', 'off', true);

  workspace_id := selected_workspace_id;
  membership_id := selected_membership_id;
  created := true;
  return next;
end;
$$;

revoke all on function app_private.ensure_teacher_default_workspace_internal(uuid)
from public, anon, authenticated, service_role;

comment on function app_private.ensure_teacher_default_workspace_internal(uuid) is
  'Idempotently creates exactly one default owner workspace when an approved teacher has no privileged workspace, within the approved quota.';

-- Keep the reviewed decision/revision body and MFA wrapper intact. The new
-- stable wrapper provisions only after a successful approval; any failure
-- rolls the entitlement decision back with it.
alter function public.decide_teacher_access_internal(
  uuid, text, integer, integer
) rename to decide_teacher_access_default_workspace_legacy_internal;

revoke all on function public.decide_teacher_access_default_workspace_legacy_internal(
  uuid, text, integer, integer
) from public, anon, authenticated, service_role;

create or replace function public.decide_teacher_access_internal(
  target_request_id uuid,
  decision text,
  expected_revision integer,
  approved_workspace_limit integer default 1
)
returns table (
  request_id uuid,
  applicant_user_id uuid,
  request_status text,
  request_revision integer,
  entitlement_revision integer,
  entitlement_max_workspaces integer,
  decided_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  decision_result record;
begin
  perform app_private.lock_fresh_platform_admin_session();

  select *
  into strict decision_result
  from public.decide_teacher_access_default_workspace_legacy_internal(
    target_request_id,
    decision,
    expected_revision,
    approved_workspace_limit
  );

  if decision_result.request_status = 'approved' then
    perform *
    from app_private.ensure_teacher_default_workspace_internal(
      decision_result.applicant_user_id
    );
  end if;

  request_id := decision_result.request_id;
  applicant_user_id := decision_result.applicant_user_id;
  request_status := decision_result.request_status;
  request_revision := decision_result.request_revision;
  entitlement_revision := decision_result.entitlement_revision;
  entitlement_max_workspaces := decision_result.entitlement_max_workspaces;
  decided_at := decision_result.decided_at;
  return next;
end;
$$;

revoke all on function public.decide_teacher_access_internal(
  uuid, text, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.decide_teacher_access_internal(
  uuid, text, integer, integer
) to authenticated;

comment on function public.decide_teacher_access_internal(
  uuid, text, integer, integer
) is
  'Revision-safe, fresh-MFA teacher decision. Approval atomically provisions the first internal workspace when none exists.';

create or replace function public.get_my_teacher_start_internal()
returns table (
  workspace_id uuid,
  membership_id uuid,
  needs_first_class boolean
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_id uuid := (select auth.uid());
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'authentication_required';
  end if;

  if not app_private.has_effective_teacher_access(caller_id) then
    return;
  end if;

  return query
  select
    membership.workspace_id,
    membership.id,
    not exists (
      select 1
      from public.batches batch
      where batch.workspace_id = membership.workspace_id
    )
  from public.workspace_members membership
  where membership.user_id = caller_id
    and membership.role in ('owner', 'teacher')
  order by
    case membership.role when 'owner' then 0 else 1 end,
    membership.created_at,
    membership.id
  limit 1;
end;
$$;

revoke all on function public.get_my_teacher_start_internal()
from public, anon, authenticated, service_role;
grant execute on function public.get_my_teacher_start_internal()
to authenticated;

create or replace function api.get_my_teacher_start()
returns table (
  workspace_id uuid,
  membership_id uuid,
  needs_first_class boolean
)
language sql
security invoker
set search_path = ''
stable
as $$
  select * from public.get_my_teacher_start_internal();
$$;

revoke all on function api.get_my_teacher_start()
from public, anon, authenticated, service_role;
grant execute on function api.get_my_teacher_start() to authenticated;

comment on function api.get_my_teacher_start() is
  'Self-only start projection that lets an approved teacher continue directly to first-class creation without exposing workspace terminology in the UI.';

notify pgrst, 'reload schema';
