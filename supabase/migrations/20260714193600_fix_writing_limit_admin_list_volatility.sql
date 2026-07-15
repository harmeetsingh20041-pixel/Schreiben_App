begin;

-- The platform-administrator guard deliberately locks the active Auth session
-- while reading the private approval queue.  Marking this facade STABLE makes
-- PostgREST execute it in a read-only transaction, where SELECT ... FOR SHARE
-- is forbidden.  Keep the lock and expose the true volatility instead.
alter function api.list_batch_writing_limit_requests(
  text,
  integer,
  timestamptz,
  uuid
) volatile;

comment on function api.list_batch_writing_limit_requests(
  text,
  integer,
  timestamptz,
  uuid
) is
  'AAL2 platform administrators list private class writing-limit requests. VOLATILE is required because the active-session guard acquires a row lock.';

notify pgrst, 'reload schema';

commit;
