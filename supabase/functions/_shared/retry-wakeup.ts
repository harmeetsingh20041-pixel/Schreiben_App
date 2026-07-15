import { singleWorkerRpcRow } from "./worker-api.ts";

// The database is the source of truth for the three ordinary attempts and the
// two exact worksheet-stage continuations. These guards only prevent an Edge
// worker from creating an unbounded self-invocation chain if a malformed
// transition response ever reaches the runtime.
const DATABASE_MAX_ATTEMPTS = 3;
const WORKSHEET_CONTINUATION_MAX_TRANSITION_ATTEMPT = 4;
const RETRY_WAKEUP_GRACE_MS = 250;
const MAX_RETRY_WAKEUP_DELAY_MS = 30_000;
const MAX_PROVIDER_OUTAGE_FIRST_WAKEUP_DELAY_MS = 90_000;
const RETRY_WAKEUP_FETCH_TIMEOUT_MS = 10_000;

export type RetryWorkerFunctionName =
  | "process-writing-jobs"
  | "process-worksheet-generation-jobs"
  | "process-worksheet-answer-jobs";

export type RetryWorkerAuthHeader =
  | "x-process-writing-secret"
  | "x-process-worksheet-secret"
  | "x-process-worksheet-answer-secret";

export type RetryWakeupSchedule = {
  jobId: string;
  attemptCount: number;
  nextAttemptAt: string;
  wakeupKind?: "stage_continuation" | "provider_outage_first_retry";
  outageRetryCount?: number;
};

export type RetryWakeupOutcome = "invoked" | "skipped" | "failed";
export type RetryWakeup = (
  schedule: RetryWakeupSchedule,
) => Promise<RetryWakeupOutcome>;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type RetryWakeupConfig = {
  functionName: RetryWorkerFunctionName;
  authHeaderName: RetryWorkerAuthHeader;
  getSupabaseUrl: () => string | null | undefined;
  getAuthSecret: () => string | null | undefined;
  fetch?: FetchLike;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
};

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Reads the authoritative result of api.fail_async_job. A retry wakeup is
 * eligible only when the database confirms the same job is in retry, has not
 * reached its final attempt, and supplied a valid availability timestamp.
 */
export function retryScheduleFromFailureTransition(
  value: unknown,
  expectedJobId: string,
): RetryWakeupSchedule | null {
  const row = singleWorkerRpcRow(value);
  if (!row || row.job_id !== expectedJobId || row.status !== "retry") {
    return null;
  }

  const attemptCount = safeInteger(row.attempt_count);
  const nextAttemptAt = typeof row.next_attempt_at === "string"
    ? row.next_attempt_at
    : "";
  if (
    attemptCount === null || attemptCount < 1 ||
    attemptCount >= DATABASE_MAX_ATTEMPTS ||
    !nextAttemptAt || !Number.isFinite(Date.parse(nextAttemptAt))
  ) {
    return null;
  }

  return { jobId: expectedJobId, attemptCount, nextAttemptAt };
}

/**
 * Reads the authoritative result of api.defer_async_job_for_provider_outage.
 * Only the first writing outage retry is eligible for an Edge self-wakeup:
 * the database schedules that transition at roughly 60 seconds, while later
 * 5/15/30 minute retries remain solely under durable external recovery.
 */
export function retryScheduleFromProviderOutageTransition(
  value: unknown,
  expectedJobId: string,
): RetryWakeupSchedule | null {
  const row = singleWorkerRpcRow(value);
  if (!row || row.job_id !== expectedJobId || row.status !== "retry") {
    return null;
  }

  const attemptCount = safeInteger(row.attempt_count);
  const outageRetryCount = safeInteger(row.outage_retry_count);
  const nextAttemptAt = typeof row.next_attempt_at === "string"
    ? row.next_attempt_at
    : "";
  if (
    attemptCount !== 0 || outageRetryCount !== 1 ||
    !nextAttemptAt || !Number.isFinite(Date.parse(nextAttemptAt))
  ) {
    return null;
  }

  return {
    jobId: expectedJobId,
    attemptCount,
    nextAttemptAt,
    wakeupKind: "provider_outage_first_retry",
    outageRetryCount,
  };
}

/**
 * A persisted worksheet fallback/repair transition is a new provider stage,
 * not an ordinary failure retry. Its exact queue message is already available
 * and should be kicked immediately, including when ordinary attempt three has
 * been consumed. The database still binds the exception to the exact message
 * and caps the full job at five claims.
 */
export function retryScheduleFromWorksheetStageContinuation(
  value: unknown,
  expectedJobId: string,
  expectedStage: "primary_fallback_generation" | "repair_generation",
): RetryWakeupSchedule | null {
  const row = singleWorkerRpcRow(value);
  if (
    !row || row.job_id !== expectedJobId || row.status !== "retry" ||
    row.stage !== expectedStage || typeof row.replayed !== "boolean"
  ) {
    return null;
  }

  const attemptCount = safeInteger(row.attempt_count);
  const nextAttemptAt = typeof row.next_attempt_at === "string"
    ? row.next_attempt_at
    : "";
  const stageMaximum = expectedStage === "repair_generation"
    ? WORKSHEET_CONTINUATION_MAX_TRANSITION_ATTEMPT
    : DATABASE_MAX_ATTEMPTS;
  if (
    attemptCount === null || attemptCount < 1 || attemptCount > stageMaximum ||
    !nextAttemptAt || !Number.isFinite(Date.parse(nextAttemptAt))
  ) {
    return null;
  }

  return {
    jobId: expectedJobId,
    attemptCount,
    nextAttemptAt,
    wakeupKind: "stage_continuation",
  };
}

/**
 * The durable database transition is authoritative even when a retry is too
 * far in the future for an Edge waitUntil timer. Long provider-outage retries
 * rely on PGMQ visibility plus the external recovery consumer instead.
 */
export function isDurableRetryTransition(
  value: unknown,
  expectedJobId: string,
) {
  const row = singleWorkerRpcRow(value);
  return Boolean(
    row && row.job_id === expectedJobId && row.status === "retry" &&
      typeof row.next_attempt_at === "string" &&
      Number.isFinite(Date.parse(row.next_attempt_at)),
  );
}

export function retryWakeupDelayMs(
  schedule: RetryWakeupSchedule,
  nowMs: number,
): number | null {
  if (schedule.wakeupKind === "provider_outage_first_retry") {
    if (schedule.attemptCount !== 0 || schedule.outageRetryCount !== 1) {
      return null;
    }
    const timestampDelayMs = Date.parse(schedule.nextAttemptAt) - nowMs;
    if (!Number.isFinite(timestampDelayMs)) return null;
    const delayMs = Math.max(timestampDelayMs, 0) + RETRY_WAKEUP_GRACE_MS;
    return delayMs <= MAX_PROVIDER_OUTAGE_FIRST_WAKEUP_DELAY_MS
      ? delayMs
      : null;
  }

  if (schedule.wakeupKind === "stage_continuation") {
    if (
      !Number.isSafeInteger(schedule.attemptCount) ||
      schedule.attemptCount < 1 ||
      schedule.attemptCount > WORKSHEET_CONTINUATION_MAX_TRANSITION_ATTEMPT
    ) {
      return null;
    }
    const timestampDelayMs = Date.parse(schedule.nextAttemptAt) - nowMs;
    if (!Number.isFinite(timestampDelayMs)) return null;
    const delayMs = Math.max(timestampDelayMs, 0) + RETRY_WAKEUP_GRACE_MS;
    return delayMs <= MAX_RETRY_WAKEUP_DELAY_MS ? delayMs : null;
  }

  if (
    !Number.isSafeInteger(schedule.attemptCount) ||
    schedule.attemptCount < 1 ||
    schedule.attemptCount >= DATABASE_MAX_ATTEMPTS
  ) {
    return null;
  }

  // Mirrors the database's current 5s, then 10s backoff. Measuring from the
  // completed failure transition is deliberately conservative: the queue
  // cannot be claimed before available_at even when clocks differ slightly.
  const databaseBackoffMs = 5_000 * (2 ** (schedule.attemptCount - 1));
  const timestampDelayMs = Date.parse(schedule.nextAttemptAt) - nowMs;
  if (!Number.isFinite(timestampDelayMs)) return null;

  const delayMs = Math.max(databaseBackoffMs, timestampDelayMs, 0) +
    RETRY_WAKEUP_GRACE_MS;
  return delayMs <= MAX_RETRY_WAKEUP_DELAY_MS ? delayMs : null;
}

function retryWorkerUrl(
  supabaseUrl: string,
  functionName: RetryWorkerFunctionName,
): string | null {
  try {
    const base = new URL(supabaseUrl);
    if (base.protocol !== "https:") return null;
    base.pathname = `/functions/v1/${functionName}`;
    base.search = "";
    base.hash = "";
    return base.toString();
  } catch {
    return null;
  }
}

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/**
 * Creates a best-effort, bounded retry wakeup. Failure never mutates the job:
 * the delayed PGMQ message remains durable for the recovery consumer.
 */
export function createRetryWakeup(config: RetryWakeupConfig): RetryWakeup {
  const fetchRequest = config.fetch ?? fetch;
  const sleep = config.sleep ?? defaultSleep;
  const now = config.now ?? Date.now;

  return async (schedule) => {
    // Provider-outage self-wakeup is intentionally writing-only. Worksheet
    // workers retain their existing durable external recovery policy.
    if (
      schedule.wakeupKind === "provider_outage_first_retry" &&
      config.functionName !== "process-writing-jobs"
    ) {
      return "skipped";
    }

    const endpoint = retryWorkerUrl(
      config.getSupabaseUrl()?.trim() ?? "",
      config.functionName,
    );
    const secret = config.getAuthSecret()?.trim() ?? "";
    const delayMs = retryWakeupDelayMs(schedule, now());
    if (!endpoint || !secret || delayMs === null) return "skipped";

    await sleep(delayMs);

    try {
      const response = await fetchRequest(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.authHeaderName]: secret,
        },
        body: "{}",
        // Do not forward an internal worker secret across a redirect.
        redirect: "error",
        signal: AbortSignal.timeout(RETRY_WAKEUP_FETCH_TIMEOUT_MS),
      });
      return response.ok ? "invoked" : "failed";
    } catch {
      return "failed";
    }
  };
}
