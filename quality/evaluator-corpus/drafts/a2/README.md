# A2 evaluator corpus candidates

This directory contains 150 **candidate** A2 evaluator cases allocated to
`A2-EVAL-001` through `A2-EVAL-150`. They are authoring material only.

The files intentionally omit every reviewed-release field: there is no reviewer,
qualification, review timestamp, release ID, evaluator execution result, model
attestation, decision hash, output hash, approval, or expert-agreement claim.
Consequently these rows cannot satisfy
`quality/evaluator-corpus/reviewed-case.schema.json` and must never be copied
directly into `reviewed-cases.jsonl`.

Before release, each candidate still requires execution through the pinned
evaluator route, exact output capture, independent qualified German-language
review, and construction of a separate reviewed-case evidence row. Expected
feedback here is a gold-authoring hypothesis, not an attested result.

Run the level-local structural check with:

```sh
node quality/evaluator-corpus/drafts/a2/verify-candidates.mjs
```

The check enforces the 150 matrix identities, 10 rows per category, 140
accepted-feedback expectations, 10 private holds, two cases for every hold
variant, exact category tags, canonical A2 topic mapping, Unicode-character
offsets, paragraph preservation, unique inputs, no PII-like text, and the
absence of release-evidence fields.
