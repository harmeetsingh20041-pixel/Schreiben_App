import { useState } from "react";
import { useLocation } from "wouter";
import { PenTool } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";

export default function TeacherOnboarding() {
  const { createWorkspace, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [workspaceName, setWorkspaceName] = useState("My German Class");
  const [error, setError] = useState<string | null>(null);

  const handleCreateWorkspace = async () => {
    setError(null);
    try {
      await createWorkspace(workspaceName);
      setLocation("/teacher/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create workspace.");
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background flex items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md shadow-sm border-border">
        <CardHeader className="space-y-4">
          <div className="w-12 h-12 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-md">
            <PenTool className="w-5 h-5" />
          </div>
          <div>
            <CardTitle className="text-2xl font-serif tracking-tight">Set Up Your Workspace</CardTitle>
            <CardDescription className="mt-2">
              Create the first class workspace for your German writing students.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="workspace-name">Workspace name</Label>
            <Input
              id="workspace-name"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="My German Class"
            />
          </div>
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <Button className="w-full h-11" onClick={handleCreateWorkspace} disabled={loading}>
            {loading ? "Creating..." : "Create Workspace"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
