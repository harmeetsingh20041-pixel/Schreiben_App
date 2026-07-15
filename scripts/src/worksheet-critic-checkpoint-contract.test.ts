import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

async function source(path: string) {
  return await readFile(resolve(ROOT, path), "utf8");
}

test("worksheet critic checkpoints bind the exact call and atomic spend state", async () => {
  const checkpoint = await source(
    "supabase/functions/process-worksheet-generation-jobs/checkpoint.ts",
  );
  const migration = await source(
    "supabase/migrations/20260713093110_resumable_worksheet_critic_evidence.sql",
  );

  assert.match(
    checkpoint,
    /worksheet_generation:job_\$\{args\.jobId\}:candidate_\$\{args\.candidateAttempt\}:\$\{args\.evidence\.provider\}:critique/,
  );
  assert.match(
    checkpoint,
    /args\.usage\.call_key !== expectedCallKey[\s\S]*args\.usage\.call_key !== `\$\{expectedCallKey\}_retry`/,
  );
  assert.match(
    checkpoint,
    /args\.candidateAttempt !== 1 && args\.candidateAttempt !== 2/,
  );

  assert.match(
    migration,
    /target_candidate_attempt is null[\s\S]*target_candidate_attempt not in \(1, 2\)/,
  );
  assert.match(
    migration,
    /'worksheet_generation:job_' \|\| selected_job\.id::text[\s\S]*':candidate_' \|\| target_candidate_attempt::text[\s\S]*critic_provider \|\| ':critique'/,
  );
  assert.match(
    migration,
    /expected_retry_call_key := expected_primary_call_key \|\| '_retry'/,
  );
  assert.match(
    migration,
    /not was_replayed[\s\S]*spend_reservation\.state is distinct from 'reserved'[\s\S]*was_replayed[\s\S]*spend_reservation\.state is distinct from 'finalized'/,
  );
  assert.match(
    migration,
    /select finalized\.\*[\s\S]*from app_private\.finalize_ai_spend_reservation\(/,
  );
  assert.match(
    migration,
    /spend_finalization\.replayed is distinct from was_replayed/,
  );
});
