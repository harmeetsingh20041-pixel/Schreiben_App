import { PublicAppError } from "@/lib/appError";
import { callApiRpc, parseApiArray, parseApiPage } from "@/services/apiFacade";

export type BatchWritingLimitRequestStatus =
  | "pending"
  | "approved"
  | "rejected";

export type BatchWritingLimitRequestStatusFilter =
  | BatchWritingLimitRequestStatus
  | "all";

export interface BatchWritingLimitRequestCursor {
  updated_at: string;
  id: string;
}

export interface BatchWritingLimitRequestItem {
  request_id: string;
  workspace_id: string;
  workspace_name: string;
  batch_id: string;
  batch_name: string;
  batch_active: boolean;
  requested_by: string;
  requester_name: string | null;
  requester_email: string | null;
  current_writing_daily_limit: number;
  requested_writing_daily_limit: number;
  request_status: BatchWritingLimitRequestStatus;
  request_revision: number;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  updated_at: string;
}

export interface BatchWritingLimitRequestPage {
  schema_version: 1;
  items: BatchWritingLimitRequestItem[];
  total_count: number;
  returned_count: number;
  page_size: number;
  has_more: boolean;
  next_cursor: BatchWritingLimitRequestCursor | null;
}

export interface BatchWritingLimitDecisionResult {
  request_id: string;
  workspace_id: string;
  batch_id: string;
  request_status: "approved" | "rejected";
  request_revision: number;
  previous_writing_daily_limit: number;
  current_writing_daily_limit: number;
  requested_writing_daily_limit: number;
  decided_at: string;
  decided_by: string;
}

type UnknownRecord = Record<string, unknown>;

const requestStatuses = new Set<BatchWritingLimitRequestStatus>([
  "pending",
  "approved",
  "rejected",
]);

function invalid(label: string): never {
  throw new PublicAppError(
    "data_invalid_response",
    `${label} returned an invalid response. Please refresh and try again.`,
  );
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(label);
  }
  return value as UnknownRecord;
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) return invalid(label);
  return value;
}

function nullableText(value: unknown, label: string) {
  if (value === null) return null;
  return requiredText(value, label);
}

function timestamp(value: unknown, label: string) {
  const parsed = requiredText(value, label);
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
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {},
) {
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

function requestStatus(
  value: unknown,
  label: string,
): BatchWritingLimitRequestStatus {
  if (
    typeof value !== "string" ||
    !requestStatuses.has(value as BatchWritingLimitRequestStatus)
  ) {
    return invalid(label);
  }
  return value as BatchWritingLimitRequestStatus;
}

function parseRequestItem(value: unknown): BatchWritingLimitRequestItem {
  const label = "Daily writing-limit requests";
  const row = record(value, label);
  const status = requestStatus(row.request_status, label);
  const parsed: BatchWritingLimitRequestItem = {
    request_id: requiredText(row.request_id, label),
    workspace_id: requiredText(row.workspace_id, label),
    workspace_name: requiredText(row.workspace_name, label),
    batch_id: requiredText(row.batch_id, label),
    batch_name: requiredText(row.batch_name, label),
    batch_active:
      typeof row.batch_active === "boolean" ? row.batch_active : invalid(label),
    requested_by: requiredText(row.requested_by, label),
    requester_name: nullableText(row.requester_name, label),
    requester_email: nullableText(row.requester_email, label),
    current_writing_daily_limit: integer(
      row.current_writing_daily_limit,
      label,
      { minimum: 1, maximum: 10 },
    ),
    requested_writing_daily_limit: integer(
      row.requested_writing_daily_limit,
      label,
      { minimum: 1, maximum: 10 },
    ),
    request_status: status,
    request_revision: integer(row.request_revision, label, { minimum: 1 }),
    requested_at: timestamp(row.requested_at, label),
    decided_at: nullableTimestamp(row.decided_at, label),
    decided_by: nullableText(row.decided_by, label),
    updated_at: timestamp(row.updated_at, label),
  };

  const pendingDecisionFieldsAreEmpty =
    parsed.decided_at === null && parsed.decided_by === null;
  const decidedFieldsArePresent =
    parsed.decided_at !== null && parsed.decided_by !== null;
  if (
    (status === "pending" && !pendingDecisionFieldsAreEmpty) ||
    (status !== "pending" && !decidedFieldsArePresent)
  ) {
    return invalid(label);
  }
  return parsed;
}

function parseRequestPage(
  value: unknown,
  expectedPageSize: number,
): BatchWritingLimitRequestPage {
  const label = "Daily writing-limit requests";
  const page = parseApiPage<unknown>(value, label);
  const rawCursor = page.next_cursor;
  let nextCursor: BatchWritingLimitRequestCursor | null = null;
  if (rawCursor !== null) {
    const cursor = record(rawCursor, label);
    nextCursor = {
      updated_at: timestamp(cursor.updated_at, label),
      id: requiredText(cursor.id, label),
    };
  }

  const items = page.items.map(parseRequestItem);
  const lastItem = items.at(-1) ?? null;
  if (
    page.page_size !== expectedPageSize ||
    page.total_count < page.returned_count ||
    page.returned_count > page.page_size ||
    page.has_more !== (nextCursor !== null) ||
    (page.has_more &&
      (!lastItem ||
        nextCursor?.id !== lastItem.request_id ||
        nextCursor.updated_at !== lastItem.updated_at))
  ) {
    return invalid(label);
  }

  return {
    schema_version: 1,
    items,
    total_count: page.total_count,
    returned_count: page.returned_count,
    page_size: page.page_size,
    has_more: page.has_more,
    next_cursor: nextCursor,
  };
}

function oneRow(value: unknown, label: string) {
  const rows = parseApiArray<unknown>(value, label);
  if (rows.length !== 1) return invalid(label);
  return record(rows[0], label);
}

export async function listBatchWritingLimitRequests(
  input: {
    status?: BatchWritingLimitRequestStatusFilter;
    pageSize?: number;
    cursor?: BatchWritingLimitRequestCursor | null;
  } = {},
): Promise<BatchWritingLimitRequestPage> {
  const pageSize = input.pageSize ?? 25;
  const status = input.status ?? "pending";
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new PublicAppError(
      "data_invalid_request",
      "Choose a writing-limit request page size between 1 and 100.",
    );
  }
  if (
    status !== "all" &&
    !requestStatuses.has(status as BatchWritingLimitRequestStatus)
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "Choose a valid writing-limit request status.",
    );
  }
  if (
    input.cursor &&
    (!input.cursor.id.trim() ||
      !Number.isFinite(Date.parse(input.cursor.updated_at)))
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "Refresh the writing-limit request list and try again.",
    );
  }

  return parseRequestPage(
    await callApiRpc<unknown>(
      "list_batch_writing_limit_requests",
      {
        status,
        page_size: pageSize,
        cursor_updated_at: input.cursor?.updated_at ?? null,
        cursor_id: input.cursor?.id ?? null,
      },
      "Daily writing-limit requests could not be loaded.",
    ),
    pageSize,
  );
}

export async function decideBatchWritingLimit(input: {
  requestId: string;
  decision: "approved" | "rejected";
  expectedRevision: number;
}): Promise<BatchWritingLimitDecisionResult> {
  if (
    !input.requestId.trim() ||
    (input.decision !== "approved" && input.decision !== "rejected") ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "Refresh the writing-limit request and try again.",
    );
  }

  const label = "Daily writing-limit decision";
  const row = oneRow(
    await callApiRpc<unknown>(
      "decide_batch_writing_limit",
      {
        request_id: input.requestId,
        decision: input.decision,
        expected_revision: input.expectedRevision,
      },
      "The daily writing-limit request could not be updated.",
    ),
    label,
  );
  const status = requestStatus(row.request_status, label);
  if (status === "pending") return invalid(label);

  const result: BatchWritingLimitDecisionResult = {
    request_id: requiredText(row.request_id, label),
    workspace_id: requiredText(row.workspace_id, label),
    batch_id: requiredText(row.batch_id, label),
    request_status: status,
    request_revision: integer(row.request_revision, label, { minimum: 1 }),
    previous_writing_daily_limit: integer(
      row.previous_writing_daily_limit,
      label,
      { minimum: 1, maximum: 10 },
    ),
    current_writing_daily_limit: integer(
      row.current_writing_daily_limit,
      label,
      { minimum: 1, maximum: 10 },
    ),
    requested_writing_daily_limit: integer(
      row.requested_writing_daily_limit,
      label,
      { minimum: 1, maximum: 10 },
    ),
    decided_at: timestamp(row.decided_at, label),
    decided_by: requiredText(row.decided_by, label),
  };

  if (
    result.request_id !== input.requestId ||
    result.request_status !== input.decision ||
    (result.request_status === "approved" &&
      result.current_writing_daily_limit !==
        result.requested_writing_daily_limit) ||
    (result.request_status === "rejected" &&
      result.current_writing_daily_limit !==
        result.previous_writing_daily_limit)
  ) {
    return invalid(label);
  }
  return result;
}
