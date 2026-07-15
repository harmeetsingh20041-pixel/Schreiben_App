function envFlag(value: string | undefined, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export const launchConfig = {
  enablePublicTeacherSignup: envFlag(
    import.meta.env.VITE_ENABLE_PUBLIC_TEACHER_SIGNUP,
    false,
  ),
  enablePublicStudentSignup: envFlag(
    import.meta.env.VITE_ENABLE_PUBLIC_STUDENT_SIGNUP,
    true,
  ),
  sentryDsn: (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? "",
  sentryEnvironment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? "",
  appRelease: (import.meta.env.VITE_APP_RELEASE as string | undefined) ?? "",
  enableSentryReplay: envFlag(import.meta.env.VITE_SENTRY_ENABLE_REPLAY, false),
};

export function isSignupEnabled(accountType: "student" | "teacher") {
  return accountType === "teacher"
    ? launchConfig.enablePublicTeacherSignup
    : launchConfig.enablePublicStudentSignup;
}
