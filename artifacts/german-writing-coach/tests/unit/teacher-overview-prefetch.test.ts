import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  batchOptions: vi.fn(),
  dashboardSummary: vi.fn(),
  onboarding: vi.fn(),
  submissions: vi.fn(),
}));

vi.mock("@/services/batchService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/batchService")>()),
  listWorkspaceBatchOptionsPage: mocks.batchOptions,
}));

vi.mock("@/services/teacherReadModelService", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/services/teacherReadModelService")
  >()),
  getTeacherDashboardSummary: mocks.dashboardSummary,
}));

vi.mock("@/services/submissionService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/submissionService")>()),
  listTeacherWorkspaceSubmissionsPage: mocks.submissions,
}));

vi.mock("@/services/onboardingService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/onboardingService")>()),
  getOnboardingProgress: mocks.onboarding,
}));

import { createTeacherDashboardQueries } from "@/lib/dashboardQueries";
import { createOnboardingProgressQuery } from "@/lib/onboardingQueries";
import { prefetchTeacherOverviewQueries } from "@/lib/teacherOverviewPrefetch";

describe("trusted Teacher Overview prefetch", () => {
  beforeEach(() => {
    mocks.batchOptions.mockReset().mockResolvedValue({
      schema_version: 1,
      items: [],
      unfiltered_total_count: 0,
      total_count: 0,
      returned_count: 0,
      page_size: 100,
      has_more: false,
      next_cursor: null,
    });
    mocks.dashboardSummary.mockReset().mockResolvedValue({
      schema_version: 1,
      workspace_id: "workspace-1",
      batch_id: null,
      student_count: 0,
      question_count: 0,
      pending_join_request_count: 0,
      attention_items: [],
    });
    mocks.submissions.mockReset().mockResolvedValue({ items: [] });
    mocks.onboarding.mockReset().mockResolvedValue({
      role: "teacher",
      revision: 0,
      steps: [],
      completed_steps: [],
      completed_count: 0,
      total_count: 4,
      all_complete: false,
      next_step: "create_class",
    });
  });

  it("starts all four reads and deduplicates the mounted page consumers", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await prefetchTeacherOverviewQueries(queryClient, "workspace-1");
    const dashboard = createTeacherDashboardQueries("workspace-1", null);
    const onboarding = createOnboardingProgressQuery("workspace-1", "teacher");
    await Promise.all([
      queryClient.fetchInfiniteQuery(dashboard.batches),
      queryClient.fetchQuery(dashboard.summary),
      queryClient.fetchQuery(dashboard.submissions),
      queryClient.fetchQuery(onboarding),
    ]);

    expect(mocks.batchOptions).toHaveBeenCalledTimes(1);
    expect(mocks.batchOptions).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      pageSize: 100,
      cursor: null,
      search: "",
    });
    expect(mocks.dashboardSummary).toHaveBeenCalledTimes(1);
    expect(mocks.submissions).toHaveBeenCalledTimes(1);
    expect(mocks.onboarding).toHaveBeenCalledTimes(1);
  });
});
