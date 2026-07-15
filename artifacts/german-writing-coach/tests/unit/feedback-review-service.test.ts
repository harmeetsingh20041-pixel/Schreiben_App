import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ callApiRpc: vi.fn() }));

vi.mock("@/services/apiFacade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/apiFacade")>()),
  callApiRpc: mocks.callApiRpc,
}));

import {
  buildTeacherChangedParts,
  listFeedbackReviewQueuePage,
  prepareFeedbackDraftContentForSave,
  updateFeedbackDraft,
  type FeedbackDraftContent,
} from "@/services/feedbackReviewService";

beforeEach(() => mocks.callApiRpc.mockReset());

function draftContent(): FeedbackDraftContent {
  return {
    overall_summary: "Review the missing preposition.",
    level_detected: "A2",
    corrected_text: "stale",
    ai_model: "fixture",
    lines: [
      {
        line_number: 1,
        source_start: 0,
        source_end: 16,
        original_line: "Ich gehe Schule.",
        corrected_line: "Ich gehe zur Schule.",
        status: "minor_issue",
        changed_parts: [],
        short_explanation: "Use zur before Schule.",
        detailed_explanation: "",
        grammar_topic: "prepositions",
      },
      {
        line_number: 2,
        source_start: 18,
        source_end: 35,
        original_line: "Danach lerne ich.",
        corrected_line: "Danach lerne ich.",
        status: "correct",
        changed_parts: [],
        short_explanation: "",
        detailed_explanation: "",
        grammar_topic: "",
      },
    ],
    grammar_topics: [],
    score_summary: {},
  };
}

describe("teacher feedback edit spans", () => {
  it("builds a lossless insertion span", () => {
    expect(
      buildTeacherChangedParts(
        "Ich gehe Schule.",
        "Ich gehe zur Schule.",
        0,
        "Missing preposition",
      ),
    ).toEqual([
      {
        from: "",
        to: "zur ",
        reason: "Missing preposition",
        grammar_topics: [],
        severity: null,
        source_start: 9,
        source_end: 9,
        corrected_start: 9,
        corrected_end: 13,
      },
    ]);
  });

  it("targets the correct repeated-word occurrence", () => {
    expect(
      buildTeacherChangedParts(
        "ich ich gehe heute",
        "ich gehe heute",
        12,
        "Repeated word",
      ),
    ).toEqual([
      expect.objectContaining({
        from: "ich ",
        to: "",
        source_start: 16,
        source_end: 20,
        corrected_start: 4,
        corrected_end: 4,
      }),
    ]);
  });

  it("preserves validated issue metadata only while the same exact edit remains", () => {
    const prior = [
      {
        from: "Schule",
        to: "zur Schule",
        reason: "Use a destination preposition.",
        grammar_topics: ["prepositions"],
        severity: "minor" as const,
        source_start: 9,
        source_end: 15,
        corrected_start: 9,
        corrected_end: 19,
      },
    ];
    expect(
      buildTeacherChangedParts(
        "Ich gehe Schule.",
        "Ich gehe zur Schule.",
        0,
        "Use a destination preposition.",
        prior,
      ),
    ).toEqual(prior);

    const changedAgain = buildTeacherChangedParts(
      "Ich gehe Schule.",
      "Ich fahre zur Schule.",
      0,
      "Teacher correction.",
      prior,
    );
    expect(changedAgain.some((part) => part.grammar_topics.length === 0)).toBe(
      true,
    );
  });

  it("preserves a teacher-edited reason when that exact span survives another text edit", () => {
    const initial = buildTeacherChangedParts(
      "Ich gehe Schule heute.",
      "Ich gehe zur Schule heute.",
      0,
      "Initial line explanation.",
    ).map((part) => ({
      ...part,
      reason: "Teacher-approved preposition reason.",
      grammar_topics: ["prepositions"],
      severity: "minor" as const,
    }));

    const changedAgain = buildTeacherChangedParts(
      "Ich gehe Schule heute.",
      "Ich gehe zur Schule morgen.",
      0,
      "Fallback line explanation.",
      initial,
    );

    expect(
      changedAgain.find((part) => part.to === "zur "),
    ).toMatchObject({
      reason: "Teacher-approved preposition reason.",
      grammar_topics: ["prepositions"],
      severity: "minor",
    });
    expect(
      changedAgain.find((part) => part.reason === "Fallback line explanation."),
    ).toMatchObject({
      reason: "Fallback line explanation.",
      grammar_topics: [],
      severity: null,
    });
  });

  it("uses Unicode code-point offsets instead of UTF-16 positions", () => {
    expect(buildTeacherChangedParts("🙂a", "🙂ä", 0, "Umlaut")).toEqual([
      expect.objectContaining({
        from: "a",
        to: "ä",
        source_start: 1,
        source_end: 2,
        corrected_start: 1,
        corrected_end: 2,
      }),
    ]);
  });

  it("builds one bounded teacher span for adversarial long corrections", () => {
    const original = "a ".repeat(6_000);
    const corrected = "b ".repeat(6_000);
    const startedAt = performance.now();
    const parts = buildTeacherChangedParts(
      original,
      corrected,
      10,
      "Teacher correction",
    );

    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      from: original.slice(0, -1),
      to: corrected.slice(0, -1),
      source_start: 10,
      source_end: 12_009,
      corrected_start: 0,
      corrected_end: 11_999,
    });
  });

  it("rebuilds corrected text while preserving paragraph separators", () => {
    const prepared = prepareFeedbackDraftContentForSave(
      "Ich gehe Schule.\n\nDanach lerne ich.",
      draftContent(),
    );

    expect(prepared.corrected_text).toBe(
      "Ich gehe zur Schule.\n\nDanach lerne ich.",
    );
    expect(prepared.lines[0].changed_parts).toEqual([
      expect.objectContaining({
        source_start: 9,
        source_end: 9,
        to: "zur ",
        grammar_topics: ["prepositions"],
        severity: "minor",
      }),
    ]);
    expect(prepared.lines[1].changed_parts).toEqual([]);
    expect(prepared.feedback_contract_version).toBe(2);
    expect(prepared.grammar_topics).toEqual([
      expect.objectContaining({
        topic: "prepositions",
        count: 1,
        minor_count: 1,
        major_count: 0,
      }),
    ]);
  });

  it("does not reuse a v2 line topic for newly edited correction spans", () => {
    const saved = prepareFeedbackDraftContentForSave(
      "Ich gehe Schule.\n\nDanach lerne ich.",
      draftContent(),
    );
    saved.lines[0].corrected_line = "Ich fahre zur Schule.";

    expect(() =>
      prepareFeedbackDraftContentForSave(
        "Ich gehe Schule.\n\nDanach lerne ich.",
        saved,
      ),
    ).toThrow("topics and severity for every correction span");
  });

  it("requires an unclear line to be classified before it can rewrite text", () => {
    const content = draftContent();
    content.lines[0] = {
      ...content.lines[0],
      status: "unclear",
      short_explanation: "The intended wording is uncertain.",
    };

    expect(() =>
      prepareFeedbackDraftContentForSave(
        "Ich gehe Schule.\n\nDanach lerne ich.",
        content,
      ),
    ).toThrow("classified as a minor or major issue");
  });

  it("forces positive lines back to the exact original", () => {
    const content = draftContent();
    content.lines[0] = {
      ...content.lines[0],
      corrected_line: "An unnecessary rewrite.",
      status: "correct",
      grammar_topic: "prepositions",
    };

    const prepared = prepareFeedbackDraftContentForSave(
      "Ich gehe Schule.\n\nDanach lerne ich.",
      content,
    );
    expect(prepared.lines[0].corrected_line).toBe("Ich gehe Schule.");
    expect(prepared.lines[0].grammar_topic).toBe("");
    expect(prepared.lines[0].changed_parts).toEqual([]);
  });

  it("rejects an issue without a real correction", () => {
    const content = draftContent();
    content.lines[0] = {
      ...content.lines[0],
      corrected_line: content.lines[0].original_line,
    };

    expect(() =>
      prepareFeedbackDraftContentForSave(
        "Ich gehe Schule.\n\nDanach lerne ich.",
        content,
      ),
    ).toThrow(
      "needs a correction, student-facing explanation, and topics and severity for every correction span",
    );
  });

  it("does not let a detailed note replace the required student-facing issue explanation", () => {
    const content = draftContent();
    content.lines[0] = {
      ...content.lines[0],
      short_explanation: "",
      detailed_explanation: "This internal detail is not student-facing.",
    };

    expect(() =>
      prepareFeedbackDraftContentForSave(
        "Ich gehe Schule.\n\nDanach lerne ich.",
        content,
      ),
    ).toThrow("student-facing explanation");
  });

  it("accepts exact feedback field limits and rejects each next Unicode character", () => {
    const source = "Ich gehe Schule.\n\nDanach lerne ich.";
    const exact = draftContent();
    exact.overall_summary = "🙂".repeat(8_000);
    exact.lines[0].short_explanation = "🙂".repeat(4_000);
    exact.lines[0].detailed_explanation = "🙂".repeat(8_000);
    expect(() =>
      prepareFeedbackDraftContentForSave(source, exact),
    ).not.toThrow();

    const longSummary = draftContent();
    longSummary.overall_summary = "🙂".repeat(8_001);
    expect(() =>
      prepareFeedbackDraftContentForSave(source, longSummary),
    ).toThrow("overall feedback summary");

    const longShort = draftContent();
    longShort.lines[0].short_explanation = "🙂".repeat(4_001);
    expect(() => prepareFeedbackDraftContentForSave(source, longShort)).toThrow(
      "student-facing explanation",
    );

    const longDetailed = draftContent();
    longDetailed.lines[0].detailed_explanation = "🙂".repeat(8_001);
    expect(() =>
      prepareFeedbackDraftContentForSave(source, longDetailed),
    ).toThrow("detailed explanation");

    const exactReason = prepareFeedbackDraftContentForSave(
      source,
      draftContent(),
    );
    exactReason.lines[0].changed_parts[0].reason = "🙂".repeat(4_000);
    expect(() =>
      prepareFeedbackDraftContentForSave(source, exactReason),
    ).not.toThrow();

    const longReason = structuredClone(exactReason);
    longReason.lines[0].changed_parts[0].reason = "🙂".repeat(4_001);
    expect(() =>
      prepareFeedbackDraftContentForSave(source, longReason),
    ).toThrow("bounded reason");
  });

  it("rejects more than six topics on one exact correction", () => {
    const source = "Ich gehe Schule.\n\nDanach lerne ich.";
    const content = prepareFeedbackDraftContentForSave(source, draftContent());
    content.lines[0].changed_parts[0].grammar_topics = [
      "articles",
      "dativ",
      "nominativ",
      "akkusativ",
      "genitiv",
      "prepositions",
      "word-order",
    ];

    expect(() => prepareFeedbackDraftContentForSave(source, content)).toThrow(
      "one to six topics per span",
    );
  });

  it("persists incomplete span metadata only in explicit private-draft mode", () => {
    const source = "Ich gehe Schule.\n\nDanach lerne ich.";
    const content = prepareFeedbackDraftContentForSave(source, draftContent());
    content.lines[0].status = "major_issue";
    content.lines[0].changed_parts[0] = {
      ...content.lines[0].changed_parts[0],
      reason: "",
      grammar_topics: [],
      severity: null,
    };

    const privateDraft = prepareFeedbackDraftContentForSave(
      source,
      content,
      "private_draft",
    );
    expect(privateDraft.lines[0].status).toBe("major_issue");
    expect(privateDraft.lines[0].changed_parts[0]).toMatchObject({
      reason: "",
      grammar_topics: [],
      severity: null,
    });
    expect(privateDraft.grammar_topics).toEqual([]);
    expect(() =>
      prepareFeedbackDraftContentForSave(source, privateDraft, "release"),
    ).toThrow("topics and severity for every correction span");
  });

  it("round-trips an incomplete v2 needs-review mutation without legacy inference", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      draft: {
        id: "draft-private-v2",
        submission_id: "submission-private-v2",
        version: 1,
        revision: 2,
        state: "needs_review",
        provider_model: "fixture",
        created_at: "2026-07-13T08:00:00.000Z",
        updated_at: "2026-07-13T08:01:00.000Z",
        approved_at: null,
        released_at: null,
        content: {
          feedback_contract_version: 2,
          overall_summary: "Private teacher working copy.",
          level_detected: "A2",
          corrected_text: "Ich gehe zur Schule.",
          ai_model: "fixture",
          grammar_topics: [],
          score_summary: {},
          lines: [
            {
              line_number: 1,
              source_start: 0,
              source_end: 16,
              original_line: "Ich gehe Schule.",
              corrected_line: "Ich gehe zur Schule.",
              status: "major_issue",
              changed_parts: [
                {
                  from: "",
                  to: "zur ",
                  reason: "",
                  grammar_topics: [],
                  severity: null,
                  source_start: 9,
                  source_end: 9,
                  corrected_start: 9,
                  corrected_end: 13,
                },
              ],
              short_explanation: "Use zur before Schule.",
              detailed_explanation: "",
              grammar_topic: "",
            },
          ],
        },
      },
    });

    const saved = await updateFeedbackDraft(
      "draft-private-v2",
      draftContent(),
      1,
    );

    expect(saved.state).toBe("needs_review");
    expect(saved.content.lines[0].status).toBe("major_issue");
    expect(saved.content.lines[0].changed_parts[0]).toMatchObject({
      reason: "",
      grammar_topics: [],
      severity: null,
    });
  });

  it("retains v1 line-topic and severity inference for legacy mutation responses", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      draft: {
        id: "draft-legacy-v1",
        submission_id: "submission-legacy-v1",
        version: 1,
        revision: 2,
        state: "needs_review",
        provider_model: "fixture",
        created_at: "2026-07-13T08:00:00.000Z",
        updated_at: "2026-07-13T08:01:00.000Z",
        approved_at: null,
        released_at: null,
        content: {
          overall_summary: "Legacy teacher working copy.",
          level_detected: "A2",
          corrected_text: "Ich gehe zur Schule.",
          grammar_topics: [],
          score_summary: {},
          lines: [
            {
              line_number: 1,
              source_start: 0,
              source_end: 16,
              original_line: "Ich gehe Schule.",
              corrected_line: "Ich gehe zur Schule.",
              status: "major_issue",
              changed_parts: [
                {
                  from: "",
                  to: "zur ",
                  reason: "Legacy reason.",
                  source_start: 9,
                  source_end: 9,
                  corrected_start: 9,
                  corrected_end: 13,
                },
              ],
              short_explanation: "Use zur before Schule.",
              detailed_explanation: "",
              grammar_topic: "prepositions",
            },
          ],
        },
      },
    });

    const saved = await updateFeedbackDraft(
      "draft-legacy-v1",
      draftContent(),
      1,
    );

    expect(saved.content.lines[0].changed_parts[0]).toMatchObject({
      grammar_topics: ["prepositions"],
      severity: "major",
    });
  });

  it("accepts a 4,000-character reconstructed correction and rejects 4,001", () => {
    const source = "Ich gehe Schule.\n\nDanach lerne ich.";
    const exact = draftContent();
    exact.lines[0].corrected_line = "x".repeat(3_981);
    expect(
      prepareFeedbackDraftContentForSave(source, exact).corrected_text,
    ).toHaveLength(4_000);

    const tooLong = draftContent();
    tooLong.lines[0].corrected_line = "x".repeat(3_982);
    expect(() => prepareFeedbackDraftContentForSave(source, tooLong)).toThrow(
      "corrected writing",
    );
  });

  it("blocks release in the teacher editor while an issue lacks its bounded student explanation", () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        "src/components/teacher-feedback-draft-editor.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("const hasIncompleteIssueLines");
    expect(source).toContain("!line.short_explanation.trim()");
    expect(source).toContain("part.grammar_topics.length === 0");
    expect(source).toContain("updateChangedPart");
    expect(source).toContain("if (hasBlockingLines) return;");
    expect(source).toContain("disabled={busy || hasBlockingLines}");
    expect(source).toContain("maxLength={4000}");
  });
});

describe("teacher feedback exception queue", () => {
  it("accepts the bounded overdue-scheduled rescue state", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          workspace_id: "22222222-2222-4222-8222-222222222222",
          student_id: "33333333-3333-4333-8333-333333333333",
          batch_id: "44444444-4444-4444-8444-444444444444",
          status: "checked",
          evaluation_status: "ready",
          release_status: "scheduled",
          release_at: "2026-07-10T12:00:00.000Z",
          feedback_mode: "automatic_delayed",
          review_reason: "overdue_scheduled",
          feedback_version_id: "55555555-5555-4555-8555-555555555555",
          feedback_version: 1,
          feedback_revision: 1,
          feedback_state: "draft",
          student_name: "Learner",
          student_email: "learner@example.test",
          batch_name: "A2 Class",
          question_title: "Free Writing",
          error_code: "scheduled_release_overdue",
          created_at: "2026-07-10T11:50:00.000Z",
          updated_at: "2026-07-10T12:00:00.000Z",
        },
      ],
      total_count: 1,
      returned_count: 1,
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });

    const page = await listFeedbackReviewQueuePage({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      reason: "overdue_scheduled",
    });

    expect(page.items[0]).toMatchObject({
      review_reason: "overdue_scheduled",
      error_code: "scheduled_release_overdue",
      release_status: "scheduled",
    });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "list_feedback_review_queue_page",
      expect.objectContaining({ target_reason: "overdue_scheduled" }),
      expect.any(String),
    );
  });
});
