import axe from "axe-core";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const teacherQuestionBankPageMock = vi.hoisted(() => vi.fn());
const practiceStatsMock = vi.hoisted(() => vi.fn());
const practiceAssignmentsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  useAuth: () => authState.current,
}));

vi.mock("@/services/questionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/questionService")>();
  return {
    ...actual,
    createWorkspaceQuestion: vi.fn(),
    listTeacherQuestionBankPage: teacherQuestionBankPageMock,
    setQuestionActive: vi.fn(),
    updateWorkspaceQuestion: vi.fn(),
  };
});

vi.mock("@/services/grammarStatsService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/grammarStatsService")>();
  return {
    ...actual,
    listStudentGrammarStats: practiceStatsMock,
  };
});

vi.mock("@/services/practiceWorksheetService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/practiceWorksheetService")>();
  return {
    ...actual,
    listStudentPracticeAssignments: practiceAssignmentsMock,
  };
});

import Login from "@/pages/login";
import CheckEmail from "@/pages/auth/check-email";
import ConfirmEmail from "@/pages/auth/confirm";
import ForgotPassword from "@/pages/auth/forgot-password";
import ResetPassword from "@/pages/auth/reset-password";
import StudentPractice from "@/pages/student/practice";
import TeacherQuestions from "@/pages/teacher/questions";
import {
  Toast,
  ToastClose,
  ToastProvider,
  ToastViewport,
} from "@/components/ui/toast";

function renderWithQueryClient(component: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>{component}</QueryClientProvider>,
  );
}

async function expectNoAutomatedViolations() {
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations).toEqual([]);
}

describe("Phase 5 accessible interaction contracts", () => {
  beforeEach(() => {
    authState.current = {};
    teacherQuestionBankPageMock.mockReset();
    practiceStatsMock.mockReset().mockResolvedValue([]);
    practiceAssignmentsMock.mockReset().mockResolvedValue([]);
    window.history.replaceState(null, "", "/");
  });

  it("submits the sign-in form with Enter and exposes a named form", async () => {
    const user = userEvent.setup();
    const signIn = vi.fn().mockResolvedValue(undefined);
    authState.current = {
      authMode: "supabase",
      loading: false,
      needsWorkspace: false,
      role: null,
      signIn,
      signUp: vi.fn(),
    };

    render(<Login />);
    await user.type(screen.getByLabelText("Email"), "student@example.com");
    await user.type(screen.getByLabelText("Password"), "safe-password");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith(
        "student@example.com",
        "safe-password",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Sign in with Email" }),
    ).toHaveAttribute("type", "submit");
    await expectNoAutomatedViolations();
  });

  it("routes an entitled student-member to teacher onboarding without a competing redirect", async () => {
    authState.current = {
      authMode: "supabase",
      loading: false,
      needsWorkspace: true,
      role: "student",
      signIn: vi.fn(),
      signUp: vi.fn(),
    };

    render(<Login />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/teacher/onboarding");
    });
  });

  it("names writing-task filters and keeps the task dialog keyboard-submittable", async () => {
    const user = userEvent.setup();
    authState.current = {
      activeWorkspaceId: "11111111-1111-4111-8111-111111111111",
      authMode: "supabase",
      user: { id: "22222222-2222-4222-8222-222222222222" },
    };
    teacherQuestionBankPageMock.mockResolvedValue({
      items: [{
        id: "33333333-3333-4333-8333-333333333333",
        workspace_id: "11111111-1111-4111-8111-111111111111",
        source: "workspace",
        batch_id: null,
        title: "Eine kurze Nachricht",
        prompt: "Schreiben Sie eine kurze Nachricht.",
        level: "A1",
        topic: "Alltag",
        task_type: "writing",
        expected_word_min: 30,
        expected_word_max: 50,
        estimated_minutes: 10,
        is_active: true,
        created_by: "22222222-2222-4222-8222-222222222222",
        created_at: "2026-07-11T00:00:00.000Z",
        updated_at: "2026-07-11T00:00:00.000Z",
      }],
      available_topics: ["Alltag"],
      total_count: 1,
      returned_count: 1,
      page_size: 25,
      has_more: false,
      next_cursor: null,
    });

    renderWithQueryClient(<TeacherQuestions />);

    expect(
      screen.getByRole("textbox", { name: "Search writing tasks" }),
    ).toBeInTheDocument();
    for (const name of [
      "Filter writing tasks by level",
      "Filter writing tasks by topic",
      "Filter writing tasks by task type",
      "Filter writing tasks by status",
    ]) {
      expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    }
    expect(
      (await screen.findAllByRole("switch", { name: /writing task/i })).length,
    ).toBeGreaterThan(0);

    await user.click(
      screen.getByRole("button", { name: "Create Workspace Writing Task" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Create New Writing Task",
    });
    expect(within(dialog).getByLabelText("Level")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Task type")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Save Writing Task" }),
    ).toHaveAttribute("type", "submit");
    await expectNoAutomatedViolations();
  });

  it("makes each assigned worksheet keyboard-operable and exposes its adaptive state", async () => {
    const user = userEvent.setup();
    authState.current = {
      activeWorkspaceId: "11111111-1111-4111-8111-111111111111",
      authMode: "supabase",
      user: { id: "22222222-2222-4222-8222-222222222222" },
    };
    practiceStatsMock.mockResolvedValue([{
      id: "stat-1",
      workspace_id: "11111111-1111-4111-8111-111111111111",
      student_id: "22222222-2222-4222-8222-222222222222",
      grammar_topic_id: "topic-1",
      topic_name: "Verb position",
      topic_slug: "verb-position",
      topic_description: "Practice main-clause verb position.",
      total_minor_issues: 1,
      total_major_issues: 2,
      total_correct_after_practice: 0,
      weakness_level: "unlocked",
      practice_unlocked: true,
      resolution_cycle_id: "cycle-1",
      resolution_cycle_number: 1,
      resolved_through_sequence: 0,
      mastery_pass_count: 0,
      state_reason: "Released feedback unlocked this topic.",
      last_seen_at: "2026-07-11T00:00:00.000Z",
      updated_at: "2026-07-11T00:00:00.000Z",
    }]);
    practiceAssignmentsMock.mockResolvedValue([{
      id: "assignment-1",
      workspace_id: "11111111-1111-4111-8111-111111111111",
      student_id: "22222222-2222-4222-8222-222222222222",
      grammar_topic_id: "topic-1",
      grammar_topic_name: "Verb position",
      grammar_topic_slug: "verb-position",
      grammar_topic_description: "Practice main-clause verb position.",
      practice_test_id: "worksheet-1",
      worksheet_title: "Verb position practice",
      worksheet_level: "A2",
      worksheet_difficulty: "standard",
      worksheet_mini_lesson: null,
      status: "unlocked",
      source: "adaptive",
      assigned_at: "2026-07-11T00:00:00.000Z",
      started_at: null,
      completed_at: null,
      latest_attempt_id: null,
      latest_attempt_status: null,
      score: null,
      max_score: null,
      score_points: null,
      max_score_points: null,
      scoring_version: null,
      evaluation_status: null,
      evaluation_started_at: null,
      evaluation_completed_at: null,
      evaluation_error: null,
      score_percent: null,
      passed: null,
      question_count: 8,
      generation_status: "ready",
      generation_started_at: null,
      generation_completed_at: "2026-07-11T00:00:00.000Z",
      generation_error: null,
      previous_assignment_id: null,
      previous_attempt_id: null,
      repeat_number: 0,
      adaptive_reason: "Released feedback unlocked this topic.",
      adaptive_status: "active",
      resolution_cycle_id: "cycle-1",
      resolution_cycle_number: 1,
      evidence_cutoff_sequence: 0,
    }]);

    renderWithQueryClient(
      <main>
        <StudentPractice />
      </main>,
    );
    expect(
      await screen.findByRole("heading", { name: "Practice unlocked" }),
    ).toBeInTheDocument();
    const worksheetLink = screen.getByRole("link", {
      name: /Start worksheet/i,
    });
    worksheetLink.focus();
    await user.keyboard("{Enter}");

    expect(window.location.pathname).toBe("/student/practice/assignment-1");
    await expectNoAutomatedViolations();
  });

  it("gives the notification close control an accessible name", async () => {
    render(
      <ToastProvider>
        <Toast open>
          <ToastClose />
        </Toast>
        <ToastViewport />
      </ToastProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Dismiss notification" }),
    ).toBeInTheDocument();
    await expectNoAutomatedViolations();
  });

  it("keeps public account-recovery states inside named landmarks", async () => {
    authState.current = {
      authCallbackState: null,
      completePasswordReset: vi.fn(),
      loading: false,
      needsWorkspace: false,
      requestPasswordReset: vi.fn(),
      resendConfirmation: vi.fn(),
      role: null,
      user: null,
    };

    for (const Page of [
      CheckEmail,
      ConfirmEmail,
      ForgotPassword,
      ResetPassword,
    ]) {
      const view = render(<Page />);
      await expectNoAutomatedViolations();
      view.unmount();
    }
  });

  it("does not treat an unrelated authenticated session as an auth callback", () => {
    authState.current = {
      authCallbackState: null,
      completePasswordReset: vi.fn(),
      loading: false,
      needsWorkspace: false,
      role: "student",
      user: { id: "unrelated-user" },
    };

    const confirmation = render(<ConfirmEmail />);
    expect(
      screen.getByRole("heading", { name: "Confirmation link unavailable" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Email confirmed")).not.toBeInTheDocument();
    confirmation.unmount();

    render(<ResetPassword />);
    expect(
      screen.getByText(/reset link is invalid or has expired/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("renders callback success only for the matching callback kind and user", () => {
    const callbackBase = {
      version: 1,
      userId: "callback-user",
      sessionId: "session-1",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    authState.current = {
      authCallbackState: { ...callbackBase, kind: "email_confirmation" },
      completePasswordReset: vi.fn(),
      loading: false,
      needsWorkspace: false,
      role: "student",
      user: { id: "callback-user" },
    };

    const confirmation = render(<ConfirmEmail />);
    expect(
      screen.getByRole("heading", { name: "Email confirmed" }),
    ).toBeInTheDocument();
    confirmation.unmount();

    authState.current = {
      ...authState.current,
      authCallbackState: { ...callbackBase, kind: "password_recovery" },
    };
    render(<ResetPassword />);
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
  });
});
