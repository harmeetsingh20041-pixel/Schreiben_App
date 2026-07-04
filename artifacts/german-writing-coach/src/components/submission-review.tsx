import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertTriangle, AlertCircle, MessageSquare, ThumbsUp, Save, Check, AlertOctagon } from "lucide-react";
import { Submission, Student, Question, Status } from "@/types";
import { GRAMMAR_TOPIC_INFO } from "@/data/mockData";
import { getDiffWords } from "@/utils/diffHighlighter";

interface SubmissionReviewProps {
  submission: Submission;
  student?: Student;
  question?: Question;
  isTeacherView?: boolean;
}

function HighlightedDiff({ original, corrected }: { original: string, corrected: string }) {
  const diffs = getDiffWords(original, corrected);
  return (
    <div className="leading-relaxed">
      {diffs.map((chunk, i) => {
        if (chunk.type === "unchanged") return <span key={i}>{chunk.text} </span>;
        if (chunk.type === "removed") return <span key={i} className="line-through text-destructive bg-destructive/10 px-1 py-0.5 rounded border border-destructive/20 mx-0.5 opacity-80">{chunk.text} </span>;
        if (chunk.type === "added") return <span key={i} className="text-[#2E7D32] font-medium bg-[#2E7D32]/10 px-1 py-0.5 rounded border border-[#2E7D32]/20 mx-0.5">{chunk.text} </span>;
        return null;
      })}
    </div>
  );
}

export function SubmissionReview({ submission, student, question, isTeacherView = false }: SubmissionReviewProps) {
  const [detailed, setDetailed] = useState(false);
  const [teacherNote, setTeacherNote] = useState(submission.teacher_note || "");
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState(submission.status);

  const handleSaveNote = () => {
    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      setStatus("Reviewed");
    }, 600);
  };

  const statusConfig: Record<Status, { icon: any, color: string, bg: string, border: string, label: string }> = {
    correct: { icon: CheckCircle2, color: "text-[#2E7D32]", bg: "bg-[#2E7D32]/5", border: "border-[#2E7D32]/20", label: "Correct" },
    acceptable_a1_a2: { icon: ThumbsUp, color: "text-[#0277BD]", bg: "bg-[#0277BD]/5", border: "border-[#0277BD]/20", label: "Good for level" },
    minor_issue: { icon: AlertTriangle, color: "text-[#F57C00]", bg: "bg-[#F57C00]/5", border: "border-[#F57C00]/20", label: "Small Issue" },
    major_issue: { icon: AlertOctagon, color: "text-[#D32F2F]", bg: "bg-[#D32F2F]/5", border: "border-[#D32F2F]/20", label: "Major Issue" },
    unclear: { icon: AlertCircle, color: "text-slate-600", bg: "bg-slate-50", border: "border-slate-200", label: "Unclear" }
  };

  const stats = {
    correct: submission.ai_response.lines.filter(l => l.status === "correct").length,
    good: submission.ai_response.lines.filter(l => l.status === "acceptable_a1_a2").length,
    minor: submission.ai_response.lines.filter(l => l.status === "minor_issue").length,
    major: submission.ai_response.lines.filter(l => l.status === "major_issue").length,
    unclear: submission.ai_response.lines.filter(l => l.status === "unclear").length,
  };

  const linesChecked = submission.ai_response.lines.length;

  const grammarGroups = submission.ai_response.lines.reduce((acc, line) => {
    if (line.grammar_topic && line.status !== "correct" && line.status !== "acceptable_a1_a2") {
      if (!acc[line.grammar_topic]) acc[line.grammar_topic] = [];
      acc[line.grammar_topic].push(line);
    }
    return acc;
  }, {} as Record<string, typeof submission.ai_response.lines>);

  return (
    <div className="space-y-8 animate-in fade-in duration-700 pb-16">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border pb-6">
        <div>
          <h1 className="text-3xl font-serif tracking-tight text-foreground">
            {question ? question.title : "Free Writing"}
          </h1>
          <div className="flex items-center gap-3 mt-2 text-muted-foreground text-sm">
            <span>{submission.date}</span>
            {student && (
              <>
                <span className="w-1 h-1 rounded-full bg-border"></span>
                <span>{student.name}</span>
                <span className="w-1 h-1 rounded-full bg-border"></span>
                <span>Batch {question?.level || submission.ai_response.level_detected}</span>
              </>
            )}
            <span className="w-1 h-1 rounded-full bg-border"></span>
            <Badge variant="outline" className="bg-muted text-muted-foreground">{question?.level || submission.ai_response.level_detected}</Badge>
          </div>
        </div>
        <Badge variant={status === "Reviewed" ? "default" : "outline"} className={status === "Reviewed" ? "bg-[#2E7D32] hover:bg-[#2E7D32]/90" : "bg-accent/10 text-accent-foreground border-accent/20"}>
          {status}
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Card className="bg-card shadow-sm border-border rounded-xl">
          <CardHeader className="bg-muted/30 pb-4 border-b border-border/50">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Original Answer</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <p className="text-foreground leading-relaxed whitespace-pre-wrap">{submission.original_answer}</p>
          </CardContent>
        </Card>
        <Card className="bg-card shadow-sm border-border rounded-xl">
          <CardHeader className="bg-primary/5 pb-4 border-b border-primary/10">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-primary">Corrected Answer</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <p className="text-foreground leading-relaxed whitespace-pre-wrap">
              {submission.ai_response.lines.map(l => l.corrected_line).join("\n")}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-primary text-primary-foreground shadow-sm rounded-xl overflow-hidden border-none">
        <div className="p-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
            <h2 className="text-2xl font-serif tracking-tight">Feedback Summary</h2>
            <div className="flex items-center gap-3">
              <Badge variant="outline" className="bg-primary-foreground/10 border-primary-foreground/20 text-primary-foreground font-medium">Level: {submission.ai_response.level_detected}</Badge>
              <Badge variant="outline" className="bg-primary-foreground/10 border-primary-foreground/20 text-primary-foreground font-medium">{linesChecked} lines checked</Badge>
            </div>
          </div>
          <p className="text-lg text-primary-foreground/90 leading-relaxed mb-8 max-w-3xl">
            {submission.ai_response.overall_summary}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 pt-6 border-t border-primary-foreground/20">
            <div className="flex flex-col">
              <span className="text-3xl font-serif mb-1">{stats.correct}</span>
              <span className="text-xs uppercase tracking-wider text-primary-foreground/70">Correct</span>
            </div>
            <div className="flex flex-col">
              <span className="text-3xl font-serif mb-1">{stats.good}</span>
              <span className="text-xs uppercase tracking-wider text-primary-foreground/70">Good for Level</span>
            </div>
            <div className="flex flex-col">
              <span className="text-3xl font-serif mb-1">{stats.minor}</span>
              <span className="text-xs uppercase tracking-wider text-primary-foreground/70">Small Issues</span>
            </div>
            <div className="flex flex-col">
              <span className="text-3xl font-serif mb-1 text-[#FFCDD2]">{stats.major}</span>
              <span className="text-xs uppercase tracking-wider text-[#FFCDD2]/70">Major Issues</span>
            </div>
            <div className="flex flex-col">
              <span className="text-3xl font-serif mb-1">{stats.unclear}</span>
              <span className="text-xs uppercase tracking-wider text-primary-foreground/70">Unclear</span>
            </div>
          </div>
        </div>
      </Card>

      <Tabs defaultValue="line-by-line" className="w-full">
        <TabsList className="w-full justify-start border-b border-border rounded-none bg-transparent h-auto p-0 mb-8 space-x-6">
          <TabsTrigger value="line-by-line" className="data-[state=active]:bg-transparent data-[state=active]:border-primary data-[state=active]:text-primary border-b-2 border-transparent rounded-none px-2 py-3 text-base">Line-by-line</TabsTrigger>
          <TabsTrigger value="original-vs-corrected" className="data-[state=active]:bg-transparent data-[state=active]:border-primary data-[state=active]:text-primary border-b-2 border-transparent rounded-none px-2 py-3 text-base">Original vs Corrected</TabsTrigger>
          <TabsTrigger value="grammar-topics" className="data-[state=active]:bg-transparent data-[state=active]:border-primary data-[state=active]:text-primary border-b-2 border-transparent rounded-none px-2 py-3 text-base">Grammar Topics</TabsTrigger>
          <TabsTrigger value="teacher-notes" className="data-[state=active]:bg-transparent data-[state=active]:border-primary data-[state=active]:text-primary border-b-2 border-transparent rounded-none px-2 py-3 text-base">Teacher Notes</TabsTrigger>
        </TabsList>

        <TabsContent value="line-by-line" className="space-y-6">
          <div className="flex justify-end mb-4">
            <div className="flex items-center space-x-3 bg-card border border-border px-4 py-2 rounded-lg shadow-sm">
              <Switch id="detailed-mode" checked={detailed} onCheckedChange={setDetailed} />
              <Label htmlFor="detailed-mode" className="font-medium cursor-pointer text-sm tracking-wide">Detailed Explanations</Label>
            </div>
          </div>
          {submission.ai_response.lines.map((line, idx) => {
            const conf = statusConfig[line.status];
            const Icon = conf.icon;
            
            return (
              <Card key={idx} className="overflow-hidden border border-border shadow-sm rounded-xl">
                <div className={`px-5 py-3 border-b ${conf.border} ${conf.bg} flex justify-between items-center`}>
                  <div className={`flex items-center gap-2 font-medium ${conf.color} text-sm tracking-wide uppercase`}>
                    <Icon className="w-4 h-4" />
                    {conf.label}
                  </div>
                  <Badge variant="outline" className="bg-background border-border text-xs text-muted-foreground font-mono">
                    Line {line.line_number} {line.grammar_topic && `• ${line.grammar_topic}`}
                  </Badge>
                </div>
                
                <CardContent className="p-0">
                  <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
                    <div className="p-6 bg-muted/30">
                      <p className="text-foreground text-lg leading-relaxed">{line.original_line}</p>
                    </div>
                    <div className="p-6 bg-card">
                      {line.status === "correct" ? (
                        <p className="text-foreground text-lg leading-relaxed">{line.corrected_line}</p>
                      ) : (
                        <div className="text-lg leading-relaxed"><HighlightedDiff original={line.original_line} corrected={line.corrected_line} /></div>
                      )}
                    </div>
                  </div>
                  
                  <div className="p-6 bg-card border-t border-border/60">
                    <div className="flex gap-4 items-start">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5 border border-primary/20">
                        <span className="text-primary font-serif font-semibold text-sm">AI</span>
                      </div>
                      <div className="pt-1">
                        {line.status === "correct" ? (
                          <p className="text-foreground font-medium">Correct. No correction needed.</p>
                        ) : line.status === "acceptable_a1_a2" ? (
                          <p className="text-foreground font-medium">This is good for your level. No need to make it more complicated.</p>
                        ) : (
                          <div>
                            <p className="text-foreground font-medium mb-1 leading-relaxed">{line.short_explanation}</p>
                            
                            {detailed && line.changed_parts.length > 0 && (
                              <div className="mt-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
                                {line.changed_parts.map((part, pIdx) => (
                                  <div key={pIdx} className="text-sm bg-muted/40 p-4 rounded-lg border border-border/50">
                                    <div className="font-mono text-xs mb-2 bg-card px-2.5 py-1.5 rounded inline-block border border-border/80 shadow-sm">
                                      <span className="line-through text-destructive opacity-80">{part.from}</span> <span className="text-muted-foreground mx-2">→</span> <span className="text-[#2E7D32] font-medium">{part.to}</span>
                                    </div>
                                    <p className="text-muted-foreground">{part.reason}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </TabsContent>

        <TabsContent value="original-vs-corrected">
          <Card className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">Original</h3>
                <div className="space-y-2">
                  {submission.ai_response.lines.map((line, i) => {
                    const conf = statusConfig[line.status];
                    return (
                      <div key={i} className={`p-3 rounded border ${conf.bg} ${conf.border}`}>
                        {line.original_line}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">Corrected</h3>
                <div className="space-y-2">
                  {submission.ai_response.lines.map((line, i) => {
                    const conf = statusConfig[line.status];
                    return (
                      <div key={i} className={`p-3 rounded border ${conf.bg} ${conf.border}`}>
                        {line.corrected_line}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="mt-8 flex flex-wrap gap-4 pt-4 border-t border-border">
              <span className="text-sm text-muted-foreground mr-2">Legend:</span>
              <div className="flex items-center gap-2 text-sm"><div className="w-3 h-3 rounded bg-[#2E7D32]/20 border border-[#2E7D32]/30"></div> Correct / Good</div>
              <div className="flex items-center gap-2 text-sm"><div className="w-3 h-3 rounded bg-[#F57C00]/20 border border-[#F57C00]/30"></div> Small Issue</div>
              <div className="flex items-center gap-2 text-sm"><div className="w-3 h-3 rounded bg-[#D32F2F]/20 border border-[#D32F2F]/30"></div> Major Issue</div>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="grammar-topics">
          {Object.keys(grammarGroups).length === 0 ? (
            <Card className="p-12 text-center text-muted-foreground border-dashed bg-muted/30">
              No specific grammar issues identified in this submission.
            </Card>
          ) : (
            <div className="space-y-6">
              {Object.entries(grammarGroups).map(([topic, lines]) => (
                <Card key={topic} className="shadow-sm border-border">
                  <CardHeader className="pb-3 border-b border-border/50 bg-muted/20">
                    <div className="flex justify-between items-center">
                      <CardTitle className="text-lg flex items-center gap-2">
                        {topic}
                        <Badge variant="secondary" className="ml-2 font-mono">{lines.length}</Badge>
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="p-6 border-b border-border/50 bg-primary/5">
                      <p className="text-foreground leading-relaxed">
                        {GRAMMAR_TOPIC_INFO[topic] || "Review the general rules for this grammar topic."}
                      </p>
                    </div>
                    <div className="p-6 space-y-4">
                      {lines.map((line, i) => (
                        <div key={i} className="bg-card border border-border rounded-lg p-4">
                          <HighlightedDiff original={line.original_line} corrected={line.corrected_line} />
                          <p className="text-sm text-muted-foreground mt-3 pt-3 border-t border-border/50">{line.short_explanation}</p>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="teacher-notes">
          <Card className="shadow-sm border-border">
            <CardHeader className="bg-muted/30 pb-4 border-b border-border">
              <CardTitle className="text-lg flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-primary" />
                Teacher's Note
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              {isTeacherView ? (
                <div className="flex flex-col gap-4">
                  <Textarea 
                    placeholder="Add an encouraging note or specific advice for the student..." 
                    className="min-h-[200px] resize-none border-border focus-visible:ring-primary/20 bg-background text-base"
                    value={teacherNote}
                    onChange={(e) => setTeacherNote(e.target.value)}
                  />
                  <div className="flex justify-end gap-3 mt-2">
                    <Button className="shadow-sm px-6" onClick={handleSaveNote} disabled={isSaving}>
                      {isSaving ? "Saving..." : status === "Reviewed" ? <><Check className="w-4 h-4 mr-2" /> Note Saved</> : <><Save className="w-4 h-4 mr-2" /> Save & Mark Reviewed</>}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="min-h-[150px]">
                  {teacherNote ? (
                    <p className="text-foreground text-lg leading-relaxed whitespace-pre-wrap">{teacherNote}</p>
                  ) : (
                    <div className="h-full flex items-center justify-center text-muted-foreground">
                      No teacher notes for this submission yet.
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
