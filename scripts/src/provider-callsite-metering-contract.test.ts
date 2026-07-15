import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const FUNCTIONS_ROOT = resolve(ROOT, "supabase/functions");

async function productionTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return productionTypeScriptFiles(path);
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".ts") ||
        entry.name.endsWith(".test.ts")
      )
        return [];
      return [path];
    }),
  );
  return nested.flat();
}

const reviewedProviderCallCounts = new Map<string, number>([
  ["_shared/writing-feedback.ts", 1],
  ["_shared/writing-adjudication.ts", 1],
  ["_shared/worksheet-generation.ts", 2],
  ["_shared/worksheet-validation.ts", 2],
  ["process-worksheet-answer-jobs/evaluate.ts", 2],
]);

const lifecycleMarkers = new Map<string, readonly RegExp[]>([
  [
    "_shared/writing-feedback.ts",
    [
      /beforeWritingProviderCall/,
      /recordWritingProviderUsage/,
      /reportWritingProviderNotCalled/,
    ],
  ],
  [
    "_shared/writing-adjudication.ts",
    [
      /beforeWritingProviderCall/,
      /recordWritingProviderUsage/,
      /reportWritingProviderNotCalled/,
    ],
  ],
  [
    "_shared/worksheet-generation.ts",
    [
      /beforeWorksheetProviderCall/,
      /reportWorksheetProviderUsage/,
      /reportWorksheetProviderNotCalled/,
    ],
  ],
  [
    "_shared/worksheet-validation.ts",
    [
      /beforeWorksheetProviderCall/,
      /reportWorksheetProviderUsage/,
      /reportWorksheetProviderNotCalled/,
    ],
  ],
  [
    "process-worksheet-answer-jobs/evaluate.ts",
    [/authorizeProviderCall/, /recordProviderUsage/, /releaseProviderCall/],
  ],
]);

test("provider calls remain inside the reviewed metered wrappers", async () => {
  const files = await productionTypeScriptFiles(FUNCTIONS_ROOT);
  const observed = new Map<string, number>();

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const count = source.match(/\.complete\s*\(/g)?.length ?? 0;
    if (count > 0) {
      observed.set(relative(FUNCTIONS_ROOT, file), count);
    }
    assert.doesNotMatch(source, /https:\/\/api\.openai\.com/i, file);
    assert.doesNotMatch(source, /\bOPENAI_API_KEY\b/, file);
  }

  assert.deepEqual(
    [...observed.entries()].sort(),
    [...reviewedProviderCallCounts.entries()].sort(),
  );

  for (const [relativePath, markers] of lifecycleMarkers) {
    const source = await readFile(
      resolve(FUNCTIONS_ROOT, relativePath),
      "utf8",
    );
    for (const marker of markers) assert.match(source, marker, relativePath);
  }
});

test("every production provider worker requires the complete lifecycle", async () => {
  const workers = [
    "process-writing-jobs",
    "process-worksheet-generation-jobs",
    "process-worksheet-answer-jobs",
  ];

  for (const worker of workers) {
    const [processor, index] = await Promise.all([
      readFile(resolve(FUNCTIONS_ROOT, worker, "processor.ts"), "utf8"),
      readFile(resolve(FUNCTIONS_ROOT, worker, "index.ts"), "utf8"),
    ]);
    assert.match(processor, /createProviderLifecycleHooks\s*:/, worker);
    assert.doesNotMatch(
      processor,
      /createProviderLifecycleHooks\s*\?\s*:/,
      worker,
    );
    assert.match(index, /new AiSpendAccountingSession\s*\(/, worker);
    assert.match(index, /accounting\.beforeProviderCall/, worker);
    assert.match(index, /accounting\.recordProviderUsage/, worker);
    assert.match(index, /accounting\.providerNotCalled/, worker);
  }

  const compatibility = await readFile(
    resolve(FUNCTIONS_ROOT, "process-due-feedback/index.ts"),
    "utf8",
  );
  assert.match(compatibility, /new AiSpendAccountingSession\s*\(/);
  assert.match(compatibility, /accounting\.beforeProviderCall/);
  assert.match(compatibility, /accounting\.recordProviderUsage/);
  assert.match(compatibility, /accounting\.providerNotCalled/);
});
