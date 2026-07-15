-- Phase 12Q: surface a missed scheduled release as an exception instead of
-- leaving validated feedback silently hidden from both teacher and student.
-- The independent Edge recovery sweep uses the existing service-only,
-- bounded api.release_due_feedback facade; this migration adds teacher-visible
-- evidence without exposing that privileged sweep to browser roles.

create or replace function public.list_feedback_review_queue_page_internal(
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
    and target_reason not in (
      'teacher_review',
      'uncertain',
      'failed',
      'overdue_scheduled'
    )
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
        when submission.feedback_mode = 'automatic_delayed'
          and submission.evaluation_status = 'ready'
          and submission.release_status = 'scheduled'
          and submission.release_at <= now() - interval '60 seconds'
          and draft.state in ('draft', 'approved') then 'overdue_scheduled'
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
        when submission.feedback_mode = 'automatic_delayed'
          and submission.evaluation_status = 'ready'
          and submission.release_status = 'scheduled'
          and submission.release_at <= now() - interval '60 seconds'
          and draft.state in ('draft', 'approved') then 'overdue_scheduled'
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
      case
        when submission.feedback_mode = 'automatic_delayed'
          and submission.evaluation_status = 'ready'
          and submission.release_status = 'scheduled'
          and submission.release_at <= now() - interval '60 seconds'
          then 'scheduled_release_overdue'
        when submission.feedback_error is not null then 'feedback_failed'
        else null
      end as error_code
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

revoke all on function public.list_feedback_review_queue_page_internal(
  uuid, text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.list_feedback_review_queue_page_internal(
  uuid, text, integer, timestamptz, uuid
) to authenticated;

comment on function public.list_feedback_review_queue_page_internal(
  uuid, text, integer, timestamptz, uuid
) is
  'Workspace-scoped teacher exception queue, including validated scheduled feedback whose automatic release is overdue.';

comment on function api.release_due_feedback(integer) is
  'Service-only bounded scheduled-feedback release sweep used by both database Cron and independent external recovery.';

notify pgrst, 'reload schema';
