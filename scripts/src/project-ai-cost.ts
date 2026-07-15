import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AiCostProjectionInput = {
  schema_version: 1;
  active_students: number;
  observation_days: number;
  usd_to_eur: number;
  exchange_rate_verified_at: string;
  exchange_rate_source: string;
  finalized_actual_microusd: number;
  estimated_maximum_microusd?: number;
  reserved_committed_microusd: number;
};

export type AiCostProjectionContract = {
  schema_version: 1;
  operating_target_eur_per_active_student_month: number;
  fair_share_reserve_basis_points: number;
  emergency_ceiling_eur_per_active_student_month: number;
  stale_exchange_rate_fallback_microrate: number;
  maximum_exchange_rate_age_days: number;
  approved_exchange_rate_sources: string[];
};

export type AiCostProjectionReport = {
  schema_version: 1;
  passed: boolean;
  active_students: number;
  observation_days: number;
  usd_to_eur: number;
  exchange_rate_verified_at: string;
  exchange_rate_source: string;
  exchange_rate_age_days: number;
  observed_committed_usd: number;
  projected_monthly_eur: number;
  projected_monthly_eur_per_active_student: number;
  operating_target_eur_per_active_student_month: number;
  fair_share_admission_ceiling_eur_per_student_month: number;
  emergency_ceiling_eur_per_active_student_month: number;
};

export type AiFairShareEnvelope = {
  active_students: number;
  per_student_limit_microusd: number;
  cohort_limit_microusd: number;
  effective_single_workspace_limit_microusd: number;
};

export type RuntimeExchangeRate = {
  effective_usd_to_eur_microrate: number;
  stale_fallback_used: boolean;
};

function positiveInteger(value: unknown, maximum: number) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
    ? value
    : null;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function dateOnlyEpoch(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    return null;
  }
  return parsed;
}

function roundMoney(value: number) {
  return Number(value.toFixed(6));
}

export function runtimeExchangeRate(args: {
  observed_usd_to_eur_microrate: number;
  exchange_rate_verified_at: string;
  maximum_exchange_rate_age_days: number;
  stale_exchange_rate_fallback_microrate: number;
  now?: Date;
}): RuntimeExchangeRate {
  const observed = args.observed_usd_to_eur_microrate;
  const fallback = args.stale_exchange_rate_fallback_microrate;
  const verifiedEpoch = dateOnlyEpoch(args.exchange_rate_verified_at);
  const now = args.now ?? new Date();
  const todayEpoch = Number.isFinite(now.getTime())
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    : Number.NaN;
  const ageDays =
    verifiedEpoch === null || !Number.isFinite(todayEpoch)
      ? Number.NaN
      : (todayEpoch - verifiedEpoch) / 86_400_000;
  if (
    !Number.isSafeInteger(observed) ||
    observed < 500_000 ||
    observed > 1_500_000 ||
    fallback !== 1_500_000 ||
    !Number.isSafeInteger(args.maximum_exchange_rate_age_days) ||
    args.maximum_exchange_rate_age_days < 1 ||
    args.maximum_exchange_rate_age_days > 14 ||
    !Number.isSafeInteger(ageDays) ||
    ageDays < 0
  ) {
    throw new Error("AI runtime exchange-rate input is invalid.");
  }
  const stale = ageDays > args.maximum_exchange_rate_age_days;
  return {
    effective_usd_to_eur_microrate: stale
      ? Math.max(observed, fallback)
      : observed,
    stale_fallback_used: stale,
  };
}

export function projectAiCost(
  input: AiCostProjectionInput,
  contract: AiCostProjectionContract,
  now = new Date(),
): AiCostProjectionReport {
  const activeStudents = positiveInteger(input.active_students, 100_000);
  const observationDays = positiveInteger(input.observation_days, 31);
  const finalized = nonNegativeInteger(input.finalized_actual_microusd);
  const estimated = nonNegativeInteger(input.estimated_maximum_microusd ?? 0);
  const reserved = nonNegativeInteger(input.reserved_committed_microusd);
  const exchangeRateEpoch = dateOnlyEpoch(input.exchange_rate_verified_at);
  const todayEpoch = Number.isFinite(now.getTime())
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    : Number.NaN;
  const exchangeRateAgeDays =
    exchangeRateEpoch === null || !Number.isFinite(todayEpoch)
      ? null
      : (todayEpoch - exchangeRateEpoch) / 86_400_000;
  const approvedSources = Array.isArray(contract.approved_exchange_rate_sources)
    ? contract.approved_exchange_rate_sources
    : [];
  if (
    input.schema_version !== 1 ||
    contract.schema_version !== 1 ||
    activeStudents === null ||
    observationDays === null ||
    observationDays < 7 ||
    finalized === null ||
    estimated === null ||
    reserved === null ||
    typeof input.usd_to_eur !== "number" ||
    !Number.isFinite(input.usd_to_eur) ||
    input.usd_to_eur < 0.5 ||
    input.usd_to_eur > 1.5 ||
    exchangeRateEpoch === null ||
    exchangeRateAgeDays === null ||
    !Number.isSafeInteger(exchangeRateAgeDays) ||
    exchangeRateAgeDays < 0 ||
    !Number.isSafeInteger(contract.maximum_exchange_rate_age_days) ||
    contract.maximum_exchange_rate_age_days < 1 ||
    contract.maximum_exchange_rate_age_days > 14 ||
    exchangeRateAgeDays > contract.maximum_exchange_rate_age_days ||
    typeof input.exchange_rate_source !== "string" ||
    !approvedSources.includes(input.exchange_rate_source) ||
    approvedSources.length === 0 ||
    new Set(approvedSources).size !== approvedSources.length ||
    !Number.isSafeInteger(contract.fair_share_reserve_basis_points) ||
    contract.fair_share_reserve_basis_points < 0 ||
    contract.fair_share_reserve_basis_points > 1_500 ||
    contract.stale_exchange_rate_fallback_microrate !== 1_500_000 ||
    typeof contract.operating_target_eur_per_active_student_month !==
      "number" ||
    contract.operating_target_eur_per_active_student_month <= 0 ||
    typeof contract.emergency_ceiling_eur_per_active_student_month !==
      "number" ||
    contract.emergency_ceiling_eur_per_active_student_month <
      contract.operating_target_eur_per_active_student_month
  ) {
    throw new Error("AI cost projection input is invalid.");
  }

  const committedMicrousd = finalized + estimated + reserved;
  if (!Number.isSafeInteger(committedMicrousd)) {
    throw new Error("AI cost projection input is invalid.");
  }
  const observedCommittedUsd = committedMicrousd / 1_000_000;
  const projectedMonthlyEur =
    observedCommittedUsd * input.usd_to_eur * (30 / observationDays);
  const perStudent = projectedMonthlyEur / activeStudents;
  const target = contract.operating_target_eur_per_active_student_month;

  return {
    schema_version: 1,
    passed: perStudent <= target,
    active_students: activeStudents,
    observation_days: observationDays,
    usd_to_eur: input.usd_to_eur,
    exchange_rate_verified_at: input.exchange_rate_verified_at,
    exchange_rate_source: input.exchange_rate_source,
    exchange_rate_age_days: exchangeRateAgeDays,
    observed_committed_usd: roundMoney(observedCommittedUsd),
    projected_monthly_eur: roundMoney(projectedMonthlyEur),
    projected_monthly_eur_per_active_student: roundMoney(perStudent),
    operating_target_eur_per_active_student_month: target,
    fair_share_admission_ceiling_eur_per_student_month: roundMoney(
      target * (1 + contract.fair_share_reserve_basis_points / 10_000),
    ),
    emergency_ceiling_eur_per_active_student_month:
      contract.emergency_ceiling_eur_per_active_student_month,
  };
}

export function aiFairShareEnvelope(args: {
  active_students: number;
  operating_target_eur_per_active_student_month: number;
  fair_share_reserve_basis_points: number;
  usd_to_eur: number;
  workspace_limit_microusd: number;
  global_limit_microusd: number;
}): AiFairShareEnvelope {
  const activeStudents = positiveInteger(args.active_students, 100_000);
  const workspaceLimit = nonNegativeInteger(args.workspace_limit_microusd);
  const globalLimit = nonNegativeInteger(args.global_limit_microusd);
  const targetMicroeur = Number.isFinite(
    args.operating_target_eur_per_active_student_month,
  )
    ? Math.round(args.operating_target_eur_per_active_student_month * 1_000_000)
    : Number.NaN;
  const fxMicrorate = Number.isFinite(args.usd_to_eur)
    ? Math.round(args.usd_to_eur * 1_000_000)
    : Number.NaN;
  if (
    activeStudents === null ||
    workspaceLimit === null ||
    workspaceLimit < 1 ||
    globalLimit === null ||
    globalLimit < 1 ||
    !Number.isSafeInteger(targetMicroeur) ||
    targetMicroeur < 1 ||
    !Number.isSafeInteger(fxMicrorate) ||
    fxMicrorate < 500_000 ||
    fxMicrorate > 1_500_000 ||
    !Number.isSafeInteger(args.fair_share_reserve_basis_points) ||
    args.fair_share_reserve_basis_points < 0 ||
    args.fair_share_reserve_basis_points > 1_500
  ) {
    throw new Error("AI fair-share input is invalid.");
  }
  const perStudent = Number(
    (BigInt(targetMicroeur) *
      BigInt(10_000 + args.fair_share_reserve_basis_points) *
      1_000_000n) /
      (10_000n * BigInt(fxMicrorate)),
  );
  const cohort = perStudent * activeStudents;
  if (!Number.isSafeInteger(perStudent) || !Number.isSafeInteger(cohort)) {
    throw new Error("AI fair-share input is invalid.");
  }
  return {
    active_students: activeStudents,
    per_student_limit_microusd: perStudent,
    cohort_limit_microusd: cohort,
    effective_single_workspace_limit_microusd: Math.min(
      cohort,
      workspaceLimit,
      globalLimit,
    ),
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const inputPath = argument("--input");
  const contractPath =
    argument("--contract") ?? "config/ai-provider-costs.json";
  if (!inputPath) {
    throw new Error(
      "Usage: ai-cost:project -- --input <content-free-spend-summary.json>",
    );
  }
  const [inputSource, contractSource] = await Promise.all([
    readFile(resolve(inputPath), "utf8"),
    readFile(resolve(contractPath), "utf8"),
  ]);
  const report = projectAiCost(
    JSON.parse(inputSource) as AiCostProjectionInput,
    JSON.parse(contractSource) as AiCostProjectionContract,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : "AI cost projection failed."
      }\n`,
    );
    process.exitCode = 1;
  });
}
