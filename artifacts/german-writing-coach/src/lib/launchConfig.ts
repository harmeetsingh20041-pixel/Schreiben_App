function envFlag(name: string, defaultValue = false) {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export const launchConfig = {
  enableDemoMode: envFlag("VITE_ENABLE_DEMO_MODE", false),
  enablePublicTeacherSignup: envFlag("VITE_ENABLE_PUBLIC_TEACHER_SIGNUP", false),
  enablePublicStudentSignup: envFlag("VITE_ENABLE_PUBLIC_STUDENT_SIGNUP", true),
  sentryDsn: (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? "",
  sentryEnvironment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? "",
  appRelease: (import.meta.env.VITE_APP_RELEASE as string | undefined) ?? "",
  enableSentryReplay: envFlag("VITE_SENTRY_ENABLE_REPLAY", false),
};

export function isSignupEnabled(accountType: "student" | "teacher") {
  return accountType === "teacher"
    ? launchConfig.enablePublicTeacherSignup
    : launchConfig.enablePublicStudentSignup;
}
