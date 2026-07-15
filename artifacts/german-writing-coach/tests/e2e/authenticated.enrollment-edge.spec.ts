import {
  expect,
  test,
  type APIResponse,
  type Browser,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import { enterTeacherShellFromAdminLanding } from "./helpers/authenticated-role-navigation";

type Credentials = { email: string; password: string };
type DetectedRole = "teacher" | "student";
type JoinResult = { requestId: string; status: "pending" | "approved" };

const CLASS_LEVEL = "A1";

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the enrollment-edge workflow.`);
  }
  return value;
}

function credentials(slot: "TEACHER" | "STUDENT"): Credentials {
  return {
    email: requiredEnvironment(`E2E_${slot}_EMAIL`),
    password: requiredEnvironment(`E2E_${slot}_PASSWORD`),
  };
}

async function safeGoto(page: Page, path: string) {
  try {
    await page.goto(path);
  } catch {
    throw new Error("A protected enrollment navigation did not complete.");
  }
}

async function safeReload(page: Page) {
  try {
    await page.reload();
  } catch {
    throw new Error("A protected enrollment refresh did not complete.");
  }
}

async function fillPrivately(field: Locator, value: string) {
  try {
    await field.fill(value);
  } catch {
    throw new Error("A private enrollment field could not be filled.");
  }
}

async function waitBriefly(page: Page, milliseconds: number) {
  try {
    await page.waitForTimeout(milliseconds);
  } catch {
    throw new Error("The protected enrollment wait was interrupted.");
  }
}

async function signInAndDetectRole(page: Page, account: Credentials) {
  await safeGoto(page, "/");
  await fillPrivately(page.getByLabel("Email"), account.email);
  await fillPrivately(page.getByLabel("Password"), account.password);
  await page.getByRole("button", { name: "Sign in with Email" }).click();
  await enterTeacherShellFromAdminLanding(page);

  const teacherOverview = page.getByRole("heading", {
    name: "Teacher Overview",
    level: 1,
  });
  const teacherOnboarding = page.getByText("Set Up Your Workspace", {
    exact: true,
  });
  const studentOverview = page.getByRole("heading", { name: /^Welcome back,/ });

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

  if (await teacherOnboarding.isVisible()) {
    throw new Error(
      "The detected teacher account needs an existing staging workspace.",
    );
  }
  return (await teacherOverview.isVisible()) ? "teacher" : "student";
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

function matchesRpc(candidate: Response, functionName: string) {
  let pathname = "";
  try {
    pathname = new URL(candidate.url()).pathname;
  } catch {
    return false;
  }
  return (
    candidate.request().method() === "POST" &&
    pathname.endsWith(`/rest/v1/rpc/${functionName}`)
  );
}

async function observeRpcAction(
  page: Page,
  functionName: string,
  action: () => Promise<void>,
) {
  const responsePromise = page.waitForResponse(
    (candidate) => matchesRpc(candidate, functionName),
    { timeout: 15_000 },
  );
  try {
    await action();
    return await responsePromise;
  } catch {
    void responsePromise.catch(() => undefined);
    throw new Error(`The ${functionName} enrollment action did not complete.`);
  }
}

async function responseJson(response: Response | APIResponse) {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("An enrollment response could not be verified safely.");
  }
}

function parseJoinResult(value: unknown): JoinResult {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("The enrollment response did not contain one result.");
  }
  const row = value[0];
  if (!row || typeof row !== "object") {
    throw new Error("The enrollment result was not a safe record.");
  }
  const requestId = "request_id" in row ? row.request_id : null;
  const status = "status" in row ? row.status : null;
  if (
    typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestId,
    ) ||
    (status !== "pending" && status !== "approved")
  ) {
    throw new Error("The enrollment result contract was invalid.");
  }
  return { requestId, status };
}

async function assertSafeRejectedResponse(
  response: Response,
  expectedCode: "22023" | "P0002",
) {
  const value = await responseJson(response);
  if (response.status() >= 200 && response.status() < 300) {
    if (Array.isArray(value) && value.length === 0) return "empty" as const;
    throw new Error("The rejected enrollment code returned an enrollment row.");
  }
  if (response.status() < 400 || response.status() >= 500) {
    throw new Error(
      `The rejected enrollment request used unsafe status ${response.status()}.`,
    );
  }
  const code =
    value && typeof value === "object" && "code" in value ? value.code : null;
  if (code !== expectedCode) {
    throw new Error("The rejected enrollment request used an unexpected code.");
  }
  return "domain-error" as const;
}

function classCard(page: Page, className: string) {
  const codeAnchor = page.getByRole("button", {
    name: `Copy join code for ${className}`,
  });
  return {
    codeAnchor,
    card: codeAnchor.locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]",
    ),
  };
}

async function openAllClasses(page: Page) {
  await safeGoto(page, "/teacher/batches");
  await expect(
    page.getByRole("heading", { name: "Classes", level: 1 }),
  ).toBeVisible();
  await page.getByLabel("Filter classes by status").click();
  await page.getByRole("option", { name: "All Statuses" }).click();
}

async function createClass(page: Page, className: string) {
  await safeGoto(page, "/teacher/batches");
  await expect(
    page.getByRole("heading", { name: "Classes", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create Class" }).click();

  const dialog = page.getByRole("dialog", { name: "Create a class" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Class name").fill(className);
  await dialog.getByLabel("CEFR level").click();
  await page.getByRole("option", { name: CLASS_LEVEL, exact: true }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("radio", { name: /^Teacher review/ }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(
    dialog.getByText("Teacher approval required", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText(className, { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Create class" }).click();

  const { card, codeAnchor } = classCard(page, className);
  await expect(codeAnchor).toBeVisible({ timeout: 10_000 });
  const joinCode = (await card.locator("p.font-mono").textContent())?.trim();
  if (!joinCode || !/^[A-Z0-9]{8,16}$/.test(joinCode)) {
    throw new Error(
      "The edge-test class did not provide a valid private code.",
    );
  }
  return joinCode;
}

async function setClassActive(
  page: Page,
  className: string,
  shouldBeActive: boolean,
) {
  await openAllClasses(page);
  const { card, codeAnchor } = classCard(page, className);
  await expect(codeAnchor).toBeVisible({ timeout: 10_000 });
  const archive = card.getByRole("button", {
    name: "Archive Class",
    exact: true,
  });
  const reactivate = card.getByRole("button", {
    name: "Reactivate Class",
    exact: true,
  });

  if (shouldBeActive) {
    if ((await reactivate.count()) === 1) await reactivate.click();
    await expect(archive).toBeVisible({ timeout: 10_000 });
    return;
  }
  if ((await archive.count()) === 1) await archive.click();
  await expect(reactivate).toBeVisible({ timeout: 10_000 });
}

async function openTeacherStudents(page: Page) {
  await safeGoto(page, "/teacher/students");
  await expect(
    page.getByRole("heading", { name: "Students", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading students/ }),
  ).toHaveCount(0, { timeout: 15_000 });
}

async function fillAndWaitForRpc(
  page: Page,
  field: Locator,
  value: string,
  functionName: string,
) {
  const responsePromise = page.waitForResponse(
    (candidate) => matchesRpc(candidate, functionName),
    { timeout: 15_000 },
  );
  try {
    await fillPrivately(field, value);
    const response = await responsePromise;
    if (response.status() >= 400) {
      throw new Error("filtered-read-failed");
    }
  } catch {
    void responsePromise.catch(() => undefined);
    throw new Error("A private enrollment lookup did not complete.");
  }
}

async function filterRosterByStudent(page: Page, studentEmail: string) {
  await openTeacherStudents(page);
  await fillAndWaitForRpc(
    page,
    page.getByLabel("Search students"),
    studentEmail,
    "list_workspace_students_filtered_page",
  );
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading student page/ }),
  ).toHaveCount(0, { timeout: 10_000 });
}

async function membershipExists(page: Page, studentEmail: string) {
  await filterRosterByStudent(page, studentEmail);
  const removeAccess = page.getByRole("button", {
    name: "Remove access",
    exact: true,
  });
  const emptyState = page.getByRole("heading", {
    name: /No students (?:match these filters|yet)/,
  });
  await expect
    .poll(
      async () => (await removeAccess.count()) + (await emptyState.count()),
      { timeout: 5_000 },
    )
    .toBeGreaterThan(0);
  if ((await removeAccess.count()) > 1) {
    throw new Error("The staging enrollment student lookup was not unique.");
  }
  return (await removeAccess.count()) === 1;
}

function pendingRequestCard(page: Page, className: string) {
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const requestLine = page.getByText(
    new RegExp(`^${escapedClassName} · ${CLASS_LEVEL} · requested `),
  );
  return {
    requestLine,
    card: requestLine.locator(
      "xpath=ancestor::div[.//button[normalize-space()='Approve']][1]",
    ),
  };
}

async function assertNoPendingRequest(page: Page, className: string) {
  await openTeacherStudents(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /^Loading class-code requests/ }),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(pendingRequestCard(page, className).requestLine).toHaveCount(0);
}

async function submitRejectedCode(
  page: Page,
  joinCode: string,
  expectedCode: "22023" | "P0002",
  expectedMessage: string,
) {
  await safeGoto(page, "/student/dashboard");
  await fillPrivately(page.getByLabel("Class join code"), joinCode);
  const response = await observeRpcAction(
    page,
    "request_batch_join",
    async () => {
      await page.getByRole("button", { name: "Request Access" }).click();
    },
  );
  const rejectionKind = await assertSafeRejectedResponse(
    response,
    expectedCode,
  );
  await expect(
    page.getByText("Could not request class", { exact: true }).last(),
  ).toBeVisible({ timeout: 10_000 });
  const visibleMessage =
    rejectionKind === "empty"
      ? "This class code is invalid, inactive, or no longer available."
      : expectedMessage;
  await expect(
    page.getByText(visibleMessage, { exact: true }).last(),
  ).toBeVisible();
}

async function submitJoinCode(page: Page, joinCode: string) {
  await safeGoto(page, "/student/dashboard");
  await fillPrivately(page.getByLabel("Class join code"), joinCode);
  const response = await observeRpcAction(
    page,
    "request_batch_join",
    async () => {
      await page.getByRole("button", { name: "Request Access" }).click();
    },
  );
  if (response.status() >= 400) {
    throw new Error("The valid enrollment request was rejected.");
  }
  return parseJoinResult(await responseJson(response));
}

async function approveRequest(
  page: Page,
  studentEmail: string,
  className: string,
) {
  await openTeacherStudents(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /^Loading class-code requests/ }),
  ).toHaveCount(0, { timeout: 15_000 });
  await fillAndWaitForRpc(
    page,
    page.getByLabel("Search pending class-code requests"),
    studentEmail,
    "list_workspace_join_requests_filtered_page",
  );

  const request = pendingRequestCard(page, className);
  await expect(request.requestLine).toHaveCount(1);
  const response = await observeRpcAction(
    page,
    "decide_batch_join",
    async () => {
      await request.card
        .getByRole("button", { name: "Approve", exact: true })
        .click();
    },
  );
  if (response.status() >= 400) {
    throw new Error("The enrollment approval was rejected.");
  }
  const result = parseJoinResult(await responseJson(response));
  if (result.status !== "approved") {
    throw new Error("The enrollment approval did not reach approved state.");
  }
  await expect(
    page.getByText("Join request approved", { exact: true }).last(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(request.card).toBeHidden({ timeout: 10_000 });
  return { request: response.request(), result };
}

async function replayApprovedRequest(
  page: Page,
  approvedRequest: Request,
  expectedRequestId: string,
) {
  let replay: APIResponse;
  try {
    replay = await page.request.fetch(approvedRequest, {
      failOnStatusCode: false,
      timeout: 15_000,
    });
  } catch {
    throw new Error("The approved enrollment replay did not complete.");
  }
  try {
    if (replay.status() >= 400) {
      throw new Error("The approved enrollment replay was not idempotent.");
    }
    const result = parseJoinResult(await responseJson(replay));
    if (
      result.requestId !== expectedRequestId ||
      result.status !== "approved"
    ) {
      throw new Error("The approved enrollment replay changed identity.");
    }
  } finally {
    await replay.dispose();
  }
}

async function assertSingleCreatedAssignment(
  page: Page,
  studentEmail: string,
  className: string,
) {
  await filterRosterByStudent(page, studentEmail);
  await expect(
    page.getByRole("button", { name: `Remove ${className}`, exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Remove access", exact: true }),
  ).toHaveCount(1);
}

async function assertArchivedClassDoesNotStrandStudent(
  page: Page,
  className: string,
) {
  await safeGoto(page, "/student/dashboard");
  await safeReload(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Loading batch access" }),
  ).toHaveCount(0, { timeout: 15_000 });

  const joinAnotherClass = page.getByRole("button", {
    name: "Join another class",
    exact: true,
  });
  await expect(joinAnotherClass).toBeVisible();
  await joinAnotherClass.click();
  const joinDialog = page.getByRole("dialog", { name: "Join another class" });
  await expect(joinDialog).toBeVisible();
  await expect(joinDialog.getByLabel("Class code")).toBeVisible();
  await page.keyboard.press("Escape");

  await safeGoto(page, "/student/write?mode=free");
  const classSelector = page.getByLabel("Class receiving this writing");
  const noEligibleClass = page.getByText(
    "Join an active class that matches this task before submitting writing.",
    { exact: true },
  );
  await expect(classSelector).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () =>
        (await classSelector.isEnabled()) ||
        (await noEligibleClass.isVisible()),
      { timeout: 15_000 },
    )
    .toBe(true);
  if (await classSelector.isEnabled()) {
    await classSelector.click();
    await expect(
      page.getByRole("option", {
        name: `${className} · ${CLASS_LEVEL}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
  } else {
    await expect(noEligibleClass).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Join another class", exact: true }),
  ).toBeVisible();
}

async function rejectPendingRequestIfPresent(page: Page, className: string) {
  await openTeacherStudents(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /^Loading class-code requests/ }),
  ).toHaveCount(0, { timeout: 15_000 });
  const request = pendingRequestCard(page, className);
  const count = await request.requestLine.count();
  if (count === 0) return;
  if (count !== 1) {
    throw new Error("The cleanup enrollment request was not unique.");
  }
  await request.card
    .getByRole("button", { name: "Reject", exact: true })
    .click();
  await expect(request.card).toBeHidden({ timeout: 10_000 });
}

async function removeCreatedEnrollment(options: {
  page: Page;
  studentEmail: string;
  className: string;
  membershipExistedBefore: boolean | null;
}) {
  await filterRosterByStudent(options.page, options.studentEmail);
  const removeAssignment = options.page.getByRole("button", {
    name: `Remove ${options.className}`,
    exact: true,
  });

  if (options.membershipExistedBefore !== false) {
    if ((await removeAssignment.count()) === 1) {
      await removeAssignment.click();
      await expect(removeAssignment).toHaveCount(0, { timeout: 10_000 });
    }
    return;
  }

  const removeAccess = options.page.getByRole("button", {
    name: "Remove access",
    exact: true,
  });
  if ((await removeAccess.count()) === 0) return;
  if ((await removeAccess.count()) !== 1) {
    throw new Error("The cleanup enrollment student was not unique.");
  }
  const studentRow = removeAccess.locator("xpath=ancestor::tr[1]");
  const assignmentRemovals = studentRow.locator(
    'button[aria-label^="Remove "]',
  );
  if (
    (await assignmentRemovals.count()) !== 1 ||
    (await assignmentRemovals.first().getAttribute("aria-label")) !==
      `Remove ${options.className}`
  ) {
    throw new Error(
      "The new enrollment membership no longer contains exactly the fixture assignment.",
    );
  }

  await removeAccess.click();
  const alert = options.page.getByRole("alertdialog");
  await expect(alert).toBeVisible();
  await alert.getByRole("button", { name: "Remove student access" }).click();
  await expect(
    options.page.getByText(/^Offboarding completed for /).last(),
  ).toBeVisible({ timeout: 10_000 });
}

async function archiveEmptyClass(page: Page, className: string) {
  await openAllClasses(page);
  const { card, codeAnchor } = classCard(page, className);
  const exists = await codeAnchor
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!exists) return;

  const studentsRow = card
    .getByText("Students", { exact: true })
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' flex ') and contains(concat(' ', normalize-space(@class), ' '), ' justify-between ')][1]",
    );
  const studentCount = Number.parseInt(
    (await studentsRow.locator("span.font-semibold").textContent())?.trim() ??
      "",
    10,
  );
  if (!Number.isSafeInteger(studentCount) || studentCount !== 0) {
    throw new Error("The enrollment fixture class was not empty at cleanup.");
  }
  const archive = card.getByRole("button", {
    name: "Archive Class",
    exact: true,
  });
  if ((await archive.count()) === 1) await archive.click();
  await expect(
    card.getByRole("button", { name: "Reactivate Class", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
}

async function cleanupFixture(options: {
  teacherPage: Page;
  studentEmail: string;
  className: string;
  classMayExist: boolean;
  membershipExistedBefore: boolean | null;
}) {
  if (!options.classMayExist) return;
  const failures: string[] = [];
  await setClassActive(options.teacherPage, options.className, true).catch(() =>
    failures.push("reactivate"),
  );
  await rejectPendingRequestIfPresent(
    options.teacherPage,
    options.className,
  ).catch(() => failures.push("pending-request"));
  await removeCreatedEnrollment({
    page: options.teacherPage,
    studentEmail: options.studentEmail,
    className: options.className,
    membershipExistedBefore: options.membershipExistedBefore,
  }).catch(() => failures.push("enrollment"));
  await archiveEmptyClass(options.teacherPage, options.className).catch(() =>
    failures.push("archive"),
  );
  expect(failures, failures.join(",")).toEqual([]);
}

async function newPrivateContext(browser: Browser, baseURL: string) {
  return browser.newContext({
    baseURL,
    viewport: { width: 1366, height: 768 },
  });
}

test.skip(
  process.env.E2E_ENROLLMENT_EDGES !== "true",
  "Set E2E_ENROLLMENT_EDGES=true only for the isolated staging enrollment-edge run.",
);

test.describe
  .serial("authenticated enrollment security edge regressions", () => {
  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
  });

  test("invalid and inactive codes fail closed, approval replay is idempotent, and archive does not strand the student", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(300_000);
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error(
        "The enrollment-edge workflow needs a local base address.",
      );
    }

    const firstAccount = credentials("TEACHER");
    const secondAccount = credentials("STUDENT");
    if (
      firstAccount.email.toLowerCase() === secondAccount.email.toLowerCase()
    ) {
      throw new Error("Enrollment-edge accounts must be different.");
    }

    const firstContext = await newPrivateContext(browser, baseURL);
    const secondContext = await newPrivateContext(browser, baseURL);
    let teacherPage: Page | null = null;
    let studentPage: Page | null = null;
    let studentEmail = "";
    let membershipExistedBefore: boolean | null = null;
    let classMayExist = false;
    const className = `V1 enrollment edge ${Date.now().toString(36)}-${process.pid}`;
    const invalidCode = "!!!!!!!!";

    try {
      const firstPage = await firstContext.newPage();
      const secondPage = await secondContext.newPage();
      const assertNoFirstFailures = monitorFatalBrowserFailures(firstPage);
      const assertNoSecondFailures = monitorFatalBrowserFailures(secondPage);
      const firstRole = await signInAndDetectRole(firstPage, firstAccount);
      const secondRole = await signInAndDetectRole(secondPage, secondAccount);
      if (firstRole === secondRole) {
        throw new Error(
          "The two enrollment-edge accounts did not provide one teacher and one student.",
        );
      }

      if (firstRole === "teacher") {
        teacherPage = firstPage;
        studentPage = secondPage;
        studentEmail = secondAccount.email;
      } else {
        teacherPage = secondPage;
        studentPage = firstPage;
        studentEmail = firstAccount.email;
      }

      membershipExistedBefore = await membershipExists(
        teacherPage,
        studentEmail,
      );

      await submitRejectedCode(
        studentPage,
        invalidCode,
        "22023",
        "Some information was invalid. Review it and try again.",
      );

      classMayExist = true;
      const joinCode = await createClass(teacherPage, className);
      await setClassActive(teacherPage, className, false);
      await submitRejectedCode(
        studentPage,
        joinCode,
        "P0002",
        "This item is no longer available. Refresh and try again.",
      );
      await assertNoPendingRequest(teacherPage, className);

      await setClassActive(teacherPage, className, true);
      const pending = await submitJoinCode(studentPage, joinCode);
      if (pending.status !== "pending") {
        throw new Error("The active class did not create a pending request.");
      }
      const approval = await approveRequest(
        teacherPage,
        studentEmail,
        className,
      );
      if (approval.result.requestId !== pending.requestId) {
        throw new Error("The approved request changed enrollment identity.");
      }

      await replayApprovedRequest(
        teacherPage,
        approval.request,
        pending.requestId,
      );
      const repeatedJoin = await submitJoinCode(studentPage, joinCode);
      if (
        repeatedJoin.requestId !== pending.requestId ||
        repeatedJoin.status !== "approved"
      ) {
        throw new Error(
          "The approved class-code replay created a new request.",
        );
      }
      await assertSingleCreatedAssignment(teacherPage, studentEmail, className);

      await setClassActive(teacherPage, className, false);
      await assertArchivedClassDoesNotStrandStudent(studentPage, className);

      assertNoFirstFailures();
      assertNoSecondFailures();
    } finally {
      try {
        if (teacherPage && studentPage && studentEmail) {
          await cleanupFixture({
            teacherPage,
            studentEmail,
            className,
            classMayExist,
            membershipExistedBefore,
          });
        }
      } finally {
        await Promise.allSettled([firstContext.close(), secondContext.close()]);
      }
    }
  });
});
