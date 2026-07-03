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
        if (chunk.type === "removed") return <span key={i} className="line-through text-destructive bg-destructive/10 px-1 py-0.5 rounded border border-destructive/20 decoration-wavy decoration-destructive underline-offset-4 mx-0.5 opacity-80">{chunk.text} </span>;
        if (chunk.type === "added") return <span key={i} className="text-[#2E7D32] font-medium bg-[#2E7D32]/10 px-1 py-0.5 rounded border border-[#2E7D32]/20 mx-0.5">{chunk.text} </span>;
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
    correct: { icon: CheckCircle2, color: "text-[#2E7D32]", bg: "bg-[#2E7D32]/5", border: "border-[#2E7D32]/20", label: "Correct" },
    acceptable_a1_a2: { icon: ThumbsUp, color: "text-[#0277BD]", bg: "bg-[#0277BD]/5", border: "border-[#0277BD]/20", label: "Good for A1/A2" },
    minor_issue: { icon: AlertTriangle, color: "text-[#F57C00]", bg: "bg-[#F57C00]/5", border: "border-[#F57C00]/20", label: "Small Issue" },
    major_issue: { icon: AlertCircle, color: "text-[#D32F2F]", bg: "bg-[#D32F2F]/5", border: "border-[#D32F2F]/20", label: "Major Issue" },
    unclear: { icon: AlertCircle, color: "text-slate-600", bg: "bg-slate-50", border: "border-slate-200", label: "Unclear" }
  };

  return (
    <div className="container mx-auto px-4 py-12 max-w-4xl animate-in fade-in duration-700">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-10 gap-4">
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground -ml-3" onClick={() => setLocation("/student/dashboard")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Dashboard
        </Button>
        <div className="flex items-center space-x-3 bg-card border border-border px-4 py-2.5 rounded-lg shadow-sm">
          <Switch id="detailed-mode" checked={detailed} onCheckedChange={setDetailed} />
          <Label htmlFor="detailed-mode" className="font-medium cursor-pointer text-sm tracking-wide">Detailed Explanations</Label>
        </div>
      </div>

      <Card className="mb-12 border-border shadow-sm bg-card rounded-xl overflow-hidden">
        <CardContent className="p-8">
          <div className="flex items-start justify-between mb-6">
            <h1 className="text-3xl font-serif tracking-tight text-foreground">Feedback Summary</h1>
            <Badge variant="outline" className="bg-secondary/50 text-secondary-foreground border-secondary font-medium tracking-wide">Level Detected: {result.level_detected}</Badge>
          </div>
          <p className="text-lg text-foreground/80 leading-relaxed mb-8 max-w-3xl">
            {result.overall_summary}
          </p>
          <div className="flex flex-wrap gap-3 border-t border-border/60 pt-6">
            <Button variant="outline" size="sm" className="bg-background shadow-sm" onClick={() => alert("Saved to history!")}>
              <BookOpen className="w-4 h-4 mr-2 text-primary" /> Save to History
            </Button>
            <Button variant="outline" size="sm" className="bg-background shadow-sm" onClick={() => alert("Downloading PDF...")}>
              <Download className="w-4 h-4 mr-2 text-primary" /> Download PDF
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-8">
        <h2 className="text-2xl font-serif tracking-tight mb-2 px-1">Line-by-Line Review</h2>
        
        {result.lines.map((line, idx) => {
          const conf = statusConfig[line.status];
          const Icon = conf.icon;
          
          return (
            <Card key={idx} className={`overflow-hidden border border-border shadow-sm transition-all duration-300 animate-in slide-in-from-bottom-4 rounded-xl`} style={{ animationDelay: `${idx * 50}ms` }}>
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
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">Original</div>
                    <p className="text-foreground text-lg leading-relaxed">{line.original_line}</p>
                  </div>
                  <div className="p-6 bg-card">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">Corrected</div>
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
      </div>

      <div className="mt-12 flex justify-center pb-16">
        <Button className="px-10 h-12 text-base shadow-sm font-medium tracking-wide" onClick={() => setLocation("/student/questions")}>
          Try Another Writing
        </Button>
      </div>
    </div>
  );
}
