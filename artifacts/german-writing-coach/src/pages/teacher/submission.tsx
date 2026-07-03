import { useState } from "react";
import { useParams, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, CheckCircle2, AlertTriangle, AlertCircle, Save, Check, MessageSquare, ThumbsUp } from "lucide-react";
import { MOCK_SUBMISSIONS, MOCK_STUDENTS, MOCK_QUESTIONS } from "@/data/mockData";
import { getDiffWords } from "@/utils/diffHighlighter";
import { Status } from "@/types";

function HighlightedDiff({ original, corrected }: { original: string, corrected: string }) {
  const diffs = getDiffWords(original, corrected);
  return (
    <div className="leading-relaxed">
      {diffs.map((chunk, i) => {
        if (chunk.type === "unchanged") return <span key={i}>{chunk.text} </span>;
        if (chunk.type === "removed") return <span key={i} className="line-through text-destructive bg-destructive/10 px-1 rounded mx-0.5 opacity-70">{chunk.text} </span>;
        if (chunk.type === "added") return <span key={i} className="text-green-700 font-medium bg-green-500/10 px-1 rounded mx-0.5">{chunk.text} </span>;
        return null;
      })}
    </div>
  );
}

export default function TeacherSubmissionDetail() {
  const { id } = useParams();
  
  // Use mock sub 1 if id not found (for demo)
  const submission = MOCK_SUBMISSIONS.find(s => s.id === id) || MOCK_SUBMISSIONS[0];
  const student = MOCK_STUDENTS.find(s => s.id === submission.studentId);
  const question = MOCK_QUESTIONS.find(q => q.id === submission.questionId);
  
  const [teacherNote, setTeacherNote] = useState(submission.teacher_note || "");
  const [status, setStatus] = useState(submission.status);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = () => {
    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      setStatus("Reviewed");
    }, 600);
  };

  const statusConfig: Record<Status, { icon: any, color: string, bg: string, border: string, label: string }> = {
    correct: { icon: CheckCircle2, color: "text-green-600", bg: "bg-green-50", border: "border-green-200", label: "Correct" },
    acceptable_a1_a2: { icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50", border: "border-blue-200", label: "Good for A1/A2" },
    minor_issue: { icon: AlertTriangle, color: "text-accent-foreground", bg: "bg-accent/10", border: "border-accent/30", label: "Small Issue" },
    major_issue: { icon: AlertCircle, color: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/30", label: "Major Issue" },
    unclear: { icon: AlertCircle, color: "text-orange-600", bg: "bg-orange-50", border: "border-orange-200", label: "Unclear" }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl animate-in fade-in duration-500">
      <div className="mb-6">
        <Button variant="ghost" size="sm" className="mb-4 text-muted-foreground hover:text-foreground -ml-3" onClick={() => window.history.back()}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Submissions
        </Button>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold">{student?.name}'s Submission</h1>
            <p className="text-muted-foreground">{submission.date} • {question ? question.title : "Free Writing"}</p>
          </div>
          <Badge variant={status === "Reviewed" ? "default" : "outline"} className={status === "Reviewed" ? "bg-green-600 hover:bg-green-700" : "bg-accent/10 text-accent-foreground border-accent/20"}>
            {status}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-primary/20 shadow-sm">
            <CardHeader className="bg-primary/5 pb-4 border-b border-primary/10">
              <CardTitle className="text-lg flex justify-between items-center">
                AI Feedback Summary
                <Badge variant="outline" className="bg-background">Level: {submission.ai_response.level_detected}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <p className="text-foreground leading-relaxed">
                {submission.ai_response.overall_summary}
              </p>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <h2 className="text-xl font-bold px-1 mt-8 mb-4">Line-by-Line Review</h2>
            {submission.ai_response.lines.map((line, idx) => {
              const conf = statusConfig[line.status];
              const Icon = conf.icon;
              
              return (
                <Card key={idx} className={`overflow-hidden border ${conf.border} shadow-sm`}>
                  <div className={`px-4 py-2 border-b ${conf.border} ${conf.bg} flex justify-between items-center`}>
                    <div className={`flex items-center gap-2 font-medium ${conf.color} text-sm`}>
                      <Icon className="w-4 h-4" />
                      {conf.label}
                    </div>
                    <Badge variant="outline" className="bg-background/50 border-border/50 text-xs text-muted-foreground">
                      {line.grammar_topic}
                    </Badge>
                  </div>
                  
                  <CardContent className="p-0">
                    <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
                      <div className="p-4 bg-muted/20">
                        <p className="text-foreground">{line.original_line}</p>
                      </div>
                      <div className="p-4">
                        {line.status === "correct" ? (
                          <p className="text-foreground">{line.corrected_line}</p>
                        ) : (
                          <HighlightedDiff original={line.original_line} corrected={line.corrected_line} />
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>

        <div className="space-y-6">
          <Card className="shadow-sm sticky top-24">
            <CardHeader className="bg-muted/30 pb-4 border-b border-border">
              <CardTitle className="text-lg flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-primary" />
                Teacher's Note
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 flex flex-col gap-4">
              <Textarea 
                placeholder="Add an encouraging note or specific advice for the student..." 
                className="min-h-[200px] resize-none border-primary/20 focus-visible:ring-primary/20 bg-background"
                value={teacherNote}
                onChange={(e) => setTeacherNote(e.target.value)}
              />
              <div className="flex flex-col gap-2">
                <Button className="w-full shadow-sm" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? "Saving..." : status === "Reviewed" ? <><Check className="w-4 h-4 mr-2" /> Note Saved</> : <><Save className="w-4 h-4 mr-2" /> Save & Mark Reviewed</>}
                </Button>
                <div className="text-xs text-center text-muted-foreground mt-2">
                  This note will be visible on the student's history page.
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
