import { useParams, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import StudentResult from "./result"; 
// In a real app we'd load the specific submission. For MVP, we reuse the result view with mock data.

export default function StudentSubmissionDetail() {
  const { id } = useParams();
  
  // Usually fetch submission by ID. Here we just wrap the result component.
  return (
    <div>
      {/* Reusing the result UI for submission details since it's the exact same layout needed */}
      <StudentResult />
    </div>
  );
}
