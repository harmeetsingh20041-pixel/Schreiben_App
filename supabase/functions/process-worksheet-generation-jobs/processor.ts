import {
  type GeneratedWorksheetCompletion,
  WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS,
  type WorksheetCompletionPayload,
  WorksheetGenerationError,
  type WorksheetProviderLifecycleHooks,
  type WorksheetRejectedCandidate,
  worksheetSpendAccountingFailure,
} from "../_shared/worksheet-generation.ts";
import {
  callWorkerApiRpc,
  singleWorkerRpcRow,
  type WorkerApiClient,
} from "../_shared/worker-api.ts";
import {
  isDurableRetryTransition,
  retryScheduleFromFailureTransition,
  retryScheduleFromWorksheetStageContinuation,
  type RetryWakeup,
  type RetryWakeupSchedule,
} from "../_shared/retry-wakeup.ts";
import { dualProviderOutageReason } from "../_shared/provider-outage-recovery.ts";
import {
  advanceWorksheetGenerationFallback,
  advanceWorksheetGenerationRepair,
  WorksheetPrimaryFallbackContinuation,
  WorksheetRepairContinuation,
} from "./checkpoint.ts";

export const WORKSHEET_GENERATION_QUEUE = "worksheet_generation";
export const WORKSHEET_GENERATION_BATCH_SIZE = 1;
// The provider orchestrator enforces an 85-second total deadline. Reserve 55
// additional seconds for context reads, deterministic validation, transactional
// persistence, queue archival, and runtime scheduling/cancellation overhead.
export const WORKSHEET_GENERATION_LEASE_OVERHEAD_MS = 55_000;
export const WORKSHEET_GENERATION_VISIBILITY_SECONDS = Math.ceil(
  (WORKSHEET_PROVIDER_TOTAL_DEADLINE_MS +
    WORKSHEET_GENERATION_LEASE_OVERHEAD_MS) /
    1_000,
);

type RpcError = { code?: string; message?: string };

export type WorksheetWorkerClient = WorkerApiClient;

export type ClaimedWorksheetJob = {
  job_id: string;
  queue_message_id: number | string;
  entity_id: string;
  entity_version: number;
  attempt_number: number;
  lease_expires_at: string;
};

export type WorksheetWorkerEvent = {
  request_id: string;
  stage:
    | "auth"
    | "claim"
    | "prepare"
    | "complete"
    | "fail"
    | "wakeup"
    | "response";
  status: "started" | "succeeded" | "failed" | "skipped";
  safe_error_code?: string;
  job_id?: string;
  assignment_id?: string;
  attempt_number?: number;
};

export type WorksheetProcessorDependencies = {
  createAdminClient(): WorksheetWorkerClient;
  prepareWorksheet(args: {
    admin: WorksheetWorkerClient;
    assignmentId: string;
    requestId: string;
    jobId: string;
    queueMessageId: number | string;
    workerId: string;
    entityVersion: number;
    attemptNumber: number;
    providerLifecycleHooks: WorksheetProviderLifecycleHooks;
    providerCallKeyPrefix: string;
  }): Promise<WorksheetCompletionPayload>;
  createProviderLifecycleHooks: (args: {
    admin: WorksheetWorkerClient;
    jobId: string;
    entityVersion: number;
    attemptNumber: number;
  }) => WorksheetProviderLifecycleHooks;
  waitUntil(promise: Promise<unknown>): void;
  wakeRetry?: RetryWakeup;
  getRecoverySecret?: () => string | null | undefined;
  getServiceAuthSecret?: () => string | null | undefined;
  createRequestId?: () => string;
  createWorkerId?: () => string;
  log?: (event: WorksheetWorkerEvent) => void;
};

export type WorksheetJobResult = {
  claimed: boolean;
  outcome:
    | "no_message"
    | "claim_failed"
    | "invalid_claim"
    | "completed"
    | "retry_scheduled"
    | "failed";
  job_id?: string;
  retry_wakeup?: RetryWakeupSchedule;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integerPattern = /^\d+$/;

function positiveInteger(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && integerPattern.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function queueMessageId(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return typeof value === "string" && integerPattern.test(value) ? value : null;
}

function normalizeClaim(value: unknown): ClaimedWorksheetJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const jobId = typeof row.job_id === "string" ? row.job_id : "";
  const entityId = typeof row.entity_id === "string" ? row.entity_id : "";
  const entityVersion = positiveInteger(row.entity_version);
  const attemptNumber = positiveInteger(row.attempt_number);
  const messageId = queueMessageId(row.queue_message_id);
  const lease =
    typeof row.lease_expires_at === "string" ? row.lease_expires_at : "";
  if (
    !uuidPattern.test(jobId) ||
    !uuidPattern.test(entityId) ||
    entityVersion === null ||
    attemptNumber === null ||
    messageId === null ||
    !lease
  ) {
    return null;
  }
  return {
    job_id: jobId,
    queue_message_id: messageId,
    entity_id: entityId,
    entity_version: entityVersion,
    attempt_number: attemptNumber,
    lease_expires_at: lease,
  };
}

function safeCode(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "worksheet_generation_failed"
  );
}

function classify(error: unknown) {
  if (error instanceof WorksheetGenerationError) {
    return {
      safeCode: safeCode(error.safeCode),
      retryable: error.retryable,
      providerOutageRecoveryEligible:
        error.providerOutageRecoveryEligible === true,
    };
  }
  return {
    safeCode: "worksheet_generation_failed",
    retryable: true,
    providerOutageRecoveryEligible: false,
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
  return new WorksheetGenerationError(
    permanentCodes.has(error.code ?? "")
      ? "worksheet_completion_rejected"
      : "worksheet_completion_failed",
    !permanentCodes.has(error.code ?? ""),
  );
}

async function rpc(
  admin: WorksheetWorkerClient,
  name: string,
  args: Record<string, unknown>,
) {
  return await callWorkerApiRpc(admin, name, args);
}

function rejectedCandidateForTerminalRescue(
  worksheet: WorksheetCompletionPayload,
): WorksheetRejectedCandidate[] {
  if (
    worksheet.mode !== "generated" ||
    worksheet.validation.independent_model !== false ||
    worksheet.validation.rejection_reasons.length === 0
  ) {
    return [];
  }
  const rejected = worksheet as GeneratedWorksheetCompletion;
  return [
    {
      attempt_number: rejected.validation.attempt_count,
      provider: rejected.generation_source,
      model: rejected.generator_model,
      rejection_reasons: rejected.validation.rejection_reasons,
      candidate: rejected,
    },
  ];
}

async function tryCurrentCertifiedBankFallback(args: {
  admin: WorksheetWorkerClient;
  job: ClaimedWorksheetJob;
  workerId: string;
  fallbackReason:
    | "provider_unavailable"
    | "provider_exhausted"
    | "candidates_rejected";
  rejectedCandidates: WorksheetRejectedCandidate[];
}) {
  try {
    const response = await rpc(
      args.admin,
      "try_complete_current_certified_worksheet_bank_fallback",
      {
        target_job_id: args.job.job_id,
        target_queue_message_id: args.job.queue_message_id,
        target_worker_id: args.workerId,
        target_fallback_reason: args.fallbackReason,
        rejected_candidates: args.rejectedCandidates,
      },
    );
    if (response.error) return false;
    const row = singleWorkerRpcRow(response.data);
    return (
      row?.schema_version === 1 &&
      row.rescued === true &&
      row.assignment_id === args.job.entity_id &&
      typeof row.practice_test_id === "string" &&
      uuidPattern.test(row.practice_test_id)
    );
  } catch {
    // The ordinary durable failure/retry transition remains authoritative when
    // a just-published certified revision cannot be attached in this lease.
    return false;
  }
}

async function tryCurrentModelCacheFallback(args: {
  admin: WorksheetWorkerClient;
  job: ClaimedWorksheetJob;
  workerId: string;
  fallbackReason:
    | "provider_unavailable"
    | "provider_exhausted"
    | "candidates_rejected";
  rejectedCandidates: WorksheetRejectedCandidate[];
}) {
  try {
    const response = await rpc(
      args.admin,
      "try_complete_current_model_cache_fallback",
      {
        target_job_id: args.job.job_id,
        target_queue_message_id: args.job.queue_message_id,
        target_worker_id: args.workerId,
        target_fallback_reason: args.fallbackReason,
        rejected_candidates: args.rejectedCandidates,
      },
    );
    if (response.error) return false;
    const row = singleWorkerRpcRow(response.data);
    return (
      row?.schema_version === 1 &&
      row.rescued === true &&
      row.assignment_id === args.job.entity_id &&
      typeof row.practice_test_id === "string" &&
      uuidPattern.test(row.practice_test_id)
    );
  } catch {
    // A cache miss, stale cache entry, or transient cache-RPC failure must not
    // replace the existing durable retry/failure transition.
    return false;
  }
}

export async function processOneWorksheetGenerationJob(args: {
  admin: WorksheetWorkerClient;
  workerId: string;
  requestId: string;
  prepareWorksheet: WorksheetProcessorDependencies["prepareWorksheet"];
  createProviderLifecycleHooks: WorksheetProcessorDependencies["createProviderLifecycleHooks"];
  log?: WorksheetProcessorDependencies["log"];
}): Promise<WorksheetJobResult> {
  const log = args.log ?? ((event) => console.log(JSON.stringify(event)));
  let claimResponse: { data: unknown; error: RpcError | null };
  try {
    claimResponse = await rpc(args.admin, "claim_async_jobs", {
      target_queue_name: WORKSHEET_GENERATION_QUEUE,
      worker_id: args.workerId,
      batch_size: WORKSHEET_GENERATION_BATCH_SIZE,
      visibility_timeout_seconds: WORKSHEET_GENERATION_VISIBILITY_SECONDS,
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
    assignment_id: job.entity_id,
    attempt_number: job.attempt_number,
  });

  let terminalRejectedCandidates: WorksheetRejectedCandidate[] = [];
  try {
    let providerLifecycleHooks: WorksheetProviderLifecycleHooks;
    try {
      providerLifecycleHooks = args.createProviderLifecycleHooks({
        admin: args.admin,
        jobId: job.job_id,
        entityVersion: job.entity_version,
        attemptNumber: job.attempt_number,
      });
    } catch (error) {
      throw worksheetSpendAccountingFailure(error);
    }
    const worksheet = await args.prepareWorksheet({
      admin: args.admin,
      assignmentId: job.entity_id,
      requestId: args.requestId,
      jobId: job.job_id,
      queueMessageId: job.queue_message_id,
      workerId: args.workerId,
      entityVersion: job.entity_version,
      attemptNumber: job.attempt_number,
      providerLifecycleHooks,
      providerCallKeyPrefix: `worksheet_generation:job_${job.job_id}`,
    });
    log({
      request_id: args.requestId,
      stage: "prepare",
      status: "succeeded",
      job_id: job.job_id,
      assignment_id: job.entity_id,
      attempt_number: job.attempt_number,
    });
    terminalRejectedCandidates = rejectedCandidateForTerminalRescue(worksheet);
    if (
      terminalRejectedCandidates.length > 0 &&
      (await tryCurrentCertifiedBankFallback({
        admin: args.admin,
        job,
        workerId: args.workerId,
        fallbackReason: "candidates_rejected",
        rejectedCandidates: terminalRejectedCandidates,
      }))
    ) {
      log({
        request_id: args.requestId,
        stage: "complete",
        status: "succeeded",
        job_id: job.job_id,
        assignment_id: job.entity_id,
        attempt_number: job.attempt_number,
      });
      return { claimed: true, outcome: "completed", job_id: job.job_id };
    }
    if (
      terminalRejectedCandidates.length > 0 &&
      (await tryCurrentModelCacheFallback({
        admin: args.admin,
        job,
        workerId: args.workerId,
        fallbackReason: "candidates_rejected",
        rejectedCandidates: terminalRejectedCandidates,
      }))
    ) {
      log({
        request_id: args.requestId,
        stage: "complete",
        status: "succeeded",
        job_id: job.job_id,
        assignment_id: job.entity_id,
        attempt_number: job.attempt_number,
      });
      return { claimed: true, outcome: "completed", job_id: job.job_id };
    }
    let completeResponse: { data: unknown; error: RpcError | null };
    try {
      completeResponse = await rpc(
        args.admin,
        "complete_worksheet_generation",
        {
          target_job_id: job.job_id,
          target_queue_message_id: job.queue_message_id,
          worker_id: args.workerId,
          worksheet,
        },
      );
    } catch {
      throw new WorksheetGenerationError("worksheet_completion_failed", true);
    }
    if (completeResponse.error) {
      throw completionFailure(completeResponse.error);
    }
    log({
      request_id: args.requestId,
      stage: "complete",
      status: "succeeded",
      job_id: job.job_id,
      assignment_id: job.entity_id,
      attempt_number: job.attempt_number,
    });
    return { claimed: true, outcome: "completed", job_id: job.job_id };
  } catch (error) {
    let failureSource = error;
    if (error instanceof WorksheetPrimaryFallbackContinuation) {
      try {
        const transition = await advanceWorksheetGenerationFallback({
          admin: args.admin,
          jobId: job.job_id,
          queueMessageId: job.queue_message_id,
          workerId: args.workerId,
          entityVersion: job.entity_version,
          primaryFailureCode: error.safeCode,
        });
        const retryWakeup = retryScheduleFromWorksheetStageContinuation(
          transition,
          job.job_id,
          "primary_fallback_generation",
        );
        log({
          request_id: args.requestId,
          stage: "prepare",
          status: "succeeded",
          job_id: job.job_id,
          assignment_id: job.entity_id,
          attempt_number: job.attempt_number,
        });
        return {
          claimed: true,
          outcome: "retry_scheduled",
          job_id: job.job_id,
          ...(retryWakeup ? { retry_wakeup: retryWakeup } : {}),
        };
      } catch (transitionError) {
        failureSource = transitionError;
      }
    } else if (error instanceof WorksheetRepairContinuation) {
      try {
        const transition = await advanceWorksheetGenerationRepair({
          admin: args.admin,
          jobId: job.job_id,
          queueMessageId: job.queue_message_id,
          workerId: args.workerId,
          entityVersion: job.entity_version,
          rejectedCandidate: error.rejectedCandidate,
        });
        const retryWakeup = retryScheduleFromWorksheetStageContinuation(
          transition,
          job.job_id,
          "repair_generation",
        );
        log({
          request_id: args.requestId,
          stage: "prepare",
          status: "succeeded",
          job_id: job.job_id,
          assignment_id: job.entity_id,
          attempt_number: job.attempt_number,
        });
        return {
          claimed: true,
          outcome: "retry_scheduled",
          job_id: job.job_id,
          ...(retryWakeup ? { retry_wakeup: retryWakeup } : {}),
        };
      } catch (transitionError) {
        failureSource = transitionError;
      }
    }
    const failure = classify(failureSource);
    const outageReason = dualProviderOutageReason(failure);
    const fallbackReason =
      terminalRejectedCandidates.length > 0
        ? "candidates_rejected"
        : outageReason
          ? "provider_unavailable"
          : "provider_exhausted";
    if (
      await tryCurrentCertifiedBankFallback({
        admin: args.admin,
        job,
        workerId: args.workerId,
        fallbackReason,
        rejectedCandidates: terminalRejectedCandidates,
      })
    ) {
      log({
        request_id: args.requestId,
        stage: "complete",
        status: "succeeded",
        job_id: job.job_id,
        assignment_id: job.entity_id,
        attempt_number: job.attempt_number,
      });
      return { claimed: true, outcome: "completed", job_id: job.job_id };
    }
    if (
      await tryCurrentModelCacheFallback({
        admin: args.admin,
        job,
        workerId: args.workerId,
        fallbackReason,
        rejectedCandidates: terminalRejectedCandidates,
      })
    ) {
      log({
        request_id: args.requestId,
        stage: "complete",
        status: "succeeded",
        job_id: job.job_id,
        assignment_id: job.entity_id,
        attempt_number: job.attempt_number,
      });
      return { claimed: true, outcome: "completed", job_id: job.job_id };
    }
    let failTransitionFailed = false;
    let durableRetry = false;
    let retryWakeup: RetryWakeupSchedule | null = null;
    try {
      const response = outageReason
        ? await rpc(args.admin, "defer_async_job_for_provider_outage", {
            target_job_id: job.job_id,
            target_queue_message_id: job.queue_message_id,
            worker_id: args.workerId,
            outage_reason: outageReason,
          })
        : await rpc(args.admin, "fail_async_job", {
            target_job_id: job.job_id,
            target_queue_message_id: job.queue_message_id,
            worker_id: args.workerId,
            error_code: failure.safeCode,
            retryable: failure.retryable,
          });
      failTransitionFailed = Boolean(response.error);
      durableRetry =
        !failTransitionFailed &&
        isDurableRetryTransition(response.data, job.job_id);
      if (!failTransitionFailed && failure.retryable && !outageReason) {
        retryWakeup = retryScheduleFromFailureTransition(
          response.data,
          job.job_id,
        );
      }
    } catch {
      failTransitionFailed = true;
    }
    log({
      request_id: args.requestId,
      stage: "fail",
      status: failTransitionFailed ? "failed" : "succeeded",
      safe_error_code: failTransitionFailed
        ? "worksheet_fail_transition_failed"
        : (outageReason ?? failure.safeCode),
      job_id: job.job_id,
      assignment_id: job.entity_id,
      attempt_number: job.attempt_number,
    });
    return {
      claimed: true,
      outcome: durableRetry ? "retry_scheduled" : "failed",
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
    difference |=
      (received.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function authorized(req: Request, deps: WorksheetProcessorDependencies) {
  const bearer = (req.headers.get("Authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const apiKey = (req.headers.get("apikey") ?? "").trim();
  const recovery = (req.headers.get("x-process-worksheet-secret") ?? "").trim();
  return (
    secretEquals(bearer, deps.getServiceAuthSecret?.()) ||
    secretEquals(apiKey, deps.getServiceAuthSecret?.()) ||
    secretEquals(recovery, deps.getRecoverySecret?.())
  );
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-process-worksheet-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function createWorksheetGenerationProcessorHandler(
  deps: WorksheetProcessorDependencies,
) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return Response.json(
        { error: "Method not allowed." },
        {
          status: 405,
          headers: corsHeaders,
        },
      );
    }
    if (!authorized(req, deps)) {
      return Response.json(
        { error: "Unauthorized." },
        {
          status: 401,
          headers: corsHeaders,
        },
      );
    }
    let admin: WorksheetWorkerClient;
    try {
      admin = deps.createAdminClient();
    } catch {
      return Response.json(
        { error: "Worksheet processor is unavailable." },
        {
          status: 503,
          headers: corsHeaders,
        },
      );
    }
    const requestId = deps.createRequestId?.() ?? crypto.randomUUID();
    const workerId = deps.createWorkerId?.() ?? crypto.randomUUID();
    const task = processOneWorksheetGenerationJob({
      admin,
      workerId,
      requestId,
      prepareWorksheet: deps.prepareWorksheet,
      createProviderLifecycleHooks: deps.createProviderLifecycleHooks,
      log: deps.log,
    })
      .then(async (result) => {
        if (result.outcome !== "retry_scheduled" || !result.retry_wakeup) {
          return;
        }
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
            status:
              wakeup === "invoked"
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
      })
      .catch(() => undefined);
    try {
      deps.waitUntil(task);
    } catch {
      return Response.json(
        { error: "Worksheet processor is unavailable." },
        {
          status: 503,
          headers: corsHeaders,
        },
      );
    }
    return Response.json(
      { status: "accepted", request_id: requestId },
      {
        status: 202,
        headers: corsHeaders,
      },
    );
  };
}
