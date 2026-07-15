import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_PRODUCTION_EDGE_DIRECTORIES,
  APPROVED_PRODUCTION_EDGE_FUNCTIONS,
  assertApprovedProductionEdgeArtifactRoot,
} from "./production-edge-functions.js";

function isWithin(parent: string, candidate: string) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function copyDirectory(source: string, output: string): Promise<number> {
  await mkdir(output, { mode: 0o700 });
  let fileCount = 0;
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = resolve(source, entry.name);
    const outputPath = resolve(output, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Production Edge source cannot contain symlinks.");
    }
    if (entry.isDirectory()) {
      fileCount += await copyDirectory(sourcePath, outputPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        "Production Edge source contains an unsupported file type.",
      );
    }
    await copyFile(sourcePath, outputPath);
    fileCount += 1;
  }
  return fileCount;
}

export async function createProductionEdgeArtifact(input: {
  sourceRoot: string;
  outputRoot: string;
}) {
  if (!isAbsolute(input.outputRoot)) {
    throw new Error(
      "Production Edge artifact output must be an absolute path.",
    );
  }
  const sourceRoot = resolve(input.sourceRoot);
  const outputRoot = resolve(input.outputRoot);
  if (isWithin(sourceRoot, outputRoot)) {
    throw new Error(
      "Production Edge artifact output must be outside its source root.",
    );
  }
  const sourceStats = await lstat(sourceRoot);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error(
      "Production Edge artifact source must be a regular directory.",
    );
  }

  for (const directory of APPROVED_PRODUCTION_EDGE_DIRECTORIES) {
    const sourceDirectory = resolve(sourceRoot, directory);
    const sourceDirectoryStats = await lstat(sourceDirectory).catch(() => null);
    if (
      !sourceDirectoryStats ||
      !sourceDirectoryStats.isDirectory() ||
      sourceDirectoryStats.isSymbolicLink()
    ) {
      throw new Error(
        `Required production Edge source is missing: ${directory}.`,
      );
    }
  }

  let created = false;
  try {
    await mkdir(outputRoot, { mode: 0o700 });
    created = true;
    let fileCount = 0;
    for (const directory of APPROVED_PRODUCTION_EDGE_DIRECTORIES) {
      fileCount += await copyDirectory(
        resolve(sourceRoot, directory),
        resolve(outputRoot, directory),
      );
    }
    await assertApprovedProductionEdgeArtifactRoot(outputRoot);
    return {
      function_slugs: [...APPROVED_PRODUCTION_EDGE_FUNCTIONS],
      file_count: fileCount,
    };
  } catch (error) {
    if (created) await rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const source = argument("--source");
  const output = argument("--output");
  if (!source || !output) {
    throw new Error(
      "Usage: release:artifact:edge -- --source <supabase/functions> --output </absolute/directory>",
    );
  }
  const result = await createProductionEdgeArtifact({
    sourceRoot: resolve(source),
    outputRoot: output,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Production Edge artifact failed."}\n`,
    );
    process.exitCode = 1;
  });
}
