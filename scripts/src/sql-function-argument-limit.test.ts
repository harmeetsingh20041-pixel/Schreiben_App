import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SUMMARY_FUNCTION =
  "create or replace function public.get_practice_assignment_summary_internal";

function summaryDefinition(source: string) {
  const start = source.indexOf(SUMMARY_FUNCTION);
  assert.notEqual(start, -1, "practice summary function is missing");
  const end = source.indexOf("\n$$;", start);
  assert.notEqual(end, -1, "practice summary function terminator is missing");
  return source.slice(start, end);
}

function jsonbBuildObjectArgumentCounts(source: string) {
  const marker = "jsonb_build_object(";
  const counts: number[] = [];
  let searchFrom = 0;

  while (true) {
    const callStart = source.indexOf(marker, searchFrom);
    if (callStart === -1) return counts;
    let depth = 1;
    let argumentCount = 1;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let cursor = callStart + marker.length;

    for (; cursor < source.length && depth > 0; cursor += 1) {
      const character = source[cursor];
      const next = source[cursor + 1];
      if (inSingleQuote) {
        if (character === "'" && next === "'") cursor += 1;
        else if (character === "'") inSingleQuote = false;
        continue;
      }
      if (inDoubleQuote) {
        if (character === '"' && next === '"') cursor += 1;
        else if (character === '"') inDoubleQuote = false;
        continue;
      }
      if (character === "'") inSingleQuote = true;
      else if (character === '"') inDoubleQuote = true;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 1) argumentCount += 1;
    }

    assert.equal(depth, 0, "unterminated jsonb_build_object call");
    counts.push(argumentCount);
    searchFrom = callStart + marker.length;
  }
}

for (const migration of [
  "../../supabase/migrations/20260711164600_mask_provisional_practice_scores.sql",
  "../../supabase/migrations/20260711164800_phase_12g_explicit_practice_class_context.sql",
]) {
  test(`${migration} keeps practice summary JSON calls below PostgreSQL's argument limit`, () => {
    const source = readFileSync(new URL(migration, import.meta.url), "utf8");
    const argumentCounts = jsonbBuildObjectArgumentCounts(
      summaryDefinition(source),
    );
    assert.equal(argumentCounts.length, 2, "summary must use two bounded objects");
    assert.ok(
      argumentCounts.every((count) => count <= 100 && count % 2 === 0),
      `invalid jsonb_build_object argument counts: ${argumentCounts.join(", ")}`,
    );
  });
}
