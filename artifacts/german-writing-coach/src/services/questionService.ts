import { getSupabaseClient } from "@/lib/supabaseClient";
import type { QuestionTaskType, WorkspaceLevel } from "@/lib/workspaceData";
import type { Database } from "@/types/supabase";

type QuestionRow = Database["public"]["Tables"]["questions"]["Row"];

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured. Demo mode is still available.");
  }
  return client;
}

export interface WorkspaceQuestion {
  id: string;
  workspace_id: string;
  title: string;
  prompt: string;
  level: WorkspaceLevel;
  topic: string;
  task_type: QuestionTaskType;
  expected_word_min: number | null;
  expected_word_max: number | null;
  estimated_minutes: number | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuestionInput {
  title: string;
  prompt: string;
  level: WorkspaceLevel;
  topic: string;
  task_type: QuestionTaskType;
  expected_word_min?: number | null;
  expected_word_max?: number | null;
  estimated_minutes?: number | null;
  is_active?: boolean;
}

function mapQuestion(question: QuestionRow): WorkspaceQuestion {
  return {
    ...question,
    level: question.level as WorkspaceLevel,
    task_type: question.task_type as QuestionTaskType,
  };
}

export async function listWorkspaceQuestions(workspaceId: string): Promise<WorkspaceQuestion[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("questions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as QuestionRow[]).map(mapQuestion);
}

export async function listStudentAssignedQuestions(studentId: string): Promise<WorkspaceQuestion[]> {
  const client = requireClient();
  const { data: assignments, error: assignmentsError } = await client
    .from("batch_students")
    .select("workspace_id, batch_id, batches!batch_students_batch_id_fkey(id, level)")
    .eq("student_id", studentId);

  if (assignmentsError) throw assignmentsError;

  const workspaceIds = Array.from(
    new Set((assignments ?? []).map((assignment) => assignment.workspace_id)),
  );
  const levels = Array.from(
    new Set(
      (assignments ?? [])
        .map((assignment) => {
          const batch = assignment.batches as { level?: string } | null;
          return batch?.level;
        })
        .filter((level): level is WorkspaceLevel => Boolean(level)),
    ),
  );

  if (workspaceIds.length === 0 || levels.length === 0) return [];

  const { data, error } = await client
    .from("questions")
    .select("*")
    .in("workspace_id", workspaceIds)
    .in("level", levels)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as QuestionRow[]).map(mapQuestion);
}

export async function createWorkspaceQuestion(
  workspaceId: string,
  userId: string,
  input: QuestionInput,
): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("questions").insert({
    workspace_id: workspaceId,
    created_by: userId,
    title: input.title,
    prompt: input.prompt,
    level: input.level,
    topic: input.topic,
    task_type: input.task_type,
    expected_word_min: input.expected_word_min ?? null,
    expected_word_max: input.expected_word_max ?? null,
    estimated_minutes: input.estimated_minutes ?? null,
    is_active: input.is_active ?? true,
  });

  if (error) throw error;
}

export async function updateWorkspaceQuestion(
  workspaceId: string,
  questionId: string,
  input: QuestionInput,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("questions")
    .update({
      title: input.title,
      prompt: input.prompt,
      level: input.level,
      topic: input.topic,
      task_type: input.task_type,
      expected_word_min: input.expected_word_min ?? null,
      expected_word_max: input.expected_word_max ?? null,
      estimated_minutes: input.estimated_minutes ?? null,
      is_active: input.is_active ?? true,
    })
    .eq("id", questionId)
    .eq("workspace_id", workspaceId);

  if (error) throw error;
}

export async function setQuestionActive(
  workspaceId: string,
  questionId: string,
  isActive: boolean,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("questions")
    .update({ is_active: isActive })
    .eq("id", questionId)
    .eq("workspace_id", workspaceId);

  if (error) throw error;
}
