import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { appQueryKeys, SHARED_QUERY_STALE_MS } from "@/lib/appQueryKeys";
import {
  listStudentGrammarStats,
  STUDENT_GRAMMAR_STATS_PAGE_SIZE,
} from "@/services/grammarStatsService";
import {
  getPracticeAssignmentSummary,
  listStudentPracticeAssignments,
  type PracticeAssignmentSummary,
} from "@/services/practiceWorksheetService";

export const PRACTICE_ASSIGNMENTS_POLL_INTERVAL_MS = 5_000;
// Two provider attempts can legitimately exceed two minutes. Keep the active
// recovery window finite, but long enough to cover one complete retry cycle.
export const PRACTICE_ASSIGNMENTS_POLL_WINDOW_MS = 5 * 60_000;

export const PRACTICE_WORKSPACE_SCOPE_COPY =
  "Practice uses released feedback from all of your active classes in this workspace. Your active class selection scopes Home, Write, and History; it does not filter Practice.";

export function hasPendingPracticeAssignment(
  assignments: PracticeAssignmentSummary[] | undefined,
) {
  return Boolean(
    assignments?.some(
      (assignment) =>
        assignment.generation_status === "queued" ||
        assignment.generation_status === "generating" ||
        assignment.evaluation_status === "pending" ||
        assignment.evaluation_status === "queued" ||
        assignment.evaluation_status === "evaluating" ||
        (assignment.class_context_version !== 1 &&
          assignment.status === "unlocked" &&
          assignment.practice_test_id === null &&
          assignment.latest_attempt_id === null),
    ),
  );
}

export function createBoundedPracticePollController(
  now: () => number = Date.now,
) {
  let pendingSince: number | null = null;

  return {
    getInterval(assignments: PracticeAssignmentSummary[] | undefined) {
      if (!hasPendingPracticeAssignment(assignments)) {
        pendingSince = null;
        return false;
      }
      pendingSince ??= now();
      return now() - pendingSince < PRACTICE_ASSIGNMENTS_POLL_WINDOW_MS
        ? PRACTICE_ASSIGNMENTS_POLL_INTERVAL_MS
        : false;
    },
    reset() {
      pendingSince = null;
    },
  };
}

export interface StudentPracticeLoaders {
  assignments: typeof listStudentPracticeAssignments;
  assignment: typeof getPracticeAssignmentSummary;
  stats: typeof listStudentGrammarStats;
}

const studentPracticeLoaders: StudentPracticeLoaders = {
  assignments: listStudentPracticeAssignments,
  assignment: getPracticeAssignmentSummary,
  stats: listStudentGrammarStats,
};

export function createStudentPracticeQueries(
  workspaceId: string,
  studentId: string,
  loaders: StudentPracticeLoaders = studentPracticeLoaders,
) {
  return {
    stats: queryOptions({
      queryKey: appQueryKeys.studentGrammarStats(
        workspaceId,
        studentId,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE,
      ),
      queryFn: () => loaders.stats(workspaceId, studentId),
      staleTime: SHARED_QUERY_STALE_MS,
    }),
    assignments: queryOptions({
      queryKey: appQueryKeys.studentPracticeAssignments(workspaceId, studentId),
      queryFn: () => loaders.assignments(workspaceId, studentId),
      staleTime: SHARED_QUERY_STALE_MS,
    }),
    assignment: (assignmentId: string) =>
      queryOptions({
        queryKey: appQueryKeys.studentPracticeAssignment(assignmentId),
        queryFn: () => loaders.assignment(assignmentId),
        staleTime: 5_000,
      }),
  };
}

export async function refreshStudentPracticeOnResume(
  queryClient: Pick<QueryClient, "fetchQuery">,
  queries: Pick<
    ReturnType<typeof createStudentPracticeQueries>,
    "assignments" | "stats"
  >,
  pollController: Pick<
    ReturnType<typeof createBoundedPracticePollController>,
    "reset"
  >,
) {
  pollController.reset();
  // fetchQuery reuses fresh or already in-flight React Query work. Calling the
  // observer's refetch() here forced a second identical request when a browser
  // focus event landed during route bootstrap.
  await Promise.all([
    queryClient.fetchQuery(queries.stats),
    queryClient.fetchQuery(queries.assignments),
  ]);
}
