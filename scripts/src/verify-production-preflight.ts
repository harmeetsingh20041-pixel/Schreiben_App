import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hasExactApprovedProductionEdgeFunctions } from "./production-edge-functions.js";
import { buildQstashScheduleIds } from "./qstash-recovery-schedules.js";

const MINIMUM_FRONTEND_ENVIRONMENT = [
  "PORT",
  "BASE_PATH",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_ENABLE_DEMO_MODE",
  "VITE_ENABLE_PUBLIC_TEACHER_SIGNUP",
  "VITE_ENABLE_PUBLIC_STUDENT_SIGNUP",
  "VITE_SENTRY_DSN",
  "VITE_SENTRY_ENVIRONMENT",
  "VITE_APP_RELEASE",
  "VITE_SENTRY_ENABLE_REPLAY",
  "SENTRY_UPLOAD_SOURCE_MAPS",
] as const;
const MINIMUM_COLLECTOR_ENVIRONMENT = [
  "LOCAL_SUPABASE_DB_URL",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PRODUCTION_PROJECT_REF",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_API_BASE_URL",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "PRODUCTION_PREFLIGHT_EXPECTATIONS_JSON",
  "PRODUCTION_OPERATIONS_EVIDENCE_JSON",
] as const;
const MINIMUM_EDGE_SECRETS = [
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_ALLOW_PRIMARY_AUTH_FAILOVER",
  "PROCESS_FEEDBACK_SECRET",
  "PROCESS_WRITING_JOBS_SECRET",
  "PROCESS_WORKSHEET_JOBS_SECRET",
  "PROCESS_WORKSHEET_ANSWER_JOBS_SECRET",
  "PROCESS_RECOVERY_SECRET",
] as const;
const GEMINI_V1_ANSWER_MODEL = "gemini-3.1-flash-lite";
const GEMINI_V1_CRITIC_MODEL = "gemini-3.1-flash-lite";
const GEMINI_V1_STRONG_MODEL = "gemini-3.1-flash-lite";
const DEEPSEEK_V1_FLASH_MODEL = "deepseek-v4-flash";
export const V1_GLOBAL_MONTHLY_AI_CAP_MICROUSD = 225_000_000;
export const V1_DEFAULT_WORKSPACE_MONTHLY_AI_CAP_MICROUSD = 100_000_000;
const RETIRED_EDGE_MODEL_SECRETS = [
  "DEEPSEEK_MODEL",
  "DEEPSEEK_FLASH_MODEL",
  "DEEPSEEK_PRO_MODEL",
  "DEEPSEEK_PRACTICE_MODEL",
  "DEEPSEEK_WORKSHEET_MODEL",
  "DEEPSEEK_WORKSHEET_CRITIC_MODEL",
] as const;
const MINIMUM_RECONCILIATION_CRONS = [
  "reconcile-writing-jobs-every-30-seconds",
  "reconcile-worksheet-generation-every-30-seconds",
  "reconcile-worksheet-evaluation-every-30-seconds",
  "reconcile-ai-spend-reservations-every-30-seconds",
  "drain-practice-cycle-transitions-every-30-seconds",
] as const;
const REQUIRED_RELEASE_CRON = "release-due-feedback-every-30-seconds";
const MINIMUM_REALTIME_TABLES = [
  "submission_status_events",
  "practice_assignment_status_events",
  "practice_attempt_status_events",
] as const;
const MINIMUM_HEALTHY_SERVICES = ["auth", "db", "rest", "realtime"] as const;
const MINIMUM_SUPPORTED_SERVER_VERSION_NUM = 170_000;
const MINIMUM_MONITORING_ALERTS = [
  "queue_age",
  "job_retries",
  "dead_letters",
  "provider_latency",
  "held_feedback",
  "worksheet_rejection",
  "auth_failures",
  "frontend_errors",
] as const;
const AUTH_RATE_LIMIT_KEYS = [
  "rate_limit_email_sent",
  "rate_limit_verify",
  "rate_limit_token_refresh",
  "rate_limit_otp",
] as const;
type AuthRateLimitKey = (typeof AUTH_RATE_LIMIT_KEYS)[number];

export type ProductionExternalSchedulerContract = {
  provider: "upstash_qstash";
  region: "eu-central-1";
  schedule_id_prefix: "schreiben-v1-recovery";
  schedule_id_suffixes: ["minute-00", "minute-30"];
  destination_path: "/functions/v1/recover-async-jobs";
  cron: "* * * * *";
  delivery_delays_seconds: [0, 30];
  effective_max_gap_seconds: 30;
  method: "POST";
  body_sha256: string;
  timeout_seconds: 10;
  retries: 2;
  retry_delay_expression: "1000 * (1 + retried)";
  forwarded_header_name: "x-process-recovery-secret";
  baseline_deliveries_per_day: 2880;
  free_plan_daily_message_limit: 1000;
  accepted_billing_plans: ["pay_as_you_go", "fixed", "enterprise"];
  contract_sha256: string;
};

export type ProductionAuthSecurityContract = {
  jwt_expiry_seconds: 600;
  totp_enrollment_enabled: true;
  totp_verification_enabled: true;
  minimum_verified_totp_factors_per_platform_admin: 2;
};

export type ProductionPreflightContract = {
  schema_version: 1;
  minimum_server_version_num: number;
  required_frontend_environment: string[];
  required_collector_environment: string[];
  required_edge_secret_names: string[];
  required_edge_functions: string[];
  required_edge_function_verify_jwt: Record<string, boolean>;
  required_reconciliation_cron_jobs: string[];
  required_release_cron_job: string;
  required_realtime_tables: string[];
  required_healthy_services: string[];
  required_auth_security: ProductionAuthSecurityContract;
  required_external_scheduler: ProductionExternalSchedulerContract;
  required_monitoring_alerts: string[];
  maximum_heartbeat_age_seconds: number;
  maximum_completed_backup_age_hours: number;
  maximum_restore_drill_age_days: number;
  maximum_scheduler_test_age_hours: number;
  maximum_rollback_evidence_age_hours: number;
  maximum_monitoring_evidence_age_hours: number;
  maximum_provider_canary_age_hours: number;
  maximum_data_governance_verification_age_hours: number;
};

export type ProductionPreflightExpectations = {
  schema_version: 1;
  project_ref: string;
  staging_project_ref: string;
  organization_slug: string;
  organization_plan: "pro" | "team" | "enterprise";
  project_created_after: string;
  app_url: string;
  auth_redirect_urls: string[];
  region: string;
  app_release: string;
  sentry_api_base_url: string;
  monitoring_workflows: Record<string, { id: string; name: string }>;
  smtp: {
    admin_email: string;
    host: string;
    port: string;
    user: string;
    sender_name: string;
  };
  auth_rate_limits: Record<AuthRateLimitKey, number>;
  edge_function_versions: Record<string, number>;
};

export type ProductionOperationsEvidence = {
  schema_version: 6;
  project_ref: string;
  app_release: string;
  backup_recovery: {
    recovery_policy_approved: boolean;
    pitr_decision: "enabled" | "not_required";
    restore_drill_succeeded: boolean;
    restore_drill_at: string;
    evidence_id: string;
  };
  external_scheduler: {
    configured: boolean;
    provider: "upstash_qstash";
    region: "eu-central-1";
    billing_plan: "free" | "pay_as_you_go" | "fixed" | "enterprise";
    schedule_ids: string[];
    cron: "* * * * *";
    delivery_delays_seconds: [0, 30];
    effective_max_gap_seconds: number;
    method: "POST";
    body_sha256: string;
    timeout_seconds: number;
    retries: number;
    retry_delay_expression: string;
    destination_verified: boolean;
    forwarded_header_name: "x-process-recovery-secret";
    forwarded_header_redacted: boolean;
    list_readback_verified: boolean;
    individual_readback_verified: boolean;
    provisioning_plan_applied: boolean;
    contract_sha256: string;
    tested_at: string;
    evidence_id: string;
  };
  rollback: {
    verified_at: string;
    frontend_artifact_present: boolean;
    edge_function_artifacts_present: boolean;
    database_forward_fix_plan_present: boolean;
    evidence_id: string;
  };
  monitoring: {
    verified_at: string;
    frontend_enabled: boolean;
    edge_functions_enabled: boolean;
    send_default_pii: boolean;
    mask_all_text: boolean;
    mask_all_inputs: boolean;
    block_all_media: boolean;
    student_writing_capture: boolean;
    provider_payload_capture: boolean;
    alerts: Record<string, boolean>;
    evidence_id: string;
  };
  provider_redundancy: {
    verified_at: string;
    primary_auth_failover_decision: "enabled" | "disabled";
    primary_auth_failover_canary_passed: boolean;
    writing_primary_passed: boolean;
    writing_fallback_passed: boolean;
    worksheet_primary_passed: boolean;
    worksheet_fallback_generator_passed: boolean;
    worksheet_fallback_critic_passed: boolean;
    worksheet_answer_primary_passed: boolean;
    worksheet_answer_fallback_passed: boolean;
    worksheet_answer_invalid_output_private: boolean;
    worksheet_answer_primary_source: "deepseek";
    worksheet_answer_fallback_source: "gemini";
    worksheet_answer_primary_model: typeof DEEPSEEK_V1_FLASH_MODEL;
    worksheet_answer_fallback_model: typeof GEMINI_V1_ANSWER_MODEL;
    invalid_output_held_private: boolean;
    fallback_generator_model: typeof GEMINI_V1_STRONG_MODEL;
    fallback_critic_model: typeof GEMINI_V1_CRITIC_MODEL;
    secondary_provider_paid_tier: boolean;
    monthly_cost_guard_enabled: boolean;
    per_student_cost_target_mode: "advisory_monitor_only";
    emergency_stop_enabled: boolean;
    cached_input_metering_canary_passed: boolean;
    cost_telemetry_canary_passed: boolean;
    global_monthly_hard_cap_microusd: number;
    default_workspace_monthly_cap_microusd: number;
    maximum_projected_cost_per_student_eur: number;
    advisory_operating_target_eur: number;
    advisory_reserve_basis_points: number;
    stale_exchange_rate_fallback_microrate: number;
    exchange_rate_verified_at: string;
    exchange_rate_source: string;
    active_student_cohorts_tested: [20, 50, 250];
    evidence_id: string;
  };
  student_data_governance: {
    approved_at: string;
    verified_at: string;
    minor_safe_privacy_approved: boolean;
    external_evaluator_dpa_approved: boolean;
    raw_student_writing_transfer_approved: boolean;
    retention_policy_approved: boolean;
    deletion_policy_approved: boolean;
    evidence_id: string;
  };
};

export type CollectedProductionEvidence = {
  schema_version: 3;
  collected_at: string;
  linked_project: {
    temp_project_ref: string | null;
    cli_linked_project_refs: string[];
    command_succeeded: boolean;
  };
  migrations: {
    local_history_succeeded: boolean;
    remote_history_succeeded: boolean;
    local: Array<{
      version: string;
      name: string;
      statement_count: number;
      statements_sha256: string;
    }>;
    remote: Array<{
      version: string;
      name: string;
      statement_count: number;
      statements_sha256: string;
    }>;
  };
  project_identity: {
    project_fetched: boolean;
    organization_fetched: boolean;
    project_ref: string | null;
    organization_slug: string | null;
    region: string | null;
    created_at: string | null;
    status: string | null;
    organization_plan: string | null;
  };
  environment: {
    present_names: string[];
    declared_project_ref_matches: boolean;
    port_valid: boolean;
    base_path_valid: boolean;
    configured_base_path: string | null;
    vite_supabase_url_matches: boolean;
    vite_supabase_key_accepted: boolean;
    demo_mode_enabled: boolean | null;
    public_teacher_signup_enabled: boolean | null;
    public_student_signup_enabled: boolean | null;
    sentry_dsn_present: boolean;
    sentry_dsn_destination_safe: boolean;
    sentry_api_base_url_matches: boolean;
    sentry_environment_is_production: boolean;
    app_release_matches: boolean;
    sentry_replay_enabled: boolean | null;
  };
  frontend_deployment: {
    fetched: boolean;
    http_status: number | null;
    manifest: {
      schema_version: number;
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
    } | null;
  };
  sentry_alerts: {
    fetched: boolean;
    http_status: number | null;
    workflows: Array<{
      id: string;
      name: string;
      enabled: boolean;
      has_active_action: boolean;
    }>;
  };
  edge_secrets: {
    command_succeeded: boolean;
    names: string[];
  };
  edge_functions: {
    command_succeeded: boolean;
    items: Array<{
      slug: string;
      status: string;
      version: number;
      verify_jwt: boolean | null;
    }>;
  };
  auth: {
    fetched: boolean;
    site_url: string | null;
    redirect_urls: string[];
    custom_smtp: {
      admin_email: boolean;
      host: boolean;
      port: boolean;
      user: boolean;
      password: boolean;
      sender_name: boolean;
      matches_expectation: boolean | null;
    };
    leaked_password_protection: boolean | null;
    email_confirmation_required: boolean | null;
    unverified_email_sign_in_allowed: boolean | null;
    jwt_expiry_seconds: number | null;
    totp_enrollment_enabled: boolean | null;
    totp_verification_enabled: boolean | null;
    rate_limits: Record<AuthRateLimitKey, number | null>;
  };
  postgrest: {
    fetched: boolean;
    exposed_schemas: string[];
  };
  service_health: {
    fetched: boolean;
    statuses: Record<string, string>;
  };
  realtime: {
    fetched: boolean;
    suspended: boolean | null;
  };
  database_health: {
    fetched: boolean;
    server_version_num: number | null;
    reconciliation_crons_ready: boolean;
    release_cron_ready: boolean;
    overdue_scheduled_feedback_count: number | null;
    realtime_publication_ready: boolean;
    platform_admin_mfa_ready: boolean;
  };
  recovery_health: {
    fetched: boolean;
    http_status: number | null;
    last_seen_at: string | null;
    heartbeat_fresh: boolean;
    pg_net_installed: boolean | null;
    writing_queue_ready: boolean;
    worksheet_generation_queue_ready: boolean;
    worksheet_answer_queue_ready: boolean;
  };
  data_api: {
    public_profile_rejected: boolean;
    public_http_status: number | null;
    api_profile_reachable: boolean;
    api_http_status: number | null;
  };
  backups: {
    fetched: boolean;
    region: string | null;
    pitr_enabled: boolean | null;
    walg_enabled: boolean | null;
    latest_completed_at: string | null;
  };
};

export type ProductionPreflightCheck = {
  id: string;
  ok: boolean;
  detail: string;
};

export type ProductionPreflightReport = {
  schema_version: 1;
  ok: boolean;
  project_ref: string | null;
  collected_at: string | null;
  passed: number;
  failed: number;
  checks: ProductionPreflightCheck[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || isBoolean(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function isProjectRef(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{20}$/.test(value);
}

function isOpaqueEvidenceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizedUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".invalid") ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0" ||
      /^127\./.test(hostname)
    ) {
      return null;
    }
    const pathname =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname}`;
  } catch {
    return null;
  }
}

const OFFICIAL_SENTRY_API_HOSTS = new Set([
  "sentry.io",
  "us.sentry.io",
  "us2.sentry.io",
  "de.sentry.io",
]);

export function normalizeOfficialSentryApiBase(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = normalizedUrl(value);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  return OFFICIAL_SENTRY_API_HOSTS.has(parsed.hostname.toLowerCase()) &&
    parsed.pathname === "/" &&
    parsed.port === ""
    ? parsed.origin
    : null;
}

export function sentryDsnDestinationIsSafe(
  value: unknown,
  apiBaseValue: unknown,
) {
  const apiBase = normalizeOfficialSentryApiBase(apiBaseValue);
  if (!apiBase || typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    const apiHostname = new URL(apiBase).hostname.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    const expectedIngestHostname = `ingest.${apiHostname}`;
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    return (
      parsed.protocol === "https:" &&
      parsed.username.length > 0 &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      (hostname === expectedIngestHostname ||
        hostname.endsWith(`.${expectedIngestHostname}`)) &&
      pathSegments.length === 1 &&
      /^\d+$/.test(pathSegments[0] ?? "")
    );
  } catch {
    return false;
  }
}

function sameStringSet(left: string[], right: string[]) {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === left.length &&
    normalizedRight.length === right.length &&
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function sameOrderedArray(left: unknown, right: readonly (string | number)[]) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function ageWithin(
  timestamp: string | null,
  maximumMilliseconds: number,
  now: Date,
) {
  if (!timestamp || !isTimestamp(timestamp)) return false;
  const age = now.getTime() - Date.parse(timestamp);
  return age >= -5 * 60_000 && age <= maximumMilliseconds;
}

function dateAgeWithin(date: string, maximumDays: number, now: Date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== date
  ) {
    return false;
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const age = (today - parsed) / 86_400_000;
  return Number.isSafeInteger(age) && age >= 0 && age <= maximumDays;
}

function includesMinimum(actual: string[], minimum: readonly string[]) {
  return (
    new Set(actual).size === actual.length &&
    minimum.every((required) => actual.includes(required))
  );
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  return sameStringSet(Object.keys(value), [...expected]);
}

function isMigrationHistoryFingerprint(value: unknown) {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, [
      "version",
      "name",
      "statement_count",
      "statements_sha256",
    ]) &&
    typeof value.version === "string" &&
    /^\d{12,14}$/.test(value.version) &&
    typeof value.name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value.name) &&
    isPositiveInteger(value.statement_count) &&
    typeof value.statements_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.statements_sha256)
  );
}

function validExternalSchedulerContract(
  value: unknown,
): value is ProductionExternalSchedulerContract {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, [
      "provider",
      "region",
      "schedule_id_prefix",
      "schedule_id_suffixes",
      "destination_path",
      "cron",
      "delivery_delays_seconds",
      "effective_max_gap_seconds",
      "method",
      "body_sha256",
      "timeout_seconds",
      "retries",
      "retry_delay_expression",
      "forwarded_header_name",
      "baseline_deliveries_per_day",
      "free_plan_daily_message_limit",
      "accepted_billing_plans",
      "contract_sha256",
    ]) &&
    value.provider === "upstash_qstash" &&
    value.region === "eu-central-1" &&
    value.schedule_id_prefix === "schreiben-v1-recovery" &&
    sameOrderedArray(value.schedule_id_suffixes, ["minute-00", "minute-30"]) &&
    value.destination_path === "/functions/v1/recover-async-jobs" &&
    value.cron === "* * * * *" &&
    sameOrderedArray(value.delivery_delays_seconds, [0, 30]) &&
    value.effective_max_gap_seconds === 30 &&
    value.method === "POST" &&
    typeof value.body_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.body_sha256) &&
    value.body_sha256 ===
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" &&
    value.timeout_seconds === 10 &&
    value.retries === 2 &&
    value.retry_delay_expression === "1000 * (1 + retried)" &&
    value.forwarded_header_name === "x-process-recovery-secret" &&
    value.baseline_deliveries_per_day === 2_880 &&
    value.free_plan_daily_message_limit === 1_000 &&
    value.baseline_deliveries_per_day > value.free_plan_daily_message_limit &&
    sameOrderedArray(value.accepted_billing_plans, [
      "pay_as_you_go",
      "fixed",
      "enterprise",
    ]) &&
    typeof value.contract_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.contract_sha256)
  );
}

function validAuthSecurityContract(
  value: unknown,
): value is ProductionAuthSecurityContract {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, [
      "jwt_expiry_seconds",
      "totp_enrollment_enabled",
      "totp_verification_enabled",
      "minimum_verified_totp_factors_per_platform_admin",
    ]) &&
    value.jwt_expiry_seconds === 600 &&
    value.totp_enrollment_enabled === true &&
    value.totp_verification_enabled === true &&
    value.minimum_verified_totp_factors_per_platform_admin === 2
  );
}

function validContract(value: unknown): value is ProductionPreflightContract {
  if (!isRecord(value) || value.schema_version !== 1) return false;
  const listFields = [
    "required_frontend_environment",
    "required_collector_environment",
    "required_edge_secret_names",
    "required_edge_functions",
    "required_reconciliation_cron_jobs",
    "required_realtime_tables",
    "required_healthy_services",
    "required_monitoring_alerts",
  ] as const;
  const durationFields = [
    "maximum_heartbeat_age_seconds",
    "maximum_completed_backup_age_hours",
    "maximum_restore_drill_age_days",
    "maximum_scheduler_test_age_hours",
    "maximum_rollback_evidence_age_hours",
    "maximum_monitoring_evidence_age_hours",
    "maximum_provider_canary_age_hours",
    "maximum_data_governance_verification_age_hours",
  ] as const;
  const requiredEdgeFunctions = value.required_edge_functions;
  const requiredVerifyJwt = value.required_edge_function_verify_jwt;
  return (
    listFields.every((field) => isStringArray(value[field])) &&
    includesMinimum(
      value.required_frontend_environment as string[],
      MINIMUM_FRONTEND_ENVIRONMENT,
    ) &&
    includesMinimum(
      value.required_collector_environment as string[],
      MINIMUM_COLLECTOR_ENVIRONMENT,
    ) &&
    includesMinimum(
      value.required_edge_secret_names as string[],
      MINIMUM_EDGE_SECRETS,
    ) &&
    RETIRED_EDGE_MODEL_SECRETS.every(
      (name) => !(value.required_edge_secret_names as string[]).includes(name),
    ) &&
    hasExactApprovedProductionEdgeFunctions(
      requiredEdgeFunctions as string[],
    ) &&
    isRecord(requiredVerifyJwt) &&
    hasExactlyKeys(requiredVerifyJwt, requiredEdgeFunctions as string[]) &&
    Object.values(requiredVerifyJwt).every(isBoolean) &&
    includesMinimum(
      value.required_reconciliation_cron_jobs as string[],
      MINIMUM_RECONCILIATION_CRONS,
    ) &&
    includesMinimum(
      value.required_realtime_tables as string[],
      MINIMUM_REALTIME_TABLES,
    ) &&
    includesMinimum(
      value.required_healthy_services as string[],
      MINIMUM_HEALTHY_SERVICES,
    ) &&
    validAuthSecurityContract(value.required_auth_security) &&
    validExternalSchedulerContract(value.required_external_scheduler) &&
    includesMinimum(
      value.required_monitoring_alerts as string[],
      MINIMUM_MONITORING_ALERTS,
    ) &&
    isPositiveInteger(value.minimum_server_version_num) &&
    value.minimum_server_version_num >= MINIMUM_SUPPORTED_SERVER_VERSION_NUM &&
    value.required_release_cron_job === REQUIRED_RELEASE_CRON &&
    durationFields.every((field) => isPositiveInteger(value[field])) &&
    Number(value.maximum_heartbeat_age_seconds) <= 90 &&
    Number(value.maximum_completed_backup_age_hours) <= 36 &&
    Number(value.maximum_restore_drill_age_days) <= 90 &&
    Number(value.maximum_scheduler_test_age_hours) <= 24 &&
    Number(value.maximum_rollback_evidence_age_hours) <= 168 &&
    Number(value.maximum_monitoring_evidence_age_hours) <= 168 &&
    Number(value.maximum_provider_canary_age_hours) <= 24 &&
    Number(value.maximum_data_governance_verification_age_hours) <= 168
  );
}

function validExpectations(
  value: unknown,
  contract: ProductionPreflightContract | null,
): value is ProductionPreflightExpectations {
  if (!isRecord(value)) return false;
  const authRateLimits = value.auth_rate_limits;
  if (
    value.schema_version !== 1 ||
    !isProjectRef(value.project_ref) ||
    !isProjectRef(value.staging_project_ref) ||
    value.staging_project_ref === value.project_ref ||
    typeof value.organization_slug !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{2,127}$/i.test(value.organization_slug) ||
    !["pro", "team", "enterprise"].includes(String(value.organization_plan)) ||
    !isTimestamp(value.project_created_after) ||
    typeof value.app_url !== "string" ||
    normalizedUrl(value.app_url) === null ||
    !isStringArray(value.auth_redirect_urls) ||
    value.auth_redirect_urls.length === 0 ||
    !value.auth_redirect_urls.every((url) => normalizedUrl(url) !== null) ||
    typeof value.region !== "string" ||
    !/^eu-[a-z]+-\d+$/.test(value.region) ||
    typeof value.app_release !== "string" ||
    value.app_release.trim().length < 7 ||
    normalizeOfficialSentryApiBase(value.sentry_api_base_url) === null ||
    !isRecord(value.monitoring_workflows) ||
    !isRecord(value.smtp) ||
    typeof value.smtp.admin_email !== "string" ||
    !/^\S+@\S+\.\S+$/.test(value.smtp.admin_email) ||
    typeof value.smtp.host !== "string" ||
    value.smtp.host.trim().length === 0 ||
    typeof value.smtp.port !== "string" ||
    !/^\d+$/.test(value.smtp.port) ||
    typeof value.smtp.user !== "string" ||
    value.smtp.user.trim().length === 0 ||
    typeof value.smtp.sender_name !== "string" ||
    value.smtp.sender_name.trim().length === 0 ||
    !isRecord(authRateLimits) ||
    !AUTH_RATE_LIMIT_KEYS.every((key) =>
      isPositiveInteger(authRateLimits[key]),
    ) ||
    Object.keys(authRateLimits).some(
      (key) => !AUTH_RATE_LIMIT_KEYS.includes(key as AuthRateLimitKey),
    ) ||
    !isRecord(value.edge_function_versions)
  ) {
    return false;
  }
  const edgeFunctionVersions = value.edge_function_versions;
  if (!isRecord(edgeFunctionVersions)) return false;
  const versionsValid =
    Object.values(edgeFunctionVersions).every(isPositiveInteger);
  const complete = contract
    ? contract.required_edge_functions.every((slug) =>
        isPositiveInteger(edgeFunctionVersions[slug]),
      )
    : true;
  const monitoringWorkflows = value.monitoring_workflows;
  const workflowSignals = Object.keys(monitoringWorkflows);
  const workflowIds = Object.values(monitoringWorkflows).flatMap((item) =>
    isRecord(item) && typeof item.id === "string" ? [item.id] : [],
  );
  const workflowsValid = Object.values(monitoringWorkflows).every(
    (item) =>
      isRecord(item) &&
      typeof item.id === "string" &&
      /^\d+$/.test(item.id) &&
      typeof item.name === "string" &&
      item.name.trim().length >= 7,
  );
  const workflowsComplete = contract
    ? sameStringSet(workflowSignals, contract.required_monitoring_alerts)
    : workflowsValid;
  return (
    versionsValid &&
    complete &&
    workflowsValid &&
    workflowsComplete &&
    new Set(workflowIds).size === workflowIds.length
  );
}

function validOperationsEvidence(
  value: unknown,
): value is ProductionOperationsEvidence {
  if (
    !isRecord(value) ||
    value.schema_version !== 6 ||
    !isProjectRef(value.project_ref) ||
    typeof value.app_release !== "string" ||
    value.app_release.trim().length < 7 ||
    !isRecord(value.backup_recovery) ||
    !isRecord(value.external_scheduler) ||
    !isRecord(value.rollback) ||
    !isRecord(value.monitoring) ||
    !isRecord(value.monitoring.alerts) ||
    !isRecord(value.provider_redundancy) ||
    !isRecord(value.student_data_governance)
  ) {
    return false;
  }
  const backup = value.backup_recovery;
  const scheduler = value.external_scheduler;
  const rollback = value.rollback;
  const monitoring = value.monitoring;
  const redundancy = value.provider_redundancy;
  const governance = value.student_data_governance;
  const alerts = monitoring.alerts;
  if (!isRecord(alerts)) return false;
  return (
    hasExactlyKeys(value, [
      "schema_version",
      "project_ref",
      "app_release",
      "backup_recovery",
      "external_scheduler",
      "rollback",
      "monitoring",
      "provider_redundancy",
      "student_data_governance",
    ]) &&
    hasExactlyKeys(backup, [
      "recovery_policy_approved",
      "pitr_decision",
      "restore_drill_succeeded",
      "restore_drill_at",
      "evidence_id",
    ]) &&
    hasExactlyKeys(scheduler, [
      "configured",
      "provider",
      "region",
      "billing_plan",
      "schedule_ids",
      "cron",
      "delivery_delays_seconds",
      "effective_max_gap_seconds",
      "method",
      "body_sha256",
      "timeout_seconds",
      "retries",
      "retry_delay_expression",
      "destination_verified",
      "forwarded_header_name",
      "forwarded_header_redacted",
      "list_readback_verified",
      "individual_readback_verified",
      "provisioning_plan_applied",
      "contract_sha256",
      "tested_at",
      "evidence_id",
    ]) &&
    hasExactlyKeys(rollback, [
      "verified_at",
      "frontend_artifact_present",
      "edge_function_artifacts_present",
      "database_forward_fix_plan_present",
      "evidence_id",
    ]) &&
    hasExactlyKeys(monitoring, [
      "verified_at",
      "frontend_enabled",
      "edge_functions_enabled",
      "send_default_pii",
      "mask_all_text",
      "mask_all_inputs",
      "block_all_media",
      "student_writing_capture",
      "provider_payload_capture",
      "alerts",
      "evidence_id",
    ]) &&
    hasExactlyKeys(redundancy, [
      "verified_at",
      "primary_auth_failover_decision",
      "primary_auth_failover_canary_passed",
      "writing_primary_passed",
      "writing_fallback_passed",
      "worksheet_primary_passed",
      "worksheet_fallback_generator_passed",
      "worksheet_fallback_critic_passed",
      "worksheet_answer_primary_passed",
      "worksheet_answer_fallback_passed",
      "worksheet_answer_invalid_output_private",
      "worksheet_answer_primary_source",
      "worksheet_answer_fallback_source",
      "worksheet_answer_primary_model",
      "worksheet_answer_fallback_model",
      "invalid_output_held_private",
      "fallback_generator_model",
      "fallback_critic_model",
      "secondary_provider_paid_tier",
      "monthly_cost_guard_enabled",
      "per_student_cost_target_mode",
      "emergency_stop_enabled",
      "cached_input_metering_canary_passed",
      "cost_telemetry_canary_passed",
      "global_monthly_hard_cap_microusd",
      "default_workspace_monthly_cap_microusd",
      "maximum_projected_cost_per_student_eur",
      "advisory_operating_target_eur",
      "advisory_reserve_basis_points",
      "stale_exchange_rate_fallback_microrate",
      "exchange_rate_verified_at",
      "exchange_rate_source",
      "active_student_cohorts_tested",
      "evidence_id",
    ]) &&
    hasExactlyKeys(governance, [
      "approved_at",
      "verified_at",
      "minor_safe_privacy_approved",
      "external_evaluator_dpa_approved",
      "raw_student_writing_transfer_approved",
      "retention_policy_approved",
      "deletion_policy_approved",
      "evidence_id",
    ]) &&
    typeof backup.recovery_policy_approved === "boolean" &&
    (backup.pitr_decision === "enabled" ||
      backup.pitr_decision === "not_required") &&
    typeof backup.restore_drill_succeeded === "boolean" &&
    isTimestamp(backup.restore_drill_at) &&
    isOpaqueEvidenceId(backup.evidence_id) &&
    typeof scheduler.configured === "boolean" &&
    scheduler.provider === "upstash_qstash" &&
    scheduler.region === "eu-central-1" &&
    ["free", "pay_as_you_go", "fixed", "enterprise"].includes(
      String(scheduler.billing_plan),
    ) &&
    isStringArray(scheduler.schedule_ids) &&
    scheduler.schedule_ids.length === 2 &&
    new Set(scheduler.schedule_ids).size === 2 &&
    scheduler.schedule_ids.every((id) =>
      /^[a-z0-9][a-z0-9-]{7,127}$/.test(id),
    ) &&
    typeof scheduler.cron === "string" &&
    scheduler.cron.trim().length > 0 &&
    Array.isArray(scheduler.delivery_delays_seconds) &&
    scheduler.delivery_delays_seconds.length === 2 &&
    scheduler.delivery_delays_seconds.every(isNonNegativeInteger) &&
    isPositiveInteger(scheduler.effective_max_gap_seconds) &&
    scheduler.method === "POST" &&
    typeof scheduler.body_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(scheduler.body_sha256) &&
    isPositiveInteger(scheduler.timeout_seconds) &&
    isNonNegativeInteger(scheduler.retries) &&
    typeof scheduler.retry_delay_expression === "string" &&
    scheduler.retry_delay_expression.trim().length > 0 &&
    typeof scheduler.destination_verified === "boolean" &&
    scheduler.forwarded_header_name === "x-process-recovery-secret" &&
    typeof scheduler.forwarded_header_redacted === "boolean" &&
    typeof scheduler.list_readback_verified === "boolean" &&
    typeof scheduler.individual_readback_verified === "boolean" &&
    typeof scheduler.provisioning_plan_applied === "boolean" &&
    typeof scheduler.contract_sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(scheduler.contract_sha256) &&
    isTimestamp(scheduler.tested_at) &&
    isOpaqueEvidenceId(scheduler.evidence_id) &&
    isTimestamp(rollback.verified_at) &&
    typeof rollback.frontend_artifact_present === "boolean" &&
    typeof rollback.edge_function_artifacts_present === "boolean" &&
    typeof rollback.database_forward_fix_plan_present === "boolean" &&
    isOpaqueEvidenceId(rollback.evidence_id) &&
    isTimestamp(monitoring.verified_at) &&
    typeof monitoring.frontend_enabled === "boolean" &&
    typeof monitoring.edge_functions_enabled === "boolean" &&
    typeof monitoring.send_default_pii === "boolean" &&
    typeof monitoring.mask_all_text === "boolean" &&
    typeof monitoring.mask_all_inputs === "boolean" &&
    typeof monitoring.block_all_media === "boolean" &&
    typeof monitoring.student_writing_capture === "boolean" &&
    typeof monitoring.provider_payload_capture === "boolean" &&
    Object.values(alerts).every(isBoolean) &&
    isOpaqueEvidenceId(monitoring.evidence_id) &&
    isTimestamp(redundancy.verified_at) &&
    (redundancy.primary_auth_failover_decision === "enabled" ||
      redundancy.primary_auth_failover_decision === "disabled") &&
    typeof redundancy.primary_auth_failover_canary_passed === "boolean" &&
    typeof redundancy.writing_primary_passed === "boolean" &&
    typeof redundancy.writing_fallback_passed === "boolean" &&
    typeof redundancy.worksheet_primary_passed === "boolean" &&
    typeof redundancy.worksheet_fallback_generator_passed === "boolean" &&
    typeof redundancy.worksheet_fallback_critic_passed === "boolean" &&
    typeof redundancy.worksheet_answer_primary_passed === "boolean" &&
    typeof redundancy.worksheet_answer_fallback_passed === "boolean" &&
    typeof redundancy.worksheet_answer_invalid_output_private === "boolean" &&
    redundancy.worksheet_answer_primary_source === "deepseek" &&
    redundancy.worksheet_answer_fallback_source === "gemini" &&
    redundancy.worksheet_answer_primary_model === DEEPSEEK_V1_FLASH_MODEL &&
    redundancy.worksheet_answer_fallback_model === GEMINI_V1_ANSWER_MODEL &&
    typeof redundancy.invalid_output_held_private === "boolean" &&
    redundancy.fallback_generator_model === GEMINI_V1_STRONG_MODEL &&
    redundancy.fallback_critic_model === GEMINI_V1_CRITIC_MODEL &&
    typeof redundancy.secondary_provider_paid_tier === "boolean" &&
    typeof redundancy.monthly_cost_guard_enabled === "boolean" &&
    redundancy.per_student_cost_target_mode === "advisory_monitor_only" &&
    typeof redundancy.emergency_stop_enabled === "boolean" &&
    typeof redundancy.cached_input_metering_canary_passed === "boolean" &&
    typeof redundancy.cost_telemetry_canary_passed === "boolean" &&
    redundancy.global_monthly_hard_cap_microusd ===
      V1_GLOBAL_MONTHLY_AI_CAP_MICROUSD &&
    redundancy.default_workspace_monthly_cap_microusd ===
      V1_DEFAULT_WORKSPACE_MONTHLY_AI_CAP_MICROUSD &&
    typeof redundancy.maximum_projected_cost_per_student_eur === "number" &&
    Number.isFinite(redundancy.maximum_projected_cost_per_student_eur) &&
    redundancy.maximum_projected_cost_per_student_eur > 0 &&
    redundancy.advisory_operating_target_eur === 1 &&
    redundancy.advisory_reserve_basis_points === 1_000 &&
    typeof redundancy.stale_exchange_rate_fallback_microrate === "number" &&
    Number.isSafeInteger(redundancy.stale_exchange_rate_fallback_microrate) &&
    redundancy.stale_exchange_rate_fallback_microrate >= 500_000 &&
    redundancy.stale_exchange_rate_fallback_microrate <= 1_500_000 &&
    typeof redundancy.exchange_rate_verified_at === "string" &&
    redundancy.exchange_rate_source ===
      "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A" &&
    sameOrderedArray(redundancy.active_student_cohorts_tested, [20, 50, 250]) &&
    isOpaqueEvidenceId(redundancy.evidence_id) &&
    isTimestamp(governance.approved_at) &&
    isTimestamp(governance.verified_at) &&
    typeof governance.minor_safe_privacy_approved === "boolean" &&
    typeof governance.external_evaluator_dpa_approved === "boolean" &&
    typeof governance.raw_student_writing_transfer_approved === "boolean" &&
    typeof governance.retention_policy_approved === "boolean" &&
    typeof governance.deletion_policy_approved === "boolean" &&
    isOpaqueEvidenceId(governance.evidence_id)
  );
}

function validCollectedEvidence(
  value: unknown,
): value is CollectedProductionEvidence {
  if (
    !isRecord(value) ||
    value.schema_version !== 3 ||
    !isTimestamp(value.collected_at)
  ) {
    return false;
  }
  const linked = value.linked_project;
  const migrations = value.migrations;
  const projectIdentity = value.project_identity;
  const environment = value.environment;
  const frontendDeployment = value.frontend_deployment;
  const sentryAlerts = value.sentry_alerts;
  const secrets = value.edge_secrets;
  const functions = value.edge_functions;
  const auth = value.auth;
  const postgrest = value.postgrest;
  const services = value.service_health;
  const realtime = value.realtime;
  const database = value.database_health;
  const recovery = value.recovery_health;
  const dataApi = value.data_api;
  const backups = value.backups;
  if (
    !isRecord(linked) ||
    !isRecord(migrations) ||
    !isRecord(projectIdentity) ||
    !isRecord(environment) ||
    !isRecord(frontendDeployment) ||
    !isRecord(sentryAlerts) ||
    !isRecord(secrets) ||
    !isRecord(functions) ||
    !isRecord(auth) ||
    !isRecord(auth.custom_smtp) ||
    !isRecord(auth.rate_limits) ||
    !isRecord(postgrest) ||
    !isRecord(services) ||
    !isRecord(services.statuses) ||
    !isRecord(realtime) ||
    !isRecord(database) ||
    !isRecord(recovery) ||
    !isRecord(dataApi) ||
    !isRecord(backups)
  ) {
    return false;
  }
  const smtp = auth.custom_smtp;
  const authRateLimits = auth.rate_limits;
  return (
    isNullableString(linked.temp_project_ref) &&
    isStringArray(linked.cli_linked_project_refs) &&
    isBoolean(linked.command_succeeded) &&
    hasExactlyKeys(migrations, [
      "local_history_succeeded",
      "remote_history_succeeded",
      "local",
      "remote",
    ]) &&
    isBoolean(migrations.local_history_succeeded) &&
    isBoolean(migrations.remote_history_succeeded) &&
    Array.isArray(migrations.local) &&
    migrations.local.every(isMigrationHistoryFingerprint) &&
    Array.isArray(migrations.remote) &&
    migrations.remote.every(isMigrationHistoryFingerprint) &&
    isBoolean(projectIdentity.project_fetched) &&
    isBoolean(projectIdentity.organization_fetched) &&
    isNullableString(projectIdentity.project_ref) &&
    isNullableString(projectIdentity.organization_slug) &&
    isNullableString(projectIdentity.region) &&
    isNullableString(projectIdentity.created_at) &&
    isNullableString(projectIdentity.status) &&
    isNullableString(projectIdentity.organization_plan) &&
    isStringArray(environment.present_names) &&
    isNullableString(environment.configured_base_path) &&
    [
      "port_valid",
      "declared_project_ref_matches",
      "base_path_valid",
      "vite_supabase_url_matches",
      "vite_supabase_key_accepted",
      "sentry_dsn_present",
      "sentry_dsn_destination_safe",
      "sentry_api_base_url_matches",
      "sentry_environment_is_production",
      "app_release_matches",
    ].every((field) => isBoolean(environment[field])) &&
    isNullableBoolean(environment.demo_mode_enabled) &&
    isNullableBoolean(environment.public_teacher_signup_enabled) &&
    isNullableBoolean(environment.public_student_signup_enabled) &&
    isNullableBoolean(environment.sentry_replay_enabled) &&
    isBoolean(frontendDeployment.fetched) &&
    isNullableNumber(frontendDeployment.http_status) &&
    (frontendDeployment.manifest === null ||
      (isRecord(frontendDeployment.manifest) &&
        typeof frontendDeployment.manifest.schema_version === "number" &&
        typeof frontendDeployment.manifest.app_release === "string" &&
        typeof frontendDeployment.manifest.supabase_url === "string" &&
        typeof frontendDeployment.manifest.supabase_project_ref === "string" &&
        typeof frontendDeployment.manifest.base_path === "string" &&
        isBoolean(frontendDeployment.manifest.demo_mode_enabled) &&
        isBoolean(frontendDeployment.manifest.public_teacher_signup_enabled) &&
        isBoolean(frontendDeployment.manifest.public_student_signup_enabled) &&
        typeof frontendDeployment.manifest.sentry_environment === "string" &&
        isBoolean(frontendDeployment.manifest.sentry_replay_enabled) &&
        isBoolean(
          frontendDeployment.manifest.sentry_source_maps_configured,
        ))) &&
    isBoolean(sentryAlerts.fetched) &&
    isNullableNumber(sentryAlerts.http_status) &&
    Array.isArray(sentryAlerts.workflows) &&
    sentryAlerts.workflows.every(
      (workflow) =>
        isRecord(workflow) &&
        typeof workflow.id === "string" &&
        typeof workflow.name === "string" &&
        isBoolean(workflow.enabled) &&
        isBoolean(workflow.has_active_action),
    ) &&
    isBoolean(secrets.command_succeeded) &&
    isStringArray(secrets.names) &&
    isBoolean(functions.command_succeeded) &&
    Array.isArray(functions.items) &&
    functions.items.every(
      (item) =>
        isRecord(item) &&
        typeof item.slug === "string" &&
        typeof item.status === "string" &&
        isPositiveInteger(item.version) &&
        isBoolean(item.verify_jwt),
    ) &&
    isBoolean(auth.fetched) &&
    isNullableString(auth.site_url) &&
    isStringArray(auth.redirect_urls) &&
    ["admin_email", "host", "port", "user", "password", "sender_name"].every(
      (field) => isBoolean(smtp[field]),
    ) &&
    isNullableBoolean(smtp.matches_expectation) &&
    isNullableBoolean(auth.leaked_password_protection) &&
    isNullableBoolean(auth.email_confirmation_required) &&
    isNullableBoolean(auth.unverified_email_sign_in_allowed) &&
    isNullableNumber(auth.jwt_expiry_seconds) &&
    isNullableBoolean(auth.totp_enrollment_enabled) &&
    isNullableBoolean(auth.totp_verification_enabled) &&
    AUTH_RATE_LIMIT_KEYS.every((key) =>
      isNullableNumber(authRateLimits[key]),
    ) &&
    isBoolean(postgrest.fetched) &&
    isStringArray(postgrest.exposed_schemas) &&
    isBoolean(services.fetched) &&
    Object.values(services.statuses).every(
      (status) => typeof status === "string",
    ) &&
    isBoolean(realtime.fetched) &&
    isNullableBoolean(realtime.suspended) &&
    hasExactlyKeys(database, [
      "fetched",
      "server_version_num",
      "reconciliation_crons_ready",
      "release_cron_ready",
      "overdue_scheduled_feedback_count",
      "realtime_publication_ready",
      "platform_admin_mfa_ready",
    ]) &&
    [
      "fetched",
      "reconciliation_crons_ready",
      "release_cron_ready",
      "realtime_publication_ready",
      "platform_admin_mfa_ready",
    ].every((field) => isBoolean(database[field])) &&
    (database.server_version_num === null ||
      isPositiveInteger(database.server_version_num)) &&
    (database.overdue_scheduled_feedback_count === null ||
      (typeof database.overdue_scheduled_feedback_count === "number" &&
        Number.isSafeInteger(database.overdue_scheduled_feedback_count) &&
        database.overdue_scheduled_feedback_count >= 0)) &&
    isBoolean(recovery.fetched) &&
    isNullableNumber(recovery.http_status) &&
    isNullableString(recovery.last_seen_at) &&
    isBoolean(recovery.heartbeat_fresh) &&
    isNullableBoolean(recovery.pg_net_installed) &&
    [
      "writing_queue_ready",
      "worksheet_generation_queue_ready",
      "worksheet_answer_queue_ready",
    ].every((field) => isBoolean(recovery[field])) &&
    isBoolean(dataApi.public_profile_rejected) &&
    isNullableNumber(dataApi.public_http_status) &&
    isBoolean(dataApi.api_profile_reachable) &&
    isNullableNumber(dataApi.api_http_status) &&
    isBoolean(backups.fetched) &&
    isNullableString(backups.region) &&
    isNullableBoolean(backups.pitr_enabled) &&
    isNullableBoolean(backups.walg_enabled) &&
    isNullableString(backups.latest_completed_at)
  );
}

function check(
  checks: ProductionPreflightCheck[],
  id: string,
  ok: boolean,
  passDetail: string,
  failureDetail: string,
) {
  checks.push({ id, ok, detail: ok ? passDetail : failureDetail });
}

export async function writeOwnerOnlyFile(path: string, contents: string) {
  const handle = await open(path, "w", 0o600);
  try {
    // Creation mode does not tighten an existing file. Change the mode through
    // the open descriptor before writing any replacement evidence.
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

export function verifyProductionPreflight(
  contractValue: unknown,
  expectationsValue: unknown,
  evidenceValue: unknown,
  operationsValue: unknown,
  now = new Date(),
): ProductionPreflightReport {
  const checks: ProductionPreflightCheck[] = [];
  const contract = validContract(contractValue) ? contractValue : null;
  check(
    checks,
    "contract.valid",
    contract !== null,
    "The checked-in production contract is valid.",
    "The production preflight contract is missing or malformed.",
  );
  const expectations = validExpectations(expectationsValue, contract)
    ? expectationsValue
    : null;
  check(
    checks,
    "expectations.valid",
    expectations !== null,
    "The release expectations are complete.",
    "Release expectations are missing, malformed, non-EU, or omit an exact Edge Function version.",
  );
  const evidence = validCollectedEvidence(evidenceValue) ? evidenceValue : null;
  check(
    checks,
    "collection.valid",
    evidence !== null,
    "The collected evidence envelope is valid.",
    "Collected production evidence is missing or malformed.",
  );
  const operations = validOperationsEvidence(operationsValue)
    ? operationsValue
    : null;
  check(
    checks,
    "operations.valid",
    operations !== null,
    "The external operations evidence envelope is valid.",
    "Backup, recovery, rollback, or monitoring evidence is missing or malformed.",
  );

  if (!contract || !expectations || !evidence || !operations) {
    const failed = checks.filter((item) => !item.ok).length;
    return {
      schema_version: 1,
      ok: false,
      project_ref: expectations?.project_ref ?? null,
      collected_at: evidence?.collected_at ?? null,
      passed: checks.length - failed,
      failed,
      checks,
    };
  }

  const expectedSupabaseUrl = `https://${expectations.project_ref}.supabase.co`;
  const linkedRefs = evidence.linked_project.cli_linked_project_refs;
  const linkedProjectOk =
    evidence.linked_project.command_succeeded &&
    evidence.environment.declared_project_ref_matches &&
    evidence.linked_project.temp_project_ref === expectations.project_ref &&
    linkedRefs.length === 1 &&
    linkedRefs[0] === expectations.project_ref;
  check(
    checks,
    "supabase.linked_project",
    linkedProjectOk,
    "The Supabase CLI is linked only to the intended production project.",
    "The declared ref or CLI link is absent, ambiguous, or points at a different project.",
  );
  const projectCreatedAt = evidence.project_identity.created_at;
  const productionIdentityOk =
    evidence.project_identity.project_fetched &&
    evidence.project_identity.organization_fetched &&
    evidence.project_identity.project_ref === expectations.project_ref &&
    evidence.project_identity.project_ref !==
      expectations.staging_project_ref &&
    evidence.project_identity.organization_slug ===
      expectations.organization_slug &&
    evidence.project_identity.organization_plan ===
      expectations.organization_plan &&
    evidence.project_identity.region === expectations.region &&
    evidence.project_identity.status === "ACTIVE_HEALTHY" &&
    projectCreatedAt !== null &&
    isTimestamp(projectCreatedAt) &&
    Date.parse(projectCreatedAt) >=
      Date.parse(expectations.project_created_after);
  check(
    checks,
    "supabase.production_identity",
    productionIdentityOk,
    "The linked project is the approved new EU production project in the paid organization.",
    "Project identity, creation boundary, EU region, healthy status, staging separation, organization, or paid plan is unproven.",
  );

  check(
    checks,
    "database.server_version",
    evidence.database_health.fetched &&
      evidence.database_health.server_version_num !== null &&
      evidence.database_health.server_version_num >=
        contract.minimum_server_version_num,
    `PostgreSQL server_version_num meets the required minimum of ${contract.minimum_server_version_num}.`,
    `PostgreSQL server_version_num is unavailable or below the required minimum of ${contract.minimum_server_version_num}.`,
  );

  const migrationsOk =
    evidence.migrations.local_history_succeeded &&
    evidence.migrations.remote_history_succeeded &&
    evidence.migrations.local.length > 0 &&
    evidence.migrations.local.length === evidence.migrations.remote.length &&
    evidence.migrations.local.every(
      (item, index, items) =>
        index === 0 || items[index - 1]!.version < item.version,
    ) &&
    evidence.migrations.remote.every(
      (item, index, items) =>
        index === 0 || items[index - 1]!.version < item.version,
    ) &&
    evidence.migrations.local.every((local, index) => {
      const remote = evidence.migrations.remote[index];
      return (
        remote !== undefined &&
        local.version === remote.version &&
        local.name === remote.name &&
        local.statement_count === remote.statement_count &&
        local.statements_sha256 === remote.statements_sha256
      );
    });
  check(
    checks,
    "database.migration_parity",
    migrationsOk,
    "The reset-local and linked-production migration histories match in ordered version, name, statement count, and statement-array digest.",
    "Migration history is unavailable, malformed, duplicated, incomplete, unordered, renamed, or has statement-content drift.",
  );

  const requiredEnvironment = [
    ...contract.required_frontend_environment,
    ...contract.required_collector_environment,
  ];
  const presentEnvironment = new Set(evidence.environment.present_names);
  const missingEnvironment = requiredEnvironment.filter(
    (name) => !presentEnvironment.has(name),
  );
  check(
    checks,
    "configuration.environment_present",
    missingEnvironment.length === 0,
    "All required frontend and server/CI environment names are present.",
    `Required environment names are missing: ${missingEnvironment.join(", ") || "unknown"}.`,
  );
  check(
    checks,
    "configuration.frontend_runtime",
    evidence.environment.port_valid &&
      evidence.environment.base_path_valid &&
      evidence.environment.vite_supabase_url_matches &&
      evidence.environment.vite_supabase_key_accepted,
    "Frontend runtime variables and browser key target the production Supabase project.",
    `Frontend PORT, BASE_PATH, VITE_SUPABASE_URL, or browser key is invalid; expected ${expectedSupabaseUrl}.`,
  );
  check(
    checks,
    "configuration.launch_flags",
    evidence.environment.demo_mode_enabled === false &&
      evidence.environment.public_teacher_signup_enabled === false &&
      evidence.environment.public_student_signup_enabled === true,
    "Demo mode and public teacher signup are disabled, and public student signup is enabled.",
    "Production signup or demo flags are unsafe or unparseable.",
  );
  check(
    checks,
    "configuration.monitoring_environment",
    evidence.environment.sentry_dsn_present &&
      evidence.environment.sentry_dsn_destination_safe &&
      evidence.environment.sentry_api_base_url_matches &&
      evidence.environment.sentry_environment_is_production &&
      evidence.environment.app_release_matches &&
      evidence.environment.sentry_replay_enabled === false,
    "Frontend monitoring is configured for this production release with Replay disabled.",
    "Frontend monitoring DSN destination/environment/release is wrong, or Replay is enabled/unparseable.",
  );
  const deployedManifest = evidence.frontend_deployment.manifest;
  check(
    checks,
    "configuration.deployed_frontend_manifest",
    evidence.frontend_deployment.fetched &&
      evidence.frontend_deployment.http_status === 200 &&
      deployedManifest !== null &&
      deployedManifest.schema_version === 1 &&
      deployedManifest.app_release === expectations.app_release &&
      deployedManifest.supabase_url === expectedSupabaseUrl &&
      deployedManifest.supabase_project_ref === expectations.project_ref &&
      deployedManifest.base_path ===
        evidence.environment.configured_base_path &&
      deployedManifest.demo_mode_enabled === false &&
      deployedManifest.public_teacher_signup_enabled === false &&
      deployedManifest.public_student_signup_enabled === true &&
      evidence.environment.public_student_signup_enabled === true &&
      deployedManifest.sentry_environment === "production" &&
      deployedManifest.sentry_replay_enabled === false &&
      deployedManifest.sentry_source_maps_configured,
    "The deployed frontend artifact proves the approved release, project, base path, launch flags, and monitoring mode.",
    "The deployed launch manifest is absent or differs from the approved production build configuration.",
  );
  const sentryWorkflowsById = new Map(
    evidence.sentry_alerts.workflows.map((workflow) => [workflow.id, workflow]),
  );
  const sentryWorkflowDrift = contract.required_monitoring_alerts.filter(
    (signal) => {
      const expected = expectations.monitoring_workflows[signal];
      const observed = expected ? sentryWorkflowsById.get(expected.id) : null;
      return (
        !expected ||
        !observed ||
        observed.name !== expected.name ||
        !observed.enabled ||
        !observed.has_active_action
      );
    },
  );
  check(
    checks,
    "monitoring.alert_workflows_live",
    evidence.sentry_alerts.fetched &&
      evidence.sentry_alerts.http_status === 200 &&
      sentryWorkflowDrift.length === 0,
    "Every required operational signal has a live enabled Sentry workflow with an active notification action.",
    `Sentry workflow inventory is unavailable or drifted for: ${sentryWorkflowDrift.join(", ") || "unknown"}.`,
  );

  const secretNames = new Set(evidence.edge_secrets.names);
  const missingSecrets = contract.required_edge_secret_names.filter(
    (name) => !secretNames.has(name),
  );
  check(
    checks,
    "edge.secrets",
    evidence.edge_secrets.command_succeeded && missingSecrets.length === 0,
    "All required Edge Function secret names exist.",
    `Edge secret inventory failed or is missing: ${missingSecrets.join(", ") || "unknown"}.`,
  );

  const functionsBySlug = new Map(
    evidence.edge_functions.items.map((item) => [item.slug, item]),
  );
  const functionDrift = contract.required_edge_functions.filter((slug) => {
    const item = functionsBySlug.get(slug);
    return (
      !item ||
      item.status !== "ACTIVE" ||
      item.version !== expectations.edge_function_versions[slug] ||
      item.verify_jwt !== contract.required_edge_function_verify_jwt[slug]
    );
  });
  const functionSlugs = evidence.edge_functions.items.map((item) => item.slug);
  const exactFunctionInventory = sameStringSet(
    functionSlugs,
    contract.required_edge_functions,
  );
  check(
    checks,
    "edge.functions",
    evidence.edge_functions.command_succeeded &&
      exactFunctionInventory &&
      functionDrift.length === 0,
    "The deployed Edge Function inventory exactly matches the approved production set, versions, statuses, and JWT-verification modes.",
    `Edge Function inventory failed, contains an unapproved or missing function, or version/status/JWT-mode drift exists for: ${functionDrift.join(", ") || "unknown"}.`,
  );

  const queuesOk =
    evidence.recovery_health.fetched &&
    evidence.recovery_health.writing_queue_ready &&
    evidence.recovery_health.worksheet_generation_queue_ready &&
    evidence.recovery_health.worksheet_answer_queue_ready;
  check(
    checks,
    "queues.ready",
    queuesOk,
    "All three durable queues are present.",
    "One or more durable queues are absent or recovery health could not be read.",
  );
  check(
    checks,
    "queues.reconciliation_cron",
    evidence.database_health.fetched &&
      evidence.database_health.reconciliation_crons_ready,
    "All queue reconciliation Cron jobs are active at the required cadence.",
    "Queue reconciliation Cron health is absent or invalid.",
  );
  check(
    checks,
    "feedback.release_cron",
    evidence.database_health.fetched &&
      evidence.database_health.release_cron_ready,
    "The scheduled-feedback release Cron job is active.",
    "Scheduled-feedback release Cron health is absent or invalid.",
  );
  check(
    checks,
    "feedback.no_overdue_scheduled_releases",
    evidence.database_health.fetched &&
      evidence.database_health.overdue_scheduled_feedback_count === 0,
    "No validated scheduled feedback is more than 60 seconds overdue.",
    "One or more validated scheduled-feedback releases are beyond the 60-second recovery threshold.",
  );

  const heartbeatAgeOk = ageWithin(
    evidence.recovery_health.last_seen_at,
    contract.maximum_heartbeat_age_seconds * 1_000,
    now,
  );
  check(
    checks,
    "recovery.external_heartbeat",
    evidence.recovery_health.fetched &&
      evidence.recovery_health.http_status === 200 &&
      evidence.recovery_health.heartbeat_fresh &&
      heartbeatAgeOk,
    "The external queue and scheduled-release recovery heartbeat is fresh.",
    "The external queue and scheduled-release recovery heartbeat is absent or stale.",
  );
  check(
    checks,
    "database.pg_net_removed",
    evidence.recovery_health.fetched &&
      evidence.recovery_health.pg_net_installed === false,
    "pg_net is not installed.",
    "pg_net is installed or its absence could not be proven.",
  );

  check(
    checks,
    "data_api.public_rejected",
    evidence.data_api.public_profile_rejected &&
      evidence.data_api.public_http_status === 406,
    "The public schema profile is rejected by the Data API.",
    "The public schema is reachable or was not conclusively rejected.",
  );
  check(
    checks,
    "data_api.api_reachable",
    evidence.data_api.api_profile_reachable &&
      evidence.data_api.api_http_status === 200 &&
      evidence.recovery_health.fetched,
    "The api schema and recovery-health RPC are reachable with service authorization.",
    "The api schema or recovery-health RPC is unreachable.",
  );
  check(
    checks,
    "data_api.exposed_schemas",
    evidence.postgrest.fetched &&
      sameStringSet(evidence.postgrest.exposed_schemas, ["api"]),
    "PostgREST exposes only the api schema.",
    "PostgREST schema exposure is unavailable or is not exactly api.",
  );

  const servicesHealthy = contract.required_healthy_services.every(
    (service) => evidence.service_health.statuses[service] === "ACTIVE_HEALTHY",
  );
  check(
    checks,
    "platform.services",
    evidence.service_health.fetched && servicesHealthy,
    "Auth, database, REST, and Realtime services are healthy.",
    "One or more required Supabase services are unavailable or unhealthy.",
  );
  check(
    checks,
    "realtime.health",
    evidence.realtime.fetched &&
      evidence.realtime.suspended === false &&
      evidence.database_health.fetched &&
      evidence.database_health.realtime_publication_ready &&
      evidence.service_health.statuses.realtime === "ACTIVE_HEALTHY",
    "Realtime is active and all required status tables are published.",
    "Realtime is suspended, unhealthy, or missing a required publication table.",
  );

  const expectedAppUrl = normalizedUrl(expectations.app_url);
  const observedSiteUrl = evidence.auth.site_url
    ? normalizedUrl(evidence.auth.site_url)
    : null;
  const normalizedExpectedRedirects = expectations.auth_redirect_urls.flatMap(
    (url) => normalizedUrl(url) ?? [],
  );
  const normalizedObservedRedirects = evidence.auth.redirect_urls.flatMap(
    (url) => normalizedUrl(url) ?? [],
  );
  check(
    checks,
    "auth.urls",
    evidence.auth.fetched &&
      observedSiteUrl === expectedAppUrl &&
      normalizedObservedRedirects.length ===
        evidence.auth.redirect_urls.length &&
      normalizedExpectedRedirects.length ===
        expectations.auth_redirect_urls.length &&
      sameStringSet(normalizedObservedRedirects, normalizedExpectedRedirects),
    "Auth site and redirect URLs match the approved production URLs exactly.",
    "Auth site URL or redirect allow-list differs from the approved production configuration.",
  );
  check(
    checks,
    "auth.custom_smtp",
    evidence.auth.fetched &&
      evidence.auth.custom_smtp.matches_expectation === true &&
      Object.entries(evidence.auth.custom_smtp)
        .filter(([name]) => name !== "matches_expectation")
        .every(([, configured]) => configured === true),
    "Custom SMTP is complete and matches the approved non-secret settings.",
    "Custom SMTP is incomplete or its administrator, host, port, or sender differs from the approved configuration.",
  );
  check(
    checks,
    "auth.password_and_email_safety",
    evidence.auth.fetched &&
      evidence.auth.leaked_password_protection === true &&
      evidence.auth.email_confirmation_required === true &&
      evidence.auth.unverified_email_sign_in_allowed === false,
    "Leaked-password protection and verified-email sign-in are enforced.",
    "Leaked-password protection is off or verified-email safeguards are not enforced.",
  );
  check(
    checks,
    "auth.mfa_and_session_security",
    evidence.auth.fetched &&
      evidence.auth.jwt_expiry_seconds ===
        contract.required_auth_security.jwt_expiry_seconds &&
      evidence.auth.totp_enrollment_enabled ===
        contract.required_auth_security.totp_enrollment_enabled &&
      evidence.auth.totp_verification_enabled ===
        contract.required_auth_security.totp_verification_enabled,
    "TOTP enrollment and verification are enabled and Auth JWTs expire after exactly 600 seconds.",
    "TOTP enrollment/verification is disabled or the Auth JWT expiry differs from the required 600 seconds.",
  );
  check(
    checks,
    "auth.platform_admin_mfa_recovery",
    evidence.database_health.fetched &&
      evidence.database_health.platform_admin_mfa_ready,
    "At least one usable platform administrator has the required two verified TOTP factors and no administrator profile violates that recovery invariant.",
    "The content-free database readback did not prove a usable platform administrator with two verified TOTP factors and zero invalid administrator profiles.",
  );
  const authRateLimitsMatch = AUTH_RATE_LIMIT_KEYS.every(
    (key) =>
      evidence.auth.rate_limits[key] === expectations.auth_rate_limits[key],
  );
  check(
    checks,
    "auth.rate_limits",
    evidence.auth.fetched && authRateLimitsMatch,
    "Auth email, verification, token-refresh, and OTP rate limits match the approved launch configuration.",
    "One or more Auth rate limits are unavailable or differ from the approved launch configuration.",
  );

  const backupFresh = ageWithin(
    evidence.backups.latest_completed_at,
    contract.maximum_completed_backup_age_hours * 60 * 60_000,
    now,
  );
  check(
    checks,
    "backup.current",
    evidence.backups.fetched &&
      evidence.backups.region === expectations.region &&
      (operations.backup_recovery.pitr_decision === "not_required" ||
        evidence.backups.pitr_enabled === true) &&
      backupFresh,
    "A recent completed backup exists in the approved EU region.",
    "Backup inventory is unavailable, stale, reports the wrong region, or contradicts the approved PITR decision.",
  );
  check(
    checks,
    "backup.restore_evidence",
    operations.project_ref === expectations.project_ref &&
      operations.app_release === expectations.app_release &&
      operations.backup_recovery.recovery_policy_approved &&
      operations.backup_recovery.restore_drill_succeeded &&
      ageWithin(
        operations.backup_recovery.restore_drill_at,
        contract.maximum_restore_drill_age_days * 24 * 60 * 60_000,
        now,
      ),
    "The recovery policy is approved and a recent restore drill succeeded.",
    "Recovery policy approval or recent successful restore-drill evidence is absent.",
  );
  const schedulerContract = contract.required_external_scheduler;
  const expectedScheduleIds = buildQstashScheduleIds(
    schedulerContract.schedule_id_prefix,
    expectations.project_ref,
    schedulerContract.schedule_id_suffixes,
  );
  const schedulerEvidence = operations.external_scheduler;
  check(
    checks,
    "recovery.scheduler_evidence",
    operations.project_ref === expectations.project_ref &&
      operations.app_release === expectations.app_release &&
      schedulerEvidence.configured &&
      schedulerEvidence.provider === schedulerContract.provider &&
      schedulerEvidence.region === schedulerContract.region &&
      schedulerEvidence.billing_plan !== "free" &&
      schedulerContract.accepted_billing_plans.includes(
        schedulerEvidence.billing_plan,
      ) &&
      sameOrderedArray(schedulerEvidence.schedule_ids, expectedScheduleIds) &&
      schedulerEvidence.cron === schedulerContract.cron &&
      sameOrderedArray(
        schedulerEvidence.delivery_delays_seconds,
        schedulerContract.delivery_delays_seconds,
      ) &&
      schedulerEvidence.effective_max_gap_seconds ===
        schedulerContract.effective_max_gap_seconds &&
      schedulerEvidence.method === schedulerContract.method &&
      schedulerEvidence.body_sha256 === schedulerContract.body_sha256 &&
      schedulerEvidence.timeout_seconds === schedulerContract.timeout_seconds &&
      schedulerEvidence.retries === schedulerContract.retries &&
      schedulerEvidence.retry_delay_expression ===
        schedulerContract.retry_delay_expression &&
      schedulerEvidence.destination_verified &&
      schedulerEvidence.forwarded_header_name ===
        schedulerContract.forwarded_header_name &&
      schedulerEvidence.forwarded_header_redacted &&
      schedulerEvidence.list_readback_verified &&
      schedulerEvidence.individual_readback_verified &&
      schedulerEvidence.provisioning_plan_applied &&
      schedulerEvidence.contract_sha256 === schedulerContract.contract_sha256 &&
      ageWithin(
        schedulerEvidence.tested_at,
        contract.maximum_scheduler_test_age_hours * 60 * 60_000,
        now,
      ),
    "Two active EU QStash schedules have exact, recent, redacted list and GET readback evidence with a 30-second effective gap.",
    "External scheduler evidence is absent, stale, on Free, unredacted, unread, or differs from the exact two-schedule EU recovery contract.",
  );
  check(
    checks,
    "rollback.evidence",
    operations.project_ref === expectations.project_ref &&
      operations.app_release === expectations.app_release &&
      operations.rollback.frontend_artifact_present &&
      operations.rollback.edge_function_artifacts_present &&
      operations.rollback.database_forward_fix_plan_present &&
      ageWithin(
        operations.rollback.verified_at,
        contract.maximum_rollback_evidence_age_hours * 60 * 60_000,
        now,
      ),
    "Frontend, Edge Function, and database forward-fix rollback evidence is current.",
    "Rollback artifacts or current verification evidence are absent.",
  );

  const redundancy = operations.provider_redundancy;
  check(
    checks,
    "providers.redundancy_canary",
    operations.project_ref === expectations.project_ref &&
      operations.app_release === expectations.app_release &&
      redundancy.primary_auth_failover_canary_passed &&
      redundancy.writing_primary_passed &&
      redundancy.writing_fallback_passed &&
      redundancy.worksheet_primary_passed &&
      redundancy.worksheet_fallback_generator_passed &&
      redundancy.worksheet_fallback_critic_passed &&
      redundancy.worksheet_answer_primary_passed &&
      redundancy.worksheet_answer_fallback_passed &&
      redundancy.worksheet_answer_invalid_output_private &&
      redundancy.worksheet_answer_primary_source === "deepseek" &&
      redundancy.worksheet_answer_fallback_source === "gemini" &&
      redundancy.worksheet_answer_primary_model === DEEPSEEK_V1_FLASH_MODEL &&
      redundancy.worksheet_answer_fallback_model === GEMINI_V1_ANSWER_MODEL &&
      redundancy.invalid_output_held_private &&
      redundancy.fallback_generator_model === GEMINI_V1_STRONG_MODEL &&
      redundancy.fallback_critic_model === GEMINI_V1_CRITIC_MODEL &&
      redundancy.secondary_provider_paid_tier &&
      redundancy.monthly_cost_guard_enabled &&
      redundancy.per_student_cost_target_mode === "advisory_monitor_only" &&
      redundancy.emergency_stop_enabled &&
      redundancy.cached_input_metering_canary_passed &&
      redundancy.cost_telemetry_canary_passed &&
      redundancy.global_monthly_hard_cap_microusd ===
        V1_GLOBAL_MONTHLY_AI_CAP_MICROUSD &&
      redundancy.default_workspace_monthly_cap_microusd ===
        V1_DEFAULT_WORKSPACE_MONTHLY_AI_CAP_MICROUSD &&
      redundancy.maximum_projected_cost_per_student_eur > 0 &&
      redundancy.maximum_projected_cost_per_student_eur <= 1 &&
      redundancy.advisory_operating_target_eur === 1 &&
      redundancy.advisory_reserve_basis_points === 1_000 &&
      redundancy.stale_exchange_rate_fallback_microrate === 1_500_000 &&
      redundancy.exchange_rate_source ===
        "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A" &&
      sameOrderedArray(
        redundancy.active_student_cohorts_tested,
        [20, 50, 250],
      ) &&
      dateAgeWithin(redundancy.exchange_rate_verified_at, 7, now) &&
      ageWithin(
        redundancy.verified_at,
        contract.maximum_provider_canary_age_hours * 60 * 60_000,
        now,
      ),
    "Primary and secondary provider canaries passed with exact source/model provenance, fail-closed invalid output, paid-tier data handling, the USD 225 global/USD 100 default-workspace hard caps, emergency stop, cost telemetry, and an advisory projection at or below EUR 1 per active student-month.",
    "Provider redundancy canaries are absent, stale, failed, lack a tested primary-auth decision, use unpinned models, lack the exact workspace/global hard caps or emergency stop, lack paid-tier/cost controls, or exceed the advisory EUR 1 per active student-month projection.",
  );

  const monitoring = operations.monitoring;
  const monitoringAlertsReady = contract.required_monitoring_alerts.every(
    (alert) => monitoring.alerts[alert] === true,
  );
  check(
    checks,
    "monitoring.privacy",
    operations.project_ref === expectations.project_ref &&
      operations.app_release === expectations.app_release &&
      monitoring.frontend_enabled &&
      monitoring.edge_functions_enabled &&
      monitoring.send_default_pii === false &&
      monitoring.mask_all_text &&
      monitoring.mask_all_inputs &&
      monitoring.block_all_media &&
      monitoring.student_writing_capture === false &&
      monitoring.provider_payload_capture === false &&
      monitoringAlertsReady &&
      ageWithin(
        monitoring.verified_at,
        contract.maximum_monitoring_evidence_age_hours * 60 * 60_000,
        now,
      ),
    "Frontend and Edge monitoring use privacy-safe capture and required alerts.",
    "Monitoring is absent, stale, lacks alerts, or may capture student/provider content or PII.",
  );

  const governance = operations.student_data_governance;
  const governanceDatesAreOrdered =
    Date.parse(governance.approved_at) <= Date.parse(governance.verified_at);
  check(
    checks,
    "privacy.student_data_governance",
    operations.project_ref === expectations.project_ref &&
      operations.app_release === expectations.app_release &&
      governance.minor_safe_privacy_approved &&
      governance.external_evaluator_dpa_approved &&
      governance.raw_student_writing_transfer_approved &&
      governance.retention_policy_approved &&
      governance.deletion_policy_approved &&
      governanceDatesAreOrdered &&
      ageWithin(
        governance.verified_at,
        contract.maximum_data_governance_verification_age_hours * 60 * 60_000,
        now,
      ),
    "A dated, minor-safe privacy/DPA review approves external evaluator transfer plus retention and deletion policies for this release.",
    "Dated minor-safe privacy/DPA approval, raw-writing transfer approval, or retention/deletion policy evidence is absent, stale, or belongs to another release.",
  );

  const failed = checks.filter((item) => !item.ok).length;
  return {
    schema_version: 1,
    ok: failed === 0,
    project_ref: expectations.project_ref,
    collected_at: evidence.collected_at,
    passed: checks.length - failed,
    failed,
    checks,
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readJson(path: string, label: string) {
  const source = await readFile(path, "utf8");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function main() {
  const contractPath = argument("--contract");
  const expectationsPath = argument("--expectations");
  const evidencePath = argument("--evidence");
  const operationsPath = argument("--operations");
  const reportPath = argument("--report-output");
  if (!contractPath || !expectationsPath || !evidencePath || !operationsPath) {
    throw new Error(
      "Usage: production:preflight:verify -- --contract <contract.json> --expectations <expectations.json> --evidence <collected.json> --operations <operations.json> [--report-output <report.json>]",
    );
  }
  const workspaceRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const workspacePath = (path: string) =>
    isAbsolute(path) ? path : resolve(workspaceRoot, path);
  const [contract, expectations, evidence, operations] = await Promise.all([
    readJson(workspacePath(contractPath), "Production contract"),
    readJson(workspacePath(expectationsPath), "Release expectations"),
    readJson(workspacePath(evidencePath), "Collected evidence"),
    readJson(workspacePath(operationsPath), "Operations evidence"),
  ]);
  const report = verifyProductionPreflight(
    contract,
    expectations,
    evidence,
    operations,
  );
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    await writeOwnerOnlyFile(workspacePath(reportPath), rendered);
  }
  console.log(rendered.trimEnd());
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Production preflight verification failed.",
    );
    process.exitCode = 1;
  });
}
