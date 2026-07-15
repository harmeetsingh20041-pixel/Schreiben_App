import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);
const gitignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");

test("manual Playwright CLI output is ignored at every repository depth", () => {
  assert.match(gitignore, /^\.playwright-cli\/$/m);

  for (const candidate of [
    ".playwright-cli/manual-session/snapshot.yml",
    "artifacts/german-writing-coach/.playwright-cli/manual-session/snapshot.yml",
    "scripts/.playwright-cli/manual-session/snapshot.yml",
  ]) {
    assert.doesNotThrow(
      () => {
        execFileSync(
          "git",
          ["check-ignore", "--quiet", "--no-index", "--", candidate],
          { cwd: repositoryRoot },
        );
      },
      `expected Git to ignore ${candidate}`,
    );
  }
});
