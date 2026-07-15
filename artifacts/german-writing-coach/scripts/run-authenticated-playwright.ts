import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export const AUTHENTICATED_OUTPUT_PREFIX =
  "schreiben-authenticated-playwright-";
export const AUTHENTICATED_OUTPUT_DIRECTORY_NAME = "playwright-output";
export const AUTHENTICATED_PERFORMANCE_PREVIEW_PORT = "4173";
export const PINNED_AUTHENTICATED_SUPABASE_URL =
  "https://vzcgalzspdehmnvqczfw.supabase.co";
export const PINNED_HOSTED_STAGING_APP_URL =
  "https://schreiben-v1-staging.netlify.app";

const SAFE_PROCESS_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
] as const;

const AUTHENTICATED_TEST_FILTER_PATTERN =
  /^authenticated(?:\.[a-z0-9][a-z0-9-]*)+\.spec\.ts(?::[1-9]\d*(?::[1-9]\d*)?)?$/;
const HOSTED_STAGING_TEST_FILE = "authenticated.workflow.spec.ts";
const PRIVATE_FILE_CREATION_MASK = 0o077;
const CLEANUP_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGHUP", "SIGINT", "SIGTERM"];

export type AuthenticatedPlaywrightArguments = {
  listOnly: boolean;
  testFilters: string[];
};

export function isAuthenticatedPerformancePreview(
  environment: NodeJS.ProcessEnv,
) {
  return (
    environment.E2E_AUTHENTICATED === "true" &&
    environment.E2E_PERFORMANCE === "true"
  );
}

export function isPinnedHostedStagingRun(environment: NodeJS.ProcessEnv) {
  return (
    environment.E2E_AUTHENTICATED === "true" &&
    environment.E2E_HOSTED_STAGING === "true"
  );
}

function safeProcessEnvironment(environment: NodeJS.ProcessEnv) {
  const safeEnvironment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_PROCESS_ENVIRONMENT_NAMES) {
    if (environment[name]) safeEnvironment[name] = environment[name];
  }
  return safeEnvironment;
}

function authenticatedPublicEnvironment(
  environment: NodeJS.ProcessEnv,
  options: { nodeEnvironment: "development" | "production"; port: string },
) {
  const supabaseUrl = environment.VITE_SUPABASE_URL?.replace(/\/$/, "");
  const supabaseAnonKey = environment.VITE_SUPABASE_ANON_KEY?.trim();
  if (supabaseUrl !== PINNED_AUTHENTICATED_SUPABASE_URL) {
    throw new Error(
      "Authenticated E2E requires the repository-pinned staging Supabase project.",
    );
  }
  if (!supabaseAnonKey) {
    throw new Error(
      "VITE_SUPABASE_ANON_KEY is required for authenticated E2E.",
    );
  }

  return {
    ...safeProcessEnvironment(environment),
    NODE_ENV: options.nodeEnvironment,
    PORT: options.port,
    BASE_PATH: "/",
    VITE_SUPABASE_URL: PINNED_AUTHENTICATED_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: supabaseAnonKey,
    VITE_ENABLE_DEMO_MODE: "false",
    VITE_ENABLE_PUBLIC_TEACHER_SIGNUP: "false",
    VITE_ENABLE_PUBLIC_STUDENT_SIGNUP: "true",
    VITE_ENABLE_RUNTIME_ERROR_OVERLAY: "false",
    SENTRY_UPLOAD_SOURCE_MAPS: "false",
  } satisfies NodeJS.ProcessEnv;
}

export function createPerformancePreviewEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  try {
    return authenticatedPublicEnvironment(environment, {
      nodeEnvironment: "production",
      port: AUTHENTICATED_PERFORMANCE_PREVIEW_PORT,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("repository-pinned staging Supabase project")
    ) {
      throw new Error(
        "Authenticated performance preview requires the repository-pinned staging Supabase project.",
      );
    }
    if (
      error instanceof Error &&
      error.message.includes("VITE_SUPABASE_ANON_KEY")
    ) {
      throw new Error(
        "VITE_SUPABASE_ANON_KEY is required for authenticated performance preview.",
      );
    }
    throw error;
  }
}

export function createAuthenticatedDevelopmentEnvironment(
  environment: NodeJS.ProcessEnv,
  port: string,
): NodeJS.ProcessEnv {
  return authenticatedPublicEnvironment(environment, {
    nodeEnvironment: "development",
    port,
  });
}

export function maskInheritedPerformancePreviewEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
  safeEnvironment: NodeJS.ProcessEnv,
): Record<string, string> {
  const masked = Object.fromEntries(
    Object.keys(inheritedEnvironment).map((name) => [name, ""]),
  );
  for (const [name, value] of Object.entries(safeEnvironment)) {
    if (value !== undefined) masked[name] = value;
  }
  return masked;
}

export function createAuthenticatedWebServerEnvironment(
  environment: NodeJS.ProcessEnv,
  port: string,
) {
  return maskInheritedPerformancePreviewEnvironment(
    environment,
    createAuthenticatedDevelopmentEnvironment(environment, port),
  );
}

export function parseAuthenticatedPlaywrightArguments(
  input: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): AuthenticatedPlaywrightArguments {
  const testFilters: string[] = [];
  let listOnly = false;

  for (const argument of input) {
    if (argument === "--list") {
      listOnly = true;
      continue;
    }
    if (
      argument.startsWith("-") ||
      !AUTHENTICATED_TEST_FILTER_PATTERN.test(argument)
    ) {
      throw new Error(
        "Authenticated E2E accepts only explicit authenticated spec filters and the safe --list option.",
      );
    }
    testFilters.push(argument);
  }

  if (testFilters.length === 0) {
    throw new Error(
      "Authenticated E2E requires an explicit authenticated spec filter.",
    );
  }

  if (
    isPinnedHostedStagingRun(environment) &&
    testFilters.some(
      (filter) =>
        filter.replace(/:\d+(?::\d+)?$/, "") !== HOSTED_STAGING_TEST_FILE,
    )
  ) {
    throw new Error(
      "Hosted staging E2E is restricted to the pinned authenticated workflow smoke.",
    );
  }

  return { listOnly, testFilters };
}

export function authenticatedPlaywrightCliArguments(
  parsed: AuthenticatedPlaywrightArguments,
) {
  return [
    "exec",
    "playwright",
    "test",
    ...parsed.testFilters,
    "--config",
    "playwright.config.ts",
    ...(parsed.listOnly ? ["--list"] : []),
  ];
}

export function withPrivateFileCreationMask<T>(run: () => T): T {
  if (process.platform === "win32") return run();
  const previousMask = process.umask(PRIVATE_FILE_CREATION_MASK);
  try {
    return run();
  } finally {
    process.umask(previousMask);
  }
}

async function runPerformancePreviewBuild(): Promise<number> {
  const safeEnvironment = createPerformancePreviewEnvironment(process.env);
  return new Promise<number>((resolveBuild, rejectBuild) => {
    const child = withPrivateFileCreationMask(() =>
      spawn(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        ["exec", "vite", "build", "--config", "vite.config.ts"],
        {
          cwd: process.cwd(),
          env: safeEnvironment,
          stdio: "inherit",
        },
      ),
    );
    child.once("error", rejectBuild);
    child.once("close", (code) => resolveBuild(code ?? 1));
  });
}

export async function withAuthenticatedOutput<T>(
  run: (outputDirectory: string) => Promise<T>,
): Promise<T> {
  const privateOutputRoot = await mkdtemp(
    join(tmpdir(), AUTHENTICATED_OUTPUT_PREFIX),
  );
  await chmod(privateOutputRoot, 0o700);
  const outputDirectory = join(
    privateOutputRoot,
    AUTHENTICATED_OUTPUT_DIRECTORY_NAME,
  );
  await mkdir(outputDirectory, { mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const removeOnExit = () => {
    try {
      rmSync(privateOutputRoot, { recursive: true, force: true });
    } catch {
      // A synchronous exit/signal cleanup cannot recover. Normal completion
      // still reports asynchronous cleanup failures through the finally block.
    }
  };

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const unregisterCleanup = () => {
    process.off("exit", removeOnExit);
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  };

  process.once("exit", removeOnExit);
  for (const signal of CLEANUP_SIGNALS) {
    const handler = () => {
      removeOnExit();
      unregisterCleanup();
      process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    return await run(outputDirectory);
  } finally {
    unregisterCleanup();
    await rm(privateOutputRoot, { recursive: true, force: true });
  }
}

export async function runAuthenticatedPlaywright(
  testArguments: string[],
): Promise<number> {
  const parsedArguments = parseAuthenticatedPlaywrightArguments(testArguments);
  if (isAuthenticatedPerformancePreview(process.env)) {
    const buildExitCode = await runPerformancePreviewBuild();
    if (buildExitCode !== 0) return buildExitCode;
  }
  return withAuthenticatedOutput(
    (outputDirectory) =>
      new Promise<number>((resolveRun, rejectRun) => {
        const child = withPrivateFileCreationMask(() =>
          spawn(
            process.platform === "win32" ? "pnpm.cmd" : "pnpm",
            authenticatedPlaywrightCliArguments(parsedArguments),
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                E2E_AUTH_OUTPUT_DIR: outputDirectory,
              },
              stdio: "inherit",
            },
          ),
        );

        child.once("error", rejectRun);
        child.once("close", (code) => resolveRun(code ?? 1));
      }),
  );
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.exitCode = await runAuthenticatedPlaywright(process.argv.slice(2));
}
