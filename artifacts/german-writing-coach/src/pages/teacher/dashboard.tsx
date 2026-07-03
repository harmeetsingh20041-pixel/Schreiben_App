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
    <div className="container mx-auto px-4 py-12 max-w-6xl animate-in fade-in duration-700">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-6 border-b border-border/60 pb-8">
        <div>
          <h1 className="text-4xl font-serif tracking-tight mb-2 text-foreground">Teacher Overview</h1>
          <p className="text-muted-foreground tracking-wide">Monitor student progress and recent submissions.</p>
        </div>
        <div className="w-full md:w-64">
          <Select value={batchFilter} onValueChange={setBatchFilter}>
            <SelectTrigger className="bg-card">
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

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
        <Card className="shadow-sm border-border rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-primary/20 bg-primary/5 flex items-center justify-center">
                <Users className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Total Students</p>
                <h3 className="text-3xl font-serif text-foreground">{MOCK_STUDENTS.length}</h3>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="shadow-sm border-border rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-primary/20 bg-primary/5 flex items-center justify-center">
                <FileText className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Submissions</p>
                <h3 className="text-3xl font-serif text-foreground">{MOCK_SUBMISSIONS.length}</h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-border rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-[#2E7D32]/20 bg-[#2E7D32]/5 flex items-center justify-center">
                <CheckCircle className="w-5 h-5 text-[#2E7D32]" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Reviewed</p>
                <h3 className="text-3xl font-serif text-foreground">{MOCK_SUBMISSIONS.filter(s => s.status === "Reviewed").length}</h3>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm border-accent/20 bg-accent/5 rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-full border border-accent/20 bg-accent/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-accent" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Common Issues</p>
                <h3 className="text-lg font-serif text-foreground truncate mt-1">Verb pos., Dativ</h3>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
        <div className="lg:col-span-2 space-y-6">
          <h2 className="text-2xl font-serif tracking-tight text-foreground">Recent Submissions</h2>
          {filteredSubmissions.slice(0, 5).map(sub => {
            const student = MOCK_STUDENTS.find(s => s.id === sub.studentId);
            return (
              <Card key={sub.id} className="hover:border-primary/40 transition-all duration-300 shadow-sm border-border rounded-xl">
                <CardContent className="p-6">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center font-serif text-lg border border-border">
                        {student?.name.charAt(0)}
                      </div>
                      <div>
                        <h4 className="font-medium text-foreground">{student?.name}</h4>
                        <p className="text-xs font-mono text-muted-foreground mt-0.5">{sub.date}</p>
                      </div>
                    </div>
                    <Badge variant="outline" className={sub.status === "Reviewed" ? "bg-[#2E7D32]/5 text-[#2E7D32] border-[#2E7D32]/20" : "bg-card text-foreground"}>
                      {sub.status}
                    </Badge>
                  </div>
                  <div className="mt-4">
                    <p className="text-sm text-foreground/80 mb-5 line-clamp-2 leading-relaxed italic border-l-2 border-border/50 pl-4">{sub.original_answer}</p>
                    <div className="flex justify-between items-center">
                      <div className="flex gap-2">
                        {sub.main_grammar_issues.map(issue => (
                          <Badge key={issue} variant="secondary" className="text-xs font-normal bg-muted border-none text-muted-foreground">
                            {issue}
                          </Badge>
                        ))}
                      </div>
                      <Link href={`/teacher/submission/${sub.id}`} className="text-sm text-primary font-medium hover:underline flex items-center group">
                        Review <span className="ml-1 transition-transform group-hover:translate-x-1">→</span>
                      </Link>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        <div className="space-y-6">
          <h2 className="text-2xl font-serif tracking-tight text-foreground">Needs Attention</h2>
          <Card className="shadow-sm border-border rounded-xl">
            <CardHeader className="pb-4 border-b border-border/60 bg-muted/20">
              <CardTitle className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Struggling with Dativ</CardTitle>
            </CardHeader>
            <CardContent className="pt-5 space-y-5">
              {MOCK_STUDENTS.filter(s => s.weak_topics.includes("Dativ/Akkusativ")).map(student => (
                <div key={student.id} className="flex justify-between items-center group">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-serif text-secondary-foreground border border-border">
                      {student.name.charAt(0)}
                    </div>
                    <div className="text-sm">
                      <p className="font-medium text-foreground group-hover:text-primary transition-colors">{student.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{student.batchId}</p>
                    </div>
                  </div>
                  <Link href={`/teacher/students?student=${student.id}`} className="text-xs text-muted-foreground font-medium uppercase tracking-wider hover:text-primary transition-colors">
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
