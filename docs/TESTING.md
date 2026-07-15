# Testing and CI

The repository uses pnpm only. Install the pinned workspace dependencies before
running checks:

```sh
pnpm install --frozen-lockfile
```

## Required pull-request checks

```sh
pnpm run typecheck
pnpm run test:unit
pnpm run check:edge
pnpm run test:edge
pnpm run build:ci
pnpm audit --prod --audit-level=high
```

`pnpm run verify` runs typecheck, unit tests, and the configured production
build in sequence. `build:ci` supplies `PORT=5173`, `BASE_PATH=/`, and the
three fail-closed V1 launch flags explicitly. This keeps the credential-free CI
artifact production-safe while still requiring real deployment environments to
provide and verify their own launch configuration.

### Complete credential-free local matrix

`pnpm run verify:local` is the aggregate local equivalent of the required
source, browser, dependency, and database CI jobs. It runs the audit ledger,
TypeScript, Vitest, Edge checks and regressions, the production-configured
build, the production dependency audit, both credential-free Playwright
suites, pgTAP, and `git diff --check`. It intentionally does not claim any
credentialed staging, provider, human-content, production, or pilot gate.

The command expects Deno 2, Chromium, the Supabase CLI, Docker, and a freshly
reset disposable local Supabase stack. Prepare and clean that stack explicitly:

```sh
pnpm run test:e2e:install
supabase start
supabase db reset --local
pnpm run verify:local
supabase stop --no-backup
```

If verification stops early, still run `supabase stop --no-backup`. Never add
`--linked`, a remote database URL, or production credentials to this reset
sequence. `supabase db reset --local` destroys and rebuilds only the disposable
local database, then replays the complete checked-in migration history and
local seed before pgTAP runs.

## Unit and component tests

Vitest and Testing Library are configured in
`artifacts/german-writing-coach/vitest.config.ts`.

```sh
pnpm run test:unit
pnpm run test:unit:coverage
```

Tests belong under `artifacts/german-writing-coach/tests/unit`. Prefer
accessible queries such as role, label, and visible name. Do not use snapshots
as the only assertion for security, workflow, or educational correctness.

## Edge Function tests

The shared writing-evaluator regressions run with Deno 2, matching the Supabase
Edge Function runtime closely enough to exercise its native imports and text
processing behavior:

```sh
pnpm run test:edge
```

The suite currently uses `--no-check` because the existing generated Supabase
client types infer several service-role tables as `never`. Runtime assertions
still execute in CI; removing that flag requires regenerating and tightening
the Edge Function database types rather than skipping these tests.

## Browser smoke tests

Playwright is configured with a local public-auth server and a Chromium smoke
project. Browser binaries are intentionally not downloaded by `pnpm install`.
The public server deliberately sets the retired `VITE_ENABLE_DEMO_MODE` flag to
`true` as a regression canary: the login page must still expose no role
shortcuts, and a stale pre-V1 local role must not open either protected shell.

```sh
pnpm run test:e2e:install
pnpm run test:e2e
pnpm run test:e2e:practice-state-matrix
```

To test an already deployed environment, skip the local web server by setting:

```sh
E2E_BASE_URL=https://staging.example.com pnpm run test:e2e
```

Never commit credentials. Authenticated browser flows must read dedicated test
credentials from CI secrets. The `Verify` workflow runs the public browser
smoke suite plus the dedicated practice-state/responsive-navigation matrix on
pull requests and branch pushes; manual dispatch can skip both by leaving
`run_e2e` disabled.

The separate manual **Authenticated staging workflow smoke** is a protected,
provider-free matrix. It runs only from a manual dispatch of protected `main`
with `run_authenticated_e2e` enabled; public pull requests never receive or
depend on its secrets. The job serves the checked-out frontend on `127.0.0.1`
and connects it only to the repository-pinned staging Supabase project. It
requires the protected `STAGING_VITE_SUPABASE_ANON_KEY`, dedicated correctly
named `E2E_TEACHER_*` and `E2E_STUDENT_*` credentials. Missing prerequisites
fail the deliberately requested job without printing their values. Database
owner credentials are deliberately excluded from the Playwright job.

The CI matrix verifies both role shells, primary navigation, and every reviewed
dialog at 1366×768. No mutable external app URL receives credentials,
authenticated traces/screenshots/videos remain disabled, and the job uploads
no authenticated artifact:

```sh
E2E_AUTHENTICATED=true \
VITE_SUPABASE_URL=https://vzcgalzspdehmnvqczfw.supabase.co \
VITE_SUPABASE_ANON_KEY='<SUPABASE_ANON_KEY_FROM_PRIVATE_ENV>' \\
E2E_TEACHER_EMAIL='<TEACHER_EMAIL_FROM_PRIVATE_ENV>' \\
E2E_TEACHER_PASSWORD='<TEACHER_PASSWORD_FROM_PRIVATE_ENV>' \\
E2E_STUDENT_EMAIL='<STUDENT_EMAIL_FROM_PRIVATE_ENV>' \\
E2E_STUDENT_PASSWORD='<STUDENT_PASSWORD_FROM_PRIVATE_ENV>' \\
pnpm run test:e2e:authenticated
```

The protected workflow invokes the read-only dialog command below:

```sh
E2E_DIALOG_SWEEP=true pnpm run test:e2e:dialog-viewport
```

An authorized staging operator can run the isolated autosave and Realtime
regressions separately. Those commands additionally require a linked Supabase
CLI and database credentials in the operator's secure environment; they are
never placed in the browser CI job:

```sh

E2E_MUTATIONS=true \
E2E_AUTOSAVE_REGRESSION=true \
E2E_AUTOSAVE_STUDENT_SLOT=STUDENT \
pnpm run test:e2e:autosave-regression

E2E_MUTATIONS=true \
E2E_SUBMISSION_REALTIME=true \
pnpm run test:e2e:submission-realtime
```

`E2E_AUTOSAVE_STUDENT_SLOT` identifies which credential slot actually belongs
to the student; it is not a role override. The application and fixture setup
still prove the trusted database roles. Before any navigation, the dialog sweep
blocks service workers and installs a browser-context guard that aborts every
Edge Function request, every reviewed mutating RPC, and every direct REST table
write while allowing authentication and read traffic. Its unconditional
teardown also fails on blocked attempts, page errors, or HTTP 5xx responses.
The operator-only autosave and submission runs use
the absolute `E2E_SUPABASE_BIN`, require the repository to be linked to the
pinned staging project, and never invoke an AI provider.

The isolated staging mutation run additionally creates one short-lived class
for each feedback mode, verifies its generated join code and visible mode, and
archives it before finishing. The same run also creates one task for each of
the nine supported writing-task types, updates one, and deactivates every task
created by that exact run stamp. Those inactive task rows remain in staging as
audit history. It is opt-in and uses the same artifact-free, loopback-only
authenticated browser configuration:

```sh
E2E_AUTHENTICATED=true \
E2E_MUTATIONS=true \
VITE_SUPABASE_URL=https://vzcgalzspdehmnvqczfw.supabase.co \
VITE_SUPABASE_ANON_KEY='<SUPABASE_ANON_KEY_FROM_PRIVATE_ENV>' \\
E2E_TEACHER_EMAIL='<TEACHER_EMAIL_FROM_PRIVATE_ENV>' \\
E2E_TEACHER_PASSWORD='<TEACHER_PASSWORD_FROM_PRIVATE_ENV>' \\
E2E_TEACHER_WORKSPACE_MEMBERSHIP_ID='exact-staging-membership-uuid' \
pnpm run test:e2e:mutations
```

`E2E_TEACHER_WORKSPACE_MEMBERSHIP_ID` is mandatory and must be the exact UUID
of the dedicated teacher account's intended staging workspace membership. The
runner writes that preference immediately before sign-in, verifies the trusted
authentication context contains that teacher membership, and confirms the
hydrated application preserved the exact selection. Any missing, malformed,
wrong-account, or substituted membership aborts the suite before it creates a
class or writing task.

The real core-workflow run uses separate teacher and student browser contexts
against the real staging application. It creates one uniquely named class, submits its code
from the student account, approves the exact request from the teacher account,
and verifies that the student can explicitly select the class for writing. Its
cleanup removes only the test-created assignment (or offboards only when a
pre-run roster check proved that the workflow created the workspace membership)
before archiving the class:

```sh
E2E_AUTHENTICATED=true \
E2E_CORE_WORKFLOW=true \
VITE_SUPABASE_URL=https://vzcgalzspdehmnvqczfw.supabase.co \
VITE_SUPABASE_ANON_KEY='<SUPABASE_ANON_KEY_FROM_PRIVATE_ENV>' \\
E2E_TEACHER_EMAIL='<TEACHER_EMAIL_FROM_PRIVATE_ENV>' \\
E2E_TEACHER_PASSWORD='<TEACHER_PASSWORD_FROM_PRIVATE_ENV>' \\
E2E_STUDENT_EMAIL='<STUDENT_EMAIL_FROM_PRIVATE_ENV>' \\
E2E_STUDENT_PASSWORD='<STUDENT_PASSWORD_FROM_PRIVATE_ENV>' \\
pnpm run test:e2e:core-workflow
```

The database intentionally keeps the archived class and the cancelled or
approved join-request history for auditability; there is no browser hard-delete
operation. Run this only against the pinned staging project and dedicated test
accounts.

Do not place real or test-account credentials in shell history, repository
files, screenshots, traces, or artifacts. This smoke is a foundation check;
the class/join gate is not Verified until the opt-in core workflow succeeds on
staging, and the feedback, practice, and offboarding matrices still need their
own isolated staging evidence before launch.

### Platform-administrator teacher-onboarding smoke

The teacher-access workflow is intentionally separate because its administrator
slot must already be a live platform administrator with a primary and a backup
verified TOTP factor. Complete both enrollments manually on separate
authenticators. Do not store the enrollment QR, `otpauth` URI, or factor secret
in CI, the repository, screenshots, or test artifacts.

Immediately before the run, load one fresh six-digit value as
`E2E_ADMIN_TOTP_CODE` from the authenticator through a private runtime secret
prompt. The test consumes that value at most once to reach AAL2, never derives
codes from a stored seed, and retains no authenticated artifact. The fresh TOTP
verification also satisfies the server's ten-minute administrator-mutation
window; if it expires, rerun with a new code rather than reusing it.

Set `E2E_AUTHENTICATED=true`, `E2E_MUTATIONS=true`,
`E2E_TEACHER_ACCESS_DISPOSABLE=true`, the pinned staging URL/key, a dedicated
platform-administrator credential slot, and the disposable student credential
slot in that private environment, then run:

```sh
E2E_ADMIN_EMAIL='<ADMIN_EMAIL_FROM_PRIVATE_ENV>' \\
E2E_ADMIN_PASSWORD='<ADMIN_PASSWORD_FROM_PRIVATE_ENV>' \\
E2E_STUDENT_EMAIL='<STUDENT_EMAIL_FROM_PRIVATE_ENV>' \\
E2E_STUDENT_PASSWORD='<STUDENT_PASSWORD_FROM_PRIVATE_ENV>' \\
pnpm run test:e2e:teacher-access
```

The workflow never enrolls an authenticator automatically. It fails before an
administrator mutation when the two-factor recovery set is incomplete, proves
that the student cannot open the administrator route, then requests access,
receives one default teaching area, reaches the first-class wizard, and is
safely disabled through the real UI. Do not reuse the ordinary teacher account
as the platform administrator; teacher workflow tests must remain routable as
an ordinary entitled teacher.

### Isolated enrollment-edge security regressions

The enrollment-edge run exercises SEC-006 and SEC-018 without submitting
writing or invoking any AI provider. It accepts the two dedicated test accounts
in either environment-variable slot, detects their actual teacher and student
shells, and then uses one uniquely named staging class. Set
`E2E_AUTHENTICATED=true` and `E2E_ENROLLMENT_EDGES=true` through the same private
secret runner described above, then run:

```sh
pnpm run test:e2e:enrollment-edges
```

The run proves that a structurally invalid code and the real code of an
archived class both fail closed without creating a pending request. It then
reactivates the class, approves one request, replays the exact authenticated
approval request, and verifies that the replay returns the same approved
request and leaves exactly one class assignment. Re-entering the approved code
must also return the same request as already joined.

Finally, the teacher archives the class while the student is enrolled. The
student must still be able to open **Join another class**, while the archived
class must disappear from active writing choices. Cleanup reactivates the exact
fixture, removes only its proven assignment (or the proven new workspace
membership), and archives the empty class. Credentials and join codes are never
printed or retained; traces, screenshots, videos, and failure artifacts remain
disabled. This opt-in command is not part of the normal `Verify` workflow.

### Isolated teacher-review and scheduled-feedback workflow

The feedback-mode workflow completes the real class, join, writing, release,
offboarding, archive, and history paths with separate teacher and student
browser contexts. It is intentionally opt-in and is not part of the normal
`Verify` workflow. Load the pinned staging configuration and dedicated
`E2E_TEACHER_*` and `E2E_STUDENT_*` credentials through the private secret
runner; do not put them in a command, shell history, repository file, or browser
artifact. The runner fingerprints every pre-existing membership for both
accounts, creates a random temporary workspace containing only the preferred
teacher membership, and then makes the teacher select that exact membership.
Existing memberships in every persistent workspace remain untouched.

Set `E2E_AUTHENTICATED=true`, `E2E_MUTATIONS=true`,
`E2E_FEEDBACK_MODES=true`, and the absolute `E2E_SUPABASE_BIN` path in that
private environment, then run:

```sh
pnpm run test:e2e:feedback-modes
```

The workflow uses fixed synthetic German text and only uniquely named resources
created by that run. For Teacher review, it verifies that the prepared draft is
private, saves an edited summary with the expected optimistic revision,
rechecks student privacy, approves the exact version, and proves that the edit
is released. For Scheduled feedback, it creates an equal 4–4 minute range so
the release time is deterministic from submission, proves that only the teacher
can see the read-only prepared preview before it is due, and requires the
student release no later than `release_at + 60 seconds`.

After both modes complete, the browser proves the temporary student membership
contains exactly the two test-created classes, offboards it, proves neither
class remains selectable, archives both classes, and confirms both historical
submissions remain visible to the teacher. Only after those history assertions
does private SQL remove the exact temporary workspace. Teardown refuses active
jobs or spend reservations, archives terminal spend evidence, removes matching
queue messages, verifies zero workspace-scoped residue, and requires both
pre-existing membership fingerprints to match exactly. An owner-only recovery
manifest remains when cleanup cannot safely finish; run the same command with
`E2E_FEEDBACK_MODES_RECOVERY_ONLY=true` to retry exact teardown without another
provider call. The authenticated runner retains no output and keeps traces,
screenshots, and videos disabled. This command mutates staging; the
specification is built and statically checked without running it unless an
operator deliberately provides the opt-in secret environment.

### Authenticated staging route performance

The read-only route-performance run measures teacher Overview, Classes,
Students, and Review Queue plus student Home, Write, Practice, and History. It
performs one excluded warm-up and twenty measured warm samples per route, reports
navigation-to-ready, Data API transfer, and post-response client-render timing
separately, rejects unreviewed duplicate equivalent Data API reads, and
enforces a warm p95 readiness limit below two seconds. One exact grammar-stat
catch-up read after the Practice Realtime subscription is reported separately
and bounded to at most one per navigation because it closes the release event
race between the initial query and subscription acknowledgement.

Load the pinned staging URL, anonymous key, and dedicated teacher and student
credentials through the same private secret runner described above. Set
`E2E_AUTHENTICATED=true` and `E2E_PERFORMANCE=true`, then run:

```sh
pnpm run test:e2e:performance
```

The two credential slots may be supplied in either order. Each account is
authenticated exactly once; the run requires one teacher and one student by
matching the trusted `get_auth_context` role to the routed application shell.

The run only navigates and reads the explicitly reviewed Data API endpoints. It
does not call an Edge Function or AI provider and does not retain request URLs,
bodies, credentials, traces, screenshots, videos, or browser output. Its
content-free summary reports endpoint names, request counts, timing aggregates,
and duplicate counts to the private process output. This opt-in command is not
part of the normal `Verify` workflow.

### Isolated immediate-writing smoke

The live-writing smoke is a separate, mutating provider check. Each run creates
one short-lived workspace and active immediate-feedback class in the pinned
staging project, assigns the configured student account, selects that exact
class in the browser, and removes only the fixture-owned records afterward.
Provide all of these values through a private secret runner or a
permission-restricted environment file outside the repository:

- `E2E_AUTHENTICATED=true`
- `E2E_MUTATIONS=true`
- `E2E_LIVE_WRITING=true`
- `E2E_WRITING_STUDENT_SLOT=TEACHER` or `STUDENT`, identifying which supplied
  credential slot is the real student account
- optionally, `E2E_LIVE_WRITING_CASE_INDEX=0` through `19` for the fixed
  sampling corpus, or the mutually exclusive closed selector
  `E2E_LIVE_WRITING_REGRESSION_ID=a1-user-letter-regression` for the
  teacher-reported A1 regression
- optionally, `E2E_LIVE_WRITING_EXTERNAL_RECOVERY=true` to suppress exactly
  the browser's normal `kick-writing-jobs` request and require a newer external
  recovery heartbeat before the same terminal feedback and cleanup gates pass
- `E2E_SUPABASE_BIN` containing the absolute path to the Supabase CLI
- the pinned staging Supabase URL and anonymous key
- both dedicated `E2E_TEACHER_*` and `E2E_STUDENT_*` credential slots

After loading those values without placing them in shell history, run:

```sh
pnpm run test:e2e:writing-live
```

The smoke uses the real application; the showcase surface no longer exists. It
verifies the configured account's exact student role, autosave, reload
restoration, durable submission acknowledgement, and released line-by-line
feedback. The fixed writing is not printed or attached; authenticated
traces, screenshots, videos, database output, and retained output are disabled.
Every writing is fixed in the test source; operators cannot substitute student
or personal content. Terminal runs emit only content-free `WRITING_LIVE_OUTCOME`
data (release/hold/failure state, safe reason, latency, provider path, retries,
and cost). Released runs additionally emit `WRITING_LIVE_METRIC` quality counts;
the closed A1 regression verifies the original hash, required correction groups,
and forbidden uncorrected forms without printing the writing or feedback.
Cleanup is pinned to the generated workspace and removes its queue messages,
jobs, feedback evidence, grammar statistics, adaptive-practice records, quota
counters, submission, class, memberships, and workspace. Residue or a scope
mismatch fails the run after cleanup.

Before database setup, the runner atomically writes an ignored, owner-only
`.e2e-private/writing-live-fixture.json` manifest containing only the pinned
project reference and fixture IDs. A normal run removes it only after exact
cleanup and zero-residue verification. If the process is terminated, the next
run consumes that manifest before creating anything new. Recovery refuses to
delete or start a new run while a fixture job is queued, processing, or waiting
to retry, or while one of its spend reservations is still reserved. To perform
recovery without making a new provider call, supply the authenticated staging
URL/key, `E2E_MUTATIONS=true`, the absolute `E2E_SUPABASE_BIN`, and
`E2E_LIVE_WRITING_RECOVERY_ONLY=true`, then run the same command. A safe failure
leaves the manifest in place for a later retry.

Database cleanup cannot undo an external provider request. Once the synthetic
sample has been submitted, it may remain subject to the provider's processing,
logging, and retention terms even after all staging fixture rows are removed.
Run this smoke only against the approved paid staging-provider configuration.

### Preconditioned live-practice autosave smoke

The live-practice smoke uses the real application with an existing eligible
staging assignment. It verifies that a named worksheet answer control
autosaves, survives a full reload, and is restored to its exact pre-run value
before the test exits. The smoke never submits the worksheet and never deletes
practice, feedback, or student history.

Load these values through the same private secret runner used for authenticated
tests:

- `E2E_AUTHENTICATED=true`
- `E2E_MUTATIONS=true`
- `E2E_LIVE_PRACTICE=true`
- `E2E_PRACTICE_MODE=autosave`, `generation`, or `submission`
- `E2E_PRACTICE_ASSIGNMENT_ID` for one operator-verified eligible assignment
- the pinned staging Supabase URL and anonymous key
- the dedicated `E2E_STUDENT_*` credentials
- for autosave mode, `E2E_PRACTICE_QUESTION_NUMBER` naming one text-answer
  question and `E2E_PRACTICE_SAMPLE` with synthetic, non-student text
- for submission mode, `E2E_PRACTICE_ANSWERS_JSON` containing the complete
  synthetic answer contract by question number

Then run:

```sh
pnpm run test:e2e:practice-live
```

Autosave mode requires a ready worksheet and restores the chosen answer content
in a `finally` block. Generation mode requires that exact assignment to still
need a worksheet and exercises approved reuse or provider generation without
submitting answers. Submission mode is an intentionally irreversible terminal
check: it fills the complete operator-supplied answer contract, submits once,
waits through semantic evaluation, and requires a score plus per-question status
and points. No mode discovers or mutates whichever worksheet happens to appear
first.

This is intentionally not a zero-state-change test: opening a ready assignment
may move it from unlocked to in progress; autosave restoration increments the
draft revision and can create an empty draft; generated worksheet history is
retained in staging; submission mode permanently completes its dedicated
assignment and retains the attempt/review history. An interrupted submission
run can also retain a partial synthetic draft. Use only disposable, explicitly
targeted staging assignments. Probe answers and credentials are never printed
or passed to the Vite server; authenticated traces, screenshots, videos, and
retained output remain disabled.

### Isolated bank-first and generated worksheet certification

The worksheet-live command is the deliberate paid-provider release canary. It
creates one exact disposable staging workspace at the explicitly selected A1,
A2, B1, or B2 level, proves synchronous reuse of an existing qualified bank
worksheet when available, then forces a no-bank generation path and requires
accepted independent DeepSeek/Gemini evidence. It also proves immediate
progress, autosave/reload restoration, complete answers, terminal scoring,
exact fixture and model-cache cleanup, and the generation/evaluation timing
gates. It never publishes or certifies a draft worksheet itself.

Run it outside routine CI with the pinned staging URL/key, both dedicated test
accounts, an absolute `E2E_SUPABASE_BIN`, and the explicit student credential
slot. The repository must already be linked to the pinned staging project:

```sh
E2E_AUTHENTICATED=true \
E2E_MUTATIONS=true \
E2E_LIVE_WORKSHEET=true \
E2E_WORKSHEET_STUDENT_SLOT=STUDENT \
E2E_WORKSHEET_LEVEL=A2 \
pnpm run test:e2e:worksheet-live
```

For the protected sequential A1, A2, B1, and B2 provider matrix, leave
`E2E_WORKSHEET_LEVEL` unset and run:

```sh
E2E_AUTHENTICATED=true \
E2E_MUTATIONS=true \
E2E_LIVE_WORKSHEET=true \
E2E_WORKSHEET_STUDENT_SLOT=STUDENT \
pnpm run test:e2e:worksheet-live-matrix
```

The matrix owns the exact A1 to B2 order, stops at the first failure, and
attempts exact recovery before returning. Set `E2E_REQUIRE_BANK=true` only for
the final bank-publication run so missing certified bank coverage fails instead
of skipping synchronous reuse. These canaries consume provider quota and can
take several minutes, so protected provider-free CI intentionally does not call
them. If a single-level run is interrupted and exact cleanup cannot finish, set
`E2E_LIVE_WORKSHEET_RECOVERY_ONLY=true` and invoke the single-level command with
the authenticated mutation prerequisites. Recovery mode performs no new
worksheet generation.

### Staging-only worksheet stage diagnostic

`provider-transport-diagnostic` is a staging-only operator function and never a
production release artifact. Invoke its `worksheet_full` mode only through the
protected secret runner, using synthetic curriculum context and the staging
service credential. Do not put that credential in a command, repository file,
shell history, screenshot, or retained CI output.

The full-pipeline response contains `accepted`, `retryable`, the final
`safe_error_code`, and an ordered `stages` array. Every stage object has an
exact content-free allowlist: `stage`, optional `generation_source`,
`elapsed_ms`, and `safe_error_code`. The only stage names are
`primary_generation`, `primary_fallback_generation`, `primary_critique`,
`repair_generation`, and `repair_critique`; the source, when a candidate source
is known, is only
`deepseek` or `gemini`. Prompts, candidate or worksheet content, questions,
answers, hashes, model names, provider response bodies, and rejection text must
never appear.

This diagnostic calls the same deterministic validator and mandatory parallel
DeepSeek/Gemini critic gate as the worker. It is diagnostic evidence for stage
identity and latency, not proof of queue checkpoint persistence. Certification
also requires the real queued staging workflow to prove that a worker restart
resumes the exact unfinished stage without repeating a completed checkpointed
generation stage. A partially completed dual-critic batch must rerun both
critics and must never release from partial evidence.

The standalone `worksheet_secondary` probe requests a 45-second durable-stage
Gemini window. The queued `primary_fallback_generation` and
`repair_generation` stages may use up to 55 seconds before their mandatory
critic reserve is applied. An observed 25-second abort on either queued stage is
a timeout-profile regression; 25 seconds is retained only for the legacy inline
orchestrator.

The 85-second provider deadline also includes the code-pinned five-second spend
settlement reserve. Both critic transports run in parallel against the remaining
window, and a critic result finalized at or after the deadline must fail
retryably without releasing its billed reservation.

### Staging-only full writing diagnostic

Invoke `provider-transport-diagnostic` with exactly `{"only":"writing_full"}`
through the protected secret runner. The mode is staging-only and remains
excluded from every production artifact. It rejects every additional request
field, so an operator cannot substitute student or arbitrary writing content.
Authenticate the gateway with the staging publishable key in `apikey` and the
function with `PROVIDER_DIAGNOSTIC_SECRET` in `x-diagnostic-key`; load both only
inside the protected runner and never retain either value in output.

The diagnostic uses one code-pinned, fixed synthetic A2 text containing a date,
time, `z.B.`, a decimal, paragraph boundaries, and `mit die Patientin`. It calls
the same segmentation, hashing, DeepSeek Flash/Pro generation, Gemini secondary
critique, deterministic validation, adjudication, and release-projection path as
the writing worker. It performs no database, student, submission, queue, quota,
or spend-accounting write.

The response is content-free. Its exact top-level fields are `accepted`,
`safe_code`, `total_elapsed_ms`, `stages`, and
`article_form_regression_passed`; every stage contains only `stage` and
`provider`. Prompts, source or corrected writing, explanations, hashes, model
names, tokens, provider bodies, and provider errors are never returned. The
normal accepted path makes two calls: DeepSeek generation and Gemini critique.
Disagreement can add DeepSeek Pro adjudication and a Gemini final critique, with
four calls as the hard diagnostic maximum under the existing 85-second writing
deadline.

Treat the run as successful only when `accepted` and
`article_form_regression_passed` are both true. The latter proves the exact
`die` to `der` correction can pass the release projection without any summary or
explanation falsely claiming that the already-present article was missing. This
live probe supplements, but never replaces, the deterministic forced-candidate
regression that must reject that imprecise description.

Phase 13A pgTAP coverage also exercises the exhausted ordinary retry boundary:
the exact durable fallback and repair continuation IDs receive one fresh claim,
while a stale processing lease or generic retry cannot reuse the exception.
Attempt counts are never reset and remain bounded at five. Edge regressions
also prove that an attempt-four repair transition schedules its fifth claim
immediately instead of inheriting ordinary retry backoff or waiting for Cron.

## Production writing-load harness

The 20-concurrent writing harness is covered by mocked Node tests as part of
`pnpm run test:unit`. Tests verify the synchronized write barrier, normal
`api.submit_writing` and immediate-worker-kick calls, terminal-state polling,
content-free evidence, distinct actors, and fail-closed unauthorized, lost,
failed, and indefinite job paths. The test suite never contacts Supabase.

The operator command is non-mutating unless `--execute` is present:

```sh
pnpm load:writing:production -- --scenario /absolute/path/outside/git/scenario.json
```

Real execution additionally requires a new output path and
`SCHREIBEN_PRODUCTION_LOAD_CONFIRM` matching the scenario attestation ID. It is
not a CI job and must use only isolated production test accounts and dedicated
authorized immediate-feedback resources. The complete scenario, execution,
evidence, revocation, and privacy contract is in
`quality/OPERATIONS_EVIDENCE.md`. Never commit or upload the credential-bearing
scenario.

## Production rollback artifact

The production artifact is built only through the manually dispatched
`Attested production rollback artifact` workflow. That job uploads hidden
source maps to the configured Sentry release, removes every browser source-map
file, hashes the frontend, Edge Functions, and complete migration history, and
attests the resulting manifest before retaining the rollback bundle.

The manifest generator can be exercised locally against a completed production
build, but it deliberately refuses to overwrite an existing output file:

```sh
pnpm release:artifact:manifest -- \
  --release "$VITE_APP_RELEASE" \
  --frontend artifacts/german-writing-coach/dist/public \
  --edge supabase/functions \
  --migrations supabase/migrations \
  --output /absolute/private/path/release-artifact-manifest.json
```

Do not treat a local manifest as release evidence. Production requires the
GitHub provenance attestation and retained workflow artifact for the exact
deployed release.

## Local database tests

Database tests are pgTAP files under `supabase/tests/database`. They run only
against a disposable local Supabase stack:

```sh
supabase start
pnpm run test:db
supabase stop --no-backup
```

The Supabase CLI and Docker are prerequisites. Never point this command at the
linked staging or production project. The `Verify` workflow starts a fresh
stack, resets it from the complete migration history, and runs pgTAP on pull
requests and branch pushes. Manual dispatch can skip the job by leaving
`run_database_tests` disabled.

`phase_12c_overdue_scheduled_feedback_release_test.sql` deliberately invokes
the global due-release consumer and is disposable-database only. For a
transactional shared-staging check of the teacher rescue that cannot release
unrelated rows, run
`supabase/setup/phase_12c_overdue_teacher_rescue_probe.sql` through an approved
SQL runner with stop-on-error enabled. The probe uses random fixtures, calls no
global consumer, and rolls back all changes.

`phase_12d_v1_writing_input_bound_test.sql` is fully transaction-scoped: its
authenticated fixtures use unique IDs, queue assertions join only to those
fixture jobs, it performs no queue purge or global job delete, and it rolls back
all writes. This makes the contract itself safe from unrelated-row mutation,
although the normal `pnpm run test:db` suite must still run only on the
disposable local stack because other pgTAP files are intentionally destructive.

## Audit traceability

Every launch finding, its expected regression check, and verification evidence
is tracked in `docs/V1_AUDIT_TRACEABILITY.md`. A finding may be marked
`Verified` only when its automated check passes and the evidence column links
to the implementation or recorded test output.
