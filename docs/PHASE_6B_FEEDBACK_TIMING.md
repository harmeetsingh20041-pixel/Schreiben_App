# Phase 6B Feedback Timing Modes

> [!WARNING]
> Historical design note — superseded for V1. This document records why the
> feedback modes were introduced; it is not scheduler setup guidance. Follow
> [`PHASE_6C_SCHEDULED_FEEDBACK.md`](./PHASE_6C_SCHEDULED_FEEDBACK.md) and the
> production runbook for the current design.

## Historical contribution

Phase 6B introduced batch-level timing and server-side `timestamptz` release
times so feedback did not depend on a teacher or student keeping a browser open.
The original identifiers were:

- `teacher_review_only`: hold prepared feedback until a teacher approves and
  releases it;
- `immediate`: prepare and release validated feedback without a scheduled wait;
- `automatic_delayed`: prepare feedback privately and release it at the stored
  server-side time.

These identifiers and the timezone invariant remain useful historical context.
The original direct due-processor scheduling proposal does not.

## Current V1 behavior

- Immediate feedback is created through the durable writing-evaluation queue
  and released only after validation.
- Scheduled feedback is evaluated privately as soon as possible and released
  by `release-due-feedback-every-30-seconds` when it is due.
- Teacher-review feedback is evaluated privately, remains held, and is released
  only through the teacher approval flow.
- Invalid or uncertain feedback retries once with the configured Pro model and
  otherwise remains held for teacher review.

Submission creation and the queue message are transactional. Immediate Edge
kicks start work promptly; queue leases, bounded retries, and reconciliation
provide recovery. No browser request or database schedule contains provider
credentials or student writing.

## Current scheduling and recovery

Migration `20260710191319_install_queue_recovery_cron.sql` installs fixed,
secret-free private SQL reconciliation jobs and the scheduled-release job.
An external scheduler POSTs an empty body to `/functions/v1/recover-async-jobs`
every 30 seconds with the recovery secret; production preflight requires its
heartbeat to be fresh. That external cycle also runs the bounded scheduled-
release sweep, so database Cron is not the only way due validated feedback can
reach a terminal released state.

Do not manually invoke a feedback processor with a copied secret, create a
Vault scheduler secret, install a database HTTP extension, or run the retired
Phase 6C setup file. The read-only production preflight must prove the exact
Cron commands and the absence of the retired network extension before launch.
