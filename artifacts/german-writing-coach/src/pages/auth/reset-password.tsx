import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";

export default function ResetPassword() {
  const { authCallbackState, completePasswordReset, loading, user } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recoveryReady = Boolean(
    user &&
    authCallbackState?.kind === "password_recovery" &&
    authCallbackState.userId === user.id &&
    authCallbackState.expiresAt > Date.now(),
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Use at least 8 characters for your new password.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }

    setSaving(true);
    try {
      await completePasswordReset(password);
      setSaved(true);
    } catch (updateError) {
      setError(formatErrorMessage(updateError, "We couldn't update your password."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="space-y-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <LockKeyhole className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-serif font-semibold leading-none tracking-tight">Choose a new password</h1>
            <CardDescription className="mt-2">
              Use at least 8 characters and do not reuse a shared password.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {saved ? (
            <div className="space-y-4">
              <p className="rounded-md border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-800" role="status" aria-live="polite">
                Your password has been updated. Sign in with the new password.
              </p>
              <Button asChild className="w-full">
                <Link href="/">Continue to sign in</Link>
              </Button>
            </div>
          ) : loading ? (
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite">Verifying your reset link...</p>
          ) : !recoveryReady ? (
            <div className="space-y-4">
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive" role="alert">
                This reset link is invalid or has expired. Request a new link to continue.
              </p>
              <Button asChild className="w-full">
                <Link href="/auth/forgot-password">Request a new reset link</Link>
              </Button>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={8}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  minLength={8}
                  required
                />
              </div>
              {error && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={saving} aria-busy={saving}>
                {saving ? "Updating..." : "Update password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
