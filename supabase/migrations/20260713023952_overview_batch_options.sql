-- Overview needs only compact class options. Keep private join codes and the
-- per-class student/submission enrichments out of this bounded read model.

create function api.list_workspace_batch_options(
  target_workspace_id uuid,
  requested_page_size integer,
  cursor_created_at timestamptz,
  cursor_id uuid,
  target_search text
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
  workspace_total bigint;
  normalized_search text := btrim(coalesce(target_search, ''));
  option_items jsonb := '[]'::jsonb;
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

  if length(normalized_search) > 160 then
    raise exception using errcode = '22023', message = 'invalid_search';
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
      where normalized_search = ''
        or position(lower(normalized_search) in lower(batch.name)) > 0
    )::bigint
  into workspace_total, exact_total
  from public.batches batch
  where batch.workspace_id = target_workspace_id;

  with candidate_rows as materialized (
    select
      batch.id,
      batch.name,
      batch.level,
      batch.is_active,
      batch.created_at
    from public.batches batch
    where batch.workspace_id = target_workspace_id
      and (
        normalized_search = ''
        or position(lower(normalized_search) in lower(batch.name)) > 0
      )
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
        select jsonb_agg(
          jsonb_build_object(
            'id', page.id,
            'name', page.name,
            'level', page.level,
            'is_active', page.is_active
          )
          order by page.created_at desc, page.id desc
        )
        from page_rows page
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
  into option_items, page_has_more, page_next_cursor;

  return jsonb_build_object(
    'schema_version', 1,
    'items', option_items,
    'unfiltered_total_count', workspace_total,
    'total_count', exact_total,
    'returned_count', jsonb_array_length(option_items),
    'page_size', requested_page_size,
    'has_more', page_has_more,
    'next_cursor', page_next_cursor
  );
end;
$$;

revoke all on function api.list_workspace_batch_options(
  uuid, integer, timestamptz, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function api.list_workspace_batch_options(
  uuid, integer, timestamptz, uuid, text
) to authenticated;

comment on function api.list_workspace_batch_options(
  uuid, integer, timestamptz, uuid, text
) is
  'Teacher-only searchable, keyset-paginated Overview class options without join codes or aggregate enrichments.';

notify pgrst, 'reload schema';
