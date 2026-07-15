import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callApiRpc: vi.fn(),
}));

vi.mock("@/services/apiFacade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/apiFacade")>();
  return { ...actual, callApiRpc: mocks.callApiRpc };
});

import {
  getWeaknessStateDescription,
  listStudentGrammarStats,
  listWorkspaceGrammarStats,
  STUDENT_GRAMMAR_STATS_PAGE_SIZE,
  WORKSPACE_GRAMMAR_STATS_PAGE_SIZE,
  type StudentGrammarStat,
} from "@/services/grammarStatsService";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const studentId = "22222222-2222-4222-8222-222222222222";

function statId(ordinal: number) {
  return `33333333-3333-4333-8333-${String(ordinal).padStart(12, "0")}`;
}

function grammarStat(
  ordinal: number,
  overrides: Partial<StudentGrammarStat> = {},
): StudentGrammarStat {
  return {
    id: statId(ordinal),
    workspace_id: workspaceId,
    student_id: studentId,
    grammar_topic_id: `44444444-4444-4444-8444-${String(ordinal).padStart(12, "0")}`,
    topic_name: `Topic ${ordinal}`,
    topic_slug: `topic-${ordinal}`,
    topic_description: null,
    total_minor_issues: 1,
    total_major_issues: 3,
    total_correct_after_practice: 0,
    weakness_level: "unlocked",
    practice_unlocked: true,
    resolution_cycle_id: null,
    resolution_cycle_number: 1,
    resolved_through_sequence: 0,
    mastery_pass_count: 0,
    state_reason: "threshold_reached",
    last_seen_at: "2026-07-10T08:00:00.000Z",
    updated_at: "2026-07-10T08:00:00.000Z",
    ...overrides,
  };
}

function cursorFor(stat: StudentGrammarStat) {
  return {
    practice_unlocked: stat.practice_unlocked,
    total_major_issues: stat.total_major_issues,
    total_minor_issues: stat.total_minor_issues,
    id: stat.id,
  };
}

function page(
  items: StudentGrammarStat[],
  totalCount: number,
  pageSize: number,
  hasMore: boolean,
) {
  return {
    schema_version: 1,
    items,
    total_count: totalCount,
    returned_count: items.length,
    page_size: pageSize,
    has_more: hasMore,
    next_cursor: hasMore ? cursorFor(items.at(-1)!) : null,
  };
}

describe("locked practice explanations", () => {
  it.each([
    [
      "level_fit_approval_required",
      "matching this advanced topic",
    ],
    [
      "active_class_context_required",
      "class that is no longer active",
    ],
    [
      "teacher_support_required",
      "Your teacher can review",
    ],
  ])("explains %s without claiming the evidence threshold is missing", (reason, expected) => {
    const description = getWeaknessStateDescription(grammarStat(1, {
      weakness_level: "locked",
      practice_unlocked: false,
      state_reason: reason,
    }));

    expect(description).toContain(expected);
    expect(description).not.toContain("Keep writing to build enough evidence");
  });

  it("makes one released minor issue visibly available without threshold copy", () => {
    const description = getWeaknessStateDescription(grammarStat(1, {
      total_major_issues: 0,
      total_minor_issues: 1,
      weakness_level: "unlocked",
      practice_unlocked: true,
    }));

    expect(description).toContain("identified this focus area");
    expect(description).toContain("available for practice");
    expect(description).not.toMatch(/three minor|threshold/i);
  });
});

describe("complete grammar-stat traversal", () => {
  beforeEach(() => {
    mocks.callApiRpc.mockReset();
  });

  it("loads every student focus area beyond the former first-page cap", async () => {
    const allStats = Array.from(
      { length: STUDENT_GRAMMAR_STATS_PAGE_SIZE + 1 },
      (_, index) => grammarStat(index + 1),
    );
    mocks.callApiRpc
      .mockResolvedValueOnce(page(
        allStats.slice(0, STUDENT_GRAMMAR_STATS_PAGE_SIZE),
        allStats.length,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE,
        true,
      ))
      .mockResolvedValueOnce(page(
        allStats.slice(STUDENT_GRAMMAR_STATS_PAGE_SIZE),
        allStats.length,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE,
        false,
      ));

    await expect(listStudentGrammarStats(workspaceId, studentId)).resolves.toEqual(allStats);
    expect(mocks.callApiRpc).toHaveBeenCalledTimes(2);
    expect(mocks.callApiRpc).toHaveBeenNthCalledWith(
      1,
      "list_student_grammar_stats_page",
      {
        target_workspace_id: workspaceId,
        target_student_id: studentId,
        requested_page_size: STUDENT_GRAMMAR_STATS_PAGE_SIZE,
        cursor_practice_unlocked: null,
        cursor_total_major_issues: null,
        cursor_total_minor_issues: null,
        cursor_stat_id: null,
      },
      expect.any(String),
    );
    expect(mocks.callApiRpc).toHaveBeenNthCalledWith(
      2,
      "list_student_grammar_stats_page",
      expect.objectContaining({
        target_workspace_id: workspaceId,
        target_student_id: studentId,
        cursor_stat_id: allStats[STUDENT_GRAMMAR_STATS_PAGE_SIZE - 1].id,
      }),
      expect.any(String),
    );
  });

  it("loads workspace focus areas beyond the former 80-row teacher cap", async () => {
    const allStats = Array.from(
      { length: WORKSPACE_GRAMMAR_STATS_PAGE_SIZE + 1 },
      (_, index) => grammarStat(index + 1),
    );
    mocks.callApiRpc
      .mockResolvedValueOnce(page(
        allStats.slice(0, WORKSPACE_GRAMMAR_STATS_PAGE_SIZE),
        allStats.length,
        WORKSPACE_GRAMMAR_STATS_PAGE_SIZE,
        true,
      ))
      .mockResolvedValueOnce(page(
        allStats.slice(WORKSPACE_GRAMMAR_STATS_PAGE_SIZE),
        allStats.length,
        WORKSPACE_GRAMMAR_STATS_PAGE_SIZE,
        false,
      ));

    const result = await listWorkspaceGrammarStats(workspaceId);

    expect(result).toHaveLength(WORKSPACE_GRAMMAR_STATS_PAGE_SIZE + 1);
    expect(result.at(-1)?.id).toBe(allStats.at(-1)?.id);
    expect(mocks.callApiRpc).toHaveBeenNthCalledWith(
      2,
      "list_workspace_grammar_stats_keyset_page",
      expect.objectContaining({
        target_workspace_id: workspaceId,
        cursor_stat_id: allStats[WORKSPACE_GRAMMAR_STATS_PAGE_SIZE - 1].id,
      }),
      expect.any(String),
    );
  });

  it("retries one complete traversal when exact counts change between pages", async () => {
    const allStats = Array.from(
      { length: STUDENT_GRAMMAR_STATS_PAGE_SIZE + 1 },
      (_, index) => grammarStat(index + 1),
    );
    const firstPage = page(
      allStats.slice(0, STUDENT_GRAMMAR_STATS_PAGE_SIZE),
      allStats.length,
      STUDENT_GRAMMAR_STATS_PAGE_SIZE,
      true,
    );
    mocks.callApiRpc
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(page(
        allStats.slice(STUDENT_GRAMMAR_STATS_PAGE_SIZE),
        allStats.length + 1,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE,
        false,
      ))
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(page(
        allStats.slice(STUDENT_GRAMMAR_STATS_PAGE_SIZE),
        allStats.length,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE,
        false,
      ));

    await expect(listStudentGrammarStats(workspaceId, studentId)).resolves.toEqual(allStats);
    expect(mocks.callApiRpc).toHaveBeenCalledTimes(4);
    expect(mocks.callApiRpc.mock.calls[2]?.[1]).toMatchObject({
      cursor_stat_id: null,
      target_workspace_id: workspaceId,
      target_student_id: studentId,
    });
  });

  it("fails safely instead of looping when a server repeats a keyset cursor", async () => {
    const firstItems = Array.from(
      { length: STUDENT_GRAMMAR_STATS_PAGE_SIZE },
      (_, index) => grammarStat(index + 1),
    );
    const secondItems = Array.from(
      { length: STUDENT_GRAMMAR_STATS_PAGE_SIZE },
      (_, index) => grammarStat(index + STUDENT_GRAMMAR_STATS_PAGE_SIZE + 1),
    );
    const repeatedCursorPage = {
      ...page(
        secondItems,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE * 3,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE,
        true,
      ),
      next_cursor: cursorFor(firstItems.at(-1)!),
    };
    mocks.callApiRpc
      .mockResolvedValueOnce(page(
        firstItems,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE * 3,
        STUDENT_GRAMMAR_STATS_PAGE_SIZE,
        true,
      ))
      .mockResolvedValueOnce(repeatedCursorPage);

    await expect(listStudentGrammarStats(workspaceId, studentId)).rejects.toMatchObject({
      code: "data_invalid_response",
    });
    expect(mocks.callApiRpc).toHaveBeenCalledTimes(2);
  });

  it("rejects a cross-workspace row instead of attaching it to the active class", async () => {
    mocks.callApiRpc.mockResolvedValue(page(
      [grammarStat(1, { workspace_id: "99999999-9999-4999-8999-999999999999" })],
      1,
      STUDENT_GRAMMAR_STATS_PAGE_SIZE,
      false,
    ));

    await expect(listStudentGrammarStats(workspaceId, studentId)).rejects.toMatchObject({
      code: "data_invalid_response",
    });
    expect(mocks.callApiRpc).toHaveBeenCalledTimes(1);
  });

  it("contains no caller-side 6, 8, 12, 40, or 80-row grammar cap", () => {
    const sources = [
      "src/services/grammarStatsService.ts",
      "src/lib/dashboardQueries.ts",
      "src/pages/student/practice.tsx",
      "src/pages/teacher/students.tsx",
    ].map((relativePath) => readFileSync(path.resolve(process.cwd(), relativePath), "utf8"));

    expect(sources.join("\n")).not.toMatch(
      /list(?:Student|Workspace)GrammarStats\([^)]*,\s*(?:6|8|12|40|80)\s*\)/,
    );
  });
});
