import { createClient } from "npm:@supabase/supabase-js@2.110.0";
import {
  createRequestPracticeWorksheetHandler,
  type PracticeProcessorKickAuthorization,
  type WorksheetRequestRpcResult,
} from "./request.ts";
import {
  createAdminClient,
  getSecretKey,
  requireEnv,
  serviceFunctionHeaders,
} from "../_shared/writing-feedback.ts";
import { createSupabaseUserJwtVerifier } from "../_shared/user-auth.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

function createUserClient(authorization: string) {
  const url = requireEnv("SUPABASE_URL");
  let publicKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY");
  const configuredKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (!publicKey && configuredKeys) {
    try {
      const parsed = JSON.parse(configuredKeys) as Record<string, string>;
      publicKey = parsed.default ?? Object.values(parsed).find(Boolean);
    } catch {
      // The stable configuration failure below is safer than exposing JSON details.
    }
  }
  if (!publicKey) throw new Error("Supabase public key is not configured.");

  return createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
    db: { schema: "api" },
  });
}

async function authorizeProcessorKick(args: {
  actorId: string;
}): Promise<PracticeProcessorKickAuthorization> {
  const admin = createAdminClient();

  const { data, error } = await admin.rpc(
    "authorize_practice_processor_kick",
    {
      target_actor_id: args.actorId,
      target_worker_kind: "worksheet_generation",
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

const handler = createRequestPracticeWorksheetHandler({
  verifyUserToken: createSupabaseUserJwtVerifier(),
  requestWorksheet: async ({ authorization, assignmentId }) => {
    const client = createUserClient(authorization);
    const { data, error } = await client.rpc("request_practice_worksheet", {
      target_assignment_id: assignmentId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("Worksheet request returned no state.");
    return row as WorksheetRequestRpcResult;
  },
  authorizeProcessorKick,
  kickProcessor: async () => {
    const url = requireEnv("SUPABASE_URL");
    const secret = getSecretKey();
    if (!secret) throw new Error("Supabase service key is not configured.");
    const response = await fetch(
      `${url}/functions/v1/process-worksheet-generation-jobs`,
      {
        method: "POST",
        headers: serviceFunctionHeaders(secret),
        body: "{}",
      },
    );
    if (!response.ok) throw new Error("Worksheet processor kick failed.");
  },
  waitUntil: (promise) => EdgeRuntime.waitUntil(promise),
});

Deno.serve(handler);
