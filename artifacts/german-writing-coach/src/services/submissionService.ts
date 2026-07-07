import { getSupabaseClient } from "@/lib/supabaseClient";
import type { WorkspaceLevel } from "@/lib/workspaceData";
import type { Database } from "@/types/supabase";

type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];
type BatchRow = Pick<Database["public"]["Tables"]["batches"]["Row"], "id" | "name" | "level">;
type WorkspaceQuestionRow = Pick<
  Database["public"]["Tables"]["questions"]["Row"],
  "id" | "title" | "prompt" | "level" | "topic"
>;
type GlobalQuestionRow = Pick<
  Database["public"]["Tables"]["global_questions"]["Row"],
  "id" | "title" | "prompt" | "level" | "topic"
>;
type ProfileRow = Pick<Database["public"]["Tables"]["profiles"]["Row"], "id" | "full_name" | "email">;
type SubmissionLineRow = Database["public"]["Tables"]["submission_lines"]["Row"];
type SubmissionGrammarTopicRow = Database["public"]["Tables"]["submission_grammar_topics"]["Row"];
type GrammarTopicRow = Pick<Database["public"]["Tables"]["grammar_topics"]["Row"], "id" | "name" | "slug">;

const SUBMISSION_QUERY_LIMITS = {
  studentHistory: 20,
  teacherList: 25,
} as const;

export type SubmissionQuestionSource = "workspace_question" | "global_question" | "free_text";
export type WritingSubmissionStatus = "draft" | "submitted" | "checking" | "checked" | "needs_review" | "failed";
export type FeedbackMode = "immediate" | "automatic_delayed" | "teacher_review_only";
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
  batchId?: string | null;
  answerText: string;
  saveAsDraft?: boolean;
}

export interface CreatedWritingSubmission {
  submission_id: string;
  feedback_mode: FeedbackMode | null;
  feedback_scheduled_at: string | null;
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

export interface WritingFeedbackLine {
  id: string;
  line_number: number;
  original_line: string;
  corrected_line: string;
  status: FeedbackLineStatus;
  changed_parts: Array<{ from: string; to: string; reason: string }>;
  short_explanation: string | null;
  detailed_explanation: string | null;
  grammar_topic: string | null;
}

export interface WritingFeedbackTopic {
  id: string;
  topic: string;
  count: number;
  severity: "minor" | "major" | "mixed";
  simple_explanation: string | null;
}

export interface WritingFeedback {
  lines: WritingFeedbackLine[];
  grammar_topics: WritingFeedbackTopic[];
}

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured. Demo mode is still available.");
  }
  return client;
}

function formatQuestionSource(source: SubmissionQuestionSource | null) {
  if (source === "global_question") return "Global writing task";
  if (source === "workspace_question") return "Workspace writing task";
  return "Free writing";
}

function emptyIfNeeded<T>(ids: string[], loader: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return loader(ids);
}

function parseChangedParts(value: unknown): WritingFeedbackLine["changed_parts"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
    .map((part) => ({
      from: typeof part.from === "string" ? part.from : "",
      to: typeof part.to === "string" ? part.to : "",
      reason: typeof part.reason === "string" ? part.reason : "",
    }));
}

async function hydrateSubmissions(
  rows: SubmissionRow[],
  includeStudents: boolean,
): Promise<WritingSubmission[]> {
  if (rows.length === 0) return [];

  const client = requireClient();
  const workspaceQuestionIds = Array.from(
    new Set(rows.map((row) => row.question_id).filter((id): id is string => Boolean(id))),
  );
  const globalQuestionIds = Array.from(
    new Set(rows.map((row) => row.global_question_id).filter((id): id is string => Boolean(id))),
  );
  const batchIds = Array.from(
    new Set(rows.map((row) => row.batch_id).filter((id): id is string => Boolean(id))),
  );
  const studentIds = includeStudents
    ? Array.from(new Set(rows.map((row) => row.student_id)))
    : [];

  const [workspaceQuestions, globalQuestions, batches, profiles] = await Promise.all([
    emptyIfNeeded(workspaceQuestionIds, async (ids) => {
      const { data, error } = await client
        .from("questions")
        .select("id, title, prompt, level, topic")
        .in("id", ids);
      if (error) throw error;
      return (data ?? []) as WorkspaceQuestionRow[];
    }),
    emptyIfNeeded(globalQuestionIds, async (ids) => {
      const { data, error } = await client
        .from("global_questions")
        .select("id, title, prompt, level, topic")
        .in("id", ids);
      if (error) throw error;
      return (data ?? []) as GlobalQuestionRow[];
    }),
    emptyIfNeeded(batchIds, async (ids) => {
      const { data, error } = await client
        .from("batches")
        .select("id, name, level")
        .in("id", ids);
      if (error) throw error;
      return (data ?? []) as BatchRow[];
    }),
    emptyIfNeeded(studentIds, async (ids) => {
      const { data, error } = await client
        .from("profiles")
        .select("id, full_name, email")
        .in("id", ids);
      if (error) throw error;
      return (data ?? []) as ProfileRow[];
    }),
  ]);

  const workspaceQuestionMap = new Map(workspaceQuestions.map((question) => [question.id, question]));
  const globalQuestionMap = new Map(globalQuestions.map((question) => [question.id, question]));
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

  return rows.map((row) => {
    const source = row.question_source as SubmissionQuestionSource | null;
    const workspaceQuestion = row.question_id ? workspaceQuestionMap.get(row.question_id) : null;
    const globalQuestion = row.global_question_id ? globalQuestionMap.get(row.global_question_id) : null;
    const question = workspaceQuestion ?? globalQuestion ?? null;
    const batch = row.batch_id ? batchMap.get(row.batch_id) : null;
    const profile = profileMap.get(row.student_id) ?? null;

    return {
      id: row.id,
      workspace_id: row.workspace_id,
      student_id: row.student_id,
      batch_id: row.batch_id,
      question_id: row.question_id,
      global_question_id: row.global_question_id,
      question_source: source,
      mode: row.mode as WritingSubmission["mode"],
      original_text: row.original_text,
      corrected_text: row.corrected_text,
      overall_summary: row.overall_summary,
      level_detected: row.level_detected as WorkspaceLevel | null,
      status: row.status as WritingSubmissionStatus,
      feedback_mode: (row.feedback_mode as FeedbackMode | null) ?? null,
      feedback_scheduled_at: row.feedback_scheduled_at ?? null,
      feedback_started_at: row.feedback_started_at ?? null,
      feedback_completed_at: row.feedback_completed_at ?? null,
      feedback_error: row.feedback_error ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      checked_at: row.checked_at,
      question_title: question?.title ?? "Free Writing",
      question_prompt: question?.prompt ?? null,
      question_level: (question?.level as WorkspaceLevel | undefined) ?? null,
      question_topic: question?.topic ?? null,
      question_source_label: formatQuestionSource(source),
      batch_name: batch?.name ?? null,
      batch_level: (batch?.level as WorkspaceLevel | undefined) ?? null,
      student_name: profile?.full_name ?? profile?.email ?? null,
      student_email: profile?.email ?? null,
    };
  });
}

export async function createWritingSubmission(input: CreateWritingSubmissionInput): Promise<CreatedWritingSubmission> {
  const client = requireClient();
  const { data, error } = await client
    .rpc("create_writing_submission", {
      target_question_source: input.questionSource,
      target_question_id: (input.questionId ?? null) as unknown as string,
      target_batch_id: (input.batchId ?? null) as unknown as string,
      answer_text: input.answerText,
      save_as_draft: input.saveAsDraft ?? false,
    })
    .single();

  if (error) throw error;
  return {
    submission_id: data.submission_id,
    feedback_mode: (data.feedback_mode as FeedbackMode | null) ?? null,
    feedback_scheduled_at: data.feedback_scheduled_at ?? null,
  };
}

export async function saveDraftSubmission(input: CreateWritingSubmissionInput): Promise<CreatedWritingSubmission> {
  return createWritingSubmission({ ...input, saveAsDraft: true });
}

export async function listStudentSubmissions(
  studentId: string,
  limit: number = SUBMISSION_QUERY_LIMITS.studentHistory,
): Promise<WritingSubmission[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("submissions")
    .select("*")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return hydrateSubmissions((data ?? []) as SubmissionRow[], false);
}

export async function getStudentSubmissionDetail(
  submissionId: string,
  studentId: string,
): Promise<WritingSubmission | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("submissions")
    .select("*")
    .eq("id", submissionId)
    .eq("student_id", studentId)
    .maybeSingle();

  if (error) throw error;
  const hydrated = await hydrateSubmissions(data ? [data as SubmissionRow] : [], false);
  return hydrated[0] ?? null;
}

export async function listTeacherWorkspaceSubmissions(
  workspaceId: string,
  limit: number = SUBMISSION_QUERY_LIMITS.teacherList,
): Promise<WritingSubmission[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("submissions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return hydrateSubmissions((data ?? []) as SubmissionRow[], true);
}

export async function getTeacherSubmissionDetail(
  workspaceId: string,
  submissionId: string,
): Promise<WritingSubmission | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("submissions")
    .select("*")
    .eq("id", submissionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) throw error;
  const hydrated = await hydrateSubmissions(data ? [data as SubmissionRow] : [], true);
  return hydrated[0] ?? null;
}

export async function getSubmissionFeedback(submissionId: string): Promise<WritingFeedback | null> {
  const client = requireClient();
  const { data: lineRows, error: lineError } = await client
    .from("submission_lines")
    .select("*")
    .eq("submission_id", submissionId)
    .order("line_number", { ascending: true });

  if (lineError) throw lineError;
  const lines = (lineRows ?? []) as SubmissionLineRow[];
  if (lines.length === 0) return null;

  const lineTopicIds = lines
    .map((line) => line.grammar_topic_id)
    .filter((id): id is string => Boolean(id));

  const { data: topicRows, error: topicError } = await client
    .from("submission_grammar_topics")
    .select("*")
    .eq("submission_id", submissionId);

  if (topicError) throw topicError;
  const summaryTopics = (topicRows ?? []) as SubmissionGrammarTopicRow[];
  const summaryTopicIds = summaryTopics.map((topic) => topic.grammar_topic_id);
  const grammarTopicIds = Array.from(new Set([...lineTopicIds, ...summaryTopicIds]));

  const grammarTopics = await emptyIfNeeded(grammarTopicIds, async (ids) => {
    const { data, error } = await client
      .from("grammar_topics")
      .select("id, name, slug")
      .in("id", ids);
    if (error) throw error;
    return (data ?? []) as GrammarTopicRow[];
  });

  const grammarTopicMap = new Map(grammarTopics.map((topic) => [topic.id, topic]));

  return {
    lines: lines.map((line) => ({
      id: line.id,
      line_number: line.line_number,
      original_line: line.original_line,
      corrected_line: line.corrected_line,
      status: line.status as FeedbackLineStatus,
      changed_parts: parseChangedParts(line.changed_parts),
      short_explanation: line.short_explanation,
      detailed_explanation: line.detailed_explanation,
      grammar_topic: line.grammar_topic_id ? grammarTopicMap.get(line.grammar_topic_id)?.name ?? null : null,
    })),
    grammar_topics: summaryTopics.map((topic) => ({
      id: topic.id,
      topic: grammarTopicMap.get(topic.grammar_topic_id)?.name ?? "Grammar topic",
      count: topic.count,
      severity: topic.severity as WritingFeedbackTopic["severity"],
      simple_explanation: topic.simple_explanation,
    })),
  };
}

export async function prepareWritingFeedback(submissionId: string): Promise<{ status: WritingSubmissionStatus; line_count: number }> {
  const client = requireClient();
  const { data, error } = await client.functions.invoke("prepare-writing-feedback", {
    body: { submission_id: submissionId },
  });

  if (error) {
    throw new Error("Feedback could not be prepared. Please try again later.");
  }
  if (data?.error) {
    throw new Error(data.error);
  }

  return {
    status: (data?.status ?? "checked") as WritingSubmissionStatus,
    line_count: Number(data?.line_count ?? 0),
  };
}
