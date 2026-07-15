import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const OPAQUE_EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const REDACTED_VALUE_PATTERN = /^REDACTED:[a-f0-9]{64}$/i;
const ACCEPTED_BILLING_PLANS = [
  "pay_as_you_go",
  "fixed",
  "enterprise",
] as const;

export type QstashAcceptedBillingPlan = (typeof ACCEPTED_BILLING_PLANS)[number];

export type QstashRecoveryScheduleContract = {
  schema_version: 1;
  provider: "upstash_qstash";
  region: "eu-central-1";
  api_base_url: "https://qstash-eu-central-1.upstash.io";
  schedule_id_prefix: "schreiben-v1-recovery";
  destination_path: "/functions/v1/recover-async-jobs";
  cron: "* * * * *";
  method: "POST";
  content_type: "application/json";
  body: "{}";
  timeout_seconds: 10;
  retries: 2;
  retry_delay_expression: "1000 * (1 + retried)";
  forwarded_header_name: "x-process-recovery-secret";
  secret_environment_name: "PROCESS_RECOVERY_SECRET";
  token_environment_name: "QSTASH_TOKEN";
  redact_fields: "header[x-process-recovery-secret]";
  effective_max_gap_seconds: 30;
  baseline_deliveries_per_day: 2880;
  free_plan_daily_message_limit: 1000;
  accepted_billing_plans: QstashAcceptedBillingPlan[];
  schedules: Array<{
    role: "primary" | "offset";
    id_suffix: "minute-00" | "minute-30";
    delivery_delay_seconds: 0 | 30;
  }>;
};

export type QstashRecoveryVerificationInput = {
  schema_version: 1;
  project_ref: string;
  billing_plan: QstashAcceptedBillingPlan;
  provisioning_plan_applied: boolean;
  tested_at: string;
  evidence_id: string;
  list_response: unknown;
  individual_readbacks: unknown;
};

export type QstashExternalSchedulerEvidence = {
  configured: true;
  provider: "upstash_qstash";
  region: "eu-central-1";
  billing_plan: QstashAcceptedBillingPlan;
  schedule_ids: string[];
  cron: "* * * * *";
  delivery_delays_seconds: [0, 30];
  effective_max_gap_seconds: 30;
  method: "POST";
  body_sha256: string;
  timeout_seconds: 10;
  retries: 2;
  retry_delay_expression: "1000 * (1 + retried)";
  destination_verified: true;
  forwarded_header_name: "x-process-recovery-secret";
  forwarded_header_redacted: true;
  list_readback_verified: true;
  individual_readback_verified: true;
  provisioning_plan_applied: true;
  contract_sha256: string;
  tested_at: string;
  evidence_id: string;
};

export type QstashRecoveryPlan = {
  schema_version: 1;
  provider: "upstash_qstash";
  region: "eu-central-1";
  api_base_url: string;
  project_ref: string;
  destination: string;
  token_environment_name: "QSTASH_TOKEN";
  secret_environment_name: "PROCESS_RECOVERY_SECRET";
  effective_max_gap_seconds: 30;
  baseline_deliveries_per_day: 2880;
  free_plan_daily_message_limit: 1000;
  accepted_billing_plans: QstashAcceptedBillingPlan[];
  contract_sha256: string;
  schedules: Array<{
    role: "primary" | "offset";
    schedule_id: string;
    create_endpoint: string;
    cron: "* * * * *";
    method: "POST";
    content_type: "application/json";
    body: "{}";
    delivery_delay_seconds: 0 | 30;
    timeout_seconds: 10;
    retries: 2;
    retry_delay_expression: "1000 * (1 + retried)";
    forwarded_header_name: "x-process-recovery-secret";
    forwarded_header_value_from_environment: "PROCESS_RECOVERY_SECRET";
    redact_fields: "header[x-process-recovery-secret]";
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  return (
    actual.length === normalizedExpected.length &&
    actual.every((key, index) => key === normalizedExpected[index])
  );
}

function sameArray<T>(left: readonly T[], right: readonly T[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function qstashContractSha256(contract: QstashRecoveryScheduleContract) {
  return sha256(stableJson(contract));
}

export function validateQstashRecoveryContract(
  value: unknown,
): value is QstashRecoveryScheduleContract {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "provider",
      "region",
      "api_base_url",
      "schedule_id_prefix",
      "destination_path",
      "cron",
      "method",
      "content_type",
      "body",
      "timeout_seconds",
      "retries",
      "retry_delay_expression",
      "forwarded_header_name",
      "secret_environment_name",
      "token_environment_name",
      "redact_fields",
      "effective_max_gap_seconds",
      "baseline_deliveries_per_day",
      "free_plan_daily_message_limit",
      "accepted_billing_plans",
      "schedules",
    ]) ||
    value.schema_version !== 1 ||
    value.provider !== "upstash_qstash" ||
    value.region !== "eu-central-1" ||
    value.api_base_url !== "https://qstash-eu-central-1.upstash.io" ||
    value.schedule_id_prefix !== "schreiben-v1-recovery" ||
    value.destination_path !== "/functions/v1/recover-async-jobs" ||
    value.cron !== "* * * * *" ||
    value.method !== "POST" ||
    value.content_type !== "application/json" ||
    value.body !== "{}" ||
    value.timeout_seconds !== 10 ||
    value.retries !== 2 ||
    value.retry_delay_expression !== "1000 * (1 + retried)" ||
    value.forwarded_header_name !== "x-process-recovery-secret" ||
    value.secret_environment_name !== "PROCESS_RECOVERY_SECRET" ||
    value.token_environment_name !== "QSTASH_TOKEN" ||
    value.redact_fields !== "header[x-process-recovery-secret]" ||
    value.effective_max_gap_seconds !== 30 ||
    value.baseline_deliveries_per_day !== 2_880 ||
    value.free_plan_daily_message_limit !== 1_000 ||
    !Array.isArray(value.accepted_billing_plans) ||
    !sameArray(value.accepted_billing_plans, ACCEPTED_BILLING_PLANS) ||
    !Array.isArray(value.schedules) ||
    value.schedules.length !== 2
  ) {
    return false;
  }

  const [primary, offset] = value.schedules;
  return (
    isRecord(primary) &&
    hasExactlyKeys(primary, ["role", "id_suffix", "delivery_delay_seconds"]) &&
    primary.role === "primary" &&
    primary.id_suffix === "minute-00" &&
    primary.delivery_delay_seconds === 0 &&
    isRecord(offset) &&
    hasExactlyKeys(offset, ["role", "id_suffix", "delivery_delay_seconds"]) &&
    offset.role === "offset" &&
    offset.id_suffix === "minute-30" &&
    offset.delivery_delay_seconds === 30 &&
    value.baseline_deliveries_per_day > value.free_plan_daily_message_limit
  );
}

function assertProjectRef(projectRef: string) {
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw new Error(
      "Project ref must be exactly 20 lowercase letters or digits.",
    );
  }
}

export function buildQstashScheduleIds(
  scheduleIdPrefix: string,
  projectRef: string,
  suffixes: readonly string[] = ["minute-00", "minute-30"],
) {
  assertProjectRef(projectRef);
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(scheduleIdPrefix)) {
    throw new Error("QStash schedule ID prefix is malformed.");
  }
  if (
    !sameArray(suffixes, ["minute-00", "minute-30"]) ||
    suffixes.some((suffix) => !/^[a-z0-9][a-z0-9-]{2,31}$/.test(suffix))
  ) {
    throw new Error("QStash schedule ID suffixes are malformed.");
  }
  return suffixes.map(
    (suffix) => `${scheduleIdPrefix}-${projectRef}-${suffix}`,
  );
}

export function buildQstashRecoveryPlan(
  contract: QstashRecoveryScheduleContract,
  projectRef: string,
): QstashRecoveryPlan {
  if (!validateQstashRecoveryContract(contract)) {
    throw new Error("QStash recovery schedule contract is malformed.");
  }
  assertProjectRef(projectRef);
  const destination = `https://${projectRef}.supabase.co${contract.destination_path}`;
  const scheduleIds = buildQstashScheduleIds(
    contract.schedule_id_prefix,
    projectRef,
    contract.schedules.map((schedule) => schedule.id_suffix),
  );
  // QStash expects the absolute destination URL directly in the path. Encoding
  // the complete URL causes the live API to reject it as having no http(s)
  // scheme, even though individual path components remain safely fixed here.
  const createEndpoint = `${contract.api_base_url}/v2/schedules/${destination}`;
  return {
    schema_version: 1,
    provider: contract.provider,
    region: contract.region,
    api_base_url: contract.api_base_url,
    project_ref: projectRef,
    destination,
    token_environment_name: contract.token_environment_name,
    secret_environment_name: contract.secret_environment_name,
    effective_max_gap_seconds: contract.effective_max_gap_seconds,
    baseline_deliveries_per_day: contract.baseline_deliveries_per_day,
    free_plan_daily_message_limit: contract.free_plan_daily_message_limit,
    accepted_billing_plans: [...contract.accepted_billing_plans],
    contract_sha256: qstashContractSha256(contract),
    schedules: contract.schedules.map((schedule, index) => ({
      role: schedule.role,
      schedule_id: scheduleIds[index]!,
      create_endpoint: createEndpoint,
      cron: contract.cron,
      method: contract.method,
      content_type: contract.content_type,
      body: contract.body,
      delivery_delay_seconds: schedule.delivery_delay_seconds,
      timeout_seconds: contract.timeout_seconds,
      retries: contract.retries,
      retry_delay_expression: contract.retry_delay_expression,
      forwarded_header_name: contract.forwarded_header_name,
      forwarded_header_value_from_environment: contract.secret_environment_name,
      redact_fields: contract.redact_fields,
    })),
  };
}

function shellLiteral(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function continued(value: string) {
  return `${value} \\`;
}

function provisionCurl(schedule: QstashRecoveryPlan["schedules"][number]) {
  const delayHeader =
    schedule.delivery_delay_seconds === 0
      ? []
      : [
          continued(
            `  --header ${shellLiteral(`Upstash-Delay: ${schedule.delivery_delay_seconds}s`)}`,
          ),
        ];
  return [
    continued("curl --fail-with-body --silent --show-error --max-time 20"),
    continued("  --request POST"),
    continued(`  --url ${shellLiteral(schedule.create_endpoint)}`),
    continued('  --header "Authorization: Bearer ${QSTASH_TOKEN}"'),
    continued(
      `  --header ${shellLiteral(`Content-Type: ${schedule.content_type}`)}`,
    ),
    continued(`  --header ${shellLiteral(`Upstash-Cron: ${schedule.cron}`)}`),
    continued(
      `  --header ${shellLiteral(`Upstash-Schedule-Id: ${schedule.schedule_id}`)}`,
    ),
    continued(
      `  --header ${shellLiteral(`Upstash-Method: ${schedule.method}`)}`,
    ),
    continued(
      `  --header ${shellLiteral(`Upstash-Timeout: ${schedule.timeout_seconds}s`)}`,
    ),
    continued(
      `  --header ${shellLiteral(`Upstash-Retries: ${schedule.retries}`)}`,
    ),
    continued(
      `  --header ${shellLiteral(`Upstash-Retry-Delay: ${schedule.retry_delay_expression}`)}`,
    ),
    ...delayHeader,
    continued(
      `  --header "Upstash-Forward-${schedule.forwarded_header_name}: \${PROCESS_RECOVERY_SECRET}"`,
    ),
    continued(
      `  --header ${shellLiteral(`Upstash-Redact-Fields: ${schedule.redact_fields}`)}`,
    ),
    `  --data ${shellLiteral(schedule.body)}`,
  ].join("\n");
}

export function renderQstashProvisionCommands(plan: QstashRecoveryPlan) {
  return [
    "# Review-only template. It is not executed by this repository script.",
    ': "${QSTASH_TOKEN:?Set the EU QStash token in this shell only}"',
    ': "${PROCESS_RECOVERY_SECRET:?Set the deployed recovery secret in this shell only}"',
    "",
    ...plan.schedules.flatMap((schedule) => [provisionCurl(schedule), ""]),
  ]
    .join("\n")
    .trimEnd();
}

function managementCurl(
  plan: QstashRecoveryPlan,
  method: "GET" | "DELETE",
  path: string,
) {
  return [
    continued("curl --fail-with-body --silent --show-error --max-time 20"),
    continued(`  --request ${method}`),
    continued(`  --url ${shellLiteral(`${plan.api_base_url}${path}`)}`),
    '  --header "Authorization: Bearer ${QSTASH_TOKEN}"',
  ].join("\n");
}

export function renderQstashReadbackCommands(plan: QstashRecoveryPlan) {
  const commands = [
    "# Write only redacted QStash readback into a restricted temporary directory.",
    ': "${QSTASH_TOKEN:?Set the EU QStash token in this shell only}"',
    ': "${QSTASH_READBACK_DIR:?Set QSTASH_READBACK_DIR to a restricted temporary directory}"',
    "umask 077",
    'mkdir -p -- "${QSTASH_READBACK_DIR}"',
    'chmod 700 -- "${QSTASH_READBACK_DIR}"',
    `${managementCurl(plan, "GET", "/v2/schedules")} > "\${QSTASH_READBACK_DIR}/list.json"`,
  ];
  for (const schedule of plan.schedules) {
    commands.push(
      `${managementCurl(plan, "GET", `/v2/schedules/${encodeURIComponent(schedule.schedule_id)}`)} > "\${QSTASH_READBACK_DIR}/${schedule.schedule_id}.json"`,
    );
  }
  return commands.join("\n\n");
}

export function renderQstashRollbackCommands(plan: QstashRecoveryPlan) {
  const commands = [
    "# Deletion stops future triggers; messages already created may still arrive.",
    ': "${QSTASH_TOKEN:?Set the EU QStash token in this shell only}"',
  ];
  for (const schedule of plan.schedules) {
    commands.push(
      managementCurl(
        plan,
        "DELETE",
        `/v2/schedules/${encodeURIComponent(schedule.schedule_id)}`,
      ),
    );
  }
  commands.push(
    "# Read the list again and confirm both deterministic IDs are absent.",
    managementCurl(plan, "GET", "/v2/schedules"),
  );
  return commands.join("\n\n");
}

function headerValues(value: unknown, expectedName: string) {
  if (!isRecord(value)) return null;
  const matches = Object.entries(value).filter(
    ([name]) => name.toLowerCase() === expectedName.toLowerCase(),
  );
  if (matches.length !== 1 || !Array.isArray(matches[0]?.[1])) return null;
  const values = matches[0][1];
  return values.every((item) => typeof item === "string")
    ? (values as string[])
    : null;
}

function hasHeader(value: unknown, expectedName: string) {
  return (
    isRecord(value) &&
    Object.keys(value).some(
      (name) => name.toLowerCase() === expectedName.toLowerCase(),
    )
  );
}

function validateScheduleReadback(
  value: unknown,
  plan: QstashRecoveryPlan,
  expected: QstashRecoveryPlan["schedules"][number],
  label: string,
) {
  const errors: string[] = [];
  if (!isRecord(value)) return [`${label} is not an object.`];
  const expectedDelay = expected.delivery_delay_seconds;
  const observedDelay = value.delay === undefined ? 0 : value.delay;
  const recoveryHeader = headerValues(
    value.header,
    expected.forwarded_header_name,
  );
  const contentType = headerValues(value.header, "content-type");

  if (value.scheduleId !== expected.schedule_id) {
    errors.push(`${label} has the wrong deterministic schedule ID.`);
  }
  if (value.cron !== expected.cron) {
    errors.push(`${label} has the wrong cron expression.`);
  }
  if (value.destination !== plan.destination) {
    errors.push(`${label} has the wrong destination.`);
  }
  if (value.method !== expected.method) {
    errors.push(`${label} has the wrong HTTP method.`);
  }
  if (value.isPaused !== false) {
    errors.push(`${label} is paused or has no explicit active state.`);
  }
  if (value.body !== expected.body) {
    errors.push(`${label} does not contain the exact empty JSON body.`);
  }
  if (value.retries !== expected.retries) {
    errors.push(`${label} has the wrong bounded retry count.`);
  }
  if (observedDelay !== expectedDelay) {
    errors.push(`${label} has the wrong delivery delay.`);
  }
  if (value.retryDelayExpression !== expected.retry_delay_expression) {
    errors.push(`${label} has the wrong retry-delay expression.`);
  }
  if (contentType?.length !== 1 || contentType[0] !== expected.content_type) {
    errors.push(`${label} has the wrong content type.`);
  }
  if (
    recoveryHeader?.length !== 1 ||
    !REDACTED_VALUE_PATTERN.test(recoveryHeader[0] ?? "")
  ) {
    errors.push(`${label} does not prove a redacted recovery header.`);
  }
  if (hasHeader(value.header, "authorization")) {
    errors.push(`${label} unexpectedly forwards an Authorization header.`);
  }
  if (typeof value.callback === "string" && value.callback.length > 0) {
    errors.push(`${label} unexpectedly configures a callback.`);
  }
  if (
    typeof value.failureCallback === "string" &&
    value.failureCallback.length > 0
  ) {
    errors.push(`${label} unexpectedly configures a failure callback.`);
  }
  return errors;
}

function timestampIsSafe(value: unknown, now: Date): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now.getTime() + 5 * 60_000;
}

export function verifyQstashRecoveryReadback(
  contract: QstashRecoveryScheduleContract,
  inputValue: unknown,
  now = new Date(),
  expectedProjectRef?: string,
): {
  ok: boolean;
  errors: string[];
  evidence: QstashExternalSchedulerEvidence | null;
} {
  const errors: string[] = [];
  if (!validateQstashRecoveryContract(contract)) {
    return {
      ok: false,
      errors: ["QStash recovery schedule contract is malformed."],
      evidence: null,
    };
  }
  if (
    !isRecord(inputValue) ||
    !hasExactlyKeys(inputValue, [
      "schema_version",
      "project_ref",
      "billing_plan",
      "provisioning_plan_applied",
      "tested_at",
      "evidence_id",
      "list_response",
      "individual_readbacks",
    ])
  ) {
    return {
      ok: false,
      errors: ["QStash verification input envelope is malformed."],
      evidence: null,
    };
  }
  const input = inputValue as unknown as QstashRecoveryVerificationInput;
  if (input.schema_version !== 1) {
    errors.push("QStash verification input schema version is unsupported.");
  }
  if (!PROJECT_REF_PATTERN.test(input.project_ref)) {
    errors.push("QStash verification input has an invalid project ref.");
  }
  if (
    expectedProjectRef !== undefined &&
    (!PROJECT_REF_PATTERN.test(expectedProjectRef) ||
      input.project_ref !== expectedProjectRef)
  ) {
    errors.push("QStash verification input targets a different project ref.");
  }
  if (
    !contract.accepted_billing_plans.includes(
      input.billing_plan as QstashAcceptedBillingPlan,
    )
  ) {
    errors.push(
      "QStash billing plan is not launch-capable; the Free plan is rejected.",
    );
  }
  if (input.provisioning_plan_applied !== true) {
    errors.push(
      "The exact checked-in QStash provisioning plan was not applied.",
    );
  }
  if (!timestampIsSafe(input.tested_at, now)) {
    errors.push("QStash verification timestamp is invalid or in the future.");
  }
  if (
    typeof input.evidence_id !== "string" ||
    !OPAQUE_EVIDENCE_ID_PATTERN.test(input.evidence_id)
  ) {
    errors.push("QStash evidence ID is malformed.");
  }
  if (errors.length > 0) return { ok: false, errors, evidence: null };

  const plan = buildQstashRecoveryPlan(contract, input.project_ref);
  if (!Array.isArray(input.list_response)) {
    errors.push("QStash list response is not an array.");
  }
  if (!Array.isArray(input.individual_readbacks)) {
    errors.push("QStash individual readbacks are not an array.");
  }
  if (errors.length > 0) return { ok: false, errors, evidence: null };

  const list = input.list_response as unknown[];
  const readbacks = input.individual_readbacks as unknown[];
  if (readbacks.length !== plan.schedules.length) {
    errors.push(
      "QStash individual readbacks do not contain exactly two schedules.",
    );
  }

  for (const expected of plan.schedules) {
    const listMatches = list.filter(
      (item) => isRecord(item) && item.scheduleId === expected.schedule_id,
    );
    const readbackMatches = readbacks.filter(
      (item) => isRecord(item) && item.scheduleId === expected.schedule_id,
    );
    if (listMatches.length !== 1) {
      errors.push(
        `QStash list must contain deterministic ID ${expected.schedule_id} exactly once.`,
      );
    } else {
      errors.push(
        ...validateScheduleReadback(
          listMatches[0],
          plan,
          expected,
          `QStash list entry ${expected.role}`,
        ),
      );
    }
    if (readbackMatches.length !== 1) {
      errors.push(
        `QStash GET readback must contain deterministic ID ${expected.schedule_id} exactly once.`,
      );
    } else {
      errors.push(
        ...validateScheduleReadback(
          readbackMatches[0],
          plan,
          expected,
          `QStash GET readback ${expected.role}`,
        ),
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors, evidence: null };
  return {
    ok: true,
    errors: [],
    evidence: {
      configured: true,
      provider: contract.provider,
      region: contract.region,
      billing_plan: input.billing_plan,
      schedule_ids: plan.schedules.map((schedule) => schedule.schedule_id),
      cron: contract.cron,
      delivery_delays_seconds: [0, 30],
      effective_max_gap_seconds: contract.effective_max_gap_seconds,
      method: contract.method,
      body_sha256: sha256(contract.body),
      timeout_seconds: contract.timeout_seconds,
      retries: contract.retries,
      retry_delay_expression: contract.retry_delay_expression,
      destination_verified: true,
      forwarded_header_name: contract.forwarded_header_name,
      forwarded_header_redacted: true,
      list_readback_verified: true,
      individual_readback_verified: true,
      provisioning_plan_applied: true,
      contract_sha256: plan.contract_sha256,
      tested_at: input.tested_at,
      evidence_id: input.evidence_id,
    },
  };
}

async function writeOwnerOnlyFile(path: string, contents: string) {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readJson(path: string, label: string) {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${label} is missing or not valid JSON.`);
  }
}

async function main() {
  const mode = argument("--mode") ?? "plan";
  const projectRef = argument("--project-ref");
  const workspaceRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const workspacePath = (path: string) =>
    isAbsolute(path) ? path : resolve(workspaceRoot, path);
  const contractPath = workspacePath(
    argument("--contract") ?? "config/qstash-recovery-schedules.contract.json",
  );
  if (!projectRef) {
    throw new Error(
      "Usage: qstash:recovery -- --mode <plan|provision-commands|readback-commands|rollback-commands|verify> --project-ref <20-char-ref> [--input <readback.json>] [--evidence-output <evidence.json>]",
    );
  }
  const contractValue = await readJson(contractPath, "QStash contract");
  if (!validateQstashRecoveryContract(contractValue)) {
    throw new Error("QStash recovery schedule contract is malformed.");
  }
  const plan = buildQstashRecoveryPlan(contractValue, projectRef);
  if (mode === "plan") {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (mode === "provision-commands") {
    console.log(renderQstashProvisionCommands(plan));
    return;
  }
  if (mode === "readback-commands") {
    console.log(renderQstashReadbackCommands(plan));
    return;
  }
  if (mode === "rollback-commands") {
    console.log(renderQstashRollbackCommands(plan));
    return;
  }
  if (mode !== "verify") {
    throw new Error("Unsupported QStash recovery command mode.");
  }
  const inputPath = argument("--input");
  if (!inputPath) {
    throw new Error("QStash readback verification requires --input.");
  }
  const result = verifyQstashRecoveryReadback(
    contractValue,
    await readJson(workspacePath(inputPath), "QStash readback input"),
    new Date(),
    projectRef,
  );
  if (!result.ok || !result.evidence) {
    throw new Error(`QStash readback failed:\n- ${result.errors.join("\n- ")}`);
  }
  const rendered = `${JSON.stringify(result.evidence, null, 2)}\n`;
  const evidenceOutput = argument("--evidence-output");
  if (evidenceOutput) {
    await writeOwnerOnlyFile(workspacePath(evidenceOutput), rendered);
  }
  console.log(rendered.trimEnd());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "QStash recovery schedule tooling failed.",
    );
    process.exitCode = 1;
  });
}
