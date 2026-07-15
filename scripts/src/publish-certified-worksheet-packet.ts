import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertCertifiedWorksheetMatrixIdentity,
  assertWorksheetArtifactEligibleForWrite,
  validateWorksheet,
  type WorksheetBankCertification,
  type WorksheetImport,
} from "./import-practice-worksheet.js";
import { verifyWorksheetFullCoverageReviewPacket } from "./verify-worksheet-full-coverage-review-packet.js";
import { verifyWorksheetReviewPacket } from "./verify-worksheet-review-packet.js";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

const priorityPacketId =
  "schreiben-v1-launch-worksheet-qualified-human-review-packet-1";
const fullCoveragePacketId =
  "schreiben-v1-worksheet-qualified-human-review-full-coverage-1";
const trustedReviewPacketHashes = new Map([
  [
    priorityPacketId,
    "878802d40e443b965c53b125dac102ae17d1acc85091dc77cb1a8e1ac53ac1b1",
  ],
  [
    fullCoveragePacketId,
    "b4ff1c25d4fd43c1cb8d4aa487518dd4a2a8b506a48faa7d89f002ba4b79d916",
  ],
]);
const releaseManifestKind =
  "qualified_human_worksheet_release_manifest" as const;
const releaseManifestStatus = "qualified_human_approved_for_release" as const;
const approvedDecision = "approved" as const;
const sha256Pattern = /^[a-f0-9]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const projectRefPattern = /^[a-z0-9]{20}$/;
const templateKeyPattern = /^[a-z0-9][a-z0-9._-]{5,119}$/;
const utcTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const checklistKeys = [
  "structural_valid",
  "ambiguity_free",
  "no_answer_leakage",
  "level_fit",
  "topic_fit",
  "type_balance",
  "scoring_safe",
] as const;
const releaseManifestKeys = [
  "schema_version",
  "artifact_kind",
  "source_packet_id",
  "source_packet_sha256",
  "status",
  "reviewed_at",
  "release_authorized_at",
  "reviewer_id",
  "releaser_id",
  "review_checklist",
  "review_notes",
  "release_notes",
  "worksheets",
] as const;
const releaseWorksheetKeys = [
  "template_key",
  "current_sha256",
  "decision",
] as const;

type ReviewPacketEntry = {
  template_key: string;
  current_file_path: string;
  current_sha256: string;
  level: string;
  topic_slug: string;
};

type ReviewPacket = {
  packet_id: string;
  worksheets: ReviewPacketEntry[];
};

type ReleaseWorksheetAttestation = {
  template_key: string;
  current_sha256: string;
  decision: typeof approvedDecision;
};

export type QualifiedWorksheetReleaseManifest = {
  schema_version: 1;
  artifact_kind: typeof releaseManifestKind;
  source_packet_id: string;
  source_packet_sha256: string;
  status: typeof releaseManifestStatus;
  reviewed_at: string;
  release_authorized_at: string;
  reviewer_id: string;
  releaser_id: string;
  review_checklist: WorksheetBankCertification["review_checklist"];
  review_notes: string;
  release_notes: string;
  worksheets: ReleaseWorksheetAttestation[];
};

export type PreparedWorksheetPublication = {
  templateKey: string;
  sourceFilePath: string;
  sourceSha256: string;
  worksheet: WorksheetImport;
};

export type PreparedPacketPublication = {
  sourcePacketId: string;
  sourcePacketSha256: string;
  sourcePacketRaw: string;
  releaseManifestSha256: string;
  releaseManifestRaw: string;
  manifest: QualifiedWorksheetReleaseManifest;
  worksheets: PreparedWorksheetPublication[];
};

type CliArgs = {
  reviewPacketPath: string;
  releaseManifestPath: string;
  linkedDb: boolean;
  expectedProjectRef: string | null;
};

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  pnpm --dir scripts worksheet-bank:publish-packet --review-packet <non-certifying-review-packet.json> --release-manifest <qualified-release-manifest.json>",
      "  pnpm --dir scripts worksheet-bank:publish-packet --review-packet <non-certifying-review-packet.json> --release-manifest <qualified-release-manifest.json> --linked-db --expected-project-ref <20-character-project-ref>",
      "Without --linked-db this command is a read-only dry run.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    reviewPacketPath: "",
    releaseManifestPath: "",
    linkedDb: false,
    expectedProjectRef: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--review-packet") {
      args.reviewPacketPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--release-manifest") {
      args.releaseManifestPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--linked-db") {
      args.linkedDb = true;
      continue;
    }
    if (arg === "--expected-project-ref") {
      args.expectedProjectRef = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    usage();
  }

  if (!args.reviewPacketPath || !args.releaseManifestPath) usage();
  if (
    args.linkedDb &&
    (!args.expectedProjectRef ||
      !projectRefPattern.test(args.expectedProjectRef))
  ) {
    throw new Error(
      "--linked-db requires --expected-project-ref with the exact 20-character linked project ref.",
    );
  }
  if (!args.linkedDb && args.expectedProjectRef) {
    throw new Error("--expected-project-ref is only used with --linked-db.");
  }
  return args;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function cleanAuditText(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const cleaned = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (cleaned.length < 16 || cleaned.length > 1000) {
    throw new Error(`${label} must contain 16-1000 characters.`);
  }
  return cleaned;
}

function parseUtcTimestamp(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !utcTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be a valid UTC timestamp.`);
  }
  return value;
}

function validateChecklist(value: unknown) {
  const checklist = asRecord(value, "release_manifest.review_checklist");
  if (
    !hasExactKeys(checklist, checklistKeys) ||
    checklistKeys.some((key) => checklist[key] !== true)
  ) {
    throw new Error(
      "release_manifest.review_checklist must contain exactly the seven required checks, all explicitly true.",
    );
  }
  return Object.fromEntries(
    checklistKeys.map((key) => [key, true]),
  ) as WorksheetBankCertification["review_checklist"];
}

export function validateQualifiedWorksheetReleaseManifest(
  value: unknown,
): QualifiedWorksheetReleaseManifest {
  const manifest = asRecord(value, "release_manifest");
  if (!hasExactKeys(manifest, releaseManifestKeys)) {
    throw new Error(
      "release_manifest has missing or unexpected top-level keys.",
    );
  }
  if (manifest.schema_version !== 1) {
    throw new Error("release_manifest.schema_version must be 1.");
  }
  if (manifest.artifact_kind !== releaseManifestKind) {
    throw new Error(
      `release_manifest.artifact_kind must be ${releaseManifestKind}.`,
    );
  }
  if (manifest.status !== releaseManifestStatus) {
    throw new Error(
      `release_manifest.status must be ${releaseManifestStatus}.`,
    );
  }
  if (
    typeof manifest.source_packet_id !== "string" ||
    ![priorityPacketId, fullCoveragePacketId].includes(
      manifest.source_packet_id,
    )
  ) {
    throw new Error("release_manifest.source_packet_id is not supported.");
  }
  if (
    typeof manifest.source_packet_sha256 !== "string" ||
    !sha256Pattern.test(manifest.source_packet_sha256)
  ) {
    throw new Error(
      "release_manifest.source_packet_sha256 must be a lowercase SHA-256.",
    );
  }
  if (
    typeof manifest.reviewer_id !== "string" ||
    !uuidPattern.test(manifest.reviewer_id) ||
    manifest.reviewer_id !== manifest.reviewer_id.toLowerCase() ||
    typeof manifest.releaser_id !== "string" ||
    !uuidPattern.test(manifest.releaser_id) ||
    manifest.releaser_id !== manifest.releaser_id.toLowerCase()
  ) {
    throw new Error(
      "release_manifest reviewer_id and releaser_id must be UUIDs registered in the private qualification registry.",
    );
  }

  const reviewedAt = parseUtcTimestamp(
    manifest.reviewed_at,
    "release_manifest.reviewed_at",
  );
  const releaseAuthorizedAt = parseUtcTimestamp(
    manifest.release_authorized_at,
    "release_manifest.release_authorized_at",
  );
  if (Date.parse(releaseAuthorizedAt) < Date.parse(reviewedAt)) {
    throw new Error(
      "release_manifest.release_authorized_at cannot precede reviewed_at.",
    );
  }
  const maximumAllowedTimestamp = Date.now() + 5 * 60 * 1000;
  if (
    Date.parse(reviewedAt) > maximumAllowedTimestamp ||
    Date.parse(releaseAuthorizedAt) > maximumAllowedTimestamp
  ) {
    throw new Error(
      "release_manifest review or release authorization timestamp is in the future beyond the allowed five-minute clock skew.",
    );
  }

  if (!Array.isArray(manifest.worksheets) || manifest.worksheets.length === 0) {
    throw new Error("release_manifest.worksheets must be a non-empty array.");
  }
  const worksheets = manifest.worksheets.map((rawWorksheet, index) => {
    const worksheet = asRecord(
      rawWorksheet,
      `release_manifest.worksheets[${index}]`,
    );
    if (!hasExactKeys(worksheet, releaseWorksheetKeys)) {
      throw new Error(
        `release_manifest.worksheets[${index}] has missing or unexpected keys.`,
      );
    }
    if (
      typeof worksheet.template_key !== "string" ||
      !templateKeyPattern.test(worksheet.template_key)
    ) {
      throw new Error(
        `release_manifest.worksheets[${index}].template_key is invalid.`,
      );
    }
    if (
      typeof worksheet.current_sha256 !== "string" ||
      !sha256Pattern.test(worksheet.current_sha256)
    ) {
      throw new Error(
        `release_manifest.worksheets[${index}].current_sha256 is invalid.`,
      );
    }
    if (worksheet.decision !== approvedDecision) {
      throw new Error(
        `release_manifest.worksheets[${index}].decision must be approved.`,
      );
    }
    return {
      template_key: worksheet.template_key,
      current_sha256: worksheet.current_sha256,
      decision: approvedDecision,
    };
  });

  if (
    new Set(worksheets.map((worksheet) => worksheet.template_key)).size !==
      worksheets.length ||
    new Set(worksheets.map((worksheet) => worksheet.current_sha256)).size !==
      worksheets.length
  ) {
    throw new Error(
      "release_manifest.worksheets must not duplicate a template key or source hash.",
    );
  }

  return {
    schema_version: 1,
    artifact_kind: releaseManifestKind,
    source_packet_id: manifest.source_packet_id,
    source_packet_sha256: manifest.source_packet_sha256,
    status: releaseManifestStatus,
    reviewed_at: reviewedAt,
    release_authorized_at: releaseAuthorizedAt,
    reviewer_id: manifest.reviewer_id,
    releaser_id: manifest.releaser_id,
    review_checklist: validateChecklist(manifest.review_checklist),
    review_notes: cleanAuditText(
      manifest.review_notes,
      "release_manifest.review_notes",
    ),
    release_notes: cleanAuditText(
      manifest.release_notes,
      "release_manifest.release_notes",
    ),
    worksheets,
  };
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function readPinnedRepositoryFile(filePath: string, label: string) {
  if (
    !filePath ||
    isAbsolute(filePath) ||
    filePath.includes("\\") ||
    filePath.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a repository-relative safe path.`);
  }
  const candidate = resolve(repositoryRoot, filePath);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  const realRoot = await realpath(repositoryRoot);
  const realCandidate = await realpath(candidate);
  const relativePath = relative(realRoot, realCandidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${label} resolves outside the repository.`);
  }
  const handle = await open(
    realCandidate,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new Error(`${label} must remain a regular file while it is read.`);
    }
    return {
      realPath: realCandidate,
      contents: await handle.readFile("utf8"),
    };
  } finally {
    await handle.close();
  }
}

async function readRepositoryInput(inputPath: string, label: string) {
  const absolute = resolve(inputPath);
  const relativePath = relative(repositoryRoot, absolute);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${label} must be stored inside the repository.`);
  }
  return (await readPinnedRepositoryFile(relativePath, label)).contents;
}

function educationalWorksheetFingerprint(worksheet: WorksheetImport) {
  return sha256(
    JSON.stringify({
      title: worksheet.title,
      level: worksheet.level,
      grammar_topic: worksheet.grammar_topic,
      difficulty: worksheet.difficulty,
      mini_lesson: worksheet.mini_lesson,
      questions: worksheet.questions,
    }),
  );
}

function releaseSafeTags(tags: string[]) {
  const blocked = new Set(["draft", "unapproved", "not-certified"]);
  const safe = tags.filter(
    (tag) => !blocked.has(tag.trim().toLocaleLowerCase("en-US")),
  );
  if (!safe.some((tag) => tag === "certified-bank")) {
    return [...safe.slice(0, 19), "certified-bank"];
  }
  return safe.slice(0, 20);
}

function preserveValidatedText(
  rawValue: unknown,
  normalizedValue: string | undefined,
  minLength: number,
  maxLength: number,
  label: string,
) {
  if (
    typeof rawValue !== "string" ||
    rawValue.normalize("NFC") !== rawValue ||
    rawValue.trim() !== rawValue ||
    rawValue.length < minLength ||
    rawValue.length > maxLength ||
    rawValue.replace(/\s+/g, " ") !== normalizedValue
  ) {
    throw new Error(
      `${label} would be trimmed, derived, Unicode-normalized, or truncated before publication. Qualified packet publication is rejection-only for educational text.`,
    );
  }
  return rawValue;
}

function preserveValidatedTextArray(
  rawValue: unknown,
  normalizedValue: string[],
  minItems: number,
  maxItems: number,
  maxItemLength: number,
  label: string,
) {
  if (
    !Array.isArray(rawValue) ||
    rawValue.some((value) => typeof value !== "string") ||
    rawValue.length < minItems ||
    rawValue.length > maxItems ||
    rawValue.length !== normalizedValue.length
  ) {
    throw new Error(
      `${label} would be trimmed, derived, Unicode-normalized, or truncated before publication. Qualified packet publication is rejection-only for educational text.`,
    );
  }
  return rawValue.map((value, index) =>
    preserveValidatedText(
      value,
      normalizedValue[index],
      1,
      maxItemLength,
      `${label}[${index}]`,
    ),
  );
}

export function createLosslessValidatedWorksheet(args: {
  rawWorksheet: unknown;
  worksheet: WorksheetImport;
  templateKey: string;
}) {
  const raw = asRecord(args.rawWorksheet, args.templateKey);
  const title = preserveValidatedText(
    raw.title,
    args.worksheet.title,
    1,
    120,
    `${args.templateKey}.title`,
  );
  const level = preserveValidatedText(
    raw.level,
    args.worksheet.level,
    2,
    2,
    `${args.templateKey}.level`,
  ) as WorksheetImport["level"];
  const difficulty = preserveValidatedText(
    raw.difficulty,
    args.worksheet.difficulty,
    1,
    12,
    `${args.templateKey}.difficulty`,
  ) as WorksheetImport["difficulty"];

  const rawTopic = asRecord(
    raw.grammar_topic,
    `${args.templateKey}.grammar_topic`,
  );
  const topicSlug =
    rawTopic.slug !== undefined
      ? preserveValidatedText(
          rawTopic.slug,
          args.worksheet.grammar_topic.slug,
          1,
          80,
          `${args.templateKey}.grammar_topic.slug`,
        )
      : undefined;
  const topicName =
    rawTopic.name !== undefined
      ? preserveValidatedText(
          rawTopic.name,
          args.worksheet.grammar_topic.name,
          1,
          120,
          `${args.templateKey}.grammar_topic.name`,
        )
      : undefined;

  const rawLesson = asRecord(
    raw.mini_lesson,
    `${args.templateKey}.mini_lesson`,
  );
  const miniLesson = {
    short_explanation: preserveValidatedText(
      rawLesson.short_explanation,
      args.worksheet.mini_lesson.short_explanation,
      1,
      500,
      `${args.templateKey}.mini_lesson.short_explanation`,
    ),
    key_rule: preserveValidatedText(
      rawLesson.key_rule,
      args.worksheet.mini_lesson.key_rule,
      1,
      400,
      `${args.templateKey}.mini_lesson.key_rule`,
    ),
    correct_examples: preserveValidatedTextArray(
      rawLesson.correct_examples,
      args.worksheet.mini_lesson.correct_examples,
      1,
      2,
      180,
      `${args.templateKey}.mini_lesson.correct_examples`,
    ),
    common_mistake_warning: preserveValidatedText(
      rawLesson.common_mistake_warning,
      args.worksheet.mini_lesson.common_mistake_warning,
      0,
      300,
      `${args.templateKey}.mini_lesson.common_mistake_warning`,
    ),
    what_to_revise: preserveValidatedText(
      rawLesson.what_to_revise,
      args.worksheet.mini_lesson.what_to_revise,
      0,
      300,
      `${args.templateKey}.mini_lesson.what_to_revise`,
    ),
  };

  if (
    !Array.isArray(raw.questions) ||
    raw.questions.length !== args.worksheet.questions.length
  ) {
    throw new Error(`${args.templateKey}.questions changed during validation.`);
  }
  const questions = raw.questions.map((rawQuestionValue, index) => {
    const rawQuestion = asRecord(
      rawQuestionValue,
      `${args.templateKey}.questions[${index}]`,
    );
    const question = args.worksheet.questions[index]!;
    if (rawQuestion.question_number !== question.question_number) {
      throw new Error(
        `${args.templateKey}.questions[${index}].question_number changed during validation.`,
      );
    }
    const questionType = preserveValidatedText(
      rawQuestion.question_type,
      question.question_type,
      1,
      60,
      `${args.templateKey}.questions[${index}].question_type`,
    );
    const prompt = preserveValidatedText(
      rawQuestion.prompt,
      question.prompt,
      12,
      800,
      `${args.templateKey}.questions[${index}].prompt`,
    );
    const correctAnswer = preserveValidatedText(
      rawQuestion.correct_answer,
      question.correct_answer,
      1,
      500,
      `${args.templateKey}.questions[${index}].correct_answer`,
    );
    const explanation = preserveValidatedText(
      rawQuestion.explanation,
      question.explanation,
      1,
      600,
      `${args.templateKey}.questions[${index}].explanation`,
    );
    const evaluationMode = preserveValidatedText(
      rawQuestion.evaluation_mode,
      question.evaluation_mode,
      1,
      40,
      `${args.templateKey}.questions[${index}].evaluation_mode`,
    ) as WorksheetImport["questions"][number]["evaluation_mode"];
    const options = preserveValidatedTextArray(
      rawQuestion.options,
      question.options,
      0,
      6,
      160,
      `${args.templateKey}.questions[${index}].options`,
    );
    let acceptedAnswers = question.accepted_answers;
    if (rawQuestion.accepted_answers !== undefined) {
      acceptedAnswers = preserveValidatedTextArray(
        rawQuestion.accepted_answers,
        question.accepted_answers,
        0,
        12,
        160,
        `${args.templateKey}.questions[${index}].accepted_answers`,
      );
    }
    let rubric = question.rubric;
    if (question.rubric) {
      const rawRubric = asRecord(
        rawQuestion.rubric,
        `${args.templateKey}.questions[${index}].rubric`,
      );
      const criteria = preserveValidatedTextArray(
        rawRubric.criteria,
        question.rubric.criteria,
        1,
        6,
        240,
        `${args.templateKey}.questions[${index}].rubric.criteria`,
      );
      const sampleAnswer = preserveValidatedText(
        rawRubric.sample_answer,
        question.rubric.sample_answer,
        1,
        500,
        `${args.templateKey}.questions[${index}].rubric.sample_answer`,
      );
      rubric = { criteria, sample_answer: sampleAnswer };
    } else if (
      rawQuestion.rubric !== undefined &&
      rawQuestion.rubric !== null
    ) {
      throw new Error(
        `${args.templateKey}.questions[${index}].rubric changed during validation.`,
      );
    }
    return {
      ...question,
      question_type: questionType,
      prompt,
      options,
      correct_answer: correctAnswer,
      accepted_answers: acceptedAnswers,
      rubric,
      explanation,
      evaluation_mode: evaluationMode,
    };
  });

  return {
    ...args.worksheet,
    title,
    level,
    grammar_topic: { slug: topicSlug, name: topicName },
    difficulty,
    mini_lesson: miniLesson,
    questions,
  };
}

export function createReleaseSafeWorksheet(args: {
  worksheet: WorksheetImport;
  sourcePacketId: string;
  templateKey: string;
}) {
  const beforeFingerprint = educationalWorksheetFingerprint(args.worksheet);
  const worksheet: WorksheetImport = {
    ...args.worksheet,
    visibility: "private",
    source: "manual_import",
    source_label: `Qualified human-reviewed V1 bank: ${args.sourcePacketId}`,
    tags: releaseSafeTags(args.worksheet.tags),
  };
  if (educationalWorksheetFingerprint(worksheet) !== beforeFingerprint) {
    throw new Error(
      `Release-safe metadata conversion changed educational content for ${args.templateKey}.`,
    );
  }
  assertWorksheetArtifactEligibleForWrite(worksheet);
  assertCertifiedWorksheetMatrixIdentity({
    worksheet,
    templateKey: args.templateKey,
  });
  return worksheet;
}

async function verifySourceReviewPacket(
  packet: unknown,
  sourcePacketId: string,
) {
  const report =
    sourcePacketId === priorityPacketId
      ? await verifyWorksheetReviewPacket(packet, repositoryRoot)
      : sourcePacketId === fullCoveragePacketId
        ? await verifyWorksheetFullCoverageReviewPacket(packet, repositoryRoot)
        : null;
  if (!report || !report.ok) {
    throw new Error(
      `The source review packet failed its immutable non-certifying verifier:\n${report?.errors.join("\n") ?? "unsupported packet"}`,
    );
  }
}

export async function prepareQualifiedPacketPublication(args: {
  reviewPacketPath: string;
  releaseManifestPath: string;
}): Promise<PreparedPacketPublication> {
  const reviewPacketRaw = await readRepositoryInput(
    args.reviewPacketPath,
    "review packet",
  );
  const releaseManifestRaw = await readRepositoryInput(
    args.releaseManifestPath,
    "release manifest",
  );
  const reviewPacket = asRecord(
    JSON.parse(reviewPacketRaw) as unknown,
    "review_packet",
  ) as unknown as ReviewPacket;
  const manifest = validateQualifiedWorksheetReleaseManifest(
    JSON.parse(releaseManifestRaw) as unknown,
  );

  if (reviewPacket.packet_id !== manifest.source_packet_id) {
    throw new Error(
      "release_manifest.source_packet_id does not match the review packet.",
    );
  }
  if (sha256(reviewPacketRaw) !== manifest.source_packet_sha256) {
    throw new Error(
      "release_manifest.source_packet_sha256 does not match the exact review packet bytes.",
    );
  }
  if (
    trustedReviewPacketHashes.get(manifest.source_packet_id) !==
    manifest.source_packet_sha256
  ) {
    throw new Error(
      "The exact review-packet byte hash is not pinned as a trusted V1 packet.",
    );
  }
  await verifySourceReviewPacket(reviewPacket, manifest.source_packet_id);

  if (!Array.isArray(reviewPacket.worksheets)) {
    throw new Error("review_packet.worksheets must be an array.");
  }
  if (manifest.worksheets.length !== reviewPacket.worksheets.length) {
    throw new Error(
      "release_manifest must approve every worksheet in the source review packet exactly once.",
    );
  }

  const worksheets: PreparedWorksheetPublication[] = [];
  for (let index = 0; index < reviewPacket.worksheets.length; index += 1) {
    const packetEntry = reviewPacket.worksheets[index];
    const releaseEntry = manifest.worksheets[index];
    if (
      releaseEntry.template_key !== packetEntry.template_key ||
      releaseEntry.current_sha256 !== packetEntry.current_sha256
    ) {
      throw new Error(
        `release_manifest.worksheets[${index}] does not match the source packet entry in canonical order.`,
      );
    }

    const worksheetSource = await readPinnedRepositoryFile(
      packetEntry.current_file_path,
      `review_packet.worksheets[${index}].current_file_path`,
    );
    const worksheetRaw = worksheetSource.contents;
    if (sha256(worksheetRaw) !== packetEntry.current_sha256) {
      throw new Error(
        `Worksheet source hash drifted for ${packetEntry.template_key}.`,
      );
    }
    const rawWorksheet = JSON.parse(worksheetRaw) as unknown;
    const reviewedWorksheet = createLosslessValidatedWorksheet({
      rawWorksheet,
      worksheet: validateWorksheet(rawWorksheet),
      templateKey: packetEntry.template_key,
    });
    if (
      reviewedWorksheet.level !== packetEntry.level ||
      reviewedWorksheet.grammar_topic.slug !== packetEntry.topic_slug
    ) {
      throw new Error(
        `Worksheet context drifted for ${packetEntry.template_key}.`,
      );
    }
    worksheets.push({
      templateKey: packetEntry.template_key,
      sourceFilePath: packetEntry.current_file_path,
      sourceSha256: packetEntry.current_sha256,
      worksheet: createReleaseSafeWorksheet({
        worksheet: reviewedWorksheet,
        sourcePacketId: manifest.source_packet_id,
        templateKey: packetEntry.template_key,
      }),
    });
  }

  return {
    sourcePacketId: manifest.source_packet_id,
    sourcePacketSha256: manifest.source_packet_sha256,
    sourcePacketRaw: reviewPacketRaw,
    releaseManifestSha256: sha256(releaseManifestRaw),
    releaseManifestRaw,
    manifest,
    worksheets,
  };
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

export function buildAtomicCanonicalPacketSql(
  prepared: PreparedPacketPublication,
) {
  if (prepared.worksheets.length === 0) {
    throw new Error("A certified worksheet packet cannot be empty.");
  }

  if (
    sha256(prepared.sourcePacketRaw) !== prepared.sourcePacketSha256 ||
    sha256(prepared.releaseManifestRaw) !== prepared.releaseManifestSha256
  ) {
    throw new Error("Prepared packet or release-manifest bytes drifted.");
  }
  const payloads = prepared.worksheets.map((entry) => ({
    template_key: entry.templateKey,
    source_file_path: entry.sourceFilePath,
    source_sha256: entry.sourceSha256,
    worksheet: entry.worksheet,
  }));

  return `begin;

select *
from app_private.publish_certified_worksheet_packet(
  ${sqlLiteral(prepared.sourcePacketRaw)},
  ${sqlLiteral(prepared.releaseManifestRaw)},
  ${sqlJson(payloads)}
)
order by ordinal;

commit;`;
}

export function assertLinkedProjectIdentity(
  linkedProjectRef: string,
  expectedProjectRef: string,
) {
  const linked = linkedProjectRef.trim();
  const expected = expectedProjectRef.trim();
  if (
    !projectRefPattern.test(linked) ||
    !projectRefPattern.test(expected) ||
    linked !== expected
  ) {
    throw new Error(
      "The linked Supabase project does not match --expected-project-ref; refusing worksheet-bank publication.",
    );
  }
  return linked;
}

export async function createPinnedSupabaseWorkdir(
  temporaryDirectory: string,
  expectedProjectRef: string,
) {
  if (!projectRefPattern.test(expectedProjectRef)) {
    throw new Error(
      "Cannot create a pinned workdir for an invalid project ref.",
    );
  }
  const supabaseDirectory = join(temporaryDirectory, "supabase");
  const stateDirectory = join(supabaseDirectory, ".temp");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await copyFile(
    resolve(repositoryRoot, "supabase/config.toml"),
    join(supabaseDirectory, "config.toml"),
  );
  await writeFile(join(stateDirectory, "project-ref"), expectedProjectRef, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    join(stateDirectory, "linked-project.json"),
    JSON.stringify({ ref: expectedProjectRef }),
    { encoding: "utf8", mode: 0o600 },
  );
  return temporaryDirectory;
}

async function runLinkedPublication(sql: string, expectedProjectRef: string) {
  const linkedProjectRef = await readFile(
    resolve(repositoryRoot, "supabase/.temp/project-ref"),
    "utf8",
  );
  assertLinkedProjectIdentity(linkedProjectRef, expectedProjectRef);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "schreiben-certified-worksheet-packet-"),
  );
  const sqlPath = join(temporaryDirectory, "publish.sql");
  try {
    await createPinnedSupabaseWorkdir(temporaryDirectory, expectedProjectRef);
    await writeFile(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    const pnpm = process.env.PNPM_BIN || "pnpm";
    const result = spawnSync(
      pnpm,
      [
        "dlx",
        "supabase@2.109.1",
        "--workdir",
        temporaryDirectory,
        "db",
        "query",
        "--linked",
        "--file",
        sqlPath,
      ],
      {
        stdio: "inherit",
        env: process.env,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `supabase db query failed with exit code ${result.status ?? "unknown"}.`,
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const prepared = await prepareQualifiedPacketPublication({
    reviewPacketPath: args.reviewPacketPath,
    releaseManifestPath: args.releaseManifestPath,
  });
  const sql = buildAtomicCanonicalPacketSql(prepared);

  if (!args.linkedDb) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: true,
          source_packet_id: prepared.sourcePacketId,
          source_packet_sha256: prepared.sourcePacketSha256,
          worksheet_count: prepared.worksheets.length,
          reviewer_id: prepared.manifest.reviewer_id,
          releaser_id: prepared.manifest.releaser_id,
          release_manifest_sha256: prepared.releaseManifestSha256,
          registry_verified: false,
          atomic_publication_sql_ready: true,
          canonical_only: true,
          workspace_clones_created: 0,
          publication_authorized: false,
          approval_recorded: false,
          message:
            "Dry run only; no worksheet certification, release, clone, assignment, or database write was recorded.",
        },
        null,
        2,
      ),
    );
    return;
  }

  await runLinkedPublication(sql, args.expectedProjectRef!);
}

const isMainModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Certified worksheet packet publication failed.",
    );
    process.exitCode = 1;
  });
}
