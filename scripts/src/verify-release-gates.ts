import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MINIMUM_DAILY_SAMPLES = 20;
const MINIMUM_DAILY_JOBS = 20;
const MINIMUM_DAILY_SESSIONS = 20;
const REQUIRED_GREEN_DAYS = 7;
const REQUIRED_SCHOOL_DAYS = 10;
const MINIMUM_PILOT_TEACHERS = 3;
const MAXIMUM_PILOT_TEACHERS = 5;
const MINIMUM_PILOT_STUDENTS = 20;
const MAXIMUM_PILOT_STUDENTS = 50;
const MINIMUM_EDUCATIONAL_REVIEWS = 20;
const REQUIRED_SUCCESS_RATE = 0.995;
const MAXIMUM_TEACHER_CORRECTION_RATE = 0.05;
const MAXIMUM_LATEST_PERFORMANCE_AGE_MS = 36 * 60 * 60_000;

const performanceGateDefinitions = {
  dashboard_request_ms: {
    label: "Dashboard request",
    statistic: "p95",
    limitMs: 2_000,
    inclusive: false,
  },
  list_request_ms: {
    label: "List request",
    statistic: "p95",
    limitMs: 2_000,
    inclusive: false,
  },
  submission_acknowledgement_ms: {
    label: "Submission acknowledgement",
    statistic: "p95",
    limitMs: 1_000,
    inclusive: false,
  },
  immediate_job_start_ms: {
    label: "Immediate job start",
    statistic: "p95",
    limitMs: 5_000,
    inclusive: false,
  },
  feedback_completion_ms: {
    label: "Feedback completion (up to 1,500 characters)",
    statistic: "p95",
    limitMs: 60_000,
    inclusive: false,
  },
  scheduled_release_lag_ms: {
    label: "Scheduled release lag",
    statistic: "max",
    limitMs: 60_000,
    inclusive: true,
  },
  reused_worksheet_ms: {
    label: "Reused worksheet",
    statistic: "max",
    limitMs: 2_000,
    inclusive: false,
  },
  generated_worksheet_progress_ms: {
    label: "Generated worksheet progress visibility",
    statistic: "p95",
    limitMs: 1_000,
    inclusive: false,
  },
  generated_worksheet_ms: {
    label: "Generated worksheet completion",
    statistic: "p95",
    limitMs: 90_000,
    inclusive: false,
  },
} as const;

export type PerformanceMetric = keyof typeof performanceGateDefinitions;

const performanceMetrics = Object.keys(
  performanceGateDefinitions,
) as PerformanceMetric[];
const performanceSources = ["synthetic", "redacted_telemetry"] as const;
type PerformanceSource = (typeof performanceSources)[number];

export type PerformanceEvidenceRow = {
  schema_version: 2;
  app_release: string;
  project_ref: string;
  deployed_at: string;
  pilot_id: string;
  pilot_started_at: string;
  pilot_ended_at: string;
  event_id: string;
  observed_at: string;
  reporting_day: string;
  environment: "production";
  source: PerformanceSource;
  run_id: string;
  metric: PerformanceMetric;
  duration_ms: number;
  concurrent_users: number;
  input_chars?: number;
  virtual_user_id?: string;
  virtual_user_started_at?: string;
  load_attestation_id?: string;
  load_generator_version?: "schreiben-load-v1";
};

export type RawPerformanceEvidenceRow = Omit<
  PerformanceEvidenceRow,
  | "schema_version"
  | "app_release"
  | "project_ref"
  | "deployed_at"
  | "pilot_id"
  | "pilot_started_at"
  | "pilot_ended_at"
> & {
  schema_version: 1;
};

export type PilotDayEvidence = {
  date: string;
  school_day: boolean;
  jobs_total: number;
  jobs_valid_terminal_without_database_intervention: number;
  frontend_sessions_total: number;
  frontend_error_free_sessions: number;
  stuck_jobs_beyond_recovery_threshold: number;
  unresolved_p0_findings: number;
  unresolved_p1_findings: number;
  unauthorized_access_incidents: number;
  cross_workspace_leakage_incidents: number;
  other_security_leakage_incidents: number;
  lost_submissions: number;
  lost_worksheet_answers: number;
  exposed_private_feedback_incidents: number;
  feedback_results_reviewed: number;
  feedback_results_corrected: number;
  worksheet_scores_reviewed: number;
  worksheet_score_overrides: number;
  worksheet_score_overrides_systemically_reviewed: number;
  unresolved_critical_accessibility_findings: number;
  unresolved_high_accessibility_findings: number;
};

export type PilotEvidence = {
  schema_version: 3;
  app_release: string;
  project_ref: string;
  deployed_at: string;
  pilot_id: string;
  pilot_started_at: string;
  pilot_ended_at: string;
  environment: "production";
  teacher_count: number;
  student_count: number;
  school_days_completed: number;
  qualified_german_signoff: {
    evaluator_corpus_approved: boolean;
    worksheet_bank_approved: boolean;
    reviewer_id: string;
    verified_at: string;
  };
  days: PilotDayEvidence[];
};

type NumericPilotDayKey = Exclude<
  keyof PilotDayEvidence,
  "date" | "school_day"
>;

type MetricReport = {
  samples: number;
  statistic: "p95" | "max";
  observed_ms: number | null;
  limit_ms: number;
  inclusive: boolean;
  ok: boolean;
};

type DailyReport = {
  date: string;
  performance: Record<PerformanceMetric, MetricReport>;
  jobs_terminal_rate: number;
  frontend_error_free_rate: number;
  feedback_correction_rate: number;
  worksheet_score_override_rate: number;
  operational_ok: boolean;
  green: boolean;
  failures: string[];
};

export type ReleaseGateReport = {
  ok: boolean;
  errors: string[];
  minimum_daily_samples: number;
  load_test_20_concurrent: boolean;
  pilot: {
    days_supplied: number;
    trailing_consecutive_green_days: number;
    required_consecutive_green_days: number;
    aggregate_job_terminal_rate: number;
    aggregate_frontend_error_free_rate: number;
    aggregate_feedback_correction_rate: number;
    aggregate_worksheet_score_override_rate: number;
    school_days_completed: number;
    qualified_german_signoff: boolean;
    daily: DailyReport[];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFiniteDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isReportingDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isUtcTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)
  );
}

function isReleaseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/.test(value)
  );
}

function isProjectRef(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{20}$/.test(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    errors.push(
      `${label} contains unsupported field(s): ${unexpected.join(", ")}.`,
    );
  }
}

function isMetric(value: unknown): value is PerformanceMetric {
  return (
    typeof value === "string" &&
    performanceMetrics.includes(value as PerformanceMetric)
  );
}

function isPerformanceSource(value: unknown): value is PerformanceSource {
  return (
    typeof value === "string" &&
    performanceSources.includes(value as PerformanceSource)
  );
}

function parsePerformanceRow(value: unknown, index: number, errors: string[]) {
  const label = `Performance row ${index + 1}`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }

  const initialErrorCount = errors.length;
  hasOnlyKeys(
    value,
    [
      "schema_version",
      "app_release",
      "project_ref",
      "deployed_at",
      "pilot_id",
      "pilot_started_at",
      "pilot_ended_at",
      "event_id",
      "observed_at",
      "reporting_day",
      "environment",
      "source",
      "run_id",
      "metric",
      "duration_ms",
      "concurrent_users",
      "input_chars",
      "virtual_user_id",
      "virtual_user_started_at",
      "load_attestation_id",
      "load_generator_version",
    ],
    label,
    errors,
  );

  if (value.schema_version !== 2)
    errors.push(`${label} must use schema_version 2.`);
  if (!isReleaseId(value.app_release)) {
    errors.push(`${label} has an invalid app_release.`);
  }
  if (!isProjectRef(value.project_ref)) {
    errors.push(`${label} has an invalid project_ref.`);
  }
  if (!isUtcTimestamp(value.deployed_at)) {
    errors.push(`${label} has an invalid UTC deployed_at.`);
  }
  if (!isOpaqueId(value.pilot_id)) {
    errors.push(`${label} has no valid opaque pilot_id.`);
  }
  if (!isUtcTimestamp(value.pilot_started_at)) {
    errors.push(`${label} has an invalid UTC pilot_started_at.`);
  }
  if (!isUtcTimestamp(value.pilot_ended_at)) {
    errors.push(`${label} has an invalid UTC pilot_ended_at.`);
  }
  if (!isOpaqueId(value.event_id)) {
    errors.push(`${label} has no valid opaque event_id.`);
  }
  if (!isUtcTimestamp(value.observed_at))
    errors.push(`${label} has an invalid UTC observed_at.`);
  if (!isReportingDay(value.reporting_day))
    errors.push(`${label} has an invalid reporting_day.`);
  if (
    isUtcTimestamp(value.observed_at) &&
    isReportingDay(value.reporting_day) &&
    value.observed_at.slice(0, 10) !== value.reporting_day
  ) {
    errors.push(`${label} observed_at does not fall on reporting_day in UTC.`);
  }
  if (
    isUtcTimestamp(value.deployed_at) &&
    isUtcTimestamp(value.pilot_started_at) &&
    Date.parse(value.deployed_at) > Date.parse(value.pilot_started_at)
  ) {
    errors.push(`${label} has a pilot window that starts before deployment.`);
  }
  if (
    isUtcTimestamp(value.pilot_started_at) &&
    isUtcTimestamp(value.pilot_ended_at) &&
    Date.parse(value.pilot_started_at) > Date.parse(value.pilot_ended_at)
  ) {
    errors.push(`${label} has an invalid pilot window.`);
  }
  if (
    isUtcTimestamp(value.observed_at) &&
    isUtcTimestamp(value.deployed_at) &&
    Date.parse(value.observed_at) < Date.parse(value.deployed_at)
  ) {
    errors.push(`${label} was observed before its deployment.`);
  }
  if (
    isUtcTimestamp(value.observed_at) &&
    isUtcTimestamp(value.pilot_started_at) &&
    isUtcTimestamp(value.pilot_ended_at) &&
    (Date.parse(value.observed_at) < Date.parse(value.pilot_started_at) ||
      Date.parse(value.observed_at) > Date.parse(value.pilot_ended_at))
  ) {
    errors.push(`${label} observed_at falls outside its pilot window.`);
  }
  if (value.environment !== "production")
    errors.push(`${label} must come from production.`);
  if (!isPerformanceSource(value.source))
    errors.push(`${label} has an invalid source.`);
  if (!isOpaqueId(value.run_id)) {
    errors.push(`${label} has no valid opaque run_id.`);
  }
  if (!isMetric(value.metric)) errors.push(`${label} has an invalid metric.`);
  if (!isFiniteDuration(value.duration_ms))
    errors.push(`${label} has an invalid duration_ms.`);
  if (
    !isPositiveInteger(value.concurrent_users) ||
    value.concurrent_users > 10_000
  ) {
    errors.push(`${label} has an invalid concurrent_users count.`);
  }

  if (value.source === "synthetic") {
    if (!isOpaqueId(value.virtual_user_id)) {
      errors.push(`${label} has no valid synthetic virtual_user_id.`);
    }
    if (!isUtcTimestamp(value.virtual_user_started_at)) {
      errors.push(`${label} has an invalid virtual_user_started_at.`);
    }
    if (!isOpaqueId(value.load_attestation_id)) {
      errors.push(`${label} has no valid load_attestation_id.`);
    }
    if (value.load_generator_version !== "schreiben-load-v1") {
      errors.push(`${label} has an unsupported load_generator_version.`);
    }
    if (
      isUtcTimestamp(value.observed_at) &&
      isUtcTimestamp(value.virtual_user_started_at) &&
      Date.parse(value.virtual_user_started_at) > Date.parse(value.observed_at)
    ) {
      errors.push(`${label} completed before its virtual user started.`);
    }
    if (
      isUtcTimestamp(value.virtual_user_started_at) &&
      isUtcTimestamp(value.deployed_at) &&
      Date.parse(value.virtual_user_started_at) < Date.parse(value.deployed_at)
    ) {
      errors.push(`${label} virtual user started before its deployment.`);
    }
    if (
      isUtcTimestamp(value.virtual_user_started_at) &&
      isUtcTimestamp(value.pilot_started_at) &&
      isUtcTimestamp(value.pilot_ended_at) &&
      (Date.parse(value.virtual_user_started_at) <
        Date.parse(value.pilot_started_at) ||
        Date.parse(value.virtual_user_started_at) >
          Date.parse(value.pilot_ended_at))
    ) {
      errors.push(`${label} virtual user started outside its pilot window.`);
    }
  } else if (
    value.virtual_user_id !== undefined ||
    value.virtual_user_started_at !== undefined ||
    value.load_attestation_id !== undefined ||
    value.load_generator_version !== undefined
  ) {
    errors.push(
      `${label} may include load-run fields only for synthetic data.`,
    );
  }

  if (value.metric === "feedback_completion_ms") {
    if (!isPositiveInteger(value.input_chars) || value.input_chars > 1_500) {
      errors.push(
        `${label} feedback evidence requires input_chars between 1 and 1,500.`,
      );
    }
  } else if (value.input_chars !== undefined) {
    errors.push(
      `${label} may only include input_chars for feedback_completion_ms.`,
    );
  }

  if (errors.length !== initialErrorCount) return null;
  return value as unknown as PerformanceEvidenceRow;
}

const pilotDayKeys = [
  "date",
  "school_day",
  "jobs_total",
  "jobs_valid_terminal_without_database_intervention",
  "frontend_sessions_total",
  "frontend_error_free_sessions",
  "stuck_jobs_beyond_recovery_threshold",
  "unresolved_p0_findings",
  "unresolved_p1_findings",
  "unauthorized_access_incidents",
  "cross_workspace_leakage_incidents",
  "other_security_leakage_incidents",
  "lost_submissions",
  "lost_worksheet_answers",
  "exposed_private_feedback_incidents",
  "feedback_results_reviewed",
  "feedback_results_corrected",
  "worksheet_scores_reviewed",
  "worksheet_score_overrides",
  "worksheet_score_overrides_systemically_reviewed",
  "unresolved_critical_accessibility_findings",
  "unresolved_high_accessibility_findings",
] as const;

function parsePilotDay(value: unknown, index: number, errors: string[]) {
  const label = `Pilot day ${index + 1}`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  const initialErrorCount = errors.length;
  hasOnlyKeys(value, pilotDayKeys, label, errors);
  if (!isReportingDay(value.date)) errors.push(`${label} has an invalid date.`);
  if (typeof value.school_day !== "boolean") {
    errors.push(`${label} has an invalid school_day flag.`);
  }
  for (const key of pilotDayKeys.slice(2)) {
    if (!isNonNegativeInteger(value[key]))
      errors.push(`${label} has an invalid ${key}.`);
  }
  if (
    isNonNegativeInteger(value.jobs_total) &&
    isNonNegativeInteger(
      value.jobs_valid_terminal_without_database_intervention,
    ) &&
    value.jobs_valid_terminal_without_database_intervention > value.jobs_total
  ) {
    errors.push(`${label} has more valid terminal jobs than total jobs.`);
  }
  if (
    isNonNegativeInteger(value.frontend_sessions_total) &&
    isNonNegativeInteger(value.frontend_error_free_sessions) &&
    value.frontend_error_free_sessions > value.frontend_sessions_total
  ) {
    errors.push(`${label} has more error-free sessions than total sessions.`);
  }
  for (const [numerator, denominator, description] of [
    [
      "feedback_results_corrected",
      "feedback_results_reviewed",
      "feedback corrections",
    ],
    [
      "worksheet_score_overrides",
      "worksheet_scores_reviewed",
      "worksheet score overrides",
    ],
    [
      "worksheet_score_overrides_systemically_reviewed",
      "worksheet_score_overrides",
      "systemically reviewed score overrides",
    ],
  ] as const) {
    if (
      isNonNegativeInteger(value[numerator]) &&
      isNonNegativeInteger(value[denominator]) &&
      value[numerator] > value[denominator]
    ) {
      errors.push(`${label} has more ${description} than its denominator.`);
    }
  }
  if (errors.length !== initialErrorCount) return null;
  return value as unknown as PilotDayEvidence;
}

function parsePilotEvidence(value: unknown, errors: string[]) {
  if (!isRecord(value)) {
    errors.push("Pilot evidence must be a JSON object.");
    return null;
  }
  const initialErrorCount = errors.length;
  hasOnlyKeys(
    value,
    [
      "schema_version",
      "app_release",
      "project_ref",
      "deployed_at",
      "pilot_id",
      "pilot_started_at",
      "pilot_ended_at",
      "environment",
      "teacher_count",
      "student_count",
      "school_days_completed",
      "qualified_german_signoff",
      "days",
    ],
    "Pilot evidence",
    errors,
  );
  if (value.schema_version !== 3)
    errors.push("Pilot evidence must use schema_version 3.");
  if (!isReleaseId(value.app_release)) {
    errors.push("Pilot evidence has an invalid app_release.");
  }
  if (!isProjectRef(value.project_ref)) {
    errors.push("Pilot evidence has an invalid project_ref.");
  }
  if (!isUtcTimestamp(value.deployed_at)) {
    errors.push("Pilot evidence has an invalid UTC deployed_at.");
  }
  if (!isOpaqueId(value.pilot_id)) {
    errors.push("Pilot evidence has no valid opaque pilot_id.");
  }
  if (!isUtcTimestamp(value.pilot_started_at)) {
    errors.push("Pilot evidence has an invalid UTC pilot_started_at.");
  }
  if (!isUtcTimestamp(value.pilot_ended_at)) {
    errors.push("Pilot evidence has an invalid UTC pilot_ended_at.");
  }
  if (
    isUtcTimestamp(value.deployed_at) &&
    isUtcTimestamp(value.pilot_started_at) &&
    Date.parse(value.deployed_at) > Date.parse(value.pilot_started_at)
  ) {
    errors.push("Pilot evidence starts before the declared deployment.");
  }
  if (
    isUtcTimestamp(value.pilot_started_at) &&
    isUtcTimestamp(value.pilot_ended_at) &&
    Date.parse(value.pilot_started_at) > Date.parse(value.pilot_ended_at)
  ) {
    errors.push("Pilot evidence has an invalid pilot window.");
  }
  if (value.environment !== "production")
    errors.push("Pilot evidence must come from production.");
  if (
    !isPositiveInteger(value.teacher_count) ||
    value.teacher_count < MINIMUM_PILOT_TEACHERS ||
    value.teacher_count > MAXIMUM_PILOT_TEACHERS
  ) {
    errors.push("Pilot evidence must include 3–5 teachers.");
  }
  if (
    !isPositiveInteger(value.student_count) ||
    value.student_count < MINIMUM_PILOT_STUDENTS ||
    value.student_count > MAXIMUM_PILOT_STUDENTS
  ) {
    errors.push("Pilot evidence must include 20–50 students.");
  }
  if (
    !isPositiveInteger(value.school_days_completed) ||
    value.school_days_completed < REQUIRED_SCHOOL_DAYS
  ) {
    errors.push("Pilot evidence must cover at least ten school days.");
  }
  const signoff = value.qualified_german_signoff;
  if (
    !isRecord(signoff) ||
    Object.keys(signoff).some(
      (key) =>
        ![
          "evaluator_corpus_approved",
          "worksheet_bank_approved",
          "reviewer_id",
          "verified_at",
        ].includes(key),
    ) ||
    signoff.evaluator_corpus_approved !== true ||
    signoff.worksheet_bank_approved !== true ||
    !isOpaqueId(signoff.reviewer_id) ||
    !isUtcTimestamp(signoff.verified_at)
  ) {
    errors.push(
      "Pilot evidence requires qualified German approval for the evaluator corpus and worksheet bank.",
    );
  }
  const rawDays = value.days;
  if (!Array.isArray(rawDays))
    errors.push("Pilot evidence days must be an array.");
  if (errors.length !== initialErrorCount || !Array.isArray(rawDays))
    return null;

  const days = rawDays
    .map((day, index) => parsePilotDay(day, index, errors))
    .filter((day): day is PilotDayEvidence => day !== null);
  const suppliedSchoolDays = days.filter((day) => day.school_day).length;
  if (
    isPositiveInteger(value.school_days_completed) &&
    value.school_days_completed !== suppliedSchoolDays
  ) {
    errors.push(
      `Pilot declares ${value.school_days_completed} school days but supplies ${suppliedSchoolDays}.`,
    );
  }
  if (
    isUtcTimestamp(value.pilot_started_at) &&
    isUtcTimestamp(value.pilot_ended_at)
  ) {
    const firstDay = value.pilot_started_at.slice(0, 10);
    const lastDay = value.pilot_ended_at.slice(0, 10);
    const expectedDayCount = dayNumber(lastDay) - dayNumber(firstDay) + 1;
    const orderedDates = days.map((day) => day.date);
    const hasCompleteOrderedWindow =
      Number.isSafeInteger(expectedDayCount) &&
      expectedDayCount > 0 &&
      orderedDates.length === expectedDayCount &&
      orderedDates.every(
        (date, index) => dayNumber(date) === dayNumber(firstDay) + index,
      );
    if (!hasCompleteOrderedWindow) {
      errors.push(
        `Pilot window ${firstDay} through ${lastDay} must contain every UTC calendar day exactly once in chronological order.`,
      );
    }
  }
  return { ...value, days } as unknown as PilotEvidence;
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile95(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? null;
}

function maximum(values: number[]) {
  return values.length === 0 ? null : Math.max(...values);
}

function passesLimit(value: number | null, limit: number, inclusive: boolean) {
  if (value === null) return false;
  return inclusive ? value <= limit : value < limit;
}

function dayNumber(day: string) {
  return Date.parse(`${day}T00:00:00.000Z`) / 86_400_000;
}

function qualifyingLoadTest(rows: PerformanceEvidenceRow[]) {
  const byRun = new Map<string, PerformanceEvidenceRow[]>();
  for (const row of rows) {
    const existing = byRun.get(row.run_id) ?? [];
    existing.push(row);
    byRun.set(row.run_id, existing);
  }
  const required: PerformanceMetric[] = [
    "submission_acknowledgement_ms",
    "immediate_job_start_ms",
    "feedback_completion_ms",
  ];
  return [...byRun.values()].some((run) => {
    if (
      !run.every(
        (row) =>
          row.source === "synthetic" &&
          row.concurrent_users >= 20 &&
          row.load_generator_version === "schreiben-load-v1" &&
          isOpaqueId(row.virtual_user_id) &&
          isUtcTimestamp(row.virtual_user_started_at) &&
          isOpaqueId(row.load_attestation_id),
      ) ||
      new Set(run.map((row) => row.reporting_day)).size !== 1 ||
      new Set(run.map((row) => row.load_attestation_id)).size !== 1
    ) {
      return false;
    }

    const virtualUsers = new Set(run.map((row) => row.virtual_user_id!));
    if (virtualUsers.size < 20) return false;
    if (!run.every((row) => row.concurrent_users === virtualUsers.size)) {
      return false;
    }
    const starts = run.map((row) => Date.parse(row.virtual_user_started_at!));
    if (Math.max(...starts) - Math.min(...starts) > 2_000) return false;

    if (
      !required.every((metric) => {
        const metricRows = run.filter((row) => row.metric === metric);
        return (
          metricRows.length === virtualUsers.size &&
          new Set(metricRows.map((row) => row.virtual_user_id)).size ===
            virtualUsers.size
        );
      })
    ) {
      return false;
    }

    return [...virtualUsers].every((virtualUserId) => {
      const observedAt = new Map(
        run
          .filter((row) => row.virtual_user_id === virtualUserId)
          .map((row) => [row.metric, Date.parse(row.observed_at)]),
      );
      const acknowledgement = observedAt.get("submission_acknowledgement_ms");
      const jobStart = observedAt.get("immediate_job_start_ms");
      const completion = observedAt.get("feedback_completion_ms");
      return (
        acknowledgement !== undefined &&
        jobStart !== undefined &&
        completion !== undefined &&
        acknowledgement <= jobStart &&
        jobStart <= completion
      );
    });
  });
}

export function verifyReleaseGates(
  performanceValues: unknown[],
  pilotValue: unknown,
  expectedRelease: string,
  expectedProjectRef: string,
  now = new Date(),
): ReleaseGateReport {
  const errors: string[] = [];
  if (!isReleaseId(expectedRelease)) {
    errors.push("The expected app release is invalid.");
  }
  if (!isProjectRef(expectedProjectRef)) {
    errors.push("The expected production project ref is invalid.");
  }
  const nowMs = now.getTime();
  const hasValidNow = Number.isFinite(nowMs);
  if (!hasValidNow) {
    errors.push("The release-gate verification time is invalid.");
  }
  if (performanceValues.length === 0)
    errors.push("Performance evidence is empty.");
  const rows = performanceValues
    .map((value, index) => parsePerformanceRow(value, index, errors))
    .filter((row): row is PerformanceEvidenceRow => row !== null);

  const eventIds = new Set<string>();
  for (const row of rows) {
    if (eventIds.has(row.event_id))
      errors.push(`Duplicate performance event_id: ${row.event_id}.`);
    eventIds.add(row.event_id);
    if (row.app_release !== expectedRelease) {
      errors.push(
        `Performance row ${row.event_id} does not belong to release ${expectedRelease}.`,
      );
    }
    if (row.project_ref !== expectedProjectRef) {
      errors.push(
        `Performance row ${row.event_id} does not belong to production project ${expectedProjectRef}.`,
      );
    }
  }

  const pilot = parsePilotEvidence(pilotValue, errors);
  const pilotDays = pilot?.days ?? [];
  if (pilot) {
    if (pilot.app_release !== expectedRelease) {
      errors.push(
        `Pilot evidence does not belong to release ${expectedRelease}.`,
      );
    }
    if (pilot.project_ref !== expectedProjectRef) {
      errors.push(
        `Pilot evidence does not belong to production project ${expectedProjectRef}.`,
      );
    }
    for (const row of rows) {
      if (
        row.pilot_id !== pilot.pilot_id ||
        row.deployed_at !== pilot.deployed_at ||
        row.pilot_started_at !== pilot.pilot_started_at ||
        row.pilot_ended_at !== pilot.pilot_ended_at
      ) {
        errors.push(
          `Performance row ${row.event_id} is not bound to the supplied pilot and deployment window.`,
        );
      }
    }
  }

  if (hasValidNow) {
    const futureObserved = rows.filter(
      (row) => Date.parse(row.observed_at) > nowMs,
    ).length;
    if (futureObserved > 0) {
      errors.push(
        `Performance evidence contains ${futureObserved} row(s) with a future observed_at.`,
      );
    }
    const futureVirtualUserStarts = rows.filter(
      (row) =>
        row.virtual_user_started_at !== undefined &&
        Date.parse(row.virtual_user_started_at) > nowMs,
    ).length;
    if (futureVirtualUserStarts > 0) {
      errors.push(
        `Performance evidence contains ${futureVirtualUserStarts} row(s) with a future virtual_user_started_at.`,
      );
    }
    const futureRowBoundaries = rows.filter(
      (row) =>
        Date.parse(row.deployed_at) > nowMs ||
        Date.parse(row.pilot_started_at) > nowMs ||
        Date.parse(row.pilot_ended_at) > nowMs,
    ).length;
    if (futureRowBoundaries > 0) {
      errors.push(
        `Performance evidence contains ${futureRowBoundaries} row(s) with a future deployment or pilot-window timestamp.`,
      );
    }

    if (rows.length > 0 && futureObserved === 0) {
      const latestObservation = rows.reduce(
        (latest, row) => Math.max(latest, Date.parse(row.observed_at)),
        Number.NEGATIVE_INFINITY,
      );
      if (nowMs - latestObservation > MAXIMUM_LATEST_PERFORMANCE_AGE_MS) {
        errors.push(
          "Latest performance observation is stale; it must be no more than 36 hours old.",
        );
      }
    }

    if (pilot) {
      if (Date.parse(pilot.deployed_at) > nowMs) {
        errors.push("Pilot evidence has a future deployed_at.");
      }
      if (Date.parse(pilot.pilot_started_at) > nowMs) {
        errors.push("Pilot evidence has a future pilot_started_at.");
      }
      if (Date.parse(pilot.pilot_ended_at) > nowMs) {
        errors.push("Pilot evidence has a future pilot_ended_at.");
      }
      const today = now.toISOString().slice(0, 10);
      for (const day of pilotDays) {
        if (day.date > today) {
          errors.push(`Pilot evidence contains future pilot day ${day.date}.`);
        }
      }
      const signoffAt = Date.parse(pilot.qualified_german_signoff.verified_at);
      if (signoffAt > nowMs) {
        errors.push("Qualified German sign-off has a future verified_at.");
      }
      if (signoffAt < Date.parse(pilot.deployed_at)) {
        errors.push(
          "Qualified German sign-off predates the declared deployment.",
        );
      }
    }
  }
  const dayIds = new Set<string>();
  for (const day of pilotDays) {
    if (dayIds.has(day.date)) errors.push(`Duplicate pilot day: ${day.date}.`);
    dayIds.add(day.date);
  }
  if (pilotDays.length < REQUIRED_GREEN_DAYS) {
    errors.push(
      `Pilot evidence has ${pilotDays.length}/${REQUIRED_GREEN_DAYS} required days.`,
    );
  }

  const rowsByDay = new Map<string, PerformanceEvidenceRow[]>();
  for (const row of rows) {
    const existing = rowsByDay.get(row.reporting_day) ?? [];
    existing.push(row);
    rowsByDay.set(row.reporting_day, existing);
  }

  const daily = [...pilotDays]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((day): DailyReport => {
      const dayRows = rowsByDay.get(day.date) ?? [];
      const failures: string[] = [];
      const performance = {} as Record<PerformanceMetric, MetricReport>;
      for (const metric of performanceMetrics) {
        const definition = performanceGateDefinitions[metric];
        const durations = dayRows
          .filter((row) => row.metric === metric)
          .map((row) => row.duration_ms);
        const observed =
          definition.statistic === "p95"
            ? percentile95(durations)
            : maximum(durations);
        const enoughSamples = durations.length >= MINIMUM_DAILY_SAMPLES;
        const withinLimit = passesLimit(
          observed,
          definition.limitMs,
          definition.inclusive,
        );
        const ok = enoughSamples && withinLimit;
        performance[metric] = {
          samples: durations.length,
          statistic: definition.statistic,
          observed_ms: observed,
          limit_ms: definition.limitMs,
          inclusive: definition.inclusive,
          ok,
        };
        if (!enoughSamples) {
          failures.push(
            `${definition.label} has ${durations.length}/${MINIMUM_DAILY_SAMPLES} required samples.`,
          );
        } else if (!withinLimit) {
          const operator = definition.inclusive ? "<=" : "<";
          failures.push(
            `${definition.label} ${definition.statistic} is ${observed}ms; required ${operator}${definition.limitMs}ms.`,
          );
        }
      }

      const jobsTerminalRate = ratio(
        day.jobs_valid_terminal_without_database_intervention,
        day.jobs_total,
      );
      const frontendRate = ratio(
        day.frontend_error_free_sessions,
        day.frontend_sessions_total,
      );
      const feedbackCorrectionRate = ratio(
        day.feedback_results_corrected,
        day.feedback_results_reviewed,
      );
      const worksheetOverrideRate = ratio(
        day.worksheet_score_overrides,
        day.worksheet_scores_reviewed,
      );
      if (day.jobs_total < MINIMUM_DAILY_JOBS) {
        failures.push(
          `Jobs have ${day.jobs_total}/${MINIMUM_DAILY_JOBS} required daily observations.`,
        );
      } else if (jobsTerminalRate < REQUIRED_SUCCESS_RATE) {
        failures.push(
          `Valid terminal job rate is ${(jobsTerminalRate * 100).toFixed(3)}%; required >=99.5%.`,
        );
      }
      if (day.frontend_sessions_total < MINIMUM_DAILY_SESSIONS) {
        failures.push(
          `Frontend sessions have ${day.frontend_sessions_total}/${MINIMUM_DAILY_SESSIONS} required daily observations.`,
        );
      } else if (frontendRate < REQUIRED_SUCCESS_RATE) {
        failures.push(
          `Frontend error-free rate is ${(frontendRate * 100).toFixed(3)}%; required >=99.5%.`,
        );
      }
      if (
        day.feedback_results_reviewed > 0 &&
        feedbackCorrectionRate >= MAXIMUM_TEACHER_CORRECTION_RATE
      ) {
        failures.push(
          `Teacher feedback correction rate is ${(feedbackCorrectionRate * 100).toFixed(3)}%; required <5%.`,
        );
      }
      if (
        day.worksheet_scores_reviewed > 0 &&
        worksheetOverrideRate >= MAXIMUM_TEACHER_CORRECTION_RATE
      ) {
        failures.push(
          `Teacher score override rate is ${(worksheetOverrideRate * 100).toFixed(3)}%; required <5%.`,
        );
      }
      if (
        day.worksheet_score_overrides_systemically_reviewed !==
        day.worksheet_score_overrides
      ) {
        failures.push(
          "Every teacher score override must receive systemic review.",
        );
      }

      const zeroFields: Array<[NumericPilotDayKey, string]> = [
        [
          "stuck_jobs_beyond_recovery_threshold",
          "stuck jobs beyond the recovery threshold",
        ],
        ["unresolved_p0_findings", "unresolved P0 findings"],
        ["unresolved_p1_findings", "unresolved P1 findings"],
        ["unauthorized_access_incidents", "unauthorized-access incidents"],
        [
          "cross_workspace_leakage_incidents",
          "cross-workspace leakage incidents",
        ],
        [
          "other_security_leakage_incidents",
          "other security-leakage incidents",
        ],
        ["lost_submissions", "lost submissions"],
        ["lost_worksheet_answers", "lost worksheet answers"],
        [
          "exposed_private_feedback_incidents",
          "private-feedback exposure incidents",
        ],
        [
          "unresolved_critical_accessibility_findings",
          "unresolved critical accessibility findings",
        ],
        [
          "unresolved_high_accessibility_findings",
          "unresolved high accessibility findings",
        ],
      ];
      for (const [field, label] of zeroFields) {
        if (day[field] !== 0)
          failures.push(`${label} must be zero; observed ${day[field]}.`);
      }

      const performanceOk = performanceMetrics.every(
        (metric) => performance[metric].ok,
      );
      const operationalOk =
        day.jobs_total >= MINIMUM_DAILY_JOBS &&
        jobsTerminalRate >= REQUIRED_SUCCESS_RATE &&
        day.frontend_sessions_total >= MINIMUM_DAILY_SESSIONS &&
        frontendRate >= REQUIRED_SUCCESS_RATE &&
        (day.feedback_results_reviewed === 0 ||
          feedbackCorrectionRate < MAXIMUM_TEACHER_CORRECTION_RATE) &&
        (day.worksheet_scores_reviewed === 0 ||
          worksheetOverrideRate < MAXIMUM_TEACHER_CORRECTION_RATE) &&
        day.worksheet_score_overrides_systemically_reviewed ===
          day.worksheet_score_overrides &&
        zeroFields.every(([field]) => day[field] === 0);
      return {
        date: day.date,
        performance,
        jobs_terminal_rate: jobsTerminalRate,
        frontend_error_free_rate: frontendRate,
        feedback_correction_rate: feedbackCorrectionRate,
        worksheet_score_override_rate: worksheetOverrideRate,
        operational_ok: operationalOk,
        green: performanceOk && operationalOk,
        failures,
      };
    });

  let trailingGreenDays = 0;
  let previousDay: number | null = null;
  for (const report of daily) {
    const currentDay = dayNumber(report.date);
    if (
      report.green &&
      (previousDay === null || currentDay === previousDay + 1)
    ) {
      trailingGreenDays += 1;
    } else {
      trailingGreenDays = report.green ? 1 : 0;
    }
    previousDay = currentDay;
  }
  if (trailingGreenDays < REQUIRED_GREEN_DAYS) {
    errors.push(
      `Pilot has ${trailingGreenDays}/${REQUIRED_GREEN_DAYS} trailing consecutive green UTC days.`,
    );
  }

  const totalJobs = pilotDays.reduce((sum, day) => sum + day.jobs_total, 0);
  const validJobs = pilotDays.reduce(
    (sum, day) => sum + day.jobs_valid_terminal_without_database_intervention,
    0,
  );
  const totalSessions = pilotDays.reduce(
    (sum, day) => sum + day.frontend_sessions_total,
    0,
  );
  const errorFreeSessions = pilotDays.reduce(
    (sum, day) => sum + day.frontend_error_free_sessions,
    0,
  );
  const aggregateJobRate = ratio(validJobs, totalJobs);
  const aggregateFrontendRate = ratio(errorFreeSessions, totalSessions);
  const feedbackReviewed = pilotDays.reduce(
    (sum, day) => sum + day.feedback_results_reviewed,
    0,
  );
  const feedbackCorrected = pilotDays.reduce(
    (sum, day) => sum + day.feedback_results_corrected,
    0,
  );
  const worksheetScoresReviewed = pilotDays.reduce(
    (sum, day) => sum + day.worksheet_scores_reviewed,
    0,
  );
  const worksheetOverrides = pilotDays.reduce(
    (sum, day) => sum + day.worksheet_score_overrides,
    0,
  );
  const worksheetOverridesReviewed = pilotDays.reduce(
    (sum, day) => sum + day.worksheet_score_overrides_systemically_reviewed,
    0,
  );
  const aggregateFeedbackCorrectionRate = ratio(
    feedbackCorrected,
    feedbackReviewed,
  );
  const aggregateWorksheetOverrideRate = ratio(
    worksheetOverrides,
    worksheetScoresReviewed,
  );
  if (aggregateJobRate < REQUIRED_SUCCESS_RATE) {
    errors.push("Aggregate valid terminal job rate is below 99.5%.");
  }
  if (aggregateFrontendRate < REQUIRED_SUCCESS_RATE) {
    errors.push("Aggregate frontend error-free session rate is below 99.5%.");
  }
  if (feedbackReviewed < MINIMUM_EDUCATIONAL_REVIEWS) {
    errors.push(
      `Pilot has ${feedbackReviewed}/${MINIMUM_EDUCATIONAL_REVIEWS} required teacher feedback reviews.`,
    );
  } else if (
    aggregateFeedbackCorrectionRate >= MAXIMUM_TEACHER_CORRECTION_RATE
  ) {
    errors.push("Aggregate teacher feedback correction rate is not below 5%.");
  }
  if (worksheetScoresReviewed < MINIMUM_EDUCATIONAL_REVIEWS) {
    errors.push(
      `Pilot has ${worksheetScoresReviewed}/${MINIMUM_EDUCATIONAL_REVIEWS} required teacher score reviews.`,
    );
  } else if (
    aggregateWorksheetOverrideRate >= MAXIMUM_TEACHER_CORRECTION_RATE
  ) {
    errors.push("Aggregate teacher score override rate is not below 5%.");
  }
  if (worksheetOverridesReviewed !== worksheetOverrides) {
    errors.push(
      "Every pilot score override must have systemic-review evidence.",
    );
  }

  const irreversibleIncidentFields: Array<[NumericPilotDayKey, string]> = [
    [
      "stuck_jobs_beyond_recovery_threshold",
      "stuck jobs beyond the recovery threshold",
    ],
    ["unauthorized_access_incidents", "unauthorized-access incidents"],
    ["cross_workspace_leakage_incidents", "cross-workspace leakage incidents"],
    ["other_security_leakage_incidents", "other security-leakage incidents"],
    ["lost_submissions", "lost submissions"],
    ["lost_worksheet_answers", "lost worksheet answers"],
    [
      "exposed_private_feedback_incidents",
      "private-feedback exposure incidents",
    ],
  ];
  for (const [field, label] of irreversibleIncidentFields) {
    const total = pilotDays.reduce((sum, day) => sum + day[field], 0);
    if (total !== 0)
      errors.push(`Pilot-wide ${label} must be zero; observed ${total}.`);
  }

  const loadTest20Concurrent = qualifyingLoadTest(rows);
  if (!loadTest20Concurrent) {
    errors.push(
      "No synthetic run proves at least 20 concurrent submissions through acknowledgement, start, and feedback completion.",
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    minimum_daily_samples: MINIMUM_DAILY_SAMPLES,
    load_test_20_concurrent: loadTest20Concurrent,
    pilot: {
      days_supplied: pilotDays.length,
      trailing_consecutive_green_days: trailingGreenDays,
      required_consecutive_green_days: REQUIRED_GREEN_DAYS,
      aggregate_job_terminal_rate: aggregateJobRate,
      aggregate_frontend_error_free_rate: aggregateFrontendRate,
      aggregate_feedback_correction_rate: aggregateFeedbackCorrectionRate,
      aggregate_worksheet_score_override_rate: aggregateWorksheetOverrideRate,
      school_days_completed: pilot?.school_days_completed ?? 0,
      qualified_german_signoff: Boolean(
        pilot?.qualified_german_signoff.evaluator_corpus_approved &&
        pilot.qualified_german_signoff.worksheet_bank_approved,
      ),
      daily,
    },
  };
}

export function parseJsonLines(source: string, label: string) {
  return source.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      throw new Error(`${label} line ${index + 1} is not valid JSON.`);
    }
  });
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const performancePath = argument("--performance");
  const pilotPath = argument("--pilot");
  const release = argument("--release");
  const projectRef = argument("--project-ref");
  if (!performancePath || !pilotPath || !release || !projectRef) {
    throw new Error(
      "Usage: release:verify -- --release <app-release> --project-ref <production-project-ref> --performance <performance-samples.jsonl> --pilot <pilot-days.json>",
    );
  }
  const workspaceRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const workspacePath = (path: string) =>
    isAbsolute(path) ? path : resolve(workspaceRoot, path);
  const [performanceSource, pilotSource] = await Promise.all([
    readFile(workspacePath(performancePath), "utf8"),
    readFile(workspacePath(pilotPath), "utf8"),
  ]);
  let pilotValue: unknown;
  try {
    pilotValue = JSON.parse(pilotSource) as unknown;
  } catch {
    throw new Error("Pilot evidence is not valid JSON.");
  }
  const report = verifyReleaseGates(
    parseJsonLines(performanceSource, "Performance evidence"),
    pilotValue,
    release,
    projectRef,
  );
  console.log(JSON.stringify(report, null, 2));
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
        : "Release-gate verification failed.",
    );
    process.exitCode = 1;
  });
}
