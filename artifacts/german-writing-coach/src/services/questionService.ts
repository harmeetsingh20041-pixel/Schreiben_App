import { getSupabaseClient } from "@/lib/supabaseClient";
import type { QuestionTaskType, WorkspaceLevel } from "@/lib/workspaceData";
import type { Database } from "@/types/supabase";

type QuestionRow = Database["public"]["Tables"]["questions"]["Row"];
type GlobalQuestionRow = Database["public"]["Tables"]["global_questions"]["Row"];

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
  source: "workspace" | "global";
  batch_id: string | null;
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
    source: "workspace",
    batch_id: null,
    level: question.level as WorkspaceLevel,
    task_type: question.task_type as QuestionTaskType,
  };
}

function mapGlobalQuestion(question: GlobalQuestionRow): WorkspaceQuestion {
  return {
    id: question.id,
    workspace_id: "global",
    source: "global",
    batch_id: null,
    title: question.title,
    prompt: question.prompt,
    level: question.level as WorkspaceLevel,
    topic: question.topic,
    task_type: question.task_type as QuestionTaskType,
    expected_word_min: question.expected_word_min,
    expected_word_max: question.expected_word_max,
    estimated_minutes: question.estimated_minutes,
    is_active: question.is_active,
    created_by: question.created_by,
    created_at: question.created_at,
    updated_at: question.updated_at,
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

export async function listGlobalQuestions(levels?: WorkspaceLevel[]): Promise<WorkspaceQuestion[]> {
  const client = requireClient();
  let query = client
    .from("global_questions")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (levels && levels.length > 0) {
    query = query.in("level", levels);
  }

  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as GlobalQuestionRow[]).map(mapGlobalQuestion);
}

export async function listStudentAssignedQuestions(studentId: string): Promise<WorkspaceQuestion[]> {
  const client = requireClient();
  const { data: assignments, error: assignmentsError } = await client
    .from("batch_students")
    .select("workspace_id, batch_id")
    .eq("student_id", studentId);

  if (assignmentsError) throw assignmentsError;

  const batchIds = Array.from(
    new Set((assignments ?? []).map((assignment) => assignment.batch_id)),
  );
  const workspaceIds = Array.from(
    new Set((assignments ?? []).map((assignment) => assignment.workspace_id)),
  );

  if (workspaceIds.length === 0 || batchIds.length === 0) return [];

  const { data: batches, error: batchesError } = await client
    .from("batches")
    .select("id, workspace_id, level")
    .in("id", batchIds);

  if (batchesError) throw batchesError;

  const levels = Array.from(
    new Set((batches ?? []).map((batch) => batch.level as WorkspaceLevel)),
  );

  if (levels.length === 0) return [];

  const assignmentContexts = (assignments ?? [])
    .map((assignment) => {
      const batch = (batches ?? []).find((candidate) => candidate.id === assignment.batch_id);
      return batch
        ? {
            batch_id: assignment.batch_id,
            workspace_id: assignment.workspace_id,
            level: batch.level as WorkspaceLevel,
          }
        : null;
    })
    .filter((context): context is { batch_id: string; workspace_id: string; level: WorkspaceLevel } => Boolean(context));

  const [
    { data: workspaceQuestions, error: workspaceQuestionsError },
    globalQuestions,
  ] = await Promise.all([
    client
    .from("questions")
    .select("*")
    .in("workspace_id", workspaceIds)
    .in("level", levels)
    .eq("is_active", true)
      .order("created_at", { ascending: false }),
    listGlobalQuestions(levels),
  ]);

  if (workspaceQuestionsError) throw workspaceQuestionsError;
  return [
    ...globalQuestions.map((question) => ({
      ...question,
      batch_id:
        assignmentContexts.find((assignment) => assignment.level === question.level)?.batch_id ?? null,
    })),
    ...((workspaceQuestions ?? []) as QuestionRow[]).map((question) => {
      const mapped = mapQuestion(question);
      return {
        ...mapped,
        batch_id:
          assignmentContexts.find(
            (assignment) =>
              assignment.workspace_id === question.workspace_id &&
              assignment.level === question.level,
          )?.batch_id ?? null,
      };
    }),
  ];
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
