-- Keep normal scheduled feedback immutable, but give an authorized teacher a
-- narrow rescue path after the promised release time has passed. The existing
-- api.release_feedback RPC supplies the workspace lock, teacher membership
-- check, draft/submission row locks, validation, materialization, and audit
-- events. This trigger only permits that RPC's approval transition.

create or replace function app_private.prevent_scheduled_feedback_teacher_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_submission public.submissions%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'authenticated' then
    return new;
  end if;

  -- Authenticate the row being changed, never a caller-supplied replacement
  -- submission_id. These identity fields are immutable for every browser
  -- feedback-draft update, including rows outside Scheduled mode.
  if new.id is distinct from old.id
    or new.submission_id is distinct from old.submission_id
    or new.version is distinct from old.version
    or new.created_at is distinct from old.created_at
  then
    raise exception using
      errcode = '55000',
      message = 'Feedback version identity is immutable.';
  end if;

  select submission.*
  into selected_submission
  from public.submissions submission
  where submission.id = old.submission_id;

  if selected_submission.id is null
    or selected_submission.feedback_mode <> 'automatic_delayed'
    or selected_submission.release_status <> 'scheduled'
  then
    return new;
  end if;

  if selected_submission.release_at is null
    or selected_submission.release_at > now()
  then
    raise exception using
      errcode = '55000',
      message = 'Scheduled feedback is read-only until its automatic release.';
  end if;

  -- After the deadline, the only authenticated update allowed while the
  -- submission is still scheduled is the approval step performed by
  -- public.release_feedback_internal. Content and immutable identity fields
  -- must remain byte-for-byte unchanged. Direct browser table writes are also
  -- revoked, so callers still have to pass the RPC's membership and row locks.
  if old.state not in ('draft', 'approved')
    or new.state <> 'approved'
    or new.revision <> old.revision + 1
    or new.content is distinct from old.content
    or new.provider_model is distinct from old.provider_model
    or new.approved_at is null
    or new.approved_by is distinct from (select auth.uid())
    or new.released_at is distinct from old.released_at
    or new.released_by is distinct from old.released_by
  then
    raise exception using
      errcode = '55000',
      message = 'Overdue scheduled feedback can be released but not edited.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.prevent_scheduled_feedback_teacher_mutation()
from public, anon, authenticated, service_role;

comment on function app_private.prevent_scheduled_feedback_teacher_mutation() is
  'Keeps scheduled drafts immutable and permits only an authorized release_feedback approval transition after release_at.';
