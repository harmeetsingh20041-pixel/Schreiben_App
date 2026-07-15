-- Keep normal scheduled feedback automatic. Teachers may preview the private
-- draft, but an authenticated browser session cannot edit it or release it
-- before the configured release worker runs. Uncertain delayed feedback is
-- moved to release_status = 'held' by the evaluation pipeline and therefore
-- remains reviewable through the existing teacher-review APIs.

create or replace function app_private.prevent_scheduled_feedback_teacher_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') = 'authenticated'
    and exists (
      select 1
      from public.submissions submission
      where submission.id = new.submission_id
        and submission.feedback_mode = 'automatic_delayed'
        and submission.release_status = 'scheduled'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'Scheduled feedback is read-only until its automatic release.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.prevent_scheduled_feedback_teacher_mutation()
from public, anon, authenticated, service_role;

drop trigger if exists feedback_drafts_guard_scheduled_teacher_mutation
on app_private.feedback_drafts;
create trigger feedback_drafts_guard_scheduled_teacher_mutation
before update on app_private.feedback_drafts
for each row execute function app_private.prevent_scheduled_feedback_teacher_mutation();

comment on function app_private.prevent_scheduled_feedback_teacher_mutation() is
  'Prevents authenticated callers from editing or releasing normal scheduled feedback before automatic release; held uncertain drafts remain reviewable.';
