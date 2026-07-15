-- Keep at least one assignable certified worksheet available for every
-- canonical grammar-topic/CEFR context that has reached the released bank.
--
-- Withdrawals for different revisions in the same context serialize on one
-- advisory key before taking any revision row lock. This prevents two
-- concurrent withdrawals from each treating the other revision as the
-- surviving replacement, and avoids the inverse row/advisory lock order that
-- could otherwise deadlock. Exact replays remain idempotent.

create or replace function app_private.withdraw_released_worksheet_template(
  target_revision_id uuid,
  expected_revision_number integer,
  expected_content_sha256 text,
  target_actor_id uuid,
  withdrawal_reason text
)
returns table (
  withdrawal_id uuid,
  revision_id uuid,
  revision_number integer,
  content_sha256 text,
  withdrawn_by uuid,
  withdrawn_at timestamptz,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_revision app_private.practice_worksheet_template_revisions%rowtype;
  selected_release app_private.practice_worksheet_template_releases%rowtype;
  selected_withdrawal app_private.practice_worksheet_template_withdrawals%rowtype;
  target_template_id uuid;
  target_grammar_topic_id uuid;
  target_topic_slug text;
  target_level text;
  actual_content_hash text;
  clean_reason text := nullif(btrim(withdrawal_reason), '');
begin
  if target_revision_id is null
    or expected_revision_number is null
    or expected_revision_number < 1
    or expected_content_sha256 is null
    or expected_content_sha256 !~ '^[a-f0-9]{64}$'
    or target_actor_id is null
    or clean_reason is null
    or length(clean_reason) not between 12 and 1000
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_withdrawal_invalid';
  end if;

  -- Resolve the immutable coverage context without a row lock, then serialize
  -- the entire topic/level context before locking the target revision. Every
  -- withdrawal follows this order, so two different target revisions cannot
  -- form a row-lock/advisory-lock cycle.
  select
    revision.template_id,
    template.grammar_topic_id,
    topic.slug,
    template.level
  into
    target_template_id,
    target_grammar_topic_id,
    target_topic_slug,
    target_level
  from app_private.practice_worksheet_template_revisions revision
  join app_private.practice_worksheet_templates template
    on template.id = revision.template_id
  join public.grammar_topics topic
    on topic.id = template.grammar_topic_id
  where revision.id = target_revision_id;

  if target_template_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'worksheet_bank_revision_not_found';
  end if;

  if target_grammar_topic_id is null
    or target_topic_slug is null
    or target_level not in ('A1', 'A2', 'B1', 'B2')
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_context_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat_ws(
      ':',
      'worksheet-bank-withdrawal-coverage',
      target_grammar_topic_id::text,
      target_topic_slug,
      target_level
    ),
    0
  ));

  select revision.*
  into selected_revision
  from app_private.practice_worksheet_template_revisions revision
  where revision.id = target_revision_id
  for update;

  if selected_revision.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'worksheet_bank_revision_not_found';
  end if;

  if selected_revision.template_id is distinct from target_template_id then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_context_changed';
  end if;

  actual_content_hash :=
    app_private.practice_worksheet_template_revision_sha256(selected_revision.id);

  select withdrawal.*
  into selected_withdrawal
  from app_private.practice_worksheet_template_withdrawals withdrawal
  where withdrawal.revision_id = selected_revision.id;

  -- A lost-response replay must not depend on present-day bank coverage. The
  -- original operation already made and recorded that decision; replay only
  -- verifies the complete immutable binding and returns the same row.
  if selected_withdrawal.id is not null then
    if selected_revision.state <> 'superseded'
      or selected_withdrawal.template_id <> selected_revision.template_id
      or selected_withdrawal.revision_number <> expected_revision_number
      or selected_withdrawal.revision_number <> selected_revision.revision_number
      or selected_withdrawal.content_sha256 <> expected_content_sha256
      or selected_withdrawal.content_sha256 <> selected_revision.content_sha256
      or selected_withdrawal.content_sha256 is distinct from actual_content_hash
      or selected_withdrawal.withdrawn_by <> target_actor_id
      or selected_withdrawal.reason <> clean_reason
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_bank_withdrawal_replay_mismatch';
    end if;

    return query select
      selected_withdrawal.id,
      selected_withdrawal.revision_id,
      selected_withdrawal.revision_number,
      selected_withdrawal.content_sha256,
      selected_withdrawal.withdrawn_by,
      selected_withdrawal.withdrawn_at,
      false;
    return;
  end if;

  -- Only new decisions require a live closed-set topic contract. Existing
  -- immutable withdrawals remain replayable even if an operator later repairs
  -- or replaces contract metadata.
  if not exists (
    select 1
    from app_private.grammar_topic_contracts contract
    where contract.slug = target_topic_slug
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_context_invalid';
  end if;

  if selected_revision.state <> 'released' then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_revision_not_released';
  end if;

  if selected_revision.revision_number <> expected_revision_number
    or selected_revision.content_sha256 <> expected_content_sha256
  then
    raise exception using
      errcode = '40001',
      message = 'worksheet_bank_withdrawal_binding_mismatch';
  end if;

  if actual_content_hash is null
    or actual_content_hash is distinct from selected_revision.content_sha256
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_hash_mismatch';
  end if;

  select release.*
  into selected_release
  from app_private.practice_worksheet_template_releases release
  where release.revision_id = selected_revision.id
    and release.content_sha256 = selected_revision.content_sha256
  for share;

  if selected_release.id is null then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_release_invalid';
  end if;

  perform 1
  from app_private.practice_worksheet_bank_reviewers actor
  where actor.user_id = target_actor_id
    and actor.active
    and actor.can_release
    and actor.verified_at <= now()
    and (actor.expires_at is null or actor.expires_at > now())
  for share;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'worksheet_bank_withdrawal_actor_not_qualified';
  end if;

  -- A replacement must be a distinct, currently released canonical revision
  -- for this exact topic and CEFR level. Its recomputed content hash, approved
  -- review, active qualified reviewer/releaser attestations, and release must
  -- all agree, and no withdrawal may be recorded. Row-share locks protect the
  -- evidence inspected here while the context advisory lock serializes every
  -- withdrawal decision.
  perform 1
  from app_private.practice_worksheet_template_revisions replacement_revision
  join app_private.practice_worksheet_templates replacement_template
    on replacement_template.id = replacement_revision.template_id
  join public.grammar_topics replacement_topic
    on replacement_topic.id = replacement_template.grammar_topic_id
  join app_private.grammar_topic_contracts replacement_contract
    on replacement_contract.slug = replacement_topic.slug
  join app_private.practice_worksheet_template_reviews replacement_review
    on replacement_review.revision_id = replacement_revision.id
   and replacement_review.decision = 'approved'
   and replacement_review.content_sha256 = replacement_revision.content_sha256
  join app_private.practice_worksheet_template_releases replacement_release
    on replacement_release.revision_id = replacement_revision.id
   and replacement_release.review_id = replacement_review.id
   and replacement_release.content_sha256 = replacement_revision.content_sha256
  join app_private.practice_worksheet_bank_reviewers replacement_reviewer
    on replacement_reviewer.user_id = replacement_review.reviewer_id
   and replacement_reviewer.active
   and replacement_reviewer.can_certify
   and replacement_reviewer.verified_at <= replacement_review.reviewed_at
   and (
     replacement_reviewer.expires_at is null
     or replacement_reviewer.expires_at > replacement_review.reviewed_at
   )
  join app_private.practice_worksheet_bank_reviewers replacement_releaser
    on replacement_releaser.user_id = replacement_release.released_by
   and replacement_releaser.active
   and replacement_releaser.can_release
   and replacement_releaser.verified_at <= replacement_release.released_at
   and (
     replacement_releaser.expires_at is null
     or replacement_releaser.expires_at > replacement_release.released_at
   )
  where replacement_revision.id <> selected_revision.id
    and replacement_revision.state = 'released'
    and replacement_template.grammar_topic_id = target_grammar_topic_id
    and replacement_contract.slug = target_topic_slug
    and replacement_template.level = target_level
    and replacement_revision.content_sha256 =
      app_private.practice_worksheet_template_revision_sha256(
        replacement_revision.id
      )
    and not exists (
      select 1
      from app_private.practice_worksheet_template_withdrawals withdrawal
      where withdrawal.revision_id = replacement_revision.id
    )
  order by replacement_release.released_at, replacement_revision.id
  limit 1
  for share of
    replacement_revision,
    replacement_template,
    replacement_review,
    replacement_release,
    replacement_reviewer,
    replacement_releaser;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_last_active_coverage_required';
  end if;

  perform set_config('app.worksheet_bank_withdrawal_insert', 'on', true);
  insert into app_private.practice_worksheet_template_withdrawals (
    revision_id,
    template_id,
    revision_number,
    release_id,
    content_sha256,
    withdrawn_by,
    reason
  ) values (
    selected_revision.id,
    selected_revision.template_id,
    selected_revision.revision_number,
    selected_release.id,
    selected_revision.content_sha256,
    target_actor_id,
    clean_reason
  )
  returning * into selected_withdrawal;

  perform set_config('app.worksheet_bank_state_transition', 'on', true);
  update app_private.practice_worksheet_template_revisions revision
  set state = 'superseded'
  where revision.id = selected_revision.id
    and revision.state = 'released';

  if not found then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_state_conflict';
  end if;

  perform set_config('app.worksheet_bank_state_transition', 'off', true);
  perform set_config('app.worksheet_bank_withdrawal_insert', 'off', true);

  return query select
    selected_withdrawal.id,
    selected_withdrawal.revision_id,
    selected_withdrawal.revision_number,
    selected_withdrawal.content_sha256,
    selected_withdrawal.withdrawn_by,
    selected_withdrawal.withdrawn_at,
    true;
end;
$$;

revoke all on function app_private.withdraw_released_worksheet_template(
  uuid, integer, text, uuid, text
)
from public, anon, authenticated, service_role;

comment on function app_private.withdraw_released_worksheet_template(
  uuid, integer, text, uuid, text
) is
  'Postgres-only, retry-safe canonical worksheet withdrawal. It requires an active qualified releaser, exact immutable bindings, and another released hash-valid non-withdrawn actively certified revision for the same canonical topic and CEFR level; exact audit replays remain idempotent.';
