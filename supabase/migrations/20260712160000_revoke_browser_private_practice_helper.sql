-- Restore the Phase 11V browser/private-function boundary after the canonical
-- worksheet-withdrawal migration recreated this helper. Browser callers use
-- api.get_practice_assignment_questions -> public.get_practice_assignment_questions;
-- the SECURITY DEFINER public wrapper does not require a browser grant on the
-- private implementation.

revoke all on function app_private.get_practice_assignment_questions_internal(uuid)
from public, anon, authenticated, service_role;
