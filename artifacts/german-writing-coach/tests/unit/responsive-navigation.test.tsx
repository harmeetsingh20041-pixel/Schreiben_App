import axe from "axe-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logoutMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => ({
  isPlatformAdmin: false,
  role: "teacher" as "student" | "teacher",
  selectActiveMembership: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    activeMembershipId: "membership-1",
    authMode: "supabase",
    isPlatformAdmin: authMock.isPlatformAdmin,
    role: authMock.role,
    user: { id: "student-1" },
    logout: logoutMock,
    selectActiveMembership: authMock.selectActiveMembership,
    workspaceMemberships: [
      {
        id: "membership-1",
        workspace_name: "Pilot School",
        role: authMock.role,
      },
      {
        id: "membership-2",
        workspace_name: "Partner School",
        role: authMock.role,
      },
    ],
  }),
}));

vi.mock("@/lib/studentClassContext", () => ({
  useStudentClass: () => ({
    activeAssignment: {
      id: "assignment-1",
      batch_id: "batch-1",
      batch_name: "A2 Evening",
      level: "A2",
    },
    activeBatchId: "batch-1",
    assignments: [
      {
        id: "assignment-1",
        batch_id: "batch-1",
        batch_name: "A2 Evening",
        level: "A2",
      },
      {
        id: "assignment-2",
        batch_id: "batch-2",
        batch_name: "B1 Morning",
        level: "B1",
      },
    ],
    isLoading: false,
    selectActiveBatch: vi.fn(),
  }),
}));

import { Layout } from "@/components/layout";

function renderLayout() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Layout>
        <div>Page content</div>
      </Layout>
    </QueryClientProvider>,
  );
}

describe("responsive primary navigation", () => {
  beforeEach(() => {
    authMock.isPlatformAdmin = false;
    authMock.role = "teacher";
  });

  it("gives the icon-only mobile platform-admin link an accessible name", () => {
    authMock.isPlatformAdmin = true;
    renderLayout();

    expect(
      screen.getByRole("link", { name: "Platform administration" }),
    ).toHaveAttribute("href", "/admin/teacher-access");
  });

  it("exposes the focused V1 teacher navigation in a keyboard-accessible mobile sheet", async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" }),
    );
    const menu = screen.getByRole("dialog", { name: "Navigation" });
    const menuQueries = within(menu);

    for (const label of [
      "Overview",
      "Classes",
      "Students",
      "Review Queue",
      "Content",
    ]) {
      expect(
        menuQueries.getByRole("link", { name: label }),
      ).toBeInTheDocument();
    }
    expect(
      menuQueries.queryByRole("link", { name: "Batches" }),
    ).not.toBeInTheDocument();
    expect(
      menuQueries.queryByRole("link", { name: "Submissions" }),
    ).not.toBeInTheDocument();

    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("keeps the drawer available until the desktop controls begin", () => {
    renderLayout();

    const primaryNavigation = screen.getByRole("navigation", {
      name: "Primary navigation",
    });
    const menuTrigger = screen.getByRole("button", {
      name: "Open navigation menu",
    });

    expect(primaryNavigation).toHaveClass("xl:flex");
    expect(primaryNavigation).not.toHaveClass("lg:flex");
    expect(menuTrigger).toHaveClass("xl:hidden");
    expect(menuTrigger).not.toHaveClass("lg:hidden");
  });

  it("retains student workspace, class, enrollment, and navigation controls in the tablet drawer", async () => {
    authMock.role = "student";
    const user = userEvent.setup();
    renderLayout();

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" }),
    );
    const menu = screen.getByRole("dialog", { name: "Navigation" });
    const menuQueries = within(menu);

    expect(
      menuQueries.getByRole("combobox", {
        name: "Active workspace and role",
      }),
    ).toBeInTheDocument();
    expect(
      menuQueries.getByRole("combobox", {
        name: "Active class",
      }),
    ).toBeInTheDocument();
    expect(
      menuQueries.getByRole("button", {
        name: "Join another class",
      }),
    ).toBeInTheDocument();
    for (const label of ["Home", "Write", "Practice", "History"]) {
      expect(
        menuQueries.getByRole("link", { name: label }),
      ).toBeInTheDocument();
    }
  });
});
