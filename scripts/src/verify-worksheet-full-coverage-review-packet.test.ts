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
import test, { after } from "node:test";
import {
  canonicalWorksheetTemplateContexts,
  canonicalWorksheetTopics,
  secondRevisionTopicsByLevel,
  worksheetLevels,
} from "./verify-worksheet-authoring-matrix.js";
import {
  verifyWorksheetFullCoverageReviewPacket,
  WORKSHEET_FULL_COVERAGE_REVIEW_STATUS,
} from "./verify-worksheet-full-coverage-review-packet.js";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const checkedInFullCoveragePacket = JSON.parse(
  await readFile(
    resolve(
      repositoryRoot,
      "quality/worksheet-bank/qualified-human-review-packet-full-coverage.json",
    ),
    "utf8",
  ),
) as Packet;

type Packet = Record<string, unknown> & {
  worksheets: Array<Record<string, unknown>>;
};

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "worksheet-full-review-"));
  const worksheets: Array<Record<string, unknown>> = [];
  for (const context of canonicalWorksheetTemplateContexts) {
    const currentFilePath = `quality/worksheet-bank/drafts/${context.level.toLowerCase()}/${context.templateKey}.json`;
    const raw = await readFile(resolve(repositoryRoot, currentFilePath));
    const target = resolve(root, currentFilePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, raw);
    const worksheet = JSON.parse(raw.toString("utf8")) as {
      questions: Array<{ evaluation_mode: string }>;
    };
    worksheets.push({
      template_key: context.templateKey,
      current_file_path: currentFilePath,
      current_sha256: createHash("sha256").update(raw).digest("hex"),
      level: context.level,
      topic_slug: context.topicSlug,
      question_counts: {
        total: worksheet.questions.length,
        local_exact: worksheet.questions.filter(
          (question) => question.evaluation_mode === "local_exact",
        ).length,
        open_evaluation: worksheet.questions.filter(
          (question) => question.evaluation_mode === "open_evaluation",
        ).length,
      },
      review_status: WORKSHEET_FULL_COVERAGE_REVIEW_STATUS,
    });
  }
  const packet: Packet = {
    schema_version: 1,
    packet_id: "schreiben-v1-worksheet-qualified-human-review-full-coverage-1",
    artifact_kind: "qualified_human_review_packet_manifest",
    coverage_kind: "all_current_draft_worksheets",
    status: WORKSHEET_FULL_COVERAGE_REVIEW_STATUS,
    launch_evidence_eligible: false,
    deployment_eligible: false,
    required_distribution: {
      total_worksheets: 184,
      worksheets_per_level: { A1: 46, A2: 46, B1: 46, B2: 46 },
      distinct_topics_per_level: 36,
      foundation_revisions_per_level: 36,
      priority_second_revisions_per_level: 10,
    },
    worksheets,
  };
  return { root, packet };
}

const fixture = await createFixture();
after(async () => {
  await rm(fixture.root, { force: true, recursive: true });
});

function clonePacket() {
  return structuredClone(fixture.packet);
}

test("the checked-in full-coverage packet pins the frozen 184-draft snapshot", async () => {
  const report = await verifyWorksheetFullCoverageReviewPacket(
    checkedInFullCoveragePacket,
    repositoryRoot,
  );
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.totalWorksheets, 184);
  assert.equal(report.totalQuestions, 1656);
  assert.deepEqual(report.worksheetsPerLevel, {
    A1: 46,
    A2: 46,
    B1: 46,
    B2: 46,
  });
});

async function expectFailure(
  mutate: (packet: Packet) => void,
  pattern: RegExp,
) {
  const packet = clonePacket();
  mutate(packet);
  const report = await verifyWorksheetFullCoverageReviewPacket(
    packet,
    fixture.root,
  );
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), pattern);
}

test("an isolated snapshot of all 184 drafts satisfies the non-certifying full-coverage contract", async () => {
  const report = await verifyWorksheetFullCoverageReviewPacket(
    fixture.packet,
    fixture.root,
  );
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.totalWorksheets, 184);
  assert.equal(report.totalQuestions, 1656);
  assert.deepEqual(report.worksheetsPerLevel, {
    A1: 46,
    A2: 46,
    B1: 46,
    B2: 46,
  });
  for (const level of worksheetLevels) {
    assert.deepEqual(
      report.topicsPerLevel[level],
      [...canonicalWorksheetTopics].sort(),
    );
    assert.deepEqual(
      report.secondRevisionTopicsPerLevel[level],
      [...secondRevisionTopicsByLevel[level]].sort(),
    );
  }
  assert.equal(fixture.packet.status, WORKSHEET_FULL_COVERAGE_REVIEW_STATUS);
  assert.equal(fixture.packet.launch_evidence_eligible, false);
  assert.equal(fixture.packet.deployment_eligible, false);
});

test("rejects a missing worksheet file", async () => {
  await expectFailure((packet) => {
    packet.worksheets[0].current_file_path =
      "quality/worksheet-bank/drafts/a1/missing.json";
  }, /points to a missing file|does not match its level and template_key/);
});

test("rejects a worksheet path that escapes through a symlinked parent", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "worksheet-full-root-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "worksheet-full-outside-"));
  try {
    const first = fixture.packet.worksheets[0];
    const escapedFile = resolve(
      outsideRoot,
      String(first.current_file_path).replace(/^quality\//u, ""),
    );
    await mkdir(dirname(escapedFile), { recursive: true });
    await writeFile(
      escapedFile,
      await readFile(resolve(fixture.root, String(first.current_file_path))),
    );
    await symlink(outsideRoot, resolve(temporaryRoot, "quality"));

    const report = await verifyWorksheetFullCoverageReviewPacket(
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

test("rejects worksheet hash and question-count drift", async () => {
  await expectFailure((packet) => {
    packet.worksheets[0].current_sha256 = "0".repeat(64);
    const counts = packet.worksheets[1].question_counts as Record<
      string,
      number
    >;
    counts.total += 1;
  }, /hash drift|question_counts/);
});

test("rejects a coordinated worksheet-content and manifest-hash repin", async () => {
  const isolated = await createFixture();
  try {
    const entry = isolated.packet.worksheets[0];
    const worksheetPath = resolve(
      isolated.root,
      String(entry.current_file_path),
    );
    const worksheet = JSON.parse(
      await readFile(worksheetPath, "utf8"),
    ) as Record<string, unknown>;
    worksheet.title = `${String(worksheet.title)} – verändert`;
    const raw = `${JSON.stringify(worksheet, null, 2)}\n`;
    await writeFile(worksheetPath, raw, "utf8");
    entry.current_sha256 = createHash("sha256").update(raw).digest("hex");

    const report = await verifyWorksheetFullCoverageReviewPacket(
      isolated.packet,
      isolated.root,
    );
    assert.equal(report.ok, false);
    assert.match(report.errors.join("\n"), /immutable snapshot root drifted/);
  } finally {
    await rm(isolated.root, { force: true, recursive: true });
  }
});

test("rejects duplicate worksheet identities", async () => {
  await expectFailure((packet) => {
    packet.worksheets[1] = structuredClone(packet.worksheets[0]);
  }, /duplicates template_key|duplicates current_file_path|duplicates current_sha256/);
});

test("rejects closed-topic, level, or priority-r2 coverage drift", async () => {
  await expectFailure((packet) => {
    packet.worksheets[0].level = "A2";
    packet.worksheets[0].topic_slug = "invented-topic";
  }, /level or topic_slug|46 worksheets for A1|all 36 closed topics/);
});

test("rejects the wrong packet or worksheet status", async () => {
  await expectFailure((packet) => {
    packet.status = "pending";
    packet.worksheets[0].review_status = "pending";
  }, /status must be awaiting_qualified_human_review/);
});

test("rejects manifest approval claims and launch or deployment eligibility", async () => {
  await expectFailure((packet) => {
    packet.worksheets[0].human_approved = true;
    packet.launch_evidence_eligible = true;
    packet.deployment_eligible = true;
  }, /forbidden approval or certification evidence|must not count as launch evidence|must not be deployment eligible/);
});

test("rejects repinned worksheet approval claims and non-certifying status drift", async () => {
  const isolated = await createFixture();
  try {
    const entry = isolated.packet.worksheets[0];
    const worksheetPath = resolve(
      isolated.root,
      String(entry.current_file_path),
    );
    const worksheet = JSON.parse(
      await readFile(worksheetPath, "utf8"),
    ) as Record<string, unknown> & {
      draft_metadata: Record<string, unknown>;
    };
    const questions = worksheet.questions as Array<Record<string, unknown>>;
    questions[0].humanApproved = true;
    let raw = `${JSON.stringify(worksheet, null, 2)}\n`;
    await writeFile(worksheetPath, raw, "utf8");
    entry.current_sha256 = createHash("sha256").update(raw).digest("hex");

    const approvalReport = await verifyWorksheetFullCoverageReviewPacket(
      isolated.packet,
      isolated.root,
    );
    assert.equal(approvalReport.ok, false);
    assert.match(
      approvalReport.errors.join("\n"),
      /forbidden review or release evidence/,
    );

    delete questions[0].humanApproved;
    questions[0].notes = "Reviewed and approved by a qualified reviewer.";
    raw = `${JSON.stringify(worksheet, null, 2)}\n`;
    await writeFile(worksheetPath, raw, "utf8");
    entry.current_sha256 = createHash("sha256").update(raw).digest("hex");
    const nestedClaimReport = await verifyWorksheetFullCoverageReviewPacket(
      isolated.packet,
      isolated.root,
    );
    assert.equal(nestedClaimReport.ok, false);
    assert.match(
      nestedClaimReport.errors.join("\n"),
      /positive approval or certification claim/,
    );

    delete questions[0].notes;
    worksheet.draft_metadata.approval_status = "approved";
    raw = `${JSON.stringify(worksheet, null, 2)}\n`;
    await writeFile(worksheetPath, raw, "utf8");
    entry.current_sha256 = createHash("sha256").update(raw).digest("hex");
    const statusReport = await verifyWorksheetFullCoverageReviewPacket(
      isolated.packet,
      isolated.root,
    );
    assert.equal(statusReport.ok, false);
    assert.match(
      statusReport.errors.join("\n"),
      /invalid non-certifying draft status/,
    );
  } finally {
    await rm(isolated.root, { force: true, recursive: true });
  }
});
