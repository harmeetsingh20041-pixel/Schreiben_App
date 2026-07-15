import { useEffect, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { formatErrorMessage } from "@/lib/workspaceData";

const RESEND_COOLDOWN_SECONDS = 60;

export default function CheckEmail() {
  const { resendConfirmation } = useAuth();
  const [email, setEmail] = useState(
    () => sessionStorage.getItem("gwc_confirmation_email") ?? "",
  );
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => {
      setCooldown((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const resend = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || cooldown > 0) return;

    setSending(true);
    setError(null);
    setMessage(null);
    try {
      await resendConfirmation(email);
      sessionStorage.setItem("gwc_confirmation_email", email.trim().toLowerCase());
      setMessage("A new confirmation email has been sent. Check your inbox and spam folder.");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (resendError) {
      setError(formatErrorMessage(resendError, "We couldn't resend the confirmation email."));
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="space-y-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <MailCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-serif font-semibold leading-none tracking-tight">Check your email</h1>
            <CardDescription className="mt-2 leading-relaxed">
              Open the confirmation link before signing in. The link may take a few minutes to arrive.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={resend}>
            <div className="space-y-2">
              <Label htmlFor="confirmation-email">Email</Label>
              <Input
                id="confirmation-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div>
              {message && (
                <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" role="status" aria-live="polite">
                  {message}
                </p>
              )}
              {error && (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
            <Button
              type="submit"
              variant="outline"
              className="w-full"
              disabled={sending || cooldown > 0 || !email.trim()}
              aria-busy={sending}
            >
              {sending
                ? "Sending..."
                : cooldown > 0
                  ? `Resend available in ${cooldown}s`
                  : "Resend confirmation email"}
            </Button>
            <Button asChild className="w-full">
              <Link href="/">Back to sign in</Link>
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
