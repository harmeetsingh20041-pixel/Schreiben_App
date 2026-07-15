import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    import.meta.dirname,
    "../e2e/authenticated.autosave-regression.spec.ts",
  ),
  "utf8",
);

function namedTestBlock(name: string) {
  const start = source.indexOf(`test("${name}`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\n  test("', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("authenticated offline autosave contract", () => {
  it("keeps exact local text, reconnects, saves, and verifies the persisted reload", () => {
    expect(source).toContain('test("WRITE-021 preserves local text offline');
    expect(source).toContain("await context.setOffline(true)");
    expect(source).toContain('toContainText(\n        "Error"');
    expect(source).toContain("await expect(editor).toHaveValue(latestText)");
    expect(source).toContain("await context.setOffline(false)");
    expect(source).toContain(
      "await waitForWritingRevision(page, baselineRevision + 1)",
    );
    expect(source).toContain("await page.reload()");
  });

  it("keeps the exact selected practice answer offline and restores it after retry and reload", () => {
    const block = namedTestBlock("PRACTICE-018");
    expect(block).toContain("await context.setOffline(true)");
    expect(block).toContain('name: "ist", exact: true');
    expect(block).toContain('toContainText(\n        "Error"');
    expect(block).toContain("await context.setOffline(false)");
    expect(block).toContain('name: "Retry save"');
    expect(block).toContain(
      "await waitForPracticeRevision(page, baselineRevision + 1)",
    );
    expect(block).toContain("await page.reload()");
  });

  it("aborts every staging Edge or AI worker route before dispatch and requires zero attempts", () => {
    expect(source).toContain(
      'const PINNED_STAGING_ORIGIN = "https://vzcgalzspdehmnvqczfw.supabase.co"',
    );
    expect(source).toContain("await context.route(");
    expect(source).toContain("`${PINNED_STAGING_ORIGIN}/functions/v1/**`");
    expect(source).toContain('pathname.startsWith("/functions/v1/")');
    expect(source).toContain('return route.abort("blockedbyclient")');
    expect(source).toContain(
      'expect(attempts, attempts.join("\\n")).toEqual([])',
    );
    expect(source).toContain("failures.push(`edge_function:");
    expect(
      source.match(/await installProviderRouteBlock\(context\)/g),
    ).toHaveLength(4);
    for (const name of [
      "WRITE-020",
      "WRITE-021",
      "PRACTICE-017",
      "PRACTICE-018",
    ]) {
      const block = namedTestBlock(name);
      expect(
        block.indexOf("await installProviderRouteBlock(context)"),
        name,
      ).toBeLessThan(block.indexOf("await context.newPage()"));
    }
  });
});
