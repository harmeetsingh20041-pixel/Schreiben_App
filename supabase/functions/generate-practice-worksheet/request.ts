import {
  authenticationUnavailableMessage,
  extractBearerToken,
  type UserJwtVerificationResult,
} from "../_shared/user-auth.ts";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "../_shared/bounded-json-request.ts";

export type WorksheetRequestRpcResult = {
  assignment_id: string;
  job_id: string | null;
  generation_status: string;
};

export type PracticeProcessorKickAuthorization =
  | "allowed"
  | "rate_limited"
  | "inactive_actor"
  | "unavailable";

export type PracticeProcessorKickStatus =
  | "scheduled"
  | "rate_limited"
  | "deferred"
  | "not_needed";

export type WorksheetRequestDependencies = {
  verifyUserToken(token: string): Promise<UserJwtVerificationResult>;
  requestWorksheet(args: {
    authorization: string;
    assignmentId: string;
  }): Promise<WorksheetRequestRpcResult>;
  authorizeProcessorKick(args: {
    actorId: string;
  }): Promise<PracticeProcessorKickAuthorization>;
  kickProcessor(): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
  log?: (event: Record<string, unknown>) => void;
  requestBodyReadTimeoutMs?: number;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function respond(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: corsHeaders });
}

function safeRpcStatus(error: unknown) {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (code === "28000" || code === "PGRST301") return 401;
  if (code === "42501") return 403;
  if (code === "02000" || code === "PGRST116") return 404;
  if (code === "PT429" || code === "54000") return 429;
  if (code === "22023" || code === "23514") return 400;
  if (code === "55000" || code === "23505") return 409;
  return 503;
}

function isRetryExhaustedError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const message = "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : "";
  return message === "worksheet_generation_retry_limit_exceeded";
}

export function createRequestPracticeWorksheetHandler(
  deps: WorksheetRequestDependencies,
) {
  const log = deps.log ?? ((event) => console.log(JSON.stringify(event)));

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return respond({ error: "Method not allowed." }, 405);
    }

    const token = extractBearerToken(req.headers.get("Authorization"));
    if (!token) {
      return respond({ error: "Authentication required." }, 401);
    }
    const authorization = `Bearer ${token}`;

    let verification: UserJwtVerificationResult;
    try {
      verification = await deps.verifyUserToken(token);
    } catch {
      verification = { status: "unavailable" };
    }
    if (verification.status === "unavailable") {
      return respond({ error: authenticationUnavailableMessage }, 503);
    }
    if (verification.status !== "verified") {
      return respond({ error: "Authentication required." }, 401);
    }
    const actorId = verification.userId;

    let assignmentId = "";
    try {
      const body = await readBoundedJsonRequest(req, {
        readTimeoutMs: deps.requestBodyReadTimeoutMs,
      }) as Record<
        string,
        unknown
      >;
      assignmentId = typeof body.assignment_id === "string"
        ? body.assignment_id.trim()
        : typeof body.assignmentId === "string"
        ? body.assignmentId.trim()
        : "";
    } catch (error) {
      if (
        error instanceof BoundedJsonRequestError &&
        error.kind === "body_too_large"
      ) {
        return respond({ error: "Request body is too large." }, 413);
      }
      if (
        error instanceof BoundedJsonRequestError &&
        error.kind === "body_read_timeout"
      ) {
        return respond({ error: "Request body timed out." }, 408);
      }
      return respond({ error: "Invalid request body." }, 400);
    }
    if (!uuidPattern.test(assignmentId)) {
      return respond({ error: "A valid assignment id is required." }, 400);
    }

    let state: WorksheetRequestRpcResult;
    try {
      state = await deps.requestWorksheet({ authorization, assignmentId });
    } catch (error) {
      const status = safeRpcStatus(error);
      const retryExhausted = status === 429 && isRetryExhaustedError(error);
      log({
        function: "generate-practice-worksheet",
        stage: "enqueue",
        status: "failed",
        safe_error_code: retryExhausted
          ? "worksheet_generation_retry_limit_exceeded"
          : `worksheet_request_${status}`,
      });
      return respond(
        {
          error: retryExhausted
            ? "Automatic worksheet retries are exhausted. Your teacher can review this practice topic while approved material is checked."
            : status >= 500
            ? "Worksheet preparation is temporarily unavailable."
            : status === 404
            ? "Practice assignment was not found."
            : status === 403
            ? "You cannot access this practice assignment."
            : status === 409
            ? "Practice assignment is not available for generation."
            : status === 429
            ? "Worksheet requests are temporarily limited. Please try again later."
            : "Worksheet request could not be accepted.",
          ...(retryExhausted
            ? { error_code: "worksheet_generation_retry_limit_exceeded" }
            : {}),
        },
        status,
      );
    }

    if (
      state.assignment_id !== assignmentId ||
      !["queued", "generating", "ready", "needs_review"].includes(
        state.generation_status,
      ) ||
      (["ready", "needs_review"].includes(state.generation_status) &&
        state.job_id !== null) ||
      (["queued", "generating"].includes(state.generation_status) &&
        (typeof state.job_id !== "string" || !uuidPattern.test(state.job_id)))
    ) {
      log({
        function: "generate-practice-worksheet",
        stage: "enqueue",
        status: "failed",
        safe_error_code: "invalid_request_state",
      });
      return respond(
        {
          error: "Worksheet preparation is temporarily unavailable.",
        },
        503,
      );
    }

    let processorKickStatus: PracticeProcessorKickStatus = "not_needed";
    if (["queued", "generating"].includes(state.generation_status)) {
      let kickAuthorization: PracticeProcessorKickAuthorization = "unavailable";
      try {
        kickAuthorization = await deps.authorizeProcessorKick({
          actorId,
        });
      } catch {
        // Fall through to one stable deferred-kick event below.
      }

      if (kickAuthorization === "allowed") {
        processorKickStatus = "scheduled";
        const kick = deps.kickProcessor().catch(() => {
          log({
            function: "generate-practice-worksheet",
            stage: "kick",
            status: "failed",
            safe_error_code: "processor_kick_failed",
          });
        });
        try {
          deps.waitUntil(kick);
        } catch {
          // The durable queue remains the source of truth; the recovery consumer can retry it.
          processorKickStatus = "deferred";
          log({
            function: "generate-practice-worksheet",
            stage: "kick",
            status: "failed",
            safe_error_code: "processor_kick_schedule_failed",
          });
        }
      } else if (kickAuthorization === "rate_limited") {
        processorKickStatus = "rate_limited";
        log({
          function: "generate-practice-worksheet",
          stage: "authorize_kick",
          status: "skipped",
          safe_error_code: "processor_kick_rate_limited",
        });
      } else {
        processorKickStatus = "deferred";
        log({
          function: "generate-practice-worksheet",
          stage: "authorize_kick",
          status: "skipped",
          safe_error_code: kickAuthorization === "inactive_actor"
            ? "processor_kick_inactive_actor"
            : "processor_kick_authorization_unavailable",
        });
      }
    }

    return respond(
      {
        assignment_id: state.assignment_id,
        job_id: state.job_id,
        generation_status: state.generation_status,
        processor_kick_status: processorKickStatus,
      },
      202,
    );
  };
}
