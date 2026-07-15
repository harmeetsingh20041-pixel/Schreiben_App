import { beforeEach, describe, expect, it, vi } from "vitest";

const callApiRpc = vi.hoisted(() => vi.fn());

vi.mock("@/services/apiFacade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/apiFacade")>();
  return { ...actual, callApiRpc };
});

import {
  decideTeacherAccess,
  disableTeacherAccess,
  getMyTeacherAccessRequest,
  getMyTeacherStart,
  getTeacherOnboardingHealth,
  listTeacherAccessRequests,
  requestTeacherAccess,
  updateTeacherWorkspaceLimit,
} from "@/services/teacherAccessService";

const timestamp = "2026-07-12T12:00:00.000Z";

function inventoryItem(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "11111111-1111-4111-8111-111111111111",
    page_cursor_id: "11111111-1111-4111-8111-111111111111",
    applicant_user_id: "22222222-2222-4222-8222-222222222222",
    applicant_name: "Pilot Teacher",
    applicant_email: "teacher@example.test",
    request_status: "pending",
    request_revision: 1,
    requested_at: timestamp,
    decided_at: null,
    decided_by: null,
    approved_max_workspaces: null,
    entitlement_active: false,
    entitlement_revision: null,
    entitlement_max_workspaces: null,
    privileged_workspace_count: 0,
    updated_at: timestamp,
    ...overrides,
  };
}

describe("teacher access service", () => {
  beforeEach(() => {
    callApiRpc.mockReset();
  });

  it("treats an empty self-status response as no request", async () => {
    callApiRpc.mockResolvedValue([]);

    await expect(getMyTeacherAccessRequest()).resolves.toBeNull();
    expect(callApiRpc).toHaveBeenCalledWith(
      "get_my_teacher_access_request",
      {},
      expect.any(String),
    );
  });

  it("sends a revision-safe request and parses its pending state", async () => {
    callApiRpc.mockResolvedValue([
      {
        request_id: "11111111-1111-4111-8111-111111111111",
        request_status: "pending",
        request_revision: 3,
        requested_at: timestamp,
        updated_at: timestamp,
      },
    ]);

    await expect(requestTeacherAccess(2)).resolves.toMatchObject({
      request_status: "pending",
      request_revision: 3,
      entitlement_active: false,
    });
    expect(callApiRpc).toHaveBeenCalledWith(
      "request_teacher_access",
      { expected_revision: 2 },
      expect.any(String),
    );
  });

  it("parses the self-only first-class destination projection", async () => {
    callApiRpc.mockResolvedValue([
      {
        workspace_id: "33333333-3333-4333-8333-333333333333",
        membership_id: "44444444-4444-4444-8444-444444444444",
        needs_first_class: true,
      },
    ]);

    await expect(getMyTeacherStart()).resolves.toEqual({
      workspace_id: "33333333-3333-4333-8333-333333333333",
      membership_id: "44444444-4444-4444-8444-444444444444",
      needs_first_class: true,
    });
    expect(callApiRpc).toHaveBeenCalledWith(
      "get_my_teacher_start",
      {},
      expect.any(String),
    );
  });

  it("uses one look-ahead row for complete keyset pagination", async () => {
    callApiRpc.mockResolvedValue([
      inventoryItem(),
      inventoryItem({
        request_id: null,
        page_cursor_id: "33333333-3333-4333-8333-333333333333",
        applicant_user_id: "33333333-3333-4333-8333-333333333333",
        request_status: "approved",
        request_revision: null,
        requested_at: null,
        decided_at: null,
        approved_max_workspaces: 2,
        entitlement_active: true,
        entitlement_revision: 4,
        entitlement_max_workspaces: 2,
        privileged_workspace_count: 1,
      }),
    ]);

    await expect(
      listTeacherAccessRequests({
        status: "pending",
        pageSize: 1,
      }),
    ).resolves.toMatchObject({
      items: [{ applicant_name: "Pilot Teacher" }],
      has_more: true,
      next_cursor: {
        id: "11111111-1111-4111-8111-111111111111",
        updated_at: timestamp,
      },
    });
    expect(callApiRpc).toHaveBeenCalledWith(
      "list_teacher_access_requests",
      expect.objectContaining({
        target_status: "pending",
        requested_page_size: 2,
        cursor_updated_at: null,
        cursor_id: null,
      }),
      expect.any(String),
    );
  });

  it("rejects an active entitlement without a concurrency revision", async () => {
    callApiRpc.mockResolvedValue([inventoryItem({ entitlement_active: true })]);

    await expect(listTeacherAccessRequests()).rejects.toMatchObject({
      code: "data_invalid_response",
    });
  });

  it("calls every administrator mutation with server revisions", async () => {
    callApiRpc
      .mockResolvedValueOnce([
        {
          request_id: "11111111-1111-4111-8111-111111111111",
          applicant_user_id: "22222222-2222-4222-8222-222222222222",
          request_status: "approved",
          request_revision: 2,
          entitlement_revision: 1,
          entitlement_max_workspaces: 2,
          decided_at: timestamp,
        },
      ])
      .mockResolvedValueOnce([
        {
          updated_user_id: "22222222-2222-4222-8222-222222222222",
          entitlement_revision: 2,
          entitlement_max_workspaces: 3,
          request_revision: 3,
          current_privileged_workspace_count: 1,
          updated_at: timestamp,
        },
      ])
      .mockResolvedValueOnce([
        {
          disabled_user_id: "22222222-2222-4222-8222-222222222222",
          entitlement_revision: 3,
          request_revision: 4,
          transferred_workspace_count: 1,
          removed_privileged_membership_count: 1,
          disabled_at: timestamp,
        },
      ]);

    await decideTeacherAccess({
      requestId: "11111111-1111-4111-8111-111111111111",
      decision: "approved",
      expectedRevision: 1,
      workspaceLimit: 2,
    });
    await updateTeacherWorkspaceLimit({
      userId: "22222222-2222-4222-8222-222222222222",
      expectedEntitlementRevision: 1,
      workspaceLimit: 3,
    });
    await disableTeacherAccess({
      userId: "22222222-2222-4222-8222-222222222222",
      expectedEntitlementRevision: 2,
    });

    expect(callApiRpc).toHaveBeenNthCalledWith(
      1,
      "decide_teacher_access",
      expect.objectContaining({
        expected_revision: 1,
        approved_workspace_limit: 2,
      }),
      expect.any(String),
    );
    expect(callApiRpc).toHaveBeenNthCalledWith(
      2,
      "update_teacher_workspace_limit",
      expect.objectContaining({ expected_entitlement_revision: 1 }),
      expect.any(String),
    );
    expect(callApiRpc).toHaveBeenNthCalledWith(
      3,
      "disable_teacher_access",
      expect.objectContaining({ expected_entitlement_revision: 2 }),
      expect.any(String),
    );
  });

  it("parses aggregate health without accepting identity fields", async () => {
    callApiRpc.mockResolvedValue([
      {
        pending_request_count: 2,
        approved_request_count: 3,
        rejected_request_count: 1,
        disabled_request_count: 1,
        active_entitlement_count: 3,
        inactive_or_expired_entitlement_count: 1,
        privileged_membership_count: 4,
        owned_workspace_count: 4,
        owned_workspace_without_active_access_count: 0,
        privileged_membership_without_active_access_count: 0,
        generated_at: timestamp,
      },
    ]);

    await expect(getTeacherOnboardingHealth()).resolves.toMatchObject({
      pending_request_count: 2,
      active_entitlement_count: 3,
    });
  });
});
