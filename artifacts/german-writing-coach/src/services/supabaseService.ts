import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabaseClient";

// Lightweight status helper retained for environment diagnostics. Protected
// V1 application flows require the real configured client.

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
