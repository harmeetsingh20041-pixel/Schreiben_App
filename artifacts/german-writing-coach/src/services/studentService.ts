import { getSupabaseClient } from "@/lib/supabaseClient";
import type { WorkspaceLevel } from "@/lib/workspaceData";
import type { Database } from "@/types/supabase";

type BatchRow = Database["public"]["Tables"]["batches"]["Row"];
type BatchStudentRow = Database["public"]["Tables"]["batch_students"]["Row"];
type BatchJoinRequestRow = Database["public"]["Tables"]["batch_join_requests"]["Row"];
type InvitationRow = Database["public"]["Tables"]["student_invitations"]["Row"];
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
type WorkspaceMemberRow = Database["public"]["Tables"]["workspace_members"]["Row"];

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured. Demo mode is still available.");
  }
  return client;
}

export interface StudentBatchAssignment {
  id: string;
  batch_id: string;
  batch_name: string;
  level: WorkspaceLevel;
}

export interface WorkspaceStudent {
  id: string;
  name: string;
  email: string;
  membership_id: string;
  batches: StudentBatchAssignment[];
  total_submissions: number;
  last_active: string;
}

export interface StudentInvitation {
  id: string;
  workspace_id: string;
  batch_id: string | null;
  email: string;
  status: "pending" | "accepted" | "cancelled" | "expired";
  accepted_by: string | null;
  accepted_at: string | null;
  expires_at: string | null;
  created_at: string;
  batch_name: string | null;
  batch_level: WorkspaceLevel | null;
}

export interface BatchJoinRequest {
  id: string;
  workspace_id: string;
  batch_id: string;
  student_id: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  student_name: string;
  student_email: string;
  batch_name: string;
  batch_level: WorkspaceLevel;
}

export interface JoinBatchResult {
  request_id: string;
  workspace_id: string;
  batch_id: string;
  batch_name: string;
  level: WorkspaceLevel;
  status: BatchJoinRequest["status"];
  requires_approval: boolean;
}

function formatActivity(value: string | null) {
  if (!value) return "No submissions yet";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function mapBatchAssignments(
  assignments: BatchStudentRow[],
  batches: Pick<BatchRow, "id" | "name" | "level">[],
): StudentBatchAssignment[] {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
  return assignments
    .map((assignment) => {
      const batch = batchMap.get(assignment.batch_id);
      if (!batch) return null;
      return {
        id: assignment.id,
        batch_id: assignment.batch_id,
        batch_name: batch.name,
        level: batch.level as WorkspaceLevel,
      };
    })
    .filter((assignment): assignment is StudentBatchAssignment => Boolean(assignment));
}

export async function listMyBatchAssignments(studentId: string): Promise<StudentBatchAssignment[]> {
  const client = requireClient();
  const { data: assignments, error: assignmentsError } = await client
    .from("batch_students")
    .select("*")
    .eq("student_id", studentId);

  if (assignmentsError) throw assignmentsError;

  const batchIds = Array.from(new Set((assignments ?? []).map((assignment) => assignment.batch_id)));
  if (batchIds.length === 0) return [];

  const { data: batches, error: batchesError } = await client
    .from("batches")
    .select("id, name, level")
    .in("id", batchIds);

  if (batchesError) throw batchesError;
  return mapBatchAssignments(
    (assignments ?? []) as BatchStudentRow[],
    (batches ?? []) as Pick<BatchRow, "id" | "name" | "level">[],
  );
}

export async function listWorkspaceStudents(workspaceId: string): Promise<WorkspaceStudent[]> {
  const client = requireClient();
  const [
    { data: memberships, error: membershipsError },
    { data: batches, error: batchesError },
    { data: assignments, error: assignmentsError },
    { data: submissions, error: submissionsError },
  ] = await Promise.all([
    client
      .from("workspace_members")
      .select("id, workspace_id, user_id, role, profiles!workspace_members_user_id_fkey(id, full_name, email)")
      .eq("workspace_id", workspaceId)
      .eq("role", "student")
      .order("created_at", { ascending: false }),
    client.from("batches").select("*").eq("workspace_id", workspaceId),
    client.from("batch_students").select("*").eq("workspace_id", workspaceId),
    client
      .from("submissions")
      .select("student_id, created_at")
      .eq("workspace_id", workspaceId),
  ]);

  if (membershipsError) throw membershipsError;
  if (batchesError) throw batchesError;
  if (assignmentsError) throw assignmentsError;
  if (submissionsError) throw submissionsError;

  const batchMap = new Map(
    ((batches ?? []) as BatchRow[]).map((batch) => [batch.id, batch]),
  );

  const assignmentsByStudent = new Map<string, BatchStudentRow[]>();
  for (const assignment of (assignments ?? []) as BatchStudentRow[]) {
    const current = assignmentsByStudent.get(assignment.student_id) ?? [];
    current.push(assignment);
    assignmentsByStudent.set(assignment.student_id, current);
  }

  const statsByStudent = new Map<string, { count: number; latest: string | null }>();
  for (const submission of submissions ?? []) {
    const current = statsByStudent.get(submission.student_id) ?? {
      count: 0,
      latest: null,
    };
    current.count += 1;
    if (!current.latest || submission.created_at > current.latest) {
      current.latest = submission.created_at;
    }
    statsByStudent.set(submission.student_id, current);
  }

  return (memberships ?? []).map((membership) => {
    const member = membership as WorkspaceMemberRow & { profiles: ProfileRow | null };
    const profile = member.profiles;
    const studentAssignments = (assignmentsByStudent.get(member.user_id) ?? [])
      .map((assignment) => {
        const batch = batchMap.get(assignment.batch_id);
        if (!batch) return null;
        return {
          id: assignment.id,
          batch_id: assignment.batch_id,
          batch_name: batch.name,
          level: batch.level as WorkspaceLevel,
        };
      })
      .filter((assignment): assignment is StudentBatchAssignment => Boolean(assignment));
    const stats = statsByStudent.get(member.user_id);

    return {
      id: member.user_id,
      name: profile?.full_name || profile?.email || "Unnamed student",
      email: profile?.email || "",
      membership_id: member.id,
      batches: studentAssignments,
      total_submissions: stats?.count ?? 0,
      last_active: formatActivity(stats?.latest ?? null),
    };
  });
}

export async function listStudentInvitations(workspaceId: string): Promise<StudentInvitation[]> {
  const client = requireClient();
  const [
    { data: invitations, error: invitationsError },
    { data: batches, error: batchesError },
  ] = await Promise.all([
    client
      .from("student_invitations")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false }),
    client.from("batches").select("id, name, level").eq("workspace_id", workspaceId),
  ]);

  if (invitationsError) throw invitationsError;
  if (batchesError) throw batchesError;

  const batchMap = new Map(
    ((batches ?? []) as Pick<BatchRow, "id" | "name" | "level">[]).map((batch) => [
      batch.id,
      batch,
    ]),
  );

  return ((invitations ?? []) as InvitationRow[]).map((invitation) => {
    const batch = invitation.batch_id ? batchMap.get(invitation.batch_id) : null;
    return {
      id: invitation.id,
      workspace_id: invitation.workspace_id,
      batch_id: invitation.batch_id,
      email: invitation.email,
      status: invitation.status as StudentInvitation["status"],
      accepted_by: invitation.accepted_by,
      accepted_at: invitation.accepted_at,
      expires_at: invitation.expires_at,
      created_at: invitation.created_at,
      batch_name: batch?.name ?? null,
      batch_level: (batch?.level as WorkspaceLevel | undefined) ?? null,
    };
  });
}

function mapJoinRequests(
  requests: BatchJoinRequestRow[],
  batches: Pick<BatchRow, "id" | "name" | "level">[],
): BatchJoinRequest[] {
  const batchMap = new Map(batches.map((batch) => [batch.id, batch]));

  return requests.map((request) => {
    const batch = batchMap.get(request.batch_id);

    return {
      id: request.id,
      workspace_id: request.workspace_id,
      batch_id: request.batch_id,
      student_id: request.student_id,
      status: request.status as BatchJoinRequest["status"],
      requested_at: request.requested_at,
      decided_at: request.decided_at,
      decided_by: request.decided_by,
      student_name: request.student_name || request.student_email,
      student_email: request.student_email,
      batch_name: batch?.name || "Unknown batch",
      batch_level: (batch?.level as WorkspaceLevel | undefined) ?? "A1",
    };
  });
}

export async function listBatchJoinRequests(workspaceId: string): Promise<BatchJoinRequest[]> {
  const client = requireClient();
  const { data: requests, error: requestsError } = await client
    .from("batch_join_requests")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("requested_at", { ascending: false });

  if (requestsError) throw requestsError;

  const requestRows = (requests ?? []) as BatchJoinRequestRow[];
  if (requestRows.length === 0) return [];

  const batchIds = Array.from(new Set(requestRows.map((request) => request.batch_id)));

  const { data: batches, error: batchesError } = await client
    .from("batches")
    .select("id, name, level")
    .in("id", batchIds);

  if (batchesError) throw batchesError;

  return mapJoinRequests(
    requestRows,
    (batches ?? []) as Pick<BatchRow, "id" | "name" | "level">[],
  );
}

export async function listMyBatchJoinRequests(studentId: string): Promise<BatchJoinRequest[]> {
  const client = requireClient();
  const { data: requests, error: requestsError } = await client
    .from("batch_join_requests")
    .select("*")
    .eq("student_id", studentId)
    .order("requested_at", { ascending: false });

  if (requestsError) throw requestsError;

  const requestRows = (requests ?? []) as BatchJoinRequestRow[];
  if (requestRows.length === 0) return [];

  const batchIds = Array.from(new Set(requestRows.map((request) => request.batch_id)));
  const { data: batches, error: batchesError } = await client
    .from("batches")
    .select("id, name, level")
    .in("id", batchIds);

  if (batchesError) throw batchesError;

  return mapJoinRequests(
    requestRows,
    (batches ?? []) as Pick<BatchRow, "id" | "name" | "level">[],
  );
}

export async function inviteStudentByEmail(email: string, batchId?: string | null) {
  const client = requireClient();
  const { error } = await client.rpc("invite_student_by_email", {
    target_email: email,
    target_batch_id: batchId || undefined,
  });

  if (error) throw error;
}

export async function requestJoinBatchByCode(joinCode: string): Promise<JoinBatchResult> {
  const client = requireClient();
  const { data, error } = await client
    .rpc("request_join_batch_by_code", { join_code: joinCode })
    .single();

  if (error) throw error;
  return {
    ...data,
    level: data.level as WorkspaceLevel,
    status: data.status as BatchJoinRequest["status"],
  };
}

export async function approveBatchJoinRequest(requestId: string) {
  const client = requireClient();
  const { error } = await client.rpc("approve_batch_join_request", {
    request_id: requestId,
  });

  if (error) throw error;
}

export async function rejectBatchJoinRequest(requestId: string) {
  const client = requireClient();
  const { error } = await client.rpc("reject_batch_join_request", {
    request_id: requestId,
  });

  if (error) throw error;
}

export async function assignStudentToBatch(
  workspaceId: string,
  studentId: string,
  batchId: string,
) {
  const client = requireClient();
  const { error } = await client.from("batch_students").insert({
    workspace_id: workspaceId,
    student_id: studentId,
    batch_id: batchId,
  });

  if (error && error.code !== "23505") throw error;
}

export async function removeStudentBatchAssignment(assignmentId: string) {
  const client = requireClient();
  const { error } = await client
    .from("batch_students")
    .delete()
    .eq("id", assignmentId);

  if (error) throw error;
}
