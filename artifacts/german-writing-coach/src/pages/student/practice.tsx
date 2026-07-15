import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  ClipboardList,
  Loader2,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import {
  formatIssueCount,
  getWeaknessBadgeClass,
  getWeaknessLabel,
  getWeaknessStateDescription,
  type StudentGrammarStat,
} from "@/services/grammarStatsService";
import {
  createNextPracticeAssignment,
  ensureStudentPracticeAssignment,
  formatPracticeScore,
  getPracticeAssignmentBadgeClass,
  getPracticeAssignmentLabel,
  preparePracticeWorksheet,
  type PracticeAssignmentSummary,
} from "@/services/practiceWorksheetService";
import {
  createBoundedPracticePollController,
  createStudentPracticeQueries,
  PRACTICE_WORKSPACE_SCOPE_COPY,
  refreshStudentPracticeOnResume,
} from "@/lib/studentPracticeQueries";
import { usePracticeUnlockRealtime } from "@/hooks/use-practice-unlock-realtime";

const SAFE_PREPARATION_ERROR =
  "Worksheet preparation did not finish. Your progress is safe; retry preparation now.";
const RETRY_EXHAUSTED_COPY =
  "Automatic worksheet retries are exhausted. Your teacher can review this topic while approved material is checked.";

function isActivePracticeAssignment(assignment: PracticeAssignmentSummary) {
  return (
    assignment.status === "unlocked" || assignment.status === "in_progress"
  );
}

function isCompletedPracticeAssignment(assignment: PracticeAssignmentSummary) {
  return (
    assignment.status === "completed" ||
    assignment.status === "passed" ||
    assignment.status === "failed"
  );
}

function sortNewestPracticeAssignment(
  left: PracticeAssignmentSummary,
  right: PracticeAssignmentSummary,
) {
  return (
    new Date(right.assigned_at).getTime() - new Date(left.assigned_at).getTime()
  );
}

function getHistoryStatusLabel(assignment: PracticeAssignmentSummary) {
  if (assignment.status === "passed") return "Passed";
  if (assignment.status === "failed") return "Needs more practice";
  return "Completed";
}

export function getDisplayedPracticeStateDescription(
  stat: StudentGrammarStat,
  assignments: PracticeAssignmentSummary[],
) {
  const defaultDescription = getWeaknessStateDescription(stat);
  if (!stat.practice_unlocked && stat.weakness_level !== "unlocked") {
    return defaultDescription;
  }

  const activeAssignment = assignments.find(isActivePracticeAssignment);
  if (!activeAssignment || activeAssignment.practice_test_id) {
    return defaultDescription;
  }
  if (
    activeAssignment.class_context_version !== 1 ||
    !activeAssignment.batch_id
  ) {
    return "Practice is unlocked, but your teacher must confirm the class before preparation.";
  }
  if (
    activeAssignment.generation_status === "queued" ||
    activeAssignment.generation_status === "generating"
  ) {
    return "Practice is unlocked and your worksheet is being prepared now.";
  }
  if (activeAssignment.generation_status === "needs_review") {
    return "Practice is unlocked, but this worksheet is still being checked before assignment.";
  }
  if (activeAssignment.generation_status === "failed") {
    return activeAssignment.generation_retry_exhausted
      ? RETRY_EXHAUSTED_COPY
      : "Practice is unlocked. Worksheet preparation can be retried now.";
  }

  return "Practice is unlocked. Prepare a worksheet when you are ready.";
}

export default function StudentPractice() {
  const { activeWorkspaceId: workspaceId, user } = useAuth();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [practiceActionError, setPracticeActionError] = useState<string | null>(
    null,
  );
  const [ensuringAssignments, setEnsuringAssignments] = useState(false);
  const [preparingAssignments, setPreparingAssignments] = useState<Set<string>>(
    new Set(),
  );
  const [advancingAssignments, setAdvancingAssignments] = useState<Set<string>>(
    new Set(),
  );
  const ensuredTopicsSignatureRef = useRef<string | null>(null);

  const studentId = user?.id ?? "inactive-student";
  const queryEnabled = Boolean(user) && Boolean(workspaceId);
  const practiceQueries = useMemo(
    () =>
      createStudentPracticeQueries(
        workspaceId ?? "inactive-workspace",
        studentId,
      ),
    [studentId, workspaceId],
  );
  const pollController = useMemo(
    () => createBoundedPracticePollController(),
    [studentId, workspaceId],
  );
  const statsQuery = useQuery({
    ...practiceQueries.stats,
    enabled: queryEnabled,
  });
  const assignmentsQuery = useQuery({
    ...practiceQueries.assignments,
    enabled: queryEnabled,
    refetchInterval: (query) =>
      pollController.getInterval(
        query.state.data as PracticeAssignmentSummary[] | undefined,
      ),
    refetchIntervalInBackground: false,
  });
  usePracticeUnlockRealtime({
    enabled: queryEnabled,
    workspaceId: workspaceId ?? "inactive-workspace",
    studentId,
  });

  useEffect(() => {
    if (!queryEnabled) return;

    const resumePolling = () => {
      void refreshStudentPracticeOnResume(
        queryClient,
        practiceQueries,
        pollController,
      );
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") resumePolling();
    };

    window.addEventListener("focus", resumePolling);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", resumePolling);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [pollController, practiceQueries, queryClient, queryEnabled]);
  const realStats = statsQuery.data ?? [];
  const realAssignments = assignmentsQuery.data ?? [];
  const loadingRealStats =
    queryEnabled &&
    (statsQuery.isPending || assignmentsQuery.isPending || ensuringAssignments);
  const practiceQueryError = statsQuery.error ?? assignmentsQuery.error;
  const realStatsError =
    practiceActionError ??
    (practiceQueryError
      ? formatErrorMessage(
          practiceQueryError,
          "Unable to load practice topics.",
        )
      : !workspaceId
        ? "Practice needs an active workspace."
        : null);

  const updateCachedAssignment = (assignment: PracticeAssignmentSummary) => {
    queryClient.setQueryData<PracticeAssignmentSummary[]>(
      practiceQueries.assignments.queryKey,
      (current = []) => [
        assignment,
        ...current.filter((item) => item.id !== assignment.id),
      ],
    );
    queryClient.setQueryData(
      practiceQueries.assignment(assignment.id).queryKey,
      assignment,
    );
  };

  useEffect(() => {
    if (
      !queryEnabled ||
      !workspaceId ||
      !user ||
      !statsQuery.isSuccess ||
      !assignmentsQuery.isSuccess
    ) {
      return;
    }

    const activeTopicIds = new Set(
      realAssignments
        .filter(isActivePracticeAssignment)
        .map((assignment) => assignment.grammar_topic_id),
    );
    const unlockedStats = realStats.filter(
      (stat) =>
        (stat.practice_unlocked || stat.weakness_level === "unlocked") &&
        !activeTopicIds.has(stat.grammar_topic_id),
    );
    if (unlockedStats.length === 0) return;

    const signature = [
      workspaceId,
      user.id,
      ...unlockedStats.map((stat) => stat.grammar_topic_id).sort(),
    ].join(":");
    if (ensuredTopicsSignatureRef.current === signature) return;
    ensuredTopicsSignatureRef.current = signature;

    let cancelled = false;
    setEnsuringAssignments(true);
    setPracticeActionError(null);
    void Promise.all(
      unlockedStats.map((stat) =>
        ensureStudentPracticeAssignment(
          workspaceId,
          user.id,
          stat.grammar_topic_id,
        ),
      ),
    )
      .then((ensuredAssignments) => {
        if (cancelled) return;
        queryClient.setQueryData<PracticeAssignmentSummary[]>(
          practiceQueries.assignments.queryKey,
          (current = []) => {
            const ensuredIds = new Set(
              ensuredAssignments.map((assignment) => assignment.id),
            );
            return [
              ...ensuredAssignments,
              ...current.filter((assignment) => !ensuredIds.has(assignment.id)),
            ];
          },
        );
      })
      .catch((error) => {
        if (!cancelled) {
          setPracticeActionError(
            formatErrorMessage(error, "Unable to unlock practice topics."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setEnsuringAssignments(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    assignmentsQuery.isSuccess,
    practiceQueries.assignments.queryKey,
    queryClient,
    queryEnabled,
    realAssignments,
    realStats,
    statsQuery.isSuccess,
    user,
    workspaceId,
  ]);

  const handlePrepareWorksheet = async (
    assignment: PracticeAssignmentSummary,
  ) => {
    try {
      setPracticeActionError(null);
      setPreparingAssignments((current) => new Set(current).add(assignment.id));
      pollController.reset();
      const preparedAssignment = await preparePracticeWorksheet(assignment.id);
      updateCachedAssignment(preparedAssignment);
    } catch {
      const refreshedAssignment = await queryClient
        .fetchQuery(practiceQueries.assignment(assignment.id))
        .catch(() => null);
      if (
        refreshedAssignment &&
        (refreshedAssignment.practice_test_id ||
          refreshedAssignment.generation_status === "queued" ||
          refreshedAssignment.generation_status === "generating" ||
          refreshedAssignment.generation_status === "needs_review" ||
          refreshedAssignment.generation_status === "failed" ||
          refreshedAssignment.generation_status !==
            assignment.generation_status)
      ) {
        updateCachedAssignment(refreshedAssignment);
      } else {
        setPracticeActionError(SAFE_PREPARATION_ERROR);
      }
    } finally {
      setPreparingAssignments((current) => {
        const next = new Set(current);
        next.delete(assignment.id);
        return next;
      });
    }
  };

  const handleCreateNextPractice = async (
    assignment: PracticeAssignmentSummary,
    navigateToAssignment = false,
  ) => {
    try {
      setPracticeActionError(null);
      setAdvancingAssignments((current) => new Set(current).add(assignment.id));
      const nextAssignment = await createNextPracticeAssignment(assignment.id);
      updateCachedAssignment(nextAssignment);
      if (navigateToAssignment) {
        navigate(`/student/practice/${nextAssignment.id}`);
      }
    } catch (error) {
      setPracticeActionError(
        formatErrorMessage(error, "Unable to prepare the next worksheet."),
      );
    } finally {
      setAdvancingAssignments((current) => {
        const next = new Set(current);
        next.delete(assignment.id);
        return next;
      });
    }
  };

  const retryPracticeLoad = () => {
    setPracticeActionError(null);
    ensuredTopicsSignatureRef.current = null;
    pollController.reset();
    void Promise.all([statsQuery.refetch(), assignmentsQuery.refetch()]);
  };

  const assignmentsByTopic = new Map<string, PracticeAssignmentSummary[]>();
  for (const assignment of realAssignments) {
    const current = assignmentsByTopic.get(assignment.grammar_topic_id) ?? [];
    current.push(assignment);
    assignmentsByTopic.set(assignment.grammar_topic_id, current);
  }
  for (const assignments of assignmentsByTopic.values()) {
    assignments.sort(sortNewestPracticeAssignment);
  }
  const statsForDisplay = [...realStats];
  const statTopicIds = new Set(realStats.map((stat) => stat.grammar_topic_id));
  for (const [topicId, assignments] of assignmentsByTopic.entries()) {
    if (statTopicIds.has(topicId)) continue;
    const visibleAssignment = assignments.find(
      (assignment) =>
        isActivePracticeAssignment(assignment) ||
        isCompletedPracticeAssignment(assignment),
    );
    if (!visibleAssignment) continue;

    const activeAssignment = assignments.find(isActivePracticeAssignment);
    const completedAssignment = assignments.find(isCompletedPracticeAssignment);
    const weaknessLevel: StudentGrammarStat["weakness_level"] = activeAssignment
      ? activeAssignment.status === "in_progress"
        ? "in_progress"
        : "unlocked"
      : completedAssignment?.status === "passed"
        ? "improving"
        : "locked";

    statsForDisplay.push({
      id: `assignment-${visibleAssignment.id}`,
      workspace_id: visibleAssignment.workspace_id,
      student_id: visibleAssignment.student_id,
      grammar_topic_id: topicId,
      topic_name: visibleAssignment.grammar_topic_name,
      topic_slug: visibleAssignment.grammar_topic_slug,
      topic_description: visibleAssignment.grammar_topic_description,
      total_minor_issues: 0,
      total_major_issues: 0,
      total_correct_after_practice: 0,
      weakness_level: weaknessLevel,
      practice_unlocked: activeAssignment?.status === "unlocked",
      resolution_cycle_id:
        activeAssignment?.resolution_cycle_id ??
        completedAssignment?.resolution_cycle_id ??
        null,
      resolution_cycle_number:
        activeAssignment?.resolution_cycle_number ??
        completedAssignment?.resolution_cycle_number ??
        0,
      resolved_through_sequence: 0,
      mastery_pass_count: completedAssignment?.status === "passed" ? 1 : 0,
      state_reason: null,
      last_seen_at: null,
      updated_at: visibleAssignment.assigned_at,
    });
  }
  const childAssignmentsByPrevious = new Map<
    string,
    PracticeAssignmentSummary
  >();
  for (const assignment of realAssignments) {
    if (
      assignment.previous_assignment_id &&
      assignment.source === "adaptive_repeat" &&
      assignment.status !== "cancelled"
    ) {
      const existing = childAssignmentsByPrevious.get(
        assignment.previous_assignment_id,
      );
      if (!existing || sortNewestPracticeAssignment(assignment, existing) < 0) {
        childAssignmentsByPrevious.set(
          assignment.previous_assignment_id,
          assignment,
        );
      }
    }
  }
  const groupedStats = {
    unlocked: statsForDisplay.filter(
      (stat) => stat.practice_unlocked || stat.weakness_level === "unlocked",
    ),
    inProgress: statsForDisplay.filter(
      (stat) => stat.weakness_level === "in_progress",
    ),
    locked: statsForDisplay.filter(
      (stat) => !stat.practice_unlocked && stat.weakness_level === "locked",
    ),
    improving: statsForDisplay.filter(
      (stat) => stat.weakness_level === "improving",
    ),
    mastered: statsForDisplay.filter(
      (stat) => stat.weakness_level === "mastered",
    ),
  };

  const sections = [
    { title: "Practice unlocked", stats: groupedStats.unlocked },
    { title: "In progress", stats: groupedStats.inProgress },
    { title: "Temporarily unavailable", stats: groupedStats.locked },
    { title: "Improving", stats: groupedStats.improving },
    { title: "Mastered", stats: groupedStats.mastered },
  ].filter((section) => section.stats.length > 0);

  return (
    <div className="container mx-auto px-4 py-8 sm:py-12 max-w-5xl animate-in fade-in duration-500">
      <h1 className="text-3xl sm:text-4xl font-serif tracking-tight mb-2">
        Practice Center
      </h1>
      <p className="text-muted-foreground text-lg mb-3">
        Review grammar topics unlocked from feedback on your writings.
      </p>
      <p className="mb-10 max-w-3xl text-sm text-muted-foreground">
        {PRACTICE_WORKSPACE_SCOPE_COPY}
      </p>

      {loadingRealStats ? (
        <Card className="border-border shadow-sm">
          <CardContent
            className="p-8 text-center text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin" />
            Loading practice profile...
          </CardContent>
        </Card>
      ) : realStatsError ? (
        <Card className="border-destructive/30 bg-destructive/5" role="alert">
          <CardContent className="flex flex-col items-start gap-4 p-6 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
            <span>{realStatsError}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full shrink-0 sm:w-auto"
              onClick={retryPracticeLoad}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : statsForDisplay.length === 0 ? (
        <Card className="border-dashed bg-muted/20">
          <CardContent className="p-10 text-center">
            <h2 className="text-2xl font-serif mb-3">No focus areas yet.</h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              Released feedback from your next writing will build your focus
              profile here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="text-xl font-serif tracking-tight mb-4">
                {section.title}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {section.stats.map((stat) => (
                  <Card key={stat.id} className="border-border shadow-sm">
                    <CardContent className="p-6">
                      <div className="flex justify-between items-start gap-4 mb-4">
                        <Badge
                          variant="outline"
                          className={getWeaknessBadgeClass(
                            stat.weakness_level,
                            stat.practice_unlocked,
                          )}
                        >
                          {getWeaknessLabel(
                            stat.weakness_level,
                            stat.practice_unlocked,
                          )}
                        </Badge>
                        <span className="text-xs font-mono text-muted-foreground">
                          {formatIssueCount(stat)}
                        </span>
                      </div>
                      <h3 className="font-serif text-2xl text-foreground mb-2">
                        {stat.topic_name}
                      </h3>
                      <p className="text-sm text-muted-foreground leading-relaxed min-h-10">
                        {stat.topic_description ??
                          "Review this grammar topic based on feedback from your writings."}
                      </p>
                      <p className="mt-3 text-sm text-muted-foreground">
                        {getDisplayedPracticeStateDescription(
                          stat,
                          assignmentsByTopic.get(stat.grammar_topic_id) ?? [],
                        )}
                      </p>
                      {(() => {
                        const topicAssignments =
                          assignmentsByTopic.get(stat.grammar_topic_id) ?? [];
                        const activeAssignment =
                          topicAssignments.find(isActivePracticeAssignment) ??
                          null;
                        const historyAssignments = topicAssignments
                          .filter(isCompletedPracticeAssignment)
                          .slice(0, 3);

                        if (
                          !activeAssignment &&
                          historyAssignments.length === 0
                        ) {
                          return (
                            <div className="mt-6 rounded-lg border border-dashed bg-muted/25 p-4 text-sm text-muted-foreground">
                              {getWeaknessStateDescription(stat)}
                            </div>
                          );
                        }

                        return (
                          <div className="mt-6 space-y-4">
                            {activeAssignment ? (
                              (() => {
                                const assignment = activeAssignment;
                                const scoreLabel =
                                  formatPracticeScore(assignment);
                                if (!assignment.practice_test_id) {
                                  const isPreparing =
                                    preparingAssignments.has(assignment.id) ||
                                    assignment.generation_status === "queued" ||
                                    assignment.generation_status ===
                                      "generating";
                                  const didFail =
                                    assignment.generation_status === "failed";
                                  const retryExhausted =
                                    didFail &&
                                    assignment.generation_retry_exhausted;
                                  const needsReview =
                                    assignment.generation_status ===
                                    "needs_review";
                                  const needsClassContext =
                                    assignment.class_context_version !== 1 ||
                                    !assignment.batch_id;
                                  const isRepeat =
                                    assignment.source === "adaptive_repeat";
                                  return (
                                    <div className="rounded-lg border border-dashed bg-muted/25 p-4">
                                      <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div className="min-w-0">
                                          <Badge
                                            variant="outline"
                                            className={getPracticeAssignmentBadgeClass(
                                              assignment,
                                            )}
                                          >
                                            {needsReview
                                              ? "Quality review"
                                              : isPreparing
                                                ? "Preparing worksheet"
                                                : getPracticeAssignmentLabel(
                                                    assignment,
                                                  )}
                                          </Badge>
                                          <p
                                            className="mt-2 text-sm text-muted-foreground"
                                            role="status"
                                            aria-live="polite"
                                          >
                                            {needsClassContext
                                              ? "Your teacher needs to confirm which class this worksheet belongs to before it can be prepared."
                                              : isPreparing
                                                ? "Preparing worksheet..."
                                                : needsReview
                                                  ? "This worksheet is being held for quality review before it can be assigned."
                                                  : didFail
                                                    ? retryExhausted
                                                      ? RETRY_EXHAUSTED_COPY
                                                      : SAFE_PREPARATION_ERROR
                                                    : isRepeat
                                                      ? "Practice again is unlocked. Prepare the next worksheet when you are ready."
                                                      : "Practice unlocked. Prepare a worksheet when you are ready."}
                                          </p>
                                          {assignment.batch_name && (
                                            <p className="mt-1 text-xs text-muted-foreground">
                                              {assignment.batch_name}
                                              {assignment.worksheet_level
                                                ? ` · ${assignment.worksheet_level}`
                                                : ""}
                                            </p>
                                          )}
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          {isRepeat &&
                                            assignment.previous_assignment_id && (
                                              <Button
                                                asChild
                                                size="sm"
                                                variant="outline"
                                              >
                                                <Link
                                                  href={`/student/practice/${assignment.previous_assignment_id}`}
                                                >
                                                  <ArrowLeft className="h-4 w-4 mr-2" />
                                                  Review previous worksheet
                                                </Link>
                                              </Button>
                                            )}
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant={
                                              didFail && !retryExhausted
                                                ? "default"
                                                : "outline"
                                            }
                                            disabled={
                                              isPreparing ||
                                              needsReview ||
                                              needsClassContext ||
                                              retryExhausted
                                            }
                                            aria-busy={isPreparing}
                                            onClick={() =>
                                              void handlePrepareWorksheet(
                                                assignment,
                                              )
                                            }
                                          >
                                            {isPreparing ? (
                                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                            ) : (
                                              <ClipboardList className="h-4 w-4 mr-2" />
                                            )}
                                            {isPreparing
                                              ? "Preparing..."
                                              : needsClassContext
                                                ? "Class confirmation needed"
                                                : needsReview
                                                  ? "Awaiting review"
                                                  : retryExhausted
                                                    ? "Teacher review needed"
                                                    : didFail
                                                      ? "Retry preparation"
                                                      : isRepeat
                                                        ? "Prepare next worksheet"
                                                        : "Prepare worksheet"}
                                          </Button>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                }

                                return (
                                  <div className="rounded-lg border bg-muted/20 p-4">
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                      <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <Badge
                                            variant="outline"
                                            className={getPracticeAssignmentBadgeClass(
                                              assignment,
                                            )}
                                          >
                                            {getPracticeAssignmentLabel(
                                              assignment,
                                            )}
                                          </Badge>
                                          {scoreLabel && (
                                            <span className="text-xs text-muted-foreground">
                                              {scoreLabel}
                                            </span>
                                          )}
                                        </div>
                                        <p className="mt-2 text-sm font-medium text-foreground truncate">
                                          {assignment.worksheet_title ??
                                            "Practice Worksheet"}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                          {assignment.question_count} questions
                                          {assignment.worksheet_level
                                            ? ` · ${assignment.worksheet_level}`
                                            : ""}
                                          {assignment.batch_name
                                            ? ` · ${assignment.batch_name}`
                                            : ""}
                                        </p>
                                      </div>
                                      <div className="flex flex-wrap gap-2">
                                        {assignment.source ===
                                          "adaptive_repeat" &&
                                          assignment.previous_assignment_id && (
                                            <Button
                                              asChild
                                              size="sm"
                                              variant="outline"
                                            >
                                              <Link
                                                href={`/student/practice/${assignment.previous_assignment_id}`}
                                              >
                                                <ArrowLeft className="h-4 w-4 mr-2" />
                                                Review previous worksheet
                                              </Link>
                                            </Button>
                                          )}
                                        <Button
                                          asChild
                                          size="sm"
                                          variant={
                                            assignment.status === "in_progress"
                                              ? "default"
                                              : "outline"
                                          }
                                        >
                                          <Link
                                            href={`/student/practice/${assignment.id}`}
                                          >
                                            <ClipboardList className="h-4 w-4 mr-2" />
                                            {assignment.status === "in_progress"
                                              ? "Continue worksheet"
                                              : assignment.status === "unlocked"
                                                ? "Start worksheet"
                                                : "Review worksheet"}
                                          </Link>
                                        </Button>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()
                            ) : (
                              <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
                                {stat.weakness_level === "mastered"
                                  ? "This topic is mastered, so no new worksheet is needed."
                                  : stat.weakness_level === "improving"
                                    ? "Your latest practice passed. New writing evidence will determine whether another worksheet is needed."
                                    : "No current worksheet is assigned for this topic."}
                              </div>
                            )}

                            {historyAssignments.length > 0 && (
                              <div className="rounded-lg border bg-card p-4">
                                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                  Recent worksheets
                                </p>
                                <div className="space-y-3">
                                  {historyAssignments.map(
                                    (historyAssignment) => {
                                      const historyScoreLabel =
                                        formatPracticeScore(historyAssignment);
                                      const childAssignment =
                                        childAssignmentsByPrevious.get(
                                          historyAssignment.id,
                                        );
                                      const canCreateRepeat =
                                        historyAssignment.status === "failed" &&
                                        historyAssignment.source !==
                                          "adaptive_repeat" &&
                                        !childAssignment;
                                      const repeatAlreadyCreated =
                                        historyAssignment.status === "failed" &&
                                        Boolean(childAssignment);
                                      const repeatNeedsTeacher =
                                        historyAssignment.status === "failed" &&
                                        historyAssignment.source ===
                                          "adaptive_repeat";

                                      return (
                                        <div
                                          key={historyAssignment.id}
                                          className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/10 px-3 py-3"
                                        >
                                          <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                              <Badge
                                                variant="outline"
                                                className={getPracticeAssignmentBadgeClass(
                                                  historyAssignment,
                                                )}
                                              >
                                                {getHistoryStatusLabel(
                                                  historyAssignment,
                                                )}
                                              </Badge>
                                              {historyScoreLabel && (
                                                <span className="text-xs text-muted-foreground">
                                                  {historyScoreLabel}
                                                </span>
                                              )}
                                            </div>
                                            <p className="mt-1 truncate text-sm font-medium text-foreground">
                                              {historyAssignment.worksheet_title ??
                                                "Practice Worksheet"}
                                            </p>
                                            {repeatAlreadyCreated && (
                                              <p className="mt-1 text-xs text-muted-foreground">
                                                Next practice already created.
                                              </p>
                                            )}
                                            {repeatNeedsTeacher && (
                                              <p className="mt-1 text-xs text-muted-foreground">
                                                Please review this with your
                                                teacher.
                                              </p>
                                            )}
                                          </div>
                                          <div className="flex flex-wrap gap-2">
                                            <Button
                                              asChild
                                              size="sm"
                                              variant="outline"
                                            >
                                              <Link
                                                href={`/student/practice/${historyAssignment.id}`}
                                              >
                                                <ClipboardList className="h-4 w-4 mr-2" />
                                                Review worksheet
                                              </Link>
                                            </Button>
                                            {repeatAlreadyCreated &&
                                              childAssignment && (
                                                <Button asChild size="sm">
                                                  <Link
                                                    href={`/student/practice/${childAssignment.id}`}
                                                  >
                                                    <ArrowRight className="h-4 w-4 mr-2" />
                                                    Go to next worksheet
                                                  </Link>
                                                </Button>
                                              )}
                                            {canCreateRepeat && (
                                              <Button
                                                type="button"
                                                size="sm"
                                                disabled={advancingAssignments.has(
                                                  historyAssignment.id,
                                                )}
                                                onClick={() =>
                                                  void handleCreateNextPractice(
                                                    historyAssignment,
                                                  )
                                                }
                                              >
                                                {advancingAssignments.has(
                                                  historyAssignment.id,
                                                ) ? (
                                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                                ) : (
                                                  <RefreshCw className="h-4 w-4 mr-2" />
                                                )}
                                                Practice again
                                              </Button>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    },
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
