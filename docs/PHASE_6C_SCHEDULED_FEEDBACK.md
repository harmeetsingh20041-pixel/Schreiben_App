# Phase 6C Scheduled Feedback Processing

Scheduled feedback no longer depends on an outbound database request. Writing
evaluation is queued immediately and prepared privately. At the due time, one
secret-free database Cron command atomically releases only feedback that is
eligible for release.

## Current production design

Migrations `20260710191319_install_queue_recovery_cron.sql` and
`20260712010300_phase_12v_ai_spend_reservation_reconciliation.sql` install five
30-second jobs as part of normal migration replay:

- `reconcile-writing-jobs-every-30-seconds`
- `reconcile-worksheet-generation-every-30-seconds`
- `reconcile-worksheet-evaluation-every-30-seconds`
- `reconcile-ai-spend-reservations-every-30-seconds`
- `release-due-feedback-every-30-seconds`

The release job executes only:

```sql
select app_private.release_due_feedback_internal(100);
```

The reconciliation jobs likewise execute fixed `app_private` SQL functions.
The AI-spend job executes only:

```sql
select app_private.reconcile_expired_ai_spend_reservations_internal(100, null);
```

They contain no URL, request header, or production secret. The final launch
preflight verifies each job's exact command, 30-second cadence, database, and
execution role.

Immediate Edge kicks remain the primary processing path. Configure the two
project-bound EU QStash schedules specified in
[`QSTASH_RECOVERY_SCHEDULER.md`](./QSTASH_RECOVERY_SCHEDULER.md). Both trigger
every minute; the second delivery is delayed by 30 seconds. Each posts an empty
JSON object to `/functions/v1/recover-async-jobs` with the redacted forwarded
`x-process-recovery-secret` header. The request contains no student writing or
worksheet answers. In addition to reconciling and waking the three queues,
each authenticated recovery cycle invokes the same bounded, row-locked
scheduled-release and expired AI-spend reservation sweeps as database Cron. A
heartbeat is recorded only after queue recovery and both independent sweeps
succeed. Production preflight rejects the Free plan, missing or drifted
schedule readback, a missing or stale live recovery heartbeat, and any
validated scheduled feedback still overdue after 60 seconds.

## Retired setup entry point

`supabase/setup/phase_6c_schedule_due_feedback.sql` is intentionally a
fail-closed sentinel. Running it raises an error and changes nothing. Do not
replace migration replay with that setup file, do not create a Vault copy of a
feedback-processing secret, and do not install a database HTTP extension.

The complete migration history removes `pg_net`; production preflight must
independently prove that it remains absent. A clean production project is
configured only by replaying the checked-in migrations and by configuring the
external recovery scheduler described above.

## Verification

Inspect the current schedules:

```sql
select jobid, jobname, schedule, command, database, username, active
from cron.job
where jobname in (
  'reconcile-writing-jobs-every-30-seconds',
  'reconcile-worksheet-generation-every-30-seconds',
  'reconcile-worksheet-evaluation-every-30-seconds',
  'reconcile-ai-spend-reservations-every-30-seconds',
  'release-due-feedback-every-30-seconds'
)
order by jobname;
```

Inspect recent database runs:

```sql
select jobid, status, return_message, start_time, end_time
from cron.job_run_details
order by start_time desc
limit 20;
```

Then run the read-only production preflight. It must prove all five commands, a
fresh external queue, release, and AI-spend recovery heartbeat, zero validated
releases overdue beyond 60 seconds, healthy queues, and absence of the retired
network extension before launch.

## Release semantics and time zones

`feedback_scheduled_at` is a `timestamptz` compared with server-side `now()`.
Release therefore does not depend on the teacher's or student's browser time
zone. A draft that is partial, invalid, uncertain, failed, or awaiting teacher
review remains held even when its scheduled time has passed.

Student-facing wording stays provider-neutral: feedback is being prepared,
ready, scheduled, held, or waiting for review. Provider names, internal model
states, database errors, and queue details are never student-facing.
