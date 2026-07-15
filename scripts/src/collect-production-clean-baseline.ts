import { open, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ProductionCleanBaselineContract,
  type ProductionCleanBaselineEvidence,
  computeMigrationBinding,
  contractSha256,
  parseProductionCleanBaselineContract,
  parseProductionCleanBaselineEvidence,
  versionAggregateSha256,
} from "./verify-production-clean-baseline.js";

const MANAGEMENT_API = "https://api.supabase.com";
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const RELATION_PATTERN =
  /^(api|app_private|public|auth|storage|pgmq)\.([a-z][a-z0-9_]*)$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAXIMUM_RESPONSE_BYTES = 1_000_000;

type JsonResponse = {
  ok: boolean;
  status: number | null;
  value: unknown;
};

export type CleanBaselineCollectorDependencies = {
  fetchImpl: typeof fetch;
  now(): string;
};

export type CleanBaselineCollectorInput = {
  cwd: string;
  project_ref: string;
  app_release: string;
  source_revision: string;
  access_token: string;
  contract_source: string;
  contract: ProductionCleanBaselineContract;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function quoteIdentifier(value: string) {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error("The baseline contract contains an unsafe SQL identifier.");
  }
  return `"${value}"`;
}

function relationParts(relation: string) {
  const match = RELATION_PATTERN.exec(relation);
  if (!match)
    throw new Error("The baseline contract contains an unsafe relation.");
  return {
    schema: match[1]!,
    table: match[2]!,
    sql: `${quoteIdentifier(match[1]!)}.${quoteIdentifier(match[2]!)}`,
  };
}

function sqlTextLiteral(value: string) {
  if (!value || value.includes("\0")) {
    throw new Error("The baseline contract contains invalid SQL text.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function zeroCountSelect(relation: string) {
  const { sql } = relationParts(relation);
  return `select ${sqlTextLiteral(relation)}::text as relation,
       count(*)::bigint as row_count,
       null::text as key_sha256
from ${sql}`;
}

function seededCountSelect(input: { relation: string; key_columns: string[] }) {
  const { sql } = relationParts(input.relation);
  const keyParts = input.key_columns.map(
    (column) => `coalesce(${quoteIdentifier(column)}::text, '<null>')`,
  );
  const keyExpression =
    keyParts.length === 1
      ? keyParts[0]!
      : `concat_ws(E'\\x1f', ${keyParts.join(", ")})`;
  return `select ${sqlTextLiteral(input.relation)}::text as relation,
       count(*)::bigint as row_count,
       encode(
         extensions.digest(
           convert_to(coalesce(string_agg(${keyExpression}, E'\\n' order by (${keyExpression}) collate "C"), ''), 'UTF8'),
           'sha256'
         ),
         'hex'
       )::text as key_sha256
from ${sql}`;
}

/**
 * Build one SELECT-only query. It returns relation names, counts, and server-side
 * fingerprints. Approved seed values are consumed only inside `digest`; no raw
 * row content, student text, email, token, or credential leaves PostgreSQL.
 */
export function buildProductionCleanBaselineQuery(
  contract: ProductionCleanBaselineContract,
) {
  const zeroRelations = [
    ...contract.tenant_relations_zero,
    ...contract.bounded_operational_relations.map((row) => row.relation),
    ...contract.auth_relations_zero,
    ...contract.storage_relations_zero,
    ...contract.queue_relations_zero,
  ];
  const countQueries = [
    ...zeroRelations.map(zeroCountSelect),
    ...contract.seeded_reference_relations.map(seededCountSelect),
  ].sort((left, right) => {
    const leftRelation = /select '([^']+)'/.exec(left)?.[1] ?? left;
    const rightRelation = /select '([^']+)'/.exec(right)?.[1] ?? right;
    return leftRelation.localeCompare(rightRelation);
  });
  const schemas = contract.application_schemas.map(sqlTextLiteral).join(", ");
  return `with relation_counts as (
${countQueries.map((query) => `  ${query.replaceAll("\n", "\n  ")}`).join("\n  union all\n")}
), application_catalog as (
  select format('%s.%s', namespace.nspname, class.relname) as relation
  from pg_catalog.pg_class as class
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = class.relnamespace
  where namespace.nspname = any(array[${schemas}]::text[])
    and class.relkind in ('r', 'p')
), auth_catalog as (
  select format('%s.%s', namespace.nspname, class.relname) as relation
  from pg_catalog.pg_class as class
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = class.relnamespace
  where namespace.nspname = 'auth'
    and class.relkind in ('r', 'p')
), storage_catalog as (
  select format('%s.%s', namespace.nspname, class.relname) as relation
  from pg_catalog.pg_class as class
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = class.relnamespace
  where namespace.nspname = 'storage'
    and class.relkind in ('r', 'p')
), remote_migrations as (
  select migration.version::text as version
  from supabase_migrations.schema_migrations as migration
)
select
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'relation', counts.relation,
        'row_count', counts.row_count,
        'key_sha256', counts.key_sha256
      ) order by counts.relation
    )
    from relation_counts as counts
  ), '[]'::jsonb) as relation_counts,
  coalesce((
    select jsonb_agg(catalog.relation order by catalog.relation)
    from application_catalog as catalog
  ), '[]'::jsonb) as application_relation_catalog,
  coalesce((
    select jsonb_agg(catalog.relation order by catalog.relation)
    from auth_catalog as catalog
  ), '[]'::jsonb) as auth_relation_catalog,
  coalesce((
    select jsonb_agg(catalog.relation order by catalog.relation)
    from storage_catalog as catalog
  ), '[]'::jsonb) as storage_relation_catalog,
  coalesce((
    select jsonb_agg(migration.version order by migration.version)
    from remote_migrations as migration
  ), '[]'::jsonb) as remote_migration_versions;`;
}

function firstRecord(value: unknown) {
  if (Array.isArray(value) && isRecord(value[0])) return value[0];
  if (isRecord(value)) {
    if (Array.isArray(value.data) && isRecord(value.data[0]))
      return value.data[0];
    if (Array.isArray(value.result) && isRecord(value.result[0]))
      return value.result[0];
  }
  return null;
}

function jsonArray(value: unknown, context: string) {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new Error(`${context} was not valid JSON.`);
    }
  }
  if (!Array.isArray(candidate))
    throw new Error(`${context} was not an array.`);
  return candidate;
}

function integerValue(value: unknown, context: string) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${context} was not a non-negative safe integer.`);
}

function sanitizeQueryResult(value: unknown) {
  const row = firstRecord(value);
  if (!row)
    throw new Error("The read-only database query returned no result row.");
  const counts = jsonArray(row.relation_counts, "relation_counts")
    .map((item, index) => {
      if (!isRecord(item))
        throw new Error(`relation_counts[${index}] was not an object.`);
      const relation = typeof item.relation === "string" ? item.relation : "";
      if (!RELATION_PATTERN.test(relation)) {
        throw new Error(
          `relation_counts[${index}] returned an unsafe relation.`,
        );
      }
      const keyDigest = item.key_sha256;
      if (
        keyDigest !== null &&
        (typeof keyDigest !== "string" || !/^[a-f0-9]{64}$/.test(keyDigest))
      ) {
        throw new Error(
          `relation_counts[${index}] returned an invalid key fingerprint.`,
        );
      }
      return {
        relation,
        row_count: integerValue(
          item.row_count,
          `relation_counts[${index}].row_count`,
        ),
        key_sha256: keyDigest,
      };
    })
    .sort((left, right) => left.relation.localeCompare(right.relation));
  const catalog = jsonArray(
    row.application_relation_catalog,
    "application_relation_catalog",
  )
    .map((item, index) => {
      if (
        typeof item !== "string" ||
        !/^(api|app_private|public)\.[a-z][a-z0-9_]*$/.test(item)
      ) {
        throw new Error(`application_relation_catalog[${index}] was invalid.`);
      }
      return item;
    })
    .sort();
  const authCatalog = jsonArray(
    row.auth_relation_catalog,
    "auth_relation_catalog",
  )
    .map((item, index) => {
      if (typeof item !== "string" || !/^auth\.[a-z][a-z0-9_]*$/.test(item)) {
        throw new Error(`auth_relation_catalog[${index}] was invalid.`);
      }
      return item;
    })
    .sort();
  const storageCatalog = jsonArray(
    row.storage_relation_catalog,
    "storage_relation_catalog",
  )
    .map((item, index) => {
      if (
        typeof item !== "string" ||
        !/^storage\.[a-z][a-z0-9_]*$/.test(item)
      ) {
        throw new Error(`storage_relation_catalog[${index}] was invalid.`);
      }
      return item;
    })
    .sort();
  const remoteVersions = jsonArray(
    row.remote_migration_versions,
    "remote_migration_versions",
  )
    .map((item, index) => {
      if (typeof item !== "string" || !/^(\d{12}|\d{14})$/.test(item)) {
        throw new Error(`remote_migration_versions[${index}] was invalid.`);
      }
      return item;
    })
    .sort();
  return { counts, catalog, authCatalog, storageCatalog, remoteVersions };
}

async function safeJsonFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<JsonResponse> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    const declaredLength = Number(
      response.headers.get("content-length") ?? "0",
    );
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAXIMUM_RESPONSE_BYTES
    ) {
      return { ok: false, status: response.status, value: null };
    }
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > MAXIMUM_RESPONSE_BYTES) {
      return { ok: false, status: response.status, value: null };
    }
    let value: unknown = null;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      value = null;
    }
    return { ok: response.ok, status: response.status, value };
  } catch {
    return { ok: false, status: null, value: null };
  }
}

function managementHeaders(accessToken: string) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

export async function collectProductionCleanBaseline(
  input: CleanBaselineCollectorInput,
  dependencies: CleanBaselineCollectorDependencies = {
    fetchImpl: fetch,
    now: () => new Date().toISOString(),
  },
): Promise<ProductionCleanBaselineEvidence> {
  if (!PROJECT_REF_PATTERN.test(input.project_ref)) {
    throw new Error("Production project ref is invalid.");
  }
  if (!RELEASE_PATTERN.test(input.app_release)) {
    throw new Error("Application release is invalid.");
  }
  if (!SOURCE_REVISION_PATTERN.test(input.source_revision)) {
    throw new Error("Source revision is invalid.");
  }
  if (
    input.access_token.length < 20 ||
    input.access_token.length > 4_096 ||
    /\s/.test(input.access_token)
  ) {
    throw new Error("Supabase Management API token is invalid.");
  }
  const migrations = await computeMigrationBinding(
    resolve(input.cwd, "supabase/migrations"),
  );
  const headers = managementHeaders(input.access_token);
  const projectUrl = `${MANAGEMENT_API}/v1/projects/${input.project_ref}`;
  const queryUrl = `${projectUrl}/database/query/read-only`;
  const [projectResponse, queryResponse] = await Promise.all([
    safeJsonFetch(dependencies.fetchImpl, projectUrl, {
      method: "GET",
      headers,
    }),
    safeJsonFetch(dependencies.fetchImpl, queryUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: buildProductionCleanBaselineQuery(input.contract),
      }),
    }),
  ]);
  if (!projectResponse.ok || !isRecord(projectResponse.value)) {
    throw new Error("Production project identity could not be fetched.");
  }
  const fetchedProjectRef =
    typeof projectResponse.value.ref === "string"
      ? projectResponse.value.ref
      : typeof projectResponse.value.id === "string"
        ? projectResponse.value.id
        : "";
  if (fetchedProjectRef !== input.project_ref) {
    throw new Error(
      "Production project identity does not match the declared ref.",
    );
  }
  if (!queryResponse.ok || queryResponse.value === null) {
    throw new Error("The Supabase read-only database query failed.");
  }
  const sanitized = sanitizeQueryResult(queryResponse.value);
  const evidence: ProductionCleanBaselineEvidence = {
    schema_version: 1,
    collected_at: dependencies.now(),
    project_ref: input.project_ref,
    app_release: input.app_release,
    source_revision: input.source_revision,
    contract_sha256: contractSha256(input.contract_source),
    project_identity_verified: true,
    read_only_query_succeeded: true,
    migrations: {
      ...migrations,
      remote_versions: sanitized.remoteVersions,
      remote_version_aggregate_sha256: versionAggregateSha256(
        sanitized.remoteVersions,
      ),
    },
    application_relation_catalog: sanitized.catalog,
    auth_relation_catalog: sanitized.authCatalog,
    storage_relation_catalog: sanitized.storageCatalog,
    relation_counts: sanitized.counts,
  };
  return parseProductionCleanBaselineEvidence(evidence);
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function writeNewJson(path: string, value: unknown) {
  if (!isAbsolute(path))
    throw new Error("Evidence output must be an absolute path.");
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
  const output = argument("--output");
  const projectRef =
    argument("--project-ref") ?? process.env.PRODUCTION_PROJECT_REF;
  const release = argument("--release") ?? process.env.VITE_APP_RELEASE;
  const sourceRevision =
    argument("--source-revision") ?? process.env.GITHUB_SHA;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!output || !projectRef || !release || !sourceRevision || !accessToken) {
    throw new Error(
      "Usage: production:clean-baseline:collect -- --project-ref <ref> --release <id> --source-revision <git-sha> --output </absolute/file.json>; SUPABASE_ACCESS_TOKEN is required.",
    );
  }
  if (
    process.env.PRODUCTION_PROJECT_REF &&
    process.env.PRODUCTION_PROJECT_REF !== projectRef
  ) {
    throw new Error(
      "Project ref argument does not match the protected environment.",
    );
  }
  if (
    process.env.VITE_APP_RELEASE &&
    process.env.VITE_APP_RELEASE !== release
  ) {
    throw new Error(
      "Release argument does not match the protected environment.",
    );
  }
  const contractSource = await readFile(contractPath, "utf8");
  const contract = parseProductionCleanBaselineContract(
    JSON.parse(contractSource),
  );
  const evidence = await collectProductionCleanBaseline({
    cwd,
    project_ref: projectRef,
    app_release: release,
    source_revision: sourceRevision,
    access_token: accessToken,
    contract_source: contractSource,
    contract,
  });
  await writeNewJson(output, evidence);
  process.stdout.write(
    `${JSON.stringify({
      collected: true,
      project_ref: evidence.project_ref,
      app_release: evidence.app_release,
      relation_count: evidence.relation_counts.length,
      migration_count: evidence.migrations.file_count,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Clean baseline collection failed."}\n`,
    );
    process.exitCode = 1;
  });
}
