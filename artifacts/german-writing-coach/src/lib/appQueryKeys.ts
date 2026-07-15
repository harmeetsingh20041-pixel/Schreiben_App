import type { SubmissionCursor } from "@/services/submissionService";
import type {
  FeedbackReviewCursor,
  FeedbackReviewReason,
} from "@/services/feedbackReviewService";
import type {
  PracticeReviewCursor,
  PracticeReviewKind,
} from "@/services/practiceReviewQueueService";
import type {
  JoinRequestCursor,
  WorkspaceStudentCursor,
} from "@/services/studentService";
import type {
  StudentAssignedQuestionCursor,
  TeacherQuestionBankCursor,
} from "@/services/questionService";
import type {
  TeacherAccessCursor,
  TeacherAccessStatus,
} from "@/services/teacherAccessService";
import type {
  BatchWritingLimitRequestCursor,
  BatchWritingLimitRequestStatusFilter,
} from "@/services/batchWritingLimitService";
import type {
  WorkspaceBatchOptionCursor,
  WorkspaceBatchCursor,
  WorkspaceBatchStatusFilter,
} from "@/services/batchService";

export const SHARED_QUERY_STALE_MS = 30_000;

function cursorKey(
  cursor: SubmissionCursor | FeedbackReviewCursor | PracticeReviewCursor | null,
) {
  if (!cursor) return null;
  if ("queue_key" in cursor) {
    return { updatedAt: cursor.updated_at, queueKey: cursor.queue_key };
  }
  return { createdAt: cursor.created_at, id: cursor.id };
}

export const appQueryKeys = {
  teacherAccessSelf: () => ["teacher-access", "self"] as const,
  teacherAccessStart: () =>
    [...appQueryKeys.teacherAccessSelf(), "start"] as const,
  teacherAccessAdmin: () => ["teacher-access", "admin"] as const,
  teacherAccessHealth: () =>
    [...appQueryKeys.teacherAccessAdmin(), "health"] as const,
  teacherAccessInventory: () =>
    [...appQueryKeys.teacherAccessAdmin(), "inventory"] as const,
  teacherAccessInventoryPage: (input: {
    status: TeacherAccessStatus | "all";
    pageSize: number;
    cursor: TeacherAccessCursor | null;
  }) =>
    [
      ...appQueryKeys.teacherAccessInventory(),
      {
        status: input.status,
        pageSize: input.pageSize,
        cursor: input.cursor
          ? { updatedAt: input.cursor.updated_at, id: input.cursor.id }
          : null,
      },
    ] as const,
  batchWritingLimitAdmin: () => ["batch-writing-limit", "admin"] as const,
  batchWritingLimitRequests: () =>
    [...appQueryKeys.batchWritingLimitAdmin(), "requests"] as const,
  batchWritingLimitRequestsPage: (input: {
    status: BatchWritingLimitRequestStatusFilter;
    pageSize: number;
    cursor: BatchWritingLimitRequestCursor | null;
  }) =>
    [
      ...appQueryKeys.batchWritingLimitRequests(),
      {
        status: input.status,
        pageSize: input.pageSize,
        cursor: input.cursor
          ? { updatedAt: input.cursor.updated_at, id: input.cursor.id }
          : null,
      },
    ] as const,
  workspace: (workspaceId: string) => ["workspace", workspaceId] as const,
  workspaceBatches: (workspaceId: string) =>
    [...appQueryKeys.workspace(workspaceId), "batches"] as const,
  workspaceBatchOptions: (input: {
    workspaceId: string;
    search: string;
    pageSize: number;
    cursor: WorkspaceBatchOptionCursor | null;
  }) =>
    [
      ...appQueryKeys.workspaceBatches(input.workspaceId),
      "options",
      {
        search: input.search.trim(),
        pageSize: input.pageSize,
        cursor: input.cursor
          ? { createdAt: input.cursor.created_at, id: input.cursor.id }
          : null,
      },
    ] as const,
  onboardingProgress: (workspaceId: string, role: "teacher" | "student") =>
    [...appQueryKeys.workspace(workspaceId), "onboarding", role] as const,
  workspaceBatchesPage: (input: {
    workspaceId: string;
    status: WorkspaceBatchStatusFilter;
    level: string | null;
    pageSize: number;
    cursor: WorkspaceBatchCursor | null;
  }) =>
    [
      ...appQueryKeys.workspaceBatches(input.workspaceId),
      "page",
      {
        status: input.status,
        level: input.level,
        pageSize: input.pageSize,
        cursor: input.cursor
          ? { createdAt: input.cursor.created_at, id: input.cursor.id }
          : null,
      },
    ] as const,
  workspaceStudentCount: (workspaceId: string) =>
    [...appQueryKeys.workspace(workspaceId), "student-count"] as const,
  workspaceStudents: (workspaceId: string) =>
    [...appQueryKeys.workspace(workspaceId), "students"] as const,
  workspaceStudentsPage: (input: {
    workspaceId: string;
    search: string;
    batchId: string | null;
    level: string | null;
    pageSize: number;
    cursor: WorkspaceStudentCursor | null;
  }) =>
    [
      ...appQueryKeys.workspaceStudents(input.workspaceId),
      "page",
      {
        search: input.search,
        batchId: input.batchId,
        level: input.level,
        pageSize: input.pageSize,
        cursor: input.cursor
          ? { createdAt: input.cursor.created_at, id: input.cursor.id }
          : null,
      },
    ] as const,
  workspaceQuestionCount: (workspaceId: string) =>
    [...appQueryKeys.workspace(workspaceId), "question-count"] as const,
  teacherDashboard: (workspaceId: string) =>
    [...appQueryKeys.workspace(workspaceId), "teacher-dashboard"] as const,
  teacherDashboardSummary: (workspaceId: string, batchId: string | null) =>
    [
      ...appQueryKeys.teacherDashboard(workspaceId),
      "summary",
      { batchId },
    ] as const,
  teacherQuestionBank: (workspaceId: string) =>
    [...appQueryKeys.workspace(workspaceId), "teacher-question-bank"] as const,
  teacherQuestionBankPage: (input: {
    workspaceId: string;
    source: "workspace" | "global";
    search: string;
    level: string | null;
    topic: string | null;
    taskType: string | null;
    status: "all" | "active" | "inactive";
    pageSize: number;
    cursor: TeacherQuestionBankCursor | null;
  }) =>
    [
      ...appQueryKeys.teacherQuestionBank(input.workspaceId),
      "page",
      {
        source: input.source,
        search: input.search,
        level: input.level,
        topic: input.topic,
        taskType: input.taskType,
        status: input.status,
        pageSize: input.pageSize,
        cursor: input.cursor
          ? {
              sortRank: input.cursor.sort_rank,
              createdAt: input.cursor.created_at,
              id: input.cursor.id,
            }
          : null,
      },
    ] as const,
  workspaceJoinRequests: (workspaceId: string) =>
    [...appQueryKeys.workspace(workspaceId), "join-requests"] as const,
  workspaceJoinRequestsPage: (input: {
    workspaceId: string;
    status: string;
    search: string;
    batchId: string | null;
    pageSize: number;
    cursor: JoinRequestCursor | null;
  }) =>
    [
      ...appQueryKeys.workspaceJoinRequests(input.workspaceId),
      "page",
      {
        status: input.status,
        search: input.search,
        batchId: input.batchId,
        pageSize: input.pageSize,
        cursor: input.cursor
          ? { requestedAt: input.cursor.requested_at, id: input.cursor.id }
          : null,
      },
    ] as const,
  workspaceGrammarStats: (workspaceId: string, limit: number) =>
    [
      ...appQueryKeys.workspace(workspaceId),
      "grammar-stats",
      { limit },
    ] as const,
  workspacePracticeAssignments: (workspaceId: string) =>
    [...appQueryKeys.workspace(workspaceId), "practice-assignments"] as const,
  teacherSubmissions: (workspaceId: string) =>
    ["teacher-submissions", workspaceId] as const,
  teacherSubmissionsPage: (input: {
    workspaceId: string;
    studentId?: string | null;
    batchId?: string | null;
    pageSize: number;
    cursor: SubmissionCursor | null;
  }) =>
    [
      ...appQueryKeys.teacherSubmissions(input.workspaceId),
      {
        studentId: input.studentId ?? null,
        batchId: input.batchId ?? null,
        pageSize: input.pageSize,
        cursor: cursorKey(input.cursor),
      },
    ] as const,
  teacherFeedbackQueue: (workspaceId: string) =>
    ["teacher-feedback-review-queue", workspaceId] as const,
  teacherFeedbackQueuePage: (input: {
    workspaceId: string;
    reason: FeedbackReviewReason | "all";
    pageSize: number;
    cursor: FeedbackReviewCursor | null;
  }) =>
    [
      ...appQueryKeys.teacherFeedbackQueue(input.workspaceId),
      {
        reason: input.reason,
        pageSize: input.pageSize,
        cursor: cursorKey(input.cursor),
      },
    ] as const,
  teacherPracticeReviewQueue: (workspaceId: string) =>
    ["teacher-practice-review-queue", workspaceId] as const,
  teacherPracticeReviewQueuePage: (input: {
    workspaceId: string;
    kind: PracticeReviewKind | "all";
    pageSize: number;
    cursor: PracticeReviewCursor | null;
  }) =>
    [
      ...appQueryKeys.teacherPracticeReviewQueue(input.workspaceId),
      {
        kind: input.kind,
        pageSize: input.pageSize,
        cursor: cursorKey(input.cursor),
      },
    ] as const,
  student: (studentId: string) => ["student", studentId] as const,
  studentBatchAssignments: (studentId: string) =>
    [...appQueryKeys.student(studentId), "batch-assignments"] as const,
  studentJoinRequests: (studentId: string) =>
    [...appQueryKeys.student(studentId), "join-requests"] as const,
  studentAssignedQuestions: (studentId: string) =>
    [...appQueryKeys.student(studentId), "assigned-questions"] as const,
  studentAssignedQuestionsPage: (input: {
    studentId: string;
    batchId: string;
    search: string;
    level: string | null;
    pageSize: number;
    cursor: StudentAssignedQuestionCursor | null;
  }) =>
    [
      ...appQueryKeys.studentAssignedQuestions(input.studentId),
      "page",
      {
        batchId: input.batchId,
        search: input.search,
        level: input.level,
        pageSize: input.pageSize,
        cursor: input.cursor
          ? {
              createdAt: input.cursor.created_at,
              source: input.cursor.source,
              id: input.cursor.id,
            }
          : null,
      },
    ] as const,
  studentGrammarStats: (
    workspaceId: string,
    studentId: string,
    limit: number,
  ) =>
    [
      ...appQueryKeys.student(studentId),
      "grammar-stats",
      { workspaceId, limit },
    ] as const,
  studentPracticeAssignments: (workspaceId: string, studentId: string) =>
    [
      ...appQueryKeys.student(studentId),
      "practice-assignments",
      { workspaceId },
    ] as const,
  studentPracticeAssignment: (assignmentId: string) =>
    ["student-practice-assignment", assignmentId] as const,
  studentSubmissions: (workspaceId: string, studentId: string) =>
    ["student-submissions", studentId, workspaceId] as const,
  studentSubmissionsPage: (input: {
    workspaceId: string;
    studentId: string;
    batchId?: string | null;
    evaluationStatus?: string | null;
    releaseStatus?: string | null;
    pageSize: number;
    cursor: SubmissionCursor | null;
  }) =>
    [
      ...appQueryKeys.studentSubmissions(input.workspaceId, input.studentId),
      {
        batchId: input.batchId ?? null,
        evaluationStatus: input.evaluationStatus ?? null,
        releaseStatus: input.releaseStatus ?? null,
        pageSize: input.pageSize,
        cursor: cursorKey(input.cursor),
      },
    ] as const,
  studentReleasedFeedbackSummary: (
    workspaceId: string,
    studentId: string,
    batchId: string | null,
  ) =>
    [
      ...appQueryKeys.student(studentId),
      "released-feedback-summary",
      { workspaceId, batchId },
    ] as const,
};
