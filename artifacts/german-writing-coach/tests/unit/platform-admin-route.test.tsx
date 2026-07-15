import { act, render, screen, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { Router, Route, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  current: {
    isPlatformAdmin: false,
    loading: false,
    platformAdminMfaReady: false,
    user: { id: "user-1" },
  },
}));

vi.mock("@/lib/auth", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => authState.current,
}));

vi.mock("@/components/layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/pages/auth/mfa", () => ({
  default: () => <p>MFA route content</p>,
}));

import { AdminRoute, MfaRoute } from "@/App";

function AdminScreen() {
  return <h1>Protected admin screen</h1>;
}

function renderRoute() {
  const location = memoryLocation({ path: "/admin/test" });
  render(
    <Router hook={location.hook}>
      <AdminRoute path="/admin/test" component={AdminScreen} />
      <Route path="/">
        <p>Public landing</p>
      </Route>
      <Route path="/auth/mfa">
        <p>MFA challenge</p>
      </Route>
    </Router>,
  );
  return location;
}

describe("platform-admin route", () => {
  beforeEach(() => {
    authState.current = {
      isPlatformAdmin: false,
      loading: false,
      platformAdminMfaReady: false,
      user: { id: "user-1" },
    };
  });

  it("does not accept an authenticated non-admin account", async () => {
    renderRoute();

    await waitFor(() =>
      expect(screen.getByText("Public landing")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Protected admin screen"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Public landing")).toBeInTheDocument();
  });

  it("renders only when trusted auth context marks the account platform admin", () => {
    authState.current = {
      isPlatformAdmin: true,
      loading: false,
      platformAdminMfaReady: true,
      user: { id: "admin-1" },
    };

    renderRoute();

    expect(
      screen.getByRole("heading", { name: "Protected admin screen" }),
    ).toBeInTheDocument();
  });

  it("routes an AAL1 administrator to MFA before rendering admin content", async () => {
    authState.current = {
      isPlatformAdmin: true,
      loading: false,
      platformAdminMfaReady: false,
      user: { id: "admin-1" },
    };

    renderRoute();

    await waitFor(() =>
      expect(screen.getByText("MFA challenge")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Protected admin screen"),
    ).not.toBeInTheDocument();
  });

  it("keeps React hook order stable across public, MFA, and administrator routes", () => {
    authState.current = {
      isPlatformAdmin: true,
      loading: false,
      platformAdminMfaReady: true,
      user: { id: "admin-1" },
    };
    const location = memoryLocation({ path: "/" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      render(
        <Router hook={location.hook}>
          <Switch>
            <Route path="/">
              <p>Public landing</p>
            </Route>
            <Route path="/auth/mfa" component={MfaRoute} />
            <AdminRoute path="/admin/test" component={AdminScreen} />
          </Switch>
        </Router>,
      );

      act(() => location.navigate("/auth/mfa"));
      expect(screen.getByText("MFA route content")).toBeInTheDocument();
      act(() => location.navigate("/admin/test"));
      expect(
        screen.getByRole("heading", { name: "Protected admin screen" }),
      ).toBeInTheDocument();

      const hookWarnings = consoleError.mock.calls
        .flat()
        .map(String)
        .filter((message) =>
          /change in the order of Hooks|Rendered (?:more|fewer) hooks/i.test(
            message,
          ),
        );
      expect(hookWarnings).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("declares the teacher-access path on the Switch child", () => {
    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/App.tsx"),
      "utf8",
    );

    // Wouter Switch reads the path from its direct child. Omitting this prop
    // turns the wrapper into a wildcard and leaves every later protected route
    // blank, even though TeacherAccessRoute has an internal default.
    expect(appSource).toContain(
      '<TeacherAccessRoute path="/teacher-access" />',
    );
    expect(appSource).not.toContain("<TeacherAccessRoute />");
  });
});
