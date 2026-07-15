begin;

-- PostgREST discovers RPC input names from the first `pronargs` entries in
-- `pg_proc.proargnames`. Keep every input-capable argument before OUT-only
-- fields so named browser calls expose the intended contract.
-- PostgreSQL treats OUT ordering as part of the returned record contract, so
-- replace this dependency-free facade explicitly inside the transaction.
drop function api.request_batch_writing_limit(uuid, integer, integer);

create function api.request_batch_writing_limit(
  inout batch_id uuid,
  in requested_limit integer,
  in expected_revision integer,
  out request_id uuid,
  out workspace_id uuid,
  out current_writing_daily_limit integer,
  out requested_writing_daily_limit integer,
  out request_status text,
  out request_revision integer,
  out requested_at timestamptz,
  out updated_at timestamptz
)
returns setof record
language sql
security invoker
set search_path = ''
volatile
as $$
  select
    requested.batch_id,
    requested.request_id,
    requested.workspace_id,
    requested.current_writing_daily_limit,
    requested.requested_writing_daily_limit,
    requested.request_status,
    requested.request_revision,
    requested.requested_at,
    requested.updated_at
  from public.request_batch_writing_limit_internal($1, $2, $3) requested;
$$;

revoke all on function api.request_batch_writing_limit(uuid, integer, integer)
from public, anon, authenticated, service_role;
grant execute on function api.request_batch_writing_limit(uuid, integer, integer)
to authenticated;

comment on function api.request_batch_writing_limit(uuid, integer, integer) is
  'Owner/teacher requests a different 1..10 evaluated-writing daily limit for an active class. Inputs are ordered first for PostgREST named-argument discovery; expected_revision is 0 for a new request.';

notify pgrst, 'reload schema';

commit;
