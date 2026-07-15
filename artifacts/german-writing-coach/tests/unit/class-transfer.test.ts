import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callApiRpc: vi.fn() }));

vi.mock("@/services/apiFacade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/apiFacade")>();
  return { ...actual, callApiRpc: mocks.callApiRpc };
});

import { transferStudentClass } from "@/services/studentService";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const studentId = "22222222-2222-4222-8222-222222222222";
const sourceAssignmentId = "33333333-3333-4333-8333-333333333333";
const sourceBatchId = "44444444-4444-4444-8444-444444444444";
const targetAssignmentId = "55555555-5555-4555-8555-555555555555";
const targetBatchId = "66666666-6666-4666-8666-666666666666";

describe("atomic teacher class transfer", () => {
  beforeEach(() => mocks.callApiRpc.mockReset());

  it("binds workspace, student, exact source assignment, and target in one RPC", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      action_id: "77777777-7777-4777-8777-777777777777",
      workspace_id: workspaceId,
      student_id: studentId,
      source_assignment_id: sourceAssignmentId,
      source_batch_id: sourceBatchId,
      target_assignment_id: targetAssignmentId,
      target_batch_id: targetBatchId,
      target_created: true,
      source_removed: true,
    });

    await expect(transferStudentClass(
      workspaceId,
      studentId,
      sourceAssignmentId,
      targetBatchId,
    )).resolves.toMatchObject({
      source_assignment_id: sourceAssignmentId,
      target_assignment_id: targetAssignmentId,
      source_removed: true,
    });
    expect(mocks.callApiRpc).toHaveBeenCalledWith(
      "transfer_student_class",
      {
        target_workspace_id: workspaceId,
        target_student_id: studentId,
        source_assignment_id: sourceAssignmentId,
        target_batch_id: targetBatchId,
      },
      expect.stringContaining("No partial change"),
    );
  });

  it("rejects a response whose exact class context changed", async () => {
    mocks.callApiRpc.mockResolvedValue({
      schema_version: 1,
      action_id: "77777777-7777-4777-8777-777777777777",
      workspace_id: workspaceId,
      student_id: studentId,
      source_assignment_id: sourceAssignmentId,
      source_batch_id: sourceBatchId,
      target_assignment_id: targetAssignmentId,
      target_batch_id: "88888888-8888-4888-8888-888888888888",
      target_created: true,
      source_removed: true,
    });

    await expect(transferStudentClass(
      workspaceId,
      studentId,
      sourceAssignmentId,
      targetBatchId,
    )).rejects.toThrow("Class transfer returned an invalid response");
  });

  it("makes transfer semantics and immutable historical context explicit in the UI", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/pages/teacher/students.tsx"),
      "utf8",
    );
    expect(source).toContain("Transfer class");
    expect(source).toContain("Transfer {student.name} between classes");
    expect(source).toContain(
      "The current class assignment is removed and the target assignment is created in one transaction.",
    );
    expect(source).toContain("Historical submissions and feedback keep their original class context.");
    expect(source).toContain('aria-busy={transferring}');
    expect(source).toMatch(
      /await transferStudentClass\([\s\S]*await onComplete\(\);/,
    );
  });
});
