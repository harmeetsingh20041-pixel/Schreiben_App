import { useEffect } from "react";
import { Link } from "wouter";
import { BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";

export default function ConfirmEmail() {
  const { authCallbackState, loading, needsWorkspace, role, user } = useAuth();
  const confirmationSucceeded = Boolean(
    user &&
    authCallbackState?.kind === "email_confirmation" &&
    authCallbackState.userId === user.id &&
    authCallbackState.expiresAt > Date.now(),
  );
  const continueTo = needsWorkspace
    ? "/teacher/onboarding"
    : role === "teacher"
      ? "/teacher/dashboard"
      : "/student/dashboard";

  useEffect(() => {
    if (confirmationSucceeded) sessionStorage.removeItem("gwc_confirmation_email");
  }, [confirmationSucceeded]);

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="space-y-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <BadgeCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-serif font-semibold leading-none tracking-tight">
              {loading
                ? "Confirming your email"
                : confirmationSucceeded
                  ? "Email confirmed"
                  : "Confirmation link unavailable"}
            </h1>
            <CardDescription className="mt-2 leading-relaxed">
              {loading
                ? "Please wait while we verify the link."
                : confirmationSucceeded
                  ? "Your account is ready. You can continue to Schreiben."
                  : "The link may have expired or already been used. Try signing in, or resend the confirmation email."}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite">Verifying...</p>
          ) : confirmationSucceeded ? (
            <Button asChild className="w-full">
              <Link href={continueTo}>Continue</Link>
            </Button>
          ) : (
            <>
              <Button asChild className="w-full">
                <Link href="/">Try signing in</Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href="/auth/check-email">Resend confirmation email</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
