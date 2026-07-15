import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicAppError } from "@/lib/appError";

const auth = vi.hoisted(() => ({
  canCreateTeacherWorkspace: true,
  createWorkspace: vi.fn(),
  loading: false,
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => auth }));

import TeacherOnboarding from "@/pages/teacher/onboarding";

describe("teacher setup", () => {
  beforeEach(() => {
    auth.canCreateTeacherWorkspace = true;
    auth.createWorkspace.mockReset().mockResolvedValue(undefined);
    auth.loading = false;
  });

  it("caps the teaching-area name at 120 Unicode code points and shows a counter", async () => {
    const user = userEvent.setup();
    render(<TeacherOnboarding />);

    const input = screen.getByLabelText("Teaching area name");
    await user.clear(input);
    await user.type(input, "😀".repeat(121));

    expect(input).toHaveValue("😀".repeat(120));
    expect(screen.getByText("120/120")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Continue to class setup" }),
    );
    expect(auth.createWorkspace).toHaveBeenCalledWith("😀".repeat(120));
  });

  it("blocks an empty name and offers the existing MFA reauthentication flow", async () => {
    const user = userEvent.setup();
    auth.createWorkspace.mockRejectedValue(
      new PublicAppError(
        "data_fresh_reauthentication_required",
        "Enter a fresh authenticator code.",
      ),
    );
    render(<TeacherOnboarding />);

    const input = screen.getByLabelText("Teaching area name");
    await user.clear(input);
    expect(
      screen.getByRole("button", { name: "Continue to class setup" }),
    ).toBeDisabled();

    await user.type(input, "Nursing German");
    await user.click(
      screen.getByRole("button", { name: "Continue to class setup" }),
    );

    expect(
      await screen.findByRole("link", { name: "Re-authenticate with MFA" }),
    ).toHaveAttribute(
      "href",
      "/auth/mfa?mode=reauth&returnTo=%2Fteacher%2Fonboarding",
    );
  });
});
