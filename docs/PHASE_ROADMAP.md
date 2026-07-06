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

Implemented in `phase-2-supabase-foundation`:

- Supabase environment variable documentation
- Supabase client wrapper
- database migration SQL
- RLS policies and helper functions
- typed database entity boundaries
- idempotent grammar topic seed SQL

Not implemented yet:

- full login replacement
- DeepSeek calls
- OCR/audio
- generated practice tests

Testing requirement: typecheck, build, and install after dependency changes.

Expected output: Safe Supabase-ready foundation that keeps the mock UI working.

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

## Phase 5B: Global Writing Task Bank Polish

Goal: Import and polish the shared A2 global Schreiben writing task bank while preserving teacher workspace writing tasks.

Will implement:

- active A2 global writing tasks
- writing task text formatting with preserved line breaks
- submitted-state awareness on student writing task cards
- latest-submission navigation for already submitted writing tasks

Will not implement yet:

- full repeat-question workflow
- question timers or exam mode
- OCR/photo upload
- daily writing/check limits
- question priority or teacher-assigned required-question queues
- AI correction
- performance optimization beyond small query/order fixes

Future repeat workflow note: after AI or teacher review exists, a submission can be marked `repeat_required` so the student can intentionally repeat the same writing task. Until then, submitted writing tasks should only show the latest submitted answer.

Future timer/exam mode note: add question timers, timed writing sessions, draft/autosave, submit-on-timer-end behavior, and per-level timer defaults in a later phase.

Future OCR/photo upload note: a student should select a writing task, upload or capture a photo of a handwritten answer, let OCR extract text, and then review/edit that extracted text before submitting. Raw images should not be stored by default unless explicitly needed, and OCR accuracy/cost must be tested before release.

Future usage-control note: daily writing/check limits should be designed with server-side enforcement after real AI cost controls exist.

Future writing task planning note: teacher priority, required assigned writing tasks, and ordered student queues should be a later workflow phase rather than part of the A2 bank import.

## Phase 5C: Performance and Scale Polish

Goal: Make the growing real-data app smoother before adding heavier AI workflows.

Will implement:

- Vite large chunk optimization
- route-based lazy loading and code splitting
- explicit query limits for questions, students, invitations, join requests, and submissions
- database index review for common filters and search
- avoiding full-table row loads in teacher/student screens
- low-device and mobile smoothness review

Phase 5C implementation note: use route-level lazy loading first, then split stable vendor chunks in Vite so student and teacher pages do not load the full app upfront.

Phase 5C data note: keep the first optimization conservative with bounded Supabase reads. Full pagination or "Load more" UI for questions, students, and submissions should be added when real class sizes grow beyond the initial limits.

Phase 5C index note: do not duplicate existing indexes. Current migrations already cover the main Phase 5C access paths for global questions, submissions, invitations, join requests, workspace members, and batch students.

Phase 5C completion note: route-based code splitting, conservative query limits, and Vite chunk organization are complete. Future scale work can still improve load-more pagination, searchable server-side filters, and low-device/mobile smoothness once real class data grows.

## Phase 6: DeepSeek V4 Flash Writing Checker

Goal: Add server-side AI correction with strict validation.

Phase 6A implements:

- server-side Supabase Edge Function
- protected DeepSeek API key
- no-overcorrection prompt
- strict JSON validation for feedback output
- server-side input length and line limits
- safe error handling
- teacher-triggered `Prepare Feedback` action
- saved line-by-line feedback in Supabase

Will not implement in Phase 6A:

- automatic immediate or delayed student feedback
- full read/unread notification system
- generated tests unless needed for separate phase
- OCR/audio
- admin panel
- timer/exam mode
- daily launch limits

Testing requirement: typecheck, build, schema validation tests, malformed AI response tests, rate-limit checks.

Expected output: Line-by-line correction works through validated server-side AI.

## Future Notification System

Goal: Surface feedback-ready events without duplicating dashboard content.

Will implement later:

- read/unread feedback notifications
- notification bell
- feedback-ready alerts
- delayed feedback mode integration

## Phase 6B: Feedback Timing Modes

Goal: Let teachers control when students receive feedback without requiring students to keep the website open.

Phase 6B implements:

- batch-level feedback timing setting: immediate feedback, automatic delayed feedback, or teacher review only
- randomized per-submission scheduled feedback time for automatic delayed batches
- server-side due-feedback Edge Function for immediate and automatic delayed submissions
- student-facing states that say feedback is being prepared or to check back later
- teacher review-only remains the safest default for existing and new batches

Operational note:

- Background processing is active only after `process-due-feedback` is invoked by Supabase cron or another trusted scheduler.
- The scheduler must provide a secret header stored outside frontend code.
- See `docs/PHASE_6B_FEEDBACK_TIMING.md` for setup notes.

Will not implement in Phase 6B: notification bell/read-unread system, OCR/photo upload, timer/exam mode, admin panel, or daily launch limits.

## Phase 6C: Scheduled Feedback Processing

Goal: Run due feedback preparation from Supabase server-side scheduling so immediate and automatic delayed feedback continue even when students close the website.

Phase 6C implements:

- Supabase `pg_cron` plus `pg_net` scheduled invocation of `process-due-feedback`
- Vault-backed storage for the scheduler copy of `PROCESS_FEEDBACK_SECRET`
- a production-like `process-due-feedback-every-5-minutes` job
- secret-free setup SQL for safely recreating or disabling the job
- documentation for monitoring, timezone behavior, and cost limits

Operational note:

- The scheduler uses server-side `timestamptz` comparisons and does not rely on browser timezone.
- The scheduled due processor uses a small limit of 3 submissions per run; the Edge Function still caps ad hoc requests at 5.
- See `docs/PHASE_6C_SCHEDULED_FEEDBACK.md` for setup and rollback notes.

Will not implement in Phase 6C: notification bell/read-unread system, OCR/photo upload, timer/exam mode, admin panel, daily launch limits, or feedback prompt changes.

## Future Admin Panel

Goal: Give platform admins a separate operational area that is not mixed into teacher workspace screens.

Will implement later:

- view/manage teachers, workspaces, batches, students, submissions, and the global writing task bank
- manage global A1/A2/B1/B2 writing tasks
- review usage, cost, and security overview metrics once production usage exists
- keep admin controls separate from normal teacher workspace UI

## Future OCR / Photo Upload

Goal: Support handwritten answers while keeping students in control of the extracted text.

Will implement later:

- student selects a writing task before uploading or capturing an answer image
- OCR extracts text from the image
- student reviews and edits extracted text before final submission
- raw images are not stored by default unless explicitly needed
- accuracy, latency, and cost are tested before release

## Future Priority, Repeat, Timer, And Limits

Goal: Add classroom control and launch safety after the core writing loop is stable.

Will implement later:

- teacher-assigned or priority writing tasks
- repeat-required workflow after teacher or AI review
- timer/exam mode with autosave and submit-on-timer-end behavior
- daily submission/check limits before real launch
- additional load-more pagination and server-side search/filter improvements when class data grows

## Phase 7: Grammar Weakness Tracking

Goal: Update student grammar stats from validated AI output.

Will implement:

- `student_grammar_stats` updates
- weak topic thresholds
- teacher/student weak topic views backed by real data
- student Practice Center remains the student-facing place for unlocked grammar practice
- teacher-side visibility uses Grammar Focus Areas and Student Weak Areas; teacher practice management comes with worksheet phases
- no worksheet generation; weak topics only unlock future practice

Will not implement yet:

- AI-generated practice tests
- generated worksheets
- OCR/audio

Testing requirement: typecheck, build, stats update tests, repeated-topic threshold tests.

Expected output: Weak grammar topics appear per student.

## Phase 7B: Practice Worksheet Assignment And Attempts

Goal: Unlock topic practice when weak areas are detected, reuse saved worksheets first, and track assignment/attempt status.

Will implement:

- `student_practice_assignments`
- practice worksheet lookup by workspace, level, topic, and difficulty
- unlock rules
- worksheet assignment/visibility
- attempt tracking
- one active worksheet per student/topic
- no new worksheet for the same topic until the previous one is completed
- local scoring for objective questions
- student worksheet start/submit flow
- teacher worksheet status visibility
- documentation that `Phase 7B Manual Dativ Worksheet` is a test fixture only

Will not implement yet:

- generating new worksheets with DeepSeek
- DeepSeek answer evaluation for open-ended worksheet answers
- OCR/photo upload
- timer/exam mode
- daily limits

Testing requirement: typecheck, build, unlock threshold tests, reuse selection tests.

Expected output: Students can practice weak grammar topics with reusable saved worksheets when available.

## Phase 7C: Practice Worksheet Generation With DeepSeek

Goal: Generate worksheets only when reuse is unavailable, without breaking the one-active-worksheet rule.

Phase 7C implementation focus:

- server-side worksheet generation endpoint
- strict generated worksheet JSON schema
- generated-question quality checks
- save/reuse generated worksheets
- reuse existing worksheets before generating new ones
- do not generate another worksheet for the same student/topic until the previous one is completed
- local objective scoring remains the first choice
- defer DeepSeek answer evaluation for open-ended answers to Phase 7D
- keep student question delivery free of answer keys, explanations, and scoring metadata before submission
- sanitize displayed option payloads so raw worksheet options never leak hidden answer metadata to students
- secure post-submit review delivery only after completion/pass/fail or submitted/checked attempt status
- basic generation abuse protection through reuse checks, active-assignment checks, and generation locking
- stale generation lock recovery after a safe timeout window
- provider timeout around DeepSeek worksheet generation
- level-matched worksheets for A1, A2, B1, and B2 students
- exact weak-topic targeting rather than generic grammar drills
- A1/A2 generation should align with Netzwerk-style classroom grammar progression where possible without copying textbook exercises or wording
- examples connected to the student's actual mistakes where appropriate
- difficulty selection based on level, repeated weakness, previous worksheet result, and exact topic need
- avoid automatically making every failed follow-up harder; target the remaining misunderstanding instead
- exact-answer-safe generated exercise types: `multiple_choice`, `fill_blank`, `sentence_correction`, `word_order`, `transformation`, and `rewrite_sentence`
- word-order generation should avoid trivial chunk ordering, answer-revealing starting hints, and proper-noun capitalization as the only challenge
- future exercise type variety, including `short_answer`, `mini_writing`, `matching`, and `error_detection`, after secure review/evaluation exists
- a default A2 worksheet target of 8-10 questions with at least 2 multiple-choice, 2 fill-the-blank, 2 sentence-correction, and 1 word-order/transformation/rewrite question
- answer keys and explanations for every generated question
- topic-aware local scoring normalization: exact matches receive full credit, punctuation-only differences receive accepted punctuation status, capitalization-only differences receive partial credit for normal grammar topics, and spelling/capitalization topics keep strict capitalization-sensitive scoring
- answer payload limits to prevent oversized worksheet submissions
- keep passed/failed results limited to fully locally scorable worksheets until secure manual/open-ended evaluation exists
- submit mixed local/manual worksheets for review instead of pretending the local subtotal is a full pass/fail result
- duplicate and impossible-question checks before assigning generated worksheets
- lifecycle rules after completion: passed moves the topic toward improving, failed can unlock/generate another worksheet later, repeated failure should notify the teacher in a later phase

Will not implement yet:

- OCR/audio
- broad teacher worksheet management beyond review/edit needs

Testing requirement: typecheck, build, schema validation, cost/rate-limit checks.

Expected output: Reusable, level-appropriate AI-generated worksheets that are useful enough to help students improve.

## Phase 7D: Open Worksheet Answer Evaluation

Goal: Evaluate only flexible worksheet answers where exact local scoring is not fair.

Phase 7D-2 implements:

- local-first worksheet scoring remains unchanged
- `evaluate-practice-attempt` Edge Function for open/flexible submitted answers
- stored per-question reviews for open answers
- one provider call per attempt, not one call per question
- cost guard of 3 open/flexible questions per attempt for now
- final score combines local points and stored open-answer points
- student-facing UI says "detailed feedback" and does not mention AI, DeepSeek, model names, or automatic correction

Phase 7D-2 does not implement:

- default open-question generation
- OCR/photo upload
- timer or exam mode
- admin panel
- broad teacher editing UI

## Phase 7E: Adaptive Practice Loop

Goal: Continue practice after failed worksheets without overwriting history or creating duplicate active worksheets.

Phase 7E-1 implements:

- passed worksheets remain review-only
- failed worksheets show `Practice again`
- repeat practice creates a new active assignment linked to the previous assignment and attempt
- existing one-active-assignment-per-student/topic enforcement remains in place
- repeated clicks return the existing active repeat assignment
- repeat assignments stay source-agnostic and can later use reusable, generated, teacher-created, or imported worksheet content

Phase 7E-1 defers:

- adaptive prompt context from previous mistake summaries
- teacher controls for assigning repeats
- full question-bank management
- making every repeat worksheet harder

Phase 7E-2 can add safe previous-attempt context to worksheet generation. It should target the remaining misunderstanding, not simply increase difficulty.

## Phase 7F: Teacher Question Bank, Manual Import, Approved Reuse

Goal: Let teachers provide grammar practice questions topic-by-topic for A1/A2/B1/B2 and reuse approved content before generation.

Future question-bank work should support:

- teacher-created questions and worksheets
- manual import
- approved reusable question-bank items
- generated questions saved for review and reuse
- source metadata such as `deepseek_generated`, `teacher_created`, and `manual_import`
- topic, level, difficulty, and question-type filtering

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
