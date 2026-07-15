import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSupabaseClient } = vi.hoisted(() => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("@/lib/supabaseClient", () => ({ getSupabaseClient }));

import { describeSubmittedWriting } from "@/pages/student/write";
import {
  createWritingSubmission,
  type CreatedWritingSubmission,
} from "@/services/submissionService";

function createMockClient(apiResult: Record<string, unknown>) {
  const apiSingle = vi.fn().mockResolvedValue({ data: apiResult, error: null });
  const apiRpc = vi.fn(() => ({ single: apiSingle }));
  const schema = vi.fn(() => ({ rpc: apiRpc }));
  const invoke = vi
    .fn()
    .mockRejectedValue(new Error("worker relay unavailable"));

  return {
    client: {
      schema,
      functions: { invoke },
    },
    apiRpc,
    apiSingle,
    invoke,
  };
}

const writingInput = {
  batchId: "batch-1",
  questionSource: "workspace_question" as const,
  questionId: "question-1",
  answerText: "Ich lerne Deutsch.",
};

describe("durable writing submission", () => {
  beforeEach(() => {
    getSupabaseClient.mockReset();
  });

  it("uses api.submit_writing and keeps the acknowledgement successful when the worker kick fails", async () => {
    const mocks = createMockClient({
      submission_id: "submission-1",
      evaluation_status: "queued",
      release_status: "held",
      release_at: null,
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    await expect(createWritingSubmission(writingInput)).resolves.toEqual({
      submission_id: "submission-1",
      evaluation_status: "queued",
      release_status: "held",
      release_at: null,
    });

    expect(mocks.client.schema).toHaveBeenCalledWith("api");
    expect(mocks.apiRpc).toHaveBeenCalledWith("submit_writing", {
      batch_id: "batch-1",
      source_type: "workspace_question",
      source_id: "question-1",
      text: "Ich lerne Deutsch.",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("kick-writing-jobs", {
      body: {},
    });
    expect(mocks.apiSingle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder[0],
    );
  });

  it("fails closed to queued and held for unknown API states", async () => {
    const mocks = createMockClient({
      submission_id: "submission-2",
      evaluation_status: "mystery",
      release_status: "public_by_accident",
      release_at: null,
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    await expect(createWritingSubmission(writingInput)).resolves.toMatchObject({
      evaluation_status: "queued",
      release_status: "held",
    });
  });

  it("does not kick a worker when the transactional daily quota rejects submission", async () => {
    const mocks = createMockClient({});
    mocks.apiSingle.mockResolvedValueOnce({
      data: null,
      error: { code: "PT429", message: "writing_daily_quota_exceeded" },
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    await expect(createWritingSubmission(writingInput)).rejects.toMatchObject({
      code: "data_rate_limited",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not kick a worker when the transactional monthly quota rejects submission", async () => {
    const mocks = createMockClient({});
    mocks.apiSingle.mockResolvedValueOnce({
      data: null,
      error: { code: "PT429", message: "writing_monthly_quota_exceeded" },
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    await expect(createWritingSubmission(writingInput)).rejects.toMatchObject({
      code: "data_rate_limited",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("sends the student's exact whitespace without trimming or normalization", async () => {
    const mocks = createMockClient({
      submission_id: "submission-exact",
      evaluation_status: "queued",
      release_status: "held",
      release_at: null,
    });
    getSupabaseClient.mockReturnValue(mocks.client);
    const exactText = "  e\u0301 🙂\r\n\r\nIch lerne Deutsch.  ";

    await createWritingSubmission({ ...writingInput, answerText: exactText });

    expect(mocks.apiRpc).toHaveBeenCalledWith(
      "submit_writing",
      expect.objectContaining({
        text: exactText,
      }),
    );
  });

  it("does not surface contradictory release states as public", async () => {
    const mocks = createMockClient({
      submission_id: "submission-3",
      evaluation_status: "processing",
      release_status: "released",
      release_at: null,
    });
    getSupabaseClient.mockReturnValue(mocks.client);

    await expect(createWritingSubmission(writingInput)).resolves.toMatchObject({
      evaluation_status: "processing",
      release_status: "held",
      release_at: null,
    });
  });

  it("restores the Save Draft control only through revision-safe draft RPCs", () => {
    const pageSource = readFileSync(
      path.resolve(process.cwd(), "src/pages/student/write.tsx"),
      "utf8",
    );
    const serviceSource = readFileSync(
      path.resolve(process.cwd(), "src/services/submissionService.ts"),
      "utf8",
    );

    expect(pageSource).toContain("Save Draft");
    expect(pageSource).toContain("expectedRevision");
    expect(serviceSource).toContain("saveWritingDraft");
    expect(serviceSource).toContain('client.rpc("save_writing_draft"');
    expect(serviceSource).toContain('client.rpc("submit_writing_draft"');
    expect(serviceSource).not.toContain("save_as_draft: true");
  });
});

describe("writing submission progress copy", () => {
  function state(
    overrides: Partial<CreatedWritingSubmission>,
  ): CreatedWritingSubmission {
    return {
      submission_id: "submission-1",
      evaluation_status: "queued",
      release_status: "held",
      release_at: null,
      ...overrides,
    };
  }

  it("never calls queued or processing feedback ready", () => {
    const queued = describeSubmittedWriting(
      state({ evaluation_status: "queued" }),
    );
    const processing = describeSubmittedWriting(
      state({ evaluation_status: "processing" }),
    );

    expect(queued.message).toContain("safely queued");
    expect(processing.message).toContain("being prepared");
    expect(`${queued.message} ${processing.message}`).not.toMatch(
      /feedback (is )?ready/i,
    );
  });

  it("only describes feedback as released when both states confirm it", () => {
    const preparedButHeld = describeSubmittedWriting(
      state({ evaluation_status: "ready" }),
    );
    const released = describeSubmittedWriting(
      state({
        evaluation_status: "ready",
        release_status: "released",
      }),
    );

    expect(preparedButHeld.message).toContain("being held");
    expect(preparedButHeld.message).not.toContain("and released");
    expect(released.message).toContain("and released");
  });

  it("guards the teacher toast against queued and already-processing results", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/pages/teacher/submission.tsx"),
      "utf8",
    );
    const processingBranch = source.indexOf("result.already_processing");
    const readyBranch = source.indexOf(
      '["ready", "checked"].includes(result.status)',
    );

    expect(processingBranch).toBeGreaterThan(-1);
    expect(readyBranch).toBeGreaterThan(processingBranch);
  });
});
