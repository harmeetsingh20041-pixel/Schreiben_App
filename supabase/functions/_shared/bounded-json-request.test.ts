import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
  UUID_COMMAND_REQUEST_MAX_BYTES,
} from "./bounded-json-request.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, received ${left}`);
}

async function assertBodyFailure(
  operation: () => Promise<unknown>,
  expectedKind: BoundedJsonRequestError["kind"],
) {
  try {
    await operation();
  } catch (error) {
    assert(
      error instanceof BoundedJsonRequestError,
      "Expected a stable bounded request-body failure.",
    );
    assertEquals(error.kind, expectedKind);
    return;
  }
  throw new Error(`Expected ${expectedKind}, but the request was accepted.`);
}

function readerBackedRequest(args: {
  chunks: Uint8Array[];
  contentLength?: string;
  stallAfterChunks?: boolean;
}) {
  let offset = 0;
  let cancelled = false;
  let readerRequested = false;
  const reader = {
    async read() {
      const value = args.chunks[offset++];
      if (value) return { done: false as const, value };
      if (args.stallAfterChunks) return await new Promise<never>(() => {});
      return { done: true as const };
    },
    cancel() {
      cancelled = true;
      return Promise.resolve();
    },
    releaseLock() {
      // No-op test reader.
    },
  };
  const body = {
    cancel() {
      cancelled = true;
      return Promise.resolve();
    },
    getReader() {
      readerRequested = true;
      return reader;
    },
  };
  const request = {
    bodyUsed: false,
    body,
    headers: new Headers(
      args.contentLength === undefined
        ? undefined
        : { "Content-Length": args.contentLength },
    ),
  } as unknown as Request;

  return {
    request,
    state: () => ({ cancelled, readerRequested }),
  };
}

async function withTestDeadline<T>(operation: Promise<T>, timeoutMs = 500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The bounded-reader test did not settle.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

Deno.test("bounded request reader preserves ordinary valid JSON", async () => {
  const request = new Request("https://example.test/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignment_id: "one" }),
  });

  assertEquals(await readBoundedJsonRequest(request), {
    assignment_id: "one",
  });
});

Deno.test("a valid JSON body exactly at the configured byte cap succeeds", async () => {
  const prefix = '{"padding":"';
  const suffix = '"}';
  const maxBytes = 64;
  const padding = "x".repeat(
    maxBytes - new TextEncoder().encode(prefix + suffix).byteLength,
  );
  const text = prefix + padding + suffix;
  assertEquals(new TextEncoder().encode(text).byteLength, maxBytes);

  const request = new Request("https://example.test/command", {
    method: "POST",
    body: text,
  });
  assertEquals(await readBoundedJsonRequest(request, { maxBytes }), {
    padding,
  });
});

Deno.test("an oversized declared length is rejected before a reader is acquired", async () => {
  const { request, state } = readerBackedRequest({
    chunks: [new TextEncoder().encode("{}")],
    contentLength: String(UUID_COMMAND_REQUEST_MAX_BYTES + 1),
  });

  await assertBodyFailure(
    () => readBoundedJsonRequest(request),
    "body_too_large",
  );
  assertEquals(state(), { cancelled: true, readerRequested: false });
});

Deno.test("a malformed declared length is rejected before a reader is acquired", async () => {
  const { request, state } = readerBackedRequest({
    chunks: [new TextEncoder().encode("{}")],
    contentLength: "4, 4",
  });

  await assertBodyFailure(
    () => readBoundedJsonRequest(request),
    "invalid_body",
  );
  assertEquals(state(), { cancelled: true, readerRequested: false });
});

Deno.test("a standards-valid declared length with leading zeroes remains compatible", async () => {
  const { request } = readerBackedRequest({
    chunks: [new TextEncoder().encode("{}")],
    contentLength: "0002",
  });

  assertEquals(await readBoundedJsonRequest(request), {});
});

Deno.test("a no-length multi-chunk body is cancelled when streamed bytes cross the cap", async () => {
  const { request, state } = readerBackedRequest({
    chunks: [
      new TextEncoder().encode('{"padding":"'),
      new TextEncoder().encode("x".repeat(64)),
      new TextEncoder().encode('"}'),
    ],
  });

  await assertBodyFailure(
    () => readBoundedJsonRequest(request, { maxBytes: 32 }),
    "body_too_large",
  );
  assertEquals(state(), { cancelled: true, readerRequested: true });
});

Deno.test("a sub-cap stream without EOF is cancelled at the total read deadline", async () => {
  const { request, state } = readerBackedRequest({
    chunks: [new TextEncoder().encode("{}")],
    stallAfterChunks: true,
  });

  await assertBodyFailure(
    () =>
      withTestDeadline(
        readBoundedJsonRequest(request, {
          maxBytes: 64,
          readTimeoutMs: 20,
        }),
      ),
    "body_read_timeout",
  );
  assertEquals(state(), { cancelled: true, readerRequested: true });
});

Deno.test("a falsely small declared length cannot bypass streamed byte accounting", async () => {
  const { request } = readerBackedRequest({
    chunks: [new TextEncoder().encode(`{"padding":"${"x".repeat(64)}"}`)],
    contentLength: "1",
  });

  await assertBodyFailure(
    () => readBoundedJsonRequest(request, { maxBytes: 32 }),
    "body_too_large",
  );
});

Deno.test("empty, invalid UTF-8, and malformed JSON bodies fail safely", async () => {
  const bodies = [
    undefined,
    new Uint8Array([0xff]),
    "not-json",
  ];
  for (const body of bodies) {
    const request = new Request("https://example.test/command", {
      method: "POST",
      ...(body === undefined ? {} : { body }),
    });
    await assertBodyFailure(
      () => readBoundedJsonRequest(request),
      "invalid_body",
    );
  }
});
