import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(process.cwd(), "../../.github/workflows/verify.yml"),
  "utf8",
);

describe("launch verification workflow", () => {
  it("runs browser and disposable-database gates on pull requests and pushes", () => {
    expect(workflow.match(/if: github\.event_name != 'workflow_dispatch' \|\| inputs\./g))
      .toHaveLength(2);
    expect(workflow).toContain("run: supabase start");
    expect(workflow).toContain("run: supabase db reset --local");
    expect(workflow).toContain("run: supabase test db");
    expect(workflow).toContain("version: 2.109.1");
  });
});
