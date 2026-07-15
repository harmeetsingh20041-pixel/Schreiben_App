-- Fix the recovery-evidence lookup discovered by the linked staging pgTAP
-- run. The private function parameter and audit-table column share the name
-- target_user_id; using the positional parameter keeps CREATE OR REPLACE
-- signature-compatible while removing PL/pgSQL ambiguity.

begin;

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
    where audit_row.target_user_id = $1
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

revoke all on function app_private.restore_platform_admin_after_mfa_recovery(uuid)
from public, anon, authenticated, service_role;
grant execute on function app_private.restore_platform_admin_after_mfa_recovery(uuid)
to postgres;

commit;
