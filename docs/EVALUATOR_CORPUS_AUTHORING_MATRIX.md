# Evaluator corpus authoring matrix

The V1 evaluator corpus plan is stored in
[`quality/evaluator-corpus/authoring-matrix.json`](../quality/evaluator-corpus/authoring-matrix.json).
It is a content-free allocation contract, not educational evidence.

## Allocation

The shared allocation template implies exactly 600 stable draft IDs:

- `A1-EVAL-001` through `A1-EVAL-150`
- `A2-EVAL-001` through `A2-EVAL-150`
- `B1-EVAL-001` through `B1-EVAL-150`
- `B2-EVAL-001` through `B2-EVAL-150`

Each level assigns exactly 10 slots to each primary category:

1. `do_not_overcorrect`
2. `correction_accuracy`
3. `explanation_accuracy`
4. `decimal`
5. `time`
6. `abbreviation`
7. `paragraph_boundary`
8. `offset`
9. `repeated_word`
10. `missing_space`
11. `long_sentence`
12. `topic_mapping`
13. `level_fit`
14. `prompt_injection`
15. `expected_hold`

Whitespace is deliberately planned as an additional release tag on paragraph
and missing-space cases, preserving the existing launch-quality coverage
contract without consuming a separate primary category.

The 10 topic-mapping slots at each level map one-to-one to that level's 10
canonical Phase 11A topic slugs. The 10 expected-hold slots are split two each
across invalid structure, original/offset mismatch, unmapped topic, unresolved
model disagreement, and insufficient adjudication evidence.

## Evidence boundary

The matrix stores no German writing, expected correction, explanation,
provider response, output hash, reviewer, qualification, timestamp, or
approval. Every slot remains `not_started`. The matrix cannot be copied into
`reviewed-cases.jsonl`, used as provider input, or counted toward a release.

The release evidence contract is a strict discriminated shape. Every case has
matching `expected_disposition` and `actual_disposition`, a unique
`decision_sha256`, explicit topic-mapping and CEFR-fit agreement, and proof that
it was not student-visible before the reviewed release boundary. Its ID uses
the level-matching matrix form such as `A2-EVAL-037`, and its
`primary_category` preserves the matrix allocation.

The content-free machine-readable template is
[`quality/evaluator-corpus/reviewed-case.schema.json`](../quality/evaluator-corpus/reviewed-case.schema.json).
It mirrors the executable launch verifier and is regression-tested against the
same key, category, tag, hold-reason, and hold-variant sets.

An `accepted_feedback` case has a unique `output_sha256`, a null hold reason,
and boolean do-not-overcorrect/correction/explanation agreements. A
`system_hold` case has a null output, an allowed runtime `hold_reason_code`, the
`expected_hold` tag, one of the five matrix-bound `hold_variant` values, and
null correction/explanation agreement because no feedback was accepted.
`structural_valid` on a hold certifies the terminal hold evidence envelope.
Each level needs exactly two reviewed cases for every hold variant. Legacy rows
missing these fields, rows with extra fields, outcome mismatches, and visible
holds all fail closed.

Each level requires exactly 140 accepted-feedback cases, 10 qualified hold
cases, and 10 rows in each primary category. Every release coverage tag needs
at least 10 passing rows per level. Topic-mapping and CEFR-fit agreement must be
100%. Accepted feedback remains subject to the 99% do-not-overcorrect and 98%
correction/explanation gates.

Each authored case still needs unique input, executed decision evidence, the
pinned evaluator/provider route, and qualified German-language review. An
expected hold must never be converted into invented accepted feedback merely
to satisfy a count.

## Validation

Run:

```sh
pnpm evaluator-matrix:verify -- \
  --file quality/evaluator-corpus/authoring-matrix.json
```

The validator expands all implied IDs and fails for count drift, missing or
duplicate levels, category range gaps or overlaps, weaker quality targets,
non-canonical topic plans, missing hold variants, release-tag drift, or any
content/evidence claim added to the matrix.
