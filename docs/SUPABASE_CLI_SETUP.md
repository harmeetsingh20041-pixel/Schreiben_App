# Supabase CLI Setup

Phase 3 targets the Supabase project:

- Project ref: `vzcgalzspdehmnvqczfw`
- Project URL: `https://vzcgalzspdehmnvqczfw.supabase.co`

## CLI Status

`supabase --version` was checked first and the standalone CLI was not installed on this Mac.

Official macOS install command:

```sh
brew install supabase/tap/supabase
```

Homebrew was not available in this shell, so the CLI was run through `pnpm dlx supabase` with Codex's bundled Node runtime. That reported Supabase CLI `2.109.0`.

## Login And Link

The project was linked successfully with:

```sh
supabase login
supabase link --project-ref vzcgalzspdehmnvqczfw
```

If `supabase link` asks for the database password, enter it directly in the terminal prompt. Do not paste it into chat and do not commit it.

## Migration Commands

After login and link, these commands were used:

```sh
supabase db push
supabase gen types typescript --linked > artifacts/german-writing-coach/src/types/supabase.ts
```

This CLI version did not expose `supabase db seed`. The seed file was applied with:

```sh
supabase db query --linked --file supabase/seed.sql
```

The final linked migration list contains:

- `202607040001_initial_schema.sql`
- `202607040002_auth_foundation_hardening.sql`
- `202607040003_security_advisor_fixes.sql`
- `202607040004_move_privileged_helpers_private.sql`
- `202607040005_split_manage_policies.sql`

Supabase security and performance advisors were rerun after the final migrations and reported no issues.

## Local Environment

The local app reads:

```sh
VITE_SUPABASE_URL=https://vzcgalzspdehmnvqczfw.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable-or-anon-key>
```

The local file is `artifacts/german-writing-coach/.env.local`. It is intentionally gitignored.
