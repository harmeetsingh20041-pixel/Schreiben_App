import { useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PromptText } from "@/components/prompt-text";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Search,
  Plus,
  Edit,
  FileText,
  Globe2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  formatErrorMessage,
  formatTaskType,
  LEVEL_OPTIONS,
  TASK_TYPE_OPTIONS,
  type QuestionTaskType,
  type WorkspaceLevel,
} from "@/lib/workspaceData";
import {
  createWorkspaceQuestion,
  listTeacherQuestionBankPage,
  setQuestionActive,
  TEACHER_QUESTION_BANK_PAGE_SIZE,
  TEACHER_TASK_PROMPT_MAX_CHARACTERS,
  updateWorkspaceQuestion,
  type TeacherQuestionBankCursor,
  type WorkspaceQuestion,
} from "@/services/questionService";
import { appQueryKeys } from "@/lib/appQueryKeys";
import { Link } from "wouter";

interface QuestionFormState {
  title: string;
  level: WorkspaceLevel;
  topic: string;
  task_type: QuestionTaskType;
  prompt: string;
  expected_word_min: string;
  expected_word_max: string;
  estimated_minutes: string;
  is_active: boolean;
}

const initialForm: QuestionFormState = {
  title: "",
  level: "A1",
  topic: "",
  task_type: "writing",
  prompt: "",
  expected_word_min: "",
  expected_word_max: "",
  estimated_minutes: "",
  is_active: true,
};

function levelBadgeClass(level: string) {
  const classes: Record<string, string> = {
    A1: "border-green-300 text-green-700 bg-green-50",
    A2: "border-blue-300 text-blue-700 bg-blue-50",
    B1: "border-violet-300 text-violet-700 bg-violet-50",
    B2: "border-amber-300 text-amber-700 bg-amber-50",
  };
  return classes[level] ?? "bg-muted";
}

function toNumberOrNull(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function wordRange(question: WorkspaceQuestion) {
  if (question.expected_word_min && question.expected_word_max) {
    return `${question.expected_word_min}-${question.expected_word_max}`;
  }
  if (question.expected_word_min) return `${question.expected_word_min}+`;
  if (question.expected_word_max) return `up to ${question.expected_word_max}`;
  return "Flexible";
}

export default function TeacherQuestions() {
  const { activeWorkspaceId: workspaceId, user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [questionSource, setQuestionSource] = useState<"global" | "workspace">(
    "workspace",
  );
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [topicFilter, setTopicFilter] = useState("all");
  const [taskTypeFilter, setTaskTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "inactive"
  >("active");
  const [questionCursorTrail, setQuestionCursorTrail] = useState<
    Array<TeacherQuestionBankCursor | null>
  >([null]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [savingQuestion, setSavingQuestion] = useState(false);
  const [editingQuestion, setEditingQuestion] =
    useState<WorkspaceQuestion | null>(null);
  const [formData, setFormData] = useState<QuestionFormState>(initialForm);
  const dialogOpenerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    setQuestionCursorTrail([null]);
  }, [
    debouncedSearch,
    levelFilter,
    questionSource,
    statusFilter,
    taskTypeFilter,
    topicFilter,
    workspaceId,
  ]);

  const questionCursor =
    questionCursorTrail[questionCursorTrail.length - 1] ?? null;
  const questionPageIndex = questionCursorTrail.length - 1;

  const queryEnabled = Boolean(user) && Boolean(workspaceId);
  const questionBankQuery = useQuery({
    queryKey: appQueryKeys.teacherQuestionBankPage({
      workspaceId: workspaceId ?? "inactive-workspace",
      source: questionSource,
      search: debouncedSearch,
      level: levelFilter === "all" ? null : levelFilter,
      topic: topicFilter === "all" ? null : topicFilter,
      taskType: taskTypeFilter === "all" ? null : taskTypeFilter,
      status: statusFilter,
      pageSize: TEACHER_QUESTION_BANK_PAGE_SIZE,
      cursor: questionCursor,
    }),
    queryFn: () =>
      listTeacherQuestionBankPage({
        workspaceId: workspaceId!,
        source: questionSource,
        search: debouncedSearch,
        level: levelFilter === "all" ? null : (levelFilter as WorkspaceLevel),
        topic: topicFilter === "all" ? null : topicFilter,
        taskType:
          taskTypeFilter === "all"
            ? null
            : (taskTypeFilter as QuestionTaskType),
        status: statusFilter,
        pageSize: TEACHER_QUESTION_BANK_PAGE_SIZE,
        cursor: questionCursor,
      }),
    enabled: queryEnabled,
    placeholderData: keepPreviousData,
  });

  const loadQuestions = async () => {
    if (queryEnabled) await questionBankQuery.refetch();
  };

  const isGlobalBank = questionSource === "global";
  const questions = questionBankQuery.data?.items ?? [];

  const topics = useMemo(
    () => questionBankQuery.data?.available_topics ?? [],
    [questionBankQuery.data?.available_topics],
  );

  const filteredQuestions = questions;
  const loading =
    queryEnabled &&
    (questionBankQuery.isPending || questionBankQuery.isPlaceholderData);
  const error = !workspaceId
    ? "Select or create a workspace before managing writing tasks."
    : questionBankQuery.isError
      ? formatErrorMessage(questionBankQuery.error, "Unable to load questions.")
      : null;
  const hasActiveFilters = Boolean(
    debouncedSearch ||
    levelFilter !== "all" ||
    topicFilter !== "all" ||
    taskTypeFilter !== "all" ||
    statusFilter !== "all",
  );

  const handleOpenDialog = (
    question?: WorkspaceQuestion,
    opener?: HTMLButtonElement | null,
  ) => {
    dialogOpenerRef.current =
      opener ??
      (document.activeElement instanceof HTMLButtonElement
        ? document.activeElement
        : null);
    if (question) {
      setEditingQuestion(question);
      setFormData({
        title: question.title,
        level: question.level,
        topic: question.topic,
        task_type: question.task_type,
        prompt: question.prompt,
        expected_word_min: question.expected_word_min?.toString() ?? "",
        expected_word_max: question.expected_word_max?.toString() ?? "",
        estimated_minutes: question.estimated_minutes?.toString() ?? "",
        is_active: question.is_active,
      });
    } else {
      setEditingQuestion(null);
      setFormData(initialForm);
    }
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    if (
      !formData.title.trim() ||
      !formData.prompt.trim() ||
      !formData.topic.trim()
    ) {
      toast({
        title: "Writing task details required",
        description: "Add a title, topic, and task text.",
      });
      return;
    }

    if (
      [...formData.prompt.trim()].length > TEACHER_TASK_PROMPT_MAX_CHARACTERS
    ) {
      toast({
        title: "Writing task text is too long",
        description: "Use no more than 4,000 characters.",
      });
      return;
    }

    if (!workspaceId || !user) return;
    try {
      setSavingQuestion(true);
      const input = {
        title: formData.title.trim(),
        prompt: formData.prompt.trim(),
        level: formData.level,
        topic: formData.topic.trim(),
        task_type: formData.task_type,
        expected_word_min: toNumberOrNull(formData.expected_word_min),
        expected_word_max: toNumberOrNull(formData.expected_word_max),
        estimated_minutes: toNumberOrNull(formData.estimated_minutes),
        is_active: formData.is_active,
      };

      if (editingQuestion) {
        await updateWorkspaceQuestion(workspaceId, editingQuestion.id, input);
      } else {
        await createWorkspaceQuestion(workspaceId, user.id, input);
      }
      setIsDialogOpen(false);
      setQuestionCursorTrail([null]);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.teacherQuestionBank(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.workspaceQuestionCount(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.teacherDashboard(workspaceId),
        }),
      ]);
      toast({
        title: editingQuestion
          ? "Writing task updated"
          : "Writing task created",
      });
    } catch (saveError) {
      toast({
        title: "Could not save writing task",
        description: formatErrorMessage(saveError, "Please try again."),
      });
    } finally {
      setSavingQuestion(false);
    }
  };

  const toggleActive = async (question: WorkspaceQuestion) => {
    if (!workspaceId) return;
    try {
      await setQuestionActive(workspaceId, question.id, !question.is_active);
      setQuestionCursorTrail([null]);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.teacherQuestionBank(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.workspaceQuestionCount(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: appQueryKeys.teacherDashboard(workspaceId),
        }),
      ]);
    } catch (toggleError) {
      toast({
        title: "Could not update writing task",
        description: formatErrorMessage(toggleError, "Please try again."),
      });
    }
  };

  const resetFilters = () => {
    setSearch("");
    setLevelFilter("all");
    setTopicFilter("all");
    setTaskTypeFilter("all");
    setStatusFilter("all");
    setQuestionCursorTrail([null]);
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Writing Task Bank
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage writing tasks for your students.
          </p>
        </div>
        {!isGlobalBank && (
          <Button
            onClick={(event) =>
              handleOpenDialog(undefined, event.currentTarget)
            }
            className="w-full shadow-md sm:w-auto"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create Workspace Writing Task
          </Button>
        )}
      </div>

      <Tabs
        value={questionSource}
        onValueChange={(value) => {
          setQuestionSource(value as "global" | "workspace");
          setTopicFilter("all");
          setQuestionCursorTrail([null]);
        }}
        className="mb-6"
      >
        <TabsList className="w-full max-w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="global" className="shrink-0">
            <Globe2 className="mr-2 h-4 w-4" />
            Global Writing Tasks
          </TabsTrigger>
          <TabsTrigger value="workspace" className="shrink-0">
            <FileText className="mr-2 h-4 w-4" />
            My Workspace Writing Tasks
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_160px_180px_180px_160px] gap-3 mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            aria-label="Search writing tasks"
            placeholder="Search writing tasks..."
            className="pl-9 bg-card"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger
            className="bg-card"
            aria-label="Filter writing tasks by level"
          >
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            {LEVEL_OPTIONS.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={topicFilter} onValueChange={setTopicFilter}>
          <SelectTrigger
            className="bg-card"
            aria-label="Filter writing tasks by topic"
          >
            <SelectValue placeholder="Topic" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Topics</SelectItem>
            {topics.map((topic) => (
              <SelectItem key={topic} value={topic}>
                {topic}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={taskTypeFilter} onValueChange={setTaskTypeFilter}>
          <SelectTrigger
            className="bg-card"
            aria-label="Filter writing tasks by task type"
          >
            <SelectValue placeholder="Task type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Task Types</SelectItem>
            {TASK_TYPE_OPTIONS.map((taskType) => (
              <SelectItem key={taskType} value={taskType}>
                {formatTaskType(taskType)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            setStatusFilter(value as "all" | "active" | "inactive")
          }
        >
          <SelectTrigger
            className="bg-card"
            aria-label="Filter writing tasks by status"
          >
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="all">All Statuses</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <Card
          className="mb-6 border-destructive/30 bg-destructive/5"
          role="alert"
        >
          <CardContent className="flex flex-col items-start gap-4 py-5 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            {workspaceId ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void loadQuestions()}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Try again
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href="/teacher/onboarding">Open workspace setup</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {error ? null : loading ? (
        <Card>
          <CardContent
            className="py-10 text-center text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin" />
            Loading writing tasks...
          </CardContent>
        </Card>
      ) : filteredQuestions.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-14 text-center">
            <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-muted">
              <FileText className="h-5 w-5" />
            </div>
            <h2 className="text-xl font-semibold mb-2">
              {hasActiveFilters
                ? "No writing tasks match these filters"
                : isGlobalBank
                  ? "No shared writing tasks are available"
                  : "Add your first writing task"}
            </h2>
            <p className="text-muted-foreground mb-5">
              {hasActiveFilters
                ? "Change or clear the filters to see other writing tasks."
                : isGlobalBank
                  ? "Refresh the shared bank. If it stays empty, ask an administrator to check the approved content bank."
                  : "Create writing tasks for A1, A2, B1, or B2 students."}
            </p>
            <div className="flex flex-col justify-center gap-2 sm:flex-row">
              {hasActiveFilters && (
                <Button type="button" variant="outline" onClick={resetFilters}>
                  Show all writing tasks
                </Button>
              )}
              {!hasActiveFilters && isGlobalBank && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void loadQuestions()}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh shared bank
                </Button>
              )}
              {!hasActiveFilters && !isGlobalBank && (
                <Button
                  onClick={(event) =>
                    handleOpenDialog(undefined, event.currentTarget)
                  }
                >
                  Create Writing Task
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredQuestions.map((question, i) => (
              <Card
                key={question.id}
                className={`flex flex-col ${!question.is_active && "opacity-60"} transition-all animate-in slide-in-from-bottom-4`}
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <CardHeader className="pb-3">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex gap-2">
                      <Badge
                        variant="outline"
                        className={levelBadgeClass(question.level)}
                      >
                        {question.level}
                      </Badge>
                      <Badge variant="secondary">
                        {formatTaskType(question.task_type)}
                      </Badge>
                      {question.source === "global" && (
                        <Badge variant="outline">Global Task</Badge>
                      )}
                    </div>
                    {!isGlobalBank && (
                      <Switch
                        checked={question.is_active}
                        onCheckedChange={() => toggleActive(question)}
                        aria-label={`${question.is_active ? "Deactivate" : "Activate"} writing task ${question.title}`}
                      />
                    )}
                  </div>
                  <CardTitle
                    className="text-lg line-clamp-1"
                    title={question.title}
                  >
                    {question.title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex-1 pb-4">
                  <p className="text-xs text-primary font-medium mb-2">
                    Topic: {question.topic}
                  </p>
                  <PromptText
                    prompt={question.prompt}
                    preview
                    className="text-sm text-foreground line-clamp-3 mb-3"
                  />
                  <div className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded inline-block">
                    {wordRange(question)} words • ~
                    {question.estimated_minutes ?? "flex"} mins
                  </div>
                </CardContent>
                <CardFooter className="border-t border-border pt-4 bg-muted/10 flex justify-end gap-2">
                  {isGlobalBank ? (
                    <p className="text-xs text-muted-foreground">
                      Read-only shared writing task
                    </p>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(event) =>
                        handleOpenDialog(question, event.currentTarget)
                      }
                    >
                      <Edit className="w-4 h-4 mr-2" /> Edit
                    </Button>
                  )}
                </CardFooter>
              </Card>
            ))}
          </div>
          {questionBankQuery.data && questionBankQuery.data.total_count > 0 && (
            <nav
              className="mt-8 flex flex-col gap-3 border-t pt-5 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
              aria-label="Writing task pages"
            >
              <p role="status" aria-live="polite">
                Showing{" "}
                {questionPageIndex * TEACHER_QUESTION_BANK_PAGE_SIZE + 1}–
                {Math.min(
                  questionPageIndex * TEACHER_QUESTION_BANK_PAGE_SIZE +
                    questionBankQuery.data.returned_count,
                  questionBankQuery.data.total_count,
                )}{" "}
                of {questionBankQuery.data.total_count} writing tasks
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Previous writing tasks page"
                  disabled={
                    questionPageIndex === 0 || questionBankQuery.isFetching
                  }
                  onClick={() =>
                    setQuestionCursorTrail((current) =>
                      current.length > 1 ? current.slice(0, -1) : current,
                    )
                  }
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Next writing tasks page"
                  disabled={
                    !questionBankQuery.data.has_more ||
                    questionBankQuery.isFetching
                  }
                  onClick={() => {
                    if (questionBankQuery.data?.next_cursor != null) {
                      setQuestionCursorTrail((current) => [
                        ...current,
                        questionBankQuery.data!.next_cursor,
                      ]);
                    }
                  }}
                >
                  Next
                </Button>
              </div>
            </nav>
          )}
        </>
      )}

      <Dialog
        open={isDialogOpen}
        onOpenChange={(open) => {
          if (!savingQuestion) setIsDialogOpen(open);
        }}
      >
        <DialogContent
          className="sm:max-w-[640px]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            dialogOpenerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editingQuestion
                ? "Edit Writing Task"
                : "Create New Writing Task"}
            </DialogTitle>
            <DialogDescription>
              Set the level, prompt, and practice limits students will see.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <fieldset className="grid gap-4 py-2" disabled={savingQuestion}>
              <legend className="sr-only">Writing task details</legend>
              <div className="space-y-2">
                <Label htmlFor="question-title">Title</Label>
                <Input
                  id="question-title"
                  value={formData.title}
                  onChange={(event) =>
                    setFormData({ ...formData, title: event.target.value })
                  }
                  placeholder="e.g. Einladung zur Party"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="question-level">Level</Label>
                  <Select
                    value={formData.level}
                    onValueChange={(value) =>
                      setFormData({
                        ...formData,
                        level: value as WorkspaceLevel,
                      })
                    }
                  >
                    <SelectTrigger id="question-level">
                      <SelectValue placeholder="Select level" />
                    </SelectTrigger>
                    <SelectContent>
                      {LEVEL_OPTIONS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="question-task-type">Task type</Label>
                  <Select
                    value={formData.task_type}
                    onValueChange={(value) =>
                      setFormData({
                        ...formData,
                        task_type: value as QuestionTaskType,
                      })
                    }
                  >
                    <SelectTrigger id="question-task-type">
                      <SelectValue placeholder="Select task type" />
                    </SelectTrigger>
                    <SelectContent>
                      {TASK_TYPE_OPTIONS.map((taskType) => (
                        <SelectItem key={taskType} value={taskType}>
                          {formatTaskType(taskType)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="question-topic">Topic</Label>
                <Input
                  id="question-topic"
                  value={formData.topic}
                  onChange={(event) =>
                    setFormData({ ...formData, topic: event.target.value })
                  }
                  placeholder="e.g. Einladung, Alltag, Argumentation"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="question-prompt">Task Text</Label>
                <Textarea
                  id="question-prompt"
                  value={formData.prompt}
                  onChange={(event) =>
                    setFormData({ ...formData, prompt: event.target.value })
                  }
                  placeholder="Schreiben Sie..."
                  rows={4}
                  maxLength={TEACHER_TASK_PROMPT_MAX_CHARACTERS}
                  aria-describedby="question-prompt-count"
                />
                <p
                  id="question-prompt-count"
                  className="text-right text-xs text-muted-foreground"
                >
                  {[...formData.prompt].length.toLocaleString()}/
                  {TEACHER_TASK_PROMPT_MAX_CHARACTERS.toLocaleString()}
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="word-min">Min words</Label>
                  <Input
                    id="word-min"
                    type="number"
                    min="0"
                    value={formData.expected_word_min}
                    onChange={(event) =>
                      setFormData({
                        ...formData,
                        expected_word_min: event.target.value,
                      })
                    }
                    placeholder="80"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="word-max">Max words</Label>
                  <Input
                    id="word-max"
                    type="number"
                    min="0"
                    value={formData.expected_word_max}
                    onChange={(event) =>
                      setFormData({
                        ...formData,
                        expected_word_max: event.target.value,
                      })
                    }
                    placeholder="120"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="estimated-minutes">Minutes</Label>
                  <Input
                    id="estimated-minutes"
                    type="number"
                    min="0"
                    value={formData.estimated_minutes}
                    onChange={(event) =>
                      setFormData({
                        ...formData,
                        estimated_minutes: event.target.value,
                      })
                    }
                    placeholder="20"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <Label htmlFor="question-active">Active writing task</Label>
                <Switch
                  id="question-active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, is_active: checked })
                  }
                />
              </div>
            </fieldset>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={savingQuestion}
                onClick={() => setIsDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={savingQuestion}
                aria-busy={savingQuestion}
              >
                {savingQuestion && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {savingQuestion
                  ? "Saving writing task..."
                  : "Save Writing Task"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
