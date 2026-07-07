# V1 Launch Runbook

This runbook is for launch hardening and incident response. Do not store secrets in this file.

## Environment Variables

Frontend, browser-safe:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_ENABLE_DEMO_MODE=false` for production
- `VITE_ENABLE_PUBLIC_TEACHER_SIGNUP=false` unless public teacher signup is intentionally open
- `VITE_ENABLE_PUBLIC_STUDENT_SIGNUP=true` only if student self-signup is intended
- `VITE_SENTRY_DSN`
- `VITE_SENTRY_ENVIRONMENT`
- `VITE_APP_RELEASE`
- `VITE_SENTRY_ENABLE_REPLAY=false` by default

Server/CI only:

- `SUPABASE_SERVICE_ROLE_KEY`
- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`
- `PROCESS_FEEDBACK_SECRET`
- `SENTRY_AUTH_TOKEN`
- `SENTRY_ORG`
- `SENTRY_PROJECT`

Never expose service-role keys, provider keys, auth tokens, prompts, student answers, or feedback payloads through Vite.

## Supabase Pro Checklist

- Upgrade the launch project to Supabase Pro before real production traffic.
- Enable leaked password protection in Supabase Auth.
- Review backup retention and decide whether PITR is needed before paid launch.
- Confirm Auth email templates and redirect URLs point to the correct production domain.
- Confirm RLS is enabled on user-facing tables.
- Keep service-role operations inside Edge Functions after caller permissions are verified.

## Migration Checklist

Before deploy:

- Pull latest `main`.
- Confirm `supabase migration list --linked` has no drift.
- Run `supabase db lint --linked`.
- Read any migration that touches Auth, RLS, or destructive DDL.
- Never run cleanup/delete SQL without explicit approval and a backup plan.

Deploy:

- Push migrations first.
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

Deploy only changed functions unless a shared module changes. If `supabase/functions/_shared/writing-feedback.ts` changes, redeploy all functions that import it.

## Sentry Setup

Use a dedicated frontend Sentry project.

- Set `VITE_SENTRY_DSN` in deployment env.
- Set `VITE_SENTRY_ENVIRONMENT=production`.
- Set `VITE_APP_RELEASE` to the git commit or release tag.
- Keep `sendDefaultPii=false`.
- Keep Replay disabled by default. If enabled, use privacy-safe settings: mask all text, mask all inputs, block media, and low error-only sampling.
- Upload source maps from CI only with `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT`.
- Do not publish source maps publicly unless that is explicitly accepted.

## Smoke Test Checklist

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
- Join batch only if testing invite flow.
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
- Demo shortcuts should be hidden unless `VITE_ENABLE_DEMO_MODE=true`.

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
