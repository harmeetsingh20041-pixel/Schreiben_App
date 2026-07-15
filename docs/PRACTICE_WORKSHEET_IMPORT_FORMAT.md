# Practice Worksheet Import Format

Phase 12H stores launch-bank content as private, immutable canonical template
revisions. A revision is eligible only after a registered qualified reviewer and
registered releaser attest to the exact database-recomputed content hash. The
system then creates an idempotent, exact-hash workspace clone in `practice_tests`
and `practice_test_questions` whenever that certified revision is assigned.

No reviewer entitlements, approvals, or worksheets are seeded by migrations.
Preparing the required A1-B2 launch bank is a qualified human certification
dependency, not something the importer or an AI model may claim automatically.

## Launch-bank authoring matrix

[`quality/worksheet-bank/authoring-matrix.json`](../quality/worksheet-bank/authoring-matrix.json)
defines the content-free authoring inventory for the 184 canonical launch-bank
revisions. Its 184 stable `template_key` values already satisfy the Phase 12H
6-120 character lowercase-key pattern. It fixes 46 draft slots per level: one
foundation revision for each of the 36 closed-contract topics plus 10 planned
second revisions. Every slot also fixes a learning objective,
CEFR-appropriate difficulty, an 8- or 10-question type mix, and no more than
three `open_evaluation` questions per worksheet.

Run its strict contract check before authoring or changing the inventory:

```sh
pnpm worksheet-matrix:verify -- \
  --file quality/worksheet-bank/authoring-matrix.json
```

This matrix is not worksheet source JSON. Every slot remains `not_started` and
contains no question, answer, rubric, certification, or reviewer attestation.
It must never be passed to the importer or counted as review, release, or
production-inventory evidence. A future authored worksheet may use the slot's
level, topic, difficulty, planned balance, and `template_key`, but it must still
pass the complete validation and qualified certification workflow below.

The first authored content set is isolated under
[`quality/worksheet-bank/drafts/a1`](../quality/worksheet-bank/drafts/a1).
Every file carries exact slot metadata but remains `draft_unapproved`,
`not_certified`, private, and outside the canonical bank. Validate its matrix
reconciliation and importer contract without writing data:

```sh
pnpm a1-worksheet-drafts:verify -- \
  --matrix quality/worksheet-bank/authoring-matrix.json \
  --dir quality/worksheet-bank/drafts/a1
```

These files contain no `bank_certification`, reviewer identity, or approval.
Even a successful importer dry-run records no approval and does not permit a
real import, assignment, or release before qualified German-language review.

Curated worksheets are the preferred v1 source for practice. Worksheet
preparation should use this priority:

1. An unseen, released canonical bank revision for the exact CEFR/topic context.
2. Approved manual or teacher-provided reusable workspace worksheets.
3. Previously generated validated reusable worksheets.
4. DeepSeek Pro generation with deterministic validation, parallel DeepSeek
   Flash plus `gemini-3.1-flash-lite` critique, and one bounded regeneration
   after an educational-quality rejection. A classified transient DeepSeek
   generator failure may use `gemini-3.1-flash-lite`, but independent DeepSeek
   approval remains mandatory.

If provider generation is unavailable or both bounded candidates are rejected,
the worker may automatically attach an unseen certified bank item for the exact
class level and topic. The teacher does not approve that worksheet again for
each student: the one-time canonical certification and immutable hash are the
approval boundary. If no matching certified item exists, the job remains held
or fails actionably rather than relabeling unsafe generic content.

### Qualified packet publication handoff

The runtime fast path is already independent of provider generation: when a
released canonical revision exists for the assignment's exact topic and frozen
CEFR level, `api.request_practice_worksheet` clones and attaches it in the same
transaction before it creates or reuses an AI job. The clone remains bound to
the immutable revision/release hashes, and the existing one-active-assignment
constraint remains the assignment boundary.

The 80-worksheet priority packet and 184-worksheet full-coverage packet remain
non-certifying review targets. Do not edit their status or add approval fields.
After a qualified reviewer completes one entire packet, create a separate
release manifest with this exact shape:

```json
{
  "schema_version": 1,
  "artifact_kind": "qualified_human_worksheet_release_manifest",
  "source_packet_id": "schreiben-v1-launch-worksheet-qualified-human-review-packet-1",
  "source_packet_sha256": "<sha256-of-the-exact-review-packet-file>",
  "status": "qualified_human_approved_for_release",
  "reviewed_at": "2026-07-13T08:00:00Z",
  "release_authorized_at": "2026-07-13T09:00:00Z",
  "reviewer_id": "<qualified-reviewer-profile-uuid>",
  "releaser_id": "<qualified-releaser-profile-uuid>",
  "review_checklist": {
    "structural_valid": true,
    "ambiguity_free": true,
    "no_answer_leakage": true,
    "level_fit": true,
    "topic_fit": true,
    "type_balance": true,
    "scoring_safe": true
  },
  "review_notes": "Qualified German-language review covered every exact hash in this packet.",
  "release_notes": "The release controller authorized these exact reviewed hashes for the canonical bank.",
  "worksheets": [
    {
      "template_key": "v1-a1-articles-r1",
      "current_sha256": "<exact-hash-copied-from-the-source-packet>",
      "decision": "approved"
    }
  ]
}
```

The `worksheets` array must contain every source-packet entry exactly once, in
the packet's canonical order. A partial, reordered, duplicated, changed, or
rehashed packet fails closed. The reviewer and releaser UUIDs must already be
active for the corresponding private certification/release capabilities; the
manifest cannot grant those capabilities.

Run the read-only preflight first (dry-run is the default):

```sh
pnpm worksheet-bank:publish-packet -- \
  --review-packet quality/worksheet-bank/qualified-human-review-packet.json \
  --release-manifest quality/worksheet-bank/<qualified-release-manifest>.json
```

Only after reviewing that output and confirming the linked project identity,
perform the explicit canonical-bank write:

```sh
pnpm worksheet-bank:publish-packet -- \
  --review-packet quality/worksheet-bank/qualified-human-review-packet.json \
  --release-manifest quality/worksheet-bank/<qualified-release-manifest>.json \
  --linked-db \
  --expected-project-ref <exact-20-character-linked-project-ref>
```

For the write, the tool copies only `supabase/config.toml` into a private
temporary workdir and pins the explicitly confirmed project ref there before it
starts the CLI. A concurrent change to the repository's normal Supabase link
cannot retarget the publication command.

The publisher pins the two current packet byte hashes in both application code
and the private database function, re-runs the immutable packet verifier, and
rechecks every source-file hash through a non-following file descriptor. It
rejects educational text that would be trimmed, derived, Unicode-normalized, or
truncated, while preserving reviewed internal layout such as paragraph breaks.
Only draft lifecycle metadata is converted in memory.

The entire packet is published inside one database transaction. An immutable
private packet ledger retains the exact packet and release-manifest bytes,
their hashes, reviewer/releaser identities and timestamps, and every source
hash linked to its effective canonical revision, review, and release IDs. Exact
lost-response replay returns the same ledger; changed or partial replay fails.
The later 184-item packet receives its own attestation rows even where it
legitimately overlaps revisions from the 80-item packet. Any failed item rolls
back the whole packet.

Packet publication creates no workspace clone, assignment, queue message, or
AI request. Workspace clones are created later, on demand, by the instant
runtime fast path.

The release manifest must come from the protected human review/release
workflow. A database owner can technically bypass application functions, as in
any managed Postgres system; that administrative trust boundary is not valid
worksheet-approval evidence. V1 launch evidence therefore still requires the
protected workflow record plus the immutable database review/release rows.

## Metadata

Approved imports should save `practice_tests` with:

- `created_by_ai = false`
- `teacher_reviewed = true`
- `quality_status = approved`
- `generation_source = manual_import` or `teacher_created`
- `visibility = workspace` for the current v1 app

Validated generated worksheets truthfully use `generation_source = deepseek`
or `generation_source = gemini`, with exact pinned generator and critic models
stored in their private generation metadata. Historical `system_fallback` rows
remain stored for audit/history but are excluded from V1 worksheet reuse and
assignment.

Certified workspace clones use:

- `generation_source = certified_bank`
- `approval_source = certified_template_bank`
- `quality_status = approved`
- immutable `worksheet_template_revision_id` and
  `worksheet_template_release_id`
- `template_content_sha256` equal to the database-recomputed canonical and
  cloned-content hashes

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
      "accepted_answers": ["auf"],
      "explanation": "The phrase is auf den Bus warten.",
      "evaluation_mode": "local_exact"
    },
    {
      "question_number": 2,
      "question_type": "fill_blank",
      "prompt": "Use the closed word bank [mit, bei, für, ohne]. Complete: Wir fahren ___ dem Zug.",
      "options": [],
      "correct_answer": "mit",
      "accepted_answers": ["mit"],
      "explanation": "Use mit for a means of transport.",
      "evaluation_mode": "local_exact"
    },
    {
      "question_number": 3,
      "question_type": "sentence_correction",
      "prompt": "Correct this sentence: Ich warte für den Bus.",
      "options": [],
      "correct_answer": "Ich warte auf den Bus.",
      "rubric": {
        "criteria": [
          "Replace für with the fixed preposition auf.",
          "Preserve the sentence meaning and produce a grammatical sentence."
        ],
        "sample_answer": "Ich warte auf den Bus."
      },
      "explanation": "The fixed phrase is auf den Bus warten.",
      "evaluation_mode": "open_evaluation"
    }
  ]
}
```

For canonical bank publication, add this review envelope to the same source
JSON. It is stripped from student content and stored as immutable private
attestations:

```json
{
  "bank_certification": {
    "review_checklist": {
      "structural_valid": true,
      "ambiguity_free": true,
      "no_answer_leakage": true,
      "level_fit": true,
      "topic_fit": true,
      "type_balance": true,
      "scoring_safe": true
    },
    "review_notes": "Qualified German-language review completed for this exact revision.",
    "release_notes": "Release controller approved this exact hash for the V1 bank."
  }
}
```

All seven keys must be present, no extra keys are accepted, and every value must
be explicitly `true`. Notes must be substantive 8-1000 character audit text.
This envelope alone grants no authority: the supplied reviewer and releaser IDs
must already exist in the private, empty-by-default qualification registry.
For a real canonical-bank write, `--template-key`, worksheet `level`, and
`grammar_topic.slug` must match one exact slot in the checked-in authoring
matrix. Off-matrix keys and contradictory level/topic identities fail before
the database command runs. The certified artifact must also retain a
release-safe `source_label` and must not retain `draft_metadata`, or draft,
unapproved, or not-certified tags/provenance. Dry-run remains available for
unfinished local validation and records no approval.

## Supported Values

`level`: `A1`, `A2`, `B1`, `B2`

`difficulty`: `easy`, `medium`, `hard`

`visibility`: `workspace`

`private` is also accepted in the source contract. Canonical bank rows remain in
the unexposed `app_private` schema; only their verified workspace clones are
student-assignable.

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
- Only `multiple_choice` and genuinely constrained `fill_blank` questions may
  use `local_exact`. Sentence corrections, word-order tasks, transformations,
  rewrites, and mini-writing are always evaluated semantically.
- `multiple_choice` must include the correct answer exactly once in `options`.
- A local-exact `fill_blank` must include exactly one `___` marker.
- A local-exact `fill_blank` must provide `accepted_answers`, containing 1-12
  plain-string answers. Entries must be unique after Unicode, case, and
  whitespace normalization and must include `correct_answer`.
- The prompt must prove that the answer space is closed: name the requested
  article category, request the inflected form of a named base word, or provide
  a bracketed closed word bank containing every accepted answer. Generic
  instructions such as “complete with one word/article/preposition” fail
  validation.
- `accepted_answers` is stored as the complete local-scoring contract, not as
  a list of examples. If every valid answer cannot be enumerated, use
  `open_evaluation`.

Open evaluation questions:

- Use `evaluation_mode = open_evaluation` for flexible `fill_blank`,
  `sentence_correction`, `word_order`, `transformation`, `rewrite_sentence`,
  and `mini_writing` questions when exact local matching would be unfair.
- Every open question requires a `rubric` with 1-6 concrete `criteria` strings
  and a real `sample_answer`. `correct_answer` must match that sample (or may be
  omitted so the importer derives it from the sample).
- `accepted_answers` must be omitted for open questions; the rubric defines
  semantic evaluation instead.
- `manual_review` and equivalent sentinel strings are rejected everywhere.
- A worksheet may contain at most three open questions, matching the evaluator
  capacity enforced at generation, submission, and evaluation.
- Objective questions remain local. After submission, one to three nonblank
  flexible answers are scored independently by DeepSeek Flash and
  `gemini-3.1-flash-lite`. Matching validated results complete automatically;
  disagreement invokes hash-bound DeepSeek Pro adjudication, and a missing,
  invalid, or unresolved result remains private. The Gemini generation fallback
  does not weaken this two-provider scoring gate.

## Import Command

### Canonical launch-bank publication

First run the source file through complete local validation without writing:

```sh
pnpm --dir scripts import:practice-worksheet \
  --file ../path/to/certified-worksheet.json \
  --workspace-id 00000000-0000-4000-8000-000000000001 \
  --publish-to-bank \
  --template-key v1-a2-prepositions-r1 \
  --bank-reviewed-by <qualified-reviewer-profile-id> \
  --bank-released-by <qualified-releaser-profile-id> \
  --dry-run
```

After checking that output, publish the immutable revision and create its first
verified workspace clone atomically:

```sh
pnpm --dir scripts import:practice-worksheet \
  --file ../path/to/certified-worksheet.json \
  --workspace-id <workspace-id> \
  --publish-to-bank \
  --template-key v1-a2-prepositions-r1 \
  --bank-reviewed-by <qualified-reviewer-profile-id> \
  --bank-released-by <qualified-releaser-profile-id> \
  --linked-db
```

Certification and release are separate entitlements. One person may perform
both only when the private registry explicitly grants both roles; the importer
never infers or creates those privileges. Repeating identical content returns
the same immutable revision and workspace clone. Changed content creates the
next revision and preserves all historical IDs.

### Workspace-only teacher import

Use the local TypeScript importer with the linked Supabase CLI login:

```sh
pnpm --dir scripts import:practice-worksheet \
  --file ../supabase/setup/approved_worksheets/a2-prepositions-practice-1.json \
  --workspace-id <workspace-id> \
  --created-by <active-owner-or-teacher-profile-id> \
  --linked-db
```

Run the exact same validation without writing anything:

```sh
pnpm --dir scripts import:practice-worksheet \
  --file ../supabase/setup/approved_worksheets/a2-prepositions-practice-1.json \
  --workspace-id 00000000-0000-4000-8000-000000000001 \
  --dry-run
```

Workspace-only dry runs do not need `--created-by`. A bank dry run requires the
explicit reviewer/releaser IDs and certification envelope so the exact command
shape is validated, but it does not query the private entitlement registry or
record an approval. In every dry run, no worksheet approval is recorded, and
the output includes `approval_recorded: false`.

The importer validates the JSON locally, then runs one atomic SQL statement
through the pinned Supabase CLI. REST write mode is intentionally disabled
because replacing a worksheet through multiple HTTP requests cannot guarantee
an all-or-nothing import.

Every non-dry-run linked workspace-only import requires an explicit
`--created-by` profile UUID.
The atomic SQL verifies that the profile currently has an `owner` or `teacher`
membership in the target workspace before it inserts a worksheet with
`teacher_reviewed = true` and `quality_status = approved`. A null or missing
profile, a student, an offboarded reviewer, or a teacher from another workspace
fails before any worksheet or question row is inserted. The verified profile is
stored in both `created_by` and `reviewed_by`, with `reviewed_at` recording the
approval time.

The linked import result includes `content_sha256`, computed inside the database
from the persisted worksheet, grammar-topic slug/name, mini-lesson, and ordered
question content. Copy that returned digest into the qualified
`approved-revisions.jsonl` entry. Never copy a hash from `quality_notes`:
quality notes are editable provenance text and are not release evidence.

The canonical-bank result instead includes `template_id`, immutable
`revision_id`, `review_id`, `release_id`, the cloned `practice_test_id`, and both
canonical and clone content hashes. The two hashes must match. Launch inventory
accepts only these hash-bound canonical releases; ordinary workspace approvals
cannot be counted toward the required bank of 184 revisions, 46 per CEFR level.
The approval manifest and production inventory must also match every exact
authoring-matrix `template_key`; aggregate topic counts cannot substitute a
duplicate r1 for a required r2.

The importer validates the JSON before writing anything. Re-importing identical
validated content is idempotent. Changed content creates a new content-addressed
worksheet revision and never updates or deletes the older worksheet or its
question IDs. The worksheet and all question rows are inserted in one
transaction. It does not create Auth users, send emails, print secrets, or
expose answer keys to the student UI.
