import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Loader2,
  RefreshCw,
  Send,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  isKickablePracticeEvaluationStatus,
  isLivePracticeEvaluationStatus,
  useBoundedPracticeRefresh,
  useLivePracticeAttempt,
} from "@/hooks/use-live-practice-attempt";
import { formatErrorMessage } from "@/lib/workspaceData";
import { isPublicAppError, PublicAppError } from "@/lib/appError";
import { hasScheduledAutomaticRetry } from "@/lib/automaticRetryState";
import {
  createNextPracticeAssignment,
  evaluatePracticeAttempt,
  formatPracticeScore,
  getChildPracticeAssignment,
  getPracticeAssignmentBadgeClass,
  getPracticeAssignmentLabel,
  hasDurableWorksheetPreparationState,
  getPracticeWorksheetReview,
  getPracticeWorksheetDetail,
  getPracticeDraft,
  preparePracticeWorksheet,
  savePracticeDraft,
  startPracticeAssignment,
  submitPracticeAttempt,
  type PracticeAssignmentSummary,
  type PracticeAnswerInput,
  type PracticeDraft,
  type PracticeWorksheetDetail,
  type PracticeWorksheetQuestion,
} from "@/services/practiceWorksheetService";
import { SerializedSaveQueue } from "@/services/serializedSaveQueue";

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
const PRACTICE_AUTOSAVE_DELAY_MS = 700;
const SAFE_WORKSHEET_PREPARATION_ERROR =
  "Worksheet preparation did not finish. Your progress is safe; retry preparation now.";
const RETRY_EXHAUSTED_COPY =
  "Automatic worksheet retries are exhausted. Your teacher can review this topic while approved material is checked.";

type DraftSaveState = "idle" | "saving" | "saved" | "conflict" | "error";

function isOpenAssignment(status: string) {
  return status === "unlocked" || status === "in_progress";
}

function isCompletedAssignment(status: string) {
  return status === "completed" || status === "passed" || status === "failed";
}

function getAnswerMaxLength(question: PracticeWorksheetQuestion) {
  return LONG_TEXT_QUESTION_TYPES.has(question.question_type)
    ? LONG_ANSWER_MAX_LENGTH
    : SHORT_ANSWER_MAX_LENGTH;
}

function getReviewBadgeClass(reviewStatus: string | null | undefined) {
  if (reviewStatus === "correct") {
    return "bg-green-50 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-100 dark:border-green-700";
  }
  if (reviewStatus === "partially_correct") {
    return "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:border-amber-700";
  }
  if (
    reviewStatus === "minor_punctuation" ||
    reviewStatus === "minor_formatting"
  ) {
    return "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-100 dark:border-emerald-700";
  }
  if (reviewStatus === "capitalization_issue") {
    return "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-100 dark:border-yellow-700";
  }
  if (reviewStatus === "incorrect") {
    return "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-100 dark:border-orange-700";
  }
  return "bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-700";
}

function getReviewLabel(reviewStatus: string | null | undefined) {
  if (reviewStatus === "correct") return "Correct";
  if (reviewStatus === "partially_correct") return "Partly correct";
  if (reviewStatus === "minor_punctuation")
    return "Accepted — check punctuation";
  if (reviewStatus === "capitalization_issue")
    return "Capitalization issue — partial credit";
  if (reviewStatus === "minor_formatting") return "Accepted — minor formatting";
  if (reviewStatus === "incorrect") return "Incorrect";
  return "Submitted for review";
}

function formatQuestionPoints(question: PracticeWorksheetQuestion) {
  if (
    question.points_awarded == null ||
    question.max_points == null ||
    question.max_points <= 0
  )
    return null;
  const formatPoint = (value: number) =>
    Number.isInteger(value)
      ? value.toString()
      : value.toFixed(2).replace(/\.?0+$/, "");
  return `${formatPoint(question.points_awarded)}/${formatPoint(question.max_points)}`;
}

function buildAnswerMap(questions: PracticeWorksheetQuestion[]) {
  return Object.fromEntries(
    questions.map((question) => [question.id, question.student_answer ?? ""]),
  );
}

export function serializePracticeAnswers(
  questions: PracticeWorksheetQuestion[],
  answers: Record<string, string>,
): PracticeAnswerInput[] {
  return [...questions]
    .sort(
      (left, right) =>
        left.question_number - right.question_number ||
        left.id.localeCompare(right.id),
    )
    .map((question) => ({
      question_id: question.id,
      answer: answers[question.id] ?? "",
    }));
}

function practiceAnswersSignature(answers: PracticeAnswerInput[]) {
  return JSON.stringify(answers);
}

export function QuestionAnswerControl({
  question,
  value,
  disabled,
  labelledBy,
  onChange,
}: {
  question: PracticeWorksheetQuestion;
  value: string;
  disabled: boolean;
  labelledBy?: string;
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
    const nextValue =
      `${currentValue.slice(0, start)}${letter}${currentValue.slice(end)}`.slice(
        0,
        maxLength,
      );
    const nextCursorPosition = Math.min(
      start + letter.length,
      nextValue.length,
    );
    onChange(nextValue);
    window.requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(nextCursorPosition, nextCursorPosition);
    });
  };

  const letterToolbar = TEXT_QUESTION_TYPES.has(question.question_type) ? (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={`German special letters for question ${question.question_number}`}
      >
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
      <span className="text-xs text-muted-foreground">
        {value.length}/{maxLength}
      </span>
    </div>
  ) : null;

  if (
    CHOICE_QUESTION_TYPES.has(question.question_type) &&
    question.options.length > 0
  ) {
    return (
      <RadioGroup
        value={value}
        disabled={disabled}
        aria-label={
          labelledBy
            ? undefined
            : `Answer choices for question ${question.question_number}`
        }
        aria-labelledby={labelledBy}
        data-testid={`worksheet-answer-${question.question_number}`}
        onValueChange={onChange}
        className="gap-3"
      >
        {question.options.map((option, optionIndex) => {
          const selected = value === option;
          const optionId = `question-${question.id}-option-${optionIndex}`;
          return (
            <label
              key={optionId}
              htmlFor={optionId}
              className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-4 py-3 text-left text-sm shadow-sm transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${
                selected
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-input bg-background hover:bg-muted"
              } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <RadioGroupItem
                id={optionId}
                value={option}
                aria-label={option}
                className="shrink-0"
              />
              <span className="whitespace-normal">{option}</span>
            </label>
          );
        })}
      </RadioGroup>
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
          aria-label={
            labelledBy
              ? undefined
              : `Answer for question ${question.question_number}`
          }
          aria-labelledby={labelledBy}
          data-testid={`worksheet-answer-${question.question_number}`}
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
        aria-label={
          labelledBy
            ? undefined
            : `Answer for question ${question.question_number}`
        }
        aria-labelledby={labelledBy}
        data-testid={`worksheet-answer-${question.question_number}`}
        onChange={(event) => onChange(event.target.value)}
        className="bg-card"
      />
      {letterToolbar}
    </div>
  );
}

export default function StudentWorksheet() {
  const { id } = useParams();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [detail, setDetail] = useState<PracticeWorksheetDetail | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [evaluatingFeedback, setEvaluatingFeedback] = useState(false);
  const [creatingNextPractice, setCreatingNextPractice] = useState(false);
  const [preparingWorksheet, setPreparingWorksheet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextAssignment, setNextAssignment] =
    useState<PracticeAssignmentSummary | null>(null);
  const [draftState, setDraftState] = useState<DraftSaveState>("idle");
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const kickedAttemptRef = useRef<string | null>(null);
  const answersRef = useRef<Record<string, string>>({});
  const practiceDraftRef = useRef({
    id: null as string | null,
    revision: 0,
    lastSavedSignature: "",
  });
  const practiceSaveQueueRef = useRef(new SerializedSaveQueue());
  const practiceAutosaveTimerRef = useRef<number | null>(null);
  const practiceConflictRef = useRef(false);
  const practiceDraftReadyRef = useRef(false);

  const replaceAnswers = (nextAnswers: Record<string, string>) => {
    answersRef.current = nextAnswers;
    setAnswers(nextAnswers);
  };

  const restorePracticeDraft = (
    draft: PracticeDraft,
    questions: PracticeWorksheetQuestion[],
  ) => {
    const knownQuestionIds = new Set(questions.map((question) => question.id));
    if (
      draft.answers.some((answer) => !knownQuestionIds.has(answer.question_id))
    ) {
      throw new PublicAppError(
        "data_invalid_response",
        "Saved worksheet answers no longer match this worksheet. Please contact your teacher.",
      );
    }
    const restoredAnswers = buildAnswerMap(questions);
    for (const answer of draft.answers) {
      restoredAnswers[answer.question_id] = answer.answer;
    }
    const canonical = serializePracticeAnswers(questions, restoredAnswers);
    practiceDraftRef.current = {
      id: draft.draft_id,
      revision: draft.revision,
      lastSavedSignature: practiceAnswersSignature(canonical),
    };
    practiceConflictRef.current = false;
    setDraftRevision(draft.revision);
    setDraftState("saved");
    setDraftMessage("Saved answers restored.");
    replaceAnswers(restoredAnswers);
  };

  const initializeEmptyPracticeDraft = (
    questions: PracticeWorksheetQuestion[],
  ) => {
    const emptyAnswers = buildAnswerMap(questions);
    practiceDraftRef.current = {
      id: null,
      revision: 0,
      lastSavedSignature: practiceAnswersSignature(
        serializePracticeAnswers(questions, emptyAnswers),
      ),
    };
    practiceConflictRef.current = false;
    setDraftRevision(0);
    setDraftState("idle");
    setDraftMessage("Answers save automatically.");
    replaceAnswers(emptyAnswers);
  };

  const enqueuePracticeSave = (
    snapshot: PracticeAnswerInput[],
  ): Promise<PracticeDraft> => {
    if (!id) {
      return Promise.reject(
        new PublicAppError(
          "data_invalid_request",
          "Practice assignment is missing.",
        ),
      );
    }
    if (practiceConflictRef.current) {
      return Promise.reject(
        new PublicAppError(
          "data_conflict",
          "These answers changed elsewhere. Reload the saved version before continuing.",
        ),
      );
    }

    const snapshotSignature = practiceAnswersSignature(snapshot);
    setDraftState("saving");
    setDraftMessage("Saving answers…");
    const operation = practiceSaveQueueRef.current
      .enqueue(async () => {
        const saved = await savePracticeDraft(
          id,
          snapshot,
          practiceDraftRef.current.revision,
        );
        if (practiceAnswersSignature(saved.answers) !== snapshotSignature) {
          throw new PublicAppError(
            "data_invalid_response",
            "Saved worksheet answers did not match your current answers. Nothing was submitted.",
          );
        }
        practiceDraftRef.current = {
          id: saved.draft_id,
          revision: saved.revision,
          lastSavedSignature: snapshotSignature,
        };
        setDraftRevision(saved.revision);
        const latestQuestions = detail?.questions ?? [];
        const latestSignature = practiceAnswersSignature(
          serializePracticeAnswers(latestQuestions, answersRef.current),
        );
        if (latestSignature === snapshotSignature) {
          setDraftState("saved");
          setDraftMessage("All answers saved.");
        } else {
          setDraftState("saving");
          setDraftMessage("Saving newer answers…");
        }
        return saved;
      })
      .catch((saveError: unknown) => {
        if (isPublicAppError(saveError) && saveError.code === "data_conflict") {
          practiceConflictRef.current = true;
          setDraftState("conflict");
          setDraftMessage(
            "These answers changed elsewhere. Your current answers were not overwritten.",
          );
        } else {
          setDraftState("error");
          setDraftMessage(
            formatErrorMessage(
              saveError,
              "Answers could not be saved. Keep this page open and try again.",
            ),
          );
        }
        throw saveError;
      });

    return operation;
  };

  async function loadWorksheet() {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      setNextAssignment(null);
      practiceDraftReadyRef.current = false;
      const nextDetail = await getPracticeWorksheetDetail(id);
      const loadedDetail =
        nextDetail.assignment.practice_test_id &&
        isOpenAssignment(nextDetail.assignment.status)
          ? await startPracticeAssignment(id).then(() =>
              getPracticeWorksheetDetail(id),
            )
          : nextDetail;

      if (isCompletedAssignment(loadedDetail.assignment.status)) {
        const reviewDetail = await getPracticeWorksheetReview(id);
        if (reviewDetail.assignment.status === "failed") {
          const existingNextAssignment = await getChildPracticeAssignment(id);
          setNextAssignment(existingNextAssignment);
        }
        setDetail({
          ...reviewDetail,
          assignment: {
            ...reviewDetail.assignment,
            worksheet_mini_lesson:
              loadedDetail.assignment.worksheet_mini_lesson,
          },
        });
        replaceAnswers(buildAnswerMap(reviewDetail.questions));
        practiceDraftRef.current = {
          id: null,
          revision: 0,
          lastSavedSignature: "",
        };
        setDraftRevision(0);
        setDraftState("idle");
        setDraftMessage(null);
      } else {
        setDetail(loadedDetail);
        if (
          loadedDetail.questions.length > 0 &&
          isOpenAssignment(loadedDetail.assignment.status)
        ) {
          const savedDraft = await getPracticeDraft(id);
          if (savedDraft) {
            restorePracticeDraft(savedDraft, loadedDetail.questions);
          } else {
            initializeEmptyPracticeDraft(loadedDetail.questions);
          }
          practiceDraftReadyRef.current = true;
        } else {
          initializeEmptyPracticeDraft(loadedDetail.questions);
        }
      }
    } catch (loadError) {
      const message = formatErrorMessage(
        loadError,
        "Unable to load this worksheet.",
      );
      setError(message);
      setDraftState("error");
      setDraftMessage(
        "Saved answers could not be checked. Editing and submission are paused to prevent data loss.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadWorksheet();
  }, [id]);

  const answeredCount = useMemo(
    () =>
      detail?.questions.filter(
        (question) => (answers[question.id] ?? "").trim().length > 0,
      ).length ?? 0,
    [answers, detail],
  );
  const allQuestionsAnswered = Boolean(
    detail?.questions.length &&
    detail.questions.every(
      (question) => (answers[question.id] ?? "").trim().length > 0,
    ),
  );

  const progress =
    detail && detail.questions.length > 0
      ? Math.round((answeredCount / detail.questions.length) * 100)
      : 0;

  const hasSubmittedForReview = useMemo(
    () =>
      detail?.questions.some(
        (question) => question.review_status === "submitted_for_review",
      ) ?? false,
    [detail],
  );

  const assignment = detail?.assignment ?? null;

  useEffect(() => {
    if (
      !id ||
      !detail ||
      !practiceDraftReadyRef.current ||
      !isOpenAssignment(detail.assignment.status) ||
      detail.questions.length === 0 ||
      submitting ||
      practiceConflictRef.current
    )
      return;

    const snapshot = serializePracticeAnswers(detail.questions, answers);
    const signature = practiceAnswersSignature(snapshot);
    if (signature === practiceDraftRef.current.lastSavedSignature) return;

    setDraftState("saving");
    setDraftMessage("Changes waiting to save…");
    if (practiceAutosaveTimerRef.current !== null) {
      window.clearTimeout(practiceAutosaveTimerRef.current);
    }
    const timeoutId = window.setTimeout(() => {
      practiceAutosaveTimerRef.current = null;
      void enqueuePracticeSave(snapshot).catch(() => {
        // The save queue maps the failure to a visible, safe state.
      });
    }, PRACTICE_AUTOSAVE_DELAY_MS);
    practiceAutosaveTimerRef.current = timeoutId;
    return () => {
      window.clearTimeout(timeoutId);
      if (practiceAutosaveTimerRef.current === timeoutId)
        practiceAutosaveTimerRef.current = null;
    };
  }, [answers, detail, id, submitting]);

  useEffect(() => {
    if (!id || !detail || !isOpenAssignment(detail.assignment.status)) return;

    const currentSnapshot = () =>
      serializePracticeAnswers(detail.questions, answersRef.current);
    const hasUnsavedAnswers = () =>
      Boolean(
        practiceDraftReadyRef.current &&
        !submitting &&
        !practiceConflictRef.current &&
        practiceAnswersSignature(currentSnapshot()) !==
          practiceDraftRef.current.lastSavedSignature,
      );
    const flushUnsavedAnswers = () => {
      if (!hasUnsavedAnswers()) return;
      if (practiceAutosaveTimerRef.current !== null) {
        window.clearTimeout(practiceAutosaveTimerRef.current);
        practiceAutosaveTimerRef.current = null;
      }
      void enqueuePracticeSave(currentSnapshot()).catch(() => {
        // beforeunload keeps the user on the page when persistence is not yet confirmed.
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushUnsavedAnswers();
    };
    const handlePageHide = () => flushUnsavedAnswers();
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedAnswers()) return;
      flushUnsavedAnswers();
      event.preventDefault();
      event.returnValue = "";
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [detail, id, submitting]);

  const handlePracticeFieldBlur = () => {
    if (
      !detail ||
      !practiceDraftReadyRef.current ||
      !isOpenAssignment(detail.assignment.status) ||
      submitting ||
      practiceConflictRef.current
    )
      return;
    const snapshot = serializePracticeAnswers(
      detail.questions,
      answersRef.current,
    );
    if (
      practiceAnswersSignature(snapshot) ===
      practiceDraftRef.current.lastSavedSignature
    )
      return;
    if (practiceAutosaveTimerRef.current !== null) {
      window.clearTimeout(practiceAutosaveTimerRef.current);
      practiceAutosaveTimerRef.current = null;
    }
    void enqueuePracticeSave(snapshot).catch(() => {
      // The visible draft state provides conflict/error recovery.
    });
  };

  const handleReloadPracticeDraft = async () => {
    if (!id || !detail) return;
    try {
      setDraftState("saving");
      setDraftMessage("Loading the saved answers…");
      const savedDraft = await getPracticeDraft(id);
      if (!savedDraft) {
        throw new PublicAppError(
          "data_not_found",
          "No saved worksheet answers are available.",
        );
      }
      restorePracticeDraft(savedDraft, detail.questions);
      setError(null);
    } catch (reloadError) {
      const message = formatErrorMessage(
        reloadError,
        "Saved worksheet answers could not be reloaded.",
      );
      setDraftState("error");
      setDraftMessage(message);
      setError(message);
    }
  };

  const handleRetryPracticeSave = async () => {
    if (!detail || !id || submitting) return;
    try {
      setError(null);
      await enqueuePracticeSave(
        serializePracticeAnswers(detail.questions, answersRef.current),
      );
    } catch (retryError) {
      setError(
        formatErrorMessage(retryError, "Worksheet answers could not be saved."),
      );
    }
  };

  async function refreshSubmittedReview() {
    if (!id) return null;
    const reviewDetail = await getPracticeWorksheetReview(id);
    setDetail((currentDetail) => ({
      ...reviewDetail,
      assignment: {
        ...reviewDetail.assignment,
        worksheet_mini_lesson:
          currentDetail?.assignment.worksheet_mini_lesson ??
          reviewDetail.assignment.worksheet_mini_lesson,
      },
    }));
    replaceAnswers(buildAnswerMap(reviewDetail.questions));
    if (reviewDetail.assignment.status === "failed") {
      setNextAssignment(await getChildPracticeAssignment(id));
    }
    return reviewDetail;
  }

  const hasLiveEvaluation = isLivePracticeEvaluationStatus(
    assignment?.evaluation_status,
  );
  const livePracticeAttempt = useLivePracticeAttempt({
    attemptId: assignment?.latest_attempt_id,
    enabled: Boolean(assignment?.latest_attempt_id && hasLiveEvaluation),
    onRefresh: async () => {
      await refreshSubmittedReview();
    },
  });

  const generationPending = Boolean(
    id &&
    assignment &&
    !assignment.practice_test_id &&
    ["queued", "generating"].includes(assignment.generation_status),
  );

  async function refreshWorksheetPreparation() {
    if (!id) return;
    const nextDetail = await getPracticeWorksheetDetail(id);
    setDetail(nextDetail);
    if (nextDetail.assignment.practice_test_id) {
      await loadWorksheet();
    } else {
      replaceAnswers(buildAnswerMap(nextDetail.questions));
    }
  }

  const worksheetGenerationPoll = useBoundedPracticeRefresh({
    enabled: generationPending,
    intervalMs: 5_000,
    onRefresh: async () => {
      await refreshWorksheetPreparation();
    },
  });

  async function handleEvaluateFeedback(showToast = false) {
    if (!id || !detail || evaluatingFeedback) return;

    try {
      setEvaluatingFeedback(true);
      setError(null);
      const evaluation = await evaluatePracticeAttempt(id);
      const reviewDetail = await refreshSubmittedReview();
      if (showToast) {
        const feedbackReady =
          evaluation.evaluated ||
          reviewDetail?.assignment.evaluation_status === "completed" ||
          reviewDetail?.assignment.evaluation_status === "not_needed";
        toast(
          feedbackReady
            ? {
                title: "Feedback ready",
                description: reviewDetail
                  ? (formatPracticeScore(reviewDetail.assignment) ??
                    getPracticeAssignmentLabel(reviewDetail.assignment))
                  : "Your checked worksheet is ready.",
              }
            : {
                title: "Feedback queued",
                description:
                  "Your answers are saved. Detailed feedback is still being prepared.",
              },
        );
      }
    } catch {
      try {
        await refreshSubmittedReview();
      } catch {
        setError(
          "Feedback status could not be refreshed. Your submitted answers are still saved.",
        );
      }
    } finally {
      setEvaluatingFeedback(false);
    }
  }

  useEffect(() => {
    const attemptId = assignment?.latest_attempt_id;
    if (
      !attemptId ||
      evaluatingFeedback ||
      !isKickablePracticeEvaluationStatus(assignment?.evaluation_status) ||
      kickedAttemptRef.current === attemptId
    )
      return;

    kickedAttemptRef.current = attemptId;
    void handleEvaluateFeedback(false);
  }, [
    assignment?.evaluation_status,
    assignment?.latest_attempt_id,
    evaluatingFeedback,
  ]);

  const handleSubmit = async () => {
    if (!id || !detail || isCompletedAssignment(detail.assignment.status))
      return;
    if (!allQuestionsAnswered) {
      setError("Answer all questions before submitting.");
      return;
    }

    try {
      setSubmitting(true);
      setError(null);
      await practiceSaveQueueRef.current.whenIdle();

      let latestSnapshot = serializePracticeAnswers(
        detail.questions,
        answersRef.current,
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const latestSignature = practiceAnswersSignature(latestSnapshot);
        if (
          practiceDraftRef.current.revision < 1 ||
          practiceDraftRef.current.lastSavedSignature !== latestSignature
        ) {
          await enqueuePracticeSave(latestSnapshot);
        }
        const currentSnapshot = serializePracticeAnswers(
          detail.questions,
          answersRef.current,
        );
        if (practiceAnswersSignature(currentSnapshot) === latestSignature)
          break;
        latestSnapshot = currentSnapshot;
      }

      const lockedSnapshot = serializePracticeAnswers(
        detail.questions,
        answersRef.current,
      );
      const lockedSignature = practiceAnswersSignature(lockedSnapshot);
      if (lockedSnapshot.some((answer) => answer.answer.trim().length === 0)) {
        throw new PublicAppError(
          "data_invalid_request",
          "Answer all questions before submitting.",
        );
      }
      if (
        practiceDraftRef.current.revision < 1 ||
        practiceDraftRef.current.lastSavedSignature !== lockedSignature
      ) {
        throw new PublicAppError(
          "data_conflict",
          "Your latest answers could not be locked for submission. Review the save status and try again.",
        );
      }

      const result = await submitPracticeAttempt(
        id,
        practiceDraftRef.current.revision,
      );
      const reviewDetail = await getPracticeWorksheetReview(id);
      setDetail({
        ...reviewDetail,
        assignment: {
          ...result,
          ...reviewDetail.assignment,
          worksheet_mini_lesson: detail.assignment.worksheet_mini_lesson,
        },
      });
      replaceAnswers(buildAnswerMap(reviewDetail.questions));
      practiceDraftReadyRef.current = false;
      practiceDraftRef.current = {
        id: null,
        revision: 0,
        lastSavedSignature: "",
      };
      setDraftRevision(0);
      setDraftState("idle");
      setDraftMessage(null);
      const reviewScoreLabel = formatPracticeScore(reviewDetail.assignment);
      toast({
        title: reviewDetail.assignment.passed
          ? "Worksheet passed"
          : "Worksheet submitted",
        description:
          reviewScoreLabel ??
          getPracticeAssignmentLabel(reviewDetail.assignment),
      });
    } catch (submitError) {
      setError(
        formatErrorMessage(submitError, "Unable to submit this worksheet."),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handlePracticeAgain = async () => {
    if (
      !id ||
      !detail ||
      detail.assignment.status !== "failed" ||
      creatingNextPractice
    )
      return;
    if (detail.assignment.source === "adaptive_repeat") return;
    if (nextAssignment) {
      navigate(`/student/practice/${nextAssignment.id}`);
      return;
    }

    try {
      setCreatingNextPractice(true);
      setError(null);
      const nextAssignment = await createNextPracticeAssignment(id);
      setNextAssignment(nextAssignment);
      if (nextAssignment.id !== id) {
        navigate(`/student/practice/${nextAssignment.id}`);
      }
    } catch (nextError) {
      setError(
        formatErrorMessage(nextError, "Unable to prepare the next worksheet."),
      );
    } finally {
      setCreatingNextPractice(false);
    }
  };

  const handlePrepareWorksheet = async () => {
    if (!id || preparingWorksheet) return;

    try {
      setPreparingWorksheet(true);
      setError(null);
      await preparePracticeWorksheet(id);
      await loadWorksheet();
    } catch {
      const refreshedDetail = await getPracticeWorksheetDetail(id).catch(
        () => null,
      );
      if (refreshedDetail) {
        setDetail(refreshedDetail);
        replaceAnswers(buildAnswerMap(refreshedDetail.questions));
        if (!hasDurableWorksheetPreparationState(refreshedDetail.assignment)) {
          setError(SAFE_WORKSHEET_PREPARATION_ERROR);
        }
      } else {
        setError(SAFE_WORKSHEET_PREPARATION_ERROR);
      }
    } finally {
      setPreparingWorksheet(false);
    }
  };

  const handleRefreshWorksheetStatus = async () => {
    if (!id || preparingWorksheet) return;
    if (worksheetGenerationPoll.isRefreshing) {
      window.location.reload();
      return;
    }
    try {
      setPreparingWorksheet(true);
      setError(null);
      worksheetGenerationPoll.restartPolling();
      await worksheetGenerationPoll.refreshNow();
    } catch (refreshError) {
      setError(
        formatErrorMessage(
          refreshError,
          "Worksheet status could not be refreshed. You can safely return later.",
        ),
      );
    } finally {
      setPreparingWorksheet(false);
    }
  };

  const handleRefreshFeedbackStatus = async () => {
    if (!id || evaluatingFeedback) return;
    if (livePracticeAttempt.isRefreshing) {
      window.location.reload();
      return;
    }
    try {
      setEvaluatingFeedback(true);
      setError(null);
      livePracticeAttempt.restartPolling();
      await livePracticeAttempt.refreshNow();
    } catch (refreshError) {
      setError(
        formatErrorMessage(
          refreshError,
          "Feedback status could not be refreshed. Your submitted answers are still saved.",
        ),
      );
    } finally {
      setEvaluatingFeedback(false);
    }
  };

  const scoreLabel = assignment ? formatPracticeScore(assignment) : null;
  const isCompleted = assignment
    ? isCompletedAssignment(assignment.status)
    : false;
  const canShowSubmit = Boolean(
    assignment &&
    assignment.practice_test_id &&
    !isCompleted &&
    detail?.questions.length,
  );
  const canSubmit =
    canShowSubmit &&
    allQuestionsAnswered &&
    practiceDraftReadyRef.current &&
    draftState !== "conflict";
  const isPreparingDetailedFeedback = Boolean(
    assignment?.latest_attempt_id &&
    (evaluatingFeedback ||
      assignment?.evaluation_status === "pending" ||
      assignment?.evaluation_status === "queued" ||
      assignment?.evaluation_status === "evaluating"),
  );
  const detailedFeedbackFailed = Boolean(
    assignment?.latest_attempt_id && assignment?.evaluation_status === "failed",
  );
  const generationAutomaticRetryScheduled = hasScheduledAutomaticRetry(
    assignment?.generation_automatic_retry_at,
  );
  const generationRetryExhausted = Boolean(
    assignment?.generation_status === "failed" &&
    assignment.generation_retry_exhausted,
  );
  const evaluationAutomaticRetryScheduled = hasScheduledAutomaticRetry(
    assignment?.evaluation_automatic_retry_at,
  );

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl animate-in fade-in duration-500">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="mb-6 text-muted-foreground hover:text-foreground -ml-3"
      >
        <Link href="/student/practice">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Practice Center
        </Link>
      </Button>


      {loading ? (
        <Card>
          <CardContent
            className="py-10 text-center text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-3" />
            Loading worksheet...
          </CardContent>
        </Card>
      ) : !detail || !assignment ? (
        error ? (
          <Card className="border-destructive/30 bg-destructive/5" role="alert">
            <CardContent className="flex flex-col items-start gap-4 py-5 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void loadWorksheet()}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center text-muted-foreground">
              <h1 className="font-semibold text-foreground">
                Worksheet unavailable
              </h1>
              <p className="mt-2 text-sm">
                It may have been archived or reassigned. Return to Practice to
                choose an active worksheet.
              </p>
            </CardContent>
          </Card>
        )
      ) : (
        <>
          {error && (
            <Card
              className="border-destructive/30 bg-destructive/5"
              role="alert"
            >
              <CardContent className="py-4 text-sm text-destructive">
                {error}
              </CardContent>
            </Card>
          )}
          {!assignment.practice_test_id ? (
            <Card className="border-dashed bg-muted/20">
              <CardContent className="p-10 text-center">
                <ClipboardList className="h-10 w-10 text-primary mx-auto mb-4" />
                <h1 className="text-3xl font-serif mb-3">Practice unlocked</h1>
                <p
                  className="text-muted-foreground"
                  role="status"
                  aria-live="polite"
                  data-testid="worksheet-generation-status"
                  data-generation-status={assignment.generation_status}
                >
                  {assignment.generation_status === "needs_review"
                    ? "This worksheet is being held for quality review before it can be assigned."
                    : generationPending
                      ? generationAutomaticRetryScheduled
                        ? "Your worksheet is safely delayed and will retry automatically. You can leave this page and return later."
                        : worksheetGenerationPoll.pollingExpired
                          ? "This worksheet is taking longer than usual. Your place is safe; refresh the status now or return later."
                          : "Your worksheet is being prepared. You can leave this page and return without losing progress."
                      : assignment.generation_status === "failed"
                        ? generationRetryExhausted
                          ? RETRY_EXHAUSTED_COPY
                          : SAFE_WORKSHEET_PREPARATION_ERROR
                        : assignment.source === "adaptive_repeat"
                          ? "Prepare the next worksheet when you are ready."
                          : "Prepare your worksheet when you are ready."}
                </p>
                <Button
                  type="button"
                  className="mt-6"
                  disabled={
                    preparingWorksheet ||
                    assignment.generation_status === "needs_review" ||
                    generationRetryExhausted
                  }
                  aria-busy={preparingWorksheet}
                  onClick={() =>
                    void (generationPending
                      ? handleRefreshWorksheetStatus()
                      : handlePrepareWorksheet())
                  }
                >
                  {preparingWorksheet ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : generationPending ? (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  ) : (
                    <ClipboardList className="h-4 w-4 mr-2" />
                  )}
                  {preparingWorksheet
                    ? "Refreshing..."
                    : generationPending
                      ? "Refresh status"
                      : assignment.generation_status === "needs_review"
                        ? "Awaiting quality review"
                        : generationRetryExhausted
                          ? "Teacher review needed"
                          : assignment.generation_status === "failed"
                            ? "Retry preparation"
                            : assignment.source === "adaptive_repeat"
                              ? "Prepare next worksheet"
                              : "Prepare worksheet"}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-col gap-4 border-b border-border pb-6 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <Badge
                      variant="outline"
                      className={getPracticeAssignmentBadgeClass(assignment)}
                    >
                      {getPracticeAssignmentLabel(assignment)}
                    </Badge>
                    {assignment.worksheet_level && (
                      <Badge variant="outline">
                        {assignment.worksheet_level}
                      </Badge>
                    )}
                  </div>
                  <h1 className="text-4xl font-serif tracking-tight text-foreground">
                    {assignment.worksheet_title ?? "Practice Worksheet"}
                  </h1>
                  <p className="text-muted-foreground mt-2">
                    {assignment.grammar_topic_name} · {detail.questions.length}{" "}
                    questions
                  </p>
                </div>
                {scoreLabel && (
                  <div
                    className="rounded-lg border bg-card px-4 py-3 text-right"
                    data-testid="practice-score"
                  >
                    <p className="text-xs uppercase tracking-widest text-muted-foreground">
                      Score
                    </p>
                    <p className="text-2xl font-serif text-foreground">
                      {scoreLabel}
                    </p>
                  </div>
                )}
              </div>

              {!isCompleted && (
                <div
                  className={`flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${
                    draftState === "conflict" || draftState === "error"
                      ? "border-destructive/30 bg-destructive/5"
                      : "border-border bg-muted/20"
                  }`}
                  role={
                    draftState === "conflict" || draftState === "error"
                      ? "alert"
                      : "status"
                  }
                  aria-live="polite"
                  data-testid="practice-draft-status"
                >
                  <div>
                    <span className="font-medium text-foreground">
                      {draftState === "saving"
                        ? "Saving"
                        : draftState === "saved"
                          ? "Saved"
                          : draftState === "conflict"
                            ? "Conflict"
                            : draftState === "error"
                              ? "Error"
                              : "Autosave ready"}
                    </span>
                    {draftMessage && (
                      <span className="ml-2 text-muted-foreground">
                        {draftMessage}
                      </span>
                    )}
                    {draftRevision > 0 && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        Revision {draftRevision}
                      </span>
                    )}
                  </div>
                  {draftState === "conflict" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={submitting}
                      onClick={() => void handleReloadPracticeDraft()}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Reload saved answers
                    </Button>
                  ) : draftState === "error" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={submitting}
                      onClick={() => {
                        if (practiceDraftReadyRef.current) {
                          void handleRetryPracticeSave();
                        } else {
                          void loadWorksheet();
                        }
                      }}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      {practiceDraftReadyRef.current
                        ? "Retry save"
                        : "Reload saved answers"}
                    </Button>
                  ) : null}
                </div>
              )}

              {isCompleted && (
                <Card
                  className={
                    assignment.passed
                      ? "border-green-200 bg-green-50/50 dark:bg-green-950/20"
                      : "border-orange-200 bg-orange-50/50 dark:bg-orange-950/20"
                  }
                >
                  <CardContent className="p-5">
                    <div className="flex items-start gap-3">
                      {isPreparingDetailedFeedback ? (
                        <Loader2 className="h-5 w-5 text-blue-700 mt-0.5 animate-spin" />
                      ) : assignment.passed ? (
                        <CheckCircle2 className="h-5 w-5 text-green-700 mt-0.5" />
                      ) : (
                        <AlertCircle className="h-5 w-5 text-orange-700 mt-0.5" />
                      )}
                      <div>
                        <p className="font-medium text-foreground">
                          {getPracticeAssignmentLabel(assignment)}
                        </p>
                        <p
                          className="text-sm text-muted-foreground mt-1"
                          role="status"
                          aria-live="polite"
                        >
                          {isPreparingDetailedFeedback
                            ? evaluationAutomaticRetryScheduled
                              ? "Your answers are saved. Feedback is safely delayed and will retry automatically."
                              : "Preparing detailed feedback..."
                            : (scoreLabel ??
                              "Your answers were submitted for review.")}
                        </p>
                        {isPreparingDetailedFeedback && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mt-3"
                            disabled={evaluatingFeedback}
                            aria-busy={evaluatingFeedback}
                            onClick={() => void handleRefreshFeedbackStatus()}
                          >
                            {evaluatingFeedback ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-2 h-4 w-4" />
                            )}
                            Refresh feedback status
                          </Button>
                        )}
                        {detailedFeedbackFailed && (
                          <div className="mt-3">
                            <p className="text-sm text-muted-foreground">
                              Feedback could not be prepared after safe retries.
                              Your answers are saved; your teacher can retry the
                              evaluation.
                            </p>
                          </div>
                        )}
                        {assignment.status === "failed" &&
                          !isPreparingDetailedFeedback && (
                            <div className="mt-4">
                              {assignment.source === "adaptive_repeat" ? (
                                <p className="text-sm font-medium text-foreground">
                                  Please review this with your teacher.
                                </p>
                              ) : nextAssignment ? (
                                <div className="flex flex-wrap items-center gap-3">
                                  <p className="text-sm font-medium text-foreground">
                                    Next practice already created.
                                  </p>
                                  <Button asChild size="sm">
                                    <Link
                                      href={`/student/practice/${nextAssignment.id}`}
                                    >
                                      <ClipboardList className="mr-2 h-4 w-4" />
                                      Go to next worksheet
                                    </Link>
                                  </Button>
                                </div>
                              ) : (
                                <Button
                                  type="button"
                                  disabled={creatingNextPractice}
                                  onClick={() => void handlePracticeAgain()}
                                >
                                  {creatingNextPractice ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  ) : (
                                    <ClipboardList className="mr-2 h-4 w-4" />
                                  )}
                                  Practice again
                                </Button>
                              )}
                            </div>
                          )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {assignment.worksheet_mini_lesson && (
                <Card className="border-border shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base font-semibold text-muted-foreground">
                      Mini lesson
                    </CardTitle>
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
                    {assignment.worksheet_mini_lesson.correct_examples.length >
                      0 && (
                      <div>
                        <p className="font-medium text-foreground">Examples</p>
                        <div className="mt-2 grid gap-2">
                          {assignment.worksheet_mini_lesson.correct_examples.map(
                            (example) => (
                              <p
                                key={example}
                                className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-foreground"
                              >
                                {example}
                              </p>
                            ),
                          )}
                        </div>
                      </div>
                    )}
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-md border bg-muted/20 p-3">
                        <p className="font-medium text-foreground">Watch for</p>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                          {
                            assignment.worksheet_mini_lesson
                              .common_mistake_warning
                          }
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
                      <span className="text-sm font-medium text-foreground">
                        {progress}%
                      </span>
                    </div>
                    <Progress
                      value={progress}
                      className="h-2"
                      aria-label="Worksheet answer progress"
                      aria-valuetext={`${answeredCount} of ${detail.questions.length} questions answered`}
                    />
                  </CardContent>
                </Card>
              )}

              <div
                className="space-y-5"
                onBlurCapture={handlePracticeFieldBlur}
              >
                {detail.questions.map((question) => {
                  const promptId = `worksheet-question-${question.id}-prompt`;
                  return (
                    <Card key={question.id} className="border-border shadow-sm">
                      <CardHeader className="pb-3">
                        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base font-semibold text-muted-foreground">
                          <span>Question {question.question_number}</span>
                          {isCompleted &&
                            question.review_status &&
                            (() => {
                              const pointsLabel =
                                formatQuestionPoints(question);
                              return (
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge
                                    variant="outline"
                                    data-testid={`worksheet-review-status-${question.question_number}`}
                                    className={getReviewBadgeClass(
                                      question.review_status,
                                    )}
                                  >
                                    {getReviewLabel(question.review_status)}
                                  </Badge>
                                  {pointsLabel && (
                                    <Badge
                                      variant="outline"
                                      data-testid={`worksheet-review-points-${question.question_number}`}
                                      className="bg-card text-muted-foreground border-border"
                                    >
                                      {pointsLabel}
                                    </Badge>
                                  )}
                                </div>
                              );
                            })()}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <p
                          id={promptId}
                          className="text-lg leading-relaxed text-foreground"
                        >
                          <span className="sr-only">
                            Question {question.question_number}.{" "}
                          </span>
                          {question.prompt}
                        </p>
                        <QuestionAnswerControl
                          question={question}
                          value={answers[question.id] ?? ""}
                          labelledBy={promptId}
                          disabled={
                            isCompleted ||
                            submitting ||
                            !practiceDraftReadyRef.current
                          }
                          onChange={(value) =>
                            replaceAnswers({
                              ...answersRef.current,
                              [question.id]: value,
                            })
                          }
                        />
                        {isCompleted && (
                          <div className="space-y-3 border-t border-border pt-4">
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                Your answer
                              </p>
                              <p className="mt-1 rounded-md border bg-muted/20 px-3 py-2 text-sm text-foreground">
                                {(question.student_answer ?? "").trim() ||
                                  "No answer submitted."}
                              </p>
                            </div>
                            {question.correct_answer && (
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Correct answer
                                </p>
                                <p className="mt-1 rounded-md border bg-green-50/60 px-3 py-2 text-sm text-foreground dark:bg-green-950/20">
                                  {question.correct_answer}
                                </p>
                              </div>
                            )}
                            {question.explanation && (
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Explanation
                                </p>
                                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                                  {question.explanation}
                                </p>
                              </div>
                            )}
                            {question.review_status ===
                              "submitted_for_review" && (
                              <div className="rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/20 dark:text-blue-100">
                                Preparing detailed feedback...
                              </div>
                            )}
                            {question.feedback_text && (
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Feedback
                                </p>
                                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                                  {question.feedback_text}
                                </p>
                              </div>
                            )}
                            {question.corrected_answer && (
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Corrected answer
                                </p>
                                <p className="mt-1 rounded-md border bg-green-50/60 px-3 py-2 text-sm text-foreground dark:bg-green-950/20">
                                  {question.corrected_answer}
                                </p>
                              </div>
                            )}
                            {question.model_answer && (
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Sample answer
                                </p>
                                <p className="mt-1 rounded-md border bg-muted/20 px-3 py-2 text-sm text-foreground">
                                  {question.model_answer}
                                </p>
                              </div>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {canShowSubmit && (
                <div className="sticky bottom-4 z-10 flex flex-col items-end gap-2">
                  {!allQuestionsAnswered && (
                    <p className="rounded-md bg-card/95 px-3 py-2 text-sm text-muted-foreground shadow-sm">
                      Answer all questions before submitting.
                    </p>
                  )}
                  <Button
                    onClick={handleSubmit}
                    disabled={submitting || !canSubmit}
                    className="shadow-lg"
                  >
                    {submitting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4 mr-2" />
                    )}
                    {submitting ? "Saving and submitting…" : "Submit worksheet"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
