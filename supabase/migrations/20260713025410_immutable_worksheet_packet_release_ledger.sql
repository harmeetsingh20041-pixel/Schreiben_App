-- Immutable, packet-level certified worksheet release evidence.
--
-- The existing single-revision publisher remains the canonical content gate.
-- This layer binds a qualified human release manifest to one of the two frozen
-- V1 review-packet byte hashes, publishes every item in one transaction, and
-- retains the source/release hashes even when a later full-coverage packet
-- overlaps a revision already released by the priority packet.

create table app_private.practice_worksheet_packet_releases (
  id uuid primary key default gen_random_uuid(),
  source_packet_id text not null unique,
  source_packet_sha256 text not null unique
    check (source_packet_sha256 ~ '^[a-f0-9]{64}$'),
  source_packet_raw text not null,
  release_manifest_sha256 text not null unique
    check (release_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  release_manifest_raw text not null,
  worksheet_payloads_sha256 text not null
    check (worksheet_payloads_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_at timestamptz not null,
  release_authorized_at timestamptz not null,
  reviewer_id uuid not null
    references app_private.practice_worksheet_bank_reviewers(user_id)
    on delete restrict,
  releaser_id uuid not null
    references app_private.practice_worksheet_bank_reviewers(user_id)
    on delete restrict,
  review_checklist jsonb not null
    check (app_private.worksheet_review_checklist_is_complete(review_checklist)),
  review_notes text not null check (length(btrim(review_notes)) between 16 and 1000),
  release_notes text not null check (length(btrim(release_notes)) between 16 and 1000),
  worksheet_count integer not null check (worksheet_count in (80, 184)),
  created_at timestamptz not null default now(),
  check (release_authorized_at >= reviewed_at)
);

create table app_private.practice_worksheet_packet_release_items (
  packet_release_id uuid not null
    references app_private.practice_worksheet_packet_releases(id)
    on delete restrict,
  ordinal integer not null check (ordinal > 0),
  template_key text not null
    references app_private.practice_worksheet_templates(template_key)
    on delete restrict,
  source_file_path text not null
    check (length(source_file_path) between 1 and 500),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  revision_id uuid not null
    references app_private.practice_worksheet_template_revisions(id)
    on delete restrict,
  review_id uuid not null,
  release_id uuid not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_revision_created boolean not null,
  created_at timestamptz not null default now(),
  primary key (packet_release_id, ordinal),
  unique (packet_release_id, template_key),
  unique (packet_release_id, source_file_path),
  unique (packet_release_id, source_sha256),
  unique (packet_release_id, revision_id),
  foreign key (review_id, revision_id)
    references app_private.practice_worksheet_template_reviews(id, revision_id)
    on delete restrict,
  foreign key (release_id, revision_id)
    references app_private.practice_worksheet_template_releases(id, revision_id)
    on delete restrict
);

create index practice_worksheet_packet_items_revision_idx
on app_private.practice_worksheet_packet_release_items (
  revision_id,
  packet_release_id
);

alter table app_private.practice_worksheet_packet_releases
enable row level security;
alter table app_private.practice_worksheet_packet_release_items
enable row level security;

revoke all on table app_private.practice_worksheet_packet_releases
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_worksheet_packet_release_items
from public, anon, authenticated, service_role;

create or replace function app_private.guard_worksheet_packet_release_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.worksheet_packet_release_insert', true)
    is distinct from 'on'
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_packet_release_publisher_required';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_packet_release_insert()
from public, anon, authenticated, service_role;

create trigger practice_worksheet_packet_releases_00_guard_insert
before insert on app_private.practice_worksheet_packet_releases
for each row execute function
  app_private.guard_worksheet_packet_release_insert();

create trigger practice_worksheet_packet_items_00_guard_insert
before insert on app_private.practice_worksheet_packet_release_items
for each row execute function
  app_private.guard_worksheet_packet_release_insert();

create trigger practice_worksheet_packet_releases_immutable
before update or delete on app_private.practice_worksheet_packet_releases
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create trigger practice_worksheet_packet_release_items_immutable
before update or delete on app_private.practice_worksheet_packet_release_items
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create or replace function app_private.publish_certified_worksheet_packet(
  target_source_packet_raw text,
  target_release_manifest_raw text,
  target_worksheet_payloads jsonb
)
returns table (
  packet_release_id uuid,
  source_packet_id text,
  template_key text,
  ordinal integer,
  revision_id uuid,
  review_id uuid,
  release_id uuid,
  source_sha256 text,
  content_sha256 text,
  canonical_revision_created boolean,
  packet_release_created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  priority_packet_id constant text :=
    'schreiben-v1-launch-worksheet-qualified-human-review-packet-1';
  priority_packet_hash constant text :=
    '878802d40e443b965c53b125dac102ae17d1acc85091dc77cb1a8e1ac53ac1b1';
  full_packet_id constant text :=
    'schreiben-v1-worksheet-qualified-human-review-full-coverage-1';
  full_packet_hash constant text :=
    'b4ff1c25d4fd43c1cb8d4aa487518dd4a2a8b506a48faa7d89f002ba4b79d916';
  source_packet jsonb;
  release_manifest jsonb;
  source_hash text;
  manifest_hash text;
  payloads_hash text;
  selected_packet_id text;
  expected_packet_hash text;
  expected_count integer;
  selected_reviewer_id uuid;
  selected_releaser_id uuid;
  selected_reviewed_at timestamptz;
  selected_release_authorized_at timestamptz;
  selected_packet_release app_private.practice_worksheet_packet_releases%rowtype;
  packet_item jsonb;
  manifest_item jsonb;
  payload_item jsonb;
  published record;
  item_ordinal integer;
  locked_item_count integer;
begin
  if target_source_packet_raw is null
    or target_release_manifest_raw is null
    or target_worksheet_payloads is null
    or jsonb_typeof(target_worksheet_payloads) is distinct from 'array'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_packet_release_invalid';
  end if;

  begin
    source_packet := target_source_packet_raw::jsonb;
    release_manifest := target_release_manifest_raw::jsonb;
  exception when others then
    raise exception using
      errcode = '22023',
      message = 'worksheet_packet_release_json_invalid';
  end;

  source_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(target_source_packet_raw, 'UTF8')),
    'hex'
  );
  manifest_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(target_release_manifest_raw, 'UTF8')),
    'hex'
  );
  payloads_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(target_worksheet_payloads::text, 'UTF8')
    ),
    'hex'
  );
  selected_packet_id := source_packet ->> 'packet_id';

  if selected_packet_id = priority_packet_id then
    expected_packet_hash := priority_packet_hash;
    expected_count := 80;
  elsif selected_packet_id = full_packet_id then
    expected_packet_hash := full_packet_hash;
    expected_count := 184;
  else
    raise exception using
      errcode = '22023',
      message = 'worksheet_packet_release_packet_not_trusted';
  end if;

  if source_hash is distinct from expected_packet_hash
    or jsonb_typeof(source_packet) is distinct from 'object'
    or source_packet ->> 'artifact_kind'
      is distinct from 'qualified_human_review_packet_manifest'
    or source_packet ->> 'status'
      is distinct from 'awaiting_qualified_human_review'
    or source_packet -> 'launch_evidence_eligible'
      is distinct from 'false'::jsonb
    or source_packet -> 'deployment_eligible'
      is distinct from 'false'::jsonb
    or jsonb_typeof(source_packet -> 'worksheets') is distinct from 'array'
    or jsonb_array_length(
      case
        when jsonb_typeof(source_packet -> 'worksheets') = 'array'
          then source_packet -> 'worksheets'
        else '[]'::jsonb
      end
    ) is distinct from expected_count
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_packet_release_packet_not_trusted';
  end if;

  if jsonb_typeof(release_manifest) is distinct from 'object'
    or not (release_manifest ?& array[
      'schema_version',
      'artifact_kind',
      'source_packet_id',
      'source_packet_sha256',
      'status',
      'reviewed_at',
      'release_authorized_at',
      'reviewer_id',
      'releaser_id',
      'review_checklist',
      'review_notes',
      'release_notes',
      'worksheets'
    ])
    or release_manifest - array[
      'schema_version',
      'artifact_kind',
      'source_packet_id',
      'source_packet_sha256',
      'status',
      'reviewed_at',
      'release_authorized_at',
      'reviewer_id',
      'releaser_id',
      'review_checklist',
      'review_notes',
      'release_notes',
      'worksheets'
    ]::text[] <> '{}'::jsonb
    or jsonb_typeof(release_manifest -> 'schema_version')
      is distinct from 'number'
    or release_manifest ->> 'schema_version' is distinct from '1'
    or jsonb_typeof(release_manifest -> 'artifact_kind')
      is distinct from 'string'
    or release_manifest ->> 'artifact_kind'
      is distinct from 'qualified_human_worksheet_release_manifest'
    or jsonb_typeof(release_manifest -> 'source_packet_id')
      is distinct from 'string'
    or release_manifest ->> 'source_packet_id'
      is distinct from selected_packet_id
    or jsonb_typeof(release_manifest -> 'source_packet_sha256')
      is distinct from 'string'
    or release_manifest ->> 'source_packet_sha256'
      is distinct from source_hash
    or jsonb_typeof(release_manifest -> 'status') is distinct from 'string'
    or release_manifest ->> 'status'
      is distinct from 'qualified_human_approved_for_release'
    or jsonb_typeof(release_manifest -> 'reviewed_at')
      is distinct from 'string'
    or coalesce(release_manifest ->> 'reviewed_at', '')
      !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$'
    or jsonb_typeof(release_manifest -> 'release_authorized_at')
      is distinct from 'string'
    or coalesce(release_manifest ->> 'release_authorized_at', '')
      !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$'
    or jsonb_typeof(release_manifest -> 'reviewer_id')
      is distinct from 'string'
    or coalesce(release_manifest ->> 'reviewer_id', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(release_manifest -> 'releaser_id')
      is distinct from 'string'
    or coalesce(release_manifest ->> 'releaser_id', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(release_manifest -> 'review_checklist')
      is distinct from 'object'
    or not app_private.worksheet_review_checklist_is_complete(
      release_manifest -> 'review_checklist'
    )
    or jsonb_typeof(release_manifest -> 'review_notes')
      is distinct from 'string'
    or length(btrim(coalesce(release_manifest ->> 'review_notes', '')))
      not between 16 and 1000
    or jsonb_typeof(release_manifest -> 'release_notes')
      is distinct from 'string'
    or length(btrim(coalesce(release_manifest ->> 'release_notes', '')))
      not between 16 and 1000
    or jsonb_typeof(release_manifest -> 'worksheets') is distinct from 'array'
    or jsonb_array_length(
      case
        when jsonb_typeof(release_manifest -> 'worksheets') = 'array'
          then release_manifest -> 'worksheets'
        else '[]'::jsonb
      end
    ) is distinct from expected_count
    or jsonb_array_length(target_worksheet_payloads)
      is distinct from expected_count
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_packet_release_manifest_invalid';
  end if;

  begin
    selected_reviewer_id := (release_manifest ->> 'reviewer_id')::uuid;
    selected_releaser_id := (release_manifest ->> 'releaser_id')::uuid;
    selected_reviewed_at :=
      (release_manifest ->> 'reviewed_at')::timestamptz;
    selected_release_authorized_at :=
      (release_manifest ->> 'release_authorized_at')::timestamptz;
  exception when others then
    raise exception using
      errcode = '22023',
      message = 'worksheet_packet_release_manifest_invalid';
  end;

  if selected_release_authorized_at < selected_reviewed_at
    or selected_reviewed_at > now() + interval '5 minutes'
    or selected_release_authorized_at > now() + interval '5 minutes'
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_packet_release_timestamp_invalid';
  end if;

  perform 1
  from app_private.practice_worksheet_bank_reviewers reviewer
  where reviewer.user_id = selected_reviewer_id
    and reviewer.active
    and reviewer.can_certify
    and reviewer.verified_at <= selected_reviewed_at
    and (
      reviewer.expires_at is null
      or reviewer.expires_at > selected_reviewed_at
    )
  for share;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'worksheet_packet_reviewer_not_qualified';
  end if;

  perform 1
  from app_private.practice_worksheet_bank_reviewers releaser
  where releaser.user_id = selected_releaser_id
    and releaser.active
    and releaser.can_release
    and releaser.verified_at <= selected_release_authorized_at
    and (
      releaser.expires_at is null
      or releaser.expires_at > selected_release_authorized_at
    )
  for share;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'worksheet_packet_releaser_not_qualified';
  end if;

  -- Packet publication is a rare release operation. Serialize both frozen V1
  -- packets before their per-template locks so overlapping 80/184 imports can
  -- never acquire template locks in opposite order and deadlock.
  perform pg_advisory_xact_lock(
    hashtextextended('worksheet-packet-release:global', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(concat('worksheet-packet-release:', source_hash), 0)
  );

  select packet_release.*
  into selected_packet_release
  from app_private.practice_worksheet_packet_releases packet_release
  where packet_release.source_packet_id = selected_packet_id
     or packet_release.source_packet_sha256 = source_hash
  for share;

  if selected_packet_release.id is not null then
    if selected_packet_release.source_packet_id <> selected_packet_id
      or selected_packet_release.source_packet_sha256 <> source_hash
      or selected_packet_release.source_packet_raw <> target_source_packet_raw
      or selected_packet_release.release_manifest_sha256 <> manifest_hash
      or selected_packet_release.release_manifest_raw <> target_release_manifest_raw
      or selected_packet_release.worksheet_payloads_sha256 <> payloads_hash
      or selected_packet_release.worksheet_count <> expected_count
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_packet_release_changed_replay';
    end if;

    perform 1
    from app_private.practice_worksheet_packet_release_items item
    join app_private.practice_worksheet_template_revisions revision
      on revision.id = item.revision_id
    join app_private.practice_worksheet_template_reviews review
      on review.id = item.review_id
     and review.revision_id = item.revision_id
     and review.content_sha256 = item.content_sha256
    join app_private.practice_worksheet_template_releases release
      on release.id = item.release_id
     and release.revision_id = item.revision_id
     and release.review_id = item.review_id
     and release.content_sha256 = item.content_sha256
    where item.packet_release_id = selected_packet_release.id
      and revision.state = 'released'
      and revision.content_sha256 = item.content_sha256
    for share of revision, review, release;
    get diagnostics locked_item_count = row_count;

    if locked_item_count <> expected_count
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_packet_release_replay_not_current';
    end if;

    return query
    select
      selected_packet_release.id,
      selected_packet_release.source_packet_id,
      item.template_key,
      item.ordinal,
      item.revision_id,
      item.review_id,
      item.release_id,
      item.source_sha256,
      item.content_sha256,
      item.canonical_revision_created,
      false
    from app_private.practice_worksheet_packet_release_items item
    where item.packet_release_id = selected_packet_release.id
    order by item.ordinal;
    return;
  end if;

  perform set_config('app.worksheet_packet_release_insert', 'on', true);
  insert into app_private.practice_worksheet_packet_releases (
    source_packet_id,
    source_packet_sha256,
    source_packet_raw,
    release_manifest_sha256,
    release_manifest_raw,
    worksheet_payloads_sha256,
    reviewed_at,
    release_authorized_at,
    reviewer_id,
    releaser_id,
    review_checklist,
    review_notes,
    release_notes,
    worksheet_count
  ) values (
    selected_packet_id,
    source_hash,
    target_source_packet_raw,
    manifest_hash,
    target_release_manifest_raw,
    payloads_hash,
    selected_reviewed_at,
    selected_release_authorized_at,
    selected_reviewer_id,
    selected_releaser_id,
    release_manifest -> 'review_checklist',
    btrim(release_manifest ->> 'review_notes'),
    btrim(release_manifest ->> 'release_notes'),
    expected_count
  ) returning * into selected_packet_release;

  for item_ordinal in 1..expected_count loop
    packet_item := source_packet -> 'worksheets' -> (item_ordinal - 1);
    manifest_item := release_manifest -> 'worksheets' -> (item_ordinal - 1);
    payload_item := target_worksheet_payloads -> (item_ordinal - 1);

    if jsonb_typeof(manifest_item) is distinct from 'object'
      or not (manifest_item ?& array[
        'template_key', 'current_sha256', 'decision'
      ])
      or manifest_item - array[
        'template_key', 'current_sha256', 'decision'
      ]::text[] is distinct from '{}'::jsonb
      or jsonb_typeof(payload_item) is distinct from 'object'
      or not (payload_item ?& array[
        'template_key', 'source_file_path', 'source_sha256', 'worksheet'
      ])
      or payload_item - array[
        'template_key', 'source_file_path', 'source_sha256', 'worksheet'
      ]::text[] is distinct from '{}'::jsonb
      or jsonb_typeof(manifest_item -> 'decision') is distinct from 'string'
      or jsonb_typeof(manifest_item -> 'template_key') is distinct from 'string'
      or jsonb_typeof(manifest_item -> 'current_sha256') is distinct from 'string'
      or jsonb_typeof(payload_item -> 'template_key') is distinct from 'string'
      or jsonb_typeof(payload_item -> 'source_file_path') is distinct from 'string'
      or jsonb_typeof(payload_item -> 'source_sha256') is distinct from 'string'
      or jsonb_typeof(payload_item -> 'worksheet') is distinct from 'object'
      or jsonb_typeof(payload_item #> '{worksheet,level}')
        is distinct from 'string'
      or jsonb_typeof(payload_item #> '{worksheet,grammar_topic,slug}')
        is distinct from 'string'
      or manifest_item ->> 'decision' is distinct from 'approved'
      or manifest_item ->> 'template_key'
        is distinct from packet_item ->> 'template_key'
      or manifest_item ->> 'current_sha256'
        is distinct from packet_item ->> 'current_sha256'
      or payload_item ->> 'template_key'
        is distinct from packet_item ->> 'template_key'
      or payload_item ->> 'source_file_path'
        is distinct from packet_item ->> 'current_file_path'
      or payload_item ->> 'source_sha256'
        is distinct from packet_item ->> 'current_sha256'
      or payload_item #>> '{worksheet,level}'
        is distinct from packet_item ->> 'level'
      or payload_item #>> '{worksheet,grammar_topic,slug}'
        is distinct from packet_item ->> 'topic_slug'
    then
      raise exception using
        errcode = '22023',
        message = 'worksheet_packet_release_item_mismatch';
    end if;

    select published_item.*
    into strict published
    from app_private.publish_certified_worksheet_template(
      payload_item ->> 'template_key',
      payload_item -> 'worksheet',
      selected_reviewer_id,
      selected_releaser_id,
      release_manifest -> 'review_checklist',
      release_manifest ->> 'review_notes',
      release_manifest ->> 'release_notes'
    ) published_item;

    -- Lock the effective immutable revision/review/release through packet
    -- commit. If a concurrent withdrawal won first, fail the whole packet;
    -- otherwise withdrawal waits and cannot make this transaction report a
    -- non-current release.
    perform 1
    from app_private.practice_worksheet_template_revisions revision
    join app_private.practice_worksheet_template_reviews review
      on review.id = published.review_id
     and review.revision_id = revision.id
    join app_private.practice_worksheet_template_releases release
      on release.id = published.release_id
     and release.revision_id = revision.id
     and release.review_id = review.id
    where revision.id = published.revision_id
      and revision.state = 'released'
      and revision.content_sha256 = published.content_sha256
      and review.content_sha256 = published.content_sha256
      and release.content_sha256 = published.content_sha256
    for share of revision, review, release;
    if not found then
      raise exception using
        errcode = '55000',
        message = 'worksheet_packet_release_not_current';
    end if;

    insert into app_private.practice_worksheet_packet_release_items (
      packet_release_id,
      ordinal,
      template_key,
      source_file_path,
      source_sha256,
      revision_id,
      review_id,
      release_id,
      content_sha256,
      canonical_revision_created
    ) values (
      selected_packet_release.id,
      item_ordinal,
      payload_item ->> 'template_key',
      payload_item ->> 'source_file_path',
      payload_item ->> 'source_sha256',
      published.revision_id,
      published.review_id,
      published.release_id,
      published.content_sha256,
      published.created
    );
  end loop;
  perform set_config('app.worksheet_packet_release_insert', 'off', true);

  select count(*)::integer
  into locked_item_count
  from app_private.practice_worksheet_packet_release_items item
  where item.packet_release_id = selected_packet_release.id;
  if locked_item_count <> expected_count then
    raise exception using
      errcode = '55000',
      message = 'worksheet_packet_release_partial';
  end if;

  return query
  select
    selected_packet_release.id,
    selected_packet_release.source_packet_id,
    item.template_key,
    item.ordinal,
    item.revision_id,
    item.review_id,
    item.release_id,
    item.source_sha256,
    item.content_sha256,
    item.canonical_revision_created,
    true
  from app_private.practice_worksheet_packet_release_items item
  where item.packet_release_id = selected_packet_release.id
  order by item.ordinal;
end;
$$;

revoke all on function app_private.publish_certified_worksheet_packet(
  text, text, jsonb
)
from public, anon, authenticated, service_role;

comment on function app_private.publish_certified_worksheet_packet(
  text, text, jsonb
) is
  'Postgres-owner-only atomic V1 packet publisher. Pins exact non-certifying review-packet bytes, validates qualified reviewer/releaser authority, publishes or reuses every canonical revision, retains immutable packet/item evidence including overlaps, rejects changed or partial replay, and locks effective releases through commit.';
