# V1 performance and pilot-exit evidence

The release gate accepts two deliberately content-free evidence files:

- `quality/operations/performance-samples.jsonl`: one timing observation per line.
- `quality/operations/pilot-days.json`: daily aggregate operational counters.

## Current staging verification snapshot (not release evidence)

The 2026-07-14 current-tree staging verification is useful regression evidence,
but it is not production performance or pilot evidence and must not be copied
into either release-evidence file as though it were collected during the pilot:

- Staging includes migration
  `20260713231137_settle_terminal_ai_spend_reservations.sql`, and
  `process-worksheet-generation-jobs` is deployed as version 60.
- The fail-closed high-risk linked database gate passes 30 files and 854
  assertions with zero active AI work or fixture residue. The repository-wide
  clean reset/replay remains pending.
- Three consecutive real provider-backed worksheet browser journeys pass in
  56.7, 57.7, and 51.9 seconds. Each run reaches visible ready material and
  proves revision-safe autosave/reload, submission, scoring, and exact cleanup.
- The live writing journey passes in 21.8 seconds. The teacher-review and
  scheduled-feedback workflow passes in 7.1 minutes, including private draft
  editing, explicit release, scheduled privacy/release, history, and
  offboarding.
- Current local gates pass frontend 562/562, scripts 609/609, and Edge 539/539;
  full typecheck, the explicit-environment production build, and the production
  dependency audit are green.
- A content-free deep security scan is sealed to frozen-tree digest
  `415503ea781a9d7b80946eaa042e2ff7cb36c521169f7f0c8867531fe48d24bc`.
  Three rounds of six workers covered the same 828 ordered paths for 14,904
  receipts; round three produced zero novel clusters. All 34 sealed artifact
  hashes verified. The nine canonical candidates resolved to zero reportable
  findings: five rejected surfaces, three hosted-ingress follow-ups, and one
  no-issue surface. The redacted durable record is
  `quality/evidence/security/2026-07-14-deep-security-scan-attestation.json`.
- Post-scan prevention is verified separately from that sealed snapshot:
  root `/.playwright-cli/` artifacts are ignored while existing copies remain
  untouched, the artifact regression is green within scripts 609/609, and the
  local fail-closed browser mutation guard passes its focused 51/51 checks and
  the full frontend 562/562 suite. Bounded 4 KiB JSON materialization is wired
  into writing retry, worksheet generation, and practice evaluation, with the
  full Edge suite at 539/539. Supabase relay admission and resource behavior
  remains a hosted-platform follow-up rather than a locally proven property.
- Netlify staging deploy `6a557efa3b78a53aa03e0ec2` is the exact current
  frontend artifact: its hashed assets and fail-closed launch manifest match
  the verified local build. Fresh hosted authenticated checks reach every
  teacher operating area and the student's Home, Write, Practice, and History
  routes without a fatal browser or HTTP 5xx failure.

The worksheet reliability correction preserves fail-closed educational
validation: internally contradictory, wrong-key, reasonless, or question-
unscoped critic verdicts retry the same candidate instead of becoming false
educational rejection evidence. A returned valid rejection tries the exact
certified bank and then a current validated model-cache revision before
quarantine. Terminal jobs conservatively finalize any remaining reserved spend
instead of silently releasing or undercounting unknown dispatched usage. The
worksheet-live cleanup harness now bridges only an exact owned synthetic private
quarantine, archives content-free spend before unbinding it, and refuses scope,
identity, snapshot, active-job, or nonterminal-spend drift.

This snapshot does **not** complete qualified German review of the evaluator or
worksheet bank, canonical bank publication, clean production deployment,
production p95/load evidence, a usable CodeRabbit review, complete current RLS
and database-advisor evidence, or the pilot. The CodeRabbit attempt timed out;
no result is being inferred from it. Those gates remain mandatory below.

Run the fail-closed verifier with:

```sh
pnpm release:verify -- \
  --release "$PRODUCTION_VITE_APP_RELEASE" \
  --project-ref "$PRODUCTION_PROJECT_REF" \
  --performance quality/operations/performance-samples.jsonl \
  --pilot quality/operations/pilot-days.json
```

The files are release evidence and are not replaced by generated passing fixtures. Missing files,
malformed rows, unsupported fields, duplicate event IDs, insufficient samples, or a failed gate
produce a non-zero exit code. `--release` and `--project-ref` are mandatory exact expectations,
not labels inferred from either evidence file.

## Release, project, deployment, and pilot-window binding

Performance evidence uses schema version 2 and pilot evidence uses schema version 3. Every
performance row carries the exact application release, 20-letter production Supabase project ref,
deployment timestamp, pilot ID, and pilot start/end timestamps. The pilot envelope carries the
same provenance. The verifier rejects a row or envelope from any other release or project, and it
rejects a row whose pilot ID, deployment timestamp, or pilot window differs from the supplied pilot
envelope.

All timestamps are strict UTC timestamps ending in `Z`. The deployment must not follow pilot start,
pilot start must not follow pilot end, and neither evidence nor qualified-review timestamps may be
in the future. Timing observations and synthetic virtual-user starts must occur after deployment and
inside the declared pilot window. Pilot days must start and end on the window's UTC dates and must
include every intervening UTC calendar day exactly once in chronological order; weekend/non-school
days remain present with `school_day: false`. A future pilot day is invalid.

The newest performance observation may be no more than 36 hours old at verification time. This
keeps an otherwise valid old performance file from being relabeled or replayed for a later launch.
Run the operational gate promptly after closing the current pilot window; do not edit timestamps to
make stale evidence appear current.

## Authorized 20-concurrent writing load run

The repository includes a production load generator, but it is deliberately validation-only by
default. It never uses a service-role key, never accepts student writing, and never invents actors.
An execution requires an external credential-bearing scenario with 20–50 distinct authenticated
test users and dedicated authorized class/task resources.

The scenario must:

- be an absolute path outside this Git repository and have owner-only permissions (`0600`);
- target the attested `https://<project-ref>.supabase.co` production root with an anon/publishable
  browser key, never a secret or service-role key;
- contain an authorization window of no more than two hours and a release-owner attestation ID;
- set `isolated_test_data` and every actor's `authorized_for_load_test` flag to `true` only after the
  accounts, immediate-feedback class, and source tasks have been reserved for this probe;
- contain 20–50 unique content-free IDs from `virtual-user-01` through `virtual-user-50`,
  access-token JWTs, and authenticated JWT subjects;
- give every actor its authorized `batch_id`, `source_type`, and `source_id`; and
- omit names, emails, passwords, student writing, feedback, and all other application data.

Abbreviated shape (the real `actors` array must contain at least 20 complete objects):

```json
{
  "schema_version": 1,
  "environment": "production",
  "purpose": "isolated-production-writing-load-test",
  "isolated_test_data": true,
  "project_ref": "abcdefghijklmnopqrst",
  "supabase_url": "https://abcdefghijklmnopqrst.supabase.co",
  "anon_key": "<project publishable key>",
  "load_attestation_id": "authorized-load-window-opaque-id",
  "authorized_from": "2026-07-10T11:55:00.000Z",
  "authorized_until": "2026-07-10T12:30:00.000Z",
  "actors": [
    {
      "virtual_user_id": "virtual-user-01",
      "access_token": "<fresh access-token JWT for isolated test actor 01>",
      "batch_id": "<authorized immediate-feedback test class UUID>",
      "source_type": "workspace_question",
      "source_id": "<authorized synthetic task UUID>",
      "authorized_for_load_test": true
    }
  ]
}
```

First validate locally. This reads the scenario but performs zero network requests and creates zero
submissions:

```sh
chmod 600 /secure/outside-repository/schreiben-load-scenario.json
pnpm load:writing:production -- \
  --scenario /secure/outside-repository/schreiben-load-scenario.json
```

After the release owner confirms the production window and all 20+ resources are disposable test
data, execute once. The confirmation value must exactly equal the scenario's attestation ID, and
the output path must not already exist:

```sh
SCHREIBEN_PRODUCTION_LOAD_CONFIRM=authorized-load-window-opaque-id \
pnpm load:writing:production -- \
  --scenario /secure/outside-repository/schreiben-load-scenario.json \
  --execute \
  --output /secure/outside-repository/writing-load-evidence.jsonl
```

Execution authenticates all actors before its write barrier, submits the same built-in synthetic
German probe through `api.submit_writing`, invokes the normal `process-writing-jobs` immediate kick,
and polls the actor-authorized `api.get_submission_detail` read model. It fails closed if an actor is
not distinct or authorized, a submission cannot be read back, a job fails, a class is not in
immediate mode, a job exceeds the recovery threshold, the run is not synchronized, or the UTC day
changes. No evidence file is written unless every virtual user reaches a valid terminal state.

Review the resulting 60+ content-free rows, then incorporate them into the restricted operational
evidence preparation process. These three writing metrics prove the concurrent-submission portion;
they do not replace the dashboard, list, scheduled-release, or worksheet samples required for a
green day. The restricted preparation process must add the release, project, deployment, and pilot
provenance from the release owner's protected deployment record; the raw load-generator output is
schema-version-1 input and is not independently sufficient release evidence. Delete/revoke the
external scenario and its access
tokens after the run. Do not commit the scenario or upload it as a CI artifact. Production load
execution is intentionally not a GitHub Actions job. An interrupted process can leave an empty
reserved output file; it is not evidence and must be investigated and removed before any authorized
retry.

## Timing evidence schema

Each JSONL row contains only timing and run metadata:

```json
{
  "schema_version": 2,
  "app_release": "release-2026-07-10",
  "project_ref": "abcdefghijklmnopqrst",
  "deployed_at": "2026-07-01T08:00:00.000Z",
  "pilot_id": "opaque-pilot-id",
  "pilot_started_at": "2026-07-01T09:00:00.000Z",
  "pilot_ended_at": "2026-07-10T18:00:00.000Z",
  "event_id": "opaque-random-id",
  "observed_at": "2026-07-10T12:00:00.000Z",
  "reporting_day": "2026-07-10",
  "environment": "production",
  "source": "synthetic",
  "run_id": "opaque-load-run-id",
  "metric": "submission_acknowledgement_ms",
  "duration_ms": 640,
  "concurrent_users": 20,
  "virtual_user_id": "virtual-user-01",
  "virtual_user_started_at": "2026-07-10T11:59:59.000Z",
  "load_attestation_id": "authorized-load-window-opaque-id",
  "load_generator_version": "schreiben-load-v1"
}
```

Allowed `metric` values and enforced limits are:

| Metric                            |        Statistic |           Gate |
| --------------------------------- | ---------------: | -------------: |
| `dashboard_request_ms`            | nearest-rank p95 |   `< 2,000 ms` |
| `list_request_ms`                 | nearest-rank p95 |   `< 2,000 ms` |
| `submission_acknowledgement_ms`   | nearest-rank p95 |   `< 1,000 ms` |
| `immediate_job_start_ms`          | nearest-rank p95 |   `< 5,000 ms` |
| `feedback_completion_ms`          | nearest-rank p95 |  `< 60,000 ms` |
| `scheduled_release_lag_ms`        |          maximum | `<= 60,000 ms` |
| `reused_worksheet_ms`             |          maximum |   `< 2,000 ms` |
| `generated_worksheet_progress_ms` | nearest-rank p95 |   `< 1,000 ms` |
| `generated_worksheet_ms`          | nearest-rank p95 |  `< 90,000 ms` |

Every metric needs at least 20 valid samples on every candidate green UTC day. A
`feedback_completion_ms` row must additionally contain `input_chars` from 1 through 1,500; other
metrics must not contain that field. At least one synthetic `run_id` must contain 20 or more samples
for acknowledgement, job start, and feedback completion, all marked with
`concurrent_users >= 20`. This proves the required 20-concurrent-submission load run.
For worksheet generation, `generated_worksheet_progress_ms` measures from the
student action to the first visible queued/generating progress state; it is
separate from total generation completion.

## Pilot aggregate schema

The JSON document contains a production pilot identifier and daily counters. The abbreviated shape
below shows one day for readability; a real file must include every UTC date in the declared window:

```json
{
  "schema_version": 3,
  "app_release": "release-2026-07-10",
  "project_ref": "abcdefghijklmnopqrst",
  "deployed_at": "2026-07-01T08:00:00.000Z",
  "pilot_id": "opaque-pilot-id",
  "pilot_started_at": "2026-07-01T09:00:00.000Z",
  "pilot_ended_at": "2026-07-10T18:00:00.000Z",
  "environment": "production",
  "teacher_count": 4,
  "student_count": 32,
  "school_days_completed": 10,
  "qualified_german_signoff": {
    "evaluator_corpus_approved": true,
    "worksheet_bank_approved": true,
    "reviewer_id": "qualified-reviewer-opaque-id",
    "verified_at": "2026-07-10T10:00:00.000Z"
  },
  "days": [
    {
      "date": "2026-07-10",
      "school_day": true,
      "jobs_total": 200,
      "jobs_valid_terminal_without_database_intervention": 200,
      "frontend_sessions_total": 200,
      "frontend_error_free_sessions": 200,
      "stuck_jobs_beyond_recovery_threshold": 0,
      "unresolved_p0_findings": 0,
      "unresolved_p1_findings": 0,
      "unauthorized_access_incidents": 0,
      "cross_workspace_leakage_incidents": 0,
      "other_security_leakage_incidents": 0,
      "lost_submissions": 0,
      "lost_worksheet_answers": 0,
      "exposed_private_feedback_incidents": 0,
      "feedback_results_reviewed": 100,
      "feedback_results_corrected": 0,
      "worksheet_scores_reviewed": 100,
      "worksheet_score_overrides": 0,
      "worksheet_score_overrides_systemically_reviewed": 0,
      "unresolved_critical_accessibility_findings": 0,
      "unresolved_high_accessibility_findings": 0
    }
  ]
}
```

A green day requires at least 20 jobs and 20 frontend sessions, at least 99.5% valid terminal jobs
without database intervention, at least 99.5% frontend error-free sessions, zero stuck jobs beyond
the recovery threshold, zero unresolved P0/P1 findings, and zero access, leakage, lost-work, or
private-feedback incidents. The aggregate rates across the supplied pilot must also be at least
99.5%. Any stuck job, unauthorized access, security leakage, lost submission, lost worksheet answer,
or private-feedback exposure anywhere in the supplied pilot is fatal. Pilot exit requires the most
recent seven supplied days to be green and consecutive by UTC calendar date.

## Collecting evidence without student content

1. Use isolated production smoke accounts and a dedicated test class. The load run uses a fixed,
   clearly synthetic German text of no more than 1,500 characters and synthetic worksheets; it never
   replays a student's writing or answers.
2. Capture browser durations with monotonic timers and backend lifecycle durations from queue/status
   timestamps. Export only the metric name, millisecond duration, UTC day, source, concurrency, and
   freshly generated opaque event/run IDs. IDs must not be user IDs, submission IDs, emails, class
   codes, or reversible hashes of them.
3. Exercise scheduled release, cached worksheet reuse, and new worksheet generation with synthetic
   records. Synthetic probes may provide the daily minimum where organic pilot traffic is too small.
4. Produce pilot counters through a privileged aggregate-only operational query or monitoring
   export. The export must return counts, never matching rows. Determine valid terminal jobs from
   terminal states and the absence of a database-intervention marker.
5. Derive frontend error-free sessions from monitoring configured with text/input masking. Export
   only total-session and error-free-session counts. Do not export URLs containing identifiers,
   breadcrumbs with entered text, stack payloads containing provider responses, or replay data.
6. Have the release owner reconcile incident counters against the security log and P0/P1 tracker,
   then run the verifier. Keep the raw restricted monitoring exports outside the repository; only
   this aggregate, content-free evidence belongs in the release evidence location.

The schemas reject extra fields. In particular, never add names, emails, Auth IDs, batch codes,
student text, worksheet answers, feedback content, prompts, provider payloads, raw error messages,
or session-replay data.

The optional **Operational performance and pilot exit gate** workflow-dispatch job runs the same
command. It is intentionally opt-in because the real seven-day evidence does not exist before the
pilot and must never be fabricated to make CI green. The job uses the protected
`production` environment and passes its protected `PRODUCTION_VITE_APP_RELEASE` and
`PRODUCTION_PROJECT_REF` values as exact verifier expectations, so repository evidence validation
does not bypass the release-owner approval boundary.

This operational gate does not replace the production student-data governance
gate. Before raw student writing is sent to the external evaluator, the
production preflight separately requires a dated, release-bound, content-free
attestation for minor-safe privacy review, DPA approval, transfer approval, and
retention/deletion policy approval. See
[`docs/PRODUCTION_PREFLIGHT.md`](../docs/PRODUCTION_PREFLIGHT.md). Do not
fabricate approval flags or place underlying legal records or student content in
either evidence file.
