import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callApiRpc: vi.fn() }));

vi.mock("@/services/apiFacade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/apiFacade")>();
  return { ...actual, callApiRpc: mocks.callApiRpc };
});

import {
  listWorkspaceJoinRequestsFilteredPage,
  listWorkspaceStudentsFilteredPage,
} from "@/services/studentService";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";
const cursorId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-07-10T12:00:00.000Z";

describe("server-filtered teacher roster", () => {
  beforeEach(() => mocks.callApiRpc.mockReset());

  it("applies search, class, and level before requesting a bounded roster page", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [{
        id: "44444444-4444-4444-8444-444444444444",
        name: "Anna Beispiel",
        email: "anna@example.test",
        membership_id: cursorId,
        batches: [{
          id: "55555555-5555-4555-8555-555555555555",
          workspace_id: workspaceId,
          batch_id: batchId,
          batch_name: "A2 Class",
          level: "A2",
        }],
        total_submissions: 7,
        last_active_at: timestamp,
        weak_topics: [{
          id: "66666666-6666-4666-8666-666666666666",
          workspace_id: workspaceId,
          student_id: "44444444-4444-4444-8444-444444444444",
          grammar_topic_id: "77777777-7777-4777-8777-777777777777",
          topic_name: "Word order",
          topic_slug: "word-order",
          topic_description: null,
          total_minor_issues: 2,
          total_major_issues: 3,
          total_correct_after_practice: 0,
          weakness_level: "unlocked",
          practice_unlocked: true,
          last_seen_at: timestamp,
          updated_at: timestamp,
          active_practice: null,
        }],
      }],
      total_count: 26,
      returned_count: 1,
      page_size: 25,
      has_more: true,
      next_cursor: { created_at: timestamp, id: cursorId },
    });

    const page = await listWorkspaceStudentsFilteredPage({
      workspaceId,
      search: "  ANNA  ",
      batchId,
      level: "A2",
      pageSize: 25,
    });

    expect(page).toMatchObject({
      total_count: 26,
      has_more: true,
      items: [{
        name: "Anna Beispiel",
        last_active: expect.any(String),
        weak_topics: [{ topic_slug: "word-order" }],
      }],
    });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "list_workspace_students_filtered_page",
      {
        target_workspace_id: workspaceId,
        search_query: "ANNA",
        target_batch_id: batchId,
        target_level: "A2",
        requested_page_size: 25,
        cursor_created_at: null,
        cursor_membership_id: null,
      },
      expect.any(String),
    );
  });

  it("loads only pending join requests and carries an opaque keyset cursor", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [{
        id: cursorId,
        workspace_id: workspaceId,
        batch_id: batchId,
        student_id: "44444444-4444-4444-8444-444444444444",
        status: "pending",
        requested_at: timestamp,
        decided_at: null,
        decided_by: null,
        student_name: "Anna Beispiel",
        student_email: "anna@example.test",
        batch_name: "A2 Class",
        batch_level: "A2",
      }],
      total_count: 11,
      returned_count: 1,
      page_size: 10,
      has_more: true,
      next_cursor: { requested_at: timestamp, id: cursorId },
    });

    const page = await listWorkspaceJoinRequestsFilteredPage({
      workspaceId,
      status: "pending",
      search: "anna",
      pageSize: 10,
    });

    expect(page.next_cursor).toEqual({ requested_at: timestamp, id: cursorId });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "list_workspace_join_requests_filtered_page",
      expect.objectContaining({
        target_workspace_id: workspaceId,
        target_status: "pending",
        search_query: "anna",
        requested_page_size: 10,
      }),
      expect.any(String),
    );
  });

  it("keeps real roster filtering and pagination in the database contract", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/pages/teacher/students.tsx"),
      "utf8",
    );
    expect(source).toContain("listWorkspaceStudentsFilteredPage");
    expect(source).toContain("listWorkspaceJoinRequestsFilteredPage");
    expect(source).toContain("workspaceStudentsPage");
    expect(source).toContain("workspaceJoinRequestsPage");
    expect(source).toContain("matching students");
    expect(source).toContain("pending requests");
    expect(source).toContain("setStudentCursorTrail");
    expect(source).toContain("setJoinCursorTrail");
    expect(source).toContain("student.weak_topics");
    expect(source).not.toContain("listWorkspaceGrammarStats");
    expect(source).not.toContain("listWorkspacePracticeAssignments");
    expect(source).toContain("refetchInterval: 15_000");
  });
});
