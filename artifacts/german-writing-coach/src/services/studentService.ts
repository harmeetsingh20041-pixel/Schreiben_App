import {
  callApiRpc,
  type ApiKeysetCursor,
  type ApiPage,
  parseApiArray,
  parseApiPage,
  parseApiRecord,
} from "@/services/apiFacade";
import type { WorkspaceLevel } from "@/lib/workspaceData";
import {
  parseTeacherWeakTopics,
  type TeacherWeakTopic,
} from "@/services/teacherReadModelService";
import { PublicAppError } from "@/lib/appError";

const ROSTER_PAGE_SIZE = 100;
const JOIN_REQUEST_PAGE_SIZE = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WorkspaceStudentCursor {
  created_at: string;
  id: string;
}

export interface JoinRequestCursor {
  requested_at: string;
  id: string;
}

export interface WorkspaceStudentPage extends Omit<
  ApiPage<WorkspaceStudent>,
  "next_cursor"
> {
  next_cursor: WorkspaceStudentCursor | null;
}

export interface BatchJoinRequestPage extends Omit<
  ApiPage<BatchJoinRequest>,
  "next_cursor"
> {
  next_cursor: JoinRequestCursor | null;
}

export interface StudentBatchAssignment {
  id: string;
  workspace_id: string;
  batch_id: string;
  batch_name: string;
  level: WorkspaceLevel;
}

export interface WorkspaceStudent {
  id: string;
  name: string;
  email: string;
  membership_id: string;
  batches: StudentBatchAssignment[];
  total_submissions: number;
  last_active: string;
  weak_topics: TeacherWeakTopic[];
}

interface WorkspaceStudentApiRow extends Omit<
  WorkspaceStudent,
  "last_active" | "weak_topics"
> {
  last_active_at: string | null;
  weak_topics: unknown;
}

export interface BatchJoinRequest {
  id: string;
  workspace_id: string;
  batch_id: string;
  student_id: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  student_name: string;
  student_email: string;
  batch_name: string;
  batch_level: WorkspaceLevel;
}

export function getProminentJoinRequest(
  requests: readonly BatchJoinRequest[],
): BatchJoinRequest | undefined {
  return requests.find(
    (request) =>
      request.status !== "cancelled" && request.status !== "rejected",
  );
}

export interface JoinBatchResult {
  request_id: string;
  workspace_id: string;
  batch_id: string;
  batch_name: string;
  level: WorkspaceLevel;
  status: "pending" | "approved";
  requires_approval: true;
}

function formatActivity(value: string | null) {
  if (!value) return "No submissions yet";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function parseWorkspaceStudentPage(
  value: unknown,
  workspaceId: string,
): WorkspaceStudentPage {
  const page = parseApiPage<WorkspaceStudentApiRow>(value, "Students");
  const next = page.next_cursor;
  if (
    next &&
    (typeof next.created_at !== "string" || typeof next.id !== "string")
  ) {
    parseApiPage(null, "Students");
  }
  return {
    ...page,
    items: page.items.map((student) => ({
      id: student.id,
      name: student.name,
      email: student.email,
      membership_id: student.membership_id,
      batches: student.batches,
      total_submissions: student.total_submissions,
      last_active: formatActivity(student.last_active_at),
      weak_topics: parseTeacherWeakTopics(
        student.weak_topics,
        { workspaceId, studentId: student.id, maxItems: 3 },
        "Students",
      ),
    })),
    next_cursor: next ? { created_at: next.created_at!, id: next.id } : null,
  };
}

export async function listWorkspaceStudentsFilteredPage(input: {
  workspaceId: string;
  search?: string;
  batchId?: string | null;
  level?: WorkspaceLevel | null;
  pageSize?: number;
  cursor?: WorkspaceStudentCursor | null;
}): Promise<WorkspaceStudentPage> {
  const value = await callApiRpc<unknown>(
    "list_workspace_students_filtered_page",
    {
      target_workspace_id: input.workspaceId,
      search_query: input.search?.trim() ?? "",
      target_batch_id: input.batchId ?? null,
      target_level: input.level ?? null,
      requested_page_size: input.pageSize ?? 25,
      cursor_created_at: input.cursor?.created_at ?? null,
      cursor_membership_id: input.cursor?.id ?? null,
    },
    "Students could not be loaded. Please try again.",
  );
  return parseWorkspaceStudentPage(value, input.workspaceId);
}

export async function listMyBatchAssignments(
  studentId: string,
): Promise<StudentBatchAssignment[]> {
  const value = await callApiRpc<unknown>(
    "list_my_batch_assignments",
    { target_student_id: studentId },
    "Your active classes could not be loaded. Please try again.",
  );
  return parseApiArray<StudentBatchAssignment>(value, "Your active classes");
}

export async function listWorkspaceStudents(
  workspaceId: string,
): Promise<WorkspaceStudent[]> {
  const students: WorkspaceStudent[] = [];
  let cursor: { created_at: string; id: string } | null = null;

  do {
    const page = await listWorkspaceStudentsFilteredPage({
      workspaceId,
      pageSize: ROSTER_PAGE_SIZE,
      cursor,
    });
    students.push(...page.items);

    if (!page.has_more) break;
    const next: ApiKeysetCursor | null = page.next_cursor;
    if (
      !next ||
      typeof next.created_at !== "string" ||
      typeof next.id !== "string" ||
      (cursor?.created_at === next.created_at && cursor.id === next.id)
    ) {
      parseApiPage(null, "Students");
    }
    cursor = { created_at: next!.created_at!, id: next!.id };
  } while (cursor);

  return students;
}

export async function getWorkspaceStudentCount(
  workspaceId: string,
): Promise<number> {
  return (
    await listWorkspaceStudentsFilteredPage({
      workspaceId,
      pageSize: 1,
    })
  ).total_count;
}

export async function listWorkspaceJoinRequestsFilteredPage(input: {
  workspaceId: string;
  status?: BatchJoinRequest["status"] | "all";
  search?: string;
  batchId?: string | null;
  pageSize?: number;
  cursor?: JoinRequestCursor | null;
}): Promise<BatchJoinRequestPage> {
  const value = await callApiRpc<unknown>(
    "list_workspace_join_requests_filtered_page",
    {
      target_workspace_id: input.workspaceId,
      target_status: input.status ?? "pending",
      search_query: input.search?.trim() ?? "",
      target_batch_id: input.batchId ?? null,
      requested_page_size: input.pageSize ?? 25,
      cursor_requested_at: input.cursor?.requested_at ?? null,
      cursor_request_id: input.cursor?.id ?? null,
    },
    "Join requests could not be loaded. Please try again.",
  );
  const page = parseApiPage<BatchJoinRequest>(value, "Join requests");
  const next = page.next_cursor;
  if (
    next &&
    (typeof next.requested_at !== "string" || typeof next.id !== "string")
  ) {
    parseApiPage(null, "Join requests");
  }
  return {
    ...page,
    next_cursor: next
      ? { requested_at: next.requested_at!, id: next.id }
      : null,
  };
}

export async function listBatchJoinRequests(
  workspaceId: string,
): Promise<BatchJoinRequest[]> {
  const requests: BatchJoinRequest[] = [];
  let cursor: { requested_at: string; id: string } | null = null;

  do {
    const page = await listWorkspaceJoinRequestsFilteredPage({
      workspaceId,
      status: "all",
      pageSize: JOIN_REQUEST_PAGE_SIZE,
      cursor,
    });
    requests.push(...page.items);
    if (!page.has_more) break;

    const next: ApiKeysetCursor | null = page.next_cursor;
    if (
      !next ||
      typeof next.requested_at !== "string" ||
      typeof next.id !== "string" ||
      (cursor?.requested_at === next.requested_at && cursor.id === next.id)
    ) {
      parseApiPage(null, "Join requests");
    }
    cursor = { requested_at: next!.requested_at!, id: next!.id };
  } while (cursor);

  return requests;
}

export async function listMyBatchJoinRequests(
  studentId: string,
): Promise<BatchJoinRequest[]> {
  const value = await callApiRpc<unknown>(
    "list_my_batch_join_requests",
    { target_student_id: studentId },
    "Your join requests could not be loaded. Please try again.",
  );
  return parseApiArray<BatchJoinRequest>(value, "Your join requests");
}

export function parseJoinBatchResult(value: unknown): JoinBatchResult {
  const rows = parseApiArray<unknown>(value, "Class join request");
  if (rows.length === 0) {
    throw new PublicAppError(
      "data_not_found",
      "This class code is invalid, inactive, or no longer available.",
    );
  }
  if (rows.length !== 1) {
    parseApiArray(null, "Class join request");
  }
  const result = parseApiRecord<Record<string, unknown>>(
    rows[0],
    "Class join request",
  );
  if (
    typeof result.request_id !== "string" ||
    !UUID_PATTERN.test(result.request_id) ||
    typeof result.workspace_id !== "string" ||
    !UUID_PATTERN.test(result.workspace_id) ||
    typeof result.batch_id !== "string" ||
    !UUID_PATTERN.test(result.batch_id) ||
    typeof result.batch_name !== "string" ||
    result.batch_name.trim().length === 0 ||
    result.batch_name.length > 160 ||
    typeof result.level !== "string" ||
    !["A1", "A2", "B1", "B2"].includes(result.level) ||
    typeof result.status !== "string" ||
    !["pending", "approved"].includes(result.status) ||
    result.requires_approval !== true
  ) {
    parseApiRecord(null, "Class join request");
  }
  return result as unknown as JoinBatchResult;
}

export async function requestJoinBatchByCode(
  joinCode: string,
): Promise<JoinBatchResult> {
  const value = await callApiRpc<unknown>(
    "request_batch_join",
    { code: joinCode },
    "The class code could not be submitted. Check it and try again.",
  );
  return parseJoinBatchResult(value);
}

export async function approveBatchJoinRequest(requestId: string) {
  const value = await callApiRpc<unknown>(
    "decide_batch_join",
    { join_request_id: requestId, decision: "approved" },
    "The join request could not be approved. Please refresh and try again.",
  );
  const rows = parseApiArray<{ request_id: string; status: string }>(
    value,
    "Join approval",
  );
  if (rows[0]?.request_id !== requestId || rows[0]?.status !== "approved") {
    parseApiArray(null, "Join approval");
  }
}

export async function rejectBatchJoinRequest(requestId: string) {
  const value = await callApiRpc<unknown>(
    "decide_batch_join",
    { join_request_id: requestId, decision: "rejected" },
    "The join request could not be rejected. Please refresh and try again.",
  );
  const rows = parseApiArray<{ request_id: string; status: string }>(
    value,
    "Join rejection",
  );
  if (rows[0]?.request_id !== requestId || rows[0]?.status !== "rejected") {
    parseApiArray(null, "Join rejection");
  }
}

export async function offboardStudent(studentId: string, workspaceId: string) {
  const value = await callApiRpc<unknown>(
    "offboard_student",
    { student_id: studentId, workspace_id: workspaceId },
    "The student could not be removed. Please refresh and try again.",
  );
  const rows = parseApiArray<unknown>(value, "Student removal");
  return parseApiRecord<{
    removed_batch_assignments: number;
    cancelled_join_requests: number;
    membership_removed: boolean;
  }>(rows[0], "Student removal");
}

export async function assignStudentToBatch(
  workspaceId: string,
  studentId: string,
  batchId: string,
) {
  const value = await callApiRpc<unknown>(
    "assign_student_to_batch",
    {
      target_workspace_id: workspaceId,
      target_student_id: studentId,
      target_batch_id: batchId,
    },
    "The student could not be assigned to this class. Please try again.",
  );
  const rows = parseApiArray<{ assignment_id: string }>(
    value,
    "Class assignment",
  );
  if (!rows[0]?.assignment_id) parseApiArray(null, "Class assignment");
}

export async function removeStudentBatchAssignment(
  workspaceId: string,
  assignmentId: string,
) {
  const value = await callApiRpc<unknown>(
    "remove_student_batch_assignment",
    {
      target_workspace_id: workspaceId,
      target_assignment_id: assignmentId,
    },
    "The class assignment could not be removed. Please try again.",
  );
  const rows = parseApiArray<{ assignment_id: string; removed: boolean }>(
    value,
    "Class assignment removal",
  );
  if (rows[0]?.assignment_id !== assignmentId || rows[0]?.removed !== true) {
    parseApiArray(null, "Class assignment removal");
  }
}

export interface ClassTransferResult {
  action_id: string;
  workspace_id: string;
  student_id: string;
  source_assignment_id: string;
  source_batch_id: string;
  target_assignment_id: string;
  target_batch_id: string;
  target_created: boolean;
  source_removed: true;
}

export async function transferStudentClass(
  workspaceId: string,
  studentId: string,
  sourceAssignmentId: string,
  targetBatchId: string,
): Promise<ClassTransferResult> {
  const value = await callApiRpc<unknown>(
    "transfer_student_class",
    {
      target_workspace_id: workspaceId,
      target_student_id: studentId,
      source_assignment_id: sourceAssignmentId,
      target_batch_id: targetBatchId,
    },
    "The student could not be transferred between classes. No partial change was saved.",
  );
  const result = parseApiRecord<Record<string, unknown>>(
    value,
    "Class transfer",
  );
  if (
    result.schema_version !== 1 ||
    result.workspace_id !== workspaceId ||
    result.student_id !== studentId ||
    result.source_assignment_id !== sourceAssignmentId ||
    result.target_batch_id !== targetBatchId ||
    typeof result.action_id !== "string" ||
    typeof result.source_batch_id !== "string" ||
    typeof result.target_assignment_id !== "string" ||
    typeof result.target_created !== "boolean" ||
    result.source_removed !== true
  ) {
    parseApiRecord(null, "Class transfer");
  }
  return result as unknown as ClassTransferResult;
}
