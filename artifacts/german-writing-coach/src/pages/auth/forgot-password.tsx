import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";

export default function ForgotPassword() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;

    setSending(true);
    setError(null);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (requestError) {
      setError(formatErrorMessage(requestError, "We couldn't send a password reset email."));
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="space-y-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-serif font-semibold leading-none tracking-tight">Reset your password</h1>
            <CardDescription className="mt-2 leading-relaxed">
              Enter your account email and we will send a secure reset link.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-4">
              <p className="rounded-md border border-green-200 bg-green-50 px-3 py-3 text-sm leading-relaxed text-green-800" role="status" aria-live="polite">
                If an account exists for that email, a password reset link has been sent. Check your inbox and spam folder.
              </p>
              <Button asChild className="w-full">
                <Link href="/">Back to sign in</Link>
              </Button>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="reset-email">Email</Label>
                <Input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoFocus
                />
              </div>
              {error && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={sending || !email.trim()} aria-busy={sending}>
                {sending ? "Sending..." : "Send reset link"}
              </Button>
              <Button asChild variant="ghost" className="w-full">
                <Link href="/">Back to sign in</Link>
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
