import axe from "axe-core";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const getOnboardingProgressMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    activeWorkspaceId: "workspace-1",
    authMode: "supabase",
    user: { id: "teacher-1" },
  }),
}));
vi.mock("@/services/onboardingService", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/onboardingService")>();
  return { ...actual, getOnboardingProgress: getOnboardingProgressMock };
});

import { OnboardingChecklist } from "@/components/onboarding-checklist";

describe("persistent onboarding checklist", () => {
  it("shows durable progress and a replayable keyboard tour without axe violations", async () => {
    getOnboardingProgressMock.mockResolvedValue({
      role: "teacher",
      revision: 1,
      steps: [
        "create_class",
        "choose_feedback_mode",
        "share_join_code",
        "review_first_submission",
      ],
      completed_steps: ["create_class", "choose_feedback_mode"],
      completed_count: 2,
      total_count: 4,
      all_complete: false,
      next_step: "share_join_code",
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient}>
        <OnboardingChecklist role="teacher" />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("2 of 4 steps complete"),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(
      screen.getByText("Create your first class").closest("p"),
    ).toHaveTextContent("Complete: Create your first class");
    expect(screen.getByText("Check the first result")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View results" })).toHaveAttribute(
      "href",
      "/teacher/submissions",
    );
    expect(screen.getByRole("link", { name: "View code" })).toHaveAttribute(
      "href",
      "/teacher/batches",
    );

    await user.click(screen.getByRole("button", { name: "Replay tour" }));
    expect(
      screen.getByRole("dialog", { name: "Create and configure a class" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("dialog", { name: "Approve student access" }),
    ).toBeInTheDocument();

    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("collapses a completed checklist by default and exposes an accessible toggle", async () => {
    getOnboardingProgressMock.mockResolvedValue({
      role: "teacher",
      revision: 1,
      steps: [
        "create_class",
        "choose_feedback_mode",
        "share_join_code",
        "review_first_submission",
      ],
      completed_steps: [
        "create_class",
        "choose_feedback_mode",
        "share_join_code",
        "review_first_submission",
      ],
      completed_count: 4,
      total_count: 4,
      all_complete: true,
      next_step: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient}>
        <OnboardingChecklist role="teacher" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Launch checklist complete")).toBeVisible();
    const toggle = screen.getByRole("button", {
      name: "Show completed checklist",
    });
    const details = document.getElementById("teacher-launch-checklist-details");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute(
      "aria-controls",
      "teacher-launch-checklist-details",
    );
    expect(details).toHaveAttribute("hidden");

    await user.click(toggle);
    expect(
      screen.getByRole("button", { name: "Hide completed checklist" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(details).not.toHaveAttribute("hidden");
    expect(screen.getByText("Create your first class")).toBeVisible();
  });
});
