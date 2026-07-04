import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { PenTool, GraduationCap, ArrowRight, BookOpen, Sparkles, Users } from "lucide-react";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";

export default function Login() {
  const { authMode, login, loading, needsWorkspace, role, signIn, signUp } = useAuth();
  const [, setLocation] = useLocation();
  const [isAnimating, setIsAnimating] = useState(false);
  const [heroText, setHeroText] = useState("Ich habe meinen Hausaufgaben gemacht.");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [accountType, setAccountType] = useState<"student" | "teacher">("teacher");
  const [formMode, setFormMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    if (needsWorkspace) setLocation("/teacher/onboarding");
    if (role === "student") setLocation("/student/dashboard");
    if (role === "teacher" && !needsWorkspace) setLocation("/teacher/dashboard");
  }, [needsWorkspace, role, setLocation]);

  useEffect(() => {
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
    try {
      if (formMode === "sign-in") {
        await signIn(email, password);
      } else {
        await signUp({ email, password, fullName, accountType });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed.");
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col lg:flex-row bg-background relative font-sans text-foreground">
      {/* Editorial background elements - subtle grain or gradient */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E')" }}></div>
      <div className="absolute top-[-15%] left-[-10%] w-[50%] h-[50%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Left side: Hero / Branding */}
      <div className="flex-1 flex flex-col justify-center p-8 lg:p-12 xl:p-16 relative z-10 border-r border-border/50">
        <div className="max-w-xl mx-auto lg:mx-0 w-full">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-card/50 text-muted-foreground text-sm font-medium mb-6">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-50"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
            </span>
            Interactive Demo Mode
          </div>
          <h1 className="text-4xl lg:text-5xl xl:text-6xl font-serif text-foreground tracking-tight mb-3 leading-[1.1]">
            Master German Writing, <span className="text-primary italic">Line by Line.</span>
          </h1>
          <p className="text-base lg:text-lg text-muted-foreground mb-6 max-w-md leading-relaxed">
            Precise feedback for A1-B2 learners that corrects mistakes without overcomplicating your sentences. Build confidence in your natural writing.
          </p>

          <div className="relative bg-card border border-border rounded-lg p-5 shadow-sm max-w-md font-mono text-sm leading-loose flex flex-col">
            <div className="flex items-center gap-2 mb-3 border-b border-border/50 pb-3">
              <div className="w-2.5 h-2.5 rounded-full bg-destructive/80" />
              <div className="w-2.5 h-2.5 rounded-full bg-accent/80" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#2E7D32]/80" />
            </div>
            <div className={`transition-opacity duration-500 ease-in-out ${isAnimating ? 'opacity-40' : 'opacity-100'}`}>
              <span className="text-muted-foreground/50 mr-2">01</span>
              {heroText === "Ich habe meinen Hausaufgaben gemacht." ? (
                <span>
                  Ich habe <span className="text-destructive font-medium bg-destructive/10 px-1.5 py-0.5 rounded border border-destructive/20 decoration-wavy decoration-destructive underline-offset-4">meinen</span> Hausaufgaben gemacht.
                </span>
              ) : (
                <span>
                  Ich habe <span className="text-[#2E7D32] font-medium bg-[#2E7D32]/10 px-1.5 py-0.5 rounded border border-[#2E7D32]/20">meine</span> Hausaufgaben gemacht.
                </span>
              )}
            </div>
            <div className={`mt-6 p-4 bg-secondary/50 rounded-md border border-secondary text-foreground transition-opacity duration-500 ${heroText !== "Ich habe meinen Hausaufgaben gemacht." ? "opacity-100" : "opacity-0"}`}>
              <span className="font-semibold block mb-1 text-xs uppercase tracking-wider text-muted-foreground">Feedback</span>
              <span className="text-sm">"Hausaufgaben" is plural, so the Akkusativ article should be "meine".</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mt-5 max-w-md">
            <div className="flex flex-col gap-1.5">
              <BookOpen className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">40+ prompts</span>
              <span className="text-xs text-muted-foreground">A1-B2 topics</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">Line-by-line</span>
              <span className="text-xs text-muted-foreground">Never overcorrects</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Users className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">Teacher notes</span>
              <span className="text-xs text-muted-foreground">Batch tracking</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right side: Login Panel */}
      <div className="w-full lg:w-[440px] bg-card/40 lg:bg-background flex flex-col justify-center p-8 lg:p-14 z-10 border-t lg:border-t-0 border-border/50">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8">
            <div className="w-12 h-12 bg-primary text-primary-foreground rounded-full flex items-center justify-center mb-5 shadow-md">
              <PenTool className="w-5 h-5" />
            </div>
            <h2 className="text-2xl font-serif tracking-tight">Welcome Back</h2>
            <p className="text-muted-foreground mt-2 text-sm">Sign in to your learning workspace</p>
          </div>

          <div className="space-y-6">
            <div className="space-y-4">
              {formMode === "sign-up" && (
                <div className="space-y-2">
                  <Label htmlFor="full-name" className="text-muted-foreground">Full name</Label>
                  <Input
                    id="full-name"
                    type="text"
                    placeholder="Rahul Sharma"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    disabled={authMode !== "supabase" || loading}
                    className="bg-background border-border/70"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email" className="text-muted-foreground">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={authMode !== "supabase" || loading}
                  className="bg-background border-border/70 disabled:bg-muted/50 disabled:border-border/50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-muted-foreground">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder={authMode === "supabase" ? "Enter password" : "••••••••"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={authMode !== "supabase" || loading}
                  className="bg-background border-border/70 disabled:bg-muted/50 disabled:border-border/50"
                />
              </div>
              {formMode === "sign-up" && (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={accountType === "teacher" ? "default" : "outline"}
                    onClick={() => setAccountType("teacher")}
                    disabled={authMode !== "supabase" || loading}
                  >
                    Teacher
                  </Button>
                  <Button
                    type="button"
                    variant={accountType === "student" ? "default" : "outline"}
                    onClick={() => setAccountType("student")}
                    disabled={authMode !== "supabase" || loading}
                  >
                    Student
                  </Button>
                </div>
              )}
              {error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              <Button
                className="w-full h-11 text-base shadow-sm"
                disabled={authMode !== "supabase" || loading || !email || !password}
                variant={authMode === "supabase" ? "default" : "secondary"}
                onClick={handleEmailAuth}
              >
                {loading ? "Please wait..." : formMode === "sign-in" ? "Sign in with Email" : "Create Account"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={() => {
                  setError(null);
                  setFormMode(formMode === "sign-in" ? "sign-up" : "sign-in");
                }}
                disabled={authMode !== "supabase" || loading}
              >
                {formMode === "sign-in" ? "Create a teacher or student account" : "Use an existing account"}
              </Button>
              {authMode !== "supabase" && (
                <p className="text-xs text-muted-foreground text-center">
                  Email auth turns on after Supabase env vars are added locally.
                </p>
              )}
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase tracking-widest">
                <span className="bg-card/40 lg:bg-background px-3 text-muted-foreground font-medium">Or continue as (Demo)</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Button 
                variant="outline" 
                className="h-auto py-4 flex flex-col gap-2.5 hover:border-primary hover:bg-primary/5 transition-all bg-card shadow-sm"
                onClick={() => login("student")}
              >
                <GraduationCap className="w-5 h-5 text-primary" />
                <span className="font-medium">Student</span>
              </Button>
              <Button 
                variant="outline" 
                className="h-auto py-4 flex flex-col gap-2.5 hover:border-primary hover:bg-primary/5 transition-all bg-card shadow-sm"
                onClick={() => login("teacher")}
              >
                <PenTool className="w-5 h-5 text-primary" />
                <span className="font-medium">Teacher</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
