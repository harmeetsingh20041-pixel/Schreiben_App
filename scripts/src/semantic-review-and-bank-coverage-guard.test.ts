import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260713063128_guard_semantic_target_scoring_and_reviewer_coverage.sql",
    import.meta.url,
  ),
  "utf8",
);

test("semantic target errors cannot receive incidental-error credit", () => {
  const transactionBegin = migration.indexOf("\nbegin;\n");
  const preconditionLock = migration.indexOf(
    "lock table public.practice_attempt_question_reviews in share row exclusive mode;",
  );
  const transactionCommit = migration.lastIndexOf("\ncommit;");

  assert.notEqual(transactionBegin, -1);
  assert.notEqual(preconditionLock, -1);
  assert.notEqual(transactionCommit, -1);
  assert(transactionBegin < preconditionLock);
  assert(preconditionLock < transactionCommit);
  assert.match(migration, /\ncommit;\s*$/);
  assert.match(
    migration,
    /lock table public\.practice_attempt_question_reviews in share row exclusive mode;\s*select app_private\.assert_semantic_review_integrity_precondition\(\);/,
  );
  assert.match(
    migration,
    /select app_private\.assert_semantic_review_integrity_precondition\(\);/,
  );
  assert.match(
    migration,
    /semantic_review_integrity_precondition_failed/,
  );
  assert.match(
    migration,
    /target_topic_slug = 'punctuation'[\s\S]*new\.review_status = 'minor_punctuation'/,
  );
  assert.match(
    migration,
    /target_topic_slug = 'capitalization'[\s\S]*new\.review_status = 'capitalization_issue'/,
  );
  assert.match(migration, /semantic_target_review_status_invalid/);
  assert.match(
    migration,
    /before insert or update of[\s\S]*attempt_id[\s\S]*review_status[\s\S]*points_awarded[\s\S]*max_points[\s\S]*on public\.practice_attempt_question_reviews/,
  );
  assert.match(
    migration,
    /join public\.practice_test_attempts attempt[\s\S]*attempt\.assignment_id = assignment\.id[\s\S]*attempt\.practice_test_id = assignment\.practice_test_id/,
  );
  assert.match(migration, /semantic_review_status_points_invalid/);
  assert.match(
    migration,
    /when 'correct' then 1\.00[\s\S]*when 'minor_punctuation' then 1\.00[\s\S]*when 'partially_correct' then 0\.50[\s\S]*when 'capitalization_issue' then 0\.50[\s\S]*when 'incorrect' then 0\.00/,
  );
});

test("reviewer eligibility changes preserve exact certified coverage", () => {
  assert.match(
    migration,
    /before update of active, can_certify, can_release, verified_at, expires_at/,
  );
  assert.match(
    migration,
    /worksheet-bank-withdrawal-coverage[\s\S]*pg_try_advisory_xact_lock/,
  );
  assert.match(migration, /worksheet_bank_coverage_concurrent_change/);
  assert.match(migration, /worksheet_bank_last_active_coverage_required/);
  assert.match(
    migration,
    /candidate_template\.grammar_topic_id =\s*coverage_context\.grammar_topic_id/,
  );
  assert.match(
    migration,
    /candidate_template\.level = coverage_context\.level/,
  );
  assert.match(
    migration,
    /practice_worksheet_template_revision_sha256\([\s\S]*candidate_revision\.id/,
  );
  assert.match(
    migration,
    /practice_worksheet_template_withdrawals[\s\S]*withdrawal\.revision_id = candidate_revision\.id/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function app_private\.guard_(?:semantic_target_review_status|worksheet_bank_reviewer_coverage)/,
  );
});
