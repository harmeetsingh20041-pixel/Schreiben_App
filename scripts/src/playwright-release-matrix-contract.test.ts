import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
const workflow = readFileSync(
  new URL("../../.github/workflows/verify.yml", import.meta.url),
  "utf8",
);
const testingGuide = readFileSync(
  new URL("../../docs/TESTING.md", import.meta.url),
  "utf8",
);

function workflowJob(name: string) {
  const header = `  ${name}:`;
  const start = workflow.indexOf(header);
  assert.notEqual(start, -1, `Missing workflow job: ${name}`);
  const following = workflow.slice(start + header.length);
  const nextJobOffset = following.search(/^  [a-z][a-z0-9-]*:/m);
  return workflow.slice(
    start,
    nextJobOffset === -1
      ? workflow.length
      : start + header.length + nextJobOffset,
  );
}

test("every reviewed authenticated release spec has an exact root and app command", () => {
  const scripts = {
    "test:e2e:autosave-regression":
      "authenticated.autosave-regression.spec.ts",
    "test:e2e:dialog-viewport": "authenticated.dialog-viewport.spec.ts",
    "test:e2e:worksheet-live": "authenticated.worksheet-live.spec.ts",
    "test:e2e:submission-realtime":
      "authenticated.submission-realtime-live.spec.ts",
  } as const;

  for (const [name, specification] of Object.entries(scripts)) {
    assert.equal(
      rootPackage.scripts?.[name],
      `pnpm --filter @workspace/german-writing-coach run ${name}`,
    );
    assert.equal(
      appPackage.scripts?.[name],
      `tsx scripts/run-authenticated-playwright.ts ${specification}`,
    );
    assert.match(testingGuide, new RegExp(`pnpm run ${name}`));
  }
});

test("public CI always executes both credential-free Playwright suites", () => {
  const job = workflowJob("e2e");
  assert.match(job, /run: pnpm run test:e2e$/m);
  assert.match(job, /run: pnpm run test:e2e:practice-state-matrix$/m);
  assert.doesNotMatch(job, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(job, /test:e2e:(?:authenticated|autosave-regression|dialog-viewport|submission-realtime|worksheet-live)/);
});

test("authenticated CI is protected, secret-checked, provider-free, and exact", () => {
  const job = workflowJob("authenticated-e2e");
  assert.match(
    job,
    /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true && inputs\.run_authenticated_e2e/,
  );
  assert.match(job, /^    environment: staging$/m);
  assert.match(job, /required=\([\s\S]*E2E_STUDENT_PASSWORD[\s\S]*\)/);
  assert.match(
    job,
    /Authenticated staging matrix prerequisites are incomplete[\s\S]*exit 1/,
  );
  for (const command of [
    "test:e2e:authenticated",
    "test:e2e:dialog-viewport",
  ]) {
    assert.match(job, new RegExp(`pnpm run ${command}`));
  }
  assert.doesNotMatch(
    job,
    /SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|E2E_SUPABASE_BIN|supabase link/,
  );
  assert.doesNotMatch(
    job,
    /test:e2e:(?:autosave-regression|submission-realtime)/,
  );
  assert.doesNotMatch(job, /test:e2e:worksheet-live/);
  assert.doesNotMatch(job, /E2E_LIVE_WORKSHEET|E2E_LIVE_WRITING/);
  assert.doesNotMatch(job, /upload-artifact/i);
});

test("the aggregate local command mirrors every credential-free CI class without overstating release certification", () => {
  assert.equal(
    rootPackage.scripts?.["verify:local"],
    "pnpm run audit:verify && pnpm run typecheck && pnpm run test:unit && pnpm run check:edge && pnpm run test:edge && pnpm run build:ci && pnpm audit --prod --audit-level=high && pnpm run test:e2e && pnpm run test:e2e:practice-state-matrix && pnpm run test:db && git diff --check",
  );
  assert.match(testingGuide, /supabase start/);
  assert.match(testingGuide, /supabase db reset --local/);
  assert.match(testingGuide, /pnpm run verify:local/);
  assert.match(testingGuide, /supabase stop --no-backup/);
  assert.match(
    testingGuide,
    /does not claim any\s+credentialed staging, provider, human-content, production, or pilot gate/,
  );
});
