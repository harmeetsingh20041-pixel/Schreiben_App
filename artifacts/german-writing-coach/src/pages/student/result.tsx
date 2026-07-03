import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { SubmissionReview } from "@/components/submission-review";
import { MOCK_SUBMISSIONS, MOCK_QUESTIONS } from "@/data/mockData";

export default function StudentResult() {
  const [, setLocation] = useLocation();
  const submission = MOCK_SUBMISSIONS[0];
  const question = MOCK_QUESTIONS.find(q => q.id === submission.questionId);

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <Button variant="ghost" size="sm" className="mb-6 text-muted-foreground hover:text-foreground -ml-3" onClick={() => setLocation("/student/dashboard")}>
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Dashboard
      </Button>
      <SubmissionReview submission={submission} question={question} />
      
      <div className="mt-8 flex justify-center pb-12">
        <Button className="px-10 h-12 text-base shadow-sm font-medium tracking-wide" onClick={() => setLocation("/student/questions")}>
          Try Another Writing
        </Button>
      </div>
    </div>
  );
}