import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callApiRpc: vi.fn(),
  toast: vi.fn(),
  onChanged: vi.fn(),
  onReleased: vi.fn(),
}));

vi.mock("@/services/apiFacade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/apiFacade")>()),
  callApiRpc: mocks.callApiRpc,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

import { TeacherFeedbackDraftEditor } from "@/components/teacher-feedback-draft-editor";
import type {
  FeedbackDraft,
  FeedbackDraftContent,
} from "@/services/feedbackReviewService";
import type { WritingSubmission } from "@/services/submissionService";

const timestamp = "2026-07-13T08:00:00.000Z";

function content(): FeedbackDraftContent {
  return {
    feedback_contract_version: 2,
    overall_summary: "Review this correction.",
    level_detected: "A2",
    corrected_text: "Ich gehe zur Schule.",
    ai_model: "fixture",
    grammar_topics: [],
    score_summary: {},
    lines: [
      {
        line_number: 1,
        source_start: 0,
        source_end: 16,
        original_line: "Ich gehe Schule.",
        corrected_line: "Ich gehe zur Schule.",
        status: "major_issue",
        changed_parts: [
          {
            from: "",
            to: "zur ",
            reason: "Initial reason.",
            grammar_topics: ["prepositions"],
            severity: "major",
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
  };
}

function draft(): FeedbackDraft {
  return {
    id: "draft-private-v2",
    submission_id: "submission-private-v2",
    version: 1,
    revision: 1,
    state: "draft",
    content: content(),
    provider_model: "fixture",
    created_at: timestamp,
    updated_at: timestamp,
    approved_at: null,
    released_at: null,
  };
}

const submission = {
  id: "submission-private-v2",
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
  status: "needs_review",
  evaluation_status: "needs_review",
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
} satisfies WritingSubmission;

describe("teacher private-draft mutation response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onChanged.mockResolvedValue(undefined);
    mocks.onReleased.mockResolvedValue(undefined);
    const privateContent = content();
    privateContent.lines[0].changed_parts[0] = {
      ...privateContent.lines[0].changed_parts[0],
      reason: "",
      grammar_topics: [],
      severity: null,
    };
    privateContent.lines[0].grammar_topic = "";
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      draft: {
        ...draft(),
        revision: 2,
        state: "needs_review",
        content: privateContent,
        updated_at: "2026-07-13T08:01:00.000Z",
      },
    });
  });

  it("keeps a parsed incomplete v2 response saved and release-blocked", async () => {
    const user = userEvent.setup();
    render(
      <TeacherFeedbackDraftEditor
        submission={submission}
        draft={draft()}
        topicOptions={[{ slug: "prepositions", name: "Prepositions" }]}
        onChanged={mocks.onChanged}
        onReleased={mocks.onReleased}
      />,
    );

    await user.clear(screen.getByLabelText("Reason for this exact correction"));
    await user.click(screen.getByRole("button", { name: "Save private draft" }));

    await waitFor(() => expect(mocks.callApiRpc).toHaveBeenCalled());
    expect(screen.getByLabelText("Reason for this exact correction")).toHaveValue("");
    expect(screen.getByText("Held for review")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one grammar topic for this correction.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approve and release" }),
    ).toBeDisabled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Draft saved and held",
    }));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: "Feedback was not saved",
    }));
  });
});
