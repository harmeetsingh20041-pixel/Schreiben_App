import axe from "axe-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    isPlatformAdmin: true,
    logout: vi.fn(),
    refreshAccess: vi.fn(),
    role: "student" as "student" | "teacher" | null,
  },
  cancel: vi.fn(),
  enroll: vi.fn(),
  getState: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/services/authService", () => ({
  cancelTotpEnrollment: mocks.cancel,
  enrollTotpFactor: mocks.enroll,
  getMfaState: mocks.getState,
  verifyTotpFactor: mocks.verify,
}));

import MfaPage from "@/pages/auth/mfa";

const primary = {
  id: "11111111-1111-4111-8111-111111111111",
  friendlyName: "Primary authenticator",
  status: "verified" as const,
  createdAt: "2026-07-13T10:00:00.000Z",
};
const backup = {
  id: "22222222-2222-4222-8222-222222222222",
  friendlyName: "Backup authenticator",
  status: "verified" as const,
  createdAt: "2026-07-13T10:01:00.000Z",
};

function state(currentLevel: "aal1" | "aal2", factors: Array<typeof primary>) {
  return {
    currentLevel,
    nextLevel: factors.length > 0 ? ("aal2" as const) : ("aal1" as const),
    totpFactors: factors,
    verifiedTotpFactors: factors.filter(
      (factor) => factor.status === "verified",
    ),
  };
}

describe("MFA page", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/auth/mfa");
    mocks.auth.isPlatformAdmin = true;
    mocks.auth.role = "student";
    mocks.auth.logout.mockReset().mockResolvedValue(undefined);
    mocks.auth.refreshAccess.mockReset().mockResolvedValue(undefined);
    mocks.cancel.mockReset().mockResolvedValue(undefined);
    mocks.enroll.mockReset();
    mocks.getState.mockReset();
    mocks.verify.mockReset().mockResolvedValue(undefined);
  });

  it("enrolls the first factor without persisting or injecting its secret", async () => {
    const user = userEvent.setup();
    mocks.getState.mockResolvedValue(state("aal1", []));
    mocks.enroll.mockResolvedValue({
      factorId: primary.id,
      qrCode: "data:image/svg+xml;utf8,encoded",
      secret: "PRIVATE-TOTP-SECRET",
      uri: "otpauth://totp/example",
    });

    render(<MfaPage />);
    await user.click(
      await screen.findByRole("button", { name: "Add authenticator" }),
    );

    expect(
      screen.getByRole("img", { name: "QR code for the new authenticator" }),
    ).toHaveAttribute("src", "data:image/svg+xml;utf8,encoded");
    expect(screen.getByText("PRIVATE-TOTP-SECRET")).toBeInTheDocument();
    expect(screen.getByLabelText("Six-digit code")).toHaveFocus();
    expect(document.body.innerHTML).not.toContain("otpauth://totp/example");

    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("challenges an existing factor before enrolling the backup at AAL1", async () => {
    mocks.getState.mockResolvedValue(state("aal1", [primary]));
    render(<MfaPage />);

    expect(
      await screen.findByRole("button", { name: "Verify authenticator" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add authenticator" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Six-digit code")).toHaveFocus();
  });

  it("asks an AAL2 account with one factor to enroll a separate backup", async () => {
    mocks.getState.mockResolvedValue(state("aal2", [primary]));
    render(<MfaPage />);

    expect(
      await screen.findByText("Add the backup authenticator"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add authenticator" }),
    ).toBeInTheDocument();
  });

  it("prioritizes cleanup of abandoned enrollment over a second action", async () => {
    mocks.getState.mockResolvedValue({
      ...state("aal1", [primary]),
      totpFactors: [
        primary,
        {
          ...backup,
          status: "unverified" as const,
        },
      ],
    });
    render(<MfaPage />);

    expect(
      await screen.findByText("Incomplete setup found"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Verify authenticator" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add authenticator" }),
    ).not.toBeInTheDocument();
  });

  it("requires a fresh challenge in reauth mode and accepts the backup factor", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/auth/mfa?mode=reauth&returnTo=%2Fadmin%2Fteacher-access",
    );
    mocks.getState.mockResolvedValue(state("aal2", [primary, backup]));
    render(<MfaPage />);

    const factor = await screen.findByLabelText("Authenticator");
    await user.selectOptions(factor, backup.id);
    await user.type(screen.getByLabelText("Six-digit code"), "123456");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(mocks.verify).toHaveBeenCalledWith(backup.id, "123456"),
    );
    expect(mocks.auth.refreshAccess).toHaveBeenCalledOnce();
  });

  it("returns a workspace-create reauthentication to the safe teaching setup route", async () => {
    const user = userEvent.setup();
    window.history.replaceState(
      {},
      "",
      "/auth/mfa?mode=reauth&returnTo=%2Fteacher%2Fonboarding",
    );
    mocks.getState.mockResolvedValue(state("aal2", [primary, backup]));
    render(<MfaPage />);

    await user.type(await screen.findByLabelText("Six-digit code"), "123456");
    await user.click(
      screen.getByRole("button", { name: "Verify authenticator" }),
    );

    await waitFor(() =>
      expect(window.location.pathname).toBe("/teacher/onboarding"),
    );
  });

  it("refreshes stale provider readiness before using the safe return target", async () => {
    const user = userEvent.setup();
    let finishRefresh: (() => void) | undefined;
    mocks.auth.refreshAccess.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    window.history.replaceState(
      {},
      "",
      "/auth/mfa?returnTo=%2F%2Fevil.example",
    );
    mocks.getState.mockResolvedValue(state("aal2", [primary, backup]));
    render(<MfaPage />);

    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(mocks.auth.refreshAccess).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe("/auth/mfa");

    finishRefresh?.();
    await waitFor(() =>
      expect(window.location.pathname).toBe("/admin/teacher-access"),
    );
  });
});
