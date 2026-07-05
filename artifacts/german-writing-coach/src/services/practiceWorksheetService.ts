import { getSupabaseClient } from "@/lib/supabaseClient";
import type { Database, Json } from "@/types/supabase";

type PracticeAssignmentRow = Database["public"]["Tables"]["student_practice_assignments"]["Row"];
type PracticeAttemptRow = Database["public"]["Tables"]["practice_test_attempts"]["Row"];
type PracticeTestRow = Database["public"]["Tables"]["practice_tests"]["Row"];
type PracticeQuestionRow = Database["public"]["Tables"]["practice_test_questions"]["Row"];
type GrammarTopicRow = Pick<Database["public"]["Tables"]["grammar_topics"]["Row"], "id" | "name" | "slug" | "description">;
type ProfileRow = Pick<Database["public"]["Tables"]["profiles"]["Row"], "id" | "full_name" | "email">;
type PracticeAssignmentRpcRow =
  Database["public"]["Functions"]["ensure_student_practice_assignment"]["Returns"][number];

export type PracticeAssignmentStatus =
  | "unlocked"
  | "in_progress"
  | "completed"
  | "passed"
  | "failed"
  | "cancelled";

export type PracticeAttemptStatus = "in_progress" | "submitted" | "checked";

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
  student_name?: string | null;
  student_email?: string | null;
}

export interface PracticeWorksheetQuestion {
  id: string;
  question_number: number;
  question_type: string;
  prompt: string;
  options: string[];
  correct_answer?: string;
  explanation: string | null;
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
  };
}

function mapAssignmentFromTables(
  assignment: PracticeAssignmentRow,
  topic: GrammarTopicRow | undefined,
  worksheet: PracticeTestRow | undefined,
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
    student_name: student?.full_name ?? student?.email ?? null,
    student_email: student?.email ?? null,
  };
}

async function hydrateAssignments(assignments: PracticeAssignmentRow[]): Promise<PracticeAssignmentSummary[]> {
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
    { data: questions, error: questionsError },
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
    worksheetIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : client.from("practice_test_questions").select("practice_test_id").in("practice_test_id", worksheetIds),
  ]);

  if (topicsError) throw topicsError;
  if (worksheetsError) throw worksheetsError;
  if (attemptsError) throw attemptsError;
  if (profilesError) throw profilesError;
  if (questionsError) throw questionsError;

  const topicMap = new Map(((topics ?? []) as GrammarTopicRow[]).map((topic) => [topic.id, topic]));
  const worksheetMap = new Map(((worksheets ?? []) as PracticeTestRow[]).map((worksheet) => [worksheet.id, worksheet]));
  const attemptMap = new Map(((attempts ?? []) as PracticeAttemptRow[]).map((attempt) => [attempt.id, attempt]));
  const profileMap = new Map(((profiles ?? []) as ProfileRow[]).map((profile) => [profile.id, profile]));
  const questionCounts = new Map<string, number>();
  for (const question of (questions ?? []) as Pick<PracticeQuestionRow, "practice_test_id">[]) {
    questionCounts.set(question.practice_test_id, (questionCounts.get(question.practice_test_id) ?? 0) + 1);
  }

  return assignments.map((assignment) =>
    mapAssignmentFromTables(
      assignment,
      topicMap.get(assignment.grammar_topic_id),
      assignment.practice_test_id ? worksheetMap.get(assignment.practice_test_id) : undefined,
      assignment.latest_attempt_id ? attemptMap.get(assignment.latest_attempt_id) : undefined,
      profileMap.get(assignment.student_id),
      assignment.practice_test_id ? questionCounts.get(assignment.practice_test_id) ?? 0 : 0,
    ),
  );
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
  const { data, error } = await client
    .from("student_practice_assignments")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("student_id", studentId)
    .order("updated_at", { ascending: false })
    .limit(PRACTICE_ASSIGNMENT_LIMITS.student);

  if (error) throw error;
  return hydrateAssignments((data ?? []) as PracticeAssignmentRow[]);
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
  return hydrateAssignments((data ?? []) as PracticeAssignmentRow[]);
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

  const summaries = await hydrateAssignments([assignment as PracticeAssignmentRow]);
  const summary = summaries[0];
  if (!summary.practice_test_id) {
    return { assignment: summary, questions: [] };
  }

  const { data: questions, error: questionsError } = await client
    .from("practice_test_questions")
    .select("*")
    .eq("practice_test_id", summary.practice_test_id)
    .order("question_number", { ascending: true });

  if (questionsError) throw questionsError;

  return {
    assignment: summary,
    questions: ((questions ?? []) as PracticeQuestionRow[]).map((question) => ({
      id: question.id,
      question_number: question.question_number,
      question_type: question.question_type,
      prompt: question.prompt,
      options: parseOptions(question.options),
      explanation: question.explanation,
    })),
  };
}

export function getPracticeAssignmentLabel(assignment: PracticeAssignmentSummary) {
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
