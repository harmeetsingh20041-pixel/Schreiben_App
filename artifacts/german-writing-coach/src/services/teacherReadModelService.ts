import { PublicAppError } from "@/lib/appError";
import { callApiRpc, parseApiRecord } from "@/services/apiFacade";
import type { WeaknessLevel } from "@/services/grammarStatsService";

export interface TeacherPracticeState {
  id: string;
  student_id: string;
  grammar_topic_id: string;
  practice_test_id: string | null;
  worksheet_title: string | null;
  status: "unlocked" | "in_progress" | "completed" | "passed" | "failed" | "cancelled";
  source: string;
  generation_status: "idle" | "queued" | "generating" | "ready" | "needs_review" | "failed";
  evaluation_status: string | null;
  latest_attempt_status: string | null;
}

export interface TeacherWeakTopic {
  id: string;
  workspace_id: string;
  student_id: string;
  student_name?: string;
  student_email?: string;
  grammar_topic_id: string;
  topic_name: string;
  topic_slug: string;
  topic_description: string | null;
  total_minor_issues: number;
  total_major_issues: number;
  total_correct_after_practice: number;
  weakness_level: WeaknessLevel;
  practice_unlocked: boolean;
  last_seen_at: string | null;
  updated_at: string;
  active_practice: TeacherPracticeState | null;
}

export interface TeacherDashboardSummary {
  schema_version: 1;
  workspace_id: string;
  batch_id: string | null;
  student_count: number;
  question_count: number;
  pending_join_request_count: number;
  attention_items: TeacherWeakTopic[];
}

const weaknessLevels = new Set<WeaknessLevel>([
  "locked",
  "unlocked",
  "in_progress",
  "improving",
  "mastered",
]);
const practiceStatuses = new Set<TeacherPracticeState["status"]>([
  "unlocked",
  "in_progress",
  "completed",
  "passed",
  "failed",
  "cancelled",
]);
const generationStatuses = new Set<TeacherPracticeState["generation_status"]>([
  "idle",
  "queued",
  "generating",
  "ready",
  "needs_review",
  "failed",
]);

function invalidTeacherReadModel(label: string): never {
  throw new PublicAppError(
    "data_invalid_response",
    `${label} returned an invalid response. Please refresh and try again.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parsePracticeState(
  value: unknown,
  studentId: string,
  topicId: string,
  label: string,
): TeacherPracticeState | null {
  if (value === null) return null;
  if (!isRecord(value)) return invalidTeacherReadModel(label);
  if (
    typeof value.id !== "string"
    || value.student_id !== studentId
    || value.grammar_topic_id !== topicId
    || !isNullableString(value.practice_test_id)
    || !isNullableString(value.worksheet_title)
    || typeof value.status !== "string"
    || !practiceStatuses.has(value.status as TeacherPracticeState["status"])
    || typeof value.source !== "string"
    || typeof value.generation_status !== "string"
    || !generationStatuses.has(
      value.generation_status as TeacherPracticeState["generation_status"],
    )
    || !isNullableString(value.evaluation_status)
    || !isNullableString(value.latest_attempt_status)
  ) {
    return invalidTeacherReadModel(label);
  }
  return value as unknown as TeacherPracticeState;
}

export function parseTeacherWeakTopics(
  value: unknown,
  context: {
    workspaceId: string;
    studentId?: string;
    maxItems: number;
    requireStudentIdentity?: boolean;
  },
  label: string,
): TeacherWeakTopic[] {
  if (!Array.isArray(value) || value.length > context.maxItems) {
    return invalidTeacherReadModel(label);
  }
  return value.map((item) => {
    if (!isRecord(item)) return invalidTeacherReadModel(label);
    const requiredStrings = [
      "id",
      "workspace_id",
      "student_id",
      "grammar_topic_id",
      "topic_name",
      "topic_slug",
      "updated_at",
    ] as const;
    if (
      requiredStrings.some((key) => typeof item[key] !== "string" || item[key].length === 0)
      || item.workspace_id !== context.workspaceId
      || (context.studentId !== undefined && item.student_id !== context.studentId)
      || !isNullableString(item.topic_description)
      || !isNullableString(item.last_seen_at)
      || !isNonNegativeInteger(item.total_minor_issues)
      || !isNonNegativeInteger(item.total_major_issues)
      || !isNonNegativeInteger(item.total_correct_after_practice)
      || typeof item.weakness_level !== "string"
      || !weaknessLevels.has(item.weakness_level as WeaknessLevel)
      || item.weakness_level === "mastered"
      || typeof item.practice_unlocked !== "boolean"
      || (
        context.requireStudentIdentity
        && (typeof item.student_name !== "string" || typeof item.student_email !== "string")
      )
      || (item.student_name !== undefined && typeof item.student_name !== "string")
      || (item.student_email !== undefined && typeof item.student_email !== "string")
    ) {
      return invalidTeacherReadModel(label);
    }
    return {
      ...item,
      active_practice: parsePracticeState(
        item.active_practice,
        item.student_id as string,
        item.grammar_topic_id as string,
        label,
      ),
    } as unknown as TeacherWeakTopic;
  });
}

export async function getTeacherDashboardSummary(
  workspaceId: string,
  batchId: string | null,
): Promise<TeacherDashboardSummary> {
  const value = await callApiRpc<unknown>(
    "get_teacher_dashboard_summary",
    {
      target_workspace_id: workspaceId,
      target_batch_id: batchId,
      requested_attention_limit: 6,
    },
    "The teacher overview could not be loaded. Please try again.",
  );
  const row = parseApiRecord<Record<string, unknown>>(value, "Teacher overview");
  if (
    row.schema_version !== 1
    || row.workspace_id !== workspaceId
    || row.batch_id !== batchId
    || !isNonNegativeInteger(row.student_count)
    || !isNonNegativeInteger(row.question_count)
    || !isNonNegativeInteger(row.pending_join_request_count)
  ) {
    return invalidTeacherReadModel("Teacher overview");
  }
  return {
    schema_version: 1,
    workspace_id: workspaceId,
    batch_id: batchId,
    student_count: row.student_count,
    question_count: row.question_count,
    pending_join_request_count: row.pending_join_request_count,
    attention_items: parseTeacherWeakTopics(
      row.attention_items,
      { workspaceId, maxItems: 6, requireStudentIdentity: true },
      "Teacher overview",
    ),
  };
}

export function formatTeacherIssueCount(topic: TeacherWeakTopic) {
  const issueCount = topic.total_major_issues + topic.total_minor_issues;
  return `${issueCount} confirmed ${issueCount === 1 ? "issue" : "issues"}`;
}

export function getTeacherPracticeLabel(practice: TeacherPracticeState) {
  if (!practice.practice_test_id && practice.generation_status === "generating") {
    return "Preparing worksheet";
  }
  if (!practice.practice_test_id && practice.generation_status === "failed") {
    return "Preparation failed";
  }
  if (practice.status === "unlocked" && !practice.practice_test_id) return "Practice unlocked";
  if (practice.status === "unlocked") return "Worksheet assigned";
  if (practice.status === "in_progress") return "In progress";
  if (practice.status === "failed") return "Needs more practice";
  if (
    practice.status === "completed"
    && ["pending", "queued", "evaluating"].includes(practice.evaluation_status ?? "")
  ) return "Preparing feedback";
  if (practice.status === "completed" && practice.evaluation_status === "failed") {
    return "Feedback needs retry";
  }
  if (practice.status === "completed" && practice.latest_attempt_status === "submitted") {
    return "Submitted for review";
  }
  return practice.status === "completed" ? "Completed" : "Practice assigned";
}

export function getTeacherPracticeBadgeClass(practice: TeacherPracticeState) {
  if (!practice.practice_test_id && practice.generation_status === "failed") {
    return "bg-destructive/10 text-destructive border-destructive/30";
  }
  if (!practice.practice_test_id && practice.generation_status === "generating") {
    return "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-700";
  }
  if (practice.status === "failed") {
    return "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-100 dark:border-orange-700";
  }
  if (practice.status === "in_progress") {
    return "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-700";
  }
  return "bg-primary/10 text-primary border-primary/20";
}

export function isTeacherSupportRecommended(practice: TeacherPracticeState) {
  return practice.source === "adaptive_repeat" && practice.status === "failed";
}
