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
    <div className="min-h-[100dvh] flex flex-col lg:flex-row bg-background relative overflow-hidden">
      {/* Decorative background elements */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] bg-accent/10 rounded-full blur-[80px] pointer-events-none" />

      {/* Left side: Hero / Branding */}
      <div className="flex-1 flex flex-col justify-center p-8 lg:p-16 relative z-10">
        <div className="max-w-xl mx-auto lg:mx-0">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium mb-6">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
            </span>
            Interactive Demo Mode
          </div>
          <h1 className="text-4xl lg:text-6xl font-extrabold text-foreground tracking-tight mb-6 leading-tight">
            Master German Writing, <span className="text-primary">Line by Line.</span>
          </h1>
          <p className="text-lg text-muted-foreground mb-12 max-w-md">
            Precise feedback for A1/A2 learners that corrects mistakes without overcomplicating your sentences. Build confidence in your natural writing.
          </p>

          <div className="relative bg-card border border-border rounded-xl p-6 shadow-xl shadow-primary/5 max-w-md font-mono text-sm">
            <div className="flex items-center gap-2 mb-4 border-b border-border pb-2">
              <div className="w-3 h-3 rounded-full bg-destructive" />
              <div className="w-3 h-3 rounded-full bg-accent" />
              <div className="w-3 h-3 rounded-full bg-green-500" />
            </div>
            <div className={`transition-opacity duration-300 ${isAnimating ? 'opacity-50' : 'opacity-100'}`}>
              <span className="text-muted-foreground">&gt; </span>
              {heroText === "Ich habe meinen Hausaufgaben gemacht." ? (
                <span>
                  Ich habe <span className="text-destructive font-semibold bg-destructive/10 px-1 rounded">meinen</span> Hausaufgaben gemacht.
                </span>
              ) : (
                <span>
                  Ich habe <span className="text-green-600 font-semibold bg-green-500/10 px-1 rounded">meine</span> Hausaufgaben gemacht.
                </span>
              )}
            </div>
            {heroText !== "Ich habe meinen Hausaufgaben gemacht." && (
              <div className="mt-4 p-3 bg-secondary rounded-lg text-secondary-foreground animate-in slide-in-from-bottom-2 fade-in">
                <span className="font-semibold block mb-1">Feedback:</span>
                "Hausaufgaben" is plural, so the Akkusativ article should be "meine".
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right side: Login Panel */}
      <div className="w-full lg:w-[480px] bg-card border-l border-border flex flex-col justify-center p-8 lg:p-12 z-10 shadow-2xl">
        <div className="mx-auto w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-primary rounded-2xl mx-auto flex items-center justify-center shadow-lg shadow-primary/20 mb-6">
              <PenTool className="w-8 h-8 text-primary-foreground" />
            </div>
            <h2 className="text-2xl font-bold">Welcome Back</h2>
            <p className="text-muted-foreground mt-2">Sign in to your learning workspace</p>
          </div>

          <div className="space-y-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" placeholder="name@example.com" disabled />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" disabled value="••••••••" />
              </div>
              <Button className="w-full" disabled variant="secondary">
                Sign in with Email
              </Button>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground font-medium">Or continue as (Demo)</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Button 
                variant="outline" 
                className="h-auto py-4 flex flex-col gap-2 hover:border-primary hover:bg-primary/5 transition-all"
                onClick={() => login("student")}
              >
                <GraduationCap className="w-6 h-6 text-primary" />
                <span>Student</span>
              </Button>
              <Button 
                variant="outline" 
                className="h-auto py-4 flex flex-col gap-2 hover:border-primary hover:bg-primary/5 transition-all"
                onClick={() => login("teacher")}
              >
                <PenTool className="w-6 h-6 text-primary" />
                <span>Teacher</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
