import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  createStudentAccessQueries,
  createStudentWorkspaceDashboardQueries,
  createTeacherDashboardQueries,
  type StudentDashboardLoaders,
  type TeacherDashboardLoaders,
} from "@/lib/dashboardQueries";

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

function teacherLoaders() {
  return {
    batches: vi.fn(async () => ({
      schema_version: 1 as const,
      items: [],
      unfiltered_total_count: 0,
      total_count: 0,
      returned_count: 0,
      page_size: 100,
      has_more: false,
      next_cursor: null,
    })),
    summary: vi.fn(async (_workspaceId: string, batchId: string | null) => ({
      schema_version: 1 as const,
      workspace_id: "workspace-1",
      batch_id: batchId,
      student_count: 18,
      question_count: 7,
      pending_join_request_count: 2,
      attention_items: [],
    })),
    submissions: vi.fn(async () => ({ items: [] })),
  } as unknown as TeacherDashboardLoaders;
}

function studentLoaders() {
  return {
    assignments: vi.fn(async () => []),
    joinRequests: vi.fn(async () => []),
    submissions: vi.fn(async () => ({ items: [] })),
    releasedFeedback: vi.fn(async () => ({
      released_count: 0,
      latest_submission: null,
    })),
    grammarStats: vi.fn(async () => []),
  } as unknown as StudentDashboardLoaders;
}

async function fetchTeacherDashboard(
  client: QueryClient,
  queries: ReturnType<typeof createTeacherDashboardQueries>,
) {
  await Promise.all([
    client.fetchInfiniteQuery(queries.batches),
    client.fetchQuery(queries.summary),
    client.fetchQuery(queries.submissions),
  ]);
}

describe("dashboard request budgets", () => {
  it("deduplicates concurrent consumers of the same cached resource", async () => {
    const client = createClient();
    const loaders = teacherLoaders();
    const first = createTeacherDashboardQueries("workspace-1", null, loaders);
    const second = createTeacherDashboardQueries("workspace-1", null, loaders);

    await Promise.all([
      client.fetchInfiniteQuery(first.batches),
      client.fetchInfiniteQuery(second.batches),
    ]);

    expect(loaders.batches).toHaveBeenCalledTimes(1);
    expect(loaders.batches).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      pageSize: 100,
      cursor: null,
      search: "",
    });
  });

  it("changes only the bounded summary and submissions requests when the class filter changes", async () => {
    const client = createClient();
    const loaders = teacherLoaders();

    await fetchTeacherDashboard(
      client,
      createTeacherDashboardQueries("workspace-1", null, loaders),
    );
    await fetchTeacherDashboard(
      client,
      createTeacherDashboardQueries("workspace-1", "batch-2", loaders),
    );

    expect(loaders.submissions).toHaveBeenCalledTimes(2);
    expect(loaders.submissions).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      batchId: null,
      pageSize: 5,
    });
    expect(loaders.submissions).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      batchId: "batch-2",
      pageSize: 5,
    });
    expect(loaders.batches).toHaveBeenCalledTimes(1);
    expect(loaders.summary).toHaveBeenCalledTimes(2);
    expect(loaders.summary).toHaveBeenNthCalledWith(1, "workspace-1", null);
    expect(loaders.summary).toHaveBeenNthCalledWith(
      2,
      "workspace-1",
      "batch-2",
    );

    const summaryOptions = createTeacherDashboardQueries(
      "workspace-1",
      null,
      loaders,
    ).summary;
    expect(summaryOptions.refetchInterval).toBe(15_000);
    expect(summaryOptions.refetchIntervalInBackground).toBe(false);
  });

  it("shares student class-access requests across dashboard and task-list consumers", async () => {
    const client = createClient();
    const loaders = studentLoaders();
    const dashboard = createStudentAccessQueries("student-1", loaders);
    const writingTasks = createStudentAccessQueries("student-1", loaders);

    await Promise.all([
      client.fetchQuery(dashboard.assignments),
      client.fetchQuery(dashboard.joinRequests),
    ]);
    await Promise.all([
      client.fetchQuery(writingTasks.assignments),
      client.fetchQuery(writingTasks.joinRequests),
    ]);

    expect(loaders.assignments).toHaveBeenCalledTimes(1);
    expect(loaders.joinRequests).toHaveBeenCalledTimes(1);
  });

  it("uses a distinct server-side released-feedback summary for the selected class", async () => {
    const client = createClient();
    const loaders = studentLoaders();
    const queries = createStudentWorkspaceDashboardQueries(
      "workspace-1",
      "student-1",
      "batch-2",
      loaders,
    );

    await Promise.all([
      client.fetchQuery(queries.submissions),
      client.fetchQuery(queries.releasedFeedback),
    ]);

    expect(loaders.submissions).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      studentId: "student-1",
      batchId: "batch-2",
      pageSize: 4,
    });
    expect(loaders.releasedFeedback).toHaveBeenCalledWith(
      "workspace-1",
      "student-1",
      "batch-2",
    );
  });

  it("clears cached user data when the authenticated identity is cleared or changes", () => {
    const authSource = readFileSync(
      path.resolve(process.cwd(), "src/lib/auth.tsx"),
      "utf8",
    );

    expect(authSource).toContain("cachedUserIdRef.current !== nextUserId");
    expect(
      authSource.match(/queryClient\.clear\(\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(authSource).toContain("scheduleVisibleMembershipRefresh");
    expect(authSource).toContain(
      "window.setInterval(\n      scheduleVisibleMembershipRefresh,\n      30_000,\n    )",
    );
    expect(authSource).toContain('window.addEventListener("focus"');
  });
});
