# Phase 7A Grammar Weakness Tracking

Phase 7A turns saved writing feedback into real grammar focus areas. It does not generate practice worksheets, tests, or DeepSeek-created exercises.

## What Is Implemented

- `refresh_student_grammar_stats(target_workspace_id, target_student_id)` recalculates one student's grammar stats from checked/needs-review submissions.
- The refresh is idempotent: rerunning it uses `submission_grammar_topics` as source-of-truth instead of incrementing blindly.
- Feedback preparation calls the refresh after feedback is saved.
- The refresh RPC is executable by `service_role` only; students and teachers read resulting stats through existing RLS-protected tables.
- Student dashboard focus areas read from `student_grammar_stats` in real Supabase mode.
- Student Practice Center shows real grammar topics grouped by tracking, weak, practice unlocked, improving, and mastered.
- Teacher dashboard shows real grammar focus areas in the Needs Attention panel.

## Thresholds

- `1` minor issue: `tracking`, practice not unlocked.
- `2` minor issues: `weak`, practice not unlocked.
- `3+` minor issues: `unlocked`, practice unlocked.
- `1+` major or mixed-severity issue: `unlocked`, practice unlocked.

## Topic Mapping

The feedback engine maps common returned topic names to the controlled seed grammar topics:

- Dativ / dative -> Dativ
- Akkusativ / accusative -> Akkusativ
- Articles / Artikel / article -> Articles
- Verb position -> Verb position
- Word order -> Word order
- Perfekt / past tense -> Perfekt
- Prepositions / Praepositionen -> Prepositions
- Conjugation / verb conjugation -> Conjugation
- Spelling / Rechtschreibung -> Spelling
- Sentence structure -> Sentence structure

Unknown model topic names are not inserted as new grammar topics in this phase.

## Future Worksheet Rule

Practice worksheet generation is intentionally deferred.

Future phases must enforce:

- One active worksheet per student/topic.
- Do not create a new worksheet for the same student/topic until the previous one is completed.
- After a worksheet result, decide whether to improve the topic status, keep the current worksheet active, or unlock/generate another worksheet.
- Prefer reusable saved worksheets before generating new ones.

## Known Limitations

- Stats currently use submission-level grammar topic summaries, not every line-level topic.
- Mastery is not assigned automatically yet.
- Teacher student-list topic chips can be added later if the dashboard summary is not enough.
