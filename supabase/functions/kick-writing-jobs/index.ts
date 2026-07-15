import {
  createAdminClient,
  getSecretKey,
  requireEnv,
  serviceFunctionHeaders,
} from "../_shared/writing-feedback.ts";
import { callWorkerApiRpc } from "../_shared/worker-api.ts";
import { createSupabaseUserJwtVerifier } from "../_shared/user-auth.ts";
import {
  createWritingKickRelayHandler,
  type WritingKickRelayAuthorization,
} from "./handler.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

async function authorizeKick(
  userId: string,
): Promise<WritingKickRelayAuthorization> {
  const admin = createAdminClient();
  const { data, error } = await callWorkerApiRpc(
    admin,
    "authorize_writing_processor_kick",
    { target_user_id: userId },
  );
  if (error) return "unavailable";
  if (
    data === "allowed" || data === "no_pending_work" ||
    data === "rate_limited" ||
    data === "inactive_user"
  ) {
    return data;
  }
  return "unavailable";
}

async function kickWorker() {
  const serviceKey = getSecretKey();
  if (!serviceKey) throw new Error("Supabase service key is not configured.");

  const response = await fetch(
    `${requireEnv("SUPABASE_URL")}/functions/v1/process-writing-jobs`,
    {
      method: "POST",
      headers: serviceFunctionHeaders(serviceKey),
      // The processor claims the next fixed-queue message. Neither the relay
      // nor its caller can choose the submission that receives provider work.
      body: "{}",
    },
  );
  if (!response.ok) throw new Error("Writing processor wake-up failed.");
}

const handler = createWritingKickRelayHandler({
  verifyUserToken: createSupabaseUserJwtVerifier(),
  authorizeKick,
  kickWorker,
  waitUntil: (promise) => EdgeRuntime.waitUntil(promise),
});

Deno.serve(handler);
