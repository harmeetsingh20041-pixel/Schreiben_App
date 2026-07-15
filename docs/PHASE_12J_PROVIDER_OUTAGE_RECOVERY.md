# Phase 12J Provider Outage Recovery

Phase 12J keeps writing evaluation, worksheet generation, and semantic
worksheet-answer evaluation durable during a verified transient outage affecting
both configured providers. It does not turn invalid educational content,
authentication failures, configuration errors, or disabled failover into an
automatic retry loop.

## Classification contract

The worker may enter the outage lane only when the final structured error is:

- retryable;
- explicitly marked `providerOutageRecoveryEligible`; and
- classified as dual-provider unavailable, rate limited, or timed out.

The marker is set only after the primary provider has a transient availability
failure and the independent fallback provider also has a transient availability
failure. A safe-code string by itself is never sufficient. HTTP 408, 425, 429,
and 5xx are transient; HTTP 409, authentication/configuration failures,
oversized or invalid responses, validation failures, educational uncertainty,
and a disabled fallback are outside this lane.

## Bounded schedule and durability

The private recovery counter is separate from the existing three ordinary job
attempts. One outage epoch permits four delayed recoveries:

1. 1 minute
2. 5 minutes
3. 15 minutes
4. 30 minutes

The fourth delayed dispatch is the final automatic outage retry inside the
24-hour epoch. A later attempt is held as exhausted for safe operator/teacher
recovery rather than repeatedly spending against both providers.

The epoch is also capped at 24 hours. The next failure after the fourth scheduled
recovery, or any failure after the deadline, moves the job to `dead` and the
source row to its safe failed state. There is no infinite retry path.

Each transition archives the old PGMQ message, sends one delayed replacement,
and updates the canonical `async_jobs` row in one transaction. Queue payloads
contain only `job_id`, `job_kind`, `entity_id`, and `entity_version`; they never
contain writing, answers, prompts, provider output, or personal data. Replaying
the exact RPC after a lost response is idempotent. Reconciliation preserves the
future availability timestamp instead of making delayed work immediately
visible.

The sub-minute recovery consumer asks for claimable/due counts. Future delayed
messages do not create repeated no-op worker fan-out.

## Student and teacher state

Authorized read models expose only:

- `automatic_retry_at`; and
- `automatic_retry_exhausted_at`.

Student copy says that checking or worksheet preparation was delayed and gives
the next automatic retry time. It never names a provider or exposes internal
error details. Moving from retry to processing clears the delayed marker;
success clears all outage markers. Exhaustion shows a stable held/failed state
instead of an endless spinner.

Teachers retain the existing bounded manual retry controls. A retry after
outage exhaustion creates a new entity version and an immutable private audit
event containing the exact predecessor job and teacher actor. A later
non-outage failure is recorded as `terminated_non_outage`, not falsely reported
as outage exhaustion.

## Operations and evidence

`api.get_provider_outage_recovery_metrics()` reports scheduled, recovered,
exhausted, and non-outage-terminated epochs without exposing content.
`api.get_async_claimable_queue_metrics()` reports only due canonical jobs and
currently visible queue messages for worker wake-up decisions.

Production recovery wake-up uses the exact secret-free, two-schedule EU QStash
contract in
[`QSTASH_RECOVERY_SCHEDULER.md`](./QSTASH_RECOVERY_SCHEDULER.md). The schedules
carry only `{}` and a redacted recovery credential; provider-outage payloads and
student content remain in the private durable job state. The external
configuration is not launch evidence until offline list/GET validation and a
fresh live recovery heartbeat both pass.

Primary regression evidence:

- `supabase/functions/_shared/provider-outage-recovery.test.ts`
- the three worker processor test suites;
- `supabase/functions/recover-async-jobs/handler.test.ts`;
- `artifacts/german-writing-coach/tests/unit/automatic-retry-state.test.ts`;
- `supabase/tests/database/phase_12j_provider_outage_recovery_shared_probe.sql`

The database probe is rollback-only and uses fixture IDs. It never globally
claims, reads, or purges a shared queue; it touches only the exact messages made
inside its surrounding transaction.
