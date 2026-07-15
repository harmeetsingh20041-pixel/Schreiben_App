// @vitest-environment node

import { access, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED_OUTPUT_DIRECTORY_NAME,
  AUTHENTICATED_PERFORMANCE_PREVIEW_PORT,
  AUTHENTICATED_OUTPUT_PREFIX,
  authenticatedPlaywrightCliArguments,
  createAuthenticatedWebServerEnvironment,
  createPerformancePreviewEnvironment,
  isAuthenticatedPerformancePreview,
  isPinnedHostedStagingRun,
  maskInheritedPerformancePreviewEnvironment,
  parseAuthenticatedPlaywrightArguments,
  PINNED_AUTHENTICATED_SUPABASE_URL,
  PINNED_HOSTED_STAGING_APP_URL,
  withPrivateFileCreationMask,
  withAuthenticatedOutput,
} from "../../scripts/run-authenticated-playwright";
import {
  assertPinnedHostedStagingPageOrigin,
  HOSTED_STAGING_PREFLIGHT_ERROR,
  PINNED_HOSTED_STAGING_MANIFEST_URL,
  PINNED_STAGING_PROJECT_REF,
  validatePinnedHostedStagingManifest,
} from "../e2e/helpers/hosted-staging-safety";

const VALID_HOSTED_MANIFEST = {
  schema_version: 1,
  app_release: "",
  supabase_url: PINNED_AUTHENTICATED_SUPABASE_URL,
  supabase_project_ref: PINNED_STAGING_PROJECT_REF,
  base_path: "/",
  demo_mode_enabled: false,
  public_teacher_signup_enabled: false,
  public_student_signup_enabled: true,
};

function manifestResponse(url = PINNED_HOSTED_STAGING_MANIFEST_URL) {
  const response = Response.json(VALID_HOSTED_MANIFEST, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("authenticated Playwright artifact cleanup", () => {
  it("enables hosted mode only for an explicit authenticated staging run", () => {
    expect(
      isPinnedHostedStagingRun({
        E2E_AUTHENTICATED: "true",
        E2E_HOSTED_STAGING: "true",
      }),
    ).toBe(true);
    expect(isPinnedHostedStagingRun({ E2E_HOSTED_STAGING: "true" })).toBe(
      false,
    );
    expect(PINNED_HOSTED_STAGING_APP_URL).toBe(
      "https://schreiben-v1-staging.netlify.app",
    );
  });

  it("allows only explicit authenticated filters and pins the config after them", () => {
    const parsed = parseAuthenticatedPlaywrightArguments([
      "authenticated.workflow.spec.ts:59",
      "--list",
    ]);
    expect(parsed).toEqual({
      listOnly: true,
      testFilters: ["authenticated.workflow.spec.ts:59"],
    });
    expect(authenticatedPlaywrightCliArguments(parsed)).toEqual([
      "exec",
      "playwright",
      "test",
      "authenticated.workflow.spec.ts:59",
      "--config",
      "playwright.config.ts",
      "--list",
    ]);

    for (const unsafeArguments of [
      ["authenticated.workflow.spec.ts", "--config", "other.config.ts"],
      ["authenticated.workflow.spec.ts", "-c", "other.config.ts"],
      ["authenticated.workflow.spec.ts", "--output=/tmp/public"],
      ["authenticated.workflow.spec.ts", "--reporter=html"],
      ["authenticated.workflow.spec.ts", "--trace=on"],
      ["authenticated.*.spec.ts"],
      [],
    ]) {
      expect(() =>
        parseAuthenticatedPlaywrightArguments(unsafeArguments),
      ).toThrow(/Authenticated E2E/);
    }
  });

  it("restricts hosted mode to the centrally guarded workflow spec", () => {
    const hostedEnvironment = {
      E2E_AUTHENTICATED: "true",
      E2E_HOSTED_STAGING: "true",
    };
    expect(
      parseAuthenticatedPlaywrightArguments(
        ["authenticated.workflow.spec.ts"],
        hostedEnvironment,
      ).testFilters,
    ).toEqual(["authenticated.workflow.spec.ts"]);
    expect(() =>
      parseAuthenticatedPlaywrightArguments(
        ["authenticated.teacher-mutations.spec.ts"],
        hostedEnvironment,
      ),
    ).toThrow("restricted to the pinned authenticated workflow smoke");
  });

  it("fails closed on redirected manifests and off-origin login pages", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    await validatePinnedHostedStagingManifest(async (input, init) => {
      requestedUrl = input;
      requestedInit = init;
      return manifestResponse();
    });
    expect(requestedUrl).toBe(PINNED_HOSTED_STAGING_MANIFEST_URL);
    expect(requestedInit).toMatchObject({
      credentials: "omit",
      method: "GET",
      redirect: "error",
    });

    await expect(
      validatePinnedHostedStagingManifest(async () =>
        manifestResponse("https://example.invalid/launch-manifest.json"),
      ),
    ).rejects.toThrow(HOSTED_STAGING_PREFLIGHT_ERROR);
    await expect(
      validatePinnedHostedStagingManifest(async () => {
        throw new TypeError("redirect rejected");
      }),
    ).rejects.toThrow(HOSTED_STAGING_PREFLIGHT_ERROR);

    expect(() =>
      assertPinnedHostedStagingPageOrigin(
        `${PINNED_HOSTED_STAGING_APP_URL}/login?next=%2Fteacher`,
      ),
    ).not.toThrow();
    expect(() =>
      assertPinnedHostedStagingPageOrigin("https://example.invalid/login"),
    ).toThrow("left the repository-pinned application origin");
  });

  it("builds performance preview with only public staging configuration", () => {
    const credential = "private-performance-credential";
    const serviceRole = "private-service-role";
    const runtimeTotp = "123456";
    const safeEnvironment = createPerformancePreviewEnvironment({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      VITE_SUPABASE_URL: PINNED_AUTHENTICATED_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: "public-anon-key",
      E2E_AUTHENTICATED: "true",
      E2E_PERFORMANCE: "true",
      E2E_TEACHER_PASSWORD: credential,
      E2E_ADMIN_TOTP_CODE: runtimeTotp,
      SUPABASE_SERVICE_ROLE_KEY: serviceRole,
    });

    expect(
      isAuthenticatedPerformancePreview({
        E2E_AUTHENTICATED: "true",
        E2E_PERFORMANCE: "true",
      }),
    ).toBe(true);
    expect(safeEnvironment).toMatchObject({
      NODE_ENV: "production",
      PORT: AUTHENTICATED_PERFORMANCE_PREVIEW_PORT,
      BASE_PATH: "/",
      VITE_SUPABASE_URL: PINNED_AUTHENTICATED_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: "public-anon-key",
      VITE_ENABLE_DEMO_MODE: "false",
      VITE_ENABLE_PUBLIC_TEACHER_SIGNUP: "false",
      VITE_ENABLE_PUBLIC_STUDENT_SIGNUP: "true",
      VITE_ENABLE_RUNTIME_ERROR_OVERLAY: "false",
      SENTRY_UPLOAD_SOURCE_MAPS: "false",
    });
    expect(Object.keys(safeEnvironment)).not.toContain(
      "SUPABASE_SERVICE_ROLE_KEY",
    );
    expect(
      Object.keys(safeEnvironment).some((name) => name.startsWith("E2E_")),
    ).toBe(false);
    expect(Object.values(safeEnvironment)).not.toContain(credential);
    expect(Object.values(safeEnvironment)).not.toContain(runtimeTotp);
    expect(Object.values(safeEnvironment)).not.toContain(serviceRole);

    const serverEnvironment = maskInheritedPerformancePreviewEnvironment(
      {
        E2E_TEACHER_PASSWORD: credential,
        E2E_ADMIN_TOTP_CODE: runtimeTotp,
        SUPABASE_SERVICE_ROLE_KEY: serviceRole,
      },
      safeEnvironment,
    );
    expect(serverEnvironment.E2E_TEACHER_PASSWORD).toBe("");
    expect(serverEnvironment.E2E_ADMIN_TOTP_CODE).toBe("");
    expect(serverEnvironment.SUPABASE_SERVICE_ROLE_KEY).toBe("");
    expect(Object.values(serverEnvironment)).not.toContain(credential);
    expect(Object.values(serverEnvironment)).not.toContain(runtimeTotp);
    expect(Object.values(serverEnvironment)).not.toContain(serviceRole);
  });

  it("passes only a fail-closed public allowlist to the local authenticated Vite server", () => {
    const safeEnvironment = createAuthenticatedWebServerEnvironment(
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        VITE_SUPABASE_URL: PINNED_AUTHENTICATED_SUPABASE_URL,
        VITE_SUPABASE_ANON_KEY: "public-anon-key",
        E2E_TEACHER_PASSWORD: "private-teacher-password",
        E2E_ADMIN_TOTP_CODE: "123456",
        SUPABASE_SERVICE_ROLE_KEY: "private-service-role",
        SUPABASE_ACCESS_TOKEN: "private-management-token",
        GEMINI_API_KEY: "private-provider-key",
      },
      "4173",
    );

    expect(safeEnvironment).toMatchObject({
      NODE_ENV: "development",
      PORT: "4173",
      VITE_SUPABASE_URL: PINNED_AUTHENTICATED_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: "public-anon-key",
      E2E_TEACHER_PASSWORD: "",
      E2E_ADMIN_TOTP_CODE: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SUPABASE_ACCESS_TOKEN: "",
      GEMINI_API_KEY: "",
    });
    expect(Object.values(safeEnvironment)).not.toContain(
      "private-teacher-password",
    );
    expect(Object.values(safeEnvironment)).not.toContain(
      "private-service-role",
    );
    expect(Object.values(safeEnvironment)).not.toContain(
      "private-management-token",
    );
    expect(Object.values(safeEnvironment)).not.toContain(
      "private-provider-key",
    );
  });

  it("rejects a performance preview outside the pinned staging project", () => {
    expect(() =>
      createPerformancePreviewEnvironment({
        VITE_SUPABASE_URL: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co",
        VITE_SUPABASE_ANON_KEY: "public-anon-key",
      }),
    ).toThrow("repository-pinned staging Supabase project");
  });

  it("keeps Vite browser globals available to clean-cache E2E typechecks", () => {
    const config = JSON.parse(
      readFileSync(new URL("../../tsconfig.e2e.json", import.meta.url), "utf8"),
    ) as { compilerOptions?: { types?: string[] } };

    expect(new Set(config.compilerOptions?.types)).toEqual(
      new Set(["node", "@playwright/test", "vite/client"]),
    );
  });

  it("deletes the exact private output directory after an intentionally failing run", async () => {
    let outputDirectory = "";
    let privateOutputRoot = "";

    await expect(
      withAuthenticatedOutput(async (directory) => {
        outputDirectory = directory;
        privateOutputRoot = dirname(directory);
        expect(basename(privateOutputRoot)).toMatch(
          new RegExp(`^${AUTHENTICATED_OUTPUT_PREFIX}`),
        );
        expect(basename(directory)).toBe(AUTHENTICATED_OUTPUT_DIRECTORY_NAME);
        if (process.platform !== "win32") {
          expect((await stat(privateOutputRoot)).mode & 0o777).toBe(0o700);
          expect((await stat(directory)).mode & 0o777).toBe(0o700);
        }
        await writeFile(
          join(directory, "error-context.md"),
          "synthetic-user@example.test\nSyntheticSecret#2026!",
          "utf8",
        );
        throw new Error("intentional authenticated test failure");
      }),
    ).rejects.toThrow("intentional authenticated test failure");

    await expect(access(outputDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(privateOutputRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("applies and restores the private child-process umask", () => {
    if (process.platform === "win32") return;
    const originalMask = process.umask();
    let inheritedMask = -1;
    withPrivateFileCreationMask(() => {
      inheritedMask = process.umask();
    });
    expect(inheritedMask).toBe(0o077);
    expect(process.umask()).toBe(originalMask);
  });

  it.skipIf(process.platform === "win32")(
    "removes the private output root before terminating on a signal",
    async () => {
      const fixture = fileURLToPath(
        new URL(
          "./fixtures/authenticated-output-signal-helper.ts",
          import.meta.url,
        ),
      );
      const child = spawn(process.execPath, ["--import", "tsx", fixture], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let privateOutputRoot = "";
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      try {
        const outputDirectory = await new Promise<string>(
          (resolveLine, rejectLine) => {
            let stdout = "";
            const timeout = setTimeout(
              () =>
                rejectLine(
                  new Error("Signal-cleanup fixture did not become ready."),
                ),
              5_000,
            );
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
              stdout += chunk;
              const newline = stdout.indexOf("\n");
              if (newline === -1) return;
              clearTimeout(timeout);
              resolveLine(stdout.slice(0, newline));
            });
            child.once("error", (error) => {
              clearTimeout(timeout);
              rejectLine(error);
            });
            child.once("exit", (code, signal) => {
              clearTimeout(timeout);
              rejectLine(
                new Error(
                  `Signal-cleanup fixture exited before readiness (${String(code)}, ${String(signal)}).`,
                ),
              );
            });
          },
        );
        privateOutputRoot = dirname(outputDirectory);
        expect((await stat(privateOutputRoot)).mode & 0o777).toBe(0o700);
        child.kill("SIGTERM");
        const close = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolveClose) => {
          child.once("close", (code, signal) => resolveClose({ code, signal }));
        });
        expect(close).toEqual({ code: null, signal: "SIGTERM" });
        await expect(access(privateOutputRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        if (privateOutputRoot) {
          await rm(privateOutputRoot, { recursive: true, force: true });
        }
        expect(stderr).toBe("");
      }
    },
  );

  it("keeps each live-practice mode credential-only, content-safe, and explicitly scoped", () => {
    const source = readFileSync(
      new URL("../e2e/authenticated.practice-live.spec.ts", import.meta.url),
      "utf8",
    );
    const config = readFileSync(
      new URL("../../playwright.config.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('requiredEnvironment("E2E_STUDENT_EMAIL")');
    expect(source).toContain('requiredEnvironment("E2E_STUDENT_PASSWORD")');
    expect(source).toContain('requiredEnvironment("E2E_PRACTICE_MODE")');
    expect(source).toContain(
      'requiredEnvironment("E2E_PRACTICE_ASSIGNMENT_ID")',
    );
    expect(source).toContain(
      'requiredEnvironment("E2E_PRACTICE_QUESTION_NUMBER")',
    );
    expect(source).toContain('requiredEnvironment("E2E_PRACTICE_SAMPLE")');
    expect(source).toContain(
      'requiredEnvironment("E2E_PRACTICE_ANSWERS_JSON")',
    );
    expect(source).toContain('requiredEnvironment("E2E_MUTATIONS")');
    expect(source).toContain("restoreAnswer(");
    expect(source).toContain("page.context().newPage()");
    expect(source).toContain("WORKSHEET_GENERATION_GATE_MS = 90_000");
    expect(source).toContain('test.skip(requiredPracticeMode() !== "autosave"');
    expect(source).toContain(
      'test.skip(requiredPracticeMode() !== "generation"',
    );
    expect(source).toContain(
      'test.skip(requiredPracticeMode() !== "submission"',
    );
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("response.url()");
    expect(source).not.toContain("console.");
    expect(source).not.toContain('name: "Submit worksheet" }).click');
    expect(source).not.toContain(".first()");
    expect(source).toContain("runTerminalSubmission(");
    expect(config).toContain('name.startsWith("E2E_")');
    expect(config).toContain('localWebServerEnvironment[name] = ""');
  });

  it("keeps two-tab autosave conflicts realistic and credential-safe", () => {
    const source = readFileSync(
      new URL(
        "../e2e/authenticated.autosave-regression.spec.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("performSettledUiSave(");
    expect(source).toContain("performStaleUiSave(");
    expect(source).toContain("expectNoUiSaveDuringRestore(");
    expect(source).toContain("await response.finished()");
    expect(source).toContain(
      'requiredEnvironment("E2E_AUTOSAVE_STUDENT_SLOT")',
    );
    expect(source).toContain('requestedStudentSlot !== "TEACHER"');
    expect(source).toContain('requestedStudentSlot !== "STUDENT"');
    expect(source).toContain("/rest/v1/rpc/get_auth_context");
    expect(source).toContain(
      "The staging student login was rejected; no autosave mutation was started.",
    );
    expect(source).not.toContain("detectAccountRole");
    expect(source).toContain("const stalePage = await context.newPage()");
    expect(source).toContain('name: "Reload saved draft"');
    expect(source).toContain('name: "Reload saved answers"');
    expect(source).toContain('toContainText("Conflict"');
    expect(source).toContain("messageClassification");
    expect(source).toContain('page.on("requestfinished"');
    expect(source).toContain("snapshot.pending === 0");
    expect(source).toContain("snapshot.finished === snapshot.started");
    expect(source).toContain("snapshot.quietForMs >= 750");
    expect(source).toContain("allowExpectedRpcFailure(staleResult.request)");
    expect(source).not.toContain("page.request");
    expect(source).not.toContain("window.fetch");
    expect(source).not.toContain("AbortController");
    expect(source).not.toContain("STALE_RPC_CLIENT_INFO");
    expect(source).not.toContain("authenticatedHeaders");
    expect(source).not.toContain("authorization");
    expect(source).not.toContain("apikey");
    expect(source).toContain('"no_matching_request"');
    expect(source).toContain('"request_pending"');
    expect(source).toContain('"request_failed"');
    expect(source).toContain('"action_failed"');
    expect(source).toContain("uiReachedConflict");
    expect(source).toContain("await waitForWritingRevision(stalePage, 1)");
    expect(source).toContain("await waitForPracticeRevision(stalePage, 1)");
    expect(source).toContain('name: "ist", exact: true');
    const jobCleanup = source.indexOf("delete from app_private.async_jobs job");
    const attemptCleanup = source.indexOf(
      "delete from public.practice_test_attempts attempt",
    );
    const worksheetCleanup = source.indexOf(
      "delete from public.practice_tests",
    );
    expect(jobCleanup).toBeGreaterThan(-1);
    expect(attemptCleanup).toBeGreaterThan(jobCleanup);
    expect(worksheetCleanup).toBeGreaterThan(attemptCleanup);
    expect(source).toContain("pg_temp.autosave_fixture_attempt_ids");
    expect(source).not.toContain(
      "The stale app autosave did not return a safe classified response.",
    );
    expect(source).not.toContain("error.message");
    expect(source).not.toMatch(
      /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)[\s\S]{0,160}throw\s+\1/,
    );
  });
});
