import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

type Policy = {
  provider: string;
  model: string;
  purpose: string;
  cached_input_rate_microusd_per_million: number;
  input_rate_microusd_per_million: number;
  output_rate_microusd_per_million: number;
  maximum_reservation_microusd: number;
};

function policyKey(policy: Pick<Policy, "provider" | "model" | "purpose">) {
  return `${policy.provider}:${policy.model}:${policy.purpose}`;
}

function policiesFromMigration(source: string): Policy[] {
  return [
    ...source.matchAll(
      /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(\d+)\s*,\s*(?:(\d+)\s*,\s*)?(\d+)\s*,\s*(\d+)\s*\)/g,
    ),
  ].map((match) => ({
    provider: match[1]!,
    model: match[2]!,
    purpose: match[3]!,
    cached_input_rate_microusd_per_million: Number(match[5] ?? match[4]),
    input_rate_microusd_per_million: Number(match[4]),
    output_rate_microusd_per_million: Number(match[6]),
    maximum_reservation_microusd: Number(match[7]),
  }));
}

test("pricing contract, migration, Edge allowlist, and EUR 1 planning target cannot drift", async () => {
  const [
    configSource,
    migration,
    criticCompatibilityMigration,
    availableGeminiMigration,
    guardrailMigration,
    fairShareMigration,
    authorityMigration,
    reserveMigration,
    edgeSource,
    preflight,
  ] = await Promise.all([
    readFile(resolve(ROOT, "config/ai-provider-costs.json"), "utf8"),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260711215912_phase_12r_gemini_secondary_provider.sql",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260712010400_phase_12w_gemini_3_critic_compatibility.sql",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260713140000_pin_available_gemini_flash_lite.sql",
      ),
      "utf8",
    ),
    readFile(
      resolve(
        ROOT,
        "supabase/migrations/20260712010100_phase_12t_launch_cost_guardrails.sql",
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
        "supabase/migrations/20260715100101_approved_batch_writing_allowance.sql",
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
      resolve(ROOT, "supabase/functions/_shared/ai-spend-accounting.ts"),
      "utf8",
    ),
    readFile(
      resolve(ROOT, "scripts/src/verify-production-preflight.ts"),
      "utf8",
    ),
  ]);
  const config = JSON.parse(configSource) as {
    schema_version: number;
    currency: string;
    pricing_verified_at: string;
    pricing_sources: string[];
    operating_target_eur_per_active_student_month: number;
    fair_share_reserve_basis_points: number;
    emergency_ceiling_eur_per_active_student_month: number;
    stale_exchange_rate_fallback_microrate: number;
    maximum_exchange_rate_age_days: number;
    approved_exchange_rate_sources: string[];
    global_monthly_limit_microusd: number;
    default_workspace_monthly_limit_microusd: number;
    policies: Policy[];
  };
  assert.equal(config.schema_version, 1);
  assert.equal(config.currency, "USD");
  assert.match(config.pricing_verified_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(config.pricing_sources, [
    "https://api-docs.deepseek.com/quick_start/pricing",
    "https://ai.google.dev/gemini-api/docs/pricing",
  ]);
  assert.equal(config.operating_target_eur_per_active_student_month, 1);
  assert.equal(config.fair_share_reserve_basis_points, 1_000);
  assert.equal(config.emergency_ceiling_eur_per_active_student_month, 2);
  assert.equal(config.stale_exchange_rate_fallback_microrate, 1_500_000);
  assert.equal(config.maximum_exchange_rate_age_days, 7);
  assert.deepEqual(config.approved_exchange_rate_sources, [
    "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A",
  ]);
  assert.equal(config.global_monthly_limit_microusd, 225_000_000);
  assert.equal(config.default_workspace_monthly_limit_microusd, 100_000_000);
  assert.equal(config.policies.length, 13);
  assert.equal(new Set(config.policies.map(policyKey)).size, 13);
  const normalizedEdgeSource = edgeSource.replace(/(?<=\d)_(?=\d)/g, "");

  const migrationPolicies = [
    ...policiesFromMigration(migration),
    ...policiesFromMigration(criticCompatibilityMigration),
    ...policiesFromMigration(availableGeminiMigration),
  ];
  assert.equal(migrationPolicies.length, 20);
  assert.equal(new Set(migrationPolicies.map(policyKey)).size, 20);
  const retiredPolicies = migrationPolicies.filter(
    (policy) =>
      policy.provider === "gemini" && policy.model !== "gemini-3.1-flash-lite",
  );
  assert.deepEqual(
    retiredPolicies.map((policy) => policy.purpose).sort(),
    [
      "worksheet_critique",
      "worksheet_generation",
      "writing_critique",
      "writing_final_critique",
      "writing_generation",
      "worksheet_critique",
      "writing_critique",
    ].sort(),
  );
  const activeMigrationPolicies = migrationPolicies.filter(
    (policy) =>
      policy.provider !== "gemini" || policy.model === "gemini-3.1-flash-lite",
  );
  assert.deepEqual(
    activeMigrationPolicies
      .map(
        ({ cached_input_rate_microusd_per_million: _cached, ...policy }) =>
          policy,
      )
      .sort((left, right) => policyKey(left).localeCompare(policyKey(right))),
    [...config.policies]
      .map(
        ({ cached_input_rate_microusd_per_million: _cached, ...policy }) =>
          policy,
      )
      .sort((left, right) => policyKey(left).localeCompare(policyKey(right))),
  );

  for (const policy of config.policies) {
    if (policy.provider === "deepseek") {
      const expected = policy.model === "deepseek-v4-flash" ? 2_800 : 3_625;
      assert.equal(policy.cached_input_rate_microusd_per_million, expected);
    } else {
      assert.equal(policy.model, "gemini-3.1-flash-lite");
      assert.equal(policy.cached_input_rate_microusd_per_million, 25_000);
      assert.equal(policy.input_rate_microusd_per_million, 250_000);
      assert.equal(policy.output_rate_microusd_per_million, 1_500_000);
    }
  }
  assert.match(
    availableGeminiMigration,
    /call_purpose = 'worksheet_answer_evaluation'[\s\S]*cached_input_rate_microusd_per_million = 25000/,
  );
  assert.match(
    fairShareMigration,
    /deepseek-v4-flash' then 2800[\s\S]*deepseek-v4-pro' then 3625/,
  );
  assert.match(
    fairShareMigration,
    /effective_usd_to_eur_microrate := greatest\([\s\S]*stale_exchange_rate_fallback_microrate/,
  );
  assert.match(
    authorityMigration,
    /new\.student_id := selected_student_id[\s\S]*new\.cached_input_rate_microusd_per_million :=[\s\S]*selected_policy\.cached_input_rate_microusd_per_million/,
  );
  assert.doesNotMatch(
    authorityMigration,
    /ai_spend_(student_fair_share|cohort_budget)_exceeded/,
  );
  assert.match(
    authorityMigration,
    /operating_target_microeur_per_active_student_month[\s\S]*Planning and monitoring target only/,
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

  for (const policy of config.policies) {
    const escaped = [policy.provider, policy.model, policy.purpose].map(
      (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    assert.match(
      normalizedEdgeSource,
      new RegExp(
        `provider:\\s*"${escaped[0]}"[\\s\\S]{0,120}` +
          `model:\\s*"${escaped[1]}"[\\s\\S]{0,120}` +
          `purpose:\\s*"${escaped[2]}"[\\s\\S]{0,120}` +
          `maximumCostMicrousd:\\s*${policy.maximum_reservation_microusd}`,
      ),
    );
  }
  assert.match(preflight, /maximum_projected_cost_per_student_eur\s*<=\s*1/);
  assert.match(guardrailMigration, /monthly_limit_microusd\s*=\s*225000000/);
  assert.match(
    guardrailMigration,
    /default_workspace_monthly_limit_microusd[\s\S]{0,160}100000000|USD 100 workspace default/,
  );
  assert.match(
    preflight,
    /V1_GLOBAL_MONTHLY_AI_CAP_MICROUSD\s*=\s*225_000_000/,
  );
  assert.match(
    preflight,
    /V1_DEFAULT_WORKSPACE_MONTHLY_AI_CAP_MICROUSD\s*=\s*100_000_000/,
  );
});
