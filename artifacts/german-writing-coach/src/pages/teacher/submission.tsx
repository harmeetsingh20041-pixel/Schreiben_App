import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PromptText } from "@/components/prompt-text";
import { ArrowLeft, Clock3, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { RealFeedbackReview } from "@/components/real-feedback-review";
import { TeacherFeedbackDraftEditor } from "@/components/teacher-feedback-draft-editor";
import {
  getSubmissionStatusMeta,
  getSubmissionStudentSummary,
  SubmissionStatusBadge,
} from "@/components/submission-status-badge";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  prepareWritingFeedback,
  type WritingFeedback,
  type WritingSubmission,
} from "@/services/submissionService";
import {
  getFeedbackDraft,
  releaseFeedback,
  type FeedbackDraft,
  type FeedbackTopicOption,
} from "@/services/feedbackReviewService";
import { useToast } from "@/hooks/use-toast";
import { useLiveTeacherSubmission } from "@/hooks/use-live-submission";
import { appQueryKeys } from "@/lib/appQueryKeys";

function formatSubmissionDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function canEditPrivateFeedbackDraft(
  submission: WritingSubmission,
  draft: FeedbackDraft,
) {
  if (submission.release_status !== "held") return false;
  return (
    submission.feedback_mode === "teacher_review_only" ||
    submission.evaluation_status === "needs_review" ||
    draft.state === "needs_review"
  );
}

export function isScheduledFeedbackPreview(
  submission: WritingSubmission,
  draft: FeedbackDraft,
) {
  return (
    submission.feedback_mode === "automatic_delayed" &&
    submission.release_status === "scheduled" &&
    submission.evaluation_status === "ready" &&
    draft.state !== "needs_review"
  );
}

export const SCHEDULED_RELEASE_GRACE_MS = 60_000;

export function canReleaseOverdueScheduledFeedback(
  submission: WritingSubmission,
  draft: FeedbackDraft,
  now = Date.now(),
) {
  if (
    !isScheduledFeedbackPreview(submission, draft) ||
    !submission.release_at
  ) {
    return false;
  }
  const releaseAt = new Date(submission.release_at).getTime();
  return (
    Number.isFinite(releaseAt) &&
    releaseAt <= now - SCHEDULED_RELEASE_GRACE_MS &&
    draft.content.lines.every((line) => line.status !== "unclear")
  );
}

export function buildPrivateFeedbackPreview(
  submission: WritingSubmission,
  draft: FeedbackDraft,
  topicOptions: FeedbackTopicOption[],
): { submission: WritingSubmission; feedback: WritingFeedback } {
  const topicNames = new Map(
    topicOptions.map((option) => [option.slug, option.name]),
  );
  const topicName = (topic: string) => topicNames.get(topic) ?? topic;

  return {
    submission: {
      ...submission,
      corrected_text: draft.content.corrected_text,
      overall_summary: draft.content.overall_summary,
      level_detected: draft.content.level_detected,
    },
    feedback: {
      lines: draft.content.lines.map((line) => ({
        id: `${draft.id}:line:${line.line_number}`,
        line_number: line.line_number,
        original_line: line.original_line,
        corrected_line: line.corrected_line,
        status: line.status,
        changed_parts: line.changed_parts.map((part) => ({
          from: part.from,
          to: part.to,
          reason: part.reason,
          grammar_topics: part.grammar_topics,
          severity: part.severity,
        })),
        short_explanation: line.short_explanation || null,
        detailed_explanation: line.detailed_explanation || null,
        grammar_topic: line.grammar_topic
          ? topicName(line.grammar_topic)
          : null,
      })),
      grammar_topics: draft.content.grammar_topics.map((topic, index) => ({
        id: `${draft.id}:topic:${index}`,
        topic: topicName(topic.topic),
        topic_slug: topic.topic,
        count: topic.count,
        severity: topic.severity,
        simple_explanation: topic.simple_explanation || null,
      })),
    },
  };
}

export default function TeacherSubmissionDetail() {
  const { id } = useParams();
  const { activeWorkspaceId: workspaceId, user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [preparingFeedback, setPreparingFeedback] = useState(false);
  const [releasingScheduledFeedback, setReleasingScheduledFeedback] =
    useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const submissionQuery = useLiveTeacherSubmission({
    submissionId: id,
    workspaceId,
    enabled: Boolean(user),
  });
  const realSubmission = submissionQuery.data?.submission ?? null;
  const feedback = submissionQuery.data?.feedback ?? null;
  const feedbackDraftQuery = useQuery({
    queryKey: ["teacher-feedback-draft", workspaceId, id],
    enabled:
      Boolean(user) &&
      Boolean(workspaceId) &&
      Boolean(id) &&
      Boolean(realSubmission) &&
      realSubmission?.release_status !== "released" &&
      (realSubmission?.evaluation_status === "ready" ||
        realSubmission?.evaluation_status === "needs_review"),
    queryFn: () => getFeedbackDraft(id!),
    staleTime: 5_000,
  });
  const privateDraft = feedbackDraftQuery.data?.draft ?? null;
  const privateDraftIsEditable = Boolean(
    realSubmission &&
    privateDraft &&
    canEditPrivateFeedbackDraft(realSubmission, privateDraft),
  );
  const scheduledFeedbackPreview =
    realSubmission &&
    privateDraft &&
    isScheduledFeedbackPreview(realSubmission, privateDraft)
      ? buildPrivateFeedbackPreview(
          realSubmission,
          privateDraft,
          feedbackDraftQuery.data?.topic_options ?? [],
        )
      : null;
  const canReleaseScheduledFeedback = Boolean(
    realSubmission &&
    privateDraft &&
    canReleaseOverdueScheduledFeedback(realSubmission, privateDraft),
  );
  const loading = submissionQuery.isLoading;
  const error = !workspaceId
    ? "Select an active workspace before opening a submission."
    : submissionQuery.error
      ? formatErrorMessage(
          submissionQuery.error,
          "Unable to load this submission.",
        )
      : null;

  const emptyFeedbackTitle = realSubmission
    ? getSubmissionStatusMeta(realSubmission).label
    : "Feedback pending";
  const emptyFeedbackMessage =
    realSubmission?.status === "checked"
      ? "Feedback is marked ready, but line-by-line details are not available. Refresh this page before preparing feedback again."
      : realSubmission?.status === "failed"
        ? "Feedback could not be prepared. You can try preparing it again."
        : realSubmission
          ? getSubmissionStudentSummary(realSubmission)
          : "Prepare line-by-line feedback for this submitted writing.";
  const canPrepareFeedback = Boolean(
    realSubmission &&
    (realSubmission.evaluation_status
      ? realSubmission.evaluation_status === "failed"
      : realSubmission.status === "submitted" ||
        realSubmission.status === "failed"),
  );

  const invalidateTeacherLists = async () => {
    if (!workspaceId) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: appQueryKeys.teacherSubmissions(workspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: appQueryKeys.teacherFeedbackQueue(workspaceId),
      }),
    ]);
  };

  const handlePrepareFeedback = async () => {
    if (!realSubmission) return;
    try {
      setPreparingFeedback(true);
      setActionError(null);
      const result = await prepareWritingFeedback(realSubmission.id);
      await Promise.all([submissionQuery.refetch(), invalidateTeacherLists()]);
      if (
        result.already_processing ||
        ["queued", "processing", "checking"].includes(result.status)
      ) {
        toast({
          title: "Feedback is processing",
          description:
            "The submission is queued or already being evaluated. Refresh shortly for its latest status.",
        });
      } else if (result.status === "needs_review") {
        toast({
          title: "Feedback needs review",
          description:
            "The evaluation was saved privately and must be reviewed before release.",
        });
      } else if (["ready", "checked"].includes(result.status)) {
        toast({
          title: "Feedback prepared",
          description:
            "The evaluation is validated and awaiting its configured release step.",
        });
      } else {
        toast({
          title: "Feedback request updated",
          description: "Refresh shortly for the latest evaluation status.",
        });
      }
    } catch (prepareError) {
      const message = formatErrorMessage(
        prepareError,
        "Feedback could not be prepared.",
      );
      setActionError(message);
      toast({ title: "Feedback failed", description: message });
      await Promise.all([submissionQuery.refetch(), invalidateTeacherLists()]);
    } finally {
      setPreparingFeedback(false);
    }
  };

  const handleReleaseScheduledFeedback = async () => {
    if (!realSubmission || !privateDraft || !canReleaseScheduledFeedback)
      return;
    try {
      setReleasingScheduledFeedback(true);
      setActionError(null);
      await releaseFeedback(realSubmission.id, privateDraft.id);
      await Promise.all([
        submissionQuery.refetch(),
        feedbackDraftQuery.refetch(),
        invalidateTeacherLists(),
      ]);
      toast({
        title: "Feedback released",
        description:
          "The overdue scheduled feedback is now available to the student.",
      });
    } catch (releaseError) {
      const message = formatErrorMessage(
        releaseError,
        "The overdue feedback could not be released. Please try again.",
      );
      setActionError(message);
      toast({ title: "Feedback release failed", description: message });
      await Promise.all([
        submissionQuery.refetch(),
        feedbackDraftQuery.refetch(),
      ]);
    } finally {
      setReleasingScheduledFeedback(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="mb-6 text-muted-foreground hover:text-foreground -ml-3"
      >
        <Link href="/teacher/submissions">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Submissions
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
            {workspaceId ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void submissionQuery.refetch()}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Try again
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href="/teacher/dashboard">Open overview</Link>
              </Button>
            )}
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
                <span>{realSubmission.student_name ?? "Student"}</span>
                {realSubmission.student_email && (
                  <>
                    <span className="w-1 h-1 rounded-full bg-border"></span>
                    <span>{realSubmission.student_email}</span>
                  </>
                )}
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

          {actionError && (
            <Card
              className="border-destructive/30 bg-destructive/5"
              role="alert"
            >
              <CardContent className="flex flex-col items-start gap-4 py-5 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
                <span>{actionError}</span>
                {canPrepareFeedback && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={preparingFeedback}
                    aria-busy={preparingFeedback}
                    onClick={handlePrepareFeedback}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Try preparing again
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

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

          {feedbackDraftQuery.isPending && feedbackDraftQuery.isFetching ? (
            <Card>
              <CardContent
                className="flex items-center justify-center gap-2 py-10 text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading private feedback draft...
              </CardContent>
            </Card>
          ) : privateDraft && privateDraftIsEditable ? (
            <TeacherFeedbackDraftEditor
              submission={realSubmission}
              draft={privateDraft}
              topicOptions={feedbackDraftQuery.data?.topic_options ?? []}
              onChanged={async () => {
                await Promise.all([
                  submissionQuery.refetch(),
                  feedbackDraftQuery.refetch(),
                ]);
              }}
              onReleased={async () => {
                await Promise.all([
                  submissionQuery.refetch(),
                  feedbackDraftQuery.refetch(),
                  invalidateTeacherLists(),
                ]);
              }}
            />
          ) : scheduledFeedbackPreview ? (
            <div className="space-y-6">
              <Card
                className="border-sky-200 bg-sky-50/70"
                role="status"
                aria-live="polite"
              >
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base text-sky-950">
                    <Clock3 className="h-4 w-4" />
                    Scheduled feedback preview
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-sky-900">
                  <p>
                    {canReleaseScheduledFeedback
                      ? "The automatic release is overdue. The feedback remains read-only, but you can release the validated version now."
                      : "This validated feedback is read-only and will be released to the student automatically"}
                    {!canReleaseScheduledFeedback &&
                      (realSubmission.release_at
                        ? ` on ${new Date(realSubmission.release_at).toLocaleString()}`
                        : " at the class release time")}
                    {!canReleaseScheduledFeedback && "."}
                  </p>
                  {canReleaseScheduledFeedback && (
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleReleaseScheduledFeedback}
                      disabled={releasingScheduledFeedback}
                      aria-busy={releasingScheduledFeedback}
                    >
                      {releasingScheduledFeedback && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      {releasingScheduledFeedback
                        ? "Releasing feedback..."
                        : "Release overdue feedback"}
                    </Button>
                  )}
                </CardContent>
              </Card>
              <RealFeedbackReview
                submission={scheduledFeedbackPreview.submission}
                feedback={scheduledFeedbackPreview.feedback}
              />
            </div>
          ) : feedback ? (
            <RealFeedbackReview
              submission={realSubmission}
              feedback={feedback}
            />
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                    Student Submission
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
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Sparkles className="h-6 w-6" />
                  </div>
                  <h2 className="text-lg font-semibold mb-2">
                    {emptyFeedbackTitle}.
                  </h2>
                  <p className="text-sm text-muted-foreground mb-6">
                    {feedbackDraftQuery.error
                      ? formatErrorMessage(
                          feedbackDraftQuery.error,
                          "The private feedback draft could not be loaded. Refresh and try again.",
                        )
                      : emptyFeedbackMessage}
                  </p>
                  <div className="flex flex-col justify-center gap-2 sm:flex-row">
                    {feedbackDraftQuery.error && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void feedbackDraftQuery.refetch()}
                        disabled={feedbackDraftQuery.isFetching}
                        aria-busy={feedbackDraftQuery.isFetching}
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Reload private draft
                      </Button>
                    )}
                    {canPrepareFeedback && (
                      <Button
                        onClick={handlePrepareFeedback}
                        disabled={preparingFeedback}
                        aria-busy={preparingFeedback}
                        className="shadow-sm"
                      >
                        {preparingFeedback ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="mr-2 h-4 w-4" />
                        )}
                        {preparingFeedback
                          ? "Preparing feedback..."
                          : "Prepare Feedback"}
                      </Button>
                    )}
                  </div>
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
              It may belong to another workspace.
            </p>
            <Button asChild className="mt-5" variant="outline">
              <Link href="/teacher/submissions">Open submissions</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
