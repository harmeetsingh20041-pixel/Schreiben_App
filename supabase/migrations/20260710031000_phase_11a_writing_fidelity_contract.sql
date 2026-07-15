-- Phase 11A: lossless writing offsets, closed grammar topics, and database-side
-- feedback semantics. New production starts empty; the nullable offset pair
-- preserves staging history that predates the offset contract.

create table if not exists app_private.grammar_topic_contracts (
  slug text primary key,
  display_name text not null,
  constraint grammar_topic_contracts_slug_check
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create table if not exists app_private.grammar_topic_aliases (
  alias_slug text primary key,
  canonical_slug text not null
    references app_private.grammar_topic_contracts(slug) on delete cascade,
  constraint grammar_topic_aliases_slug_check
    check (alias_slug ~ '^[[:alnum:]]+(?:-[[:alnum:]]+)*$')
);

alter table app_private.grammar_topic_contracts enable row level security;
alter table app_private.grammar_topic_aliases enable row level security;
revoke all on table app_private.grammar_topic_contracts
from public, anon, authenticated, service_role;
revoke all on table app_private.grammar_topic_aliases
from public, anon, authenticated, service_role;

insert into app_private.grammar_topic_contracts (slug, display_name)
values
  ('articles', 'Articles'),
  ('nominativ', 'Nominativ'),
  ('akkusativ', 'Akkusativ'),
  ('dativ', 'Dativ'),
  ('genitiv', 'Genitiv'),
  ('adjective-endings', 'Adjective endings'),
  ('pronouns', 'Pronouns'),
  ('plural-forms', 'Plural forms'),
  ('conjugation', 'Conjugation'),
  ('subject-verb-agreement', 'Subject-verb agreement'),
  ('verb-position', 'Verb position'),
  ('word-order', 'Word order'),
  ('sentence-structure', 'Sentence structure'),
  ('question-formation', 'Question formation'),
  ('negation', 'Negation'),
  ('modal-verbs', 'Modal verbs'),
  ('separable-verbs', 'Separable verbs'),
  ('reflexive-verbs', 'Reflexive verbs'),
  ('prepositions', 'Prepositions'),
  ('conjunctions', 'Conjunctions'),
  ('connectors', 'Connectors'),
  ('subordinate-clauses', 'Subordinate clauses'),
  ('relative-clauses', 'Relative clauses'),
  ('infinitive-zu', 'Infinitive with zu'),
  ('perfekt', 'Perfekt'),
  ('praeteritum', 'Präteritum'),
  ('plusquamperfekt', 'Plusquamperfekt'),
  ('future-tense', 'Future tense'),
  ('passive-voice', 'Passive voice'),
  ('konjunktiv', 'Konjunktiv'),
  ('spelling', 'Spelling'),
  ('capitalization', 'Capitalization'),
  ('punctuation', 'Punctuation'),
  ('register', 'Register'),
  ('coherence', 'Coherence'),
  ('task-fulfilment', 'Task fulfilment')
on conflict (slug) do update
set display_name = excluded.display_name;

insert into app_private.grammar_topic_aliases (alias_slug, canonical_slug)
select contract.slug, contract.slug
from app_private.grammar_topic_contracts contract
on conflict (alias_slug) do update
set canonical_slug = excluded.canonical_slug;

insert into app_private.grammar_topic_aliases (alias_slug, canonical_slug)
values
  ('article', 'articles'), ('artikel', 'articles'), ('artikeln', 'articles'),
  ('artikelgebrauch', 'articles'),
  ('nominative', 'nominativ'), ('nominative-case', 'nominativ'),
  ('accusative', 'akkusativ'), ('accusative-case', 'akkusativ'),
  ('dative', 'dativ'), ('dative-case', 'dativ'),
  ('genitive', 'genitiv'), ('genitive-case', 'genitiv'),
  ('adjective-declension', 'adjective-endings'),
  ('adjective-inflection', 'adjective-endings'),
  ('adjektivendungen', 'adjective-endings'),
  ('pronoun', 'pronouns'), ('pronomen', 'pronouns'),
  ('plural', 'plural-forms'), ('pluralformen', 'plural-forms'),
  ('verb-conjugation', 'conjugation'), ('konjugation', 'conjugation'),
  ('subject-verb-concord', 'subject-verb-agreement'),
  ('subjekt-verb-kongruenz', 'subject-verb-agreement'),
  ('verb-positions', 'verb-position'), ('verb-positioning', 'verb-position'),
  ('sentence-order', 'word-order'),
  ('sentence-construction', 'sentence-structure'), ('structure', 'sentence-structure'),
  ('questions', 'question-formation'), ('fragebildung', 'question-formation'),
  ('verneinung', 'negation'),
  ('modal-verb', 'modal-verbs'), ('modalverben', 'modal-verbs'),
  ('separable-verb', 'separable-verbs'), ('trennbare-verben', 'separable-verbs'),
  ('reflexive-verb', 'reflexive-verbs'), ('reflexive-verben', 'reflexive-verbs'),
  ('preposition', 'prepositions'), ('präpositionen', 'prepositions'),
  ('conjunction', 'conjunctions'), ('konjunktionen', 'conjunctions'),
  ('connector', 'connectors'), ('konnektoren', 'connectors'),
  ('subordinate-clause', 'subordinate-clauses'),
  ('nebensätze', 'subordinate-clauses'), ('nebensaetze', 'subordinate-clauses'),
  ('relative-clause', 'relative-clauses'),
  ('relativsätze', 'relative-clauses'), ('relativsaetze', 'relative-clauses'),
  ('zu-infinitive', 'infinitive-zu'), ('infinitive-with-zu', 'infinitive-zu'),
  ('infinitiv-mit-zu', 'infinitive-zu'),
  ('past-tense', 'perfekt'), ('perfect-tense', 'perfekt'),
  ('präteritum', 'praeteritum'), ('simple-past', 'praeteritum'),
  ('past-perfect', 'plusquamperfekt'), ('futur', 'future-tense'),
  ('passive', 'passive-voice'), ('passiv', 'passive-voice'),
  ('subjunctive', 'konjunktiv'),
  ('rechtschreibung', 'spelling'),
  ('großschreibung', 'capitalization'), ('grossschreibung', 'capitalization'),
  ('zeichensetzung', 'punctuation'), ('stilregister', 'register'),
  ('kohärenz', 'coherence'), ('kohaerenz', 'coherence'),
  ('task-fulfillment', 'task-fulfilment'),
  ('aufgabenerfüllung', 'task-fulfilment'),
  ('aufgabenerfuellung', 'task-fulfilment')
on conflict (alias_slug) do update
set canonical_slug = excluded.canonical_slug;

insert into public.grammar_topics (slug, name, level, description)
select
  contract.slug,
  contract.display_name,
  'A1_A2',
  'Closed A1-B2 writing-feedback topic. Persist only after deterministic validation.'
from app_private.grammar_topic_contracts contract
on conflict (slug, level) do update
set name = excluded.name,
    description = excluded.description;

create or replace function app_private.canonical_grammar_topic_slug(topic_value text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select alias.canonical_slug
  from app_private.grammar_topic_aliases alias
  where alias.alias_slug = trim(both '-' from lower(regexp_replace(
    btrim(coalesce(topic_value, '')),
    '[^[:alnum:]]+',
    '-',
    'g'
  )))
  limit 1;
$$;

revoke all on function app_private.canonical_grammar_topic_slug(text)
from public, anon, authenticated, service_role;

-- Keep the enqueue boundary aligned with the evaluator's unit limit. This
-- deliberately mirrors the lossless Edge segmentation rules closely enough to
-- reject poison submissions before a queue message exists: newlines end an
-- unpunctuated unit; sentence punctuation ends a unit only at whitespace/end;
-- decimals, ordinals, initials, and common German abbreviations stay intact.
create or replace function app_private.writing_feedback_unit_count(value text)
returns integer
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  value_length integer := char_length(value);
  cursor_position integer := 1;
  punctuation_end integer;
  next_position integer;
  unit_count integer := 0;
  unit_has_content boolean := false;
  current_character text;
  previous_character text;
  next_character text;
  token_before_period text;
  period_is_nonterminal boolean;
  known_abbreviations constant text[] := array[
    'abs.', 'art.', 'bzw.', 'ca.', 'd.h.', 'dipl.', 'dr.', 'e.v.',
    'etc.', 'evtl.', 'exkl.', 'fr.', 'geb.', 'ggf.', 'hr.', 'inkl.',
    'mag.', 'nr.', 'o.ä.', 'prof.', 'str.', 'tel.', 'u.a.', 'u.ä.',
    'usw.', 'vgl.', 'z.b.', 'zzt.'
  ];
begin
  while cursor_position <= value_length loop
    current_character := substring(value from cursor_position for 1);

    if current_character ~ '[[:space:]]' then
      if current_character in (chr(10), chr(13)) and unit_has_content then
        unit_count := unit_count + 1;
        unit_has_content := false;
      end if;
      cursor_position := cursor_position + 1;
      continue;
    end if;

    unit_has_content := true;
    if current_character not in ('.', '!', '?') then
      cursor_position := cursor_position + 1;
      continue;
    end if;

    period_is_nonterminal := false;
    if current_character = '.' then
      previous_character := case
        when cursor_position > 1 then substring(value from cursor_position - 1 for 1)
        else ''
      end;
      next_character := case
        when cursor_position < value_length then substring(value from cursor_position + 1 for 1)
        else ''
      end;
      token_before_period := coalesce(substring(
        substring(value from 1 for cursor_position)
        from '([[:alnum:].]+)$'
      ), '');

      period_is_nonterminal := (
        previous_character ~ '^[0-9]$' and next_character ~ '^[0-9]$'
      )
        or lower(token_before_period) = any(known_abbreviations)
        or token_before_period ~ '^([[:alpha:]]{1,3}[.]){2,}$'
        or token_before_period ~ '^[[:alpha:]][.]$'
        or token_before_period ~ '^[0-9]+[.]$';
    end if;

    if period_is_nonterminal then
      cursor_position := cursor_position + 1;
      continue;
    end if;

    punctuation_end := cursor_position + 1;
    while punctuation_end <= value_length
      and substring(value from punctuation_end for 1) in ('.', '!', '?')
    loop
      punctuation_end := punctuation_end + 1;
    end loop;
    while punctuation_end <= value_length
      and substring(value from punctuation_end for 1) in (
        '"', '''', '»', '“', '”', '’', ')', ']', '}'
      )
    loop
      punctuation_end := punctuation_end + 1;
    end loop;

    next_position := punctuation_end;
    if next_position > value_length
      or substring(value from next_position for 1) ~ '[[:space:]]'
    then
      unit_count := unit_count + 1;
      unit_has_content := false;
      cursor_position := punctuation_end;
    else
      cursor_position := cursor_position + 1;
    end if;
  end loop;

  if unit_has_content then
    unit_count := unit_count + 1;
  end if;
  return unit_count;
end;
$$;

revoke all on function app_private.writing_feedback_unit_count(text)
from public, anon, authenticated, service_role;

-- The legacy internal creator validates a trimmed copy and historically stored
-- that copy. Preserve its mature assignment/mode checks behind a private name,
-- then restore the exact caller text before control returns to the durable
-- public wrapper and before that wrapper enqueues the job.
alter function app_private.create_writing_submission_internal(
  text,
  uuid,
  uuid,
  text,
  boolean
) rename to create_writing_submission_internal_trimmed_legacy;

revoke all on function app_private.create_writing_submission_internal_trimmed_legacy(
  text,
  uuid,
  uuid,
  text,
  boolean
)
from public, anon, authenticated, service_role;

create or replace function app_private.create_writing_submission_internal(
  target_question_source text,
  target_question_id uuid,
  target_batch_id uuid,
  answer_text text,
  save_as_draft boolean default false
)
returns table (
  submission_id uuid,
  feedback_mode text,
  feedback_scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_submission record;
begin
  if answer_text is null or answer_text !~ '[^[:space:]]' then
    raise exception using errcode = '22023', message = 'Writing text is required.';
  end if;

  if regexp_replace(answer_text, E'[\t\n\r]', '', 'g') ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'Writing text contains unsupported control characters.';
  end if;

  if char_length(answer_text) > 12000 then
    raise exception using
      errcode = '22023',
      message = 'Writing text is too long. Please keep it under 12000 characters.';
  end if;

  if app_private.writing_feedback_unit_count(answer_text) > 120 then
    raise exception using
      errcode = '22023',
      message = 'Writing has too many feedback units. Please keep it to 120 sentences or paragraphs.';
  end if;

  select created.*
  into created_submission
  from app_private.create_writing_submission_internal_trimmed_legacy(
    target_question_source,
    target_question_id,
    target_batch_id,
    answer_text,
    save_as_draft
  ) created;

  update public.submissions submission
  set original_text = answer_text
  where submission.id = created_submission.submission_id;

  return query
  select
    created_submission.submission_id,
    created_submission.feedback_mode,
    created_submission.feedback_scheduled_at;
end;
$$;

revoke all on function app_private.create_writing_submission_internal(
  text,
  uuid,
  uuid,
  text,
  boolean
)
from public, anon, authenticated, service_role;

-- A correction span contract is useful only when the ordered spans describe
-- the complete edit. Matching each individual `from`/`to` value is not enough:
-- repeated words could otherwise let a caller point at the wrong occurrence or
-- omit an unrelated rewrite. PostgreSQL `char_length` uses Unicode characters,
-- matching the Edge evaluator's code-point offsets.
create or replace function app_private.feedback_change_spans_match(
  original_line_value text,
  corrected_line_value text,
  line_source_start integer,
  changed_parts_value jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  part_item jsonb;
  part_source_start integer;
  part_source_end integer;
  part_corrected_start integer;
  part_corrected_end integer;
  relative_source_start integer;
  relative_source_end integer;
  unchanged_length integer;
  source_cursor integer := 0;
  corrected_cursor integer := 0;
begin
  if original_line_value is null
    or corrected_line_value is null
    or line_source_start is null
    or coalesce(jsonb_typeof(changed_parts_value) <> 'array', true)
  then
    return false;
  end if;

  for part_item in
    select element.item
    from jsonb_array_elements(changed_parts_value)
      with ordinality as element(item, ordinality)
    order by element.ordinality
  loop
    if jsonb_typeof(part_item) <> 'object'
      or coalesce(part_item ->> 'source_start', '') !~ '^[0-9]+$'
      or coalesce(part_item ->> 'source_end', '') !~ '^[0-9]+$'
      or coalesce(part_item ->> 'corrected_start', '') !~ '^[0-9]+$'
      or coalesce(part_item ->> 'corrected_end', '') !~ '^[0-9]+$'
      or jsonb_typeof(part_item -> 'from') <> 'string'
      or jsonb_typeof(part_item -> 'to') <> 'string'
    then
      return false;
    end if;

    part_source_start := (part_item ->> 'source_start')::integer;
    part_source_end := (part_item ->> 'source_end')::integer;
    part_corrected_start := (part_item ->> 'corrected_start')::integer;
    part_corrected_end := (part_item ->> 'corrected_end')::integer;
    relative_source_start := part_source_start - line_source_start;
    relative_source_end := part_source_end - line_source_start;

    if relative_source_start < source_cursor
      or relative_source_end < relative_source_start
      or relative_source_end > char_length(original_line_value)
      or part_corrected_start < corrected_cursor
      or part_corrected_end < part_corrected_start
      or part_corrected_end > char_length(corrected_line_value)
    then
      return false;
    end if;

    unchanged_length := relative_source_start - source_cursor;
    if part_corrected_start <> corrected_cursor + unchanged_length
      or substring(
        original_line_value from source_cursor + 1 for unchanged_length
      ) <> substring(
        corrected_line_value from corrected_cursor + 1 for unchanged_length
      )
      or substring(
        original_line_value
        from relative_source_start + 1
        for relative_source_end - relative_source_start
      ) <> part_item ->> 'from'
      or substring(
        corrected_line_value
        from part_corrected_start + 1
        for part_corrected_end - part_corrected_start
      ) <> part_item ->> 'to'
      or part_corrected_end
        <> part_corrected_start + char_length(part_item ->> 'to')
    then
      return false;
    end if;

    source_cursor := relative_source_end;
    corrected_cursor := part_corrected_end;
  end loop;

  unchanged_length := char_length(original_line_value) - source_cursor;
  return corrected_cursor + unchanged_length = char_length(corrected_line_value)
    and substring(original_line_value from source_cursor + 1)
      = substring(corrected_line_value from corrected_cursor + 1);
end;
$$;

revoke all on function app_private.feedback_change_spans_match(
  text,
  text,
  integer,
  jsonb
)
from public, anon, authenticated, service_role;

alter table public.submission_lines
  add column if not exists source_start integer,
  add column if not exists source_end integer;

alter table public.submission_lines
  drop constraint if exists submission_lines_source_offsets_check,
  add constraint submission_lines_source_offsets_check check (
    (source_start is null and source_end is null)
    or (
      source_start is not null
      and source_end is not null
      and source_start >= 0
      and source_end > source_start
      and source_end - source_start = char_length(original_line)
    )
  );

-- A conservative staging backfill only assigns offsets when the line text has
-- one unambiguous occurrence. New writes are required to supply exact offsets.
with located as (
  select
    line.id,
    strpos(submission.original_text, line.original_line) - 1 as source_start,
    strpos(submission.original_text, line.original_line) - 1
      + char_length(line.original_line) as source_end,
    strpos(submission.original_text, line.original_line) as first_position,
    strpos(
      substring(
        submission.original_text
        from strpos(submission.original_text, line.original_line)
          + char_length(line.original_line)
      ),
      line.original_line
    ) as later_position
  from public.submission_lines line
  join public.submissions submission on submission.id = line.submission_id
  where line.source_start is null
)
update public.submission_lines line
set source_start = located.source_start,
    source_end = located.source_end
from located
where located.id = line.id
  and located.first_position > 0
  and located.later_position = 0;

create or replace function app_private.validate_feedback_draft_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  submission_text text;
  line_item jsonb;
  normalized_lines jsonb := '[]'::jsonb;
  derived_topics jsonb := '[]'::jsonb;
  derived_score jsonb := '{}'::jsonb;
  corrected_reconstruction text := '';
  source_cursor integer := 0;
  line_ordinal integer;
  source_start_value integer;
  source_end_value integer;
  original_line_value text;
  corrected_line_value text;
  status_value text;
  topic_value text;
  canonical_topic text;
  changed_parts_value jsonb;
begin
  if jsonb_typeof(new.content) <> 'object'
    or jsonb_typeof(new.content -> 'lines') <> 'array'
    or jsonb_array_length(new.content -> 'lines') not between 1 and 120
    or coalesce(new.content ->> 'level_detected', '') not in ('A1', 'A2', 'B1', 'B2')
    or jsonb_typeof(new.content -> 'overall_summary') <> 'string'
    or btrim(coalesce(new.content ->> 'overall_summary', '')) = ''
    or jsonb_typeof(new.content -> 'corrected_text') <> 'string'
  then
    raise exception using errcode = '22023', message = 'Feedback draft structure is invalid.';
  end if;

  select submission.original_text
  into submission_text
  from public.submissions submission
  where submission.id = new.submission_id;

  if submission_text is null then
    raise exception using errcode = '02000', message = 'Submission not found.';
  end if;

  for line_item, line_ordinal in
    select element.item, element.ordinality::integer
    from jsonb_array_elements(new.content -> 'lines')
      with ordinality as element(item, ordinality)
    order by element.ordinality
  loop
    if jsonb_typeof(line_item) <> 'object'
      or jsonb_typeof(line_item -> 'source_start') <> 'number'
      or jsonb_typeof(line_item -> 'source_end') <> 'number'
      or coalesce(line_item ->> 'source_start', '') !~ '^[0-9]+$'
      or coalesce(line_item ->> 'source_end', '') !~ '^[0-9]+$'
      or coalesce(line_item ->> 'line_number', '') !~ '^[1-9][0-9]*$'
      or (line_item ->> 'line_number')::integer <> line_ordinal
      or jsonb_typeof(line_item -> 'original_line') <> 'string'
      or jsonb_typeof(line_item -> 'corrected_line') <> 'string'
      or coalesce(line_item ->> 'status', '') not in (
        'correct', 'acceptable_for_level', 'acceptable_a1_a2',
        'minor_issue', 'major_issue', 'unclear'
      )
      or jsonb_typeof(coalesce(line_item -> 'changed_parts', '[]'::jsonb)) <> 'array'
    then
      raise exception using errcode = '22023', message = 'Feedback line structure is invalid.';
    end if;

    source_start_value := (line_item ->> 'source_start')::integer;
    source_end_value := (line_item ->> 'source_end')::integer;
    original_line_value := line_item ->> 'original_line';
    corrected_line_value := line_item ->> 'corrected_line';
    status_value := line_item ->> 'status';
    topic_value := btrim(coalesce(line_item ->> 'grammar_topic', ''));
    canonical_topic := app_private.canonical_grammar_topic_slug(topic_value);
    changed_parts_value := coalesce(line_item -> 'changed_parts', '[]'::jsonb);

    if source_start_value < source_cursor
      or source_end_value <= source_start_value
      or source_end_value > char_length(submission_text)
      or source_end_value - source_start_value <> char_length(original_line_value)
      or substring(
        submission_text from source_cursor + 1
        for source_start_value - source_cursor
      ) ~ '[^[:space:]]'
      or substring(
        submission_text from source_start_value + 1
        for source_end_value - source_start_value
      ) <> original_line_value
      or btrim(corrected_line_value) = ''
    then
      raise exception using errcode = '22023', message = 'Feedback line source offsets do not match the submission.';
    end if;

    if status_value in ('correct', 'acceptable_for_level', 'acceptable_a1_a2') and (
      corrected_line_value <> original_line_value
      or jsonb_array_length(changed_parts_value) <> 0
      or topic_value <> ''
    ) then
      raise exception using errcode = '22023', message = 'Positive feedback cannot rewrite or assign a weakness.';
    end if;

    if topic_value <> '' and canonical_topic is null then
      raise exception using errcode = '22023', message = 'Feedback topic is outside the closed topic set.';
    end if;

    if status_value not in ('correct', 'acceptable_for_level', 'acceptable_a1_a2')
      and btrim(coalesce(line_item ->> 'short_explanation', '')) = ''
      and btrim(coalesce(line_item ->> 'detailed_explanation', '')) = ''
    then
      raise exception using errcode = '22023', message = 'Non-positive feedback requires an explanation.';
    end if;

    if status_value in ('minor_issue', 'major_issue') and (
      canonical_topic is null
      or corrected_line_value = original_line_value
      or jsonb_array_length(changed_parts_value) = 0
      or btrim(coalesce(line_item ->> 'short_explanation', '')) = ''
        and btrim(coalesce(line_item ->> 'detailed_explanation', '')) = ''
    ) then
      raise exception using errcode = '22023', message = 'Issue feedback requires a correction, explanation, and mapped topic.';
    end if;

    if jsonb_array_length(changed_parts_value) > 20 or exists (
      select 1
      from jsonb_array_elements(changed_parts_value) part(item)
      where jsonb_typeof(part.item) <> 'object'
        or jsonb_typeof(part.item -> 'from') <> 'string'
        or jsonb_typeof(part.item -> 'to') <> 'string'
        or btrim(coalesce(part.item ->> 'reason', '')) = ''
        or jsonb_typeof(part.item -> 'source_start') <> 'number'
        or jsonb_typeof(part.item -> 'source_end') <> 'number'
        or jsonb_typeof(part.item -> 'corrected_start') <> 'number'
        or jsonb_typeof(part.item -> 'corrected_end') <> 'number'
        or coalesce(part.item ->> 'source_start', '') !~ '^[0-9]+$'
        or coalesce(part.item ->> 'source_end', '') !~ '^[0-9]+$'
        or coalesce(part.item ->> 'corrected_start', '') !~ '^[0-9]+$'
        or coalesce(part.item ->> 'corrected_end', '') !~ '^[0-9]+$'
        or coalesce(part.item ->> 'from', '') = ''
          and coalesce(part.item ->> 'to', '') = ''
    ) then
      raise exception using errcode = '22023', message = 'Feedback correction spans are invalid.';
    end if;

    if exists (
      with parts as (
        select
          part.item,
          part.ordinality,
          (part.item ->> 'source_start')::integer as part_source_start,
          (part.item ->> 'source_end')::integer as part_source_end,
          (part.item ->> 'corrected_start')::integer as part_corrected_start,
          (part.item ->> 'corrected_end')::integer as part_corrected_end,
          lag((part.item ->> 'source_end')::integer)
            over (order by part.ordinality) as prior_source_end,
          lag((part.item ->> 'corrected_end')::integer)
            over (order by part.ordinality) as prior_corrected_end
        from jsonb_array_elements(changed_parts_value)
          with ordinality as part(item, ordinality)
      )
      select 1
      from parts
      where part_source_start < source_start_value
        or part_source_end < part_source_start
        or part_source_end > source_end_value
        or part_corrected_start < 0
        or part_corrected_end < part_corrected_start
        or part_corrected_end > char_length(corrected_line_value)
        or part_source_start < coalesce(prior_source_end, source_start_value)
        or part_corrected_start < coalesce(prior_corrected_end, 0)
        or substring(
          submission_text from part_source_start + 1
          for part_source_end - part_source_start
        ) <> item ->> 'from'
        or substring(
          corrected_line_value from part_corrected_start + 1
          for part_corrected_end - part_corrected_start
        ) <> item ->> 'to'
    ) then
      raise exception using errcode = '22023', message = 'Feedback correction spans do not match their source text.';
    end if;

    if not app_private.feedback_change_spans_match(
      original_line_value,
      corrected_line_value,
      source_start_value,
      changed_parts_value
    ) then
      raise exception using errcode = '22023', message = 'Feedback correction spans do not describe the complete edit.';
    end if;

    corrected_reconstruction := corrected_reconstruction
      || substring(
        submission_text from source_cursor + 1
        for source_start_value - source_cursor
      )
      || corrected_line_value;
    source_cursor := source_end_value;

    normalized_lines := normalized_lines || jsonb_build_array(
      jsonb_set(line_item, '{grammar_topic}', to_jsonb(coalesce(canonical_topic, '')))
    );
  end loop;

  corrected_reconstruction := corrected_reconstruction
    || substring(submission_text from source_cursor + 1);
  if substring(submission_text from source_cursor + 1) ~ '[^[:space:]]' then
    raise exception using errcode = '22023', message = 'Feedback lines do not cover the complete submission.';
  end if;
  if corrected_reconstruction <> coalesce(new.content ->> 'corrected_text', '') then
    raise exception using errcode = '22023', message = 'Corrected text does not preserve source separators.';
  end if;

  select coalesce(jsonb_agg(summary.topic_json order by summary.topic_slug), '[]'::jsonb)
  into derived_topics
  from (
    select
      issue.topic_slug,
      jsonb_build_object(
        'topic', issue.topic_slug,
        'count', count(*)::integer,
        'severity', case
          when bool_or(issue.status = 'minor_issue')
            and bool_or(issue.status = 'major_issue') then 'mixed'
          when bool_or(issue.status = 'major_issue') then 'major'
          else 'minor'
        end,
        'simple_explanation', coalesce(
          max(nullif(issue.short_explanation, '')),
          max(nullif(issue.detailed_explanation, '')),
          ''
        )
      ) as topic_json
    from (
      select
        item ->> 'grammar_topic' as topic_slug,
        item ->> 'status' as status,
        item ->> 'short_explanation' as short_explanation,
        item ->> 'detailed_explanation' as detailed_explanation
      from jsonb_array_elements(normalized_lines) item
      where item ->> 'status' in ('minor_issue', 'major_issue')
    ) issue
    group by issue.topic_slug
  ) summary;

  select jsonb_build_object(
    'correct_lines', count(*) filter (where item ->> 'status' = 'correct')::integer,
    'acceptable_lines', count(*) filter (
      where item ->> 'status' in ('acceptable_for_level', 'acceptable_a1_a2')
    )::integer,
    'minor_issues', count(*) filter (where item ->> 'status' = 'minor_issue')::integer,
    'major_issues', count(*) filter (where item ->> 'status' = 'major_issue')::integer,
    'needs_review', count(*) filter (where item ->> 'status' = 'unclear')::integer
  )
  into derived_score
  from jsonb_array_elements(normalized_lines) item;

  new.content := jsonb_set(
    jsonb_set(
      jsonb_set(new.content, '{lines}', normalized_lines, true),
      '{grammar_topics}',
      derived_topics,
      true
    ),
    '{score_summary}',
    derived_score,
    true
  );
  return new;
end;
$$;

revoke all on function app_private.validate_feedback_draft_content()
from public, anon, authenticated, service_role;

drop trigger if exists feedback_drafts_validate_content
on app_private.feedback_drafts;
create trigger feedback_drafts_validate_content
before insert or update of content on app_private.feedback_drafts
for each row execute function app_private.validate_feedback_draft_content();

-- Do not guess offsets for unreleased drafts created before this contract. They
-- remain available to the teacher, but must be regenerated/reviewed instead of
-- failing halfway through materialization or exposing ambiguous repeated text.
with legacy_drafts as (
  select distinct draft.id, draft.submission_id
  from app_private.feedback_drafts draft
  cross join lateral jsonb_array_elements(
    coalesce(draft.content -> 'lines', '[]'::jsonb)
  ) line_item
  where draft.state in ('draft', 'approved')
    and (
      coalesce(jsonb_typeof(line_item -> 'source_start') <> 'number', true)
      or coalesce(jsonb_typeof(line_item -> 'source_end') <> 'number', true)
    )
)
update app_private.feedback_drafts draft
set state = 'needs_review'
from legacy_drafts legacy
where draft.id = legacy.id;

update public.submissions submission
set status = 'needs_review',
    evaluation_status = 'needs_review',
    release_status = 'held',
    release_at = null,
    feedback_error = 'feedback_contract_upgrade_required'
where exists (
  select 1
  from app_private.feedback_drafts draft
  where draft.submission_id = submission.id
    and draft.state = 'needs_review'
    and exists (
      select 1
      from jsonb_array_elements(coalesce(draft.content -> 'lines', '[]'::jsonb)) line_item
      where coalesce(jsonb_typeof(line_item -> 'source_start') <> 'number', true)
        or coalesce(jsonb_typeof(line_item -> 'source_end') <> 'number', true)
    )
);

create or replace function app_private.validate_submission_line_fidelity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  submission_text text;
  topic_slug text;
begin
  if new.source_start is null or new.source_end is null then
    select
      (line_item ->> 'source_start')::integer,
      (line_item ->> 'source_end')::integer
    into new.source_start, new.source_end
    from app_private.feedback_drafts draft
    cross join lateral jsonb_array_elements(draft.content -> 'lines') line_item
    where draft.submission_id = new.submission_id
      and draft.state in ('draft', 'approved')
      and (line_item ->> 'line_number')::integer = new.line_number
    order by draft.version desc
    limit 1;
  end if;

  select submission.original_text
  into submission_text
  from public.submissions submission
  where submission.id = new.submission_id;

  select app_private.canonical_grammar_topic_slug(topic.slug)
  into topic_slug
  from public.grammar_topics topic
  where topic.id = new.grammar_topic_id;

  if submission_text is null
    or new.source_start is null
    or new.source_end is null
    or new.source_start < 0
    or new.source_end <= new.source_start
    or new.source_end > char_length(submission_text)
    or substring(
      submission_text from new.source_start + 1
      for new.source_end - new.source_start
    ) <> new.original_line
  then
    raise exception using errcode = '22023', message = 'Submission line offsets do not match the original writing.';
  end if;

  if exists (
    select 1
    from public.submission_lines existing
    where existing.submission_id = new.submission_id
      and existing.id <> new.id
      and existing.source_start is not null
      and existing.source_end is not null
      and int4range(existing.source_start, existing.source_end, '[)')
        && int4range(new.source_start, new.source_end, '[)')
  ) then
    raise exception using errcode = '22023', message = 'Submission line offsets overlap.';
  end if;

  if new.status in ('correct', 'acceptable_for_level', 'acceptable_a1_a2') and (
    new.corrected_line <> new.original_line
    or jsonb_array_length(new.changed_parts) <> 0
    or new.grammar_topic_id is not null
  ) then
    raise exception using errcode = '22023', message = 'Positive feedback cannot rewrite or assign a weakness.';
  end if;

  if new.status in ('minor_issue', 'major_issue') and (
    new.corrected_line = new.original_line
    or topic_slug is null
    or btrim(coalesce(new.short_explanation, '')) = ''
      and btrim(coalesce(new.detailed_explanation, '')) = ''
    or jsonb_typeof(new.changed_parts) <> 'array'
    or jsonb_array_length(new.changed_parts) = 0
  ) then
    raise exception using errcode = '22023', message = 'Issue feedback requires a correction, explanation, and mapped topic.';
  end if;

  if new.grammar_topic_id is not null and topic_slug is null then
    raise exception using errcode = '22023', message = 'Submission line topic is outside the closed topic set.';
  end if;

  if jsonb_typeof(new.changed_parts) <> 'array'
    or jsonb_array_length(new.changed_parts) > 20
    or exists (
      select 1
      from jsonb_array_elements(new.changed_parts) part(item)
      where jsonb_typeof(part.item) <> 'object'
        or jsonb_typeof(part.item -> 'from') <> 'string'
        or jsonb_typeof(part.item -> 'to') <> 'string'
        or btrim(coalesce(part.item ->> 'reason', '')) = ''
        or coalesce(part.item ->> 'source_start', '') !~ '^[0-9]+$'
        or coalesce(part.item ->> 'source_end', '') !~ '^[0-9]+$'
        or coalesce(part.item ->> 'corrected_start', '') !~ '^[0-9]+$'
        or coalesce(part.item ->> 'corrected_end', '') !~ '^[0-9]+$'
    )
  then
    raise exception using errcode = '22023', message = 'Submission correction spans are invalid.';
  end if;

  if exists (
    with parts as (
      select
        part.item,
        part.ordinality,
        (part.item ->> 'source_start')::integer as part_source_start,
        (part.item ->> 'source_end')::integer as part_source_end,
        (part.item ->> 'corrected_start')::integer as part_corrected_start,
        (part.item ->> 'corrected_end')::integer as part_corrected_end,
        lag((part.item ->> 'source_end')::integer)
          over (order by part.ordinality) as prior_source_end,
        lag((part.item ->> 'corrected_end')::integer)
          over (order by part.ordinality) as prior_corrected_end
      from jsonb_array_elements(new.changed_parts)
        with ordinality as part(item, ordinality)
    )
    select 1
    from parts
    where part_source_start < new.source_start
      or part_source_end < part_source_start
      or part_source_end > new.source_end
      or part_corrected_start < 0
      or part_corrected_end < part_corrected_start
      or part_corrected_end > char_length(new.corrected_line)
      or part_source_start < coalesce(prior_source_end, new.source_start)
      or part_corrected_start < coalesce(prior_corrected_end, 0)
      or substring(
        submission_text from part_source_start + 1
        for part_source_end - part_source_start
      ) <> item ->> 'from'
      or substring(
        new.corrected_line from part_corrected_start + 1
        for part_corrected_end - part_corrected_start
      ) <> item ->> 'to'
  ) then
    raise exception using errcode = '22023', message = 'Submission correction spans do not match their text.';
  end if;

  if not app_private.feedback_change_spans_match(
    new.original_line,
    new.corrected_line,
    new.source_start,
    new.changed_parts
  ) then
    raise exception using errcode = '22023', message = 'Submission correction spans do not describe the complete edit.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.validate_submission_line_fidelity()
from public, anon, authenticated, service_role;

drop trigger if exists submission_lines_validate_fidelity
on public.submission_lines;
create trigger submission_lines_validate_fidelity
before insert or update on public.submission_lines
for each row execute function app_private.validate_submission_line_fidelity();

create or replace view api.submission_lines
with (security_invoker = true, security_barrier = true)
as
select
  line.id,
  line.submission_id,
  line.line_number,
  line.original_line,
  line.corrected_line,
  line.status,
  line.grammar_topic_id,
  line.short_explanation,
  line.detailed_explanation,
  line.changed_parts,
  line.created_at,
  line.source_start,
  line.source_end
from public.submission_lines line
join public.submissions submission on submission.id = line.submission_id
where
  submission.release_status = 'released'
  or public.has_workspace_role(submission.workspace_id, array['owner', 'teacher']);

revoke all on table api.submission_lines from public, anon;
grant select on table api.submission_lines to authenticated;
