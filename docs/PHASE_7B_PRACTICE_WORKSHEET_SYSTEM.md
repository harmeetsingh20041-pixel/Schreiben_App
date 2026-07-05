# Phase 7B Practice Worksheet System

Phase 7B adds real worksheet assignment and attempt tracking for grammar weaknesses. It does not generate worksheets with DeepSeek and does not evaluate open-ended worksheet answers with DeepSeek.

## What Is Implemented

- `student_practice_assignments` links a workspace, student, grammar topic, optional saved worksheet, and assignment status.
- A partial unique index enforces one active assignment per `workspace_id`, `student_id`, and `grammar_topic_id`.
- Active assignment statuses are `unlocked` and `in_progress`.
- Completed statuses are `completed`, `passed`, `failed`, and `cancelled`; they do not block future assignments at the database constraint level.
- `practice_test_attempts` now supports assignment linkage, attempt status, start/submission timestamps, score percent, and pass/fail.
- RPCs create/start/submit worksheet assignments:
  - `ensure_student_practice_assignment(target_workspace_id, target_student_id, target_grammar_topic_id)`
  - `start_practice_assignment(target_assignment_id)`
  - `submit_practice_attempt(target_assignment_id, submitted_answers)`
- Assignment creation is idempotent for the current grammar-stats cycle and reuses an existing active assignment instead of creating duplicates.
- If a matching saved worksheet exists, it is attached; otherwise the assignment remains unlocked without a worksheet.
- Student Practice Center shows worksheet assignment state and links to the worksheet page.
- Teachers can see worksheet status beside grammar focus areas.

## Worksheet Reuse

The assignment RPC looks for saved worksheets with:

- same workspace
- same grammar topic
- matching student/topic level
- `teacher_reviewed = true`
- `visibility = 'workspace'`
- difficulty `easy` or `medium`

If no saved worksheet exists, students see: "Practice unlocked. Worksheet will be available soon."

## Scoring

Objective question types are scored locally:

- `multiple_choice`
- `fill_blank`
- `correction`
- `short_answer` by exact normalized text match

The initial pass threshold is 70%.

If no locally scorable questions exist, the attempt is submitted as needing review instead of pretending correctness.

## Deferred To Phase 7C

- Generate or reuse worksheets with DeepSeek.
- Validate generated worksheet JSON.
- Quality-check generated questions before students receive them.
- Reuse existing worksheets before generating new ones.
- Keep one active worksheet per student/topic.
- Do not generate another worksheet for the same student/topic until the previous one is completed.
- Keep costs controlled by checking objective answers locally and using DeepSeek later only for open-ended answers where needed.
