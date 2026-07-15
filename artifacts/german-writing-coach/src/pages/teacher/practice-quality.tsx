import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  XCircle,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  decideQuarantinedWorksheet,
  getQuarantinedWorksheet,
  type QuarantinedWorksheetQuestion,
} from "@/services/practiceReviewQueueService";

type QualityDecision = "approve" | "reject";

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function rejectionReasons(metadata: Record<string, unknown> | null) {
  const validation = metadata?.validation;
  if (
    !validation ||
    typeof validation !== "object" ||
    Array.isArray(validation)
  )
    return [];
  const reasons = (validation as Record<string, unknown>).rejection_reasons;
  return Array.isArray(reasons)
    ? reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
}

export default function TeacherPracticeQualityReview() {
  const { id } = useParams();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState("");
  const [pendingDecision, setPendingDecision] =
    useState<QualityDecision | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const decisionOpenerRef = useRef<HTMLButtonElement | null>(null);

  const reviewQuery = useQuery({
    queryKey: ["teacher-practice-quality", id ?? "missing-assignment"],
    enabled: Boolean(id),
    queryFn: () => getQuarantinedWorksheet(id!),
    staleTime: 0,
  });

  const review = reviewQuery.data;
  const reasons = rejectionReasons(
    review?.worksheet.generation_metadata ?? null,
  );
  const cleanNotes = notes.trim();
  const decisionReady = cleanNotes.length >= 8 && cleanNotes.length <= 1000;
  const pageError = !id
    ? "This worksheet review link is invalid."
    : reviewQuery.error
      ? formatErrorMessage(
          reviewQuery.error,
          "The private worksheet could not be loaded for review.",
        )
      : null;

  async function confirmDecision() {
    if (!id || !pendingDecision || !decisionReady) return;
    try {
      setSaving(true);
      setActionError(null);
      const decision = pendingDecision;
      await decideQuarantinedWorksheet(id, decision, cleanNotes);
      await queryClient.invalidateQueries({
        queryKey: appQueryKeys.teacherPracticeReviewQueue(
          review?.assignment.workspace_id ?? "inactive-workspace",
        ),
      });
      toast({
        title:
          decision === "approve"
            ? "Worksheet approved and assigned."
            : "Worksheet rejected and kept private.",
        description:
          decision === "reject"
            ? "The assignment is now available for a safe generation retry."
            : undefined,
      });
      setPendingDecision(null);
      navigate("/teacher/review-queue");
    } catch (error) {
      setActionError(
        formatErrorMessage(error, "The worksheet decision could not be saved."),
      );
      setPendingDecision(null);
    } finally {
      setSaving(false);
    }
  }

  if (reviewQuery.isPending) {
    return (
      <div
        className="container mx-auto flex max-w-5xl items-center justify-center px-4 py-16"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading the private worksheet...
      </div>
    );
  }

  if (!review || pageError) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-12">
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="space-y-4 py-6">
            <p className="text-sm text-destructive" role="alert">
              {pageError ?? "This worksheet is no longer waiting for review."}
            </p>
            <Button asChild variant="outline">
              <Link href="/teacher/review-queue">Back to review queue</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-5xl space-y-6 px-4 py-8 animate-in fade-in duration-300">
      <div>
        <Button
          asChild
          variant="link"
          className="mb-3 h-auto p-0 text-muted-foreground"
        >
          <Link href="/teacher/review-queue">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to review queue
          </Link>
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Worksheet quality review
            </h1>
            <p className="mt-1 text-muted-foreground">
              {review.assignment.student_name} ·{" "}
              {review.assignment.grammar_topic_name}
            </p>
          </div>
          <Badge
            variant="outline"
            className="w-fit border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
          >
            Private · needs human review
          </Badge>
        </div>
      </div>

      <Card className="border-amber-300/70 bg-amber-50/60 dark:bg-amber-950/20">
        <CardContent className="flex gap-3 py-5">
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300"
            aria-hidden="true"
          />
          <div>
            <p className="font-semibold">
              This worksheet did not pass independent model validation.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Check every prompt, every accepted answer, the CEFR level, and
              whether an alternative valid answer could be marked wrong.
              Approval makes this exact revision available to the assigned
              student.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{review.worksheet.title}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Level
            </p>
            <p className="mt-1 font-medium">
              {review.worksheet.level} · {review.worksheet.difficulty}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Questions
            </p>
            <p className="mt-1 font-medium">
              {review.worksheet.questions.length}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Generator
            </p>
            <p className="mt-1 font-medium">
              {review.worksheet.generator_model ?? "Recorded provider"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Created
            </p>
            <p className="mt-1 font-medium">
              {formatDate(review.worksheet.created_at)}
            </p>
          </div>
          {(review.worksheet.description || review.worksheet.quality_notes) && (
            <div className="sm:col-span-2 lg:col-span-4">
              {review.worksheet.description && (
                <p className="text-sm">{review.worksheet.description}</p>
              )}
              {review.worksheet.quality_notes && (
                <p className="mt-2 text-sm text-muted-foreground">
                  System note: {review.worksheet.quality_notes}
                </p>
              )}
            </div>
          )}
          {reasons.length > 0 && (
            <div className="sm:col-span-2 lg:col-span-4">
              <p className="text-sm font-medium">
                Independent reviewer concerns
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <section
        aria-labelledby="quality-questions-heading"
        className="space-y-4"
      >
        <div>
          <h2 id="quality-questions-heading" className="text-2xl font-semibold">
            Questions and answer contracts
          </h2>
          <p className="text-sm text-muted-foreground">
            Exact questions must list every valid answer. Flexible questions
            must have a usable rubric and sample answer.
          </p>
        </div>
        {review.worksheet.questions.map((question) => (
          <QualityQuestion key={question.id} question={question} />
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Record the human decision</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="quality-review-notes">Review notes</Label>
            <Textarea
              id="quality-review-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Explain what you verified or why the worksheet must be regenerated."
              maxLength={1000}
              rows={4}
              aria-describedby="quality-review-notes-help"
            />
            <div
              id="quality-review-notes-help"
              className="flex justify-between text-xs text-muted-foreground"
            >
              <span>
                At least 8 characters. This note becomes immutable audit
                evidence.
              </span>
              <span>{notes.length}/1000</span>
            </div>
          </div>
          {actionError && (
            <p className="text-sm text-destructive" role="alert">
              {actionError}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="destructive"
              disabled={!decisionReady || saving}
              onClick={(event) => {
                decisionOpenerRef.current = event.currentTarget;
                setPendingDecision("reject");
              }}
            >
              <XCircle className="mr-2 h-4 w-4" />
              Reject and keep private
            </Button>
            <Button
              type="button"
              disabled={!decisionReady || saving}
              onClick={(event) => {
                decisionOpenerRef.current = event.currentTarget;
                setPendingDecision("approve");
              }}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Approve and assign
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingDecision !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setPendingDecision(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            decisionOpenerRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDecision === "approve"
                ? "Approve this exact worksheet?"
                : "Reject this worksheet?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDecision === "approve"
                ? "The private revision will become available to the assigned student immediately. Once used, it cannot be changed."
                : "The worksheet will stay private and the assignment will move to a retryable failed state."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              aria-busy={saving}
              className={
                pendingDecision === "reject"
                  ? "bg-destructive text-destructive-foreground"
                  : undefined
              }
              onClick={(event) => {
                event.preventDefault();
                void confirmDecision();
              }}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pendingDecision === "approve"
                ? "Approve and assign"
                : "Reject and keep private"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function QualityQuestion({
  question,
}: {
  question: QuarantinedWorksheetQuestion;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Question {question.question_number}</Badge>
          <Badge variant="outline">
            {question.question_type.replaceAll("_", " ")}
          </Badge>
          <Badge variant="outline">
            {question.evaluation_mode === "local_exact"
              ? "Exact scoring"
              : "Semantic scoring"}
          </Badge>
        </div>
        <CardTitle className="pt-2 text-lg">{question.prompt}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {question.options.length > 0 && (
          <div>
            <p className="font-medium">Options</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {question.options.map((option) => (
                <li key={option}>{option}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="font-medium">Canonical answer</p>
            <p className="mt-1 rounded-md border bg-muted/40 p-3">
              {question.correct_answer}
            </p>
          </div>
          <div>
            <p className="font-medium">Accepted answers</p>
            <p className="mt-1 rounded-md border bg-muted/40 p-3">
              {question.accepted_answers.length > 0
                ? question.accepted_answers.join(" · ")
                : "Semantic evaluation — no exact-answer list"}
            </p>
          </div>
        </div>
        {question.rubric && (
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="font-medium">Rubric</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {question.rubric.criteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
            <p className="mt-2 text-muted-foreground">
              Sample answer:{" "}
              {question.rubric.sample_answer ?? "No sample answer supplied"}
            </p>
          </div>
        )}
        <div>
          <p className="font-medium">Student explanation</p>
          <p className="mt-1 text-muted-foreground">{question.explanation}</p>
        </div>
      </CardContent>
    </Card>
  );
}
