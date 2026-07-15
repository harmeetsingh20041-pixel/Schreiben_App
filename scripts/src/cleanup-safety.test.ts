import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function executableSql(source: string) {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

test("the checked-in production cleanup artifact is explicit-ID and rollback-only", async () => {
  const source = await readFile(
    new URL("../../docs/V1_CLEANUP_DRY_RUN.sql", import.meta.url),
    "utf8",
  );
  const sql = executableSql(source);
  assert.doesNotMatch(sql, /\bilike\b/i);
  assert.doesNotMatch(sql, /\b(delete|truncate)\b/i);
  assert.doesNotMatch(sql, /\b(update|merge)\s+(public|auth|app_private)\./i);
  assert.doesNotMatch(sql, /\binsert\s+into\s+(public|auth|app_private)\./i);
  assert.match(sql, /entity_id\s+uuid\s+not\s+null/i);
  assert.match(sql, /primary\s+key\s*\(entity_type,\s*entity_id\)/i);
  assert.match(sql.trim(), /rollback;$/i);
  assert.doesNotMatch(sql, /\bcommit\s*;/i);
});
