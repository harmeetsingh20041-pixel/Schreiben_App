import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const callsites = [
  "../../supabase/functions/kick-writing-jobs/index.ts",
  "../../supabase/functions/generate-practice-worksheet/index.ts",
  "../../supabase/functions/evaluate-practice-attempt/index.ts",
  "../../supabase/functions/recover-async-jobs/handler.ts",
] as const;

test("private worker wake-ups use the modern Supabase API-key header contract", () => {
  for (const relativePath of callsites) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /serviceFunctionHeaders\(/, relativePath);
    assert.doesNotMatch(
      source,
      /Authorization\s*:\s*`Bearer\s+\$\{(?:serviceKey|secret)\}`/,
      relativePath,
    );
  }
});

test("the shared admin client strips only an opaque secret-key Bearer", () => {
  const source = readFileSync(
    new URL(
      "../../supabase/functions/_shared/writing-feedback.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /global:\s*\{\s*fetch:\s*secretKeyAwareFetch\(/);
  assert.match(source, /secretKey\.startsWith\("sb_secret_"\)/);
  assert.match(
    source,
    /headers\.get\("Authorization"\)\s*===\s*`Bearer \$\{secretKey\}`/,
  );
  assert.match(source, /headers\.delete\("Authorization"\)/);
});
