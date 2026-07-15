import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

test("writing full diagnostic is fixed-input, real-pipeline, and content-free", async () => {
  const [index, diagnostic, testing, runbook] = await Promise.all([
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
        "supabase/functions/provider-transport-diagnostic/writing-full-diagnostic.ts",
      ),
      "utf8",
    ),
    readFile(resolve(ROOT, "docs/TESTING.md"), "utf8"),
    readFile(resolve(ROOT, "docs/V1_LAUNCH_RUNBOOK.md"), "utf8"),
  ]);

  assert.match(
    diagnostic,
    /WRITING_FULL_DIAGNOSTIC_ORIGINAL_TEXT\s*=\s*\n\s*"Am 12\.07\.2026 beginnt meine Schicht um 7\.30 Uhr\.\\n"\s*\+\s*\n\s*"Ich dokumentiere z\.B\. 2,5 ml\.\\n\\n"\s*\+\s*\n\s*"Danach spreche ich mit die Patientin\."/,
  );
  const start = index.indexOf("async function checkFullWritingPipeline");
  const end = index.indexOf("function syntheticRecoveryCriticPayload", start);
  assert(start >= 0 && end > start, "Missing bounded writing_full pipeline.");
  const pipeline = index.slice(start, end);
  assert.match(
    pipeline,
    /buildFeedbackInputLines\(\s*WRITING_FULL_DIAGNOSTIC_ORIGINAL_TEXT/,
  );
  assert.match(
    pipeline,
    /sha256Text\(\s*WRITING_FULL_DIAGNOSTIC_ORIGINAL_TEXT/,
  );
  assert.match(pipeline, /generateIndependentlyAdjudicatedFeedback\(\{/);
  assert.match(pipeline, /flashModel:\s*DEEPSEEK_V1_FLASH_MODEL/);
  assert.match(pipeline, /proModel:\s*DEEPSEEK_V1_PRO_MODEL/);
  assert.match(pipeline, /geminiSecondary:\s*secondaryProvider/);
  assert.match(pipeline, /articleFormRegressionPassed\(\{/);
  assert.doesNotMatch(
    pipeline,
    /(?:createClient|createAdminClient|\.rpc\(|queue|quota|workspaceId|submissionId)/,
  );

  assert.match(index, /only !== "writing_full"/);
  assert.match(index, /request\.headers\.get\("apikey"\)/);
  assert.match(index, /request\.headers\.get\("x-diagnostic-key"\)/);
  assert.match(index, /Deno\.env\.get\("PROVIDER_DIAGNOSTIC_SECRET"\)/);
  assert.match(index, /Deno\.env\.get\("SUPABASE_SECRET_KEYS"\)/);
  assert.match(
    index,
    /Object\.keys\(requestBody\)\.some\(\(key\) => key !== "only"\)/,
  );
  assert.match(
    index,
    /return Response\.json\(\s*await checkFullWritingPipeline\(deepSeekKey, geminiKey\)/,
  );

  assert.match(
    diagnostic,
    /WRITING_FULL_DIAGNOSTIC_FIELDS\s*=\s*\[\s*"accepted",\s*"safe_code",\s*"total_elapsed_ms",\s*"stages",\s*"article_form_regression_passed",?\s*\]/,
  );
  assert.match(
    diagnostic,
    /WRITING_FULL_DIAGNOSTIC_STAGE_FIELDS\s*=\s*\[\s*"stage",\s*"provider",?\s*\]/,
  );
  assert.match(diagnostic, /MAX_DIAGNOSTIC_PROVIDER_CALLS\s*=\s*6/);
  const outputStart = diagnostic.indexOf(
    "export function createWritingFullDiagnosticOutput",
  );
  assert(outputStart >= 0, "Missing diagnostic output constructor.");
  const outputBuilder = diagnostic.slice(outputStart);
  assert.doesNotMatch(
    outputBuilder,
    /(?:prompt|original|corrected|explanation|hash|token|model|body|error)[a-z_]*\s*:/i,
  );

  for (const document of [testing, runbook]) {
    assert.match(document, /writing_full/);
    assert.match(document, /fixed\s+synthetic A2/i);
    assert.match(document, /content-free/i);
    assert.match(document, /85-second/i);
    assert.match(document, /production artifact/i);
  }
});

test("writing full diagnostic remains excluded from production Edge artifacts", async () => {
  const [inventory, artifactContract] = await Promise.all([
    readFile(resolve(ROOT, "scripts/src/production-edge-functions.ts"), "utf8"),
    readFile(
      resolve(ROOT, "scripts/src/create-production-edge-artifact.test.ts"),
      "utf8",
    ),
  ]);
  const allowlist = inventory.match(
    /APPROVED_PRODUCTION_EDGE_FUNCTIONS\s*=\s*\[([\s\S]*?)\]\s+as const/,
  )?.[1];
  assert(allowlist, "Missing production Edge allowlist.");
  assert.doesNotMatch(allowlist, /provider-transport-diagnostic/);
  assert.match(
    artifactContract,
    /access\(join\(value\.output, "provider-transport-diagnostic"\)\)/,
  );
});

test("staging Gemini health probes are bounded, content-free, and parallel", async () => {
  const index = await readFile(
    resolve(
      ROOT,
      "supabase/functions/provider-transport-diagnostic/index.ts",
    ),
    "utf8",
  );

  assert.match(index, /signal:\s*AbortSignal\.timeout\(15_000\)/);
  assert.match(index, /async function checkGeminiHealth\(/);
  assert.match(index, /error_status:\s*"TRANSPORT_UNAVAILABLE"/);
  assert.match(
    index,
    /only === "gemini_health"[\s\S]*?Promise\.all\([\s\S]*?checkGeminiHealth/,
  );
  assert.doesNotMatch(
    index.slice(
      index.indexOf("async function checkGeminiHealth"),
      index.indexOf("function deepSeekSummary"),
    ),
    /(?:error\.message|String\(error\)|response\.text|api_key|diagnostic_key|secret\s*:)/i,
  );
});
