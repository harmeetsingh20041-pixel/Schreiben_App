-- The onboarding projection previously broke ties between same-transaction
-- owner memberships by random UUID. A teacher who created a second empty
-- workspace immediately after approval could therefore be sent back into the
-- first-class wizard even though their default workspace already had a class.
-- Prefer a privileged workspace that contains a class before the stable role
-- and creation-order tie-breakers.

begin;

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
    case when exists (
      select 1
      from public.batches batch
      where batch.workspace_id = membership.workspace_id
    ) then 0 else 1 end,
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

comment on function public.get_my_teacher_start_internal() is
  'Returns one effective teacher workspace, preferring a workspace with an existing class so multi-workspace teachers are not reopened into first-class onboarding.';

commit;
