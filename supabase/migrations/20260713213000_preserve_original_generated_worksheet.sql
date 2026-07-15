-- Phase 14E: keep a freshly generated worksheet usable by the exact
-- assignment that paid for it when it contains at most three valid semantic
-- questions. The global current/reuse predicate stays MCQ-only, so another
-- student cannot receive this unpromoted semantic worksheet.

do $migration$
declare
  source_definition text;
  original_definition text;
  old_question_contract constant text := $old$
      and not exists (
        select 1
        from public.practice_test_questions question
        where question.practice_test_id = test.id
          and (
            question.question_type <> 'multiple_choice'
            or question.evaluation_mode <> 'local_exact'
            or question.answer_contract_version <> 1
            or question.rubric is not null
            or jsonb_typeof(question.options) is distinct from 'array'
            or jsonb_array_length(question.options) not between 3 and 4
            or jsonb_typeof(question.accepted_answers)
              is distinct from 'array'
            or jsonb_array_length(question.accepted_answers) <> 1
            or jsonb_typeof(question.accepted_answers #> '{0}')
              is distinct from 'string'
            or question.accepted_answers #>> '{0}'
              is distinct from question.correct_answer
            or exists (
              select 1
              from jsonb_array_elements(question.options) option_value(value)
              where jsonb_typeof(option_value.value) is distinct from 'string'
                or length(btrim(option_value.value #>> '{}')) = 0
            )
            or (
              select count(*) <> count(distinct
                app_private.normalize_practice_contract_value(
                  option_value,
                  scoring.strict_scoring
                )
              )
              from jsonb_array_elements_text(question.options) option_value
            )
            or (
              select count(*)
              from jsonb_array_elements_text(question.options) option_value
              where app_private.normalize_practice_contract_value(
                option_value,
                scoring.strict_scoring
              ) = app_private.normalize_practice_contract_value(
                question.correct_answer,
                scoring.strict_scoring
              )
            ) <> 1
          )
      )
$old$;
  original_assignment_contract constant text := $new$
      and (
        select count(*)
        from public.practice_test_questions question
        where question.practice_test_id = test.id
          and question.evaluation_mode = 'open_evaluation'
      ) <= 3
      and not exists (
        select 1
        from public.practice_test_questions question
        where question.practice_test_id = test.id
          and (
            question.answer_contract_version <> 1
            or question.evaluation_mode not in (
              'local_exact', 'open_evaluation'
            )
            or (
              question.evaluation_mode = 'local_exact'
              and question.question_type not in (
                'multiple_choice', 'fill_blank'
              )
            )
            or (
              question.evaluation_mode = 'open_evaluation'
              and question.question_type = 'multiple_choice'
            )
          )
      )
$new$;
begin
  select pg_get_functiondef(
    'app_private.practice_test_has_current_unlinked_model_evidence(uuid)'::regprocedure
  )
  into source_definition;

  if source_definition is null
    or position(old_question_contract in source_definition) = 0
    or position(
      'app_private.practice_test_has_current_unlinked_model_evidence'
      in source_definition
    ) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'phase14e_expected_model_evidence_contract_missing';
  end if;

  original_definition := replace(
    source_definition,
    'app_private.practice_test_has_current_unlinked_model_evidence',
    'app_private.practice_test_has_current_original_model_evidence'
  );
  original_definition := replace(
    original_definition,
    old_question_contract,
    original_assignment_contract
  );

  if position(old_question_contract in original_definition) > 0
    or position(original_assignment_contract in original_definition) = 0
    or position(
      'app_private.practice_test_has_current_original_model_evidence'
      in original_definition
    ) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'phase14e_original_model_evidence_rewrite_failed';
  end if;

  execute original_definition;
end;
$migration$;

revoke all on function
  app_private.practice_test_has_current_original_model_evidence(uuid)
from public, anon, authenticated, service_role;

comment on function
  app_private.practice_test_has_current_original_model_evidence(uuid) is
  'Exact immutable completion/content/7+3 critic proof for an original generated worksheet with at most three trigger-validated semantic questions. It is not a cross-assignment reuse predicate.';

create or replace function
  app_private.practice_assignment_has_current_original_model_evidence(
    target_assignment_id uuid
  )
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.student_practice_assignments assignment
    join public.practice_tests worksheet
      on worksheet.id = assignment.practice_test_id
     and worksheet.generated_from_assignment_id = assignment.id
     and worksheet.workspace_id = assignment.workspace_id
     and worksheet.grammar_topic_id = assignment.grammar_topic_id
     and worksheet.level = assignment.worksheet_level
    where assignment.id = target_assignment_id
      and assignment.generation_status = 'ready'
      and app_private.practice_test_has_current_original_model_evidence(
        worksheet.id
      )
  ), false);
$$;

revoke all on function
  app_private.practice_assignment_has_current_original_model_evidence(uuid)
from public, anon, authenticated, service_role;

comment on function
  app_private.practice_assignment_has_current_original_model_evidence(uuid) is
  'Assignment-bound proof that a ready unlinked provider worksheet is the exact immutable completion generated for this assignment. It never authorizes reuse by another assignment.';

-- The lazy withdrawal detector is shared by summary, question, draft,
-- generation-context and request boundaries. Exempt only the exact original
-- assignment proof; canonical and cache withdrawals remain unchanged.
do $migration$
declare
  function_definition text;
  corrected_definition text;
  old_guard constant text := $old$
      and not app_private.practice_test_canonical_revision_is_current(
        assignment.practice_test_id
      )
$old$;
  corrected_guard constant text := $new$
      and not app_private.practice_test_canonical_revision_is_current(
        assignment.practice_test_id
      )
      and not app_private.practice_assignment_has_current_original_model_evidence(
        assignment.id
      )
$new$;
begin
  select pg_get_functiondef(
    'app_private.practice_assignment_has_withdrawn_unstarted_clone(uuid)'::regprocedure
  )
  into function_definition;

  if function_definition is null
    or position(old_guard in function_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'phase14e_expected_withdrawal_guard_missing';
  end if;

  corrected_definition := replace(
    function_definition,
    old_guard,
    corrected_guard
  );

  if position(corrected_guard in corrected_definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'phase14e_withdrawal_guard_rewrite_failed';
  end if;

  execute corrected_definition;
end;
$migration$;

-- Starting an attempt has an independent canonical-withdrawal trigger. Permit
-- the semantic worksheet only when the attempt fields match the exact original
-- assignment and that assignment still has current immutable evidence.
do $migration$
declare
  function_definition text;
  corrected_definition text;
  old_guard constant text := $old$
  elsif selected_independent_model then
    worksheet_withdrawn := not
      app_private.practice_test_canonical_revision_is_current(
        new.practice_test_id
      );
$old$;
  corrected_guard constant text := $new$
  elsif selected_independent_model then
    worksheet_withdrawn := not
      app_private.practice_test_canonical_revision_is_current(
        new.practice_test_id
      )
      and not exists (
        select 1
        from public.student_practice_assignments assignment
        where assignment.id = new.assignment_id
          and assignment.practice_test_id = new.practice_test_id
          and assignment.student_id = new.student_id
          and assignment.workspace_id = new.workspace_id
          and app_private.practice_assignment_has_current_original_model_evidence(
            assignment.id
          )
      );
$new$;
begin
  select pg_get_functiondef(
    'app_private.guard_withdrawn_canonical_practice_attempt()'::regprocedure
  )
  into function_definition;

  if function_definition is null
    or position(old_guard in function_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'phase14e_expected_attempt_guard_missing';
  end if;

  corrected_definition := replace(
    function_definition,
    old_guard,
    corrected_guard
  );

  if position(corrected_guard in corrected_definition) = 0 then
    raise exception using
      errcode = '55000',
      message = 'phase14e_attempt_guard_rewrite_failed';
  end if;

  execute corrected_definition;
end;
$migration$;

revoke all on function
  app_private.practice_assignment_has_withdrawn_unstarted_clone(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  app_private.guard_withdrawn_canonical_practice_attempt()
from public, anon, authenticated, service_role;
