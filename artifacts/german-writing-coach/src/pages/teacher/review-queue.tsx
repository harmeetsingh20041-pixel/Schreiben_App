import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  Eye,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  listFeedbackReviewQueuePage,
  releaseFeedback,
  type FeedbackReviewQueueItem,
  type FeedbackReviewCursor,
  type FeedbackReviewReason,
} from "@/services/feedbackReviewService";
import {
  listPracticeReviewQueuePage,
  retryPracticeAttemptEvaluation,
  type PracticeReviewCursor,
  type PracticeReviewKind,
  type PracticeReviewQueueItem,
} from "@/services/practiceReviewQueueService";
import { preparePracticeWorksheet } from "@/services/practiceWorksheetService";

const reasonLabels: Record<FeedbackReviewReason, string> = {
  teacher_review: "Teacher review",
  uncertain: "Uncertain feedback",
  failed: "Evaluation failed",
  overdue_scheduled: "Scheduled release overdue",
};

const practiceKindLabels: Record<PracticeReviewKind, string> = {
  worksheet_quarantine: "Worksheet quality review",
  generation_failed: "Worksheet generation failed",
  evaluation_failed: "Answer evaluation failed",
  semantic_review_required: "Answer review required",
  support_recommended: "Teacher support recommended",
};

function reasonBadge(reason: FeedbackReviewReason) {
  if (reason === "failed" || reason === "overdue_scheduled") {
    return "destructive" as const;
  }
  if (reason === "uncertain") return "outline" as const;
  return "secondary" as const;
}

function practiceBadge(kind: PracticeReviewKind) {
  if (kind === "generation_failed" || kind === "evaluation_failed") {
    return "destructive" as const;
  }
  if (kind === "worksheet_quarantine") return "outline" as const;
  if (kind === "semantic_review_required") return "outline" as const;
  return "secondary" as const;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function MobileTableScrollCue() {
  return (
    <p
      className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:hidden"
      role="note"
    >
      <ArrowLeftRight className="h-4 w-4 shrink-0" aria-hidden="true" />
      Swipe sideways to reach the Action column.
    </p>
  );
}

export default function TeacherReviewQueue() {
  const { activeWorkspaceId: workspaceId, user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<FeedbackReviewReason | "all">("all");
  const [feedbackCursorTrail, setFeedbackCursorTrail] = useState<
    Array<FeedbackReviewCursor | null>
  >([null]);
  const feedbackCursor =
    feedbackCursorTrail[feedbackCursorTrail.length - 1] ?? null;
  const feedbackPageNumber = feedbackCursorTrail.length;
  const [busyFeedbackId, setBusyFeedbackId] = useState<string | null>(null);
  const [practiceKind, setPracticeKind] = useState<PracticeReviewKind | "all">(
    "all",
  );
  const [practiceCursorTrail, setPracticeCursorTrail] = useState<
    Array<PracticeReviewCursor | null>
  >([null]);
  const practiceCursor =
    practiceCursorTrail[practiceCursorTrail.length - 1] ?? null;
  const practicePageNumber = practiceCursorTrail.length;
  const [busyPracticeKey, setBusyPracticeKey] = useState<string | null>(null);
  const [practiceActionError, setPracticeActionError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setFeedbackCursorTrail([null]);
  }, [reason, workspaceId]);

  useEffect(() => {
    setPracticeCursorTrail([null]);
  }, [practiceKind, workspaceId]);

  const feedbackQuery = useQuery({
    queryKey: appQueryKeys.teacherFeedbackQueuePage({
      workspaceId: workspaceId ?? "inactive-workspace",
      reason,
      pageSize: 25,
      cursor: feedbackCursor,
    }),
    enabled: Boolean(user) && Boolean(workspaceId),
    queryFn: () =>
      listFeedbackReviewQueuePage({
        workspaceId: workspaceId!,
        reason: reason === "all" ? null : reason,
        pageSize: 25,
        cursor: feedbackCursor,
      }),
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === workspaceId ? previousData : undefined,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const practiceQuery = useQuery({
    queryKey: appQueryKeys.teacherPracticeReviewQueuePage({
      workspaceId: workspaceId ?? "inactive-workspace",
      kind: practiceKind,
      pageSize: 25,
      cursor: practiceCursor,
    }),
    enabled: Boolean(user) && Boolean(workspaceId),
    queryFn: () =>
      listPracticeReviewQueuePage({
        workspaceId: workspaceId!,
        kind: practiceKind === "all" ? null : practiceKind,
        pageSize: 25,
        cursor: practiceCursor,
      }),
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === workspaceId ? previousData : undefined,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const feedbackPage = feedbackQuery.data;
  const feedbackItems = feedbackPage?.items ?? [];
  const practicePage = practiceQuery.data;
  const practiceItems = practicePage?.items ?? [];
  const workspaceError = !workspaceId
    ? "No active workspace is available."
    : null;
  const feedbackError =
    workspaceError ??
    (feedbackQuery.error
      ? formatErrorMessage(
          feedbackQuery.error,
          "The feedback review queue could not be loaded.",
        )
      : null);
  const practiceError =
    workspaceError ??
    (practiceQuery.error
      ? formatErrorMessage(
          practiceQuery.error,
          "The worksheet and support queue could not be loaded.",
        )
      : null);

  async function refreshPracticeQueue() {
    if (!workspaceId) return;
    await queryClient.invalidateQueries({
      queryKey: appQueryKeys.teacherPracticeReviewQueue(workspaceId),
    });
  }

  async function releaseOverdueFeedback(item: FeedbackReviewQueueItem) {
    if (!workspaceId || !item.feedback_version_id) return;
    try {
      setBusyFeedbackId(item.id);
      await releaseFeedback(item.id, item.feedback_version_id);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.teacherFeedbackQueue(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.teacherSubmissions(workspaceId),
        }),
      ]);
      toast({
        title: "Feedback released",
        description: "The validated feedback is now available to the student.",
      });
    } catch (actionError) {
      toast({
        title: "Feedback release failed",
        description: formatErrorMessage(
          actionError,
          "The automatic recovery will keep retrying. You can also try again here.",
        ),
        variant: "destructive",
      });
    } finally {
      setBusyFeedbackId(null);
    }
  }

  async function retryPracticeItem(item: PracticeReviewQueueItem) {
    try {
      setBusyPracticeKey(item.queue_key);
      setPracticeActionError(null);
      if (item.action_kind === "generation_failed") {
        const state = await preparePracticeWorksheet(item.assignment_id);
        const title =
          state.generation_status === "ready"
            ? "An approved worksheet is ready."
            : state.generation_status === "needs_review"
              ? "The replacement worksheet is held for review."
              : "Worksheet retry queued.";
        toast({ title });
      } else if (item.action_kind === "evaluation_failed" && item.attempt_id) {
        const state = await retryPracticeAttemptEvaluation(
          item.assignment_id,
          item.attempt_id,
        );
        toast({
          title: state.already_processing
            ? "Practice feedback is already processing."
            : "Practice feedback retry queued.",
          description:
            state.processor_kick === "recovery_pending"
              ? "The durable recovery worker will start it if the immediate kick was unavailable."
              : undefined,
        });
      }
      await refreshPracticeQueue();
    } catch (actionError) {
      setPracticeActionError(
        formatErrorMessage(
          actionError,
          "This worksheet action could not be completed.",
        ),
      );
    } finally {
      setBusyPracticeKey(null);
    }
  }

  return (
    <div className="container mx-auto max-w-6xl space-y-8 px-4 py-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Review Queue</h1>
        <p className="mt-1 text-muted-foreground">
          Validated work is handled automatically. Only exceptions and classes
          explicitly set to Teacher review appear here.
        </p>
      </div>

      <section aria-labelledby="writing-review-heading" className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="writing-review-heading" className="text-2xl font-semibold">
              Writing feedback
            </h2>
            <p className="text-sm text-muted-foreground">
              Private drafts and uncertain results remain hidden until they are
              safely released.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={reason}
              onValueChange={(value) =>
                setReason(value as FeedbackReviewReason | "all")
              }
            >
              <SelectTrigger
                className="w-52"
                aria-label="Filter writing feedback queue"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All writing reviews</SelectItem>
                <SelectItem value="teacher_review">Teacher review</SelectItem>
                <SelectItem value="uncertain">Uncertain feedback</SelectItem>
                <SelectItem value="failed">Failed evaluations</SelectItem>
                <SelectItem value="overdue_scheduled">
                  Overdue scheduled releases
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Refresh writing feedback queue"
              aria-busy={feedbackQuery.isFetching}
              disabled={!workspaceId || feedbackQuery.isFetching}
              onClick={() => void feedbackQuery.refetch()}
            >
              {feedbackQuery.isFetching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        <Card className="overflow-hidden shadow-sm">
          <MobileTableScrollCue />
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Writing task</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="hidden md:table-cell">Received</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {feedbackError ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-12 text-center text-destructive"
                    role="alert"
                  >
                    <AlertCircle className="mx-auto mb-2 h-5 w-5" />
                    {feedbackError}
                  </TableCell>
                </TableRow>
              ) : Boolean(workspaceId) && feedbackQuery.isPending ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-12 text-center text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                    Loading writing reviews...
                  </TableCell>
                </TableRow>
              ) : feedbackItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center">
                    <QueueEmpty
                      title="No writing feedback is waiting."
                      detail={
                        reason === "all"
                          ? "Nothing needs you right now. Teacher-review drafts and rare automatic exceptions will appear here."
                          : `There are no ${reasonLabels[reason].toLowerCase()} items right now.`
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                feedbackItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <p className="font-medium">{item.student_name}</p>
                      {item.student_email && (
                        <p className="hidden text-xs text-muted-foreground sm:block">
                          {item.student_email}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="max-w-xs truncate font-medium">
                        {item.question_title}
                      </p>
                      {item.batch_name && (
                        <p className="text-xs text-muted-foreground">
                          {item.batch_name}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={reasonBadge(item.review_reason)}>
                        {reasonLabels[item.review_reason]}
                      </Badge>
                      {item.review_reason === "uncertain" && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Held from the student
                        </p>
                      )}
                      {item.review_reason === "failed" && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Open to retry safely
                        </p>
                      )}
                      {item.review_reason === "overdue_scheduled" && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Automatic recovery is still retrying
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                      {formatDate(item.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      {item.review_reason === "overdue_scheduled" &&
                      item.feedback_version_id ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busyFeedbackId === item.id}
                          aria-busy={busyFeedbackId === item.id}
                          onClick={() => void releaseOverdueFeedback(item)}
                        >
                          {busyFeedbackId === item.id && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          Release now
                        </Button>
                      ) : (
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/teacher/submission/${item.id}`}>
                            <Eye className="mr-2 h-4 w-4" />
                            {item.review_reason === "failed"
                              ? "Open and retry"
                              : "Review"}
                          </Link>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>

        {feedbackPage && feedbackPage.total_count > 0 && (
          <QueuePagination
            pageNumber={feedbackPageNumber}
            pageSize={feedbackPage.page_size}
            returnedCount={feedbackPage.returned_count}
            totalCount={feedbackPage.total_count}
            hasMore={feedbackPage.has_more}
            loading={
              feedbackQuery.isFetching || feedbackQuery.isPlaceholderData
            }
            onPrevious={() =>
              setFeedbackCursorTrail((current) => current.slice(0, -1))
            }
            onNext={() => {
              if (feedbackPage.next_cursor) {
                setFeedbackCursorTrail((current) => [
                  ...current,
                  feedbackPage.next_cursor,
                ]);
              }
            }}
          />
        )}
      </section>

      <section aria-labelledby="practice-review-heading" className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="practice-review-heading" className="text-2xl font-semibold">
              Worksheets and support
            </h2>
            <p className="text-sm text-muted-foreground">
              Inspect quarantined content, recover failed jobs, and act on
              students who need help.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={practiceKind}
              onValueChange={(value) =>
                setPracticeKind(value as PracticeReviewKind | "all")
              }
            >
              <SelectTrigger
                className="w-60"
                aria-label="Filter worksheet and support queue"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All worksheet actions</SelectItem>
                <SelectItem value="worksheet_quarantine">
                  Quality review
                </SelectItem>
                <SelectItem value="generation_failed">
                  Generation failed
                </SelectItem>
                <SelectItem value="evaluation_failed">
                  Evaluation failed
                </SelectItem>
                <SelectItem value="semantic_review_required">
                  Answer review required
                </SelectItem>
                <SelectItem value="support_recommended">
                  Support recommended
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Refresh worksheet and support queue"
              aria-busy={practiceQuery.isFetching}
              disabled={!workspaceId || practiceQuery.isFetching}
              onClick={() => void practiceQuery.refetch()}
            >
              {practiceQuery.isFetching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {practiceActionError && (
          <Card className="border-destructive/30 bg-destructive/5" role="alert">
            <CardContent className="flex items-start gap-2 py-4 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {practiceActionError}
            </CardContent>
          </Card>
        )}

        <Card className="overflow-hidden shadow-sm">
          <MobileTableScrollCue />
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Topic</TableHead>
                <TableHead>Required action</TableHead>
                <TableHead className="hidden md:table-cell">Updated</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {practiceError ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-12 text-center text-destructive"
                    role="alert"
                  >
                    <AlertCircle className="mx-auto mb-2 h-5 w-5" />
                    {practiceError}
                  </TableCell>
                </TableRow>
              ) : Boolean(workspaceId) && practiceQuery.isPending ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-12 text-center text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                    Loading worksheet actions...
                  </TableCell>
                </TableRow>
              ) : practiceItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center">
                    <QueueEmpty
                      title="No worksheet or support actions are waiting."
                      detail={
                        practiceKind === "all"
                          ? "Held answer reviews, quarantined worksheets, failed jobs, and support recommendations will appear here."
                          : `There are no ${practiceKindLabels[practiceKind].toLowerCase()} items right now.`
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                practiceItems.map((item) => (
                  <TableRow key={item.queue_key}>
                    <TableCell>
                      <p className="font-medium">{item.student_name}</p>
                      {item.student_email && (
                        <p className="hidden text-xs text-muted-foreground sm:block">
                          {item.student_email}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{item.grammar_topic_name}</p>
                      {item.worksheet_title && (
                        <p className="max-w-xs truncate text-xs text-muted-foreground">
                          {item.worksheet_title}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={practiceBadge(item.action_kind)}>
                        {item.error_code === "worksheet_class_context_required"
                          ? "Class confirmation needed"
                          : practiceKindLabels[item.action_kind]}
                      </Badge>
                      {item.action_kind === "worksheet_quarantine" && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Private until a human decision
                        </p>
                      )}
                      {item.action_kind === "semantic_review_required" && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Automatic checks could not safely agree; the score is
                          still hidden from the student
                        </p>
                      )}
                      {item.error_code ===
                        "worksheet_class_context_required" && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Choose the source class before retrying
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                      {formatDate(item.updated_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <PracticeQueueAction
                        item={item}
                        busy={busyPracticeKey === item.queue_key}
                        onRetry={() => void retryPracticeItem(item)}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>

        {practicePage && practicePage.total_count > 0 && (
          <QueuePagination
            pageNumber={practicePageNumber}
            pageSize={practicePage.page_size}
            returnedCount={practicePage.returned_count}
            totalCount={practicePage.total_count}
            hasMore={practicePage.has_more}
            loading={
              practiceQuery.isFetching ||
              practiceQuery.isPlaceholderData ||
              busyPracticeKey !== null
            }
            onPrevious={() =>
              setPracticeCursorTrail((current) => current.slice(0, -1))
            }
            onNext={() => {
              if (practicePage.next_cursor) {
                setPracticeCursorTrail((current) => [
                  ...current,
                  practicePage.next_cursor,
                ]);
              }
            }}
          />
        )}
      </section>
    </div>
  );
}

function PracticeQueueAction({
  item,
  busy,
  onRetry,
}: {
  item: PracticeReviewQueueItem;
  busy: boolean;
  onRetry: () => void;
}) {
  if (item.action_kind === "worksheet_quarantine") {
    return (
      <Button asChild variant="ghost" size="sm">
        <Link href={`/teacher/practice-quality/${item.assignment_id}`}>
          <Eye className="mr-2 h-4 w-4" />
          Inspect
        </Link>
      </Button>
    );
  }
  if (item.action_kind === "support_recommended") {
    return (
      <Button asChild variant="ghost" size="sm">
        <Link href={`/teacher/practice/${item.assignment_id}`}>
          <Eye className="mr-2 h-4 w-4" />
          Review support
        </Link>
      </Button>
    );
  }
  if (item.action_kind === "semantic_review_required") {
    return (
      <Button asChild variant="ghost" size="sm">
        <Link href={`/teacher/practice/${item.assignment_id}`}>
          <Eye className="mr-2 h-4 w-4" />
          Review answers
        </Link>
      </Button>
    );
  }
  if (item.error_code === "worksheet_class_context_required") {
    return (
      <Button asChild variant="outline" size="sm">
        <Link href={`/teacher/practice/${item.assignment_id}`}>
          <Eye className="mr-2 h-4 w-4" />
          Choose class
        </Link>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={
        busy || (item.action_kind === "evaluation_failed" && !item.attempt_id)
      }
      aria-busy={busy}
      onClick={onRetry}
    >
      {busy ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <RotateCcw className="mr-2 h-4 w-4" />
      )}
      Retry safely
    </Button>
  );
}

function QueueEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div>
      <CheckCircle2
        className="mx-auto mb-2 h-6 w-6 text-emerald-600"
        aria-hidden="true"
      />
      <p className="font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function QueuePagination({
  pageNumber,
  pageSize,
  returnedCount,
  totalCount,
  hasMore,
  loading,
  onPrevious,
  onNext,
}: {
  pageNumber: number;
  pageSize: number;
  returnedCount: number;
  totalCount: number;
  hasMore: boolean;
  loading: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      {loading ? (
        <p role="status">Loading page {pageNumber}...</p>
      ) : (
        <p>
          Showing {(pageNumber - 1) * pageSize + 1}–
          {Math.min((pageNumber - 1) * pageSize + returnedCount, totalCount)} of{" "}
          {totalCount}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pageNumber === 1 || loading}
          onClick={onPrevious}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasMore || loading}
          onClick={onNext}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
