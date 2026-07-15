import { beforeEach, describe, expect, it, vi } from "vitest";

const callApiRpc = vi.hoisted(() => vi.fn());

vi.mock("@/services/apiFacade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/apiFacade")>()),
  callApiRpc,
}));

import {
  listWorkspaceBatchOptionsPage,
  listWorkspaceBatches,
  listWorkspaceBatchesPage,
} from "@/services/batchService";

describe("server-filtered class pagination service", () => {
  beforeEach(() => callApiRpc.mockReset());

  it("uses the enriched current endpoint when loading all classes for student management", async () => {
    callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [
        {
          id: "batch-1",
          workspace_id: "workspace-1",
          name: "A2 Evening",
          level: "A2",
          description: null,
          is_active: true,
          join_code: "ABC123",
          join_code_enabled: true,
          join_requires_approval: true,
          feedback_mode: "immediate",
          feedback_delay_min_minutes: 15,
          feedback_delay_max_minutes: 180,
          created_by: "teacher-1",
          created_at: "2026-07-14T09:00:00.000Z",
          updated_at: "2026-07-14T10:00:00.000Z",
          student_count: 1,
          submission_count: 3,
          current_writing_daily_limit: 3,
          pending_writing_limit_request_id: null,
          pending_writing_limit_request_status: null,
          pending_writing_daily_limit: null,
          pending_writing_limit_request_revision: null,
        },
      ],
      unfiltered_total_count: 1,
      total_count: 1,
      returned_count: 1,
      page_size: 100,
      has_more: false,
      next_cursor: null,
    });

    await expect(listWorkspaceBatches("workspace-1")).resolves.toHaveLength(1);
    expect(callApiRpc).toHaveBeenCalledWith(
      "list_workspace_batches_page",
      {
        target_workspace_id: "workspace-1",
        requested_page_size: 100,
        cursor_created_at: null,
        cursor_id: null,
        target_status: "all",
        target_level: null,
      },
      "Classes could not be loaded. Please try again.",
    );
  });

  it("passes status, CEFR, page size, and keyset cursor to the filtered overload", async () => {
    callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [],
      unfiltered_total_count: 30,
      total_count: 25,
      returned_count: 0,
      page_size: 12,
      has_more: false,
      next_cursor: null,
    });

    const page = await listWorkspaceBatchesPage({
      workspaceId: "workspace-1",
      status: "inactive",
      level: "B1",
      pageSize: 12,
      cursor: {
        created_at: "2026-07-13T00:00:00.000Z",
        id: "batch-12",
      },
    });

    expect(page.total_count).toBe(25);
    expect(callApiRpc).toHaveBeenCalledWith(
      "list_workspace_batches_page",
      {
        target_workspace_id: "workspace-1",
        requested_page_size: 12,
        cursor_created_at: "2026-07-13T00:00:00.000Z",
        cursor_id: "batch-12",
        target_status: "inactive",
        target_level: "B1",
      },
      "Classes could not be loaded. Please try again.",
    );
  });

  it("rejects a has-more response without a complete next cursor", async () => {
    callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [],
      unfiltered_total_count: 13,
      total_count: 13,
      returned_count: 0,
      page_size: 12,
      has_more: true,
      next_cursor: null,
    });

    await expect(
      listWorkspaceBatchesPage({
        workspaceId: "workspace-1",
        status: "active",
        level: null,
        pageSize: 12,
        cursor: null,
      }),
    ).rejects.toMatchObject({ code: "data_invalid_response" });
  });

  it("parses the current writing limit and one complete pending request", async () => {
    callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [
        {
          id: "batch-1",
          workspace_id: "workspace-1",
          name: "A1 Evening",
          level: "A1",
          description: null,
          is_active: true,
          join_code: "ABC123",
          join_code_enabled: true,
          join_requires_approval: true,
          feedback_mode: "immediate",
          feedback_delay_min_minutes: 15,
          feedback_delay_max_minutes: 180,
          created_by: "teacher-1",
          created_at: "2026-07-14T09:00:00.000Z",
          updated_at: "2026-07-14T10:00:00.000Z",
          student_count: 5,
          submission_count: 7,
          current_writing_daily_limit: 3,
          pending_writing_limit_request_id: "request-1",
          pending_writing_limit_request_status: "pending",
          pending_writing_daily_limit: 8,
          pending_writing_limit_request_revision: 2,
        },
      ],
      unfiltered_total_count: 1,
      total_count: 1,
      returned_count: 1,
      page_size: 12,
      has_more: false,
      next_cursor: null,
    });

    await expect(
      listWorkspaceBatchesPage({
        workspaceId: "workspace-1",
        status: "active",
        level: null,
        pageSize: 12,
        cursor: null,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          current_writing_daily_limit: 3,
          pending_writing_limit_request_status: "pending",
          pending_writing_daily_limit: 8,
          pending_writing_limit_request_revision: 2,
        },
      ],
    });
  });

  it.each([
    [
      "out-of-range current limit",
      {
        current_writing_daily_limit: 11,
        pending_writing_limit_request_id: null,
        pending_writing_limit_request_status: null,
        pending_writing_daily_limit: null,
        pending_writing_limit_request_revision: null,
      },
    ],
    [
      "partial pending request",
      {
        current_writing_daily_limit: 3,
        pending_writing_limit_request_id: "request-1",
        pending_writing_limit_request_status: "pending",
        pending_writing_daily_limit: null,
        pending_writing_limit_request_revision: 1,
      },
    ],
  ])("rejects invalid writing-limit class data: %s", async (_label, item) => {
    callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [item],
      unfiltered_total_count: 1,
      total_count: 1,
      returned_count: 1,
      page_size: 12,
      has_more: false,
      next_cursor: null,
    });

    await expect(
      listWorkspaceBatchesPage({
        workspaceId: "workspace-1",
        status: "active",
        level: null,
        pageSize: 12,
        cursor: null,
      }),
    ).rejects.toMatchObject({ code: "data_invalid_response" });
  });

  it("loads only compact class options for the teacher Overview", async () => {
    callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [
        {
          id: "batch-1",
          name: "A1 Evening",
          level: "A1",
          is_active: true,
        },
      ],
      unfiltered_total_count: 52,
      total_count: 1,
      returned_count: 1,
      page_size: 20,
      has_more: false,
      next_cursor: null,
    });

    await expect(
      listWorkspaceBatchOptionsPage({
        workspaceId: "workspace-1",
        pageSize: 20,
        cursor: {
          created_at: "2026-07-13T00:00:00.000Z",
          id: "batch-cursor",
        },
        search: "  evening  ",
      }),
    ).resolves.toEqual({
      schema_version: 1,
      items: [
        {
          id: "batch-1",
          name: "A1 Evening",
          level: "A1",
          is_active: true,
        },
      ],
      unfiltered_total_count: 52,
      total_count: 1,
      returned_count: 1,
      page_size: 20,
      has_more: false,
      next_cursor: null,
    });
    expect(callApiRpc).toHaveBeenCalledWith(
      "list_workspace_batch_options",
      {
        target_workspace_id: "workspace-1",
        requested_page_size: 20,
        cursor_created_at: "2026-07-13T00:00:00.000Z",
        cursor_id: "batch-cursor",
        target_search: "evening",
      },
      "Class options could not be loaded. Please try again.",
    );
  });

  it("rejects private or enriched fields in the compact Overview response", async () => {
    callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [
        {
          id: "batch-1",
          name: "A1 Evening",
          level: "A1",
          is_active: true,
          join_code: "MUST_NOT_REACH_OVERVIEW",
        },
      ],
      unfiltered_total_count: 1,
      total_count: 1,
      returned_count: 1,
      page_size: 20,
      has_more: false,
      next_cursor: null,
    });

    await expect(
      listWorkspaceBatchOptionsPage({
        workspaceId: "workspace-1",
        pageSize: 20,
        cursor: null,
        search: "",
      }),
    ).rejects.toMatchObject({ code: "data_invalid_response" });
  });

  it("rejects has-more when the exact total proves there is no next row", async () => {
    callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [
        {
          id: "batch-1",
          name: "A1 Evening",
          level: "A1",
          is_active: true,
        },
      ],
      unfiltered_total_count: 1,
      total_count: 1,
      returned_count: 1,
      page_size: 1,
      has_more: true,
      next_cursor: {
        created_at: "2026-07-13T00:00:00.000Z",
        id: "batch-1",
      },
    });

    await expect(
      listWorkspaceBatchOptionsPage({
        workspaceId: "workspace-1",
        pageSize: 1,
        cursor: null,
        search: "",
      }),
    ).rejects.toMatchObject({ code: "data_invalid_response" });
  });

  it.each([
    ["non-numeric total", { total_count: "1" }],
    ["returned-count mismatch", { returned_count: 0 }],
    ["total below item length", { total_count: 0 }],
    [
      "invalid level",
      {
        items: [
          { id: "batch-1", name: "A1 Evening", level: "C1", is_active: true },
        ],
      },
    ],
    [
      "empty name",
      { items: [{ id: "batch-1", name: "   ", level: "A1", is_active: true }] },
    ],
    [
      "non-boolean status",
      {
        items: [
          { id: "batch-1", name: "A1 Evening", level: "A1", is_active: "true" },
        ],
      },
    ],
  ])("rejects malformed compact options: %s", async (_label, override) => {
    callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [
        {
          id: "batch-1",
          name: "A1 Evening",
          level: "A1",
          is_active: true,
        },
      ],
      unfiltered_total_count: 1,
      total_count: 1,
      returned_count: 1,
      page_size: 20,
      has_more: false,
      next_cursor: null,
      ...override,
    });

    await expect(
      listWorkspaceBatchOptionsPage({
        workspaceId: "workspace-1",
        pageSize: 20,
        cursor: null,
        search: "",
      }),
    ).rejects.toMatchObject({ code: "data_invalid_response" });
  });
});
