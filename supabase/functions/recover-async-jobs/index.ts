import {
  createAdminClient,
  getSecretKey,
  requireEnv,
} from "../_shared/writing-feedback.ts";
import { createAsyncRecoveryHandler } from "./handler.ts";

declare const EdgeRuntime: {
  waitUntil(task: Promise<unknown>): void;
};

const handler = createAsyncRecoveryHandler({
  createAdminClient,
  getRecoverySecret: () => Deno.env.get("PROCESS_RECOVERY_SECRET"),
  getServiceKey: getSecretKey,
  getSupabaseUrl: () => requireEnv("SUPABASE_URL"),
  waitUntil: (task) => EdgeRuntime.waitUntil(task),
  log: (event) =>
    console.log(JSON.stringify({
      function: "recover-async-jobs",
      ...event,
    })),
});

Deno.serve(handler);
