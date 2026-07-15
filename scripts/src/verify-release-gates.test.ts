import assert from "node:assert/strict";
import test from "node:test";
import {
  parseJsonLines,
  type PerformanceEvidenceRow,
  type PerformanceMetric,
  type PilotEvidence,
  verifyReleaseGates,
} from "./verify-release-gates.js";

const metrics: Array<[PerformanceMetric, number]> = [
  ["dashboard_request_ms", 1_500],
  ["list_request_ms", 1_500],
  ["submission_acknowledgement_ms", 800],
  ["immediate_job_start_ms", 4_000],
  ["feedback_completion_ms", 50_000],
  ["scheduled_release_lag_ms", 50_000],
  ["reused_worksheet_ms", 1_500],
  ["generated_worksheet_progress_ms", 800],
  ["generated_worksheet_ms", 80_000],
];

const APP_RELEASE = "release-2026-07-10";
const PROJECT_REF = "abcde1ghijklmnopqrst";

function utcDay(offset: number) {
  return new Date(Date.UTC(2026, 6, 1 + offset)).toISOString().slice(0, 10);
}

function validEvidence(dayCount = 10): {
  performance: PerformanceEvidenceRow[];
  pilot: PilotEvidence;
} {
  const performance: PerformanceEvidenceRow[] = [];
  const pilotId = "pilot-2026-07";
  const deployedAt = `${utcDay(0)}T08:00:00.000Z`;
  const pilotStartedAt = `${utcDay(0)}T09:00:00.000Z`;
  const pilotEndedAt = `${utcDay(dayCount - 1)}T18:00:00.000Z`;
  const days = Array.from({ length: dayCount }, (_, dayIndex) => {
    const date = utcDay(dayIndex);
    for (const [metric, duration] of metrics) {
      for (let sample = 0; sample < 20; sample += 1) {
        performance.push({
          schema_version: 2,
          app_release: APP_RELEASE,
          project_ref: PROJECT_REF,
          deployed_at: deployedAt,
          pilot_id: pilotId,
          pilot_started_at: pilotStartedAt,
          pilot_ended_at: pilotEndedAt,
          event_id: `${date}-${metric}-${sample}`,
          observed_at: `${date}T12:00:00.000Z`,
          reporting_day: date,
          environment: "production",
          source: "synthetic",
          run_id: `load-${date}`,
          metric,
          duration_ms: duration,
          concurrent_users: 20,
          virtual_user_id: `virtual-user-${sample.toString().padStart(2, "0")}`,
          virtual_user_started_at: `${date}T11:59:59.000Z`,
          load_attestation_id: `load-attestation-${date}`,
          load_generator_version: "schreiben-load-v1",
          ...(metric === "feedback_completion_ms"
            ? { input_chars: 1_500 }
            : {}),
        });
      }
    }
    return {
      date,
      school_day: true,
      jobs_total: 200,
      jobs_valid_terminal_without_database_intervention: 200,
      frontend_sessions_total: 200,
      frontend_error_free_sessions: 200,
      stuck_jobs_beyond_recovery_threshold: 0,
      unresolved_p0_findings: 0,
      unresolved_p1_findings: 0,
      unauthorized_access_incidents: 0,
      cross_workspace_leakage_incidents: 0,
      other_security_leakage_incidents: 0,
      lost_submissions: 0,
      lost_worksheet_answers: 0,
      exposed_private_feedback_incidents: 0,
      feedback_results_reviewed: 100,
      feedback_results_corrected: 0,
      worksheet_scores_reviewed: 100,
      worksheet_score_overrides: 0,
      worksheet_score_overrides_systemically_reviewed: 0,
      unresolved_critical_accessibility_findings: 0,
      unresolved_high_accessibility_findings: 0,
    };
  });
  return {
    performance,
    pilot: {
      schema_version: 3,
      app_release: APP_RELEASE,
      project_ref: PROJECT_REF,
      deployed_at: deployedAt,
      pilot_id: pilotId,
      pilot_started_at: pilotStartedAt,
      pilot_ended_at: pilotEndedAt,
      environment: "production",
      teacher_count: 4,
      student_count: 32,
      school_days_completed: dayCount,
      qualified_german_signoff: {
        evaluator_corpus_approved: true,
        worksheet_bank_approved: true,
        reviewer_id: "german-reviewer-2026",
        verified_at: "2026-07-10T16:00:00.000Z",
      },
      days,
    },
  };
}

function verificationNow(pilot: PilotEvidence) {
  return new Date(Date.parse(pilot.pilot_ended_at) + 6 * 60 * 60_000);
}

function verify(
  evidence: ReturnType<typeof validEvidence>,
  now = verificationNow(evidence.pilot),
) {
  return verifyReleaseGates(
    evidence.performance,
    evidence.pilot,
    APP_RELEASE,
    PROJECT_REF,
    now,
  );
}

test("passes only when every performance and pilot exit gate has seven green days", () => {
  const evidence = validEvidence();
  const report = verify(evidence);

  assert.equal(report.ok, true);
  assert.equal(report.load_test_20_concurrent, true);
  assert.equal(report.pilot.trailing_consecutive_green_days, 10);
  assert.equal(report.pilot.aggregate_job_terminal_rate, 1);
  assert.equal(report.pilot.aggregate_frontend_error_free_rate, 1);
  assert.equal(report.pilot.aggregate_feedback_correction_rate, 0);
  assert.equal(report.pilot.aggregate_worksheet_score_override_rate, 0);
  assert.equal(report.pilot.school_days_completed, 10);
  assert.equal(report.pilot.qualified_german_signoff, true);
  assert.deepEqual(report.errors, []);
});

test("uses nearest-rank p95 and the strict limits from the launch plan", () => {
  const evidence = validEvidence();
  const latest = evidence.pilot.days.at(-1)!.date;
  const dashboardRows = evidence.performance.filter(
    (row) =>
      row.reporting_day === latest && row.metric === "dashboard_request_ms",
  );
  dashboardRows.at(-1)!.duration_ms = 2_000;
  dashboardRows.at(-2)!.duration_ms = 2_000;

  const report = verify(evidence);
  const day = report.pilot.daily.at(-1)!;
  assert.equal(day.performance.dashboard_request_ms.observed_ms, 2_000);
  assert.equal(day.performance.dashboard_request_ms.ok, false);
  assert(day.failures.some((failure) => failure.includes("required <2000ms")));
  assert.equal(report.ok, false);
});

for (const [metric, threshold] of [
  ["list_request_ms", 2_000],
  ["submission_acknowledgement_ms", 1_000],
  ["immediate_job_start_ms", 5_000],
  ["feedback_completion_ms", 60_000],
  ["generated_worksheet_progress_ms", 1_000],
  ["generated_worksheet_ms", 90_000],
] as const satisfies ReadonlyArray<readonly [PerformanceMetric, number]>) {
  test(`${metric} fails when nearest-rank p95 equals its strict threshold`, () => {
    const evidence = validEvidence();
    const latest = evidence.pilot.days.at(-1)!.date;
    const rows = evidence.performance.filter(
      (row) => row.reporting_day === latest && row.metric === metric,
    );
    rows.at(-1)!.duration_ms = threshold;
    rows.at(-2)!.duration_ms = threshold;

    const report = verify(evidence);
    const metricReport = report.pilot.daily.at(-1)!.performance[metric];
    assert.equal(metricReport.statistic, "p95");
    assert.equal(metricReport.observed_ms, threshold);
    assert.equal(metricReport.ok, false);
    assert.equal(report.ok, false);
  });
}

test("enforces maximum scheduled lag and reused worksheet latency", () => {
  const evidence = validEvidence();
  const latest = evidence.pilot.days.at(-1)!.date;
  const scheduled = evidence.performance.find(
    (row) =>
      row.reporting_day === latest && row.metric === "scheduled_release_lag_ms",
  )!;
  const reused = evidence.performance.find(
    (row) =>
      row.reporting_day === latest && row.metric === "reused_worksheet_ms",
  )!;
  scheduled.duration_ms = 60_001;
  reused.duration_ms = 2_000;

  const report = verify(evidence);
  const day = report.pilot.daily.at(-1)!;
  assert.equal(day.performance.scheduled_release_lag_ms.statistic, "max");
  assert.equal(day.performance.scheduled_release_lag_ms.ok, false);
  assert.equal(day.performance.reused_worksheet_ms.ok, false);
  assert(
    day.failures.some((failure) => failure.includes("required <=60000ms")),
  );
  assert(day.failures.some((failure) => failure.includes("required <2000ms")));
});

test("fails closed when a daily metric has fewer than 20 samples", () => {
  const evidence = validEvidence();
  const latest = evidence.pilot.days.at(-1)!.date;
  const index = evidence.performance.findIndex(
    (row) =>
      row.reporting_day === latest && row.metric === "generated_worksheet_ms",
  );
  evidence.performance.splice(index, 1);

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert(
    report.pilot.daily
      .at(-1)!
      .failures.some((failure) =>
        failure.includes("Generated worksheet completion has 19/20"),
      ),
  );
});

test("accepts exactly 99.5 percent and rejects anything below it", () => {
  const evidence = validEvidence();
  evidence.pilot.days.at(
    -1,
  )!.jobs_valid_terminal_without_database_intervention = 199;
  evidence.pilot.days.at(-1)!.frontend_error_free_sessions = 199;
  assert.equal(verify(evidence).ok, true);

  evidence.pilot.days.at(
    -1,
  )!.jobs_valid_terminal_without_database_intervention = 198;
  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert(
    report.pilot.daily
      .at(-1)!
      .failures.some((failure) => failure.includes("99.000%")),
  );
});

test("requires seven trailing calendar-consecutive green UTC days", () => {
  const evidence = validEvidence();
  const previousLast = evidence.pilot.days.at(-1)!.date;
  const skipped = utcDay(11);
  evidence.pilot.days.at(-1)!.date = skipped;
  evidence.pilot.pilot_ended_at = `${skipped}T18:00:00.000Z`;
  for (const row of evidence.performance) {
    row.pilot_ended_at = evidence.pilot.pilot_ended_at;
    if (row.reporting_day === previousLast) {
      row.reporting_day = skipped;
      row.observed_at = `${skipped}T12:00:00.000Z`;
    }
  }

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert.equal(report.pilot.trailing_consecutive_green_days, 1);
  assert(
    report.errors.some((error) => error.includes("1/7 trailing consecutive")),
  );
});

test("pilot-wide security leakage, lost work, private feedback, and stuck jobs are fatal", () => {
  const evidence = validEvidence(11);
  evidence.pilot.days[0]!.unauthorized_access_incidents = 1;
  evidence.pilot.days[0]!.lost_worksheet_answers = 1;
  evidence.pilot.days[0]!.exposed_private_feedback_incidents = 1;
  evidence.pilot.days[0]!.stuck_jobs_beyond_recovery_threshold = 1;

  const report = verify(evidence);
  assert.equal(report.pilot.trailing_consecutive_green_days, 10);
  assert.equal(report.ok, false);
  assert(
    report.errors.some((error) =>
      error.includes("Pilot-wide unauthorized-access"),
    ),
  );
  assert(
    report.errors.some((error) =>
      error.includes("Pilot-wide lost worksheet answers"),
    ),
  );
  assert(
    report.errors.some((error) =>
      error.includes("Pilot-wide private-feedback exposure"),
    ),
  );
  assert(
    report.errors.some((error) => error.includes("Pilot-wide stuck jobs")),
  );
});

test("an unresolved P0 or P1 prevents a green pilot exit day", () => {
  const evidence = validEvidence();
  evidence.pilot.days.at(-1)!.unresolved_p0_findings = 1;
  evidence.pilot.days.at(-1)!.unresolved_p1_findings = 1;

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert.equal(report.pilot.daily.at(-1)!.operational_ok, false);
  assert(
    report.pilot.daily
      .at(-1)!
      .failures.some((failure) => failure.includes("unresolved P0")),
  );
  assert(
    report.pilot.daily
      .at(-1)!
      .failures.some((failure) => failure.includes("unresolved P1")),
  );
});

test("requires the complete ten-school-day pilot cohort and qualified German sign-off", () => {
  const evidence = validEvidence();
  evidence.pilot.teacher_count = 2;
  evidence.pilot.student_count = 51;
  evidence.pilot.school_days_completed = 9;
  evidence.pilot.days[0]!.school_day = false;
  evidence.pilot.qualified_german_signoff.worksheet_bank_approved = false;

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert(report.errors.some((error) => error.includes("3–5 teachers")));
  assert(report.errors.some((error) => error.includes("20–50 students")));
  assert(report.errors.some((error) => error.includes("ten school days")));
  assert(
    report.errors.some((error) => error.includes("qualified German approval")),
  );
});

test("requires sub-five-percent correction rates, systemic override review, and zero high accessibility findings", () => {
  const evidence = validEvidence();
  const latest = evidence.pilot.days.at(-1)!;
  latest.feedback_results_corrected = 5;
  latest.worksheet_score_overrides = 5;
  latest.worksheet_score_overrides_systemically_reviewed = 4;
  latest.unresolved_high_accessibility_findings = 1;

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert(
    report.pilot.daily
      .at(-1)!
      .failures.some((failure) => failure.includes("correction rate")),
  );
  assert(
    report.pilot.daily
      .at(-1)!
      .failures.some((failure) => failure.includes("override rate")),
  );
  assert(
    report.errors.some((error) => error.includes("systemic-review evidence")),
  );
  assert(
    report.pilot.daily
      .at(-1)!
      .failures.some((failure) => failure.includes("high accessibility")),
  );
});

test("requires a 20-concurrent synthetic submission run", () => {
  const evidence = validEvidence();
  for (const row of evidence.performance) row.concurrent_users = 19;

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert.equal(report.load_test_20_concurrent, false);
  assert(
    report.errors.some((error) => error.includes("20 concurrent submissions")),
  );
});

test("rejects a claimed concurrency count without 20 synchronized virtual users", () => {
  const evidence = validEvidence();
  const latestRun = `load-${evidence.pilot.days.at(-1)!.date}`;
  for (const row of evidence.performance) {
    if (row.run_id === latestRun) {
      row.virtual_user_id = "one-reused-virtual-user";
    }
  }
  for (const row of evidence.performance) {
    if (row.run_id !== latestRun) row.concurrent_users = 19;
  }

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert.equal(report.load_test_20_concurrent, false);
});

test("rejects unsynchronized or mixed-attestation synthetic load evidence", () => {
  const evidence = validEvidence();
  for (const row of evidence.performance) {
    row.concurrent_users = 19;
  }
  const latest = evidence.pilot.days.at(-1)!.date;
  const latestRows = evidence.performance.filter(
    (row) => row.reporting_day === latest,
  );
  for (const row of latestRows) row.concurrent_users = 20;
  latestRows[0]!.virtual_user_started_at = `${latest}T12:00:03.500Z`;
  latestRows[1]!.load_attestation_id = "different-load-attestation";

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert.equal(report.load_test_20_concurrent, false);
});

test("rejects load evidence whose per-user lifecycle timestamps are out of order", () => {
  const evidence = validEvidence();
  for (const row of evidence.performance) row.concurrent_users = 19;
  const latest = evidence.pilot.days.at(-1)!.date;
  const latestRows = evidence.performance.filter(
    (row) => row.reporting_day === latest,
  );
  for (const row of latestRows) row.concurrent_users = 20;
  const firstUserJobStart = latestRows.find(
    (row) =>
      row.virtual_user_id === "virtual-user-00" &&
      row.metric === "immediate_job_start_ms",
  )!;
  firstUserJobStart.observed_at = `${latest}T11:59:59.500Z`;

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert.equal(report.load_test_20_concurrent, false);
});

test("rejects malformed or content-bearing performance rows", () => {
  const evidence = validEvidence();
  const malformed = {
    ...evidence.performance[0],
    event_id: "content-bearing-row",
    student_text: "This field must never be exported",
  };
  const report = verifyReleaseGates(
    [...evidence.performance, malformed],
    evidence.pilot,
    APP_RELEASE,
    PROJECT_REF,
    verificationNow(evidence.pilot),
  );
  assert.equal(report.ok, false);
  assert(
    report.errors.some((error) =>
      error.includes("unsupported field(s): student_text"),
    ),
  );
});

test("rejects non-UTC timestamps and identifiers that could contain personal data", () => {
  const evidence = validEvidence();
  const row = {
    ...evidence.performance[0],
    event_id: "student@example.invalid",
    observed_at: "2026-07-01Z",
  };

  const report = verifyReleaseGates(
    [row, ...evidence.performance.slice(1)],
    evidence.pilot,
    APP_RELEASE,
    PROJECT_REF,
    verificationNow(evidence.pilot),
  );
  assert.equal(report.ok, false);
  assert(report.errors.some((error) => error.includes("opaque event_id")));
  assert(
    report.errors.some((error) => error.includes("invalid UTC observed_at")),
  );
});

test("rejects malformed pilot counts and unknown free-text fields", () => {
  const evidence = validEvidence();
  const pilot = structuredClone(evidence.pilot) as unknown as Record<
    string,
    unknown
  >;
  const days = pilot.days as Array<Record<string, unknown>>;
  days[0]!.student_email = "not-allowed@example.invalid";
  days[1]!.jobs_total = -1;

  const report = verifyReleaseGates(
    evidence.performance,
    pilot,
    APP_RELEASE,
    PROJECT_REF,
    verificationNow(evidence.pilot),
  );
  assert.equal(report.ok, false);
  assert(report.errors.some((error) => error.includes("student_email")));
  assert(report.errors.some((error) => error.includes("invalid jobs_total")));
});

test("JSONL parsing reports the exact malformed line", () => {
  assert.throws(
    () =>
      parseJsonLines('{"schema_version":1}\nnot-json', "Performance evidence"),
    /Performance evidence line 2 is not valid JSON/,
  );
});

test("binds every row and the pilot envelope to the exact release and project", () => {
  const evidence = validEvidence();
  evidence.performance[0]!.app_release = "release-2026-07-09";
  evidence.performance[1]!.project_ref = "zyxwvutsrqponmlkjihg";
  evidence.performance[2]!.pilot_id = "different-pilot-id";
  evidence.pilot.app_release = "release-2026-07-09";
  evidence.pilot.project_ref = "zyxwvutsrqponmlkjihg";

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert(
    report.errors.some((error) =>
      error.includes("does not belong to release release-2026-07-10"),
    ),
  );
  assert(
    report.errors.some((error) =>
      error.includes(
        `does not belong to production project ${PROJECT_REF}`,
      ),
    ),
  );
  assert(
    report.errors.some((error) =>
      error.includes(
        "is not bound to the supplied pilot and deployment window",
      ),
    ),
  );
});

test("rejects performance observations collected before deployment or outside the pilot window", () => {
  const evidence = validEvidence();
  const row = evidence.performance[0]!;
  row.observed_at = `${utcDay(0)}T07:59:00.000Z`;
  row.virtual_user_started_at = `${utcDay(0)}T07:58:59.000Z`;

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert(
    report.errors.some((error) => error.includes("before its deployment")),
  );
  assert(
    report.errors.some((error) => error.includes("outside its pilot window")),
  );
});

test("rejects stale performance evidence using the injected verification time", () => {
  const evidence = validEvidence();
  const now = new Date(
    Date.parse(evidence.pilot.pilot_ended_at) + 49 * 60 * 60_000,
  );

  const report = verify(evidence, now);
  assert.equal(report.ok, false);
  assert(
    report.errors.some((error) =>
      error.includes("Latest performance observation is stale"),
    ),
  );
});

test("rejects a non-contiguous pilot window", () => {
  const evidence = validEvidence();
  evidence.pilot.days.splice(4, 1);

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert(
    report.errors.some((error) =>
      error.includes("must contain every UTC calendar day"),
    ),
  );
});

test("rejects a pilot window that starts before deployment or ends before it starts", () => {
  const evidence = validEvidence();
  evidence.pilot.deployed_at = `${utcDay(0)}T10:00:00.000Z`;
  evidence.pilot.pilot_ended_at = `${utcDay(0)}T08:30:00.000Z`;

  const report = verify(evidence);
  assert.equal(report.ok, false);
  assert(
    report.errors.some((error) =>
      error.includes("starts before the declared deployment"),
    ),
  );
  assert(report.errors.some((error) => error.includes("invalid pilot window")));
});

test("rejects future performance timestamps and future pilot days", () => {
  const evidence = validEvidence();
  const now = new Date(`${utcDay(8)}T23:59:59.000Z`);

  const report = verify(evidence, now);
  assert.equal(report.ok, false);
  assert(report.errors.some((error) => error.includes("future observed_at")));
  assert(report.errors.some((error) => error.includes("future pilot day")));
});
