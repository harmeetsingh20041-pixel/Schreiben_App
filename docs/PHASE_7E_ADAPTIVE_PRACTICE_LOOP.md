# Phase 7E Adaptive Practice Loop

Phase 7E-1 adds the repeat loop after worksheet completion. It keeps worksheet history intact and creates a new assignment only when the student explicitly asks to practice again after a failed worksheet.

## Passed Worksheets

- Keep the completed worksheet review visible.
- Keep score, saved answers, feedback, corrected answers, sample answers, and explanations visible.
- Mark the topic as improving or practiced through the existing scoring flow.
- Do not automatically create another worksheet for the same topic.
- Student can reopen and review the worksheet.

## Failed Worksheets

- Keep the failed worksheet review visible.
- Show a clear `Practice again` action.
- Create a new active assignment instead of overwriting the failed assignment.
- Link the repeat assignment to the previous assignment and latest attempt.
- Show a `Review previous worksheet` link from an adaptive repeat so the old failed review remains discoverable.
- Show recent topic worksheet history directly in Practice Center with status, score, and a review action.
- If a repeat already exists for a failed worksheet, hide `Practice again` for that old worksheet and show `Next practice already created` with a `Go to next worksheet` action.
- If an adaptive repeat fails, do not create another automatic repeat in Phase 7E-1. Show teacher-support guidance instead.
- If an active repeat already exists for the same student/topic, return it instead of creating a duplicate.
- Do not accept blank or incomplete worksheet submissions; students must answer every question before submitting.

## One Active Assignment Rule

The existing partial unique index still enforces at most one active assignment per workspace, student, and grammar topic. Active means `unlocked` or `in_progress`. Completed, passed, failed, and cancelled assignments are history.

## Adaptive Metadata

Repeat assignments store:

- `previous_assignment_id`
- `previous_attempt_id`
- `repeat_number`
- `adaptive_reason`
- `adaptive_status`

Phase 7E-1 uses this metadata for traceability and reuse guards. Worksheet generation still starts from an empty assignment and keeps reuse-before-generate behavior, but adaptive repeats must not reattach any worksheet already attempted by the same student for the same grammar topic. If no unseen reviewed/approved reusable worksheet exists, the system should generate a new worksheet instead of cycling back to old failed practice.

For normal `weakness_auto` assignments, worksheet preparation still depends on `student_grammar_stats.practice_unlocked` or an unlocked weakness level. For `adaptive_repeat` assignments, the repeat assignment itself is the unlock signal because it can only be created after `create_next_practice_assignment` validates a completed failed worksheet and caller permissions.

## Worksheet Quality Stabilization

Generated worksheets must fail validation before saving or attaching when they are spoon-fed or meaningless. Phase 7E-1 rejects fill-blank prompts that leak the correct answer in the prompt, including article hints such as `___ (den)` or `___ (ein)`, and rejects word-order tasks whose chunks are already in the final answer order. Provider/internal validation details stay in logs only; students see the safe retry message: `Worksheet could not be prepared. Please try again later.`

Worksheet generation is resilient in v1:

- The provider is asked for more candidate questions than the final worksheet needs.
- Each candidate question is validated independently.
- Valid questions are kept; invalid questions are rejected with developer-safe diagnostics.
- Retries ask only for the missing valid questions and include the rejected patterns to avoid.
- The final saved worksheet is renumbered after validation.
- If provider generation still cannot produce enough valid questions, the function tries a deterministic system fallback for common v1 topics.

Developer diagnostics are stored in `practice_generation_events`. This table is not exposed to students and must not store secrets or large raw provider payloads. It records assignment, workspace, student, topic, attempt number, pipeline stage, safe status, developer reason, and question-level context when relevant.

Current deterministic fallback coverage:

- Prepositions
- Akkusativ
- Dativ
- Verb position / Word order
- Articles

Fallback worksheets use exact-answer-safe local question types only and must pass the same validation gates as provider-generated worksheets before they are saved. Saved fallback worksheets use `generation_source = 'system_fallback'`.

## Deferred To Phase 7E-2

Future adaptive generation can use a safe, short summary of the previous attempt:

- topic
- previous review statuses
- wrong, partial, capitalization, or punctuation patterns
- feedback themes

Do not send student names or emails. Do not copy old answer text unnecessarily. Generation should target the remaining misunderstanding, not simply make the next worksheet harder.

## Future Question Bank Compatibility

Phase 7E-1 must not make practice DeepSeek-only. Repeat assignments should remain compatible with:

- teacher-created worksheets
- manual import
- approved reusable question bank items
- generated questions saved for reuse
- source metadata such as `deepseek_generated`, `teacher_created`, and `manual_import`
- topic, level, difficulty, and question-type filtering

Phase 7F or later should add Teacher Question Bank + Manual Import + Approved Reuse. Approved question-bank content should be searched by topic, level, difficulty, and question type before falling back to DeepSeek generation.
