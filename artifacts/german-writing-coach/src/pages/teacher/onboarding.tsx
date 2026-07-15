import { useState } from "react";
import { Link } from "wouter";
import { PenTool } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isPublicAppError } from "@/lib/appError";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";

const TEACHING_AREA_NAME_MAX_CODE_POINTS = 120;

function codePoints(value: string) {
  return Array.from(value);
}

export default function TeacherOnboarding() {
  const { canCreateTeacherWorkspace, createWorkspace, loading } = useAuth();
  const [workspaceName, setWorkspaceName] = useState("My German Class");
  const [error, setError] = useState<string | null>(null);
  const [mfaActionRequired, setMfaActionRequired] = useState(false);
  const workspaceNameLength = codePoints(workspaceName).length;
  const validWorkspaceName =
    workspaceName.trim().length > 0 &&
    workspaceNameLength <= TEACHING_AREA_NAME_MAX_CODE_POINTS;

  const handleCreateWorkspace = async () => {
    setError(null);
    setMfaActionRequired(false);
    try {
      await createWorkspace(workspaceName);
    } catch (err) {
      if (
        isPublicAppError(err) &&
        (err.code === "data_fresh_reauthentication_required" ||
          err.code === "data_mfa_required")
      ) {
        setMfaActionRequired(true);
      }
      setError(formatErrorMessage(err, "Could not prepare teaching."));
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
            <CardTitle className="text-2xl font-serif tracking-tight">
              Set Up Teaching
            </CardTitle>
            <CardDescription className="mt-2">
              Name this private teaching area, then create your first class.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="workspace-name">Teaching area name</Label>
            <Input
              id="workspace-name"
              value={workspaceName}
              onChange={(event) =>
                setWorkspaceName(
                  codePoints(event.target.value)
                    .slice(0, TEACHING_AREA_NAME_MAX_CODE_POINTS)
                    .join(""),
                )
              }
              aria-describedby="workspace-name-count"
              placeholder="My German Class"
            />
            <p
              id="workspace-name-count"
              className="text-right text-xs text-muted-foreground"
            >
              {workspaceNameLength}/{TEACHING_AREA_NAME_MAX_CODE_POINTS}
            </p>
          </div>
          {error && (
            <div
              role="alert"
              className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
              {mfaActionRequired && (
                <div>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/auth/mfa?mode=reauth&returnTo=%2Fteacher%2Fonboarding">
                      Re-authenticate with MFA
                    </Link>
                  </Button>
                </div>
              )}
            </div>
          )}
          <Button
            className="w-full h-11"
            onClick={handleCreateWorkspace}
            disabled={
              loading || !canCreateTeacherWorkspace || !validWorkspaceName
            }
          >
            {loading ? "Preparing..." : "Continue to class setup"}
          </Button>
          {!canCreateTeacherWorkspace && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              Your teacher account is not currently allowed to create another
              teaching area. Contact the pilot administrator for access.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
