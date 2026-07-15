import { createClient } from "npm:@supabase/supabase-js@2.110.0";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jwtPartPattern = /^[A-Za-z0-9_-]+$/;
const maxJwtLength = 8_192;
const defaultVerificationTimeoutMs = 3_000;

export const authenticationUnavailableMessage =
  "Authentication service is temporarily unavailable. Please try again.";

export type VerifiedJwtClaims = {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  role?: unknown;
  aal?: unknown;
  session_id?: unknown;
  is_anonymous?: unknown;
};

export type ClaimsVerifier = (token: string) => Promise<{
  data: { claims: VerifiedJwtClaims } | null;
  error: unknown;
}>;

export type UserJwtVerificationResult =
  | { status: "verified"; userId: string }
  | { status: "invalid" }
  | { status: "unavailable" };

export function extractBearerToken(authorization: string | null) {
  if (!authorization || authorization.length > maxJwtLength + 16) return null;
  const match = authorization.trim().match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return null;

  const token = match[1];
  const parts = token.split(".");
  if (
    token.length > maxJwtLength || parts.length !== 3 ||
    parts.some((part) => !part || !jwtPartPattern.test(part))
  ) {
    return null;
  }
  return token;
}

function expectedIssuer(supabaseUrl: string) {
  try {
    const parsed = new URL(supabaseUrl);
    const loopbackHostname = parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopbackHostname)
    ) {
      return null;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") + "/auth/v1";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function verifiedUserIdFromClaims(
  claims: VerifiedJwtClaims | null | undefined,
  supabaseUrl: string,
  nowMs = Date.now(),
) {
  if (!claims) return null;
  const issuer = expectedIssuer(supabaseUrl);
  const nowSeconds = Math.floor(nowMs / 1_000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (
    !issuer || claims.iss !== issuer || claims.role !== "authenticated" ||
    claims.is_anonymous !== false ||
    !audience.includes("authenticated") ||
    typeof claims.sub !== "string" || !uuidPattern.test(claims.sub) ||
    typeof claims.session_id !== "string" ||
    !uuidPattern.test(claims.session_id) ||
    !["aal1", "aal2"].includes(String(claims.aal ?? "")) ||
    typeof claims.exp !== "number" || !Number.isFinite(claims.exp) ||
    claims.exp <= nowSeconds ||
    typeof claims.iat !== "number" || !Number.isFinite(claims.iat) ||
    claims.iat <= 0 || claims.iat > nowSeconds + 60 ||
    (claims.nbf !== undefined &&
      (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) ||
        claims.nbf > nowSeconds + 60))
  ) {
    return null;
  }

  return claims.sub;
}

function invalidVerificationError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
  };
  const name = typeof record.name === "string" ? record.name : "";
  const code = typeof record.code === "string" ? record.code : "";
  const status = typeof record.status === "number" ? record.status : 0;

  return name === "AuthInvalidJwtError" ||
    name === "AuthSessionMissingError" ||
    ["invalid_jwt", "bad_jwt", "session_not_found", "user_not_found"].includes(
      code,
    ) ||
    status === 400 || status === 401 || status === 403;
}

export async function verifySupabaseUserJwt(args: {
  token: string;
  supabaseUrl: string;
  getClaims: ClaimsVerifier;
  nowMs?: number;
  timeoutMs?: number;
}): Promise<UserJwtVerificationResult> {
  const requestedTimeout = args.timeoutMs ?? defaultVerificationTimeoutMs;
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout
    : defaultVerificationTimeoutMs;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const claimsTask = Promise.resolve().then(() => args.getClaims(args.token))
    .then(
      (response) => ({ kind: "response", response } as const),
      (error) => ({ kind: "failure", error } as const),
    );
  const timeoutTask = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });

  try {
    const outcome = await Promise.race([claimsTask, timeoutTask]);
    if (outcome.kind === "timeout") return { status: "unavailable" };
    if (outcome.kind === "failure") {
      return {
        status: invalidVerificationError(outcome.error)
          ? "invalid"
          : "unavailable",
      };
    }

    const { data, error } = outcome.response;
    if (error) {
      return {
        status: invalidVerificationError(error) ? "invalid" : "unavailable",
      };
    }
    if (!data) return { status: "invalid" };

    const userId = verifiedUserIdFromClaims(
      data.claims,
      args.supabaseUrl,
      args.nowMs,
    );
    return userId ? { status: "verified", userId } : { status: "invalid" };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function publishableKey() {
  const direct = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY");
  if (direct) return direct;

  const configured = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed).find(Boolean);
      if (first) return first;
    } catch {
      // Fail closed during function initialization; deployment preflight must
      // reject malformed key configuration before this code reaches traffic.
    }
  }
  throw new Error("Supabase publishable key is not configured.");
}

export function createSupabaseUserJwtVerifier() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) throw new Error("SUPABASE_URL is not configured.");

  const client = createClient(supabaseUrl, publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return (token: string) =>
    verifySupabaseUserJwt({
      token,
      supabaseUrl,
      getClaims: (jwt) => client.auth.getClaims(jwt),
    });
}
