import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { PenTool, Clock, BookOpen, AlertCircle, TrendingUp, KeyRound } from "lucide-react";
import { Link } from "wouter";
import { MOCK_STUDENTS, MOCK_SUBMISSIONS } from "@/data/mockData";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";
import { useToast } from "@/hooks/use-toast";
import { listMyBatchAssignments, listMyBatchJoinRequests, requestJoinBatchByCode, type BatchJoinRequest, type StudentBatchAssignment } from "@/services/studentService";
import { listStudentSubmissions, type WritingSubmission } from "@/services/submissionService";

export default function StudentDashboard() {
  const { authMode, user, profile } = useAuth();
  const { toast } = useToast();
  const student = MOCK_STUDENTS[0]; // Rahul Sharma
  const useRealData = authMode === "supabase" && Boolean(user);
  const recentSubmissions = useRealData ? [] : MOCK_SUBMISSIONS.filter(s => s.studentId === student.id).slice(0, 3);
  const [batchAssignments, setBatchAssignments] = useState<StudentBatchAssignment[]>([]);
  const [joinRequests, setJoinRequests] = useState<BatchJoinRequest[]>([]);
  const [realSubmissions, setRealSubmissions] = useState<WritingSubmission[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [loading, setLoading] = useState(useRealData);
  const [submittingJoinCode, setSubmittingJoinCode] = useState(false);

  const loadStudentAccess = async () => {
    if (!user) return;
    try {
      setLoading(true);
      const [nextAssignments, nextRequests, nextSubmissions] = await Promise.all([
        listMyBatchAssignments(user.id),
        listMyBatchJoinRequests(user.id),
        listStudentSubmissions(user.id, 4),
      ]);
      setBatchAssignments(nextAssignments);
      setJoinRequests(nextRequests);
      setRealSubmissions(nextSubmissions);
    } catch (error) {
      toast({
        title: "Could not load batch access",
        description: formatErrorMessage(error, "Please refresh and try again."),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!useRealData) return;
    void loadStudentAccess();
  }, [useRealData, user]);

  const submitJoinCode = async () => {
    if (!joinCode.trim()) {
      toast({ title: "Batch code required", description: "Enter the code your teacher shared." });
      return;
    }

    try {
      setSubmittingJoinCode(true);
      const result = await requestJoinBatchByCode(joinCode);
      setJoinCode("");
      await loadStudentAccess();
      toast({
        title: result.status === "approved" ? "Joined batch" : "Request sent",
        description: result.status === "approved"
          ? `${result.batch_name} is ready.`
          : "Waiting for teacher approval.",
      });
    } catch (error) {
      toast({
        title: "Could not request batch",
        description: formatErrorMessage(error, "Check the code and try again."),
      });
    } finally {
      setSubmittingJoinCode(false);
    }
  };

  const primaryBatch = batchAssignments[0];
  const latestJoinRequest = joinRequests[0];
  const firstName = useRealData
    ? (profile?.full_name || user?.email || "there").split(/[ @]/)[0]
    : student.name.split(' ')[0];
  const batchSummary = useRealData
    ? primaryBatch
      ? `${primaryBatch.batch_name} · ${primaryBatch.level}`
      : loading
        ? "Loading batch..."
        : "No batch yet"
    : student.batchId.toUpperCase();
  
  return (
    <div className="container mx-auto px-4 py-12 max-w-6xl animate-in fade-in duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-6 border-b border-border/60 pb-8">
        <div>
          <h1 className="text-4xl font-serif tracking-tight mb-2">Welcome back, {firstName}!</h1>
          <p className="text-muted-foreground">Batch: {batchSummary} • {useRealData ? "real workspace access" : `${student.total_submissions} submissions so far`}</p>
        </div>
        <div className="flex gap-4">
          <Link href="/student/history" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-card hover:bg-accent hover:text-accent-foreground h-11 px-6 shadow-sm">
            View History
          </Link>
          <Link href="/student/questions" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-11 px-6 shadow-sm">
            <PenTool className="w-4 h-4 mr-2" />
            Start New Writing
          </Link>
        </div>
      </div>

      {useRealData && !loading && batchAssignments.length === 0 && (
        <Card className="mb-12 border-primary/25 bg-primary/5">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                <KeyRound className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle>Join your batch</CardTitle>
                <CardDescription>Enter your teacher's batch code. They will approve your request before writing tasks appear.</CardDescription>
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
              <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline">{latestJoinRequest.status}</Badge>
                <span>{latestJoinRequest.batch_name} · {latestJoinRequest.batch_level}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {useRealData && loading ? (
        <Card className="mb-12">
          <CardContent className="py-10 text-center text-muted-foreground">Loading batch access...</CardContent>
        </Card>
      ) : (!useRealData || batchAssignments.length > 0) && (
        <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <Card className="bg-card shadow-sm border-border rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              Recent Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-serif text-foreground mb-3">{useRealData ? "-" : "85%"}</div>
            <p className="text-sm text-muted-foreground mb-5 leading-relaxed">
              {useRealData ? "No real submissions yet." : "Average correct sentences in last 5 submissions."}
            </p>
            <Progress value={useRealData ? 0 : 85} className="h-1.5 bg-muted" />
          </CardContent>
        </Card>

        <Card className="bg-card shadow-sm border-border rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-accent" />
              Focus Areas
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col h-[calc(100%-3rem)]">
            <p className="text-sm text-muted-foreground mb-5 leading-relaxed">
              {useRealData
                ? "Writing feedback will appear after students submit work."
                : "Grammar topics to review based on your mistakes."}
            </p>
            <div className="flex flex-wrap gap-2 mb-6 flex-1">
              {useRealData ? (
                <span className="text-sm text-muted-foreground">No focus areas yet.</span>
              ) : (
                student.weak_topics.map(topic => (
                  <Badge key={topic} variant="secondary" className="bg-secondary/50 text-secondary-foreground border-border/50 font-medium">
                    {topic}
                  </Badge>
                ))
              )}
            </div>
            <Link href="/student/practice" className="mt-auto">
              <Button variant="outline" className="w-full shadow-sm hover:border-primary hover:text-primary transition-colors">
                <PenTool className="w-4 h-4 mr-2" /> Practice Weak Topics
              </Button>
            </Link>
          </CardContent>
        </Card>

        <Card className="bg-card shadow-sm border-border rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" />
              Next Steps
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-5 mt-2">
              <div className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 mt-2 rounded-full bg-primary" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {useRealData ? "Start an assigned writing task" : "Review Dativ/Akkusativ"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {useRealData ? "Feedback will appear after real submissions are saved" : "Recommended before next writing"}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 mt-2 rounded-full bg-muted-foreground/30" />
                <div>
                  <p className="text-sm font-medium text-foreground">Complete assigned writing topic</p>
                  <p className="text-xs text-muted-foreground mt-1">Try a new writing task</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <h2 className="text-2xl font-serif tracking-tight mb-6">Recent Feedback</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {useRealData && realSubmissions.length === 0 ? (
          <Card className="md:col-span-2 border-dashed bg-muted/20">
            <CardContent className="p-8 text-center">
              <h3 className="text-lg font-semibold mb-2">No real submissions yet.</h3>
              <p className="text-sm text-muted-foreground">Writing submissions will appear here after students submit work.</p>
            </CardContent>
          </Card>
        ) : useRealData ? realSubmissions.slice(0, 4).map((submission, i) => (
          <Card key={submission.id} className="hover:border-primary/30 transition-all duration-300 shadow-sm border-border rounded-xl animate-in slide-in-from-bottom-4" style={{ animationDelay: `${i * 50}ms` }}>
            <CardContent className="p-6">
              <div className="flex justify-between items-start mb-4">
                <Badge variant="outline" className="bg-accent/10 text-accent-foreground border-accent/20 font-medium">
                  {submission.status}
                </Badge>
                <div className="flex items-center text-xs font-mono text-muted-foreground">
                  <Clock className="w-3.5 h-3.5 mr-1.5" />
                  {new Date(submission.created_at).toLocaleDateString()}
                </div>
              </div>
              <h3 className="font-serif text-xl mb-3 text-foreground">
                {submission.question_title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2 mb-6">
                Correction pending. Feedback is being prepared.
              </p>
              <div className="flex justify-between items-center mt-auto border-t border-border/60 pt-4">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                  {submission.question_source_label}
                </div>
                <Link href={`/student/submission/${submission.id}`} className="text-sm text-primary font-medium hover:underline flex items-center tracking-wide">
                  Open <span className="ml-1 transition-transform group-hover:translate-x-1">→</span>
                </Link>
              </div>
            </CardContent>
          </Card>
        )) : recentSubmissions.map((sub, i) => (
          <Card key={sub.id} className="hover:border-primary/30 transition-all duration-300 shadow-sm border-border rounded-xl animate-in slide-in-from-bottom-4" style={{ animationDelay: `${i * 50}ms` }}>
            <CardContent className="p-6">
              <div className="flex justify-between items-start mb-4">
                <Badge variant="outline" className="bg-card text-foreground border-border font-medium">
                  {sub.status}
                </Badge>
                <div className="flex items-center text-xs font-mono text-muted-foreground">
                  <Clock className="w-3.5 h-3.5 mr-1.5" />
                  {sub.date}
                </div>
              </div>
              <h3 className="font-serif text-xl mb-3 text-foreground">
                {sub.questionId ? "Structured Practice" : "Free Writing"}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2 mb-6">
                {sub.ai_response?.overall_summary || "Waiting for feedback..."}
              </p>
              <div className="flex justify-between items-center mt-auto border-t border-border/60 pt-4">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                  {sub.number_of_corrections} corrections
                </div>
                <Link href={`/student/submission/${sub.id}`} className="text-sm text-primary font-medium hover:underline flex items-center tracking-wide">
                  Review <span className="ml-1 transition-transform group-hover:translate-x-1">→</span>
                </Link>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
        </>
      )}
    </div>
  );
}
