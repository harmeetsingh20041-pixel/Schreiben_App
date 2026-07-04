# Phase 6A DeepSeek Feedback Engine

## Goal

Phase 6A adds server-side writing feedback preparation for already-submitted writing.

The browser never calls DeepSeek directly. The frontend calls the Supabase Edge Function `prepare-writing-feedback` with the signed-in user's session. The function validates teacher access, calls DeepSeek from the server, validates strict JSON, then saves line-by-line feedback to Supabase.

## Secrets

DeepSeek secrets must be set in Supabase Edge Function secrets, not in source code:

```bash
pnpm dlx supabase secrets set DEEPSEEK_API_KEY="..."
pnpm dlx supabase secrets set DEEPSEEK_MODEL="deepseek-v4-flash"
```

Do not commit API keys, `.env.local`, or local function env files.

## Edge Function

Function name:

- `prepare-writing-feedback`

Expected request body:

```json
{ "submission_id": "uuid" }
```

Security behavior:

- requires a valid signed-in user JWT
- requires the caller to be workspace owner, workspace teacher, or platform admin
- rejects draft, empty, oversized, and currently-checking submissions
- does not let students trigger feedback preparation in Phase 6A
- treats student writing as data only
- does not log student text or secrets

## Database Writes

On success, the function writes:

- `submissions.corrected_text`
- `submissions.overall_summary`
- `submissions.level_detected`
- `submissions.status`
- `submissions.ai_model`
- `submissions.checked_at`
- `submission_lines`
- `submission_grammar_topics` when returned topics match known grammar topics
- `usage_events` with safe metadata

The migration expands:

- `submissions.status` with `checking`
- `submission_lines.status` with `acceptable_for_level`

## JSON Validation

The function requests JSON mode and validates the response before saving anything. If the response is invalid, it does not save partial line feedback and marks the submission as failed.

Accepted line statuses:

- `correct`
- `acceptable_for_level`
- `acceptable_a1_a2`
- `minor_issue`
- `major_issue`
- `unclear`

## UI Behavior

Teacher submission detail:

- shows `Prepare Feedback` when no feedback exists
- shows `Preparing feedback...` while the function runs
- shows saved line-by-line feedback after success

Student submission detail:

- shows neutral pending copy if feedback does not exist
- shows saved line-by-line feedback when it exists
- does not mention DeepSeek, model names, or AI

Demo mode keeps the existing mock feedback flow.

## Deferred

Not implemented in Phase 6A:

- automatic feedback after student submit
- delayed feedback scheduling
- OCR/photo upload
- timer/exam mode
- admin panel
- daily launch limits and cost dashboard
- full teacher override workflow
- grammar weakness stat updates from feedback
