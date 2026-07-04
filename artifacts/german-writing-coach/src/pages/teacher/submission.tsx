import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Clock } from "lucide-react";
import { SubmissionReview } from "@/components/submission-review";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage, getActiveWorkspaceId } from "@/lib/workspaceData";
import { getTeacherSubmissionDetail, type WritingSubmission } from "@/services/submissionService";
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
  const useRealData = authMode === "supabase" && Boolean(user);
  const workspaceId = getActiveWorkspaceId(workspaceMemberships);
  const [realSubmission, setRealSubmission] = useState<WritingSubmission | null>(null);
  const [loading, setLoading] = useState(useRealData);
  const [error, setError] = useState<string | null>(null);
  
  const submission = MOCK_SUBMISSIONS.find(s => s.id === id) || MOCK_SUBMISSIONS[0];
  const student = MOCK_STUDENTS.find(s => s.id === submission.studentId);
  const question = MOCK_QUESTIONS.find(q => q.id === submission.questionId);

  useEffect(() => {
    if (!useRealData || !workspaceId || !id) return;

    async function loadSubmission() {
      try {
        setLoading(true);
        setError(null);
        setRealSubmission(await getTeacherSubmissionDetail(workspaceId!, id!));
      } catch (loadError) {
        setError(formatErrorMessage(loadError, "Unable to load this submission."));
      } finally {
        setLoading(false);
      }
    }

    void loadSubmission();
  }, [id, useRealData, workspaceId]);

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
              <Badge variant="outline" className="bg-accent/10 text-accent-foreground border-accent/20">
                <Clock className="w-3 h-3 mr-1" />
                {realSubmission.status}
              </Badge>
            </div>

            {realSubmission.question_prompt && (
              <Card className="bg-primary/5 border-primary/20">
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-widest text-primary">Prompt</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="leading-relaxed">{realSubmission.question_prompt}</p>
                </CardContent>
              </Card>
            )}

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
                <h2 className="text-lg font-semibold mb-2">AI feedback pending.</h2>
                <p className="text-sm text-muted-foreground">Line-by-line correction and grammar insights will appear after AI checking is connected.</p>
              </CardContent>
            </Card>
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
