-- Phase 7E-1 safety: normal worksheet submission must include an answer for every question.
-- Blank-answer handling in Phase 7D-2 remains as a defensive fallback for legacy/direct data,
-- but the submit RPC now rejects incomplete active worksheet submissions before scoring.

alter function app_private.submit_practice_attempt_internal(uuid, jsonb)
rename to submit_practice_attempt_internal_phase_7d2_unchecked;

revoke all on function app_private.submit_practice_attempt_internal_phase_7d2_unchecked(uuid, jsonb)
from public, anon, authenticated;

create or replace function app_private.submit_practice_attempt_internal(
  target_assignment_id uuid,
  submitted_answers jsonb
)
returns table (
  assignment_id uuid,
  workspace_id uuid,
  student_id uuid,
  grammar_topic_id uuid,
  grammar_topic_name text,
  grammar_topic_slug text,
  practice_test_id uuid,
  worksheet_title text,
  worksheet_level text,
  worksheet_difficulty text,
  status text,
  source text,
  assigned_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  score integer,
  max_score integer,
  score_percent numeric,
  passed boolean,
  question_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  assignment_record public.student_practice_assignments%rowtype;
begin
  if caller_id is null then
    raise exception 'Authentication required.'
      using errcode = '28000';
  end if;

  if submitted_answers is null or jsonb_typeof(submitted_answers) <> 'array' then
    raise exception 'Answers must be submitted as a JSON array.'
      using errcode = '22023';
  end if;

  if jsonb_array_length(submitted_answers) > 20 then
    raise exception 'Too many answers were submitted at once.'
      using errcode = '22023';
  end if;

  if octet_length(submitted_answers::text) > 25000 then
    raise exception 'Worksheet answers are too large to submit. Please shorten your answers.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(submitted_answers) answer_item
    where jsonb_typeof(answer_item) <> 'object'
      or not ((answer_item ->> 'question_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      or length(coalesce(answer_item ->> 'answer', '')) > 1000
  ) then
    raise exception 'One or more worksheet answers are too long or invalid.'
      using errcode = '22023';
  end if;

  select spa.*
  into assignment_record
  from public.student_practice_assignments spa
  where spa.id = target_assignment_id;

  if assignment_record.id is null then
    raise exception 'Practice assignment was not found.'
      using errcode = '02000';
  end if;

  if caller_id <> assignment_record.student_id
    and not app_private.is_platform_admin()
  then
    raise exception 'Permission denied.'
      using errcode = '42501';
  end if;

  if assignment_record.practice_test_id is null then
    raise exception 'Worksheet is not available yet.'
      using errcode = '22023';
  end if;

  if assignment_record.status in ('unlocked', 'in_progress') and exists (
    with submitted as (
      select distinct on ((answer_item ->> 'question_id')::uuid)
        (answer_item ->> 'question_id')::uuid as question_id,
        coalesce(answer_item ->> 'answer', '') as answer
      from jsonb_array_elements(submitted_answers) answer_item
      order by (answer_item ->> 'question_id')::uuid
    )
    select 1
    from public.practice_test_questions ptq
    left join submitted submitted_answer
      on submitted_answer.question_id = ptq.id
    where ptq.practice_test_id = assignment_record.practice_test_id
      and btrim(coalesce(submitted_answer.answer, '')) = ''
  ) then
    raise exception 'Please answer every question before submitting.'
      using errcode = '22023';
  end if;

  return query
    select *
    from app_private.submit_practice_attempt_internal_phase_7d2_unchecked(
      target_assignment_id,
      submitted_answers
    );
end;
$$;

create or replace function public.submit_practice_attempt(
  target_assignment_id uuid,
  submitted_answers jsonb
)
returns table (
  assignment_id uuid,
  workspace_id uuid,
  student_id uuid,
  grammar_topic_id uuid,
  grammar_topic_name text,
  grammar_topic_slug text,
  practice_test_id uuid,
  worksheet_title text,
  worksheet_level text,
  worksheet_difficulty text,
  status text,
  source text,
  assigned_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  score integer,
  max_score integer,
  score_percent numeric,
  passed boolean,
  question_count integer
)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.submit_practice_attempt_internal(target_assignment_id, submitted_answers);
$$;

revoke all on function app_private.submit_practice_attempt_internal(uuid, jsonb) from public, anon;
grant execute on function app_private.submit_practice_attempt_internal(uuid, jsonb) to authenticated;

revoke all on function public.submit_practice_attempt(uuid, jsonb) from public, anon;
grant execute on function public.submit_practice_attempt(uuid, jsonb) to authenticated;
