import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText, Calendar, Eye } from "lucide-react";
import { getSubmissionActionLabel, getSubmissionIssueLabel, SubmissionStatusBadge } from "@/components/submission-status-badge";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { listStudentSubmissionsPage, type SubmissionCursor } from "@/services/submissionService";
import { useStudentClass } from "@/lib/studentClassContext";
import { StudentClassSwitcher } from "@/components/student-class-switcher";

function formatSubmissionDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function StudentHistory() {
  const { activeWorkspaceId: workspaceId, user } = useAuth();
  const {
    activeAssignment,
    activeBatchId,
    assignments,
    error: assignmentsError,
    isLoading: assignmentsLoading,
  } = useStudentClass();
  const resolvedWorkspaceId = workspaceId ?? activeAssignment?.workspace_id ?? null;
  const [cursorTrail, setCursorTrail] = useState<Array<SubmissionCursor | null>>([null]);
  const cursor = cursorTrail[cursorTrail.length - 1] ?? null;
  const pageNumber = cursorTrail.length;

  useEffect(() => {
    setCursorTrail([null]);
  }, [activeBatchId, user?.id, resolvedWorkspaceId]);

  const historyQuery = useQuery({
    queryKey: appQueryKeys.studentSubmissionsPage({
      studentId: user?.id ?? "inactive-student",
      workspaceId: resolvedWorkspaceId ?? "inactive-workspace",
      batchId: activeBatchId,
      pageSize: 20,
      cursor,
    }),
    enabled: Boolean(user) && Boolean(resolvedWorkspaceId) && Boolean(activeBatchId),
    queryFn: () => listStudentSubmissionsPage({
      studentId: user!.id,
      workspaceId: resolvedWorkspaceId!,
      batchId: activeBatchId,
      pageSize: 20,
      cursor,
    }),
    placeholderData: keepPreviousData,
  });
  const submissionPage = historyQuery.data;
  const submissions = submissionPage?.items ?? [];
  const loading = (
    assignmentsLoading
    || (Boolean(activeBatchId) && (historyQuery.isPending || historyQuery.isPlaceholderData))
  );
  const error = assignmentsError
    ? formatErrorMessage(assignmentsError, "Unable to load your active classes.")
    : !assignmentsLoading && assignments.length === 0
      ? "Join an active class before opening submission history."
      : !assignmentsLoading && !activeBatchId
        ? "Choose an active class before opening submission history."
    : historyQuery.error
      ? formatErrorMessage(historyQuery.error, "Unable to load submissions.")
      : null;
  
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl animate-in fade-in duration-500">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">My History</h1>
        <p className="text-muted-foreground mt-1">Review your past writings and feedback.</p>
      </div>

      {assignments.length > 1 && (
        <Card className="mb-6 shadow-none">
          <CardContent className="p-4">
            <StudentClassSwitcher id="history-active-class" showLabel className="max-w-sm" />
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive" role="alert">{error}</CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {error ? null : loading ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground" role="status">Loading submissions...</CardContent>
          </Card>
        ) : submissions.length === 0 ? (
          <Card className="p-12 text-center border-dashed bg-muted/30">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <FileText className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No submissions yet.</h3>
            <p className="text-muted-foreground mb-6">Your writing will appear here after you submit it.</p>
            <Button asChild>
              <Link href="/student/questions">Start Practice</Link>
            </Button>
          </Card>
        ) : submissions.map((submission, i) => (
          <Card key={submission.id} className="hover:border-primary/40 hover:shadow-md transition-all duration-300 animate-in slide-in-from-bottom-4 group" style={{ animationDelay: `${i * 75}ms` }}>
            <CardContent className="p-0">
              <div className="flex flex-col md:flex-row md:items-center">
                <div className="p-5 md:w-[200px] border-b md:border-b-0 md:border-r border-border bg-muted/20 flex flex-row md:flex-col justify-between items-start gap-2">
                  <div className="flex items-center text-sm font-medium text-muted-foreground">
                    <Calendar className="w-4 h-4 mr-2 text-primary" />
                    {formatSubmissionDate(submission.created_at)}
                  </div>
                  <SubmissionStatusBadge
                    status={submission.status}
                    feedbackMode={submission.feedback_mode}
                    feedbackScheduledAt={submission.feedback_scheduled_at}
                  />
                </div>

                <div className="p-5 flex-1 flex flex-col justify-center">
                  <div className="flex justify-between items-start mb-2 gap-4">
                    <div>
                      <h3 className="font-semibold text-lg text-foreground group-hover:text-primary transition-colors">
                        {submission.question_title}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {submission.question_source_label}
                        {submission.question_level && ` · ${submission.question_level}`}
                        {submission.batch_name && ` · ${submission.batch_name}`}
                      </p>
                    </div>
                    <div className="text-right hidden sm:block text-sm font-medium text-foreground">
                      {getSubmissionIssueLabel(submission)}
                    </div>
                  </div>

                  <p className="text-sm text-muted-foreground line-clamp-2 mt-2">
                    {submission.original_text}
                  </p>
                </div>

                <div className="p-5 border-t md:border-t-0 md:border-l border-border bg-muted/5 flex items-center justify-end">
                  <Button asChild variant="outline" className="w-full md:w-auto shadow-sm group-hover:bg-primary group-hover:text-primary-foreground group-hover:border-primary transition-colors">
                    <Link href={`/student/submission/${submission.id}`}>
                      <Eye className="w-4 h-4 mr-2" /> {getSubmissionActionLabel(submission)}
                    </Link>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {submissionPage && submissionPage.total_count > 0 && (
        <div className="mt-5 flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          {historyQuery.isPlaceholderData ? (
            <p role="status">Loading page {pageNumber}...</p>
          ) : (
            <p>
              Showing {(pageNumber - 1) * submissionPage.page_size + 1}
              {"–"}
              {Math.min(
                (pageNumber - 1) * submissionPage.page_size + submissionPage.returned_count,
                submissionPage.total_count,
              )} of {submissionPage.total_count}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={cursorTrail.length === 1 || historyQuery.isFetching}
              onClick={() => setCursorTrail((current) => current.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!submissionPage.has_more || historyQuery.isFetching}
              onClick={() => {
                if (!submissionPage.next_cursor) return;
                setCursorTrail((current) => [...current, submissionPage.next_cursor]);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
