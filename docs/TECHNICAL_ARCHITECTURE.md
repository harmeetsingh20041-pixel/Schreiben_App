# Technical Architecture

## Current Repo Architecture

This repository is a pnpm workspace.

Workspace packages:

- `artifacts/german-writing-coach`: main React/Vite frontend app.
- `artifacts/api-server`: minimal Express API server.
- `artifacts/mockup-sandbox`: separate Vite mockup sandbox.
- `lib/api-spec`: OpenAPI source and Orval config.
- `lib/api-client-react`: generated React Query API client.
- `lib/api-zod`: generated Zod schemas.
- `lib/db`: Drizzle/Postgres package placeholder.
- `scripts`: utility scripts.

Root scripts:

- `pnpm run typecheck`: builds TypeScript project references and typechecks artifacts/scripts.
- `pnpm run build`: runs typecheck and package build scripts.
- `pnpm --filter @workspace/api-spec run codegen`: regenerates generated API clients/schemas.
- `pnpm --filter @workspace/db run push`: pushes Drizzle schema changes.

## Current Frontend Architecture

Main app path: `artifacts/german-writing-coach`.

Framework and libraries:

- React 19
- Vite 7
- TypeScript
- Tailwind CSS v4 via `@tailwindcss/vite`
- Shadcn/Radix-style UI components in `src/components/ui`
- Wouter routing
- TanStack React Query installed but not yet used for real app data
- Framer Motion installed
- Lucide React icons

Important files:

- `src/main.tsx`: React entrypoint.
- `src/App.tsx`: router, providers, protected routes.
- `src/index.css`: theme and global styling.
- `src/lib/auth.tsx`: demo role auth using localStorage.
- `src/components/layout.tsx`: role-based navigation shell.
- `src/components/submission-review.tsx`: central correction results UI.
- `src/data/mockData.ts`: questions, batches, students, submissions, AI response, grammar info, and practice exercises.
- `src/services/aiCorrectionService.ts`: mock AI check service.
- `src/services/supabaseService.ts`: placeholder service, not connected to Supabase.
- `src/types/index.ts`: current frontend domain types.

## Current Routes

Public:

- `/`
- `/login`

Student:

- `/student/dashboard`
- `/student/questions`
- `/student/write`
- `/student/practice`
- `/student/result/:id`
- `/student/history`
- `/student/submission/:id`

Teacher:

- `/teacher/dashboard`
- `/teacher/batches`
- `/teacher/students`
- `/teacher/questions`
- `/teacher/submissions`
- `/teacher/submission/:id`

Protection today is frontend-only. `ProtectedRoute` checks the local demo role from `useAuth`. It is not security.

## Current State Management

Current state is mostly local React state and mock imports:

- Auth role is stored in localStorage key `gwc_role`.
- Questions, batches, students, submissions, AI response, grammar topics, and practice exercises come from `src/data/mockData.ts`.
- Teacher question edits live only in page state.
- Teacher note save is simulated in `SubmissionReview`.
- Writing check is simulated by `checkWriting`, which returns `MOCK_AI_RESPONSE`.

No real persistence exists yet.

## Current API / Backend Architecture

`artifacts/api-server` is an Express 5 app with:

- Pino HTTP logging.
- CORS enabled.
- JSON/urlencoded body parsing.
- `/api/healthz` route.
- Zod validation for health response via `@workspace/api-zod`.

There is not yet an endpoint for auth, submissions, DeepSeek, grammar stats, questions, batches, or teacher notes.

`lib/api-spec/openapi.yaml` currently only documents `/healthz`.

`lib/db/src/schema/index.ts` is a placeholder with no real tables.

## Proposed Backend Architecture

Use Supabase for Auth, Postgres, RLS, and possibly Storage later. Keep business-sensitive operations server-side.

Recommended service boundaries:

- Frontend:
  - renders current UI
  - holds temporary form state
  - calls authenticated data APIs
  - never holds DeepSeek API key
  - never uses Supabase service role key

- Supabase:
  - Auth sessions
  - Postgres tables
  - RLS for workspace isolation
  - optional Storage for OCR uploads later

- Server endpoint or Supabase Edge Function:
  - validates user/session
  - enforces input limits
  - checks workspace access
  - calls DeepSeek V4 Flash
  - validates AI JSON with Zod
  - writes submissions, lines, grammar stats, usage events
  - applies rate limits and cost controls

The current Express API package can host these endpoints if deployment includes a Node server. If deploying static frontend plus Supabase Edge Functions, the Express package may remain as local/dev or be retired later.

## Supabase Integration Plan

Phase 2 should add foundation only:

1. Add environment variable examples for Supabase URL and anon key.
2. Add a small Supabase browser client wrapper.
3. Add server/edge-only notes for service role usage.
4. Draft migrations and RLS policies.
5. Keep current UI and mock data unchanged until Phase 3/4.

Phase 3 should replace localStorage demo auth with Supabase Auth.

Phase 4/5 should replace mock questions, batches, students, and submissions with real Supabase data.

Phase 2 implementation now includes:

- `artifacts/german-writing-coach/src/lib/supabaseClient.ts`
- `artifacts/german-writing-coach/src/types/database.ts`
- `supabase/migrations/202607040001_initial_schema.sql`
- `supabase/seed.sql`
- `docs/SUPABASE_FOUNDATION.md`

The Supabase client intentionally returns `null` when frontend-safe env vars are missing, so the current mock demo still runs without a Supabase project.

## DeepSeek Integration Plan

DeepSeek should be connected only after submissions are persisted and authorization is real.

Recommended endpoint:

- `POST /api/writing/check`

Request should include:

- authenticated user/session
- workspace id or derived workspace context
- optional question id
- student answer text

Server should:

1. Verify user is a student in the workspace.
2. Enforce max answer length and max line count.
3. Treat student text as data, not prompt instructions.
4. Build a fixed no-overcorrection system prompt.
5. Call DeepSeek V4 Flash.
6. Validate response against a strict Zod schema.
7. Reject malformed JSON safely.
8. Persist submission, lines, grammar topics, and usage events.
9. Return normalized result to frontend.

## Future AI JSON Contract

The planned shape should include:

- `overall_summary`
- `level_detected`
- `score_summary`
- `grammar_topics`
- `lines`

Current frontend `AIResponse` should later be expanded to include `score_summary`, `grammar_topics`, and `detailed_explanation` if the UI needs them. Do this carefully so `SubmissionReview` keeps its current appearance.

## Hosting Considerations

The frontend is a Vite app and builds static files to `artifacts/german-writing-coach/dist/public`.

Current Vite config requires:

- `PORT`
- `BASE_PATH`

For local development, use `PORT=5173 BASE_PATH=/`.

For static hosting, `BASE_PATH=/` is likely appropriate unless deploying under a subpath.

Netlify and Vercel can both host the static Vite frontend. Based on the current repo:

- Netlify is a natural fit if the app remains a static Vite frontend plus Supabase/Edge Functions.
- Vercel is also viable for static hosting, but the repo is not a Next.js app.
- If keeping the Express API server as a deployed backend, use a platform that supports the Node server separately, or split frontend hosting from backend deployment.

Do not decide final hosting until Phase 12. Phase 2-6 architecture should avoid platform lock-in.

## Future OCR / Image Upload Fit

OCR should be added after auth, storage, and submissions exist.

Recommended flow:

1. Student uploads image.
2. Server validates file type and size.
3. File is stored in workspace-scoped storage if needed.
4. OCR service extracts text.
5. Student edits extracted text.
6. Edited text goes through normal writing submission flow.

OCR output should never be submitted directly without student review.

## Future Audio Fit

Audio/listening should be a separate service boundary after core correction is stable.

Possible uses:

- play corrected sentence
- play simple explanation
- teacher-reviewed audio support later

Audio generation should be rate-limited and optionally cached.
