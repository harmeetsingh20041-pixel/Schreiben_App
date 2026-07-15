import {
  createClient,
  type SupabaseClient,
} from "npm:@supabase/supabase-js@2.110.0";
import { createSupabaseUserJwtVerifier } from "../_shared/user-auth.ts";
import { requireEnv } from "../_shared/writing-feedback.ts";
import { createPrepareWritingFeedbackHandler } from "./handler.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

function getPublishableKey() {
  const directKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY");
  if (directKey) return directKey;

  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const firstKey = Object.values(parsed).find(Boolean);
      if (firstKey) return firstKey;
    } catch {
      // The stable configuration error is returned by the handler.
    }
  }

  throw new Error("Supabase publishable key is not configured.");
}

function createAuthenticatedClient(jwt: string) {
  return createClient(requireEnv("SUPABASE_URL"), getPublishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    db: { schema: "api" },
  });
}

async function kickWritingProcessor(jwt: string) {
  const response = await fetch(
    `${requireEnv("SUPABASE_URL")}/functions/v1/kick-writing-jobs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: getPublishableKey(),
        "Content-Type": "application/json",
      },
      // The relay verifies this JWT cryptographically before it binds the
      // durable rate limit to the caller. The downstream worker remains entity-free.
      body: "{}",
    },
  );
  if (!response.ok) throw new Error("Writing processor kick was not accepted.");
}

const handler = createPrepareWritingFeedbackHandler({
  verifyUserToken: createSupabaseUserJwtVerifier(),
  createAuthenticatedClient: (jwt) =>
    createAuthenticatedClient(jwt) as unknown as SupabaseClient,
  kickWritingProcessor,
  waitUntil: (promise) => EdgeRuntime.waitUntil(promise),
});

Deno.serve(handler);
