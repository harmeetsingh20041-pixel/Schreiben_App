import type { Session } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  authCallback: null as
    | ((event: string, session: Session | null) => void)
    | null,
  getAuthSnapshot: vi.fn(),
  getCurrentSession: vi.fn(),
  getMfaState: vi.fn(),
  prefetchTeacherOverviewQueries: vi.fn(async () => undefined),
  signInWithEmailPassword: vi.fn(),
}));

vi.mock("@/services/authService", () => ({
  canUseSupabaseAuth: () => true,
  clearAuthCallbackState: vi.fn(),
  completePasswordRecovery: vi.fn(),
  consumeAuthCallbackIntent: vi.fn(),
  createTeacherWorkspace: vi.fn(),
  getAuthSnapshot: mocks.getAuthSnapshot,
  getCurrentSession: mocks.getCurrentSession,
  getMfaState: mocks.getMfaState,
  hasPendingAuthCallbackIntent: vi.fn(() => false),
  isRecentEmailConfirmationSession: vi.fn(() => false),
  persistAuthCallbackState: vi.fn(() => null),
  readStoredAuthCallbackState: vi.fn(() => null),
  requestPasswordResetEmail: vi.fn(),
  resendSignUpConfirmation: vi.fn(),
  signInWithEmailPassword: mocks.signInWithEmailPassword,
  signOut: vi.fn(),
  signUpWithEmailPassword: vi.fn(),
  onAuthStateChange: vi.fn(
    (callback: (event: string, session: Session | null) => void) => {
      mocks.authCallback = callback;
      return vi.fn();
    },
  ),
}));

vi.mock("@/lib/supabaseClient", () => ({
  clearSupabaseBrowserSession: vi.fn(),
}));

vi.mock("@/lib/teacherOverviewPrefetch", () => ({
  prefetchTeacherOverviewQueries: mocks.prefetchTeacherOverviewQueries,
}));

import { AuthProvider, useAuth } from "@/lib/auth";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function emptySnapshot() {
  return {
    session: null,
    user: null,
    profile: null,
    workspaceMemberships: [],
    activeMembershipId: null,
    activeWorkspaceId: null,
    role: null,
    needsWorkspace: false,
    isPlatformAdmin: false,
    teacherEntitled: false,
    canCreateTeacherWorkspace: false,
  } as const;
}

function teacherSnapshot(session: Session) {
  return {
    session,
    user: session.user,
    profile: {
      id: session.user.id,
      full_name: "Teacher",
      email: "teacher@example.invalid",
      global_role: "teacher" as const,
    },
    workspaceMemberships: [
      {
        id: "membership-1",
        workspace_id: "workspace-1",
        user_id: session.user.id,
        role: "teacher" as const,
      },
    ],
    activeMembershipId: "membership-1",
    activeWorkspaceId: "workspace-1",
    role: "teacher" as const,
    needsWorkspace: false,
    isPlatformAdmin: false,
    teacherEntitled: true,
    canCreateTeacherWorkspace: true,
  };
}

function adminSnapshot(session: Session) {
  return {
    ...emptySnapshot(),
    session,
    user: session.user,
    profile: {
      id: session.user.id,
      full_name: "Administrator",
      email: "admin@example.invalid",
      global_role: "platform_admin" as const,
    },
    role: "student" as const,
    isPlatformAdmin: true,
  };
}

function session(userId: string) {
  return {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_in: 3600,
    token_type: "bearer",
    user: { id: userId },
  } as Session;
}

function AuthStateProbe() {
  const { loading, role, user } = useAuth();
  return (
    <p data-testid="auth-state">
      {loading ? "loading" : user ? `${role}:${user.id}` : "signed-out"}
    </p>
  );
}

function SignInProbe() {
  const { signIn } = useAuth();
  return (
    <button
      type="button"
      onClick={() => void signIn("teacher@example.invalid", "password")}
    >
      Sign in
    </button>
  );
}

function AdminMfaProbe() {
  const { platformAdminMfaReady } = useAuth();
  return <p>{platformAdminMfaReady ? "admin-ready" : "admin-mfa-required"}</p>;
}

function wrapper(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

describe("AuthProvider event ordering", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    mocks.authCallback = null;
    mocks.getAuthSnapshot.mockReset();
    mocks.getCurrentSession.mockReset();
    mocks.getMfaState.mockReset();
    mocks.prefetchTeacherOverviewQueries.mockClear();
    mocks.signInWithEmailPassword.mockReset();
  });

  it("does not let an older signed-in refresh overwrite a newer signed-out event", async () => {
    const oldSession = session("old-user");
    const oldRefresh = deferred<ReturnType<typeof teacherSnapshot>>();
    mocks.getAuthSnapshot.mockImplementation(
      (_preferredMembershipId: string | null, eventSession?: Session | null) =>
        eventSession === null
          ? Promise.resolve(emptySnapshot())
          : oldRefresh.promise,
    );

    render(wrapper(<AuthStateProbe />));
    expect(mocks.authCallback).not.toBeNull();

    act(() => mocks.authCallback?.("SIGNED_IN", oldSession));
    await waitFor(() => expect(mocks.getAuthSnapshot).toHaveBeenCalledOnce());

    act(() => mocks.authCallback?.("SIGNED_OUT", null));
    await waitFor(() => expect(mocks.getAuthSnapshot).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-out"),
    );

    await act(async () => {
      oldRefresh.resolve(teacherSnapshot(oldSession));
      await oldRefresh.promise;
    });

    expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-out");
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
    expect(mocks.prefetchTeacherOverviewQueries).not.toHaveBeenCalled();
  });

  it("prefetches Overview only after a current trusted teacher snapshot wins", async () => {
    const currentSession = session("teacher-user");
    window.history.replaceState({}, "", "/teacher/dashboard");
    mocks.getAuthSnapshot.mockResolvedValue(teacherSnapshot(currentSession));

    render(wrapper(<AuthStateProbe />));
    act(() => mocks.authCallback?.("INITIAL_SESSION", currentSession));

    await waitFor(() =>
      expect(screen.getByTestId("auth-state")).toHaveTextContent(
        "teacher:teacher-user",
      ),
    );
    expect(mocks.getAuthSnapshot).toHaveBeenCalledWith(null, currentSession);
    expect(mocks.prefetchTeacherOverviewQueries).toHaveBeenCalledWith(
      expect.any(QueryClient),
      "workspace-1",
    );

    act(() => mocks.authCallback?.("USER_UPDATED", currentSession));
    await waitFor(() => expect(mocks.getAuthSnapshot).toHaveBeenCalledTimes(2));
    expect(mocks.prefetchTeacherOverviewQueries).toHaveBeenCalledTimes(1);

    act(() =>
      mocks.authCallback?.("MFA_CHALLENGE_VERIFIED", currentSession),
    );
    await waitFor(() => expect(mocks.getAuthSnapshot).toHaveBeenCalledTimes(3));
    expect(mocks.prefetchTeacherOverviewQueries).toHaveBeenCalledTimes(1);
  });

  it("passes the explicit password sign-in session into trusted refresh", async () => {
    const user = userEvent.setup();
    const signedInSession = session("signed-in-teacher");
    mocks.signInWithEmailPassword.mockResolvedValue(signedInSession);
    mocks.getAuthSnapshot.mockResolvedValue(teacherSnapshot(signedInSession));

    render(wrapper(<SignInProbe />));
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(mocks.getAuthSnapshot).toHaveBeenCalledWith(null, signedInSession),
    );
    expect(mocks.getCurrentSession).not.toHaveBeenCalled();
  });

  it("fails admin routing closed until AAL2 and two verified factors load", async () => {
    const currentSession = session("admin-user");
    mocks.getAuthSnapshot.mockResolvedValue(adminSnapshot(currentSession));
    mocks.getMfaState.mockResolvedValue({
      currentLevel: "aal1",
      nextLevel: "aal2",
      totpFactors: [],
      verifiedTotpFactors: [],
    });

    render(wrapper(<AdminMfaProbe />));
    act(() => mocks.authCallback?.("INITIAL_SESSION", currentSession));

    expect(await screen.findByText("admin-mfa-required")).toBeInTheDocument();
    await waitFor(() => expect(mocks.getMfaState).toHaveBeenCalledOnce());
  });
});
