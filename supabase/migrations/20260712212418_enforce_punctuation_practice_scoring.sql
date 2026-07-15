-- Punctuation worksheets must score the punctuation they explicitly test.
--
-- The historical local scorer deliberately treats a sentence-final .!? change
-- as harmless `minor_punctuation` for ordinary grammar practice. That behavior
-- is useful outside punctuation lessons and remains unchanged. Punctuation
-- worksheets, however, include exact answers such as `?` and full-sentence
-- choices that differ only by their final mark. Route those questions through
-- a topic-aware policy so the punctuation distinction cannot collapse to full
-- credit, while capitalization/spelling and ordinary grammar keep their
-- established behavior.

create or replace function app_private.is_practice_topic_punctuation_scoring(
  topic_name text,
  topic_slug text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select lower(btrim(coalesce(topic_slug, ''))) = 'punctuation'
    or (coalesce(topic_name, '') || ' ' || coalesce(topic_slug, '')) ~*
      '(punctuat|zeichensetz|interpunkt)';
$$;

revoke all on function app_private.is_practice_topic_punctuation_scoring(
  text, text
) from public, anon, authenticated, service_role;

create or replace function app_private.practice_answer_review_status_with_policy(
  submitted_answer text,
  correct_answer text,
  strict_case_scoring boolean,
  strict_punctuation_scoring boolean
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  with normalized as (
    select
      app_private.normalize_practice_answer_exact(submitted_answer)
        as submitted_exact,
      app_private.normalize_practice_answer_exact(correct_answer)
        as correct_exact,
      app_private.normalize_practice_answer_without_final_punctuation(
        submitted_answer
      ) as submitted_without_punctuation,
      app_private.normalize_practice_answer_without_final_punctuation(
        correct_answer
      ) as correct_without_punctuation
  )
  select case
    when nullif(btrim(coalesce(correct_answer, '')), '') is null
      then 'submitted_for_review'
    when submitted_exact = correct_exact then 'correct'
    when coalesce(strict_punctuation_scoring, false) then
      case
        -- Preserve the existing half-credit capitalization behavior only when
        -- the complete punctuation-bearing answer is otherwise identical.
        when not coalesce(strict_case_scoring, false)
          and lower(submitted_exact) = lower(correct_exact)
          then 'capitalization_issue'
        else 'incorrect'
      end
    when submitted_without_punctuation = correct_without_punctuation
      then 'minor_punctuation'
    when not coalesce(strict_case_scoring, false)
      and lower(submitted_without_punctuation) =
        lower(correct_without_punctuation)
      then 'capitalization_issue'
    else 'incorrect'
  end
  from normalized;
$$;

revoke all on function app_private.practice_answer_review_status_with_policy(
  text, text, boolean, boolean
) from public, anon, authenticated, service_role;

create or replace function app_private.practice_answer_review_status_any(
  submitted_answer text,
  correct_answer text,
  accepted_answers jsonb,
  strict_case_scoring boolean,
  grammar_topic_id uuid
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  strict_punctuation_scoring boolean := false;
  selected_status text;
begin
  select app_private.is_practice_topic_punctuation_scoring(
    topic.name,
    topic.slug
  )
  into strict_punctuation_scoring
  from public.grammar_topics topic
  where topic.id = grammar_topic_id;

  strict_punctuation_scoring := coalesce(strict_punctuation_scoring, false);

  select candidate.review_status
  into selected_status
  from (
    select
      app_private.practice_answer_review_status_with_policy(
        submitted_answer,
        accepted.answer,
        strict_case_scoring,
        strict_punctuation_scoring
      ) as review_status
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(accepted_answers) = 'array' then accepted_answers
        else '[]'::jsonb
      end
    ) accepted(answer)
  ) candidate
  order by
    app_private.practice_review_status_points(candidate.review_status) desc
      nulls last,
    case candidate.review_status
      when 'correct' then 5
      when 'minor_punctuation' then 4
      when 'partially_correct' then 3
      when 'capitalization_issue' then 2
      else 1
    end desc
  limit 1;

  return coalesce(
    selected_status,
    app_private.practice_answer_review_status_with_policy(
      submitted_answer,
      correct_answer,
      strict_case_scoring,
      strict_punctuation_scoring
    )
  );
end;
$$;

revoke all on function app_private.practice_answer_review_status_any(
  text, text, jsonb, boolean, uuid
) from public, anon, authenticated, service_role;

-- Patch only the three current local-score decision points. Each replacement
-- is exact and fail-closed so a future upstream function change cannot silently
-- leave one user-visible path on the unsafe four-argument scorer.
do $patch_punctuation_practice_scorers$
declare
  function_sql text;
  original_sql text;
begin
  select pg_get_functiondef(
    'app_private.submit_practice_attempt_internal_phase_7d2_unchecked(uuid,jsonb)'::regprocedure
  ) into function_sql;
  original_sql := function_sql;
  function_sql := replace(
    function_sql,
    E'app_private.practice_answer_review_status_any(\n        coalesce(submitted.answer, ''''),\n        sq.correct_answer,\n        sq.accepted_answers,\n        strict_scoring\n      )',
    E'app_private.practice_answer_review_status_any(\n        coalesce(submitted.answer, ''''),\n        sq.correct_answer,\n        sq.accepted_answers,\n        strict_scoring,\n        assignment_record.grammar_topic_id\n      )'
  );
  if function_sql = original_sql
    or length(function_sql) - length(replace(
      function_sql,
      'assignment_record.grammar_topic_id',
      ''
    )) < length('assignment_record.grammar_topic_id')
  then
    raise exception using
      errcode = '55000',
      message = 'practice_submit_punctuation_scoring_patch_failed';
  end if;
  execute function_sql;

  select pg_get_functiondef(
    'app_private.finalize_practice_attempt_evaluation_internal(uuid,text)'::regprocedure
  ) into function_sql;
  original_sql := function_sql;
  function_sql := replace(
    function_sql,
    E'app_private.practice_answer_review_status_any(\n        question.student_answer,\n        question.correct_answer,\n        question.accepted_answers,\n        strict_scoring\n      )',
    E'app_private.practice_answer_review_status_any(\n        question.student_answer,\n        question.correct_answer,\n        question.accepted_answers,\n        strict_scoring,\n        assignment_record.grammar_topic_id\n      )'
  );
  if function_sql = original_sql
    or position(
      'assignment_record.grammar_topic_id' in function_sql
    ) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'practice_finalizer_punctuation_scoring_patch_failed';
  end if;
  execute function_sql;

  select pg_get_functiondef(
    'app_private.get_practice_assignment_review_internal(uuid)'::regprocedure
  ) into function_sql;
  original_sql := function_sql;
  function_sql := replace(
    function_sql,
    E'app_private.practice_answer_review_status_any(\n              q.student_answer,\n              q.correct_answer,\n              q.accepted_answers,\n              strict_scoring\n            )',
    E'app_private.practice_answer_review_status_any(\n              q.student_answer,\n              q.correct_answer,\n              q.accepted_answers,\n              strict_scoring,\n              assignment_record.grammar_topic_id\n            )'
  );
  if function_sql = original_sql
    or position(
      'assignment_record.grammar_topic_id' in function_sql
    ) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'practice_review_punctuation_scoring_patch_failed';
  end if;
  execute function_sql;
end;
$patch_punctuation_practice_scorers$;

comment on function app_private.is_practice_topic_punctuation_scoring(
  text, text
) is
  'Closed-topic predicate for literal punctuation scoring in practice worksheets.';

comment on function app_private.practice_answer_review_status_with_policy(
  text, text, boolean, boolean
) is
  'Local answer classifier that preserves ordinary partial-formatting credit but requires exact punctuation for punctuation lessons.';

comment on function app_private.practice_answer_review_status_any(
  text, text, jsonb, boolean, uuid
) is
  'Topic-aware accepted-answer scorer. Canonical punctuation worksheets cannot receive full credit for a different punctuation mark.';
