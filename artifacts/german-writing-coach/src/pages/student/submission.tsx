import { useParams } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { SubmissionReview } from "@/components/submission-review";
import { useAuth } from "@/lib/auth";
import { MOCK_SUBMISSIONS, MOCK_QUESTIONS, MOCK_STUDENTS } from "@/data/mockData";

export default function StudentSubmissionDetail() {
  const { id } = useParams();
  const { authMode, user } = useAuth();
  const useRealData = authMode === "supabase" && Boolean(user);
  
  const submission = MOCK_SUBMISSIONS.find(s => s.id === id) || MOCK_SUBMISSIONS[0];
  const question = MOCK_QUESTIONS.find(q => q.id === submission.questionId);
  const student = MOCK_STUDENTS.find(s => s.id === submission.studentId);
  
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <Button variant="ghost" size="sm" className="mb-6 text-muted-foreground hover:text-foreground -ml-3" onClick={() => window.history.back()}>
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to History
      </Button>
      {useRealData ? (
        <Card className="border-dashed bg-muted/20">
          <CardContent className="p-10 text-center">
            <h1 className="text-lg font-semibold mb-2">No real submissions yet.</h1>
            <p className="text-sm text-muted-foreground">Writing submissions will appear here after students submit work.</p>
          </CardContent>
        </Card>
      ) : (
        <SubmissionReview submission={submission} question={question} student={student} />
      )}
    </div>
  );
}
