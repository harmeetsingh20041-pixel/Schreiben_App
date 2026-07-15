import assert from "node:assert/strict";
import test from "node:test";
import {
  SEC009_FIXTURE,
  buildApproveRaceSql,
  buildCleanupSql,
  buildIdempotentRereadSql,
  buildRejectRaceSql,
  buildSetupSql,
  buildZeroResidueSql,
} from "./run-join-decision-race.js";

test("SEC-009 uses only fixed synthetic fixture identities", () => {
  const setup = buildSetupSql();

  assert.match(SEC009_FIXTURE.teacherEmail, /@example\.test$/);
  assert.match(SEC009_FIXTURE.studentEmail, /@example\.test$/);
  for (const value of Object.values(SEC009_FIXTURE)) {
    assert.match(setup, new RegExp(value.replaceAll("-", "\\-")));
  }
  assert.match(setup, /app_private\.teacher_entitlements/);
  assert.doesNotMatch(setup, /sprachflug|harmeet|sharmeet/i);
});

test("both race sessions call only the reviewed authenticated decision API", () => {
  const approve = buildApproveRaceSql();
  const reject = buildRejectRaceSql();

  for (const sql of [approve, reject]) {
    assert.match(sql, /set local role authenticated;/);
    assert.match(sql, /from api\.decide_batch_join\(/);
    assert.match(sql, /request\.jwt\.claims/);
    assert.doesNotMatch(
      sql,
      /(?:insert\s+into|update|delete\s+from)\s+public\.batch_join_requests/i,
    );
  }
  assert.match(approve, /for update;/);
  assert.match(approve, /pg_advisory_xact_lock/);
  assert.match(approve, /pg_sleep\(12\)/);
  assert.match(approve, /statement_timeout = '25s'/);
  assert.match(reject, /statement_timeout = '25s'/);
});

test("cleanup is exact, bounded, idempotent, and avoids fuzzy mutation", () => {
  const cleanup = buildCleanupSql();

  assert.match(cleanup, /^\s*begin;/);
  assert.match(cleanup, /commit;\s*$/);
  assert.match(cleanup, /lock_timeout = '5s'/);
  assert.match(cleanup, /statement_timeout = '15s'/);
  assert.doesNotMatch(cleanup, /\btruncate\b|\bilike\b/i);
  for (const value of Object.values(SEC009_FIXTURE)) {
    assert.match(cleanup, new RegExp(value.replaceAll("-", "\\-")));
  }
  for (const relation of [
    "batch_join_requests",
    "batch_students",
    "workspace_members",
    "batch_join_codes",
    "onboarding_progress",
    "usage_events",
    "teacher_entitlements",
  ]) {
    assert.match(cleanup, new RegExp(relation));
  }
});

test("terminal reread and zero-residue checks fail closed", () => {
  const reread = buildIdempotentRereadSql();
  const residue = buildZeroResidueSql();

  assert.match(reread, /api\.decide_batch_join\([^;]+, 'approved'\)/s);
  assert.match(reread, /sec009_idempotent_decision_changed/);
  assert.match(reread, /sec009_idempotent_membership_duplicated/);
  assert.match(reread, /sec009_idempotent_assignment_duplicated/);

  for (const relation of [
    "auth.users",
    "public.profiles",
    "public.workspaces",
    "public.batches",
    "app_private.batch_join_codes",
    "public.batch_join_requests",
    "public.workspace_members",
    "public.batch_students",
    "app_private.onboarding_progress",
    "public.usage_events",
    "app_private.teacher_entitlements",
    "app_private.batch_join_attempt_windows",
    "app_private.practice_processor_kick_windows",
    "app_private.writing_processor_kick_windows",
    "app_private.writing_submission_daily_usage",
  ]) {
    assert.match(residue, new RegExp(relation.replaceAll(".", "\\.")));
  }
  assert.match(residue, /pg_class/);
  assert.match(residue, /pg_proc/);
  assert.match(residue, /pg_trigger/);
  assert.doesNotMatch(residue, /pg_extension|'dblink'|'pgtap'/);
  assert.match(residue, /sec009_cleanup_residue_detected/);
});
