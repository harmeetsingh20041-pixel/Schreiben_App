import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { aiFairShareEnvelope } from "./project-ai-cost.js";

const ROOT = resolve(import.meta.dirname, "../..");

test("reservation attribution is monitor-only, serialized, immutable, and private while hard caps remain", async () => {
  const [
    authorityMigration,
    foundationMigration,
    reserveMigration,
    evidenceMigration,
    baseline,
  ] = await Promise.all([
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260715100101_approved_batch_writing_allowance.sql",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260713084132_cohort_ai_spend_fair_share.sql",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260712120000_archive_writing_live_canary_spend.sql",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260711215912_phase_12r_gemini_secondary_provider.sql",
      ),
      "utf8",
    ),
    readFile(
      resolve(ROOT, "config/production-clean-baseline-contract.json"),
      "utf8",
    ),
  ]);
  assert.match(
    authorityMigration,
    /from public\.workspace_members membership[\s\S]*order by membership\.id[\s\S]*for share/,
  );
  assert.match(
    authorityMigration,
    /current_setting\('app\.ai_spend_transition', true\) <> 'on'[\s\S]*message = 'ai_spend_evidence_immutable'/,
  );
  assert.match(
    authorityMigration,
    /new\.student_id := selected_student_id[\s\S]*new\.cached_input_rate_microusd_per_million :=[\s\S]*selected_policy\.cached_input_rate_microusd_per_million/,
  );
  assert.doesNotMatch(
    authorityMigration,
    /ai_spend_(student_fair_share|cohort_budget)_exceeded/,
  );
  assert.doesNotMatch(
    authorityMigration,
    /(global_student_committed_microusd|cohort_committed_microusd)/,
  );
  assert.match(
    authorityMigration,
    /operating_target_microeur_per_active_student_month[\s\S]*Planning and monitoring target only/,
  );
  assert.match(
    foundationMigration,
    /create index ai_spend_reservations_global_student_month_idx[\s\S]*student_id, billing_month, state[\s\S]*where state in \('reserved', 'finalized'\)/,
  );
  assert.match(
    foundationMigration,
    /create trigger ai_spend_reservations_00_fair_share[\s\S]*before insert on app_private\.ai_spend_reservations[\s\S]*enforce_ai_spend_fair_share/,
  );
  assert.match(
    reserveMigration,
    /into strict global_policy[\s\S]*where policy\.singleton[\s\S]*for update[\s\S]*insert into app_private\.ai_spend_reservations/,
  );
  assert.match(
    reserveMigration,
    /if global_policy\.emergency_stop[\s\S]*message = 'ai_spend_emergency_stop'/,
  );
  assert.match(
    reserveMigration,
    /workspace_committed \+ maximum_cost_microusd[\s\S]*message = 'ai_spend_workspace_budget_exceeded'/,
  );
  assert.match(
    reserveMigration,
    /global_committed \+ maximum_cost_microusd[\s\S]*message = 'ai_spend_global_budget_exceeded'/,
  );
  assert.match(
    reserveMigration,
    /set_config\('app\.ai_spend_transition', 'on', true\)[\s\S]*insert into app_private\.ai_spend_reservations[\s\S]*set_config\('app\.ai_spend_transition', 'off', true\)/,
  );
  assert.match(
    reserveMigration,
    /revoke all on function app_private\.reserve_ai_spend\([\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute on function app_private\.reserve_ai_spend\([\s\S]*to service_role/,
  );
  assert.match(
    evidenceMigration,
    /revoke all on table app_private\.ai_spend_reservations[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    evidenceMigration,
    /message = 'ai_spend_evidence_immutable'[\s\S]*create trigger ai_spend_reservations_guard[\s\S]*before insert or update or delete on app_private\.ai_spend_reservations/,
  );
  assert.match(
    authorityMigration,
    /revoke all on function app_private\.enforce_ai_spend_fair_share\(\)[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    authorityMigration,
    /(student_text|original_text|provider_payload|prompt_content|answer_text)/i,
  );
  assert.match(baseline, /cached_input_rate_microusd_per_million/);
  assert.match(baseline, /operating_target_microeur_per_active_student_month/);
});

test("reservation and offboarding share async-job then advisory then membership lock order", async () => {
  const [authorityMigration, foundationMigration] = await Promise.all([
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260715100101_approved_batch_writing_allowance.sql",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260713084132_cohort_ai_spend_fair_share.sql",
      ),
      "utf8",
    ),
  ]);
  const fairShareStart = authorityMigration.indexOf(
    "create or replace function app_private.enforce_ai_spend_fair_share()",
  );
  const fairShareEnd = authorityMigration.indexOf(
    "revoke all on function app_private.enforce_ai_spend_fair_share()",
  );
  const fairShare = authorityMigration.slice(fairShareStart, fairShareEnd);
  const fairGlobalAdvisory = fairShare.indexOf(
    "app_private.student_month_work_lock_key(",
  );
  const fairWorkspaceAdvisory = fairShare.indexOf(
    "app_private.student_workspace_work_lock_key(",
    fairGlobalAdvisory,
  );
  const fairMembership = fairShare.indexOf(
    "from public.workspace_members membership",
    fairWorkspaceAdvisory,
  );
  const fairMembershipLock = fairShare.indexOf("for share;", fairMembership);
  assert.ok(
    fairShareStart >= 0 &&
      fairGlobalAdvisory >= 0 &&
      fairGlobalAdvisory < fairWorkspaceAdvisory &&
      fairWorkspaceAdvisory < fairMembership &&
      fairMembership < fairMembershipLock,
  );

  const offboardStart = foundationMigration.indexOf(
    "create or replace function app_private.offboard_student_internal(",
  );
  const offboardEnd = foundationMigration.indexOf(
    "revoke all on function app_private.offboard_student_internal(uuid, uuid)",
    offboardStart,
  );
  const offboard = foundationMigration.slice(offboardStart, offboardEnd);
  const jobLock = offboard.indexOf("order by job.id\n    for update");
  const globalAdvisory = offboard.indexOf(
    "app_private.student_month_work_lock_key(",
    jobLock,
  );
  const workspaceAdvisory = offboard.indexOf(
    "app_private.student_workspace_work_lock_key(",
    globalAdvisory,
  );
  const lockedRoleRead = offboard.indexOf(
    "select membership.role",
    workspaceAdvisory,
  );
  const membershipLock = offboard.indexOf("for update;", lockedRoleRead);
  assert.ok(
    offboardStart >= 0 &&
      jobLock >= 0 &&
      jobLock < globalAdvisory &&
      globalAdvisory < workspaceAdvisory &&
      workspaceAdvisory < lockedRoleRead &&
      lockedRoleRead < membershipLock,
  );
  assert.match(
    offboard,
    /if target_role is not null and target_role <> 'student'[\s\S]*Only student memberships can be offboarded/,
  );
  assert.match(
    foundationMigration,
    /revoke all on function app_private\.student_month_work_lock_key\(uuid, date\)[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    foundationMigration,
    /revoke all on function app_private\.student_workspace_work_lock_key\(uuid, uuid\)[\s\S]*from public, anon, authenticated, service_role/,
  );
});

test("monitor-only attribution still serializes one student month across workspaces", async () => {
  const [authorityMigration, foundationMigration] = await Promise.all([
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260715100101_approved_batch_writing_allowance.sql",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260713084132_cohort_ai_spend_fair_share.sql",
      ),
      "utf8",
    ),
  ]);
  const keyStart = foundationMigration.indexOf(
    "create or replace function app_private.student_month_work_lock_key(",
  );
  const keyEnd = foundationMigration.indexOf(
    "revoke all on function app_private.student_month_work_lock_key(uuid, date)",
    keyStart,
  );
  const keyFunction = foundationMigration.slice(keyStart, keyEnd);
  assert.match(keyFunction, /target_student_id::text/);
  assert.match(keyFunction, /target_billing_month::text/);
  assert.doesNotMatch(keyFunction, /workspace/);

  const fairShareStart = authorityMigration.indexOf(
    "create or replace function app_private.enforce_ai_spend_fair_share()",
  );
  const fairShareEnd = authorityMigration.indexOf(
    "revoke all on function app_private.enforce_ai_spend_fair_share()",
  );
  const fairShare = authorityMigration.slice(fairShareStart, fairShareEnd);
  const globalLock = fairShare.indexOf(
    "app_private.student_month_work_lock_key(\n      selected_student_id,\n      new.billing_month",
  );
  const workspaceLock = fairShare.indexOf(
    "app_private.student_workspace_work_lock_key(\n      new.workspace_id,\n      selected_student_id",
    globalLock,
  );
  const membershipLock = fairShare.indexOf(
    "from public.workspace_members membership",
    workspaceLock,
  );
  assert.ok(
    globalLock >= 0 &&
      globalLock < workspaceLock &&
      workspaceLock < membershipLock,
  );
  assert.doesNotMatch(fairShare, /global_student_committed_microusd/);
  assert.doesNotMatch(fairShare, /cohort_committed_microusd/);
  assert.doesNotMatch(
    fairShare,
    /ai_spend_(student_fair_share|cohort_budget)_exceeded/,
  );
});

test("20, 50, and 250 active students produce exact planning envelopes", () => {
  const expected = new Map([
    [20, { cohort: 23_913_040, effective: 23_913_040 }],
    [50, { cohort: 59_782_600, effective: 59_782_600 }],
    [250, { cohort: 298_913_000, effective: 100_000_000 }],
  ]);
  for (const [activeStudents, wanted] of expected) {
    const actual = aiFairShareEnvelope({
      active_students: activeStudents,
      operating_target_eur_per_active_student_month: 1,
      fair_share_reserve_basis_points: 1_000,
      usd_to_eur: 0.92,
      workspace_limit_microusd: 100_000_000,
      global_limit_microusd: 225_000_000,
    });
    assert.equal(actual.per_student_limit_microusd, 1_195_652);
    assert.equal(actual.cohort_limit_microusd, wanted.cohort);
    assert.equal(
      actual.effective_single_workspace_limit_microusd,
      wanted.effective,
    );
  }
});
