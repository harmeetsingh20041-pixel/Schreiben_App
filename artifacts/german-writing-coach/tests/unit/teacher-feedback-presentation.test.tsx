import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeedbackDraft: vi.fn(),
  prepareWritingFeedback: vi.fn(),
  releaseFeedback: vi.fn(),
  invalidateQueries: vi.fn(),
  refetch: vi.fn(),
  toast: vi.fn(),
  liveResult: null as unknown,
}));

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useParams: () => ({ id: "submission-1" }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    activeWorkspaceId: "workspace-1",
    authMode: "supabase",
    user: { id: "teacher-1" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/hooks/use-live-submission", () => ({
  useLiveTeacherSubmission: () => mocks.liveResult,
}));

vi.mock("@/services/submissionService", () => ({
  prepareWritingFeedback: mocks.prepareWritingFeedback,
}));

vi.mock("@/services/feedbackReviewService", () => ({
  getFeedbackDraft: mocks.getFeedbackDraft,
  releaseFeedback: mocks.releaseFeedback,
}));

vi.mock("@/components/teacher-feedback-draft-editor", () => ({
  TeacherFeedbackDraftEditor: () => (
    <div data-testid="editable-private-feedback">Editable private feedback</div>
  ),
}));

vi.mock("@/components/real-feedback-review", () => ({
  RealFeedbackReview: () => (
    <div data-testid="read-only-feedback">Read-only feedback</div>
  ),
}));

import TeacherSubmissionDetail, {
  canReleaseOverdueScheduledFeedback,
  SCHEDULED_RELEASE_GRACE_MS,
} from "@/pages/teacher/submission";

const timestamp = "2026-07-11T12:00:00.000Z";

function submission(overrides: Record<string, unknown> = {}) {
  return {
    id: "submission-1",
    workspace_id: "workspace-1",
    student_id: "student-1",
    batch_id: "batch-1",
    question_id: null,
    global_question_id: null,
    question_source: "free_text",
    mode: "free_text",
    original_text: "Ich gehe Schule.",
    corrected_text: null,
    overall_summary: null,
    level_detected: null,
    status: "checked",
    evaluation_status: "ready",
    release_status: "held",
    release_at: null,
    evaluation_version: 1,
    feedback_mode: "teacher_review_only",
    feedback_scheduled_at: null,
    feedback_started_at: timestamp,
    feedback_completed_at: timestamp,
    feedback_error: null,
    created_at: timestamp,
    updated_at: timestamp,
    checked_at: null,
    question_title: "Free Writing",
    question_prompt: null,
    question_level: "A2",
    question_topic: null,
    question_source_label: "Free writing",
    batch_name: "A2 Class",
    batch_level: "A2",
    student_name: "Learner",
    student_email: "learner@example.test",
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: "draft-1",
    submission_id: "submission-1",
    version: 1,
    revision: 1,
    state: "draft",
    content: {
      overall_summary: "Use the missing preposition.",
      level_detected: "A2",
      corrected_text: "Ich gehe zur Schule.",
      lines: [
        {
          line_number: 1,
          source_start: 0,
          source_end: 16,
          original_line: "Ich gehe Schule.",
          corrected_line: "Ich gehe zur Schule.",
          status: "minor_issue",
          changed_parts: [
            {
              from: "",
              to: "zur ",
              reason: "A preposition is required.",
              grammar_topics: ["prepositions"],
              severity: "minor",
              source_start: 9,
              source_end: 9,
              corrected_start: 9,
              corrected_end: 13,
            },
          ],
          short_explanation: "Use zur before Schule.",
          detailed_explanation: "",
          grammar_topic: "prepositions",
        },
      ],
      grammar_topics: [
        {
          topic: "prepositions",
          count: 1,
          severity: "minor",
          simple_explanation: "Use a preposition for this destination.",
        },
      ],
    },
    provider_model: "fixture",
    created_at: timestamp,
    updated_at: timestamp,
    approved_at: null,
    released_at: null,
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TeacherSubmissionDetail />
    </QueryClientProvider>,
  );
}

describe("teacher feedback presentation", () => {
  beforeEach(() => {
    mocks.refetch.mockResolvedValue(undefined);
    mocks.invalidateQueries.mockResolvedValue(undefined);
    mocks.releaseFeedback.mockResolvedValue({
      submission_id: "submission-1",
      feedback_version_id: "draft-1",
      feedback_version: 1,
      feedback_revision: 2,
      state: "released",
      release_status: "released",
      released_at: timestamp,
    });
    mocks.getFeedbackDraft.mockResolvedValue({
      draft: draft(),
      topic_options: [{ slug: "prepositions", name: "Prepositions" }],
    });
  });

  it("prioritizes an editable private draft over a truthy unreleased feedback envelope", async () => {
    mocks.liveResult = {
      data: {
        submission: submission(),
        feedback: { lines: [], grammar_topics: [] },
      },
      isLoading: false,
      error: null,
      refetch: mocks.refetch,
    };

    renderPage();

    expect(
      await screen.findByTestId("editable-private-feedback"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("read-only-feedback")).not.toBeInTheDocument();
  });

  it("shows normal scheduled feedback as a read-only preview without release controls", async () => {
    mocks.liveResult = {
      data: {
        submission: submission({
          feedback_mode: "automatic_delayed",
          release_status: "scheduled",
          release_at: "2099-07-11T15:00:00.000Z",
        }),
        feedback: { lines: [], grammar_topics: [] },
      },
      isLoading: false,
      error: null,
      refetch: mocks.refetch,
    };

    renderPage();

    expect(
      await screen.findByText("Scheduled feedback preview"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/read-only and will be released/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("read-only-feedback")).toBeInTheDocument();
    expect(
      screen.queryByTestId("editable-private-feedback"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve and release/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /release overdue feedback/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps a just-due scheduled result automatic for the full recovery window", () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    const scheduledDraft = draft() as Parameters<
      typeof canReleaseOverdueScheduledFeedback
    >[1];
    const scheduledSubmission = (releaseAt: number) =>
      submission({
        feedback_mode: "automatic_delayed",
        release_status: "scheduled",
        release_at: new Date(releaseAt).toISOString(),
      }) as Parameters<typeof canReleaseOverdueScheduledFeedback>[0];

    expect(
      canReleaseOverdueScheduledFeedback(
        scheduledSubmission(now - 30_000),
        scheduledDraft,
        now,
      ),
    ).toBe(false);
    expect(
      canReleaseOverdueScheduledFeedback(
        scheduledSubmission(now - SCHEDULED_RELEASE_GRACE_MS),
        scheduledDraft,
        now,
      ),
    ).toBe(true);
  });

  it("offers an idempotent release rescue only after scheduled feedback is overdue", async () => {
    mocks.liveResult = {
      data: {
        submission: submission({
          feedback_mode: "automatic_delayed",
          release_status: "scheduled",
          release_at: "2020-01-01T00:00:00.000Z",
        }),
        feedback: { lines: [], grammar_topics: [] },
      },
      isLoading: false,
      error: null,
      refetch: mocks.refetch,
    };

    renderPage();

    expect(
      await screen.findByText(/automatic release is overdue/i),
    ).toBeInTheDocument();
    const releaseButton = screen.getByRole("button", {
      name: /release overdue feedback/i,
    });
    fireEvent.click(releaseButton);

    await waitFor(() => {
      expect(mocks.releaseFeedback).toHaveBeenCalledWith(
        "submission-1",
        "draft-1",
      );
    });
    expect(mocks.refetch).toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Feedback released",
      }),
    );
  });

  it("keeps uncertain delayed feedback editable after the pipeline holds it", async () => {
    mocks.liveResult = {
      data: {
        submission: submission({
          status: "needs_review",
          feedback_mode: "automatic_delayed",
          evaluation_status: "needs_review",
          release_status: "held",
        }),
        feedback: { lines: [], grammar_topics: [] },
      },
      isLoading: false,
      error: null,
      refetch: mocks.refetch,
    };
    mocks.getFeedbackDraft.mockResolvedValue({
      draft: draft({ state: "needs_review" }),
      topic_options: [{ slug: "prepositions", name: "Prepositions" }],
    });

    renderPage();

    expect(
      await screen.findByTestId("editable-private-feedback"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("read-only-feedback")).not.toBeInTheDocument();
  });
});
