-- Phase 11V: make every browser mutation RPC-only.
--
-- Early historical migrations granted authenticated users DML on the public
-- schema and relied on RLS. The V1 browser now talks only to the reviewed api
-- facade, so those ambient table/sequence privileges are unnecessary and
-- would become dangerous if an RLS policy or exposed-schema setting drifted.

revoke insert, update, delete, truncate, references, trigger
on all tables in schema public
from public, anon, authenticated;

revoke all on all sequences in schema public
from public, anon, authenticated;

-- Private implementation objects are callable only through reviewed public or
-- api security-definer boundaries. Re-apply the deny after every historical
-- migration so later-created practice/queue helpers cannot inherit old grants.
revoke all on schema app_private from public, anon, authenticated;
revoke all on all tables in schema app_private
from public, anon, authenticated;
revoke all on all sequences in schema app_private
from public, anon, authenticated;
revoke execute on all functions in schema app_private
from public, anon, authenticated;

-- Future objects created by the migration owner start from the same boundary.
alter default privileges in schema public
revoke insert, update, delete, truncate, references, trigger on tables
from public, anon, authenticated;

alter default privileges in schema public
revoke all on sequences
from public, anon, authenticated;

alter default privileges in schema app_private
revoke all on tables
from public, anon, authenticated;

alter default privileges in schema app_private
revoke all on sequences
from public, anon, authenticated;

alter default privileges in schema app_private
revoke execute on functions
from public, anon, authenticated;

notify pgrst, 'reload schema';
