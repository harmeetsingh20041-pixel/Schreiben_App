import { useState, useEffect, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PromptText } from "@/components/prompt-text";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, ArrowLeft, Save, Trash2, CheckCircle2, PenTool } from "lucide-react";
import { MOCK_QUESTIONS } from "@/data/mockData";
import { checkWriting } from "@/services/aiCorrectionService";
import { createWritingSubmission, saveDraftSubmission, type SubmissionQuestionSource } from "@/services/submissionService";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { formatErrorMessage } from "@/lib/workspaceData";
import type { Question } from "@/types";

const GERMAN_SPECIAL_LETTERS = ["ä", "ö", "ü", "ß", "Ä", "Ö", "Ü"];

export default function StudentWrite() {
  const { authMode, user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(useSearch());
  const qId = searchParams.get("q");
  const isFree = searchParams.get("mode") === "free";
  const useRealData = authMode === "supabase" && Boolean(user);
  const storedQuestion = (() => {
    if (!qId) return null;
    try {
      const raw = sessionStorage.getItem("gwc_selected_question");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Question;
      return parsed.id === qId ? parsed : null;
    } catch {
      return null;
    }
  })();
  const question = MOCK_QUESTIONS.find(q => q.id === qId) ?? storedQuestion;
  
  const [text, setText] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [checkStage, setCheckStage] = useState(0);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  
  const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
  
  const stages = useRealData ? [
    "Saving your writing...",
    "Preparing review status..."
  ] : [
    "Checking grammar and vocabulary...",
    "Checking meaning and context...",
    "Checking level suitability...",
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
  }, [isChecking, stages.length]);

  const getQuestionSource = (): SubmissionQuestionSource => {
    if (isFree) return "free_text";
    return question?.source === "global" ? "global_question" : "workspace_question";
  };

  const submitRealWriting = async (saveAsDraft = false) => {
    if (!text.trim()) return;
    setSubmitError(null);
    if (saveAsDraft) {
      setIsSavingDraft(true);
    } else {
      setIsChecking(true);
      setCheckStage(0);
    }

    try {
      const service = saveAsDraft ? saveDraftSubmission : createWritingSubmission;
      const nextSubmissionId = await service({
        questionSource: getQuestionSource(),
        questionId: isFree ? null : question?.id ?? qId,
        batchId: isFree ? null : question?.batch_id ?? null,
        answerText: text,
      });

      if (saveAsDraft) {
        toast({
          title: "Draft saved",
          description: "Your writing draft was saved in Supabase.",
        });
      } else {
        setSubmittedId(nextSubmissionId);
      }
    } catch (error) {
      const message = formatErrorMessage(error, "Could not save your writing.");
      setSubmitError(message);
      toast({ title: "Submission failed", description: message });
    } finally {
      setIsSavingDraft(false);
      setIsChecking(false);
    }
  };

  const handleCheck = async () => {
    if (!text.trim()) return;
    if (useRealData) {
      await submitRealWriting(false);
      return;
    }

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

  const handleSaveDraft = async () => {
    if (!text.trim()) return;
    if (useRealData) {
      await submitRealWriting(true);
      return;
    }
    toast({
      title: "Draft kept locally",
      description: "Demo mode keeps the existing mock writing flow.",
    });
  };

  const rememberSelection = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    selectionRef.current = {
      start: textarea.selectionStart ?? text.length,
      end: textarea.selectionEnd ?? text.length,
    };
  };

  const insertSpecialLetter = (letter: string) => {
    const textarea = textareaRef.current;
    if (!textarea || isChecking) return;

    const savedSelection = selectionRef.current;
    const start = Math.min(savedSelection?.start ?? textarea.selectionStart ?? text.length, text.length);
    const end = Math.min(savedSelection?.end ?? textarea.selectionEnd ?? text.length, text.length);
    const nextText = `${text.slice(0, start)}${letter}${text.slice(end)}`;
    const nextCursor = start + letter.length;

    setText(nextText);
    selectionRef.current = { start: nextCursor, end: nextCursor };
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  };

  if (!isFree && !question) {
    return <div className="p-8 text-center">Writing task not found.</div>;
  }

  if (submittedId) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-4xl animate-in fade-in duration-300">
        <Button variant="ghost" size="sm" className="mb-6 text-muted-foreground hover:text-foreground -ml-3" onClick={() => setLocation("/student/questions")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Writing
        </Button>
        <Card className="border-primary/25 bg-primary/5">
          <CardContent className="p-10 text-center">
            <div className="w-14 h-14 rounded-xl bg-primary/15 text-primary flex items-center justify-center mx-auto mb-5">
              <CheckCircle2 className="w-7 h-7" />
            </div>
            <h1 className="text-2xl font-serif mb-2">Writing submitted.</h1>
            <p className="text-muted-foreground mb-6">Feedback is being prepared. Check back later for line-by-line feedback.</p>
            <div className="flex flex-col sm:flex-row justify-center gap-3">
              <Button onClick={() => setLocation(`/student/submission/${submittedId}`)}>
                View Submission
              </Button>
              <Button variant="outline" onClick={() => {
                setSubmittedId(null);
                setText("");
              }}>
                Back to Writing
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
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
            <PromptText prompt={question?.prompt} className="text-foreground text-base" />
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
            <h3 className="text-xl font-bold mb-2">{useRealData ? "Submitting your writing" : "Analyzing your writing"}</h3>
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

          <div className="px-4 py-3 border-b border-border bg-background/70 flex flex-col sm:flex-row sm:items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              German letters
            </span>
            <div className="flex flex-wrap gap-2" aria-label="German special letters">
              {GERMAN_SPECIAL_LETTERS.map((letter) => (
                <Button
                  key={letter}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 min-w-8 px-2 text-base font-semibold leading-none bg-card"
                  aria-label={`Insert ${letter}`}
                  disabled={isChecking}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertSpecialLetter(letter)}
                >
                  {letter}
                </Button>
              ))}
            </div>
          </div>
          
          <Textarea 
            ref={textareaRef}
            className="flex-1 resize-none border-0 focus-visible:ring-0 rounded-none p-6 text-lg leading-relaxed shadow-none bg-transparent"
            placeholder="Type your German text here..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onClick={rememberSelection}
            onFocus={rememberSelection}
            onKeyUp={rememberSelection}
            onSelect={rememberSelection}
            disabled={isChecking}
          />
          
          <div className="bg-background px-6 py-4 border-t border-border flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className={`text-sm text-foreground flex flex-wrap gap-4 ${isChecking ? "opacity-80" : ""}`}>
              <span className={isFree ? "font-medium" : wordCount > 0 ? (wordCount >= parseInt(question?.expected_word_range.split('-')[0] || "0") ? "text-green-700 dark:text-green-300 font-semibold" : "text-amber-700 dark:text-amber-300 font-semibold") : "font-medium"}>
                <strong>{wordCount}</strong> words
              </span>
              <span className="font-medium"><strong>{text.length}</strong> characters</span>
              {submitError && <span className="text-destructive font-medium">{submitError}</span>}
            </div>
            
            <div className="flex gap-2 w-full sm:w-auto">
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setText("")} disabled={!text || isChecking}>
                <Trash2 className="w-4 h-4 mr-2" /> Clear
              </Button>
              <Button variant="outline" size="sm" onClick={handleSaveDraft} disabled={!text || isChecking || isSavingDraft}>
                {isSavingDraft ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Save Draft
              </Button>
              <Button onClick={handleCheck} disabled={!text.trim() || isChecking} className="shadow-md">
                {isChecking ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                {useRealData ? "Submit Writing" : "Check My Writing"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
