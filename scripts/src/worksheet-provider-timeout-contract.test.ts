import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

function numericConstant(source: string, name: string) {
  const raw = source.match(
    new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)\\s*;`),
  )?.[1];
  assert(raw, `Missing explicit ${name}.`);
  const value = Number(raw.replaceAll("_", ""));
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be positive.`);
  return value;
}

test("worksheet critic timeouts and the global latency ceiling cannot drift", async () => {
  const [generation, validation, diagnostic, runbook] = await Promise.all([
    readFile(
      resolve(ROOT, "supabase/functions/_shared/worksheet-generation.ts"),
      "utf8",
    ),
    readFile(
      resolve(ROOT, "supabase/functions/_shared/worksheet-validation.ts"),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/functions/provider-transport-diagnostic/index.ts",
      ),
      "utf8",
    ),
    readFile(resolve(ROOT, "docs/V1_LAUNCH_RUNBOOK.md"), "utf8"),
  ]);

  const deepSeekCriticMs = numericConstant(
    generation,
    "WORKSHEET_CRITIC_TIMEOUT_MS",
  );
  const geminiCriticMs = numericConstant(
    generation,
    "WORKSHEET_SECONDARY_CRITIC_TIMEOUT_MS",
  );
  const providerDeadlineMs = numericConstant(
    generation,
    "WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS",
  );
  const durableGeminiGenerationMs = numericConstant(
    generation,
    "WORKSHEET_REPAIR_GENERATOR_TIMEOUT_MS",
  );

  assert.equal(deepSeekCriticMs, 20_000);
  assert.equal(geminiCriticMs, 20_000);
  assert.equal(durableGeminiGenerationMs, 55_000);
  assert.equal(providerDeadlineMs, 85_000);
  assert(providerDeadlineMs < 90_000);
  assert.doesNotMatch(
    generation,
    /WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS\s*=\s*WORKSHEET_MAX_PROVIDER_PATH_MS/,
  );

  const reservationBarrier = validation.indexOf(
    "await authorizeDualCriticCalls({",
  );
  const postReservationBudget = validation.indexOf(
    "deepSeekTimeoutMs = worksheetProviderStageTimeout({",
    reservationBarrier,
  );
  const criticDispatch = validation.indexOf(
    "const [deepSeekResult, geminiResult] = await Promise.allSettled([",
    postReservationBudget,
  );
  assert(reservationBarrier >= 0, "Missing dual-critic reservation barrier.");
  assert(
    postReservationBudget > reservationBarrier,
    "Critic transport time must be computed after spend reservation.",
  );
  assert(
    criticDispatch > postReservationBudget,
    "No critic may dispatch before its post-reservation deadline check.",
  );
  assert.match(
    validation.slice(postReservationBudget, criticDispatch),
    /capMs:\s*WORKSHEET_CRITIC_TIMEOUT_MS/,
  );
  assert.match(
    validation.slice(postReservationBudget, criticDispatch),
    /capMs:\s*WORKSHEET_SECONDARY_CRITIC_TIMEOUT_MS/,
  );
  assert.equal(
    validation
      .slice(postReservationBudget, criticDispatch)
      .match(/reserveMs:\s*AI_SPEND_ACCOUNTING_RPC_TIMEOUT_MS/g)?.length,
    2,
    "Parallel critic transports must each reserve the one shared settlement window.",
  );
  assert.match(
    validation,
    /WORKSHEET_DUAL_CRITIC_TOTAL_RESERVE_MS\s*=\s*WORKSHEET_DUAL_CRITIC_PASS_TIMEOUT_MS\s*\+\s*AI_SPEND_ACCOUNTING_RPC_TIMEOUT_MS\s*\+\s*1_000/,
  );
  assert.match(validation, /calls:\s*\[deepSeekCall, geminiCall\]/);
  assert.match(
    validation,
    /providerCallKeyPrefix,\s*candidateAttempt: attempt,\s*deadlineAt/,
  );
  assert.match(
    validation,
    /deepSeekResult\.status === "rejected" \|\|\s*geminiResult\.status === "rejected"/,
  );
  assert.match(
    validation,
    /"worksheet_provider_timeout",\s*"worksheet_provider_deadline_exceeded"/,
  );
  assert.match(
    validation,
    /deepSeekEvidence\.approved\s*&&\s*geminiEvidence\.approved/,
  );
  assert.match(
    validation,
    /if \(Date\.now\(\) >= args\.deadlineAt\) \{\s*throw new WorksheetGenerationError\(\s*"worksheet_provider_deadline_exceeded",\s*true/,
  );
  assert.equal(
    validation.match(/timeoutProfile:\s*"durable_stage"/g)?.length,
    2,
    "Both separately queued Gemini generation stages need the extended ceiling.",
  );
  assert.match(
    generation,
    /args\.timeoutProfile === "durable_stage"\s*\? WORKSHEET_REPAIR_GENERATOR_TIMEOUT_MS\s*:\s*WORKSHEET_SECONDARY_FALLBACK_TIMEOUT_MS/,
  );
  assert.match(
    diagnostic,
    /timeoutMs:\s*WORKSHEET_MCQ_SAFE_GENERATOR_TIMEOUT_MS,\s*timeoutProfile:\s*"durable_stage",\s*providerOutageRecoveryEligible:\s*true,\s*generationProfile:\s*"mcq_safe"/,
  );

  assert.match(diagnostic, /timeoutMs:\s*WORKSHEET_CRITIC_TIMEOUT_MS/);
  assert.match(
    diagnostic,
    /timeoutMs:\s*WORKSHEET_SECONDARY_CRITIC_TIMEOUT_MS/,
  );

  const worksheetSection = runbook.match(
    /Worksheet generation uses a dual-provider gate\.([\s\S]*?)\n\nAll three AI workflows/,
  )?.[1];
  assert(worksheetSection, "Missing worksheet provider section in runbook.");
  assert.match(worksheetSection, /share\s+the\s+20-second\s+window/);
  assert.match(worksheetSection, /Gemini critic share\s+the\s+20-second\s+window/);
  assert.match(worksheetSection, /both verdicts are mandatory/i);
  assert.match(worksheetSection, /spend-reservation RPC\s+time consumes/);
  assert.match(
    worksheetSection,
    /five-second accounting settlement\s+window is reserved inside the same 85-second budget/i,
  );
  assert.match(
    worksheetSection,
    /late finalized critic output is\s+retried and cannot be accepted/i,
  );
  assert.match(
    worksheetSection,
    /ordinary transport delivery remains capped at three claims/i,
  );
  assert.match(
    worksheetSection,
    /attempt history stays\s+monotonic and has a hard ceiling of five/i,
  );
  assert.match(
    worksheetSection,
    /stage continuation triggers an immediate bounded worker wakeup/i,
  );
  assert.match(
    worksheetSection,
    /transport windows are computed only\s+after both reservations settle/,
  );
  assert.match(worksheetSection, /dynamically\s+clipped/i);
  assert.match(
    worksheetSection,
    new RegExp(
      `hard provider deadline\\s+remains ${providerDeadlineMs / 1_000} seconds`,
    ),
  );
  assert.match(worksheetSection, /below the 90-second product\s+target/);
  assert.match(
    worksheetSection,
    /separately queued Gemini generation stages receive a\s+55-second ceiling/i,
  );
  assert.match(
    worksheetSection,
    /legacy inline fallback remains capped at 25 seconds/i,
  );
});

test("AI spend RPCs remain abortable and bounded before provider dispatch", async () => {
  const [accounting, workerApi, runbook] = await Promise.all([
    readFile(
      resolve(ROOT, "supabase/functions/_shared/ai-spend-accounting.ts"),
      "utf8",
    ),
    readFile(resolve(ROOT, "supabase/functions/_shared/worker-api.ts"), "utf8"),
    readFile(resolve(ROOT, "docs/V1_LAUNCH_RUNBOOK.md"), "utf8"),
  ]);
  assert.equal(
    numericConstant(accounting, "AI_SPEND_ACCOUNTING_RPC_TIMEOUT_MS"),
    5_000,
  );
  assert.equal(accounting.match(/await this\.#callRpc\(/g)?.length, 3);
  assert.match(accounting, /signal:\s*controller\.signal/);
  assert.match(accounting, /ai_spend_accounting_timeout/);
  assert.match(workerApi, /request\.abortSignal\(options\.signal\)/);
  assert.match(workerApi, /Promise\.race\(\[operation, aborted\]\)/);
  assert.match(
    runbook,
    /reserve, finalize, and release RPCs abort after five seconds/i,
  );
  assert.match(runbook, /uncertain reservation remains\s+for reconciliation/i);
});
