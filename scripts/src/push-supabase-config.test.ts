import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  createConfigPushPlan,
  executeRemoteAuthConfig,
} from "./push-supabase-config.js";

const ROOT = resolve(import.meta.dirname, "../..");
const STAGING = "abcdefghijklmnopqrst";
const PRODUCTION = "bcdefghijklmnopqrstu";
const OTHER = "cdefghijklmnopqrstuv";
const STAGING_SITE_URL = "https://schreiben-v1-staging.netlify.app";
const STAGING_REDIRECT_URLS = [
  "https://schreiben-v1-staging.netlify.app/auth/confirm",
  "https://schreiben-v1-staging.netlify.app/auth/reset-password",
];

async function baseConfig() {
  return readFile(resolve(ROOT, "supabase/config.toml"), "utf8");
}

async function stagingPlan(overrides: Record<string, unknown> = {}) {
  return createConfigPushPlan({
    environment: "staging",
    targetProjectRef: STAGING,
    linkedProjectRef: STAGING,
    stagingProjectRef: STAGING,
    productionProjectRef: PRODUCTION,
    baseConfigSource: await baseConfig(),
    stagingSiteUrl: STAGING_SITE_URL,
    stagingRedirectUrls: STAGING_REDIRECT_URLS,
    ...overrides,
  });
}

async function productionPlan(overrides: Record<string, unknown> = {}) {
  return createConfigPushPlan({
    environment: "production",
    targetProjectRef: PRODUCTION,
    linkedProjectRef: PRODUCTION,
    stagingProjectRef: STAGING,
    productionProjectRef: PRODUCTION,
    baseConfigSource: await baseConfig(),
    productionSiteUrl: "https://schreiben.example",
    productionRedirectUrls: [
      "https://schreiben.example/auth/confirm",
      "https://schreiben.example/auth/reset-password",
    ],
    ...overrides,
  });
}

test("staging always renders the required remote Auth config for the staging identity", async () => {
  const source = await baseConfig();
  const plan = await stagingPlan();
  assert.equal(plan.environment, "staging");
  assert.equal(plan.projectRef, STAGING);
  assert.notEqual(plan.configSource, source);
  assert.equal(plan.authSiteUrl, "https://schreiben-v1-staging.netlify.app/");
  assert.deepEqual(plan.authRedirectUrls, STAGING_REDIRECT_URLS);
  assert.equal(plan.authJwtExpirySeconds, 600);
  assert.equal(plan.authMinimumPasswordLength, 8);
  assert.equal(plan.authTotpEnrollmentEnabled, true);
  assert.equal(plan.authTotpVerificationEnabled, true);
  assert.match(plan.configSource, /^jwt_expiry = 600$/m);
  assert.match(plan.configSource, /^minimum_password_length = 8$/m);
  assert.match(plan.configSource, /^enroll_enabled = true$/m);
  assert.match(plan.configSource, /^verify_enabled = true$/m);
});

test("staging renders only the explicit HTTPS site and exact same-origin Auth routes", async () => {
  const source = await baseConfig();
  const plan = await stagingPlan({
    stagingSiteUrl: STAGING_SITE_URL,
    stagingRedirectUrls: STAGING_REDIRECT_URLS,
  });
  assert.equal(plan.environment, "staging");
  assert.equal(plan.projectRef, STAGING);
  assert.notEqual(plan.configSource, source);
  assert.equal(plan.authSiteUrl, "https://schreiben-v1-staging.netlify.app/");
  assert.deepEqual(plan.authRedirectUrls, STAGING_REDIRECT_URLS);
  assert.equal(plan.authJwtExpirySeconds, 600);
  assert.equal(plan.authMinimumPasswordLength, 8);
  assert.equal(plan.authTotpEnrollmentEnabled, true);
  assert.equal(plan.authTotpVerificationEnabled, true);
  assert.match(plan.configSource, /^jwt_expiry = 600$/m);
  assert.match(plan.configSource, /^minimum_password_length = 8$/m);
  assert.match(plan.configSource, /^enroll_enabled = true$/m);
  assert.match(plan.configSource, /^verify_enabled = true$/m);
  assert.match(
    plan.configSource,
    /site_url = "https:\/\/schreiben-v1-staging\.netlify\.app\/"/,
  );
  assert.doesNotMatch(plan.configSource, /http:\/\/localhost/);
  assert.doesNotMatch(plan.configSource, /additional_redirect_urls = \[\]/);
});

test("staging HTTPS Auth overrides fail closed unless both exact routes are supplied", async () => {
  await assert.rejects(
    () =>
      stagingPlan({
        stagingSiteUrl: undefined,
        stagingRedirectUrls: undefined,
      }),
    /staging site URL must be an absolute URL/,
  );
  await assert.rejects(
    () =>
      stagingPlan({
        stagingSiteUrl: STAGING_SITE_URL,
        stagingRedirectUrls: undefined,
      }),
    /exactly the confirmation and password-reset Auth redirect URLs/,
  );
  await assert.rejects(
    () =>
      stagingPlan({
        stagingSiteUrl: undefined,
        stagingRedirectUrls: STAGING_REDIRECT_URLS,
      }),
    /staging site URL must be an absolute URL/,
  );
  await assert.rejects(
    () =>
      stagingPlan({
        stagingSiteUrl: "http://schreiben-v1-staging.netlify.app",
        stagingRedirectUrls: STAGING_REDIRECT_URLS,
      }),
    /staging site URL must use HTTPS/,
  );
  await assert.rejects(
    () =>
      stagingPlan({
        stagingSiteUrl: STAGING_SITE_URL,
        stagingRedirectUrls: [
          STAGING_REDIRECT_URLS[0],
          "https://another.example/auth/reset-password",
        ],
      }),
    /must use the site URL origin/,
  );
  await assert.rejects(
    () =>
      stagingPlan({
        stagingSiteUrl: STAGING_SITE_URL,
        stagingRedirectUrls: [
          STAGING_REDIRECT_URLS[0],
          "https://schreiben-v1-staging.netlify.app/auth/callback",
        ],
      }),
    /exact \/auth\/confirm and \/auth\/reset-password paths/,
  );
  await assert.rejects(
    () =>
      stagingPlan({
        stagingSiteUrl: STAGING_SITE_URL,
        stagingRedirectUrls: [
          STAGING_REDIRECT_URLS[0],
          "https://schreiben-v1-staging.netlify.app/**",
        ],
      }),
    /cannot contain a wildcard/,
  );
});

test("production renders only validated HTTPS Auth URLs and removes local defaults", async () => {
  const plan = await productionPlan();
  assert.equal(plan.environment, "production");
  assert.equal(plan.projectRef, PRODUCTION);
  assert.equal(plan.authSiteUrl, "https://schreiben.example/");
  assert.deepEqual(plan.authRedirectUrls, [
    "https://schreiben.example/auth/confirm",
    "https://schreiben.example/auth/reset-password",
  ]);
  assert.equal(plan.authJwtExpirySeconds, 600);
  assert.equal(plan.authMinimumPasswordLength, 8);
  assert.equal(plan.authTotpEnrollmentEnabled, true);
  assert.equal(plan.authTotpVerificationEnabled, true);
  assert.match(plan.configSource, /^jwt_expiry = 600$/m);
  assert.match(plan.configSource, /^minimum_password_length = 8$/m);
  assert.match(plan.configSource, /^enroll_enabled = true$/m);
  assert.match(plan.configSource, /^verify_enabled = true$/m);
  assert.match(
    plan.configSource,
    /site_url = "https:\/\/schreiben\.example\/"/,
  );
  assert.doesNotMatch(plan.configSource, /http:\/\/localhost/);
  assert.doesNotMatch(plan.configSource, /additional_redirect_urls = \[\]/);
});

test("production identity cannot use a staging-linked workspace", async () => {
  await assert.rejects(
    () => productionPlan({ linkedProjectRef: STAGING }),
    /linked project ref does not match/,
  );
});

test("staging config cannot target the production identity", async () => {
  await assert.rejects(
    () =>
      stagingPlan({
        targetProjectRef: PRODUCTION,
        linkedProjectRef: PRODUCTION,
      }),
    /staging config can only target/,
  );
});

test("production config cannot target the staging identity", async () => {
  await assert.rejects(
    () =>
      productionPlan({
        targetProjectRef: STAGING,
        linkedProjectRef: STAGING,
      }),
    /production config can only target/,
  );
});

test("staging and production cannot share the same expected project ref", async () => {
  await assert.rejects(
    () => productionPlan({ stagingProjectRef: PRODUCTION }),
    /must be different/,
  );
});

test("local config is never a remote config-push environment", async () => {
  await assert.rejects(
    () => productionPlan({ environment: "local" }),
    /local configuration is never pushed/,
  );
});

test("production requires a separately supplied production identity", async () => {
  await assert.rejects(
    () => productionPlan({ productionProjectRef: undefined }),
    /PRODUCTION_PROJECT_REF is required/,
  );
});

test("production rejects localhost, HTTP, empty, wildcard, and cross-origin Auth URLs", async () => {
  await assert.rejects(
    () => productionPlan({ productionSiteUrl: "http://localhost:3000" }),
    /must use HTTPS/,
  );
  await assert.rejects(
    () => productionPlan({ productionSiteUrl: "http://schreiben.example" }),
    /must use HTTPS/,
  );
  await assert.rejects(
    () => productionPlan({ productionRedirectUrls: [] }),
    /requires the exact \/auth\/confirm and \/auth\/reset-password redirect URLs/,
  );
  await assert.rejects(
    () =>
      productionPlan({
        productionRedirectUrls: ["https://schreiben.example/auth/confirm"],
      }),
    /requires the exact \/auth\/confirm and \/auth\/reset-password redirect URLs/,
  );
  await assert.rejects(
    () =>
      productionPlan({
        productionRedirectUrls: ["https://schreiben.example/**"],
      }),
    /cannot contain a wildcard/,
  );
  await assert.rejects(
    () =>
      productionPlan({
        productionRedirectUrls: ["https://accounts.example/auth/callback"],
      }),
    /must use the site URL origin/,
  );
  await assert.rejects(
    () =>
      productionPlan({
        productionRedirectUrls: ["https://schreiben.example/auth,confirm"],
      }),
    /cannot contain a comma/,
  );
  for (const nonPublicUrl of [
    "https://localhost.",
    "https://127.0.0.1",
    "https://[fc00::1]",
    "https://[fe80::1]",
    "https://[::ffff:127.0.0.1]",
  ]) {
    await assert.rejects(
      () => productionPlan({ productionSiteUrl: nonPublicUrl }),
      /must use a public hostname/,
    );
  }
});

test("production Auth overrides cannot be mixed into a staging plan", async () => {
  await assert.rejects(
    () =>
      stagingPlan({
        productionSiteUrl: "https://schreiben.example",
        productionRedirectUrls: ["https://schreiben.example/auth/confirm"],
      }),
    /not accepted for staging/,
  );
});

test("staging Auth overrides cannot be mixed into a production plan", async () => {
  await assert.rejects(
    () =>
      productionPlan({
        stagingSiteUrl: STAGING_SITE_URL,
        stagingRedirectUrls: STAGING_REDIRECT_URLS,
      }),
    /not accepted for production/,
  );
});

test("staging and production Auth plans reject JWT lifetime drift", async () => {
  const source = (await baseConfig()).replace(
    "jwt_expiry = 600",
    "jwt_expiry = 601",
  );
  await assert.rejects(
    () => stagingPlan({ baseConfigSource: source }),
    /auth\.jwt_expiry must be exactly 600 seconds/,
  );
  await assert.rejects(
    () => productionPlan({ baseConfigSource: source }),
    /auth\.jwt_expiry must be exactly 600 seconds/,
  );
});

test("staging and production Auth plans reject minimum-password drift", async () => {
  const source = (await baseConfig()).replace(
    "minimum_password_length = 8",
    "minimum_password_length = 6",
  );
  await assert.rejects(
    () => stagingPlan({ baseConfigSource: source }),
    /auth\.minimum_password_length must be exactly 8/,
  );
  await assert.rejects(
    () => productionPlan({ baseConfigSource: source }),
    /auth\.minimum_password_length must be exactly 8/,
  );
});

test("staging and production Auth plans reject disabled TOTP enrollment or verification", async () => {
  for (const [configuredLine, disabledLine, expected] of [
    [
      "enroll_enabled = true",
      "enroll_enabled = false",
      /auth\.mfa\.totp\.enroll_enabled must be true/,
    ],
    [
      "verify_enabled = true",
      "verify_enabled = false",
      /auth\.mfa\.totp\.verify_enabled must be true/,
    ],
  ] as const) {
    const source = (await baseConfig()).replace(configuredLine, disabledLine);
    await assert.rejects(
      () => stagingPlan({ baseConfigSource: source }),
      expected,
    );
    await assert.rejects(
      () => productionPlan({ baseConfigSource: source }),
      expected,
    );
  }
});

test("execution updates only the targeted Auth Management API fields and verifies readback", async () => {
  const plan = await productionPlan();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const desired = {
    site_url: plan.authSiteUrl,
    uri_allow_list: plan.authRedirectUrls.join(","),
    jwt_exp: 600,
    password_min_length: 8,
    mfa_totp_enroll_enabled: true,
    mfa_totp_verify_enabled: true,
  };
  const responses = [
    { ...desired, site_url: "https://old.example/" },
    desired,
    desired,
  ];
  const result = await executeRemoteAuthConfig(plan, {
    accessToken: "sbp_test_management_token_value",
    fetchImpl: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return Response.json(responses.shift());
    },
  });
  assert.deepEqual(result, { outcome: "updated", verified: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.url),
    Array(3).fill(
      `https://api.supabase.com/v1/projects/${PRODUCTION}/config/auth`,
    ),
  );
  assert.equal(calls[0]!.init.method, undefined);
  assert.equal(calls[1]!.init.method, "PATCH");
  assert.equal(calls[2]!.init.method, undefined);
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), desired);
  assert.deepEqual(
    Object.keys(JSON.parse(String(calls[1]!.init.body))).sort(),
    [
      "jwt_exp",
      "mfa_totp_enroll_enabled",
      "mfa_totp_verify_enabled",
      "password_min_length",
      "site_url",
      "uri_allow_list",
    ],
  );
  for (const call of calls) {
    assert.equal(call.init.redirect, "error");
    assert.equal(
      (call.init.headers as Record<string, string>).Authorization,
      "Bearer sbp_test_management_token_value",
    );
  }
});

test("execution is a read-only no-op when the exact Auth settings already match", async () => {
  const plan = await stagingPlan();
  let requests = 0;
  const result = await executeRemoteAuthConfig(plan, {
    accessToken: "sbp_test_management_token_value",
    fetchImpl: async (_input, init = {}) => {
      requests += 1;
      assert.equal(init.method, undefined);
      return Response.json({
        site_url: plan.authSiteUrl,
        uri_allow_list: plan.authRedirectUrls.join(","),
        jwt_exp: 600,
        password_min_length: 8,
        mfa_totp_enroll_enabled: true,
        mfa_totp_verify_enabled: true,
      });
    },
  });
  assert.deepEqual(result, { outcome: "already-current", verified: true });
  assert.equal(requests, 1);
});

test("execution fails closed without a protected token or on an invalid readback", async () => {
  const plan = await stagingPlan();
  await assert.rejects(
    () => executeRemoteAuthConfig(plan),
    /SUPABASE_ACCESS_TOKEN must be supplied securely/,
  );

  let request = 0;
  const desired = {
    site_url: plan.authSiteUrl,
    uri_allow_list: plan.authRedirectUrls.join(","),
    jwt_exp: 600,
    password_min_length: 8,
    mfa_totp_enroll_enabled: true,
    mfa_totp_verify_enabled: true,
  };
  await assert.rejects(
    () =>
      executeRemoteAuthConfig(plan, {
        accessToken: "sbp_test_management_token_value",
        fetchImpl: async () => {
          request += 1;
          if (request === 1) {
            return Response.json({
              site_url: "https://old.example/",
              uri_allow_list: "",
              jwt_exp: 3600,
              password_min_length: 6,
              mfa_totp_enroll_enabled: false,
              mfa_totp_verify_enabled: false,
            });
          }
          if (request === 2) return Response.json(desired);
          return Response.json({ ...desired, mfa_totp_verify_enabled: false });
        },
      }),
    /readback does not match the approved plan/,
  );
  assert.equal(request, 3);
});

test("execution rejects Management API schema drift before attempting a PATCH", async () => {
  const plan = await stagingPlan();
  const desired = {
    site_url: plan.authSiteUrl,
    uri_allow_list: plan.authRedirectUrls.join(","),
    jwt_exp: 600,
    password_min_length: 8,
    mfa_totp_enroll_enabled: true,
    mfa_totp_verify_enabled: true,
  };
  for (const malformed of [
    { ...desired, jwt_exp: "600" },
    { ...desired, mfa_totp_enroll_enabled: "true" },
    { ...desired, uri_allow_list: [desired.uri_allow_list] },
    Object.fromEntries(
      Object.entries(desired).filter(([key]) => key !== "jwt_exp"),
    ),
  ]) {
    let requests = 0;
    await assert.rejects(
      () =>
        executeRemoteAuthConfig(plan, {
          accessToken: "sbp_test_management_token_value",
          fetchImpl: async () => {
            requests += 1;
            return Response.json(malformed);
          },
        }),
      /response (?:has invalid fields|is missing required fields)/,
    );
    assert.equal(requests, 1);
  }
});

test("execution repairs nullable or noncanonical but schema-valid Auth values", async () => {
  const plan = await stagingPlan();
  const desired = {
    site_url: plan.authSiteUrl,
    uri_allow_list: plan.authRedirectUrls.join(","),
    jwt_exp: 600,
    password_min_length: 8,
    mfa_totp_enroll_enabled: true,
    mfa_totp_verify_enabled: true,
  };
  for (const current of [
    {
      site_url: null,
      uri_allow_list: null,
      jwt_exp: null,
      password_min_length: null,
      mfa_totp_enroll_enabled: null,
      mfa_totp_verify_enabled: null,
    },
    { ...desired, uri_allow_list: `${desired.uri_allow_list},` },
    { ...desired, uri_allow_list: desired.uri_allow_list.replace(",", ", ") },
  ]) {
    let request = 0;
    const result = await executeRemoteAuthConfig(plan, {
      accessToken: "sbp_test_management_token_value",
      fetchImpl: async () => {
        request += 1;
        return Response.json(request === 1 ? current : desired);
      },
    });
    assert.deepEqual(result, { outcome: "updated", verified: true });
    assert.equal(request, 3);
  }
});

test("execution revalidates target-bound plan identity before any network call", async () => {
  const plan = await stagingPlan();
  let requests = 0;
  await assert.rejects(
    () =>
      executeRemoteAuthConfig(
        { ...plan, projectRef: OTHER },
        {
          accessToken: "sbp_test_management_token_value",
          fetchImpl: async () => {
            requests += 1;
            return Response.json({});
          },
        },
      ),
    /plan identity hash is invalid/,
  );
  assert.equal(requests, 0);

  await assert.rejects(
    () =>
      executeRemoteAuthConfig(
        { ...plan, environment: "local" } as unknown as typeof plan,
        {
          accessToken: "sbp_test_management_token_value",
          fetchImpl: async () => {
            requests += 1;
            return Response.json({});
          },
        },
      ),
    /plan environment is invalid/,
  );
  assert.equal(requests, 0);

  const sameSettingsDifferentTarget = await productionPlan({
    targetProjectRef: OTHER,
    linkedProjectRef: OTHER,
    productionProjectRef: OTHER,
  });
  const originalProduction = await productionPlan();
  assert.notEqual(
    sameSettingsDifferentTarget.authPlanSha256,
    originalProduction.authPlanSha256,
  );
});

test("execution exposes only a stable HTTP status when the Management API rejects a request", async () => {
  const plan = await stagingPlan();
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      () =>
        executeRemoteAuthConfig(plan, {
          accessToken: "sbp_test_management_token_value",
          fetchImpl: async () =>
            new Response('{"message":"secret provider detail"}', {
              status,
              headers: { "Content-Type": "application/json" },
            }),
        }),
      (error: unknown) => {
        assert.match(String(error), new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(String(error), /secret provider detail/);
        assert.doesNotMatch(String(error), /sbp_test_management_token_value/);
        return true;
      },
    );
  }
});

test("malformed or duplicated Auth keys fail closed", async () => {
  const source = await baseConfig();
  await assert.rejects(
    () =>
      productionPlan({
        baseConfigSource: source.replace(
          'site_url = "http://localhost:3000"',
          'site_url = "http://localhost:3000"\nsite_url = "http://localhost:3001"',
        ),
      }),
    /exactly one auth\.site_url/,
  );
  await assert.rejects(
    () =>
      productionPlan({
        baseConfigSource: source.replace(
          "additional_redirect_urls = []",
          'additional_redirect_urls = [\n  "http://localhost:3000",\n]',
        ),
      }),
    /multiline or malformed/,
  );
  await assert.rejects(
    () =>
      productionPlan({
        baseConfigSource: source.replace(
          "enroll_enabled = true",
          "enroll_enabled = true\nenroll_enabled = true",
        ),
      }),
    /auth\.mfa\.totp\.enroll_enabled exactly once/,
  );
  await assert.rejects(
    () => stagingPlan({ targetProjectRef: OTHER, linkedProjectRef: OTHER }),
    /staging config can only target/,
  );
  await assert.rejects(
    () =>
      stagingPlan({
        targetProjectRef: "abcdefghijklmnopqrs1",
        linkedProjectRef: "abcdefghijklmnopqrs1",
      }),
    /exact 20-letter lowercase Supabase project ref/,
  );
});
