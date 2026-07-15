-- Phase 10A: paginated submission read models (after the Phase 9A state model).
--
-- These security-invoker routines preserve base-table RLS while replacing
-- capped client-side list assembly and multi-request detail hydration. They
-- deliberately return list excerpts rather than full writing/feedback data.

create or replace function api.list_workspace_submissions_page(
  target_workspace_id uuid,
  target_student_id uuid default null,
  target_batch_id uuid default null,
  target_evaluation_status text default null,
  target_release_status text default null,
  requested_page_size integer default 25,
  cursor_created_at timestamptz default null,
  cursor_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  is_service_role boolean := current_user = 'service_role' or jwt_role = 'service_role';
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if target_workspace_id is null then
    raise exception using
      errcode = '22023',
      message = 'Workspace is required.';
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

  if target_evaluation_status is not null
    and target_evaluation_status not in ('queued', 'processing', 'ready', 'needs_review', 'failed')
  then
    raise exception using
      errcode = '22023',
      message = 'Evaluation status filter is invalid.';
  end if;

  if target_release_status is not null
    and target_release_status not in ('held', 'scheduled', 'released')
  then
    raise exception using
      errcode = '22023',
      message = 'Release status filter is invalid.';
  end if;

  if not is_service_role then
    if actor_id is null then
      raise exception using
        errcode = '28000',
        message = 'Authentication required.';
    end if;

    if not public.is_platform_admin()
      and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
    then
      raise exception using
        errcode = '42501',
        message = 'Permission denied.';
    end if;
  end if;

  if target_batch_id is not null
    and not exists (
      select 1
      from public.batches batch
      where batch.id = target_batch_id
        and batch.workspace_id = target_workspace_id
    )
  then
    raise exception using
      errcode = '22023',
      message = 'Batch does not belong to the workspace.';
  end if;

  select count(*)::bigint
  into exact_total
  from public.submissions submission
  where submission.workspace_id = target_workspace_id
    and (target_student_id is null or submission.student_id = target_student_id)
    and (target_batch_id is null or submission.batch_id = target_batch_id)
    and (
      target_evaluation_status is null
      or submission.evaluation_status = target_evaluation_status
    )
    and (
      target_release_status is null
      or submission.release_status = target_release_status
    );

  with candidate_rows as (
    select
      submission.id,
      submission.workspace_id,
      submission.student_id,
      submission.batch_id,
      submission.question_id,
      submission.global_question_id,
      submission.question_source,
      submission.mode,
      submission.status,
      submission.evaluation_status,
      submission.release_status,
      submission.release_at,
      submission.feedback_mode,
      submission.feedback_scheduled_at,
      case when submission.feedback_error is null then null else 'feedback_failed' end
        as feedback_error_code,
      submission.created_at,
      submission.updated_at,
      left(submission.original_text, 280) as original_text_excerpt,
      char_length(submission.original_text) as original_character_count,
      coalesce(workspace_question.title, global_question.title, 'Free Writing')
        as question_title,
      coalesce(workspace_question.level, global_question.level) as question_level,
      coalesce(workspace_question.topic, global_question.topic) as question_topic,
      case submission.question_source
        when 'workspace_question' then 'Workspace writing task'
        when 'global_question' then 'Global writing task'
        else 'Free writing'
      end as question_source_label,
      batch.name as batch_name,
      batch.level as batch_level,
      coalesce(profile.full_name, profile.email, 'Student') as student_name,
      profile.email as student_email
    from public.submissions submission
    left join public.questions workspace_question
      on workspace_question.id = submission.question_id
    left join public.global_questions global_question
      on global_question.id = submission.global_question_id
    left join public.batches batch
      on batch.id = submission.batch_id
    left join public.profiles profile
      on profile.id = submission.student_id
    where submission.workspace_id = target_workspace_id
      and (target_student_id is null or submission.student_id = target_student_id)
      and (target_batch_id is null or submission.batch_id = target_batch_id)
      and (
        target_evaluation_status is null
        or submission.evaluation_status = target_evaluation_status
      )
      and (
        target_release_status is null
        or submission.release_status = target_release_status
      )
      and (
        cursor_created_at is null
        or (submission.created_at, submission.id) < (cursor_created_at, cursor_id)
      )
    order by submission.created_at desc, submission.id desc
    limit (requested_page_size + 1)
  ),
  page_rows as (
    select *
    from candidate_rows
    order by created_at desc, id desc
    limit requested_page_size
  ),
  candidate_stats as (
    select count(*)::integer as candidate_count
    from candidate_rows
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'workspace_id', page_row.workspace_id,
            'student_id', page_row.student_id,
            'batch_id', page_row.batch_id,
            'question_id', page_row.question_id,
            'global_question_id', page_row.global_question_id,
            'question_source', page_row.question_source,
            'mode', page_row.mode,
            'status', page_row.status,
            'evaluation_status', page_row.evaluation_status,
            'release_status', page_row.release_status,
            'release_at', page_row.release_at,
            'feedback_mode', page_row.feedback_mode,
            'feedback_scheduled_at', page_row.feedback_scheduled_at,
            'feedback_error_code', page_row.feedback_error_code,
            'created_at', page_row.created_at,
            'updated_at', page_row.updated_at,
            'original_text_excerpt', page_row.original_text_excerpt,
            'original_character_count', page_row.original_character_count,
            'question_title', page_row.question_title,
            'question_level', page_row.question_level,
            'question_topic', page_row.question_topic,
            'question_source_label', page_row.question_source_label,
            'batch_name', page_row.batch_name,
            'batch_level', page_row.batch_level,
            'student_name', page_row.student_name,
            'student_email', page_row.student_email
          )
          order by page_row.created_at desc, page_row.id desc
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    candidate_stats.candidate_count > requested_page_size,
    case
      when candidate_stats.candidate_count > requested_page_size then (
        select jsonb_build_object(
          'created_at', last_row.created_at,
          'id', last_row.id
        )
        from page_rows last_row
        order by last_row.created_at asc, last_row.id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor
  from candidate_stats;

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

create or replace function api.list_student_submissions_page(
  target_workspace_id uuid,
  target_student_id uuid,
  target_batch_id uuid default null,
  target_evaluation_status text default null,
  target_release_status text default null,
  requested_page_size integer default 20,
  cursor_created_at timestamptz default null,
  cursor_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  is_service_role boolean := current_user = 'service_role' or jwt_role = 'service_role';
  is_admin boolean := false;
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if target_workspace_id is null or target_student_id is null then
    raise exception using
      errcode = '22023',
      message = 'Workspace and student are required.';
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

  if target_evaluation_status is not null
    and target_evaluation_status not in ('queued', 'processing', 'ready', 'needs_review', 'failed')
  then
    raise exception using
      errcode = '22023',
      message = 'Evaluation status filter is invalid.';
  end if;

  if target_release_status is not null
    and target_release_status not in ('held', 'scheduled', 'released')
  then
    raise exception using
      errcode = '22023',
      message = 'Release status filter is invalid.';
  end if;

  if not is_service_role then
    if actor_id is null then
      raise exception using
        errcode = '28000',
        message = 'Authentication required.';
    end if;

    is_admin := public.is_platform_admin();
    if not is_admin and actor_id <> target_student_id then
      raise exception using
        errcode = '42501',
        message = 'Permission denied.';
    end if;

    if not is_admin and not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = target_student_id
        and membership.role = 'student'
    )
    then
      raise exception using
        errcode = '42501',
        message = 'Permission denied.';
    end if;
  end if;

  if target_batch_id is not null
    and not exists (
      select 1
      from public.batch_students assignment
      where assignment.workspace_id = target_workspace_id
        and assignment.batch_id = target_batch_id
        and assignment.student_id = target_student_id
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Permission denied.';
  end if;

  select count(*)::bigint
  into exact_total
  from public.submissions submission
  where submission.workspace_id = target_workspace_id
    and submission.student_id = target_student_id
    and (target_batch_id is null or submission.batch_id = target_batch_id)
    and (
      target_evaluation_status is null
      or submission.evaluation_status = target_evaluation_status
    )
    and (
      target_release_status is null
      or submission.release_status = target_release_status
    );

  with candidate_rows as (
    select
      submission.id,
      submission.workspace_id,
      submission.student_id,
      submission.batch_id,
      submission.question_id,
      submission.global_question_id,
      submission.question_source,
      submission.mode,
      submission.status,
      submission.evaluation_status,
      submission.release_status,
      submission.release_at,
      submission.feedback_mode,
      submission.feedback_scheduled_at,
      case when submission.feedback_error is null then null else 'feedback_failed' end
        as feedback_error_code,
      submission.created_at,
      submission.updated_at,
      left(submission.original_text, 280) as original_text_excerpt,
      char_length(submission.original_text) as original_character_count,
      coalesce(workspace_question.title, global_question.title, 'Free Writing')
        as question_title,
      coalesce(workspace_question.level, global_question.level) as question_level,
      coalesce(workspace_question.topic, global_question.topic) as question_topic,
      case submission.question_source
        when 'workspace_question' then 'Workspace writing task'
        when 'global_question' then 'Global writing task'
        else 'Free writing'
      end as question_source_label,
      batch.name as batch_name,
      batch.level as batch_level,
      coalesce(profile.full_name, profile.email, 'Student') as student_name,
      profile.email as student_email
    from public.submissions submission
    left join public.questions workspace_question
      on workspace_question.id = submission.question_id
    left join public.global_questions global_question
      on global_question.id = submission.global_question_id
    left join public.batches batch
      on batch.id = submission.batch_id
    left join public.profiles profile
      on profile.id = submission.student_id
    where submission.workspace_id = target_workspace_id
      and submission.student_id = target_student_id
      and (target_batch_id is null or submission.batch_id = target_batch_id)
      and (
        target_evaluation_status is null
        or submission.evaluation_status = target_evaluation_status
      )
      and (
        target_release_status is null
        or submission.release_status = target_release_status
      )
      and (
        cursor_created_at is null
        or (submission.created_at, submission.id) < (cursor_created_at, cursor_id)
      )
    order by submission.created_at desc, submission.id desc
    limit (requested_page_size + 1)
  ),
  page_rows as (
    select *
    from candidate_rows
    order by created_at desc, id desc
    limit requested_page_size
  ),
  candidate_stats as (
    select count(*)::integer as candidate_count
    from candidate_rows
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'workspace_id', page_row.workspace_id,
            'student_id', page_row.student_id,
            'batch_id', page_row.batch_id,
            'question_id', page_row.question_id,
            'global_question_id', page_row.global_question_id,
            'question_source', page_row.question_source,
            'mode', page_row.mode,
            'status', page_row.status,
            'evaluation_status', page_row.evaluation_status,
            'release_status', page_row.release_status,
            'release_at', page_row.release_at,
            'feedback_mode', page_row.feedback_mode,
            'feedback_scheduled_at', page_row.feedback_scheduled_at,
            'feedback_error_code', page_row.feedback_error_code,
            'created_at', page_row.created_at,
            'updated_at', page_row.updated_at,
            'original_text_excerpt', page_row.original_text_excerpt,
            'original_character_count', page_row.original_character_count,
            'question_title', page_row.question_title,
            'question_level', page_row.question_level,
            'question_topic', page_row.question_topic,
            'question_source_label', page_row.question_source_label,
            'batch_name', page_row.batch_name,
            'batch_level', page_row.batch_level,
            'student_name', page_row.student_name,
            'student_email', page_row.student_email
          )
          order by page_row.created_at desc, page_row.id desc
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    candidate_stats.candidate_count > requested_page_size,
    case
      when candidate_stats.candidate_count > requested_page_size then (
        select jsonb_build_object(
          'created_at', last_row.created_at,
          'id', last_row.id
        )
        from page_rows last_row
        order by last_row.created_at asc, last_row.id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor
  from candidate_stats;

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

create or replace function api.get_submission_detail(target_submission_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  is_service_role boolean := current_user = 'service_role' or jwt_role = 'service_role';
  is_admin boolean := false;
  is_teacher boolean := false;
  is_student_owner boolean := false;
  feedback_visible boolean := false;
  selected_submission public.submissions%rowtype;
  submission_json jsonb;
  feedback_lines_json jsonb := '[]'::jsonb;
  feedback_topics_json jsonb := '[]'::jsonb;
  feedback_json jsonb;
begin
  if target_submission_id is null then
    raise exception using
      errcode = '22023',
      message = 'Submission is required.';
  end if;

  if not is_service_role and actor_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select submission.*
  into selected_submission
  from public.submissions submission
  where submission.id = target_submission_id;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Submission not found or access denied.';
  end if;

  if is_service_role then
    is_teacher := true;
  else
    is_admin := public.is_platform_admin();
    is_teacher := public.has_workspace_role(
      selected_submission.workspace_id,
      array['owner', 'teacher']
    );
    is_student_owner := actor_id = selected_submission.student_id
      and exists (
        select 1
        from public.workspace_members membership
        where membership.workspace_id = selected_submission.workspace_id
          and membership.user_id = actor_id
          and membership.role = 'student'
      );

    if not is_admin and not is_teacher and not is_student_owner then
      raise exception using
        errcode = '42501',
        message = 'Permission denied.';
    end if;
  end if;

  feedback_visible := is_service_role
    or is_admin
    or is_teacher
    or selected_submission.release_status = 'released';

  select jsonb_build_object(
    'id', selected_submission.id,
    'workspace_id', selected_submission.workspace_id,
    'student_id', selected_submission.student_id,
    'batch_id', selected_submission.batch_id,
    'question_id', selected_submission.question_id,
    'global_question_id', selected_submission.global_question_id,
    'question_source', selected_submission.question_source,
    'mode', selected_submission.mode,
    'original_text', selected_submission.original_text,
    'corrected_text', case when feedback_visible then selected_submission.corrected_text else null end,
    'overall_summary', case when feedback_visible then selected_submission.overall_summary else null end,
    'level_detected', case when feedback_visible then selected_submission.level_detected else null end,
    'status', selected_submission.status,
    'evaluation_status', selected_submission.evaluation_status,
    'release_status', selected_submission.release_status,
    'release_at', selected_submission.release_at,
    'evaluation_version', selected_submission.evaluation_version,
    'feedback_mode', selected_submission.feedback_mode,
    'feedback_scheduled_at', selected_submission.feedback_scheduled_at,
    'feedback_started_at', selected_submission.feedback_started_at,
    'feedback_completed_at', selected_submission.feedback_completed_at,
    'feedback_error_code', case
      when selected_submission.feedback_error is null then null
      else 'feedback_failed'
    end,
    'created_at', selected_submission.created_at,
    'updated_at', selected_submission.updated_at,
    'checked_at', case when feedback_visible then selected_submission.checked_at else null end,
    'question_title', coalesce(
      (select question.title from public.questions question where question.id = selected_submission.question_id),
      (select question.title from public.global_questions question where question.id = selected_submission.global_question_id),
      'Free Writing'
    ),
    'question_prompt', coalesce(
      (select question.prompt from public.questions question where question.id = selected_submission.question_id),
      (select question.prompt from public.global_questions question where question.id = selected_submission.global_question_id)
    ),
    'question_level', coalesce(
      (select question.level from public.questions question where question.id = selected_submission.question_id),
      (select question.level from public.global_questions question where question.id = selected_submission.global_question_id)
    ),
    'question_topic', coalesce(
      (select question.topic from public.questions question where question.id = selected_submission.question_id),
      (select question.topic from public.global_questions question where question.id = selected_submission.global_question_id)
    ),
    'question_source_label', case selected_submission.question_source
      when 'workspace_question' then 'Workspace writing task'
      when 'global_question' then 'Global writing task'
      else 'Free writing'
    end,
    'batch_name', (
      select batch.name
      from public.batches batch
      where batch.id = selected_submission.batch_id
    ),
    'batch_level', (
      select batch.level
      from public.batches batch
      where batch.id = selected_submission.batch_id
    ),
    'student_name', (
      select coalesce(profile.full_name, profile.email, 'Student')
      from public.profiles profile
      where profile.id = selected_submission.student_id
    ),
    'student_email', (
      select profile.email
      from public.profiles profile
      where profile.id = selected_submission.student_id
    )
  )
  into submission_json;

  if feedback_visible then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', line.id,
          'line_number', line.line_number,
          'original_line', line.original_line,
          'corrected_line', line.corrected_line,
          'status', line.status,
          'changed_parts', line.changed_parts,
          'short_explanation', line.short_explanation,
          'detailed_explanation', line.detailed_explanation,
          'grammar_topic', case
            when topic.id is null then null
            else jsonb_build_object(
              'id', topic.id,
              'name', topic.name,
              'slug', topic.slug
            )
          end
        )
        order by line.line_number, line.id
      ),
      '[]'::jsonb
    )
    into feedback_lines_json
    from public.submission_lines line
    left join public.grammar_topics topic
      on topic.id = line.grammar_topic_id
    where line.submission_id = target_submission_id;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', summary.id,
          'grammar_topic_id', summary.grammar_topic_id,
          'topic_name', topic.name,
          'topic_slug', topic.slug,
          'count', summary.count,
          'severity', summary.severity,
          'simple_explanation', summary.simple_explanation
        )
        order by topic.name, summary.id
      ),
      '[]'::jsonb
    )
    into feedback_topics_json
    from public.submission_grammar_topics summary
    join public.grammar_topics topic
      on topic.id = summary.grammar_topic_id
    where summary.submission_id = target_submission_id;

    feedback_json := jsonb_build_object(
      'lines', feedback_lines_json,
      'grammar_topics', feedback_topics_json
    );
  else
    feedback_json := null;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'submission', submission_json,
    'feedback', feedback_json
  );
end;
$$;

revoke all on function api.list_workspace_submissions_page(
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer,
  timestamptz,
  uuid
) from public, anon, authenticated, service_role;

revoke all on function api.list_student_submissions_page(
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer,
  timestamptz,
  uuid
) from public, anon, authenticated, service_role;

revoke all on function api.get_submission_detail(uuid)
from public, anon, authenticated, service_role;

grant execute on function api.list_workspace_submissions_page(
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer,
  timestamptz,
  uuid
) to authenticated, service_role;

grant execute on function api.list_student_submissions_page(
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer,
  timestamptz,
  uuid
) to authenticated, service_role;

grant execute on function api.get_submission_detail(uuid)
to authenticated, service_role;

comment on function api.list_workspace_submissions_page(
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer,
  timestamptz,
  uuid
) is
  'Teacher/admin submission list read model. Returns a schema-versioned JSON keyset page with exact filtered total and list-only labels/excerpts.';

comment on function api.list_student_submissions_page(
  uuid,
  uuid,
  uuid,
  text,
  text,
  integer,
  timestamptz,
  uuid
) is
  'Student-owned submission history read model. Requires current workspace membership and returns a schema-versioned JSON keyset page with exact filtered total.';

comment on function api.get_submission_detail(uuid) is
  'Authorized submission detail read model. Students receive child feedback only after release; private feedback drafts are never projected.';
