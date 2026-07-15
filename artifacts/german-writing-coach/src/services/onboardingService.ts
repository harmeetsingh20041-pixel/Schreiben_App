import { PublicAppError, isPublicAppError } from "@/lib/appError";
import { callApiRpc, parseApiRecord } from "@/services/apiFacade";

export type OnboardingRole = "teacher" | "student";
export type TeacherOnboardingStep =
  | "create_class"
  | "choose_feedback_mode"
  | "share_join_code"
  | "review_first_submission";
export type StudentOnboardingStep =
  | "join_class"
  | "submit_writing"
  | "review_feedback"
  | "start_practice";
export type OnboardingStep = TeacherOnboardingStep | StudentOnboardingStep;

const stepsByRole: Record<OnboardingRole, readonly OnboardingStep[]> = {
  teacher: [
    "create_class",
    "choose_feedback_mode",
    "share_join_code",
    "review_first_submission",
  ],
  student: [
    "join_class",
    "submit_writing",
    "review_feedback",
    "start_practice",
  ],
};

export interface OnboardingProgress {
  role: OnboardingRole;
  revision: number;
  steps: OnboardingStep[];
  completed_steps: OnboardingStep[];
  completed_count: number;
  total_count: number;
  all_complete: boolean;
  next_step: OnboardingStep | null;
}

function parseInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value;
}

function parseSteps(value: unknown, role: OnboardingRole, label: string): OnboardingStep[] {
  const allowed = new Set(stepsByRole[role]);
  if (
    !Array.isArray(value)
    || value.some((step) => typeof step !== "string" || !allowed.has(step as OnboardingStep))
    || new Set(value).size !== value.length
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      `${label} returned an invalid response. Please refresh and try again.`,
    );
  }
  return value as OnboardingStep[];
}

function parseProgress(value: unknown): OnboardingProgress {
  const row = parseApiRecord<Record<string, unknown>>(value, "Onboarding progress");
  if (row.role !== "teacher" && row.role !== "student") {
    throw new PublicAppError(
      "data_invalid_response",
      "Onboarding progress returned an invalid response. Please refresh and try again.",
    );
  }
  const role = row.role;
  const steps = parseSteps(row.steps, role, "Onboarding progress");
  const completedSteps = parseSteps(row.completed_steps, role, "Onboarding progress");
  const revision = parseInteger(row.revision, "Onboarding progress");
  const completedCount = parseInteger(row.completed_count, "Onboarding progress");
  const totalCount = parseInteger(row.total_count, "Onboarding progress");
  const nextStep = row.next_step === null
    ? null
    : parseSteps([row.next_step], role, "Onboarding progress")[0];

  if (
    steps.length !== stepsByRole[role].length
    || steps.some((step, index) => step !== stepsByRole[role][index])
    || completedCount !== completedSteps.length
    || totalCount !== steps.length
    || row.all_complete !== (completedCount === totalCount)
    || (nextStep !== null && completedSteps.includes(nextStep))
  ) {
    throw new PublicAppError(
      "data_invalid_response",
      "Onboarding progress returned an invalid response. Please refresh and try again.",
    );
  }

  return {
    role,
    revision,
    steps,
    completed_steps: completedSteps,
    completed_count: completedCount,
    total_count: totalCount,
    all_complete: row.all_complete as boolean,
    next_step: nextStep,
  };
}

export async function getOnboardingProgress(
  workspaceId: string,
  role: OnboardingRole,
) {
  return parseProgress(await callApiRpc<unknown>("get_onboarding_progress", {
    target_workspace_id: workspaceId,
    target_role: role,
  }));
}

export async function completeOnboardingStep(
  workspaceId: string,
  role: OnboardingRole,
  step: OnboardingStep,
  expectedRevision: number,
) {
  if (!stepsByRole[role].includes(step)) {
    throw new PublicAppError("data_invalid_request", "This checklist step is not available for the active role.");
  }
  return parseProgress(await callApiRpc<unknown>("complete_onboarding_step", {
    target_workspace_id: workspaceId,
    target_role: role,
    target_step: step,
    expected_revision: expectedRevision,
  }));
}

export async function markOnboardingStep(
  workspaceId: string,
  role: OnboardingRole,
  step: OnboardingStep,
) {
  let progress = await getOnboardingProgress(workspaceId, role);
  if (progress.completed_steps.includes(step)) return progress;

  try {
    return await completeOnboardingStep(workspaceId, role, step, progress.revision);
  } catch (error) {
    if (!isPublicAppError(error) || error.code !== "data_conflict") throw error;
    progress = await getOnboardingProgress(workspaceId, role);
    if (progress.completed_steps.includes(step)) return progress;
    return completeOnboardingStep(workspaceId, role, step, progress.revision);
  }
}
