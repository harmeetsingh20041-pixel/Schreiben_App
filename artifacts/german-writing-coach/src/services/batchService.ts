import {
  callApiRpc,
  type ApiKeysetCursor,
  type ApiPage,
  parseApiArray,
  parseApiPage,
  parseApiRecord,
} from "@/services/apiFacade";
import { PublicAppError } from "@/lib/appError";
import type { WorkspaceLevel } from "@/lib/workspaceData";

const BATCH_PAGE_SIZE = 100;

export type WorkspaceBatchStatusFilter = "active" | "inactive" | "all";
export interface WorkspaceBatchCursor {
  created_at: string;
  id: string;
}

export interface WorkspaceBatchPageInput {
  workspaceId: string;
  status: WorkspaceBatchStatusFilter;
  level: WorkspaceLevel | null;
  pageSize: number;
  cursor: WorkspaceBatchCursor | null;
}

export interface WorkspaceBatchPage extends ApiPage<WorkspaceBatch> {
  unfiltered_total_count: number;
}

export interface WorkspaceBatchOption {
  id: string;
  name: string;
  level: WorkspaceLevel;
  is_active: boolean;
}

export interface WorkspaceBatchOptionCursor {
  created_at: string;
  id: string;
}

export interface WorkspaceBatchOptionsPageInput {
  workspaceId: string;
  pageSize: number;
  cursor: WorkspaceBatchOptionCursor | null;
  search: string;
}

export interface WorkspaceBatchOptionsPage extends ApiPage<WorkspaceBatchOption> {
  unfiltered_total_count: number;
}

export interface WorkspaceBatch {
  id: string;
  workspace_id: string;
  name: string;
  level: WorkspaceLevel;
  description: string | null;
  is_active: boolean;
  join_code: string;
  join_code_enabled: boolean;
  join_requires_approval: boolean;
  feedback_mode: BatchFeedbackMode;
  feedback_delay_min_minutes: number;
  feedback_delay_max_minutes: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  student_count: number;
  submission_count: number;
  current_writing_daily_limit: number;
  pending_writing_limit_request_id: string | null;
  pending_writing_limit_request_status: "pending" | null;
  pending_writing_daily_limit: number | null;
  pending_writing_limit_request_revision: number | null;
}

export interface BatchWritingLimitRequestResult {
  request_id: string;
  workspace_id: string;
  batch_id: string;
  current_writing_daily_limit: number;
  requested_writing_daily_limit: number;
  request_status: "pending";
  request_revision: number;
  requested_at: string;
  updated_at: string;
}

export type BatchFeedbackMode =
  | "immediate"
  | "automatic_delayed"
  | "teacher_review_only";

const workspaceLevels = new Set<WorkspaceLevel>(["A1", "A2", "B1", "B2"]);

function isWritingLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 10
  );
}

function parseWorkspaceBatch(value: unknown): WorkspaceBatch {
  const item = parseApiRecord<Record<string, unknown>>(value, "Class");
  const pendingValues = [
    item.pending_writing_limit_request_id,
    item.pending_writing_limit_request_status,
    item.pending_writing_daily_limit,
    item.pending_writing_limit_request_revision,
  ];
  const hasPendingRequest = pendingValues.every((entry) => entry !== null);
  const hasNoPendingRequest = pendingValues.every((entry) => entry === null);

  if (
    !isWritingLimit(item.current_writing_daily_limit) ||
    (!hasPendingRequest && !hasNoPendingRequest) ||
    (hasPendingRequest &&
      (typeof item.pending_writing_limit_request_id !== "string" ||
        item.pending_writing_limit_request_id.trim().length === 0 ||
        item.pending_writing_limit_request_status !== "pending" ||
        !isWritingLimit(item.pending_writing_daily_limit) ||
        typeof item.pending_writing_limit_request_revision !== "number" ||
        !Number.isSafeInteger(item.pending_writing_limit_request_revision) ||
        item.pending_writing_limit_request_revision < 1))
  ) {
    parseApiRecord(null, "Class");
  }

  return item as unknown as WorkspaceBatch;
}

function parseWritingLimitRequest(
  value: unknown,
  expectedWorkspaceId: string,
  expectedBatchId: string,
): BatchWritingLimitRequestResult {
  const item = parseApiRecord<Record<string, unknown>>(
    value,
    "Writing limit request",
  );
  if (
    typeof item.request_id !== "string" ||
    item.request_id.trim().length === 0 ||
    item.workspace_id !== expectedWorkspaceId ||
    item.batch_id !== expectedBatchId ||
    !isWritingLimit(item.current_writing_daily_limit) ||
    !isWritingLimit(item.requested_writing_daily_limit) ||
    item.request_status !== "pending" ||
    typeof item.request_revision !== "number" ||
    !Number.isSafeInteger(item.request_revision) ||
    item.request_revision < 1 ||
    typeof item.requested_at !== "string" ||
    !Number.isFinite(Date.parse(item.requested_at)) ||
    typeof item.updated_at !== "string" ||
    !Number.isFinite(Date.parse(item.updated_at))
  ) {
    parseApiRecord(null, "Writing limit request");
  }
  return item as unknown as BatchWritingLimitRequestResult;
}

export async function listWorkspaceBatchOptionsPage(
  input: WorkspaceBatchOptionsPageInput,
): Promise<WorkspaceBatchOptionsPage> {
  if (
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > 100 ||
    input.search.trim().length > 160 ||
    (input.cursor != null &&
      (input.cursor.created_at.trim().length === 0 ||
        input.cursor.id.trim().length === 0))
  ) {
    parseApiPage(null, "Class options");
  }
  const value = await callApiRpc<unknown>(
    "list_workspace_batch_options",
    {
      target_workspace_id: input.workspaceId,
      requested_page_size: input.pageSize,
      cursor_created_at: input.cursor?.created_at ?? null,
      cursor_id: input.cursor?.id ?? null,
      target_search: input.search.trim(),
    },
    "Class options could not be loaded. Please try again.",
  );
  const page = parseApiPage<unknown>(value, "Class options");
  const record = value as Record<string, unknown>;
  const unfilteredTotal = record.unfiltered_total_count;
  if (
    typeof unfilteredTotal !== "number" ||
    !Number.isSafeInteger(unfilteredTotal) ||
    unfilteredTotal < page.total_count ||
    page.total_count < page.returned_count ||
    page.page_size !== input.pageSize ||
    page.returned_count > page.page_size ||
    (page.has_more &&
      (page.total_count <= page.returned_count ||
        page.returned_count !== page.page_size ||
        typeof page.next_cursor?.created_at !== "string" ||
        page.next_cursor.created_at.trim().length === 0 ||
        typeof page.next_cursor.id !== "string" ||
        page.next_cursor.id.trim().length === 0)) ||
    (!page.has_more && page.next_cursor !== null)
  ) {
    parseApiPage(null, "Class options");
  }

  const allowedKeys = new Set(["id", "name", "level", "is_active"]);
  const seenIds = new Set<string>();
  const items = page.items.map((item) => {
    const option = parseApiRecord<Record<string, unknown>>(
      item,
      "Class option",
    );
    if (
      Object.keys(option).some((key) => !allowedKeys.has(key)) ||
      Object.keys(option).length !== allowedKeys.size ||
      typeof option.id !== "string" ||
      option.id.trim().length === 0 ||
      seenIds.has(option.id) ||
      typeof option.name !== "string" ||
      option.name.trim().length === 0 ||
      typeof option.level !== "string" ||
      !workspaceLevels.has(option.level as WorkspaceLevel) ||
      typeof option.is_active !== "boolean"
    ) {
      parseApiRecord(null, "Class option");
    }
    seenIds.add(option.id as string);
    return {
      id: option.id as string,
      name: option.name as string,
      level: option.level as WorkspaceLevel,
      is_active: option.is_active as boolean,
    };
  });

  return {
    ...page,
    items,
    unfiltered_total_count: unfilteredTotal as number,
  };
}

export interface BatchInput {
  name: string;
  level: WorkspaceLevel;
  description?: string | null;
  is_active?: boolean;
  join_code_enabled?: boolean;
  feedback_mode?: BatchFeedbackMode;
  feedback_delay_min_minutes?: number;
  feedback_delay_max_minutes?: number;
}

function batchArgs(input: BatchInput) {
  return {
    batch_name: input.name,
    batch_level: input.level,
    batch_description: input.description ?? null,
    batch_is_active: input.is_active ?? true,
    batch_join_code_enabled: input.join_code_enabled ?? true,
    batch_feedback_mode: input.feedback_mode ?? "immediate",
    batch_feedback_delay_min_minutes: input.feedback_delay_min_minutes ?? 15,
    batch_feedback_delay_max_minutes: input.feedback_delay_max_minutes ?? 180,
  };
}

export async function listWorkspaceBatchesPage(
  input: WorkspaceBatchPageInput,
): Promise<WorkspaceBatchPage> {
  const value: unknown = await callApiRpc<unknown>(
    "list_workspace_batches_page",
    {
      target_workspace_id: input.workspaceId,
      requested_page_size: input.pageSize,
      cursor_created_at: input.cursor?.created_at ?? null,
      cursor_id: input.cursor?.id ?? null,
      target_status: input.status,
      target_level: input.level,
    },
    "Classes could not be loaded. Please try again.",
  );
  const rawPage = parseApiPage<unknown>(value, "Classes");
  const page: ApiPage<WorkspaceBatch> = {
    ...rawPage,
    items: rawPage.items.map(parseWorkspaceBatch),
  };
  const unfilteredTotal =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { unfiltered_total_count?: unknown }).unfiltered_total_count
      : null;
  if (
    typeof unfilteredTotal !== "number" ||
    !Number.isSafeInteger(unfilteredTotal) ||
    unfilteredTotal < page.total_count
  ) {
    parseApiPage(null, "Classes");
  }
  if (page.page_size !== input.pageSize) parseApiPage(null, "Classes");
  if (
    page.has_more &&
    (!page.next_cursor?.created_at || !page.next_cursor.id)
  ) {
    parseApiPage(null, "Classes");
  }
  return { ...page, unfiltered_total_count: unfilteredTotal as number };
}

export async function listWorkspaceBatches(
  workspaceId: string,
): Promise<WorkspaceBatch[]> {
  const batches: WorkspaceBatch[] = [];
  let cursor: { created_at: string; id: string } | null = null;

  do {
    const value: unknown = await callApiRpc<unknown>(
      "list_workspace_batches_page",
      {
        target_workspace_id: workspaceId,
        requested_page_size: BATCH_PAGE_SIZE,
        cursor_created_at: cursor?.created_at ?? null,
        cursor_id: cursor?.id ?? null,
        target_status: "all",
        target_level: null,
      },
      "Classes could not be loaded. Please try again.",
    );
    const rawPage = parseApiPage<unknown>(value, "Classes");
    const page: ApiPage<WorkspaceBatch> = {
      ...rawPage,
      items: rawPage.items.map(parseWorkspaceBatch),
    };
    batches.push(...page.items);

    if (!page.has_more) break;
    const next: ApiKeysetCursor | null = page.next_cursor;
    if (
      !next ||
      typeof next.created_at !== "string" ||
      typeof next.id !== "string" ||
      (cursor?.created_at === next.created_at && cursor.id === next.id)
    ) {
      parseApiPage(null, "Classes");
    }
    cursor = { created_at: next!.created_at!, id: next!.id };
  } while (cursor);

  return batches;
}

export async function createWorkspaceBatch(
  workspaceId: string,
  _userId: string,
  input: BatchInput,
): Promise<void> {
  const value = await callApiRpc<unknown>(
    "create_workspace_batch",
    { target_workspace_id: workspaceId, ...batchArgs(input) },
    "The class could not be created. Please try again.",
  );
  const rows = parseApiArray<{ batch_id: string }>(value, "Class creation");
  if (!rows[0]?.batch_id) parseApiArray(null, "Class creation");
}

export async function updateWorkspaceBatch(
  workspaceId: string,
  batchId: string,
  input: BatchInput,
): Promise<void> {
  const value = await callApiRpc<unknown>(
    "update_workspace_batch",
    {
      target_workspace_id: workspaceId,
      target_batch_id: batchId,
      ...batchArgs(input),
    },
    "The class could not be updated. Please try again.",
  );
  const rows = parseApiArray<{ batch_id: string }>(value, "Class update");
  if (rows[0]?.batch_id !== batchId) parseApiArray(null, "Class update");
}

export async function rotateBatchJoinCode(batchId: string): Promise<string> {
  const value = await callApiRpc<unknown>(
    "rotate_batch_join_code",
    { target_batch_id: batchId },
    "The class code could not be changed. Please try again.",
  );
  const rows = parseApiArray<unknown>(value, "Class code");
  const row = parseApiRecord<{ batch_id?: unknown; join_code?: unknown }>(
    rows[0],
    "Class code",
  );
  if (row.batch_id !== batchId || typeof row.join_code !== "string") {
    parseApiRecord(null, "Class code");
  }
  return row.join_code as string;
}

export async function setBatchActive(
  workspaceId: string,
  batchId: string,
  isActive: boolean,
): Promise<void> {
  const value = await callApiRpc<unknown>(
    "set_batch_active",
    {
      target_workspace_id: workspaceId,
      target_batch_id: batchId,
      target_is_active: isActive,
    },
    "The class status could not be changed. Please try again.",
  );
  const rows = parseApiArray<{ batch_id: string; is_active: boolean }>(
    value,
    "Class status",
  );
  if (rows[0]?.batch_id !== batchId || rows[0]?.is_active !== isActive) {
    parseApiArray(null, "Class status");
  }
}

export async function requestBatchWritingLimit(
  workspaceId: string,
  batchId: string,
  requestedLimit: number,
  expectedRevision: number,
): Promise<BatchWritingLimitRequestResult> {
  if (
    !workspaceId.trim() ||
    !batchId.trim() ||
    !isWritingLimit(requestedLimit) ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "Choose a daily writing limit from 1 to 10 and try again.",
    );
  }

  const value = await callApiRpc<unknown>(
    "request_batch_writing_limit",
    {
      batch_id: batchId,
      requested_limit: requestedLimit,
      expected_revision: expectedRevision,
    },
    "The writing-limit request could not be sent. Please try again.",
  );
  const rows = parseApiArray<unknown>(value, "Writing limit request");
  if (rows.length !== 1) parseApiArray(null, "Writing limit request");
  return parseWritingLimitRequest(rows[0], workspaceId, batchId);
}
