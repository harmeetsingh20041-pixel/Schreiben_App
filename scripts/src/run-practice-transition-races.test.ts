import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PRACTICE_TRANSITION_FIXTURE,
  buildBarrierProbeSql,
  buildBlockedSessionProbeSql,
  buildHarnessSessionDrainProbeSql,
  buildHarnessApplicationSql,
  buildLegacyContextRaceVerificationSql,
  buildLegacyContextRecoverySessionSql,
  buildLegacyHistoricalReassignmentSessionSql,
  buildMvccReconcileSessionSql,
  buildMvccTerminalSessionSql,
  buildMvccVerificationSql,
  buildPracticeTransitionCleanupSql,
  buildPracticeTransitionSetupSql,
  buildPracticeTransitionZeroResidueSql,
  buildTeacherReassignmentSessionSql,
  buildWorkerRaceVerificationSql,
  buildWorkerFixtureTransitionSql,
  buildWorkerSessionSql,
  createPracticeTransitionRaceLifecycle,
} from "./run-practice-transition-races.js";

test("practice-transition races use only fixed synthetic identities", () => {
  const setup = buildPracticeTransitionSetupSql();

  assert.match(PRACTICE_TRANSITION_FIXTURE.teacherEmail, /@example\.test$/);
  assert.match(PRACTICE_TRANSITION_FIXTURE.studentEmail, /@example\.test$/);
  for (const value of Object.values(PRACTICE_TRANSITION_FIXTURE)) {
    assert.match(setup, new RegExp(value.replaceAll("-", "\\-")));
  }
  assert.match(setup, /app_private\.teacher_entitlements/);
  assert.doesNotMatch(setup, /sprachflug|harmeet|sharmeet/i);
});

test("MVCC race blocks a stale selector behind a terminal assignment commit", () => {
  const owner = buildMvccTerminalSessionSql();
  const contender = buildMvccReconcileSessionSql();
  const verification = buildMvccVerificationSql();

  assert.match(owner, /^\s*begin;/);
  assert.match(owner, /set status = 'failed'/);
  assert.match(owner, /pg_advisory_xact_lock\(13162, 1\)/);
  assert.match(owner, /application_name = 'phase13j_mvcc_owner'/);
  assert.match(owner, /lock_timeout = '45s'/);
  assert.match(owner, /statement_timeout = '60s'/);
  assert.match(owner, /pg_sleep\(30\)/);
  assert.match(owner, /commit;\s*$/);

  assert.match(contender, /^\s*begin;/);
  assert.match(contender, /application_name = 'phase13j_mvcc_contender'/);
  assert.match(
    contender,
    /app_private\.ensure_practice_cycle_assignment_internal\(/,
  );
  assert.doesNotMatch(contender, /practice_assignment_cycle_transition_jobs/);
  assert.match(contender, /commit;\s*$/);

  assert.match(verification, /phase13j_mvcc_replacement_created/);
  assert.match(verification, /assignment\.status_revision = 1/);
  assert.match(verification, /job\.processed_at is null/);
  assert.match(verification, /cycle\.active_assignment_id = assignment\.id/);
});

test("worker and teacher race through their reviewed APIs under distinct roles", () => {
  const worker = buildWorkerSessionSql();
  const teacher = buildTeacherReassignmentSessionSql();
  const verification = buildWorkerRaceVerificationSql();

  assert.match(
    worker,
    /practice_assignment_cycle_transition_jobs job[\s\S]+for update;/,
  );
  assert.match(worker, /hashtextextended\(/);
  assert.match(worker, new RegExp(PRACTICE_TRANSITION_FIXTURE.workerTopicId));
  assert.match(worker, /pg_advisory_xact_lock\(13162, 2\)/);
  assert.match(worker, /application_name = 'phase13j_transition_worker'/);
  assert.match(worker, /lock_timeout = '45s'/);
  assert.match(worker, /statement_timeout = '60s'/);
  assert.match(worker, /pg_sleep\(30\)/);
  assert.match(worker, /set local role service_role;/);
  assert.match(worker, /api\.process_practice_cycle_transition_jobs\(10\)/);

  assert.match(teacher, /set local role authenticated;/);
  assert.match(teacher, /application_name = 'phase13j_teacher_reassign'/);
  assert.match(teacher, /request\.jwt\.claims/);
  assert.match(teacher, /api\.reassign_practice_assignment\(/);
  assert.doesNotMatch(
    teacher,
    /(?:insert\s+into|update|delete\s+from)\s+(?:public|app_private)\./i,
  );

  assert.match(verification, /phase13j_worker_active_count_invalid/);
  assert.match(verification, /assignment\.worksheet_level = 'B2'/);
  assert.match(verification, /job\.processed_at is not null/);
  assert.match(verification, /action\.action_revision = 1/);
  assert.match(verification, /action\.related_assignment_id = replacement_id/);
});

test("legacy class recovery overlaps a fast safe historical reassignment rejection", () => {
  const owner = buildLegacyContextRecoverySessionSql();
  const contender = buildLegacyHistoricalReassignmentSessionSql();
  const verification = buildLegacyContextRaceVerificationSql();

  assert.match(owner, /^\s*begin;/);
  assert.match(owner, /application_name = 'phase13j_legacy_context_owner'/);
  assert.match(
    owner,
    new RegExp(PRACTICE_TRANSITION_FIXTURE.legacyCurrentAssignmentId),
  );
  assert.match(owner, /for update;/);
  assert.match(owner, /pg_advisory_xact_lock\(\s*13162,\s*3\s*\)/);
  assert.match(owner, /pg_sleep\(30\)/);
  assert.match(owner, /set local role authenticated;/);
  assert.match(owner, /api\.resolve_practice_assignment_class_context\(/);
  assert.match(owner, /commit;\s*$/);

  assert.match(contender, /^\s*begin;/);
  assert.match(contender, /application_name = 'phase13j_legacy_reassign'/);
  assert.match(contender, /lock_timeout = '2s'/);
  assert.match(contender, /statement_timeout = '8s'/);
  assert.match(contender, /set local role authenticated;/);
  assert.match(contender, /api\.reassign_practice_assignment\(/);
  assert.match(contender, /practice_class_context_resolution_pending/);
  assert.match(contender, /rejection_started_at timestamptz/);
  assert.match(contender, /interval '5 seconds'/);
  assert.match(contender, /phase13j_legacy_reassignment_not_fast/);
  assert.match(contender, /from pg_locks held_lock/);
  assert.match(contender, /join pg_stat_activity owner_activity/);
  assert.match(
    contender,
    /owner_activity\.application_name = 'phase13j_legacy_context_owner'/,
  );
  assert.match(contender, /phase13j_legacy_owner_barrier_missing/);
  assert.match(contender, /phase13j_legacy_rejection_while_owner_locked/);
  assert.match(contender, /commit;\s*$/);
  assert.doesNotMatch(
    contender,
    /(?:insert\s+into|update|delete\s+from)\s+(?:public|app_private)\./i,
  );

  assert.match(verification, /phase13j_legacy_context_recovery_invalid/);
  assert.match(verification, /phase13j_legacy_replacement_created/);
  assert.match(verification, /phase13j_legacy_teacher_action_created/);
  assert.match(verification, /class_context_version = 1/);
  assert.match(verification, /class_context_integrity = 'teacher_verified'/);
});

test("cleanup is bounded, exact, idempotent, and proves zero residue", () => {
  const cleanup = buildPracticeTransitionCleanupSql();
  const residue = buildPracticeTransitionZeroResidueSql();

  assert.match(cleanup, /^\s*begin;/);
  assert.match(cleanup, /lock_timeout = '5s'/);
  assert.match(cleanup, /statement_timeout = '20s'/);
  assert.match(cleanup, /session_replication_role = replica/);
  assert.match(cleanup, /session_replication_role = origin/);
  assert.match(cleanup, /commit;\s*$/);
  assert.doesNotMatch(cleanup, /\btruncate\b|\bilike\b/i);
  for (const value of Object.values(PRACTICE_TRANSITION_FIXTURE)) {
    assert.match(cleanup, new RegExp(value.replaceAll("-", "\\-")));
  }

  for (const relation of [
    "auth.users",
    "public.profiles",
    "public.workspaces",
    "public.batches",
    "public.workspace_members",
    "public.batch_students",
    "app_private.teacher_entitlements",
    "public.grammar_topics",
    "public.student_grammar_stats",
    "public.student_practice_assignments",
    "app_private.practice_resolution_cycles",
    "app_private.practice_resolution_cycle_events",
    "app_private.practice_level_fit_reconciliation_failures",
    "app_private.practice_level_fit_opt_ins",
    "app_private.practice_assignment_cycle_transition_jobs",
    "app_private.practice_teacher_actions",
  ]) {
    assert.match(residue, new RegExp(relation.replaceAll(".", "\\.")));
  }
  assert.match(residue, /phase13j_race_cleanup_residue_detected/);
});

test("orchestrator requires exact linked-project confirmation and genuine overlaps", async () => {
  const barrierProbe = buildBarrierProbeSql(
    { classId: 13_162, objectId: 9 },
    "phase13j_probe_owner",
  );
  const blockedProbe = buildBlockedSessionProbeSql(
    "phase13j_probe_fixture",
    "phase13j_probe_blocker",
  );
  const drainProbe = buildHarnessSessionDrainProbeSql();
  const source = await readFile(
    new URL("./run-practice-transition-races.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /PRACTICE_RACE_PROJECT_REF/);
  assert.match(source, /PRACTICE_RACE_CONFIRM/);
  assert.match(source, /run-isolated-practice-transition-races:/);
  assert.match(source, /supabase\/\.temp\/project-ref/);
  assert.match(source, /SUPABASE_CLI_PATH/);
  assert.match(source, /isAbsolute\(configuredCli\)/);
  assert.match(
    source,
    /waitForBarrier\(\s*options,\s*MVCC_BARRIER,\s*MVCC_OWNER_APPLICATION/,
  );
  assert.match(
    source,
    /waitForBarrier\(\s*options,\s*WORKER_BARRIER,\s*WORKER_APPLICATION/,
  );
  assert.match(
    source,
    /waitForBlockedSession\(\s*options,\s*MVCC_CONTENDER_APPLICATION,\s*MVCC_OWNER_APPLICATION/,
  );
  assert.match(
    source,
    /waitForBlockedSession\(\s*options,\s*TEACHER_APPLICATION,\s*WORKER_APPLICATION/,
  );
  assert.match(barrierProbe, /interval '18 seconds'/);
  assert.match(barrierProbe, /perform pg_sleep\(0\.1\)/);
  assert.match(barrierProbe, /join pg_stat_activity owner_activity/);
  assert.match(
    barrierProbe,
    /owner_activity\.application_name = 'phase13j_probe_owner'/,
  );
  assert.match(blockedProbe, /from pg_stat_activity activity/);
  assert.match(
    blockedProbe,
    /activity\.application_name = 'phase13j_probe_fixture'/,
  );
  assert.match(blockedProbe, /activity\.wait_event_type = 'Lock'/);
  assert.match(blockedProbe, /activity\.wait_event is not null/);
  assert.match(blockedProbe, /pg_blocking_pids\(activity\.pid\)/);
  assert.match(blockedProbe, /join pg_stat_activity expected_blocker/);
  assert.match(
    blockedProbe,
    /expected_blocker\.application_name = 'phase13j_probe_blocker'/,
  );
  assert.match(blockedProbe, /perform pg_sleep\(0\.1\)/);
  assert.match(drainProbe, /interval '40 seconds'/);
  assert.match(drainProbe, /phase13j_harness_sessions_did_not_drain/);
  assert.match(drainProbe, /phase13j_legacy_reassign/);
  assert.match(drainProbe, /phase13j_fixture_cleanup/);
  assert.match(drainProbe, /phase13j_fixture_setup/);
  assert.match(drainProbe, /phase13j_mvcc_verification/);
  assert.match(drainProbe, /phase13j_worker_fixture_transition/);
  assert.equal(source.match(/await Promise\.all\(/g)?.length, 3);
  assert.match(source, /assertOverlap\(mvccOwner, mvccContender/);
  assert.match(source, /assertOverlap\(worker, teacher/);
  assert.match(source, /teacher_completed_before_expected_lock/);
  assert.match(
    source,
    /assertFastOverlap\(\s*legacyContextOwner,\s*legacyReassignment/,
  );
  assert.match(source, /COMMAND_TIMEOUT_MS = 90_000/);
  assert.match(source, /CHILD_KILL_GRACE_MS = 2_000/);
  assert.match(source, /child\.kill\("SIGKILL"\)/);
  assert.match(
    source,
    /!contender\.stdout\.includes\(LEGACY_REJECTION_SENTINEL\)/,
  );
  assert.doesNotMatch(source, /await sleep\(150\)/);
  assert.doesNotMatch(source, /contender\.durationMs >= 8_000/);
  assert.match(source, /let cleanupPromise: Promise<void> \| undefined/);
  assert.match(source, /runSqlCheckedWithRetry\(/);
  assert.match(source, /CLEANUP_ATTEMPTS = 3/);
  assert.match(source, /waitForHarnessSessionsToDrain\(options\)/);
  assert.match(source, /buildPracticeTransitionZeroResidueSql\(\)/);
  assert.match(source, /lifecycle\.requestAbort\(\)/);
  assert.match(source, /process\.exitCode = signal === "SIGINT" \? 130 : 143/);
  assert.doesNotMatch(source, /process\.exit\(/);
  assert.match(source, /process\.on\("SIGINT", onSigint\)/);
  assert.match(source, /process\.on\("SIGTERM", onSigterm\)/);
  assert.doesNotMatch(source, /process\.once\("SIG(?:INT|TERM)"/);
  assert.match(source, /const startMutatingSql/);
  assert.match(source, /const runMutatingSqlChecked/);
  assert.match(source, /lifecycle\.prepareForMutations\(\)/);
});

test("shutdown is latched, coalesced, and cannot clear cleanup for new mutations", async () => {
  const lifecycle = createPracticeTransitionRaceLifecycle();
  let cleanupRuns = 0;
  let shutdownRuns = 0;

  const initialCleanup = lifecycle.runCleanup(async () => {
    cleanupRuns += 1;
  });
  await initialCleanup;

  lifecycle.requestAbort();
  assert.equal(lifecycle.abortRequested, true);
  assert.throws(
    () => lifecycle.prepareForMutations(),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "PracticeTransitionRaceError" &&
      "code" in error &&
      error.code === "execution_interrupted",
  );

  await lifecycle.runCleanup(async () => {
    cleanupRuns += 1;
  });
  assert.equal(cleanupRuns, 1);

  const firstShutdown = lifecycle.runShutdown(async () => {
    shutdownRuns += 1;
  });
  const secondShutdown = lifecycle.runShutdown(async () => {
    shutdownRuns += 1;
  });
  assert.strictEqual(firstShutdown, secondShutdown);
  await Promise.all([firstShutdown, secondShutdown]);
  assert.equal(shutdownRuns, 1);
});

test("a normal run clears only the successful preflight cleanup before mutation", async () => {
  const lifecycle = createPracticeTransitionRaceLifecycle();
  let cleanupRuns = 0;
  const cleanup = async () => {
    cleanupRuns += 1;
  };

  await lifecycle.runCleanup(cleanup);
  lifecycle.prepareForMutations();
  await lifecycle.runCleanup(cleanup);

  assert.equal(lifecycle.abortRequested, false);
  assert.equal(cleanupRuns, 2);
});

test("shutdown replaces a signal-interrupted final cleanup retry exactly once", async () => {
  const lifecycle = createPracticeTransitionRaceLifecycle();
  let interruptedCleanupRuns = 0;
  let freshCleanupRuns = 0;
  let shutdownRuns = 0;

  await assert.rejects(
    lifecycle.runCleanup(async () => {
      interruptedCleanupRuns += 1;
      throw new Error("simulated_final_retry_interruption");
    }),
    /simulated_final_retry_interruption/,
  );
  lifecycle.requestAbort();
  lifecycle.requestAbort();

  const shutdown = () =>
    lifecycle.runShutdown(async () => {
      shutdownRuns += 1;
      await lifecycle.settleCurrentCleanup();
      lifecycle.prepareShutdownCleanup();
      await lifecycle.runCleanup(async () => {
        freshCleanupRuns += 1;
      });
    });

  const firstShutdown = shutdown();
  const secondShutdown = shutdown();
  assert.strictEqual(firstShutdown, secondShutdown);
  await Promise.all([firstShutdown, secondShutdown]);

  assert.equal(interruptedCleanupRuns, 1);
  assert.equal(freshCleanupRuns, 1);
  assert.equal(shutdownRuns, 1);
  assert.throws(
    () => lifecycle.prepareForMutations(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "execution_interrupted",
  );
});

test("setup and standalone mutations stay drain-visible after local interruption", () => {
  const namedSetup = buildHarnessApplicationSql(
    "phase13j_fixture_setup",
    buildPracticeTransitionSetupSql(),
  );
  const namedMutation = buildHarnessApplicationSql(
    "phase13j_worker_fixture_transition",
    buildWorkerFixtureTransitionSql(),
  );
  const drain = buildHarnessSessionDrainProbeSql();

  assert.match(
    namedSetup,
    /^begin;\s*set local application_name = 'phase13j_fixture_setup';/,
  );
  assert.match(
    namedMutation,
    /^begin;\s*set local application_name = 'phase13j_worker_fixture_transition';/,
  );
  assert.doesNotMatch(namedSetup, /^set application_name/m);
  assert.doesNotMatch(namedMutation, /^set application_name/m);
  assert.match(drain, /phase13j_fixture_setup/);
  assert.match(drain, /phase13j_worker_fixture_transition/);
});

test("mutation tracker waits for a delayed local operation before shutdown", async () => {
  const lifecycle = createPracticeTransitionRaceLifecycle();
  let finishMutation: (() => void) | undefined;
  const delayedMutation = new Promise<void>((resolve) => {
    finishMutation = resolve;
  });
  lifecycle.trackMutatingOperation(delayedMutation);

  let fenceFinished = false;
  const fence = lifecycle.settleMutatingOperations(1_000).then((settled) => {
    fenceFinished = true;
    return settled;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fenceFinished, false);

  finishMutation!();
  assert.equal(await fence, true);
  assert.equal(fenceFinished, true);
});
