import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260713070109_preserve_current_practice_class_context.sql",
    import.meta.url,
  ),
  "utf8",
);

const regression = await readFile(
  new URL(
    "../../supabase/tests/database/phase_13u_current_practice_class_context_test.sql",
    import.meta.url,
  ),
  "utf8",
);

const priorLevelFitRegression = await readFile(
  new URL(
    "../../supabase/tests/database/phase_13d_low_cefr_gate_hardening_test.sql",
    import.meta.url,
  ),
  "utf8",
);

test("active practice context requires the current batch level to match its immutable snapshot", () => {
  assert.match(
    migration,
    /create or replace function app_private\.practice_class_context_is_active\([\s\S]*batch\.is_active[\s\S]*batch\.level = target_worksheet_level/,
  );
  assert.match(
    migration,
    /create or replace function app_private\.lock_active_practice_class_context\([\s\S]*select batch\.is_active, batch\.level[\s\S]*selected_batch_level is distinct from target_worksheet_level/,
  );
  assert.match(
    migration,
    /after update of is_active, level on public\.batches/,
  );
  assert.match(
    migration,
    /cancel_untouched_practice_level_mismatches\([\s\S]*assignment\.worksheet_level is distinct from target_current_level[\s\S]*assignment\.status = 'unlocked'[\s\S]*assignment\.started_at is null[\s\S]*assignment\.latest_attempt_id is null/,
  );
  assert.match(migration, /last_error_code = 'class_context_inactive'/);
});

test("unfrozen reconciliation selects and audits the newest qualifying evidence context", () => {
  assert.match(
    migration,
    /newest tamper-valid evidence[\s\S]*evidence\.class_context_integrity in \([\s\S]*'writing_snapshot', 'teacher_verified'[\s\S]*order by evidence\.evidence_sequence desc[\s\S]*limit 1/,
  );
  assert.match(
    migration,
    /evidence_frozen_at is null[\s\S]*active_assignment_id is null[\s\S]*new\.batch_id = expected_batch_id[\s\S]*new\.worksheet_level = expected_worksheet_level/,
  );
  assert.match(
    migration,
    /new\.minor_issue_count = expected_minor_issue_count[\s\S]*new\.major_issue_count = expected_major_issue_count[\s\S]*new\.state = case/,
  );
  assert.match(
    migration,
    /'previous_worksheet_level', previous_worksheet_level[\s\S]*'worksheet_level', current_cycle\.worksheet_level[\s\S]*'class_context_refreshed'/,
  );
  assert.match(
    migration,
    /perform pg_advisory_xact_lock\([\s\S]*select cycle\.\*[\s\S]*for update/,
  );
});

test("database regressions cover mixed-level thresholds and A2-to-B1 detachment", () => {
  assert.match(regression, /select plan\(21\)/);
  assert.match(
    regression,
    /mixed_a1_first[\s\S]*mixed_b2_second[\s\S]*mixed_b2_third/,
  );
  assert.match(
    regression,
    /A1 minor plus two later B2 minors unlocks exactly the current B2 context, never A1/,
  );
  assert.match(
    regression,
    /set level = 'B1'[\s\S]*both read and locking predicates reject an A2 snapshot after its batch becomes B1/,
  );
  assert.match(
    regression,
    /target_status = 'cancelled'[\s\S]*process_practice_cycle_transition_jobs\(10\)[\s\S]*state_reason = 'active_class_context_required'[\s\S]*active_assignment_id is null/,
  );
  assert.match(regression, /event\.event_type = 'assignment_cancelled'/);
  assert.match(
    priorLevelFitRegression,
    /0::bigint,[\s\S]*current batch-level edit holds frozen contexts whose immutable level no longer matches/,
  );
});

test("legacy active pairs require atomic teacher recovery instead of automatic half-promotion", () => {
  assert.match(
    migration,
    /old\.class_context_version = 0 and new\.class_context_version = 1[\s\S]*old\.active_assignment_id is not null[\s\S]*new\.active_assignment_id is not null[\s\S]*Practice cycle class context requires atomic teacher recovery/,
  );
  assert.match(
    migration,
    /current_cycle\.evidence_frozen_at is null[\s\S]*current_cycle\.class_context_version = 0[\s\S]*current_cycle\.active_assignment_id is not null/,
  );
  assert.match(
    migration,
    /app\.practice_teacher_context_recovery_cycle[\s\S]*selected_assignment\.resolution_cycle_id::text[\s\S]*evidence_frozen_at = coalesce\([\s\S]*selected_assignment\.assigned_at[\s\S]*teacher_context_recovery_scope_anchor_changed/,
  );
  assert.match(regression, /legacy_pair_valid_a1/);
  assert.match(
    regression,
    /new valid evidence is retained without promoting, freezing, or duplicating a legacy active pair/,
  );
  assert.match(
    regression,
    /a private caller cannot promote only the cycle half of an active legacy pair/,
  );
  assert.match(
    regression,
    /teacher recovery atomically freezes one matching version-one pair at its immutable assignment cutoff/,
  );
  assert.match(
    regression,
    /later reconciliation preserves the frozen assignment cutoff and retains recurrence evidence beyond it/,
  );
  assert.match(
    regression,
    /the recovered assignment pass finalizes without a cutoff mismatch/,
  );
  assert.match(
    regression,
    /the pass resolves only its frozen cutoff and opens a later recurrence without losing evidence/,
  );
});

test("new private helpers are never granted to browser or worker roles", () => {
  assert.match(
    migration,
    /revoke all on function app_private\.cancel_untouched_practice_level_mismatches\([\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function app_private\.(?:practice_class_context_is_active|lock_active_practice_class_context|cancel_untouched_practice_level_mismatches)/,
  );
});
