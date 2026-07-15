import axe from "axe-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    activeMembershipId: null as string | null,
    loading: false,
    needsWorkspace: false,
    refreshAccess: vi.fn(),
    role: "student" as "student" | "teacher",
    selectActiveMembership: vi.fn(),
    teacherEntitled: false,
    user: { id: "student-1" },
  },
  decide: vi.fn(),
  decideWritingLimit: vi.fn(),
  disable: vi.fn(),
  getHealth: vi.fn(),
  getMfaState: vi.fn(),
  getMy: vi.fn(),
  getStart: vi.fn(),
  list: vi.fn(),
  listWritingLimits: vi.fn(),
  request: vi.fn(),
  updateLimit: vi.fn(),
  verifyTotp: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => mocks.auth }));

vi.mock("@/services/authService", () => ({
  getMfaState: mocks.getMfaState,
  verifyTotpFactor: mocks.verifyTotp,
}));

vi.mock("@/services/teacherAccessService", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/teacherAccessService")>();
  return {
    ...actual,
    decideTeacherAccess: mocks.decide,
    disableTeacherAccess: mocks.disable,
    getMyTeacherAccessRequest: mocks.getMy,
    getMyTeacherStart: mocks.getStart,
    getTeacherOnboardingHealth: mocks.getHealth,
    listTeacherAccessRequests: mocks.list,
    requestTeacherAccess: mocks.request,
    updateTeacherWorkspaceLimit: mocks.updateLimit,
  };
});

vi.mock("@/services/batchWritingLimitService", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/services/batchWritingLimitService")
    >();
  return {
    ...actual,
    decideBatchWritingLimit: mocks.decideWritingLimit,
    listBatchWritingLimitRequests: mocks.listWritingLimits,
  };
});

import TeacherAccessPage from "@/pages/teacher-access";
import AdminTeacherAccessPage from "@/pages/admin/teacher-access";
import { PublicAppError } from "@/lib/appError";

const timestamp = "2026-07-12T12:00:00.000Z";

function renderWithQuery(component: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <main>{component}</main>
    </QueryClientProvider>,
  );
}

describe("teacher access UI", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/teacher-access");
    mocks.auth.loading = false;
    mocks.auth.activeMembershipId = null;
    mocks.auth.needsWorkspace = false;
    mocks.auth.refreshAccess.mockReset().mockResolvedValue(undefined);
    mocks.auth.role = "student";
    mocks.auth.selectActiveMembership.mockReset().mockResolvedValue(undefined);
    mocks.auth.teacherEntitled = false;
    mocks.decide.mockReset();
    mocks.decideWritingLimit.mockReset();
    mocks.disable.mockReset();
    mocks.getHealth.mockReset();
    mocks.getMfaState.mockReset();
    mocks.getMy.mockReset();
    mocks.getStart.mockReset();
    mocks.list.mockReset();
    mocks.listWritingLimits.mockReset().mockResolvedValue({
      schema_version: 1,
      items: [],
      total_count: 0,
      returned_count: 0,
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });
    mocks.request.mockReset();
    mocks.updateLimit.mockReset();
    mocks.verifyTotp.mockReset().mockResolvedValue(undefined);
  });

  it("lets a verified standard account request access and see pending state", async () => {
    const user = userEvent.setup();
    mocks.getMy.mockResolvedValue(null);
    mocks.request.mockResolvedValue({
      request_id: "11111111-1111-4111-8111-111111111111",
      request_status: "pending",
      request_revision: 1,
      requested_at: timestamp,
      decided_at: null,
      approved_max_workspaces: null,
      entitlement_active: false,
      entitlement_revision: null,
      entitlement_max_workspaces: null,
      updated_at: timestamp,
    });

    renderWithQuery(<TeacherAccessPage />);

    await user.click(
      await screen.findByRole("button", { name: "Request teacher access" }),
    );

    expect(mocks.request).toHaveBeenCalledWith(0);
    expect(await screen.findByText("Under review")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This page checks automatically for an administrator decision.",
      ),
    ).toBeInTheDocument();
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("sends an approved first-time teacher directly to first-class creation", async () => {
    const user = userEvent.setup();
    mocks.auth.role = "teacher";
    mocks.auth.teacherEntitled = true;
    mocks.getMy.mockResolvedValue({
      request_id: "11111111-1111-4111-8111-111111111111",
      request_status: "approved",
      request_revision: 2,
      requested_at: timestamp,
      decided_at: timestamp,
      approved_max_workspaces: 1,
      entitlement_active: true,
      entitlement_revision: 1,
      entitlement_max_workspaces: 1,
      updated_at: timestamp,
    });
    mocks.getStart.mockResolvedValue({
      workspace_id: "33333333-3333-4333-8333-333333333333",
      membership_id: "44444444-4444-4444-8444-444444444444",
      needs_first_class: true,
    });

    renderWithQuery(<TeacherAccessPage />);

    const link = await screen.findByRole("link", {
      name: "Create your first class",
    });
    expect(link).toHaveAttribute("href", "/teacher/batches?create=first-class");
    expect(screen.queryByText(/workspace/i)).not.toBeInTheDocument();
    await user.click(link);
    expect(mocks.auth.selectActiveMembership).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
    );
    await waitFor(() =>
      expect(window.location.pathname).toBe("/teacher/batches"),
    );
  });

  it("gives an admin the minimal approve flow with an explicit quota", async () => {
    const user = userEvent.setup();
    mocks.getHealth.mockResolvedValue({
      pending_request_count: 1,
      approved_request_count: 0,
      rejected_request_count: 0,
      disabled_request_count: 0,
      active_entitlement_count: 0,
      inactive_or_expired_entitlement_count: 0,
      privileged_membership_count: 0,
      owned_workspace_count: 0,
      owned_workspace_without_active_access_count: 0,
      privileged_membership_without_active_access_count: 0,
      generated_at: timestamp,
    });
    mocks.list.mockResolvedValue({
      items: [
        {
          request_id: "11111111-1111-4111-8111-111111111111",
          page_cursor_id: "11111111-1111-4111-8111-111111111111",
          applicant_user_id: "22222222-2222-4222-8222-222222222222",
          applicant_name: "Pilot Teacher",
          applicant_email: "teacher@example.test",
          request_status: "pending",
          request_revision: 4,
          requested_at: timestamp,
          decided_at: null,
          decided_by: null,
          approved_max_workspaces: null,
          entitlement_active: false,
          entitlement_revision: null,
          entitlement_max_workspaces: null,
          privileged_workspace_count: 0,
          updated_at: timestamp,
        },
      ],
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });
    mocks.decide
      .mockRejectedValueOnce(
        new PublicAppError(
          "data_fresh_reauthentication_required",
          "Fresh authentication required.",
        ),
      )
      .mockResolvedValue({
        request_id: "11111111-1111-4111-8111-111111111111",
        applicant_user_id: "22222222-2222-4222-8222-222222222222",
        request_status: "approved",
        request_revision: 5,
        entitlement_revision: 1,
        entitlement_max_workspaces: 1,
        decided_at: timestamp,
      });
    mocks.getMfaState.mockResolvedValue({
      currentLevel: "aal2",
      nextLevel: "aal2",
      totpFactors: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          friendlyName: "Primary authenticator",
          status: "verified",
          createdAt: timestamp,
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          friendlyName: "Backup authenticator",
          status: "verified",
          createdAt: timestamp,
        },
      ],
      verifiedTotpFactors: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          friendlyName: "Primary authenticator",
          status: "verified",
          createdAt: timestamp,
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          friendlyName: "Backup authenticator",
          status: "verified",
          createdAt: timestamp,
        },
      ],
    });

    renderWithQuery(<AdminTeacherAccessPage />);

    expect(await screen.findByText("Pilot Teacher")).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace limit")).toHaveValue(1);
    await user.click(screen.getByRole("button", { name: "Approve teacher" }));

    expect(
      await screen.findByRole("heading", {
        name: "Confirm administrator action",
      }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Six-digit code"), "123456");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mocks.decide).toHaveBeenCalledTimes(2);
      expect(mocks.decide).toHaveBeenLastCalledWith({
        requestId: "11111111-1111-4111-8111-111111111111",
        decision: "approved",
        expectedRevision: 4,
        workspaceLimit: 1,
      });
    });
    expect(mocks.verifyTotp).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "123456",
    );
    expect(mocks.auth.refreshAccess).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Teacher access" }),
    ).toBeInTheDocument();
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("shows current and requested class limits and reauthenticates an approval", async () => {
    const user = userEvent.setup();
    mocks.getHealth.mockResolvedValue({
      pending_request_count: 0,
      approved_request_count: 1,
      rejected_request_count: 0,
      disabled_request_count: 0,
      active_entitlement_count: 1,
      inactive_or_expired_entitlement_count: 0,
      privileged_membership_count: 1,
      owned_workspace_count: 1,
      owned_workspace_without_active_access_count: 0,
      privileged_membership_without_active_access_count: 0,
      generated_at: timestamp,
    });
    mocks.list.mockResolvedValue({
      items: [],
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });
    mocks.listWritingLimits.mockResolvedValue({
      schema_version: 1,
      items: [
        {
          request_id: "55555555-5555-4555-8555-555555555555",
          workspace_id: "66666666-6666-4666-8666-666666666666",
          workspace_name: "Nursing School",
          batch_id: "77777777-7777-4777-8777-777777777777",
          batch_name: "A2 Evening",
          batch_active: true,
          requested_by: "22222222-2222-4222-8222-222222222222",
          requester_name: "Pilot Teacher",
          requester_email: "teacher@example.test",
          current_writing_daily_limit: 3,
          requested_writing_daily_limit: 7,
          request_status: "pending",
          request_revision: 4,
          requested_at: timestamp,
          decided_at: null,
          decided_by: null,
          updated_at: timestamp,
        },
      ],
      total_count: 1,
      returned_count: 1,
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });
    mocks.decideWritingLimit
      .mockRejectedValueOnce(
        new PublicAppError(
          "data_fresh_reauthentication_required",
          "Fresh authentication required.",
        ),
      )
      .mockResolvedValue({
        request_id: "55555555-5555-4555-8555-555555555555",
        workspace_id: "66666666-6666-4666-8666-666666666666",
        batch_id: "77777777-7777-4777-8777-777777777777",
        request_status: "approved",
        request_revision: 5,
        previous_writing_daily_limit: 3,
        current_writing_daily_limit: 7,
        requested_writing_daily_limit: 7,
        decided_at: timestamp,
        decided_by: "88888888-8888-4888-8888-888888888888",
      });
    mocks.getMfaState.mockResolvedValue({
      currentLevel: "aal2",
      nextLevel: "aal2",
      totpFactors: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          friendlyName: "Primary authenticator",
          status: "verified",
          createdAt: timestamp,
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          friendlyName: "Backup authenticator",
          status: "verified",
          createdAt: timestamp,
        },
      ],
      verifiedTotpFactors: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          friendlyName: "Primary authenticator",
          status: "verified",
          createdAt: timestamp,
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          friendlyName: "Backup authenticator",
          status: "verified",
          createdAt: timestamp,
        },
      ],
    });

    renderWithQuery(<AdminTeacherAccessPage />);

    const card = await screen.findByTestId("batch-writing-limit-request");
    expect(within(card).getByText("A2 Evening")).toBeInTheDocument();
    expect(within(card).getByText("3")).toBeInTheDocument();
    expect(within(card).getByText("7")).toBeInTheDocument();
    await user.click(
      within(card).getByRole("button", {
        name: "Approve writing-limit request for A2 Evening",
      }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Confirm administrator action",
      }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Six-digit code"), "123456");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mocks.decideWritingLimit).toHaveBeenCalledTimes(2);
      expect(mocks.decideWritingLimit).toHaveBeenLastCalledWith({
        requestId: "55555555-5555-4555-8555-555555555555",
        decision: "approved",
        expectedRevision: 4,
      });
    });
    expect(mocks.verifyTotp).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "123456",
    );
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("rejects a class limit request with its current revision", async () => {
    const user = userEvent.setup();
    mocks.getHealth.mockResolvedValue({
      pending_request_count: 0,
      approved_request_count: 1,
      rejected_request_count: 0,
      disabled_request_count: 0,
      active_entitlement_count: 1,
      inactive_or_expired_entitlement_count: 0,
      privileged_membership_count: 1,
      owned_workspace_count: 1,
      owned_workspace_without_active_access_count: 0,
      privileged_membership_without_active_access_count: 0,
      generated_at: timestamp,
    });
    mocks.list.mockResolvedValue({
      items: [],
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });
    mocks.listWritingLimits.mockResolvedValue({
      schema_version: 1,
      items: [
        {
          request_id: "55555555-5555-4555-8555-555555555555",
          workspace_id: "66666666-6666-4666-8666-666666666666",
          workspace_name: "Nursing School",
          batch_id: "77777777-7777-4777-8777-777777777777",
          batch_name: "A2 Evening",
          batch_active: false,
          requested_by: "22222222-2222-4222-8222-222222222222",
          requester_name: "Pilot Teacher",
          requester_email: "teacher@example.test",
          current_writing_daily_limit: 3,
          requested_writing_daily_limit: 7,
          request_status: "pending",
          request_revision: 4,
          requested_at: timestamp,
          decided_at: null,
          decided_by: null,
          updated_at: timestamp,
        },
      ],
      total_count: 1,
      returned_count: 1,
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });
    mocks.decideWritingLimit.mockResolvedValue({
      request_id: "55555555-5555-4555-8555-555555555555",
      workspace_id: "66666666-6666-4666-8666-666666666666",
      batch_id: "77777777-7777-4777-8777-777777777777",
      request_status: "rejected",
      request_revision: 5,
      previous_writing_daily_limit: 3,
      current_writing_daily_limit: 3,
      requested_writing_daily_limit: 7,
      decided_at: timestamp,
      decided_by: "88888888-8888-4888-8888-888888888888",
    });

    renderWithQuery(<AdminTeacherAccessPage />);
    const card = await screen.findByTestId("batch-writing-limit-request");
    expect(
      within(card).getByRole("button", {
        name: "Approve writing-limit request for A2 Evening",
      }),
    ).toBeDisabled();
    await user.click(
      within(card).getByRole("button", {
        name: "Reject writing-limit request for A2 Evening",
      }),
    );

    await waitFor(() =>
      expect(mocks.decideWritingLimit).toHaveBeenCalledWith({
        requestId: "55555555-5555-4555-8555-555555555555",
        decision: "rejected",
        expectedRevision: 4,
      }),
    );
  });
});
