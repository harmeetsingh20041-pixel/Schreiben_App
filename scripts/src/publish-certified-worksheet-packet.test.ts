import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateWorksheet } from "./import-practice-worksheet.js";
import {
  createLosslessValidatedWorksheet,
  assertLinkedProjectIdentity,
  buildAtomicCanonicalPacketSql,
  createPinnedSupabaseWorkdir,
  createReleaseSafeWorksheet,
  prepareQualifiedPacketPublication,
  validateQualifiedWorksheetReleaseManifest,
  type PreparedPacketPublication,
  type QualifiedWorksheetReleaseManifest,
} from "./publish-certified-worksheet-packet.js";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const sourcePacketId =
  "schreiben-v1-launch-worksheet-qualified-human-review-packet-1";
const reviewerId = "00000000-0000-4000-8000-000000000001";
const releaserId = "00000000-0000-4000-8000-000000000002";

function releaseManifest(): QualifiedWorksheetReleaseManifest {
  return {
    schema_version: 1,
    artifact_kind: "qualified_human_worksheet_release_manifest",
    source_packet_id: sourcePacketId,
    source_packet_sha256: "a".repeat(64),
    status: "qualified_human_approved_for_release",
    reviewed_at: "2026-07-12T08:00:00Z",
    release_authorized_at: "2026-07-12T09:00:00Z",
    reviewer_id: reviewerId,
    releaser_id: releaserId,
    review_checklist: {
      structural_valid: true,
      ambiguity_free: true,
      no_answer_leakage: true,
      level_fit: true,
      topic_fit: true,
      type_balance: true,
      scoring_safe: true,
    },
    review_notes:
      "Qualified German-language review covered every exact hash in this packet.",
    release_notes:
      "The release controller authorized these exact reviewed hashes for the canonical bank.",
    worksheets: [
      {
        template_key: "v1-a1-articles-r1",
        current_sha256: "b".repeat(64),
        decision: "approved",
      },
    ],
  };
}

test("accepts only one exact, explicit qualified release manifest contract", () => {
  const manifest = releaseManifest();
  assert.deepEqual(
    validateQualifiedWorksheetReleaseManifest(manifest),
    manifest,
  );

  assert.throws(
    () =>
      validateQualifiedWorksheetReleaseManifest({
        ...manifest,
        approval_recorded: true,
      }),
    /missing or unexpected top-level keys/,
  );
  assert.throws(
    () =>
      validateQualifiedWorksheetReleaseManifest({
        ...manifest,
        status: "awaiting_qualified_human_review",
      }),
    /status must be qualified_human_approved_for_release/,
  );
  assert.throws(
    () =>
      validateQualifiedWorksheetReleaseManifest({
        ...manifest,
        source_packet_sha256: "A".repeat(64),
      }),
    /lowercase SHA-256/,
  );
});

test("fails closed on incomplete review, invalid authority, chronology, or duplicated attestations", () => {
  const manifest = releaseManifest();
  assert.throws(
    () =>
      validateQualifiedWorksheetReleaseManifest({
        ...manifest,
        review_checklist: {
          ...manifest.review_checklist,
          scoring_safe: false,
        },
      }),
    /all explicitly true/,
  );
  assert.throws(
    () =>
      validateQualifiedWorksheetReleaseManifest({
        ...manifest,
        reviewer_id: "not-a-uuid",
      }),
    /must be UUIDs registered in the private qualification registry/,
  );
  assert.throws(
    () =>
      validateQualifiedWorksheetReleaseManifest({
        ...manifest,
        release_authorized_at: "2026-07-12T07:59:59Z",
      }),
    /cannot precede reviewed_at/,
  );
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  assert.throws(
    () =>
      validateQualifiedWorksheetReleaseManifest({
        ...manifest,
        reviewed_at: future,
        release_authorized_at: future,
      }),
    /future beyond the allowed five-minute clock skew/,
  );
  assert.throws(
    () =>
      validateQualifiedWorksheetReleaseManifest({
        ...manifest,
        worksheets: [manifest.worksheets[0], manifest.worksheets[0]],
      }),
    /must not duplicate a template key or source hash/,
  );
});

test("converts reviewed draft metadata without changing educational content", async () => {
  const draft = JSON.parse(
    await readFile(
      resolve(
        repositoryRoot,
        "quality/worksheet-bank/drafts/a1/v1-a1-articles-r1.json",
      ),
      "utf8",
    ),
  ) as unknown;
  const reviewed = validateWorksheet(draft);
  const lossless = createLosslessValidatedWorksheet({
    rawWorksheet: draft,
    worksheet: reviewed,
    templateKey: "v1-a1-articles-r1",
  });
  assert.deepEqual(lossless, reviewed);
  const released = createReleaseSafeWorksheet({
    worksheet: reviewed,
    sourcePacketId,
    templateKey: "v1-a1-articles-r1",
  });

  assert.equal(released.title, reviewed.title);
  assert.equal(released.level, reviewed.level);
  assert.deepEqual(released.grammar_topic, reviewed.grammar_topic);
  assert.deepEqual(released.mini_lesson, reviewed.mini_lesson);
  assert.deepEqual(released.questions, reviewed.questions);
  assert.equal(released.visibility, "private");
  assert.equal(released.source, "manual_import");
  assert.match(released.source_label ?? "", /Qualified human-reviewed V1 bank/);
  assert.ok(released.tags.includes("certified-bank"));
  assert.ok(!released.tags.includes("draft"));
  assert.ok(!released.tags.includes("unapproved"));
  assert.ok(!released.tags.includes("not-certified"));
});

test("preserves deliberate internal layout but rejects trimming or truncation", async () => {
  const draft = JSON.parse(
    await readFile(
      resolve(
        repositoryRoot,
        "quality/worksheet-bank/drafts/a1/v1-a1-articles-r1.json",
      ),
      "utf8",
    ),
  ) as { questions: Array<Record<string, unknown>> };
  draft.questions[0]!.prompt = String(draft.questions[0]!.prompt).replace(
    " ",
    "\n\n",
  );
  const normalized = validateWorksheet(draft);
  const lossless = createLosslessValidatedWorksheet({
    rawWorksheet: draft,
    worksheet: normalized,
    templateKey: "v1-a1-articles-r1",
  });
  assert.equal(lossless.questions[0]!.prompt, draft.questions[0]!.prompt);
  assert.notEqual(
    lossless.questions[0]!.prompt,
    normalized.questions[0]!.prompt,
  );

  draft.questions[0]!.prompt = ` ${String(draft.questions[0]!.prompt)}`;
  const trimmed = validateWorksheet(draft);

  assert.throws(
    () =>
      createLosslessValidatedWorksheet({
        rawWorksheet: draft,
        worksheet: trimmed,
        templateKey: "v1-a1-articles-r1",
      }),
    /rejection-only for educational text/,
  );
});

test("prepares the exact immutable priority packet without certifying or writing it", async () => {
  const temporaryDirectory = await mkdtemp(
    join(repositoryRoot, ".worksheet-packet-publisher-test-"),
  );
  try {
    const reviewPacketPath = resolve(
      repositoryRoot,
      "quality/worksheet-bank/qualified-human-review-packet.json",
    );
    const reviewPacketRaw = await readFile(reviewPacketPath, "utf8");
    const reviewPacket = JSON.parse(reviewPacketRaw) as {
      packet_id: string;
      worksheets: Array<{
        template_key: string;
        current_sha256: string;
      }>;
    };
    const manifest = {
      ...releaseManifest(),
      source_packet_id: reviewPacket.packet_id,
      source_packet_sha256: createHash("sha256")
        .update(reviewPacketRaw)
        .digest("hex"),
      worksheets: reviewPacket.worksheets.map((worksheet) => ({
        template_key: worksheet.template_key,
        current_sha256: worksheet.current_sha256,
        decision: "approved",
      })),
    };
    const releaseManifestPath = join(
      temporaryDirectory,
      "test-only-release-manifest.json",
    );
    await writeFile(releaseManifestPath, JSON.stringify(manifest), "utf8");

    const prepared = await prepareQualifiedPacketPublication({
      reviewPacketPath,
      releaseManifestPath,
    });

    assert.equal(prepared.worksheets.length, 80);
    assert.equal(prepared.sourcePacketId, sourcePacketId);
    assert.ok(
      prepared.worksheets.every(
        (entry) =>
          entry.worksheet.visibility === "private" &&
          entry.worksheet.tags.includes("certified-bank") &&
          !entry.worksheet.tags.includes("draft"),
      ),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("prepares all 184 exact full-coverage worksheets with reviewed internal layout intact", async () => {
  const temporaryDirectory = await mkdtemp(
    join(repositoryRoot, ".worksheet-full-packet-publisher-test-"),
  );
  try {
    const reviewPacketPath = resolve(
      repositoryRoot,
      "quality/worksheet-bank/qualified-human-review-packet-full-coverage.json",
    );
    const reviewPacketRaw = await readFile(reviewPacketPath, "utf8");
    const reviewPacket = JSON.parse(reviewPacketRaw) as {
      packet_id: string;
      worksheets: Array<{
        template_key: string;
        current_sha256: string;
      }>;
    };
    const manifest = {
      ...releaseManifest(),
      source_packet_id: reviewPacket.packet_id,
      source_packet_sha256: createHash("sha256")
        .update(reviewPacketRaw)
        .digest("hex"),
      worksheets: reviewPacket.worksheets.map((worksheet) => ({
        template_key: worksheet.template_key,
        current_sha256: worksheet.current_sha256,
        decision: "approved",
      })),
    };
    const releaseManifestPath = join(
      temporaryDirectory,
      "test-only-full-release-manifest.json",
    );
    await writeFile(releaseManifestPath, JSON.stringify(manifest), "utf8");

    const prepared = await prepareQualifiedPacketPublication({
      reviewPacketPath,
      releaseManifestPath,
    });
    const formalMessage = prepared.worksheets.find(
      (entry) => entry.templateKey === "v1-b1-register-r1",
    );

    assert.equal(prepared.worksheets.length, 184);
    assert.ok(formalMessage);
    assert.ok(
      formalMessage.worksheet.questions
        .slice(9, 10)
        .every(
          (question) =>
            question.prompt.includes("\n") ||
            question.correct_answer.includes("\n"),
        ),
      "reviewed formal-message paragraph layout must survive publication preparation",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("builds one all-or-nothing canonical-only publication with no clone, assignment, queue, or provider path", async () => {
  const draft = validateWorksheet(
    JSON.parse(
      await readFile(
        resolve(
          repositoryRoot,
          "quality/worksheet-bank/drafts/a1/v1-a1-articles-r1.json",
        ),
        "utf8",
      ),
    ) as unknown,
  );
  const worksheet = createReleaseSafeWorksheet({
    worksheet: draft,
    sourcePacketId,
    templateKey: "v1-a1-articles-r1",
  });
  const manifest = releaseManifest();
  const sourcePacketRaw = "test-only-source-packet";
  const releaseManifestRaw = JSON.stringify(manifest);
  const prepared: PreparedPacketPublication = {
    sourcePacketId,
    sourcePacketSha256: createHash("sha256")
      .update(sourcePacketRaw)
      .digest("hex"),
    sourcePacketRaw,
    releaseManifestSha256: createHash("sha256")
      .update(releaseManifestRaw)
      .digest("hex"),
    releaseManifestRaw,
    manifest,
    worksheets: [
      {
        templateKey: "v1-a1-articles-r1",
        sourceFilePath:
          "quality/worksheet-bank/drafts/a1/v1-a1-articles-r1.json",
        sourceSha256: manifest.worksheets[0].current_sha256,
        worksheet,
      },
      {
        templateKey: "v1-a1-articles-r2",
        sourceFilePath:
          "quality/worksheet-bank/drafts/a1/v1-a1-articles-r2.json",
        sourceSha256: "c".repeat(64),
        worksheet: { ...worksheet, title: `${worksheet.title} 2` },
      },
    ],
  };
  const sql = buildAtomicCanonicalPacketSql(prepared);

  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;$/);
  assert.equal(
    (sql.match(/app_private\.publish_certified_worksheet_packet\(/g) ?? [])
      .length,
    1,
  );
  assert.doesNotMatch(sql, /publish_certified_worksheet_template/);
  assert.doesNotMatch(sql, /create temporary table/);
  assert.match(sql, /order by ordinal/);
  assert.doesNotMatch(sql, /clone_released_worksheet_template/);
  assert.doesNotMatch(sql, /public\.practice_tests/);
  assert.doesNotMatch(sql, /student_practice_assignments/);
  assert.doesNotMatch(sql, /pgmq|async_jobs|deepseek|gemini|openai/i);
});

test("refuses an empty publication packet", () => {
  const manifest = releaseManifest();
  assert.throws(
    () =>
      buildAtomicCanonicalPacketSql({
        sourcePacketId,
        sourcePacketSha256: manifest.source_packet_sha256,
        sourcePacketRaw: "",
        releaseManifestSha256: "d".repeat(64),
        releaseManifestRaw: JSON.stringify(manifest),
        manifest,
        worksheets: [],
      }),
    /cannot be empty/,
  );
});

test("refuses a linked write when the explicit project identity differs", () => {
  assert.equal(
    assertLinkedProjectIdentity(
      "abcdefghijklmnopqrst\n",
      "abcdefghijklmnopqrst",
    ),
    "abcdefghijklmnopqrst",
  );
  assert.throws(
    () =>
      assertLinkedProjectIdentity(
        "abcdefghijklmnopqrst",
        "tsrqponmlkjihgfedcba",
      ),
    /does not match --expected-project-ref/,
  );
});

test("creates an isolated CLI workdir pinned to the explicitly confirmed project", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "worksheet-pinned-workdir-test-"),
  );
  try {
    const projectRef = "abcdefghijklmnopqrst";
    await createPinnedSupabaseWorkdir(temporaryDirectory, projectRef);
    assert.equal(
      await readFile(
        join(temporaryDirectory, "supabase/.temp/project-ref"),
        "utf8",
      ),
      projectRef,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(temporaryDirectory, "supabase/.temp/linked-project.json"),
          "utf8",
        ),
      ),
      { ref: projectRef },
    );
    assert.match(
      await readFile(join(temporaryDirectory, "supabase/config.toml"), "utf8"),
      /^\[api\]/m,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
