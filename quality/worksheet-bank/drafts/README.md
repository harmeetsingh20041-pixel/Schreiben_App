# Worksheet drafts

Files below this directory are educational drafts only. They are not qualified
review evidence, are not certified canonical-bank revisions, and must never be
assigned or imported as approved content.

The A1, A2, B1, and B2 sets live in [`a1/`](./a1/), [`a2/`](./a2/),
[`b1/`](./b1/), and [`b2/`](./b2/). Each set contains 46 drafts and reconciles
exactly to its 46 planning slots in
[`../../worksheet-bank/authoring-matrix.json`](../authoring-matrix.json). Every
file is marked `draft_unapproved`, `not_certified`, and `unapproved`; no file
contains a reviewer identity, certification envelope, or release attestation.

The complete 184-draft bank currently contains 1,656 questions. It has passed
deterministic importer validation and an internal question-by-question
AI-assisted content QA pass across A1, A2, B1, and B2. That QA corrected
concrete ambiguity, answer-leakage, scoring-contract, CEFR-scope, and German
language defects, but it is not qualified-human certification and cannot be
used as production release evidence.

Run the deterministic reconciliation and importer-contract check with:

```sh
pnpm a1-worksheet-drafts:verify -- \
  --matrix quality/worksheet-bank/authoring-matrix.json \
  --dir quality/worksheet-bank/drafts/a1

pnpm a2-worksheet-drafts:verify -- \
  --matrix quality/worksheet-bank/authoring-matrix.json \
  --dir quality/worksheet-bank/drafts/a2

pnpm --dir scripts exec tsx ./src/verify-a1-worksheet-drafts.ts -- \
  --level B1 \
  --matrix quality/worksheet-bank/authoring-matrix.json \
  --dir quality/worksheet-bank/drafts/b1

pnpm --dir scripts exec tsx ./src/verify-a1-worksheet-drafts.ts -- \
  --level B2 \
  --matrix quality/worksheet-bank/authoring-matrix.json \
  --dir quality/worksheet-bank/drafts/b2
```

Local importer dry-runs are validation only and must use `--dry-run`. Publishing
to the canonical bank remains forbidden until every draft has received genuine
qualified German-language review and separate certification/release authority.
