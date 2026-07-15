-- The importer and generation validators accept visible closed word banks
-- separated by comma, semicolon, vertical bar, or slash. The database trigger
-- only accepted commas, so otherwise valid certified worksheets could fail at
-- publication time. Keep the database boundary aligned with the canonical
-- application contract and with the learner-facing packets already validated.

begin;

create or replace function app_private.has_valid_practice_closed_word_bank(
  prompt_value text,
  accepted_values jsonb,
  strict_scoring boolean
)
returns boolean
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  bank_match text[];
  bank_body text;
  normalized_choices text[];
  choice_count integer;
  distinct_choice_count integer;
  choices_nonempty boolean;
begin
  if prompt_value is null
    or jsonb_typeof(accepted_values) <> 'array'
  then
    return false;
  end if;

  bank_match := regexp_match(
    prompt_value,
    '(closed[[:space:]]+)?(word[[:space:]]+bank|word[[:space:]]+list|wortbank|wortliste)[[:space:]]*[:：]?[[:space:]]*(\[([^]]*)\]|\(([^)]*)\))',
    'i'
  );
  if bank_match is null then
    return false;
  end if;

  bank_body := coalesce(bank_match[4], bank_match[5]);
  if bank_body is null or bank_body !~ '[,;|/]' then
    return false;
  end if;

  select
    array_agg(choice.normalized order by choice.ordinality),
    count(*)::integer,
    count(distinct choice.normalized)::integer,
    bool_and(choice.normalized <> '')
  into
    normalized_choices,
    choice_count,
    distinct_choice_count,
    choices_nonempty
  from (
    select
      split.ordinality,
      app_private.normalize_practice_contract_value(
        split.value,
        strict_scoring
      ) as normalized
    from regexp_split_to_table(bank_body, '[,;|/]')
      with ordinality as split(value, ordinality)
  ) choice;

  if choice_count not between 2 and 6
    or distinct_choice_count <> choice_count
    or not coalesce(choices_nonempty, false)
  then
    return false;
  end if;

  return not exists (
    select 1
    from jsonb_array_elements_text(accepted_values) accepted(answer)
    where app_private.normalize_practice_contract_value(
      accepted.answer,
      strict_scoring
    ) <> all(normalized_choices)
  );
end;
$$;

revoke all on function app_private.has_valid_practice_closed_word_bank(
  text,
  jsonb,
  boolean
)
from public, anon, authenticated, service_role;

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
    raise exception using
      errcode = '22023',
      message = 'A validated answer contract is required.';
  end if;

  if lower(btrim(coalesce(new.correct_answer, ''))) in (
    'manual_review',
    'manual review',
    'open_review',
    'flexible_review',
    'requires_review'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Manual-review sentinels are not valid answers.';
  end if;

  if jsonb_typeof(new.accepted_answers) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'Accepted answers must be an array.';
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
    raise exception using
      errcode = '22023',
      message = 'Accepted answers are invalid or duplicated.';
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
      raise exception using
        errcode = '22023',
        message = 'Exact-scoring contract is invalid.';
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
      raise exception using
        errcode = '22023',
        message = 'Multiple-choice answer contract is invalid.';
    end if;

    if new.question_type = 'fill_blank' and (
      (length(new.prompt) - length(replace(new.prompt, '___', ''))) / 3 <> 1
      or not (
        new.prompt ~* '(definite|indefinite|possessive)[[:space:]]+article'
        or new.prompt ~* '(bestimmt[^[:space:]]*|unbestimmt[^[:space:]]*|possessiv[^[:space:]]*)[[:space:]]+artikel'
        or new.prompt ~* '(correct|inflected|conjugated)[[:space:]]+form[[:space:]]+of[[:space:]]+["''„“]?[[:alpha:]][[:alpha:]-]*'
        or new.prompt ~* '(richtig[^[:space:]]*|passend[^[:space:]]*|konjugiert[^[:space:]]*|dekliniert[^[:space:]]*)[[:space:]]+form[[:space:]]+(von[[:space:]]+|des[[:space:]]+wortes[[:space:]]+)["''„“]?[[:alpha:]][[:alpha:]-]*'
        or app_private.has_valid_practice_closed_word_bank(
          new.prompt,
          new.accepted_answers,
          strict_scoring
        )
      )
    ) then
      raise exception using
        errcode = '22023',
        message = 'Fill-blank answer contract is ambiguous.';
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
      raise exception using
        errcode = '22023',
        message = 'Semantic-evaluation rubric is invalid.';
    end if;

    criteria_count := jsonb_array_length(new.rubric -> 'criteria');
    if criteria_count not between 1 and 6 or exists (
      select 1
      from jsonb_array_elements(new.rubric -> 'criteria') criterion(item)
      where jsonb_typeof(criterion.item) <> 'string'
        or length(btrim(criterion.item #>> '{}')) not between 1 and 240
    ) then
      raise exception using
        errcode = '22023',
        message = 'Semantic-evaluation criteria are invalid.';
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
      raise exception using
        errcode = '22023',
        message = 'Semantic sample answer is invalid.';
    end if;
  else
    raise exception using
      errcode = '22023',
      message = 'Evaluation mode is invalid.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.validate_practice_question_contract()
from public, anon, authenticated, service_role;

comment on function app_private.validate_practice_question_contract() is
  'Validates exact or semantic worksheet answer contracts; closed word banks accept the canonical comma, semicolon, vertical-bar, or slash separators.';

comment on function app_private.has_valid_practice_closed_word_bank(
  text,
  jsonb,
  boolean
) is
  'Validates a visible two-to-six-choice closed word bank and binds every accepted exact answer to a unique listed choice.';

commit;
