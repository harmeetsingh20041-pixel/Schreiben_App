import { useState, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PromptText } from "@/components/prompt-text";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  ArrowLeft,
  Trash2,
  CheckCircle2,
  PenTool,
  Save,
  RefreshCw,
} from "lucide-react";
import {
  getWritingDraft,
  getWritingDraftByContext,
  saveWritingDraft,
  submitWritingDraft,
  type CreatedWritingSubmission,
  type SavedWritingDraft,
  type SubmissionQuestionSource,
  type WritingDraft,
} from "@/services/submissionService";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { formatErrorMessage } from "@/lib/workspaceData";
import type { Question } from "@/types";
import { isPublicAppError, PublicAppError } from "@/lib/appError";
import { SerializedSaveQueue } from "@/services/serializedSaveQueue";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { useStudentClass } from "@/lib/studentClassContext";
import {
  constrainWritingInput,
  V1_WRITING_CHARACTER_LIMIT_MESSAGE,
  V1_WRITING_MAX_CHARACTERS,
  V1_WRITING_MAX_FEEDBACK_UNITS,
  writingUnicodeCharacterCount,
} from "@/lib/writingInputContract";

const GERMAN_SPECIAL_LETTERS = ["ä", "ö", "ü", "ß", "Ä", "Ö", "Ü"];
const WRITING_AUTOSAVE_DELAY_MS = 900;

export type DraftSaveState = "idle" | "saving" | "saved" | "conflict" | "error";

export function writingDraftStatusTitle(state: DraftSaveState, ready: boolean) {
  if (state === "conflict") return "Conflict";
  if (state === "error") return "Error";
  if (!ready) return "Preparing draft";
  if (state === "saving") return "Saving";
  if (state === "saved") return "Saved";
  return "Draft ready";
}

export interface WritingDraftContext {
  batchId: string;
  questionSource: SubmissionQuestionSource;
  questionSourceId: string | null;
}

export interface WritingDraftIdentity {
  id: string | null;
  revision: number;
  lastSavedText: string;
  batchId: string | null;
  questionSource: SubmissionQuestionSource | null;
  questionSourceId: string | null;
}

export function writingDraftContextMatches(
  identity: WritingDraftIdentity,
  context: WritingDraftContext,
) {
  return (
    identity.batchId === context.batchId &&
    identity.questionSource === context.questionSource &&
    identity.questionSourceId === context.questionSourceId
  );
}

export function writingDraftSnapshotIsCurrent(
  identity: WritingDraftIdentity,
  context: WritingDraftContext,
  text: string,
): identity is WritingDraftIdentity & { id: string } {
  return (
    identity.id !== null &&
    identity.revision > 0 &&
    identity.lastSavedText === text &&
    writingDraftContextMatches(identity, context)
  );
}

export function writingDraftShouldPersist(
  identity: WritingDraftIdentity,
  context: WritingDraftContext,
  text: string,
) {
  return (
    text.trim().length > 0 ||
    (identity.id !== null && writingDraftContextMatches(identity, context))
  );
}

export function writingDraftSaveVersion(
  identity: WritingDraftIdentity,
  context: WritingDraftContext,
) {
  return writingDraftContextMatches(identity, context)
    ? { draftId: identity.id, expectedRevision: identity.revision }
    : { draftId: null, expectedRevision: 0 };
}

export function writingDraftRestoreIsCurrent(
  expectedEpoch: number,
  currentEpoch: number,
  expectedBatchId: string,
  currentBatchId: string | null,
) {
  return expectedEpoch === currentEpoch && expectedBatchId === currentBatchId;
}

const EVALUATION_STATUS_LABELS: Record<
  CreatedWritingSubmission["evaluation_status"],
  string
> = {
  queued: "Queued",
  processing: "Processing",
  ready: "Prepared",
  needs_review: "Needs teacher review",
  failed: "Evaluation failed",
};

const RELEASE_STATUS_LABELS: Record<
  CreatedWritingSubmission["release_status"],
  string
> = {
  held: "Held safely",
  scheduled: "Scheduled",
  released: "Released",
};

export function describeSubmittedWriting(submission: CreatedWritingSubmission) {
  const evaluationLabel =
    EVALUATION_STATUS_LABELS[submission.evaluation_status];
  const releaseLabel = RELEASE_STATUS_LABELS[submission.release_status];

  if (submission.evaluation_status === "failed") {
    return {
      evaluationLabel,
      releaseLabel,
      message:
        "Your writing is safely stored, but feedback could not be prepared. Your teacher can retry it.",
    };
  }

  if (submission.evaluation_status === "needs_review") {
    return {
      evaluationLabel,
      releaseLabel,
      message:
        "Your writing is safely stored. Feedback needs teacher review before it can be released.",
    };
  }

  if (submission.evaluation_status === "ready") {
    if (submission.release_status === "released") {
      return {
        evaluationLabel,
        releaseLabel,
        message: "Your feedback has been prepared, validated, and released.",
      };
    }
    if (submission.release_status === "scheduled") {
      return {
        evaluationLabel,
        releaseLabel,
        message:
          "Your feedback has been prepared and will appear at the scheduled release time.",
      };
    }
    return {
      evaluationLabel,
      releaseLabel,
      message:
        "Your feedback has been prepared and is being held until review and release are complete.",
    };
  }

  if (submission.evaluation_status === "processing") {
    return {
      evaluationLabel,
      releaseLabel,
      message:
        submission.release_status === "scheduled"
          ? "Feedback is being prepared now and will appear at the scheduled release time."
          : "Feedback is being prepared now. It will remain private until validation and release are complete.",
    };
  }

  return {
    evaluationLabel,
    releaseLabel,
    message:
      submission.release_status === "scheduled"
        ? "Your writing is safely queued. Feedback will appear at the scheduled release time, and temporary service delays are retried automatically."
        : "Your writing is safely queued. Feedback stays private while it is checked, and temporary service delays are retried automatically.",
  };
}

function formatReleaseAt(value: string) {
  const releaseAt = new Date(value);
  if (Number.isNaN(releaseAt.getTime())) return null;
  return releaseAt.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function StudentWrite() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(useSearch());
  const qId = searchParams.get("q");
  const isFree = searchParams.get("mode") === "free";
  const requestedBatchId = searchParams.get("batch");
  const requestedDraftId = searchParams.get("draft");
  const {
    activeBatchId,
    assignments: batchAssignments,
    error: assignmentsError,
    isLoading: loadingBatches,
    selectActiveBatch,
  } = useStudentClass();
  const storedQuestion = (() => {
    if (!qId) return null;
    try {
      const raw = sessionStorage.getItem("gwc_selected_question");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Question;
      return parsed.id === qId ? parsed : null;
    } catch {
      return null;
    }
  })();
  const question = storedQuestion;

  const [text, setText] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [checkStage, setCheckStage] = useState(0);
  const [submittedSubmission, setSubmittedSubmission] =
    useState<CreatedWritingSubmission | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(
    question?.batch_id ?? requestedBatchId ?? activeBatchId,
  );
  const [draftReady, setDraftReady] = useState(false);
  const [draftState, setDraftState] = useState<DraftSaveState>("idle");
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const textRef = useRef(text);
  const draftIdentityRef = useRef<WritingDraftIdentity>({
    id: null as string | null,
    revision: 0,
    lastSavedText: "",
    batchId: null,
    questionSource: null,
    questionSourceId: null,
  });
  const draftSaveQueueRef = useRef(new SerializedSaveQueue());
  const writingAutosaveTimerRef = useRef<number | null>(null);
  const draftConflictRef = useRef(false);
  const loadedDraftRouteRef = useRef<string | null>(null);
  const checkedDraftContextRef = useRef<string | null>(null);
  const lastObservedActiveBatchIdRef = useRef<string | null>(activeBatchId);
  const selectedBatchIdRef = useRef<string | null>(selectedBatchId);
  const writingContextEpochRef = useRef(0);
  const hasReconciledWritingBatchRef = useRef(false);

  const wordCount = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  const expectedWordRange = question?.expected_word_range?.trim() ?? "";
  const hasFixedWordGuidance =
    expectedWordRange.length > 0 &&
    expectedWordRange.toLowerCase() !== "flexible";
  const parsedExpectedWordMinimum = Number.parseInt(
    expectedWordRange.split("-")[0] ?? "",
    10,
  );
  const expectedWordMinimum =
    hasFixedWordGuidance && Number.isFinite(parsedExpectedWordMinimum)
      ? parsedExpectedWordMinimum
      : null;
  const writingCharacterCount = writingUnicodeCharacterCount(text);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const eligibleBatchAssignments = useMemo(
    () =>
      batchAssignments.filter((assignment) => {
        if (isFree) return true;
        if (question?.batch_id && assignment.batch_id !== question.batch_id)
          return false;
        if (question?.level && assignment.level !== question.level)
          return false;
        if (
          question?.source === "workspace" &&
          question.workspace_id &&
          assignment.workspace_id !== question.workspace_id
        ) {
          return false;
        }
        return true;
      }),
    [
      batchAssignments,
      isFree,
      question?.batch_id,
      question?.level,
      question?.source,
      question?.workspace_id,
    ],
  );
  const questionSource: SubmissionQuestionSource = isFree
    ? "free_text"
    : question?.source === "global"
      ? "global_question"
      : "workspace_question";
  const questionSourceId = isFree ? null : (question?.id ?? qId);
  const questionSourceRef = useRef(questionSource);
  const questionSourceIdRef = useRef<string | null>(questionSourceId);
  questionSourceRef.current = questionSource;
  questionSourceIdRef.current = questionSourceId;

  const rememberDraftIdentity = (
    nextId: string,
    nextRevision: number,
    lastSavedText: string,
    context: WritingDraftContext,
  ) => {
    draftIdentityRef.current = {
      id: nextId,
      revision: nextRevision,
      lastSavedText,
      ...context,
    };
    setDraftId(nextId);
    setDraftRevision(nextRevision);
  };

  const replaceDraftQuery = (nextDraftId: string) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("draft", nextDraftId);
    window.history.replaceState(
      window.history.state,
      "",
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    );
  };

  const removeDraftQuery = () => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("draft");
    window.history.replaceState(
      window.history.state,
      "",
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    );
  };

  const applyWritingBatch = (batchId: string) => {
    selectedBatchIdRef.current = batchId;
    setSelectedBatchId(batchId);
    selectActiveBatch(batchId);
  };

  const invalidateWritingBatchContext = (
    nextBatchId: string | null,
    preservePendingDraftRoute = false,
  ) => {
    writingContextEpochRef.current += 1;
    checkedDraftContextRef.current = null;
    if (!preservePendingDraftRoute) {
      loadedDraftRouteRef.current = null;
      removeDraftQuery();
    }
    draftConflictRef.current = false;

    // Keep the ref itself until serialized old-context saves have drained.
    // writingDraftSaveVersion already refuses to reuse it for nextBatchId.
    if (draftIdentityRef.current.batchId !== nextBatchId) {
      setDraftId(null);
      setDraftRevision(0);
    }
    setDraftReady(false);
    setDraftState("idle");
    setDraftMessage(
      textRef.current.length > 0
        ? "Class changed. Your text will be saved as a separate draft."
        : null,
    );
  };

  const selectWritingBatch = (batchId: string) => {
    if (selectedBatchIdRef.current === batchId) {
      selectActiveBatch(batchId);
      return;
    }

    // A class change is an explicit context boundary. Invalidate any older
    // asynchronous draft lookup before React has time to run its cleanup, and
    // never let a stale ?draft route pull the selector back to the old class.
    invalidateWritingBatchContext(batchId);
    applyWritingBatch(batchId);
  };

  const restoreWritingDraft = (draft: WritingDraft) => {
    rememberDraftIdentity(draft.draft_id, draft.revision, draft.text, {
      batchId: draft.batch_id,
      questionSource: draft.source_type,
      questionSourceId: draft.source_id,
    });
    draftConflictRef.current = false;
    applyWritingBatch(draft.batch_id);
    setText(draft.text);
    setDraftState("saved");
    setDraftMessage("Saved draft restored.");
    loadedDraftRouteRef.current = draft.draft_id;
    replaceDraftQuery(draft.draft_id);
  };

  const enqueueWritingSave = (snapshot: string): Promise<SavedWritingDraft> => {
    const batchId = selectedBatchId;
    if (!batchId || (!isFree && !questionSourceId)) {
      return Promise.reject(
        new PublicAppError(
          "data_invalid_request",
          "Select an active class and writing task before saving this draft.",
        ),
      );
    }
    if (draftConflictRef.current) {
      return Promise.reject(
        new PublicAppError(
          "data_conflict",
          "This draft changed elsewhere. Reload the saved version before continuing.",
        ),
      );
    }

    setDraftState("saving");
    setDraftMessage("Saving exact text…");
    const saveContext: WritingDraftContext = {
      batchId,
      questionSource,
      questionSourceId,
    };
    const saveEpoch = writingContextEpochRef.current;
    const saveIsCurrent = () =>
      writingDraftRestoreIsCurrent(
        saveEpoch,
        writingContextEpochRef.current,
        saveContext.batchId,
        selectedBatchIdRef.current,
      ) &&
      saveContext.questionSource === questionSourceRef.current &&
      saveContext.questionSourceId === questionSourceIdRef.current;
    const operation = draftSaveQueueRef.current
      .enqueue(async () => {
        const identity = draftIdentityRef.current;
        const saveVersion = writingDraftSaveVersion(identity, saveContext);
        const saved = await saveWritingDraft({
          // A draft is immutable with respect to its class/task identity from
          // the browser's point of view. Switching context creates or resumes
          // that context's own draft instead of silently moving another one.
          draftId: saveVersion.draftId,
          expectedRevision: saveVersion.expectedRevision,
          questionSource,
          questionId: questionSourceId,
          batchId,
          answerText: snapshot,
        });
        if (saveIsCurrent()) {
          rememberDraftIdentity(
            saved.draft_id,
            saved.revision,
            snapshot,
            saveContext,
          );
          loadedDraftRouteRef.current = saved.draft_id;
          replaceDraftQuery(saved.draft_id);
          if (textRef.current === snapshot) {
            setDraftState("saved");
            setDraftMessage("All changes saved.");
          } else {
            setDraftState("saving");
            setDraftMessage("Saving newer changes…");
          }
        }
        return saved;
      })
      .catch((error: unknown) => {
        if (saveIsCurrent()) {
          if (isPublicAppError(error) && error.code === "data_conflict") {
            draftConflictRef.current = true;
            setDraftState("conflict");
            setDraftMessage(
              "This draft changed elsewhere. Your current text was not overwritten.",
            );
          } else {
            setDraftState("error");
            setDraftMessage(
              formatErrorMessage(
                error,
                "Draft could not be saved. Your text remains on this screen.",
              ),
            );
          }
        }
        throw error;
      });

    return operation;
  };

  useEffect(() => {
    if (loadingBatches) return;

    const isInitialReconciliation = !hasReconciledWritingBatchRef.current;
    hasReconciledWritingBatchRef.current = true;

    const questionBatchId =
      question?.batch_id &&
      eligibleBatchAssignments.some(
        (assignment) => assignment.batch_id === question.batch_id,
      )
        ? question.batch_id
        : null;
    const activeIsEligible =
      activeBatchId &&
      eligibleBatchAssignments.some(
        (assignment) => assignment.batch_id === activeBatchId,
      )
        ? activeBatchId
        : null;
    const currentIsEligible =
      selectedBatchId &&
      eligibleBatchAssignments.some(
        (assignment) => assignment.batch_id === selectedBatchId,
      )
        ? selectedBatchId
        : null;
    const activeChanged =
      lastObservedActiveBatchIdRef.current !== activeBatchId;
    lastObservedActiveBatchIdRef.current = activeBatchId;
    const nextBatchId =
      questionBatchId ??
      (activeChanged ? activeIsEligible : null) ??
      currentIsEligible ??
      activeIsEligible ??
      (eligibleBatchAssignments.length === 1
        ? eligibleBatchAssignments[0].batch_id
        : null);

    if (nextBatchId !== selectedBatchId) {
      invalidateWritingBatchContext(
        nextBatchId,
        isInitialReconciliation && Boolean(requestedDraftId),
      );
      selectedBatchIdRef.current = nextBatchId;
      setSelectedBatchId(nextBatchId);
    }
    if (nextBatchId && nextBatchId !== activeBatchId) {
      selectActiveBatch(nextBatchId);
    }
  }, [
    activeBatchId,
    eligibleBatchAssignments,
    loadingBatches,
    question?.batch_id,
    requestedDraftId,
    selectActiveBatch,
    selectedBatchId,
  ]);

  useEffect(() => {
    if (!assignmentsError) return;
    setSubmitError(
      formatErrorMessage(
        assignmentsError,
        "Could not load your active classes.",
      ),
    );
  }, [assignmentsError]);

  useEffect(() => {
    if (!requestedDraftId) return;
    if (loadingBatches || loadedDraftRouteRef.current === requestedDraftId)
      return;

    let cancelled = false;
    const restoreEpoch = writingContextEpochRef.current;
    const restoreQuestionSource = questionSource;
    const restoreQuestionSourceId = questionSourceId;
    const restoreIsCurrent = () =>
      !cancelled &&
      restoreEpoch === writingContextEpochRef.current &&
      restoreQuestionSource === questionSourceRef.current &&
      restoreQuestionSourceId === questionSourceIdRef.current;
    setDraftReady(false);
    setDraftState("idle");
    setDraftMessage("Restoring saved draft…");
    void getWritingDraft(requestedDraftId)
      .then((draft) => {
        if (!restoreIsCurrent()) return;
        if (!draft) {
          throw new PublicAppError(
            "data_not_found",
            "This saved draft is no longer available.",
          );
        }
        const batchIsAvailable = eligibleBatchAssignments.some(
          (assignment) => assignment.batch_id === draft.batch_id,
        );
        if (
          !batchIsAvailable ||
          draft.source_type !== questionSource ||
          draft.source_id !== questionSourceId
        ) {
          throw new PublicAppError(
            "data_permission_denied",
            "This draft does not belong to this active writing task.",
          );
        }
        setDraftReady(true);
        restoreWritingDraft(draft);
        loadedDraftRouteRef.current = requestedDraftId;
      })
      .catch((error: unknown) => {
        if (!restoreIsCurrent()) return;
        setDraftReady(false);
        setDraftState("error");
        setDraftMessage(
          formatErrorMessage(error, "Saved draft could not be restored."),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    eligibleBatchAssignments,
    loadingBatches,
    questionSource,
    questionSourceId,
    requestedDraftId,
  ]);

  useEffect(() => {
    if (requestedDraftId || loadingBatches) return;
    if (!selectedBatchId) {
      setDraftReady(false);
      return;
    }
    const assignment = eligibleBatchAssignments.find(
      (candidate) => candidate.batch_id === selectedBatchId,
    );
    if (!assignment) {
      setDraftReady(false);
      return;
    }

    const contextKey = [
      selectedBatchId,
      questionSource,
      questionSourceId ?? "free",
    ].join(":");
    if (checkedDraftContextRef.current === contextKey) return;
    checkedDraftContextRef.current = contextKey;

    // Automatic restoration is only for an untouched task entry. If the
    // student deliberately switches class with text already present, the
    // context-safe save path creates that class's own draft instead.
    if (draftIdentityRef.current.id || textRef.current.length > 0) {
      setDraftReady(true);
      return;
    }

    let cancelled = false;
    let settled = false;
    const restoreEpoch = writingContextEpochRef.current;
    const restoreBatchId = selectedBatchId;
    const restoreIsCurrent = () =>
      !cancelled &&
      writingDraftRestoreIsCurrent(
        restoreEpoch,
        writingContextEpochRef.current,
        restoreBatchId,
        selectedBatchIdRef.current,
      ) &&
      questionSource === questionSourceRef.current &&
      questionSourceId === questionSourceIdRef.current;
    setDraftReady(false);
    setDraftState("idle");
    setDraftMessage("Checking for a saved draft…");
    void draftSaveQueueRef.current
      .whenIdle()
      .then(() =>
        restoreIsCurrent()
          ? getWritingDraftByContext(
              assignment.workspace_id,
              restoreBatchId,
              questionSource,
              questionSourceId,
            )
          : null,
      )
      .then((draft) => {
        if (!restoreIsCurrent()) return;
        settled = true;
        if (draft) {
          if (
            draft.batch_id !== restoreBatchId ||
            draft.source_type !== questionSource ||
            draft.source_id !== questionSourceId
          ) {
            throw new PublicAppError(
              "data_permission_denied",
              "The saved draft does not belong to this writing context.",
            );
          }
          setDraftReady(true);
          restoreWritingDraft(draft);
        } else {
          setDraftReady(true);
          setDraftState("idle");
          setDraftMessage(null);
        }
      })
      .catch((error: unknown) => {
        if (!restoreIsCurrent()) return;
        settled = true;
        setDraftReady(false);
        setDraftState("error");
        setDraftMessage(
          formatErrorMessage(
            error,
            "Saved drafts could not be checked. Reload before writing to avoid a conflict.",
          ),
        );
      });

    return () => {
      cancelled = true;
      if (!settled && checkedDraftContextRef.current === contextKey) {
        checkedDraftContextRef.current = null;
      }
    };
  }, [
    eligibleBatchAssignments,
    loadingBatches,
    questionSource,
    questionSourceId,
    requestedDraftId,
    selectedBatchId,
  ]);

  useEffect(() => {
    if (!selectedBatchId) return;
    const draftContext: WritingDraftContext = {
      batchId: selectedBatchId,
      questionSource,
      questionSourceId,
    };
    if (
      !draftReady ||
      isChecking ||
      draftConflictRef.current ||
      !writingDraftShouldPersist(
        draftIdentityRef.current,
        draftContext,
        text,
      ) ||
      writingDraftSnapshotIsCurrent(
        draftIdentityRef.current,
        draftContext,
        text,
      )
    )
      return;

    setDraftState("saving");
    setDraftMessage("Changes waiting to save…");
    if (writingAutosaveTimerRef.current !== null) {
      window.clearTimeout(writingAutosaveTimerRef.current);
    }
    const timeoutId = window.setTimeout(() => {
      writingAutosaveTimerRef.current = null;
      void enqueueWritingSave(text).catch(() => {
        // The queue maps failures to a visible, safe draft state.
      });
    }, WRITING_AUTOSAVE_DELAY_MS);
    writingAutosaveTimerRef.current = timeoutId;
    return () => {
      window.clearTimeout(timeoutId);
      if (writingAutosaveTimerRef.current === timeoutId)
        writingAutosaveTimerRef.current = null;
    };
  }, [
    draftReady,
    isChecking,
    questionSource,
    questionSourceId,
    selectedBatchId,
    text,
  ]);

  useEffect(() => {
    const hasUnsavedWriting = () => {
      if (!selectedBatchId) return false;
      const draftContext: WritingDraftContext = {
        batchId: selectedBatchId,
        questionSource,
        questionSourceId,
      };
      return Boolean(
        draftReady &&
        !isChecking &&
        !draftConflictRef.current &&
        writingDraftShouldPersist(
          draftIdentityRef.current,
          draftContext,
          textRef.current,
        ) &&
        !writingDraftSnapshotIsCurrent(
          draftIdentityRef.current,
          draftContext,
          textRef.current,
        ),
      );
    };
    const flushUnsavedWriting = () => {
      if (!hasUnsavedWriting()) return;
      if (writingAutosaveTimerRef.current !== null) {
        window.clearTimeout(writingAutosaveTimerRef.current);
        writingAutosaveTimerRef.current = null;
      }
      void enqueueWritingSave(textRef.current).catch(() => {
        // beforeunload keeps the user on the page when persistence is not yet confirmed.
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushUnsavedWriting();
    };
    const handlePageHide = () => flushUnsavedWriting();
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWriting()) return;
      flushUnsavedWriting();
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
  }, [
    draftReady,
    isChecking,
    questionSource,
    questionSourceId,
    selectedBatchId,
  ]);

  const stages = [
    "Saving your writing securely...",
    "Confirming queue status...",
  ];

  useEffect(() => {
    if (!isChecking) {
      return;
    }

    const interval = setInterval(() => {
      setCheckStage((prev) => {
        if (prev < stages.length - 1) return prev + 1;
        clearInterval(interval);
        return prev;
      });
    }, 600);
    return () => clearInterval(interval);
  }, [isChecking, stages.length]);

  const submitRealWriting = async () => {
    if (!text.trim()) return;
    setSubmitError(null);
    if (!selectedBatchId) {
      const message = "Select the class that should receive this writing.";
      setSubmitError(message);
      toast({ title: "Class required", description: message });
      return;
    }
    setIsChecking(true);
    setCheckStage(0);

    try {
      await draftSaveQueueRef.current.whenIdle();
      let snapshot = textRef.current;
      let finalIdentity = draftIdentityRef.current;
      const submissionContext: WritingDraftContext = {
        batchId: selectedBatchId,
        questionSource,
        questionSourceId,
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (
          !writingDraftSnapshotIsCurrent(
            finalIdentity,
            submissionContext,
            snapshot,
          )
        ) {
          await enqueueWritingSave(snapshot);
          finalIdentity = draftIdentityRef.current;
        }
        if (textRef.current === snapshot) break;
        snapshot = textRef.current;
      }
      finalIdentity = draftIdentityRef.current;
      if (
        !writingDraftSnapshotIsCurrent(
          finalIdentity,
          submissionContext,
          textRef.current,
        )
      ) {
        throw new PublicAppError(
          "data_conflict",
          "Your latest changes could not be locked for submission. Review the draft status and try again.",
        );
      }

      const nextSubmission = await submitWritingDraft(
        finalIdentity.id,
        finalIdentity.revision,
      );
      const submittedWorkspaceId = batchAssignments.find(
        (assignment) => assignment.batch_id === finalIdentity.batchId,
      )?.workspace_id;
      if (user && submittedWorkspaceId) {
        await queryClient.invalidateQueries({
          queryKey: appQueryKeys.studentSubmissions(
            submittedWorkspaceId,
            user.id,
          ),
        });
      }
      draftIdentityRef.current = {
        id: null,
        revision: 0,
        lastSavedText: "",
        batchId: null,
        questionSource: null,
        questionSourceId: null,
      };
      draftConflictRef.current = false;
      loadedDraftRouteRef.current = null;
      setDraftId(null);
      setDraftRevision(0);
      setDraftState("idle");
      setDraftMessage(null);
      removeDraftQuery();
      setSubmittedSubmission(nextSubmission);
    } catch (error) {
      const message = formatErrorMessage(error, "Could not save your writing.");
      setSubmitError(message);
      toast({ title: "Submission failed", description: message });
    } finally {
      setIsChecking(false);
    }
  };

  const handleSaveDraft = async () => {
    if (
      (!text.trim() && !draftIdentityRef.current.id) ||
      !selectedBatchId ||
      isChecking
    )
      return;
    try {
      setSubmitError(null);
      await enqueueWritingSave(textRef.current);
      toast({
        title: "Draft saved",
        description:
          "Your exact text will be restored if you refresh this page.",
      });
    } catch (error) {
      const message = formatErrorMessage(error, "Draft could not be saved.");
      setSubmitError(message);
      toast({ title: "Draft not saved", description: message });
    }
  };

  const handleWritingBlur = () => {
    const draftContext: WritingDraftContext | null = selectedBatchId
      ? { batchId: selectedBatchId, questionSource, questionSourceId }
      : null;
    if (
      !draftReady ||
      !draftContext ||
      isChecking ||
      draftConflictRef.current ||
      !writingDraftShouldPersist(
        draftIdentityRef.current,
        draftContext,
        textRef.current,
      ) ||
      writingDraftSnapshotIsCurrent(
        draftIdentityRef.current,
        draftContext,
        textRef.current,
      )
    )
      return;
    if (writingAutosaveTimerRef.current !== null) {
      window.clearTimeout(writingAutosaveTimerRef.current);
      writingAutosaveTimerRef.current = null;
    }
    void enqueueWritingSave(textRef.current).catch(() => {
      // The visible draft state provides recovery without overwriting local text.
    });
  };

  const handleReloadDraft = async () => {
    if (!selectedBatchId) return;
    try {
      setDraftState("saving");
      setDraftMessage("Loading the saved version…");
      const currentId = draftIdentityRef.current.id ?? requestedDraftId;
      let savedDraft = currentId ? await getWritingDraft(currentId) : null;

      if (!savedDraft) {
        const assignment = eligibleBatchAssignments.find(
          (candidate) => candidate.batch_id === selectedBatchId,
        );
        if (assignment) {
          savedDraft = await getWritingDraftByContext(
            assignment.workspace_id,
            selectedBatchId,
            questionSource,
            questionSourceId,
          );
        }
      }

      if (!savedDraft) {
        throw new PublicAppError(
          "data_not_found",
          "No saved version is available for this writing task.",
        );
      }
      restoreWritingDraft(savedDraft);
      setSubmitError(null);
    } catch (error) {
      const message = formatErrorMessage(
        error,
        "Saved draft could not be reloaded.",
      );
      setDraftState("error");
      setDraftMessage(message);
      setSubmitError(message);
    }
  };

  const handleCheck = async () => {
    if (!text.trim()) return;
    if (writingCharacterCount > V1_WRITING_MAX_CHARACTERS) {
      setSubmitError(V1_WRITING_CHARACTER_LIMIT_MESSAGE);
      toast({
        title: "Writing is too long",
        description: V1_WRITING_CHARACTER_LIMIT_MESSAGE,
      });
      return;
    }
    await submitRealWriting();
  };

  const handleWritingChange = (nextValue: string) => {
    const constrained = constrainWritingInput(text, nextValue);
    setText(constrained.value);
    if (constrained.wasLimited) {
      setSubmitError(V1_WRITING_CHARACTER_LIMIT_MESSAGE);
    } else if (
      submitError === V1_WRITING_CHARACTER_LIMIT_MESSAGE &&
      writingUnicodeCharacterCount(constrained.value) <
        V1_WRITING_MAX_CHARACTERS
    ) {
      setSubmitError(null);
    }
  };

  const rememberSelection = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    selectionRef.current = {
      start: textarea.selectionStart ?? text.length,
      end: textarea.selectionEnd ?? text.length,
    };
  };

  const insertSpecialLetter = (letter: string) => {
    const textarea = textareaRef.current;
    if (!textarea || isChecking) return;

    const savedSelection = selectionRef.current;
    const start = Math.min(
      savedSelection?.start ?? textarea.selectionStart ?? text.length,
      text.length,
    );
    const end = Math.min(
      savedSelection?.end ?? textarea.selectionEnd ?? text.length,
      text.length,
    );
    const requestedText = `${text.slice(0, start)}${letter}${text.slice(end)}`;
    const constrained = constrainWritingInput(text, requestedText);
    const nextText = constrained.value;
    const nextCursor =
      constrained.wasLimited && nextText === text
        ? start
        : Math.min(start + letter.length, nextText.length);

    setText(nextText);
    if (constrained.wasLimited) {
      setSubmitError(V1_WRITING_CHARACTER_LIMIT_MESSAGE);
    }
    selectionRef.current = { start: nextCursor, end: nextCursor };
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  };

  if (!isFree && !question) {
    return (
      <div className="container mx-auto max-w-xl px-4 py-12 text-center">
        <Card className="border-dashed bg-muted/20">
          <CardContent className="p-8">
            <h1 className="text-xl font-semibold">Writing task unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This task may have been archived or removed. Choose another active
              task to continue.
            </p>
            <Button
              className="mt-5"
              onClick={() => setLocation("/student/questions")}
            >
              Choose a writing task
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const submittedProgress = submittedSubmission
    ? describeSubmittedWriting(submittedSubmission)
    : null;
  const formattedReleaseAt = submittedSubmission?.release_at
    ? formatReleaseAt(submittedSubmission.release_at)
    : null;

  if (submittedSubmission && submittedProgress) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-4xl animate-in fade-in duration-300">
        <Button
          variant="ghost"
          size="sm"
          className="mb-6 text-muted-foreground hover:text-foreground -ml-3"
          onClick={() => setLocation("/student/questions")}
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Writing
        </Button>
        <Card className="border-primary/25 bg-primary/5">
          <CardContent className="p-10 text-center">
            <div className="w-14 h-14 rounded-xl bg-primary/15 text-primary flex items-center justify-center mx-auto mb-5">
              <CheckCircle2 className="w-7 h-7" />
            </div>
            <h1 className="text-2xl font-serif mb-2">
              Writing submitted safely.
            </h1>
            <p
              className="text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {submittedProgress.message}
            </p>
            <div
              className="mt-5 flex flex-wrap justify-center gap-2"
              role="group"
              aria-label="Submission progress"
            >
              <Badge variant="outline">
                Evaluation: {submittedProgress.evaluationLabel}
              </Badge>
              <Badge variant="outline">
                Release: {submittedProgress.releaseLabel}
              </Badge>
            </div>
            {formattedReleaseAt &&
              submittedSubmission.release_status === "scheduled" && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Expected release:{" "}
                  <time dateTime={submittedSubmission.release_at ?? undefined}>
                    {formattedReleaseAt}
                  </time>
                </p>
              )}
            <div className="mt-6 flex flex-col sm:flex-row justify-center gap-3">
              <Button
                onClick={() =>
                  setLocation(
                    `/student/submission/${submittedSubmission.submission_id}`,
                  )
                }
              >
                {submittedSubmission.evaluation_status === "ready" &&
                submittedSubmission.release_status === "released"
                  ? "View Feedback"
                  : "View Submission"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setSubmittedSubmission(null);
                  setText("");
                  setLocation(
                    isFree
                      ? "/student/write?mode=free"
                      : `/student/write?q=${questionSourceId ?? ""}`,
                  );
                }}
              >
                Back to Writing
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl animate-in fade-in duration-300 flex flex-col h-full min-h-[calc(100dvh-4rem)]">
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 text-muted-foreground hover:text-foreground"
          onClick={() => setLocation("/student/questions")}
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Writing Tasks
        </Button>

        {isFree ? (
          <div>
            <h1 className="text-2xl font-bold">Free Writing</h1>
            <p className="text-muted-foreground mt-1">
              Write anything you want. Keep it simple and natural.
            </p>
          </div>
        ) : (
          <Card className="p-6 bg-primary/5 border-primary/20 shadow-none">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <span className="px-2 py-1 text-xs font-medium bg-primary text-primary-foreground rounded">
                {question?.level}
              </span>
              <span className="text-sm font-medium text-primary">
                Topic: {question?.topic}
              </span>
            </div>
            <h1 className="text-xl font-bold mb-3">{question?.title}</h1>
            <PromptText
              prompt={question?.prompt}
              className="text-foreground text-base"
            />
            <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span>
                Suggested length:{" "}
                <strong>
                  {hasFixedWordGuidance
                    ? `${expectedWordRange} words`
                    : "No fixed word limit"}
                </strong>
              </span>
              <span>
                Time: <strong>~{question?.estimated_time}</strong>
              </span>
            </div>
          </Card>
        )}
      </div>

      <Card className="mb-5 border-border/80 shadow-none">
        <CardContent className="p-4">
          <label
            className="mb-2 block text-sm font-medium"
            htmlFor="writing-batch-context"
          >
            Class receiving this writing
          </label>
          <Select
            value={selectedBatchId ?? undefined}
            onValueChange={selectWritingBatch}
            disabled={
              loadingBatches ||
              isChecking ||
              draftState === "saving" ||
              eligibleBatchAssignments.length === 0
            }
          >
            <SelectTrigger
              id="writing-batch-context"
              className="w-full bg-background"
            >
              <SelectValue
                placeholder={
                  loadingBatches
                    ? "Loading active classes..."
                    : "Select a class"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {eligibleBatchAssignments.map((assignment) => (
                <SelectItem key={assignment.id} value={assignment.batch_id}>
                  {assignment.batch_name} · {assignment.level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!loadingBatches && eligibleBatchAssignments.length === 0 && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              Join an active class that matches this task before submitting
              writing.
            </p>
          )}
        </CardContent>
      </Card>

      <div
        className={`mb-4 flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${
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
        data-testid="writing-draft-status"
      >
        <div>
          <span className="font-medium text-foreground">
            {writingDraftStatusTitle(draftState, draftReady)}
          </span>
          {draftMessage && (
            <span className="ml-2 text-muted-foreground">{draftMessage}</span>
          )}
          {draftId && draftRevision > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">
              Revision {draftRevision}
            </span>
          )}
        </div>
        {(draftState === "conflict" || draftState === "error") &&
          (draftId || selectedBatchId) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleReloadDraft()}
              disabled={isChecking}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Reload saved draft
            </Button>
          )}
      </div>

      <div className="flex-1 flex flex-col relative">
        {isChecking ? (
          <div
            className="absolute inset-0 z-10 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center rounded-xl border border-border animate-in fade-in"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mb-6 shadow-inner">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
            <h3 className="text-xl font-bold mb-2">Submitting your writing</h3>
            <div className="h-6 overflow-hidden relative w-64 text-center">
              <div
                className="text-sm font-medium text-muted-foreground transition-all duration-300"
                key={checkStage}
              >
                {stages[checkStage]}
              </div>
            </div>
            <div
              className="w-64 max-w-[calc(100%-2rem)] bg-secondary h-2 rounded-full mt-6 overflow-hidden"
              role="progressbar"
              aria-label="Writing submission progress"
              aria-valuemin={0}
              aria-valuemax={stages.length}
              aria-valuenow={checkStage + 1}
            >
              <div
                className="bg-primary h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${Math.max(5, (checkStage / (stages.length - 1)) * 100)}%`,
                }}
              />
            </div>
          </div>
        ) : null}

        <div className="bg-card border border-border rounded-xl shadow-sm flex flex-col flex-1 overflow-hidden focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/50 transition-all">
          <div className="bg-muted px-4 py-2 border-b border-border flex flex-col items-start gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <label
              htmlFor="student-writing-text"
              className="font-medium text-foreground flex items-center gap-2"
            >
              <PenTool className="w-4 h-4" /> Your Text
            </label>
            <span className="bg-background px-2 py-1 rounded border shadow-sm">
              Simple German is okay. Write naturally.
            </span>
          </div>

          <div className="px-4 py-3 border-b border-border bg-background/70 flex flex-col sm:flex-row sm:items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              German letters
            </span>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="German special letters"
            >
              {GERMAN_SPECIAL_LETTERS.map((letter) => (
                <Button
                  key={letter}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 min-w-8 px-2 text-base font-semibold leading-none bg-card"
                  aria-label={`Insert ${letter}`}
                  disabled={isChecking || !draftReady}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertSpecialLetter(letter)}
                >
                  {letter}
                </Button>
              ))}
            </div>
          </div>

          <Textarea
            id="student-writing-text"
            ref={textareaRef}
            className="min-h-[260px] flex-1 resize-none border-0 focus-visible:ring-0 rounded-none p-6 text-lg leading-relaxed shadow-none bg-transparent sm:min-h-[340px]"
            placeholder="Type your German text here..."
            value={text}
            onChange={(e) => handleWritingChange(e.target.value)}
            onClick={rememberSelection}
            onFocus={rememberSelection}
            onKeyUp={rememberSelection}
            onSelect={rememberSelection}
            onBlur={handleWritingBlur}
            disabled={isChecking || !draftReady || !selectedBatchId}
            aria-describedby={`writing-counts${submitError ? " writing-submit-error" : ""}`}
            aria-invalid={Boolean(submitError)}
          />

          <div className="bg-background px-6 py-4 border-t border-border flex flex-col sm:flex-row justify-between items-center gap-4">
            <div
              id="writing-counts"
              className={`text-sm text-foreground flex flex-wrap gap-4 ${isChecking ? "opacity-80" : ""}`}
            >
              <span
                className={
                  isFree
                    ? "font-medium"
                    : wordCount > 0 && expectedWordMinimum !== null
                      ? wordCount >= expectedWordMinimum
                        ? "text-green-700 dark:text-green-300 font-semibold"
                        : "text-amber-700 dark:text-amber-300 font-semibold"
                      : "font-medium"
                }
              >
                <strong>{wordCount}</strong> words
              </span>
              <span
                className={
                  writingCharacterCount > V1_WRITING_MAX_CHARACTERS
                    ? "font-semibold text-destructive"
                    : "font-medium"
                }
              >
                <strong>{writingCharacterCount}</strong> /{" "}
                {V1_WRITING_MAX_CHARACTERS.toLocaleString()} characters
              </span>
              <span className="font-medium text-muted-foreground">
                Up to {V1_WRITING_MAX_FEEDBACK_UNITS} sentences or paragraphs
              </span>
              {submitError && (
                <span
                  id="writing-submit-error"
                  className="text-destructive font-medium"
                  role="alert"
                >
                  {submitError}
                </span>
              )}
            </div>

            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground sm:w-auto"
                onClick={() => setText("")}
                disabled={!text || isChecking || !draftReady}
              >
                <Trash2 className="w-4 h-4 mr-2" /> Clear
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => void handleSaveDraft()}
                disabled={
                  (!text.trim() && !draftId) ||
                  !draftReady ||
                  isChecking ||
                  !selectedBatchId ||
                  draftState === "saving" ||
                  draftState === "conflict"
                }
              >
                {draftState === "saving" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save Draft
              </Button>
              <Button
                onClick={handleCheck}
                disabled={
                  !text.trim() ||
                  !draftReady ||
                  isChecking ||
                  draftState === "conflict" ||
                  !selectedBatchId
                }
                className="w-full shadow-md sm:w-auto"
                aria-busy={isChecking}
              >
                {isChecking ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                )}
                Submit Writing
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
