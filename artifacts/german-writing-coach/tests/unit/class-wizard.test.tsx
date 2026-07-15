import userEvent from "@testing-library/user-event";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";

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

const {
  createWorkspaceBatchMock,
  listWorkspaceBatchesPageMock,
  requestBatchWritingLimitMock,
  toastMock,
} = vi.hoisted(() => ({
  createWorkspaceBatchMock: vi.fn(),
  listWorkspaceBatchesPageMock: vi.fn(),
  requestBatchWritingLimitMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    activeWorkspaceId: "11111111-1111-4111-8111-111111111111",
    authMode: "supabase",
    user: { id: "22222222-2222-4222-8222-222222222222" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("@/services/batchService", () => ({
  createWorkspaceBatch: createWorkspaceBatchMock,
  listWorkspaceBatchesPage: listWorkspaceBatchesPageMock,
  requestBatchWritingLimit: requestBatchWritingLimitMock,
  rotateBatchJoinCode: vi.fn(),
  setBatchActive: vi.fn(),
  updateWorkspaceBatch: vi.fn(),
}));

import TeacherBatches from "@/pages/teacher/batches";
import { PublicAppError } from "@/lib/appError";

function workspaceBatch(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    workspace_id: "11111111-1111-4111-8111-111111111111",
    name: `Class ${index}`,
    level: "A1",
    description: null,
    is_active: true,
    join_code: `CODE${String(index).padStart(4, "0")}`,
    join_code_enabled: true,
    join_requires_approval: true,
    feedback_mode: "immediate",
    feedback_delay_min_minutes: 15,
    feedback_delay_max_minutes: 180,
    created_by: "22222222-2222-4222-8222-222222222222",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 20 - index)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    student_count: 0,
    submission_count: 0,
    current_writing_daily_limit: 3,
    pending_writing_limit_request_id: null,
    pending_writing_limit_request_status: null,
    pending_writing_daily_limit: null,
    pending_writing_limit_request_revision: null,
  };
}

async function expectNoAutomatedAccessibilityViolations() {
  const result = await axe.run(document.body, {
    rules: {
      // JSDOM has no layout or computed color model; run contrast in Chromium.
      "color-contrast": { enabled: false },
    },
  });
  expect(result.violations).toEqual([]);
}

describe("guided class wizard", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/teacher/batches");
    createWorkspaceBatchMock.mockResolvedValue({});
    requestBatchWritingLimitMock.mockReset();
    listWorkspaceBatchesPageMock.mockResolvedValue({
      schema_version: 1,
      items: [],
      unfiltered_total_count: 0,
      total_count: 0,
      returned_count: 0,
      page_size: 12,
      has_more: false,
      next_cursor: null,
    });
  });

  it("opens the first-class wizard from the approved-teacher destination", async () => {
    window.history.replaceState({}, "", "/teacher/batches?create=first-class");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TeacherBatches />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("dialog", { name: "Create a class" }),
    ).toBeVisible();
    expect(window.location.search).toBe("");
    expect(screen.getByLabelText("Class name")).toHaveFocus();
  });

  it("keeps the first-class destination intact when the class inventory fails", async () => {
    window.history.replaceState({}, "", "/teacher/batches?create=first-class");
    listWorkspaceBatchesPageMock.mockRejectedValue(
      new Error("temporary class inventory failure"),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TeacherBatches />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "temporary class inventory failure",
    );
    expect(
      screen.queryByRole("dialog", { name: "Create a class" }),
    ).not.toBeInTheDocument();
    expect(window.location.search).toBe("?create=first-class");
  });

  it("guides a keyboard-operable scheduled class setup through all five steps", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <main>
          <TeacherBatches />
        </main>
      </QueryClientProvider>,
    );

    const emptyStateHeading = await screen.findByRole("heading", {
      name: "Create your first class",
    });
    const emptyState = emptyStateHeading.parentElement;
    expect(emptyState).not.toBeNull();
    await user.click(
      within(emptyState as HTMLElement).getByRole("button", {
        name: "Create Class",
      }),
    );

    expect(screen.getByText("Step 1 of 5: Class details")).toBeInTheDocument();
    expect(screen.getByTestId("class-wizard-scroll-region")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
    );
    const actions = screen.getByTestId("class-wizard-actions");
    expect(
      within(actions).getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
    expect(
      within(actions).getByRole("button", { name: "Continue" }),
    ).toBeVisible();
    expect(
      within(actions).getByText(
        "Scroll within this step if more fields are below.",
      ),
    ).toBeInTheDocument();
    await expectNoAutomatedAccessibilityViolations();
    await user.type(screen.getByLabelText("Class name"), "A2 Evening Class");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Step 2 of 5: Feedback mode")).toBeInTheDocument();
    await expectNoAutomatedAccessibilityViolations();
    expect(
      screen.getByRole("radio", { name: /Immediate feedback/ }),
    ).toHaveAttribute("aria-checked", "true");
    const immediateMode = screen.getByRole("radio", {
      name: /Immediate feedback/,
    });
    const scheduledMode = screen.getByRole("radio", {
      name: /Scheduled feedback/,
    });
    const teacherReviewMode = screen.getByRole("radio", {
      name: /Teacher review/,
    });
    expect(immediateMode).toHaveAttribute("tabindex", "0");
    expect(scheduledMode).toHaveAttribute("tabindex", "-1");
    expect(teacherReviewMode).toHaveAttribute("tabindex", "-1");
    immediateMode.focus();
    await user.keyboard("{ArrowRight}");
    expect(scheduledMode).toHaveAttribute("aria-checked", "true");
    expect(scheduledMode).toHaveAttribute("tabindex", "0");
    expect(immediateMode).toHaveAttribute("tabindex", "-1");
    expect(scheduledMode).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Step 3 of 5: Schedule")).toBeInTheDocument();
    await expectNoAutomatedAccessibilityViolations();
    const earliest = screen.getByLabelText("Earliest release (minutes)");
    const latest = screen.getByLabelText("Latest release (minutes)");
    await user.clear(earliest);
    await user.type(earliest, "30");
    await user.clear(latest);
    await user.type(latest, "90");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Step 4 of 5: Enrollment")).toBeInTheDocument();
    await expectNoAutomatedAccessibilityViolations();
    expect(
      screen.getByRole("switch", { name: "Enable join code" }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Step 5 of 5: Review")).toBeInTheDocument();
    await expectNoAutomatedAccessibilityViolations();
    expect(screen.getByText("A2 Evening Class · A1")).toBeInTheDocument();
    expect(screen.getByText("30–90 minutes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create class" }));

    await waitFor(() => {
      expect(createWorkspaceBatchMock).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        expect.objectContaining({
          name: "A2 Evening Class",
          feedback_mode: "automatic_delayed",
          feedback_delay_min_minutes: 30,
          feedback_delay_max_minutes: 90,
          join_code_enabled: true,
        }),
      );
    });
  }, 15_000);

  it("returns keyboard focus to the control that opened the class wizard", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <main>
          <TeacherBatches />
        </main>
      </QueryClientProvider>,
    );

    const emptyStateHeading = await screen.findByRole("heading", {
      name: "Create your first class",
    });
    const emptyState = emptyStateHeading.parentElement;
    expect(emptyState).not.toBeNull();
    const opener = within(emptyState as HTMLElement).getByRole("button", {
      name: "Create Class",
    });

    await user.click(opener);
    expect(
      screen.getByRole("dialog", { name: "Create a class" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("submits one class mutation while a save is already in flight", async () => {
    let resolveCreate: (() => void) | undefined;
    createWorkspaceBatchMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeacherBatches />
      </QueryClientProvider>,
    );

    const emptyStateHeading = await screen.findByRole("heading", {
      name: "Create your first class",
    });
    const emptyState = emptyStateHeading.parentElement;
    expect(emptyState).not.toBeNull();
    fireEvent.click(
      within(emptyState as HTMLElement).getByRole("button", {
        name: "Create Class",
      }),
    );
    fireEvent.change(screen.getByLabelText("Class name"), {
      target: { value: "One request only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const submit = screen.getByRole("button", { name: "Create class" });
    const form = submit.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.submit(form as HTMLFormElement);

    expect(createWorkspaceBatchMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Creating class..." }),
    ).toBeDisabled();
    expect(form).toHaveAttribute("aria-busy", "true");

    resolveCreate?.();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Create a class" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps loaded classes visible and retries a failed next page", async () => {
    const user = userEvent.setup();
    const firstBatch = workspaceBatch(1);
    const secondBatch = workspaceBatch(2);
    let nextPageAttempts = 0;
    listWorkspaceBatchesPageMock.mockImplementation(
      ({ cursor }: { cursor: { created_at: string; id: string } | null }) => {
        if (!cursor) {
          return Promise.resolve({
            schema_version: 1,
            items: [firstBatch],
            unfiltered_total_count: 2,
            total_count: 2,
            returned_count: 1,
            page_size: 12,
            has_more: true,
            next_cursor: {
              created_at: firstBatch.created_at,
              id: firstBatch.id,
            },
          });
        }
        nextPageAttempts += 1;
        if (nextPageAttempts === 1) {
          return Promise.reject(new Error("temporary transport failure"));
        }
        return Promise.resolve({
          schema_version: 1,
          items: [secondBatch],
          unfiltered_total_count: 2,
          total_count: 2,
          returned_count: 1,
          page_size: 12,
          has_more: false,
          next_cursor: null,
        });
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeacherBatches />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Class 1")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load more classes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The classes already shown remain available.",
    );
    expect(screen.getByText("Class 1")).toBeVisible();
    expect(screen.queryByText("Class 2")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Retry loading more classes" }),
    );
    expect(await screen.findByText("Class 2")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(nextPageAttempts).toBe(2);
  });

  it("lets a teacher request a daily writing limit without changing the class wizard", async () => {
    const user = userEvent.setup();
    const batch = workspaceBatch(1);
    listWorkspaceBatchesPageMock.mockResolvedValue({
      schema_version: 1,
      items: [batch],
      unfiltered_total_count: 1,
      total_count: 1,
      returned_count: 1,
      page_size: 12,
      has_more: false,
      next_cursor: null,
    });
    const requestResult = {
      request_id: "99999999-9999-4999-8999-999999999999",
      workspace_id: "11111111-1111-4111-8111-111111111111",
      batch_id: batch.id,
      current_writing_daily_limit: 3,
      requested_writing_daily_limit: 7,
      request_status: "pending",
      request_revision: 1,
      requested_at: "2026-07-14T10:00:00.000Z",
      updated_at: "2026-07-14T10:00:00.000Z",
    };
    requestBatchWritingLimitMock.mockImplementation(async () => {
      Object.assign(batch, {
        pending_writing_limit_request_id: requestResult.request_id,
        pending_writing_limit_request_status: "pending",
        pending_writing_daily_limit: 7,
        pending_writing_limit_request_revision: 1,
      });
      return requestResult;
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <main>
          <TeacherBatches />
        </main>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Daily writing feedback")).toBeVisible();
    expect(
      screen.getByText(
        "The standard limit is 3 evaluated writings per student each day.",
      ),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Request a writing limit change for Class 1",
      }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Daily writing limit",
    });
    expect(within(dialog).getByText("Current approved limit")).toBeVisible();
    expect(
      within(dialog).getByText(
        /approval changes this class's daily writing limit for every student in the class/i,
      ),
    ).toBeVisible();
    await expectNoAutomatedAccessibilityViolations();
    const limitSelect = within(dialog).getByLabelText(
      "Requested writings per student per day",
    );
    await user.click(limitSelect);
    await user.click(screen.getByRole("option", { name: "7 writings" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Send request" }),
    );

    await waitFor(() => {
      expect(requestBatchWritingLimitMock).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        batch.id,
        7,
        0,
      );
    });
    expect(await screen.findByText("Under review")).toBeVisible();
    expect(
      screen.getByText(
        "7/day requested. The current 3/day limit remains active until an administrator approves the change.",
      ),
    ).toBeVisible();
  });

  it("requires an archived class to be reactivated before requesting a limit change", async () => {
    const user = userEvent.setup();
    const batch = { ...workspaceBatch(1), is_active: false };
    listWorkspaceBatchesPageMock.mockResolvedValue({
      schema_version: 1,
      items: [batch],
      unfiltered_total_count: 1,
      total_count: 1,
      returned_count: 1,
      page_size: 12,
      has_more: false,
      next_cursor: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeacherBatches />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "Reactivate this class before requesting a limit change.",
      ),
    ).toBeVisible();
    const requestButton = screen.getByRole("button", {
      name: "Request a writing limit change for Class 1",
    });
    expect(requestButton).toBeDisabled();
    await user.click(requestButton);
    expect(
      screen.queryByRole("dialog", { name: "Daily writing limit" }),
    ).not.toBeInTheDocument();
    expect(requestBatchWritingLimitMock).not.toHaveBeenCalled();
  });

  it("updates the single pending request with its exact revision", async () => {
    const user = userEvent.setup();
    const batch = {
      ...workspaceBatch(1),
      pending_writing_limit_request_id: "99999999-9999-4999-8999-999999999999",
      pending_writing_limit_request_status: "pending" as const,
      pending_writing_daily_limit: 6,
      pending_writing_limit_request_revision: 4,
    };
    listWorkspaceBatchesPageMock.mockResolvedValue({
      schema_version: 1,
      items: [batch],
      unfiltered_total_count: 1,
      total_count: 1,
      returned_count: 1,
      page_size: 12,
      has_more: false,
      next_cursor: null,
    });
    requestBatchWritingLimitMock.mockResolvedValue({
      request_id: batch.pending_writing_limit_request_id,
      workspace_id: batch.workspace_id,
      batch_id: batch.id,
      current_writing_daily_limit: 3,
      requested_writing_daily_limit: 8,
      request_status: "pending",
      request_revision: 5,
      requested_at: "2026-07-14T10:00:00.000Z",
      updated_at: "2026-07-14T10:05:00.000Z",
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeacherBatches />
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Change pending writing limit request for Class 1",
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Daily writing limit",
    });
    expect(within(dialog).getByText("6/day")).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Update request" }),
    ).toBeDisabled();
    await user.click(
      within(dialog).getByLabelText("Requested writings per student per day"),
    );
    await user.click(screen.getByRole("option", { name: "8 writings" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Update request" }),
    );

    await waitFor(() =>
      expect(requestBatchWritingLimitMock).toHaveBeenCalledWith(
        batch.workspace_id,
        batch.id,
        8,
        4,
      ),
    );
  });

  it("closes a stale request and never resends its revision before fresh data is reopened", async () => {
    const user = userEvent.setup();
    const staleBatch = {
      ...workspaceBatch(1),
      pending_writing_limit_request_id: "99999999-9999-4999-8999-999999999999",
      pending_writing_limit_request_status: "pending" as const,
      pending_writing_daily_limit: 6,
      pending_writing_limit_request_revision: 4,
    };
    const freshBatch = {
      ...staleBatch,
      pending_writing_daily_limit: 8,
      pending_writing_limit_request_revision: 5,
    };
    const page = (batch: typeof staleBatch) => ({
      schema_version: 1 as const,
      items: [batch],
      unfiltered_total_count: 1,
      total_count: 1,
      returned_count: 1,
      page_size: 12,
      has_more: false,
      next_cursor: null,
    });
    let resolveRefresh: ((value: ReturnType<typeof page>) => void) | undefined;
    let listCall = 0;
    listWorkspaceBatchesPageMock.mockImplementation(() => {
      listCall += 1;
      if (listCall === 1) return Promise.resolve(page(staleBatch));
      if (listCall === 2) {
        return new Promise<ReturnType<typeof page>>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return Promise.resolve(page(freshBatch));
    });
    requestBatchWritingLimitMock
      .mockRejectedValueOnce(
        new PublicAppError(
          "data_conflict",
          "This writing-limit request changed while you were reviewing it.",
        ),
      )
      .mockResolvedValueOnce({
        request_id: freshBatch.pending_writing_limit_request_id,
        workspace_id: freshBatch.workspace_id,
        batch_id: freshBatch.id,
        current_writing_daily_limit: 3,
        requested_writing_daily_limit: 9,
        request_status: "pending",
        request_revision: 6,
        requested_at: "2026-07-14T10:00:00.000Z",
        updated_at: "2026-07-14T10:10:00.000Z",
      });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeacherBatches />
      </QueryClientProvider>,
    );

    const requestButton = await screen.findByRole("button", {
      name: "Change pending writing limit request for Class 1",
    });
    await user.click(requestButton);
    let dialog = screen.getByRole("dialog", { name: "Daily writing limit" });
    await user.click(
      within(dialog).getByLabelText("Requested writings per student per day"),
    );
    await user.click(screen.getByRole("option", { name: "8 writings" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Update request" }),
    );

    await waitFor(() =>
      expect(requestBatchWritingLimitMock).toHaveBeenCalledWith(
        staleBatch.workspace_id,
        staleBatch.id,
        8,
        4,
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "Daily writing limit" }),
    ).not.toBeInTheDocument();
    const refreshingButton = screen.getByRole("button", {
      name: "Change pending writing limit request for Class 1",
    });
    expect(refreshingButton).toBeDisabled();
    expect(refreshingButton).toHaveTextContent("Refreshing limit...");
    fireEvent.click(refreshingButton);
    expect(requestBatchWritingLimitMock).toHaveBeenCalledTimes(1);

    resolveRefresh?.(page(freshBatch));
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Change pending writing limit request for Class 1",
        }),
      ).toBeEnabled(),
    );
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Writing-limit request changed",
        description: expect.stringMatching(/reopen the request/i),
      }),
    );

    await user.click(
      screen.getByRole("button", {
        name: "Change pending writing limit request for Class 1",
      }),
    );
    dialog = screen.getByRole("dialog", { name: "Daily writing limit" });
    expect(within(dialog).getByText("8/day")).toBeVisible();
    await user.click(
      within(dialog).getByLabelText("Requested writings per student per day"),
    );
    await user.click(screen.getByRole("option", { name: "9 writings" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Update request" }),
    );

    await waitFor(() =>
      expect(requestBatchWritingLimitMock).toHaveBeenNthCalledWith(
        2,
        freshBatch.workspace_id,
        freshBatch.id,
        9,
        5,
      ),
    );
    expect(
      requestBatchWritingLimitMock.mock.calls.filter((call) => call[3] === 4),
    ).toHaveLength(1);
    expect(requestBatchWritingLimitMock).toHaveBeenCalledTimes(2);
  });

  it("loads one bounded server-filtered page and exposes every later class", async () => {
    const user = userEvent.setup();
    const firstPage = Array.from({ length: 12 }, (_, index) =>
      workspaceBatch(index + 1),
    );
    const finalBatch = workspaceBatch(13);
    listWorkspaceBatchesPageMock.mockImplementation(
      ({ cursor }: { cursor: { created_at: string; id: string } | null }) =>
        cursor
          ? Promise.resolve({
              schema_version: 1,
              items: [finalBatch],
              unfiltered_total_count: 13,
              total_count: 13,
              returned_count: 1,
              page_size: 12,
              has_more: false,
              next_cursor: null,
            })
          : Promise.resolve({
              schema_version: 1,
              items: firstPage,
              unfiltered_total_count: 13,
              total_count: 13,
              returned_count: 12,
              page_size: 12,
              has_more: true,
              next_cursor: {
                created_at: firstPage[11].created_at,
                id: firstPage[11].id,
              },
            }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <main>
          <TeacherBatches />
        </main>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Showing 12 of 13 filtered classes"),
    ).toBeVisible();
    expect(screen.queryByText("Class 13")).not.toBeInTheDocument();
    expect(listWorkspaceBatchesPageMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: "active",
        level: null,
        pageSize: 12,
        cursor: null,
      }),
    );
    await expectNoAutomatedAccessibilityViolations();

    await user.click(screen.getByRole("button", { name: "Load more classes" }));

    expect(await screen.findByText("Class 13")).toBeVisible();
    expect(screen.getByText("Showing 13 of 13 filtered classes")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Load more classes" }),
    ).not.toBeInTheDocument();
    expect(listWorkspaceBatchesPageMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: "active",
        level: null,
        pageSize: 12,
        cursor: {
          created_at: firstPage[11].created_at,
          id: firstPage[11].id,
        },
      }),
    );
  }, 15_000);

  it("sends status and CEFR filters to the server before pagination", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TeacherBatches />
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Create your first class" });

    screen.getByLabelText("Filter classes by level").focus();
    await user.keyboard("{Enter}{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(listWorkspaceBatchesPageMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "active", level: "A2" }),
      ),
    );

    screen.getByLabelText("Filter classes by status").focus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(listWorkspaceBatchesPageMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "inactive", level: "A2" }),
      ),
    );
  });

  it("explains an empty filtered page without pretending the workspace is empty", async () => {
    const user = userEvent.setup();
    listWorkspaceBatchesPageMock.mockResolvedValue({
      schema_version: 1,
      items: [],
      unfiltered_total_count: 5,
      total_count: 0,
      returned_count: 0,
      page_size: 12,
      has_more: false,
      next_cursor: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <main>
          <TeacherBatches />
        </main>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "No classes match these filters",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Create your first class" }),
    ).not.toBeInTheDocument();
    await expectNoAutomatedAccessibilityViolations();

    await user.click(screen.getByRole("button", { name: "Show all classes" }));
    await waitFor(() =>
      expect(listWorkspaceBatchesPageMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "all", level: null }),
      ),
    );
  });
});
