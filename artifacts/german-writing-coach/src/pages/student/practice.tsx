import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, CheckCircle2, XCircle, ArrowRight, BrainCircuit, RefreshCw } from "lucide-react";
import { PRACTICE_EXERCISES, MOCK_STUDENTS } from "@/data/mockData";

export default function StudentPractice() {
  const student = MOCK_STUDENTS[0];
  const weakTopics = student.weak_topics;
  
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [exercises, setExercises] = useState(PRACTICE_EXERCISES);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [showExplanation, setShowExplanation] = useState(false);
  const [score, setScore] = useState(0);
  const [isFinished, setIsFinished] = useState(false);

  const topics = Array.from(new Set(PRACTICE_EXERCISES.map(e => e.topic)));

  const handleSelectTopic = (topic: string) => {
    setSelectedTopic(topic);
    setExercises(PRACTICE_EXERCISES.filter(e => e.topic === topic));
    setCurrentIdx(0);
    setScore(0);
    setIsFinished(false);
    setSelectedAnswer(null);
    setShowExplanation(false);
  };

  const handleAnswer = (option: string) => {
    if (showExplanation) return;
    setSelectedAnswer(option);
    setShowExplanation(true);
    if (option === exercises[currentIdx].correctAnswer) {
      setScore(s => s + 1);
    }
  };

  const handleNext = () => {
    if (currentIdx < exercises.length - 1) {
      setCurrentIdx(i => i + 1);
      setSelectedAnswer(null);
      setShowExplanation(false);
    } else {
      setIsFinished(true);
    }
  };

  const progress = exercises.length > 0 ? ((currentIdx + (isFinished ? 1 : 0)) / exercises.length) * 100 : 0;

  if (!selectedTopic) {
    return (
      <div className="container mx-auto px-4 py-12 max-w-4xl animate-in fade-in duration-500">
        <h1 className="text-4xl font-serif tracking-tight mb-2">Practice Center</h1>
        <p className="text-muted-foreground text-lg mb-10">Target your weak areas with quick exercises.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {topics.map(topic => {
            const isWeak = weakTopics.includes(topic);
            const count = PRACTICE_EXERCISES.filter(e => e.topic === topic).length;
            
            return (
              <Card 
                key={topic} 
                className={`cursor-pointer transition-all duration-300 hover:shadow-md ${isWeak ? 'border-primary/40 bg-primary/5' : 'hover:border-border/80'}`}
                onClick={() => handleSelectTopic(topic)}
              >
                <CardContent className="p-6">
                  <div className="flex justify-between items-start mb-4">
                    <Badge variant={isWeak ? "default" : "outline"} className={isWeak ? "bg-accent hover:bg-accent" : ""}>
                      {isWeak ? "Recommended" : "Practice"}
                    </Badge>
                    <span className="text-sm font-mono text-muted-foreground">{count} exercises</span>
                  </div>
                  <h3 className="font-serif text-2xl text-foreground mb-2">{topic}</h3>
                  <div className="flex items-center text-sm font-medium text-primary mt-6">
                    Start Practice <ArrowRight className="w-4 h-4 ml-1" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    );
  }

  const currentExercise = exercises[currentIdx];

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl animate-in fade-in duration-300">
      <Button variant="ghost" size="sm" className="mb-6 text-muted-foreground hover:text-foreground -ml-3" onClick={() => setSelectedTopic(null)}>
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Topics
      </Button>

      <div className="mb-8">
        <div className="flex justify-between items-end mb-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-1">{selectedTopic}</h2>
            <div className="text-3xl font-serif">Exercise {currentIdx + 1} of {exercises.length}</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-xl font-medium text-primary">{score} / {exercises.length}</div>
          </div>
        </div>
        <Progress value={progress} className="h-2" />
      </div>

      {!isFinished ? (
        <Card className="border-border shadow-sm overflow-hidden">
          <CardHeader className="bg-muted/20 p-8 border-b border-border/50">
            <CardTitle className="text-2xl font-serif text-center leading-relaxed">
              {currentExercise.question.split("____").map((part, i, arr) => (
                <span key={i}>
                  {part}
                  {i < arr.length - 1 && (
                    <span className={`inline-block border-b-2 mx-2 px-4 transition-colors ${
                      showExplanation && selectedAnswer === currentExercise.correctAnswer ? "border-[#2E7D32] text-[#2E7D32]" : 
                      showExplanation && selectedAnswer !== currentExercise.correctAnswer ? "border-[#D32F2F] text-[#D32F2F]" : 
                      "border-primary text-primary"
                    }`}>
                      {showExplanation ? currentExercise.correctAnswer : "\u00A0\u00A0\u00A0"}
                    </span>
                  )}
                </span>
              ))}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-8">
            <div className="grid gap-4">
              {currentExercise.options.map(option => {
                const isSelected = selectedAnswer === option;
                const isCorrect = option === currentExercise.correctAnswer;
                
                let variant = "outline" as any;
                let borderClass = "border-border";
                let bgClass = "bg-card hover:bg-muted";
                
                if (showExplanation) {
                  if (isCorrect) {
                    bgClass = "bg-[#2E7D32]/10 border-[#2E7D32]/30 text-[#2E7D32]";
                    borderClass = "border-[#2E7D32]/30";
                  } else if (isSelected && !isCorrect) {
                    bgClass = "bg-[#D32F2F]/10 border-[#D32F2F]/30 text-[#D32F2F]";
                    borderClass = "border-[#D32F2F]/30";
                  } else {
                    bgClass = "opacity-50";
                  }
                } else if (isSelected) {
                  bgClass = "bg-primary/10 border-primary text-primary";
                  borderClass = "border-primary";
                }

                return (
                  <Button 
                    key={option} 
                    variant={variant}
                    className={`h-14 text-lg justify-start px-6 ${bgClass} ${borderClass} shadow-sm transition-all`}
                    onClick={() => handleAnswer(option)}
                    disabled={showExplanation}
                  >
                    <div className="flex items-center w-full">
                      {showExplanation && isCorrect && <CheckCircle2 className="w-5 h-5 mr-3 text-[#2E7D32]" />}
                      {showExplanation && isSelected && !isCorrect && <XCircle className="w-5 h-5 mr-3 text-[#D32F2F]" />}
                      {!showExplanation && <div className="w-5 h-5 rounded-full border border-current mr-3 flex-shrink-0" />}
                      {option}
                    </div>
                  </Button>
                );
              })}
            </div>

            {showExplanation && (
              <div className="mt-8 p-5 bg-muted/40 rounded-xl border border-border/60 animate-in slide-in-from-bottom-2">
                <h4 className="font-semibold mb-2 flex items-center">
                  <BrainCircuit className="w-4 h-4 mr-2 text-primary" />
                  Explanation
                </h4>
                <p className="text-foreground leading-relaxed">
                  {currentExercise.explanation}
                </p>
                <div className="mt-6 flex justify-end">
                  <Button onClick={handleNext} className="px-8 shadow-sm">
                    {currentIdx < exercises.length - 1 ? "Next Question" : "See Results"} <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="text-center p-12 border-border shadow-sm">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6 border border-primary/20">
            <CheckCircle2 className="w-10 h-10 text-primary" />
          </div>
          <h2 className="text-3xl font-serif mb-4">Practice Complete!</h2>
          <p className="text-xl text-muted-foreground mb-8">
            You scored <span className="font-bold text-foreground">{score}</span> out of {exercises.length}.
          </p>
          <div className="flex justify-center gap-4">
            <Button variant="outline" onClick={() => handleSelectTopic(selectedTopic)}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Try Again
            </Button>
            <Button onClick={() => setSelectedTopic(null)}>
              Choose Another Topic
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}