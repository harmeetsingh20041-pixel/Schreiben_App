import type { QueryClient } from "@tanstack/react-query";
import { createTeacherDashboardQueries } from "@/lib/dashboardQueries";
import { createOnboardingProgressQuery } from "@/lib/onboardingQueries";

export async function prefetchTeacherOverviewQueries(
  queryClient: QueryClient,
  workspaceId: string,
) {
  const dashboard = createTeacherDashboardQueries(workspaceId, null, "");
  const onboarding = createOnboardingProgressQuery(workspaceId, "teacher");
  await Promise.allSettled([
    queryClient.prefetchInfiniteQuery(dashboard.batches),
    queryClient.prefetchQuery(dashboard.summary),
    queryClient.prefetchQuery(dashboard.submissions),
    queryClient.prefetchQuery(onboarding),
  ]);
}
