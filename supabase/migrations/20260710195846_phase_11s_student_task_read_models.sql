-- Phase 11S: student task pages own their batch/task completion state and the
-- dashboard asks for released feedback explicitly. Browser clients no longer
-- infer either result from a capped, unrelated submission page.

create index if not exists questions_active_batch_level_page_idx
on public.questions (workspace_id, level, created_at desc, id desc)
where is_active;

create index if not exists global_questions_active_level_page_idx
on public.global_questions (level, created_at desc, id desc)
where is_active;

create index if not exists submissions_latest_workspace_task_idx
on public.submissions (
  student_id,
  workspace_id,
  batch_id,
  question_id,
  created_at desc,
  id desc
)
where question_source = 'workspace_question'
  and question_id is not null;

create index if not exists submissions_latest_global_task_idx
on public.submissions (
  student_id,
  workspace_id,
  batch_id,
  global_question_id,
  created_at desc,
  id desc
)
where question_source = 'global_question'
  and global_question_id is not null;

create index if not exists submissions_student_released_latest_idx
on public.submissions (
  workspace_id,
  student_id,
  batch_id,
  created_at desc,
  id desc
)
where release_status = 'released';

create or replace function api.list_student_assigned_questions_page(
  target_student_id uuid,
  target_batch_id uuid,
  target_search text default null,
  target_level text default null,
  requested_page_size integer default 12,
  cursor_created_at timestamptz default null,
  cursor_source text default null,
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
  is_admin boolean := false;
  clean_search text := lower(btrim(coalesce(target_search, '')));
  selected_context record;
  exact_total bigint := 0;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb := null;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_student_id is null or target_batch_id is null then
    raise exception using errcode = '22023', message = 'student_batch_required';
  end if;

  if requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 50
    or length(clean_search) > 200
    or (
      target_level is not null
      and target_level not in ('A1', 'A2', 'B1', 'B2')
    )
    or (
      cursor_source is not null
      and cursor_source not in ('workspace', 'global')
    )
    or num_nonnulls(cursor_created_at, cursor_source, cursor_id) not in (0, 3)
  then
    raise exception using errcode = '22023', message = 'invalid_assigned_question_page';
  end if;

  is_admin := public.is_platform_admin();
  if actor_id <> target_student_id and not is_admin then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select
    assignment.workspace_id,
    assignment.batch_id,
    batch.name as batch_name,
    batch.level
  into selected_context
  from public.batch_students assignment
  join public.batches batch
    on batch.id = assignment.batch_id
    and batch.workspace_id = assignment.workspace_id
  join public.workspace_members membership
    on membership.workspace_id = assignment.workspace_id
    and membership.user_id = assignment.student_id
    and membership.role = 'student'
  where assignment.student_id = target_student_id
    and assignment.batch_id = target_batch_id
    and batch.is_active;

  if selected_context.batch_id is null then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  with task_catalog as materialized (
    select
      question.id,
      selected_context.workspace_id::text as workspace_id,
      'workspace'::text as source,
      selected_context.batch_id as batch_id,
      selected_context.batch_name::text as batch_name,
      question.title,
      question.prompt,
      question.level,
      question.topic,
      question.task_type,
      question.expected_word_min,
      question.expected_word_max,
      question.estimated_minutes,
      question.is_active,
      question.created_by,
      question.created_at,
      question.updated_at
    from public.questions question
    where question.workspace_id = selected_context.workspace_id
      and question.level = selected_context.level
      and question.is_active

    union all

    select
      question.id,
      selected_context.workspace_id::text as workspace_id,
      'global'::text as source,
      selected_context.batch_id as batch_id,
      selected_context.batch_name::text as batch_name,
      question.title,
      question.prompt,
      question.level,
      question.topic,
      question.task_type,
      question.expected_word_min,
      question.expected_word_max,
      question.estimated_minutes,
      question.is_active,
      question.created_by,
      question.created_at,
      question.updated_at
    from public.global_questions question
    where question.level = selected_context.level
      and question.is_active
  ),
  filtered_tasks as materialized (
    select task.*
    from task_catalog task
    where (target_level is null or task.level = target_level)
      and (
        clean_search = ''
        or position(clean_search in lower(task.title || ' ' || task.topic)) > 0
      )
  ),
  task_count as (
    select count(*)::bigint as exact_total
    from filtered_tasks
  ),
  candidate_tasks as (
    select task.*
    from filtered_tasks task
    where cursor_created_at is null
      or (task.created_at, task.source, task.id)
        < (cursor_created_at, cursor_source, cursor_id)
    order by task.created_at desc, task.source desc, task.id desc
    limit (requested_page_size + 1)
  ),
  page_tasks as (
    select task.*
    from candidate_tasks task
    order by task.created_at desc, task.source desc, task.id desc
    limit requested_page_size
  ),
  page_rows as (
    select
      task.*,
      latest.id as latest_submission_id,
      latest.status as latest_submission_status,
      latest.evaluation_status as latest_evaluation_status,
      latest.release_status as latest_release_status,
      latest.release_at as latest_release_at,
      latest.feedback_mode as latest_feedback_mode,
      latest.created_at as latest_submission_created_at,
      case
        when latest.id is null then 'not_started'
        when latest.status = 'failed' or latest.evaluation_status = 'failed'
          then 'failed'
        when latest.release_status = 'released' then 'feedback_released'
        when latest.evaluation_status = 'needs_review' then 'needs_review'
        when latest.release_status = 'scheduled' then 'scheduled'
        when latest.evaluation_status = 'ready'
          and latest.release_status = 'held' then 'feedback_held'
        when latest.evaluation_status = 'processing' then 'processing'
        when latest.evaluation_status = 'queued' then 'queued'
        else 'submitted'
      end as task_state
    from page_tasks task
    left join lateral (
      select
        submission.id,
        submission.status,
        submission.evaluation_status,
        submission.release_status,
        submission.release_at,
        submission.feedback_mode,
        submission.created_at
      from public.submissions submission
      where submission.student_id = target_student_id
        and submission.workspace_id = selected_context.workspace_id
        and submission.batch_id = selected_context.batch_id
        and (
          (
            task.source = 'workspace'
            and submission.question_source = 'workspace_question'
            and submission.question_id = task.id
          )
          or (
            task.source = 'global'
            and submission.question_source = 'global_question'
            and submission.global_question_id = task.id
          )
        )
      order by submission.created_at desc, submission.id desc
      limit 1
    ) latest on true
  ),
  candidate_stats as (
    select count(*)::integer as candidate_count
    from candidate_tasks
  )
  select
    task_count.exact_total,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'workspace_id', page_row.workspace_id,
            'source', page_row.source,
            'batch_id', page_row.batch_id,
            'batch_name', page_row.batch_name,
            'title', page_row.title,
            'prompt', page_row.prompt,
            'level', page_row.level,
            'topic', page_row.topic,
            'task_type', page_row.task_type,
            'expected_word_min', page_row.expected_word_min,
            'expected_word_max', page_row.expected_word_max,
            'estimated_minutes', page_row.estimated_minutes,
            'is_active', page_row.is_active,
            'created_by', page_row.created_by,
            'created_at', page_row.created_at,
            'updated_at', page_row.updated_at,
            'task_state', page_row.task_state,
            'latest_submission_id', page_row.latest_submission_id,
            'latest_submission_status', page_row.latest_submission_status,
            'latest_evaluation_status', page_row.latest_evaluation_status,
            'latest_release_status', page_row.latest_release_status,
            'latest_release_at', page_row.latest_release_at,
            'latest_feedback_mode', page_row.latest_feedback_mode,
            'latest_submission_created_at', page_row.latest_submission_created_at
          )
          order by page_row.created_at desc, page_row.source desc, page_row.id desc
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
          'source', last_row.source,
          'id', last_row.id
        )
        from page_tasks last_row
        order by last_row.created_at asc, last_row.source asc, last_row.id asc
        limit 1
      )
      else null
    end
  into exact_total, page_items, page_has_more, page_next_cursor
  from task_count
  cross join candidate_stats;

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

-- The legacy all-class JSON array remains only for already-open clients. It is
-- deliberately capped; new clients use the explicit-batch keyset page above.
create or replace function api.list_student_assigned_questions(target_student_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  result jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_student_id is null then
    raise exception using errcode = '22023', message = 'student_required';
  end if;

  if actor_id <> target_student_id and not public.is_platform_admin() then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  with active_contexts as materialized (
    select
      assignment.workspace_id,
      assignment.batch_id,
      batch.name as batch_name,
      batch.level
    from public.batch_students assignment
    join public.batches batch
      on batch.id = assignment.batch_id
      and batch.workspace_id = assignment.workspace_id
    join public.workspace_members membership
      on membership.workspace_id = assignment.workspace_id
      and membership.user_id = assignment.student_id
      and membership.role = 'student'
    where assignment.student_id = target_student_id
      and batch.is_active
  ),
  assigned_questions as (
    select
      question.id,
      question.workspace_id::text as workspace_id,
      'workspace'::text as source,
      context.batch_id,
      context.batch_name,
      question.title,
      question.prompt,
      question.level,
      question.topic,
      question.task_type,
      question.expected_word_min,
      question.expected_word_max,
      question.estimated_minutes,
      question.is_active,
      question.created_by,
      question.created_at,
      question.updated_at
    from active_contexts context
    join public.questions question
      on question.workspace_id = context.workspace_id
      and question.level = context.level
      and question.is_active

    union all

    select
      question.id,
      'global'::text as workspace_id,
      'global'::text as source,
      context.batch_id,
      context.batch_name,
      question.title,
      question.prompt,
      question.level,
      question.topic,
      question.task_type,
      question.expected_word_min,
      question.expected_word_max,
      question.estimated_minutes,
      question.is_active,
      question.created_by,
      question.created_at,
      question.updated_at
    from active_contexts context
    join public.global_questions question
      on question.level = context.level
      and question.is_active
  ),
  bounded_questions as (
    select assigned_question.*
    from assigned_questions assigned_question
    order by assigned_question.batch_name,
      assigned_question.source,
      assigned_question.created_at desc,
      assigned_question.id
    limit 100
  )
  select coalesce(
    jsonb_agg(
      to_jsonb(bounded_question)
      order by bounded_question.batch_name,
        bounded_question.source,
        bounded_question.created_at desc,
        bounded_question.id
    ),
    '[]'::jsonb
  )
  into result
  from bounded_questions bounded_question;

  return result;
end;
$$;

create or replace function api.get_student_released_feedback_summary(
  target_workspace_id uuid,
  target_student_id uuid,
  target_batch_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  is_admin boolean := false;
  released_count bigint := 0;
  latest_feedback jsonb := null;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null or target_student_id is null then
    raise exception using errcode = '22023', message = 'workspace_student_required';
  end if;

  is_admin := public.is_platform_admin();
  if actor_id <> target_student_id and not is_admin then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if not exists (
    select 1
    from public.workspace_members membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = target_student_id
      and membership.role = 'student'
  ) then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if target_batch_id is not null and not exists (
    select 1
    from public.batch_students assignment
    where assignment.workspace_id = target_workspace_id
      and assignment.batch_id = target_batch_id
      and assignment.student_id = target_student_id
  ) then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into released_count
  from public.submissions submission
  where submission.workspace_id = target_workspace_id
    and submission.student_id = target_student_id
    and submission.release_status = 'released'
    and (target_batch_id is null or submission.batch_id = target_batch_id);

  select jsonb_build_object(
    'id', submission.id,
    'created_at', submission.created_at,
    'question_title', coalesce(
      workspace_question.title,
      global_question.title,
      'Free Writing'
    )
  )
  into latest_feedback
  from public.submissions submission
  left join public.questions workspace_question
    on workspace_question.id = submission.question_id
  left join public.global_questions global_question
    on global_question.id = submission.global_question_id
  where submission.workspace_id = target_workspace_id
    and submission.student_id = target_student_id
    and submission.release_status = 'released'
    and (target_batch_id is null or submission.batch_id = target_batch_id)
  order by submission.created_at desc, submission.id desc
  limit 1;

  return jsonb_build_object(
    'schema_version', 1,
    'released_count', released_count,
    'latest_submission', latest_feedback
  );
end;
$$;

revoke all on function api.list_student_assigned_questions_page(
  uuid, uuid, text, text, integer, timestamptz, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function api.list_student_assigned_questions_page(
  uuid, uuid, text, text, integer, timestamptz, text, uuid
) to authenticated;

revoke all on function api.list_student_assigned_questions(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.list_student_assigned_questions(uuid)
to authenticated;

revoke all on function api.get_student_released_feedback_summary(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function api.get_student_released_feedback_summary(uuid, uuid, uuid)
to authenticated;

comment on function api.list_student_assigned_questions_page(
  uuid, uuid, text, text, integer, timestamptz, text, uuid
) is
  'Returns one authorized class task page with server-derived latest submission state per exact batch/source/task key.';

comment on function api.list_student_assigned_questions(uuid) is
  'Deprecated compatibility array capped at 100 rows; use list_student_assigned_questions_page for complete traversal.';

comment on function api.get_student_released_feedback_summary(uuid, uuid, uuid) is
  'Returns only the exact released-feedback count and latest submission link metadata for an authorized student context.';

notify pgrst, 'reload schema';
