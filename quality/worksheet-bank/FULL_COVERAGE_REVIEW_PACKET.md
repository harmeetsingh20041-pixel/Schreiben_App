# Full-coverage worksheet review packet

`qualified-human-review-packet-full-coverage.json` is the handoff manifest for
qualified German-language review of all 184 current worksheet drafts. It is
separate from `qualified-human-review-packet.json`, which remains the focused
breadth-first priority set of 80 worksheets: 20 distinct topics per level.

The full-coverage packet is a review target only. Its required status is
`awaiting_qualified_human_review`; it is not launch evidence and cannot be used
for deployment. The manifest records 46 worksheets per CEFR level, all 36
closed grammar topics once per level, and the existing 10 priority second
revisions per level. Every entry is bound to its repository-relative file path,
current SHA-256, level, topic, and question counts.

Both packet verifiers also contain an immutable digest of their ordered entry
set. Editing worksheet content and merely repinning a manifest therefore fails
closed; changing a review snapshot requires a separate, explicit verifier
trust-root change that can be independently reviewed.

Run the integrity check with:

```sh
pnpm --dir scripts worksheet-full-coverage-review-packet:verify
```

Any worksheet edit changes its hash and requires a new review target. Updating
the manifest never substitutes for qualified human review. Separate release
evidence must be produced through the launch-quality process after that review.
