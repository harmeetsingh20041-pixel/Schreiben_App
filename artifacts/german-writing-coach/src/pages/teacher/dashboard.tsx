import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, FileText, CheckCircle, TrendingUp, AlertTriangle } from "lucide-react";
import { MOCK_STUDENTS, MOCK_SUBMISSIONS, MOCK_BATCHES } from "@/data/mockData";

export default function TeacherDashboard() {
  const [batchFilter, setBatchFilter] = useState("all");

  const filteredSubmissions = batchFilter === "all" 
    ? MOCK_SUBMISSIONS 
    : MOCK_SUBMISSIONS.filter(sub => {
        const student = MOCK_STUDENTS.find(s => s.id === sub.studentId);
        return student?.batchId === batchFilter;
      });

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Teacher Overview</h1>
          <p className="text-muted-foreground mt-1">Monitor student progress and recent submissions.</p>
        </div>
        <div className="w-full md:w-64">
          <Select value={batchFilter} onValueChange={setBatchFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by Batch" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Batches</SelectItem>
              {MOCK_BATCHES.map(b => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <Card className="shadow-sm">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Users className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Students</p>
                <h3 className="text-2xl font-bold">{MOCK_STUDENTS.length}</h3>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="shadow-sm">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <FileText className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Submissions (Total)</p>
                <h3 className="text-2xl font-bold">{MOCK_SUBMISSIONS.length}</h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center">
                <CheckCircle className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Reviewed</p>
                <h3 className="text-2xl font-bold">{MOCK_SUBMISSIONS.filter(s => s.status === "Reviewed").length}</h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-accent/30 bg-accent/5">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-accent-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Common Issues</p>
                <h3 className="text-lg font-bold truncate">Verb position, Dativ</h3>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <h2 className="text-xl font-bold">Recent Submissions</h2>
          {filteredSubmissions.slice(0, 5).map(sub => {
            const student = MOCK_STUDENTS.find(s => s.id === sub.studentId);
            return (
              <Card key={sub.id} className="hover:border-primary/30 transition-all shadow-sm">
                <CardContent className="p-5">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center font-bold text-primary text-sm">
                        {student?.name.charAt(0)}
                      </div>
                      <div>
                        <h4 className="font-semibold text-sm">{student?.name}</h4>
                        <p className="text-xs text-muted-foreground">{sub.date}</p>
                      </div>
                    </div>
                    <Badge variant="outline" className={sub.status === "Reviewed" ? "bg-green-50 text-green-700" : "bg-accent/10"}>
                      {sub.status}
                    </Badge>
                  </div>
                  <div className="mt-3">
                    <p className="text-sm text-foreground mb-3 line-clamp-2">{sub.original_answer}</p>
                    <div className="flex justify-between items-center">
                      <div className="flex gap-2">
                        {sub.main_grammar_issues.map(issue => (
                          <Badge key={issue} variant="secondary" className="text-xs font-normal bg-muted">
                            {issue}
                          </Badge>
                        ))}
                      </div>
                      <Link href={`/teacher/submission/${sub.id}`} className="text-sm text-primary font-medium hover:underline">
                        Review
                      </Link>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        <div className="space-y-6">
          <h2 className="text-xl font-bold">Needs Attention</h2>
          <Card className="shadow-sm">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold">Struggling with Dativ</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              {MOCK_STUDENTS.filter(s => s.weak_topics.includes("Dativ/Akkusativ")).map(student => (
                <div key={student.id} className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                      {student.name.charAt(0)}
                    </div>
                    <div className="text-sm">
                      <p className="font-medium">{student.name}</p>
                      <p className="text-xs text-muted-foreground">{student.batchId}</p>
                    </div>
                  </div>
                  <Link href={`/teacher/students?student=${student.id}`} className="text-xs text-primary font-medium">
                    Profile
                  </Link>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
