// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../e2e/authenticated.worksheet-live.spec.ts", import.meta.url),
  "utf8",
);
const playwrightConfig = readFileSync(
  new URL("../../playwright.config.ts", import.meta.url),
  "utf8",
);
const worksheetPageSource = readFileSync(
  new URL("../../src/pages/student/worksheet.tsx", import.meta.url),
  "utf8",
);
const matrixRunnerSource = readFileSync(
  new URL("../../scripts/run-worksheet-live-matrix.ts", import.meta.url),
  "utf8",
);
const packageSource = readFileSync(
  new URL("../../package.json", import.meta.url),
  "utf8",
);

describe("isolated live worksheet E2E contract", () => {
  it("pins staging, strips credentials from private SQL, and never logs private output", () => {
    expect(source).toContain(
      'const PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw"',
    );
    expect(source).toContain('"https://vzcgalzspdehmnvqczfw.supabase.co"');
    expect(source).toContain("assertPinnedBrowserStaging()");
    expect(source).toContain("installPinnedSupabaseRequestGuard(page)");
    expect(source).toContain('route.abort("blockedbyclient")');
    expect(source).toContain('requiredEnvironment("E2E_SUPABASE_BIN")');
    expect(source).toContain('!name.startsWith("E2E_")');
    expect(source).toContain('stdio: ["pipe", "pipe", "pipe"]');
    expect(source).toContain("PRIVATE_SQL_TIMEOUT_MS = 120_000");
    expect(source).toContain("timeout: PRIVATE_SQL_TIMEOUT_MS");
    expect(source).toContain('killSignal: "SIGKILL"');
    expect(source).toContain("PRIVATE_SQL_SAFE_STATUS_PATTERN");
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("result.stdout.trim");
    expect(source).not.toContain("result.stderr.trim");
    expect(source).not.toContain("console.");
    expect(source).not.toContain("firstChoiceLabel");
    expect(playwrightConfig).toContain('trace: authenticated ? "off"');
    expect(playwrightConfig).toContain('screenshot: authenticated ? "off"');
    expect(playwrightConfig).toContain('video: authenticated ? "off"');
    expect(playwrightConfig).toContain(
      'preserveOutput: authenticated ? "never"',
    );
  });

  it("uses only the exact disposable staging workspace and preserves shared bank content", () => {
    expect(source).toContain(
      'workspaceId: "e1300000-0000-4000-8000-000000000001"',
    );
    expect(source).toContain("worksheet_live_cleanup_identity_mismatch");
    expect(source).toContain("worksheet_live_cleanup_residue_detected");
    expect(source).toContain("worksheet_live_cleanup_job_active");
    expect(source).toContain("worksheet_live_cleanup_spend_not_terminal");
    expect(source).toContain("worksheet_live_cleanup_snapshot_changed");
    expect(source).toContain("for update nowait");
    expect(source).toContain("pg_try_advisory_xact_lock");
    expect(source).not.toContain("pg_advisory_xact_lock(");
    expect(source).toContain("'paid-job-entity'");
    expect(source).toContain("app_private.ai_canary_spend_archive");
    expect(source).toContain("api.archive_worksheet_live_canary_spend(");
    expect(source).toContain(
      "archived.archive_source = 'worksheet_live_canary_cleanup'",
    );
    expect(source).toContain("worksheet_live_cleanup_spend_archive_invalid");
    expect(source).not.toContain(
      "insert into app_private.ai_canary_spend_archive",
    );
    expect(source).toContain("set local session_replication_role = replica");
    expect(source).not.toContain("publish_certified_worksheet_template");
    expect(source).toContain(
      'providerTopicId: "e1300000-0000-4000-8000-000000000008"',
    );
    expect(source).toContain(
      'providerTopicSlug: "e2e-worksheet-provider-canary"',
    );
    expect(source).toContain("insert into public.grammar_topics");
    expect(source).toContain("delete from public.grammar_topics topic");
    expect(source).not.toContain(
      "insert into app_private.practice_worksheet_template",
    );
    expect(source).not.toContain(
      "insert into app_private.grammar_topic_contracts",
    );
    expect(source).not.toContain("worksheet_live_job_evidence_cleanup");
    expect(source).toContain(
      "delete from app_private.worksheet_generation_rejections",
    );
  });

  it("bridges only an exactly proven private quarantine during cleanup", () => {
    const cleanup = source.slice(
      source.indexOf("function cleanupFixtureSql("),
      source.indexOf("function createFixtureSql("),
    );
    const quarantineBridge = cleanup.slice(
      cleanup.indexOf(
        "create temp table worksheet_live_quarantined_test_bindings",
      ),
      cleanup.indexOf("select set_config('request.jwt.claims'"),
    );
    const archiveAndUnbind = cleanup.slice(
      cleanup.indexOf("select set_config('request.jwt.claims'"),
      cleanup.indexOf("do $worksheet_live_archive_guard$"),
    );

    expect(quarantineBridge).toContain(
      "assignment.id = ${sqlUuid(FIXTURE.providerAssignmentId)}",
    );
    expect(quarantineBridge).toContain(
      "assignment.workspace_id = ${sqlUuid(FIXTURE.workspaceId)}",
    );
    expect(quarantineBridge).toContain(
      "assignment.batch_id = ${sqlUuid(FIXTURE.batchId)}",
    );
    expect(quarantineBridge).toContain(
      "assignment.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}",
    );
    expect(quarantineBridge).toContain("assignment.practice_test_id is null");
    expect(quarantineBridge).toContain(
      "assignment.generation_status = 'needs_review'",
    );
    expect(quarantineBridge).toContain(
      "job.entity_version = assignment.generation_version",
    );
    expect(quarantineBridge).toContain("job.status = 'succeeded'");
    expect(quarantineBridge).toContain(
      "app_private.worksheet_generation_completions_v2",
    );
    expect(quarantineBridge).toContain(
      "completion.completion_mode = 'generated'",
    );
    expect(quarantineBridge).toContain("test.id = completion.practice_test_id");
    expect(quarantineBridge).toContain("test.generation_job_id = job.id");
    expect(quarantineBridge).toContain(
      "test.generated_from_assignment_id = assignment.id",
    );
    expect(quarantineBridge).toContain("test.visibility = 'private'");
    expect(quarantineBridge).toContain("test.quality_status = 'needs_review'");
    expect(quarantineBridge).toContain("not test.teacher_reviewed");
    expect(quarantineBridge).toContain("test.approval_source is null");
    expect(quarantineBridge).toContain(
      "message = 'worksheet_live_cleanup_test_scope_invalid'",
    );
    expect(quarantineBridge).toContain(
      "set local session_replication_role = replica",
    );
    expect(quarantineBridge).toContain(
      "set practice_test_id = binding.practice_test_id",
    );
    expect(archiveAndUnbind).toContain(
      "api.archive_worksheet_live_canary_spend(",
    );
    expect(archiveAndUnbind).toContain("set practice_test_id = null");
    expect(archiveAndUnbind).toContain(
      "message = 'worksheet_live_cleanup_test_unbinding_invalid'",
    );
    expect(
      cleanup.indexOf("set practice_test_id = binding.practice_test_id"),
    ).toBeLessThan(cleanup.indexOf("api.archive_worksheet_live_canary_spend("));
    expect(cleanup.indexOf("set practice_test_id = null")).toBeGreaterThan(
      cleanup.indexOf("api.archive_worksheet_live_canary_spend("),
    );
  });

  it("removes only an exact fixture-owned model-cache chain and preserves shared revisions", () => {
    const cleanup = source.slice(
      source.indexOf("function cleanupFixtureSql("),
      source.indexOf("function createFixtureSql("),
    );
    const cacheDiscovery = cleanup.slice(
      cleanup.indexOf(
        "create temp table worksheet_live_model_cache_revision_ids",
      ),
      cleanup.indexOf("do $worksheet_live_identity_guard$"),
    );
    const cacheDeletionStart = cleanup.indexOf(
      "set local session_replication_role = replica;",
      cleanup.indexOf("do $worksheet_live_archive_guard$"),
    );
    const cacheDeletion = cleanup.slice(
      cacheDeletionStart,
      cleanup.indexOf("delete from pgmq.q_worksheet_generation"),
    );

    expect(cacheDiscovery).toContain(
      "create temp table worksheet_live_model_cache_revision_ids",
    );
    expect(cacheDiscovery).toContain(
      "source_link.source_practice_test_id = revision.source_practice_test_id",
    );
    expect(cacheDiscovery).toContain(
      "source_link.source_completion_job_id = revision.source_completion_job_id",
    );
    expect(cacheDiscovery).toContain("completion.practice_test_id = test.id");
    expect(cacheDiscovery).toContain("test.generated_from_assignment_id =");
    expect(cacheDiscovery).toContain("job.entity_id = assignment.id");
    expect(cacheDiscovery).toContain(
      "job.entity_version = assignment.generation_version",
    );
    expect(cacheDiscovery).toContain("completion.evidence_version = 2");
    expect(cacheDiscovery).toContain(
      "revision.candidate_sha256 = completion.candidate_sha256",
    );
    expect(cacheDiscovery).toContain("revision.secondary_verdict_sha256 =");
    expect(cacheDiscovery).toContain(
      "app_private.practice_worksheet_model_cache_revision_is_current(",
    );
    expect(cacheDiscovery).toContain("FIXTURE.providerAssignmentId");
    expect(cacheDiscovery).toContain("FIXTURE.providerTopicId");
    expect(cacheDiscovery).toContain(
      "app_private.practice_worksheet_model_cache_sources other_source",
    );
    expect(cacheDiscovery).toContain(
      "app_private.practice_worksheet_model_cache_withdrawals",
    );
    expect(cacheDiscovery).toContain(
      "app_private.practice_worksheet_model_cache_attachment_events",
    );
    expect(cacheDiscovery).toContain(
      "app_private.practice_worksheet_model_cache_recovery_failures",
    );
    expect(cacheDiscovery).toContain("for update nowait");
    expect(cacheDiscovery).toContain(
      "worksheet_live_cleanup_model_cache_scope_invalid",
    );
    expect(cacheDiscovery).toContain(
      "revision.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}",
    );
    expect(cacheDiscovery).not.toContain(
      "hashtextextended(fixture_test_id::text, 13153000)",
    );

    const failureDelete = cacheDeletion.indexOf(
      "delete from app_private.practice_worksheet_model_cache_promotion_failures",
    );
    const questionDelete = cacheDeletion.indexOf(
      "delete from app_private.practice_worksheet_model_cache_questions",
    );
    const sourceDelete = cacheDeletion.indexOf(
      "delete from app_private.practice_worksheet_model_cache_sources",
    );
    const revisionDelete = cacheDeletion.indexOf(
      "delete from app_private.practice_worksheet_model_cache_revisions",
    );
    expect(failureDelete).toBeGreaterThanOrEqual(0);
    expect(questionDelete).toBeGreaterThan(failureDelete);
    expect(sourceDelete).toBeGreaterThan(questionDelete);
    expect(revisionDelete).toBeGreaterThan(sourceDelete);
    expect(cacheDeletion).toContain(
      "set local session_replication_role = replica",
    );
    expect(cacheDeletion).toContain(
      "worksheet_live_cleanup_model_cache_residue",
    );
    expect(cacheDeletion).not.toContain(
      "where revision.grammar_topic_id = ${sqlUuid(FIXTURE.providerTopicId)}",
    );
  });

  it("forces a no-bank generated worksheet and proves dual-provider provenance", () => {
    expect(source).toContain(
      "public.select_released_worksheet_template_internal",
    );
    expect(source).toContain(
      "app_private.worksheet_bank_direct_attachment_events",
    );
    expect(source).toContain("FIXTURE.providerTopicId");
    expect(source).toContain("app_private.worksheet_generation_completions_v2");
    expect(source).toContain(
      "completion.provider_source in ('deepseek', 'gemini')",
    );
    expect(source).toContain("completion.primary_critic_provider = 'deepseek'");
    expect(source).toContain("completion.secondary_critic_provider = 'gemini'");
    expect(source).toContain(
      "reservation.call_purpose = 'worksheet_generation'",
    );
    expect(source).toContain("reservation.call_purpose = 'worksheet_critique'");
    expect(source).toContain(
      "completion.generator_model = case completion.provider_source",
    );
    expect(source).toContain("job.attempt_count between 1 and 5");
    expect(source).toContain(
      "completion.secondary_critic_model = 'gemini-3.1-flash-lite'",
    );
    const providerAssertion = source.slice(
      source.indexOf("function providerReadyAssertionSql()"),
      source.indexOf("function evaluationTerminalAssertionSql()"),
    );
    expect(providerAssertion).toContain(
      "split_part(reservation.call_key, ':', 1) =",
    );
    expect(providerAssertion).toContain(
      "'attempt_' || job.attempt_count::text",
    );
    expect(providerAssertion).toContain(
      "split_part(reservation.call_key, ':', 1) ~ '^attempt_[1-5]$'",
    );
    expect(providerAssertion).toContain(")::integer < job.attempt_count");
    expect(providerAssertion).toContain("reservation.state = 'reserved'");
    expect(providerAssertion).toContain(
      "count(distinct reservation.call_key) between 3 and 13",
    );
    expect(providerAssertion).toContain(") between 2 and 10");
    expect(providerAssertion).toContain(
      "from app_private.worksheet_generation_checkpoints checkpoint",
    );
    expect(providerAssertion).toContain(
      "from pgmq.q_worksheet_generation queued",
    );
    expect(providerAssertion).toContain(
      "from pgmq.a_worksheet_generation archived",
    );
    expect(providerAssertion).toContain(
      "archived.msg_id = job.queue_message_id",
    );
    expect(providerAssertion).toContain(
      "archived.message ->> 'entity_version' = job.entity_version::text",
    );
    expect(providerAssertion).toMatch(
      /and not exists \(\s+select 1\s+from app_private\.worksheet_generation_checkpoints checkpoint/,
    );
    expect(providerAssertion).toMatch(
      /and not exists \(\s+select 1\s+from pgmq\.q_worksheet_generation queued/,
    );
    expect(providerAssertion).toMatch(
      /and \(\s+select count\(\*\)\s+from pgmq\.a_worksheet_generation archived[\s\S]*?\) = 1/,
    );
    expect(source).toContain(
      "count(distinct reservation.call_key) between 3 and 13",
    );
    expect(source).toContain("count(*) = count(distinct reservation.call_key)");
    expect(source).toContain("test.worksheet_template_revision_id is null");
    expect(source).toContain("worksheet_live_generation_deepseek_mcq_safe");
    expect(source).toContain("worksheet_live_generation_gemini_mcq_safe");
    expect(source).not.toContain(
      '"worksheet_live_generation_deepseek_rich_mixed"',
    );
    expect(source).not.toContain(
      '"worksheet_live_generation_gemini_rich_mixed"',
    );
    expect(source).toContain(
      "if source_name is null or source_name not in ('deepseek', 'gemini')",
    );
  });

  it("requires one exact A1-B2 level and keeps fixture cleanup level-derived", () => {
    const levelParser = source.slice(
      source.indexOf("function requiredWorksheetLevel()"),
      source.indexOf("function activeWorksheetLevel()"),
    );
    const countContract = source.slice(
      source.indexOf("function expectedQuestionCount("),
      source.indexOf("function providerTopicDescription("),
    );
    const cleanup = source.slice(
      source.indexOf("function cleanupFixtureSql("),
      source.indexOf("function createFixtureSql("),
    );

    expect(source).toContain(
      'const WORKSHEET_LEVELS = ["A1", "A2", "B1", "B2"] as const',
    );
    expect(levelParser).toContain('requiredEnvironment("E2E_WORKSHEET_LEVEL")');
    expect(levelParser).toContain("WORKSHEET_LEVELS.includes(");
    expect(levelParser).toContain(
      "E2E_WORKSHEET_LEVEL must equal A1, A2, B1, or B2",
    );
    expect(source).toContain("worksheetLevel = requiredWorksheetLevel()");
    expect(countContract).toContain('return level === "A2" ? 9 : 8');
    expect(source).not.toContain("EXPECTED_A2_QUESTION_COUNT");
    expect(source).toContain(
      "Synthetic staging canary for focused ${level} accusative-case practice.",
    );

    expect(cleanup).toContain(
      "create temp table worksheet_live_fixture_context",
    );
    expect(cleanup).toMatch(
      /insert into pg_temp\.worksheet_live_fixture_context[\s\S]*?select\s+batch\.level/,
    );
    expect(cleanup).toContain("fixture_level not in ('A1', 'A2', 'B1', 'B2')");
    expect(cleanup).toContain("assignment.worksheet_level = fixture_level");
    expect(cleanup).toContain("topic.level = fixture_level");
    expect(cleanup).toContain("from public.batches batch");
    expect(cleanup).toContain("from public.grammar_topics topic");
    expect(cleanup).toContain("from public.practice_tests test");
    expect(cleanup).toContain("for update nowait");
    expect(cleanup).not.toContain("activeWorksheetLevel()");
    expect(cleanup).not.toContain("E2E_WORKSHEET_LEVEL");
  });

  it("runs the four live levels sequentially through the protected wrapper with exact recovery", () => {
    expect(matrixRunnerSource).toContain(
      'import { runAuthenticatedPlaywright } from "./run-authenticated-playwright"',
    );
    expect(matrixRunnerSource).toContain(
      'WORKSHEET_LIVE_MATRIX_LEVELS = ["A1", "A2", "B1", "B2"] as const',
    );
    expect(matrixRunnerSource).toContain(
      'requireExactEnvironment("E2E_AUTHENTICATED", "true")',
    );
    expect(matrixRunnerSource).toContain(
      'requireExactEnvironment("E2E_MUTATIONS", "true")',
    );
    expect(matrixRunnerSource).toContain(
      'requireExactEnvironment("E2E_LIVE_WORKSHEET", "true")',
    );
    expect(matrixRunnerSource).toContain(
      "process.env.E2E_WORKSHEET_LEVEL = level",
    );
    expect(matrixRunnerSource).toContain(
      'process.env.E2E_LIVE_WORKSHEET_RECOVERY_ONLY = "true"',
    );
    expect(matrixRunnerSource).toContain(
      "for (const level of WORKSHEET_LIVE_MATRIX_LEVELS)",
    );
    expect(matrixRunnerSource).toContain(
      "await runAuthenticatedPlaywright([WORKSHEET_LIVE_SPEC])",
    );
    expect(matrixRunnerSource).not.toContain("spawn(");
    expect(matrixRunnerSource).not.toContain("console.");
    expect(packageSource).toContain(
      '"test:e2e:worksheet-live-matrix": "tsx scripts/run-worksheet-live-matrix.ts"',
    );
  });

  it("proves optional exact-first bank reuse, immediate progress, autosave reload, and profile-correct terminal scoring", () => {
    const bankLevelContract = source.slice(
      source.indexOf("function bankTopicLevelsSql("),
      source.indexOf("function candidateAccounts("),
    );
    const bankSelection = source.slice(
      source.indexOf("setup_stage := 'bank_topic_selection'"),
      source.indexOf("setup_stage := 'provider_assignment_insert'"),
    );
    expect(bankLevelContract).toContain('level === "A1" || level === "A2"');
    expect(bankLevelContract).toContain("`${sqlLiteral(level)}, 'A1_A2'`");
    expect(bankLevelContract).toContain("sqlLiteral(level)");
    expect(bankSelection).toContain(
      "topic.level in (${bankTopicLevelsSql(level)})",
    );
    expect(bankSelection).toContain(
      "case when topic.level = ${sqlLiteral(level)} then 0 else 1 end",
    );
    expect(bankSelection).toMatch(
      /public\.select_released_worksheet_template_internal\([\s\S]*?topic\.id,\s+\$\{sqlLiteral\(level\)\}\s+\) is not null/,
    );
    expect(bankSelection).not.toContain(
      "app_private.practice_worksheet_template_revisions",
    );
    expect(bankSelection).not.toContain("where topic.level = 'A1_A2'");
    expect(bankSelection).not.toContain("topic.level in ('A2', 'A1_A2')");
    expect(source).toContain("worksheet_live_bank_reuse_ready");
    expect(source).toContain(
      "Staging has no existing qualified ${activeWorksheetLevel()} bank release",
    );
    expect(source).toContain('process.env.E2E_REQUIRE_BANK === "true"');
    expect(source).toContain(
      "Launch certification requires an existing qualified ${activeWorksheetLevel()} bank release.",
    );
    expect(source).toContain("GENERATION_PROGRESS_GATE_MS = 5_000");
    expect(source).toContain("GENERATION_TERMINAL_GATE_MS = 210_000");
    expect(source).toContain("GENERATION_PERFORMANCE_SMOKE_MS = 90_000");
    expect(source).toContain("EVALUATION_TERMINAL_GATE_MS = 180_000");
    expect(source).toContain('return "pending";');
    const autosaveContract = source.slice(
      source.indexOf("async function autosaveReloadAndCompleteAnswers"),
      source.indexOf("async function submitAndWaitForTerminalEvaluation"),
    );
    expect(autosaveContract.match(/await page\.reload\(\)/g)).toHaveLength(2);
    expect(autosaveContract).toContain("fullyRestoredControls");
    expect(autosaveContract).toContain(
      "for (let index = 0; index < expectedQuestionCount(); index += 1)",
    );
    expect(autosaveContract).toContain(
      "const restoredControl = fullyRestoredControls.nth(index)",
    );
    expect(source).toContain("toBeChecked()");
    expect(source).toContain("toHaveValue(");
    expect(source).toContain("textControlIndex");
    expect(source).toContain("async function waitForSaved");
    expect(source).toContain('"Saved",');
    expect(source).toContain(
      "app_private.worksheet_answer_completion_provenance_v2",
    );
    expect(source).toContain(
      "app_private.worksheet_answer_adjudication_evidence_v2",
    );
    expect(source).toContain("review_totals.score_points");
    expect(source).toContain("attempt.score_percent = round(");
    expect(source).toContain(
      "reservation.call_purpose = 'worksheet_answer_evaluation'",
    );
    expect(source).toContain("worksheet_live_evaluation_terminal");
    expect(source).toContain("worksheet_live_objective_terminal");
    expect(source).toContain("attempt.evaluation_status = 'not_needed'");
    const objectiveAssertion = source.slice(
      source.indexOf("function objectiveTerminalAssertionSql()"),
      source.indexOf("async function signInStudent"),
    );
    expect(objectiveAssertion).toContain(
      "jsonb_array_elements(attempt.answers)",
    );
    expect(objectiveAssertion).toContain(
      "app_private.practice_answer_review_status_any(",
    );
    expect(objectiveAssertion).toContain(
      "app_private.practice_review_status_points(",
    );
    expect(objectiveAssertion).not.toContain(
      "from public.practice_attempt_question_reviews",
    );
    expect(source).toContain("job.job_kind = 'worksheet_answer_evaluation'");
    expect(source).toContain(
      'expect(generationStatus.endsWith("_mcq_safe")).toBe(true)',
    );
    expect(source).toContain(
      'const worksheetProfile: WorksheetLiveProfile = "mcq_safe"',
    );
    expect(source).toContain('if (worksheetProfile === "mcq_safe")');
  });

  it("captures only bounded content-free generation diagnostics before cleanup", () => {
    expect(source).toContain("function providerGenerationDiagnosticSql()");
    expect(source).toContain("assignment.generation_status");
    expect(source).toContain("assignment.generation_error");
    expect(source).toContain("safe_error_codes(code)");
    expect(source).toContain("'independent_validation_rejected'");
    expect(source).toContain("invalid_or_unmapped");
    expect(source).toContain("worksheet_fallback_ambiguous_fill_blank");
    expect(source).toContain("job.attempt_count");
    expect(source).toContain("job.attempt_count between 0 and 5");
    expect(source).toContain("'over_limit'");
    expect(source).toContain("job.last_error_code");
    expect(source).toContain("job.lease_expires_at");
    expect(source).toContain("job.available_at");
    expect(source).toContain("checkpoint.stage");
    expect(source).toContain("checkpoint.fallback_failure_code");
    expect(source).toContain("checkpoint.candidate_attempt");
    expect(source).toContain("checkpoint.candidate_provider");
    expect(source).toContain("checkpoint.candidate_model is null");
    expect(source).toContain("checkpoint.candidate is null");
    expect(source).toContain("pgmq.q_worksheet_generation");
    expect(source).toContain("pgmq.a_worksheet_generation");
    expect(source).toContain("app_private.ai_spend_reservations");
    expect(source).toContain("reservation.state = 'reserved'");
    expect(source).toContain("reservation.state = 'finalized'");
    expect(source).toContain("reservation.state = 'released'");
    expect(source).toContain("app_private.worksheet_generation_stage_evidence");
    expect(source).toContain("app_private.worksheet_generation_rejections");
    expect(source).toContain("app_private.worksheet_bank_fallback_events");
    expect(source).toContain('["worksheet_live_diag_"]');
    expect(source).toContain("throw new PrivateSqlError(diagnostic)");
    expect(source).toContain('state === "failed"');
    expect(source).toContain('status.getAttribute("data-generation-status")');
    expect(source).toContain('generationStatus === "failed"');
    expect(source).toContain('generationStatus === "needs_review"');
    expect(worksheetPageSource).toContain(
      "data-generation-status={assignment.generation_status}",
    );
    expect(source).not.toContain(
      'safeStatus.includes("could not be prepared")',
    );
    expect(source).toContain("worksheet_generation_terminal_failure");
    expect(source).toContain("worksheet_generation_terminal_timeout");
    expect(source).not.toContain("checkpoint.candidate::text");
    expect(source).not.toContain("checkpoint.completion_payload");
    expect(source).not.toContain("rejection.rejection_reasons");
  });
});
