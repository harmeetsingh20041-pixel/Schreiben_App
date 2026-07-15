import { AlertCircle, CheckCircle2, Clock, FileText, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FeedbackMode, WritingSubmissionStatus } from "@/services/submissionService";

const fallbackStatus: WritingSubmissionStatus = "submitted";

const statusMeta = {
  draft: {
    label: "Draft",
    icon: FileText,
    className: "bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-600",
    issueLabel: "Draft saved",
    studentSummary: "This draft has not been submitted yet.",
    actionLabel: "Open submission",
  },
  submitted: {
    label: "Feedback pending",
    icon: Clock,
    className: "bg-amber-100 text-amber-950 border-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-700",
    issueLabel: "Feedback pending",
    studentSummary: "Feedback is being prepared.",
    actionLabel: "Open submission",
  },
  checking: {
    label: "Preparing feedback",
    icon: Loader2,
    className: "bg-blue-100 text-blue-950 border-blue-300 dark:bg-blue-950 dark:text-blue-100 dark:border-blue-700",
    issueLabel: "Preparing feedback",
    studentSummary: "Feedback is being prepared.",
    actionLabel: "Open submission",
  },
  checked: {
    label: "Feedback ready",
    icon: CheckCircle2,
    className: "bg-green-100 text-green-950 border-green-300 dark:bg-green-950 dark:text-green-100 dark:border-green-700",
    issueLabel: "Line-by-line feedback ready",
    studentSummary: "Line-by-line feedback is ready.",
    actionLabel: "Open feedback",
  },
  needs_review: {
    label: "Teacher review",
    icon: AlertCircle,
    className: "bg-orange-100 text-orange-950 border-orange-300 dark:bg-orange-950 dark:text-orange-100 dark:border-orange-700",
    issueLabel: "Teacher review required",
    studentSummary: "Your teacher is reviewing this feedback.",
    actionLabel: "View submission",
  },
  failed: {
    label: "Feedback failed",
    icon: XCircle,
    className: "bg-red-100 text-red-950 border-red-300 dark:bg-red-950 dark:text-red-100 dark:border-red-700",
    issueLabel: "Feedback failed",
    studentSummary: "Feedback could not be prepared. Please ask your teacher.",
    actionLabel: "Open submission",
  },
} satisfies Record<
  WritingSubmissionStatus,
  {
    label: string;
    icon: typeof CheckCircle2;
    className: string;
    issueLabel: string;
    studentSummary: string;
    actionLabel: string;
  }
>;

interface SubmissionStatusContext {
  status: WritingSubmissionStatus | string | null | undefined;
  feedback_mode?: FeedbackMode | string | null;
  feedback_scheduled_at?: string | null;
}

type SubmissionStatusInput = SubmissionStatusContext | WritingSubmissionStatus | string | null | undefined;

function normalizeStatus(status: WritingSubmissionStatus | string | null | undefined): WritingSubmissionStatus {
  return status && status in statusMeta ? (status as WritingSubmissionStatus) : fallbackStatus;
}

function getStatusContext(input: SubmissionStatusInput): SubmissionStatusContext {
  if (input && typeof input === "object") {
    return input;
  }
  return { status: input };
}

function formatRelativeDueTime(value: string | null | undefined) {
  if (!value) return "Scheduled for later";
  const dueAt = new Date(value).getTime();
  if (Number.isNaN(dueAt)) return "Scheduled for later";
  const diffMs = dueAt - Date.now();
  if (diffMs <= 0) return "Due now";
  const minutes = Math.ceil(diffMs / 60000);
  if (minutes < 60) return `Due in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `Due in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.ceil(hours / 24);
  return `Due in ${days} day${days === 1 ? "" : "s"}`;
}

export function getSubmissionStatusMeta(input: SubmissionStatusInput) {
  const context = getStatusContext(input);
  const status = normalizeStatus(context.status);
  const base = statusMeta[status];

  if (status !== "submitted") {
    return base;
  }

  if (context.feedback_mode === "teacher_review_only") {
    return {
      ...base,
      label: "Waiting for review",
      className: "bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-600",
      issueLabel: "Waiting for review",
      studentSummary: "Your teacher will review the feedback before it is released.",
    };
  }

  if (context.feedback_mode === "automatic_delayed") {
    const dueLabel = formatRelativeDueTime(context.feedback_scheduled_at);
    return {
      ...base,
      label: dueLabel === "Due now" ? "Feedback pending" : "Scheduled for later",
      issueLabel: dueLabel,
      studentSummary: "Feedback is being prepared. Check back later for line-by-line feedback.",
    };
  }

  return base;
}

export function getSubmissionIssueLabel(input: SubmissionStatusInput) {
  return getSubmissionStatusMeta(input).issueLabel;
}

export function getSubmissionStudentSummary(input: SubmissionStatusInput) {
  return getSubmissionStatusMeta(input).studentSummary;
}

export function getSubmissionActionLabel(input: SubmissionStatusInput) {
  return getSubmissionStatusMeta(input).actionLabel;
}

export function isFeedbackReadyStatus(input: SubmissionStatusInput) {
  return normalizeStatus(getStatusContext(input).status) === "checked";
}

interface SubmissionStatusBadgeProps {
  status: WritingSubmissionStatus | string | null | undefined;
  feedbackMode?: FeedbackMode | string | null;
  feedbackScheduledAt?: string | null;
  className?: string;
}

export function SubmissionStatusBadge({ status, feedbackMode, feedbackScheduledAt, className }: SubmissionStatusBadgeProps) {
  const meta = getSubmissionStatusMeta({
    status,
    feedback_mode: feedbackMode,
    feedback_scheduled_at: feedbackScheduledAt,
  });
  const Icon = meta.icon;

  return (
    <Badge variant="outline" className={cn("font-semibold shadow-sm", meta.className, className)}>
      <Icon aria-hidden="true" className={cn("w-3 h-3 mr-1", normalizeStatus(status) === "checking" && "animate-spin")} />
      {meta.label}
    </Badge>
  );
}
