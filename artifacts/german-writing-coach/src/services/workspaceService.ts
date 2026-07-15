import { callApiRpc, parseApiRecord } from "@/services/apiFacade";

export interface ActiveWorkspace {
  id: string;
  name: string;
  slug: string;
}

export async function getWorkspace(workspaceId: string): Promise<ActiveWorkspace | null> {
  const value = await callApiRpc<unknown>(
    "get_workspace",
    { target_workspace_id: workspaceId },
    "The workspace could not be loaded. Please try again.",
  );
  return parseApiRecord<ActiveWorkspace>(value, "Workspace");
}
