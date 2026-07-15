import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKSHEET_REVIEW_PACKET_STATUS =
  "awaiting_qualified_human_review" as const;
export const WORKSHEET_REVIEW_PACKET_TOTAL = 80;
export const WORKSHEET_REVIEW_PACKET_PER_LEVEL = 20;
export const WORKSHEET_REVIEW_PACKET_LEVELS = ["A1", "A2", "B1", "B2"] as const;
export const WORKSHEET_REVIEW_PACKET_SNAPSHOT_ROOT_SHA256 =
  "c5d9344ed5ff103b39053c3f1b236a563fa74f7afd76e27a63e1c654cc839c20";

type WorksheetReviewLevel = (typeof WORKSHEET_REVIEW_PACKET_LEVELS)[number];

const expectedTemplateSuffixesByLevel: Record<
  WorksheetReviewLevel,
  readonly string[]
> = {
  A1: [
    "articles-r1",
    "akkusativ-r2",
    "dativ-r1",
    "pronouns-r1",
    "plural-forms-r1",
    "conjugation-r2",
    "verb-position-r2",
    "word-order-r1",
    "question-formation-r2",
    "negation-r2",
    "modal-verbs-r2",
    "separable-verbs-r1",
    "prepositions-r2",
    "perfekt-r1",
    "spelling-r1",
    "capitalization-r1",
    "punctuation-r1",
    "register-r1",
    "coherence-r1",
    "task-fulfilment-r1",
  ],
  A2: [
    "articles-r1",
    "akkusativ-r1",
    "dativ-r2",
    "adjective-endings-r2",
    "pronouns-r2",
    "plural-forms-r2",
    "conjugation-r1",
    "subject-verb-agreement-r1",
    "word-order-r2",
    "question-formation-r1",
    "negation-r1",
    "modal-verbs-r1",
    "separable-verbs-r2",
    "reflexive-verbs-r1",
    "prepositions-r2",
    "conjunctions-r1",
    "subordinate-clauses-r1",
    "perfekt-r2",
    "register-r1",
    "task-fulfilment-r1",
  ],
  B1: [
    "adjective-endings-r2",
    "genitiv-r1",
    "prepositions-r1",
    "connectors-r2",
    "conjunctions-r1",
    "subordinate-clauses-r2",
    "relative-clauses-r2",
    "infinitive-zu-r2",
    "praeteritum-r2",
    "plusquamperfekt-r2",
    "future-tense-r2",
    "passive-voice-r2",
    "konjunktiv-r1",
    "modal-verbs-r1",
    "reflexive-verbs-r1",
    "word-order-r1",
    "punctuation-r1",
    "register-r1",
    "coherence-r1",
    "task-fulfilment-r1",
  ],
  B2: [
    "adjective-endings-r1",
    "genitiv-r1",
    "pronouns-r1",
    "word-order-r2",
    "sentence-structure-r1",
    "prepositions-r1",
    "conjunctions-r1",
    "connectors-r2",
    "subordinate-clauses-r2",
    "relative-clauses-r2",
    "infinitive-zu-r1",
    "plusquamperfekt-r1",
    "future-tense-r1",
    "passive-voice-r2",
    "konjunktiv-r2",
    "punctuation-r2",
    "register-r2",
    "coherence-r2",
    "task-fulfilment-r2",
    "verb-position-r1",
  ],
};

export const EXPECTED_WORKSHEET_REVIEW_PACKET_TEMPLATE_KEYS =
  WORKSHEET_REVIEW_PACKET_LEVELS.flatMap((level) =>
    expectedTemplateSuffixesByLevel[level].map(
      (suffix) => `v1-${level.toLowerCase()}-${suffix}`,
    ),
  );

export type WorksheetReviewPacketReport = {
  ok: boolean;
  errors: string[];
  totalWorksheets: number;
  worksheetsPerLevel: Record<WorksheetReviewLevel, number>;
  topicsPerLevel: Record<WorksheetReviewLevel, string[]>;
  totalQuestions: number;
};

const manifestKeys = [
  "schema_version",
  "packet_id",
  "artifact_kind",
  "status",
  "launch_evidence_eligible",
  "deployment_eligible",
  "required_distribution",
  "worksheets",
] as const;
const distributionKeys = [
  "total_worksheets",
  "worksheets_per_level",
  "distinct_topics_per_level",
] as const;
const worksheetKeys = [
  "template_key",
  "current_file_path",
  "current_sha256",
  "level",
  "topic_slug",
  "question_counts",
  "review_status",
] as const;
const questionCountKeys = ["total", "local_exact", "open_evaluation"] as const;
const worksheetTopLevelKeys = [
  "draft_metadata",
  "title",
  "level",
  "grammar_topic",
  "difficulty",
  "visibility",
  "source",
  "source_label",
  "tags",
  "mini_lesson",
  "questions",
] as const;
const worksheetMetadataKeys = [
  "schema_version",
  "slot_id",
  "template_key",
  "revision_number",
  "revision_objective_id",
  "revision_objective_category",
  "revision_objective",
  "authoring_status",
  "certification_status",
  "approval_status",
] as const;

const approvalKeyPattern =
  /(?:^|_)(?:approval|approved|certification|certified|reviewed|reviewer|signed_off|signoff)(?:_|$)/iu;
const approvalValuePattern =
  /(?:^|[_\s-])(?:approved|certified|review_complete|human_reviewed|qualified_reviewed|signed_off)(?:$|[_\s-])/iu;
const worksheetApprovalKeyPattern =
  /(?:^|_)(?:approval|approved|certification|certified|review|reviewed|reviewer|signed_off|signoff)(?:_|$)/iu;
const allowedDraftStatusKeys = new Set([
  "approval_status",
  "certification_status",
]);

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function approvalClaimPaths(
  value: unknown,
  path = "manifest",
  claims: string[] = [],
) {
  if (typeof value === "string" && approvalValuePattern.test(value)) {
    claims.push(`${path} contains an approval or certification claim`);
    return claims;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      approvalClaimPaths(item, `${path}[${index}]`, claims),
    );
    return claims;
  }
  const object = record(value);
  if (!object) return claims;
  for (const [key, item] of Object.entries(object)) {
    if (approvalKeyPattern.test(key)) {
      claims.push(
        `${path}.${key} is forbidden approval or certification evidence`,
      );
    }
    approvalClaimPaths(item, `${path}.${key}`, claims);
  }
  return claims;
}

function worksheetApprovalClaims(
  value: unknown,
  path: string,
  claims: string[] = [],
) {
  if (typeof value === "string") {
    const withoutExplicitNonClaims = value
      .replace(/\bdraft[_\s-]*unapproved\b/giu, "")
      .replace(/\bunapproved\b/giu, "")
      .replace(/\bnot[_\s-]+approved\b/giu, "")
      .replace(/\bnot[_\s-]+certified\b/giu, "");
    if (approvalValuePattern.test(withoutExplicitNonClaims)) {
      claims.push(
        `${path} contains a positive approval or certification claim`,
      );
    }
    return claims;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      worksheetApprovalClaims(item, `${path}[${index}]`, claims),
    );
    return claims;
  }
  const object = record(value);
  if (!object) return claims;
  for (const [key, child] of Object.entries(object)) {
    const normalizedKey = key
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_");
    if (
      worksheetApprovalKeyPattern.test(normalizedKey) &&
      !allowedDraftStatusKeys.has(normalizedKey)
    ) {
      claims.push(
        `${path}.${key} contains forbidden review or release evidence`,
      );
    }
    worksheetApprovalClaims(child, `${path}.${key}`, claims);
  }
  return claims;
}

function countRecord(value: unknown) {
  const object = record(value);
  if (!object || !hasExactKeys(object, questionCountKeys)) return null;
  if (
    !Number.isInteger(object.total) ||
    !Number.isInteger(object.local_exact) ||
    !Number.isInteger(object.open_evaluation)
  ) {
    return null;
  }
  return object as {
    total: number;
    local_exact: number;
    open_evaluation: number;
  };
}

function worksheetSnapshotRoot(worksheets: unknown[]) {
  const canonical = worksheets.map((rawEntry) => {
    const entry = record(rawEntry) ?? {};
    const counts = record(entry.question_counts) ?? {};
    return [
      entry.template_key,
      entry.current_file_path,
      entry.current_sha256,
      entry.level,
      entry.topic_slug,
      counts.total,
      counts.local_exact,
      counts.open_evaluation,
      entry.review_status,
    ];
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function emptyLevelCounts(): Record<WorksheetReviewLevel, number> {
  return { A1: 0, A2: 0, B1: 0, B2: 0 };
}

function emptyLevelTopicSets(): Record<WorksheetReviewLevel, Set<string>> {
  return { A1: new Set(), A2: new Set(), B1: new Set(), B2: new Set() };
}

function isWorksheetReviewLevel(value: unknown): value is WorksheetReviewLevel {
  return WORKSHEET_REVIEW_PACKET_LEVELS.includes(value as WorksheetReviewLevel);
}

export async function verifyWorksheetReviewPacket(
  input: unknown,
  repositoryRoot: string,
): Promise<WorksheetReviewPacketReport> {
  const errors: string[] = approvalClaimPaths(input);
  const worksheetsPerLevel = emptyLevelCounts();
  const topicSets = emptyLevelTopicSets();
  let totalQuestions = 0;
  const manifest = record(input);

  if (!manifest) {
    errors.push("Worksheet review packet manifest must be an object.");
    return {
      ok: false,
      errors,
      totalWorksheets: 0,
      worksheetsPerLevel,
      topicsPerLevel: { A1: [], A2: [], B1: [], B2: [] },
      totalQuestions,
    };
  }
  if (!hasExactKeys(manifest, manifestKeys)) {
    errors.push(
      "Worksheet review packet manifest has missing or unexpected top-level keys.",
    );
  }
  if (manifest.schema_version !== 1)
    errors.push("Worksheet review packet schema_version must be 1.");
  if (
    manifest.packet_id !==
    "schreiben-v1-launch-worksheet-qualified-human-review-packet-1"
  ) {
    errors.push("Worksheet review packet has the wrong packet_id.");
  }
  if (manifest.artifact_kind !== "qualified_human_review_packet_manifest") {
    errors.push("Worksheet review packet has the wrong artifact_kind.");
  }
  if (manifest.status !== WORKSHEET_REVIEW_PACKET_STATUS) {
    errors.push(
      `Worksheet review packet status must be ${WORKSHEET_REVIEW_PACKET_STATUS}.`,
    );
  }
  if (manifest.launch_evidence_eligible !== false) {
    errors.push("Worksheet review packet must not count as launch evidence.");
  }
  if (manifest.deployment_eligible !== false) {
    errors.push("Worksheet review packet must not be deployment eligible.");
  }

  const distribution = record(manifest.required_distribution);
  const declaredLevelCounts = record(distribution?.worksheets_per_level);
  if (
    !distribution ||
    !hasExactKeys(distribution, distributionKeys) ||
    distribution.total_worksheets !== WORKSHEET_REVIEW_PACKET_TOTAL ||
    distribution.distinct_topics_per_level !==
      WORKSHEET_REVIEW_PACKET_PER_LEVEL ||
    !declaredLevelCounts ||
    !hasExactKeys(declaredLevelCounts, WORKSHEET_REVIEW_PACKET_LEVELS) ||
    WORKSHEET_REVIEW_PACKET_LEVELS.some(
      (level) =>
        declaredLevelCounts[level] !== WORKSHEET_REVIEW_PACKET_PER_LEVEL,
    )
  ) {
    errors.push(
      "Worksheet review packet must declare exactly 80 worksheets, 20 per level, and 20 distinct topics per level.",
    );
  }

  const worksheets = Array.isArray(manifest.worksheets)
    ? manifest.worksheets
    : [];
  if (!Array.isArray(manifest.worksheets)) {
    errors.push("Worksheet review packet worksheets must be an array.");
  }
  if (worksheets.length !== WORKSHEET_REVIEW_PACKET_TOTAL) {
    errors.push(
      `Worksheet review packet has ${worksheets.length}/80 worksheets.`,
    );
  }
  if (
    worksheetSnapshotRoot(worksheets) !==
    WORKSHEET_REVIEW_PACKET_SNAPSHOT_ROOT_SHA256
  ) {
    errors.push(
      "Worksheet review packet immutable snapshot root drifted; content/hash repinning requires an explicit verifier trust-root change.",
    );
  }

  const templateKeys = new Set<string>();
  const filePaths = new Set<string>();
  const contentHashes = new Set<string>();
  const manifestOrder: string[] = [];
  const normalizedRoot = resolve(repositoryRoot);
  const realRepositoryRoot = await realpath(normalizedRoot);

  for (const [index, rawEntry] of worksheets.entries()) {
    const label = `Worksheet review packet entry ${index + 1}`;
    const entry = record(rawEntry);
    if (!entry) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (!hasExactKeys(entry, worksheetKeys)) {
      errors.push(`${label} has missing or unexpected keys.`);
    }

    const templateKey =
      typeof entry.template_key === "string" ? entry.template_key : "";
    const filePath =
      typeof entry.current_file_path === "string"
        ? entry.current_file_path
        : "";
    const currentSha256 =
      typeof entry.current_sha256 === "string" ? entry.current_sha256 : "";
    const level = entry.level;
    const topicSlug =
      typeof entry.topic_slug === "string" ? entry.topic_slug : "";
    const counts = countRecord(entry.question_counts);
    manifestOrder.push(templateKey);

    if (!/^v1-(?:a1|a2|b1|b2)-[a-z0-9-]+-r[12]$/u.test(templateKey)) {
      errors.push(`${label} has an invalid template_key.`);
    } else if (templateKeys.has(templateKey)) {
      errors.push(`${label} duplicates template_key ${templateKey}.`);
    } else {
      templateKeys.add(templateKey);
    }
    if (!isWorksheetReviewLevel(level)) {
      errors.push(`${label} has an invalid level.`);
    } else {
      worksheetsPerLevel[level] += 1;
      topicSets[level].add(topicSlug);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(topicSlug)) {
      errors.push(`${label} has an invalid topic_slug.`);
    }
    if (!/^[a-f0-9]{64}$/u.test(currentSha256)) {
      errors.push(`${label} has an invalid current_sha256.`);
    } else if (contentHashes.has(currentSha256)) {
      errors.push(`${label} duplicates current_sha256 ${currentSha256}.`);
    } else {
      contentHashes.add(currentSha256);
    }
    if (entry.review_status !== WORKSHEET_REVIEW_PACKET_STATUS) {
      errors.push(
        `${label} review_status must be ${WORKSHEET_REVIEW_PACKET_STATUS}.`,
      );
    }
    if (
      !counts ||
      counts.total < 1 ||
      counts.local_exact < 0 ||
      counts.open_evaluation < 0
    ) {
      errors.push(`${label} has invalid question_counts.`);
    } else {
      totalQuestions += counts.total;
      if (counts.local_exact + counts.open_evaluation !== counts.total) {
        errors.push(`${label} question_counts do not add up.`);
      }
    }

    if (
      !filePath ||
      isAbsolute(filePath) ||
      filePath.includes("\\") ||
      filePath.split("/").includes("..")
    ) {
      errors.push(
        `${label} current_file_path must be a safe repository-relative POSIX path.`,
      );
      continue;
    }
    if (filePaths.has(filePath)) {
      errors.push(`${label} duplicates current_file_path ${filePath}.`);
      continue;
    }
    filePaths.add(filePath);

    const fullPath = resolve(normalizedRoot, filePath);
    const relativePath = relative(normalizedRoot, fullPath);
    if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
      errors.push(`${label} current_file_path escapes the repository root.`);
      continue;
    }
    if (isWorksheetReviewLevel(level) && templateKey) {
      const expectedPath = `quality/worksheet-bank/drafts/${level.toLowerCase()}/${templateKey}.json`;
      if (filePath !== expectedPath) {
        errors.push(
          `${label} current_file_path does not match its level and template_key.`,
        );
      }
    }

    let raw: Buffer;
    try {
      const fileStat = await lstat(fullPath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        errors.push(`${label} must reference a regular non-symlink file.`);
        continue;
      }
      const realFilePath = await realpath(fullPath);
      const realRelativePath = relative(realRepositoryRoot, realFilePath);
      if (
        realRelativePath === ".." ||
        realRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(realRelativePath)
      ) {
        errors.push(
          `${label} resolves outside the real repository root through a symlink.`,
        );
        continue;
      }
      raw = await readFile(realFilePath);
    } catch {
      errors.push(`${label} points to a missing file: ${filePath}.`);
      continue;
    }
    const actualHash = createHash("sha256").update(raw).digest("hex");
    if (actualHash !== currentSha256) {
      errors.push(
        `${label} hash drift: expected ${currentSha256}, got ${actualHash}.`,
      );
    }

    let worksheet: Record<string, unknown> | null = null;
    try {
      worksheet = record(JSON.parse(raw.toString("utf8")) as unknown);
    } catch {
      errors.push(`${label} file is not valid JSON.`);
    }
    if (!worksheet) continue;
    errors.push(...worksheetApprovalClaims(worksheet, label));
    if (!hasExactKeys(worksheet, worksheetTopLevelKeys)) {
      errors.push(
        `${label} worksheet has missing or unexpected top-level keys.`,
      );
    }
    const metadata = record(worksheet.draft_metadata);
    if (!metadata || !hasExactKeys(metadata, worksheetMetadataKeys)) {
      errors.push(`${label} has invalid draft_metadata keys.`);
    }
    if (
      metadata?.authoring_status !== "draft_unapproved" ||
      metadata.certification_status !== "not_certified" ||
      metadata.approval_status !== "unapproved"
    ) {
      errors.push(`${label} has invalid non-certifying draft status.`);
    }
    const grammarTopic = record(worksheet.grammar_topic);
    const questions = Array.isArray(worksheet.questions)
      ? worksheet.questions
      : null;
    if (metadata?.template_key !== templateKey) {
      errors.push(`${label} template_key does not match the worksheet file.`);
    }
    if (worksheet.level !== level) {
      errors.push(`${label} level does not match the worksheet file.`);
    }
    if (grammarTopic?.slug !== topicSlug) {
      errors.push(`${label} topic_slug does not match the worksheet file.`);
    }
    if (
      worksheet.visibility !== "private" ||
      worksheet.source !== "manual_import"
    ) {
      errors.push(`${label} must remain a private manual-import draft.`);
    }
    if (!questions) {
      errors.push(`${label} worksheet file has no questions array.`);
      continue;
    }
    const actualCounts = {
      total: questions.length,
      local_exact: questions.filter(
        (question) => record(question)?.evaluation_mode === "local_exact",
      ).length,
      open_evaluation: questions.filter(
        (question) => record(question)?.evaluation_mode === "open_evaluation",
      ).length,
    };
    if (
      !counts ||
      counts.total !== actualCounts.total ||
      counts.local_exact !== actualCounts.local_exact ||
      counts.open_evaluation !== actualCounts.open_evaluation
    ) {
      errors.push(`${label} question_counts do not match the worksheet file.`);
    }
  }

  for (const level of WORKSHEET_REVIEW_PACKET_LEVELS) {
    if (worksheetsPerLevel[level] !== WORKSHEET_REVIEW_PACKET_PER_LEVEL) {
      errors.push(
        `Worksheet review packet has ${worksheetsPerLevel[level]}/20 worksheets for ${level}.`,
      );
    }
    if (topicSets[level].size !== WORKSHEET_REVIEW_PACKET_PER_LEVEL) {
      errors.push(
        `Worksheet review packet has ${topicSets[level].size}/20 distinct topics for ${level}.`,
      );
    }
  }

  const expectedTemplateKeys = new Set(
    EXPECTED_WORKSHEET_REVIEW_PACKET_TEMPLATE_KEYS,
  );
  const missingTemplateKeys = [...expectedTemplateKeys].filter(
    (templateKey) => !templateKeys.has(templateKey),
  );
  const unexpectedTemplateKeys = [...templateKeys].filter(
    (templateKey) => !expectedTemplateKeys.has(templateKey),
  );
  if (missingTemplateKeys.length > 0 || unexpectedTemplateKeys.length > 0) {
    errors.push(
      `Worksheet review packet selection drift: missing [${missingTemplateKeys.join(
        ", ",
      )}], unexpected [${unexpectedTemplateKeys.join(", ")}].`,
    );
  }
  if (
    JSON.stringify(manifestOrder) !==
    JSON.stringify(EXPECTED_WORKSHEET_REVIEW_PACKET_TEMPLATE_KEYS)
  ) {
    errors.push(
      "Worksheet review packet canonical breadth-first order drifted.",
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    totalWorksheets: worksheets.length,
    worksheetsPerLevel,
    topicsPerLevel: {
      A1: [...topicSets.A1].sort(),
      A2: [...topicSets.A2].sort(),
      B1: [...topicSets.B1].sort(),
      B2: [...topicSets.B2].sort(),
    },
    totalQuestions,
  };
}

async function main() {
  const repositoryRoot = resolve(
    fileURLToPath(new URL("../..", import.meta.url)),
  );
  const manifestPath = resolve(
    repositoryRoot,
    "quality/worksheet-bank/qualified-human-review-packet.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const report = await verifyWorksheetReviewPacket(manifest, repositoryRoot);
  if (!report.ok) {
    console.error(report.errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Worksheet review packet verified: ${report.totalWorksheets} worksheets, ${report.totalQuestions} questions, 20 distinct topics per A1/A2/B1/B2; status ${WORKSHEET_REVIEW_PACKET_STATUS}.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
