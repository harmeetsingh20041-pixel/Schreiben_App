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

export type SubmissionQuestionSource = "workspace_question" | "global_question" | "free_text";
export type WritingSubmissionStatus = "draft" | "submitted" | "checked" | "needs_review" | "failed";

export interface CreateWritingSubmissionInput {
  questionSource: SubmissionQuestionSource;
  questionId?: string | null;
  batchId?: string | null;
  answerText: string;
  saveAsDraft?: boolean;
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

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured. Demo mode is still available.");
  }
  return client;
}

function formatQuestionSource(source: SubmissionQuestionSource | null) {
  if (source === "global_question") return "Global question";
  if (source === "workspace_question") return "Workspace question";
  return "Free writing";
}

function emptyIfNeeded<T>(ids: string[], loader: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return loader(ids);
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

export async function createWritingSubmission(input: CreateWritingSubmissionInput): Promise<string> {
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
  return data.submission_id;
}

export async function saveDraftSubmission(input: CreateWritingSubmissionInput): Promise<string> {
  return createWritingSubmission({ ...input, saveAsDraft: true });
}

export async function listStudentSubmissions(studentId: string): Promise<WritingSubmission[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("submissions")
    .select("*")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false });

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
): Promise<WritingSubmission[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("submissions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

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
