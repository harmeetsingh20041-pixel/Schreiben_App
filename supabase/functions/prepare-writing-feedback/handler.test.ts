import {
  callRetryWritingEvaluation,
  createPrepareWritingFeedbackHandler,
  type PrepareWritingFeedbackDependencies,
} from "./handler.ts";
import { UUID_COMMAND_REQUEST_MAX_BYTES } from "../_shared/bounded-json-request.ts";

const submissionId = "22222222-2222-4222-8222-222222222222";
const jobId = "11111111-1111-4111-8111-111111111111";
const jwt = "header.payload.signature";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "Values are not equal",
) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

function rpcClient(
  response: { data: unknown; error: { code?: string } | null },
) {
  return {
    schema: (schemaName: string) => ({
      rpc: (functionName: string, args: Record<string, unknown>) => {
        assertEquals(schemaName, "api");
        assertEquals(functionName, "retry_writing_evaluation");
        assertEquals(args, { target_submission_id: submissionId });
        return Promise.resolve(response);
      },
    }),
  } as unknown as ReturnType<
    PrepareWritingFeedbackDependencies["createAuthenticatedClient"]
  >;
}

function dependencies(
  overrides: Partial<PrepareWritingFeedbackDependencies> = {},
) {
  return {
    verifyUserToken: async () => ({
      status: "verified" as const,
      userId: "33333333-3333-4333-8333-333333333333",
    }),
    createAuthenticatedClient: () =>
      rpcClient({
        data: [{
          submission_id: submissionId,
          job_id: jobId,
          evaluation_status: "queued",
          release_status: "held",
          release_at: null,
          job_created: true,
          already_processing: false,
        }],
        error: null,
      }),
    kickWritingProcessor: async () => undefined,
    waitUntil: () => undefined,
    createRequestId: () => "request-1",
    ...overrides,
  } as PrepareWritingFeedbackDependencies;
}

function request(body: unknown = { submission_id: submissionId }) {
  return new Request(
    "https://example.test/functions/v1/prepare-writing-feedback",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function rawRequest(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(
    "https://example.test/functions/v1/prepare-writing-feedback",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body,
    },
  );
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

Deno.test("retry helper calls only the authenticated api RPC", async () => {
  const response = await callRetryWritingEvaluation(
    rpcClient({ data: [], error: null }),
    submissionId,
  );
  assertEquals(response, { data: [], error: null });
});

Deno.test("teacher retry returns durable state and schedules an entity-free kick", async () => {
  let kickedJwt = "";
  let backgroundTask: Promise<unknown> | null = null;
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    kickWritingProcessor: async (jwt) => {
      kickedJwt = jwt;
    },
    waitUntil: (task) => {
      backgroundTask = task;
    },
  }));

  const response = await handler(request());
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(body, {
    submission_id: submissionId,
    job_id: jobId,
    evaluation_status: "queued",
    release_status: "held",
    release_at: null,
    job_created: true,
    already_processing: false,
    status: "queued",
    line_count: 0,
    already_processed: false,
  });
  assert(
    backgroundTask,
    "Expected a best-effort processor kick background task.",
  );
  await backgroundTask;
  assertEquals(kickedJwt, jwt);
});

Deno.test("already-processing RPC state is returned without direct evaluation", async () => {
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    createAuthenticatedClient: () =>
      rpcClient({
        data: [{
          submission_id: submissionId,
          job_id: jobId,
          evaluation_status: "processing",
          release_status: "held",
          release_at: null,
          job_created: false,
          already_processing: true,
        }],
        error: null,
      }),
  }));

  const response = await handler(request());
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(body.evaluation_status, "processing");
  assertEquals(body.already_processing, true);
});

Deno.test("RPC authorization failures expose only a stable safe error", async () => {
  let kicked = false;
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    createAuthenticatedClient: () =>
      rpcClient({
        data: null,
        error: { code: "42501" },
      }),
    kickWritingProcessor: async () => {
      kicked = true;
    },
  }));

  const response = await handler(request());
  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: "Permission denied." });
  assert(!kicked, "Failed retry authorization must not kick the processor.");
});

Deno.test("processor kick failure does not undo a committed durable retry", async () => {
  let backgroundTask: Promise<unknown> | null = null;
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    kickWritingProcessor: async () => {
      throw new Error("raw network detail");
    },
    waitUntil: (task) => {
      backgroundTask = task;
    },
  }));

  const response = await handler(request());
  assertEquals(response.status, 200);
  assert(
    backgroundTask,
    "Expected the failed kick to remain a background task.",
  );
  await backgroundTask;
});

Deno.test("invalid identifiers are rejected before creating an authenticated RPC client", async () => {
  let rpcClientCreated = false;
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    createAuthenticatedClient: () => {
      rpcClientCreated = true;
      throw new Error("must not run");
    },
  }));

  const response = await handler(request({ submission_id: "not-a-uuid" }));
  assertEquals(response.status, 400);
  assert(
    !rpcClientCreated,
    "Invalid input must fail before creating an authenticated RPC client.",
  );
});

Deno.test("an oversized declared retry body returns 413 before database work", async () => {
  let rpcClientCreated = false;
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    createAuthenticatedClient: () => {
      rpcClientCreated = true;
      throw new Error("must not run");
    },
  }));
  const text = JSON.stringify({
    submission_id: submissionId,
    padding: "x".repeat(UUID_COMMAND_REQUEST_MAX_BYTES),
  });
  const response = await handler(rawRequest(text, {
    "Content-Length": String(new TextEncoder().encode(text).byteLength),
  }));

  assertEquals(response.status, 413);
  assertEquals(await response.json(), {
    error: "Request body is too large.",
  });
  assert(!rpcClientCreated, "Oversized input reached the database RPC client.");
});

Deno.test("an oversized chunked retry body returns 413 before database work", async () => {
  let rpcClientCreated = false;
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    createAuthenticatedClient: () => {
      rpcClientCreated = true;
      throw new Error("must not run");
    },
  }));
  const req = chunkedRequest(JSON.stringify({
    submission_id: submissionId,
    padding: "x".repeat(UUID_COMMAND_REQUEST_MAX_BYTES),
  }));
  assertEquals(req.headers.get("content-length"), null);

  const response = await handler(req);
  assertEquals(response.status, 413);
  assertEquals(await response.json(), {
    error: "Request body is too large.",
  });
  assert(!rpcClientCreated, "Chunked oversized input reached the RPC client.");
});

Deno.test("a stalled authenticated retry body returns 408 before database work", async () => {
  let rpcClientCreated = false;
  let kicked = false;
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    requestBodyReadTimeoutMs: 20,
    createAuthenticatedClient: () => {
      rpcClientCreated = true;
      throw new Error("must not run");
    },
    kickWritingProcessor: async () => {
      kicked = true;
    },
  }));
  const stalled = stalledRequest("{}");

  const response = await handler(stalled.request);

  assertEquals(response.status, 408);
  assertEquals(await response.json(), { error: "Request body timed out." });
  assert(stalled.wasCancelled(), "Timed-out retry body was not cancelled.");
  assert(!rpcClientCreated, "Timed-out input reached the database RPC client.");
  assert(!kicked, "Timed-out input kicked the writing processor.");
});

Deno.test("authenticated malformed retry JSON preserves the stable 400 error", async () => {
  let rpcClientCreated = false;
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    createAuthenticatedClient: () => {
      rpcClientCreated = true;
      throw new Error("must not run");
    },
  }));

  const response = await handler(rawRequest("not-json"));
  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "Invalid request body." });
  assert(!rpcClientCreated, "Malformed JSON reached the database RPC client.");
});

Deno.test("a forged JWT is rejected before request parsing or database RPC", async () => {
  let rpcClientCreated = false;
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    verifyUserToken: async () => ({ status: "invalid" }),
    createAuthenticatedClient: () => {
      rpcClientCreated = true;
      throw new Error("must not run");
    },
  }));

  const response = await handler(request());
  assertEquals(response.status, 401);
  assert(!rpcClientCreated, "Forged JWT reached the database RPC client.");
});

Deno.test("an auth verifier outage returns 503 before body parsing or database RPC", async () => {
  let rpcClientCreated = false;
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    verifyUserToken: async () => ({ status: "unavailable" }),
    createAuthenticatedClient: () => {
      rpcClientCreated = true;
      throw new Error("must not run");
    },
  }));

  const response = await handler(
    new Request(
      "https://example.test/functions/v1/prepare-writing-feedback",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: "not-json",
      },
    ),
  );

  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error:
      "Authentication service is temporarily unavailable. Please try again.",
  });
  assert(!rpcClientCreated, "Verifier outage reached the database RPC client.");
});

Deno.test("untyped RPC failures never expose raw thrown strings", async () => {
  const secretDetail = "SUPABASE_SERVICE_ROLE_KEY=must-stay-private";
  const handler = createPrepareWritingFeedbackHandler(dependencies({
    createAuthenticatedClient: () =>
      ({
        schema: () => ({
          rpc: () => Promise.reject(secretDetail),
        }),
      }) as unknown as ReturnType<
        PrepareWritingFeedbackDependencies["createAuthenticatedClient"]
      >,
  }));

  const response = await handler(request());
  const responseText = await response.text();

  assertEquals(response.status, 500);
  assert(
    !responseText.includes(secretDetail),
    "The response must not include an untyped thrown value.",
  );
  assertEquals(JSON.parse(responseText), {
    error: "Feedback could not be queued. Please try again later.",
  });
});
