import { getSupabaseClient } from "@/lib/supabaseClient";
import type { WorkspaceLevel } from "@/lib/workspaceData";
import type { Database } from "@/types/supabase";

type BatchRow = Database["public"]["Tables"]["batches"]["Row"];

const BATCH_QUERY_LIMITS = {
  batches: 100,
  countRows: 1000,
} as const;

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured. Demo mode is still available.");
  }
  return client;
}

export interface WorkspaceBatch {
  id: string;
  workspace_id: string;
  name: string;
  level: WorkspaceLevel;
  description: string | null;
  is_active: boolean;
  join_code: string;
  join_code_enabled: boolean;
  join_requires_approval: boolean;
  feedback_mode: BatchFeedbackMode;
  feedback_delay_min_minutes: number;
  feedback_delay_max_minutes: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  student_count: number;
  submission_count: number;
}

export type BatchFeedbackMode = "immediate" | "automatic_delayed" | "teacher_review_only";

export interface BatchInput {
  name: string;
  level: WorkspaceLevel;
  description?: string | null;
  is_active?: boolean;
  join_code_enabled?: boolean;
  join_requires_approval?: boolean;
  feedback_mode?: BatchFeedbackMode;
  feedback_delay_min_minutes?: number;
  feedback_delay_max_minutes?: number;
}

function mapBatch(
  batch: BatchRow,
  studentCounts: Map<string, number>,
  submissionCounts: Map<string, number>,
): WorkspaceBatch {
  return {
    ...batch,
    level: batch.level as WorkspaceLevel,
    feedback_mode: (batch.feedback_mode ?? "teacher_review_only") as BatchFeedbackMode,
    feedback_delay_min_minutes: batch.feedback_delay_min_minutes ?? 15,
    feedback_delay_max_minutes: batch.feedback_delay_max_minutes ?? 180,
    student_count: studentCounts.get(batch.id) ?? 0,
    submission_count: submissionCounts.get(batch.id) ?? 0,
  };
}

export async function listWorkspaceBatches(workspaceId: string): Promise<WorkspaceBatch[]> {
  const client = requireClient();
  const [
    { data: batches, error: batchesError },
    { data: batchStudents, error: batchStudentsError },
    { data: submissions, error: submissionsError },
  ] = await Promise.all([
    client
      .from("batches")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(BATCH_QUERY_LIMITS.batches),
    client
      .from("batch_students")
      .select("batch_id")
      .eq("workspace_id", workspaceId)
      .limit(BATCH_QUERY_LIMITS.countRows),
    client
      .from("submissions")
      .select("batch_id")
      .eq("workspace_id", workspaceId)
      .limit(BATCH_QUERY_LIMITS.countRows),
  ]);

  if (batchesError) throw batchesError;
  if (batchStudentsError) throw batchStudentsError;
  if (submissionsError) throw submissionsError;

  const studentCounts = new Map<string, number>();
  for (const row of batchStudents ?? []) {
    studentCounts.set(row.batch_id, (studentCounts.get(row.batch_id) ?? 0) + 1);
  }

  const submissionCounts = new Map<string, number>();
  for (const row of submissions ?? []) {
    if (!row.batch_id) continue;
    submissionCounts.set(row.batch_id, (submissionCounts.get(row.batch_id) ?? 0) + 1);
  }

  return ((batches ?? []) as BatchRow[]).map((batch) =>
    mapBatch(batch, studentCounts, submissionCounts),
  );
}

export async function createWorkspaceBatch(
  workspaceId: string,
  userId: string,
  input: BatchInput,
): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("batches").insert({
    workspace_id: workspaceId,
    created_by: userId,
    join_code: "",
    name: input.name,
    level: input.level,
    description: input.description || null,
    is_active: input.is_active ?? true,
    join_code_enabled: input.join_code_enabled ?? true,
    join_requires_approval: input.join_requires_approval ?? true,
    feedback_mode: input.feedback_mode ?? "teacher_review_only",
    feedback_delay_min_minutes: input.feedback_delay_min_minutes ?? 15,
    feedback_delay_max_minutes: input.feedback_delay_max_minutes ?? 180,
  });

  if (error) throw error;
}

export async function updateWorkspaceBatch(
  workspaceId: string,
  batchId: string,
  input: BatchInput,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("batches")
    .update({
      name: input.name,
      level: input.level,
      description: input.description || null,
      is_active: input.is_active ?? true,
      join_code_enabled: input.join_code_enabled ?? true,
      join_requires_approval: input.join_requires_approval ?? true,
      feedback_mode: input.feedback_mode ?? "teacher_review_only",
      feedback_delay_min_minutes: input.feedback_delay_min_minutes ?? 15,
      feedback_delay_max_minutes: input.feedback_delay_max_minutes ?? 180,
    })
    .eq("id", batchId)
    .eq("workspace_id", workspaceId);

  if (error) throw error;
}

export async function rotateBatchJoinCode(batchId: string): Promise<string> {
  const client = requireClient();
  const { data, error } = await client
    .rpc("rotate_batch_join_code", { target_batch_id: batchId })
    .single();

  if (error) throw error;
  return data.join_code;
}

export async function setBatchActive(
  workspaceId: string,
  batchId: string,
  isActive: boolean,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("batches")
    .update({ is_active: isActive })
    .eq("id", batchId)
    .eq("workspace_id", workspaceId);

  if (error) throw error;
}
