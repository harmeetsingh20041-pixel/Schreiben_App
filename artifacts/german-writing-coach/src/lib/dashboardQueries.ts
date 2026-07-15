import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { appQueryKeys, SHARED_QUERY_STALE_MS } from "@/lib/appQueryKeys";
import {
  listWorkspaceBatchOptionsPage,
  type WorkspaceBatchOptionCursor,
} from "@/services/batchService";
import {
  getStudentReleasedFeedbackSummary,
  listTeacherWorkspaceSubmissionsPage,
  listStudentSubmissionsPage,
} from "@/services/submissionService";
import {
  listMyBatchAssignments,
  listMyBatchJoinRequests,
} from "@/services/studentService";
import {
  listStudentGrammarStats,
  STUDENT_GRAMMAR_STATS_PAGE_SIZE,
} from "@/services/grammarStatsService";
import { getTeacherDashboardSummary } from "@/services/teacherReadModelService";

export interface TeacherDashboardLoaders {
  batches: typeof listWorkspaceBatchOptionsPage;
  summary: typeof getTeacherDashboardSummary;
  submissions: typeof listTeacherWorkspaceSubmissionsPage;
}

const teacherDashboardLoaders: TeacherDashboardLoaders = {
  batches: listWorkspaceBatchOptionsPage,
  summary: getTeacherDashboardSummary,
  submissions: listTeacherWorkspaceSubmissionsPage,
};

export const OVERVIEW_BATCH_OPTION_PAGE_SIZE = 100;

export function createTeacherDashboardQueries(
  workspaceId: string,
  batchId: string | null,
  batchSearchOrLoaders: string | TeacherDashboardLoaders = "",
  suppliedLoaders: TeacherDashboardLoaders = teacherDashboardLoaders,
) {
  const batchSearch =
    typeof batchSearchOrLoaders === "string" ? batchSearchOrLoaders : "";
  const loaders =
    typeof batchSearchOrLoaders === "string"
      ? suppliedLoaders
      : batchSearchOrLoaders;
  const normalizedBatchSearch = batchSearch.trim();
  return {
    batches: infiniteQueryOptions({
      queryKey: appQueryKeys.workspaceBatchOptions({
        workspaceId,
        search: normalizedBatchSearch,
        pageSize: OVERVIEW_BATCH_OPTION_PAGE_SIZE,
        cursor: null,
      }),
      queryFn: ({ pageParam }) =>
        loaders.batches({
          workspaceId,
          pageSize: OVERVIEW_BATCH_OPTION_PAGE_SIZE,
          cursor: pageParam,
          search: normalizedBatchSearch,
        }),
      initialPageParam: null as WorkspaceBatchOptionCursor | null,
      getNextPageParam: (lastPage) =>
        lastPage.has_more
          ? {
              created_at: lastPage.next_cursor!.created_at!,
              id: lastPage.next_cursor!.id,
            }
          : undefined,
      staleTime: SHARED_QUERY_STALE_MS,
    }),
    summary: queryOptions({
      queryKey: appQueryKeys.teacherDashboardSummary(workspaceId, batchId),
      queryFn: () => loaders.summary(workspaceId, batchId),
      staleTime: 10_000,
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    }),
    submissions: queryOptions({
      queryKey: appQueryKeys.teacherSubmissionsPage({
        workspaceId,
        batchId,
        pageSize: 5,
        cursor: null,
      }),
      queryFn: () => loaders.submissions({ workspaceId, batchId, pageSize: 5 }),
      staleTime: SHARED_QUERY_STALE_MS,
    }),
  };
}

export interface StudentDashboardLoaders {
  assignments: typeof listMyBatchAssignments;
  joinRequests: typeof listMyBatchJoinRequests;
  submissions: typeof listStudentSubmissionsPage;
  releasedFeedback: typeof getStudentReleasedFeedbackSummary;
  grammarStats: typeof listStudentGrammarStats;
}

const studentDashboardLoaders: StudentDashboardLoaders = {
  assignments: listMyBatchAssignments,
  joinRequests: listMyBatchJoinRequests,
  submissions: listStudentSubmissionsPage,
  releasedFeedback: getStudentReleasedFeedbackSummary,
  grammarStats: listStudentGrammarStats,
};

export function createStudentAccessQueries(
  studentId: string,
  loaders: StudentDashboardLoaders = studentDashboardLoaders,
) {
  return {
    assignments: queryOptions({
      queryKey: appQueryKeys.studentBatchAssignments(studentId),
      queryFn: () => loaders.assignments(studentId),
      staleTime: SHARED_QUERY_STALE_MS,
    }),
    joinRequests: queryOptions({
      queryKey: appQueryKeys.studentJoinRequests(studentId),
      queryFn: () => loaders.joinRequests(studentId),
      staleTime: SHARED_QUERY_STALE_MS,
    }),
  };
}

export function createStudentWorkspaceDashboardQueries(
  workspaceId: string,
  studentId: string,
  batchId: string | null,
  loaders: StudentDashboardLoaders = studentDashboardLoaders,
) {
  return {
    submissions: queryOptions({
      queryKey: appQueryKeys.studentSubmissionsPage({
        workspaceId,
        studentId,
        batchId,
        pageSize: 4,
        cursor: null,
      }),
      queryFn: () =>
        loaders.submissions({
          workspaceId,
          studentId,
          batchId,
          pageSize: 4,
        }),
      staleTime: SHARED_QUERY_STALE_MS,
    }),
    releasedFeedback: queryOptions({
      queryKey: appQueryKeys.studentReleasedFeedbackSummary(
        workspaceId,
        studentId,
        batchId,
      ),
      queryFn: () => loaders.releasedFeedback(workspaceId, studentId, batchId),
      staleTime: SHARED_QUERY_STALE_MS,
    }),
    grammarStats: queryOptions({
      queryKey: appQueryKeys.studentGrammarStats(
        workspaceId,
        studentId,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE,
      ),
      queryFn: () => loaders.grammarStats(workspaceId, studentId),
      staleTime: SHARED_QUERY_STALE_MS,
    }),
  };
}
