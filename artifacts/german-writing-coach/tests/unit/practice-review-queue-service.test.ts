import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callApiRpc: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@/services/apiFacade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/apiFacade")>();
  return { ...actual, callApiRpc: mocks.callApiRpc };
});

vi.mock("@/lib/supabaseClient", () => ({
  getSupabaseClient: () => ({ functions: { invoke: mocks.invoke } }),
}));

import {
  decideQuarantinedWorksheet,
  getQuarantinedWorksheet,
  listPracticeReviewQueuePage,
  retryPracticeAttemptEvaluation,
} from "@/services/practiceReviewQueueService";

const assignmentId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const testId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-07-10T12:00:00.000Z";

function queueItem() {
  return {
    queue_key: `worksheet_quarantine:${assignmentId}`,
    assignment_id: assignmentId,
    attempt_id: null,
    practice_test_id: testId,
    workspace_id: workspaceId,
    student_id: "55555555-5555-4555-8555-555555555555",
    student_name: "Student",
    student_email: "student@example.test",
    grammar_topic_name: "Prepositions",
    worksheet_title: "Preposition practice",
    action_kind: "worksheet_quarantine",
    generation_status: "needs_review",
    evaluation_status: null,
    error_code: "independent_validation_rejected",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function quarantinedWorksheet() {
  return {
    schema_version: 1,
    assignment: {
      id: assignmentId,
      workspace_id: workspaceId,
      student_id: "55555555-5555-4555-8555-555555555555",
      student_name: "Student",
      grammar_topic_id: "66666666-6666-4666-8666-666666666666",
      grammar_topic_name: "Prepositions",
      generation_status: "needs_review",
    },
    worksheet: {
      id: testId,
      title: "Preposition practice",
      description: "Focused A1 practice.",
      level: "A1",
      difficulty: "easy",
      mini_lesson: { key_rule: "Use the correct case." },
      quality_status: "needs_review",
      quality_notes: "Independent critic rejected one ambiguity.",
      generator_model: "deepseek-v4-pro",
      generation_metadata: {
        validation: { rejection_reasons: ["One item may have two valid answers."] },
      },
      created_at: timestamp,
      questions: [{
        id: "77777777-7777-4777-8777-777777777777",
        question_number: 1,
        question_type: "multiple_choice",
        evaluation_mode: "local_exact",
        prompt: "Which answer is correct?",
        options: ["A", "B", "C"],
        correct_answer: "A",
        accepted_answers: ["A"],
        rubric: null,
        explanation: "A is correct in this context.",
        answer_contract_version: 1,
      }],
    },
  };
}

describe("teacher practice review queue service", () => {
  beforeEach(() => {
    mocks.callApiRpc.mockReset();
    mocks.invoke.mockReset();
  });

  it("parses a server-filtered keyset page without client-side caps", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [queueItem()],
      total_count: 26,
      returned_count: 1,
      page_size: 25,
      has_more: true,
      next_cursor: {
        updated_at: timestamp,
        queue_key: `worksheet_quarantine:${assignmentId}`,
      },
    });

    await expect(listPracticeReviewQueuePage({
      workspaceId,
      kind: "worksheet_quarantine",
      pageSize: 25,
    })).resolves.toMatchObject({
      total_count: 26,
      has_more: true,
      items: [{ action_kind: "worksheet_quarantine" }],
    });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "list_practice_review_queue_page",
      expect.objectContaining({
        target_workspace_id: workspaceId,
        target_kind: "worksheet_quarantine",
        requested_page_size: 25,
      }),
      expect.any(String),
    );
  });

  it("rejects unknown server action kinds", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [{ ...queueItem(), action_kind: "raw_provider_failure" }],
      total_count: 1,
      returned_count: 1,
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });

    await expect(listPracticeReviewQueuePage({ workspaceId })).rejects.toThrow(
      "Practice review queue returned an invalid response",
    );
  });

  it("loads complete private answer contracts only through the teacher API", async () => {
    mocks.callApiRpc.mockResolvedValue(quarantinedWorksheet());

    await expect(getQuarantinedWorksheet(assignmentId)).resolves.toMatchObject({
      assignment: { id: assignmentId, generation_status: "needs_review" },
      worksheet: {
        id: testId,
        questions: [{
          evaluation_mode: "local_exact",
          accepted_answers: ["A"],
          answer_contract_version: 1,
        }],
      },
    });
  });

  it("records an explicit human decision with review notes", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      action_id: "88888888-8888-4888-8888-888888888888",
      assignment_id: assignmentId,
      practice_test_id: testId,
      decision: "approve",
      quality_status: "approved",
      generation_status: "ready",
    });

    await expect(decideQuarantinedWorksheet(
      assignmentId,
      "approve",
      "Every task and accepted answer was checked by a teacher.",
    )).resolves.toMatchObject({ decision: "approve", generation_status: "ready" });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "decide_quarantined_practice_worksheet",
      expect.objectContaining({
        target_assignment_id: assignmentId,
        target_decision: "approve",
      }),
      expect.any(String),
    );
  });

  it("returns the durable retry state even when the immediate processor kick needs recovery", async () => {
    mocks.callApiRpc.mockResolvedValue([{
      attempt_id: attemptId,
      assignment_id: assignmentId,
      job_id: "99999999-9999-4999-8999-999999999999",
      evaluation_status: "queued",
      job_created: true,
      already_processing: false,
    }]);
    mocks.invoke.mockResolvedValue({ data: null, error: new Error("temporary") });

    await expect(retryPracticeAttemptEvaluation(assignmentId, attemptId)).resolves.toEqual({
      assignment_id: assignmentId,
      attempt_id: attemptId,
      evaluation_status: "queued",
      already_processing: false,
      processor_kick: "recovery_pending",
    });
  });

  it("reports when the immediate processor kick was accepted", async () => {
    mocks.callApiRpc.mockResolvedValue([{
      attempt_id: attemptId,
      assignment_id: assignmentId,
      job_id: "99999999-9999-4999-8999-999999999999",
      evaluation_status: "queued",
      job_created: true,
      already_processing: false,
    }]);
    mocks.invoke.mockResolvedValue({
      error: null,
      data: {
        accepted: true,
        assignment_id: assignmentId,
        attempt_id: attemptId,
        evaluation_status: "queued",
      },
    });

    await expect(retryPracticeAttemptEvaluation(assignmentId, attemptId)).resolves.toMatchObject({
      processor_kick: "requested",
    });
  });
});
