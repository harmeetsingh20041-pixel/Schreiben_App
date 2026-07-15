import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { cartographer } from "@replit/vite-plugin-cartographer";
import { devBanner } from "@replit/vite-plugin-dev-banner";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { resolveViteRuntimeConfig } from "../../config/vite-runtime";
import { assertSafeProductionLaunchFlags } from "../../config/production-launch";
import { buildProductionLaunchManifest } from "../../config/launch-manifest";

const appRoot = path.resolve(import.meta.dirname);
const appOutDir = path.resolve(import.meta.dirname, "dist/public");
const OFFICIAL_SENTRY_API_HOSTS = new Set([
  "sentry.io",
  "us.sentry.io",
  "us2.sentry.io",
  "de.sentry.io",
]);

export function isResolvedPackageModule(id: string, packageName: string) {
  const normalized = id.replaceAll("\\", "/");
  return normalized.includes(`/node_modules/${packageName}/`);
}

function normalizeOfficialSentryApiBase(value: string) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !OFFICIAL_SENTRY_API_HOSTS.has(hostname)
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function sentryDsnMatchesApiBase(dsnValue: string, apiBase: string) {
  try {
    const dsn = new URL(dsnValue);
    const apiHostname = new URL(apiBase).hostname.toLowerCase();
    const hostname = dsn.hostname.toLowerCase();
    const expectedIngestHostname = `ingest.${apiHostname}`;
    const pathSegments = dsn.pathname.split("/").filter(Boolean);
    return (
      dsn.protocol === "https:" &&
      dsn.username.length > 0 &&
      dsn.password === "" &&
      dsn.port === "" &&
      dsn.search === "" &&
      dsn.hash === "" &&
      (hostname === expectedIngestHostname ||
        hostname.endsWith(`.${expectedIngestHostname}`)) &&
      pathSegments.length === 1 &&
      /^\d+$/.test(pathSegments[0] ?? "")
    );
  } catch {
    return false;
  }
}

export function resolveSentryBuildConfig(
  command: "build" | "serve",
  environment: Record<string, string | undefined>,
) {
  const requested = ["1", "true", "yes", "on"].includes(
    (environment.SENTRY_UPLOAD_SOURCE_MAPS ?? "").trim().toLowerCase(),
  );
  const values = {
    authToken: environment.SENTRY_AUTH_TOKEN?.trim() ?? "",
    org: environment.SENTRY_ORG?.trim() ?? "",
    project: environment.SENTRY_PROJECT?.trim() ?? "",
    url: environment.SENTRY_API_BASE_URL?.trim() ?? "",
    release: environment.VITE_APP_RELEASE?.trim() ?? "",
  };
  const browserDsn = environment.VITE_SENTRY_DSN?.trim() ?? "";
  const inputsComplete =
    Object.values(values).every(Boolean) && browserDsn.length > 0;
  if (command === "build" && requested && !inputsComplete) {
    throw new Error(
      "Sentry source-map upload is only safe with SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, SENTRY_API_BASE_URL, VITE_SENTRY_DSN, and VITE_APP_RELEASE together.",
    );
  }
  const approvedApiBase = normalizeOfficialSentryApiBase(values.url);
  const routingApproved =
    approvedApiBase !== null &&
    sentryDsnMatchesApiBase(browserDsn, approvedApiBase);
  if (command === "build" && requested && !routingApproved) {
    throw new Error(
      "Sentry source-map upload requires an approved official Sentry destination bound to the browser DSN.",
    );
  }
  const enabled =
    command === "build" && requested && inputsComplete && routingApproved;
  return {
    enabled,
    ...values,
    url: enabled ? (approvedApiBase ?? "") : values.url,
  };
}

export function resolveViteEnvironment(
  mode: string,
  root: string,
  command: "build" | "serve",
  currentEnvironment: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...loadEnv(mode, root, ""),
    ...currentEnvironment,
    // A Vite build is a production artifact even when a custom mode or an
    // inherited NODE_ENV would otherwise make the guard return early.
    NODE_ENV: command === "build" ? "production" : currentEnvironment.NODE_ENV,
  };
}

export function shouldEnableRuntimeErrorOverlay(
  environment: Record<string, string | undefined>,
) {
  return !["0", "false", "no", "off"].includes(
    (environment.VITE_ENABLE_RUNTIME_ERROR_OVERLAY ?? "true")
      .trim()
      .toLowerCase(),
  );
}

export default defineConfig(({ command, mode }) => {
  const environment = resolveViteEnvironment(
    mode,
    appRoot,
    command,
    process.env,
  );
  assertSafeProductionLaunchFlags(environment);
  const { port, basePath } = resolveViteRuntimeConfig(environment);
  const sentryBuild = resolveSentryBuildConfig(command, environment);
  const launchManifest = buildProductionLaunchManifest(
    environment,
    basePath,
    sentryBuild.enabled,
  );
  const runtimeErrorOverlayEnabled =
    shouldEnableRuntimeErrorOverlay(environment);

  return {
    base: basePath,
    plugins: [
      react(),
      tailwindcss(),
      ...(runtimeErrorOverlayEnabled ? [runtimeErrorOverlay()] : []),
      {
        name: "schreiben-production-launch-manifest",
        apply: "build",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "launch-manifest.json",
            source: `${JSON.stringify(launchManifest, null, 2)}\n`,
          });
        },
      },
      ...(sentryBuild.enabled
        ? sentryVitePlugin({
            authToken: sentryBuild.authToken,
            org: sentryBuild.org,
            project: sentryBuild.project,
            url: sentryBuild.url,
            telemetry: false,
            release: {
              name: sentryBuild.release,
              inject: true,
              create: true,
              finalize: true,
              setCommits: false,
            },
            sourcemaps: {
              assets: `${appOutDir}/**`,
              filesToDeleteAfterUpload: `${appOutDir}/**/*.map`,
            },
          })
        : []),
      ...(command === "serve" &&
      environment.NODE_ENV !== "production" &&
      environment.REPL_ID !== undefined
        ? [
            cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
            devBanner(),
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@assets": path.resolve(
          import.meta.dirname,
          "..",
          "..",
          "attached_assets",
        ),
      },
      dedupe: ["react", "react-dom"],
    },
    root: appRoot,
    build: {
      outDir: appOutDir,
      emptyOutDir: true,
      sourcemap: sentryBuild.enabled ? "hidden" : false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (id.includes("@supabase")) return "vendor-supabase";
            if (id.includes("@radix-ui")) return "vendor-radix";
            if (id.includes("lucide-react")) return "vendor-icons";
            if (id.includes("@tanstack/react-query")) return "vendor-query";
            if (
              ["react", "react-dom", "scheduler", "wouter"].some(
                (packageName) => isResolvedPackageModule(id, packageName),
              )
            )
              return "vendor-react";
            return undefined;
          },
        },
      },
    },
    server: {
      port,
      strictPort: true,
      host: "0.0.0.0",
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
    },
  };
});
