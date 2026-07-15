// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../e2e/authenticated.teacher-access.spec.ts", import.meta.url),
  "utf8",
);
const adminPageSource = readFileSync(
  new URL("../../src/pages/admin/teacher-access.tsx", import.meta.url),
  "utf8",
);
const applicationPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const rootPackage = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };

describe("platform-admin teacher-access E2E contract", () => {
  it("uses a dedicated administrator and disposable applicant with the private wrapper", () => {
    expect(source).toContain('credentials("ADMIN")');
    expect(source).toContain('credentials("STUDENT")');
    expect(source).not.toContain('credentials("TEACHER")');
    expect(source).toContain('requiredEnvironment("E2E_AUTHENTICATED")');
    expect(source).toContain('requiredEnvironment("E2E_ADMIN_TOTP_CODE")');
    expect(source).toContain(
      'requiredEnvironment("E2E_TEACHER_ACCESS_DISPOSABLE")',
    );
    expect(source).toContain('process.env.E2E_MUTATIONS !== "true"');
    expect(applicationPackage.scripts?.["test:e2e:teacher-access"]).toBe(
      "tsx scripts/run-authenticated-playwright.ts authenticated.teacher-access.spec.ts",
    );
    expect(rootPackage.scripts?.["test:e2e:teacher-access"]).toBe(
      "pnpm --filter @workspace/german-writing-coach run test:e2e:teacher-access",
    );
  });

  it("uses a fresh runtime-only TOTP value and fails closed before manual enrollment", () => {
    expect(source).toContain('url.pathname === "/auth/mfa"');
    expect(source).toContain('page.getByLabel("Six-digit code")');
    expect(source).toContain('name: "Verify authenticator"');
    expect(source).toContain(
      'page.getByText("Two-factor setup is complete", { exact: true })',
    );
    expect(source).toContain("adminTotp.consume()");
    expect(source).toContain("test.describe.configure({ retries: 0 })");
    expect(source).toContain("assertSuccessfulAdminMutation(");
    expect(source).toContain("will not reuse a consumed value");
    expect(source).toContain("primary and backup TOTP factor");
    expect(source).not.toMatch(/TOTP_(?:SECRET|SEED)/i);
    expect(source).not.toContain("otpauth://");
    expect(source).not.toContain("qr_code");
    expect(source).not.toContain("E2E_ADMIN_TOTP_CODE:");
  });

  it("proves route denial, approval, first-class setup, cleanup, and learner continuity", () => {
    expect(source).toContain('studentPage.goto("/admin/teacher-access")');
    expect(source).toContain('status === "pending"');
    expect(source).toContain('rejected: "Rejected requests"');
    expect(source).toContain('disabled: "Disabled access"');
    expect(source).toContain("assertDisposableRequestBaseline(");
    expect(source).not.toContain("normalizeApplicantForRequest(");
    expect(source).toContain("Request teacher access again");
    expect(source).toContain(
      "payload.expected_revision !== match.row.requestRevision",
    );
    expect(source).toContain(
      "payload.approved_workspace_limit !== APPROVED_WORKSPACE_LIMIT",
    );
    expect(source).toContain("test.setTimeout(240_000)");
    expect(source).toContain("waitForInventoryRpc(page, status,");
    expect(source).toContain("rows[0]!.transferred_workspace_count !== 1");
    expect(source).toContain('name: "Create your first class"');
    expect(source).toContain('name: "Create a class"');
    expect(adminPageSource).toContain('data-testid="teacher-access-account"');
    expect(adminPageSource).toContain(
      "data-applicant-user-id={item.applicant_user_id}",
    );
    expect(source).toContain(
      "await disableApplicant(adminPage, applicant.email)",
    );
    expect(source).toContain('studentPage.goto("/student/dashboard")');
    expect(source).toContain('name: "Join another class"');
  });

  it("retains no credential, response-body, or browser-content artifacts", () => {
    expect(source).not.toMatch(/@gmail\.com|SchreibenTest/i);
    expect(source).not.toMatch(/testInfo\s*\.\s*attach/);
    expect(source).not.toMatch(/screenshot|tracing|video/);
    expect(source).not.toContain("page.request");
    expect(source).not.toContain("window.fetch");
    expect(source).not.toContain("authorization");
    expect(source).not.toContain("apikey");
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("response.url()");
  });
});
