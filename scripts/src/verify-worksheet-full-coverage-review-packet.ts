import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalWorksheetTemplateContexts,
  canonicalWorksheetTopics,
  secondRevisionTopicsByLevel,
  worksheetLevels,
  type WorksheetLevel,
} from "./verify-worksheet-authoring-matrix.js";

export const WORKSHEET_FULL_COVERAGE_REVIEW_STATUS =
  "awaiting_qualified_human_review" as const;
export const WORKSHEET_FULL_COVERAGE_TOTAL = 184;
export const WORKSHEET_FULL_COVERAGE_PER_LEVEL = 46;
export const WORKSHEET_FULL_COVERAGE_TOPICS_PER_LEVEL = 36;
export const WORKSHEET_FULL_COVERAGE_SECOND_REVISIONS_PER_LEVEL = 10;
export const WORKSHEET_FULL_COVERAGE_SNAPSHOT_ROOT_SHA256 =
  "0395193e4e4ceb428a8f3994a9f57bdbaa05bad000bb71acc6b1d192213f2955";

export type WorksheetFullCoverageReviewReport = {
  ok: boolean;
  errors: string[];
  totalWorksheets: number;
  totalQuestions: number;
  worksheetsPerLevel: Record<WorksheetLevel, number>;
  topicsPerLevel: Record<WorksheetLevel, string[]>;
  secondRevisionTopicsPerLevel: Record<WorksheetLevel, string[]>;
};

const manifestKeys = [
  "schema_version",
  "packet_id",
  "artifact_kind",
  "coverage_kind",
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
  "foundation_revisions_per_level",
  "priority_second_revisions_per_level",
] as const;
const worksheetEntryKeys = [
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

function manifestApprovalClaims(
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
      manifestApprovalClaims(item, `${path}[${index}]`, claims),
    );
    return claims;
  }
  const object = record(value);
  if (!object) return claims;
  for (const [key, child] of Object.entries(object)) {
    if (approvalKeyPattern.test(key)) {
      claims.push(
        `${path}.${key} is forbidden approval or certification evidence`,
      );
    }
    manifestApprovalClaims(child, `${path}.${key}`, claims);
  }
  return claims;
}

function worksheetApprovalClaimKeys(
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
      worksheetApprovalClaimKeys(item, `${path}[${index}]`, claims),
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
    worksheetApprovalClaimKeys(child, `${path}.${key}`, claims);
  }
  return claims;
}

function validQuestionCounts(value: unknown) {
  const counts = record(value);
  if (
    !counts ||
    !hasExactKeys(counts, questionCountKeys) ||
    !Number.isInteger(counts.total) ||
    !Number.isInteger(counts.local_exact) ||
    !Number.isInteger(counts.open_evaluation)
  ) {
    return null;
  }
  return counts as {
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

function emptyLevelCounts(): Record<WorksheetLevel, number> {
  return { A1: 0, A2: 0, B1: 0, B2: 0 };
}

function emptyLevelSets(): Record<WorksheetLevel, Set<string>> {
  return { A1: new Set(), A2: new Set(), B1: new Set(), B2: new Set() };
}

function isLevel(value: unknown): value is WorksheetLevel {
  return worksheetLevels.includes(value as WorksheetLevel);
}

function safeRepositoryPath(filePath: string) {
  return (
    filePath.length > 0 &&
    !isAbsolute(filePath) &&
    !filePath.includes("\\") &&
    !filePath.split("/").includes("..")
  );
}

export async function verifyWorksheetFullCoverageReviewPacket(
  input: unknown,
  repositoryRoot: string,
): Promise<WorksheetFullCoverageReviewReport> {
  const errors = manifestApprovalClaims(input);
  const worksheetsPerLevel = emptyLevelCounts();
  const topicSets = emptyLevelSets();
  const secondRevisionTopicSets = emptyLevelSets();
  let totalQuestions = 0;
  const manifest = record(input);
  if (!manifest) {
    errors.push("Full-coverage worksheet review packet must be an object.");
    return {
      ok: false,
      errors,
      totalWorksheets: 0,
      totalQuestions,
      worksheetsPerLevel,
      topicsPerLevel: { A1: [], A2: [], B1: [], B2: [] },
      secondRevisionTopicsPerLevel: { A1: [], A2: [], B1: [], B2: [] },
    };
  }

  if (!hasExactKeys(manifest, manifestKeys)) {
    errors.push(
      "Full-coverage worksheet review packet has missing or unexpected top-level keys.",
    );
  }
  if (manifest.schema_version !== 1) {
    errors.push(
      "Full-coverage worksheet review packet schema_version must be 1.",
    );
  }
  if (
    manifest.packet_id !==
    "schreiben-v1-worksheet-qualified-human-review-full-coverage-1"
  ) {
    errors.push(
      "Full-coverage worksheet review packet has the wrong packet_id.",
    );
  }
  if (manifest.artifact_kind !== "qualified_human_review_packet_manifest") {
    errors.push(
      "Full-coverage worksheet review packet has the wrong artifact_kind.",
    );
  }
  if (manifest.coverage_kind !== "all_current_draft_worksheets") {
    errors.push(
      "Full-coverage worksheet review packet must cover all current draft worksheets.",
    );
  }
  if (manifest.status !== WORKSHEET_FULL_COVERAGE_REVIEW_STATUS) {
    errors.push(
      `Full-coverage worksheet review packet status must be ${WORKSHEET_FULL_COVERAGE_REVIEW_STATUS}.`,
    );
  }
  if (manifest.launch_evidence_eligible !== false) {
    errors.push(
      "Full-coverage worksheet review packet must not count as launch evidence.",
    );
  }
  if (manifest.deployment_eligible !== false) {
    errors.push(
      "Full-coverage worksheet review packet must not be deployment eligible.",
    );
  }

  const distribution = record(manifest.required_distribution);
  const declaredPerLevel = record(distribution?.worksheets_per_level);
  if (
    !distribution ||
    !hasExactKeys(distribution, distributionKeys) ||
    distribution.total_worksheets !== WORKSHEET_FULL_COVERAGE_TOTAL ||
    distribution.distinct_topics_per_level !==
      WORKSHEET_FULL_COVERAGE_TOPICS_PER_LEVEL ||
    distribution.foundation_revisions_per_level !==
      WORKSHEET_FULL_COVERAGE_TOPICS_PER_LEVEL ||
    distribution.priority_second_revisions_per_level !==
      WORKSHEET_FULL_COVERAGE_SECOND_REVISIONS_PER_LEVEL ||
    !declaredPerLevel ||
    !hasExactKeys(declaredPerLevel, worksheetLevels) ||
    worksheetLevels.some(
      (level) => declaredPerLevel[level] !== WORKSHEET_FULL_COVERAGE_PER_LEVEL,
    )
  ) {
    errors.push(
      "Full-coverage worksheet review packet must declare 184 worksheets, 46 per level, 36 foundation topics, and 10 priority second revisions per level.",
    );
  }

  const worksheets = Array.isArray(manifest.worksheets)
    ? manifest.worksheets
    : [];
  if (!Array.isArray(manifest.worksheets)) {
    errors.push(
      "Full-coverage worksheet review packet worksheets must be an array.",
    );
  }
  if (worksheets.length !== WORKSHEET_FULL_COVERAGE_TOTAL) {
    errors.push(
      `Full-coverage worksheet review packet has ${worksheets.length}/184 worksheets.`,
    );
  }
  if (
    worksheetSnapshotRoot(worksheets) !==
    WORKSHEET_FULL_COVERAGE_SNAPSHOT_ROOT_SHA256
  ) {
    errors.push(
      "Full-coverage worksheet review packet immutable snapshot root drifted; content/hash repinning requires an explicit verifier trust-root change.",
    );
  }

  const normalizedRoot = resolve(repositoryRoot);
  let realRepositoryRoot: string;
  try {
    realRepositoryRoot = await realpath(normalizedRoot);
  } catch {
    errors.push("Full-coverage worksheet review repository root is missing.");
    return {
      ok: false,
      errors,
      totalWorksheets: worksheets.length,
      totalQuestions,
      worksheetsPerLevel,
      topicsPerLevel: { A1: [], A2: [], B1: [], B2: [] },
      secondRevisionTopicsPerLevel: { A1: [], A2: [], B1: [], B2: [] },
    };
  }

  const expectedContexts = canonicalWorksheetTemplateContexts;
  const expectedContextByKey = new Map(
    expectedContexts.map((context) => [context.templateKey, context]),
  );
  const templateKeys = new Set<string>();
  const filePaths = new Set<string>();
  const contentHashes = new Set<string>();
  const manifestOrder: string[] = [];

  for (const [index, rawEntry] of worksheets.entries()) {
    const label = `Full-coverage worksheet entry ${index + 1}`;
    const entry = record(rawEntry);
    if (!entry) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (!hasExactKeys(entry, worksheetEntryKeys)) {
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
    const counts = validQuestionCounts(entry.question_counts);
    manifestOrder.push(templateKey);

    const expectedContext = expectedContextByKey.get(templateKey);
    if (!expectedContext) {
      errors.push(`${label} has an unexpected template_key.`);
    }
    if (templateKeys.has(templateKey)) {
      errors.push(`${label} duplicates template_key ${templateKey}.`);
    } else {
      templateKeys.add(templateKey);
    }
    if (!isLevel(level)) {
      errors.push(`${label} has an invalid level.`);
    } else {
      worksheetsPerLevel[level] += 1;
      topicSets[level].add(topicSlug);
      if (expectedContext?.revisionNumber === 2) {
        secondRevisionTopicSets[level].add(topicSlug);
      }
    }
    if (
      expectedContext &&
      (expectedContext.level !== level ||
        expectedContext.topicSlug !== topicSlug)
    ) {
      errors.push(
        `${label} level or topic_slug does not match its template_key.`,
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(currentSha256)) {
      errors.push(`${label} has an invalid current_sha256.`);
    } else if (contentHashes.has(currentSha256)) {
      errors.push(`${label} duplicates current_sha256 ${currentSha256}.`);
    } else {
      contentHashes.add(currentSha256);
    }
    if (entry.review_status !== WORKSHEET_FULL_COVERAGE_REVIEW_STATUS) {
      errors.push(
        `${label} review_status must be ${WORKSHEET_FULL_COVERAGE_REVIEW_STATUS}.`,
      );
    }
    if (
      !counts ||
      counts.total < 1 ||
      counts.local_exact < 0 ||
      counts.open_evaluation < 0 ||
      counts.local_exact + counts.open_evaluation !== counts.total
    ) {
      errors.push(`${label} has invalid question_counts.`);
    } else {
      totalQuestions += counts.total;
    }

    if (!safeRepositoryPath(filePath)) {
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
    if (isLevel(level) && templateKey) {
      const expectedPath = `quality/worksheet-bank/drafts/${level.toLowerCase()}/${templateKey}.json`;
      if (filePath !== expectedPath) {
        errors.push(
          `${label} current_file_path does not match its level and template_key.`,
        );
      }
    }

    const fullPath = resolve(normalizedRoot, filePath);
    const lexicalRelative = relative(normalizedRoot, fullPath);
    if (
      lexicalRelative === ".." ||
      lexicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(lexicalRelative)
    ) {
      errors.push(`${label} current_file_path escapes the repository root.`);
      continue;
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
    errors.push(...worksheetApprovalClaimKeys(worksheet, label));
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
    if (metadata?.template_key !== templateKey) {
      errors.push(`${label} template_key does not match worksheet content.`);
    }
    if (worksheet.level !== level) {
      errors.push(`${label} level does not match worksheet content.`);
    }
    const grammarTopic = record(worksheet.grammar_topic);
    if (grammarTopic?.slug !== topicSlug) {
      errors.push(`${label} topic_slug does not match worksheet content.`);
    }
    if (
      worksheet.visibility !== "private" ||
      worksheet.source !== "manual_import"
    ) {
      errors.push(`${label} must remain a private manual-import draft.`);
    }
    const questions = Array.isArray(worksheet.questions)
      ? worksheet.questions
      : null;
    if (!questions) {
      errors.push(`${label} worksheet has no questions array.`);
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
      errors.push(`${label} question_counts do not match worksheet content.`);
    }
  }

  const expectedOrder = expectedContexts.map((context) => context.templateKey);
  if (JSON.stringify(manifestOrder) !== JSON.stringify(expectedOrder)) {
    errors.push(
      "Full-coverage worksheet review packet selection or canonical order drifted.",
    );
  }
  for (const level of worksheetLevels) {
    if (worksheetsPerLevel[level] !== WORKSHEET_FULL_COVERAGE_PER_LEVEL) {
      errors.push(
        `Full-coverage worksheet review packet has ${worksheetsPerLevel[level]}/46 worksheets for ${level}.`,
      );
    }
    const topics = [...topicSets[level]].sort();
    if (
      topics.length !== WORKSHEET_FULL_COVERAGE_TOPICS_PER_LEVEL ||
      JSON.stringify(topics) !==
        JSON.stringify([...canonicalWorksheetTopics].sort())
    ) {
      errors.push(
        `Full-coverage worksheet review packet does not contain all 36 closed topics for ${level}.`,
      );
    }
    const secondRevisionTopics = [...secondRevisionTopicSets[level]].sort();
    if (
      secondRevisionTopics.length !==
        WORKSHEET_FULL_COVERAGE_SECOND_REVISIONS_PER_LEVEL ||
      JSON.stringify(secondRevisionTopics) !==
        JSON.stringify([...secondRevisionTopicsByLevel[level]].sort())
    ) {
      errors.push(
        `Full-coverage worksheet review packet has the wrong priority r2 topics for ${level}.`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    totalWorksheets: worksheets.length,
    totalQuestions,
    worksheetsPerLevel,
    topicsPerLevel: {
      A1: [...topicSets.A1].sort(),
      A2: [...topicSets.A2].sort(),
      B1: [...topicSets.B1].sort(),
      B2: [...topicSets.B2].sort(),
    },
    secondRevisionTopicsPerLevel: {
      A1: [...secondRevisionTopicSets.A1].sort(),
      A2: [...secondRevisionTopicSets.A2].sort(),
      B1: [...secondRevisionTopicSets.B1].sort(),
      B2: [...secondRevisionTopicSets.B2].sort(),
    },
  };
}

async function main() {
  const repositoryRoot = resolve(
    fileURLToPath(new URL("../..", import.meta.url)),
  );
  const manifest = JSON.parse(
    await readFile(
      resolve(
        repositoryRoot,
        "quality/worksheet-bank/qualified-human-review-packet-full-coverage.json",
      ),
      "utf8",
    ),
  ) as unknown;
  const report = await verifyWorksheetFullCoverageReviewPacket(
    manifest,
    repositoryRoot,
  );
  if (!report.ok) {
    console.error(report.errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Full-coverage worksheet review packet verified: ${report.totalWorksheets} worksheets, ${report.totalQuestions} questions, 46 per A1/A2/B1/B2 with all 36 topics plus 10 priority r2s; status ${WORKSHEET_FULL_COVERAGE_REVIEW_STATUS}.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
