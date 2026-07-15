import { createEvaluatePracticeAttemptRequestHandler } from "./request.ts";
import { UUID_COMMAND_REQUEST_MAX_BYTES } from "../_shared/bounded-json-request.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

const assignmentId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const actorId = "44444444-4444-4444-8444-444444444444";
const token = "header.payload.signature";
const authorization = `Bearer ${token}`;
const verifyUserToken = async () => ({
  status: "verified" as const,
  userId: actorId,
});

function rawRequest(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("https://example.test/evaluate-practice-attempt", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

function chunkedRequest(body: string) {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  return rawRequest(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.byteLength, offset + 512);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    }),
  );
}

function stalledRequest(body: string) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    request: rawRequest(stream),
    wasCancelled: () => cancelled,
  };
}

Deno.test("a forged evaluation token is rejected before attempt acknowledgement", async () => {
  let acknowledged = false;
  let authorized = false;
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken: async () => ({ status: "invalid" }),
    acknowledgeAttempt: async () => {
      acknowledged = true;
      throw new Error("must not run");
    },
    authorizeProcessorKick: async () => {
      authorized = true;
      return "allowed";
    },
    kickProcessor: async () => undefined,
    waitUntil: () => undefined,
    log: () => undefined,
  });

  const response = await handler(
    new Request("https://example.test/evaluate-practice-attempt", {
      method: "POST",
      headers: {
        Authorization: "Bearer header.payload.forged",
        "Content-Type": "application/json",
      },
      body: "not-json",
    }),
  );

  assertEquals(response.status, 401);
  assert(!acknowledged, "A forged token must not reach the attempt RPC.");
  assert(
    !authorized,
    "A forged token must not reach privileged kick authorization.",
  );
});

Deno.test("an evaluation auth outage returns 503 before body parsing or RPC work", async () => {
  let acknowledged = false;
  let authorized = false;
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken: async () => ({ status: "unavailable" }),
    acknowledgeAttempt: async () => {
      acknowledged = true;
      throw new Error("must not run");
    },
    authorizeProcessorKick: async () => {
      authorized = true;
      return "allowed";
    },
    kickProcessor: async () => undefined,
    waitUntil: () => undefined,
    log: () => undefined,
  });

  const response = await handler(
    new Request("https://example.test/evaluate-practice-attempt", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: "not-json",
    }),
  );

  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error:
      "Authentication service is temporarily unavailable. Please try again.",
  });
  assert(!acknowledged, "Verifier outage reached the attempt RPC.");
  assert(!authorized, "Verifier outage reached privileged kick authorization.");
});

Deno.test("an oversized declared evaluation request returns 413 before RPC work", async () => {
  let acknowledged = false;
  let authorized = false;
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken,
    acknowledgeAttempt: async () => {
      acknowledged = true;
      throw new Error("must not run");
    },
    authorizeProcessorKick: async () => {
      authorized = true;
      return "allowed";
    },
    kickProcessor: async () => undefined,
    waitUntil: () => undefined,
    log: () => undefined,
  });
  const text = JSON.stringify({
    assignment_id: assignmentId,
    attempt_id: attemptId,
    padding: "x".repeat(UUID_COMMAND_REQUEST_MAX_BYTES),
  });

  const response = await handler(rawRequest(text, {
    "Content-Length": String(new TextEncoder().encode(text).byteLength),
  }));
  assertEquals(response.status, 413);
  assertEquals(await response.json(), {
    error: "Request body is too large.",
  });
  assert(!acknowledged, "Oversized input reached the attempt RPC.");
  assert(!authorized, "Oversized input reached privileged kick authorization.");
});

Deno.test("an oversized chunked evaluation request returns 413 before RPC work", async () => {
  let acknowledged = false;
  let authorized = false;
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken,
    acknowledgeAttempt: async () => {
      acknowledged = true;
      throw new Error("must not run");
    },
    authorizeProcessorKick: async () => {
      authorized = true;
      return "allowed";
    },
    kickProcessor: async () => undefined,
    waitUntil: () => undefined,
    log: () => undefined,
  });
  const req = chunkedRequest(JSON.stringify({
    assignment_id: assignmentId,
    attempt_id: attemptId,
    padding: "x".repeat(UUID_COMMAND_REQUEST_MAX_BYTES),
  }));
  assertEquals(req.headers.get("content-length"), null);

  const response = await handler(req);
  assertEquals(response.status, 413);
  assertEquals(await response.json(), {
    error: "Request body is too large.",
  });
  assert(!acknowledged, "Chunked oversized input reached the attempt RPC.");
  assert(
    !authorized,
    "Chunked oversized input reached privileged kick authorization.",
  );
});

Deno.test("a stalled authenticated evaluation request returns 408 before RPC work", async () => {
  let acknowledged = false;
  let authorized = false;
  let kicked = false;
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken,
    requestBodyReadTimeoutMs: 20,
    acknowledgeAttempt: async () => {
      acknowledged = true;
      throw new Error("must not run");
    },
    authorizeProcessorKick: async () => {
      authorized = true;
      return "allowed";
    },
    kickProcessor: async () => {
      kicked = true;
    },
    waitUntil: () => undefined,
    log: () => undefined,
  });
  const stalled = stalledRequest("{}");

  const response = await handler(stalled.request);

  assertEquals(response.status, 408);
  assertEquals(await response.json(), { error: "Request body timed out." });
  assert(
    stalled.wasCancelled(),
    "Timed-out evaluation body was not cancelled.",
  );
  assert(!acknowledged, "Timed-out input reached the attempt RPC.");
  assert(!authorized, "Timed-out input reached kick authorization.");
  assert(!kicked, "Timed-out input kicked the evaluation processor.");
});

Deno.test("authenticated malformed evaluation JSON preserves the stable 400 error", async () => {
  let acknowledged = false;
  let authorized = false;
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken,
    acknowledgeAttempt: async () => {
      acknowledged = true;
      throw new Error("must not run");
    },
    authorizeProcessorKick: async () => {
      authorized = true;
      return "allowed";
    },
    kickProcessor: async () => undefined,
    waitUntil: () => undefined,
    log: () => undefined,
  });

  const response = await handler(rawRequest("not-json"));
  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "Invalid request body." });
  assert(!acknowledged, "Malformed JSON reached the attempt RPC.");
  assert(!authorized, "Malformed JSON reached privileged kick authorization.");
});

Deno.test("authenticated evaluation request returns durable state with 202 without provider blocking", async () => {
  let acknowledgementArgs: unknown;
  let background: Promise<unknown> | null = null;
  let resolveKick!: () => void;
  const pendingKick = new Promise<void>((resolve) => {
    resolveKick = resolve;
  });
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken,
    acknowledgeAttempt: async (args) => {
      acknowledgementArgs = args;
      return {
        assignment_id: assignmentId,
        attempt_id: attemptId,
        evaluation_status: "queued",
      };
    },
    authorizeProcessorKick: async (args) => {
      assertEquals(args, { actorId });
      return "allowed";
    },
    kickProcessor: () => pendingKick,
    waitUntil: (promise) => {
      background = promise;
    },
    log: () => undefined,
  });

  const response = await handler(
    new Request("https://example.test/evaluate-practice-attempt", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assignment_id: assignmentId,
        queue_name: "caller_queue",
        job_id: "caller-controlled-job",
      }),
    }),
  );

  assertEquals(response.status, 202);
  assertEquals(acknowledgementArgs, {
    authorization,
    assignmentId,
    attemptId: "",
  });
  assert(
    background,
    "Expected the worker kick to be registered with waitUntil.",
  );
  assertEquals(await response.json(), {
    accepted: true,
    assignment_id: assignmentId,
    attempt_id: attemptId,
    status: "queued",
    evaluation_status: "queued",
    evaluated: false,
    processor_kick_status: "scheduled",
  });

  resolveKick();
  await background;
});

Deno.test("terminal evaluation state is acknowledged without a duplicate worker kick", async () => {
  let authorized = false;
  let kicked = false;
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken,
    acknowledgeAttempt: async () => ({
      assignment_id: assignmentId,
      attempt_id: attemptId,
      evaluation_status: "completed",
    }),
    authorizeProcessorKick: async () => {
      authorized = true;
      return "allowed";
    },
    kickProcessor: async () => {
      kicked = true;
    },
    waitUntil: () => undefined,
    log: () => undefined,
  });
  const response = await handler(
    new Request("https://example.test/evaluate-practice-attempt", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ attempt_id: attemptId }),
    }),
  );
  assertEquals(response.status, 202);
  assert(
    !authorized,
    "Completed work must not consume an immediate-kick allowance.",
  );
  assert(!kicked, "Completed work must not schedule duplicate processing.");
  assertEquals((await response.json()).evaluated, true);
});

Deno.test("practice acknowledgement failures never expose raw internal errors", async () => {
  const secretDetail = "postgres://private-connection-string";
  const logEvents: Array<Record<string, unknown>> = [];
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken,
    acknowledgeAttempt: async () => {
      throw secretDetail;
    },
    authorizeProcessorKick: async () => "allowed",
    kickProcessor: async () => undefined,
    waitUntil: () => undefined,
    log: (event) => logEvents.push(event),
  });

  const response = await handler(
    new Request("https://example.test/evaluate-practice-attempt", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ attempt_id: attemptId }),
    }),
  );
  const responseText = await response.text();

  assertEquals(response.status, 503);
  assert(
    !responseText.includes(secretDetail),
    "The response must not include the thrown internal value.",
  );
  assert(
    !JSON.stringify(logEvents).includes(secretDetail),
    "Structured request logs must retain only stable safe codes.",
  );
});

Deno.test("replayed queued evaluations cannot mint unbounded privileged wakeups", async () => {
  let authorizationCalls = 0;
  let processorKicks = 0;
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken,
    acknowledgeAttempt: async () => ({
      assignment_id: assignmentId,
      attempt_id: attemptId,
      evaluation_status: "evaluating",
    }),
    authorizeProcessorKick: async () =>
      authorizationCalls++ < 2 ? "allowed" : "rate_limited",
    kickProcessor: async () => {
      processorKicks += 1;
    },
    waitUntil: () => undefined,
    log: () => undefined,
  });

  const responses = await Promise.all(
    Array.from({ length: 25 }, () =>
      handler(
        new Request("https://example.test/evaluate-practice-attempt", {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ attempt_id: attemptId }),
        }),
      )),
  );
  const bodies = await Promise.all(
    responses.map((response) => response.json()),
  );

  assert(
    responses.every((response) => response.status === 202),
    "Durable evaluation acknowledgements must survive immediate-kick throttling.",
  );
  assertEquals(processorKicks, 2);
  assertEquals(
    bodies.filter((body) => body.processor_kick_status === "scheduled").length,
    2,
  );
  assertEquals(
    bodies.filter((body) => body.processor_kick_status === "rate_limited")
      .length,
    23,
  );
});

Deno.test("a throttled evaluation kick remains an accepted durable job", async () => {
  let kicked = false;
  const handler = createEvaluatePracticeAttemptRequestHandler({
    verifyUserToken,
    acknowledgeAttempt: async () => ({
      assignment_id: assignmentId,
      attempt_id: attemptId,
      evaluation_status: "queued",
    }),
    authorizeProcessorKick: async () => "rate_limited",
    kickProcessor: async () => {
      kicked = true;
    },
    waitUntil: () => undefined,
    log: () => undefined,
  });

  const response = await handler(
    new Request("https://example.test/evaluate-practice-attempt", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ attempt_id: attemptId }),
    }),
  );

  assertEquals(response.status, 202);
  assert(
    !kicked,
    "A rate-limited actor must not reach the service-key worker sink.",
  );
  assertEquals((await response.json()).processor_kick_status, "rate_limited");
});
