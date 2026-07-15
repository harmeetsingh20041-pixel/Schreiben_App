import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFailClosedLinkedSql } from "./run-linked-multi-workspace-regressions.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const stagingProjectRef = "vzcgalzspdehmnvqczfw";

export const v1LinkedDatabaseTests = [
  ["phase_14f_batch_writing_daily_limit_approval_test.sql", 44],
  ["phase_14e_all_level_worksheet_live_archive_test.sql", 21],
  ["phase_13m_generalized_ai_canary_spend_archive_test.sql", 24],
  ["phase_14d_terminal_ai_spend_settlement_test.sql", 12],
  ["phase_14c_explicit_worksheet_content_check_evidence_test.sql", 35],
  ["phase_14b_model_validated_worksheet_cache_test.sql", 59],
  ["phase_13z_pin_available_gemini_flash_lite_test.sql", 46],
  ["phase_12w_gemini_3_critic_compatibility_test.sql", 22],
  ["phase_12r_gemini_secondary_provider_test.sql", 57],
  ["phase_13x_resumable_worksheet_critic_evidence_test.sql", 15],
  ["phase_13p_mcq_safe_worksheet_completion_test.sql", 14],
  ["phase_9a_durable_jobs_test.sql", 75],
  ["phase_12h_certified_worksheet_bank_test.sql", 38],
  ["phase_13a_resumable_worksheet_generation_checkpoints_test.sql", 70],
  ["phase_12e_openai_worksheet_provenance_shared_probe.sql", 12],
  ["phase_13b_certified_bank_non_exhausting_selector_test.sql", 11],
  ["phase_13d_low_cefr_gate_hardening_test.sql", 21],
  ["phase_13e_canonical_worksheet_withdrawal_test.sql", 39],
  ["phase_13h_low_cefr_withdrawal_gate_regression_test.sql", 22],
  ["phase_13g_immediate_certified_bank_attachment_test.sql", 25],
  ["phase_13t_semantic_scoring_and_reviewer_coverage_test.sql", 18],
  ["phase_13u_current_practice_class_context_test.sql", 21],
  ["phase_13u_current_worksheet_reviewer_qualification_test.sql", 16],
  ["phase_13v_strict_worksheet_packet_boundary_test.sql", 8],
  ["phase_13s_all_level_topic_generation_paths_test.sql", 24],
  ["phase_8a_security_test.sql", 60],
  ["phase_8b_api_schema_test.sql", 38],
  ["phase_11g_api_invoker_boundary_test.sql", 11],
  ["phase_11v_rpc_only_data_mutations_test.sql", 10],
  ["phase_11w_validated_security_controls_test.sql", 26],
  ["phase_13i_private_practice_helper_boundary_test.sql", 4],
] as const;

const zeroWorksheetWorkSql = `do $v1_linked_zero_work$
begin
  if exists (
    select 1 from app_private.async_jobs
    where status in ('queued', 'processing', 'retry')
  ) or exists (
    select 1 from pgmq.q_writing_evaluation
  ) or exists (
    select 1 from pgmq.q_worksheet_generation
  ) or exists (
    select 1 from pgmq.q_worksheet_answer_evaluation
  ) or exists (
    select 1 from app_private.worksheet_generation_checkpoints
  ) or exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.state = 'reserved'
  ) then
    raise exception using
      errcode = '55000',
      message = 'v1_linked_database_gate_requires_zero_ai_work';
  end if;
end;
$v1_linked_zero_work$;
select 'V1_LINKED_ZERO_WORK' as linked_gate_state;`;

const phase13sPreflightSql = `do $phase13s_preflight$
begin
  if exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    left join app_private.practice_level_fit_reconciliation_failures failure
      on failure.cycle_id = cycle.id
    where cycle.resolved_at is null
      and cycle.state = 'locked'
      and cycle.state_reason in (
        'level_fit_approval_required', 'active_class_context_required'
      )
      and app_private.practice_cycle_has_active_class_context(cycle.id)
      and (
        cycle.state_reason = 'active_class_context_required'
        or app_private.practice_topic_level_gate_satisfied(
          cycle.grammar_topic_id,
          cycle.worksheet_level,
          cycle.id
        )
      )
      and coalesce(failure.failure_count, 0) < 5
      and coalesce(failure.next_retry_at, now()) <= now()
  ) then
    raise exception using
      errcode = '55000',
      message = 'phase13s_linked_test_requires_zero_external_cycles';
  end if;
end;
$phase13s_preflight$;
select 'PHASE13S_EXTERNAL_CYCLES_ZERO' as linked_gate_state;`;

function parseArgs(argv: string[]) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (
    ![2, 4].includes(normalized.length) ||
    normalized[0] !== "--expected-project-ref" ||
    normalized[1] !== stagingProjectRef ||
    (normalized.length === 4 && normalized[2] !== "--start-at")
  ) {
    throw new Error(
      `Usage: linked V1 database gate --expected-project-ref ${stagingProjectRef} [--start-at <reviewed-test-file>]`,
    );
  }
  const startAt = normalized[3];
  if (
    startAt &&
    !v1LinkedDatabaseTests.some(([fileName]) => fileName === startAt)
  ) {
    throw new Error(`Unreviewed linked V1 start file: ${startAt}`);
  }
  return { expectedProjectRef: normalized[1], startAt };
}

function runSupabase(args: string[]) {
  const executable = process.env.SUPABASE_BIN?.trim() || "supabase";
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Supabase command failed with exit code ${result.status ?? "unknown"}.`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { expectedProjectRef, startAt } = parseArgs(argv);
  const linkedProjectRef = (
    await readFile(
      resolve(repositoryRoot, "supabase/.temp/project-ref"),
      "utf8",
    )
  ).trim();
  if (linkedProjectRef !== expectedProjectRef) {
    throw new Error(
      `Refusing linked V1 gate: expected ${expectedProjectRef}, found ${linkedProjectRef || "no linked project"}.`,
    );
  }

  runSupabase(["db", "query", "--linked", zeroWorksheetWorkSql]);

  const firstTestIndex = startAt
    ? v1LinkedDatabaseTests.findIndex(([fileName]) => fileName === startAt)
    : 0;
  const selectedTests = v1LinkedDatabaseTests.slice(firstTestIndex);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "schreiben-v1-db-"));
  try {
    for (const [fileName, assertions] of selectedTests) {
      if (fileName === "phase_12h_certified_worksheet_bank_test.sql") {
        runSupabase(["db", "query", "--linked", zeroWorksheetWorkSql]);
      }
      if (
        fileName ===
        "phase_13a_resumable_worksheet_generation_checkpoints_test.sql"
      ) {
        runSupabase(["db", "query", "--linked", zeroWorksheetWorkSql]);
      }
      if (fileName === "phase_13s_all_level_topic_generation_paths_test.sql") {
        runSupabase(["db", "query", "--linked", phase13sPreflightSql]);
      }

      const path = resolve(repositoryRoot, "supabase/tests/database", fileName);
      const source = await readFile(path, "utf8");
      const linkedSql = buildFailClosedLinkedSql({
        source,
        fileName,
        assertions,
      });
      const temporaryPath = join(temporaryDirectory, fileName);
      await writeFile(temporaryPath, linkedSql, {
        encoding: "utf8",
        mode: 0o600,
      });
      runSupabase(["db", "query", "--linked", "--file", temporaryPath]);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  runSupabase(["db", "query", "--linked", zeroWorksheetWorkSql]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        project_ref: expectedProjectRef,
        start_at: startAt ?? null,
        files: selectedTests.length,
        assertions: selectedTests.reduce(
          (total, [, assertions]) => total + assertions,
          0,
        ),
        transaction: "outer rollback per file",
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}
