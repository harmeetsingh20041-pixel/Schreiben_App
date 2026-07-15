import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

test("every deployed writing worker requires and threads the complete spend lifecycle", async () => {
  const [canonical, compatibility, processor] = await Promise.all([
    readFile(
      resolve(ROOT, "supabase/functions/process-writing-jobs/index.ts"),
      "utf8",
    ),
    readFile(
      resolve(ROOT, "supabase/functions/process-due-feedback/index.ts"),
      "utf8",
    ),
    readFile(
      resolve(ROOT, "supabase/functions/process-writing-jobs/processor.ts"),
      "utf8",
    ),
  ]);

  for (const [name, source] of [
    ["canonical", canonical],
    ["compatibility", compatibility],
  ] as const) {
    assert.match(source, /new AiSpendAccountingSession\s*\(/, name);
    assert.match(source, /createProviderLifecycleHooks\s*:/, name);
    assert.match(
      source,
      /onBeforeProviderCall:\s*accounting\.beforeProviderCall/,
      name,
    );
    assert.match(
      source,
      /onProviderUsage:\s*accounting\.recordProviderUsage/,
      name,
    );
    assert.match(
      source,
      /onProviderNotCalled:\s*accounting\.providerNotCalled/,
      name,
    );
    assert.match(source, /onProviderNotCalled,\s*\n\s*\}\)/, name);
  }

  assert.match(processor, /createProviderLifecycleHooks:\s*\(args:/);
  assert.doesNotMatch(processor, /createProviderLifecycleHooks\?\s*:/);
  assert.match(processor, /args\.createProviderLifecycleHooks\s*\(/);
  assert.doesNotMatch(processor, /args\.createProviderLifecycleHooks\?\./);
});

test("every Gemini writing generator call threads the complete reservation lifecycle", async () => {
  const source = await readFile(
    resolve(ROOT, "supabase/functions/_shared/writing-feedback.ts"),
    "utf8",
  );
  const callBlocks = [
    ...source.matchAll(
      /await tryGeminiSecondaryFeedback\(\{([\s\S]*?)^\s{4}\}\);/gm,
    ),
  ];

  // Both availability/auth recovery and post-validation recovery deliberately
  // share one independently reviewed generator path. The remaining second
  // callsite is the legacy validated-feedback compatibility path.
  assert.equal(callBlocks.length, 2);
  for (const call of callBlocks) {
    assert.match(call[1], /onBeforeProviderCall:\s*args\.onBeforeProviderCall/);
    assert.match(call[1], /onProviderUsage:\s*args\.onProviderUsage/);
    assert.match(call[1], /onProviderNotCalled:\s*args\.onProviderNotCalled/);
  }
});

test("launch runbook uses the pinned writing provider deadline", async () => {
  const [runbook, adjudication] = await Promise.all([
    readFile(resolve(ROOT, "docs/V1_LAUNCH_RUNBOOK.md"), "utf8"),
    readFile(
      resolve(ROOT, "supabase/functions/_shared/writing-adjudication.ts"),
      "utf8",
    ),
  ]);
  const budgetSource = adjudication.match(
    /WRITING_INDEPENDENT_TOTAL_BUDGET_MS\s*=\s*([\d_]+)\s*;/,
  )?.[1];
  assert(budgetSource, "Missing pinned writing provider deadline.");
  const budgetMs = Number(budgetSource.replaceAll("_", ""));
  assert(Number.isSafeInteger(budgetMs) && budgetMs > 0);
  assert.equal(budgetMs % 1_000, 0);

  const writingSection = runbook.match(
    /Writing release has its own mandatory independent gate\.([\s\S]*?)\n\nProvider availability fallback/,
  )?.[1];
  assert(writingSection, "Missing writing release section in launch runbook.");
  assert.match(
    writingSection,
    new RegExp(`hard provider deadline at ${budgetMs / 1_000} seconds`),
  );
});
