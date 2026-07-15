import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  type CollectedProductionEvidence,
  type ProductionOperationsEvidence,
  type ProductionPreflightContract,
  type ProductionPreflightExpectations,
  normalizeOfficialSentryApiBase,
  sentryDsnDestinationIsSafe,
  verifyProductionPreflight,
  writeOwnerOnlyFile,
} from "./verify-production-preflight.js";

const execFileAsync = promisify(execFile);
const MANAGEMENT_API = "https://api.supabase.com";
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const MIGRATION_VERSION_PATTERN = /^\d{12,14}$/;
const SAFE_DATABASE_NAME_PATTERN = /^[a-z0-9_-]+$/;
const EXPECTED_CRON_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  "reconcile-writing-jobs-every-30-seconds":
    "select app_private.reconcile_async_jobs_internal('writing_evaluation');",
  "reconcile-worksheet-generation-every-30-seconds":
    "select app_private.reconcile_async_jobs_internal('worksheet_generation');",
  "reconcile-worksheet-evaluation-every-30-seconds":
    "select app_private.reconcile_async_jobs_internal('worksheet_answer_evaluation');",
  "reconcile-ai-spend-reservations-every-30-seconds":
    "select app_private.reconcile_expired_ai_spend_reservations_internal(100, null);",
  "drain-practice-cycle-transitions-every-30-seconds":
    "select app_private.process_practice_cycle_transition_jobs(50);",
  "release-due-feedback-every-30-seconds":
    "select app_private.release_due_feedback_internal(100);",
});

type CliResult = {
  ok: boolean;
  stdout: string;
};

export type ProductionCollectorDependencies = {
  runSupabase(args: string[]): Promise<CliResult>;
  runLocalPsql(databaseUrl: string, query: string): Promise<CliResult>;
  fetchImpl: typeof fetch;
  readText(path: string): Promise<string>;
};

export type ProductionCollectorInput = {
  cwd: string;
  environment: Record<string, string | undefined>;
  contract: ProductionPreflightContract;
  expectations: ProductionPreflightExpectations;
  collectedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function integerValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
}

function constantTimeEqual(left: string, right: string) {
  if (!left || !right) return false;
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function decodeJwtRecord(segment: string) {
  try {
    const decoded = Buffer.from(segment, "base64url").toString("utf8");
    const parsed = parseJson(decoded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Accept only Supabase publishable keys or a legacy, project-accepted JWT whose
 * signed payload identifies the `anon` role. The live Auth settings probe is
 * what verifies that the key belongs to the target project; this structural
 * check prevents a service-role/secret key from being mistaken for a browser
 * key after that probe succeeds.
 */
export function browserKeyIsSafeForProject(input: {
  browserKey: string | undefined;
  serviceRoleKey: string | undefined;
  acceptedByProject: boolean;
}) {
  if (!input.acceptedByProject) return false;
  const browserKey = input.browserKey?.trim() ?? "";
  const serviceRoleKey = input.serviceRoleKey?.trim() ?? "";
  if (!browserKey || constantTimeEqual(browserKey, serviceRoleKey))
    return false;

  if (browserKey.startsWith("sb_secret_")) return false;
  if (browserKey.startsWith("sb_publishable_")) {
    return /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(browserKey);
  }

  const segments = browserKey.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment))
    return false;
  const header = decodeJwtRecord(segments[0]);
  const payload = decodeJwtRecord(segments[1]);
  return header?.alg === "HS256" && payload?.role === "anon";
}

function arrayPayload(value: unknown, keys: string[]) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

export function parseProjectsList(source: string) {
  const rows = arrayPayload(parseJson(source), ["projects", "data"]);
  return rows.flatMap((row) => {
    if (!isRecord(row) || row.linked !== true) return [];
    const ref = stringValue(
      row.id || row.ref || row.project_ref || row.reference_id,
    );
    return PROJECT_REF_PATTERN.test(ref) ? [ref] : [];
  });
}

function migrationVersion(value: unknown) {
  const candidate =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  return MIGRATION_VERSION_PATTERN.test(candidate) ? candidate : null;
}

const MIGRATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;

function migrationRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    if (
      value.length === 1 &&
      isRecord(value[0]) &&
      "migration_history" in value[0]
    ) {
      return migrationRows(value[0].migration_history);
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed === null ? null : migrationRows(parsed);
  }
  if (isRecord(value) && "migration_history" in value) {
    return migrationRows(value.migration_history);
  }
  return null;
}

export type MigrationHistoryFingerprint = {
  version: string;
  name: string;
  statement_count: number;
  statements_sha256: string;
};

export function fingerprintMigrationHistory(value: unknown): {
  valid: boolean;
  items: MigrationHistoryFingerprint[];
} {
  const rows = migrationRows(value);
  if (!rows || rows.length === 0) return { valid: false, items: [] };
  const items: MigrationHistoryFingerprint[] = [];
  for (const row of rows) {
    if (!isRecord(row)) return { valid: false, items: [] };
    const version = migrationVersion(row.version);
    const name = typeof row.name === "string" ? row.name : "";
    const statements = row.statements;
    if (
      !version ||
      !MIGRATION_NAME_PATTERN.test(name) ||
      !Array.isArray(statements) ||
      statements.length === 0 ||
      !statements.every((statement) => typeof statement === "string")
    ) {
      return { valid: false, items: [] };
    }
    items.push({
      version,
      name,
      statement_count: statements.length,
      statements_sha256: createHash("sha256")
        .update(JSON.stringify(statements), "utf8")
        .digest("hex"),
    });
  }
  return { valid: true, items };
}

export function buildMigrationHistoryQuery() {
  return `select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'version', history.version,
      'name', history.name,
      'statements', history.statements
    )
    order by history.version
  ),
  '[]'::jsonb
) as migration_history
from supabase_migrations.schema_migrations as history;`;
}

export function localDatabaseUrlIsSafe(value: unknown) {
  if (typeof value !== "string" || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    return (
      ["postgres:", "postgresql:"].includes(parsed.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(
        parsed.hostname.toLowerCase(),
      ) &&
      parsed.username.length > 0 &&
      parsed.pathname.length > 1 &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export function parseFunctionInventory(source: string) {
  const parsed = parseJson(source);
  const directRows = arrayPayload(parsed, ["functions", "data"]);
  const rows =
    directRows.length > 0
      ? directRows
      : isRecord(parsed)
        ? Object.values(parsed).filter(isRecord)
        : [];
  return rows.flatMap((row) => {
    if (!isRecord(row)) return [];
    const slug = stringValue(row.slug || row.name);
    const status = stringValue(row.status);
    const version = integerValue(row.version);
    const verifyJwt = booleanValue(row.verify_jwt);
    return slug && status && version !== null
      ? [{ slug, status, version, verify_jwt: verifyJwt }]
      : [];
  });
}

export function parseSecretNames(source: string) {
  const parsed = parseJson(source);
  const rows = arrayPayload(parsed, ["secrets", "data"]);
  const rowNames = rows.flatMap((row) => {
    if (!isRecord(row)) return [];
    const name = stringValue(row.name);
    return /^[A-Z][A-Z0-9_]+$/.test(name) ? [name] : [];
  });
  const mapNames = isRecord(parsed)
    ? Object.keys(parsed).filter((name) => /^[A-Z][A-Z0-9_]+$/.test(name))
    : [];
  return [...new Set([...rowNames, ...mapNames])].sort();
}

function splitCommaList(value: unknown) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringValue(item) || []).filter(Boolean);
  }
  return stringValue(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function sanitizeAuthConfig(
  value: unknown,
  expectedSmtp?: ProductionPreflightExpectations["smtp"],
) {
  const config = isRecord(value) ? value : {};
  const configured = (field: string) => stringValue(config[field]).length > 0;
  const smtpMatches = expectedSmtp
    ? stringValue(config.smtp_admin_email).toLowerCase() ===
        expectedSmtp.admin_email.trim().toLowerCase() &&
      stringValue(config.smtp_host).toLowerCase() ===
        expectedSmtp.host.trim().toLowerCase() &&
      stringValue(config.smtp_port) === expectedSmtp.port.trim() &&
      stringValue(config.smtp_user) === expectedSmtp.user.trim() &&
      stringValue(config.smtp_sender_name) === expectedSmtp.sender_name.trim()
    : null;
  return {
    fetched: isRecord(value),
    site_url: configured("site_url") ? stringValue(config.site_url) : null,
    redirect_urls: splitCommaList(config.uri_allow_list),
    custom_smtp: {
      admin_email: configured("smtp_admin_email"),
      host: configured("smtp_host"),
      port: configured("smtp_port"),
      user: configured("smtp_user"),
      password: configured("smtp_pass"),
      sender_name: configured("smtp_sender_name"),
      matches_expectation: smtpMatches,
    },
    leaked_password_protection: booleanValue(config.password_hibp_enabled),
    email_confirmation_required:
      typeof config.mailer_autoconfirm === "boolean"
        ? !config.mailer_autoconfirm
        : null,
    unverified_email_sign_in_allowed: booleanValue(
      config.mailer_allow_unverified_email_sign_ins,
    ),
    jwt_expiry_seconds: integerValue(config.jwt_exp),
    totp_enrollment_enabled: booleanValue(config.mfa_totp_enroll_enabled),
    totp_verification_enabled: booleanValue(config.mfa_totp_verify_enabled),
    rate_limits: {
      rate_limit_email_sent: integerValue(config.rate_limit_email_sent),
      rate_limit_verify: integerValue(config.rate_limit_verify),
      rate_limit_token_refresh: integerValue(config.rate_limit_token_refresh),
      rate_limit_otp: integerValue(config.rate_limit_otp),
    },
  };
}

export function sanitizePostgrestConfig(value: unknown) {
  const config = isRecord(value) ? value : {};
  return {
    fetched: isRecord(value),
    exposed_schemas: splitCommaList(config.db_schema),
  };
}

export function sanitizeServiceHealth(value: unknown) {
  const rows = arrayPayload(value, ["services", "data"]);
  const statuses: Record<string, string> = {};
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = stringValue(row.name);
    const status = stringValue(row.status);
    if (name && status) statuses[name] = status;
  }
  return { fetched: Array.isArray(value), statuses };
}

export function sanitizeRealtimeConfig(value: unknown) {
  const config = isRecord(value) ? value : {};
  return {
    fetched: isRecord(value),
    suspended: booleanValue(config.suspend),
  };
}

export function sanitizeProjectIdentity(
  projectValue: unknown,
  organizationValue: unknown,
) {
  const project = isRecord(projectValue) ? projectValue : {};
  const organization = isRecord(organizationValue) ? organizationValue : {};
  const projectRef = stringValue(project.ref || project.id);
  const organizationSlug = stringValue(project.organization_slug);
  const region = stringValue(project.region);
  const createdAt = stringValue(project.created_at);
  const status = stringValue(project.status);
  const organizationPlan = stringValue(organization.plan).toLowerCase();
  return {
    project_fetched: isRecord(projectValue),
    organization_fetched: isRecord(organizationValue),
    project_ref: PROJECT_REF_PATTERN.test(projectRef) ? projectRef : null,
    organization_slug: organizationSlug || null,
    region: region || null,
    created_at: Number.isFinite(Date.parse(createdAt)) ? createdAt : null,
    status: status || null,
    organization_plan: organizationPlan || null,
  };
}

function firstRecord(value: unknown) {
  if (Array.isArray(value) && isRecord(value[0])) return value[0];
  if (isRecord(value)) {
    if (Array.isArray(value.data) && isRecord(value.data[0]))
      return value.data[0];
    if (Array.isArray(value.result) && isRecord(value.result[0])) {
      return value.result[0];
    }
  }
  return null;
}

export function sanitizeDatabaseHealth(value: unknown) {
  const row = firstRecord(value);
  return {
    fetched: row !== null,
    server_version_num: integerValue(row?.server_version_num),
    reconciliation_crons_ready: row?.reconciliation_crons_ready === true,
    release_cron_ready: row?.release_cron_ready === true,
    overdue_scheduled_feedback_count: integerValue(
      row?.overdue_scheduled_feedback_count,
    ),
    realtime_publication_ready: row?.realtime_publication_ready === true,
    platform_admin_mfa_ready: row?.platform_admin_mfa_ready === true,
  };
}

export function sanitizeRecoveryHealth(
  value: unknown,
  httpStatus: number | null,
) {
  const row = firstRecord(value);
  return {
    fetched: httpStatus === 200 && row !== null,
    http_status: httpStatus,
    last_seen_at:
      isRecord(row) && stringValue(row.last_seen_at)
        ? stringValue(row.last_seen_at)
        : null,
    heartbeat_fresh: isRecord(row) && row.heartbeat_fresh === true,
    pg_net_installed: isRecord(row) ? booleanValue(row.pg_net_installed) : null,
    writing_queue_ready: isRecord(row) && row.writing_queue_ready === true,
    worksheet_generation_queue_ready:
      isRecord(row) && row.worksheet_generation_queue_ready === true,
    worksheet_answer_queue_ready:
      isRecord(row) && row.worksheet_answer_queue_ready === true,
  };
}

export function sanitizeBackups(value: unknown) {
  const response = isRecord(value) ? value : {};
  const backups = Array.isArray(response.backups) ? response.backups : [];
  const completed = backups
    .flatMap((backup) => {
      if (!isRecord(backup) || backup.status !== "COMPLETED") return [];
      const insertedAt = stringValue(backup.inserted_at);
      return Number.isFinite(Date.parse(insertedAt)) ? [insertedAt] : [];
    })
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return {
    fetched: isRecord(value),
    region: stringValue(response.region) || null,
    pitr_enabled: booleanValue(response.pitr_enabled),
    walg_enabled: booleanValue(response.walg_enabled),
    latest_completed_at: completed[0] ?? null,
  };
}

function strictEnvironmentFlag(value: string | undefined) {
  if (value == null || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function normalizedUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return null;
    }
    return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export function productionBasePathIsSafe(value: string) {
  if (value === "./") return true;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (/[\\?#\u0000-\u001f\u007f]/.test(value)) return false;

  try {
    return (
      new URL(value, "https://schreiben.invalid").origin ===
      "https://schreiben.invalid"
    );
  } catch {
    return false;
  }
}

function collectEnvironment(
  environment: Record<string, string | undefined>,
  contract: ProductionPreflightContract,
  expectations: ProductionPreflightExpectations,
  frontendKeyAccepted: boolean,
) {
  const requiredNames = [
    ...contract.required_frontend_environment,
    ...contract.required_collector_environment,
  ];
  const presentNames = requiredNames.filter((name) =>
    environment[name]?.trim(),
  );
  const port = Number(environment.PORT);
  const basePath = environment.BASE_PATH?.trim() ?? "";
  return {
    present_names: presentNames,
    declared_project_ref_matches:
      environment.PRODUCTION_PROJECT_REF?.trim() === expectations.project_ref,
    port_valid:
      /^\d+$/.test(environment.PORT?.trim() ?? "") &&
      Number.isSafeInteger(port) &&
      port >= 1 &&
      port <= 65_535,
    base_path_valid: productionBasePathIsSafe(basePath),
    configured_base_path: basePath || null,
    vite_supabase_url_matches:
      normalizedUrl(environment.VITE_SUPABASE_URL) ===
      `https://${expectations.project_ref}.supabase.co`,
    vite_supabase_key_accepted: frontendKeyAccepted,
    demo_mode_enabled: strictEnvironmentFlag(environment.VITE_ENABLE_DEMO_MODE),
    public_teacher_signup_enabled: strictEnvironmentFlag(
      environment.VITE_ENABLE_PUBLIC_TEACHER_SIGNUP,
    ),
    public_student_signup_enabled: strictEnvironmentFlag(
      environment.VITE_ENABLE_PUBLIC_STUDENT_SIGNUP,
    ),
    sentry_dsn_present: Boolean(environment.VITE_SENTRY_DSN?.trim()),
    sentry_dsn_destination_safe: sentryDsnDestinationIsSafe(
      environment.VITE_SENTRY_DSN,
      expectations.sentry_api_base_url,
    ),
    sentry_api_base_url_matches:
      normalizeOfficialSentryApiBase(environment.SENTRY_API_BASE_URL) ===
      normalizeOfficialSentryApiBase(expectations.sentry_api_base_url),
    sentry_environment_is_production:
      environment.VITE_SENTRY_ENVIRONMENT?.trim() === "production",
    app_release_matches:
      environment.VITE_APP_RELEASE?.trim() === expectations.app_release,
    sentry_replay_enabled: strictEnvironmentFlag(
      environment.VITE_SENTRY_ENABLE_REPLAY,
    ),
  };
}

function containsActiveWorkflowAction(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsActiveWorkflowAction);
  if (!isRecord(value)) return false;
  if (
    typeof value.type === "string" &&
    value.type.trim().length > 0 &&
    value.status === "active"
  )
    return true;
  return Object.values(value).some(containsActiveWorkflowAction);
}

export function sanitizeSentryWorkflows(value: unknown, status: number | null) {
  const rows = arrayPayload(value, ["workflows", "data"]);
  return {
    fetched: status === 200 && Array.isArray(value),
    http_status: status,
    workflows: rows.flatMap((row) => {
      if (!isRecord(row)) return [];
      const id = stringValue(row.id);
      const name = stringValue(row.name);
      const enabled = booleanValue(row.enabled);
      if (!/^\d+$/.test(id) || !name || enabled === null) return [];
      return [
        {
          id,
          name,
          enabled,
          has_active_action: containsActiveWorkflowAction({
            triggers: row.triggers,
            actionFilters: row.actionFilters,
          }),
        },
      ];
    }),
  };
}

function sanitizeLaunchManifest(value: unknown, status: number | null) {
  if (!isRecord(value)) {
    return { fetched: false, http_status: status, manifest: null };
  }
  const manifest = {
    schema_version: integerValue(value.schema_version) ?? 0,
    app_release: stringValue(value.app_release),
    supabase_url: stringValue(value.supabase_url),
    supabase_project_ref: stringValue(value.supabase_project_ref),
    base_path: stringValue(value.base_path),
    demo_mode_enabled: booleanValue(value.demo_mode_enabled) ?? true,
    public_teacher_signup_enabled:
      booleanValue(value.public_teacher_signup_enabled) ?? true,
    public_student_signup_enabled:
      booleanValue(value.public_student_signup_enabled) ?? false,
    sentry_environment: stringValue(value.sentry_environment),
    sentry_replay_enabled: booleanValue(value.sentry_replay_enabled) ?? true,
    sentry_source_maps_configured:
      booleanValue(value.sentry_source_maps_configured) ?? false,
  };
  return { fetched: status === 200, http_status: status, manifest };
}

function safeSqlLiteral(value: string) {
  if (!SAFE_DATABASE_NAME_PATTERN.test(value)) {
    throw new Error(
      "The checked-in production contract contains an unsafe name.",
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlTextLiteral(value: string) {
  if (!value || value.includes("\0")) {
    throw new Error(
      "The checked-in production contract contains invalid SQL text.",
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildDatabaseHealthQuery(
  contract: ProductionPreflightContract,
) {
  const reconciliationRows = contract.required_reconciliation_cron_jobs
    .map((name) => {
      const command = EXPECTED_CRON_COMMANDS[name];
      if (!command) {
        throw new Error(`No fixed recovery command exists for ${name}.`);
      }
      return `(${safeSqlLiteral(name)}, ${sqlTextLiteral(command)})`;
    })
    .join(", ");
  const realtimeTables = contract.required_realtime_tables
    .map(safeSqlLiteral)
    .join(", ");
  const releaseJob = safeSqlLiteral(contract.required_release_cron_job);
  const minimumAdminTotpFactors =
    contract.required_auth_security
      .minimum_verified_totp_factors_per_platform_admin;
  const releaseCommand =
    EXPECTED_CRON_COMMANDS[contract.required_release_cron_job];
  if (!releaseCommand) {
    throw new Error(
      "No fixed scheduled-release command exists for the contract.",
    );
  }
  return `select
  current_setting('server_version_num')::integer as server_version_num,
  coalesce((
    select count(*) = ${contract.required_reconciliation_cron_jobs.length}
      and bool_and(
        job.active
        and job.schedule = '30 seconds'
        and regexp_replace(btrim(job.command), '\\s+', ' ', 'g') = expected.command
        and job.database = current_database()
        and job.username = current_user
      )
    from cron.job as job
    join (values ${reconciliationRows}) as expected(jobname, command)
      on expected.jobname = job.jobname
  ), false) as reconciliation_crons_ready,
  coalesce((
    select count(*) = 1
      and bool_and(
        job.active
        and job.schedule = '30 seconds'
        and regexp_replace(btrim(job.command), '\\s+', ' ', 'g') = ${sqlTextLiteral(releaseCommand)}
        and job.database = current_database()
        and job.username = current_user
      )
    from cron.job as job
    where job.jobname = ${releaseJob}
  ), false) as release_cron_ready,
  coalesce((
    select count(*)::integer
    from public.submissions as submission
    where submission.evaluation_status = 'ready'
      and submission.release_status = 'scheduled'
      and submission.release_at <= now() - interval '60 seconds'
  ), 0) as overdue_scheduled_feedback_count,
  coalesce((
    select count(*) = ${contract.required_realtime_tables.length}
    from pg_catalog.pg_publication_tables as publication
    where publication.pubname = 'supabase_realtime'
      and publication.schemaname = 'api'
      and publication.tablename = any(array[${realtimeTables}]::text[])
      and not exists (
        select 1
        from pg_catalog.pg_publication_tables as unsafe_publication
        where unsafe_publication.pubname = 'supabase_realtime'
          and unsafe_publication.schemaname = 'public'
          and unsafe_publication.tablename = any(array[
            'submissions',
            'student_practice_assignments',
            'practice_test_attempts'
          ]::text[])
      )
  ), false) as realtime_publication_ready,
  coalesce((
    select
      exists (
        select 1
        from public.profiles as profile
        join auth.users as account on account.id = profile.id
        where profile.global_role = 'platform_admin'
          and account.email_confirmed_at is not null
          and not coalesce(account.is_anonymous, false)
          and account.deleted_at is null
          and (account.banned_until is null or account.banned_until <= now())
          and (
            select count(*)
            from auth.mfa_factors as factor
            where factor.user_id = account.id
              and factor.factor_type = 'totp'
              and factor.status = 'verified'
          ) >= ${minimumAdminTotpFactors}
      )
      and not exists (
        select 1
        from public.profiles as profile
        left join auth.users as account on account.id = profile.id
        where profile.global_role = 'platform_admin'
          and (
            account.id is null
            or account.email_confirmed_at is null
            or coalesce(account.is_anonymous, false)
            or account.deleted_at is not null
            or account.banned_until > now()
            or (
              select count(*)
              from auth.mfa_factors as factor
              where factor.user_id = profile.id
                and factor.factor_type = 'totp'
                and factor.status = 'verified'
            ) < ${minimumAdminTotpFactors}
          )
      )
  ), false) as platform_admin_mfa_ready;`;
}

function defaultDependencies(
  cwd: string,
  environment: Record<string, string | undefined>,
): ProductionCollectorDependencies {
  const executable = environment.SUPABASE_CLI_BIN?.trim() || "supabase";
  const psqlExecutable = environment.PSQL_BIN?.trim() || "psql";
  return {
    async runSupabase(args) {
      try {
        const result = await execFileAsync(executable, args, {
          cwd,
          env: { ...process.env, ...environment },
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60_000,
        });
        return { ok: true, stdout: result.stdout };
      } catch {
        return { ok: false, stdout: "" };
      }
    },
    async runLocalPsql(databaseUrl, query) {
      try {
        const result = await execFileAsync(
          psqlExecutable,
          [
            "--no-psqlrc",
            "--set=ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--dbname",
            databaseUrl,
            "--command",
            query,
          ],
          {
            cwd,
            env: {
              ...process.env,
              ...environment,
              PGCONNECT_TIMEOUT: "5",
            },
            maxBuffer: 50 * 1024 * 1024,
            timeout: 30_000,
          },
        );
        return { ok: true, stdout: result.stdout };
      } catch {
        return { ok: false, stdout: "" };
      }
    },
    fetchImpl: fetch,
    readText: (path) => readFile(path, "utf8"),
  };
}

async function safeJsonFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
) {
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
    let value: unknown = null;
    try {
      value = (await response.json()) as unknown;
    } catch {
      value = null;
    }
    return { ok: response.ok, status: response.status, value };
  } catch {
    return { ok: false, status: null, value: null };
  }
}

function managementHeaders(accessToken: string) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

export function dataApiHeaders(serviceKey: string, profile: "api" | "public") {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Profile": profile,
    "Content-Profile": profile,
    "Content-Type": "application/json",
    apikey: serviceKey,
  };

  // Supabase secret keys (`sb_secret_...`) are opaque API keys, not JWTs.
  // Legacy service_role JWTs still need the Bearer role assertion for
  // PostgREST, while modern keys are authenticated and authorized by apikey.
  if (!serviceKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }
  return headers;
}

function publicProfileWasRejected(status: number | null, value: unknown) {
  return status === 406 && isRecord(value) && value.code === "PGRST106";
}

function serviceHealthUrl(projectRef: string, services: string[]) {
  const url = new URL(`/v1/projects/${projectRef}/health`, MANAGEMENT_API);
  services.forEach((service) => url.searchParams.append("services", service));
  url.searchParams.set("timeout_ms", "5000");
  return url.toString();
}

export function approvedSentryRouting(input: {
  configuredApiBaseUrl: string | undefined;
  expectedApiBaseUrl: string;
  browserDsn: string | undefined;
}) {
  const configuredApiBase = normalizeOfficialSentryApiBase(
    input.configuredApiBaseUrl,
  );
  const expectedApiBase = normalizeOfficialSentryApiBase(
    input.expectedApiBaseUrl,
  );
  if (
    !configuredApiBase ||
    !expectedApiBase ||
    configuredApiBase !== expectedApiBase ||
    !sentryDsnDestinationIsSafe(input.browserDsn, expectedApiBase)
  ) {
    throw new Error("Sentry routing configuration is not approved.");
  }
  return expectedApiBase;
}

export async function collectProductionEvidence(
  input: ProductionCollectorInput,
  dependencies = defaultDependencies(input.cwd, input.environment),
): Promise<CollectedProductionEvidence> {
  const { contract, expectations, environment, cwd } = input;
  const sentryApiBase = approvedSentryRouting({
    configuredApiBaseUrl: environment.SENTRY_API_BASE_URL,
    expectedApiBaseUrl: expectations.sentry_api_base_url,
    browserDsn: environment.VITE_SENTRY_DSN,
  });
  const projectRef = expectations.project_ref;
  const accessToken = environment.SUPABASE_ACCESS_TOKEN ?? "";
  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const frontendKey = environment.VITE_SUPABASE_ANON_KEY ?? "";
  const localDatabaseUrl = environment.LOCAL_SUPABASE_DB_URL ?? "";
  if (!localDatabaseUrlIsSafe(localDatabaseUrl)) {
    throw new Error(
      "LOCAL_SUPABASE_DB_URL must identify the disposable loopback Supabase database.",
    );
  }
  const migrationHistoryQuery = buildMigrationHistoryQuery();
  const localMigrationResult = await dependencies.runLocalPsql(
    localDatabaseUrl,
    migrationHistoryQuery,
  );
  const localMigrationHistory = fingerprintMigrationHistory(
    parseJson(localMigrationResult.stdout),
  );
  if (!localMigrationResult.ok || !localMigrationHistory.valid) {
    throw new Error(
      "Disposable reset-local migration history is unavailable or malformed.",
    );
  }
  const supabaseUrl = `https://${projectRef}.supabase.co`;
  const manifestUrl = new URL(
    "launch-manifest.json",
    `${expectations.app_url.replace(/\/+$/, "")}/`,
  ).toString();
  const sentryWorkflowsUrl = new URL(
    `/api/0/organizations/${encodeURIComponent(environment.SENTRY_ORG ?? "")}/workflows/`,
    sentryApiBase,
  );
  sentryWorkflowsUrl.searchParams.append(
    "project",
    environment.SENTRY_PROJECT ?? "",
  );

  const cliPromises = {
    projects: dependencies.runSupabase(["projects", "list", "-o", "json"]),
    functions: dependencies.runSupabase([
      "functions",
      "list",
      "--project-ref",
      projectRef,
      "-o",
      "json",
    ]),
    secrets: dependencies.runSupabase([
      "secrets",
      "list",
      "--project-ref",
      projectRef,
      "-o",
      "json",
    ]),
  };

  const managementBase = `${MANAGEMENT_API}/v1/projects/${projectRef}`;
  const managementInit = { headers: managementHeaders(accessToken) };
  const networkPromises = {
    project: safeJsonFetch(
      dependencies.fetchImpl,
      managementBase,
      managementInit,
    ),
    organization: safeJsonFetch(
      dependencies.fetchImpl,
      `${MANAGEMENT_API}/v1/organizations/${encodeURIComponent(expectations.organization_slug)}`,
      managementInit,
    ),
    auth: safeJsonFetch(
      dependencies.fetchImpl,
      `${managementBase}/config/auth`,
      managementInit,
    ),
    postgrest: safeJsonFetch(
      dependencies.fetchImpl,
      `${managementBase}/postgrest`,
      managementInit,
    ),
    services: safeJsonFetch(
      dependencies.fetchImpl,
      serviceHealthUrl(projectRef, contract.required_healthy_services),
      managementInit,
    ),
    realtime: safeJsonFetch(
      dependencies.fetchImpl,
      `${managementBase}/config/realtime`,
      managementInit,
    ),
    backups: safeJsonFetch(
      dependencies.fetchImpl,
      `${managementBase}/database/backups`,
      managementInit,
    ),
    databaseHealth: safeJsonFetch(
      dependencies.fetchImpl,
      `${managementBase}/database/query/read-only`,
      {
        method: "POST",
        headers: {
          ...managementHeaders(accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: buildDatabaseHealthQuery(contract) }),
      },
    ),
    migrationHistory: safeJsonFetch(
      dependencies.fetchImpl,
      `${managementBase}/database/query/read-only`,
      {
        method: "POST",
        headers: {
          ...managementHeaders(accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: migrationHistoryQuery }),
      },
    ),
    recovery: safeJsonFetch(
      dependencies.fetchImpl,
      `${supabaseUrl}/rest/v1/rpc/get_recovery_health`,
      {
        method: "POST",
        headers: dataApiHeaders(serviceKey, "api"),
        body: "{}",
      },
    ),
    publicProfile: safeJsonFetch(
      dependencies.fetchImpl,
      `${supabaseUrl}/rest/v1/__production_preflight_nonexistent?select=*`,
      {
        method: "GET",
        headers: dataApiHeaders(serviceKey, "public"),
      },
    ),
    frontendKey: safeJsonFetch(
      dependencies.fetchImpl,
      `${supabaseUrl}/auth/v1/settings`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          apikey: frontendKey,
        },
      },
    ),
    frontendManifest: safeJsonFetch(dependencies.fetchImpl, manifestUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    }),
    sentryWorkflows: safeJsonFetch(
      dependencies.fetchImpl,
      sentryWorkflowsUrl.toString(),
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${environment.SENTRY_AUTH_TOKEN ?? ""}`,
        },
      },
    ),
  };

  const [
    projects,
    functions,
    secrets,
    project,
    organization,
    auth,
    postgrest,
    services,
    realtime,
    backups,
    databaseHealth,
    migrationHistory,
    recovery,
    publicProfile,
    frontendKeyResponse,
    frontendManifest,
    sentryWorkflows,
    tempProjectRef,
  ] = await Promise.all([
    cliPromises.projects,
    cliPromises.functions,
    cliPromises.secrets,
    networkPromises.project,
    networkPromises.organization,
    networkPromises.auth,
    networkPromises.postgrest,
    networkPromises.services,
    networkPromises.realtime,
    networkPromises.backups,
    networkPromises.databaseHealth,
    networkPromises.migrationHistory,
    networkPromises.recovery,
    networkPromises.publicProfile,
    networkPromises.frontendKey,
    networkPromises.frontendManifest,
    networkPromises.sentryWorkflows,
    dependencies.readText(`${cwd}/supabase/.temp/project-ref`).catch(() => ""),
  ]);

  const remoteMigrationHistory = fingerprintMigrationHistory(
    migrationHistory.value,
  );
  const functionItems = parseFunctionInventory(functions.stdout);
  const secretNames = parseSecretNames(secrets.stdout);
  const sanitizedRecovery = sanitizeRecoveryHealth(
    recovery.value,
    recovery.status,
  );

  return {
    schema_version: 3,
    collected_at: input.collectedAt,
    linked_project: {
      temp_project_ref: PROJECT_REF_PATTERN.test(tempProjectRef.trim())
        ? tempProjectRef.trim()
        : null,
      cli_linked_project_refs: parseProjectsList(projects.stdout),
      command_succeeded: projects.ok,
    },
    migrations: {
      local_history_succeeded: true,
      remote_history_succeeded:
        migrationHistory.ok && remoteMigrationHistory.valid,
      local: localMigrationHistory.items,
      remote: remoteMigrationHistory.items,
    },
    project_identity: sanitizeProjectIdentity(
      project.ok ? project.value : null,
      organization.ok ? organization.value : null,
    ),
    environment: collectEnvironment(
      environment,
      contract,
      expectations,
      browserKeyIsSafeForProject({
        browserKey: frontendKey,
        serviceRoleKey: serviceKey,
        acceptedByProject:
          frontendKeyResponse.ok && frontendKeyResponse.status === 200,
      }),
    ),
    frontend_deployment: sanitizeLaunchManifest(
      frontendManifest.ok ? frontendManifest.value : null,
      frontendManifest.status,
    ),
    sentry_alerts: sanitizeSentryWorkflows(
      sentryWorkflows.ok ? sentryWorkflows.value : null,
      sentryWorkflows.status,
    ),
    edge_secrets: {
      command_succeeded: secrets.ok && parseJson(secrets.stdout) !== null,
      names: secretNames,
    },
    edge_functions: {
      command_succeeded: functions.ok && parseJson(functions.stdout) !== null,
      items: functionItems,
    },
    auth: sanitizeAuthConfig(auth.ok ? auth.value : null, expectations.smtp),
    postgrest: sanitizePostgrestConfig(postgrest.ok ? postgrest.value : null),
    service_health: sanitizeServiceHealth(services.ok ? services.value : null),
    realtime: sanitizeRealtimeConfig(realtime.ok ? realtime.value : null),
    database_health: sanitizeDatabaseHealth(
      databaseHealth.ok ? databaseHealth.value : null,
    ),
    recovery_health: sanitizedRecovery,
    data_api: {
      public_profile_rejected: publicProfileWasRejected(
        publicProfile.status,
        publicProfile.value,
      ),
      public_http_status: publicProfile.status,
      api_profile_reachable: sanitizedRecovery.fetched,
      api_http_status: recovery.status,
    },
    backups: sanitizeBackups(backups.ok ? backups.value : null),
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseEnvironmentJson(
  environment: Record<string, string | undefined>,
  name: string,
) {
  const source = environment[name];
  if (!source) throw new Error(`${name} is required.`);
  const value = parseJson(source);
  if (value === null) throw new Error(`${name} is not valid JSON.`);
  return value;
}

async function main() {
  const cwd =
    argument("--workspace-root") ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const contractArgument = argument("--contract");
  const contractPath = contractArgument
    ? isAbsolute(contractArgument)
      ? contractArgument
      : resolve(cwd, contractArgument)
    : `${cwd}/config/production-preflight.contract.json`;
  const evidencePath = argument("--evidence-output");
  const reportPath = argument("--report-output");
  const contract = parseJson(
    await readFile(contractPath, "utf8"),
  ) as ProductionPreflightContract | null;
  const expectations = parseEnvironmentJson(
    process.env,
    "PRODUCTION_PREFLIGHT_EXPECTATIONS_JSON",
  ) as ProductionPreflightExpectations;
  const operations = parseEnvironmentJson(
    process.env,
    "PRODUCTION_OPERATIONS_EVIDENCE_JSON",
  ) as ProductionOperationsEvidence;
  if (!contract || !PROJECT_REF_PATTERN.test(expectations.project_ref ?? "")) {
    throw new Error(
      "Production contract or release expectations are malformed.",
    );
  }
  const collectedAt = new Date().toISOString();
  const evidence = await collectProductionEvidence({
    cwd,
    environment: process.env,
    contract,
    expectations,
    collectedAt,
  });
  const report = verifyProductionPreflight(
    contract,
    expectations,
    evidence,
    operations,
    new Date(collectedAt),
  );
  const evidenceJson = `${JSON.stringify(evidence, null, 2)}\n`;
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = (path: string) =>
    isAbsolute(path) ? path : resolve(cwd, path);
  if (evidencePath) {
    await writeOwnerOnlyFile(outputPath(evidencePath), evidenceJson);
  }
  if (reportPath) {
    await writeOwnerOnlyFile(outputPath(reportPath), reportJson);
  }
  console.log(reportJson.trimEnd());
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
        : "Production preflight collection failed.",
    );
    process.exitCode = 1;
  });
}
