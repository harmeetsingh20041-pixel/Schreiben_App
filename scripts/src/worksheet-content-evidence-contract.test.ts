import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

async function source(path: string) {
  return await readFile(resolve(ROOT, path), "utf8");
}

test("explicit worksheet content evidence is hash-bound in both runtimes", async () => {
  const edge = await source(
    "supabase/functions/_shared/worksheet-validation.ts",
  );
  const migration = await source(
    "supabase/migrations/20260713154000_explicit_worksheet_content_check_evidence.sql",
  );
  const pgTap = await source(
    "supabase/tests/database/phase_14c_explicit_worksheet_content_check_evidence_test.sql",
  );

  for (const check of [
    "mini_lesson_scope_accurate",
    "learner_cues_semantically_aligned",
    "examples_rubrics_consistent",
  ]) {
    assert.match(edge, new RegExp(`\\b${check}\\b`));
    assert.match(migration, new RegExp(`'${check}'`));
    assert.match(pgTap, new RegExp(`'${check}'|"${check}"`));
  }

  assert.match(
    edge,
    /export async function worksheetCriticVerdictSha256[\s\S]*return await sha256Hex\(evidence\)/,
  );
  assert.match(
    edge,
    /verdict_sha256: await worksheetCriticVerdictSha256\(evidenceWithoutHash\)/,
  );
  assert.match(
    migration,
    /critic ->> 'verdict_sha256' <>[\s\S]*app_private\.worksheet_critic_verdict_sha256\(critic\)/,
  );
  assert.match(
    pgTap,
    /TypeScript and PostgreSQL agree on candidate and critic verdict hashes/,
  );
});

test("the breaking evidence contract requires a zero-job coordinated rollout", async () => {
  const migration = await source(
    "supabase/migrations/20260713154000_explicit_worksheet_content_check_evidence.sql",
  );

  assert.match(
    migration,
    /lock table app_private\.async_jobs,[\s\S]*app_private\.worksheet_generation_checkpoints[\s\S]*in share row exclusive mode/,
  );
  assert.match(
    migration,
    /job\.job_kind = 'worksheet_generation'[\s\S]*job\.status in \('queued', 'processing', 'retry'\)/,
  );
  assert.match(
    migration,
    /message = 'worksheet_content_evidence_quiet_window_required'/,
  );
  assert.doesNotMatch(
    migration,
    /coalesce\([^)]*content_checks[^)]*(?:checks|true)/i,
  );
});
