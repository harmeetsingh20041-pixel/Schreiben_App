import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJoinBatchResult } from "@/services/studentService";

const migrationSource = readFileSync(
  path.resolve(
    process.cwd(),
    "../../supabase/migrations/20260709205617_phase_8a_security_authorization_hardening.sql",
  ),
  "utf8",
);
const browserApiMigrationSource = readFileSync(
  path.resolve(
    process.cwd(),
    "../../supabase/migrations/20260710032000_phase_11c_browser_api_cutover.sql",
  ),
  "utf8",
);
const stableMutationMigrationSource = readFileSync(
  path.resolve(
    process.cwd(),
    "../../supabase/migrations/20260711123000_phase_11z_stable_mutation_validation.sql",
  ),
  "utf8",
);

function readSource(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), "src", relativePath), "utf8");
}

describe("V1 batch enrollment safety", () => {
  it("enforces teacher approval at the database boundary", () => {
    expect(migrationSource).toContain(
      "constraint batches_teacher_approval_only",
    );
    expect(migrationSource).toMatch(
      /check\s*\(\s*join_requires_approval\s+is\s+true\s*\)/i,
    );
    expect(migrationSource).not.toContain(
      "if batch_record.join_requires_approval then",
    );
    expect(migrationSource).not.toContain("new_status := 'approved'");
    expect(migrationSource).not.toContain(
      "app_private.apply_join_request_approval(new_request_id, caller_id)",
    );
    expect(migrationSource).toContain("requires_approval := true");
  });

  it("never accepts an automatic-approval choice from the batch service", () => {
    const source = readSource("services/batchService.ts");

    expect(source).not.toContain("input.join_requires_approval");
    expect(source).not.toContain("batch_join_requires_approval");
    expect(
      browserApiMigrationSource.match(
        /join_requires_approval,\n\s*feedback_mode/g,
      ),
    ).toHaveLength(1);
    expect(
      browserApiMigrationSource.match(/\n\s*true,\n\s*batch_feedback_mode/g),
    ).toHaveLength(1);
    expect(browserApiMigrationSource).toContain(
      "join_requires_approval = true",
    );
  });

  it("uses automatic immediate feedback as the low-burden class default", () => {
    const service = readSource("services/batchService.ts");
    const page = readSource("pages/teacher/batches.tsx");

    expect(service).toContain('input.feedback_mode ?? "immediate"');
    expect(page).toContain('feedback_mode: "immediate"');
    expect(page).toContain('["immediate", "automatic_delayed", "teacher_review_only"]');
    expect(
      stableMutationMigrationSource.match(
        /batch_feedback_mode text default 'immediate'/g,
      ),
    ).toHaveLength(4);
    expect(stableMutationMigrationSource).not.toContain(
      "batch_feedback_mode text default 'teacher_review_only'",
    );
  });

  it("presents teacher approval as mandatory in the teacher UI", () => {
    const source = readSource("pages/teacher/batches.tsx");

    expect(source).not.toContain("Auto-approve");
    expect(source).not.toContain("batch-approval-required");
    expect(source).not.toContain("formData.join_requires_approval");
    expect(source).toContain("Teacher approval required");
    expect(source).toContain(
      "A code never grants access by itself. You approve each request.",
    );
  });

  it("accepts only pending or previously approved teacher-controlled joins", () => {
    const pending = {
      request_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: "22222222-2222-4222-8222-222222222222",
      batch_id: "33333333-3333-4333-8333-333333333333",
      batch_name: "A1 Morning",
      level: "A1",
      status: "pending",
      requires_approval: true,
    };

    expect(parseJoinBatchResult([pending])).toEqual(pending);
    expect(parseJoinBatchResult([{ ...pending, status: "approved" }])).toEqual({
      ...pending,
      status: "approved",
    });
    expect(() =>
      parseJoinBatchResult([
        { ...pending, status: "approved", requires_approval: false },
      ]),
    ).toThrow();
    expect(() => parseJoinBatchResult([pending, pending])).toThrow();
    expect(() =>
      parseJoinBatchResult([{ ...pending, request_id: "not-a-uuid" }]),
    ).toThrow();
    expect(() =>
      parseJoinBatchResult([{ ...pending, batch_name: "" }]),
    ).toThrow();
  });

  it("turns an unknown or inactive code into a safe user-facing error", () => {
    expect(() => parseJoinBatchResult([])).toThrowError(
      "This class code is invalid, inactive, or no longer available.",
    );
  });
});
