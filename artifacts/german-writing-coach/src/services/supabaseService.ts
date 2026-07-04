import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabaseClient";

// Phase 2 foundation only. The approved demo UI still uses mock data.
// Real auth/data integration starts in Phase 3/4.

export function getSupabaseStatus() {
  return {
    configured: isSupabaseConfigured,
    client: getSupabaseClient(),
  };
}

export async function saveSubmission(data: any): Promise<void> {
  void data;
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, 500);
  });
}

export async function getSubmissions(): Promise<any[]> {
  return Promise.resolve([]);
}
