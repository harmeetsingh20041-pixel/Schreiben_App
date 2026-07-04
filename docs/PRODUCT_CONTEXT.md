# Product Context

## What This App Is

Schreiben App / German Writing Coach is a standalone German writing correction tool for A1/A2 learners. The current product is a polished frontend demo with student and teacher flows, mock data, mock role selection, mock AI correction output, and a practice center. The immediate product direction is to preserve the approved frontend while replacing demo behavior with real authentication, storage, AI correction, grammar tracking, and teacher/admin workflows phase by phase.

The app should remain independent for now. It may later be merged into a larger Physics Wallah-related learning platform, but current architecture should not assume that merge.

## Target Users

- Student: writes or pastes German answers, receives line-by-line feedback, reviews history, and practices weak grammar topics.
- Teacher/Admin: manages batches, students, prompts, submissions, reviews, and teacher notes for their own workspace.
- Future multi-teacher/workspace users: multiple teachers or organizations should be able to use the same platform without seeing each other's students or data.

## Student Flow

Current frontend flow:

1. Student chooses demo login from `src/pages/login.tsx`.
2. Role is saved in localStorage by `src/lib/auth.tsx`.
3. Student reaches `/student/dashboard`.
4. Student chooses `/student/questions` for predefined prompts or free writing.
5. Student writes text in `/student/write`.
6. `src/services/aiCorrectionService.ts` returns `MOCK_AI_RESPONSE` after a delay.
7. Student is routed to `/student/result/:id`.
8. Feedback is rendered through `src/components/submission-review.tsx`.
9. History and practice are driven by `src/data/mockData.ts`.

Future real flow:

1. Student authenticates through Supabase Auth.
2. Student profile and workspace membership determine access.
3. Student sees assigned batches/questions from Supabase.
4. Student submits writing through a server-side endpoint.
5. Server validates input limits and authorization.
6. Server calls DeepSeek V4 Flash with a protected API key.
7. Server validates strict AI JSON output.
8. Server saves submission, line feedback, grammar topics, stats, and teacher-visible data.
9. Student sees persisted feedback and unlocked practice tests.

## Teacher Flow

Current frontend flow:

1. Teacher chooses demo login from `src/pages/login.tsx`.
2. Teacher reaches `/teacher/dashboard`.
3. Teacher views mock dashboard, batches, students, questions, and submissions.
4. Teacher question changes are local React state only.
5. Teacher notes in `SubmissionReview` are local UI state only and are not persisted.

Future real flow:

1. Teacher authenticates through Supabase Auth.
2. Teacher role and workspace membership determine authorization.
3. Teacher manages only their workspace's batches, students, questions, submissions, and notes.
4. Teacher sees grammar weakness trends by student and batch.
5. Teacher can review/edit generated practice tests in later phases.

## No-Overcorrection Philosophy

The core correction rule is: do not overcorrect A1/A2 writing.

The AI should not rewrite simple correct German into advanced German. Simple, natural, correct A1/A2 sentences should stay unchanged and be marked as `correct` or `acceptable_a1_a2`. Corrections should target real mistakes only, including:

- article mistakes
- case mistakes
- Dativ/Akkusativ mistakes
- verb position mistakes
- conjugation mistakes
- spelling mistakes
- tense mistakes
- Perfekt mistakes
- preposition mistakes
- missing words
- unclear meaning
- wrong sentence structure

The current UI already reflects this philosophy in the loading text, feedback tabs, status labels, changed-word highlighting, and `Good for A1/A2` status.

## Future DeepSeek Role

DeepSeek V4 Flash should be used only through a server-side endpoint or Supabase Edge Function. The DeepSeek key must never be exposed to frontend code.

DeepSeek should:

- check writing line by line
- preserve acceptable A1/A2 sentences
- produce corrected lines only when needed
- explain changes in simple English
- tag grammar topics
- detect repeated weak areas
- generate grammar practice tests later when reuse is not available

DeepSeek must not control:

- authentication
- authorization
- database access
- workspace separation
- teacher access
- business rules
- rate limits
- SQL
- user permissions

## Future Supabase Role

Supabase should provide:

- Auth
- Postgres database
- Row Level Security
- possibly Storage later for OCR/image uploads

The frontend should use Supabase only for authenticated user/session flows when appropriate. Sensitive AI calls, service role operations, rate limit checks, and cross-table business logic should stay server-side.

## Future Multi-Teacher / Workspace Model

Future architecture should be workspace-first.

- A workspace belongs to a teacher or organization.
- Teachers can manage only their workspace.
- Students can belong to one or more batches inside a workspace.
- Teachers must not see another teacher's workspace data.
- Students must not see other students' submissions.
- Platform admin exists for minimal global support operations.

Primary roles:

- `platform_admin`
- `teacher`
- `student`

