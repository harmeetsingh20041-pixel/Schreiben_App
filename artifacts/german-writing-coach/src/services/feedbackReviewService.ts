import { diffArrays } from "diff";
import { PublicAppError } from "@/lib/appError";
import {
  sequenceDiffExceedsBudget,
  sharedSequenceBounds,
} from "@/utils/boundedDiff";
import {
  callApiRpc,
  parseApiPage,
  parseApiRecord,
  type ApiPage,
} from "@/services/apiFacade";
import type {
  FeedbackLineStatus,
  FeedbackMode,
  WritingEvaluationStatus,
  WritingReleaseStatus,
} from "@/services/submissionService";

export type FeedbackDraftState = "draft" | "needs_review" | "approved";
export type FeedbackReviewReason =
  | "teacher_review"
  | "uncertain"
  | "failed"
  | "overdue_scheduled";

export interface FeedbackTopicOption {
  slug: string;
  name: string;
}

export interface FeedbackDraftChangedPart {
  from: string;
  to: string;
  reason: string;
  grammar_topics: string[];
  severity: "minor" | "major" | null;
  source_start: number;
  source_end: number;
  corrected_start: number;
  corrected_end: number;
}

export interface FeedbackDraftLine extends Record<string, unknown> {
  line_number: number;
  source_start: number;
  source_end: number;
  original_line: string;
  corrected_line: string;
  status: FeedbackLineStatus;
  changed_parts: FeedbackDraftChangedPart[];
  short_explanation: string;
  detailed_explanation: string;
  grammar_topic: string;
}

export interface FeedbackDraftTopic {
  topic: string;
  count: number;
  minor_count?: number;
  major_count?: number;
  severity: "minor" | "major" | "mixed";
  simple_explanation: string;
}

export interface FeedbackDraftContent extends Record<string, unknown> {
  feedback_contract_version?: 2;
  overall_summary: string;
  level_detected: "A1" | "A2" | "B1" | "B2";
  corrected_text: string;
  ai_model?: string;
  lines: FeedbackDraftLine[];
  grammar_topics: FeedbackDraftTopic[];
  score_summary?: Record<string, unknown>;
}

export interface FeedbackDraft {
  id: string;
  submission_id: string;
  version: number;
  revision: number;
  state: FeedbackDraftState;
  content: FeedbackDraftContent;
  provider_model: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  released_at: string | null;
}

export interface FeedbackDraftRead {
  draft: FeedbackDraft | null;
  topic_options: FeedbackTopicOption[];
}

export interface FeedbackReleaseResult {
  submission_id: string;
  feedback_version_id: string;
  feedback_version: number;
  feedback_revision: number;
  state: "released";
  release_status: "released";
  released_at: string;
}

export interface FeedbackReviewQueueItem {
  id: string;
  workspace_id: string;
  student_id: string;
  batch_id: string | null;
  status: string;
  evaluation_status: WritingEvaluationStatus;
  release_status: WritingReleaseStatus;
  release_at: string | null;
  feedback_mode: FeedbackMode;
  review_reason: FeedbackReviewReason;
  feedback_version_id: string | null;
  feedback_version: number | null;
  feedback_revision: number | null;
  feedback_state: FeedbackDraftState | null;
  student_name: string;
  student_email: string | null;
  batch_name: string | null;
  question_title: string;
  error_code: "feedback_failed" | "scheduled_release_overdue" | null;
  created_at: string;
  updated_at: string;
}

export interface FeedbackReviewCursor {
  created_at: string;
  id: string;
}

export interface FeedbackReviewQueuePage extends Omit<
  ApiPage<FeedbackReviewQueueItem>,
  "next_cursor"
> {
  next_cursor: FeedbackReviewCursor | null;
}

type UnknownRecord = Record<string, unknown>;

const feedbackStatuses = new Set<FeedbackLineStatus>([
  "correct",
  "acceptable_for_level",
  "acceptable_a1_a2",
  "minor_issue",
  "major_issue",
  "unclear",
]);
const draftStates = new Set<FeedbackDraftState>([
  "draft",
  "needs_review",
  "approved",
]);
const reviewReasons = new Set<FeedbackReviewReason>([
  "teacher_review",
  "uncertain",
  "failed",
  "overdue_scheduled",
]);
const evaluationStatuses = new Set<WritingEvaluationStatus>([
  "queued",
  "processing",
  "ready",
  "needs_review",
  "failed",
]);
const releaseStatuses = new Set<WritingReleaseStatus>([
  "held",
  "scheduled",
  "released",
]);
const feedbackModes = new Set<FeedbackMode>([
  "immediate",
  "automatic_delayed",
  "teacher_review_only",
]);
const levels = new Set<FeedbackDraftContent["level_detected"]>([
  "A1",
  "A2",
  "B1",
  "B2",
]);
const MAX_CORRECTION_TOPICS = 6;
const MAX_CORRECTION_REASON_CHARACTERS = 4_000;

function invalidFeedbackResponse(): never {
  throw new PublicAppError(
    "data_invalid_response",
    "Feedback data could not be loaded safely. Refresh and try again.",
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return invalidFeedbackResponse();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value);
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalidFeedbackResponse();
  }
  return value;
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return positiveInteger(value);
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidFeedbackResponse();
  }
  return value;
}

function timestamp(value: unknown): string {
  const parsed = stringValue(value, false);
  if (Number.isNaN(Date.parse(parsed))) return invalidFeedbackResponse();
  return parsed;
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return timestamp(value);
}

function parseChangedPart(
  value: unknown,
  allowIncompleteV2: boolean,
): FeedbackDraftChangedPart {
  if (!isRecord(value)) return invalidFeedbackResponse();
  return {
    from: stringValue(value.from),
    to: stringValue(value.to),
    reason: stringValue(value.reason, allowIncompleteV2),
    grammar_topics: Array.isArray(value.grammar_topics)
      ? value.grammar_topics.map((topic) => stringValue(topic, false))
      : [],
    severity:
      value.severity === "minor" || value.severity === "major"
        ? value.severity
        : null,
    source_start: nonnegativeInteger(value.source_start),
    source_end: nonnegativeInteger(value.source_end),
    corrected_start: nonnegativeInteger(value.corrected_start),
    corrected_end: nonnegativeInteger(value.corrected_end),
  };
}

function parseDraftLine(
  value: unknown,
  feedbackContractVersion: 2 | undefined,
  allowIncompleteV2: boolean,
): FeedbackDraftLine {
  if (!isRecord(value) || !Array.isArray(value.changed_parts)) {
    return invalidFeedbackResponse();
  }
  if (
    typeof value.status !== "string" ||
    !feedbackStatuses.has(value.status as FeedbackLineStatus)
  ) {
    return invalidFeedbackResponse();
  }
  const status = value.status as FeedbackLineStatus;
  const legacyTopic = nullableString(value.grammar_topic) ?? "";
  const changedParts = value.changed_parts
    .map((part) => parseChangedPart(part, allowIncompleteV2))
    .map((part) =>
      feedbackContractVersion !== 2
        && (status === "minor_issue" || status === "major_issue")
        ? {
            ...part,
            grammar_topics:
              part.grammar_topics.length > 0 || !legacyTopic
                ? part.grammar_topics
                : [legacyTopic],
            severity:
              part.severity ??
              (status === "major_issue" ? "major" : "minor"),
          }
        : part,
    );
  if (
    feedbackContractVersion === 2
    && !allowIncompleteV2
    && (status === "minor_issue" || status === "major_issue")
    && changedParts.some(
      (part) =>
        !part.reason
        || part.grammar_topics.length === 0
        || part.severity === null,
    )
  ) {
    return invalidFeedbackResponse();
  }
  return {
    ...value,
    line_number: positiveInteger(value.line_number),
    source_start: nonnegativeInteger(value.source_start),
    source_end: positiveInteger(value.source_end),
    original_line: stringValue(value.original_line, false),
    corrected_line: stringValue(value.corrected_line, false),
    status,
    changed_parts: changedParts,
    short_explanation: nullableString(value.short_explanation) ?? "",
    detailed_explanation: nullableString(value.detailed_explanation) ?? "",
    grammar_topic: legacyTopic,
  };
}

function parseDraftTopic(value: unknown): FeedbackDraftTopic {
  if (!isRecord(value)) return invalidFeedbackResponse();
  const severity = value.severity;
  if (severity !== "minor" && severity !== "major" && severity !== "mixed") {
    return invalidFeedbackResponse();
  }
  return {
    topic: stringValue(value.topic, false),
    count: nonnegativeInteger(value.count),
    minor_count:
      value.minor_count === undefined
        ? value.severity === "minor"
          ? nonnegativeInteger(value.count)
          : 0
        : nonnegativeInteger(value.minor_count),
    major_count:
      value.major_count === undefined
        ? value.severity === "major" || value.severity === "mixed"
          ? nonnegativeInteger(value.count)
          : 0
        : nonnegativeInteger(value.major_count),
    severity,
    simple_explanation: nullableString(value.simple_explanation) ?? "",
  };
}

function parseDraftContent(
  value: unknown,
  draftState: FeedbackDraftState,
): FeedbackDraftContent {
  if (
    !isRecord(value) ||
    !Array.isArray(value.lines) ||
    !Array.isArray(value.grammar_topics)
  ) {
    return invalidFeedbackResponse();
  }
  if (
    typeof value.level_detected !== "string" ||
    !levels.has(value.level_detected as FeedbackDraftContent["level_detected"])
  ) {
    return invalidFeedbackResponse();
  }
  const feedbackContractVersion = value.feedback_contract_version === 2
    ? 2 as const
    : undefined;
  const allowIncompleteV2 = feedbackContractVersion === 2
    && draftState === "needs_review";
  return {
    ...value,
    overall_summary: stringValue(value.overall_summary, false),
    feedback_contract_version: feedbackContractVersion,
    level_detected:
      value.level_detected as FeedbackDraftContent["level_detected"],
    corrected_text: stringValue(value.corrected_text, false),
    ai_model: typeof value.ai_model === "string" ? value.ai_model : undefined,
    lines: value.lines.map((line) =>
      parseDraftLine(line, feedbackContractVersion, allowIncompleteV2)
    ),
    grammar_topics: value.grammar_topics.map(parseDraftTopic),
    score_summary: isRecord(value.score_summary)
      ? value.score_summary
      : undefined,
  };
}

function parseDraft(value: unknown): FeedbackDraft {
  if (!isRecord(value)) return invalidFeedbackResponse();
  if (
    typeof value.state !== "string" ||
    !draftStates.has(value.state as FeedbackDraftState)
  ) {
    return invalidFeedbackResponse();
  }
  const state = value.state as FeedbackDraftState;
  return {
    id: stringValue(value.id, false),
    submission_id: stringValue(value.submission_id, false),
    version: positiveInteger(value.version),
    revision: positiveInteger(value.revision),
    state,
    content: parseDraftContent(value.content, state),
    provider_model: nullableString(value.provider_model),
    created_at: timestamp(value.created_at),
    updated_at: timestamp(value.updated_at),
    approved_at: nullableTimestamp(value.approved_at),
    released_at: nullableTimestamp(value.released_at),
  };
}

function parseTopicOption(value: unknown): FeedbackTopicOption {
  if (!isRecord(value)) return invalidFeedbackResponse();
  return {
    slug: stringValue(value.slug, false),
    name: stringValue(value.name, false),
  };
}

function parseDraftRead(value: unknown): FeedbackDraftRead {
  const record = parseApiRecord<UnknownRecord>(value, "Feedback draft");
  if (record.schema_version !== 1 || !Array.isArray(record.topic_options)) {
    return invalidFeedbackResponse();
  }
  return {
    draft: record.draft === null ? null : parseDraft(record.draft),
    topic_options: record.topic_options.map(parseTopicOption),
  };
}

function parseDraftMutation(value: unknown): FeedbackDraft {
  const record = parseApiRecord<UnknownRecord>(value, "Feedback edit");
  if (record.schema_version !== 1) return invalidFeedbackResponse();
  return parseDraft(record.draft);
}

function parseRelease(value: unknown): FeedbackReleaseResult {
  const record = parseApiRecord<UnknownRecord>(value, "Feedback release");
  if (
    record.schema_version !== 1 ||
    record.state !== "released" ||
    record.release_status !== "released"
  )
    return invalidFeedbackResponse();
  return {
    submission_id: stringValue(record.submission_id, false),
    feedback_version_id: stringValue(record.feedback_version_id, false),
    feedback_version: positiveInteger(record.feedback_version),
    feedback_revision: positiveInteger(record.feedback_revision),
    state: "released",
    release_status: "released",
    released_at: timestamp(record.released_at),
  };
}

function parseQueueItem(value: unknown): FeedbackReviewQueueItem {
  if (!isRecord(value)) return invalidFeedbackResponse();
  if (
    typeof value.review_reason !== "string" ||
    !reviewReasons.has(value.review_reason as FeedbackReviewReason) ||
    typeof value.evaluation_status !== "string" ||
    !evaluationStatuses.has(
      value.evaluation_status as WritingEvaluationStatus,
    ) ||
    typeof value.release_status !== "string" ||
    !releaseStatuses.has(value.release_status as WritingReleaseStatus) ||
    typeof value.feedback_mode !== "string" ||
    !feedbackModes.has(value.feedback_mode as FeedbackMode)
  ) {
    return invalidFeedbackResponse();
  }
  const feedbackState = value.feedback_state;
  if (
    feedbackState !== null &&
    feedbackState !== undefined &&
    (typeof feedbackState !== "string" ||
      !draftStates.has(feedbackState as FeedbackDraftState))
  ) {
    return invalidFeedbackResponse();
  }
  return {
    id: stringValue(value.id, false),
    workspace_id: stringValue(value.workspace_id, false),
    student_id: stringValue(value.student_id, false),
    batch_id: nullableString(value.batch_id),
    status: stringValue(value.status, false),
    evaluation_status: value.evaluation_status as WritingEvaluationStatus,
    release_status: value.release_status as WritingReleaseStatus,
    release_at: nullableTimestamp(value.release_at),
    feedback_mode: value.feedback_mode as FeedbackMode,
    review_reason: value.review_reason as FeedbackReviewReason,
    feedback_version_id: nullableString(value.feedback_version_id),
    feedback_version: nullablePositiveInteger(value.feedback_version),
    feedback_revision: nullablePositiveInteger(value.feedback_revision),
    feedback_state:
      (feedbackState as FeedbackDraftState | null | undefined) ?? null,
    student_name: stringValue(value.student_name, false),
    student_email: nullableString(value.student_email),
    batch_name: nullableString(value.batch_name),
    question_title: stringValue(value.question_title, false),
    error_code:
      value.error_code === "feedback_failed"
        ? "feedback_failed"
        : value.error_code === "scheduled_release_overdue"
          ? "scheduled_release_overdue"
          : null,
    created_at: timestamp(value.created_at),
    updated_at: timestamp(value.updated_at),
  };
}

export async function getFeedbackDraft(
  submissionId: string,
): Promise<FeedbackDraftRead> {
  const value = await callApiRpc<unknown>(
    "get_feedback_draft",
    { target_submission_id: submissionId },
    "The private feedback draft could not be loaded. Please try again.",
  );
  return parseDraftRead(value);
}

export async function updateFeedbackDraft(
  feedbackVersionId: string,
  content: FeedbackDraftContent,
  expectedRevision: number,
): Promise<FeedbackDraft> {
  const value = await callApiRpc<unknown>(
    "update_feedback_draft",
    {
      feedback_version_id: feedbackVersionId,
      content,
      expected_revision: expectedRevision,
    },
    "The feedback edit could not be saved. Please try again.",
  );
  return parseDraftMutation(value);
}

export async function releaseFeedback(
  submissionId: string,
  feedbackVersionId: string,
): Promise<FeedbackReleaseResult> {
  const value = await callApiRpc<unknown>(
    "release_feedback",
    {
      submission_id: submissionId,
      feedback_version_id: feedbackVersionId,
    },
    "The feedback could not be released. Please try again.",
  );
  return parseRelease(value);
}

export async function listFeedbackReviewQueuePage(input: {
  workspaceId: string;
  reason?: FeedbackReviewReason | null;
  pageSize?: number;
  cursor?: FeedbackReviewCursor | null;
}): Promise<FeedbackReviewQueuePage> {
  const pageSize = input.pageSize ?? 25;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new PublicAppError(
      "data_invalid_request",
      "Page size must be between 1 and 100.",
    );
  }
  const value = await callApiRpc<unknown>(
    "list_feedback_review_queue_page",
    {
      target_workspace_id: input.workspaceId,
      target_reason: input.reason ?? null,
      requested_page_size: pageSize,
      cursor_created_at: input.cursor?.created_at ?? null,
      cursor_id: input.cursor?.id ?? null,
    },
    "The feedback review queue could not be loaded. Please try again.",
  );
  const parsed = parseApiPage<unknown>(value, "Feedback review queue");
  const items = parsed.items.map(parseQueueItem);
  const next = parsed.next_cursor;
  const nextCursor =
    next === null
      ? null
      : {
          created_at: timestamp(next.created_at),
          id: stringValue(next.id, false),
        };
  return {
    ...parsed,
    items,
    next_cursor: nextCursor,
  };
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function normalizedTopicSlugs(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function withIssueMetadata(
  parts: FeedbackDraftChangedPart[],
  priorParts: FeedbackDraftChangedPart[],
): FeedbackDraftChangedPart[] {
  const consumed = new Set<number>();
  return parts.map((part) => {
    const exactIndex = priorParts.findIndex(
      (candidate, candidateIndex) =>
        !consumed.has(candidateIndex) &&
        candidate.from === part.from &&
        candidate.to === part.to &&
        candidate.source_start === part.source_start &&
        candidate.source_end === part.source_end &&
        candidate.corrected_start === part.corrected_start &&
        candidate.corrected_end === part.corrected_end,
    );
    const selectedIndex = exactIndex;
    const selected = selectedIndex >= 0 ? priorParts[selectedIndex] : null;
    if (selected) consumed.add(selectedIndex);
    return {
      ...part,
      reason: selected?.reason.trim() || part.reason,
      grammar_topics: normalizedTopicSlugs(selected?.grammar_topics ?? []),
      severity: selected?.severity ?? null,
    };
  });
}

function priorPartsDescribeCorrection(
  original: string,
  corrected: string,
  absoluteSourceStart: number,
  parts: FeedbackDraftChangedPart[],
) {
  if (parts.length === 0) return original === corrected;
  const originalPoints = codePoints(original);
  let sourceCursor = 0;
  let reconstructed = "";
  for (const part of parts) {
    const relativeStart = part.source_start - absoluteSourceStart;
    const relativeEnd = part.source_end - absoluteSourceStart;
    if (
      relativeStart < sourceCursor ||
      relativeEnd < relativeStart ||
      relativeEnd > originalPoints.length ||
      originalPoints.slice(relativeStart, relativeEnd).join("") !== part.from
    ) {
      return false;
    }
    reconstructed += originalPoints.slice(sourceCursor, relativeStart).join("");
    reconstructed += part.to;
    sourceCursor = relativeEnd;
  }
  reconstructed += originalPoints.slice(sourceCursor).join("");
  return reconstructed === corrected;
}

export function buildTeacherChangedParts(
  original: string,
  corrected: string,
  absoluteSourceStart: number,
  reason: string,
  priorParts: FeedbackDraftChangedPart[] = [],
): FeedbackDraftChangedPart[] {
  if (original === corrected) return [];
  if (
    priorPartsDescribeCorrection(
      original,
      corrected,
      absoluteSourceStart,
      priorParts,
    )
  ) {
    return priorParts.map((part) => ({
      ...part,
      grammar_topics: normalizedTopicSlugs(part.grammar_topics),
    }));
  }
  const safeReason = reason.trim() || "Teacher correction.";
  const originalPoints = codePoints(original);
  const correctedPoints = codePoints(corrected);
  const linearPart = () => {
    const { prefixLength, leftEnd, rightEnd } = sharedSequenceBounds(
      originalPoints,
      correctedPoints,
    );
    return withIssueMetadata([
      {
        from: originalPoints.slice(prefixLength, leftEnd).join(""),
        to: correctedPoints.slice(prefixLength, rightEnd).join(""),
        reason: safeReason,
        grammar_topics: [],
        severity: null,
        source_start: absoluteSourceStart + prefixLength,
        source_end: absoluteSourceStart + leftEnd,
        corrected_start: prefixLength,
        corrected_end: rightEnd,
      },
    ], priorParts);
  };
  if (
    sequenceDiffExceedsBudget(originalPoints.length, correctedPoints.length)
  ) {
    return linearPart();
  }

  const changes = diffArrays(originalPoints, correctedPoints);
  const parts: FeedbackDraftChangedPart[] = [];
  let sourceCursor = 0;
  let correctedCursor = 0;
  let pending: FeedbackDraftChangedPart | null = null;

  const flush = () => {
    if (!pending || (pending.from === "" && pending.to === "")) return;
    parts.push(pending);
    pending = null;
  };

  for (const change of changes) {
    const text = change.value.join("");
    const length = change.value.length;
    if (!change.added && !change.removed) {
      flush();
      sourceCursor += length;
      correctedCursor += length;
      continue;
    }

    pending ??= {
      from: "",
      to: "",
      reason: safeReason,
      grammar_topics: [],
      severity: null,
      source_start: absoluteSourceStart + sourceCursor,
      source_end: absoluteSourceStart + sourceCursor,
      corrected_start: correctedCursor,
      corrected_end: correctedCursor,
    };

    if (change.removed) {
      pending.from += text;
      sourceCursor += length;
      pending.source_end = absoluteSourceStart + sourceCursor;
    }
    if (change.added) {
      pending.to += text;
      correctedCursor += length;
      pending.corrected_end = correctedCursor;
    }
  }
  flush();
  return parts.length <= 20 ? withIssueMetadata(parts, priorParts) : linearPart();
}

function isPositiveStatus(status: FeedbackLineStatus) {
  return (
    status === "correct" ||
    status === "acceptable_for_level" ||
    status === "acceptable_a1_a2"
  );
}

export function prepareFeedbackDraftContentForSave(
  originalText: string,
  content: FeedbackDraftContent,
  validationMode: "private_draft" | "release" = "release",
): FeedbackDraftContent {
  if (content.lines.length < 1 || content.lines.length > 40) {
    throw new PublicAppError(
      "data_invalid_request",
      "Feedback must contain between 1 and 40 writing units.",
    );
  }
  if (codePoints(content.overall_summary.trim()).length > 8_000) {
    throw new PublicAppError(
      "data_invalid_request",
      "The overall feedback summary must be 8,000 characters or fewer.",
    );
  }
  if (
    content.grammar_topics.some(
      (topic) => codePoints(topic.simple_explanation ?? "").length > 4_000,
    )
  ) {
    throw new PublicAppError(
      "data_invalid_request",
      "Grammar-topic explanations must be 4,000 characters or fewer.",
    );
  }
  const source = codePoints(originalText);
  let sourceCursor = 0;
  let correctedText = "";

  const lines = content.lines.map((current, index) => {
    if (
      current.line_number !== index + 1 ||
      current.source_start < sourceCursor ||
      current.source_end <= current.source_start ||
      current.source_end > source.length ||
      source.slice(current.source_start, current.source_end).join("") !==
        current.original_line
    ) {
      throw new PublicAppError(
        "data_conflict",
        "This draft no longer matches the original writing. Refresh before editing.",
      );
    }

    const positive = isPositiveStatus(current.status);
    const correctedLine = positive
      ? current.original_line
      : current.corrected_line;
    const shortExplanation = current.short_explanation.trim();
    const detailedExplanation = current.detailed_explanation.trim();
    const explanation = shortExplanation || detailedExplanation;

    if (
      codePoints(current.original_line).length > 4_000 ||
      codePoints(correctedLine).length > 4_000
    ) {
      throw new PublicAppError(
        "data_invalid_request",
        `Line ${current.line_number} must be 4,000 characters or fewer.`,
      );
    }
    if (codePoints(shortExplanation).length > 4_000) {
      throw new PublicAppError(
        "data_invalid_request",
        `Line ${current.line_number}'s student-facing explanation must be 4,000 characters or fewer.`,
      );
    }
    if (codePoints(detailedExplanation).length > 8_000) {
      throw new PublicAppError(
        "data_invalid_request",
        `Line ${current.line_number}'s detailed explanation must be 8,000 characters or fewer.`,
      );
    }

    if (!correctedLine.trim()) {
      throw new PublicAppError(
        "data_invalid_request",
        `Line ${current.line_number} needs corrected text.`,
      );
    }
    if (current.status === "unclear" && !explanation) {
      throw new PublicAppError(
        "data_invalid_request",
        `Line ${current.line_number} needs an explanation for the teacher review.`,
      );
    }
    if (
      current.status === "unclear" &&
      correctedLine !== current.original_line
    ) {
      throw new PublicAppError(
        "data_invalid_request",
        `Line ${current.line_number} must be classified as a minor or major issue before saving a correction.`,
      );
    }

    const derivedChangedParts = positive
      ? []
      : buildTeacherChangedParts(
          current.original_line,
          correctedLine,
          current.source_start,
          explanation,
          current.changed_parts,
        );
    const issueStatus =
      current.status === "minor_issue" || current.status === "major_issue";
    const legacyTopic = current.grammar_topic.trim();
    const changedParts = (
      content.feedback_contract_version !== 2 && issueStatus && legacyTopic
      ? derivedChangedParts.map((part) => ({
          ...part,
          grammar_topics: part.grammar_topics.length > 0
            ? part.grammar_topics
            : [legacyTopic],
          severity:
            part.severity ??
            (current.status === "major_issue" ? "major" : "minor"),
        }))
      : derivedChangedParts
    ).map((part) => ({
      ...part,
      reason: part.reason.trim(),
      grammar_topics: normalizedTopicSlugs(part.grammar_topics),
    }));
    const invalidChangedPart = changedParts.find(
      (part) =>
        codePoints(part.reason).length > MAX_CORRECTION_REASON_CHARACTERS
        || part.grammar_topics.length > MAX_CORRECTION_TOPICS
        || (
          validationMode === "release"
          && (
            !part.reason
            || part.grammar_topics.length === 0
            || part.severity === null
          )
        ),
    );
    if (
      issueStatus &&
      (correctedLine === current.original_line ||
        !shortExplanation ||
        changedParts.length === 0 ||
        invalidChangedPart !== undefined)
    ) {
      throw new PublicAppError(
        "data_invalid_request",
        `Line ${current.line_number} needs a correction, student-facing explanation, and topics and severity for every correction span; each span also needs a bounded reason and one to six topics per span.`,
      );
    }
    const hasIncompleteChangedPart = changedParts.some(
      (part) =>
        !part.reason
        || part.grammar_topics.length === 0
        || part.severity === null,
    );
    const status = issueStatus
      ? validationMode === "private_draft" && hasIncompleteChangedPart
        ? current.status
        : changedParts.some((part) => part.severity === "major")
        ? "major_issue"
        : "minor_issue"
      : current.status;
    const grammarTopic = positive
      ? ""
      : normalizedTopicSlugs(
          changedParts.flatMap((part) => part.grammar_topics),
        )[0] ?? "";

    correctedText += source.slice(sourceCursor, current.source_start).join("");
    correctedText += correctedLine;
    sourceCursor = current.source_end;

    return {
      ...current,
      status,
      corrected_line: correctedLine,
      grammar_topic: grammarTopic,
      changed_parts: changedParts,
    };
  });

  correctedText += source.slice(sourceCursor).join("");
  if (!content.overall_summary.trim()) {
    throw new PublicAppError(
      "data_invalid_request",
      "Add an overall feedback summary before saving.",
    );
  }
  if (codePoints(correctedText).length > 4_000) {
    throw new PublicAppError(
      "data_invalid_request",
      "The corrected writing must be 4,000 characters or fewer.",
    );
  }

  const topicIssues = new Map<
    string,
    Array<{ severity: "minor" | "major"; explanation: string }>
  >();
  for (const line of lines) {
    if (line.status !== "minor_issue" && line.status !== "major_issue") continue;
    for (const part of line.changed_parts) {
      if (!part.severity) continue;
      for (const topic of normalizedTopicSlugs(part.grammar_topics)) {
        const issues = topicIssues.get(topic) ?? [];
        issues.push({ severity: part.severity, explanation: part.reason });
        topicIssues.set(topic, issues);
      }
    }
  }
  const grammarTopics = [...topicIssues.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([topic, issues]) => {
      const hasMinor = issues.some((issue) => issue.severity === "minor");
      const hasMajor = issues.some((issue) => issue.severity === "major");
      const explanations = issues.map((issue) => issue.explanation).filter(Boolean);
      return {
        topic,
        count: issues.length,
        minor_count: issues.filter((issue) => issue.severity === "minor").length,
        major_count: issues.filter((issue) => issue.severity === "major").length,
        severity: hasMinor && hasMajor
          ? "mixed" as const
          : hasMajor
            ? "major" as const
            : "minor" as const,
        simple_explanation: explanations[0] ?? "",
      };
    });
  const scoreSummary = {
    correct_lines: lines.filter((line) => line.status === "correct").length,
    acceptable_lines: lines.filter((line) => isPositiveStatus(line.status) && line.status !== "correct").length,
    minor_issues: lines.filter((line) => line.status === "minor_issue").length,
    major_issues: lines.filter((line) => line.status === "major_issue").length,
    needs_review: lines.filter((line) => line.status === "unclear").length,
  };

  return {
    ...content,
    feedback_contract_version: 2,
    overall_summary: content.overall_summary.trim(),
    corrected_text: correctedText,
    lines,
    grammar_topics: grammarTopics,
    score_summary: scoreSummary,
  };
}
