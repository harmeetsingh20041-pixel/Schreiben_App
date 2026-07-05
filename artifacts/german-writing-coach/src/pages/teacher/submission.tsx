import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PromptText } from "@/components/prompt-text";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { SubmissionReview } from "@/components/submission-review";
import { RealFeedbackReview } from "@/components/real-feedback-review";
import { getSubmissionStatusMeta, getSubmissionStudentSummary, SubmissionStatusBadge } from "@/components/submission-status-badge";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage, getActiveWorkspaceId } from "@/lib/workspaceData";
import { getSubmissionFeedback, getTeacherSubmissionDetail, prepareWritingFeedback, type WritingFeedback, type WritingSubmission } from "@/services/submissionService";
import { useToast } from "@/hooks/use-toast";
import { MOCK_SUBMISSIONS, MOCK_STUDENTS, MOCK_QUESTIONS } from "@/data/mockData";

function formatSubmissionDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function TeacherSubmissionDetail() {
  const { id } = useParams();
  const { authMode, user, workspaceMemberships } = useAuth();
  const { toast } = useToast();
  const useRealData = authMode === "supabase" && Boolean(user);
  const workspaceId = getActiveWorkspaceId(workspaceMemberships);
  const [realSubmission, setRealSubmission] = useState<WritingSubmission | null>(null);
  const [feedback, setFeedback] = useState<WritingFeedback | null>(null);
  const [loading, setLoading] = useState(useRealData);
  const [preparingFeedback, setPreparingFeedback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const submission = MOCK_SUBMISSIONS.find(s => s.id === id) || MOCK_SUBMISSIONS[0];
  const student = MOCK_STUDENTS.find(s => s.id === submission.studentId);
  const question = MOCK_QUESTIONS.find(q => q.id === submission.questionId);

  const emptyFeedbackTitle = realSubmission ? getSubmissionStatusMeta(realSubmission.status).label : "Feedback pending";
  const emptyFeedbackMessage = realSubmission?.status === "checked"
    ? "Feedback is marked ready, but line-by-line details are not available. Refresh this page before preparing feedback again."
    : realSubmission?.status === "failed"
      ? "Feedback could not be prepared. You can try preparing it again."
      : realSubmission
        ? getSubmissionStudentSummary(realSubmission.status)
        : "Prepare line-by-line feedback for this submitted writing.";
  const canPrepareFeedback = Boolean(realSubmission && !["draft", "checking", "checked"].includes(realSubmission.status));

  async function loadSubmission() {
    if (!useRealData || !workspaceId || !id) return;
    try {
      setLoading(true);
      setError(null);
      const nextSubmission = await getTeacherSubmissionDetail(workspaceId, id);
      setRealSubmission(nextSubmission);
      setFeedback(nextSubmission ? await getSubmissionFeedback(nextSubmission.id) : null);
    } catch (loadError) {
      setError(formatErrorMessage(loadError, "Unable to load this submission."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSubmission();
  }, [id, useRealData, workspaceId]);

  const handlePrepareFeedback = async () => {
    if (!realSubmission) return;
    try {
      setPreparingFeedback(true);
      setError(null);
      await prepareWritingFeedback(realSubmission.id);
      await loadSubmission();
      toast({ title: "Feedback ready", description: "Line-by-line feedback was saved for this submission." });
    } catch (prepareError) {
      const message = formatErrorMessage(prepareError, "Feedback could not be prepared.");
      setError(message);
      toast({ title: "Feedback failed", description: message });
      await loadSubmission();
    } finally {
      setPreparingFeedback(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <Button variant="ghost" size="sm" className="mb-6 text-muted-foreground hover:text-foreground -ml-3" onClick={() => window.history.back()}>
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Submissions
      </Button>
      {useRealData ? (
        loading ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">Loading submission...</CardContent>
          </Card>
        ) : error ? (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
          </Card>
        ) : realSubmission ? (
          <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-6">
              <div>
                <h1 className="text-3xl font-serif tracking-tight text-foreground">{realSubmission.question_title}</h1>
                <div className="flex flex-wrap items-center gap-3 mt-2 text-muted-foreground text-sm">
                  <span>{formatSubmissionDate(realSubmission.created_at)}</span>
                  <span className="w-1 h-1 rounded-full bg-border"></span>
                  <span>{realSubmission.student_name ?? "Student"}</span>
                  {realSubmission.student_email && (
                    <>
                      <span className="w-1 h-1 rounded-full bg-border"></span>
                      <span>{realSubmission.student_email}</span>
                    </>
                  )}
                  {realSubmission.batch_name && (
                    <>
                      <span className="w-1 h-1 rounded-full bg-border"></span>
                      <span>{realSubmission.batch_name}</span>
                    </>
                  )}
                  {(realSubmission.question_level || realSubmission.batch_level) && (
                    <Badge variant="outline" className="bg-muted text-muted-foreground">
                      {realSubmission.question_level ?? realSubmission.batch_level}
                    </Badge>
                  )}
                </div>
              </div>
              <SubmissionStatusBadge status={realSubmission.status} />
            </div>

            {realSubmission.question_prompt && (
              <Card className="bg-primary/5 border-primary/20">
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-widest text-primary">Writing Task</CardTitle>
                </CardHeader>
                <CardContent>
                  <PromptText prompt={realSubmission.question_prompt} />
                </CardContent>
              </Card>
            )}

            {feedback ? (
              <RealFeedbackReview submission={realSubmission} feedback={feedback} />
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Student Submission</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="whitespace-pre-wrap leading-relaxed">{realSubmission.original_text}</p>
                  </CardContent>
                </Card>

                <Card className="border-dashed bg-muted/20">
                  <CardContent className="p-8 text-center">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Sparkles className="h-6 w-6" />
                    </div>
                    <h2 className="text-lg font-semibold mb-2">{emptyFeedbackTitle}.</h2>
                    <p className="text-sm text-muted-foreground mb-6">{emptyFeedbackMessage}</p>
                    {canPrepareFeedback && (
                      <Button
                        onClick={handlePrepareFeedback}
                        disabled={preparingFeedback}
                        className="shadow-sm"
                      >
                        {preparingFeedback ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="mr-2 h-4 w-4" />
                        )}
                        {preparingFeedback ? "Preparing feedback..." : "Prepare Feedback"}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        ) : (
          <Card className="border-dashed bg-muted/20">
            <CardContent className="p-10 text-center">
              <h1 className="text-lg font-semibold mb-2">Submission not found.</h1>
              <p className="text-sm text-muted-foreground">It may belong to another workspace.</p>
            </CardContent>
          </Card>
        )
      ) : (
        <SubmissionReview
          submission={submission}
          student={student}
          question={question}
          isTeacherView={true}
        />
      )}
    </div>
  );
}
