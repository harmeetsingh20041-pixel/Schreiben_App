import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

type AppSupabaseClient = SupabaseClient<Database, "api">;

let client: AppSupabaseClient | null = null;
export const SUPABASE_AUTH_STORAGE_KEY = "gwc_supabase_auth";

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export function getSupabaseClient(): AppSupabaseClient | null {
  if (!isSupabaseConfigured) {
    return null;
  }

  if (!client) {
    client = createClient<Database, "api">(supabaseUrl!, supabaseAnonKey!, {
      db: { schema: "api" },
      auth: {
        // PKCE binds email-confirmation, magic-link, and password-recovery
        // callbacks to the browser that initiated the flow. The client still
        // performs the code exchange automatically after the redirect.
        flowType: "pkce",
        detectSessionInUrl: true,
        storageKey: SUPABASE_AUTH_STORAGE_KEY,
      },
    });
  }

  return client;
}

// The production browser talks only to the deliberately exposed API facade.
// Auth, Realtime, Storage, and Edge Functions continue to use their dedicated
// Supabase endpoints; no browser REST request defaults to the public schema.
export const supabase = getSupabaseClient();

export function clearSupabaseBrowserSession() {
  if (typeof window === "undefined") return;
  for (const key of [
    SUPABASE_AUTH_STORAGE_KEY,
    `${SUPABASE_AUTH_STORAGE_KEY}-code-verifier`,
    `${SUPABASE_AUTH_STORAGE_KEY}-user`,
  ]) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Auth state below is still cleared in memory and from query caches.
    }
  }
}
