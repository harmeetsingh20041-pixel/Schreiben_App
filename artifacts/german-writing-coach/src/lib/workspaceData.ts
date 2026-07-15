import { captureSafeException, isTechnicalErrorMessage } from "@/lib/monitoring";
import { isPublicAppError } from "@/lib/appError";

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

function getErrorMessage(error: unknown) {
  if (typeof error === "string") return error;
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
  if (isPublicAppError(error)) {
    captureSafeException(error, { code: error.code, displayed_message: error.publicMessage });
    return error.publicMessage;
  }

  const message = getErrorMessage(error);
  if (message) {
    const displayedMessage = isLikelySafeUserMessage(message) ? message : fallback;
    // Never send an arbitrary thrown string to monitoring. It can contain
    // provider output, SQL details, or student content.
    const reportableError = new Error("A client operation failed.");
    captureSafeException(reportableError, {
      fallback,
      displayed_message: displayedMessage,
      source_error_type: error instanceof Error ? error.name : typeof error,
    });
    return displayedMessage;
  }
  return fallback;
}
