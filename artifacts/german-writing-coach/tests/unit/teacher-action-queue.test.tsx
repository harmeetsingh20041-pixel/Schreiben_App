import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";

const mocks = vi.hoisted(() => ({
  listFeedback: vi.fn(),
  releaseFeedback: vi.fn(),
  listPractice: vi.fn(),
  getQuarantined: vi.fn(),
  decide: vi.fn(),
  retryEvaluation: vi.fn(),
  prepareWorksheet: vi.fn(),
  toast: vi.fn(),
  navigate: vi.fn(),
  workspaceId: "22222222-2222-4222-8222-222222222222",
}));

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useParams: () => ({ id: "11111111-1111-4111-8111-111111111111" }),
  useLocation: () => ["/teacher/practice-quality/fixture", mocks.navigate],
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    activeWorkspaceId: mocks.workspaceId,
    authMode: "supabase",
    user: { id: "33333333-3333-4333-8333-333333333333" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/services/feedbackReviewService", () => ({
  listFeedbackReviewQueuePage: mocks.listFeedback,
  releaseFeedback: mocks.releaseFeedback,
}));

vi.mock("@/services/practiceReviewQueueService", () => ({
  listPracticeReviewQueuePage: mocks.listPractice,
  getQuarantinedWorksheet: mocks.getQuarantined,
  decideQuarantinedWorksheet: mocks.decide,
  retryPracticeAttemptEvaluation: mocks.retryEvaluation,
}));

vi.mock("@/services/practiceWorksheetService", () => ({
  preparePracticeWorksheet: mocks.prepareWorksheet,
}));

import TeacherReviewQueue from "@/pages/teacher/review-queue";
import TeacherPracticeQualityReview from "@/pages/teacher/practice-quality";

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function expectNoAutomatedAccessibilityViolations() {
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations).toEqual([]);
}

describe("unified teacher action queue", () => {
  beforeEach(() => {
    mocks.listFeedback.mockReset();
    mocks.releaseFeedback.mockReset();
    mocks.listPractice.mockReset();
    mocks.getQuarantined.mockReset();
    mocks.decide.mockReset();
    mocks.retryEvaluation.mockReset();
    mocks.prepareWorksheet.mockReset();
    mocks.toast.mockReset();
    mocks.navigate.mockReset();
    mocks.workspaceId = "22222222-2222-4222-8222-222222222222";
    mocks.listFeedback.mockResolvedValue({
      schema_version: 1,
      items: [],
      total_count: 0,
      returned_count: 0,
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });
    mocks.listPractice.mockResolvedValue({
      schema_version: 1,
      items: [],
      total_count: 0,
      returned_count: 0,
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });
    mocks.releaseFeedback.mockResolvedValue({
      release_status: "released",
    });
  });

  it("shows writing, worksheet, failure, and support work in one accessible destination", async () => {
    render(
      <QueryClientProvider client={queryClient()}>
        <main>
          <TeacherReviewQueue />
        </main>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Writing feedback" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Worksheets and support" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Filter writing feedback queue"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Filter worksheet and support queue"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("No writing feedback is waiting."),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("No worksheet or support actions are waiting."),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Swipe sideways to reach the Action column."),
    ).toHaveLength(2);
    await expectNoAutomatedAccessibilityViolations();
  });

  it("lets a teacher rescue an overdue validated scheduled release in one click", async () => {
    mocks.listFeedback.mockResolvedValue({
      schema_version: 1,
      items: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          workspace_id: "22222222-2222-4222-8222-222222222222",
          student_id: "44444444-4444-4444-8444-444444444444",
          batch_id: "55555555-5555-4555-8555-555555555555",
          status: "checked",
          evaluation_status: "ready",
          release_status: "scheduled",
          release_at: "2026-07-10T11:59:00.000Z",
          feedback_mode: "automatic_delayed",
          review_reason: "overdue_scheduled",
          feedback_version_id: "66666666-6666-4666-8666-666666666666",
          feedback_version: 1,
          feedback_revision: 1,
          feedback_state: "draft",
          student_name: "Learner",
          student_email: "learner@example.test",
          batch_name: "A2 Class",
          question_title: "Free Writing",
          error_code: "scheduled_release_overdue",
          created_at: "2026-07-10T11:50:00.000Z",
          updated_at: "2026-07-10T11:59:00.000Z",
        },
      ],
      total_count: 1,
      returned_count: 1,
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient()}>
        <main>
          <TeacherReviewQueue />
        </main>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Scheduled release overdue"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Release now" }));

    expect(mocks.releaseFeedback).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999",
      "66666666-6666-4666-8666-666666666666",
    );
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Feedback released",
      }),
    );
  });

  it("clears the previous workspace queue before the next workspace resolves", async () => {
    const oldWorkspace = "22222222-2222-4222-8222-222222222222";
    const nextWorkspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const oldPage = {
      schema_version: 1,
      items: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          workspace_id: oldWorkspace,
          student_id: "44444444-4444-4444-8444-444444444444",
          batch_id: "55555555-5555-4555-8555-555555555555",
          status: "failed",
          evaluation_status: "failed",
          release_status: "held",
          release_at: null,
          feedback_mode: "immediate",
          review_reason: "failed",
          feedback_version_id: null,
          feedback_version: null,
          feedback_revision: null,
          feedback_state: null,
          student_name: "Previous Workspace Learner",
          student_email: null,
          batch_name: "Previous class",
          question_title: "Free Writing",
          error_code: "feedback_failed",
          created_at: "2026-07-10T11:50:00.000Z",
          updated_at: "2026-07-10T11:59:00.000Z",
        },
      ],
      total_count: 1,
      returned_count: 1,
      page_size: 25,
      has_more: false,
      next_cursor: null,
    };
    let resolveNextWorkspace: ((value: typeof oldPage) => void) | undefined;
    mocks.listFeedback.mockImplementation(
      ({ workspaceId }: { workspaceId: string }) => {
        if (workspaceId === oldWorkspace) return Promise.resolve(oldPage);
        return new Promise<typeof oldPage>((resolve) => {
          resolveNextWorkspace = resolve;
        });
      },
    );
    const client = queryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <main>
          <TeacherReviewQueue />
        </main>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Previous Workspace Learner"),
    ).toBeInTheDocument();
    mocks.workspaceId = nextWorkspace;
    view.rerender(
      <QueryClientProvider client={client}>
        <main>
          <TeacherReviewQueue />
        </main>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        screen.queryByText("Previous Workspace Learner"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Loading writing reviews...")).toBeInTheDocument();
    expect(mocks.listFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: nextWorkspace }),
    );

    resolveNextWorkspace?.({
      ...oldPage,
      items: [],
      total_count: 0,
      returned_count: 0,
    });
  });

  it("requires a reviewed note and confirmation before assigning quarantined content", async () => {
    mocks.getQuarantined.mockResolvedValue({
      assignment: {
        id: "11111111-1111-4111-8111-111111111111",
        workspace_id: "22222222-2222-4222-8222-222222222222",
        student_id: "44444444-4444-4444-8444-444444444444",
        student_name: "Learner",
        grammar_topic_id: "55555555-5555-4555-8555-555555555555",
        grammar_topic_name: "Prepositions",
        generation_status: "needs_review",
      },
      worksheet: {
        id: "66666666-6666-4666-8666-666666666666",
        title: "Preposition practice",
        description: "Focused practice",
        level: "A1",
        difficulty: "easy",
        mini_lesson: null,
        quality_status: "needs_review",
        quality_notes: "Independent validation rejected one ambiguity.",
        generator_model: "deepseek-v4-pro",
        generation_metadata: {
          validation: {
            rejection_reasons: ["Check whether another answer is valid."],
          },
        },
        created_at: "2026-07-10T12:00:00.000Z",
        questions: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            question_number: 1,
            question_type: "multiple_choice",
            evaluation_mode: "local_exact",
            prompt: "Which answer is correct?",
            options: ["A", "B", "C"],
            correct_answer: "A",
            accepted_answers: ["A"],
            rubric: null,
            explanation: "A is correct here.",
            answer_contract_version: 1,
          },
        ],
      },
    });
    mocks.decide.mockResolvedValue({
      action_id: "88888888-8888-4888-8888-888888888888",
      assignment_id: "11111111-1111-4111-8111-111111111111",
      practice_test_id: "66666666-6666-4666-8666-666666666666",
      decision: "approve",
      quality_status: "approved",
      generation_status: "ready",
    });
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient()}>
        <main>
          <TeacherPracticeQualityReview />
        </main>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Worksheet quality review" }),
    ).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: "Approve and assign" });
    expect(approve).toBeDisabled();
    await expectNoAutomatedAccessibilityViolations();

    await user.type(
      screen.getByLabelText("Review notes"),
      "I checked every option and accepted answer against the prompt.",
    );
    expect(approve).toBeEnabled();
    await user.click(approve);

    expect(
      screen.getByRole("alertdialog", {
        name: "Approve this exact worksheet?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/cannot be changed/i)).toBeInTheDocument();
    await expectNoAutomatedAccessibilityViolations();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(approve).toHaveFocus());

    const reject = screen.getByRole("button", {
      name: "Reject and keep private",
    });
    await user.click(reject);
    expect(
      screen.getByRole("alertdialog", { name: "Reject this worksheet?" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(reject).toHaveFocus());
  });
});
