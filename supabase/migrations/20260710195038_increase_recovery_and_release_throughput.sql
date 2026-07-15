-- The recovery function needs queue depth to launch a bounded burst instead of
-- waking exactly one consumer per queue every 30 seconds.
create or replace function api.get_async_queue_metrics()
returns table (
  queue_name text,
  queue_length bigint,
  oldest_message_age_seconds integer,
  queued_jobs bigint,
  processing_jobs bigint,
  retry_jobs bigint,
  dead_jobs bigint
)
language sql
security invoker
set search_path = ''
as $$
  select * from public.get_async_queue_metrics();
$$;

revoke all on function api.get_async_queue_metrics()
from public, anon, authenticated, service_role;
grant execute on function api.get_async_queue_metrics()
to service_role;

-- A scheduled run requests 100 releases. Honor that request (with a defensive
-- maximum) rather than silently clamping it to 25.
create or replace function app_private.release_due_feedback_internal(
  batch_size integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  due_feedback record;
  released_count integer := 0;
  selected_limit integer := greatest(1, least(coalesce(batch_size, 100), 500));
begin
  for due_feedback in
    select s.id as submission_id, fd.id as draft_id
    from public.submissions s
    join app_private.feedback_drafts fd
      on fd.submission_id = s.id
     and fd.state in ('draft', 'approved')
    where s.evaluation_status = 'ready'
      and s.release_status = 'scheduled'
      and s.release_at <= now()
    order by s.release_at, s.id
    for update of s skip locked
    limit selected_limit
  loop
    begin
      perform app_private.materialize_feedback_draft(
        due_feedback.submission_id,
        due_feedback.draft_id,
        null
      );
      released_count := released_count + 1;
    exception when others then
      update app_private.feedback_drafts draft
      set state = 'needs_review'
      where draft.id = due_feedback.draft_id
        and draft.state in ('draft', 'approved');

      update public.submissions submission
      set evaluation_status = 'needs_review',
          release_status = 'held',
          release_at = null,
          status = 'needs_review',
          feedback_error = 'release_validation_failed'
      where submission.id = due_feedback.submission_id;
    end;
  end loop;

  return released_count;
end;
$$;

revoke all on function app_private.release_due_feedback_internal(integer)
from public, anon, authenticated, service_role;

comment on function api.get_async_queue_metrics() is
  'Service-only queue-depth evidence for bounded recovery fan-out.';
comment on function app_private.release_due_feedback_internal(integer) is
  'Releases up to the requested batch size, capped at 500, with per-draft failure isolation.';
