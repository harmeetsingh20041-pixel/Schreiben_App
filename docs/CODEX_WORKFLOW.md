# Codex Workflow

## Branching

- Never work directly on `main`.
- Create one branch per phase.
- Phase 1 branch: `phase-1-repo-audit-and-plan`.
- Keep `main` unmerged and uncommitted unless the user explicitly approves a merge.
- Do not merge phase branches into `main` without user confirmation.

## UI Preservation

- The current frontend is visually approved.
- Do not redesign it.
- Do not replace the UI.
- Do not remove animations.
- Do not simplify the visual design.
- Do not break existing student or teacher flows.
- Prefer replacing data/service layers behind the current components.

## Package Manager

- Use pnpm only.
- Do not use npm.
- Do not use yarn.
- Do not delete pnpm workspace configuration.

## Testing

- Inspect scripts before running commands.
- Run relevant commands for every phase.
- At minimum, run:
  - `pnpm install` if dependencies are missing or lockfile/config changed
  - `pnpm run typecheck`
  - `pnpm run build`
- Run app-specific lint/test scripts if they exist.
- If a command fails, report:
  - command
  - error summary
  - likely cause
  - what was tried
  - recommended next step

## Honesty

- Do not claim a command passed unless it was run and passed.
- Do not claim a file changed unless it actually changed.
- Do not claim a feature works unless it was tested.
- Do not hallucinate repo structure.
- If unsure, inspect and say what is unknown.
- Do not hide failing tests.
- Do not silently ignore TypeScript errors.

## Security

- Do not expose API keys in frontend code.
- Do not hardcode secrets.
- Do not add real credentials.
- Do not add payment logic unless explicitly requested in a later phase.
- Treat user text as untrusted data.
- Keep DeepSeek and service-role Supabase operations server-side.

## Reporting

Final reports should include:

- branch name
- files created/changed
- commands run
- commands passed
- commands failed
- exact failure summaries
- whether UI was changed
- whether `main` was merged or untouched
- recommended next phase
- whether the branch is ready for user review

