# Phase 6B Feedback Timing Modes

Phase 6B adds batch-level feedback timing without changing the DeepSeek feedback prompt or exposing secrets to the browser.

## Batch Modes

- `teacher_review_only`: safest default. Submissions are saved and teachers manually prepare feedback.
- `immediate`: submissions are due for feedback immediately and are processed by the due-feedback processor.
- `automatic_delayed`: submissions get a randomized server-side `feedback_scheduled_at` between the batch minimum and maximum delay.

Delay scheduling uses Postgres/server time and stores `feedback_scheduled_at` as `timestamptz`, so it does not rely on the student or teacher browser timezone.

## Edge Functions

- `prepare-writing-feedback`: teacher-triggered feedback preparation.
- `process-due-feedback`: secret-protected processor for due `immediate` and `automatic_delayed` submissions.

`process-due-feedback` requires one Edge Function secret:

```bash
pnpm dlx supabase secrets set PROCESS_FEEDBACK_SECRET="..."
```

Do not commit or print the secret.

## Scheduling

Automatic delayed feedback requires a trusted scheduled invocation of `process-due-feedback`. Until a scheduler is configured, the function can be invoked manually with the secret header for testing.

Supabase-hosted scheduling can be configured with `pg_cron` plus `pg_net`, ideally storing the function URL and secret in Supabase Vault. The scheduled request should call the function every minute or every few minutes, with a small batch size, and include either:

- `Authorization: Bearer <PROCESS_FEEDBACK_SECRET>`
- or `x-process-feedback-secret: <PROCESS_FEEDBACK_SECRET>`

The processor only handles a small batch per run and the feedback function atomically marks a submission as `checking` before calling DeepSeek, preventing duplicate processing.
