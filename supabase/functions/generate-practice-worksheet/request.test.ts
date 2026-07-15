import { createRequestPracticeWorksheetHandler } from "./request.ts";
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
const jobId = "11111111-1111-4111-8111-111111111111";
const actorId = "33333333-3333-4333-8333-333333333333";
const token = "header.payload.signature";
const authorization = `Bearer ${token}`;
const verifyUserToken = async () => ({
  status: "verified" as const,
  userId: actorId,
});

function rawRequest(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("https://example.test/generate", {
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

Deno.test(
  "a forged worksheet token is rejected before request acknowledgement",
  async () => {
    let requested = false;
    let authorized = false;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken: async () => ({ status: "invalid" }),
      requestWorksheet: async () => {
        requested = true;
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
      new Request("https://example.test/generate", {
        method: "POST",
        headers: {
          Authorization: "Bearer header.payload.forged",
          "Content-Type": "application/json",
        },
        body: "not-json",
      }),
    );

    assertEquals(response.status, 401);
    assert(!requested, "A forged token must not reach the worksheet RPC.");
    assert(
      !authorized,
      "A forged token must not reach privileged kick authorization.",
    );
  },
);

Deno.test(
  "a worksheet auth outage returns 503 before body parsing or RPC work",
  async () => {
    let requested = false;
    let authorized = false;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken: async () => ({ status: "unavailable" }),
      requestWorksheet: async () => {
        requested = true;
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
      new Request("https://example.test/generate", {
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
    assert(!requested, "Verifier outage reached the worksheet RPC.");
    assert(
      !authorized,
      "Verifier outage reached privileged kick authorization.",
    );
  },
);

Deno.test(
  "an oversized declared worksheet request returns 413 before RPC work",
  async () => {
    let requested = false;
    let authorized = false;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestWorksheet: async () => {
        requested = true;
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
      padding: "x".repeat(UUID_COMMAND_REQUEST_MAX_BYTES),
    });

    const response = await handler(rawRequest(text, {
      "Content-Length": String(new TextEncoder().encode(text).byteLength),
    }));
    assertEquals(response.status, 413);
    assertEquals(await response.json(), {
      error: "Request body is too large.",
    });
    assert(!requested, "Oversized input reached the worksheet RPC.");
    assert(
      !authorized,
      "Oversized input reached privileged kick authorization.",
    );
  },
);

Deno.test(
  "an oversized chunked worksheet request returns 413 before RPC work",
  async () => {
    let requested = false;
    let authorized = false;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestWorksheet: async () => {
        requested = true;
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
      padding: "x".repeat(UUID_COMMAND_REQUEST_MAX_BYTES),
    }));
    assertEquals(req.headers.get("content-length"), null);

    const response = await handler(req);
    assertEquals(response.status, 413);
    assertEquals(await response.json(), {
      error: "Request body is too large.",
    });
    assert(!requested, "Chunked oversized input reached the worksheet RPC.");
    assert(
      !authorized,
      "Chunked oversized input reached privileged kick authorization.",
    );
  },
);

Deno.test(
  "a stalled authenticated worksheet request returns 408 before RPC work",
  async () => {
    let requested = false;
    let authorized = false;
    let kicked = false;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestBodyReadTimeoutMs: 20,
      requestWorksheet: async () => {
        requested = true;
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
      "Timed-out worksheet body was not cancelled.",
    );
    assert(!requested, "Timed-out input reached the worksheet RPC.");
    assert(!authorized, "Timed-out input reached kick authorization.");
    assert(!kicked, "Timed-out input kicked the worksheet processor.");
  },
);

Deno.test(
  "authenticated malformed worksheet JSON preserves the stable 400 error",
  async () => {
    let requested = false;
    let authorized = false;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestWorksheet: async () => {
        requested = true;
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
    assert(!requested, "Malformed JSON reached the worksheet RPC.");
    assert(
      !authorized,
      "Malformed JSON reached privileged kick authorization.",
    );
  },
);

Deno.test(
  "worksheet request returns durable 202 without waiting for provider work",
  async () => {
    let requestArgs: unknown;
    let resolveKick!: () => void;
    const kickPromise = new Promise<void>((resolve) => {
      resolveKick = resolve;
    });
    let background: Promise<unknown> | null = null;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestWorksheet: async (args) => {
        requestArgs = args;
        return {
          assignment_id: assignmentId,
          job_id: jobId,
          generation_status: "queued",
        };
      },
      authorizeProcessorKick: async (args) => {
        assertEquals(args, { actorId });
        return "allowed";
      },
      kickProcessor: () => kickPromise,
      waitUntil: (promise) => {
        background = promise;
      },
      log: () => undefined,
    });

    const response = await handler(
      new Request("https://example.test/generate", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assignment_id: assignmentId,
          queue_name: "attacker_queue",
          job_id: "caller-cannot-control-this",
        }),
      }),
    );

    assertEquals(response.status, 202);
    assertEquals(requestArgs, {
      authorization,
      assignmentId,
    });
    assert(
      background,
      "Expected the processor kick to be registered in waitUntil.",
    );
    assertEquals(await response.json(), {
      assignment_id: assignmentId,
      job_id: jobId,
      generation_status: "queued",
      processor_kick_status: "scheduled",
    });
    resolveKick();
    await background;
  },
);

Deno.test(
  "ready worksheet state returns 202 without an unnecessary kick",
  async () => {
    let authorized = false;
    let kicked = false;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestWorksheet: async () => ({
        assignment_id: assignmentId,
        job_id: null,
        generation_status: "ready",
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
      new Request("https://example.test/generate", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ assignment_id: assignmentId }),
      }),
    );
    assertEquals(response.status, 202);
    assert(
      !authorized,
      "Ready state must not consume an immediate-kick allowance.",
    );
    assert(!kicked, "Ready state must not schedule duplicate processing.");
  },
);

Deno.test(
  "held candidate state does not enqueue duplicate processor work",
  async () => {
    let authorized = false;
    let kicked = false;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestWorksheet: async () => ({
        assignment_id: assignmentId,
        job_id: null,
        generation_status: "needs_review",
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
      new Request("https://example.test/generate", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ assignment_id: assignmentId }),
      }),
    );
    assertEquals(response.status, 202);
    assert(
      !authorized,
      "Held state must not consume an immediate-kick allowance.",
    );
    assert(!kicked, "Held candidates must not start duplicate provider work.");
  },
);

Deno.test(
  "worksheet request failures never expose raw provider or database errors",
  async () => {
    const secretDetail = "DEEPSEEK_API_KEY=must-never-reach-the-student";
    const logEvents: Array<Record<string, unknown>> = [];
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestWorksheet: async () => {
        throw new Error(secretDetail);
      },
      authorizeProcessorKick: async () => "allowed",
      kickProcessor: async () => undefined,
      waitUntil: () => undefined,
      log: (event) => logEvents.push(event),
    });

    const response = await handler(
      new Request("https://example.test/generate", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ assignment_id: assignmentId }),
      }),
    );
    const responseText = await response.text();

    assertEquals(response.status, 503);
    assert(
      !responseText.includes(secretDetail),
      "The response must not include a raw provider or database error.",
    );
    assert(
      !JSON.stringify(logEvents).includes(secretDetail),
      "Structured request logs must retain only stable safe codes.",
    );
  },
);

Deno.test(
  "manual retry exhaustion returns a truthful stable 429 without a fake kick",
  async () => {
    let authorized = false;
    let kicked = false;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestWorksheet: async () => {
        throw {
          code: "PT429",
          message: "worksheet_generation_retry_limit_exceeded",
          details: "private job history",
        };
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

    const response = await handler(
      new Request("https://example.test/generate", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ assignment_id: assignmentId }),
      }),
    );

    assertEquals(response.status, 429);
    assertEquals(await response.json(), {
      error:
        "Automatic worksheet retries are exhausted. Your teacher can review this practice topic while approved material is checked.",
      error_code: "worksheet_generation_retry_limit_exceeded",
    });
    assert(
      !authorized,
      "Retry exhaustion must not authorize a fake processor kick.",
    );
    assert(
      !kicked,
      "Retry exhaustion must not schedule a fake processor kick.",
    );
  },
);

Deno.test(
  "replayed queued worksheet requests cannot mint unbounded privileged wakeups",
  async () => {
    let authorizationCalls = 0;
    let processorKicks = 0;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestWorksheet: async () => ({
        assignment_id: assignmentId,
        job_id: jobId,
        generation_status: "queued",
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
          new Request("https://example.test/generate", {
            method: "POST",
            headers: {
              Authorization: authorization,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ assignment_id: assignmentId }),
          }),
        )),
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );

    assert(
      responses.every((response) => response.status === 202),
      "Durable acknowledgements must remain available while immediate kicks are throttled.",
    );
    assertEquals(processorKicks, 2);
    assertEquals(
      bodies.filter((body) => body.processor_kick_status === "scheduled")
        .length,
      2,
    );
    assertEquals(
      bodies.filter((body) => body.processor_kick_status === "rate_limited")
        .length,
      23,
    );
  },
);

Deno.test(
  "an unavailable best-effort kick leaves the durable worksheet job queued",
  async () => {
    let kicked = false;
    const handler = createRequestPracticeWorksheetHandler({
      verifyUserToken,
      requestWorksheet: async () => ({
        assignment_id: assignmentId,
        job_id: jobId,
        generation_status: "queued",
      }),
      authorizeProcessorKick: async () => "unavailable",
      kickProcessor: async () => {
        kicked = true;
      },
      waitUntil: () => undefined,
      log: () => undefined,
    });

    const response = await handler(
      new Request("https://example.test/generate", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ assignment_id: assignmentId }),
      }),
    );

    assertEquals(response.status, 202);
    assert(
      !kicked,
      "Unavailable authorization must not reach the service-key worker sink.",
    );
    assertEquals((await response.json()).processor_kick_status, "deferred");
  },
);
