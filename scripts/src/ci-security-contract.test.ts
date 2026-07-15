import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/verify.yml", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const edgeTestFiles = readdirSync(
  new URL("../../supabase/functions/", import.meta.url),
  { recursive: true, encoding: "utf8" },
)
  .filter((path) => path.endsWith(".test.ts"))
  .map((path) => `supabase/functions/${path.replaceAll("\\", "/")}`)
  .sort();
const playwrightConfig = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/playwright.config.ts",
    import.meta.url,
  ),
  "utf8",
);
const authenticatedPlaywrightRunner = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/scripts/run-authenticated-playwright.ts",
    import.meta.url,
  ),
  "utf8",
);
const authenticatedWorkflowSpec = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/authenticated.workflow.spec.ts",
    import.meta.url,
  ),
  "utf8",
);
const authenticatedGlobalSetup = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/authenticated.global-setup.ts",
    import.meta.url,
  ),
  "utf8",
);
const hostedStagingSafety = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/helpers/hosted-staging-safety.ts",
    import.meta.url,
  ),
  "utf8",
);
const authenticatedCoreWorkflowSpec = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/authenticated.core-workflow.spec.ts",
    import.meta.url,
  ),
  "utf8",
);
const publicPlaywrightSpec = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/login.smoke.spec.ts",
    import.meta.url,
  ),
  "utf8",
);
const appSource = readFileSync(
  new URL("../../artifacts/german-writing-coach/src/App.tsx", import.meta.url),
  "utf8",
);
const authSource = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/src/lib/auth.tsx",
    import.meta.url,
  ),
  "utf8",
);
const launchConfigSource = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/src/lib/launchConfig.ts",
    import.meta.url,
  ),
  "utf8",
);
const loginSource = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/src/pages/login.tsx",
    import.meta.url,
  ),
  "utf8",
);
const studentWriteSource = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/src/pages/student/write.tsx",
    import.meta.url,
  ),
  "utf8",
);
const authenticatedWritingLiveSpec = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/authenticated.writing-live.spec.ts",
    import.meta.url,
  ),
  "utf8",
);
const viteConfigs = [
  "../../artifacts/german-writing-coach/vite.config.ts",
  "../../artifacts/mockup-sandbox/vite.config.ts",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

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

function workflowStep(job: string, name: string) {
  const header = `      - name: ${name}`;
  const start = job.indexOf(header);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const following = job.slice(start + header.length);
  const nextStepOffset = following.search(/^      - name:/m);
  return job.slice(
    start,
    nextStepOffset === -1 ? job.length : start + header.length + nextStepOffset,
  );
}

test("the retired showcase flag cannot restore demo auth or protected mock routes", () => {
  assert.doesNotMatch(
    launchConfigSource,
    /enableDemoMode|VITE_ENABLE_DEMO_MODE/,
  );
  assert.doesNotMatch(
    loginSource,
    /Interactive Demo Mode|continue as \(Demo\)/i,
  );
  assert.doesNotMatch(authSource, /getItem\(["']gwc_role["']\)/);
  assert.doesNotMatch(authSource, /setItem\(["']gwc_role["']/);
  assert.doesNotMatch(authSource, /authMode:\s*["']mock["']/);
  assert.doesNotMatch(appSource, /student\/result|pages\/student\/result/);
  assert.doesNotMatch(studentWriteSource, /student\/submission\/mock/);

  // The unauthenticated browser server intentionally sets the retired flag to
  // true. Its public smoke must still find no shortcuts and must prove that a
  // stale pre-V1 local role cannot cross either protected role boundary.
  assert.match(
    playwrightConfig,
    /VITE_ENABLE_DEMO_MODE=\$\{authenticated \? "false" : "true"\}/,
  );
  assert.match(
    publicPlaywrightSpec,
    /localStorage\.setItem\("gwc_role", "student"\)/,
  );
  assert.match(publicPlaywrightSpec, /Interactive Demo Mode/);
  assert.match(publicPlaywrightSpec, /\/student\/dashboard/);
  assert.match(publicPlaywrightSpec, /\/teacher\/dashboard/);
  assert.doesNotMatch(
    publicPlaywrightSpec,
    /getByRole\("button", \{ name: "Student" \}\)\.click/,
  );
});

test("every third-party GitHub Action is pinned to a full commit", () => {
  const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(
    (match) => match[1] ?? "",
  );
  assert(uses.length > 0);
  for (const action of uses) {
    assert.match(action, /^[^@\s]+@[a-f0-9]{40}$/, action);
  }
});

test("the full Edge test command includes every checked-in Edge test", () => {
  const command = rootPackage.scripts?.["test:edge"] ?? "";
  const listedTests =
    command.match(/supabase\/functions\/[^\s]+\.test\.ts/g) ?? [];

  assert.deepEqual([...listedTests].sort(), edgeTestFiles);
});

test("the credential-free CI build pins every safe V1 launch flag", () => {
  const command = rootPackage.scripts?.["build:ci"] ?? "";

  assert.match(command, /(?:^|\s)PORT=5173(?:\s|$)/);
  assert.match(command, /(?:^|\s)BASE_PATH=\/(?:\s|$)/);
  assert.match(command, /(?:^|\s)VITE_ENABLE_DEMO_MODE=false(?:\s|$)/);
  assert.match(
    command,
    /(?:^|\s)VITE_ENABLE_PUBLIC_TEACHER_SIGNUP=false(?:\s|$)/,
  );
  assert.match(
    command,
    /(?:^|\s)VITE_ENABLE_PUBLIC_STUDENT_SIGNUP=true(?:\s|$)/,
  );
});

test("authenticated browser tests run only from protected main and expose credentials only to Playwright", () => {
  const authenticatedJob = workflowJob("authenticated-e2e");
  assert.match(
    authenticatedJob,
    /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true && inputs\.run_authenticated_e2e/,
  );
  assert.match(authenticatedJob, /^    environment: staging$/m);
  assert.doesNotMatch(authenticatedJob, /^    env:/m);
  assert.doesNotMatch(authenticatedJob, /GITHUB_ENV/);

  const smoke = workflowStep(
    authenticatedJob,
    "Run authenticated staging smokes",
  );
  const beforeSmoke = authenticatedJob.slice(
    0,
    authenticatedJob.indexOf(smoke),
  );
  assert.doesNotMatch(beforeSmoke, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(authenticatedJob, /STAGING_APP_URL|E2E_BASE_URL/);
  assert.match(
    smoke,
    /VITE_SUPABASE_URL: https:\/\/vzcgalzspdehmnvqczfw\.supabase\.co/,
  );
  assert.match(
    smoke,
    /VITE_SUPABASE_ANON_KEY:.*secrets\.STAGING_VITE_SUPABASE_ANON_KEY/,
  );
  for (const credential of [
    "E2E_TEACHER_EMAIL",
    "E2E_TEACHER_PASSWORD",
    "E2E_STUDENT_EMAIL",
    "E2E_STUDENT_PASSWORD",
  ]) {
    assert.match(smoke, new RegExp(`secrets\\.${credential}`));
  }
  assert.match(smoke, /pnpm run test:e2e:authenticated/);
  assert.doesNotMatch(authenticatedJob, /upload-artifact/i);
  assert.match(playwrightConfig, /trace:\s*authenticated \? "off"/);
  assert.match(playwrightConfig, /screenshot:\s*authenticated \? "off"/);
  assert.match(playwrightConfig, /video:\s*authenticated \? "off"/);
  assert.match(
    playwrightConfig,
    /preserveOutput:\s*authenticated \? "never" : "failures-only"/,
  );
  assert.match(
    playwrightConfig,
    /outputDir:\s*authenticated[\s\S]*authenticatedOutputDir/,
  );
  assert.match(playwrightConfig, /E2E_AUTH_OUTPUT_DIR/);
  assert.match(
    authenticatedPlaywrightRunner,
    /mkdtemp\([\s\S]*AUTHENTICATED_OUTPUT_PREFIX/,
  );
  assert.match(
    authenticatedPlaywrightRunner,
    /finally\s*\{[\s\S]*rm\(privateOutputRoot,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/,
  );
  assert.match(
    authenticatedPlaywrightRunner,
    /E2E_AUTH_OUTPUT_DIR:\s*outputDirectory/,
  );
  assert.match(
    playwrightConfig,
    /reporter:\s*authenticated[\s\S]*\[\["list"\]\]/,
  );
  assert.match(
    playwrightConfig,
    /hostedStaging[\s\S]*externalBaseUrl !== PINNED_HOSTED_STAGING_APP_URL[\s\S]*repository-pinned HTTPS application URL/,
  );
  assert.match(
    playwrightConfig,
    /authenticated && externalBaseUrl && !hostedStaging[\s\S]*Authenticated E2E must use the checked-out frontend on the local loopback server/,
  );
  assert.match(
    authenticatedPlaywrightRunner,
    /export const PINNED_AUTHENTICATED_SUPABASE_URL\s*=\s*\n?\s*"https:\/\/vzcgalzspdehmnvqczfw\.supabase\.co"/,
  );
  assert.match(
    authenticatedPlaywrightRunner,
    /export const PINNED_HOSTED_STAGING_APP_URL\s*=\s*\n?\s*"https:\/\/schreiben-v1-staging\.netlify\.app"/,
  );
  assert.match(
    playwrightConfig,
    /PINNED_AUTHENTICATED_SUPABASE_URL[\s\S]*configuredSupabaseUrl !== PINNED_AUTHENTICATED_SUPABASE_URL/,
  );
  assert.match(playwrightConfig, /--host 127\.0\.0\.1/);
  assert.match(
    playwrightConfig,
    /hostedStaging \|\| \(!authenticated && externalBaseUrl\)[\s\S]*\? undefined/,
  );
  assert.match(
    playwrightConfig,
    /globalSetup:\s*hostedStaging[\s\S]*authenticated\.global-setup\.ts/,
  );
  assert.match(
    playwrightConfig,
    /testMatch:\s*hostedStaging \? "\*\*\/authenticated\.workflow\.spec\.ts" : undefined/,
  );
  assert.match(
    playwrightConfig,
    /!name\.startsWith\("E2E_"\)[\s\S]*performancePreviewWebServerEnvironment \?\?[\s\S]*authenticatedWebServerEnvironment \?\?[\s\S]*localWebServerEnvironment/,
  );
  assert.match(
    playwrightConfig,
    /reuseExistingServer: authenticated \? false : !process\.env\.CI/,
  );
  assert.match(
    playwrightConfig,
    /VITE_ENABLE_RUNTIME_ERROR_OVERLAY=\$\{authenticated \? "false" : "true"\}/,
  );
  assert.match(
    playwrightConfig,
    /createAuthenticatedWebServerEnvironment\(process\.env, port\)/,
  );
  assert.match(
    authenticatedPlaywrightRunner,
    /argument\.startsWith\("-"\)[\s\S]*AUTHENTICATED_TEST_FILTER_PATTERN\.test\(argument\)/,
  );
  assert.match(
    authenticatedPlaywrightRunner,
    /\.\.\.parsed\.testFilters,[\s\S]*"--config",[\s\S]*"playwright\.config\.ts"/,
  );
  assert.match(
    authenticatedPlaywrightRunner,
    /AUTHENTICATED_OUTPUT_DIRECTORY_NAME = "playwright-output"[\s\S]*chmod\(privateOutputRoot, 0o700\)/,
  );
  assert.match(
    authenticatedGlobalSetup,
    /validatePinnedHostedStagingManifest\(\)/,
  );
  assert.match(hostedStagingSafety, /redirect:\s*"error"/);
  assert.match(
    hostedStagingSafety,
    /response\.url !== PINNED_HOSTED_STAGING_MANIFEST_URL/,
  );
  assert.match(
    authenticatedWorkflowSpec,
    /assertPinnedHostedStagingPageOrigin\(page\.url\(\)\)/,
  );
  assert.doesNotMatch(authenticatedWorkflowSpec, /error\.message/);
  assert.doesNotMatch(authenticatedWorkflowSpec, /response\.url\(\)/);
  assert.match(authenticatedWorkflowSpec, /pageerror:\$\{error\.name\}/);
  assert.match(
    authenticatedCoreWorkflowSpec,
    /process\.env\.E2E_CORE_WORKFLOW !== "true"/,
  );
  assert.doesNotMatch(authenticatedCoreWorkflowSpec, /error\.message/);
  assert.doesNotMatch(authenticatedCoreWorkflowSpec, /response\.url\(\)/);
  assert.doesNotMatch(
    authenticatedCoreWorkflowSpec,
    /trace|screenshot|video|testInfo\.attach/,
  );
  assert.match(authenticatedCoreWorkflowSpec, /pageerror:\$\{error\.name\}/);
  assert.match(
    authenticatedWritingLiveSpec,
    /process\.env\.E2E_LIVE_WRITING !== "true"/,
  );
  assert.doesNotMatch(authenticatedWritingLiveSpec, /E2E_WRITING_SAMPLE/);
  assert.match(
    authenticatedWritingLiveSpec,
    /requiredEnvironment\("E2E_WRITING_STUDENT_SLOT"\)/,
  );
  assert.match(
    authenticatedWritingLiveSpec,
    /PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw"/,
  );
  assert.match(authenticatedWritingLiveSpec, /E2E_SUPABASE_BIN/);
  assert.match(authenticatedWritingLiveSpec, /E2E_MUTATIONS/);
  assert.match(authenticatedWritingLiveSpec, /cleanupFixtureSql/);
  assert.match(
    authenticatedWritingLiveSpec,
    /name: `\$\{target\.batchName\} · \$\{target\.level\}`/,
  );
  assert.doesNotMatch(authenticatedWritingLiveSpec, /Start Free Writing/);
  assert.doesNotMatch(authenticatedWritingLiveSpec, /E2E_LIVE_WRITING_MODE/);
  assert.match(
    authenticatedWritingLiveSpec,
    /process\.env\.E2E_LIVE_WRITING_CASE_INDEX/,
  );
  assert.match(
    authenticatedWritingLiveSpec,
    /process\.env\.E2E_LIVE_WRITING_REGRESSION_ID/,
  );
  assert.match(
    authenticatedWritingLiveSpec,
    /writing\.fill\(SELECTED_WRITING_CASE\.text\)/,
  );
  assert.match(authenticatedWritingLiveSpec, /"WRITING_LIVE_METRIC"/);
  assert.match(authenticatedWritingLiveSpec, /"WRITING_LIVE_OUTCOME"/);
  assert.match(authenticatedWritingLiveSpec, /correction_checks=/);
  assert.match(authenticatedWritingLiveSpec, /forbidden_remaining=/);
  assert.doesNotMatch(authenticatedWritingLiveSpec, /error\.message/);
  assert.doesNotMatch(authenticatedWritingLiveSpec, /response\.url\(\)/);
  assert.doesNotMatch(
    authenticatedWritingLiveSpec,
    /console\.(?:log|info|warn|error)/,
  );
  assert.doesNotMatch(
    authenticatedWritingLiveSpec,
    /trace|screenshot|video|testInfo\.attach/,
  );
  assert.doesNotMatch(
    authenticatedWritingLiveSpec,
    /toHaveValue\([^)]*SELECTED_WRITING_CASE\.text/,
  );
  assert.doesNotMatch(
    authenticatedWritingLiveSpec,
    /toHaveURL\([^)]*student\\\/submission/,
  );

  const secretNames = [...authenticatedJob.matchAll(/secrets\.([A-Z0-9_]+)/g)]
    .map((match) => match[1]!)
    .sort();
  assert.deepEqual(secretNames, [
    "E2E_STUDENT_EMAIL",
    "E2E_STUDENT_PASSWORD",
    "E2E_TEACHER_EMAIL",
    "E2E_TEACHER_PASSWORD",
    "STAGING_VITE_SUPABASE_ANON_KEY",
  ]);
});

test("production artifacts run only from protected main and expose credentials only to the production build", () => {
  const artifactJob = workflowJob("production-artifact");
  assert.match(
    artifactJob,
    /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true && inputs\.run_production_artifact/,
  );
  assert.match(artifactJob, /^    environment: production$/m);
  assert.doesNotMatch(artifactJob, /^    env:/m);
  assert.doesNotMatch(artifactJob, /GITHUB_ENV/);

  const releaseBinding = workflowStep(
    artifactJob,
    "Bind rollback release to the checked-out commit",
  );
  assert.match(
    releaseBinding,
    /APPROVED_APP_RELEASE:.*vars\.PRODUCTION_VITE_APP_RELEASE/,
  );
  assert.match(
    releaseBinding,
    /if \[\[ "\$APPROVED_APP_RELEASE" != "\$GITHUB_SHA" \]\]/,
  );
  assert.doesNotMatch(releaseBinding, /\$\{\{\s*secrets\./);

  const build = workflowStep(
    artifactJob,
    "Build and upload hidden source maps",
  );
  const beforeBuild = artifactJob.slice(0, artifactJob.indexOf(build));
  assert(
    artifactJob.indexOf(releaseBinding) < artifactJob.indexOf(build),
    "Release binding must run before the credential-bearing build.",
  );
  assert.doesNotMatch(beforeBuild, /\$\{\{\s*secrets\./);
  assert.match(
    build,
    /VITE_SUPABASE_ANON_KEY:.*secrets\.PRODUCTION_VITE_SUPABASE_ANON_KEY/,
  );
  assert.match(build, /SENTRY_AUTH_TOKEN:.*secrets\.SENTRY_AUTH_TOKEN/);
  assert.match(build, /VITE_APP_RELEASE:.*github\.sha/);
  assert.doesNotMatch(
    build,
    /E2E_TEACHER|E2E_STUDENT|PRODUCTION_SUPABASE_DB_PASSWORD|PRODUCTION_SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN/,
  );

  for (const stepName of [
    "Create exact production Edge rollback bundle",
    "Create immutable artifact hash manifest",
    "Attest the hash manifest",
    "Retain rollback artifacts",
  ]) {
    assert.doesNotMatch(
      workflowStep(artifactJob, stepName),
      /\$\{\{\s*secrets\./,
    );
  }

  const manifest = workflowStep(
    artifactJob,
    "Create immutable artifact hash manifest",
  );
  const edgeBundle = workflowStep(
    artifactJob,
    "Create exact production Edge rollback bundle",
  );
  assert.match(edgeBundle, /pnpm release:artifact:edge --/);
  assert.match(
    edgeBundle,
    /--source "\$GITHUB_WORKSPACE\/supabase\/functions"/,
  );
  assert.match(
    edgeBundle,
    /--output "\$RUNNER_TEMP\/production-edge-functions"/,
  );
  assert.match(manifest, /VITE_APP_RELEASE:.*github\.sha/);
  assert.match(
    manifest,
    /--frontend "\$GITHUB_WORKSPACE\/artifacts\/german-writing-coach\/dist\/public"/,
  );
  assert.match(manifest, /--edge "\$RUNNER_TEMP\/production-edge-functions"/);
  assert.match(
    manifest,
    /--migrations "\$GITHUB_WORKSPACE\/supabase\/migrations"/,
  );
  assert.doesNotMatch(manifest, /--edge supabase\/functions/);
  const retention = workflowStep(artifactJob, "Retain rollback artifacts");
  assert.match(retention, /name: schreiben-production-\$\{\{ github\.sha \}\}/);
  assert.match(
    retention,
    /\$\{\{ runner\.temp \}\}\/production-edge-functions/,
  );
  assert.doesNotMatch(retention, /^\s+supabase\/functions\s*$/m);
  assert.doesNotMatch(
    `${build}\n${edgeBundle}\n${manifest}\n${retention}`,
    /vars\.PRODUCTION_VITE_APP_RELEASE/,
  );

  const secretNames = [...artifactJob.matchAll(/secrets\.([A-Z0-9_]+)/g)]
    .map((match) => match[1]!)
    .sort();
  assert.deepEqual(secretNames, [
    "PRODUCTION_VITE_SUPABASE_ANON_KEY",
    "SENTRY_AUTH_TOKEN",
  ]);
});

test("Vite development servers never disable Host-header validation", () => {
  for (const source of viteConfigs) {
    assert.doesNotMatch(source, /allowedHosts:\s*true/);
  }
});

test("production preflight exposes credentials only to their exact trusted steps", () => {
  const job = workflowJob("production-preflight");
  assert.match(
    job,
    /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && github\.ref_protected && inputs\.run_production_preflight/,
  );
  assert.doesNotMatch(job, /^    env:/m);
  assert.doesNotMatch(job, /GITHUB_ENV/);

  const link = workflowStep(
    job,
    "Create an ephemeral local link to the declared production project",
  );
  const beforeLink = job.slice(0, job.indexOf(link));
  assert.doesNotMatch(beforeLink, /\$\{\{\s*secrets\./);
  assert.match(link, /SUPABASE_ACCESS_TOKEN:.*secrets\.SUPABASE_ACCESS_TOKEN/);
  assert.match(
    link,
    /SUPABASE_DB_PASSWORD:.*secrets\.PRODUCTION_SUPABASE_DB_PASSWORD/,
  );
  assert.doesNotMatch(
    link,
    /PRODUCTION_SUPABASE_SERVICE_ROLE_KEY|PRODUCTION_VITE_SUPABASE_ANON_KEY|SENTRY_AUTH_TOKEN/,
  );

  const preflight = workflowStep(
    job,
    "Collect and verify production evidence without mutation",
  );
  for (const credential of [
    "SUPABASE_ACCESS_TOKEN",
    "PRODUCTION_SUPABASE_SERVICE_ROLE_KEY",
    "PRODUCTION_VITE_SUPABASE_ANON_KEY",
    "SENTRY_AUTH_TOKEN",
  ]) {
    assert.match(preflight, new RegExp(`secrets\\.${credential}`));
  }
  assert.doesNotMatch(preflight, /PRODUCTION_SUPABASE_DB_PASSWORD/);
  assert.match(
    preflight,
    /LOCAL_SUPABASE_DB_URL=.*production-preflight-local-db-url/,
  );

  const worksheetCollection = workflowStep(
    job,
    "Collect the content-free production worksheet inventory",
  );
  assert.match(
    worksheetCollection,
    /SUPABASE_ACCESS_TOKEN:.*secrets\.SUPABASE_ACCESS_TOKEN/,
  );
  assert.doesNotMatch(
    worksheetCollection,
    /PRODUCTION_SUPABASE_DB_PASSWORD|PRODUCTION_SUPABASE_SERVICE_ROLE_KEY|PRODUCTION_VITE_SUPABASE_ANON_KEY|SENTRY_AUTH_TOKEN/,
  );

  const cleanup = workflowStep(
    job,
    "Stop the disposable local migration-history database",
  );
  assert.match(cleanup, /rm -f .*production-preflight-local-db-url/);
  assert.match(cleanup, /rm -rf .*supabase\/\.temp/);

  for (const stepName of [
    "Stop the disposable local migration-history database",
    "Reconcile production worksheets to the qualified launch bank",
    "Upload sanitized preflight evidence",
  ]) {
    assert.doesNotMatch(workflowStep(job, stepName), /\$\{\{\s*secrets\./);
  }

  const secretNames = [...job.matchAll(/secrets\.([A-Z0-9_]+)/g)]
    .map((match) => match[1]!)
    .sort();
  assert.deepEqual(secretNames, [
    "PRODUCTION_SUPABASE_DB_PASSWORD",
    "PRODUCTION_SUPABASE_SERVICE_ROLE_KEY",
    "PRODUCTION_VITE_SUPABASE_ANON_KEY",
    "SENTRY_AUTH_TOKEN",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_ACCESS_TOKEN",
  ]);
});
