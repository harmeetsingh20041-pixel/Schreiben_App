import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import {
  LogOut,
  BookOpen,
  PenTool,
  LayoutDashboard,
  Users,
  FileText,
  ClipboardCheck,
  GraduationCap,
  Menu,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { StudentClassSwitcher } from "@/components/student-class-switcher";
import { StudentJoinClassDialog } from "@/components/student-join-class-dialog";

export function Layout({ children }: { children: ReactNode }) {
  const {
    activeMembershipId,
    isPlatformAdmin,
    needsWorkspace,
    role,
    logout,
    selectActiveMembership,
    workspaceMemberships,
  } = useAuth();
  const [location] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isStudent = role === "student";
  const isTeacher = role === "teacher";
  const isAdminView = isPlatformAdmin && location.startsWith("/admin/");
  const hasNavigation = isAdminView || Boolean(role);

  const navItems = isAdminView
    ? [
        {
          label: "Teacher Access",
          href: "/admin/teacher-access",
          icon: <ShieldCheck className="h-4 w-4" aria-hidden="true" />,
        },
        {
          label: "Teaching",
          href: needsWorkspace ? "/teacher/onboarding" : "/teacher/dashboard",
          icon: <GraduationCap className="h-4 w-4" aria-hidden="true" />,
        },
      ]
    : isStudent
      ? [
          {
            label: "Home",
            href: "/student/dashboard",
            icon: <LayoutDashboard className="h-4 w-4" aria-hidden="true" />,
          },
          {
            label: "Write",
            href: "/student/questions",
            icon: <FileText className="h-4 w-4" aria-hidden="true" />,
          },
          {
            label: "Practice",
            href: "/student/practice",
            icon: <PenTool className="h-4 w-4" aria-hidden="true" />,
          },
          {
            label: "History",
            href: "/student/history",
            icon: <BookOpen className="h-4 w-4" aria-hidden="true" />,
          },
        ]
      : isTeacher
        ? [
            {
              label: "Overview",
              href: "/teacher/dashboard",
              icon: <LayoutDashboard className="h-4 w-4" aria-hidden="true" />,
            },
            {
              label: "Classes",
              href: "/teacher/batches",
              icon: <Users className="h-4 w-4" aria-hidden="true" />,
            },
            {
              label: "Students",
              href: "/teacher/students",
              icon: <BookOpen className="h-4 w-4" aria-hidden="true" />,
            },
            {
              label: "Review Queue",
              href: "/teacher/review-queue",
              icon: <ClipboardCheck className="h-4 w-4" aria-hidden="true" />,
            },
            {
              label: "Content",
              href: "/teacher/questions",
              icon: <FileText className="h-4 w-4" aria-hidden="true" />,
            },
          ]
        : [];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background font-sans text-foreground">
      <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/90 backdrop-blur-md">
        <div className="container mx-auto flex h-16 items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-5 xl:gap-8">
            <div className="flex shrink-0 items-center gap-2 font-serif text-lg font-medium tracking-tight text-primary sm:gap-3 sm:text-xl">
              <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-sm">
                <PenTool className="w-4 h-4" aria-hidden="true" />
              </div>
              <span className="whitespace-nowrap sm:hidden">Schreiben</span>
              <span className="hidden whitespace-nowrap sm:inline">
                {isAdminView
                  ? "Schreiben Admin"
                  : isStudent
                    ? "Schreiben"
                    : "German Writing Coach"}
              </span>
            </div>

            {hasNavigation && (
              <nav
                className="hidden items-center gap-1 xl:flex"
                aria-label="Primary navigation"
              >
                {navItems.map((item) => {
                  const isActive =
                    location === item.href ||
                    location.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors xl:px-4 ${isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                    >
                      {item.icon}
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            {hasNavigation && (
              <div className="flex items-center gap-2 sm:gap-4">
                <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
                  <SheetTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="xl:hidden"
                      aria-label="Open navigation menu"
                    >
                      <Menu className="h-5 w-5" aria-hidden="true" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent
                    side="left"
                    className="flex w-[min(22rem,88vw)] flex-col overflow-y-auto"
                  >
                    <SheetHeader className="text-left">
                      <SheetTitle>Navigation</SheetTitle>
                      <SheetDescription>
                        {isAdminView
                          ? "Approve teacher access and keep account permissions healthy."
                          : isTeacher
                            ? "Manage classes and student work."
                            : "Write, practice, and review your progress."}
                      </SheetDescription>
                    </SheetHeader>

                    {!isAdminView &&
                      workspaceMemberships.length > 1 &&
                      activeMembershipId && (
                        <div className="mt-4 space-y-2">
                          <label
                            className="text-sm font-medium"
                            htmlFor="mobile-workspace"
                          >
                            Workspace and role
                          </label>
                          <Select
                            value={activeMembershipId}
                            onValueChange={(membershipId) => {
                              void selectActiveMembership(membershipId);
                              setMobileMenuOpen(false);
                            }}
                          >
                            <SelectTrigger
                              id="mobile-workspace"
                              aria-label="Active workspace and role"
                              className="w-full bg-card"
                            >
                              <SelectValue placeholder="Choose workspace" />
                            </SelectTrigger>
                            <SelectContent>
                              {workspaceMemberships.map((membership) => (
                                <SelectItem
                                  key={membership.id}
                                  value={membership.id}
                                >
                                  {membership.workspace_name ?? "Workspace"} ·{" "}
                                  {membership.role}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                    {!isAdminView && isStudent && (
                      <div className="mt-4 space-y-4 border-t pt-4">
                        <StudentClassSwitcher
                          id="mobile-active-student-class"
                          showLabel
                        />
                        <StudentJoinClassDialog compact />
                        {!isPlatformAdmin && (
                          <SheetClose asChild>
                            <Button
                              asChild
                              variant="outline"
                              className="w-full"
                            >
                              <Link href="/teacher-access">Teacher access</Link>
                            </Button>
                          </SheetClose>
                        )}
                      </div>
                    )}

                    <nav
                      className="mt-5 grid gap-1"
                      aria-label="Mobile primary navigation"
                    >
                      {navItems.map((item) => {
                        const isActive =
                          location === item.href ||
                          location.startsWith(`${item.href}/`);
                        return (
                          <SheetClose asChild key={item.href}>
                            <Link
                              href={item.href}
                              aria-current={isActive ? "page" : undefined}
                              className={`flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium ${isActive ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"}`}
                            >
                              {item.icon}
                              {item.label}
                            </Link>
                          </SheetClose>
                        );
                      })}
                    </nav>
                  </SheetContent>
                </Sheet>
                {!isAdminView && isStudent && (
                  <div className="hidden items-center gap-2 xl:flex">
                    <StudentClassSwitcher
                      id="desktop-active-student-class"
                      className="w-44 2xl:w-52"
                    />
                    <StudentJoinClassDialog />
                  </div>
                )}
                {!isAdminView &&
                  workspaceMemberships.length > 1 &&
                  activeMembershipId && (
                    <Select
                      value={activeMembershipId}
                      onValueChange={(membershipId) =>
                        void selectActiveMembership(membershipId)
                      }
                    >
                      <SelectTrigger
                        className="hidden w-52 bg-card xl:flex"
                        aria-label="Active workspace and role"
                      >
                        <SelectValue placeholder="Choose workspace" />
                      </SelectTrigger>
                      <SelectContent>
                        {workspaceMemberships.map((membership) => (
                          <SelectItem key={membership.id} value={membership.id}>
                            {membership.workspace_name ?? "Workspace"} ·{" "}
                            {membership.role}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                <span className="hidden border-r border-border/60 pr-4 text-sm text-muted-foreground sm:inline-block xl:hidden 2xl:inline-block">
                  Logged in as{" "}
                  <span className="font-semibold text-foreground capitalize">
                    {isAdminView ? "admin" : role}
                  </span>
                </span>
                {!isPlatformAdmin && isStudent && (
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="hidden text-muted-foreground hover:text-foreground sm:inline-flex"
                  >
                    <Link href="/teacher-access">Teacher access</Link>
                  </Button>
                )}
                {isPlatformAdmin && !isAdminView && (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href="/admin/teacher-access"
                      aria-label="Platform administration"
                    >
                      <ShieldCheck
                        className="h-4 w-4 sm:mr-2"
                        aria-hidden="true"
                      />
                      <span className="hidden sm:inline">Admin</span>
                    </Link>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={logout}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Log out"
                >
                  <LogOut className="h-4 w-4 sm:mr-2" aria-hidden="true" />
                  <span className="hidden sm:inline">Logout</span>
                </Button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col">{children}</main>
    </div>
  );
}
