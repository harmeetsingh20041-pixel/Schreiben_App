# Phase 7C DeepSeek Worksheet Generation

Phase 7C adds server-side worksheet preparation for unlocked grammar practice assignments. It reuses reviewed workspace worksheets first, and only calls DeepSeek when no suitable reusable worksheet exists.

## Product Rules

- Reuse before generate.
- Keep one active worksheet per workspace, student, and grammar topic.
- Multiple topics may each have one active worksheet.
- Never generate another worksheet for the same student/topic while an active assignment is `unlocked` or `in_progress`.
- Do not expose answer keys, explanations, scoring metadata, or hidden option metadata to students before submission.
- Do not create easy or generic filler worksheets.
- Generated worksheets must help the student repair the exact weak grammar topic.

## Server Flow

The `generate-practice-worksheet` Supabase Edge Function accepts `assignment_id`.

It:

1. Authenticates the caller.
2. Confirms the assignment exists and is active.
3. Confirms the caller is the student, a teacher/owner in the workspace, or a platform admin.
4. Confirms the grammar topic is still unlocked for practice.
5. Returns the current worksheet if one is already attached.
6. Checks for a reusable worksheet in the same workspace, topic, and level.
7. Attaches the reusable worksheet without calling DeepSeek when found.
8. Acquires a generation lock when no reusable worksheet exists.
9. Calls DeepSeek server-side using Supabase Edge Function secrets.
10. Validates the worksheet JSON strictly.
11. Saves the worksheet and questions for future reuse.
12. Attaches the saved worksheet to the assignment.

The browser never receives DeepSeek credentials or raw provider output.

## Reuse Rules

Reusable worksheets must match:

- `workspace_id`
- `grammar_topic_id`
- level
- `visibility = workspace`
- `teacher_reviewed = true` or `quality_status = passed`
- suitable difficulty

A1 can prefer easy with medium fallback. A2/B1/B2 prefer medium with easy fallback for now. Phase 7D can improve difficulty selection with previous attempt results and repeated weakness patterns.

## Generation Lock

`student_practice_assignments.generation_status` prevents duplicate generation:

- `idle`
- `generating`
- `ready`
- `failed`

The Edge Function updates an active assignment from `idle`/`failed`/`ready` to `generating` only when `practice_test_id` is still null. If another request wins the lock, the caller receives a friendly preparing state. If a worksheet was already attached, the existing assignment is returned.

If an assignment remains `generating` for less than 15 minutes, the Edge Function treats the lock as active and returns the current preparing state. If `generation_started_at` is missing or older than 15 minutes, the function marks the stale lock as `failed` with the safe retry message, then reacquires the lock through the normal single-assignment update path. This prevents students from being stuck forever while still avoiding duplicate worksheet attachment.

DeepSeek requests use an 80-second provider timeout. Timeout and provider failures mark the assignment as `failed`, leave `practice_test_id` null, and return only: "Worksheet could not be prepared. Please try again later."

## Worksheet Quality Standard

Generated worksheets must:

- Match the student level: A1, A2, B1, or B2.
- Target the exact weak grammar topic.
- Use short safe snippets from the same student's recent writing when available.
- Keep examples anonymized and within the same workspace/student.
- Use mistake snippets to understand patterns, not as text to copy into reusable worksheets.
- Include a useful mini lesson.
- Align A1/A2 style and topic progression with Netzwerk-style classroom grammar progression where possible without copying copyrighted textbook exercises or wording.
- Avoid duplicate, near-duplicate, impossible, or ambiguous questions.
- Avoid B1/B2 grammar in A1/A2 worksheets.
- Avoid childish filler and generic grammar drills.
- Include answer keys for all locally scorable questions.
- Include a student-safe explanation for every question, stored for later review/explanation flow.

## Mini Lesson

Generated worksheets save `mini_lesson` on `practice_tests`:

- `short_explanation`
- `key_rule`
- `correct_examples`
- `common_mistake_warning`
- `what_to_revise`

The student worksheet page may show this mini lesson before questions. It must not contain answer keys or question-specific explanations.

## Question Types

Phase 7C generates only exact-answer-safe types:

- `multiple_choice`
- `fill_blank`
- `sentence_correction`
- `word_order`
- `transformation`
- `rewrite_sentence`

Exact-answer safety means:

- `multiple_choice` is safe only when the correct answer appears exactly once in the display options.
- `fill_blank` is safe only when exactly one blank and one exact answer are expected.
- `sentence_correction` is safe only when the prompt asks for one corrected sentence.
- `word_order` is safe only when all required words or phrases are provided and one exact target answer is expected. Phase 7C requires enough chunks to be meaningful and rejects starting-hint prompts that make the answer obvious.
- `transformation` and `rewrite_sentence` are safe only when tightly controlled with one exact expected answer.

For A2 verb-position worksheets, generated word-order tasks should practice meaningful clause patterns such as main clauses with a fronted element, simple subordinate clauses with `weil`/`dass`/`ob`, or verb-second versus verb-final contrast. Proper-noun capitalization must not be the only real challenge.

The broader system remains open to future types, but Phase 7C generation should not use them:

- `short_answer`
- `mini_writing`
- `matching`
- `error_detection`

DeepSeek answer evaluation for open-ended worksheet answers is deferred. Mixed/manual worksheets should be submitted/completed for review rather than marked passed or failed.

## A2 Default Structure

A good generated A2 worksheet should have 8-10 questions. The current prompt asks for 9 by default and validates at least:

- 2 multiple-choice questions
- 2 fill-the-blank questions
- 2 sentence-correction questions
- 1 word-order, transformation, or rewrite question

Every question must have a non-empty answer/explanation where needed, and questions must not be duplicates.

## Validation

Generated worksheet validation checks:

- Valid JSON object.
- Level matches the assignment.
- Difficulty is valid and not automatically too easy for A2+.
- Mini lesson is complete and student-safe.
- Question count is reasonable.
- Question types are supported.
- Local answer keys are non-empty for locally scorable questions.
- Generated questions are exact-answer-safe and do not contain answer alternatives.
- Word-order prompts provide enough chunks, avoid answer-revealing starting hints, and are not trivial reorderings.
- Multiple-choice options are plain strings and include the correct answer exactly once.
- Options do not contain hidden metadata.
- Student-visible fields do not mention AI, DeepSeek, model names, answer keys, or scoring metadata.
- Duplicate prompts are rejected.
- A2 question mix meets the target structure.

If validation fails, the worksheet is not saved or attached. The assignment is marked `generation_status = failed` with a safe error message, and students see: "Worksheet could not be prepared. Please try again later."

## Student Safety

Students receive questions only through `get_practice_assignment_questions`, which returns:

- `id`
- `question_number`
- `question_type`
- `prompt`
- sanitized `options`

Raw `practice_test_questions.options` must never be relied on as student-safe storage. Future generation and editing tools must not place hidden answers, explanations, `is_correct`, answer keys, or scoring metadata inside options.

After submission, students can load review data only through `get_practice_assignment_review`. That RPC requires the caller to be the assignment student, a teacher/owner in the workspace, or a platform admin, and it only returns answers/explanations after the assignment is completed/passed/failed or the latest attempt is submitted/checked.

## Answer Evaluation

Phase 7C does not add DeepSeek answer evaluation. Local scoring still applies only when the entire worksheet is safely locally scorable. If any question is manual/unscored, the attempt is submitted and the assignment is completed without passed/failed.

Phase 7D-1 adds point-based local scoring for exact-answer worksheets. For non-capitalization/spelling topics, local scoring trims whitespace, collapses repeated spaces, and first checks for an exact normalized match. If only optional final punctuation such as `.`, `!`, or `?` differs, the answer receives full credit with `review_status = minor_punctuation`. If capitalization differs but words and order still match after removing final punctuation and lowercasing both answers, the answer receives partial credit with `review_status = capitalization_issue`. Word-order or word-choice differences remain `incorrect`.

For capitalization, spelling, Rechtschreibung, or orthography topics, capitalization is strict. A capitalization mismatch must not be relaxed into `capitalization_issue`; it remains incorrect unless the exact capitalization matches. This keeps capitalization-focused practice from hiding the skill being tested.

New locally scored attempts store decimal scoring fields on `practice_test_attempts`: `score_points`, `max_score_points`, and `scoring_version`. The integer `score` and `max_score` remain for backward compatibility, but the UI should prefer the decimal point fields when available.

Worksheet submissions are bounded server-side: at most 20 answers, at most 1000 characters per answer, and about 25 KB of submitted answer JSON.

## Test Fixture

`Phase 7B Manual Dativ Worksheet` remains a test fixture only. It is not production worksheet content and is not a quality benchmark for generated worksheets.
