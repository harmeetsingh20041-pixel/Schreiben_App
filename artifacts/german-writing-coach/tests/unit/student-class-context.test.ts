import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getStudentTaskPresentation } from "@/pages/student/questions";
import {
  writingDraftRestoreIsCurrent,
  writingDraftSaveVersion,
  writingDraftShouldPersist,
  writingDraftSnapshotIsCurrent,
  writingDraftStatusTitle,
  type WritingDraftIdentity,
} from "@/pages/student/write";

const dashboardSource = readFileSync(
  path.resolve(process.cwd(), "src/pages/student/dashboard.tsx"),
  "utf8",
);
const questionsSource = readFileSync(
  path.resolve(process.cwd(), "src/pages/student/questions.tsx"),
  "utf8",
);
const writeSource = readFileSync(
  path.resolve(process.cwd(), "src/pages/student/write.tsx"),
  "utf8",
);

describe("explicit student class context", () => {
  it("renders the server-owned latest state, including held and failed work", () => {
    expect(getStudentTaskPresentation("feedback_held")).toMatchObject({
      badge: "Waiting for teacher",
      action: "View Submission",
    });
    expect(getStudentTaskPresentation("failed")).toMatchObject({
      badge: "Evaluation failed",
      action: "View Submission",
    });
    expect(questionsSource).toContain("listStudentAssignedQuestionsPage");
    expect(questionsSource).toContain("question.latest_submission_id");
    expect(questionsSource).not.toContain("listStudentSubmissionsPage");
    expect(questionsSource).not.toContain("latestSubmissionByQuestion");
    expect(questionsSource).toContain('aria-label="Writing task pages"');
    expect(questionsSource).toContain(
      'aria-label="Previous writing task page"',
    );
    expect(questionsSource).toContain('aria-label="Next writing task page"');
    expect(dashboardSource).toContain("workspaceQueries.releasedFeedback");
    expect(dashboardSource).not.toContain("isFeedbackReadyStatus");
  });

  it("cannot reuse an unchanged class-A draft when class B is selected", () => {
    const identity: WritingDraftIdentity = {
      id: "draft-a",
      revision: 4,
      lastSavedText: "Ich lerne Deutsch.",
      batchId: "class-a",
      questionSource: "global_question",
      questionSourceId: "question-1",
    };
    const classA = {
      batchId: "class-a",
      questionSource: "global_question" as const,
      questionSourceId: "question-1",
    };
    const classB = { ...classA, batchId: "class-b" };

    expect(
      writingDraftSnapshotIsCurrent(identity, classA, identity.lastSavedText),
    ).toBe(true);
    expect(
      writingDraftSnapshotIsCurrent(identity, classB, identity.lastSavedText),
    ).toBe(false);
    expect(writingDraftSaveVersion(identity, classB)).toEqual({
      draftId: null,
      expectedRevision: 0,
    });
  });

  it("rejects a stale draft restore after the student changes class", () => {
    expect(writingDraftRestoreIsCurrent(4, 4, "class-a", "class-a")).toBe(true);
    expect(writingDraftRestoreIsCurrent(4, 5, "class-a", "class-b")).toBe(
      false,
    );
    expect(writingDraftRestoreIsCurrent(4, 4, "class-a", "class-b")).toBe(
      false,
    );
  });

  it("skips untouched empty contexts but persists clearing an existing draft", () => {
    const context = {
      batchId: "class-a",
      questionSource: "free_text" as const,
      questionSourceId: null,
    };
    const freshIdentity: WritingDraftIdentity = {
      id: null,
      revision: 0,
      lastSavedText: "",
      batchId: null,
      questionSource: null,
      questionSourceId: null,
    };
    const existingIdentity: WritingDraftIdentity = {
      id: "draft-a",
      revision: 3,
      lastSavedText: "Vorheriger Text",
      ...context,
    };

    expect(writingDraftShouldPersist(freshIdentity, context, "")).toBe(false);
    expect(writingDraftShouldPersist(freshIdentity, context, "   ")).toBe(
      false,
    );
    expect(
      writingDraftShouldPersist(freshIdentity, context, "  Neuer Text  "),
    ).toBe(true);
    expect(writingDraftShouldPersist(existingIdentity, context, "")).toBe(true);
    expect(
      writingDraftShouldPersist(
        existingIdentity,
        { ...context, batchId: "class-b" },
        "",
      ),
    ).toBe(false);
  });

  it("never labels an unready draft as saved", () => {
    expect(writingDraftStatusTitle("saved", false)).toBe("Preparing draft");
    expect(writingDraftStatusTitle("saving", false)).toBe("Preparing draft");
    expect(writingDraftStatusTitle("saved", true)).toBe("Saved");
    expect(writingDraftStatusTitle("error", false)).toBe("Error");
  });

  it("always exposes enrollment and blocks ambiguous writing starts", () => {
    expect(dashboardSource).toContain('"Join another class"');
    expect(dashboardSource).not.toContain("batchAssignments.length === 0 && (");
    expect(questionsSource).toContain('"Join another class"');
    expect(questionsSource).toContain("disabled={!selectedBatchId}");
    expect(questionsSource).toContain('aria-label="Class for this writing"');
    expect(writeSource).toContain(
      'const requestedBatchId = searchParams.get("batch");',
    );
    expect(writeSource).toContain("question?.batch_id ?? requestedBatchId");
    expect(writeSource).toMatch(
      /if\s*\(\s*question\?\.batch_id\s*&&\s*assignment\.batch_id\s*!==\s*question\.batch_id\s*\)\s*return false;/,
    );
  });
});
