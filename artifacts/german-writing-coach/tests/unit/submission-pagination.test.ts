import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSupabaseClient } = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("@/lib/supabaseClient", () => ({ getSupabaseClient }));

import {
  getStudentSubmissionDetail,
  getTeacherSubmissionDetail,
  listStudentSubmissionsPage,
  listTeacherWorkspaceSubmissionsPage,
} from "@/services/submissionService";

const serviceSource = readFileSync(
  path.resolve(process.cwd(), "src/services/submissionService.ts"),
  "utf8",
);
const hookSource = readFileSync(
  path.resolve(process.cwd(), "src/hooks/use-live-submission.ts"),
  "utf8",
);
const teacherPageSource = readFileSync(
  path.resolve(process.cwd(), "src/pages/teacher/submissions.tsx"),
  "utf8",
);
const historySource = readFileSync(
  path.resolve(process.cwd(), "src/pages/student/history.tsx"),
  "utf8",
);

const timestamp = "2026-07-10T08:00:00.000Z";

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "submission-1",
    workspace_id: "workspace-1",
    student_id: "student-1",
    batch_id: "batch-1",
    question_id: "question-1",
    global_question_id: null,
    question_source: "workspace_question",
    mode: "predefined_question",
    status: "submitted",
    evaluation_status: "queued",
    release_status: "held",
    release_at: null,
    feedback_mode: "immediate",
    feedback_scheduled_at: null,
    feedback_error_code: null,
    created_at: timestamp,
    updated_at: timestamp,
    original_text_excerpt: "Ich lerne Deutsch.",
    original_character_count: 19,
    question_title: "Mein Alltag",
    question_level: "A2",
    question_topic: "Alltag",
    question_source_label: "Workspace writing task",
    batch_name: "A2 Morning",
    batch_level: "A2",
    student_name: "Learner",
    student_email: "learner@example.test",
    ...overrides,
  };
}

function pagePayload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    items: [listItem()],
    total_count: 2,
    returned_count: 1,
    page_size: 1,
    has_more: true,
    next_cursor: { created_at: timestamp, id: "submission-1" },
    ...overrides,
  };
}

function detailPayload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    submission: {
      ...listItem(),
      original_text: "Ich lerne Deutsch.",
      corrected_text: "Ich lerne Deutsch.",
      overall_summary: "Gut gemacht.",
      level_detected: "A2",
      evaluation_version: 2,
      feedback_started_at: timestamp,
      feedback_completed_at: timestamp,
      checked_at: timestamp,
      ...overrides,
    },
    feedback: {
      lines: [{
        id: "line-1",
        line_number: 1,
        original_line: "Ich lerne Deutsch.",
        corrected_line: "Ich lerne Deutsch.",
        status: "correct",
        changed_parts: [],
        short_explanation: null,
        detailed_explanation: null,
        grammar_topic: { id: "topic-1", name: "Verbposition", slug: "verbposition" },
      }],
      grammar_topics: [{
        id: "summary-1",
        grammar_topic_id: "topic-1",
        topic_name: "Verbposition",
        topic_slug: "verbposition",
        count: 1,
        severity: "minor",
        simple_explanation: "Das Verb steht an Position zwei.",
      }],
    },
  };
}

function createMockClient(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  const schema = vi.fn(() => ({ rpc }));
  const from = vi.fn(() => {
    throw new Error("Submission reads must not use exposed tables.");
  });
  return { client: { schema, from }, schema, rpc, from };
}

describe("submission read-model pagination", () => {
  beforeEach(() => {
    getSupabaseClient.mockReset();
  });

  it("sends teacher filters and the keyset cursor to the api schema", async () => {
    const mocks = createMockClient({ data: pagePayload(), error: null });
    getSupabaseClient.mockReturnValue(mocks.client);

    const page = await listTeacherWorkspaceSubmissionsPage({
      workspaceId: "workspace-1",
      studentId: "student-1",
      batchId: "batch-1",
      evaluationStatus: "processing",
      releaseStatus: "held",
      pageSize: 1,
      cursor: { created_at: "2026-07-10T09:00:00.000Z", id: "cursor-id" },
    });

    expect(mocks.schema).toHaveBeenCalledWith("api");
    expect(mocks.rpc).toHaveBeenCalledWith("list_workspace_submissions_page", {
      target_workspace_id: "workspace-1",
      target_student_id: "student-1",
      target_batch_id: "batch-1",
      target_evaluation_status: "processing",
      target_release_status: "held",
      requested_page_size: 1,
      cursor_created_at: "2026-07-10T09:00:00.000Z",
      cursor_id: "cursor-id",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(page).toMatchObject({ total_count: 2, returned_count: 1, has_more: true });
    expect(page.next_cursor).toEqual({ created_at: timestamp, id: "submission-1" });
    expect(page.items[0]).toMatchObject({
      original_text: "Ich lerne Deutsch.",
      corrected_text: null,
      student_name: "Learner",
    });
  });

  it("requires explicit student workspace context and uses the student RPC", async () => {
    const mocks = createMockClient({
      data: pagePayload({ page_size: 20, has_more: false, next_cursor: null }),
      error: null,
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    await listStudentSubmissionsPage({
      workspaceId: "workspace-1",
      studentId: "student-1",
      batchId: "batch-1",
      pageSize: 20,
    });

    expect(mocks.rpc).toHaveBeenCalledWith("list_student_submissions_page", {
      target_workspace_id: "workspace-1",
      target_student_id: "student-1",
      target_batch_id: "batch-1",
      target_evaluation_status: null,
      target_release_status: null,
      requested_page_size: 20,
      cursor_created_at: null,
      cursor_id: null,
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects a malformed cursor page instead of guessing the next page", async () => {
    const mocks = createMockClient({
      data: pagePayload({ has_more: true, next_cursor: null }),
      error: null,
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    await expect(listTeacherWorkspaceSubmissionsPage({ workspaceId: "workspace-1" }))
      .rejects.toThrow("Submission data could not be loaded safely");
  });

  it("rejects oversized page requests instead of silently truncating them", async () => {
    const mocks = createMockClient({ data: pagePayload(), error: null });
    getSupabaseClient.mockReturnValue(mocks.client);

    await expect(listTeacherWorkspaceSubmissionsPage({
      workspaceId: "workspace-1",
      pageSize: 101,
    })).rejects.toThrow("Page size must be between 1 and 100.");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps database authorization failures to stable user-safe text", async () => {
    const mocks = createMockClient({
      data: null,
      error: { code: "42501", message: "private_table secret SQL detail" },
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    await expect(listTeacherWorkspaceSubmissionsPage({ workspaceId: "workspace-1" }))
      .rejects.toThrow("You do not have access to this submission.");
    await expect(listTeacherWorkspaceSubmissionsPage({ workspaceId: "workspace-1" }))
      .rejects.not.toThrow(/private_table|SQL detail/);
  });
});

describe("single-call submission detail privacy", () => {
  beforeEach(() => {
    getSupabaseClient.mockReset();
  });

  it("does not parse an unreleased feedback envelope as released feedback", async () => {
    const payload = detailPayload({
      evaluation_status: "needs_review",
      release_status: "held",
    });
    payload.feedback = { lines: [], grammar_topics: [] };
    const mocks = createMockClient({
      data: payload,
      error: null,
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    const detail = await getTeacherSubmissionDetail("workspace-1", "submission-1");

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("get_submission_detail", {
      target_submission_id: "submission-1",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(detail?.submission.status).toBe("needs_review");
    expect(detail?.submission.corrected_text).toBeNull();
    expect(detail?.feedback).toBeNull();
  });

  it("parses teacher feedback after the release state is confirmed", async () => {
    const mocks = createMockClient({
      data: detailPayload({
        status: "checked",
        evaluation_status: "ready",
        release_status: "released",
      }),
      error: null,
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    const detail = await getTeacherSubmissionDetail("workspace-1", "submission-1");

    expect(detail?.submission.status).toBe("checked");
    expect(detail?.submission.corrected_text).toBe("Ich lerne Deutsch.");
    expect(detail?.feedback?.lines[0].grammar_topic).toBe("Verbposition");
  });

  it("strips child feedback in a student client unless release is confirmed", async () => {
    const mocks = createMockClient({
      data: detailPayload({ evaluation_status: "ready", release_status: "held" }),
      error: null,
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    const detail = await getStudentSubmissionDetail("submission-1", "student-1", "workspace-1");

    expect(detail?.feedback).toBeNull();
    expect(detail?.submission.corrected_text).toBeNull();
    expect(detail?.submission.overall_summary).toBeNull();
    expect(detail?.submission.status).toBe("submitted");
  });

  it("rejects detail data outside the student's active workspace context", async () => {
    const mocks = createMockClient({ data: detailPayload(), error: null });
    getSupabaseClient.mockReturnValue(mocks.client);

    await expect(getStudentSubmissionDetail(
      "submission-1",
      "student-1",
      "different-workspace",
    )).resolves.toBeNull();
  });
});

describe("submission page integration contract", () => {
  it("contains no legacy public-table submission hydration path", () => {
    expect(serviceSource).not.toContain('.from("submissions")');
    expect(serviceSource).not.toContain('.from("submission_lines")');
    expect(serviceSource).not.toContain('.from("submission_grammar_topics")');
    expect(serviceSource).not.toContain("hydrateSubmissions");
    expect(hookSource).not.toContain("getSubmissionFeedback");
  });

  it("keeps a cursor trail for explicit next and previous navigation", () => {
    for (const source of [teacherPageSource, historySource]) {
      expect(source).toContain("cursorTrail");
      expect(source).toContain("next_cursor");
      expect(source).toContain("current.slice(0, -1)");
    }
  });
});
