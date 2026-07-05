# Phase 6C Scheduled Feedback Processing

Phase 6C makes automatic delayed feedback work without the student keeping the website open. Supabase Cron calls the existing `process-due-feedback` Edge Function on a trusted server-side schedule.

## Production Schedule

- Cron job: `process-due-feedback-every-5-minutes`
- Frequency: every 5 minutes (`*/5 * * * *`)
- Function: `https://vzcgalzspdehmnvqczfw.supabase.co/functions/v1/process-due-feedback?limit=3`
- Batch size: maximum 3 submissions per scheduled invocation
- Secret header: `x-process-feedback-secret`

The Edge Function still filters for due rows only:

- `status = submitted`
- `feedback_mode in (immediate, automatic_delayed)`
- `feedback_scheduled_at <= now()`

Already checked submissions are not selected again.

## Extensions

The scheduler uses:

- `pg_cron` for recurring database-side scheduling
- `pg_net` for the HTTP request to the Edge Function
- Supabase Vault for the scheduler secret

The migration `20260705100305_phase_6c_scheduled_feedback_processing.sql` enables only `pg_cron` and `pg_net`. It does not store URLs, headers, or secret values.

## Secret Storage

Keep one process secret:

```bash
PROCESS_FEEDBACK_SECRET
```

The same value must exist in two places:

- Supabase Edge Function secrets as `PROCESS_FEEDBACK_SECRET`
- Supabase Vault as `process_due_feedback_secret`

Do not store the value in source control, docs, `.env.local`, migrations, shell history, or frontend code. If the current secret cannot be retrieved safely, rotate it by generating a new random value locally, setting it as the Edge Function secret, and writing that same value into Vault without printing it.

## Setup SQL

The secret-free scheduler setup lives at:

```text
supabase/setup/phase_6c_schedule_due_feedback.sql
```

It is safe to rerun. It:

- checks that Vault contains `process_due_feedback_secret`
- unschedules any existing job named `process-due-feedback-every-5-minutes`
- schedules the five-minute cron job again

To disable the scheduler:

```sql
select cron.unschedule('process-due-feedback-every-5-minutes');
```

To list scheduled jobs:

```sql
select jobid, jobname, schedule, active
from cron.job
order by jobid;
```

To inspect recent runs:

```sql
select jobid, job_pid, database, username, command, status, return_message, start_time, end_time
from cron.job_run_details
order by start_time desc
limit 20;
```

To inspect recent HTTP responses from `pg_net`:

```sql
select id, status_code, content, created
from net._http_response
order by created desc
limit 20;
```

## Timezone Behavior

Scheduling uses Postgres/server timestamps. `feedback_scheduled_at` is stored as `timestamptz` and compared with server-side `now()`, so processing does not depend on the student or teacher browser timezone. This is important for teachers in Germany and students in India.

The UI may show relative labels like "Due in 42 minutes" or "Feedback ready", but backend due checks remain UTC-safe.

## Student Wording

Student-facing UI should continue to use neutral wording:

- Feedback is being prepared.
- Feedback ready.
- Check back later.
- Waiting for review.
- Line-by-line feedback.

Do not show "AI", "DeepSeek", "model", or "automatic AI correction" in student-facing screens.

## Cost And Safety

- The scheduled due processor handles at most 3 submissions per invocation. The Edge Function still caps ad hoc requests at 5.
- Checked submissions are filtered out before processing.
- `prepare-writing-feedback` atomically marks a submission as `checking`, which prevents duplicate processing during overlapping invocations.
- Keep batch defaults conservative: `teacher_review_only`, 15 to 180 minutes.
- Do not lower production delays globally without a launch decision.
- Monitor Edge Function logs, `cron.job_run_details`, and `net._http_response` after enabling the job.

## Known Limitations

- There is no notification bell or read/unread feedback notification table yet.
- Phase 6C does not add timer/exam mode, OCR/photo upload, admin tools, or daily usage limits.
- Production monitoring and cost dashboards are still future work.
