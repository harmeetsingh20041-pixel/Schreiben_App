import { PublicAppError } from "@/lib/appError";
import { callApiRpc, parseApiArray } from "@/services/apiFacade";

export type TeacherAccessStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "disabled";

export interface TeacherAccessCursor {
  updated_at: string;
  id: string;
}

export interface MyTeacherAccessRequest {
  request_id: string;
  request_status: TeacherAccessStatus;
  request_revision: number;
  requested_at: string;
  decided_at: string | null;
  approved_max_workspaces: number | null;
  entitlement_active: boolean;
  entitlement_revision: number | null;
  entitlement_max_workspaces: number | null;
  updated_at: string;
}

export interface TeacherAccessInventoryItem {
  request_id: string | null;
  page_cursor_id: string;
  applicant_user_id: string;
  applicant_name: string | null;
  applicant_email: string | null;
  request_status: TeacherAccessStatus;
  request_revision: number | null;
  requested_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  approved_max_workspaces: number | null;
  entitlement_active: boolean;
  entitlement_revision: number | null;
  entitlement_max_workspaces: number | null;
  privileged_workspace_count: number;
  updated_at: string;
}

export interface TeacherAccessInventoryPage {
  items: TeacherAccessInventoryItem[];
  page_size: number;
  has_more: boolean;
  next_cursor: TeacherAccessCursor | null;
}

export interface TeacherOnboardingHealth {
  pending_request_count: number;
  approved_request_count: number;
  rejected_request_count: number;
  disabled_request_count: number;
  active_entitlement_count: number;
  inactive_or_expired_entitlement_count: number;
  privileged_membership_count: number;
  owned_workspace_count: number;
  owned_workspace_without_active_access_count: number;
  privileged_membership_without_active_access_count: number;
  generated_at: string;
}

export interface TeacherAccessDecisionResult {
  request_id: string;
  applicant_user_id: string;
  request_status: "approved" | "rejected";
  request_revision: number;
  entitlement_revision: number | null;
  entitlement_max_workspaces: number | null;
  decided_at: string;
}

export interface TeacherStartDestination {
  workspace_id: string;
  membership_id: string;
  needs_first_class: boolean;
}

export interface TeacherWorkspaceLimitResult {
  updated_user_id: string;
  entitlement_revision: number;
  entitlement_max_workspaces: number;
  request_revision: number | null;
  current_privileged_workspace_count: number;
  updated_at: string;
}

export interface TeacherAccessDisableResult {
  disabled_user_id: string;
  entitlement_revision: number;
  request_revision: number | null;
  transferred_workspace_count: number;
  removed_privileged_membership_count: number;
  disabled_at: string;
}

const statuses = new Set<TeacherAccessStatus>([
  "pending",
  "approved",
  "rejected",
  "disabled",
]);

function invalid(label: string): never {
  throw new PublicAppError(
    "data_invalid_response",
    `${label} returned an invalid response. Please refresh and try again.`,
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(label);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) return invalid(label);
  return value;
}

function nullableText(value: unknown, label: string) {
  if (value === null) return null;
  return text(value, label);
}

function timestamp(value: unknown, label: string) {
  const parsed = text(value, label);
  if (!Number.isFinite(Date.parse(parsed))) return invalid(label);
  return parsed;
}

function nullableTimestamp(value: unknown, label: string) {
  if (value === null) return null;
  return timestamp(value, label);
}

function integer(
  value: unknown,
  label: string,
  options: { minimum?: number; maximum?: number } = {},
) {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(label);
  }
  return value;
}

function nullableInteger(
  value: unknown,
  label: string,
  options: { minimum?: number; maximum?: number } = {},
) {
  if (value === null) return null;
  return integer(value, label, options);
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") return invalid(label);
  return value;
}

function status(value: unknown, label: string): TeacherAccessStatus {
  if (
    typeof value !== "string" ||
    !statuses.has(value as TeacherAccessStatus)
  ) {
    return invalid(label);
  }
  return value as TeacherAccessStatus;
}

function oneRow(value: unknown, label: string) {
  const rows = parseApiArray<unknown>(value, label);
  if (rows.length !== 1) return invalid(label);
  return rows[0];
}

function parseMyRequest(value: unknown): MyTeacherAccessRequest {
  const label = "Teacher access status";
  const row = record(value, label);
  const parsed: MyTeacherAccessRequest = {
    request_id: text(row.request_id, label),
    request_status: status(row.request_status, label),
    request_revision: integer(row.request_revision, label, { minimum: 1 }),
    requested_at: timestamp(row.requested_at, label),
    decided_at: nullableTimestamp(row.decided_at, label),
    approved_max_workspaces: nullableInteger(
      row.approved_max_workspaces,
      label,
      { minimum: 1, maximum: 100 },
    ),
    entitlement_active: boolean(row.entitlement_active, label),
    entitlement_revision: nullableInteger(row.entitlement_revision, label, {
      minimum: 1,
    }),
    entitlement_max_workspaces: nullableInteger(
      row.entitlement_max_workspaces,
      label,
      { minimum: 1, maximum: 100 },
    ),
    updated_at: timestamp(row.updated_at, label),
  };

  if (
    (parsed.request_status === "pending" && parsed.decided_at !== null) ||
    (parsed.request_status !== "pending" && parsed.decided_at === null) ||
    (parsed.entitlement_active && parsed.entitlement_revision === null)
  ) {
    return invalid(label);
  }
  return parsed;
}

function parseInventoryItem(value: unknown): TeacherAccessInventoryItem {
  const label = "Teacher access inventory";
  const row = record(value, label);
  const parsed: TeacherAccessInventoryItem = {
    request_id: nullableText(row.request_id, label),
    page_cursor_id: text(row.page_cursor_id, label),
    applicant_user_id: text(row.applicant_user_id, label),
    applicant_name: nullableText(row.applicant_name, label),
    applicant_email: nullableText(row.applicant_email, label),
    request_status: status(row.request_status, label),
    request_revision: nullableInteger(row.request_revision, label, {
      minimum: 1,
    }),
    requested_at: nullableTimestamp(row.requested_at, label),
    decided_at: nullableTimestamp(row.decided_at, label),
    decided_by: nullableText(row.decided_by, label),
    approved_max_workspaces: nullableInteger(
      row.approved_max_workspaces,
      label,
      { minimum: 1, maximum: 100 },
    ),
    entitlement_active: boolean(row.entitlement_active, label),
    entitlement_revision: nullableInteger(row.entitlement_revision, label, {
      minimum: 1,
    }),
    entitlement_max_workspaces: nullableInteger(
      row.entitlement_max_workspaces,
      label,
      { minimum: 1, maximum: 100 },
    ),
    privileged_workspace_count: integer(row.privileged_workspace_count, label),
    updated_at: timestamp(row.updated_at, label),
  };

  if (
    (parsed.request_id === null) !== (parsed.request_revision === null) ||
    (parsed.entitlement_active && parsed.entitlement_revision === null)
  ) {
    return invalid(label);
  }
  return parsed;
}

function parseHealth(value: unknown): TeacherOnboardingHealth {
  const label = "Teacher onboarding health";
  const row = record(oneRow(value, label), label);
  return {
    pending_request_count: integer(row.pending_request_count, label),
    approved_request_count: integer(row.approved_request_count, label),
    rejected_request_count: integer(row.rejected_request_count, label),
    disabled_request_count: integer(row.disabled_request_count, label),
    active_entitlement_count: integer(row.active_entitlement_count, label),
    inactive_or_expired_entitlement_count: integer(
      row.inactive_or_expired_entitlement_count,
      label,
    ),
    privileged_membership_count: integer(
      row.privileged_membership_count,
      label,
    ),
    owned_workspace_count: integer(row.owned_workspace_count, label),
    owned_workspace_without_active_access_count: integer(
      row.owned_workspace_without_active_access_count,
      label,
    ),
    privileged_membership_without_active_access_count: integer(
      row.privileged_membership_without_active_access_count,
      label,
    ),
    generated_at: timestamp(row.generated_at, label),
  };
}

export async function getMyTeacherAccessRequest() {
  const value = await callApiRpc<unknown>(
    "get_my_teacher_access_request",
    {},
    "We couldn't load your teacher-access status.",
  );
  const rows = parseApiArray<unknown>(value, "Teacher access status");
  if (rows.length > 1) return invalid("Teacher access status");
  return rows.length === 0 ? null : parseMyRequest(rows[0]);
}

export async function getMyTeacherStart(): Promise<TeacherStartDestination | null> {
  const label = "Teacher start";
  const value = await callApiRpc<unknown>(
    "get_my_teacher_start",
    {},
    "We couldn't prepare your first class.",
  );
  const rows = parseApiArray<unknown>(value, label);
  if (rows.length > 1) return invalid(label);
  if (rows.length === 0) return null;
  const row = record(rows[0], label);
  return {
    workspace_id: text(row.workspace_id, label),
    membership_id: text(row.membership_id, label),
    needs_first_class: boolean(row.needs_first_class, label),
  };
}

export async function requestTeacherAccess(expectedRevision = 0) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new PublicAppError(
      "data_invalid_request",
      "Refresh your teacher-access status and try again.",
    );
  }
  const value = await callApiRpc<unknown>(
    "request_teacher_access",
    { expected_revision: expectedRevision },
    "We couldn't send your teacher-access request.",
  );
  const row = record(
    oneRow(value, "Teacher access request"),
    "Teacher access request",
  );
  return parseMyRequest({
    ...row,
    decided_at: null,
    approved_max_workspaces: null,
    entitlement_active: false,
    entitlement_revision: null,
    entitlement_max_workspaces: null,
  });
}

export async function listTeacherAccessRequests(
  input: {
    status?: TeacherAccessStatus | null;
    pageSize?: number;
    cursor?: TeacherAccessCursor | null;
  } = {},
): Promise<TeacherAccessInventoryPage> {
  const pageSize = input.pageSize ?? 25;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 99) {
    throw new PublicAppError(
      "data_invalid_request",
      "Choose a teacher list page size between 1 and 99.",
    );
  }

  const value = await callApiRpc<unknown>(
    "list_teacher_access_requests",
    {
      target_status: input.status ?? null,
      requested_page_size: pageSize + 1,
      cursor_updated_at: input.cursor?.updated_at ?? null,
      cursor_id: input.cursor?.id ?? null,
    },
    "We couldn't load teacher access requests.",
  );
  const rows = parseApiArray<unknown>(value, "Teacher access inventory").map(
    parseInventoryItem,
  );
  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize);
  const lastItem = items.at(-1) ?? null;
  return {
    items,
    page_size: pageSize,
    has_more: hasMore,
    next_cursor:
      hasMore && lastItem
        ? { updated_at: lastItem.updated_at, id: lastItem.page_cursor_id }
        : null,
  };
}

export async function decideTeacherAccess(input: {
  requestId: string;
  decision: "approved" | "rejected";
  expectedRevision: number;
  workspaceLimit?: number;
}): Promise<TeacherAccessDecisionResult> {
  const value = await callApiRpc<unknown>(
    "decide_teacher_access",
    {
      target_request_id: input.requestId,
      decision: input.decision,
      expected_revision: input.expectedRevision,
      approved_workspace_limit: input.workspaceLimit ?? 1,
    },
    "We couldn't update this teacher-access request.",
  );
  const label = "Teacher access decision";
  const row = record(oneRow(value, label), label);
  const result: TeacherAccessDecisionResult = {
    request_id: text(row.request_id, label),
    applicant_user_id: text(row.applicant_user_id, label),
    request_status:
      row.request_status === "approved" || row.request_status === "rejected"
        ? row.request_status
        : invalid(label),
    request_revision: integer(row.request_revision, label, { minimum: 1 }),
    entitlement_revision: nullableInteger(row.entitlement_revision, label, {
      minimum: 1,
    }),
    entitlement_max_workspaces: nullableInteger(
      row.entitlement_max_workspaces,
      label,
      { minimum: 1, maximum: 100 },
    ),
    decided_at: timestamp(row.decided_at, label),
  };
  if (
    result.request_status === "approved" &&
    (result.entitlement_revision === null ||
      result.entitlement_max_workspaces === null)
  ) {
    return invalid(label);
  }
  return result;
}

export async function updateTeacherWorkspaceLimit(input: {
  userId: string;
  expectedEntitlementRevision: number;
  workspaceLimit: number;
}): Promise<TeacherWorkspaceLimitResult> {
  const value = await callApiRpc<unknown>(
    "update_teacher_workspace_limit",
    {
      target_teacher_user_id: input.userId,
      expected_entitlement_revision: input.expectedEntitlementRevision,
      new_workspace_limit: input.workspaceLimit,
    },
    "We couldn't update this teacher's workspace limit.",
  );
  const label = "Teacher workspace limit";
  const row = record(oneRow(value, label), label);
  return {
    updated_user_id: text(row.updated_user_id, label),
    entitlement_revision: integer(row.entitlement_revision, label, {
      minimum: 1,
    }),
    entitlement_max_workspaces: integer(row.entitlement_max_workspaces, label, {
      minimum: 1,
      maximum: 100,
    }),
    request_revision: nullableInteger(row.request_revision, label, {
      minimum: 1,
    }),
    current_privileged_workspace_count: integer(
      row.current_privileged_workspace_count,
      label,
    ),
    updated_at: timestamp(row.updated_at, label),
  };
}

export async function disableTeacherAccess(input: {
  userId: string;
  expectedEntitlementRevision: number;
}): Promise<TeacherAccessDisableResult> {
  const value = await callApiRpc<unknown>(
    "disable_teacher_access",
    {
      target_teacher_user_id: input.userId,
      expected_entitlement_revision: input.expectedEntitlementRevision,
    },
    "We couldn't disable this teacher's access.",
  );
  const label = "Teacher access disable";
  const row = record(oneRow(value, label), label);
  return {
    disabled_user_id: text(row.disabled_user_id, label),
    entitlement_revision: integer(row.entitlement_revision, label, {
      minimum: 1,
    }),
    request_revision: nullableInteger(row.request_revision, label, {
      minimum: 1,
    }),
    transferred_workspace_count: integer(
      row.transferred_workspace_count,
      label,
    ),
    removed_privileged_membership_count: integer(
      row.removed_privileged_membership_count,
      label,
    ),
    disabled_at: timestamp(row.disabled_at, label),
  };
}

export async function getTeacherOnboardingHealth() {
  return parseHealth(
    await callApiRpc<unknown>(
      "get_teacher_onboarding_health",
      {},
      "We couldn't load teacher-onboarding health.",
    ),
  );
}
