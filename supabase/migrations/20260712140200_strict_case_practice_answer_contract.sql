-- Capitalization and spelling worksheets are intentionally case-sensitive.
-- The Phase 9A answer-contract trigger compared every option and accepted
-- answer after lowercasing, so a valid capitalization choice such as
-- "Pflege" versus "pflege" was rejected as a duplicate before critics could
-- review or students could receive the worksheet. Keep the existing relaxed
-- contract for all other topics, but bind strict normalization to the parent
-- worksheet's canonical grammar topic for both workspace and bank questions.

create or replace function app_private.normalize_practice_contract_value(
  answer_value text,
  strict_scoring boolean
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when strict_scoring then
      regexp_replace(btrim(coalesce(answer_value, '')), '\s+', ' ', 'g')
    else lower(
      regexp_replace(btrim(coalesce(answer_value, '')), '\s+', ' ', 'g')
    )
  end;
$$;

revoke all on function app_private.normalize_practice_contract_value(
  text, boolean
) from public, anon, authenticated, service_role;

create or replace function app_private.validate_practice_question_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  accepted_count integer;
  criteria_count integer;
  strict_scoring boolean := false;
  parent_id uuid;
  normalized_answer text;
begin
  if tg_relid = 'public.practice_test_questions'::regclass then
    parent_id := nullif(to_jsonb(new) ->> 'practice_test_id', '')::uuid;
    select app_private.is_practice_topic_strict_scoring(topic.name, topic.slug)
    into strict_scoring
    from public.practice_tests worksheet
    join public.grammar_topics topic
      on topic.id = worksheet.grammar_topic_id
    where worksheet.id = parent_id;
  elsif tg_relid =
    'app_private.practice_worksheet_template_questions'::regclass
  then
    parent_id := nullif(to_jsonb(new) ->> 'revision_id', '')::uuid;
    select app_private.is_practice_topic_strict_scoring(topic.name, topic.slug)
    into strict_scoring
    from app_private.practice_worksheet_template_revisions revision
    join app_private.practice_worksheet_templates template
      on template.id = revision.template_id
    join public.grammar_topics topic
      on topic.id = template.grammar_topic_id
    where revision.id = parent_id;
  else
    raise exception using
      errcode = '55000',
      message = 'Practice question parent contract is unavailable.';
  end if;

  strict_scoring := coalesce(strict_scoring, false);
  normalized_answer := app_private.normalize_practice_contract_value(
    new.correct_answer,
    strict_scoring
  );

  if new.answer_contract_version <> 1 then
    raise exception using errcode = '22023', message = 'A validated answer contract is required.';
  end if;

  if lower(btrim(coalesce(new.correct_answer, ''))) in (
    'manual_review',
    'manual review',
    'open_review',
    'flexible_review',
    'requires_review'
  ) then
    raise exception using errcode = '22023', message = 'Manual-review sentinels are not valid answers.';
  end if;

  if jsonb_typeof(new.accepted_answers) <> 'array' then
    raise exception using errcode = '22023', message = 'Accepted answers must be an array.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(new.accepted_answers) accepted(item)
    where jsonb_typeof(accepted.item) <> 'string'
      or length(btrim(accepted.item #>> '{}')) not between 1 and 500
  ) or (
    select count(*) <> count(distinct
      app_private.normalize_practice_contract_value(
        accepted.item #>> '{}',
        strict_scoring
      )
    )
    from jsonb_array_elements(new.accepted_answers) accepted(item)
  ) then
    raise exception using errcode = '22023', message = 'Accepted answers are invalid or duplicated.';
  end if;

  accepted_count := jsonb_array_length(new.accepted_answers);

  if new.evaluation_mode = 'local_exact' then
    if new.question_type not in ('multiple_choice', 'fill_blank')
      or normalized_answer = ''
      or accepted_count not between 1 and 12
      or new.rubric is not null
      or not exists (
        select 1
        from jsonb_array_elements_text(new.accepted_answers) accepted(answer)
        where app_private.normalize_practice_contract_value(
          accepted.answer,
          strict_scoring
        ) = normalized_answer
      )
    then
      raise exception using errcode = '22023', message = 'Exact-scoring contract is invalid.';
    end if;

    if new.question_type = 'multiple_choice' and (
      accepted_count <> 1
      or jsonb_typeof(new.options) <> 'array'
      or (
        select count(*)
        from jsonb_array_elements_text(new.options) option_value
        where app_private.normalize_practice_contract_value(
          option_value,
          strict_scoring
        ) = normalized_answer
      ) <> 1
    ) then
      raise exception using errcode = '22023', message = 'Multiple-choice answer contract is invalid.';
    end if;

    if new.question_type = 'fill_blank' and (
      (length(new.prompt) - length(replace(new.prompt, '___', ''))) / 3 <> 1
      or not (
        new.prompt ~* '(definite|indefinite|possessive)[[:space:]]+article'
        or new.prompt ~* '(bestimmt[^[:space:]]*|unbestimmt[^[:space:]]*|possessiv[^[:space:]]*)[[:space:]]+artikel'
        or new.prompt ~* '(conjugate|correct form of|partizip[[:space:]]*(ii|2)|comparative|superlative)'
        or new.prompt ~* '(konjugier|richtige[^[:space:]]*[[:space:]]+form|komparativ|superlativ|partizip[[:space:]]*(ii|2))'
        or (
          new.prompt ~* '(closed[[:space:]]+)?(word[[:space:]]+bank|word[[:space:]]+list)|wortbank|wortliste'
          and position(',' in new.prompt) > 0
        )
      )
    ) then
      raise exception using errcode = '22023', message = 'Fill-blank answer contract is ambiguous.';
    end if;
  elsif new.evaluation_mode = 'open_evaluation' then
    if accepted_count <> 0
      or new.question_type = 'multiple_choice'
      or new.rubric is null
      or not (new.rubric ?& array['criteria', 'sample_answer'])
      or new.rubric - array['criteria', 'sample_answer']::text[] <> '{}'::jsonb
      or jsonb_typeof(new.rubric -> 'criteria') <> 'array'
      or jsonb_typeof(new.rubric -> 'sample_answer') not in ('string', 'null')
    then
      raise exception using errcode = '22023', message = 'Semantic-evaluation rubric is invalid.';
    end if;

    criteria_count := jsonb_array_length(new.rubric -> 'criteria');
    if criteria_count not between 1 and 6 or exists (
      select 1
      from jsonb_array_elements(new.rubric -> 'criteria') criterion(item)
      where jsonb_typeof(criterion.item) <> 'string'
        or length(btrim(criterion.item #>> '{}')) not between 1 and 240
    ) then
      raise exception using errcode = '22023', message = 'Semantic-evaluation criteria are invalid.';
    end if;

    if jsonb_typeof(new.rubric -> 'sample_answer') = 'string' and (
      length(btrim(new.rubric ->> 'sample_answer')) not between 1 and 500
      or (
        normalized_answer <> ''
        and app_private.normalize_practice_contract_value(
          new.rubric ->> 'sample_answer',
          strict_scoring
        ) <> normalized_answer
      )
    ) then
      raise exception using errcode = '22023', message = 'Semantic sample answer is invalid.';
    end if;
  else
    raise exception using errcode = '22023', message = 'Evaluation mode is invalid.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.validate_practice_question_contract()
from public, anon, authenticated, service_role;

comment on function app_private.normalize_practice_contract_value(
  text, boolean
) is
  'Normalizes persisted worksheet answer contracts while preserving case for capitalization and spelling topics.';

comment on function app_private.validate_practice_question_contract() is
  'Validates exact or semantic worksheet answer contracts using the immutable parent grammar topic; capitalization and spelling contracts remain case-sensitive.';
