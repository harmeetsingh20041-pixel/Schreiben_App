import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PromptText } from "@/components/prompt-text";
import { Search, Clock, Edit3, KeyRound } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage, LEVEL_OPTIONS } from "@/lib/workspaceData";
import {
  listStudentAssignedQuestionsPage,
  STUDENT_ASSIGNED_QUESTION_PAGE_SIZE,
  type StudentAssignedQuestionCursor,
  type StudentWritingTaskState,
  type WorkspaceQuestion,
} from "@/services/questionService";
import {
  getProminentJoinRequest,
  requestJoinBatchByCode,
} from "@/services/studentService";
import { appQueryKeys, SHARED_QUERY_STALE_MS } from "@/lib/appQueryKeys";
import { createStudentAccessQueries } from "@/lib/dashboardQueries";
import { useStudentClass } from "@/lib/studentClassContext";

function wordRange(question: WorkspaceQuestion) {
  if (question.expected_word_min && question.expected_word_max) {
    return `${question.expected_word_min}-${question.expected_word_max}`;
  }
  if (question.expected_word_min) return `${question.expected_word_min}+`;
  if (question.expected_word_max) return `up to ${question.expected_word_max}`;
  return "Flexible";
}

export function getWordGuidance(question: WorkspaceQuestion) {
  if (question.expected_word_min && question.expected_word_max) {
    return `Suggested length: ${question.expected_word_min}–${question.expected_word_max} words`;
  }
  if (question.expected_word_min) {
    return `Suggested length: at least ${question.expected_word_min} words`;
  }
  if (question.expected_word_max) {
    return `Suggested length: up to ${question.expected_word_max} words`;
  }
  return "Suggested length: no fixed word limit";
}

const taskPresentations: Record<
  StudentWritingTaskState,
  {
    badge: string | null;
    action: string;
    className: string;
  }
> = {
  not_started: { badge: null, action: "Start Writing", className: "" },
  submitted: {
    badge: "Submitted",
    action: "View Submission",
    className: "bg-blue-50 text-blue-800 border-blue-200",
  },
  queued: {
    badge: "Queued",
    action: "View Progress",
    className: "bg-blue-50 text-blue-800 border-blue-200",
  },
  processing: {
    badge: "Checking",
    action: "View Progress",
    className: "bg-blue-50 text-blue-800 border-blue-200",
  },
  scheduled: {
    badge: "Feedback scheduled",
    action: "View Submission",
    className: "bg-amber-50 text-amber-900 border-amber-200",
  },
  needs_review: {
    badge: "Held for review",
    action: "View Submission",
    className: "bg-amber-50 text-amber-900 border-amber-200",
  },
  feedback_held: {
    badge: "Waiting for teacher",
    action: "View Submission",
    className: "bg-amber-50 text-amber-900 border-amber-200",
  },
  feedback_released: {
    badge: "Feedback ready",
    action: "View Feedback",
    className: "bg-green-50 text-green-800 border-green-200",
  },
  failed: {
    badge: "Evaluation failed",
    action: "View Submission",
    className: "bg-red-50 text-red-800 border-red-200",
  },
};

export function getStudentTaskPresentation(state: StudentWritingTaskState) {
  return taskPresentations[state];
}

export default function StudentQuestions() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<string>("All");
  const [joinCode, setJoinCode] = useState("");
  const [questionCursorTrail, setQuestionCursorTrail] = useState<
    Array<StudentAssignedQuestionCursor | null>
  >([null]);
  const questionCursor =
    questionCursorTrail[questionCursorTrail.length - 1] ?? null;
  const questionPageNumber = questionCursorTrail.length;
  const [, setLocation] = useLocation();
  const studentId = user?.id ?? "inactive-student";
  const queryEnabled = Boolean(user);
  const accessQueries = createStudentAccessQueries(studentId);
  const {
    activeBatchId: selectedBatchId,
    assignments: batchAssignments,
    error: assignmentsError,
    isLoading: assignmentsLoading,
    selectActiveBatch,
  } = useStudentClass();
  const joinRequestsQuery = useQuery({
    ...accessQueries.joinRequests,
    enabled: queryEnabled,
  });
  const questionsQuery = useQuery({
    queryKey: appQueryKeys.studentAssignedQuestionsPage({
      studentId,
      batchId: selectedBatchId ?? "inactive-class",
      search: debouncedSearch,
      level: levelFilter === "All" ? null : levelFilter,
      pageSize: STUDENT_ASSIGNED_QUESTION_PAGE_SIZE,
      cursor: questionCursor,
    }),
    queryFn: () =>
      listStudentAssignedQuestionsPage({
        studentId,
        batchId: selectedBatchId!,
        search: debouncedSearch,
        level:
          levelFilter === "All"
            ? null
            : (levelFilter as WorkspaceQuestion["level"]),
        pageSize: STUDENT_ASSIGNED_QUESTION_PAGE_SIZE,
        cursor: questionCursor,
      }),
    enabled: queryEnabled && Boolean(selectedBatchId),
    staleTime: SHARED_QUERY_STALE_MS,
  });
  const realQuestionPage = questionsQuery.data;
  const realQuestions = realQuestionPage?.items ?? [];
  const joinRequests = joinRequestsQuery.data ?? [];
  const loading =
    queryEnabled &&
    ((Boolean(selectedBatchId) && questionsQuery.isPending) ||
      assignmentsLoading ||
      joinRequestsQuery.isPending);
  const loadError = [
    questionsQuery.error,
    assignmentsError,
    joinRequestsQuery.error,
  ].find(Boolean);
  const error = loadError
    ? formatErrorMessage(loadError, "Unable to load assigned writing tasks.")
    : null;
  const joinBatchMutation = useMutation({ mutationFn: requestJoinBatchByCode });

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setQuestionCursorTrail([null]);
  }, [debouncedSearch, levelFilter, selectedBatchId, studentId]);

  const filteredQuestions = realQuestions;

  const startWritingTask = (question: WorkspaceQuestion) => {
    sessionStorage.setItem(
      "gwc_selected_question",
      JSON.stringify({
        id: question.id,
        title: question.title,
        source: question.source,
        workspace_id: question.workspace_id,
        batch_id: question.batch_id ?? selectedBatchId,
        level: question.level,
        topic: question.topic,
        prompt: question.prompt,
        expected_word_range: wordRange(question),
        estimated_time: question.estimated_minutes
          ? `${question.estimated_minutes} mins`
          : "flexible",
        active: question.is_active,
      }),
    );
    setLocation(`/student/write?q=${question.id}`);
  };

  const submitJoinCode = async () => {
    if (!joinCode.trim()) {
      toast({
        title: "Class code required",
        description: "Enter the code your teacher shared.",
      });
      return;
    }

    try {
      const result = await joinBatchMutation.mutateAsync(joinCode);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.studentBatchAssignments(studentId),
        }),
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.studentJoinRequests(studentId),
        }),
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.studentAssignedQuestions(studentId),
        }),
      ]);
      setJoinCode("");
      toast(
        result.status === "approved"
          ? {
              title: "Already joined",
              description: `You already have access to ${result.batch_name}.`,
            }
          : {
              title: "Request sent",
              description: "Waiting for teacher approval.",
            },
      );
    } catch (joinError) {
      toast({
        title: "Could not request class",
        description: formatErrorMessage(
          joinError,
          "Check the code and try again.",
        ),
      });
    }
  };
  const submittingJoinCode = joinBatchMutation.isPending;

  const latestJoinRequest = getProminentJoinRequest(joinRequests);

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Writing Tasks</h1>
          <p className="text-muted-foreground mt-1">
            Choose a writing task to practice your writing skills.
          </p>
        </div>
      </div>

      {batchAssignments.length > 1 && (
        <div className="mb-6 rounded-lg border bg-card p-4">
          <label
            htmlFor="writing-class"
            className="mb-2 block text-sm font-medium"
          >
            Class for this writing
          </label>
          <Select
            value={selectedBatchId ?? ""}
            onValueChange={selectActiveBatch}
          >
            <SelectTrigger
              id="writing-class"
              aria-label="Class for this writing"
              className="w-full sm:w-80"
            >
              <SelectValue placeholder="Choose a class before writing" />
            </SelectTrigger>
            <SelectContent>
              {batchAssignments.map((assignment) => (
                <SelectItem
                  key={assignment.batch_id}
                  value={assignment.batch_id}
                >
                  {assignment.batch_name} · {assignment.level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!selectedBatchId && (
            <p className="mt-2 text-sm text-amber-700" role="status">
              Choose the class that should receive this writing.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4 mb-8">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search topics..."
            aria-label="Search writing tasks"
            className="pl-9 bg-card border-border shadow-sm"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div
          className="flex gap-2 flex-wrap"
          role="group"
          aria-label="Filter by CEFR level"
        >
          {["All", ...LEVEL_OPTIONS].map((level) => (
            <Button
              key={level}
              variant={levelFilter === level ? "default" : "outline"}
              className={
                levelFilter === level
                  ? "min-w-[4.5rem]"
                  : "min-w-[4.5rem] bg-card text-foreground"
              }
              onClick={() => setLevelFilter(level)}
              aria-pressed={levelFilter === level}
            >
              {level === "All" ? "All Levels" : level}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive" role="alert">
            {error}
          </CardContent>
        </Card>
      )}

      {!loading && (
        <Card className="mb-8 border-primary/25 bg-primary/5">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                <KeyRound className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle>
                  {batchAssignments.length > 0
                    ? "Join another class"
                    : "Join your first class"}
                </CardTitle>
                <CardDescription>
                  Enter the class code your teacher shared. Every request waits
                  for teacher approval.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-3">
              <Input
                value={joinCode}
                onChange={(event) =>
                  setJoinCode(event.target.value.toUpperCase())
                }
                placeholder="Enter class code"
                aria-label="Class join code"
                className="font-mono tracking-wider bg-card"
              />
              <Button onClick={submitJoinCode} disabled={submittingJoinCode}>
                {submittingJoinCode ? "Sending..." : "Request Access"}
              </Button>
            </div>
            {latestJoinRequest && (
              <p className="mt-3 text-sm text-muted-foreground">
                Latest request: {latestJoinRequest.batch_name} ·{" "}
                {latestJoinRequest.batch_level} · {latestJoinRequest.status}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Card className="border-primary/30 shadow-md bg-gradient-to-br from-card to-primary/5 flex flex-col group hover:shadow-lg transition-all duration-300">
          <CardHeader>
            <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center mb-3">
              <Edit3 className="w-5 h-5 text-primary" />
            </div>
            <CardTitle className="text-xl">Free Writing</CardTitle>
            <CardDescription>
              Practice without a specific writing task
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            <p className="text-sm text-muted-foreground">
              Have something specific in mind? Write about your day, a recent
              trip, or just paste text you want to check.
            </p>
          </CardContent>
          <CardFooter>
            <Button
              className="w-full shadow-sm"
              disabled={!selectedBatchId}
              onClick={() =>
                selectedBatchId &&
                setLocation(`/student/write?mode=free&batch=${selectedBatchId}`)
              }
            >
              Start Free Writing
            </Button>
          </CardFooter>
        </Card>

        {loading ? (
          <Card>
            <CardContent
              className="py-10 text-center text-muted-foreground"
              role="status"
            >
              Loading assigned writing tasks...
            </CardContent>
          </Card>
        ) : error ? null : filteredQuestions.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center">
              <h2 className="text-lg font-semibold mb-2">
                {batchAssignments.length > 1 && !selectedBatchId
                  ? "Choose a class to see its writing tasks"
                  : "No assigned writing tasks yet"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {batchAssignments.length > 1 && !selectedBatchId
                  ? "Your writing is always attached to the class you select."
                  : "Your teacher can add writing tasks for this class."}
              </p>
            </CardContent>
          </Card>
        ) : (
          filteredQuestions.map((question, i) => {
            const presentation = getStudentTaskPresentation(
              question.task_state,
            );
            const latestSubmissionId = question.latest_submission_id;

            return (
              <Card
                key={`${question.batch_id}:${question.source}:${question.id}`}
                className="flex flex-col group hover:shadow-md transition-all duration-300 animate-in slide-in-from-bottom-4"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <CardHeader className="pb-4">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex flex-wrap gap-2">
                      <Badge
                        variant="secondary"
                        className="bg-secondary text-secondary-foreground"
                      >
                        {question.level}
                      </Badge>
                      {question.source === "global" && (
                        <Badge variant="outline">Global Task</Badge>
                      )}
                      {presentation.badge && (
                        <Badge
                          variant="outline"
                          className={presentation.className}
                        >
                          {presentation.badge}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md">
                      <Clock className="w-3 h-3 mr-1" />
                      {question.estimated_minutes
                        ? `${question.estimated_minutes} mins`
                        : "flex"}
                    </div>
                  </div>
                  <CardTitle className="text-lg line-clamp-2">
                    {question.title}
                  </CardTitle>
                  <CardDescription className="text-xs font-medium text-primary">
                    Topic: {question.topic}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 pb-4">
                  <PromptText
                    prompt={question.prompt}
                    preview
                    className="text-sm text-foreground line-clamp-3 mb-4"
                  />
                  <div className="text-xs text-muted-foreground bg-accent/10 text-accent-foreground border border-accent/20 px-3 py-2 rounded-md inline-block">
                    {getWordGuidance(question)}
                  </div>
                </CardContent>
                <CardFooter>
                  <Button
                    variant="outline"
                    className="w-full group-hover:bg-primary group-hover:text-primary-foreground group-hover:border-primary transition-colors"
                    onClick={() =>
                      latestSubmissionId
                        ? setLocation(
                            `/student/submission/${latestSubmissionId}`,
                          )
                        : startWritingTask(question)
                    }
                  >
                    {presentation.action}
                  </Button>
                </CardFooter>
              </Card>
            );
          })
        )}
      </div>

      {realQuestionPage && realQuestionPage.total_count > 0 && (
        <nav
          className="mt-6 flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
          aria-label="Writing task pages"
        >
          <p role="status">
            Showing {(questionPageNumber - 1) * realQuestionPage.page_size + 1}
            {"–"}
            {Math.min(
              (questionPageNumber - 1) * realQuestionPage.page_size +
                realQuestionPage.returned_count,
              realQuestionPage.total_count,
            )}{" "}
            of {realQuestionPage.total_count} tasks
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Previous writing task page"
              disabled={
                questionCursorTrail.length === 1 || questionsQuery.isFetching
              }
              onClick={() =>
                setQuestionCursorTrail((current) => current.slice(0, -1))
              }
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Next writing task page"
              disabled={!realQuestionPage.has_more || questionsQuery.isFetching}
              onClick={() => {
                if (!realQuestionPage.next_cursor) return;
                setQuestionCursorTrail((current) => [
                  ...current,
                  realQuestionPage.next_cursor,
                ]);
              }}
            >
              Next
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
