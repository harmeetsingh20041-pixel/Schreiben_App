import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

type AppSupabaseClient = SupabaseClient<Database>;

let client: AppSupabaseClient | null = null;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export function getSupabaseClient(): AppSupabaseClient | null {
  if (!isSupabaseConfigured) {
    return null;
  }

  if (!client) {
    client = createClient<Database>(supabaseUrl!, supabaseAnonKey!);
  }

  return client;
}

// Real auth starts in Phase 3. Data-heavy workflows still keep the approved
// mock fallback until Phase 4 replaces them gradually.
export const supabase = getSupabaseClient();
