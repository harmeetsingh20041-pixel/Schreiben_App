import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const getOnboardingProgress = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    activeWorkspaceId: "workspace-1",
    authMode: "supabase",
    user: { id: "member-1" },
  }),
}));

vi.mock("@/services/onboardingService", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/onboardingService")>();
  return { ...actual, getOnboardingProgress };
});

import { OnboardingChecklist } from "@/components/onboarding-checklist";
import type { OnboardingRole } from "@/services/onboardingService";

const firstTitle: Record<OnboardingRole, string> = {
  teacher: "Create and configure a class",
  student: "Choose the right class",
};

const progressSteps = {
  teacher: [
    "create_class",
    "choose_feedback_mode",
    "share_join_code",
    "review_first_submission",
  ],
  student: [
    "join_class",
    "submit_writing",
    "review_feedback",
    "start_practice",
  ],
} as const;

function renderChecklist(role: OnboardingRole) {
  getOnboardingProgress.mockResolvedValue({
    role,
    revision: 1,
    steps: [...progressSteps[role]],
    completed_steps: [],
    completed_count: 0,
    total_count: 4,
    all_complete: false,
    next_step: progressSteps[role][0],
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OnboardingChecklist role={role} />
    </QueryClientProvider>,
  );
}

for (const role of ["teacher", "student"] as const) {
  describe(`${role} contextual tour focus restoration`, () => {
    it("restores the replay opener after Escape", async () => {
      const user = userEvent.setup();
      renderChecklist(role);
      const opener = await screen.findByRole("button", { name: "Replay tour" });

      await user.click(opener);
      expect(
        screen.getByRole("dialog", { name: firstTitle[role] }),
      ).toBeVisible();
      await user.keyboard("{Escape}");

      await waitFor(() => expect(opener).toHaveFocus());
    });

    it("restores the replay opener after the Close control", async () => {
      const user = userEvent.setup();
      renderChecklist(role);
      const opener = await screen.findByRole("button", { name: "Replay tour" });

      await user.click(opener);
      await user.click(screen.getByRole("button", { name: "Close" }));

      await waitFor(() => expect(opener).toHaveFocus());
    });

    it("restores the replay opener after Finish without changing progress", async () => {
      const user = userEvent.setup();
      renderChecklist(role);
      const opener = await screen.findByRole("button", { name: "Replay tour" });

      await user.click(opener);
      for (let index = 0; index < 3; index += 1) {
        await user.click(screen.getByRole("button", { name: "Next" }));
      }
      await user.click(screen.getByRole("button", { name: "Finish" }));

      await waitFor(() => expect(opener).toHaveFocus());
      expect(getOnboardingProgress).toHaveBeenCalledWith("workspace-1", role);
      expect(getOnboardingProgress).toHaveBeenCalledTimes(1);
    });
  });
}
