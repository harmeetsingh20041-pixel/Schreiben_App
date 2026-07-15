-- Phase 11M: complete, stable grammar-stat traversal.
--
-- The Phase 11C read models sorted correctly, but the student endpoint was
-- limit-only and the workspace service consumed only the first offset page.
-- These keyset contracts preserve the educational priority order while making
-- every focus area reachable without increasingly expensive OFFSET scans.

create index if not exists student_grammar_stats_student_priority_page_idx
on public.student_grammar_stats (
  workspace_id,
  student_id,
  practice_unlocked desc,
  total_major_issues desc,
  total_minor_issues desc,
  id
);

create index if not exists student_grammar_stats_workspace_priority_page_idx
on public.student_grammar_stats (
  workspace_id,
  practice_unlocked desc,
  total_major_issues desc,
  total_minor_issues desc,
  id
);

create or replace function api.list_student_grammar_stats_page(
  target_workspace_id uuid,
  target_student_id uuid,
  requested_page_size integer default 100,
  cursor_practice_unlocked boolean default null,
  cursor_total_major_issues integer default null,
  cursor_total_minor_issues integer default null,
  cursor_stat_id uuid default null
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
  next_practice_unlocked boolean;
  next_total_major_issues integer;
  next_total_minor_issues integer;
  next_stat_id uuid;
  cursor_supplied boolean := cursor_stat_id is not null;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null
    or target_student_id is null
    or requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 200
    or (
      cursor_stat_id is null
      and (
        cursor_practice_unlocked is not null
        or cursor_total_major_issues is not null
        or cursor_total_minor_issues is not null
      )
    )
    or (
      cursor_stat_id is not null
      and (
        cursor_practice_unlocked is null
        or cursor_total_major_issues is null
        or cursor_total_minor_issues is null
        or cursor_total_major_issues < 0
        or cursor_total_minor_issues < 0
      )
    )
  then
    raise exception using errcode = '22023', message = 'invalid_grammar_stats_page_request';
  end if;

  if actor_id = target_student_id then
    if not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = target_student_id
        and membership.role = 'student'
    ) then
      raise exception using errcode = '42501', message = 'active_membership_required';
    end if;
  elsif not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into exact_total
  from public.student_grammar_stats stat
  where stat.workspace_id = target_workspace_id
    and stat.student_id = target_student_id;

  with candidate_rows as materialized (
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
      and (
        not cursor_supplied
        or stat.practice_unlocked < cursor_practice_unlocked
        or (
          stat.practice_unlocked = cursor_practice_unlocked
          and stat.total_major_issues < cursor_total_major_issues
        )
        or (
          stat.practice_unlocked = cursor_practice_unlocked
          and stat.total_major_issues = cursor_total_major_issues
          and stat.total_minor_issues < cursor_total_minor_issues
        )
        or (
          stat.practice_unlocked = cursor_practice_unlocked
          and stat.total_major_issues = cursor_total_major_issues
          and stat.total_minor_issues = cursor_total_minor_issues
          and stat.id > cursor_stat_id
        )
      )
    order by
      stat.practice_unlocked desc,
      stat.total_major_issues desc,
      stat.total_minor_issues desc,
      stat.id
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select *
    from candidate_rows
    order by
      practice_unlocked desc,
      total_major_issues desc,
      total_minor_issues desc,
      id
    limit requested_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          to_jsonb(page_row)
          order by
            page_row.practice_unlocked desc,
            page_row.total_major_issues desc,
            page_row.total_minor_issues desc,
            page_row.id
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    exists (select 1 from candidate_rows offset requested_page_size),
    last_row.practice_unlocked,
    last_row.total_major_issues,
    last_row.total_minor_issues,
    last_row.id
  into
    page_items,
    page_has_more,
    next_practice_unlocked,
    next_total_major_issues,
    next_total_minor_issues,
    next_stat_id
  from (values (true)) as anchor(always_one_row)
  left join lateral (
    select
      page_row.practice_unlocked,
      page_row.total_major_issues,
      page_row.total_minor_issues,
      page_row.id
    from page_rows page_row
    order by
      page_row.practice_unlocked,
      page_row.total_major_issues,
      page_row.total_minor_issues,
      page_row.id desc
    limit 1
  ) last_row on true;

  return jsonb_build_object(
    'schema_version', 1,
    'items', page_items,
    'total_count', exact_total,
    'returned_count', jsonb_array_length(page_items),
    'page_size', requested_page_size,
    'has_more', coalesce(page_has_more, false),
    'next_cursor', case
      when page_has_more then jsonb_build_object(
        'practice_unlocked', next_practice_unlocked,
        'total_major_issues', next_total_major_issues,
        'total_minor_issues', next_total_minor_issues,
        'id', next_stat_id
      )
      else null
    end
  );
end;
$$;

create or replace function api.list_workspace_grammar_stats_keyset_page(
  target_workspace_id uuid,
  requested_page_size integer default 200,
  cursor_practice_unlocked boolean default null,
  cursor_total_major_issues integer default null,
  cursor_total_minor_issues integer default null,
  cursor_stat_id uuid default null
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
  next_practice_unlocked boolean;
  next_total_major_issues integer;
  next_total_minor_issues integer;
  next_stat_id uuid;
  cursor_supplied boolean := cursor_stat_id is not null;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null
    or requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 200
    or (
      cursor_stat_id is null
      and (
        cursor_practice_unlocked is not null
        or cursor_total_major_issues is not null
        or cursor_total_minor_issues is not null
      )
    )
    or (
      cursor_stat_id is not null
      and (
        cursor_practice_unlocked is null
        or cursor_total_major_issues is null
        or cursor_total_minor_issues is null
        or cursor_total_major_issues < 0
        or cursor_total_minor_issues < 0
      )
    )
  then
    raise exception using errcode = '22023', message = 'invalid_grammar_stats_page_request';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select count(*)::bigint
  into exact_total
  from public.student_grammar_stats stat
  where stat.workspace_id = target_workspace_id;

  with candidate_rows as materialized (
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
      and (
        not cursor_supplied
        or stat.practice_unlocked < cursor_practice_unlocked
        or (
          stat.practice_unlocked = cursor_practice_unlocked
          and stat.total_major_issues < cursor_total_major_issues
        )
        or (
          stat.practice_unlocked = cursor_practice_unlocked
          and stat.total_major_issues = cursor_total_major_issues
          and stat.total_minor_issues < cursor_total_minor_issues
        )
        or (
          stat.practice_unlocked = cursor_practice_unlocked
          and stat.total_major_issues = cursor_total_major_issues
          and stat.total_minor_issues = cursor_total_minor_issues
          and stat.id > cursor_stat_id
        )
      )
    order by
      stat.practice_unlocked desc,
      stat.total_major_issues desc,
      stat.total_minor_issues desc,
      stat.id
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select *
    from candidate_rows
    order by
      practice_unlocked desc,
      total_major_issues desc,
      total_minor_issues desc,
      id
    limit requested_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(
          to_jsonb(page_row)
          order by
            page_row.practice_unlocked desc,
            page_row.total_major_issues desc,
            page_row.total_minor_issues desc,
            page_row.id
        )
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    exists (select 1 from candidate_rows offset requested_page_size),
    last_row.practice_unlocked,
    last_row.total_major_issues,
    last_row.total_minor_issues,
    last_row.id
  into
    page_items,
    page_has_more,
    next_practice_unlocked,
    next_total_major_issues,
    next_total_minor_issues,
    next_stat_id
  from (values (true)) as anchor(always_one_row)
  left join lateral (
    select
      page_row.practice_unlocked,
      page_row.total_major_issues,
      page_row.total_minor_issues,
      page_row.id
    from page_rows page_row
    order by
      page_row.practice_unlocked,
      page_row.total_major_issues,
      page_row.total_minor_issues,
      page_row.id desc
    limit 1
  ) last_row on true;

  return jsonb_build_object(
    'schema_version', 1,
    'items', page_items,
    'total_count', exact_total,
    'returned_count', jsonb_array_length(page_items),
    'page_size', requested_page_size,
    'has_more', coalesce(page_has_more, false),
    'next_cursor', case
      when page_has_more then jsonb_build_object(
        'practice_unlocked', next_practice_unlocked,
        'total_major_issues', next_total_major_issues,
        'total_minor_issues', next_total_minor_issues,
        'id', next_stat_id
      )
      else null
    end
  );
end;
$$;

revoke all on function api.list_student_grammar_stats_page(
  uuid, uuid, integer, boolean, integer, integer, uuid
) from public, anon, authenticated, service_role;
revoke all on function api.list_workspace_grammar_stats_keyset_page(
  uuid, integer, boolean, integer, integer, uuid
) from public, anon, authenticated, service_role;

-- Retire the limit-only and OFFSET contracts so a stale browser cannot
-- silently reintroduce incomplete focus areas.
revoke all on function api.list_student_grammar_stats(uuid, uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function api.list_workspace_grammar_stats_page(uuid, integer, integer)
from public, anon, authenticated, service_role;

grant execute on function api.list_student_grammar_stats_page(
  uuid, uuid, integer, boolean, integer, integer, uuid
) to authenticated;
grant execute on function api.list_workspace_grammar_stats_keyset_page(
  uuid, integer, boolean, integer, integer, uuid
) to authenticated;

notify pgrst, 'reload schema';
