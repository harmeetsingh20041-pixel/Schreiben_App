// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../e2e/authenticated.writing-live.spec.ts", import.meta.url),
  "utf8",
);
const manifestSource = readFileSync(
  new URL("../e2e/fixtures/writing-live-recovery-manifest.ts", import.meta.url),
  "utf8",
);
const safeStatusSource = readFileSync(
  new URL("../e2e/fixtures/writing-live-safe-status.ts", import.meta.url),
  "utf8",
);
const gitignore = readFileSync(
  new URL("../../../../.gitignore", import.meta.url),
  "utf8",
);
const testingGuide = readFileSync(
  new URL("../../../../docs/TESTING.md", import.meta.url),
  "utf8",
);
const generalizedWritingArchiveMigration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260714181756_generalize_writing_live_canary_levels.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("isolated live-writing E2E contract", () => {
  it("pins every privileged fixture mutation to the linked staging project", () => {
    expect(source).toContain(
      'const PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw"',
    );
    expect(source).toContain('"supabase/.temp/project-ref"');
    expect(source).toContain("assertPinnedLinkedStaging();");
    expect(source).toContain('requiredEnvironment("E2E_SUPABASE_BIN")');
    expect(source).toContain("if (!isAbsolute(executable))");
    expect(source).toContain(
      '["db", "query", "--linked", "--file", "/dev/stdin"]',
    );
    expect(source).toContain('!name.startsWith("E2E_")');
    expect(source).toContain('stdio: ["pipe", "pipe", "pipe"]');
    expect(source).toContain("PRIVATE_SQL_MUTATION_TIMEOUT_MS = 90_000");
    expect(source).toContain("timeout: PRIVATE_SQL_MUTATION_TIMEOUT_MS");
    expect(source).toContain('killSignal: "SIGKILL"');
    expect(source).toContain("PRIVATE_SQL_SAFE_ERROR_PATTERN");
    expect(source).toContain("writing_live_(?:fixture|canary)_");
    expect(source).toContain(
      "value.match(PRIVATE_SQL_SAFE_ERROR_PATTERN)?.[0]",
    );
    expect(source).toContain("error instanceof PrivateSqlError");
    expect(source).not.toContain("${result.stderr}");
    expect(source).not.toContain("${result.stdout}");
  });

  it("uses strict JSON output for numeric-only linked database probes", () => {
    const numericRunnerStart = source.indexOf(
      "async function runPrivateLinkedNumericSql(",
    );
    const numericRunnerEnd = source.indexOf(
      "function createFixtureSql(",
      numericRunnerStart,
    );
    const numericRunner = source.slice(numericRunnerStart, numericRunnerEnd);

    expect(numericRunnerStart).toBeGreaterThan(-1);
    expect(numericRunner).toContain('"--agent",\n        "no"');
    expect(numericRunner).toContain('"--output-format",\n        "json"');
    expect(numericRunner).toContain(
      "parsePrivateNumericRow(stdout, expectedValueCount)",
    );
    expect(numericRunner).not.toContain("console.");
    expect(numericRunner).not.toContain("${stdout}");
    expect(numericRunner).not.toContain("${stderr}");
    expect(safeStatusSource).toContain("JSON.parse(trimmedOutput)");
    expect(safeStatusSource).toContain("parsed.length !== 1");
    expect(safeStatusSource).toContain(
      'keys.length !== 1 || keys[0] !== "safe_numbers"',
    );
    expect(safeStatusSource).toContain('typeof candidate !== "string"');
  });

  it("can prove external recovery without allowing the normal browser kick", () => {
    expect(source).toContain("E2E_LIVE_WRITING_EXTERNAL_RECOVERY");
    expect(source).toContain(
      'page.route("**/functions/v1/kick-writing-jobs"',
    );
    expect(source).toContain("latestRecoveryHeartbeatEpoch()");
    expect(source).toContain("recoveryHeartbeatBeforeSubmit");
    expect(source).toContain("suppressedImmediateKicks");
    expect(source).toContain(".toBeGreaterThan(recoveryHeartbeatBeforeSubmit)");
    expect(source).toContain("expect(suppressedImmediateKicks).toBe(1)");
  });

  it("uses the configured account slot and proves exact database and browser roles", () => {
    expect(source).toContain('requiredEnvironment("E2E_WRITING_STUDENT_SLOT")');
    expect(source).toContain('requestedStudentSlot !== "TEACHER"');
    expect(source).toContain('requestedStudentSlot !== "STUDENT"');
    expect(source).toContain(
      "teacher_role not in ('teacher', 'platform_admin')",
    );
    expect(source).toContain("student_role <> 'student'");
    expect(source).toContain("assignment.student_id = student_profile_id");
    expect(source).not.toContain("assignment.student_id = student_id");
    expect(source).toContain(
      "insert into public.batch_students (\n    id,\n    batch_id,\n    student_id,\n    workspace_id",
    );
    expect(source).not.toContain(
      "insert into public.batch_students (\n    id,\n    batch_id,\n    student_profile_id,",
    );
    expect(source).toContain(
      "${sqlUuid(target.batchId)},\n    student_profile_id,",
    );
    expect(source).not.toContain(
      "${sqlUuid(target.batchId)},\n    student_id,",
    );
    expect(source).toContain("membership.role = 'teacher'");
    expect(source).toContain("membership.role = 'student'");
    expect(source).toContain('pathname === "/student/dashboard"');
    expect(source).toContain(
      "The configured writing student opened a teacher shell",
    );
  });

  it("creates and selects one exact immediate fixture without an existing-class fallback", () => {
    const workspaceInsert = source.indexOf("insert into public.workspaces");
    const membershipInsert = source.indexOf(
      "insert into public.workspace_members",
    );
    const batchInsert = source.indexOf("insert into public.batches");
    const assignmentInsert = source.indexOf(
      "insert into public.batch_students",
    );
    expect(workspaceInsert).toBeGreaterThan(-1);
    expect(membershipInsert).toBeGreaterThan(workspaceInsert);
    expect(batchInsert).toBeGreaterThan(membershipInsert);
    expect(assignmentInsert).toBeGreaterThan(batchInsert);
    expect(source).toContain("batch.feedback_mode = 'immediate'");
    expect(source).toContain("batch.is_active");
    expect(source).toContain("name: `${target.workspaceName} · student`");
    expect(source).toContain("name: `${target.batchName} · ${target.level}`");
    expect(source).toContain('page.goto("/student/write?mode=free")');
    expect(source).not.toContain("Start Free Writing");
    expect(source).not.toContain("E2E_LIVE_WRITING_MODE");
    expect(source).not.toContain("existing immediate class");
  });

  it("preflights monitor-only student cost targets and hard platform spend caps without reserving spend", () => {
    const preflightStart = source.indexOf(
      "function writingLiveCapacityPreflightSql(",
    );
    const preflightEnd = source.indexOf(
      "async function assertWritingLiveCapacity(",
      preflightStart,
    );
    const preflight = source.slice(preflightStart, preflightEnd);
    expect(preflightStart).toBeGreaterThan(-1);
    expect(preflight).toContain("date_trunc('month', timezone('UTC', now()))");
    expect(preflight).toContain("lower(profile.email)");
    expect(preflight).toContain("membership.role = 'student'");
    expect(preflight).toContain("active_student_count");
    expect(preflight).toContain(
      "operating_target_microeur_per_active_student_month",
    );
    expect(preflight).toContain("fair_share_reserve_basis_points");
    expect(preflight).toContain("ai_spend_accounting_entries()");
    expect(preflight).toContain("pg_get_functiondef(");
    expect(preflight).toContain("app_private.enforce_ai_spend_fair_share()");
    expect(preflight).toContain(
      "app_private.reserve_ai_spend(uuid,integer,text,text,text,text,bigint,integer)",
    );
    expect(preflight).toContain("ai_spend_student_fair_share_exceeded");
    expect(preflight).toContain("ai_fair_share_limit_microusd");
    expect(preflight).toContain("new.student_id");
    expect(preflight).toContain("cached_input_rate_microusd_per_million");
    expect(preflight).toContain("ai_spend_emergency_stop");
    expect(preflight).toContain("ai_spend_workspace_budget_exceeded");
    expect(preflight).toContain("ai_spend_global_budget_exceeded");
    expect(preflight).toContain("policy.provider_name = 'deepseek'");
    expect(preflight).toContain("policy.model_name = 'deepseek-v4-flash'");
    expect(preflight).toContain("policy.call_purpose = 'writing_generation'");
    expect(preflight).toContain("DEEPSEEK_FLASH_WRITING_RESERVATION_MICROUSD");
    expect(preflight).toContain("select concat_ws(");
    expect(preflight).toContain(") as safe_numbers");
    expect(preflight).not.toContain("copy (");
    expect(preflight).not.toContain("to stdout");
    expect(preflight).not.toMatch(/\b(?:insert|update|delete)\b/iu);
    expect(preflight).not.toContain("select * from app_private.reserve_ai_spend");
    expect(source).toContain(
      '"writing_live_fixture_deepseek_flash_capacity_unavailable"',
    );
    expect(source.indexOf("fixtureInstalled = true")).toBeLessThan(
      source.indexOf(
        "await assertWritingLiveCapacity(fixture, accounts.student)",
      ),
    );
  });

  it("polls exact numeric-only submission and job flags and fails early while retries remain allowed", () => {
    const statusStart = source.indexOf("function writingLiveSafeStatusSql(");
    const statusEnd = source.indexOf(
      "async function waitForValidatedWritingFeedback(",
      statusStart,
    );
    const statusQuery = source.slice(statusStart, statusEnd);
    const adjudicationReasons = [
      "critic_approved",
      "final_critic_approved",
      "recovery_critic_approved",
      "generator_not_configured",
      "generator_authentication_failed",
      "generator_not_primary",
      "generator_invalid",
      "critic_not_configured",
      "critic_authentication_failed",
      "critic_invalid",
      "critic_hash_mismatch",
      "critic_disagreed",
      "critic_uncertain",
      "adjudicator_not_configured",
      "adjudicator_authentication_failed",
      "adjudicator_invalid",
      "adjudicator_hash_mismatch",
      "adjudicator_unresolved",
      "final_critic_not_configured",
      "final_critic_authentication_failed",
      "final_critic_invalid",
      "final_critic_hash_mismatch",
      "final_critic_disagreed",
      "final_critic_uncertain",
    ] as const;
    expect(statusStart).toBeGreaterThan(-1);
    expect(statusQuery).toContain(
      "submission.id = ${sqlUuid(target.submissionId)}",
    );
    expect(statusQuery).toContain(
      "assignment.id = ${sqlUuid(target.batchStudentId)}",
    );
    expect(statusQuery).toContain("job.job_kind = 'writing_evaluation'");
    expect(statusQuery).toContain("job.queue_name = 'writing_evaluation'");
    expect(statusQuery).toContain(
      "submission.evaluation_status = 'needs_review'",
    );
    expect(statusQuery).toContain("submission.release_status = 'held'");
    expect(statusQuery).toContain("job.attempt_count");
    expect(statusQuery).toContain("job.last_error_code is not null");
    expect(statusQuery).toContain("job.status = 'retry'");
    expect(statusQuery).toContain("job.available_at <= now()");
    expect(statusQuery).toContain(
      "app_private.writing_feedback_adjudications_v2 evidence",
    );
    expect(statusQuery).toContain(
      "select evidence.decision, evidence.reason_code",
    );
    expect(statusQuery).not.toContain("select evidence.*");
    expect(statusQuery).toContain("job.id = evidence.job_id");
    expect(statusQuery).toContain(
      "job.entity_version = evidence.evaluation_version",
    );
    expect(statusQuery).toContain(
      "job.entity_version = evidence.feedback_version",
    );
    expect(statusQuery).toContain(
      "evidence.submission_id = ${sqlUuid(target.submissionId)}",
    );
    expect(statusQuery).toContain(
      "(select count(*) from adjudication_evidence)::bigint",
    );
    expect(statusQuery).toContain(
      "evidence.decision = 'accepted_model_feedback'",
    );
    expect(statusQuery).toContain("evidence.decision = 'system_hold'");
    adjudicationReasons.forEach((reason, index) => {
      expect(statusQuery).toContain(`when '${reason}' then ${index + 1}`);
      expect(safeStatusSource).toContain(`"${reason}"`);
    });
    expect(statusQuery).toContain("else 0");
    expect(statusQuery).toContain("select concat_ws(");
    expect(statusQuery).toContain(") as safe_numbers");
    expect(statusQuery).not.toContain("copy (");
    expect(statusQuery).not.toContain("to stdout");
    expect(statusQuery).not.toMatch(
      /payload|provider_output|original_text|corrected_text|candidate_feedback|final_feedback|submission\.text/iu,
    );
    expect(source).toContain(
      "parsePrivateNumericRow(stdout, expectedValueCount)",
    );
    expect(source).toContain("classifyWritingLiveSafeStatus(status)");
    expect(source).toContain('decision.state === "failed"');
    expect(source).toContain("Promise.race([statusQuery, browserProbe])");
    expect(source).toContain("queryController.abort()");
    expect(source).toContain(
      "if (await feedbackHeading.isVisible().catch(() => false)) return",
    );
    expect(source).toContain('"writing_live_fixture_status_query_timeout"');
    expect(source).toContain('"writing_live_fixture_database_command_failed"');
    expect(source).toContain("isTransientStatusQueryFailure(outcome.error)");
    expect(source).toContain("PRIVATE_SQL_STATUS_TIMEOUT_MS = 45_000");
    expect(source).not.toContain(
      'name: "Feedback Summary", level: 2 }),\n    ).toBeVisible({ timeout: 150_000 })',
    );
    expect(safeStatusSource).toContain(
      "status.jobRetry && retryWindowCount !== 1",
    );
    expect(safeStatusSource).toContain(
      "writing_live_fixture_feedback_failed_${jobError}",
    );
    expect(safeStatusSource).toContain(
      '"writing_live_fixture_feedback_failed_unknown"',
    );
    expect(safeStatusSource).toContain(
      'safeCode: "writing_live_fixture_feedback_needs_review_evidence_missing"',
    );
    expect(safeStatusSource).toContain(
      'safeCode: "writing_live_fixture_feedback_needs_review_evidence_invalid"',
    );
    expect(safeStatusSource).toContain(
      "`writing_live_fixture_feedback_needs_review_${adjudicationReason}`",
    );
    expect(safeStatusSource).toContain("WRITING_LIVE_STATUS_VALUE_COUNT = 26");
    expect(safeStatusSource).toContain(
      'safeCode: "writing_live_fixture_feedback_held"',
    );
  });

  it("requires one bounded exact terminal database proof after browser readiness", () => {
    const proofStart = source.indexOf(
      "async function assertWritingLiveTerminalProof(",
    );
    const proofEnd = source.indexOf("function cleanupFixtureSql(", proofStart);
    const proof = source.slice(proofStart, proofEnd);
    const browserWait = source.lastIndexOf(
      "await waitForValidatedWritingFeedback(page, fixture)",
    );
    const terminalProof = source.lastIndexOf(
      "await assertWritingLiveTerminalProof(fixture)",
    );
    const lineByLineAssertion = source.lastIndexOf(
      'page.getByRole("tab", { name: "Line-by-line" })',
    );

    expect(proofStart).toBeGreaterThan(-1);
    expect(proof).toContain("writingLiveSafeStatusSql(target)");
    expect(proof).toContain("WRITING_LIVE_STATUS_VALUE_COUNT");
    expect(proof).toContain("timeoutMs: PRIVATE_SQL_STATUS_TIMEOUT_MS");
    expect(proof).toContain("parseWritingLiveSafeStatus(values)");
    expect(proof).toContain("classifyWritingLiveSafeStatus(status)");
    expect(proof).toContain('decision.state === "ready"');
    expect(proof).toContain('decision.state === "failed"');
    expect(proof).toContain('"writing_live_fixture_feedback_not_terminal"');
    expect(proof).not.toContain("isTransientStatusQueryFailure");
    expect(browserWait).toBeGreaterThan(-1);
    expect(terminalProof).toBeGreaterThan(browserWait);
    expect(lineByLineAssertion).toBeGreaterThan(terminalProof);
  });

  it("asserts fatal browser failures from a finally block without losing a workflow failure", () => {
    expect(source).toContain("} finally {");
    expect(source).toContain("assertNoFatalFailures();");
    expect(source).toContain("new AggregateError(");
    expect(source).toContain("[workflowFailure, browserFailure]");
  });

  it("cleans the exact fixture and owner-only manifest if capacity preflight fails in beforeAll", () => {
    const capacityCall = source.indexOf(
      "await assertWritingLiveCapacity(fixture, accounts.student)",
    );
    const capacityCleanup = source.indexOf(
      '"Live writing capacity-preflight cleanup"',
      capacityCall,
    );
    const manifestRemoval = source.indexOf(
      "await removeWritingLiveRecoveryManifest(",
      capacityCleanup,
    );
    const fixtureDisarmed = source.indexOf(
      "fixtureInstalled = false",
      manifestRemoval,
    );
    const rethrow = source.indexOf("throw capacityFailure", fixtureDisarmed);
    expect(source).toContain("test.setTimeout(180_000)");
    expect(capacityCall).toBeGreaterThan(-1);
    expect(capacityCleanup).toBeGreaterThan(capacityCall);
    expect(manifestRemoval).toBeGreaterThan(capacityCleanup);
    expect(fixtureDisarmed).toBeGreaterThan(manifestRemoval);
    expect(rethrow).toBeGreaterThan(fixtureDisarmed);
    expect(source).toContain("[capacityFailure, cleanupFailure]");
    expect(source).toContain(
      "Live-writing capacity preflight and exact cleanup failed safely.",
    );
  });

  it("archives spend and deletes exact queue, evidence, feedback, adaptive, usage, and workspace state in a guarded order", () => {
    const spendArchive = source.indexOf(
      "from api.archive_writing_live_canary_spend(",
    );
    const queueCleanup = source.indexOf(
      "delete from pgmq.q_writing_evaluation",
    );
    const outageCleanup = source.indexOf(
      "delete from app_private.provider_outage_recovery_events",
    );
    const adjudicationCleanup = source.indexOf(
      "delete from app_private.writing_feedback_adjudications_v2",
    );
    const feedbackEventCleanup = source.indexOf(
      "delete from app_private.feedback_draft_events",
    );
    const adaptiveEventCleanup = source.indexOf(
      "delete from app_private.practice_resolution_cycle_events",
    );
    const weaknessCleanup = source.indexOf(
      "delete from app_private.practice_weakness_evidence",
    );
    const contextCleanup = source.indexOf(
      "delete from app_private.writing_evaluation_contexts",
    );
    const jobCleanup = source.indexOf("delete from app_private.async_jobs");
    const submissionCleanup = source.indexOf("delete from public.submissions");
    const workspaceCleanup = source.lastIndexOf(
      "delete from public.workspaces workspace",
    );

    expect(spendArchive).toBeGreaterThan(-1);
    expect(queueCleanup).toBeGreaterThan(spendArchive);
    expect(outageCleanup).toBeGreaterThan(queueCleanup);
    expect(adjudicationCleanup).toBeGreaterThan(outageCleanup);
    expect(feedbackEventCleanup).toBeGreaterThan(adjudicationCleanup);
    expect(adaptiveEventCleanup).toBeGreaterThan(feedbackEventCleanup);
    expect(weaknessCleanup).toBeGreaterThan(adaptiveEventCleanup);
    expect(contextCleanup).toBeGreaterThan(weaknessCleanup);
    expect(jobCleanup).toBeGreaterThan(contextCleanup);
    expect(submissionCleanup).toBeGreaterThan(jobCleanup);
    expect(workspaceCleanup).toBeGreaterThan(submissionCleanup);
    expect(source).toContain("writing_live_fixture_submission_ids");
    expect(source).toContain("writing_live_fixture_job_ids");
    expect(source).toContain("writing_live_fixture_cycle_ids");
    expect(source).toContain("writing_live_cleanup_lock_workspace");
    expect(source).toContain("writing_live_cleanup_lock_entities");
    expect(source).toContain("pg_advisory_xact_lock(");
    expect(source).toContain("'paid-job-entity'");
    expect(source.indexOf("writing_live_cleanup_lock_entities")).toBeLessThan(
      source.indexOf("create temp table writing_live_fixture_job_ids"),
    );
    expect(source).toContain("writing_live_fixture_identity_mismatch");
    expect(source).toContain("unexpected_submission_scope");
    expect(source).toContain("unexpected_job_scope");
    expect(source).toContain("writing_live_queue_scope_mismatch");
    expect(source).toContain("writing_live_fixture_job_not_terminal");
    expect(source).toContain("writing_live_fixture_spend_not_settled");
    expect(source).not.toContain(
      "delete from app_private.ai_spend_reservations",
    );
    expect(source).not.toContain(
      "delete from app_private.ai_canary_spend_archive",
    );
    expect(source).not.toContain("attribute.attname = 'original_workspace_id'");
    expect(source).toContain(
      "job.entity_id in (\n         select id from pg_temp.writing_live_fixture_submission_ids",
    );
    const scopeGuard = source.slice(
      source.indexOf("do $writing_live_scope_guard$"),
      source.indexOf(
        "$writing_live_scope_guard$;",
        source.indexOf("do $writing_live_scope_guard$") + 1,
      ),
    );
    expect(scopeGuard).toContain(
      "raise exception using message = 'writing_live_fixture_identity_mismatch'",
    );
    expect(scopeGuard).toContain(
      "raise exception using message = 'unexpected_submission_scope'",
    );
    expect(scopeGuard).toContain(
      "raise exception using message = 'unexpected_job_scope'",
    );
    expect(scopeGuard).toContain("queued.message ->> 'job_id'");
    expect(scopeGuard).toContain("queued.message ->> 'entity_id'");
    expect(scopeGuard).toContain("queued.msg_id in");
    expect(scopeGuard).not.toContain(
      "insert into pg_temp.writing_live_cleanup_anomalies",
    );
    expect(
      source.indexOf("set local session_replication_role = replica"),
    ).toBeGreaterThan(spendArchive);
    expect(source).toContain("delete from public.student_practice_assignments");
    expect(source).toContain(
      "delete from app_private.practice_resolution_cycles",
    );
    expect(source).toContain("delete from public.student_grammar_stats");
    expect(source).toContain(
      "delete from app_private.writing_submission_daily_usage",
    );
    expect(source).toContain(
      "delete from app_private.writing_submission_monthly_usage",
    );
    expect(source).toContain("delete from app_private.ai_student_daily_usage");
    expect(source).toContain(
      "delete from app_private.ai_student_monthly_usage",
    );
    expect(source).toContain(
      "delete from app_private.ai_workspace_daily_usage",
    );
    expect(source).toContain("set local session_replication_role = replica");
    expect(source).toContain("set local session_replication_role = origin");
    expect(source).toContain("writing_live_residue_guard");
    expect(source).toContain("writing_live_fixture_scope_or_cleanup_failed");

    const queueDeletes = source.slice(
      source.indexOf("delete from pgmq.q_writing_evaluation"),
      source.indexOf("delete from app_private.provider_outage_recovery_events"),
    );
    expect(queueDeletes).toContain(
      "queue.message ->> 'job_id' = fixture_job.id::text",
    );
    expect(queueDeletes).toContain(
      "queue.message ->> 'entity_id' = fixture_job.entity_id::text",
    );
    expect(queueDeletes).toContain(
      "archive.message ->> 'job_id' = fixture_job.id::text",
    );
    expect(queueDeletes).toContain(
      "archive.message ->> 'entity_id' = fixture_job.entity_id::text",
    );
    expect(queueDeletes).not.toContain("msg_id in");
    expect(generalizedWritingArchiveMigration).toContain(
      "batch.level in (''A1'', ''A2'', ''B1'', ''B2'')",
    );
    expect(generalizedWritingArchiveMigration).toContain(
      "writing_live_canary_level_patch_contract_invalid",
    );
  });

  it("uses only closed source-owned cases and emits content-free terminal evidence", () => {
    expect(source).toContain('requiredEnvironment("E2E_MUTATIONS")');
    expect(source).toContain("fixture!.submissionId = match[1]!");
    expect(source).toContain(
      "writingLiveReliabilityCase(\n  process.env.E2E_LIVE_WRITING_CASE_INDEX",
    );
    expect(source).toContain("process.env.E2E_LIVE_WRITING_REGRESSION_ID");
    expect(source).toContain("WRITING_LIVE_RELIABILITY_CORPUS");
    expect(source).toContain("writing.fill(SELECTED_WRITING_CASE.text)");
    expect(source).not.toContain("E2E_WRITING_SAMPLE");
    expect(source).not.toContain("console.");
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("response.url()");
    expect(source).not.toMatch(/trace|screenshot|video|testInfo\.attach/);
    expect(source).toContain("writing_live_fixture_setup_' || setup_stage");
    expect(source).toContain("when '23503' then 'foreign_key'");
    expect(source).toContain("when '23505' then 'unique'");
    expect(source).toContain("when '23514' then 'check'");
    expect(source).toContain("when '42501' then 'permission'");
    expect(source).toContain("when '42703' then 'undefined_column'");
    expect(source).toContain("[result.stdout, result.stderr]");
    expect(source).not.toContain("${result.stdout}");
    expect(source).toContain('"WRITING_LIVE_METRIC"');
    expect(source).toContain('"WRITING_LIVE_OUTCOME"');
    expect(source).toContain("correction_contract(check_index, alternatives)");
    expect(source).toContain("forbidden_contract(check_index, fragment)");
    expect(source).toContain("lower(alternative)");
    expect(source).toContain("lower(contract.fragment)");
    expect(source).toContain("original_text_exact");
    expect(source).toContain("correction_checks=");
    expect(source).toContain("forbidden_remaining=");
    expect(source).toContain("generator_provider_ordinal");
    expect(source).toContain("accepted_model_ordinal");
    expect(source).not.toContain("original_text,");
    expect(source).not.toContain("corrected_text,");
  });

  it("creates an ignored IDs-only recovery manifest before setup and removes it only after verified cleanup", () => {
    expect(gitignore).toContain("/.e2e-private/");
    expect(manifestSource).toContain('open(temporaryPath, "wx", 0o600)');
    expect(manifestSource).toContain("await handle.sync()");
    expect(manifestSource).toContain("await link(temporaryPath, scope.path)");
    expect(manifestSource).toContain(
      "await assertOwnedRealDirectory(scope.workspaceRoot, false)",
    );
    expect(manifestSource).toContain("metadata.isSymbolicLink()");
    expect(manifestSource).toContain("metadata.uid !== currentUserId()");
    expect(manifestSource).toContain("(metadata.mode & 0o777) !== 0o700");
    expect(manifestSource).toContain("if ((metadata.mode & 0o077) !== 0)");
    expect(manifestSource).not.toMatch(/email|password|writing_sample/i);

    const manifestCreation = source.indexOf(
      "await createWritingLiveRecoveryManifest(",
    );
    const fixtureSetup = source.indexOf(
      '"Live writing fixture setup"',
      manifestCreation,
    );
    expect(manifestCreation).toBeGreaterThan(-1);
    expect(fixtureSetup).toBeGreaterThan(manifestCreation);
    expect(source).toContain("await recoverPreviousWritingLiveFixture()");
    expect(source).toContain("E2E_LIVE_WRITING_RECOVERY_ONLY");
    expect(source).toContain("retry recovery after the worker");
    expect(testingGuide).toContain(
      "Database cleanup cannot undo an external provider request.",
    );
    expect(testingGuide).toContain("E2E_LIVE_WRITING_RECOVERY_ONLY=true");

    const ordinaryCleanup = source.indexOf('"Live writing exact cleanup"');
    const manifestRemoval = source.indexOf(
      "await removeWritingLiveRecoveryManifest(",
      ordinaryCleanup,
    );
    expect(ordinaryCleanup).toBeGreaterThan(-1);
    expect(manifestRemoval).toBeGreaterThan(ordinaryCleanup);

    const setupFailureHandler = source.slice(
      fixtureSetup,
      source.indexOf("fixtureInstalled = true", fixtureSetup),
    );
    expect(setupFailureHandler).toContain(
      "await recoverPreviousWritingLiveFixture()",
    );
    expect(setupFailureHandler).toContain(
      "exact database absence was verified",
    );
  });
});
