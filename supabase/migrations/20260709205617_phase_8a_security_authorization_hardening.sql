-- Phase 8A: close the launch-blocking authorization gaps without exposing
-- private entitlement or batch-code data through the Data API.

create schema if not exists app_private;

revoke all on schema app_private from public, anon;
grant usage on schema app_private to service_role;

alter default privileges for role postgres in schema app_private
  revoke execute on functions from public;

alter default privileges for role postgres in schema public
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Trusted teacher entitlements and authenticated application context
-- ---------------------------------------------------------------------------

create table app_private.teacher_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  max_workspaces smallint not null default 1
    check (max_workspaces between 1 and 100),
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  note text,
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at > granted_at)
);

comment on table app_private.teacher_entitlements is
  'Server-managed teacher onboarding entitlements. Never expose through the Data API.';

alter table app_private.teacher_entitlements enable row level security;

revoke all on table app_private.teacher_entitlements from public, anon, authenticated;
grant select, insert, update, delete on table app_private.teacher_entitlements to service_role;

-- Preserve every legitimate teacher already present before entitlements were
-- introduced. The derived limit never removes an existing workspace.
with teacher_workspace_counts as (
  select
    wm.user_id,
    count(*)::integer as workspace_count
  from public.workspace_members wm
  where wm.role in ('owner', 'teacher')
  group by wm.user_id
)
insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  note
)
select
  p.id,
  true,
  case
    when p.global_role = 'platform_admin' then 100
    else greatest(1, coalesce(twc.workspace_count, 0))::smallint
  end,
  'Backfilled from the pre-entitlement teacher state during Phase 8A.'
from public.profiles p
left join teacher_workspace_counts twc on twc.user_id = p.id
where p.global_role in ('platform_admin', 'teacher')
   or coalesce(twc.workspace_count, 0) > 0
on conflict (user_id) do update
set max_workspaces = greatest(
      app_private.teacher_entitlements.max_workspaces,
      excluded.max_workspaces
    ),
    updated_at = now();

create or replace function app_private.sync_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('app.allow_profile_email_sync', 'on', true);

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

  perform set_config('app.allow_profile_email_sync', 'off', true);

  return new;
end;
$$;

revoke all on function app_private.sync_auth_user_profile() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_profile_synced on auth.users;

create trigger on_auth_user_profile_synced
after insert or update of email on auth.users
for each row execute function app_private.sync_auth_user_profile();

drop function if exists public.handle_new_auth_user();

create or replace function public.prevent_profile_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  email_sync_allowed boolean :=
    coalesce(current_setting('app.allow_profile_email_sync', true), '') = 'on';
begin
  if app_private.is_platform_admin() then
    return new;
  end if;

  if new.id <> old.id then
    raise exception 'Profile id cannot be changed.';
  end if;

  if new.email is distinct from old.email and not email_sync_allowed then
    raise exception 'Profile email cannot be changed from the client.';
  end if;

  if new.global_role is distinct from old.global_role then
    raise exception 'Profile role cannot be changed from the client.';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_profile_role_escalation() from public, anon;
grant execute on function public.prevent_profile_role_escalation() to authenticated;

create or replace function app_private.get_auth_context_internal()
returns table (
  user_id uuid,
  full_name text,
  email text,
  global_role text,
  teacher_entitled boolean,
  teacher_workspace_count integer,
  teacher_workspace_limit integer,
  can_create_teacher_workspace boolean,
  memberships jsonb
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_id uuid := (select auth.uid());
  caller_profile public.profiles%rowtype;
  entitlement app_private.teacher_entitlements%rowtype;
  is_admin boolean := false;
  entitlement_is_active boolean := false;
  workspace_count integer := 0;
  workspace_limit integer := 0;
  membership_rows jsonb := '[]'::jsonb;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select p.*
  into caller_profile
  from public.profiles p
  where p.id = caller_id;

  if caller_profile.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Profile not found.';
  end if;

  is_admin := caller_profile.global_role = 'platform_admin';

  select te.*
  into entitlement
  from app_private.teacher_entitlements te
  where te.user_id = caller_id;

  entitlement_is_active := is_admin or (
    entitlement.user_id is not null
    and entitlement.active
    and (entitlement.expires_at is null or entitlement.expires_at > now())
  );

  select count(*)::integer
  into workspace_count
  from public.workspace_members wm
  where wm.user_id = caller_id
    and wm.role in ('owner', 'teacher');

  workspace_limit := case
    when is_admin then 100
    when entitlement_is_active then entitlement.max_workspaces::integer
    else 0
  end;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'membership_id', memberships_source.membership_id,
        'workspace_id', memberships_source.workspace_id,
        'workspace_name', memberships_source.workspace_name,
        'workspace_slug', memberships_source.workspace_slug,
        'role', memberships_source.role,
        'created_at', memberships_source.created_at
      )
      order by memberships_source.created_at, memberships_source.membership_id
    ),
    '[]'::jsonb
  )
  into membership_rows
  from (
    select
      wm.id as membership_id,
      wm.workspace_id,
      w.name as workspace_name,
      w.slug as workspace_slug,
      wm.role,
      wm.created_at
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = caller_id
  ) memberships_source;

  user_id := caller_id;
  full_name := caller_profile.full_name;
  email := caller_profile.email;
  global_role := caller_profile.global_role;
  teacher_entitled := entitlement_is_active;
  teacher_workspace_count := workspace_count;
  teacher_workspace_limit := workspace_limit;
  can_create_teacher_workspace := entitlement_is_active and workspace_count < workspace_limit;
  memberships := membership_rows;
  return next;
end;
$$;

revoke all on function app_private.get_auth_context_internal() from public, anon, authenticated;

create or replace function public.get_auth_context()
returns table (
  user_id uuid,
  full_name text,
  email text,
  global_role text,
  teacher_entitled boolean,
  teacher_workspace_count integer,
  teacher_workspace_limit integer,
  can_create_teacher_workspace boolean,
  memberships jsonb
)
language sql
security definer
set search_path = ''
stable
as $$
  select * from app_private.get_auth_context_internal();
$$;

revoke all on function public.get_auth_context() from public, anon;
grant execute on function public.get_auth_context() to authenticated;

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
  clean_name text := nullif(btrim(workspace_name), '');
  base_slug text;
  new_workspace_id uuid;
  new_membership_id uuid;
  entitlement app_private.teacher_entitlements%rowtype;
  is_admin boolean := false;
  workspace_count integer := 0;
  workspace_limit integer := 0;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select exists (
    select 1
    from public.profiles p
    where p.id = caller_id
      and p.global_role = 'platform_admin'
  ) into is_admin;

  if is_admin then
    workspace_limit := 100;
  else
    select te.*
    into entitlement
    from app_private.teacher_entitlements te
    where te.user_id = caller_id
    for update;

    if entitlement.user_id is null
      or not entitlement.active
      or (entitlement.expires_at is not null and entitlement.expires_at <= now())
    then
      raise exception using
        errcode = '42501',
        message = 'Teacher onboarding is not enabled for this account.';
    end if;

    workspace_limit := entitlement.max_workspaces::integer;
  end if;

  select count(*)::integer
  into workspace_count
  from public.workspace_members wm
  where wm.user_id = caller_id
    and wm.role in ('owner', 'teacher');

  if workspace_count >= workspace_limit then
    raise exception using
      errcode = '23514',
      message = 'Teacher workspace limit reached.';
  end if;

  clean_name := coalesce(clean_name, 'My German Class');
  base_slug := lower(regexp_replace(clean_name, '[^a-zA-Z0-9]+', '-', 'g'));
  base_slug := trim(both '-' from base_slug);
  base_slug := coalesce(nullif(base_slug, ''), 'my-german-class');
  base_slug := base_slug || '-' || left(replace(gen_random_uuid()::text, '-', ''), 10);

  insert into public.workspaces (name, slug, owner_id)
  values (clean_name, base_slug, caller_id)
  returning id into new_workspace_id;

  perform set_config('app.allow_workspace_owner_insert', 'on', true);

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, caller_id, 'owner')
  returning id into new_membership_id;

  perform set_config('app.allow_workspace_owner_insert', 'off', true);

  workspace_id := new_workspace_id;
  membership_id := new_membership_id;
  return next;
end;
$$;

revoke all on function app_private.create_teacher_workspace_internal(text)
  from public, anon, authenticated;

create or replace function public.create_teacher_workspace(
  workspace_name text default 'My German Class'
)
returns table (workspace_id uuid, membership_id uuid)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.create_teacher_workspace_internal(workspace_name);
$$;

revoke all on function public.create_teacher_workspace(text) from public, anon;
grant execute on function public.create_teacher_workspace(text) to authenticated;

-- Direct workspace creation would bypass the entitlement check.
revoke insert on table public.workspaces from authenticated;
drop policy if exists "workspaces_insert_owner" on public.workspaces;

-- ---------------------------------------------------------------------------
-- Private batch join codes
-- ---------------------------------------------------------------------------

-- V1 enrollment is deliberately approval-only. Normalize legacy rows before
-- making the rule a database invariant so no client or future UI can restore
-- the automatic-approval path.
update public.batches
set join_requires_approval = true
where join_requires_approval is distinct from true;

alter table public.batches
  drop constraint if exists batches_teacher_approval_only;

alter table public.batches
  add constraint batches_teacher_approval_only
  check (join_requires_approval is true);

create table app_private.batch_join_codes (
  batch_id uuid primary key references public.batches(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  join_code text not null unique
    check (join_code ~ '^[A-Z0-9]{8,16}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table app_private.batch_join_codes is
  'Join secrets stored outside every exposed Data API schema.';

alter table app_private.batch_join_codes enable row level security;

revoke all on table app_private.batch_join_codes from public, anon, authenticated;
grant select, insert, update, delete on table app_private.batch_join_codes to service_role;

insert into app_private.batch_join_codes (
  batch_id,
  workspace_id,
  join_code,
  enabled,
  created_at,
  rotated_at,
  updated_at
)
select
  b.id,
  b.workspace_id,
  b.join_code,
  b.join_code_enabled,
  b.created_at,
  b.updated_at,
  b.updated_at
from public.batches b
on conflict (batch_id) do update
set workspace_id = excluded.workspace_id,
    join_code = excluded.join_code,
    enabled = excluded.enabled,
    updated_at = now();

create or replace function app_private.generate_batch_join_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate text;
begin
  loop
    candidate := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (
      select 1
      from app_private.batch_join_codes bjc
      where bjc.join_code = candidate
    );
  end loop;

  return candidate;
end;
$$;

revoke all on function app_private.generate_batch_join_code()
  from public, anon, authenticated;

create or replace function app_private.sync_batch_join_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into app_private.batch_join_codes (
      batch_id,
      workspace_id,
      join_code,
      enabled
    )
    values (
      new.id,
      new.workspace_id,
      app_private.generate_batch_join_code(),
      new.join_code_enabled
    )
    on conflict (batch_id) do update
    set workspace_id = excluded.workspace_id,
        enabled = excluded.enabled,
        updated_at = now();
  else
    update app_private.batch_join_codes bjc
    set workspace_id = new.workspace_id,
        enabled = new.join_code_enabled,
        updated_at = now()
    where bjc.batch_id = new.id;

    if not found then
      insert into app_private.batch_join_codes (
        batch_id,
        workspace_id,
        join_code,
        enabled
      )
      values (
        new.id,
        new.workspace_id,
        app_private.generate_batch_join_code(),
        new.join_code_enabled
      );
    end if;

    if old.is_active and not new.is_active then
      update public.batch_join_requests bjr
      set status = 'cancelled',
          decided_by = (select auth.uid()),
          decided_at = now()
      where bjr.batch_id = new.id
        and bjr.workspace_id = new.workspace_id
        and bjr.status = 'pending';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.sync_batch_join_code()
  from public, anon, authenticated;

drop trigger if exists batches_private_join_code_sync on public.batches;

create trigger batches_private_join_code_sync
after insert or update of workspace_id, join_code_enabled, is_active on public.batches
for each row execute function app_private.sync_batch_join_code();

create or replace function public.list_workspace_batch_join_codes(
  target_workspace_id uuid
)
returns table (
  batch_id uuid,
  join_code text,
  join_code_enabled boolean,
  join_requires_approval boolean
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
      message = 'Authentication required.';
  end if;

  if not app_private.is_platform_admin()
    and not app_private.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Permission denied.';
  end if;

  return query
  select
    b.id,
    bjc.join_code,
    bjc.enabled,
    b.join_requires_approval
  from public.batches b
  join app_private.batch_join_codes bjc on bjc.batch_id = b.id
  where b.workspace_id = target_workspace_id
  order by b.created_at desc, b.id;
end;
$$;

revoke all on function public.list_workspace_batch_join_codes(uuid)
  from public, anon;
grant execute on function public.list_workspace_batch_join_codes(uuid)
  to authenticated;

create or replace function public.get_batch_join_code(target_batch_id uuid)
returns table (
  batch_id uuid,
  join_code text,
  join_code_enabled boolean,
  join_requires_approval boolean
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_id uuid := (select auth.uid());
  target_workspace_id uuid;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select b.workspace_id
  into target_workspace_id
  from public.batches b
  where b.id = target_batch_id;

  if target_workspace_id is null
    or (
      not app_private.is_platform_admin()
      and not app_private.has_workspace_role(
        target_workspace_id,
        array['owner', 'teacher']
      )
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Batch not found or permission denied.';
  end if;

  return query
  select
    b.id,
    bjc.join_code,
    bjc.enabled,
    b.join_requires_approval
  from public.batches b
  join app_private.batch_join_codes bjc on bjc.batch_id = b.id
  where b.id = target_batch_id;
end;
$$;

revoke all on function public.get_batch_join_code(uuid) from public, anon;
grant execute on function public.get_batch_join_code(uuid) to authenticated;

create or replace function app_private.rotate_batch_join_code_internal(
  target_batch_id uuid
)
returns table (
  batch_id uuid,
  join_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  target_workspace_id uuid;
  new_code text;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select b.workspace_id
  into target_workspace_id
  from public.batches b
  where b.id = target_batch_id
  for update;

  if target_workspace_id is null
    or (
      not app_private.is_platform_admin()
      and not app_private.has_workspace_role(
        target_workspace_id,
        array['owner', 'teacher']
      )
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Batch not found or permission denied.';
  end if;

  new_code := app_private.generate_batch_join_code();

  update app_private.batch_join_codes bjc
  set join_code = new_code,
      enabled = true,
      rotated_at = now(),
      updated_at = now()
  where bjc.batch_id = target_batch_id;

  if not found then
    insert into app_private.batch_join_codes (
      batch_id,
      workspace_id,
      join_code,
      enabled
    )
    values (
      target_batch_id,
      target_workspace_id,
      new_code,
      true
    );
  end if;

  update public.batches b
  set join_code_enabled = true
  where b.id = target_batch_id;

  batch_id := target_batch_id;
  join_code := new_code;
  return next;
end;
$$;

revoke all on function app_private.rotate_batch_join_code_internal(uuid)
  from public, anon, authenticated;

create or replace function public.rotate_batch_join_code(target_batch_id uuid)
returns table (
  batch_id uuid,
  join_code text
)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.rotate_batch_join_code_internal(target_batch_id);
$$;

revoke all on function public.rotate_batch_join_code(uuid) from public, anon;
grant execute on function public.rotate_batch_join_code(uuid) to authenticated;

create or replace function app_private.request_join_batch_by_code_internal(
  join_code text
)
returns table (
  request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  batch_name text,
  level text,
  status text,
  requires_approval boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  clean_code text := regexp_replace(upper(btrim(join_code)), '[^A-Z0-9]', '', 'g');
  batch_record public.batches%rowtype;
  existing_request public.batch_join_requests%rowtype;
  caller_profile public.profiles%rowtype;
  new_request_id uuid;
  new_status text;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select p.*
  into caller_profile
  from public.profiles p
  where p.id = caller_id;

  if caller_profile.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Profile not found.';
  end if;

  if clean_code is null or length(clean_code) < 8 then
    raise exception using
      errcode = '22023',
      message = 'Enter a valid batch code.';
  end if;

  select b.*
  into batch_record
  from app_private.batch_join_codes bjc
  join public.batches b on b.id = bjc.batch_id
  where bjc.join_code = clean_code
    and bjc.enabled
    and b.join_code_enabled
    and b.is_active
  for share of b;

  if batch_record.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Batch code was not found or is inactive.';
  end if;

  select bjr.*
  into existing_request
  from public.batch_join_requests bjr
  where bjr.batch_id = batch_record.id
    and bjr.student_id = caller_id
    and bjr.status in ('pending', 'approved')
  order by bjr.requested_at desc
  limit 1
  for update;

  if existing_request.id is not null then
    request_id := existing_request.id;
    workspace_id := existing_request.workspace_id;
    batch_id := existing_request.batch_id;
    batch_name := batch_record.name;
    level := batch_record.level;
    status := existing_request.status;
    requires_approval := true;
    return next;
    return;
  end if;

  insert into public.batch_join_requests (
    workspace_id,
    batch_id,
    student_id,
    student_email,
    student_name,
    status
  )
  values (
    batch_record.workspace_id,
    batch_record.id,
    caller_id,
    lower(btrim(caller_profile.email)),
    caller_profile.full_name,
    'pending'
  )
  on conflict do nothing
  returning id into new_request_id;

  new_status := 'pending';

  if new_request_id is null then
    select bjr.*
    into existing_request
    from public.batch_join_requests bjr
    where bjr.batch_id = batch_record.id
      and bjr.student_id = caller_id
      and bjr.status in ('pending', 'approved')
    order by bjr.requested_at desc
    limit 1
    for update;

    if existing_request.id is null then
      raise exception using
        errcode = '40001',
        message = 'The join request changed. Please try again.';
    end if;

    new_request_id := existing_request.id;
    new_status := existing_request.status;
  end if;

  request_id := new_request_id;
  workspace_id := batch_record.workspace_id;
  batch_id := batch_record.id;
  batch_name := batch_record.name;
  level := batch_record.level;
  status := new_status;
  requires_approval := true;
  return next;
end;
$$;

revoke all on function app_private.request_join_batch_by_code_internal(text)
  from public, anon, authenticated;

create or replace function public.request_join_batch_by_code(join_code text)
returns table (
  request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  batch_name text,
  level text,
  status text,
  requires_approval boolean
)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.request_join_batch_by_code_internal(join_code);
$$;

revoke all on function public.request_join_batch_by_code(text) from public, anon;
grant execute on function public.request_join_batch_by_code(text) to authenticated;

-- Every dependent function now reads the private code table. Remove the secret
-- from the student-readable batches relation only after the backfill succeeds.
drop trigger if exists batches_normalize_join_code on public.batches;
drop function if exists public.normalize_batch_join_code();
drop index if exists public.batches_join_code_lookup_idx;
drop index if exists public.batches_join_code_key;
alter table public.batches drop constraint if exists batches_join_code_format_check;
alter table public.batches drop column join_code;

-- ---------------------------------------------------------------------------
-- Atomic join decisions and explicit student offboarding
-- ---------------------------------------------------------------------------

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
set search_path = ''
as $$
declare
  locked_request record;
  new_membership_id uuid;
  new_batch_student_id uuid;
begin
  if actor_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select
    bjr.id,
    bjr.workspace_id,
    bjr.batch_id,
    bjr.student_id,
    bjr.status,
    bjr.decided_by,
    bjr.decided_at,
    b.is_active as batch_is_active
  into locked_request
  from public.batch_join_requests bjr
  join public.batches b
    on b.id = bjr.batch_id
   and b.workspace_id = bjr.workspace_id
  where bjr.id = target_request_id
  for update of bjr, b;

  if locked_request.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Join request not found.';
  end if;

  if not locked_request.batch_is_active then
    raise exception using
      errcode = '23514',
      message = 'Inactive batches cannot accept join requests.';
  end if;

  if locked_request.status not in ('pending', 'approved') then
    raise exception using
      errcode = '23514',
      message = 'Only pending join requests can be approved.';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (locked_request.workspace_id, locked_request.student_id, 'student')
  on conflict on constraint workspace_members_workspace_id_user_id_key do nothing
  returning id into new_membership_id;

  if new_membership_id is null then
    select wm.id
    into new_membership_id
    from public.workspace_members wm
    where wm.workspace_id = locked_request.workspace_id
      and wm.user_id = locked_request.student_id;
  end if;

  insert into public.batch_students (workspace_id, batch_id, student_id)
  values (
    locked_request.workspace_id,
    locked_request.batch_id,
    locked_request.student_id
  )
  on conflict on constraint batch_students_batch_id_student_id_key do nothing
  returning id into new_batch_student_id;

  if new_batch_student_id is null then
    select bs.id
    into new_batch_student_id
    from public.batch_students bs
    where bs.workspace_id = locked_request.workspace_id
      and bs.batch_id = locked_request.batch_id
      and bs.student_id = locked_request.student_id;
  end if;

  if locked_request.status = 'pending' then
    update public.batch_join_requests bjr
    set status = 'approved',
        decided_by = actor_id,
        decided_at = now()
    where bjr.id = locked_request.id
      and bjr.status = 'pending';
  end if;

  approved_request_id := locked_request.id;
  workspace_id := locked_request.workspace_id;
  batch_id := locked_request.batch_id;
  student_id := locked_request.student_id;
  membership_id := new_membership_id;
  batch_student_id := new_batch_student_id;
  status := 'approved';
  return next;
end;
$$;

revoke all on function app_private.apply_join_request_approval(uuid, uuid)
  from public, anon, authenticated;

create or replace function app_private.approve_batch_join_request_internal(
  target_request_id uuid
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
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  request_workspace_id uuid;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select bjr.workspace_id
  into request_workspace_id
  from public.batch_join_requests bjr
  where bjr.id = target_request_id;

  if request_workspace_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Join request not found.';
  end if;

  if not app_private.is_platform_admin()
    and not app_private.has_workspace_role(
      request_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Permission denied.';
  end if;

  return query
  select *
  from app_private.apply_join_request_approval(target_request_id, caller_id);
end;
$$;

revoke all on function app_private.approve_batch_join_request_internal(uuid)
  from public, anon, authenticated;

create or replace function public.approve_batch_join_request(request_id uuid)
returns table (
  approved_request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  membership_id uuid,
  batch_student_id uuid,
  status text
)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.approve_batch_join_request_internal(request_id);
$$;

revoke all on function public.approve_batch_join_request(uuid) from public, anon;
grant execute on function public.approve_batch_join_request(uuid) to authenticated;

create or replace function app_private.reject_batch_join_request_internal(
  target_request_id uuid
)
returns table (
  rejected_request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  locked_request record;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select
    bjr.id,
    bjr.workspace_id,
    bjr.batch_id,
    bjr.student_id,
    bjr.status,
    b.is_active as batch_is_active
  into locked_request
  from public.batch_join_requests bjr
  join public.batches b
    on b.id = bjr.batch_id
   and b.workspace_id = bjr.workspace_id
  where bjr.id = target_request_id
  for update of bjr, b;

  if locked_request.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Join request not found.';
  end if;

  if not app_private.is_platform_admin()
    and not app_private.has_workspace_role(
      locked_request.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Permission denied.';
  end if;

  if not locked_request.batch_is_active then
    raise exception using
      errcode = '23514',
      message = 'Inactive batches cannot accept join decisions.';
  end if;

  if locked_request.status = 'approved' then
    raise exception using
      errcode = '23514',
      message = 'Approved join requests cannot be rejected.';
  end if;

  if locked_request.status not in ('pending', 'rejected') then
    raise exception using
      errcode = '23514',
      message = 'Only pending join requests can be rejected.';
  end if;

  if locked_request.status = 'pending' then
    update public.batch_join_requests bjr
    set status = 'rejected',
        decided_by = caller_id,
        decided_at = now()
    where bjr.id = locked_request.id
      and bjr.status = 'pending';
  end if;

  rejected_request_id := locked_request.id;
  workspace_id := locked_request.workspace_id;
  batch_id := locked_request.batch_id;
  student_id := locked_request.student_id;
  status := 'rejected';
  return next;
end;
$$;

revoke all on function app_private.reject_batch_join_request_internal(uuid)
  from public, anon, authenticated;

create or replace function public.reject_batch_join_request(request_id uuid)
returns table (
  rejected_request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  status text
)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.reject_batch_join_request_internal(request_id);
$$;

revoke all on function public.reject_batch_join_request(uuid) from public, anon;
grant execute on function public.reject_batch_join_request(uuid) to authenticated;

create or replace function app_private.offboard_student_internal(
  target_student_id uuid,
  target_workspace_id uuid
)
returns table (
  removed_batch_assignments integer,
  cancelled_join_requests integer,
  membership_removed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  target_role text;
  removed_assignments integer := 0;
  cancelled_requests integer := 0;
  removed_memberships integer := 0;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  if not app_private.is_platform_admin()
    and not app_private.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Permission denied.';
  end if;

  select wm.role
  into target_role
  from public.workspace_members wm
  where wm.workspace_id = target_workspace_id
    and wm.user_id = target_student_id
  for update;

  if target_role is not null and target_role <> 'student' then
    raise exception using
      errcode = '23514',
      message = 'Only student memberships can be offboarded.';
  end if;

  update public.batch_join_requests bjr
  set status = 'cancelled',
      decided_by = caller_id,
      decided_at = now()
  where bjr.workspace_id = target_workspace_id
    and bjr.student_id = target_student_id
    and bjr.status in ('pending', 'approved');
  get diagnostics cancelled_requests = row_count;

  delete from public.batch_students bs
  where bs.workspace_id = target_workspace_id
    and bs.student_id = target_student_id;
  get diagnostics removed_assignments = row_count;

  delete from public.workspace_members wm
  where wm.workspace_id = target_workspace_id
    and wm.user_id = target_student_id
    and wm.role = 'student';
  get diagnostics removed_memberships = row_count;

  removed_batch_assignments := removed_assignments;
  cancelled_join_requests := cancelled_requests;
  membership_removed := removed_memberships > 0;
  return next;
end;
$$;

revoke all on function app_private.offboard_student_internal(uuid, uuid)
  from public, anon, authenticated;

create or replace function public.offboard_student(
  student_id uuid,
  workspace_id uuid
)
returns table (
  removed_batch_assignments integer,
  cancelled_join_requests integer,
  membership_removed boolean
)
language sql
security definer
set search_path = ''
as $$
  select *
  from app_private.offboard_student_internal(student_id, workspace_id);
$$;

revoke all on function public.offboard_student(uuid, uuid) from public, anon;
grant execute on function public.offboard_student(uuid, uuid) to authenticated;

-- Force membership lifecycle changes through audited, transactional RPCs.
revoke insert, update, delete on table public.workspace_members from authenticated;
drop policy if exists "workspace_members_insert_owner_managed" on public.workspace_members;
drop policy if exists "workspace_members_update_owner_managed" on public.workspace_members;
drop policy if exists "workspace_members_delete_owner_managed" on public.workspace_members;

-- Join decisions are safe only when the row lock and state checks above run.
revoke insert, update, delete on table public.batch_join_requests from authenticated;
drop policy if exists "batch_join_requests_insert_admin_only" on public.batch_join_requests;
drop policy if exists "batch_join_requests_update_admin_only" on public.batch_join_requests;
drop policy if exists "batch_join_requests_delete_admin_only" on public.batch_join_requests;

-- Preserve workspace context at the database boundary even when a future UI
-- submits mismatched IDs.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'batches_id_workspace_id_key'
      and conrelid = 'public.batches'::regclass
  ) then
    alter table public.batches
      add constraint batches_id_workspace_id_key unique (id, workspace_id);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'batch_join_codes_batch_workspace_fkey'
      and conrelid = 'app_private.batch_join_codes'::regclass
  ) then
    alter table app_private.batch_join_codes
      add constraint batch_join_codes_batch_workspace_fkey
      foreign key (batch_id, workspace_id)
      references public.batches(id, workspace_id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'batch_students_batch_workspace_fkey'
      and conrelid = 'public.batch_students'::regclass
  ) then
    alter table public.batch_students
      add constraint batch_students_batch_workspace_fkey
      foreign key (batch_id, workspace_id)
      references public.batches(id, workspace_id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'batch_students_membership_fkey'
      and conrelid = 'public.batch_students'::regclass
  ) then
    alter table public.batch_students
      add constraint batch_students_membership_fkey
      foreign key (workspace_id, student_id)
      references public.workspace_members(workspace_id, user_id)
      on delete cascade
      not valid;
  end if;
end $$;

alter table app_private.batch_join_codes
  validate constraint batch_join_codes_batch_workspace_fkey;
alter table public.batch_students
  validate constraint batch_students_batch_workspace_fkey;
alter table public.batch_students
  validate constraint batch_students_membership_fkey;

create or replace function app_private.validate_batch_student_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.batches b
    where b.id = new.batch_id
      and b.workspace_id = new.workspace_id
      and b.is_active
  ) then
    raise exception using
      errcode = '23514',
      message = 'Student assignments require a matching active batch.';
  end if;

  if not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = new.workspace_id
      and wm.user_id = new.student_id
      and wm.role = 'student'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Student assignments require an active student membership.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.validate_batch_student_context()
  from public, anon, authenticated;

drop trigger if exists batch_students_validate_context on public.batch_students;

create trigger batch_students_validate_context
before insert or update of workspace_id, batch_id, student_id
on public.batch_students
for each row execute function app_private.validate_batch_student_context();

drop policy if exists "batches_select_members" on public.batches;

create policy "batches_select_assigned_students_or_workspace_teacher"
on public.batches for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or exists (
    select 1
    from public.batch_students bs
    where bs.batch_id = batches.id
      and bs.workspace_id = batches.workspace_id
      and bs.student_id = (select auth.uid())
  )
);

-- V1 enrollment is batch-code based. Keep historical invitation rows readable
-- to authorized users, but disable the incomplete mutation path.
revoke insert, update, delete on table public.student_invitations from authenticated;
revoke execute on function public.invite_student_by_email(text, uuid) from authenticated;
revoke execute on function public.accept_workspace_invitation(uuid) from authenticated;
revoke all on function app_private.invite_student_by_email_internal(text, uuid)
  from public, anon, authenticated;
revoke all on function app_private.accept_workspace_invitation_internal(uuid)
  from public, anon, authenticated;

drop policy if exists "student_invitations_insert_workspace_teacher"
  on public.student_invitations;
drop policy if exists "student_invitations_update_workspace_teacher"
  on public.student_invitations;
drop policy if exists "student_invitations_delete_workspace_teacher"
  on public.student_invitations;

-- ---------------------------------------------------------------------------
-- Submission creation is RPC-only and requires explicit batch context
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
begin
  if (select auth.uid()) is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  if target_batch_id is null then
    raise exception using
      errcode = '22023',
      message = 'Select a batch before submitting writing.';
  end if;

  return query
  select *
  from app_private.create_writing_submission_internal(
    target_question_source,
    target_question_id,
    target_batch_id,
    answer_text,
    save_as_draft
  );
end;
$$;

revoke all on function app_private.create_writing_submission_internal(
  text,
  uuid,
  uuid,
  text,
  boolean
) from public, anon, authenticated;

revoke all on function public.create_writing_submission(
  text,
  uuid,
  uuid,
  text,
  boolean
) from public, anon;

grant execute on function public.create_writing_submission(
  text,
  uuid,
  uuid,
  text,
  boolean
) to authenticated;

revoke insert, update, delete on table public.submissions from authenticated;
revoke insert, update, delete on table public.submission_lines from authenticated;
revoke insert, update, delete on table public.submission_grammar_topics from authenticated;

grant select, insert, update, delete on table public.submissions to service_role;
grant select, insert, update, delete on table public.submission_lines to service_role;
grant select, insert, update, delete on table public.submission_grammar_topics to service_role;

drop policy if exists "submissions_insert_student" on public.submissions;
drop policy if exists "submissions_insert_student_valid_assignment" on public.submissions;
drop policy if exists "submissions_update_owner_or_teacher" on public.submissions;
drop policy if exists "submissions_update_workspace_teacher" on public.submissions;

comment on function public.create_writing_submission(
  text,
  uuid,
  uuid,
  text,
  boolean
) is
  'The only authenticated submission write path. Derives feedback timing from the selected batch.';

-- Existing public compatibility wrappers used to require direct access to the
-- private schema. Run the wrappers as their tightly controlled owner instead,
-- then remove every authenticated grant on app_private. The internal routines
-- continue to authorize with auth.uid(), not current_user.
alter function public.is_platform_admin() security definer;
alter function public.is_platform_admin() set search_path = '';

alter function public.is_workspace_member(uuid) security definer;
alter function public.is_workspace_member(uuid) set search_path = '';

alter function public.has_workspace_role(uuid, text[]) security definer;
alter function public.has_workspace_role(uuid, text[]) set search_path = '';

alter function public.prevent_workspace_member_escalation() security definer;
alter function public.prevent_workspace_member_escalation() set search_path = '';

alter function public.ensure_student_practice_assignment(uuid, uuid, uuid)
  security definer;
alter function public.ensure_student_practice_assignment(uuid, uuid, uuid)
  set search_path = '';

alter function public.start_practice_assignment(uuid) security definer;
alter function public.start_practice_assignment(uuid) set search_path = '';

alter function public.submit_practice_attempt(uuid, jsonb) security definer;
alter function public.submit_practice_attempt(uuid, jsonb) set search_path = '';

alter function public.get_practice_assignment_questions(uuid) security definer;
alter function public.get_practice_assignment_questions(uuid) set search_path = '';

alter function public.list_student_practice_assignments(uuid, uuid)
  security definer;
alter function public.list_student_practice_assignments(uuid, uuid)
  set search_path = '';

alter function public.get_practice_assignment_review(uuid) security definer;
alter function public.get_practice_assignment_review(uuid) set search_path = '';

alter function public.create_next_practice_assignment(uuid) security definer;
alter function public.create_next_practice_assignment(uuid) set search_path = '';

drop policy if exists "student_invitations_select_workspace_teacher_or_recipient"
  on public.student_invitations;

create policy "student_invitations_select_workspace_teacher_or_recipient"
on public.student_invitations for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or email = (
    select lower(p.email)
    from public.profiles p
    where p.id = (select auth.uid())
  )
);

drop policy if exists "practice_attempt_question_reviews_select_owner_or_teacher"
  on public.practice_attempt_question_reviews;

create policy "practice_attempt_question_reviews_select_owner_or_teacher"
on public.practice_attempt_question_reviews for select
to authenticated
using (
  student_id = (select auth.uid())
  or public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

revoke all on all tables in schema app_private from authenticated;
revoke all on all sequences in schema app_private from authenticated;
revoke execute on all functions in schema app_private from authenticated;
revoke usage on schema app_private from authenticated;

-- New public functions are closed by default; every API above has an explicit
-- authenticated grant. Refresh PostgREST after replacing the exposed routines.
notify pgrst, 'reload schema';
