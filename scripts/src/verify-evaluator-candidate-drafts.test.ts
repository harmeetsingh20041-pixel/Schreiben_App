import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const level of ["a1", "a2", "b1", "b2"] as const) {
  test(`the checked-in ${level.toUpperCase()} evaluator candidates satisfy their strict local contract`, () => {
    const verifier = fileURLToPath(
      new URL(
        `../../quality/evaluator-corpus/drafts/${level}/verify-candidates.mjs`,
        import.meta.url,
      ),
    );
    const result = spawnSync(process.execPath, [verifier], {
      encoding: "utf8",
      env: {},
      timeout: 10_000,
    });

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.notEqual(report.ok, false);
    assert.equal(report.total ?? report.candidate_count, 150);
    assert.equal(report.accepted ?? report.accepted_candidates, 140);
    assert.equal(report.held ?? report.expected_private_holds, 10);
    assert.equal(
      report.counts_as_launch_evidence ?? report.contains_release_evidence,
      false,
    );
    if (level === "a2") {
      assert.deepEqual(report.line_status_counts, {
        correct: 26,
        acceptable_for_level: 15,
        minor_issue: 85,
        major_issue: 14,
      });
    }
  });
}
