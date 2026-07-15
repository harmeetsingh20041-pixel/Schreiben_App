-- Keep packet publication rejection-only at the final database boundary.
--
-- The supported release tool already validates and losslessly prepares every
-- worksheet, but the private packet RPC must independently reject JSON nulls,
-- string-encoded numbers, and non-string answer material. Otherwise a future
-- release-tool regression or an owner-issued manual call could either normalize
-- reviewed content silently or escape through a raw table constraint error.
--
-- Exact packet replay must also use the same definition of "current" as student
-- delivery. Packet two may legitimately reuse a revision first published by
-- packet one, so the packet header's reviewer/releaser are not necessarily the
-- original canonical revision's attesters.

create or replace function app_private.worksheet_packet_payload_item_is_strictly_typed(
  payload_item jsonb
)
returns boolean
language plpgsql
immutable
parallel safe
security invoker
set search_path = ''
as $$
declare
  worksheet jsonb;
begin
  if jsonb_typeof(payload_item) is distinct from 'object'
    or not (payload_item ?& array[
      'template_key',
      'source_file_path',
      'source_sha256',
      'worksheet'
    ])
    or payload_item - array[
      'template_key',
      'source_file_path',
      'source_sha256',
      'worksheet'
    ]::text[] is distinct from '{}'::jsonb
    or jsonb_typeof(payload_item -> 'template_key') is distinct from 'string'
    or coalesce(payload_item ->> 'template_key', '')
      !~ '^[a-z0-9][a-z0-9._-]{5,119}$'
    or jsonb_typeof(payload_item -> 'source_file_path') is distinct from 'string'
    or length(coalesce(payload_item ->> 'source_file_path', ''))
      not between 1 and 500
    or jsonb_typeof(payload_item -> 'source_sha256') is distinct from 'string'
    or coalesce(payload_item ->> 'source_sha256', '') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(payload_item -> 'worksheet') is distinct from 'object'
  then
    return false;
  end if;

  worksheet := payload_item -> 'worksheet';

  if not app_private.worksheet_template_payload_is_structurally_valid(worksheet)
    or not (worksheet ?& array[
      'title',
      'level',
      'grammar_topic',
      'difficulty',
      'visibility',
      'source',
      'source_label',
      'tags',
      'mini_lesson',
      'questions'
    ])
    or jsonb_typeof(worksheet -> 'title') is distinct from 'string'
    or (
      worksheet ? 'description'
      and jsonb_typeof(worksheet -> 'description') is distinct from 'string'
    )
    or jsonb_typeof(worksheet -> 'level') is distinct from 'string'
    or jsonb_typeof(worksheet -> 'grammar_topic') is distinct from 'object'
    or not ((worksheet -> 'grammar_topic') ? 'slug')
    or jsonb_typeof(worksheet #> '{grammar_topic,slug}')
      is distinct from 'string'
    or (
      (worksheet -> 'grammar_topic') ? 'name'
      and jsonb_typeof(worksheet #> '{grammar_topic,name}')
        is distinct from 'string'
    )
    or jsonb_typeof(worksheet -> 'difficulty') is distinct from 'string'
    or jsonb_typeof(worksheet -> 'visibility') is distinct from 'string'
    or jsonb_typeof(worksheet -> 'source') is distinct from 'string'
    or jsonb_typeof(worksheet -> 'source_label') is distinct from 'string'
    or jsonb_typeof(worksheet -> 'tags') is distinct from 'array'
    or exists (
      select 1
      from jsonb_array_elements(worksheet -> 'tags') tag(item)
      where jsonb_typeof(tag.item) is distinct from 'string'
    )
    or jsonb_typeof(worksheet -> 'mini_lesson') is distinct from 'object'
    or not ((worksheet -> 'mini_lesson') ?& array[
      'short_explanation',
      'key_rule',
      'correct_examples',
      'common_mistake_warning',
      'what_to_revise'
    ])
    or jsonb_typeof(worksheet #> '{mini_lesson,short_explanation}')
      is distinct from 'string'
    or jsonb_typeof(worksheet #> '{mini_lesson,key_rule}')
      is distinct from 'string'
    or jsonb_typeof(worksheet #> '{mini_lesson,correct_examples}')
      is distinct from 'array'
    or exists (
      select 1
      from jsonb_array_elements(
        worksheet #> '{mini_lesson,correct_examples}'
      ) example(item)
      where jsonb_typeof(example.item) is distinct from 'string'
    )
    or jsonb_typeof(worksheet #> '{mini_lesson,common_mistake_warning}')
      is distinct from 'string'
    or jsonb_typeof(worksheet #> '{mini_lesson,what_to_revise}')
      is distinct from 'string'
    or jsonb_typeof(worksheet -> 'questions') is distinct from 'array'
    or exists (
      select 1
      from jsonb_array_elements(worksheet -> 'questions') question(item)
      where jsonb_typeof(question.item) is distinct from 'object'
        or not (question.item ?& array[
          'question_number',
          'question_type',
          'prompt',
          'options',
          'correct_answer',
          'accepted_answers',
          'rubric',
          'answer_contract_version',
          'explanation',
          'evaluation_mode'
        ])
        or question.item - array[
          'question_number',
          'question_type',
          'prompt',
          'options',
          'correct_answer',
          'accepted_answers',
          'rubric',
          'answer_contract_version',
          'explanation',
          'evaluation_mode'
        ]::text[] is distinct from '{}'::jsonb
        or jsonb_typeof(question.item -> 'question_number')
          is distinct from 'number'
        or coalesce(question.item ->> 'question_number', '')
          !~ '^[1-9][0-9]*$'
        or jsonb_typeof(question.item -> 'question_type')
          is distinct from 'string'
        or jsonb_typeof(question.item -> 'prompt') is distinct from 'string'
        or jsonb_typeof(question.item -> 'options') is distinct from 'array'
        or exists (
          select 1
          from jsonb_array_elements(question.item -> 'options') answer_option(item)
          where jsonb_typeof(answer_option.item) is distinct from 'string'
        )
        or jsonb_typeof(question.item -> 'correct_answer')
          is distinct from 'string'
        or jsonb_typeof(question.item -> 'accepted_answers')
          is distinct from 'array'
        or exists (
          select 1
          from jsonb_array_elements(
            question.item -> 'accepted_answers'
          ) accepted(item)
          where jsonb_typeof(accepted.item) is distinct from 'string'
        )
        or jsonb_typeof(question.item -> 'rubric') not in ('object', 'null')
        or (
          jsonb_typeof(question.item -> 'rubric') = 'object'
          and (
            not ((question.item -> 'rubric') ?& array[
              'criteria',
              'sample_answer'
            ])
            or (question.item -> 'rubric') - array[
              'criteria',
              'sample_answer'
            ]::text[] is distinct from '{}'::jsonb
            or jsonb_typeof(question.item #> '{rubric,criteria}')
              is distinct from 'array'
            or exists (
              select 1
              from jsonb_array_elements(
                question.item #> '{rubric,criteria}'
              ) criterion(item)
              where jsonb_typeof(criterion.item) is distinct from 'string'
            )
            or jsonb_typeof(question.item #> '{rubric,sample_answer}')
              is distinct from 'string'
          )
        )
        or jsonb_typeof(question.item -> 'answer_contract_version')
          is distinct from 'number'
        or question.item ->> 'answer_contract_version' is distinct from '1'
        or jsonb_typeof(question.item -> 'explanation')
          is distinct from 'string'
        or jsonb_typeof(question.item -> 'evaluation_mode')
          is distinct from 'string'
    )
  then
    return false;
  end if;

  return true;
exception
  when invalid_parameter_value
    or data_exception
    or numeric_value_out_of_range
  then
    return false;
end;
$$;

revoke all on function
  app_private.worksheet_packet_payload_item_is_strictly_typed(jsonb)
from public, anon, authenticated, service_role;

comment on function
  app_private.worksheet_packet_payload_item_is_strictly_typed(jsonb)
is
  'Private packet-boundary validator. Canonical release payloads are strictly typed and rejection-only; JSON nulls, string-number coercions, and non-string educational arrays fail before publication.';

-- Patch the latest packet publisher in place. Every anchor is unique and
-- guarded so definition drift aborts the migration rather than leaving a
-- partially hardened release path.
do $migration$
declare
  function_definition text;
  patched_definition text;
  old_fragment text;
  new_fragment text;
  occurrence_count integer;
begin
  select pg_get_functiondef(
    'app_private.publish_certified_worksheet_packet(text,text,jsonb)'::regprocedure
  ) into function_definition;
  patched_definition := function_definition;

  old_fragment := '    join app_private.practice_worksheet_template_releases release
      on release.id = item.release_id
     and release.revision_id = item.revision_id
     and release.review_id = item.review_id
     and release.content_sha256 = item.content_sha256
    where item.packet_release_id = selected_packet_release.id';
  new_fragment := '    join app_private.practice_worksheet_template_releases release
      on release.id = item.release_id
     and release.revision_id = item.revision_id
     and release.review_id = item.review_id
     and release.content_sha256 = item.content_sha256
    join app_private.practice_worksheet_bank_reviewers reviewer
      on reviewer.user_id = review.reviewer_id
     and reviewer.active
     and reviewer.can_certify
     and reviewer.verified_at <= review.reviewed_at
     and (
       reviewer.expires_at is null
       or reviewer.expires_at > greatest(review.reviewed_at, now())
     )
    join app_private.practice_worksheet_bank_reviewers releaser
      on releaser.user_id = release.released_by
     and releaser.active
     and releaser.can_release
     and releaser.verified_at <= release.released_at
     and (
       releaser.expires_at is null
       or releaser.expires_at > greatest(release.released_at, now())
     )
    where item.packet_release_id = selected_packet_release.id';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_packet_replay_attester_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := '      and revision.content_sha256 = item.content_sha256
    for share of revision, review, release;';
  new_fragment := '      and revision.content_sha256 = item.content_sha256
      and revision.content_sha256 =
        app_private.practice_worksheet_template_revision_sha256(revision.id)
      and not exists (
        select 1
        from app_private.practice_worksheet_template_withdrawals withdrawal
        where withdrawal.revision_id = revision.id
      )
    for share of revision, review, release, reviewer, releaser;';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_packet_replay_integrity_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := '    select published_item.*
    into strict published
    from app_private.publish_certified_worksheet_template(';
  new_fragment := '    if not app_private.worksheet_packet_payload_item_is_strictly_typed(
      payload_item
    ) then
      raise exception using
        errcode = ''22023'',
        message = ''worksheet_packet_release_payload_invalid'';
    end if;

    select published_item.*
    into strict published
    from app_private.publish_certified_worksheet_template(';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_packet_strict_payload_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := '    join app_private.practice_worksheet_template_releases release
      on release.id = published.release_id
     and release.revision_id = revision.id
     and release.review_id = review.id
    where revision.id = published.revision_id';
  new_fragment := '    join app_private.practice_worksheet_template_releases release
      on release.id = published.release_id
     and release.revision_id = revision.id
     and release.review_id = review.id
    join app_private.practice_worksheet_bank_reviewers reviewer
      on reviewer.user_id = review.reviewer_id
     and reviewer.active
     and reviewer.can_certify
     and reviewer.verified_at <= review.reviewed_at
     and (
       reviewer.expires_at is null
       or reviewer.expires_at > greatest(review.reviewed_at, now())
     )
    join app_private.practice_worksheet_bank_reviewers releaser
      on releaser.user_id = release.released_by
     and releaser.active
     and releaser.can_release
     and releaser.verified_at <= release.released_at
     and (
       releaser.expires_at is null
       or releaser.expires_at > greatest(release.released_at, now())
     )
    where revision.id = published.revision_id';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_packet_publication_attester_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  old_fragment := '      and release.content_sha256 = published.content_sha256
    for share of revision, review, release;';
  new_fragment := '      and release.content_sha256 = published.content_sha256
      and revision.content_sha256 =
        app_private.practice_worksheet_template_revision_sha256(revision.id)
      and not exists (
        select 1
        from app_private.practice_worksheet_template_withdrawals withdrawal
        where withdrawal.revision_id = revision.id
      )
    for share of revision, review, release, reviewer, releaser;';
  occurrence_count := (
    length(patched_definition) - length(replace(patched_definition, old_fragment, ''))
  ) / length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_packet_publication_integrity_patch_mismatch';
  end if;
  patched_definition := replace(
    patched_definition,
    old_fragment,
    new_fragment
  );

  execute patched_definition;
end;
$migration$;

revoke all on function app_private.publish_certified_worksheet_packet(
  text, text, jsonb
)
from public, anon, authenticated, service_role;

comment on function app_private.publish_certified_worksheet_packet(
  text, text, jsonb
) is
  'Postgres-owner-only atomic V1 packet publisher. Strictly typed source-bound payloads are rejection-only; both first publication and exact replay recompute every canonical hash, exclude withdrawals, and lock each original currently qualified reviewer/releaser through commit.';
