-- Phase 11C: browser Data API cutover.
--
-- The production browser targets the deliberately exposed `api` schema only.
-- These routines replace browser-side joins and direct table mutations with
-- explicit, context-bound read models and commands. All exposed routines stay
-- SECURITY INVOKER; existing table RLS remains the final authorization layer.

-- ---------------------------------------------------------------------------
-- Workspace and batch read models / commands
-- ---------------------------------------------------------------------------

create or replace function api.get_workspace(target_workspace_id uuid)
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

  if target_workspace_id is null then
    raise exception using errcode = '22023', message = 'workspace_required';
  end if;

  if not public.is_platform_admin()
    and not public.is_workspace_member(target_workspace_id)
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select jsonb_build_object(
    'id', workspace.id,
    'name', workspace.name,
    'slug', workspace.slug
  )
  into result
  from public.workspaces workspace
  where workspace.id = target_workspace_id;

  if result is null then
    raise exception using errcode = 'P0002', message = 'workspace_not_found';
  end if;

  return result;
end;
$$;

create or replace function api.list_workspace_batches_page(
  target_workspace_id uuid,
  requested_page_size integer default 50,
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
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null then
    raise exception using errcode = '22023', message = 'workspace_required';
  end if;

  if requested_page_size is null or requested_page_size < 1 or requested_page_size > 100 then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;

  if (cursor_created_at is null) <> (cursor_id is null) then
    raise exception using errcode = '22023', message = 'invalid_cursor';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into exact_total
  from public.batches batch
  where batch.workspace_id = target_workspace_id;

  with join_codes as materialized (
    select *
    from public.list_workspace_batch_join_codes(target_workspace_id)
  ),
  candidate_rows as materialized (
    select
      batch.id,
      batch.workspace_id,
      batch.name,
      batch.level,
      batch.description,
      batch.is_active,
      join_codes.join_code,
      join_codes.join_code_enabled,
      join_codes.join_requires_approval,
      batch.feedback_mode,
      batch.feedback_delay_min_minutes,
      batch.feedback_delay_max_minutes,
      batch.created_by,
      batch.created_at,
      batch.updated_at,
      (
        select count(*)::integer
        from public.batch_students assignment
        where assignment.workspace_id = batch.workspace_id
          and assignment.batch_id = batch.id
      ) as student_count,
      (
        select count(*)::integer
        from public.submissions submission
        where submission.workspace_id = batch.workspace_id
          and submission.batch_id = batch.id
      ) as submission_count
    from public.batches batch
    join join_codes on join_codes.batch_id = batch.id
    where batch.workspace_id = target_workspace_id
      and (
        cursor_created_at is null
        or (batch.created_at, batch.id) < (cursor_created_at, cursor_id)
      )
    order by batch.created_at desc, batch.id desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select *
    from candidate_rows
    order by created_at desc, id desc
    limit requested_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(to_jsonb(page_row) order by page_row.created_at desc, page_row.id desc)
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object('created_at', page_row.created_at, 'id', page_row.id)
        from page_rows page_row
        order by page_row.created_at asc, page_row.id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor;

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

create or replace function api.create_workspace_batch(
  target_workspace_id uuid,
  batch_name text,
  batch_level text,
  batch_description text default null,
  batch_is_active boolean default true,
  batch_join_code_enabled boolean default true,
  batch_feedback_mode text default 'teacher_review_only',
  batch_feedback_delay_min_minutes integer default 15,
  batch_feedback_delay_max_minutes integer default 180
)
returns table (batch_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  created_id uuid;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null
    or batch_name is null
    or length(btrim(batch_name)) not between 1 and 160
    or batch_level not in ('A1', 'A2', 'B1', 'B2')
    or (batch_description is not null and length(batch_description) > 4000)
    or batch_feedback_mode not in ('immediate', 'automatic_delayed', 'teacher_review_only')
    or batch_feedback_delay_min_minutes is null
    or batch_feedback_delay_max_minutes is null
    or batch_feedback_delay_min_minutes < 0
    or batch_feedback_delay_max_minutes < batch_feedback_delay_min_minutes
    or batch_feedback_delay_max_minutes > 10080
  then
    raise exception using errcode = '22023', message = 'invalid_batch';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  insert into public.batches (
    workspace_id,
    created_by,
    name,
    level,
    description,
    is_active,
    join_code_enabled,
    join_requires_approval,
    feedback_mode,
    feedback_delay_min_minutes,
    feedback_delay_max_minutes
  ) values (
    target_workspace_id,
    actor_id,
    btrim(batch_name),
    batch_level,
    nullif(btrim(batch_description), ''),
    coalesce(batch_is_active, true),
    coalesce(batch_join_code_enabled, true),
    true,
    batch_feedback_mode,
    batch_feedback_delay_min_minutes,
    batch_feedback_delay_max_minutes
  )
  returning id into created_id;

  return query select created_id;
end;
$$;

create or replace function api.update_workspace_batch(
  target_workspace_id uuid,
  target_batch_id uuid,
  batch_name text,
  batch_level text,
  batch_description text default null,
  batch_is_active boolean default true,
  batch_join_code_enabled boolean default true,
  batch_feedback_mode text default 'teacher_review_only',
  batch_feedback_delay_min_minutes integer default 15,
  batch_feedback_delay_max_minutes integer default 180
)
returns table (batch_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null
    or target_batch_id is null
    or batch_name is null
    or length(btrim(batch_name)) not between 1 and 160
    or batch_level not in ('A1', 'A2', 'B1', 'B2')
    or (batch_description is not null and length(batch_description) > 4000)
    or batch_feedback_mode not in ('immediate', 'automatic_delayed', 'teacher_review_only')
    or batch_feedback_delay_min_minutes is null
    or batch_feedback_delay_max_minutes is null
    or batch_feedback_delay_min_minutes < 0
    or batch_feedback_delay_max_minutes < batch_feedback_delay_min_minutes
    or batch_feedback_delay_max_minutes > 10080
  then
    raise exception using errcode = '22023', message = 'invalid_batch';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  update public.batches batch
  set
    name = btrim(batch_name),
    level = batch_level,
    description = nullif(btrim(batch_description), ''),
    is_active = coalesce(batch_is_active, true),
    join_code_enabled = coalesce(batch_join_code_enabled, true),
    join_requires_approval = true,
    feedback_mode = batch_feedback_mode,
    feedback_delay_min_minutes = batch_feedback_delay_min_minutes,
    feedback_delay_max_minutes = batch_feedback_delay_max_minutes
  where batch.id = target_batch_id
    and batch.workspace_id = target_workspace_id
  returning batch.id into updated_id;

  if updated_id is null then
    raise exception using errcode = 'P0002', message = 'batch_not_found';
  end if;

  return query select updated_id;
end;
$$;

create or replace function api.set_batch_active(
  target_workspace_id uuid,
  target_batch_id uuid,
  target_is_active boolean
)
returns table (batch_id uuid, is_active boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_id uuid;
  updated_active boolean;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null or target_batch_id is null or target_is_active is null then
    raise exception using errcode = '22023', message = 'invalid_batch_state';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  update public.batches batch
  set is_active = target_is_active
  where batch.id = target_batch_id
    and batch.workspace_id = target_workspace_id
  returning batch.id, batch.is_active into updated_id, updated_active;

  if updated_id is null then
    raise exception using errcode = 'P0002', message = 'batch_not_found';
  end if;

  return query select updated_id, updated_active;
end;
$$;

-- ---------------------------------------------------------------------------
-- Writing-question read models / commands
-- ---------------------------------------------------------------------------

create or replace function api.list_workspace_questions_page(
  target_workspace_id uuid,
  requested_page_size integer default 50,
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
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null then
    raise exception using errcode = '22023', message = 'workspace_required';
  end if;

  if requested_page_size is null or requested_page_size < 1 or requested_page_size > 100 then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;

  if (cursor_created_at is null) <> (cursor_id is null) then
    raise exception using errcode = '22023', message = 'invalid_cursor';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into exact_total
  from public.questions question
  where question.workspace_id = target_workspace_id;

  with candidate_rows as materialized (
    select
      question.id,
      question.workspace_id,
      'workspace'::text as source,
      null::uuid as batch_id,
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
    where question.workspace_id = target_workspace_id
      and (
        cursor_created_at is null
        or (question.created_at, question.id) < (cursor_created_at, cursor_id)
      )
    order by question.created_at desc, question.id desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select * from candidate_rows
    order by created_at desc, id desc
    limit requested_page_size
  )
  select
    coalesce(
      (select jsonb_agg(to_jsonb(page_row) order by page_row.created_at desc, page_row.id desc) from page_rows page_row),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object('created_at', page_row.created_at, 'id', page_row.id)
        from page_rows page_row
        order by page_row.created_at asc, page_row.id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor;

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

create or replace function api.list_global_questions_page(
  target_levels text[] default null,
  requested_page_size integer default 100,
  requested_offset integer default 0
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if not public.is_platform_admin()
    and not exists (
      select 1
      from public.workspace_members membership
      where membership.user_id = (select auth.uid())
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if requested_page_size is null or requested_page_size < 1 or requested_page_size > 200
    or requested_offset is null or requested_offset < 0 or requested_offset > 100000
    or exists (
      select 1 from unnest(coalesce(target_levels, array[]::text[])) level_name
      where level_name not in ('A1', 'A2', 'B1', 'B2')
    )
  then
    raise exception using errcode = '22023', message = 'invalid_question_page';
  end if;

  select count(*)::bigint
  into exact_total
  from public.global_questions question
  where question.is_active
    and (target_levels is null or question.level = any(target_levels));

  select coalesce(
    jsonb_agg(to_jsonb(page_row) order by page_row.sort_order, page_row.created_at desc, page_row.id),
    '[]'::jsonb
  )
  into page_items
  from (
    select
      question.id,
      'global'::text as workspace_id,
      'global'::text as source,
      null::uuid as batch_id,
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
      question.updated_at,
      question.sort_order
    from public.global_questions question
    where question.is_active
      and (target_levels is null or question.level = any(target_levels))
    order by question.sort_order, question.created_at desc, question.id
    limit requested_page_size
    offset requested_offset
  ) page_row;

  return jsonb_build_object(
    'schema_version', 1,
    'items', page_items,
    'total_count', exact_total,
    'returned_count', jsonb_array_length(page_items),
    'page_size', requested_page_size,
    'offset', requested_offset,
    'has_more', requested_offset + jsonb_array_length(page_items) < exact_total,
    'next_offset', case
      when requested_offset + jsonb_array_length(page_items) < exact_total
      then requested_offset + jsonb_array_length(page_items)
      else null
    end
  );
end;
$$;

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
      question.workspace_id,
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
  )
  select coalesce(
    jsonb_agg(
      to_jsonb(assigned_question)
      order by assigned_question.batch_name, assigned_question.source, assigned_question.created_at desc, assigned_question.id
    ),
    '[]'::jsonb
  )
  into result
  from assigned_questions assigned_question;

  return result;
end;
$$;

create or replace function api.create_workspace_question(
  target_workspace_id uuid,
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text,
  question_task_type text,
  question_expected_word_min integer default null,
  question_expected_word_max integer default null,
  question_estimated_minutes integer default null,
  question_is_active boolean default true
)
returns table (question_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  created_id uuid;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null
    or question_title is null or length(btrim(question_title)) not between 1 and 240
    or question_prompt is null or length(btrim(question_prompt)) not between 1 and 12000
    or question_level not in ('A1', 'A2', 'B1', 'B2')
    or question_topic is null or length(btrim(question_topic)) not between 1 and 160
    or question_task_type not in ('writing', 'email', 'free_text', 'opinion', 'description')
    or (question_expected_word_min is not null and question_expected_word_min not between 0 and 5000)
    or (question_expected_word_max is not null and question_expected_word_max not between 0 and 5000)
    or (
      question_expected_word_min is not null
      and question_expected_word_max is not null
      and question_expected_word_min > question_expected_word_max
    )
    or (question_estimated_minutes is not null and question_estimated_minutes not between 0 and 1440)
  then
    raise exception using errcode = '22023', message = 'invalid_question';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  insert into public.questions (
    workspace_id,
    created_by,
    title,
    prompt,
    level,
    topic,
    task_type,
    expected_word_min,
    expected_word_max,
    estimated_minutes,
    is_active
  ) values (
    target_workspace_id,
    actor_id,
    btrim(question_title),
    btrim(question_prompt),
    question_level,
    btrim(question_topic),
    question_task_type,
    question_expected_word_min,
    question_expected_word_max,
    question_estimated_minutes,
    coalesce(question_is_active, true)
  )
  returning id into created_id;

  return query select created_id;
end;
$$;

create or replace function api.update_workspace_question(
  target_workspace_id uuid,
  target_question_id uuid,
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text,
  question_task_type text,
  question_expected_word_min integer default null,
  question_expected_word_max integer default null,
  question_estimated_minutes integer default null,
  question_is_active boolean default true
)
returns table (question_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_question_id is null
    or target_workspace_id is null
    or question_title is null or length(btrim(question_title)) not between 1 and 240
    or question_prompt is null or length(btrim(question_prompt)) not between 1 and 12000
    or question_level not in ('A1', 'A2', 'B1', 'B2')
    or question_topic is null or length(btrim(question_topic)) not between 1 and 160
    or question_task_type not in ('writing', 'email', 'free_text', 'opinion', 'description')
    or (question_expected_word_min is not null and question_expected_word_min not between 0 and 5000)
    or (question_expected_word_max is not null and question_expected_word_max not between 0 and 5000)
    or (
      question_expected_word_min is not null
      and question_expected_word_max is not null
      and question_expected_word_min > question_expected_word_max
    )
    or (question_estimated_minutes is not null and question_estimated_minutes not between 0 and 1440)
  then
    raise exception using errcode = '22023', message = 'invalid_question';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  update public.questions question
  set
    title = btrim(question_title),
    prompt = btrim(question_prompt),
    level = question_level,
    topic = btrim(question_topic),
    task_type = question_task_type,
    expected_word_min = question_expected_word_min,
    expected_word_max = question_expected_word_max,
    estimated_minutes = question_estimated_minutes,
    is_active = coalesce(question_is_active, true)
  where question.id = target_question_id
    and question.workspace_id = target_workspace_id
  returning question.id into updated_id;

  if updated_id is null then
    raise exception using errcode = 'P0002', message = 'question_not_found';
  end if;

  return query select updated_id;
end;
$$;

create or replace function api.set_question_active(
  target_workspace_id uuid,
  target_question_id uuid,
  target_is_active boolean
)
returns table (question_id uuid, is_active boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_id uuid;
  updated_active boolean;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null or target_question_id is null or target_is_active is null then
    raise exception using errcode = '22023', message = 'invalid_question_state';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  update public.questions question
  set is_active = target_is_active
  where question.id = target_question_id
    and question.workspace_id = target_workspace_id
  returning question.id, question.is_active into updated_id, updated_active;

  if updated_id is null then
    raise exception using errcode = 'P0002', message = 'question_not_found';
  end if;

  return query select updated_id, updated_active;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enrollment, roster, and join-request read models / commands
-- ---------------------------------------------------------------------------

create or replace function api.list_my_batch_assignments(target_student_id uuid)
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

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', assignment.id,
        'workspace_id', assignment.workspace_id,
        'batch_id', assignment.batch_id,
        'batch_name', batch.name,
        'level', batch.level
      ) order by batch.name, assignment.id
    ),
    '[]'::jsonb
  )
  into result
  from public.batch_students assignment
  join public.batches batch
    on batch.id = assignment.batch_id
    and batch.workspace_id = assignment.workspace_id
  join public.workspace_members membership
    on membership.workspace_id = assignment.workspace_id
    and membership.user_id = assignment.student_id
    and membership.role = 'student'
  where assignment.student_id = target_student_id
    and batch.is_active;

  return result;
end;
$$;

create or replace function api.list_workspace_students_page(
  target_workspace_id uuid,
  requested_page_size integer default 50,
  cursor_created_at timestamptz default null,
  cursor_membership_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null then
    raise exception using errcode = '22023', message = 'workspace_required';
  end if;

  if requested_page_size is null or requested_page_size < 1 or requested_page_size > 100 then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;

  if (cursor_created_at is null) <> (cursor_membership_id is null) then
    raise exception using errcode = '22023', message = 'invalid_cursor';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into exact_total
  from public.workspace_members membership
  where membership.workspace_id = target_workspace_id
    and membership.role = 'student';

  with candidate_rows as materialized (
    select
      membership.id as membership_id,
      membership.created_at as membership_created_at,
      membership.user_id as id,
      coalesce(profile.full_name, profile.email, 'Unnamed student') as name,
      profile.email,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', assignment.id,
              'workspace_id', assignment.workspace_id,
              'batch_id', assignment.batch_id,
              'batch_name', batch.name,
              'level', batch.level
            ) order by batch.name, assignment.id
          )
          from public.batch_students assignment
          join public.batches batch
            on batch.id = assignment.batch_id
            and batch.workspace_id = assignment.workspace_id
          where assignment.workspace_id = membership.workspace_id
            and assignment.student_id = membership.user_id
            and batch.is_active
        ),
        '[]'::jsonb
      ) as batches,
      (
        select count(*)::integer
        from public.submissions submission
        where submission.workspace_id = membership.workspace_id
          and submission.student_id = membership.user_id
      ) as total_submissions,
      (
        select max(submission.created_at)
        from public.submissions submission
        where submission.workspace_id = membership.workspace_id
          and submission.student_id = membership.user_id
      ) as last_active_at
    from public.workspace_members membership
    join public.profiles profile on profile.id = membership.user_id
    where membership.workspace_id = target_workspace_id
      and membership.role = 'student'
      and (
        cursor_created_at is null
        or (membership.created_at, membership.id) < (cursor_created_at, cursor_membership_id)
      )
    order by membership.created_at desc, membership.id desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select * from candidate_rows
    order by membership_created_at desc, membership_id desc
    limit requested_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          (to_jsonb(page_row) - 'membership_created_at')
          order by page_row.membership_created_at desc, page_row.membership_id desc
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object(
          'created_at', page_row.membership_created_at,
          'id', page_row.membership_id
        )
        from page_rows page_row
        order by page_row.membership_created_at asc, page_row.membership_id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor;

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

create or replace function api.list_workspace_batch_join_requests_page(
  target_workspace_id uuid,
  requested_page_size integer default 50,
  cursor_requested_at timestamptz default null,
  cursor_request_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null then
    raise exception using errcode = '22023', message = 'workspace_required';
  end if;

  if requested_page_size is null or requested_page_size < 1 or requested_page_size > 100 then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;

  if (cursor_requested_at is null) <> (cursor_request_id is null) then
    raise exception using errcode = '22023', message = 'invalid_cursor';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into exact_total
  from public.batch_join_requests request
  where request.workspace_id = target_workspace_id;

  with candidate_rows as materialized (
    select
      request.id,
      request.workspace_id,
      request.batch_id,
      request.student_id,
      request.status,
      request.requested_at,
      request.decided_at,
      request.decided_by,
      coalesce(request.student_name, request.student_email) as student_name,
      request.student_email,
      batch.name as batch_name,
      batch.level as batch_level
    from public.batch_join_requests request
    join public.batches batch
      on batch.id = request.batch_id
      and batch.workspace_id = request.workspace_id
    where request.workspace_id = target_workspace_id
      and (
        cursor_requested_at is null
        or (request.requested_at, request.id) < (cursor_requested_at, cursor_request_id)
      )
    order by request.requested_at desc, request.id desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select * from candidate_rows
    order by requested_at desc, id desc
    limit requested_page_size
  )
  select
    coalesce(
      (select jsonb_agg(to_jsonb(page_row) order by page_row.requested_at desc, page_row.id desc) from page_rows page_row),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object('requested_at', page_row.requested_at, 'id', page_row.id)
        from page_rows page_row
        order by page_row.requested_at asc, page_row.id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor;

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

-- Pending students cannot read the batch row through normal RLS yet. This
-- narrowly-scoped helper returns only their own request display metadata.
create or replace function public.list_my_batch_join_requests_secure(
  target_student_id uuid
)
returns jsonb
language plpgsql
security definer
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

  if actor_id <> target_student_id and not app_private.is_platform_admin() then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', request.id,
        'workspace_id', request.workspace_id,
        'batch_id', request.batch_id,
        'student_id', request.student_id,
        'status', request.status,
        'requested_at', request.requested_at,
        'decided_at', request.decided_at,
        'decided_by', request.decided_by,
        'student_name', coalesce(request.student_name, request.student_email),
        'student_email', request.student_email,
        'batch_name', batch.name,
        'batch_level', batch.level
      ) order by request.requested_at desc, request.id desc
    ),
    '[]'::jsonb
  )
  into result
  from public.batch_join_requests request
  join public.batches batch
    on batch.id = request.batch_id
    and batch.workspace_id = request.workspace_id
  where request.student_id = target_student_id;

  return result;
end;
$$;

revoke all on function public.list_my_batch_join_requests_secure(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.list_my_batch_join_requests_secure(uuid)
to authenticated, service_role;

create or replace function api.list_my_batch_join_requests(target_student_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.list_my_batch_join_requests_secure(target_student_id);
$$;

create or replace function api.assign_student_to_batch(
  target_workspace_id uuid,
  target_student_id uuid,
  target_batch_id uuid
)
returns table (assignment_id uuid, created boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_assignment_id uuid;
  was_created boolean := false;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null or target_student_id is null or target_batch_id is null then
    raise exception using errcode = '22023', message = 'assignment_context_required';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if not exists (
    select 1 from public.batches batch
    where batch.id = target_batch_id
      and batch.workspace_id = target_workspace_id
      and batch.is_active
  ) then
    raise exception using errcode = '22023', message = 'active_batch_required';
  end if;

  if not exists (
    select 1 from public.workspace_members membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = target_student_id
      and membership.role = 'student'
  ) then
    raise exception using errcode = '22023', message = 'active_student_membership_required';
  end if;

  insert into public.batch_students (workspace_id, student_id, batch_id)
  values (target_workspace_id, target_student_id, target_batch_id)
  on conflict (batch_id, student_id) do nothing
  returning id into selected_assignment_id;

  if selected_assignment_id is not null then
    was_created := true;
  else
    select assignment.id
    into selected_assignment_id
    from public.batch_students assignment
    where assignment.workspace_id = target_workspace_id
      and assignment.student_id = target_student_id
      and assignment.batch_id = target_batch_id;
  end if;

  return query select selected_assignment_id, was_created;
end;
$$;

create or replace function api.remove_student_batch_assignment(
  target_workspace_id uuid,
  target_assignment_id uuid
)
returns table (assignment_id uuid, removed boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  removed_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null or target_assignment_id is null then
    raise exception using errcode = '22023', message = 'assignment_context_required';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  delete from public.batch_students assignment
  where assignment.id = target_assignment_id
    and assignment.workspace_id = target_workspace_id
  returning assignment.id into removed_id;

  if removed_id is null then
    raise exception using errcode = 'P0002', message = 'assignment_not_found';
  end if;

  return query select removed_id, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grammar-statistics read models
-- ---------------------------------------------------------------------------

create or replace function api.list_student_grammar_stats(
  target_workspace_id uuid,
  target_student_id uuid,
  requested_limit integer default 20
)
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

  if target_workspace_id is null or target_student_id is null
    or requested_limit is null or requested_limit < 1 or requested_limit > 100
  then
    raise exception using errcode = '22023', message = 'invalid_grammar_stats_request';
  end if;

  if actor_id = target_student_id then
    if not exists (
      select 1 from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = target_student_id
        and membership.role = 'student'
    ) then
      raise exception using errcode = '42501', message = 'active_membership_required';
    end if;
  elsif not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(stat_row) order by stat_row.practice_unlocked desc, stat_row.total_major_issues desc, stat_row.total_minor_issues desc, stat_row.id),
    '[]'::jsonb
  )
  into result
  from (
    select
      stat.id,
      stat.workspace_id,
      stat.student_id,
      stat.grammar_topic_id,
      topic.name as topic_name,
      topic.slug as topic_slug,
      topic.description as topic_description,
      stat.total_minor_issues,
      stat.total_major_issues,
      stat.total_correct_after_practice,
      stat.weakness_level,
      stat.practice_unlocked,
      stat.last_seen_at,
      stat.updated_at,
      stat.resolution_cycle_id,
      stat.resolution_cycle_number,
      stat.resolved_through_sequence,
      stat.mastery_pass_count,
      stat.state_reason
    from public.student_grammar_stats stat
    join public.grammar_topics topic on topic.id = stat.grammar_topic_id
    where stat.workspace_id = target_workspace_id
      and stat.student_id = target_student_id
    order by stat.practice_unlocked desc, stat.total_major_issues desc, stat.total_minor_issues desc, stat.id
    limit requested_limit
  ) stat_row;

  return result;
end;
$$;

create or replace function api.list_workspace_grammar_stats_page(
  target_workspace_id uuid,
  requested_page_size integer default 100,
  requested_offset integer default 0
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null
    or requested_page_size is null or requested_page_size < 1 or requested_page_size > 200
    or requested_offset is null or requested_offset < 0 or requested_offset > 100000
  then
    raise exception using errcode = '22023', message = 'invalid_grammar_stats_request';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into exact_total
  from public.student_grammar_stats stat
  where stat.workspace_id = target_workspace_id;

  select coalesce(
    jsonb_agg(to_jsonb(stat_row) order by stat_row.practice_unlocked desc, stat_row.total_major_issues desc, stat_row.total_minor_issues desc, stat_row.id),
    '[]'::jsonb
  )
  into page_items
  from (
    select
      stat.id,
      stat.workspace_id,
      stat.student_id,
      stat.grammar_topic_id,
      topic.name as topic_name,
      topic.slug as topic_slug,
      topic.description as topic_description,
      stat.total_minor_issues,
      stat.total_major_issues,
      stat.total_correct_after_practice,
      stat.weakness_level,
      stat.practice_unlocked,
      stat.last_seen_at,
      stat.updated_at,
      stat.resolution_cycle_id,
      stat.resolution_cycle_number,
      stat.resolved_through_sequence,
      stat.mastery_pass_count,
      stat.state_reason,
      coalesce(profile.full_name, profile.email) as student_name,
      profile.email as student_email
    from public.student_grammar_stats stat
    join public.grammar_topics topic on topic.id = stat.grammar_topic_id
    join public.profiles profile on profile.id = stat.student_id
    where stat.workspace_id = target_workspace_id
    order by stat.practice_unlocked desc, stat.total_major_issues desc, stat.total_minor_issues desc, stat.id
    limit requested_page_size
    offset requested_offset
  ) stat_row;

  return jsonb_build_object(
    'schema_version', 1,
    'items', page_items,
    'total_count', exact_total,
    'returned_count', jsonb_array_length(page_items),
    'page_size', requested_page_size,
    'offset', requested_offset,
    'has_more', requested_offset + jsonb_array_length(page_items) < exact_total,
    'next_offset', case
      when requested_offset + jsonb_array_length(page_items) < exact_total
      then requested_offset + jsonb_array_length(page_items)
      else null
    end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Adaptive-practice read models and command wrappers
-- ---------------------------------------------------------------------------

create or replace function api.get_practice_assignment_summary(
  target_assignment_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  selected_workspace_id uuid;
  selected_student_id uuid;
  result jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_assignment_id is null then
    raise exception using errcode = '22023', message = 'assignment_required';
  end if;

  select assignment.workspace_id, assignment.student_id
  into selected_workspace_id, selected_student_id
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if selected_workspace_id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  if actor_id = selected_student_id then
    if not exists (
      select 1 from public.workspace_members membership
      where membership.workspace_id = selected_workspace_id
        and membership.user_id = actor_id
        and membership.role = 'student'
    ) then
      raise exception using errcode = '42501', message = 'active_membership_required';
    end if;
  elsif not public.is_platform_admin()
    and not public.has_workspace_role(selected_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select jsonb_build_object(
    'id', assignment.id,
    'workspace_id', assignment.workspace_id,
    'student_id', assignment.student_id,
    'grammar_topic_id', assignment.grammar_topic_id,
    'grammar_topic_name', topic.name,
    'grammar_topic_slug', topic.slug,
    'grammar_topic_description', topic.description,
    'practice_test_id', assignment.practice_test_id,
    'worksheet_title', worksheet.title,
    'worksheet_level', worksheet.level,
    'worksheet_difficulty', worksheet.difficulty,
    'worksheet_mini_lesson', worksheet.mini_lesson,
    'status', assignment.status,
    'source', assignment.source,
    'assigned_at', assignment.assigned_at,
    'started_at', assignment.started_at,
    'completed_at', assignment.completed_at,
    'latest_attempt_id', assignment.latest_attempt_id,
    'latest_attempt_status', attempt.status,
    'score', attempt.score,
    'max_score', attempt.max_score,
    'score_points', attempt.score_points,
    'max_score_points', attempt.max_score_points,
    'scoring_version', attempt.scoring_version,
    'evaluation_status', attempt.evaluation_status,
    'evaluation_started_at', attempt.evaluation_started_at,
    'evaluation_completed_at', attempt.evaluation_completed_at,
    'evaluation_error', case when attempt.evaluation_error is null then null else 'evaluation_failed' end,
    'score_percent', attempt.score_percent,
    'passed', attempt.passed,
    'question_count', case
      when assignment.practice_test_id is null then 0
      else (
        select count(*)::integer
        from public.practice_test_questions question
        where question.practice_test_id = assignment.practice_test_id
      )
    end,
    'generation_status', assignment.generation_status,
    'generation_started_at', assignment.generation_started_at,
    'generation_completed_at', assignment.generation_completed_at,
    'generation_error', case when assignment.generation_error is null then null else 'generation_failed' end,
    'previous_assignment_id', assignment.previous_assignment_id,
    'previous_attempt_id', assignment.previous_attempt_id,
    'repeat_number', assignment.repeat_number,
    'adaptive_reason', assignment.adaptive_reason,
    'adaptive_status', assignment.adaptive_status,
    'resolution_cycle_id', assignment.resolution_cycle_id,
    'resolution_cycle_number', assignment.resolution_cycle_number,
    'evidence_cutoff_sequence', assignment.evidence_cutoff_sequence,
    'student_name', coalesce(profile.full_name, profile.email),
    'student_email', profile.email
  )
  into result
  from public.student_practice_assignments assignment
  join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
  join public.profiles profile on profile.id = assignment.student_id
  left join public.practice_tests worksheet on worksheet.id = assignment.practice_test_id
  left join public.practice_test_attempts attempt on attempt.id = assignment.latest_attempt_id
  where assignment.id = target_assignment_id;

  if result is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;

  return result;
end;
$$;

create or replace function api.list_student_practice_assignments_page(
  target_workspace_id uuid,
  target_student_id uuid,
  requested_page_size integer default 50,
  cursor_updated_at timestamptz default null,
  cursor_assignment_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null or target_student_id is null
    or requested_page_size is null or requested_page_size < 1 or requested_page_size > 100
    or ((cursor_updated_at is null) <> (cursor_assignment_id is null))
  then
    raise exception using errcode = '22023', message = 'invalid_practice_page';
  end if;

  if actor_id = target_student_id then
    if not exists (
      select 1 from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = target_student_id
        and membership.role = 'student'
    ) then
      raise exception using errcode = '42501', message = 'active_membership_required';
    end if;
  elsif not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into exact_total
  from public.student_practice_assignments assignment
  where assignment.workspace_id = target_workspace_id
    and assignment.student_id = target_student_id;

  with candidate_rows as materialized (
    select assignment.id, assignment.updated_at
    from public.student_practice_assignments assignment
    where assignment.workspace_id = target_workspace_id
      and assignment.student_id = target_student_id
      and (
        cursor_updated_at is null
        or (assignment.updated_at, assignment.id) < (cursor_updated_at, cursor_assignment_id)
      )
    order by assignment.updated_at desc, assignment.id desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select * from candidate_rows
    order by updated_at desc, id desc
    limit requested_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          api.get_practice_assignment_summary(page_row.id)
          order by page_row.updated_at desc, page_row.id desc
        ) from page_rows page_row
      ),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object('updated_at', page_row.updated_at, 'id', page_row.id)
        from page_rows page_row
        order by page_row.updated_at asc, page_row.id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor;

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

create or replace function api.list_workspace_practice_assignments_page(
  target_workspace_id uuid,
  requested_page_size integer default 100,
  cursor_updated_at timestamptz default null,
  cursor_assignment_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null
    or requested_page_size is null or requested_page_size < 1 or requested_page_size > 100
    or ((cursor_updated_at is null) <> (cursor_assignment_id is null))
  then
    raise exception using errcode = '22023', message = 'invalid_practice_page';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into exact_total
  from public.student_practice_assignments assignment
  where assignment.workspace_id = target_workspace_id;

  with candidate_rows as materialized (
    select assignment.id, assignment.updated_at
    from public.student_practice_assignments assignment
    where assignment.workspace_id = target_workspace_id
      and (
        cursor_updated_at is null
        or (assignment.updated_at, assignment.id) < (cursor_updated_at, cursor_assignment_id)
      )
    order by assignment.updated_at desc, assignment.id desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select * from candidate_rows
    order by updated_at desc, id desc
    limit requested_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          api.get_practice_assignment_summary(page_row.id)
          order by page_row.updated_at desc, page_row.id desc
        ) from page_rows page_row
      ),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object('updated_at', page_row.updated_at, 'id', page_row.id)
        from page_rows page_row
        order by page_row.updated_at asc, page_row.id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor;

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

create or replace function api.get_child_practice_assignment(
  target_previous_assignment_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  child_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_previous_assignment_id is null then
    raise exception using errcode = '22023', message = 'assignment_required';
  end if;

  -- Authorize the parent first so an arbitrary UUID cannot be used as an
  -- existence oracle for another student's repeat assignment.
  perform api.get_practice_assignment_summary(target_previous_assignment_id);

  select assignment.id
  into child_id
  from public.student_practice_assignments assignment
  where assignment.previous_assignment_id = target_previous_assignment_id
    and assignment.source = 'adaptive_repeat'
    and assignment.status <> 'cancelled'
  order by assignment.assigned_at desc, assignment.id desc
  limit 1;

  if child_id is null then
    return null;
  end if;

  return api.get_practice_assignment_summary(child_id);
end;
$$;

create or replace function api.ensure_student_practice_assignment(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  with created as materialized (
    select result.assignment_id
    from public.ensure_student_practice_assignment(
      target_workspace_id,
      target_student_id,
      target_grammar_topic_id
    ) result
    limit 1
  )
  select api.get_practice_assignment_summary(created.assignment_id)
  from created;
$$;

create or replace function api.start_practice_assignment(target_assignment_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  with authorized as materialized (
    select api.get_practice_assignment_summary(target_assignment_id) as payload
  ),
  started as materialized (
    select result.assignment_id
    from authorized
    cross join lateral public.start_practice_assignment(target_assignment_id) result
    limit 1
  )
  select api.get_practice_assignment_summary(started.assignment_id)
  from started;
$$;

create or replace function api.create_next_practice_assignment(target_assignment_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  with authorized as materialized (
    select api.get_practice_assignment_summary(target_assignment_id) as payload
  ),
  created as materialized (
    select result.assignment_id
    from authorized
    cross join lateral public.create_next_practice_assignment(target_assignment_id) result
    limit 1
  )
  select api.get_practice_assignment_summary(created.assignment_id)
  from created;
$$;

create or replace function api.get_practice_assignment_questions(target_assignment_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  with authorized as materialized (
    select api.get_practice_assignment_summary(target_assignment_id) as payload
  )
  select coalesce(
    jsonb_agg(to_jsonb(result) order by result.question_number),
    '[]'::jsonb
  )
  from authorized
  cross join lateral public.get_practice_assignment_questions(target_assignment_id) result;
$$;

create or replace function api.get_practice_assignment_review(target_assignment_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  with authorized as materialized (
    select api.get_practice_assignment_summary(target_assignment_id) as payload
  )
  select coalesce(
    jsonb_agg(to_jsonb(result) order by result.question_number),
    '[]'::jsonb
  )
  from authorized
  cross join lateral public.get_practice_assignment_review(target_assignment_id) result;
$$;

-- ---------------------------------------------------------------------------
-- Explicit privilege allowlist
-- ---------------------------------------------------------------------------

revoke all on function api.get_workspace(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.list_workspace_batches_page(uuid, integer, timestamptz, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.create_workspace_batch(uuid, text, text, text, boolean, boolean, text, integer, integer)
from public, anon, authenticated, service_role;
revoke all on function api.update_workspace_batch(uuid, uuid, text, text, text, boolean, boolean, text, integer, integer)
from public, anon, authenticated, service_role;
revoke all on function api.set_batch_active(uuid, uuid, boolean)
from public, anon, authenticated, service_role;
revoke all on function api.list_workspace_questions_page(uuid, integer, timestamptz, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.list_global_questions_page(text[], integer, integer)
from public, anon, authenticated, service_role;
revoke all on function api.list_student_assigned_questions(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.create_workspace_question(uuid, text, text, text, text, text, integer, integer, integer, boolean)
from public, anon, authenticated, service_role;
revoke all on function api.update_workspace_question(uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean)
from public, anon, authenticated, service_role;
revoke all on function api.set_question_active(uuid, uuid, boolean)
from public, anon, authenticated, service_role;
revoke all on function api.list_my_batch_assignments(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.list_workspace_students_page(uuid, integer, timestamptz, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.list_workspace_batch_join_requests_page(uuid, integer, timestamptz, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.list_my_batch_join_requests(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.assign_student_to_batch(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.remove_student_batch_assignment(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.list_student_grammar_stats(uuid, uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function api.list_workspace_grammar_stats_page(uuid, integer, integer)
from public, anon, authenticated, service_role;
revoke all on function api.get_practice_assignment_summary(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.list_student_practice_assignments_page(uuid, uuid, integer, timestamptz, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.list_workspace_practice_assignments_page(uuid, integer, timestamptz, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.get_child_practice_assignment(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.ensure_student_practice_assignment(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.start_practice_assignment(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.create_next_practice_assignment(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.get_practice_assignment_questions(uuid)
from public, anon, authenticated, service_role;
revoke all on function api.get_practice_assignment_review(uuid)
from public, anon, authenticated, service_role;

grant execute on function api.get_workspace(uuid)
to authenticated, service_role;
grant execute on function api.list_workspace_batches_page(uuid, integer, timestamptz, uuid)
to authenticated, service_role;
grant execute on function api.create_workspace_batch(uuid, text, text, text, boolean, boolean, text, integer, integer)
to authenticated, service_role;
grant execute on function api.update_workspace_batch(uuid, uuid, text, text, text, boolean, boolean, text, integer, integer)
to authenticated, service_role;
grant execute on function api.set_batch_active(uuid, uuid, boolean)
to authenticated, service_role;
grant execute on function api.list_workspace_questions_page(uuid, integer, timestamptz, uuid)
to authenticated, service_role;
grant execute on function api.list_global_questions_page(text[], integer, integer)
to authenticated, service_role;
grant execute on function api.list_student_assigned_questions(uuid)
to authenticated, service_role;
grant execute on function api.create_workspace_question(uuid, text, text, text, text, text, integer, integer, integer, boolean)
to authenticated, service_role;
grant execute on function api.update_workspace_question(uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean)
to authenticated, service_role;
grant execute on function api.set_question_active(uuid, uuid, boolean)
to authenticated, service_role;
grant execute on function api.list_my_batch_assignments(uuid)
to authenticated, service_role;
grant execute on function api.list_workspace_students_page(uuid, integer, timestamptz, uuid)
to authenticated, service_role;
grant execute on function api.list_workspace_batch_join_requests_page(uuid, integer, timestamptz, uuid)
to authenticated, service_role;
grant execute on function api.list_my_batch_join_requests(uuid)
to authenticated, service_role;
grant execute on function api.assign_student_to_batch(uuid, uuid, uuid)
to authenticated, service_role;
grant execute on function api.remove_student_batch_assignment(uuid, uuid)
to authenticated, service_role;
grant execute on function api.list_student_grammar_stats(uuid, uuid, integer)
to authenticated, service_role;
grant execute on function api.list_workspace_grammar_stats_page(uuid, integer, integer)
to authenticated, service_role;
grant execute on function api.get_practice_assignment_summary(uuid)
to authenticated, service_role;
grant execute on function api.list_student_practice_assignments_page(uuid, uuid, integer, timestamptz, uuid)
to authenticated, service_role;
grant execute on function api.list_workspace_practice_assignments_page(uuid, integer, timestamptz, uuid)
to authenticated, service_role;
grant execute on function api.get_child_practice_assignment(uuid)
to authenticated, service_role;
grant execute on function api.ensure_student_practice_assignment(uuid, uuid, uuid)
to authenticated, service_role;
grant execute on function api.start_practice_assignment(uuid)
to authenticated, service_role;
grant execute on function api.create_next_practice_assignment(uuid)
to authenticated, service_role;
grant execute on function api.get_practice_assignment_questions(uuid)
to authenticated, service_role;
grant execute on function api.get_practice_assignment_review(uuid)
to authenticated, service_role;

comment on function api.list_workspace_batches_page(uuid, integer, timestamptz, uuid) is
  'Teacher-authorized, keyset-paginated batch read model with exact server counts and private join-code projection.';
comment on function api.list_student_assigned_questions(uuid) is
  'Returns one explicit batch context per writing-task assignment; no arbitrary multi-batch selection.';
comment on function api.get_practice_assignment_summary(uuid) is
  'RLS-preserving browser read model with safe job errors and no answer keys.';
