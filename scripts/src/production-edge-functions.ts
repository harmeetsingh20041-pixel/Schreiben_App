import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export const APPROVED_PRODUCTION_EDGE_FUNCTIONS = [
  "prepare-writing-feedback",
  "process-due-feedback",
  "generate-practice-worksheet",
  "evaluate-practice-attempt",
  "kick-writing-jobs",
  "process-writing-jobs",
  "process-worksheet-generation-jobs",
  "process-worksheet-answer-jobs",
  "recover-async-jobs",
] as const;

export const PRODUCTION_EDGE_SHARED_DIRECTORY = "_shared";

export const APPROVED_PRODUCTION_EDGE_DIRECTORIES = [
  PRODUCTION_EDGE_SHARED_DIRECTORY,
  ...APPROVED_PRODUCTION_EDGE_FUNCTIONS,
] as const;

function sameStringSet(left: readonly string[], right: readonly string[]) {
  const expected = new Set<string>(right);
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => expected.has(value))
  );
}

export function hasExactApprovedProductionEdgeFunctions(
  values: readonly string[],
) {
  return sameStringSet(values, APPROVED_PRODUCTION_EDGE_FUNCTIONS);
}

export async function assertApprovedProductionEdgeArtifactRoot(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name);
  if (
    !entries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink()) ||
    !sameStringSet(names, APPROVED_PRODUCTION_EDGE_DIRECTORIES)
  ) {
    throw new Error(
      "Artifact root does not match the approved production Edge Function inventory.",
    );
  }

  for (const slug of APPROVED_PRODUCTION_EDGE_FUNCTIONS) {
    const entrypoint = await lstat(resolve(root, slug, "index.ts")).catch(
      () => null,
    );
    if (!entrypoint || !entrypoint.isFile() || entrypoint.isSymbolicLink()) {
      throw new Error(
        `Approved production Edge Function is missing a regular entrypoint: ${slug}.`,
      );
    }
  }

  const sharedEntries = await readdir(
    resolve(root, PRODUCTION_EDGE_SHARED_DIRECTORY),
    { withFileTypes: true },
  );
  if (
    !sharedEntries.some(
      (entry) =>
        entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".ts"),
    )
  ) {
    throw new Error(
      "Production Edge artifact is missing required shared code.",
    );
  }
}
