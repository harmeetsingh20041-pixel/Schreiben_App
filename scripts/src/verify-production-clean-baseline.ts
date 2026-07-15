import { createHash } from "node:crypto";
import { open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELATION_PATTERN =
  /^(api|app_private|public|auth|storage|pgmq)\.[a-z][a-z0-9_]*$/;
const APP_RELATION_PATTERN = /^(api|app_private|public)\.[a-z][a-z0-9_]*$/;
const SEEDED_RELATION_PATTERN =
  /^(api|app_private|public|pgmq)\.[a-z][a-z0-9_]*$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
const MIGRATION_FILENAME_PATTERN = /^(\d{12}|\d{14})_[a-z0-9_]+\.sql$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type SeededReferenceRelation = {
  relation: string;
  key_columns: string[];
  expected_row_count: number;
  expected_key_sha256: string;
};

export type BoundedOperationalRelation = {
  relation: string;
  minimum_row_count: number;
  maximum_row_count: number;
};

export type ProductionCleanBaselineContract = {
  schema_version: 1;
  maximum_evidence_age_seconds: number;
  application_schemas: string[];
  tenant_relations_zero: string[];
  seeded_reference_relations: SeededReferenceRelation[];
  bounded_operational_relations: BoundedOperationalRelation[];
  auth_relations_zero: string[];
  auth_system_relations: string[];
  storage_relations_zero: string[];
  storage_system_relations: string[];
  queue_relations_zero: string[];
};

export type MigrationBinding = {
  file_count: number;
  versions: string[];
  aggregate_sha256: string;
};

export type ProductionCleanBaselineEvidence = {
  schema_version: 1;
  collected_at: string;
  project_ref: string;
  app_release: string;
  source_revision: string;
  contract_sha256: string;
  project_identity_verified: boolean;
  read_only_query_succeeded: boolean;
  migrations: {
    file_count: number;
    versions: string[];
    aggregate_sha256: string;
    remote_versions: string[];
    remote_version_aggregate_sha256: string;
  };
  application_relation_catalog: string[];
  auth_relation_catalog: string[];
  storage_relation_catalog: string[];
  relation_counts: Array<{
    relation: string;
    row_count: number;
    key_sha256: string | null;
  }>;
};

export type ProductionCleanBaselineReport = {
  schema_version: 1;
  verified_at: string;
  project_ref: string;
  app_release: string;
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${context} contains unsupported or missing fields.`);
  }
}

function safeInteger(value: unknown, context: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} must be a non-negative safe integer.`);
  }
  return value;
}

function safeString(value: unknown, pattern: RegExp, context: string) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${context} is invalid.`);
  }
  return value;
}

function uniqueSortedStrings(value: unknown, pattern: RegExp, context: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array.`);
  }
  const rows = value.map((item, index) =>
    safeString(item, pattern, `${context}[${index}]`),
  );
  if (new Set(rows).size !== rows.length) {
    throw new Error(`${context} contains duplicates.`);
  }
  return [...rows].sort();
}

function uniqueStrings(value: unknown, pattern: RegExp, context: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array.`);
  }
  const rows = value.map((item, index) =>
    safeString(item, pattern, `${context}[${index}]`),
  );
  if (new Set(rows).size !== rows.length) {
    throw new Error(`${context} contains duplicates.`);
  }
  return rows;
}

function exactStringArray(
  value: unknown,
  pattern: RegExp,
  context: string,
  allowEmpty = false,
) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${context} must be ${allowEmpty ? "an" : "a non-empty"} array.`,
    );
  }
  const rows = value.map((item, index) =>
    safeString(item, pattern, `${context}[${index}]`),
  );
  if (
    new Set(rows).size !== rows.length ||
    rows.some((item, index) => index > 0 && rows[index - 1]! >= item)
  ) {
    throw new Error(`${context} must be sorted and unique.`);
  }
  return rows;
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function contractSha256(source: string) {
  return sha256(source);
}

export function versionAggregateSha256(versions: readonly string[]) {
  return sha256(versions.join("\n"));
}

export function parseProductionCleanBaselineContract(
  value: unknown,
): ProductionCleanBaselineContract {
  if (!isRecord(value)) throw new Error("Baseline contract must be an object.");
  exactKeys(
    value,
    [
      "schema_version",
      "maximum_evidence_age_seconds",
      "application_schemas",
      "tenant_relations_zero",
      "seeded_reference_relations",
      "bounded_operational_relations",
      "auth_relations_zero",
      "auth_system_relations",
      "storage_relations_zero",
      "storage_system_relations",
      "queue_relations_zero",
    ],
    "Baseline contract",
  );
  if (value.schema_version !== 1) {
    throw new Error("Baseline contract schema version is unsupported.");
  }
  const maximumAge = safeInteger(
    value.maximum_evidence_age_seconds,
    "maximum_evidence_age_seconds",
  );
  if (maximumAge < 60 || maximumAge > 3_600) {
    throw new Error(
      "Baseline evidence age must be between 60 and 3600 seconds.",
    );
  }
  const applicationSchemas = uniqueSortedStrings(
    value.application_schemas,
    /^(api|app_private|public)$/,
    "application_schemas",
  );
  if (applicationSchemas.join(",") !== "api,app_private,public") {
    throw new Error("The complete application schema set is required.");
  }
  const tenantRelations = uniqueSortedStrings(
    value.tenant_relations_zero,
    APP_RELATION_PATTERN,
    "tenant_relations_zero",
  );

  if (!Array.isArray(value.seeded_reference_relations)) {
    throw new Error("seeded_reference_relations must be an array.");
  }
  const seeded = value.seeded_reference_relations
    .map((item, index) => {
      if (!isRecord(item)) {
        throw new Error(
          `seeded_reference_relations[${index}] must be an object.`,
        );
      }
      exactKeys(
        item,
        [
          "relation",
          "key_columns",
          "expected_row_count",
          "expected_key_sha256",
        ],
        `seeded_reference_relations[${index}]`,
      );
      return {
        relation: safeString(
          item.relation,
          SEEDED_RELATION_PATTERN,
          `seeded_reference_relations[${index}].relation`,
        ),
        key_columns: uniqueStrings(
          item.key_columns,
          IDENTIFIER_PATTERN,
          `seeded_reference_relations[${index}].key_columns`,
        ),
        expected_row_count: safeInteger(
          item.expected_row_count,
          `seeded_reference_relations[${index}].expected_row_count`,
        ),
        expected_key_sha256: safeString(
          item.expected_key_sha256,
          SHA256_PATTERN,
          `seeded_reference_relations[${index}].expected_key_sha256`,
        ),
      };
    })
    .sort((left, right) => left.relation.localeCompare(right.relation));
  if (
    seeded.length === 0 ||
    new Set(seeded.map((row) => row.relation)).size !== seeded.length
  ) {
    throw new Error("seeded_reference_relations must be non-empty and unique.");
  }

  if (!Array.isArray(value.bounded_operational_relations)) {
    throw new Error("bounded_operational_relations must be an array.");
  }
  const bounded = value.bounded_operational_relations
    .map((item, index) => {
      if (!isRecord(item)) {
        throw new Error(
          `bounded_operational_relations[${index}] must be an object.`,
        );
      }
      exactKeys(
        item,
        ["relation", "minimum_row_count", "maximum_row_count"],
        `bounded_operational_relations[${index}]`,
      );
      const minimum = safeInteger(
        item.minimum_row_count,
        `bounded_operational_relations[${index}].minimum_row_count`,
      );
      const maximum = safeInteger(
        item.maximum_row_count,
        `bounded_operational_relations[${index}].maximum_row_count`,
      );
      if (minimum > maximum) {
        throw new Error("Operational relation minimum exceeds its maximum.");
      }
      return {
        relation: safeString(
          item.relation,
          APP_RELATION_PATTERN,
          `bounded_operational_relations[${index}].relation`,
        ),
        minimum_row_count: minimum,
        maximum_row_count: maximum,
      };
    })
    .sort((left, right) => left.relation.localeCompare(right.relation));
  if (new Set(bounded.map((row) => row.relation)).size !== bounded.length) {
    throw new Error("bounded_operational_relations contains duplicates.");
  }

  const authRelations = uniqueSortedStrings(
    value.auth_relations_zero,
    /^auth\.[a-z][a-z0-9_]*$/,
    "auth_relations_zero",
  );
  const storageRelations = uniqueSortedStrings(
    value.storage_relations_zero,
    /^storage\.[a-z][a-z0-9_]*$/,
    "storage_relations_zero",
  );
  const authSystemRelations = uniqueSortedStrings(
    value.auth_system_relations,
    /^auth\.[a-z][a-z0-9_]*$/,
    "auth_system_relations",
  );
  const storageSystemRelations = uniqueSortedStrings(
    value.storage_system_relations,
    /^storage\.[a-z][a-z0-9_]*$/,
    "storage_system_relations",
  );
  const queueRelations = uniqueSortedStrings(
    value.queue_relations_zero,
    /^pgmq\.(?:a|q)_[a-z][a-z0-9_]*$/,
    "queue_relations_zero",
  );
  const allRelations = [
    ...tenantRelations,
    ...seeded.map((row) => row.relation),
    ...bounded.map((row) => row.relation),
    ...authRelations,
    ...authSystemRelations,
    ...storageRelations,
    ...storageSystemRelations,
    ...queueRelations,
  ];
  if (new Set(allRelations).size !== allRelations.length) {
    throw new Error("Baseline relation categories overlap.");
  }
  return {
    schema_version: 1,
    maximum_evidence_age_seconds: maximumAge,
    application_schemas: applicationSchemas,
    tenant_relations_zero: tenantRelations,
    seeded_reference_relations: seeded,
    bounded_operational_relations: bounded,
    auth_relations_zero: authRelations,
    auth_system_relations: authSystemRelations,
    storage_relations_zero: storageRelations,
    storage_system_relations: storageSystemRelations,
    queue_relations_zero: queueRelations,
  };
}

export async function computeMigrationBinding(
  migrationDirectory: string,
): Promise<MigrationBinding> {
  const entries = await readdir(migrationDirectory, { withFileTypes: true });
  const migrationNames = entries
    .flatMap((entry) => {
      if (entry.name.endsWith(".sql") && !entry.isFile()) {
        throw new Error("Migration directory contains a non-file SQL entry.");
      }
      if (
        entry.name.endsWith(".sql") &&
        !MIGRATION_FILENAME_PATTERN.test(entry.name)
      ) {
        throw new Error(
          "Migration directory contains an invalid SQL filename.",
        );
      }
      return entry.isFile() && entry.name.endsWith(".sql") ? [entry.name] : [];
    })
    .sort();
  if (migrationNames.length === 0)
    throw new Error("No migration files were found.");
  const versions = migrationNames.map(
    (name) => MIGRATION_FILENAME_PATTERN.exec(name)![1]!,
  );
  if (new Set(versions).size !== versions.length) {
    throw new Error("Migration versions must be unique.");
  }
  const rows: string[] = [];
  for (const name of migrationNames) {
    const contents = await readFile(resolve(migrationDirectory, name));
    rows.push(`${name}\u001f${sha256(contents)}`);
  }
  return {
    file_count: migrationNames.length,
    versions,
    aggregate_sha256: sha256(rows.join("\n")),
  };
}

export function parseProductionCleanBaselineEvidence(
  value: unknown,
): ProductionCleanBaselineEvidence {
  if (!isRecord(value)) throw new Error("Baseline evidence must be an object.");
  exactKeys(
    value,
    [
      "schema_version",
      "collected_at",
      "project_ref",
      "app_release",
      "source_revision",
      "contract_sha256",
      "project_identity_verified",
      "read_only_query_succeeded",
      "migrations",
      "application_relation_catalog",
      "auth_relation_catalog",
      "storage_relation_catalog",
      "relation_counts",
    ],
    "Baseline evidence",
  );
  if (value.schema_version !== 1) {
    throw new Error("Baseline evidence schema version is unsupported.");
  }
  const collectedAt = safeString(
    value.collected_at,
    UTC_TIMESTAMP_PATTERN,
    "collected_at",
  );
  if (new Date(collectedAt).toISOString() !== collectedAt) {
    throw new Error("collected_at is not a canonical UTC timestamp.");
  }
  const projectRef = safeString(
    value.project_ref,
    PROJECT_REF_PATTERN,
    "project_ref",
  );
  const release = safeString(value.app_release, RELEASE_PATTERN, "app_release");
  const sourceRevision = safeString(
    value.source_revision,
    SOURCE_REVISION_PATTERN,
    "source_revision",
  );
  const contractDigest = safeString(
    value.contract_sha256,
    SHA256_PATTERN,
    "contract_sha256",
  );
  if (
    typeof value.project_identity_verified !== "boolean" ||
    typeof value.read_only_query_succeeded !== "boolean"
  ) {
    throw new Error("Baseline evidence verification flags must be booleans.");
  }
  if (!isRecord(value.migrations)) {
    throw new Error("Baseline migration evidence must be an object.");
  }
  exactKeys(
    value.migrations,
    [
      "file_count",
      "versions",
      "aggregate_sha256",
      "remote_versions",
      "remote_version_aggregate_sha256",
    ],
    "Baseline migration evidence",
  );
  const migrations = {
    file_count: safeInteger(
      value.migrations.file_count,
      "migrations.file_count",
    ),
    versions: exactStringArray(
      value.migrations.versions,
      /^(\d{12}|\d{14})$/,
      "migrations.versions",
    ),
    aggregate_sha256: safeString(
      value.migrations.aggregate_sha256,
      SHA256_PATTERN,
      "migrations.aggregate_sha256",
    ),
    remote_versions: exactStringArray(
      value.migrations.remote_versions,
      /^(\d{12}|\d{14})$/,
      "migrations.remote_versions",
      true,
    ),
    remote_version_aggregate_sha256: safeString(
      value.migrations.remote_version_aggregate_sha256,
      SHA256_PATTERN,
      "migrations.remote_version_aggregate_sha256",
    ),
  };
  const catalog = exactStringArray(
    value.application_relation_catalog,
    APP_RELATION_PATTERN,
    "application_relation_catalog",
  );
  const authCatalog = exactStringArray(
    value.auth_relation_catalog,
    /^auth\.[a-z][a-z0-9_]*$/,
    "auth_relation_catalog",
  );
  const storageCatalog = exactStringArray(
    value.storage_relation_catalog,
    /^storage\.[a-z][a-z0-9_]*$/,
    "storage_relation_catalog",
  );
  if (
    !Array.isArray(value.relation_counts) ||
    value.relation_counts.length === 0
  ) {
    throw new Error("relation_counts must be a non-empty array.");
  }
  const relationCounts = value.relation_counts.map((item, index) => {
    if (!isRecord(item))
      throw new Error(`relation_counts[${index}] must be an object.`);
    exactKeys(
      item,
      ["relation", "row_count", "key_sha256"],
      `relation_counts[${index}]`,
    );
    const keyDigest = item.key_sha256;
    if (
      keyDigest !== null &&
      (typeof keyDigest !== "string" || !SHA256_PATTERN.test(keyDigest))
    ) {
      throw new Error(`relation_counts[${index}].key_sha256 is invalid.`);
    }
    return {
      relation: safeString(
        item.relation,
        RELATION_PATTERN,
        `relation_counts[${index}].relation`,
      ),
      row_count: safeInteger(
        item.row_count,
        `relation_counts[${index}].row_count`,
      ),
      key_sha256: keyDigest,
    };
  });
  if (
    new Set(relationCounts.map((row) => row.relation)).size !==
      relationCounts.length ||
    relationCounts.some(
      (row, index) =>
        index > 0 && relationCounts[index - 1]!.relation >= row.relation,
    )
  ) {
    throw new Error("relation_counts must be sorted and unique.");
  }
  return {
    schema_version: 1,
    collected_at: collectedAt,
    project_ref: projectRef,
    app_release: release,
    source_revision: sourceRevision,
    contract_sha256: contractDigest,
    project_identity_verified: value.project_identity_verified,
    read_only_query_succeeded: value.read_only_query_succeeded,
    migrations,
    application_relation_catalog: catalog,
    auth_relation_catalog: authCatalog,
    storage_relation_catalog: storageCatalog,
    relation_counts: relationCounts,
  };
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function expectedApplicationRelations(
  contract: ProductionCleanBaselineContract,
) {
  return [
    ...contract.tenant_relations_zero,
    ...contract.seeded_reference_relations.map((row) => row.relation),
    ...contract.bounded_operational_relations.map((row) => row.relation),
  ]
    .filter((relation) => APP_RELATION_PATTERN.test(relation))
    .sort();
}

function expectedTrackedRelations(contract: ProductionCleanBaselineContract) {
  return [
    ...contract.tenant_relations_zero,
    ...contract.seeded_reference_relations.map((row) => row.relation),
    ...contract.bounded_operational_relations.map((row) => row.relation),
    ...contract.auth_relations_zero,
    ...contract.storage_relations_zero,
    ...contract.queue_relations_zero,
  ].sort();
}

export function verifyProductionCleanBaseline(input: {
  contract: ProductionCleanBaselineContract;
  contract_sha256: string;
  evidence: ProductionCleanBaselineEvidence;
  migrations: MigrationBinding;
  expected_project_ref: string;
  expected_release: string;
  expected_source_revision: string;
  now?: string;
}): ProductionCleanBaselineReport {
  safeString(input.contract_sha256, SHA256_PATTERN, "Expected contract digest");
  safeString(
    input.expected_project_ref,
    PROJECT_REF_PATTERN,
    "Expected project ref",
  );
  safeString(input.expected_release, RELEASE_PATTERN, "Expected release");
  safeString(
    input.expected_source_revision,
    SOURCE_REVISION_PATTERN,
    "Expected source revision",
  );
  const now = input.now ?? new Date().toISOString();
  if (!UTC_TIMESTAMP_PATTERN.test(now) || new Date(now).toISOString() !== now) {
    throw new Error("Verification time must be canonical UTC.");
  }
  const checks: ProductionCleanBaselineReport["checks"] = [];
  const add = (id: string, passed: boolean, detail: string) =>
    checks.push({ id, passed, detail });
  const evidence = input.evidence;
  add(
    "contract_binding",
    evidence.contract_sha256 === input.contract_sha256,
    evidence.contract_sha256 === input.contract_sha256
      ? "Evidence matches the checked-in baseline contract."
      : "Evidence was collected under a different baseline contract.",
  );
  add(
    "project_binding",
    evidence.project_ref === input.expected_project_ref &&
      evidence.project_identity_verified,
    evidence.project_ref === input.expected_project_ref &&
      evidence.project_identity_verified
      ? "Evidence is bound to the declared production project."
      : "Production project identity was not verified.",
  );
  add(
    "release_binding",
    evidence.app_release === input.expected_release,
    evidence.app_release === input.expected_release
      ? "Evidence is bound to the declared application release."
      : "Evidence release does not match the declared release.",
  );
  add(
    "source_revision_binding",
    evidence.source_revision === input.expected_source_revision,
    evidence.source_revision === input.expected_source_revision
      ? "Evidence is bound to the exact source revision."
      : "Evidence source revision does not match the checkout.",
  );
  add(
    "read_only_collection",
    evidence.read_only_query_succeeded,
    evidence.read_only_query_succeeded
      ? "Counts were returned by the read-only database endpoint."
      : "The read-only database query did not succeed.",
  );
  const evidenceTime = Date.parse(evidence.collected_at);
  const nowTime = Date.parse(now);
  const ageSeconds = (nowTime - evidenceTime) / 1_000;
  const timeValid =
    Number.isFinite(ageSeconds) &&
    ageSeconds >= -60 &&
    ageSeconds <= input.contract.maximum_evidence_age_seconds;
  add(
    "collection_time",
    timeValid,
    timeValid
      ? "Evidence collection time is fresh and canonical UTC."
      : "Evidence is stale or unreasonably future-dated.",
  );

  const localMigrationMatch =
    evidence.migrations.file_count === input.migrations.file_count &&
    arraysEqual(evidence.migrations.versions, input.migrations.versions) &&
    evidence.migrations.aggregate_sha256 === input.migrations.aggregate_sha256;
  add(
    "local_migration_aggregate",
    localMigrationMatch,
    localMigrationMatch
      ? "Evidence matches the complete checked-in migration aggregate."
      : "Checked-in migrations changed after evidence collection.",
  );
  const remoteMigrationAggregate = versionAggregateSha256(
    evidence.migrations.remote_versions,
  );
  const remoteMigrationMatch =
    arraysEqual(
      evidence.migrations.remote_versions,
      input.migrations.versions,
    ) &&
    evidence.migrations.remote_version_aggregate_sha256 ===
      remoteMigrationAggregate;
  add(
    "remote_migration_versions",
    remoteMigrationMatch,
    remoteMigrationMatch
      ? "Production contains exactly the checked-in migration versions."
      : "Production migration versions do not match the checkout.",
  );

  const expectedCatalog = expectedApplicationRelations(input.contract);
  const catalogMatch = arraysEqual(
    evidence.application_relation_catalog,
    expectedCatalog,
  );
  add(
    "application_relation_catalog",
    catalogMatch,
    catalogMatch
      ? "Every application table is classified by the baseline contract."
      : "An application table is missing, unexpected, or unclassified.",
  );
  const expectedAuthCatalog = [
    ...input.contract.auth_relations_zero,
    ...input.contract.auth_system_relations,
  ].sort();
  const authCatalogMatch = arraysEqual(
    evidence.auth_relation_catalog,
    expectedAuthCatalog,
  );
  add(
    "auth_relation_catalog",
    authCatalogMatch,
    authCatalogMatch
      ? "Every Auth table is explicitly classified."
      : "An Auth table is missing, unexpected, or unclassified.",
  );
  const expectedStorageCatalog = [
    ...input.contract.storage_relations_zero,
    ...input.contract.storage_system_relations,
  ].sort();
  const storageCatalogMatch = arraysEqual(
    evidence.storage_relation_catalog,
    expectedStorageCatalog,
  );
  add(
    "storage_relation_catalog",
    storageCatalogMatch,
    storageCatalogMatch
      ? "Every Storage table is explicitly classified."
      : "A Storage table is missing, unexpected, or unclassified.",
  );
  const expectedTracked = expectedTrackedRelations(input.contract);
  const actualTracked = evidence.relation_counts.map((row) => row.relation);
  const trackedMatch = arraysEqual(actualTracked, expectedTracked);
  add(
    "tracked_relation_inventory",
    trackedMatch,
    trackedMatch
      ? "All application, Auth, and Storage baseline relations were counted."
      : "The count inventory is incomplete or contains an unexpected relation.",
  );
  const countByRelation = new Map(
    evidence.relation_counts.map((row) => [row.relation, row]),
  );
  const zeroGroup = (
    id: string,
    relations: readonly string[],
    label: string,
  ) => {
    const failed = relations.filter(
      (relation) =>
        countByRelation.get(relation)?.row_count !== 0 ||
        countByRelation.get(relation)?.key_sha256 !== null,
    );
    add(
      id,
      failed.length === 0,
      failed.length === 0
        ? `${label} relations contain zero rows.`
        : `${label} baseline failed for ${failed.join(", ")}.`,
    );
  };
  zeroGroup(
    "tenant_data_zero",
    input.contract.tenant_relations_zero,
    "Tenant and student-content",
  );
  zeroGroup(
    "auth_data_zero",
    input.contract.auth_relations_zero,
    "Auth user-data",
  );
  zeroGroup(
    "storage_data_zero",
    input.contract.storage_relations_zero,
    "Storage",
  );
  zeroGroup(
    "queue_data_zero",
    input.contract.queue_relations_zero,
    "Durable queue and archive",
  );

  const seededFailures = input.contract.seeded_reference_relations
    .filter((expected) => {
      const actual = countByRelation.get(expected.relation);
      return (
        actual?.row_count !== expected.expected_row_count ||
        actual.key_sha256 !== expected.expected_key_sha256
      );
    })
    .map((row) => row.relation);
  add(
    "seeded_reference_allowlist",
    seededFailures.length === 0,
    seededFailures.length === 0
      ? "Only the explicitly allowlisted grammar, configuration, and global reference rows exist."
      : `Seeded reference allowlist failed for ${seededFailures.join(", ")}.`,
  );
  const boundedFailures = input.contract.bounded_operational_relations
    .filter((expected) => {
      const actual = countByRelation.get(expected.relation);
      return (
        !actual ||
        actual.key_sha256 !== null ||
        actual.row_count < expected.minimum_row_count ||
        actual.row_count > expected.maximum_row_count
      );
    })
    .map((row) => row.relation);
  add(
    "bounded_operational_state",
    boundedFailures.length === 0,
    boundedFailures.length === 0
      ? "Operational bootstrap state remains within its explicit bound."
      : `Operational baseline failed for ${boundedFailures.join(", ")}.`,
  );
  return {
    schema_version: 1,
    verified_at: now,
    project_ref: input.expected_project_ref,
    app_release: input.expected_release,
    passed: checks.every((check) => check.passed),
    checks,
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function writeNewJson(path: string, value: unknown) {
  if (!isAbsolute(path))
    throw new Error("Report output must be an absolute path.");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function main() {
  const cwd = process.cwd();
  const contractPath = resolve(
    argument("--contract") ?? "config/production-clean-baseline-contract.json",
  );
  const evidencePath = argument("--evidence");
  const reportPath = argument("--report-output");
  const projectRef =
    argument("--project-ref") ?? process.env.PRODUCTION_PROJECT_REF;
  const release = argument("--release") ?? process.env.VITE_APP_RELEASE;
  const sourceRevision =
    argument("--source-revision") ?? process.env.GITHUB_SHA;
  if (
    !evidencePath ||
    !reportPath ||
    !projectRef ||
    !release ||
    !sourceRevision
  ) {
    throw new Error(
      "Usage: production:clean-baseline:verify -- --project-ref <ref> --release <id> --source-revision <git-sha> --evidence </absolute/file.json> --report-output </absolute/file.json>",
    );
  }
  if (!isAbsolute(evidencePath))
    throw new Error("Evidence path must be absolute.");
  const [contractSource, evidenceSource, migrations] = await Promise.all([
    readFile(contractPath, "utf8"),
    readFile(evidencePath, "utf8"),
    computeMigrationBinding(resolve(cwd, "supabase/migrations")),
  ]);
  const contract = parseProductionCleanBaselineContract(
    JSON.parse(contractSource),
  );
  const evidence = parseProductionCleanBaselineEvidence(
    JSON.parse(evidenceSource),
  );
  const report = verifyProductionCleanBaseline({
    contract,
    contract_sha256: contractSha256(contractSource),
    evidence,
    migrations,
    expected_project_ref: projectRef,
    expected_release: release,
    expected_source_revision: sourceRevision,
  });
  await writeNewJson(reportPath, report);
  process.stdout.write(
    `${JSON.stringify({
      passed: report.passed,
      project_ref: report.project_ref,
      app_release: report.app_release,
      check_count: report.checks.length,
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
      `${error instanceof Error ? error.message : "Clean baseline verification failed."}\n`,
    );
    process.exitCode = 1;
  });
}
