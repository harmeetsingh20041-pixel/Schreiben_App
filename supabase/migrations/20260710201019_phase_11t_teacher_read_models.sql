-- Phase 11T: bounded teacher-side read models.
--
-- The roster now carries only three confirmed focus areas per visible student,
-- including the one active worksheet state for each topic. The dashboard gets
-- one compact count/attention projection, and Content filters/paginates both
-- question banks in Postgres instead of downloading either complete bank.

create index if not exists questions_workspace_bank_page_idx
on public.questions (workspace_id, is_active, created_at desc, id desc);

create index if not exists global_questions_active_sort_page_idx
on public.global_questions (
  is_active,
  (coalesce(sort_order, 2147483647)),
  created_at desc,
  id desc
);

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
      ) as last_active_at,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', focus.id,
              'workspace_id', focus.workspace_id,
              'student_id', focus.student_id,
              'grammar_topic_id', focus.grammar_topic_id,
              'topic_name', focus.topic_name,
              'topic_slug', focus.topic_slug,
              'topic_description', focus.topic_description,
              'total_minor_issues', focus.total_minor_issues,
              'total_major_issues', focus.total_major_issues,
              'total_correct_after_practice', focus.total_correct_after_practice,
              'weakness_level', focus.weakness_level,
              'practice_unlocked', focus.practice_unlocked,
              'last_seen_at', focus.last_seen_at,
              'updated_at', focus.updated_at,
              'active_practice', focus.active_practice
            ) order by
              focus.practice_unlocked desc,
              focus.total_major_issues desc,
              focus.total_minor_issues desc,
              focus.id
          )
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
              (
                select jsonb_build_object(
                  'id', practice.id,
                  'student_id', practice.student_id,
                  'grammar_topic_id', practice.grammar_topic_id,
                  'practice_test_id', practice.practice_test_id,
                  'worksheet_title', worksheet.title,
                  'status', practice.status,
                  'source', practice.source,
                  'generation_status', practice.generation_status,
                  'evaluation_status', attempt.evaluation_status,
                  'latest_attempt_status', attempt.status
                )
                from public.student_practice_assignments practice
                left join public.practice_tests worksheet
                  on worksheet.id = practice.practice_test_id
                left join public.practice_test_attempts attempt
                  on attempt.id = practice.latest_attempt_id
                where practice.workspace_id = stat.workspace_id
                  and practice.student_id = stat.student_id
                  and practice.grammar_topic_id = stat.grammar_topic_id
                  and practice.status in ('unlocked', 'in_progress', 'completed')
                order by practice.updated_at desc, practice.id desc
                limit 1
              ) as active_practice
            from public.student_grammar_stats stat
            join public.grammar_topics topic on topic.id = stat.grammar_topic_id
            where stat.workspace_id = membership.workspace_id
              and stat.student_id = membership.user_id
              and stat.weakness_level <> 'mastered'
            order by
              stat.practice_unlocked desc,
              stat.total_major_issues desc,
              stat.total_minor_issues desc,
              stat.id
            limit 3
          ) focus
        ),
        '[]'::jsonb
      ) as weak_topics
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

create or replace function api.get_teacher_dashboard_summary(
  target_workspace_id uuid,
  target_batch_id uuid default null,
  requested_attention_limit integer default 6
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  student_count integer;
  question_count integer;
  pending_join_request_count integer;
  attention_items jsonb := '[]'::jsonb;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_workspace_id is null
    or requested_attention_limit is null
    or requested_attention_limit < 1
    or requested_attention_limit > 12
  then
    raise exception using errcode = '22023', message = 'invalid_teacher_dashboard_summary';
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
    raise exception using errcode = '22023', message = 'invalid_teacher_dashboard_batch';
  end if;

  select count(*)::integer
  into student_count
  from public.workspace_members membership
  where membership.workspace_id = target_workspace_id
    and membership.role = 'student'
    and (
      target_batch_id is null
      or exists (
        select 1
        from public.batch_students assignment
        where assignment.workspace_id = target_workspace_id
          and assignment.batch_id = target_batch_id
          and assignment.student_id = membership.user_id
      )
    );

  select count(*)::integer
  into question_count
  from public.questions question
  where question.workspace_id = target_workspace_id;

  select count(*)::integer
  into pending_join_request_count
  from public.batch_join_requests request
  where request.workspace_id = target_workspace_id
    and request.status = 'pending'
    and (target_batch_id is null or request.batch_id = target_batch_id);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', focus.id,
        'workspace_id', focus.workspace_id,
        'student_id', focus.student_id,
        'student_name', focus.student_name,
        'student_email', focus.student_email,
        'grammar_topic_id', focus.grammar_topic_id,
        'topic_name', focus.topic_name,
        'topic_slug', focus.topic_slug,
        'topic_description', focus.topic_description,
        'total_minor_issues', focus.total_minor_issues,
        'total_major_issues', focus.total_major_issues,
        'total_correct_after_practice', focus.total_correct_after_practice,
        'weakness_level', focus.weakness_level,
        'practice_unlocked', focus.practice_unlocked,
        'last_seen_at', focus.last_seen_at,
        'updated_at', focus.updated_at,
        'active_practice', focus.active_practice
      ) order by
        focus.practice_unlocked desc,
        focus.total_major_issues desc,
        focus.total_minor_issues desc,
        focus.id
    ),
    '[]'::jsonb
  )
  into attention_items
  from (
    select
      stat.id,
      stat.workspace_id,
      stat.student_id,
      coalesce(profile.full_name, profile.email, 'Unnamed student') as student_name,
      profile.email as student_email,
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
      (
        select jsonb_build_object(
          'id', practice.id,
          'student_id', practice.student_id,
          'grammar_topic_id', practice.grammar_topic_id,
          'practice_test_id', practice.practice_test_id,
          'worksheet_title', worksheet.title,
          'status', practice.status,
          'source', practice.source,
          'generation_status', practice.generation_status,
          'evaluation_status', attempt.evaluation_status,
          'latest_attempt_status', attempt.status
        )
        from public.student_practice_assignments practice
        left join public.practice_tests worksheet
          on worksheet.id = practice.practice_test_id
        left join public.practice_test_attempts attempt
          on attempt.id = practice.latest_attempt_id
        where practice.workspace_id = stat.workspace_id
          and practice.student_id = stat.student_id
          and practice.grammar_topic_id = stat.grammar_topic_id
          and (
            practice.status in ('unlocked', 'in_progress', 'completed')
            or (practice.status = 'failed' and practice.source = 'adaptive_repeat')
          )
        order by
          case when practice.status in ('unlocked', 'in_progress', 'completed') then 0 else 1 end,
          practice.updated_at desc,
          practice.id desc
        limit 1
      ) as active_practice
    from public.student_grammar_stats stat
    join public.grammar_topics topic on topic.id = stat.grammar_topic_id
    join public.profiles profile on profile.id = stat.student_id
    where stat.workspace_id = target_workspace_id
      and stat.weakness_level <> 'mastered'
      and (
        target_batch_id is null
        or exists (
          select 1
          from public.batch_students assignment
          where assignment.workspace_id = target_workspace_id
            and assignment.batch_id = target_batch_id
            and assignment.student_id = stat.student_id
        )
      )
    order by
      stat.practice_unlocked desc,
      stat.total_major_issues desc,
      stat.total_minor_issues desc,
      stat.id
    limit requested_attention_limit
  ) focus;

  return jsonb_build_object(
    'schema_version', 1,
    'workspace_id', target_workspace_id,
    'batch_id', target_batch_id,
    'student_count', student_count,
    'question_count', question_count,
    'pending_join_request_count', pending_join_request_count,
    'attention_items', attention_items
  );
end;
$$;

create or replace function api.list_teacher_question_bank_page(
  target_workspace_id uuid,
  target_source text,
  search_query text default '',
  target_level text default null,
  target_topic text default null,
  target_task_type text default null,
  target_status text default 'active',
  requested_page_size integer default 12,
  cursor_sort_rank integer default null,
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
  clean_search text := lower(btrim(coalesce(search_query, '')));
  clean_topic text := nullif(btrim(target_topic), '');
  exact_total bigint := 0;
  page_items jsonb := '[]'::jsonb;
  available_topics jsonb := '[]'::jsonb;
  page_has_more boolean := false;
  page_next_cursor jsonb;
  returned_count integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_workspace_id is null
    or target_source is null
    or target_source not in ('workspace', 'global')
    or char_length(clean_search) > 200
    or char_length(coalesce(clean_topic, '')) > 120
    or (target_level is not null and target_level not in ('A1', 'A2', 'B1', 'B2'))
    or (
      target_task_type is not null
      and target_task_type not in (
        'email', 'message', 'description', 'opinion', 'apology', 'invitation',
        'formal_letter', 'free_text', 'writing'
      )
    )
    or target_status is null
    or target_status not in ('all', 'active', 'inactive')
    or requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 50
    or num_nonnulls(cursor_sort_rank, cursor_created_at, cursor_id) not in (0, 3)
    or (target_source = 'workspace' and cursor_sort_rank is not null and cursor_sort_rank <> 0)
  then
    raise exception using errcode = '22023', message = 'invalid_teacher_question_page';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if target_source = 'workspace' then
    select count(*)::bigint
    into exact_total
    from public.questions question
    where question.workspace_id = target_workspace_id
      and (
        clean_search = ''
        or position(
          clean_search in lower(concat_ws(' ', question.title, question.topic, question.prompt))
        ) > 0
      )
      and (target_level is null or question.level = target_level)
      and (clean_topic is null or question.topic = clean_topic)
      and (target_task_type is null or question.task_type = target_task_type)
      and (
        target_status = 'all'
        or question.is_active = (target_status = 'active')
      );

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
        question.updated_at,
        0::integer as sort_rank
      from public.questions question
      where question.workspace_id = target_workspace_id
        and (
          clean_search = ''
          or position(
            clean_search in lower(concat_ws(' ', question.title, question.topic, question.prompt))
          ) > 0
        )
        and (target_level is null or question.level = target_level)
        and (clean_topic is null or question.topic = clean_topic)
        and (target_task_type is null or question.task_type = target_task_type)
        and (
          target_status = 'all'
          or question.is_active = (target_status = 'active')
        )
        and (
          cursor_sort_rank is null
          or question.created_at < cursor_created_at
          or (question.created_at = cursor_created_at and question.id < cursor_id)
        )
      order by question.created_at desc, question.id desc
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
            to_jsonb(page_row) - 'sort_rank'
            order by page_row.created_at desc, page_row.id desc
          )
          from page_rows page_row
        ),
        '[]'::jsonb
      ),
      (select count(*) > requested_page_size from candidate_rows),
      case
        when (select count(*) > requested_page_size from candidate_rows) then (
          select jsonb_build_object(
            'sort_rank', page_row.sort_rank,
            'created_at', page_row.created_at,
            'id', page_row.id
          )
          from page_rows page_row
          order by page_row.created_at asc, page_row.id asc
          limit 1
        )
        else null
      end
    into page_items, page_has_more, page_next_cursor;

    select coalesce(jsonb_agg(topic_row.topic order by topic_row.topic), '[]'::jsonb)
    into available_topics
    from (
      select distinct question.topic
      from public.questions question
      where question.workspace_id = target_workspace_id
        and btrim(question.topic) <> ''
    ) topic_row;
  else
    select count(*)::bigint
    into exact_total
    from public.global_questions question
    where (
        clean_search = ''
        or position(
          clean_search in lower(concat_ws(' ', question.title, question.topic, question.prompt))
        ) > 0
      )
      and (target_level is null or question.level = target_level)
      and (clean_topic is null or question.topic = clean_topic)
      and (target_task_type is null or question.task_type = target_task_type)
      and (
        target_status = 'all'
        or question.is_active = (target_status = 'active')
      );

    with candidate_rows as materialized (
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
        coalesce(question.sort_order, 2147483647) as sort_rank
      from public.global_questions question
      where (
          clean_search = ''
          or position(
            clean_search in lower(concat_ws(' ', question.title, question.topic, question.prompt))
          ) > 0
        )
        and (target_level is null or question.level = target_level)
        and (clean_topic is null or question.topic = clean_topic)
        and (target_task_type is null or question.task_type = target_task_type)
        and (
          target_status = 'all'
          or question.is_active = (target_status = 'active')
        )
        and (
          cursor_sort_rank is null
          or coalesce(question.sort_order, 2147483647) > cursor_sort_rank
          or (
            coalesce(question.sort_order, 2147483647) = cursor_sort_rank
            and question.created_at < cursor_created_at
          )
          or (
            coalesce(question.sort_order, 2147483647) = cursor_sort_rank
            and question.created_at = cursor_created_at
            and question.id < cursor_id
          )
        )
      order by
        coalesce(question.sort_order, 2147483647),
        question.created_at desc,
        question.id desc
      limit requested_page_size + 1
    ),
    page_rows as materialized (
      select *
      from candidate_rows
      order by sort_rank, created_at desc, id desc
      limit requested_page_size
    )
    select
      coalesce(
        (
          select jsonb_agg(
            to_jsonb(page_row) - 'sort_rank'
            order by page_row.sort_rank, page_row.created_at desc, page_row.id desc
          )
          from page_rows page_row
        ),
        '[]'::jsonb
      ),
      (select count(*) > requested_page_size from candidate_rows),
      case
        when (select count(*) > requested_page_size from candidate_rows) then (
          select jsonb_build_object(
            'sort_rank', page_row.sort_rank,
            'created_at', page_row.created_at,
            'id', page_row.id
          )
          from page_rows page_row
          order by page_row.sort_rank desc, page_row.created_at asc, page_row.id asc
          limit 1
        )
        else null
      end
    into page_items, page_has_more, page_next_cursor;

    select coalesce(jsonb_agg(topic_row.topic order by topic_row.topic), '[]'::jsonb)
    into available_topics
    from (
      select distinct question.topic
      from public.global_questions question
      where btrim(question.topic) <> ''
    ) topic_row;
  end if;

  returned_count := jsonb_array_length(page_items);
  return jsonb_build_object(
    'schema_version', 1,
    'items', page_items,
    'total_count', exact_total,
    'returned_count', returned_count,
    'page_size', requested_page_size,
    'has_more', page_has_more,
    'next_cursor', page_next_cursor,
    'available_topics', available_topics
  );
end;
$$;

revoke all on function api.list_workspace_students_filtered_page(
  uuid, text, uuid, text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function api.get_teacher_dashboard_summary(uuid, uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function api.list_teacher_question_bank_page(
  uuid, text, text, text, text, text, text, integer, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;

grant execute on function api.list_workspace_students_filtered_page(
  uuid, text, uuid, text, integer, timestamptz, uuid
) to authenticated;
grant execute on function api.get_teacher_dashboard_summary(uuid, uuid, integer)
to authenticated;
grant execute on function api.list_teacher_question_bank_page(
  uuid, text, text, text, text, text, text, integer, integer, timestamptz, uuid
) to authenticated;

comment on function api.get_teacher_dashboard_summary(uuid, uuid, integer) is
  'Bounded teacher overview counts plus at most twelve confirmed grammar attention rows.';
comment on function api.list_teacher_question_bank_page(
  uuid, text, text, text, text, text, text, integer, integer, timestamptz, uuid
) is 'Server-filtered, keyset-paginated teacher Content question bank.';

notify pgrst, 'reload schema';
