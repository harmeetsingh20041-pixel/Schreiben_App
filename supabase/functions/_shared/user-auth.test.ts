import {
  extractBearerToken,
  type VerifiedJwtClaims,
  verifiedUserIdFromClaims,
  verifySupabaseUserJwt,
} from "./user-auth.ts";

const now = Date.parse("2026-07-11T12:00:00.000Z");
const userId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const supabaseUrl = "https://abcdefghijklmnopqrst.supabase.co";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function validClaims(overrides: Partial<VerifiedJwtClaims> = {}) {
  return {
    iss: `${supabaseUrl}/auth/v1`,
    sub: userId,
    aud: "authenticated",
    exp: Math.floor(now / 1_000) + 300,
    iat: Math.floor(now / 1_000) - 30,
    role: "authenticated",
    aal: "aal1",
    session_id: sessionId,
    is_anonymous: false,
    ...overrides,
  };
}

Deno.test("bearer pre-parser rejects malformed and oversized tokens before verification", () => {
  assertEquals(extractBearerToken(null), null);
  assertEquals(extractBearerToken("Bearer arbitrary"), null);
  assertEquals(extractBearerToken("Bearer a.b"), null);
  assertEquals(extractBearerToken("Bearer a.b.c extra"), null);
  assertEquals(extractBearerToken(`Bearer ${"a".repeat(8_193)}.b.c`), null);
  assertEquals(
    extractBearerToken("Bearer header.payload.signature"),
    "header.payload.signature",
  );
});

Deno.test("verified claims are bound to the exact project, audience, session, and user role", () => {
  assertEquals(
    verifiedUserIdFromClaims(validClaims(), supabaseUrl, now),
    userId,
  );
  const { is_anonymous: _omitted, ...missingAnonymousClaim } = validClaims();
  for (
    const claims of [
      validClaims({ iss: "https://attacker.invalid/auth/v1" }),
      validClaims({ aud: "anon" }),
      validClaims({ role: "service_role" }),
      validClaims({ is_anonymous: true }),
      validClaims({ is_anonymous: "false" }),
      missingAnonymousClaim,
      validClaims({ session_id: "not-a-uuid" }),
      validClaims({ exp: Math.floor(now / 1_000) }),
      validClaims({ iat: Math.floor(now / 1_000) + 120 }),
      validClaims({ nbf: Math.floor(now / 1_000) + 120 }),
    ]
  ) {
    assertEquals(verifiedUserIdFromClaims(claims, supabaseUrl, now), null);
  }
});

Deno.test("issuer validation permits HTTPS and HTTP loopback only", () => {
  for (
    const localUrl of [
      "http://127.0.0.1:54321",
      "http://localhost:54321",
      "http://[::1]:54321",
    ]
  ) {
    assertEquals(
      verifiedUserIdFromClaims(
        validClaims({ iss: `${localUrl}/auth/v1` }),
        localUrl,
        now,
      ),
      userId,
    );
  }
  for (const unsafeUrl of ["http://example.test", "ftp://127.0.0.1"]) {
    assertEquals(
      verifiedUserIdFromClaims(
        validClaims({ iss: `${unsafeUrl}/auth/v1` }),
        unsafeUrl,
        now,
      ),
      null,
    );
  }
});

Deno.test("only claims returned by successful cryptographic verification are trusted", async () => {
  let calls = 0;
  const verified = await verifySupabaseUserJwt({
    token: "header.payload.signature",
    supabaseUrl,
    nowMs: now,
    getClaims: async () => {
      calls += 1;
      return { data: { claims: validClaims() }, error: null };
    },
  });
  assertEquals(verified, { status: "verified", userId });
  assertEquals(calls, 1);

  const forged = await verifySupabaseUserJwt({
    token: "header.payload.forged",
    supabaseUrl,
    nowMs: now,
    getClaims: async () => ({
      data: null,
      error: {
        name: "AuthInvalidJwtError",
        status: 400,
        code: "invalid_jwt",
      },
    }),
  });
  assertEquals(forged, { status: "invalid" });

  const rejectedForged = await verifySupabaseUserJwt({
    token: "header.payload.forged",
    supabaseUrl,
    nowMs: now,
    getClaims: () =>
      Promise.reject({
        name: "AuthInvalidJwtError",
        status: 400,
        code: "invalid_jwt",
      }),
  });
  assertEquals(rejectedForged, { status: "invalid" });

  const missing = await verifySupabaseUserJwt({
    token: "header.payload.signature",
    supabaseUrl,
    nowMs: now,
    getClaims: async () => ({ data: null, error: null }),
  });
  assertEquals(missing, { status: "invalid" });
});

Deno.test("claim-service outages and timeouts remain distinguishable from invalid JWTs", async () => {
  const retryableFailure = await verifySupabaseUserJwt({
    token: "header.payload.signature",
    supabaseUrl,
    nowMs: now,
    getClaims: async () => ({
      data: null,
      error: { name: "AuthRetryableFetchError", status: 503 },
    }),
  });
  assertEquals(retryableFailure, { status: "unavailable" });

  const unavailable = await verifySupabaseUserJwt({
    token: "header.payload.signature",
    supabaseUrl,
    nowMs: now,
    getClaims: async () => {
      throw new Error("JWKS unavailable");
    },
  });
  assertEquals(unavailable, { status: "unavailable" });

  const timedOut = await verifySupabaseUserJwt({
    token: "header.payload.signature",
    supabaseUrl,
    nowMs: now,
    timeoutMs: 5,
    getClaims: () => new Promise(() => undefined),
  });
  assertEquals(timedOut, { status: "unavailable" });
});
