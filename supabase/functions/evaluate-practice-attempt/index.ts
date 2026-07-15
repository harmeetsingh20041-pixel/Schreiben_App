import {
  createClient,
  type SupabaseClient,
} from "npm:@supabase/supabase-js@2.110.0";
import {
  createAdminClient,
  getSecretKey,
  requireEnv,
  serviceFunctionHeaders,
} from "../_shared/writing-feedback.ts";
import { createSupabaseUserJwtVerifier } from "../_shared/user-auth.ts";
import {
  createEvaluatePracticeAttemptRequestHandler,
  type PracticeEvaluationRequestState,
  type PracticeProcessorKickAuthorization,
} from "./request.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

type ApiClient = SupabaseClient<any, any, "api", any, any>;

function publishableKey() {
  const direct = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY");
  if (direct) return direct;

  const configured = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed).find(Boolean);
      if (first) return first;
    } catch {
      // A stable configuration error is returned by the request handler.
    }
  }
  throw new Error("Supabase publishable key is not configured.");
}

function userClient(authorization: string): ApiClient {
  return createClient(requireEnv("SUPABASE_URL"), publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
    db: { schema: "api" },
  });
}

function stateError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

async function acknowledgeAttempt(args: {
  authorization: string;
  assignmentId: string;
  attemptId: string;
}): Promise<PracticeEvaluationRequestState> {
  const client = userClient(args.authorization);
  const { data, error } = await client.rpc(
    "get_practice_evaluation_request_state",
    {
      target_assignment_id: args.assignmentId || null,
      target_attempt_id: args.attemptId || null,
    },
  );
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null;
  const assignmentId = typeof row?.assignment_id === "string"
    ? row.assignment_id
    : "";
  const attemptId = typeof row?.attempt_id === "string" ? row.attempt_id : "";
  const evaluationStatus = typeof row?.evaluation_status === "string"
    ? row.evaluation_status
    : "";

  if (
    !assignmentId || !attemptId || ![
      "queued",
      "evaluating",
      "completed",
      "not_needed",
      "failed",
    ].includes(evaluationStatus)
  ) {
    throw stateError("50300", "Practice evaluation state was invalid.");
  }

  return {
    assignment_id: assignmentId,
    attempt_id: attemptId,
    evaluation_status:
      evaluationStatus as PracticeEvaluationRequestState["evaluation_status"],
  };
}

async function authorizeProcessorKick(args: {
  actorId: string;
}): Promise<PracticeProcessorKickAuthorization> {
  const admin = createAdminClient();

  const { data, error } = await admin.rpc(
    "authorize_practice_processor_kick",
    {
      target_actor_id: args.actorId,
      target_worker_kind: "worksheet_answer_evaluation",
    },
  );
  if (error) return "unavailable";

  if (
    data === "allowed" || data === "rate_limited" ||
    data === "inactive_actor"
  ) {
    return data;
  }
  return "unavailable";
}

async function kickProcessor() {
  const secret = getSecretKey();
  if (!secret) throw new Error("Supabase service key is not configured.");
  const response = await fetch(
    `${requireEnv("SUPABASE_URL")}/functions/v1/process-worksheet-answer-jobs`,
    {
      method: "POST",
      headers: serviceFunctionHeaders(secret),
      body: "{}",
    },
  );
  if (!response.ok) throw new Error("Worksheet answer processor kick failed.");
}

const handler = createEvaluatePracticeAttemptRequestHandler({
  verifyUserToken: createSupabaseUserJwtVerifier(),
  acknowledgeAttempt,
  authorizeProcessorKick,
  kickProcessor,
  waitUntil: (promise) => EdgeRuntime.waitUntil(promise),
});

Deno.serve(handler);
