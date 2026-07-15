import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listTeacherQuestionBankPage = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    activeWorkspaceId: "workspace-1",
    authMode: "supabase",
    user: { id: "teacher-1" },
  }),
}));

vi.mock("@/services/questionService", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/questionService")>();
  return {
    ...actual,
    createWorkspaceQuestion: vi.fn(),
    listTeacherQuestionBankPage,
    setQuestionActive: vi.fn(),
    updateWorkspaceQuestion: vi.fn(),
  };
});

import TeacherQuestions from "@/pages/teacher/questions";

function renderQuestions() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TeacherQuestions />
    </QueryClientProvider>,
  );
}

describe("teacher writing-task dialog focus restoration", () => {
  beforeEach(() => {
    listTeacherQuestionBankPage.mockReset().mockResolvedValue({
      schema_version: 1,
      items: [],
      available_topics: [],
      total_count: 0,
      returned_count: 0,
      page_size: 12,
      has_more: false,
      next_cursor: null,
    });
  });

  it("restores focus to the create control after Escape", async () => {
    const user = userEvent.setup();
    renderQuestions();
    const opener = screen.getByRole("button", {
      name: "Create Workspace Writing Task",
    });

    await user.click(opener);
    expect(
      screen.getByRole("dialog", { name: "Create New Writing Task" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("restores focus to the create control after Cancel", async () => {
    const user = userEvent.setup();
    renderQuestions();
    const opener = screen.getByRole("button", {
      name: "Create Workspace Writing Task",
    });

    await user.click(opener);
    const dialog = screen.getByRole("dialog", {
      name: "Create New Writing Task",
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(opener).toHaveFocus());
  });
});
