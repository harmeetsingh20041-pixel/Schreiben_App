-- Phase 11J: fail closed for legacy/unreviewed worksheet revisions.
--
-- Phase 9A quarantined pre-contract worksheets from reuse, but an assignment
-- that was already attached before that migration could still reach the old
-- exact scorer. Repair unused legacy flexible questions into semantic
-- contracts where that is deterministic, preserve all used history unchanged,
-- and prevent any student submit operation unless its exact worksheet revision
-- is approved and every question carries the validated v1 answer contract.

update public.practice_test_questions question
set
  evaluation_mode = 'open_evaluation',
  accepted_answers = '[]'::jsonb,
  correct_answer = case
    when lower(btrim(coalesce(question.correct_answer, ''))) in (
      'manual_review',
      'manual review',
      'open_review',
      'flexible_review',
      'requires_review'
    ) then ''
    else question.correct_answer
  end,
  rubric = jsonb_build_object(
    'criteria', jsonb_build_array(
      'Evaluate the response semantically against the stated German grammar task and its context.'
    ),
    'sample_answer', case
      when lower(btrim(coalesce(question.correct_answer, ''))) in (
        'manual_review',
        'manual review',
        'open_review',
        'flexible_review',
        'requires_review'
      ) then null
      when nullif(btrim(coalesce(question.correct_answer, '')), '') is null then null
      else question.correct_answer
    end
  ),
  answer_contract_version = 1
where question.answer_contract_version = 0
  and question.question_type <> 'multiple_choice'
  and not exists (
    select 1
    from public.practice_test_attempts attempt
    where attempt.practice_test_id = question.practice_test_id
  );

-- A legacy multiple-choice row is promoted only when its complete objective
-- contract is already deterministic. Anything else remains quarantined and is
-- blocked by the attempt gate below until a reviewed re-import creates a new
-- immutable revision.
update public.practice_test_questions question
set answer_contract_version = 1
where question.answer_contract_version = 0
  and question.question_type = 'multiple_choice'
  and question.evaluation_mode = 'local_exact'
  and question.rubric is null
  and nullif(btrim(coalesce(question.correct_answer, '')), '') is not null
  and lower(btrim(question.correct_answer)) not in (
    'manual_review',
    'manual review',
    'open_review',
    'flexible_review',
    'requires_review'
  )
  and jsonb_typeof(question.accepted_answers) = 'array'
  and jsonb_array_length(case
    when jsonb_typeof(question.accepted_answers) = 'array'
      then question.accepted_answers
    else '[]'::jsonb
  end) = 1
  and lower(regexp_replace(
    btrim((case
      when jsonb_typeof(question.accepted_answers) = 'array'
        then question.accepted_answers
      else '[]'::jsonb
    end) ->> 0),
    '\s+',
    ' ',
    'g'
  )) = lower(regexp_replace(btrim(question.correct_answer), '\s+', ' ', 'g'))
  and jsonb_typeof(question.options) = 'array'
  and jsonb_array_length(case
    when jsonb_typeof(question.options) = 'array' then question.options
    else '[]'::jsonb
  end) between 2 and 6
  and (
    select count(*)
    from jsonb_array_elements_text(case
      when jsonb_typeof(question.options) = 'array' then question.options
      else '[]'::jsonb
    end) option_value
    where lower(regexp_replace(btrim(option_value), '\s+', ' ', 'g'))
      = lower(regexp_replace(btrim(question.correct_answer), '\s+', ' ', 'g'))
  ) = 1
  and (
    select count(*) = count(distinct lower(regexp_replace(
      btrim(option_value),
      '\s+',
      ' ',
      'g'
    )))
    from jsonb_array_elements_text(case
      when jsonb_typeof(question.options) = 'array' then question.options
      else '[]'::jsonb
    end) option_value
  )
  and not exists (
    select 1
    from public.practice_test_attempts attempt
    where attempt.practice_test_id = question.practice_test_id
  );

create or replace function app_private.assert_practice_assignment_answer_contract(
  target_assignment_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_practice_test_id uuid;
  selected_workspace_id uuid;
  selected_quality_status text;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'Authentication required.';
  end if;

  select assignment.practice_test_id, assignment.workspace_id
  into selected_practice_test_id, selected_workspace_id
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
    and assignment.student_id = caller_id
  for share;

  if selected_workspace_id is null then
    raise exception using
      errcode = '02000',
      message = 'Practice assignment not found.';
  end if;

  if not exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = selected_workspace_id
      and member.user_id = caller_id
      and member.role = 'student'
  ) then
    raise exception using
      errcode = '42501',
      message = 'Active class membership is required.';
  end if;

  select test.quality_status
  into selected_quality_status
  from public.practice_tests test
  where test.id = selected_practice_test_id
  for share;

  if selected_practice_test_id is null
    or selected_quality_status is distinct from 'approved'
    or not exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = selected_practice_test_id
    )
    or exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = selected_practice_test_id
        and question.answer_contract_version <> 1
    )
  then
    raise exception using
      errcode = '55000',
      message = 'practice_worksheet_requires_review';
  end if;
end;
$$;

revoke all on function app_private.assert_practice_assignment_answer_contract(uuid)
from public, anon, authenticated, service_role;

alter function public.submit_practice_attempt(uuid, jsonb)
rename to submit_practice_attempt_phase_11j_unchecked;

revoke all on function public.submit_practice_attempt_phase_11j_unchecked(uuid, jsonb)
from public, anon, authenticated, service_role;

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
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_practice_assignment_answer_contract(
    target_assignment_id
  );

  return query
  select *
  from public.submit_practice_attempt_phase_11j_unchecked(
    target_assignment_id,
    submitted_answers
  );
end;
$$;

revoke all on function public.submit_practice_attempt(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.submit_practice_attempt(uuid, jsonb)
to authenticated;

-- The JSONB API overload predates revision-safe practice drafts. Keeping its
-- browser grant would let a direct PostgREST caller bypass optimistic revision
-- locking even though the current frontend uses the integer overload.
revoke all on function api.submit_practice_attempt(uuid, jsonb)
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
