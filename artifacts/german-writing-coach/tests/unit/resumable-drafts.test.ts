import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicAppError } from "@/lib/appError";

const { getSupabaseClient } = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("@/lib/supabaseClient", () => ({ getSupabaseClient }));

import {
  getWritingDraft,
  getWritingDraftByContext,
  listMyWritingDrafts,
  saveWritingDraft,
  submitWritingDraft,
} from "@/services/submissionService";
import {
  getPracticeDraft,
  savePracticeDraft,
  submitPracticeAttempt,
} from "@/services/practiceWorksheetService";
import { SerializedSaveQueue } from "@/services/serializedSaveQueue";
import { serializePracticeAnswers } from "@/pages/student/worksheet";

const savedAt = "2026-07-10T12:00:00.000Z";

function assignmentSummary() {
  return {
    id: "assignment-1",
    workspace_id: "workspace-1",
    student_id: "student-1",
    grammar_topic_id: "topic-1",
    grammar_topic_name: "Word order",
    grammar_topic_slug: "word-order",
    grammar_topic_description: null,
    practice_test_id: "test-1",
    worksheet_title: "Word order",
    worksheet_level: "A2",
    worksheet_difficulty: "standard",
    worksheet_mini_lesson: null,
    status: "completed",
    source: "adaptive",
    assigned_at: savedAt,
    started_at: savedAt,
    completed_at: savedAt,
    latest_attempt_id: "attempt-1",
    latest_attempt_status: "checked",
    score: 1,
    max_score: 1,
    score_points: 1,
    max_score_points: 1,
    scoring_version: "v1",
    evaluation_status: "not_needed",
    evaluation_started_at: null,
    evaluation_completed_at: savedAt,
    evaluation_error: null,
    score_percent: 100,
    passed: true,
    question_count: 1,
    generation_status: "ready",
    generation_started_at: null,
    generation_completed_at: savedAt,
    generation_error: null,
    previous_assignment_id: null,
    previous_attempt_id: null,
    repeat_number: 0,
    adaptive_reason: null,
    adaptive_status: "mastered",
    resolution_cycle_id: "cycle-1",
    resolution_cycle_number: 1,
    evidence_cutoff_sequence: 1,
  };
}

describe("revision-safe writing drafts", () => {
  beforeEach(() => {
    getSupabaseClient.mockReset();
  });

  it("round-trips exact text and passes the optimistic revision to save", async () => {
    const exactText = "  e\u0301 🙂\r\n\r\nIch  lerne Deutsch.  ";
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "save_writing_draft") {
        return {
          data: [
            {
              saved_draft_id: "draft-1",
              workspace_id: "workspace-1",
              saved_revision: 3,
              saved_at: savedAt,
            },
          ],
          error: null,
        };
      }
      if (name === "get_writing_draft") {
        return {
          data: [
            {
              draft_id: "draft-1",
              workspace_id: "workspace-1",
              batch_id: "batch-1",
              source_type: "free_text",
              source_id: null,
              text: exactText,
              revision: 3,
              updated_at: savedAt,
            },
          ],
          error: null,
        };
      }
      if (name === "get_writing_draft_by_context") {
        return {
          data: [
            {
              draft_id: "draft-1",
              workspace_id: "workspace-1",
              batch_id: "batch-1",
              source_type: "free_text",
              source_id: null,
              text: exactText,
              revision: 3,
              updated_at: savedAt,
            },
          ],
          error: null,
        };
      }
      throw new Error(`unexpected ${name}`);
    });
    getSupabaseClient.mockReturnValue({ rpc, functions: { invoke: vi.fn() } });

    await expect(
      saveWritingDraft({
        draftId: "draft-1",
        expectedRevision: 2,
        questionSource: "free_text",
        questionId: null,
        batchId: "batch-1",
        answerText: exactText,
      }),
    ).resolves.toMatchObject({ draft_id: "draft-1", revision: 3 });
    await expect(getWritingDraft("draft-1")).resolves.toMatchObject({
      text: exactText,
    });
    await expect(
      getWritingDraftByContext("workspace-1", "batch-1", "free_text", null),
    ).resolves.toMatchObject({
      draft_id: "draft-1",
      text: exactText,
      revision: 3,
    });

    expect(rpc).toHaveBeenCalledWith("save_writing_draft", {
      draft_id: "draft-1",
      batch_id: "batch-1",
      source_type: "free_text",
      source_id: null,
      text: exactText,
      expected_revision: 2,
    });
    expect(rpc).toHaveBeenCalledWith("get_writing_draft_by_context", {
      target_workspace_id: "workspace-1",
      target_batch_id: "batch-1",
      target_source_type: "free_text",
      target_source_id: null,
    });
  });

  it("lists resumable contexts without any table query", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          draft_id: "draft-1",
          batch_id: "batch-1",
          source_type: "workspace_question",
          source_id: "question-1",
          preview: "Ich lerne…",
          character_count: 18,
          revision: 4,
          updated_at: savedAt,
        },
      ],
      error: null,
    });
    getSupabaseClient.mockReturnValue({ rpc, functions: { invoke: vi.fn() } });

    await expect(listMyWritingDrafts("workspace-1", 50)).resolves.toHaveLength(
      1,
    );
    expect(rpc).toHaveBeenCalledWith("list_my_writing_drafts", {
      target_workspace_id: "workspace-1",
      page_size: 50,
    });
  });

  it("submits only a locked draft revision, then kicks the durable processor", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ data: { accepted: true }, error: null });
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          submission_id: "submission-1",
          evaluation_status: "queued",
          release_status: "held",
          release_at: null,
        },
      ],
      error: null,
    });
    getSupabaseClient.mockReturnValue({ rpc, functions: { invoke } });

    await expect(submitWritingDraft("draft-1", 7)).resolves.toMatchObject({
      submission_id: "submission-1",
      evaluation_status: "queued",
    });
    expect(rpc).toHaveBeenCalledWith("submit_writing_draft", {
      target_draft_id: "draft-1",
      expected_revision: 7,
    });
    expect(invoke).toHaveBeenCalledWith("kick-writing-jobs", { body: {} });
  });

  it("does not kick the processor when draft submission reaches a quota", async () => {
    const invoke = vi.fn();
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "PT429", message: "writing_daily_quota_exceeded" },
    });
    getSupabaseClient.mockReturnValue({ rpc, functions: { invoke } });

    await expect(submitWritingDraft("draft-1", 7)).rejects.toMatchObject({
      code: "data_rate_limited",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("maps API PT412 to a safe conflict without retrying stale data", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "PT412", message: "private revision details" },
    });
    getSupabaseClient.mockReturnValue({ rpc, functions: { invoke: vi.fn() } });

    const error = await saveWritingDraft({
      draftId: "draft-1",
      expectedRevision: 2,
      questionSource: "free_text",
      questionId: null,
      batchId: "batch-1",
      answerText: "Local text",
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(PublicAppError);
    expect(error.code).toBe("data_conflict");
    expect(error.message).not.toContain("private revision details");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("revision-safe worksheet drafts", () => {
  beforeEach(() => {
    getSupabaseClient.mockReset();
  });

  it("restores exact answers and saves against the returned revision", async () => {
    const exactAnswer = "  Weil ich Zeit habe.\r\nNoch ein Satz.  ";
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "get_practice_draft") {
        return {
          data: [
            {
              draft_id: "practice-draft-1",
              assignment_id: "assignment-1",
              revision: 5,
              answers: [{ question_id: "question-1", answer: exactAnswer }],
              updated_at: savedAt,
            },
          ],
          error: null,
        };
      }
      if (name === "save_practice_draft") {
        return {
          data: [
            {
              draft_id: "practice-draft-1",
              assignment_id: "assignment-1",
              saved_revision: 6,
              answers: args.submitted_answers,
              saved_at: savedAt,
            },
          ],
          error: null,
        };
      }
      throw new Error(`unexpected ${name}`);
    });
    getSupabaseClient.mockReturnValue({ rpc, functions: { invoke: vi.fn() } });

    await expect(getPracticeDraft("assignment-1")).resolves.toMatchObject({
      revision: 5,
      answers: [{ question_id: "question-1", answer: exactAnswer }],
    });
    await expect(
      savePracticeDraft(
        "assignment-1",
        [{ question_id: "question-1", answer: exactAnswer }],
        5,
      ),
    ).resolves.toMatchObject({ revision: 6 });

    expect(rpc).toHaveBeenCalledWith("save_practice_draft", {
      target_assignment_id: "assignment-1",
      submitted_answers: [{ question_id: "question-1", answer: exactAnswer }],
      expected_revision: 5,
    });
  });

  it("serializes every question deterministically without trimming answers", () => {
    const exact = "  Antwort\r\nmit Abstand  ";
    const serialized = serializePracticeAnswers(
      [
        {
          id: "question-2",
          question_number: 2,
          question_type: "short_answer",
          prompt: "2",
          options: [],
        },
        {
          id: "question-1",
          question_number: 1,
          question_type: "short_answer",
          prompt: "1",
          options: [],
        },
      ],
      {
        "question-1": exact,
        "question-2": "",
      },
    );

    expect(serialized).toEqual([
      { question_id: "question-1", answer: exact },
      { question_id: "question-2", answer: "" },
    ]);
  });

  it("submits the locked revision rather than a stale browser answer payload", async () => {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "submit_practice_attempt") {
        return {
          data: assignmentSummary(),
          error: null,
        };
      }
      throw new Error(`unexpected ${name}`);
    });
    getSupabaseClient.mockReturnValue({ rpc, functions: { invoke: vi.fn() } });

    await expect(
      submitPracticeAttempt("assignment-1", 9),
    ).resolves.toMatchObject({
      id: "assignment-1",
      status: "completed",
    });
    expect(rpc).toHaveBeenCalledWith("submit_practice_attempt", {
      target_assignment_id: "assignment-1",
      expected_revision: 9,
    });
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("submitted_answers");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("serialized autosave queue", () => {
  it("does not start a later revision save until the earlier one settles", async () => {
    const queue = new SerializedSaveQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
      return 1;
    });
    const second = queue.enqueue(async () => {
      order.push("second:start");
      return 2;
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("allows an explicit recovery save after a failed revision", async () => {
    const queue = new SerializedSaveQueue();
    await expect(
      queue.enqueue(async () => {
        throw new Error("conflict");
      }),
    ).rejects.toThrow("conflict");
    await expect(queue.enqueue(async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });
});

describe("student autosave UI contract", () => {
  it("exposes testable Saving, Saved, Conflict, and Error states", () => {
    const writingPage = readFileSync(
      path.resolve(process.cwd(), "src/pages/student/write.tsx"),
      "utf8",
    );
    const worksheetPage = readFileSync(
      path.resolve(process.cwd(), "src/pages/student/worksheet.tsx"),
      "utf8",
    );

    for (const source of [writingPage, worksheetPage]) {
      expect(source).toContain('"saving"');
      expect(source).toContain('"saved"');
      expect(source).toContain('"conflict"');
      expect(source).toContain('"error"');
    }
    expect(writingPage).toContain('data-testid="writing-draft-status"');
    expect(writingPage).toContain("Save Draft");
    expect(writingPage).toContain("Checking for a saved draft…");
    expect(writingPage).toContain("getWritingDraftByContext(");
    expect(writingPage).not.toContain("listMyWritingDrafts");
    expect(writingPage).toContain("draft.source_type !== questionSource");
    expect(worksheetPage).toContain('data-testid="practice-draft-status"');
    expect(worksheetPage).toContain("Reload saved answers");
    for (const source of [writingPage, worksheetPage]) {
      expect(source).toContain('addEventListener("visibilitychange"');
      expect(source).toContain('addEventListener("pagehide"');
      expect(source).toContain('addEventListener("beforeunload"');
      expect(source).toContain('event.returnValue = ""');
    }
  });
});
