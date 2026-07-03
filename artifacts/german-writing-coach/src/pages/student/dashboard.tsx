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
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Welcome back, {student.name.split(' ')[0]}!</h1>
          <p className="text-muted-foreground mt-1">Batch: A2 Morning • {student.total_submissions} submissions so far</p>
        </div>
        <div className="flex gap-3">
          <Link href="/student/history" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2">
            View History
          </Link>
          <Link href="/student/questions" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2 shadow-md shadow-primary/20">
            <PenTool className="w-4 h-4 mr-2" />
            Start New Writing
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <Card className="bg-gradient-to-br from-card to-card/50 shadow-sm border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg font-medium flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-primary" />
              Recent Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-primary mb-2">85%</div>
            <p className="text-sm text-muted-foreground mb-4">Average correct sentences in last 5 submissions.</p>
            <Progress value={85} className="h-2" />
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg font-medium flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-accent" />
              Focus Areas
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">Grammar topics to review based on your mistakes.</p>
            <div className="flex flex-wrap gap-2">
              {student.weak_topics.map(topic => (
                <Badge key={topic} variant="secondary" className="bg-accent/10 text-accent-foreground border-accent/20">
                  {topic}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg font-medium flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary" />
              Next Steps
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 mt-1.5 rounded-full bg-primary" />
                <div>
                  <p className="text-sm font-medium">Review Dativ/Akkusativ</p>
                  <p className="text-xs text-muted-foreground">Recommended before next writing</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 mt-1.5 rounded-full bg-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Complete A2 Topic: Travel</p>
                  <p className="text-xs text-muted-foreground">Try a new practice prompt</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <h2 className="text-xl font-bold mb-4">Recent Feedback</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {recentSubmissions.map((sub, i) => (
          <Card key={sub.id} className="hover:border-primary/30 transition-colors shadow-sm animate-in slide-in-from-bottom-4" style={{ animationDelay: `${i * 100}ms` }}>
            <CardContent className="p-5">
              <div className="flex justify-between items-start mb-3">
                <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20">
                  {sub.status}
                </Badge>
                <div className="flex items-center text-xs text-muted-foreground">
                  <Clock className="w-3 h-3 mr-1" />
                  {sub.date}
                </div>
              </div>
              <h3 className="font-semibold text-lg mb-2">
                {sub.questionId ? "Structured Practice" : "Free Writing"}
              </h3>
              <p className="text-sm text-muted-foreground line-clamp-2 mb-4">
                {sub.ai_response?.overall_summary || "Waiting for feedback..."}
              </p>
              <div className="flex justify-between items-center mt-4">
                <div className="text-xs text-muted-foreground font-medium">
                  {sub.number_of_corrections} corrections
                </div>
                <Link href={`/student/submission/${sub.id}`} className="text-sm text-primary font-medium hover:underline flex items-center">
                  Review <span className="ml-1">→</span>
                </Link>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
