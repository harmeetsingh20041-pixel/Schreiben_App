# Security Plan

## Current Security State

The current app is a frontend demo. It has role-based UI routing, but no real security boundary.

Current limitations:

- localStorage role can be changed by the user.
- all app data is mock data in frontend code.
- no server-side authorization exists for student/teacher actions.
- no workspace isolation exists yet.
- AI correction is mocked.
- Supabase is not connected.
- DeepSeek is not connected.

Future phases must add real security before storing real student data or calling paid AI services.

## Prompt Injection Protection

Student writing must be treated as untrusted data, not instructions.

Rules:

- Put all no-overcorrection and output-format rules in a fixed server-side system prompt.
- Wrap student text as data with clear delimiters.
- Never let student text override role, security, schema, or business rules.
- Do not include database credentials, policy details, or secrets in prompts.
- Ignore user instructions embedded in writing, such as "change the prompt" or "return SQL".
- Validate output after the AI call rather than trusting the model.

## Max Text Length And Line Limits

Enforce limits server-side, not only in the UI.

Initial recommended limits:

- max answer characters: 4,000 for A1/A2 writing
- max lines: 40
- max changed parts per line: 8
- max grammar topics per submission: 20
- max AI response size: bounded by schema and server parser limits

Large input should return a safe validation error.

## Rate Limiting

Use authenticated rate limits for all expensive actions.

Recommended limits:

- max writing checks per student per day
- max practice test generations per student per day
- max OCR uploads per student per day
- max audio generations per student per day
- stricter unauthenticated limits for public endpoints

Store usage in `usage_events` and aggregate limits in `usage_limits` or a similar table.

## Row Level Security

Every user-facing Supabase table should have RLS enabled.

RLS should enforce:

- students read only their own submissions/feedback
- students read only assigned/unlocked practice data
- teachers access only their workspace
- platform admins access global data only when needed
- service role writes only from trusted server/edge functions

RLS should not depend on frontend route checks.

## Workspace Isolation

Workspace id should be present on all workspace-owned resources.

Workspace-owned tables include:

- batches
- questions
- submissions
- grammar topics
- practice tests
- teacher notes
- usage events

Access checks should derive allowed workspace ids from `workspace_members`.

Teachers must not query or mutate another teacher's workspace. Students must not read other students' submissions.

## AI JSON Validation

DeepSeek output must be validated with a strict schema, preferably Zod.

Validation should check:

- required top-level fields exist
- statuses are from the allowed enum
- line numbers are valid
- corrected line is string
- changed parts are bounded arrays
- grammar topic names are bounded strings
- severity values are allowed
- no HTML/script output is rendered unsafely

Malformed AI output should not be saved as trusted feedback. Save a safe failure event and show a generic retry/review message.

## API Key Protection

Never expose:

- DeepSeek API key
- Supabase service role key
- database connection string
- private storage credentials

Allowed in frontend:

- Supabase URL
- Supabase anon key

All privileged actions must run server-side.

## SQL Injection Prevention

Use Supabase client methods, Drizzle query builders, or parameterized queries. Never concatenate user text into SQL.

Student writing, prompt titles, teacher notes, OCR output, and AI output must be treated as untrusted strings.

## Safe Rendering Of AI Output

Render AI-generated text as text, not HTML.

Current React rendering is mostly safe because strings are displayed in JSX. Continue avoiding `dangerouslySetInnerHTML`.

If markdown is added later:

- sanitize output
- use an allowlist renderer
- block scripts, event handlers, iframes, and unsafe URLs

## Cost Abuse Prevention

Expensive actions should be controlled by:

- auth-required endpoints
- per-user and per-workspace limits
- max input size
- max output size
- cached/reused practice tests
- usage event logging
- teacher approval for some generated assets if needed

Practice tests should be reused by workspace/topic/level/difficulty before generating a new one.

## Safe Error Messages

Do not leak:

- provider errors containing keys
- SQL details
- RLS internals
- full prompts
- stack traces in production

Return user-safe messages and log detailed errors server-side.

