import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ArrowLeft, CheckCircle2, AlertTriangle, AlertCircle, Download, BookOpen, ThumbsUp } from "lucide-react";
import { MOCK_AI_RESPONSE } from "@/data/mockData";
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

export default function StudentResult() {
  const [, setLocation] = useLocation();
  const [detailed, setDetailed] = useState(false);
  const result = MOCK_AI_RESPONSE;

  const statusConfig: Record<Status, { icon: any, color: string, bg: string, border: string, label: string }> = {
    correct: { icon: CheckCircle2, color: "text-green-600", bg: "bg-green-50", border: "border-green-200", label: "Correct" },
    acceptable_a1_a2: { icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50", border: "border-blue-200", label: "Good for A1/A2" },
    minor_issue: { icon: AlertTriangle, color: "text-accent-foreground", bg: "bg-accent/10", border: "border-accent/30", label: "Small Issue" },
    major_issue: { icon: AlertCircle, color: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/30", label: "Major Issue" },
    unclear: { icon: AlertCircle, color: "text-orange-600", bg: "bg-orange-50", border: "border-orange-200", label: "Unclear" }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground -ml-3" onClick={() => setLocation("/student/dashboard")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Dashboard
        </Button>
        <div className="flex items-center space-x-2 bg-card border border-border px-4 py-2 rounded-full shadow-sm">
          <Switch id="detailed-mode" checked={detailed} onCheckedChange={setDetailed} />
          <Label htmlFor="detailed-mode" className="font-medium cursor-pointer text-sm">Detailed Explanations</Label>
        </div>
      </div>

      <Card className="mb-8 border-primary/20 shadow-md bg-gradient-to-br from-card to-primary/5">
        <CardContent className="p-6">
          <div className="flex items-start justify-between mb-4">
            <h1 className="text-2xl font-bold">Feedback Summary</h1>
            <Badge variant="outline" className="bg-background">Level Detected: {result.level_detected}</Badge>
          </div>
          <p className="text-lg text-foreground/90 leading-relaxed mb-6">
            {result.overall_summary}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" size="sm" className="bg-background shadow-sm hover:bg-muted" onClick={() => alert("Saved to history!")}>
              <BookOpen className="w-4 h-4 mr-2" /> Save to History
            </Button>
            <Button variant="outline" size="sm" className="bg-background shadow-sm hover:bg-muted" onClick={() => alert("Downloading PDF...")}>
              <Download className="w-4 h-4 mr-2" /> Download PDF
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <h2 className="text-xl font-bold px-1">Line-by-Line Review</h2>
        
        {result.lines.map((line, idx) => {
          const conf = statusConfig[line.status];
          const Icon = conf.icon;
          
          return (
            <Card key={idx} className={`overflow-hidden border ${conf.border} shadow-sm transition-all duration-300 animate-in slide-in-from-bottom-4`} style={{ animationDelay: `${idx * 100}ms` }}>
              <div className={`px-4 py-2 border-b ${conf.border} ${conf.bg} flex justify-between items-center`}>
                <div className={`flex items-center gap-2 font-medium ${conf.color} text-sm`}>
                  <Icon className="w-4 h-4" />
                  {conf.label}
                </div>
                <Badge variant="outline" className="bg-background/50 border-border/50 text-xs text-muted-foreground shadow-none">
                  Line {line.line_number} • {line.grammar_topic}
                </Badge>
              </div>
              
              <CardContent className="p-0">
                <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
                  <div className="p-5 bg-muted/30">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Original</div>
                    <p className="text-foreground text-lg">{line.original_line}</p>
                  </div>
                  <div className="p-5">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Corrected</div>
                    {line.status === "correct" ? (
                      <p className="text-foreground text-lg">{line.corrected_line}</p>
                    ) : (
                      <div className="text-lg"><HighlightedDiff original={line.original_line} corrected={line.corrected_line} /></div>
                    )}
                  </div>
                </div>
                
                <div className="p-5 bg-card border-t border-border">
                  <div className="flex gap-3 items-start">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-primary font-bold text-sm">AI</span>
                    </div>
                    <div>
                      {line.status === "correct" ? (
                        <p className="text-foreground font-medium">Correct. No correction needed.</p>
                      ) : line.status === "acceptable_a1_a2" ? (
                        <p className="text-foreground font-medium">This is good for your level. No need to make it more complicated.</p>
                      ) : (
                        <div>
                          <p className="text-foreground font-medium mb-1">{line.short_explanation}</p>
                          
                          {detailed && line.changed_parts.length > 0 && (
                            <div className="mt-3 space-y-2 animate-in fade-in slide-in-from-top-2">
                              {line.changed_parts.map((part, pIdx) => (
                                <div key={pIdx} className="text-sm bg-muted/50 p-3 rounded-lg border border-border">
                                  <div className="font-mono text-xs mb-1 bg-background px-2 py-1 rounded inline-block border">
                                    <span className="line-through text-destructive opacity-70">{part.from}</span> <span className="text-muted-foreground mx-1">→</span> <span className="text-green-600 font-medium">{part.to}</span>
                                  </div>
                                  <p className="text-muted-foreground mt-1">{part.reason}</p>
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
      </div>

      <div className="mt-10 flex justify-center pb-12">
        <Button className="px-8 shadow-md" onClick={() => setLocation("/student/questions")}>
          Try Another Writing
        </Button>
      </div>
    </div>
  );
}
