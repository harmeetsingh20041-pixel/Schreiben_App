# Gemini Secondary Provider Contract

DeepSeek remains the primary V1 provider. Gemini is the mandatory independent
secondary family for automatic writing release, generated-worksheet approval,
and semantic worksheet-answer scoring. Provider names, keys, prompts, student
text, answers, and raw responses never appear in student-facing UI, queue
payloads, or persistent logs.

## Pinned V1 roles

- `gemini-3.1-flash-lite`: low-cost independent semantic-answer evaluator,
  routine writing and generated-worksheet critic, rare bounded recovery
  generator, and fresh final critic after a disputed writing result.

Aliases, preview models, experimental models, and environment-selected model
names fail closed. A model change is a code release and requires the complete
evaluator and worksheet benchmark again.
Historical records and settled accounting rows may retain truthful
`gemini-2.5-flash` or `gemini-3.5-flash` provenance, but those retired models
are never eligible for a new V1 provider call or launch canary.

The integration uses Gemini's native non-streaming `generateContent` endpoint,
not the beta OpenAI-compatibility endpoint. Requests use `x-goog-api-key`, one
candidate, JSON output, bounded output tokens, and model-appropriate low-cost
thinking controls. The pinned Flash-Lite model uses an explicit low thinking
level. The adapter accepts only one `STOP`
candidate with valid text, a compatible returned `modelVersion`, bounded usage
metadata, and no prompt block. Safety, recitation, SPII, blocklist,
prohibited-content, malformed, and max-token endings are classified as safe
retry-or-hold outcomes and never become released educational content.

## Writing evaluation

DeepSeek Flash generates the first candidate. Gemini 3.1 Flash-Lite independently
checks the exact hash-bound student-visible projection. An approval may release
according to the class feedback mode. A disagreement invokes DeepSeek Pro once;
a fresh Gemini 3.1 Flash-Lite call must then approve the resolved projection.

If both DeepSeek Flash and DeepSeek Pro return deterministically malformed,
oversized, empty, or schema-invalid generation output, Gemini 3.1 Flash-Lite may
generate one fresh recovery candidate. That candidate can release only when a
fresh DeepSeek Pro critic approves the exact context, candidate, and visible
release hashes. A Gemini critic can never approve a Gemini-generated candidate.
Uncertainty is not treated as provider failure: uncertain Pro output remains
private. Critic disagreement, uncertainty, malformed output, authentication or
availability failure, deadline exhaustion, spend rejection, and hash mismatch
all hold or durably retry without release.

Classified transient DeepSeek Flash outage and explicitly enabled
authentication failover use the same bounded Gemini-generator recovery lane.
The Gemini candidate can release only when a fresh, healthy DeepSeek Pro call
independently approves its exact context, candidate, and visible release
hashes. If Pro is unavailable, rejects authentication, returns invalid or
insufficient evidence, disagrees, or misses the deadline, the candidate stays
private. With authentication failover disabled, an authentication failure never
calls Gemini. A missing DeepSeek credential may create a private Gemini draft
only when the flag is enabled, but cannot release because no independent
DeepSeek Pro critic is configured.

## Worksheet generation

An exact-context certified or approved reusable worksheet is selected before
any provider call. Otherwise DeepSeek Pro generates a candidate, deterministic
validation runs, and DeepSeek Flash plus Gemini 3.1 Flash-Lite critique the same
hash-bound worksheet independently. Both must approve. One rejected candidate
may be regenerated; a second failure is quarantined or replaced only by an
eligible certified-bank revision.

Gemini 3.1 Flash-Lite may replace only a classified transient DeepSeek generator
failure. Missing/malformed DeepSeek configuration and authentication failures
do not silently switch providers.

## Semantic worksheet answers

Objective questions remain local and cost no provider tokens. For one to three
nonblank flexible answers, DeepSeek Flash and Gemini 3.1 Flash-Lite score the
same anonymized rubric context independently. Agreement completes
automatically. Disagreement invokes DeepSeek Pro with both hash-bound results;
unresolved output stays private for teacher review.

## Cost, data, and reliability gates

Production requires a billing-enabled Gemini project. The unpaid Gemini tier is
not permitted for student content. `GEMINI_API_KEY` is a Supabase Edge secret
and must never use the `VITE_` prefix. `GEMINI_ALLOW_PRIMARY_AUTH_FAILOVER`
defaults to `false` and is a writing-only incident circuit breaker.

Every provider call is covered by a job-scoped idempotent spend reservation,
truthful token settlement, workspace/global monthly limits, and emergency stop.
The checked-in 2026-07-13 pricing snapshot uses Gemini 3.1 Flash-Lite Standard
paid-tier rates of USD 0.25 per million input tokens and USD 1.50 per million output
tokens (including thinking tokens), with context-cached input at USD 0.025 per
million tokens. Routine writing and worksheet critique each
reserve a conservative maximum of USD 0.15 per call; actual billed token usage
settles the reservation downward.
Only locally proven pre-dispatch rejection and Gemini's documented unbilled
HTTP 400/500 responses release a reservation. Timeouts, aborts, malformed
successful responses, DeepSeek errors, and all other unknown usage stay
conservatively charged. Phase 12V changes expired unknown usage from an active
reservation into an immutable full-maximum estimate after a five-minute grace;
`usage_estimated`, estimated count, and estimated maximum cost remain separate
from metered provider usage in spend health and cost projection. Both the
30-second private database Cron and the authenticated recovery Edge worker run
bounded reconciliation. The rollback-only pgTAP path scopes every successful
transition to its exact fixture job; the global facade is never run against
shared staging by that test.
Production preflight also requires paid-tier evidence, recent token/cost
telemetry canaries, alerts, and a projected total operating cost at or below
EUR 1 per active student-month. A separate EUR 2 per-student hard-cap envelope
is emergency protection, not an acceptable operating target. Retries never
bypass spend reservations.

Automatic activation requires:

- all 600 A1-B2 evaluator cases structurally valid;
- at least 99% agreement on do-not-overcorrect cases;
- at least 98% qualified-expert agreement on corrections and explanations;
- every worksheet deterministic and dual-critic gate passing;
- live timeout, 429, 5xx, safety-block, malformed-output, and outage recovery
  canaries passing;
- the deterministic Flash-invalid, Pro-invalid, Gemini-recovery, DeepSeek-Pro-
  criticism lane passing its exact-hash release and fail-closed benchmark;
- the Flash timeout/429 and explicitly enabled authentication-failover lanes
  releasing only after a healthy exact-hash DeepSeek Pro approval, while Pro
  outage/authentication/invalid-evidence cases remain private;
- performance and monthly cost gates passing on staging.

## Official references

- [Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [GenerateContent API](https://ai.google.dev/api/generate-content)
- [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking)
- [Gemini API terms](https://ai.google.dev/gemini-api/terms)
