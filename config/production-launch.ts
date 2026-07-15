function enabled(value: string | undefined) {
  return (
    value != null &&
    ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
  );
}

export function assertSafeProductionLaunchFlags(
  environment: Record<string, string | undefined>,
) {
  if (environment.NODE_ENV !== "production") return;
  if (enabled(environment.VITE_ENABLE_DEMO_MODE)) {
    throw new Error("Production build blocked: demo mode must be disabled.");
  }
  if (enabled(environment.VITE_ENABLE_PUBLIC_TEACHER_SIGNUP)) {
    throw new Error(
      "Production build blocked: public teacher signup must be disabled.",
    );
  }
  if (!enabled(environment.VITE_ENABLE_PUBLIC_STUDENT_SIGNUP)) {
    throw new Error(
      "Production build blocked: public student signup must be enabled.",
    );
  }
}
