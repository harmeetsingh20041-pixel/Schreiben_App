# Product Context

## What This App Is

Schreiben App / German Writing Coach is a standalone German writing and adaptive-practice tool for A1-B2 learners. V1 uses real Supabase authentication, server-managed workspace roles, persisted classes and submissions, durable writing evaluation, teacher-controlled feedback release, and persisted practice worksheets. The old showcase login, local role selection, and mock protected-data routes are not part of V1.

The app should remain independent for now. It may later be merged into a larger Physics Wallah-related learning platform, but current architecture should not assume that merge.

## Target Users

- Student: writes or pastes German answers, receives line-by-line feedback, reviews history, and practices weak grammar topics.
- Teacher/Admin: manages batches, students, prompts, submissions, reviews, and teacher notes for their own workspace.
- Future multi-teacher/workspace users: multiple teachers or organizations should be able to use the same platform without seeing each other's students or data.

## Student Flow

Current V1 flow:

1. Student authenticates through Supabase Auth.
2. Server-controlled profile and workspace membership determine access.
3. Student requests a class with its private join code and waits for teacher approval.
4. Student explicitly selects a class, then chooses an assigned prompt or free writing.
5. Writing is autosaved and submitted through the versioned API facade.
6. A durable worker validates and evaluates the exact original text.
7. Feedback is released immediately, at the scheduled time, or after teacher review according to the class mode.
8. Only released feedback appears in student history and confirmed weakness statistics.
9. Adaptive practice reuses an approved worksheet or generates and validates a new one when needed.

## Teacher Flow

Current V1 flow:

1. Teacher authenticates through Supabase Auth and receives the role allowed by the active workspace membership.
2. Teacher creates a class, chooses its feedback mode, and shares its private join code.
3. Teacher approves or rejects each exact enrollment request.
4. Teacher manages only their workspace's classes, students, writing tasks, submissions, feedback drafts, and practice support actions.
5. Teacher-review and uncertain feedback stays private until an authorized teacher edits and releases it.
6. Teacher sees confirmed grammar weakness trends and can review, override, reassign, or resolve practice support with an audit trail.

## No-Overcorrection Philosophy

The core correction rule is: do not overcorrect A1-B2 writing.

The evaluator should not rewrite simple correct German into more advanced German. Natural, correct sentences that fit the learner's declared A1-B2 level should stay unchanged. Corrections should target real mistakes only, including:

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
