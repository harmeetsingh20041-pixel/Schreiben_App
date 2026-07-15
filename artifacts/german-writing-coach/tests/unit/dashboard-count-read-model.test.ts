import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSupabaseClient } = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("@/lib/supabaseClient", () => ({ getSupabaseClient }));

import { getWorkspaceQuestionCount } from "@/services/questionService";
import { getWorkspaceStudentCount } from "@/services/studentService";

function page(totalCount: number) {
  return {
    schema_version: 1,
    items: [{ id: "first-row" }],
    total_count: totalCount,
    returned_count: 1,
    page_size: 1,
    has_more: totalCount > 1,
    next_cursor: totalCount > 1
      ? { created_at: "2026-07-10T08:00:00.000Z", id: "first-row" }
      : null,
  };
}

function rosterPage(totalCount: number) {
  return {
    ...page(totalCount),
    items: [{
      id: "student-1",
      name: "Student One",
      email: "student@example.test",
      membership_id: "first-row",
      batches: [],
      total_submissions: 0,
      last_active_at: null,
      weak_topics: [],
    }],
  };
}

describe("dashboard count projections", () => {
  beforeEach(() => {
    getSupabaseClient.mockReset();
  });

  it("uses the paginated task read model's exact count without downloading the task bank", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: page(67), error: null });
    const from = vi.fn();
    getSupabaseClient.mockReturnValue({ rpc, from });

    await expect(getWorkspaceQuestionCount("workspace-1")).resolves.toBe(67);
    expect(rpc).toHaveBeenCalledWith("list_workspace_questions_page", {
      target_workspace_id: "workspace-1",
      requested_page_size: 1,
      cursor_created_at: null,
      cursor_id: null,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("uses the paginated roster read model's exact count without downloading all students", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: rosterPage(143), error: null });
    const from = vi.fn();
    getSupabaseClient.mockReturnValue({ rpc, from });

    await expect(getWorkspaceStudentCount("workspace-1")).resolves.toBe(143);
    expect(rpc).toHaveBeenCalledWith("list_workspace_students_filtered_page", {
      target_workspace_id: "workspace-1",
      search_query: "",
      target_batch_id: null,
      target_level: null,
      requested_page_size: 1,
      cursor_created_at: null,
      cursor_membership_id: null,
    });
    expect(from).not.toHaveBeenCalled();
  });
});
