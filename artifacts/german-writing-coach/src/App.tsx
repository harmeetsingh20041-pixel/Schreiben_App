import { lazy, Suspense, type ComponentType, useEffect } from "react";
import {
  Switch,
  Route,
  Router as WouterRouter,
  Redirect,
  useLocation,
} from "wouter";
import * as Sentry from "@sentry/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { AuthProvider, useAuth } from "@/lib/auth";
import { StudentClassProvider } from "@/lib/studentClassContext";
import { Layout } from "@/components/layout";
import { setMonitoringContext } from "@/lib/monitoring";
import { isTeacherOverviewPath } from "@/lib/routePaths";

import Login from "@/pages/login";
import CheckEmail from "@/pages/auth/check-email";
import ConfirmEmail from "@/pages/auth/confirm";
import ForgotPassword from "@/pages/auth/forgot-password";
import ResetPassword from "@/pages/auth/reset-password";
import Mfa from "@/pages/auth/mfa";

// Student Pages
const StudentDashboard = lazy(() => import("@/pages/student/dashboard"));
const StudentQuestions = lazy(() => import("@/pages/student/questions"));
const StudentWrite = lazy(() => import("@/pages/student/write"));
const StudentHistory = lazy(() => import("@/pages/student/history"));
const StudentSubmissionDetail = lazy(
  () => import("@/pages/student/submission"),
);
const StudentPractice = lazy(() => import("@/pages/student/practice"));
const StudentWorksheet = lazy(() => import("@/pages/student/worksheet"));

// Teacher Pages
type TeacherDashboardModule = typeof import("@/pages/teacher/dashboard");
let teacherDashboardModule: Promise<TeacherDashboardModule> | null = null;

export function loadTeacherDashboardModule() {
  teacherDashboardModule ??= import("@/pages/teacher/dashboard");
  return teacherDashboardModule;
}

export function preloadTeacherDashboardForPath(
  pathname: string,
  loader: () => Promise<TeacherDashboardModule> = loadTeacherDashboardModule,
) {
  return isTeacherOverviewPath(pathname) ? loader() : null;
}

if (typeof window !== "undefined") {
  void preloadTeacherDashboardForPath(window.location.pathname)?.catch(
    () => undefined,
  );
}

const TeacherDashboard = lazy(loadTeacherDashboardModule);
const TeacherBatches = lazy(() => import("@/pages/teacher/batches"));
const TeacherStudents = lazy(() => import("@/pages/teacher/students"));
const TeacherQuestions = lazy(() => import("@/pages/teacher/questions"));
const TeacherSubmissions = lazy(() => import("@/pages/teacher/submissions"));
const TeacherSubmissionDetail = lazy(
  () => import("@/pages/teacher/submission"),
);
const TeacherReviewQueue = lazy(() => import("@/pages/teacher/review-queue"));
const TeacherPracticeReview = lazy(() => import("@/pages/teacher/practice"));
const TeacherPracticeQualityReview = lazy(
  () => import("@/pages/teacher/practice-quality"),
);
const TeacherOnboarding = lazy(() => import("@/pages/teacher/onboarding"));

// Account and platform-admin pages
const TeacherAccess = lazy(() => import("@/pages/teacher-access"));
const AdminTeacherAccess = lazy(() => import("@/pages/admin/teacher-access"));

const NotFound = lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});

function RouteLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-4">
      <div className="rounded-lg border bg-card px-5 py-3 text-sm text-muted-foreground shadow-sm">
        Loading...
      </div>
    </div>
  );
}

function AppErrorFallback() {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-16 text-foreground">
      <div className="mx-auto max-w-md rounded-lg border bg-card p-6 text-center shadow-sm">
        <h1 className="mb-2 text-2xl font-serif">Something went wrong.</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          Please refresh the page. If the problem continues, contact your
          teacher or support.
        </p>
        <Button type="button" onClick={() => window.location.reload()}>
          Refresh page
        </Button>
      </div>
    </div>
  );
}

function MonitoringContextBridge() {
  const [route] = useLocation();
  const { activeWorkspaceId, isPlatformAdmin, role, user } = useAuth();

  useEffect(() => {
    setMonitoringContext({
      role: isPlatformAdmin && route.startsWith("/admin/") ? "admin" : role,
      route,
      userId: user?.id ?? null,
      workspaceId: activeWorkspaceId,
    });
  }, [activeWorkspaceId, isPlatformAdmin, role, route, user?.id]);

  return null;
}

export function protectedRouteInstanceKey(
  path: string,
  params: Record<string, string | undefined>,
) {
  const parameterKey = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value ?? ""}`)
    .join("&");
  return `${path}?${parameterKey}`;
}

export function ProtectedRoute({
  component: Component,
  role,
  path,
}: {
  component: ComponentType;
  role: "student" | "teacher";
  path: string;
}) {
  const {
    canCreateTeacherWorkspace,
    loading,
    role: currentRole,
    needsWorkspace,
  } = useAuth();
  return (
    <Route path={path}>
      {(params) => {
        if (loading) return <RouteLoading />;
        if (needsWorkspace) {
          if (
            role === "teacher" &&
            path === "/teacher/onboarding" &&
            canCreateTeacherWorkspace
          ) {
            return (
              <Layout>
                <Suspense fallback={<RouteLoading />}>
                  <Component key={protectedRouteInstanceKey(path, params)} />
                </Suspense>
              </Layout>
            );
          }
          return (
            <Redirect
              to={canCreateTeacherWorkspace ? "/teacher/onboarding" : "/"}
            />
          );
        }
        if (currentRole !== role) return <Redirect to="/" />;
        return (
          <Layout>
            <Suspense fallback={<RouteLoading />}>
              <Component key={protectedRouteInstanceKey(path, params)} />
            </Suspense>
          </Layout>
        );
      }}
    </Route>
  );
}

export function TeacherAccessRoute({
  path = "/teacher-access",
}: {
  path?: string;
}) {
  const { isPlatformAdmin, loading, platformAdminMfaReady, user } = useAuth();
  return (
    <Route path={path}>
      {() => {
        if (loading) return <RouteLoading />;
        if (!user) return <Redirect to="/" />;
        if (isPlatformAdmin) {
          return (
            <Redirect
              to={
                platformAdminMfaReady
                  ? "/admin/teacher-access"
                  : "/auth/mfa?returnTo=%2Fadmin%2Fteacher-access"
              }
            />
          );
        }
        return (
          <Layout>
            <Suspense fallback={<RouteLoading />}>
              <TeacherAccess />
            </Suspense>
          </Layout>
        );
      }}
    </Route>
  );
}

export function AdminRoute({
  component: Component,
  path,
}: {
  component: ComponentType;
  path: string;
}) {
  const { isPlatformAdmin, loading, platformAdminMfaReady, user } = useAuth();
  return (
    <Route path={path}>
      {(params) => {
        if (loading) return <RouteLoading />;
        if (!user || !isPlatformAdmin) return <Redirect to="/" />;
        if (!platformAdminMfaReady) {
          return (
            <Redirect
              to={`/auth/mfa?returnTo=${encodeURIComponent(path)}`}
            />
          );
        }
        return (
          <Layout>
            <Suspense fallback={<RouteLoading />}>
              <Component key={protectedRouteInstanceKey(path, params)} />
            </Suspense>
          </Layout>
        );
      }}
    </Route>
  );
}

export function MfaRoute() {
  const { loading, user } = useAuth();
  if (loading) return <RouteLoading />;
  if (!user) return <Redirect to="/" />;
  return <Mfa />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Login} />
      <Route path="/login" component={Login} />
      <Route path="/auth/check-email" component={CheckEmail} />
      <Route path="/auth/confirm" component={ConfirmEmail} />
      <Route path="/auth/forgot-password" component={ForgotPassword} />
      <Route path="/auth/reset-password" component={ResetPassword} />
      <Route path="/auth/mfa" component={MfaRoute} />

      <TeacherAccessRoute path="/teacher-access" />
      <AdminRoute path="/admin/teacher-access" component={AdminTeacherAccess} />

      {/* Student Routes */}
      <ProtectedRoute
        path="/student/dashboard"
        role="student"
        component={StudentDashboard}
      />
      <ProtectedRoute
        path="/student/questions"
        role="student"
        component={StudentQuestions}
      />
      <ProtectedRoute
        path="/student/write"
        role="student"
        component={StudentWrite}
      />
      <ProtectedRoute
        path="/student/practice"
        role="student"
        component={StudentPractice}
      />
      <ProtectedRoute
        path="/student/practice/:id"
        role="student"
        component={StudentWorksheet}
      />
      <ProtectedRoute
        path="/student/history"
        role="student"
        component={StudentHistory}
      />
      <ProtectedRoute
        path="/student/submission/:id"
        role="student"
        component={StudentSubmissionDetail}
      />

      {/* Teacher Routes */}
      <ProtectedRoute
        path="/teacher/onboarding"
        role="teacher"
        component={TeacherOnboarding}
      />
      <ProtectedRoute
        path="/teacher/dashboard"
        role="teacher"
        component={TeacherDashboard}
      />
      <ProtectedRoute
        path="/teacher/batches"
        role="teacher"
        component={TeacherBatches}
      />
      <ProtectedRoute
        path="/teacher/students"
        role="teacher"
        component={TeacherStudents}
      />
      <ProtectedRoute
        path="/teacher/questions"
        role="teacher"
        component={TeacherQuestions}
      />
      <ProtectedRoute
        path="/teacher/submissions"
        role="teacher"
        component={TeacherSubmissions}
      />
      <ProtectedRoute
        path="/teacher/submission/:id"
        role="teacher"
        component={TeacherSubmissionDetail}
      />
      <ProtectedRoute
        path="/teacher/review-queue"
        role="teacher"
        component={TeacherReviewQueue}
      />
      <ProtectedRoute
        path="/teacher/practice-quality/:id"
        role="teacher"
        component={TeacherPracticeQualityReview}
      />
      <ProtectedRoute
        path="/teacher/practice/:id"
        role="teacher"
        component={TeacherPracticeReview}
      />

      <Route>
        <Layout>
          <Suspense fallback={<RouteLoading />}>
            <NotFound />
          </Suspense>
        </Layout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <Sentry.ErrorBoundary fallback={<AppErrorFallback />}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthProvider>
              <StudentClassProvider>
                <MonitoringContextBridge />
                <Router />
              </StudentClassProvider>
            </AuthProvider>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </Sentry.ErrorBoundary>
  );
}

export default App;
