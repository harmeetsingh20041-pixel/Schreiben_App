import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const specification = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/authenticated.enrollment-edge.spec.ts",
    import.meta.url,
  ),
  "utf8",
);
const guide = readFileSync(
  new URL("../../docs/TESTING.md", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../../.github/workflows/verify.yml", import.meta.url),
  "utf8",
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

test("the enrollment-edge browser run is isolated and opt-in", () => {
  assert.equal(
    rootPackage.scripts?.["test:e2e:enrollment-edges"],
    "pnpm --filter @workspace/german-writing-coach run test:e2e:enrollment-edges",
  );
  assert.equal(
    appPackage.scripts?.["test:e2e:enrollment-edges"],
    "tsx scripts/run-authenticated-playwright.ts authenticated.enrollment-edge.spec.ts",
  );
  assert.match(specification, /process\.env\.E2E_ENROLLMENT_EDGES !== "true"/);
  assert.match(specification, /requiredEnvironment\("E2E_AUTHENTICATED"\)/);
  assert.doesNotMatch(workflow, /test:e2e:enrollment-edges/);
});

test("the enrollment edge matrix covers SEC-006 and SEC-018 behavior", () => {
  assert.match(specification, /const invalidCode = "!!!!!!!!"/);
  assert.match(specification, /"22023"/);
  assert.match(specification, /"P0002"/);
  assert.match(specification, /assertNoPendingRequest/);
  assert.match(specification, /replayApprovedRequest/);
  assert.match(specification, /page\.request\.fetch\(approvedRequest/);
  assert.match(
    specification,
    /The approved class-code replay created a new request/,
  );
  assert.match(specification, /assertSingleCreatedAssignment/);
  assert.match(specification, /assertArchivedClassDoesNotStrandStudent/);
  assert.match(specification, /Join another class/);
  assert.match(specification, /Join an active class that matches this task/);
  assert.match(specification, /removeCreatedEnrollment/);
  assert.match(specification, /archiveEmptyClass/);
});

test("the enrollment-edge specification cannot retain sensitive evidence or invoke AI", () => {
  for (const forbidden of [
    /console\.(?:log|info|warn|error)/,
    /error\.message/,
    /response\.url\(\)/,
    /page\.url\(\)/,
    /toHaveURL/,
    /trace|screenshot|video|testInfo\.attach/,
    /E2E_WRITING_SAMPLE/,
    /Submit Writing/,
    /prepare-writing-feedback/,
    /generate-practice-worksheet/,
  ]) {
    assert.doesNotMatch(specification, forbidden);
  }
  assert.match(specification, /pageerror:\$\{error\.name\}/);
  assert.match(
    specification,
    /http:\$\{response\.status\(\)\}:\$\{response\.request\(\)\.resourceType\(\)\}/,
  );
});

test("the operator guide documents process-only credentials and exact cleanup", () => {
  assert.match(guide, /Isolated enrollment-edge security regressions/);
  assert.match(guide, /E2E_ENROLLMENT_EDGES=true/);
  assert.match(guide, /pnpm run test:e2e:enrollment-edges/);
  assert.match(
    guide,
    /without submitting\s+writing or invoking any AI provider/,
  );
  assert.match(guide, /detects their actual teacher and student\s+shells/);
  assert.match(guide, /same approved\s+request/);
  assert.match(guide, /Join another class/);
  assert.match(guide, /removes only its proven assignment/);
  assert.match(guide, /not part of the normal `Verify` workflow/);
});
