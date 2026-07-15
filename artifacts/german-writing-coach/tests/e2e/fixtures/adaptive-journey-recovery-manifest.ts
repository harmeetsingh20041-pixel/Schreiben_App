import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rm,
  rmdir,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export interface AdaptiveJourneyRecoveryManifest {
  schema_version: 1;
  project_ref: string;
  workspace_id: string;
  teacher_membership_id: string;
  student_membership_id: string;
  batch_id: string;
  batch_student_id: string;
  grammar_topic_id: string;
  first_submission_id: string;
  recurrence_submission_id: string;
  practice_test_ids: [string, string];
  question_ids: [string, string, string, string];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_DIRECTORY_NAME = ".e2e-private";
const MANIFEST_FILE_NAME = "adaptive-journey-fixture.json";
const MANIFEST_KEYS = [
  "batch_id",
  "batch_student_id",
  "first_submission_id",
  "grammar_topic_id",
  "practice_test_ids",
  "project_ref",
  "question_ids",
  "recurrence_submission_id",
  "schema_version",
  "student_membership_id",
  "teacher_membership_id",
  "workspace_id",
] as const;

interface ManifestPathScope {
  path: string;
  directory: string;
  workspaceRoot: string;
}

function isMissingFile(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function currentUserId() {
  if (typeof process.getuid !== "function") {
    throw new Error(
      "The adaptive-journey recovery manifest cannot verify local ownership.",
    );
  }
  return process.getuid();
}

function manifestPathScope(path: string): ManifestPathScope {
  if (!isAbsolute(path) || path !== resolve(path)) {
    throw new Error("The adaptive-journey recovery manifest path is unsafe.");
  }
  const directory = dirname(path);
  if (
    basename(directory) !== PRIVATE_DIRECTORY_NAME ||
    basename(path) !== MANIFEST_FILE_NAME
  ) {
    throw new Error("The adaptive-journey recovery manifest path is unsafe.");
  }
  return { path, directory, workspaceRoot: dirname(directory) };
}

async function assertOwnedRealDirectory(
  path: string,
  requireOwnerOnly: boolean,
) {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUserId() ||
    (requireOwnerOnly && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error("The adaptive-journey recovery manifest path is unsafe.");
  }
  return metadata;
}

async function inspectPrivateDirectory(path: string) {
  const scope = manifestPathScope(path);
  await assertOwnedRealDirectory(scope.workspaceRoot, false);
  try {
    await assertOwnedRealDirectory(scope.directory, true);
  } catch (error) {
    if (isMissingFile(error)) return { scope, exists: false as const };
    throw error;
  }
  return { scope, exists: true as const };
}

function uuidTuple(value: unknown, length: number) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(
      (entry) => typeof entry === "string" && UUID_PATTERN.test(entry),
    )
  );
}

function parseManifest(
  value: unknown,
  expectedProjectRef: string,
): AdaptiveJourneyRecoveryManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The adaptive-journey recovery manifest is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
    JSON.stringify([...MANIFEST_KEYS].sort())
  ) {
    throw new Error(
      "The adaptive-journey recovery manifest has unknown fields.",
    );
  }
  if (
    record.schema_version !== 1 ||
    record.project_ref !== expectedProjectRef
  ) {
    throw new Error(
      "The adaptive-journey recovery manifest targets another scope.",
    );
  }
  for (const key of [
    "workspace_id",
    "teacher_membership_id",
    "student_membership_id",
    "batch_id",
    "batch_student_id",
    "grammar_topic_id",
    "first_submission_id",
    "recurrence_submission_id",
  ] as const) {
    if (typeof record[key] !== "string" || !UUID_PATTERN.test(record[key])) {
      throw new Error(
        "The adaptive-journey recovery manifest contains an invalid ID.",
      );
    }
  }
  if (
    !uuidTuple(record.practice_test_ids, 2) ||
    !uuidTuple(record.question_ids, 4)
  ) {
    throw new Error(
      "The adaptive-journey recovery manifest contains an invalid ID.",
    );
  }
  return record as unknown as AdaptiveJourneyRecoveryManifest;
}

function serializeManifest(
  manifest: AdaptiveJourneyRecoveryManifest,
  expectedProjectRef: string,
) {
  return `${JSON.stringify(parseManifest(manifest, expectedProjectRef), null, 2)}\n`;
}

async function preparePrivateDirectory(path: string) {
  const inspection = await inspectPrivateDirectory(path);
  if (!inspection.exists) {
    await mkdir(inspection.scope.directory, { mode: 0o700 });
  }
  const metadata = await assertOwnedRealDirectory(
    inspection.scope.directory,
    true,
  );
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error("The adaptive-journey recovery manifest path is unsafe.");
  }
  return inspection.scope;
}

export async function readAdaptiveJourneyRecoveryManifest(
  path: string,
  expectedProjectRef: string,
): Promise<AdaptiveJourneyRecoveryManifest | null> {
  const inspection = await inspectPrivateDirectory(path);
  if (!inspection.exists) return null;
  let metadata;
  try {
    metadata = await lstat(inspection.scope.path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUserId()
  ) {
    throw new Error("The adaptive-journey recovery manifest path is unsafe.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      "The adaptive-journey recovery manifest is not owner-only.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(inspection.scope.path, "utf8"));
  } catch {
    throw new Error("The adaptive-journey recovery manifest is unreadable.");
  }
  return parseManifest(parsed, expectedProjectRef);
}

export async function createAdaptiveJourneyRecoveryManifest(
  path: string,
  manifest: AdaptiveJourneyRecoveryManifest,
  expectedProjectRef: string,
) {
  const scope = await preparePrivateDirectory(path);
  const temporaryPath = `${scope.path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(
      serializeManifest(manifest, expectedProjectRef),
      "utf8",
    );
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    await assertOwnedRealDirectory(scope.directory, true);
    await link(temporaryPath, scope.path);
    await rm(temporaryPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeAdaptiveJourneyRecoveryManifest(
  path: string,
  expectedProjectRef: string,
) {
  const current = await readAdaptiveJourneyRecoveryManifest(
    path,
    expectedProjectRef,
  );
  if (!current) return;
  const inspection = await inspectPrivateDirectory(path);
  if (!inspection.exists) {
    throw new Error("The adaptive-journey recovery manifest disappeared.");
  }
  await rm(inspection.scope.path);
  await assertOwnedRealDirectory(inspection.scope.directory, true);
  await rmdir(inspection.scope.directory).catch((error) => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOTEMPTY" && code !== "ENOENT") throw error;
  });
}
