import { lazy, Suspense, type ComponentType } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Layout } from "@/components/layout";

import Login from "@/pages/login";

// Student Pages
const StudentDashboard = lazy(() => import("@/pages/student/dashboard"));
const StudentQuestions = lazy(() => import("@/pages/student/questions"));
const StudentWrite = lazy(() => import("@/pages/student/write"));
const StudentResult = lazy(() => import("@/pages/student/result"));
const StudentHistory = lazy(() => import("@/pages/student/history"));
const StudentSubmissionDetail = lazy(() => import("@/pages/student/submission"));
const StudentPractice = lazy(() => import("@/pages/student/practice"));
const StudentWorksheet = lazy(() => import("@/pages/student/worksheet"));

// Teacher Pages
const TeacherDashboard = lazy(() => import("@/pages/teacher/dashboard"));
const TeacherBatches = lazy(() => import("@/pages/teacher/batches"));
const TeacherStudents = lazy(() => import("@/pages/teacher/students"));
const TeacherQuestions = lazy(() => import("@/pages/teacher/questions"));
const TeacherSubmissions = lazy(() => import("@/pages/teacher/submissions"));
const TeacherSubmissionDetail = lazy(() => import("@/pages/teacher/submission"));
const TeacherOnboarding = lazy(() => import("@/pages/teacher/onboarding"));

const NotFound = lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient();

function RouteLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-4">
      <div className="rounded-lg border bg-card px-5 py-3 text-sm text-muted-foreground shadow-sm">
        Loading...
      </div>
    </div>
  );
}

function ProtectedRoute({
  component: Component,
  role,
  path,
}: {
  component: ComponentType;
  role: "student" | "teacher";
  path: string;
}) {
  return (
    <Route path={path}>
      {() => {
        const { loading, role: currentRole, needsWorkspace } = useAuth();
        if (loading) return <RouteLoading />;
        if (currentRole !== role) return <Redirect to="/" />;
        if (role === "teacher" && needsWorkspace && path !== "/teacher/onboarding") {
          return <Redirect to="/teacher/onboarding" />;
        }
        return (
          <Layout>
            <Suspense fallback={<RouteLoading />}>
              <Component />
            </Suspense>
          </Layout>
        );
      }}
    </Route>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Login} />
      <Route path="/login" component={Login} />
      
      {/* Student Routes */}
      <ProtectedRoute path="/student/dashboard" role="student" component={StudentDashboard} />
      <ProtectedRoute path="/student/questions" role="student" component={StudentQuestions} />
      <ProtectedRoute path="/student/write" role="student" component={StudentWrite} />
      <ProtectedRoute path="/student/practice" role="student" component={StudentPractice} />
      <ProtectedRoute path="/student/practice/:id" role="student" component={StudentWorksheet} />
      <ProtectedRoute path="/student/result/:id" role="student" component={StudentResult} />
      <ProtectedRoute path="/student/history" role="student" component={StudentHistory} />
      <ProtectedRoute path="/student/submission/:id" role="student" component={StudentSubmissionDetail} />
      
      {/* Teacher Routes */}
      <ProtectedRoute path="/teacher/onboarding" role="teacher" component={TeacherOnboarding} />
      <ProtectedRoute path="/teacher/dashboard" role="teacher" component={TeacherDashboard} />
      <ProtectedRoute path="/teacher/batches" role="teacher" component={TeacherBatches} />
      <ProtectedRoute path="/teacher/students" role="teacher" component={TeacherStudents} />
      <ProtectedRoute path="/teacher/questions" role="teacher" component={TeacherQuestions} />
      <ProtectedRoute path="/teacher/submissions" role="teacher" component={TeacherSubmissions} />
      <ProtectedRoute path="/teacher/submission/:id" role="teacher" component={TeacherSubmissionDetail} />

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
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
