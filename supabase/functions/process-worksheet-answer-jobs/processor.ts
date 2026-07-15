import {
  type WorksheetAnswerBeforeProviderCall,
  type WorksheetAnswerCompletionPayload,
  WorksheetAnswerEvaluationError,
  type WorksheetAnswerProviderNotCalled,
  type WorksheetAnswerProviderUsageRecorder,
} from "./evaluate.ts";
import {
  callWorkerApiRpc,
  type WorkerApiClient,
} from "../_shared/worker-api.ts";
import {
  isDurableRetryTransition,
  retryScheduleFromFailureTransition,
  type RetryWakeup,
  type RetryWakeupSchedule,
} from "../_shared/retry-wakeup.ts";
import { dualProviderOutageReason } from "../_shared/provider-outage-recovery.ts";

export const WORKSHEET_ANSWER_QUEUE = "worksheet_answer_evaluation";
export const WORKSHEET_ANSWER_BATCH_SIZE = 1;
export const WORKSHEET_ANSWER_VISIBILITY_SECONDS = 300;
export const PRACTICE_CYCLE_TRANSITION_BATCH_SIZE = 10;

type RpcError = { code?: string; message?: string };

export type WorksheetAnswerWorkerClient = WorkerApiClient;

export type WorksheetAnswerProviderLifecycleHooks = Readonly<{
  onBeforeProviderCall: WorksheetAnswerBeforeProviderCall;
  onProviderNotCalled: WorksheetAnswerProviderNotCalled;
  onProviderUsage: WorksheetAnswerProviderUsageRecorder;
}>;

export type ClaimedWorksheetAnswerJob = {
  job_id: string;
  queue_message_id: number | string;
  entity_id: string;
  entity_version: number;
  attempt_number: number;
  lease_expires_at: string;
};

export type WorksheetAnswerWorkerEvent = {
  request_id: string;
  stage:
    | "auth"
    | "claim"
    | "evaluate"
    | "complete"
    | "practice_transition"
    | "hold"
    | "fail"
    | "wakeup"
    | "response";
  status: "started" | "succeeded" | "failed" | "skipped";
  safe_error_code?: string;
  job_id?: string;
  attempt_id?: string;
  attempt_number?: number;
};

export type WorksheetAnswerProcessorDependencies = {
  createAdminClient(): WorksheetAnswerWorkerClient;
  evaluateAttempt(args: {
    admin: WorksheetAnswerWorkerClient;
    jobId: string;
    jobAttemptNumber: number;
    queueMessageId: number | string;
    workerId: string;
    attemptId: string;
    entityVersion: number;
    requestId: string;
    providerLifecycleHooks: WorksheetAnswerProviderLifecycleHooks;
    providerCallKeyPrefix: string;
  }): Promise<WorksheetAnswerCompletionPayload>;
  createProviderLifecycleHooks: (args: {
    admin: WorksheetAnswerWorkerClient;
    jobId: string;
    entityVersion: number;
    attemptNumber: number;
  }) => WorksheetAnswerProviderLifecycleHooks;
  waitUntil(promise: Promise<unknown>): void;
  wakeRetry?: RetryWakeup;
  getRecoverySecret?: () => string | null | undefined;
  getServiceAuthSecret?: () => string | null | undefined;
  createRequestId?: () => string;
  createWorkerId?: () => string;
  log?: (event: WorksheetAnswerWorkerEvent) => void;
};

export type WorksheetAnswerJobResult = {
  claimed: boolean;
  outcome:
    | "no_message"
    | "claim_failed"
    | "invalid_claim"
    | "completed"
    | "needs_review"
    | "retry_scheduled"
    | "failed";
  job_id?: string;
  retry_wakeup?: RetryWakeupSchedule;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integerPattern = /^\d+$/;

function nonNegativeInteger(value: unknown) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && integerPattern.test(value)
    ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function messageId(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return typeof value === "string" && integerPattern.test(value) ? value : null;
}

function normalizeClaim(value: unknown): ClaimedWorksheetAnswerJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const jobId = typeof row.job_id === "string" ? row.job_id : "";
  const attemptId = typeof row.entity_id === "string" ? row.entity_id : "";
  const entityVersion = nonNegativeInteger(row.entity_version);
  const attemptNumber = nonNegativeInteger(row.attempt_number);
  const queueMessageId = messageId(row.queue_message_id);
  const lease = typeof row.lease_expires_at === "string"
    ? row.lease_expires_at
    : "";
  if (
    !uuidPattern.test(jobId) || !uuidPattern.test(attemptId) ||
    entityVersion === null || entityVersion < 1 || attemptNumber === null ||
    attemptNumber < 1 || queueMessageId === null || !lease
  ) return null;
  return {
    job_id: jobId,
    queue_message_id: queueMessageId,
    entity_id: attemptId,
    entity_version: entityVersion,
    attempt_number: attemptNumber,
    lease_expires_at: lease,
  };
}

function safeCode(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 80) ||
    "worksheet_answer_evaluation_failed";
}

function classify(error: unknown) {
  if (error instanceof WorksheetAnswerEvaluationError) {
    return {
      safeCode: safeCode(error.safeCode),
      retryable: error.retryable,
      providerOutageRecoveryEligible:
        error.providerOutageRecoveryEligible === true,
      needsReviewReason: error.needsReviewReason,
    };
  }
  return {
    safeCode: "worksheet_answer_evaluation_failed",
    retryable: true,
    providerOutageRecoveryEligible: false,
    needsReviewReason: null,
  };
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
  return new WorksheetAnswerEvaluationError(
    permanent
      ? "worksheet_answer_completion_rejected"
      : "worksheet_answer_completion_failed",
    !permanent,
  );
}

function worksheetAnswerSpendAccountingFailure(error: unknown) {
  const retryable = !error || typeof error !== "object" ||
      typeof (error as { retryable?: unknown }).retryable !== "boolean"
    ? true
    : (error as { retryable: boolean }).retryable;
  return new WorksheetAnswerEvaluationError(
    "worksheet_spend_accounting_failed",
    retryable,
  );
}

async function rpc(
  admin: WorksheetAnswerWorkerClient,
  name: string,
  args: Record<string, unknown>,
) {
  return await callWorkerApiRpc(admin, name, args);
}

export async function processOneWorksheetAnswerJob(args: {
  admin: WorksheetAnswerWorkerClient;
  workerId: string;
  requestId: string;
  evaluateAttempt: WorksheetAnswerProcessorDependencies["evaluateAttempt"];
  createProviderLifecycleHooks:
    WorksheetAnswerProcessorDependencies["createProviderLifecycleHooks"];
  log?: WorksheetAnswerProcessorDependencies["log"];
}): Promise<WorksheetAnswerJobResult> {
  const log = args.log ?? ((event) => console.log(JSON.stringify(event)));
  let claimResponse: { data: unknown; error: RpcError | null };
  try {
    claimResponse = await rpc(args.admin, "claim_async_jobs", {
      target_queue_name: WORKSHEET_ANSWER_QUEUE,
      worker_id: args.workerId,
      batch_size: WORKSHEET_ANSWER_BATCH_SIZE,
      visibility_timeout_seconds: WORKSHEET_ANSWER_VISIBILITY_SECONDS,
    });
  } catch {
    return { claimed: false, outcome: "claim_failed" };
  }
  if (claimResponse.error) return { claimed: false, outcome: "claim_failed" };

  const rows = Array.isArray(claimResponse.data)
    ? claimResponse.data
    : claimResponse.data
    ? [claimResponse.data]
    : [];
  if (rows.length === 0) return { claimed: false, outcome: "no_message" };
  const job = normalizeClaim(rows[0]);
  if (!job) return { claimed: true, outcome: "invalid_claim" };

  log({
    request_id: args.requestId,
    stage: "claim",
    status: "succeeded",
    job_id: job.job_id,
    attempt_id: job.entity_id,
    attempt_number: job.attempt_number,
  });

  try {
    let providerLifecycleHooks: WorksheetAnswerProviderLifecycleHooks;
    try {
      providerLifecycleHooks = args.createProviderLifecycleHooks({
        admin: args.admin,
        jobId: job.job_id,
        entityVersion: job.entity_version,
        attemptNumber: job.attempt_number,
      });
    } catch (error) {
      throw worksheetAnswerSpendAccountingFailure(error);
    }
    const result = await args.evaluateAttempt({
      admin: args.admin,
      jobId: job.job_id,
      jobAttemptNumber: job.attempt_number,
      queueMessageId: job.queue_message_id,
      workerId: args.workerId,
      attemptId: job.entity_id,
      entityVersion: job.entity_version,
      requestId: args.requestId,
      providerLifecycleHooks,
      providerCallKeyPrefix: `worksheet_answer:message_${job.queue_message_id}`,
    });
    log({
      request_id: args.requestId,
      stage: "evaluate",
      status: "succeeded",
      job_id: job.job_id,
      attempt_id: job.entity_id,
      attempt_number: job.attempt_number,
    });

    let completion: { data: unknown; error: RpcError | null };
    try {
      const { adjudication, ...completionResult } = result;
      completion = await rpc(
        args.admin,
        "complete_worksheet_answer_adjudication",
        {
          target_job_id: job.job_id,
          target_queue_message_id: job.queue_message_id,
          worker_id: args.workerId,
          result: completionResult,
          adjudication,
        },
      );
    } catch {
      throw new WorksheetAnswerEvaluationError(
        "worksheet_answer_completion_failed",
        true,
      );
    }
    if (completion.error) {
      throw completionFailure(completion.error);
    }

    log({
      request_id: args.requestId,
      stage: "complete",
      status: "succeeded",
      job_id: job.job_id,
      attempt_id: job.entity_id,
      attempt_number: job.attempt_number,
    });

    // Scoring and the durable transition outbox append have already committed
    // inside complete_worksheet_answer_adjudication. Progress the adaptive
    // cycle immediately when possible, but never turn a valid score into a
    // failed answer job if this best-effort drain is unavailable. The private
    // outbox remains authoritative and pg_cron/recovery will retry it.
    try {
      const transition = await rpc(
        args.admin,
        "process_practice_cycle_transition_jobs",
        { max_jobs: PRACTICE_CYCLE_TRANSITION_BATCH_SIZE },
      );
      log({
        request_id: args.requestId,
        stage: "practice_transition",
        status: transition.error ? "failed" : "succeeded",
        ...(transition.error
          ? { safe_error_code: "practice_transition_drain_failed" }
          : {}),
        job_id: job.job_id,
        attempt_id: job.entity_id,
        attempt_number: job.attempt_number,
      });
    } catch {
      log({
        request_id: args.requestId,
        stage: "practice_transition",
        status: "failed",
        safe_error_code: "practice_transition_drain_failed",
        job_id: job.job_id,
        attempt_id: job.entity_id,
        attempt_number: job.attempt_number,
      });
    }
    return { claimed: true, outcome: "completed", job_id: job.job_id };
  } catch (error) {
    const failure = classify(error);
    const outageReason = dualProviderOutageReason(failure);
    const shouldHold = outageReason === null &&
      failure.needsReviewReason !== null &&
      (!failure.retryable || job.attempt_number >= 3);
    let failureTransitionFailed = false;
    let durableRetry = false;
    let retryWakeup: RetryWakeupSchedule | null = null;
    try {
      const response = shouldHold
        ? await rpc(
          args.admin,
          "hold_worksheet_answer_for_review",
          {
            target_job_id: job.job_id,
            target_queue_message_id: job.queue_message_id,
            worker_id: args.workerId,
            reason_code: failure.needsReviewReason,
          },
        )
        : outageReason
        ? await rpc(
          args.admin,
          "defer_async_job_for_provider_outage",
          {
            target_job_id: job.job_id,
            target_queue_message_id: job.queue_message_id,
            worker_id: args.workerId,
            outage_reason: outageReason,
          },
        )
        : await rpc(args.admin, "fail_async_job", {
          target_job_id: job.job_id,
          target_queue_message_id: job.queue_message_id,
          worker_id: args.workerId,
          error_code: failure.safeCode,
          retryable: failure.retryable,
        });
      failureTransitionFailed = Boolean(response.error);
      durableRetry = !shouldHold && !failureTransitionFailed &&
        isDurableRetryTransition(response.data, job.job_id);
      if (
        !shouldHold && !failureTransitionFailed && failure.retryable &&
        !outageReason
      ) {
        retryWakeup = retryScheduleFromFailureTransition(
          response.data,
          job.job_id,
        );
      }
    } catch {
      failureTransitionFailed = true;
    }
    log({
      request_id: args.requestId,
      stage: shouldHold ? "hold" : "fail",
      status: failureTransitionFailed ? "failed" : "succeeded",
      safe_error_code: failureTransitionFailed
        ? "worksheet_answer_fail_transition_failed"
        : shouldHold
        ? failure.needsReviewReason ?? "semantic_review_required"
        : outageReason ?? failure.safeCode,
      job_id: job.job_id,
      attempt_id: job.entity_id,
      attempt_number: job.attempt_number,
    });
    return {
      claimed: true,
      outcome: shouldHold && !failureTransitionFailed
        ? "needs_review"
        : durableRetry
        ? "retry_scheduled"
        : "failed",
      job_id: job.job_id,
      ...(retryWakeup ? { retry_wakeup: retryWakeup } : {}),
    };
  }
}

function secretEquals(received: string, expected: string | null | undefined) {
  if (!received || !expected) return false;
  const max = Math.max(received.length, expected.length);
  let difference = received.length ^ expected.length;
  for (let index = 0; index < max; index += 1) {
    difference |= (received.charCodeAt(index) || 0) ^
      (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function authorized(req: Request, deps: WorksheetAnswerProcessorDependencies) {
  const bearer = (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "").trim();
  const apiKey = (req.headers.get("apikey") ?? "").trim();
  const recovery = (
    req.headers.get("x-process-worksheet-answer-secret") ?? ""
  ).trim();
  return secretEquals(bearer, deps.getServiceAuthSecret?.()) ||
    secretEquals(apiKey, deps.getServiceAuthSecret?.()) ||
    secretEquals(recovery, deps.getRecoverySecret?.());
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-process-worksheet-answer-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function createWorksheetAnswerProcessorHandler(
  deps: WorksheetAnswerProcessorDependencies,
) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, {
        status: 405,
        headers: corsHeaders,
      });
    }
    if (!authorized(req, deps)) {
      return Response.json({ error: "Unauthorized." }, {
        status: 401,
        headers: corsHeaders,
      });
    }

    let admin: WorksheetAnswerWorkerClient;
    try {
      admin = deps.createAdminClient();
    } catch {
      return Response.json({
        error: "Worksheet answer processor is unavailable.",
      }, {
        status: 503,
        headers: corsHeaders,
      });
    }
    const requestId = deps.createRequestId?.() ?? crypto.randomUUID();
    const workerId = deps.createWorkerId?.() ?? crypto.randomUUID();
    const task = processOneWorksheetAnswerJob({
      admin,
      workerId,
      requestId,
      evaluateAttempt: deps.evaluateAttempt,
      createProviderLifecycleHooks: deps.createProviderLifecycleHooks,
      log: deps.log,
    }).then(async (result) => {
      if (result.outcome !== "retry_scheduled" || !result.retry_wakeup) return;
      if (!deps.wakeRetry) {
        deps.log?.({
          request_id: requestId,
          stage: "wakeup",
          status: "skipped",
          safe_error_code: "retry_wakeup_not_configured",
          job_id: result.job_id,
        });
        return;
      }
      try {
        const wakeup = await deps.wakeRetry(result.retry_wakeup);
        deps.log?.({
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
        });
      } catch {
        deps.log?.({
          request_id: requestId,
          stage: "wakeup",
          status: "failed",
          safe_error_code: "retry_wakeup_failed",
          job_id: result.job_id,
        });
      }
    }).catch(() => undefined);
    try {
      deps.waitUntil(task);
    } catch {
      return Response.json({
        error: "Worksheet answer processor is unavailable.",
      }, {
        status: 503,
        headers: corsHeaders,
      });
    }
    return Response.json({ status: "accepted", request_id: requestId }, {
      status: 202,
      headers: corsHeaders,
    });
  };
}
