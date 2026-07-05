import { getSupabaseClient } from "@/lib/supabaseClient";
import type { Database } from "@/types/supabase";

type StudentGrammarStatsRow = Database["public"]["Tables"]["student_grammar_stats"]["Row"];
type GrammarTopicRow = Pick<Database["public"]["Tables"]["grammar_topics"]["Row"], "id" | "name" | "slug" | "description">;
type ProfileRow = Pick<Database["public"]["Tables"]["profiles"]["Row"], "id" | "full_name" | "email">;

export type WeaknessLevel = "tracking" | "weak" | "unlocked" | "improving" | "mastered";

export interface StudentGrammarStat {
  id: string;
  workspace_id: string;
  student_id: string;
  grammar_topic_id: string;
  topic_name: string;
  topic_slug: string;
  topic_description: string | null;
  total_minor_issues: number;
  total_major_issues: number;
  total_correct_after_practice: number;
  weakness_level: WeaknessLevel;
  practice_unlocked: boolean;
  last_seen_at: string | null;
  updated_at: string;
  student_name?: string | null;
  student_email?: string | null;
}

type StatsRowWithRelations = StudentGrammarStatsRow & {
  grammar_topics?: GrammarTopicRow | null;
  profiles?: ProfileRow | null;
};

const GRAMMAR_STATS_LIMITS = {
  student: 8,
  workspace: 40,
} as const;

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase is not configured. Demo mode is still available.");
  }
  return client;
}

function mapGrammarStat(row: StatsRowWithRelations): StudentGrammarStat {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    student_id: row.student_id,
    grammar_topic_id: row.grammar_topic_id,
    topic_name: row.grammar_topics?.name ?? "Grammar topic",
    topic_slug: row.grammar_topics?.slug ?? "grammar-topic",
    topic_description: row.grammar_topics?.description ?? null,
    total_minor_issues: row.total_minor_issues,
    total_major_issues: row.total_major_issues,
    total_correct_after_practice: row.total_correct_after_practice,
    weakness_level: row.weakness_level as WeaknessLevel,
    practice_unlocked: row.practice_unlocked,
    last_seen_at: row.last_seen_at,
    updated_at: row.updated_at,
    student_name: row.profiles?.full_name ?? row.profiles?.email ?? null,
    student_email: row.profiles?.email ?? null,
  };
}

export function getWeaknessLabel(level: WeaknessLevel, practiceUnlocked: boolean) {
  if (practiceUnlocked || level === "unlocked") return "Practice unlocked";
  if (level === "weak") return "Weak";
  if (level === "improving") return "Improving";
  if (level === "mastered") return "Mastered";
  return "Tracking";
}

export function getWeaknessBadgeClass(level: WeaknessLevel, practiceUnlocked: boolean) {
  if (practiceUnlocked || level === "unlocked") {
    return "bg-green-50 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-100 dark:border-green-700";
  }
  if (level === "weak") {
    return "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-100 dark:border-orange-700";
  }
  if (level === "improving") {
    return "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-700";
  }
  if (level === "mastered") {
    return "bg-primary/10 text-primary border-primary/20";
  }
  return "bg-muted text-muted-foreground border-border";
}

export function formatIssueCount(stat: StudentGrammarStat) {
  const parts = [];
  if (stat.total_major_issues > 0) {
    parts.push(`${stat.total_major_issues} major`);
  }
  if (stat.total_minor_issues > 0) {
    parts.push(`${stat.total_minor_issues} minor`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No current issues";
}

export async function listStudentGrammarStats(
  workspaceId: string,
  studentId: string,
  limit: number = GRAMMAR_STATS_LIMITS.student,
): Promise<StudentGrammarStat[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("student_grammar_stats")
    .select("*, grammar_topics!inner(id, name, slug, description)")
    .eq("workspace_id", workspaceId)
    .eq("student_id", studentId)
    .order("practice_unlocked", { ascending: false })
    .order("total_major_issues", { ascending: false })
    .order("total_minor_issues", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as StatsRowWithRelations[]).map(mapGrammarStat);
}

export async function listWorkspaceGrammarStats(
  workspaceId: string,
  limit: number = GRAMMAR_STATS_LIMITS.workspace,
): Promise<StudentGrammarStat[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("student_grammar_stats")
    .select("*, grammar_topics!inner(id, name, slug, description), profiles!student_grammar_stats_student_id_fkey(id, full_name, email)")
    .eq("workspace_id", workspaceId)
    .order("practice_unlocked", { ascending: false })
    .order("total_major_issues", { ascending: false })
    .order("total_minor_issues", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as StatsRowWithRelations[]).map(mapGrammarStat);
}
