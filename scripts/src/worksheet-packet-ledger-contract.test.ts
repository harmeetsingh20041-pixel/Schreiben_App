import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const migrationPath = resolve(
  repositoryRoot,
  "supabase/migrations/20260713025410_immutable_worksheet_packet_release_ledger.sql",
);
const migration = await readFile(migrationPath, "utf8");
const hardeningMigration = await readFile(
  resolve(
    repositoryRoot,
    "supabase/migrations/20260713073908_harden_worksheet_packet_replay_and_payload_types.sql",
  ),
  "utf8",
);
const linkedRegression = await readFile(
  resolve(
    repositoryRoot,
    "scripts/src/run-certified-worksheet-packet-regression.ts",
  ),
  "utf8",
);

test("packet release and item ledgers are private, RLS-enabled, guarded, and immutable", () => {
  for (const table of [
    "practice_worksheet_packet_releases",
    "practice_worksheet_packet_release_items",
  ]) {
    assert.match(migration, new RegExp(`create table app_private\\.${table}`));
    assert.match(
      migration,
      new RegExp(
        `alter table app_private\\.${table}\\s+enable row level security`,
      ),
    );
    assert.match(
      migration,
      new RegExp(
        `revoke all on table app_private\\.${table}\\s+from public, anon, authenticated, service_role`,
      ),
    );
  }
  assert.match(migration, /worksheet_packet_release_publisher_required/);
  assert.equal(
    (
      migration.match(
        /execute function app_private\.reject_worksheet_bank_history_mutation\(\)/g,
      ) ?? []
    ).length,
    2,
  );
});

test("the database independently pins both exact non-certifying packet bytes", () => {
  assert.match(
    migration,
    /878802d40e443b965c53b125dac102ae17d1acc85091dc77cb1a8e1ac53ac1b1/,
  );
  assert.match(
    migration,
    /b4ff1c25d4fd43c1cb8d4aa487518dd4a2a8b506a48faa7d89f002ba4b79d916/,
  );
  assert.match(migration, /worksheet_packet_release_packet_not_trusted/);
});

test("release manifests and item bindings reject JSON null instead of passing nullable comparisons", () => {
  for (const field of [
    "artifact_kind",
    "source_packet_id",
    "source_packet_sha256",
    "status",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `jsonb_typeof\\(release_manifest -> '${field}'\\)[\\s\\S]{0,80}is distinct from 'string'`,
      ),
    );
  }
  for (const field of ["decision", "template_key", "current_sha256"]) {
    assert.match(
      migration,
      new RegExp(
        `jsonb_typeof\\(manifest_item -> '${field}'\\)[\\s\\S]{0,80}is distinct from 'string'`,
      ),
    );
  }
  assert.match(
    migration,
    /manifest_item ->> 'decision' is distinct from 'approved'/,
  );
  assert.doesNotMatch(
    migration,
    /(?:release_manifest|manifest_item|payload_item)\s*(?:->>|#>>)[^\n]+<>/,
  );
  for (const path of [
    "{status}",
    "{artifact_kind}",
    "{source_packet_id}",
    "{source_packet_sha256}",
    "{worksheets,0,decision}",
    "{worksheets,0,template_key}",
    "{worksheets,0,current_sha256}",
  ]) {
    assert.match(linkedRegression, new RegExp(`jsonb_set\\([\\s\\S]+?${path.replace(/[{}]/g, "\\$&")}`));
  }
});

test("the packet boundary rejects nested nulls, number strings, and non-string educational arrays", () => {
  assert.match(
    hardeningMigration,
    /create or replace function app_private\.worksheet_packet_payload_item_is_strictly_typed\(/,
  );
  assert.match(
    hardeningMigration,
    /jsonb_typeof\(question\.item -> 'question_number'\)\s+is distinct from 'number'/,
  );
  assert.match(
    hardeningMigration,
    /jsonb_typeof\(question\.item -> 'answer_contract_version'\)\s+is distinct from 'number'/,
  );
  assert.match(
    hardeningMigration,
    /question\.item ->> 'answer_contract_version' is distinct from '1'/,
  );
  assert.match(
    hardeningMigration,
    /jsonb_array_elements\(question\.item -> 'options'\)[\s\S]*jsonb_typeof\(answer_option\.item\) is distinct from 'string'/,
  );
  assert.match(
    hardeningMigration,
    /worksheet_packet_release_payload_invalid/,
  );
  for (const regressionName of [
    "packet_null_answer_contract",
    "packet_string_answer_contract",
    "packet_string_question_number",
    "packet_non_string_option",
  ]) {
    assert.match(linkedRegression, new RegExp(regressionName));
  }
});

test("one private function owns atomic publication and no browser or worker role can execute it", () => {
  assert.match(
    migration,
    /create or replace function app_private\.publish_certified_worksheet_packet\(\s*target_source_packet_raw text,\s*target_release_manifest_raw text,\s*target_worksheet_payloads jsonb\s*\)[\s\S]+?security definer\s+set search_path = ''/,
  );
  assert.match(
    migration,
    /revoke all on function app_private\.publish_certified_worksheet_packet\(\s*text, text, jsonb\s*\)\s+from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function app_private\.publish_certified_worksheet_packet/,
  );
});

test("exact replay binds packet, manifest, and canonical payload hashes while changed or partial replay fails", () => {
  assert.match(
    migration,
    /selected_packet_release\.source_packet_raw <> target_source_packet_raw/,
  );
  assert.match(
    migration,
    /selected_packet_release\.release_manifest_raw <> target_release_manifest_raw/,
  );
  assert.match(
    migration,
    /selected_packet_release\.worksheet_payloads_sha256 <> payloads_hash/,
  );
  assert.match(migration, /worksheet_packet_release_changed_replay/);
  assert.match(migration, /worksheet_packet_release_partial/);
  assert.match(migration, /packet_release_created boolean/);
  assert.match(migration, /item\.canonical_revision_created,\s+false/);
});

test("every effective canonical revision, review, and release is locked through packet commit", () => {
  assert.match(
    migration,
    /for share of revision, review, release;\s+if not found then\s+raise exception using\s+errcode = '55000',\s+message = 'worksheet_packet_release_not_current'/,
  );
  assert.match(
    migration,
    /get diagnostics locked_item_count = row_count;\s+if locked_item_count <> expected_count/,
  );
});

test("first publication and exact replay use current original item attesters and recomputed hashes", () => {
  assert.match(
    hardeningMigration,
    /release\.content_sha256 = item\.content_sha256[\s\S]*join app_private\.practice_worksheet_bank_reviewers reviewer[\s\S]*join app_private\.practice_worksheet_bank_reviewers releaser/,
  );
  assert.match(
    hardeningMigration,
    /revision\.content_sha256 =\s*app_private\.practice_worksheet_template_revision_sha256\(revision\.id\)/,
  );
  assert.match(
    hardeningMigration,
    /practice_worksheet_template_withdrawals withdrawal[\s\S]*withdrawal\.revision_id = revision\.id/,
  );
  assert.equal(
    (
      hardeningMigration.match(
        /for share of revision, review, release, reviewer, releaser/g,
      ) ?? []
    ).length,
    2,
  );
  assert.match(
    linkedRegression,
    /packet_replay_hash_corruption[\s\S]*worksheet_packet_release_replay_not_current/,
  );
  assert.match(
    linkedRegression,
    /packet_replay_expired_overlap_attesters[\s\S]*worksheet_packet_release_replay_not_current/,
  );
  assert.match(linkedRegression, /fullReviewerId/);
  assert.match(linkedRegression, /fullReleaserId/);
});

test("forward-definition patches fail closed without broadening packet publisher authority", () => {
  const expectedDefinitionAnchors = [
    `    join app_private.practice_worksheet_template_releases release
      on release.id = item.release_id
     and release.revision_id = item.revision_id
     and release.review_id = item.review_id
     and release.content_sha256 = item.content_sha256
    where item.packet_release_id = selected_packet_release.id`,
    `      and revision.content_sha256 = item.content_sha256
    for share of revision, review, release;`,
    `    select published_item.*
    into strict published
    from app_private.publish_certified_worksheet_template(`,
    `    join app_private.practice_worksheet_template_releases release
      on release.id = published.release_id
     and release.revision_id = revision.id
     and release.review_id = review.id
    where revision.id = published.revision_id`,
    `      and release.content_sha256 = published.content_sha256
    for share of revision, review, release;`,
  ];
  for (const anchor of expectedDefinitionAnchors) {
    assert.equal(
      migration.split(anchor).length - 1,
      1,
      "each guarded source-definition anchor must match exactly once",
    );
    assert.ok(
      hardeningMigration.includes(anchor),
      "each source-definition anchor must be guarded by the hardening migration",
    );
  }
  for (const errorCode of [
    "worksheet_packet_replay_attester_patch_mismatch",
    "worksheet_packet_replay_integrity_patch_mismatch",
    "worksheet_packet_strict_payload_patch_mismatch",
    "worksheet_packet_publication_attester_patch_mismatch",
    "worksheet_packet_publication_integrity_patch_mismatch",
  ]) {
    assert.match(hardeningMigration, new RegExp(errorCode));
  }
  assert.equal(
    hardeningMigration.match(/if occurrence_count <> 1 then/g)?.length,
    5,
  );
  assert.match(
    hardeningMigration,
    /revoke all on function app_private\.publish_certified_worksheet_packet\([\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    hardeningMigration,
    /grant execute on function app_private\.(?:publish_certified_worksheet_packet|worksheet_packet_payload_item_is_strictly_typed)/,
  );
});

test("the packet function records overlap-safe per-packet item links and never creates student runtime state", () => {
  assert.match(migration, /unique \(packet_release_id, revision_id\)/);
  assert.doesNotMatch(
    migration,
    /insert into public\.(?:practice_tests|practice_test_questions|student_practice_assignments)/,
  );
  assert.doesNotMatch(
    migration,
    /insert into app_private\.async_jobs|pgmq\.(?:send|send_batch)/,
  );
});

test("the rollback-only linked regression covers late failure, replay, audit, and zero runtime mutation", () => {
  assert.match(linkedRegression, /begin;[\s\S]+rollback;`;/);
  assert.match(linkedRegression, /packet_forced_failure/);
  assert.match(
    linkedRegression,
    /late item failure rolls back canonical revisions created by earlier items/,
  );
  assert.match(
    linkedRegression,
    /lost-response replay returns the exact packet and canonical IDs/,
  );
  assert.match(linkedRegression, /changed manifest replay fails closed/);
  assert.match(
    linkedRegression,
    /changed canonical payload replay fails closed/,
  );
  assert.match(
    linkedRegression,
    /canonical packet publication creates no clone, assignment, or async job/,
  );
  assert.match(
    linkedRegression,
    /full packet reuses all 80 overlapping revisions and retains a second packet attestation/,
  );
  assert.match(linkedRegression, /packet_priority_fixture/);
  assert.match(linkedRegression, /packet_full_fixture/);
  assert.equal(
    linkedRegression.match(/\$\{sqlJson\(priority\.payloads\)\}/g)?.length,
    1,
    "the priority payload must cross the linked Management API boundary once",
  );
  assert.equal(
    linkedRegression.match(/\$\{sqlJson\(full\.payloads\)\}/g)?.length,
    1,
    "the full payload must cross the linked Management API boundary once",
  );
  assert.match(linkedRegression, /select plan\(24\)/);
});
