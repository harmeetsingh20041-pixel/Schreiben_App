import { expect, test, type Locator, type Page } from "@playwright/test";
import { enterTeacherShellFromAdminLanding } from "./helpers/authenticated-role-navigation";
import {
  assertReadOnlySweepPassed,
  installReadOnlySweepGuard,
  type ReadOnlySweepGuard,
} from "./helpers/read-only-sweep-guard";

type Credentials = { email: string; password: string };
type SurfaceRole = "dialog" | "alertdialog";

test.skip(
  process.env.E2E_DIALOG_SWEEP !== "true",
  "Set E2E_DIALOG_SWEEP=true only for the read-only authenticated staging sweep.",
);

test.describe.serial("authenticated application dialog viewport sweep", () => {
  let readOnlySweepGuard: ReadOnlySweepGuard | undefined;

  test.use({
    viewport: { width: 1366, height: 768 },
    serviceWorkers: "block",
  });

  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
  });

  test.beforeEach(async ({ context }) => {
    readOnlySweepGuard = await installReadOnlySweepGuard(context);
  });

  test.afterEach(async () => {
    const guard = readOnlySweepGuard;
    readOnlySweepGuard = undefined;
    expect(
      guard,
      "The read-only dialog guard was not installed.",
    ).toBeDefined();
    if (!guard) return;
    try {
      await guard.dispose();
    } finally {
      assertReadOnlySweepPassed(guard.evidence);
    }
  });

  test("teacher core dialogs are complete without saving changes", async ({
    page,
  }) => {
    await signIn(page, credentials("TEACHER"), "teacher");

    await page.goto("/teacher/batches");
    await expect(
      page.getByRole("heading", { name: "Classes", level: 1 }),
    ).toBeVisible();
    await exerciseClassWizard(page);

    await page.goto("/teacher/questions");
    await expect(
      page.getByRole("heading", { name: "Writing Task Bank", level: 1 }),
    ).toBeVisible();
    await exerciseWritingTaskDialog(page);

    await page.goto("/teacher/dashboard");
    await expect(
      page.getByRole("heading", { name: "Teacher Overview", level: 1 }),
    ).toBeVisible();
    await exerciseTour(page, [
      "Create and configure a class",
      "Approve student access",
      "Let the system handle routine feedback",
      "Step in only when needed",
    ]);
  });

  test("teacher fixture-backed dialogs are complete when their rows exist", async ({
    page,
  }) => {
    const unavailable: string[] = [];
    await signIn(page, credentials("TEACHER"), "teacher");

    await page.goto("/teacher/students");
    await expect(
      page.getByRole("heading", { name: "Students", level: 1 }),
    ).toBeVisible();

    const removeAccess = page
      .getByRole("button", { name: "Remove access" })
      .first();
    if (await isAvailable(removeAccess)) {
      await exerciseOffboardingDialog(page, removeAccess);
    } else {
      markFixtureUnavailable("student offboarding confirmation", unavailable);
    }

    const transferClass = page
      .getByRole("button", { name: "Transfer class" })
      .first();
    if (await isAvailable(transferClass)) {
      await exerciseTransferDialog(page, transferClass);
    } else {
      markFixtureUnavailable("student class-transfer form", unavailable);
    }

    await page.goto("/teacher/review-queue");
    await expect(
      page.getByRole("heading", { name: "Review Queue", level: 1 }),
    ).toBeVisible();
    const inspectWorksheet = page
      .getByRole("link", { name: "Inspect", exact: true })
      .first();
    if (await isAvailable(inspectWorksheet)) {
      await inspectWorksheet.click();
      await expect(page).toHaveURL(/\/teacher\/practice-quality\//);
      const qualityHeading = page.getByRole("heading", {
        name: "Worksheet quality review",
        level: 1,
      });
      if (await isAvailable(qualityHeading)) {
        await exerciseWorksheetQualityDialogs(page);
      } else {
        markFixtureUnavailable(
          "worksheet quality confirmation (stale row)",
          unavailable,
        );
      }
    } else {
      markFixtureUnavailable("worksheet quality confirmation", unavailable);
    }

    test.info().annotations.push({
      type: "fixture-coverage",
      description:
        unavailable.length === 0
          ? "All teacher fixture-backed dialogs were reachable."
          : `Unavailable staging fixtures: ${unavailable.join(", ")}.`,
    });
  });

  test("student dialogs and responsive navigation are complete without submitting", async ({
    page,
  }) => {
    await signIn(page, credentials("STUDENT"), "student");
    await expect(page).toHaveURL(/\/student\/dashboard$/);

    await exerciseJoinClassDialog(page);
    await exerciseTour(page, [
      "Choose the right class",
      "Your work saves while you write",
      "Feedback release is visible",
      "Practice follows your needs",
    ]);

    await page.setViewportSize({ width: 1023, height: 768 });
    await exerciseResponsiveNavigation(page);
  });
});

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(
      `${name} is required for authenticated dialog verification.`,
    );
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
  expectedRole: "teacher" | "student",
) {
  await page.goto("/");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in with Email" }).click();
  await enterTeacherShellFromAdminLanding(page);
  await expect(page).toHaveURL(new RegExp(`/${expectedRole}/`), {
    timeout: 15_000,
  });
  if (page.url().endsWith("/teacher/onboarding")) {
    throw new Error(
      "The teacher dialog-sweep account needs an existing staging workspace.",
    );
  }
}

async function isAvailable(locator: Locator, timeout = 5_000) {
  return locator
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

function markFixtureUnavailable(label: string, unavailable: string[]) {
  unavailable.push(label);
}

async function expectSurfaceContract(
  page: Page,
  surface: Locator,
  actionNames: string[],
  viewport = { width: 1366, height: 768 },
  scrollSurface = surface,
) {
  await expect(surface).toBeVisible();
  await expect
    .poll(async () => {
      const box = await surface.boundingBox();
      return Boolean(
        box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height,
      );
    })
    .toBe(true);

  await expect(scrollSurface).toBeVisible();
  const metrics = await scrollSurface.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(metrics.clientHeight).toBeLessThanOrEqual(viewport.height);
  expect(["auto", "scroll"]).toContain(metrics.overflowY);
  if (metrics.scrollHeight > metrics.clientHeight) {
    const maximumScroll = await scrollSurface.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(maximumScroll).toBeGreaterThan(0);
    await scrollSurface.evaluate((element) => {
      element.scrollTop = 0;
    });
  }

  for (const name of actionNames) {
    const action = surface.getByRole("button", { name, exact: true }).first();
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
    const actionBox = await action.boundingBox();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.y).toBeGreaterThanOrEqual(0);
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(
      viewport.height,
    );
  }

  await expect
    .poll(() =>
      surface.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await surface.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
}

async function expectDismissedWithFocus(surface: Locator, opener: Locator) {
  await expect(surface).toBeHidden();
  await expect(opener).toBeFocused();
}

async function openWithKeyboard(opener: Locator) {
  await opener.focus();
  await opener.press("Enter");
}

async function exerciseClassWizard(page: Page) {
  const opener = page
    .getByRole("button", { name: "Create Class", exact: true })
    .first();
  await opener.click();
  let dialog = page.getByRole("dialog", { name: "Create a class" });
  await expectSurfaceContract(
    page,
    dialog,
    ["Cancel", "Continue"],
    { width: 1366, height: 768 },
    dialog.getByTestId("class-wizard-scroll-region"),
  );
  await page.keyboard.press("Escape");
  await expectDismissedWithFocus(dialog, opener);

  await openWithKeyboard(opener);
  dialog = page.getByRole("dialog", { name: "Create a class" });
  await dialog.getByLabel("Class name").fill("OPS-002 unsaved class");
  let continueButton = dialog.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await continueButton.focus();
  await continueButton.press("Enter");

  const scheduled = dialog.getByRole("radio", { name: /^Scheduled feedback/ });
  await scheduled.focus();
  await scheduled.press("Space");
  await continueButton.click();
  await expect(dialog.getByLabel("Earliest release (minutes)")).toBeVisible();
  await expectSurfaceContract(
    page,
    dialog,
    ["Cancel", "Back", "Continue"],
    { width: 1366, height: 768 },
    dialog.getByTestId("class-wizard-scroll-region"),
  );
  await dialog.getByLabel("Earliest release (minutes)").fill("1");
  await dialog.getByLabel("Latest release (minutes)").fill("2");
  await continueButton.focus();
  await continueButton.press("Enter");

  await expect(
    dialog.getByText("Teacher approval required", { exact: true }),
  ).toBeVisible();
  continueButton = dialog.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await continueButton.click();
  await expectSurfaceContract(
    page,
    dialog,
    ["Cancel", "Back", "Create class"],
    { width: 1366, height: 768 },
    dialog.getByTestId("class-wizard-scroll-region"),
  );
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await cancel.click();
  await expectDismissedWithFocus(dialog, opener);
}

async function exerciseWritingTaskDialog(page: Page) {
  const opener = page.getByRole("button", {
    name: "Create Workspace Writing Task",
    exact: true,
  });
  await opener.click();
  let dialog = page.getByRole("dialog", { name: "Create New Writing Task" });
  await expectSurfaceContract(page, dialog, ["Cancel", "Save Writing Task"]);
  await page.keyboard.press("Escape");
  await expectDismissedWithFocus(dialog, opener);

  await openWithKeyboard(opener);
  dialog = page.getByRole("dialog", { name: "Create New Writing Task" });
  await dialog.getByLabel("Title").fill("OPS-002 unsaved task");
  await dialog.getByLabel("Topic").fill("Viewport regression");
  await dialog.getByLabel("Task Text").fill("Schreiben Sie einen kurzen Text.");
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await cancel.scrollIntoViewIfNeeded();
  await cancel.click();
  await expectDismissedWithFocus(dialog, opener);
}

async function exerciseTour(page: Page, titles: string[]) {
  const opener = page.getByRole("button", { name: "Replay tour", exact: true });
  await expect(opener).toBeVisible({ timeout: 10_000 });
  await opener.click();
  let dialog = page.getByRole("dialog", { name: titles[0] });
  await expectSurfaceContract(page, dialog, ["Next"]);
  await page.keyboard.press("Escape");
  await expectDismissedWithFocus(dialog, opener);

  await openWithKeyboard(opener);
  for (let index = 0; index < titles.length; index += 1) {
    dialog = page.getByRole("dialog", { name: titles[index] });
    await expect(dialog).toBeVisible();
    if (index < titles.length - 1) {
      const next = dialog.getByRole("button", { name: "Next", exact: true });
      if (index % 2 === 0) {
        await next.focus();
        await next.press("Enter");
      } else {
        await next.click();
      }
    } else {
      await dialog.getByRole("button", { name: "Finish", exact: true }).click();
    }
  }
  await expectDismissedWithFocus(dialog, opener);
}

async function exerciseOffboardingDialog(page: Page, opener: Locator) {
  await opener.click();
  let dialog = page.getByRole("alertdialog");
  await expectSurfaceContract(page, dialog, [
    "Keep student",
    "Remove student access",
  ]);
  await page.keyboard.press("Escape");
  await expectDismissedWithFocus(dialog, opener);

  await openWithKeyboard(opener);
  dialog = page.getByRole("alertdialog");
  await dialog
    .getByRole("button", { name: "Keep student", exact: true })
    .click();
  await expectDismissedWithFocus(dialog, opener);
}

async function exerciseTransferDialog(page: Page, opener: Locator) {
  await opener.click();
  let dialog = page.getByRole("dialog", {
    name: /^Transfer .+ between classes$/,
  });
  await expectSurfaceContract(page, dialog, ["Cancel", "Transfer student"]);
  await page.keyboard.press("Escape");
  await expectDismissedWithFocus(dialog, opener);

  await openWithKeyboard(opener);
  dialog = page.getByRole("dialog", { name: /^Transfer .+ between classes$/ });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expectDismissedWithFocus(dialog, opener);
}

async function exerciseWorksheetQualityDialogs(page: Page) {
  await page
    .getByLabel("Review notes")
    .fill("OPS-002 read-only viewport verification");

  const approve = page.getByRole("main").getByRole("button", {
    name: "Approve and assign",
    exact: true,
  });
  await approve.click();
  let dialog = page.getByRole("alertdialog", {
    name: "Approve this exact worksheet?",
  });
  await expectSurfaceContract(page, dialog, ["Cancel", "Approve and assign"]);
  await page.keyboard.press("Escape");
  await expectDismissedWithFocus(dialog, approve);

  const reject = page.getByRole("main").getByRole("button", {
    name: "Reject and keep private",
    exact: true,
  });
  await openWithKeyboard(reject);
  dialog = page.getByRole("alertdialog", { name: "Reject this worksheet?" });
  await expectSurfaceContract(page, dialog, [
    "Cancel",
    "Reject and keep private",
  ]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expectDismissedWithFocus(dialog, reject);
}

async function exerciseJoinClassDialog(page: Page) {
  const opener = page.getByRole("button", {
    name: "Join another class",
    exact: true,
  });
  await opener.click();
  let dialog = page.getByRole("dialog", { name: "Join another class" });
  await expectSurfaceContract(page, dialog, ["Close", "Request access"]);
  await page.keyboard.press("Escape");
  await expectDismissedWithFocus(dialog, opener);

  await openWithKeyboard(opener);
  dialog = page.getByRole("dialog", { name: "Join another class" });
  await dialog.getByLabel("Class code").fill("UNSAVED");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expectDismissedWithFocus(dialog, opener);
}

async function exerciseResponsiveNavigation(page: Page) {
  const viewport = { width: 1023, height: 768 };
  const opener = page.getByRole("button", {
    name: "Open navigation menu",
    exact: true,
  });
  await expect(opener).toBeVisible();
  await opener.click();
  let dialog = page.getByRole("dialog", { name: "Navigation" });
  await expectSurfaceContract(page, dialog, ["Close"], viewport);
  await expect(
    dialog.getByRole("link", { name: "History", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expectDismissedWithFocus(dialog, opener);

  await openWithKeyboard(opener);
  dialog = page.getByRole("dialog", { name: "Navigation" });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expectDismissedWithFocus(dialog, opener);
}
