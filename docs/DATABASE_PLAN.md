# Database Plan

## Principles

- Use workspace-first data modeling.
- Every workspace-owned row should include `workspace_id`.
- Enable RLS on all user-facing tables.
- Use UUID primary keys.
- Use `created_at` and `updated_at` where useful.
- Keep AI output validated before persistence.
- Keep service-role writes server-side only.

## Tables

### workspaces

Purpose: tenant boundary for teachers, organizations, and future multi-teacher use.

Important columns:

- `id`
- `name`
- `owner_profile_id`
- `created_at`
- `updated_at`

Relationships:

- has many `workspace_members`
- has many `batches`, `questions`, `submissions`, `practice_tests`

Indexes:

- `owner_profile_id`

RLS concept:

- members can read their workspace
- owner/teacher can update workspace metadata
- platform admin can manage all

### profiles

Purpose: app profile linked to Supabase Auth user.

Important columns:

- `id`
- `auth_user_id`
- `display_name`
- `email`
- `global_role`
- `created_at`
- `updated_at`

Indexes:

- unique `auth_user_id`
- unique/lowercase `email` if required

RLS concept:

- users can read/update safe fields on own profile
- teachers can read profiles of students in their workspace
- platform admins can read all

### workspace_members

Purpose: map users to workspaces and roles.

Important columns:

- `id`
- `workspace_id`
- `profile_id`
- `role` (`platform_admin`, `teacher`, `student`)
- `status`
- `created_at`

Indexes:

- unique `(workspace_id, profile_id)`
- `(profile_id, role)`
- `(workspace_id, role)`

RLS concept:

- members can read their own membership
- teachers can read/manage memberships in their workspace
- students cannot add/remove memberships

### batches

Purpose: class groups inside a workspace.

Important columns:

- `id`
- `workspace_id`
- `name`
- `level`
- `active`
- `created_by`
- `created_at`
- `updated_at`

Indexes:

- `(workspace_id, active)`
- `(workspace_id, level)`

RLS concept:

- teachers can manage batches in their workspace
- students can read assigned batches only

### batch_students

Purpose: membership of students in batches.

Important columns:

- `id`
- `workspace_id`
- `batch_id`
- `student_profile_id`
- `status`
- `created_at`

Indexes:

- unique `(batch_id, student_profile_id)`
- `(workspace_id, student_profile_id)`

RLS concept:

- teachers can manage batch students in their workspace
- students can read their own batch assignments

### questions

Purpose: teacher-managed predefined writing prompts.

Important columns:

- `id`
- `workspace_id`
- `created_by`
- `title`
- `level`
- `topic`
- `prompt`
- `expected_word_min`
- `expected_word_max`
- `estimated_time_minutes`
- `active`
- `created_at`
- `updated_at`

Indexes:

- `(workspace_id, active)`
- `(workspace_id, level)`
- full-text/search index later for title/topic if needed

RLS concept:

- teachers can create/update/delete questions in their workspace
- students can read active questions assigned to their batch/workspace

### submissions

Purpose: one writing submission and summary result.

Important columns:

- `id`
- `workspace_id`
- `student_profile_id`
- `question_id`
- `batch_id`
- `original_answer`
- `overall_summary`
- `level_detected`
- `status`
- `number_of_corrections`
- `ai_model`
- `ai_response_version`
- `created_at`
- `updated_at`

Indexes:

- `(workspace_id, student_profile_id, created_at desc)`
- `(workspace_id, batch_id, created_at desc)`
- `(workspace_id, status)`
- `(question_id)`

RLS concept:

- student can create/read own submissions
- teacher can read submissions in own workspace
- server writes validated AI fields

### submission_lines

Purpose: line-by-line correction records.

Important columns:

- `id`
- `workspace_id`
- `submission_id`
- `line_number`
- `original_line`
- `corrected_line`
- `status`
- `short_explanation`
- `detailed_explanation`
- `grammar_topic_id`
- `created_at`

Indexes:

- `(submission_id, line_number)`
- `(workspace_id, grammar_topic_id)`

RLS concept:

- access follows parent submission workspace/student visibility

### grammar_topics

Purpose: canonical grammar topic names per workspace or global seed set.

Important columns:

- `id`
- `workspace_id` nullable for global topics
- `name`
- `description`
- `level`
- `active`

Indexes:

- unique `(workspace_id, name)`
- `(name)`

RLS concept:

- global topics readable by authenticated users
- workspace topics manageable by workspace teachers

### submission_grammar_topics

Purpose: summary counts and severity by submission/topic.

Important columns:

- `id`
- `workspace_id`
- `submission_id`
- `grammar_topic_id`
- `count`
- `severity`
- `simple_explanation`

Indexes:

- unique `(submission_id, grammar_topic_id, severity)`
- `(workspace_id, grammar_topic_id)`

RLS concept:

- access follows parent submission visibility

### student_grammar_stats

Purpose: aggregate weak topic tracking.

Important columns:

- `id`
- `workspace_id`
- `student_profile_id`
- `grammar_topic_id`
- `minor_count`
- `major_count`
- `last_seen_at`
- `weak_topic_status`
- `practice_unlocked`
- `updated_at`

Indexes:

- unique `(workspace_id, student_profile_id, grammar_topic_id)`
- `(workspace_id, grammar_topic_id, weak_topic_status)`
- `(student_profile_id, practice_unlocked)`

RLS concept:

- student can read own stats
- teacher can read stats for students in their workspace
- updates should happen server-side after validated AI output

Suggested thresholds:

- 1 minor issue: track only
- 2-3 repeated issues: show as weak topic
- 3+ repeated issues or repeated major issue: unlock practice test

### practice_tests

Purpose: reusable grammar practice tests.

Important columns:

- `id`
- `workspace_id`
- `grammar_topic_id`
- `level`
- `difficulty`
- `title`
- `source` (`teacher_created`, `ai_generated`)
- `status` (`draft`, `approved`, `archived`)
- `created_by`
- `created_at`
- `updated_at`

Indexes:

- `(workspace_id, grammar_topic_id, level, difficulty, status)`
- `(workspace_id, source)`

RLS concept:

- students can read approved/unlocked tests in their workspace
- teachers can manage tests in their workspace

### practice_test_questions

Purpose: individual questions inside a practice test.

Important columns:

- `id`
- `workspace_id`
- `practice_test_id`
- `order_index`
- `question`
- `options`
- `correct_answer`
- `explanation`

Indexes:

- `(practice_test_id, order_index)`

RLS concept:

- access follows parent practice test

### practice_test_attempts

Purpose: track student attempts and scores.

Important columns:

- `id`
- `workspace_id`
- `practice_test_id`
- `student_profile_id`
- `score`
- `total_questions`
- `answers`
- `started_at`
- `completed_at`

Indexes:

- `(workspace_id, student_profile_id, completed_at desc)`
- `(practice_test_id, student_profile_id)`

RLS concept:

- student can create/read own attempts
- teacher can read attempts in own workspace

### teacher_notes

Purpose: teacher comments on submissions.

Important columns:

- `id`
- `workspace_id`
- `submission_id`
- `teacher_profile_id`
- `note`
- `created_at`
- `updated_at`

Indexes:

- `(submission_id, created_at desc)`
- `(workspace_id, teacher_profile_id)`

RLS concept:

- teachers can create/update their notes in own workspace
- students can read notes attached to their own submissions if product allows

### usage_events

Purpose: audit and cost tracking for AI/OCR/audio actions.

Important columns:

- `id`
- `workspace_id`
- `profile_id`
- `event_type`
- `provider`
- `model`
- `input_size`
- `output_size`
- `status`
- `created_at`

Indexes:

- `(workspace_id, profile_id, event_type, created_at desc)`
- `(event_type, created_at desc)`

RLS concept:

- users may read limited own usage if needed
- teachers can read aggregate workspace usage
- detailed provider logs server/admin only

### usage_limits

Purpose: configurable limits per workspace/role/user.

Important columns:

- `id`
- `workspace_id`
- `profile_id` nullable
- `role` nullable
- `event_type`
- `period`
- `max_count`
- `active`

Indexes:

- `(workspace_id, event_type, active)`
- `(profile_id, event_type, active)`

RLS concept:

- teachers can read workspace-level limits
- platform admins manage global defaults
- server enforces limits

## Workspace Isolation Model

For every request:

1. Resolve authenticated `profile_id`.
2. Resolve allowed `workspace_id` values from `workspace_members`.
3. Query only rows where `workspace_id` is allowed.
4. Apply role-specific rules.
5. Use RLS policies as the final enforcement layer.

Frontend route guards are UX only. Real access control must be in Supabase RLS and server-side checks.

