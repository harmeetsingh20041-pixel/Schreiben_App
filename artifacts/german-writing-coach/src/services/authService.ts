import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabaseClient";
import { isSignupEnabled } from "@/lib/launchConfig";
import type { WorkspaceRole } from "@/types/database";
import type { Session, User } from "@supabase/supabase-js";

export type AuthRole = "student" | "teacher" | null;

export interface AuthProfile {
  id: string;
  full_name: string | null;
  email: string;
  global_role: "platform_admin" | "teacher" | "student";
}

export interface AuthWorkspaceMembership {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
}

export interface AuthSnapshot {
  session: Session | null;
  user: User | null;
  profile: AuthProfile | null;
  workspaceMemberships: AuthWorkspaceMembership[];
  role: AuthRole;
  needsWorkspace: boolean;
}

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured. Demo mode is still available.");
  }
  return client;
}

function getRequestedAccountType(user: User | null): AuthRole {
  const accountType = user?.user_metadata?.account_type;
  return accountType === "teacher" || accountType === "student" ? accountType : null;
}

function deriveRole(
  user: User | null,
  profile: AuthProfile | null,
  workspaceMemberships: AuthWorkspaceMembership[],
): AuthRole {
  if (!user) return null;
  if (profile?.global_role === "platform_admin") return "teacher";
  if (workspaceMemberships.some((member) => member.role === "owner" || member.role === "teacher")) {
    return "teacher";
  }
  if (getRequestedAccountType(user) === "teacher") return "teacher";
  return "student";
}

export function canUseSupabaseAuth() {
  return isSupabaseConfigured;
}

export async function signInWithEmailPassword(email: string, password: string) {
  const client = requireClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUpWithEmailPassword(params: {
  email: string;
  password: string;
  fullName?: string;
  accountType: "student" | "teacher";
}) {
  if (!isSignupEnabled(params.accountType)) {
    throw new Error(
      params.accountType === "teacher"
        ? "Teacher signup is not open. Ask an administrator for access."
        : "Student signup is not open. Ask your teacher for access.",
    );
  }

  const client = requireClient();
  const { error } = await client.auth.signUp({
    email: params.email,
    password: params.password,
    options: {
      data: {
        full_name: params.fullName || undefined,
        account_type: params.accountType,
      },
    },
  });
  if (error) throw error;
}

export async function signOut() {
  const client = getSupabaseClient();
  if (!client) return;
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

export async function getCurrentSession() {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function getCurrentUser() {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  return data.user;
}

export function onAuthStateChange(callback: () => void) {
  const client = getSupabaseClient();
  if (!client) return () => {};
  const { data } = client.auth.onAuthStateChange(() => {
    callback();
  });
  return () => data.subscription.unsubscribe();
}

export async function getAuthSnapshot(): Promise<AuthSnapshot> {
  const client = getSupabaseClient();
  if (!client) {
    return {
      session: null,
      user: null,
      profile: null,
      workspaceMemberships: [],
      role: null,
      needsWorkspace: false,
    };
  }

  const session = await getCurrentSession();
  const user = session?.user ?? null;
  if (!user) {
    return {
      session: null,
      user: null,
      profile: null,
      workspaceMemberships: [],
      role: null,
      needsWorkspace: false,
    };
  }

  const [{ data: profile, error: profileError }, { data: memberships, error: membershipError }] =
    await Promise.all([
      client
        .from("profiles")
        .select("id, full_name, email, global_role")
        .eq("id", user.id)
        .maybeSingle(),
      client
        .from("workspace_members")
        .select("id, workspace_id, user_id, role")
        .eq("user_id", user.id),
    ]);

  if (profileError) throw profileError;
  if (membershipError) throw membershipError;

  const workspaceMemberships = (memberships ?? []) as AuthWorkspaceMembership[];
  const role = deriveRole(user, profile as AuthProfile | null, workspaceMemberships);
  const needsWorkspace =
    role === "teacher" &&
    workspaceMemberships.length === 0 &&
    getRequestedAccountType(user) === "teacher";

  return {
    session,
    user,
    profile: profile as AuthProfile | null,
    workspaceMemberships,
    role,
    needsWorkspace,
  };
}

export async function createTeacherWorkspace(workspaceName = "My German Class") {
  const client = requireClient();
  const { error } = await client.rpc("create_teacher_workspace", {
    workspace_name: workspaceName,
  });
  if (error) throw error;
}
