import type {
  WritingBeforeProviderCallHook,
  WritingFeedbackCompletionPayload,
  WritingProviderNotCalledRecorder,
  WritingProviderUsageRecorder,
} from "../_shared/writing-feedback.ts";
import { isWritingSpendAccountingSafeCode } from "../_shared/writing-feedback.ts";
import {
  callWorkerApiRpc,
  type WorkerApiClient,
} from "../_shared/worker-api.ts";
import {
  isDurableRetryTransition,
  retryScheduleFromFailureTransition,
  retryScheduleFromProviderOutageTransition,
  type RetryWakeup,
  type RetryWakeupSchedule,
} from "../_shared/retry-wakeup.ts";
import { dualProviderOutageReason } from "../_shared/provider-outage-recovery.ts";

export const WRITING_QUEUE_NAME = "writing_evaluation";
export const WRITING_JOB_BATCH_SIZE = 1;
export const WRITING_VISIBILITY_TIMEOUT_SECONDS = 300;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integerPattern = /^\d+$/;

export type ClaimedWritingJob = {
  job_id: string;
  queue_message_id: number | string;
  entity_id: string;
  entity_version: number;
  attempt_number: number;
  lease_expires_at: string;
};

type RpcError = {
  code?: string;
  message?: string;
};

export type WritingProcessorAdminClient = WorkerApiClient;

export type WritingProcessorEvent = {
  request_id: string;
  stage:
    | "auth"
    | "claim"
    | "evaluate"
    | "complete"
    | "fail"
    | "wakeup"
    | "response";
  status: "started" | "succeeded" | "failed" | "skipped";
  safe_error_code?: string;
  job_id?: string;
  submission_id?: string;
  attempt_number?: number;
  duration_ms?: number;
};

export type WritingProcessorDependencies = {
  createAdminClient: () => WritingProcessorAdminClient;
  createProviderLifecycleHooks: (args: {
    admin: WritingProcessorAdminClient;
    jobId: string;
    entityVersion: number;
    attemptNumber: number;
  }) => {
    providerCallKeyPrefix: string;
    onBeforeProviderCall: WritingBeforeProviderCallHook;
    onProviderUsage: WritingProviderUsageRecorder;
    onProviderNotCalled: WritingProviderNotCalledRecorder;
  };
  evaluateSubmission: (args: {
    admin: WritingProcessorAdminClient;
    submissionId: string;
    requestId: string;
    providerCallKeyPrefix?: string;
    onBeforeProviderCall?: WritingBeforeProviderCallHook;
    onProviderUsage?: WritingProviderUsageRecorder;
    onProviderNotCalled?: WritingProviderNotCalledRecorder;
  }) => Promise<WritingFeedbackCompletionPayload>;
  waitUntil: (promise: Promise<unknown>) => void;
  wakeRetry?: RetryWakeup;
  getRecoverySecret?: () => string | null | undefined;
  getServiceAuthSecret?: () => string | null | undefined;
  createRequestId?: () => string;
  createWorkerId?: () => string;
  log?: (event: WritingProcessorEvent) => void;
};

type WritingKickAuthorization = "authorized" | "unauthorized";

export type ProcessWritingJobResult = {
  claimed: boolean;
  outcome:
    | "no_message"
    | "claim_failed"
    | "completed"
    | "retry_scheduled"
    | "failed"
    | "invalid_claim";
  job_id?: string;
  retry_wakeup?: RetryWakeupSchedule;
};

export class WritingJobProcessingError extends Error {
  readonly safeCode: string;
  readonly retryable: boolean;
  readonly providerOutageRecoveryEligible: boolean;

  constructor(
    safeCode: string,
    retryable: boolean,
    providerOutageRecoveryEligible = false,
  ) {
    super("Writing job processing failed.");
    this.name = "WritingJobProcessingError";
    this.safeCode = normalizeSafeErrorCode(safeCode);
    this.retryable = retryable;
    this.providerOutageRecoveryEligible = providerOutageRecoveryEligible;
  }
}

function normalizeSafeErrorCode(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.slice(0, 80) || "writing_job_failed";
}

function completionFailure(error: RpcError) {
  const permanentCodes = new Set([
    "02000",
    "22023",
    "23503",
    "23505",
    "23514",
    "42501",
    "55000",
  ]);
  const permanent = permanentCodes.has(error.code ?? "");
  return new WritingJobProcessingError(
    permanent ? "completion_rejected" : "completion_failed",
    !permanent,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && integerPattern.test(value)
    ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function asQueueMessageId(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && integerPattern.test(value)) return value;
  return null;
}

function normalizeClaimedJob(value: unknown): ClaimedWritingJob | null {
  const record = asRecord(value);
  if (!record) return null;

  const jobId = typeof record.job_id === "string" ? record.job_id : "";
  const entityId = typeof record.entity_id === "string" ? record.entity_id : "";
  const entityVersion = asPositiveInteger(record.entity_version);
  const attemptNumber = asPositiveInteger(record.attempt_number);
  const queueMessageId = asQueueMessageId(record.queue_message_id);
  const leaseExpiresAt = typeof record.lease_expires_at === "string"
    ? record.lease_expires_at
    : "";

  if (
    !uuidPattern.test(jobId) ||
    !uuidPattern.test(entityId) ||
    entityVersion === null ||
    entityVersion < 1 ||
    attemptNumber === null ||
    attemptNumber < 1 ||
    queueMessageId === null ||
    !leaseExpiresAt
  ) {
    return null;
  }

  return {
    job_id: jobId,
    queue_message_id: queueMessageId,
    entity_id: entityId,
    entity_version: entityVersion,
    attempt_number: attemptNumber,
    lease_expires_at: leaseExpiresAt,
  };
}

function classifyProcessingError(error: unknown): WritingJobProcessingError {
  if (error instanceof WritingJobProcessingError) return error;

  const record = asRecord(error);
  if (
    typeof record?.safeCode === "string" &&
    typeof record.retryable === "boolean"
  ) {
    const safeCode = record.safeCode === "writing_spend_accounting_failed" &&
        isWritingSpendAccountingSafeCode(record.spendAccountingSafeCode)
      ? record.spendAccountingSafeCode
      : record.safeCode;
    return new WritingJobProcessingError(
      safeCode,
      record.retryable,
      record.providerOutageRecoveryEligible === true,
    );
  }
  const status = typeof record?.status === "number" ? record.status : null;
  if (
    status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  ) {
    return new WritingJobProcessingError("invalid_submission", false);
  }

  return new WritingJobProcessingError("evaluation_unavailable", true);
}

function defaultLog(event: WritingProcessorEvent) {
  console.log(JSON.stringify(event));
}

async function callRpc(
  admin: WritingProcessorAdminClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: RpcError | null }> {
  const response = (await callWorkerApiRpc(admin, name, args)) as unknown as {
    data: unknown;
    error: RpcError | null;
  };
  return response;
}

export async function processOneWritingJob(args: {
  admin: WritingProcessorAdminClient;
  workerId: string;
  requestId: string;
  evaluateSubmission: WritingProcessorDependencies["evaluateSubmission"];
  createProviderLifecycleHooks:
    WritingProcessorDependencies["createProviderLifecycleHooks"];
  log?: WritingProcessorDependencies["log"];
}): Promise<ProcessWritingJobResult> {
  const startedAt = Date.now();
  const log = args.log ?? defaultLog;
  let claimResponse: { data: unknown; error: RpcError | null };

  try {
    claimResponse = await callRpc(args.admin, "claim_async_jobs", {
      target_queue_name: WRITING_QUEUE_NAME,
      worker_id: args.workerId,
      batch_size: WRITING_JOB_BATCH_SIZE,
      visibility_timeout_seconds: WRITING_VISIBILITY_TIMEOUT_SECONDS,
    });
  } catch {
    log({
      request_id: args.requestId,
      stage: "claim",
      status: "failed",
      safe_error_code: "claim_request_failed",
      duration_ms: Date.now() - startedAt,
    });
    return { claimed: false, outcome: "claim_failed" };
  }

  if (claimResponse.error) {
    log({
      request_id: args.requestId,
      stage: "claim",
      status: "failed",
      safe_error_code: "claim_failed",
      duration_ms: Date.now() - startedAt,
    });
    return { claimed: false, outcome: "claim_failed" };
  }

  const claimRows = Array.isArray(claimResponse.data)
    ? claimResponse.data
    : claimResponse.data
    ? [claimResponse.data]
    : [];
  if (claimRows.length === 0) {
    log({
      request_id: args.requestId,
      stage: "claim",
      status: "skipped",
      duration_ms: Date.now() - startedAt,
    });
    return { claimed: false, outcome: "no_message" };
  }

  const job = normalizeClaimedJob(claimRows[0]);
  if (!job) {
    log({
      request_id: args.requestId,
      stage: "claim",
      status: "failed",
      safe_error_code: "invalid_claim_payload",
      duration_ms: Date.now() - startedAt,
    });
    return { claimed: true, outcome: "invalid_claim" };
  }

  log({
    request_id: args.requestId,
    stage: "claim",
    status: "succeeded",
    job_id: job.job_id,
    submission_id: job.entity_id,
    attempt_number: job.attempt_number,
  });

  try {
    const providerLifecycle = args.createProviderLifecycleHooks({
      admin: args.admin,
      jobId: job.job_id,
      entityVersion: job.entity_version,
      attemptNumber: job.attempt_number,
    });
    const feedback = await args.evaluateSubmission({
      admin: args.admin,
      submissionId: job.entity_id,
      requestId: args.requestId,
      ...providerLifecycle,
      providerCallKeyPrefix:
        `${providerLifecycle.providerCallKeyPrefix}:message_${job.queue_message_id}`,
    });

    log({
      request_id: args.requestId,
      stage: "evaluate",
      status: "succeeded",
      job_id: job.job_id,
      submission_id: job.entity_id,
      attempt_number: job.attempt_number,
    });

    let completionResponse: { data: unknown; error: RpcError | null };
    try {
      completionResponse = await callRpc(
        args.admin,
        "complete_writing_evaluation",
        {
          target_job_id: job.job_id,
          target_queue_message_id: job.queue_message_id,
          worker_id: args.workerId,
          feedback,
        },
      );
    } catch {
      throw new WritingJobProcessingError("completion_request_failed", true);
    }

    if (completionResponse.error) {
      throw completionFailure(completionResponse.error);
    }

    log({
      request_id: args.requestId,
      stage: "complete",
      status: "succeeded",
      job_id: job.job_id,
      submission_id: job.entity_id,
      attempt_number: job.attempt_number,
      duration_ms: Date.now() - startedAt,
    });
    return { claimed: true, outcome: "completed", job_id: job.job_id };
  } catch (error) {
    const classified = classifyProcessingError(error);
    const outageReason = dualProviderOutageReason(classified);
    let failRpcFailed = false;
    let durableRetry = false;
    let retryWakeup: RetryWakeupSchedule | null = null;

    try {
      const failResponse = outageReason
        ? await callRpc(args.admin, "defer_async_job_for_provider_outage", {
          target_job_id: job.job_id,
          target_queue_message_id: job.queue_message_id,
          worker_id: args.workerId,
          outage_reason: outageReason,
        })
        : await callRpc(args.admin, "fail_async_job", {
          target_job_id: job.job_id,
          target_queue_message_id: job.queue_message_id,
          worker_id: args.workerId,
          error_code: classified.safeCode,
          retryable: classified.retryable,
        });
      failRpcFailed = Boolean(failResponse.error);
      durableRetry = !failRpcFailed &&
        isDurableRetryTransition(failResponse.data, job.job_id);
      if (!failRpcFailed && classified.retryable) {
        retryWakeup = outageReason
          ? retryScheduleFromProviderOutageTransition(
            failResponse.data,
            job.job_id,
          )
          : retryScheduleFromFailureTransition(
            failResponse.data,
            job.job_id,
          );
      }
    } catch {
      failRpcFailed = true;
    }

    log({
      request_id: args.requestId,
      stage: "fail",
      status: failRpcFailed ? "failed" : "succeeded",
      safe_error_code: failRpcFailed
        ? "fail_transition_failed"
        : (outageReason ?? classified.safeCode),
      job_id: job.job_id,
      submission_id: job.entity_id,
      attempt_number: job.attempt_number,
      duration_ms: Date.now() - startedAt,
    });

    return {
      claimed: true,
      outcome: durableRetry ? "retry_scheduled" : "failed",
      job_id: job.job_id,
      ...(retryWakeup ? { retry_wakeup: retryWakeup } : {}),
    };
  }
}

function safeSecretEquals(
  received: string,
  expected: string | null | undefined,
) {
  if (!received || !expected) return false;
  const maxLength = Math.max(received.length, expected.length);
  let difference = received.length ^ expected.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (received.charCodeAt(index) || 0) ^
      (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isAuthorizedKick(
  req: Request,
  deps: WritingProcessorDependencies,
): WritingKickAuthorization {
  const authorization = req.headers.get("Authorization") ?? "";
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  const apiKey = (req.headers.get("apikey") ?? "").trim();
  const recoverySecret = (
    req.headers.get("x-process-writing-secret") ??
      req.headers.get("x-process-feedback-secret") ??
      ""
  ).trim();
  const expectedRecoverySecret = deps.getRecoverySecret?.();
  const expectedServiceSecret = deps.getServiceAuthSecret?.();

  if (safeSecretEquals(recoverySecret, expectedRecoverySecret)) {
    return "authorized";
  }
  if (safeSecretEquals(apiKey, expectedServiceSecret)) return "authorized";
  if (safeSecretEquals(bearer, expectedServiceSecret)) return "authorized";
  return "unauthorized";
}

const processorCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type, x-process-writing-secret, x-process-feedback-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: processorCorsHeaders });
}

export function createProcessWritingJobsHandler(
  deps: WritingProcessorDependencies,
) {
  const createRequestId = deps.createRequestId ?? (() => crypto.randomUUID());
  const createWorkerId = deps.createWorkerId ?? (() => crypto.randomUUID());
  const log = deps.log ?? defaultLog;

  return async (req: Request): Promise<Response> => {
    const requestId = createRequestId();
    const startedAt = Date.now();

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: processorCorsHeaders });
    }
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }

    // This endpoint is an internal worker. Browser JWTs terminate at the
    // gateway-verified kick-writing-jobs relay and are never verified here.
    // Rejecting before client creation also guarantees that an arbitrary
    // bearer token cannot trigger Auth or database traffic from this worker.
    const kickAuthorization = isAuthorizedKick(req, deps);
    if (kickAuthorization !== "authorized") {
      log({
        request_id: requestId,
        stage: "auth",
        status: "failed",
        safe_error_code: "kick_unauthorized",
        duration_ms: Date.now() - startedAt,
      });
      return jsonResponse({ error: "Unauthorized." }, 401);
    }

    let admin: WritingProcessorAdminClient;
    try {
      admin = deps.createAdminClient();
    } catch {
      log({
        request_id: requestId,
        stage: "response",
        status: "failed",
        safe_error_code: "processor_config_failed",
        duration_ms: Date.now() - startedAt,
      });
      return jsonResponse({ error: "Writing processor is unavailable." }, 503);
    }

    const workerId = createWorkerId();
    const task = processOneWritingJob({
      admin,
      workerId,
      requestId,
      evaluateSubmission: deps.evaluateSubmission,
      createProviderLifecycleHooks: deps.createProviderLifecycleHooks,
      log,
    })
      .then(async (result) => {
        if (result.outcome !== "retry_scheduled" || !result.retry_wakeup) {
          return;
        }

        if (!deps.wakeRetry) {
          log({
            request_id: requestId,
            stage: "wakeup",
            status: "skipped",
            safe_error_code: "retry_wakeup_not_configured",
            job_id: result.job_id,
            duration_ms: Date.now() - startedAt,
          });
          return;
        }

        try {
          const wakeup = await deps.wakeRetry(result.retry_wakeup);
          log({
            request_id: requestId,
            stage: "wakeup",
            status: wakeup === "invoked"
              ? "succeeded"
              : wakeup === "skipped"
              ? "skipped"
              : "failed",
            ...(wakeup === "invoked"
              ? {}
              : { safe_error_code: `retry_wakeup_${wakeup}` }),
            job_id: result.job_id,
            duration_ms: Date.now() - startedAt,
          });
        } catch {
          log({
            request_id: requestId,
            stage: "wakeup",
            status: "failed",
            safe_error_code: "retry_wakeup_failed",
            job_id: result.job_id,
            duration_ms: Date.now() - startedAt,
          });
        }
      })
      .catch(() => {
        log({
          request_id: requestId,
          stage: "response",
          status: "failed",
          safe_error_code: "background_task_failed",
          duration_ms: Date.now() - startedAt,
        });
      });

    try {
      deps.waitUntil(task);
    } catch {
      log({
        request_id: requestId,
        stage: "response",
        status: "failed",
        safe_error_code: "background_schedule_failed",
        duration_ms: Date.now() - startedAt,
      });
      return jsonResponse({ error: "Writing processor is unavailable." }, 503);
    }

    log({
      request_id: requestId,
      stage: "response",
      status: "succeeded",
      duration_ms: Date.now() - startedAt,
    });
    return jsonResponse({ status: "accepted", request_id: requestId }, 202);
  };
}
