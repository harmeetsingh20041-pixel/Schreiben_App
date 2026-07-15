import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const MIGRATION = resolve(
  ROOT,
  "supabase/migrations/20260713093017_resumable_worksheet_answer_provider_checkpoints.sql",
);
const DATABASE_TEST = resolve(
  ROOT,
  "supabase/tests/database/phase_13x_resumable_worksheet_answer_provider_checkpoints_test.sql",
);

async function source(path: string) {
  return await readFile(resolve(ROOT, path), "utf8");
}

test("answer provider checkpoint is private, version-bound, and terminally deleted", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const databaseTest = await readFile(DATABASE_TEST, "utf8");
  assert.match(
    sql,
    /create table app_private\.worksheet_answer_provider_checkpoints/,
  );
  assert.match(
    sql,
    /alter table app_private\.worksheet_answer_provider_checkpoints\s+enable row level security/i,
  );
  assert.match(
    sql,
    /revoke all on table app_private\.worksheet_answer_provider_checkpoints\s+from public, anon, authenticated, service_role/i,
  );
  assert.match(
    sql,
    /create or replace function api\.get_worksheet_answer_provider_checkpoints\([\s\S]*?security definer/,
  );
  assert.match(
    sql,
    /create or replace function api\.save_worksheet_answer_provider_checkpoint\([\s\S]*?security definer/,
  );
  assert.match(
    sql,
    /create or replace function api\.get_worksheet_answer_adjudication_checkpoint\([\s\S]*?security definer/,
  );
  assert.match(
    sql,
    /create or replace function api\.save_worksheet_answer_adjudication_checkpoint\([\s\S]*?security definer/,
  );
  assert.match(
    sql,
    /primary key \(job_id, checkpoint_role, provider_name\)/,
  );
  assert.match(sql, /checkpoint_role in \('evaluation', 'adjudication'\)/);
  assert.match(sql, /evaluator_contract_version = 1/);
  assert.match(sql, /prompt_contract_version = 1/);
  assert.match(sql, /evidence_sha256 ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(sql, /jsonb_array_length\(normalized_verdict\) between 1 and 3/);
  assert.match(
    sql,
    /provider_name = 'deepseek'[\s\S]*provider_model = 'deepseek-v4-flash'/,
  );
  assert.match(
    sql,
    /provider_name = 'gemini'[\s\S]*provider_model = 'gemini-3\.1-flash-lite'/,
  );
  assert.match(
    sql,
    /checkpoint_role = 'adjudication'[\s\S]*provider_model = 'deepseek-v4-pro'/,
  );
  assert.match(sql, /worksheet_answer_checkpoint_replay_mismatch/g);
  assert.match(
    sql,
    /worksheet_answer_provider_checkpoint_verdict_hash_check[\s\S]*canonical_jsonb_sha256\(normalized_verdict\)/,
  );
  assert.match(
    sql,
    /target_verdict_sha256 is distinct from[\s\S]*canonical_jsonb_sha256\(target_normalized_verdict\)/,
  );
  assert.match(
    sql,
    /select reservation\.\*[\s\S]*from app_private\.ai_spend_reservations[\s\S]*for update/,
  );
  assert.match(
    sql,
    /perform app_private\.finalize_ai_spend_reservation\([\s\S]*target_billed_cached_input_tokens[\s\S]*target_billed_uncached_input_tokens/,
  );
  assert.match(
    sql,
    /assert_worksheet_answer_adjudication_checkpoint_verdict[\s\S]*deepseek_result_sha256[\s\S]*gemini_result_sha256[\s\S]*resolutions/,
  );
  assert.match(
    sql,
    /target_normalized_verdict ->> 'deepseek_result_sha256'[\s\S]*target_normalized_verdict ->> 'gemini_result_sha256'/,
  );
  assert.match(
    sql,
    /spend_reservation\.call_purpose <> 'worksheet_answer_adjudication'/,
  );
  assert.match(
    sql,
    /new\.status in \('succeeded', 'dead'\)[\s\S]*delete from app_private\.worksheet_answer_provider_checkpoints/,
  );
  assert.match(
    sql,
    /after update of status on app_private\.async_jobs/,
  );
  assert.match(
    databaseTest,
    /Pro save rejects a payload whose embedded Flash hash is not exact/,
  );
  assert.match(
    databaseTest,
    /an exact lost-response replay accepts the already finalized invoice/,
  );
  assert.match(
    databaseTest,
    /an expired lease cannot replay even a valid durable Pro checkpoint/,
  );
  assert.match(
    databaseTest,
    /terminal success deletes all transient roles but preserves invoice evidence/,
  );
});

test("answer evaluator reserves and calls only the missing independent provider", async () => {
  const evaluator = await source(
    "supabase/functions/process-worksheet-answer-jobs/evaluate.ts",
  );
  const checkpoint = await source(
    "supabase/functions/process-worksheet-answer-jobs/checkpoint.ts",
  );
  assert.match(evaluator, /canonicalJsonSha256/);
  assert.doesNotMatch(
    evaluator,
    /new TextEncoder\(\)\.encode\(JSON\.stringify\(value\)\)/,
  );
  assert.match(checkpoint, /canonicalJsonSha256/);
  assert.doesNotMatch(
    checkpoint,
    /new TextEncoder\(\)\.encode\(JSON\.stringify\(value\)\)/,
  );
  assert.match(evaluator, /worksheetAnswerEvidenceSha256/);
  assert.match(
    evaluator,
    /WORKSHEET_ANSWER_EVALUATOR_CONTRACT_VERSION = 1/,
  );
  assert.match(evaluator, /WORKSHEET_ANSWER_PROMPT_CONTRACT_VERSION = 1/);
  assert.match(
    evaluator,
    /worksheetAnswerEvidenceSha256[\s\S]*evaluator_contract_version:[\s\S]*prompt_contract_version:/,
  );
  assert.match(
    evaluator,
    /worksheetAnswerProEvidenceSha256[\s\S]*evaluator_contract_version:[\s\S]*prompt_contract_version:/,
  );
  assert.match(evaluator, /student_answer: question\.studentAnswer/);
  assert.match(
    evaluator,
    /\.checkpointStore\.load\([\s\S]*deepSeekModel:[\s\S]*geminiModel:/,
  );
  assert.match(
    evaluator,
    /\.\.\.\(deepSeekCheckpoint \? \[\] : \[deepSeekCall\]\)/,
  );
  assert.match(
    evaluator,
    /\.\.\.\(geminiCheckpoint \? \[\] : \[geminiCall\]\)/,
  );
  assert.match(evaluator, /await args\.checkpointStore!\.save\(/);
  assert.match(
    evaluator,
    /checkpointStore\.loadAdjudication\([\s\S]*checkpointStore!\.saveAdjudication\(/,
  );
  assert.match(
    evaluator,
    /const accountingSlackMs = args\.checkpointStore \|\| args\.onProviderUsage/,
  );
  assert.match(
    evaluator,
    /onValidatedResult: args\.checkpointStore[\s\S]*usage,/,
  );
  assert.match(
    evaluator,
    /deepSeekOutcome\.status === "rejected"[\s\S]*geminiOutcome\.status === "rejected"/,
  );
  assert.match(
    evaluator,
    /if \(deepSeekOutcome\.status === "rejected"\)[\s\S]*throw semanticProviderFailure/,
  );
  assert.match(
    evaluator,
    /if \(geminiOutcome\.status === "rejected"\)[\s\S]*throw semanticProviderFailure/,
  );
  assert.match(checkpoint, /get_worksheet_answer_adjudication_checkpoint/);
  assert.match(checkpoint, /save_worksheet_answer_adjudication_checkpoint/);
  assert.match(
    checkpoint,
    /expected_evaluator_contract_version:[\s\S]*expected_prompt_contract_version:/,
  );
  assert.match(
    checkpoint,
    /target_evaluator_contract_version:[\s\S]*target_prompt_contract_version:/,
  );
});

test("active queue lease is forwarded into the private checkpoint adapter", async () => {
  const processor = await source(
    "supabase/functions/process-worksheet-answer-jobs/processor.ts",
  );
  const entrypoint = await source(
    "supabase/functions/process-worksheet-answer-jobs/index.ts",
  );
  assert.match(processor, /queueMessageId: job\.queue_message_id/);
  assert.match(processor, /workerId: args\.workerId/);
  assert.match(entrypoint, /createWorksheetAnswerCheckpointStore\(\{/);
  assert.match(
    entrypoint,
    /jobId,[\s\S]*queueMessageId,[\s\S]*workerId,[\s\S]*attemptId,[\s\S]*entityVersion/,
  );
});

test("one-sided transient provider loss uses the bounded outage allowlist", async () => {
  const evaluator = await source(
    "supabase/functions/process-worksheet-answer-jobs/evaluate.ts",
  );
  const processor = await source(
    "supabase/functions/process-worksheet-answer-jobs/processor.ts",
  );
  const outageSql = await source(
    "supabase/migrations/20260712010100_phase_12t_launch_cost_guardrails.sql",
  );
  assert.match(
    evaluator,
    /function singleProviderOutageFailure[\s\S]*worksheet_single_provider_timeout[\s\S]*worksheet_single_provider_unavailable[\s\S]*semantic_single_provider_incomplete/,
  );
  assert.match(
    evaluator,
    /isTransientProviderOutage\(deepSeekOutcome\.reason\)[\s\S]*throw singleProviderOutageFailure\(deepSeekOutcome\.reason\)/,
  );
  assert.match(
    evaluator,
    /isTransientProviderOutage\(geminiOutcome\.reason\)[\s\S]*throw singleProviderOutageFailure\(geminiOutcome\.reason\)/,
  );
  assert.match(
    processor,
    /const outageReason = dualProviderOutageReason\(failure\);[\s\S]*const shouldHold = outageReason === null/,
  );
  for (
    const reason of [
      "dual_provider_outage_unavailable",
      "dual_provider_outage_rate_limited",
      "dual_provider_outage_timeout",
    ]
  ) {
    assert.match(outageSql, new RegExp(`'${reason}'`));
  }
});
