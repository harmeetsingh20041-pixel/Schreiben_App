import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const helper = readFileSync(
  resolve(root, "e2e/helpers/authenticated-role-navigation.ts"),
  "utf8",
);
const teacherMutations = readFileSync(
  resolve(root, "e2e/authenticated.teacher-mutations.spec.ts"),
  "utf8",
);

const protectedSpecs = [
  "authenticated.workflow.spec.ts",
  "authenticated.teacher-mutations.spec.ts",
  "authenticated.feedback-modes.spec.ts",
  "authenticated.enrollment-edge.spec.ts",
  "authenticated.offboarding-history.spec.ts",
  "authenticated.dialog-viewport.spec.ts",
  "authenticated.performance.spec.ts",
];

describe("authenticated role navigation contract", () => {
  it("uses only the visible Teaching route for an administrator who is also a teacher", () => {
    expect(helper).toContain('currentPathname(page) === "/auth/mfa"');
    expect(helper).toContain("process.env.E2E_ADMIN_TOTP_CODE?.trim()");
    expect(helper).toContain("process.env.E2E_ADMIN_TOTP_PIPE?.trim()");
    expect(helper).toContain("stats.isFIFO()");
    expect(helper).toContain("E2E_MFA_CODE_REQUIRED");
    expect(helper).toContain("selectPrimaryAuthenticator(page, timeout)");
    expect(helper).toContain('=== "primary authenticator"');
    const mfaBranch = helper.indexOf('currentPathname(page) === "/auth/mfa"');
    expect(
      helper.indexOf(
        "await selectPrimaryAuthenticator(page, timeout)",
        mfaBranch,
      ),
    ).toBeLessThan(helper.indexOf("await runtimeAdminTotpCode()", mfaBranch));
    expect(helper).toContain('getByLabel("Six-digit code")');
    expect(helper).toContain('name: "Verify authenticator"');
    expect(helper).toContain("E2E_MFA_VERIFICATION_REJECTED");
    expect(helper).not.toMatch(/writeFile|localStorage|sessionStorage/);
    expect(helper).toContain(
      'currentPathname(page) !== "/admin/teacher-access"',
    );
    expect(helper).toContain('name: "Teaching"');
    expect(helper).toContain("await expect(teachingLink).toBeVisible");
    expect(helper).toContain("/\\/teacher\\/(?:dashboard|onboarding)$/");
  });

  it("keeps every account-classifying protected suite aligned", () => {
    for (const file of protectedSpecs) {
      const source = readFileSync(resolve(root, "e2e", file), "utf8");
      expect(source, file).toContain(
        'from "./helpers/authenticated-role-navigation"',
      );
      expect(source, file).toContain(
        "await enterTeacherShellFromAdminLanding(page)",
      );
    }
  });

  it("pins teacher mutations to one UUID-validated workspace membership before writes", () => {
    expect(teacherMutations).toContain(
      'requiredEnvironment("E2E_TEACHER_WORKSPACE_MEMBERSHIP_ID")',
    );
    expect(teacherMutations).toContain("UUID_PATTERN.test(value)");
    expect(teacherMutations).toContain("teacherWorkspaceMembershipId();");
    expect(teacherMutations).toContain(
      'window.localStorage.setItem("gwc_active_membership_id", membershipId)',
    );
    expect(teacherMutations).toContain(
      "const trustedAuthContext = waitForPinnedTeacherAuthContext",
    );
    expect(teacherMutations).toContain(
      'window.localStorage.getItem("gwc_active_membership_id")',
    );
    expect(teacherMutations).toContain(".toBe(expectedMembershipId)");
    expect(teacherMutations).toContain("did not contain the pinned membership");

    const authContextWait = teacherMutations.indexOf(
      "const trustedAuthContext = waitForPinnedTeacherAuthContext",
    );
    const preferenceWrite = teacherMutations.indexOf(
      'window.localStorage.setItem("gwc_active_membership_id", membershipId)',
    );
    const signInClick = teacherMutations.indexOf('name: "Sign in with Email"');
    const hydrationAwait = teacherMutations.indexOf("await trustedAuthContext");
    const pinnedSelectionAssertion = teacherMutations.indexOf(
      ".toBe(expectedMembershipId)",
    );
    expect(authContextWait).toBeGreaterThan(-1);
    expect(preferenceWrite).toBeGreaterThan(authContextWait);
    expect(signInClick).toBeGreaterThan(preferenceWrite);
    expect(hydrationAwait).toBeGreaterThan(signInClick);
    expect(pinnedSelectionAssertion).toBeGreaterThan(hydrationAwait);

    const classMutationStart = teacherMutations.indexOf(
      'test("teacher creates and archives a class in every feedback mode"',
    );
    const taskMutationStart = teacherMutations.indexOf(
      'test("teacher creates every writing-task type',
    );
    const classMutation = teacherMutations.slice(
      classMutationStart,
      taskMutationStart,
    );
    const taskMutation = teacherMutations.slice(taskMutationStart);
    expect(classMutationStart).toBeGreaterThan(-1);
    expect(taskMutationStart).toBeGreaterThan(classMutationStart);
    expect(classMutationStart).toBeGreaterThan(pinnedSelectionAssertion);
    expect(classMutation.indexOf("await signInTeacher(page)")).toBeLessThan(
      classMutation.indexOf('name: "Create Class"'),
    );
    expect(taskMutation.indexOf("await signInTeacher(page)")).toBeLessThan(
      taskMutation.indexOf('name: "Create Workspace Writing Task"'),
    );
    expect(classMutation).toContain("test.setTimeout(120_000)");
    expect(classMutation.indexOf("test.setTimeout(120_000)")).toBeLessThan(
      classMutation.indexOf('name: "Create Class"'),
    );
  });
});
