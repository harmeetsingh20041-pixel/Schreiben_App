import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  browserKeyIsSafeForProject,
  buildDatabaseHealthQuery,
  buildMigrationHistoryQuery,
  collectProductionEvidence,
  dataApiHeaders,
  fingerprintMigrationHistory,
  localDatabaseUrlIsSafe,
  parseFunctionInventory,
  parseSecretNames,
  productionBasePathIsSafe,
  sanitizeAuthConfig,
  type ProductionCollectorDependencies,
} from "./collect-production-preflight.js";
import {
  type CollectedProductionEvidence,
  type ProductionOperationsEvidence,
  type ProductionPreflightContract,
  type ProductionPreflightExpectations,
  normalizeOfficialSentryApiBase,
  verifyProductionPreflight,
  writeOwnerOnlyFile,
} from "./verify-production-preflight.js";
import { APPROVED_PRODUCTION_EDGE_FUNCTIONS } from "./production-edge-functions.js";
import { buildQstashScheduleIds } from "./qstash-recovery-schedules.js";

const now = new Date("2026-07-10T12:00:00.000Z");
const projectRef = "abcde1ghijklmnopqrst";
const stagingProjectRef = "tsrqponmlkjihgfedcba";
const organizationSlug = "schreiben-production";
const publishableKey = `sb_publishable_${"a".repeat(32)}`;
const serviceRoleKey = `sb_secret_${"b".repeat(32)}`;
const contract = JSON.parse(
  readFileSync(
    new URL("../../config/production-preflight.contract.json", import.meta.url),
    "utf8",
  ),
) as ProductionPreflightContract;

test("checked-in Edge Function JWT modes match the production contract", () => {
  const config = readFileSync(
    new URL("../../supabase/config.toml", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    Object.keys(contract.required_edge_function_verify_jwt).sort(),
    [...contract.required_edge_functions].sort(),
  );
  assert.deepEqual(
    contract.required_edge_functions,
    APPROVED_PRODUCTION_EDGE_FUNCTIONS,
  );
  for (const slug of contract.required_edge_functions) {
    const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const section = new RegExp(
      `\\[functions\\.${escapedSlug}\\]\\s*\\n([^[]*)`,
      "m",
    ).exec(config)?.[1];
    assert(section, `Missing [functions.${slug}] in supabase/config.toml`);
    const modes = [...section.matchAll(/^verify_jwt\s*=\s*(true|false)\s*$/gm)];
    assert.equal(
      modes.length,
      1,
      `${slug} must declare verify_jwt exactly once`,
    );
    assert.equal(
      modes[0]?.[1] === "true",
      contract.required_edge_function_verify_jwt[slug],
      `${slug} verify_jwt differs from the production contract`,
    );
  }
});

test("production preflight rejects cross-origin or URL-like base paths", () => {
  assert(productionBasePathIsSafe("/"));
  assert(productionBasePathIsSafe("/schreiben/"));
  assert(productionBasePathIsSafe("./"));
  for (const value of [
    "//attacker.invalid/",
    "/\\\\attacker.invalid/",
    "/schreiben/?redirect=//attacker.invalid/",
    "/schreiben/#//attacker.invalid/",
  ]) {
    assert.equal(productionBasePathIsSafe(value), false, value);
  }
});

test("V1 model roles are code-pinned and never accepted as Edge secrets", () => {
  const retiredModelSecrets = [
    "DEEPSEEK_MODEL",
    "DEEPSEEK_FLASH_MODEL",
    "DEEPSEEK_PRO_MODEL",
    "DEEPSEEK_PRACTICE_MODEL",
    "DEEPSEEK_WORKSHEET_MODEL",
    "DEEPSEEK_WORKSHEET_CRITIC_MODEL",
  ];
  assert.deepEqual(contract.required_edge_secret_names, [
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "GEMINI_ALLOW_PRIMARY_AUTH_FAILOVER",
    "PROCESS_FEEDBACK_SECRET",
    "PROCESS_WRITING_JOBS_SECRET",
    "PROCESS_WORKSHEET_JOBS_SECRET",
    "PROCESS_WORKSHEET_ANSWER_JOBS_SECRET",
    "PROCESS_RECOVERY_SECRET",
  ]);
  for (const name of retiredModelSecrets) {
    assert(!contract.required_edge_secret_names.includes(name), name);
  }

  const runtimeSources = [
    "../../supabase/functions/_shared/writing-feedback.ts",
    "../../supabase/functions/process-worksheet-generation-jobs/index.ts",
    "../../supabase/functions/process-worksheet-answer-jobs/index.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  for (const source of runtimeSources) {
    for (const name of retiredModelSecrets) {
      assert.doesNotMatch(
        source,
        new RegExp(`Deno\\.env\\.get\\(["']${name}["']\\)`),
      );
    }
  }
  assert.match(runtimeSources[0]!, /flashModel:\s*DEEPSEEK_V1_FLASH_MODEL/);
  assert.match(runtimeSources[0]!, /proModel:\s*DEEPSEEK_V1_PRO_MODEL/);
  assert.match(runtimeSources[1]!, /model:\s*DEEPSEEK_V1_PRO_MODEL/);
  assert.match(runtimeSources[1]!, /criticModel:\s*DEEPSEEK_V1_FLASH_MODEL/);
  assert.match(runtimeSources[2]!, /model:\s*DEEPSEEK_V1_FLASH_MODEL/);

  const runbook = readFileSync(
    new URL("../../docs/V1_LAUNCH_RUNBOOK.md", import.meta.url),
    "utf8",
  );
  for (const name of retiredModelSecrets) {
    assert.doesNotMatch(runbook, new RegExp(`\\b${name}\\b`));
  }
  assert.match(runbook, /code constants/i);
  assert.match(runbook, /gold\s+sets/i);

  const legacyContract = structuredClone(contract);
  legacyContract.required_edge_secret_names.push("DEEPSEEK_FLASH_MODEL");
  const report = verifyProductionPreflight(
    legacyContract,
    expectations(),
    evidence(),
    operations(),
    now,
  );
  assert.equal(
    report.checks.find((item) => item.id === "contract.valid")?.ok,
    false,
  );
});

test("database preflight pins every Cron name to its private command and execution context", () => {
  const query = buildDatabaseHealthQuery(contract);
  assert.equal(contract.minimum_server_version_num, 170_000);
  for (const command of [
    "reconcile_async_jobs_internal(''writing_evaluation'')",
    "reconcile_async_jobs_internal(''worksheet_generation'')",
    "reconcile_async_jobs_internal(''worksheet_answer_evaluation'')",
    "process_practice_cycle_transition_jobs(50)",
    "release_due_feedback_internal(100)",
  ]) {
    assert(query.includes(command), command);
  }
  assert(query.includes("job.database = current_database()"));
  assert(query.includes("job.username = current_user"));
  assert(query.includes("job.schedule = '30 seconds'"));
  assert(query.includes("overdue_scheduled_feedback_count"));
  assert(
    query.includes("submission.release_at <= now() - interval '60 seconds'"),
  );
  assert(
    query.includes(
      "current_setting('server_version_num')::integer as server_version_num",
    ),
  );
  assert(query.includes("publication.schemaname = 'api'"));
  assert(query.includes("unsafe_publication.schemaname = 'public'"));
  assert(query.includes("submission_status_events"));
  assert(query.includes("from public.profiles as profile"));
  assert(query.includes("join auth.users as account"));
  assert(query.includes("left join auth.users as account"));
  assert(query.includes("from auth.mfa_factors as factor"));
  assert(query.includes("factor.factor_type = 'totp'"));
  assert(query.includes("factor.status = 'verified'"));
  assert(query.includes(") >= 2"));
  assert(query.includes(") < 2"));
  assert(query.includes("platform_admin_mfa_ready"));
});

test("retired Phase 6C setup cannot restore the legacy outbound scheduler", () => {
  const setup = readFileSync(
    new URL(
      "../../supabase/setup/phase_6c_schedule_due_feedback.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const guide = readFileSync(
    new URL("../../docs/PHASE_6C_SCHEDULED_FEEDBACK.md", import.meta.url),
    "utf8",
  );
  const runbook = readFileSync(
    new URL("../../docs/V1_LAUNCH_RUNBOOK.md", import.meta.url),
    "utf8",
  );
  const preflight = readFileSync(
    new URL("../../docs/PRODUCTION_PREFLIGHT.md", import.meta.url),
    "utf8",
  );
  const feedbackTiming = readFileSync(
    new URL("../../docs/PHASE_6B_FEEDBACK_TIMING.md", import.meta.url),
    "utf8",
  );
  const roadmap = readFileSync(
    new URL("../../docs/PHASE_ROADMAP.md", import.meta.url),
    "utf8",
  );
  const cleanup = readFileSync(
    new URL("../../docs/PRODUCTION_CLEANUP.md", import.meta.url),
    "utf8",
  );
  const cliSetup = readFileSync(
    new URL("../../docs/SUPABASE_CLI_SETUP.md", import.meta.url),
    "utf8",
  );
  const authPhase = readFileSync(
    new URL("../../docs/SUPABASE_AUTH_PHASE.md", import.meta.url),
    "utf8",
  );

  for (const forbidden of [
    /\bpg_net\b/i,
    /net\.http_post/i,
    /vzcgalzspdehmnvqczfw/i,
    /process_due_feedback_secret/i,
  ]) {
    assert.doesNotMatch(setup, forbidden);
  }
  assert.match(setup, /raise exception/i);
  assert.match(setup, /20260710191319_install_queue_recovery_cron\.sql/);

  assert.doesNotMatch(guide, /net\.http_post/i);
  assert.doesNotMatch(guide, /vzcgalzspdehmnvqczfw/i);
  assert.doesNotMatch(guide, /process-due-feedback-every-5-minutes/i);
  assert.match(guide, /release-due-feedback-every-30-seconds/);
  assert.match(guide, /reconcile-ai-spend-reservations-every-30-seconds/);
  assert.match(guide, /recover-async-jobs/);

  assert.match(runbook, /does not use `pg_net`/);
  assert.match(runbook, /do not run a separate setup\s+script/i);
  assert.match(preflight, /`pg_net` is absent/);
  assert.doesNotMatch(
    `${runbook}\n${preflight}`,
    /run\s+`?supabase\/setup\/phase_6c_schedule_due_feedback\.sql`?/i,
  );

  const retiredSchedulingDocs = `${feedbackTiming}\n${roadmap}`;
  for (const forbidden of [
    /can be configured with `pg_cron` plus `pg_net`/i,
    /create\s+extension(?:\s+if\s+not\s+exists)?\s+pg_net/i,
    /net\.http_post/i,
    /invoked manually with the secret header/i,
    /supabase\s+secrets\s+set\s+PROCESS_FEEDBACK_SECRET/i,
    /Authorization:\s*Bearer <PROCESS_FEEDBACK_SECRET>/i,
    /x-process-feedback-secret:\s*<PROCESS_FEEDBACK_SECRET>/i,
    /cron\.(?:schedule|unschedule)\s*\(/i,
    /Vault-backed storage for the scheduler/i,
    /process-due-feedback-every-5-minutes/i,
    /secret-free setup SQL for safely recreating/i,
  ]) {
    assert.doesNotMatch(retiredSchedulingDocs, forbidden);
  }
  assert.match(feedbackTiming, /Historical design note.+superseded for V1/is);
  assert.match(roadmap, /Phase 6B and Phase 6C are historical milestones/i);
  for (const currentControl of [
    /release-due-feedback-every-30-seconds/,
    /recover-async-jobs/,
    /20260710191319_install_queue_recovery_cron\.sql/,
  ]) {
    assert.match(retiredSchedulingDocs, currentControl);
  }

  assert.doesNotMatch(
    cleanup,
    /cron\.unschedule\('process-due-feedback-every-5-minutes'\)/i,
  );
  assert.doesNotMatch(cleanup, /process-due-feedback-every-5-minutes/i);
  assert.match(cleanup, /Do not manually unschedule individual V1 jobs/i);
  assert.match(cleanup, /release-due-feedback-every-30-seconds/);

  assert.match(cliSetup, /Historical staging record.+not production/is);
  assert.match(authPhase, /Historical staging implementation record/is);
  assert.match(`${cliSetup}\n${authPhase}`, /V1_LAUNCH_RUNBOOK\.md/);
  assert.doesNotMatch(
    cliSetup,
    /supabase link --project-ref vzcgalzspdehmnvqczfw/i,
  );
  assert.doesNotMatch(
    cliSetup,
    /VITE_SUPABASE_URL=https:\/\/vzcgalzspdehmnvqczfw\.supabase\.co/i,
  );
  assert.doesNotMatch(
    `${cliSetup}\n${authPhase}`,
    /(?:production|launch) project(?: ref| URL)?:?\s*`?vzcgalzspdehmnvqczfw/i,
  );
});

function legacyApiKey(role: "anon" | "service_role") {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role })}.signed-by-project`;
}

test("Data API auth keeps modern secret keys out of the Bearer slot", () => {
  const modernHeaders = new Headers(dataApiHeaders(serviceRoleKey, "api"));
  assert.equal(modernHeaders.get("apikey"), serviceRoleKey);
  assert.equal(modernHeaders.get("authorization"), null);

  const legacyServiceRole = legacyApiKey("service_role");
  const legacyHeaders = new Headers(dataApiHeaders(legacyServiceRole, "api"));
  assert.equal(legacyHeaders.get("apikey"), legacyServiceRole);
  assert.equal(
    legacyHeaders.get("authorization"),
    `Bearer ${legacyServiceRole}`,
  );
});

test("browser-key safety accepts only project-verified publishable or legacy anon keys", () => {
  assert.equal(
    browserKeyIsSafeForProject({
      browserKey: publishableKey,
      serviceRoleKey,
      acceptedByProject: true,
    }),
    true,
  );
  assert.equal(
    browserKeyIsSafeForProject({
      browserKey: legacyApiKey("anon"),
      serviceRoleKey: legacyApiKey("service_role"),
      acceptedByProject: true,
    }),
    true,
  );
  assert.equal(
    browserKeyIsSafeForProject({
      browserKey: publishableKey,
      serviceRoleKey,
      acceptedByProject: false,
    }),
    false,
  );
});

test("browser-key safety rejects secret, service-role, equal, and malformed keys", () => {
  const serviceJwt = legacyApiKey("service_role");
  for (const [browserKey, configuredServiceKey] of [
    [serviceRoleKey, serviceRoleKey],
    [serviceRoleKey, `sb_secret_${"c".repeat(32)}`],
    [serviceJwt, `sb_secret_${"c".repeat(32)}`],
    [publishableKey, publishableKey],
    ["not-a-supabase-key", serviceRoleKey],
  ] as const) {
    assert.equal(
      browserKeyIsSafeForProject({
        browserKey,
        serviceRoleKey: configuredServiceKey,
        acceptedByProject: true,
      }),
      false,
      browserKey,
    );
  }
});

test("Sentry API routing accepts only the fixed official SaaS origins", () => {
  assert.equal(
    normalizeOfficialSentryApiBase("https://de.sentry.io"),
    "https://de.sentry.io",
  );
  assert.equal(
    normalizeOfficialSentryApiBase("https://us2.sentry.io/"),
    "https://us2.sentry.io",
  );
  for (const unsafe of [
    "http://de.sentry.io",
    "https://tenant.sentry.io",
    "https://de.sentry.io:8443",
    "https://de.sentry.io/api/0",
    "https://token@de.sentry.io",
  ]) {
    assert.equal(normalizeOfficialSentryApiBase(unsafe), null, unsafe);
  }
});

function expectations(): ProductionPreflightExpectations {
  return {
    schema_version: 1,
    project_ref: projectRef,
    staging_project_ref: stagingProjectRef,
    organization_slug: organizationSlug,
    organization_plan: "pro",
    project_created_after: "2026-07-01T00:00:00.000Z",
    app_url: "https://schreiben.example",
    auth_redirect_urls: [
      "https://schreiben.example/auth/confirm",
      "https://schreiben.example/auth/reset-password",
    ],
    region: "eu-central-1",
    app_release: "release-2026-07-10",
    sentry_api_base_url: "https://de.sentry.io",
    monitoring_workflows: Object.fromEntries(
      contract.required_monitoring_alerts.map((signal, index) => [
        signal,
        { id: String(1_000 + index), name: `Schreiben ${signal}` },
      ]),
    ),
    smtp: {
      admin_email: "admin@example.invalid",
      host: "smtp.example.invalid",
      port: "587",
      user: "mailer",
      sender_name: "Schreiben",
    },
    auth_rate_limits: {
      rate_limit_email_sent: 30,
      rate_limit_verify: 360,
      rate_limit_token_refresh: 1_800,
      rate_limit_otp: 30,
    },
    edge_function_versions: Object.fromEntries(
      contract.required_edge_functions.map((slug) => [slug, 7]),
    ),
  };
}

function operations(): ProductionOperationsEvidence {
  const schedulerContract = contract.required_external_scheduler;
  return {
    schema_version: 6,
    project_ref: projectRef,
    app_release: "release-2026-07-10",
    backup_recovery: {
      recovery_policy_approved: true,
      pitr_decision: "not_required",
      restore_drill_succeeded: true,
      restore_drill_at: "2026-07-01T12:00:00.000Z",
      evidence_id: "restore-evidence-20260701",
    },
    external_scheduler: {
      configured: true,
      provider: schedulerContract.provider,
      region: schedulerContract.region,
      billing_plan: "pay_as_you_go",
      schedule_ids: buildQstashScheduleIds(
        schedulerContract.schedule_id_prefix,
        projectRef,
        schedulerContract.schedule_id_suffixes,
      ),
      cron: schedulerContract.cron,
      delivery_delays_seconds: [...schedulerContract.delivery_delays_seconds],
      effective_max_gap_seconds: schedulerContract.effective_max_gap_seconds,
      method: schedulerContract.method,
      body_sha256: schedulerContract.body_sha256,
      timeout_seconds: schedulerContract.timeout_seconds,
      retries: schedulerContract.retries,
      retry_delay_expression: schedulerContract.retry_delay_expression,
      destination_verified: true,
      forwarded_header_name: schedulerContract.forwarded_header_name,
      forwarded_header_redacted: true,
      list_readback_verified: true,
      individual_readback_verified: true,
      provisioning_plan_applied: true,
      contract_sha256: schedulerContract.contract_sha256,
      tested_at: "2026-07-10T11:30:00.000Z",
      evidence_id: "scheduler-evidence-20260710",
    },
    rollback: {
      verified_at: "2026-07-10T10:00:00.000Z",
      frontend_artifact_present: true,
      edge_function_artifacts_present: true,
      database_forward_fix_plan_present: true,
      evidence_id: "rollback-evidence-20260710",
    },
    monitoring: {
      verified_at: "2026-07-10T10:00:00.000Z",
      frontend_enabled: true,
      edge_functions_enabled: true,
      send_default_pii: false,
      mask_all_text: true,
      mask_all_inputs: true,
      block_all_media: true,
      student_writing_capture: false,
      provider_payload_capture: false,
      alerts: Object.fromEntries(
        contract.required_monitoring_alerts.map((name) => [name, true]),
      ),
      evidence_id: "monitoring-evidence-20260710",
    },
    provider_redundancy: {
      verified_at: "2026-07-10T11:45:00.000Z",
      primary_auth_failover_decision: "enabled",
      primary_auth_failover_canary_passed: true,
      writing_primary_passed: true,
      writing_fallback_passed: true,
      worksheet_primary_passed: true,
      worksheet_fallback_generator_passed: true,
      worksheet_fallback_critic_passed: true,
      worksheet_answer_primary_passed: true,
      worksheet_answer_fallback_passed: true,
      worksheet_answer_invalid_output_private: true,
      worksheet_answer_primary_source: "deepseek",
      worksheet_answer_fallback_source: "gemini",
      worksheet_answer_primary_model: "deepseek-v4-flash",
      worksheet_answer_fallback_model: "gemini-3.1-flash-lite",
      invalid_output_held_private: true,
      fallback_generator_model: "gemini-3.1-flash-lite",
      fallback_critic_model: "gemini-3.1-flash-lite",
      secondary_provider_paid_tier: true,
      monthly_cost_guard_enabled: true,
      per_student_cost_target_mode: "advisory_monitor_only",
      emergency_stop_enabled: true,
      cached_input_metering_canary_passed: true,
      cost_telemetry_canary_passed: true,
      global_monthly_hard_cap_microusd: 225_000_000,
      default_workspace_monthly_cap_microusd: 100_000_000,
      maximum_projected_cost_per_student_eur: 0.75,
      advisory_operating_target_eur: 1,
      advisory_reserve_basis_points: 1_000,
      stale_exchange_rate_fallback_microrate: 1_500_000,
      exchange_rate_verified_at: "2026-07-10",
      exchange_rate_source:
        "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A",
      active_student_cohorts_tested: [20, 50, 250],
      evidence_id: "provider-canary-evidence-20260710",
    },
    student_data_governance: {
      approved_at: "2026-07-08T09:00:00.000Z",
      verified_at: "2026-07-10T10:00:00.000Z",
      minor_safe_privacy_approved: true,
      external_evaluator_dpa_approved: true,
      raw_student_writing_transfer_approved: true,
      retention_policy_approved: true,
      deletion_policy_approved: true,
      evidence_id: "student-data-governance-20260710",
    },
  };
}

function evidence(): CollectedProductionEvidence {
  const requiredEnvironment = [
    ...contract.required_frontend_environment,
    ...contract.required_collector_environment,
  ];
  return {
    schema_version: 3,
    collected_at: now.toISOString(),
    linked_project: {
      temp_project_ref: projectRef,
      cli_linked_project_refs: [projectRef],
      command_succeeded: true,
    },
    migrations: {
      local_history_succeeded: true,
      remote_history_succeeded: true,
      local: [
        {
          version: "20260710010000",
          name: "durable_jobs",
          statement_count: 2,
          statements_sha256: "a".repeat(64),
        },
        {
          version: "20260710020000",
          name: "submission_read_models",
          statement_count: 1,
          statements_sha256: "b".repeat(64),
        },
      ],
      remote: [
        {
          version: "20260710010000",
          name: "durable_jobs",
          statement_count: 2,
          statements_sha256: "a".repeat(64),
        },
        {
          version: "20260710020000",
          name: "submission_read_models",
          statement_count: 1,
          statements_sha256: "b".repeat(64),
        },
      ],
    },
    project_identity: {
      project_fetched: true,
      organization_fetched: true,
      project_ref: projectRef,
      organization_slug: organizationSlug,
      region: "eu-central-1",
      created_at: "2026-07-05T12:00:00.000Z",
      status: "ACTIVE_HEALTHY",
      organization_plan: "pro",
    },
    environment: {
      present_names: requiredEnvironment,
      declared_project_ref_matches: true,
      port_valid: true,
      base_path_valid: true,
      configured_base_path: "/",
      vite_supabase_url_matches: true,
      vite_supabase_key_accepted: true,
      demo_mode_enabled: false,
      public_teacher_signup_enabled: false,
      public_student_signup_enabled: true,
      sentry_dsn_present: true,
      sentry_dsn_destination_safe: true,
      sentry_api_base_url_matches: true,
      sentry_environment_is_production: true,
      app_release_matches: true,
      sentry_replay_enabled: false,
    },
    frontend_deployment: {
      fetched: true,
      http_status: 200,
      manifest: {
        schema_version: 1,
        app_release: "release-2026-07-10",
        supabase_url: `https://${projectRef}.supabase.co`,
        supabase_project_ref: projectRef,
        base_path: "/",
        demo_mode_enabled: false,
        public_teacher_signup_enabled: false,
        public_student_signup_enabled: true,
        sentry_environment: "production",
        sentry_replay_enabled: false,
        sentry_source_maps_configured: true,
      },
    },
    sentry_alerts: {
      fetched: true,
      http_status: 200,
      workflows: contract.required_monitoring_alerts.map((signal, index) => ({
        id: String(1_000 + index),
        name: `Schreiben ${signal}`,
        enabled: true,
        has_active_action: true,
      })),
    },
    edge_secrets: {
      command_succeeded: true,
      names: [...contract.required_edge_secret_names],
    },
    edge_functions: {
      command_succeeded: true,
      items: contract.required_edge_functions.map((slug) => ({
        slug,
        status: "ACTIVE",
        version: 7,
        verify_jwt: contract.required_edge_function_verify_jwt[slug]!,
      })),
    },
    auth: {
      fetched: true,
      site_url: "https://schreiben.example/",
      redirect_urls: [
        "https://schreiben.example/auth/reset-password/",
        "https://schreiben.example/auth/confirm",
      ],
      custom_smtp: {
        admin_email: true,
        host: true,
        port: true,
        user: true,
        password: true,
        sender_name: true,
        matches_expectation: true,
      },
      leaked_password_protection: true,
      email_confirmation_required: true,
      unverified_email_sign_in_allowed: false,
      jwt_expiry_seconds: 600,
      totp_enrollment_enabled: true,
      totp_verification_enabled: true,
      rate_limits: {
        rate_limit_email_sent: 30,
        rate_limit_verify: 360,
        rate_limit_token_refresh: 1_800,
        rate_limit_otp: 30,
      },
    },
    postgrest: { fetched: true, exposed_schemas: ["api"] },
    service_health: {
      fetched: true,
      statuses: Object.fromEntries(
        contract.required_healthy_services.map((name) => [
          name,
          "ACTIVE_HEALTHY",
        ]),
      ),
    },
    realtime: { fetched: true, suspended: false },
    database_health: {
      fetched: true,
      server_version_num: 170_006,
      reconciliation_crons_ready: true,
      release_cron_ready: true,
      overdue_scheduled_feedback_count: 0,
      realtime_publication_ready: true,
      platform_admin_mfa_ready: true,
    },
    recovery_health: {
      fetched: true,
      http_status: 200,
      last_seen_at: "2026-07-10T11:59:30.000Z",
      heartbeat_fresh: true,
      pg_net_installed: false,
      writing_queue_ready: true,
      worksheet_generation_queue_ready: true,
      worksheet_answer_queue_ready: true,
    },
    data_api: {
      public_profile_rejected: true,
      public_http_status: 406,
      api_profile_reachable: true,
      api_http_status: 200,
    },
    backups: {
      fetched: true,
      region: "eu-central-1",
      pitr_enabled: false,
      walg_enabled: true,
      latest_completed_at: "2026-07-10T04:00:00.000Z",
    },
  };
}

function failedCheck(
  collected: CollectedProductionEvidence,
  operationEvidence: ProductionOperationsEvidence,
  id: string,
) {
  const report = verifyProductionPreflight(
    contract,
    expectations(),
    collected,
    operationEvidence,
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((item) => item.id === id)?.ok, false, id);
}

test("passes only with complete production, recovery, and privacy evidence", () => {
  const report = verifyProductionPreflight(
    contract,
    expectations(),
    evidence(),
    operations(),
    now,
  );
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(report.failed, 0);
  assert(report.passed >= 25);
  assert.equal(
    report.checks.find((item) => item.id === "database.server_version")?.ok,
    true,
  );
});

test("accepts evidence at the exact PostgreSQL 17 minimum", () => {
  const collected = evidence();
  collected.database_health.server_version_num =
    contract.minimum_server_version_num;
  const report = verifyProductionPreflight(
    contract,
    expectations(),
    collected,
    operations(),
    now,
  );
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(
    report.checks.find((item) => item.id === "database.server_version")?.ok,
    true,
  );
});

test("fails closed when PostgreSQL is older than the checked-in minimum", () => {
  const collected = evidence();
  collected.database_health.server_version_num =
    contract.minimum_server_version_num - 1;
  failedCheck(collected, operations(), "database.server_version");
});

test("rejects unexpected raw database-version content in evidence", () => {
  const unsafe = evidence() as unknown as {
    database_health: Record<string, unknown>;
  };
  unsafe.database_health.server_version =
    "RAW_DATABASE_VERSION_MUST_NOT_VALIDATE";
  const report = verifyProductionPreflight(
    contract,
    expectations(),
    unsafe,
    operations(),
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "collection.valid")?.ok,
    false,
  );
  assert.doesNotMatch(JSON.stringify(report), /RAW_DATABASE_VERSION/);
});

test("owner-only output replaces a permissive existing file safely", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "schreiben-preflight-output-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "evidence.json");
  writeFileSync(output, "stale public content\n", { mode: 0o666 });
  chmodSync(output, 0o666);

  await writeOwnerOnlyFile(output, '{"safe":true}\n');

  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(readFileSync(output, "utf8"), '{"safe":true}\n');

  const collectorSource = readFileSync(
    new URL("./collect-production-preflight.ts", import.meta.url),
    "utf8",
  );
  const verifierSource = readFileSync(
    new URL("./verify-production-preflight.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    collectorSource,
    /writeOwnerOnlyFile\(outputPath\(evidencePath\), evidenceJson\)/,
  );
  assert.match(
    collectorSource,
    /writeOwnerOnlyFile\(outputPath\(reportPath\), reportJson\)/,
  );
  assert.match(
    verifierSource,
    /writeOwnerOnlyFile\(workspacePath\(reportPath\), rendered\)/,
  );
});

test("fails when the deployed frontend manifest drifts from the approved release", () => {
  const collected = evidence();
  collected.frontend_deployment.manifest!.app_release = "stale-release";
  failedCheck(
    collected,
    operations(),
    "configuration.deployed_frontend_manifest",
  );
});

test("fails when a required Sentry workflow is disabled", () => {
  const collected = evidence();
  collected.sentry_alerts.workflows[0].enabled = false;
  failedCheck(collected, operations(), "monitoring.alert_workflows_live");
});

const evidenceFailures: Array<{
  name: string;
  check: string;
  mutate(value: CollectedProductionEvidence): void;
}> = [
  {
    name: "wrong linked project",
    check: "supabase.linked_project",
    mutate: (value) => {
      value.linked_project.temp_project_ref = "zyxwvutsrqponmlkjihg";
    },
  },
  {
    name: "missing production migration",
    check: "database.migration_parity",
    mutate: (value) => {
      value.migrations.remote.pop();
    },
  },
  {
    name: "local reset migration history unavailable",
    check: "database.migration_parity",
    mutate: (value) => {
      value.migrations.local_history_succeeded = false;
    },
  },
  {
    name: "production migration history unavailable",
    check: "database.migration_parity",
    mutate: (value) => {
      value.migrations.remote_history_succeeded = false;
    },
  },
  {
    name: "same migration version with different statement digest",
    check: "database.migration_parity",
    mutate: (value) => {
      value.migrations.remote[0]!.statements_sha256 = "c".repeat(64);
    },
  },
  {
    name: "renamed production migration",
    check: "database.migration_parity",
    mutate: (value) => {
      value.migrations.remote[0]!.name = "renamed_migration";
    },
  },
  {
    name: "different production migration statement count",
    check: "database.migration_parity",
    mutate: (value) => {
      value.migrations.remote[0]!.statement_count += 1;
    },
  },
  {
    name: "duplicate production migration version",
    check: "database.migration_parity",
    mutate: (value) => {
      value.migrations.remote.push({ ...value.migrations.remote[1]! });
    },
  },
  {
    name: "extra production migration",
    check: "database.migration_parity",
    mutate: (value) => {
      value.migrations.remote.push({
        version: "20260710030000",
        name: "unexpected_migration",
        statement_count: 1,
        statements_sha256: "d".repeat(64),
      });
    },
  },
  {
    name: "unordered production migration history",
    check: "database.migration_parity",
    mutate: (value) => {
      value.migrations.remote.reverse();
    },
  },
  {
    name: "staging or unpaid production identity",
    check: "supabase.production_identity",
    mutate: (value) => {
      value.project_identity.project_ref = stagingProjectRef;
      value.project_identity.organization_plan = "free";
    },
  },
  {
    name: "missing deployment variable",
    check: "configuration.environment_present",
    mutate: (value) => {
      value.environment.present_names = value.environment.present_names.filter(
        (name) => name !== "VITE_SUPABASE_ANON_KEY",
      );
    },
  },
  {
    name: "wrong production frontend URL",
    check: "configuration.frontend_runtime",
    mutate: (value) => {
      value.environment.vite_supabase_url_matches = false;
    },
  },
  {
    name: "browser key rejected by production",
    check: "configuration.frontend_runtime",
    mutate: (value) => {
      value.environment.vite_supabase_key_accepted = false;
    },
  },
  {
    name: "demo mode enabled",
    check: "configuration.launch_flags",
    mutate: (value) => {
      value.environment.demo_mode_enabled = true;
    },
  },
  {
    name: "public student signup disabled",
    check: "configuration.launch_flags",
    mutate: (value) => {
      value.environment.public_student_signup_enabled = false;
    },
  },
  {
    name: "monitoring runtime missing",
    check: "configuration.monitoring_environment",
    mutate: (value) => {
      value.environment.sentry_dsn_present = false;
    },
  },
  {
    name: "monitoring DSN destination is unapproved",
    check: "configuration.monitoring_environment",
    mutate: (value) => {
      value.environment.sentry_dsn_destination_safe = false;
    },
  },
  {
    name: "missing Gemini redundancy secret",
    check: "edge.secrets",
    mutate: (value) => {
      value.edge_secrets.names = value.edge_secrets.names.filter(
        (name) => name !== "GEMINI_API_KEY",
      );
    },
  },
  {
    name: "outdated Edge function",
    check: "edge.functions",
    mutate: (value) => {
      value.edge_functions.items[0]!.version = 6;
    },
  },
  {
    name: "Edge function JWT-verification mode drift",
    check: "edge.functions",
    mutate: (value) => {
      value.edge_functions.items[0]!.verify_jwt =
        !value.edge_functions.items[0]!.verify_jwt;
    },
  },
  {
    name: "duplicate Edge function inventory",
    check: "edge.functions",
    mutate: (value) => {
      value.edge_functions.items.push({ ...value.edge_functions.items[0]! });
    },
  },
  {
    name: "staging provider diagnostic deployed to production",
    check: "edge.functions",
    mutate: (value) => {
      value.edge_functions.items.push({
        slug: "provider-transport-diagnostic",
        status: "ACTIVE",
        version: 1,
        verify_jwt: true,
      });
    },
  },
  {
    name: "unreviewed Edge function deployed to production",
    check: "edge.functions",
    mutate: (value) => {
      value.edge_functions.items.push({
        slug: "unreviewed-function",
        status: "ACTIVE",
        version: 1,
        verify_jwt: true,
      });
    },
  },
  {
    name: "missing queue",
    check: "queues.ready",
    mutate: (value) => {
      value.recovery_health.writing_queue_ready = false;
    },
  },
  {
    name: "missing reconciliation cron",
    check: "queues.reconciliation_cron",
    mutate: (value) => {
      value.database_health.reconciliation_crons_ready = false;
    },
  },
  {
    name: "missing release cron",
    check: "feedback.release_cron",
    mutate: (value) => {
      value.database_health.release_cron_ready = false;
    },
  },
  {
    name: "overdue scheduled feedback",
    check: "feedback.no_overdue_scheduled_releases",
    mutate: (value) => {
      value.database_health.overdue_scheduled_feedback_count = 1;
    },
  },
  {
    name: "stale recovery heartbeat",
    check: "recovery.external_heartbeat",
    mutate: (value) => {
      value.recovery_health.last_seen_at = "2026-07-10T11:55:00.000Z";
    },
  },
  {
    name: "pg_net installed",
    check: "database.pg_net_removed",
    mutate: (value) => {
      value.recovery_health.pg_net_installed = true;
    },
  },
  {
    name: "public schema accepted",
    check: "data_api.public_rejected",
    mutate: (value) => {
      value.data_api.public_profile_rejected = false;
      value.data_api.public_http_status = 200;
    },
  },
  {
    name: "api schema unreachable",
    check: "data_api.api_reachable",
    mutate: (value) => {
      value.data_api.api_profile_reachable = false;
      value.data_api.api_http_status = 404;
    },
  },
  {
    name: "public exposed in PostgREST",
    check: "data_api.exposed_schemas",
    mutate: (value) => {
      value.postgrest.exposed_schemas = ["api", "public"];
    },
  },
  {
    name: "unhealthy Supabase service",
    check: "platform.services",
    mutate: (value) => {
      value.service_health.statuses.db = "UNHEALTHY";
    },
  },
  {
    name: "missing Realtime publication",
    check: "realtime.health",
    mutate: (value) => {
      value.database_health.realtime_publication_ready = false;
    },
  },
  {
    name: "wrong Auth URL",
    check: "auth.urls",
    mutate: (value) => {
      value.auth.site_url = "https://staging.example";
    },
  },
  {
    name: "unsafe extra Auth redirect",
    check: "auth.urls",
    mutate: (value) => {
      value.auth.redirect_urls.push("http://localhost:5173/auth/confirm");
    },
  },
  {
    name: "wrong custom SMTP configuration",
    check: "auth.custom_smtp",
    mutate: (value) => {
      value.auth.custom_smtp.matches_expectation = false;
    },
  },
  {
    name: "leaked password protection off",
    check: "auth.password_and_email_safety",
    mutate: (value) => {
      value.auth.leaked_password_protection = false;
    },
  },
  {
    name: "Auth JWT lifetime drift",
    check: "auth.mfa_and_session_security",
    mutate: (value) => {
      value.auth.jwt_expiry_seconds = 3_600;
    },
  },
  {
    name: "TOTP enrollment disabled",
    check: "auth.mfa_and_session_security",
    mutate: (value) => {
      value.auth.totp_enrollment_enabled = false;
    },
  },
  {
    name: "TOTP verification disabled",
    check: "auth.mfa_and_session_security",
    mutate: (value) => {
      value.auth.totp_verification_enabled = false;
    },
  },
  {
    name: "no usable platform administrator recovery set",
    check: "auth.platform_admin_mfa_recovery",
    mutate: (value) => {
      value.database_health.platform_admin_mfa_ready = false;
    },
  },
  {
    name: "Auth rate-limit drift",
    check: "auth.rate_limits",
    mutate: (value) => {
      value.auth.rate_limits.rate_limit_email_sent = 300;
    },
  },
  {
    name: "stale backup",
    check: "backup.current",
    mutate: (value) => {
      value.backups.latest_completed_at = "2026-07-01T04:00:00.000Z";
    },
  },
];

for (const scenario of evidenceFailures) {
  test(`${scenario.name} fails closed`, () => {
    const collected = evidence();
    scenario.mutate(collected);
    failedCheck(collected, operations(), scenario.check);
  });
}

const operationFailures: Array<{
  name: string;
  check: string;
  mutate(value: ProductionOperationsEvidence): void;
}> = [
  {
    name: "PITR policy contradicts production",
    check: "backup.current",
    mutate: (value) => {
      value.backup_recovery.pitr_decision = "enabled";
    },
  },
  {
    name: "missing restore drill",
    check: "backup.restore_evidence",
    mutate: (value) => {
      value.backup_recovery.restore_drill_succeeded = false;
    },
  },
  {
    name: "slow effective external scheduler gap",
    check: "recovery.scheduler_evidence",
    mutate: (value) => {
      value.external_scheduler.effective_max_gap_seconds = 60;
    },
  },
  {
    name: "Free external scheduler plan",
    check: "recovery.scheduler_evidence",
    mutate: (value) => {
      value.external_scheduler.billing_plan = "free";
    },
  },
  {
    name: "missing external scheduler GET readback",
    check: "recovery.scheduler_evidence",
    mutate: (value) => {
      value.external_scheduler.individual_readback_verified = false;
    },
  },
  {
    name: "external scheduler provisioning plan was not applied",
    check: "recovery.scheduler_evidence",
    mutate: (value) => {
      value.external_scheduler.provisioning_plan_applied = false;
    },
  },
  {
    name: "external scheduler deterministic ID drift",
    check: "recovery.scheduler_evidence",
    mutate: (value) => {
      value.external_scheduler.schedule_ids[1] =
        "schreiben-v1-recovery-wrongprojectref00000-minute-30";
    },
  },
  {
    name: "external scheduler retry drift",
    check: "recovery.scheduler_evidence",
    mutate: (value) => {
      value.external_scheduler.retries = 5;
    },
  },
  {
    name: "missing rollback artifact",
    check: "rollback.evidence",
    mutate: (value) => {
      value.rollback.edge_function_artifacts_present = false;
    },
  },
  {
    name: "rollback evidence belongs to another release",
    check: "rollback.evidence",
    mutate: (value) => {
      value.app_release = "different-release-2026";
    },
  },
  {
    name: "monitoring can capture student writing",
    check: "monitoring.privacy",
    mutate: (value) => {
      value.monitoring.student_writing_capture = true;
    },
  },
  {
    name: "writing fallback canary failed",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.writing_fallback_passed = false;
    },
  },
  {
    name: "primary-auth failover canary failed",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.primary_auth_failover_canary_passed = false;
    },
  },
  {
    name: "worksheet fallback critic canary failed",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.worksheet_fallback_critic_passed = false;
    },
  },
  {
    name: "worksheet answer fallback canary failed",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.worksheet_answer_fallback_passed = false;
    },
  },
  {
    name: "worksheet answer invalid output became visible",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.worksheet_answer_invalid_output_private = false;
    },
  },
  {
    name: "worksheet answer fallback source is mislabeled",
    check: "operations.valid",
    mutate: (value) => {
      value.provider_redundancy.worksheet_answer_fallback_source =
        "deepseek" as typeof value.provider_redundancy.worksheet_answer_fallback_source;
    },
  },
  {
    name: "worksheet answer fallback uses an unpinned alias",
    check: "operations.valid",
    mutate: (value) => {
      value.provider_redundancy.worksheet_answer_fallback_model =
        "gemini-flash-latest" as typeof value.provider_redundancy.worksheet_answer_fallback_model;
    },
  },
  {
    name: "provider canary evidence is stale",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.verified_at = "2026-07-09T10:00:00.000Z";
    },
  },
  {
    name: "fallback generator uses an unpinned alias",
    check: "operations.valid",
    mutate: (value) => {
      value.provider_redundancy.fallback_generator_model =
        "gemini-flash-latest" as typeof value.provider_redundancy.fallback_generator_model;
    },
  },
  {
    name: "fallback critic uses the retired Gemini model",
    check: "operations.valid",
    mutate: (value) => {
      value.provider_redundancy.fallback_critic_model =
        "gemini-2.5-flash" as typeof value.provider_redundancy.fallback_critic_model;
    },
  },
  {
    name: "secondary provider is not on the paid data tier",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.secondary_provider_paid_tier = false;
    },
  },
  {
    name: "provider cost telemetry canary failed",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.cost_telemetry_canary_passed = false;
    },
  },
  {
    name: "per-student cost target became a hard admission control",
    check: "operations.valid",
    mutate: (value) => {
      value.provider_redundancy.per_student_cost_target_mode =
        "hard_admission" as typeof value.provider_redundancy.per_student_cost_target_mode;
    },
  },
  {
    name: "provider emergency stop was not enabled",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.emergency_stop_enabled = false;
    },
  },
  {
    name: "cached input metering canary failed",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.cached_input_metering_canary_passed = false;
    },
  },
  {
    name: "exchange-rate evidence is stale",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.exchange_rate_verified_at = "2026-07-02";
    },
  },
  {
    name: "stale exchange-rate fallback can admit a looser cap",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.stale_exchange_rate_fallback_microrate = 920_000;
    },
  },
  {
    name: "global provider hard cap exceeds the launch contract",
    check: "operations.valid",
    mutate: (value) => {
      value.provider_redundancy.global_monthly_hard_cap_microusd = 500_000_000;
    },
  },
  {
    name: "default workspace provider cap drifted",
    check: "operations.valid",
    mutate: (value) => {
      value.provider_redundancy.default_workspace_monthly_cap_microusd = 225_000_000;
    },
  },
  {
    name: "projected provider cost exceeds the V1 target",
    check: "providers.redundancy_canary",
    mutate: (value) => {
      value.provider_redundancy.maximum_projected_cost_per_student_eur = 1.01;
    },
  },
  {
    name: "required monitoring alert is missing",
    check: "monitoring.privacy",
    mutate: (value) => {
      value.monitoring.alerts.queue_age = false;
    },
  },
  {
    name: "minor-safe privacy approval is missing",
    check: "privacy.student_data_governance",
    mutate: (value) => {
      value.student_data_governance.minor_safe_privacy_approved = false;
    },
  },
  {
    name: "external evaluator DPA approval is missing",
    check: "privacy.student_data_governance",
    mutate: (value) => {
      value.student_data_governance.external_evaluator_dpa_approved = false;
    },
  },
  {
    name: "raw student writing transfer approval is missing",
    check: "privacy.student_data_governance",
    mutate: (value) => {
      value.student_data_governance.raw_student_writing_transfer_approved = false;
    },
  },
  {
    name: "retention policy approval is missing",
    check: "privacy.student_data_governance",
    mutate: (value) => {
      value.student_data_governance.retention_policy_approved = false;
    },
  },
  {
    name: "deletion policy approval is missing",
    check: "privacy.student_data_governance",
    mutate: (value) => {
      value.student_data_governance.deletion_policy_approved = false;
    },
  },
  {
    name: "student-data governance verification is stale",
    check: "privacy.student_data_governance",
    mutate: (value) => {
      value.student_data_governance.verified_at = "2026-07-01T10:00:00.000Z";
    },
  },
  {
    name: "student-data approval postdates its verification",
    check: "privacy.student_data_governance",
    mutate: (value) => {
      value.student_data_governance.approved_at = "2026-07-10T11:00:00.000Z";
    },
  },
];

for (const scenario of operationFailures) {
  test(`${scenario.name} fails closed`, () => {
    const operationEvidence = operations();
    scenario.mutate(operationEvidence);
    failedCheck(evidence(), operationEvidence, scenario.check);
  });
}

test("malformed or incomplete release expectations never reach a passing report", () => {
  const invalid = expectations() as unknown as Record<string, unknown>;
  invalid.region = "us-east-1";
  invalid.edge_function_versions = {};
  const report = verifyProductionPreflight(
    contract,
    invalid,
    evidence(),
    operations(),
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "expectations.valid")?.ok,
    false,
  );
});

test("missing or non-boolean deployed JWT-verification modes fail closed", () => {
  for (const malformed of [undefined, null, "false", 0] as const) {
    const collected = evidence() as unknown as {
      edge_functions: { items: Array<Record<string, unknown>> };
    };
    if (malformed === undefined) {
      delete collected.edge_functions.items[0]!.verify_jwt;
    } else {
      collected.edge_functions.items[0]!.verify_jwt = malformed;
    }
    const report = verifyProductionPreflight(
      contract,
      expectations(),
      collected,
      operations(),
      now,
    );
    assert.equal(report.ok, false, String(malformed));
    assert.equal(
      report.checks.find((item) => item.id === "collection.valid")?.ok,
      false,
      String(malformed),
    );
  }
});

test("operations evidence rejects unsupported content-bearing fields", () => {
  const unsafe = operations() as unknown as Record<string, unknown>;
  unsafe.raw_student_writing = "must never be embedded in an attestation";
  const report = verifyProductionPreflight(
    contract,
    expectations(),
    evidence(),
    unsafe,
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "operations.valid")?.ok,
    false,
  );
});

test("legacy operations evidence cannot bypass the governance contract", () => {
  const legacy = operations() as unknown as Record<string, unknown>;
  legacy.schema_version = 1;
  delete legacy.student_data_governance;
  const report = verifyProductionPreflight(
    contract,
    expectations(),
    evidence(),
    legacy,
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "operations.valid")?.ok,
    false,
  );
});

test("the checked-in contract cannot remove a gate or relax freshness", () => {
  const weakened = structuredClone(contract);
  weakened.required_edge_functions.pop();
  weakened.minimum_server_version_num = 150_000;
  weakened.maximum_heartbeat_age_seconds = 900;
  weakened.maximum_provider_canary_age_hours = 999;
  weakened.maximum_data_governance_verification_age_hours = 999;
  weakened.required_auth_security.jwt_expiry_seconds = 3_600 as 600;
  const report = verifyProductionPreflight(
    weakened,
    expectations(),
    evidence(),
    operations(),
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "contract.valid")?.ok,
    false,
  );
});

test("the checked-in contract cannot weaken administrator MFA recovery", () => {
  const weakened = structuredClone(contract);
  weakened.required_auth_security.minimum_verified_totp_factors_per_platform_admin =
    1 as 2;
  const report = verifyProductionPreflight(
    weakened,
    expectations(),
    evidence(),
    operations(),
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "contract.valid")?.ok,
    false,
  );
});

test("the checked-in contract cannot approve an additional Edge function", () => {
  const expanded = structuredClone(contract);
  expanded.required_edge_functions.push("provider-transport-diagnostic");
  expanded.required_edge_function_verify_jwt["provider-transport-diagnostic"] =
    false;
  const report = verifyProductionPreflight(
    expanded,
    expectations(),
    evidence(),
    operations(),
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "contract.valid")?.ok,
    false,
  );
});

test("the checked-in contract requires one boolean JWT mode per Edge function", () => {
  for (const mutate of [
    (value: ProductionPreflightContract) => {
      delete value.required_edge_function_verify_jwt[
        value.required_edge_functions[0]!
      ];
    },
    (value: ProductionPreflightContract) => {
      (value.required_edge_function_verify_jwt as Record<string, unknown>)[
        value.required_edge_functions[0]!
      ] = "false";
    },
    (value: ProductionPreflightContract) => {
      value.required_edge_function_verify_jwt["unexpected-function"] = false;
    },
  ]) {
    const weakened = structuredClone(contract);
    mutate(weakened);
    const report = verifyProductionPreflight(
      weakened,
      expectations(),
      evidence(),
      operations(),
      now,
    );
    assert.equal(report.ok, false);
    assert.equal(
      report.checks.find((item) => item.id === "contract.valid")?.ok,
      false,
    );
  }
});

test("nested malformed evidence returns a structured fail-closed report", () => {
  const malformed = evidence() as unknown as Record<string, unknown>;
  malformed.recovery_health = { fetched: true };
  const report = verifyProductionPreflight(
    contract,
    expectations(),
    malformed,
    operations(),
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "collection.valid")?.ok,
    false,
  );
});

test("legacy version-only production evidence fails closed", () => {
  const legacy = evidence() as unknown as Record<string, unknown>;
  legacy.schema_version = 1;
  legacy.migrations = {
    command_succeeded: true,
    local_versions: ["20260710010000"],
    remote_versions: ["20260710010000"],
  };
  const report = verifyProductionPreflight(
    contract,
    expectations(),
    legacy,
    operations(),
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "collection.valid")?.ok,
    false,
  );
});

test("content-bearing migration evidence is rejected", () => {
  const unsafe = evidence() as unknown as {
    migrations: { local: Array<Record<string, unknown>> };
  };
  unsafe.migrations.local[0]!.statements = ["select secret_payload;"];
  const report = verifyProductionPreflight(
    contract,
    expectations(),
    unsafe,
    operations(),
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "collection.valid")?.ok,
    false,
  );
  assert.doesNotMatch(JSON.stringify(report), /secret_payload/);
});

test("localhost and development URLs are rejected as release expectations", () => {
  const invalid = expectations() as unknown as Record<string, unknown>;
  invalid.app_url = "https://localhost";
  const report = verifyProductionPreflight(
    contract,
    invalid,
    evidence(),
    operations(),
    now,
  );
  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find((item) => item.id === "expectations.valid")?.ok,
    false,
  );
});

test("stored migration histories become ordered content-free fingerprints", () => {
  const statements = ["select 1;", "select 2;"];
  const direct = fingerprintMigrationHistory([
    {
      version: "20260710010000",
      name: "durable_jobs",
      statements,
    },
  ]);
  assert.equal(direct.valid, true);
  assert.deepEqual(direct.items, [
    {
      version: "20260710010000",
      name: "durable_jobs",
      statement_count: 2,
      statements_sha256:
        "361c002e99788a4c8eb207c1ac8935ef54dc1d2cd2981cb9e05c52a5fe4ebf48",
    },
  ]);
  assert.deepEqual(
    fingerprintMigrationHistory([
      {
        migration_history: [
          {
            version: "20260710010000",
            name: "durable_jobs",
            statements,
          },
        ],
      },
    ]),
    direct,
  );
  assert.doesNotMatch(JSON.stringify(direct), /select 1/);
});

test("missing, null, empty, or malformed stored statement arrays fail closed", () => {
  for (const statements of [undefined, null, [], ["select 1", 2]]) {
    const result = fingerprintMigrationHistory([
      {
        version: "20260710010000",
        name: "durable_jobs",
        statements,
      },
    ]);
    assert.equal(result.valid, false, JSON.stringify(statements));
    assert.deepEqual(result.items, []);
  }
});

test("migration history query is ordered, read-only, and local URL is loopback-only", () => {
  const query = buildMigrationHistoryQuery();
  assert.match(query, /^select/i);
  assert.match(query, /supabase_migrations\.schema_migrations/);
  assert.match(query, /order by history\.version/);
  assert(!/\b(insert|update|delete|drop|alter|grant|revoke)\b/i.test(query));
  assert(
    localDatabaseUrlIsSafe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    ),
  );
  assert(
    localDatabaseUrlIsSafe(
      "postgres://postgres:postgres@localhost:54322/postgres",
    ),
  );
  for (const unsafe of [
    "postgresql://postgres:secret@db.example.com/postgres",
    "postgresql://postgres:secret@10.0.0.2/postgres",
    "postgresql://postgres:secret@127.0.0.1/postgres?sslmode=disable",
    " postgresql://postgres:secret@127.0.0.1/postgres",
  ]) {
    assert.equal(localDatabaseUrlIsSafe(unsafe), false, unsafe);
  }
});

test("CLI inventory parsers retain only safe function controls and secret names", () => {
  const functionSource = JSON.stringify([
    {
      slug: "worker",
      status: "ACTIVE",
      version: 9,
      verify_jwt: false,
      ezbr_sha256: "secret-function-digest",
    },
  ]);
  const secretSource = JSON.stringify([
    { name: "DEEPSEEK_API_KEY", value: "must-not-survive", digest: "digest" },
  ]);
  assert.deepEqual(parseFunctionInventory(functionSource), [
    { slug: "worker", status: "ACTIVE", version: 9, verify_jwt: false },
  ]);
  assert.deepEqual(
    parseFunctionInventory(
      JSON.stringify([
        { slug: "missing", status: "ACTIVE", version: 1 },
        {
          slug: "stringified",
          status: "ACTIVE",
          version: 1,
          verify_jwt: "false",
        },
      ]),
    ),
    [
      { slug: "missing", status: "ACTIVE", version: 1, verify_jwt: null },
      {
        slug: "stringified",
        status: "ACTIVE",
        version: 1,
        verify_jwt: null,
      },
    ],
  );
  assert.deepEqual(parseSecretNames(secretSource), ["DEEPSEEK_API_KEY"]);
  assert.deepEqual(
    parseSecretNames(JSON.stringify({ DEEPSEEK_API_KEY: "digest" })),
    ["DEEPSEEK_API_KEY"],
  );
  assert(
    !JSON.stringify(parseFunctionInventory(functionSource)).includes("digest"),
  );
  assert(
    !JSON.stringify(parseSecretNames(secretSource)).includes(
      "must-not-survive",
    ),
  );
});

test("Auth sanitizer never retains SMTP or provider secret values", () => {
  const sanitized = sanitizeAuthConfig({
    site_url: "https://schreiben.example",
    uri_allow_list: "https://schreiben.example/auth/confirm",
    smtp_admin_email: "admin@example.invalid",
    smtp_host: "smtp.example.invalid",
    smtp_port: "587",
    smtp_user: "mailer",
    smtp_pass: "SMTP_SUPER_SECRET",
    smtp_sender_name: "Schreiben",
    password_hibp_enabled: true,
    jwt_exp: 600,
    mfa_totp_enroll_enabled: true,
    mfa_totp_verify_enabled: true,
    external_google_secret: "PROVIDER_SUPER_SECRET",
  });
  const rendered = JSON.stringify(sanitized);
  assert.equal(sanitized.custom_smtp.password, true);
  assert.equal(sanitized.jwt_expiry_seconds, 600);
  assert.equal(sanitized.totp_enrollment_enabled, true);
  assert.equal(sanitized.totp_verification_enabled, true);
  assert(!rendered.includes("SMTP_SUPER_SECRET"));
  assert(!rendered.includes("PROVIDER_SUPER_SECRET"));
});

function productionEnvironment(release: string) {
  const environment: Record<string, string> = {
    PORT: "5173",
    BASE_PATH: "/",
    VITE_SUPABASE_URL: `https://${projectRef}.supabase.co`,
    VITE_SUPABASE_ANON_KEY: publishableKey,
    VITE_ENABLE_DEMO_MODE: "false",
    VITE_ENABLE_PUBLIC_TEACHER_SIGNUP: "false",
    VITE_ENABLE_PUBLIC_STUDENT_SIGNUP: "true",
    VITE_SENTRY_DSN: "https://public-key@o123.ingest.de.sentry.io/456",
    VITE_SENTRY_ENVIRONMENT: "production",
    VITE_APP_RELEASE: release,
    VITE_SENTRY_ENABLE_REPLAY: "false",
    SENTRY_UPLOAD_SOURCE_MAPS: "true",
    LOCAL_SUPABASE_DB_URL:
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    SUPABASE_ACCESS_TOKEN: "MANAGEMENT_SECRET_VALUE",
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    PRODUCTION_PROJECT_REF: projectRef,
    SENTRY_AUTH_TOKEN: "SENTRY_SECRET_VALUE",
    SENTRY_API_BASE_URL: "https://de.sentry.io",
    SENTRY_ORG: "org",
    SENTRY_PROJECT: "project",
    PRODUCTION_PREFLIGHT_EXPECTATIONS_JSON: "{}",
    PRODUCTION_OPERATIONS_EVIDENCE_JSON: "{}",
  };
  return environment;
}

test("collector rejects an unapproved Sentry API destination before any credentialed work starts", async () => {
  const unsafeExpectations = expectations();
  unsafeExpectations.sentry_api_base_url = "https://collector.attacker.example";
  const environment = productionEnvironment(unsafeExpectations.app_release);
  environment.SENTRY_API_BASE_URL = unsafeExpectations.sentry_api_base_url;
  let cliCalls = 0;
  let psqlCalls = 0;
  let fetchCalls = 0;
  const dependencies: ProductionCollectorDependencies = {
    async runSupabase() {
      cliCalls += 1;
      return { ok: false, stdout: "" };
    },
    async runLocalPsql() {
      psqlCalls += 1;
      return { ok: false, stdout: "" };
    },
    async fetchImpl() {
      fetchCalls += 1;
      return Response.json({});
    },
    async readText() {
      return "";
    },
  };

  await assert.rejects(
    collectProductionEvidence(
      {
        cwd: "/workspace",
        environment,
        contract,
        expectations: unsafeExpectations,
        collectedAt: now.toISOString(),
      },
      dependencies,
    ),
    /Sentry routing configuration is not approved/,
  );
  assert.equal(cliCalls, 0);
  assert.equal(psqlCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("collector rejects an unapproved browser Sentry DSN before any credentialed work starts", async () => {
  const expected = expectations();
  const environment = productionEnvironment(expected.app_release);
  environment.VITE_SENTRY_DSN =
    "https://public-key-must-not-leak@ingest.attacker.example/456";
  let cliCalls = 0;
  let psqlCalls = 0;
  let fetchCalls = 0;
  const dependencies: ProductionCollectorDependencies = {
    async runSupabase() {
      cliCalls += 1;
      return { ok: false, stdout: "" };
    },
    async runLocalPsql() {
      psqlCalls += 1;
      return { ok: false, stdout: "" };
    },
    async fetchImpl() {
      fetchCalls += 1;
      return Response.json({});
    },
    async readText() {
      return "";
    },
  };

  await assert.rejects(
    collectProductionEvidence(
      {
        cwd: "/workspace",
        environment,
        contract,
        expectations: expected,
        collectedAt: now.toISOString(),
      },
      dependencies,
    ),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(
        error.message,
        /Sentry routing configuration is not approved/,
      );
      assert.doesNotMatch(error.message, /public-key-must-not-leak/);
      return true;
    },
  );
  assert.equal(cliCalls, 0);
  assert.equal(psqlCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("collector refuses non-loopback psql before any CLI or network work", async () => {
  const expected = expectations();
  const environment = productionEnvironment(expected.app_release);
  environment.LOCAL_SUPABASE_DB_URL =
    "postgresql://postgres:secret@production.example/postgres";
  let cliCalls = 0;
  let psqlCalls = 0;
  let fetchCalls = 0;
  const dependencies: ProductionCollectorDependencies = {
    async runSupabase() {
      cliCalls += 1;
      return { ok: false, stdout: "" };
    },
    async runLocalPsql() {
      psqlCalls += 1;
      return { ok: false, stdout: "" };
    },
    async fetchImpl() {
      fetchCalls += 1;
      return Response.json({});
    },
    async readText() {
      return "";
    },
  };

  await assert.rejects(
    collectProductionEvidence(
      {
        cwd: "/workspace",
        environment,
        contract,
        expectations: expected,
        collectedAt: now.toISOString(),
      },
      dependencies,
    ),
    /disposable loopback Supabase database/,
  );
  assert.equal(cliCalls, 0);
  assert.equal(psqlCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("online collector uses read-only contracts and emits content-free evidence", async () => {
  const expected = expectations();
  const commands: string[][] = [];
  const localPsqlCalls: Array<{ databaseUrl: string; query: string }> = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const storedMigrations = [
    {
      version: "20260710010000",
      name: "durable_jobs",
      statements: [
        "create table raw_migration_sql_must_not_enter_evidence();",
        "select 1;",
      ],
    },
    {
      version: "20260710020000",
      name: "submission_read_models",
      statements: ["select 2;"],
    },
  ];
  const dependencies: ProductionCollectorDependencies = {
    async runSupabase(args) {
      commands.push(args);
      if (args[0] === "projects") {
        return {
          ok: true,
          stdout: JSON.stringify([{ id: projectRef, linked: true }]),
        };
      }
      if (args[0] === "functions") {
        return {
          ok: true,
          stdout: JSON.stringify(
            contract.required_edge_functions.map((slug) => ({
              slug,
              status: "ACTIVE",
              version: 7,
              verify_jwt: contract.required_edge_function_verify_jwt[slug],
              ezbr_sha256: "FUNCTION_SECRET_DIGEST",
            })),
          ),
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify(
          contract.required_edge_secret_names.map((name) => ({
            name,
            digest: "EDGE_SECRET_DIGEST",
          })),
        ),
      };
    },
    async runLocalPsql(databaseUrl, query) {
      localPsqlCalls.push({ databaseUrl, query });
      return { ok: true, stdout: JSON.stringify(storedMigrations) };
    },
    async fetchImpl(input, init = {}) {
      const url = String(input);
      fetches.push({ url, init });
      if (url === `https://api.supabase.com/v1/projects/${projectRef}`) {
        return Response.json({
          ref: projectRef,
          organization_slug: organizationSlug,
          region: expected.region,
          created_at: "2026-07-05T12:00:00.000Z",
          status: "ACTIVE_HEALTHY",
        });
      }
      if (
        url === `https://api.supabase.com/v1/organizations/${organizationSlug}`
      ) {
        return Response.json({ plan: "pro" });
      }
      if (url.endsWith("/config/auth")) {
        return Response.json({
          site_url: expected.app_url,
          uri_allow_list: expected.auth_redirect_urls.join(","),
          smtp_admin_email: "admin@example.invalid",
          smtp_host: "smtp.example.invalid",
          smtp_port: "587",
          smtp_user: "mailer",
          smtp_pass: "SMTP_SECRET_VALUE",
          smtp_sender_name: "Schreiben",
          password_hibp_enabled: true,
          mailer_autoconfirm: false,
          mailer_allow_unverified_email_sign_ins: false,
          rate_limit_email_sent: 30,
          rate_limit_verify: 360,
          rate_limit_token_refresh: 1_800,
          rate_limit_otp: 30,
          jwt_exp: 600,
          mfa_totp_enroll_enabled: true,
          mfa_totp_verify_enabled: true,
          external_google_secret: "PROVIDER_SECRET_VALUE",
        });
      }
      if (url.endsWith("/postgrest")) {
        return Response.json({
          db_schema: "api",
          jwt_secret: "JWT_SECRET_VALUE",
        });
      }
      if (url.includes("/health?")) {
        return Response.json(
          contract.required_healthy_services.map((name) => ({
            name,
            status: "ACTIVE_HEALTHY",
          })),
        );
      }
      if (url.endsWith("/config/realtime")) {
        return Response.json({ suspend: false });
      }
      if (url.endsWith("/database/backups")) {
        return Response.json({
          region: expected.region,
          pitr_enabled: false,
          walg_enabled: true,
          backups: [
            { status: "COMPLETED", inserted_at: "2026-07-10T04:00:00.000Z" },
          ],
        });
      }
      if (url.endsWith("/database/query/read-only")) {
        const body = JSON.parse(String(init.body)) as { query: string };
        assert.match(body.query, /^select/i);
        assert(
          !/\b(insert|update|delete|drop|alter|grant|revoke)\b/i.test(
            body.query,
          ),
        );
        if (body.query.includes("supabase_migrations.schema_migrations")) {
          return Response.json([{ migration_history: storedMigrations }], {
            status: 201,
          });
        }
        return Response.json(
          [
            {
              server_version_num: 170_006,
              server_version: "RAW_DATABASE_VERSION_MUST_NOT_ENTER_EVIDENCE",
              reconciliation_crons_ready: true,
              release_cron_ready: true,
              overdue_scheduled_feedback_count: 0,
              realtime_publication_ready: true,
              platform_admin_mfa_ready: true,
            },
          ],
          { status: 201 },
        );
      }
      if (url.includes("/rpc/get_recovery_health")) {
        return Response.json([
          {
            last_seen_at: "2026-07-10T11:59:30.000Z",
            heartbeat_fresh: true,
            pg_net_installed: false,
            writing_queue_ready: true,
            worksheet_generation_queue_ready: true,
            worksheet_answer_queue_ready: true,
          },
        ]);
      }
      if (url.endsWith("/auth/v1/settings")) {
        return Response.json({ disable_signup: false });
      }
      if (url === `${expected.app_url}/launch-manifest.json`) {
        return Response.json({
          schema_version: 1,
          app_release: expected.app_release,
          supabase_url: `https://${projectRef}.supabase.co`,
          supabase_project_ref: projectRef,
          base_path: "/",
          demo_mode_enabled: false,
          public_teacher_signup_enabled: false,
          public_student_signup_enabled: true,
          sentry_environment: "production",
          sentry_replay_enabled: false,
          sentry_source_maps_configured: true,
        });
      }
      if (
        url.startsWith(
          "https://de.sentry.io/api/0/organizations/org/workflows/",
        )
      ) {
        return Response.json(
          contract.required_monitoring_alerts.map((signal, index) => ({
            id: String(1_000 + index),
            name: `Schreiben ${signal}`,
            enabled: true,
            actionFilters: [
              {
                actions: [{ type: "email", status: "active" }],
              },
            ],
          })),
        );
      }
      return Response.json(
        { code: "PGRST106", message: "The schema must be one of api" },
        { status: 406 },
      );
    },
    async readText() {
      return projectRef;
    },
  };

  const collected = await collectProductionEvidence(
    {
      cwd: "/workspace",
      environment: productionEnvironment(expected.app_release),
      contract,
      expectations: expected,
      collectedAt: now.toISOString(),
    },
    dependencies,
  );
  const report = verifyProductionPreflight(
    contract,
    expected,
    collected,
    operations(),
    now,
  );
  assert.equal(report.ok, true);
  assert.equal(collected.database_health.server_version_num, 170_006);

  for (const unsafeBrowserKey of [
    serviceRoleKey,
    legacyApiKey("service_role"),
  ]) {
    const unsafeEnvironment = productionEnvironment(expected.app_release);
    unsafeEnvironment.VITE_SUPABASE_ANON_KEY = unsafeBrowserKey;
    const unsafeEvidence = await collectProductionEvidence(
      {
        cwd: "/workspace",
        environment: unsafeEnvironment,
        contract,
        expectations: expected,
        collectedAt: now.toISOString(),
      },
      dependencies,
    );
    const unsafeReport = verifyProductionPreflight(
      contract,
      expected,
      unsafeEvidence,
      operations(),
      now,
    );
    assert.equal(unsafeEvidence.environment.vite_supabase_key_accepted, false);
    assert.equal(
      unsafeReport.checks.find(
        (item) => item.id === "configuration.frontend_runtime",
      )?.ok,
      false,
    );
  }

  assert(
    commands.every((args) => args.includes("-o") && args.includes("json")),
  );
  assert(!commands.some((args) => args[0] === "migration"));
  assert.equal(localPsqlCalls.length, 3);
  assert(
    localPsqlCalls.every(
      ({ databaseUrl, query }) =>
        databaseUrl.includes("127.0.0.1") &&
        query.includes("supabase_migrations.schema_migrations"),
    ),
  );
  assert(
    fetches.some(
      ({ url, init }) =>
        url.endsWith("/database/query/read-only") && init.method === "POST",
    ),
  );
  assert(
    fetches.some(({ url }) => url.includes("/rest/v1/rpc/get_recovery_health")),
  );
  assert(fetches.some(({ url }) => url.endsWith("/launch-manifest.json")));
  assert(
    fetches.some(({ url }) => url.includes("/workflows/?project=project")),
  );
  assert(
    fetches
      .filter(({ init }) => {
        const headers = new Headers(init.headers);
        return headers.has("authorization") || headers.has("apikey");
      })
      .every(({ init }) => init.redirect === "error"),
  );
  const rendered = JSON.stringify(collected);
  for (const forbidden of [
    publishableKey,
    "MANAGEMENT_SECRET_VALUE",
    serviceRoleKey,
    "DATABASE_SECRET_VALUE",
    "SENTRY_SECRET_VALUE",
    "SMTP_SECRET_VALUE",
    "PROVIDER_SECRET_VALUE",
    "JWT_SECRET_VALUE",
    "EDGE_SECRET_DIGEST",
    "FUNCTION_SECRET_DIGEST",
    "raw_migration_sql_must_not_enter_evidence",
    "RAW_DATABASE_VERSION_MUST_NOT_ENTER_EVIDENCE",
  ]) {
    assert(!rendered.includes(forbidden), forbidden);
  }
});
