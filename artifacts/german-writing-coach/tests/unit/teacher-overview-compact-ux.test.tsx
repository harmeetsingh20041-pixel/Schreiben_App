import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

for (const [name, value] of [
  ["hasPointerCapture", () => false],
  ["setPointerCapture", () => undefined],
  ["releasePointerCapture", () => undefined],
  ["scrollIntoView", () => undefined],
] as const) {
  Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    value,
  });
}

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    activeWorkspaceId: "workspace-1",
    user: { id: "teacher-1" },
  }),
}));

vi.mock("@/components/onboarding-checklist", () => ({
  OnboardingChecklist: () => null,
}));

vi.mock("@/lib/dashboardQueries", () => ({
  createTeacherDashboardQueries: vi.fn(
    (_workspaceId: string, _batchId: string | null, search = "") => ({
      batches: {
        queryKey: ["workspace", "workspace-1", "batches", "options", search],
        queryFn: async ({
          pageParam,
        }: {
          pageParam: { id: string } | null;
        }) => {
          const normalizedSearch = search.trim().toLowerCase();
          const items = normalizedSearch
            ? normalizedSearch === "archived"
              ? [
                  {
                    id: "archived-class",
                    name: "Archived class",
                    level: "B1",
                    is_active: false,
                  },
                ]
              : []
            : pageParam
              ? [
                  {
                    id: "archived-class",
                    name: "Archived class",
                    level: "B1",
                    is_active: false,
                  },
                ]
              : [
                  {
                    id: "active-class",
                    name: "Active class",
                    level: "A1",
                    is_active: true,
                  },
                ];
          return {
            schema_version: 1 as const,
            items,
            unfiltered_total_count: 52,
            total_count: normalizedSearch ? items.length : 2,
            returned_count: items.length,
            page_size: 100,
            has_more: !normalizedSearch && pageParam == null,
            next_cursor:
              !normalizedSearch && pageParam == null
                ? { created_at: "2026-07-13T00:00:00Z", id: "active-class" }
                : null,
          };
        },
        initialPageParam: null,
        getNextPageParam: (page: {
          has_more: boolean;
          next_cursor: unknown;
        }) => (page.has_more ? page.next_cursor : undefined),
        staleTime: 30_000,
      },
      summary: {
        queryKey: ["teacher-summary", "workspace-1", null],
        queryFn: async () => ({
          student_count: 18,
          question_count: 7,
          pending_join_request_count: 2,
          attention_items: [],
        }),
        staleTime: 10_000,
      },
      submissions: {
        queryKey: ["teacher-submissions", "workspace-1", null],
        queryFn: async () => ({ items: [] }),
        staleTime: 30_000,
      },
    }),
  ),
}));

import { createTeacherDashboardQueries } from "@/lib/dashboardQueries";
import TeacherDashboard from "@/pages/teacher/dashboard";

describe("Teacher Overview compact class options", () => {
  it("shows the exact class total and preserves archived filter options", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeacherDashboard />
      </QueryClientProvider>,
    );

    const classesLabel = await screen.findByText("Classes");
    expect(classesLabel.parentElement).not.toBeNull();
    await waitFor(() =>
      expect(
        within(classesLabel.parentElement as HTMLElement).getByText("52"),
      ).toBeVisible(),
    );

    const filter = screen.getByRole("combobox", {
      name: "Filter overview by class",
    });
    await user.click(filter);
    expect(
      await screen.findByRole("option", { name: /Active class/ }),
    ).toBeVisible();
    const loadMore = screen.getByRole("button", { name: /Load more/ });
    loadMore.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("option", { name: /Archived class/ }),
    ).toBeVisible();

    await user.click(screen.getByRole("option", { name: /Archived class/ }));
    expect(filter).toHaveTextContent("Archived class");

    await user.click(filter);
    await user.type(
      screen.getByRole("combobox", { name: "Search classes" }),
      "archived",
    );
    await waitFor(() =>
      expect(vi.mocked(createTeacherDashboardQueries)).toHaveBeenLastCalledWith(
        "workspace-1",
        "archived-class",
        "archived",
      ),
    );
    expect(filter).toHaveTextContent("Archived class");
    expect(
      await screen.findByRole("option", { name: /Archived class/ }),
    ).toBeVisible();

    const searchInput = screen.getByRole("combobox", {
      name: "Search classes",
    });
    await user.clear(searchInput);
    await user.type(searchInput, "missing");
    const noMatches = await screen.findByText("No classes match your search.");
    expect(noMatches).toHaveAttribute("role", "status");
    expect(noMatches).toHaveAttribute("aria-live", "polite");
  });
});
