import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callApiRpc: vi.fn() }));

vi.mock("@/services/apiFacade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/apiFacade")>();
  return { ...actual, callApiRpc: mocks.callApiRpc };
});

import { listTeacherQuestionBankPage } from "@/services/questionService";
import { getTeacherDashboardSummary } from "@/services/teacherReadModelService";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";
const studentId = "33333333-3333-4333-8333-333333333333";
const topicId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-07-10T12:00:00.000Z";

function weakTopic() {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    workspace_id: workspaceId,
    student_id: studentId,
    student_name: "Anna Beispiel",
    student_email: "anna@example.test",
    grammar_topic_id: topicId,
    topic_name: "Word order",
    topic_slug: "word-order",
    topic_description: null,
    total_minor_issues: 2,
    total_major_issues: 4,
    total_correct_after_practice: 0,
    weakness_level: "in_progress",
    practice_unlocked: false,
    last_seen_at: timestamp,
    updated_at: timestamp,
    active_practice: {
      id: "66666666-6666-4666-8666-666666666666",
      student_id: studentId,
      grammar_topic_id: topicId,
      practice_test_id: "77777777-7777-4777-8777-777777777777",
      worksheet_title: "Word order practice",
      status: "in_progress",
      source: "weakness_auto",
      generation_status: "ready",
      evaluation_status: null,
      latest_attempt_status: "in_progress",
    },
  };
}

function question(id: string) {
  return {
    id,
    workspace_id: workspaceId,
    source: "workspace",
    batch_id: null,
    title: "A2 email",
    prompt: "Schreiben Sie eine E-Mail.",
    level: "A2",
    topic: "Alltag",
    task_type: "email",
    expected_word_min: 60,
    expected_word_max: 80,
    estimated_minutes: 20,
    is_active: true,
    created_by: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("bounded teacher read-model services", () => {
  beforeEach(() => mocks.callApiRpc.mockReset());

  it("loads dashboard counts and attention in one class-aware RPC", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      workspace_id: workspaceId,
      batch_id: batchId,
      student_count: 18,
      question_count: 34,
      pending_join_request_count: 2,
      attention_items: [weakTopic()],
    });

    const summary = await getTeacherDashboardSummary(workspaceId, batchId);

    expect(summary).toMatchObject({
      student_count: 18,
      question_count: 34,
      pending_join_request_count: 2,
      attention_items: [{
        topic_slug: "word-order",
        active_practice: { status: "in_progress" },
      }],
    });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "get_teacher_dashboard_summary",
      {
        target_workspace_id: workspaceId,
        target_batch_id: batchId,
        requested_attention_limit: 6,
      },
      expect.any(String),
    );
  });

  it("sends every Content filter and keyset cursor to one bounded question-bank RPC", async () => {
    const cursor = {
      sort_rank: 0,
      created_at: "2026-07-10T13:00:00.000Z",
      id: "88888888-8888-4888-8888-000000000000",
    };
    const nextCursor = {
      sort_rank: 0,
      created_at: timestamp,
      id: "88888888-8888-4888-8888-000000000012",
    };
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: Array.from({ length: 12 }, (_, index) => question(
        `88888888-8888-4888-8888-${String(index + 1).padStart(12, "0")}`,
      )),
      total_count: 13,
      returned_count: 12,
      page_size: 12,
      has_more: true,
      next_cursor: nextCursor,
      available_topics: ["Alltag", "Reisen"],
    });

    const page = await listTeacherQuestionBankPage({
      workspaceId,
      source: "workspace",
      search: "  email  ",
      level: "A2",
      topic: "Alltag",
      taskType: "email",
      status: "active",
      pageSize: 12,
      cursor,
    });

    expect(page).toMatchObject({
      total_count: 13,
      next_cursor: nextCursor,
      available_topics: ["Alltag", "Reisen"],
    });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "list_teacher_question_bank_page",
      {
        target_workspace_id: workspaceId,
        target_source: "workspace",
        search_query: "email",
        target_level: "A2",
        target_topic: "Alltag",
        target_task_type: "email",
        target_status: "active",
        requested_page_size: 12,
        cursor_sort_rank: 0,
        cursor_created_at: cursor.created_at,
        cursor_id: cursor.id,
      },
      expect.any(String),
    );
  });

  it("rejects a page whose returned source does not match the requested bank", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [{ ...question("99999999-9999-4999-8999-999999999999"), source: "global" }],
      total_count: 1,
      returned_count: 1,
      page_size: 12,
      has_more: false,
      next_cursor: null,
      available_topics: ["Alltag"],
    });

    await expect(listTeacherQuestionBankPage({
      workspaceId,
      source: "workspace",
    })).rejects.toMatchObject({ code: "data_invalid_response" });
  });

  it("removes whole-workspace teacher scans from page source", () => {
    const students = readFileSync(
      path.resolve(process.cwd(), "src/pages/teacher/students.tsx"),
      "utf8",
    );
    const dashboard = readFileSync(
      path.resolve(process.cwd(), "src/pages/teacher/dashboard.tsx"),
      "utf8",
    );
    const questions = readFileSync(
      path.resolve(process.cwd(), "src/pages/teacher/questions.tsx"),
      "utf8",
    );
    const dashboardQueries = readFileSync(
      path.resolve(process.cwd(), "src/lib/dashboardQueries.ts"),
      "utf8",
    );
    const reviewQueue = readFileSync(
      path.resolve(process.cwd(), "src/pages/teacher/review-queue.tsx"),
      "utf8",
    );

    expect(students).not.toMatch(/listWorkspaceGrammarStats|listWorkspacePracticeAssignments/);
    expect(students).toContain("refetchInterval: 15_000");
    expect(dashboard).not.toMatch(/listBatchJoinRequests|grammarStatsQuery|practiceAssignmentsQuery/);
    expect(dashboardQueries).toContain("getTeacherDashboardSummary");
    expect(dashboardQueries).toContain("refetchInterval: 15_000");
    expect(questions).toContain("listTeacherQuestionBankPage");
    expect(questions).not.toMatch(/listGlobalQuestions|listWorkspaceQuestions/);
    expect(questions).toContain('aria-label="Writing task pages"');
    expect(questions).toContain('aria-label="Previous writing tasks page"');
    expect(questions).toContain('aria-label="Next writing tasks page"');
    expect(reviewQueue.match(/refetchInterval: 15_000/g)).toHaveLength(2);
    expect(reviewQueue.match(/refetchIntervalInBackground: false/g)).toHaveLength(2);
  });
});
