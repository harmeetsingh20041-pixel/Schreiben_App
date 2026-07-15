import assert from "node:assert/strict";
import test from "node:test";

import { buildLinkedImporterRegressionSql } from "./import-practice-worksheet.linked-regression.js";

test("linked importer regression is exact-fixture and outer-rollback only", () => {
  const sql = buildLinkedImporterRegressionSql();

  assert.match(sql, /^begin;/);
  assert.match(sql, /actual_assertion_count <> 28/);
  assert.match(sql, /rollback;\n\ndo \$importer_residue_guard\$/);
  assert.match(sql, /IMPORTER_IN_QUERY_ROLLBACK_CONFIRMED/);
  assert.equal((sql.match(/do \$worksheet_import\$/g) ?? []).length, 10);
  assert.equal(
    (
      sql.match(
        /select pg_temp\.importer_(?:ok|is|isnt|matches|throws_ok)\(/g,
      ) ?? []
    ).length,
    28,
  );
  assert.match(sql, /d7020001-0001-4001-8001-000000000001/);
  assert.match(sql, /Phase 12X Importer Linked 20260712 Invalid Item/);
  assert.match(sql, /A validated answer contract is required\./);
  assert.match(sql, /Reviewer must be an active owner or teacher/);
  assert.doesNotMatch(sql, /^\s*commit\s*;/im);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+(?:table|schema|database)\b/i);
});
