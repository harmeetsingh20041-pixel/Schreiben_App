import type { Session, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authClient = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
}));
const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabaseClient", () => ({
  getSupabaseClient: () => ({ auth: authClient, rpc }),
  isSupabaseConfigured: true,
}));

import {
  AUTH_CALLBACK_TTL_MS,
  completePasswordRecovery,
  createAuthCallbackState,
  detectAuthCallbackIntent,
  getAuthSnapshot,
  isAuthCallbackStateValid,
  isRecentEmailConfirmationSession,
  persistAuthCallbackState,
  readAuthCallbackState,
  resolveAuthAccess,
  signInWithEmailPassword,
  type AuthWorkspaceMembership,
} from "@/services/authService";

function makeSession(
  userId: string,
  sessionId: string,
  now: number,
  confirmedAt = new Date(now).toISOString(),
): Session {
  const payload = Buffer.from(
    JSON.stringify({ session_id: sessionId }),
  ).toString("base64url");
  const user = {
    id: userId,
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date(now - 60_000).toISOString(),
    email_confirmed_at: confirmedAt,
  } as User;
  return {
    access_token: `header.${payload}.signature`,
    refresh_token: "refresh-token",
    expires_in: 3600,
    expires_at: Math.floor((now + 3_600_000) / 1000),
    token_type: "bearer",
    user,
  } as Session;
}

function studentMembership(id = "student-membership"): AuthWorkspaceMembership {
  return {
    id,
    workspace_id: "student-workspace",
    user_id: "teacher-user",
    role: "student",
  };
}

describe("session-bound auth callback state", () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);

  beforeEach(() => {
    sessionStorage.clear();
    authClient.getSession.mockReset();
    authClient.signInWithPassword.mockReset();
    authClient.updateUser.mockReset();
    authClient.updateUser.mockResolvedValue({ error: null });
    rpc.mockReset();
  });

  it("returns the exact password sign-in session for trusted refresh reuse", async () => {
    const session = makeSession("user-1", "session-1", now);
    authClient.signInWithPassword.mockResolvedValue({
      data: { session },
      error: null,
    });

    await expect(
      signInWithEmailPassword(" teacher@example.invalid ", "password"),
    ).resolves.toBe(session);
    expect(authClient.signInWithPassword).toHaveBeenCalledWith({
      email: "teacher@example.invalid",
      password: "password",
    });
  });

  it("fails closed when password auth returns no reusable session", async () => {
    authClient.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    await expect(
      signInWithEmailPassword("teacher@example.invalid", "password"),
    ).rejects.toMatchObject({ code: "auth_sign_in_failed" });
  });

  it("accepts only the expected user, session, callback kind, and short TTL", () => {
    const session = makeSession("user-1", "session-1", now);
    const otherSession = makeSession("user-1", "session-2", now);
    const state = createAuthCallbackState("password_recovery", session, now);

    expect(
      isAuthCallbackStateValid(
        state,
        "password_recovery",
        session,
        now + 1_000,
      ),
    ).toBe(true);
    expect(
      isAuthCallbackStateValid(
        state,
        "email_confirmation",
        session,
        now + 1_000,
      ),
    ).toBe(false);
    expect(
      isAuthCallbackStateValid(
        state,
        "password_recovery",
        otherSession,
        now + 1_000,
      ),
    ).toBe(false);
    expect(
      isAuthCallbackStateValid(
        state,
        "password_recovery",
        session,
        now + AUTH_CALLBACK_TTL_MS,
      ),
    ).toBe(false);
  });

  it("restores a persisted marker only for its matching session", () => {
    const session = makeSession("user-1", "session-1", now);
    const state = persistAuthCallbackState("email_confirmation", session, now);

    expect(
      readAuthCallbackState("email_confirmation", session, now + 1_000),
    ).toEqual(state);
    expect(
      readAuthCallbackState(
        "email_confirmation",
        makeSession("user-2", "session-2", now),
        now + 1_000,
      ),
    ).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("fails password updates closed without the matching recovery marker", async () => {
    const session = makeSession("user-1", "session-1", now);
    authClient.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });

    await expect(
      completePasswordRecovery("new-password", null),
    ).rejects.toMatchObject({
      code: "auth_session_expired",
    });
    expect(authClient.updateUser).not.toHaveBeenCalled();
  });

  it("rejects a recovery marker created for a different session", async () => {
    const markerSession = makeSession("user-1", "session-1", now);
    const currentSession = makeSession("user-1", "session-2", now);
    const state = persistAuthCallbackState(
      "password_recovery",
      markerSession,
      now,
    );
    authClient.getSession.mockResolvedValue({
      data: { session: currentSession },
      error: null,
    });

    await expect(
      completePasswordRecovery("new-password", state),
    ).rejects.toMatchObject({
      code: "auth_session_expired",
    });
    expect(authClient.updateUser).not.toHaveBeenCalled();
  });

  it("updates once with a matching recovery marker and consumes it", async () => {
    const currentTime = Date.now();
    const session = makeSession("user-1", "session-1", currentTime);
    const state = persistAuthCallbackState("password_recovery", session);
    authClient.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });

    await completePasswordRecovery("new-password", state);

    expect(authClient.updateUser).toHaveBeenCalledOnce();
    expect(authClient.updateUser).toHaveBeenCalledWith({
      password: "new-password",
    });
    expect(sessionStorage.length).toBe(0);
  });

  it("recognizes only explicit, non-error callback URLs and recent confirmations", () => {
    expect(
      detectAuthCallbackIntent({
        pathname: "/auth/reset-password",
        search: "?code=recovery-code",
        hash: "",
      }),
    ).toBe("password_recovery");
    expect(
      detectAuthCallbackIntent({
        pathname: "/auth/confirm",
        search: "",
        hash: "#type=signup&access_token=token",
      }),
    ).toBeNull();
    expect(
      detectAuthCallbackIntent({
        pathname: "/auth/confirm",
        search: "?error_code=otp_expired",
        hash: "",
      }),
    ).toBeNull();
    expect(
      detectAuthCallbackIntent({
        pathname: "/auth/confirm",
        search: "",
        hash: "",
      }),
    ).toBeNull();

    expect(
      isRecentEmailConfirmationSession(
        makeSession("user-1", "session-1", now),
        now + 1_000,
      ),
    ).toBe(true);
    expect(
      isRecentEmailConfirmationSession(
        makeSession(
          "user-1",
          "session-1",
          now,
          new Date(now - AUTH_CALLBACK_TTL_MS - 1).toISOString(),
        ),
        now,
      ),
    ).toBe(false);
  });
});

describe("trusted auth-event session bootstrap", () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);

  function trustedContext(userId: string) {
    return {
      user_id: userId,
      full_name: "Test Teacher",
      email: "teacher@example.invalid",
      global_role: "teacher",
      teacher_entitled: true,
      teacher_workspace_count: 1,
      teacher_workspace_limit: 2,
      can_create_teacher_workspace: true,
      memberships: [
        {
          membership_id: "teacher-membership",
          workspace_id: "teacher-workspace",
          workspace_name: "Teacher Workspace",
          workspace_slug: "teacher-workspace",
          role: "teacher",
          created_at: new Date(now).toISOString(),
        },
      ],
    };
  }

  beforeEach(() => {
    authClient.getSession.mockReset();
    rpc.mockReset();
  });

  it("uses the supplied auth-event session and still requires the trusted RPC", async () => {
    const session = makeSession("user-1", "session-1", now);
    rpc.mockResolvedValue({ data: trustedContext("user-1"), error: null });

    const snapshot = await getAuthSnapshot("teacher-membership", session);

    expect(authClient.getSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("get_auth_context");
    expect(snapshot).toMatchObject({
      session,
      user: session.user,
      activeMembershipId: "teacher-membership",
      activeWorkspaceId: "teacher-workspace",
      role: "teacher",
    });
  });

  it("rejects an auth-event session that disagrees with the server user", async () => {
    const session = makeSession("user-1", "session-1", now);
    rpc.mockResolvedValue({ data: trustedContext("user-2"), error: null });

    await expect(getAuthSnapshot(null, session)).rejects.toMatchObject({
      code: "auth_context_failed",
    });
    expect(authClient.getSession).not.toHaveBeenCalled();
  });

  it("treats an explicit signed-out event as empty without a trusted read", async () => {
    const snapshot = await getAuthSnapshot(undefined, null);

    expect(authClient.getSession).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      session: null,
      user: null,
      workspaceMemberships: [],
      activeMembershipId: null,
      activeWorkspaceId: null,
      role: null,
    });
  });
});

describe("teacher onboarding access resolution", () => {
  it("does not let a student membership override entitled teacher onboarding", () => {
    const result = resolveAuthAccess(
      [studentMembership()],
      "student-membership",
      true,
      true,
    );

    expect(result).toMatchObject({
      activeMembership: null,
      role: "teacher",
      needsWorkspace: true,
    });
    expect(result.workspaceMemberships).toHaveLength(1);
  });

  it("keeps a non-entitled student in the selected student workspace", () => {
    const membership = studentMembership();
    const result = resolveAuthAccess([membership], membership.id, false, false);

    expect(result).toMatchObject({
      activeMembership: membership,
      role: "student",
      needsWorkspace: false,
    });
  });

  it("ignores a stale preferred membership outside the server-returned set", () => {
    const student = studentMembership();
    const teacher: AuthWorkspaceMembership = {
      id: "teacher-membership",
      workspace_id: "teacher-workspace",
      user_id: "teacher-user",
      role: "teacher",
    };

    const result = resolveAuthAccess(
      [student, teacher],
      "stale-local-membership",
      true,
      true,
    );

    expect(result.activeMembership).toEqual(teacher);
    expect(result.role).toBe("teacher");
    expect(result.needsWorkspace).toBe(false);
  });
});
