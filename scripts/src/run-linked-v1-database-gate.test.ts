import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildFailClosedLinkedSql } from "./run-linked-multi-workspace-regressions.js";
import { v1LinkedDatabaseTests } from "./run-linked-v1-database-gate.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("linked V1 database gate is pinned, rollback-only, and fail-closed", async () => {
  assert.equal(v1LinkedDatabaseTests.length, 31);
  assert.equal(
    v1LinkedDatabaseTests.reduce(
      (total, [, assertions]) => total + assertions,
      0,
    ),
    898,
  );
  assert.doesNotMatch(
    v1LinkedDatabaseTests.map(([fileName]) => fileName).join("\n"),
    /^phase_12e_openai_worksheet_provenance_test\.sql$/m,
  );

  for (const [fileName, assertions] of v1LinkedDatabaseTests) {
    const source = await readFile(
      resolve(repositoryRoot, "supabase/tests/database", fileName),
      "utf8",
    );
    const linkedSql = buildFailClosedLinkedSql({
      source,
      fileName,
      assertions,
    });
    assert.match(linkedSql, /^begin;/);
    assert.match(linkedSql, /linked_pgtap_assertion_failure:/);
    assert.match(linkedSql, /rollback;\n\nselect 'LINKED_PGTAP_PASS:/);
    assert.doesNotMatch(linkedSql, /^\s*commit\s*;/im);
    assert.equal(
      linkedSql.match(/insert into linked_pgtap_results \(line\)/g)?.length,
      assertions,
      `${fileName} must capture every declared pgTAP assertion`,
    );
  }
});

test("terminal AI spend settlement is conservative, terminal-only, and keeps Cron recovery", async () => {
  const migration = await readFile(
    resolve(
      repositoryRoot,
      "supabase/migrations/20260713231137_settle_terminal_ai_spend_reservations.sql",
    ),
    "utf8",
  );

  assert.match(
    migration,
    /selected_job_status not in \('succeeded', 'dead'\)[\s\S]*return 0/,
  );
  assert.match(
    migration,
    /state = 'finalized'[\s\S]*actual_microusd = reservation\.reserved_microusd[\s\S]*billed_input_tokens = 0[\s\S]*billed_output_tokens = 0[\s\S]*usage_estimated = true/,
  );
  assert.match(migration, /after update of status on app_private\.async_jobs/);
  assert.match(
    migration,
    /where reservation\.state = 'reserved'[\s\S]*job\.status in \('succeeded', 'dead'\)/,
  );
  assert.doesNotMatch(migration, /state\s*=\s*'released'/);
  assert.doesNotMatch(migration, /cron\.(?:schedule|unschedule)/);
});

test("worksheet-live spend archival derives and locks the exact A1-B2 fixture level", async () => {
  const migration = await readFile(
    resolve(
      repositoryRoot,
      "supabase/migrations/20260714010000_generalize_worksheet_live_archive_levels.sql",
    ),
    "utf8",
  );

  assert.match(
    migration,
    /create or replace function app_private\.archive_worksheet_live_canary_spend\(\s*target_workspace_id uuid,\s*target_workspace_slug text,\s*target_batch_id uuid,\s*target_provider_assignment_id uuid,\s*target_bank_assignment_id uuid\s*\)/,
  );
  assert.match(
    migration,
    /selected_fixture_level not in \('A1', 'A2', 'B1', 'B2'\)/,
  );
  assert.match(migration, /topic\.level = selected_fixture_level/);
  assert.match(
    migration,
    /bank_topic\.level = selected_fixture_level[\s\S]*selected_fixture_level in \('A1', 'A2'\)[\s\S]*bank_topic\.level = 'A1_A2'/,
  );
  assert.match(migration, /test\.level <> selected_fixture_level/);
  assert.doesNotMatch(migration, /assignment\.worksheet_level = 'A2'/);
  assert.doesNotMatch(migration, /\n\s+and topic\.level = 'A1_A2'/);
  assert.doesNotMatch(migration, /test\.level <> 'A2'/);
  assert.doesNotMatch(
    migration,
    /create or replace function (?:public|api)\.archive_worksheet_live_canary_spend/,
  );

  const batchLock = migration.indexOf("select batch.level");
  const assignmentLock = migration.indexOf("perform assignment.id");
  const topicLock = migration.indexOf("perform topic.id");
  const testLock = migration.indexOf("perform test.id");
  assert.ok(batchLock >= 0 && batchLock < assignmentLock);
  assert.ok(assignmentLock < topicLock);
  assert.ok(topicLock < testLock);
});

test("linked pgTAP capture includes the expanded reviewed assertion set", () => {
  const linkedSql = buildFailClosedLinkedSql({
    fileName: "capture_probe.sql",
    assertions: 4,
    source: `begin;
select plan(4);
select has_function('public', 'probe', array[]::text[]);
select has_schema('public');
select has_view('public', 'probe_view');
select results_eq('select 1', 'values (1)');
select * from finish();
rollback;`,
  });

  assert.equal(
    linkedSql.match(/insert into linked_pgtap_results \(line\)/g)?.length,
    4,
  );
});
