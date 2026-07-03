import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { SubmissionReview } from "@/components/submission-review";
import { MOCK_SUBMISSIONS, MOCK_STUDENTS, MOCK_QUESTIONS } from "@/data/mockData";

export default function TeacherSubmissionDetail() {
  const { id } = useParams();
  
  const submission = MOCK_SUBMISSIONS.find(s => s.id === id) || MOCK_SUBMISSIONS[0];
  const student = MOCK_STUDENTS.find(s => s.id === submission.studentId);
  const question = MOCK_QUESTIONS.find(q => q.id === submission.questionId);

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <Button variant="ghost" size="sm" className="mb-6 text-muted-foreground hover:text-foreground -ml-3" onClick={() => window.history.back()}>
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Submissions
      </Button>
      <SubmissionReview 
        submission={submission} 
        student={student} 
        question={question} 
        isTeacherView={true} 
      />
    </div>
  );
}