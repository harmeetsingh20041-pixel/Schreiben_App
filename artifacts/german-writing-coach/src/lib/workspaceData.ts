import type { AuthWorkspaceMembership } from "@/services/authService";
import { captureSafeException, isTechnicalErrorMessage } from "@/lib/monitoring";

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

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "";
}

function isLikelySafeUserMessage(message: string) {
  if (!message || message.length > 220) return false;
  if (isTechnicalErrorMessage(message)) return false;
  return !/(at\s+\w+\s+\(|https?:\/\/|supabase\.co|postgres|sqlstate|constraint|stack|trace)/i.test(message);
}

export function formatErrorMessage(error: unknown, fallback: string) {
  const message = getErrorMessage(error);
  if (message) {
    captureSafeException(error, { fallback, displayed_message: isLikelySafeUserMessage(message) ? message : fallback });
    if (isLikelySafeUserMessage(message)) return message;
  }
  return fallback;
}
