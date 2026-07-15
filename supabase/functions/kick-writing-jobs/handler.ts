import {
  authenticationUnavailableMessage,
  extractBearerToken,
  type UserJwtVerificationResult,
} from "../_shared/user-auth.ts";

const relayCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export type WritingKickRelayAuthorization =
  | "allowed"
  | "no_pending_work"
  | "rate_limited"
  | "inactive_user"
  | "unavailable";

export type WritingKickRelayEvent = {
  request_id: string;
  stage: "auth" | "authorize" | "kick" | "response";
  status: "succeeded" | "failed" | "skipped";
  safe_error_code?: string;
  duration_ms?: number;
};

export type WritingKickRelayDependencies = {
  verifyUserToken(token: string): Promise<UserJwtVerificationResult>;
  authorizeKick(userId: string): Promise<WritingKickRelayAuthorization>;
  kickWorker(): Promise<unknown>;
  waitUntil(task: Promise<unknown>): void;
  createRequestId?: () => string;
  now?: () => number;
  log?: (event: WritingKickRelayEvent) => void;
};

function jsonResponse(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: relayCorsHeaders });
}

function defaultLog(event: WritingKickRelayEvent) {
  console.log(JSON.stringify({ function: "kick-writing-jobs", ...event }));
}

export function createWritingKickRelayHandler(
  deps: WritingKickRelayDependencies,
) {
  const createRequestId = deps.createRequestId ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;

  return async (req: Request): Promise<Response> => {
    const requestId = createRequestId();
    const startedAt = now();

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: relayCorsHeaders });
    }
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }

    const token = extractBearerToken(req.headers.get("Authorization"));
    let verification: UserJwtVerificationResult = { status: "invalid" };
    if (token) {
      try {
        verification = await deps.verifyUserToken(token);
      } catch {
        verification = { status: "unavailable" };
      }
    }
    if (verification.status === "unavailable") {
      log({
        request_id: requestId,
        stage: "auth",
        status: "failed",
        safe_error_code: "relay_jwt_unavailable",
        duration_ms: now() - startedAt,
      });
      return jsonResponse({ error: authenticationUnavailableMessage }, 503);
    }
    if (verification.status !== "verified") {
      log({
        request_id: requestId,
        stage: "auth",
        status: "failed",
        safe_error_code: "relay_jwt_invalid",
        duration_ms: now() - startedAt,
      });
      return jsonResponse({ error: "Unauthorized." }, 401);
    }
    const userId = verification.userId;

    let authorization: WritingKickRelayAuthorization;
    try {
      authorization = await deps.authorizeKick(userId);
    } catch {
      authorization = "unavailable";
    }

    if (authorization === "no_pending_work") {
      log({
        request_id: requestId,
        stage: "kick",
        status: "skipped",
        safe_error_code: "relay_no_pending_work",
        duration_ms: now() - startedAt,
      });
      return jsonResponse({
        status: "accepted",
        processor_kick_status: "not_needed",
        request_id: requestId,
      }, 202);
    }

    if (authorization !== "allowed") {
      const status = authorization === "rate_limited"
        ? 429
        : authorization === "inactive_user"
        ? 403
        : 503;
      const error = status === 429
        ? "Too many processor requests. The queued writing will continue automatically."
        : status === 403
        ? "An active workspace membership is required."
        : "Writing processor authorization is temporarily unavailable.";
      log({
        request_id: requestId,
        stage: "authorize",
        status: "failed",
        safe_error_code: `relay_${authorization}`,
        duration_ms: now() - startedAt,
      });
      return jsonResponse({ error }, status);
    }

    const kickTask = Promise.resolve().then(() => deps.kickWorker()).then(
      () => {
        log({
          request_id: requestId,
          stage: "kick",
          status: "succeeded",
        });
      },
    ).catch(() => {
      // The writing transaction already committed. The recovery consumer will
      // pick up the durable queue if this best-effort wake-up fails.
      log({
        request_id: requestId,
        stage: "kick",
        status: "failed",
        safe_error_code: "relay_worker_unavailable",
      });
    });

    let kickStatus: "scheduled" | "deferred" = "scheduled";
    try {
      deps.waitUntil(kickTask);
    } catch {
      kickStatus = "deferred";
      log({
        request_id: requestId,
        stage: "kick",
        status: "failed",
        safe_error_code: "relay_schedule_failed",
      });
    }

    log({
      request_id: requestId,
      stage: "response",
      status: "succeeded",
      duration_ms: now() - startedAt,
    });
    return jsonResponse({
      status: "accepted",
      processor_kick_status: kickStatus,
      request_id: requestId,
    }, 202);
  };
}
