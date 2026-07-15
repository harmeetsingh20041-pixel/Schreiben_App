import { expect, test, type Locator, type Page } from "@playwright/test";

type HarnessKind = "dialog" | "alert-dialog" | "sheet";
type HarnessScenario = {
  name: string;
  kind: HarnessKind;
  role: "dialog" | "alertdialog";
  opener: string;
  title: string;
  primary: string;
  secondary: string;
};

test.use({ viewport: { width: 1366, height: 768 } });

async function mountHarness(page: Page, scenario: HarnessScenario) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Welcome Back/i }),
  ).toBeVisible();
  const optimizationReload = page
    .waitForEvent("load", { timeout: 1_500 })
    .catch(() => null);
  await page
    .evaluate(async () => {
      const modulePaths = [
        "/src/components/ui/dialog.tsx",
        "/src/components/ui/alert-dialog.tsx",
        "/src/components/ui/sheet.tsx",
      ];
      await Promise.all(
        modulePaths.map((path) => import(/* @vite-ignore */ path)),
      );
    })
    .catch(() => undefined);
  await optimizationReload;
  // Vite may perform a one-time dependency-optimization reload after the first
  // module warm-up. Establish a fresh, stable document before mounting.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Welcome Back/i }),
  ).toBeVisible();
  await page.evaluate(async (harnessScenario) => {
    const importModule = (path: string) => import(/* @vite-ignore */ path);
    const [reactModule, reactDomModule] = await Promise.all([
      importModule("/node_modules/.vite/deps/react.js"),
      importModule("/node_modules/.vite/deps/react-dom_client.js"),
    ]);
    const React = reactModule.default;
    const { createRoot } = reactDomModule.default;
    const e = React.createElement;
    const hiddenApplication = document.getElementById("root");
    if (hiddenApplication) hiddenApplication.hidden = true;
    const harnessRoot = document.createElement("div");
    harnessRoot.id = "ops-002-dialog-harness";
    document.body.append(harnessRoot);

    if (harnessScenario.kind === "dialog") {
      const module = await importModule("/src/components/ui/dialog.tsx");
      const Harness = () => {
        const [open, setOpen] = React.useState(false);
        return e(
          module.Dialog,
          { open, onOpenChange: setOpen },
          e(
            module.DialogTrigger,
            { asChild: true },
            e("button", { type: "button" }, harnessScenario.opener),
          ),
          e(
            module.DialogContent,
            { className: "sm:max-w-[640px]" },
            e(
              module.DialogHeader,
              null,
              e(module.DialogTitle, null, harnessScenario.title),
              e(
                module.DialogDescription,
                null,
                "OPS-002 viewport regression harness.",
              ),
            ),
            e("div", { style: { height: "1100px" }, "aria-hidden": "true" }),
            e(
              module.DialogFooter,
              null,
              harnessScenario.secondary === "Close"
                ? null
                : e(
                    "button",
                    { type: "button", onClick: () => setOpen(false) },
                    harnessScenario.secondary,
                  ),
              e(
                "button",
                { type: "button", onClick: () => setOpen(false) },
                harnessScenario.primary,
              ),
            ),
          ),
        );
      };
      createRoot(harnessRoot).render(e(Harness));
      return;
    }

    if (harnessScenario.kind === "alert-dialog") {
      const module = await importModule("/src/components/ui/alert-dialog.tsx");
      const Harness = () => {
        const [open, setOpen] = React.useState(false);
        return e(
          module.AlertDialog,
          { open, onOpenChange: setOpen },
          e(
            module.AlertDialogTrigger,
            { asChild: true },
            e("button", { type: "button" }, harnessScenario.opener),
          ),
          e(
            module.AlertDialogContent,
            null,
            e(
              module.AlertDialogHeader,
              null,
              e(module.AlertDialogTitle, null, harnessScenario.title),
              e(
                module.AlertDialogDescription,
                null,
                "Review all details before continuing.",
              ),
            ),
            e("div", { style: { height: "1100px" }, "aria-hidden": "true" }),
            e(
              module.AlertDialogFooter,
              null,
              e(module.AlertDialogCancel, null, harnessScenario.secondary),
              e(module.AlertDialogAction, null, harnessScenario.primary),
            ),
          ),
        );
      };
      createRoot(harnessRoot).render(e(Harness));
      return;
    }

    const module = await importModule("/src/components/ui/sheet.tsx");
    const Harness = () => {
      const [open, setOpen] = React.useState(false);
      return e(
        module.Sheet,
        { open, onOpenChange: setOpen },
        e(
          module.SheetTrigger,
          { asChild: true },
          e("button", { type: "button" }, harnessScenario.opener),
        ),
        e(
          module.SheetContent,
          {
            side: "left",
            className: "flex w-[min(22rem,88vw)] flex-col overflow-y-auto",
          },
          e(
            module.SheetHeader,
            null,
            e(module.SheetTitle, null, harnessScenario.title),
            e(module.SheetDescription, null, "Application navigation."),
          ),
          e("div", {
            style: { height: "1100px", flexShrink: "0" },
            "aria-hidden": "true",
          }),
          e(
            module.SheetClose,
            { asChild: true },
            e("button", { type: "button" }, harnessScenario.primary),
          ),
        ),
      );
    };
    createRoot(harnessRoot).render(e(Harness));
  }, scenario);
}

async function expectSurfaceInsideViewport(surface: Locator) {
  await expect(surface).toBeVisible();
  await expect
    .poll(async () => {
      const current = await surface.boundingBox();
      return Boolean(
        current &&
        current.x >= 0 &&
        current.y >= 0 &&
        current.x + current.width <= 1366 &&
        current.y + current.height <= 768,
      );
    })
    .toBe(true);
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1366);
  expect(box!.y + box!.height).toBeLessThanOrEqual(768);
  const metrics = await surface.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(metrics.clientHeight).toBeLessThanOrEqual(768);
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(["auto", "scroll"]).toContain(metrics.overflowY);
}

async function expectActionReachable(action: Locator) {
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeVisible();
  const box = await action.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(768);
}

async function expectFocusContained(page: Page, surface: Locator) {
  await expect
    .poll(() =>
      surface.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await surface.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
}

const cases = [
  {
    name: "class wizard",
    kind: "dialog" as const,
    role: "dialog" as const,
    opener: "Create Class",
    title: "Create a class",
    primary: "Continue",
    secondary: "Cancel",
  },
  {
    name: "writing-task form",
    kind: "dialog" as const,
    role: "dialog" as const,
    opener: "Create Workspace Writing Task",
    title: "Create New Writing Task",
    primary: "Save Writing Task",
    secondary: "Cancel",
  },
  {
    name: "student join-class form",
    kind: "dialog" as const,
    role: "dialog" as const,
    opener: "Join another class",
    title: "Join another class",
    primary: "Request access",
    secondary: "Close",
  },
  {
    name: "contextual onboarding tour",
    kind: "dialog" as const,
    role: "dialog" as const,
    opener: "Replay tour",
    title: "Create and configure a class",
    primary: "Next",
    secondary: "Back",
  },
  {
    name: "student class-transfer form",
    kind: "dialog" as const,
    role: "dialog" as const,
    opener: "Transfer class",
    title: "Transfer student between classes",
    primary: "Transfer student",
    secondary: "Cancel",
  },
  {
    name: "student offboarding confirmation",
    kind: "alert-dialog" as const,
    role: "alertdialog" as const,
    opener: "Remove access",
    title: "Remove student from this workspace?",
    primary: "Remove student access",
    secondary: "Keep student",
  },
  {
    name: "worksheet quality confirmation",
    kind: "alert-dialog" as const,
    role: "alertdialog" as const,
    opener: "Review worksheet decision",
    title: "Approve this exact worksheet?",
    primary: "Approve and assign",
    secondary: "Cancel",
  },
  {
    name: "responsive navigation",
    kind: "sheet" as const,
    role: "dialog" as const,
    opener: "Open navigation sheet",
    title: "Navigation",
    primary: "Done",
    secondary: "Done",
  },
] satisfies readonly HarnessScenario[];

for (const scenario of cases) {
  test(`${scenario.name} stays keyboard- and pointer-complete at 1366x768`, async ({
    page,
  }) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mountHarness(page, scenario);
        const opener = page.getByRole("button", { name: scenario.opener });
        await opener.click();
        const surface = page.getByRole(scenario.role, { name: scenario.title });
        await expectSurfaceInsideViewport(surface);
        await expectFocusContained(page, surface);
        await expectActionReachable(
          surface.getByRole("button", { name: scenario.primary }),
        );
        await expectActionReachable(
          surface.getByRole("button", { name: scenario.secondary }),
        );
        await page.keyboard.press("Escape");
        await expect(surface).toBeHidden();
        await expect(opener).toBeFocused();

        await opener.focus();
        await page.keyboard.press("Enter");
        await expectSurfaceInsideViewport(surface);
        await expectActionReachable(
          surface.getByRole("button", { name: scenario.secondary }),
        );
        await surface.getByRole("button", { name: scenario.secondary }).click();
        await expect(surface).toBeHidden();
        await expect(opener).toBeFocused();
        return;
      } catch (error) {
        const harnessWasReloaded =
          (await page
            .locator("#ops-002-dialog-harness")
            .count()
            .catch(() => 0)) === 0;
        if (attempt === 0 && harnessWasReloaded) continue;
        throw error;
      }
    }
  });
}
