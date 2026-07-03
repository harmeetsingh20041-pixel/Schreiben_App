import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useLocation } from "wouter";

type Role = "student" | "teacher" | null;

interface AuthContextType {
  role: Role;
  login: (role: Role) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role>(null);
  const [, setLocation] = useLocation();

  useEffect(() => {
    const savedRole = localStorage.getItem("gwc_role") as Role;
    if (savedRole) {
      setRole(savedRole);
    }
  }, []);

  const login = (newRole: Role) => {
    setRole(newRole);
    localStorage.setItem("gwc_role", newRole || "");
    if (newRole === "student") {
      setLocation("/student/dashboard");
    } else if (newRole === "teacher") {
      setLocation("/teacher/dashboard");
    }
  };

  const logout = () => {
    setRole(null);
    localStorage.removeItem("gwc_role");
    setLocation("/");
  };

  return (
    <AuthContext.Provider value={{ role, login, logout }}>
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
