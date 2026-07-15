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
  EXPECTED_WORKSHEET_REVIEW_PACKET_TEMPLATE_KEYS,
  verifyWorksheetReviewPacket,
  WORKSHEET_REVIEW_PACKET_STATUS,
} from "./verify-worksheet-review-packet.js";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const checkedInPacket = JSON.parse(
  await readFile(
    resolve(
      repositoryRoot,
      "quality/worksheet-bank/qualified-human-review-packet.json",
    ),
    "utf8",
  ),
) as Record<string, unknown> & { worksheets: Array<Record<string, unknown>> };

function clonePacket() {
  return structuredClone(checkedInPacket);
}

async function expectFailure(
  mutate: (packet: ReturnType<typeof clonePacket>) => void,
  pattern: RegExp,
) {
  const packet = clonePacket();
  mutate(packet);
  const report = await verifyWorksheetReviewPacket(packet, repositoryRoot);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), pattern);
}

test("the exact breadth-first 80-worksheet packet remains non-certifying and hash-bound", async () => {
  const report = await verifyWorksheetReviewPacket(
    checkedInPacket,
    repositoryRoot,
  );
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.totalWorksheets, 80);
  assert.equal(report.totalQuestions, 720);
  assert.deepEqual(report.worksheetsPerLevel, {
    A1: 20,
    A2: 20,
    B1: 20,
    B2: 20,
  });
  assert.equal(checkedInPacket.status, WORKSHEET_REVIEW_PACKET_STATUS);
  assert.equal(checkedInPacket.launch_evidence_eligible, false);
  assert.equal(checkedInPacket.deployment_eligible, false);
  for (const level of ["A1", "A2", "B1", "B2"] as const) {
    assert.equal(report.topicsPerLevel[level].length, 20);
  }
  assert.deepEqual(
    checkedInPacket.worksheets.map((entry) => entry.template_key),
    EXPECTED_WORKSHEET_REVIEW_PACKET_TEMPLATE_KEYS,
  );
});

test("rejects a missing worksheet file", async () => {
  await expectFailure((packet) => {
    packet.worksheets[0].current_file_path =
      "quality/worksheet-bank/drafts/a1/v1-a1-missing-r1.json";
    packet.worksheets[0].template_key = "v1-a1-missing-r1";
  }, /points to a missing file/);
});

test("rejects a worksheet path that escapes through a symlink", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "worksheet-review-packet-"),
  );
  const outsideFile = join(
    tmpdir(),
    `${temporaryRoot.split("/").pop()}-outside.json`,
  );
  try {
    const packet = clonePacket();
    const firstPath = String(packet.worksheets[0].current_file_path);
    await writeFile(outsideFile, "{}", "utf8");
    await mkdir(dirname(join(temporaryRoot, firstPath)), { recursive: true });
    await symlink(outsideFile, join(temporaryRoot, firstPath));

    const report = await verifyWorksheetReviewPacket(packet, temporaryRoot);
    assert.equal(report.ok, false);
    assert.match(
      report.errors.join("\n"),
      /regular non-symlink file|resolves outside the real repository root/,
    );
  } finally {
    await rm(outsideFile, { force: true });
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("rejects worksheet hash drift", async () => {
  await expectFailure((packet) => {
    packet.worksheets[0].current_sha256 = "0".repeat(64);
  }, /hash drift/);
});

test("rejects the wrong packet or worksheet review status", async () => {
  await expectFailure((packet) => {
    packet.status = "pending";
    packet.worksheets[0].review_status = "pending";
  }, /status must be awaiting_qualified_human_review/);
});

test("rejects duplicate worksheet identities", async () => {
  await expectFailure((packet) => {
    packet.worksheets[1] = structuredClone(packet.worksheets[0]);
  }, /duplicates template_key|duplicates current_file_path|duplicates current_sha256/);
});

test("rejects drift from the exact selected 80 templates", async () => {
  await expectFailure((packet) => {
    packet.worksheets[0].template_key = "v1-a1-nominativ-r1";
  }, /selection drift/);
});

test("rejects canonical breadth-first order drift", async () => {
  await expectFailure((packet) => {
    [packet.worksheets[0], packet.worksheets[1]] = [
      packet.worksheets[1],
      packet.worksheets[0],
    ];
  }, /canonical breadth-first order drifted/);
});

test("rejects per-level count drift", async () => {
  await expectFailure((packet) => {
    packet.worksheets[0].level = "A2";
  }, /19\/20 worksheets for A1|21\/20 worksheets for A2/);
});

test("rejects loss of 20 distinct topics within a level", async () => {
  await expectFailure((packet) => {
    packet.worksheets[1].topic_slug = packet.worksheets[0].topic_slug;
  }, /19\/20 distinct topics for A1|topic_slug does not match/);
});

test("rejects any approval or certification claim", async () => {
  await expectFailure((packet) => {
    packet.worksheets[0].approval_status = "approved";
  }, /forbidden approval or certification evidence|approval or certification claim/);
});

test("rejects launch or deployment eligibility claims", async () => {
  await expectFailure((packet) => {
    packet.launch_evidence_eligible = true;
    packet.deployment_eligible = true;
  }, /must not count as launch evidence|must not be deployment eligible/);
});

test("rejects a coordinated priority-content and manifest-hash repin", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "worksheet-priority-root-"),
  );
  try {
    const packet = clonePacket();
    for (const item of packet.worksheets) {
      const source = resolve(repositoryRoot, String(item.current_file_path));
      const target = resolve(temporaryRoot, String(item.current_file_path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(source));
    }
    const entry = packet.worksheets[0];
    const worksheetPath = resolve(
      temporaryRoot,
      String(entry.current_file_path),
    );
    const worksheet = JSON.parse(
      await readFile(worksheetPath, "utf8"),
    ) as Record<string, unknown>;
    worksheet.title = `${String(worksheet.title)} – verändert`;
    const raw = `${JSON.stringify(worksheet, null, 2)}\n`;
    await writeFile(worksheetPath, raw, "utf8");
    entry.current_sha256 = createHash("sha256").update(raw).digest("hex");

    const report = await verifyWorksheetReviewPacket(packet, temporaryRoot);
    assert.equal(report.ok, false);
    assert.match(report.errors.join("\n"), /immutable snapshot root drifted/);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("rejects repinned worksheet approval claims and draft-status drift", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "worksheet-priority-copy-"),
  );
  try {
    const packet = clonePacket();
    for (const entry of packet.worksheets) {
      const source = resolve(repositoryRoot, String(entry.current_file_path));
      const target = resolve(temporaryRoot, String(entry.current_file_path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(source));
    }
    const entry = packet.worksheets[0];
    const worksheetPath = resolve(
      temporaryRoot,
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
    const approvalReport = await verifyWorksheetReviewPacket(
      packet,
      temporaryRoot,
    );
    assert.equal(approvalReport.ok, false);
    assert.match(
      approvalReport.errors.join("\n"),
      /forbidden review or release evidence/,
    );

    delete questions[0].humanApproved;
    worksheet.draft_metadata.approval_status = "approved";
    raw = `${JSON.stringify(worksheet, null, 2)}\n`;
    await writeFile(worksheetPath, raw, "utf8");
    entry.current_sha256 = createHash("sha256").update(raw).digest("hex");
    const statusReport = await verifyWorksheetReviewPacket(
      packet,
      temporaryRoot,
    );
    assert.equal(statusReport.ok, false);
    assert.match(
      statusReport.errors.join("\n"),
      /invalid non-certifying draft status/,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
