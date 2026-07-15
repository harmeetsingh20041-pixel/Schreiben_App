import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  getWritingDraft: vi.fn(),
  getWritingDraftByContext: vi.fn(),
  saveWritingDraft: vi.fn(),
  submitWritingDraft: vi.fn(),
  selectActiveBatch: vi.fn(),
  toast: vi.fn(),
  classState: {
    current: {} as Record<string, unknown>,
  },
}));

vi.mock("@/services/submissionService", () => ({
  getWritingDraft: mocks.getWritingDraft,
  getWritingDraftByContext: mocks.getWritingDraftByContext,
  saveWritingDraft: mocks.saveWritingDraft,
  submitWritingDraft: mocks.submitWritingDraft,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "student-1" } }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/studentClassContext", () => ({
  useStudentClass: () => mocks.classState.current,
}));

import StudentWrite from "@/pages/student/write";

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      scrollIntoViewDescriptor,
    );
  } else {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

const assignments = [
  {
    id: "assignment-a",
    workspace_id: "workspace-1",
    batch_id: "class-a",
    batch_name: "Class A",
    level: "A1",
  },
  {
    id: "assignment-b",
    workspace_id: "workspace-1",
    batch_id: "class-b",
    batch_name: "Class B",
    level: "A2",
  },
];

const classADraft = {
  draft_id: "draft-a",
  workspace_id: "workspace-1",
  batch_id: "class-a",
  source_type: "free_text",
  source_id: null,
  text: "Entwurf aus Klasse A",
  revision: 3,
  updated_at: "2026-07-12T08:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function setClassContext(
  activeBatchId: string | null,
  nextAssignments = assignments,
) {
  mocks.classState.current = {
    activeBatchId,
    assignments: nextAssignments,
    error: null,
    isLoading: false,
    selectActiveBatch: mocks.selectActiveBatch,
  };
}

function renderWrite() {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <StudentWrite />
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    rerenderWrite: () => view.rerender(tree()),
  };
}

function classSelector() {
  return screen.getByRole("combobox", {
    name: "Class receiving this writing",
  });
}

describe("StudentWrite class and draft race isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectActiveBatch.mockReset();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/student/write?mode=free");
    setClassContext("class-a");
  });

  it("atomically enables an exact restore that triggers effect cleanup", async () => {
    mocks.getWritingDraftByContext.mockResolvedValue(classADraft);
    let view!: ReturnType<typeof renderWrite>;
    mocks.selectActiveBatch.mockImplementation((batchId: string) => {
      setClassContext(batchId, [...assignments]);
      view.rerenderWrite();
    });

    view = renderWrite();

    await waitFor(() =>
      expect(screen.getByLabelText("Your Text")).toHaveValue(classADraft.text),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Your Text")).toBeEnabled(),
    );
    expect(screen.getByTestId("writing-draft-status")).toHaveTextContent(
      "Saved",
    );
    expect(mocks.getWritingDraftByContext).toHaveBeenCalledWith(
      "workspace-1",
      "class-a",
      "free_text",
      null,
    );
    expect(mocks.getWritingDraft).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.get("draft")).toBe(
      "draft-a",
    );

    setClassContext("class-a", [...assignments]);
    view.rerenderWrite();
    await act(async () => Promise.resolve());
    expect(mocks.getWritingDraftByContext).toHaveBeenCalledTimes(1);
  });

  it("retries the same context when reconciliation cancels an unsettled lookup", async () => {
    const pendingRestore = deferred<typeof classADraft | null>();
    mocks.getWritingDraftByContext
      .mockImplementationOnce(() => pendingRestore.promise)
      .mockResolvedValueOnce(null);

    const view = renderWrite();

    await waitFor(() =>
      expect(mocks.getWritingDraftByContext).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByTestId("writing-draft-status")).toHaveTextContent(
      "Preparing draft",
    );
    expect(screen.getByLabelText("Your Text")).toBeDisabled();

    setClassContext("class-a", [...assignments]);
    view.rerenderWrite();

    await waitFor(() =>
      expect(mocks.getWritingDraftByContext).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Your Text")).toBeEnabled(),
    );
    expect(screen.getByTestId("writing-draft-status")).not.toHaveTextContent(
      "Preparing draft",
    );

    await act(async () => {
      pendingRestore.resolve(classADraft);
      await pendingRestore.promise;
    });

    expect(mocks.getWritingDraftByContext).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Your Text")).toHaveValue("");
  });

  it("keeps a settled lookup error deduplicated across equivalent context refreshes", async () => {
    mocks.getWritingDraftByContext.mockRejectedValue(
      new Error("temporary lookup failure"),
    );

    const view = renderWrite();

    await waitFor(() =>
      expect(screen.getByTestId("writing-draft-status")).toHaveTextContent(
        "Error",
      ),
    );
    expect(screen.getByLabelText("Your Text")).toBeDisabled();

    setClassContext("class-a", [...assignments]);
    view.rerenderWrite();
    await act(async () => Promise.resolve());

    expect(mocks.getWritingDraftByContext).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("writing-draft-status")).toHaveTextContent(
      "Error",
    );
  });

  it("keeps a fresh untouched context ready without saving an empty draft", async () => {
    mocks.getWritingDraftByContext.mockResolvedValue(null);

    renderWrite();
    const editor = await screen.findByLabelText("Your Text");

    await waitFor(() => expect(editor).toBeEnabled());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    });
    fireEvent.blur(editor);
    fireEvent(window, new Event("pagehide"));
    await act(async () => Promise.resolve());

    expect(mocks.saveWritingDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId("writing-draft-status")).toHaveTextContent(
      "Draft ready",
    );
  });

  it("revision-saves deliberate clearing of an existing draft", async () => {
    window.history.replaceState(
      null,
      "",
      "/student/write?mode=free&draft=draft-a",
    );
    mocks.getWritingDraft.mockResolvedValue(classADraft);
    mocks.getWritingDraftByContext.mockResolvedValue(null);
    mocks.saveWritingDraft.mockResolvedValue({
      draft_id: classADraft.draft_id,
      workspace_id: classADraft.workspace_id,
      revision: 4,
      saved_at: "2026-07-12T08:02:00.000Z",
    });

    renderWrite();
    const editor = await screen.findByLabelText("Your Text");

    await waitFor(() => expect(editor).toHaveValue(classADraft.text));
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.focus(editor);
    fireEvent.change(editor, { target: { value: "" } });
    await waitFor(() => expect(editor).toHaveValue(""));
    fireEvent.blur(editor);

    await waitFor(() =>
      expect(mocks.saveWritingDraft).toHaveBeenCalledWith({
        draftId: classADraft.draft_id,
        expectedRevision: classADraft.revision,
        questionSource: "free_text",
        questionId: null,
        batchId: "class-a",
        answerText: "",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("writing-draft-status")).toHaveTextContent(
        "Revision 4",
      ),
    );
  });

  it("keeps a later class choice when the old class auto-restore resolves", async () => {
    const user = userEvent.setup();
    const pendingClassARestore = deferred<typeof classADraft | null>();
    mocks.getWritingDraftByContext
      .mockImplementationOnce(() => pendingClassARestore.promise)
      .mockResolvedValueOnce(null);

    renderWrite();
    await waitFor(() =>
      expect(mocks.getWritingDraftByContext).toHaveBeenCalledTimes(1),
    );

    classSelector().focus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    await waitFor(() => expect(classSelector()).toHaveTextContent("Class B"));

    await act(async () => {
      pendingClassARestore.resolve(classADraft);
      await pendingClassARestore.promise;
    });

    await waitFor(() =>
      expect(mocks.getWritingDraftByContext).toHaveBeenCalledTimes(2),
    );
    expect(mocks.getWritingDraft).not.toHaveBeenCalled();
    expect(classSelector()).toHaveTextContent("Class B");
    expect(screen.getByLabelText("Your Text")).toHaveValue("");
    expect(new URL(window.location.href).searchParams.get("draft")).toBeNull();
  });

  it(
    "ignores an old class save completion after the active class switches",
    async () => {
      const pendingClassASave = deferred<{
        draft_id: string;
        workspace_id: string;
        revision: number;
        updated_at: string;
      }>();
      mocks.getWritingDraftByContext.mockResolvedValue(null);
      mocks.saveWritingDraft.mockImplementationOnce(
        () => pendingClassASave.promise,
      );

      const view = renderWrite();
      const textarea = await screen.findByLabelText("Your Text");
      await waitFor(() => expect(textarea).toBeEnabled());
      fireEvent.change(textarea, { target: { value: "Text für Klasse A" } });
      fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
      await waitFor(() =>
        expect(mocks.saveWritingDraft).toHaveBeenCalledWith(
          expect.objectContaining({
            answerText: "Text für Klasse A",
            batchId: "class-a",
          }),
        ),
      );

      setClassContext("class-b");
      view.rerenderWrite();
      await waitFor(() => expect(classSelector()).toHaveTextContent("Class B"));

      await act(async () => {
        pendingClassASave.resolve({
          draft_id: "saved-class-a",
          workspace_id: "workspace-1",
          revision: 1,
          updated_at: "2026-07-12T08:01:00.000Z",
        });
        await pendingClassASave.promise;
      });

      expect(classSelector()).toHaveTextContent("Class B");
      expect(screen.getByLabelText("Your Text")).toHaveValue(
        "Text für Klasse A",
      );
      expect(new URL(window.location.href).searchParams.get("draft")).toBeNull();
    },
    10_000,
  );

  it("restores an explicit draft deep-link into the draft's own class", async () => {
    setClassContext("class-b");
    window.history.replaceState(
      null,
      "",
      "/student/write?mode=free&draft=draft-a",
    );
    mocks.getWritingDraft.mockResolvedValue(classADraft);
    mocks.getWritingDraftByContext.mockResolvedValue(null);

    renderWrite();

    await waitFor(() =>
      expect(screen.getByLabelText("Your Text")).toHaveValue(classADraft.text),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Your Text")).toBeEnabled(),
    );
    expect(classSelector()).toHaveTextContent("Class A");
    expect(mocks.selectActiveBatch).toHaveBeenCalledWith("class-a");
    expect(new URL(window.location.href).searchParams.get("draft")).toBe(
      "draft-a",
    );
  });
});
