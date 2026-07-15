import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CheckCircle2, ChevronDown, Circle, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/lib/auth";
import {
  type OnboardingRole,
  type OnboardingStep,
} from "@/services/onboardingService";
import { createOnboardingProgressQuery } from "@/lib/onboardingQueries";

interface ChecklistItem {
  step: OnboardingStep;
  label: string;
  description: string;
  href: string;
  action: string;
}

const checklistItems: Record<OnboardingRole, ChecklistItem[]> = {
  teacher: [
    {
      step: "create_class",
      label: "Create your first class",
      description: "Set a clear name and CEFR level.",
      href: "/teacher/batches",
      action: "Open Classes",
    },
    {
      step: "choose_feedback_mode",
      label: "Choose a feedback mode",
      description: "Decide between immediate, scheduled, or teacher review.",
      href: "/teacher/batches",
      action: "Choose mode",
    },
    {
      step: "share_join_code",
      label: "Share the class code",
      description: "Students request access; you approve every request.",
      href: "/teacher/batches",
      action: "View code",
    },
    {
      step: "review_first_submission",
      label: "Check the first result",
      description:
        "Confirm that automatic feedback reached the student; edit only if the system held an exception.",
      href: "/teacher/submissions",
      action: "View results",
    },
  ],
  student: [
    {
      step: "join_class",
      label: "Join a class",
      description: "Enter the code from your teacher and wait for approval.",
      href: "/student/dashboard",
      action: "Join class",
    },
    {
      step: "submit_writing",
      label: "Submit your first writing",
      description: "Choose the correct class before you start.",
      href: "/student/questions",
      action: "Start writing",
    },
    {
      step: "review_feedback",
      label: "Review released feedback",
      description: "Read the line-by-line explanations after release.",
      href: "/student/history",
      action: "Open history",
    },
    {
      step: "start_practice",
      label: "Start targeted practice",
      description: "Work on a topic unlocked by released feedback.",
      href: "/student/practice",
      action: "Open practice",
    },
  ],
};

const tourSteps: Record<
  OnboardingRole,
  Array<{ title: string; description: string }>
> = {
  teacher: [
    {
      title: "Create and configure a class",
      description:
        "Classes keep enrollment, CEFR level, feedback timing, and student work in one explicit context.",
    },
    {
      title: "Approve student access",
      description:
        "A join code only creates a request. Check Students to approve or reject it safely.",
    },
    {
      title: "Let the system handle routine feedback",
      description:
        "Validated immediate and scheduled feedback is released automatically. The review queue is only for exceptions and classes where you explicitly choose teacher review.",
    },
    {
      title: "Step in only when needed",
      description:
        "Private, partial, or uncertain work stays hidden. If both automatic checks cannot safely agree, one clear item appears for you instead of reaching the student.",
    },
  ],
  student: [
    {
      title: "Choose the right class",
      description:
        "When you belong to more than one class, select the class before starting a writing.",
    },
    {
      title: "Your work saves while you write",
      description:
        "Writing and worksheet answers show Saving, Saved, or a safe conflict message.",
    },
    {
      title: "Feedback release is visible",
      description:
        "You can see whether feedback is processing, scheduled, held for review, or released.",
    },
    {
      title: "Practice follows your needs",
      description:
        "Released feedback unlocks targeted worksheets and later practice can resolve a weakness.",
    },
  ],
};

function ContextualTour({ role }: { role: OnboardingRole }) {
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const dialogOpenerRef = useRef<HTMLButtonElement | null>(null);
  const steps = tourSteps[role];
  const step = steps[stepIndex];

  return (
    <>
      <Button
        ref={dialogOpenerRef}
        type="button"
        variant="outline"
        size="sm"
        onClick={(event) => {
          dialogOpenerRef.current = event.currentTarget;
          setStepIndex(0);
          setOpen(true);
        }}
      >
        <Compass className="h-4 w-4" aria-hidden="true" />
        Replay tour
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            dialogOpenerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{step.title}</DialogTitle>
            <DialogDescription>
              {role === "teacher" ? "Teacher" : "Student"} tour · Step{" "}
              {stepIndex + 1} of {steps.length}
            </DialogDescription>
          </DialogHeader>
          <p
            className="py-4 text-sm leading-6 text-foreground"
            aria-live="polite"
          >
            {step.description}
          </p>
          <DialogFooter className="gap-2 sm:space-x-0">
            {stepIndex > 0 && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setStepIndex((current) => current - 1)}
              >
                Back
              </Button>
            )}
            {stepIndex < steps.length - 1 ? (
              <Button
                type="button"
                onClick={() => setStepIndex((current) => current + 1)}
              >
                Next
              </Button>
            ) : (
              <Button type="button" onClick={() => setOpen(false)}>
                Finish
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function OnboardingChecklist({ role }: { role: OnboardingRole }) {
  const { activeWorkspaceId, authMode, user } = useAuth();
  const [completedChecklistExpanded, setCompletedChecklistExpanded] =
    useState(false);
  const enabled = authMode === "supabase" && Boolean(user && activeWorkspaceId);
  const progressQuery = useQuery({
    ...createOnboardingProgressQuery(
      activeWorkspaceId ?? "inactive-workspace",
      role,
    ),
    enabled,
  });

  if (!enabled) return null;

  if (progressQuery.isLoading) {
    return (
      <Card className="mb-8" aria-busy="true">
        <CardContent
          className="py-5 text-sm text-muted-foreground"
          role="status"
        >
          Loading your launch checklist…
        </CardContent>
      </Card>
    );
  }

  if (progressQuery.isError || !progressQuery.data) {
    return (
      <Card className="mb-8 border-amber-200 bg-amber-50/50">
        <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            Your checklist could not be loaded. The rest of the app is still
            available.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void progressQuery.refetch()}
          >
            Retry checklist
          </Button>
        </CardContent>
      </Card>
    );
  }

  const progress = progressQuery.data;
  const completed = new Set(progress.completed_steps);
  const percent = Math.round(
    (progress.completed_count / progress.total_count) * 100,
  );
  const detailsId = `${role}-launch-checklist-details`;
  const showDetails = !progress.all_complete || completedChecklistExpanded;

  return (
    <Card className="mb-8 border-primary/20 bg-primary/[0.03]">
      <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-lg">
            {progress.all_complete
              ? "Launch checklist complete"
              : `${role === "teacher" ? "Teacher" : "Student"} launch checklist`}
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {progress.completed_count} of {progress.total_count} steps complete
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {progress.all_complete && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={completedChecklistExpanded}
              aria-controls={detailsId}
              onClick={() =>
                setCompletedChecklistExpanded((current) => !current)
              }
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${completedChecklistExpanded ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
              {completedChecklistExpanded
                ? "Hide completed checklist"
                : "Show completed checklist"}
            </Button>
          )}
          <ContextualTour role={role} />
        </div>
      </CardHeader>
      <CardContent id={detailsId} hidden={!showDetails}>
        <Progress
          value={percent}
          aria-label={`${progress.completed_count} of ${progress.total_count} onboarding steps complete`}
          className="mb-5"
        />
        <ol className="grid gap-3 md:grid-cols-2">
          {checklistItems[role].map((item) => {
            const isComplete = completed.has(item.step);
            return (
              <li
                key={item.step}
                className={`rounded-lg border p-4 ${isComplete ? "bg-muted/40" : "bg-card"}`}
              >
                <div className="flex items-start gap-3">
                  {isComplete ? (
                    <CheckCircle2
                      className="mt-0.5 h-5 w-5 shrink-0 text-green-700"
                      aria-hidden="true"
                    />
                  ) : (
                    <Circle
                      className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      <span className="sr-only">
                        {isComplete ? "Complete: " : "Not complete: "}
                      </span>
                      {item.label}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {item.description}
                    </p>
                    {!isComplete && (
                      <Button
                        asChild
                        variant="link"
                        className="mt-2 h-auto min-h-0 justify-start p-0"
                      >
                        <Link href={item.href}>{item.action}</Link>
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
