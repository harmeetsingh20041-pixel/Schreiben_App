-- Phase 11D: teacher-controlled feedback editing, approval, and release.
--
-- Private draft content remains in app_private. Browser clients receive it only
-- through narrowly authorized, teacher-only SECURITY DEFINER functions. Student
-- read models continue to use released materialized feedback exclusively.

create table if not exists app_private.feedback_draft_events (
  id bigint generated always as identity primary key,
  feedback_draft_id uuid not null
    references app_private.feedback_drafts(id) on delete cascade,
  submission_id uuid not null
    references public.submissions(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  from_state text,
  to_state text not null,
  from_revision integer,
  to_revision integer not null,
  before_content jsonb,
  after_content jsonb,
  created_at timestamptz not null default now(),
  constraint feedback_draft_events_type_check check (
    event_type in ('teacher_edited', 'teacher_approved', 'teacher_released')
  ),
  constraint feedback_draft_events_state_check check (
    from_state is null
      or from_state in ('draft', 'needs_review', 'approved', 'released', 'superseded')
  ),
  constraint feedback_draft_events_to_state_check check (
    to_state in ('draft', 'needs_review', 'approved', 'released', 'superseded')
  ),
  constraint feedback_draft_events_revision_check check (
    to_revision > 0
      and (from_revision is null or from_revision > 0)
  ),
  constraint feedback_draft_events_content_check check (
    (before_content is null or jsonb_typeof(before_content) = 'object')
      and (after_content is null or jsonb_typeof(after_content) = 'object')
  )
);

create index if not exists feedback_draft_events_draft_created_idx
on app_private.feedback_draft_events (feedback_draft_id, created_at, id);

create index if not exists feedback_draft_events_submission_created_idx
on app_private.feedback_draft_events (submission_id, created_at, id);

alter table app_private.feedback_draft_events enable row level security;
revoke all on table app_private.feedback_draft_events
from public, anon, authenticated, service_role;
revoke all on sequence app_private.feedback_draft_events_id_seq
from public, anon, authenticated, service_role;

-- Released and superseded versions may never be edited in place. Direct table
-- access is already revoked; this trigger also protects privileged internal
-- code from accidentally rewriting historical feedback.
create or replace function app_private.prevent_final_feedback_draft_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.state in ('released', 'superseded') then
    raise exception using
      errcode = '55000',
      message = 'Final feedback versions are immutable.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.prevent_final_feedback_draft_update()
from public, anon, authenticated, service_role;

drop trigger if exists feedback_drafts_prevent_final_update
on app_private.feedback_drafts;
create trigger feedback_drafts_prevent_final_update
before update on app_private.feedback_drafts
for each row execute function app_private.prevent_final_feedback_draft_update();

create or replace function app_private.lock_feedback_teacher_membership(
  target_workspace_id uuid,
  target_actor_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  membership_found boolean := false;
begin
  select true
  into membership_found
  from public.workspace_members membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = target_actor_id
    and membership.role in ('owner', 'teacher')
  for key share;

  return coalesce(membership_found, false);
end;
$$;

revoke all on function app_private.lock_feedback_teacher_membership(uuid, uuid)
from public, anon, authenticated, service_role;

create or replace function api.get_feedback_draft(target_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  selected_submission public.submissions%rowtype;
  selected_draft app_private.feedback_drafts%rowtype;
  topic_options jsonb := '[]'::jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if target_submission_id is null then
    raise exception using errcode = '22023', message = 'Submission is required.';
  end if;

  select submission.*
  into selected_submission
  from public.submissions submission
  where submission.id = target_submission_id;

  if selected_submission.id is null
    or not public.has_workspace_role(
      selected_submission.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Submission not found or access denied.';
  end if;

  select draft.*
  into selected_draft
  from app_private.feedback_drafts draft
  where draft.submission_id = target_submission_id
    and draft.state in ('draft', 'needs_review', 'approved')
  order by draft.version desc, draft.created_at desc, draft.id desc
  limit 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slug', contract.slug,
        'name', contract.display_name
      )
      order by contract.display_name, contract.slug
    ),
    '[]'::jsonb
  )
  into topic_options
  from app_private.grammar_topic_contracts contract;

  return jsonb_build_object(
    'schema_version', 1,
    'draft', case
      when selected_draft.id is null then null
      else jsonb_build_object(
        'id', selected_draft.id,
        'submission_id', selected_draft.submission_id,
        'version', selected_draft.version,
        'revision', selected_draft.revision,
        'state', selected_draft.state,
        'content', selected_draft.content,
        'provider_model', selected_draft.provider_model,
        'created_at', selected_draft.created_at,
        'updated_at', selected_draft.updated_at,
        'approved_at', selected_draft.approved_at,
        'released_at', selected_draft.released_at
      )
    end,
    'topic_options', topic_options
  );
end;
$$;

create or replace function api.update_feedback_draft(
  feedback_version_id uuid,
  content jsonb,
  expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  target_submission_id uuid;
  selected_submission public.submissions%rowtype;
  selected_draft app_private.feedback_drafts%rowtype;
  updated_draft app_private.feedback_drafts%rowtype;
  next_content jsonb := content;
  next_state text;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if feedback_version_id is null
    or content is null
    or jsonb_typeof(content) <> 'object'
    or expected_revision is null
    or expected_revision < 1
  then
    raise exception using errcode = '22023', message = 'Feedback edit is invalid.';
  end if;

  if pg_column_size(next_content) > 1048576 then
    raise exception using errcode = '22023', message = 'Feedback edit is too large.';
  end if;

  select draft.submission_id
  into target_submission_id
  from app_private.feedback_drafts draft
  where draft.id = feedback_version_id;

  if target_submission_id is null then
    raise exception using
      errcode = '42501',
      message = 'Feedback version not found or access denied.';
  end if;

  -- Keep the lock order aligned with materialize_feedback_draft: submission,
  -- then draft. This avoids teacher-edit/release deadlocks with scheduled jobs.
  select submission.*
  into selected_submission
  from public.submissions submission
  where submission.id = target_submission_id
  for update;

  if selected_submission.id is null
    or not app_private.lock_feedback_teacher_membership(
      selected_submission.workspace_id,
      actor_id
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Feedback version not found or access denied.';
  end if;

  select draft.*
  into selected_draft
  from app_private.feedback_drafts draft
  where draft.id = feedback_version_id
    and draft.submission_id = selected_submission.id
  for update;

  if selected_draft.id is null then
    raise exception using
      errcode = '42501',
      message = 'Feedback version not found or access denied.';
  end if;

  if selected_draft.state not in ('draft', 'needs_review', 'approved') then
    raise exception using errcode = '55000', message = 'Feedback version is immutable.';
  end if;

  if selected_draft.revision <> expected_revision then
    raise exception using
      errcode = '40001',
      message = 'Feedback changed while you were editing. Refresh and try again.';
  end if;

  next_state := case
    when exists (
      select 1
      from jsonb_array_elements(coalesce(next_content -> 'lines', '[]'::jsonb)) line_item
      where line_item ->> 'status' = 'unclear'
    ) then 'needs_review'
    else 'draft'
  end;

  -- The Phase 11A content trigger validates source offsets, corrections,
  -- explanations, closed topic slugs, and re-derives topic/score summaries.
  update app_private.feedback_drafts draft
  set
    content = next_content,
    state = next_state,
    revision = draft.revision + 1,
    approved_at = null,
    approved_by = null
  where draft.id = selected_draft.id
  returning draft.* into updated_draft;

  update public.submissions submission
  set
    status = case when next_state = 'needs_review' then 'needs_review' else 'checked' end,
    evaluation_status = case
      when next_state = 'needs_review' then 'needs_review'
      else 'ready'
    end,
    release_status = 'held',
    release_at = null,
    corrected_text = null,
    overall_summary = null,
    level_detected = null,
    checked_at = null,
    feedback_error = null
  where submission.id = selected_submission.id;

  insert into app_private.feedback_draft_events (
    feedback_draft_id,
    submission_id,
    actor_id,
    event_type,
    from_state,
    to_state,
    from_revision,
    to_revision,
    before_content,
    after_content
  ) values (
    selected_draft.id,
    selected_submission.id,
    actor_id,
    'teacher_edited',
    selected_draft.state,
    updated_draft.state,
    selected_draft.revision,
    updated_draft.revision,
    selected_draft.content,
    updated_draft.content
  );

  return jsonb_build_object(
    'schema_version', 1,
    'draft', jsonb_build_object(
      'id', updated_draft.id,
      'submission_id', updated_draft.submission_id,
      'version', updated_draft.version,
      'revision', updated_draft.revision,
      'state', updated_draft.state,
      'content', updated_draft.content,
      'provider_model', updated_draft.provider_model,
      'created_at', updated_draft.created_at,
      'updated_at', updated_draft.updated_at,
      'approved_at', updated_draft.approved_at,
      'released_at', updated_draft.released_at
    )
  );
end;
$$;

create or replace function api.release_feedback(
  submission_id uuid,
  feedback_version_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  selected_submission public.submissions%rowtype;
  selected_draft app_private.feedback_drafts%rowtype;
  approved_draft app_private.feedback_drafts%rowtype;
  released_draft app_private.feedback_drafts%rowtype;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if submission_id is null or feedback_version_id is null then
    raise exception using errcode = '22023', message = 'Feedback release is invalid.';
  end if;

  select submission.*
  into selected_submission
  from public.submissions submission
  where submission.id = submission_id
  for update;

  if selected_submission.id is null
    or not app_private.lock_feedback_teacher_membership(
      selected_submission.workspace_id,
      actor_id
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Feedback version not found or access denied.';
  end if;

  select draft.*
  into selected_draft
  from app_private.feedback_drafts draft
  where draft.id = feedback_version_id
    and draft.submission_id = selected_submission.id
  for update;

  if selected_draft.id is null then
    raise exception using
      errcode = '42501',
      message = 'Feedback version not found or access denied.';
  end if;

  if selected_draft.state = 'released'
    and selected_submission.release_status = 'released'
  then
    return jsonb_build_object(
      'schema_version', 1,
      'submission_id', selected_submission.id,
      'feedback_version_id', selected_draft.id,
      'feedback_version', selected_draft.version,
      'feedback_revision', selected_draft.revision,
      'state', selected_draft.state,
      'release_status', selected_submission.release_status,
      'released_at', selected_draft.released_at
    );
  end if;

  if selected_draft.state not in ('draft', 'approved')
    or exists (
      select 1
      from jsonb_array_elements(
        coalesce(selected_draft.content -> 'lines', '[]'::jsonb)
      ) line_item
      where line_item ->> 'status' = 'unclear'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'Feedback must be fully reviewed before release.';
  end if;

  update app_private.feedback_drafts draft
  set
    state = 'approved',
    revision = draft.revision + 1,
    approved_at = now(),
    approved_by = actor_id
  where draft.id = selected_draft.id
  returning draft.* into approved_draft;

  insert into app_private.feedback_draft_events (
    feedback_draft_id,
    submission_id,
    actor_id,
    event_type,
    from_state,
    to_state,
    from_revision,
    to_revision,
    before_content,
    after_content
  ) values (
    selected_draft.id,
    selected_submission.id,
    actor_id,
    'teacher_approved',
    selected_draft.state,
    approved_draft.state,
    selected_draft.revision,
    approved_draft.revision,
    selected_draft.content,
    approved_draft.content
  );

  -- Approval, materialization, release-state transition, evidence refresh, and
  -- both audit events commit atomically or roll back together.
  perform app_private.materialize_feedback_draft(
    selected_submission.id,
    approved_draft.id,
    actor_id
  );

  select draft.*
  into released_draft
  from app_private.feedback_drafts draft
  where draft.id = approved_draft.id;

  insert into app_private.feedback_draft_events (
    feedback_draft_id,
    submission_id,
    actor_id,
    event_type,
    from_state,
    to_state,
    from_revision,
    to_revision,
    before_content,
    after_content
  ) values (
    approved_draft.id,
    selected_submission.id,
    actor_id,
    'teacher_released',
    approved_draft.state,
    released_draft.state,
    approved_draft.revision,
    released_draft.revision,
    approved_draft.content,
    released_draft.content
  );

  return jsonb_build_object(
    'schema_version', 1,
    'submission_id', selected_submission.id,
    'feedback_version_id', released_draft.id,
    'feedback_version', released_draft.version,
    'feedback_revision', released_draft.revision,
    'state', released_draft.state,
    'release_status', 'released',
    'released_at', released_draft.released_at
  );
end;
$$;

create or replace function api.list_feedback_review_queue_page(
  target_workspace_id uuid,
  target_reason text default null,
  requested_page_size integer default 25,
  cursor_created_at timestamptz default null,
  cursor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  exact_total bigint := 0;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb := null;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if target_workspace_id is null then
    raise exception using errcode = '22023', message = 'Workspace is required.';
  end if;

  if not public.has_workspace_role(target_workspace_id, array['owner', 'teacher']) then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  if target_reason is not null
    and target_reason not in ('teacher_review', 'uncertain', 'failed')
  then
    raise exception using errcode = '22023', message = 'Review reason is invalid.';
  end if;

  if requested_page_size is null or requested_page_size < 1 or requested_page_size > 100 then
    raise exception using
      errcode = '22023',
      message = 'Page size must be between 1 and 100.';
  end if;

  if (cursor_created_at is null) <> (cursor_id is null) then
    raise exception using
      errcode = '22023',
      message = 'Both cursor fields are required together.';
  end if;

  with queue_candidates as (
    select
      submission.id,
      case
        when submission.evaluation_status = 'failed' then 'failed'
        when submission.evaluation_status = 'needs_review'
          or draft.state = 'needs_review' then 'uncertain'
        when submission.feedback_mode = 'teacher_review_only'
          and submission.evaluation_status = 'ready'
          and submission.release_status = 'held'
          and draft.state in ('draft', 'approved') then 'teacher_review'
        else null
      end as review_reason
    from public.submissions submission
    left join app_private.feedback_drafts draft
      on draft.submission_id = submission.id
     and draft.state in ('draft', 'needs_review', 'approved')
    where submission.workspace_id = target_workspace_id
      and submission.release_status is distinct from 'released'
  )
  select count(*)::bigint
  into exact_total
  from queue_candidates candidate
  where candidate.review_reason is not null
    and (target_reason is null or candidate.review_reason = target_reason);

  with queue_candidates as (
    select
      submission.id,
      submission.workspace_id,
      submission.student_id,
      submission.batch_id,
      submission.status,
      submission.evaluation_status,
      submission.release_status,
      submission.release_at,
      coalesce(submission.feedback_mode, 'teacher_review_only') as feedback_mode,
      submission.created_at,
      submission.updated_at,
      case
        when submission.evaluation_status = 'failed' then 'failed'
        when submission.evaluation_status = 'needs_review'
          or draft.state = 'needs_review' then 'uncertain'
        when submission.feedback_mode = 'teacher_review_only'
          and submission.evaluation_status = 'ready'
          and submission.release_status = 'held'
          and draft.state in ('draft', 'approved') then 'teacher_review'
        else null
      end as review_reason,
      draft.id as feedback_version_id,
      draft.version as feedback_version,
      draft.revision as feedback_revision,
      draft.state as feedback_state,
      coalesce(profile.full_name, profile.email, 'Student') as student_name,
      profile.email as student_email,
      batch.name as batch_name,
      coalesce(workspace_question.title, global_question.title, 'Free Writing')
        as question_title,
      case when submission.feedback_error is null then null else 'feedback_failed' end
        as error_code
    from public.submissions submission
    left join app_private.feedback_drafts draft
      on draft.submission_id = submission.id
     and draft.state in ('draft', 'needs_review', 'approved')
    join public.profiles profile on profile.id = submission.student_id
    left join public.batches batch on batch.id = submission.batch_id
    left join public.questions workspace_question
      on workspace_question.id = submission.question_id
    left join public.global_questions global_question
      on global_question.id = submission.global_question_id
    where submission.workspace_id = target_workspace_id
      and submission.release_status is distinct from 'released'
  ),
  filtered_candidates as (
    select candidate.*
    from queue_candidates candidate
    where candidate.review_reason is not null
      and (target_reason is null or candidate.review_reason = target_reason)
      and (
        cursor_created_at is null
        or (candidate.created_at, candidate.id) < (cursor_created_at, cursor_id)
      )
    order by candidate.created_at desc, candidate.id desc
    limit requested_page_size + 1
  ),
  visible_rows as (
    select candidate.*
    from filtered_candidates candidate
    order by candidate.created_at desc, candidate.id desc
    limit requested_page_size
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', row.id,
          'workspace_id', row.workspace_id,
          'student_id', row.student_id,
          'batch_id', row.batch_id,
          'status', row.status,
          'evaluation_status', row.evaluation_status,
          'release_status', row.release_status,
          'release_at', row.release_at,
          'feedback_mode', row.feedback_mode,
          'review_reason', row.review_reason,
          'feedback_version_id', row.feedback_version_id,
          'feedback_version', row.feedback_version,
          'feedback_revision', row.feedback_revision,
          'feedback_state', row.feedback_state,
          'student_name', row.student_name,
          'student_email', row.student_email,
          'batch_name', row.batch_name,
          'question_title', row.question_title,
          'error_code', row.error_code,
          'created_at', row.created_at,
          'updated_at', row.updated_at
        )
        order by row.created_at desc, row.id desc
      ),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from filtered_candidates)
  into page_items, page_has_more
  from visible_rows row;

  if page_has_more and jsonb_array_length(page_items) > 0 then
    page_next_cursor := jsonb_build_object(
      'created_at', page_items #>> array[
        (jsonb_array_length(page_items) - 1)::text,
        'created_at'
      ],
      'id', page_items #>> array[
        (jsonb_array_length(page_items) - 1)::text,
        'id'
      ]
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'items', page_items,
    'total_count', exact_total,
    'returned_count', jsonb_array_length(page_items),
    'page_size', requested_page_size,
    'has_more', page_has_more,
    'next_cursor', page_next_cursor
  );
end;
$$;

revoke all on function api.get_feedback_draft(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.update_feedback_draft(uuid, jsonb, integer)
from public, anon, authenticated, service_role;
revoke all on function api.release_feedback(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.list_feedback_review_queue_page(
  uuid,
  text,
  integer,
  timestamptz,
  uuid
) from public, anon, authenticated, service_role;

grant execute on function api.get_feedback_draft(uuid) to authenticated;
grant execute on function api.update_feedback_draft(uuid, jsonb, integer)
to authenticated;
grant execute on function api.release_feedback(uuid, uuid) to authenticated;
grant execute on function api.list_feedback_review_queue_page(
  uuid,
  text,
  integer,
  timestamptz,
  uuid
) to authenticated;

comment on function api.get_feedback_draft(uuid) is
  'Teacher-only private current feedback draft read. Never granted to students by row context.';
comment on function api.update_feedback_draft(uuid, jsonb, integer) is
  'Revision-safe teacher edit. Phase 11A revalidates content and derives topic and score summaries.';
comment on function api.release_feedback(uuid, uuid) is
  'Atomically approves, materializes, releases, refreshes released-only statistics, and audits feedback.';
comment on function api.list_feedback_review_queue_page(
  uuid,
  text,
  integer,
  timestamptz,
  uuid
) is
  'Teacher-only keyset page for writing feedback awaiting review or retry.';
