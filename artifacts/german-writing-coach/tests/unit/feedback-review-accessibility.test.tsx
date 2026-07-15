import axe from "axe-core";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RealFeedbackReview } from "@/components/real-feedback-review";
import type {
  WritingFeedback,
  WritingSubmission,
} from "@/services/submissionService";

const submission: WritingSubmission = {
  id: "10000000-0000-4000-8000-000000000001",
  workspace_id: "20000000-0000-4000-8000-000000000001",
  student_id: "30000000-0000-4000-8000-000000000001",
  batch_id: "40000000-0000-4000-8000-000000000001",
  question_id: null,
  global_question_id: null,
  question_source: "free_text",
  mode: "free_text",
  original_text: "Danach kommt die Bus.",
  corrected_text: "Danach kommt der Bus.",
  overall_summary: "Good work with one article correction.",
  level_detected: "A2",
  status: "checked",
  evaluation_status: "ready",
  release_status: "released",
  release_at: "2026-07-12T10:00:00.000Z",
  evaluation_version: 1,
  feedback_mode: "immediate",
  feedback_scheduled_at: null,
  feedback_started_at: "2026-07-12T09:59:00.000Z",
  feedback_completed_at: "2026-07-12T10:00:00.000Z",
  feedback_error: null,
  created_at: "2026-07-12T09:58:00.000Z",
  updated_at: "2026-07-12T10:00:00.000Z",
  checked_at: "2026-07-12T10:00:00.000Z",
  question_title: "Free Writing",
  question_prompt: null,
  question_level: "A2",
  question_topic: null,
  question_source_label: "Free Writing",
  batch_name: "A2 Evening",
  batch_level: "A2",
  student_name: "Learner",
  student_email: "learner@example.test",
};

const feedback: WritingFeedback = {
  lines: [
    {
      id: "line-1",
      line_number: 1,
      original_line: "Danach kommt die Bus.",
      corrected_line: "Danach kommt der Bus.",
      status: "minor_issue",
      changed_parts: [
        {
          from: "die",
          to: "der",
          reason: "Bus is masculine in the nominative case.",
          grammar_topics: ["articles", "nominativ"],
          severity: "minor",
        },
      ],
      short_explanation: "Use the masculine article with Bus.",
      detailed_explanation: null,
      grammar_topic: "Articles",
    },
    {
      id: "line-2",
      line_number: 2,
      original_line: "Ich gehen.",
      corrected_line: "Ich gehe.",
      status: "major_issue",
      changed_parts: [],
      short_explanation: "Conjugate the verb for ich.",
      detailed_explanation: null,
      grammar_topic: "Verb conjugation",
    },
  ],
  grammar_topics: [],
};

describe("released feedback accessibility", () => {
  it("announces replacements semantically without merging removed and added text", async () => {
    const user = userEvent.setup();
    render(
      <main>
        <RealFeedbackReview submission={submission} feedback={feedback} />
      </main>,
    );

    const correction = screen.getByRole("group", {
      name: /Correction: replace “die” with “der”\. Corrected sentence: Danach kommt der Bus\./,
    });
    expect(correction).toHaveAccessibleName(
      "Correction: replace “die” with “der”. Corrected sentence: Danach kommt der Bus.",
    );
    expect(correction).not.toHaveTextContent("dieder");
    expect(correction).toHaveTextContent("die→der");
    expect(correction.querySelector("[aria-hidden='true']")).not.toBeNull();

    await user.click(
      screen.getByRole("switch", { name: "Detailed Explanations" }),
    );
    expect(screen.getByText("Replace “die” with “der”.")).toHaveClass(
      "sr-only",
    );

    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
