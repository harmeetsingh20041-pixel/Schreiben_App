import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertApprovedProductionEdgeArtifactRoot } from "./production-edge-functions.js";

const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

export type ArtifactRoot = { label: string; path: string };

export type ReleaseArtifactManifest = {
  schema_version: 1;
  release: string;
  supabase_project_ref: string;
  created_at: string;
  aggregate_sha256: string;
  roots: Array<{
    label: string;
    files: Array<{ path: string; size: number; sha256: string }>;
  }>;
};

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelativePath(root: string, file: string) {
  const value = relative(root, file).split(sep).join("/");
  if (!value || value.startsWith("../") || value.includes("\0")) {
    throw new Error("Artifact path escapes its declared root.");
  }
  return value;
}

async function collectFiles(root: string) {
  const rootStats = await stat(root);
  if (!rootStats.isDirectory())
    throw new Error("Artifact root must be a directory.");
  const pending = [root];
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Artifact roots cannot contain symlinks.");
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile())
        throw new Error("Artifact roots contain an unsupported file type.");
      const path = safeRelativePath(root, absolute);
      if (path.endsWith(".map")) {
        throw new Error(
          "Public source maps must be deleted before artifact capture.",
        );
      }
      if (/(^|\/)\.env(?:\.|$)/.test(path)) {
        throw new Error(
          "Environment files cannot be included in release artifacts.",
        );
      }
      const contents = await readFile(absolute);
      files.push({ path, size: contents.byteLength, sha256: sha256(contents) });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function createReleaseArtifactManifest(input: {
  release: string;
  frontendRoot: string;
  roots: ArtifactRoot[];
  outputPath: string;
  createdAt?: string;
}): Promise<ReleaseArtifactManifest> {
  if (!RELEASE_PATTERN.test(input.release))
    throw new Error("Release identifier is invalid.");
  if (!isAbsolute(input.outputPath))
    throw new Error("Manifest output must be an absolute path.");
  const launchManifest = JSON.parse(
    await readFile(resolve(input.frontendRoot, "launch-manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  if (
    launchManifest.schema_version !== 1 ||
    launchManifest.app_release !== input.release ||
    !PROJECT_REF_PATTERN.test(
      String(launchManifest.supabase_project_ref ?? ""),
    ) ||
    launchManifest.demo_mode_enabled !== false ||
    launchManifest.public_teacher_signup_enabled !== false ||
    launchManifest.public_student_signup_enabled !== true ||
    launchManifest.sentry_source_maps_configured !== true
  ) {
    throw new Error(
      "Deployed launch manifest does not satisfy production artifact invariants.",
    );
  }

  const labels = input.roots.map((root) => root.label);
  const requiredLabels = ["frontend", "edge-functions", "database-migrations"];
  if (
    input.roots.length !== requiredLabels.length ||
    labels.some((label) => !/^[a-z][a-z0-9_-]{2,40}$/.test(label)) ||
    new Set(labels).size !== labels.length ||
    requiredLabels.some((label) => !labels.includes(label))
  ) {
    throw new Error(
      "Artifact roots must be exactly frontend, edge-functions, and database-migrations.",
    );
  }

  const edgeRoot = input.roots.find((root) => root.label === "edge-functions")!;
  await assertApprovedProductionEdgeArtifactRoot(resolve(edgeRoot.path));

  const roots = await Promise.all(
    input.roots.map(async (root) => ({
      label: root.label,
      files: await collectFiles(resolve(root.path)),
    })),
  );
  if (roots.some((root) => root.files.length === 0)) {
    throw new Error("Artifact roots cannot be empty.");
  }
  const aggregateInput = roots
    .flatMap((root) =>
      root.files.map(
        (file) => `${root.label}:${file.path}:${file.size}:${file.sha256}`,
      ),
    )
    .join("\n");
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt)))
    throw new Error("Artifact timestamp is invalid.");
  const manifest: ReleaseArtifactManifest = {
    schema_version: 1,
    release: input.release,
    supabase_project_ref: String(launchManifest.supabase_project_ref),
    created_at: createdAt,
    aggregate_sha256: sha256(aggregateInput),
    roots,
  };

  await mkdir(dirname(input.outputPath), { recursive: true });
  const handle = await open(input.outputPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return manifest;
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const release = argument("--release");
  const frontend = argument("--frontend");
  const edge = argument("--edge");
  const migrations = argument("--migrations");
  const output = argument("--output");
  if (!release || !frontend || !edge || !migrations || !output) {
    throw new Error(
      "Usage: release:artifact:manifest -- --release <id> --frontend <dir> --edge <dir> --migrations <dir> --output </absolute/file.json>",
    );
  }
  const manifest = await createReleaseArtifactManifest({
    release,
    frontendRoot: resolve(frontend),
    roots: [
      { label: "frontend", path: resolve(frontend) },
      { label: "edge-functions", path: resolve(edge) },
      { label: "database-migrations", path: resolve(migrations) },
    ],
    outputPath: output,
  });
  process.stdout.write(
    `${JSON.stringify({
      release: manifest.release,
      supabase_project_ref: manifest.supabase_project_ref,
      aggregate_sha256: manifest.aggregate_sha256,
      file_count: manifest.roots.reduce(
        (total, root) => total + root.files.length,
        0,
      ),
    })}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Artifact manifest failed."}\n`,
    );
    process.exitCode = 1;
  });
}
