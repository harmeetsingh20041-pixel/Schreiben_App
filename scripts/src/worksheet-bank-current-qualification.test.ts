import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260713070804_require_current_worksheet_reviewer_qualification.sql",
    import.meta.url,
  ),
  "utf8",
);
const productionPreflight = await readFile(
  new URL("../../docs/PRODUCTION_PREFLIGHT.md", import.meta.url),
  "utf8",
);

test("canonical worksheet selection and clone reuse require current attesters", () => {
  assert.match(
    migration,
    /create or replace function app_private\.practice_test_canonical_revision_is_current\([\s\S]*reviewer\.expires_at > greatest\(review\.reviewed_at, now\(\)\)[\s\S]*releaser\.expires_at > greatest\(release\.released_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /create or replace function public\.select_released_worksheet_template_internal\([\s\S]*reviewer\.expires_at > greatest\(review\.reviewed_at, now\(\)\)[\s\S]*releaser\.expires_at > greatest\(release\.released_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /revision\.content_sha256 =\s*app_private\.practice_worksheet_template_revision_sha256\(\s*revision\.id\s*\)/,
  );
  assert.match(
    migration,
    /app_private\.clone_released_worksheet_template\(uuid,uuid\)[\s\S]*reviewer\.expires_at > greatest\(selected_review\.reviewed_at, now\(\)\)[\s\S]*releaser\.expires_at > greatest\(selected_release\.released_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /revoke all on function app_private\.clone_released_worksheet_template\(uuid, uuid\)[\s\S]*from public, anon, authenticated, service_role/,
  );
});

test("withdrawal and reviewer mutation cannot count an expired replacement", () => {
  assert.match(
    migration,
    /replacement_reviewer\.expires_at > greatest\(replacement_review\.reviewed_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /replacement_releaser\.expires_at > greatest\(replacement_release\.released_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /reviewer\.expires_at > greatest\(review\.reviewed_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /releaser\.expires_at > greatest\(release\.released_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /end > greatest\(candidate_review\.reviewed_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /end > greatest\(candidate_release\.released_at, now\(\)\)/,
  );
});

test("gates, publication replay, and packet publication require current signers", () => {
  assert.match(
    migration,
    /app_private\.practice_topic_level_gate_satisfied\(uuid,text,uuid\)[\s\S]*reviewer\.expires_at > greatest\(review\.reviewed_at, now\(\)\)[\s\S]*releaser\.expires_at > greatest\(release\.released_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /practice_worksheet_template_revision_sha256\(revision\.id\)[\s\S]*practice_worksheet_template_withdrawals[\s\S]*practice_topic_level_gate_revision_integrity_patch_mismatch/,
  );
  assert.match(
    migration,
    /app_private\.publish_certified_worksheet_template\(text,jsonb,uuid,uuid,jsonb,text,text\)[\s\S]*reviewer\.expires_at > greatest\(selected_review\.reviewed_at, now\(\)\)[\s\S]*releaser\.expires_at > greatest\(selected_release\.released_at, now\(\)\)/,
  );
  assert.match(
    migration,
    /app_private\.publish_certified_worksheet_packet\(text,text,jsonb\)[\s\S]*reviewer\.expires_at > greatest\(selected_reviewed_at, now\(\)\)[\s\S]*releaser\.expires_at > greatest\(selected_release_authorized_at, now\(\)\)/,
  );
});

test("large-function patches fail closed on any unexpected definition drift", () => {
  const guardedPatchCount = migration.match(/if occurrence_count <> 1 then/g)?.length;
  assert.equal(guardedPatchCount, 15);

  for (const errorCode of [
    "practice_topic_level_gate_reviewer_expiry_patch_mismatch",
    "practice_topic_level_gate_releaser_expiry_patch_mismatch",
    "practice_topic_level_gate_revision_integrity_patch_mismatch",
    "worksheet_bank_publish_replay_reviewer_expiry_patch_mismatch",
    "worksheet_bank_publish_replay_releaser_expiry_patch_mismatch",
    "worksheet_bank_clone_reviewer_expiry_patch_mismatch",
    "worksheet_bank_clone_releaser_expiry_patch_mismatch",
    "worksheet_packet_reviewer_expiry_patch_mismatch",
    "worksheet_packet_releaser_expiry_patch_mismatch",
    "worksheet_bank_withdrawal_reviewer_expiry_patch_mismatch",
    "worksheet_bank_withdrawal_releaser_expiry_patch_mismatch",
    "worksheet_bank_coverage_reviewer_expiry_patch_mismatch",
    "worksheet_bank_coverage_releaser_expiry_patch_mismatch",
    "worksheet_bank_coverage_candidate_reviewer_expiry_patch_mismatch",
    "worksheet_bank_coverage_candidate_releaser_expiry_patch_mismatch",
  ]) {
    assert.match(migration, new RegExp(errorCode));
  }

  assert.doesNotMatch(
    migration,
    /grant execute on function app_private\.(?:practice_test_canonical_revision_is_current|practice_topic_level_gate_satisfied|publish_certified_worksheet_template|clone_released_worksheet_template|publish_certified_worksheet_packet|withdraw_released_worksheet_template|guard_worksheet_bank_reviewer_coverage)/,
  );
  assert.match(
    migration,
    /grant execute on function public\.select_released_worksheet_template_internal\([\s\S]*to service_role/,
  );
});

test("operations get a content-free reviewer qualification renewal warning", () => {
  assert.match(productionPreflight, /worksheet inventory at least daily/i);
  assert.match(
    productionPreflight,
    /reviewer\.expires_at <= now\(\) \+ interval '30 days'/,
  );
  assert.match(productionPreflight, /urgent at 7 days/i);
  assert.match(productionPreflight, /query changes no data/i);
});
