import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const specification = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/authenticated.performance.spec.ts",
    import.meta.url,
  ),
  "utf8",
);
const authenticatedRunner = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/scripts/run-authenticated-playwright.ts",
    import.meta.url,
  ),
  "utf8",
);
const playwrightConfig = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/playwright.config.ts",
    import.meta.url,
  ),
  "utf8",
);
const roleAssignment = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/performance-role-assignment.ts",
    import.meta.url,
  ),
  "utf8",
);
const roleAssignmentTest = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/unit/performance-role-assignment.test.ts",
    import.meta.url,
  ),
  "utf8",
);
const requestFailureClassifier = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/e2e/performance-request-failures.ts",
    import.meta.url,
  ),
  "utf8",
);
const requestFailureClassifierTest = readFileSync(
  new URL(
    "../../artifacts/german-writing-coach/tests/unit/performance-request-failures.test.ts",
    import.meta.url,
  ),
  "utf8",
);
const testingGuide = readFileSync(
  new URL("../../docs/TESTING.md", import.meta.url),
  "utf8",
);
const verifyWorkflow = readFileSync(
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

test("the staging route-performance run is private, isolated, and opt-in", () => {
  assert.equal(
    rootPackage.scripts?.["test:e2e:performance"],
    "pnpm --filter @workspace/german-writing-coach run test:e2e:performance",
  );
  assert.equal(
    appPackage.scripts?.["test:e2e:performance"],
    "tsx scripts/run-authenticated-playwright.ts authenticated.performance.spec.ts",
  );
  assert.match(specification, /process\.env\.E2E_PERFORMANCE !== "true"/);
  assert.match(specification, /requiredEnvironment\("E2E_AUTHENTICATED"\)/);
  assert.match(specification, /requiredEnvironment\("E2E_PERFORMANCE"\)/);
  assert.doesNotMatch(verifyWorkflow, /test:e2e:performance/);

  assert.match(
    authenticatedRunner,
    /mkdtemp\([\s\S]*AUTHENTICATED_OUTPUT_PREFIX/,
  );
  assert.match(
    authenticatedRunner,
    /finally\s*\{[\s\S]*rm\(privateOutputRoot,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/,
  );
  assert.match(playwrightConfig, /trace:\s*authenticated \? "off"/);
  assert.match(playwrightConfig, /screenshot:\s*authenticated \? "off"/);
  assert.match(playwrightConfig, /video:\s*authenticated \? "off"/);
  assert.match(
    playwrightConfig,
    /preserveOutput:\s*authenticated \? "never" : "failures-only"/,
  );
  assert.match(authenticatedRunner, /runPerformancePreviewBuild/);
  assert.match(
    authenticatedRunner,
    /\["exec", "vite", "build", "--config", "vite\.config\.ts"\]/,
  );
  assert.match(authenticatedRunner, /env:\s*safeEnvironment/);
  assert.match(
    playwrightConfig,
    /authenticatedPerformancePreview[\s\S]*vite preview/,
  );
  assert.match(playwrightConfig, /maskInheritedPerformancePreviewEnvironment/);
  assert.match(
    authenticatedRunner,
    /Object\.keys\(inheritedEnvironment\)[\s\S]*\[name, ""\]/,
  );
  assert.match(authenticatedRunner, /VITE_ENABLE_DEMO_MODE:\s*"false"/);
  assert.match(
    authenticatedRunner,
    /VITE_ENABLE_PUBLIC_TEACHER_SIGNUP:\s*"false"/,
  );
  assert.match(
    authenticatedRunner,
    /VITE_ENABLE_PUBLIC_STUDENT_SIGNUP:\s*"true"/,
  );
  assert.doesNotMatch(authenticatedRunner, /safeEnvironment\[[^\]]*E2E_/);
});

test("the measurement covers every requested dashboard and list route", () => {
  for (const [route, label] of [
    ["/teacher/dashboard", "teacher_overview"],
    ["/teacher/batches", "teacher_classes"],
    ["/teacher/students", "teacher_students"],
    ["/teacher/review-queue", "teacher_review_queue"],
    ["/student/dashboard", "student_home"],
    ["/student/questions", "student_write"],
    ["/student/practice", "student_practice"],
    ["/student/history", "student_history"],
  ]) {
    assert.match(specification, new RegExp(`route: "${route}"`));
    assert.match(specification, new RegExp(`label: "${label}"`));
  }
  assert.match(specification, /const WARM_SAMPLE_COUNT = 20;/);
  assert.match(specification, /const READY_P95_LIMIT_MS = 2_000;/);
  assert.match(specification, /Math\.ceil\(ordered\.length \* 0\.95\) - 1/);
  assert.match(specification, /duplicate_equivalent_requests_total/);
  assert.match(specification, /unreviewed_duplicate_equivalent_requests_total/);
  assert.match(specification, /reviewed_realtime_catchup_reads_total/);
  assert.match(
    specification,
    /rpc:list_student_grammar_stats_page[\s\S]*Math\.min\([\s\S]*1/,
  );
  assert.match(specification, /toBeLessThan\(READY_P95_LIMIT_MS\)/);
});

test("credential slots are mapped by trusted role and routed shell exactly once", () => {
  assert.match(specification, /signInAndDetectRole/);
  assert.match(specification, /matchesRpc\(response, "get_auth_context"\)/);
  assert.ok(
    specification.indexOf("await enterTeacherShellFromAdminLanding(page)") <
      specification.indexOf('matchesRpc(response, "get_auth_context")'),
    "the authoritative auth-context read must happen after any MFA challenge",
  );
  assert.match(
    specification,
    /authContextResponsePromise[\s\S]*page\.reload\(\{ waitUntil: "domcontentloaded" \}\)/,
  );
  assert.match(
    specification,
    /trustedServerRole\(authContext\) !== routedRole/,
  );
  assert.match(
    specification,
    /indexPerformanceAccountsByRole\(detectedAccounts\)/,
  );
  assert.match(
    roleAssignment,
    /teachers\.length !== 1 \|\| students\.length !== 1/,
  );
  assert.match(
    roleAssignmentTest,
    /maps reversed credential labels by detected role/,
  );
  assert.match(roleAssignmentTest, /signInAttempts: 1/);
  assert.doesNotMatch(specification, /@gmail\.com|SchreibenTest/);
});

test("a focused performance diagnostic remains explicit and cannot count as the full matrix", () => {
  assert.match(specification, /E2E_PERFORMANCE_DIAGNOSTIC_ROUTE/);
  assert.match(specification, /E2E_PERFORMANCE_DIAGNOSTIC_SLOT/);
  assert.match(
    specification,
    /requires both an exact route label and credential slot/,
  );
  assert.match(
    specification,
    /diagnostic_warm_full_navigation[\s\S]*warm_full_navigation/,
  );
  assert.match(
    specification,
    /diagnostic credential did not match the reviewed route role/,
  );
});

test("the measurement separates browser, Data API, and render timing", () => {
  assert.match(specification, /clientBootstrapMs/);
  assert.match(specification, /dataApiCriticalPathMs/);
  assert.match(specification, /maxDataApiRequestMs/);
  assert.match(specification, /clientRenderAfterDataMs/);
  assert.match(specification, /network_server_definition/);
  assert.match(specification, /client_render_definition/);
  assert.match(specification, /reviewed_endpoint_counts_total/);
  assert.match(specification, /rpc:list_workspace_batch_options/);
  assert.match(specification, /kind: "route_performance_diagnostic"/);
  assert.match(specification, /raw_duration_components: samples\.map/);
  for (const field of [
    "navigation_to_ready_ms",
    "client_bootstrap_ms",
    "network_server_critical_path_ms",
    "network_server_single_request_ms",
    "client_render_after_data_ms",
  ]) {
    assert.match(specification, new RegExp(field));
  }
  assert.ok(
    specification.indexOf("logRouteDiagnostic(summary, samples)") <
      specification.indexOf("toBeLessThan(READY_P95_LIMIT_MS)"),
  );
});

test("only a proven navigation-superseded auth abort is ignored", () => {
  assert.match(
    specification,
    /isSupersededNavigationAuthAbort\(record, records\)/,
  );
  assert.match(
    requestFailureClassifier,
    /request\.failureText !== "net::ERR_ABORTED"/,
  );
  assert.match(requestFailureClassifier, /request\.responseObserved \|\|/);
  assert.match(
    requestFailureClassifier,
    /candidate\.navigationSequence > request\.navigationSequence/,
  );
  assert.match(requestFailureClassifier, /candidate\.status >= 200/);
  assert.match(requestFailureClassifier, /candidate\.status < 300/);
  assert.match(requestFailureClassifierTest, /"an HTTP failure"/);
  assert.match(requestFailureClassifierTest, /"a different transport failure"/);
  assert.match(
    requestFailureClassifierTest,
    /"an abort without a successful successor"/,
  );
});

test("request evidence is content-free and AI providers cannot be invoked", () => {
  assert.match(specification, /createHash\("sha256"\)/);
  assert.match(specification, /raw_urls_retained:\s*false/);
  assert.match(specification, /request_bodies_retained:\s*false/);
  assert.match(specification, /credentials_retained:\s*false/);
  assert.match(specification, /student_content_retained:\s*false/);
  assert.match(specification, /ai_provider_calls:\s*0/);
  assert.match(
    specification,
    /url\.pathname\.startsWith\("\/functions\/v1\/"\)/,
  );
  assert.doesNotMatch(specification, /testInfo\.attach|response\.body\(/);
  assert.doesNotMatch(specification, /E2E_WRITING_SAMPLE|Submit Writing/);
});

test("the operator guide documents the exact artifact-free command", () => {
  assert.match(testingGuide, /Authenticated staging route performance/);
  assert.match(testingGuide, /E2E_PERFORMANCE=true/);
  assert.match(testingGuide, /pnpm run test:e2e:performance/);
  assert.match(testingGuide, /twenty measured warm samples per route/);
  assert.match(testingGuide, /does not call an Edge Function or AI provider/);
  assert.match(testingGuide, /not part of the normal `Verify` workflow/);
});
