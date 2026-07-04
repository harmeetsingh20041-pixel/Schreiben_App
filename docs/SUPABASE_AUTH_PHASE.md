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

## Intentionally Not Implemented

- DeepSeek calls.
- OCR.
- Audio.
- Generated grammar practice tests.
- Replacement of mock batches, questions, students, submissions, or writing corrections.
- Service role usage in the frontend.

## Mock Fallback

If `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is missing, the Supabase client returns `null`. The app stays in demo mode and the existing student/teacher demo buttons continue to work.

## First Teacher Workspace

1. Add `artifacts/german-writing-coach/.env.local` with the project URL and publishable/anon key.
2. Start the app.
3. Create a teacher account from the login page.
4. If the Supabase project requires email confirmation, confirm the email first, then sign in.
5. The app routes teachers with no workspace to `/teacher/onboarding`.
6. Create the workspace. The database function creates the workspace and owner membership together.

## Phase 4 Recommendation

Phase 4 should replace mock batches, questions, students, and submissions with real Supabase queries gradually. Keep the writing correction flow mocked until DeepSeek integration is designed and secured.
