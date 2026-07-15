-- Require a live AAL2 session backed by a recoverable two-factor TOTP set for
-- every platform-administrator privilege. High-impact onboarding mutations
-- additionally require a TOTP verification performed in the last ten minutes.
--
-- The role remains server-owned in public.profiles so an AAL1 administrator
-- can be routed to the MFA flow, but no RLS or RPC administrator bypass is
-- available until these database checks succeed.

create or replace function app_private.has_platform_admin_totp_recovery_set(
  target_user_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select count(*) >= 2
  from auth.mfa_factors factor
  where factor.user_id = target_user_id
    and factor.factor_type = 'totp'
    and factor.status = 'verified';
$$;

revoke all on function app_private.has_platform_admin_totp_recovery_set(uuid)
from public, anon, authenticated, service_role;

-- Fail the migration before replacing any administrator authorization helper
-- if an existing administrator would be locked out by the new invariant. The
-- short table locks keep Auth/profile writes from invalidating the readback
-- between this check and the transactional DDL commit.
create or replace function app_private.assert_platform_admin_mfa_precondition()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  lock table auth.users in share mode;
  lock table auth.mfa_factors in share mode;
  lock table public.profiles in share mode;

  if exists (
    select 1
    from public.profiles profile
    left join auth.users account on account.id = profile.id
    where profile.global_role = 'platform_admin'
      and (
        account.id is null
        or account.email_confirmed_at is null
        or coalesce(account.is_anonymous, false)
        or account.deleted_at is not null
        or account.banned_until > now()
        or not app_private.has_platform_admin_totp_recovery_set(profile.id)
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'platform_admin_mfa_precondition_failed';
  end if;
end;
$$;

revoke all on function app_private.assert_platform_admin_mfa_precondition()
from public, anon, authenticated, service_role;
grant execute on function app_private.assert_platform_admin_mfa_precondition()
to postgres;

-- This statement intentionally aborts the entire transactional migration on
-- a legacy administrator that has not completed the two-factor rollout.
select app_private.assert_platform_admin_mfa_precondition();

create or replace function app_private.current_totp_amr_epoch()
returns bigint
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  amr_claim jsonb := (select auth.jwt() -> 'amr');
  raw_amr_claim text := nullif(
    current_setting('request.jwt.claim.amr', true),
    ''
  );
  method_entry jsonb;
  raw_timestamp text;
  parsed_timestamp bigint;
  latest_totp_epoch bigint;
begin
  if amr_claim is null and raw_amr_claim is not null then
    begin
      amr_claim := raw_amr_claim::jsonb;
    exception when others then
      return null;
    end;
  end if;

  if jsonb_typeof(amr_claim) is distinct from 'array' then
    return null;
  end if;

  for method_entry in
    select entry.value
    from jsonb_array_elements(amr_claim) entry(value)
  loop
    if jsonb_typeof(method_entry) = 'object'
      and method_entry ->> 'method' = 'totp'
      and jsonb_typeof(method_entry -> 'timestamp') = 'number'
    then
      raw_timestamp := method_entry ->> 'timestamp';
      if raw_timestamp ~ '^[0-9]{1,12}$' then
        parsed_timestamp := raw_timestamp::bigint;
        if latest_totp_epoch is null
          or parsed_timestamp > latest_totp_epoch
        then
          latest_totp_epoch := parsed_timestamp;
        end if;
      end if;
    end if;
  end loop;

  return latest_totp_epoch;
end;
$$;

revoke all on function app_private.current_totp_amr_epoch()
from public, anon, authenticated, service_role;

create or replace function app_private.is_platform_admin()
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_id uuid := (select auth.uid());
  session_claim text := coalesce(
    nullif((select auth.jwt() ->> 'session_id'), ''),
    nullif(current_setting('request.jwt.claim.session_id', true), '')
  );
  aal_claim text := coalesce(
    nullif((select auth.jwt() ->> 'aal'), ''),
    nullif(current_setting('request.jwt.claim.aal', true), '')
  );
begin
  if caller_id is null
    or session_claim is null
    or session_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or aal_claim <> 'aal2'
  then
    return false;
  end if;

  return exists (
    select 1
    from auth.users account
    join public.profiles profile on profile.id = account.id
    join auth.sessions auth_session
      on auth_session.user_id = account.id
     and auth_session.id::text = lower(session_claim)
    where account.id = caller_id
      and account.email_confirmed_at is not null
      and not coalesce(account.is_anonymous, false)
      and account.deleted_at is null
      and (account.banned_until is null or account.banned_until <= now())
      and profile.global_role = 'platform_admin'
      and (auth_session.not_after is null or auth_session.not_after > now())
      and app_private.has_platform_admin_totp_recovery_set(account.id)
  );
end;
$$;

revoke all on function app_private.is_platform_admin()
from public, anon, authenticated, service_role;

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
  aal_claim text := coalesce(
    nullif((select auth.jwt() ->> 'aal'), ''),
    nullif(current_setting('request.jwt.claim.aal', true), '')
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

  if aal_claim <> 'aal2' then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_mfa_required';
  end if;

  perform 1
  from auth.mfa_factors factor
  where factor.user_id = verified_id
    and factor.factor_type = 'totp'
    and factor.status = 'verified'
  for share of factor;

  if not app_private.has_platform_admin_totp_recovery_set(verified_id) then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_mfa_required';
  end if;

  return verified_id;
end;
$$;

revoke all on function app_private.lock_active_platform_admin_session()
from public, anon, authenticated, service_role;

create or replace function app_private.lock_fresh_platform_admin_session()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid;
  latest_totp_epoch bigint;
  current_epoch bigint := floor(
    extract(epoch from clock_timestamp())
  )::bigint;
begin
  caller_id := app_private.lock_active_platform_admin_session();
  latest_totp_epoch := app_private.current_totp_amr_epoch();

  if latest_totp_epoch is null
    or latest_totp_epoch < current_epoch - 600
    or latest_totp_epoch > current_epoch
  then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_fresh_authentication_required';
  end if;

  return caller_id;
end;
$$;

revoke all on function app_private.lock_fresh_platform_admin_session()
from public, anon, authenticated, service_role;

comment on function app_private.is_platform_admin() is
  'True only for a live, confirmed platform-administrator session at AAL2 with two verified TOTP factors.';
comment on function app_private.lock_fresh_platform_admin_session() is
  'Locks a live AAL2 administrator session and requires a server-verified TOTP AMR timestamp no older than ten minutes.';

-- Promotion remains a server-owned profile transition. Even an already
-- elevated administrator cannot promote a target that lacks the required
-- primary and backup verified TOTP factors.
create or replace function public.prevent_profile_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  email_sync_allowed boolean :=
    coalesce(current_setting('app.allow_profile_email_sync', true), '') = 'on';
  bootstrap_target text := nullif(
    current_setting('app.platform_admin_bootstrap_target', true),
    ''
  );
  recovery_demote_target text := nullif(
    current_setting('app.platform_admin_recovery_demote_target', true),
    ''
  );
  recovery_restore_target text := nullif(
    current_setting('app.platform_admin_recovery_restore_target', true),
    ''
  );
begin
  if new.global_role is distinct from old.global_role
    and new.global_role = 'platform_admin'
    and not app_private.has_platform_admin_totp_recovery_set(new.id)
  then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_two_verified_totp_factors_required';
  end if;

  -- The only no-admin bootstrap path is the private function below. Its
  -- transaction-local target marker is accepted only from a direct postgres
  -- owner session with no end-user JWT, never from PostgREST/authenticated.
  if new.global_role is distinct from old.global_role
    and new.global_role = 'platform_admin'
    and (
      bootstrap_target = new.id::text
      or recovery_restore_target = new.id::text
    )
    and session_user::text = 'postgres'
    and (select auth.uid()) is null
  then
    return new;
  end if;

  if new.global_role is distinct from old.global_role
    and old.global_role = 'platform_admin'
    and new.global_role = 'student'
    and recovery_demote_target = new.id::text
    and session_user::text = 'postgres'
    and (select auth.uid()) is null
  then
    return new;
  end if;

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

revoke all on function public.prevent_profile_role_escalation()
from public, anon, service_role;
grant execute on function public.prevent_profile_role_escalation()
to authenticated;

create table app_private.platform_admin_security_audit (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null,
  action text not null check (action in (
    'first_admin_bootstrapped',
    'admin_recovery_demoted',
    'admin_recovery_restored'
  )),
  verified_totp_factor_count smallint not null
    check (verified_totp_factor_count >= 0),
  database_actor text not null,
  occurred_at timestamptz not null default now()
);

alter table app_private.platform_admin_security_audit enable row level security;
revoke all on table app_private.platform_admin_security_audit
from public, anon, authenticated, service_role;

comment on table app_private.platform_admin_security_audit is
  'Content-free evidence for the one-time, database-owner first-administrator bootstrap.';

create or replace function app_private.reject_platform_admin_security_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'platform_admin_security_audit_immutable';
end;
$$;

revoke all on function app_private.reject_platform_admin_security_audit_mutation()
from public, anon, authenticated, service_role;

create trigger platform_admin_security_audit_immutable
before update or delete on app_private.platform_admin_security_audit
for each row execute function
  app_private.reject_platform_admin_security_audit_mutation();

create or replace function app_private.bootstrap_first_platform_admin(
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_factor_count integer;
  promoted_count integer;
begin
  if session_user::text <> 'postgres'
    or (select auth.uid()) is not null
    or target_user_id is null
  then
    raise exception using
      errcode = '42501',
      message = 'database_owner_bootstrap_required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('platform-admin:first-bootstrap', 0)
  );

  if exists (
    select 1
    from public.profiles profile
    where profile.global_role = 'platform_admin'
  ) then
    raise exception using
      errcode = '42501',
      message = 'first_platform_admin_already_exists';
  end if;

  if not exists (
    select 1
    from auth.users account
    join public.profiles profile on profile.id = account.id
    where account.id = target_user_id
      and account.email_confirmed_at is not null
      and not coalesce(account.is_anonymous, false)
      and account.deleted_at is null
      and (account.banned_until is null or account.banned_until <= now())
      and profile.global_role = 'student'
  ) then
    raise exception using
      errcode = '42501',
      message = 'confirmed_standard_bootstrap_account_required';
  end if;

  select count(*)::integer
  into target_factor_count
  from auth.mfa_factors factor
  where factor.user_id = target_user_id
    and factor.factor_type = 'totp'
    and factor.status = 'verified';

  if target_factor_count < 2 then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_two_verified_totp_factors_required';
  end if;

  perform set_config(
    'app.platform_admin_bootstrap_target',
    target_user_id::text,
    true
  );

  update public.profiles profile
  set global_role = 'platform_admin',
      updated_at = now()
  where profile.id = target_user_id
    and profile.global_role = 'student';
  get diagnostics promoted_count = row_count;

  perform set_config('app.platform_admin_bootstrap_target', '', true);

  if promoted_count <> 1 then
    raise exception using
      errcode = '40001',
      message = 'platform_admin_bootstrap_conflict';
  end if;

  insert into app_private.platform_admin_security_audit (
    target_user_id,
    action,
    verified_totp_factor_count,
    database_actor
  )
  values (
    target_user_id,
    'first_admin_bootstrapped',
    target_factor_count,
    session_user::text
  );
end;
$$;

revoke all on function app_private.bootstrap_first_platform_admin(uuid)
from public, anon, authenticated, service_role;
grant execute on function app_private.bootstrap_first_platform_admin(uuid)
to postgres;

create or replace function app_private.demote_platform_admin_for_mfa_recovery(
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_factor_count integer;
  demoted_count integer;
begin
  if session_user::text <> 'postgres'
    or (select auth.uid()) is not null
    or target_user_id is null
  then
    raise exception using
      errcode = '42501',
      message = 'database_owner_recovery_required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('platform-admin:mfa-recovery:' || target_user_id::text, 0)
  );

  select count(*)::integer
  into target_factor_count
  from auth.mfa_factors factor
  where factor.user_id = target_user_id
    and factor.factor_type = 'totp'
    and factor.status = 'verified';

  perform set_config(
    'app.platform_admin_recovery_demote_target',
    target_user_id::text,
    true
  );

  update public.profiles profile
  set global_role = 'student',
      updated_at = now()
  where profile.id = target_user_id
    and profile.global_role = 'platform_admin';
  get diagnostics demoted_count = row_count;

  perform set_config(
    'app.platform_admin_recovery_demote_target',
    '',
    true
  );

  if demoted_count <> 1 then
    raise exception using
      errcode = 'P0002',
      message = 'platform_admin_recovery_target_not_found';
  end if;

  insert into app_private.platform_admin_security_audit (
    target_user_id,
    action,
    verified_totp_factor_count,
    database_actor
  )
  values (
    target_user_id,
    'admin_recovery_demoted',
    target_factor_count,
    session_user::text
  );
end;
$$;

create or replace function app_private.restore_platform_admin_after_mfa_recovery(
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_factor_count integer;
  restored_count integer;
begin
  if session_user::text <> 'postgres'
    or (select auth.uid()) is not null
    or target_user_id is null
  then
    raise exception using
      errcode = '42501',
      message = 'database_owner_recovery_required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('platform-admin:mfa-recovery:' || target_user_id::text, 0)
  );

  if not exists (
    select 1
    from app_private.platform_admin_security_audit audit_row
    where audit_row.target_user_id = target_user_id
      and audit_row.action = 'admin_recovery_demoted'
  ) then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_recovery_demote_evidence_required';
  end if;

  if not exists (
    select 1
    from auth.users account
    join public.profiles profile on profile.id = account.id
    where account.id = target_user_id
      and account.email_confirmed_at is not null
      and not coalesce(account.is_anonymous, false)
      and account.deleted_at is null
      and (account.banned_until is null or account.banned_until <= now())
      and profile.global_role = 'student'
  ) then
    raise exception using
      errcode = '42501',
      message = 'confirmed_standard_recovery_account_required';
  end if;

  select count(*)::integer
  into target_factor_count
  from auth.mfa_factors factor
  where factor.user_id = target_user_id
    and factor.factor_type = 'totp'
    and factor.status = 'verified';

  if target_factor_count < 2 then
    raise exception using
      errcode = '42501',
      message = 'platform_admin_two_verified_totp_factors_required';
  end if;

  perform set_config(
    'app.platform_admin_recovery_restore_target',
    target_user_id::text,
    true
  );

  update public.profiles profile
  set global_role = 'platform_admin',
      updated_at = now()
  where profile.id = target_user_id
    and profile.global_role = 'student';
  get diagnostics restored_count = row_count;

  perform set_config(
    'app.platform_admin_recovery_restore_target',
    '',
    true
  );

  if restored_count <> 1 then
    raise exception using
      errcode = '40001',
      message = 'platform_admin_recovery_restore_conflict';
  end if;

  insert into app_private.platform_admin_security_audit (
    target_user_id,
    action,
    verified_totp_factor_count,
    database_actor
  )
  values (
    target_user_id,
    'admin_recovery_restored',
    target_factor_count,
    session_user::text
  );
end;
$$;

revoke all on function app_private.demote_platform_admin_for_mfa_recovery(uuid)
from public, anon, authenticated, service_role;
revoke all on function app_private.restore_platform_admin_after_mfa_recovery(uuid)
from public, anon, authenticated, service_role;
grant execute on function app_private.demote_platform_admin_for_mfa_recovery(uuid)
to postgres;
grant execute on function app_private.restore_platform_admin_after_mfa_recovery(uuid)
to postgres;

-- Teacher authority expires at request time, not only after an administrator
-- happens to clean up the denormalized membership rows. Student memberships
-- remain unaffected.
create or replace function app_private.has_effective_teacher_access(
  target_user_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from app_private.teacher_entitlements entitlement
    join auth.users account on account.id = entitlement.user_id
    join public.profiles profile on profile.id = entitlement.user_id
    where entitlement.user_id = target_user_id
      and entitlement.active
      and (
        entitlement.expires_at is null
        or entitlement.expires_at > now()
      )
      and account.email_confirmed_at is not null
      and not coalesce(account.is_anonymous, false)
      and account.deleted_at is null
      and (account.banned_until is null or account.banned_until <= now())
      and profile.global_role <> 'platform_admin'
  );
$$;

revoke all on function app_private.has_effective_teacher_access(uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.is_workspace_member(
  target_workspace_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = (select auth.uid())
      and (
        membership.role = 'student'
        or app_private.has_effective_teacher_access(membership.user_id)
        or app_private.is_platform_admin()
      )
  );
$$;

create or replace function app_private.has_workspace_role(
  target_workspace_id uuid,
  allowed_roles text[]
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = (select auth.uid())
      and membership.role = any(allowed_roles)
      and (
        membership.role = 'student'
        or app_private.has_effective_teacher_access(membership.user_id)
        or app_private.is_platform_admin()
      )
  );
$$;

revoke all on function app_private.is_workspace_member(uuid)
from public, anon, authenticated, service_role;
revoke all on function app_private.has_workspace_role(uuid, text[])
from public, anon, authenticated, service_role;

create or replace function app_private.lock_feedback_teacher_membership(
  target_workspace_id uuid,
  target_actor_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  membership_found boolean := false;
begin
  if target_actor_id is distinct from (select auth.uid()) then
    return false;
  end if;

  if app_private.is_platform_admin() then
    select true
    into membership_found
    from public.workspace_members membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = target_actor_id
      and membership.role in ('owner', 'teacher')
    for share of membership;

    return coalesce(membership_found, false);
  end if;

  select true
  into membership_found
  from public.workspace_members membership
  join app_private.teacher_entitlements entitlement
    on entitlement.user_id = membership.user_id
  join auth.users account on account.id = membership.user_id
  join public.profiles profile on profile.id = membership.user_id
  where membership.workspace_id = target_workspace_id
    and membership.user_id = target_actor_id
    and membership.role in ('owner', 'teacher')
    and entitlement.active
    and (
      entitlement.expires_at is null
      or entitlement.expires_at > now()
    )
    and account.email_confirmed_at is not null
    and not coalesce(account.is_anonymous, false)
    and account.deleted_at is null
    and (account.banned_until is null or account.banned_until <= now())
    and profile.global_role <> 'platform_admin'
  for share of membership, entitlement;

  return coalesce(membership_found, false);
end;
$$;

revoke all on function app_private.lock_feedback_teacher_membership(uuid, uuid)
from public, anon, authenticated, service_role;

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
  has_admin_role boolean := false;
  admin_assurance_satisfied boolean := false;
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

  select profile.*
  into caller_profile
  from public.profiles profile
  where profile.id = caller_id;

  if caller_profile.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Profile not found.';
  end if;

  has_admin_role := caller_profile.global_role = 'platform_admin';
  admin_assurance_satisfied := has_admin_role
    and app_private.is_platform_admin();

  select teacher_entitlement.*
  into entitlement
  from app_private.teacher_entitlements teacher_entitlement
  where teacher_entitlement.user_id = caller_id;

  entitlement_is_active := admin_assurance_satisfied or (
    not has_admin_role
    and app_private.has_effective_teacher_access(caller_id)
  );

  select count(*)::integer
  into workspace_count
  from public.workspace_members membership
  where membership.user_id = caller_id
    and membership.role in ('owner', 'teacher')
    and entitlement_is_active;

  workspace_limit := case
    when admin_assurance_satisfied then 100
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
      membership.id as membership_id,
      membership.workspace_id,
      workspace.name as workspace_name,
      workspace.slug as workspace_slug,
      membership.role,
      membership.created_at
    from public.workspace_members membership
    join public.workspaces workspace
      on workspace.id = membership.workspace_id
    where membership.user_id = caller_id
      and (
        membership.role = 'student'
        or entitlement_is_active
      )
  ) memberships_source;

  user_id := caller_id;
  full_name := caller_profile.full_name;
  email := caller_profile.email;
  global_role := caller_profile.global_role;
  teacher_entitled := entitlement_is_active;
  teacher_workspace_count := workspace_count;
  teacher_workspace_limit := workspace_limit;
  can_create_teacher_workspace :=
    entitlement_is_active and workspace_count < workspace_limit;
  memberships := membership_rows;
  return next;
end;
$$;

revoke all on function app_private.get_auth_context_internal()
from public, anon, authenticated, service_role;

comment on function app_private.has_effective_teacher_access(uuid) is
  'Server-side entitlement predicate used whenever owner or teacher memberships grant live authority.';

-- Creating a workspace is an ordinary entitlement mutation for teachers, but
-- a platform administrator reaches it through the control-plane bypass. Keep
-- the teacher path unchanged and step up only the administrator branch.
alter function app_private.create_teacher_workspace_internal(text)
rename to create_teacher_workspace_aal2_legacy_internal;

revoke all on function app_private.create_teacher_workspace_aal2_legacy_internal(text)
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
  caller_is_admin boolean := false;
begin
  select profile.global_role = 'platform_admin'
  into caller_is_admin
  from public.profiles profile
  where profile.id = caller_id;

  if coalesce(caller_is_admin, false) then
    perform app_private.lock_fresh_platform_admin_session();
  end if;

  return query
  select *
  from app_private.create_teacher_workspace_aal2_legacy_internal(
    workspace_name
  );
end;
$$;

revoke all on function app_private.create_teacher_workspace_internal(text)
from public, anon, authenticated, service_role;

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

revoke all on function public.create_teacher_workspace(text)
from public, anon, service_role;
grant execute on function public.create_teacher_workspace(text)
to authenticated;

comment on function app_private.create_teacher_workspace_internal(text) is
  'Preserves ordinary entitled-teacher creation and requires fresh TOTP when the caller has the platform-admin role.';

-- Preserve the reviewed Phase 13H mutation bodies behind new entry points.
-- The stable public names become small step-up wrappers, so no authenticated
-- caller can bypass the fresh-TOTP check through the former internal grants.
alter function public.decide_teacher_access_internal(
  uuid, text, integer, integer
) rename to decide_teacher_access_aal2_legacy_internal;
alter function public.update_teacher_workspace_limit_internal(
  uuid, integer, integer
) rename to update_teacher_workspace_limit_aal2_legacy_internal;
alter function public.disable_teacher_access_internal(
  uuid, integer
) rename to disable_teacher_access_aal2_legacy_internal;

revoke all on function public.decide_teacher_access_aal2_legacy_internal(
  uuid, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.update_teacher_workspace_limit_aal2_legacy_internal(
  uuid, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.disable_teacher_access_aal2_legacy_internal(
  uuid, integer
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
begin
  perform app_private.lock_fresh_platform_admin_session();

  return query
  select *
  from public.decide_teacher_access_aal2_legacy_internal(
    target_request_id,
    decision,
    expected_revision,
    approved_workspace_limit
  );
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
begin
  perform app_private.lock_fresh_platform_admin_session();

  return query
  select *
  from public.update_teacher_workspace_limit_aal2_legacy_internal(
    target_teacher_user_id,
    expected_entitlement_revision,
    new_workspace_limit
  );
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
  owned_workspace record;
  transfer_count integer := 0;
  removed_count integer := 0;
  previous_request_revision integer;
  transferred_workspace_ids uuid[] := '{}'::uuid[];
  disable_audit_id uuid;
  repair_required boolean := false;
begin
  caller_id := app_private.lock_fresh_platform_admin_session();

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

  -- Normal active rows, including time-expired rows, retain the original
  -- atomic transfer implementation. The expected+1 branch preserves its
  -- same-admin lost-response replay semantics.
  if entitlement.active
    or entitlement.revision = expected_entitlement_revision + 1
  then
    return query
    select *
    from public.disable_teacher_access_aal2_legacy_internal(
      target_teacher_user_id,
      expected_entitlement_revision
    );
    return;
  end if;

  if entitlement.revision <> expected_entitlement_revision then
    raise exception using
      errcode = '40001',
      message = 'teacher_entitlement_revision_conflict';
  end if;

  repair_required := target_profile.global_role = 'teacher'
    or locked_request.id is not null and locked_request.status <> 'disabled'
    or entitlement.disabled_at is null
    or entitlement.disabled_by is null
    or exists (
      select 1
      from public.workspaces workspace
      where workspace.owner_id = target_teacher_user_id
    )
    or exists (
      select 1
      from public.workspace_members membership
      where membership.user_id = target_teacher_user_id
        and membership.role in ('owner', 'teacher')
    );

  if not repair_required then
    disabled_user_id := target_teacher_user_id;
    entitlement_revision := entitlement.revision;
    request_revision := locked_request.revision;
    transferred_workspace_count := 0;
    removed_privileged_membership_count := 0;
    disabled_at := entitlement.disabled_at;
    return next;
    return;
  end if;

  if target_profile.global_role = 'teacher' then
    update public.profiles profile
    set global_role = 'student',
        updated_at = now()
    where profile.id = target_teacher_user_id;
  end if;

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
      disabled_at = coalesce(teacher_entitlement.disabled_at, now()),
      disabled_by = coalesce(teacher_entitlement.disabled_by, caller_id)
  where teacher_entitlement.user_id = target_teacher_user_id
  returning * into entitlement;

  previous_request_revision := locked_request.revision;

  if locked_request.id is not null
    and locked_request.status <> 'disabled'
  then
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
    now()
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

revoke all on function public.decide_teacher_access_internal(
  uuid, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.update_teacher_workspace_limit_internal(
  uuid, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.disable_teacher_access_internal(
  uuid, integer
) from public, anon, authenticated, service_role;

grant execute on function public.decide_teacher_access_internal(
  uuid, text, integer, integer
) to authenticated;
grant execute on function public.update_teacher_workspace_limit_internal(
  uuid, integer, integer
) to authenticated;
grant execute on function public.disable_teacher_access_internal(
  uuid, integer
) to authenticated;

comment on function public.decide_teacher_access_internal(
  uuid, text, integer, integer
) is 'Fresh-TOTP protected teacher-access decision implementation.';
comment on function public.update_teacher_workspace_limit_internal(
  uuid, integer, integer
) is 'Fresh-TOTP protected teacher workspace limit implementation.';
comment on function public.disable_teacher_access_internal(
  uuid, integer
) is 'Fresh-TOTP protected atomic disable and idempotent inactive-state offboarding repair.';
