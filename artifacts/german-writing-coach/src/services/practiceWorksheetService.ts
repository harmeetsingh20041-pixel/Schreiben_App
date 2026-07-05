import { getSupabaseClient } from "@/lib/supabaseClient";
import type { Database, Json } from "@/types/supabase";

type PracticeAssignmentRow = Database["public"]["Tables"]["student_practice_assignments"]["Row"];
type PracticeAttemptRow = Database["public"]["Tables"]["practice_test_attempts"]["Row"];
type PracticeTestRow = Database["public"]["Tables"]["practice_tests"]["Row"];
type GrammarTopicRow = Pick<Database["public"]["Tables"]["grammar_topics"]["Row"], "id" | "name" | "slug" | "description">;
type ProfileRow = Pick<Database["public"]["Tables"]["profiles"]["Row"], "id" | "full_name" | "email">;
type PracticeAssignmentRpcRow =
  | Database["public"]["Functions"]["ensure_student_practice_assignment"]["Returns"][number]
  | Database["public"]["Functions"]["list_student_practice_assignments"]["Returns"][number]
  | Database["public"]["Functions"]["start_practice_assignment"]["Returns"][number]
  | Database["public"]["Functions"]["submit_practice_attempt"]["Returns"][number];
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
export type PracticeGenerationStatus = "idle" | "generating" | "ready" | "failed";

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
  score_percent: number | null;
  passed: boolean | null;
  question_count: number;
  generation_status: PracticeGenerationStatus;
  generation_started_at: string | null;
  generation_completed_at: string | null;
  generation_error: string | null;
  student_name?: string | null;
  student_email?: string | null;
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
  review_status?: "correct" | "minor_formatting" | "incorrect" | "submitted_for_review" | string | null;
}

export interface PracticeWorksheetDetail {
  assignment: PracticeAssignmentSummary;
  questions: PracticeWorksheetQuestion[];
}

export interface PracticeAnswerInput {
  question_id: string;
  answer: string;
}

const PRACTICE_ASSIGNMENT_LIMITS = {
  student: 40,
  workspace: 160,
} as const;

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured. Demo mode is still available.");
  }
  return client;
}

function parseOptions(options: Json | null): string[] {
  if (Array.isArray(options)) {
    return options.filter((option): option is string => typeof option === "string");
  }

  if (options && typeof options === "object") {
    const candidate = (options as { choices?: unknown; options?: unknown }).choices
      ?? (options as { choices?: unknown; options?: unknown }).options;
    if (Array.isArray(candidate)) {
      return candidate.filter((option): option is string => typeof option === "string");
    }
  }

  return [];
}

function parseMiniLesson(value: Json | null | undefined): PracticeMiniLesson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const examples = Array.isArray(record.correct_examples)
    ? record.correct_examples.filter((example): example is string => typeof example === "string")
    : [];

  const miniLesson = {
    short_explanation: typeof record.short_explanation === "string" ? record.short_explanation : "",
    key_rule: typeof record.key_rule === "string" ? record.key_rule : "",
    correct_examples: examples,
    common_mistake_warning: typeof record.common_mistake_warning === "string" ? record.common_mistake_warning : "",
    what_to_revise: typeof record.what_to_revise === "string" ? record.what_to_revise : "",
  };

  return miniLesson.short_explanation || miniLesson.key_rule || miniLesson.correct_examples.length > 0
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

function normalizeAttemptStatus(status: string | null): PracticeAttemptStatus | null {
  if (status === "in_progress" || status === "submitted" || status === "checked") return status;
  return null;
}

function normalizeGenerationStatus(status: string | null | undefined, hasWorksheet = false): PracticeGenerationStatus {
  if (status === "idle" || status === "generating" || status === "ready" || status === "failed") return status;
  return hasWorksheet ? "ready" : "idle";
}

type PracticeAssignmentWithGeneration = PracticeAssignmentRow & {
  generation_status?: string | null;
  generation_started_at?: string | null;
  generation_completed_at?: string | null;
  generation_error?: string | null;
};

type PracticeTestWithMiniLesson = PracticeTestRow & {
  mini_lesson?: Json | null;
};

function mapRpcAssignment(row: PracticeAssignmentRpcRow): PracticeAssignmentSummary {
  return {
    id: row.assignment_id,
    workspace_id: row.workspace_id,
    student_id: row.student_id,
    grammar_topic_id: row.grammar_topic_id,
    grammar_topic_name: row.grammar_topic_name,
    grammar_topic_slug: row.grammar_topic_slug,
    grammar_topic_description: null,
    practice_test_id: row.practice_test_id,
    worksheet_title: row.worksheet_title,
    worksheet_level: row.worksheet_level,
    worksheet_difficulty: row.worksheet_difficulty,
    worksheet_mini_lesson: null,
    status: normalizeStatus(row.status),
    source: row.source,
    assigned_at: row.assigned_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    latest_attempt_id: row.latest_attempt_id,
    latest_attempt_status: normalizeAttemptStatus(row.latest_attempt_status),
    score: row.score,
    max_score: row.max_score,
    score_percent: row.score_percent,
    passed: row.passed,
    question_count: row.question_count,
    generation_status: normalizeGenerationStatus(null, Boolean(row.practice_test_id)),
    generation_started_at: null,
    generation_completed_at: null,
    generation_error: null,
  };
}

function mapReviewAssignment(row: PracticeReviewRpcRow): PracticeAssignmentSummary {
  return {
    id: row.assignment_id,
    workspace_id: row.workspace_id,
    student_id: row.student_id,
    grammar_topic_id: row.grammar_topic_id,
    grammar_topic_name: row.grammar_topic_name,
    grammar_topic_slug: row.grammar_topic_slug,
    grammar_topic_description: null,
    practice_test_id: row.practice_test_id,
    worksheet_title: row.worksheet_title,
    worksheet_level: row.worksheet_level,
    worksheet_difficulty: row.worksheet_difficulty,
    worksheet_mini_lesson: null,
    status: normalizeStatus(row.status),
    source: row.source,
    assigned_at: row.assigned_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    latest_attempt_id: row.latest_attempt_id,
    latest_attempt_status: normalizeAttemptStatus(row.latest_attempt_status),
    score: row.score,
    max_score: row.max_score,
    score_percent: row.score_percent,
    passed: row.passed,
    question_count: row.question_count,
    generation_status: normalizeGenerationStatus(null, Boolean(row.practice_test_id)),
    generation_started_at: null,
    generation_completed_at: null,
    generation_error: null,
  };
}

function mapAssignmentFromTables(
  assignment: PracticeAssignmentWithGeneration,
  topic: GrammarTopicRow | undefined,
  worksheet: PracticeTestWithMiniLesson | undefined,
  latestAttempt: PracticeAttemptRow | undefined,
  student?: ProfileRow | undefined,
  questionCount = 0,
): PracticeAssignmentSummary {
  return {
    id: assignment.id,
    workspace_id: assignment.workspace_id,
    student_id: assignment.student_id,
    grammar_topic_id: assignment.grammar_topic_id,
    grammar_topic_name: topic?.name ?? "Grammar topic",
    grammar_topic_slug: topic?.slug ?? "grammar-topic",
    grammar_topic_description: topic?.description ?? null,
    practice_test_id: assignment.practice_test_id,
    worksheet_title: worksheet?.title ?? null,
    worksheet_level: worksheet?.level ?? null,
    worksheet_difficulty: worksheet?.difficulty ?? null,
    worksheet_mini_lesson: parseMiniLesson(worksheet?.mini_lesson),
    status: normalizeStatus(assignment.status),
    source: assignment.source,
    assigned_at: assignment.assigned_at,
    started_at: assignment.started_at,
    completed_at: assignment.completed_at,
    latest_attempt_id: assignment.latest_attempt_id,
    latest_attempt_status: normalizeAttemptStatus(latestAttempt?.status ?? null),
    score: latestAttempt?.score ?? null,
    max_score: latestAttempt?.max_score ?? null,
    score_percent: latestAttempt?.score_percent ?? null,
    passed: latestAttempt?.passed ?? null,
    question_count: questionCount,
    generation_status: normalizeGenerationStatus(assignment.generation_status, Boolean(assignment.practice_test_id)),
    generation_started_at: assignment.generation_started_at ?? null,
    generation_completed_at: assignment.generation_completed_at ?? null,
    generation_error: assignment.generation_error ?? null,
    student_name: student?.full_name ?? student?.email ?? null,
    student_email: student?.email ?? null,
  };
}

async function hydrateAssignments(assignments: PracticeAssignmentWithGeneration[]): Promise<PracticeAssignmentSummary[]> {
  if (assignments.length === 0) return [];

  const client = requireClient();
  const topicIds = Array.from(new Set(assignments.map((assignment) => assignment.grammar_topic_id)));
  const worksheetIds = Array.from(new Set(assignments.map((assignment) => assignment.practice_test_id).filter((id): id is string => Boolean(id))));
  const attemptIds = Array.from(new Set(assignments.map((assignment) => assignment.latest_attempt_id).filter((id): id is string => Boolean(id))));
  const studentIds = Array.from(new Set(assignments.map((assignment) => assignment.student_id)));

  const [
    { data: topics, error: topicsError },
    { data: worksheets, error: worksheetsError },
    { data: attempts, error: attemptsError },
    { data: profiles, error: profilesError },
  ] = await Promise.all([
    client.from("grammar_topics").select("id, name, slug, description").in("id", topicIds),
    worksheetIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client.from("practice_tests").select("*").in("id", worksheetIds),
    attemptIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client.from("practice_test_attempts").select("*").in("id", attemptIds),
    studentIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client.from("profiles").select("id, full_name, email").in("id", studentIds),
  ]);

  if (topicsError) throw topicsError;
  if (worksheetsError) throw worksheetsError;
  if (attemptsError) throw attemptsError;
  if (profilesError) throw profilesError;

  const topicMap = new Map(((topics ?? []) as GrammarTopicRow[]).map((topic) => [topic.id, topic]));
  const worksheetMap = new Map(((worksheets ?? []) as PracticeTestWithMiniLesson[]).map((worksheet) => [worksheet.id, worksheet]));
  const attemptMap = new Map(((attempts ?? []) as PracticeAttemptRow[]).map((attempt) => [attempt.id, attempt]));
  const profileMap = new Map(((profiles ?? []) as ProfileRow[]).map((profile) => [profile.id, profile]));

  return assignments.map((assignment) =>
    mapAssignmentFromTables(
      assignment,
      topicMap.get(assignment.grammar_topic_id),
      assignment.practice_test_id ? worksheetMap.get(assignment.practice_test_id) : undefined,
      assignment.latest_attempt_id ? attemptMap.get(assignment.latest_attempt_id) : undefined,
      profileMap.get(assignment.student_id),
      0,
    ),
  );
}

type EdgeAssignmentSummary = Partial<PracticeAssignmentSummary> & {
  id?: string;
  assignment_id?: string;
};

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}

function mapEdgeAssignment(row: EdgeAssignmentSummary): PracticeAssignmentSummary {
  const id = asString(row.id ?? row.assignment_id);
  const practiceTestId = asNullableString(row.practice_test_id);
  if (!id) {
    throw new Error("Practice assignment was not returned.");
  }

  return {
    id,
    workspace_id: asString(row.workspace_id),
    student_id: asString(row.student_id),
    grammar_topic_id: asString(row.grammar_topic_id),
    grammar_topic_name: asString(row.grammar_topic_name, "Grammar topic"),
    grammar_topic_slug: asString(row.grammar_topic_slug, "grammar-topic"),
    grammar_topic_description: asNullableString(row.grammar_topic_description),
    practice_test_id: practiceTestId,
    worksheet_title: asNullableString(row.worksheet_title),
    worksheet_level: asNullableString(row.worksheet_level),
    worksheet_difficulty: asNullableString(row.worksheet_difficulty),
    worksheet_mini_lesson: parseMiniLesson(row.worksheet_mini_lesson as Json | null | undefined),
    status: normalizeStatus(asString(row.status, "unlocked")),
    source: asString(row.source, "weakness_auto"),
    assigned_at: asString(row.assigned_at),
    started_at: asNullableString(row.started_at),
    completed_at: asNullableString(row.completed_at),
    latest_attempt_id: asNullableString(row.latest_attempt_id),
    latest_attempt_status: normalizeAttemptStatus(asNullableString(row.latest_attempt_status)),
    score: asNullableNumber(row.score),
    max_score: asNullableNumber(row.max_score),
    score_percent: asNullableNumber(row.score_percent),
    passed: typeof row.passed === "boolean" ? row.passed : null,
    question_count: typeof row.question_count === "number" ? row.question_count : 0,
    generation_status: normalizeGenerationStatus(asNullableString(row.generation_status), Boolean(practiceTestId)),
    generation_started_at: asNullableString(row.generation_started_at),
    generation_completed_at: asNullableString(row.generation_completed_at),
    generation_error: asNullableString(row.generation_error),
    student_name: asNullableString(row.student_name),
    student_email: asNullableString(row.student_email),
  };
}

export async function ensureStudentPracticeAssignment(
  workspaceId: string,
  studentId: string,
  grammarTopicId: string,
): Promise<PracticeAssignmentSummary> {
  const client = requireClient();
  const { data, error } = await client.rpc("ensure_student_practice_assignment", {
    target_workspace_id: workspaceId,
    target_student_id: studentId,
    target_grammar_topic_id: grammarTopicId,
  });

  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error("Practice assignment was not returned.");
  return mapRpcAssignment(row);
}

export async function listStudentPracticeAssignments(
  workspaceId: string,
  studentId: string,
): Promise<PracticeAssignmentSummary[]> {
  const client = requireClient();
  const { data, error } = await client.rpc("list_student_practice_assignments", {
    target_workspace_id: workspaceId,
    target_student_id: studentId,
  });

  if (error) throw error;
  const summaries = ((data ?? []) as PracticeAssignmentRpcRow[])
    .slice(0, PRACTICE_ASSIGNMENT_LIMITS.student)
    .map(mapRpcAssignment);
  const assignmentIds = summaries.map((assignment) => assignment.id);
  if (assignmentIds.length === 0) return summaries;

  const { data: assignments, error: assignmentError } = await client
    .from("student_practice_assignments")
    .select("*")
    .in("id", assignmentIds);

  if (assignmentError) throw assignmentError;
  const assignmentMap = new Map(
    ((assignments ?? []) as PracticeAssignmentWithGeneration[]).map((assignment) => [assignment.id, assignment]),
  );

  return summaries.map((summary) => {
    const assignment = assignmentMap.get(summary.id);
    if (!assignment) return summary;
    return {
      ...summary,
      generation_status: normalizeGenerationStatus(assignment.generation_status, Boolean(summary.practice_test_id)),
      generation_started_at: assignment.generation_started_at ?? null,
      generation_completed_at: assignment.generation_completed_at ?? null,
      generation_error: assignment.generation_error ?? null,
    };
  });
}

export async function preparePracticeWorksheet(assignmentId: string): Promise<PracticeAssignmentSummary> {
  const client = requireClient();
  const { data, error } = await client.functions.invoke<{
    error?: string;
    assignment?: EdgeAssignmentSummary;
  }>("generate-practice-worksheet", {
    body: { assignment_id: assignmentId },
  });

  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  if (!data?.assignment) throw new Error("Worksheet preparation did not return an assignment.");
  return mapEdgeAssignment(data.assignment);
}

export async function listWorkspacePracticeAssignments(
  workspaceId: string,
): Promise<PracticeAssignmentSummary[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("student_practice_assignments")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(PRACTICE_ASSIGNMENT_LIMITS.workspace);

  if (error) throw error;
  return hydrateAssignments((data ?? []) as PracticeAssignmentWithGeneration[]);
}

export async function startPracticeAssignment(assignmentId: string): Promise<PracticeAssignmentSummary> {
  const client = requireClient();
  const { data, error } = await client.rpc("start_practice_assignment", {
    target_assignment_id: assignmentId,
  });

  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error("Practice assignment was not returned.");
  return mapRpcAssignment(row);
}

export async function submitPracticeAttempt(
  assignmentId: string,
  answers: PracticeAnswerInput[],
): Promise<PracticeAssignmentSummary> {
  const client = requireClient();
  const { data, error } = await client.rpc("submit_practice_attempt", {
    target_assignment_id: assignmentId,
    submitted_answers: answers as unknown as Json,
  });

  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error("Practice attempt result was not returned.");
  return mapRpcAssignment(row);
}

export async function getPracticeWorksheetDetail(assignmentId: string): Promise<PracticeWorksheetDetail> {
  const client = requireClient();
  const { data: assignment, error: assignmentError } = await client
    .from("student_practice_assignments")
    .select("*")
    .eq("id", assignmentId)
    .maybeSingle();

  if (assignmentError) throw assignmentError;
  if (!assignment) throw new Error("Practice assignment was not found.");

  const summaries = await hydrateAssignments([assignment as PracticeAssignmentWithGeneration]);
  const summary = summaries[0];
  if (!summary.practice_test_id) {
    return { assignment: summary, questions: [] };
  }

  const { data: questions, error: questionsError } = await client
    .rpc("get_practice_assignment_questions", {
      target_assignment_id: assignmentId,
    });

  if (questionsError) throw questionsError;
  const safeQuestions = (questions ?? []) as PracticeQuestionRpcRow[];

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

export async function getPracticeWorksheetReview(assignmentId: string): Promise<PracticeWorksheetDetail> {
  const client = requireClient();
  const { data, error } = await client.rpc("get_practice_assignment_review", {
    target_assignment_id: assignmentId,
  });

  if (error) throw error;
  const reviewRows = (data ?? []) as PracticeReviewRpcRow[];
  const firstRow = reviewRows[0];
  if (!firstRow) throw new Error("Worksheet review is not available yet.");

  let assignment = mapReviewAssignment(firstRow);
  const { data: assignmentRow, error: assignmentError } = await client
    .from("student_practice_assignments")
    .select("*")
    .eq("id", assignmentId)
    .maybeSingle();

  if (assignmentError) throw assignmentError;
  if (assignmentRow) {
    const hydrated = await hydrateAssignments([assignmentRow as PracticeAssignmentWithGeneration]);
    assignment = {
      ...assignment,
      ...hydrated[0],
      question_count: reviewRows.length,
      latest_attempt_id: firstRow.latest_attempt_id,
      latest_attempt_status: normalizeAttemptStatus(firstRow.latest_attempt_status),
      score: firstRow.score,
      max_score: firstRow.max_score,
      score_percent: firstRow.score_percent,
      passed: firstRow.passed,
    };
  }

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
    })),
  };
}

export function getPracticeAssignmentLabel(assignment: PracticeAssignmentSummary) {
  if (!assignment.practice_test_id && assignment.generation_status === "generating") return "Preparing worksheet";
  if (!assignment.practice_test_id && assignment.generation_status === "failed") return "Preparation failed";
  if (assignment.status === "unlocked" && !assignment.practice_test_id) return "Practice unlocked";
  if (assignment.status === "unlocked") return "Worksheet assigned";
  if (assignment.status === "in_progress") return "In progress";
  if (assignment.status === "passed") return "Passed";
  if (assignment.status === "failed") return "Needs more practice";
  if (assignment.status === "completed" && assignment.latest_attempt_status === "submitted") return "Submitted for review";
  if (assignment.status === "completed") return "Completed";
  return "Cancelled";
}

export function getPracticeAssignmentBadgeClass(assignment: PracticeAssignmentSummary) {
  if (!assignment.practice_test_id && assignment.generation_status === "failed") {
    return "bg-destructive/10 text-destructive border-destructive/30";
  }
  if (!assignment.practice_test_id && assignment.generation_status === "generating") {
    return "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-700";
  }
  if (assignment.status === "passed") {
    return "bg-green-50 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-100 dark:border-green-700";
  }
  if (assignment.status === "failed") {
    return "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-100 dark:border-orange-700";
  }
  if (assignment.status === "in_progress") {
    return "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-700";
  }
  if (assignment.status === "cancelled") {
    return "bg-muted text-muted-foreground border-border";
  }
  return "bg-primary/10 text-primary border-primary/20";
}

export function formatPracticeScore(assignment: PracticeAssignmentSummary) {
  if (assignment.score_percent == null || assignment.max_score == null || assignment.max_score === 0) {
    return null;
  }
  return `${assignment.score ?? 0}/${assignment.max_score} (${Math.round(assignment.score_percent)}%)`;
}
