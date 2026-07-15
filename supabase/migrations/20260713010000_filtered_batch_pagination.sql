-- Filter the teacher Classes read before counting, enriching, and paginating.
-- The original four-argument overload remains available to older callers.

create function api.list_workspace_batches_page(
  target_workspace_id uuid,
  requested_page_size integer,
  cursor_created_at timestamptz,
  cursor_id uuid,
  target_status text,
  target_level text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  workspace_total bigint;
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

  if requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 100
  then
    raise exception using errcode = '22023', message = 'invalid_page_size';
  end if;

  if (cursor_created_at is null) <> (cursor_id is null) then
    raise exception using errcode = '22023', message = 'invalid_cursor';
  end if;

  if target_status is null
    or target_status not in ('active', 'inactive', 'all')
  then
    raise exception using errcode = '22023', message = 'invalid_batch_status';
  end if;

  if target_level is not null
    and target_level not in ('A1', 'A2', 'B1', 'B2')
  then
    raise exception using errcode = '22023', message = 'invalid_batch_level';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select
    count(*)::bigint,
    count(*) filter (
      where (
        target_status = 'all'
        or batch.is_active = (target_status = 'active')
      )
        and (target_level is null or batch.level = target_level)
    )::bigint
  into workspace_total, exact_total
  from public.batches batch
  where batch.workspace_id = target_workspace_id;

  with candidate_rows as materialized (
    select
      batch.id,
      batch.workspace_id,
      batch.name,
      batch.level,
      batch.description,
      batch.is_active,
      batch.join_requires_approval,
      batch.feedback_mode,
      batch.feedback_delay_min_minutes,
      batch.feedback_delay_max_minutes,
      batch.created_by,
      batch.created_at,
      batch.updated_at
    from public.batches batch
    where batch.workspace_id = target_workspace_id
      and (
        target_status = 'all'
        or batch.is_active = (target_status = 'active')
      )
      and (target_level is null or batch.level = target_level)
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
  ),
  join_codes as materialized (
    select join_code.*
    from public.list_workspace_batch_join_codes(target_workspace_id) join_code
    join page_rows page on page.id = join_code.batch_id
  ),
  enriched_rows as materialized (
    select
      page.id,
      page.workspace_id,
      page.name,
      page.level,
      page.description,
      page.is_active,
      join_codes.join_code,
      join_codes.join_code_enabled,
      page.join_requires_approval,
      page.feedback_mode,
      page.feedback_delay_min_minutes,
      page.feedback_delay_max_minutes,
      page.created_by,
      page.created_at,
      page.updated_at,
      (
        select count(*)::integer
        from public.batch_students assignment
        where assignment.workspace_id = page.workspace_id
          and assignment.batch_id = page.id
      ) as student_count,
      (
        select count(*)::integer
        from public.submissions submission
        where submission.workspace_id = page.workspace_id
          and submission.batch_id = page.id
      ) as submission_count
    from page_rows page
    join join_codes on join_codes.batch_id = page.id
  )
  select
    coalesce(
      (
        select jsonb_agg(
          to_jsonb(enriched)
          order by enriched.created_at desc, enriched.id desc
        )
        from enriched_rows enriched
      ),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object(
          'created_at', page.created_at,
          'id', page.id
        )
        from page_rows page
        order by page.created_at asc, page.id asc
        limit 1
      )
      else null
    end
  into page_items, page_has_more, page_next_cursor;

  return jsonb_build_object(
    'schema_version', 1,
    'items', page_items,
    'unfiltered_total_count', workspace_total,
    'total_count', exact_total,
    'returned_count', jsonb_array_length(page_items),
    'page_size', requested_page_size,
    'has_more', page_has_more,
    'next_cursor', page_next_cursor
  );
end;
$$;

revoke all on function api.list_workspace_batches_page(
  uuid, integer, timestamptz, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function api.list_workspace_batches_page(
  uuid, integer, timestamptz, uuid, text, text
) to authenticated;

comment on function api.list_workspace_batches_page(
  uuid, integer, timestamptz, uuid, text, text
) is
  'Teacher-only keyset batch page with status and CEFR filters applied before exact counting, enrichment, and pagination.';

notify pgrst, 'reload schema';
