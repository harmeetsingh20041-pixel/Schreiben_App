# Supabase Foundation

## Phase 2 Status

Phase 2 prepares the app for Supabase without connecting the approved frontend demo to real auth or data yet.

Implemented:

- Supabase JavaScript client dependency in `@workspace/german-writing-coach`.
- Frontend-safe environment examples.
- Non-crashing Supabase client utility.
- App-level TypeScript database interfaces.
- Initial SQL schema migration.
- Initial RLS policies and helper functions.
- Idempotent grammar topic seed SQL.

Intentionally not implemented:

- real Supabase Auth login
- replacing localStorage demo role auth
- replacing mock data in pages
- DeepSeek API calls
- Edge Functions
- OCR
- audio/listening
- real credentials

## Environment Variables

Frontend-safe Vite variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Current local Vite config also requires:

- `PORT`
- `BASE_PATH`

Future server-only variables:

- `SUPABASE_SERVICE_ROLE_KEY`
- `DEEPSEEK_API_KEY`

Never put server-only variables in browser code. Never prefix service-role or DeepSeek keys with `VITE_`.

Env example files:

- Root example: `.env.example`
- Frontend example: `artifacts/german-writing-coach/.env.example`

## Supabase Client

Client utility:

- `artifacts/german-writing-coach/src/lib/supabaseClient.ts`

The client returns `null` when `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing. This is intentional so Phase 2 does not require a Supabase project and the mock frontend keeps working.

Current placeholder service:

- `artifacts/german-writing-coach/src/services/supabaseService.ts`

Real auth/data calls should be added in Phase 3/4.

## Migration Files

Initial schema:

- `supabase/migrations/202607040001_initial_schema.sql`

Seed/reference data:

- `supabase/seed.sql`

The seed file is idempotent and inserts these grammar topics:

- Articles
- Dativ
- Akkusativ
- Verb position
- Perfekt
- Prepositions
- Word order
- Conjugation
- Spelling
- Sentence structure

## Tables Prepared

- `profiles`
- `workspaces`
- `workspace_members`
- `batches`
- `batch_students`
- `questions`
- `grammar_topics`
- `submissions`
- `submission_lines`
- `submission_grammar_topics`
- `student_grammar_stats`
- `practice_tests`
- `practice_test_questions`
- `practice_test_attempts`
- `teacher_notes`
- `usage_events`

## RLS Concept

RLS is enabled on all user-facing tables in the initial migration.

Helper functions:

- `is_platform_admin()`
- `is_workspace_member(workspace_id)`
- `has_workspace_role(workspace_id, roles)`

Security notes:

- Helper functions use `security definer` with explicit `search_path`.
- Function execute grants are revoked from `public` and `anon`.
- Policies use `TO authenticated` plus row ownership/workspace predicates.
- Students can read their own profile, memberships, submissions, lines, stats, available practice tests, and attempts.
- Teachers can manage data inside their own workspace.
- Platform admins can access everything.
- Service-role operations remain server-side in future phases.

## Creating A Supabase Project Later

Recommended later workflow:

1. Create a Supabase project.
2. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to local env.
3. Keep `SUPABASE_SERVICE_ROLE_KEY` only in server or Edge Function environments.
4. Apply migrations with Supabase CLI or dashboard SQL editor.
5. Apply `supabase/seed.sql` for grammar topics.
6. Verify RLS policies before connecting UI pages to real data.
7. Generate official Supabase database types only after the project exists.

## Hosting Note

The current frontend is a Vite static app, not Next.js.

Netlify is a natural fit for static Vite hosting plus Supabase/Edge Functions. Vercel is also viable for static Vite output, but this repo does not currently use Vercel-specific framework features. Final hosting should be decided in Phase 12 after auth, storage, API/Edge Function strategy, environment variables, and preview workflows are clear.

Required hosting env vars for the frontend will include:

- `BASE_PATH=/`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Server/Edge environments will later need:

- `SUPABASE_SERVICE_ROLE_KEY`
- `DEEPSEEK_API_KEY`

## Next Phase

Phase 3 should connect real Supabase Auth and roles while preserving the current visual UI.

Recommended Phase 3 tasks:

- replace demo localStorage role with Supabase session state
- create profile on first login/signup
- resolve workspace membership
- protect routes using real role data
- keep mock content available as fallback until Phase 4

