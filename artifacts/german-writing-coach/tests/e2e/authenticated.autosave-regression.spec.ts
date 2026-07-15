import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Credentials = { email: string; password: string };
type AccountSlot = "TEACHER" | "STUDENT";

interface AutosaveFixture {
  workspaceId: string;
  workspaceName: string;
  batchId: string;
  batchName: string;
  grammarTopicId: string;
  practiceTestId: string;
  questionId: string;
  assignmentId: string;
}

const PINNED_STAGING_PROJECT_REF = "vzcgalzspdehmnvqczfw";
const PINNED_STAGING_ORIGIN = "https://vzcgalzspdehmnvqczfw.supabase.co";
const PRIVATE_SQL_MAX_BUFFER = 1024 * 1024;

let fixture: AutosaveFixture | null = null;
let studentAccount: Credentials | null = null;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the autosave regression.`);
  }
  return value;
}

function candidateAccounts(): Credentials[] {
  const candidates = [
    {
      email: requiredEnvironment("E2E_TEACHER_EMAIL"),
      password: requiredEnvironment("E2E_TEACHER_PASSWORD"),
    },
    {
      email: requiredEnvironment("E2E_STUDENT_EMAIL"),
      password: requiredEnvironment("E2E_STUDENT_PASSWORD"),
    },
  ];
  if (candidates[0].email.toLowerCase() === candidates[1].email.toLowerCase()) {
    throw new Error("The autosave regression requires two distinct accounts.");
  }
  return candidates;
}

function resolveAccountSlots() {
  const requestedStudentSlot = requiredEnvironment("E2E_AUTOSAVE_STUDENT_SLOT");
  if (
    requestedStudentSlot !== "TEACHER" &&
    requestedStudentSlot !== "STUDENT"
  ) {
    throw new Error("E2E_AUTOSAVE_STUDENT_SLOT must equal TEACHER or STUDENT.");
  }
  const accounts = candidateAccounts();
  const studentIndex = requestedStudentSlot === "TEACHER" ? 0 : 1;
  return {
    student: accounts[studentIndex],
    teacher: accounts[studentIndex === 0 ? 1 : 0],
    studentSlot: requestedStudentSlot as AccountSlot,
  };
}

function sqlLiteral(value: string) {
  if (/\u0000|[\r\n]/u.test(value)) {
    throw new Error("The autosave fixture received an invalid SQL value.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlUuid(value: string) {
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error("The autosave fixture received an invalid UUID.");
  }
  return `'${value}'::uuid`;
}

function runPrivateLinkedSql(label: string, sql: string) {
  const binary = requiredEnvironment("E2E_SUPABASE_BIN");
  if (!isAbsolute(binary)) {
    throw new Error("E2E_SUPABASE_BIN must be an absolute path.");
  }
  const linkedProjectRef = readFileSync(
    resolve(process.cwd(), "../../supabase/.temp/project-ref"),
    "utf8",
  ).trim();
  if (linkedProjectRef !== PINNED_STAGING_PROJECT_REF) {
    throw new Error("The autosave regression is not linked to pinned staging.");
  }

  const result = spawnSync(
    binary,
    [
      "db",
      "query",
      "--linked",
      "--file",
      "/dev/stdin",
      "--output-format",
      "json",
    ],
    {
      cwd: process.cwd(),
      input: sql,
      encoding: "utf8",
      maxBuffer: PRIVATE_SQL_MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    const safeDiagnostic = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
        "[uuid]",
      )
      .replace(/https?:\/\/[^\s]+/gi, "[url]")
      .replace(/[A-Za-z0-9_-]{48,}/g, "[redacted]")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-4)
      .join(" | ")
      .slice(0, 500);
    throw new Error(
      `${label} failed: ${safeDiagnostic || "private database output was suppressed."}`,
    );
  }
}

function newAutosaveFixture(): AutosaveFixture {
  const suffix = randomUUID();
  return {
    workspaceId: randomUUID(),
    workspaceName: `V1 autosave ${suffix.slice(0, 8)}`,
    batchId: randomUUID(),
    batchName: `Autosave class ${suffix.slice(0, 8)}`,
    grammarTopicId: randomUUID(),
    practiceTestId: randomUUID(),
    questionId: randomUUID(),
    assignmentId: randomUUID(),
  };
}

function createFixtureSql(
  target: AutosaveFixture,
  teacher: Credentials,
  student: Credentials,
) {
  const workspaceSlug = `e2e-autosave-${target.workspaceId}`;
  const topicSlug = `e2e-autosave-${target.grammarTopicId}`;
  return `
begin;
do $fixture$
declare
  teacher_id uuid;
  student_id uuid;
begin
  select profile.id into teacher_id
  from public.profiles profile
  where lower(profile.email) = lower(${sqlLiteral(teacher.email)});

  select profile.id into student_id
  from public.profiles profile
  where lower(profile.email) = lower(${sqlLiteral(student.email)});

  if teacher_id is null or student_id is null or teacher_id = student_id then
    raise exception 'autosave_fixture_accounts_invalid';
  end if;

  insert into public.workspaces (id, name, slug, owner_id)
  values (
    ${sqlUuid(target.workspaceId)},
    ${sqlLiteral(target.workspaceName)},
    ${sqlLiteral(workspaceSlug)},
    teacher_id
  );

  insert into public.workspace_members (workspace_id, user_id, role)
  values
    (${sqlUuid(target.workspaceId)}, teacher_id, 'teacher'),
    (${sqlUuid(target.workspaceId)}, student_id, 'student');

  insert into public.batches (
    id,
    workspace_id,
    name,
    level,
    created_by,
    feedback_mode,
    join_requires_approval
  ) values (
    ${sqlUuid(target.batchId)},
    ${sqlUuid(target.workspaceId)},
    ${sqlLiteral(target.batchName)},
    'A1',
    teacher_id,
    'teacher_review_only',
    true
  );

  insert into public.batch_students (batch_id, student_id, workspace_id)
  values (
    ${sqlUuid(target.batchId)},
    student_id,
    ${sqlUuid(target.workspaceId)}
  );

  insert into public.grammar_topics (id, slug, name, level, description)
  values (
    ${sqlUuid(target.grammarTopicId)},
    ${sqlLiteral(topicSlug)},
    'Autosave regression topic',
    'A1',
    'Short-lived provider-free staging fixture.'
  );

  insert into public.practice_tests (
    id,
    workspace_id,
    grammar_topic_id,
    level,
    difficulty,
    title,
    description,
    created_by_ai,
    teacher_reviewed,
    visibility,
    created_by,
    generation_source,
    quality_status
  ) values (
    ${sqlUuid(target.practiceTestId)},
    ${sqlUuid(target.workspaceId)},
    ${sqlUuid(target.grammarTopicId)},
    'A1',
    'easy',
    'Autosave regression worksheet',
    'Provider-free staging fixture for answer persistence.',
    false,
    true,
    'workspace',
    teacher_id,
    'fixture',
    'approved'
  );

  insert into public.practice_test_questions (
    id,
    practice_test_id,
    question_number,
    question_type,
    prompt,
    options,
    correct_answer,
    explanation,
    evaluation_mode,
    accepted_answers,
    answer_contract_version
  ) values (
    ${sqlUuid(target.questionId)},
    ${sqlUuid(target.practiceTestId)},
    1,
    'multiple_choice',
    'Ich ___ heute im Kurs.',
    '["bin", "bist", "ist"]'::jsonb,
    'bin',
    'The first-person form of sein is bin.',
    'local_exact',
    '["bin"]'::jsonb,
    1
  );

  insert into public.student_practice_assignments (
    id,
    workspace_id,
    student_id,
    grammar_topic_id,
    practice_test_id,
    source,
    status,
    assigned_by,
    generation_status,
    generation_completed_at
  ) values (
    ${sqlUuid(target.assignmentId)},
    ${sqlUuid(target.workspaceId)},
    student_id,
    ${sqlUuid(target.grammarTopicId)},
    ${sqlUuid(target.practiceTestId)},
    'manual',
    'unlocked',
    teacher_id,
    'ready',
    now()
  );

  if not exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.id = ${sqlUuid(target.assignmentId)}
      and assignment.practice_test_id = ${sqlUuid(target.practiceTestId)}
      and assignment.generation_status = 'ready'
  ) then
    raise exception 'autosave_fixture_not_ready';
  end if;
end
$fixture$;
commit;
`;
}

function cleanupFixtureSql(target: AutosaveFixture) {
  return `
begin;
create temp table autosave_fixture_attempt_ids (
  id uuid primary key
) on commit drop;
insert into pg_temp.autosave_fixture_attempt_ids (id)
select attempt.id
from public.practice_test_attempts attempt
where attempt.assignment_id = ${sqlUuid(target.assignmentId)}
  and attempt.practice_test_id = ${sqlUuid(target.practiceTestId)}
  and attempt.workspace_id = ${sqlUuid(target.workspaceId)};
delete from app_private.practice_drafts
where assignment_id = ${sqlUuid(target.assignmentId)};
delete from app_private.writing_drafts
where batch_id = ${sqlUuid(target.batchId)};
delete from app_private.async_jobs job
where job.job_kind = 'worksheet_answer_evaluation'
  and job.entity_id in (select id from pg_temp.autosave_fixture_attempt_ids);
delete from public.practice_test_attempts attempt
where attempt.id in (select id from pg_temp.autosave_fixture_attempt_ids);
delete from public.student_practice_assignments
where id = ${sqlUuid(target.assignmentId)};
delete from public.practice_tests
where id = ${sqlUuid(target.practiceTestId)};
delete from public.batch_students
where batch_id = ${sqlUuid(target.batchId)};
delete from public.batches
where id = ${sqlUuid(target.batchId)};
delete from public.workspace_members
where workspace_id = ${sqlUuid(target.workspaceId)};
delete from public.workspaces
where id = ${sqlUuid(target.workspaceId)};
delete from public.grammar_topics
where id = ${sqlUuid(target.grammarTopicId)};

do $verify$
begin
  if exists (
    select 1 from app_private.practice_drafts
    where assignment_id = ${sqlUuid(target.assignmentId)}
  ) or exists (
    select 1 from app_private.writing_drafts
    where batch_id = ${sqlUuid(target.batchId)}
  ) or exists (
    select 1 from public.student_practice_assignments
    where id = ${sqlUuid(target.assignmentId)}
  ) or exists (
    select 1 from public.practice_test_attempts attempt
    where attempt.practice_test_id = ${sqlUuid(target.practiceTestId)}
      and attempt.workspace_id = ${sqlUuid(target.workspaceId)}
  ) or exists (
    select 1 from app_private.async_jobs job
    where job.job_kind = 'worksheet_answer_evaluation'
      and job.entity_id in (select id from pg_temp.autosave_fixture_attempt_ids)
  ) or exists (
    select 1 from public.practice_tests
    where id = ${sqlUuid(target.practiceTestId)}
  ) or exists (
    select 1 from public.batches
    where id = ${sqlUuid(target.batchId)}
  ) or exists (
    select 1 from public.workspaces
    where id = ${sqlUuid(target.workspaceId)}
  ) or exists (
    select 1 from public.grammar_topics
    where id = ${sqlUuid(target.grammarTopicId)}
  ) then
    raise exception 'autosave_fixture_cleanup_incomplete';
  end if;
end
$verify$;
commit;
`;
}

async function signInStudent(
  page: Page,
  account: Credentials,
  target: AutosaveFixture,
) {
  let authEvidence: {
    status: number;
    studentRole: boolean;
    fixtureMembership: boolean;
  } | null = null;
  const captureAuthContext = (
    response: Awaited<ReturnType<Page["waitForResponse"]>>,
  ) => {
    let pathname = "";
    try {
      pathname = new URL(response.url()).pathname;
    } catch {
      return;
    }
    if (!pathname.endsWith("/rest/v1/rpc/get_auth_context")) return;
    void response
      .json()
      .then((payload: unknown) => {
        const row = Array.isArray(payload) ? payload[0] : null;
        const record =
          row && typeof row === "object" && !Array.isArray(row)
            ? (row as Record<string, unknown>)
            : null;
        const memberships = Array.isArray(record?.memberships)
          ? record.memberships
          : [];
        authEvidence = {
          status: response.status(),
          studentRole: record?.global_role === "student",
          fixtureMembership: memberships.some(
            (membership) =>
              membership !== null &&
              typeof membership === "object" &&
              !Array.isArray(membership) &&
              (membership as Record<string, unknown>).workspace_id ===
                target.workspaceId &&
              (membership as Record<string, unknown>).role === "student",
          ),
        };
      })
      .catch(() => {
        authEvidence = {
          status: response.status(),
          studentRole: false,
          fixtureMembership: false,
        };
      });
  };

  page.on("response", captureAuthContext);
  await page.goto("/");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in with Email" }).click();
  const readLoginOutcome = async () => {
    const pathname = new URL(page.url()).pathname;
    if (pathname === "/student/dashboard") return "student";
    if (
      pathname === "/teacher/dashboard" ||
      pathname === "/teacher/onboarding"
    ) {
      return "teacher";
    }
    const alert = page.getByRole("alert");
    if ((await alert.count()) > 0 && (await alert.first().isVisible())) {
      return "login_error";
    }
    return "pending";
  };
  await expect.poll(readLoginOutcome, { timeout: 15_000 }).not.toBe("pending");
  const outcome = await readLoginOutcome();
  if (outcome === "login_error") {
    page.off("response", captureAuthContext);
    throw new Error(
      "The staging student login was rejected; no autosave mutation was started.",
    );
  }
  if (outcome !== "student") {
    page.off("response", captureAuthContext);
    throw new Error(
      "The selected autosave account opened a teacher shell; no student mutation was started.",
    );
  }
  await expect.poll(() => authEvidence, { timeout: 15_000 }).not.toBeNull();
  page.off("response", captureAuthContext);
  const verifiedAuthEvidence = authEvidence as {
    status: number;
    studentRole: boolean;
    fixtureMembership: boolean;
  } | null;
  if (
    !verifiedAuthEvidence ||
    verifiedAuthEvidence.status >= 400 ||
    !verifiedAuthEvidence.studentRole ||
    !verifiedAuthEvidence.fixtureMembership
  ) {
    throw new Error(
      "The authenticated student context was invalid; no autosave mutation was started.",
    );
  }
}

function visibleWorkspaceSelector(page: Page) {
  return page.getByLabel("Active workspace and role").filter({ visible: true });
}

async function selectFixtureWorkspace(page: Page, target: AutosaveFixture) {
  await page.goto("/student/dashboard");
  const selector = visibleWorkspaceSelector(page);
  await expect(selector).toHaveCount(1, { timeout: 15_000 });
  await selector.click();
  const option = page.getByRole("option", {
    name: `${target.workspaceName} · student`,
    exact: true,
  });
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(page).toHaveURL(/\/student\/dashboard$/, { timeout: 10_000 });
}

async function openFixtureWriting(page: Page, target: AutosaveFixture) {
  await page.goto("/student/write?mode=free");
  const classSelector = page.getByLabel("Class receiving this writing");
  await expect(classSelector).toBeVisible({ timeout: 15_000 });
  await expect(classSelector).toBeEnabled({ timeout: 15_000 });
  if (!(await classSelector.textContent())?.includes(target.batchName)) {
    await classSelector.click();
    await page
      .getByRole("option", {
        name: `${target.batchName} · A1`,
        exact: true,
      })
      .click();
  }
  await expect(classSelector).toContainText(target.batchName);
  await expect(page.getByTestId("writing-draft-status")).toContainText(
    /Draft ready|Saved/,
    { timeout: 15_000 },
  );
}

async function waitForWritingRevision(page: Page, revision: number) {
  await expect(page.getByTestId("writing-draft-status")).toContainText(
    `Revision ${revision}`,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("writing-draft-status")).toContainText("Saved");
}

async function openFixtureWorksheet(page: Page, target: AutosaveFixture) {
  await page.goto(`/student/practice/${target.assignmentId}`);
  await expect(
    page.getByText("Loading worksheet...", { exact: true }),
  ).toBeHidden({ timeout: 15_000 });
  await expect(
    page.getByRole("progressbar", { name: "Worksheet answer progress" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("worksheet-answer-1")).toBeVisible();
}

async function waitForPracticeRevision(page: Page, revision: number) {
  await expect(page.getByTestId("practice-draft-status")).toContainText(
    `Revision ${revision}`,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("practice-draft-status")).toContainText(
    "Saved",
  );
}

function monitorFatalBrowserFailures(page: Page) {
  const failures: string[] = [];
  const serverFailures: Array<{
    request: Request;
    diagnostic: string;
  }> = [];
  const expectedFailures = new WeakSet<Request>();
  page.on("pageerror", (error) => failures.push(`pageerror:${error.name}`));
  page.on("request", (request) => {
    let pathname = "";
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      return;
    }
    if (pathname.startsWith("/functions/v1/")) {
      failures.push(`edge_function:${pathname.slice("/functions/v1/".length)}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverFailures.push({
        request: response.request(),
        diagnostic: `http:${response.status()}:${response.request().resourceType()}`,
      });
    }
  });
  return {
    allowExpectedRpcFailure: (request: Request) => {
      expectedFailures.add(request);
    },
    assertNoFatalFailures: () => {
      const unexpectedServerFailures = serverFailures
        .filter(({ request }) => !expectedFailures.has(request))
        .map(({ diagnostic }) => diagnostic);
      const unexpected = [...failures, ...unexpectedServerFailures];
      expect(unexpected, unexpected.join("\n")).toEqual([]);
    },
  };
}

async function readWritingRevision(page: Page) {
  const status = await page.getByTestId("writing-draft-status").textContent();
  const revision = status?.match(/Revision (\d+)/)?.[1];
  if (!revision) {
    throw new Error("The writing draft status did not expose a revision.");
  }
  return Number.parseInt(revision, 10);
}

async function readPracticeRevision(page: Page) {
  const status = await page.getByTestId("practice-draft-status").textContent();
  const revision = status?.match(/Revision (\d+)/)?.[1];
  if (!revision) {
    throw new Error("The practice draft status did not expose a revision.");
  }
  return Number.parseInt(revision, 10);
}

async function installProviderRouteBlock(context: BrowserContext) {
  const attempts: string[] = [];
  await context.route(`${PINNED_STAGING_ORIGIN}/functions/v1/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    attempts.push(pathname.slice("/functions/v1/".length));
    return route.abort("blockedbyclient");
  });
  return () => expect(attempts, attempts.join("\n")).toEqual([]);
}

function rpcRequestMatches(request: Request, functionName: string) {
  const candidate = new URL(request.url());
  return (
    request.method() === "POST" &&
    candidate.pathname.endsWith(`/rest/v1/rpc/${functionName}`)
  );
}

async function performSettledUiSave(
  page: Page,
  functionName: string,
  action: () => Promise<void>,
) {
  const pending = new Set<Request>();
  let started = 0;
  let finished = 0;
  let failed = 0;
  let lastChangeAt = Date.now();
  const onRequest = (request: Request) => {
    if (!rpcRequestMatches(request, functionName)) return;
    pending.add(request);
    started += 1;
    lastChangeAt = Date.now();
  };
  const onRequestFinished = (request: Request) => {
    if (!pending.delete(request)) return;
    finished += 1;
    lastChangeAt = Date.now();
  };
  const onRequestFailed = (request: Request) => {
    if (!pending.delete(request)) return;
    failed += 1;
    lastChangeAt = Date.now();
  };
  const activity = () => ({
    started,
    finished,
    failed,
    pending: pending.size,
    quietForMs: Date.now() - lastChangeAt,
  });
  page.on("request", onRequest);
  page.on("requestfinished", onRequestFinished);
  page.on("requestfailed", onRequestFailed);
  try {
    const matchingResponse = page.waitForResponse(
      (response) => rpcRequestMatches(response.request(), functionName),
      { timeout: 15_000 },
    );
    await action();
    const response = await matchingResponse;
    if (response.status() >= 400) {
      throw new Error("normal_autosave_failed");
    }
    await response.finished();
    await expect
      .poll(
        () => {
          const snapshot = activity();
          return (
            snapshot.started >= 1 &&
            snapshot.pending === 0 &&
            snapshot.failed === 0 &&
            snapshot.finished === snapshot.started &&
            snapshot.quietForMs >= 750
          );
        },
        { timeout: 5_000, intervals: [100] },
      )
      .toBe(true);
  } catch {
    const snapshot = activity();
    throw new Error(
      `The completed browser autosave was not safely settled (started=${snapshot.started}, finished=${snapshot.finished}, failed=${snapshot.failed}, pending=${snapshot.pending}).`,
    );
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onRequestFinished);
    page.off("requestfailed", onRequestFailed);
  }
}

async function expectNoUiSaveDuringRestore(
  page: Page,
  functionName: string,
  restore: () => Promise<void>,
) {
  let started = 0;
  const onRequest = (request: Request) => {
    if (rpcRequestMatches(request, functionName)) started += 1;
  };
  page.on("request", onRequest);
  try {
    await restore();
    await page.waitForTimeout(750);
    expect(
      started,
      `Unexpected ${functionName} request during the settled revision-one restore.`,
    ).toBe(0);
  } finally {
    page.off("request", onRequest);
  }
}

async function performStaleUiSave(
  page: Page,
  functionName: string,
  statusTestId: string,
  action: () => Promise<void>,
) {
  let startedRequest: Request | null = null;
  let matchingResponse: Response | null = null;
  let resolveRequestOutcome: (
    value: "response" | "request_failed",
  ) => void = () => undefined;
  const requestOutcome = new Promise<"response" | "request_failed">(
    (resolve) => {
      resolveRequestOutcome = resolve;
    },
  );
  const onRequest = (request: Request) => {
    if (!startedRequest && rpcRequestMatches(request, functionName)) {
      startedRequest = request;
    }
  };
  const onResponse = (response: Response) => {
    if (
      !matchingResponse &&
      rpcRequestMatches(response.request(), functionName)
    ) {
      matchingResponse = response;
      resolveRequestOutcome("response");
    }
  };
  const onRequestFailed = (request: Request) => {
    if (rpcRequestMatches(request, functionName)) {
      startedRequest ??= request;
      resolveRequestOutcome("request_failed");
    }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  try {
    let actionClassification = "completed";
    try {
      await action();
    } catch {
      actionClassification = "action_failed";
    }

    const outcome =
      actionClassification === "completed"
        ? await Promise.race([
            requestOutcome,
            page.waitForTimeout(20_000).then(() => "timeout" as const),
          ])
        : ("action_failed" as const);
    const response = matchingResponse as Response | null;
    const payload = response
      ? ((await response.json().catch(() => null)) as unknown)
      : null;
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const uiReachedConflict = await page
      .getByTestId(statusTestId)
      .filter({ hasText: "Conflict" })
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    const requestClassification =
      outcome === "response"
        ? "response"
        : outcome === "request_failed"
          ? "request_failed"
          : outcome === "action_failed"
            ? "action_failed"
            : startedRequest
              ? "request_pending"
              : "no_matching_request";
    return {
      request: response?.request() ?? startedRequest,
      requestClassification,
      requestStarted: startedRequest !== null,
      requestFailed: outcome === "request_failed",
      status: response?.status() ?? null,
      code: typeof record?.code === "string" ? record.code : null,
      messageClassification:
        record?.message === "draft_revision_conflict"
          ? "draft_revision_conflict"
          : typeof record?.message === "string"
            ? "other_error"
            : "none",
      uiReachedConflict,
    };
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
  }
}

test.skip(
  process.env.E2E_AUTOSAVE_REGRESSION !== "true",
  "Set E2E_AUTOSAVE_REGRESSION=true only for the isolated staging run.",
);

test.describe.serial("isolated real-browser autosave regressions", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
    expect(requiredEnvironment("E2E_MUTATIONS")).toBe("true");
    const accounts = resolveAccountSlots();
    studentAccount = accounts.student;
    fixture = newAutosaveFixture();
    runPrivateLinkedSql(
      "Autosave fixture setup",
      createFixtureSql(fixture, accounts.teacher, studentAccount),
    );
  });

  test.afterAll(() => {
    if (!fixture) return;
    runPrivateLinkedSql("Autosave fixture cleanup", cleanupFixtureSql(fixture));
  });

  test("WRITE-020 restores exact text and rejects a stale browser overwrite", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    if (!fixture || !studentAccount) {
      throw new Error("The writing autosave fixture was not prepared.");
    }
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error("The writing autosave regression requires a local URL.");
    }

    const context = await browser.newContext({ baseURL });
    const assertNoProviderRouteAttempts =
      await installProviderRouteBlock(context);
    const firstPage = await context.newPage();
    const firstFailures = monitorFatalBrowserFailures(firstPage);
    const originalText =
      "Erste Zeile mit 10.30 Uhr.\n\nZweiter Absatz bleibt exakt.";
    const newestText =
      "Erste Zeile mit 10.30 Uhr.\n\nZweiter Absatz bleibt exakt.\nNeueste Fassung.";
    const staleText = "Diese veraltete Fassung darf nicht gespeichert werden.";

    try {
      await signInStudent(firstPage, studentAccount, fixture);
      await selectFixtureWorkspace(firstPage, fixture);
      await openFixtureWriting(firstPage, fixture);
      const firstEditor = firstPage.getByLabel("Your Text");
      await firstEditor.fill(originalText);
      await firstEditor.press("Tab");
      await waitForWritingRevision(firstPage, 1);
      const draftRoute = `${new URL(firstPage.url()).pathname}${new URL(firstPage.url()).search}`;
      expect(draftRoute).toMatch(/draft=[0-9a-f-]{36}/i);

      await firstPage.reload();
      await expect(firstEditor).toHaveValue(originalText, { timeout: 15_000 });
      await waitForWritingRevision(firstPage, 1);

      const stalePage = await context.newPage();
      const staleFailures = monitorFatalBrowserFailures(stalePage);
      await expectNoUiSaveDuringRestore(
        stalePage,
        "save_writing_draft",
        async () => {
          await stalePage.goto(draftRoute);
          await expect(stalePage.getByLabel("Your Text")).toHaveValue(
            originalText,
            { timeout: 15_000 },
          );
          await waitForWritingRevision(stalePage, 1);
        },
      );

      await performSettledUiSave(firstPage, "save_writing_draft", async () => {
        await firstEditor.fill(newestText);
        await firstEditor.press("Tab");
        await waitForWritingRevision(firstPage, 2);
      });

      const staleEditor = stalePage.getByLabel("Your Text");
      await waitForWritingRevision(stalePage, 1);
      const staleResult = await performStaleUiSave(
        stalePage,
        "save_writing_draft",
        "writing-draft-status",
        async () => {
          await staleEditor.fill(staleText);
          await staleEditor.press("Tab");
        },
      );
      const staleDiagnostic = `request=${staleResult.requestClassification}; started=${staleResult.requestStarted}; failed=${staleResult.requestFailed}; status=${staleResult.status ?? "none"}; code=${staleResult.code ?? "none"}; message=${staleResult.messageClassification}; ui_conflict=${staleResult.uiReachedConflict}`;
      if (
        staleResult.request &&
        staleResult.status === 412 &&
        staleResult.code === "PT412" &&
        staleResult.messageClassification === "draft_revision_conflict"
      ) {
        staleFailures.allowExpectedRpcFailure(staleResult.request);
      }
      expect(staleResult.requestClassification, staleDiagnostic).toBe(
        "response",
      );
      expect(staleResult.requestStarted, staleDiagnostic).toBe(true);
      expect(staleResult.requestFailed, staleDiagnostic).toBe(false);
      expect(staleResult.status, staleDiagnostic).toBe(412);
      expect(staleResult.code, staleDiagnostic).toBe("PT412");
      expect(staleResult.messageClassification, staleDiagnostic).toBe(
        "draft_revision_conflict",
      );
      expect(staleResult.uiReachedConflict, staleDiagnostic).toBe(true);
      await expect(stalePage.getByTestId("writing-draft-status")).toContainText(
        "Conflict",
        { timeout: 15_000 },
      );
      await expect(staleEditor).toHaveValue(staleText);

      await stalePage
        .getByRole("button", { name: "Reload saved draft" })
        .click();
      await expect(staleEditor).toHaveValue(newestText, { timeout: 15_000 });
      await waitForWritingRevision(stalePage, 2);
      await stalePage.reload();
      await expect(staleEditor).toHaveValue(newestText, { timeout: 15_000 });
      await waitForWritingRevision(stalePage, 2);

      firstFailures.assertNoFatalFailures();
      staleFailures.assertNoFatalFailures();
      assertNoProviderRouteAttempts();
    } finally {
      await context.close();
    }
  });

  test("WRITE-021 preserves local text offline and recovers the exact latest draft online", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    if (!fixture || !studentAccount) {
      throw new Error("The offline autosave fixture was not prepared.");
    }
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error("The offline autosave regression requires a local URL.");
    }

    const context = await browser.newContext({ baseURL });
    const assertNoProviderRouteAttempts =
      await installProviderRouteBlock(context);
    const page = await context.newPage();
    const failures = monitorFatalBrowserFailures(page);
    const stamp = `${Date.now().toString(36)}-${process.pid}`;
    const baselineText = `Offline baseline ${stamp}.\n\nDiese Fassung ist gespeichert.`;
    const latestText = `${baselineText}\nDiese lokale Änderung darf nicht verloren gehen.`;

    try {
      await signInStudent(page, studentAccount, fixture);
      await selectFixtureWorkspace(page, fixture);
      await openFixtureWriting(page, fixture);
      const editor = page.getByLabel("Your Text");

      await performSettledUiSave(page, "save_writing_draft", async () => {
        await editor.fill(baselineText);
        await editor.press("Tab");
        await expect(page.getByTestId("writing-draft-status")).toContainText(
          "Saved",
          { timeout: 20_000 },
        );
      });
      const baselineRevision = await readWritingRevision(page);

      await context.setOffline(true);
      await editor.fill(latestText);
      await editor.press("Tab");
      await expect(page.getByTestId("writing-draft-status")).toContainText(
        "Error",
        { timeout: 20_000 },
      );
      await expect(page.getByTestId("writing-draft-status")).not.toContainText(
        "Saved",
      );
      await expect(editor).toHaveValue(latestText);
      expect(await readWritingRevision(page)).toBe(baselineRevision);

      await context.setOffline(false);
      await performSettledUiSave(page, "save_writing_draft", async () => {
        await page.getByRole("button", { name: "Save Draft" }).click();
        await waitForWritingRevision(page, baselineRevision + 1);
      });
      await expect(editor).toHaveValue(latestText);

      await page.reload();
      await expect(editor).toHaveValue(latestText, { timeout: 15_000 });
      await waitForWritingRevision(page, baselineRevision + 1);
      failures.assertNoFatalFailures();
      assertNoProviderRouteAttempts();
    } finally {
      await context.setOffline(false).catch(() => undefined);
      await context.close();
    }
  });

  test("PRACTICE-017 restores answers and rejects a stale browser overwrite", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    if (!fixture || !studentAccount) {
      throw new Error("The practice autosave fixture was not prepared.");
    }
    const targetFixture = fixture;
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error("The practice autosave regression requires a local URL.");
    }

    const context = await browser.newContext({ baseURL });
    const assertNoProviderRouteAttempts =
      await installProviderRouteBlock(context);
    const firstPage = await context.newPage();
    const firstFailures = monitorFatalBrowserFailures(firstPage);

    try {
      await signInStudent(firstPage, studentAccount, fixture);
      await selectFixtureWorkspace(firstPage, fixture);
      await openFixtureWorksheet(firstPage, fixture);
      await firstPage.getByRole("radio", { name: "bin" }).click();
      await waitForPracticeRevision(firstPage, 1);

      await firstPage.reload();
      await openFixtureWorksheet(firstPage, fixture);
      await expect(firstPage.getByRole("radio", { name: "bin" })).toBeChecked();
      await waitForPracticeRevision(firstPage, 1);

      const stalePage = await context.newPage();
      const staleFailures = monitorFatalBrowserFailures(stalePage);
      await expectNoUiSaveDuringRestore(
        stalePage,
        "save_practice_draft",
        async () => {
          await openFixtureWorksheet(stalePage, targetFixture);
          await expect(
            stalePage.getByRole("radio", { name: "bin" }),
          ).toBeChecked();
          await waitForPracticeRevision(stalePage, 1);
        },
      );

      await performSettledUiSave(firstPage, "save_practice_draft", async () => {
        await firstPage.getByRole("radio", { name: "bist" }).click();
        await waitForPracticeRevision(firstPage, 2);
      });

      await waitForPracticeRevision(stalePage, 1);
      const staleResult = await performStaleUiSave(
        stalePage,
        "save_practice_draft",
        "practice-draft-status",
        async () => {
          // Accessible-name matching is substring-based unless exact is set;
          // without it, "ist" also matches the neighboring "bist" option.
          await stalePage
            .getByRole("radio", { name: "ist", exact: true })
            .click();
        },
      );
      const staleDiagnostic = `request=${staleResult.requestClassification}; started=${staleResult.requestStarted}; failed=${staleResult.requestFailed}; status=${staleResult.status ?? "none"}; code=${staleResult.code ?? "none"}; message=${staleResult.messageClassification}; ui_conflict=${staleResult.uiReachedConflict}`;
      if (
        staleResult.request &&
        staleResult.status === 412 &&
        staleResult.code === "PT412" &&
        staleResult.messageClassification === "draft_revision_conflict"
      ) {
        staleFailures.allowExpectedRpcFailure(staleResult.request);
      }
      expect(staleResult.requestClassification, staleDiagnostic).toBe(
        "response",
      );
      expect(staleResult.requestStarted, staleDiagnostic).toBe(true);
      expect(staleResult.requestFailed, staleDiagnostic).toBe(false);
      expect(staleResult.status, staleDiagnostic).toBe(412);
      expect(staleResult.code, staleDiagnostic).toBe("PT412");
      expect(staleResult.messageClassification, staleDiagnostic).toBe(
        "draft_revision_conflict",
      );
      expect(staleResult.uiReachedConflict, staleDiagnostic).toBe(true);
      await expect(
        stalePage.getByTestId("practice-draft-status"),
      ).toContainText("Conflict", { timeout: 15_000 });
      await expect(
        stalePage.getByRole("radio", { name: "ist", exact: true }),
      ).toBeChecked();

      await stalePage
        .getByRole("button", { name: "Reload saved answers" })
        .click();
      await expect(stalePage.getByRole("radio", { name: "bist" })).toBeChecked({
        timeout: 15_000,
      });
      await waitForPracticeRevision(stalePage, 2);
      await stalePage.reload();
      await openFixtureWorksheet(stalePage, fixture);
      await expect(
        stalePage.getByRole("radio", { name: "bist" }),
      ).toBeChecked();
      await waitForPracticeRevision(stalePage, 2);

      firstFailures.assertNoFatalFailures();
      staleFailures.assertNoFatalFailures();
      assertNoProviderRouteAttempts();
    } finally {
      await context.close();
    }
  });

  test("PRACTICE-018 preserves the changed answer offline and recovers it online", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    if (!fixture || !studentAccount) {
      throw new Error("The offline practice fixture was not prepared.");
    }
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error("The offline practice regression requires a local URL.");
    }

    const context = await browser.newContext({ baseURL });
    const assertNoProviderRouteAttempts =
      await installProviderRouteBlock(context);
    const page = await context.newPage();
    const failures = monitorFatalBrowserFailures(page);

    try {
      await signInStudent(page, studentAccount, fixture);
      await selectFixtureWorkspace(page, fixture);
      await openFixtureWorksheet(page, fixture);

      await performSettledUiSave(page, "save_practice_draft", async () => {
        await page.getByRole("radio", { name: "bin", exact: true }).click();
        await expect(page.getByTestId("practice-draft-status")).toContainText(
          "Saved",
          { timeout: 20_000 },
        );
      });
      const baselineRevision = await readPracticeRevision(page);

      await context.setOffline(true);
      await page.getByRole("radio", { name: "ist", exact: true }).click();
      await expect(page.getByTestId("practice-draft-status")).toContainText(
        "Error",
        { timeout: 20_000 },
      );
      await expect(page.getByTestId("practice-draft-status")).not.toContainText(
        "Saved",
      );
      await expect(
        page.getByRole("radio", { name: "ist", exact: true }),
      ).toBeChecked();
      expect(await readPracticeRevision(page)).toBe(baselineRevision);

      await context.setOffline(false);
      await performSettledUiSave(page, "save_practice_draft", async () => {
        await page.getByRole("button", { name: "Retry save" }).click();
        await waitForPracticeRevision(page, baselineRevision + 1);
      });
      await expect(
        page.getByRole("radio", { name: "ist", exact: true }),
      ).toBeChecked();

      await page.reload();
      await openFixtureWorksheet(page, fixture);
      await expect(
        page.getByRole("radio", { name: "ist", exact: true }),
      ).toBeChecked();
      await waitForPracticeRevision(page, baselineRevision + 1);
      failures.assertNoFatalFailures();
      assertNoProviderRouteAttempts();
    } finally {
      await context.setOffline(false).catch(() => undefined);
      await context.close();
    }
  });
});
