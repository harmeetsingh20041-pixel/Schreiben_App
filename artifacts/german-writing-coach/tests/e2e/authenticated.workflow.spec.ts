import { expect, test, type Page } from "@playwright/test";
import { enterTeacherShellFromAdminLanding } from "./helpers/authenticated-role-navigation";
import { assertPinnedHostedStagingPageOrigin } from "./helpers/hosted-staging-safety";

type Credentials = { email: string; password: string };

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for authenticated E2E.`);
  return value;
}

function credentials(role: "TEACHER" | "STUDENT"): Credentials {
  return {
    email: requiredEnvironment(`E2E_${role}_EMAIL`),
    password: requiredEnvironment(`E2E_${role}_PASSWORD`),
  };
}

async function signIn(page: Page, account: Credentials) {
  const assertSafeHostedOrigin = () => {
    if (process.env.E2E_HOSTED_STAGING === "true") {
      assertPinnedHostedStagingPageOrigin(page.url());
    }
  };
  await page.goto("/");
  assertSafeHostedOrigin();
  const emailInput = page.getByLabel("Email");
  const passwordInput = page.getByLabel("Password");
  assertSafeHostedOrigin();
  await emailInput.fill(account.email);
  assertSafeHostedOrigin();
  await passwordInput.fill(account.password);
  assertSafeHostedOrigin();
  await page.getByRole("button", { name: "Sign in with Email" }).click();
  await enterTeacherShellFromAdminLanding(page);
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

test.describe("authenticated staging workflow shell", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test.beforeAll(() => {
    expect(requiredEnvironment("E2E_AUTHENTICATED")).toBe("true");
  });

  test("teacher can reach every V1 operating area", async ({ page }) => {
    // A hosted administrator signs in through a human-supplied MFA code. Give
    // that short-lived handoff its own budget instead of consuming the normal
    // 30-second navigation smoke timeout while the browser waits at /auth/mfa.
    test.setTimeout(120_000);
    const assertNoFatalFailures = monitorFatalBrowserFailures(page);
    await signIn(page, credentials("TEACHER"));
    await expect(page).toHaveURL(/\/teacher\/(?:dashboard|onboarding)$/);

    if (page.url().endsWith("/teacher/onboarding")) {
      throw new Error(
        "The authenticated E2E teacher must be an entitled current teacher with a workspace.",
      );
    }

    const destinations = [
      ["Overview", /\/teacher\/dashboard$/, "Teacher Overview"],
      ["Classes", /\/teacher\/batches$/, "Classes"],
      ["Students", /\/teacher\/students$/, "Students"],
      ["Review Queue", /\/teacher\/review-queue$/, "Review Queue"],
      ["Content", /\/teacher\/questions$/, "Writing Task Bank"],
    ] as const;

    for (const [name, route, heading] of destinations) {
      await page.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(route);
      await expect(
        page.getByRole("heading", { name: heading, level: 1 }),
      ).toBeVisible();
    }
    assertNoFatalFailures();
  });

  test("student can reach Home, Write, Practice, and History with persistent enrollment", async ({
    page,
  }) => {
    const assertNoFatalFailures = monitorFatalBrowserFailures(page);
    await signIn(page, credentials("STUDENT"));
    await expect(page).toHaveURL(/\/student\/dashboard$/);
    await expect(
      page.getByRole("button", { name: "Join another class" }),
    ).toBeVisible();

    const destinations = [
      ["Home", /\/student\/dashboard$/],
      ["Write", /\/student\/questions$/],
      ["Practice", /\/student\/practice$/],
      ["History", /\/student\/history$/],
    ] as const;
    for (const [name, route] of destinations) {
      await page.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(route);
      await expect(page.getByRole("main")).toBeVisible();
    }
    await expect(
      page.getByRole("button", { name: "Join another class" }),
    ).toBeVisible();
    assertNoFatalFailures();
  });
});
