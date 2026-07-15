-- Phase 11N: server-filtered, keyset-paginated teacher roster and join requests.
-- Search, class, level, and request-state predicates run before LIMIT so the
-- UI never downloads a complete workspace merely to filter it in memory.

create or replace function api.list_workspace_students_filtered_page(
  target_workspace_id uuid,
  search_query text default '',
  target_batch_id uuid default null,
  target_level text default null,
  requested_page_size integer default 25,
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
  clean_search text := lower(btrim(coalesce(search_query, '')));
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_workspace_id is null
    or char_length(clean_search) > 120
    or (target_level is not null and target_level not in ('A1', 'A2', 'B1', 'B2'))
    or requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 100
    or ((cursor_created_at is null) <> (cursor_membership_id is null))
  then
    raise exception using errcode = '22023', message = 'invalid_student_roster_page';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;
  if target_batch_id is not null and not exists (
    select 1
    from public.batches batch
    where batch.id = target_batch_id
      and batch.workspace_id = target_workspace_id
  )
  then
    raise exception using errcode = '22023', message = 'invalid_student_roster_filter';
  end if;

  select count(*)::bigint
  into exact_total
  from public.workspace_members membership
  join public.profiles profile on profile.id = membership.user_id
  where membership.workspace_id = target_workspace_id
    and membership.role = 'student'
    and (
      clean_search = ''
      or position(
        clean_search in lower(concat_ws(' ', profile.full_name, profile.email))
      ) > 0
    )
    and (
      target_batch_id is null
      or exists (
        select 1
        from public.batch_students assignment
        join public.batches batch
          on batch.id = assignment.batch_id
          and batch.workspace_id = assignment.workspace_id
        where assignment.workspace_id = membership.workspace_id
          and assignment.student_id = membership.user_id
          and assignment.batch_id = target_batch_id
          and batch.is_active
      )
    )
    and (
      target_level is null
      or exists (
        select 1
        from public.batch_students assignment
        join public.batches batch
          on batch.id = assignment.batch_id
          and batch.workspace_id = assignment.workspace_id
        where assignment.workspace_id = membership.workspace_id
          and assignment.student_id = membership.user_id
          and batch.level = target_level
          and batch.is_active
      )
    );

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
        clean_search = ''
        or position(
          clean_search in lower(concat_ws(' ', profile.full_name, profile.email))
        ) > 0
      )
      and (
        target_batch_id is null
        or exists (
          select 1
          from public.batch_students assignment
          join public.batches batch
            on batch.id = assignment.batch_id
            and batch.workspace_id = assignment.workspace_id
          where assignment.workspace_id = membership.workspace_id
            and assignment.student_id = membership.user_id
            and assignment.batch_id = target_batch_id
            and batch.is_active
        )
      )
      and (
        target_level is null
        or exists (
          select 1
          from public.batch_students assignment
          join public.batches batch
            on batch.id = assignment.batch_id
            and batch.workspace_id = assignment.workspace_id
          where assignment.workspace_id = membership.workspace_id
            and assignment.student_id = membership.user_id
            and batch.level = target_level
            and batch.is_active
        )
      )
      and (
        cursor_created_at is null
        or (membership.created_at, membership.id) < (
          cursor_created_at,
          cursor_membership_id
        )
      )
    order by membership.created_at desc, membership.id desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select *
    from candidate_rows
    order by membership_created_at desc, membership_id desc
    limit requested_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          to_jsonb(page_row) - 'membership_created_at'
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

create or replace function api.list_workspace_join_requests_filtered_page(
  target_workspace_id uuid,
  target_status text default 'pending',
  search_query text default '',
  target_batch_id uuid default null,
  requested_page_size integer default 25,
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
  clean_search text := lower(btrim(coalesce(search_query, '')));
  exact_total bigint;
  page_items jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_workspace_id is null
    or target_status not in ('all', 'pending', 'approved', 'rejected', 'cancelled')
    or char_length(clean_search) > 120
    or requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 100
    or ((cursor_requested_at is null) <> (cursor_request_id is null))
  then
    raise exception using errcode = '22023', message = 'invalid_join_request_page';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;
  if target_batch_id is not null and not exists (
    select 1
    from public.batches batch
    where batch.id = target_batch_id
      and batch.workspace_id = target_workspace_id
  )
  then
    raise exception using errcode = '22023', message = 'invalid_join_request_filter';
  end if;

  select count(*)::bigint
  into exact_total
  from public.batch_join_requests request
  where request.workspace_id = target_workspace_id
    and (target_status = 'all' or request.status = target_status)
    and (target_batch_id is null or request.batch_id = target_batch_id)
    and (
      clean_search = ''
      or position(
        clean_search in lower(concat_ws(' ', request.student_name, request.student_email))
      ) > 0
    );

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
      and (target_status = 'all' or request.status = target_status)
      and (target_batch_id is null or request.batch_id = target_batch_id)
      and (
        clean_search = ''
        or position(
          clean_search in lower(concat_ws(' ', request.student_name, request.student_email))
        ) > 0
      )
      and (
        cursor_requested_at is null
        or (request.requested_at, request.id) < (
          cursor_requested_at,
          cursor_request_id
        )
      )
    order by request.requested_at desc, request.id desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select *
    from candidate_rows
    order by requested_at desc, id desc
    limit requested_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          to_jsonb(page_row)
          order by page_row.requested_at desc, page_row.id desc
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object(
          'requested_at', page_row.requested_at,
          'id', page_row.id
        )
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

revoke all on function api.list_workspace_students_filtered_page(
  uuid, text, uuid, text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function api.list_workspace_join_requests_filtered_page(
  uuid, text, text, uuid, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;

grant execute on function api.list_workspace_students_filtered_page(
  uuid, text, uuid, text, integer, timestamptz, uuid
) to authenticated;
grant execute on function api.list_workspace_join_requests_filtered_page(
  uuid, text, text, uuid, integer, timestamptz, uuid
) to authenticated;

notify pgrst, 'reload schema';
