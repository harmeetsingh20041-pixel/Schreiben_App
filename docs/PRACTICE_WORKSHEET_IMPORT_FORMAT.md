# Practice Worksheet Import Format

Phase 7F-A stores approved worksheet-bank content in the existing `practice_tests`
and `practice_test_questions` tables. There is no separate question-bank table in
this phase.

Curated worksheets are the preferred v1 source for practice. Worksheet
preparation should use this priority:

1. Approved manual or teacher-provided reusable worksheets.
2. Previously generated validated reusable worksheets.
3. DeepSeek generation with validation, salvage, and retry.
4. System fallback.

## Metadata

Approved imports should save `practice_tests` with:

- `created_by_ai = false`
- `teacher_reviewed = true`
- `quality_status = approved`
- `generation_source = manual_import` or `teacher_created`
- `visibility = workspace` for the current v1 app

Existing generated worksheets keep using `generation_source = deepseek` or
`system_fallback`. Those remain available as fallbacks; they are not the primary
quality source when approved manual content exists.

## JSON Shape

```json
{
  "title": "A2 Prepositions Practice 1",
  "level": "A2",
  "grammar_topic": {
    "slug": "prepositions",
    "name": "Prepositions"
  },
  "difficulty": "medium",
  "visibility": "workspace",
  "source": "manual_import",
  "source_label": "Teacher approved worksheet bank",
  "tags": ["prepositions", "a2", "local-exact"],
  "mini_lesson": {
    "short_explanation": "Prepositions connect ideas and often belong to fixed phrases or case patterns.",
    "key_rule": "Learn each preposition together with the noun phrase that follows it.",
    "correct_examples": ["Ich warte auf den Bus.", "Wir fahren mit dem Zug."],
    "common_mistake_warning": "Do not choose a preposition only by translating from English.",
    "what_to_revise": "Review common A2 preposition phrases."
  },
  "questions": [
    {
      "question_number": 1,
      "question_type": "multiple_choice",
      "prompt": "Choose the best option: Ich warte ___ den Bus.",
      "options": ["auf", "mit", "bei", "nach"],
      "correct_answer": "auf",
      "explanation": "The phrase is auf den Bus warten.",
      "evaluation_mode": "local_exact"
    }
  ]
}
```

## Supported Values

`level`: `A1`, `A2`, `B1`, `B2`

`difficulty`: `easy`, `medium`, `hard`

`visibility`: `workspace`

Current schema also supports `private`; global reusable worksheets are a future
extension and should not be imported until the table constraint supports it.

`source`: `manual_import`, `teacher_created`

`question_type`:

- `multiple_choice`
- `fill_blank`
- `sentence_correction`
- `word_order`
- `transformation`
- `rewrite_sentence`
- `mini_writing`

`evaluation_mode`:

- `local_exact`
- `open_evaluation`

## Validation Rules

All worksheets:

- Topic must map to an existing `grammar_topics` row by slug or name.
- Question count should be reasonable for a worksheet, normally 8-12 questions.
- Prompts must not duplicate each other within the worksheet.
- Student-facing text must not mention AI, DeepSeek, models, answer keys, or
  internal scoring.
- Options must be arrays of plain strings only.
- Options must not contain objects, `is_correct`, explanations, answer keys, or
  any hidden metadata.

Local exact questions:

- `correct_answer` is required and must be non-empty.
- `multiple_choice` must include the correct answer exactly once in `options`.
- `fill_blank` must include exactly one blank and must not leak the answer in
  the prompt.
- `word_order` chunks must be shuffled, meaningful, and not already in the
  correct final order.

Open evaluation questions:

- Only `mini_writing` may use `evaluation_mode = open_evaluation` in Phase 7F-A.
- Use `correct_answer = "manual_review"` for `mini_writing` import rows.
- DeepSeek answer evaluation remains the Phase 7D-2 path and is only used after
  the student submits.

## Import Command

Use the local TypeScript importer with the linked Supabase CLI login:

```sh
pnpm --dir scripts import:practice-worksheet -- \
  --file supabase/setup/approved_worksheets/a2-prepositions-practice-1.json \
  --workspace-id <workspace-id> \
  --linked-db
```

This validates the JSON locally, then runs an upsert through
`supabase db query --linked`. It does not require a service-role key in the local
shell.

For environments that intentionally provide service-role credentials, the same
script can import over the Supabase REST API by omitting `--linked-db`.

REST mode required environment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:

- `PRACTICE_IMPORT_CREATED_BY=<profile-id>`

The importer validates the JSON before writing anything. If a worksheet with the
same workspace, grammar topic, level, title, and source already exists, it
updates that worksheet and replaces its question rows. It does not create Auth
users, send emails, print secrets, or expose answer keys to the student UI.
