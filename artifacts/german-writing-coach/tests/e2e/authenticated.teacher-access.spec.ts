import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";

type Credentials = { email: string; password: string };
type RuntimeTotpCode = { consume: () => string };
type BrowserResponse = Awaited<ReturnType<Page["waitForResponse"]>>;
type TeacherAccessStatus = "pending" | "approved" | "rejected" | "disabled";

type StudentAccessState = {
  status: TeacherAccessStatus;
  requestRevision: number;
  entitlementActive: boolean;
  entitlementRevision: number | null;
};

type AdminInventoryRow = {
  applicantUserId: string;
  applicantEmail: string | null;
  pageCursorId: string;
  requestStatus: TeacherAccessStatus;
  requestRevision: number | null;
  entitlementActive: boolean;
  entitlementRevision: number | null;
  privilegedWorkspaceCount: number;
  updatedAt: string;
};

type InventoryCursor = { updatedAt: string; id: string };

const ADMIN_PAGE_SIZE = 25;
const APPROVED_WORKSPACE_LIMIT = 2;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for teacher-access staging E2E.`);
  }
  return value;
}

function credentials(role: "ADMIN" | "STUDENT"): Credentials {
  return {
    email: requiredEnvironment(`E2E_${role}_EMAIL`),
    password: requiredEnvironment(`E2E_${role}_PASSWORD`),
  };
}

function runtimeAdminTotpCode(): RuntimeTotpCode {
  const code = requiredEnvironment("E2E_ADMIN_TOTP_CODE");
  if (!/^\d{6}$/.test(code)) {
    throw new Error(
      "E2E_ADMIN_TOTP_CODE must be a fresh six-digit runtime code.",
    );
  }
  let consumed = false;
  return {
    consume() {
      if (consumed) {
        throw new Error(
          "The runtime administrator TOTP code was already consumed. Rerun with a fresh code; TOTP values are never reused or generated from a stored factor secret.",
        );
      }
      consumed = true;
      return code;
    },
  };
}

function monitorFatalBrowserFailures(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror:${error.name}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push(`console_error:${message.location().lineNumber ?? 0}`);
    }
  });
  page.on("response", (candidate) => {
    if (candidate.status() >= 500) {
      failures.push(
        `http:${candidate.status()}:${candidate.request().resourceType()}`,
      );
    }
  });
  return () => expect(failures, failures.join("\n")).toEqual([]);
}

async function signIn(
  page: Page,
  account: Credentials,
  expectedRole: "admin" | "student",
  adminTotp?: RuntimeTotpCode,
) {
  await page.goto("/");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in with Email" }).click();

  if (expectedRole === "admin") {
    if (!adminTotp) {
      throw new Error("Administrator sign-in requires a runtime TOTP code.");
    }
    await page.waitForURL(
      (url) =>
        url.pathname === "/auth/mfa" ||
        url.pathname === "/admin/teacher-access",
      { timeout: 15_000 },
    );
    if (new URL(page.url()).pathname === "/auth/mfa") {
      await expect(
        page.getByRole("heading", {
          name: "Authenticator verification",
          level: 1,
        }),
      ).toBeVisible();
      const codeInput = page.getByLabel("Six-digit code");
      try {
        await expect(codeInput).toBeVisible({ timeout: 15_000 });
      } catch {
        if (
          await page
            .getByRole("button", { name: "Add authenticator" })
            .isVisible()
        ) {
          throw new Error(
            "The staging platform administrator must manually enroll and verify a primary and backup TOTP factor before this test. The browser test never captures a QR code or factor secret.",
          );
        }
        throw new Error(
          "The administrator MFA challenge was unavailable after sign-in.",
        );
      }
      await codeInput.fill(adminTotp.consume());
      await page.getByRole("button", { name: "Verify authenticator" }).click();
      try {
        await expect(
          page.getByText("Two-factor setup is complete", { exact: true }),
        ).toBeVisible({ timeout: 15_000 });
      } catch {
        if (
          await page
            .getByRole("button", { name: "Add authenticator" })
            .isVisible()
        ) {
          throw new Error(
            "The staging platform administrator needs a separately verified backup TOTP factor before this test can mutate teacher access.",
          );
        }
        throw new Error(
          "The fresh administrator TOTP code was not accepted. Rerun with a new current code.",
        );
      }
      await page.getByRole("button", { name: "Continue" }).click();
    }
    await expect(page).toHaveURL(/\/admin\/teacher-access$/, {
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", { name: "Teacher access", level: 1 }),
    ).toBeVisible();
    return;
  }

  await expect(page).toHaveURL(/\/student\/dashboard$/, { timeout: 15_000 });
  await expect(page.getByRole("main")).toBeVisible();
}

function isRpcResponse(candidate: BrowserResponse, functionName: string) {
  try {
    return (
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname.endsWith(`/rest/v1/rpc/${functionName}`)
    );
  } catch {
    return false;
  }
}

function waitForRpc(page: Page, functionName: string) {
  return page.waitForResponse(
    (candidate) => isRpcResponse(candidate, functionName),
    { timeout: 15_000 },
  );
}

function assertSuccessfulRpc(response: BrowserResponse, action: string) {
  if (response.status() >= 400) {
    throw new Error(`${action} returned a safe non-success response.`);
  }
}

async function assertSuccessfulAdminMutation(
  page: Page,
  response: BrowserResponse,
  action: string,
) {
  if (response.status() < 400) return;
  const reauthenticationDialog = page.getByRole("dialog", {
    name: "Confirm administrator action",
  });
  const requiresFreshTotp = await reauthenticationDialog
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (requiresFreshTotp) {
    throw new Error(
      `${action} requires another fresh runtime TOTP code. Stop and rerun with a new code; the test will not reuse a consumed value or store a factor secret.`,
    );
  }
  throw new Error(`${action} returned a safe non-success response.`);
}

async function responseRows(response: BrowserResponse, action: string) {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${action} returned an unreadable response.`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`${action} returned an invalid row collection.`);
  }
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${action} returned an invalid row.`);
    }
    return row as Record<string, unknown>;
  });
}

function teacherAccessStatus(
  value: unknown,
  action: string,
): TeacherAccessStatus {
  if (
    value !== "pending" &&
    value !== "approved" &&
    value !== "rejected" &&
    value !== "disabled"
  ) {
    throw new Error(`${action} returned an invalid status.`);
  }
  return value;
}

function positiveInteger(value: unknown, action: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${action} returned an invalid revision.`);
  }
  return value;
}

function nullablePositiveInteger(value: unknown, action: string) {
  return value === null ? null : positiveInteger(value, action);
}

function nonnegativeInteger(value: unknown, action: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${action} returned an invalid count.`);
  }
  return value;
}

function parseStudentAccessRows(
  rows: Record<string, unknown>[],
): StudentAccessState | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error("Teacher-access status was not unique.");
  }
  const row = rows[0]!;
  if (typeof row.entitlement_active !== "boolean") {
    throw new Error("Teacher-access status returned an invalid entitlement.");
  }
  return {
    status: teacherAccessStatus(row.request_status, "Teacher-access status"),
    requestRevision: positiveInteger(
      row.request_revision,
      "Teacher-access status",
    ),
    entitlementActive: row.entitlement_active,
    entitlementRevision: nullablePositiveInteger(
      row.entitlement_revision,
      "Teacher-access status",
    ),
  };
}

async function loadStudentAccess(page: Page, reload = false) {
  const responsePromise = waitForRpc(page, "get_my_teacher_access_request");
  if (reload) {
    await page.reload();
  } else {
    await page.goto("/teacher-access");
  }
  const response = await responsePromise;
  assertSuccessfulRpc(response, "Teacher-access status");
  return parseStudentAccessRows(
    await responseRows(response, "Teacher-access status"),
  );
}

function parseInventoryRows(rows: Record<string, unknown>[]) {
  return rows.map((row): AdminInventoryRow => {
    const applicantUserId = row.applicant_user_id;
    const applicantEmail = row.applicant_email;
    const pageCursorId = row.page_cursor_id;
    const requestRevision = row.request_revision;
    const entitlementRevision = row.entitlement_revision;
    const updatedAt = row.updated_at;
    if (typeof applicantUserId !== "string" || !applicantUserId) {
      throw new Error("Teacher inventory returned an invalid account id.");
    }
    if (applicantEmail !== null && typeof applicantEmail !== "string") {
      throw new Error("Teacher inventory returned an invalid applicant.");
    }
    if (typeof pageCursorId !== "string" || !pageCursorId) {
      throw new Error("Teacher inventory returned an invalid page cursor.");
    }
    if (typeof row.entitlement_active !== "boolean") {
      throw new Error("Teacher inventory returned an invalid entitlement.");
    }
    if (
      typeof updatedAt !== "string" ||
      !Number.isFinite(Date.parse(updatedAt))
    ) {
      throw new Error("Teacher inventory returned an invalid update time.");
    }
    return {
      applicantUserId,
      applicantEmail,
      pageCursorId,
      requestStatus: teacherAccessStatus(
        row.request_status,
        "Teacher inventory",
      ),
      requestRevision:
        requestRevision === null
          ? null
          : positiveInteger(requestRevision, "Teacher inventory"),
      entitlementActive: row.entitlement_active,
      entitlementRevision:
        entitlementRevision === null
          ? null
          : positiveInteger(entitlementRevision, "Teacher inventory"),
      privilegedWorkspaceCount: nonnegativeInteger(
        row.privileged_workspace_count,
        "Teacher inventory",
      ),
      updatedAt,
    };
  });
}

const filterLabels: Record<TeacherAccessStatus, string> = {
  pending: "Pending requests",
  approved: "Approved teachers",
  rejected: "Rejected requests",
  disabled: "Disabled access",
};

function inventoryRequestMatches(
  candidate: BrowserResponse,
  status: TeacherAccessStatus | null,
  cursor: InventoryCursor | null,
) {
  if (!isRpcResponse(candidate, "list_teacher_access_requests")) return false;
  let payload: unknown;
  try {
    payload = candidate.request().postDataJSON();
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const body = payload as Record<string, unknown>;
  return (
    body.target_status === status &&
    body.requested_page_size === ADMIN_PAGE_SIZE + 1 &&
    body.cursor_updated_at === (cursor?.updatedAt ?? null) &&
    body.cursor_id === (cursor?.id ?? null)
  );
}

function waitForInventoryRpc(
  page: Page,
  status: TeacherAccessStatus | null,
  cursor: InventoryCursor | null,
) {
  return page.waitForResponse(
    (candidate) => inventoryRequestMatches(candidate, status, cursor),
    { timeout: 15_000 },
  );
}

async function findApplicantCard(
  page: Page,
  applicantEmail: string,
  status: TeacherAccessStatus,
): Promise<{ card: Locator; row: AdminInventoryRow } | null> {
  let responsePromise = waitForInventoryRpc(page, null, null);
  await page.goto("/admin/teacher-access");
  let response = await responsePromise;
  assertSuccessfulRpc(response, "Teacher inventory");

  responsePromise = waitForInventoryRpc(page, status, null);
  await page.getByLabel("Filter teacher access").click();
  await page.getByRole("option", { name: filterLabels[status] }).click();
  response = await responsePromise;
  assertSuccessfulRpc(response, "Filtered teacher inventory");

  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const rows = parseInventoryRows(
      await responseRows(response, "Filtered teacher inventory"),
    );
    const visibleRows = rows.slice(0, ADMIN_PAGE_SIZE);
    const applicantIndex = visibleRows.findIndex(
      (row) => row.applicantEmail === applicantEmail,
    );

    if (applicantIndex >= 0) {
      const row = visibleRows[applicantIndex]!;
      const card = page.locator(
        `[data-testid="teacher-access-account"][data-applicant-user-id="${row.applicantUserId}"]`,
      );
      await expect(card).toHaveCount(1, { timeout: 10_000 });
      return {
        card,
        row,
      };
    }

    if (rows.length <= ADMIN_PAGE_SIZE) return null;
    const lastVisibleRow = visibleRows.at(-1);
    if (!lastVisibleRow) {
      throw new Error("Teacher inventory returned an empty paginated page.");
    }
    responsePromise = waitForInventoryRpc(page, status, {
      updatedAt: lastVisibleRow.updatedAt,
      id: lastVisibleRow.pageCursorId,
    });
    await page.getByRole("button", { name: "Next", exact: true }).click();
    response = await responsePromise;
    assertSuccessfulRpc(response, "Teacher inventory page");
  }

  throw new Error("Teacher inventory pagination exceeded its safety limit.");
}

function rpcPayload(response: BrowserResponse, action: string) {
  let value: unknown;
  try {
    value = response.request().postDataJSON();
  } catch {
    throw new Error(`${action} did not send a readable request.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${action} did not send a valid request.`);
  }
  return value as Record<string, unknown>;
}

async function rejectApplicant(adminPage: Page, applicantEmail: string) {
  const match = await findApplicantCard(adminPage, applicantEmail, "pending");
  if (!match || match.row.requestRevision === null) {
    throw new Error("Pending applicant was not available for rejection.");
  }
  const responsePromise = waitForRpc(adminPage, "decide_teacher_access");
  await match.card.getByRole("button", { name: "Reject", exact: true }).click();
  const response = await responsePromise;
  await assertSuccessfulAdminMutation(
    adminPage,
    response,
    "Teacher-access rejection",
  );
  const payload = rpcPayload(response, "Teacher-access rejection");
  if (
    payload.decision !== "rejected" ||
    payload.expected_revision !== match.row.requestRevision
  ) {
    throw new Error(
      "Teacher-access rejection did not use the current revision.",
    );
  }
}

async function approveApplicant(adminPage: Page, applicantEmail: string) {
  const match = await findApplicantCard(adminPage, applicantEmail, "pending");
  if (!match || match.row.requestRevision === null) {
    throw new Error("Pending applicant was not available for approval.");
  }
  if (match.row.privilegedWorkspaceCount !== 0) {
    throw new Error("Disposable applicant has privileged workspace access.");
  }

  await match.card
    .getByLabel("Workspace limit")
    .fill(String(APPROVED_WORKSPACE_LIMIT));
  const responsePromise = waitForRpc(adminPage, "decide_teacher_access");
  await match.card
    .getByRole("button", { name: "Approve teacher", exact: true })
    .click();
  const response = await responsePromise;
  await assertSuccessfulAdminMutation(
    adminPage,
    response,
    "Teacher-access approval",
  );
  const payload = rpcPayload(response, "Teacher-access approval");
  if (
    payload.decision !== "approved" ||
    payload.expected_revision !== match.row.requestRevision ||
    payload.approved_workspace_limit !== APPROVED_WORKSPACE_LIMIT
  ) {
    throw new Error(
      "Teacher-access approval did not use its current revision and limit.",
    );
  }

  const rows = await responseRows(response, "Teacher-access approval");
  if (
    rows.length !== 1 ||
    rows[0]!.request_status !== "approved" ||
    rows[0]!.entitlement_max_workspaces !== APPROVED_WORKSPACE_LIMIT
  ) {
    throw new Error("Teacher-access approval returned an invalid result.");
  }
  await expect(
    adminPage.getByText("Teacher access approved", { exact: true }),
  ).toBeVisible();
}

async function disableApplicant(adminPage: Page, applicantEmail: string) {
  const match = await findApplicantCard(adminPage, applicantEmail, "approved");
  if (
    !match ||
    !match.row.entitlementActive ||
    match.row.entitlementRevision === null
  ) {
    throw new Error("Active applicant was not available for safe disabling.");
  }
  if (match.row.privilegedWorkspaceCount !== 1) {
    throw new Error(
      "Approved applicant did not retain exactly one default teaching area.",
    );
  }

  await match.card
    .getByRole("button", { name: "Disable access", exact: true })
    .click();
  const dialog = adminPage.getByRole("alertdialog", {
    name: "Disable teacher access?",
  });
  await expect(dialog).toBeVisible();
  const responsePromise = waitForRpc(adminPage, "disable_teacher_access");
  await dialog
    .getByRole("button", { name: "Disable teacher", exact: true })
    .click();
  const response = await responsePromise;
  await assertSuccessfulAdminMutation(
    adminPage,
    response,
    "Teacher-access disable",
  );
  const payload = rpcPayload(response, "Teacher-access disable");
  if (payload.expected_entitlement_revision !== match.row.entitlementRevision) {
    throw new Error("Teacher-access disable did not use the current revision.");
  }
  const rows = await responseRows(response, "Teacher-access disable");
  if (
    rows.length !== 1 ||
    rows[0]!.transferred_workspace_count !== 1 ||
    rows[0]!.removed_privileged_membership_count !== 1
  ) {
    throw new Error(
      "Disposable applicant cleanup did not transfer the default teaching area exactly once.",
    );
  }
  await expect(
    adminPage.getByText("Teacher access disabled", { exact: true }),
  ).toBeVisible();
}

async function requestApplicantAccess(
  studentPage: Page,
  current: StudentAccessState | null,
) {
  if (current?.status === "pending" || current?.entitlementActive) {
    throw new Error("Applicant state was not requestable.");
  }
  const buttonName = current
    ? "Request teacher access again"
    : "Request teacher access";
  const responsePromise = waitForRpc(studentPage, "request_teacher_access");
  await studentPage
    .getByRole("button", { name: buttonName, exact: true })
    .click();
  const response = await responsePromise;
  assertSuccessfulRpc(response, "Teacher-access request");
  const rows = await responseRows(response, "Teacher-access request");
  if (rows.length !== 1 || rows[0]!.request_status !== "pending") {
    throw new Error("Teacher-access request did not reach pending state.");
  }
  await expect(
    studentPage.getByText("Under review", { exact: true }),
  ).toBeVisible();
}

function assertDisposableRequestBaseline(current: StudentAccessState | null) {
  if (
    current?.entitlementActive ||
    (current?.status !== undefined &&
      current.status !== "rejected" &&
      current.status !== "disabled")
  ) {
    throw new Error(
      "Disposable applicant must start with no request, rejected access, or disabled access.",
    );
  }
}

async function cleanupApplicantState(
  adminPage: Page,
  studentPage: Page,
  applicantEmail: string,
) {
  const current = await loadStudentAccess(studentPage);
  if (current?.entitlementActive) {
    await disableApplicant(adminPage, applicantEmail);
  } else if (current?.status === "pending") {
    await rejectApplicant(adminPage, applicantEmail);
  }
}

async function runTeacherAccessWorkflow(browser: Browser) {
  const adminContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const studentPage = await studentContext.newPage();
  const assertNoAdminFailures = monitorFatalBrowserFailures(adminPage);
  const assertNoStudentFailures = monitorFatalBrowserFailures(studentPage);
  const admin = credentials("ADMIN");
  const applicant = credentials("STUDENT");
  const adminTotp = runtimeAdminTotpCode();
  let adminSignedIn = false;
  let studentSignedIn = false;
  let workflowMutationStarted = false;
  let exactDisableVerified = false;

  try {
    await signIn(adminPage, admin, "admin", adminTotp);
    adminSignedIn = true;
    await signIn(studentPage, applicant, "student");
    studentSignedIn = true;

    // The same learner session must fail closed at the protected admin route.
    await studentPage.goto("/admin/teacher-access");
    await expect(studentPage).toHaveURL(/\/student\/dashboard$/, {
      timeout: 15_000,
    });
    await expect(studentPage.getByRole("main")).toBeVisible();

    const requestableState = await loadStudentAccess(studentPage);
    assertDisposableRequestBaseline(requestableState);
    workflowMutationStarted = true;
    await requestApplicantAccess(studentPage, requestableState);
    await approveApplicant(adminPage, applicant.email);

    const approved = await loadStudentAccess(studentPage, true);
    if (
      approved?.status !== "approved" ||
      !approved.entitlementActive ||
      approved.entitlementRevision === null
    ) {
      throw new Error("Applicant refresh did not activate teacher access.");
    }
    await expect(
      studentPage.getByText("Your verified teacher access is active.", {
        exact: true,
      }),
    ).toBeVisible();
    const firstClassLink = studentPage.getByRole("link", {
      name: "Create your first class",
    });
    await expect(firstClassLink).toBeVisible();
    await firstClassLink.click();
    await expect(studentPage).toHaveURL(/\/teacher\/batches$/);
    await expect(
      studentPage.getByRole("dialog", { name: "Create a class" }),
    ).toBeVisible();
    const firstClassName = `E2E First Class ${Date.now()}`;
    await studentPage.getByLabel("Class name").fill(firstClassName);
    for (let step = 0; step < 4; step += 1) {
      await studentPage.getByRole("button", { name: "Continue" }).click();
    }
    const createBatchResponse = waitForRpc(
      studentPage,
      "create_workspace_batch",
    );
    await studentPage.getByRole("button", { name: "Create class" }).click();
    const created = await createBatchResponse;
    assertSuccessfulRpc(created, "First-class creation");
    await expect(
      studentPage.getByText("Class created", { exact: true }),
    ).toBeVisible();
    await expect(
      studentPage.getByText(firstClassName, { exact: true }),
    ).toBeVisible();

    // Cleanup is intentionally performed through the same revision-safe UI.
    await disableApplicant(adminPage, applicant.email);
    const disabled = await loadStudentAccess(studentPage, true);
    if (disabled?.status !== "disabled" || disabled.entitlementActive) {
      throw new Error("Teacher-access cleanup did not reach disabled state.");
    }
    exactDisableVerified = true;

    // Disabling teacher privileges must preserve the account's learner access.
    await studentPage.goto("/student/dashboard");
    await expect(studentPage).toHaveURL(/\/student\/dashboard$/);
    await expect(studentPage.getByRole("main")).toBeVisible();
    await expect(
      studentPage.getByRole("button", { name: "Join another class" }),
    ).toBeVisible();

    assertNoAdminFailures();
    assertNoStudentFailures();
  } finally {
    const cleanupFailures: string[] = [];
    if (
      adminSignedIn &&
      studentSignedIn &&
      workflowMutationStarted &&
      !exactDisableVerified
    ) {
      await cleanupApplicantState(
        adminPage,
        studentPage,
        applicant.email,
      ).catch(() => cleanupFailures.push("teacher-access-state"));
    }
    await adminContext
      .close()
      .catch(() => cleanupFailures.push("admin-context"));
    await studentContext
      .close()
      .catch(() => cleanupFailures.push("student-context"));
    expect(cleanupFailures, cleanupFailures.join(",")).toEqual([]);
  }
}

test.skip(
  process.env.E2E_MUTATIONS !== "true",
  "Set E2E_MUTATIONS=true only for the isolated staging mutation run.",
);

test.describe.serial("platform-admin teacher onboarding", () => {
  test.describe.configure({ retries: 0 });
  test.use({ viewport: { width: 1366, height: 768 } });

  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
    expect(requiredEnvironment("E2E_TEACHER_ACCESS_DISPOSABLE")).toBe("true");
  });

  test("student requests access and the admin safely approves then disables it", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    await runTeacherAccessWorkflow(browser);
  });
});
