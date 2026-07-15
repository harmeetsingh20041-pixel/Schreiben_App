import { PublicAppError } from "@/lib/appError";
import { getSupabaseClient } from "@/lib/supabaseClient";
import {
  callApiRpc,
  parseApiArray,
  parseApiPage,
  parseApiRecord,
} from "@/services/apiFacade";

export type PracticeReviewKind =
  | "worksheet_quarantine"
  | "generation_failed"
  | "evaluation_failed"
  | "semantic_review_required"
  | "support_recommended";

export interface PracticeReviewCursor {
  updated_at: string;
  queue_key: string;
}

export interface PracticeReviewQueueItem {
  queue_key: string;
  assignment_id: string;
  attempt_id: string | null;
  practice_test_id: string | null;
  workspace_id: string;
  student_id: string;
  student_name: string;
  student_email: string | null;
  grammar_topic_name: string;
  worksheet_title: string | null;
  action_kind: PracticeReviewKind;
  generation_status: string;
  evaluation_status: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface PracticeReviewQueuePage {
  schema_version: 1;
  items: PracticeReviewQueueItem[];
  total_count: number;
  returned_count: number;
  page_size: number;
  has_more: boolean;
  next_cursor: PracticeReviewCursor | null;
}

export interface QuarantinedWorksheetQuestion {
  id: string;
  question_number: number;
  question_type: string;
  evaluation_mode: "local_exact" | "open_evaluation";
  prompt: string;
  options: string[];
  correct_answer: string;
  accepted_answers: string[];
  rubric: {
    criteria: string[];
    sample_answer: string | null;
  } | null;
  explanation: string;
  answer_contract_version: 1;
}

export interface QuarantinedWorksheet {
  assignment: {
    id: string;
    workspace_id: string;
    student_id: string;
    student_name: string;
    grammar_topic_id: string;
    grammar_topic_name: string;
    generation_status: "needs_review";
  };
  worksheet: {
    id: string;
    title: string;
    description: string | null;
    level: "A1" | "A2" | "B1" | "B2";
    difficulty: "easy" | "medium" | "hard";
    mini_lesson: Record<string, unknown> | null;
    quality_status: "needs_review";
    quality_notes: string | null;
    generator_model: string | null;
    generation_metadata: Record<string, unknown> | null;
    created_at: string;
    questions: QuarantinedWorksheetQuestion[];
  };
}

export interface PracticeQualityDecisionResult {
  action_id: string;
  assignment_id: string;
  practice_test_id: string;
  decision: "approve" | "reject";
  quality_status: "approved" | "failed";
  generation_status: "ready" | "failed";
}

export interface PracticeEvaluationRetryResult {
  assignment_id: string;
  attempt_id: string;
  evaluation_status: "queued" | "evaluating";
  already_processing: boolean;
  processor_kick: "requested" | "recovery_pending";
}

type UnknownRecord = Record<string, unknown>;

const reviewKinds = new Set<PracticeReviewKind>([
  "worksheet_quarantine",
  "generation_failed",
  "evaluation_failed",
  "semantic_review_required",
  "support_recommended",
]);

function invalidResponse(label: string): never {
  throw new PublicAppError(
    "data_invalid_response",
    `${label} returned an invalid response. Please refresh and try again.`,
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidResponse(label);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value == null) return null;
  return requiredString(value, label);
}

function timestamp(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (Number.isNaN(Date.parse(text))) return invalidResponse(label);
  return text;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return invalidResponse(label);
  }
  return value as string[];
}

function parseQueueItem(value: unknown): PracticeReviewQueueItem {
  if (!isRecord(value) || !reviewKinds.has(value.action_kind as PracticeReviewKind)) {
    return invalidResponse("Practice review queue");
  }
  return {
    queue_key: requiredString(value.queue_key, "Practice review queue"),
    assignment_id: requiredString(value.assignment_id, "Practice review queue"),
    attempt_id: nullableString(value.attempt_id, "Practice review queue"),
    practice_test_id: nullableString(value.practice_test_id, "Practice review queue"),
    workspace_id: requiredString(value.workspace_id, "Practice review queue"),
    student_id: requiredString(value.student_id, "Practice review queue"),
    student_name: requiredString(value.student_name, "Practice review queue"),
    student_email: nullableString(value.student_email, "Practice review queue"),
    grammar_topic_name: requiredString(value.grammar_topic_name, "Practice review queue"),
    worksheet_title: nullableString(value.worksheet_title, "Practice review queue"),
    action_kind: value.action_kind as PracticeReviewKind,
    generation_status: requiredString(value.generation_status, "Practice review queue"),
    evaluation_status: nullableString(value.evaluation_status, "Practice review queue"),
    error_code: nullableString(value.error_code, "Practice review queue"),
    created_at: timestamp(value.created_at, "Practice review queue"),
    updated_at: timestamp(value.updated_at, "Practice review queue"),
  };
}

function parseQuestion(value: unknown): QuarantinedWorksheetQuestion {
  if (!isRecord(value)) return invalidResponse("Quarantined worksheet");
  const evaluationMode = value.evaluation_mode;
  const questionNumber = value.question_number;
  const answerContractVersion = value.answer_contract_version;
  if (
    (evaluationMode !== "local_exact" && evaluationMode !== "open_evaluation")
    || typeof questionNumber !== "number"
    || !Number.isSafeInteger(questionNumber)
    || questionNumber < 1
    || answerContractVersion !== 1
  ) {
    return invalidResponse("Quarantined worksheet");
  }

  let rubric: QuarantinedWorksheetQuestion["rubric"] = null;
  if (value.rubric != null) {
    if (!isRecord(value.rubric)) return invalidResponse("Quarantined worksheet");
    const criteria = stringArray(value.rubric.criteria, "Quarantined worksheet");
    const sampleAnswer = value.rubric.sample_answer;
    if (sampleAnswer !== null && typeof sampleAnswer !== "string") {
      return invalidResponse("Quarantined worksheet");
    }
    rubric = { criteria, sample_answer: sampleAnswer as string | null };
  }

  return {
    id: requiredString(value.id, "Quarantined worksheet"),
    question_number: questionNumber,
    question_type: requiredString(value.question_type, "Quarantined worksheet"),
    evaluation_mode: evaluationMode,
    prompt: requiredString(value.prompt, "Quarantined worksheet"),
    options: stringArray(value.options, "Quarantined worksheet"),
    correct_answer: requiredString(value.correct_answer, "Quarantined worksheet"),
    accepted_answers: stringArray(value.accepted_answers, "Quarantined worksheet"),
    rubric,
    explanation: requiredString(value.explanation, "Quarantined worksheet"),
    answer_contract_version: 1,
  };
}

export async function listPracticeReviewQueuePage(input: {
  workspaceId: string;
  kind?: PracticeReviewKind | null;
  pageSize?: number;
  cursor?: PracticeReviewCursor | null;
}): Promise<PracticeReviewQueuePage> {
  const pageSize = input.pageSize ?? 25;
  const value = await callApiRpc<unknown>(
    "list_practice_review_queue_page",
    {
      target_workspace_id: input.workspaceId,
      target_kind: input.kind ?? "all",
      requested_page_size: pageSize,
      cursor_updated_at: input.cursor?.updated_at ?? null,
      cursor_queue_key: input.cursor?.queue_key ?? null,
    },
    "The worksheet and support review queue could not be loaded.",
  );
  const rawPage = parseApiPage<unknown>(value, "Practice review queue");
  const rawCursor = rawPage.next_cursor as unknown;
  let nextCursor: PracticeReviewCursor | null = null;
  if (rawCursor != null) {
    if (!isRecord(rawCursor)) return invalidResponse("Practice review queue");
    nextCursor = {
      updated_at: timestamp(rawCursor.updated_at, "Practice review queue"),
      queue_key: requiredString(rawCursor.queue_key, "Practice review queue"),
    };
  }
  if (rawPage.has_more !== Boolean(nextCursor)) {
    return invalidResponse("Practice review queue");
  }
  return {
    schema_version: 1,
    items: rawPage.items.map(parseQueueItem),
    total_count: rawPage.total_count,
    returned_count: rawPage.returned_count,
    page_size: rawPage.page_size,
    has_more: rawPage.has_more,
    next_cursor: nextCursor,
  };
}

export async function getQuarantinedWorksheet(
  assignmentId: string,
): Promise<QuarantinedWorksheet> {
  const value = await callApiRpc<unknown>(
    "get_quarantined_practice_worksheet",
    { target_assignment_id: assignmentId },
    "The private worksheet could not be loaded for review.",
  );
  const root = parseApiRecord<UnknownRecord>(value, "Quarantined worksheet");
  if (root.schema_version !== 1 || !isRecord(root.assignment) || !isRecord(root.worksheet)) {
    return invalidResponse("Quarantined worksheet");
  }
  const assignment = root.assignment;
  const worksheet = root.worksheet;
  if (
    assignment.id !== assignmentId
    || assignment.generation_status !== "needs_review"
    || worksheet.quality_status !== "needs_review"
    || !Array.isArray(worksheet.questions)
    || !["A1", "A2", "B1", "B2"].includes(String(worksheet.level))
    || !["easy", "medium", "hard"].includes(String(worksheet.difficulty))
  ) {
    return invalidResponse("Quarantined worksheet");
  }
  const miniLesson = worksheet.mini_lesson;
  const generationMetadata = worksheet.generation_metadata;
  if (
    miniLesson != null && !isRecord(miniLesson)
    || generationMetadata != null && !isRecord(generationMetadata)
  ) {
    return invalidResponse("Quarantined worksheet");
  }
  return {
    assignment: {
      id: assignmentId,
      workspace_id: requiredString(assignment.workspace_id, "Quarantined worksheet"),
      student_id: requiredString(assignment.student_id, "Quarantined worksheet"),
      student_name: requiredString(assignment.student_name, "Quarantined worksheet"),
      grammar_topic_id: requiredString(assignment.grammar_topic_id, "Quarantined worksheet"),
      grammar_topic_name: requiredString(assignment.grammar_topic_name, "Quarantined worksheet"),
      generation_status: "needs_review",
    },
    worksheet: {
      id: requiredString(worksheet.id, "Quarantined worksheet"),
      title: requiredString(worksheet.title, "Quarantined worksheet"),
      description: nullableString(worksheet.description, "Quarantined worksheet"),
      level: worksheet.level as QuarantinedWorksheet["worksheet"]["level"],
      difficulty: worksheet.difficulty as QuarantinedWorksheet["worksheet"]["difficulty"],
      mini_lesson: miniLesson as Record<string, unknown> | null,
      quality_status: "needs_review",
      quality_notes: nullableString(worksheet.quality_notes, "Quarantined worksheet"),
      generator_model: nullableString(worksheet.generator_model, "Quarantined worksheet"),
      generation_metadata: generationMetadata as Record<string, unknown> | null,
      created_at: timestamp(worksheet.created_at, "Quarantined worksheet"),
      questions: worksheet.questions.map(parseQuestion),
    },
  };
}

export async function decideQuarantinedWorksheet(
  assignmentId: string,
  decision: "approve" | "reject",
  notes: string,
): Promise<PracticeQualityDecisionResult> {
  const cleanNotes = notes.trim();
  if (cleanNotes.length < 8 || cleanNotes.length > 1000) {
    throw new PublicAppError(
      "data_invalid_request",
      "Add a short review note explaining this quality decision.",
    );
  }
  const value = await callApiRpc<unknown>(
    "decide_quarantined_practice_worksheet",
    {
      target_assignment_id: assignmentId,
      target_decision: decision,
      review_notes: cleanNotes,
    },
    "The worksheet quality decision could not be saved.",
  );
  const result = parseApiRecord<UnknownRecord>(value, "Worksheet quality decision");
  const expectedQuality = decision === "approve" ? "approved" : "failed";
  const expectedGeneration = decision === "approve" ? "ready" : "failed";
  if (
    result.schema_version !== 1
    || result.assignment_id !== assignmentId
    || result.decision !== decision
    || result.quality_status !== expectedQuality
    || result.generation_status !== expectedGeneration
  ) {
    return invalidResponse("Worksheet quality decision");
  }
  return {
    action_id: requiredString(result.action_id, "Worksheet quality decision"),
    assignment_id: assignmentId,
    practice_test_id: requiredString(result.practice_test_id, "Worksheet quality decision"),
    decision,
    quality_status: expectedQuality,
    generation_status: expectedGeneration,
  };
}

export async function retryPracticeAttemptEvaluation(
  assignmentId: string,
  attemptId: string,
): Promise<PracticeEvaluationRetryResult> {
  const value = await callApiRpc<unknown>(
    "retry_practice_attempt_evaluation",
    { target_attempt_id: attemptId },
    "Practice feedback could not be queued for retry.",
  );
  const rows = parseApiArray<UnknownRecord>(value, "Practice evaluation retry");
  const result = rows[0];
  if (
    rows.length !== 1
    || !result
    || result.assignment_id !== assignmentId
    || result.attempt_id !== attemptId
    || !["queued", "evaluating"].includes(String(result.evaluation_status))
    || typeof result.already_processing !== "boolean"
  ) {
    return invalidResponse("Practice evaluation retry");
  }

  let processorKick: PracticeEvaluationRetryResult["processor_kick"] = "recovery_pending";
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.functions.invoke<UnknownRecord>(
      "evaluate-practice-attempt",
      { body: { assignment_id: assignmentId, attempt_id: attemptId } },
    );
    if (
      !error
      && data?.accepted === true
      && data.assignment_id === assignmentId
      && data.attempt_id === attemptId
      && ["queued", "evaluating"].includes(String(data.evaluation_status))
    ) {
      processorKick = "requested";
    }
  }

  return {
    assignment_id: assignmentId,
    attempt_id: attemptId,
    evaluation_status: result.evaluation_status as "queued" | "evaluating",
    already_processing: result.already_processing,
    processor_kick: processorKick,
  };
}
