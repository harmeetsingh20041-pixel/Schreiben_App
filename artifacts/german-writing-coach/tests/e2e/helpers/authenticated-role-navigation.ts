import { expect, type Page } from "@playwright/test";
import { lstat, readFile } from "node:fs/promises";

const AUTHENTICATED_LANDING_PATHS = new Set([
  "/auth/mfa",
  "/admin/teacher-access",
  "/student/dashboard",
  "/teacher/dashboard",
  "/teacher/onboarding",
]);

function currentPathname(page: Page) {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return "";
  }
}

function validatedTotpCode(value: string | undefined) {
  const code = value?.trim();
  if (!code || !/^\d{6}$/.test(code)) {
    throw new Error(
      "Administrator navigation requires a fresh six-digit runtime TOTP code.",
    );
  }
  return code;
}

async function runtimeAdminTotpCode() {
  const environmentCode = process.env.E2E_ADMIN_TOTP_CODE?.trim();
  if (environmentCode) return validatedTotpCode(environmentCode);

  const pipePath = process.env.E2E_ADMIN_TOTP_PIPE?.trim();
  if (!pipePath) {
    throw new Error(
      "Administrator navigation requires E2E_ADMIN_TOTP_CODE or a private E2E_ADMIN_TOTP_PIPE.",
    );
  }
  const stats = await lstat(pipePath);
  if (!stats.isFIFO() || (stats.mode & 0o077) !== 0) {
    throw new Error(
      "The administrator TOTP channel must be a private owner-only named pipe.",
    );
  }

  process.stdout.write("E2E_MFA_CODE_REQUIRED\n");
  return validatedTotpCode(await readFile(pipePath, "utf8"));
}

async function selectPrimaryAuthenticator(page: Page, timeout: number) {
  const factorSelect = page.getByLabel("Authenticator");
  await expect(factorSelect).toBeVisible({ timeout });

  const options = factorSelect.locator("option");
  const labels = await options.allTextContents();
  const primaryIndexes = labels.flatMap((label, index) =>
    label.trim().toLowerCase() === "primary authenticator" ? [index] : [],
  );
  if (primaryIndexes.length > 1) {
    throw new Error(
      "E2E_MFA_PRIMARY_FACTOR_AMBIGUOUS: Multiple primary authenticators are configured.",
    );
  }
  if (primaryIndexes.length === 0) return;

  const primaryValue = await options
    .nth(primaryIndexes[0])
    .getAttribute("value");
  if (!primaryValue) {
    throw new Error(
      "E2E_MFA_PRIMARY_FACTOR_INVALID: The primary authenticator cannot be selected.",
    );
  }
  await factorSelect.selectOption(primaryValue);
  if ((await factorSelect.inputValue()) !== primaryValue) {
    throw new Error(
      "E2E_MFA_PRIMARY_FACTOR_SELECTION_FAILED: The primary authenticator was not selected.",
    );
  }
}

/**
 * The pilot administrator is also a real teacher. The application deliberately
 * lands platform administrators on the access-review page first, then exposes
 * their teacher workspace through the visible Teaching link. Ordinary teacher
 * and student accounts continue through without any navigation change.
 */
export async function enterTeacherShellFromAdminLanding(
  page: Page,
  timeout = 15_000,
) {
  await expect
    .poll(
      () =>
        AUTHENTICATED_LANDING_PATHS.has(currentPathname(page))
          ? "ready"
          : "pending",
      { timeout },
    )
    .toBe("ready");

  if (currentPathname(page) === "/auth/mfa") {
    // Select the intended factor before requesting a short-lived runtime code.
    // Provider factor order is not a stable automation contract.
    await selectPrimaryAuthenticator(page, timeout);
    const code = await runtimeAdminTotpCode();
    const codeInput = page.getByLabel("Six-digit code");
    await expect(codeInput).toBeVisible({ timeout });
    await codeInput.fill(code);
    await page.getByRole("button", { name: "Verify authenticator" }).click();
    const verificationOutcome = await Promise.race([
      page
        .getByText("Two-factor setup is complete", { exact: true })
        .waitFor({ state: "visible", timeout })
        .then(() => "verified" as const),
      page
        .getByRole("alert")
        .waitFor({ state: "visible", timeout })
        .then(() => "rejected" as const),
    ]);
    if (verificationOutcome === "rejected") {
      throw new Error(
        "E2E_MFA_VERIFICATION_REJECTED: The selected authenticator rejected the runtime code.",
      );
    }
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/admin\/teacher-access$/, { timeout });
  }

  if (currentPathname(page) !== "/admin/teacher-access") return;

  const teachingLink = page.getByRole("link", {
    name: "Teaching",
    exact: true,
  });
  await expect(teachingLink).toBeVisible({ timeout });
  await teachingLink.click();
  await expect(page).toHaveURL(/\/teacher\/(?:dashboard|onboarding)$/, {
    timeout,
  });
}
