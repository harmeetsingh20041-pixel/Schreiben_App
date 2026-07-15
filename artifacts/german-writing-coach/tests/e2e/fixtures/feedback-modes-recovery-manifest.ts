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

export interface FeedbackModesRecoveryManifest {
  schema_version: 1;
  project_ref: string;
  workspace_id: string;
  teacher_membership_id: string;
  teacher_profile_id: string;
  student_profile_id: string;
  teacher_membership_count: number;
  teacher_membership_fingerprint: string;
  student_membership_count: number;
  student_membership_fingerprint: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;
const PRIVATE_DIRECTORY_NAME = ".e2e-private";
const MANIFEST_FILE_NAME = "feedback-modes-fixture.json";
const MANIFEST_KEYS = [
  "project_ref",
  "schema_version",
  "student_membership_count",
  "student_membership_fingerprint",
  "student_profile_id",
  "teacher_membership_count",
  "teacher_membership_fingerprint",
  "teacher_membership_id",
  "teacher_profile_id",
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
      "The feedback-mode recovery manifest cannot verify local ownership.",
    );
  }
  return process.getuid();
}

function manifestPathScope(path: string): ManifestPathScope {
  if (!isAbsolute(path) || path !== resolve(path)) {
    throw new Error("The feedback-mode recovery manifest path is unsafe.");
  }
  const directory = dirname(path);
  if (
    basename(directory) !== PRIVATE_DIRECTORY_NAME ||
    basename(path) !== MANIFEST_FILE_NAME
  ) {
    throw new Error("The feedback-mode recovery manifest path is unsafe.");
  }
  return {
    path,
    directory,
    workspaceRoot: dirname(directory),
  };
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
    throw new Error("The feedback-mode recovery manifest path is unsafe.");
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

function parseManifest(
  value: unknown,
  expectedProjectRef: string,
): FeedbackModesRecoveryManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The feedback-mode recovery manifest is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
    JSON.stringify([...MANIFEST_KEYS].sort())
  ) {
    throw new Error("The feedback-mode recovery manifest has unknown fields.");
  }
  if (
    record.schema_version !== 1 ||
    record.project_ref !== expectedProjectRef
  ) {
    throw new Error(
      "The feedback-mode recovery manifest targets another scope.",
    );
  }
  for (const key of [
    "workspace_id",
    "teacher_membership_id",
    "teacher_profile_id",
    "student_profile_id",
  ] as const) {
    if (typeof record[key] !== "string" || !UUID_PATTERN.test(record[key])) {
      throw new Error(
        "The feedback-mode recovery manifest contains an invalid ID.",
      );
    }
  }
  for (const key of [
    "teacher_membership_count",
    "student_membership_count",
  ] as const) {
    if (
      typeof record[key] !== "number" ||
      !Number.isSafeInteger(record[key]) ||
      record[key] < 0
    ) {
      throw new Error(
        "The feedback-mode recovery manifest contains an invalid count.",
      );
    }
  }
  for (const key of [
    "teacher_membership_fingerprint",
    "student_membership_fingerprint",
  ] as const) {
    if (
      typeof record[key] !== "string" ||
      !FINGERPRINT_PATTERN.test(record[key])
    ) {
      throw new Error(
        "The feedback-mode recovery manifest contains an invalid fingerprint.",
      );
    }
  }
  return record as unknown as FeedbackModesRecoveryManifest;
}

function serializeManifest(
  manifest: FeedbackModesRecoveryManifest,
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
    throw new Error("The feedback-mode recovery manifest path is unsafe.");
  }
  return inspection.scope;
}

export async function readFeedbackModesRecoveryManifest(
  path: string,
  expectedProjectRef: string,
): Promise<FeedbackModesRecoveryManifest | null> {
  const directoryInspection = await inspectPrivateDirectory(path);
  if (!directoryInspection.exists) return null;
  let metadata;
  try {
    metadata = await lstat(directoryInspection.scope.path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUserId()
  ) {
    throw new Error("The feedback-mode recovery manifest path is unsafe.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("The feedback-mode recovery manifest is not owner-only.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(directoryInspection.scope.path, "utf8"));
  } catch {
    throw new Error("The feedback-mode recovery manifest is unreadable.");
  }
  return parseManifest(parsed, expectedProjectRef);
}

export async function createFeedbackModesRecoveryManifest(
  path: string,
  manifest: FeedbackModesRecoveryManifest,
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

export async function removeFeedbackModesRecoveryManifest(
  path: string,
  expectedProjectRef: string,
) {
  const current = await readFeedbackModesRecoveryManifest(
    path,
    expectedProjectRef,
  );
  if (!current) return;
  const inspection = await inspectPrivateDirectory(path);
  if (!inspection.exists) {
    throw new Error("The feedback-mode recovery manifest disappeared.");
  }
  await rm(inspection.scope.path);
  await assertOwnedRealDirectory(inspection.scope.directory, true);
  await rmdir(inspection.scope.directory).catch((error) => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOTEMPTY" && code !== "ENOENT") throw error;
  });
}
