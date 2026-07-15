import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateFeedbackDraft: vi.fn(),
  releaseFeedback: vi.fn(),
  toast: vi.fn(),
  onChanged: vi.fn(),
  onReleased: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/services/feedbackReviewService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/feedbackReviewService")>()),
  updateFeedbackDraft: mocks.updateFeedbackDraft,
  releaseFeedback: mocks.releaseFeedback,
}));

import { TeacherFeedbackDraftEditor } from "@/components/teacher-feedback-draft-editor";
import type {
  FeedbackDraft,
  FeedbackDraftContent,
} from "@/services/feedbackReviewService";
import type { WritingSubmission } from "@/services/submissionService";

const timestamp = "2026-07-13T08:00:00.000Z";
const topicOptions = [
  { slug: "articles", name: "Articles" },
  { slug: "nominativ", name: "Nominative" },
  { slug: "akkusativ", name: "Accusative" },
  { slug: "dativ", name: "Dative" },
  { slug: "genitiv", name: "Genitive" },
  { slug: "prepositions", name: "Prepositions" },
  { slug: "word-order", name: "Word order" },
];

function draftContent(): FeedbackDraftContent {
  return {
    feedback_contract_version: 2,
    overall_summary: "Review the exact correction.",
    level_detected: "A2",
    corrected_text: "Ich gehe zur Schule.",
    ai_model: "fixture",
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
            reason: "Original exact-span reason.",
            grammar_topics: topicOptions.slice(0, 6).map((topic) => topic.slug),
            severity: "minor",
            source_start: 9,
            source_end: 9,
            corrected_start: 9,
            corrected_end: 13,
          },
        ],
        short_explanation: "Use zur before Schule.",
        detailed_explanation: "",
        grammar_topic: "akkusativ",
      },
    ],
    grammar_topics: [],
    score_summary: {},
  };
}

function draft(content = draftContent()): FeedbackDraft {
  return {
    id: "draft-1",
    submission_id: "submission-1",
    version: 1,
    revision: 1,
    state: "draft",
    content,
    provider_model: "fixture",
    created_at: timestamp,
    updated_at: timestamp,
    approved_at: null,
    released_at: null,
  };
}

const submission = {
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
} satisfies WritingSubmission;

function renderEditor(content = draftContent()) {
  render(
    <TeacherFeedbackDraftEditor
      submission={submission}
      draft={draft(content)}
      topicOptions={topicOptions}
      onChanged={mocks.onChanged}
      onReleased={mocks.onReleased}
    />,
  );
}

describe("teacher exact-correction editing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onChanged.mockResolvedValue(undefined);
    mocks.onReleased.mockResolvedValue(undefined);
    mocks.updateFeedbackDraft.mockImplementation(
      async (_id: string, content: FeedbackDraftContent, revision: number) => ({
        ...draft(content),
        revision: revision + 1,
      }),
    );
    mocks.releaseFeedback.mockResolvedValue({
      submission_id: "submission-1",
      feedback_version_id: "draft-1",
      feedback_version: 1,
      feedback_revision: 2,
      state: "released",
      release_status: "released",
      released_at: timestamp,
    });
  });

  it("persists the teacher-edited span reason before releasing", async () => {
    const user = userEvent.setup();
    renderEditor();

    const reason = screen.getByLabelText("Reason for this exact correction");
    expect(reason).not.toHaveAttribute("maxlength");
    await user.clear(reason);
    await user.type(reason, "Teacher-approved exact-span reason.");
    await user.click(
      screen.getByRole("button", { name: "Approve and release" }),
    );

    await waitFor(() => expect(mocks.updateFeedbackDraft).toHaveBeenCalled());
    const savedContent = mocks.updateFeedbackDraft.mock.calls[0][1] as FeedbackDraftContent;
    expect(savedContent.lines[0].changed_parts[0].reason).toBe(
      "Teacher-approved exact-span reason.",
    );
    expect(savedContent.grammar_topics[0].simple_explanation).toBe(
      "Teacher-approved exact-span reason.",
    );
    expect(mocks.releaseFeedback).toHaveBeenCalledWith(
      "submission-1",
      "draft-1",
    );
  });

  it("locks unselected topics at six and unlocks them after one is removed", async () => {
    const user = userEvent.setup();
    renderEditor();

    const seventhTopic = screen.getByRole("checkbox", { name: "Word order" });
    expect(seventhTopic).toBeDisabled();
    expect(
      screen.getByText("6 of 6 grammar topics selected. Remove one to choose another."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Genitive" }));
    expect(seventhTopic).toBeEnabled();

    await user.click(seventhTopic);
    expect(screen.getByRole("checkbox", { name: "Genitive" })).toBeDisabled();
  });

  it("blocks release until every exact correction has a reason", () => {
    const content = draftContent();
    content.lines[0].changed_parts[0].reason = "";
    renderEditor(content);

    expect(
      screen.getByRole("button", { name: "Approve and release" }),
    ).toBeDisabled();
    expect(screen.getByText("Teacher decision required")).toBeInTheDocument();
  });

  it("saves incomplete correction metadata privately while release stays blocked", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.clear(screen.getByLabelText("Reason for this exact correction"));
    expect(
      screen.getByRole("button", { name: "Approve and release" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save private draft" }));

    await waitFor(() => expect(mocks.updateFeedbackDraft).toHaveBeenCalled());
    const savedContent = mocks.updateFeedbackDraft.mock.calls[0][1] as FeedbackDraftContent;
    expect(savedContent.lines[0].changed_parts[0].reason).toBe("");
    expect(mocks.releaseFeedback).not.toHaveBeenCalled();
  });

  it("counts and caps correction reasons by Unicode code point", () => {
    renderEditor();

    const reason = screen.getByLabelText("Reason for this exact correction");
    fireEvent.change(reason, { target: { value: "🙂".repeat(4_001) } });

    expect(Array.from((reason as HTMLTextAreaElement).value)).toHaveLength(4_000);
    expect(screen.getByText(/4,000 \/ 4,000 characters\./)).toBeInTheDocument();
  });

  it("names each topic group with its line and correction number", () => {
    renderEditor();

    expect(
      screen.getByRole("group", {
        name: "Grammar topics for line 1, correction 1",
      }),
    ).toBeInTheDocument();
  });

  it("reports a committed save even when the parent refresh fails", async () => {
    const user = userEvent.setup();
    mocks.onChanged.mockRejectedValueOnce(new Error("refresh unavailable"));
    renderEditor();

    const reason = screen.getByLabelText("Reason for this exact correction");
    await user.clear(reason);
    await user.type(reason, "Saved before refresh.");
    await user.click(screen.getByRole("button", { name: "Save private draft" }));

    await waitFor(() => expect(mocks.onChanged).toHaveBeenCalled());
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Feedback draft saved",
    }));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Draft saved; refresh delayed",
    }));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: "Feedback was not saved",
    }));
  });

  it("reports a committed release even when the parent refresh fails", async () => {
    const user = userEvent.setup();
    mocks.onReleased.mockRejectedValueOnce(new Error("refresh unavailable"));
    renderEditor();

    await user.click(screen.getByRole("button", { name: "Approve and release" }));

    await waitFor(() => expect(mocks.onReleased).toHaveBeenCalled());
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Feedback released",
    }));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Feedback released; refresh delayed",
    }));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: "Feedback was not released",
    }));
  });
});
