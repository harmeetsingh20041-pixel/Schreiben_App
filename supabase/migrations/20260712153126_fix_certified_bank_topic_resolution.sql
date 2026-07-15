-- Canonical worksheet-bank imports treat the closed slug as the topic
-- identity. The human-readable name is presentation metadata and may be
-- localized without changing the selected topic. A supplied unknown slug never
-- falls back to a coincidentally matching display name.
create or replace function app_private.resolve_worksheet_bank_topic_id(
  requested_slug text,
  requested_name text,
  worksheet_level text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_slug text := nullif(btrim(requested_slug), '');
  normalized_name text := nullif(btrim(requested_name), '');
  selected_topic_id uuid;
begin
  if worksheet_level is null
    or worksheet_level not in ('A1', 'A2', 'B1', 'B2')
  then
    return null;
  end if;

  if normalized_slug is not null then
    select topic.id
    into selected_topic_id
    from public.grammar_topics topic
    join app_private.grammar_topic_contracts contract
      on contract.slug = topic.slug
    where contract.slug = lower(normalized_slug)
      and topic.level in (worksheet_level, 'A1_A2')
    order by
      case when topic.level = worksheet_level then 0 else 1 end,
      topic.created_at,
      topic.id
    limit 1;

    return selected_topic_id;
  end if;

  if normalized_name is null then
    return null;
  end if;

  select topic.id
  into selected_topic_id
  from public.grammar_topics topic
  join app_private.grammar_topic_contracts contract
    on contract.slug = topic.slug
  where lower(topic.name) = lower(normalized_name)
    and topic.level in (worksheet_level, 'A1_A2')
  order by
    case when topic.level = worksheet_level then 0 else 1 end,
    topic.created_at,
    topic.id
  limit 1;

  return selected_topic_id;
end;
$$;

revoke all on function app_private.resolve_worksheet_bank_topic_id(
  text, text, text
)
from public, anon, authenticated, service_role;

comment on function app_private.resolve_worksheet_bank_topic_id(
  text, text, text
) is
  'Resolves a certified worksheet topic from the closed canonical slug set. A supplied canonical slug is authoritative; display names are used only for legacy name-only payloads.';

create or replace function app_private.publish_certified_worksheet_template(
  target_template_key text,
  worksheet jsonb,
  target_reviewer_id uuid,
  target_releaser_id uuid,
  review_checklist jsonb,
  review_notes text,
  release_notes text
)
returns table (
  template_id uuid,
  revision_id uuid,
  review_id uuid,
  release_id uuid,
  content_sha256 text,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_topic_id uuid;
  selected_template app_private.practice_worksheet_templates%rowtype;
  selected_revision app_private.practice_worksheet_template_revisions%rowtype;
  selected_review app_private.practice_worksheet_template_reviews%rowtype;
  selected_release app_private.practice_worksheet_template_releases%rowtype;
  requested_slug text := nullif(worksheet #>> '{grammar_topic,slug}', '');
  requested_name text := nullif(worksheet #>> '{grammar_topic,name}', '');
  import_hash text;
  expected_content_hash text;
  actual_content_hash text;
  next_revision integer;
  question_count integer;
  open_question_count integer;
begin
  if target_template_key is null
    or target_template_key !~ '^[a-z0-9][a-z0-9._-]{5,119}$'
    or worksheet is null
    or jsonb_typeof(worksheet) <> 'object'
    or coalesce(worksheet ->> 'level', '') not in ('A1', 'A2', 'B1', 'B2')
    or coalesce(worksheet ->> 'difficulty', '') not in ('easy', 'medium', 'hard')
    or length(btrim(coalesce(worksheet ->> 'title', ''))) not between 1 and 120
    or jsonb_typeof(worksheet -> 'mini_lesson') <> 'object'
    or jsonb_typeof(worksheet -> 'questions') <> 'array'
    or not app_private.worksheet_review_checklist_is_complete(review_checklist)
    or length(btrim(coalesce(review_notes, ''))) not between 8 and 1000
    or length(btrim(coalesce(release_notes, ''))) not between 8 and 1000
  then
    raise exception using errcode = '22023', message = 'worksheet_bank_publish_invalid';
  end if;

  if not app_private.worksheet_template_payload_is_structurally_valid(worksheet) then
    raise exception using errcode = '22023', message = 'worksheet_bank_payload_invalid';
  end if;

  question_count := jsonb_array_length(worksheet -> 'questions');
  select count(*) filter (
    where question.item ->> 'evaluation_mode' = 'open_evaluation'
  )::integer
  into open_question_count
  from jsonb_array_elements(worksheet -> 'questions') question(item);

  if question_count not between 2 and 20 or open_question_count > 3 then
    raise exception using errcode = '22023', message = 'worksheet_bank_question_count_invalid';
  end if;

  perform 1
  from app_private.practice_worksheet_bank_reviewers reviewer
  where reviewer.user_id = target_reviewer_id
    and reviewer.active
    and reviewer.can_certify
    and reviewer.verified_at <= now()
    and (reviewer.expires_at is null or reviewer.expires_at > now())
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'worksheet_bank_reviewer_not_qualified';
  end if;

  perform 1
  from app_private.practice_worksheet_bank_reviewers releaser
  where releaser.user_id = target_releaser_id
    and releaser.active
    and releaser.can_release
    and releaser.verified_at <= now()
    and (releaser.expires_at is null or releaser.expires_at > now())
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'worksheet_bank_releaser_not_qualified';
  end if;

  selected_topic_id := app_private.resolve_worksheet_bank_topic_id(
    requested_slug,
    requested_name,
    worksheet ->> 'level'
  );

  if selected_topic_id is null then
    raise exception using errcode = 'P0002', message = 'worksheet_bank_topic_not_found';
  end if;

  expected_content_hash := app_private.practice_worksheet_template_payload_sha256(
    selected_topic_id,
    worksheet
  );
  import_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(worksheet::text, 'UTF8')),
    'hex'
  );

  if expected_content_hash is null then
    raise exception using errcode = '55000', message = 'worksheet_bank_hash_failed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat('worksheet-bank:', target_template_key),
    0
  ));

  select template.*
  into selected_template
  from app_private.practice_worksheet_templates template
  where template.template_key = target_template_key
  for update;

  if selected_template.id is null then
    insert into app_private.practice_worksheet_templates (
      template_key,
      grammar_topic_id,
      level,
      created_by
    ) values (
      target_template_key,
      selected_topic_id,
      worksheet ->> 'level',
      target_reviewer_id
    )
    returning * into selected_template;
  elsif selected_template.grammar_topic_id <> selected_topic_id
    or selected_template.level <> worksheet ->> 'level'
  then
    raise exception using errcode = '55000', message = 'worksheet_bank_template_context_changed';
  end if;

  select revision.*
  into selected_revision
  from app_private.practice_worksheet_template_revisions revision
  where revision.template_id = selected_template.id
    and revision.content_sha256 = expected_content_hash
  limit 1;

  if selected_revision.id is not null then
    select review.* into selected_review
    from app_private.practice_worksheet_template_reviews review
    where review.revision_id = selected_revision.id
      and review.decision = 'approved';

    select release.* into selected_release
    from app_private.practice_worksheet_template_releases release
    where release.revision_id = selected_revision.id
      and release.review_id = selected_review.id;

    actual_content_hash := app_private.practice_worksheet_template_revision_sha256(
      selected_revision.id
    );
    if selected_revision.state <> 'released'
      or selected_review.id is null
      or selected_release.id is null
      or actual_content_hash is distinct from selected_revision.content_sha256
      or selected_review.content_sha256 is distinct from selected_revision.content_sha256
      or selected_release.content_sha256 is distinct from selected_revision.content_sha256
      or not exists (
        select 1
        from app_private.practice_worksheet_bank_reviewers reviewer
        where reviewer.user_id = selected_review.reviewer_id
          and reviewer.active
          and reviewer.can_certify
          and reviewer.verified_at <= selected_review.reviewed_at
          and (
            reviewer.expires_at is null
            or reviewer.expires_at > selected_review.reviewed_at
          )
      )
      or not exists (
        select 1
        from app_private.practice_worksheet_bank_reviewers releaser
        where releaser.user_id = selected_release.released_by
          and releaser.active
          and releaser.can_release
          and releaser.verified_at <= selected_release.released_at
          and (
            releaser.expires_at is null
            or releaser.expires_at > selected_release.released_at
          )
      )
    then
      raise exception using errcode = '55000', message = 'worksheet_bank_existing_revision_invalid';
    end if;

    return query select
      selected_template.id,
      selected_revision.id,
      selected_review.id,
      selected_release.id,
      selected_revision.content_sha256,
      false;
    return;
  end if;

  select coalesce(max(revision.revision_number), 0) + 1
  into next_revision
  from app_private.practice_worksheet_template_revisions revision
  where revision.template_id = selected_template.id;

  insert into app_private.practice_worksheet_template_revisions (
    template_id,
    revision_number,
    difficulty,
    title,
    description,
    mini_lesson,
    source_label,
    tags,
    import_payload_sha256,
    content_sha256,
    created_by
  ) values (
    selected_template.id,
    next_revision,
    worksheet ->> 'difficulty',
    btrim(worksheet ->> 'title'),
    coalesce(
      nullif(btrim(worksheet ->> 'description'), ''),
      btrim(worksheet #>> '{mini_lesson,short_explanation}')
    ),
    worksheet -> 'mini_lesson',
    nullif(btrim(worksheet ->> 'source_label'), ''),
    coalesce(worksheet -> 'tags', '[]'::jsonb),
    import_hash,
    expected_content_hash,
    target_reviewer_id
  )
  returning * into selected_revision;

  insert into app_private.practice_worksheet_template_questions (
    revision_id,
    question_number,
    question_type,
    evaluation_mode,
    prompt,
    options,
    correct_answer,
    accepted_answers,
    rubric,
    answer_contract_version,
    explanation
  )
  select
    selected_revision.id,
    (question.item ->> 'question_number')::integer,
    question.item ->> 'question_type',
    question.item ->> 'evaluation_mode',
    btrim(question.item ->> 'prompt'),
    case
      when jsonb_typeof(question.item -> 'options') = 'array'
        and jsonb_array_length(question.item -> 'options') > 0
        then question.item -> 'options'
      else null
    end,
    btrim(question.item ->> 'correct_answer'),
    coalesce(question.item -> 'accepted_answers', '[]'::jsonb),
    nullif(question.item -> 'rubric', 'null'::jsonb),
    1,
    btrim(question.item ->> 'explanation')
  from jsonb_array_elements(worksheet -> 'questions') question(item)
  order by (question.item ->> 'question_number')::integer;

  actual_content_hash := app_private.practice_worksheet_template_revision_sha256(
    selected_revision.id
  );
  if actual_content_hash is distinct from expected_content_hash then
    raise exception using errcode = '55000', message = 'worksheet_bank_persisted_hash_mismatch';
  end if;

  perform set_config('app.worksheet_bank_attestation_insert', 'on', true);
  insert into app_private.practice_worksheet_template_reviews (
    revision_id,
    reviewer_id,
    decision,
    checklist,
    notes,
    content_sha256
  ) values (
    selected_revision.id,
    target_reviewer_id,
    'approved',
    review_checklist,
    btrim(review_notes),
    actual_content_hash
  ) returning * into selected_review;

  perform set_config('app.worksheet_bank_state_transition', 'on', true);
  update app_private.practice_worksheet_template_revisions revision
  set state = 'certified'
  where revision.id = selected_revision.id;

  insert into app_private.practice_worksheet_template_releases (
    revision_id,
    review_id,
    released_by,
    release_notes,
    content_sha256
  ) values (
    selected_revision.id,
    selected_review.id,
    target_releaser_id,
    btrim(release_notes),
    actual_content_hash
  ) returning * into selected_release;

  update app_private.practice_worksheet_template_revisions revision
  set state = 'released'
  where revision.id = selected_revision.id;
  perform set_config('app.worksheet_bank_state_transition', 'off', true);
  perform set_config('app.worksheet_bank_attestation_insert', 'off', true);

  return query select
    selected_template.id,
    selected_revision.id,
    selected_review.id,
    selected_release.id,
    actual_content_hash,
    true;
end;
$$;

revoke all on function app_private.publish_certified_worksheet_template(
  text, jsonb, uuid, uuid, jsonb, text, text
)
from public, anon, authenticated, service_role;

comment on function app_private.publish_certified_worksheet_template(
  text, jsonb, uuid, uuid, jsonb, text, text
) is
  'Postgres-only atomic publisher. Canonical slugs select the closed grammar topic even when display names are localized; unknown supplied slugs fail closed.';
