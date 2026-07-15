import {
  createWritingKickRelayHandler,
  type WritingKickRelayAuthorization,
} from "./handler.ts";
import type { UserJwtVerificationResult } from "../_shared/user-auth.ts";

const userId = "22222222-2222-4222-8222-222222222222";
const now = Date.parse("2026-07-11T12:00:00.000Z");
const verifiedUser = { status: "verified", userId } as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "Values differ",
) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function encode(value: Record<string, unknown>) {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function gatewayVerifiedToken(overrides: Record<string, unknown> = {}) {
  return `${encode({ alg: "ES256", typ: "JWT" })}.${
    encode({
      sub: userId,
      role: "authenticated",
      exp: Math.floor(now / 1_000) + 300,
      ...overrides,
    })
  }.gateway-verified-signature`;
}

function request(token: string, body = "{}") {
  return new Request("https://example.test/functions/v1/kick-writing-jobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });
}

function handlerFor(args: {
  verify?: (token: string) => Promise<UserJwtVerificationResult>;
  authorization?: WritingKickRelayAuthorization;
  authorize?: (userId: string) => Promise<WritingKickRelayAuthorization>;
  kick?: () => Promise<unknown>;
  waitUntil?: (task: Promise<unknown>) => void;
}) {
  return createWritingKickRelayHandler({
    verifyUserToken: args.verify ?? (async () => verifiedUser),
    authorizeKick: args.authorize ??
      (async () => args.authorization ?? "allowed"),
    kickWorker: args.kick ?? (async () => undefined),
    waitUntil: args.waitUntil ?? (() => undefined),
    createRequestId: () => "relay-request-1",
    now: () => now,
    log: () => undefined,
  });
}

Deno.test("a cryptographically rejected JWT stops before authorization or wake-up", async () => {
  let authorized = false;
  let kicked = false;
  const handler = handlerFor({
    verify: async () => ({ status: "invalid" }),
    authorize: async () => {
      authorized = true;
      return "allowed";
    },
    kick: async () => {
      kicked = true;
    },
  });

  const response = await handler(request(gatewayVerifiedToken()));

  assertEquals(response.status, 401);
  assert(!authorized, "Rejected claims reached kick authorization.");
  assert(!kicked, "Rejected claims woke the internal worker.");
});

Deno.test("invalid arbitrary bearers stop before authorization RPC or worker wake-up", async () => {
  let verified = false;
  let authorized = false;
  let kicked = false;
  const handler = handlerFor({
    verify: async () => {
      verified = true;
      return verifiedUser;
    },
    authorize: async () => {
      authorized = true;
      return "allowed";
    },
    kick: async () => {
      kicked = true;
    },
  });

  const response = await handler(request("not-a-jwt"));

  assertEquals(response.status, 401);
  assert(!verified, "Malformed JWT reached cryptographic verification.");
  assert(!authorized, "Invalid JWT reached the kick authorization RPC.");
  assert(!kicked, "Invalid JWT woke the internal worker.");
});

Deno.test("a verifier outage returns 503 before authorization or wake-up", async () => {
  let authorized = false;
  let kicked = false;
  const handler = handlerFor({
    verify: async () => ({ status: "unavailable" }),
    authorize: async () => {
      authorized = true;
      return "allowed";
    },
    kick: async () => {
      kicked = true;
    },
  });

  const response = await handler(request(gatewayVerifiedToken(), "not-json"));

  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error:
      "Authentication service is temporarily unavailable. Please try again.",
  });
  assert(!authorized, "Verifier outage reached kick authorization.");
  assert(!kicked, "Verifier outage woke the internal worker.");
});

Deno.test("an authenticated kick is rate-limited for the exact gateway user and remains entity-free", async () => {
  let authorizedUserId = "";
  let backgroundTask: Promise<unknown> | null = null;
  let kicked = false;
  const handler = handlerFor({
    authorize: async (receivedUserId) => {
      authorizedUserId = receivedUserId;
      return "allowed";
    },
    kick: async () => {
      kicked = true;
    },
    waitUntil: (task) => {
      backgroundTask = task;
    },
  });

  const response = await handler(request(
    gatewayVerifiedToken(),
    JSON.stringify({ submission_id: "caller-cannot-select-this-job" }),
  ));

  assertEquals(response.status, 202);
  assertEquals(authorizedUserId, userId);
  assert(backgroundTask, "The relay did not register its worker wake-up.");
  await backgroundTask;
  assert(kicked, "The authorized relay did not wake the worker.");
  assertEquals(await response.json(), {
    status: "accepted",
    processor_kick_status: "scheduled",
    request_id: "relay-request-1",
  });
});

Deno.test("rate-limited and inactive callers cannot wake the internal worker", async () => {
  for (
    const [authorization, status] of [
      ["rate_limited", 429],
      ["inactive_user", 403],
    ] as const
  ) {
    let kicked = false;
    const handler = handlerFor({
      authorization,
      kick: async () => {
        kicked = true;
      },
    });

    const response = await handler(request(gatewayVerifiedToken()));
    assertEquals(response.status, status);
    assert(!kicked, `${authorization} caller woke the internal worker.`);
  }
});

Deno.test("a verified caller with no reachable queued writing skips the global worker poll", async () => {
  let kicked = false;
  const handler = handlerFor({
    authorization: "no_pending_work",
    kick: async () => {
      kicked = true;
    },
  });

  const response = await handler(request(gatewayVerifiedToken()));

  assertEquals(response.status, 202);
  assert(!kicked, "An empty authenticated request woke the global worker.");
  assertEquals(await response.json(), {
    status: "accepted",
    processor_kick_status: "not_needed",
    request_id: "relay-request-1",
  });
});

Deno.test("worker wake-up failure does not revoke an already durable submission", async () => {
  let backgroundTask: Promise<unknown> | null = null;
  const handler = handlerFor({
    kick: async () => {
      throw new Error("network unavailable");
    },
    waitUntil: (task) => {
      backgroundTask = task;
    },
  });

  const response = await handler(request(gatewayVerifiedToken()));
  assertEquals(response.status, 202);
  assert(backgroundTask, "Expected the failed wake-up to stay in waitUntil.");
  await backgroundTask;
});
