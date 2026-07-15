import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Response,
  type WebSocketRoute,
} from "@playwright/test";

type Credentials = { email: string; password: string };
type AccountRole = "teacher" | "student";
type FixtureStatus = "processing" | "needs_review" | "failed";

interface SubmissionRealtimeFixture {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  teacherMembershipId: string;
  studentMembershipId: string;
  batchId: string;
  batchStudentId: string;
  submissionId: string;
  feedbackDraftId: string;
}

interface RealtimeDropController {
  arm: () => void;
  routedCount: () => number;
  droppedCount: () => number;
}

interface SubmissionDetailStateObserver {
  dispose: () => void;
  nonMatchingCount: () => number;
  waitForMatch: (timeout: number) => Promise<unknown>;
}

const PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw";
const ORIGINAL_TEXT = "X";
const PRIVATE_SUMMARY = "Provider-free private regression summary.";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the submission live regression.`);
  }
  return value;
}

function configuredCredentials(role: "TEACHER" | "STUDENT"): Credentials {
  return {
    email: requiredEnvironment(`E2E_${role}_EMAIL`),
    password: requiredEnvironment(`E2E_${role}_PASSWORD`),
  };
}

function requireUuid(value: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("The submission live fixture received an invalid UUID.");
  }
  return value;
}

function sqlUuid(value: string) {
  return `'${requireUuid(value)}'::uuid`;
}

function sqlLiteral(value: string) {
  if (/\u0000|[\r\n]/u.test(value)) {
    throw new Error("The submission live fixture received an invalid value.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function newFixture(): SubmissionRealtimeFixture {
  const workspaceId = randomUUID();
  const suffix = workspaceId.slice(0, 8);
  return {
    workspaceId,
    workspaceName: `V1 submission live ${suffix}`,
    workspaceSlug: `e2e-submission-live-${workspaceId}`,
    teacherMembershipId: randomUUID(),
    studentMembershipId: randomUUID(),
    batchId: randomUUID(),
    batchStudentId: randomUUID(),
    submissionId: randomUUID(),
    feedbackDraftId: randomUUID(),
  };
}

function repositoryRoot() {
  return resolve(process.cwd(), "../..");
}

function assertPinnedLinkedStaging() {
  let linkedProjectRef = "";
  try {
    linkedProjectRef = readFileSync(
      resolve(repositoryRoot(), "supabase/.temp/project-ref"),
      "utf8",
    ).trim();
  } catch {
    throw new Error("The submission live regression could not verify staging.");
  }
  if (linkedProjectRef !== PINNED_STAGING_PROJECT_REF) {
    throw new Error(
      "The submission live regression is not linked to pinned staging.",
    );
  }
}

async function runPrivateLinkedSql(sql: string, operation: string) {
  assertPinnedLinkedStaging();
  const executable = requiredEnvironment("E2E_SUPABASE_BIN");
  if (!isAbsolute(executable)) {
    throw new Error("E2E_SUPABASE_BIN must be an absolute path.");
  }
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("E2E_TEACHER_") && !name.startsWith("E2E_STUDENT_"),
    ),
  ) as NodeJS.ProcessEnv;

  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(
      executable,
      ["db", "query", "--linked", "--file", "/dev/stdin"],
      {
        cwd: repositoryRoot(),
        env: childEnvironment,
        // Fixture SQL is accepted only over stdin. Database output is never
        // retained in Playwright results or copied into an exception.
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) rejectRun(error);
      else resolveRun();
    };
    child.once("error", () => {
      settle(new Error(`The ${operation} database command could not start.`));
    });
    child.once("close", (code) => {
      if (code === 0) settle();
      else {
        settle(
          new Error(
            `The ${operation} database command failed with exit code ${code ?? "unknown"}.`,
          ),
        );
      }
    });
    child.stdin.once("error", () => {
      settle(new Error(`The ${operation} database input failed.`));
    });
    child.stdin.end(sql);
  });
}

function installFixtureSql(
  fixture: SubmissionRealtimeFixture,
  teacher: Credentials,
  student: Credentials,
) {
  return `
begin;
do $write_016_fixture$
declare
  teacher_id uuid;
  student_id uuid;
begin
  if (
    select count(*) from public.profiles profile
    where lower(profile.email) = lower(${sqlLiteral(teacher.email)})
  ) <> 1 or (
    select count(*) from public.profiles profile
    where lower(profile.email) = lower(${sqlLiteral(student.email)})
  ) <> 1 then
    raise exception using message = 'write_016_fixture_accounts_invalid';
  end if;

  select profile.id into teacher_id
  from public.profiles profile
  where lower(profile.email) = lower(${sqlLiteral(teacher.email)});

  select profile.id into student_id
  from public.profiles profile
  where lower(profile.email) = lower(${sqlLiteral(student.email)});

  if teacher_id = student_id then
    raise exception using message = 'write_016_fixture_accounts_not_distinct';
  end if;

  insert into public.workspaces (id, name, slug, owner_id)
  values (
    ${sqlUuid(fixture.workspaceId)},
    ${sqlLiteral(fixture.workspaceName)},
    ${sqlLiteral(fixture.workspaceSlug)},
    teacher_id
  );

  insert into public.workspace_members (id, workspace_id, user_id, role)
  values
    (
      ${sqlUuid(fixture.teacherMembershipId)},
      ${sqlUuid(fixture.workspaceId)},
      teacher_id,
      'teacher'
    ),
    (
      ${sqlUuid(fixture.studentMembershipId)},
      ${sqlUuid(fixture.workspaceId)},
      student_id,
      'student'
    );

  insert into public.batches (
    id,
    workspace_id,
    name,
    level,
    created_by,
    feedback_mode,
    join_requires_approval
  ) values (
    ${sqlUuid(fixture.batchId)},
    ${sqlUuid(fixture.workspaceId)},
    'WRITE-016 provider-free class',
    'A1',
    teacher_id,
    'teacher_review_only',
    true
  );

  insert into public.batch_students (
    id,
    batch_id,
    student_id,
    workspace_id
  ) values (
    ${sqlUuid(fixture.batchStudentId)},
    ${sqlUuid(fixture.batchId)},
    student_id,
    ${sqlUuid(fixture.workspaceId)}
  );

  insert into public.submissions (
    id,
    workspace_id,
    student_id,
    batch_id,
    question_source,
    mode,
    original_text,
    status,
    evaluation_status,
    release_status,
    feedback_mode,
    evaluation_version
  ) values (
    ${sqlUuid(fixture.submissionId)},
    ${sqlUuid(fixture.workspaceId)},
    student_id,
    ${sqlUuid(fixture.batchId)},
    'free_text',
    'free_text',
    ${sqlLiteral(ORIGINAL_TEXT)},
    'checking',
    'processing',
    'held',
    'teacher_review_only',
    1
  );

  insert into app_private.feedback_drafts (
    id,
    submission_id,
    version,
    state,
    content,
    provider_model,
    revision
  ) values (
    ${sqlUuid(fixture.feedbackDraftId)},
    ${sqlUuid(fixture.submissionId)},
    1,
    'needs_review',
    jsonb_build_object(
      'corrected_text', ${sqlLiteral(ORIGINAL_TEXT)},
      'overall_summary', ${sqlLiteral(PRIVATE_SUMMARY)},
      'level_detected', 'A1',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'line_number', 1,
          'source_start', 0,
          'source_end', 1,
          'original_line', ${sqlLiteral(ORIGINAL_TEXT)},
          'corrected_line', ${sqlLiteral(ORIGINAL_TEXT)},
          'status', 'correct',
          'changed_parts', '[]'::jsonb,
          'short_explanation', '',
          'detailed_explanation', '',
          'grammar_topic', ''
        )
      ),
      'grammar_topics', '[]'::jsonb,
      'score_summary', jsonb_build_object(
        'correct_lines', 1,
        'acceptable_lines', 0,
        'minor_issues', 0,
        'major_issues', 0,
        'needs_review', 0
      )
    ),
    'non_ai_regression_fixture',
    1
  );

  if not exists (
    select 1 from api.submission_status_events event
    where event.id = ${sqlUuid(fixture.submissionId)}
      and event.workspace_id = ${sqlUuid(fixture.workspaceId)}
      and event.evaluation_status = 'processing'
      and event.release_status = 'held'
  ) or exists (
    select 1 from app_private.async_jobs job
    where job.entity_id = ${sqlUuid(fixture.submissionId)}
  ) or exists (
    select 1 from public.submission_lines line
    where line.submission_id = ${sqlUuid(fixture.submissionId)}
  ) or exists (
    select 1 from public.submission_grammar_topics topic
    where topic.submission_id = ${sqlUuid(fixture.submissionId)}
  ) then
    raise exception using message = 'write_016_fixture_not_isolated';
  end if;
end;
$write_016_fixture$;
commit;
`;
}

function transitionFixtureSql(
  fixture: SubmissionRealtimeFixture,
  status: FixtureStatus,
) {
  const values =
    status === "processing"
      ? { submission: "checking", evaluation: "processing", error: "null" }
      : status === "needs_review"
        ? {
            submission: "needs_review",
            evaluation: "needs_review",
            error: "null",
          }
        : {
            submission: "failed",
            evaluation: "failed",
            error: "'feedback_failed'",
          };
  return `
begin;
do $write_016_transition$
declare
  changed_rows integer;
begin
  update public.submissions submission
  set status = '${values.submission}',
      evaluation_status = '${values.evaluation}',
      feedback_error = ${values.error},
      updated_at = clock_timestamp()
  where submission.id = ${sqlUuid(fixture.submissionId)}
    and submission.workspace_id = ${sqlUuid(fixture.workspaceId)}
    and submission.batch_id = ${sqlUuid(fixture.batchId)}
    and submission.release_status = 'held'
    and submission.original_text = ${sqlLiteral(ORIGINAL_TEXT)};

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using message = 'write_016_transition_scope_changed';
  end if;

  if not exists (
    select 1 from api.submission_status_events event
    where event.id = ${sqlUuid(fixture.submissionId)}
      and event.workspace_id = ${sqlUuid(fixture.workspaceId)}
      and event.evaluation_status = '${values.evaluation}'
      and event.release_status = 'held'
  ) then
    raise exception using message = 'write_016_status_feed_not_updated';
  end if;
end;
$write_016_transition$;
commit;
`;
}

function cleanupFixtureSql(fixture: SubmissionRealtimeFixture) {
  return `
begin;
do $write_016_cleanup$
declare
  matching_workspace public.workspaces%rowtype;
begin
  select workspace.* into matching_workspace
  from public.workspaces workspace
  where workspace.id = ${sqlUuid(fixture.workspaceId)};

  if found and (
    matching_workspace.name <> ${sqlLiteral(fixture.workspaceName)}
    or matching_workspace.slug <> ${sqlLiteral(fixture.workspaceSlug)}
  ) then
    raise exception using message = 'write_016_cleanup_scope_changed';
  end if;

  delete from public.submissions submission
  where submission.id = ${sqlUuid(fixture.submissionId)}
    and submission.workspace_id = ${sqlUuid(fixture.workspaceId)}
    and submission.batch_id = ${sqlUuid(fixture.batchId)}
    and submission.original_text = ${sqlLiteral(ORIGINAL_TEXT)};

  delete from public.workspaces workspace
  where workspace.id = ${sqlUuid(fixture.workspaceId)}
    and workspace.name = ${sqlLiteral(fixture.workspaceName)}
    and workspace.slug = ${sqlLiteral(fixture.workspaceSlug)};

  if exists (
    select 1 from public.submissions submission
    where submission.id = ${sqlUuid(fixture.submissionId)}
  ) or exists (
    select 1 from app_private.feedback_drafts draft
    where draft.id = ${sqlUuid(fixture.feedbackDraftId)}
      or draft.submission_id = ${sqlUuid(fixture.submissionId)}
  ) or exists (
    select 1 from api.submission_status_events event
    where event.id = ${sqlUuid(fixture.submissionId)}
  ) or exists (
    select 1 from app_private.async_jobs job
    where job.entity_id = ${sqlUuid(fixture.submissionId)}
  ) or exists (
    select 1 from public.batch_students assignment
    where assignment.id = ${sqlUuid(fixture.batchStudentId)}
  ) or exists (
    select 1 from public.batches batch
    where batch.id = ${sqlUuid(fixture.batchId)}
  ) or exists (
    select 1 from public.workspace_members membership
    where membership.id in (
      ${sqlUuid(fixture.teacherMembershipId)},
      ${sqlUuid(fixture.studentMembershipId)}
    )
  ) or exists (
    select 1 from public.workspaces workspace
    where workspace.id = ${sqlUuid(fixture.workspaceId)}
  ) then
    raise exception using message = 'write_016_cleanup_residue';
  end if;
end;
$write_016_cleanup$;
commit;
`;
}

async function safeGoto(page: Page, path: string) {
  try {
    await page.goto(path);
  } catch {
    throw new Error("A protected submission navigation did not complete.");
  }
}

async function fillPrivately(locator: Locator, value: string) {
  try {
    await locator.fill(value);
  } catch {
    throw new Error("A protected sign-in field could not be filled.");
  }
}

async function signIn(page: Page, account: Credentials) {
  await safeGoto(page, "/");

  // Regression: a membership preference written before authentication is
  // intentionally cleared by the no-session bootstrap. Never use that value
  // to decide which role the credentialed workflow received after sign-in.
  await page.evaluate(() => {
    window.localStorage.setItem(
      "gwc_active_membership_id",
      "pre-login-preference-is-not-authoritative",
    );
  });
  await page.reload();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.localStorage.getItem("gwc_active_membership_id"),
        ),
      { timeout: 10_000 },
    )
    .toBeNull();

  await fillPrivately(page.getByLabel("Email"), account.email);
  await fillPrivately(page.getByLabel("Password"), account.password);
  const authContextResponse = waitForAuthContext(page);
  await page.getByRole("button", { name: "Sign in with Email" }).click();
  await authContextResponse;
  await expect(page).toHaveURL(
    /\/(?:teacher\/(?:dashboard|onboarding)|student\/dashboard)$/,
    { timeout: 15_000 },
  );
}

async function waitForAuthContext(page: Page) {
  let response: Response;
  try {
    response = await page.waitForResponse(
      (candidate) => matchesRpc(candidate, "get_auth_context"),
      { timeout: 15_000 },
    );
  } catch {
    throw new Error("The trusted browser auth context was not observed.");
  }
  if (response.status() >= 400) {
    throw new Error("The trusted browser auth context failed safely.");
  }
  return parseDetailResponse(response);
}

function assertFixtureMembership(
  payload: unknown,
  fixture: SubmissionRealtimeFixture,
  role: AccountRole,
  membershipId: string,
) {
  const row = Array.isArray(payload) ? recordValue(payload[0]) : null;
  const memberships = Array.isArray(row?.memberships) ? row.memberships : [];
  const found = memberships.some((candidate) => {
    const membership = recordValue(candidate);
    return (
      membership?.membership_id === membershipId &&
      membership.workspace_id === fixture.workspaceId &&
      membership.workspace_name === fixture.workspaceName &&
      membership.role === role
    );
  });
  if (!found) {
    throw new Error(
      "The trusted auth context did not contain the exact fixture membership.",
    );
  }
}

function visibleWorkspaceSelector(page: Page) {
  return page.getByLabel("Active workspace and role").filter({ visible: true });
}

async function selectFixtureMembership(
  page: Page,
  fixture: SubmissionRealtimeFixture,
  role: AccountRole,
  membershipId: string,
  verifyCurrentSelection: boolean,
) {
  const selector = visibleWorkspaceSelector(page);
  await expect(selector).toHaveCount(1, { timeout: 15_000 });
  const expectedLabel = `${fixture.workspaceName} · ${role}`;
  const storedMembershipBeforeSelection = await page.evaluate(() =>
    window.localStorage.getItem("gwc_active_membership_id"),
  );
  const selectorLabelBeforeSelection = (await selector.textContent())
    ?.replace(/\s+/gu, " ")
    .trim();
  await selector.click();
  const option = page.getByRole("option", {
    name: expectedLabel,
    exact: true,
  });
  await expect(option).toHaveCount(1);
  const alreadySelected =
    (await option.getAttribute("data-state")) === "checked" ||
    (storedMembershipBeforeSelection === membershipId &&
      selectorLabelBeforeSelection === expectedLabel);

  let selectedAuthContext: Promise<unknown>;
  if (alreadySelected) {
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.localStorage.getItem("gwc_active_membership_id"),
          ),
        { timeout: 10_000 },
      )
      .toBe(membershipId);
    selectedAuthContext = waitForAuthContext(page);
    await page.reload();
  } else {
    selectedAuthContext = waitForAuthContext(page);
    await option.click();
  }
  assertFixtureMembership(
    await selectedAuthContext,
    fixture,
    role,
    membershipId,
  );
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.localStorage.getItem("gwc_active_membership_id"),
        ),
      { timeout: 15_000 },
    )
    .toBe(membershipId);

  // Exercise the already-current path deterministically on the first browser
  // pass even when the random fixture was not the login-time default. A normal
  // reload must refresh trusted context; clicking the selected option is a
  // Radix no-op and is deliberately never used as the refresh trigger.
  if (verifyCurrentSelection && !alreadySelected) {
    const currentAuthContext = waitForAuthContext(page);
    await page.reload();
    assertFixtureMembership(
      await currentAuthContext,
      fixture,
      role,
      membershipId,
    );
  }
  await safeGoto(
    page,
    role === "teacher" ? "/teacher/dashboard" : "/student/dashboard",
  );
  await expect(page).toHaveURL(
    role === "teacher" ? /\/teacher\/dashboard$/ : /\/student\/dashboard$/,
    { timeout: 15_000 },
  );
  await expect(visibleWorkspaceSelector(page)).toContainText(
    `${fixture.workspaceName} · ${role}`,
  );
}

function matchesRpc(response: Response, functionName: string) {
  try {
    return (
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(`/rest/v1/rpc/${functionName}`)
    );
  } catch {
    return false;
  }
}

async function waitForSubmissionDetail(page: Page, timeout = 15_000) {
  let response: Response;
  try {
    response = await page.waitForResponse(
      (candidate) => matchesRpc(candidate, "get_submission_detail"),
      { timeout },
    );
  } catch {
    throw new Error(
      "The authorized submission detail refresh was not observed.",
    );
  }
  if (response.status() >= 400) {
    throw new Error("The authorized submission detail refresh failed safely.");
  }
  return response;
}

async function parseDetailResponse(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("The submission detail response was not valid JSON.");
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertDetailStatus(payload: unknown, expectedStatus: FixtureStatus) {
  if (!hasDetailStatus(payload, expectedStatus)) {
    throw new Error("The submission detail returned an unexpected safe state.");
  }
}

function hasDetailStatus(payload: unknown, expectedStatus: FixtureStatus) {
  const detail = recordValue(payload);
  const submission = recordValue(detail?.submission);
  const expectedSubmissionStatus =
    expectedStatus === "processing" ? "checking" : expectedStatus;
  return (
    detail?.schema_version === 1 &&
    submission?.status === expectedSubmissionStatus &&
    submission?.evaluation_status === expectedStatus &&
    submission?.release_status === "held"
  );
}

function assertStudentDetailPrivate(
  payload: unknown,
  expectedStatus: FixtureStatus,
) {
  assertDetailStatus(payload, expectedStatus);
  const detail = recordValue(payload)!;
  const submission = recordValue(detail.submission)!;
  if (
    detail.feedback !== null ||
    submission.corrected_text !== null ||
    submission.overall_summary !== null ||
    submission.level_detected !== null ||
    submission.checked_at !== null ||
    JSON.stringify(payload).includes(PRIVATE_SUMMARY)
  ) {
    throw new Error("Held feedback became visible in the student read model.");
  }
}

async function assertPageStatus(page: Page, label: string) {
  await expect(page.getByText(label, { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
}

async function assertStudentPagePrivate(page: Page) {
  await expect(
    page.getByText("Corrected Version", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Feedback Summary", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(PRIVATE_SUMMARY, { exact: true })).toHaveCount(0);
}

async function openSubmission(
  page: Page,
  role: AccountRole,
  submissionId: string,
) {
  const responsePromise = waitForSubmissionDetail(page);
  await safeGoto(page, `/${role}/submission/${submissionId}`);
  return parseDetailResponse(await responsePromise);
}

function observeSubmissionDetailState(
  page: Page,
  expectedStatus: FixtureStatus,
): SubmissionDetailStateObserver {
  let disposed = false;
  let nonMatchingResponses = 0;
  let matchingPayload: unknown;
  let observerFailure: Error | null = null;
  let waiter: {
    reject: (error: Error) => void;
    resolve: (payload: unknown) => void;
    timeoutId: NodeJS.Timeout;
  } | null = null;

  const settleMatch = (payload: unknown) => {
    matchingPayload = payload;
    if (!waiter) return;
    clearTimeout(waiter.timeoutId);
    const { resolve } = waiter;
    waiter = null;
    resolve(payload);
  };
  const settleFailure = (error: Error) => {
    observerFailure = error;
    if (!waiter) return;
    clearTimeout(waiter.timeoutId);
    const { reject } = waiter;
    waiter = null;
    reject(error);
  };
  const handleResponse = (response: Response) => {
    if (!matchesRpc(response, "get_submission_detail")) return;
    void (async () => {
      if (response.status() >= 400) {
        settleFailure(
          new Error("The authorized submission detail refresh failed safely."),
        );
        return;
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        settleFailure(
          new Error("The submission detail response was not valid JSON."),
        );
        return;
      }
      if (disposed) return;
      if (hasDetailStatus(payload, expectedStatus)) {
        settleMatch(payload);
      } else {
        nonMatchingResponses += 1;
      }
    })();
  };
  page.on("response", handleResponse);

  return {
    dispose: () => {
      disposed = true;
      page.off("response", handleResponse);
      if (waiter) {
        clearTimeout(waiter.timeoutId);
        const { reject } = waiter;
        waiter = null;
        reject(new Error("The submission detail state observer was disposed."));
      }
    },
    nonMatchingCount: () => nonMatchingResponses,
    waitForMatch: (timeout) => {
      if (matchingPayload !== undefined) {
        return Promise.resolve(matchingPayload);
      }
      if (observerFailure) return Promise.reject(observerFailure);
      if (waiter) {
        return Promise.reject(
          new Error("The submission detail state observer is already waiting."),
        );
      }
      return new Promise<unknown>((resolveMatch, rejectMatch) => {
        const timeoutId = setTimeout(() => {
          waiter = null;
          rejectMatch(
            new Error(
              "The expected authorized submission detail state was not observed.",
            ),
          );
        }, timeout);
        waiter = {
          reject: rejectMatch,
          resolve: resolveMatch,
          timeoutId,
        };
      });
    },
  };
}

function monitorFatalBrowserFailures(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror:${error.name}`));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(
        `http:${response.status()}:${response.request().resourceType()}`,
      );
    }
  });
  return () => expect(failures, failures.join("\n")).toEqual([]);
}

function monitorStudentDraftBoundary(page: Page) {
  let privateDraftRequests = 0;
  page.on("request", (request) => {
    try {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith(
          "/rest/v1/rpc/get_feedback_draft",
        )
      ) {
        privateDraftRequests += 1;
      }
    } catch {
      // A malformed unrelated URL is ignored without retaining it.
    }
  });
  return () => {
    if (privateDraftRequests !== 0) {
      throw new Error(
        "The student browser requested a private feedback draft.",
      );
    }
  };
}

function monitorRealtimeSocket(
  page: Page,
  submissionId: string,
  expectedStatus: FixtureStatus,
) {
  let realtimeSockets = 0;
  let matchingStatusFrames = 0;
  page.on("websocket", (socket) => {
    try {
      if (new URL(socket.url()).pathname === "/realtime/v1/websocket") {
        realtimeSockets += 1;
        socket.on("framereceived", ({ payload }) => {
          if (isTargetStatusFrame(payload, submissionId, expectedStatus)) {
            matchingStatusFrames += 1;
          }
        });
      }
    } catch {
      // A malformed unrelated URL is ignored without retaining it.
    }
  });
  return {
    matchingStatusFrameCount: () => matchingStatusFrames,
    socketCount: () => realtimeSockets,
  };
}

function isTargetStatusFrame(
  message: string | Buffer,
  submissionId: string,
  expectedStatus: FixtureStatus,
) {
  if (typeof message !== "string") return false;
  return (
    message.includes(submissionId) &&
    new RegExp(`"evaluation_status"\\s*:\\s*"${expectedStatus}"`, "u").test(
      message,
    ) &&
    /"release_status"\s*:\s*"held"/u.test(message)
  );
}

function proxyRealtimeSocket(
  route: WebSocketRoute,
  submissionId: string,
  shouldDrop: () => boolean,
  markDropped: () => void,
) {
  const server = route.connectToServer();
  route.onMessage((message) => server.send(message));
  server.onMessage((message) => {
    if (shouldDrop() && isTargetStatusFrame(message, submissionId, "failed")) {
      markDropped();
      return;
    }
    route.send(message);
  });
}

async function installRealtimeDrop(
  context: BrowserContext,
  submissionId: string,
): Promise<RealtimeDropController> {
  let armed = false;
  let routed = 0;
  let dropped = 0;
  await context.routeWebSocket(
    (url) => url.pathname === "/realtime/v1/websocket",
    (route) => {
      routed += 1;
      proxyRealtimeSocket(
        route,
        submissionId,
        () => armed,
        () => {
          dropped += 1;
        },
      );
    },
  );
  return {
    arm: () => {
      armed = true;
    },
    routedCount: () => routed,
    droppedCount: () => dropped,
  };
}

async function waitForPositiveCount(
  readCount: () => number,
  message: string,
  timeout = 10_000,
) {
  await expect.poll(readCount, { message, timeout }).toBeGreaterThan(0);
}

async function createFixturePages(args: {
  browser: Browser;
  baseURL: string;
  fixture: SubmissionRealtimeFixture;
  teacher: Credentials;
  student: Credentials;
  interceptRealtime: boolean;
}) {
  const teacherContext = await args.browser.newContext({
    baseURL: args.baseURL,
    viewport: { width: 1366, height: 768 },
  });
  const studentContext = await args.browser.newContext({
    baseURL: args.baseURL,
    viewport: { width: 1366, height: 768 },
  });
  let teacherDrop: RealtimeDropController | null = null;
  let studentDrop: RealtimeDropController | null = null;
  if (args.interceptRealtime) {
    [teacherDrop, studentDrop] = await Promise.all([
      installRealtimeDrop(teacherContext, args.fixture.submissionId),
      installRealtimeDrop(studentContext, args.fixture.submissionId),
    ]);
  }
  const teacherPage = await teacherContext.newPage();
  const studentPage = await studentContext.newPage();
  await Promise.all([
    signIn(teacherPage, args.teacher),
    signIn(studentPage, args.student),
  ]);
  await Promise.all([
    selectFixtureMembership(
      teacherPage,
      args.fixture,
      "teacher",
      args.fixture.teacherMembershipId,
      !args.interceptRealtime,
    ),
    selectFixtureMembership(
      studentPage,
      args.fixture,
      "student",
      args.fixture.studentMembershipId,
      !args.interceptRealtime,
    ),
  ]);
  return {
    teacherContext,
    studentContext,
    teacherPage,
    studentPage,
    teacherDrop,
    studentDrop,
  };
}

test.skip(
  process.env.E2E_SUBMISSION_REALTIME !== "true",
  "Set E2E_SUBMISSION_REALTIME=true only for the isolated WRITE-016 staging run.",
);

test.describe.serial("authenticated WRITE-016 submission live recovery", () => {
  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
    expect(requiredEnvironment("E2E_MUTATIONS")).toBe("true");
  });

  test("teacher and student detail pages update through Realtime and recover a dropped event without exposing held feedback", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error(
        "WRITE-016 requires the private local authenticated frontend.",
      );
    }

    const teacher = configuredCredentials("TEACHER");
    const student = configuredCredentials("STUDENT");
    if (teacher.email.toLowerCase() === student.email.toLowerCase()) {
      throw new Error("WRITE-016 requires two distinct staging accounts.");
    }

    const fixture = newFixture();
    const openContexts: BrowserContext[] = [];
    let fixtureInstalled = false;
    try {
      await runPrivateLinkedSql(
        installFixtureSql(fixture, teacher, student),
        "WRITE-016 setup",
      );
      fixtureInstalled = true;

      const realtime = await createFixturePages({
        browser,
        baseURL,
        fixture,
        teacher,
        student,
        interceptRealtime: false,
      });
      openContexts.push(realtime.teacherContext, realtime.studentContext);
      const assertTeacherSafe = monitorFatalBrowserFailures(
        realtime.teacherPage,
      );
      const assertStudentSafe = monitorFatalBrowserFailures(
        realtime.studentPage,
      );
      const assertStudentDraftBoundary = monitorStudentDraftBoundary(
        realtime.studentPage,
      );
      const teacherRealtimeSockets = monitorRealtimeSocket(
        realtime.teacherPage,
        fixture.submissionId,
        "needs_review",
      );
      const studentRealtimeSockets = monitorRealtimeSocket(
        realtime.studentPage,
        fixture.submissionId,
        "needs_review",
      );

      const [initialTeacherDetail, initialStudentDetail] = await Promise.all([
        openSubmission(realtime.teacherPage, "teacher", fixture.submissionId),
        openSubmission(realtime.studentPage, "student", fixture.submissionId),
      ]);
      assertDetailStatus(initialTeacherDetail, "processing");
      assertStudentDetailPrivate(initialStudentDetail, "processing");
      await Promise.all([
        assertPageStatus(realtime.teacherPage, "Preparing feedback"),
        assertPageStatus(realtime.studentPage, "Preparing feedback"),
        assertStudentPagePrivate(realtime.studentPage),
        waitForPositiveCount(
          teacherRealtimeSockets.socketCount,
          "The teacher Realtime socket was not opened.",
        ),
        waitForPositiveCount(
          studentRealtimeSockets.socketCount,
          "The student Realtime socket was not opened.",
        ),
      ]);
      await realtime.teacherPage.waitForTimeout(1_500);

      const teacherNeedsReviewObserver = observeSubmissionDetailState(
        realtime.teacherPage,
        "needs_review",
      );
      const studentNeedsReviewObserver = observeSubmissionDetailState(
        realtime.studentPage,
        "needs_review",
      );
      let teacherNeedsReview: unknown;
      let studentNeedsReview: unknown;
      try {
        // Regression: force one authorized but stale processing response into
        // each observer first. The state observer must consume and ignore it,
        // then accept only a later response that reflects the committed state.
        const staleTeacherResponse = waitForSubmissionDetail(
          realtime.teacherPage,
        );
        const staleStudentResponse = waitForSubmissionDetail(
          realtime.studentPage,
        );
        await Promise.all([
          realtime.teacherPage.evaluate(() => {
            window.dispatchEvent(new Event("focus"));
          }),
          realtime.studentPage.evaluate(() => {
            window.dispatchEvent(new Event("focus"));
          }),
        ]);
        const [staleTeacherDetail, staleStudentDetail] = await Promise.all([
          parseDetailResponse(await staleTeacherResponse),
          parseDetailResponse(await staleStudentResponse),
        ]);
        assertDetailStatus(staleTeacherDetail, "processing");
        assertStudentDetailPrivate(staleStudentDetail, "processing");
        await Promise.all([
          waitForPositiveCount(
            teacherNeedsReviewObserver.nonMatchingCount,
            "The teacher stale detail response was not consumed.",
          ),
          waitForPositiveCount(
            studentNeedsReviewObserver.nonMatchingCount,
            "The student stale detail response was not consumed.",
          ),
        ]);

        // The 4.8-second bound is intentionally below the disconnected
        // 5-second fallback. A passing matching refresh therefore exercises
        // authorized Realtime, even though a stale response arrived first.
        const realtimeDeadline = Date.now() + 4_800;
        await runPrivateLinkedSql(
          transitionFixtureSql(fixture, "needs_review"),
          "WRITE-016 Realtime transition",
        );
        const remainingRealtimeMs = Math.max(1, realtimeDeadline - Date.now());
        [teacherNeedsReview, studentNeedsReview] = await Promise.all([
          teacherNeedsReviewObserver.waitForMatch(remainingRealtimeMs),
          studentNeedsReviewObserver.waitForMatch(remainingRealtimeMs),
        ]);
        await Promise.all([
          waitForPositiveCount(
            teacherRealtimeSockets.matchingStatusFrameCount,
            "The teacher authorized Realtime status frame was not observed.",
          ),
          waitForPositiveCount(
            studentRealtimeSockets.matchingStatusFrameCount,
            "The student authorized Realtime status frame was not observed.",
          ),
        ]);
      } finally {
        teacherNeedsReviewObserver.dispose();
        studentNeedsReviewObserver.dispose();
      }
      assertDetailStatus(teacherNeedsReview, "needs_review");
      assertStudentDetailPrivate(studentNeedsReview, "needs_review");
      await Promise.all([
        assertPageStatus(realtime.teacherPage, "Teacher review"),
        assertPageStatus(realtime.studentPage, "Teacher review"),
        expect(
          realtime.teacherPage.getByText("Teacher feedback editor", {
            exact: true,
          }),
        ).toBeVisible({ timeout: 15_000 }),
        assertStudentPagePrivate(realtime.studentPage),
      ]);
      assertStudentDraftBoundary();
      assertTeacherSafe();
      assertStudentSafe();

      await Promise.all([
        realtime.teacherContext.close(),
        realtime.studentContext.close(),
      ]);
      openContexts.splice(0, openContexts.length);

      await runPrivateLinkedSql(
        transitionFixtureSql(fixture, "processing"),
        "WRITE-016 recovery reset",
      );

      const recovery = await createFixturePages({
        browser,
        baseURL,
        fixture,
        teacher,
        student,
        interceptRealtime: true,
      });
      openContexts.push(recovery.teacherContext, recovery.studentContext);
      const assertRecoveryTeacherSafe = monitorFatalBrowserFailures(
        recovery.teacherPage,
      );
      const assertRecoveryStudentSafe = monitorFatalBrowserFailures(
        recovery.studentPage,
      );
      const assertRecoveryStudentDraftBoundary = monitorStudentDraftBoundary(
        recovery.studentPage,
      );
      const [recoveryTeacherInitial, recoveryStudentInitial] =
        await Promise.all([
          openSubmission(recovery.teacherPage, "teacher", fixture.submissionId),
          openSubmission(recovery.studentPage, "student", fixture.submissionId),
        ]);
      assertDetailStatus(recoveryTeacherInitial, "processing");
      assertStudentDetailPrivate(recoveryStudentInitial, "processing");
      await Promise.all([
        assertPageStatus(recovery.teacherPage, "Preparing feedback"),
        assertPageStatus(recovery.studentPage, "Preparing feedback"),
        assertStudentPagePrivate(recovery.studentPage),
        waitForPositiveCount(
          recovery.teacherDrop!.routedCount,
          "The teacher Realtime proxy was not connected.",
        ),
        waitForPositiveCount(
          recovery.studentDrop!.routedCount,
          "The student Realtime proxy was not connected.",
        ),
      ]);
      await recovery.teacherPage.waitForTimeout(1_500);

      const teacherFailedObserver = observeSubmissionDetailState(
        recovery.teacherPage,
        "failed",
      );
      const studentFailedObserver = observeSubmissionDetailState(
        recovery.studentPage,
        "failed",
      );
      recovery.teacherDrop!.arm();
      recovery.studentDrop!.arm();
      await runPrivateLinkedSql(
        transitionFixtureSql(fixture, "failed"),
        "WRITE-016 dropped-event transition",
      );
      await Promise.all([
        waitForPositiveCount(
          recovery.teacherDrop!.droppedCount,
          "The teacher status event was not deliberately dropped.",
        ),
        waitForPositiveCount(
          recovery.studentDrop!.droppedCount,
          "The student status event was not deliberately dropped.",
        ),
      ]);

      await Promise.all([
        assertPageStatus(recovery.teacherPage, "Preparing feedback"),
        assertPageStatus(recovery.studentPage, "Preparing feedback"),
      ]);

      await recovery.teacherPage.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
      });
      const teacherFailed = await teacherFailedObserver.waitForMatch(5_000);
      assertDetailStatus(teacherFailed, "failed");
      await assertPageStatus(recovery.teacherPage, "Feedback failed");

      // The connected page missed its Realtime frame on purpose. The bounded
      // 30-second safety poll must still recover without user interaction.
      const studentFailed = await studentFailedObserver.waitForMatch(40_000);
      teacherFailedObserver.dispose();
      studentFailedObserver.dispose();
      assertStudentDetailPrivate(studentFailed, "failed");
      await Promise.all([
        assertPageStatus(recovery.studentPage, "Feedback failed"),
        assertStudentPagePrivate(recovery.studentPage),
      ]);
      assertRecoveryStudentDraftBoundary();
      assertRecoveryTeacherSafe();
      assertRecoveryStudentSafe();
    } finally {
      const cleanupFailures: string[] = [];
      await Promise.allSettled(openContexts.map((context) => context.close()));
      if (fixtureInstalled) {
        await runPrivateLinkedSql(
          cleanupFixtureSql(fixture),
          "WRITE-016 exact cleanup",
        ).catch(() => cleanupFailures.push("exact-cleanup"));
      }
      expect(cleanupFailures, cleanupFailures.join(",")).toEqual([]);
    }
  });
});
