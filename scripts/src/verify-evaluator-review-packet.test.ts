import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  EVALUATOR_REVIEW_PACKET_CATEGORIES,
  EVALUATOR_REVIEW_PACKET_STATUS,
  EXPECTED_EVALUATOR_REVIEW_SOURCE_PATHS,
  verifyEvaluatorReviewPacket,
} from "./verify-evaluator-review-packet.js";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const checkedInPacket = JSON.parse(
  await readFile(
    resolve(
      repositoryRoot,
      "quality/evaluator-corpus/qualified-human-review-packet.json",
    ),
    "utf8",
  ),
) as Record<string, unknown> & {
  source_files: Array<Record<string, unknown>>;
  cases: Array<Record<string, unknown>>;
};

function clonePacket() {
  return structuredClone(checkedInPacket);
}

async function expectFailure(
  mutate: (packet: ReturnType<typeof clonePacket>) => void,
  pattern: RegExp,
) {
  const packet = clonePacket();
  mutate(packet);
  const report = await verifyEvaluatorReviewPacket(packet, repositoryRoot);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), pattern);
}

async function copyCandidateSources(temporaryRoot: string) {
  for (const sourcePath of EXPECTED_EVALUATOR_REVIEW_SOURCE_PATHS) {
    const target = resolve(temporaryRoot, sourcePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      await readFile(resolve(repositoryRoot, sourcePath)),
    );
  }
}

test("the exact 600-case evaluator packet remains non-certifying and hash-bound", async () => {
  const report = await verifyEvaluatorReviewPacket(
    checkedInPacket,
    repositoryRoot,
  );
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.totalSourceFiles, 7);
  assert.equal(report.totalCases, 600);
  assert.deepEqual(report.casesPerLevel, {
    A1: 150,
    A2: 150,
    B1: 150,
    B2: 150,
  });
  for (const level of ["A1", "A2", "B1", "B2"] as const) {
    for (const category of EVALUATOR_REVIEW_PACKET_CATEGORIES) {
      assert.equal(report.categoriesPerLevel[level][category], 10);
    }
  }
  assert.equal(checkedInPacket.status, EVALUATOR_REVIEW_PACKET_STATUS);
  assert.equal(checkedInPacket.launch_evidence_eligible, false);
  assert.equal(checkedInPacket.deployment_eligible, false);
  assert.deepEqual(
    checkedInPacket.source_files.map((source) => source.current_file_path),
    EXPECTED_EVALUATOR_REVIEW_SOURCE_PATHS,
  );
});

test("rejects a missing candidate source file", async () => {
  await expectFailure((packet) => {
    packet.source_files[0].current_file_path =
      "quality/evaluator-corpus/drafts/a1/missing.jsonl";
  }, /points to a missing file|exact candidate source path/);
});

test("rejects a source path that escapes through a symlinked parent", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluator-review-root-"));
  const outsideRoot = await mkdtemp(
    join(tmpdir(), "evaluator-review-outside-"),
  );
  try {
    const escapedFile = resolve(
      outsideRoot,
      "evaluator-corpus/drafts/a1/candidates.jsonl",
    );
    await mkdir(dirname(escapedFile), { recursive: true });
    await writeFile(escapedFile, "{}\n", "utf8");
    await symlink(outsideRoot, resolve(temporaryRoot, "quality"));

    const report = await verifyEvaluatorReviewPacket(
      clonePacket(),
      temporaryRoot,
    );
    assert.equal(report.ok, false);
    assert.match(
      report.errors.join("\n"),
      /resolves outside the real repository root through a symlink/,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
    await rm(outsideRoot, { force: true, recursive: true });
  }
});

test("rejects source-file and case-content hash drift", async () => {
  await expectFailure((packet) => {
    packet.source_files[0].current_sha256 = "0".repeat(64);
    packet.cases[0].current_sha256 = "1".repeat(64);
  }, /hash drift|content hash drifted/);
});

test("rejects id, level, and primary-category drift", async () => {
  await expectFailure((packet) => {
    packet.cases[0].id = "A1-EVAL-999";
    packet.cases[1].level = "A2";
    packet.cases[2].primary_category = "decimal";
  }, /id does not match source content|level does not match source content|primary_category does not match source content/);
});

test("rejects source-file count and category-distribution drift", async () => {
  await expectFailure((packet) => {
    packet.source_files[0].case_count = 149;
    const counts = packet.source_files[0].category_counts as Record<
      string,
      number
    >;
    counts.decimal = 9;
  }, /case_count does not match|category_counts do not match/);
});

test("rejects duplicate case ids, coordinates, and hashes", async () => {
  await expectFailure((packet) => {
    packet.cases[1] = structuredClone(packet.cases[0]);
  }, /duplicates id|duplicates source coordinate|duplicates a case hash/);
});

test("rejects wrong packet, source, or case review status", async () => {
  await expectFailure((packet) => {
    packet.status = "pending";
    packet.source_files[0].review_status = "pending";
    packet.cases[0].review_status = "pending";
  }, /status must be awaiting_qualified_human_review/);
});

test("rejects any manifest approval or certification claim", async () => {
  await expectFailure((packet) => {
    packet.cases[0].approval_status = "approved";
  }, /forbidden approval or certification evidence|approval or certification claim/);
});

test("rejects launch or deployment eligibility claims", async () => {
  await expectFailure((packet) => {
    packet.launch_evidence_eligible = true;
    packet.deployment_eligible = true;
  }, /must not count as launch evidence|must not be deployment eligible/);
});

test("rejects repinned source approval claims and private-candidate status drift", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluator-review-copy-"));
  try {
    await copyCandidateSources(temporaryRoot);
    const packet = clonePacket();
    const sourcePath = String(packet.source_files[0].current_file_path);
    const sourceFile = resolve(temporaryRoot, sourcePath);
    const lines = (await readFile(sourceFile, "utf8")).trimEnd().split("\n");
    const candidate = JSON.parse(lines[0]) as Record<string, unknown>;
    candidate.human_approved = true;
    candidate.human_review_complete = true;
    lines[0] = JSON.stringify(candidate);
    let updated = `${lines.join("\n")}\n`;
    const repin = async () => {
      await writeFile(sourceFile, updated, "utf8");
      packet.source_files[0].current_sha256 = createHash("sha256")
        .update(updated)
        .digest("hex");
      packet.cases[0].current_sha256 = createHash("sha256")
        .update(lines[0])
        .digest("hex");
    };
    await repin();

    const approvalReport = await verifyEvaluatorReviewPacket(
      packet,
      temporaryRoot,
    );
    assert.equal(approvalReport.ok, false);
    assert.match(
      approvalReport.errors.join("\n"),
      /forbidden approval or certification evidence|missing or unexpected candidate keys/,
    );

    delete candidate.human_approved;
    delete candidate.human_review_complete;
    candidate.authoring_status = "review_complete";
    lines[0] = JSON.stringify(candidate);
    updated = `${lines.join("\n")}\n`;
    await repin();
    const statusReport = await verifyEvaluatorReviewPacket(
      packet,
      temporaryRoot,
    );
    assert.equal(statusReport.ok, false);
    assert.match(
      statusReport.errors.join("\n"),
      /invalid private candidate status/,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
