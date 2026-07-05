import { useEffect, useMemo, useState } from "react";
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

function isOpenAssignment(status: string) {
  return status === "unlocked" || status === "in_progress";
}

function isCompletedAssignment(status: string) {
  return status === "completed" || status === "passed" || status === "failed";
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
      <Textarea
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-24 resize-y bg-card"
      />
    );
  }

  return (
    <Input
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="bg-card"
    />
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
      if (nextDetail.assignment.practice_test_id && isOpenAssignment(nextDetail.assignment.status)) {
        await startPracticeAssignment(id);
        setDetail(await getPracticeWorksheetDetail(id));
      } else {
        setDetail(nextDetail);
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
      setDetail({ ...detail, assignment: result });
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
                  <CardTitle className="text-base font-semibold text-muted-foreground">
                    Question {question.question_number}
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
                  {isCompleted && question.explanation && (
                    <p className="rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">{question.explanation}</p>
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
