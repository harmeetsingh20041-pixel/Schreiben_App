import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildQstashRecoveryPlan,
  renderQstashProvisionCommands,
  renderQstashReadbackCommands,
  renderQstashRollbackCommands,
  type QstashRecoveryScheduleContract,
  validateQstashRecoveryContract,
  verifyQstashRecoveryReadback,
} from "./qstash-recovery-schedules.js";

const projectRef = "abcde1ghijklmnopqrst";
const now = new Date("2026-07-11T20:00:00.000Z");
const contractValue = JSON.parse(
  readFileSync(
    new URL(
      "../../config/qstash-recovery-schedules.contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as unknown;
assert(validateQstashRecoveryContract(contractValue));
const contract: QstashRecoveryScheduleContract = contractValue;
const plan = buildQstashRecoveryPlan(contract, projectRef);
const preflightContract = JSON.parse(
  readFileSync(
    new URL("../../config/production-preflight.contract.json", import.meta.url),
    "utf8",
  ),
) as {
  required_external_scheduler: Record<string, unknown>;
};

function scheduleReadback(index: number) {
  const schedule = plan.schedules[index]!;
  return {
    scheduleId: schedule.schedule_id,
    cron: schedule.cron,
    destination: plan.destination,
    createdAt: 1_783_800_000_000,
    method: schedule.method,
    isPaused: false,
    header: {
      "Content-Type": [schedule.content_type],
      "x-process-recovery-secret": [`REDACTED:${"a".repeat(64)}`],
    },
    body: schedule.body,
    retries: schedule.retries,
    ...(schedule.delivery_delay_seconds === 0
      ? {}
      : { delay: schedule.delivery_delay_seconds }),
    retryDelayExpression: schedule.retry_delay_expression,
  };
}

function validInput() {
  const primary = scheduleReadback(0);
  const offset = scheduleReadback(1);
  return {
    schema_version: 1,
    project_ref: projectRef,
    billing_plan: "pay_as_you_go",
    provisioning_plan_applied: true,
    tested_at: "2026-07-11T19:55:00.000Z",
    evidence_id: "qstash-readback-20260711",
    list_response: [primary, offset, { scheduleId: "unrelated-schedule" }],
    individual_readbacks: [structuredClone(primary), structuredClone(offset)],
  };
}

test("checked-in QStash contract pins the accepted two-schedule EU design", () => {
  assert.equal(contract.provider, "upstash_qstash");
  assert.equal(contract.api_base_url, "https://qstash-eu-central-1.upstash.io");
  assert.deepEqual(
    plan.schedules.map((schedule) => schedule.schedule_id),
    [
      `schreiben-v1-recovery-${projectRef}-minute-00`,
      `schreiben-v1-recovery-${projectRef}-minute-30`,
    ],
  );
  assert.deepEqual(
    plan.schedules.map((schedule) => schedule.delivery_delay_seconds),
    [0, 30],
  );
  assert.equal(contract.effective_max_gap_seconds, 30);
  assert.equal(contract.baseline_deliveries_per_day, 2_880);
  assert.equal(contract.free_plan_daily_message_limit, 1_000);
  assert(!contract.accepted_billing_plans.includes("free" as never));
  assert(plan.destination.endsWith("/functions/v1/recover-async-jobs"));
  assert(
    plan.schedules[0]!.create_endpoint.endsWith(
      `/v2/schedules/${plan.destination}`,
    ),
  );
});

test("production preflight pins the exact QStash contract digest and controls", () => {
  assert.deepEqual(preflightContract.required_external_scheduler, {
    provider: contract.provider,
    region: contract.region,
    schedule_id_prefix: contract.schedule_id_prefix,
    schedule_id_suffixes: contract.schedules.map(
      (schedule) => schedule.id_suffix,
    ),
    destination_path: contract.destination_path,
    cron: contract.cron,
    delivery_delays_seconds: contract.schedules.map(
      (schedule) => schedule.delivery_delay_seconds,
    ),
    effective_max_gap_seconds: contract.effective_max_gap_seconds,
    method: contract.method,
    body_sha256:
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    timeout_seconds: contract.timeout_seconds,
    retries: contract.retries,
    retry_delay_expression: contract.retry_delay_expression,
    forwarded_header_name: contract.forwarded_header_name,
    baseline_deliveries_per_day: contract.baseline_deliveries_per_day,
    free_plan_daily_message_limit: contract.free_plan_daily_message_limit,
    accepted_billing_plans: contract.accepted_billing_plans,
    contract_sha256: plan.contract_sha256,
  });
});

test("review-only commands use placeholders, bounded controls, readback, and rollback", () => {
  const provision = renderQstashProvisionCommands(plan);
  const readback = renderQstashReadbackCommands(plan);
  const rollback = renderQstashRollbackCommands(plan);

  assert.match(provision, /Authorization: Bearer \$\{QSTASH_TOKEN\}/);
  assert.match(provision, /PROCESS_RECOVERY_SECRET/);
  assert.match(provision, /Upstash-Timeout: 10s/);
  assert.match(provision, /Upstash-Retries: 2/);
  assert.match(provision, /Upstash-Delay: 30s/);
  assert.match(
    provision,
    /Upstash-Redact-Fields: header\[x-process-recovery-secret\]/,
  );
  assert.equal((provision.match(/--request POST/g) ?? []).length, 2);
  assert.equal((readback.match(/--request GET/g) ?? []).length, 3);
  assert.equal((rollback.match(/--request DELETE/g) ?? []).length, 2);
  assert.match(rollback, /already created may still arrive/);

  for (const forbidden of [
    "QSTASH_TOKEN_VALUE",
    "PROCESS_RECOVERY_SECRET_VALUE",
    "Bearer real-token",
  ]) {
    assert(!`${provision}\n${readback}\n${rollback}`.includes(forbidden));
  }
});

test("offline list and individual GET verification emits only sanitized evidence", () => {
  const result = verifyQstashRecoveryReadback(contract, validInput(), now);
  assert.equal(result.ok, true);
  assert(result.evidence);
  assert.equal(result.evidence.billing_plan, "pay_as_you_go");
  assert.equal(result.evidence.effective_max_gap_seconds, 30);
  assert.equal(result.evidence.timeout_seconds, 10);
  assert.equal(result.evidence.retries, 2);
  assert.equal(result.evidence.destination_verified, true);
  assert.equal(result.evidence.forwarded_header_redacted, true);
  assert.equal(result.evidence.list_readback_verified, true);
  assert.equal(result.evidence.individual_readback_verified, true);
  assert.equal(result.evidence.provisioning_plan_applied, true);
  assert.match(result.evidence.body_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.evidence.contract_sha256, /^[a-f0-9]{64}$/);
  const rendered = JSON.stringify(result.evidence);
  assert(!rendered.includes("REDACTED:"));
  assert(!rendered.includes("QSTASH_TOKEN"));
  assert(!rendered.includes("PROCESS_RECOVERY_SECRET"));
});

const readbackFailures: Array<{
  name: string;
  mutate(input: ReturnType<typeof validInput>): void;
  expected: RegExp;
}> = [
  {
    name: "unattested provisioning plan",
    mutate(input) {
      input.provisioning_plan_applied = false;
    },
    expected: /provisioning plan was not applied/,
  },
  {
    name: "different CLI project ref",
    mutate() {},
    expected: /different project ref/,
  },
  {
    name: "Free billing plan",
    mutate(input) {
      (input as { billing_plan: string }).billing_plan = "free";
    },
    expected: /Free plan is rejected/,
  },
  {
    name: "missing deterministic list entry",
    mutate(input) {
      input.list_response = input.list_response.slice(1);
    },
    expected: /list must contain deterministic ID/,
  },
  {
    name: "paused schedule",
    mutate(input) {
      (input.individual_readbacks[0] as { isPaused: boolean }).isPaused = true;
    },
    expected: /paused/,
  },
  {
    name: "wrong 30-second offset",
    mutate(input) {
      (input.individual_readbacks[1] as { delay: number }).delay = 29;
    },
    expected: /wrong delivery delay/,
  },
  {
    name: "wrong destination",
    mutate(input) {
      (input.individual_readbacks[0] as { destination: string }).destination =
        "https://attacker.invalid";
    },
    expected: /wrong destination/,
  },
  {
    name: "raw recovery secret in readback",
    mutate(input) {
      const header = (
        input.individual_readbacks[0] as {
          header: Record<string, string[]>;
        }
      ).header;
      header["x-process-recovery-secret"] = ["DO_NOT_PRINT_SECRET"];
    },
    expected: /redacted recovery header/,
  },
  {
    name: "unexpected forwarded Authorization",
    mutate(input) {
      const header = (
        input.individual_readbacks[0] as {
          header: Record<string, string[]>;
        }
      ).header;
      header.Authorization = ["Bearer unsafe"];
    },
    expected: /Authorization header/,
  },
  {
    name: "unbounded retry drift",
    mutate(input) {
      (input.individual_readbacks[0] as { retries: number }).retries = 5;
    },
    expected: /bounded retry count/,
  },
  {
    name: "callback drift",
    mutate(input) {
      (input.individual_readbacks[0] as { callback?: string }).callback =
        "https://unexpected.example/callback";
    },
    expected: /unexpectedly configures a callback/,
  },
];

for (const scenario of readbackFailures) {
  test(`${scenario.name} fails closed`, () => {
    const input = validInput();
    scenario.mutate(input);
    const result = verifyQstashRecoveryReadback(
      contract,
      input,
      now,
      scenario.name === "different CLI project ref"
        ? "tsrqponmlkjihgfedcba"
        : projectRef,
    );
    assert.equal(result.ok, false);
    assert.equal(result.evidence, null);
    assert.match(result.errors.join("\n"), scenario.expected);
    assert(!result.errors.join("\n").includes("DO_NOT_PRINT_SECRET"));
  });
}

test("the scheduler tool performs no network or environment-secret reads", () => {
  const source = readFileSync(
    new URL("./qstash-recovery-schedules.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /exec(?:File|Sync)?\s*\(/);
});
