import { expect, test, type Page } from "@playwright/test";

const FIXTURE_PATH = "/tests/e2e/fixtures/practice-state-matrix.html";
const widths = [1024, 1180] as const;

async function mountNavigationHarness(page: Page) {
  await page.goto(FIXTURE_PATH);
  await page.locator("#root").waitFor();
  await page.evaluate(async () => {
    const importModule = (path: string) => import(/* @vite-ignore */ path);
    const harness = await importModule(
      "/tests/e2e/fixtures/responsive-navigation-harness.tsx",
    );
    harness.mountResponsiveNavigationHarness();
  });
  await expect(page.getByText("Responsive navigation fixture")).toBeVisible();
}

for (const width of widths) {
  test(`keeps essential student context controls reachable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await mountNavigationHarness(page);

    await expect(
      page.getByRole("navigation", {
        name: "Primary navigation",
      }),
    ).toBeHidden();
    const menuTrigger = page.getByRole("button", {
      name: "Open navigation menu",
    });
    await expect(menuTrigger).toBeVisible();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);

    await menuTrigger.click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("combobox", {
        name: "Active workspace and role",
      }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("combobox", {
        name: "Active class",
      }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", {
        name: "Join another class",
      }),
    ).toBeVisible();

    for (const label of ["Home", "Write", "Practice", "History"]) {
      await expect(drawer.getByRole("link", { name: label })).toBeVisible();
    }

    await expect
      .poll(async () => {
        const box = await drawer.boundingBox();
        return Boolean(box && box.x >= 0 && box.x + box.width <= width);
      })
      .toBe(true);
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox).not.toBeNull();
    expect(drawerBox!.x).toBeGreaterThanOrEqual(0);
    expect(drawerBox!.x + drawerBox!.width).toBeLessThanOrEqual(width);
  });
}
