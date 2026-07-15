-- The provider pipeline now has a deliberately narrow, fully deterministic
-- fallback profile: every task is an exact-scored multiple-choice question.
-- Keep the established rich-mix count gate equivalent, align its MCQ option
-- identity with the existing topic-aware scoring contract, and add only the
-- closed mcq_safe alternative at the final materializer.
--
-- Patch the current function definition instead of restoring an older copy.
-- This preserves every intervening durability/security change and aborts the
-- migration if the expected historical gate is no longer present exactly once.
do $migration$
declare
  current_definition text;
  patched_definition text;
  historical_declaration constant text := $fragment$
  completion_mode text;
begin
$fragment$;
  strict_declaration constant text := $fragment$
  completion_mode text;
  strict_scoring boolean := false;
begin
$fragment$;
  historical_topic_boundary constant text := $fragment$
  if selected_assignment.class_context_version <> 1
    or selected_assignment.batch_id is null
    or target_level is null
    or target_level not in ('A1', 'A2', 'B1', 'B2')
  then
    raise exception using errcode = '22023', message = 'Practice assignment class context is required.';
  end if;

  if worksheet is null
$fragment$;
  strict_topic_boundary constant text := $fragment$
  if selected_assignment.class_context_version <> 1
    or selected_assignment.batch_id is null
    or target_level is null
    or target_level not in ('A1', 'A2', 'B1', 'B2')
  then
    raise exception using errcode = '22023', message = 'Practice assignment class context is required.';
  end if;

  select coalesce(
    app_private.is_practice_topic_strict_scoring(topic.name, topic.slug),
    false
  ) or coalesce(
    app_private.is_practice_topic_punctuation_scoring(topic.name, topic.slug),
    false
  )
  into strict_scoring
  from public.grammar_topics topic
  where topic.id = selected_assignment.grammar_topic_id;

  if worksheet is null
$fragment$;
  historical_option_gate constant text := $fragment$
    if exists (
      select 1
      from jsonb_array_elements(worksheet -> 'questions') q(item)
      where q.item ->> 'question_type' = 'multiple_choice'
        and (
          select count(*)
          from jsonb_array_elements_text(q.item -> 'options') option_value
          where lower(btrim(option_value)) = lower(btrim(q.item ->> 'correct_answer'))
        ) <> 1
    ) or exists (
      select 1
      from jsonb_array_elements(worksheet -> 'questions') q(item)
      where q.item ->> 'question_type' = 'multiple_choice'
        and (
          select count(*) <> count(distinct lower(btrim(option_value)))
          from jsonb_array_elements_text(q.item -> 'options') option_value
        )
    ) or (
$fragment$;
  strict_option_gate constant text := $fragment$
    if exists (
      select 1
      from jsonb_array_elements(worksheet -> 'questions') q(item)
      where q.item ->> 'question_type' = 'multiple_choice'
        and (
          select count(*)
          from jsonb_array_elements_text(q.item -> 'options') option_value
          where app_private.normalize_practice_contract_value(
            option_value,
            strict_scoring
          ) = app_private.normalize_practice_contract_value(
            q.item ->> 'correct_answer',
            strict_scoring
          )
        ) <> 1
    ) or exists (
      select 1
      from jsonb_array_elements(worksheet -> 'questions') q(item)
      where q.item ->> 'question_type' = 'multiple_choice'
        and (
          select count(*) <> count(distinct
            app_private.normalize_practice_contract_value(
              option_value,
              strict_scoring
            )
          )
          from jsonb_array_elements_text(q.item -> 'options') option_value
        )
    ) or (
$fragment$;
  historical_mix_gate constant text := $gate$
    if open_question_count not between 1 and 3
      or multiple_choice_count < 2
      or fill_blank_count < 2
    then
      raise exception using errcode = '22023', message = 'Generated worksheet mix is unsafe.';
    end if;
$gate$;
  expanded_mix_gate constant text := $gate$
    if not (
      (
        open_question_count between 1 and 3
        and multiple_choice_count >= 2
        and fill_blank_count >= 2
      )
      or (
        open_question_count = 0
        and multiple_choice_count = question_count
        and fill_blank_count = 0
        and not exists (
          select 1
          from jsonb_array_elements(worksheet -> 'questions') q(item)
          where q.item ->> 'question_type' <> 'multiple_choice'
            or q.item ->> 'evaluation_mode' <> 'local_exact'
            or q.item -> 'rubric' is distinct from 'null'::jsonb
            or jsonb_array_length(q.item -> 'options') not between 3 and 4
            or exists (
              select 1
              from jsonb_array_elements(q.item -> 'options') option_value(value)
              where jsonb_typeof(option_value.value) <> 'string'
                or length(btrim(option_value.value #>> '{}')) = 0
            )
            or (
              select count(*) <> count(distinct
                app_private.normalize_practice_contract_value(
                  option_value,
                  strict_scoring
                )
              )
              from jsonb_array_elements_text(q.item -> 'options') option_value
            )
            or (
              select count(*)
              from jsonb_array_elements_text(q.item -> 'options') option_value
              where btrim(option_value) = btrim(q.item ->> 'correct_answer')
            ) <> 1
            or jsonb_array_length(q.item -> 'accepted_answers') <> 1
            or jsonb_typeof(q.item #> '{accepted_answers,0}') <> 'string'
            or (q.item #>> '{accepted_answers,0}')
              is distinct from (q.item ->> 'correct_answer')
        )
      )
    ) then
      raise exception using errcode = '22023', message = 'Generated worksheet mix is unsafe.';
    end if;
$gate$;
begin
  select pg_get_functiondef(
    'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)'::regprocedure
  )
  into strict current_definition;

  if strpos(current_definition, historical_declaration) = 0
    or length(current_definition)
      - length(replace(current_definition, historical_declaration, ''))
      <> length(historical_declaration)
    or strpos(current_definition, historical_topic_boundary) = 0
    or length(current_definition)
      - length(replace(current_definition, historical_topic_boundary, ''))
      <> length(historical_topic_boundary)
    or strpos(current_definition, historical_option_gate) = 0
    or length(current_definition)
      - length(replace(current_definition, historical_option_gate, ''))
      <> length(historical_option_gate)
    or strpos(current_definition, historical_mix_gate) = 0
    or length(current_definition)
      - length(replace(current_definition, historical_mix_gate, ''))
      <> length(historical_mix_gate)
  then
    raise exception using
      errcode = '55000',
      message = 'complete_worksheet_generation_mix_gate_drifted';
  end if;

  patched_definition := replace(
    replace(
      replace(
        replace(
          current_definition,
          historical_declaration,
          strict_declaration
        ),
        historical_topic_boundary,
        strict_topic_boundary
      ),
      historical_option_gate,
      strict_option_gate
    ),
    historical_mix_gate,
    expanded_mix_gate
  );

  execute patched_definition;
end;
$migration$;

-- CREATE OR REPLACE preserves the existing ACL. Repeat the intended boundary
-- explicitly so future privilege drift cannot make the legacy materializer a
-- browser- or worker-callable surface; workers continue through api.* only.
revoke all on function public.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
)
from public, anon, authenticated, service_role;

comment on function public.complete_worksheet_generation(
  uuid, bigint, uuid, jsonb
) is
  'Private transactional worksheet materializer. Accepts the historical rich mix or a deterministic all-MCQ local_exact fallback after gated API validation.';

notify pgrst, 'reload schema';
