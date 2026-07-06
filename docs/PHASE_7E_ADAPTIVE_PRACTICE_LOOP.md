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
- If an active repeat already exists for the same student/topic, return it instead of creating a duplicate.

## One Active Assignment Rule

The existing partial unique index still enforces at most one active assignment per workspace, student, and grammar topic. Active means `unlocked` or `in_progress`. Completed, passed, failed, and cancelled assignments are history.

## Adaptive Metadata

Repeat assignments store:

- `previous_assignment_id`
- `previous_attempt_id`
- `repeat_number`
- `adaptive_reason`
- `adaptive_status`

Phase 7E-1 uses this metadata for traceability and one reuse guard. Worksheet generation still starts from an empty assignment and keeps reuse-before-generate behavior, but adaptive repeats must not reattach the exact worksheet from the immediately previous failed assignment.

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
