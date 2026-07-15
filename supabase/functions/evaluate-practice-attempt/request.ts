import {
  authenticationUnavailableMessage,
  extractBearerToken,
  type UserJwtVerificationResult,
} from "../_shared/user-auth.ts";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "../_shared/bounded-json-request.ts";

export type PracticeEvaluationRequestState = {
  assignment_id: string;
  attempt_id: string;
  evaluation_status:
    | "queued"
    | "evaluating"
    | "completed"
    | "not_needed"
    | "failed";
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

export type PracticeEvaluationRequestDependencies = {
  verifyUserToken(token: string): Promise<UserJwtVerificationResult>;
  acknowledgeAttempt(args: {
    authorization: string;
    assignmentId: string;
    attemptId: string;
  }): Promise<PracticeEvaluationRequestState>;
  authorizeProcessorKick(args: {
    actorId: string;
  }): Promise<PracticeProcessorKickAuthorization>;
  kickProcessor(): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
  log?: (event: Record<string, unknown>) => void;
  requestBodyReadTimeoutMs?: number;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const acceptedEvaluationStates = new Set([
  "queued",
  "evaluating",
  "completed",
  "not_needed",
  "failed",
]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: corsHeaders });
}

function safeErrorStatus(error: unknown) {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; status?: unknown }
    : null;
  const code = typeof record?.code === "string" ? record.code : "";
  const status = typeof record?.status === "number" ? record.status : 0;
  if (status === 401 || code === "28000" || code === "PGRST301") return 401;
  if (status === 403 || code === "42501") return 403;
  if (status === 404 || code === "02000" || code === "PGRST116") return 404;
  if (status === 400 || code === "22023" || code === "22P02") return 400;
  if (status === 409 || code === "55000" || code === "23514") return 409;
  return 503;
}

function safeErrorMessage(status: number) {
  if (status === 401) return "Authentication required.";
  if (status === 403) return "You cannot access this practice attempt.";
  if (status === 404) return "Practice attempt was not found.";
  if (status === 400) return "A valid assignment or attempt id is required.";
  if (status === 409) return "Practice feedback is not queued for evaluation.";
  return "Practice feedback is temporarily unavailable.";
}

export function createEvaluatePracticeAttemptRequestHandler(
  deps: PracticeEvaluationRequestDependencies,
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
    let attemptId = "";
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
      attemptId = typeof body.attempt_id === "string"
        ? body.attempt_id.trim()
        : typeof body.attemptId === "string"
        ? body.attemptId.trim()
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

    if (
      (!assignmentId && !attemptId) ||
      (assignmentId && !uuidPattern.test(assignmentId)) ||
      (attemptId && !uuidPattern.test(attemptId))
    ) {
      return respond({
        error: "A valid assignment or attempt id is required.",
      }, 400);
    }

    let state: PracticeEvaluationRequestState;
    try {
      state = await deps.acknowledgeAttempt({
        authorization,
        assignmentId,
        attemptId,
      });
    } catch (error) {
      const status = safeErrorStatus(error);
      log({
        function: "evaluate-practice-attempt",
        stage: "acknowledge",
        status: "failed",
        safe_error_code: `practice_evaluation_request_${status}`,
      });
      return respond({ error: safeErrorMessage(status) }, status);
    }

    if (
      !uuidPattern.test(state.assignment_id) ||
      !uuidPattern.test(state.attempt_id) ||
      (assignmentId && state.assignment_id !== assignmentId) ||
      (attemptId && state.attempt_id !== attemptId) ||
      !acceptedEvaluationStates.has(state.evaluation_status)
    ) {
      log({
        function: "evaluate-practice-attempt",
        stage: "acknowledge",
        status: "failed",
        safe_error_code: "invalid_practice_evaluation_state",
      });
      return respond({
        error: "Practice feedback is temporarily unavailable.",
      }, 503);
    }

    let processorKickStatus: PracticeProcessorKickStatus = "not_needed";
    if (["queued", "evaluating"].includes(state.evaluation_status)) {
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
            function: "evaluate-practice-attempt",
            stage: "kick",
            status: "failed",
            safe_error_code: "worksheet_answer_processor_kick_failed",
          });
        });
        try {
          deps.waitUntil(kick);
        } catch {
          // The durable queue remains authoritative; a recovery consumer can retry.
          processorKickStatus = "deferred";
          log({
            function: "evaluate-practice-attempt",
            stage: "kick",
            status: "failed",
            safe_error_code: "worksheet_answer_processor_schedule_failed",
          });
        }
      } else if (kickAuthorization === "rate_limited") {
        processorKickStatus = "rate_limited";
        log({
          function: "evaluate-practice-attempt",
          stage: "authorize_kick",
          status: "skipped",
          safe_error_code: "worksheet_answer_kick_rate_limited",
        });
      } else {
        processorKickStatus = "deferred";
        log({
          function: "evaluate-practice-attempt",
          stage: "authorize_kick",
          status: "skipped",
          safe_error_code: kickAuthorization === "inactive_actor"
            ? "worksheet_answer_kick_inactive_actor"
            : "worksheet_answer_kick_authorization_unavailable",
        });
      }
    }

    return respond({
      accepted: true,
      assignment_id: state.assignment_id,
      attempt_id: state.attempt_id,
      status: state.evaluation_status,
      evaluation_status: state.evaluation_status,
      evaluated: state.evaluation_status === "completed",
      processor_kick_status: processorKickStatus,
    }, 202);
  };
}
