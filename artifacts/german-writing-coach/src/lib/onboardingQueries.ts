import { queryOptions } from "@tanstack/react-query";
import { appQueryKeys } from "@/lib/appQueryKeys";
import {
  getOnboardingProgress,
  type OnboardingRole,
} from "@/services/onboardingService";

export function createOnboardingProgressQuery(
  workspaceId: string,
  role: OnboardingRole,
) {
  return queryOptions({
    queryKey: appQueryKeys.onboardingProgress(workspaceId, role),
    queryFn: () => getOnboardingProgress(workspaceId, role),
    staleTime: 15_000,
  });
}
