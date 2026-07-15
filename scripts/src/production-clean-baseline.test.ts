import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildProductionCleanBaselineQuery,
  collectProductionCleanBaseline,
} from "./collect-production-clean-baseline.js";
import {
  type ProductionCleanBaselineContract,
  type ProductionCleanBaselineEvidence,
  computeMigrationBinding,
  contractSha256,
  parseProductionCleanBaselineContract,
  parseProductionCleanBaselineEvidence,
  verifyProductionCleanBaseline,
  versionAggregateSha256,
} from "./verify-production-clean-baseline.js";
import { verifyProductionMigrationParity } from "./verify-production-migration-parity.js";

const ROOT = resolve(import.meta.dirname, "../..");
const CONTRACT_PATH = resolve(
  ROOT,
  "config/production-clean-baseline-contract.json",
);
const PROJECT_REF = "abcde1ghijklmnopqrst";
const RELEASE = "release-2026-07-11";
const SOURCE_REVISION = "a".repeat(40);
const COLLECTED_AT = "2026-07-11T10:00:00.000Z";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(rows: string[][]) {
  return sha256(
    rows
      .map((row) => row.join("\u001f"))
      .sort()
      .join("\n"),
  );
}

async function checkedInContract() {
  const source = await readFile(CONTRACT_PATH, "utf8");
  return {
    source,
    value: parseProductionCleanBaselineContract(JSON.parse(source)),
  };
}

function applicationRelations(contract: ProductionCleanBaselineContract) {
  return [
    ...contract.tenant_relations_zero,
    ...contract.seeded_reference_relations.map((row) => row.relation),
    ...contract.bounded_operational_relations.map((row) => row.relation),
  ]
    .filter((relation) => /^(api|app_private|public)\./.test(relation))
    .sort();
}

function relationCounts(contract: ProductionCleanBaselineContract) {
  return [
    ...contract.tenant_relations_zero.map((relation) => ({
      relation,
      row_count: 0,
      key_sha256: null,
    })),
    ...contract.seeded_reference_relations.map((row) => ({
      relation: row.relation,
      row_count: row.expected_row_count,
      key_sha256: row.expected_key_sha256,
    })),
    ...contract.bounded_operational_relations.map((row) => ({
      relation: row.relation,
      row_count: row.minimum_row_count,
      key_sha256: null,
    })),
    ...contract.auth_relations_zero.map((relation) => ({
      relation,
      row_count: 0,
      key_sha256: null,
    })),
    ...contract.storage_relations_zero.map((relation) => ({
      relation,
      row_count: 0,
      key_sha256: null,
    })),
    ...contract.queue_relations_zero.map((relation) => ({
      relation,
      row_count: 0,
      key_sha256: null,
    })),
  ].sort((left, right) => left.relation.localeCompare(right.relation));
}

function authRelations(contract: ProductionCleanBaselineContract) {
  return [
    ...contract.auth_relations_zero,
    ...contract.auth_system_relations,
  ].sort();
}

function storageRelations(contract: ProductionCleanBaselineContract) {
  return [
    ...contract.storage_relations_zero,
    ...contract.storage_system_relations,
  ].sort();
}

async function migrationFixture() {
  const root = await mkdtemp(join(tmpdir(), "schreiben-clean-baseline-"));
  const migrations = join(root, "supabase", "migrations");
  await mkdir(migrations, { recursive: true });
  await writeFile(join(migrations, "202607040001_first.sql"), "select 1;\n");
  await writeFile(join(migrations, "20260711000000_second.sql"), "select 2;\n");
  return { root, migrations };
}

async function validEvidence(
  contract: ProductionCleanBaselineContract,
  contractSource: string,
) {
  const fixture = await migrationFixture();
  const migrations = await computeMigrationBinding(fixture.migrations);
  const evidence: ProductionCleanBaselineEvidence = {
    schema_version: 1,
    collected_at: COLLECTED_AT,
    project_ref: PROJECT_REF,
    app_release: RELEASE,
    source_revision: SOURCE_REVISION,
    contract_sha256: contractSha256(contractSource),
    project_identity_verified: true,
    read_only_query_succeeded: true,
    migrations: {
      ...migrations,
      remote_versions: [...migrations.versions],
      remote_version_aggregate_sha256: versionAggregateSha256(
        migrations.versions,
      ),
    },
    application_relation_catalog: applicationRelations(contract),
    auth_relation_catalog: authRelations(contract),
    storage_relation_catalog: storageRelations(contract),
    relation_counts: relationCounts(contract),
  };
  return { fixture, migrations, evidence };
}

test("checked-in contract classifies every application table created by migrations", async () => {
  const { value: contract } = await checkedInContract();
  const migrationDirectory = resolve(ROOT, "supabase/migrations");
  const names = (await readdir(migrationDirectory)).filter((name) =>
    name.endsWith(".sql"),
  );
  const created = new Set<string>();
  for (const name of names) {
    const source = await readFile(resolve(migrationDirectory, name), "utf8");
    for (const match of source.matchAll(
      /^\s*create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(api|app_private|public)\.([a-z][a-z0-9_]*)/gim,
    )) {
      created.add(`${match[1]}.${match[2]}`);
    }
  }
  assert.deepEqual([...created].sort(), applicationRelations(contract));
  assert.equal(created.size, 107);
});

test("checked-in contract counts every configured PGMQ live and archive table", async () => {
  const { value: contract } = await checkedInContract();
  const queueMigration = await readFile(
    resolve(
      ROOT,
      "supabase/migrations/20260710010000_phase_9a_durable_job_substrate.sql",
    ),
    "utf8",
  );
  const queueNames = [
    ...new Set(
      [...queueMigration.matchAll(/pgmq\.create\('([a-z][a-z0-9_]*)'\)/g)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();
  assert.deepEqual(queueNames, [
    "worksheet_answer_evaluation",
    "worksheet_generation",
    "writing_evaluation",
  ]);
  assert.deepEqual(
    contract.queue_relations_zero,
    queueNames
      .flatMap((queueName) => [`pgmq.a_${queueName}`, `pgmq.q_${queueName}`])
      .sort(),
  );
  const meta = contract.seeded_reference_relations.find(
    (row) => row.relation === "pgmq.meta",
  )!;
  assert.equal(meta.expected_row_count, queueNames.length);
  assert.equal(
    meta.expected_key_sha256,
    fingerprint(queueNames.map((queueName) => [queueName])),
  );
});

test("checked-in contract classifies privacy-bearing Auth and Storage tables", async () => {
  const { value: contract } = await checkedInContract();
  assert.deepEqual(contract.auth_relations_zero, [
    "auth.audit_log_entries",
    "auth.custom_oauth_providers",
    "auth.flow_state",
    "auth.identities",
    "auth.mfa_amr_claims",
    "auth.mfa_challenges",
    "auth.mfa_factors",
    "auth.oauth_authorizations",
    "auth.oauth_client_states",
    "auth.oauth_clients",
    "auth.oauth_consents",
    "auth.one_time_tokens",
    "auth.refresh_tokens",
    "auth.saml_providers",
    "auth.saml_relay_states",
    "auth.sessions",
    "auth.sso_domains",
    "auth.sso_providers",
    "auth.users",
    "auth.webauthn_challenges",
    "auth.webauthn_credentials",
  ]);
  assert.deepEqual(contract.auth_system_relations, [
    "auth.instances",
    "auth.schema_migrations",
  ]);
  assert.deepEqual(contract.storage_relations_zero, [
    "storage.buckets",
    "storage.buckets_analytics",
    "storage.buckets_vectors",
    "storage.iceberg_namespaces",
    "storage.iceberg_tables",
    "storage.objects",
    "storage.s3_multipart_uploads",
    "storage.s3_multipart_uploads_parts",
    "storage.vector_indexes",
  ]);
  assert.deepEqual(contract.storage_system_relations, ["storage.migrations"]);
});

test("protected workflow orders empty-project parity before baseline without worksheet inventory", async () => {
  const workflow = await readFile(
    resolve(ROOT, ".github/workflows/verify.yml"),
    "utf8",
  );
  const job = workflow.split("\n  production-clean-baseline:\n", 2)[1]!;
  assert.match(job, /needs: production-migration-parity/);
  assert.match(job, /github\.ref == 'refs\/heads\/main'/);
  assert.match(job, /github\.ref_protected == true/);
  assert.match(job, /needs\.production-migration-parity\.result == 'success'/);
  assert.equal(job.match(/^\s*SUPABASE_ACCESS_TOKEN:.*$/gm)?.length, 1);
  assert(
    job.indexOf("SUPABASE_ACCESS_TOKEN") >
      job.indexOf("Collect and immediately verify"),
  );
  assert.equal(job.match(/--source-revision "\$GITHUB_SHA"/g)?.length, 2);

  const parity = workflow
    .split("\n  production-migration-parity:\n", 2)[1]!
    .split("\n  production-clean-baseline:\n", 1)[0]!;
  assert.match(parity, /github\.ref == 'refs\/heads\/main'/);
  assert.match(parity, /github\.ref_protected == true/);
  assert.match(parity, /supabase db reset --local --no-seed/);
  assert.match(parity, /pnpm production:migration-parity/);
  assert.doesNotMatch(parity, /worksheet-inventory/);
  assert.equal(parity.match(/^\s*SUPABASE_ACCESS_TOKEN:.*$/gm)?.length, 1);
  assert(
    parity.indexOf("SUPABASE_ACCESS_TOKEN") >
      parity.indexOf("Verify content-free migration statement parity"),
  );
});

test("migration parity rejects same-version statement drift", () => {
  const base = {
    schema_version: 1 as const,
    collected_at: COLLECTED_AT,
    project_ref: PROJECT_REF,
    app_release: RELEASE,
    source_revision: SOURCE_REVISION,
    project_identity_verified: true,
    local_history: [
      {
        version: "202607040001",
        name: "first",
        statement_count: 1,
        statements_sha256: "a".repeat(64),
      },
    ],
    remote_history: [
      {
        version: "202607040001",
        name: "first",
        statement_count: 1,
        statements_sha256: "a".repeat(64),
      },
    ],
  };
  const passing = verifyProductionMigrationParity({
    evidence: base,
    project_ref: PROJECT_REF,
    app_release: RELEASE,
    source_revision: SOURCE_REVISION,
    now: "2026-07-11T10:01:00.000Z",
  });
  assert.equal(passing.passed, true);
  const drifted = structuredClone(base);
  drifted.remote_history[0]!.statements_sha256 = "b".repeat(64);
  const failing = verifyProductionMigrationParity({
    evidence: drifted,
    project_ref: PROJECT_REF,
    app_release: RELEASE,
    source_revision: SOURCE_REVISION,
    now: "2026-07-11T10:01:00.000Z",
  });
  assert.equal(failing.passed, false);
  assert.equal(
    failing.checks.find((check) => check.id === "statement_content_parity")
      ?.passed,
    false,
  );
});

test("seeded fingerprints cover all launch-relevant migration content", async () => {
  const { value: contract } = await checkedInContract();
  const byRelation = new Map(
    contract.seeded_reference_relations.map((row) => [row.relation, row]),
  );
  const questionSource = await readFile(
    resolve(
      ROOT,
      "supabase/migrations/20260704184413_phase_5b_a2_global_question_bank.sql",
    ),
    "utf8",
  );
  const questionRows = [
    ...questionSource.matchAll(
      /\(\s*'(a2_[a-z0-9_]+)',\s*(\d+),\s*'([^']*)',\s*'([^']*)',\s*\$prompt\$([\s\S]*?)\$prompt\$,\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*null,\s*null,\s*null,\s*true\s*\)/g,
    ),
  ].map((match) => [
    match[1]!,
    match[2]!,
    match[3]!,
    match[4]!,
    match[5]!,
    match[6]!,
    match[7]!,
    match[8]!,
    "<null>",
    "<null>",
    "<null>",
    "true",
    "<null>",
  ]);
  assert.equal(questionRows.length, 47);
  assert.equal(
    byRelation.get("public.global_questions")!.expected_row_count,
    47,
  );
  assert.equal(
    byRelation.get("public.global_questions")!.expected_key_sha256,
    fingerprint(questionRows),
  );

  const grammarSource = await readFile(
    resolve(
      ROOT,
      "supabase/migrations/20260710031000_phase_11a_writing_fidelity_contract.sql",
    ),
    "utf8",
  );
  const contractBlock = grammarSource
    .split(
      "insert into app_private.grammar_topic_contracts (slug, display_name)",
      2,
    )[1]!
    .split("on conflict", 1)[0]!;
  const grammarRows = [
    ...contractBlock.matchAll(/\('([^']+)',\s*'([^']+)'\)/g),
  ].map((match) => [match[1]!, match[2]!]);
  const grammarSlugs = grammarRows.map((row) => row[0]!);
  assert.equal(
    byRelation.get("app_private.grammar_topic_contracts")!.expected_row_count,
    36,
  );
  assert.equal(
    byRelation.get("app_private.grammar_topic_contracts")!.expected_key_sha256,
    fingerprint(grammarRows),
  );

  const learnerDescriptionSource = await readFile(
    resolve(
      ROOT,
      "supabase/migrations/20260712163000_learner_friendly_grammar_topic_descriptions.sql",
    ),
    "utf8",
  );
  const learnerDescriptionBlock = learnerDescriptionSource
    .split("with descriptions(slug, description) as (", 2)[1]!
    .split("update public.grammar_topics topic", 1)[0]!;
  const learnerDescriptionRows = [
    ...learnerDescriptionBlock.matchAll(
      /\(\s*'((?:''|[^'])+)',\s*'((?:''|[^'])+)'\s*\)/g,
    ),
  ].map((match) => [
    match[1]!.replaceAll("''", "'"),
    match[2]!.replaceAll("''", "'"),
  ]);
  assert.equal(learnerDescriptionRows.length, 36);
  const learnerDescriptions = new Map(
    learnerDescriptionRows.map(([slug, description]) => [slug!, description!]),
  );
  assert.equal(learnerDescriptions.size, 36);
  assert.deepEqual(
    [...learnerDescriptions.keys()].sort(),
    [...grammarSlugs].sort(),
  );
  assert.equal(
    byRelation.get("public.grammar_topics")!.expected_key_sha256,
    fingerprint(
      grammarRows.map(([slug, displayName]) => [
        slug!,
        displayName!,
        "A1_A2",
        learnerDescriptions.get(slug!)!,
      ]),
    ),
  );

  const aliasBlock = grammarSource
    .split(
      "insert into app_private.grammar_topic_aliases (alias_slug, canonical_slug)\nvalues",
      2,
    )[1]!
    .split("on conflict", 1)[0]!;
  const aliases = new Map(grammarSlugs.map((slug) => [slug, slug]));
  for (const match of aliasBlock.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)) {
    aliases.set(match[1]!, match[2]!);
  }
  const aliasRows = [...aliases].map(([alias, canonical]) => [
    alias,
    canonical,
  ]);
  assert.equal(
    byRelation.get("app_private.grammar_topic_aliases")!.expected_row_count,
    107,
  );
  assert.equal(
    byRelation.get("app_private.grammar_topic_aliases")!.expected_key_sha256,
    fingerprint(aliasRows),
  );
  const levelFitGateRows = [
    [
      "A1",
      "level_fit_approval_required",
      "A1 adjective-ending productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A1",
      "level_fit_approval_required",
      "A1 future-tense productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A1",
      "level_fit_approval_required",
      "A1 Genitiv productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A1",
      "level_fit_approval_required",
      "A1 infinitive-with-zu productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A1",
      "level_fit_approval_required",
      "A1 Konjunktiv productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A1",
      "level_fit_approval_required",
      "A1 passive-voice productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A1",
      "level_fit_approval_required",
      "A1 Plusquamperfekt productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A1",
      "level_fit_approval_required",
      "A1 Präteritum productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A1",
      "level_fit_approval_required",
      "A1 reflexive-verb productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A1",
      "level_fit_approval_required",
      "A1 relative-clause productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A1",
      "level_fit_approval_required",
      "A1 subordinate-clause productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A2",
      "level_fit_approval_required",
      "A2 Genitiv productive practice requires explicit or qualified level-fit approval.",
    ],
    [
      "A2",
      "level_fit_approval_required",
      "A2 Plusquamperfekt productive practice requires explicit or qualified level-fit approval.",
    ],
  ];
  assert.equal(
    byRelation.get("app_private.practice_topic_level_assignment_gates")!
      .expected_row_count,
    13,
  );
  assert.equal(
    byRelation.get("app_private.practice_topic_level_assignment_gates")!
      .expected_key_sha256,
    fingerprint(levelFitGateRows),
  );
  assert.equal(
    byRelation.get("app_private.abuse_security_limits")!.expected_key_sha256,
    fingerprint([["true", "6", "6"]]),
  );
  assert.equal(
    byRelation.get("app_private.writing_security_limits")!.expected_key_sha256,
    fingerprint([["true", "3", "40", "6"]]),
  );
  assert.equal(
    byRelation.get("app_private.ai_paid_work_limits")!.expected_key_sha256,
    fingerprint([
      ["true", "40", "50", "10000", "8", "300", "12", "600", "2", "1", "2", "3"],
    ]),
  );
  const geminiSource = await readFile(
    resolve(
      ROOT,
      "supabase/migrations/20260711215912_phase_12r_gemini_secondary_provider.sql",
    ),
    "utf8",
  );
  const geminiCriticCompatibilitySource = await readFile(
    resolve(
      ROOT,
      "supabase/migrations/20260712010400_phase_12w_gemini_3_critic_compatibility.sql",
    ),
    "utf8",
  );
  const guardrailSource = await readFile(
    resolve(
      ROOT,
      "supabase/migrations/20260712010100_phase_12t_launch_cost_guardrails.sql",
    ),
    "utf8",
  );
  const fairShareSource = await readFile(
    resolve(
      ROOT,
      "supabase/migrations/20260713084132_cohort_ai_spend_fair_share.sql",
    ),
    "utf8",
  );
  const costPolicyRows = [
    ...[geminiSource, geminiCriticCompatibilitySource].flatMap((source) => [
      ...source.matchAll(
        /\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(\d+),\s*(\d+),\s*(\d+)\)/g,
      ),
    ]),
  ].map((match) => {
    const row = match.slice(1, 7);
    const cachedRate =
      row[0] === "deepseek"
        ? row[1] === "deepseek-v4-flash"
          ? "2800"
          : "3625"
        : row[3]!;
    return [...row.slice(0, 3), cachedRate, ...row.slice(3)];
  });
  assert.equal(costPolicyRows.length, 15);
  assert.equal(
    byRelation.get("app_private.ai_model_cost_policies")!.expected_row_count,
    15,
  );
  assert.equal(
    byRelation.get("app_private.ai_model_cost_policies")!.expected_key_sha256,
    fingerprint(costPolicyRows),
  );
  assert.match(
    guardrailSource,
    /update app_private\.ai_spend_global_policy[\s\S]*monthly_limit_microusd = 225000000/,
  );
  assert.match(
    fairShareSource,
    /operating_target_microeur_per_active_student_month[\s\S]*fair_share_reserve_basis_points[\s\S]*usd_to_eur_microrate/,
  );
  assert.equal(
    byRelation.get("app_private.ai_spend_global_policy")!.expected_key_sha256,
    fingerprint([
      [
        "true",
        "225000000",
        "100000000",
        "false",
        "2",
        "1000000",
        "1000",
        "920000",
        "1500000",
        "2026-07-11",
        "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A",
        "7",
      ],
    ]),
  );
  assert.equal(
    byRelation.get("app_private.ai_budget_change_audit")!.expected_key_sha256,
    fingerprint([
      [
        "global",
        "500000000",
        "225000000",
        "100000000",
        "100000000",
        "false",
        "false",
        "2",
      ],
    ]),
  );
  assert.equal(
    byRelation.get("pgmq.meta")!.expected_key_sha256,
    fingerprint([
      ["worksheet_answer_evaluation"],
      ["worksheet_generation"],
      ["writing_evaluation"],
    ]),
  );
});

test("collector query is SELECT-only and returns counts plus server-side fingerprints", async () => {
  const { value: contract } = await checkedInContract();
  const query = buildProductionCleanBaselineQuery(contract);
  assert.match(query, /^with relation_counts as \(/);
  assert.match(query, /extensions\.digest/);
  assert.match(query, /collate "C"/);
  assert.match(query, /"prompt"::text/);
  assert.match(query, /count\(\*\)::bigint/);
  assert.match(query, /supabase_migrations\.schema_migrations/);
  assert.doesNotMatch(
    query,
    /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|copy|call|do)\b/i,
  );
  assert.doesNotMatch(query, /select\s+\*/i);
  assert.doesNotMatch(query, /jsonb_build_object\(\s*'prompt'/i);
  assert.doesNotMatch(
    query,
    /\bas\s+(prompt|email|password|raw_user_meta_data)\b/i,
  );
});

test("migration binding rejects SQL files outside the versioned naming contract", async () => {
  const fixture = await migrationFixture();
  await writeFile(join(fixture.migrations, "manual_patch.sql"), "select 3;\n");
  await assert.rejects(
    () => computeMigrationBinding(fixture.migrations),
    /invalid SQL filename/,
  );
});

test("collector binds project, release, contract, migrations, and sanitized counts", async () => {
  const { source, value: contract } = await checkedInContract();
  const fixture = await migrationFixture();
  const migrations = await computeMigrationBinding(fixture.migrations);
  const requestedUrls: string[] = [];
  let submittedQuery = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith(`/v1/projects/${PROJECT_REF}`)) {
      return new Response(JSON.stringify({ ref: PROJECT_REF }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    assert(
      url.endsWith(`/v1/projects/${PROJECT_REF}/database/query/read-only`),
    );
    const body = JSON.parse(String(init?.body)) as { query: string };
    submittedQuery = body.query;
    return new Response(
      JSON.stringify([
        {
          relation_counts: relationCounts(contract),
          application_relation_catalog: applicationRelations(contract),
          auth_relation_catalog: authRelations(contract),
          storage_relation_catalog: storageRelations(contract),
          remote_migration_versions: migrations.versions,
        },
      ]),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  const evidence = await collectProductionCleanBaseline(
    {
      cwd: fixture.root,
      project_ref: PROJECT_REF,
      app_release: RELEASE,
      source_revision: SOURCE_REVISION,
      access_token: "sbp_test_management_token_1234567890",
      contract_source: source,
      contract,
    },
    { fetchImpl, now: () => COLLECTED_AT },
  );
  assert.equal(requestedUrls.length, 2);
  assert.match(submittedQuery, /^with relation_counts/);
  assert.equal(evidence.project_ref, PROJECT_REF);
  assert.equal(evidence.app_release, RELEASE);
  assert.equal(evidence.contract_sha256, contractSha256(source));
  assert.equal(
    evidence.migrations.aggregate_sha256,
    migrations.aggregate_sha256,
  );
  assert.deepEqual(evidence.migrations.remote_versions, migrations.versions);
  assert(!JSON.stringify(evidence).includes("sbp_test_management_token"));
  assert(!JSON.stringify(evidence).includes("prompt"));
});

test("collector fails closed on project mismatch and read-only query failure", async () => {
  const { source, value: contract } = await checkedInContract();
  const fixture = await migrationFixture();
  const mismatchFetch: typeof fetch = async (input) =>
    String(input).endsWith("/database/query/read-only")
      ? new Response("[]", { status: 201 })
      : new Response(JSON.stringify({ ref: "zzzzz1ghijklmnopqrst" }), {
          status: 200,
        });
  await assert.rejects(
    () =>
      collectProductionCleanBaseline(
        {
          cwd: fixture.root,
          project_ref: PROJECT_REF,
          app_release: RELEASE,
          source_revision: SOURCE_REVISION,
          access_token: "sbp_test_management_token_1234567890",
          contract_source: source,
          contract,
        },
        { fetchImpl: mismatchFetch, now: () => COLLECTED_AT },
      ),
    /identity does not match/,
  );

  const failedQueryFetch: typeof fetch = async (input) =>
    String(input).endsWith("/database/query/read-only")
      ? new Response(JSON.stringify({ message: "denied" }), { status: 403 })
      : new Response(JSON.stringify({ ref: PROJECT_REF }), { status: 200 });
  await assert.rejects(
    () =>
      collectProductionCleanBaseline(
        {
          cwd: fixture.root,
          project_ref: PROJECT_REF,
          app_release: RELEASE,
          source_revision: SOURCE_REVISION,
          access_token: "sbp_test_management_token_1234567890",
          contract_source: source,
          contract,
        },
        { fetchImpl: failedQueryFetch, now: () => COLLECTED_AT },
      ),
    /read-only database query failed/,
  );
});

test("verifier accepts only the fresh, exact, zero-data production baseline", async () => {
  const { source, value: contract } = await checkedInContract();
  const { migrations, evidence } = await validEvidence(contract, source);
  const report = verifyProductionCleanBaseline({
    contract,
    contract_sha256: contractSha256(source),
    evidence,
    migrations,
    expected_project_ref: PROJECT_REF,
    expected_release: RELEASE,
    expected_source_revision: SOURCE_REVISION,
    now: "2026-07-11T10:01:00.000Z",
  });
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 18);
  assert(report.checks.every((check) => check.passed));
});

test("verifier rejects tenant, Auth, Storage, seeded, catalog, time, and migration drift", async () => {
  const { source, value: contract } = await checkedInContract();
  const { migrations, evidence } = await validEvidence(contract, source);
  const cases: Array<{
    id: string;
    mutate(value: ProductionCleanBaselineEvidence): void;
  }> = [
    {
      id: "contract_binding",
      mutate: (value) => {
        value.contract_sha256 = "0".repeat(64);
      },
    },
    {
      id: "project_binding",
      mutate: (value) => {
        value.project_identity_verified = false;
      },
    },
    {
      id: "release_binding",
      mutate: (value) => {
        value.app_release = "release-2026-07-11-wrong";
      },
    },
    {
      id: "read_only_collection",
      mutate: (value) => {
        value.read_only_query_succeeded = false;
      },
    },
    {
      id: "source_revision_binding",
      mutate: (value) => {
        value.source_revision = "b".repeat(40);
      },
    },
    {
      id: "local_migration_aggregate",
      mutate: (value) => {
        value.migrations.aggregate_sha256 = "0".repeat(64);
      },
    },
    {
      id: "tenant_data_zero",
      mutate: (value) => {
        value.relation_counts.find(
          (row) => row.relation === "public.submissions",
        )!.row_count = 1;
      },
    },
    {
      id: "auth_data_zero",
      mutate: (value) => {
        value.relation_counts.find(
          (row) => row.relation === "auth.users",
        )!.row_count = 1;
      },
    },
    {
      id: "storage_data_zero",
      mutate: (value) => {
        value.relation_counts.find(
          (row) => row.relation === "storage.objects",
        )!.row_count = 1;
      },
    },
    {
      id: "queue_data_zero",
      mutate: (value) => {
        value.relation_counts.find(
          (row) => row.relation === "pgmq.q_writing_evaluation",
        )!.row_count = 1;
      },
    },
    {
      id: "seeded_reference_allowlist",
      mutate: (value) => {
        value.relation_counts.find(
          (row) => row.relation === "public.grammar_topics",
        )!.key_sha256 = "0".repeat(64);
      },
    },
    {
      id: "application_relation_catalog",
      mutate: (value) => {
        value.application_relation_catalog.push("public.unclassified_rows");
        value.application_relation_catalog.sort();
      },
    },
    {
      id: "auth_relation_catalog",
      mutate: (value) => {
        value.auth_relation_catalog.push("auth.unclassified_payloads");
        value.auth_relation_catalog.sort();
      },
    },
    {
      id: "storage_relation_catalog",
      mutate: (value) => {
        value.storage_relation_catalog.push("storage.unclassified_payloads");
        value.storage_relation_catalog.sort();
      },
    },
    {
      id: "tracked_relation_inventory",
      mutate: (value) => {
        value.relation_counts = value.relation_counts.filter(
          (row) => row.relation !== "public.teacher_notes",
        );
      },
    },
    {
      id: "collection_time",
      mutate: (value) => {
        value.collected_at = "2026-07-11T09:00:00.000Z";
      },
    },
    {
      id: "remote_migration_versions",
      mutate: (value) => {
        value.migrations.remote_versions =
          value.migrations.remote_versions.slice(0, -1);
        value.migrations.remote_version_aggregate_sha256 =
          versionAggregateSha256(value.migrations.remote_versions);
      },
    },
  ];
  for (const scenario of cases) {
    const changed = structuredClone(evidence);
    scenario.mutate(changed);
    const report = verifyProductionCleanBaseline({
      contract,
      contract_sha256: contractSha256(source),
      evidence: changed,
      migrations,
      expected_project_ref: PROJECT_REF,
      expected_release: RELEASE,
      expected_source_revision: SOURCE_REVISION,
      now: "2026-07-11T10:01:00.000Z",
    });
    assert.equal(report.passed, false, scenario.id);
    assert.equal(
      report.checks.find((check) => check.id === scenario.id)?.passed,
      false,
    );
  }
});

test("evidence parser rejects unsupported content-bearing fields", async () => {
  const { source, value: contract } = await checkedInContract();
  const { evidence } = await validEvidence(contract, source);
  const unsafe = { ...evidence, student_writing: "raw text" };
  assert.throws(
    () => parseProductionCleanBaselineEvidence(unsafe),
    /unsupported or missing fields/,
  );
});
