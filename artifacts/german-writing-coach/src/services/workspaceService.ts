import { getSupabaseClient } from "@/lib/supabaseClient";
import type { Database } from "@/types/supabase";

type WorkspaceRow = Database["public"]["Tables"]["workspaces"]["Row"];

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured. Demo mode is still available.");
  }
  return client;
}

export interface ActiveWorkspace {
  id: string;
  name: string;
  slug: string;
}

export async function getWorkspace(workspaceId: string): Promise<ActiveWorkspace | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("workspaces")
    .select("id, name, slug")
    .eq("id", workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const workspace = data as Pick<WorkspaceRow, "id" | "name" | "slug">;
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
  };
}
