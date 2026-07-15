const PROJECT_URL_PATTERN = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/;

function enabled(value: string | undefined) {
  return value != null && ["1", "true", "yes", "on"].includes(
    value.trim().toLowerCase(),
  );
}

export type ProductionLaunchManifest = {
  schema_version: 1;
  app_release: string;
  supabase_url: string;
  supabase_project_ref: string;
  base_path: string;
  demo_mode_enabled: boolean;
  public_teacher_signup_enabled: boolean;
  public_student_signup_enabled: boolean;
  sentry_environment: string;
  sentry_replay_enabled: boolean;
  sentry_source_maps_configured: boolean;
};

export function buildProductionLaunchManifest(
  environment: Record<string, string | undefined>,
  basePath: string,
  sentrySourceMapsConfigured = false,
): ProductionLaunchManifest {
  const supabaseUrl = environment.VITE_SUPABASE_URL?.trim() ?? "";
  const projectRef = PROJECT_URL_PATTERN.exec(supabaseUrl)?.[1] ?? "";
  return {
    schema_version: 1,
    app_release: environment.VITE_APP_RELEASE?.trim() ?? "",
    supabase_url: supabaseUrl.replace(/\/+$/, ""),
    supabase_project_ref: projectRef,
    base_path: basePath,
    demo_mode_enabled: enabled(environment.VITE_ENABLE_DEMO_MODE),
    public_teacher_signup_enabled: enabled(
      environment.VITE_ENABLE_PUBLIC_TEACHER_SIGNUP,
    ),
    public_student_signup_enabled: enabled(
      environment.VITE_ENABLE_PUBLIC_STUDENT_SIGNUP,
    ),
    sentry_environment: environment.VITE_SENTRY_ENVIRONMENT?.trim() ?? "",
    sentry_replay_enabled: enabled(environment.VITE_SENTRY_ENABLE_REPLAY),
    sentry_source_maps_configured: sentrySourceMapsConfigured,
  };
}
