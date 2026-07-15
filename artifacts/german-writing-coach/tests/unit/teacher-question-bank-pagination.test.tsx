import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTeacherQuestionBankPage: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    activeWorkspaceId: "workspace-1",
    authMode: "supabase",
    user: { id: "teacher-1" },
  }),
}));

vi.mock("@/services/questionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/questionService")>();
  return {
    ...actual,
    createWorkspaceQuestion: vi.fn(),
    listTeacherQuestionBankPage: mocks.listTeacherQuestionBankPage,
    setQuestionActive: vi.fn(),
    updateWorkspaceQuestion: vi.fn(),
  };
});

import TeacherQuestions from "@/pages/teacher/questions";

function question(id: string, title: string, createdAt: string) {
  return {
    id,
    workspace_id: "workspace-1",
    source: "workspace" as const,
    batch_id: null,
    title,
    prompt: "Schreiben Sie eine E-Mail.",
    level: "A2" as const,
    topic: "Alltag",
    task_type: "email" as const,
    expected_word_min: 60,
    expected_word_max: 80,
    estimated_minutes: 20,
    is_active: true,
    created_by: "teacher-1",
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe("teacher Content pagination", () => {
  const nextCursor = {
    sort_rank: 0,
    created_at: "2026-07-10T01:00:00.000Z",
    id: "question-12",
  };

  beforeEach(() => {
    mocks.listTeacherQuestionBankPage.mockReset();
    mocks.listTeacherQuestionBankPage.mockImplementation(async (input: {
      cursor?: typeof nextCursor | null;
    }) => {
      return input.cursor == null
        ? {
          schema_version: 1 as const,
          items: Array.from({ length: 12 }, (_, index) => question(
            `question-${index + 1}`,
            index === 0 ? "First page" : `First page item ${index + 1}`,
            `2026-07-10T${String(12 - index).padStart(2, "0")}:00:00.000Z`,
          )),
          total_count: 13,
          returned_count: 12,
          page_size: 12,
          has_more: true,
          next_cursor: nextCursor,
          available_topics: ["Alltag"],
        }
        : {
          schema_version: 1 as const,
          items: [question("question-13", "Second page", "2026-07-09T12:00:00.000Z")],
          total_count: 13,
          returned_count: 1,
          page_size: 12,
          has_more: false,
          next_cursor: null,
          available_topics: ["Alltag"],
        };
    });
  });

  it("exposes keyboard-operable previous and next controls for server pages", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeacherQuestions />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("First page")).toBeInTheDocument();
    const pagination = screen.getByRole("navigation", { name: "Writing task pages" });
    const previous = screen.getByRole("button", { name: "Previous writing tasks page" });
    const next = screen.getByRole("button", { name: "Next writing tasks page" });
    expect(pagination).toContainElement(previous);
    expect(pagination).toContainElement(next);
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();

    next.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mocks.listTeacherQuestionBankPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: nextCursor, pageSize: 12 }),
      );
    });
    expect(await screen.findByText("Second page")).toBeInTheDocument();
    expect(screen.getByText(/Showing 13–13 of 13 writing tasks/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous writing tasks page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next writing tasks page" })).toBeDisabled();
  });

  it("bounds new teacher task text to the 4,000-character launch contract", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeacherQuestions />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("First page")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Create Workspace Writing Task" }),
    );

    const prompt = screen.getByRole("textbox", { name: "Task Text" });
    expect(prompt).toHaveAttribute("maxlength", "4000");
    expect(prompt).toHaveAttribute("aria-describedby", "question-prompt-count");
    expect(screen.getByText("0/4,000")).toBeInTheDocument();
  });
});
