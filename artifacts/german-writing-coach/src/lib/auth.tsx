import { createContext, useContext, useCallback, useEffect, ReactNode, useState } from "react";
import { useLocation } from "wouter";
import type { Session, User } from "@supabase/supabase-js";
import {
  canUseSupabaseAuth,
  createTeacherWorkspace,
  getAuthSnapshot,
  signInWithEmailPassword,
  signOut,
  signUpWithEmailPassword,
  onAuthStateChange,
  type AuthProfile,
  type AuthRole,
  type AuthWorkspaceMembership,
} from "@/services/authService";

type Role = AuthRole;

interface AuthContextType {
  loading: boolean;
  authMode: "mock" | "supabase";
  user: User | null;
  session: Session | null;
  profile: AuthProfile | null;
  workspaceMemberships: AuthWorkspaceMembership[];
  role: Role;
  needsWorkspace: boolean;
  login: (role: Role) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (params: {
    email: string;
    password: string;
    fullName?: string;
    accountType: "student" | "teacher";
  }) => Promise<void>;
  createWorkspace: (workspaceName?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(canUseSupabaseAuth());
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [workspaceMemberships, setWorkspaceMemberships] = useState<AuthWorkspaceMembership[]>([]);
  const [needsWorkspace, setNeedsWorkspace] = useState(false);
  const [role, setRole] = useState<Role>(null);
  const [, setLocation] = useLocation();

  const refreshAuthState = useCallback(async () => {
    if (!canUseSupabaseAuth()) {
      setLoading(false);
      return;
    }

    try {
      const snapshot = await getAuthSnapshot();
      setSession(snapshot.session);
      setUser(snapshot.user);
      setProfile(snapshot.profile);
      setWorkspaceMemberships(snapshot.workspaceMemberships);
      setRole(snapshot.role);
      setNeedsWorkspace(snapshot.needsWorkspace);
    } catch (error) {
      console.error("Unable to load Supabase auth state", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const savedRole = localStorage.getItem("gwc_role") as Role;
    if (savedRole && !canUseSupabaseAuth()) {
      setRole(savedRole);
    }
    void refreshAuthState();
    return onAuthStateChange(() => {
      void refreshAuthState();
    });
  }, [refreshAuthState]);

  const login = (newRole: Role) => {
    setRole(newRole);
    localStorage.setItem("gwc_role", newRole || "");
    if (newRole === "student") {
      setLocation("/student/dashboard");
    } else if (newRole === "teacher") {
      setLocation("/teacher/dashboard");
    }
  };

  const signIn = async (email: string, password: string) => {
    setLoading(true);
    try {
      await signInWithEmailPassword(email, password);
      await refreshAuthState();
    } finally {
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
      await signUpWithEmailPassword(params);
      await refreshAuthState();
    } finally {
      setLoading(false);
    }
  };

  const createWorkspace = async (workspaceName = "My German Class") => {
    setLoading(true);
    try {
      await createTeacherWorkspace(workspaceName);
      await refreshAuthState();
      setLocation("/teacher/dashboard");
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    setRole(null);
    setSession(null);
    setUser(null);
    setProfile(null);
    setWorkspaceMemberships([]);
    setNeedsWorkspace(false);
    localStorage.removeItem("gwc_role");
    await signOut();
    setLocation("/");
  };

  return (
    <AuthContext.Provider
      value={{
        loading,
        authMode: canUseSupabaseAuth() ? "supabase" : "mock",
        user,
        session,
        profile,
        workspaceMemberships,
        role,
        needsWorkspace,
        login,
        signIn,
        signUp,
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
