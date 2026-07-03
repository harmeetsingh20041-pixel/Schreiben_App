import { useParams, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { SubmissionReview } from "@/components/submission-review";
import { MOCK_SUBMISSIONS, MOCK_QUESTIONS, MOCK_STUDENTS } from "@/data/mockData";

export default function StudentSubmissionDetail() {
  const { id } = useParams();
  
  const submission = MOCK_SUBMISSIONS.find(s => s.id === id) || MOCK_SUBMISSIONS[0];
  const question = MOCK_QUESTIONS.find(q => q.id === submission.questionId);
  const student = MOCK_STUDENTS.find(s => s.id === submission.studentId);
  
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <Button variant="ghost" size="sm" className="mb-6 text-muted-foreground hover:text-foreground -ml-3" onClick={() => window.history.back()}>
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to History
      </Button>
      <SubmissionReview submission={submission} question={question} student={student} />
    </div>
  );
}