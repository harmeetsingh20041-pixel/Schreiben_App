import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  persistStudentBatchId,
  readPersistedStudentBatchId,
  resolveActiveStudentBatchId,
  studentClassStorageKey,
} from "@/lib/studentClassContext";
import {
  createBoundedPracticePollController,
  createStudentPracticeQueries,
  hasPendingPracticeAssignment,
  PRACTICE_ASSIGNMENTS_POLL_INTERVAL_MS,
  PRACTICE_ASSIGNMENTS_POLL_WINDOW_MS,
  PRACTICE_WORKSPACE_SCOPE_COPY,
  refreshStudentPracticeOnResume,
} from "@/lib/studentPracticeQueries";
import type { StudentBatchAssignment } from "@/services/studentService";
import type { PracticeAssignmentSummary } from "@/services/practiceWorksheetService";

const assignments: StudentBatchAssignment[] = [
  {
    id: "assignment-a",
    workspace_id: "workspace-1",
    batch_id: "batch-a",
    batch_name: "A1 Morning",
    level: "A1",
  },
  {
    id: "assignment-b",
    workspace_id: "workspace-1",
    batch_id: "batch-b",
    batch_name: "A2 Evening",
    level: "A2",
  },
];

function practiceAssignment(
  overrides: Partial<PracticeAssignmentSummary> = {},
): PracticeAssignmentSummary {
  return {
    id: "practice-1",
    workspace_id: "workspace-1",
    student_id: "student-1",
    grammar_topic_id: "topic-1",
    grammar_topic_name: "Word order",
    grammar_topic_slug: "word-order",
    grammar_topic_description: null,
    batch_id: "batch-a",
    batch_name: "A1 Morning",
    class_context_version: 1,
    practice_test_id: null,
    worksheet_title: null,
    worksheet_level: "A1",
    worksheet_difficulty: "easy",
    worksheet_mini_lesson: null,
    status: "unlocked",
    source: "adaptive",
    assigned_at: "2026-07-11T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    latest_attempt_id: null,
    latest_attempt_status: null,
    score: null,
    max_score: null,
    score_points: null,
    max_score_points: null,
    scoring_version: null,
    evaluation_status: null,
    evaluation_started_at: null,
    evaluation_completed_at: null,
    evaluation_error: null,
    score_percent: null,
    passed: null,
    question_count: 0,
    generation_status: "idle",
    generation_retry_exhausted: false,
    generation_started_at: null,
    generation_completed_at: null,
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

describe("shared student class context", () => {
  it("auto-selects only an unambiguous class and fails closed for stale multi-class choices", () => {
    expect(resolveActiveStudentBatchId(assignments.slice(0, 1), null)).toBe(
      "batch-a",
    );
    expect(resolveActiveStudentBatchId(assignments, "batch-b")).toBe("batch-b");
    expect(
      resolveActiveStudentBatchId(assignments, "archived-batch"),
    ).toBeNull();
    expect(resolveActiveStudentBatchId(assignments, null)).toBeNull();
  });

  it("scopes persisted choices to the student and workspace", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => void values.set(key, value),
    };

    persistStudentBatchId(storage, "student-1", "workspace-1", "batch-a");
    expect(
      readPersistedStudentBatchId(storage, "student-1", "workspace-1"),
    ).toBe("batch-a");
    expect(
      readPersistedStudentBatchId(storage, "student-2", "workspace-1"),
    ).toBeNull();
    expect(studentClassStorageKey("student-1", "workspace-2")).not.toBe(
      studentClassStorageKey("student-1", "workspace-1"),
    );

    persistStudentBatchId(storage, "student-1", "workspace-1", null);
    expect(
      readPersistedStudentBatchId(storage, "student-1", "workspace-1"),
    ).toBeNull();
  });

  it("survives browser storage being unavailable", () => {
    const blockedStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(
      readPersistedStudentBatchId(blockedStorage, "student-1", "workspace-1"),
    ).toBeNull();
    expect(() =>
      persistStudentBatchId(
        blockedStorage,
        "student-1",
        "workspace-1",
        "batch-a",
      ),
    ).not.toThrow();
  });
});

describe("student Practice query performance", () => {
  it("deduplicates concurrent assignment loads through one shared query key", async () => {
    const assignmentLoader = vi.fn(async () => [practiceAssignment()]);
    const queries = createStudentPracticeQueries("workspace-1", "student-1", {
      assignments: assignmentLoader,
      assignment: vi.fn(async () => practiceAssignment()),
      stats: vi.fn(async () => []),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const [first, second] = await Promise.all([
      queryClient.fetchQuery(queries.assignments),
      queryClient.fetchQuery(queries.assignments),
    ]);

    expect(first).toEqual(second);
    expect(assignmentLoader).toHaveBeenCalledTimes(1);
  });

  it("reuses fresh bootstrap data when focus resumes practice polling", async () => {
    const assignmentLoader = vi.fn(async () => [practiceAssignment()]);
    const statsLoader = vi.fn(async () => []);
    const queries = createStudentPracticeQueries("workspace-1", "student-1", {
      assignments: assignmentLoader,
      assignment: vi.fn(async () => practiceAssignment()),
      stats: statsLoader,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const pollController = createBoundedPracticePollController();

    await Promise.all([
      queryClient.fetchQuery(queries.stats),
      queryClient.fetchQuery(queries.assignments),
    ]);
    await refreshStudentPracticeOnResume(queryClient, queries, pollController);

    expect(statsLoader).toHaveBeenCalledTimes(1);
    expect(assignmentLoader).toHaveBeenCalledTimes(1);
  });

  it("polls only while work is pending and stops after the bounded window", () => {
    let now = 1_000;
    const controller = createBoundedPracticePollController(() => now);
    const pending = [practiceAssignment({ generation_status: "queued" })];

    expect(hasPendingPracticeAssignment(pending)).toBe(true);
    expect(controller.getInterval(pending)).toBe(
      PRACTICE_ASSIGNMENTS_POLL_INTERVAL_MS,
    );
    now += PRACTICE_ASSIGNMENTS_POLL_WINDOW_MS - 1;
    expect(controller.getInterval(pending)).toBe(
      PRACTICE_ASSIGNMENTS_POLL_INTERVAL_MS,
    );
    now += 1;
    expect(controller.getInterval(pending)).toBe(false);
    expect(
      controller.getInterval([
        practiceAssignment({ generation_status: "ready" }),
      ]),
    ).toBe(false);

    now += 1;
    expect(controller.getInterval(pending)).toBe(
      PRACTICE_ASSIGNMENTS_POLL_INTERVAL_MS,
    );
  });

  it("briefly polls a held historical assignment so teacher class recovery appears without a reload", () => {
    const heldForClass = [
      practiceAssignment({
        batch_id: null,
        batch_name: null,
        class_context_version: 0,
        worksheet_level: null,
        generation_status: "failed",
        generation_error: "generation_failed",
      }),
    ];

    expect(hasPendingPracticeAssignment(heldForClass)).toBe(true);
    expect(
      createBoundedPracticePollController().getInterval(heldForClass),
    ).toBe(PRACTICE_ASSIGNMENTS_POLL_INTERVAL_MS);
  });

  it("states clearly that adaptive Practice is workspace-wide", () => {
    expect(PRACTICE_WORKSPACE_SCOPE_COPY).toContain(
      "all of your active classes",
    );
    expect(PRACTICE_WORKSPACE_SCOPE_COPY).toContain("does not filter Practice");
  });
});
