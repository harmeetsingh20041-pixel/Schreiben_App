# Schreiben V1 controlled teacher handoff

This handoff is for one invited teacher testing the pinned staging application:

<https://schreiben-v1-staging.netlify.app>

It is not a public launch approval. Staging data may be reset, so the tester
must use synthetic learner names and writing. Do not enter real patient,
employer, medical, identity, or other sensitive personal data.

## Before the session

- Use the separately supplied teacher and student test accounts. Passwords,
  authenticator codes, and provider keys must never be added to this document
  or an issue report.
- Complete the teacher authenticator challenge with the primary authenticator.
- Use one browser profile for the teacher and a separate private/incognito
  profile for the student so their sessions cannot overwrite one another.
- Record the local time and browser version. A screen recording is optional,
  but it must not reveal passwords, authenticator codes, or student writing.

## Required teacher and student journey

1. Teacher signs in and reaches **Teacher Overview** without a dead end.
2. The teacher creates an **A1**, **A2**, **B1**, or **B2** class and chooses
   one feedback mode: **Immediate**, **Scheduled**, or **Teacher review**.
   All four levels passed the controlled live generation matrix described
   below; this remains staging validation rather than public-launch approval.
3. Student signs in, enters the class code, and requests access.
4. Teacher approves the request; the student sees the class without refreshing
   repeatedly.
5. Student writes a synthetic German text, waits for **Saved**, reloads once,
   confirms the exact text is restored, and submits it to the selected class.
6. Confirm the chosen feedback contract:
   - **Immediate:** validated feedback becomes available automatically.
   - **Scheduled:** feedback stays private before the due time and releases at
     the configured time.
   - **Teacher review:** the draft stays private until the teacher edits,
     approves, and releases it.
7. Student opens released feedback and confirms paragraphs, spacing, original
   text, corrections, explanations, and grammar-topic labels are readable.
8. If a weakness unlocks practice, the student opens the worksheet. If no
   worksheet exists yet, use **Prepare worksheet** and confirm progress appears
   promptly and usable material arrives without teacher approval.
9. Answer at least two questions, wait for **Saved**, reload, and confirm every
   answer is restored. Complete and submit the worksheet, then confirm the score
   and per-question review appear.
10. Teacher checks the student's writing and practice history. No private draft,
    provider error, internal database detail, or another student's work may be
    visible.

## Pass criteria

- No lost writing, lost worksheet answers, stuck loading state, blank worksheet,
  raw technical error, cross-account data, or private feedback exposure.
- Writing submission is acknowledged promptly and ordinary feedback completes
  within 60 seconds.
- Worksheet progress appears within five seconds. Generated material should
  complete within 90 seconds; an eligible reused worksheet should open within
  two seconds.
- Refreshing or navigating away never silently changes the selected class.
- The teacher can understand what requires action without technical help.

## Reporting a problem

Report the role, page, local time, feedback mode, class level, visible safe error
code (if any), and the last action taken. Do not include passwords,
authenticator codes, API keys, full student writing, or database/provider
payloads. Mark lost work, exposed private/cross-account data, or a student who
cannot receive writing feedback or practice material as launch-blocking.

## Current certification boundary

The 2026-07-14 post-deployment staging snapshot passed the sequential real A1,
A2, B1, and B2 generated-worksheet matrix in 55.7, 56.3, 57.1, and 53.5
seconds. Every level showed technically operable rendered material, restored
autosaved answers after reload, reached terminal scoring, recorded both
provider-validation layers, and completed exact cleanup. A fresh live
writing-feedback journey passed in 26.0 seconds with autosave/reload, released
validated feedback, and exact cleanup. A fresh teacher/student core journey
also passed class creation, join request, teacher approval, explicit class
selection, and cleanup in 1.4 minutes. The teacher-review and scheduled-feedback
workflow passed previously and is unchanged by the deployed request-reader
hardening. The current broad gates pass 562 frontend tests, 609 scripts tests,
543 Edge Function tests,
30 linked database files with 854 assertions, 13 public browser tests, and 11
practice-state/responsive browser tests. Typecheck, the production-mode build,
and the production dependency audit are green. The final eight-route
teacher/student performance run also passed 20 measured reloads per route:
every p95 was between 0.83 and 1.32 seconds, with zero unreviewed duplicate
reads. The exact hosted frontend artifact also passed a fresh 2/2 teacher and
student authenticated navigation run after the Edge deployment, with no fatal
browser error or HTTP 5xx. Only the three reviewed staging Edge Functions were
updated: writing preparation is active at version 56, worksheet generation at
version 66, and worksheet evaluation at version 48.

This is controlled teacher UAT, not public-launch certification. The audit
ledger still has 29 unresolved launch findings (5 P0 and 24 P1), including
qualified German and privacy review, canonical-bank publication, remaining
administrator/authenticated browser evidence, provider/job and production-load
evidence, and complete database replay evidence, independent security review,
clean production and
monitoring setup, and the controlled pilot exit gates. The current source of
truth is `docs/V1_AUDIT_TRACEABILITY.md`; none of those gates is waived by this
handoff.
