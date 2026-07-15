-- Phase 12S: make the shared AI-budget trigger safe for both record shapes.
--
-- PostgreSQL resolves dynamic trigger-record fields before boolean AND can
-- short-circuit. Keep table-specific field access inside its own branch so a
-- workspace-budget UPDATE never attempts to read the global-only `singleton`
-- column (and vice versa).

create or replace function app_private.prepare_ai_budget_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'ai_budget_delete_forbidden';
  end if;

  if tg_op = 'UPDATE' then
    if tg_table_name = 'ai_spend_global_policy' then
      if new.singleton is distinct from old.singleton then
        raise exception using
          errcode = '55000',
          message = 'ai_budget_key_immutable';
      end if;
    elsif tg_table_name = 'ai_workspace_monthly_budgets' then
      if new.workspace_id is distinct from old.workspace_id
        or new.billing_month is distinct from old.billing_month
      then
        raise exception using
          errcode = '55000',
          message = 'ai_budget_key_immutable';
      end if;
    else
      raise exception using
        errcode = '55000',
        message = 'ai_budget_table_invalid';
    end if;

    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;

  return new;
end;
$$;

revoke all on function app_private.prepare_ai_budget_change()
from public, anon, authenticated, service_role;

comment on function app_private.prepare_ai_budget_change() is
  'Rejects budget deletes and key changes while handling global and workspace record shapes independently.';
