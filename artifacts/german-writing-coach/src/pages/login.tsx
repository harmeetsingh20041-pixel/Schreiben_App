import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { isPublicAppError } from "@/lib/appError";
import { isSignupEnabled } from "@/lib/launchConfig";
import { formatErrorMessage } from "@/lib/workspaceData";
import { PenTool, BookOpen, Sparkles, Users } from "lucide-react";
import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";

export default function Login() {
  const {
    authMode,
    isPlatformAdmin,
    loading,
    needsWorkspace,
    platformAdminMfaReady,
    role,
    signIn,
    signUp,
  } = useAuth();
  const [, setLocation] = useLocation();
  const teacherSignupEnabled = isSignupEnabled("teacher");
  const studentSignupEnabled = isSignupEnabled("student");
  const enabledSignupTypeCount =
    Number(teacherSignupEnabled) + Number(studentSignupEnabled);
  const onlyEnabledSignupType =
    enabledSignupTypeCount === 1
      ? teacherSignupEnabled
        ? "teacher"
        : "student"
      : null;
  const signupEnabled = enabledSignupTypeCount > 0;
  const [isAnimating, setIsAnimating] = useState(false);
  const [heroText, setHeroText] = useState(
    "Ich habe meinen Hausaufgaben gemacht.",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [accountType, setAccountType] = useState<"student" | "teacher" | null>(
    onlyEnabledSignupType,
  );
  const [formMode, setFormMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = useState<string | null>(null);
  const [showConfirmationResend, setShowConfirmationResend] = useState(false);

  useEffect(() => {
    if (isPlatformAdmin) {
      setLocation(
        platformAdminMfaReady
          ? "/admin/teacher-access"
          : "/auth/mfa?returnTo=%2Fadmin%2Fteacher-access",
      );
      return;
    }
    if (needsWorkspace) {
      setLocation("/teacher/onboarding");
      return;
    }
    if (role === "student") {
      setLocation("/student/dashboard");
      return;
    }
    if (role === "teacher") setLocation("/teacher/dashboard");
  }, [
    isPlatformAdmin,
    needsWorkspace,
    platformAdminMfaReady,
    role,
    setLocation,
  ]);

  useEffect(() => {
    if (!signupEnabled && formMode === "sign-up") {
      setFormMode("sign-in");
      return;
    }
    if (
      formMode === "sign-up" &&
      accountType &&
      !isSignupEnabled(accountType)
    ) {
      setAccountType(onlyEnabledSignupType);
    }
  }, [accountType, formMode, onlyEnabledSignupType, signupEnabled]);

  useEffect(() => {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const interval = setInterval(() => {
      setIsAnimating(true);
      setTimeout(() => {
        setHeroText("Ich habe meine Hausaufgaben gemacht.");
      }, 500);
      setTimeout(() => {
        setIsAnimating(false);
      }, 2000);

      setTimeout(() => {
        setHeroText("Ich habe meinen Hausaufgaben gemacht.");
      }, 4000);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleEmailAuth = async () => {
    setError(null);
    setShowConfirmationResend(false);
    try {
      if (formMode === "sign-in") {
        await signIn(email, password);
      } else {
        if (!accountType) {
          setError(
            "Choose whether you are creating a student or teacher account.",
          );
          return;
        }
        const result = await signUp({ email, password, fullName, accountType });
        if (result.requiresEmailConfirmation) {
          sessionStorage.setItem("gwc_confirmation_email", result.email);
          setLocation("/auth/check-email");
        }
      }
    } catch (err) {
      setError(
        formatErrorMessage(err, "Authentication failed. Please try again."),
      );
      if (isPublicAppError(err) && err.code === "auth_email_unconfirmed") {
        sessionStorage.setItem(
          "gwc_confirmation_email",
          email.trim().toLowerCase(),
        );
        setShowConfirmationResend(true);
      }
    }
  };

  return (
    <main className="min-h-[100dvh] flex flex-col lg:flex-row bg-background relative font-sans text-foreground">
      {/* Editorial background elements - subtle grain or gradient */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            "url('data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E')",
        }}
      ></div>
      <div className="absolute top-[-15%] left-[-10%] w-[50%] h-[50%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Left side: Hero / Branding */}
      <div className="order-2 flex-1 flex flex-col justify-center p-8 lg:order-1 lg:p-12 xl:p-16 relative z-10 border-r border-border/50">
        <div className="max-w-xl mx-auto lg:mx-0 w-full">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-card/50 text-muted-foreground text-sm font-medium mb-6">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-50"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
            </span>
            German Writing Coach
          </div>
          <h1 className="text-4xl lg:text-5xl xl:text-6xl font-serif text-foreground tracking-tight mb-3 leading-[1.1]">
            Master German Writing,{" "}
            <span className="text-primary italic">Line by Line.</span>
          </h1>
          <p className="text-base lg:text-lg text-muted-foreground mb-6 max-w-md leading-relaxed">
            Precise feedback for A1-B2 learners that corrects mistakes without
            overcomplicating your sentences. Build confidence in your natural
            writing.
          </p>

          <div className="relative bg-card border border-border rounded-lg p-5 shadow-sm max-w-md font-mono text-sm leading-loose flex flex-col">
            <div className="flex items-center gap-2 mb-3 border-b border-border/50 pb-3">
              <div className="w-2.5 h-2.5 rounded-full bg-destructive/80" />
              <div className="w-2.5 h-2.5 rounded-full bg-accent/80" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#2E7D32]/80" />
            </div>
            <div
              className={`transition-opacity duration-500 ease-in-out ${isAnimating ? "opacity-40" : "opacity-100"}`}
            >
              <span className="text-muted-foreground/50 mr-2">01</span>
              {heroText === "Ich habe meinen Hausaufgaben gemacht." ? (
                <span>
                  Ich habe{" "}
                  <span className="text-destructive font-medium bg-destructive/10 px-1.5 py-0.5 rounded border border-destructive/20 decoration-wavy decoration-destructive underline-offset-4">
                    meinen
                  </span>{" "}
                  Hausaufgaben gemacht.
                </span>
              ) : (
                <span>
                  Ich habe{" "}
                  <span className="text-[#2E7D32] font-medium bg-[#2E7D32]/10 px-1.5 py-0.5 rounded border border-[#2E7D32]/20">
                    meine
                  </span>{" "}
                  Hausaufgaben gemacht.
                </span>
              )}
            </div>
            <div
              className={`mt-6 p-4 bg-secondary/50 rounded-md border border-secondary text-foreground transition-opacity duration-500 ${heroText !== "Ich habe meinen Hausaufgaben gemacht." ? "opacity-100" : "opacity-0"}`}
            >
              <span className="font-semibold block mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                Feedback
              </span>
              <span className="text-sm">
                "Hausaufgaben" is plural, so the Akkusativ article should be
                "meine".
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mt-5 max-w-md">
            <div className="flex flex-col gap-1.5">
              <BookOpen className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">40+ writing tasks</span>
              <span className="text-xs text-muted-foreground">
                A1-B2 topics
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">Line-by-line</span>
              <span className="text-xs text-muted-foreground">
                Never overcorrects
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Users className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">Teacher notes</span>
              <span className="text-xs text-muted-foreground">
                Batch tracking
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Right side: Login Panel */}
      <div className="order-1 w-full lg:order-2 lg:w-[440px] bg-card/40 lg:bg-background flex flex-col justify-center p-8 lg:p-14 z-10 border-t lg:border-t-0 border-border/50">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8">
            <div className="w-12 h-12 bg-primary text-primary-foreground rounded-full flex items-center justify-center mb-5 shadow-md">
              <PenTool className="w-5 h-5" />
            </div>
            <h2 className="text-2xl font-serif tracking-tight">
              {formMode === "sign-in" ? "Welcome back" : "Create your account"}
            </h2>
            <p className="text-muted-foreground mt-2 text-sm">
              {formMode === "sign-in"
                ? "Sign in to your learning workspace"
                : "Set up secure access to your learning workspace"}
            </p>
          </div>

          <div className="space-y-6">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleEmailAuth();
              }}
            >
              {formMode === "sign-up" && (
                <div className="space-y-2">
                  <Label htmlFor="full-name" className="text-muted-foreground">
                    Full name
                  </Label>
                  <Input
                    id="full-name"
                    type="text"
                    placeholder="Your full name"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    autoComplete="name"
                    disabled={authMode !== "supabase" || loading}
                    className="bg-background border-border/70"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email" className="text-muted-foreground">
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  disabled={authMode !== "supabase" || loading}
                  className="bg-background border-border/70 disabled:bg-muted/50 disabled:border-border/50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-muted-foreground">
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  placeholder={
                    authMode === "supabase" ? "Enter password" : "••••••••"
                  }
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={
                    formMode === "sign-in" ? "current-password" : "new-password"
                  }
                  disabled={authMode !== "supabase" || loading}
                  className="bg-background border-border/70 disabled:bg-muted/50 disabled:border-border/50"
                />
              </div>
              {formMode === "sign-up" && enabledSignupTypeCount > 1 && (
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-muted-foreground">
                    Account type
                  </legend>
                  <div className="grid grid-cols-2 gap-2">
                    {teacherSignupEnabled && (
                      <Button
                        type="button"
                        variant={
                          accountType === "teacher" ? "default" : "outline"
                        }
                        aria-pressed={accountType === "teacher"}
                        onClick={() => setAccountType("teacher")}
                        disabled={authMode !== "supabase" || loading}
                      >
                        Teacher
                      </Button>
                    )}
                    {studentSignupEnabled && (
                      <Button
                        type="button"
                        variant={
                          accountType === "student" ? "default" : "outline"
                        }
                        aria-pressed={accountType === "student"}
                        onClick={() => setAccountType("student")}
                        disabled={authMode !== "supabase" || loading}
                      >
                        Student
                      </Button>
                    )}
                  </div>
                </fieldset>
              )}
              {formMode === "sign-up" &&
                enabledSignupTypeCount === 1 &&
                accountType && (
                  <p className="text-xs text-muted-foreground">
                    {accountType === "student"
                      ? "Creating a standard learner account. After confirming your email, you can request teacher access from your account."
                      : "Creating a teacher account."}
                  </p>
                )}
              {error && (
                <div
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                >
                  {error}
                </div>
              )}
              {showConfirmationResend && (
                <Link
                  href="/auth/check-email"
                  className="block text-center text-sm font-medium text-primary hover:underline"
                >
                  Resend confirmation email
                </Link>
              )}
              <Button
                type="submit"
                className="w-full h-11 text-base shadow-sm"
                aria-busy={loading}
                disabled={
                  authMode !== "supabase" ||
                  loading ||
                  !email ||
                  !password ||
                  (formMode === "sign-up" && !accountType)
                }
                variant={authMode === "supabase" ? "default" : "secondary"}
              >
                {loading
                  ? "Please wait..."
                  : formMode === "sign-in"
                    ? "Sign in with Email"
                    : "Create Account"}
              </Button>
              {formMode === "sign-in" && (
                <div className="text-center">
                  <Link
                    href="/auth/forgot-password"
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
              )}
              {signupEnabled && (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-muted-foreground"
                  onClick={() => {
                    setError(null);
                    setShowConfirmationResend(false);
                    setFormMode(formMode === "sign-in" ? "sign-up" : "sign-in");
                  }}
                  disabled={authMode !== "supabase" || loading}
                >
                  {formMode === "sign-in"
                    ? "Create an account"
                    : "Use an existing account"}
                </Button>
              )}
              {authMode !== "supabase" && (
                <p className="text-xs text-muted-foreground text-center">
                  Sign-in requires the Supabase environment variables.
                </p>
              )}
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
