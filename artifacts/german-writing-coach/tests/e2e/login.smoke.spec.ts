import { expect, test } from "@playwright/test";

test("the public sign-in shell is usable", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Welcome Back" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with Email" }),
  ).toBeVisible();
});

test("forgot-password navigation is discoverable from sign in", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: /Forgot (your )?password\?/i })
    .click();

  await expect(page).toHaveURL(/\/auth\/forgot-password$/);
  await expect(
    page.getByRole("heading", { name: "Reset your password" }),
  ).toBeVisible();
});

test("public account-recovery routes render without authentication", async ({
  page,
}) => {
  const routes = [
    ["/auth/check-email", "Check your email"],
    ["/auth/forgot-password", "Reset your password"],
    ["/auth/reset-password", "Choose a new password"],
  ] as const;

  for (const [route, heading] of routes) {
    await page.goto(route);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
});

test("email-confirmation callback route has a safe terminal state", async ({
  page,
}) => {
  await page.goto("/auth/confirm");

  await expect(
    page.getByRole("heading", {
      name: /Confirming your email|Email confirmed|Confirmation link unavailable/,
    }),
  ).toBeVisible();
});

test("a legacy demo flag and stale local role cannot open the protected app", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("gwc_role", "student");
  });
  await page.goto("/");

  await expect(page.getByText("Interactive Demo Mode")).toHaveCount(0);
  await expect(page.getByText(/continue as \(Demo\)/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Student" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Teacher" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("gwc_role"))).toBeNull();

  for (const route of ["/student/dashboard", "/teacher/dashboard"]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("heading", { name: "Welcome Back" }),
    ).toBeVisible();
  }

  await page.goto("/student/result/mock");
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
});
