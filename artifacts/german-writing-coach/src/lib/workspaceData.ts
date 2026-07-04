import type { AuthWorkspaceMembership } from "@/services/authService";

export const LEVEL_OPTIONS = ["A1", "A2", "B1", "B2"] as const;
export type WorkspaceLevel = (typeof LEVEL_OPTIONS)[number];

export const TASK_TYPE_OPTIONS = [
  "email",
  "message",
  "description",
  "opinion",
  "apology",
  "invitation",
  "formal_letter",
  "free_text",
  "writing",
] as const;
export type QuestionTaskType = (typeof TASK_TYPE_OPTIONS)[number];

export function formatTaskType(taskType: string) {
  return taskType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getActiveWorkspaceId(memberships: AuthWorkspaceMembership[]) {
  return memberships[0]?.workspace_id ?? null;
}

export function formatErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}
