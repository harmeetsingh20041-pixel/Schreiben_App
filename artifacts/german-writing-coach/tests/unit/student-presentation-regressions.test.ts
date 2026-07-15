import { describe, expect, it } from "vitest";
import { getWordGuidance } from "@/pages/student/questions";
import {
  getProminentJoinRequest,
  type BatchJoinRequest,
} from "@/services/studentService";
import type { WorkspaceQuestion } from "@/services/questionService";

function joinRequest(
  id: string,
  status: BatchJoinRequest["status"],
): BatchJoinRequest {
  return {
    id,
    workspace_id: "10000000-0000-4000-8000-000000000001",
    batch_id: "20000000-0000-4000-8000-000000000001",
    student_id: "30000000-0000-4000-8000-000000000001",
    status,
    requested_at: "2026-07-12T10:00:00.000Z",
    decided_at: status === "pending" ? null : "2026-07-12T10:01:00.000Z",
    decided_by:
      status === "pending" ? null : "40000000-0000-4000-8000-000000000001",
    student_name: "Learner",
    student_email: "learner@example.test",
    batch_name: `Class ${id}`,
    batch_level: "A2",
  };
}

function writingTask(
  expectedWordMin: number | null,
  expectedWordMax: number | null,
): WorkspaceQuestion {
  return {
    expected_word_min: expectedWordMin,
    expected_word_max: expectedWordMax,
  } as WorkspaceQuestion;
}

describe("student-facing presentation regressions", () => {
  it("skips cancelled and rejected requests in the prominent join status", () => {
    const pending = joinRequest("pending", "pending");
    expect(
      getProminentJoinRequest([
        joinRequest("cancelled", "cancelled"),
        joinRequest("rejected", "rejected"),
        pending,
      ]),
    ).toBe(pending);
    expect(
      getProminentJoinRequest([
        joinRequest("cancelled", "cancelled"),
        joinRequest("rejected", "rejected"),
      ]),
    ).toBeUndefined();
  });

  it("uses polished writing-task length guidance", () => {
    expect(getWordGuidance(writingTask(60, 90))).toBe(
      "Suggested length: 60–90 words",
    );
    expect(getWordGuidance(writingTask(null, null))).toBe(
      "Suggested length: no fixed word limit",
    );
  });
});
