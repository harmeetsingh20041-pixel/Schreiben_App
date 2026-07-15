import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(
  path.resolve(process.cwd(), "src/App.tsx"),
  "utf8",
);
const writeSource = readFileSync(
  path.resolve(process.cwd(), "src/pages/student/write.tsx"),
  "utf8",
);
const authSource = readFileSync(
  path.resolve(process.cwd(), "src/lib/auth.tsx"),
  "utf8",
);
const launchConfigSource = readFileSync(
  path.resolve(process.cwd(), "src/lib/launchConfig.ts"),
  "utf8",
);
const loginSource = readFileSync(
  path.resolve(process.cwd(), "src/pages/login.tsx"),
  "utf8",
);
const playwrightSource = readFileSync(
  path.resolve(process.cwd(), "playwright.config.ts"),
  "utf8",
);

function listRuntimeSources(relativeDirectory: string): string[] {
  const absoluteDirectory = path.resolve(process.cwd(), relativeDirectory);
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return listRuntimeSources(relativePath);
    return /\.(ts|tsx)$/.test(entry.name) ? [relativePath] : [];
  });
}

describe("student result route safety", () => {
  it("uses only the authorized submission detail route", () => {
    expect(appSource).not.toContain("/student/result/:id");
    expect(appSource).not.toContain("pages/student/result");
    expect(writeSource).not.toContain("/student/result/");
    expect(writeSource).not.toContain("/student/submission/mock");
  });

  it("cannot restore the retired showcase with its legacy environment flag", () => {
    expect(launchConfigSource).not.toContain("enableDemoMode");
    expect(launchConfigSource).not.toContain("VITE_ENABLE_DEMO_MODE");
    expect(loginSource).not.toContain("Interactive Demo Mode");
    expect(loginSource).not.toMatch(/continue as \(Demo\)/i);
    expect(authSource).not.toMatch(/getItem\(["']gwc_role["']\)/);
    expect(authSource).not.toMatch(/setItem\(["']gwc_role["']/);
    expect(authSource).not.toContain('authMode: "mock"');

    // Public browser smoke deliberately sets the retired flag to true. The
    // test therefore proves the current app ignores it instead of merely
    // relying on a false default.
    expect(playwrightSource).toContain(
      'VITE_ENABLE_DEMO_MODE=${authenticated ? "false" : "true"}',
    );
  });

  it("ships no mock-data module or protected-page demo fallback", () => {
    expect(
      existsSync(path.resolve(process.cwd(), "src/data/mockData.ts")),
    ).toBe(false);

    for (const relativePath of listRuntimeSources("src")) {
      const source = readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
      expect(source, relativePath).not.toMatch(/(?:@\/|\.\.\/)data\/mockData/);
      expect(source, relativePath).not.toMatch(/\bMOCK_[A-Z0-9_]+\b/);
      expect(source, relativePath).not.toMatch(/\buseRealData\b/);
    }
  });
});
