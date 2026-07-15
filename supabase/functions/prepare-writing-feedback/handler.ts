import type { SupabaseClient } from "npm:@supabase/supabase-js@2.110.0";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "../_shared/bounded-json-request.ts";
import {
  authenticationUnavailableMessage,
  extractBearerToken,
  type UserJwtVerificationResult,
} from "../_shared/user-auth.ts";
import {
  cleanString,
  corsHeaders,
  createRequestId,
  durationMs,
  jsonResponse,
  logFunctionEvent,
} from "../_shared/writing-feedback.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const evaluationStatuses = new Set([
  "queued",
  "processing",
  "ready",
  "needs_review",
  "failed",
]);
const releaseStatuses = new Set(["held", "scheduled", "released"]);

type RpcError = {
  code?: string;
};

export type RetryWritingEvaluationState = {
  submission_id: string;
  job_id: string | null;
  evaluation_status:
    | "queued"
    | "processing"
    | "ready"
    | "needs_review"
    | "failed";
  release_status: "held" | "scheduled" | "released";
  release_at: string | null;
  job_created: boolean;
  already_processing: boolean;
};

type RetryRpcClient = Pick<SupabaseClient, "schema">;

export type PrepareWritingFeedbackDependencies = {
  verifyUserToken: (token: string) => Promise<UserJwtVerificationResult>;
  createAuthenticatedClient: (jwt: string) => RetryRpcClient;
  kickWritingProcessor: (jwt: string) => Promise<unknown>;
  waitUntil: (promise: Promise<unknown>) => void;
  createRequestId?: () => string;
  requestBodyReadTimeoutMs?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function normalizeRetryState(
  value: unknown,
  requestedSubmissionId: string,
): RetryWritingEvaluationState | null {
  if (Array.isArray(value) && value.length !== 1) return null;
  const row = Array.isArray(value) ? value[0] : value;
  const record = asRecord(row);
  if (!record) return null;

  const submissionId = typeof record.submission_id === "string"
    ? record.submission_id
    : "";
  const jobId = record.job_id === null
    ? null
    : typeof record.job_id === "string"
    ? record.job_id
    : "";
  const evaluationStatus = typeof record.evaluation_status === "string"
    ? record.evaluation_status
    : "";
  const releaseStatus = typeof record.release_status === "string"
    ? record.release_status
    : "";
  const releaseAt = record.release_at === null
    ? null
    : typeof record.release_at === "string"
    ? record.release_at
    : "";

  if (
    submissionId !== requestedSubmissionId ||
    !uuidPattern.test(submissionId) ||
    (jobId !== null && !uuidPattern.test(jobId)) ||
    !evaluationStatuses.has(evaluationStatus) ||
    !releaseStatuses.has(releaseStatus) ||
    (releaseAt !== null && !releaseAt) ||
    typeof record.job_created !== "boolean" ||
    typeof record.already_processing !== "boolean" ||
    (releaseStatus === "scheduled" && !releaseAt)
  ) {
    return null;
  }

  return {
    submission_id: submissionId,
    job_id: jobId,
    evaluation_status:
      evaluationStatus as RetryWritingEvaluationState["evaluation_status"],
    release_status:
      releaseStatus as RetryWritingEvaluationState["release_status"],
    release_at: releaseAt,
    job_created: record.job_created,
    already_processing: record.already_processing,
  };
}

function rpcErrorStatus(error: RpcError | null) {
  if (error?.code === "28000") return 401;
  if (error?.code === "42501") return 403;
  if (error?.code === "02000" || error?.code === "PGRST116") return 404;
  if (error?.code === "22P02" || error?.code === "22023") return 400;
  return 500;
}

function safeRpcError(status: number) {
  if (status === 401) return "Authentication required.";
  if (status === 403) return "Permission denied.";
  if (status === 404) return "Submission not found.";
  if (status === 400) return "Invalid feedback request.";
  return "Feedback could not be queued. Please try again later.";
}

export async function callRetryWritingEvaluation(
  client: RetryRpcClient,
  submissionId: string,
): Promise<{ data: unknown; error: RpcError | null }> {
  const response = await client
    .schema("api")
    .rpc("retry_writing_evaluation", {
      target_submission_id: submissionId,
    }) as unknown as { data: unknown; error: RpcError | null };
  return response;
}

export function createPrepareWritingFeedbackHandler(
  deps: PrepareWritingFeedbackDependencies,
) {
  const nextRequestId = deps.createRequestId ?? createRequestId;

  return async (req: Request): Promise<Response> => {
    const requestId = nextRequestId();
    const startedAt = Date.now();

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }

    const jwt = extractBearerToken(req.headers.get("Authorization"));
    if (!jwt) {
      return jsonResponse({ error: "Authentication required." }, 401);
    }

    let verification: UserJwtVerificationResult;
    try {
      verification = await deps.verifyUserToken(jwt);
    } catch {
      verification = { status: "unavailable" };
    }
    if (verification.status === "unavailable") {
      return jsonResponse({ error: authenticationUnavailableMessage }, 503);
    }
    if (verification.status !== "verified") {
      return jsonResponse({ error: "Authentication required." }, 401);
    }

    let submissionId = "";
    try {
      const body = await readBoundedJsonRequest(req, {
        readTimeoutMs: deps.requestBodyReadTimeoutMs,
      }) as Record<
        string,
        unknown
      >;
      submissionId = cleanString(body?.submission_id || body?.submissionId);
    } catch (error) {
      if (
        error instanceof BoundedJsonRequestError &&
        error.kind === "body_too_large"
      ) {
        return jsonResponse({ error: "Request body is too large." }, 413);
      }
      if (
        error instanceof BoundedJsonRequestError &&
        error.kind === "body_read_timeout"
      ) {
        return jsonResponse({ error: "Request body timed out." }, 408);
      }
      return jsonResponse({ error: "Invalid request body." }, 400);
    }
    if (!uuidPattern.test(submissionId)) {
      return jsonResponse({ error: "A valid submission id is required." }, 400);
    }

    let rpcClient: RetryRpcClient;
    try {
      rpcClient = deps.createAuthenticatedClient(jwt);
    } catch {
      return jsonResponse({ error: "Feedback service is unavailable." }, 503);
    }

    let rpcResponse: { data: unknown; error: RpcError | null };
    try {
      rpcResponse = await callRetryWritingEvaluation(rpcClient, submissionId);
    } catch {
      rpcResponse = { data: null, error: {} };
    }

    if (rpcResponse.error) {
      const status = rpcErrorStatus(rpcResponse.error);
      logFunctionEvent({
        request_id: requestId,
        function: "prepare-writing-feedback",
        stage: "enqueue_retry",
        status: "failed",
        submission_id: submissionId,
        safe_error_code: `retry_rpc_${status}`,
        duration_ms: durationMs(startedAt),
      });
      return jsonResponse({ error: safeRpcError(status) }, status);
    }

    const state = normalizeRetryState(rpcResponse.data, submissionId);
    if (!state) {
      logFunctionEvent({
        request_id: requestId,
        function: "prepare-writing-feedback",
        stage: "enqueue_retry",
        status: "failed",
        submission_id: submissionId,
        safe_error_code: "invalid_retry_state",
        duration_ms: durationMs(startedAt),
      });
      return jsonResponse({
        error: "Feedback could not be queued. Please try again later.",
      }, 500);
    }

    const kickTask = deps.kickWritingProcessor(jwt).then(() => {
      logFunctionEvent({
        request_id: requestId,
        function: "prepare-writing-feedback",
        stage: "kick_processor",
        status: "succeeded",
        submission_id: submissionId,
      });
    }).catch(() => {
      logFunctionEvent({
        request_id: requestId,
        function: "prepare-writing-feedback",
        stage: "kick_processor",
        status: "failed",
        submission_id: submissionId,
        safe_error_code: "processor_kick_failed",
      });
    });
    try {
      deps.waitUntil(kickTask);
    } catch {
      // The queue transaction already committed. Recovery consumers will pick
      // up the job if this immediate best-effort kick cannot be scheduled.
    }

    logFunctionEvent({
      request_id: requestId,
      function: "prepare-writing-feedback",
      stage: "response",
      status: "succeeded",
      submission_id: submissionId,
      duration_ms: durationMs(startedAt),
      detail:
        `evaluation_status=${state.evaluation_status}; job_created=${state.job_created}`,
    });

    return jsonResponse({
      ...state,
      // Compatibility fields keep the current teacher screen accurate until it
      // consumes the richer evaluation/release contract directly.
      status: state.evaluation_status,
      line_count: 0,
      already_processed: state.evaluation_status === "ready" ||
        state.evaluation_status === "needs_review",
    });
  };
}
