# Supabase CLI Setup (Historical Staging Record)

> [!WARNING]
> Historical staging record — not production. The project identifiers and CLI
> results below describe the original test environment only. Never link, push,
> seed, or generate production types by copying commands from this file. Follow
> [`V1_LAUNCH_RUNBOOK.md`](./V1_LAUNCH_RUNBOOK.md) and the project-identity
> checks in [`PRODUCTION_PREFLIGHT.md`](./PRODUCTION_PREFLIGHT.md) for production.

Phase 3 historically targeted this staging/test project:

- Historical staging project ref: `vzcgalzspdehmnvqczfw`
- Historical staging project URL: `https://vzcgalzspdehmnvqczfw.supabase.co`

## Historical CLI Status

`supabase --version` was checked first and the standalone CLI was not installed on this Mac.

Official macOS install command:

```sh
brew install supabase/tap/supabase
```

Homebrew was not available in this shell, so the CLI was run through `pnpm dlx supabase` with Codex's bundled Node runtime. That reported Supabase CLI `2.109.0`.

## Login And Link

The staging project was linked successfully. The equivalent form is shown with
a placeholder deliberately; verify the target independently before any use:

```sh
supabase login
supabase link --project-ref <verified-staging-project-ref>
```

If `supabase link` asks for the database password, enter it directly in the terminal prompt. Do not paste it into chat and do not commit it.

## Historical Staging Migration Commands

After the historical staging link was verified, these commands were used there:

```sh
supabase db push
supabase gen types typescript --linked > artifacts/german-writing-coach/src/types/supabase.ts
```

This CLI version did not expose `supabase db seed`. The seed file was applied with:

```sh
supabase db query --linked --file supabase/seed.sql
```

The historical staging migration list at the end of Phase 3 contained:

- `202607040001_initial_schema.sql`
- `202607040002_auth_foundation_hardening.sql`
- `202607040003_security_advisor_fixes.sql`
- `202607040004_move_privileged_helpers_private.sql`
- `202607040005_split_manage_policies.sql`
- `20260704085609_allow_workspace_owner_onboarding.sql`

Supabase security and performance advisors were rerun against staging after
those migrations. At that time, performance reported no issues and staging
reported one Auth warning: leaked-password protection was disabled. This is not
evidence of current production configuration; production preflight verifies
the setting independently.

## Local Environment

The historical local staging app used:

```sh
VITE_SUPABASE_URL=<verified-staging-project-url>
VITE_SUPABASE_ANON_KEY=<publishable-or-anon-key>
```

The local file is `artifacts/german-writing-coach/.env.local`. It is intentionally gitignored.

## Email-Safe Testing

Remote staging Auth tests must use real reachable email addresses or owned Gmail
aliases. Do not run these tests against production, create fake remote Auth
users, or resend confirmations to unreachable addresses. Use Mailpit only with
local Supabase testing.

See `docs/SUPABASE_EMAIL_TESTING_POLICY.md` for the full policy.
