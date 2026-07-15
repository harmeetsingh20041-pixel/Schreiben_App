import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  ReactNode,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import type { Session, User } from "@supabase/supabase-js";
import {
  canUseSupabaseAuth,
  clearAuthCallbackState,
  completePasswordRecovery,
  consumeAuthCallbackIntent,
  createTeacherWorkspace,
  getAuthSnapshot,
  getCurrentSession,
  getMfaState,
  hasPendingAuthCallbackIntent,
  isRecentEmailConfirmationSession,
  persistAuthCallbackState,
  readStoredAuthCallbackState,
  requestPasswordResetEmail,
  resendSignUpConfirmation,
  signInWithEmailPassword,
  signOut,
  signUpWithEmailPassword,
  onAuthStateChange,
  type AuthCallbackState,
  type AuthProfile,
  type AuthRole,
  type SignUpResult,
  type AuthWorkspaceMembership,
  type MfaState,
} from "@/services/authService";
import { clearSupabaseBrowserSession } from "@/lib/supabaseClient";
import { isTeacherOverviewPath } from "@/lib/routePaths";
import { prefetchTeacherOverviewQueries } from "@/lib/teacherOverviewPrefetch";

type Role = AuthRole;

interface AuthContextType {
  loading: boolean;
  authMode: "supabase" | "unavailable";
  user: User | null;
  session: Session | null;
  profile: AuthProfile | null;
  workspaceMemberships: AuthWorkspaceMembership[];
  activeMembershipId: string | null;
  activeWorkspaceId: string | null;
  role: Role;
  needsWorkspace: boolean;
  isPlatformAdmin: boolean;
  mfaState: MfaState | null;
  platformAdminMfaReady: boolean;
  teacherEntitled: boolean;
  canCreateTeacherWorkspace: boolean;
  authCallbackState: AuthCallbackState | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (params: {
    email: string;
    password: string;
    fullName?: string;
    accountType: "student" | "teacher";
  }) => Promise<SignUpResult>;
  resendConfirmation: (email: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  completePasswordReset: (password: string) => Promise<void>;
  refreshAccess: () => Promise<void>;
  selectActiveMembership: (membershipId: string) => Promise<void>;
  createWorkspace: (workspaceName?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const cachedUserIdRef = useRef<string | null>(null);
  const overviewPrefetchKeyRef = useRef<string | null>(null);
  const authRefreshIdRef = useRef(0);
  const explicitSignInRefreshRef = useRef(false);
  const [loading, setLoading] = useState(canUseSupabaseAuth());
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [workspaceMemberships, setWorkspaceMemberships] = useState<
    AuthWorkspaceMembership[]
  >([]);
  const [activeMembershipId, setActiveMembershipId] = useState<string | null>(
    null,
  );
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    null,
  );
  const [needsWorkspace, setNeedsWorkspace] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [mfaState, setMfaState] = useState<MfaState | null>(null);
  const [teacherEntitled, setTeacherEntitled] = useState(false);
  const [canCreateTeacherWorkspace, setCanCreateTeacherWorkspace] =
    useState(false);
  const [authCallbackState, setAuthCallbackState] =
    useState<AuthCallbackState | null>(null);
  const [role, setRole] = useState<Role>(null);
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (!isTeacherOverviewPath(location)) {
      overviewPrefetchKeyRef.current = null;
    }
  }, [location]);

  const refreshAuthState = useCallback(
    async (
      options: {
        throwOnFailure?: boolean;
        sessionFromAuthEvent?: Session | null;
      } = {},
    ) => {
      const refreshId = ++authRefreshIdRef.current;
      if (!canUseSupabaseAuth()) {
        setLoading(false);
        return;
      }

      try {
        const preferredMembershipId = localStorage.getItem(
          "gwc_active_membership_id",
        );
        const snapshot = await getAuthSnapshot(
          preferredMembershipId,
          options.sessionFromAuthEvent,
        );
        if (refreshId !== authRefreshIdRef.current) return;
        let nextMfaState: MfaState | null = null;
        if (snapshot.isPlatformAdmin) {
          try {
            nextMfaState = await getMfaState();
          } catch {
            // Routing fails closed to the MFA screen. The database remains the
            // authority for every administrator read and mutation.
          }
        }
        if (refreshId !== authRefreshIdRef.current) return;
        const nextUserId = snapshot.user?.id ?? null;
        if (cachedUserIdRef.current !== nextUserId) {
          queryClient.clear();
          cachedUserIdRef.current = nextUserId;
          overviewPrefetchKeyRef.current = null;
        }
        if (
          snapshot.role === "teacher" &&
          snapshot.activeWorkspaceId &&
          isTeacherOverviewPath(window.location.pathname)
        ) {
          // The fresh get_auth_context response has already passed the exact
          // user-id check in getAuthSnapshot. Start server-authorized Overview
          // reads before the lazy route mounts; matching React Query keys
          // deduplicate the page consumers. Prefetch failures never grant a
          // role and remain isolated from the authoritative auth transition.
          const overviewPrefetchKey = `${nextUserId}:${snapshot.activeWorkspaceId}:${window.location.pathname}`;
          if (overviewPrefetchKeyRef.current !== overviewPrefetchKey) {
            overviewPrefetchKeyRef.current = overviewPrefetchKey;
            void prefetchTeacherOverviewQueries(
              queryClient,
              snapshot.activeWorkspaceId,
            );
          }
        } else {
          overviewPrefetchKeyRef.current = null;
        }
        setSession(snapshot.session);
        setUser(snapshot.user);
        setProfile(snapshot.profile);
        setWorkspaceMemberships(snapshot.workspaceMemberships);
        setActiveMembershipId(snapshot.activeMembershipId);
        setActiveWorkspaceId(snapshot.activeWorkspaceId);
        setRole(snapshot.role);
        setNeedsWorkspace(snapshot.needsWorkspace);
        setIsPlatformAdmin(snapshot.isPlatformAdmin);
        setMfaState(nextMfaState);
        setTeacherEntitled(snapshot.teacherEntitled);
        setCanCreateTeacherWorkspace(snapshot.canCreateTeacherWorkspace);
        if (snapshot.session) {
          setAuthCallbackState(readStoredAuthCallbackState(snapshot.session));
        }
        if (snapshot.activeMembershipId) {
          localStorage.setItem(
            "gwc_active_membership_id",
            snapshot.activeMembershipId,
          );
        } else {
          localStorage.removeItem("gwc_active_membership_id");
        }
      } catch (error) {
        if (refreshId !== authRefreshIdRef.current) return;
        // Fail closed. Stale client state must never grant a role after trusted
        // membership/profile context fails to load.
        queryClient.clear();
        cachedUserIdRef.current = null;
        overviewPrefetchKeyRef.current = null;
        let callbackSession: Session | null = null;
        try {
          callbackSession = await getCurrentSession();
        } catch {
          // The role context and callback session both remain unavailable.
        }
        if (refreshId !== authRefreshIdRef.current) return;
        setSession(callbackSession);
        setUser(callbackSession?.user ?? null);
        setProfile(null);
        setWorkspaceMemberships([]);
        setActiveMembershipId(null);
        setActiveWorkspaceId(null);
        setRole(null);
        setNeedsWorkspace(false);
        setIsPlatformAdmin(false);
        setMfaState(null);
        setTeacherEntitled(false);
        setCanCreateTeacherWorkspace(false);
        setAuthCallbackState(readStoredAuthCallbackState(callbackSession));
        // Background refreshes fail closed and may recover on the next focus or
        // visibility refresh. An explicit sign-in must instead surface the
        // already-sanitized trusted-context error so valid credentials never
        // appear to succeed while leaving the user silently on the login page.
        if (options.throwOnFailure) throw error;
      } finally {
        if (refreshId === authRefreshIdRef.current) setLoading(false);
      }
    },
    [queryClient],
  );

  useEffect(() => {
    // A role is accepted only from the server-managed auth context. Remove a
    // stale value left by pre-V1 showcase builds so it can never grant access.
    localStorage.removeItem("gwc_role");
    // Supabase always emits INITIAL_SESSION after a listener is registered.
    // Let that single event hydrate the trusted context instead of starting a
    // duplicate getUser request that can outlive a route change and surface as
    // a misleading browser transport error.
    return onAuthStateChange((event, eventSession) => {
      // Invalidate any context read that started before this auth event.
      authRefreshIdRef.current += 1;
      if (event === "PASSWORD_RECOVERY" && eventSession) {
        const callbackState = persistAuthCallbackState(
          "password_recovery",
          eventSession,
        );
        if (callbackState) {
          consumeAuthCallbackIntent("password_recovery");
          setAuthCallbackState(callbackState);
          setLocation("/auth/reset-password");
        }
      } else if (
        eventSession &&
        ["INITIAL_SESSION", "SIGNED_IN", "USER_UPDATED"].includes(event) &&
        hasPendingAuthCallbackIntent("email_confirmation") &&
        isRecentEmailConfirmationSession(eventSession)
      ) {
        const callbackState = persistAuthCallbackState(
          "email_confirmation",
          eventSession,
        );
        if (callbackState) {
          consumeAuthCallbackIntent("email_confirmation");
          setAuthCallbackState(callbackState);
        }
      } else if (event === "SIGNED_OUT") {
        clearAuthCallbackState();
        setAuthCallbackState(null);
      }
      // Email/password sign-in performs and awaits its own trusted-context
      // refresh below. Suppress the duplicate SIGNED_IN refresh so a second
      // getUser request cannot linger across the first protected navigation.
      if (event === "SIGNED_IN" && explicitSignInRefreshRef.current) return;
      // Defer Supabase calls until the auth callback has returned. Calling
      // getUser/getSession inside the callback can block later auth events.
      window.setTimeout(
        () => void refreshAuthState({ sessionFromAuthEvent: eventSession }),
        0,
      );
    });
  }, [refreshAuthState, setLocation]);

  useEffect(() => {
    if (!canUseSupabaseAuth() || !user?.id) return;
    let scheduledRefresh: number | null = null;
    const scheduleVisibleMembershipRefresh = () => {
      if (document.visibilityState !== "visible" || scheduledRefresh !== null)
        return;
      // Focus and visibilitychange normally fire together. Coalesce them and
      // give an imminent route change time to cancel the request on unmount.
      scheduledRefresh = window.setTimeout(() => {
        scheduledRefresh = null;
        void refreshAuthState();
      }, 250);
    };
    const intervalId = window.setInterval(
      scheduleVisibleMembershipRefresh,
      30_000,
    );
    window.addEventListener("focus", scheduleVisibleMembershipRefresh);
    document.addEventListener(
      "visibilitychange",
      scheduleVisibleMembershipRefresh,
    );
    return () => {
      window.clearInterval(intervalId);
      if (scheduledRefresh !== null) window.clearTimeout(scheduledRefresh);
      window.removeEventListener("focus", scheduleVisibleMembershipRefresh);
      document.removeEventListener(
        "visibilitychange",
        scheduleVisibleMembershipRefresh,
      );
    };
  }, [refreshAuthState, user?.id]);

  useEffect(() => {
    if (!authCallbackState) return;
    const remainingMs = authCallbackState.expiresAt - Date.now();
    if (remainingMs <= 0) {
      clearAuthCallbackState();
      setAuthCallbackState(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      clearAuthCallbackState();
      setAuthCallbackState(null);
    }, remainingMs);
    return () => window.clearTimeout(timeout);
  }, [authCallbackState]);

  const signIn = async (email: string, password: string) => {
    setLoading(true);
    explicitSignInRefreshRef.current = true;
    try {
      clearAuthCallbackState();
      setAuthCallbackState(null);
      const signedInSession = await signInWithEmailPassword(email, password);
      await refreshAuthState({
        throwOnFailure: true,
        sessionFromAuthEvent: signedInSession,
      });
    } finally {
      explicitSignInRefreshRef.current = false;
      setLoading(false);
    }
  };

  const signUp = async (params: {
    email: string;
    password: string;
    fullName?: string;
    accountType: "student" | "teacher";
  }) => {
    setLoading(true);
    try {
      clearAuthCallbackState();
      setAuthCallbackState(null);
      const result = await signUpWithEmailPassword(params);
      await refreshAuthState();
      return result;
    } finally {
      setLoading(false);
    }
  };

  const resendConfirmation = async (email: string) => {
    await resendSignUpConfirmation(email);
  };

  const requestPasswordReset = async (email: string) => {
    await requestPasswordResetEmail(email);
  };

  const clearAuthState = () => {
    clearSupabaseBrowserSession();
    queryClient.clear();
    cachedUserIdRef.current = null;
    setRole(null);
    setSession(null);
    setUser(null);
    setProfile(null);
    setWorkspaceMemberships([]);
    setActiveMembershipId(null);
    setActiveWorkspaceId(null);
    setNeedsWorkspace(false);
    setIsPlatformAdmin(false);
    setMfaState(null);
    setTeacherEntitled(false);
    setCanCreateTeacherWorkspace(false);
    setAuthCallbackState(null);
    clearAuthCallbackState();
    localStorage.removeItem("gwc_role");
    localStorage.removeItem("gwc_active_membership_id");
    sessionStorage.removeItem("gwc_password_recovery");
  };

  const completePasswordReset = async (password: string) => {
    setLoading(true);
    let passwordUpdated = false;
    try {
      await completePasswordRecovery(password, authCallbackState);
      passwordUpdated = true;
      setAuthCallbackState(null);
      await signOut();
    } finally {
      if (passwordUpdated) clearAuthState();
      setLoading(false);
    }
  };

  const selectActiveMembership = async (membershipId: string) => {
    if (
      !workspaceMemberships.some((membership) => membership.id === membershipId)
    ) {
      return;
    }
    localStorage.setItem("gwc_active_membership_id", membershipId);
    setLoading(true);
    await refreshAuthState();
  };

  const refreshAccess = async () => {
    setLoading(true);
    try {
      await refreshAuthState({ throwOnFailure: true });
    } finally {
      setLoading(false);
    }
  };

  const createWorkspace = async (workspaceName = "My German Class") => {
    setLoading(true);
    try {
      const created = await createTeacherWorkspace(workspaceName);
      localStorage.setItem("gwc_active_membership_id", created.membershipId);
      await refreshAuthState();
      setLocation("/teacher/batches?create=first-class");
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      await signOut();
    } catch {
      // A network/provider error must not leave a usable local session or
      // another student's cached data in this browser.
    } finally {
      clearAuthState();
      setLocation("/");
    }
  };

  return (
    <AuthContext.Provider
      value={{
        loading,
        authMode: canUseSupabaseAuth() ? "supabase" : "unavailable",
        user,
        session,
        profile,
        workspaceMemberships,
        activeMembershipId,
        activeWorkspaceId,
        role,
        needsWorkspace,
        isPlatformAdmin,
        mfaState,
        platformAdminMfaReady:
          isPlatformAdmin &&
          mfaState?.currentLevel === "aal2" &&
          mfaState.verifiedTotpFactors.length >= 2,
        teacherEntitled,
        canCreateTeacherWorkspace,
        authCallbackState,
        signIn,
        signUp,
        resendConfirmation,
        requestPasswordReset,
        completePasswordReset,
        refreshAccess,
        selectActiveMembership,
        createWorkspace,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
