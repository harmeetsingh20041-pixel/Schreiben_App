import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, ArrowLeft, Send, Save, Trash2, CheckCircle2, PenTool } from "lucide-react";
import { MOCK_QUESTIONS } from "@/data/mockData";
import { checkWriting } from "@/services/aiCorrectionService";

export default function StudentWrite() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(useSearch());
  const qId = searchParams.get("q");
  const isFree = searchParams.get("mode") === "free";
  
  const question = MOCK_QUESTIONS.find(q => q.id === qId);
  
  const [text, setText] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [checkStage, setCheckStage] = useState(0);
  
  const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
  
  const stages = [
    "Checking grammar and vocabulary...",
    "Checking meaning and context...",
    "Checking A1/A2 suitability...",
    "Avoiding unnecessary overcorrection...",
    "Preparing line-by-line feedback..."
  ];

  useEffect(() => {
    if (!isChecking) {
      return;
    }

    const interval = setInterval(() => {
      setCheckStage(prev => {
        if (prev < stages.length - 1) return prev + 1;
        clearInterval(interval);
        return prev;
      });
    }, 600);
    return () => clearInterval(interval);
  }, [isChecking]);

  const handleCheck = async () => {
    if (!text.trim()) return;
    setIsChecking(true);
    setCheckStage(0);
    
    try {
      await checkWriting(text);
      // Pass ID 'mock' to show the mock result
      setLocation("/student/result/mock");
    } catch (error) {
      setIsChecking(false);
    }
  };

  if (!isFree && !question) {
    return <div className="p-8 text-center">Prompt not found.</div>;
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl animate-in fade-in duration-300 flex flex-col h-full min-h-[calc(100vh-4rem)]">
      <div className="mb-6">
        <Button variant="ghost" size="sm" className="mb-4 text-muted-foreground hover:text-foreground" onClick={() => window.history.back()}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>
        
        {isFree ? (
          <div>
            <h1 className="text-2xl font-bold">Free Writing</h1>
            <p className="text-muted-foreground mt-1">Write anything you want. Keep it simple and natural.</p>
          </div>
        ) : (
          <Card className="p-6 bg-primary/5 border-primary/20 shadow-none">
            <div className="flex items-center gap-3 mb-2">
              <span className="px-2 py-1 text-xs font-medium bg-primary text-primary-foreground rounded">
                {question?.level}
              </span>
              <span className="text-sm font-medium text-primary">Topic: {question?.topic}</span>
            </div>
            <h1 className="text-xl font-bold mb-3">{question?.title}</h1>
            <p className="text-foreground text-base leading-relaxed">{question?.prompt}</p>
            <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
              <span>Target: <strong>{question?.expected_word_range} words</strong></span>
              <span>Time: <strong>~{question?.estimated_time}</strong></span>
            </div>
          </Card>
        )}
      </div>

      <div className="flex-1 flex flex-col relative">
        {isChecking ? (
          <div className="absolute inset-0 z-10 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center rounded-xl border border-border animate-in fade-in">
            <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mb-6 shadow-inner">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
            <h3 className="text-xl font-bold mb-2">Analyzing your writing</h3>
            <div className="h-6 overflow-hidden relative w-64 text-center">
              <div className="text-sm font-medium text-muted-foreground transition-all duration-300" key={checkStage}>
                {stages[checkStage]}
              </div>
            </div>
            <div className="w-64 bg-secondary h-2 rounded-full mt-6 overflow-hidden">
              <div 
                className="bg-primary h-full rounded-full transition-all duration-500 ease-out"
                style={{ width: `${Math.max(5, (checkStage / (stages.length - 1)) * 100)}%` }}
              />
            </div>
          </div>
        ) : null}

        <div className="bg-card border border-border rounded-xl shadow-sm flex flex-col flex-1 overflow-hidden focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/50 transition-all">
          <div className="bg-muted px-4 py-2 border-b border-border flex justify-between items-center text-sm text-muted-foreground">
            <span className="font-medium text-foreground flex items-center gap-2">
              <PenTool className="w-4 h-4" /> Your Text
            </span>
            <span className="bg-background px-2 py-1 rounded border shadow-sm">
              Simple German is okay. Write naturally.
            </span>
          </div>
          
          <Textarea 
            className="flex-1 resize-none border-0 focus-visible:ring-0 rounded-none p-6 text-lg leading-relaxed shadow-none bg-transparent"
            placeholder="Type your German text here..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isChecking}
          />
          
          <div className="bg-background px-6 py-4 border-t border-border flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="text-sm text-muted-foreground flex gap-4">
              <span className={isFree ? "" : wordCount > 0 ? (wordCount >= parseInt(question?.expected_word_range.split('-')[0] || "0") ? "text-green-600 font-medium" : "text-accent-foreground font-medium") : ""}>
                <strong>{wordCount}</strong> words
              </span>
              <span><strong>{text.length}</strong> characters</span>
            </div>
            
            <div className="flex gap-2 w-full sm:w-auto">
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setText("")} disabled={!text || isChecking}>
                <Trash2 className="w-4 h-4 mr-2" /> Clear
              </Button>
              <Button variant="outline" size="sm" disabled={!text || isChecking}>
                <Save className="w-4 h-4 mr-2" /> Save Draft
              </Button>
              <Button onClick={handleCheck} disabled={!text.trim() || isChecking} className="shadow-md">
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Check My Writing
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
