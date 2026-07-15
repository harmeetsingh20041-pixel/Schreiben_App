import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Eye, Calendar } from "lucide-react";
import { getSubmissionIssueLabel, SubmissionStatusBadge } from "@/components/submission-status-badge";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { listTeacherWorkspaceSubmissionsPage, type SubmissionCursor } from "@/services/submissionService";

function formatSubmissionDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function TeacherSubmissions() {
  const { activeWorkspaceId: workspaceId, user } = useAuth();
  const searchParams = new URLSearchParams(useSearch());
  const filterStudent = searchParams.get("student");
  const filterBatch = searchParams.get("batch");
  const [cursorTrail, setCursorTrail] = useState<Array<SubmissionCursor | null>>([null]);
  const cursor = cursorTrail[cursorTrail.length - 1] ?? null;
  const pageNumber = cursorTrail.length;

  useEffect(() => {
    setCursorTrail([null]);
  }, [filterBatch, filterStudent, workspaceId]);

  const submissionsQuery = useQuery({
    queryKey: appQueryKeys.teacherSubmissionsPage({
      workspaceId: workspaceId ?? "inactive-workspace",
      studentId: filterStudent,
      batchId: filterBatch,
      pageSize: 25,
      cursor,
    }),
    enabled: Boolean(user) && Boolean(workspaceId),
    queryFn: () => listTeacherWorkspaceSubmissionsPage({
      workspaceId: workspaceId!,
      pageSize: 25,
      studentId: filterStudent,
      batchId: filterBatch,
      cursor,
    }),
    placeholderData: keepPreviousData,
  });
  const realSubmissionPage = submissionsQuery.data;
  const realSubmissions = realSubmissionPage?.items ?? [];
  const loading = Boolean(workspaceId)
    && (submissionsQuery.isPending || submissionsQuery.isPlaceholderData);
  const error = !workspaceId
    ? "No workspace found."
    : submissionsQuery.error
      ? formatErrorMessage(submissionsQuery.error, "Unable to load submissions.")
      : null;

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Student Submissions</h1>
          <p className="text-muted-foreground mt-1">Review submitted writing and add teacher notes.</p>
        </div>
      </div>

      <Card className="shadow-sm overflow-hidden border-border">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className="hidden md:table-cell">Date</TableHead>
              <TableHead className="hidden sm:table-cell">Issues</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                  <span role="status">Loading submissions...</span>
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-destructive">
                  <span role="alert">{error}</span>
                </TableCell>
              </TableRow>
            ) : realSubmissions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12">
                  <h2 className="text-lg font-semibold mb-2 text-foreground">No submissions yet.</h2>
                  <p className="text-sm text-muted-foreground">Writing submissions will appear here after students submit work.</p>
                </TableCell>
              </TableRow>
            ) : realSubmissions.map((submission) => (
                <TableRow key={submission.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">{submission.student_name ?? "Student"}</div>
                    <div className="text-xs text-muted-foreground hidden sm:block">{submission.student_email}</div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm line-clamp-1">{submission.question_title}</div>
                    <div className="text-xs text-muted-foreground">
                      {submission.question_source_label}
                      {submission.question_level && ` · Level ${submission.question_level}`}
                      {submission.batch_name && ` · ${submission.batch_name}`}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    <div className="flex items-center">
                      <Calendar className="w-3 h-3 mr-1" /> {formatSubmissionDate(submission.created_at)}
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="text-xs font-medium text-foreground">{getSubmissionIssueLabel(submission)}</span>
                  </TableCell>
                  <TableCell>
                    <SubmissionStatusBadge
                      status={submission.status}
                      feedbackMode={submission.feedback_mode}
                      feedbackScheduledAt={submission.feedback_scheduled_at}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm" className="hover:bg-primary/10 hover:text-primary">
                      <Link href={`/teacher/submission/${submission.id}`}>
                        <Eye className="w-4 h-4 mr-2" /> Open
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </Card>
      {realSubmissionPage && realSubmissionPage.total_count > 0 && (
        <div className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          {submissionsQuery.isPlaceholderData ? (
            <p role="status">Loading page {pageNumber}...</p>
          ) : (
            <p>
              Showing {(pageNumber - 1) * realSubmissionPage.page_size + 1}
              {"–"}
              {Math.min(
                (pageNumber - 1) * realSubmissionPage.page_size + realSubmissionPage.returned_count,
                realSubmissionPage.total_count,
              )} of {realSubmissionPage.total_count}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={cursorTrail.length === 1 || submissionsQuery.isFetching}
              onClick={() => setCursorTrail((current) => current.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!realSubmissionPage.has_more || submissionsQuery.isFetching}
              onClick={() => {
                if (!realSubmissionPage.next_cursor) return;
                setCursorTrail((current) => [...current, realSubmissionPage.next_cursor]);
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
