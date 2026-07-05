import { AlertCircle, CheckCircle2, Clock, FileText, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { WritingSubmissionStatus } from "@/services/submissionService";

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
    label: "Needs review",
    icon: AlertCircle,
    className: "bg-orange-100 text-orange-950 border-orange-300 dark:bg-orange-950 dark:text-orange-100 dark:border-orange-700",
    issueLabel: "Needs review",
    studentSummary: "Your teacher is reviewing this feedback.",
    actionLabel: "Open feedback",
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

function normalizeStatus(status: WritingSubmissionStatus | string | null | undefined): WritingSubmissionStatus {
  return status && status in statusMeta ? (status as WritingSubmissionStatus) : fallbackStatus;
}

export function getSubmissionStatusMeta(status: WritingSubmissionStatus | string | null | undefined) {
  return statusMeta[normalizeStatus(status)];
}

export function getSubmissionIssueLabel(status: WritingSubmissionStatus | string | null | undefined) {
  return getSubmissionStatusMeta(status).issueLabel;
}

export function getSubmissionStudentSummary(status: WritingSubmissionStatus | string | null | undefined) {
  return getSubmissionStatusMeta(status).studentSummary;
}

export function getSubmissionActionLabel(status: WritingSubmissionStatus | string | null | undefined) {
  return getSubmissionStatusMeta(status).actionLabel;
}

export function isFeedbackReadyStatus(status: WritingSubmissionStatus | string | null | undefined) {
  return normalizeStatus(status) === "checked";
}

interface SubmissionStatusBadgeProps {
  status: WritingSubmissionStatus | string | null | undefined;
  className?: string;
}

export function SubmissionStatusBadge({ status, className }: SubmissionStatusBadgeProps) {
  const meta = getSubmissionStatusMeta(status);
  const Icon = meta.icon;

  return (
    <Badge variant="outline" className={cn("font-semibold shadow-sm", meta.className, className)}>
      <Icon className={cn("w-3 h-3 mr-1", normalizeStatus(status) === "checking" && "animate-spin")} />
      {meta.label}
    </Badge>
  );
}
