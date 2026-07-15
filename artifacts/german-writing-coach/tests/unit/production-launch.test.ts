// @vitest-environment node

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeProductionLaunchFlags } from "../../../../config/production-launch";
import { buildProductionLaunchManifest } from "../../../../config/launch-manifest";
import {
  isResolvedPackageModule,
  resolveViteEnvironment,
  shouldEnableRuntimeErrorOverlay,
} from "../../vite.config";

describe("production launch flags", () => {
  it("matches exact vendor packages without swallowing unrelated React-named dependencies", () => {
    expect(
      isResolvedPackageModule(
        "/repo/node_modules/.pnpm/react@19.1.0/node_modules/react/index.js",
        "react",
      ),
    ).toBe(true);
    expect(
      isResolvedPackageModule(
        "/repo/node_modules/.pnpm/react-hook-form@7/node_modules/react-hook-form/dist/index.js",
        "react",
      ),
    ).toBe(false);
    expect(
      isResolvedPackageModule(
        "/repo/node_modules/.pnpm/@radix-ui+react-dialog@1/node_modules/@radix-ui/react-dialog/dist/index.js",
        "react",
      ),
    ).toBe(false);
  });

  it("keeps the development overlay by default and disables it only for explicit production-like browser tests", () => {
    expect(shouldEnableRuntimeErrorOverlay({})).toBe(true);
    expect(
      shouldEnableRuntimeErrorOverlay({
        VITE_ENABLE_RUNTIME_ERROR_OVERLAY: "false",
      }),
    ).toBe(false);
  });

  it("emits a content-free manifest for independent deployed-artifact verification", () => {
    expect(
      buildProductionLaunchManifest(
        {
          VITE_APP_RELEASE: "release-1",
          VITE_SUPABASE_URL: "https://abcde1ghijklmnopqrst.supabase.co/",
          VITE_ENABLE_DEMO_MODE: "false",
          VITE_ENABLE_PUBLIC_TEACHER_SIGNUP: "false",
          VITE_ENABLE_PUBLIC_STUDENT_SIGNUP: "true",
          VITE_SENTRY_ENVIRONMENT: "production",
          VITE_SENTRY_ENABLE_REPLAY: "false",
          VITE_SUPABASE_ANON_KEY: "must-not-appear",
          VITE_SENTRY_DSN: "must-not-appear",
        },
        "/",
      ),
    ).toEqual({
      schema_version: 1,
      app_release: "release-1",
      supabase_url: "https://abcde1ghijklmnopqrst.supabase.co",
      supabase_project_ref: "abcde1ghijklmnopqrst",
      base_path: "/",
      demo_mode_enabled: false,
      public_teacher_signup_enabled: false,
      public_student_signup_enabled: true,
      sentry_environment: "production",
      sentry_replay_enabled: false,
      sentry_source_maps_configured: false,
    });
  });

  it("requires complete Sentry build credentials before enabling source maps", async () => {
    const { resolveSentryBuildConfig } = await import("../../vite.config");
    expect(() =>
      resolveSentryBuildConfig("build", {
        SENTRY_UPLOAD_SOURCE_MAPS: "true",
        SENTRY_AUTH_TOKEN: "token-only",
      }),
    ).toThrow("only safe");
    expect(
      resolveSentryBuildConfig("build", {
        SENTRY_UPLOAD_SOURCE_MAPS: "true",
        SENTRY_AUTH_TOKEN: "token",
        SENTRY_ORG: "org",
        SENTRY_PROJECT: "project",
        SENTRY_API_BASE_URL: "https://de.sentry.io",
        VITE_SENTRY_DSN: "https://public-key@o123.ingest.de.sentry.io/456",
        VITE_APP_RELEASE: "release-1",
      }).enabled,
    ).toBe(true);
    expect(() =>
      resolveSentryBuildConfig("build", {
        SENTRY_UPLOAD_SOURCE_MAPS: "true",
        SENTRY_AUTH_TOKEN: "token",
        SENTRY_ORG: "org",
        SENTRY_PROJECT: "project",
        SENTRY_API_BASE_URL: "https://source-maps.attacker.example",
        VITE_SENTRY_DSN: "https://public-key@o123.ingest.de.sentry.io/456",
        VITE_APP_RELEASE: "release-1",
      }),
    ).toThrow("approved official Sentry destination");
    expect(() =>
      resolveSentryBuildConfig("build", {
        SENTRY_UPLOAD_SOURCE_MAPS: "true",
        SENTRY_AUTH_TOKEN: "token",
        SENTRY_ORG: "org",
        SENTRY_PROJECT: "project",
        SENTRY_API_BASE_URL: "https://tenant.sentry.io",
        VITE_SENTRY_DSN: "https://public-key@o123.ingest.tenant.sentry.io/456",
        VITE_APP_RELEASE: "release-1",
      }),
    ).toThrow("approved official Sentry destination");
    expect(() =>
      resolveSentryBuildConfig("build", {
        SENTRY_UPLOAD_SOURCE_MAPS: "true",
        SENTRY_AUTH_TOKEN: "token",
        SENTRY_ORG: "org",
        SENTRY_PROJECT: "project",
        SENTRY_API_BASE_URL: "https://de.sentry.io",
        VITE_SENTRY_DSN:
          "https://public-key-must-not-leak@ingest.attacker.example/456",
        VITE_APP_RELEASE: "release-1",
      }),
    ).toThrow("approved official Sentry destination");
    expect(
      resolveSentryBuildConfig("build", {
        SENTRY_AUTH_TOKEN: "ambient-token",
      }).enabled,
    ).toBe(false);
  });

  it("allows production only with demo and teacher signup off and student signup on", () => {
    expect(() =>
      assertSafeProductionLaunchFlags({
        NODE_ENV: "production",
        VITE_ENABLE_DEMO_MODE: "false",
        VITE_ENABLE_PUBLIC_TEACHER_SIGNUP: "0",
        VITE_ENABLE_PUBLIC_STUDENT_SIGNUP: "true",
      }),
    ).not.toThrow();
  });

  it.each([undefined, "false", "0"])(
    "blocks missing or disabled public student signup in production (%s)",
    (value) => {
      expect(() =>
        assertSafeProductionLaunchFlags({
          NODE_ENV: "production",
          VITE_ENABLE_DEMO_MODE: "false",
          VITE_ENABLE_PUBLIC_TEACHER_SIGNUP: "false",
          VITE_ENABLE_PUBLIC_STUDENT_SIGNUP: value,
        }),
      ).toThrow("public student signup");
    },
  );

  it.each([
    ["VITE_ENABLE_DEMO_MODE", "demo mode"],
    ["VITE_ENABLE_PUBLIC_TEACHER_SIGNUP", "public teacher signup"],
  ])("blocks %s in a production artifact", (flag, expectedMessage) => {
    expect(() =>
      assertSafeProductionLaunchFlags({
        NODE_ENV: "production",
        [flag]: "true",
      }),
    ).toThrow(expectedMessage);
  });

  it("does not constrain local demo development", () => {
    expect(() =>
      assertSafeProductionLaunchFlags({
        NODE_ENV: "development",
        VITE_ENABLE_DEMO_MODE: "true",
        VITE_ENABLE_PUBLIC_TEACHER_SIGNUP: "true",
      }),
    ).not.toThrow();
  });

  it.each([
    ["VITE_ENABLE_DEMO_MODE", "demo mode"],
    ["VITE_ENABLE_PUBLIC_TEACHER_SIGNUP", "public teacher signup"],
  ])("blocks %s loaded from .env.production", (flag, expectedMessage) => {
    const root = mkdtempSync(join(tmpdir(), "schreiben-vite-env-"));
    try {
      writeFileSync(join(root, ".env.production"), `${flag}=true\n`, "utf8");
      const environment = resolveViteEnvironment(
        "production",
        root,
        "build",
        {},
      );
      expect(environment[flag]).toBe("true");
      expect(() => assertSafeProductionLaunchFlags(environment)).toThrow(
        expectedMessage,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
