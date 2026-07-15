# A1 evaluator candidate corpus

This directory contains 150 authored **candidate** cases for the A1 allocation
in `quality/evaluator-corpus/authoring-matrix.json`.

- `candidates.jsonl` contains 140 expected-feedback candidates and 10 expected
  private-hold candidates.
- `build-candidates.mjs` is the deterministic source for the JSONL file and
  computes Unicode-code-point source and corrected offsets exactly like the
  writing evaluator runtime.
- `verify-candidates.mjs` reconciles every row to the shared matrix and checks
  counts, tags, topics, offsets, corrected-text reconstruction, preservation
  rules, duplicates, hold variants, and the absence of release evidence.
- `verify-candidates.test.mjs` proves the validator rejects missing identities,
  fabricated review evidence, offset drift, duplicate inputs, topic drift,
  hold-quota drift, and weakened prompt-injection expectations.

The draft severity rubric marks a repair as `major_issue` when it changes the
core order of a complete A1 clause/question or repairs the required subject
form. Local article, verb-form, agreement, duplicate-word, and spacing repairs
remain `minor_issue`. These are authored gold hypotheses, not reviewed
severity evidence.

Run the local checks with:

```sh
node quality/evaluator-corpus/drafts/a1/build-candidates.mjs
node quality/evaluator-corpus/drafts/a1/verify-candidates.mjs
node --test quality/evaluator-corpus/drafts/a1/verify-candidates.test.mjs
```

These files are not reviewed cases and cannot satisfy launch gates. They
deliberately contain no provider execution, hashes, actual disposition,
reviewer identity, qualification, approval, or certification. Qualified German
review and release-bound execution evidence must be added through the separate
reviewed-case process before any candidate can count toward launch quality.
