-- Browser and API roles must never be able to run VACUUM, ANALYZE, REINDEX,
-- CLUSTER, REFRESH MATERIALIZED VIEW, or other table-maintenance operations.
-- PostgreSQL 15 added MAINTAIN as a separately grantable table privilege, so
-- the earlier explicit DML revokes did not cover it on this legacy project.

revoke maintain on all tables in schema public
from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema public
revoke maintain on tables
from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema api
revoke maintain on tables
from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema app_private
revoke maintain on tables
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
