/// <reference types="vite/client" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PublicAppError } from "@/lib/appError";
import { formatErrorMessage } from "@/lib/workspaceData";

function readSource(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), "src", relativePath), "utf8");
}

describe("frontend authorization context", () => {
  it("uses the trusted auth-context RPC without a user_metadata role fallback", () => {
    const source = readSource("services/authService.ts");

    expect(source).toContain('rpc("get_auth_context")');
    expect(source).toContain("const user = session.user;");
    expect(source).not.toContain("const user = await getCurrentUser()");
    expect(source.indexOf("await loadTrustedAuthContext(client)")).toBeLessThan(
      source.indexOf("const user = session.user;"),
    );
    expect(source).toContain('trustedContext.global_role === "platform_admin"');
    expect(source).not.toMatch(/user\?\.user_metadata\?\.account_type/);
    expect(source).not.toMatch(/raw_user_meta_data/);

    const routes = readSource("App.tsx");
    expect(routes).toMatch(
      /function AdminRoute[\s\S]*?if \(!user \|\| !isPlatformAdmin\) return <Redirect/,
    );
    const adminPage = readSource("pages/admin/teacher-access.tsx");
    expect(adminPage).not.toMatch(/sprachflug|harmeet|sharmeet|@gmail\.com/i);
  });

  it("surfaces a trusted-context failure from an explicit sign-in", () => {
    const source = readSource("lib/auth.tsx");

    expect(source).toContain("sessionFromAuthEvent: signedInSession");
    expect(source).toContain("throwOnFailure: true");
    expect(source).toMatch(
      /catch \(error\) \{[\s\S]*?if \(options\.throwOnFailure\) throw error;/,
    );
  });

  it("reuses the canonical auth-event session without weakening server authority", () => {
    const provider = readSource("lib/auth.tsx");
    const service = readSource("services/authService.ts");

    expect(provider).toContain(
      "refreshAuthState({ sessionFromAuthEvent: eventSession })",
    );
    expect(provider).toContain("options.sessionFromAuthEvent");
    expect(service).toMatch(
      /sessionFromAuthEvent === undefined\s+\? await getCurrentSession\(\)\s+: sessionFromAuthEvent/,
    );
    expect(
      service.indexOf("await loadTrustedAuthContext(client)"),
    ).toBeLessThan(service.indexOf("const user = session.user;"));
    expect(service).toContain("trustedContext.user_id !== user.id");
  });

  it("prefetches Overview data only after trusted teacher context is resolved", () => {
    const provider = readSource("lib/auth.tsx");

    expect(
      provider.indexOf("const snapshot = await getAuthSnapshot("),
    ).toBeLessThan(provider.indexOf("prefetchTeacherOverviewQueries("));
    expect(provider).toContain('snapshot.role === "teacher"');
    expect(provider).toContain("snapshot.activeWorkspaceId");
    expect(provider).toContain(
      "isTeacherOverviewPath(window.location.pathname)",
    );
    expect(provider.indexOf("prefetchTeacherOverviewQueries(")).toBeLessThan(
      provider.indexOf("setRole(snapshot.role)"),
    );
  });

  it("keeps the incomplete email invitation workflow out of V1 teacher screens", () => {
    const studentsPage = readSource("pages/teacher/students.tsx");
    const dashboardPage = readSource("pages/teacher/dashboard.tsx");

    expect(studentsPage).not.toContain("inviteStudentByEmail");
    expect(studentsPage).not.toContain("Pending Invitations");
    expect(studentsPage).not.toContain("Invite Student");
    expect(dashboardPage).not.toContain("listStudentInvitations");

    const studentService = readSource("services/studentService.ts");
    expect(studentService).not.toContain("inviteStudentByEmail");
    expect(studentService).not.toContain("listStudentInvitations");
  });

  it("keeps duplicate signup responses existence-neutral", () => {
    const source = readSource("services/authService.ts");

    expect(source).not.toMatch(
      /user_already_exists|email_exists|already registered/i,
    );
    expect(source).not.toContain("auth_account_exists");
  });
});

describe("safe client error messages", () => {
  it("supports intentional thrown strings but hides technical strings", () => {
    expect(
      formatErrorMessage(
        "Please answer every question before submitting.",
        "Try again.",
      ),
    ).toBe("Please answer every question before submitting.");
    expect(formatErrorMessage("postgres SQLSTATE 42501", "Try again.")).toBe(
      "Try again.",
    );
  });

  it("preserves stable public error codes and messages", () => {
    const error = new PublicAppError(
      "auth_email_unconfirmed",
      "Confirm your email before signing in.",
    );

    expect(formatErrorMessage(error, "Authentication failed.")).toBe(
      "Confirm your email before signing in.",
    );
  });
});
