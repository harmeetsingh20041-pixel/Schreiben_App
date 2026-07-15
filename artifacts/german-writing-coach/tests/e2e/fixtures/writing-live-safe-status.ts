export const WRITING_LIVE_CAPACITY_VALUE_COUNT = 10;
export const WRITING_LIVE_STATUS_VALUE_COUNT = 26;

const WRITING_ADJUDICATION_REASON_BY_ORDINAL = [
  null,
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

const FIRST_SYSTEM_HOLD_REASON_ORDINAL = 4;

const WRITING_JOB_ERROR_BY_ORDINAL = [
  null,
  "provider_timeout",
  "provider_unavailable",
  "provider_http_408",
  "provider_http_425",
  "provider_http_429",
  "provider_http_500",
  "provider_http_502",
  "provider_http_503",
  "provider_http_504",
  "writing_critic_timeout",
  "writing_adjudication_deadline_exceeded",
  "writing_spend_accounting_failed",
  "provider_response_invalid",
  "provider_response_too_large",
  "provider_authentication_failed",
  "feedback_invalid_after_pro",
  "ai_spend_workspace_budget_exceeded",
  "ai_spend_cohort_budget_exceeded",
  "ai_spend_student_fair_share_exceeded",
  "ai_spend_student_inactive",
  "ai_spend_global_budget_exceeded",
  "ai_spend_fx_rate_future",
  "ai_spend_fx_rate_stale",
  "ai_spend_emergency_stop",
  "ai_spend_model_not_allowed",
  "ai_spend_contract_invalid",
  "ai_spend_reservation_missing",
  "ai_spend_reservation_expired",
  "ai_spend_actual_exceeds_reserved",
  "ai_spend_reservation_conflict",
  "ai_spend_release_reason_invalid",
  "ai_spend_job_missing",
  "ai_spend_job_version_mismatch",
  "ai_spend_job_not_active",
  "ai_spend_response_invalid",
  "ai_spend_accounting_timeout",
  "ai_spend_accounting_unavailable",
  "ai_spend_duplicate_dispatch",
  "ai_spend_reservation_already_settled",
  "ai_spend_dispatch_uncertain",
] as const;

export type WritingLiveSafeStatus = Readonly<{
  submissionCount: number;
  exactScope: boolean;
  evaluationQueued: boolean;
  evaluationProcessing: boolean;
  evaluationReady: boolean;
  evaluationNeedsReview: boolean;
  evaluationFailed: boolean;
  releaseHeld: boolean;
  releaseScheduled: boolean;
  releaseReleased: boolean;
  jobCount: number;
  jobQueued: boolean;
  jobProcessing: boolean;
  jobRetry: boolean;
  jobSucceeded: boolean;
  jobDead: boolean;
  attemptCount: number;
  hasError: boolean;
  retryDue: boolean;
  retryScheduled: boolean;
  activeLease: boolean;
  adjudicationCount: number;
  adjudicationAccepted: boolean;
  adjudicationSystemHold: boolean;
  adjudicationReasonOrdinal: number;
  jobErrorOrdinal: number;
}>;

export type WritingLiveStatusDecision =
  | Readonly<{ state: "pending" | "ready" }>
  | Readonly<{ state: "failed"; safeCode: string }>;

function isFlag(value: number) {
  return value === 0 || value === 1;
}

function flag(value: number) {
  return value === 1;
}

export function parsePrivateNumericRow(
  output: string,
  expectedValueCount: number,
): readonly number[] | null {
  if (!Number.isSafeInteger(expectedValueCount) || expectedValueCount < 1) {
    return null;
  }
  const trimmedOutput = output.trim();
  const numericPattern = /^-?\d+(?:\|-?\d+)*$/u;
  let safeNumbers: string;

  if (numericPattern.test(trimmedOutput)) {
    // Retain the exact legacy raw-row contract for local CLI compatibility.
    safeNumbers = trimmedOutput;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedOutput);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== 1) return null;
    const row: unknown = parsed[0];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return null;
    }
    const keys = Object.keys(row);
    if (keys.length !== 1 || keys[0] !== "safe_numbers") return null;
    const candidate = (row as Record<string, unknown>).safe_numbers;
    if (typeof candidate !== "string" || !numericPattern.test(candidate)) {
      return null;
    }
    safeNumbers = candidate;
  }

  const values = safeNumbers.split("|").map(Number);
  if (
    values.length !== expectedValueCount ||
    values.some((value) => !Number.isSafeInteger(value))
  ) {
    return null;
  }
  return values;
}

export function parseWritingLiveSafeStatus(
  values: readonly number[],
): WritingLiveSafeStatus | null {
  if (values.length !== WRITING_LIVE_STATUS_VALUE_COUNT) return null;
  const [
    submissionCount,
    exactScope,
    evaluationQueued,
    evaluationProcessing,
    evaluationReady,
    evaluationNeedsReview,
    evaluationFailed,
    releaseHeld,
    releaseScheduled,
    releaseReleased,
    jobCount,
    jobQueued,
    jobProcessing,
    jobRetry,
    jobSucceeded,
    jobDead,
    attemptCount,
    hasError,
    retryDue,
    retryScheduled,
    activeLease,
    adjudicationCount,
    adjudicationAccepted,
    adjudicationSystemHold,
    adjudicationReasonOrdinal,
    jobErrorOrdinal,
  ] = values;
  const booleanValues = [
    exactScope,
    evaluationQueued,
    evaluationProcessing,
    evaluationReady,
    evaluationNeedsReview,
    evaluationFailed,
    releaseHeld,
    releaseScheduled,
    releaseReleased,
    jobQueued,
    jobProcessing,
    jobRetry,
    jobSucceeded,
    jobDead,
    hasError,
    retryDue,
    retryScheduled,
    activeLease,
    adjudicationAccepted,
    adjudicationSystemHold,
  ];
  if (
    !Number.isSafeInteger(submissionCount) ||
    submissionCount! < 0 ||
    !Number.isSafeInteger(jobCount) ||
    jobCount! < 0 ||
    !Number.isSafeInteger(attemptCount) ||
    attemptCount! < -1 ||
    attemptCount! > 3 ||
    !Number.isSafeInteger(adjudicationCount) ||
    adjudicationCount! < 0 ||
    !Number.isSafeInteger(adjudicationReasonOrdinal) ||
    adjudicationReasonOrdinal! < 0 ||
    adjudicationReasonOrdinal! >=
      WRITING_ADJUDICATION_REASON_BY_ORDINAL.length ||
    !Number.isSafeInteger(jobErrorOrdinal) ||
    jobErrorOrdinal! < 0 ||
    jobErrorOrdinal! >= WRITING_JOB_ERROR_BY_ORDINAL.length ||
    booleanValues.some((value) => !isFlag(value!))
  ) {
    return null;
  }

  return {
    submissionCount: submissionCount!,
    exactScope: flag(exactScope!),
    evaluationQueued: flag(evaluationQueued!),
    evaluationProcessing: flag(evaluationProcessing!),
    evaluationReady: flag(evaluationReady!),
    evaluationNeedsReview: flag(evaluationNeedsReview!),
    evaluationFailed: flag(evaluationFailed!),
    releaseHeld: flag(releaseHeld!),
    releaseScheduled: flag(releaseScheduled!),
    releaseReleased: flag(releaseReleased!),
    jobCount: jobCount!,
    jobQueued: flag(jobQueued!),
    jobProcessing: flag(jobProcessing!),
    jobRetry: flag(jobRetry!),
    jobSucceeded: flag(jobSucceeded!),
    jobDead: flag(jobDead!),
    attemptCount: attemptCount!,
    hasError: flag(hasError!),
    retryDue: flag(retryDue!),
    retryScheduled: flag(retryScheduled!),
    activeLease: flag(activeLease!),
    adjudicationCount: adjudicationCount!,
    adjudicationAccepted: flag(adjudicationAccepted!),
    adjudicationSystemHold: flag(adjudicationSystemHold!),
    adjudicationReasonOrdinal: adjudicationReasonOrdinal!,
    jobErrorOrdinal: jobErrorOrdinal!,
  };
}

export function classifyWritingLiveSafeStatus(
  status: WritingLiveSafeStatus,
): WritingLiveStatusDecision {
  const evaluationStateCount = [
    status.evaluationQueued,
    status.evaluationProcessing,
    status.evaluationReady,
    status.evaluationNeedsReview,
    status.evaluationFailed,
  ].filter(Boolean).length;
  const releaseStateCount = [
    status.releaseHeld,
    status.releaseScheduled,
    status.releaseReleased,
  ].filter(Boolean).length;
  const jobStateCount = [
    status.jobQueued,
    status.jobProcessing,
    status.jobRetry,
    status.jobSucceeded,
    status.jobDead,
  ].filter(Boolean).length;
  const retryWindowCount = [status.retryDue, status.retryScheduled].filter(
    Boolean,
  ).length;
  const adjudicationDecisionCount = [
    status.adjudicationAccepted,
    status.adjudicationSystemHold,
  ].filter(Boolean).length;
  const adjudicationReason =
    WRITING_ADJUDICATION_REASON_BY_ORDINAL[status.adjudicationReasonOrdinal] ??
    null;
  const jobError = WRITING_JOB_ERROR_BY_ORDINAL[status.jobErrorOrdinal] ?? null;
  const adjudicationAbsent =
    status.adjudicationCount === 0 &&
    adjudicationDecisionCount === 0 &&
    status.adjudicationReasonOrdinal === 0;
  const adjudicationPresent =
    status.adjudicationCount === 1 &&
    adjudicationDecisionCount === 1 &&
    adjudicationReason !== null;

  if (
    status.submissionCount !== 1 ||
    !status.exactScope ||
    status.jobCount !== 1
  ) {
    return {
      state: "failed",
      safeCode: "writing_live_fixture_status_scope_invalid",
    };
  }
  if (
    evaluationStateCount !== 1 ||
    releaseStateCount !== 1 ||
    jobStateCount !== 1 ||
    (status.jobRetry && retryWindowCount !== 1) ||
    (!status.jobRetry && retryWindowCount !== 0) ||
    ((status.jobRetry || status.jobDead) && !status.hasError)
  ) {
    return {
      state: "failed",
      safeCode: "writing_live_fixture_status_contract_invalid",
    };
  }
  if (status.evaluationFailed) {
    return {
      state: "failed",
      safeCode: jobError
        ? `writing_live_fixture_feedback_failed_${jobError}`
        : "writing_live_fixture_feedback_failed_unknown",
    };
  }
  if (status.evaluationNeedsReview) {
    if (adjudicationAbsent) {
      return {
        state: "failed",
        safeCode: "writing_live_fixture_feedback_needs_review_evidence_missing",
      };
    }
    if (
      !adjudicationPresent ||
      !status.adjudicationSystemHold ||
      status.adjudicationAccepted ||
      status.adjudicationReasonOrdinal < FIRST_SYSTEM_HOLD_REASON_ORDINAL
    ) {
      return {
        state: "failed",
        safeCode: "writing_live_fixture_feedback_needs_review_evidence_invalid",
      };
    }
    return {
      state: "failed",
      safeCode: `writing_live_fixture_feedback_needs_review_${adjudicationReason}`,
    };
  }
  if (
    !adjudicationAbsent &&
    (!adjudicationPresent ||
      (status.adjudicationAccepted &&
        status.adjudicationReasonOrdinal >= FIRST_SYSTEM_HOLD_REASON_ORDINAL) ||
      (status.adjudicationSystemHold &&
        status.adjudicationReasonOrdinal < FIRST_SYSTEM_HOLD_REASON_ORDINAL))
  ) {
    return {
      state: "failed",
      safeCode: "writing_live_fixture_status_contract_invalid",
    };
  }
  if (status.jobDead) {
    return {
      state: "failed",
      safeCode: "writing_live_fixture_job_dead",
    };
  }
  if (status.releaseScheduled) {
    return {
      state: "failed",
      safeCode: "writing_live_fixture_feedback_scheduled",
    };
  }
  if (status.releaseHeld && (status.evaluationReady || status.jobSucceeded)) {
    return {
      state: "failed",
      safeCode: "writing_live_fixture_feedback_held",
    };
  }
  if (
    status.jobSucceeded &&
    !(status.evaluationReady && status.releaseReleased)
  ) {
    return {
      state: "failed",
      safeCode: "writing_live_fixture_job_terminal_without_release",
    };
  }
  if (status.evaluationReady && status.releaseReleased && status.jobSucceeded) {
    if (
      !adjudicationPresent ||
      !status.adjudicationAccepted ||
      status.adjudicationSystemHold ||
      status.adjudicationReasonOrdinal >= FIRST_SYSTEM_HOLD_REASON_ORDINAL
    ) {
      return {
        state: "failed",
        safeCode: "writing_live_fixture_terminal_adjudication_invalid",
      };
    }
    return { state: "ready" };
  }
  return { state: "pending" };
}
