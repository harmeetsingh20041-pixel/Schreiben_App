import assert from "node:assert/strict";
import test from "node:test";
import {
  aiFairShareEnvelope,
  projectAiCost,
  runtimeExchangeRate,
} from "./project-ai-cost.js";

const now = new Date("2026-07-13T12:00:00.000Z");
const exchangeRateSource =
  "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A";

const contract = {
  schema_version: 1 as const,
  operating_target_eur_per_active_student_month: 1,
  fair_share_reserve_basis_points: 1_000,
  emergency_ceiling_eur_per_active_student_month: 2,
  stale_exchange_rate_fallback_microrate: 1_500_000,
  maximum_exchange_rate_age_days: 7,
  approved_exchange_rate_sources: [exchangeRateSource],
};

test("projects metered, estimated-maximum, and reserved spend below EUR 1", () => {
  const report = projectAiCost(
    {
      schema_version: 1,
      active_students: 250,
      observation_days: 10,
      usd_to_eur: 0.92,
      exchange_rate_verified_at: "2026-07-11",
      exchange_rate_source: exchangeRateSource,
      finalized_actual_microusd: 50_000_000,
      estimated_maximum_microusd: 5_000_000,
      reserved_committed_microusd: 1_000_000,
    },
    contract,
    now,
  );
  assert.equal(report.passed, true);
  assert.equal(report.projected_monthly_eur_per_active_student, 0.61824);
  assert.equal(report.exchange_rate_age_days, 2);
  assert.equal(report.exchange_rate_source, exchangeRateSource);
  assert.equal(report.fair_share_admission_ceiling_eur_per_student_month, 1.1);
});

test("fails the operating gate even before the emergency ceiling", () => {
  const report = projectAiCost(
    {
      schema_version: 1,
      active_students: 100,
      observation_days: 10,
      usd_to_eur: 1,
      exchange_rate_verified_at: "2026-07-11",
      exchange_rate_source: exchangeRateSource,
      finalized_actual_microusd: 35_000_000,
      estimated_maximum_microusd: 0,
      reserved_committed_microusd: 0,
    },
    contract,
    now,
  );
  assert.equal(report.projected_monthly_eur_per_active_student, 1.05);
  assert.equal(report.passed, false);
});

test("requires at least seven observed days and rejects malformed money", () => {
  assert.throws(() =>
    projectAiCost(
      {
        schema_version: 1,
        active_students: 20,
        observation_days: 6,
        usd_to_eur: 0.92,
        exchange_rate_verified_at: "2026-07-11",
        exchange_rate_source: exchangeRateSource,
        finalized_actual_microusd: 1,
        estimated_maximum_microusd: 0,
        reserved_committed_microusd: 0,
      },
      contract,
      now,
    ),
  );
  assert.throws(() =>
    projectAiCost(
      {
        schema_version: 1,
        active_students: 20,
        observation_days: 10,
        usd_to_eur: 0.92,
        exchange_rate_verified_at: "2026-07-11",
        exchange_rate_source: exchangeRateSource,
        finalized_actual_microusd: -1,
        estimated_maximum_microusd: 0,
        reserved_committed_microusd: 0,
      },
      contract,
      now,
    ),
  );
  assert.throws(() =>
    projectAiCost(
      {
        schema_version: 1,
        active_students: 20,
        observation_days: 10,
        usd_to_eur: 0.92,
        exchange_rate_verified_at: "2026-07-11",
        exchange_rate_source: exchangeRateSource,
        finalized_actual_microusd: 1,
        estimated_maximum_microusd: -1,
        reserved_committed_microusd: 0,
      },
      contract,
      now,
    ),
  );
});

test("legacy summaries without an estimate field remain backward compatible", () => {
  const report = projectAiCost(
    {
      schema_version: 1,
      active_students: 100,
      observation_days: 10,
      usd_to_eur: 1,
      exchange_rate_verified_at: "2026-07-11",
      exchange_rate_source: exchangeRateSource,
      finalized_actual_microusd: 10_000_000,
      reserved_committed_microusd: 0,
    },
    contract,
    now,
  );
  assert.equal(report.observed_committed_usd, 10);
});

test("rejects future, stale, or unapproved exchange-rate evidence", () => {
  const base = {
    schema_version: 1 as const,
    active_students: 20,
    observation_days: 10,
    usd_to_eur: 0.92,
    exchange_rate_verified_at: "2026-07-11",
    exchange_rate_source: exchangeRateSource,
    finalized_actual_microusd: 1,
    estimated_maximum_microusd: 0,
    reserved_committed_microusd: 0,
  };
  assert.throws(() =>
    projectAiCost(
      { ...base, exchange_rate_verified_at: "2026-07-14" },
      contract,
      now,
    ),
  );
  assert.throws(() =>
    projectAiCost(
      { ...base, exchange_rate_verified_at: "2026-07-05" },
      contract,
      now,
    ),
  );
  assert.throws(() =>
    projectAiCost(
      { ...base, exchange_rate_source: "https://example.invalid/fx" },
      contract,
      now,
    ),
  );
});

test("fair-share envelopes are deterministic for 20, 50, and 250 students", () => {
  const expected = [
    [20, 23_913_040],
    [50, 59_782_600],
    [250, 100_000_000],
  ] as const;
  for (const [activeStudents, effective] of expected) {
    const envelope = aiFairShareEnvelope({
      active_students: activeStudents,
      operating_target_eur_per_active_student_month: 1,
      fair_share_reserve_basis_points: 1_000,
      usd_to_eur: 0.92,
      workspace_limit_microusd: 100_000_000,
      global_limit_microusd: 225_000_000,
    });
    assert.equal(envelope.per_student_limit_microusd, 1_195_652);
    assert.equal(envelope.cohort_limit_microusd, 1_195_652 * activeStudents);
    assert.equal(envelope.effective_single_workspace_limit_microusd, effective);
  }
});

test("stale runtime FX tightens admission without shutting off AI", () => {
  const freshRate = runtimeExchangeRate({
    observed_usd_to_eur_microrate: 920_000,
    exchange_rate_verified_at: "2026-07-11",
    maximum_exchange_rate_age_days: 7,
    stale_exchange_rate_fallback_microrate: 1_500_000,
    now,
  });
  const staleRate = runtimeExchangeRate({
    observed_usd_to_eur_microrate: 920_000,
    exchange_rate_verified_at: "2026-07-01",
    maximum_exchange_rate_age_days: 7,
    stale_exchange_rate_fallback_microrate: 1_500_000,
    now,
  });
  assert.deepEqual(freshRate, {
    effective_usd_to_eur_microrate: 920_000,
    stale_fallback_used: false,
  });
  assert.deepEqual(staleRate, {
    effective_usd_to_eur_microrate: 1_500_000,
    stale_fallback_used: true,
  });

  const envelope = (microrate: number) =>
    aiFairShareEnvelope({
      active_students: 20,
      operating_target_eur_per_active_student_month: 1,
      fair_share_reserve_basis_points: 1_000,
      usd_to_eur: microrate / 1_000_000,
      workspace_limit_microusd: 100_000_000,
      global_limit_microusd: 225_000_000,
    });
  assert.ok(
    envelope(staleRate.effective_usd_to_eur_microrate)
      .per_student_limit_microusd <=
      envelope(freshRate.effective_usd_to_eur_microrate)
        .per_student_limit_microusd,
  );
  assert.throws(() =>
    runtimeExchangeRate({
      observed_usd_to_eur_microrate: 920_000,
      exchange_rate_verified_at: "2026-07-14",
      maximum_exchange_rate_age_days: 7,
      stale_exchange_rate_fallback_microrate: 1_500_000,
      now,
    }),
  );
  assert.throws(() =>
    runtimeExchangeRate({
      observed_usd_to_eur_microrate: 0,
      exchange_rate_verified_at: "2026-07-11",
      maximum_exchange_rate_age_days: 7,
      stale_exchange_rate_fallback_microrate: 1_500_000,
      now,
    }),
  );
  assert.throws(() =>
    runtimeExchangeRate({
      observed_usd_to_eur_microrate: 920_000,
      exchange_rate_verified_at: "2026-07-01",
      maximum_exchange_rate_age_days: 7,
      stale_exchange_rate_fallback_microrate: 1_400_000,
      now,
    }),
  );
});
