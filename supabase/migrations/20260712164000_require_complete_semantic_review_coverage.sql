-- A historical mixed worksheet exposed a terminal 8/9 score while one open
-- question still had no semantic review. Terminal score visibility must prove
-- one stored review for every semantic question, not merely that at least one
-- review exists.

create or replace function public.practice_attempt_semantic_review_coverage_internal(
  target_attempt_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  request_role text := coalesce(
    current_setting('request.jwt.claim.role', true),
    ''
  );
  selected_attempt public.practice_test_attempts%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  expected_semantic_count integer := 0;
  reviewed_semantic_count integer := 0;
  stored_review_count integer := 0;
  actor_authorized boolean := false;
begin
  if target_attempt_id is null then
    return -1;
  end if;

  select attempt.*
  into selected_attempt
  from public.practice_test_attempts attempt
  where attempt.id = target_attempt_id;

  if selected_attempt.id is null or selected_attempt.assignment_id is null then
    return -1;
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = selected_attempt.assignment_id
    and assignment.workspace_id = selected_attempt.workspace_id
    and assignment.student_id = selected_attempt.student_id
    and assignment.practice_test_id = selected_attempt.practice_test_id;

  if selected_assignment.id is null then
    return -1;
  end if;

  actor_authorized :=
    request_role = 'service_role'
    or actor_id = selected_attempt.student_id and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = selected_attempt.workspace_id
        and membership.user_id = selected_attempt.student_id
        and membership.role = 'student'
    )
    or app_private.is_platform_admin()
    or app_private.has_workspace_role(
      selected_attempt.workspace_id,
      array['owner', 'teacher']
    );

  if not coalesce(actor_authorized, false) then
    return -1;
  end if;

  select count(*)::integer
  into expected_semantic_count
  from public.practice_test_questions question
  where question.practice_test_id = selected_attempt.practice_test_id
    and not app_private.is_practice_question_locally_scorable(
      question.question_type,
      question.correct_answer,
      question.evaluation_mode,
      question.accepted_answers
    );

  select count(*)::integer
  into reviewed_semantic_count
  from public.practice_test_questions question
  join public.practice_attempt_question_reviews review
    on review.question_id = question.id
   and review.attempt_id = selected_attempt.id
  where question.practice_test_id = selected_attempt.practice_test_id
    and not app_private.is_practice_question_locally_scorable(
      question.question_type,
      question.correct_answer,
      question.evaluation_mode,
      question.accepted_answers
    );

  select count(*)::integer
  into stored_review_count
  from public.practice_attempt_question_reviews review
  where review.attempt_id = selected_attempt.id;

  if expected_semantic_count not between 0 and 3
    or reviewed_semantic_count <> expected_semantic_count
    or stored_review_count <> expected_semantic_count
  then
    return -1;
  end if;

  return expected_semantic_count;
end;
$$;

revoke all on function public.practice_attempt_semantic_review_coverage_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.practice_attempt_semantic_review_coverage_internal(uuid)
to authenticated, service_role;

comment on function public.practice_attempt_semantic_review_coverage_internal(uuid) is
  'Actor-authorized terminal visibility input. Returns the exact 0-3 semantic-question count only when every semantic question has one review and no extra review row exists; otherwise returns -1.';

-- Keep the underlying RLS boundary fail-closed as well as the exposed API
-- read models. Managers retain recovery access, while a student may read the
-- stored semantic rows only after coverage proves that the terminal review is
-- complete. The helper is SECURITY DEFINER, so this policy does not recurse
-- through practice_attempt_question_reviews RLS.
drop policy if exists "practice_attempt_question_reviews_select_terminal_or_teacher"
on public.practice_attempt_question_reviews;

create policy "practice_attempt_question_reviews_select_terminal_or_teacher"
on public.practice_attempt_question_reviews for select
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
  or (
    student_id = (select auth.uid())
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = practice_attempt_question_reviews.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
    and exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.id = practice_attempt_question_reviews.attempt_id
        and attempt.status = 'checked'
        and attempt.evaluation_status in ('completed', 'not_needed')
    )
    and public.practice_attempt_semantic_review_coverage_internal(
      practice_attempt_question_reviews.attempt_id
    ) >= 0
  )
);

do $patch_practice_summary_coverage$
declare
  function_definition text;
  original_fragment text := 'question_stats.semantic_question_count';
  replacement_fragment text :=
    'public.practice_attempt_semantic_review_coverage_internal(attempt.id)';
begin
  select pg_get_functiondef(
    'public.get_practice_assignment_summary_internal_before_phase_13e(uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(original_fragment in function_definition) = 0
    or length(function_definition)
      - length(replace(function_definition, original_fragment, ''))
      <> length(original_fragment)
  then
    raise exception using
      errcode = '55000',
      message = 'practice_summary_coverage_patch_precondition_failed';
  end if;

  execute replace(
    function_definition,
    original_fragment,
    replacement_fragment
  );
end;
$patch_practice_summary_coverage$;

do $patch_practice_review_coverage$
declare
  function_definition text;
  original_fragment text := $old$
      semantic_question_count
    );
$old$;
  replacement_fragment text := $new$
      public.practice_attempt_semantic_review_coverage_internal(
        attempt_record.id
      )
    );
$new$;
begin
  select pg_get_functiondef(
    'app_private.get_practice_assignment_review_internal(uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(original_fragment in function_definition) = 0
    or length(function_definition)
      - length(replace(function_definition, original_fragment, ''))
      <> length(original_fragment)
  then
    raise exception using
      errcode = '55000',
      message = 'practice_review_coverage_patch_precondition_failed';
  end if;

  execute replace(
    function_definition,
    original_fragment,
    replacement_fragment
  );
end;
$patch_practice_review_coverage$;

create or replace view api.practice_test_attempts
with (security_invoker = true, security_barrier = true)
as
select
  attempt.id,
  attempt.workspace_id,
  attempt.student_id,
  attempt.practice_test_id,
  attempt.assignment_id,
  attempt.status,
  attempt.started_at,
  attempt.submitted_at,
  attempt.completed_at,
  (case when terminal.visible then attempt.score else null end)::integer as score,
  (case when terminal.visible then attempt.max_score else null end)::integer
    as max_score,
  (case when terminal.visible then attempt.score_percent else null end)::numeric(5, 2)
    as score_percent,
  (case when terminal.visible then attempt.passed else null end)::boolean as passed,
  (case when terminal.visible then attempt.score_points else null end)::numeric(6, 2)
    as score_points,
  (case when terminal.visible then attempt.max_score_points else null end)::numeric(6, 2)
    as max_score_points,
  (case when terminal.visible then attempt.scoring_version else null end)::text
    as scoring_version,
  attempt.evaluation_status,
  attempt.evaluation_started_at,
  attempt.evaluation_completed_at,
  case
    when attempt.evaluation_status = 'failed' then 'evaluation_failed'
    when attempt.evaluation_status = 'needs_review' then 'review_required'
    else null
  end::text as evaluation_error,
  attempt.created_at
from public.practice_test_attempts attempt
left join public.student_practice_assignments assignment
  on assignment.id = attempt.assignment_id
cross join lateral (
  select public.practice_attempt_semantic_review_coverage_internal(
    attempt.id
  ) as semantic_question_count
) semantic
cross join lateral (
  select coalesce((
    attempt.status = 'checked'
    and attempt.evaluation_status in ('completed', 'not_needed')
    and attempt.evaluation_completed_at is not null
    and attempt.evaluation_error is null
    and attempt.score is not null
    and attempt.max_score is not null
    and attempt.max_score > 0
    and attempt.score between 0 and attempt.max_score
    and attempt.score_points is not null
    and attempt.max_score_points is not null
    and attempt.max_score_points > 0
    and attempt.score_points between 0 and attempt.max_score_points
    and nullif(btrim(attempt.scoring_version), '') is not null
    and attempt.score_percent is not null
    and attempt.score_percent between 0 and 100
    and abs(
      attempt.score_percent
      - round((attempt.score_points * 100) / attempt.max_score_points, 2)
    ) <= 0.01
    and attempt.passed is not null
    and attempt.passed = (attempt.score_percent >= 70)
    and assignment.status = case
      when attempt.passed then 'passed'
      else 'failed'
    end
    and case attempt.evaluation_status
      when 'completed' then semantic.semantic_question_count > 0
      when 'not_needed' then semantic.semantic_question_count = 0
      else false
    end
  ), false) as visible
) terminal;

revoke all on table api.practice_test_attempts
from public, anon, authenticated, service_role;
grant select on table api.practice_test_attempts
to authenticated, service_role;

comment on function public.get_practice_assignment_summary_internal(uuid) is
  'Actor-authorized practice summary. Student grade fields require complete semantic-review coverage plus the canonical terminal-state checks.';
comment on function public.get_practice_assignment_summary_internal_before_phase_13e(uuid) is
  'Underlying actor-authorized practice summary. Student grade fields require complete semantic-review coverage before later withdrawal masking is applied.';
comment on function app_private.get_practice_assignment_review_internal(uuid) is
  'Actor-authorized worksheet review. Students see terminal details only after every semantic question has exactly one stored review.';
comment on view api.practice_test_attempts is
  'Actor-filtered practice attempts. Student grade fields remain masked until complete semantic-review coverage and coherent terminal state are both proven.';

notify pgrst, 'reload schema';
