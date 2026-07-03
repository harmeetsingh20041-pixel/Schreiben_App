import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Users, FileText, CheckCircle2 } from "lucide-react";
import { MOCK_BATCHES } from "@/data/mockData";

export default function TeacherBatches() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl animate-in fade-in duration-500">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Batches</h1>
        <p className="text-muted-foreground mt-1">Manage your class batches and view aggregate performance.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {MOCK_BATCHES.map((batch, i) => (
          <Card key={batch.id} className="hover:shadow-md transition-shadow animate-in slide-in-from-bottom-4" style={{ animationDelay: `${i * 50}ms` }}>
            <CardHeader className="pb-4 border-b border-border bg-muted/30">
              <CardTitle className="text-xl">{batch.name}</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center text-muted-foreground">
                    <Users className="w-4 h-4 mr-2" />
                    <span className="text-sm">Students</span>
                  </div>
                  <span className="font-semibold">{batch.student_count}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center text-muted-foreground">
                    <FileText className="w-4 h-4 mr-2" />
                    <span className="text-sm">Total Submissions</span>
                  </div>
                  <span className="font-semibold">{batch.submission_count}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center text-muted-foreground">
                    <CheckCircle2 className="w-4 h-4 mr-2 text-green-600" />
                    <span className="text-sm">Avg Corrections/Submission</span>
                  </div>
                  <span className="font-semibold">{batch.avg_correction_count}</span>
                </div>
              </div>
            </CardContent>
            <CardFooter className="grid grid-cols-2 gap-3 bg-muted/10 pt-4">
              <Link href={`/teacher/students?batch=${batch.id}`} className="w-full">
                <Button variant="outline" className="w-full text-xs">View Students</Button>
              </Link>
              <Link href={`/teacher/submissions?batch=${batch.id}`} className="w-full">
                <Button className="w-full text-xs">Submissions</Button>
              </Link>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}
