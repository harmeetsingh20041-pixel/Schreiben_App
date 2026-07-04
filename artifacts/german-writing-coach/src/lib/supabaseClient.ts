import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

let client: SupabaseClient | null = null;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) {
    return null;
  }

  if (!client) {
    client = createClient(supabaseUrl!, supabaseAnonKey!);
  }

  return client;
}

// Real auth starts in Phase 3. Data-heavy workflows still keep the approved
// mock fallback until Phase 4 replaces them gradually.
export const supabase = getSupabaseClient();
