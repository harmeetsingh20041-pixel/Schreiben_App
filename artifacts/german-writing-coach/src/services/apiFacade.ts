import { PublicAppError } from "@/lib/appError";
import { getSupabaseClient } from "@/lib/supabaseClient";

interface ApiRpcError {
  code?: string;
  message?: string;
}

interface ApiRpcResult<T> {
  data: T | null;
  error: ApiRpcError | null;
}

export interface ApiKeysetCursor {
  id: string;
  created_at?: string;
  requested_at?: string;
  updated_at?: string;
}

export interface ApiPage<T> {
  schema_version: 1;
  items: T[];
  total_count: number;
  returned_count: number;
  page_size: number;
  has_more: boolean;
  next_cursor: ApiKeysetCursor | null;
  next_offset?: number | null;
}

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new PublicAppError(
      "data_unavailable",
      "The application service is not configured. Please try again later.",
    );
  }
  return client;
}

export function toPublicDataError(
  error: unknown,
  fallback: string,
): PublicAppError {
  if (error instanceof PublicAppError) return error;
  const candidate =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown })
      : null;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const databaseMessage =
    typeof candidate?.message === "string" ? candidate.message.trim() : "";
  const isRateLimitCode = code === "54000" || code === "PT429";

  if (databaseMessage === "platform_admin_mfa_required") {
    return new PublicAppError(
      "data_mfa_required",
      "Complete two-factor authentication before continuing.",
    );
  }
  if (databaseMessage === "platform_admin_fresh_authentication_required") {
    return new PublicAppError(
      "data_fresh_reauthentication_required",
      "Enter a fresh authenticator code to confirm this administrator action.",
    );
  }
  if (
    [
      "active_account_session_required",
      "active_platform_admin_session_required",
    ].includes(databaseMessage)
  ) {
    return new PublicAppError(
      "data_session_expired",
      "Your account access changed or your session expired. Sign in again.",
    );
  }
  if (
    [
      "confirmed_standard_account_required",
      "standard_student_account_required",
    ].includes(databaseMessage)
  ) {
    return new PublicAppError(
      "data_permission_denied",
      "Teacher access can only be requested from a confirmed standard account.",
    );
  }
  if (databaseMessage === "teacher_access_already_active") {
    return new PublicAppError(
      "data_conflict",
      "Teacher access is already active. Refresh your account access.",
    );
  }
  if (databaseMessage === "teacher_workspace_limit_below_current_usage") {
    return new PublicAppError(
      "data_invalid_request",
      "The workspace limit cannot be lower than the teacher's current workspace count.",
    );
  }
  if (databaseMessage === "workspace_name_invalid") {
    return new PublicAppError(
      "data_invalid_request",
      "Use a teaching-area name between 1 and 120 characters.",
    );
  }
  if (
    [
      "teacher_access_revision_conflict",
      "teacher_access_state_conflict",
      "teacher_entitlement_revision_conflict",
    ].includes(databaseMessage)
  ) {
    return new PublicAppError(
      "data_conflict",
      "Teacher access changed while you were working. Refresh and try again.",
    );
  }
  if (
    [
      "teacher_access_request_not_found",
      "teacher_access_user_not_found",
      "teacher_entitlement_not_found",
    ].includes(databaseMessage)
  ) {
    return new PublicAppError(
      "data_not_found",
      "This teacher-access record is no longer available. Refresh and try again.",
    );
  }
  if (databaseMessage === "batch_writing_limit_invalid") {
    return new PublicAppError(
      "data_invalid_request",
      "Choose a daily writing limit from 1 to 10.",
    );
  }
  if (databaseMessage === "batch_writing_limit_unchanged") {
    return new PublicAppError(
      "data_invalid_request",
      "Choose a daily writing limit different from the class's current limit.",
    );
  }
  if (databaseMessage === "batch_writing_limit_revision_conflict") {
    return new PublicAppError(
      "data_conflict",
      "This writing-limit request changed while you were reviewing it. Refresh and try again.",
    );
  }
  if (databaseMessage === "batch_writing_limit_request_not_found") {
    return new PublicAppError(
      "data_not_found",
      "This writing-limit request is no longer available. Refresh and try again.",
    );
  }
  if (databaseMessage === "batch_writing_limit_request_stale") {
    return new PublicAppError(
      "data_conflict",
      "This request no longer matches the class's current limit or active state. Refresh and review it again.",
    );
  }

  if (code === "28000" || code === "PGRST301") {
    return new PublicAppError(
      "data_session_expired",
      "Your session has expired. Please sign in again.",
    );
  }
  if (code === "42501") {
    return new PublicAppError(
      "data_permission_denied",
      "You do not have permission to perform this action.",
    );
  }
  if (
    isRateLimitCode &&
    databaseMessage === "batch_join_attempt_rate_limited"
  ) {
    return new PublicAppError(
      "data_rate_limited",
      "Too many class-code attempts. Wait one minute, then try again.",
    );
  }
  if (isRateLimitCode && databaseMessage === "writing_daily_quota_exceeded") {
    return new PublicAppError(
      "data_rate_limited",
      "You have reached today’s writing-feedback limit for this class. Your saved drafts remain available; please continue tomorrow or ask your teacher for help.",
    );
  }
  if (isRateLimitCode && databaseMessage === "writing_monthly_quota_exceeded") {
    return new PublicAppError(
      "data_rate_limited",
      "You have reached this month’s writing-feedback limit for this class. Your saved drafts remain available; continue next month or ask your teacher for help.",
    );
  }
  if (
    isRateLimitCode &&
    databaseMessage === "student_ai_daily_budget_exceeded"
  ) {
    return new PublicAppError(
      "data_rate_limited",
      "You have reached today’s automatic-feedback and practice limit for this class. Your saved work remains available; continue tomorrow or ask your teacher for help.",
    );
  }
  if (
    isRateLimitCode &&
    databaseMessage === "student_ai_monthly_budget_exceeded"
  ) {
    return new PublicAppError(
      "data_rate_limited",
      "You have reached this month’s automatic writing-feedback limit for this class. Your work remains saved; continue next month or ask your teacher for help.",
    );
  }
  if (
    isRateLimitCode &&
    databaseMessage === "workspace_ai_daily_budget_exceeded"
  ) {
    return new PublicAppError(
      "data_rate_limited",
      "This class has reached today’s automatic-evaluation capacity. Saved work remains available; please try tomorrow or ask the teacher to contact support.",
    );
  }
  if (
    isRateLimitCode &&
    [
      "writing_manual_retry_limit_exceeded",
      "worksheet_generation_retry_limit_exceeded",
      "practice_manual_retry_limit_exceeded",
    ].includes(databaseMessage)
  ) {
    return new PublicAppError(
      "data_rate_limited",
      "The safe automatic retry limit has been reached. The work is preserved and now needs teacher review.",
    );
  }
  if (code === "PT429") {
    return new PublicAppError(
      "data_rate_limited",
      "This request limit has been reached. Wait a moment, then try again.",
    );
  }
  if (code === "22023" && databaseMessage === "writing_text_too_long") {
    return new PublicAppError(
      "data_invalid_request",
      "Writing can be up to 4,000 characters. Shorten it and try again.",
    );
  }
  if (code === "22023" && databaseMessage === "writing_too_many_units") {
    return new PublicAppError(
      "data_invalid_request",
      "Writing can contain up to 40 sentences or paragraphs. Combine or shorten it and try again.",
    );
  }
  if (code === "22023" && databaseMessage === "teacher_task_prompt_too_long") {
    return new PublicAppError(
      "data_invalid_request",
      "Writing task text can be up to 4,000 characters. Shorten it and try again.",
    );
  }
  if (code === "22023" || code === "23514" || code === "22P02") {
    return new PublicAppError(
      "data_invalid_request",
      "Some information was invalid. Review it and try again.",
    );
  }
  if (code === "P0002" || code === "02000") {
    return new PublicAppError(
      "data_not_found",
      "This item is no longer available. Refresh and try again.",
    );
  }
  if (
    code === "23505" ||
    code === "40001" ||
    code === "40P01" ||
    code === "PT412"
  ) {
    return new PublicAppError(
      "data_conflict",
      "This information changed while you were working. Refresh and try again.",
    );
  }
  if (code === "55000") {
    return new PublicAppError(
      "data_conflict",
      "This item is not editable in its current state. Refresh and review its latest status.",
    );
  }
  return new PublicAppError("data_request_failed", fallback);
}

export async function callApiRpc<T>(
  functionName: string,
  args: Record<string, unknown> = {},
  fallback = "The request could not be completed. Please try again.",
): Promise<T> {
  const client = requireClient();
  const rpcClient = client as unknown as {
    rpc: (
      name: string,
      parameters: Record<string, unknown>,
    ) => Promise<ApiRpcResult<T>>;
  };
  const { data, error } = await rpcClient.rpc(functionName, args);
  if (error) throw toPublicDataError(error, fallback);
  return data as T;
}

export function parseApiArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value as T[];
}

export function parseApiRecord<T extends object>(
  value: unknown,
  label: string,
): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value as T;
}

export function parseApiPage<T>(value: unknown, label: string): ApiPage<T> {
  const page = parseApiRecord<Partial<ApiPage<T>>>(value, label);
  if (
    page.schema_version !== 1 ||
    !Array.isArray(page.items) ||
    typeof page.total_count !== "number" ||
    !Number.isSafeInteger(page.total_count) ||
    page.total_count < 0 ||
    typeof page.returned_count !== "number" ||
    page.returned_count !== page.items.length ||
    typeof page.page_size !== "number" ||
    !Number.isSafeInteger(page.page_size) ||
    page.page_size < 1 ||
    typeof page.has_more !== "boolean" ||
    (page.has_more && page.next_cursor == null && page.next_offset == null)
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return page as ApiPage<T>;
}
