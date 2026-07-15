import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const prepareFeedbackSource = readFileSync(
  path.resolve(
    process.cwd(),
    "../../supabase/functions/prepare-writing-feedback/handler.ts",
  ),
  "utf8",
);
const compatibilityProcessorSource = readFileSync(
  path.resolve(
    process.cwd(),
    "../../supabase/functions/process-due-feedback/index.ts",
  ),
  "utf8",
);

describe("prepare-writing-feedback error boundary", () => {
  it("exposes known client errors but never arbitrary Error.message values", () => {
    expect(prepareFeedbackSource).toContain("function safeRpcError");
    expect(prepareFeedbackSource).toContain('return "Permission denied."');
    expect(prepareFeedbackSource).toContain(
      'return "Feedback could not be queued. Please try again later."',
    );
    expect(prepareFeedbackSource).not.toMatch(
      /error\s+instanceof\s+Error\s*\?\s*error\.message/,
    );
    expect(prepareFeedbackSource).not.toContain("prepareSubmissionFeedback");
    expect(prepareFeedbackSource).not.toContain('.from("submission_lines")');
    expect(prepareFeedbackSource).toContain('rpc("retry_writing_evaluation"');
  });
});

describe("process-due-feedback compatibility authorization", () => {
  it("accepts only service or recovery credentials", () => {
    expect(compatibilityProcessorSource).toContain("getRecoverySecret:");
    expect(compatibilityProcessorSource).toContain(
      "getServiceAuthSecret: getSecretKey",
    );
    expect(compatibilityProcessorSource).not.toContain(
      "authorizeAuthenticatedUserKick",
    );
  });
});
