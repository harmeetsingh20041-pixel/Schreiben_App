-- Phase 13U: issue-level writing topics and severities.
--
-- Feedback contract v2 makes each correction span the authoritative weakness
-- unit. A sentence can therefore contribute several topics, and several
-- independent errors for one topic are counted independently. The legacy
-- line-level grammar_topic remains as a compatibility projection only.
-- Deploy this migration before the matching Edge Functions and frontend. The
-- database must understand feedback contract v2 before either writer emits it.

create or replace function app_private.writing_feedback_content_requires_review(
  content jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  line_item jsonb;
  part_item jsonb;
begin
  if content is null
    or jsonb_typeof(content) <> 'object'
    or jsonb_typeof(content -> 'lines') <> 'array'
  then
    return true;
  end if;

  for line_item in
    select element.item
    from jsonb_array_elements(content -> 'lines') as element(item)
  loop
    if line_item ->> 'status' = 'unclear' then
      return true;
    end if;

    if content ->> 'feedback_contract_version' = '2'
      and line_item ->> 'status' in ('minor_issue', 'major_issue')
    then
      if coalesce(line_item ->> 'corrected_line', '') =
          coalesce(line_item ->> 'original_line', '')
        or btrim(coalesce(line_item ->> 'short_explanation', '')) = ''
        or jsonb_typeof(line_item -> 'changed_parts') <> 'array'
        or jsonb_array_length(line_item -> 'changed_parts') = 0
      then
        return true;
      end if;

      for part_item in
        select element.item
        from jsonb_array_elements(line_item -> 'changed_parts') as element(item)
      loop
        if jsonb_typeof(part_item) <> 'object'
          or btrim(coalesce(part_item ->> 'reason', '')) = ''
          or jsonb_typeof(part_item -> 'grammar_topics') <> 'array'
          or jsonb_array_length(part_item -> 'grammar_topics') not between 1 and 6
          or coalesce(part_item ->> 'severity', '') not in ('minor', 'major')
        then
          return true;
        end if;
      end loop;
    end if;
  end loop;

  return false;
exception
  when others then
    -- Malformed content is never considered release-ready. The structural
    -- trigger below still rejects it instead of silently persisting it.
    return true;
end;
$$;

revoke all on function app_private.writing_feedback_content_requires_review(jsonb)
from public, anon, authenticated, service_role;

create or replace function app_private.assert_private_feedback_draft_text_limits(
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
          or char_length(coalesce(changed_part ->> 'reason', '')) > 4000
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

revoke all on function app_private.assert_private_feedback_draft_text_limits(jsonb)
from public, anon, authenticated, service_role;

create or replace function app_private.validate_feedback_draft_size()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'needs_review'
    and new.content ->> 'feedback_contract_version' = '2'
  then
    perform app_private.assert_private_feedback_draft_text_limits(new.content);
  else
    perform app_private.assert_feedback_completion_text_limits(new.content);
  end if;
  return new;
end;
$$;

revoke all on function app_private.validate_feedback_draft_size()
from public, anon, authenticated, service_role;

create or replace function app_private.prepare_writing_issue_span_topics()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  line_item jsonb;
  part_item jsonb;
  normalized_lines jsonb := '[]'::jsonb;
  normalized_parts jsonb;
  canonical_topics jsonb;
  line_topics jsonb;
  status_value text;
  span_severity text;
  derived_status text;
  first_topic text;
  has_major boolean;
  private_draft boolean := new.state = 'needs_review';
  line_metadata_complete boolean;
  normalized_part jsonb;
begin
  if tg_op = 'UPDATE' then
    if old.content ->> 'feedback_contract_version' = '2'
      and new.content ->> 'feedback_contract_version' is distinct from '2'
    then
      raise exception using
        errcode = '22023',
        message = 'writing_feedback_contract_downgrade_forbidden';
    end if;
  end if;

  if not (new.content ? 'feedback_contract_version') then
    return new;
  end if;

  if jsonb_typeof(new.content -> 'feedback_contract_version') <> 'number'
    or new.content ->> 'feedback_contract_version' <> '2'
  then
    raise exception using
      errcode = '22023',
      message = 'writing_feedback_contract_version_unsupported';
  end if;

  if jsonb_typeof(new.content -> 'lines') <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'writing_feedback_v2_lines_invalid';
  end if;

  for line_item in
    select line_element.item
    from jsonb_array_elements(new.content -> 'lines')
      with ordinality as line_element(item, ordinality)
    order by line_element.ordinality
  loop
    status_value := coalesce(line_item ->> 'status', '');
    normalized_parts := '[]'::jsonb;
    line_topics := '[]'::jsonb;
    has_major := false;

    if jsonb_typeof(coalesce(line_item -> 'changed_parts', '[]'::jsonb)) <> 'array'
    then
      raise exception using
        errcode = '22023',
        message = 'writing_feedback_v2_spans_invalid';
    end if;

    if status_value in ('correct', 'acceptable_for_level', 'acceptable_a1_a2')
    then
      if jsonb_array_length(coalesce(line_item -> 'changed_parts', '[]'::jsonb)) <> 0
        or btrim(coalesce(line_item ->> 'grammar_topic', '')) <> ''
      then
        raise exception using
          errcode = '22023',
          message = 'writing_feedback_v2_positive_topic_forbidden';
      end if;
    elsif status_value = 'unclear' then
      if jsonb_array_length(coalesce(line_item -> 'changed_parts', '[]'::jsonb)) <> 0
        or btrim(coalesce(line_item ->> 'grammar_topic', '')) <> ''
      then
        raise exception using
          errcode = '22023',
          message = 'writing_feedback_v2_unclear_span_forbidden';
      end if;
    elsif status_value in ('minor_issue', 'major_issue') then
      line_metadata_complete := true;
      if jsonb_array_length(coalesce(line_item -> 'changed_parts', '[]'::jsonb)) = 0
      then
        line_metadata_complete := false;
        if not private_draft then
          raise exception using
            errcode = '22023',
            message = 'writing_feedback_v2_issue_span_required';
        end if;
      end if;

      for part_item in
        select part_element.item
        from jsonb_array_elements(line_item -> 'changed_parts')
          with ordinality as part_element(item, ordinality)
        order by part_element.ordinality
      loop
        if jsonb_typeof(part_item) <> 'object'
          or coalesce(jsonb_typeof(part_item -> 'reason'), '') <> 'string'
          or char_length(coalesce(part_item ->> 'reason', '')) > 4000
          or coalesce(jsonb_typeof(part_item -> 'grammar_topics'), '') <> 'array'
          or jsonb_array_length(part_item -> 'grammar_topics') > 6
          or exists (
            select 1
            from jsonb_array_elements(part_item -> 'grammar_topics')
              as topic_element(item)
            where jsonb_typeof(topic_element.item) <> 'string'
          )
          or coalesce(part_item ->> 'severity', '') not in ('', 'minor', 'major')
        then
          raise exception using
            errcode = '22023',
            message = 'writing_feedback_v2_span_metadata_invalid';
        end if;

        if btrim(coalesce(part_item ->> 'reason', '')) = ''
          or jsonb_array_length(part_item -> 'grammar_topics') = 0
          or coalesce(part_item ->> 'severity', '') not in ('minor', 'major')
        then
          line_metadata_complete := false;
          if not private_draft then
            raise exception using
              errcode = '22023',
              message = 'writing_feedback_v2_span_metadata_invalid';
          end if;
        end if;

        if exists (
          select 1
          from jsonb_array_elements_text(part_item -> 'grammar_topics')
            as topic_element(topic_value)
          where app_private.canonical_grammar_topic_slug(
            topic_element.topic_value
          ) is null
        ) then
          raise exception using
            errcode = '22023',
            message = 'writing_feedback_v2_span_topic_unmapped';
        end if;

        select coalesce(
          jsonb_agg(to_jsonb(topic_slug) order by topic_slug collate "C"),
          '[]'::jsonb
        )
        into canonical_topics
        from (
          select distinct
            app_private.canonical_grammar_topic_slug(
              topic_element.topic_value
            ) as topic_slug
          from jsonb_array_elements_text(part_item -> 'grammar_topics')
            as topic_element(topic_value)
        ) canonical;

        if jsonb_array_length(canonical_topics) = 0 and not private_draft then
          raise exception using
            errcode = '22023',
            message = 'writing_feedback_v2_span_topic_unmapped';
        end if;

        span_severity := nullif(part_item ->> 'severity', '');
        has_major := has_major or span_severity = 'major';
        line_topics := line_topics || canonical_topics;
        normalized_part := jsonb_set(
          part_item,
          '{grammar_topics}',
          canonical_topics,
          true
        );
        normalized_part := jsonb_set(
          normalized_part,
          '{severity}',
          coalesce(to_jsonb(span_severity), 'null'::jsonb),
          true
        );
        normalized_parts := normalized_parts || jsonb_build_array(normalized_part);
      end loop;

      if line_metadata_complete then
        derived_status := case when has_major then 'major_issue' else 'minor_issue' end;
        if status_value <> derived_status then
          raise exception using
            errcode = '22023',
            message = 'writing_feedback_v2_line_severity_contradiction';
        end if;
      end if;

      select topic_value
      into first_topic
      from (
        select distinct topic_element.value #>> '{}' as topic_value
        from jsonb_array_elements(line_topics) topic_element(value)
      ) topics
      order by topic_value collate "C"
      limit 1;

      line_item := jsonb_set(
        jsonb_set(line_item, '{changed_parts}', normalized_parts, true),
        '{grammar_topic}',
        to_jsonb(coalesce(first_topic, '')),
        true
      );
    else
      raise exception using
        errcode = '22023',
        message = 'writing_feedback_v2_status_invalid';
    end if;

    normalized_lines := normalized_lines || jsonb_build_array(line_item);
  end loop;

  new.content := jsonb_set(new.content, '{lines}', normalized_lines, true);
  return new;
end;
$$;

revoke all on function app_private.prepare_writing_issue_span_topics()
from public, anon, authenticated, service_role;

drop trigger if exists feedback_drafts_01_prepare_issue_span_topics
on app_private.feedback_drafts;
create trigger feedback_drafts_01_prepare_issue_span_topics
before insert or update of content on app_private.feedback_drafts
for each row execute function app_private.prepare_writing_issue_span_topics();

-- A teacher may save unfinished span classification only while the version is
-- private and explicitly held in needs_review. Exact source text, offsets, and
-- the complete corrected-text reconstruction remain mandatory even then.
create or replace function app_private.validate_private_feedback_draft_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  submission_text text;
  line_item jsonb;
  changed_parts_value jsonb;
  corrected_reconstruction text := '';
  source_cursor integer := 0;
  line_ordinal integer;
  source_start_value integer;
  source_end_value integer;
  original_line_value text;
  corrected_line_value text;
  status_value text;
begin
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

    if status_value in ('correct', 'acceptable_for_level', 'acceptable_a1_a2')
      and (
        corrected_line_value <> original_line_value
        or jsonb_array_length(changed_parts_value) <> 0
        or btrim(coalesce(line_item ->> 'grammar_topic', '')) <> ''
      )
    then
      raise exception using errcode = '22023', message = 'Positive feedback cannot rewrite or assign a weakness.';
    end if;

    if status_value = 'unclear' and corrected_line_value <> original_line_value then
      raise exception using errcode = '22023', message = 'Unclear feedback cannot persist a correction.';
    end if;

    if status_value in ('minor_issue', 'major_issue') and (
      corrected_line_value = original_line_value
        and jsonb_array_length(changed_parts_value) <> 0
      or corrected_line_value <> original_line_value
        and jsonb_array_length(changed_parts_value) = 0
    ) then
      raise exception using errcode = '22023', message = 'Private feedback correction spans are incomplete.';
    end if;

    if jsonb_array_length(changed_parts_value) > 20 or exists (
      select 1
      from jsonb_array_elements(changed_parts_value) part(item)
      where jsonb_typeof(part.item) <> 'object'
        or jsonb_typeof(part.item -> 'from') <> 'string'
        or jsonb_typeof(part.item -> 'to') <> 'string'
        or coalesce(jsonb_typeof(part.item -> 'reason'), '') <> 'string'
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
  end loop;

  corrected_reconstruction := corrected_reconstruction
    || substring(submission_text from source_cursor + 1);
  if substring(submission_text from source_cursor + 1) ~ '[^[:space:]]' then
    raise exception using errcode = '22023', message = 'Feedback lines do not cover the complete submission.';
  end if;
  if corrected_reconstruction <> coalesce(new.content ->> 'corrected_text', '') then
    raise exception using errcode = '22023', message = 'Corrected text does not preserve source separators.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.validate_private_feedback_draft_content()
from public, anon, authenticated, service_role;

drop trigger if exists feedback_drafts_validate_content
on app_private.feedback_drafts;
create trigger feedback_drafts_validate_content
before insert or update of content on app_private.feedback_drafts
for each row
when (
  new.state <> 'needs_review'
  or new.content ->> 'feedback_contract_version' is distinct from '2'
)
execute function app_private.validate_feedback_draft_content();

drop trigger if exists feedback_drafts_02_validate_private_content
on app_private.feedback_drafts;
create trigger feedback_drafts_02_validate_private_content
before insert or update of content on app_private.feedback_drafts
for each row
when (
  new.state = 'needs_review'
  and new.content ->> 'feedback_contract_version' = '2'
)
execute function app_private.validate_private_feedback_draft_content();

-- The teacher edit mutation owns the state transition. Incomplete contract-v2
-- metadata is saved as needs_review, which the release API already rejects.
create or replace function public.update_feedback_draft_internal(
  feedback_version_id uuid,
  content jsonb,
  expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  target_submission_id uuid;
  selected_submission public.submissions%rowtype;
  selected_draft app_private.feedback_drafts%rowtype;
  updated_draft app_private.feedback_drafts%rowtype;
  next_content jsonb := content;
  next_state text;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if feedback_version_id is null
    or content is null
    or jsonb_typeof(content) <> 'object'
    or expected_revision is null
    or expected_revision < 1
  then
    raise exception using errcode = '22023', message = 'Feedback edit is invalid.';
  end if;

  if pg_column_size(next_content) > 1048576 then
    raise exception using errcode = '22023', message = 'Feedback edit is too large.';
  end if;

  select draft.submission_id
  into target_submission_id
  from app_private.feedback_drafts draft
  where draft.id = feedback_version_id;

  if target_submission_id is null then
    raise exception using
      errcode = '42501',
      message = 'Feedback version not found or access denied.';
  end if;

  select submission.*
  into selected_submission
  from public.submissions submission
  where submission.id = target_submission_id
  for update;

  if selected_submission.id is null
    or not app_private.lock_feedback_teacher_membership(
      selected_submission.workspace_id,
      actor_id
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Feedback version not found or access denied.';
  end if;

  select draft.*
  into selected_draft
  from app_private.feedback_drafts draft
  where draft.id = feedback_version_id
    and draft.submission_id = selected_submission.id
  for update;

  if selected_draft.id is null then
    raise exception using
      errcode = '42501',
      message = 'Feedback version not found or access denied.';
  end if;

  if selected_draft.state not in ('draft', 'needs_review', 'approved') then
    raise exception using errcode = '55000', message = 'Feedback version is immutable.';
  end if;

  if selected_draft.revision <> expected_revision then
    raise exception using
      errcode = '40001',
      message = 'Feedback changed while you were editing. Refresh and try again.';
  end if;

  next_state := case
    when app_private.writing_feedback_content_requires_review(next_content)
      then 'needs_review'
    else 'draft'
  end;

  update app_private.feedback_drafts draft
  set
    content = next_content,
    state = next_state,
    revision = draft.revision + 1,
    approved_at = null,
    approved_by = null
  where draft.id = selected_draft.id
  returning draft.* into updated_draft;

  update public.submissions submission
  set
    status = case when next_state = 'needs_review' then 'needs_review' else 'checked' end,
    evaluation_status = case
      when next_state = 'needs_review' then 'needs_review'
      else 'ready'
    end,
    release_status = 'held',
    release_at = null,
    corrected_text = null,
    overall_summary = null,
    level_detected = null,
    checked_at = null,
    feedback_error = null
  where submission.id = selected_submission.id;

  insert into app_private.feedback_draft_events (
    feedback_draft_id,
    submission_id,
    actor_id,
    event_type,
    from_state,
    to_state,
    from_revision,
    to_revision,
    before_content,
    after_content
  ) values (
    selected_draft.id,
    selected_submission.id,
    actor_id,
    'teacher_edited',
    selected_draft.state,
    updated_draft.state,
    selected_draft.revision,
    updated_draft.revision,
    selected_draft.content,
    updated_draft.content
  );

  return jsonb_build_object(
    'schema_version', 1,
    'draft', jsonb_build_object(
      'id', updated_draft.id,
      'submission_id', updated_draft.submission_id,
      'version', updated_draft.version,
      'revision', updated_draft.revision,
      'state', updated_draft.state,
      'content', updated_draft.content,
      'provider_model', updated_draft.provider_model,
      'created_at', updated_draft.created_at,
      'updated_at', updated_draft.updated_at,
      'approved_at', updated_draft.approved_at,
      'released_at', updated_draft.released_at
    )
  );
end;
$$;

revoke all on function public.update_feedback_draft_internal(uuid, jsonb, integer)
from public, anon, service_role;
grant execute on function public.update_feedback_draft_internal(uuid, jsonb, integer)
to authenticated;

create or replace function app_private.require_release_ready_feedback_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.content ->> 'feedback_contract_version' = '2'
    and new.state in ('draft', 'approved', 'released')
    and app_private.writing_feedback_content_requires_review(new.content)
  then
    raise exception using
      errcode = '55000',
      message = 'writing_feedback_incomplete_private_draft';
  end if;
  return new;
end;
$$;

revoke all on function app_private.require_release_ready_feedback_state()
from public, anon, authenticated, service_role;

drop trigger if exists feedback_drafts_03_require_release_ready_state
on app_private.feedback_drafts;
create trigger feedback_drafts_03_require_release_ready_state
before insert or update on app_private.feedback_drafts
for each row execute function app_private.require_release_ready_feedback_state();

-- Phase 11A continues to validate exact source offsets and complete edits. It
-- also rebuilds legacy line summaries, so this later trigger restores the v2
-- issue-level summary before the independent release hash is checked.
create or replace function app_private.finalize_writing_issue_span_topics()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  derived_topics jsonb := '[]'::jsonb;
  derived_score jsonb := '{}'::jsonb;
begin
  if new.content ->> 'feedback_contract_version' is distinct from '2' then
    return new;
  end if;

  select coalesce(
    jsonb_agg(summary.topic_json order by summary.topic_slug collate "C"),
    '[]'::jsonb
  )
  into derived_topics
  from (
    select
      issue.topic_slug,
      jsonb_build_object(
        'topic', issue.topic_slug,
        'count', count(*)::integer,
        'minor_count', count(*) filter (
          where issue.span_severity = 'minor'
        )::integer,
        'major_count', count(*) filter (
          where issue.span_severity = 'major'
        )::integer,
        'severity', case
          when bool_or(issue.span_severity = 'minor')
            and bool_or(issue.span_severity = 'major') then 'mixed'
          when bool_or(issue.span_severity = 'major') then 'major'
          else 'minor'
        end,
        'simple_explanation', coalesce(
          (array_agg(
            issue.reason
            order by issue.line_ordinal, issue.part_ordinal
          ) filter (where btrim(issue.reason) <> ''))[1],
          ''
        )
      ) as topic_json
    from (
      select
        topic_value as topic_slug,
        part.item ->> 'severity' as span_severity,
        coalesce(part.item ->> 'reason', '') as reason,
        line.ordinality as line_ordinal,
        part.ordinality as part_ordinal
      from jsonb_array_elements(new.content -> 'lines')
        with ordinality as line(item, ordinality)
      cross join lateral jsonb_array_elements(line.item -> 'changed_parts')
        with ordinality as part(item, ordinality)
      cross join lateral jsonb_array_elements_text(part.item -> 'grammar_topics')
        topic(topic_value)
      where line.item ->> 'status' in ('minor_issue', 'major_issue')
    ) issue
    group by issue.topic_slug
  ) summary;

  if jsonb_array_length(derived_topics) > 36 then
    raise exception using
      errcode = '22023',
      message = 'writing_feedback_v2_topic_limit_exceeded';
  end if;

  select jsonb_build_object(
    'correct_lines', count(*) filter (
      where line_item ->> 'status' = 'correct'
    )::integer,
    'acceptable_lines', count(*) filter (
      where line_item ->> 'status' in (
        'acceptable_for_level', 'acceptable_a1_a2'
      )
    )::integer,
    'minor_issues', count(*) filter (
      where line_item ->> 'status' = 'minor_issue'
    )::integer,
    'major_issues', count(*) filter (
      where line_item ->> 'status' = 'major_issue'
    )::integer,
    'needs_review', count(*) filter (
      where line_item ->> 'status' = 'unclear'
    )::integer
  )
  into derived_score
  from jsonb_array_elements(new.content -> 'lines') line_item;

  new.content := jsonb_set(
    jsonb_set(
      new.content,
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

revoke all on function app_private.finalize_writing_issue_span_topics()
from public, anon, authenticated, service_role;

drop trigger if exists feedback_drafts_y_finalize_issue_span_topics
on app_private.feedback_drafts;
create trigger feedback_drafts_y_finalize_issue_span_topics
before insert or update of content on app_private.feedback_drafts
for each row execute function app_private.finalize_writing_issue_span_topics();

-- Released v2 feedback preserves exact minor/major occurrence counts in the
-- adaptive-practice evidence ledger. Legacy drafts retain their prior mapping.
create or replace function app_private.capture_released_practice_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state <> 'released' then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.state = 'released' then
    return new;
  end if;

  insert into app_private.practice_weakness_evidence (
    source_kind,
    source_release_id,
    feedback_draft_id,
    submission_id,
    workspace_id,
    student_id,
    grammar_topic_id,
    batch_id,
    evidence_level,
    writing_context_version,
    writing_context_sha256,
    minor_issue_count,
    major_issue_count,
    released_at
  )
  select
    'feedback_draft',
    new.id,
    new.id,
    submission.id,
    context.workspace_id,
    context.student_id,
    topic.grammar_topic_id,
    context.batch_id,
    context.cefr_level,
    context.context_version,
    context.context_sha256,
    case
      when new.content ->> 'feedback_contract_version' = '2'
        then coalesce((issue_summary.item ->> 'minor_count')::integer, 0)
      when topic.severity = 'minor' then topic.count
      else 0
    end,
    case
      when new.content ->> 'feedback_contract_version' = '2'
        then coalesce((issue_summary.item ->> 'major_count')::integer, 0)
      when topic.severity in ('major', 'mixed') then topic.count
      else 0
    end,
    coalesce(new.released_at, now())
  from app_private.writing_evaluation_contexts context
  join public.submissions submission
    on submission.id = context.submission_id
   and submission.workspace_id = context.workspace_id
   and submission.student_id = context.student_id
   and submission.batch_id = context.batch_id
  join public.submission_grammar_topics topic
    on topic.submission_id = submission.id
  join public.grammar_topics grammar_topic
    on grammar_topic.id = topic.grammar_topic_id
  left join lateral (
    select topic_item.item
    from jsonb_array_elements(
      case
        when jsonb_typeof(new.content -> 'grammar_topics') = 'array'
          then new.content -> 'grammar_topics'
        else '[]'::jsonb
      end
    ) topic_item(item)
    where app_private.canonical_grammar_topic_slug(
      topic_item.item ->> 'topic'
    ) = app_private.canonical_grammar_topic_slug(grammar_topic.slug)
    limit 1
  ) issue_summary on true
  where submission.id = new.submission_id
    and submission.release_status = 'released'
    and context.context_sha256 =
      app_private.writing_evaluation_context_sha256(
        context.submission_id,
        context.context_version,
        context.workspace_id,
        context.student_id,
        context.batch_id,
        context.cefr_level,
        context.source_type,
        context.source_id,
        context.submission_mode,
        context.question_metadata,
        context.original_text_sha256
      )
    and topic.count > 0
  on conflict (source_kind, source_release_id, grammar_topic_id) do nothing;

  return new;
end;
$$;

revoke all on function app_private.capture_released_practice_evidence()
from public, anon, authenticated, service_role;

comment on function app_private.prepare_writing_issue_span_topics() is
  'Normalizes and validates feedback contract v2 topics and severity on every correction span before exact-offset validation.';

comment on function app_private.finalize_writing_issue_span_topics() is
  'Derives contract v2 canonical weakness summaries from correction spans so a sentence can unlock multiple topics and repeated errors count separately.';
