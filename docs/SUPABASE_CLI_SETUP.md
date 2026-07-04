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

Homebrew was not available in this shell, so the CLI was tested through `pnpm dlx supabase` with Codex's bundled Node runtime. That reported Supabase CLI `2.109.0`.

## Login And Link

The intended commands are:

```sh
supabase login
supabase link --project-ref vzcgalzspdehmnvqczfw
```

If `supabase link` asks for the database password, enter it directly in the terminal prompt. Do not paste it into chat and do not commit it.

## Migration Commands

After login and link:

```sh
supabase db push
supabase db seed
supabase gen types typescript --linked > artifacts/german-writing-coach/src/types/supabase.ts
```

If `supabase db seed` is unavailable, apply the seed file manually in SQL Editor:

```sql
-- Paste the contents of supabase/seed.sql into Supabase SQL Editor.
```

## Local Environment

The local app reads:

```sh
VITE_SUPABASE_URL=https://vzcgalzspdehmnvqczfw.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable-or-anon-key>
```

The local file is `artifacts/german-writing-coach/.env.local`. It is intentionally gitignored.
