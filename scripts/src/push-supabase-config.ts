import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MANAGEMENT_API = "https://api.supabase.com";
const PROJECT_REF_PATTERN = /^[a-z]{20}$/;
const REQUIRED_AUTH_JWT_EXPIRY_SECONDS = 600;
const REQUIRED_AUTH_MINIMUM_PASSWORD_LENGTH = 8;
const REQUIRED_AUTH_TOTP_ENROLLMENT_ENABLED = true;
const REQUIRED_AUTH_TOTP_VERIFICATION_ENABLED = true;

export type RemoteConfigEnvironment = "staging" | "production";

export type ConfigPushPlanInput = {
  environment: string;
  targetProjectRef: string;
  linkedProjectRef: string;
  stagingProjectRef?: string;
  productionProjectRef?: string;
  baseConfigSource: string;
  stagingSiteUrl?: string;
  stagingRedirectUrls?: string[];
  productionSiteUrl?: string;
  productionRedirectUrls?: string[];
};

export type ConfigPushPlan = {
  environment: RemoteConfigEnvironment;
  projectRef: string;
  configSource: string;
  authPlanSha256: string;
  authSiteUrl: string;
  authRedirectUrls: string[];
  authJwtExpirySeconds: number;
  authMinimumPasswordLength: number;
  authTotpEnrollmentEnabled: true;
  authTotpVerificationEnabled: true;
};

export type AuthConfigExecutionResult = {
  outcome: "already-current" | "updated";
  verified: true;
};

type AuthManagementConfig = Record<string, unknown>;
type ParsedAuthManagementConfig = {
  siteUrl: string | null;
  redirectAllowList: string | null;
  jwtExpirySeconds: number | null;
  minimumPasswordLength: number | null;
  totpEnrollmentEnabled: boolean | null;
  totpVerificationEnabled: boolean | null;
};

type AuthPlanFields = Pick<
  ConfigPushPlan,
  | "environment"
  | "projectRef"
  | "authSiteUrl"
  | "authRedirectUrls"
  | "authJwtExpirySeconds"
  | "authMinimumPasswordLength"
  | "authTotpEnrollmentEnabled"
  | "authTotpVerificationEnabled"
>;

function authManagementPatch(plan: AuthPlanFields) {
  return {
    site_url: plan.authSiteUrl,
    uri_allow_list: plan.authRedirectUrls.join(","),
    jwt_exp: plan.authJwtExpirySeconds,
    password_min_length: plan.authMinimumPasswordLength,
    mfa_totp_enroll_enabled: plan.authTotpEnrollmentEnabled,
    mfa_totp_verify_enabled: plan.authTotpVerificationEnabled,
  } as const;
}

function authPlanSha256(plan: AuthPlanFields) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        environment: plan.environment,
        project_ref: plan.projectRef,
        ...authManagementPatch(plan),
      }),
    )
    .digest("hex");
}

function projectRef(value: string | undefined, label: string) {
  const normalized = value?.trim() ?? "";
  if (!PROJECT_REF_PATTERN.test(normalized)) {
    throw new Error(
      `${label} must be an exact 20-letter lowercase Supabase project ref`,
    );
  }
  return normalized;
}

function authSectionLines(source: string) {
  const lines = source.split(/\r?\n/);
  let inAuth = false;
  let authSections = 0;
  const indexes: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index]!.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (section) {
      inAuth = section[1] === "auth";
      if (inAuth) authSections += 1;
      continue;
    }
    if (inAuth) indexes.push(index);
  }

  if (authSections !== 1) {
    throw new Error("config must contain exactly one [auth] section");
  }
  return { lines, indexes };
}

function mfaTotpSectionLines(source: string) {
  const lines = source.split(/\r?\n/);
  let inSection = false;
  let sectionCount = 0;
  const indexes: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index]!.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (section) {
      inSection = section[1] === "auth.mfa.totp";
      if (inSection) sectionCount += 1;
      continue;
    }
    if (inSection) indexes.push(index);
  }

  if (sectionCount !== 1) {
    throw new Error("config must contain exactly one [auth.mfa.totp] section");
  }
  return { lines, indexes };
}

function parseMfaTotpConfig(source: string) {
  const { lines, indexes } = mfaTotpSectionLines(source);
  let enrollEnabled: boolean | undefined;
  let verifyEnabled: boolean | undefined;
  let enrollEnabledCount = 0;
  let verifyEnabledCount = 0;

  for (const index of indexes) {
    const line = lines[index]!;
    if (/^\s*enroll_enabled\s*=/.test(line)) {
      enrollEnabledCount += 1;
      const match = line.match(
        /^\s*enroll_enabled\s*=\s*(true|false)\s*(?:#.*)?$/,
      );
      if (!match) {
        throw new Error("auth.mfa.totp.enroll_enabled must be one boolean");
      }
      enrollEnabled = match[1] === "true";
    }
    if (/^\s*verify_enabled\s*=/.test(line)) {
      verifyEnabledCount += 1;
      const match = line.match(
        /^\s*verify_enabled\s*=\s*(true|false)\s*(?:#.*)?$/,
      );
      if (!match) {
        throw new Error("auth.mfa.totp.verify_enabled must be one boolean");
      }
      verifyEnabled = match[1] === "true";
    }
  }

  if (enrollEnabledCount !== 1 || enrollEnabled === undefined) {
    throw new Error(
      "config must define auth.mfa.totp.enroll_enabled exactly once",
    );
  }
  if (verifyEnabledCount !== 1 || verifyEnabled === undefined) {
    throw new Error(
      "config must define auth.mfa.totp.verify_enabled exactly once",
    );
  }
  if (enrollEnabled !== REQUIRED_AUTH_TOTP_ENROLLMENT_ENABLED) {
    throw new Error("auth.mfa.totp.enroll_enabled must be true");
  }
  if (verifyEnabled !== REQUIRED_AUTH_TOTP_VERIFICATION_ENABLED) {
    throw new Error("auth.mfa.totp.verify_enabled must be true");
  }

  return {
    enrollEnabled: true as const,
    verifyEnabled: true as const,
  };
}

function parseAuthConfig(source: string) {
  const { lines, indexes } = authSectionLines(source);
  let siteUrl: string | undefined;
  let redirectUrls: string[] | undefined;
  let jwtExpirySeconds: number | undefined;
  let minimumPasswordLength: number | undefined;
  let siteUrlCount = 0;
  let redirectUrlsCount = 0;
  let jwtExpiryCount = 0;
  let minimumPasswordLengthCount = 0;

  for (const index of indexes) {
    const line = lines[index]!;
    if (/^\s*site_url\s*=/.test(line)) {
      siteUrlCount += 1;
      const match = line.match(
        /^\s*site_url\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/,
      );
      if (!match) {
        throw new Error(
          "auth.site_url must be one JSON-compatible TOML string",
        );
      }
      siteUrl = JSON.parse(match[1]!) as string;
    }
    if (/^\s*additional_redirect_urls\s*=/.test(line)) {
      redirectUrlsCount += 1;
      const match = line.match(
        /^\s*additional_redirect_urls\s*=\s*(\[(?:[^\]"\\]|"(?:[^"\\]|\\.)*"|\\.)*\])\s*(?:#.*)?$/,
      );
      if (!match) {
        throw new Error(
          "auth.additional_redirect_urls must be one JSON-compatible TOML string array",
        );
      }
      const parsed = JSON.parse(match[1]!) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.some((value) => typeof value !== "string")
      ) {
        throw new Error(
          "auth.additional_redirect_urls must contain only strings",
        );
      }
      redirectUrls = parsed;
    }
    if (/^\s*jwt_expiry\s*=/.test(line)) {
      jwtExpiryCount += 1;
      const match = line.match(/^\s*jwt_expiry\s*=\s*([0-9]+)\s*(?:#.*)?$/);
      if (!match) {
        throw new Error("auth.jwt_expiry must be one integer value");
      }
      jwtExpirySeconds = Number(match[1]);
    }
    if (/^\s*minimum_password_length\s*=/.test(line)) {
      minimumPasswordLengthCount += 1;
      const match = line.match(
        /^\s*minimum_password_length\s*=\s*([0-9]+)\s*(?:#.*)?$/,
      );
      if (!match) {
        throw new Error(
          "auth.minimum_password_length must be one integer value",
        );
      }
      minimumPasswordLength = Number(match[1]);
    }
  }

  if (siteUrlCount !== 1 || siteUrl === undefined) {
    throw new Error("config must define auth.site_url exactly once");
  }
  if (redirectUrlsCount !== 1 || redirectUrls === undefined) {
    throw new Error(
      "config must define auth.additional_redirect_urls exactly once",
    );
  }
  if (jwtExpiryCount !== 1 || jwtExpirySeconds === undefined) {
    throw new Error("config must define auth.jwt_expiry exactly once");
  }
  if (jwtExpirySeconds !== REQUIRED_AUTH_JWT_EXPIRY_SECONDS) {
    throw new Error(
      `auth.jwt_expiry must be exactly ${REQUIRED_AUTH_JWT_EXPIRY_SECONDS} seconds`,
    );
  }
  if (minimumPasswordLengthCount !== 1 || minimumPasswordLength === undefined) {
    throw new Error(
      "config must define auth.minimum_password_length exactly once",
    );
  }
  if (minimumPasswordLength !== REQUIRED_AUTH_MINIMUM_PASSWORD_LENGTH) {
    throw new Error(
      `auth.minimum_password_length must be exactly ${REQUIRED_AUTH_MINIMUM_PASSWORD_LENGTH}`,
    );
  }
  return {
    siteUrl,
    redirectUrls,
    jwtExpirySeconds,
    minimumPasswordLength,
    ...parseMfaTotpConfig(source),
  };
}

function replaceRemoteAuthConfig(
  source: string,
  siteUrl: string,
  redirectUrls: string[],
) {
  const { lines, indexes } = authSectionLines(source);
  let siteUrlCount = 0;
  let redirectUrlsCount = 0;

  for (const index of indexes) {
    const line = lines[index]!;
    if (/^\s*site_url\s*=/.test(line)) {
      if (!/^\s*site_url\s*=\s*"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/.test(line)) {
        throw new Error("refusing to replace a non-scalar auth.site_url");
      }
      siteUrlCount += 1;
      lines[index] = `site_url = ${JSON.stringify(siteUrl)}`;
    }
    if (/^\s*additional_redirect_urls\s*=/.test(line)) {
      if (
        !/^\s*additional_redirect_urls\s*=\s*\[[^\]\r\n]*\]\s*(?:#.*)?$/.test(
          line,
        )
      ) {
        throw new Error(
          "refusing to replace a multiline or malformed auth.additional_redirect_urls",
        );
      }
      redirectUrlsCount += 1;
      lines[index] = `additional_redirect_urls = [${redirectUrls
        .map((value) => JSON.stringify(value))
        .join(", ")}]`;
    }
  }

  if (siteUrlCount !== 1 || redirectUrlsCount !== 1) {
    throw new Error(
      "remote rendering requires exactly one auth.site_url and auth.additional_redirect_urls",
    );
  }
  return lines.join("\n");
}

function remoteHttpsUrl(
  value: string,
  label: string,
  requireRootPath: boolean,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");

  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    isIP(hostname) !== 0
  ) {
    throw new Error(`${label} must use a public hostname`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} cannot contain credentials, a query, or a hash`);
  }
  if (value.includes("*")) {
    throw new Error(`${label} cannot contain a wildcard`);
  }
  if (value.includes(",")) {
    throw new Error(`${label} cannot contain a comma`);
  }
  if (requireRootPath && url.pathname !== "/") {
    throw new Error(`${label} must use its HTTPS origin without a path`);
  }
  return url;
}

function validateProductionAuth(siteUrl: string, redirectUrls: string[]) {
  const site = remoteHttpsUrl(siteUrl, "production site URL", true);
  const requiredRedirects = new Set([
    new URL("/auth/confirm", site).href,
    new URL("/auth/reset-password", site).href,
  ]);
  const unique = new Set<string>();
  for (const value of redirectUrls) {
    const redirect = remoteHttpsUrl(value, "production redirect URL", false);
    if (redirect.origin !== site.origin) {
      throw new Error("production redirect URLs must use the site URL origin");
    }
    if (unique.has(redirect.href)) {
      throw new Error("production redirect URLs must be unique");
    }
    unique.add(redirect.href);
  }
  for (const required of requiredRedirects) {
    if (!unique.has(required)) {
      throw new Error(
        "production requires the exact /auth/confirm and /auth/reset-password redirect URLs",
      );
    }
  }
  return {
    siteUrl: site.href,
    redirectUrls: [...unique].sort(),
  };
}

function validateStagingAuth(siteUrl: string, redirectUrls: string[]) {
  const site = remoteHttpsUrl(siteUrl, "staging site URL", true);
  const requiredRedirects = new Set([
    new URL("/auth/confirm", site).href,
    new URL("/auth/reset-password", site).href,
  ]);
  if (redirectUrls.length !== requiredRedirects.size) {
    throw new Error(
      "staging requires exactly the confirmation and password-reset Auth redirect URLs",
    );
  }

  const unique = new Set<string>();
  for (const value of redirectUrls) {
    const redirect = remoteHttpsUrl(value, "staging redirect URL", false);
    if (redirect.origin !== site.origin) {
      throw new Error("staging redirect URLs must use the site URL origin");
    }
    if (!requiredRedirects.has(redirect.href)) {
      throw new Error(
        "staging redirect URLs must be the exact /auth/confirm and /auth/reset-password paths",
      );
    }
    if (unique.has(redirect.href)) {
      throw new Error("staging redirect URLs must be unique");
    }
    unique.add(redirect.href);
  }

  if (unique.size !== requiredRedirects.size) {
    throw new Error(
      "staging requires both the confirmation and password-reset Auth redirect URLs",
    );
  }
  return {
    siteUrl: site.href,
    redirectUrls: [...unique].sort(),
  };
}

export function createConfigPushPlan(
  input: ConfigPushPlanInput,
): ConfigPushPlan {
  if (input.environment === "local") {
    throw new Error(
      "local configuration is never pushed; use the local Supabase stack instead",
    );
  }
  if (input.environment !== "staging" && input.environment !== "production") {
    throw new Error("environment must be exactly staging or production");
  }

  const target = projectRef(input.targetProjectRef, "target project ref");
  const linked = projectRef(input.linkedProjectRef, "linked project ref");
  const staging = projectRef(input.stagingProjectRef, "STAGING_PROJECT_REF");
  const production = input.productionProjectRef
    ? projectRef(input.productionProjectRef, "PRODUCTION_PROJECT_REF")
    : undefined;

  if (production && production === staging) {
    throw new Error("staging and production project refs must be different");
  }
  if (linked !== target) {
    throw new Error(
      "linked project ref does not match the explicit target; refusing remote Auth configuration",
    );
  }

  if (input.environment === "staging") {
    if (target !== staging) {
      throw new Error("staging config can only target STAGING_PROJECT_REF");
    }
    if (production && target === production) {
      throw new Error("staging config cannot target PRODUCTION_PROJECT_REF");
    }
    if (
      input.productionSiteUrl !== undefined ||
      input.productionRedirectUrls !== undefined
    ) {
      throw new Error("production Auth overrides are not accepted for staging");
    }
    const validatedStagingAuth = validateStagingAuth(
      input.stagingSiteUrl ?? "",
      input.stagingRedirectUrls ?? [],
    );
    const configSource = replaceRemoteAuthConfig(
      input.baseConfigSource,
      validatedStagingAuth.siteUrl,
      validatedStagingAuth.redirectUrls,
    );
    const auth = parseAuthConfig(configSource);
    if (
      auth.siteUrl !== validatedStagingAuth.siteUrl ||
      JSON.stringify(auth.redirectUrls) !==
        JSON.stringify(validatedStagingAuth.redirectUrls)
    ) {
      throw new Error("rendered staging Auth config failed exact verification");
    }
    if (
      /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)/i.test(
        configSource,
      )
    ) {
      throw new Error("rendered staging config contains a loopback URL");
    }
    const plan = {
      environment: "staging",
      projectRef: target,
      configSource,
      authSiteUrl: auth.siteUrl,
      authRedirectUrls: auth.redirectUrls,
      authJwtExpirySeconds: auth.jwtExpirySeconds,
      authMinimumPasswordLength: auth.minimumPasswordLength,
      authTotpEnrollmentEnabled: auth.enrollEnabled,
      authTotpVerificationEnabled: auth.verifyEnabled,
    } as const;
    return { ...plan, authPlanSha256: authPlanSha256(plan) };
  }

  if (!production) {
    throw new Error("PRODUCTION_PROJECT_REF is required for production");
  }
  if (target !== production) {
    throw new Error("production config can only target PRODUCTION_PROJECT_REF");
  }
  if (target === staging) {
    throw new Error("production config cannot target STAGING_PROJECT_REF");
  }
  if (
    input.stagingSiteUrl !== undefined ||
    input.stagingRedirectUrls !== undefined
  ) {
    throw new Error("staging Auth overrides are not accepted for production");
  }

  const auth = validateProductionAuth(
    input.productionSiteUrl ?? "",
    input.productionRedirectUrls ?? [],
  );
  const configSource = replaceRemoteAuthConfig(
    input.baseConfigSource,
    auth.siteUrl,
    auth.redirectUrls,
  );
  const renderedAuth = parseAuthConfig(configSource);
  if (
    renderedAuth.siteUrl !== auth.siteUrl ||
    JSON.stringify(renderedAuth.redirectUrls) !==
      JSON.stringify(auth.redirectUrls)
  ) {
    throw new Error(
      "rendered production Auth config failed exact verification",
    );
  }
  if (
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)/i.test(
      configSource,
    )
  ) {
    throw new Error("rendered production config contains a loopback URL");
  }

  const plan = {
    environment: "production",
    projectRef: target,
    configSource,
    authSiteUrl: auth.siteUrl,
    authRedirectUrls: auth.redirectUrls,
    authJwtExpirySeconds: renderedAuth.jwtExpirySeconds,
    authMinimumPasswordLength: renderedAuth.minimumPasswordLength,
    authTotpEnrollmentEnabled: renderedAuth.enrollEnabled,
    authTotpVerificationEnabled: renderedAuth.verifyEnabled,
  } as const;
  return { ...plan, authPlanSha256: authPlanSha256(plan) };
}

function parseAuthManagementConfig(
  value: AuthManagementConfig,
): ParsedAuthManagementConfig {
  const requiredKeys = [
    "site_url",
    "uri_allow_list",
    "jwt_exp",
    "password_min_length",
    "mfa_totp_enroll_enabled",
    "mfa_totp_verify_enabled",
  ] as const;
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(
        "Supabase Auth configuration response is missing required fields",
      );
    }
  }
  if (value.site_url !== null && typeof value.site_url !== "string") {
    throw new Error("Supabase Auth configuration response has invalid fields");
  }
  if (
    value.uri_allow_list !== null &&
    typeof value.uri_allow_list !== "string"
  ) {
    throw new Error("Supabase Auth configuration response has invalid fields");
  }
  if (
    value.jwt_exp !== null &&
    (typeof value.jwt_exp !== "number" || !Number.isSafeInteger(value.jwt_exp))
  ) {
    throw new Error("Supabase Auth configuration response has invalid fields");
  }
  if (
    value.password_min_length !== null &&
    (typeof value.password_min_length !== "number" ||
      !Number.isSafeInteger(value.password_min_length))
  ) {
    throw new Error("Supabase Auth configuration response has invalid fields");
  }
  if (
    value.mfa_totp_enroll_enabled !== null &&
    typeof value.mfa_totp_enroll_enabled !== "boolean"
  ) {
    throw new Error("Supabase Auth configuration response has invalid fields");
  }
  if (
    value.mfa_totp_verify_enabled !== null &&
    typeof value.mfa_totp_verify_enabled !== "boolean"
  ) {
    throw new Error("Supabase Auth configuration response has invalid fields");
  }
  return {
    siteUrl: value.site_url,
    redirectAllowList: value.uri_allow_list,
    jwtExpirySeconds: value.jwt_exp,
    minimumPasswordLength: value.password_min_length,
    totpEnrollmentEnabled: value.mfa_totp_enroll_enabled,
    totpVerificationEnabled: value.mfa_totp_verify_enabled,
  };
}

function authManagementConfigMatches(
  value: ParsedAuthManagementConfig,
  plan: ConfigPushPlan,
) {
  return (
    value.siteUrl === plan.authSiteUrl &&
    value.redirectAllowList === plan.authRedirectUrls.join(",") &&
    value.jwtExpirySeconds === plan.authJwtExpirySeconds &&
    value.minimumPasswordLength === plan.authMinimumPasswordLength &&
    value.totpEnrollmentEnabled === plan.authTotpEnrollmentEnabled &&
    value.totpVerificationEnabled === plan.authTotpVerificationEnabled
  );
}

function usableManagementToken(value: string | undefined) {
  const token = value?.trim() ?? "";
  if (token.length < 20 || /\s/.test(token)) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN must be supplied securely for remote Auth configuration",
    );
  }
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function fetchAuthManagementConfig(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Supabase Auth configuration request failed");
  }
  if (!response.ok) {
    throw new Error(
      `Supabase Auth configuration request failed with HTTP ${response.status}`,
    );
  }
  let value: unknown;
  try {
    value = (await response.json()) as unknown;
  } catch {
    throw new Error("Supabase Auth configuration returned invalid JSON");
  }
  if (!isRecord(value)) {
    throw new Error("Supabase Auth configuration returned an invalid object");
  }
  return value;
}

function assertExecutablePlan(plan: ConfigPushPlan) {
  projectRef(plan.projectRef, "plan project ref");
  if (plan.environment !== "staging" && plan.environment !== "production") {
    throw new Error("remote Auth plan environment is invalid");
  }
  const validated =
    plan.environment === "staging"
      ? validateStagingAuth(plan.authSiteUrl, plan.authRedirectUrls)
      : validateProductionAuth(plan.authSiteUrl, plan.authRedirectUrls);
  if (
    validated.siteUrl !== plan.authSiteUrl ||
    JSON.stringify(validated.redirectUrls) !==
      JSON.stringify(plan.authRedirectUrls)
  ) {
    throw new Error("remote Auth plan URLs are not canonical");
  }
  if (
    plan.authJwtExpirySeconds !== REQUIRED_AUTH_JWT_EXPIRY_SECONDS ||
    plan.authMinimumPasswordLength !== REQUIRED_AUTH_MINIMUM_PASSWORD_LENGTH ||
    plan.authTotpEnrollmentEnabled !== REQUIRED_AUTH_TOTP_ENROLLMENT_ENABLED ||
    plan.authTotpVerificationEnabled !== REQUIRED_AUTH_TOTP_VERIFICATION_ENABLED
  ) {
    throw new Error("remote Auth plan security settings are not approved");
  }
  if (plan.authPlanSha256 !== authPlanSha256(plan)) {
    throw new Error("remote Auth plan identity hash is invalid");
  }
}

export async function executeRemoteAuthConfig(
  plan: ConfigPushPlan,
  options: {
    accessToken?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<AuthConfigExecutionResult> {
  assertExecutablePlan(plan);
  const token = usableManagementToken(options.accessToken);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${MANAGEMENT_API}/v1/projects/${plan.projectRef}/config/auth`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };

  const current = parseAuthManagementConfig(
    await fetchAuthManagementConfig(fetchImpl, url, { headers }),
  );
  if (authManagementConfigMatches(current, plan)) {
    return { outcome: "already-current", verified: true };
  }

  const patched = parseAuthManagementConfig(
    await fetchAuthManagementConfig(fetchImpl, url, {
      method: "PATCH",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(authManagementPatch(plan)),
    }),
  );
  if (!authManagementConfigMatches(patched, plan)) {
    throw new Error(
      "Supabase Auth configuration response does not match the approved plan",
    );
  }

  const readback = parseAuthManagementConfig(
    await fetchAuthManagementConfig(fetchImpl, url, { headers }),
  );
  if (!authManagementConfigMatches(readback, plan)) {
    throw new Error(
      "Supabase Auth configuration readback does not match the approved plan",
    );
  }
  return { outcome: "updated", verified: true };
}

type CliArguments = {
  environment?: string;
  projectRef?: string;
  siteUrl?: string;
  redirectUrls: string[];
  execute: boolean;
};

function parseArguments(argv: string[]): CliArguments {
  const parsed: CliArguments = { redirectUrls: [], execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") continue;
    if (argument === "--execute") {
      parsed.execute = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    if (argument === "--environment") parsed.environment = value;
    else if (argument === "--project-ref") parsed.projectRef = value;
    else if (argument === "--site-url") parsed.siteUrl = value;
    else if (argument === "--redirect-url") parsed.redirectUrls.push(value);
    else throw new Error(`unsupported argument: ${argument}`);
  }
  return parsed;
}

export async function runConfigPushCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const args = parseArguments(argv);
  const root = resolve(import.meta.dirname, "../..");
  const [baseConfigSource, linkedProjectRef] = await Promise.all([
    readFile(resolve(root, "supabase/config.toml"), "utf8"),
    readFile(resolve(root, "supabase/.temp/project-ref"), "utf8").catch(() => {
      throw new Error(
        "linked project identity is missing; run the protected link step first",
      );
    }),
  ]);
  const plan = createConfigPushPlan({
    environment: args.environment ?? "",
    targetProjectRef: args.projectRef ?? "",
    linkedProjectRef,
    stagingProjectRef: env.STAGING_PROJECT_REF,
    productionProjectRef: env.PRODUCTION_PROJECT_REF,
    baseConfigSource,
    stagingSiteUrl: args.environment === "staging" ? args.siteUrl : undefined,
    stagingRedirectUrls:
      args.environment === "staging" &&
      (args.siteUrl !== undefined || args.redirectUrls.length > 0)
        ? args.redirectUrls
        : undefined,
    productionSiteUrl:
      args.environment === "production" ? args.siteUrl : undefined,
    productionRedirectUrls:
      args.environment === "production" ? args.redirectUrls : undefined,
  });

  const summary = {
    mode: args.execute ? "execute" : "dry-run",
    environment: plan.environment,
    project_ref: plan.projectRef,
    auth_plan_sha256: plan.authPlanSha256,
    auth_site_origin: new URL(plan.authSiteUrl).origin,
    auth_redirect_count: plan.authRedirectUrls.length,
    auth_jwt_expiry_seconds: plan.authJwtExpirySeconds,
    auth_minimum_password_length: plan.authMinimumPasswordLength,
    auth_totp_enrollment_enabled: plan.authTotpEnrollmentEnabled,
    auth_totp_verification_enabled: plan.authTotpVerificationEnabled,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (args.execute) {
    const execution = await executeRemoteAuthConfig(plan, {
      accessToken: env.SUPABASE_ACCESS_TOKEN,
    });
    process.stdout.write(
      `${JSON.stringify({ auth_configuration: execution.outcome, readback_verified: execution.verified })}\n`,
    );
  } else {
    process.stdout.write(
      "Dry-run only. Repeat the exact command with --execute after review.\n",
    );
  }
  return summary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runConfigPushCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Auth configuration failed"}\n`,
    );
    process.exitCode = 1;
  });
}
