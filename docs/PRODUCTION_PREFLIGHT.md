# Production Preflight

The production preflight is a fail-closed, read-only release check. It does not
deploy, migrate, repair, configure, schedule, restore, or delete anything in a
remote system. Run it only after the clean production project has been
provisioned and the approved release has been deployed.

This check complements, but does not replace, the educational quality gate or
the seven-day performance and pilot-exit gate in
[`quality/OPERATIONS_EVIDENCE.md`](../quality/OPERATIONS_EVIDENCE.md).

## What it checks

The verifier blocks launch when it cannot prove all of the following:

- the production database reports an integer `server_version_num` of at least
  `170000` (PostgreSQL 17), which is required before replaying the migration
  history;
- the local Supabase CLI link and the CLI's linked-project marker identify the
  one expected production project;
- a disposable reset-local database and linked production have the same
  strictly ordered migration version, name, statement count, and SHA-256 of
  each stored statement array;
- every required frontend and CI variable name exists;
- every required Edge Function secret name exists;
- all nine required Edge Functions are `ACTIVE` at their exact approved
  deployment version and use the exact checked-in `verify_jwt` mode;
- all three `pgmq` queues exist, all four reconciliation Cron jobs (including
  maximum-cost settlement of expired unknown AI usage) and the release Cron
  are active, and all three Realtime status tables are published;
- two exact EU QStash schedules (one every minute and one every minute with a
  30-second delivery delay) have current redacted list/GET readback evidence on
  an accepted paid plan, and the recovery endpoint has produced a heartbeat no
  older than 90 seconds; that heartbeat is recorded only after queue recovery,
  expired AI reservation settlement, and the independent scheduled-feedback
  release sweep all succeed;
- no validated scheduled feedback is more than 60 seconds overdue;
- `pg_net` is absent;
- PostgREST exposes exactly `api`, rejects `Accept-Profile: public`, and serves
  `api.get_recovery_health` with service authorization;
- Auth, database, REST, and Realtime platform services report
  `ACTIVE_HEALTHY`, and Realtime is not suspended;
- the production Supabase URL, Auth site URL, and complete redirect allow-list
  exactly match the approved release expectations, and the browser key is a
  project-accepted publishable/legacy `anon` key that is neither
  secret/service-role shaped nor equal to the configured service-role key;
- custom SMTP is complete and matches the approved non-secret settings,
  leaked-password protection is on, email confirmation is required, and
  unverified email sign-in is off;
- the hosted Auth readback reports a JWT expiry of exactly 600 seconds and TOTP
  enrollment plus verification both enabled, and a content-free database
  readback proves at least one live, confirmed, unbanned platform administrator
  has two verified TOTP factors with no administrator profile violating that
  recovery invariant;
- demo mode, public teacher signup, and Sentry Replay are off; public student
  signup is on; and the deployed
  launch manifest proves the release/project/flags plus successful source-map
  upload configuration;
- a recent completed backup exists in the approved EU region, an approved
  recovery policy and successful restore drill exist, and rollback artifacts
  have been verified recently through the attested production-artifact
  workflow and its content-free SHA-256 manifest;
- frontend and Edge monitoring are enabled with PII disabled, all text and
  inputs masked, media blocked, student writing/provider payload capture off,
  and every required alert exists as an enabled live Sentry workflow with an
  active action;
- a dated, release-bound minor-safe privacy review approves sending raw student
  writing to the external evaluator, the applicable DPA is approved, and both
  retention and deletion policies are approved;
- the Gemini secondary-provider project is on a paid tier, hard project and
  application monthly spend guards are enabled, a recent cost-telemetry canary
  passed, and projected total operating cost is no more than EUR 1 per active
  student-month;
- the 184 qualified human launch-bank revisions match production by exact
  authoring-matrix `template_key`, immutable revision ID, CEFR level, and
  content hash; automatically released generated
  worksheets are separately identified by deterministic plus independent-model
  validation; teacher-reviewed generated worksheets retain reviewer provenance;
  and every legacy revision is reusable, quarantined, retired, or historical-only.

## Read-only collection contracts

The collector uses current official Supabase contracts:

- [`supabase projects list`, `functions list`, and `secrets list`](https://supabase.com/docs/reference/cli/supabase-orgs-list)
  with `-o json`;
- the [Management API](https://supabase.com/docs/reference/api/getting-started)
  `GET` routes for Auth config, PostgREST config, service health, Realtime
  config, and backups;
- `POST /v1/projects/{ref}/database/query/read-only` with schema-qualified,
  read-only `SELECT` statements for the integer `server_version_num`,
  Cron/Realtime health, the count of validated scheduled feedback more than 60
  seconds overdue, the boolean platform-administrator MFA recovery-set gate,
  the linked
  `supabase_migrations.schema_migrations` history, and the content-free
  worksheet inventory. Migration statement arrays are hashed in transient
  collector memory and are never written to evidence, reports, logs, or
  artifacts. The worksheet inventory includes IDs, CEFR levels, hashes, state
  flags, validation/reviewer provenance booleans, and dispositions—never titles,
  prompts, answers, rubrics, student identities, or student work;
- the [Data API custom-schema contract](https://supabase.com/docs/guides/api/securing-your-api)
  for explicit `Accept-Profile`/`Content-Profile` probes and the service-role
  `api.get_recovery_health` RPC.

The Management API access token and service-role key are used only in process
memory and request headers. CLI stderr, raw response bodies, secret values, secret
digests, JWT secrets, provider configuration, and SMTP credentials are never
included in the evidence or report. The sanitized evidence contains only
variable/secret names, public URLs, the integer `server_version_num`, migration
versions/names/statement counts and SHA-256 digests, deployment versions,
statuses, JWT-verification-mode booleans, hosted JWT lifetime, TOTP capability
booleans, the platform-admin MFA-readiness boolean, and timestamps. Collected
evidence schema version 3 rejects older envelopes that do not prove these Auth
controls; it also retains the schema-v2 migration-statement fingerprints that
reject the old version-only migration format.

Before starting any CLI or network work, the collector validates that both the
expected and configured Sentry API bases are the same official Sentry SaaS
HTTPS origin. It also validates that `VITE_SENTRY_DSN` uses the matching
official ingestion region; the DSN public key is never copied into evidence or
an error. Every collector fetch rejects redirects, so authorization and API-key
headers cannot be forwarded by a redirect response.

## Release expectations

Set `PRODUCTION_PREFLIGHT_EXPECTATIONS_JSON` as a GitHub production-environment
variable or an equivalent protected runtime variable. Replace every placeholder
with the approved release value:

```json
{
  "schema_version": 1,
  "project_ref": "abcdefghijklmnopqrst",
  "staging_project_ref": "tsrqponmlkjihgfedcba",
  "organization_slug": "schreiben-production",
  "organization_plan": "pro",
  "project_created_after": "2026-07-01T00:00:00.000Z",
  "app_url": "https://app.example.de",
  "auth_redirect_urls": [
    "https://app.example.de/auth/confirm",
    "https://app.example.de/auth/reset-password"
  ],
  "region": "eu-central-1",
  "app_release": "git-commit-or-release-id",
  "sentry_api_base_url": "https://de.sentry.io",
  "monitoring_workflows": {
    "queue_age": { "id": "1001", "name": "Schreiben queue_age" },
    "job_retries": { "id": "1002", "name": "Schreiben job_retries" },
    "dead_letters": { "id": "1003", "name": "Schreiben dead_letters" },
    "provider_latency": { "id": "1004", "name": "Schreiben provider_latency" },
    "held_feedback": { "id": "1005", "name": "Schreiben held_feedback" },
    "worksheet_rejection": {
      "id": "1006",
      "name": "Schreiben worksheet_rejection"
    },
    "auth_failures": { "id": "1007", "name": "Schreiben auth_failures" },
    "frontend_errors": { "id": "1008", "name": "Schreiben frontend_errors" }
  },
  "smtp": {
    "admin_email": "noreply@example.de",
    "host": "smtp.example.de",
    "port": "587",
    "user": "smtp-account-id",
    "sender_name": "Schreiben"
  },
  "auth_rate_limits": {
    "rate_limit_email_sent": 30,
    "rate_limit_verify": 360,
    "rate_limit_token_refresh": 1800,
    "rate_limit_otp": 30
  },
  "edge_function_versions": {
    "prepare-writing-feedback": 1,
    "process-due-feedback": 1,
    "generate-practice-worksheet": 1,
    "evaluate-practice-attempt": 1,
    "kick-writing-jobs": 1,
    "process-writing-jobs": 1,
    "process-worksheet-generation-jobs": 1,
    "process-worksheet-answer-jobs": 1,
    "recover-async-jobs": 1
  }
}
```

Use the versions returned after the approved deployment by
`supabase functions list --project-ref <ref> -o json`. A missing version,
older version, newer unapproved version, non-`ACTIVE` status, non-EU region, or
non-HTTPS URL fails closed. The expected `verify_jwt` modes are deliberately
not supplied through mutable production variables: they are pinned for every
required function in
[`config/production-preflight.contract.json`](../config/production-preflight.contract.json).
The live function inventory must be exactly that approved set. Any additional
slug fails closed, including the staging-only `provider-transport-diagnostic`;
keep that diagnostic available in source and staging until the paid-provider
canaries finish, but never deploy it to production. The collector preserves the
CLI's boolean `verify_jwt` field, and a missing, non-boolean, or mismatched value
fails closed. This protects the
[per-function authentication configuration](https://supabase.com/docs/guides/functions/function-configuration)
from being changed by an out-of-band deploy flag without detection.
Set `SENTRY_API_BASE_URL` to the same regional origin (for an EU-hosted Sentry
organization, normally `https://de.sentry.io`). The protected
`SENTRY_AUTH_TOKEN` needs `alerts:read` or an equivalent organization-read
scope. Preflight reads the organization workflow inventory and requires every
declared workflow ID/name to be enabled with an active notification action;
the boolean operations attestation alone cannot satisfy this gate.
The Auth rate-limit values are release decisions, not universal defaults. Set
them to the exact approved production values after reviewing expected pilot
traffic; preflight reads the current Supabase Auth configuration and fails on
any drift. Keep the email-send limit compatible with the custom SMTP provider.
`staging_project_ref` must be the current staging project and must differ from
`project_ref`. Set `project_created_after` to the approved production
provisioning boundary. The collector reads the project and organization from
the Supabase Management API and requires the exact EU region, healthy project,
organization slug, paid plan, and a creation timestamp on or after that
boundary. This prevents a renamed staging/free project from satisfying the
launch identity gate; the separate clean-data smoke remains mandatory.

## Operations evidence

Set `PRODUCTION_OPERATIONS_EVIDENCE_JSON` as a protected GitHub
production-environment variable. This compact JSON is an attestation to the
restricted underlying tickets, provider screens, restore logs, Sentry settings,
and stored rollback artifacts. Keep those underlying artifacts in the approved
operations system; do not place secrets, student data, provider payloads, or raw
logs in this JSON.

```json
{
  "schema_version": 6,
  "project_ref": "abcdefghijklmnopqrst",
  "app_release": "git-commit-or-release-id",
  "backup_recovery": {
    "recovery_policy_approved": true,
    "pitr_decision": "not_required",
    "restore_drill_succeeded": true,
    "restore_drill_at": "2026-07-01T12:00:00.000Z",
    "evidence_id": "restore-ticket-opaque-id"
  },
  "external_scheduler": {
    "configured": true,
    "provider": "upstash_qstash",
    "region": "eu-central-1",
    "billing_plan": "pay_as_you_go",
    "schedule_ids": [
      "schreiben-v1-recovery-abcdefghijklmnopqrst-minute-00",
      "schreiben-v1-recovery-abcdefghijklmnopqrst-minute-30"
    ],
    "cron": "* * * * *",
    "delivery_delays_seconds": [0, 30],
    "effective_max_gap_seconds": 30,
    "method": "POST",
    "body_sha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    "timeout_seconds": 10,
    "retries": 2,
    "retry_delay_expression": "1000 * (1 + retried)",
    "destination_verified": true,
    "forwarded_header_name": "x-process-recovery-secret",
    "forwarded_header_redacted": true,
    "list_readback_verified": true,
    "individual_readback_verified": true,
    "provisioning_plan_applied": true,
    "contract_sha256": "ab5662265933439e8eea84964d0c39c2752bab962aa4b426ec753cfd521c6c25",
    "tested_at": "2026-07-10T11:30:00.000Z",
    "evidence_id": "scheduler-ticket-opaque-id"
  },
  "rollback": {
    "verified_at": "2026-07-10T10:00:00.000Z",
    "frontend_artifact_present": true,
    "edge_function_artifacts_present": true,
    "database_forward_fix_plan_present": true,
    "evidence_id": "rollback-ticket-opaque-id"
  },
  "monitoring": {
    "verified_at": "2026-07-10T10:00:00.000Z",
    "frontend_enabled": true,
    "edge_functions_enabled": true,
    "send_default_pii": false,
    "mask_all_text": true,
    "mask_all_inputs": true,
    "block_all_media": true,
    "student_writing_capture": false,
    "provider_payload_capture": false,
    "alerts": {
      "queue_age": true,
      "job_retries": true,
      "dead_letters": true,
      "provider_latency": true,
      "held_feedback": true,
      "worksheet_rejection": true,
      "auth_failures": true,
      "frontend_errors": true
    },
    "evidence_id": "monitoring-ticket-opaque-id"
  },
  "provider_redundancy": {
    "verified_at": "2026-07-10T11:45:00.000Z",
    "primary_auth_failover_decision": "enabled",
    "primary_auth_failover_canary_passed": true,
    "writing_primary_passed": true,
    "writing_fallback_passed": true,
    "worksheet_primary_passed": true,
    "worksheet_fallback_generator_passed": true,
    "worksheet_fallback_critic_passed": true,
    "worksheet_answer_primary_passed": true,
    "worksheet_answer_fallback_passed": true,
    "worksheet_answer_invalid_output_private": true,
    "worksheet_answer_primary_source": "deepseek",
    "worksheet_answer_fallback_source": "gemini",
    "worksheet_answer_primary_model": "deepseek-v4-flash",
    "worksheet_answer_fallback_model": "gemini-3.1-flash-lite",
    "invalid_output_held_private": true,
    "fallback_generator_model": "gemini-3.1-flash-lite",
    "fallback_critic_model": "gemini-3.1-flash-lite",
    "secondary_provider_paid_tier": true,
    "monthly_cost_guard_enabled": true,
    "per_student_cost_target_mode": "advisory_monitor_only",
    "emergency_stop_enabled": true,
    "cached_input_metering_canary_passed": true,
    "cost_telemetry_canary_passed": true,
    "global_monthly_hard_cap_microusd": 225000000,
    "default_workspace_monthly_cap_microusd": 100000000,
    "maximum_projected_cost_per_student_eur": 0.75,
    "advisory_operating_target_eur": 1,
    "advisory_reserve_basis_points": 1000,
    "stale_exchange_rate_fallback_microrate": 1500000,
    "exchange_rate_verified_at": "2026-07-10",
    "exchange_rate_source": "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A",
    "active_student_cohorts_tested": [20, 50, 250],
    "evidence_id": "provider-canary-ticket-opaque-id"
  },
  "student_data_governance": {
    "approved_at": "2026-07-08T09:00:00.000Z",
    "verified_at": "2026-07-10T10:00:00.000Z",
    "minor_safe_privacy_approved": true,
    "external_evaluator_dpa_approved": true,
    "raw_student_writing_transfer_approved": true,
    "retention_policy_approved": true,
    "deletion_policy_approved": true,
    "evidence_id": "student-data-governance-ticket-opaque-id"
  }
}
```

Set `pitr_decision` to `enabled` only when the Management API confirms PITR is
enabled; otherwise use `not_required` only after the approved recovery policy
documents that decision. The restore drill may be at most 90 days old.
Scheduler and provider-canary evidence may be at most 24 hours old. Provider
canaries must use synthetic, non-personal fixtures and retain only pass/fail,
latency, exact model identifiers, token/cost totals, the projected cost per
active student-month, and an opaque evidence ID; never place prompts, writing,
answers, or provider payloads in the operations JSON. The protected underlying
record must prove a billing-enabled Gemini project, an AI Studio hard monthly
project cap, application-level workspace/global monthly reservations and an
emergency stop, per-student cost attribution, and an advisory projection no
higher than EUR 1 per active student-month after bounded retry and fallback
traffic. `monthly_cost_guard_enabled` may be `true` only when the workspace and
global hard caps, reservation accounting, and emergency stop are active;
retries may not bypass spend reservations. Per-student and cohort targets are
monitoring signals only and must never deny an otherwise allowed student job.
Cost input must add provider-metered actual usage, active
reservations, and full-maximum `usage_estimated` settlements; estimates remain
budget-counted and must not be reported as metered tokens. The evidence must
also prove DeepSeek cache-hit and cache-miss tokens were invoiced at separate
snapshotted rates, with absent cache metadata conservatively treated as a full
cache miss. The USD-to-EUR observation must come from the exact ECB source
shown above, may not be future-dated, and may be at most seven UTC days old.
Release preflight still fails when that evidence is stale. At runtime only,
stale-but-otherwise-valid evidence uses the fixed `1500000` EUR-per-USD
microrate denominator for conservative reporting. Invalid or future exchange
rate evidence must raise an operations alert, but the advisory per-student
target does not participate in student job admission.
The 10% (`1000` basis-point) advisory reserve is bounded and auditable; the
EUR 1 operating target remains a projection gate for launch planning and
alerts. Cost projections must be verified at 20, 50, and 250 active students.
Only the workspace hard cap, global hard cap, or emergency stop may deny work
for cost-control reasons; per-student and cohort totals remain attributable and
visible for monitoring. The evidence must report the exact USD 225 global hard cap
(`225000000` microusd) and USD 100 default workspace cap (`100000000`
microusd). A larger-cohort workspace override is permitted only through the
audited budget-update path, with the global cap unchanged and a fresh cost
projection. Rollback and monitoring evidence may be at most seven days old.
Student-data governance approval must predate its verification, and that
release-bound verification may be at most seven days old. These booleans attest
to restricted underlying legal/privacy records; they are not legal conclusions
and must never be set without the documented human approvals.

Create scheduler evidence only through the secret-free contract and offline
readback verifier in
[`QSTASH_RECOVERY_SCHEDULER.md`](./QSTASH_RECOVERY_SCHEDULER.md). The Free plan
cannot pass: the two one-minute schedules require 2,880 baseline deliveries per
day before retries, above the 1,000-message daily Free allowance. The scheduler
evidence does not replace the separate live recovery-heartbeat check.
Rollback evidence must cover the previous frontend artifact, the approved Edge
Function versions/bundles, and the reviewed database forward-fix runbook backed
by a recoverable backup. Database migrations are never rolled back by deleting
production data.

## Coordinated worksheet-evidence rollout

The migration that introduces explicit worksheet `content_checks` is an
intentional DB/worker contract boundary. Deploy it only during a controlled
worksheet-generation quiet window:

1. Stop new worksheet-generation requests and pause every worksheet recovery
   consumer/Cron trigger. Writing evaluation and worksheet-answer evaluation
   may remain available.
2. Prove that no `worksheet_generation` job is `queued`, `processing`, or
   `retry`, and that no worksheet-generation queue message or active AI-spend
   reservation remains. Do not delete or rewrite a live job to manufacture this
   state; let it finish or recover it first.
3. Apply the reviewed database migrations. The content-evidence migration also
   locks the job/checkpoint write boundaries and fails with
   `worksheet_content_evidence_quiet_window_required` if the database is not
   quiet.
4. While new generation remains closed, deploy the matching
   `process-worksheet-generation-jobs` and `recover-async-jobs` bundles. Never
   reopen a version gap where an older worker can persist evidence against the
   newer database contract.
5. Run the focused content-evidence, cache, checkpoint, withdrawal, recovery,
   and authorization tests. Then run one synthetic generated worksheet through
   both critics and prove terminal status, immutable hashes, empty queues, and
   settled spend.
6. Re-enable immediate processing and recovery triggers, then reopen worksheet
   generation. Capture function versions, migration parity, test output, and
   the synthetic canary result in the release evidence.

A clean production project with no users or jobs naturally satisfies the first
two steps, but the same deployment order still applies. If any step fails, keep
generation closed and forward-fix; do not bypass the evidence validator or
delete student data.

## Required GitHub production environment

Configure these GitHub **variables**:

- `PRODUCTION_PORT`
- `PRODUCTION_BASE_PATH`
- `PRODUCTION_VITE_SUPABASE_URL`
- `PRODUCTION_VITE_ENABLE_DEMO_MODE=false`
- `PRODUCTION_VITE_ENABLE_PUBLIC_TEACHER_SIGNUP=false`
- `PRODUCTION_VITE_ENABLE_PUBLIC_STUDENT_SIGNUP`
- `PRODUCTION_VITE_SENTRY_DSN`
- `PRODUCTION_VITE_SENTRY_ENVIRONMENT=production`
- `PRODUCTION_VITE_APP_RELEASE`
- `PRODUCTION_VITE_SENTRY_ENABLE_REPLAY=false`
- `PRODUCTION_SENTRY_UPLOAD_SOURCE_MAPS=true`
- `PRODUCTION_PREFLIGHT_EXPECTATIONS_JSON`
- `PRODUCTION_OPERATIONS_EVIDENCE_JSON`
- `PRODUCTION_PROJECT_REF` (must equal the ref inside the expectations JSON)
- `SENTRY_API_BASE_URL` (the approved regional Sentry API origin)
- `SENTRY_ORG`
- `SENTRY_PROJECT`

Configure these GitHub **secrets**:

- `SUPABASE_ACCESS_TOKEN`
- `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY`
- `PRODUCTION_SUPABASE_DB_PASSWORD`
- `PRODUCTION_VITE_SUPABASE_ANON_KEY` (a Supabase publishable key or legacy
  `anon` JWT only; never a secret/service-role key)
- `SENTRY_AUTH_TOKEN`

The Supabase project must separately contain every custom Edge secret name in
[`config/production-preflight.contract.json`](../config/production-preflight.contract.json).
This includes `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, and the server-only
`GEMINI_ALLOW_PRIMARY_AUTH_FAILOVER` decision flag. No OpenAI secret is required
for V1. Production fails the redundancy gate unless the decision is explicitly
`enabled` or `disabled` in operations evidence and a fresh synthetic canary
proves that exact behavior. That flag and canary apply only to writing
evaluation. With `enabled`, a missing DeepSeek key or DeepSeek 401/403 may route
writing to `gemini-3.1-flash-lite`; with `disabled`, the same writing scenarios must
fail closed.

The separate worksheet canary must prove that missing/malformed DeepSeek
configuration and DeepSeek 401/403 never call Gemini generation, and instead
use only an eligible exact-context certified bank revision or remain privately
held. It must also prove that every generated candidate receives matching,
hash-bound approvals from DeepSeek Flash and `gemini-3.1-flash-lite`; a classified
transient generator fallback uses only `gemini-3.1-flash-lite`. Answer-scoring
evidence must separately prove that DeepSeek Flash and
`gemini-3.1-flash-lite` evaluated the same answers, agreement completed
automatically, disagreement invoked hash-bound Pro adjudication, an unresolved
result stayed private, and uniform or mixed per-question source/model evidence
persisted truthfully. Writing evidence must prove routine critique by
`gemini-3.1-flash-lite` and final post-adjudication critique by
`gemini-3.1-flash-lite`. A one-provider result must never become student-visible
regardless of the writing auth-failover flag. All model identifiers are stable,
code-pinned names; aliases, preview models, and mutable environment model names
fail closed.

Supabase-managed `SUPABASE_URL` and API keys are not copied into the report.

## Running it

Use the optional **Read-only production environment preflight** job under
GitHub Actions → Verify → Run workflow. Select only the production environment
whose protection rules and secrets belong to the target project. The job is
hard-blocked unless the dispatched ref is protected `refs/heads/main`; GitHub
then pins that run to the immutable commit SHA resolved for `main`.

Production credentials are never job-scoped. Checkout, action setup,
dependency installation, Supabase CLI installation, and the disposable local
reset run without production secrets. The production database password exists
only in the `supabase link` step; the Management token is limited to that link
and the two read-only collection steps; the service-role key, browser key, and
Sentry token exist only in the main preflight collector step. The local
database URL is stored briefly in an owner-only runner temporary file, exported
only inside that collector step, and removed before worksheet collection or
artifact upload. The ephemeral `supabase/.temp` link metadata is removed at the
same boundary so later repository scripts and actions cannot inherit cached
connection material.

Because `supabase/.temp` is intentionally not committed, the workflow first
runs `supabase start` and `supabase db reset --local --no-seed` against a
disposable runner-local database. It obtains that loopback connection from
`supabase status`, invokes `psql` without printing its captured output, and
fingerprints the migration rows created by the complete reset. The workflow
then runs `supabase link` with the protected declared project ref. The CLI reads
the production database password from step-local `SUPABASE_DB_PASSWORD`, so the
value never appears in a command argument or in the preflight evidence
environment contract. Linking writes only ephemeral local CLI
state on the GitHub runner; it does not configure or mutate production. The
collector checks the link, reads production history only through the Management
API read-only query route, and compares the two ordered content-free
fingerprint lists. No reset, repair, migration, or direct `psql` connection is
ever run against production.

For an authorized local run, load the same production values from a secret
manager without putting them on the command line. Create and reset a disposable
local Supabase stack, bind the collector only to its loopback database, confirm
`supabase/.temp/project-ref` is the clean production ref, then run:

```sh
supabase start
trap 'supabase stop --no-backup' EXIT
supabase db reset --local --no-seed
psql --version
LOCAL_SUPABASE_DB_URL="$(supabase status -o env | sed -n 's/^DB_URL=//p' | head -n 1)"
LOCAL_SUPABASE_DB_URL="${LOCAL_SUPABASE_DB_URL%\"}"
LOCAL_SUPABASE_DB_URL="${LOCAL_SUPABASE_DB_URL#\"}"
export LOCAL_SUPABASE_DB_URL

pnpm production:preflight -- \
  --evidence-output /restricted/production-preflight-evidence.json \
  --report-output /restricted/production-preflight-report.json
```

The collector rejects non-loopback local database URLs. Its fixed `psql` query
reads only `version`, `name`, and the stored `statements` array from
`supabase_migrations.schema_migrations`; output evidence retains only version,
name, statement count, and a lowercase SHA-256 digest of the UTF-8 JSON array
with statement order preserved. A same-version edit, rename, missing/null
statement array, duplicate, missing/extra row, or ordering change fails closed.

The two output files are sanitized and written with owner-only permissions.
Existing output files are tightened to owner-only before replacement content is
written. They are still operational release records and should be retained
according to the project's evidence policy.

Collect and reconcile the worksheet inventory for the same release/project:

```sh
pnpm worksheet-inventory:collect -- \
  --release <exact-release-id> \
  --project-ref <production-project-ref> \
  --output /restricted/production-worksheet-inventory.json

pnpm worksheet-inventory:verify -- \
  --release <exact-release-id> \
  --project-ref <production-project-ref> \
  --approvals quality/worksheet-bank/approved-revisions.jsonl \
  --inventory /restricted/production-worksheet-inventory.json \
  --report-output /restricted/production-worksheet-inventory-report.json
```

The collector labels this schema-v4 evidence with
`hash_origin: "db_recomputed_v1"`. Its existing content-free public worksheet
`rows` inventory remains compatible, and an additive `canonical_bank` array
records only canonical IDs, exact `template_key`, CEFR/topic context,
timestamps, qualification flags, immutability controls, and database-computed
hashes. A separate additive `model_validated_cache` array records only cache
revision IDs, CEFR/topic/difficulty context, provider and critic identifiers,
validation flags, source IDs, hashes, promotion time, withdrawal state, current
eligibility, and immutability controls. It never emits worksheet text,
questions, answers, validation payloads, reviewer qualifications, or student
data. The verifier rejects missing canonical or cache evidence, missing or
different hash origins, and older evidence schemas that do not bind both
template identities and model-cache provenance.

The gate requires exactly 184 `released` canonical bank revisions and exactly
46 for each of A1, A2, B1, and B2. Every `approved-revisions.jsonl` row must name
the exact canonical revision UUID, authoring-matrix `template_key`, CEFR level,
explicit grammar-topic slug, and content hash. All 184 template keys must appear
exactly once, covering all 36 foundation topics and the 10 planned second
revisions at each level. The database evidence must independently prove a complete approved
checklist, currently qualified certifier and releaser records, an immutable
review/release chain, chronological review then release, and equality of the
stored revision, recomputed content, review, and release hashes. Missing, extra,
superseded-only, mismatched, expired, or structurally mutable evidence fails the
preflight. The report lists the distinct topic slugs represented at each level,
and the gate requires all 36 distinct topics within each level's 46 revisions.

Reviewer qualification expiry is time-driven; no row update occurs when the
clock passes `expires_at`. Run the worksheet inventory at least daily during
pilot and before every release, and route any `reviewer_qualified: false` or
`releaser_qualified: false` result as a launch-blocking alert. In addition, run
this content-free read-only renewal-window query weekly and alert at 30 days
(urgent at 7 days) so qualifications are renewed before selectors fail closed:

```sql
select
  reviewer.user_id,
  reviewer.can_certify,
  reviewer.can_release,
  reviewer.expires_at,
  greatest(
    floor(extract(epoch from (reviewer.expires_at - now())) / 86400),
    0
  )::integer as whole_days_remaining
from app_private.practice_worksheet_bank_reviewers reviewer
where reviewer.active
  and reviewer.expires_at is not null
  and reviewer.expires_at <= now() + interval '30 days'
order by reviewer.expires_at, reviewer.user_id;
```

The query changes no data and contains no worksheet or student content. Renewal
must preserve a currently qualified exact-topic/CEFR alternative throughout;
never disable the database coverage guard to silence an expiry alert.

This does not require teachers to approve every generated worksheet. A generated
workspace revision is reusable automatically when its deterministic checks and
independent model critique both pass. A separately stored `mcq_safe_v1` cache
revision is reusable only while its immutable source/completion evidence,
DeepSeek and Gemini critic evidence, database-recomputed content hash, question
contract, and non-withdrawn state remain current. Workspace copies retain the
original model provider and `independent_model_validation` provenance; they are
never labeled teacher-reviewed or certified-bank content. The report counts
`model_validated_cache_*` and `certified_clone_total` separately, and neither
model-generated revisions nor cache copies can inflate or replace the 184
canonical qualified-human revisions or their exact template-key coverage.
Failed, stale, withdrawn, or uncertain model material remains unavailable for
new student delivery.

The pure evaluator can be rerun without network access:

```sh
pnpm production:preflight:verify -- \
  --contract config/production-preflight.contract.json \
  --expectations /restricted/production-expectations.json \
  --evidence /restricted/production-preflight-evidence.json \
  --operations /restricted/production-operations-evidence.json \
  --report-output /restricted/production-preflight-report.json
```

The current staging project, missing production project, missing deployment,
missing heartbeat, missing evidence, or missing GitHub variable is expected to
fail. Do not weaken a gate to turn that failure green; supply or repair the
underlying production evidence.
