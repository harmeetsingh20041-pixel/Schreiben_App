import {
  callApiRpc,
  type ApiKeysetCursor,
  type ApiPage,
  parseApiArray,
  parseApiPage,
  parseApiRecord,
} from "@/services/apiFacade";
import { PublicAppError } from "@/lib/appError";
import type { QuestionTaskType, WorkspaceLevel } from "@/lib/workspaceData";

const QUESTION_PAGE_SIZE = 100;
const GLOBAL_QUESTION_PAGE_SIZE = 200;
export const STUDENT_ASSIGNED_QUESTION_PAGE_SIZE = 9;
export const TEACHER_QUESTION_BANK_PAGE_SIZE = 12;
export const TEACHER_TASK_PROMPT_MAX_CHARACTERS = 4_000;

export type StudentWritingTaskState =
  | "not_started"
  | "submitted"
  | "queued"
  | "processing"
  | "scheduled"
  | "needs_review"
  | "feedback_held"
  | "feedback_released"
  | "failed";

export interface WorkspaceQuestion {
  id: string;
  workspace_id: string;
  source: "workspace" | "global";
  batch_id: string | null;
  title: string;
  prompt: string;
  level: WorkspaceLevel;
  topic: string;
  task_type: QuestionTaskType;
  expected_word_min: number | null;
  expected_word_max: number | null;
  estimated_minutes: number | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface StudentAssignedQuestion extends WorkspaceQuestion {
  batch_id: string;
  batch_name: string;
  task_state: StudentWritingTaskState;
  latest_submission_id: string | null;
  latest_submission_status: string | null;
  latest_evaluation_status: string | null;
  latest_release_status: string | null;
  latest_release_at: string | null;
  latest_feedback_mode: string | null;
  latest_submission_created_at: string | null;
}

export interface StudentAssignedQuestionCursor {
  created_at: string;
  source: "workspace" | "global";
  id: string;
}

export interface StudentAssignedQuestionPage extends Omit<
  ApiPage<StudentAssignedQuestion>,
  "next_cursor"
> {
  next_cursor: StudentAssignedQuestionCursor | null;
}

export interface StudentAssignedQuestionPageInput {
  studentId: string;
  batchId: string;
  search?: string;
  level?: WorkspaceLevel | null;
  pageSize?: number;
  cursor?: StudentAssignedQuestionCursor | null;
}

export interface TeacherQuestionBankCursor extends ApiKeysetCursor {
  created_at: string;
  sort_rank: number;
}

export interface TeacherQuestionBankPage extends Omit<
  ApiPage<WorkspaceQuestion>,
  "next_cursor"
> {
  available_topics: string[];
  next_cursor: TeacherQuestionBankCursor | null;
}

export interface TeacherQuestionBankPageInput {
  workspaceId: string;
  source: "workspace" | "global";
  search?: string;
  level?: WorkspaceLevel | null;
  topic?: string | null;
  taskType?: QuestionTaskType | null;
  status?: "all" | "active" | "inactive";
  pageSize?: number;
  cursor?: TeacherQuestionBankCursor | null;
}

export interface QuestionInput {
  title: string;
  prompt: string;
  level: WorkspaceLevel;
  topic: string;
  task_type: QuestionTaskType;
  expected_word_min?: number | null;
  expected_word_max?: number | null;
  estimated_minutes?: number | null;
  is_active?: boolean;
}

function questionArgs(input: QuestionInput) {
  if (
    [...input.prompt.trim()].length >
      TEACHER_TASK_PROMPT_MAX_CHARACTERS
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "Writing task text can be up to 4,000 characters. Shorten it and try again.",
    );
  }
  return {
    question_title: input.title,
    question_prompt: input.prompt,
    question_level: input.level,
    question_topic: input.topic,
    question_task_type: input.task_type,
    question_expected_word_min: input.expected_word_min ?? null,
    question_expected_word_max: input.expected_word_max ?? null,
    question_estimated_minutes: input.estimated_minutes ?? null,
    question_is_active: input.is_active ?? true,
  };
}

function invalidTeacherQuestionPage(): never {
  parseApiPage(null, "Writing tasks");
  throw new Error("Invalid teacher writing-task page.");
}

export async function listTeacherQuestionBankPage(
  input: TeacherQuestionBankPageInput,
): Promise<TeacherQuestionBankPage> {
  const search = input.search?.trim() ?? "";
  const topic = input.topic?.trim() || null;
  const pageSize = input.pageSize ?? TEACHER_QUESTION_BANK_PAGE_SIZE;
  const cursor = input.cursor ?? null;
  const status = input.status ?? "active";
  if (
    !input.workspaceId
    || !["workspace", "global"].includes(input.source)
    || search.length > 200
    || (topic?.length ?? 0) > 120
    || !Number.isSafeInteger(pageSize)
    || pageSize < 1
    || pageSize > 50
    || (cursor != null && (
      !Number.isSafeInteger(cursor.sort_rank)
      || cursor.sort_rank < -2_147_483_648
      || cursor.sort_rank > 2_147_483_647
      || typeof cursor.created_at !== "string"
      || cursor.created_at.length === 0
      || typeof cursor.id !== "string"
      || cursor.id.length === 0
      || (input.source === "workspace" && cursor.sort_rank !== 0)
    ))
    || !["all", "active", "inactive"].includes(status)
  ) {
    return invalidTeacherQuestionPage();
  }
  const value = await callApiRpc<unknown>(
    "list_teacher_question_bank_page",
    {
      target_workspace_id: input.workspaceId,
      target_source: input.source,
      search_query: search,
      target_level: input.level ?? null,
      target_topic: topic,
      target_task_type: input.taskType ?? null,
      target_status: status,
      requested_page_size: pageSize,
      cursor_sort_rank: cursor?.sort_rank ?? null,
      cursor_created_at: cursor?.created_at ?? null,
      cursor_id: cursor?.id ?? null,
    },
    "Writing tasks could not be loaded. Please try again.",
  );
  const page = parseApiPage<WorkspaceQuestion>(value, "Writing tasks");
  const raw = parseApiRecord<Record<string, unknown>>(value, "Writing tasks");
  let nextCursor: TeacherQuestionBankCursor | null = null;
  if (page.next_cursor) {
    const next = page.next_cursor as unknown as Record<string, unknown>;
    if (
      typeof next.sort_rank !== "number"
      || !Number.isSafeInteger(next.sort_rank)
      || next.sort_rank < -2_147_483_648
      || next.sort_rank > 2_147_483_647
      || typeof next.created_at !== "string"
      || next.created_at.length === 0
      || typeof next.id !== "string"
      || next.id.length === 0
      || (input.source === "workspace" && next.sort_rank !== 0)
      || (
        cursor?.sort_rank === next.sort_rank
        && cursor.created_at === next.created_at
        && cursor.id === next.id
      )
    ) {
      return invalidTeacherQuestionPage();
    }
    nextCursor = {
      sort_rank: next.sort_rank,
      created_at: next.created_at,
      id: next.id,
    };
  }
  if (
    page.page_size !== pageSize
    || page.returned_count > pageSize
    || page.next_offset != null
    || !Array.isArray(raw.available_topics)
    || raw.available_topics.some((item) => typeof item !== "string")
    || new Set(raw.available_topics).size !== raw.available_topics.length
    || page.has_more !== Boolean(nextCursor)
    || page.items.some((question) => (
      !question
      || typeof question.id !== "string"
      || question.source !== input.source
      || (
        input.source === "workspace"
          ? question.workspace_id !== input.workspaceId
          : question.workspace_id !== "global"
      )
      || (input.level != null && question.level !== input.level)
      || (topic != null && question.topic !== topic)
      || (input.taskType != null && question.task_type !== input.taskType)
      || (status === "active" && !question.is_active)
      || (status === "inactive" && question.is_active)
    ))
  ) {
    return invalidTeacherQuestionPage();
  }
  return {
    ...page,
    available_topics: raw.available_topics as string[],
    next_cursor: nextCursor,
  };
}

export async function listWorkspaceQuestions(
  workspaceId: string,
  limit?: number,
): Promise<WorkspaceQuestion[]> {
  const questions: WorkspaceQuestion[] = [];
  let cursor: { created_at: string; id: string } | null = null;

  do {
    const remaining =
      limit == null
        ? QUESTION_PAGE_SIZE
        : Math.max(limit - questions.length, 0);
    if (remaining === 0) break;
    const pageSize = Math.min(QUESTION_PAGE_SIZE, remaining);
    const value: unknown = await callApiRpc<unknown>(
      "list_workspace_questions_page",
      {
        target_workspace_id: workspaceId,
        requested_page_size: pageSize,
        cursor_created_at: cursor?.created_at ?? null,
        cursor_id: cursor?.id ?? null,
      },
      "Writing tasks could not be loaded. Please try again.",
    );
    const page: ApiPage<WorkspaceQuestion> = parseApiPage<WorkspaceQuestion>(
      value,
      "Writing tasks",
    );
    questions.push(...page.items);
    if (!page.has_more || (limit != null && questions.length >= limit)) break;

    const next: ApiKeysetCursor | null = page.next_cursor;
    if (
      !next ||
      typeof next.created_at !== "string" ||
      typeof next.id !== "string" ||
      (cursor?.created_at === next.created_at && cursor.id === next.id)
    ) {
      parseApiPage(null, "Writing tasks");
    }
    cursor = { created_at: next!.created_at!, id: next!.id };
  } while (cursor);

  return questions;
}

export async function getWorkspaceQuestionCount(
  workspaceId: string,
): Promise<number> {
  const value = await callApiRpc<unknown>(
    "list_workspace_questions_page",
    {
      target_workspace_id: workspaceId,
      requested_page_size: 1,
      cursor_created_at: null,
      cursor_id: null,
    },
    "The writing-task count could not be loaded. Please try again.",
  );
  return parseApiPage<WorkspaceQuestion>(value, "Writing-task count")
    .total_count;
}

export async function listGlobalQuestions(
  levels?: WorkspaceLevel[],
  limit?: number,
): Promise<WorkspaceQuestion[]> {
  const questions: WorkspaceQuestion[] = [];
  let offset = 0;

  do {
    const remaining =
      limit == null
        ? GLOBAL_QUESTION_PAGE_SIZE
        : Math.max(limit - questions.length, 0);
    if (remaining === 0) break;
    const value = await callApiRpc<unknown>(
      "list_global_questions_page",
      {
        target_levels: levels?.length ? levels : null,
        requested_page_size: Math.min(GLOBAL_QUESTION_PAGE_SIZE, remaining),
        requested_offset: offset,
      },
      "Shared writing tasks could not be loaded. Please try again.",
    );
    const page = parseApiPage<WorkspaceQuestion>(value, "Shared writing tasks");
    questions.push(...page.items);
    if (!page.has_more || (limit != null && questions.length >= limit)) break;
    if (typeof page.next_offset !== "number" || page.next_offset <= offset) {
      parseApiPage(null, "Shared writing tasks");
    }
    offset = page.next_offset!;
  } while (true);

  return questions;
}

const studentTaskStates = new Set<StudentWritingTaskState>([
  "not_started",
  "submitted",
  "queued",
  "processing",
  "scheduled",
  "needs_review",
  "feedback_held",
  "feedback_released",
  "failed",
]);

function invalidStudentQuestionPage(): never {
  parseApiPage(null, "Your writing tasks");
  throw new Error("Invalid writing-task page.");
}

export async function listStudentAssignedQuestionsPage(
  input: StudentAssignedQuestionPageInput,
): Promise<StudentAssignedQuestionPage> {
  const pageSize = input.pageSize ?? STUDENT_ASSIGNED_QUESTION_PAGE_SIZE;
  const search = input.search?.trim() ?? "";
  if (
    !input.studentId ||
    !input.batchId ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50 ||
    search.length > 200
  ) {
    return invalidStudentQuestionPage();
  }
  const value = await callApiRpc<unknown>(
    "list_student_assigned_questions_page",
    {
      target_student_id: input.studentId,
      target_batch_id: input.batchId,
      target_search: search,
      target_level: input.level ?? null,
      requested_page_size: pageSize,
      cursor_created_at: input.cursor?.created_at ?? null,
      cursor_source: input.cursor?.source ?? null,
      cursor_id: input.cursor?.id ?? null,
    },
    "Your writing tasks could not be loaded. Please try again.",
  );
  const page = parseApiPage<StudentAssignedQuestion>(
    value,
    "Your writing tasks",
  );
  if (page.page_size !== pageSize) return invalidStudentQuestionPage();

  for (const task of page.items) {
    if (
      !task ||
      typeof task !== "object" ||
      typeof task.id !== "string" ||
      typeof task.workspace_id !== "string" ||
      (task.source !== "workspace" && task.source !== "global") ||
      task.batch_id !== input.batchId ||
      typeof task.batch_name !== "string" ||
      !studentTaskStates.has(task.task_state) ||
      (task.task_state === "not_started"
        ? task.latest_submission_id !== null
        : typeof task.latest_submission_id !== "string")
    ) {
      return invalidStudentQuestionPage();
    }
  }

  let nextCursor: StudentAssignedQuestionCursor | null = null;
  if (page.next_cursor) {
    const cursor = page.next_cursor as unknown as Record<string, unknown>;
    if (
      typeof cursor.created_at !== "string" ||
      (cursor.source !== "workspace" && cursor.source !== "global") ||
      typeof cursor.id !== "string" ||
      (input.cursor?.created_at === cursor.created_at &&
        input.cursor.source === cursor.source &&
        input.cursor.id === cursor.id)
    ) {
      return invalidStudentQuestionPage();
    }
    nextCursor = {
      created_at: cursor.created_at,
      source: cursor.source,
      id: cursor.id,
    };
  }

  if (page.has_more !== Boolean(nextCursor))
    return invalidStudentQuestionPage();
  return { ...page, next_cursor: nextCursor };
}

export async function createWorkspaceQuestion(
  workspaceId: string,
  _userId: string,
  input: QuestionInput,
): Promise<void> {
  const value = await callApiRpc<unknown>(
    "create_workspace_question",
    { target_workspace_id: workspaceId, ...questionArgs(input) },
    "The writing task could not be created. Please try again.",
  );
  const rows = parseApiArray<{ question_id: string }>(
    value,
    "Writing-task creation",
  );
  if (!rows[0]?.question_id) parseApiArray(null, "Writing-task creation");
}

export async function updateWorkspaceQuestion(
  workspaceId: string,
  questionId: string,
  input: QuestionInput,
): Promise<void> {
  const value = await callApiRpc<unknown>(
    "update_workspace_question",
    {
      target_workspace_id: workspaceId,
      target_question_id: questionId,
      ...questionArgs(input),
    },
    "The writing task could not be updated. Please try again.",
  );
  const rows = parseApiArray<{ question_id: string }>(
    value,
    "Writing-task update",
  );
  if (rows[0]?.question_id !== questionId)
    parseApiArray(null, "Writing-task update");
}

export async function setQuestionActive(
  workspaceId: string,
  questionId: string,
  isActive: boolean,
): Promise<void> {
  const value = await callApiRpc<unknown>(
    "set_question_active",
    {
      target_workspace_id: workspaceId,
      target_question_id: questionId,
      target_is_active: isActive,
    },
    "The writing-task status could not be changed. Please try again.",
  );
  const rows = parseApiArray<{ question_id: string; is_active: boolean }>(
    value,
    "Writing-task status",
  );
  if (rows[0]?.question_id !== questionId || rows[0]?.is_active !== isActive) {
    parseApiArray(null, "Writing-task status");
  }
}
