# Phase Roadmap

## Phase 0: Product And Architecture Onboarding

Goal: Understand the app purpose, existing frontend, and future requirements.

Implemented: Documentation of product purpose, users, correction philosophy, and future architecture assumptions.

Not implemented yet: Supabase, DeepSeek, OCR, audio, real auth, real persistence.

Testing requirement: No runtime behavior changes expected. Run repo checks after documentation and setup changes.

Expected output: Clear product context and shared vocabulary for future phases.

## Phase 1: Repo Audit And Integration Plan

Goal: Inspect the existing frontend and prepare the project without breaking the approved UI.

Implemented: Repo audit docs, technical plan, security plan, database plan, workflow rules, and local development setup compatibility.

Not implemented yet: Real backend, Supabase client, DeepSeek endpoint, database migrations, RLS policies.

Testing requirement: `pnpm install` if needed, `pnpm run typecheck`, `pnpm run build`, plus app-specific lint/test scripts if present.

Expected output: File-by-file plan and documentation for backend integration.

## Phase 2: Supabase Foundation

Goal: Add Supabase foundation without changing the visual UI.

Will implement:

- Supabase environment variable documentation
- Supabase client wrapper
- database migration plan or SQL migration files
- RLS policy draft
- typed data access boundaries

Will not implement yet:

- full login replacement
- DeepSeek calls
- OCR/audio
- generated practice tests

Testing requirement: typecheck, build, and any new schema validation checks.

Expected output: Safe Supabase-ready foundation.

## Phase 3: Real Authentication And Roles

Goal: Connect login/signup to Supabase Auth and replace localStorage role demo.

Will implement:

- real auth session handling
- profiles
- workspace membership
- role-aware route guards
- logout and protected route behavior

Will not implement yet:

- full real data replacement for all screens
- DeepSeek writing checks

Testing requirement: typecheck, build, auth flow smoke tests, unauthorized route checks.

Expected output: Students and teachers can log in properly.

## Phase 4: Real Data For Batches, Questions, And Students

Goal: Replace mock data gradually with Supabase data.

Will implement:

- workspace-scoped batches
- students
- teacher-managed questions
- student assigned questions
- loading/empty/error states matching current UI

Will not implement yet:

- AI correction
- grammar weakness updates from AI output
- generated practice tests

Testing requirement: typecheck, build, data access tests where practical, RLS/manual access checks.

Expected output: Teacher can manage real batches/questions/students, and student sees assigned questions.

## Phase 5: Submissions Storage

Goal: Persist student writing submissions and teacher-visible submission data.

Will implement:

- create submission flow
- submission history
- teacher submission list
- teacher notes persistence
- submission detail retrieval

Will not implement yet:

- real DeepSeek correction unless using stored mock/placeholder result
- practice generation

Testing requirement: typecheck, build, submission create/read checks, authorization checks.

Expected output: Submissions are persistent.

## Phase 6: DeepSeek V4 Flash Writing Checker

Goal: Add server-side AI correction with strict validation.

Will implement:

- server-side AI endpoint or Supabase Edge Function
- protected DeepSeek API key
- no-overcorrection prompt
- strict Zod schema for AI JSON
- server-side input length and line limits
- safe error handling

Will not implement yet:

- generated tests unless needed for separate phase
- OCR/audio

Testing requirement: typecheck, build, schema validation tests, malformed AI response tests, rate-limit checks.

Expected output: Line-by-line correction works through validated server-side AI.

## Phase 7: Grammar Weakness Tracking

Goal: Update student grammar stats from validated AI output.

Will implement:

- `student_grammar_stats` updates
- weak topic thresholds
- teacher/student weak topic views backed by real data

Will not implement yet:

- AI-generated practice tests
- OCR/audio

Testing requirement: typecheck, build, stats update tests, repeated-topic threshold tests.

Expected output: Weak grammar topics appear per student.

## Phase 8: Practice Test Unlock And Reuse

Goal: Unlock topic practice when weak areas are detected and reuse saved tests first.

Will implement:

- practice test lookup by workspace, level, topic, and difficulty
- unlock rules
- test assignment/visibility
- attempt tracking

Will not implement yet:

- generating new tests with DeepSeek unless no saved test exists in the next phase

Testing requirement: typecheck, build, unlock threshold tests, reuse selection tests.

Expected output: Students can practice weak grammar topics with reusable saved tests.

## Phase 9: Practice Test Generation With DeepSeek

Goal: Generate tests only when reuse is unavailable.

Will implement:

- server-side test generation endpoint
- strict generated test schema
- save/reuse generated tests
- abuse limits for generation

Will not implement yet:

- OCR/audio

Testing requirement: typecheck, build, schema validation, cost/rate-limit checks.

Expected output: Reusable AI-generated tests.

## Phase 10: OCR / Image Upload

Goal: Allow image upload and text extraction.

Will implement:

- upload flow
- text extraction service boundary
- editable extracted text before submission
- storage policy if using Supabase Storage

Will not implement yet:

- audio/listening features

Testing requirement: typecheck, build, upload limits, file type/size validation, extracted text edit flow.

Expected output: Student can edit extracted text before checking.

## Phase 11: Audio / Listening Features

Goal: Add optional listening support.

Will implement:

- text-to-speech or audio explanation service boundary
- safe caching/storage decision
- playback UI integrated without redesign

Will not implement yet:

- unrelated product expansion

Testing requirement: typecheck, build, playback smoke tests, accessibility checks.

Expected output: Listening support for corrected text or explanations.

## Phase 12: Production Readiness

Goal: Make the app safe to deploy and operate.

Will implement:

- hosting configuration
- environment variable docs
- monitoring/logging
- backups
- production rate limits
- security review
- deployment checklist

Will not implement yet:

- new product features beyond hardening

Testing requirement: full typecheck, full build, deployment preview, auth/RLS checks, abuse case checks.

Expected output: Safe deployable app.

