import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDirectory = fileURLToPath(
  new URL("../../artifacts/german-writing-coach/", import.meta.url),
);
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const appPackage = JSON.parse(
  readFileSync(
    new URL(
      "../../artifacts/german-writing-coach/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { scripts?: Record<string, string> };

type Discovery = {
  fileCounts: Record<string, number>;
  totalFiles: number;
  totalTests: number;
};

function discover(config: string): Discovery {
  const output = execFileSync(
    "pnpm",
    ["exec", "playwright", "test", "--config", config, "--list"],
    {
      cwd: appDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "",
        E2E_AUTHENTICATED: "false",
        E2E_BASE_URL: "",
      },
      maxBuffer: 1024 * 1024,
    },
  ).replace(/\u001b\[[0-9;]*m/g, "");

  const fileCounts: Record<string, number> = {};
  for (const match of output.matchAll(
    /^\s*\[[^\]]+\]\s+›\s+([^:]+\.spec\.ts):/gm,
  )) {
    const file = match[1];
    fileCounts[file] = (fileCounts[file] ?? 0) + 1;
  }

  const summary = output.match(
    /^Total:\s+(\d+)\s+tests?\s+in\s+(\d+)\s+files?$/m,
  );
  assert.ok(summary, `Playwright discovery summary was missing:\n${output}`);

  return {
    fileCounts,
    totalTests: Number(summary[1]),
    totalFiles: Number(summary[2]),
  };
}

test("public Playwright discovers exactly the credential-free suite", () => {
  assert.deepEqual(discover("playwright.config.ts"), {
    fileCounts: {
      "dialog-viewport.spec.ts": 8,
      "login.smoke.spec.ts": 5,
    },
    totalFiles: 2,
    totalTests: 13,
  });
});

test("the provider-free fixture suites remain exact and dedicated", () => {
  assert.deepEqual(discover("playwright.practice-state-matrix.config.ts"), {
    fileCounts: {
      "practice-state-matrix.spec.ts": 9,
      "responsive-navigation.spec.ts": 2,
    },
    totalFiles: 2,
    totalTests: 11,
  });
  assert.equal(
    rootPackage.scripts?.["test:e2e:practice-state-matrix"],
    "pnpm --filter @workspace/german-writing-coach run test:e2e:practice-state-matrix",
  );
  assert.equal(
    appPackage.scripts?.["test:e2e:practice-state-matrix"],
    "tsc -p tsconfig.practice-state-matrix.json --noEmit && playwright test --config playwright.practice-state-matrix.config.ts",
  );
});
