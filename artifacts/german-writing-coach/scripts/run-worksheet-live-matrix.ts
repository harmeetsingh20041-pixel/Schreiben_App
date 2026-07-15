import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAuthenticatedPlaywright } from "./run-authenticated-playwright";

export const WORKSHEET_LIVE_MATRIX_LEVELS = ["A1", "A2", "B1", "B2"] as const;

const WORKSHEET_LIVE_SPEC = "authenticated.worksheet-live.spec.ts";

function requireExactEnvironment(name: string, expected: string) {
  if (process.env[name]?.trim() !== expected) {
    throw new Error(`${name} must equal ${expected} for the worksheet matrix.`);
  }
}

export function validateWorksheetLiveMatrixEnvironment() {
  requireExactEnvironment("E2E_AUTHENTICATED", "true");
  requireExactEnvironment("E2E_MUTATIONS", "true");
  requireExactEnvironment("E2E_LIVE_WORKSHEET", "true");

  if (
    process.env.E2E_HOSTED_STAGING === "true" ||
    process.env.E2E_PERFORMANCE === "true" ||
    process.env.E2E_LIVE_WORKSHEET_RECOVERY_ONLY === "true" ||
    process.env.E2E_BASE_URL?.trim()
  ) {
    throw new Error(
      "The worksheet matrix is restricted to the protected local-frontend staging workflow.",
    );
  }

  if (process.env.E2E_WORKSHEET_LEVEL?.trim()) {
    throw new Error(
      "Unset E2E_WORKSHEET_LEVEL; the worksheet matrix owns the A1-B2 sequence.",
    );
  }
}

async function recoverExactFixture() {
  const previousRecoveryOnly = process.env.E2E_LIVE_WORKSHEET_RECOVERY_ONLY;
  process.env.E2E_LIVE_WORKSHEET_RECOVERY_ONLY = "true";
  try {
    return await runAuthenticatedPlaywright([WORKSHEET_LIVE_SPEC]);
  } finally {
    if (previousRecoveryOnly === undefined) {
      delete process.env.E2E_LIVE_WORKSHEET_RECOVERY_ONLY;
    } else {
      process.env.E2E_LIVE_WORKSHEET_RECOVERY_ONLY = previousRecoveryOnly;
    }
  }
}

export async function runWorksheetLiveMatrix() {
  validateWorksheetLiveMatrixEnvironment();

  try {
    for (const level of WORKSHEET_LIVE_MATRIX_LEVELS) {
      process.env.E2E_WORKSHEET_LEVEL = level;
      const exitCode = await runAuthenticatedPlaywright([WORKSHEET_LIVE_SPEC]);
      if (exitCode !== 0) {
        const recoveryExitCode = await recoverExactFixture();
        return recoveryExitCode === 0 ? exitCode : recoveryExitCode;
      }
    }
    return 0;
  } finally {
    delete process.env.E2E_WORKSHEET_LEVEL;
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.exitCode = await runWorksheetLiveMatrix();
}
