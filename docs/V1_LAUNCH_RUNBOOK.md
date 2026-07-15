# V1 Launch Runbook

This runbook is for launch hardening and incident response. Do not store secrets in this file.

## Environment Variables

Frontend, browser-safe:

- `PORT` defaults to `5173`; set it explicitly in deployment environments
- `BASE_PATH` defaults to `/`; use an absolute path when deploying below a subpath
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` (Supabase publishable key or legacy `anon` JWT;
  production preflight rejects secret/service-role keys and equality with
  `SUPABASE_SERVICE_ROLE_KEY`)
- `VITE_ENABLE_DEMO_MODE=false` as a retired-flag production guard; the V1
  frontend contains no demo login or role shortcut even if this legacy flag is set
- `VITE_ENABLE_PUBLIC_TEACHER_SIGNUP=false` unless public teacher signup is intentionally open
- `VITE_ENABLE_PUBLIC_STUDENT_SIGNUP=true` (required for V1 student onboarding)
- `VITE_SENTRY_DSN`
- `VITE_SENTRY_ENVIRONMENT`
- `VITE_APP_RELEASE`
- `VITE_SENTRY_ENABLE_REPLAY=false` by default

Server/CI only:

- `SUPABASE_SERVICE_ROLE_KEY`
- `DEEPSEEK_API_KEY`
- `GEMINI_API_KEY` (required in production for the native secondary-provider path)
- `GEMINI_ALLOW_PRIMARY_AUTH_FAILOVER=false` by default; this writing-only,
  server-side circuit breaker may be enabled only after an operator decision
  and Gemini paid-tier spend controls are documented and canary-tested
- `PROCESS_FEEDBACK_SECRET`
- `PROCESS_WRITING_JOBS_SECRET`
- `PROCESS_WORKSHEET_JOBS_SECRET`
- `PROCESS_WORKSHEET_ANSWER_JOBS_SECRET`
- `PROCESS_RECOVERY_SECRET` (forwarded only by the two external recovery
  schedules)
- `SENTRY_AUTH_TOKEN`
- `SENTRY_ORG`
- `SENTRY_PROJECT`

Never expose service-role keys, provider keys, auth tokens, prompts, student answers, or feedback payloads through Vite.

Production queue recovery does not use `pg_net`. Configure the exact two
EU QStash schedules in
[`QSTASH_RECOVERY_SCHEDULER.md`](./QSTASH_RECOVERY_SCHEDULER.md): both trigger
every minute and the second uses a 30-second delivery delay. Each posts exact
`{}` to `/functions/v1/recover-async-jobs` and forwards the redacted
`x-process-recovery-secret`; no student data is present. The Free QStash plan is
not launch-capable because this design needs 2,880 baseline deliveries per day.
The deployment preflight must verify both deterministic schedule IDs through
redacted list and individual GET readback, an accepted paid plan, and a fresh
live recovery heartbeat. The database Cron jobs reconcile expired leases,
terminalize expired unknown-usage AI reservations at their full reserved
maximum, and release scheduled feedback. The external recovery endpoint
independently runs the same bounded spend and scheduled-release sweeps; it
records a heartbeat only when queue recovery, spend reconciliation, and the
release sweep all succeed. Preflight must also report
zero validated scheduled releases older than the 60-second release gate.
The first four secret-free database Cron jobs are installed by migration
`20260710191319_install_queue_recovery_cron.sql`; Phase 12V adds the fifth,
`reconcile-ai-spend-reservations-every-30-seconds`. Do not run a separate setup
script on a clean project. Preflight verifies each job's exact private SQL
command, cadence, target database, and execution role rather than trusting its
name alone.

Worksheet generation uses a dual-provider gate. DeepSeek Pro generates;
deterministic code validates; then DeepSeek Flash and the stable Gemini model
`gemini-3.1-flash-lite` independently critique the same hash-bound candidate in
parallel. Both critics must approve every quality check. The durable workflow is
split into five content-free resumable stages: `primary_generation`,
`primary_fallback_generation`, `primary_critique`, `repair_generation`, and
`repair_critique`. A successful
generation stage persists its exact private candidate and integrity binding
before critique begins. A first educational rejection checkpoints the complete
critic evidence and queues `repair_generation`; it does not squeeze a second
generation and critic pass into the first execution's deadline. The repair uses
the independent strong provider, then `repair_critique` applies the full gate.
A second rejection remains private and enters review; it is never attached to
the student.

A transient DeepSeek timeout or availability failure, or a classified
malformed, oversized, or deterministically invalid primary response, does not
consume Gemini's budget in the same execution. It atomically archives the
ID-only queue message, queues `primary_fallback_generation`, and gives Gemini a
fresh bounded generation and dual-critic pass. Provider authentication,
configuration, model-role, redirect, and non-retryable HTTP failures remain
fail-closed. Neither provider transport failure nor an invalid pre-critic
candidate is recorded as a semantic candidate rejection.

A worker retry or expired lease resumes the first unfinished stage. It verifies
the persisted integrity binding before use, and a completed checkpointed
generation stage is not repeated. The two parallel critic calls are one atomic
quality stage: if that stage does not finish, both critics run again against the
same persisted candidate so partial evidence can never authorize release. A
classified transient DeepSeek generator failure may use
`gemini-3.1-flash-lite`, but the Gemini-generated candidate still requires
independent DeepSeek Flash approval. DeepSeek Flash and the Gemini critic share
the 20-second window after the paid full-pipeline canary proved the former
12-second Gemini ceiling too short; both critics remain mandatory even when one
shares the generator family, and both verdicts are mandatory. The per-stage caps are not additive at
runtime: spend-reservation RPC
time consumes the same budget, and critic transport windows are computed only
after both reservations settle. One shared five-second accounting settlement
window is reserved inside the same 85-second budget for the parallel critic
pass; it is the maximum parallel settlement, not an additive allowance per
critic. A post-settlement deadline check means late finalized critic output is
retried and cannot be accepted, and already billed calls are never falsely
released. Later generation or critic work is dynamically clipped around its
mandatory critic reserve. Each provider-stage execution
shares one 85-second ceiling across the generation and mandatory critic work in
that worker execution. Separately queued Gemini generation stages receive a
55-second ceiling, dynamically clipped when less time remains for their
mandatory critic pass; the legacy inline fallback remains capped at 25 seconds.
A critique-only resume or separately queued repair gets a fresh bounded
execution budget. The hard provider deadline remains 85 seconds
for each worker execution, below the 90-second product target. Queue progress
remains visible while a separately queued repair completes, and the durable
lease prevents recovery from claiming active work prematurely.

Ordinary transport delivery remains capped at three claims. The exact first
queue message created for `primary_fallback_generation` and the exact first
queue message created for `repair_generation` each receive one mandatory fresh
claim even when the ordinary cap has already been reached. Those exceptions are
bound to the persisted stage and message ID: a generic retry, replacement
message, or expired processing lease cannot reuse them. Attempt history stays
monotonic and has a hard ceiling of five across the full worksheet job. A
committed stage continuation triggers an immediate bounded worker wakeup;
sub-minute recovery remains the fallback rather than the normal start path.

The staging-only `provider-transport-diagnostic` `worksheet_full` mode emits an
ordered content-free stage trace. Each entry is restricted to `stage`, optional
`generation_source`, `elapsed_ms`, and `safe_error_code`; it never emits prompts,
candidate content, questions, answers, hashes, model names, provider response
bodies, or rejection text. The diagnostic is excluded from every production
artifact and does not replace the real queued resume/recovery test.

Before freezing the staging release candidate, run the same diagnostic with
exactly `{"only":"writing_full"}` through the protected secret runner. This
staging-only mode rejects additional request fields and uses only its fixed
synthetic A2 text. It exercises the real DeepSeek Flash/Pro and Gemini writing
path without database, student, queue, quota, or spend-accounting writes. Its
gateway request uses the staging publishable key in `apikey` and the dedicated
`PROVIDER_DIAGNOSTIC_SECRET` in `x-diagnostic-key`; neither value may be logged
or retained. Its
content-free response contains only `accepted`, bounded `safe_code`, total
elapsed time, stage/provider provenance, and
`article_form_regression_passed`. The ordinary path is two provider calls and
the disagreement path is bounded to four within the existing 85-second
deadline. Require both booleans to be true, retain only that content-free
evidence, and never retain provider content. The diagnostic remains excluded
from every production artifact and does not replace a real queued staging
canary.
Spend reserve, finalize, and release RPCs abort after five seconds. A timed-out
reserve never authorizes provider dispatch, and its uncertain reservation remains
for reconciliation rather than being guessed safe or released optimistically.

All three AI workflows use DeepSeek as primary and Gemini through its native,
non-streaming `generateContent` adapter as the independent secondary family.
V1 model roles are code constants:

- `deepseek-v4-flash` performs first-pass writing, worksheet critique, and one
  side of semantic answer evaluation;
- `deepseek-v4-pro` performs writing repair, worksheet generation, and
  hash-bound answer disagreement adjudication;
- `gemini-3.1-flash-lite` is the low-cost semantic-answer evaluator, routine
  writing and generated-worksheet critic, strong recovery generator, and fresh
  final writing critic.

No OpenAI key, endpoint, compatibility layer, or model is required for V1.
Semantic worksheet-answer evaluation runs DeepSeek Flash and
`gemini-3.1-flash-lite` independently in parallel. It requires both validated
results; agreement auto-completes, disagreement uses DeepSeek Pro, and
one-provider-only output never releases a score. Its 35-second DeepSeek and
20-second Gemini caps share a 55-second provider deadline. The atomic completion
contract persists truthful per-question `evaluator_source` and exact model
provenance; invalid or uncertain output never creates a visible review.
Model-name environment variables are not a deployment interface. Aliases,
preview models, experimental models, and environment-selected model names fail
closed. A model or provider change requires a reviewed code release, evaluator
and worksheet gold sets to be rerun, and updated release evidence. Do not use an
environment-only URL override or the Gemini OpenAI-compatibility endpoint to
change providers in production. See
[`GEMINI_SECONDARY_PROVIDER.md`](./GEMINI_SECONDARY_PROVIDER.md) for the native
adapter and safety contract.
Historical `gemini-2.5-flash` and `gemini-3.5-flash` evidence and settled
cost-policy rows remain immutable for truthful audit replay, but no new
dispatch or production canary may select those retired models.

Writing release has its own mandatory independent gate. DeepSeek is the
semantic authority and Gemini is an independent advisory critic. DeepSeek Flash gets a 20-second candidate attempt,
and `gemini-3.1-flash-lite` gets a 13-second critique plus one bounded 7-second
contract retry. Invalid or unclear Flash output receives a bounded DeepSeek Pro
repair. If Gemini disputes a valid Flash candidate, DeepSeek Pro adjudicates the
exact immutable evidence and gets one distinct contract retry; a valid Pro
resolution releases without another Gemini veto. A valid Pro-generated
candidate also remains authoritative over Gemini disagreement. Missing,
malformed, or unavailable advisory output triggers bounded automatic recovery
instead of routine teacher review. Only an explicit, structurally valid
DeepSeek Pro finding that the student's meaning is genuinely uninterpretable
may remain private for teacher review. The hard provider deadline at 135 seconds
includes every bounded recovery stage. Partial or structurally invalid
feedback never reaches a student; technical exhaustion remains retryable.

Provider availability fallback covers bounded timeout, network, 408, 429, and
5xx failures. Primary authentication or configuration incidents must not be
silently hidden as ordinary availability. For writing evaluation only, the
server-side `GEMINI_ALLOW_PRIMARY_AUTH_FAILOVER` flag defaults to `false`; it
may be `true` only after a reviewed operator decision, a paid Gemini project,
hard spend caps, and a live synthetic canary. Enabled writing auth failover may
use `gemini-3.1-flash-lite`, emits a high-severity content-free event, and never
logs keys, prompts, or student text.

Worksheet generation never honors the auth-failover flag. A missing or
malformed DeepSeek key, or a DeepSeek 401/403, skips Gemini generation and uses
only an eligible exact-context certified bank worksheet; otherwise the job is
held privately. Semantic worksheet-answer evaluation also never honors the
flag and never releases from one provider alone. Production preflight therefore
requires a writing-only flag decision and canary, plus separate content-free
worksheet evidence proving auth/config fail-closed, both worksheet critics,
certified-bank/private-hold handling, and answer evidence proving both
evaluators, Pro disagreement adjudication, private unresolved output, and
truthful per-question provenance. Missing `GEMINI_API_KEY` blocks automatic
writing release: DeepSeek may prepare a private teacher-review hold, but no
single-model result reaches a student. It likewise blocks generated worksheet
release and automatic semantic-answer completion because their independent
Gemini gates are mandatory.

Production uses a billing-enabled Gemini project; the unpaid tier is forbidden
for student content. Before activation, configure the
[Gemini project spend cap](https://ai.google.dev/gemini-api/docs/billing) in AI
Studio and the application's workspace/global monthly spend reservations plus
emergency stop. Retries and fallbacks never bypass these reservations. The
canonical and compatibility writing workers both require the same complete
reservation lifecycle. A locally rejected pre-dispatch request releases with
`provider_not_called`; Gemini HTTP 400 and 500 release with
`request_failed_unbilled` under Gemini's published billing contract. Timeouts,
aborts, DeepSeek errors, malformed successful bodies, and unknown usage never
use that free path. After expiry plus a five-minute grace, unknown usage is
immutably finalized at the reserved maximum with `usage_estimated = true` and
reported separately from provider-metered spend. It remains charged against
the hard caps. The
combined external-provider cap must fit inside the approved active-student
budget, and recent staging token/cost telemetry, using the current
[Gemini prices](https://ai.google.dev/gemini-api/docs/pricing), must project the
total operating cost at no more than EUR 1 per active student-month, including
bounded retries and fallback traffic. Preflight requires
`secondary_provider_paid_tier`, `monthly_cost_guard_enabled`,
`cost_telemetry_canary_passed`, and
`maximum_projected_cost_per_student_eur <= 1`; the separate EUR 2 hard-cap
envelope is emergency protection only. Any missing evidence or exhausted
cap holds new provider work privately rather than shifting work to teachers.

The checked-in 2026-07-13 Standard paid-tier price snapshot records Gemini 3.1
Flash-Lite at USD 0.25 per million input tokens and USD 1.50 per million output
tokens, including thinking tokens, with context-cached input at USD 0.025 per
million tokens. Each routine Gemini writing or worksheet critique reserves at
most USD 0.15 before dispatch and settles to the actual metered cost afterward.

The V1 application hard cap is USD 225 per UTC billing month; the default
workspace cap remains USD 100 for the controlled pilot. Do not edit migration
history to raise either value. A larger verified cohort may receive a workspace
override only through the audited budget-update path, after a fresh per-student
projection, while the USD 225 global cap remains in force.

## Supabase Pro Checklist

- Upgrade the launch project to Supabase Pro before real production traffic.
- Enable leaked password protection in Supabase Auth.
- Review backup retention and decide whether PITR is needed before paid launch.
- Confirm Auth email templates and redirect URLs point to the correct production domain.
- Approve explicit Auth limits for email sends, verification, token refresh,
  and OTP requests; record the exact values in the protected production
  preflight expectations so configuration drift blocks launch.
- Confirm RLS is enabled on user-facing tables.
- Keep service-role operations inside Edge Functions after caller permissions are verified.

## Platform-administrator MFA, bootstrap, and recovery

Platform-administrator access requires a live Supabase Auth session at `aal2`
and two verified TOTP factors. The second factor is the recovery factor because
Supabase Auth does not issue recovery codes. Administrator queue reads require
AAL2; teacher-access decisions, quota changes, disable/transfer, and the
administrator branch of workspace creation additionally require a TOTP
verification no older than ten minutes. Browser routing is guidance only: the
database helpers and mutation wrappers are authoritative.

Set the Auth access-token lifetime to exactly 600 seconds in production and
record the redacted configuration readback in release evidence. The same
readback must prove TOTP enrollment and TOTP verification are both enabled.
Do not lower the JWT lifetime below five minutes. A revoked refresh session
cannot mint another token, but an already-issued JWT remains usable until
expiry; the ten-minute lifetime bounds that residual window. The checked-in
local/staging defaults are `auth.jwt_expiry = 600` and enabled
`auth.mfa.totp` enrollment/verification in `supabase/config.toml`.

Roll out an existing administrator in this order:

1. Deploy the MFA enrollment/challenge frontend while the old authorization
   migration is still active.
2. From a controlled device, enroll and verify a primary TOTP factor and a
   backup TOTP factor stored on a different device or secure authenticator.
3. Sign out globally, sign in again, complete TOTP, and verify that the new JWT
   reports `aal2`.
4. Through a database-owner/read-only session, verify the exact known user UUID
   has at least two `auth.mfa_factors` rows with `factor_type = 'totp'` and
   `status = 'verified'`. Do not retain secrets or factor IDs in launch
   evidence.
5. Apply `20260713031658_platform_admin_mfa_assurance.sql`, then deploy the
   matching frontend from the same reviewed release.
6. Prove AAL1 rejection, AAL2 read access, fresh-TOTP mutation success, stale
   TOTP rejection, and global sign-out/revoked-session rejection. Retain only
   user UUID, release, timestamps, stable result codes, and pass/fail.

Run that administrator readback separately against staging and production
immediately before the migration push. The environment-specific preflight must
return zero platform-administrator profiles whose Auth account is missing,
unconfirmed, anonymous, deleted, currently banned, or backed by fewer than two
verified TOTP factors. Retain only the environment, release, timestamp, and
violating-row count. The migration repeats this check under short table locks
before redefining administrator authority and raises the stable
`platform_admin_mfa_precondition_failed` error with SQLSTATE `23514` if any row
fails; treat that as a hard deployment rollback, complete factor/account
remediation under the old authorization release, and rerun the preflight. Do
not bypass, comment out, or manually mark this migration as applied.

For a new project with no platform administrator, create and confirm a normal
account first. While it is still a student profile, enroll and verify both TOTP
factors. Then run only this private function from a direct `postgres`
database-owner session with no end-user JWT:

```sql
select app_private.bootstrap_first_platform_admin(
  '<exact-confirmed-user-uuid>'::uuid
);
```

The function fails if an administrator already exists, the account is not a
live confirmed standard account, or fewer than two verified TOTP factors
exist. It writes one immutable, content-free
`app_private.platform_admin_security_audit` row. It is not executable by
`authenticated`, `service_role`, `anon`, or `PUBLIC`. Never add an AAL1,
email-based, metadata-based, hardcoded-UUID, or time-limited bootstrap bypass,
and never disable the profile guard trigger for bootstrap.

Normal lost-device recovery uses the backup factor: challenge it, enroll and
verify a replacement backup, confirm two verified factors remain, and only
then unenroll the lost factor. Never remove the last two factors from a
platform-administrator account.

If all factors are lost or compromise is suspected:

1. A database owner immediately runs
   `app_private.demote_platform_admin_for_mfa_recovery(<uuid>)`. This removes
   platform authority and records immutable evidence before any factor reset.
2. In the Supabase Auth Dashboard or a server-only Admin API procedure, ban the
   exact account and globally revoke its sessions. If a verified factor is
   deleted with the Admin MFA API, Supabase logs out all active sessions. Never
   expose the secret/service-role key to the browser and never modify
   `auth.sessions` directly in product SQL.
3. Complete out-of-band identity verification. Unban only for the controlled
   recovery login, remove compromised factors, and enroll and verify a new
   primary plus backup TOTP factor.
4. After a database-owner readback confirms two verified factors and a live,
   confirmed, unbanned standard account, run
   `app_private.restore_platform_admin_after_mfa_recovery(<uuid>)`. Restoration
   requires the prior demotion evidence and writes a second immutable audit
   row.
5. Sign out globally again, sign in with password plus TOTP, and rerun the AAL2,
   freshness, session-revocation, and audit-immutability smokes.

For a compromised teacher account, first use the fresh-TOTP
`disable_teacher_access` operation. Effective-entitlement checks remove
owner/teacher authority immediately even if an old membership row or access JWT
still exists, and finish-offboarding transfers ownership and removes residual
privileged memberships. Then ban the Auth account and globally revoke sessions.
With a 600-second JWT, ordinary learner self-access can persist for at most that
residual token lifetime; teacher/control-plane authority does not. Record the
incident time, target UUID, entitlement revision, transferred/removed counts,
ban/session action result, and final zero-authority probe without retaining
email, factor secrets, tokens, or student content.

## Data API Schema Checklist

- Local, staging, and clean production expose only `schemas = ["api"]` after
  the Phase 11C browser and Edge cutover. The linked worksheet importer uses a
  direct database transaction and does not require a public REST route.
- The browser defaults to `api`; Phase 11C pgTAP and browser service tests must
  pass before a deployment is promoted.
- Confirm authenticated callers can execute only the revision-safe
  `api.submit_practice_attempt(uuid, integer)` overload; the legacy raw-answer
  `api.submit_practice_attempt(uuid, jsonb)` overload must have no browser grant.
- Clean production exposes only `api`; do not expose `app_private`, queue
  schemas, diagnostics, answer-key tables, or `graphql_public`.
- Production preflight must prove `Accept-Profile: public` is rejected and
  `Accept-Profile: api` succeeds for an authorized test account.
- Every Edge Data API client must set `db.schema` to `api`; the deployment
  preflight rejects unqualified public REST/RPC dependencies.

## Migration Checklist

Before replaying the migration history into a newly provisioned production
project, run this read-only query through the Supabase SQL Editor or Management
API read-only query route:

```sql
select current_setting('server_version_num')::integer as server_version_num;
```

Proceed only when the returned integer is at least `170000` (PostgreSQL 17).
The full production preflight repeats this check and fails closed if the value
is missing or lower.

Erratum: migration
`20260711130630_revoke_browser_maintain_privileges.sql` uses the `MAINTAIN`
privilege, which was introduced in PostgreSQL 17, not PostgreSQL 15. That
migration has already been applied to staging and is immutable: do not edit,
rename, or rewrite it. Any future correction must be a reviewed forward-fix
migration.

Before any launch decision, run the fail-closed, read-only production check in
[`PRODUCTION_PREFLIGHT.md`](./PRODUCTION_PREFLIGHT.md). It verifies project
identity, migration/function/secret parity, Auth and Data API configuration,
queue/Cron/Realtime recovery, backups, rollback evidence, and monitoring
privacy. It also fails closed unless a dated minor-safe privacy/DPA review and
retention/deletion policy approval cover the external evaluator transfer for
the exact production release. It is separate from the seven-day operational
release gate.

Dispatch production preflight only from `main`. Its workflow must keep
production secrets out of job scope: checkout/setup/install/local-reset steps
receive none, the database password is limited to the link step, and collection
credentials are limited to the exact read-only collector that uses them.

Before deploy:

- Pull latest `main`.
- Confirm `supabase migration list --linked` has no drift.
- Run `supabase db lint --linked`.
- Read any migration that touches Auth, RLS, or destructive DDL.
- Never run cleanup/delete SQL without explicit approval and a backup plan.
- For the production preflight, reset the complete migration history into a
  disposable local Supabase database. The collector uses local `psql` and the
  production Management API read-only query route to compare ordered migration
  names, statement counts, and statement-array SHA-256 digests; it does not
  reset or connect `psql` directly to production.

### Guarded remote Auth configuration

Never run raw `supabase config push` for this repository. It reconciles API,
database, Auth, and Storage configuration together and can overwrite unrelated
remote drift. The checked-in `supabase/config.toml` intentionally contains local
defaults and is not remote staging or production configuration. Use only the
targeted Auth Management API wrapper, which:

- requires an explicit target environment and project ref;
- independently reads the linked project ref and rejects any mismatch;
- binds staging and production to distinct expected project refs;
- refuses to push local configuration;
- requires a public HTTPS remote site URL plus exact same-origin Auth landing
  routes (staging requires `/auth/confirm` and `/auth/reset-password`); and
- renders and validates the approved Auth plan without making a change;
- on `--execute`, PATCHes only `site_url`, `uri_allow_list`, `jwt_exp`,
  `password_min_length`, and the two TOTP capability fields; and
- performs an exact GET readback, while never sending the checked-in API,
  database, Storage, or Edge Function configuration to the remote project.

Set the expected project identities in the protected operator environment. A
project ref is not a secret, but the protected values are the independent
identity contract used by the guard:

```sh
export STAGING_PROJECT_REF="<staging-project-ref>"
export PRODUCTION_PROJECT_REF="<production-project-ref>"
export SUPABASE_ACCESS_TOKEN="<protected-management-api-token>"
```

For staging, first confirm the workspace is linked to the expected staging
project. Provide the stable HTTPS staging origin and both exact Auth landing
routes, then review the dry-run and repeat the exact command with `--execute`:

```sh
pnpm run supabase:auth:configure -- \
  --environment staging \
  --project-ref "$STAGING_PROJECT_REF" \
  --site-url "https://<staging-domain>" \
  --redirect-url "https://<staging-domain>/auth/confirm" \
  --redirect-url "https://<staging-domain>/auth/reset-password"
```

For production, the protected production link step must already be complete.
Provide the canonical production origin and every exact Auth landing route.
The first command is validation-only and cannot change Supabase:

```sh
pnpm run supabase:auth:configure -- \
  --environment production \
  --project-ref "$PRODUCTION_PROJECT_REF" \
  --site-url "https://<production-domain>" \
  --redirect-url "https://<production-domain>/auth/confirm" \
  --redirect-url "https://<production-domain>/auth/reset-password"
```

After checking the environment, project ref, six-field Auth-plan SHA-256, site origin,
redirect count, exact `auth_jwt_expiry_seconds: 600`, exact
`auth_minimum_password_length: 8`, and both
`auth_totp_enrollment_enabled: true` and
`auth_totp_verification_enabled: true` printed by the dry-run, repeat the exact
command with `--execute`. The wrapper still fails closed if the linked identity,
any Auth URL, JWT lifetime, password minimum, or TOTP capability changed. Local
development uses `supabase start`; it never uses remote Auth configuration. The
execute step requires `SUPABASE_ACCESS_TOKEN` from the protected operator
environment and never prints or stores it. After a remote update, run the
read-only production preflight and retain the redacted Auth readback proving the
approved URLs, exact 600-second JWT lifetime, both TOTP capabilities, and the
content-free boolean that at least one usable platform administrator has two
verified TOTP factors.

Deploy:

- For ordinary releases, push migrations first.
- Exception: do not push
  `20260713031658_platform_admin_mfa_assurance.sql` until the enrollment UI is
  already being served and every existing platform administrator has enrolled
  primary and backup verified TOTP factors. Follow “Platform-administrator MFA,
  bootstrap, and recovery” above. The release gate must record a zero-violation
  staging readback, then a zero-violation production readback, plus the exact
  `jwt_expiry = 600` rendered-config check before allowing this migration. A
  `platform_admin_mfa_precondition_failed` result blocks the push; it is never
  overridden by the generic migrations-first order.
- Generate frontend Supabase types only when schema changes.
- Deploy changed Edge Functions.
- Build frontend from the same commit.

After deploy:

- Verify migration list again.
- Run the smoke checklist below.

## Edge Function Deploy Checklist

Active functions:

- `prepare-writing-feedback`
- `process-due-feedback`
- `generate-practice-worksheet`
- `evaluate-practice-attempt`
- `kick-writing-jobs`
- `process-writing-jobs`
- `process-worksheet-generation-jobs`
- `process-worksheet-answer-jobs`
- `recover-async-jobs`

Deploy only changed functions unless a shared module changes. If `supabase/functions/_shared/writing-feedback.ts` changes, redeploy all functions that import it.

The exact deployed `verify_jwt` mode for every function is pinned in
`config/production-preflight.contract.json` and checked against the sanitized
`supabase functions list -o json` inventory. Do not use a deploy flag to
override the checked-in mode. The browser-facing relay handlers perform their
own cryptographic Supabase user-JWT verification before parsing request bodies
or making authorization RPCs; worker/recovery handlers independently verify
their service credentials. A missing, non-boolean, or drifted deployed mode is
a production-preflight failure.

## Student-data governance gate

- Before any production writing reaches an external evaluator, the responsible
  human reviewers must approve the minor-safe privacy treatment, the applicable
  DPA, the raw-writing transfer, and the retention and deletion policies.
- Store only a dated, opaque, content-free attestation in
  `PRODUCTION_OPERATIONS_EVIDENCE_JSON`; keep the underlying legal/privacy
  records in the restricted system of record.
- The preflight ties the attestation to the production project and release,
  rejects stale or future-dated verification, and rejects unsupported fields.
  Passing booleans are evidence requirements, not legal conclusions.

## Sentry Setup

Use a dedicated frontend Sentry project.

- Set `VITE_SENTRY_DSN` in deployment env.
- Set `VITE_SENTRY_ENVIRONMENT=production`.
- Set `VITE_APP_RELEASE` to the git commit or release tag.
- Keep `sendDefaultPii=false`.
- Keep Replay disabled by default. If enabled, use privacy-safe settings: mask all text, mask all inputs, block media, and low error-only sampling.
- Production builds must provide `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `SENTRY_API_BASE_URL`, and the same `VITE_APP_RELEASE` used
  at runtime, with `SENTRY_UPLOAD_SOURCE_MAPS=true`. The build validates the
  API base as an official Sentry SaaS HTTPS origin and requires the browser DSN
  to use that origin's matching ingestion region before the upload plugin can
  receive the token. The official Vite plugin fails the build on upload errors, injects
  release/debug IDs, and deletes generated `.map` files after upload.
- Never publish source maps in the deployed frontend artifact. The deployed
  `launch-manifest.json` must report `sentry_source_maps_configured: true`.
- Run the `Attested production rollback artifact` workflow for the exact
  approved release. It hashes the frontend, Edge Functions, and complete
  migration history; rejects `.map` and `.env` files; creates a GitHub build
  provenance attestation; and retains the rollback bundle for 90 days.
- Configure Edge Function monitoring as a separate privacy-safe source. Log only
  opaque request/job identifiers, status, stage, attempt count, and duration;
  never attach student writing, worksheet answers, feedback/provider payloads,
  prompts, headers, tokens, or free-form exception bodies.
- Configure alerts for queue age, retries, dead letters, provider latency, held
  feedback, worksheet rejection, Auth failures, and frontend errors. Record the
  verified privacy state in operations evidence and each live Sentry workflow
  ID/name in release expectations; preflight reads the workflow API and rejects
  disabled workflows or workflows without an active notification action.

## Smoke Test Checklist

Before the manual smoke test, run the automated checks documented in
`docs/TESTING.md`. CI runs unit/type/build, browser, and disposable local
database checks on every pull request and branch push.

Teacher:

- Sign in.
- Open dashboard.
- Open batches/students/questions/submissions.
- Create or edit one writing task if needed.
- Open one submitted writing.
- Prepare feedback once.
- Confirm feedback success or safe failure text.

Student:

- Sign in.
- Open dashboard.
- Join a batch with its code and wait for teacher approval.
- Submit writing.
- Open feedback result/history.
- Open Practice Center.
- Prepare a worksheet for an unlocked topic.
- Confirm answer keys are hidden before submit.
- Submit worksheet.
- Confirm saved answers, result, explanations, and review show after submit.
- Fail an original worksheet and confirm exactly one repeat is available.
- Fail a repeat worksheet and confirm teacher-support message appears.

Safety:

- No student-facing message should mention provider names, models, internal validation, stack traces, or raw Supabase errors.
- The retired `VITE_ENABLE_DEMO_MODE` flag must never restore demo shortcuts or
  local role access. Public Playwright runs with the flag set to `true` and
  proves both protected role shells still reject unauthenticated access.

## Rollback and Recovery

- For frontend-only issues, redeploy the previous frontend build or previous commit.
- For Edge Function issues, redeploy the last known good function bundle.
- For migration issues, do not manually delete data. Stop traffic if needed, inspect Supabase backups, and write a reviewed forward-fix migration.
- For failed worksheet generation, inspect `practice_generation_events` and Edge Function logs by `assignment_id`.
- For failed writing feedback, inspect Edge Function logs by `request_id` and `submission_id`.

## Data That Must Never Be Deleted Without Explicit Approval

- Auth users
- profiles
- workspace graph
- real student submissions and feedback
- global writing tasks
- approved/manual worksheets
- migrations/schema history
- production usage events required for audit/debugging

## Debugging With Codex

When reporting an issue, collect:

- user role
- route
- workspace id if known
- submission id, assignment id, or attempt id
- timestamp with timezone
- screenshot of safe UI error
- Sentry event id if available
- Supabase Edge Function log lines with matching `request_id`

Do not send passwords, API keys, raw writing text, worksheet answers, or provider output.
