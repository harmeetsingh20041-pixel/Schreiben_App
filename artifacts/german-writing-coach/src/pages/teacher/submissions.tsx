import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Eye, Calendar, Clock, CheckCircle2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage, getActiveWorkspaceId } from "@/lib/workspaceData";
import { listTeacherWorkspaceSubmissions, type WritingSubmission } from "@/services/submissionService";
import { MOCK_SUBMISSIONS, MOCK_STUDENTS, MOCK_QUESTIONS } from "@/data/mockData";

function formatSubmissionDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function TeacherSubmissions() {
  const { authMode, user, workspaceMemberships } = useAuth();
  const useRealData = authMode === "supabase" && Boolean(user);
  const workspaceId = getActiveWorkspaceId(workspaceMemberships);
  const searchParams = new URLSearchParams(useSearch());
  const filterStudent = searchParams.get("student");
  const filterBatch = searchParams.get("batch");
  const [realSubmissions, setRealSubmissions] = useState<WritingSubmission[]>([]);
  const [loading, setLoading] = useState(useRealData);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!useRealData) return;
    if (!workspaceId) {
      setLoading(false);
      setError("No workspace found.");
      return;
    }

    async function loadSubmissions() {
      try {
        setLoading(true);
        setError(null);
        setRealSubmissions(await listTeacherWorkspaceSubmissions(workspaceId!));
      } catch (loadError) {
        setError(formatErrorMessage(loadError, "Unable to load real submissions."));
      } finally {
        setLoading(false);
      }
    }

    void loadSubmissions();
  }, [useRealData, workspaceId]);

  let filtered = useRealData ? [] : MOCK_SUBMISSIONS;
  if (!useRealData && filterStudent) {
    filtered = filtered.filter(s => s.studentId === filterStudent);
  } else if (!useRealData && filterBatch) {
    filtered = filtered.filter(s => {
      const student = MOCK_STUDENTS.find(st => st.id === s.studentId);
      return student?.batchId === filterBatch;
    });
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Student Submissions</h1>
          <p className="text-muted-foreground mt-1">Review submitted writing and add teacher notes.</p>
        </div>
      </div>

      <Card className="shadow-sm overflow-hidden border-border">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className="hidden md:table-cell">Date</TableHead>
              <TableHead className="hidden sm:table-cell">Issues</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {useRealData && loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                  Loading real submissions...
                </TableCell>
              </TableRow>
            ) : useRealData && error ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-destructive">
                  {error}
                </TableCell>
              </TableRow>
            ) : useRealData && realSubmissions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12">
                  <h2 className="text-lg font-semibold mb-2 text-foreground">No real submissions yet.</h2>
                  <p className="text-sm text-muted-foreground">Writing submissions will appear here after students submit work.</p>
                </TableCell>
              </TableRow>
            ) : useRealData ? realSubmissions
              .filter((submission) => !filterStudent || submission.student_id === filterStudent)
              .filter((submission) => !filterBatch || submission.batch_id === filterBatch)
              .map((submission) => (
                <TableRow key={submission.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">{submission.student_name ?? "Student"}</div>
                    <div className="text-xs text-muted-foreground hidden sm:block">{submission.student_email}</div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm line-clamp-1">{submission.question_title}</div>
                    <div className="text-xs text-muted-foreground">
                      {submission.question_source_label}
                      {submission.question_level && ` · Level ${submission.question_level}`}
                      {submission.batch_name && ` · ${submission.batch_name}`}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    <div className="flex items-center">
                      <Calendar className="w-3 h-3 mr-1" /> {formatSubmissionDate(submission.created_at)}
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="text-xs text-muted-foreground">Correction pending</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-accent/10 text-accent-foreground border-accent/20">
                      <Clock className="w-3 h-3 mr-1" />
                      {submission.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/teacher/submission/${submission.id}`}>
                      <Button variant="ghost" size="sm" className="hover:bg-primary/10 hover:text-primary">
                        <Eye className="w-4 h-4 mr-2" /> Open
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              )) : filtered.map(sub => {
              const student = MOCK_STUDENTS.find(s => s.id === sub.studentId);
              const question = MOCK_QUESTIONS.find(q => q.id === sub.questionId);
              const isReviewed = sub.status === "Reviewed";

              return (
                <TableRow key={sub.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">{student?.name}</div>
                    <div className="text-xs text-muted-foreground hidden sm:block">{student?.email}</div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm line-clamp-1">{question ? question.title : "Free Writing"}</div>
                    {question && <div className="text-xs text-muted-foreground">Level {question.level}</div>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    <div className="flex items-center">
                      <Calendar className="w-3 h-3 mr-1" /> {sub.date}
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="flex gap-1 flex-wrap">
                      {sub.main_grammar_issues.map(iss => (
                        <Badge key={iss} variant="secondary" className="text-[10px] py-0 h-4 bg-muted">
                          {iss}
                        </Badge>
                      ))}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {sub.number_of_corrections} corrections
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={isReviewed ? "bg-green-50 text-green-700 border-green-200" : "bg-accent/10 text-accent-foreground border-accent/20"}>
                      {isReviewed ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <Clock className="w-3 h-3 mr-1" />}
                      {sub.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/teacher/submission/${sub.id}`}>
                      <Button variant="ghost" size="sm" className="hover:bg-primary/10 hover:text-primary">
                        <Eye className="w-4 h-4 mr-2" /> Open
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
            {!useRealData && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                  No submissions found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
