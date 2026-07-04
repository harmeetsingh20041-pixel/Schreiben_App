-- Trigger-only helper should not be directly callable through PostgREST RPC.

revoke execute on function public.normalize_batch_join_code() from authenticated;
