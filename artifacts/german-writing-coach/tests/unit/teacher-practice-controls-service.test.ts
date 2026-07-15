import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callApiRpc: vi.fn(),
}));

vi.mock("@/services/apiFacade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/apiFacade")>();
  return {
    ...actual,
    callApiRpc: mocks.callApiRpc,
  };
});

import {
  getPracticeTeacherActions,
  overridePracticeAttemptScore,
  reassignPracticeAssignment,
  resolvePracticeSupport,
  type PracticeTeacherAction,
} from "@/services/practiceWorksheetService";
import { describePracticeTeacherAction } from "@/pages/teacher/practice";

const assignmentId = "11111111-1111-4111-8111-111111111111";

describe("teacher practice controls service", () => {
  beforeEach(() => {
    mocks.callApiRpc.mockReset();
  });

  it("parses revisioned immutable action history", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      assignment_id: assignmentId,
      current_revision: 1,
      support_status: "open",
      items: [{
        id: "22222222-2222-4222-8222-222222222222",
        action_revision: 1,
        action_type: "score_override",
        attempt_id: "33333333-3333-4333-8333-333333333333",
        resolution: null,
        reason: "The semantic answer did not meet the rubric.",
        before_state: { score_percent: 80, passed: true },
        after_state: { score_percent: 60, passed: false },
        related_assignment_id: null,
        actor_id: "44444444-4444-4444-8444-444444444444",
        actor_name: "Teacher",
        created_at: "2026-07-10T12:00:00.000Z",
      }],
    });

    await expect(getPracticeTeacherActions(assignmentId)).resolves.toMatchObject({
      current_revision: 1,
      support_status: "open",
      items: [{ action_type: "score_override", action_revision: 1 }],
    });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "get_practice_teacher_actions",
      { target_assignment_id: assignmentId },
      expect.any(String),
    );
  });

  it("rejects action history whose current revision does not match its newest item", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      assignment_id: assignmentId,
      current_revision: 2,
      support_status: "open",
      items: [{
        id: "22222222-2222-4222-8222-222222222222",
        action_revision: 1,
        action_type: "score_override",
        attempt_id: "33333333-3333-4333-8333-333333333333",
        resolution: null,
        reason: "Audit history mismatch fixture.",
        before_state: {},
        after_state: {},
        related_assignment_id: null,
        actor_id: "44444444-4444-4444-8444-444444444444",
        actor_name: "Teacher",
        created_at: "2026-07-10T12:00:00.000Z",
      }],
    });

    await expect(getPracticeTeacherActions(assignmentId)).rejects.toThrow(
      "Teacher action history returned an invalid response",
    );
  });

  it("sends the optimistic revision with a score override", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      action_id: "22222222-2222-4222-8222-222222222222",
      action_revision: 3,
      assignment_id: assignmentId,
      attempt_id: "33333333-3333-4333-8333-333333333333",
      score_points: 3.75,
      max_score_points: 5,
      score_percent: 75,
      passed: true,
      assignment_status: "passed",
      follow_up_assignment_id: null,
    });

    await expect(overridePracticeAttemptScore(
      assignmentId,
      75,
      "Teacher rubric review supports this result.",
      2,
    )).resolves.toMatchObject({ score_percent: 75, action_revision: 3 });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "override_practice_attempt_score",
      {
        target_assignment_id: assignmentId,
        target_score_percent: 75,
        override_reason: "Teacher rubric review supports this result.",
        expected_action_revision: 2,
      },
      expect.any(String),
    );
  });

  it("uses API-only commands for reassignment and support closure", async () => {
    const replacementId = "55555555-5555-4555-8555-555555555555";
    mocks.callApiRpc
      .mockResolvedValueOnce({
        schema_version: 1,
        assignment_id: assignmentId,
        action_revision: 2,
        replacement_assignment_id: replacementId,
      })
      .mockResolvedValueOnce({
        schema_version: 1,
        assignment_id: assignmentId,
        action_revision: 3,
        support_status: "resolved",
        resolution: "reassigned",
      });

    await expect(reassignPracticeAssignment(
      assignmentId,
      "Give the student another targeted worksheet.",
      1,
    )).resolves.toEqual({ action_revision: 2, replacement_assignment_id: replacementId });
    await expect(resolvePracticeSupport(
      assignmentId,
      "reassigned",
      "The replacement is ready.",
      2,
    )).resolves.toEqual({ action_revision: 3, support_status: "resolved" });

    expect(mocks.callApiRpc.mock.calls.map(([name]) => name)).toEqual([
      "reassign_practice_assignment",
      "resolve_practice_support",
    ]);
  });

  it("makes score and support audit entries understandable in the teacher UI", () => {
    const baseAction: PracticeTeacherAction = {
      id: "22222222-2222-4222-8222-222222222222",
      action_revision: 1,
      action_type: "score_override",
      attempt_id: "33333333-3333-4333-8333-333333333333",
      resolution: null,
      reason: "Rubric correction.",
      before_state: { score_percent: 80 },
      after_state: { score_percent: 60 },
      related_assignment_id: null,
      actor_id: "44444444-4444-4444-8444-444444444444",
      actor_name: "Teacher",
      created_at: "2026-07-10T12:00:00.000Z",
    };

    expect(describePracticeTeacherAction(baseAction)).toBe("Score changed from 80% to 60%.");
    expect(describePracticeTeacherAction({
      ...baseAction,
      action_type: "support_resolved",
      attempt_id: null,
      resolution: "contacted",
    })).toBe("Support closed after teacher contact.");
  });
});
