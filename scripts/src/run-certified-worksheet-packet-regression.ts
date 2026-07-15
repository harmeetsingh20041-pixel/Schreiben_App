import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateWorksheet } from "./import-practice-worksheet.js";
import {
  assertLinkedProjectIdentity,
  createPinnedSupabaseWorkdir,
  createLosslessValidatedWorksheet,
  createReleaseSafeWorksheet,
} from "./publish-certified-worksheet-packet.js";
import { verifyWorksheetReviewPacket } from "./verify-worksheet-review-packet.js";
import { verifyWorksheetFullCoverageReviewPacket } from "./verify-worksheet-full-coverage-review-packet.js";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const priorityReviewPacketPath = resolve(
  repositoryRoot,
  "quality/worksheet-bank/qualified-human-review-packet.json",
);
const fullReviewPacketPath = resolve(
  repositoryRoot,
  "quality/worksheet-bank/qualified-human-review-packet-full-coverage.json",
);
const reviewerId = "d8010001-0001-4001-8001-000000000001";
const releaserId = "d8010002-0002-4002-8002-000000000002";
const fullReviewerId = "d8010003-0003-4003-8003-000000000003";
const fullReleaserId = "d8010004-0004-4004-8004-000000000004";
const projectRefPattern = /^[a-z0-9]{20}$/;

type PacketEntry = {
  template_key: string;
  current_file_path: string;
  current_sha256: string;
  level: string;
  topic_slug: string;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function fixtureAuthUser(id: string, email: string, name: string) {
  return `(
    '00000000-0000-0000-0000-000000000000'::uuid,
    ${sqlLiteral(id)}::uuid,
    'authenticated',
    'authenticated',
    ${sqlLiteral(email)},
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    ${sqlJson({ full_name: name })},
    now(),
    now()
  )`;
}

export function buildCertifiedWorksheetPacketRegressionSql(args: {
  priority: {
    sourcePacketRaw: string;
    releaseManifestRaw: string;
    payloads: unknown[];
  };
  full: {
    sourcePacketRaw: string;
    releaseManifestRaw: string;
    payloads: unknown[];
  };
}) {
  const priority = args.priority;
  const full = args.full;

  return `begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(24);

select ok(
  to_regclass('app_private.practice_worksheet_packet_releases') is not null
    and to_regclass('app_private.practice_worksheet_packet_release_items') is not null
    and to_regprocedure(
      'app_private.publish_certified_worksheet_packet(text,text,jsonb)'
    ) is not null,
  'private packet release foundation exists'
);

select ok(
  not has_function_privilege(
    'anon',
    'app_private.publish_certified_worksheet_packet(text,text,jsonb)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.publish_certified_worksheet_packet(text,text,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.publish_certified_worksheet_packet(text,text,jsonb)',
      'EXECUTE'
    ),
  'packet publisher is unavailable to browser and worker roles'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
${fixtureAuthUser(reviewerId, "packet-regression-reviewer@example.test", "Packet Regression Reviewer")},
${fixtureAuthUser(releaserId, "packet-regression-releaser@example.test", "Packet Regression Releaser")},
${fixtureAuthUser(fullReviewerId, "packet-regression-full-reviewer@example.test", "Full Packet Regression Reviewer")},
${fixtureAuthUser(fullReleaserId, "packet-regression-full-releaser@example.test", "Full Packet Regression Releaser")};

insert into app_private.practice_worksheet_bank_reviewers (
  user_id,
  qualification,
  can_certify,
  can_release,
  active,
  verified_by,
  verified_at
)
values
  (
    ${sqlLiteral(reviewerId)}::uuid,
    'Test-only qualified German packet regression reviewer',
    true,
    false,
    true,
    ${sqlLiteral(reviewerId)}::uuid,
    now() - interval '1 day'
  ),
  (
    ${sqlLiteral(releaserId)}::uuid,
    'Test-only independent packet regression release controller',
    false,
    true,
    true,
    ${sqlLiteral(reviewerId)}::uuid,
    now() - interval '1 day'
  ),
  (
    ${sqlLiteral(fullReviewerId)}::uuid,
    'Test-only qualified full-packet German regression reviewer',
    true,
    false,
    true,
    ${sqlLiteral(fullReviewerId)}::uuid,
    now() - interval '1 day'
  ),
  (
    ${sqlLiteral(fullReleaserId)}::uuid,
    'Test-only independent full-packet regression release controller',
    false,
    true,
    true,
    ${sqlLiteral(fullReviewerId)}::uuid,
    now() - interval '1 day'
  );

create temporary table packet_regression_baseline as
select
  (select count(*) from app_private.practice_worksheet_packet_releases) as packet_releases,
  (select count(*) from app_private.practice_worksheet_packet_release_items) as packet_items,
  (select count(*) from app_private.practice_worksheet_templates) as templates,
  (select count(*) from app_private.practice_worksheet_template_revisions) as revisions,
  (select count(*) from public.practice_tests) as practice_tests,
  (select count(*) from public.practice_test_questions) as practice_questions,
  (select count(*) from public.student_practice_assignments) as assignments,
  (select count(*) from app_private.async_jobs) as async_jobs;

create temporary table packet_priority_fixture (
  source_packet_raw text not null,
  release_manifest_raw text not null,
  release_manifest jsonb not null,
  worksheet_payloads jsonb not null
) on commit drop;

insert into packet_priority_fixture (
  source_packet_raw,
  release_manifest_raw,
  release_manifest,
  worksheet_payloads
) values (
  ${sqlLiteral(priority.sourcePacketRaw)},
  ${sqlLiteral(priority.releaseManifestRaw)},
  ${sqlJson(JSON.parse(priority.releaseManifestRaw))},
  ${sqlJson(priority.payloads)}
);

create temporary table packet_full_fixture (
  source_packet_raw text not null,
  release_manifest_raw text not null,
  worksheet_payloads jsonb not null
) on commit drop;

insert into packet_full_fixture (
  source_packet_raw,
  release_manifest_raw,
  worksheet_payloads
) values (
  ${sqlLiteral(full.sourcePacketRaw)},
  ${sqlLiteral(full.releaseManifestRaw)},
  ${sqlJson(full.payloads)}
);

create function pg_temp.packet_manifest_rejection(mutated_manifest jsonb)
returns text
language plpgsql
as $packet_manifest_rejection$
declare
  fixture packet_priority_fixture%rowtype;
begin
  select * into strict fixture from packet_priority_fixture;
  begin
    perform *
    from app_private.publish_certified_worksheet_packet(
      fixture.source_packet_raw,
      mutated_manifest::text,
      fixture.worksheet_payloads
    );
    raise exception using
      errcode = 'P0001',
      message = 'packet_manifest_null_unexpectedly_accepted';
  exception
    when sqlstate '22023' then
      return sqlerrm;
    when others then
      return sqlstate || ':' || sqlerrm;
  end;
end;
$packet_manifest_rejection$;

select is(
  pg_temp.packet_manifest_rejection(
    jsonb_set(
      (select release_manifest from packet_priority_fixture),
      '{status}',
      'null'::jsonb
    )
  ),
  'worksheet_packet_release_manifest_invalid',
  'a JSON-null top-level status is rejected'
);

select is(
  pg_temp.packet_manifest_rejection(
    jsonb_set(
      (select release_manifest from packet_priority_fixture),
      '{artifact_kind}',
      'null'::jsonb
    )
  ),
  'worksheet_packet_release_manifest_invalid',
  'a JSON-null top-level artifact kind is rejected'
);

select is(
  pg_temp.packet_manifest_rejection(
    jsonb_set(
      (select release_manifest from packet_priority_fixture),
      '{source_packet_id}',
      'null'::jsonb
    )
  ),
  'worksheet_packet_release_manifest_invalid',
  'a JSON-null source packet id is rejected'
);

select is(
  pg_temp.packet_manifest_rejection(
    jsonb_set(
      (select release_manifest from packet_priority_fixture),
      '{source_packet_sha256}',
      'null'::jsonb
    )
  ),
  'worksheet_packet_release_manifest_invalid',
  'a JSON-null source packet hash is rejected'
);

select is(
  pg_temp.packet_manifest_rejection(
    jsonb_set(
      (select release_manifest from packet_priority_fixture),
      '{worksheets,0,decision}',
      'null'::jsonb
    )
  ),
  'worksheet_packet_release_item_mismatch',
  'a JSON-null per-item approval decision is rejected'
);

select is(
  pg_temp.packet_manifest_rejection(
    jsonb_set(
      (select release_manifest from packet_priority_fixture),
      '{worksheets,0,template_key}',
      'null'::jsonb
    )
  ),
  'worksheet_packet_release_item_mismatch',
  'a JSON-null per-item template key is rejected'
);

select is(
  pg_temp.packet_manifest_rejection(
    jsonb_set(
      (select release_manifest from packet_priority_fixture),
      '{worksheets,0,current_sha256}',
      'null'::jsonb
    )
  ),
  'worksheet_packet_release_item_mismatch',
  'a JSON-null per-item source hash is rejected'
);

-- These are procedural release gates rather than additional TAP assertions, so
-- the established 24-assertion packet matrix remains stable. Any acceptance or
-- any non-domain error aborts the rollback-only regression.
create function pg_temp.packet_payload_rejection(mutated_payloads jsonb)
returns text
language plpgsql
as $packet_payload_rejection$
declare
  fixture packet_priority_fixture%rowtype;
begin
  select * into strict fixture from packet_priority_fixture;
  begin
    perform *
    from app_private.publish_certified_worksheet_packet(
      fixture.source_packet_raw,
      fixture.release_manifest_raw,
      mutated_payloads
    );
    raise exception using
      errcode = 'P0001',
      message = 'packet_payload_unexpectedly_accepted';
  exception
    when sqlstate '22023' then
      return sqlerrm;
    when others then
      return sqlstate || ':' || sqlerrm;
  end;
end;
$packet_payload_rejection$;

create function pg_temp.packet_changed_replay_rejection(
  mutated_manifest text,
  mutated_payloads jsonb
)
returns text
language plpgsql
as $packet_changed_replay_rejection$
declare
  fixture packet_priority_fixture%rowtype;
begin
  select * into strict fixture from packet_priority_fixture;
  begin
    perform *
    from app_private.publish_certified_worksheet_packet(
      fixture.source_packet_raw,
      mutated_manifest,
      mutated_payloads
    );
    raise exception using
      errcode = 'P0001',
      message = 'packet_changed_replay_unexpectedly_accepted';
  exception
    when sqlstate '55000' then
      return sqlerrm;
    when others then
      return sqlstate || ':' || sqlerrm;
  end;
end;
$packet_changed_replay_rejection$;

do $packet_null_answer_contract$
declare
  rejection text;
begin
  select pg_temp.packet_payload_rejection(
    jsonb_set(
      (select worksheet_payloads from packet_priority_fixture),
      '{0,worksheet,questions,0,answer_contract_version}',
      'null'::jsonb,
      false
    )
  ) into strict rejection;
  if rejection <> 'worksheet_packet_release_payload_invalid' then
    raise exception using
      errcode = 'P0001',
      message = 'packet_null_answer_contract_wrong_result',
      detail = rejection;
  end if;
end;
$packet_null_answer_contract$;

do $packet_string_answer_contract$
declare
  rejection text;
begin
  select pg_temp.packet_payload_rejection(
    jsonb_set(
      (select worksheet_payloads from packet_priority_fixture),
      '{0,worksheet,questions,0,answer_contract_version}',
      '"1"'::jsonb,
      false
    )
  ) into strict rejection;
  if rejection <> 'worksheet_packet_release_payload_invalid' then
    raise exception using
      errcode = 'P0001',
      message = 'packet_string_answer_contract_wrong_result',
      detail = rejection;
  end if;
end;
$packet_string_answer_contract$;

do $packet_string_question_number$
declare
  rejection text;
begin
  select pg_temp.packet_payload_rejection(
    jsonb_set(
      (select worksheet_payloads from packet_priority_fixture),
      '{0,worksheet,questions,0,question_number}',
      '"1"'::jsonb,
      false
    )
  ) into strict rejection;
  if rejection <> 'worksheet_packet_release_payload_invalid' then
    raise exception using
      errcode = 'P0001',
      message = 'packet_string_question_number_wrong_result',
      detail = rejection;
  end if;
end;
$packet_string_question_number$;

do $packet_non_string_option$
declare
  rejection text;
begin
  select pg_temp.packet_payload_rejection(
    jsonb_set(
      (select worksheet_payloads from packet_priority_fixture),
      '{0,worksheet,questions,0,options,0}',
      'null'::jsonb,
      false
    )
  ) into strict rejection;
  if rejection <> 'worksheet_packet_release_payload_invalid' then
    raise exception using
      errcode = 'P0001',
      message = 'packet_non_string_option_wrong_result',
      detail = rejection;
  end if;
end;
$packet_non_string_option$;

do $packet_forced_failure$
declare
  rejection text;
begin
  select pg_temp.packet_payload_rejection(
    jsonb_set(
      (select worksheet_payloads from packet_priority_fixture),
      array[
        (
          jsonb_array_length(
            (select worksheet_payloads from packet_priority_fixture)
          ) - 1
        )::text,
        'source_sha256'
      ],
      to_jsonb(repeat('0', 64)),
      false
    )
  ) into strict rejection;
  if rejection <> 'worksheet_packet_release_item_mismatch' then
    raise exception using
      errcode = 'P0001',
      message = 'packet_forced_failure_wrong_result',
      detail = rejection;
  end if;
end;
$packet_forced_failure$;

select is(
  (select count(*) from app_private.practice_worksheet_packet_releases),
  (select packet_releases from packet_regression_baseline),
  'late item failure rolls back the packet release row'
);
select is(
  (select count(*) from app_private.practice_worksheet_packet_release_items),
  (select packet_items from packet_regression_baseline),
  'late item failure rolls back every packet item row'
);
select is(
  (select count(*) from app_private.practice_worksheet_templates),
  (select templates from packet_regression_baseline),
  'late item failure rolls back canonical templates created by earlier items'
);
select is(
  (select count(*) from app_private.practice_worksheet_template_revisions),
  (select revisions from packet_regression_baseline),
  'late item failure rolls back canonical revisions created by earlier items'
);

create temporary table packet_first_publication as
select published.*
from packet_priority_fixture fixture
cross join lateral app_private.publish_certified_worksheet_packet(
  fixture.source_packet_raw,
  fixture.release_manifest_raw,
  fixture.worksheet_payloads
) published;

select is(
  (select count(*) from packet_first_publication),
  80::bigint,
  'valid priority packet publishes all 80 canonical items'
);
select ok(
  (select count(distinct packet_release_id) = 1 from packet_first_publication)
    and (select bool_and(packet_release_created) from packet_first_publication),
  'first publication records one immutable packet release'
);

create temporary table packet_exact_replay as
select published.*
from packet_priority_fixture fixture
cross join lateral app_private.publish_certified_worksheet_packet(
  fixture.source_packet_raw,
  fixture.release_manifest_raw,
  fixture.worksheet_payloads
) published;

select ok(
  (select count(*) = 80 from packet_exact_replay)
    and not (select bool_or(packet_release_created) from packet_exact_replay)
    and not exists (
      select 1
      from packet_first_publication first_item
      full join packet_exact_replay replay_item using (ordinal)
      where first_item.packet_release_id is distinct from replay_item.packet_release_id
         or first_item.revision_id is distinct from replay_item.revision_id
         or first_item.review_id is distinct from replay_item.review_id
         or first_item.release_id is distinct from replay_item.release_id
    ),
  'lost-response replay returns the exact packet and canonical IDs'
);

select is(
  pg_temp.packet_changed_replay_rejection(
    (
      select jsonb_set(
        fixture.release_manifest,
        '{release_notes}',
        to_jsonb(
          (fixture.release_manifest ->> 'release_notes') || ' Changed replay.'
        ),
        false
      )::text
      from packet_priority_fixture fixture
    ),
    (select worksheet_payloads from packet_priority_fixture)
  ),
  'worksheet_packet_release_changed_replay',
  'changed manifest replay fails closed'
);

select is(
  pg_temp.packet_changed_replay_rejection(
    (select release_manifest_raw from packet_priority_fixture),
    jsonb_set(
      (select worksheet_payloads from packet_priority_fixture),
      array[
        (
          jsonb_array_length(
            (select worksheet_payloads from packet_priority_fixture)
          ) - 1
        )::text,
        'source_sha256'
      ],
      to_jsonb(repeat('0', 64)),
      false
    )
  ),
  'worksheet_packet_release_changed_replay',
  'changed canonical payload replay fails closed'
);

select ok(
  (select count(*) from app_private.practice_worksheet_packet_releases)
    = (select packet_releases + 1 from packet_regression_baseline)
    and (select count(*) from app_private.practice_worksheet_packet_release_items)
      = (select packet_items + 80 from packet_regression_baseline),
  'valid publication leaves a complete 1-to-80 durable ledger'
);

select ok(
  exists (
    select 1
    from app_private.practice_worksheet_packet_releases packet_release
    where packet_release.reviewer_id = ${sqlLiteral(reviewerId)}::uuid
      and packet_release.releaser_id = ${sqlLiteral(releaserId)}::uuid
      and packet_release.source_packet_sha256 =
        ${sqlLiteral(sha256(priority.sourcePacketRaw))}
      and packet_release.release_manifest_sha256 =
        ${sqlLiteral(sha256(priority.releaseManifestRaw))}
      and packet_release.worksheet_count = 80
  ),
  'durable packet evidence binds exact bytes and both qualified actors'
);

create temporary table packet_full_publication as
select published.*
from packet_full_fixture fixture
cross join lateral app_private.publish_certified_worksheet_packet(
  fixture.source_packet_raw,
  fixture.release_manifest_raw,
  fixture.worksheet_payloads
) published;

select is(
  (select count(*) from packet_full_publication),
  184::bigint,
  'full-coverage packet publishes or reuses all 184 canonical items'
);

select ok(
  (
    select count(*) = 80
      and bool_and(priority_item.revision_id = full_item.revision_id)
      and bool_and(
        priority_item.packet_release_id <> full_item.packet_release_id
      )
    from packet_first_publication priority_item
    join packet_full_publication full_item using (template_key)
  ),
  'full packet reuses all 80 overlapping revisions and retains a second packet attestation'
);

select ok(
  (select count(*) from app_private.practice_worksheet_packet_releases)
      = (select packet_releases + 2 from packet_regression_baseline)
    and (select count(*) from app_private.practice_worksheet_packet_release_items)
      = (select packet_items + 264 from packet_regression_baseline),
  'priority and full packets retain two complete overlap-safe ledgers'
);

select ok(
  (select count(*) from public.practice_tests)
      = (select practice_tests from packet_regression_baseline)
    and (select count(*) from public.practice_test_questions)
      = (select practice_questions from packet_regression_baseline)
    and (select count(*) from public.student_practice_assignments)
      = (select assignments from packet_regression_baseline)
    and (select count(*) from app_private.async_jobs)
      = (select async_jobs from packet_regression_baseline),
  'canonical packet publication creates no clone, assignment, or async job'
);

-- Corrupt one immutable canonical question inside a subtransaction. Exact
-- replay must recompute the revision hash and reject the packet. Catching the
-- expected error rolls back both the test-only trigger bypass and the mutation.
do $packet_replay_hash_corruption$
begin
  alter table app_private.practice_worksheet_template_questions
  disable trigger practice_worksheet_template_questions_immutable;

  update app_private.practice_worksheet_template_questions question
  set prompt = question.prompt || ' Test-only hash corruption.'
  where question.id = (
    select candidate_question.id
    from packet_full_publication packet_item
    join app_private.practice_worksheet_template_questions candidate_question
      on candidate_question.revision_id = packet_item.revision_id
    order by packet_item.ordinal, candidate_question.question_number
    limit 1
  );

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'packet_replay_hash_fixture_missing';
  end if;

  alter table app_private.practice_worksheet_template_questions
  enable trigger practice_worksheet_template_questions_immutable;

  perform published.*
  from packet_full_fixture fixture
  cross join lateral app_private.publish_certified_worksheet_packet(
    fixture.source_packet_raw,
    fixture.release_manifest_raw,
    fixture.worksheet_payloads
  ) published;
  raise exception using
    errcode = 'P0001',
    message = 'packet_replay_hash_corruption_unexpectedly_accepted';
exception
  when sqlstate '55000' then
    if sqlerrm <> 'worksheet_packet_release_replay_not_current' then
      raise;
    end if;
end;
$packet_replay_hash_corruption$;

-- Packet two uses its own current actors but reuses packet one's 80 canonical
-- revisions. Simulate wall-clock expiry of the earlier actors while preserving
-- historically valid review/release timestamps. Packet-two replay must inspect
-- each original item attester, not just its own header actors. The exception
-- subtransaction restores all timestamps, qualifications, and trigger states.
do $packet_replay_expired_overlap_attesters$
begin
  alter table app_private.practice_worksheet_template_reviews
  disable trigger practice_worksheet_template_reviews_immutable;
  update app_private.practice_worksheet_template_reviews review
  set reviewed_at = now() - interval '3 hours'
  where review.id in (
    select packet_item.review_id from packet_first_publication packet_item
  );
  alter table app_private.practice_worksheet_template_reviews
  enable trigger practice_worksheet_template_reviews_immutable;

  alter table app_private.practice_worksheet_template_releases
  disable trigger practice_worksheet_template_releases_immutable;
  update app_private.practice_worksheet_template_releases release
  set released_at = now() - interval '2 hours'
  where release.id in (
    select packet_item.release_id from packet_first_publication packet_item
  );
  alter table app_private.practice_worksheet_template_releases
  enable trigger practice_worksheet_template_releases_immutable;

  alter table app_private.practice_worksheet_bank_reviewers
  disable trigger practice_worksheet_bank_reviewers_guard_coverage;
  update app_private.practice_worksheet_bank_reviewers reviewer
  set expires_at = now() - interval '1 hour'
  where reviewer.user_id in (
    ${sqlLiteral(reviewerId)}::uuid,
    ${sqlLiteral(releaserId)}::uuid
  );
  alter table app_private.practice_worksheet_bank_reviewers
  enable trigger practice_worksheet_bank_reviewers_guard_coverage;

  perform published.*
  from packet_full_fixture fixture
  cross join lateral app_private.publish_certified_worksheet_packet(
    fixture.source_packet_raw,
    fixture.release_manifest_raw,
    fixture.worksheet_payloads
  ) published;
  raise exception using
    errcode = 'P0001',
    message = 'packet_replay_expired_overlap_attesters_unexpectedly_accepted';
exception
  when sqlstate '55000' then
    if sqlerrm <> 'worksheet_packet_release_replay_not_current' then
      raise;
    end if;
end;
$packet_replay_expired_overlap_attesters$;

select * from finish();
rollback;`;
}

async function prepareRegressionInput(
  reviewPacketPath: string,
  actors: { reviewerId: string; releaserId: string },
) {
  const sourcePacketRaw = await readFile(reviewPacketPath, "utf8");
  const packet = JSON.parse(sourcePacketRaw) as {
    packet_id: string;
    worksheets: PacketEntry[];
  };
  const report = packet.packet_id.includes("full-coverage")
    ? await verifyWorksheetFullCoverageReviewPacket(packet, repositoryRoot)
    : await verifyWorksheetReviewPacket(packet, repositoryRoot);
  if (!report.ok) {
    throw new Error(report.errors.join("\n"));
  }

  const reviewedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const releaseAuthorizedAt = new Date(Date.now() - 60 * 1000).toISOString();
  const manifest = {
    schema_version: 1,
    artifact_kind: "qualified_human_worksheet_release_manifest",
    source_packet_id: packet.packet_id,
    source_packet_sha256: sha256(sourcePacketRaw),
    status: "qualified_human_approved_for_release",
    reviewed_at: reviewedAt,
    release_authorized_at: releaseAuthorizedAt,
    reviewer_id: actors.reviewerId,
    releaser_id: actors.releaserId,
    review_checklist: {
      structural_valid: true,
      ambiguity_free: true,
      no_answer_leakage: true,
      level_fit: true,
      topic_fit: true,
      type_balance: true,
      scoring_safe: true,
    },
    review_notes:
      "Test-only packet regression review; this is never launch approval evidence.",
    release_notes:
      "Test-only packet regression release; the surrounding transaction always rolls back.",
    worksheets: packet.worksheets.map((entry) => ({
      template_key: entry.template_key,
      current_sha256: entry.current_sha256,
      decision: "approved",
    })),
  };

  const payloads = [];
  for (const entry of packet.worksheets) {
    const absolutePath = resolve(repositoryRoot, entry.current_file_path);
    const handle = await open(
      absolutePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    let raw: string;
    try {
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    if (sha256(raw) !== entry.current_sha256) {
      throw new Error(`Hash drift for ${entry.template_key}.`);
    }
    const rawWorksheet = JSON.parse(raw) as unknown;
    const lossless = createLosslessValidatedWorksheet({
      rawWorksheet,
      worksheet: validateWorksheet(rawWorksheet),
      templateKey: entry.template_key,
    });
    payloads.push({
      template_key: entry.template_key,
      source_file_path: entry.current_file_path,
      source_sha256: entry.current_sha256,
      worksheet: createReleaseSafeWorksheet({
        worksheet: lossless,
        sourcePacketId: packet.packet_id,
        templateKey: entry.template_key,
      }),
    });
  }

  return {
    sourcePacketRaw,
    releaseManifestRaw: JSON.stringify(manifest),
    payloads,
  };
}

async function main(argv = process.argv.slice(2)) {
  const expectedFlag = argv.indexOf("--expected-project-ref");
  const expectedProjectRef =
    expectedFlag >= 0 ? (argv[expectedFlag + 1] ?? "") : "";
  if (
    argv.length !== 2 ||
    expectedFlag !== 0 ||
    !projectRefPattern.test(expectedProjectRef)
  ) {
    throw new Error(
      "Usage: pnpm --dir scripts test:worksheet-packet:linked --expected-project-ref <20-character-project-ref>",
    );
  }

  const linkedProjectRef = await readFile(
    resolve(repositoryRoot, "supabase/.temp/project-ref"),
    "utf8",
  );
  assertLinkedProjectIdentity(linkedProjectRef, expectedProjectRef);

  const [priority, full] = await Promise.all([
    prepareRegressionInput(priorityReviewPacketPath, {
      reviewerId,
      releaserId,
    }),
    prepareRegressionInput(fullReviewPacketPath, {
      reviewerId: fullReviewerId,
      releaserId: fullReleaserId,
    }),
  ]);
  const sql = buildCertifiedWorksheetPacketRegressionSql({ priority, full });
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "schreiben-worksheet-packet-regression-"),
  );
  const sqlPath = join(temporaryDirectory, "regression.sql");
  try {
    await createPinnedSupabaseWorkdir(temporaryDirectory, expectedProjectRef);
    await writeFile(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    const result = spawnSync(
      process.env.PNPM_BIN || "pnpm",
      [
        "dlx",
        "supabase@2.109.1",
        "--workdir",
        temporaryDirectory,
        "db",
        "query",
        "--linked",
        "--file",
        sqlPath,
      ],
      { stdio: "inherit", env: process.env },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `worksheet packet linked regression failed with exit code ${result.status ?? "unknown"}.`,
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const isMainModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Worksheet packet linked regression failed.",
    );
    process.exitCode = 1;
  });
}
