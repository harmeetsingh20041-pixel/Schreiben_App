import { expect, test, type Page } from "@playwright/test";
import { enterTeacherShellFromAdminLanding } from "./helpers/authenticated-role-navigation";

type TeacherCredentials = { email: string; password: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for staging mutations.`);
  return value;
}

function teacherCredentials(): TeacherCredentials {
  return {
    email: requiredEnvironment("E2E_TEACHER_EMAIL"),
    password: requiredEnvironment("E2E_TEACHER_PASSWORD"),
  };
}

function teacherWorkspaceMembershipId() {
  const value = requiredEnvironment("E2E_TEACHER_WORKSPACE_MEMBERSHIP_ID");
  if (!UUID_PATTERN.test(value)) {
    throw new Error(
      "E2E_TEACHER_WORKSPACE_MEMBERSHIP_ID must be a valid UUID.",
    );
  }
  return value.toLowerCase();
}

async function waitForPinnedTeacherAuthContext(
  page: Page,
  expectedMembershipId: string,
) {
  const response = await page.waitForResponse(
    (candidate) => {
      try {
        return (
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).pathname.endsWith(
            "/rest/v1/rpc/get_auth_context",
          )
        );
      } catch {
        return false;
      }
    },
    { timeout: 15_000 },
  );
  if (response.status() >= 400) {
    throw new Error("The trusted teacher auth context request failed.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The trusted teacher auth context was malformed.");
  }
  const candidate = Array.isArray(payload) ? payload[0] : payload;
  const row =
    candidate && typeof candidate === "object"
      ? (candidate as { memberships?: unknown })
      : null;
  const memberships = Array.isArray(row?.memberships) ? row.memberships : [];
  const exactTeacherMembership = memberships.some((membership) => {
    if (!membership || typeof membership !== "object") return false;
    const value = membership as {
      membership_id?: unknown;
      role?: unknown;
    };
    return (
      value.membership_id === expectedMembershipId &&
      (value.role === "owner" || value.role === "teacher")
    );
  });
  if (!exactTeacherMembership) {
    throw new Error(
      "The trusted teacher auth context did not contain the pinned membership.",
    );
  }
}

async function signInTeacher(page: Page) {
  const account = teacherCredentials();
  const expectedMembershipId = teacherWorkspaceMembershipId();
  await page.goto("/");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  const trustedAuthContext = waitForPinnedTeacherAuthContext(
    page,
    expectedMembershipId,
  );
  await page.evaluate((membershipId) => {
    window.localStorage.setItem("gwc_active_membership_id", membershipId);
  }, expectedMembershipId);
  await page.getByRole("button", { name: "Sign in with Email" }).click();
  await trustedAuthContext;
  await enterTeacherShellFromAdminLanding(page);
  await expect(page).toHaveURL(/\/teacher\/(?:dashboard|onboarding)$/, {
    timeout: 15_000,
  });
  if (page.url().endsWith("/teacher/onboarding")) {
    throw new Error(
      "The teacher mutation account must have an existing staging workspace.",
    );
  }
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.localStorage.getItem("gwc_active_membership_id"),
        ),
      { timeout: 15_000 },
    )
    .toBe(expectedMembershipId);
}

async function monitorFatalBrowserFailures(page: Page) {
  const failures: string[] = [];
  await page.addInitScript(() => {
    const captured: string[] = [];
    Object.defineProperty(window, "__schreibenE2EFailures", {
      configurable: false,
      value: captured,
      writable: false,
    });
    const isBenignResizeObserverMessage = (message: string) => {
      return /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)\.?$/i.test(
        message.trim(),
      );
    };
    const describeType = (reason: unknown) => {
      if (reason instanceof Error) return `error:${reason.name}`;
      if (reason === null) return "non-error:null";
      if (Array.isArray(reason)) return "non-error:array";
      return `non-error:${typeof reason}`;
    };
    window.addEventListener(
      "error",
      (event) => {
        if (!isBenignResizeObserverMessage(event.message)) {
          captured.push(`early-error:${describeType(event.error)}`);
        }
      },
      { capture: true },
    );
    window.addEventListener(
      "unhandledrejection",
      (event) =>
        captured.push(`early-unhandledrejection:${describeType(event.reason)}`),
      { capture: true },
    );
  });
  page.on("pageerror", (error) => failures.push(`pageerror:${error.name}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)\.?$/i.test(
        message.text().trim(),
      )
    ) {
      return;
    }
    const location = message.location();
    let pathname = "unknown";
    try {
      pathname = location.url ? new URL(location.url).pathname : "unknown";
    } catch {
      pathname = "unknown";
    }
    failures.push(`console_error:${pathname}:${location.lineNumber ?? 0}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(
        `http:${response.status()}:${new URL(response.url()).pathname}`,
      );
    }
  });
  return async () => {
    const earlyFailures = await page
      .evaluate(
        () =>
          (window as Window & { __schreibenE2EFailures?: string[] })
            .__schreibenE2EFailures ?? [],
      )
      .catch(() => [] as string[]);
    const allFailures = [...failures, ...earlyFailures];
    expect(allFailures, allFailures.join("\n")).toEqual([]);
  };
}

const modeCases = [
  {
    slug: "review",
    label: "Teacher review",
    level: "A1",
    schedule: null,
  },
  {
    slug: "immediate",
    label: "Immediate feedback",
    level: "A2",
    schedule: null,
  },
  {
    slug: "scheduled",
    label: "Scheduled feedback",
    level: "B1",
    schedule: { earliest: "1", latest: "2" },
  },
] as const;

const taskTypeCases = [
  { value: "email", label: "Email" },
  { value: "message", label: "Message" },
  { value: "description", label: "Description" },
  { value: "opinion", label: "Opinion" },
  { value: "apology", label: "Apology" },
  { value: "invitation", label: "Invitation" },
  { value: "formal_letter", label: "Formal Letter" },
  { value: "free_text", label: "Free Text" },
  { value: "writing", label: "Writing" },
] as const;

test.skip(
  process.env.E2E_MUTATIONS !== "true",
  "Set E2E_MUTATIONS=true only for the isolated staging mutation run.",
);

test.describe.serial("authenticated teacher staging mutations", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
    teacherWorkspaceMembershipId();
  });

  test("teacher creates and archives a class in every feedback mode", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const assertNoFatalFailures = await monitorFatalBrowserFailures(page);
    const runStamp = `${Date.now().toString(36)}-${process.pid}`;
    const createdNames = new Set<string>();

    await signInTeacher(page);
    await page.getByRole("link", { name: "Classes", exact: true }).click();
    await expect(page).toHaveURL(/\/teacher\/batches$/);

    try {
      for (const mode of modeCases) {
        const className = `V1 ${mode.slug} ${runStamp}`;
        await page.getByRole("button", { name: "Create Class" }).click();
        const dialog = page.getByRole("dialog", { name: "Create a class" });
        await expect(dialog).toBeVisible();

        await dialog.getByLabel("Class name").fill(className);
        await dialog.getByLabel("CEFR level").click();
        await page
          .getByRole("option", { name: mode.level, exact: true })
          .click();
        await dialog.getByRole("button", { name: "Continue" }).click();

        await dialog
          .getByRole("radio", { name: new RegExp(`^${mode.label}`) })
          .click();
        await dialog.getByRole("button", { name: "Continue" }).click();

        if (mode.schedule) {
          await dialog
            .getByLabel("Earliest release (minutes)")
            .fill(mode.schedule.earliest);
          await dialog
            .getByLabel("Latest release (minutes)")
            .fill(mode.schedule.latest);
        }
        await dialog.getByRole("button", { name: "Continue" }).click();
        await expect(
          dialog.getByText("Teacher approval required", { exact: true }),
        ).toBeVisible();
        await dialog.getByRole("button", { name: "Continue" }).click();
        await expect(
          dialog.getByText(className, { exact: false }),
        ).toBeVisible();
        createdNames.add(className);
        await dialog.getByRole("button", { name: "Create class" }).click();

        const copyCode = page.getByRole("button", {
          name: `Copy join code for ${className}`,
        });
        await expect(copyCode).toBeVisible({ timeout: 10_000 });
        const card = copyCode.locator(
          "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]",
        );
        await expect(card.getByText(mode.label, { exact: true })).toBeVisible();
        await expect(card.locator("p.font-mono")).toHaveText(
          /^[A-Z0-9]{8,16}$/,
        );
        await card.getByRole("button", { name: "Archive Class" }).click();
        await expect(copyCode).toBeHidden({ timeout: 10_000 });
        createdNames.delete(className);
      }
    } finally {
      // A failed assertion must not strand an active smoke class in staging.
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.goto("/teacher/batches");
      for (const className of createdNames) {
        const copyCode = page.getByRole("button", {
          name: `Copy join code for ${className}`,
        });
        const activeClassExists = await copyCode
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(() => true)
          .catch(() => false);
        if (activeClassExists) {
          const card = copyCode.locator(
            "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]",
          );
          await card.getByRole("button", { name: "Archive Class" }).click();
          await expect(copyCode).toBeHidden({ timeout: 10_000 });
        }
        createdNames.delete(className);
      }
      expect(createdNames.size).toBe(0);
    }

    await assertNoFatalFailures();
  });

  test("teacher creates every writing-task type and can update and deactivate one", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const assertNoFatalFailures = await monitorFatalBrowserFailures(page);
    const runStamp = `${Date.now().toString(36)}-${process.pid}`;

    await signInTeacher(page);
    await page.goto("/teacher/questions");
    await page.getByRole("tab", { name: "My Workspace Writing Tasks" }).click();

    const search = page.getByLabel("Search writing tasks");

    try {
      for (const taskType of taskTypeCases) {
        const title = `V1 ${taskType.value} ${runStamp}`;
        await page
          .getByRole("button", { name: "Create Workspace Writing Task" })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "Create New Writing Task",
        });
        await dialog.getByLabel("Title").fill(title);
        await dialog.getByLabel("Level").click();
        await page.getByRole("option", { name: "A2", exact: true }).click();
        await dialog.getByLabel("Task type").click();
        await page
          .getByRole("option", { name: taskType.label, exact: true })
          .click();
        await dialog.getByLabel("Topic").fill("V1 staging verification");
        await dialog
          .getByLabel("Task Text")
          .fill("Schreiben Sie einen kurzen passenden Text auf Deutsch.");
        await dialog.getByLabel("Min words").fill("30");
        await dialog.getByLabel("Max words").fill("80");
        await dialog.getByLabel("Minutes").fill("10");
        await dialog.getByRole("button", { name: "Save Writing Task" }).click();
        await expect(
          page.getByText("Writing task created", { exact: true }).last(),
        ).toBeVisible();
        await search.fill(title);
        const taskCard = page
          .getByText(title, { exact: true })
          .locator(
            "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]",
          );
        await expect(taskCard).toBeVisible({ timeout: 10_000 });

        if (taskType.value === "formal_letter") {
          await taskCard.getByRole("button", { name: "Edit" }).click();
          const editDialog = page.getByRole("dialog", {
            name: "Edit Writing Task",
          });
          const updatedTitle = `${title} updated`;
          await editDialog.getByLabel("Title").fill(updatedTitle);
          await editDialog.getByLabel("Task type").click();
          await page
            .getByRole("option", { name: "Message", exact: true })
            .click();
          await editDialog
            .getByRole("button", { name: "Save Writing Task" })
            .click();
          await expect(
            page.getByText("Writing task updated", { exact: true }).last(),
          ).toBeVisible();
          await search.fill(updatedTitle);
          const updatedSwitch = page.getByRole("switch", {
            name: `Deactivate writing task ${updatedTitle}`,
          });
          await expect(updatedSwitch).toBeVisible({ timeout: 10_000 });
          await updatedSwitch.click();
          await expect(
            page.getByRole("switch", {
              name: `Activate writing task ${updatedTitle}`,
            }),
          ).toBeVisible({ timeout: 10_000 });
        } else {
          const activeSwitch = taskCard.getByRole("switch", {
            name: `Deactivate writing task ${title}`,
          });
          await activeSwitch.click();
          await expect(
            page.getByRole("switch", {
              name: `Activate writing task ${title}`,
            }),
          ).toBeVisible({ timeout: 10_000 });
        }
      }
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.goto("/teacher/questions");
      await page
        .getByRole("tab", { name: "My Workspace Writing Tasks" })
        .click();
      await search.fill(runStamp);
      await page.waitForTimeout(350);
      const activeSmokeTasks = page.locator(
        `[role="switch"][aria-label^="Deactivate writing task V1 "][aria-label*="${runStamp}"]`,
      );
      while ((await activeSmokeTasks.count()) > 0) {
        const activeSwitch = activeSmokeTasks.first();
        const activeLabel = await activeSwitch.getAttribute("aria-label");
        expect(activeLabel).toMatch(/^Deactivate writing task V1 /);
        expect(activeLabel).toContain(runStamp);
        const inactiveLabel = activeLabel!.replace(/^Deactivate/, "Activate");
        await activeSwitch.click();
        await expect(
          page.getByRole("switch", { name: inactiveLabel }),
        ).toBeVisible({ timeout: 10_000 });
      }
      await expect(activeSmokeTasks).toHaveCount(0);
    }

    await assertNoFatalFailures();
  });
});
