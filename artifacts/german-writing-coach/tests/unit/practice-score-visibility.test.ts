import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatPracticeScore,
  hasTerminalPracticeResult,
  type PracticeAssignmentSummary,
} from "@/services/practiceWorksheetService";

function assignment(
  overrides: Partial<PracticeAssignmentSummary> = {},
): PracticeAssignmentSummary {
  return {
    id: "assignment-1",
    workspace_id: "workspace-1",
    student_id: "student-1",
    grammar_topic_id: "topic-1",
    grammar_topic_name: "Word order",
    grammar_topic_slug: "word-order",
    grammar_topic_description: null,
    batch_id: "batch-1",
    batch_name: "B1 Class",
    class_context_version: 1,
    practice_test_id: "worksheet-1",
    worksheet_title: "Word order",
    worksheet_level: "B1",
    worksheet_difficulty: "medium",
    worksheet_mini_lesson: null,
    status: "completed",
    source: "adaptive",
    assigned_at: "2026-07-11T08:00:00.000Z",
    started_at: "2026-07-11T08:01:00.000Z",
    completed_at: "2026-07-11T08:02:00.000Z",
    latest_attempt_id: "attempt-1",
    latest_attempt_status: "submitted",
    score: 1,
    max_score: 2,
    score_points: 1,
    max_score_points: 2,
    scoring_version: "provisional-v1",
    evaluation_status: "queued",
    evaluation_started_at: null,
    evaluation_completed_at: null,
    evaluation_error: null,
    score_percent: 50,
    passed: false,
    question_count: 2,
    generation_status: "ready",
    generation_retry_exhausted: false,
    generation_started_at: null,
    generation_completed_at: "2026-07-11T08:00:00.000Z",
    generation_error: null,
    previous_assignment_id: null,
    previous_attempt_id: null,
    repeat_number: 0,
    adaptive_reason: null,
    adaptive_status: null,
    resolution_cycle_id: null,
    resolution_cycle_number: null,
    evidence_cutoff_sequence: null,
    ...overrides,
  };
}

describe("student practice score visibility", () => {
  it.each(["queued", "evaluating", "failed"])(
    "hides a provisional subtotal while evaluation is %s",
    (evaluationStatus) => {
      const value = assignment({
        latest_attempt_status: "submitted",
        evaluation_status: evaluationStatus,
      });

      expect(hasTerminalPracticeResult(value)).toBe(false);
      expect(formatPracticeScore(value)).toBeNull();
    },
  );

  it("does not treat checked alone as terminal", () => {
    const value = assignment({ latest_attempt_status: "checked" });

    expect(hasTerminalPracticeResult(value)).toBe(false);
    expect(formatPracticeScore(value)).toBeNull();
  });

  it.each(["completed", "not_needed"])(
    "renders a checked %s result",
    (evaluationStatus) => {
      const value = assignment({
        status: "passed",
        latest_attempt_status: "checked",
        evaluation_status: evaluationStatus,
        score: 2,
        max_score: 2,
        score_points: 2,
        max_score_points: 2,
        scoring_version: "final-v1",
        evaluation_completed_at: "2026-07-11T08:03:00.000Z",
        score_percent: 100,
        passed: true,
      });

      expect(hasTerminalPracticeResult(value)).toBe(true);
      expect(formatPracticeScore(value)).toBe("2/2 (100%)");
    },
  );

  it("lets the teacher recovery view render a provisional subtotal explicitly", () => {
    expect(formatPracticeScore(assignment(), { allowProvisional: true })).toBe(
      "1/2 (50%)",
    );
  });

  it("keeps the provisional override out of both student rendering surfaces", () => {
    const studentPractice = readFileSync(
      path.resolve(process.cwd(), "src/pages/student/practice.tsx"),
      "utf8",
    );
    const studentWorksheet = readFileSync(
      path.resolve(process.cwd(), "src/pages/student/worksheet.tsx"),
      "utf8",
    );
    const teacherPractice = readFileSync(
      path.resolve(process.cwd(), "src/pages/teacher/practice.tsx"),
      "utf8",
    );

    expect(studentPractice).not.toContain("allowProvisional");
    expect(studentWorksheet).not.toContain("allowProvisional");
    expect(teacherPractice).toContain("allowProvisional: true");
  });
});
