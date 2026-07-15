-- Phase 11K: one teacher action queue for worksheet quality, failed jobs, and
-- support recommendations. Generated worksheets that failed independent model
-- review remain private until a teacher records an explicit, immutable decision.

create table app_private.practice_quality_actions (
  id uuid primary key default gen_random_uuid(),
  practice_test_id uuid not null
    references public.practice_tests(id) on delete restrict,
  assignment_id uuid not null
    references public.student_practice_assignments(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  decision text not null check (decision in ('approved', 'rejected')),
  notes text not null check (length(notes) between 8 and 1000),
  before_state jsonb not null check (jsonb_typeof(before_state) = 'object'),
  after_state jsonb not null check (jsonb_typeof(after_state) = 'object'),
  created_at timestamptz not null default now(),
  unique (practice_test_id)
);

create index practice_quality_actions_workspace_created_idx
on app_private.practice_quality_actions (workspace_id, created_at desc, id desc);

alter table app_private.practice_quality_actions enable row level security;

revoke all on table app_private.practice_quality_actions
from public, anon, authenticated, service_role;

drop trigger if exists practice_quality_actions_immutable
on app_private.practice_quality_actions;
create trigger practice_quality_actions_immutable
before update or delete on app_private.practice_quality_actions
for each row execute function app_private.reject_adaptive_history_mutation();

-- The helper is deliberately non-exposed and returns only teacher-actionable
-- metadata. Student answers, student writing, provider payloads, and raw errors
-- never enter the queue response.
create or replace function public.practice_review_queue_rows_internal(
  target_workspace_id uuid
)
returns table (
  queue_key text,
  assignment_id uuid,
  attempt_id uuid,
  practice_test_id uuid,
  workspace_id uuid,
  student_id uuid,
  student_name text,
  student_email text,
  grammar_topic_name text,
  worksheet_title text,
  action_kind text,
  generation_status text,
  evaluation_status text,
  error_code text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  with authorized_workspace as materialized (
    select target_workspace_id as id
    where (select auth.uid()) is not null
      and target_workspace_id is not null
      and (
        public.is_platform_admin()
        or public.has_workspace_role(
          target_workspace_id,
          array['owner', 'teacher']
        )
      )
  ),
  active_assignments as materialized (
    select assignment.*
    from public.student_practice_assignments assignment
    join authorized_workspace workspace on workspace.id = assignment.workspace_id
    where exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = assignment.workspace_id
        and membership.user_id = assignment.student_id
        and membership.role = 'student'
    )
  ),
  quarantined as (
    select
      'worksheet_quarantine:' || assignment.id::text as queue_key,
      assignment.id as assignment_id,
      null::uuid as attempt_id,
      worksheet.id as practice_test_id,
      assignment.workspace_id,
      assignment.student_id,
      coalesce(student.full_name, 'Student') as student_name,
      student.email as student_email,
      topic.name as grammar_topic_name,
      worksheet.title as worksheet_title,
      'worksheet_quarantine'::text as action_kind,
      assignment.generation_status,
      null::text as evaluation_status,
      'independent_validation_rejected'::text as error_code,
      worksheet.created_at,
      greatest(assignment.updated_at, worksheet.updated_at) as updated_at
    from active_assignments assignment
    join public.profiles student on student.id = assignment.student_id
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    join lateral (
      select candidate.*
      from public.practice_tests candidate
      where candidate.generated_from_assignment_id = assignment.id
        and candidate.workspace_id = assignment.workspace_id
        and candidate.grammar_topic_id = assignment.grammar_topic_id
        and candidate.quality_status = 'needs_review'
        and candidate.visibility = 'private'
        and not candidate.teacher_reviewed
      order by candidate.created_at desc, candidate.id desc
      limit 1
    ) worksheet on true
    where assignment.generation_status = 'needs_review'
      and assignment.practice_test_id is null
      and assignment.status in ('unlocked', 'in_progress')
  ),
  generation_failures as (
    select
      'generation_failed:' || assignment.id::text as queue_key,
      assignment.id as assignment_id,
      null::uuid as attempt_id,
      null::uuid as practice_test_id,
      assignment.workspace_id,
      assignment.student_id,
      coalesce(student.full_name, 'Student') as student_name,
      student.email as student_email,
      topic.name as grammar_topic_name,
      null::text as worksheet_title,
      'generation_failed'::text as action_kind,
      assignment.generation_status,
      null::text as evaluation_status,
      'worksheet_generation_failed'::text as error_code,
      assignment.assigned_at as created_at,
      assignment.updated_at
    from active_assignments assignment
    join public.profiles student on student.id = assignment.student_id
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    where assignment.generation_status = 'failed'
      and assignment.practice_test_id is null
      and assignment.status in ('unlocked', 'in_progress')
      and not exists (
        select 1
        from public.practice_tests candidate
        where candidate.generated_from_assignment_id = assignment.id
          and candidate.quality_status = 'needs_review'
      )
  ),
  evaluation_failures as (
    select
      'evaluation_failed:' || assignment.id::text as queue_key,
      assignment.id as assignment_id,
      attempt.id as attempt_id,
      assignment.practice_test_id,
      assignment.workspace_id,
      assignment.student_id,
      coalesce(student.full_name, 'Student') as student_name,
      student.email as student_email,
      topic.name as grammar_topic_name,
      worksheet.title as worksheet_title,
      'evaluation_failed'::text as action_kind,
      assignment.generation_status,
      attempt.evaluation_status,
      'worksheet_evaluation_failed'::text as error_code,
      attempt.created_at,
      coalesce(
        attempt.evaluation_completed_at,
        attempt.submitted_at,
        attempt.created_at
      ) as updated_at
    from active_assignments assignment
    join public.practice_test_attempts attempt
      on attempt.id = assignment.latest_attempt_id
      and attempt.assignment_id = assignment.id
    join public.profiles student on student.id = assignment.student_id
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    left join public.practice_tests worksheet on worksheet.id = assignment.practice_test_id
    where attempt.evaluation_status = 'failed'
      and attempt.status in ('submitted', 'checked')
      and assignment.status in ('completed', 'passed', 'failed')
  ),
  support_recommendations as (
    select
      'support_recommended:' || assignment.id::text as queue_key,
      assignment.id as assignment_id,
      assignment.latest_attempt_id as attempt_id,
      assignment.practice_test_id,
      assignment.workspace_id,
      assignment.student_id,
      coalesce(student.full_name, 'Student') as student_name,
      student.email as student_email,
      topic.name as grammar_topic_name,
      worksheet.title as worksheet_title,
      'support_recommended'::text as action_kind,
      assignment.generation_status,
      attempt.evaluation_status,
      null::text as error_code,
      coalesce(assignment.completed_at, assignment.assigned_at) as created_at,
      assignment.updated_at
    from active_assignments assignment
    join public.profiles student on student.id = assignment.student_id
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    left join public.practice_tests worksheet on worksheet.id = assignment.practice_test_id
    left join public.practice_test_attempts attempt on attempt.id = assignment.latest_attempt_id
    where assignment.status = 'failed'
      and coalesce(attempt.evaluation_status, 'not_needed') <> 'failed'
      and not exists (
        select 1
        from app_private.practice_teacher_actions action
        where action.assignment_id = assignment.id
          and action.action_type = 'support_resolved'
      )
  )
  select * from quarantined
  union all
  select * from generation_failures
  union all
  select * from evaluation_failures
  union all
  select * from support_recommendations;
$$;

revoke all on function public.practice_review_queue_rows_internal(uuid)
from public, anon, authenticated, service_role;

create or replace function public.list_practice_review_queue_page_internal(
  target_workspace_id uuid,
  target_kind text default 'all',
  requested_page_size integer default 25,
  cursor_updated_at timestamptz default null,
  cursor_queue_key text default null
)
returns jsonb
language plpgsql
security definer
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
    or target_kind not in (
      'all',
      'worksheet_quarantine',
      'generation_failed',
      'evaluation_failed',
      'support_recommended'
    )
    or requested_page_size is null
    or requested_page_size < 1
    or requested_page_size > 100
    or ((cursor_updated_at is null) <> (cursor_queue_key is null))
  then
    raise exception using errcode = '22023', message = 'invalid_practice_review_page';
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
  from public.practice_review_queue_rows_internal(target_workspace_id) item
  where target_kind = 'all' or item.action_kind = target_kind;

  with candidate_rows as materialized (
    select item.*
    from public.practice_review_queue_rows_internal(target_workspace_id) item
    where (target_kind = 'all' or item.action_kind = target_kind)
      and (
        cursor_updated_at is null
        or (item.updated_at, item.queue_key) < (
          cursor_updated_at,
          cursor_queue_key
        )
      )
    order by item.updated_at desc, item.queue_key desc
    limit requested_page_size + 1
  ),
  page_rows as materialized (
    select *
    from candidate_rows
    order by updated_at desc, queue_key desc
    limit requested_page_size
  )
  select
    coalesce(
      (
        select jsonb_agg(to_jsonb(page_row)
          order by page_row.updated_at desc, page_row.queue_key desc)
        from page_rows page_row
      ),
      '[]'::jsonb
    ),
    (select count(*) > requested_page_size from candidate_rows),
    case
      when (select count(*) > requested_page_size from candidate_rows) then (
        select jsonb_build_object(
          'updated_at', page_row.updated_at,
          'queue_key', page_row.queue_key
        )
        from page_rows page_row
        order by page_row.updated_at asc, page_row.queue_key asc
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

revoke all on function public.list_practice_review_queue_page_internal(
  uuid, text, integer, timestamptz, text
) from public, anon, authenticated, service_role;
-- The API wrapper is SECURITY INVOKER, so authenticated callers need execute
-- on its exact implementation. Production exposes only the api schema, which
-- keeps this implementation unreachable as a direct PostgREST endpoint.
grant execute on function public.list_practice_review_queue_page_internal(
  uuid, text, integer, timestamptz, text
) to authenticated;

create or replace function api.list_practice_review_queue_page(
  target_workspace_id uuid,
  target_kind text default 'all',
  requested_page_size integer default 25,
  cursor_updated_at timestamptz default null,
  cursor_queue_key text default null
)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.list_practice_review_queue_page_internal(
    target_workspace_id,
    target_kind,
    requested_page_size,
    cursor_updated_at,
    cursor_queue_key
  );
$$;

revoke all on function api.list_practice_review_queue_page(
  uuid, text, integer, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function api.list_practice_review_queue_page(
  uuid, text, integer, timestamptz, text
) to authenticated;

create or replace function public.get_quarantined_practice_worksheet_internal(
  target_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  selected_test public.practice_tests%rowtype;
  student_name text;
  topic_name text;
  questions jsonb := '[]'::jsonb;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if selected_assignment.id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      selected_assignment.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select candidate.*
  into selected_test
  from public.practice_tests candidate
  where candidate.generated_from_assignment_id = selected_assignment.id
    and candidate.workspace_id = selected_assignment.workspace_id
    and candidate.grammar_topic_id = selected_assignment.grammar_topic_id
    and candidate.quality_status = 'needs_review'
    and candidate.visibility = 'private'
    and not candidate.teacher_reviewed
  order by candidate.created_at desc, candidate.id desc
  limit 1;

  if selected_assignment.generation_status <> 'needs_review'
    or selected_assignment.practice_test_id is not null
    or selected_test.id is null
  then
    raise exception using errcode = '55000', message = 'worksheet_not_quarantined';
  end if;

  select coalesce(profile.full_name, 'Student')
  into student_name
  from public.profiles profile
  where profile.id = selected_assignment.student_id;

  select topic.name
  into topic_name
  from public.grammar_topics topic
  where topic.id = selected_assignment.grammar_topic_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', question.id,
        'question_number', question.question_number,
        'question_type', question.question_type,
        'evaluation_mode', question.evaluation_mode,
        'prompt', question.prompt,
        'options', coalesce(question.options, '[]'::jsonb),
        'correct_answer', question.correct_answer,
        'accepted_answers', question.accepted_answers,
        'rubric', question.rubric,
        'explanation', question.explanation,
        'answer_contract_version', question.answer_contract_version
      ) order by question.question_number
    ),
    '[]'::jsonb
  )
  into questions
  from public.practice_test_questions question
  where question.practice_test_id = selected_test.id;

  return jsonb_build_object(
    'schema_version', 1,
    'assignment', jsonb_build_object(
      'id', selected_assignment.id,
      'workspace_id', selected_assignment.workspace_id,
      'student_id', selected_assignment.student_id,
      'student_name', student_name,
      'grammar_topic_id', selected_assignment.grammar_topic_id,
      'grammar_topic_name', topic_name,
      'generation_status', selected_assignment.generation_status
    ),
    'worksheet', jsonb_build_object(
      'id', selected_test.id,
      'title', selected_test.title,
      'description', selected_test.description,
      'level', selected_test.level,
      'difficulty', selected_test.difficulty,
      'mini_lesson', selected_test.mini_lesson,
      'quality_status', selected_test.quality_status,
      'quality_notes', selected_test.quality_notes,
      'generator_model', selected_test.generator_model,
      'generation_metadata', selected_test.generation_metadata,
      'created_at', selected_test.created_at,
      'questions', questions
    )
  );
end;
$$;

revoke all on function public.get_quarantined_practice_worksheet_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_quarantined_practice_worksheet_internal(uuid)
to authenticated;

create or replace function api.get_quarantined_practice_worksheet(
  target_assignment_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select public.get_quarantined_practice_worksheet_internal(target_assignment_id);
$$;

revoke all on function api.get_quarantined_practice_worksheet(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.get_quarantined_practice_worksheet(uuid)
to authenticated;

create or replace function public.decide_quarantined_practice_worksheet_internal(
  target_assignment_id uuid,
  target_decision text,
  review_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  selected_test public.practice_tests%rowtype;
  clean_notes text := btrim(review_notes);
  question_count integer := 0;
  multiple_choice_count integer := 0;
  fill_blank_count integer := 0;
  open_question_count integer := 0;
  expected_question_count integer := 0;
  action_id uuid := gen_random_uuid();
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_assignment_id is null
    or target_decision not in ('approve', 'reject')
    or clean_notes is null
    or length(clean_notes) not between 8 and 1000
  then
    raise exception using errcode = '22023', message = 'invalid_quality_decision';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      selected_assignment.workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;
  if selected_assignment.status not in ('unlocked', 'in_progress')
    or selected_assignment.generation_status <> 'needs_review'
    or selected_assignment.practice_test_id is not null
  then
    raise exception using errcode = '55000', message = 'worksheet_not_quarantined';
  end if;

  select candidate.*
  into selected_test
  from public.practice_tests candidate
  where candidate.generated_from_assignment_id = selected_assignment.id
    and candidate.workspace_id = selected_assignment.workspace_id
    and candidate.grammar_topic_id = selected_assignment.grammar_topic_id
    and candidate.quality_status = 'needs_review'
    and candidate.visibility = 'private'
    and not candidate.teacher_reviewed
  order by candidate.created_at desc, candidate.id desc
  limit 1
  for update;

  if selected_test.id is null
    or exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.practice_test_id = selected_test.id
    )
    or exists (
      select 1
      from app_private.practice_quality_actions action
      where action.practice_test_id = selected_test.id
    )
  then
    raise exception using errcode = '55000', message = 'worksheet_not_quarantined';
  end if;

  select
    count(*)::integer,
    count(*) filter (
      where question.question_type = 'multiple_choice'
        and question.evaluation_mode = 'local_exact'
    )::integer,
    count(*) filter (
      where question.question_type = 'fill_blank'
        and question.evaluation_mode = 'local_exact'
    )::integer,
    count(*) filter (
      where question.evaluation_mode = 'open_evaluation'
    )::integer
  into
    question_count,
    multiple_choice_count,
    fill_blank_count,
    open_question_count
  from public.practice_test_questions question
  where question.practice_test_id = selected_test.id;

  expected_question_count := case when selected_test.level = 'A2' then 9 else 8 end;

  if target_decision = 'approve' and (
    question_count <> expected_question_count
    or multiple_choice_count < 2
    or fill_blank_count < 2
    or open_question_count not between 1 and 3
    or exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
        and question.answer_contract_version <> 1
    )
    or exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
        and question.question_number not between 1 and expected_question_count
    )
    or (
      select count(*) <> count(distinct question.question_number)
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
    )
    or (
      select count(*) <> count(distinct lower(regexp_replace(
        btrim(question.prompt),
        '\s+',
        ' ',
        'g'
      )))
      from public.practice_test_questions question
      where question.practice_test_id = selected_test.id
    )
  )
  then
    raise exception using errcode = '55000', message = 'worksheet_contract_invalid';
  end if;

  if target_decision = 'approve' then
    update public.practice_tests worksheet
    set
      quality_status = 'approved',
      quality_notes = clean_notes,
      teacher_reviewed = true,
      visibility = 'workspace',
      reviewed_by = caller_id,
      reviewed_at = now(),
      updated_at = now()
    where worksheet.id = selected_test.id;

    update public.student_practice_assignments assignment
    set
      practice_test_id = selected_test.id,
      generation_status = 'ready',
      generation_error = null,
      generation_completed_at = now(),
      updated_at = now()
    where assignment.id = selected_assignment.id;
  else
    update public.practice_tests worksheet
    set
      quality_status = 'failed',
      quality_notes = clean_notes,
      teacher_reviewed = true,
      visibility = 'private',
      reviewed_by = caller_id,
      reviewed_at = now(),
      updated_at = now()
    where worksheet.id = selected_test.id;

    update public.student_practice_assignments assignment
    set
      generation_status = 'failed',
      generation_error = 'teacher_rejected',
      generation_completed_at = now(),
      updated_at = now()
    where assignment.id = selected_assignment.id;
  end if;

  insert into app_private.practice_quality_actions (
    id,
    practice_test_id,
    assignment_id,
    workspace_id,
    actor_id,
    decision,
    notes,
    before_state,
    after_state
  ) values (
    action_id,
    selected_test.id,
    selected_assignment.id,
    selected_assignment.workspace_id,
    caller_id,
    case when target_decision = 'approve' then 'approved' else 'rejected' end,
    clean_notes,
    jsonb_build_object(
      'quality_status', selected_test.quality_status,
      'visibility', selected_test.visibility,
      'teacher_reviewed', selected_test.teacher_reviewed,
      'generation_status', selected_assignment.generation_status,
      'practice_test_id', selected_assignment.practice_test_id
    ),
    jsonb_build_object(
      'quality_status', case when target_decision = 'approve' then 'approved' else 'failed' end,
      'visibility', case when target_decision = 'approve' then 'workspace' else 'private' end,
      'teacher_reviewed', true,
      'generation_status', case when target_decision = 'approve' then 'ready' else 'failed' end,
      'practice_test_id', case when target_decision = 'approve' then selected_test.id else null end
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action_id', action_id,
    'assignment_id', selected_assignment.id,
    'practice_test_id', selected_test.id,
    'decision', target_decision,
    'quality_status', case when target_decision = 'approve' then 'approved' else 'failed' end,
    'generation_status', case when target_decision = 'approve' then 'ready' else 'failed' end
  );
end;
$$;

revoke all on function public.decide_quarantined_practice_worksheet_internal(
  uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.decide_quarantined_practice_worksheet_internal(
  uuid, text, text
) to authenticated;

create or replace function api.decide_quarantined_practice_worksheet(
  target_assignment_id uuid,
  target_decision text,
  review_notes text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.decide_quarantined_practice_worksheet_internal(
    target_assignment_id,
    target_decision,
    review_notes
  );
$$;

revoke all on function api.decide_quarantined_practice_worksheet(
  uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function api.decide_quarantined_practice_worksheet(
  uuid, text, text
) to authenticated;

comment on function api.list_practice_review_queue_page(
  uuid, text, integer, timestamptz, text
) is 'Teacher-only keyset page for quarantined worksheets, failed worksheet jobs, and unresolved support actions.';

comment on function api.decide_quarantined_practice_worksheet(uuid, text, text)
is 'Atomically records an immutable human quality decision and either releases or rejects a quarantined generated worksheet.';

notify pgrst, 'reload schema';
