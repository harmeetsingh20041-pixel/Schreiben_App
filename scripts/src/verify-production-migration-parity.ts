import { execFile } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type MigrationHistoryFingerprint,
  buildMigrationHistoryQuery,
  fingerprintMigrationHistory,
  localDatabaseUrlIsSafe,
} from "./collect-production-preflight.js";

const execFileAsync = promisify(execFile);
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const MAXIMUM_RESPONSE_BYTES = 20 * 1024 * 1024;

export type ProductionMigrationParityEvidence = {
  schema_version: 1;
  collected_at: string;
  project_ref: string;
  app_release: string;
  source_revision: string;
  project_identity_verified: boolean;
  local_history: MigrationHistoryFingerprint[];
  remote_history: MigrationHistoryFingerprint[];
};

export type ProductionMigrationParityReport = {
  schema_version: 1;
  verified_at: string;
  project_ref: string;
  app_release: string;
  source_revision: string;
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalUtc(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value
  );
}

function orderedUnique(items: readonly MigrationHistoryFingerprint[]) {
  return (
    items.length > 0 &&
    items.every(
      (item, index) => index === 0 || items[index - 1]!.version < item.version,
    )
  );
}

function sameHistory(
  left: readonly MigrationHistoryFingerprint[],
  right: readonly MigrationHistoryFingerprint[],
) {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        other?.version === item.version &&
        other.name === item.name &&
        other.statement_count === item.statement_count &&
        other.statements_sha256 === item.statements_sha256
      );
    })
  );
}

export function verifyProductionMigrationParity(input: {
  evidence: ProductionMigrationParityEvidence;
  project_ref: string;
  app_release: string;
  source_revision: string;
  now?: string;
}): ProductionMigrationParityReport {
  if (!PROJECT_REF_PATTERN.test(input.project_ref))
    throw new Error("Project ref is invalid.");
  if (!RELEASE_PATTERN.test(input.app_release))
    throw new Error("Release is invalid.");
  if (!SOURCE_REVISION_PATTERN.test(input.source_revision)) {
    throw new Error("Source revision is invalid.");
  }
  const now = input.now ?? new Date().toISOString();
  if (!canonicalUtc(now) || !canonicalUtc(input.evidence.collected_at)) {
    throw new Error("Migration parity timestamps must be canonical UTC.");
  }
  const ageSeconds =
    (Date.parse(now) - Date.parse(input.evidence.collected_at)) / 1_000;
  const checks: ProductionMigrationParityReport["checks"] = [
    {
      id: "project_binding",
      passed:
        input.evidence.project_ref === input.project_ref &&
        input.evidence.project_identity_verified,
      detail: "Evidence must identify the protected production project.",
    },
    {
      id: "release_binding",
      passed: input.evidence.app_release === input.app_release,
      detail: "Evidence must identify the protected release.",
    },
    {
      id: "source_revision_binding",
      passed: input.evidence.source_revision === input.source_revision,
      detail: "Evidence must identify the exact Git source revision.",
    },
    {
      id: "collection_time",
      passed:
        Number.isFinite(ageSeconds) && ageSeconds >= -30 && ageSeconds <= 120,
      detail:
        "Evidence must be collected within the two-minute protected window.",
    },
    {
      id: "ordered_histories",
      passed:
        orderedUnique(input.evidence.local_history) &&
        orderedUnique(input.evidence.remote_history),
      detail:
        "Local and production migration histories must be ordered and unique.",
    },
    {
      id: "statement_content_parity",
      passed: sameHistory(
        input.evidence.local_history,
        input.evidence.remote_history,
      ),
      detail:
        "Every version, name, statement count, and statement digest must match.",
    },
  ];
  return {
    schema_version: 1,
    verified_at: now,
    project_ref: input.project_ref,
    app_release: input.app_release,
    source_revision: input.source_revision,
    passed: checks.every((check) => check.passed),
    checks,
  };
}

async function jsonFetch(url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const source = await response.text();
  if (Buffer.byteLength(source, "utf8") > MAXIMUM_RESPONSE_BYTES) {
    throw new Error("Migration parity response exceeded its safe size.");
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("Migration parity response was not JSON.");
  }
  if (!response.ok) throw new Error("Migration parity request failed.");
  return value;
}

function parseJson(source: string) {
  try {
    return JSON.parse(source.trim()) as unknown;
  } catch {
    return null;
  }
}

async function collectEvidence(input: {
  project_ref: string;
  app_release: string;
  source_revision: string;
  access_token: string;
  local_database_url: string;
}): Promise<ProductionMigrationParityEvidence> {
  if (!PROJECT_REF_PATTERN.test(input.project_ref))
    throw new Error("Project ref is invalid.");
  if (!RELEASE_PATTERN.test(input.app_release))
    throw new Error("Release is invalid.");
  if (!SOURCE_REVISION_PATTERN.test(input.source_revision)) {
    throw new Error("Source revision is invalid.");
  }
  if (!localDatabaseUrlIsSafe(input.local_database_url)) {
    throw new Error("Local migration database must use a loopback URL.");
  }
  if (input.access_token.length < 20 || /\s/.test(input.access_token)) {
    throw new Error("Management API token is invalid.");
  }
  const query = buildMigrationHistoryQuery();
  const { SUPABASE_ACCESS_TOKEN: _managementToken, ...psqlEnvironment } =
    process.env;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${input.access_token}`,
  };
  const projectUrl = `https://api.supabase.com/v1/projects/${input.project_ref}`;
  const [localResult, project, remote] = await Promise.all([
    execFileAsync(
      process.env.PSQL_BIN?.trim() || "psql",
      [
        "--no-psqlrc",
        "--set=ON_ERROR_STOP=1",
        "--tuples-only",
        "--no-align",
        "--dbname",
        input.local_database_url,
        "--command",
        query,
      ],
      {
        env: { ...psqlEnvironment, PGCONNECT_TIMEOUT: "5" },
        maxBuffer: MAXIMUM_RESPONSE_BYTES,
        timeout: 30_000,
      },
    ),
    jsonFetch(projectUrl, { method: "GET", headers }),
    jsonFetch(`${projectUrl}/database/query/read-only`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  ]);
  if (!isRecord(project) || (project.ref ?? project.id) !== input.project_ref) {
    throw new Error("Production project identity does not match.");
  }
  const local = fingerprintMigrationHistory(parseJson(localResult.stdout));
  const remoteFingerprint = fingerprintMigrationHistory(remote);
  if (!local.valid || !remoteFingerprint.valid) {
    throw new Error("Migration history is unavailable or malformed.");
  }
  return {
    schema_version: 1,
    collected_at: new Date().toISOString(),
    project_ref: input.project_ref,
    app_release: input.app_release,
    source_revision: input.source_revision,
    project_identity_verified: true,
    local_history: local.items,
    remote_history: remoteFingerprint.items,
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function writeNewJson(path: string, value: unknown) {
  if (!isAbsolute(path))
    throw new Error("Migration parity outputs must be absolute paths.");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function main() {
  const projectRef =
    argument("--project-ref") ?? process.env.PRODUCTION_PROJECT_REF;
  const release = argument("--release") ?? process.env.VITE_APP_RELEASE;
  const sourceRevision =
    argument("--source-revision") ?? process.env.GITHUB_SHA;
  const localUrlFile = argument("--local-db-url-file");
  const evidenceOutput = argument("--evidence-output");
  const reportOutput = argument("--report-output");
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (
    !projectRef ||
    !release ||
    !sourceRevision ||
    !localUrlFile ||
    !evidenceOutput ||
    !reportOutput ||
    !accessToken
  ) {
    throw new Error(
      "Usage: production:migration-parity -- --project-ref <ref> --release <id> --source-revision <git-sha> --local-db-url-file </absolute/file> --evidence-output </absolute/file> --report-output </absolute/file>",
    );
  }
  if (!isAbsolute(localUrlFile))
    throw new Error("Local DB URL file must be absolute.");
  const urlFileStats = await stat(localUrlFile);
  if (!urlFileStats.isFile() || (urlFileStats.mode & 0o077) !== 0) {
    throw new Error("Local DB URL file must be owner-only.");
  }
  const localDatabaseUrl = (await readFile(localUrlFile, "utf8")).trim();
  const evidence = await collectEvidence({
    project_ref: projectRef,
    app_release: release,
    source_revision: sourceRevision,
    access_token: accessToken,
    local_database_url: localDatabaseUrl,
  });
  const report = verifyProductionMigrationParity({
    evidence,
    project_ref: projectRef,
    app_release: release,
    source_revision: sourceRevision,
  });
  await writeNewJson(evidenceOutput, evidence);
  await writeNewJson(reportOutput, report);
  process.stdout.write(
    `${JSON.stringify({
      passed: report.passed,
      migration_count: evidence.local_history.length,
      project_ref: projectRef,
      app_release: release,
      source_revision: sourceRevision,
    })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Migration parity failed."}\n`,
    );
    process.exitCode = 1;
  });
}
