import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Layout } from "@/components/layout";
import NotFound from "@/pages/not-found";

import Login from "@/pages/login";

// Student Pages
import StudentDashboard from "@/pages/student/dashboard";
import StudentQuestions from "@/pages/student/questions";
import StudentWrite from "@/pages/student/write";
import StudentResult from "@/pages/student/result";
import StudentHistory from "@/pages/student/history";
import StudentSubmissionDetail from "@/pages/student/submission";

// Teacher Pages
import TeacherDashboard from "@/pages/teacher/dashboard";
import TeacherBatches from "@/pages/teacher/batches";
import TeacherStudents from "@/pages/teacher/students";
import TeacherQuestions from "@/pages/teacher/questions";
import TeacherSubmissions from "@/pages/teacher/submissions";
import TeacherSubmissionDetail from "@/pages/teacher/submission";

const queryClient = new QueryClient();

function ProtectedRoute({ component: Component, role, path }: any) {
  return (
    <Route path={path}>
      {() => {
        const { role: currentRole } = useAuth();
        if (currentRole !== role) return <Redirect to="/" />;
        return (
          <Layout>
            <Component />
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
      <ProtectedRoute path="/student/result/:id" role="student" component={StudentResult} />
      <ProtectedRoute path="/student/history" role="student" component={StudentHistory} />
      <ProtectedRoute path="/student/submission/:id" role="student" component={StudentSubmissionDetail} />
      
      {/* Teacher Routes */}
      <ProtectedRoute path="/teacher/dashboard" role="teacher" component={TeacherDashboard} />
      <ProtectedRoute path="/teacher/batches" role="teacher" component={TeacherBatches} />
      <ProtectedRoute path="/teacher/students" role="teacher" component={TeacherStudents} />
      <ProtectedRoute path="/teacher/questions" role="teacher" component={TeacherQuestions} />
      <ProtectedRoute path="/teacher/submissions" role="teacher" component={TeacherSubmissions} />
      <ProtectedRoute path="/teacher/submission/:id" role="teacher" component={TeacherSubmissionDetail} />

      <Route>
        <Layout><NotFound /></Layout>
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
