import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PromptText } from "@/components/prompt-text";
import { Search, Clock, Edit3, KeyRound } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage, LEVEL_OPTIONS } from "@/lib/workspaceData";
import { listStudentAssignedQuestions, type WorkspaceQuestion } from "@/services/questionService";
import { listStudentSubmissions, type WritingSubmission } from "@/services/submissionService";
import { listMyBatchAssignments, listMyBatchJoinRequests, requestJoinBatchByCode, type BatchJoinRequest, type StudentBatchAssignment } from "@/services/studentService";
import { MOCK_QUESTIONS } from "@/data/mockData";

function mockToWorkspaceQuestion(question: (typeof MOCK_QUESTIONS)[number]): WorkspaceQuestion {
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

function wordRange(question: WorkspaceQuestion) {
  if (question.expected_word_min && question.expected_word_max) {
    return `${question.expected_word_min}-${question.expected_word_max}`;
  }
  if (question.expected_word_min) return `${question.expected_word_min}+`;
  if (question.expected_word_max) return `up to ${question.expected_word_max}`;
  return "Flexible";
}

const completedSubmissionStatuses = new Set(["submitted", "checked", "needs_review"]);

function questionSubmissionKey(question: WorkspaceQuestion) {
  return `${question.source}:${question.id}`;
}

function submissionQuestionKey(submission: WritingSubmission) {
  if (submission.question_source === "global_question" && submission.global_question_id) {
    return `global:${submission.global_question_id}`;
  }
  if (submission.question_source === "workspace_question" && submission.question_id) {
    return `workspace:${submission.question_id}`;
  }
  return null;
}

export default function StudentQuestions() {
  const { authMode, user } = useAuth();
  const { toast } = useToast();
  const useRealData = authMode === "supabase" && Boolean(user);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<string>("All");
  const [realQuestions, setRealQuestions] = useState<WorkspaceQuestion[]>([]);
  const [realSubmissions, setRealSubmissions] = useState<WritingSubmission[]>([]);
  const [batchAssignments, setBatchAssignments] = useState<StudentBatchAssignment[]>([]);
  const [joinRequests, setJoinRequests] = useState<BatchJoinRequest[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [submittingJoinCode, setSubmittingJoinCode] = useState(false);
  const [loading, setLoading] = useState(useRealData);
  const [error, setError] = useState<string | null>(null);
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!useRealData || !user) return;

    async function loadQuestions() {
      try {
        setLoading(true);
        setError(null);
        const [nextQuestions, nextAssignments, nextJoinRequests, nextSubmissions] = await Promise.all([
          listStudentAssignedQuestions(user!.id),
          listMyBatchAssignments(user!.id),
          listMyBatchJoinRequests(user!.id),
          listStudentSubmissions(user!.id),
        ]);
        setRealQuestions(nextQuestions);
        setBatchAssignments(nextAssignments);
        setJoinRequests(nextJoinRequests);
        setRealSubmissions(nextSubmissions);
      } catch (loadError) {
        setError(formatErrorMessage(loadError, "Unable to load assigned prompts."));
      } finally {
        setLoading(false);
      }
    }

    void loadQuestions();
  }, [useRealData, user]);

  const reloadStudentData = async () => {
    if (!user) return;
    const [nextQuestions, nextAssignments, nextJoinRequests, nextSubmissions] = await Promise.all([
      listStudentAssignedQuestions(user.id),
      listMyBatchAssignments(user.id),
      listMyBatchJoinRequests(user.id),
      listStudentSubmissions(user.id),
    ]);
    setRealQuestions(nextQuestions);
    setBatchAssignments(nextAssignments);
    setJoinRequests(nextJoinRequests);
    setRealSubmissions(nextSubmissions);
  };

  const questions = useRealData ? realQuestions : MOCK_QUESTIONS.map(mockToWorkspaceQuestion);

  const filteredQuestions = useMemo(() => questions.filter((question) => {
    const query = search.toLowerCase();
    const matchesSearch =
      question.title.toLowerCase().includes(query) ||
      question.topic.toLowerCase().includes(query);
    const matchesLevel = levelFilter === "All" || question.level === levelFilter;
    return matchesSearch && matchesLevel && question.is_active;
  }), [levelFilter, questions, search]);

  const latestSubmissionByQuestion = useMemo(() => {
    const map = new Map<string, WritingSubmission>();
    for (const submission of realSubmissions) {
      if (!completedSubmissionStatuses.has(submission.status)) continue;
      const key = submissionQuestionKey(submission);
      if (key && !map.has(key)) map.set(key, submission);
    }
    return map;
  }, [realSubmissions]);

  const selectPrompt = (question: WorkspaceQuestion) => {
    sessionStorage.setItem(
      "gwc_selected_question",
      JSON.stringify({
        id: question.id,
        title: question.title,
        source: question.source,
        batch_id: question.batch_id,
        level: question.level,
        topic: question.topic,
        prompt: question.prompt,
        expected_word_range: wordRange(question),
        estimated_time: question.estimated_minutes ? `${question.estimated_minutes} mins` : "flexible",
        active: question.is_active,
      }),
    );
    setLocation(`/student/write?q=${question.id}`);
  };

  const submitJoinCode = async () => {
    if (!joinCode.trim()) {
      toast({ title: "Batch code required", description: "Enter the code your teacher shared." });
      return;
    }

    try {
      setSubmittingJoinCode(true);
      const result = await requestJoinBatchByCode(joinCode);
      await reloadStudentData();
      setJoinCode("");
      toast({
        title: result.status === "approved" ? "Joined batch" : "Request sent",
        description: result.status === "approved"
          ? `${result.batch_name} is ready.`
          : "Waiting for teacher approval.",
      });
    } catch (joinError) {
      toast({
        title: "Could not request batch",
        description: formatErrorMessage(joinError, "Check the code and try again."),
      });
    } finally {
      setSubmittingJoinCode(false);
    }
  };

  const latestJoinRequest = joinRequests[0];

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Practice Prompts</h1>
          <p className="text-muted-foreground mt-1">Choose a topic to practice your writing skills.</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-4 mb-8">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search topics..."
            className="pl-9 bg-card border-border shadow-sm"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {["All", ...LEVEL_OPTIONS].map((level) => (
            <Button
              key={level}
              variant={levelFilter === level ? "default" : "outline"}
              className={levelFilter === level
                ? "min-w-[4.5rem]"
                : "min-w-[4.5rem] bg-card text-foreground"}
              onClick={() => setLevelFilter(level)}
            >
              {level === "All" ? "All Levels" : level}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {useRealData && !loading && batchAssignments.length === 0 && (
        <Card className="mb-8 border-primary/25 bg-primary/5">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                <KeyRound className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle>Join your batch</CardTitle>
                <CardDescription>Enter the code your teacher shared. Most batches wait for teacher approval.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-3">
              <Input
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="Enter batch code"
                className="font-mono tracking-wider bg-card"
              />
              <Button onClick={submitJoinCode} disabled={submittingJoinCode}>
                {submittingJoinCode ? "Sending..." : "Request Access"}
              </Button>
            </div>
            {latestJoinRequest && (
              <p className="mt-3 text-sm text-muted-foreground">
                Latest request: {latestJoinRequest.batch_name} · {latestJoinRequest.batch_level} · {latestJoinRequest.status}
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
            <CardDescription>Practice without a specific prompt</CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            <p className="text-sm text-muted-foreground">
              Have something specific in mind? Write about your day, a recent trip, or just paste text you want to check.
            </p>
          </CardContent>
          <CardFooter>
            <Button className="w-full shadow-sm" onClick={() => setLocation("/student/write?mode=free")}>
              Start Free Writing
            </Button>
          </CardFooter>
        </Card>

        {loading ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">Loading assigned prompts...</CardContent>
          </Card>
        ) : filteredQuestions.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center">
              <h2 className="text-lg font-semibold mb-2">No assigned prompts yet</h2>
              <p className="text-sm text-muted-foreground">Your teacher can assign batches and prompts from the workspace.</p>
            </CardContent>
          </Card>
        ) : (
          filteredQuestions.map((question, i) => {
            const latestSubmission = useRealData
              ? latestSubmissionByQuestion.get(questionSubmissionKey(question))
              : null;

            return (
              <Card key={question.id} className="flex flex-col group hover:shadow-md transition-all duration-300 animate-in slide-in-from-bottom-4" style={{ animationDelay: `${i * 50}ms` }}>
                <CardHeader className="pb-4">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary" className="bg-secondary text-secondary-foreground">
                        {question.level}
                      </Badge>
                      {question.source === "global" && <Badge variant="outline">Global</Badge>}
                      {latestSubmission && (
                        <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                          Submitted
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md">
                      <Clock className="w-3 h-3 mr-1" />
                      {question.estimated_minutes ? `${question.estimated_minutes} mins` : "flex"}
                    </div>
                  </div>
                  <CardTitle className="text-lg line-clamp-2">{question.title}</CardTitle>
                  <CardDescription className="text-xs font-medium text-primary">Topic: {question.topic}</CardDescription>
                </CardHeader>
                <CardContent className="flex-1 pb-4">
                  <PromptText prompt={question.prompt} preview className="text-sm text-foreground line-clamp-3 mb-4" />
                  <div className="text-xs text-muted-foreground bg-accent/10 text-accent-foreground border border-accent/20 px-3 py-2 rounded-md inline-block">
                    Expected: {wordRange(question)} words
                  </div>
                </CardContent>
                <CardFooter>
                  <Button
                    variant="outline"
                    className="w-full group-hover:bg-primary group-hover:text-primary-foreground group-hover:border-primary transition-colors"
                    onClick={() => latestSubmission ? setLocation(`/student/submission/${latestSubmission.id}`) : selectPrompt(question)}
                  >
                    {latestSubmission ? "View Submission" : "Select Prompt"}
                  </Button>
                </CardFooter>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
