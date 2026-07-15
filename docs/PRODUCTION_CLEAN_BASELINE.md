# Clean Production Baseline Gate

This gate proves that the launch project started from the migration history and
does not contain staging, demo, teacher, student, submission, feedback, practice,
Auth-user, or Storage-object data. It is a read-only release gate. It never
deletes, truncates, updates, imports, or repairs production data.

Run it once after the complete migration history has been replayed into the new
production project and before creating production users or importing the
qualified worksheet bank. After real launch data exists, the gate is expected to
fail and must not be used as a cleanup tool.

## What is checked

The checked-in contract is
[`config/production-clean-baseline-contract.json`](../config/production-clean-baseline-contract.json).
It explicitly classifies every base table created by the application migrations
in `api`, `app_private`, and `public`. The scripts test that this classification
remains exhaustive when migrations add or remove a table.

The gate requires:

- every tenant, teacher, student, batch, submission, feedback, worksheet,
  attempt, adaptive-practice, draft, queue, audit-action, and usage relation to
  contain zero rows, except the single migration-authored immutable global
  budget-change record described below;
- all six PGMQ live/archive tables for writing evaluation, worksheet generation,
  and worksheet-answer evaluation to contain zero rows, while `pgmq.meta`
  contains exactly those three expected queue names;
- every current privacy-bearing Auth table—including users, identities,
  sessions, refresh/one-time tokens, flow state, audit logs, MFA, SAML/SSO,
  OAuth, and WebAuthn state—to contain zero rows; only Auth's `instances` and
  `schema_migrations` system tables are exempt from the zero-row rule;
- every current payload-bearing Storage table—including file, analytics,
  vector, Iceberg, and multipart-upload metadata—to contain zero rows; only
  Storage's migration-history table is exempt;
- the live Auth and Storage base-table catalogs to exactly match those explicit
  classifications, so a new platform table fails closed until reviewed;
- only the explicitly allowlisted reference/configuration seeds to exist:
  47 global A2 writing prompts, 36 closed grammar topics, 107 grammar aliases,
  13 provider-price policies, one row in each security/spend policy table, and
  the one audited USD 500-to-USD 225 global cap revision created by Phase 12T;
- the recovery heartbeat to contain at most its single operational bootstrap
  row;
- the disposable reset-local migration history and production history to match
  by version, name, statement count, and SHA-256 statement fingerprint before
  the zero-data collector starts; and
- the local SHA-256 migration aggregate, contract SHA-256, project ref,
  application release, exact Git source revision, and collection time to remain
  bound to the evidence.

Seed validation uses row counts and SHA-256 fingerprints of every
launch-relevant, non-secret value: the complete global prompt records, grammar
display values and descriptions, alias mappings, queue names, and security-limit
settings. Fingerprint ordering uses the deterministic PostgreSQL `C` collation.
The database computes each fingerprint before returning the result. Prompts,
answers, names, emails, student writing, provider payloads, credentials, and raw
rows are never included in the evidence or report.

## Protected GitHub workflow

Use **Actions → Verify → Run workflow** on `main` and enable **Run the clean
production zero-data baseline gate**. This first runs a dedicated migration
statement-parity prerequisite against a disposable reset-local database; only
then can the zero-data collector start. Both jobs use the protected `production`
environment, so the repository's required reviewers and environment protections
apply.

Do not make this baseline depend on the full production preflight: that later
gate reconciles the imported 184-worksheet launch bank, while this baseline must
run before any worksheet rows exist. The correct order is migrations → migration
parity → clean baseline → approved worksheet import → full production preflight.

Configure:

- environment variable `PRODUCTION_PROJECT_REF`;
- environment variable `PRODUCTION_VITE_APP_RELEASE`; and
- secret `SUPABASE_ACCESS_TOKEN` with only the Management API permissions needed
  to read the project identity and run a read-only database query
  (`project_admin_read` and `database_read`).

The collector calls Supabase's Management API project endpoint and the
`database/query/read-only` endpoint over HTTPS. The latter executes as
`supabase_read_only_user`; every relation in the generated SQL is schema
qualified. See the official
[Management API reference](https://supabase.com/docs/reference/api/getting-started).

The workflow uploads only the sanitized count/fingerprint evidence and the
pass/fail report. Credentials are supplied through the protected environment and
are never written to either artifact. Collection and verification run
back-to-back in the same protected shell step to minimize the zero-data
time-of-check window.

## Local command shape

Collection intentionally requires an absolute output path and creates the file
with owner-only permissions. It refuses to overwrite an existing file.

```bash
export PRODUCTION_PROJECT_REF="<20-character-production-ref>"
export VITE_APP_RELEASE="<immutable-release-id>"
export GITHUB_SHA="<40-character-source-revision>"
export SUPABASE_ACCESS_TOKEN="<read-only-management-token>"

pnpm production:clean-baseline:collect -- \
  --project-ref "$PRODUCTION_PROJECT_REF" \
  --release "$VITE_APP_RELEASE" \
  --source-revision "$GITHUB_SHA" \
  --output "/absolute/private/path/production-clean-baseline.json"

pnpm production:clean-baseline:verify -- \
  --project-ref "$PRODUCTION_PROJECT_REF" \
  --release "$VITE_APP_RELEASE" \
  --source-revision "$GITHUB_SHA" \
  --evidence "/absolute/private/path/production-clean-baseline.json" \
  --report-output "/absolute/private/path/production-clean-baseline-report.json"
```

Evidence expires after two minutes. Re-collect it for the exact checkout and
release if the contract, migrations, project, release, or time window changes.
Keep production frozen between this gate and the approved initialization steps:
public signup must remain disabled and no administrator should write data during
that interval.

The local commands validate the zero-data evidence only. Launch certification
also requires migration statement parity, the later full production-preflight
job after worksheet import, and one live run against the disposable clean
production project; mocked unit tests do not replace those external gates.

## Failure handling

Any missing relation, new unclassified application table, extra row, live or
archived queue message, changed seed/config fingerprint, Auth user, Storage
object, project mismatch, release mismatch, migration mismatch, malformed
response, stale timestamp, or network failure closes the gate.

Do not run a broad cleanup against a failed production project. Investigate the
count-only report. Before launch, the safe response to unexplained data is to
stop the release and provision another empty production project, then replay the
migrations and rerun the gate.
