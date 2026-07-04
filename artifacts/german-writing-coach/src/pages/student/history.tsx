import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText, Calendar, CheckCircle2, Clock, Eye } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { MOCK_SUBMISSIONS, MOCK_QUESTIONS } from "@/data/mockData";

export default function StudentHistory() {
  const { authMode, user } = useAuth();
  const useRealData = authMode === "supabase" && Boolean(user);
  const studentSubmissions = MOCK_SUBMISSIONS.filter(s => s.studentId === "s1");
  
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl animate-in fade-in duration-500">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">My History</h1>
        <p className="text-muted-foreground mt-1">Review your past writings and feedback.</p>
      </div>

      <div className="space-y-4">
        {useRealData ? (
          <Card className="p-12 text-center border-dashed bg-muted/30">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <FileText className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No real submissions yet.</h3>
            <p className="text-muted-foreground mb-6">Writing submissions will appear here after students submit work.</p>
            <Link href="/student/questions">
              <Button>Start Practice</Button>
            </Link>
          </Card>
        ) : studentSubmissions.map((sub, i) => {
          const question = MOCK_QUESTIONS.find(q => q.id === sub.questionId);
          const isReviewed = sub.status === "Reviewed";
          
          return (
            <Card key={sub.id} className="hover:border-primary/40 hover:shadow-md transition-all duration-300 animate-in slide-in-from-bottom-4 group" style={{ animationDelay: `${i * 100}ms` }}>
              <CardContent className="p-0">
                <div className="flex flex-col md:flex-row md:items-center">
                  <div className="p-5 md:w-[200px] border-b md:border-b-0 md:border-r border-border bg-muted/20 flex flex-row md:flex-col justify-between items-start gap-2">
                    <div className="flex items-center text-sm font-medium text-muted-foreground">
                      <Calendar className="w-4 h-4 mr-2 text-primary" />
                      {sub.date}
                    </div>
                    <Badge variant="outline" className={isReviewed ? "bg-green-50 text-green-700 border-green-200" : "bg-accent/10 text-accent-foreground border-accent/20"}>
                      {isReviewed ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <Clock className="w-3 h-3 mr-1" />}
                      {sub.status}
                    </Badge>
                  </div>
                  
                  <div className="p-5 flex-1 flex flex-col justify-center">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <h3 className="font-semibold text-lg text-foreground group-hover:text-primary transition-colors">
                          {question ? question.title : "Free Writing"}
                        </h3>
                        {question && <p className="text-sm text-muted-foreground">Level {question.level} • {question.topic}</p>}
                      </div>
                      <div className="text-right hidden sm:block">
                        <div className="text-sm font-medium">
                          {sub.number_of_corrections === 0 ? "Perfect!" : `${sub.number_of_corrections} corrections`}
                        </div>
                      </div>
                    </div>
                    
                    {sub.main_grammar_issues.length > 0 && (
                      <div className="flex items-center gap-2 mt-3">
                        <span className="text-xs text-muted-foreground">Issues:</span>
                        <div className="flex gap-1">
                          {sub.main_grammar_issues.map(issue => (
                            <Badge key={issue} variant="secondary" className="text-[10px] py-0 h-5 font-normal">
                              {issue}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  
                  <div className="p-5 border-t md:border-t-0 md:border-l border-border bg-muted/5 flex items-center justify-end">
                    <Link href={`/student/submission/${sub.id}`}>
                      <Button variant="outline" className="w-full md:w-auto shadow-sm group-hover:bg-primary group-hover:text-primary-foreground group-hover:border-primary transition-colors">
                        <Eye className="w-4 h-4 mr-2" /> View Feedback
                      </Button>
                    </Link>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      
      {!useRealData && studentSubmissions.length === 0 && (
        <Card className="p-12 text-center border-dashed bg-muted/30">
          <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
            <FileText className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">No submissions yet</h3>
          <p className="text-muted-foreground mb-6">Complete your first writing practice to see it here.</p>
          <Link href="/student/questions">
            <Button>Start Practice</Button>
          </Link>
        </Card>
      )}
    </div>
  );
}
