import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  executeProductionWritingLoad,
  LOAD_GENERATOR_VERSION,
  LoadHarnessError,
  parseLoadCommandArguments,
  runLoadCommand,
  validateWritingLoadScenario,
  type LoadHarnessDependencies,
  type WritingLoadScenario,
} from "./run-writing-load-test.js";
import { verifyReleaseGates } from "./verify-release-gates.js";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const PROJECT_REF = "abcde1ghijklmnopqrst";

function uuid(index: number, group = 4) {
  return `00000000-0000-${group}000-8000-${index.toString(16).padStart(12, "0")}`;
}

function jwt(subject: string, expiresAt = NOW.getTime() + 10 * 60_000) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: subject,
    iss: `https://${PROJECT_REF}.supabase.co/auth/v1`,
    role: "authenticated",
    exp: Math.floor(expiresAt / 1_000),
  })}.test-signature`;
}

function scenario(actorCount = 20): WritingLoadScenario {
  return {
    schema_version: 1,
    environment: "production",
    purpose: "isolated-production-writing-load-test",
    isolated_test_data: true,
    project_ref: PROJECT_REF,
    supabase_url: `https://${PROJECT_REF}.supabase.co`,
    anon_key: `sb_publishable_${"a".repeat(32)}`,
    load_attestation_id: "authorized-load-20260710",
    authorized_from: "2026-07-10T11:55:00.000Z",
    authorized_until: "2026-07-10T12:30:00.000Z",
    actors: Array.from({ length: actorCount }, (_, index) => {
      const subject = uuid(index + 1);
      return {
        virtual_user_id: `virtual-user-${(index + 1).toString().padStart(2, "0")}`,
        access_token: jwt(subject),
        batch_id: uuid(1_000 + index),
        source_type: "workspace_question" as const,
        source_id: uuid(2_000 + index),
        authorized_for_load_test: true as const,
      };
    }),
  };
}

function tokenSubject(authorization: string | null) {
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Missing test authorization header");
  }
  const token = authorization.slice("Bearer ".length);
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
  ) as { sub: string };
  return payload.sub;
}

type MockBehavior = {
  unauthorizedAuthSubject?: string;
  unauthorizedSubmitSubject?: string;
  status?: "success" | "failed" | "indefinite" | "lost";
};

function mockRuntime(behavior: MockBehavior = {}) {
  let monotonic = 0;
  let randomIndex = 10_000;
  const sequence: string[] = [];
  const submittedBodies: Array<Record<string, unknown>> = [];
  const statusCounts = new Map<string, number>();
  const submissionBySubject = new Map<string, string>();
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    const subject = tokenSubject(headers.get("Authorization"));

    if (url.pathname === "/auth/v1/user") {
      sequence.push(`auth:${subject}`);
      if (subject === behavior.unauthorizedAuthSubject) {
        return Response.json(
          { code: "PGRST301", message: "sensitive" },
          {
            status: 401,
          },
        );
      }
      return Response.json({
        id: subject,
        email: "must-not-be-emitted@example.invalid",
      });
    }

    if (url.pathname === "/rest/v1/rpc/submit_writing") {
      sequence.push(`submit:${subject}`);
      assert.equal(headers.get("Accept-Profile"), "api");
      assert.equal(headers.get("Content-Profile"), "api");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      submittedBodies.push(body);
      if (subject === behavior.unauthorizedSubmitSubject) {
        return Response.json(
          {
            code: "42501",
            message: `${headers.get("Authorization")} ${body.text}`,
          },
          { status: 403 },
        );
      }
      const actorIndex = Number.parseInt(subject.slice(-12), 16);
      const submissionId = uuid(3_000 + actorIndex);
      submissionBySubject.set(subject, submissionId);
      return Response.json([
        {
          submission_id: submissionId,
          evaluation_status: "queued",
          release_status: "held",
          release_at: null,
        },
      ]);
    }

    if (url.pathname === "/functions/v1/kick-writing-jobs") {
      sequence.push(`kick:${subject}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.deepEqual(body, {});
      return Response.json(
        { status: "accepted", request_id: uuid(9_000) },
        {
          status: 202,
        },
      );
    }

    if (url.pathname === "/rest/v1/rpc/get_submission_detail") {
      sequence.push(`status:${subject}`);
      assert.equal(headers.get("Accept-Profile"), "api");
      assert.equal(headers.get("Content-Profile"), "api");
      const expectedSubmission = submissionBySubject.get(subject)!;
      const requestBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      assert.equal(requestBody.target_submission_id, expectedSubmission);
      const poll = (statusCounts.get(subject) ?? 0) + 1;
      statusCounts.set(subject, poll);
      if (behavior.status === "lost") {
        return Response.json({
          schema_version: 1,
          submission: { id: uuid(8_000) },
        });
      }
      const state =
        behavior.status === "failed"
          ? "failed"
          : behavior.status === "indefinite"
            ? "queued"
            : poll === 1
              ? "processing"
              : "ready";
      return Response.json({
        schema_version: 1,
        submission: {
          id: expectedSubmission,
          evaluation_status: state,
          release_status: state === "ready" ? "released" : "held",
          feedback_started_at: state === "queued" ? null : NOW.toISOString(),
          feedback_completed_at:
            state === "ready" || state === "failed" ? NOW.toISOString() : null,
          original_text: "must never enter evidence",
        },
        feedback: null,
      });
    }

    throw new Error(`Unexpected test URL: ${url.pathname}`);
  };

  const dependencies: Partial<LoadHarnessDependencies> = {
    fetch: fetchMock,
    now: () => new Date(NOW.getTime() + monotonic),
    monotonicNow: () => monotonic,
    sleep: async (_milliseconds, signal) => {
      if (signal.aborted) throw new Error("aborted");
      monotonic += 5;
    },
    randomUUID: () => uuid(randomIndex++),
    pollIntervalMs: 1,
    jobTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  };
  return {
    dependencies,
    sequence,
    submittedBodies,
    submissionBySubject,
  };
}

async function expectLoadError(
  operation: Promise<unknown> | (() => unknown),
  code: string,
) {
  try {
    if (typeof operation === "function") operation();
    else await operation;
    assert.fail(`Expected ${code}`);
  } catch (error) {
    assert(error instanceof LoadHarnessError);
    assert.equal(error.code, code);
    return error;
  }
}

test("runs 20 isolated actors behind one synchronized barrier and emits content-free raw rows", async () => {
  const input = scenario();
  const runtime = mockRuntime();
  const result = await executeProductionWritingLoad(
    input,
    runtime.dependencies,
  );

  assert.equal(result.actor_count, 20);
  assert.equal(result.evidence.length, 60);
  assert.equal(new Set(result.evidence.map((row) => row.event_id)).size, 60);
  const releaseContract = verifyReleaseGates(
    result.evidence,
    {},
    "release-2026-07-10",
    PROJECT_REF,
    NOW,
  );
  assert.equal(releaseContract.ok, false);
  assert.equal(releaseContract.load_test_20_concurrent, false);
  assert(
    releaseContract.errors.some((error) =>
      error.includes("must use schema_version 2"),
    ),
  );
  for (const metric of [
    "submission_acknowledgement_ms",
    "immediate_job_start_ms",
    "feedback_completion_ms",
  ]) {
    const rows = result.evidence.filter((row) => row.metric === metric);
    assert.equal(rows.length, 20);
    assert.equal(new Set(rows.map((row) => row.virtual_user_id)).size, 20);
  }
  for (const row of result.evidence) {
    assert.equal(row.concurrent_users, 20);
    assert.equal(row.load_attestation_id, input.load_attestation_id);
    assert.equal(row.load_generator_version, LOAD_GENERATOR_VERSION);
    assert.equal(row.environment, "production");
    assert.equal(row.source, "synthetic");
  }
  const starts = result.evidence.map((row) =>
    Date.parse(row.virtual_user_started_at!),
  );
  assert(Math.max(...starts) - Math.min(...starts) <= 2_000);

  assert.equal(
    runtime.sequence.filter((entry) => entry.startsWith("auth:")).length,
    20,
  );
  assert.equal(
    runtime.sequence.filter((entry) => entry.startsWith("submit:")).length,
    20,
  );
  assert.equal(
    runtime.sequence.filter((entry) => entry.startsWith("kick:")).length,
    20,
  );
  assert(
    runtime.sequence.findIndex((entry) => entry.startsWith("submit:")) >
      runtime.sequence
        .map((entry) => entry.startsWith("auth:"))
        .lastIndexOf(true),
  );
  assert(
    runtime.sequence.findIndex((entry) => entry.startsWith("kick:")) >
      runtime.sequence
        .map((entry) => entry.startsWith("submit:"))
        .lastIndexOf(true),
  );
  assert.equal(
    new Set(runtime.submittedBodies.map((body) => body.text)).size,
    1,
  );
  assert.deepEqual(
    new Set(runtime.submittedBodies.map((body) => body.batch_id)),
    new Set(input.actors.map((actor) => actor.batch_id)),
  );
  assert.deepEqual(
    new Set(runtime.submittedBodies.map((body) => body.source_id)),
    new Set(input.actors.map((actor) => actor.source_id)),
  );
  assert(
    runtime.submittedBodies.every(
      (body) => body.source_type === "workspace_question",
    ),
  );
  assert.equal(typeof runtime.submittedBodies[0]!.text, "string");
  assert(
    (runtime.submittedBodies[0]!.text as string).includes("synthetischer"),
  );
  assert((runtime.submittedBodies[0]!.text as string).length <= 1_500);

  const evidenceSource = JSON.stringify(result.evidence);
  for (const actor of input.actors) {
    assert(!evidenceSource.includes(actor.access_token));
    assert(!evidenceSource.includes(actor.batch_id));
    assert(!evidenceSource.includes(actor.source_id));
    assert(
      !evidenceSource.includes(tokenSubject(`Bearer ${actor.access_token}`)),
    );
  }
  for (const submissionId of runtime.submissionBySubject.values()) {
    assert(!evidenceSource.includes(submissionId));
  }
  assert(!evidenceSource.includes("synthetischer Text"));
  assert(!evidenceSource.includes("must never enter evidence"));
});

test("the CLI is validation-only by default and never invokes fetch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schreiben-load-scenario-"));
  const scenarioPath = join(directory, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify(scenario()), { mode: 0o600 });
  let fetchCalls = 0;
  const result = await runLoadCommand(
    ["--scenario", scenarioPath],
    {},
    {
      now: () => NOW,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("must not be reached");
      },
    },
    resolve(import.meta.dirname, "../.."),
  );

  assert.deepEqual(result, {
    mode: "validation_only",
    actor_count: 20,
    load_attestation_id: "authorized-load-20260710",
  });
  assert.equal(fetchCalls, 0);
});

test("execution requires the attestation confirmation before any network request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schreiben-load-confirm-"));
  const scenarioPath = join(directory, "scenario.json");
  const outputPath = join(directory, "evidence.jsonl");
  await writeFile(scenarioPath, JSON.stringify(scenario()), { mode: 0o600 });
  let fetchCalls = 0;
  const error = await expectLoadError(
    runLoadCommand(
      ["--scenario", scenarioPath, "--execute", "--output", outputPath],
      {},
      {
        now: () => NOW,
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("must not be reached");
        },
      },
      resolve(import.meta.dirname, "../.."),
    ),
    "execution_not_confirmed",
  );
  assert.equal(fetchCalls, 0);
  assert(!error.message.includes(inputToken(scenario())));
});

function inputToken(value: WritingLoadScenario) {
  return value.actors[0]!.access_token;
}

test("command execution writes exactly 60 JSONL rows to a new evidence file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schreiben-load-output-"));
  const scenarioPath = join(directory, "scenario.json");
  const outputPath = join(directory, "evidence.jsonl");
  const input = scenario();
  await writeFile(scenarioPath, JSON.stringify(input), { mode: 0o600 });
  const runtime = mockRuntime();
  const result = await runLoadCommand(
    ["--scenario", scenarioPath, "--execute", "--output", outputPath],
    { SCHREIBEN_PRODUCTION_LOAD_CONFIRM: input.load_attestation_id },
    runtime.dependencies,
    resolve(import.meta.dirname, "../.."),
  );
  assert.deepEqual(result, {
    mode: "executed",
    actor_count: 20,
    load_attestation_id: input.load_attestation_id,
    row_count: 60,
  });
  const rows = (await readFile(outputPath, "utf8")).trim().split("\n");
  assert.equal(rows.length, 60);
  assert(
    rows.every(
      (row) =>
        JSON.parse(row).load_generator_version === LOAD_GENERATOR_VERSION,
    ),
  );
});

test("an existing evidence target blocks execution before any network request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schreiben-load-existing-"));
  const scenarioPath = join(directory, "scenario.json");
  const outputPath = join(directory, "evidence.jsonl");
  const input = scenario();
  await writeFile(scenarioPath, JSON.stringify(input), { mode: 0o600 });
  await writeFile(outputPath, "existing evidence\n", { mode: 0o600 });
  let fetchCalls = 0;
  await expectLoadError(
    runLoadCommand(
      ["--scenario", scenarioPath, "--execute", "--output", outputPath],
      { SCHREIBEN_PRODUCTION_LOAD_CONFIRM: input.load_attestation_id },
      {
        now: () => NOW,
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("must not be reached");
        },
      },
      resolve(import.meta.dirname, "../.."),
    ),
    "evidence_target_exists",
  );
  assert.equal(fetchCalls, 0);
  assert.equal(await readFile(outputPath, "utf8"), "existing evidence\n");
});

test("a failed run removes its empty evidence reservation", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "schreiben-load-failed-output-"),
  );
  const scenarioPath = join(directory, "scenario.json");
  const outputPath = join(directory, "evidence.jsonl");
  const input = scenario();
  await writeFile(scenarioPath, JSON.stringify(input), { mode: 0o600 });
  const runtime = mockRuntime({ status: "failed" });
  await expectLoadError(
    runLoadCommand(
      ["--scenario", scenarioPath, "--execute", "--output", outputPath],
      { SCHREIBEN_PRODUCTION_LOAD_CONFIRM: input.load_attestation_id },
      runtime.dependencies,
      resolve(import.meta.dirname, "../.."),
    ),
    "evaluation_failed",
  );
  await assert.rejects(access(outputPath));
});

test("fewer than 20 or non-distinct actors fail before fetch", async () => {
  await expectLoadError(
    () => validateWritingLoadScenario(scenario(19), NOW),
    "scenario_actor_count_invalid",
  );
  const duplicated = scenario();
  duplicated.actors[1]!.access_token = duplicated.actors[0]!.access_token;
  await expectLoadError(
    () => validateWritingLoadScenario(duplicated, NOW),
    "scenario_actors_not_distinct",
  );
});

test("scenario schema rejects embedded writing and in-repository credential files", async () => {
  const withWriting = scenario() as unknown as Record<string, unknown>;
  (withWriting.actors as Array<Record<string, unknown>>)[0]!.text =
    "real student content must never be accepted";
  await expectLoadError(
    () => validateWritingLoadScenario(withWriting, NOW),
    "scenario_invalid",
  );

  const directory = await mkdtemp(join(tmpdir(), "schreiben-load-root-"));
  const scenarioPath = join(directory, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify(scenario()), { mode: 0o600 });
  await expectLoadError(
    runLoadCommand(
      ["--scenario", scenarioPath],
      {},
      { now: () => NOW },
      directory,
    ),
    "scenario_path_unsafe",
  );

  if (process.platform !== "win32") {
    const externalDirectory = await mkdtemp(
      join(tmpdir(), "schreiben-load-permissions-"),
    );
    const externalScenario = join(externalDirectory, "scenario.json");
    await writeFile(externalScenario, JSON.stringify(scenario()), {
      mode: 0o600,
    });
    await chmod(externalScenario, 0o644);
    await expectLoadError(
      runLoadCommand(
        ["--scenario", externalScenario],
        {},
        { now: () => NOW },
        resolve(import.meta.dirname, "../.."),
      ),
      "scenario_path_unsafe",
    );
  }
});

test("scenario validation rejects unisolated resources and privileged browser keys", async () => {
  const unisolated = scenario() as unknown as Record<string, unknown>;
  unisolated.isolated_test_data = false;
  await expectLoadError(
    () => validateWritingLoadScenario(unisolated, NOW),
    "scenario_invalid",
  );

  const unauthorizedResource = scenario() as unknown as Record<string, unknown>;
  (
    unauthorizedResource.actors as Array<Record<string, unknown>>
  )[0]!.authorized_for_load_test = false;
  await expectLoadError(
    () => validateWritingLoadScenario(unauthorizedResource, NOW),
    "scenario_invalid",
  );

  const serviceKey = scenario() as unknown as Record<string, unknown>;
  serviceKey.anon_key = `sb_secret_${"x".repeat(40)}`;
  await expectLoadError(
    () => validateWritingLoadScenario(serviceKey, NOW),
    "scenario_invalid",
  );
});

test("an unauthorized auth preflight fails before any submission", async () => {
  const input = scenario();
  const rejectedSubject = tokenSubject(
    `Bearer ${input.actors[3]!.access_token}`,
  );
  const runtime = mockRuntime({ unauthorizedAuthSubject: rejectedSubject });
  await expectLoadError(
    executeProductionWritingLoad(input, runtime.dependencies),
    "unauthorized",
  );
  assert.equal(
    runtime.sequence.filter((entry) => entry.startsWith("submit:")).length,
    0,
  );
});

test("unauthorized submission errors remain content-free", async () => {
  const input = scenario();
  const rejectedSubject = tokenSubject(
    `Bearer ${input.actors[5]!.access_token}`,
  );
  const runtime = mockRuntime({ unauthorizedSubmitSubject: rejectedSubject });
  const error = await expectLoadError(
    executeProductionWritingLoad(input, runtime.dependencies),
    "unauthorized",
  );
  assert(!error.message.includes(input.actors[5]!.access_token));
  assert(!error.message.includes("synthetischer"));
});

for (const [status, expectedCode] of [
  ["failed", "evaluation_failed"],
  ["indefinite", "job_indefinite"],
  ["lost", "submission_lost"],
] as const) {
  test(`${status} jobs fail closed without emitting qualifying evidence`, async () => {
    const runtime = mockRuntime({ status });
    if (status === "indefinite") {
      runtime.dependencies.jobTimeoutMs = 10;
    }
    await expectLoadError(
      executeProductionWritingLoad(scenario(), runtime.dependencies),
      expectedCode,
    );
  });
}

test("command parser never infers execute mode", async () => {
  assert.deepEqual(
    parseLoadCommandArguments(["--", "--scenario", "/secure/scenario.json"]),
    {
      scenarioPath: "/secure/scenario.json",
      outputPath: undefined,
      execute: false,
    },
  );
  await expectLoadError(
    () =>
      parseLoadCommandArguments([
        "--scenario",
        "/secure/scenario.json",
        "--output",
        "evidence.jsonl",
      ]),
    "arguments_invalid",
  );
});
