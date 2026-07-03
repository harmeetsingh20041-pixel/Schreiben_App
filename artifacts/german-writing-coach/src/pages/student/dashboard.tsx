import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { PenTool, Clock, BookOpen, AlertCircle, TrendingUp } from "lucide-react";
import { Link } from "wouter";
import { MOCK_STUDENTS, MOCK_SUBMISSIONS } from "@/data/mockData";

export default function StudentDashboard() {
  const student = MOCK_STUDENTS[0]; // Rahul Sharma
  const recentSubmissions = MOCK_SUBMISSIONS.filter(s => s.studentId === student.id).slice(0, 3);
  
  return (
    <div className="container mx-auto px-4 py-12 max-w-6xl animate-in fade-in duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-6 border-b border-border/60 pb-8">
        <div>
          <h1 className="text-4xl font-serif tracking-tight mb-2">Welcome back, {student.name.split(' ')[0]}!</h1>
          <p className="text-muted-foreground">Batch: A2 Morning • {student.total_submissions} submissions so far</p>
        </div>
        <div className="flex gap-4">
          <Link href="/student/history" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-card hover:bg-accent hover:text-accent-foreground h-11 px-6 shadow-sm">
            View History
          </Link>
          <Link href="/student/questions" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-11 px-6 shadow-sm">
            <PenTool className="w-4 h-4 mr-2" />
            Start New Writing
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <Card className="bg-card shadow-sm border-border rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              Recent Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-serif text-foreground mb-3">85%</div>
            <p className="text-sm text-muted-foreground mb-5 leading-relaxed">Average correct sentences in last 5 submissions.</p>
            <Progress value={85} className="h-1.5 bg-muted" />
          </CardContent>
        </Card>

        <Card className="bg-card shadow-sm border-border rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-accent" />
              Focus Areas
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-5 leading-relaxed">Grammar topics to review based on your mistakes.</p>
            <div className="flex flex-wrap gap-2">
              {student.weak_topics.map(topic => (
                <Badge key={topic} variant="secondary" className="bg-secondary/50 text-secondary-foreground border-border/50 font-medium">
                  {topic}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card shadow-sm border-border rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" />
              Next Steps
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-5 mt-2">
              <div className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 mt-2 rounded-full bg-primary" />
                <div>
                  <p className="text-sm font-medium text-foreground">Review Dativ/Akkusativ</p>
                  <p className="text-xs text-muted-foreground mt-1">Recommended before next writing</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-1.5 h-1.5 mt-2 rounded-full bg-muted-foreground/30" />
                <div>
                  <p className="text-sm font-medium text-foreground">Complete A2 Topic: Travel</p>
                  <p className="text-xs text-muted-foreground mt-1">Try a new practice prompt</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <h2 className="text-2xl font-serif tracking-tight mb-6">Recent Feedback</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {recentSubmissions.map((sub, i) => (
          <Card key={sub.id} className="hover:border-primary/30 transition-all duration-300 shadow-sm border-border rounded-xl animate-in slide-in-from-bottom-4" style={{ animationDelay: `${i * 50}ms` }}>
            <CardContent className="p-6">
              <div className="flex justify-between items-start mb-4">
                <Badge variant="outline" className="bg-card text-foreground border-border font-medium">
                  {sub.status}
                </Badge>
                <div className="flex items-center text-xs font-mono text-muted-foreground">
                  <Clock className="w-3.5 h-3.5 mr-1.5" />
                  {sub.date}
                </div>
              </div>
              <h3 className="font-serif text-xl mb-3 text-foreground">
                {sub.questionId ? "Structured Practice" : "Free Writing"}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2 mb-6">
                {sub.ai_response?.overall_summary || "Waiting for feedback..."}
              </p>
              <div className="flex justify-between items-center mt-auto border-t border-border/60 pt-4">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                  {sub.number_of_corrections} corrections
                </div>
                <Link href={`/student/submission/${sub.id}`} className="text-sm text-primary font-medium hover:underline flex items-center tracking-wide">
                  Review <span className="ml-1 transition-transform group-hover:translate-x-1">→</span>
                </Link>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
