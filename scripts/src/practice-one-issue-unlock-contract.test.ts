import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const migration = await readFile(
  path.join(
    root,
    "supabase/migrations/20260713094907_unlock_any_released_practice_issue.sql",
  ),
  "utf8",
);
const keysetMigration = await readFile(
  path.join(
    root,
    "supabase/migrations/20260710091158_phase_11m_grammar_stats_keyset_pagination.sql",
  ),
  "utf8",
);

test("one released issue is centralized across every mature threshold owner", () => {
  assert.match(
    migration,
    /create or replace function app_private\.practice_issue_count_unlocks\(/,
  );
  assert.match(
    migration,
    /coalesce\(target_minor_issue_count, 0\)[\s\S]*\+ coalesce\(target_major_issue_count, 0\)[\s\S]*>= 1/,
  );
  assert.match(migration, /match_count <> 2/);
  assert.match(migration, /match_count <> 1/);
  assert.ok(migration.includes(
    "'app_private.reconcile_practice_topic_internal(uuid,uuid,uuid)'::regprocedure",
  ));
  assert.ok(migration.includes(
    "'public.opt_in_restricted_practice_internal(uuid,text)'::regprocedure",
  ));
});

test("the clean-production migration performs no historical assignment backfill", () => {
  assert.doesNotMatch(migration, /practice_issue_unlock_backfill_jobs/);
  assert.doesNotMatch(migration, /cron\.(?:schedule|unschedule)/);
  assert.doesNotMatch(migration, /for selected_cycle in/i);
  assert.doesNotMatch(migration, /insert into public\.student_practice_assignments/i);
});

test("release validation, level gates, bank selection, and spend controls remain authoritative", () => {
  assert.doesNotMatch(
    migration,
    /create or replace function app_private\.capture_released_practice_evidence/i,
  );
  assert.doesNotMatch(
    migration,
    /create or replace function app_private\.practice_topic_level_gate_satisfied/i,
  );
  assert.doesNotMatch(
    migration,
    /create or replace function app_private\.select_practice_test_for_cycle/i,
  );
  assert.doesNotMatch(
    migration,
    /create or replace function app_private\.ensure_practice_cycle_assignment_(?:core_)?internal/i,
  );
  assert.doesNotMatch(migration, /reserve_ai|ai_spend|paid_generation/i);
});

test("major and repeated-minor topics stay ahead of one-off minor topics", () => {
  assert.match(
    keysetMigration,
    /order by\s+stat\.practice_unlocked desc,\s+stat\.total_major_issues desc,\s+stat\.total_minor_issues desc,\s+stat\.id/,
  );
  assert.match(
    keysetMigration,
    /student_grammar_stats_student_priority_page_idx[\s\S]*practice_unlocked desc,[\s\S]*total_major_issues desc,[\s\S]*total_minor_issues desc/,
  );
});
