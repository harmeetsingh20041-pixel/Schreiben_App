import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PenTool,
  Clock,
  BookOpen,
  AlertCircle,
  TrendingUp,
  KeyRound,
} from "lucide-react";
import { Link } from "wouter";
import {
  getSubmissionActionLabel,
  getSubmissionStudentSummary,
  SubmissionStatusBadge,
} from "@/components/submission-status-badge";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import { useToast } from "@/hooks/use-toast";
import {
  getProminentJoinRequest,
  requestJoinBatchByCode,
} from "@/services/studentService";
import {
  formatIssueCount,
  getWeaknessBadgeClass,
  getWeaknessLabel,
} from "@/services/grammarStatsService";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { appQueryKeys } from "@/lib/appQueryKeys";
import {
  createStudentAccessQueries,
  createStudentWorkspaceDashboardQueries,
} from "@/lib/dashboardQueries";
import { useStudentClass } from "@/lib/studentClassContext";

export default function StudentDashboard() {
  const { activeWorkspaceId: workspaceId, user, profile } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [joinCode, setJoinCode] = useState("");
  const studentId = user?.id ?? "inactive-student";
  const accessQueries = createStudentAccessQueries(studentId);
  const accessEnabled = Boolean(user);
  const {
    activeAssignment,
    activeBatchId,
    assignments: batchAssignments,
    error: assignmentsError,
    isLoading: assignmentsLoading,
    selectionRequired,
    selectActiveBatch,
  } = useStudentClass();
  const joinRequestsQuery = useQuery({
    ...accessQueries.joinRequests,
    enabled: accessEnabled,
  });
  const joinRequests = joinRequestsQuery.data ?? [];
  const resolvedWorkspaceId =
    workspaceId ?? activeAssignment?.workspace_id ?? null;
  const workspaceQueries = createStudentWorkspaceDashboardQueries(
    resolvedWorkspaceId ?? "inactive-workspace",
    studentId,
    activeBatchId,
  );
  const workspaceQueryEnabled = accessEnabled && Boolean(resolvedWorkspaceId);
  const submissionContextEnabled =
    workspaceQueryEnabled && Boolean(activeBatchId);
  const submissionsQuery = useQuery({
    ...workspaceQueries.submissions,
    enabled: submissionContextEnabled,
  });
  const releasedFeedbackQuery = useQuery({
    ...workspaceQueries.releasedFeedback,
    enabled: submissionContextEnabled,
  });
  const grammarStatsQuery = useQuery({
    ...workspaceQueries.grammarStats,
    enabled: workspaceQueryEnabled,
  });
  const realSubmissions = submissionsQuery.data?.items ?? [];
  const releasedFeedback = releasedFeedbackQuery.data;
  const grammarStats = grammarStatsQuery.data ?? [];
  const loading =
    accessEnabled &&
    (assignmentsLoading ||
      joinRequestsQuery.isPending ||
      (workspaceQueryEnabled && grammarStatsQuery.isPending) ||
      (submissionContextEnabled &&
        (submissionsQuery.isPending || releasedFeedbackQuery.isPending)));
  const loadError = [
    assignmentsError,
    joinRequestsQuery.error,
    submissionsQuery.error,
    releasedFeedbackQuery.error,
    grammarStatsQuery.error,
  ].find(Boolean);
  const error = loadError
    ? formatErrorMessage(
        loadError,
        "Student dashboard data could not be loaded. Refresh and try again.",
      )
    : null;

  const joinBatchMutation = useMutation({
    mutationFn: requestJoinBatchByCode,
  });

  const submitJoinCode = async () => {
    if (!joinCode.trim()) {
      toast({
        title: "Class code required",
        description: "Enter the code your teacher shared.",
      });
      return;
    }

    try {
      const result = await joinBatchMutation.mutateAsync(joinCode);
      setJoinCode("");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.studentBatchAssignments(studentId),
        }),
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.studentJoinRequests(studentId),
        }),
      ]);
      toast(
        result.status === "approved"
          ? {
              title: "Already joined",
              description: `You already have access to ${result.batch_name}.`,
            }
          : {
              title: "Request sent",
              description: "Waiting for teacher approval.",
            },
      );
    } catch (error) {
      toast({
        title: "Could not request class",
        description: formatErrorMessage(error, "Check the code and try again."),
      });
    }
  };
  const submittingJoinCode = joinBatchMutation.isPending;

  const primaryBatch = activeAssignment ?? undefined;
  const latestJoinRequest = getProminentJoinRequest(joinRequests);
  const releasedFeedbackCount = releasedFeedback?.released_count ?? 0;
  const latestReadySubmission = releasedFeedback?.latest_submission ?? null;
  const firstName = (profile?.full_name || user?.email || "there").split(
    /[ @]/,
  )[0];
  const batchSummary = primaryBatch
    ? `${primaryBatch.batch_name} · ${primaryBatch.level}`
    : batchAssignments.length > 1
      ? "Choose a class"
      : loading
        ? "Loading batch..."
        : "No batch yet";

  return (
    <div className="container mx-auto px-4 py-12 max-w-6xl animate-in fade-in duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-6 border-b border-border/60 pb-8">
        <div>
          <h1 className="text-4xl font-serif tracking-tight mb-2">
            Welcome back, {firstName}!
          </h1>
          <p className="text-muted-foreground">Class: {batchSummary}</p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
          {batchAssignments.length > 1 && (
            <Select
              value={activeBatchId ?? ""}
              onValueChange={selectActiveBatch}
            >
              <SelectTrigger
                className="w-full bg-card sm:w-56"
                aria-label="Active class"
              >
                <SelectValue placeholder="Choose a class" />
              </SelectTrigger>
              <SelectContent>
                {batchAssignments.map((assignment) => (
                  <SelectItem
                    key={assignment.batch_id}
                    value={assignment.batch_id}
                  >
                    {assignment.batch_name} · {assignment.level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Link
            href="/student/history"
            aria-disabled={!activeBatchId}
            tabIndex={!activeBatchId ? -1 : undefined}
            onClick={(event) => {
              if (!activeBatchId) event.preventDefault();
            }}
            className={`inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border border-input bg-card hover:bg-accent hover:text-accent-foreground h-11 px-6 shadow-sm ${!activeBatchId ? "pointer-events-none opacity-50" : ""}`}
          >
            View History
          </Link>
          <Link
            href="/student/questions"
            aria-disabled={!activeBatchId}
            tabIndex={!activeBatchId ? -1 : undefined}
            onClick={(event) => {
              if (!activeBatchId) event.preventDefault();
            }}
            className={`inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 bg-primary text-primary-foreground hover:bg-primary/90 h-11 px-6 shadow-sm ${!activeBatchId ? "pointer-events-none opacity-50" : ""}`}
          >
            <PenTool className="w-4 h-4 mr-2" />
            Start New Writing
          </Link>
        </div>
      </div>

      <OnboardingChecklist role="student" />

      {error && (
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive" role="alert">
            {error}
          </CardContent>
        </Card>
      )}

      {selectionRequired && (
        <Card className="mb-6 border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
          <CardContent
            className="py-4 text-sm text-amber-900 dark:text-amber-100"
            role="status"
          >
            Choose an active class before opening class-specific writing or
            history.
          </CardContent>
        </Card>
      )}

      {!loading && (
        <Card className="mb-12 border-primary/25 bg-primary/5">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                <KeyRound className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle>
                  {batchAssignments.length > 0
                    ? "Join another class"
                    : "Join your first class"}
                </CardTitle>
                <CardDescription>
                  Enter your teacher's class code. They will approve your
                  request before writing tasks appear.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-3">
              <Input
                value={joinCode}
                onChange={(event) =>
                  setJoinCode(event.target.value.toUpperCase())
                }
                placeholder="Enter class code"
                aria-label="Class join code"
                className="font-mono tracking-wider bg-card"
              />
              <Button onClick={submitJoinCode} disabled={submittingJoinCode}>
                {submittingJoinCode ? "Sending..." : "Request Access"}
              </Button>
            </div>
            {latestJoinRequest && (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline">{latestJoinRequest.status}</Badge>
                <span>
                  {latestJoinRequest.batch_name} ·{" "}
                  {latestJoinRequest.batch_level}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <Card className="mb-12">
          <CardContent
            className="py-10 text-center text-muted-foreground"
            role="status"
          >
            Loading batch access...
          </CardContent>
        </Card>
      ) : (
        batchAssignments.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
              <Card className="bg-card shadow-sm border-border rounded-xl">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-primary" />
                    Recent Progress
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-4xl font-serif text-foreground mb-3">
                    -
                  </div>
                  <p className="text-sm text-muted-foreground mb-5 leading-relaxed">
                    {(submissionsQuery.data?.total_count ?? 0) > 0
                      ? `${submissionsQuery.data!.total_count} submission${submissionsQuery.data!.total_count === 1 ? "" : "s"} saved.`
                      : "No submissions yet."}
                  </p>
                  <Progress
                    value={0}
                    aria-label="Writing progress"
                    aria-valuetext={"Progress score is not available yet"}
                    className="h-1.5 bg-muted"
                  />
                </CardContent>
              </Card>

              <Card className="bg-card shadow-sm border-border rounded-xl">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-accent" />
                    Focus Areas
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col h-[calc(100%-3rem)]">
                  <p className="text-sm text-muted-foreground mb-5 leading-relaxed">
                    {grammarStats.length > 0
                      ? "Feedback from your writings is building your practice profile."
                      : "Feedback from future writings will build your practice profile."}
                  </p>
                  <div className="flex flex-wrap gap-2 mb-6 flex-1">
                    {grammarStats.length > 0 ? (
                      grammarStats.slice(0, 4).map((stat) => (
                        <Badge
                          key={stat.id}
                          variant="outline"
                          className={getWeaknessBadgeClass(
                            stat.weakness_level,
                            stat.practice_unlocked,
                          )}
                        >
                          {stat.topic_name}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        No focus areas yet.
                      </span>
                    )}
                  </div>
                  <Button
                    asChild
                    variant="outline"
                    className="mt-auto w-full shadow-sm hover:border-primary hover:text-primary transition-colors"
                  >
                    <Link href="/student/practice">
                      <PenTool className="w-4 h-4 mr-2" /> Practice Weak Topics
                    </Link>
                  </Button>
                </CardContent>
              </Card>

              <Card className="bg-card shadow-sm border-border rounded-xl">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-primary" />
                    Next Steps
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-5 mt-2">
                    <div className="flex items-start gap-3">
                      <div className="w-1.5 h-1.5 mt-2 rounded-full bg-primary" />
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {grammarStats[0]
                            ? `Review ${grammarStats[0].topic_name}`
                            : "Start an assigned writing task"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {grammarStats[0]
                            ? `${getWeaknessLabel(grammarStats[0].weakness_level, grammarStats[0].practice_unlocked)} · ${formatIssueCount(grammarStats[0])}`
                            : "Feedback will appear after you submit a writing task"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="w-1.5 h-1.5 mt-2 rounded-full bg-muted-foreground/30" />
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          Complete assigned writing topic
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Try a new writing task
                        </p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {releasedFeedbackCount > 0 && (
              <Card className="mb-10 border-green-300 bg-green-50 shadow-sm dark:border-green-700 dark:bg-green-950/40">
                <CardContent className="p-5 md:p-6">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div className="flex items-start gap-4">
                      <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-green-300 bg-card text-green-800 shadow-sm dark:border-green-700 dark:text-green-100">
                        <BookOpen className="h-5 w-5" />
                      </div>
                      <div>
                        <SubmissionStatusBadge
                          status="checked"
                          className="mb-2"
                        />
                        <h2 className="text-lg font-serif text-green-950 dark:text-green-100">
                          Feedback ready
                        </h2>
                        <p className="text-sm text-green-900/80 dark:text-green-100/80">
                          {releasedFeedbackCount === 1
                            ? "1 writing has feedback ready."
                            : `${releasedFeedbackCount} writings have line-by-line feedback ready.`}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2 md:justify-end">
                      {latestReadySubmission && (
                        <Button asChild className="shadow-sm">
                          <Link
                            href={`/student/submission/${latestReadySubmission.id}`}
                          >
                            Open latest feedback
                          </Link>
                        </Button>
                      )}
                      <Button
                        asChild
                        variant="outline"
                        className="bg-card shadow-sm"
                      >
                        <Link href="/student/history">View all feedback</Link>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            <h2 className="text-2xl font-serif tracking-tight mb-6">
              Recent Feedback
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {realSubmissions.length === 0 ? (
                <Card className="md:col-span-2 border-dashed bg-muted/20">
                  <CardContent className="p-8 text-center">
                    <h3 className="text-lg font-semibold mb-2">
                      No submissions yet.
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Your writing will appear here after you submit it.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                realSubmissions.slice(0, 4).map((submission, i) => (
                  <Card
                    key={submission.id}
                    className="hover:border-primary/30 transition-all duration-300 shadow-sm border-border rounded-xl animate-in slide-in-from-bottom-4"
                    style={{ animationDelay: `${i * 50}ms` }}
                  >
                    <CardContent className="p-6">
                      <div className="flex justify-between items-start mb-4">
                        <SubmissionStatusBadge
                          status={submission.status}
                          feedbackMode={submission.feedback_mode}
                          feedbackScheduledAt={submission.feedback_scheduled_at}
                        />
                        <div className="flex items-center text-xs font-mono text-muted-foreground">
                          <Clock className="w-3.5 h-3.5 mr-1.5" />
                          {new Date(submission.created_at).toLocaleDateString()}
                        </div>
                      </div>
                      <h3 className="font-serif text-xl mb-3 text-foreground">
                        {submission.question_title}
                      </h3>
                      <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2 mb-6">
                        {getSubmissionStudentSummary(submission)}
                      </p>
                      <div className="flex justify-between items-center mt-auto border-t border-border/60 pt-4">
                        <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                          {submission.question_source_label}
                        </div>
                        <Link
                          href={`/student/submission/${submission.id}`}
                          className="text-sm text-primary font-medium hover:underline flex items-center tracking-wide"
                        >
                          {getSubmissionActionLabel(submission)}{" "}
                          <span className="ml-1 transition-transform group-hover:translate-x-1">
                            →
                          </span>
                        </Link>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </>
        )
      )}
    </div>
  );
}
