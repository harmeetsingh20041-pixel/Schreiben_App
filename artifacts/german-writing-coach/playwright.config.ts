import { defineConfig, devices } from "@playwright/test";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  AUTHENTICATED_OUTPUT_DIRECTORY_NAME,
  AUTHENTICATED_OUTPUT_PREFIX,
  AUTHENTICATED_PERFORMANCE_PREVIEW_PORT,
  createAuthenticatedWebServerEnvironment,
  createPerformancePreviewEnvironment,
  isAuthenticatedPerformancePreview,
  maskInheritedPerformancePreviewEnvironment,
  PINNED_AUTHENTICATED_SUPABASE_URL,
  PINNED_HOSTED_STAGING_APP_URL,
  isPinnedHostedStagingRun,
} from "./scripts/run-authenticated-playwright";

const externalBaseUrl = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const authenticatedPerformancePreview = isAuthenticatedPerformancePreview(
  process.env,
);
const port = authenticatedPerformancePreview
  ? AUTHENTICATED_PERFORMANCE_PREVIEW_PORT
  : process.env.E2E_PORT || "4173";
const localBaseUrl = `http://127.0.0.1:${port}`;
const authenticated = process.env.E2E_AUTHENTICATED === "true";
const hostedStaging = isPinnedHostedStagingRun(process.env);
const requestedAuthenticatedOutputDir =
  process.env.E2E_AUTH_OUTPUT_DIR?.trim() ?? "";
const authenticatedOutputDir = requestedAuthenticatedOutputDir
  ? resolve(requestedAuthenticatedOutputDir)
  : "";
if (process.env.E2E_HOSTED_STAGING === "true" && !authenticated) {
  throw new Error("Hosted staging E2E requires authenticated private mode.");
}
if (hostedStaging && externalBaseUrl !== PINNED_HOSTED_STAGING_APP_URL) {
  throw new Error(
    "Hosted staging E2E requires the repository-pinned HTTPS application URL.",
  );
}
if (authenticated && externalBaseUrl && !hostedStaging) {
  throw new Error(
    "Authenticated E2E must use the checked-out frontend on the local loopback server.",
  );
}
if (authenticated) {
  if (!authenticatedOutputDir) {
    throw new Error(
      "Authenticated E2E must run through its private cleanup wrapper.",
    );
  }
  const temporaryRoot = resolve(tmpdir());
  const privateOutputRoot = dirname(authenticatedOutputDir);
  const relativeToTemporaryRoot = relative(temporaryRoot, privateOutputRoot);
  let privateOutputIsValid = false;
  try {
    const privateRootStats = lstatSync(privateOutputRoot);
    const outputStats = lstatSync(authenticatedOutputDir);
    privateOutputIsValid =
      privateRootStats.isDirectory() &&
      !privateRootStats.isSymbolicLink() &&
      outputStats.isDirectory() &&
      !outputStats.isSymbolicLink() &&
      (process.platform === "win32" ||
        ((privateRootStats.mode & 0o077) === 0 &&
          (outputStats.mode & 0o077) === 0));
  } catch {
    privateOutputIsValid = false;
  }
  if (
    dirname(privateOutputRoot) !== temporaryRoot ||
    relativeToTemporaryRoot.startsWith("..") ||
    isAbsolute(relativeToTemporaryRoot) ||
    !basename(privateOutputRoot).startsWith(AUTHENTICATED_OUTPUT_PREFIX) ||
    basename(authenticatedOutputDir) !== AUTHENTICATED_OUTPUT_DIRECTORY_NAME ||
    !privateOutputIsValid
  ) {
    throw new Error(
      "Authenticated E2E output must be an isolated application-owned temporary directory.",
    );
  }
  const configuredSupabaseUrl = process.env.VITE_SUPABASE_URL?.replace(
    /\/$/,
    "",
  );
  if (configuredSupabaseUrl !== PINNED_AUTHENTICATED_SUPABASE_URL) {
    throw new Error(
      "Authenticated E2E requires the repository-pinned staging Supabase project.",
    );
  }
  if (!process.env.VITE_SUPABASE_ANON_KEY?.trim()) {
    throw new Error(
      "VITE_SUPABASE_ANON_KEY is required for authenticated E2E.",
    );
  }
}
const baseURL = hostedStaging
  ? PINNED_HOSTED_STAGING_APP_URL
  : authenticated
    ? localBaseUrl
    : externalBaseUrl || localBaseUrl;
const localWebServerEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && !name.startsWith("E2E_"),
  ),
) as Record<string, string>;
// Playwright merges webServer.env over the parent environment. Empty every
// browser-only E2E value explicitly so credentials and private samples cannot
// reach Vite plugins or application code through inherited process state.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("E2E_")) localWebServerEnvironment[name] = "";
}
const authenticatedWebServerEnvironment =
  authenticated && !authenticatedPerformancePreview
    ? createAuthenticatedWebServerEnvironment(process.env, port)
    : undefined;
const performancePreviewWebServerEnvironment = authenticatedPerformancePreview
  ? maskInheritedPerformancePreviewEnvironment(
      process.env,
      createPerformancePreviewEnvironment(process.env),
    )
  : undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: hostedStaging
    ? "./tests/e2e/authenticated.global-setup.ts"
    : undefined,
  testMatch: hostedStaging ? "**/authenticated.workflow.spec.ts" : undefined,
  testIgnore: authenticated
    ? []
    : [
        "**/authenticated*.spec.ts",
        "**/practice-state-matrix.spec.ts",
        "**/responsive-navigation.spec.ts",
      ],
  outputDir: authenticated
    ? authenticatedOutputDir
    : "../../test-results/playwright",
  // Error-context snapshots can contain the values of filled form controls.
  // Authenticated runs therefore retain no per-test output, even on failure.
  preserveOutput: authenticated ? "never" : "failures-only",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: authenticated
    ? process.env.CI
      ? [["github"]]
      : [["list"]]
    : process.env.CI
      ? [
          ["github"],
          ["html", { outputFolder: "../../playwright-report", open: "never" }],
        ]
      : [
          ["list"],
          ["html", { outputFolder: "../../playwright-report", open: "never" }],
        ],
  use: {
    baseURL,
    trace: authenticated ? "off" : "on-first-retry",
    screenshot: authenticated ? "off" : "only-on-failure",
    video: authenticated ? "off" : "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer:
    hostedStaging || (!authenticated && externalBaseUrl)
      ? undefined
      : {
          command: authenticatedPerformancePreview
            ? "pnpm exec vite preview --config vite.config.ts --host 127.0.0.1 --strictPort"
            : `PORT=${port} BASE_PATH=/ VITE_ENABLE_DEMO_MODE=${authenticated ? "false" : "true"} VITE_ENABLE_PUBLIC_TEACHER_SIGNUP=false VITE_ENABLE_PUBLIC_STUDENT_SIGNUP=false VITE_ENABLE_RUNTIME_ERROR_OVERLAY=${authenticated ? "false" : "true"} pnpm exec vite --config vite.config.ts --host 127.0.0.1`,
          url: localBaseUrl,
          env:
            performancePreviewWebServerEnvironment ??
            authenticatedWebServerEnvironment ??
            localWebServerEnvironment,
          reuseExistingServer: authenticated ? false : !process.env.CI,
          timeout: 120_000,
        },
});
