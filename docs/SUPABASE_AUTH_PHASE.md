# Supabase Auth Phase

Phase 3 adds the auth foundation while keeping the existing demo UI available.

## Implemented

- Safe auth service functions for email/password sign in, sign up, sign out, session lookup, user lookup, and auth-state subscriptions.
- Auth provider state for loading, Supabase user, profile, workspace memberships, app role, and workspace onboarding need.
- Login page email/password wiring when Supabase env vars exist.
- Demo student and teacher buttons remain available.
- Teacher onboarding route for creating the first workspace.
- Database hardening migration:
  - Auth user trigger creates a profile automatically.
  - New profiles default to `student`.
  - User metadata is used only for display/account intent, not database authorization.
  - Browser users cannot update their own `global_role`.
  - Workspace owner membership is created through `create_teacher_workspace`.
  - Workspace members cannot self-promote to owner.
- Advisor follow-up migrations:
  - Fixed the mutable search path warning on `set_updated_at`.
  - Revoked exposed execution for `rls_auto_enable` when present.
  - Moved privileged helper logic into the non-exposed `app_private` schema.
  - Split broad `FOR ALL` RLS policies into explicit insert/update/delete policies.
  - Allowed the trusted onboarding RPC to create the first owner membership while direct client owner inserts stay blocked.
- Live Supabase TypeScript types generated into `artifacts/german-writing-coach/src/types/supabase.ts`.
- Supabase project migrations applied to project `vzcgalzspdehmnvqczfw`.
- Grammar topic seed data applied to the linked project.

## Intentionally Not Implemented

- DeepSeek calls.
- OCR.
- Audio.
- Generated grammar practice tests.
- Replacement of mock batches, questions, students, submissions, or writing corrections.
- Service role usage in the frontend.

## Mock Fallback

If `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing, the Supabase client returns `null`. The app stays in demo mode and the existing student/teacher demo buttons continue to work.

The local `.env.local` now uses the project URL and a frontend publishable key. The file is ignored and must not be committed.

## First Teacher Workspace

1. Add `artifacts/german-writing-coach/.env.local` with the project URL and publishable/anon key.
2. Start the app.
3. Create a teacher account from the login page.
4. If the Supabase project requires email confirmation, confirm the email first, then sign in.
5. The app routes teachers with no workspace to `/teacher/onboarding`.
6. Create the workspace. The database function creates the workspace and owner membership together.

## Verification

- Linked project migration history matches local migrations through `20260704085609`.
- `public.grammar_topics` contains 10 seed rows.
- Auth/profile hardening triggers exist in the remote database.
- Live teacher login passed after manual email confirmation for `phase3.teacher.20260704.authcheck@gmail.com`.
- Teacher onboarding created `Phase 3 Test Workspace`, inserted an `owner` membership, and redirected to `/teacher/dashboard`.
- Sign out/sign in passed after workspace creation; the teacher returned to `/teacher/dashboard` instead of onboarding.
- Student signup smoke was blocked by Supabase email rate limiting before account creation; no student test rows were created.
- Rolled-back RLS probes confirmed profile role updates are blocked, direct owner membership creation is blocked, and `create_teacher_workspace` works.
- Supabase security advisors report one project-level Auth warning: leaked password protection is disabled.
- Supabase performance advisors report no issues.

## Phase 4 Recommendation

Phase 4 should replace mock batches, questions, students, and submissions with real Supabase queries gradually. Keep the writing correction flow mocked until DeepSeek integration is designed and secured.
