import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "../e2e/authenticated.dialog-viewport.spec.ts"),
  "utf8",
);
const guardSource = readFileSync(
  resolve(
    import.meta.dirname,
    "../e2e/helpers/read-only-sweep-guard.ts",
  ),
  "utf8",
);

describe("authenticated dialog viewport contract", () => {
  it("checks the class wizard inner scroll region while retaining the outer dialog contract", () => {
    expect(source).toContain("scrollSurface = surface");
    expect(source).toContain("await expect(scrollSurface).toBeVisible()");
    expect(source).toContain(
      'dialog.getByTestId("class-wizard-scroll-region")',
    );
    expect(
      source.match(/dialog\.getByTestId\("class-wizard-scroll-region"\)/g),
    ).toHaveLength(3);
    expect(source).toContain(
      "surface.evaluate((element) => element.contains(document.activeElement))",
    );
  });

  it("installs a context-level read-only guard before navigation and verifies it in teardown", () => {
    expect(source).toContain('serviceWorkers: "block"');
    expect(source).toContain("test.beforeEach(async ({ context }) => {");
    expect(source).toContain(
      "readOnlySweepGuard = await installReadOnlySweepGuard(context)",
    );
    expect(source).toContain("test.afterEach(async () => {");
    expect(source).toContain("await guard.dispose()");
    expect(source).toMatch(
      /try \{\s+await guard\.dispose\(\);\s+\} finally \{\s+assertReadOnlySweepPassed\(guard\.evidence\);/,
    );
    expect(source).toContain("assertReadOnlySweepPassed(guard.evidence)");
    expect(source).not.toContain("monitorReadOnlyRun");
    expect(guardSource).toContain('await context.route("**/*", handleRoute)');
    expect(guardSource).toContain('await route.abort("blockedbyclient")');
    expect(guardSource).toContain('page.on("pageerror", onPageError)');
    expect(guardSource).toContain('page.on("response", onResponse)');
  });
});
