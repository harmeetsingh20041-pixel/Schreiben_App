import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { AlertCircle, ArrowLeft, CheckCircle2, ClipboardList, Loader2, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  formatPracticeScore,
  getPracticeAssignmentBadgeClass,
  getPracticeAssignmentLabel,
  getPracticeWorksheetReview,
  getPracticeWorksheetDetail,
  startPracticeAssignment,
  submitPracticeAttempt,
  type PracticeWorksheetDetail,
  type PracticeWorksheetQuestion,
} from "@/services/practiceWorksheetService";

const CHOICE_QUESTION_TYPES = new Set(["multiple_choice", "matching"]);
const LONG_TEXT_QUESTION_TYPES = new Set([
  "sentence_correction",
  "correction",
  "word_order",
  "transformation",
  "short_answer",
  "mini_writing",
  "error_detection",
  "rewrite_sentence",
]);
const TEXT_QUESTION_TYPES = new Set([
  "fill_blank",
  "sentence_correction",
  "correction",
  "word_order",
  "transformation",
  "short_answer",
  "mini_writing",
  "error_detection",
  "rewrite_sentence",
]);
const GERMAN_SPECIAL_LETTERS = ["ä", "ö", "ü", "ß", "Ä", "Ö", "Ü"];
const SHORT_ANSWER_MAX_LENGTH = 300;
const LONG_ANSWER_MAX_LENGTH = 800;

function isOpenAssignment(status: string) {
  return status === "unlocked" || status === "in_progress";
}

function isCompletedAssignment(status: string) {
  return status === "completed" || status === "passed" || status === "failed";
}

function getAnswerMaxLength(question: PracticeWorksheetQuestion) {
  return LONG_TEXT_QUESTION_TYPES.has(question.question_type) ? LONG_ANSWER_MAX_LENGTH : SHORT_ANSWER_MAX_LENGTH;
}

function getReviewBadgeClass(reviewStatus: string | null | undefined) {
  if (reviewStatus === "correct") {
    return "bg-green-50 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-100 dark:border-green-700";
  }
  if (reviewStatus === "incorrect") {
    return "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-100 dark:border-orange-700";
  }
  return "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-700";
}

function getReviewLabel(reviewStatus: string | null | undefined) {
  if (reviewStatus === "correct") return "Correct";
  if (reviewStatus === "incorrect") return "Incorrect";
  return "Submitted for review";
}

function buildAnswerMap(questions: PracticeWorksheetQuestion[]) {
  return Object.fromEntries(
    questions.map((question) => [question.id, question.student_answer ?? ""]),
  );
}

function QuestionAnswerControl({
  question,
  value,
  disabled,
  onChange,
}: {
  question: PracticeWorksheetQuestion;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const maxLength = getAnswerMaxLength(question);

  const insertSpecialLetter = (letter: string) => {
    if (disabled) return;
    const currentValue = value ?? "";
    const field = fieldRef.current;
    const start = field?.selectionStart ?? currentValue.length;
    const end = field?.selectionEnd ?? start;
    const nextValue = `${currentValue.slice(0, start)}${letter}${currentValue.slice(end)}`.slice(0, maxLength);
    const nextCursorPosition = Math.min(start + letter.length, nextValue.length);
    onChange(nextValue);
    window.requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(nextCursorPosition, nextCursorPosition);
    });
  };

  const letterToolbar = TEXT_QUESTION_TYPES.has(question.question_type) ? (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap gap-1.5" aria-label="German special letters">
        {GERMAN_SPECIAL_LETTERS.map((letter) => (
          <Button
            key={letter}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 min-w-7 px-2 text-sm font-semibold leading-none bg-card"
            aria-label={`Insert ${letter}`}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insertSpecialLetter(letter)}
          >
            {letter}
          </Button>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">{value.length}/{maxLength}</span>
    </div>
  ) : null;

  if (CHOICE_QUESTION_TYPES.has(question.question_type) && question.options.length > 0) {
    return (
      <div className="grid gap-3">
        {question.options.map((option) => {
          const selected = value === option;
          return (
            <Button
              key={option}
              type="button"
              variant={selected ? "default" : "outline"}
              className="min-h-11 justify-start whitespace-normal text-left"
              disabled={disabled}
              onClick={() => onChange(option)}
            >
              {option}
            </Button>
          );
        })}
      </div>
    );
  }

  if (LONG_TEXT_QUESTION_TYPES.has(question.question_type)) {
    return (
      <div className="space-y-2">
        <Textarea
          ref={(element) => {
            fieldRef.current = element;
          }}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-24 resize-y bg-card"
        />
        {letterToolbar}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Input
        ref={(element) => {
          fieldRef.current = element;
        }}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        className="bg-card"
      />
      {letterToolbar}
    </div>
  );
}

export default function StudentWorksheet() {
  const { id } = useParams();
  const { toast } = useToast();
  const [detail, setDetail] = useState<PracticeWorksheetDetail | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadWorksheet() {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      const nextDetail = await getPracticeWorksheetDetail(id);
      const loadedDetail = nextDetail.assignment.practice_test_id && isOpenAssignment(nextDetail.assignment.status)
        ? await startPracticeAssignment(id).then(() => getPracticeWorksheetDetail(id))
        : nextDetail;

      if (isCompletedAssignment(loadedDetail.assignment.status)) {
        const reviewDetail = await getPracticeWorksheetReview(id);
        setDetail({
          ...reviewDetail,
          assignment: {
            ...reviewDetail.assignment,
            worksheet_mini_lesson: loadedDetail.assignment.worksheet_mini_lesson,
          },
        });
        setAnswers(buildAnswerMap(reviewDetail.questions));
      } else {
        setDetail(loadedDetail);
        setAnswers(buildAnswerMap(loadedDetail.questions));
      }
    } catch (loadError) {
      setError(formatErrorMessage(loadError, "Unable to load this worksheet."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadWorksheet();
  }, [id]);

  const answeredCount = useMemo(() => (
    detail?.questions.filter((question) => (answers[question.id] ?? "").trim().length > 0).length ?? 0
  ), [answers, detail]);

  const progress = detail && detail.questions.length > 0
    ? Math.round((answeredCount / detail.questions.length) * 100)
    : 0;

  const handleSubmit = async () => {
    if (!id || !detail || isCompletedAssignment(detail.assignment.status)) return;

    try {
      setSubmitting(true);
      setError(null);
      const result = await submitPracticeAttempt(
        id,
        detail.questions.map((question) => ({
          question_id: question.id,
          answer: answers[question.id] ?? "",
        })),
      );
      const reviewDetail = await getPracticeWorksheetReview(id);
      setDetail({
        ...reviewDetail,
        assignment: {
          ...reviewDetail.assignment,
          ...result,
          worksheet_mini_lesson: detail.assignment.worksheet_mini_lesson,
        },
      });
      setAnswers(buildAnswerMap(reviewDetail.questions));
      toast({
        title: result.passed ? "Worksheet passed" : "Worksheet submitted",
        description: formatPracticeScore(result) ?? getPracticeAssignmentLabel(result),
      });
    } catch (submitError) {
      setError(formatErrorMessage(submitError, "Unable to submit this worksheet."));
    } finally {
      setSubmitting(false);
    }
  };

  const assignment = detail?.assignment ?? null;
  const scoreLabel = assignment ? formatPracticeScore(assignment) : null;
  const isCompleted = assignment ? isCompletedAssignment(assignment.status) : false;
  const canSubmit = Boolean(assignment && assignment.practice_test_id && !isCompleted && detail?.questions.length);

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl animate-in fade-in duration-500">
      <Link href="/student/practice">
        <Button variant="ghost" size="sm" className="mb-6 text-muted-foreground hover:text-foreground -ml-3">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Practice Center
        </Button>
      </Link>

      {loading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-3" />
            Loading worksheet...
          </CardContent>
        </Card>
      ) : error ? (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : !detail || !assignment ? (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-muted-foreground">Worksheet was not found.</CardContent>
        </Card>
      ) : !assignment.practice_test_id ? (
        <Card className="border-dashed bg-muted/20">
          <CardContent className="p-10 text-center">
            <ClipboardList className="h-10 w-10 text-primary mx-auto mb-4" />
            <h1 className="text-3xl font-serif mb-3">Practice unlocked</h1>
            <p className="text-muted-foreground">Worksheet will be available soon.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-col gap-4 border-b border-border pb-6 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <Badge variant="outline" className={getPracticeAssignmentBadgeClass(assignment)}>
                  {getPracticeAssignmentLabel(assignment)}
                </Badge>
                {assignment.worksheet_level && <Badge variant="outline">{assignment.worksheet_level}</Badge>}
              </div>
              <h1 className="text-4xl font-serif tracking-tight text-foreground">
                {assignment.worksheet_title ?? "Practice Worksheet"}
              </h1>
              <p className="text-muted-foreground mt-2">
                {assignment.grammar_topic_name} · {detail.questions.length} questions
              </p>
            </div>
            {scoreLabel && (
              <div className="rounded-lg border bg-card px-4 py-3 text-right">
                <p className="text-xs uppercase tracking-widest text-muted-foreground">Score</p>
                <p className="text-2xl font-serif text-foreground">{scoreLabel}</p>
              </div>
            )}
          </div>

          {isCompleted && (
            <Card className={assignment.passed ? "border-green-200 bg-green-50/50 dark:bg-green-950/20" : "border-orange-200 bg-orange-50/50 dark:bg-orange-950/20"}>
              <CardContent className="p-5">
                <div className="flex items-start gap-3">
                  {assignment.passed ? (
                    <CheckCircle2 className="h-5 w-5 text-green-700 mt-0.5" />
                  ) : (
                    <AlertCircle className="h-5 w-5 text-orange-700 mt-0.5" />
                  )}
                  <div>
                    <p className="font-medium text-foreground">{getPracticeAssignmentLabel(assignment)}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {scoreLabel ?? "Your answers were submitted for review."}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {assignment.worksheet_mini_lesson && (
            <Card className="border-border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold text-muted-foreground">Mini lesson</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="font-medium text-foreground">Key idea</p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {assignment.worksheet_mini_lesson.short_explanation}
                  </p>
                </div>
                <div>
                  <p className="font-medium text-foreground">Rule</p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {assignment.worksheet_mini_lesson.key_rule}
                  </p>
                </div>
                {assignment.worksheet_mini_lesson.correct_examples.length > 0 && (
                  <div>
                    <p className="font-medium text-foreground">Examples</p>
                    <div className="mt-2 grid gap-2">
                      {assignment.worksheet_mini_lesson.correct_examples.map((example) => (
                        <p key={example} className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-foreground">
                          {example}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-md border bg-muted/20 p-3">
                    <p className="font-medium text-foreground">Watch for</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {assignment.worksheet_mini_lesson.common_mistake_warning}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/20 p-3">
                    <p className="font-medium text-foreground">Revise</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {assignment.worksheet_mini_lesson.what_to_revise}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {!isCompleted && (
            <Card className="border-border shadow-sm">
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-4 mb-3">
                  <span className="text-sm text-muted-foreground">
                    {answeredCount} of {detail.questions.length} answered
                  </span>
                  <span className="text-sm font-medium text-foreground">{progress}%</span>
                </div>
                <Progress value={progress} className="h-2" />
              </CardContent>
            </Card>
          )}

          <div className="space-y-5">
            {detail.questions.map((question) => (
              <Card key={question.id} className="border-border shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base font-semibold text-muted-foreground">
                    <span>Question {question.question_number}</span>
                    {isCompleted && question.review_status && (
                      <Badge variant="outline" className={getReviewBadgeClass(question.review_status)}>
                        {getReviewLabel(question.review_status)}
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-lg leading-relaxed text-foreground">{question.prompt}</p>
                  <QuestionAnswerControl
                    question={question}
                    value={answers[question.id] ?? ""}
                    disabled={isCompleted || submitting}
                    onChange={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))}
                  />
                  {isCompleted && (
                    <div className="space-y-3 border-t border-border pt-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your answer</p>
                        <p className="mt-1 rounded-md border bg-muted/20 px-3 py-2 text-sm text-foreground">
                          {(question.student_answer ?? "").trim() || "No answer submitted."}
                        </p>
                      </div>
                      {question.correct_answer && (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Correct answer</p>
                          <p className="mt-1 rounded-md border bg-green-50/60 px-3 py-2 text-sm text-foreground dark:bg-green-950/20">
                            {question.correct_answer}
                          </p>
                        </div>
                      )}
                      {question.explanation && (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Explanation</p>
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{question.explanation}</p>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {canSubmit && (
            <div className="sticky bottom-4 z-10 flex justify-end">
              <Button onClick={handleSubmit} disabled={submitting} className="shadow-lg">
                {submitting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                Submit worksheet
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
