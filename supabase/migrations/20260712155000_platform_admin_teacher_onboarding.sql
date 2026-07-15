-- Secure V1 teacher onboarding owned by the platform administrator.
--
-- Applicants remain ordinary, email-confirmed accounts until a platform
-- administrator records an explicit approval. Authorization continues to use
-- the private entitlement table and workspace memberships; no JWT user
-- metadata participates in any decision.

alter table app_private.teacher_entitlements
  add column revision integer not null default 1
    check (revision > 0),
  add column disabled_at timestamptz,
  add column disabled_by uuid;

comment on column app_private.teacher_entitlements.revision is
  'Monotonic concurrency token for administrator approval and disable actions.';

-- Entitlements are mutated only by the authenticated, administrator-checked
-- routines below. The service role may inspect the private state for recovery
-- and diagnostics, but it cannot silently grant or revoke teacher access.
revoke all on table app_private.teacher_entitlements
from public, anon, authenticated, service_role;
grant select on table app_private.teacher_entitlements to service_role;

create table app_private.teacher_access_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'disabled')),
  revision integer not null default 1 check (revision > 0),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  approved_max_workspaces smallint
    check (approved_max_workspaces between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (
      status = 'pending'
      and decided_at is null
      and decided_by is null
      and approved_max_workspaces is null
    )
    or (
      status = 'approved'
      and decided_at is not null
      and decided_by is not null
      and approved_max_workspaces is not null
    )
    or (
      status = 'rejected'
      and decided_at is not null
      and decided_by is not null
      and approved_max_workspaces is null
    )
    or (
      status = 'disabled'
      and decided_at is not null
      and decided_by is not null
    )
  )
);

create index teacher_access_requests_status_page_idx
on app_private.teacher_access_requests (status, updated_at desc, id desc);

create index teacher_access_requests_global_page_idx
on app_private.teacher_access_requests (updated_at desc, id desc);

create index teacher_entitlements_inventory_page_idx
on app_private.teacher_entitlements (updated_at desc, user_id desc);

comment on table app_private.teacher_access_requests is
  'Private, revision-safe teacher-access applications. Applicant email and name remain authoritative in Auth/profile records rather than being copied here.';

create table app_private.teacher_access_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid
    references app_private.teacher_access_requests(id) on delete restrict,
  target_user_id uuid not null,
  actor_user_id uuid not null,
  action text not null check (action in (
    'requested',
    'resubmitted',
    'approved',
    'rejected',
    'disabled',
    'workspace_limit_updated'
  )),
  request_revision_before integer
    check (request_revision_before is null or request_revision_before > 0),
  request_revision_after integer
    check (request_revision_after is null or request_revision_after > 0),
  entitlement_revision_before integer
    check (entitlement_revision_before is null or entitlement_revision_before > 0),
  entitlement_revision_after integer
    check (entitlement_revision_after is null or entitlement_revision_after > 0),
  previous_max_workspaces smallint
    check (previous_max_workspaces between 1 and 100),
  max_workspaces smallint check (max_workspaces between 1 and 100),
  transferred_workspace_count integer not null default 0
    check (transferred_workspace_count >= 0),
  removed_privileged_membership_count integer not null default 0
    check (removed_privileged_membership_count >= 0),
  occurred_at timestamptz not null default now(),
  check (
    (
      action in ('requested', 'resubmitted', 'rejected')
      and previous_max_workspaces is null
      and max_workspaces is null
    )
    or (
      action = 'approved'
      and max_workspaces is not null
    )
    or (
      action in ('disabled', 'workspace_limit_updated')
      and previous_max_workspaces is not null
      and max_workspaces is not null
    )
  ),
  check (
    (request_id is null and request_revision_before is null and request_revision_after is null)
    or (request_id is not null and request_revision_after is not null)
  )
);

create index teacher_access_audit_target_time_idx
on app_private.teacher_access_audit (
  target_user_id,
  occurred_at desc,
  id desc
);

comment on table app_private.teacher_access_audit is
  'Content-free immutable evidence for teacher requests, decisions, and administrator takeover during disable.';

create table app_private.teacher_access_workspace_transfers (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null
    references app_private.teacher_access_audit(id) on delete restrict,
  workspace_id uuid not null,
  previous_owner_user_id uuid not null,
  new_owner_user_id uuid not null,
  transferred_at timestamptz not null default now(),
  unique (audit_id, workspace_id),
  check (previous_owner_user_id <> new_owner_user_id)
);

create index teacher_access_workspace_transfers_workspace_time_idx
on app_private.teacher_access_workspace_transfers (
  workspace_id,
  transferred_at desc,
  id desc
);

comment on table app_private.teacher_access_workspace_transfers is
  'Content-free immutable per-workspace ownership evidence for administrator teacher-access disable actions.';

alter table app_private.teacher_access_requests enable row level security;
alter table app_private.teacher_access_audit enable row level security;
alter table app_private.teacher_access_workspace_transfers enable row level security;

revoke all on table app_private.teacher_access_requests
from public, anon, authenticated, service_role;
revoke all on table app_private.teacher_access_audit
from public, anon, authenticated, service_role;
revoke all on table app_private.teacher_access_workspace_transfers
from public, anon, authenticated, service_role;

create or replace function app_private.guard_teacher_access_request_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'teacher_access_request_history_immutable';
  end if;

  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.created_at is distinct from old.created_at
  then
    raise exception using
      errcode = '55000',
      message = 'teacher_access_request_identity_immutable';
  end if;

  if new.revision <> old.revision + 1 then
    raise exception using
      errcode = '40001',
      message = 'teacher_access_request_revision_required';
  end if;

  return new;
end;
$$;

create or replace function app_private.reject_teacher_access_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'teacher_access_audit_immutable';
end;
$$;

revoke all on function app_private.guard_teacher_access_request_history()
from public, anon, authenticated, service_role;
revoke all on function app_private.reject_teacher_access_audit_mutation()
from public, anon, authenticated, service_role;

create trigger teacher_access_requests_history_guard
before update or delete on app_private.teacher_access_requests
for each row execute function app_private.guard_teacher_access_request_history();

create trigger teacher_access_audit_immutable
before update or delete on app_private.teacher_access_audit
for each row execute function app_private.reject_teacher_access_audit_mutation();

create trigger teacher_access_workspace_transfers_immutable
before update or delete on app_private.teacher_access_workspace_transfers
for each row execute function app_private.reject_teacher_access_audit_mutation();

create or replace function app_private.lock_active_account_session()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  session_claim text := coalesce(
    nullif((select auth.jwt() ->> 'session_id'), ''),
    nullif(current_setting('request.jwt.claim.session_id', true), '')
  );
  session_id uuid;
  verified_id uuid;
begin
  if caller_id is null
    or session_claim is null
    or session_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception using
      errcode = '42501',
      message = 'active_account_session_required';
  end if;

  session_id := session_claim::uuid;

  select account.id
  into verified_id
  from auth.users account
  join public.profiles profile on profile.id = account.id
  join auth.sessions auth_session
    on auth_session.id = session_id
   and auth_session.user_id = account.id
  where account.id = caller_id
    and account.email_confirmed_at is not null
    and not coalesce(account.is_anonymous, false)
    and account.deleted_at is null
    and (account.banned_until is null or account.banned_until <= now())
    and (auth_session.not_after is null or auth_session.not_after > now())
  for share of account, profile, auth_session;

  if verified_id is null then
    raise exception using
      errcode = '42501',
      message = 'active_account_session_required';
  end if;

  return verified_id;
end;
$$;

create or replace function app_private.lock_active_platform_admin_session()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  session_claim text := coalesce(
    nullif((select auth.jwt() ->> 'session_id'), ''),
    nullif(current_setting('request.jwt.claim.session_id', true), '')
  );
  session_id uuid;
  verified_id uuid;
begin
  if caller_id is null
    or session_claim is null
    or session_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception using
      errcode = '42501',
      message = 'active_platform_admin_session_required';
  end if;

  session_id := session_claim::uuid;

  select account.id
  into verified_id
  from auth.users account
  join public.profiles profile on profile.id = account.id
  join auth.sessions auth_session
    on auth_session.id = session_id
   and auth_session.user_id = account.id
  where account.id = caller_id
    and account.email_confirmed_at is not null
    and not coalesce(account.is_anonymous, false)
    and account.deleted_at is null
    and (account.banned_until is null or account.banned_until <= now())
    and profile.global_role = 'platform_admin'
    and (auth_session.not_after is null or auth_session.not_after > now())
  for share of account, profile, auth_session;

  if verified_id is null then
    raise exception using
      errcode = '42501',
      message = 'active_platform_admin_session_required';
  end if;

  return verified_id;
end;
$$;

revoke all on function app_private.lock_active_account_session()
from public, anon, authenticated, service_role;
revoke all on function app_private.lock_active_platform_admin_session()
from public, anon, authenticated, service_role;

-- A single per-account advisory lock gives request, decision, and disable the
-- same concurrency order without retaining applicant content in a job table.
create or replace function app_private.lock_teacher_access_account(
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_user_id is null then
    raise exception using
      errcode = '22023',
      message = 'teacher_access_user_required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('teacher-access:' || target_user_id::text, 0)
  );
end;
$$;

revoke all on function app_private.lock_teacher_access_account(uuid)
from public, anon, authenticated, service_role;

-- Workspace creation takes the same account lock before the entitlement row.
-- This removes the entitlement -> profile-FK versus profile -> entitlement
-- lock inversion between creation and administrator disable.
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

  perform app_private.lock_teacher_access_account(caller_id);
  caller_id := app_private.lock_active_account_session();

  select exists (
    select 1
    from public.profiles profile
    where profile.id = caller_id
      and profile.global_role = 'platform_admin'
  ) into is_admin;

  if is_admin then
    caller_id := app_private.lock_active_platform_admin_session();
    workspace_limit := 100;
  else
    select teacher_entitlement.*
    into entitlement
    from app_private.teacher_entitlements teacher_entitlement
    where teacher_entitlement.user_id = caller_id
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
  from public.workspace_members membership
  where membership.user_id = caller_id
    and membership.role in ('owner', 'teacher');

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
from public, anon, authenticated, service_role;

create or replace function public.request_teacher_access_internal(
  expected_revision integer default 0
)
returns table (
  request_id uuid,
  request_status text,
  request_revision integer,
  requested_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  auth_account record;
  caller_profile public.profiles%rowtype;
  locked_request app_private.teacher_access_requests%rowtype;
  entitlement app_private.teacher_entitlements%rowtype;
  previous_revision integer;
  audit_action text;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if expected_revision is null or expected_revision < 0 then
    raise exception using
      errcode = '22023',
      message = 'teacher_access_revision_invalid';
  end if;

  perform app_private.lock_teacher_access_account(caller_id);

  select
    account.id,
    account.email_confirmed_at,
    coalesce(account.is_anonymous, false) as is_anonymous,
    account.deleted_at,
    account.banned_until
  into auth_account
  from auth.users account
  where account.id = caller_id
  for update;

  if auth_account.id is null
    or auth_account.email_confirmed_at is null
    or auth_account.is_anonymous
    or auth_account.deleted_at is not null
    or (
      auth_account.banned_until is not null
      and auth_account.banned_until > now()
    )
  then
    raise exception using
      errcode = '42501',
      message = 'confirmed_standard_account_required';
  end if;

  select profile.*
  into caller_profile
  from public.profiles profile
  where profile.id = caller_id
  for update;

  select access_request.*
  into locked_request
  from app_private.teacher_access_requests access_request
  where access_request.user_id = caller_id
  for update;

  select teacher_entitlement.*
  into entitlement
  from app_private.teacher_entitlements teacher_entitlement
  where teacher_entitlement.user_id = caller_id
  for update;

  if caller_profile.id is null
    or (
      caller_profile.global_role <> 'student'
      and not (
        caller_profile.global_role = 'teacher'
        and entitlement.user_id is not null
      )
    )
  then
    raise exception using
      errcode = '42501',
      message = 'standard_student_account_required';
  end if;

  if entitlement.user_id is not null
    and entitlement.active
    and (entitlement.expires_at is null or entitlement.expires_at > now())
  then
    raise exception using
      errcode = '23514',
      message = 'teacher_access_already_active';
  end if;

  if locked_request.id is null then
    if expected_revision <> 0 then
      raise exception using
        errcode = '40001',
        message = 'teacher_access_revision_conflict';
    end if;

    insert into app_private.teacher_access_requests (
      user_id,
      status,
      revision,
      requested_at,
      created_at,
      updated_at
    )
    values (caller_id, 'pending', 1, now(), now(), now())
    returning * into locked_request;

    insert into app_private.teacher_access_audit (
      request_id,
      target_user_id,
      actor_user_id,
      action,
      request_revision_before,
      request_revision_after
    )
    values (
      locked_request.id,
      caller_id,
      caller_id,
      'requested',
      null,
      locked_request.revision
    );
  elsif locked_request.status = 'pending' then
    -- Exact-current calls are harmless reads. One-revision-behind calls are
    -- the lost-response replay of the immediately preceding request action.
    if expected_revision not in (
      locked_request.revision,
      locked_request.revision - 1
    ) then
      raise exception using
        errcode = '40001',
        message = 'teacher_access_revision_conflict';
    end if;
  else
    if expected_revision <> locked_request.revision then
      raise exception using
        errcode = '40001',
        message = 'teacher_access_revision_conflict';
    end if;

    previous_revision := locked_request.revision;
    audit_action := 'resubmitted';

    update app_private.teacher_access_requests access_request
    set status = 'pending',
        revision = access_request.revision + 1,
        requested_at = now(),
        decided_at = null,
        decided_by = null,
        approved_max_workspaces = null,
        updated_at = now()
    where access_request.id = locked_request.id
    returning * into locked_request;

    insert into app_private.teacher_access_audit (
      request_id,
      target_user_id,
      actor_user_id,
      action,
      request_revision_before,
      request_revision_after,
      entitlement_revision_before,
      entitlement_revision_after
    )
    values (
      locked_request.id,
      caller_id,
      caller_id,
      audit_action,
      previous_revision,
      locked_request.revision,
      entitlement.revision,
      entitlement.revision
    );
  end if;

  request_id := locked_request.id;
  request_status := locked_request.status;
  request_revision := locked_request.revision;
  requested_at := locked_request.requested_at;
  updated_at := locked_request.updated_at;
  return next;
end;
$$;

create or replace function public.list_teacher_access_requests_internal(
  target_status text default null,
  requested_page_size integer default 25,
  cursor_updated_at timestamptz default null,
  cursor_id uuid default null
)
returns table (
  request_id uuid,
  page_cursor_id uuid,
  applicant_user_id uuid,
  applicant_name text,
  applicant_email text,
  request_status text,
  request_revision integer,
  requested_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  approved_max_workspaces integer,
  entitlement_active boolean,
  entitlement_revision integer,
  entitlement_max_workspaces integer,
  privileged_workspace_count integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid;
  clean_status text := nullif(lower(btrim(target_status)), '');
  clean_page_size integer := least(greatest(coalesce(requested_page_size, 25), 1), 100);
begin
  caller_id := app_private.lock_active_platform_admin_session();

  if clean_status is not null
    and clean_status not in ('pending', 'approved', 'rejected', 'disabled')
  then
    raise exception using
      errcode = '22023',
      message = 'teacher_access_status_invalid';
  end if;

  if (cursor_updated_at is null) <> (cursor_id is null) then
    raise exception using
      errcode = '22023',
      message = 'teacher_access_cursor_invalid';
  end if;

  return query
  with inventory_users as materialized (
    select access_request.user_id
    from app_private.teacher_access_requests access_request
    union
    select teacher_entitlement.user_id
    from app_private.teacher_entitlements teacher_entitlement
  ),
  inventory_rows as materialized (
    select
      access_request.id as request_id,
      coalesce(access_request.id, inventory_user.user_id) as page_cursor_id,
      inventory_user.user_id as applicant_user_id,
      profile.full_name as applicant_name,
      profile.email as applicant_email,
      coalesce(
        access_request.status,
        case
          when teacher_entitlement.active
            and (
              teacher_entitlement.expires_at is null
              or teacher_entitlement.expires_at > now()
            )
          then 'approved'
          else 'disabled'
        end
      ) as request_status,
      access_request.revision as request_revision,
      access_request.requested_at,
      access_request.decided_at,
      coalesce(access_request.decided_by, teacher_entitlement.granted_by)
        as decided_by,
      coalesce(
        access_request.approved_max_workspaces,
        teacher_entitlement.max_workspaces
      )::integer as approved_max_workspaces,
      coalesce(
        teacher_entitlement.active
          and (
            teacher_entitlement.expires_at is null
            or teacher_entitlement.expires_at > now()
          ),
        false
      ) as entitlement_active,
      teacher_entitlement.revision as entitlement_revision,
      teacher_entitlement.max_workspaces::integer
        as entitlement_max_workspaces,
      coalesce(privileged_memberships.workspace_count, 0)::integer
        as privileged_workspace_count,
      greatest(
        coalesce(access_request.updated_at, '-infinity'::timestamptz),
        coalesce(teacher_entitlement.updated_at, '-infinity'::timestamptz)
      ) as row_updated_at
    from inventory_users inventory_user
    left join app_private.teacher_access_requests access_request
      on access_request.user_id = inventory_user.user_id
    left join app_private.teacher_entitlements teacher_entitlement
      on teacher_entitlement.user_id = inventory_user.user_id
    left join public.profiles profile
      on profile.id = inventory_user.user_id
    left join lateral (
      select count(*)::integer as workspace_count
      from public.workspace_members membership
      where membership.user_id = inventory_user.user_id
        and membership.role in ('owner', 'teacher')
    ) privileged_memberships on true
    where coalesce(profile.global_role, 'student') <> 'platform_admin'
  )
  select
    inventory.request_id,
    inventory.page_cursor_id,
    inventory.applicant_user_id,
    inventory.applicant_name,
    inventory.applicant_email,
    inventory.request_status,
    inventory.request_revision,
    inventory.requested_at,
    inventory.decided_at,
    inventory.decided_by,
    inventory.approved_max_workspaces,
    inventory.entitlement_active,
    inventory.entitlement_revision,
    inventory.entitlement_max_workspaces,
    inventory.privileged_workspace_count,
    inventory.row_updated_at
  from inventory_rows inventory
  where (clean_status is null or inventory.request_status = clean_status)
    and (
      cursor_updated_at is null
      or (inventory.row_updated_at, inventory.page_cursor_id)
        < (cursor_updated_at, cursor_id)
    )
  order by inventory.row_updated_at desc, inventory.page_cursor_id desc
  limit clean_page_size;
end;
$$;

create or replace function public.get_my_teacher_access_request_internal()
returns table (
  request_id uuid,
  request_status text,
  request_revision integer,
  requested_at timestamptz,
  decided_at timestamptz,
  approved_max_workspaces integer,
  entitlement_active boolean,
  entitlement_revision integer,
  entitlement_max_workspaces integer,
  updated_at timestamptz
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
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  return query
  select
    access_request.id,
    access_request.status,
    access_request.revision,
    access_request.requested_at,
    access_request.decided_at,
    access_request.approved_max_workspaces::integer,
    coalesce(
      teacher_entitlement.active
        and (
          teacher_entitlement.expires_at is null
          or teacher_entitlement.expires_at > now()
        ),
      false
    ),
    teacher_entitlement.revision,
    teacher_entitlement.max_workspaces::integer,
    access_request.updated_at
  from app_private.teacher_access_requests access_request
  left join app_private.teacher_entitlements teacher_entitlement
    on teacher_entitlement.user_id = access_request.user_id
  where access_request.user_id = caller_id;
end;
$$;

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
  caller_id uuid;
  clean_decision text := lower(btrim(decision));
  target_user_id uuid;
  auth_account record;
  target_profile public.profiles%rowtype;
  locked_request app_private.teacher_access_requests%rowtype;
  entitlement app_private.teacher_entitlements%rowtype;
  old_entitlement_revision integer;
  old_entitlement_max smallint;
  current_privileged_workspace_count integer;
  target_is_platform_admin boolean := false;
begin
  caller_id := app_private.lock_active_platform_admin_session();

  if target_request_id is null
    or clean_decision is null
    or clean_decision not in ('approved', 'rejected')
    or expected_revision is null
    or expected_revision < 1
    or approved_workspace_limit is null
    or approved_workspace_limit not between 1 and 100
  then
    raise exception using
      errcode = '22023',
      message = 'teacher_access_decision_invalid';
  end if;

  select access_request.user_id
  into target_user_id
  from app_private.teacher_access_requests access_request
  where access_request.id = target_request_id;

  if target_user_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'teacher_access_request_not_found';
  end if;

  perform app_private.lock_teacher_access_account(target_user_id);

  select exists (
    select 1
    from public.profiles profile
    where profile.id = target_user_id
      and profile.global_role = 'platform_admin'
  ) into target_is_platform_admin;

  if clean_decision = 'approved' and target_is_platform_admin then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_teacher_access_decision_forbidden';
  end if;

  -- Rejection only closes the request row and therefore never needs UPDATE
  -- locks on the target account/profile. This also prevents simultaneous
  -- cross-admin stale-request rejections from lock-upgrading each other's
  -- session-held profile rows.
  if clean_decision = 'approved' then
    select
      account.id,
      account.email_confirmed_at,
      coalesce(account.is_anonymous, false) as is_anonymous,
      account.deleted_at,
      account.banned_until
    into auth_account
    from auth.users account
    where account.id = target_user_id
    for update;

    select profile.*
    into target_profile
    from public.profiles profile
    where profile.id = target_user_id
    for update;
  end if;

  select access_request.*
  into locked_request
  from app_private.teacher_access_requests access_request
  where access_request.id = target_request_id
    and access_request.user_id = target_user_id
  for update;

  select teacher_entitlement.*
  into entitlement
  from app_private.teacher_entitlements teacher_entitlement
  where teacher_entitlement.user_id = target_user_id
  for update;

  -- A retry after a lost response is accepted only for the same administrator,
  -- same decision, same request revision, and same approved limit.
  if locked_request.revision = expected_revision + 1
    and locked_request.status = clean_decision
    and locked_request.decided_by = caller_id
    and (
      clean_decision = 'rejected'
      or locked_request.approved_max_workspaces = approved_workspace_limit
    )
  then
    if clean_decision = 'approved' and (
      entitlement.user_id is null
      or not entitlement.active
      or entitlement.max_workspaces <> approved_workspace_limit
    ) then
      raise exception using
        errcode = '40001',
        message = 'teacher_access_state_conflict';
    end if;

    request_id := locked_request.id;
    applicant_user_id := locked_request.user_id;
    request_status := locked_request.status;
    request_revision := locked_request.revision;
    entitlement_revision := entitlement.revision;
    entitlement_max_workspaces := entitlement.max_workspaces::integer;
    decided_at := locked_request.decided_at;
    return next;
    return;
  end if;

  if locked_request.revision <> expected_revision
    or locked_request.status <> 'pending'
  then
    raise exception using
      errcode = '40001',
      message = 'teacher_access_revision_conflict';
  end if;

  -- Rejection is a safe closure action even when an applicant was banned,
  -- deleted, or changed role after applying. Approval alone requires a live,
  -- confirmed standard account. A legacy teacher profile is accepted only
  -- when it already has a private entitlement row, then normalized below.
  if clean_decision = 'approved' and (
    auth_account.id is null
    or auth_account.email_confirmed_at is null
    or auth_account.is_anonymous
    or auth_account.deleted_at is not null
    or (
      auth_account.banned_until is not null
      and auth_account.banned_until > now()
    )
    or target_profile.id is null
    or (
      target_profile.global_role <> 'student'
      and not (
        target_profile.global_role = 'teacher'
        and entitlement.user_id is not null
      )
    )
  ) then
    raise exception using
      errcode = '42501',
      message = 'confirmed_standard_account_required';
  end if;

  old_entitlement_revision := entitlement.revision;
  old_entitlement_max := entitlement.max_workspaces;

  if clean_decision = 'approved' then
    select count(*)::integer
    into current_privileged_workspace_count
    from public.workspace_members membership
    where membership.user_id = target_user_id
      and membership.role in ('owner', 'teacher');

    if approved_workspace_limit < current_privileged_workspace_count then
      raise exception using
        errcode = '23514',
        message = 'teacher_workspace_limit_below_current_usage';
    end if;

    if target_profile.global_role = 'teacher' then
      update public.profiles profile
      set global_role = 'student',
          updated_at = now()
      where profile.id = target_user_id;
    end if;

    if entitlement.user_id is null then
      insert into app_private.teacher_entitlements (
        user_id,
        active,
        max_workspaces,
        granted_by,
        granted_at,
        expires_at,
        note,
        updated_at,
        revision,
        disabled_at,
        disabled_by
      )
      values (
        target_user_id,
        true,
        approved_workspace_limit,
        caller_id,
        now(),
        null,
        'Approved through the platform-admin teacher onboarding workflow.',
        now(),
        1,
        null,
        null
      )
      returning * into entitlement;
    else
      update app_private.teacher_entitlements teacher_entitlement
      set active = true,
          max_workspaces = approved_workspace_limit,
          granted_by = caller_id,
          granted_at = now(),
          expires_at = null,
          note = 'Approved through the platform-admin teacher onboarding workflow.',
          updated_at = now(),
          revision = teacher_entitlement.revision + 1,
          disabled_at = null,
          disabled_by = null
      where teacher_entitlement.user_id = target_user_id
      returning * into entitlement;
    end if;

    update app_private.teacher_access_requests access_request
    set status = 'approved',
        revision = access_request.revision + 1,
        decided_at = now(),
        decided_by = caller_id,
        approved_max_workspaces = approved_workspace_limit,
        updated_at = now()
    where access_request.id = locked_request.id
    returning * into locked_request;
  else
    update app_private.teacher_access_requests access_request
    set status = 'rejected',
        revision = access_request.revision + 1,
        decided_at = now(),
        decided_by = caller_id,
        approved_max_workspaces = null,
        updated_at = now()
    where access_request.id = locked_request.id
    returning * into locked_request;
  end if;

  insert into app_private.teacher_access_audit (
    request_id,
    target_user_id,
    actor_user_id,
    action,
    request_revision_before,
    request_revision_after,
    entitlement_revision_before,
    entitlement_revision_after,
    previous_max_workspaces,
    max_workspaces
  )
  values (
    locked_request.id,
    target_user_id,
    caller_id,
    clean_decision,
    expected_revision,
    locked_request.revision,
    old_entitlement_revision,
    entitlement.revision,
    case
      when clean_decision = 'approved' then old_entitlement_max
      else null
    end,
    case
      when clean_decision = 'approved' then approved_workspace_limit
      else null
    end
  );

  request_id := locked_request.id;
  applicant_user_id := locked_request.user_id;
  request_status := locked_request.status;
  request_revision := locked_request.revision;
  entitlement_revision := entitlement.revision;
  entitlement_max_workspaces := entitlement.max_workspaces::integer;
  decided_at := locked_request.decided_at;
  return next;
end;
$$;

create or replace function public.update_teacher_workspace_limit_internal(
  target_teacher_user_id uuid,
  expected_entitlement_revision integer,
  new_workspace_limit integer
)
returns table (
  updated_user_id uuid,
  entitlement_revision integer,
  entitlement_max_workspaces integer,
  request_revision integer,
  current_privileged_workspace_count integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid;
  target_profile public.profiles%rowtype;
  locked_request app_private.teacher_access_requests%rowtype;
  entitlement app_private.teacher_entitlements%rowtype;
  replay_audit app_private.teacher_access_audit%rowtype;
  old_request_revision integer;
  old_entitlement_revision integer;
  old_workspace_limit smallint;
  privileged_count integer;
begin
  caller_id := app_private.lock_active_platform_admin_session();

  if target_teacher_user_id is null
    or expected_entitlement_revision is null
    or expected_entitlement_revision < 1
    or new_workspace_limit is null
    or new_workspace_limit not between 1 and 100
  then
    raise exception using
      errcode = '22023',
      message = 'teacher_workspace_limit_invalid';
  end if;

  if target_teacher_user_id = caller_id then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_teacher_limit_forbidden';
  end if;

  perform app_private.lock_teacher_access_account(target_teacher_user_id);

  -- Reject administrator targets before taking UPDATE locks on their Auth or
  -- profile rows. Two administrators making simultaneous forbidden cross-
  -- target calls therefore cannot each hold their own session rows while
  -- waiting to upgrade the other administrator's profile lock.
  if exists (
    select 1
    from public.profiles profile
    where profile.id = target_teacher_user_id
      and profile.global_role = 'platform_admin'
  ) then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_teacher_limit_forbidden';
  end if;

  select profile.*
  into target_profile
  from public.profiles profile
  where profile.id = target_teacher_user_id
  for update;

  if target_profile.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'teacher_access_user_not_found';
  end if;

  if target_profile.global_role = 'platform_admin' then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_teacher_limit_forbidden';
  end if;

  select access_request.*
  into locked_request
  from app_private.teacher_access_requests access_request
  where access_request.user_id = target_teacher_user_id
  for update;

  select teacher_entitlement.*
  into entitlement
  from app_private.teacher_entitlements teacher_entitlement
  where teacher_entitlement.user_id = target_teacher_user_id
  for update;

  if entitlement.user_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'teacher_entitlement_not_found';
  end if;

  select count(*)::integer
  into privileged_count
  from public.workspace_members membership
  where membership.user_id = target_teacher_user_id
    and membership.role in ('owner', 'teacher');

  if entitlement.revision = expected_entitlement_revision + 1
    and entitlement.max_workspaces = new_workspace_limit
  then
    select audit_row.*
    into replay_audit
    from app_private.teacher_access_audit audit_row
    where audit_row.target_user_id = target_teacher_user_id
      and audit_row.actor_user_id = caller_id
      and audit_row.action = 'workspace_limit_updated'
      and audit_row.entitlement_revision_before = expected_entitlement_revision
      and audit_row.entitlement_revision_after = entitlement.revision
      and audit_row.max_workspaces = new_workspace_limit
    order by audit_row.occurred_at desc, audit_row.id desc
    limit 1;

    if replay_audit.id is not null then
      updated_user_id := target_teacher_user_id;
      entitlement_revision := entitlement.revision;
      entitlement_max_workspaces := entitlement.max_workspaces::integer;
      request_revision := replay_audit.request_revision_after;
      current_privileged_workspace_count := privileged_count;
      updated_at := entitlement.updated_at;
      return next;
      return;
    end if;
  end if;

  if entitlement.revision <> expected_entitlement_revision then
    raise exception using
      errcode = '40001',
      message = 'teacher_entitlement_revision_conflict';
  end if;

  if new_workspace_limit < privileged_count then
    raise exception using
      errcode = '23514',
      message = 'teacher_workspace_limit_below_current_usage';
  end if;

  old_request_revision := locked_request.revision;
  old_entitlement_revision := entitlement.revision;
  old_workspace_limit := entitlement.max_workspaces;

  update app_private.teacher_entitlements teacher_entitlement
  set max_workspaces = new_workspace_limit,
      revision = teacher_entitlement.revision + 1,
      updated_at = now()
  where teacher_entitlement.user_id = target_teacher_user_id
  returning * into entitlement;

  if locked_request.id is not null
    and locked_request.status in ('approved', 'disabled')
  then
    update app_private.teacher_access_requests access_request
    set approved_max_workspaces = new_workspace_limit,
        revision = access_request.revision + 1,
        updated_at = now()
    where access_request.id = locked_request.id
    returning * into locked_request;
  end if;

  insert into app_private.teacher_access_audit (
    request_id,
    target_user_id,
    actor_user_id,
    action,
    request_revision_before,
    request_revision_after,
    entitlement_revision_before,
    entitlement_revision_after,
    previous_max_workspaces,
    max_workspaces
  )
  values (
    locked_request.id,
    target_teacher_user_id,
    caller_id,
    'workspace_limit_updated',
    old_request_revision,
    locked_request.revision,
    old_entitlement_revision,
    entitlement.revision,
    old_workspace_limit,
    entitlement.max_workspaces
  );

  updated_user_id := target_teacher_user_id;
  entitlement_revision := entitlement.revision;
  entitlement_max_workspaces := entitlement.max_workspaces::integer;
  request_revision := locked_request.revision;
  current_privileged_workspace_count := privileged_count;
  updated_at := entitlement.updated_at;
  return next;
end;
$$;

create or replace function public.disable_teacher_access_internal(
  target_teacher_user_id uuid,
  expected_entitlement_revision integer
)
returns table (
  disabled_user_id uuid,
  entitlement_revision integer,
  request_revision integer,
  transferred_workspace_count integer,
  removed_privileged_membership_count integer,
  disabled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid;
  target_profile public.profiles%rowtype;
  locked_request app_private.teacher_access_requests%rowtype;
  entitlement app_private.teacher_entitlements%rowtype;
  replay_audit app_private.teacher_access_audit%rowtype;
  owned_workspace record;
  transfer_count integer := 0;
  removed_count integer := 0;
  previous_request_revision integer;
  transferred_workspace_ids uuid[] := '{}'::uuid[];
  disable_audit_id uuid;
begin
  caller_id := app_private.lock_active_platform_admin_session();

  if target_teacher_user_id is null
    or expected_entitlement_revision is null
    or expected_entitlement_revision < 1
  then
    raise exception using
      errcode = '22023',
      message = 'teacher_access_disable_invalid';
  end if;

  if target_teacher_user_id = caller_id then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_self_disable_forbidden';
  end if;

  perform app_private.lock_teacher_access_account(target_teacher_user_id);

  if exists (
    select 1
    from public.profiles profile
    where profile.id = target_teacher_user_id
      and profile.global_role = 'platform_admin'
  ) then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_disable_forbidden';
  end if;

  perform 1
  from auth.users account
  where account.id = target_teacher_user_id
  for update;

  select profile.*
  into target_profile
  from public.profiles profile
  where profile.id = target_teacher_user_id
  for update;

  if target_profile.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'teacher_access_user_not_found';
  end if;

  if target_profile.global_role = 'platform_admin' then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_disable_forbidden';
  end if;

  if target_profile.global_role = 'teacher' then
    update public.profiles profile
    set global_role = 'student',
        updated_at = now()
    where profile.id = target_teacher_user_id
    returning * into target_profile;
  end if;

  select access_request.*
  into locked_request
  from app_private.teacher_access_requests access_request
  where access_request.user_id = target_teacher_user_id
  for update;

  select teacher_entitlement.*
  into entitlement
  from app_private.teacher_entitlements teacher_entitlement
  where teacher_entitlement.user_id = target_teacher_user_id
  for update;

  if entitlement.user_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'teacher_entitlement_not_found';
  end if;

  if not entitlement.active
    and entitlement.revision = expected_entitlement_revision + 1
  then
    select audit_row.*
    into replay_audit
    from app_private.teacher_access_audit audit_row
    where audit_row.target_user_id = target_teacher_user_id
      and audit_row.actor_user_id = caller_id
      and audit_row.action = 'disabled'
      and audit_row.entitlement_revision_before = expected_entitlement_revision
      and audit_row.entitlement_revision_after = entitlement.revision
    order by audit_row.occurred_at desc, audit_row.id desc
    limit 1;

    if replay_audit.id is not null then
      disabled_user_id := target_teacher_user_id;
      entitlement_revision := entitlement.revision;
      request_revision := replay_audit.request_revision_after;
      transferred_workspace_count := replay_audit.transferred_workspace_count;
      removed_privileged_membership_count :=
        replay_audit.removed_privileged_membership_count;
      disabled_at := entitlement.disabled_at;
      return next;
      return;
    end if;
  end if;

  if entitlement.revision <> expected_entitlement_revision
    or not entitlement.active
  then
    raise exception using
      errcode = '40001',
      message = 'teacher_entitlement_revision_conflict';
  end if;

  -- The entitlement row lock serializes against workspace creation. Workspaces
  -- are then locked in UUID order before ownership and membership change.
  for owned_workspace in
    select workspace.id
    from public.workspaces workspace
    where workspace.owner_id = target_teacher_user_id
    order by workspace.id
    for update
  loop
    insert into public.workspace_members (workspace_id, user_id, role)
    values (owned_workspace.id, caller_id, 'owner')
    on conflict (workspace_id, user_id) do update
    set role = 'owner';

    update public.workspaces workspace
    set owner_id = caller_id,
        updated_at = now()
    where workspace.id = owned_workspace.id;

    transfer_count := transfer_count + 1;
    transferred_workspace_ids :=
      array_append(transferred_workspace_ids, owned_workspace.id);
  end loop;

  delete from public.workspace_members membership
  where membership.user_id = target_teacher_user_id
    and membership.role in ('owner', 'teacher');
  get diagnostics removed_count = row_count;

  update app_private.teacher_entitlements teacher_entitlement
  set active = false,
      updated_at = now(),
      revision = teacher_entitlement.revision + 1,
      disabled_at = now(),
      disabled_by = caller_id
  where teacher_entitlement.user_id = target_teacher_user_id
  returning * into entitlement;

  previous_request_revision := locked_request.revision;

  if locked_request.id is not null then
    update app_private.teacher_access_requests access_request
    set status = 'disabled',
        revision = access_request.revision + 1,
        decided_at = now(),
        decided_by = caller_id,
        updated_at = now()
    where access_request.id = locked_request.id
    returning * into locked_request;
  end if;

  insert into app_private.teacher_access_audit (
    request_id,
    target_user_id,
    actor_user_id,
    action,
    request_revision_before,
    request_revision_after,
    entitlement_revision_before,
    entitlement_revision_after,
    previous_max_workspaces,
    max_workspaces,
    transferred_workspace_count,
    removed_privileged_membership_count
  )
  values (
    locked_request.id,
    target_teacher_user_id,
    caller_id,
    'disabled',
    previous_request_revision,
    locked_request.revision,
    expected_entitlement_revision,
    entitlement.revision,
    entitlement.max_workspaces,
    entitlement.max_workspaces,
    transfer_count,
    removed_count
  )
  returning id into disable_audit_id;

  insert into app_private.teacher_access_workspace_transfers (
    audit_id,
    workspace_id,
    previous_owner_user_id,
    new_owner_user_id,
    transferred_at
  )
  select
    disable_audit_id,
    transferred_workspace_id,
    target_teacher_user_id,
    caller_id,
    entitlement.disabled_at
  from unnest(transferred_workspace_ids) transferred_workspace_id;

  disabled_user_id := target_teacher_user_id;
  entitlement_revision := entitlement.revision;
  request_revision := locked_request.revision;
  transferred_workspace_count := transfer_count;
  removed_privileged_membership_count := removed_count;
  disabled_at := entitlement.disabled_at;
  return next;
end;
$$;

create or replace function public.get_teacher_onboarding_health_internal()
returns table (
  pending_request_count bigint,
  approved_request_count bigint,
  rejected_request_count bigint,
  disabled_request_count bigint,
  active_entitlement_count bigint,
  inactive_or_expired_entitlement_count bigint,
  privileged_membership_count bigint,
  owned_workspace_count bigint,
  owned_workspace_without_active_access_count bigint,
  privileged_membership_without_active_access_count bigint,
  generated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid;
begin
  caller_id := app_private.lock_active_platform_admin_session();

  return query
  with non_admin_entitlements as materialized (
    select
      entitlement.user_id,
      entitlement.active
        and (entitlement.expires_at is null or entitlement.expires_at > now())
        as effectively_active
    from app_private.teacher_entitlements entitlement
    left join public.profiles profile on profile.id = entitlement.user_id
    where coalesce(profile.global_role, 'student') <> 'platform_admin'
  ),
  privileged_memberships as materialized (
    select membership.user_id, membership.workspace_id
    from public.workspace_members membership
    where membership.role in ('owner', 'teacher')
  )
  select
    (select count(*) from app_private.teacher_access_requests request
      where request.status = 'pending'),
    (select count(*) from app_private.teacher_access_requests request
      where request.status = 'approved'),
    (select count(*) from app_private.teacher_access_requests request
      where request.status = 'rejected'),
    (select count(*) from app_private.teacher_access_requests request
      where request.status = 'disabled'),
    (select count(*) from non_admin_entitlements entitlement
      where entitlement.effectively_active),
    (select count(*) from non_admin_entitlements entitlement
      where not entitlement.effectively_active),
    (select count(*) from privileged_memberships),
    (select count(*) from public.workspaces),
    (
      select count(*)
      from public.workspaces workspace
      left join non_admin_entitlements entitlement
        on entitlement.user_id = workspace.owner_id
      left join public.profiles profile on profile.id = workspace.owner_id
      where coalesce(profile.global_role, 'student') <> 'platform_admin'
        and not coalesce(entitlement.effectively_active, false)
    ),
    (
      select count(*)
      from privileged_memberships membership
      left join non_admin_entitlements entitlement
        on entitlement.user_id = membership.user_id
      left join public.profiles profile on profile.id = membership.user_id
      where coalesce(profile.global_role, 'student') <> 'platform_admin'
        and not coalesce(entitlement.effectively_active, false)
    ),
    now();
end;
$$;

revoke all on function public.request_teacher_access_internal(integer)
from public, anon, authenticated, service_role;
revoke all on function public.get_my_teacher_access_request_internal()
from public, anon, authenticated, service_role;
revoke all on function public.list_teacher_access_requests_internal(
  text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.decide_teacher_access_internal(
  uuid, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.update_teacher_workspace_limit_internal(
  uuid, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.disable_teacher_access_internal(uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function public.get_teacher_onboarding_health_internal()
from public, anon, authenticated, service_role;

grant execute on function public.request_teacher_access_internal(integer)
to authenticated;
grant execute on function public.get_my_teacher_access_request_internal()
to authenticated;
grant execute on function public.list_teacher_access_requests_internal(
  text, integer, timestamptz, uuid
) to authenticated;
grant execute on function public.decide_teacher_access_internal(
  uuid, text, integer, integer
) to authenticated;
grant execute on function public.update_teacher_workspace_limit_internal(
  uuid, integer, integer
) to authenticated;
grant execute on function public.disable_teacher_access_internal(uuid, integer)
to authenticated;
grant execute on function public.get_teacher_onboarding_health_internal()
to authenticated;

-- Deliberately exposed Data API facades never acquire owner privileges. The
-- non-exposed implementations above perform the authenticated authorization.
create or replace function api.request_teacher_access(
  expected_revision integer default 0
)
returns table (
  request_id uuid,
  request_status text,
  request_revision integer,
  requested_at timestamptz,
  updated_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.request_teacher_access_internal(expected_revision);
$$;

create or replace function api.get_my_teacher_access_request()
returns table (
  request_id uuid,
  request_status text,
  request_revision integer,
  requested_at timestamptz,
  decided_at timestamptz,
  approved_max_workspaces integer,
  entitlement_active boolean,
  entitlement_revision integer,
  entitlement_max_workspaces integer,
  updated_at timestamptz
)
language sql
security invoker
set search_path = ''
stable
as $$
  select * from public.get_my_teacher_access_request_internal();
$$;

create or replace function api.list_teacher_access_requests(
  target_status text default null,
  requested_page_size integer default 25,
  cursor_updated_at timestamptz default null,
  cursor_id uuid default null
)
returns table (
  request_id uuid,
  page_cursor_id uuid,
  applicant_user_id uuid,
  applicant_name text,
  applicant_email text,
  request_status text,
  request_revision integer,
  requested_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  approved_max_workspaces integer,
  entitlement_active boolean,
  entitlement_revision integer,
  entitlement_max_workspaces integer,
  privileged_workspace_count integer,
  updated_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.list_teacher_access_requests_internal(
    target_status,
    requested_page_size,
    cursor_updated_at,
    cursor_id
  );
$$;

create or replace function api.decide_teacher_access(
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
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.decide_teacher_access_internal(
    target_request_id,
    decision,
    expected_revision,
    approved_workspace_limit
  );
$$;

create or replace function api.update_teacher_workspace_limit(
  target_teacher_user_id uuid,
  expected_entitlement_revision integer,
  new_workspace_limit integer
)
returns table (
  updated_user_id uuid,
  entitlement_revision integer,
  entitlement_max_workspaces integer,
  request_revision integer,
  current_privileged_workspace_count integer,
  updated_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.update_teacher_workspace_limit_internal(
    target_teacher_user_id,
    expected_entitlement_revision,
    new_workspace_limit
  );
$$;

create or replace function api.disable_teacher_access(
  target_teacher_user_id uuid,
  expected_entitlement_revision integer
)
returns table (
  disabled_user_id uuid,
  entitlement_revision integer,
  request_revision integer,
  transferred_workspace_count integer,
  removed_privileged_membership_count integer,
  disabled_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.disable_teacher_access_internal(
    target_teacher_user_id,
    expected_entitlement_revision
  );
$$;

create or replace function api.get_teacher_onboarding_health()
returns table (
  pending_request_count bigint,
  approved_request_count bigint,
  rejected_request_count bigint,
  disabled_request_count bigint,
  active_entitlement_count bigint,
  inactive_or_expired_entitlement_count bigint,
  privileged_membership_count bigint,
  owned_workspace_count bigint,
  owned_workspace_without_active_access_count bigint,
  privileged_membership_without_active_access_count bigint,
  generated_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select * from public.get_teacher_onboarding_health_internal();
$$;

revoke all on function api.request_teacher_access(integer)
from public, anon, authenticated, service_role;
revoke all on function api.get_my_teacher_access_request()
from public, anon, authenticated, service_role;
revoke all on function api.list_teacher_access_requests(
  text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function api.decide_teacher_access(uuid, text, integer, integer)
from public, anon, authenticated, service_role;
revoke all on function api.update_teacher_workspace_limit(uuid, integer, integer)
from public, anon, authenticated, service_role;
revoke all on function api.disable_teacher_access(uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function api.get_teacher_onboarding_health()
from public, anon, authenticated, service_role;

grant execute on function api.request_teacher_access(integer) to authenticated;
grant execute on function api.get_my_teacher_access_request() to authenticated;
grant execute on function api.list_teacher_access_requests(
  text, integer, timestamptz, uuid
) to authenticated;
grant execute on function api.decide_teacher_access(
  uuid, text, integer, integer
) to authenticated;
grant execute on function api.update_teacher_workspace_limit(
  uuid, integer, integer
) to authenticated;
grant execute on function api.disable_teacher_access(uuid, integer)
to authenticated;
grant execute on function api.get_teacher_onboarding_health()
to authenticated;

comment on function api.request_teacher_access(integer) is
  'Revision-safe application for an email-confirmed standard account. No metadata authorization is used.';
comment on function api.get_my_teacher_access_request() is
  'Self-only request and entitlement status, including the current revisions needed after reload or administrator action.';
comment on function api.list_teacher_access_requests(
  text, integer, timestamptz, uuid
) is
  'Platform-admin-only keyset page with request and entitlement revisions for safe decisions.';
comment on function api.decide_teacher_access(uuid, text, integer, integer) is
  'Platform-admin-only approval or rejection. Approval is the sole browser-accessible entitlement grant path.';
comment on function api.update_teacher_workspace_limit(uuid, integer, integer) is
  'Platform-admin-only revision-safe teacher workspace quota update that cannot undercut current privileged memberships.';
comment on function api.disable_teacher_access(uuid, integer) is
  'Platform-admin-only atomic disable, administrator workspace takeover, and privileged-membership removal.';
comment on function api.get_teacher_onboarding_health() is
  'Platform-admin-only aggregate health. It returns counts only and excludes content, provider payloads, and raw errors.';

notify pgrst, 'reload schema';
