import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeOffboardingResult } from "@/pages/teacher/students";

const studentsPageSource = readFileSync(
  path.resolve(process.cwd(), "src/pages/teacher/students.tsx"),
  "utf8",
);

describe("teacher student offboarding", () => {
  it("reports each transactional result count and the retained-history guarantee", () => {
    expect(describeOffboardingResult({
      membership_removed: true,
      removed_batch_assignments: 2,
      cancelled_join_requests: 1,
    })).toBe(
      "Workspace membership removed. 2 batch assignments removed. 1 join request cancelled. Historical work was preserved.",
    );

    expect(describeOffboardingResult({
      membership_removed: false,
      removed_batch_assignments: 0,
      cancelled_join_requests: 0,
    })).toBe(
      "Workspace membership was already absent. 0 batch assignments removed. 0 join requests cancelled. Historical work was preserved.",
    );
  });

  it("requires an accessible destructive confirmation before calling the RPC", () => {
    expect(studentsPageSource).toContain("<AlertDialogTrigger asChild>");
    expect(studentsPageSource).toContain("Remove {student.name} from this workspace?");
    expect(studentsPageSource).toContain(
      "Historical submissions, feedback, worksheet attempts, and progress records are preserved.",
    );
    expect(studentsPageSource).toContain('aria-busy={offboarding}');
    expect(studentsPageSource).toContain('if (offboardingRequest.current) return;');
    expect(studentsPageSource).toContain('event.preventDefault();');
    expect(studentsPageSource).toContain('disabled={offboarding}');
    expect(studentsPageSource).toMatch(
      /await offboardStudent\(student\.id, workspaceId\);[\s\S]*await onComplete\(\);/,
    );
  });

  it("does not describe a completed removal as unchanged when only refresh fails", () => {
    const rpcSuccess = studentsPageSource.indexOf("Offboarding completed for");
    const refreshCall = studentsPageSource.indexOf("await onComplete();");
    const refreshFailure = studentsPageSource.indexOf(
      "Student access was removed, but the list did not refresh",
    );

    expect(rpcSuccess).toBeGreaterThan(-1);
    expect(refreshCall).toBeGreaterThan(rpcSuccess);
    expect(refreshFailure).toBeGreaterThan(refreshCall);
  });
});
