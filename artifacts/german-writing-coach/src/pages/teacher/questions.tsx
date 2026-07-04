import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Search, Plus, Edit, FileText, Globe2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage, formatTaskType, getActiveWorkspaceId, LEVEL_OPTIONS, TASK_TYPE_OPTIONS, type QuestionTaskType, type WorkspaceLevel } from "@/lib/workspaceData";
import { createWorkspaceQuestion, listGlobalQuestions, listWorkspaceQuestions, setQuestionActive, updateWorkspaceQuestion, type WorkspaceQuestion } from "@/services/questionService";
import { MOCK_QUESTIONS } from "@/data/mockData";
import { Question } from "@/types";

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

function mockToWorkspaceQuestion(question: Question): WorkspaceQuestion {
  const [min, max] = question.expected_word_range.split("-").map((value) => Number(value));
  return {
    id: question.id,
    workspace_id: "mock",
    source: "workspace",
    batch_id: null,
    title: question.title,
    prompt: question.prompt,
    level: question.level,
    topic: question.topic,
    task_type: "writing",
    expected_word_min: Number.isFinite(min) ? min : null,
    expected_word_max: Number.isFinite(max) ? max : null,
    estimated_minutes: Number.parseInt(question.estimated_time, 10) || null,
    is_active: question.active,
    created_by: null,
    created_at: "",
    updated_at: "",
  };
}

export default function TeacherQuestions() {
  const { authMode, user, workspaceMemberships } = useAuth();
  const { toast } = useToast();
  const workspaceId = getActiveWorkspaceId(workspaceMemberships);
  const useRealData = authMode === "supabase" && Boolean(user);

  const [realQuestions, setRealQuestions] = useState<WorkspaceQuestion[]>([]);
  const [globalQuestions, setGlobalQuestions] = useState<WorkspaceQuestion[]>([]);
  const [mockQuestions, setMockQuestions] = useState<Question[]>(MOCK_QUESTIONS);
  const [loading, setLoading] = useState(useRealData);
  const [error, setError] = useState<string | null>(null);
  const [questionSource, setQuestionSource] = useState<"global" | "workspace">("workspace");
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [topicFilter, setTopicFilter] = useState("all");
  const [taskTypeFilter, setTaskTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<WorkspaceQuestion | null>(null);
  const [formData, setFormData] = useState<QuestionFormState>(initialForm);

  const loadQuestions = async () => {
    if (!useRealData) return;
    if (!workspaceId) {
      setError("No workspace found. Create a workspace before managing questions.");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const [nextWorkspaceQuestions, nextGlobalQuestions] = await Promise.all([
        listWorkspaceQuestions(workspaceId),
        listGlobalQuestions(),
      ]);
      setRealQuestions(nextWorkspaceQuestions);
      setGlobalQuestions(nextGlobalQuestions);
    } catch (loadError) {
      setError(formatErrorMessage(loadError, "Unable to load questions."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadQuestions();
  }, [useRealData, workspaceId]);

  const isGlobalBank = useRealData && questionSource === "global";
  const questions = useRealData
    ? (isGlobalBank ? globalQuestions : realQuestions)
    : mockQuestions.map(mockToWorkspaceQuestion);

  const topics = useMemo(
    () => Array.from(new Set(questions.map((question) => question.topic).filter(Boolean))).sort(),
    [questions],
  );

  const filteredQuestions = questions.filter((question) => {
    const query = search.toLowerCase();
    const matchesSearch =
      question.title.toLowerCase().includes(query) ||
      question.topic.toLowerCase().includes(query) ||
      question.prompt.toLowerCase().includes(query);
    const matchesLevel = levelFilter === "all" || question.level === levelFilter;
    const matchesTopic = topicFilter === "all" || question.topic === topicFilter;
    const matchesTaskType = taskTypeFilter === "all" || question.task_type === taskTypeFilter;
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" ? question.is_active : !question.is_active);
    return matchesSearch && matchesLevel && matchesTopic && matchesTaskType && matchesStatus;
  });

  const handleOpenDialog = (question?: WorkspaceQuestion) => {
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
    if (!formData.title.trim() || !formData.prompt.trim() || !formData.topic.trim()) {
      toast({ title: "Prompt details required", description: "Add a title, topic, and prompt." });
      return;
    }

    if (useRealData) {
      if (!workspaceId || !user) return;
      try {
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
        await loadQuestions();
        toast({ title: editingQuestion ? "Prompt updated" : "Prompt created" });
      } catch (saveError) {
        toast({
          title: "Could not save prompt",
          description: formatErrorMessage(saveError, "Please try again."),
        });
      }
      return;
    }

    if (editingQuestion) {
      setMockQuestions((previous) =>
        previous.map((question) =>
          question.id === editingQuestion.id
            ? {
                ...question,
                title: formData.title,
                level: formData.level,
                topic: formData.topic,
                prompt: formData.prompt,
                expected_word_range: `${formData.expected_word_min || "0"}-${formData.expected_word_max || "0"}`,
                estimated_time: `${formData.estimated_minutes || "10"} mins`,
                active: formData.is_active,
              }
            : question,
        ),
      );
    } else {
      setMockQuestions((previous) => [
        ...previous,
        {
          id: `q${Date.now()}`,
          title: formData.title,
          level: formData.level,
          topic: formData.topic,
          prompt: formData.prompt,
          expected_word_range: `${formData.expected_word_min || "0"}-${formData.expected_word_max || "0"}`,
          estimated_time: `${formData.estimated_minutes || "10"} mins`,
          active: formData.is_active,
        },
      ]);
    }
    setIsDialogOpen(false);
  };

  const toggleActive = async (question: WorkspaceQuestion) => {
    if (useRealData) {
      if (!workspaceId) return;
      try {
        await setQuestionActive(workspaceId, question.id, !question.is_active);
        await loadQuestions();
      } catch (toggleError) {
        toast({
          title: "Could not update prompt",
          description: formatErrorMessage(toggleError, "Please try again."),
        });
      }
      return;
    }

    setMockQuestions((previous) =>
      previous.map((item) => item.id === question.id ? { ...item, active: !item.active } : item),
    );
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Question Bank</h1>
          <p className="text-muted-foreground mt-1">Manage writing prompts for your students.</p>
        </div>
        {!isGlobalBank && (
          <Button onClick={() => handleOpenDialog()} className="shadow-md">
            <Plus className="w-4 h-4 mr-2" />
            Create Workspace Prompt
          </Button>
        )}
      </div>

      {useRealData && (
        <Tabs value={questionSource} onValueChange={(value) => setQuestionSource(value as "global" | "workspace")} className="mb-6">
          <TabsList>
            <TabsTrigger value="global">
              <Globe2 className="mr-2 h-4 w-4" />
              Global Bank
            </TabsTrigger>
            <TabsTrigger value="workspace">
              <FileText className="mr-2 h-4 w-4" />
              My Workspace Prompts
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[1fr_160px_180px_180px_160px] gap-3 mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search prompts..."
            className="pl-9 bg-card"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger className="bg-card">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            {LEVEL_OPTIONS.map((level) => (
              <SelectItem key={level} value={level}>{level}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={topicFilter} onValueChange={setTopicFilter}>
          <SelectTrigger className="bg-card">
            <SelectValue placeholder="Topic" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Topics</SelectItem>
            {topics.map((topic) => (
              <SelectItem key={topic} value={topic}>{topic}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={taskTypeFilter} onValueChange={setTaskTypeFilter}>
          <SelectTrigger className="bg-card">
            <SelectValue placeholder="Task type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Task Types</SelectItem>
            {TASK_TYPE_OPTIONS.map((taskType) => (
              <SelectItem key={taskType} value={taskType}>{formatTaskType(taskType)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="bg-card">
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
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {loading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">Loading questions...</CardContent>
        </Card>
      ) : filteredQuestions.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-14 text-center">
            <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-muted">
              <FileText className="h-5 w-5" />
            </div>
            <h2 className="text-xl font-semibold mb-2">
              {isGlobalBank ? "No global questions yet" : "Add your first writing question"}
            </h2>
            <p className="text-muted-foreground mb-5">
              {isGlobalBank
                ? "Global A1-B2 prompts will appear here after the real bank is imported."
                : "Create prompts for A1, A2, B1, or B2 students."}
            </p>
            {!isGlobalBank && <Button onClick={() => handleOpenDialog()}>Create Prompt</Button>}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredQuestions.map((question, i) => (
            <Card key={question.id} className={`flex flex-col ${!question.is_active && "opacity-60"} transition-all animate-in slide-in-from-bottom-4`} style={{ animationDelay: `${i * 50}ms` }}>
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex gap-2">
                    <Badge variant="outline" className={levelBadgeClass(question.level)}>{question.level}</Badge>
                    <Badge variant="secondary">{formatTaskType(question.task_type)}</Badge>
                    {question.source === "global" && <Badge variant="outline">Global</Badge>}
                  </div>
                  {!isGlobalBank && <Switch checked={question.is_active} onCheckedChange={() => toggleActive(question)} />}
                </div>
                <CardTitle className="text-lg line-clamp-1" title={question.title}>{question.title}</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 pb-4">
                <p className="text-xs text-primary font-medium mb-2">Topic: {question.topic}</p>
                <p className="text-sm text-foreground line-clamp-3 mb-3">{question.prompt}</p>
                <div className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded inline-block">
                  {wordRange(question)} words • ~{question.estimated_minutes ?? "flex"} mins
                </div>
              </CardContent>
              <CardFooter className="border-t border-border pt-4 bg-muted/10 flex justify-end gap-2">
                {isGlobalBank ? (
                  <p className="text-xs text-muted-foreground">Read-only shared prompt</p>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => handleOpenDialog(question)}>
                    <Edit className="w-4 h-4 mr-2" /> Edit
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>{editingQuestion ? "Edit Prompt" : "Create New Prompt"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="question-title">Title</Label>
              <Input
                id="question-title"
                value={formData.title}
                onChange={(event) => setFormData({ ...formData, title: event.target.value })}
                placeholder="e.g. Einladung zur Party"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Level</Label>
                <Select value={formData.level} onValueChange={(value) => setFormData({ ...formData, level: value as WorkspaceLevel })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select level" />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVEL_OPTIONS.map((level) => (
                      <SelectItem key={level} value={level}>{level}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Task type</Label>
                <Select value={formData.task_type} onValueChange={(value) => setFormData({ ...formData, task_type: value as QuestionTaskType })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select task type" />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_TYPE_OPTIONS.map((taskType) => (
                      <SelectItem key={taskType} value={taskType}>{formatTaskType(taskType)}</SelectItem>
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
                onChange={(event) => setFormData({ ...formData, topic: event.target.value })}
                placeholder="e.g. Einladung, Alltag, Argumentation"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="question-prompt">Prompt</Label>
              <Textarea
                id="question-prompt"
                value={formData.prompt}
                onChange={(event) => setFormData({ ...formData, prompt: event.target.value })}
                placeholder="Schreiben Sie..."
                rows={4}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="word-min">Min words</Label>
                <Input
                  id="word-min"
                  type="number"
                  min="0"
                  value={formData.expected_word_min}
                  onChange={(event) => setFormData({ ...formData, expected_word_min: event.target.value })}
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
                  onChange={(event) => setFormData({ ...formData, expected_word_max: event.target.value })}
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
                  onChange={(event) => setFormData({ ...formData, estimated_minutes: event.target.value })}
                  placeholder="20"
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <Label htmlFor="question-active">Active prompt</Label>
              <Switch
                id="question-active"
                checked={formData.is_active}
                onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave}>Save Prompt</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
