import { getSupabaseClient } from "@/lib/supabaseClient";
import { PublicAppError } from "@/lib/appError";
import {
  callApiRpc,
  parseApiArray,
  parseApiPage,
  parseApiRecord,
  type ApiKeysetCursor,
  type ApiPage,
} from "@/services/apiFacade";
import type { Database, Json } from "@/types/supabase";

type PracticeQuestionRpcRow =
  Database["public"]["Functions"]["get_practice_assignment_questions"]["Returns"][number];
type PracticeReviewRpcRow =
  Database["public"]["Functions"]["get_practice_assignment_review"]["Returns"][number];

export type PracticeAssignmentStatus =
  | "unlocked"
  | "in_progress"
  | "completed"
  | "passed"
  | "failed"
  | "cancelled";

export type PracticeAttemptStatus = "in_progress" | "submitted" | "checked";
export type PracticeEvaluationStatus =
  | "queued"
  | "evaluating"
  | "completed"
  | "not_needed"
  | "needs_review"
  | "failed";
export type PracticeGenerationStatus =
  | "idle"
  | "queued"
  | "generating"
  | "ready"
  | "needs_review"
  | "failed";

export interface PracticeMiniLesson {
  short_explanation: string;
  key_rule: string;
  correct_examples: string[];
  common_mistake_warning: string;
  what_to_revise: string;
}

export interface PracticeAssignmentSummary {
  id: string;
  workspace_id: string;
  student_id: string;
  grammar_topic_id: string;
  grammar_topic_name: string;
  grammar_topic_slug: string;
  grammar_topic_description: string | null;
  batch_id: string | null;
  batch_name: string | null;
  class_context_version: number;
  practice_test_id: string | null;
  worksheet_title: string | null;
  worksheet_level: string | null;
  worksheet_difficulty: string | null;
  worksheet_mini_lesson: PracticeMiniLesson | null;
  status: PracticeAssignmentStatus;
  source: string;
  assigned_at: string;
  started_at: string | null;
  completed_at: string | null;
  latest_attempt_id: string | null;
  latest_attempt_status: PracticeAttemptStatus | null;
  score: number | null;
  max_score: number | null;
  score_points: number | null;
  max_score_points: number | null;
  scoring_version: string | null;
  evaluation_status: PracticeEvaluationStatus | "pending" | string | null;
  evaluation_automatic_retry_at?: string | null;
  evaluation_automatic_retry_exhausted_at?: string | null;
  evaluation_started_at: string | null;
  evaluation_completed_at: string | null;
  evaluation_error: string | null;
  score_percent: number | null;
  passed: boolean | null;
  question_count: number;
  generation_status: PracticeGenerationStatus;
  generation_retry_exhausted: boolean;
  generation_automatic_retry_at?: string | null;
  generation_automatic_retry_exhausted_at?: string | null;
  generation_started_at: string | null;
  generation_completed_at: string | null;
  generation_error: string | null;
  previous_assignment_id: string | null;
  previous_attempt_id: string | null;
  repeat_number: number;
  adaptive_reason: string | null;
  adaptive_status: string | null;
  resolution_cycle_id: string | null;
  resolution_cycle_number: number | null;
  evidence_cutoff_sequence: number | null;
  student_name?: string | null;
  student_email?: string | null;
}

export function hasDurableWorksheetPreparationState(
  assignment: Pick<
    PracticeAssignmentSummary,
    "practice_test_id" | "generation_status"
  >,
) {
  return (
    Boolean(assignment.practice_test_id) ||
    ["queued", "generating", "needs_review"].includes(
      assignment.generation_status,
    )
  );
}

export type PracticeQuestionType =
  | "multiple_choice"
  | "fill_blank"
  | "sentence_correction"
  | "correction"
  | "word_order"
  | "transformation"
  | "short_answer"
  | "mini_writing"
  | "matching"
  | "error_detection"
  | "rewrite_sentence"
  | (string & {});

export interface PracticeWorksheetQuestion {
  id: string;
  question_number: number;
  question_type: PracticeQuestionType;
  prompt: string;
  options: string[];
  student_answer?: string | null;
  correct_answer?: string | null;
  explanation?: string | null;
  is_correct?: boolean | null;
  review_status?:
    | "correct"
    | "partially_correct"
    | "minor_punctuation"
    | "capitalization_issue"
    | "minor_formatting"
    | "incorrect"
    | "submitted_for_review"
    | string
    | null;
  points_awarded?: number | null;
  max_points?: number | null;
  feedback_text?: string | null;
  corrected_answer?: string | null;
  model_answer?: string | null;
  short_reason?: string | null;
  evaluator_source?: string | null;
}

export interface PracticeWorksheetDetail {
  assignment: PracticeAssignmentSummary;
  questions: PracticeWorksheetQuestion[];
}

export interface PracticeClassContextOption {
  batch_id: string;
  batch_name: string;
  worksheet_level: "A1" | "A2" | "B1" | "B2";
}

export interface PracticeAnswerInput {
  question_id: string;
  answer: string;
}

export interface PracticeDraft {
  draft_id: string;
  assignment_id: string;
  revision: number;
  answers: PracticeAnswerInput[];
  updated_at: string;
}

export interface SavedPracticeDraft extends PracticeDraft {
  saved_at: string;
}

export type PracticeTeacherActionType =
  | "score_override"
  | "assignment_reassigned"
  | "support_resolved"
  | "semantic_review_finalized";

export type PracticeSupportResolution =
  | "reassigned"
  | "contacted"
  | "not_needed";
export type PracticeSupportStatus = "open" | "resolved" | "not_applicable";

export interface PracticeTeacherAction {
  id: string;
  action_revision: number;
  action_type: PracticeTeacherActionType;
  attempt_id: string | null;
  resolution: PracticeSupportResolution | null;
  reason: string;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  related_assignment_id: string | null;
  actor_id: string;
  actor_name: string;
  created_at: string;
}

export interface PracticeTeacherActionHistory {
  assignment_id: string;
  current_revision: number;
  support_status: PracticeSupportStatus;
  items: PracticeTeacherAction[];
}

export interface PracticeScoreOverrideResult {
  action_id: string;
  action_revision: number;
  assignment_id: string;
  attempt_id: string;
  score_points: number;
  max_score_points: number;
  score_percent: number;
  passed: boolean;
  assignment_status: "passed" | "failed";
  follow_up_assignment_id: string | null;
}

export type PracticeSemanticReviewStatus =
  | "correct"
  | "partially_correct"
  | "capitalization_issue"
  | "minor_punctuation"
  | "incorrect";

export interface PracticeSemanticReviewQuestion {
  question_id: string;
  question_number: number;
  question_type: string;
  prompt: string;
  student_answer: string;
  rubric: { criteria: string[]; sample_answer: string | null } | null;
  sample_answer: string | null;
  explanation: string | null;
}

export interface PracticeSemanticReviewDraft {
  assignment_id: string;
  attempt_id: string;
  evaluation_version: number;
  hold_reason_code: string;
  current_action_revision: number;
  questions: PracticeSemanticReviewQuestion[];
}

export interface PracticeSemanticReviewDecision {
  question_id: string;
  review_status: PracticeSemanticReviewStatus;
  feedback_text: string;
  corrected_answer: string | null;
  model_answer: string | null;
  short_reason: string;
}

export interface PracticeSemanticReviewResult {
  action_id: string;
  action_revision: number;
  assignment_id: string;
  attempt_id: string;
  evaluation_status: "completed";
  attempt_status: "checked";
  assignment_status: "passed" | "failed";
  score_points: number;
  max_score_points: number;
  score_percent: number;
  passed: boolean;
}

const PRACTICE_ASSIGNMENT_PAGE_SIZE = 100;

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error(
      "The application service is not configured. Please contact support.",
    );
  }
  return client;
}

function parseOptions(options: Json | null): string[] {
  if (Array.isArray(options)) {
    return options.filter(
      (option): option is string => typeof option === "string",
    );
  }

  if (options && typeof options === "object") {
    const candidate =
      (options as { choices?: unknown; options?: unknown }).choices ??
      (options as { choices?: unknown; options?: unknown }).options;
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (option): option is string => typeof option === "string",
      );
    }
  }

  return [];
}

function parseMiniLesson(
  value: Json | null | undefined,
): PracticeMiniLesson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const examples = Array.isArray(record.correct_examples)
    ? record.correct_examples.filter(
        (example): example is string => typeof example === "string",
      )
    : [];

  const miniLesson = {
    short_explanation:
      typeof record.short_explanation === "string"
        ? record.short_explanation
        : "",
    key_rule: typeof record.key_rule === "string" ? record.key_rule : "",
    correct_examples: examples,
    common_mistake_warning:
      typeof record.common_mistake_warning === "string"
        ? record.common_mistake_warning
        : "",
    what_to_revise:
      typeof record.what_to_revise === "string" ? record.what_to_revise : "",
  };

  return miniLesson.short_explanation ||
    miniLesson.key_rule ||
    miniLesson.correct_examples.length > 0
    ? miniLesson
    : null;
}

function normalizeStatus(status: string): PracticeAssignmentStatus {
  if (
    status === "unlocked" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "passed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  return "unlocked";
}

function normalizeAttemptStatus(
  status: string | null,
): PracticeAttemptStatus | null {
  if (
    status === "in_progress" ||
    status === "submitted" ||
    status === "checked"
  )
    return status;
  return null;
}

function normalizeGenerationStatus(
  status: string | null | undefined,
  hasWorksheet = false,
): PracticeGenerationStatus {
  if (
    status === "idle" ||
    status === "queued" ||
    status === "generating" ||
    status === "ready" ||
    status === "needs_review" ||
    status === "failed"
  )
    return status;
  return hasWorksheet ? "ready" : "idle";
}

function asNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parsePositiveRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value;
}

function parseDraftTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value;
}

function parsePracticeAnswers(
  value: unknown,
  label: string,
): PracticeAnswerInput[] {
  if (!Array.isArray(value)) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  const answers = value.map((answer) => {
    if (
      !answer ||
      typeof answer !== "object" ||
      Array.isArray(answer) ||
      typeof (answer as Record<string, unknown>).question_id !== "string" ||
      typeof (answer as Record<string, unknown>).answer !== "string"
    ) {
      throw new PublicAppError(
        "data_invalid_response",
        `${label} returned an invalid response. Please refresh and try again.`,
      );
    }
    return {
      question_id: (answer as Record<string, unknown>).question_id as string,
      answer: (answer as Record<string, unknown>).answer as string,
    };
  });
  if (
    new Set(answers.map((answer) => answer.question_id)).size !== answers.length
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return answers;
}

function parseTeacherActionRevision(
  value: unknown,
  label: string,
  allowZero = false,
) {
  const minimum = allowZero ? 0 : 1;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value;
}

function parseTeacherActionObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  return parseApiRecord<Record<string, unknown>>(value, label);
}

function parsePracticeTeacherAction(value: unknown): PracticeTeacherAction {
  const row = parseApiRecord<Record<string, unknown>>(value, "Teacher action");
  if (
    typeof row.id !== "string" ||
    ![
      "score_override",
      "assignment_reassigned",
      "support_resolved",
      "semantic_review_finalized",
    ].includes(typeof row.action_type === "string" ? row.action_type : "") ||
    typeof row.reason !== "string" ||
    typeof row.actor_id !== "string" ||
    typeof row.actor_name !== "string" ||
    typeof row.created_at !== "string"
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Teacher action history returned an invalid response. Please refresh and try again.",
    );
  }

  const resolution = asNullableString(row.resolution);
  if (
    resolution &&
    !["reassigned", "contacted", "not_needed"].includes(resolution)
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Teacher action history returned an invalid response. Please refresh and try again.",
    );
  }

  return {
    id: row.id,
    action_revision: parseTeacherActionRevision(
      row.action_revision,
      "Teacher action",
    ),
    action_type: row.action_type as PracticeTeacherActionType,
    attempt_id: asNullableString(row.attempt_id),
    resolution: resolution as PracticeSupportResolution | null,
    reason: row.reason,
    before_state: parseTeacherActionObject(row.before_state, "Teacher action"),
    after_state: parseTeacherActionObject(row.after_state, "Teacher action"),
    related_assignment_id: asNullableString(row.related_assignment_id),
    actor_id: row.actor_id,
    actor_name: row.actor_name,
    created_at: parseDraftTimestamp(row.created_at, "Teacher action"),
  };
}

function parsePracticeTeacherActionHistory(
  value: unknown,
  assignmentId: string,
): PracticeTeacherActionHistory {
  const row = parseApiRecord<Record<string, unknown>>(
    value,
    "Teacher action history",
  );
  if (
    row.schema_version !== 1 ||
    row.assignment_id !== assignmentId ||
    !["open", "resolved", "not_applicable"].includes(
      typeof row.support_status === "string" ? row.support_status : "",
    )
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Teacher action history returned an invalid response. Please refresh and try again.",
    );
  }

  const items = parseApiArray<unknown>(row.items, "Teacher action history").map(
    parsePracticeTeacherAction,
  );
  const currentRevision = parseTeacherActionRevision(
    row.current_revision,
    "Teacher action history",
    true,
  );
  if ((items[0]?.action_revision ?? 0) !== currentRevision) {
    throw new PublicAppError(
      "data_invalid_response",
      "Teacher action history returned an invalid response. Please refresh and try again.",
    );
  }

  return {
    assignment_id: assignmentId,
    current_revision: currentRevision,
    support_status: row.support_status as PracticeSupportStatus,
    items,
  };
}

function mapApiAssignment(value: unknown): PracticeAssignmentSummary {
  const row = parseApiRecord<Record<string, unknown>>(
    value,
    "Practice assignment",
  );
  const requiredStrings = [
    row.id,
    row.workspace_id,
    row.student_id,
    row.grammar_topic_id,
    row.grammar_topic_name,
    row.grammar_topic_slug,
    row.status,
    row.source,
    row.assigned_at,
  ];
  if (requiredStrings.some((entry) => typeof entry !== "string")) {
    throw new PublicAppError(
      "data_invalid_response",
      "Practice assignment returned an invalid response. Please refresh and try again.",
    );
  }

  const practiceTestId = asNullableString(row.practice_test_id);
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    student_id: row.student_id as string,
    grammar_topic_id: row.grammar_topic_id as string,
    grammar_topic_name: row.grammar_topic_name as string,
    grammar_topic_slug: row.grammar_topic_slug as string,
    grammar_topic_description: asNullableString(row.grammar_topic_description),
    batch_id: asNullableString(row.batch_id),
    batch_name: asNullableString(row.batch_name),
    class_context_version: asNullableNumber(row.class_context_version) ?? 0,
    practice_test_id: practiceTestId,
    worksheet_title: asNullableString(row.worksheet_title),
    worksheet_level: asNullableString(row.worksheet_level),
    worksheet_difficulty: asNullableString(row.worksheet_difficulty),
    worksheet_mini_lesson: parseMiniLesson(
      (row.worksheet_mini_lesson ?? null) as Json | null,
    ),
    status: normalizeStatus(row.status as string),
    source: row.source as string,
    assigned_at: row.assigned_at as string,
    started_at: asNullableString(row.started_at),
    completed_at: asNullableString(row.completed_at),
    latest_attempt_id: asNullableString(row.latest_attempt_id),
    latest_attempt_status: normalizeAttemptStatus(
      asNullableString(row.latest_attempt_status),
    ),
    score: asNullableNumber(row.score),
    max_score: asNullableNumber(row.max_score),
    score_points: asNullableNumber(row.score_points),
    max_score_points: asNullableNumber(row.max_score_points),
    scoring_version: asNullableString(row.scoring_version),
    evaluation_status: asNullableString(row.evaluation_status),
    evaluation_automatic_retry_at: asNullableString(
      row.evaluation_automatic_retry_at,
    ),
    evaluation_automatic_retry_exhausted_at: asNullableString(
      row.evaluation_automatic_retry_exhausted_at,
    ),
    evaluation_started_at: asNullableString(row.evaluation_started_at),
    evaluation_completed_at: asNullableString(row.evaluation_completed_at),
    evaluation_error: asNullableString(row.evaluation_error),
    score_percent: asNullableNumber(row.score_percent),
    passed: typeof row.passed === "boolean" ? row.passed : null,
    question_count: asNullableNumber(row.question_count) ?? 0,
    generation_status: normalizeGenerationStatus(
      asNullableString(row.generation_status),
      Boolean(practiceTestId),
    ),
    generation_retry_exhausted: row.generation_retry_exhausted === true,
    generation_automatic_retry_at: asNullableString(
      row.generation_automatic_retry_at,
    ),
    generation_automatic_retry_exhausted_at: asNullableString(
      row.generation_automatic_retry_exhausted_at,
    ),
    generation_started_at: asNullableString(row.generation_started_at),
    generation_completed_at: asNullableString(row.generation_completed_at),
    generation_error: asNullableString(row.generation_error),
    previous_assignment_id: asNullableString(row.previous_assignment_id),
    previous_attempt_id: asNullableString(row.previous_attempt_id),
    repeat_number: asNullableNumber(row.repeat_number) ?? 0,
    adaptive_reason: asNullableString(row.adaptive_reason),
    adaptive_status: asNullableString(row.adaptive_status),
    resolution_cycle_id: asNullableString(row.resolution_cycle_id),
    resolution_cycle_number: asNullableNumber(row.resolution_cycle_number),
    evidence_cutoff_sequence: asNullableNumber(row.evidence_cutoff_sequence),
    student_name: asNullableString(row.student_name),
    student_email: asNullableString(row.student_email),
  };
}

export async function ensureStudentPracticeAssignment(
  workspaceId: string,
  studentId: string,
  grammarTopicId: string,
): Promise<PracticeAssignmentSummary> {
  const value = await callApiRpc<unknown>(
    "ensure_student_practice_assignment",
    {
      target_workspace_id: workspaceId,
      target_student_id: studentId,
      target_grammar_topic_id: grammarTopicId,
    },
    "Practice could not be unlocked. Please try again.",
  );
  return mapApiAssignment(value);
}

export async function listStudentPracticeAssignments(
  workspaceId: string,
  studentId: string,
): Promise<PracticeAssignmentSummary[]> {
  const assignments: PracticeAssignmentSummary[] = [];
  let cursor: { updated_at: string; id: string } | null = null;

  do {
    const value: unknown = await callApiRpc<unknown>(
      "list_student_practice_assignments_page",
      {
        target_workspace_id: workspaceId,
        target_student_id: studentId,
        requested_page_size: PRACTICE_ASSIGNMENT_PAGE_SIZE,
        cursor_updated_at: cursor?.updated_at ?? null,
        cursor_assignment_id: cursor?.id ?? null,
      },
      "Practice assignments could not be loaded. Please try again.",
    );
    const page: ApiPage<unknown> = parseApiPage<unknown>(
      value,
      "Practice assignments",
    );
    assignments.push(...page.items.map(mapApiAssignment));
    if (!page.has_more) break;

    const next: ApiKeysetCursor | null = page.next_cursor;
    if (
      !next ||
      typeof next.updated_at !== "string" ||
      typeof next.id !== "string" ||
      (cursor?.updated_at === next.updated_at && cursor.id === next.id)
    ) {
      parseApiPage(null, "Practice assignments");
    }
    cursor = { updated_at: next!.updated_at!, id: next!.id };
  } while (cursor);

  return assignments;
}

export async function getPracticeAssignmentSummary(
  assignmentId: string,
): Promise<PracticeAssignmentSummary> {
  const value = await callApiRpc<unknown>(
    "get_practice_assignment_summary",
    { target_assignment_id: assignmentId },
    "Practice assignment could not be loaded. Please try again.",
  );
  return mapApiAssignment(value);
}

export async function listPracticeClassContextOptions(
  assignmentId: string,
): Promise<PracticeClassContextOption[]> {
  const value = await callApiRpc<unknown>(
    "list_practice_class_context_options",
    { target_assignment_id: assignmentId },
    "Available classes could not be loaded. Please try again.",
  );
  const root = parseApiRecord<Record<string, unknown>>(
    value,
    "Practice class options",
  );
  if (
    root.schema_version !== 1 ||
    root.assignment_id !== assignmentId ||
    !Array.isArray(root.items)
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Available classes returned an invalid response. Please refresh and try again.",
    );
  }

  return root.items.map((value) => {
    const row = parseApiRecord<Record<string, unknown>>(
      value,
      "Practice class option",
    );
    if (
      typeof row.batch_id !== "string" ||
      typeof row.batch_name !== "string" ||
      typeof row.worksheet_level !== "string" ||
      !["A1", "A2", "B1", "B2"].includes(row.worksheet_level)
    ) {
      throw new PublicAppError(
        "data_invalid_response",
        "Available classes returned an invalid response. Please refresh and try again.",
      );
    }
    return {
      batch_id: row.batch_id,
      batch_name: row.batch_name,
      worksheet_level:
        row.worksheet_level as PracticeClassContextOption["worksheet_level"],
    };
  });
}

export async function resolvePracticeAssignmentClassContext(
  assignmentId: string,
  batchId: string,
): Promise<PracticeAssignmentSummary> {
  const value = await callApiRpc<unknown>(
    "resolve_practice_assignment_class_context",
    {
      target_assignment_id: assignmentId,
      target_batch_id: batchId,
    },
    "The worksheet class could not be saved. Please try again.",
  );
  const row = parseApiRecord<Record<string, unknown>>(
    value,
    "Practice class resolution",
  );
  if (
    row.schema_version !== 1 ||
    row.assignment_id !== assignmentId ||
    row.batch_id !== batchId ||
    typeof row.batch_name !== "string" ||
    typeof row.worksheet_level !== "string" ||
    !["A1", "A2", "B1", "B2"].includes(row.worksheet_level)
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "The saved worksheet class returned an invalid response. Please refresh and try again.",
    );
  }
  return getPracticeAssignmentSummary(assignmentId);
}

export async function preparePracticeWorksheet(
  assignmentId: string,
): Promise<PracticeAssignmentSummary> {
  const client = requireClient();
  const { data, error } = await client.functions.invoke<{
    error?: string;
    error_code?: string;
    assignment_id?: string;
    job_id?: string | null;
    generation_status?: PracticeGenerationStatus;
  }>("generate-practice-worksheet", {
    body: { assignment_id: assignmentId },
  });

  if (error || data?.error) {
    const currentAssignment = await getPracticeAssignmentSummary(
      assignmentId,
    ).catch(() => null);
    if (
      currentAssignment &&
      hasDurableWorksheetPreparationState(currentAssignment)
    ) {
      return currentAssignment;
    }
    if (error) throw error;
    if (data?.error_code === "worksheet_generation_retry_limit_exceeded") {
      throw new PublicAppError(
        "data_rate_limited",
        "Automatic worksheet retries are exhausted. Your teacher can review this practice topic while approved material is checked.",
      );
    }
    throw new PublicAppError(
      "data_request_failed",
      data?.error ?? "Worksheet preparation could not be started.",
    );
  }
  if (
    data?.assignment_id !== assignmentId ||
    !data.generation_status ||
    !["queued", "generating", "ready", "needs_review"].includes(
      data.generation_status,
    )
  ) {
    throw new Error(
      "Worksheet preparation did not return a valid durable state.",
    );
  }

  const currentAssignment = await getPracticeAssignmentSummary(assignmentId);
  return {
    ...currentAssignment,
    generation_status: data.generation_status,
  };
}

export async function listWorkspacePracticeAssignments(
  workspaceId: string,
): Promise<PracticeAssignmentSummary[]> {
  const assignments: PracticeAssignmentSummary[] = [];
  let cursor: { updated_at: string; id: string } | null = null;

  do {
    const value: unknown = await callApiRpc<unknown>(
      "list_workspace_practice_assignments_page",
      {
        target_workspace_id: workspaceId,
        requested_page_size: PRACTICE_ASSIGNMENT_PAGE_SIZE,
        cursor_updated_at: cursor?.updated_at ?? null,
        cursor_assignment_id: cursor?.id ?? null,
      },
      "Workspace practice assignments could not be loaded. Please try again.",
    );
    const page: ApiPage<unknown> = parseApiPage<unknown>(
      value,
      "Workspace practice assignments",
    );
    assignments.push(...page.items.map(mapApiAssignment));
    if (!page.has_more) break;

    const next: ApiKeysetCursor | null = page.next_cursor;
    if (
      !next ||
      typeof next.updated_at !== "string" ||
      typeof next.id !== "string" ||
      (cursor?.updated_at === next.updated_at && cursor.id === next.id)
    ) {
      parseApiPage(null, "Workspace practice assignments");
    }
    cursor = { updated_at: next!.updated_at!, id: next!.id };
  } while (cursor);

  return assignments;
}

export async function startPracticeAssignment(
  assignmentId: string,
): Promise<PracticeAssignmentSummary> {
  const value = await callApiRpc<unknown>(
    "start_practice_assignment",
    { target_assignment_id: assignmentId },
    "Practice could not be started. Please try again.",
  );
  return mapApiAssignment(value);
}

export async function getPracticeDraft(
  assignmentId: string,
): Promise<PracticeDraft | null> {
  const value = await callApiRpc<unknown>(
    "get_practice_draft",
    { target_assignment_id: assignmentId },
    "Saved worksheet answers could not be loaded. Please try again.",
  );
  const rows = parseApiArray<Record<string, unknown>>(value, "Practice draft");
  if (rows.length > 1) {
    throw new PublicAppError(
      "data_invalid_response",
      "Practice draft returned an invalid response. Please refresh and try again.",
    );
  }
  const row = rows[0];
  if (!row) return null;
  if (typeof row.draft_id !== "string" || row.assignment_id !== assignmentId) {
    throw new PublicAppError(
      "data_invalid_response",
      "Practice draft returned an invalid response. Please refresh and try again.",
    );
  }
  return {
    draft_id: row.draft_id,
    assignment_id: assignmentId,
    revision: parsePositiveRevision(row.revision, "Practice draft"),
    answers: parsePracticeAnswers(row.answers, "Practice draft"),
    updated_at: parseDraftTimestamp(row.updated_at, "Practice draft"),
  };
}

export async function savePracticeDraft(
  assignmentId: string,
  answers: PracticeAnswerInput[],
  expectedRevision: number,
): Promise<SavedPracticeDraft> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new PublicAppError(
      "data_invalid_request",
      "The worksheet draft revision is invalid. Refresh and try again.",
    );
  }
  const value = await callApiRpc<unknown>(
    "save_practice_draft",
    {
      target_assignment_id: assignmentId,
      submitted_answers: answers as unknown as Json,
      expected_revision: expectedRevision,
    },
    "Worksheet answers could not be saved. Please try again.",
  );
  const rows = parseApiArray<Record<string, unknown>>(
    value,
    "Practice draft save",
  );
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    typeof row.draft_id !== "string" ||
    row.assignment_id !== assignmentId
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Practice draft save returned an invalid response. Please refresh and try again.",
    );
  }
  const savedAt = parseDraftTimestamp(row.saved_at, "Practice draft save");
  return {
    draft_id: row.draft_id,
    assignment_id: assignmentId,
    revision: parsePositiveRevision(row.saved_revision, "Practice draft save"),
    answers: parsePracticeAnswers(row.answers, "Practice draft save"),
    updated_at: savedAt,
    saved_at: savedAt,
  };
}

export async function submitPracticeAttempt(
  assignmentId: string,
  expectedRevision: number,
): Promise<PracticeAssignmentSummary> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new PublicAppError(
      "data_invalid_request",
      "The worksheet draft revision is invalid. Refresh and try again.",
    );
  }
  const value = await callApiRpc<unknown>(
    "submit_practice_attempt",
    {
      target_assignment_id: assignmentId,
      expected_revision: expectedRevision,
    },
    "Practice answers could not be submitted. Please try again.",
  );
  const result = mapApiAssignment(value);
  if (result.id !== assignmentId) {
    throw new PublicAppError(
      "data_invalid_response",
      "Practice submission returned an invalid response. Please refresh and try again.",
    );
  }
  return result;
}

export async function createNextPracticeAssignment(
  assignmentId: string,
): Promise<PracticeAssignmentSummary> {
  const value = await callApiRpc<unknown>(
    "create_next_practice_assignment",
    { target_assignment_id: assignmentId },
    "The next practice assignment could not be created. Please try again.",
  );
  return mapApiAssignment(value);
}

export async function getChildPracticeAssignment(
  assignmentId: string,
): Promise<PracticeAssignmentSummary | null> {
  const value = await callApiRpc<unknown>(
    "get_child_practice_assignment",
    { target_previous_assignment_id: assignmentId },
    "The next practice assignment could not be loaded. Please try again.",
  );
  return value == null ? null : mapApiAssignment(value);
}

export async function evaluatePracticeAttempt(assignmentId: string): Promise<{
  accepted: true;
  assignment_id: string;
  attempt_id: string;
  status: PracticeEvaluationStatus;
  evaluation_status: PracticeEvaluationStatus;
  evaluated: boolean;
}> {
  const client = requireClient();
  const { data, error } = await client.functions.invoke<{
    error?: string;
    accepted?: boolean;
    assignment_id?: string;
    attempt_id?: string;
    status?: PracticeEvaluationStatus;
    evaluation_status?: PracticeEvaluationStatus;
    evaluated?: boolean;
  }>("evaluate-practice-attempt", {
    body: { assignment_id: assignmentId },
  });

  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  if (
    data?.accepted !== true ||
    data.assignment_id !== assignmentId ||
    !data.attempt_id ||
    !data.status ||
    data.evaluation_status !== data.status ||
    !["queued", "evaluating", "completed", "not_needed", "failed"].includes(
      data.status,
    )
  ) {
    throw new Error("Practice feedback did not return a valid durable state.");
  }
  return {
    accepted: true,
    assignment_id: data.assignment_id,
    attempt_id: data.attempt_id,
    status: data.status,
    evaluation_status: data.evaluation_status,
    evaluated: Boolean(data?.evaluated),
  };
}

export async function getPracticeWorksheetDetail(
  assignmentId: string,
): Promise<PracticeWorksheetDetail> {
  const summary = await getPracticeAssignmentSummary(assignmentId);
  if (!summary.practice_test_id) {
    return { assignment: summary, questions: [] };
  }

  const value = await callApiRpc<unknown>(
    "get_practice_assignment_questions",
    { target_assignment_id: assignmentId },
    "Worksheet questions could not be loaded. Please try again.",
  );
  const safeQuestions = parseApiArray<PracticeQuestionRpcRow>(
    value,
    "Worksheet questions",
  );

  return {
    assignment: {
      ...summary,
      question_count: safeQuestions.length,
    },
    questions: safeQuestions.map((question) => ({
      id: question.id,
      question_number: question.question_number,
      question_type: question.question_type,
      prompt: question.prompt,
      options: parseOptions(question.options),
    })),
  };
}

export async function getPracticeWorksheetReview(
  assignmentId: string,
): Promise<PracticeWorksheetDetail> {
  const value = await callApiRpc<unknown>(
    "get_practice_assignment_review",
    { target_assignment_id: assignmentId },
    "Worksheet review could not be loaded. Please try again.",
  );
  const reviewRows = parseApiArray<PracticeReviewRpcRow>(
    value,
    "Worksheet review",
  );
  const firstRow = reviewRows[0];
  if (!firstRow) throw new Error("Worksheet review is not available yet.");

  const currentAssignment = await getPracticeAssignmentSummary(assignmentId);
  const assignment: PracticeAssignmentSummary = {
    ...currentAssignment,
    question_count: reviewRows.length,
    latest_attempt_id: firstRow.latest_attempt_id,
    latest_attempt_status: normalizeAttemptStatus(
      firstRow.latest_attempt_status,
    ),
    score: firstRow.score,
    max_score: firstRow.max_score,
    score_points: asNullableNumber(
      (firstRow as PracticeReviewRpcRow & { score_points?: unknown })
        .score_points,
    ),
    max_score_points: asNullableNumber(
      (firstRow as PracticeReviewRpcRow & { max_score_points?: unknown })
        .max_score_points,
    ),
    scoring_version: asNullableString(
      (firstRow as PracticeReviewRpcRow & { scoring_version?: unknown })
        .scoring_version,
    ),
    evaluation_status: asNullableString(
      (firstRow as PracticeReviewRpcRow & { evaluation_status?: unknown })
        .evaluation_status,
    ),
    evaluation_error: asNullableString(
      (firstRow as PracticeReviewRpcRow & { evaluation_error?: unknown })
        .evaluation_error,
    ),
    score_percent: firstRow.score_percent,
    passed: firstRow.passed,
  };

  return {
    assignment: {
      ...assignment,
      question_count: reviewRows.length,
    },
    questions: reviewRows.map((question) => ({
      id: question.question_id,
      question_number: question.question_number,
      question_type: question.question_type,
      prompt: question.prompt,
      options: parseOptions(question.options),
      student_answer: question.student_answer,
      correct_answer: question.correct_answer,
      explanation: question.explanation,
      is_correct: question.is_correct,
      review_status: question.review_status,
      points_awarded: asNullableNumber(
        (question as PracticeReviewRpcRow & { points_awarded?: unknown })
          .points_awarded,
      ),
      max_points: asNullableNumber(
        (question as PracticeReviewRpcRow & { max_points?: unknown })
          .max_points,
      ),
      feedback_text: asNullableString(
        (question as PracticeReviewRpcRow & { feedback_text?: unknown })
          .feedback_text,
      ),
      corrected_answer: asNullableString(
        (question as PracticeReviewRpcRow & { corrected_answer?: unknown })
          .corrected_answer,
      ),
      model_answer: asNullableString(
        (question as PracticeReviewRpcRow & { model_answer?: unknown })
          .model_answer,
      ),
      short_reason: asNullableString(
        (question as PracticeReviewRpcRow & { short_reason?: unknown })
          .short_reason,
      ),
      evaluator_source: asNullableString(
        (question as PracticeReviewRpcRow & { evaluator_source?: unknown })
          .evaluator_source,
      ),
    })),
  };
}

export async function getPracticeTeacherActions(
  assignmentId: string,
): Promise<PracticeTeacherActionHistory> {
  const value = await callApiRpc<unknown>(
    "get_practice_teacher_actions",
    { target_assignment_id: assignmentId },
    "Teacher worksheet history could not be loaded. Please try again.",
  );
  return parsePracticeTeacherActionHistory(value, assignmentId);
}

export async function getPracticeSemanticReviewDraft(
  assignmentId: string,
): Promise<PracticeSemanticReviewDraft> {
  const value = await callApiRpc<unknown>(
    "get_practice_semantic_review_draft",
    { target_assignment_id: assignmentId },
    "The held answer review could not be loaded. Please try again.",
  );
  const row = parseApiRecord<Record<string, unknown>>(
    value,
    "Held answer review",
  );
  if (
    row.schema_version !== 1 ||
    row.assignment_id !== assignmentId ||
    typeof row.attempt_id !== "string" ||
    typeof row.hold_reason_code !== "string"
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "The held answer review returned an invalid response. Please refresh and try again.",
    );
  }

  const questions = parseApiArray<unknown>(
    row.questions,
    "Held answer review",
  ).map((value): PracticeSemanticReviewQuestion => {
    const question = parseApiRecord<Record<string, unknown>>(
      value,
      "Held answer question",
    );
    if (
      typeof question.question_id !== "string" ||
      typeof question.question_number !== "number" ||
      !Number.isSafeInteger(question.question_number) ||
      question.question_number < 1 ||
      typeof question.question_type !== "string" ||
      typeof question.prompt !== "string" ||
      typeof question.student_answer !== "string"
    ) {
      throw new PublicAppError(
        "data_invalid_response",
        "A held answer question returned an invalid response. Please refresh and try again.",
      );
    }
    let rubric: PracticeSemanticReviewQuestion["rubric"] = null;
    if (question.rubric != null) {
      const rubricRow = parseApiRecord<Record<string, unknown>>(
        question.rubric,
        "Held answer rubric",
      );
      const criteria = parseApiArray<unknown>(
        rubricRow.criteria,
        "Held answer rubric",
      );
      if (criteria.some((criterion) => typeof criterion !== "string")) {
        throw new PublicAppError(
          "data_invalid_response",
          "The held answer rubric returned an invalid response. Please refresh and try again.",
        );
      }
      rubric = {
        criteria: criteria as string[],
        sample_answer: asNullableString(rubricRow.sample_answer),
      };
    }
    return {
      question_id: question.question_id,
      question_number: question.question_number,
      question_type: question.question_type,
      prompt: question.prompt,
      student_answer: question.student_answer,
      rubric,
      sample_answer: asNullableString(question.sample_answer),
      explanation: asNullableString(question.explanation),
    };
  });
  if (questions.length < 1 || questions.length > 3) {
    throw new PublicAppError(
      "data_invalid_response",
      "The held answer review returned an invalid question count. Please refresh and try again.",
    );
  }

  return {
    assignment_id: assignmentId,
    attempt_id: row.attempt_id,
    evaluation_version: parsePositiveRevision(
      row.evaluation_version,
      "Held answer review",
    ),
    hold_reason_code: row.hold_reason_code,
    current_action_revision: parseTeacherActionRevision(
      row.current_action_revision,
      "Held answer review",
      true,
    ),
    questions,
  };
}

const semanticReviewPoints: Record<PracticeSemanticReviewStatus, number> = {
  correct: 1,
  minor_punctuation: 1,
  partially_correct: 0.5,
  capitalization_issue: 0.5,
  incorrect: 0,
};

export async function finalizePracticeSemanticReview(input: {
  assignmentId: string;
  commandId: string;
  expectedActionRevision: number;
  reason: string;
  reviews: PracticeSemanticReviewDecision[];
}): Promise<PracticeSemanticReviewResult> {
  const reason = input.reason.trim();
  if (
    reason.length < 8 ||
    reason.length > 1000 ||
    !Number.isSafeInteger(input.expectedActionRevision) ||
    input.expectedActionRevision < 0 ||
    input.reviews.length < 1 ||
    input.reviews.length > 3 ||
    new Set(input.reviews.map((review) => review.question_id)).size !==
      input.reviews.length ||
    input.reviews.some(
      (review) =>
        !Object.hasOwn(semanticReviewPoints, review.review_status) ||
        review.feedback_text.trim().length < 1 ||
        review.feedback_text.trim().length > 500 ||
        review.short_reason.trim().length < 1 ||
        review.short_reason.trim().length > 240 ||
        (review.review_status !== "correct" &&
          !review.corrected_answer?.trim()),
    )
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "Complete every held answer with a rubric-based verdict, correction, feedback, and audit reason.",
    );
  }

  const value = await callApiRpc<unknown>(
    "finalize_practice_semantic_review",
    {
      target_assignment_id: input.assignmentId,
      command_id: input.commandId,
      expected_action_revision: input.expectedActionRevision,
      review_reason: reason,
      reviews: input.reviews.map((review) => ({
        question_id: review.question_id,
        review_status: review.review_status,
        points_awarded: semanticReviewPoints[review.review_status],
        max_points: 1,
        feedback_text: review.feedback_text.trim(),
        corrected_answer:
          review.review_status === "correct"
            ? null
            : review.corrected_answer?.trim() || null,
        model_answer: review.model_answer?.trim() || null,
        short_reason: review.short_reason.trim(),
      })),
    },
    "The held answer review could not be finalized. Please try again.",
  );
  const row = parseApiRecord<Record<string, unknown>>(
    value,
    "Held answer finalization",
  );
  const scorePoints = asNullableNumber(row.score_points);
  const maxScorePoints = asNullableNumber(row.max_score_points);
  const scorePercent = asNullableNumber(row.score_percent);
  if (
    row.schema_version !== 1 ||
    row.assignment_id !== input.assignmentId ||
    typeof row.action_id !== "string" ||
    typeof row.attempt_id !== "string" ||
    row.evaluation_status !== "completed" ||
    row.attempt_status !== "checked" ||
    !["passed", "failed"].includes(String(row.assignment_status)) ||
    scorePoints == null ||
    maxScorePoints == null ||
    scorePercent == null ||
    typeof row.passed !== "boolean"
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "The held answer finalization returned an invalid response. Please refresh and try again.",
    );
  }
  return {
    action_id: row.action_id,
    action_revision: parseTeacherActionRevision(
      row.action_revision,
      "Held answer finalization",
    ),
    assignment_id: input.assignmentId,
    attempt_id: row.attempt_id,
    evaluation_status: "completed",
    attempt_status: "checked",
    assignment_status: row.assignment_status as "passed" | "failed",
    score_points: scorePoints,
    max_score_points: maxScorePoints,
    score_percent: scorePercent,
    passed: row.passed,
  };
}

export async function overridePracticeAttemptScore(
  assignmentId: string,
  scorePercent: number,
  reason: string,
  expectedActionRevision: number,
): Promise<PracticeScoreOverrideResult> {
  if (
    !Number.isFinite(scorePercent) ||
    scorePercent < 0 ||
    scorePercent > 100 ||
    reason.trim().length < 8 ||
    !Number.isSafeInteger(expectedActionRevision) ||
    expectedActionRevision < 0
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "Enter a score from 0 to 100 and a short reason for the audit history.",
    );
  }

  const value = await callApiRpc<unknown>(
    "override_practice_attempt_score",
    {
      target_assignment_id: assignmentId,
      target_score_percent: scorePercent,
      override_reason: reason.trim(),
      expected_action_revision: expectedActionRevision,
    },
    "The worksheet score could not be updated. Please try again.",
  );
  const row = parseApiRecord<Record<string, unknown>>(
    value,
    "Worksheet score override",
  );
  if (
    row.schema_version !== 1 ||
    row.assignment_id !== assignmentId ||
    typeof row.action_id !== "string" ||
    typeof row.attempt_id !== "string" ||
    typeof row.score_points !== "number" ||
    typeof row.max_score_points !== "number" ||
    typeof row.score_percent !== "number" ||
    typeof row.passed !== "boolean" ||
    !["passed", "failed"].includes(
      typeof row.assignment_status === "string" ? row.assignment_status : "",
    )
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Worksheet score override returned an invalid response. Please refresh and try again.",
    );
  }

  return {
    action_id: row.action_id,
    action_revision: parseTeacherActionRevision(
      row.action_revision,
      "Worksheet score override",
    ),
    assignment_id: assignmentId,
    attempt_id: row.attempt_id,
    score_points: row.score_points,
    max_score_points: row.max_score_points,
    score_percent: row.score_percent,
    passed: row.passed,
    assignment_status: row.assignment_status as "passed" | "failed",
    follow_up_assignment_id: asNullableString(row.follow_up_assignment_id),
  };
}

export async function reassignPracticeAssignment(
  assignmentId: string,
  reason: string,
  expectedActionRevision: number,
): Promise<{ action_revision: number; replacement_assignment_id: string }> {
  if (
    reason.trim().length < 8 ||
    !Number.isSafeInteger(expectedActionRevision) ||
    expectedActionRevision < 0
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "Add a short reason before reassigning this worksheet.",
    );
  }

  const value = await callApiRpc<unknown>(
    "reassign_practice_assignment",
    {
      target_assignment_id: assignmentId,
      reassignment_reason: reason.trim(),
      expected_action_revision: expectedActionRevision,
    },
    "The follow-up worksheet could not be assigned. Please try again.",
  );
  const row = parseApiRecord<Record<string, unknown>>(
    value,
    "Worksheet reassignment",
  );
  if (
    row.schema_version !== 1 ||
    row.assignment_id !== assignmentId ||
    typeof row.replacement_assignment_id !== "string"
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Worksheet reassignment returned an invalid response. Please refresh and try again.",
    );
  }
  return {
    action_revision: parseTeacherActionRevision(
      row.action_revision,
      "Worksheet reassignment",
    ),
    replacement_assignment_id: row.replacement_assignment_id,
  };
}

export async function resolvePracticeSupport(
  assignmentId: string,
  resolution: PracticeSupportResolution,
  notes: string,
  expectedActionRevision: number,
): Promise<{ action_revision: number; support_status: "resolved" }> {
  if (
    !["reassigned", "contacted", "not_needed"].includes(resolution) ||
    notes.trim().length > 1000 ||
    !Number.isSafeInteger(expectedActionRevision) ||
    expectedActionRevision < 0
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "The support resolution is invalid. Review it and try again.",
    );
  }

  const value = await callApiRpc<unknown>(
    "resolve_practice_support",
    {
      target_assignment_id: assignmentId,
      support_resolution: resolution,
      support_notes: notes.trim() || null,
      expected_action_revision: expectedActionRevision,
    },
    "The support recommendation could not be resolved. Please try again.",
  );
  const row = parseApiRecord<Record<string, unknown>>(
    value,
    "Support resolution",
  );
  if (
    row.schema_version !== 1 ||
    row.assignment_id !== assignmentId ||
    row.support_status !== "resolved" ||
    row.resolution !== resolution
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Support resolution returned an invalid response. Please refresh and try again.",
    );
  }
  return {
    action_revision: parseTeacherActionRevision(
      row.action_revision,
      "Support resolution",
    ),
    support_status: "resolved",
  };
}

export function getPracticeAssignmentLabel(
  assignment: PracticeAssignmentSummary,
) {
  if (
    !assignment.practice_test_id &&
    assignment.generation_status === "generating"
  )
    return "Preparing worksheet";
  if (!assignment.practice_test_id && assignment.generation_status === "failed")
    return "Preparation failed";
  if (assignment.status === "unlocked" && !assignment.practice_test_id)
    return "Practice unlocked";
  if (assignment.status === "unlocked") return "Worksheet assigned";
  if (assignment.status === "in_progress") return "In progress";
  if (assignment.status === "passed") return "Passed";
  if (assignment.status === "failed") return "Needs more practice";
  if (
    assignment.status === "completed" &&
    (assignment.evaluation_status === "pending" ||
      assignment.evaluation_status === "queued" ||
      assignment.evaluation_status === "evaluating")
  )
    return "Preparing feedback";
  if (
    assignment.status === "completed" &&
    assignment.evaluation_status === "failed"
  )
    return "Feedback needs retry";
  if (
    assignment.status === "completed" &&
    assignment.evaluation_status === "needs_review"
  )
    return "Teacher review required";
  if (
    assignment.status === "completed" &&
    assignment.latest_attempt_status === "submitted"
  )
    return "Submitted for review";
  if (assignment.status === "completed") return "Completed";
  return "Cancelled";
}

export function getPracticeAssignmentBadgeClass(
  assignment: PracticeAssignmentSummary,
) {
  if (
    !assignment.practice_test_id &&
    assignment.generation_status === "failed"
  ) {
    return "bg-destructive/10 text-destructive border-destructive/30";
  }
  if (
    !assignment.practice_test_id &&
    assignment.generation_status === "generating"
  ) {
    return "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-700";
  }
  if (assignment.status === "passed") {
    return "bg-green-50 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-100 dark:border-green-700";
  }
  if (assignment.status === "failed") {
    return "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-100 dark:border-orange-700";
  }
  if (assignment.evaluation_status === "needs_review") {
    return "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:border-amber-700";
  }
  if (assignment.status === "in_progress") {
    return "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-700";
  }
  if (assignment.status === "cancelled") {
    return "bg-muted text-muted-foreground border-border";
  }
  return "bg-primary/10 text-primary border-primary/20";
}

export function hasTerminalPracticeResult(
  assignment: PracticeAssignmentSummary,
) {
  return (
    assignment.latest_attempt_status === "checked" &&
    (assignment.evaluation_status === "completed" ||
      assignment.evaluation_status === "not_needed")
  );
}

export function formatPracticeScore(
  assignment: PracticeAssignmentSummary,
  options: { allowProvisional?: boolean } = {},
) {
  if (!options.allowProvisional && !hasTerminalPracticeResult(assignment)) {
    return null;
  }

  const formatPointValue = (value: number) => {
    if (Number.isInteger(value)) return value.toString();
    return value.toFixed(2).replace(/\.?0+$/, "");
  };

  if (
    assignment.score_points != null &&
    assignment.max_score_points != null &&
    assignment.max_score_points > 0
  ) {
    const percent =
      assignment.score_percent ??
      (assignment.score_points * 100) / assignment.max_score_points;
    return `${formatPointValue(assignment.score_points)}/${formatPointValue(assignment.max_score_points)} (${Math.round(percent)}%)`;
  }

  if (
    assignment.score_percent == null ||
    assignment.max_score == null ||
    assignment.max_score === 0
  ) {
    return null;
  }
  return `${assignment.score ?? 0}/${assignment.max_score} (${Math.round(assignment.score_percent)}%)`;
}
