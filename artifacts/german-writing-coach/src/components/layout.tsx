import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { LogOut, BookOpen, PenTool, LayoutDashboard, Users, FileText, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Layout({ children }: { children: ReactNode }) {
  const { role, logout } = useAuth();
  const [location] = useLocation();

  const isStudent = role === "student";
  const isTeacher = role === "teacher";

  const navItems = isStudent
    ? [
        { label: "Dashboard", href: "/student/dashboard", icon: <LayoutDashboard className="w-4 h-4 mr-2" /> },
        { label: "Practice", href: "/student/questions", icon: <PenTool className="w-4 h-4 mr-2" /> },
        { label: "History", href: "/student/history", icon: <BookOpen className="w-4 h-4 mr-2" /> },
      ]
    : isTeacher
    ? [
        { label: "Dashboard", href: "/teacher/dashboard", icon: <LayoutDashboard className="w-4 h-4 mr-2" /> },
        { label: "Batches", href: "/teacher/batches", icon: <Users className="w-4 h-4 mr-2" /> },
        { label: "Students", href: "/teacher/students", icon: <BookOpen className="w-4 h-4 mr-2" /> },
        { label: "Questions", href: "/teacher/questions", icon: <FileText className="w-4 h-4 mr-2" /> },
        { label: "Submissions", href: "/teacher/submissions", icon: <CheckCircle className="w-4 h-4 mr-2" /> },
      ]
    : [];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-40 w-full border-b border-border bg-card/80 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 font-bold text-xl text-primary tracking-tight">
              <div className="w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center">
                <PenTool className="w-5 h-5" />
              </div>
              German Writing Coach
            </div>
            
            {role && (
              <nav className="hidden md:flex items-center gap-1 ml-4">
                {navItems.map((item) => {
                  const isActive = location === item.href || location.startsWith(`${item.href}/`);
                  return (
                    <Link key={item.href} href={item.href} className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center ${isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                      {item.icon}
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            )}
          </div>

          <div className="flex items-center gap-4">
            {role && (
              <div className="flex items-center gap-4">
                <span className="text-sm text-muted-foreground hidden sm:inline-block">
                  Logged in as <span className="font-semibold text-foreground capitalize">{role}</span>
                </span>
                <Button variant="ghost" size="sm" onClick={logout}>
                  <LogOut className="w-4 h-4 mr-2" />
                  Logout
                </Button>
              </div>
            )}
          </div>
        </div>
      </header>
      
      <main className="flex-1 flex flex-col">
        {children}
      </main>
    </div>
  );
}
