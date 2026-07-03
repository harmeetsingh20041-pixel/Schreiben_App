---
name: Design subagent mock-data edits
description: Async DESIGN subagents editing large mock data arrays (e.g. mockData.ts) can silently drop export declarations or brackets, breaking the build.
---

When an async DESIGN subagent adds new mock data (e.g. new exercise/topic arrays) into an existing large `mockData.ts` file, it can accidentally merge two array literals or drop the `export const X: Type[] = ` declaration for an existing array, producing a cascade of `TS1005 ';' expected` errors starting partway through the file.

**Why:** Subagents insert new content near existing arrays and sometimes edit the closing `];` of one array while adding the next, losing the following declaration's `export const name: Type[] =` prefix.

**How to apply:** Always run `pnpm --filter <artifact> run typecheck` immediately after a design subagent reports completion, before restarting the workflow or presenting to the user. If you see a long run of `TS1005`/`TS1128` errors starting at one line in a data file, check for a missing `export const ... = [` declaration just above that line rather than assuming a deeper logic bug.
