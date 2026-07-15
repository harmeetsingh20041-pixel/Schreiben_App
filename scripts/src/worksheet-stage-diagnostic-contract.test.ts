import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKSHEET_DIAGNOSTIC_STAGES = [
  "primary_generation",
  "primary_fallback_generation",
  "primary_critique",
  "repair_generation",
  "repair_critique",
] as const;

test("worksheet full diagnostic and operator docs retain the privacy and dual-critic contract", async () => {
  const [diagnostic, stageDiagnostic, validation, testing, runbook] =
    await Promise.all([
      readFile(
        resolve(
          ROOT,
          "supabase/functions/provider-transport-diagnostic/index.ts",
        ),
        "utf8",
      ),
      readFile(
        resolve(
          ROOT,
          "supabase/functions/provider-transport-diagnostic/worksheet-stage-diagnostic.ts",
        ),
        "utf8",
      ),
      readFile(
        resolve(ROOT, "supabase/functions/_shared/worksheet-validation.ts"),
        "utf8",
      ),
      readFile(resolve(ROOT, "docs/TESTING.md"), "utf8"),
      readFile(resolve(ROOT, "docs/V1_LAUNCH_RUNBOOK.md"), "utf8"),
    ]);
  const start = diagnostic.indexOf("async function checkFullWorksheetPipeline");
  const end = diagnostic.indexOf("function criticDiagnosticResult", start);
  assert(start >= 0 && end > start);
  const fullPipelineDiagnostic = diagnostic.slice(start, end);

  assert.match(
    fullPipelineDiagnostic,
    /generatePrimaryWorksheetCandidate\(\{/,
  );
  assert.match(
    fullPipelineDiagnostic,
    /generatePrimaryFallbackWorksheetCandidate\(\{/,
  );
  assert.match(
    fullPipelineDiagnostic,
    /isPrimaryGeneratorFallbackEligible\(error\)/,
  );
  assert.match(
    fullPipelineDiagnostic,
    /validateWorksheetCandidateWithDualCritics\(\{/,
  );
  assert.match(
    fullPipelineDiagnostic,
    /generateRepairWorksheetCandidate\(\{/,
  );
  assert.match(
    fullPipelineDiagnostic,
    /candidateAttempt:\s*2/,
  );
  assert.match(
    fullPipelineDiagnostic,
    /providerLifecycleHooks:\s*stageDiagnostic\.hooks/,
  );
  assert.match(
    fullPipelineDiagnostic,
    /stages:\s*stageDiagnostic\.snapshot\(\)/,
  );
  assert.doesNotMatch(
    fullPipelineDiagnostic,
    /(?:generator_model|attempt_count|checks|rejection_reasons|rejected_candidates|question_count)\s*:/,
  );
  assert.match(
    stageDiagnostic,
    /WORKSHEET_STAGE_DIAGNOSTIC_FIELDS\s*=\s*\[\s*"stage",\s*"generation_source",\s*"elapsed_ms",\s*"safe_error_code",?\s*\]/,
  );
  assert.doesNotMatch(
    stageDiagnostic,
    /(?:prompt|question|answer|hash|model|body|rejection)[a-z_]*\s*:/i,
  );
  assert.match(
    validation,
    /const \[deepSeekResult, geminiResult\] = await Promise\.allSettled\(\[/,
  );
  assert.match(
    validation,
    /deepSeekEvidence\.approved\s*&&\s*geminiEvidence\.approved/,
  );

  for (const stage of WORKSHEET_DIAGNOSTIC_STAGES) {
    assert.match(stageDiagnostic, new RegExp(`\\b${stage}\\b`));
    assert.match(testing, new RegExp(`\\b${stage}\\b`));
    assert.match(runbook, new RegExp(`\\b${stage}\\b`));
  }
  assert.match(testing, /staging-only/i);
  assert.match(testing, /never a\s+production release artifact/i);
  assert.match(
    testing,
    /stage.*generation_source.*elapsed_ms.*safe_error_code/is,
  );
  assert.match(
    runbook,
    /completed checkpointed\s+generation stage is not repeated/i,
  );
  assert.match(runbook, /partial evidence can never authorize release/i);
  assert.match(runbook, /both critics remain mandatory/i);
});

test("Edge and database pin the same primary fallback allowlist", async () => {
  const [generation, migration] = await Promise.all([
    readFile(
      resolve(ROOT, "supabase/functions/_shared/worksheet-generation.ts"),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260712100653_resumable_worksheet_generation_checkpoints.sql",
      ),
      "utf8",
    ),
  ]);
  const edgeBlock = generation.match(
    /PRIMARY_WORKSHEET_FALLBACK_CODES\s*=\s*\[([\s\S]*?)\]\s+as const/,
  )?.[1];
  assert(edgeBlock, "Missing Edge primary fallback allowlist.");
  const edgeCodes = [...edgeBlock.matchAll(/"([a-z0-9_]+)"/g)].map(
    (match) => match[1]!,
  );
  const constraintBlock = migration.match(
    /fallback_failure_code in \(([\s\S]*?)\)\s+and fallback_queue_message_id/,
  )?.[1];
  const rpcBlock = migration.match(
    /if primary_failure_code not in \(([\s\S]*?)\) then/,
  )?.[1];
  assert(constraintBlock, "Missing checkpoint fallback constraint allowlist.");
  assert(rpcBlock, "Missing checkpoint fallback RPC allowlist.");
  const sqlCodes = (source: string) =>
    [...source.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]!);

  assert.equal(edgeCodes.length, 31);
  assert.deepEqual(sqlCodes(constraintBlock), edgeCodes);
  assert.deepEqual(sqlCodes(rpcBlock), edgeCodes);
  for (
    const denied of [
      "worksheet_provider_authentication_failed",
      "worksheet_provider_not_configured",
      "worksheet_provider_model_invalid",
      "worksheet_provider_redirect_rejected",
      "worksheet_provider_rejected",
    ]
  ) {
    assert(!edgeCodes.includes(denied), `${denied} must remain fail-closed.`);
  }
});
