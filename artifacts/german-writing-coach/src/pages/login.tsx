import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { PenTool, GraduationCap, ArrowRight } from "lucide-react";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";

export default function Login() {
  const { login, role } = useAuth();
  const [, setLocation] = useLocation();
  const [isAnimating, setIsAnimating] = useState(false);
  const [heroText, setHeroText] = useState("Ich habe meinen Hausaufgaben gemacht.");
  
  useEffect(() => {
    if (role === "student") setLocation("/student/dashboard");
    if (role === "teacher") setLocation("/teacher/dashboard");
  }, [role, setLocation]);

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

  return (
    <div className="min-h-[100dvh] flex flex-col lg:flex-row bg-background relative overflow-hidden font-sans text-foreground">
      {/* Editorial background elements - subtle grain or gradient */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E')" }}></div>
      <div className="absolute top-[-15%] left-[-10%] w-[50%] h-[50%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Left side: Hero / Branding */}
      <div className="flex-1 flex flex-col justify-center p-8 lg:p-16 xl:p-24 relative z-10 border-r border-border/50">
        <div className="max-w-xl mx-auto lg:mx-0">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-card/50 text-muted-foreground text-sm font-medium mb-8">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-50"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
            </span>
            Interactive Demo Mode
          </div>
          <h1 className="text-5xl lg:text-7xl font-serif text-foreground tracking-tight mb-6 leading-[1.1]">
            Master German Writing, <span className="text-primary italic">Line by Line.</span>
          </h1>
          <p className="text-lg text-muted-foreground mb-12 max-w-md leading-relaxed">
            Precise feedback for A1/A2 learners that corrects mistakes without overcomplicating your sentences. Build confidence in your natural writing.
          </p>

          <div className="relative bg-card border border-border rounded-lg p-8 shadow-sm max-w-md font-mono text-sm leading-loose">
            <div className="flex items-center gap-2 mb-6 border-b border-border/50 pb-4">
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
            {heroText !== "Ich habe meinen Hausaufgaben gemacht." && (
              <div className="mt-6 p-4 bg-secondary/50 rounded-md border border-secondary text-foreground animate-in fade-in slide-in-from-bottom-2 duration-500">
                <span className="font-semibold block mb-1 text-xs uppercase tracking-wider text-muted-foreground">Feedback</span>
                <span className="text-sm">"Hausaufgaben" is plural, so the Akkusativ article should be "meine".</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right side: Login Panel */}
      <div className="w-full lg:w-[480px] bg-background flex flex-col justify-center p-8 lg:p-16 z-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="text-center mb-10">
            <div className="w-14 h-14 bg-primary text-primary-foreground rounded-full mx-auto flex items-center justify-center mb-6 shadow-md">
              <PenTool className="w-6 h-6" />
            </div>
            <h2 className="text-3xl font-serif tracking-tight">Welcome Back</h2>
            <p className="text-muted-foreground mt-3">Sign in to your learning workspace</p>
          </div>

          <div className="space-y-8">
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-muted-foreground">Email</Label>
                <Input id="email" type="email" placeholder="name@example.com" disabled className="bg-muted/50 border-border/50" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-muted-foreground">Password</Label>
                <Input id="password" type="password" disabled value="••••••••" className="bg-muted/50 border-border/50" />
              </div>
              <Button className="w-full h-11 text-base shadow-sm" disabled variant="secondary">
                Sign in with Email
              </Button>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase tracking-widest">
                <span className="bg-background px-3 text-muted-foreground font-medium">Or continue as (Demo)</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Button 
                variant="outline" 
                className="h-auto py-5 flex flex-col gap-3 hover:border-primary hover:bg-primary/5 transition-all bg-card shadow-sm"
                onClick={() => login("student")}
              >
                <GraduationCap className="w-5 h-5 text-primary" />
                <span className="font-medium">Student</span>
              </Button>
              <Button 
                variant="outline" 
                className="h-auto py-5 flex flex-col gap-3 hover:border-primary hover:bg-primary/5 transition-all bg-card shadow-sm"
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
