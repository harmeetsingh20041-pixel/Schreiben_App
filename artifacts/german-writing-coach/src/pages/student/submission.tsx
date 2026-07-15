import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PromptText } from "@/components/prompt-text";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { RealFeedbackReview } from "@/components/real-feedback-review";
import {
  getSubmissionStatusMeta,
  getSubmissionStudentSummary,
  SubmissionStatusBadge,
} from "@/components/submission-status-badge";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import { useLiveStudentSubmission } from "@/hooks/use-live-submission";
import { markOnboardingStep } from "@/services/onboardingService";
import { hasScheduledAutomaticRetry } from "@/lib/automaticRetryState";
import { appQueryKeys } from "@/lib/appQueryKeys";

function formatSubmissionDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function StudentSubmissionDetail() {
  const { id } = useParams();
  const { activeWorkspaceId: workspaceId, user } = useAuth();
  const queryClient = useQueryClient();
  const markedFeedbackRef = useRef<string | null>(null);
  const submissionQuery = useLiveStudentSubmission({
    submissionId: id,
    studentId: user?.id,
    workspaceId,
    enabled: Boolean(user),
  });
  const realSubmission = submissionQuery.data?.submission ?? null;
  const feedback = submissionQuery.data?.feedback ?? null;
  const releasedFeedback =
    realSubmission?.release_status === "released" ? feedback : null;
  const loading = submissionQuery.isLoading;
  const error = !workspaceId
    ? "Select a class before opening a submission."
    : submissionQuery.error
      ? formatErrorMessage(
          submissionQuery.error,
          "Unable to load this submission.",
        )
      : null;
  const automaticRetryScheduled = hasScheduledAutomaticRetry(
    realSubmission?.automatic_retry_at,
  );

  const emptyFeedbackTitle = automaticRetryScheduled
    ? "Feedback delayed safely"
    : realSubmission?.evaluation_status === "ready" &&
        realSubmission.release_status !== "released"
      ? realSubmission.release_status === "scheduled"
        ? "Feedback scheduled"
        : "Awaiting release"
      : realSubmission
        ? getSubmissionStatusMeta(realSubmission).label
        : "Feedback pending";
  const emptyFeedbackMessage = automaticRetryScheduled
    ? "Your writing is saved. The checker is temporarily delayed and will retry automatically; you can leave this page and return later."
    : realSubmission?.evaluation_status === "ready" &&
        realSubmission.release_status !== "released"
      ? realSubmission.release_status === "scheduled"
        ? "Your feedback is prepared and will appear at the scheduled release time."
        : "Your feedback is prepared and remains private until your teacher releases it."
      : realSubmission?.status === "checked"
        ? "Feedback is marked ready, but line-by-line details are not available yet. Please refresh or ask your teacher."
        : realSubmission
          ? getSubmissionStudentSummary(realSubmission)
          : "Feedback is being prepared.";

  useEffect(() => {
    if (
      !workspaceId ||
      !realSubmission ||
      !releasedFeedback ||
      realSubmission.release_status !== "released" ||
      markedFeedbackRef.current === realSubmission.id
    )
      return;

    markedFeedbackRef.current = realSubmission.id;
    void markOnboardingStep(workspaceId, "student", "review_feedback")
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.onboardingProgress(workspaceId, "student"),
        }),
      )
      .catch(() => {
        markedFeedbackRef.current = null;
      });
  }, [queryClient, realSubmission, releasedFeedback, workspaceId]);

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="mb-6 text-muted-foreground hover:text-foreground -ml-3"
      >
        <Link href="/student/history">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to History
        </Link>
      </Button>
      {loading ? (
        <Card>
          <CardContent
            className="py-10 text-center text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin" />
            Loading submission...
          </CardContent>
        </Card>
      ) : error ? (
        <Card className="border-destructive/30 bg-destructive/5" role="alert">
          <CardContent className="flex flex-col items-start gap-4 py-5 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              {workspaceId && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void submissionQuery.refetch()}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Try again
                </Button>
              )}
              <Button asChild size="sm" variant="outline">
                <Link href="/student/history">Open history</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : realSubmission ? (
        <div className="space-y-6 animate-in fade-in duration-500">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-6">
            <div>
              <h1 className="text-3xl font-serif tracking-tight text-foreground">
                {realSubmission.question_title}
              </h1>
              <div className="flex flex-wrap items-center gap-3 mt-2 text-muted-foreground text-sm">
                <span>{formatSubmissionDate(realSubmission.created_at)}</span>
                <span className="w-1 h-1 rounded-full bg-border"></span>
                <span>{realSubmission.question_source_label}</span>
                {realSubmission.batch_name && (
                  <>
                    <span className="w-1 h-1 rounded-full bg-border"></span>
                    <span>{realSubmission.batch_name}</span>
                  </>
                )}
                {(realSubmission.question_level ||
                  realSubmission.batch_level) && (
                  <Badge
                    variant="outline"
                    className="bg-muted text-muted-foreground"
                  >
                    {realSubmission.question_level ??
                      realSubmission.batch_level}
                  </Badge>
                )}
              </div>
            </div>
            <SubmissionStatusBadge
              status={realSubmission.status}
              feedbackMode={realSubmission.feedback_mode}
              feedbackScheduledAt={realSubmission.feedback_scheduled_at}
            />
          </div>

          {realSubmission.question_prompt && (
            <Card className="bg-primary/5 border-primary/20">
              <CardHeader>
                <CardTitle className="text-sm font-semibold uppercase tracking-widest text-primary">
                  Writing Task
                </CardTitle>
              </CardHeader>
              <CardContent>
                <PromptText prompt={realSubmission.question_prompt} />
              </CardContent>
            </Card>
          )}

          {releasedFeedback ? (
            <RealFeedbackReview
              submission={realSubmission}
              feedback={releasedFeedback}
            />
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                    Original Submission
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="whitespace-pre-wrap leading-relaxed">
                    {realSubmission.original_text}
                  </p>
                </CardContent>
              </Card>

              <Card
                className="border-dashed bg-muted/20"
                role="status"
                aria-live="polite"
              >
                <CardContent className="p-8 text-center">
                  <h2 className="text-lg font-semibold mb-2">
                    {emptyFeedbackTitle}.
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {emptyFeedbackMessage}
                  </p>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      ) : (
        <Card className="border-dashed bg-muted/20">
          <CardContent className="p-10 text-center">
            <h1 className="text-lg font-semibold mb-2">
              Submission not found.
            </h1>
            <p className="text-sm text-muted-foreground">
              It may belong to another account or workspace.
            </p>
            <Button asChild className="mt-5" variant="outline">
              <Link href="/student/history">Open history</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
