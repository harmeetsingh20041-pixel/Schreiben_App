import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import {
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  History,
  RefreshCw,
  UserRoundCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  formatPracticeScore,
  finalizePracticeSemanticReview,
  getPracticeAssignmentBadgeClass,
  getPracticeAssignmentLabel,
  getPracticeAssignmentSummary,
  getPracticeSemanticReviewDraft,
  getPracticeTeacherActions,
  getPracticeWorksheetDetail,
  getPracticeWorksheetReview,
  listPracticeClassContextOptions,
  overridePracticeAttemptScore,
  reassignPracticeAssignment,
  resolvePracticeAssignmentClassContext,
  resolvePracticeSupport,
  type PracticeClassContextOption,
  type PracticeSemanticReviewDecision,
  type PracticeSemanticReviewDraft,
  type PracticeSemanticReviewStatus,
  type PracticeSupportResolution,
  type PracticeTeacherAction,
  type PracticeTeacherActionHistory,
  type PracticeWorksheetDetail,
  type PracticeWorksheetQuestion,
} from "@/services/practiceWorksheetService";

type BusyAction =
  | "context"
  | "semantic"
  | "score"
  | "reassign"
  | "support"
  | null;

type SemanticReviewForm = Omit<
  PracticeSemanticReviewDecision,
  "review_status"
> & { review_status: PracticeSemanticReviewStatus | "" };

function formatPoints(question: PracticeWorksheetQuestion) {
  if (question.points_awarded == null || question.max_points == null)
    return null;
  return `${question.points_awarded}/${question.max_points}`;
}

function reviewLabel(status: string | null | undefined) {
  if (status === "correct") return "Correct";
  if (status === "partially_correct") return "Partly correct";
  if (status === "capitalization_issue") return "Capitalization issue";
  if (status === "minor_punctuation" || status === "minor_formatting")
    return "Accepted with note";
  if (status === "incorrect") return "Incorrect";
  return "Awaiting review";
}

function reviewClass(status: string | null | undefined) {
  if (
    status === "correct" ||
    status === "minor_punctuation" ||
    status === "minor_formatting"
  ) {
    return "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-100";
  }
  if (status === "incorrect") {
    return "border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-100";
  }
  return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100";
}

function stateNumber(state: Record<string, unknown>, key: string) {
  const value = state[key];
  return typeof value === "number" ? value : null;
}

export function describePracticeTeacherAction(action: PracticeTeacherAction) {
  if (action.action_type === "score_override") {
    const before = stateNumber(action.before_state, "score_percent");
    const after = stateNumber(action.after_state, "score_percent");
    return before != null && after != null
      ? `Score changed from ${Math.round(before)}% to ${Math.round(after)}%.`
      : "The calculated score was corrected.";
  }
  if (action.action_type === "assignment_reassigned") {
    return "A follow-up worksheet was assigned without replacing this attempt.";
  }
  if (action.action_type === "semantic_review_finalized") {
    return "Held flexible answers were reviewed and finalized by the teacher.";
  }
  if (action.resolution === "reassigned")
    return "Support closed after reassignment.";
  if (action.resolution === "contacted")
    return "Support closed after teacher contact.";
  return "Support recommendation closed as not needed.";
}

function hasReviewAttempt(detail: PracticeWorksheetDetail) {
  return Boolean(
    detail.assignment.latest_attempt_id &&
    (detail.assignment.latest_attempt_status === "submitted" ||
      detail.assignment.latest_attempt_status === "checked"),
  );
}

export default function TeacherPracticeReview() {
  const { id } = useParams();
  const { toast } = useToast();
  const [detail, setDetail] = useState<PracticeWorksheetDetail | null>(null);
  const [history, setHistory] = useState<PracticeTeacherActionHistory | null>(
    null,
  );
  const [semanticDraft, setSemanticDraft] =
    useState<PracticeSemanticReviewDraft | null>(null);
  const [semanticReviews, setSemanticReviews] = useState<
    SemanticReviewForm[]
  >([]);
  const [semanticReason, setSemanticReason] = useState("");
  const [semanticCommandId, setSemanticCommandId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [scorePercent, setScorePercent] = useState("");
  const [scoreReason, setScoreReason] = useState("");
  const [reassignmentReason, setReassignmentReason] = useState("");
  const [supportResolution, setSupportResolution] =
    useState<PracticeSupportResolution>("contacted");
  const [supportNotes, setSupportNotes] = useState("");
  const [classOptions, setClassOptions] = useState<
    PracticeClassContextOption[]
  >([]);
  const [selectedBatchId, setSelectedBatchId] = useState("");

  async function loadReview() {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      const summary = await getPracticeAssignmentSummary(id);
      const nextDetail = summary.latest_attempt_id
        ? await getPracticeWorksheetReview(id).catch(() =>
            getPracticeWorksheetDetail(id),
          )
        : await getPracticeWorksheetDetail(id);
      const nextHistory = await getPracticeTeacherActions(id);
      const nextSemanticDraft =
        summary.evaluation_status === "needs_review"
          ? await getPracticeSemanticReviewDraft(id)
          : null;
      const nextClassOptions =
        summary.class_context_version === 1 ||
        summary.status !== "unlocked" ||
        summary.practice_test_id !== null ||
        summary.latest_attempt_id !== null
          ? []
          : await listPracticeClassContextOptions(id);
      setDetail(nextDetail);
      setHistory(nextHistory);
      setSemanticDraft(nextSemanticDraft);
      setSemanticReviews(
        nextSemanticDraft?.questions.map((question) => ({
          question_id: question.question_id,
          review_status: "",
          feedback_text: "",
          corrected_answer: question.sample_answer,
          model_answer: question.sample_answer,
          short_reason: "",
        })) ?? [],
      );
      setSemanticReason("");
      setSemanticCommandId(
        nextSemanticDraft ? crypto.randomUUID() : "",
      );
      setClassOptions(nextClassOptions);
      setSelectedBatchId((current) =>
        nextClassOptions.some((option) => option.batch_id === current)
          ? current
          : (nextClassOptions[0]?.batch_id ?? ""),
      );
      setScorePercent(
        nextDetail.assignment.score_percent == null
          ? ""
          : String(nextDetail.assignment.score_percent),
      );
    } catch (loadError) {
      setError(
        formatErrorMessage(loadError, "Unable to load this worksheet review."),
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadReview();
  }, [id]);

  const assignment = detail?.assignment ?? null;
  const score = assignment
    ? formatPracticeScore(assignment, { allowProvisional: true })
    : null;
  const scoreOverrideAvailable = Boolean(
    assignment?.latest_attempt_id &&
    assignment.latest_attempt_status === "checked" &&
    assignment.score_percent != null &&
    assignment.max_score_points != null &&
    assignment.max_score_points > 0,
  );
  const reassignmentAvailable = Boolean(
    assignment && ["passed", "failed", "cancelled"].includes(assignment.status),
  );
  const answersAvailable = detail ? hasReviewAttempt(detail) : false;
  const semanticReviewReady = Boolean(
    semanticDraft &&
    semanticCommandId &&
    semanticReason.trim().length >= 8 &&
    semanticReviews.length === semanticDraft.questions.length &&
    semanticReviews.every((review) =>
      review.review_status &&
      review.feedback_text.trim() &&
      review.short_reason.trim() &&
      (review.review_status === "correct" ||
        Boolean(review.corrected_answer?.trim()))
    ),
  );

  const sortedQuestions = useMemo(
    () =>
      [...(detail?.questions ?? [])].sort(
        (left, right) => left.question_number - right.question_number,
      ),
    [detail?.questions],
  );

  async function runAction(
    action: Exclude<BusyAction, null>,
    operation: () => Promise<unknown>,
    success: string,
  ) {
    try {
      setBusyAction(action);
      setError(null);
      await operation();
      toast({ title: success });
      await loadReview();
    } catch (actionError) {
      setError(
        formatErrorMessage(
          actionError,
          "The teacher action could not be saved.",
        ),
      );
    } finally {
      setBusyAction(null);
    }
  }

  if (loading && !detail) {
    return (
      <div
        className="container mx-auto max-w-5xl px-4 py-12"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        Loading worksheet review...
      </div>
    );
  }

  if (!id || !detail || !history || !assignment) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-12">
        <Card className="border-destructive/30 bg-destructive/5" role="alert">
          <CardContent className="space-y-4 py-6">
            <p className="text-sm text-destructive">
              {error ?? "This worksheet review is not available."}
            </p>
            <Button asChild variant="outline">
              <Link href="/teacher/students">Back to students</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-6xl space-y-6 px-4 py-8 animate-in fade-in duration-300">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            href="/teacher/students"
            className="mb-3 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to students
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">
            Worksheet review
          </h1>
          <p className="mt-1 text-muted-foreground">
            {assignment.student_name ?? "Student"} ·{" "}
            {assignment.grammar_topic_name}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void loadReview()}
          disabled={loading || busyAction !== null}
          aria-busy={loading}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/30 bg-destructive/5" role="alert">
          <CardContent className="flex flex-col items-start gap-4 py-4 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading || busyAction !== null}
              onClick={() => void loadReview()}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {assignment.class_context_version !== 1 &&
        assignment.status === "unlocked" &&
        assignment.practice_test_id === null &&
        assignment.latest_attempt_id === null && (
          <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20">
            <CardHeader>
              <CardTitle className="text-lg">
                Choose the worksheet class
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This older assignment did not preserve its source class. Select
                the class that supplied the writing evidence; the CEFR level
                will then be locked for this worksheet.
              </p>
              {classOptions.length > 0 ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="w-full max-w-md space-y-2">
                    <Label htmlFor="worksheet-class-context">Class</Label>
                    <Select
                      value={selectedBatchId}
                      onValueChange={setSelectedBatchId}
                    >
                      <SelectTrigger
                        id="worksheet-class-context"
                        aria-label="Worksheet class"
                      >
                        <SelectValue placeholder="Choose a class" />
                      </SelectTrigger>
                      <SelectContent>
                        {classOptions.map((option) => (
                          <SelectItem
                            key={option.batch_id}
                            value={option.batch_id}
                          >
                            {option.batch_name} · {option.worksheet_level}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    disabled={!selectedBatchId || busyAction !== null}
                    aria-busy={busyAction === "context"}
                    onClick={() =>
                      void runAction(
                        "context",
                        () =>
                          resolvePracticeAssignmentClassContext(
                            assignment.id,
                            selectedBatchId,
                          ),
                        "Worksheet class saved. It is ready for safe preparation.",
                      )
                    }
                  >
                    {busyAction === "context" ? "Saving..." : "Confirm class"}
                  </Button>
                </div>
              ) : (
                <p
                  className="text-sm font-medium text-amber-900 dark:text-amber-100"
                  role="status"
                >
                  This student is not currently assigned to an active class. Add
                  the student to the correct class first.
                </p>
              )}
            </CardContent>
          </Card>
        )}

      {assignment.class_context_version !== 1 &&
        (assignment.practice_test_id !== null ||
          assignment.latest_attempt_id !== null) && (
          <Card className="border-muted bg-muted/20">
            <CardContent className="py-4 text-sm text-muted-foreground">
              This historical worksheet did not record a source class. Its
              worksheet and completed result remain unchanged.
            </CardContent>
          </Card>
        )}

      <Card>
        <CardContent className="grid gap-4 py-6 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Worksheet
            </p>
            <p className="mt-1 font-medium">
              {assignment.worksheet_title ?? "Preparing worksheet"}
            </p>
            <p className="text-sm text-muted-foreground">
              {[assignment.worksheet_level, assignment.worksheet_difficulty]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {assignment.batch_name && (
              <p className="text-xs text-muted-foreground">
                Class: {assignment.batch_name}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Status
            </p>
            <Badge
              variant="outline"
              className={`mt-1 ${getPracticeAssignmentBadgeClass(assignment)}`}
            >
              {getPracticeAssignmentLabel(assignment)}
            </Badge>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Score
            </p>
            <p className="mt-1 font-medium">{score ?? "Not scored yet"}</p>
            {assignment.scoring_version === "teacher_override_v1" && (
              <p className="text-xs text-muted-foreground">
                Teacher-corrected total
              </p>
            )}
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Support
            </p>
            <p className="mt-1 font-medium capitalize">
              {history.support_status.replace("_", " ")}
            </p>
            <p className="text-xs text-muted-foreground">
              Audit revision {history.current_revision}
            </p>
          </div>
        </CardContent>
      </Card>

      {semanticDraft && (
        <section aria-labelledby="semantic-review-heading">
          <Card className="border-amber-300 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/20">
            <CardHeader>
              <CardTitle
                id="semantic-review-heading"
                className="flex items-center gap-2 text-lg"
              >
                <AlertTriangle className="h-5 w-5" />
                Review held flexible answers
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <p className="text-sm text-muted-foreground">
                Two independent checks and a final adjudication could not
                safely agree. Nothing has been scored or shown to the student.
                Apply the saved rubric below to finish this rare exception.
              </p>

              {semanticDraft.questions.map((question, index) => {
                const review = semanticReviews[index];
                if (!review) return null;
                const updateReview = (changes: Partial<SemanticReviewForm>) =>
                  setSemanticReviews((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, ...changes } : item
                    )
                  );
                return (
                  <fieldset
                    key={question.question_id}
                    className="space-y-4 rounded-lg border bg-background p-4"
                    disabled={busyAction !== null}
                  >
                    <legend className="px-1 font-semibold">
                      Question {question.question_number}
                    </legend>
                    <p className="whitespace-pre-wrap text-sm font-medium">
                      {question.prompt}
                    </p>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-md border bg-muted/20 p-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Student answer
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">
                          {question.student_answer || "No answer"}
                        </p>
                      </div>
                      <div className="rounded-md border bg-muted/20 p-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Rubric and sample
                        </p>
                        {question.rubric?.criteria.map((criterion) => (
                          <p key={criterion} className="mt-1 text-sm">
                            • {criterion}
                          </p>
                        ))}
                        {question.sample_answer && (
                          <p className="mt-2 text-sm text-muted-foreground">
                            Sample: {question.sample_answer}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`semantic-status-${question.question_id}`}>
                          Verdict
                        </Label>
                        <Select
                          value={review.review_status}
                          onValueChange={(value) =>
                            updateReview({
                              review_status: value as PracticeSemanticReviewStatus,
                              corrected_answer: value === "correct"
                                ? null
                                : (review.corrected_answer ??
                                  question.sample_answer),
                            })
                          }
                        >
                          <SelectTrigger
                            id={`semantic-status-${question.question_id}`}
                          >
                            <SelectValue placeholder="Choose a verdict" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="correct">Correct · 1</SelectItem>
                            <SelectItem value="minor_punctuation">
                              Minor punctuation · 1
                            </SelectItem>
                            <SelectItem value="partially_correct">
                              Partly correct · 0.5
                            </SelectItem>
                            <SelectItem value="capitalization_issue">
                              Capitalization issue · 0.5
                            </SelectItem>
                            <SelectItem value="incorrect">
                              Incorrect · 0
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`semantic-correction-${question.question_id}`}>
                          Corrected answer
                        </Label>
                        <Textarea
                          id={`semantic-correction-${question.question_id}`}
                          value={review.corrected_answer ?? ""}
                          maxLength={500}
                          disabled={
                            busyAction !== null ||
                            review.review_status === "correct"
                          }
                          onChange={(event) =>
                            updateReview({ corrected_answer: event.target.value })
                          }
                          placeholder="Required unless the answer is correct."
                        />
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`semantic-feedback-${question.question_id}`}>
                          Student-facing feedback
                        </Label>
                        <Textarea
                          id={`semantic-feedback-${question.question_id}`}
                          value={review.feedback_text}
                          maxLength={500}
                          onChange={(event) =>
                            updateReview({ feedback_text: event.target.value })
                          }
                          placeholder="Explain the result clearly and briefly."
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`semantic-reason-${question.question_id}`}>
                          Short rubric reason
                        </Label>
                        <Textarea
                          id={`semantic-reason-${question.question_id}`}
                          value={review.short_reason}
                          maxLength={240}
                          onChange={(event) =>
                            updateReview({ short_reason: event.target.value })
                          }
                          placeholder="State which rubric rule decided the verdict."
                        />
                      </div>
                    </div>
                  </fieldset>
                );
              })}

              <div className="space-y-2">
                <Label htmlFor="semantic-review-audit-reason">
                  Reason for the audit history
                </Label>
                <Textarea
                  id="semantic-review-audit-reason"
                  value={semanticReason}
                  maxLength={1000}
                  disabled={busyAction !== null}
                  onChange={(event) => setSemanticReason(event.target.value)}
                  placeholder="For example: Reviewed against the saved rubric after automatic disagreement."
                />
              </div>
              <Button
                type="button"
                disabled={!semanticReviewReady || busyAction !== null}
                aria-busy={busyAction === "semantic"}
                onClick={() =>
                  void runAction(
                    "semantic",
                    () =>
                      finalizePracticeSemanticReview({
                        assignmentId: assignment.id,
                        commandId: semanticCommandId,
                        expectedActionRevision:
                          semanticDraft.current_action_revision,
                        reason: semanticReason,
                        reviews: semanticReviews.map((review) => ({
                          ...review,
                          review_status:
                            review.review_status as PracticeSemanticReviewStatus,
                        })),
                      }),
                    "Held answers finalized and released to the student",
                  )
                }
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {busyAction === "semantic"
                  ? "Finalizing answers..."
                  : "Finalize reviewed answers"}
              </Button>
            </CardContent>
          </Card>
        </section>
      )}

      <section aria-labelledby="answers-heading" className="space-y-4">
        <div>
          <h2 id="answers-heading" className="text-2xl font-semibold">
            Answers and reviews
          </h2>
          <p className="text-sm text-muted-foreground">
            {answersAvailable
              ? "The saved student answer and the per-question evaluation are shown together."
              : "The worksheet has not reached a submitted attempt yet."}
          </p>
        </div>

        {sortedQuestions.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              No worksheet questions are available.
            </CardContent>
          </Card>
        ) : (
          sortedQuestions.map((question) => (
            <Card key={question.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <CardTitle className="text-base">
                    Question {question.question_number}
                  </CardTitle>
                  {answersAvailable && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className={reviewClass(question.review_status)}
                      >
                        {reviewLabel(question.review_status)}
                      </Badge>
                      {formatPoints(question) && (
                        <Badge variant="secondary">
                          {formatPoints(question)} points
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="whitespace-pre-wrap font-medium">
                  {question.prompt}
                </p>
                {answersAvailable && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded-lg border bg-muted/20 p-4">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Student answer
                      </p>
                      <p className="whitespace-pre-wrap text-sm">
                        {question.student_answer || "No answer"}
                      </p>
                    </div>
                    <div className="rounded-lg border bg-muted/20 p-4">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Review reference
                      </p>
                      <p className="whitespace-pre-wrap text-sm">
                        {question.corrected_answer ||
                          question.model_answer ||
                          question.correct_answer ||
                          "No fixed answer; use the rubric feedback."}
                      </p>
                    </div>
                  </div>
                )}
                {(question.feedback_text ||
                  question.short_reason ||
                  question.explanation) && (
                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
                    <p className="font-medium">Feedback</p>
                    <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                      {question.feedback_text ||
                        question.short_reason ||
                        question.explanation}
                    </p>
                    {question.evaluator_source && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Source: {question.evaluator_source}
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </section>

      <section aria-labelledby="controls-heading" className="space-y-4">
        <div>
          <h2 id="controls-heading" className="text-2xl font-semibold">
            Teacher controls
          </h2>
          <p className="text-sm text-muted-foreground">
            Every action requires the latest audit revision and remains visible
            in history.
          </p>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <ClipboardCheck className="h-5 w-5" />
                Correct total score
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Per-question reviews stay unchanged. The corrected total is
                clearly marked as a teacher override. Changing a resolved pass
                to a fail opens one new support cycle and cannot later be
                reversed across the pass threshold.
              </p>
              <div className="space-y-2">
                <Label htmlFor="teacher-score-percent">Score percent</Label>
                <Input
                  id="teacher-score-percent"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={scorePercent}
                  disabled={!scoreOverrideAvailable || busyAction !== null}
                  onChange={(event) => setScorePercent(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="teacher-score-reason">
                  Reason for the audit history
                </Label>
                <Textarea
                  id="teacher-score-reason"
                  value={scoreReason}
                  maxLength={1000}
                  disabled={!scoreOverrideAvailable || busyAction !== null}
                  onChange={(event) => setScoreReason(event.target.value)}
                  placeholder="Explain the rubric-based correction."
                />
              </div>
              <Button
                disabled={
                  !scoreOverrideAvailable ||
                  busyAction !== null ||
                  scoreReason.trim().length < 8 ||
                  scorePercent === ""
                }
                aria-busy={busyAction === "score"}
                onClick={() =>
                  void runAction(
                    "score",
                    () =>
                      overridePracticeAttemptScore(
                        assignment.id,
                        Number(scorePercent),
                        scoreReason,
                        history.current_revision,
                      ),
                    "Worksheet score corrected",
                  )
                }
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {busyAction === "score"
                  ? "Saving correction..."
                  : "Save score correction"}
              </Button>
              {!scoreOverrideAvailable && (
                <p className="text-xs text-muted-foreground">
                  A terminal, fully scored attempt is required.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <UserRoundCheck className="h-5 w-5" />
                Reassign practice
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Creates or records the active follow-up assignment. The current
                worksheet and attempt remain immutable.
              </p>
              <div className="space-y-2">
                <Label htmlFor="teacher-reassignment-reason">
                  Reason for reassignment
                </Label>
                <Textarea
                  id="teacher-reassignment-reason"
                  value={reassignmentReason}
                  maxLength={1000}
                  disabled={!reassignmentAvailable || busyAction !== null}
                  onChange={(event) =>
                    setReassignmentReason(event.target.value)
                  }
                  placeholder="Describe what the follow-up should reinforce."
                />
              </div>
              <Button
                variant="outline"
                disabled={
                  !reassignmentAvailable ||
                  busyAction !== null ||
                  reassignmentReason.trim().length < 8
                }
                aria-busy={busyAction === "reassign"}
                onClick={() =>
                  void runAction(
                    "reassign",
                    () =>
                      reassignPracticeAssignment(
                        assignment.id,
                        reassignmentReason,
                        history.current_revision,
                      ),
                    "Follow-up worksheet assigned",
                  )
                }
              >
                {busyAction === "reassign"
                  ? "Assigning..."
                  : "Assign follow-up worksheet"}
              </Button>
              {!reassignmentAvailable && (
                <p className="text-xs text-muted-foreground">
                  Finish or cancel this attempt before reassigning.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {history.support_status === "open" && (
          <Card className="border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/20">
            <CardHeader>
              <CardTitle className="text-lg">
                Resolve teacher-support recommendation
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Closing this recommendation records the operational follow-up
                only. It does not mark the grammar topic as mastered.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="support-resolution">Resolution</Label>
                  <Select
                    value={supportResolution}
                    onValueChange={(value) =>
                      setSupportResolution(value as PracticeSupportResolution)
                    }
                  >
                    <SelectTrigger id="support-resolution">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="contacted">
                        Teacher contacted student
                      </SelectItem>
                      <SelectItem value="reassigned">
                        Follow-up worksheet assigned
                      </SelectItem>
                      <SelectItem value="not_needed">
                        No further action needed
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="support-notes">Notes</Label>
                  <Textarea
                    id="support-notes"
                    value={supportNotes}
                    maxLength={1000}
                    disabled={busyAction !== null}
                    onChange={(event) => setSupportNotes(event.target.value)}
                    placeholder="Optional private teacher note."
                  />
                </div>
              </div>
              <Button
                disabled={busyAction !== null}
                aria-busy={busyAction === "support"}
                onClick={() =>
                  void runAction(
                    "support",
                    () =>
                      resolvePracticeSupport(
                        assignment.id,
                        supportResolution,
                        supportNotes,
                        history.current_revision,
                      ),
                    "Support recommendation resolved",
                  )
                }
              >
                {busyAction === "support"
                  ? "Saving resolution..."
                  : "Mark support as resolved"}
              </Button>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="history-heading">
        <Card>
          <CardHeader>
            <CardTitle
              id="history-heading"
              className="flex items-center gap-2 text-lg"
            >
              <History className="h-5 w-5" />
              Immutable action history
            </CardTitle>
          </CardHeader>
          <CardContent>
            {history.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No teacher changes have been recorded.
              </p>
            ) : (
              <ol className="space-y-4">
                {history.items.map((action) => (
                  <li key={action.id} className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">
                          {describePracticeTeacherAction(action)}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {action.reason}
                        </p>
                      </div>
                      <Badge variant="outline">
                        Revision {action.action_revision}
                      </Badge>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {action.actor_name} ·{" "}
                      {new Date(action.created_at).toLocaleString()}
                    </p>
                    {action.related_assignment_id && (
                      <Link
                        href={`/teacher/practice/${action.related_assignment_id}`}
                        className="mt-2 inline-flex text-sm font-medium text-primary hover:underline"
                      >
                        Open follow-up worksheet
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
