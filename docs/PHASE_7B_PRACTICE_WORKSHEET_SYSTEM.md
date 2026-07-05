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

## Worksheet Quality Standard

Phase 7B can attach existing worksheets, but production worksheet content belongs to Phase 7C and later. Future worksheets must meet a real learning standard:

- Worksheets must not be too easy, generic, or filler content.
- Worksheets must match the student's level: A1, A2, B1, or B2.
- Each worksheet must target the exact weak grammar topic that unlocked practice.
- Questions should use examples connected to the student's actual mistakes where appropriate.
- A completed worksheet should be useful enough that the student can improve, not merely click through.
- Questions must be possible for the student's level and should avoid trick wording unless that is the explicit learning goal.

## Exercise Type Variety

The system should remain open to multiple exercise types. Future generated and teacher-edited worksheets should support names such as:

- `multiple_choice`
- `fill_blank`
- `sentence_correction`
- `word_order`
- `transformation`
- `short_answer`
- `mini_writing`
- `matching`
- `error_detection`
- `rewrite_sentence`

Do not hardcode future phases around one question style. Existing local scoring can remain conservative, but the data model and UI should be able to display richer question types as they are added.

## A2 Generated Worksheet Default

A good default target for generated A2 worksheets is:

- 8-10 questions.
- A mix of recognition and production.
- At least 2 multiple-choice questions.
- At least 2 fill-the-blank questions.
- At least 2 sentence-correction questions.
- At least 1 word-order or transformation question.
- 1-2 short production questions.
- No impossible questions.
- Every question must include an answer and explanation.
- Questions should not be duplicates or near-duplicates.

This is a default target, not a permanent limit. Teachers and future quality checks may adjust the mix by level, topic, and learner need.

## Scoring

Objective question types are scored locally:

- `multiple_choice`
- `fill_blank`
- `correction`
- `short_answer` by exact normalized text match

The initial pass threshold is 70%.

If no locally scorable questions exist, the attempt is submitted as needing review instead of pretending correctness.

## One Active Worksheet Rule

The product rule is intentionally strict:

- Keep one active worksheet per student/topic.
- Active means `unlocked` or `in_progress`.
- Do not unlock or generate another worksheet for the same student/topic until the previous one is completed.
- After completion:
  - `passed` means the topic can move toward `improving`.
  - `failed` means another worksheet may be unlocked or generated later.
  - repeated failure should notify the teacher in a later phase.

The database enforces the active-state rule with a partial unique index. Future DeepSeek generation must respect the same rule before spending tokens or saving new content.

## Editability And Extensibility

Phase 7C and Phase 7D should allow future exercise types and teacher editing/review. Generated worksheets should be saved as editable worksheet records, then reviewed or improved before broad reuse where appropriate.

Do not make Phase 7C depend on one fixed worksheet shape. The app should support adding richer prompts, options, answer keys, explanations, teacher review fields, and manual edits without replacing the assignment/attempt system.

## Test Fixture Warning

`Phase 7B Manual Dativ Worksheet` is a live verification fixture only. It proves the assignment/start/submit/scoring loop works, but it is not production content and should not be treated as a quality benchmark for generated worksheets.

## Deferred To Phase 7C

- Generate or reuse worksheets with DeepSeek.
- Validate generated worksheet JSON.
- Quality-check generated questions before students receive them.
- Reuse existing worksheets before generating new ones.
- Keep one active worksheet per student/topic.
- Do not generate another worksheet for the same student/topic until the previous one is completed.
- Keep costs controlled by checking objective answers locally and using DeepSeek later only for open-ended answers where needed.
