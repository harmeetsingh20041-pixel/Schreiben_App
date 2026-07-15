// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../e2e/authenticated.offboarding-history.spec.ts", import.meta.url),
  "utf8",
);
const appPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const rootPackage = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };

describe("OPS-020 authenticated offboarding/history workflow contract", () => {
  it("keeps both supplied accounts process-only and determines their roles in-app", () => {
    expect(workflow).toContain("requiredEnvironment(`E2E_${slot}_EMAIL`)");
    expect(workflow).toContain("requiredEnvironment(`E2E_${slot}_PASSWORD`)");
    expect(workflow).toContain('pathname.startsWith("/teacher/")');
    expect(workflow).toContain(
      'signedInAccounts.find((account) => account.role === "teacher")',
    );
    expect(workflow).toContain(
      'signedInAccounts.find((account) => account.role === "student")',
    );
    expect(workflow).not.toContain("console.");
    expect(workflow).not.toContain("response.url()");
    expect(workflow).not.toContain("error.message");
  });

  it("uses exact linked fixtures over stdin, forbids AI calls, and always cleans up", () => {
    expect(workflow).toContain('spawn(executable, ["db", "query", "--linked"]');
    expect(workflow).toContain('stdio: ["pipe", "ignore", "ignore"]');
    expect(workflow).toContain("child.stdin.end(sql)");
    expect(workflow).toContain("ops_020_submission_collision");
    expect(workflow).toContain("installExactFixtureAssignment({");
    expect(workflow).toContain("ops_020_snapshotted_membership_changed");
    expect(workflow).toContain("ops_020_fixture_class_not_empty");
    expect(workflow).toContain("ops_020_cleanup_assignment_changed");
    expect(workflow).toContain("membershipFingerprint:");
    expect(workflow).toContain("if (fullOffboard) {");
    expect(workflow).toContain(
      'getByRole("link", { name: "History", exact: true }).click()',
    );
    expect(workflow).toContain(
      "the removed class cannot remain visible or selectable",
    );
    expect(workflow).toContain("ops_020_cleanup_scope_changed");
    expect(workflow).toContain("ops_020_cleanup_residue");
    expect(workflow).toContain("ops_020_unexpected_ai_job");
    expect(workflow).toContain("forbiddenProviderCalls");
    expect(workflow).toContain("await cleanupExactFixture(");
    expect(workflow).toContain("readRelationshipSnapshot({");
    expect(workflow).toContain("relationshipAfterCleanup");
    expect(workflow).toContain("removeOnlyFixtureAssignment(");
    expect(workflow).not.toContain("submit_writing");
    expect(workflow).not.toContain("createWritingSubmission");
  });

  it("exposes one private opt-in command without joining the normal suite", () => {
    expect(appPackage.scripts?.["test:e2e:offboarding-history"]).toBe(
      "tsx scripts/run-authenticated-playwright.ts authenticated.offboarding-history.spec.ts",
    );
    expect(rootPackage.scripts?.["test:e2e:offboarding-history"]).toBe(
      "pnpm --filter @workspace/german-writing-coach run test:e2e:offboarding-history",
    );
    expect(workflow).toContain(
      'process.env.E2E_OFFBOARDING_HISTORY !== "true"',
    );
  });
});
