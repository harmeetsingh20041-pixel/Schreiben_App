import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import { enterTeacherShellFromAdminLanding } from "./helpers/authenticated-role-navigation";

type Credentials = { email: string; password: string };

const CLASS_LEVEL = "A1";

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the authenticated core workflow.`);
  }
  return value;
}

function credentials(role: "TEACHER" | "STUDENT"): Credentials {
  return {
    email: requiredEnvironment(`E2E_${role}_EMAIL`),
    password: requiredEnvironment(`E2E_${role}_PASSWORD`),
  };
}

async function signIn(
  page: Page,
  account: Credentials,
  role: "teacher" | "student",
) {
  await page.goto("/");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in with Email" }).click();

  if (role === "teacher") {
    await enterTeacherShellFromAdminLanding(page);
    await expect(page).toHaveURL(/\/teacher\/(?:dashboard|onboarding)$/, {
      timeout: 15_000,
    });
    if (page.url().endsWith("/teacher/onboarding")) {
      throw new Error(
        "The teacher workflow account must have an existing staging workspace.",
      );
    }
    return;
  }

  await expect(page).toHaveURL(/\/student\/dashboard$/, { timeout: 15_000 });
}

function monitorFatalBrowserFailures(page: Page) {
  const failures: string[] = [];
  let abortedAuthRequests = 0;
  let authFetchConsoleErrors = 0;
  page.on("pageerror", (error) => failures.push(`pageerror:${error.name}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const rawMessage = message.text();
    if (
      rawMessage.includes("TypeError: Failed to fetch") &&
      rawMessage.includes("SupabaseAuthClient.getUser")
    ) {
      authFetchConsoleErrors += 1;
      return;
    }
    const sourcePath = (() => {
      try {
        return new URL(message.location().url).pathname;
      } catch {
        return "browser";
      }
    })();
    const safeMessage = rawMessage
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/https?:\/\/[^\s]+/gi, "[url]")
      .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
      .slice(0, 240);
    const pagePath = (() => {
      try {
        return new URL(page.url()).pathname;
      } catch {
        return "unknown";
      }
    })();
    failures.push(`console_error:${pagePath}:${sourcePath}:${safeMessage}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(
        `http:${response.status()}:${response.request().resourceType()}`,
      );
    }
  });
  page.on("requestfailed", (request) => {
    let pathname = "unknown";
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      // Keep the diagnostic path generic.
    }
    if (pathname === "/auth/v1/user") {
      if (request.failure()?.errorText === "net::ERR_ABORTED") {
        abortedAuthRequests += 1;
        return;
      }
      failures.push(
        `request_failed:${pathname}:${request.failure()?.errorText ?? "unknown"}`,
      );
    }
  });
  return () => {
    if (authFetchConsoleErrors > abortedAuthRequests) {
      failures.push(
        `unmatched_auth_fetch_failures:${authFetchConsoleErrors - abortedAuthRequests}`,
      );
    }
    expect(failures, failures.join("\n")).toEqual([]);
  };
}

async function waitForRpc(page: Page, functionName: string) {
  const response = await page.waitForResponse(
    (candidate) => {
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
    },
    { timeout: 15_000 },
  );
  if (response.status() >= 400) {
    throw new Error(`The ${functionName} staging read failed.`);
  }
}

async function fillAndWaitForRpc(
  page: Page,
  field: Locator,
  value: string,
  functionName: string,
) {
  const response = waitForRpc(page, functionName);
  await field.fill(value);
  await response;
}

async function openTeacherStudents(page: Page) {
  await page.goto("/teacher/students");
  await expect(
    page.getByRole("heading", { name: "Students", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading students/ }),
  ).toHaveCount(0, { timeout: 15_000 });
}

async function filterRosterByStudentEmail(page: Page, email: string) {
  await openTeacherStudents(page);
  await fillAndWaitForRpc(
    page,
    page.getByLabel("Search students"),
    email,
    "list_workspace_students_filtered_page",
  );
  await expect(
    page.getByRole("status").filter({ hasText: /^Loading student page/ }),
  ).toHaveCount(0, { timeout: 10_000 });
}

async function teacherMembershipExists(page: Page, studentEmail: string) {
  await filterRosterByStudentEmail(page, studentEmail);
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
  const membershipCount = await removeAccess.count();
  if (membershipCount > 1) {
    throw new Error("The staging student lookup was not unique.");
  }
  return membershipCount === 1;
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

async function createClass(page: Page, className: string) {
  await page.goto("/teacher/batches");
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
      "The created staging class did not expose a valid join code.",
    );
  }
  return joinCode;
}

async function submitJoinRequest(
  page: Page,
  joinCode: string,
  className: string,
) {
  await page.goto("/student/dashboard");
  await page.getByLabel("Class join code").fill(joinCode);
  await page.getByRole("button", { name: "Request Access" }).click();
  await expect(
    page.getByText("Request sent", { exact: true }).last(),
  ).toBeVisible({ timeout: 10_000 });

  const requestSummary = page
    .getByText(`${className} · ${CLASS_LEVEL}`, { exact: true })
    .locator("..");
  await expect(
    requestSummary.getByText("pending", { exact: true }),
  ).toBeVisible();
}

async function approveJoinRequest(
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

  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const requestLine = page.getByText(
    new RegExp(`^${escapedClassName} · ${CLASS_LEVEL} · requested `),
  );
  const requestCard = requestLine.locator(
    "xpath=ancestor::div[.//button[normalize-space()='Approve']][1]",
  );
  await expect(requestCard).toHaveCount(1);
  await requestCard
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await expect(
    page.getByText("Join request approved", { exact: true }).last(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(requestCard).toBeHidden({ timeout: 10_000 });
}

function visibleWorkspaceSelector(page: Page) {
  return page.getByLabel("Active workspace and role").filter({ visible: true });
}

async function selectClassInCurrentWorkspace(page: Page, className: string) {
  await page.goto("/student/write?mode=free");
  const classSelector = page.getByLabel("Class receiving this writing");
  const available = await classSelector
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!available) return false;
  const noEligibleClass = page.getByText(
    "Join an active class that matches this task before submitting writing.",
    { exact: true },
  );
  await expect
    .poll(
      async () =>
        (await classSelector.isEnabled()) ||
        (await noEligibleClass.isVisible()),
      { timeout: 15_000 },
    )
    .toBe(true);
  if (!(await classSelector.isEnabled())) return false;

  await classSelector.click();
  const classOption = page.getByRole("option", {
    name: `${className} · ${CLASS_LEVEL}`,
    exact: true,
  });
  if ((await classOption.count()) !== 1) {
    await page.keyboard.press("Escape");
    return false;
  }
  await classOption.click();
  await expect(classSelector).toContainText(className);
  return true;
}

async function selectCreatedStudentClass(page: Page, className: string) {
  await page.goto("/student/dashboard");
  const workspaceSelector = visibleWorkspaceSelector(page);
  let studentWorkspaceNames: string[] = [];

  if ((await workspaceSelector.count()) === 1) {
    await workspaceSelector.click();
    studentWorkspaceNames = (await page.getByRole("option").allTextContents())
      .map((name) => name.trim())
      .filter((name) => name.endsWith(" · student"));
    await page.keyboard.press("Escape");
  }

  if (await selectClassInCurrentWorkspace(page, className)) return;

  for (const workspaceName of studentWorkspaceNames) {
    await page.goto("/student/dashboard");
    const selector = visibleWorkspaceSelector(page);
    if ((await selector.count()) !== 1) continue;
    await selector.click();
    const option = page.getByRole("option", {
      name: workspaceName,
      exact: true,
    });
    if ((await option.count()) !== 1) {
      await page.keyboard.press("Escape");
      continue;
    }
    await option.click();
    await expect(page).toHaveURL(/\/student\/dashboard$/, { timeout: 10_000 });
    if (await selectClassInCurrentWorkspace(page, className)) return;
  }

  throw new Error(
    "The approved staging class was not available in any student workspace.",
  );
}

async function rejectPendingRequestIfPresent(
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

  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const requestLine = page.getByText(
    new RegExp(`^${escapedClassName} · ${CLASS_LEVEL} · requested `),
  );
  if ((await requestLine.count()) === 0) return;
  const requestCard = requestLine.locator(
    "xpath=ancestor::div[.//button[normalize-space()='Reject']][1]",
  );
  await requestCard
    .getByRole("button", { name: "Reject", exact: true })
    .click();
  await expect(requestCard).toBeHidden({ timeout: 10_000 });
}

async function removeCreatedEnrollment(
  page: Page,
  studentEmail: string,
  className: string,
  membershipExistedBeforeRun: boolean,
) {
  await filterRosterByStudentEmail(page, studentEmail);

  if (membershipExistedBeforeRun) {
    const removeAssignment = page.getByRole("button", {
      name: `Remove ${className}`,
      exact: true,
    });
    if ((await removeAssignment.count()) === 1) {
      await removeAssignment.click();
      await expect(removeAssignment).toBeHidden({ timeout: 10_000 });
    }
    return;
  }

  const removeAccess = page.getByRole("button", {
    name: "Remove access",
    exact: true,
  });
  if ((await removeAccess.count()) === 0) return;
  if ((await removeAccess.count()) !== 1) {
    throw new Error("The staging cleanup student lookup was not unique.");
  }
  const studentRow = removeAccess.locator("xpath=ancestor::tr[1]");
  const assignmentRemovals = studentRow.locator(
    'button[aria-label^="Remove "]',
  );
  const assignmentCount = await assignmentRemovals.count();
  if (assignmentCount > 1) {
    throw new Error(
      "The new staging membership gained another class during the workflow; cleanup stopped safely.",
    );
  }
  if (
    assignmentCount === 1 &&
    (await assignmentRemovals.first().getAttribute("aria-label")) !==
      `Remove ${className}`
  ) {
    throw new Error(
      "The new staging membership no longer contains only the workflow class; cleanup stopped safely.",
    );
  }
  await removeAccess.click();
  const alert = page.getByRole("alertdialog");
  await expect(alert).toBeVisible();
  await alert.getByRole("button", { name: "Remove student access" }).click();
  await expect(
    page.getByText(/^Offboarding completed for /).last(),
  ).toBeVisible({ timeout: 10_000 });
}

async function archiveCreatedClass(page: Page, className: string) {
  await page.goto("/teacher/batches");
  await expect(
    page.getByRole("heading", { name: "Classes", level: 1 }),
  ).toBeVisible();
  await page.getByLabel("Filter classes by status").click();
  await page.getByRole("option", { name: "All Statuses" }).click();

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
  const remainingStudentText = (
    await studentsRow.locator("span.font-semibold").textContent()
  )?.trim();
  const remainingStudents = Number.parseInt(remainingStudentText ?? "", 10);
  const archive = card.getByRole("button", {
    name: "Archive Class",
    exact: true,
  });
  if ((await archive.count()) === 1) {
    await archive.click();
    await expect(
      card.getByRole("button", { name: "Reactivate Class", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  }
  if (!Number.isSafeInteger(remainingStudents) || remainingStudents !== 0) {
    throw new Error(
      "The created staging class still had a current assignment after cleanup.",
    );
  }
}

async function newPrivateContext(browser: Browser, baseURL: string) {
  return browser.newContext({
    baseURL,
    viewport: { width: 1366, height: 768 },
  });
}

test.skip(
  process.env.E2E_CORE_WORKFLOW !== "true",
  "Set E2E_CORE_WORKFLOW=true only for the isolated staging core-workflow run.",
);

test.describe
  .serial("authenticated real teacher and student core workflow", () => {
  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
  });

  test("teacher creates a class, student requests access, teacher approves, and student selects the class", async ({
    browser,
  }, testInfo) => {
    // A human supplies the platform-admin TOTP only after the browser reaches
    // the challenge. Keep that safe wait outside the normal workflow budget.
    test.setTimeout(300_000);
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error("Authenticated core workflow requires a local base URL.");
    }

    const teacherAccount = credentials("TEACHER");
    const studentAccount = credentials("STUDENT");
    if (
      teacherAccount.email.toLowerCase() === studentAccount.email.toLowerCase()
    ) {
      throw new Error(
        "Teacher and student workflow accounts must be different.",
      );
    }

    const teacherContext = await newPrivateContext(browser, baseURL);
    const studentContext = await newPrivateContext(browser, baseURL);
    const teacherPage = await teacherContext.newPage();
    const studentPage = await studentContext.newPage();
    const assertNoTeacherFailures = monitorFatalBrowserFailures(teacherPage);
    const assertNoStudentFailures = monitorFatalBrowserFailures(studentPage);
    const className = `V1 core ${Date.now().toString(36)}-${process.pid}`;
    let membershipExistedBeforeRun = false;
    let classCreationMayHaveOccurred = false;
    let joinRequestMayHaveOccurred = false;

    try {
      await signIn(teacherPage, teacherAccount, "teacher");
      membershipExistedBeforeRun = await teacherMembershipExists(
        teacherPage,
        studentAccount.email,
      );

      classCreationMayHaveOccurred = true;
      const joinCode = await createClass(teacherPage, className);

      await signIn(studentPage, studentAccount, "student");
      joinRequestMayHaveOccurred = true;
      await submitJoinRequest(studentPage, joinCode, className);
      await approveJoinRequest(teacherPage, studentAccount.email, className);

      await studentPage.reload();
      await expect(studentPage).toHaveURL(/\/student\/dashboard$/);
      await selectCreatedStudentClass(studentPage, className);
      await studentPage.goto("/student/questions");
      await expect(
        studentPage.getByRole("heading", { name: "Writing Tasks", level: 1 }),
      ).toBeVisible();
      const writingClass = studentPage.getByLabel("Class for this writing");
      if ((await writingClass.count()) === 1) {
        await expect(writingClass).toContainText(className);
      }

      assertNoTeacherFailures();
      assertNoStudentFailures();
    } finally {
      const cleanupFailures: string[] = [];
      if (classCreationMayHaveOccurred) {
        if (joinRequestMayHaveOccurred) {
          await rejectPendingRequestIfPresent(
            teacherPage,
            studentAccount.email,
            className,
          ).catch(() => cleanupFailures.push("join-request"));
          await removeCreatedEnrollment(
            teacherPage,
            studentAccount.email,
            className,
            membershipExistedBeforeRun,
          ).catch(() => cleanupFailures.push("student-enrollment"));
        }
        await archiveCreatedClass(teacherPage, className).catch(() =>
          cleanupFailures.push("class-archive"),
        );
      }
      await Promise.allSettled([
        teacherContext.close(),
        studentContext.close(),
      ]);
      expect(cleanupFailures, cleanupFailures.join(",")).toEqual([]);
    }
  });
});
