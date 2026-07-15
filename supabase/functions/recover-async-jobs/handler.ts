import {
  callWorkerApiRpc,
  type WorkerApiClient,
} from "../_shared/worker-api.ts";
import { serviceFunctionHeaders } from "../_shared/writing-feedback.ts";

const queueNames = [
  "writing_evaluation",
  "worksheet_generation",
  "worksheet_answer_evaluation",
] as const;

const workerFunctions = [
  "process-writing-jobs",
  "process-worksheet-generation-jobs",
  "process-worksheet-answer-jobs",
] as const;

export const RECOVERY_MAX_WAKEUPS_PER_QUEUE = 10;
export const RECOVERY_WAKEUP_TIMEOUT_MS = 5_000;
export const RECOVERY_SCHEDULED_RELEASE_BATCH_SIZE = 100;
export const RECOVERY_AI_RESERVATION_BATCH_SIZE = 100;
export const RECOVERY_PRACTICE_CYCLE_TRANSITION_BATCH_SIZE = 50;
export const RECOVERY_LEVEL_FIT_BATCH_SIZE = 25;
export const RECOVERY_CERTIFIED_BANK_RESCUE_BATCH_SIZE = 25;
export const RECOVERY_MODEL_CACHE_PROMOTION_BATCH_SIZE = 25;
export const RECOVERY_MODEL_CACHE_ASSIGNMENT_BATCH_SIZE = 25;

type RecoveryDependencies = {
  createAdminClient(): WorkerApiClient;
  getRecoverySecret(): string | null | undefined;
  getServiceKey(): string | null | undefined;
  getSupabaseUrl(): string | null | undefined;
  waitUntil(task: Promise<unknown>): void;
  fetchImpl?: typeof fetch;
  wakeupTimeoutMs?: number;
  log?: (event: Record<string, unknown>) => void;
};

function secretEquals(received: string, expected: string | null | undefined) {
  if (!received || !expected) return false;
  const width = Math.max(received.length, expected.length);
  let difference = received.length ^ expected.length;
  for (let index = 0; index < width; index += 1) {
    difference |= (received.charCodeAt(index) || 0) ^
      (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function nonNegativeInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function strictNonNegativeInteger(value: unknown) {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

type RecoveryResultBounds = {
  maxAttempted: number;
  maxDeferred: number;
};

function boundedRecoveryResult(value: unknown, bounds: RecoveryResultBounds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(",") !==
      "attempted,deferred,exhausted,failed,schema_version,succeeded"
  ) {
    return null;
  }
  if (record.schema_version !== 1) return null;
  const attempted = strictNonNegativeInteger(record.attempted);
  const succeeded = strictNonNegativeInteger(record.succeeded);
  const failed = strictNonNegativeInteger(record.failed);
  const deferred = strictNonNegativeInteger(record.deferred);
  const exhausted = strictNonNegativeInteger(record.exhausted);
  if (
    attempted === null ||
    succeeded === null ||
    failed === null ||
    deferred === null ||
    exhausted === null ||
    attempted > bounds.maxAttempted ||
    deferred > bounds.maxDeferred ||
    // Database recovery functions define attempted as work that actually ran.
    // Deferred rows were scanned but not attempted; exhausted is independent
    // global backlog health. Therefore this equality, not a five-field sum, is
    // the exact result invariant.
    attempted !== succeeded + failed
  ) {
    return null;
  }
  return { attempted, succeeded, failed, deferred, exhausted };
}

function recoveryWakeupCounts(value: unknown) {
  const counts = new Map<string, number>();
  if (!Array.isArray(value)) return counts;
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (
      !queueNames.includes(record.queue_name as (typeof queueNames)[number])
    ) {
      continue;
    }
    const pending = Math.max(
      nonNegativeInteger(record.claimable_jobs),
      nonNegativeInteger(record.claimable_messages),
    );
    if (pending > 0) {
      counts.set(
        String(record.queue_name),
        Math.min(RECOVERY_MAX_WAKEUPS_PER_QUEUE, pending),
      );
    }
  }
  return counts;
}

async function runRecovery(deps: RecoveryDependencies, requestId: string) {
  const admin = deps.createAdminClient();
  const serviceKey = deps.getServiceKey();
  const supabaseUrl = deps.getSupabaseUrl()?.replace(/\/+$/, "");
  if (!serviceKey || !supabaseUrl) {
    throw new Error("recovery_not_configured");
  }

  const reconciliations = await Promise.allSettled(
    queueNames.map((queueName) =>
      callWorkerApiRpc(admin, "reconcile_async_jobs", {
        target_queue_name: queueName,
      })
    ),
  );

  let expiredReservationReconciliationFailure = 0;
  let expiredReservationsEstimated = 0;
  try {
    const reconciliation = await callWorkerApiRpc(
      admin,
      "reconcile_expired_ai_spend_reservations",
      { batch_size: RECOVERY_AI_RESERVATION_BATCH_SIZE },
    );
    const estimated = strictNonNegativeInteger(reconciliation.data);
    if (reconciliation.error || estimated === null) {
      expiredReservationReconciliationFailure = 1;
    } else {
      expiredReservationsEstimated = estimated;
    }
  } catch {
    expiredReservationReconciliationFailure = 1;
  }

  // The database Cron remains the primary sub-minute release mechanism. This
  // service-only sweep gives scheduled feedback an independent recovery path
  // when pg_cron is unavailable or a release run is missed. The underlying
  // routine uses row locks plus SKIP LOCKED, so it is safe to race the Cron.
  let scheduledReleaseFailure = 0;
  let scheduledFeedbackReleased = 0;
  try {
    const release = await callWorkerApiRpc(admin, "release_due_feedback", {
      batch_size: RECOVERY_SCHEDULED_RELEASE_BATCH_SIZE,
    });
    const released = strictNonNegativeInteger(release.data);
    if (release.error || released === null) {
      scheduledReleaseFailure = 1;
    } else {
      scheduledFeedbackReleased = released;
    }
  } catch {
    scheduledReleaseFailure = 1;
  }

  // Assignment status transitions are captured durably by the database and
  // processed outside the learner-facing mutation. Drain those transitions
  // before reconciling level-fit locks so the latter observes current cycle
  // state. The database routine isolates individual jobs and reports only
  // aggregate counters; raw failure details remain private.
  let practiceCycleTransitionFailure = 0;
  let practiceCycleTransitionAttempted = 0;
  let practiceCycleTransitionSucceeded = 0;
  let practiceCycleTransitionFailed = 0;
  let practiceCycleTransitionDeferred = 0;
  let practiceCycleTransitionExhausted = 0;
  try {
    const processing = await callWorkerApiRpc(
      admin,
      "process_practice_cycle_transition_jobs",
      { max_jobs: RECOVERY_PRACTICE_CYCLE_TRANSITION_BATCH_SIZE },
    );
    const result = boundedRecoveryResult(processing.data, {
      maxAttempted: RECOVERY_PRACTICE_CYCLE_TRANSITION_BATCH_SIZE,
      maxDeferred: RECOVERY_PRACTICE_CYCLE_TRANSITION_BATCH_SIZE * 4,
    });
    if (processing.error || !result) {
      practiceCycleTransitionFailure = 1;
    } else {
      practiceCycleTransitionAttempted = result.attempted;
      practiceCycleTransitionSucceeded = result.succeeded;
      practiceCycleTransitionFailed = result.failed;
      practiceCycleTransitionDeferred = result.deferred;
      practiceCycleTransitionExhausted = result.exhausted;
      if (result.exhausted > 0) practiceCycleTransitionFailure = 1;
    }
  } catch {
    practiceCycleTransitionFailure = 1;
  }

  // Qualified bank releases never fan out learner reconciliation inside the
  // publisher transaction. This independent bounded sweep promotes eligible
  // locked cycles with per-cycle failure isolation and database backoff.
  let levelFitReconciliationFailure = 0;
  let levelFitAttempted = 0;
  let levelFitSucceeded = 0;
  let levelFitFailed = 0;
  let levelFitDeferred = 0;
  let levelFitExhausted = 0;
  try {
    const reconciliation = await callWorkerApiRpc(
      admin,
      "reconcile_eligible_level_fit_cycles",
      { max_cycles: RECOVERY_LEVEL_FIT_BATCH_SIZE },
    );
    const result = boundedRecoveryResult(reconciliation.data, {
      maxAttempted: RECOVERY_LEVEL_FIT_BATCH_SIZE,
      maxDeferred: RECOVERY_LEVEL_FIT_BATCH_SIZE * 4,
    });
    if (reconciliation.error || !result) {
      levelFitReconciliationFailure = 1;
    } else {
      levelFitAttempted = result.attempted;
      levelFitSucceeded = result.succeeded;
      levelFitFailed = result.failed;
      levelFitDeferred = result.deferred;
      levelFitExhausted = result.exhausted;
      if (result.exhausted > 0) levelFitReconciliationFailure = 1;
    }
  } catch {
    levelFitReconciliationFailure = 1;
  }

  // A qualified worksheet can be published after a generation job has already
  // failed or exhausted its provider attempts. Re-check untouched assignments
  // here so the next bounded recovery run can attach that material without a
  // learner retry or teacher intervention.
  let certifiedBankRescueFailure = 0;
  let certifiedBankRescueAttempted = 0;
  let certifiedBankRescueSucceeded = 0;
  let certifiedBankRescueFailed = 0;
  let certifiedBankRescueDeferred = 0;
  let certifiedBankRescueExhausted = 0;
  try {
    const recovery = await callWorkerApiRpc(
      admin,
      "recover_current_certified_worksheet_assignments",
      { max_assignments: RECOVERY_CERTIFIED_BANK_RESCUE_BATCH_SIZE },
    );
    const result = boundedRecoveryResult(recovery.data, {
      maxAttempted: RECOVERY_CERTIFIED_BANK_RESCUE_BATCH_SIZE,
      maxDeferred: RECOVERY_CERTIFIED_BANK_RESCUE_BATCH_SIZE * 4,
    });
    if (recovery.error || !result) {
      certifiedBankRescueFailure = 1;
    } else {
      certifiedBankRescueAttempted = result.attempted;
      certifiedBankRescueSucceeded = result.succeeded;
      certifiedBankRescueFailed = result.failed;
      certifiedBankRescueDeferred = result.deferred;
      certifiedBankRescueExhausted = result.exhausted;
      // The database isolates individual assignments so one race does not stop
      // the sweep, but any caught exception must remain operationally visible
      // and must not produce a healthy recovery heartbeat.
      certifiedBankRescueFailure = result.failed > 0 || result.exhausted > 0
        ? 1
        : 0;
    }
  } catch {
    certifiedBankRescueFailure = 1;
  }

  // Human-certified material remains the first recovery source. After that
  // bounded rescue has run, promote independently model-validated worksheets
  // that have completed their hold period, then attach the current promoted
  // cache to otherwise stranded assignments. Both routines return aggregate,
  // content-free counters and isolate individual rows in the database.
  let modelCachePromotionFailure = 0;
  let modelCachePromotionAttempted = 0;
  let modelCachePromotionSucceeded = 0;
  let modelCachePromotionFailed = 0;
  let modelCachePromotionDeferred = 0;
  let modelCachePromotionExhausted = 0;
  try {
    const promotion = await callWorkerApiRpc(
      admin,
      "promote_pending_model_validated_worksheets",
      { max_worksheets: RECOVERY_MODEL_CACHE_PROMOTION_BATCH_SIZE },
    );
    const result = boundedRecoveryResult(promotion.data, {
      maxAttempted: RECOVERY_MODEL_CACHE_PROMOTION_BATCH_SIZE,
      maxDeferred: RECOVERY_MODEL_CACHE_PROMOTION_BATCH_SIZE * 4,
    });
    if (promotion.error || !result) {
      modelCachePromotionFailure = 1;
    } else {
      modelCachePromotionAttempted = result.attempted;
      modelCachePromotionSucceeded = result.succeeded;
      modelCachePromotionFailed = result.failed;
      modelCachePromotionDeferred = result.deferred;
      modelCachePromotionExhausted = result.exhausted;
      modelCachePromotionFailure = result.failed > 0 || result.exhausted > 0
        ? 1
        : 0;
    }
  } catch {
    modelCachePromotionFailure = 1;
  }

  let modelCacheAssignmentRecoveryFailure = 0;
  let modelCacheAssignmentRecoveryAttempted = 0;
  let modelCacheAssignmentRecoverySucceeded = 0;
  let modelCacheAssignmentRecoveryFailed = 0;
  let modelCacheAssignmentRecoveryDeferred = 0;
  let modelCacheAssignmentRecoveryExhausted = 0;
  try {
    const recovery = await callWorkerApiRpc(
      admin,
      "recover_current_model_cache_assignments",
      { max_assignments: RECOVERY_MODEL_CACHE_ASSIGNMENT_BATCH_SIZE },
    );
    const result = boundedRecoveryResult(recovery.data, {
      maxAttempted: RECOVERY_MODEL_CACHE_ASSIGNMENT_BATCH_SIZE,
      maxDeferred: RECOVERY_MODEL_CACHE_ASSIGNMENT_BATCH_SIZE * 4,
    });
    if (recovery.error || !result) {
      modelCacheAssignmentRecoveryFailure = 1;
    } else {
      modelCacheAssignmentRecoveryAttempted = result.attempted;
      modelCacheAssignmentRecoverySucceeded = result.succeeded;
      modelCacheAssignmentRecoveryFailed = result.failed;
      modelCacheAssignmentRecoveryDeferred = result.deferred;
      modelCacheAssignmentRecoveryExhausted = result.exhausted;
      modelCacheAssignmentRecoveryFailure =
        result.failed > 0 || result.exhausted > 0 ? 1 : 0;
    }
  } catch {
    modelCacheAssignmentRecoveryFailure = 1;
  }

  let metricsFailure = 0;
  let wakeupCounts = new Map<string, number>();
  try {
    const metrics = await callWorkerApiRpc(
      admin,
      "get_async_claimable_queue_metrics",
      {},
    );
    if (metrics.error) {
      metricsFailure = 1;
    } else {
      wakeupCounts = recoveryWakeupCounts(metrics.data);
    }
  } catch {
    metricsFailure = 1;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const wakeupPlan = workerFunctions.flatMap((functionName, index) =>
    Array.from(
      { length: wakeupCounts.get(queueNames[index]) ?? 0 },
      () => functionName,
    )
  );
  const wakeups = await Promise.allSettled(
    wakeupPlan.map(async (functionName) => {
      const controller = new AbortController();
      const configuredTimeout = deps.wakeupTimeoutMs ??
        RECOVERY_WAKEUP_TIMEOUT_MS;
      const timeoutMs = Number.isFinite(configuredTimeout)
        ? Math.max(1, Math.min(30_000, Math.trunc(configuredTimeout)))
        : RECOVERY_WAKEUP_TIMEOUT_MS;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error("worker_wakeup_timeout"));
        }, timeoutMs);
      });
      try {
        const response = await Promise.race([
          fetchImpl(`${supabaseUrl}/functions/v1/${functionName}`, {
            method: "POST",
            headers: serviceFunctionHeaders(serviceKey),
            body: "{}",
            signal: controller.signal,
          }),
          timeout,
        ]);
        if (!response.ok) throw new Error("worker_wakeup_failed");
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    }),
  );

  const reconciliationFailures = reconciliations.filter(
    (result) =>
      result.status === "rejected" ||
      (result.status === "fulfilled" && result.value.error),
  ).length;
  const wakeupFailures = wakeups.filter(
    (result) => result.status === "rejected",
  ).length;
  if (
    reconciliationFailures === 0 &&
    expiredReservationReconciliationFailure === 0 &&
    metricsFailure === 0 &&
    wakeupFailures === 0 &&
    scheduledReleaseFailure === 0 &&
    practiceCycleTransitionFailure === 0 &&
    levelFitReconciliationFailure === 0 &&
    certifiedBankRescueFailure === 0 &&
    modelCachePromotionFailure === 0 &&
    modelCacheAssignmentRecoveryFailure === 0
  ) {
    const heartbeat = await callWorkerApiRpc(
      admin,
      "record_recovery_heartbeat",
      {
        target_request_id: requestId,
      },
    );
    if (heartbeat.error) throw new Error("recovery_heartbeat_failed");
  }

  deps.log?.({
    request_id: requestId,
    stage: "recovery",
    reconciliation_failures: reconciliationFailures,
    expired_reservation_reconciliation_failures:
      expiredReservationReconciliationFailure,
    expired_reservations_estimated: expiredReservationsEstimated,
    scheduled_release_failures: scheduledReleaseFailure,
    scheduled_feedback_released: scheduledFeedbackReleased,
    practice_cycle_transition_failures: practiceCycleTransitionFailure,
    practice_cycle_transition_attempted: practiceCycleTransitionAttempted,
    practice_cycle_transition_succeeded: practiceCycleTransitionSucceeded,
    practice_cycle_transition_failed: practiceCycleTransitionFailed,
    practice_cycle_transition_deferred: practiceCycleTransitionDeferred,
    practice_cycle_transition_exhausted: practiceCycleTransitionExhausted,
    level_fit_reconciliation_failures: levelFitReconciliationFailure,
    level_fit_attempted: levelFitAttempted,
    level_fit_succeeded: levelFitSucceeded,
    level_fit_failed: levelFitFailed,
    level_fit_deferred: levelFitDeferred,
    level_fit_exhausted: levelFitExhausted,
    certified_bank_rescue_failures: certifiedBankRescueFailure,
    certified_bank_rescue_attempted: certifiedBankRescueAttempted,
    certified_bank_rescue_succeeded: certifiedBankRescueSucceeded,
    certified_bank_rescue_failed: certifiedBankRescueFailed,
    certified_bank_rescue_deferred: certifiedBankRescueDeferred,
    certified_bank_rescue_exhausted: certifiedBankRescueExhausted,
    model_cache_promotion_failures: modelCachePromotionFailure,
    model_cache_promotion_attempted: modelCachePromotionAttempted,
    model_cache_promotion_succeeded: modelCachePromotionSucceeded,
    model_cache_promotion_failed: modelCachePromotionFailed,
    model_cache_promotion_deferred: modelCachePromotionDeferred,
    model_cache_promotion_exhausted: modelCachePromotionExhausted,
    model_cache_assignment_recovery_failures:
      modelCacheAssignmentRecoveryFailure,
    model_cache_assignment_recovery_attempted:
      modelCacheAssignmentRecoveryAttempted,
    model_cache_assignment_recovery_succeeded:
      modelCacheAssignmentRecoverySucceeded,
    model_cache_assignment_recovery_failed: modelCacheAssignmentRecoveryFailed,
    model_cache_assignment_recovery_deferred:
      modelCacheAssignmentRecoveryDeferred,
    model_cache_assignment_recovery_exhausted:
      modelCacheAssignmentRecoveryExhausted,
    metrics_failures: metricsFailure,
    wakeups_requested: wakeupPlan.length,
    wakeup_failures: wakeupFailures,
  });
}

export function createAsyncRecoveryHandler(deps: RecoveryDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    const suppliedSecret = request.headers.get("x-process-recovery-secret") ??
      "";
    if (!secretEquals(suppliedSecret, deps.getRecoverySecret())) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }

    const requestId = crypto.randomUUID();
    let task: Promise<unknown>;
    try {
      task = runRecovery(deps, requestId).catch((error) => {
        deps.log?.({
          request_id: requestId,
          stage: "recovery",
          status: "failed",
          safe_error_code: error instanceof Error
            ? error.message.replace(/[^a-z0-9_]+/gi, "_").slice(0, 80)
            : "recovery_failed",
        });
      });
      deps.waitUntil(task);
    } catch {
      return Response.json(
        { error: "Recovery worker is unavailable." },
        {
          status: 503,
        },
      );
    }
    return Response.json(
      { status: "accepted", request_id: requestId },
      {
        status: 202,
      },
    );
  };
}
