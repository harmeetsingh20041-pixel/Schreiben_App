import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import {
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import { enterTeacherShellFromAdminLanding } from "./helpers/authenticated-role-navigation";
import {
  indexPerformanceAccountsByRole,
  type PerformanceRole,
} from "./performance-role-assignment";
import { isSupersededNavigationAuthAbort } from "./performance-request-failures";

type Credentials = { email: string; password: string };
type AppRole = PerformanceRole;

type RouteContract = {
  role: AppRole;
  route: string;
  label: string;
  heading: string | RegExp;
};

type DataApiRequest = {
  endpoint: string;
  fingerprint: string;
  startedAtMs: number;
  navigationSequence: number;
  finishedAtMs: number | null;
  responseObserved: boolean;
  status: number | null;
  failed: boolean;
  failureText: string | null;
};

type WarmSample = {
  navigationReadyMs: number;
  clientBootstrapMs: number;
  dataApiCriticalPathMs: number;
  maxDataApiRequestMs: number;
  clientRenderAfterDataMs: number;
  dataApiRequestCount: number;
  duplicateEquivalentRequests: number;
  duplicateEquivalentRequestsByEndpoint: Record<string, number>;
  endpointCounts: Record<string, number>;
};

type RouteEvidence = {
  role: AppRole;
  route: string;
  label: string;
  warm_sample_count: number;
  navigation_to_ready_p95_ms: number;
  client_bootstrap_p95_ms: number;
  network_server_critical_path_p95_ms: number;
  network_server_single_request_p95_ms: number;
  client_render_after_data_p95_ms: number;
  data_api_requests_per_sample_min: number;
  data_api_requests_per_sample_max: number;
  data_api_requests_per_sample_p95: number;
  reviewed_endpoint_counts_total: Record<string, number>;
  duplicate_equivalent_requests_total: number;
  reviewed_realtime_catchup_reads_total: number;
  unreviewed_duplicate_equivalent_requests_total: number;
};

// Twenty samples are the minimum at which nearest-rank p95 is not simply the
// single slowest observation. One excluded warm-up still precedes this set.
const WARM_SAMPLE_COUNT = 20;
const READY_P95_LIMIT_MS = 2_000;
const QUIET_WINDOW_MS = 75;
const QUIET_TIMEOUT_MS = 3_000;
const PINNED_STAGING_ORIGIN = "https://vzcgalzspdehmnvqczfw.supabase.co";
const diagnosticRouteLabel =
  process.env.E2E_PERFORMANCE_DIAGNOSTIC_ROUTE?.trim() || null;
const diagnosticCredentialSlot =
  process.env.E2E_PERFORMANCE_DIAGNOSTIC_SLOT?.trim() || null;

const ROUTES: readonly RouteContract[] = [
  {
    role: "teacher",
    route: "/teacher/dashboard",
    label: "teacher_overview",
    heading: "Teacher Overview",
  },
  {
    role: "teacher",
    route: "/teacher/batches",
    label: "teacher_classes",
    heading: "Classes",
  },
  {
    role: "teacher",
    route: "/teacher/students",
    label: "teacher_students",
    heading: "Students",
  },
  {
    role: "teacher",
    route: "/teacher/review-queue",
    label: "teacher_review_queue",
    heading: "Review Queue",
  },
  {
    role: "student",
    route: "/student/dashboard",
    label: "student_home",
    heading: /^Welcome back/,
  },
  {
    role: "student",
    route: "/student/questions",
    label: "student_write",
    heading: "Writing Tasks",
  },
  {
    role: "student",
    route: "/student/practice",
    label: "student_practice",
    heading: "Practice Center",
  },
  {
    role: "student",
    route: "/student/history",
    label: "student_history",
    heading: "My History",
  },
] as const;

const REVIEWED_DATA_API_ENDPOINTS = new Set([
  "rpc:get_auth_context",
  "rpc:get_onboarding_progress",
  "rpc:get_student_released_feedback_summary",
  "rpc:get_teacher_dashboard_summary",
  "rpc:list_feedback_review_queue_page",
  "rpc:list_my_batch_assignments",
  "rpc:list_my_batch_join_requests",
  "rpc:list_practice_review_queue_page",
  "rpc:list_student_assigned_questions_page",
  "rpc:list_student_grammar_stats_page",
  "rpc:list_student_practice_assignments_page",
  "rpc:list_student_submissions_page",
  "rpc:list_workspace_batch_options",
  "rpc:list_workspace_batches_page",
  "rpc:list_workspace_join_requests_filtered_page",
  "rpc:list_workspace_students_filtered_page",
  "rpc:list_workspace_submissions_page",
]);

test.skip(
  process.env.E2E_PERFORMANCE !== "true",
  "Set E2E_PERFORMANCE=true only for the isolated staging performance run.",
);

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the performance run.`);
  return value;
}

function diagnosticRunConfiguration() {
  if (!diagnosticRouteLabel && !diagnosticCredentialSlot) return null;
  if (!diagnosticRouteLabel || !diagnosticCredentialSlot) {
    throw new Error(
      "A performance diagnostic requires both an exact route label and credential slot.",
    );
  }
  if (
    diagnosticCredentialSlot !== "TEACHER" &&
    diagnosticCredentialSlot !== "STUDENT"
  ) {
    throw new Error(
      "The performance diagnostic credential slot must be TEACHER or STUDENT.",
    );
  }
  const route = ROUTES.find(
    (candidate) => candidate.label === diagnosticRouteLabel,
  );
  if (!route) {
    throw new Error("The performance diagnostic route label is not reviewed.");
  }
  return { route, slot: diagnosticCredentialSlot } as const;
}

function credentials(role: "TEACHER" | "STUDENT"): Credentials {
  return {
    email: requiredEnvironment(`E2E_${role}_EMAIL`),
    password: requiredEnvironment(`E2E_${role}_PASSWORD`),
  };
}

function nearestRankP95(values: number[]) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

function dataApiEndpoint(request: Request) {
  const url = new URL(request.url());
  if (url.origin !== PINNED_STAGING_ORIGIN) return null;
  if (!url.pathname.startsWith("/rest/v1/")) return null;
  if (request.method() === "OPTIONS") return null;
  const suffix = url.pathname.slice("/rest/v1/".length);
  if (suffix.startsWith("rpc/")) {
    return `rpc:${suffix.slice("rpc/".length)}`;
  }
  return `relation:${suffix}`;
}

function equivalentRequestFingerprint(request: Request) {
  const url = new URL(request.url());
  return createHash("sha256")
    .update(request.method())
    .update("\0")
    .update(url.pathname)
    .update("\0")
    .update(url.search)
    .update("\0")
    .update(request.postData() ?? "")
    .digest("hex");
}

class DataApiCollector {
  private readonly requests = new Map<Request, DataApiRequest>();
  private readonly responseTasks: Promise<void>[] = [];
  private lastActivityAtMs = performance.now();
  private navigationSequence = 0;

  private readonly onFrameNavigated = (frame: Frame) => {
    if (frame === this.page.mainFrame()) this.navigationSequence += 1;
  };

  private readonly onRequest = (request: Request) => {
    const endpoint = dataApiEndpoint(request);
    if (!endpoint) return;
    this.lastActivityAtMs = performance.now();
    this.requests.set(request, {
      endpoint,
      fingerprint: equivalentRequestFingerprint(request),
      startedAtMs: this.lastActivityAtMs,
      navigationSequence: this.navigationSequence,
      finishedAtMs: null,
      responseObserved: false,
      status: null,
      failed: false,
      failureText: null,
    });
  };

  private readonly onResponse = (response: Response) => {
    const request = response.request();
    const record = this.requests.get(request);
    if (!record) return;
    record.responseObserved = true;
    record.status = response.status();
    const task = (async () => {
      const transferError = await response.finished();
      record.finishedAtMs = performance.now();
      record.failed =
        record.failed || transferError !== null || response.status() >= 400;
      if (transferError !== null && record.failureText === null) {
        record.failureText = "response_transfer_failed";
      }
      this.lastActivityAtMs = record.finishedAtMs;
    })();
    this.responseTasks.push(task);
  };

  private readonly onRequestFailed = (request: Request) => {
    const record = this.requests.get(request);
    if (!record) return;
    record.finishedAtMs = performance.now();
    record.failed = true;
    record.failureText = request.failure()?.errorText ?? "request_failed";
    this.lastActivityAtMs = record.finishedAtMs;
  };

  constructor(private readonly page: Page) {
    page.on("framenavigated", this.onFrameNavigated);
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfailed", this.onRequestFailed);
  }

  async waitForQuiescence() {
    const deadline = performance.now() + QUIET_TIMEOUT_MS;
    while (performance.now() < deadline) {
      await Promise.allSettled(this.responseTasks);
      const pending = [...this.requests.values()].some(
        (request) => request.finishedAtMs === null,
      );
      if (
        !pending &&
        performance.now() - this.lastActivityAtMs >= QUIET_WINDOW_MS
      ) {
        return;
      }
      await sleep(20);
    }
    throw new Error("Data API requests did not reach a bounded quiet state.");
  }

  stop() {
    this.page.off("framenavigated", this.onFrameNavigated);
    this.page.off("request", this.onRequest);
    this.page.off("response", this.onResponse);
    this.page.off("requestfailed", this.onRequestFailed);
  }

  sample(navigationStartedAtMs: number, readyAtMs: number): WarmSample {
    const records = [...this.requests.values()];
    const ignoredRequests = new Set(
      records.filter((record) =>
        isSupersededNavigationAuthAbort(record, records),
      ),
    );
    const consideredRecords = records.filter(
      (record) => !ignoredRequests.has(record),
    );
    const failures = consideredRecords.filter((record) => record.failed);
    if (failures.length > 0) {
      throw new Error(
        `Reviewed Data API request failed: ${failures
          .map(
            (record) =>
              `${record.endpoint}:${record.status ?? "request_failed"}`,
          )
          .join(",")}`,
      );
    }
    const unreviewed = [
      ...new Set(consideredRecords.map((record) => record.endpoint)),
    ].filter((endpoint) => !REVIEWED_DATA_API_ENDPOINTS.has(endpoint));
    if (unreviewed.length > 0) {
      throw new Error(
        `Unreviewed Data API endpoint observed: ${unreviewed.join(",")}`,
      );
    }
    const complete = consideredRecords.filter(
      (record): record is DataApiRequest & { finishedAtMs: number } =>
        record.finishedAtMs !== null,
    );
    const fingerprintCounts = new Map<
      string,
      { count: number; endpoint: string }
    >();
    const endpointCounts: Record<string, number> = {};
    for (const record of complete) {
      const currentFingerprint = fingerprintCounts.get(record.fingerprint);
      fingerprintCounts.set(record.fingerprint, {
        count: (currentFingerprint?.count ?? 0) + 1,
        endpoint: record.endpoint,
      });
      endpointCounts[record.endpoint] =
        (endpointCounts[record.endpoint] ?? 0) + 1;
    }
    const duplicateEquivalentRequestsByEndpoint: Record<string, number> = {};
    for (const { count, endpoint } of fingerprintCounts.values()) {
      const duplicates = Math.max(0, count - 1);
      if (duplicates > 0) {
        duplicateEquivalentRequestsByEndpoint[endpoint] =
          (duplicateEquivalentRequestsByEndpoint[endpoint] ?? 0) + duplicates;
      }
    }
    const duplicateEquivalentRequests = Object.values(
      duplicateEquivalentRequestsByEndpoint,
    ).reduce((count, duplicates) => count + duplicates, 0);
    const firstRequestAtMs =
      complete.length > 0
        ? Math.min(...complete.map((record) => record.startedAtMs))
        : readyAtMs;
    const lastResponseAtMs =
      complete.length > 0
        ? Math.max(...complete.map((record) => record.finishedAtMs))
        : readyAtMs;
    const requestDurations = complete.map(
      (record) => record.finishedAtMs - record.startedAtMs,
    );

    return {
      navigationReadyMs: readyAtMs - navigationStartedAtMs,
      clientBootstrapMs: Math.max(0, firstRequestAtMs - navigationStartedAtMs),
      dataApiCriticalPathMs:
        complete.length > 0
          ? Math.max(0, lastResponseAtMs - firstRequestAtMs)
          : 0,
      maxDataApiRequestMs: Math.max(0, ...requestDurations),
      clientRenderAfterDataMs: Math.max(0, readyAtMs - lastResponseAtMs),
      dataApiRequestCount: complete.length,
      duplicateEquivalentRequests,
      duplicateEquivalentRequestsByEndpoint,
      endpointCounts,
    };
  }
}

function matchesRpc(response: Response, functionName: string) {
  const url = new URL(response.url());
  return (
    url.origin === PINNED_STAGING_ORIGIN &&
    response.request().method() === "POST" &&
    url.pathname.endsWith(`/rest/v1/rpc/${functionName}`)
  );
}

function trustedServerRole(
  value: unknown,
): AppRole | "teacher-onboarding" | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, unknown>;
  if (
    typeof row.teacher_entitled !== "boolean" ||
    typeof row.can_create_teacher_workspace !== "boolean" ||
    !Array.isArray(row.memberships)
  ) {
    return null;
  }
  const memberships = row.memberships.flatMap((membership) => {
    if (!membership || typeof membership !== "object") return [];
    const record = membership as Record<string, unknown>;
    if (
      typeof record.membership_id !== "string" ||
      typeof record.workspace_id !== "string" ||
      !["owner", "teacher", "student"].includes(String(record.role))
    ) {
      return [];
    }
    return [
      {
        membershipId: record.membership_id,
        workspaceId: record.workspace_id,
        role: record.role as "owner" | AppRole,
      },
    ];
  });
  if (memberships.length !== row.memberships.length) return null;
  const hasTeacherMembership = memberships.some(
    (membership) =>
      membership.role === "owner" || membership.role === "teacher",
  );
  if (row.can_create_teacher_workspace && !hasTeacherMembership) {
    return "teacher-onboarding";
  }
  const rank = { owner: 0, teacher: 1, student: 2 } as const;
  const activeMembership = [...memberships].sort((left, right) => {
    const rankDifference = rank[left.role] - rank[right.role];
    if (rankDifference !== 0) return rankDifference;
    const workspaceDifference = left.workspaceId.localeCompare(
      right.workspaceId,
    );
    return (
      workspaceDifference || left.membershipId.localeCompare(right.membershipId)
    );
  })[0];
  if (activeMembership) {
    return activeMembership.role === "student" ? "student" : "teacher";
  }
  return row.teacher_entitled ? "teacher" : "student";
}

async function signInAndDetectRole(page: Page, account: Credentials) {
  await page.goto("/");
  await fillPrivately(page.getByLabel("Email"), account.email);
  await fillPrivately(page.getByLabel("Password"), account.password);
  try {
    await page.getByRole("button", { name: "Sign in with Email" }).click();
  } catch {
    throw new Error("A performance account could not be signed in safely.");
  }
  await enterTeacherShellFromAdminLanding(page);

  // A platform administrator first receives an AAL1 auth-context response,
  // then reaches AAL2 through the runtime-only authenticator challenge. Verify
  // the routed shell against a fresh post-challenge response, not the earlier
  // deliberately restricted AAL1 snapshot.
  const authContextResponsePromise = page.waitForResponse(
    (response) => matchesRpc(response, "get_auth_context"),
    { timeout: 15_000 },
  );
  await page.reload({ waitUntil: "domcontentloaded" });

  const teacherOverview = page.getByRole("heading", {
    name: "Teacher Overview",
    level: 1,
  });
  const teacherOnboarding = page.getByText("Set Up Your Workspace", {
    exact: true,
  });
  const studentOverview = page.getByRole("heading", {
    name: /^Welcome back,/,
    level: 1,
  });
  await expect
    .poll(
      async () => {
        if (await teacherOverview.isVisible()) return "teacher";
        if (await teacherOnboarding.isVisible()) return "teacher-onboarding";
        if (await studentOverview.isVisible()) return "student";
        return "unknown";
      },
      { timeout: 15_000 },
    )
    .not.toBe("unknown");
  const routedRole: AppRole | "teacher-onboarding" =
    (await teacherOnboarding.isVisible())
      ? "teacher-onboarding"
      : (await teacherOverview.isVisible())
        ? "teacher"
        : "student";
  const authContextResponse = await authContextResponsePromise;
  if (!authContextResponse.ok()) {
    throw new Error("The trusted auth context could not be verified.");
  }
  let authContext: unknown;
  try {
    authContext = await authContextResponse.json();
  } catch {
    throw new Error("The trusted auth context was not valid JSON.");
  }
  if (trustedServerRole(authContext) !== routedRole) {
    throw new Error(
      "The trusted auth context did not authorize the detected application shell.",
    );
  }
  if (routedRole === "teacher-onboarding") {
    throw new Error("The performance teacher requires an existing workspace.");
  }
  return routedRole;
}

async function fillPrivately(field: Locator, value: string) {
  try {
    await field.fill(value);
  } catch {
    throw new Error(
      "A private performance credential field could not be filled.",
    );
  }
}

function monitorBrowserSafety(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror:${error.name}`));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin === PINNED_STAGING_ORIGIN &&
      url.pathname.startsWith("/functions/v1/")
    ) {
      failures.push(
        `edge_function:${url.pathname.slice("/functions/v1/".length)}`,
      );
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(
        `http:${response.status()}:${response.request().resourceType()}`,
      );
    }
  });
  return () => {
    expect(failures, failures.join("\n")).toEqual([]);
  };
}

async function waitForRouteReady(page: Page, contract: RouteContract) {
  await expect(page).toHaveURL(new RegExp(`${contract.route}$`));
  await expect(
    page.getByRole("heading", { name: contract.heading, level: 1 }),
  ).toBeVisible();
  await page.waitForFunction(() => {
    const loadingStatus = [
      ...document.querySelectorAll('[role="status"]'),
    ].some((element) => /^\s*Loading\b/i.test(element.textContent ?? ""));
    const busy = document.querySelector('[aria-busy="true"]') !== null;
    return !loadingStatus && !busy;
  });
}

async function measureRoute(page: Page, contract: RouteContract) {
  const collector = new DataApiCollector(page);
  const navigationStartedAtMs = performance.now();
  try {
    await page.goto(contract.route, { waitUntil: "domcontentloaded" });
    await waitForRouteReady(page, contract);
    await collector.waitForQuiescence();
    const readyAtMs = performance.now();
    return collector.sample(navigationStartedAtMs, readyAtMs);
  } finally {
    collector.stop();
  }
}

function summarizeRoute(contract: RouteContract, samples: WarmSample[]) {
  const endpointCounts: Record<string, number> = {};
  for (const sample of samples) {
    for (const [endpoint, count] of Object.entries(sample.endpointCounts)) {
      endpointCounts[endpoint] = (endpointCounts[endpoint] ?? 0) + count;
    }
  }
  const requestCounts = samples.map((sample) => sample.dataApiRequestCount);
  const duplicateEquivalentRequestsTotal = samples.reduce(
    (count, sample) => count + sample.duplicateEquivalentRequests,
    0,
  );
  // The Practice Realtime subscription deliberately performs one race-closing
  // grammar-stat read after SUBSCRIBED. It prevents a released writing from
  // being missed between the initial query and subscription acknowledgement.
  // Treat at most one exact duplicate per navigation as reviewed; every other
  // duplicate remains a hard performance failure.
  const reviewedRealtimeCatchupReadsTotal =
    contract.label === "student_practice"
      ? samples.reduce(
          (count, sample) =>
            count +
            Math.min(
              1,
              sample.duplicateEquivalentRequestsByEndpoint[
                "rpc:list_student_grammar_stats_page"
              ] ?? 0,
            ),
          0,
        )
      : 0;
  const evidence: RouteEvidence = {
    role: contract.role,
    route: contract.route,
    label: contract.label,
    warm_sample_count: samples.length,
    navigation_to_ready_p95_ms: rounded(
      nearestRankP95(samples.map((sample) => sample.navigationReadyMs)),
    ),
    client_bootstrap_p95_ms: rounded(
      nearestRankP95(samples.map((sample) => sample.clientBootstrapMs)),
    ),
    network_server_critical_path_p95_ms: rounded(
      nearestRankP95(samples.map((sample) => sample.dataApiCriticalPathMs)),
    ),
    network_server_single_request_p95_ms: rounded(
      nearestRankP95(samples.map((sample) => sample.maxDataApiRequestMs)),
    ),
    client_render_after_data_p95_ms: rounded(
      nearestRankP95(samples.map((sample) => sample.clientRenderAfterDataMs)),
    ),
    data_api_requests_per_sample_min: Math.min(...requestCounts),
    data_api_requests_per_sample_max: Math.max(...requestCounts),
    data_api_requests_per_sample_p95: nearestRankP95(requestCounts),
    reviewed_endpoint_counts_total: Object.fromEntries(
      Object.entries(endpointCounts).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    duplicate_equivalent_requests_total: duplicateEquivalentRequestsTotal,
    reviewed_realtime_catchup_reads_total: reviewedRealtimeCatchupReadsTotal,
    unreviewed_duplicate_equivalent_requests_total:
      duplicateEquivalentRequestsTotal - reviewedRealtimeCatchupReadsTotal,
  };
  return evidence;
}

function logRouteDiagnostic(summary: RouteEvidence, samples: WarmSample[]) {
  console.log(
    JSON.stringify(
      {
        schema_version: 1,
        kind: "route_performance_diagnostic",
        environment: "linked_staging",
        route_label: summary.label,
        role: summary.role,
        summary,
        raw_duration_components: samples.map((sample, index) => ({
          sample_number: index + 1,
          navigation_to_ready_ms: rounded(sample.navigationReadyMs),
          client_bootstrap_ms: rounded(sample.clientBootstrapMs),
          network_server_critical_path_ms: rounded(
            sample.dataApiCriticalPathMs,
          ),
          network_server_single_request_ms: rounded(sample.maxDataApiRequestMs),
          client_render_after_data_ms: rounded(sample.clientRenderAfterDataMs),
        })),
        raw_urls_retained: false,
        request_bodies_retained: false,
        credentials_retained: false,
        student_content_retained: false,
      },
      null,
      2,
    ),
  );
}

test.describe("authenticated staging route performance", () => {
  test.use({ viewport: { width: 1366, height: 768 } });
  test.setTimeout(600_000);

  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
    expect(requiredEnvironment("E2E_PERFORMANCE")).toBe("true");
    expect(requiredEnvironment("VITE_SUPABASE_URL").replace(/\/$/, "")).toBe(
      PINNED_STAGING_ORIGIN,
    );
    diagnosticRunConfiguration();
  });

  test("all dashboard and list routes stay below the warm p95 gate without duplicate reads", async ({
    browser,
  }) => {
    const evidence: RouteEvidence[] = [];
    const contexts: BrowserContext[] = [];
    try {
      const diagnostic = diagnosticRunConfiguration();
      const detectedAccounts = [];
      const credentialSlots = diagnostic
        ? ([diagnostic.slot] as const)
        : (["TEACHER", "STUDENT"] as const);
      for (const slot of credentialSlots) {
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        const assertBrowserSafe = monitorBrowserSafety(page);
        const role = await signInAndDetectRole(page, credentials(slot));
        detectedAccounts.push({
          role,
          value: { page, assertBrowserSafe },
        });
      }
      const accountsToMeasure = diagnostic
        ? (() => {
            const detected = detectedAccounts[0];
            if (!detected || detected.role !== diagnostic.route.role) {
              throw new Error(
                "The diagnostic credential did not match the reviewed route role.",
              );
            }
            return [{ role: detected.role, ...detected.value }];
          })()
        : (() => {
            const accountsByRole =
              indexPerformanceAccountsByRole(detectedAccounts);
            return (["teacher", "student"] as const).map((role) => ({
              role,
              ...accountsByRole[role],
            }));
          })();

      for (const { role, page, assertBrowserSafe } of accountsToMeasure) {
        const routes = diagnostic
          ? [diagnostic.route]
          : ROUTES.filter((item) => item.role === role);
        for (const route of routes) {
          await measureRoute(page, route); // excluded warm-up
          const samples: WarmSample[] = [];
          for (let sample = 0; sample < WARM_SAMPLE_COUNT; sample += 1) {
            samples.push(await measureRoute(page, route));
          }
          const summary = summarizeRoute(route, samples);
          logRouteDiagnostic(summary, samples);
          expect(
            summary.unreviewed_duplicate_equivalent_requests_total,
            `${route.label} issued unreviewed duplicate equivalent Data API reads`,
          ).toBe(0);
          expect(
            summary.navigation_to_ready_p95_ms,
            `${route.label} warm navigation-to-ready p95 must stay below 2 seconds`,
          ).toBeLessThan(READY_P95_LIMIT_MS);
          evidence.push(summary);
        }
        assertBrowserSafe();
      }
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }

    console.log(
      JSON.stringify(
        {
          schema_version: 1,
          environment: "linked_staging",
          measurement: diagnosticRunConfiguration()
            ? "diagnostic_warm_full_navigation"
            : "warm_full_navigation",
          sample_count_per_route: WARM_SAMPLE_COUNT,
          readiness_p95_limit_ms: READY_P95_LIMIT_MS,
          network_server_definition:
            "browser request start through complete Data API response transfer",
          client_render_definition:
            "last complete Data API response through loading-free visible route",
          raw_urls_retained: false,
          request_bodies_retained: false,
          credentials_retained: false,
          ai_provider_calls: 0,
          routes: evidence,
        },
        null,
        2,
      ),
    );
  });
});
