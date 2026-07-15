import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callApiRpc: vi.fn() }));

vi.mock("@/services/apiFacade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/apiFacade")>();
  return { ...actual, callApiRpc: mocks.callApiRpc };
});

import {
  listStudentAssignedQuestionsPage,
  type StudentAssignedQuestion,
} from "@/services/questionService";
import { getStudentReleasedFeedbackSummary } from "@/services/submissionService";

function task(
  overrides: Partial<StudentAssignedQuestion> = {},
): StudentAssignedQuestion {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    workspace_id: "20000000-0000-4000-8000-000000000001",
    source: "workspace",
    batch_id: "30000000-0000-4000-8000-000000000001",
    batch_name: "A2 Morning",
    title: "A day at school",
    prompt: "Write about school.",
    level: "A2",
    topic: "School",
    task_type: "writing",
    expected_word_min: 60,
    expected_word_max: 90,
    estimated_minutes: 20,
    is_active: true,
    created_by: null,
    created_at: "2026-07-10T11:00:00.000Z",
    updated_at: "2026-07-10T11:00:00.000Z",
    task_state: "feedback_held",
    latest_submission_id: "40000000-0000-4000-8000-000000000001",
    latest_submission_status: "checked",
    latest_evaluation_status: "ready",
    latest_release_status: "held",
    latest_release_at: null,
    latest_feedback_mode: "teacher_review_only",
    latest_submission_created_at: "2026-07-10T11:30:00.000Z",
    ...overrides,
  };
}

describe("student task and released-feedback read models", () => {
  beforeEach(() => mocks.callApiRpc.mockReset());

  it("requests one explicit class page and preserves the server-derived held state", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [task()],
      total_count: 14,
      returned_count: 1,
      page_size: 9,
      has_more: true,
      next_cursor: {
        created_at: "2026-07-10T11:00:00.000Z",
        source: "workspace",
        id: "10000000-0000-4000-8000-000000000001",
      },
    });

    const page = await listStudentAssignedQuestionsPage({
      studentId: "50000000-0000-4000-8000-000000000001",
      batchId: "30000000-0000-4000-8000-000000000001",
      search: " school ",
      level: "A2",
      pageSize: 9,
    });

    expect(page.items[0]).toMatchObject({
      task_state: "feedback_held",
      latest_release_status: "held",
    });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "list_student_assigned_questions_page",
      {
        target_student_id: "50000000-0000-4000-8000-000000000001",
        target_batch_id: "30000000-0000-4000-8000-000000000001",
        target_search: "school",
        target_level: "A2",
        requested_page_size: 9,
        cursor_created_at: null,
        cursor_source: null,
        cursor_id: null,
      },
      "Your writing tasks could not be loaded. Please try again.",
    );
  });

  it("passes the complete three-part keyset cursor and rejects contradictory task state", async () => {
    mocks.callApiRpc.mockResolvedValueOnce({
      schema_version: 1,
      items: [
        task({ task_state: "failed", latest_evaluation_status: "failed" }),
      ],
      total_count: 1,
      returned_count: 1,
      page_size: 9,
      has_more: false,
      next_cursor: null,
    });
    await listStudentAssignedQuestionsPage({
      studentId: "50000000-0000-4000-8000-000000000001",
      batchId: "30000000-0000-4000-8000-000000000001",
      cursor: {
        created_at: "2026-07-10T12:00:00.000Z",
        source: "global",
        id: "60000000-0000-4000-8000-000000000001",
      },
    });
    expect(mocks.callApiRpc.mock.calls[0]?.[1]).toMatchObject({
      cursor_created_at: "2026-07-10T12:00:00.000Z",
      cursor_source: "global",
      cursor_id: "60000000-0000-4000-8000-000000000001",
    });

    mocks.callApiRpc.mockResolvedValueOnce({
      schema_version: 1,
      items: [task({ task_state: "not_started" })],
      total_count: 1,
      returned_count: 1,
      page_size: 9,
      has_more: false,
      next_cursor: null,
    });
    await expect(
      listStudentAssignedQuestionsPage({
        studentId: "50000000-0000-4000-8000-000000000001",
        batchId: "30000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("invalid response");
  });

  it("loads only the released count and latest link metadata for the dashboard", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      released_count: 7,
      latest_submission: {
        id: "70000000-0000-4000-8000-000000000001",
        created_at: "2026-07-10T12:00:00.000Z",
        question_title: "Latest writing",
      },
    });

    const summary = await getStudentReleasedFeedbackSummary(
      "20000000-0000-4000-8000-000000000001",
      "50000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000001",
    );

    expect(summary.released_count).toBe(7);
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "get_student_released_feedback_summary",
      {
        target_workspace_id: "20000000-0000-4000-8000-000000000001",
        target_student_id: "50000000-0000-4000-8000-000000000001",
        target_batch_id: "30000000-0000-4000-8000-000000000001",
      },
      "Your released-feedback summary could not be loaded. Please try again.",
    );
  });
});
