import { PublicAppError } from "@/lib/appError";
import { callApiRpc, parseApiPage } from "@/services/apiFacade";

export type WeaknessLevel = "locked" | "unlocked" | "in_progress" | "improving" | "mastered";

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
  resolution_cycle_id: string | null;
  resolution_cycle_number: number;
  resolved_through_sequence: number;
  mastery_pass_count: number;
  state_reason: string | null;
  last_seen_at: string | null;
  updated_at: string;
  student_name?: string | null;
  student_email?: string | null;
}

export const STUDENT_GRAMMAR_STATS_PAGE_SIZE = 100;
export const WORKSPACE_GRAMMAR_STATS_PAGE_SIZE = 200;

interface GrammarStatCursor {
  practice_unlocked: boolean;
  total_major_issues: number;
  total_minor_issues: number;
  id: string;
}

interface GrammarStatReadContext {
  workspaceId: string;
  studentId?: string;
}

class GrammarStatsSnapshotChanged extends Error {}

const weaknessLevels = new Set<WeaknessLevel>([
  "locked",
  "unlocked",
  "in_progress",
  "improving",
  "mastered",
]);

function invalidGrammarStatsResponse(label: string): PublicAppError {
  return new PublicAppError(
    "data_invalid_response",
    `${label} could not be loaded safely. Please refresh and try again.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseGrammarStat(
  value: unknown,
  context: GrammarStatReadContext,
  label: string,
): StudentGrammarStat {
  if (!isRecord(value)) throw invalidGrammarStatsResponse(label);

  const requiredStrings = [
    "id",
    "workspace_id",
    "student_id",
    "grammar_topic_id",
    "topic_name",
    "topic_slug",
    "updated_at",
  ] as const;
  const requiredCounts = [
    "total_minor_issues",
    "total_major_issues",
    "total_correct_after_practice",
    "resolution_cycle_number",
    "resolved_through_sequence",
    "mastery_pass_count",
  ] as const;

  if (
    requiredStrings.some((key) => typeof value[key] !== "string" || value[key].length === 0)
    || requiredCounts.some((key) => !isNonNegativeInteger(value[key]))
    || typeof value.practice_unlocked !== "boolean"
    || typeof value.weakness_level !== "string"
    || !weaknessLevels.has(value.weakness_level as WeaknessLevel)
    || !isNullableString(value.topic_description)
    || !isNullableString(value.resolution_cycle_id)
    || !isNullableString(value.state_reason)
    || !isNullableString(value.last_seen_at)
    || (value.student_name !== undefined && !isNullableString(value.student_name))
    || (value.student_email !== undefined && !isNullableString(value.student_email))
    || value.workspace_id !== context.workspaceId
    || (context.studentId !== undefined && value.student_id !== context.studentId)
  ) {
    throw invalidGrammarStatsResponse(label);
  }

  return value as unknown as StudentGrammarStat;
}

function compareGrammarStats(left: StudentGrammarStat, right: StudentGrammarStat): number {
  if (left.practice_unlocked !== right.practice_unlocked) {
    return left.practice_unlocked ? -1 : 1;
  }
  if (left.total_major_issues !== right.total_major_issues) {
    return right.total_major_issues - left.total_major_issues;
  }
  if (left.total_minor_issues !== right.total_minor_issues) {
    return right.total_minor_issues - left.total_minor_issues;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function parseGrammarStatCursor(value: unknown, label: string): GrammarStatCursor {
  if (
    !isRecord(value)
    || typeof value.practice_unlocked !== "boolean"
    || !isNonNegativeInteger(value.total_major_issues)
    || !isNonNegativeInteger(value.total_minor_issues)
    || typeof value.id !== "string"
    || value.id.length === 0
  ) {
    throw invalidGrammarStatsResponse(label);
  }
  return value as unknown as GrammarStatCursor;
}

function cursorMatchesStat(cursor: GrammarStatCursor, stat: StudentGrammarStat): boolean {
  return cursor.practice_unlocked === stat.practice_unlocked
    && cursor.total_major_issues === stat.total_major_issues
    && cursor.total_minor_issues === stat.total_minor_issues
    && cursor.id === stat.id;
}

async function collectGrammarStatsOnce(
  loadPage: (cursor: GrammarStatCursor | null) => Promise<unknown>,
  pageSize: number,
  context: GrammarStatReadContext,
  label: string,
): Promise<StudentGrammarStat[]> {
  const collected: StudentGrammarStat[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: GrammarStatCursor | null = null;
  let expectedTotal: number | null = null;
  let pageNumber = 0;

  while (true) {
    const page = parseApiPage<unknown>(await loadPage(cursor), label);
    pageNumber += 1;

    if (
      page.page_size !== pageSize
      || page.items.length > pageSize
      || (page.has_more && page.items.length !== pageSize)
    ) {
      throw invalidGrammarStatsResponse(label);
    }

    if (expectedTotal === null) {
      expectedTotal = page.total_count;
    } else if (page.total_count !== expectedTotal) {
      throw new GrammarStatsSnapshotChanged();
    }

    const pageItems = page.items.map((item) => parseGrammarStat(item, context, label));
    for (const stat of pageItems) {
      const previous = collected.at(-1);
      if (previous && compareGrammarStats(previous, stat) > 0) {
        throw invalidGrammarStatsResponse(label);
      }
      if (seenIds.has(stat.id)) {
        throw new GrammarStatsSnapshotChanged();
      }
      seenIds.add(stat.id);
      collected.push(stat);
    }

    if (collected.length > expectedTotal) {
      throw new GrammarStatsSnapshotChanged();
    }

    if (!page.has_more) {
      if (page.next_cursor !== null) throw invalidGrammarStatsResponse(label);
      if (collected.length !== expectedTotal) throw new GrammarStatsSnapshotChanged();
      return collected;
    }

    if (expectedTotal === 0 || pageNumber >= Math.ceil(expectedTotal / pageSize)) {
      throw new GrammarStatsSnapshotChanged();
    }

    const nextCursor = parseGrammarStatCursor(page.next_cursor, label);
    const lastItem = pageItems.at(-1);
    if (!lastItem || !cursorMatchesStat(nextCursor, lastItem)) {
      throw invalidGrammarStatsResponse(label);
    }

    const cursorKey = JSON.stringify(nextCursor);
    if (seenCursors.has(cursorKey)) throw invalidGrammarStatsResponse(label);
    seenCursors.add(cursorKey);
    cursor = nextCursor;
  }
}

async function collectGrammarStats(
  loadPage: (cursor: GrammarStatCursor | null) => Promise<unknown>,
  pageSize: number,
  context: GrammarStatReadContext,
  label: string,
): Promise<StudentGrammarStat[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await collectGrammarStatsOnce(loadPage, pageSize, context, label);
    } catch (error) {
      if (!(error instanceof GrammarStatsSnapshotChanged)) throw error;
    }
  }
  throw invalidGrammarStatsResponse(label);
}

export function getWeaknessLabel(level: WeaknessLevel, practiceUnlocked: boolean) {
  if (practiceUnlocked || level === "unlocked") return "Practice unlocked";
  if (level === "in_progress") return "In progress";
  if (level === "locked") return "Locked";
  if (level === "improving") return "Improving";
  if (level === "mastered") return "Mastered";
  return "Locked";
}

export function getWeaknessBadgeClass(level: WeaknessLevel, practiceUnlocked: boolean) {
  if (practiceUnlocked || level === "unlocked") {
    return "bg-green-50 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-100 dark:border-green-700";
  }
  if (level === "locked") {
    return "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-100 dark:border-orange-700";
  }
  if (level === "in_progress" || level === "improving") {
    return "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-700";
  }
  if (level === "mastered") {
    return "bg-primary/10 text-primary border-primary/20";
  }
  return "bg-muted text-muted-foreground border-border";
}

export function getWeaknessStateDescription(stat: StudentGrammarStat) {
  if (stat.weakness_level === "locked") {
    if (stat.state_reason === "level_fit_approval_required") {
      return "We are matching this advanced topic to practice at your current level. No teacher action is normally needed; the worksheet will appear when the approved material is ready.";
    }
    if (stat.state_reason === "active_class_context_required") {
      return "This focus area belongs to a class that is no longer active for you. Join or select an active class before starting new practice.";
    }
    if (stat.state_reason === "teacher_support_required") {
      return "Automatic retries are paused. Your teacher can review this focus area and choose the best next step.";
    }
    return "This released focus area is temporarily held while its class or worksheet safety checks finish.";
  }
  if (stat.weakness_level === "unlocked") {
    return "Your released feedback identified this focus area. One worksheet is available for practice.";
  }
  if (stat.weakness_level === "in_progress") {
    return "This cycle is active. Finish the current worksheet before another one can be assigned.";
  }
  if (stat.weakness_level === "improving") {
    return "You passed the worksheet for the latest evidence. Future feedback starts a new cycle instead of reopening old issues.";
  }
  return "You have passed this focus area in at least two separate evidence cycles. New feedback can still start a fresh cycle.";
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
): Promise<StudentGrammarStat[]> {
  return collectGrammarStats(
    (cursor) => callApiRpc<unknown>(
      "list_student_grammar_stats_page",
      {
        target_workspace_id: workspaceId,
        target_student_id: studentId,
        requested_page_size: STUDENT_GRAMMAR_STATS_PAGE_SIZE,
        cursor_practice_unlocked: cursor?.practice_unlocked ?? null,
        cursor_total_major_issues: cursor?.total_major_issues ?? null,
        cursor_total_minor_issues: cursor?.total_minor_issues ?? null,
        cursor_stat_id: cursor?.id ?? null,
      },
      "Practice strengths could not be loaded. Please try again.",
    ),
    STUDENT_GRAMMAR_STATS_PAGE_SIZE,
    { workspaceId, studentId },
    "Practice strengths",
  );
}

export async function listWorkspaceGrammarStats(
  workspaceId: string,
): Promise<StudentGrammarStat[]> {
  return collectGrammarStats(
    (cursor) => callApiRpc<unknown>(
      "list_workspace_grammar_stats_keyset_page",
      {
        target_workspace_id: workspaceId,
        requested_page_size: WORKSPACE_GRAMMAR_STATS_PAGE_SIZE,
        cursor_practice_unlocked: cursor?.practice_unlocked ?? null,
        cursor_total_major_issues: cursor?.total_major_issues ?? null,
        cursor_total_minor_issues: cursor?.total_minor_issues ?? null,
        cursor_stat_id: cursor?.id ?? null,
      },
      "Workspace practice strengths could not be loaded. Please try again.",
    ),
    WORKSPACE_GRAMMAR_STATS_PAGE_SIZE,
    { workspaceId },
    "Workspace practice strengths",
  );
}
