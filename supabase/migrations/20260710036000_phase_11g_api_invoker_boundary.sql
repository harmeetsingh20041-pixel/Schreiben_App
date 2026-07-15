-- Phase 11G: keep every deliberately exposed API routine SECURITY INVOKER.
-- Privileged implementations live in the non-exposed public schema;
-- browser-callable wrappers carry no definer authority of their own.

alter function api.get_feedback_draft(uuid) set schema public;
alter function public.get_feedback_draft(uuid)
  rename to get_feedback_draft_internal;
alter function api.update_feedback_draft(uuid, jsonb, integer)
  set schema public;
alter function public.update_feedback_draft(uuid, jsonb, integer)
  rename to update_feedback_draft_internal;
alter function api.release_feedback(uuid, uuid) set schema public;
alter function public.release_feedback(uuid, uuid)
  rename to release_feedback_internal;
alter function api.list_feedback_review_queue_page(
  uuid, text, integer, timestamptz, uuid
) set schema public;
alter function public.list_feedback_review_queue_page(
  uuid, text, integer, timestamptz, uuid
) rename to list_feedback_review_queue_page_internal;

alter function api.save_writing_draft(uuid, uuid, text, uuid, text, integer)
  set schema public;
alter function public.save_writing_draft(uuid, uuid, text, uuid, text, integer)
  rename to save_writing_draft_internal;
alter function api.get_writing_draft(uuid) set schema public;
alter function public.get_writing_draft(uuid)
  rename to get_writing_draft_internal;
alter function api.list_my_writing_drafts(uuid, integer) set schema public;
alter function public.list_my_writing_drafts(uuid, integer)
  rename to list_my_writing_drafts_internal;
alter function api.submit_writing_draft(uuid, integer) set schema public;
alter function public.submit_writing_draft(uuid, integer)
  rename to submit_writing_draft_internal;
alter function api.save_practice_draft(uuid, jsonb, integer)
  set schema public;
alter function public.save_practice_draft(uuid, jsonb, integer)
  rename to save_practice_draft_internal;
alter function api.get_practice_draft(uuid) set schema public;
alter function public.get_practice_draft(uuid)
  rename to get_practice_draft_internal;
alter function api.submit_practice_attempt(uuid, integer) set schema public;
alter function public.submit_practice_attempt(uuid, integer)
  rename to submit_practice_draft_internal;

alter function api.record_recovery_heartbeat(uuid) set schema public;
alter function public.record_recovery_heartbeat(uuid)
  rename to record_recovery_heartbeat_internal;
alter function api.get_recovery_health() set schema public;
alter function public.get_recovery_health()
  rename to get_recovery_health_internal;

revoke all on function public.get_feedback_draft_internal(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.update_feedback_draft_internal(uuid, jsonb, integer)
from public, anon, authenticated, service_role;
revoke all on function public.release_feedback_internal(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.list_feedback_review_queue_page_internal(
  uuid, text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.save_writing_draft_internal(
  uuid, uuid, text, uuid, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.get_writing_draft_internal(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.list_my_writing_drafts_internal(uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function public.submit_writing_draft_internal(uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function public.save_practice_draft_internal(uuid, jsonb, integer)
from public, anon, authenticated, service_role;
revoke all on function public.get_practice_draft_internal(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.submit_practice_draft_internal(uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function public.record_recovery_heartbeat_internal(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.get_recovery_health_internal()
from public, anon, authenticated, service_role;

-- The invoker wrappers need execute permission on the exact non-exposed
-- implementation they delegate to. Production exposes only the api schema, so
-- none of these bodies is directly reachable through PostgREST.
grant execute on function public.get_feedback_draft_internal(uuid)
to authenticated;
grant execute on function public.update_feedback_draft_internal(uuid, jsonb, integer)
to authenticated;
grant execute on function public.release_feedback_internal(uuid, uuid)
to authenticated;
grant execute on function public.list_feedback_review_queue_page_internal(
  uuid, text, integer, timestamptz, uuid
) to authenticated;
grant execute on function public.save_writing_draft_internal(
  uuid, uuid, text, uuid, text, integer
) to authenticated;
grant execute on function public.get_writing_draft_internal(uuid)
to authenticated;
grant execute on function public.list_my_writing_drafts_internal(uuid, integer)
to authenticated;
grant execute on function public.submit_writing_draft_internal(uuid, integer)
to authenticated;
grant execute on function public.save_practice_draft_internal(uuid, jsonb, integer)
to authenticated;
grant execute on function public.get_practice_draft_internal(uuid)
to authenticated;
grant execute on function public.submit_practice_draft_internal(uuid, integer)
to authenticated;
grant execute on function public.record_recovery_heartbeat_internal(uuid)
to service_role;
grant execute on function public.get_recovery_health_internal()
to service_role;

create or replace function api.get_feedback_draft(target_submission_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.get_feedback_draft_internal(target_submission_id);
$$;

create or replace function api.update_feedback_draft(
  feedback_version_id uuid,
  content jsonb,
  expected_revision integer
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.update_feedback_draft_internal(
    feedback_version_id,
    content,
    expected_revision
  );
$$;

create or replace function api.release_feedback(
  submission_id uuid,
  feedback_version_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.release_feedback_internal(
    submission_id,
    feedback_version_id
  );
$$;

create or replace function api.list_feedback_review_queue_page(
  target_workspace_id uuid,
  target_reason text default null,
  requested_page_size integer default 25,
  cursor_created_at timestamptz default null,
  cursor_id uuid default null
)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.list_feedback_review_queue_page_internal(
    target_workspace_id,
    target_reason,
    requested_page_size,
    cursor_created_at,
    cursor_id
  );
$$;

create or replace function api.save_writing_draft(
  draft_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  "text" text,
  expected_revision integer
)
returns table (
  saved_draft_id uuid,
  workspace_id uuid,
  saved_revision integer,
  saved_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.save_writing_draft_internal(
    draft_id,
    batch_id,
    source_type,
    source_id,
    "text",
    expected_revision
  );
$$;

create or replace function api.get_writing_draft(target_draft_id uuid)
returns table (
  draft_id uuid,
  workspace_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  "text" text,
  revision integer,
  updated_at timestamptz
)
language sql
security invoker
set search_path = ''
stable
as $$
  select * from public.get_writing_draft_internal(target_draft_id);
$$;

create or replace function api.list_my_writing_drafts(
  target_workspace_id uuid,
  page_size integer default 25
)
returns table (
  draft_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  preview text,
  character_count integer,
  revision integer,
  updated_at timestamptz
)
language sql
security invoker
set search_path = ''
stable
as $$
  select *
  from public.list_my_writing_drafts_internal(
    target_workspace_id,
    page_size
  );
$$;

create or replace function api.submit_writing_draft(
  target_draft_id uuid,
  expected_revision integer
)
returns table (
  submission_id uuid,
  evaluation_status text,
  release_status text,
  release_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.submit_writing_draft_internal(
    target_draft_id,
    expected_revision
  );
$$;

create or replace function api.save_practice_draft(
  target_assignment_id uuid,
  submitted_answers jsonb,
  expected_revision integer
)
returns table (
  draft_id uuid,
  assignment_id uuid,
  saved_revision integer,
  answers jsonb,
  saved_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.save_practice_draft_internal(
    target_assignment_id,
    submitted_answers,
    expected_revision
  );
$$;

create or replace function api.get_practice_draft(target_assignment_id uuid)
returns table (
  draft_id uuid,
  assignment_id uuid,
  revision integer,
  answers jsonb,
  updated_at timestamptz
)
language sql
security invoker
set search_path = ''
stable
as $$
  select *
  from public.get_practice_draft_internal(target_assignment_id);
$$;

create or replace function api.submit_practice_attempt(
  target_assignment_id uuid,
  expected_revision integer
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.submit_practice_draft_internal(
    target_assignment_id,
    expected_revision
  );
$$;

create or replace function api.record_recovery_heartbeat(target_request_id uuid)
returns timestamptz
language sql
security invoker
set search_path = ''
as $$
  select public.record_recovery_heartbeat_internal(target_request_id);
$$;

create or replace function api.get_recovery_health()
returns table (
  last_seen_at timestamptz,
  heartbeat_fresh boolean,
  pg_net_installed boolean,
  writing_queue_ready boolean,
  worksheet_generation_queue_ready boolean,
  worksheet_answer_queue_ready boolean
)
language sql
security invoker
set search_path = ''
stable
as $$
  select * from public.get_recovery_health_internal();
$$;

revoke all on function api.get_feedback_draft(uuid) from public, anon;
revoke all on function api.update_feedback_draft(uuid, jsonb, integer)
from public, anon;
revoke all on function api.release_feedback(uuid, uuid) from public, anon;
revoke all on function api.list_feedback_review_queue_page(
  uuid, text, integer, timestamptz, uuid
) from public, anon;
revoke all on function api.save_writing_draft(
  uuid, uuid, text, uuid, text, integer
) from public, anon;
revoke all on function api.get_writing_draft(uuid) from public, anon;
revoke all on function api.list_my_writing_drafts(uuid, integer)
from public, anon;
revoke all on function api.submit_writing_draft(uuid, integer)
from public, anon;
revoke all on function api.save_practice_draft(uuid, jsonb, integer)
from public, anon;
revoke all on function api.get_practice_draft(uuid) from public, anon;
revoke all on function api.submit_practice_attempt(uuid, integer)
from public, anon;
revoke all on function api.record_recovery_heartbeat(uuid)
from public, anon, authenticated;
revoke all on function api.get_recovery_health()
from public, anon, authenticated;

grant execute on function api.get_feedback_draft(uuid) to authenticated;
grant execute on function api.update_feedback_draft(uuid, jsonb, integer)
to authenticated;
grant execute on function api.release_feedback(uuid, uuid) to authenticated;
grant execute on function api.list_feedback_review_queue_page(
  uuid, text, integer, timestamptz, uuid
) to authenticated;
grant execute on function api.save_writing_draft(
  uuid, uuid, text, uuid, text, integer
) to authenticated;
grant execute on function api.get_writing_draft(uuid) to authenticated;
grant execute on function api.list_my_writing_drafts(uuid, integer)
to authenticated;
grant execute on function api.submit_writing_draft(uuid, integer)
to authenticated;
grant execute on function api.save_practice_draft(uuid, jsonb, integer)
to authenticated;
grant execute on function api.get_practice_draft(uuid) to authenticated;
grant execute on function api.submit_practice_attempt(uuid, integer)
to authenticated;
grant execute on function api.record_recovery_heartbeat(uuid) to service_role;
grant execute on function api.get_recovery_health() to service_role;

notify pgrst, 'reload schema';
