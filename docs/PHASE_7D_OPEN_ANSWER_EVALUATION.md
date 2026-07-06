# Phase 7D Open Answer Evaluation

Phase 7D-2 adds detailed evaluation for open or flexible worksheet answers after submission. It does not replace local scoring.

## Core Rule

Use local scoring whenever exact scoring is fair. Use the `evaluate-practice-attempt` Edge Function only for worksheet questions that remain `submitted_for_review`.

Local-first question types:

- `multiple_choice`
- `fill_blank` with one exact answer
- `word_order` with one exact answer
- exact `sentence_correction`
- exact `transformation`
- exact `rewrite_sentence`
- exact `short_answer`

Open/flexible question types:

- `mini_writing`
- flexible `short_answer`
- flexible `rewrite_sentence`
- flexible `transformation`
- flexible `sentence_correction`

Flexible questions use a non-local answer key marker such as `manual_review`, so they are not accidentally scored as exact-answer questions.

## Evaluation Flow

1. Student submits a worksheet.
2. `submit_practice_attempt` scores exact local questions with the Phase 7D-1 rules.
3. If any open/flexible questions remain, the attempt is marked `evaluation_status = pending`.
4. The worksheet review page shows "Preparing detailed feedback..." and calls `evaluate-practice-attempt`.
5. The Edge Function evaluates only open/flexible questions, in one provider call per attempt.
6. Results are stored in `practice_attempt_question_reviews`.
7. `finalize_practice_attempt_evaluation` combines local points and stored open-answer points.
8. The attempt becomes `checked`, and the assignment becomes `passed` or `failed` using the 70% threshold.

## Safety

- Students never receive answer keys, explanations, or evaluation metadata before submission.
- The Edge Function authenticates the caller and confirms they are the student, a teacher/owner in the workspace, or a platform admin before evaluation.
- The browser never receives DeepSeek credentials or raw provider output.
- Student-facing UI must not mention AI, DeepSeek, model names, or automatic AI correction.
- Only necessary question, topic, level, and answer text is sent for evaluation.
- Student names and email addresses are not sent to the provider.

## Cost Guards

- Local-scored questions are skipped.
- At most 3 open/flexible questions are evaluated per attempt for now.
- Answers are capped at 1000 characters.
- Duplicate evaluation is prevented with `evaluation_status = evaluating`.
- Recent evaluation locks are respected; stale locks can be retried.
- Existing completed evaluations are returned without another provider call.

## Review Results

Open-answer reviews can return:

- `correct`
- `partially_correct`
- `capitalization_issue`
- `minor_punctuation`
- `incorrect`

Stored review fields include points, feedback text, optional corrected answer, optional sample answer, and a short reason. The secure review RPC returns these fields only after submission.
