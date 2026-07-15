# QStash Recovery Scheduler

This is the V1 external wake-up contract for `recover-async-jobs`. It is a
recovery path; authenticated immediate kicks remain the primary job-start path.
The schedule request contains only `{}` and never contains student writing,
worksheet answers, prompts, or provider output.

Each accepted cycle reconciles the three durable queues, wakes only claimable
work, and runs a service-only bounded sweep for due validated scheduled
feedback. Database Cron still performs the same release sweep every 30 seconds,
but is no longer its only recovery path. The endpoint withholds its success
heartbeat if either queue recovery or the scheduled-release sweep fails.

The checked-in tooling is deliberately offline. It can build a reviewable plan,
render provisioning/readback/deletion commands, and validate already-redacted
API responses. It never reads environment secrets, calls QStash, creates a
schedule, or deletes a schedule itself.

## Accepted production design

- Provider: Upstash QStash in `eu-central-1`.
- Endpoint: `https://qstash-eu-central-1.upstash.io`.
- Destination:
  `https://<production-project-ref>.supabase.co/functions/v1/recover-async-jobs`.
- Schedule 1: `* * * * *`, no delivery delay.
- Schedule 2: `* * * * *`, 30-second delivery delay.
- Effective maximum planned wake-up gap: 30 seconds.
- Deterministic IDs:
  - `schreiben-v1-recovery-<project-ref>-minute-00`
  - `schreiben-v1-recovery-<project-ref>-minute-30`
- Method/body: `POST` with exact `application/json` body `{}`.
- Delivery timeout: 10 seconds.
- Retries: two, with `1000 * (1 + retried)` retry delay (1 second, then
  2 seconds).
- Authentication: QStash forwards `x-process-recovery-secret` from the
  operator's in-memory `PROCESS_RECOVERY_SECRET` shell variable.
- Redaction: `header[x-process-recovery-secret]`; list and GET responses must
  show exactly one `REDACTED:<SHA256>` value for that header.
- No callback or failure callback.

QStash cron resolution is one minute, so the 30-second recovery cadence is
implemented as two one-minute schedules with the second delivery delayed by
30 seconds. Duplicate recovery wake-ups are safe because the recovery handler
uses idempotent queue claims and returns quickly with `202` while work continues
through `waitUntil`.

## Billing gate

The Free plan is not accepted for launch. Two schedules triggering every minute
produce a baseline of:

```text
2 schedules * 1,440 minutes/day = 2,880 deliveries/day
```

That exceeds the Free allowance of 1,000 messages/day before any retry. A paid
`pay_as_you_go`, `fixed`, or `enterprise` plan is mandatory evidence. At the
currently documented pay-as-you-go rate of USD 1 per 100,000 messages, the
baseline is 86,400 messages per 30-day month, or approximately USD 0.86/month.
Every retry delivery is billed separately, so this estimate is informational
and never a release gate.

## 1. Review the secret-free plan

Do this only after the clean production project ref is final:

```bash
pnpm qstash:recovery -- \
  --mode plan \
  --project-ref "$PRODUCTION_PROJECT_REF"
```

Review the region, destination, deterministic IDs, exact offsets, body, timeout,
retry controls, and contract SHA-256. The output contains environment-variable
names only, not their values.

## 2. Render the provisioning commands

```bash
pnpm qstash:recovery -- \
  --mode provision-commands \
  --project-ref "$PRODUCTION_PROJECT_REF"
```

This prints two `curl` commands but does not execute them. A release operator
must compare them with
`config/qstash-recovery-schedules.contract.json`, confirm that the QStash
account is in the EU region on an accepted paid plan, and then run the reviewed
commands from a restricted shell.

Set `QSTASH_TOKEN` and `PROCESS_RECOVERY_SECRET` only in that shell. Do not put
either value in a command-line argument, file, repository, ticket, chat, shell
history, build log, or operations evidence. The recovery secret must match the
already-deployed Supabase Edge secret.

Important: a deterministic-ID create request updates an existing schedule. A
redacted schedule must always be updated with the original secret value from
`PROCESS_RECOVERY_SECRET`; never copy a `REDACTED:<SHA256>` readback value into
an update request.

## 3. Capture list and individual GET readback

Choose a restricted temporary directory and render the read-only commands:

```bash
export QSTASH_READBACK_DIR="$(mktemp -d)"
chmod 700 "$QSTASH_READBACK_DIR"

pnpm qstash:recovery -- \
  --mode readback-commands \
  --project-ref "$PRODUCTION_PROJECT_REF"
```

Run the printed GET commands. They capture one list response and one individual
GET response for each deterministic ID. Confirm manually that no unredacted
header value is present before doing anything else with the files.

Create a temporary verification envelope with exactly this shape:

```json
{
  "schema_version": 1,
  "project_ref": "abcdefghijklmnopqrst",
  "billing_plan": "pay_as_you_go",
  "provisioning_plan_applied": true,
  "tested_at": "2026-07-11T20:00:00.000Z",
  "evidence_id": "qstash-change-ticket-opaque-id",
  "list_response": [],
  "individual_readbacks": []
}
```

`provisioning_plan_applied` is a human attestation, backed by the restricted
change record, that the exact reviewed commands from the current contract were
run. This matters because the QStash list/GET response schema exposes retries,
delay, and retry-delay expression but does not expose the request timeout.
Preflight binds that attestation to the current contract SHA-256 and still
verifies every control that QStash does return independently.

`list_response` is the complete parsed list response.
`individual_readbacks` contains the two parsed GET objects. `billing_plan` is a
human attestation to the restricted provider billing record; `free` is rejected.
Use an opaque evidence ID, never a URL, token, secret, student identifier, or
free-form log.

Validate offline and write the sanitized evidence with owner-only permissions:

```bash
pnpm qstash:recovery -- \
  --mode verify \
  --project-ref "$PRODUCTION_PROJECT_REF" \
  --input "$QSTASH_READBACK_DIR/verification-input.json" \
  --evidence-output "$QSTASH_READBACK_DIR/external-scheduler-evidence.json"
```

The validator fails closed unless both deterministic IDs appear exactly once in
the list and once in individual GET readback, both are active, the destination,
cron, method, body, delays, retries, and retry expression match, the recovery
header is redacted, and no forwarded Authorization header or callback exists.
The emitted evidence contains booleans, IDs, fixed controls, hashes, and an
opaque evidence reference only. It never retains the redacted header hash.

Embed that exact object as `external_scheduler` in schema-version 4
`PRODUCTION_OPERATIONS_EVIDENCE_JSON`. Production preflight also requires a
fresh successful recovery heartbeat from the actual Edge destination; provider
configuration readback alone cannot pass launch.

The function's structured operational log includes
`scheduled_release_failures` and `scheduled_feedback_released`. Alert on any
non-zero failure value and on a stale heartbeat. The released count is an
aggregate only; logs must never include submission IDs, student identities, or
feedback content.

Delete the restricted temporary readback files according to the approved
operations retention policy after the release evidence has been recorded.

## 4. Rollback and deletion

Render the two deterministic deletion commands:

```bash
pnpm qstash:recovery -- \
  --mode rollback-commands \
  --project-ref "$PRODUCTION_PROJECT_REF"
```

The tool does not execute them. After an approved rollback, run both reviewed
DELETE requests and list schedules again to prove that both IDs are absent.
Deleting a schedule stops future triggers but does not cancel messages already
created by an earlier trigger. If immediate credential invalidation is required,
rotate `PROCESS_RECOVERY_SECRET` through the separately approved Supabase secret
rotation procedure and redeploy/verify the recovery function before restoring
the schedules.

Never delete schedules by a broad label, prefix search, or account-wide cleanup.
Only the two exact project-bound deterministic IDs are in scope.
