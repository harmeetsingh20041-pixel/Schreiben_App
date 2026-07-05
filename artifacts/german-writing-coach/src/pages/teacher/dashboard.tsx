import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage, getActiveWorkspaceId } from "@/lib/workspaceData";
import { listWorkspaceBatches, type WorkspaceBatch } from "@/services/batchService";
import { listWorkspaceQuestions } from "@/services/questionService";
import { listTeacherWorkspaceSubmissions, type WritingSubmission } from "@/services/submissionService";
import { listBatchJoinRequests, listStudentInvitations, listWorkspaceStudents, type BatchJoinRequest, type StudentInvitation, type WorkspaceStudent } from "@/services/studentService";
import { getSubmissionIssueLabel, SubmissionStatusBadge } from "@/components/submission-status-badge";
import { formatIssueCount, getWeaknessBadgeClass, getWeaknessLabel, listWorkspaceGrammarStats, type StudentGrammarStat } from "@/services/grammarStatsService";
import { getPracticeAssignmentBadgeClass, getPracticeAssignmentLabel, listWorkspacePracticeAssignments, type PracticeAssignmentSummary } from "@/services/practiceWorksheetService";
import { Users, FileText, CheckCircle, AlertTriangle } from "lucide-react";
import { MOCK_STUDENTS, MOCK_SUBMISSIONS, MOCK_BATCHES } from "@/data/mockData";

export default function TeacherDashboard() {
  const { authMode, user, workspaceMemberships } = useAuth();
  const workspaceId = getActiveWorkspaceId(workspaceMemberships);
  const useRealData = authMode === "supabase" && Boolean(user);

  const [batchFilter, setBatchFilter] = useState("all");
  const [batches, setBatches] = useState<WorkspaceBatch[]>([]);
  const [students, setStudents] = useState<WorkspaceStudent[]>([]);
  const [questionCount, setQuestionCount] = useState(0);
  const [invitations, setInvitations] = useState<StudentInvitation[]>([]);
  const [joinRequests, setJoinRequests] = useState<BatchJoinRequest[]>([]);
  const [realSubmissions, setRealSubmissions] = useState<WritingSubmission[]>([]);
  const [grammarStats, setGrammarStats] = useState<StudentGrammarStat[]>([]);
  const [practiceAssignments, setPracticeAssignments] = useState<PracticeAssignmentSummary[]>([]);
  const [loading, setLoading] = useState(useRealData);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!useRealData) return;
    if (!workspaceId) {
      setError("No workspace found. Create a workspace before viewing real dashboard data.");
      setLoading(false);
      return;
    }

    async function loadDashboard() {
      try {
        setLoading(true);
        setError(null);
        const [nextBatches, nextStudents, nextQuestions, nextInvitations, nextJoinRequests, nextSubmissions, nextGrammarStats, nextPracticeAssignments] = await Promise.all([
          listWorkspaceBatches(workspaceId!),
          listWorkspaceStudents(workspaceId!),
          listWorkspaceQuestions(workspaceId!),
          listStudentInvitations(workspaceId!),
          listBatchJoinRequests(workspaceId!),
          listTeacherWorkspaceSubmissions(workspaceId!, 5),
          listWorkspaceGrammarStats(workspaceId!, 12),
          listWorkspacePracticeAssignments(workspaceId!),
        ]);
        setBatches(nextBatches);
        setStudents(nextStudents);
        setQuestionCount(nextQuestions.length);
        setInvitations(nextInvitations);
        setJoinRequests(nextJoinRequests);
        setRealSubmissions(nextSubmissions);
        setGrammarStats(nextGrammarStats);
        setPracticeAssignments(nextPracticeAssignments);
      } catch (loadError) {
        setError(formatErrorMessage(loadError, "Unable to load dashboard data."));
      } finally {
        setLoading(false);
      }
    }

    void loadDashboard();
  }, [useRealData, workspaceId]);

  const realFilteredStudents = useMemo(() => {
    if (batchFilter === "all") return students;
    return students.filter((student) =>
      student.batches.some((batch) => batch.batch_id === batchFilter),
    );
  }, [batchFilter, students]);

  const filteredSubmissions = batchFilter === "all"
    ? MOCK_SUBMISSIONS
    : MOCK_SUBMISSIONS.filter((sub) => {
        const student = MOCK_STUDENTS.find((item) => item.id === sub.studentId);
        return student?.batchId === batchFilter;
      });
  const realFilteredSubmissions = batchFilter === "all"
    ? realSubmissions
    : realSubmissions.filter((submission) => submission.batch_id === batchFilter);

  const totalStudents = useRealData ? realFilteredStudents.length : MOCK_STUDENTS.length;
  const totalBatches = useRealData ? batches.length : MOCK_BATCHES.length;
  const totalQuestions = useRealData ? questionCount : MOCK_SUBMISSIONS.length;
  const pendingInvitationCount = invitations.filter((invitation) => invitation.status === "pending").length;
  const pendingJoinRequestCount = joinRequests.filter((request) => request.status === "pending").length;
  const totalPendingAccess = pendingInvitationCount + pendingJoinRequestCount;
  const practiceAssignmentByStudentTopic = useMemo(() => {
    const assignmentMap = new Map<string, PracticeAssignmentSummary>();
    for (const assignment of practiceAssignments) {
      const key = `${assignment.student_id}:${assignment.grammar_topic_id}`;
      if (!assignmentMap.has(key)) {
        assignmentMap.set(key, assignment);
      }
    }
    return assignmentMap;
  }, [practiceAssignments]);

  return (
    <div className="container mx-auto px-4 py-12 max-w-6xl animate-in fade-in duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-6 border-b border-border/60 pb-8">
        <div>
          <h1 className="text-4xl font-serif tracking-tight mb-2 text-foreground">Teacher Overview</h1>
          <p className="text-muted-foreground tracking-wide">Monitor student progress and recent submissions.</p>
        </div>
        <div className="w-full md:w-64">
          <Select value={batchFilter} onValueChange={setBatchFilter}>
            <SelectTrigger className="bg-card">
              <SelectValue placeholder="Filter by Batch" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Batches</SelectItem>
              {(useRealData ? batches : MOCK_BATCHES).map((batch) => (
                <SelectItem key={batch.id} value={batch.id}>{batch.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <Card className="mb-6 border-destructive/30 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
        <Card className="shadow-sm border-border rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-primary/20 bg-primary/5 flex items-center justify-center">
                <Users className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Students</p>
                <h3 className="text-3xl font-serif text-foreground">{loading ? "..." : totalStudents}</h3>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="shadow-sm border-border rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-primary/20 bg-primary/5 flex items-center justify-center">
                <FileText className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">{useRealData ? "Writing Tasks" : "Submissions"}</p>
                <h3 className="text-3xl font-serif text-foreground">{loading ? "..." : totalQuestions}</h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-border rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-[#2E7D32]/20 bg-[#2E7D32]/5 flex items-center justify-center">
                <CheckCircle className="w-5 h-5 text-[#2E7D32]" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Batches</p>
                <h3 className="text-3xl font-serif text-foreground">{loading ? "..." : totalBatches}</h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-accent/20 bg-accent/5 rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-accent/20 bg-accent/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-accent" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">{useRealData ? "Pending Access" : "Common Issues"}</p>
                <h3 className="text-lg font-serif text-foreground truncate mt-1">
                  {useRealData ? (loading ? "..." : totalPendingAccess) : "Verb pos., Dativ"}
                </h3>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
        <div className="lg:col-span-2 space-y-6">
          <h2 className="text-2xl font-serif tracking-tight text-foreground">Recent Submissions</h2>
          {useRealData ? (
            realFilteredSubmissions.length === 0 ? (
              <Card className="border-dashed shadow-sm border-border rounded-xl">
                <CardContent className="p-8 text-center">
                  <h3 className="text-lg font-medium mb-2">No real submissions yet</h3>
                  <p className="text-sm text-muted-foreground">Writing submissions will appear here after students submit work.</p>
                </CardContent>
              </Card>
            ) : (
              realFilteredSubmissions.slice(0, 5).map((submission) => (
                <Card key={submission.id} className="hover:border-primary/40 transition-all duration-300 shadow-sm border-border rounded-xl">
                  <CardContent className="p-6">
                    <div className="flex justify-between items-start mb-4 gap-4">
                      <div>
                        <h4 className="font-medium text-foreground">{submission.student_name ?? "Student"}</h4>
                        <p className="text-xs font-mono text-muted-foreground mt-0.5">
                          {new Date(submission.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <SubmissionStatusBadge
                        status={submission.status}
                        feedbackMode={submission.feedback_mode}
                        feedbackScheduledAt={submission.feedback_scheduled_at}
                      />
                    </div>
                    <div className="mt-4">
                      <p className="text-sm font-medium text-foreground mb-1 line-clamp-1">{submission.question_title}</p>
                      <p className="text-sm text-foreground/80 mb-5 line-clamp-2 leading-relaxed italic border-l-2 border-border/50 pl-4">
                        {submission.original_text}
                      </p>
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-medium text-foreground">{getSubmissionIssueLabel(submission)}</span>
                        <Link href={`/teacher/submission/${submission.id}`} className="text-sm text-primary font-medium hover:underline flex items-center group">
                          Review <span className="ml-1 transition-transform group-hover:translate-x-1">-&gt;</span>
                        </Link>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )
          ) : (
            filteredSubmissions.slice(0, 5).map((sub) => {
              const student = MOCK_STUDENTS.find((item) => item.id === sub.studentId);
              return (
                <Card key={sub.id} className="hover:border-primary/40 transition-all duration-300 shadow-sm border-border rounded-xl">
                  <CardContent className="p-6">
                    <div className="flex justify-between items-start mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center font-serif text-lg border border-border">
                          {student?.name.charAt(0)}
                        </div>
                        <div>
                          <h4 className="font-medium text-foreground">{student?.name}</h4>
                          <p className="text-xs font-mono text-muted-foreground mt-0.5">{sub.date}</p>
                        </div>
                      </div>
                      <Badge variant="outline" className={sub.status === "Reviewed" ? "bg-[#2E7D32]/5 text-[#2E7D32] border-[#2E7D32]/20" : "bg-card text-foreground"}>
                        {sub.status}
                      </Badge>
                    </div>
                    <div className="mt-4">
                      <p className="text-sm text-foreground/80 mb-5 line-clamp-2 leading-relaxed italic border-l-2 border-border/50 pl-4">{sub.original_answer}</p>
                      <div className="flex justify-between items-center">
                        <div className="flex gap-2">
                          {sub.main_grammar_issues.map((issue) => (
                            <Badge key={issue} variant="secondary" className="text-xs font-normal bg-muted border-none text-muted-foreground">
                              {issue}
                            </Badge>
                          ))}
                        </div>
                        <Link href={`/teacher/submission/${sub.id}`} className="text-sm text-primary font-medium hover:underline flex items-center group">
                          Review <span className="ml-1 transition-transform group-hover:translate-x-1">-&gt;</span>
                        </Link>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        <div className="space-y-6">
          <h2 className="text-2xl font-serif tracking-tight text-foreground">Needs Attention</h2>
          <Card className="shadow-sm border-border rounded-xl">
            <CardHeader className="pb-4 border-b border-border/60 bg-muted/20">
              <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                {useRealData ? "Grammar Focus Areas" : "Struggling with Dativ"}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-5 space-y-5">
              {useRealData ? (
                grammarStats.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No real grammar focus areas yet.</p>
                ) : (
                  grammarStats.slice(0, 6).map((stat) => {
                    const assignment = practiceAssignmentByStudentTopic.get(`${stat.student_id}:${stat.grammar_topic_id}`);
                    return (
                      <div key={stat.id} className="space-y-2 rounded-lg border bg-card p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">{stat.topic_name}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{stat.student_name ?? "Student"}</p>
                          </div>
                          <Badge variant="outline" className={getWeaknessBadgeClass(stat.weakness_level, stat.practice_unlocked)}>
                            {getWeaknessLabel(stat.weakness_level, stat.practice_unlocked)}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">{formatIssueCount(stat)}</p>
                        {assignment && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className={getPracticeAssignmentBadgeClass(assignment)}>
                              {getPracticeAssignmentLabel(assignment)}
                            </Badge>
                            {assignment.worksheet_title && (
                              <span className="text-xs text-muted-foreground truncate">{assignment.worksheet_title}</span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )
              ) : (
                MOCK_STUDENTS.filter((student) => student.weak_topics.includes("Dativ/Akkusativ")).map((student) => (
                  <div key={student.id} className="flex justify-between items-center group">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-serif text-secondary-foreground border border-border">
                        {student.name.charAt(0)}
                      </div>
                      <div className="text-sm">
                        <p className="font-medium text-foreground group-hover:text-primary transition-colors">{student.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{student.batchId}</p>
                      </div>
                    </div>
                    <Link href={`/teacher/students?student=${student.id}`} className="text-xs text-muted-foreground font-medium uppercase tracking-wider hover:text-primary transition-colors">
                      Profile
                    </Link>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
