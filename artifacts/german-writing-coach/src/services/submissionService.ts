import { getSupabaseClient } from "@/lib/supabaseClient";
import type { WorkspaceLevel } from "@/lib/workspaceData";
import { PublicAppError } from "@/lib/appError";
import { callApiRpc, toPublicDataError } from "@/services/apiFacade";

const SUBMISSION_QUERY_LIMITS = {
  studentHistory: 20,
  teacherList: 25,
  maximumPageSize: 100,
} as const;

export type SubmissionQuestionSource =
  | "workspace_question"
  | "global_question"
  | "free_text";
export type WritingSubmissionStatus =
  | "draft"
  | "submitted"
  | "checking"
  | "checked"
  | "needs_review"
  | "failed";
export type WritingEvaluationStatus =
  | "queued"
  | "processing"
  | "ready"
  | "needs_review"
  | "failed";
export type WritingReleaseStatus = "held" | "scheduled" | "released";
export type FeedbackMode =
  | "immediate"
  | "automatic_delayed"
  | "teacher_review_only";
export type FeedbackLineStatus =
  | "correct"
  | "acceptable_for_level"
  | "acceptable_a1_a2"
  | "minor_issue"
  | "major_issue"
  | "unclear";

export interface CreateWritingSubmissionInput {
  questionSource: SubmissionQuestionSource;
  questionId?: string | null;
  batchId: string;
  answerText: string;
}

export interface CreatedWritingSubmission {
  submission_id: string;
  evaluation_status: WritingEvaluationStatus;
  release_status: WritingReleaseStatus;
  release_at: string | null;
}

export interface WritingDraft {
  draft_id: string;
  workspace_id: string;
  batch_id: string;
  source_type: SubmissionQuestionSource;
  source_id: string | null;
  text: string;
  revision: number;
  updated_at: string;
}

export interface WritingDraftSummary {
  draft_id: string;
  batch_id: string;
  source_type: SubmissionQuestionSource;
  source_id: string | null;
  preview: string;
  character_count: number;
  revision: number;
  updated_at: string;
}

export interface SaveWritingDraftInput extends CreateWritingSubmissionInput {
  draftId: string | null;
  expectedRevision: number;
}

export interface SavedWritingDraft {
  draft_id: string;
  workspace_id: string;
  revision: number;
  saved_at: string;
}

export interface PrepareWritingFeedbackResult {
  status: WritingSubmissionStatus | WritingEvaluationStatus;
  line_count: number;
  already_processed: boolean;
  already_processing: boolean;
}

export interface WritingSubmission {
  id: string;
  workspace_id: string;
  student_id: string;
  batch_id: string | null;
  question_id: string | null;
  global_question_id: string | null;
  question_source: SubmissionQuestionSource | null;
  mode: "predefined_question" | "free_text";
  original_text: string;
  corrected_text: string | null;
  overall_summary: string | null;
  level_detected: WorkspaceLevel | null;
  status: WritingSubmissionStatus;
  evaluation_status: WritingEvaluationStatus | null;
  release_status: WritingReleaseStatus | null;
  release_at: string | null;
  evaluation_version: number;
  automatic_retry_at?: string | null;
  automatic_retry_exhausted_at?: string | null;
  feedback_mode: FeedbackMode | null;
  feedback_scheduled_at: string | null;
  feedback_started_at: string | null;
  feedback_completed_at: string | null;
  feedback_error: string | null;
  created_at: string;
  updated_at: string;
  checked_at: string | null;
  question_title: string;
  question_prompt: string | null;
  question_level: WorkspaceLevel | null;
  question_topic: string | null;
  question_source_label: string;
  batch_name: string | null;
  batch_level: WorkspaceLevel | null;
  student_name: string | null;
  student_email: string | null;
}

export interface WritingSubmissionPage {
  items: WritingSubmission[];
  page_size: number;
  total_count: number;
  returned_count: number;
  has_more: boolean;
  next_cursor: SubmissionCursor | null;
}

export interface StudentReleasedFeedbackSummary {
  released_count: number;
  latest_submission: {
    id: string;
    created_at: string;
    question_title: string;
  } | null;
}

export interface SubmissionCursor {
  created_at: string;
  id: string;
}

export interface TeacherSubmissionPageInput {
  workspaceId: string;
  pageSize?: number;
  studentId?: string | null;
  batchId?: string | null;
  evaluationStatus?: WritingEvaluationStatus | null;
  releaseStatus?: WritingReleaseStatus | null;
  cursor?: SubmissionCursor | null;
}

export interface StudentSubmissionPageInput {
  studentId: string;
  workspaceId: string;
  pageSize?: number;
  batchId?: string | null;
  evaluationStatus?: WritingEvaluationStatus | null;
  releaseStatus?: WritingReleaseStatus | null;
  cursor?: SubmissionCursor | null;
}

export interface WritingFeedbackLine {
  id: string;
  line_number: number;
  original_line: string;
  corrected_line: string;
  status: FeedbackLineStatus;
  changed_parts: Array<{
    from: string;
    to: string;
    reason: string;
    grammar_topics: string[];
    severity: "minor" | "major" | null;
  }>;
  short_explanation: string | null;
  detailed_explanation: string | null;
  grammar_topic: string | null;
}

export interface WritingFeedbackTopic {
  id: string;
  topic: string;
  topic_slug: string;
  count: number;
  severity: "minor" | "major" | "mixed";
  simple_explanation: string | null;
}

export interface WritingFeedback {
  lines: WritingFeedbackLine[];
  grammar_topics: WritingFeedbackTopic[];
}

export interface WritingSubmissionDetail {
  submission: WritingSubmission;
  feedback: WritingFeedback | null;
}

const writingEvaluationStatuses = new Set<WritingEvaluationStatus>([
  "queued",
  "processing",
  "ready",
  "needs_review",
  "failed",
]);
const writingReleaseStatuses = new Set<WritingReleaseStatus>([
  "held",
  "scheduled",
  "released",
]);

function normalizeWritingEvaluationStatus(
  value: unknown,
): WritingEvaluationStatus {
  return typeof value === "string" &&
    writingEvaluationStatuses.has(value as WritingEvaluationStatus)
    ? (value as WritingEvaluationStatus)
    : "queued";
}

function normalizeWritingReleaseStatus(value: unknown): WritingReleaseStatus {
  return typeof value === "string" &&
    writingReleaseStatuses.has(value as WritingReleaseStatus)
    ? (value as WritingReleaseStatus)
    : "held";
}

const writingSubmissionStatuses = new Set<WritingSubmissionStatus>([
  "draft",
  "submitted",
  "checking",
  "checked",
  "needs_review",
  "failed",
]);
const feedbackModes = new Set<FeedbackMode>([
  "immediate",
  "automatic_delayed",
  "teacher_review_only",
]);
const questionSources = new Set<SubmissionQuestionSource>([
  "workspace_question",
  "global_question",
  "free_text",
]);
const workspaceLevels = new Set<WorkspaceLevel>(["A1", "A2", "B1", "B2"]);
const feedbackLineStatuses = new Set<FeedbackLineStatus>([
  "correct",
  "acceptable_for_level",
  "acceptable_a1_a2",
  "minor_issue",
  "major_issue",
  "unclear",
]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidReadModel(): never {
  throw new Error(
    "Submission data could not be loaded safely. Please refresh and try again.",
  );
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0)
    return invalidReadModel();
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredTimestamp(record: JsonRecord, key: string): string {
  const value = requiredString(record, key);
  if (Number.isNaN(Date.parse(value))) return invalidReadModel();
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

function normalizePageSize(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > SUBMISSION_QUERY_LIMITS.maximumPageSize
  ) {
    throw new Error("Page size must be between 1 and 100.");
  }
  return value;
}

function normalizeFeedbackMode(value: unknown): FeedbackMode | null {
  return typeof value === "string" && feedbackModes.has(value as FeedbackMode)
    ? (value as FeedbackMode)
    : null;
}

function normalizeWorkspaceLevel(value: unknown): WorkspaceLevel | null {
  return typeof value === "string" &&
    workspaceLevels.has(value as WorkspaceLevel)
    ? (value as WorkspaceLevel)
    : null;
}

function normalizeQuestionSource(
  value: unknown,
): SubmissionQuestionSource | null {
  return typeof value === "string" &&
    questionSources.has(value as SubmissionQuestionSource)
    ? (value as SubmissionQuestionSource)
    : null;
}

function deriveSubmissionStatus(
  value: unknown,
  evaluationStatus: WritingEvaluationStatus | null,
  releaseStatus: WritingReleaseStatus | null,
): WritingSubmissionStatus {
  const storedStatus =
    typeof value === "string" &&
    writingSubmissionStatuses.has(value as WritingSubmissionStatus)
      ? (value as WritingSubmissionStatus)
      : "submitted";

  if (storedStatus === "draft") return "draft";
  if (evaluationStatus === "failed") return "failed";
  if (evaluationStatus === "processing") return "checking";
  if (evaluationStatus === "needs_review") return "needs_review";
  if (evaluationStatus === "queued") return "submitted";
  if (evaluationStatus === "ready") {
    if (releaseStatus === "released") return "checked";
    return storedStatus === "needs_review" ? "needs_review" : "submitted";
  }

  if (storedStatus === "checked" && releaseStatus !== "released")
    return "submitted";
  return storedStatus;
}

function normalizeReleaseState(
  evaluationStatus: WritingEvaluationStatus | null,
  value: unknown,
  releaseAt: string | null,
): WritingReleaseStatus | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizeWritingReleaseStatus(value);
  if (normalized === "released" && evaluationStatus !== "ready") return "held";
  if (normalized === "scheduled" && !releaseAt) return "held";
  return normalized;
}

function formatQuestionSource(source: SubmissionQuestionSource | null) {
  if (source === "global_question") return "Global writing task";
  if (source === "workspace_question") return "Workspace writing task";
  return "Free writing";
}

function mapSubmissionRow(
  record: JsonRecord,
  detail: boolean,
): WritingSubmission {
  const evaluationStatus =
    record.evaluation_status === null || record.evaluation_status === undefined
      ? null
      : normalizeWritingEvaluationStatus(record.evaluation_status);
  const releaseAt = nullableTimestamp(record.release_at);
  const releaseStatus = normalizeReleaseState(
    evaluationStatus,
    record.release_status,
    releaseAt,
  );
  const questionSource = normalizeQuestionSource(record.question_source);
  const originalText = detail
    ? requiredString(record, "original_text")
    : (nullableString(record.original_text_excerpt) ?? "");

  return {
    id: requiredString(record, "id"),
    workspace_id: requiredString(record, "workspace_id"),
    student_id: requiredString(record, "student_id"),
    batch_id: nullableString(record.batch_id),
    question_id: nullableString(record.question_id),
    global_question_id: nullableString(record.global_question_id),
    question_source: questionSource,
    mode:
      record.mode === "predefined_question"
        ? "predefined_question"
        : "free_text",
    original_text: originalText,
    corrected_text: detail ? nullableString(record.corrected_text) : null,
    overall_summary: detail ? nullableString(record.overall_summary) : null,
    level_detected: detail
      ? normalizeWorkspaceLevel(record.level_detected)
      : null,
    status: deriveSubmissionStatus(
      record.status,
      evaluationStatus,
      releaseStatus,
    ),
    evaluation_status: evaluationStatus,
    release_status: releaseStatus,
    release_at: releaseStatus === "scheduled" ? releaseAt : null,
    evaluation_version: Math.max(
      1,
      finiteInteger(record.evaluation_version, 1),
    ),
    automatic_retry_at: detail
      ? nullableTimestamp(record.automatic_retry_at)
      : null,
    automatic_retry_exhausted_at: detail
      ? nullableTimestamp(record.automatic_retry_exhausted_at)
      : null,
    feedback_mode: normalizeFeedbackMode(record.feedback_mode),
    feedback_scheduled_at: nullableTimestamp(record.feedback_scheduled_at),
    feedback_started_at: detail
      ? nullableTimestamp(record.feedback_started_at)
      : null,
    feedback_completed_at: detail
      ? nullableTimestamp(record.feedback_completed_at)
      : null,
    feedback_error:
      record.feedback_error_code === "feedback_failed"
        ? "feedback_failed"
        : null,
    created_at: requiredTimestamp(record, "created_at"),
    updated_at: requiredTimestamp(record, "updated_at"),
    checked_at: detail ? nullableTimestamp(record.checked_at) : null,
    question_title: nullableString(record.question_title) ?? "Free Writing",
    question_prompt: detail ? nullableString(record.question_prompt) : null,
    question_level: normalizeWorkspaceLevel(record.question_level),
    question_topic: nullableString(record.question_topic),
    question_source_label:
      nullableString(record.question_source_label) ??
      formatQuestionSource(questionSource),
    batch_name: nullableString(record.batch_name),
    batch_level: normalizeWorkspaceLevel(record.batch_level),
    student_name: nullableString(record.student_name),
    student_email: nullableString(record.student_email),
  };
}

function parseChangedParts(
  value: unknown,
): WritingFeedbackLine["changed_parts"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((part) => ({
    from: nullableString(part.from) ?? "",
    to: nullableString(part.to) ?? "",
    reason: nullableString(part.reason) ?? "",
    grammar_topics: Array.isArray(part.grammar_topics)
      ? part.grammar_topics.filter(
          (topic): topic is string => typeof topic === "string" && topic.length > 0,
        )
      : [],
    severity:
      part.severity === "minor" || part.severity === "major"
        ? part.severity
        : null,
  }));
}

function parseFeedback(value: unknown): WritingFeedback | null {
  if (value === null || value === undefined) return null;
  if (
    !isRecord(value) ||
    !Array.isArray(value.lines) ||
    !Array.isArray(value.grammar_topics)
  ) {
    return invalidReadModel();
  }

  return {
    lines: value.lines.map((lineValue) => {
      if (!isRecord(lineValue)) return invalidReadModel();
      const topic = isRecord(lineValue.grammar_topic)
        ? nullableString(lineValue.grammar_topic.name)
        : nullableString(lineValue.grammar_topic);
      const status =
        typeof lineValue.status === "string" &&
        feedbackLineStatuses.has(lineValue.status as FeedbackLineStatus)
          ? (lineValue.status as FeedbackLineStatus)
          : "unclear";
      return {
        id: requiredString(lineValue, "id"),
        line_number: Math.max(0, finiteInteger(lineValue.line_number, 0)),
        original_line: nullableString(lineValue.original_line) ?? "",
        corrected_line: nullableString(lineValue.corrected_line) ?? "",
        status,
        changed_parts: parseChangedParts(lineValue.changed_parts),
        short_explanation: nullableString(lineValue.short_explanation),
        detailed_explanation: nullableString(lineValue.detailed_explanation),
        grammar_topic: topic,
      };
    }),
    grammar_topics: value.grammar_topics.map((topicValue) => {
      if (!isRecord(topicValue)) return invalidReadModel();
      const severity =
        topicValue.severity === "minor" ||
        topicValue.severity === "major" ||
        topicValue.severity === "mixed"
          ? topicValue.severity
          : "mixed";
      return {
        id: requiredString(topicValue, "id"),
        topic: nullableString(topicValue.topic_name) ?? "Grammar topic",
        topic_slug:
          nullableString(topicValue.topic_slug) ??
          nullableString(topicValue.topic_name) ??
          "grammar-topic",
        count: Math.max(0, finiteInteger(topicValue.count, 0)),
        severity,
        simple_explanation: nullableString(topicValue.simple_explanation),
      };
    }),
  };
}

function parseCursor(value: unknown): SubmissionCursor | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return invalidReadModel();
  return {
    created_at: requiredTimestamp(value, "created_at"),
    id: requiredString(value, "id"),
  };
}

function parseSubmissionPage(value: unknown): WritingSubmissionPage {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    !Array.isArray(value.items)
  ) {
    return invalidReadModel();
  }
  const pageSize = finiteInteger(value.page_size, 0);
  const totalCount = finiteInteger(value.total_count, -1);
  const returnedCount = finiteInteger(value.returned_count, -1);
  const hasMore = value.has_more === true;
  const nextCursor = parseCursor(value.next_cursor);
  const items = value.items.map((item) => {
    if (!isRecord(item)) return invalidReadModel();
    return mapSubmissionRow(item, false);
  });
  const uniqueIds = new Set(items.map((item) => item.id));

  if (
    pageSize < 1 ||
    pageSize > SUBMISSION_QUERY_LIMITS.maximumPageSize ||
    totalCount < items.length ||
    returnedCount !== items.length ||
    uniqueIds.size !== items.length ||
    hasMore !== Boolean(nextCursor)
  ) {
    return invalidReadModel();
  }

  return {
    items,
    page_size: pageSize,
    total_count: totalCount,
    returned_count: returnedCount,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

function parseSubmissionDetail(value: unknown): WritingSubmissionDetail {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    !isRecord(value.submission)
  ) {
    return invalidReadModel();
  }
  const submission = mapSubmissionRow(value.submission, true);
  // Released feedback and private drafts are different contracts. The teacher
  // detail RPC may project an empty feedback envelope while a private draft is
  // awaiting review or its scheduled release. Treating that envelope as
  // released feedback hides the draft controls and renders a misleading empty
  // result, so unreleased content is read only through get_feedback_draft.
  const feedback = submission.release_status === "released"
    ? parseFeedback(value.feedback)
    : null;

  if (!feedback) {
    submission.corrected_text = null;
    submission.overall_summary = null;
    submission.level_detected = null;
    submission.checked_at = null;
  }

  return { submission, feedback };
}

function throwSubmissionReadError(error: unknown, fallback: string): never {
  const code = isRecord(error) ? nullableString(error.code) : null;
  if (code === "42501") {
    throw new Error("You do not have access to this submission.");
  }
  if (code === "28000" || code === "PGRST301") {
    throw new Error("Your session has expired. Please sign in again.");
  }
  if (code === "22023") {
    throw new Error(
      "The submission request was invalid. Please refresh and try again.",
    );
  }
  throw new Error(fallback);
}

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error(
      "The application service is not configured. Please contact support.",
    );
  }
  return client;
}

async function kickWritingJobProcessor(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
) {
  try {
    // functions.invoke uses this client's active user session JWT. The durable
    // database queue is already committed, so a relay or network failure here
    // must never turn the accepted submission into a client-visible failure.
    // The JWT-gated relay rate-limits the caller; the internal worker claims
    // the next fixed-queue message without accepting an entity identifier.
    await client.functions.invoke("kick-writing-jobs", { body: {} });
  } catch {
    // Recovery consumers will process the durable queue if this immediate kick
    // cannot reach the worker.
  }
}

function draftRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value;
}

function draftRows(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value) || value.some((row) => !isRecord(row))) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value as JsonRecord[];
}

function positiveRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value;
}

function draftSource(value: unknown, label: string): SubmissionQuestionSource {
  if (
    typeof value !== "string" ||
    !questionSources.has(value as SubmissionQuestionSource)
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value as SubmissionQuestionSource;
}

function draftTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value;
}

function parseWritingDraftRow(value: unknown): WritingDraft {
  const row = draftRecord(value, "Writing draft");
  const sourceType = draftSource(row.source_type, "Writing draft");
  const sourceId = nullableString(row.source_id);
  if (
    typeof row.draft_id !== "string" ||
    typeof row.workspace_id !== "string" ||
    typeof row.batch_id !== "string" ||
    typeof row.text !== "string" ||
    (sourceType === "free_text" ? sourceId !== null : sourceId === null)
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Writing draft returned an invalid response. Please refresh and try again.",
    );
  }
  return {
    draft_id: row.draft_id,
    workspace_id: row.workspace_id,
    batch_id: row.batch_id,
    source_type: sourceType,
    source_id: sourceId,
    text: row.text,
    revision: positiveRevision(row.revision, "Writing draft"),
    updated_at: draftTimestamp(row.updated_at, "Writing draft"),
  };
}

function parseCreatedSubmission(value: unknown): CreatedWritingSubmission {
  const row = draftRecord(value, "Writing submission");
  if (typeof row.submission_id !== "string") {
    throw new PublicAppError(
      "data_invalid_response",
      "Writing submission returned an invalid response. Please refresh and try again.",
    );
  }
  const evaluationStatus = normalizeWritingEvaluationStatus(
    row.evaluation_status,
  );
  const returnedReleaseStatus = normalizeWritingReleaseStatus(
    row.release_status,
  );
  const releaseAt = typeof row.release_at === "string" ? row.release_at : null;
  const releaseStatus =
    returnedReleaseStatus === "released" && evaluationStatus !== "ready"
      ? "held"
      : returnedReleaseStatus === "scheduled" && !releaseAt
        ? "held"
        : returnedReleaseStatus;
  return {
    submission_id: row.submission_id,
    evaluation_status: evaluationStatus,
    release_status: releaseStatus,
    release_at: releaseStatus === "scheduled" ? releaseAt : null,
  };
}

export async function getWritingDraft(
  draftId: string,
): Promise<WritingDraft | null> {
  const client = requireClient();
  const { data, error } = await client.rpc("get_writing_draft", {
    target_draft_id: draftId,
  });
  if (error) {
    throw toPublicDataError(
      error,
      "The writing draft could not be loaded. Please try again.",
    );
  }
  const rows = draftRows(data, "Writing draft");
  if (rows.length > 1) {
    throw new PublicAppError(
      "data_invalid_response",
      "Writing draft returned an invalid response. Please refresh and try again.",
    );
  }
  return rows[0] ? parseWritingDraftRow(rows[0]) : null;
}

export async function getWritingDraftByContext(
  workspaceId: string,
  batchId: string,
  sourceType: SubmissionQuestionSource,
  sourceId: string | null,
): Promise<WritingDraft | null> {
  const client = requireClient();
  const { data, error } = await client.rpc("get_writing_draft_by_context", {
    target_workspace_id: workspaceId,
    target_batch_id: batchId,
    target_source_type: sourceType,
    target_source_id: sourceId,
  });
  if (error) {
    throw toPublicDataError(
      error,
      "The writing draft could not be restored. Please try again.",
    );
  }
  const rows = draftRows(data, "Writing draft context");
  if (rows.length > 1) {
    throw new PublicAppError(
      "data_invalid_response",
      "Writing draft context returned an invalid response. Please refresh and try again.",
    );
  }
  return rows[0] ? parseWritingDraftRow(rows[0]) : null;
}

export async function listMyWritingDrafts(
  workspaceId: string,
  pageSize = 25,
): Promise<WritingDraftSummary[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new PublicAppError(
      "data_invalid_request",
      "Draft page size must be between 1 and 100.",
    );
  }
  const client = requireClient();
  const { data, error } = await client.rpc("list_my_writing_drafts", {
    target_workspace_id: workspaceId,
    page_size: pageSize,
  });
  if (error) {
    throw toPublicDataError(
      error,
      "Writing drafts could not be loaded. Please try again.",
    );
  }
  return draftRows(data, "Writing drafts").map((row) => {
    const sourceType = draftSource(row.source_type, "Writing drafts");
    const sourceId = nullableString(row.source_id);
    if (
      typeof row.draft_id !== "string" ||
      typeof row.batch_id !== "string" ||
      typeof row.preview !== "string" ||
      typeof row.character_count !== "number" ||
      !Number.isSafeInteger(row.character_count) ||
      row.character_count < 0 ||
      (sourceType === "free_text" ? sourceId !== null : sourceId === null)
    ) {
      throw new PublicAppError(
        "data_invalid_response",
        "Writing drafts returned an invalid response. Please refresh and try again.",
      );
    }
    return {
      draft_id: row.draft_id,
      batch_id: row.batch_id,
      source_type: sourceType,
      source_id: sourceId,
      preview: row.preview,
      character_count: row.character_count,
      revision: positiveRevision(row.revision, "Writing drafts"),
      updated_at: draftTimestamp(row.updated_at, "Writing drafts"),
    };
  });
}

export async function saveWritingDraft(
  input: SaveWritingDraftInput,
): Promise<SavedWritingDraft> {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "The draft revision is invalid. Refresh and try again.",
    );
  }
  const client = requireClient();
  const { data, error } = await client.rpc("save_writing_draft", {
    draft_id: input.draftId,
    batch_id: input.batchId,
    source_type: input.questionSource,
    source_id: input.questionId ?? null,
    // Preserve the student's exact UTF-16/Unicode text, whitespace, and line endings.
    text: input.answerText,
    expected_revision: input.expectedRevision,
  });
  if (error) {
    throw toPublicDataError(
      error,
      "The writing draft could not be saved. Please try again.",
    );
  }
  const rows = draftRows(data, "Writing draft save");
  if (rows.length !== 1) {
    throw new PublicAppError(
      "data_invalid_response",
      "Writing draft save returned an invalid response. Please refresh and try again.",
    );
  }
  const row = rows[0];
  if (
    typeof row.saved_draft_id !== "string" ||
    typeof row.workspace_id !== "string"
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Writing draft save returned an invalid response. Please refresh and try again.",
    );
  }
  return {
    draft_id: row.saved_draft_id,
    workspace_id: row.workspace_id,
    revision: positiveRevision(row.saved_revision, "Writing draft save"),
    saved_at: draftTimestamp(row.saved_at, "Writing draft save"),
  };
}

export async function submitWritingDraft(
  draftId: string,
  expectedRevision: number,
): Promise<CreatedWritingSubmission> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new PublicAppError(
      "data_invalid_request",
      "The draft revision is invalid. Refresh and try again.",
    );
  }
  const client = requireClient();
  const { data, error } = await client.rpc("submit_writing_draft", {
    target_draft_id: draftId,
    expected_revision: expectedRevision,
  });
  if (error) {
    throw toPublicDataError(
      error,
      "The writing draft could not be submitted. Please try again.",
    );
  }
  const rows = draftRows(data, "Writing draft submission");
  if (rows.length !== 1) {
    throw new PublicAppError(
      "data_invalid_response",
      "Writing draft submission returned an invalid response. Please refresh and try again.",
    );
  }
  const submission = parseCreatedSubmission(rows[0]);
  void kickWritingJobProcessor(client);
  return submission;
}

export async function createWritingSubmission(
  input: CreateWritingSubmissionInput,
): Promise<CreatedWritingSubmission> {
  const client = requireClient();
  const { data, error } = await client
    .schema("api")
    .rpc("submit_writing", {
      batch_id: input.batchId,
      source_type: input.questionSource,
      source_id: input.questionId ?? null,
      text: input.answerText,
    })
    .single();

  if (error) {
    throw toPublicDataError(
      error,
      "The writing could not be submitted. Please try again.",
    );
  }

  const submission = parseCreatedSubmission(data);

  void kickWritingJobProcessor(client);
  return submission;
}

export async function listStudentSubmissions(
  studentId: string,
  workspaceId: string,
  limit: number = SUBMISSION_QUERY_LIMITS.studentHistory,
): Promise<WritingSubmission[]> {
  const page = await listStudentSubmissionsPage({
    studentId,
    workspaceId,
    pageSize: limit,
  });
  return page.items;
}

export async function listStudentSubmissionsPage(
  input: StudentSubmissionPageInput,
): Promise<WritingSubmissionPage> {
  const client = requireClient();
  const pageSize = normalizePageSize(
    input.pageSize,
    SUBMISSION_QUERY_LIMITS.studentHistory,
  );
  const cursor = input.cursor ? parseCursor(input.cursor) : null;
  const { data, error } = await client
    .schema("api")
    .rpc("list_student_submissions_page", {
      target_workspace_id: input.workspaceId,
      target_student_id: input.studentId,
      target_batch_id: input.batchId ?? null,
      target_evaluation_status: input.evaluationStatus ?? null,
      target_release_status: input.releaseStatus ?? null,
      requested_page_size: pageSize,
      cursor_created_at: cursor?.created_at ?? null,
      cursor_id: cursor?.id ?? null,
    });

  if (error) {
    return throwSubmissionReadError(
      error,
      "Your submission history could not be loaded. Please try again.",
    );
  }
  const page = parseSubmissionPage(data);
  if (page.page_size !== pageSize) return invalidReadModel();
  if (
    cursor &&
    page.next_cursor?.created_at === cursor.created_at &&
    page.next_cursor.id === cursor.id
  )
    return invalidReadModel();
  return page;
}

export async function getStudentReleasedFeedbackSummary(
  workspaceId: string,
  studentId: string,
  batchId?: string | null,
): Promise<StudentReleasedFeedbackSummary> {
  const data = await callApiRpc<unknown>(
    "get_student_released_feedback_summary",
    {
      target_workspace_id: workspaceId,
      target_student_id: studentId,
      target_batch_id: batchId ?? null,
    },
    "Your released-feedback summary could not be loaded. Please try again.",
  );
  if (
    !isRecord(data) ||
    data.schema_version !== 1 ||
    typeof data.released_count !== "number" ||
    !Number.isSafeInteger(data.released_count) ||
    data.released_count < 0
  ) {
    return invalidReadModel();
  }
  if (data.latest_submission === null) {
    if (data.released_count !== 0) return invalidReadModel();
    return { released_count: 0, latest_submission: null };
  }
  if (!isRecord(data.latest_submission)) return invalidReadModel();
  const latest = data.latest_submission;
  if (
    data.released_count < 1 ||
    typeof latest.id !== "string" ||
    typeof latest.created_at !== "string" ||
    Number.isNaN(Date.parse(latest.created_at)) ||
    typeof latest.question_title !== "string" ||
    latest.question_title.length === 0
  ) {
    return invalidReadModel();
  }
  return {
    released_count: data.released_count,
    latest_submission: {
      id: latest.id,
      created_at: latest.created_at,
      question_title: latest.question_title,
    },
  };
}

export async function getStudentSubmissionDetail(
  submissionId: string,
  studentId: string,
  workspaceId: string,
): Promise<WritingSubmissionDetail | null> {
  const detail = await loadSubmissionDetail(submissionId);
  if (
    detail.submission.student_id !== studentId ||
    detail.submission.workspace_id !== workspaceId
  )
    return null;

  // Defense in depth: even if the API projection regresses, a student client
  // never displays feedback child rows before the released state.
  if (detail.submission.release_status !== "released") {
    detail.submission.corrected_text = null;
    detail.submission.overall_summary = null;
    detail.submission.level_detected = null;
    detail.submission.checked_at = null;
    detail.feedback = null;
  }
  return detail;
}

export async function listTeacherWorkspaceSubmissions(
  workspaceId: string,
  limit: number = SUBMISSION_QUERY_LIMITS.teacherList,
  batchId?: string | null,
): Promise<WritingSubmission[]> {
  const page = await listTeacherWorkspaceSubmissionsPage({
    workspaceId,
    pageSize: limit,
    batchId,
  });
  return page.items;
}

export async function listTeacherWorkspaceSubmissionsPage(
  input: TeacherSubmissionPageInput,
): Promise<WritingSubmissionPage> {
  const client = requireClient();
  const pageSize = normalizePageSize(
    input.pageSize,
    SUBMISSION_QUERY_LIMITS.teacherList,
  );
  const cursor = input.cursor ? parseCursor(input.cursor) : null;
  const { data, error } = await client
    .schema("api")
    .rpc("list_workspace_submissions_page", {
      target_workspace_id: input.workspaceId,
      target_student_id: input.studentId ?? null,
      target_batch_id: input.batchId ?? null,
      target_evaluation_status: input.evaluationStatus ?? null,
      target_release_status: input.releaseStatus ?? null,
      requested_page_size: pageSize,
      cursor_created_at: cursor?.created_at ?? null,
      cursor_id: cursor?.id ?? null,
    });

  if (error) {
    return throwSubmissionReadError(
      error,
      "Workspace submissions could not be loaded. Please try again.",
    );
  }
  const page = parseSubmissionPage(data);
  if (page.page_size !== pageSize) return invalidReadModel();
  if (
    cursor &&
    page.next_cursor?.created_at === cursor.created_at &&
    page.next_cursor.id === cursor.id
  )
    return invalidReadModel();
  return page;
}

export async function getTeacherSubmissionDetail(
  workspaceId: string,
  submissionId: string,
): Promise<WritingSubmissionDetail | null> {
  const detail = await loadSubmissionDetail(submissionId);
  return detail.submission.workspace_id === workspaceId ? detail : null;
}

async function loadSubmissionDetail(
  submissionId: string,
): Promise<WritingSubmissionDetail> {
  const client = requireClient();
  const { data, error } = await client
    .schema("api")
    .rpc("get_submission_detail", { target_submission_id: submissionId });

  if (error) {
    return throwSubmissionReadError(
      error,
      "This submission could not be loaded. Please try again.",
    );
  }
  return parseSubmissionDetail(data);
}

export async function prepareWritingFeedback(
  submissionId: string,
): Promise<PrepareWritingFeedbackResult> {
  const client = requireClient();
  const { data, error } = await client.functions.invoke(
    "prepare-writing-feedback",
    {
      body: { submission_id: submissionId },
    },
  );

  if (error) {
    throw new Error("Feedback could not be prepared. Please try again later.");
  }
  if (data?.error) {
    throw new Error(data.error);
  }

  return {
    status: (data?.status ??
      "checking") as PrepareWritingFeedbackResult["status"],
    line_count: Number(data?.line_count ?? 0),
    already_processed: Boolean(data?.already_processed),
    already_processing: Boolean(data?.already_processing),
  };
}
