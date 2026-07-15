-- V1 accepts a bounded A1-B2 writing size that can be evaluated in one
-- provider response. Keep the direct-submit and resumable-draft pathways on
-- the same Unicode-character and German-aware feedback-unit contract.

create or replace function app_private.assert_writing_input_contract(
  value text,
  allow_blank boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if value is null
    or (not coalesce(allow_blank, false) and value !~ '[^[:space:]]')
  then
    raise exception using errcode = '22023', message = 'writing_text_required';
  end if;
  if regexp_replace(value, E'[\t\n\r]', '', 'g') ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'writing_text_invalid';
  end if;
  if char_length(value) > 4000 then
    raise exception using errcode = '22023', message = 'writing_text_too_long';
  end if;
  if app_private.writing_feedback_unit_count(value) > 40 then
    raise exception using errcode = '22023', message = 'writing_too_many_units';
  end if;
end;
$$;

revoke all on function app_private.assert_writing_input_contract(text, boolean)
from public, anon, authenticated, service_role;

create or replace function app_private.assert_writing_draft_content(
  value text,
  allow_blank boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_writing_input_contract(value, allow_blank);
end;
$$;

revoke all on function app_private.assert_writing_draft_content(text, boolean)
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
  perform app_private.assert_writing_input_contract(answer_text, false);

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

comment on function app_private.assert_writing_input_contract(text, boolean) is
  'V1 writing bound shared by draft save and submission: 4,000 Unicode characters and 40 German-aware sentence/paragraph feedback units.';

-- Keep provider output, teacher edits, and durable completion on one bounded
-- contract. This runs before the deeper Phase 11A offset/semantic validator,
-- so a response that cannot fit the database never reaches completion.
create or replace function app_private.assert_feedback_completion_text_limits(
  content jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  feedback_lines jsonb;
  grammar_topics jsonb;
begin
  if content is null or jsonb_typeof(content) <> 'object' then
    raise exception using errcode = '22023', message = 'feedback_text_limits_invalid';
  end if;

  feedback_lines := content -> 'lines';
  grammar_topics := content -> 'grammar_topics';
  if jsonb_typeof(feedback_lines) <> 'array'
    or jsonb_array_length(feedback_lines) not between 1 and 40
    or jsonb_typeof(grammar_topics) <> 'array'
    or jsonb_array_length(grammar_topics) > 30
    or char_length(coalesce(content ->> 'overall_summary', '')) not between 1 and 8000
    or char_length(coalesce(content ->> 'corrected_text', '')) not between 1 and 4000
  then
    raise exception using errcode = '22023', message = 'feedback_text_limits_invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(feedback_lines) line_item
    where jsonb_typeof(line_item) <> 'object'
      or char_length(coalesce(line_item ->> 'original_line', '')) > 4000
      or char_length(coalesce(line_item ->> 'corrected_line', '')) > 4000
      or char_length(coalesce(line_item ->> 'short_explanation', '')) > 4000
      or char_length(coalesce(line_item ->> 'detailed_explanation', '')) > 8000
      or (
        line_item ->> 'status' in ('minor_issue', 'major_issue')
        and btrim(coalesce(line_item ->> 'short_explanation', '')) = ''
      )
      or jsonb_typeof(coalesce(line_item -> 'changed_parts', '[]'::jsonb)) <> 'array'
      or exists (
        select 1
        from jsonb_array_elements(
          case
            when jsonb_typeof(line_item -> 'changed_parts') = 'array'
              then line_item -> 'changed_parts'
            else '[]'::jsonb
          end
        ) changed_part
        where jsonb_typeof(changed_part) <> 'object'
          or char_length(coalesce(changed_part ->> 'from', '')) > 4000
          or char_length(coalesce(changed_part ->> 'to', '')) > 4000
          or char_length(coalesce(changed_part ->> 'reason', '')) > 8000
      )
  ) then
    raise exception using errcode = '22023', message = 'feedback_text_limits_invalid';
  end if;

  if (
    select coalesce(sum(char_length(coalesce(line_item ->> 'corrected_line', ''))), 0)
    from jsonb_array_elements(feedback_lines) line_item
  ) > 4000
    or exists (
      select 1
      from jsonb_array_elements(grammar_topics) topic_item
      where jsonb_typeof(topic_item) <> 'object'
        or char_length(coalesce(topic_item ->> 'simple_explanation', '')) > 4000
    )
  then
    raise exception using errcode = '22023', message = 'feedback_text_limits_invalid';
  end if;
end;
$$;

revoke all on function app_private.assert_feedback_completion_text_limits(jsonb)
from public, anon, authenticated, service_role;

create or replace function app_private.validate_feedback_draft_size()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.assert_feedback_completion_text_limits(new.content);
  return new;
end;
$$;

revoke all on function app_private.validate_feedback_draft_size()
from public, anon, authenticated, service_role;

drop trigger if exists feedback_drafts_00_validate_size
on app_private.feedback_drafts;
create trigger feedback_drafts_00_validate_size
before insert or update of content on app_private.feedback_drafts
for each row execute function app_private.validate_feedback_draft_size();

comment on function app_private.assert_feedback_completion_text_limits(jsonb) is
  'V1 database-aligned feedback cap: 40 lines, 4,000-character corrected writing and short explanations, and 8,000-character summary/detail fields.';
