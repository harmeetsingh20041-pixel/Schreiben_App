import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EVALUATOR_REVIEW_PACKET_STATUS =
  "awaiting_qualified_human_review" as const;
export const EVALUATOR_REVIEW_PACKET_TOTAL = 600;
export const EVALUATOR_REVIEW_PACKET_PER_LEVEL = 150;
export const EVALUATOR_REVIEW_PACKET_PER_CATEGORY_PER_LEVEL = 10;
export const EVALUATOR_REVIEW_PACKET_LEVELS = ["A1", "A2", "B1", "B2"] as const;
export const EVALUATOR_REVIEW_PACKET_CATEGORIES = [
  "do_not_overcorrect",
  "correction_accuracy",
  "explanation_accuracy",
  "decimal",
  "time",
  "abbreviation",
  "paragraph_boundary",
  "offset",
  "repeated_word",
  "missing_space",
  "long_sentence",
  "topic_mapping",
  "level_fit",
  "prompt_injection",
  "expected_hold",
] as const;

type EvaluatorReviewLevel = (typeof EVALUATOR_REVIEW_PACKET_LEVELS)[number];
type EvaluatorReviewCategory =
  (typeof EVALUATOR_REVIEW_PACKET_CATEGORIES)[number];

export const EXPECTED_EVALUATOR_REVIEW_SOURCE_PATHS = [
  "quality/evaluator-corpus/drafts/a1/candidates.jsonl",
  "quality/evaluator-corpus/drafts/a2/001-080-candidates.jsonl",
  "quality/evaluator-corpus/drafts/a2/081-150-candidates.jsonl",
  "quality/evaluator-corpus/drafts/b1/001-080-candidates.jsonl",
  "quality/evaluator-corpus/drafts/b1/081-150-candidates.jsonl",
  "quality/evaluator-corpus/drafts/b2/001-080-candidates.jsonl",
  "quality/evaluator-corpus/drafts/b2/081-150-candidates.jsonl",
] as const;

export type EvaluatorReviewPacketReport = {
  ok: boolean;
  errors: string[];
  totalSourceFiles: number;
  totalCases: number;
  casesPerLevel: Record<EvaluatorReviewLevel, number>;
  categoriesPerLevel: Record<
    EvaluatorReviewLevel,
    Record<EvaluatorReviewCategory, number>
  >;
};

const manifestKeys = [
  "schema_version",
  "packet_id",
  "artifact_kind",
  "status",
  "launch_evidence_eligible",
  "deployment_eligible",
  "required_distribution",
  "source_files",
  "cases",
] as const;
const distributionKeys = [
  "total_cases",
  "cases_per_level",
  "primary_categories",
  "cases_per_category_per_level",
] as const;
const sourceFileKeys = [
  "current_file_path",
  "current_sha256",
  "level",
  "case_count",
  "first_case_id",
  "last_case_id",
  "category_counts",
  "review_status",
] as const;
const caseKeys = [
  "id",
  "level",
  "primary_category",
  "source_file_path",
  "source_line",
  "current_sha256",
  "review_status",
] as const;
const a1CandidateKeys = [
  "schema_version",
  "id",
  "level",
  "primary_category",
  "case_tags",
  "authoring_status",
  "release_evidence_eligible",
  "input_text",
  "expected_disposition",
  "expected_adversarial_instruction_resisted",
  "must_remain_private_until_review",
  "expected_feedback",
  "expected_topic_slugs",
  "preservation_requirements",
  "hold_variant",
  "hold_fixture",
] as const;
const laterLevelCandidateKeys = [
  "candidate_schema_version",
  "id",
  "level",
  "primary_category",
  "case_tags",
  "draft_status",
  "counts_as_launch_evidence",
  "input_text",
  "expected_disposition",
  "expected_level",
  "expected_topic_slug",
  "expected_feedback",
  "expected_hold",
  "adversarial_instruction_must_be_ignored",
] as const;

const approvalKeyPattern =
  /(?:^|_)(?:approval|approved|certification|certified|reviewed|reviewer|signed_off|signoff)(?:_|$)/iu;
const approvalValuePattern =
  /(?:^|[_\s-])(?:approved|certified|review_complete|human_reviewed|qualified_reviewed|signed_off)(?:$|[_\s-])/iu;
const forbiddenCandidateEvidenceKeys = new Set([
  "reviewer",
  "reviewer_id",
  "qualification",
  "reviewed_at",
  "approved",
  "approval",
  "certified",
  "certification",
  "release_id",
  "decision_sha256",
  "actual_disposition",
  "student_visible_before_release",
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
  for (const [key, child] of Object.entries(object)) {
    if (approvalKeyPattern.test(key)) {
      claims.push(
        `${path}.${key} is forbidden approval or certification evidence`,
      );
    }
    approvalClaimPaths(child, `${path}.${key}`, claims);
  }
  return claims;
}

function candidateEvidenceKeys(
  value: unknown,
  path: string,
  findings: string[] = [],
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      candidateEvidenceKeys(item, `${path}[${index}]`, findings),
    );
    return findings;
  }
  const object = record(value);
  if (!object) return findings;
  for (const [key, child] of Object.entries(object)) {
    if (forbiddenCandidateEvidenceKeys.has(key)) {
      findings.push(
        `${path}.${key} contains forbidden review or release evidence`,
      );
    }
    candidateEvidenceKeys(child, `${path}.${key}`, findings);
  }
  return findings;
}

function isLevel(value: unknown): value is EvaluatorReviewLevel {
  return EVALUATOR_REVIEW_PACKET_LEVELS.includes(value as EvaluatorReviewLevel);
}

function isCategory(value: unknown): value is EvaluatorReviewCategory {
  return EVALUATOR_REVIEW_PACKET_CATEGORIES.includes(
    value as EvaluatorReviewCategory,
  );
}

function emptyLevelCounts(): Record<EvaluatorReviewLevel, number> {
  return { A1: 0, A2: 0, B1: 0, B2: 0 };
}

function emptyCategoryCounts(): Record<EvaluatorReviewCategory, number> {
  return Object.fromEntries(
    EVALUATOR_REVIEW_PACKET_CATEGORIES.map((category) => [category, 0]),
  ) as Record<EvaluatorReviewCategory, number>;
}

function emptyCategoriesPerLevel(): Record<
  EvaluatorReviewLevel,
  Record<EvaluatorReviewCategory, number>
> {
  return {
    A1: emptyCategoryCounts(),
    A2: emptyCategoryCounts(),
    B1: emptyCategoryCounts(),
    B2: emptyCategoryCounts(),
  };
}

function validCategoryCounts(value: unknown) {
  const counts = record(value);
  if (
    !counts ||
    !hasExactKeys(counts, EVALUATOR_REVIEW_PACKET_CATEGORIES) ||
    EVALUATOR_REVIEW_PACKET_CATEGORIES.some(
      (category) =>
        !Number.isInteger(counts[category]) || Number(counts[category]) < 0,
    )
  ) {
    return null;
  }
  return counts as Record<EvaluatorReviewCategory, number>;
}

function safeRepositoryPath(filePath: string) {
  return (
    filePath.length > 0 &&
    !isAbsolute(filePath) &&
    !filePath.includes("\\") &&
    !filePath.split("/").includes("..")
  );
}

function expectedCaseIds() {
  return EVALUATOR_REVIEW_PACKET_LEVELS.flatMap((level) =>
    Array.from(
      { length: EVALUATOR_REVIEW_PACKET_PER_LEVEL },
      (_, index) => `${level}-EVAL-${String(index + 1).padStart(3, "0")}`,
    ),
  );
}

type ActualCandidate = {
  id: string;
  level: EvaluatorReviewLevel;
  primaryCategory: EvaluatorReviewCategory;
  sourceFilePath: string;
  sourceLine: number;
  currentSha256: string;
};

export async function verifyEvaluatorReviewPacket(
  input: unknown,
  repositoryRoot: string,
): Promise<EvaluatorReviewPacketReport> {
  const errors = approvalClaimPaths(input);
  const casesPerLevel = emptyLevelCounts();
  const categoriesPerLevel = emptyCategoriesPerLevel();
  const manifest = record(input);
  if (!manifest) {
    errors.push("Evaluator review packet manifest must be an object.");
    return {
      ok: false,
      errors,
      totalSourceFiles: 0,
      totalCases: 0,
      casesPerLevel,
      categoriesPerLevel,
    };
  }

  if (!hasExactKeys(manifest, manifestKeys)) {
    errors.push(
      "Evaluator review packet manifest has missing or unexpected top-level keys.",
    );
  }
  if (manifest.schema_version !== 1) {
    errors.push("Evaluator review packet schema_version must be 1.");
  }
  if (
    manifest.packet_id !==
    "schreiben-v1-launch-evaluator-qualified-human-review-packet-1"
  ) {
    errors.push("Evaluator review packet has the wrong packet_id.");
  }
  if (manifest.artifact_kind !== "qualified_human_review_packet_manifest") {
    errors.push("Evaluator review packet has the wrong artifact_kind.");
  }
  if (manifest.status !== EVALUATOR_REVIEW_PACKET_STATUS) {
    errors.push(
      `Evaluator review packet status must be ${EVALUATOR_REVIEW_PACKET_STATUS}.`,
    );
  }
  if (manifest.launch_evidence_eligible !== false) {
    errors.push("Evaluator review packet must not count as launch evidence.");
  }
  if (manifest.deployment_eligible !== false) {
    errors.push("Evaluator review packet must not be deployment eligible.");
  }

  const distribution = record(manifest.required_distribution);
  const declaredCasesPerLevel = record(distribution?.cases_per_level);
  if (
    !distribution ||
    !hasExactKeys(distribution, distributionKeys) ||
    distribution.total_cases !== EVALUATOR_REVIEW_PACKET_TOTAL ||
    distribution.cases_per_category_per_level !==
      EVALUATOR_REVIEW_PACKET_PER_CATEGORY_PER_LEVEL ||
    !Array.isArray(distribution.primary_categories) ||
    JSON.stringify(distribution.primary_categories) !==
      JSON.stringify(EVALUATOR_REVIEW_PACKET_CATEGORIES) ||
    !declaredCasesPerLevel ||
    !hasExactKeys(declaredCasesPerLevel, EVALUATOR_REVIEW_PACKET_LEVELS) ||
    EVALUATOR_REVIEW_PACKET_LEVELS.some(
      (level) =>
        declaredCasesPerLevel[level] !== EVALUATOR_REVIEW_PACKET_PER_LEVEL,
    )
  ) {
    errors.push(
      "Evaluator review packet must declare exactly 600 cases, 150 per level, and 10 per category per level.",
    );
  }

  const sourceFiles = Array.isArray(manifest.source_files)
    ? manifest.source_files
    : [];
  if (!Array.isArray(manifest.source_files)) {
    errors.push("Evaluator review packet source_files must be an array.");
  }
  if (sourceFiles.length !== EXPECTED_EVALUATOR_REVIEW_SOURCE_PATHS.length) {
    errors.push(
      `Evaluator review packet has ${sourceFiles.length}/7 source files.`,
    );
  }
  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  if (!Array.isArray(manifest.cases)) {
    errors.push("Evaluator review packet cases must be an array.");
  }
  if (cases.length !== EVALUATOR_REVIEW_PACKET_TOTAL) {
    errors.push(`Evaluator review packet has ${cases.length}/600 cases.`);
  }

  const normalizedRoot = resolve(repositoryRoot);
  let realRepositoryRoot: string;
  try {
    realRepositoryRoot = await realpath(normalizedRoot);
  } catch {
    errors.push("Evaluator review packet repository root is missing.");
    return {
      ok: false,
      errors,
      totalSourceFiles: sourceFiles.length,
      totalCases: cases.length,
      casesPerLevel,
      categoriesPerLevel,
    };
  }

  const actualByCoordinate = new Map<string, ActualCandidate>();
  const actualById = new Map<string, ActualCandidate>();
  const actualOrder: ActualCandidate[] = [];
  const declaredSourcePaths: string[] = [];
  const sourceHashes = new Set<string>();

  for (const [fileIndex, rawSource] of sourceFiles.entries()) {
    const label = `Evaluator review source file ${fileIndex + 1}`;
    const source = record(rawSource);
    if (!source) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (!hasExactKeys(source, sourceFileKeys)) {
      errors.push(`${label} has missing or unexpected keys.`);
    }
    const filePath =
      typeof source.current_file_path === "string"
        ? source.current_file_path
        : "";
    const expectedPath = EXPECTED_EVALUATOR_REVIEW_SOURCE_PATHS[fileIndex];
    declaredSourcePaths.push(filePath);
    if (filePath !== expectedPath) {
      errors.push(`${label} does not match the exact candidate source path.`);
    }
    if (!safeRepositoryPath(filePath)) {
      errors.push(
        `${label} current_file_path must be a safe repository-relative POSIX path.`,
      );
      continue;
    }
    const level = source.level;
    if (!isLevel(level)) errors.push(`${label} has an invalid level.`);
    const currentSha256 =
      typeof source.current_sha256 === "string" ? source.current_sha256 : "";
    if (!/^[a-f0-9]{64}$/u.test(currentSha256)) {
      errors.push(`${label} has an invalid current_sha256.`);
    } else if (sourceHashes.has(currentSha256)) {
      errors.push(`${label} duplicates a source-file hash.`);
    } else {
      sourceHashes.add(currentSha256);
    }
    if (source.review_status !== EVALUATOR_REVIEW_PACKET_STATUS) {
      errors.push(
        `${label} review_status must be ${EVALUATOR_REVIEW_PACKET_STATUS}.`,
      );
    }
    const declaredCategoryCounts = validCategoryCounts(source.category_counts);
    if (!declaredCategoryCounts) {
      errors.push(`${label} has invalid category_counts.`);
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
    const actualFileHash = createHash("sha256").update(raw).digest("hex");
    if (actualFileHash !== currentSha256) {
      errors.push(
        `${label} hash drift: expected ${currentSha256}, got ${actualFileHash}.`,
      );
    }
    const text = raw.toString("utf8");
    const allLines = text.split(/\r?\n/u);
    if (allLines.at(-1) === "") allLines.pop();
    if (allLines.some((line) => line.length === 0)) {
      errors.push(`${label} contains a blank JSONL line.`);
    }
    const fileCategoryCounts = emptyCategoryCounts();
    const fileCases: ActualCandidate[] = [];
    for (const [lineIndex, line] of allLines.entries()) {
      const lineLabel = `${label} line ${lineIndex + 1}`;
      let candidate: Record<string, unknown> | null = null;
      try {
        candidate = record(JSON.parse(line) as unknown);
      } catch {
        errors.push(`${lineLabel} is not valid JSON.`);
      }
      if (!candidate) continue;
      errors.push(...approvalClaimPaths(candidate, lineLabel));
      errors.push(...candidateEvidenceKeys(candidate, lineLabel));
      const expectedCandidateKeys = filePath.includes("/drafts/a1/")
        ? a1CandidateKeys
        : laterLevelCandidateKeys;
      if (!hasExactKeys(candidate, expectedCandidateKeys)) {
        errors.push(`${lineLabel} has missing or unexpected candidate keys.`);
      }
      const id = typeof candidate.id === "string" ? candidate.id : "";
      const candidateLevel = candidate.level;
      const primaryCategory = candidate.primary_category;
      if (!/^(?:A1|A2|B1|B2)-EVAL-[0-9]{3}$/u.test(id)) {
        errors.push(`${lineLabel} has an invalid case id.`);
      }
      if (!isLevel(candidateLevel)) {
        errors.push(`${lineLabel} has an invalid level.`);
        continue;
      }
      if (candidateLevel !== level) {
        errors.push(`${lineLabel} level does not match its source-file level.`);
      }
      if (!isCategory(primaryCategory)) {
        errors.push(`${lineLabel} has an invalid primary_category.`);
        continue;
      }
      if (
        candidateLevel === "A1" &&
        (candidate.authoring_status !== "candidate_unreviewed" ||
          candidate.release_evidence_eligible !== false ||
          candidate.must_remain_private_until_review !== true)
      ) {
        errors.push(`${lineLabel} has invalid private candidate status.`);
      }
      if (
        candidateLevel !== "A1" &&
        (candidate.draft_status !== "candidate_unreviewed" ||
          candidate.counts_as_launch_evidence !== false)
      ) {
        errors.push(`${lineLabel} has invalid private candidate status.`);
      }
      const actual: ActualCandidate = {
        id,
        level: candidateLevel,
        primaryCategory,
        sourceFilePath: filePath,
        sourceLine: lineIndex + 1,
        currentSha256: createHash("sha256").update(line).digest("hex"),
      };
      const coordinate = `${filePath}:${lineIndex + 1}`;
      if (actualByCoordinate.has(coordinate)) {
        errors.push(`${lineLabel} duplicates a source coordinate.`);
      }
      if (actualById.has(id)) {
        errors.push(`${lineLabel} duplicates case id ${id}.`);
      }
      actualByCoordinate.set(coordinate, actual);
      actualById.set(id, actual);
      actualOrder.push(actual);
      fileCases.push(actual);
      fileCategoryCounts[primaryCategory] += 1;
    }
    if (source.case_count !== fileCases.length) {
      errors.push(`${label} case_count does not match its JSONL content.`);
    }
    if (source.first_case_id !== fileCases[0]?.id) {
      errors.push(`${label} first_case_id does not match its JSONL content.`);
    }
    if (source.last_case_id !== fileCases.at(-1)?.id) {
      errors.push(`${label} last_case_id does not match its JSONL content.`);
    }
    if (
      !declaredCategoryCounts ||
      EVALUATOR_REVIEW_PACKET_CATEGORIES.some(
        (category) =>
          declaredCategoryCounts[category] !== fileCategoryCounts[category],
      )
    ) {
      errors.push(`${label} category_counts do not match its JSONL content.`);
    }
  }

  if (
    JSON.stringify(declaredSourcePaths) !==
    JSON.stringify(EXPECTED_EVALUATOR_REVIEW_SOURCE_PATHS)
  ) {
    errors.push(
      "Evaluator review packet source-file selection or order drifted.",
    );
  }

  const manifestIds = new Set<string>();
  const manifestCoordinates = new Set<string>();
  const manifestHashes = new Set<string>();
  const manifestOrder: string[] = [];
  for (const [index, rawCase] of cases.entries()) {
    const label = `Evaluator review case ${index + 1}`;
    const reviewCase = record(rawCase);
    if (!reviewCase) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (!hasExactKeys(reviewCase, caseKeys)) {
      errors.push(`${label} has missing or unexpected keys.`);
    }
    const id = typeof reviewCase.id === "string" ? reviewCase.id : "";
    const level = reviewCase.level;
    const primaryCategory = reviewCase.primary_category;
    const sourceFilePath =
      typeof reviewCase.source_file_path === "string"
        ? reviewCase.source_file_path
        : "";
    const sourceLine = reviewCase.source_line;
    const currentSha256 =
      typeof reviewCase.current_sha256 === "string"
        ? reviewCase.current_sha256
        : "";
    manifestOrder.push(id);
    if (!/^(?:A1|A2|B1|B2)-EVAL-[0-9]{3}$/u.test(id)) {
      errors.push(`${label} has an invalid id.`);
    } else if (manifestIds.has(id)) {
      errors.push(`${label} duplicates id ${id}.`);
    } else {
      manifestIds.add(id);
    }
    if (!isLevel(level)) {
      errors.push(`${label} has an invalid level.`);
    } else {
      casesPerLevel[level] += 1;
    }
    if (!isCategory(primaryCategory)) {
      errors.push(`${label} has an invalid primary_category.`);
    } else if (isLevel(level)) {
      categoriesPerLevel[level][primaryCategory] += 1;
    }
    if (
      !EXPECTED_EVALUATOR_REVIEW_SOURCE_PATHS.includes(sourceFilePath as never)
    ) {
      errors.push(`${label} has an unexpected source_file_path.`);
    }
    if (!Number.isInteger(sourceLine) || Number(sourceLine) < 1) {
      errors.push(`${label} has an invalid source_line.`);
    }
    const coordinate = `${sourceFilePath}:${sourceLine}`;
    if (manifestCoordinates.has(coordinate)) {
      errors.push(`${label} duplicates source coordinate ${coordinate}.`);
    } else {
      manifestCoordinates.add(coordinate);
    }
    if (!/^[a-f0-9]{64}$/u.test(currentSha256)) {
      errors.push(`${label} has an invalid current_sha256.`);
    } else if (manifestHashes.has(currentSha256)) {
      errors.push(`${label} duplicates a case hash.`);
    } else {
      manifestHashes.add(currentSha256);
    }
    if (reviewCase.review_status !== EVALUATOR_REVIEW_PACKET_STATUS) {
      errors.push(
        `${label} review_status must be ${EVALUATOR_REVIEW_PACKET_STATUS}.`,
      );
    }
    const actual = actualByCoordinate.get(coordinate);
    if (!actual) {
      errors.push(`${label} does not map to a candidate source line.`);
      continue;
    }
    if (actual.id !== id)
      errors.push(`${label} id does not match source content.`);
    if (actual.level !== level) {
      errors.push(`${label} level does not match source content.`);
    }
    if (actual.primaryCategory !== primaryCategory) {
      errors.push(`${label} primary_category does not match source content.`);
    }
    if (actual.currentSha256 !== currentSha256) {
      errors.push(`${label} content hash drifted from its source line.`);
    }
  }

  const expectedIds = expectedCaseIds();
  if (
    JSON.stringify(actualOrder.map((candidate) => candidate.id)) !==
    JSON.stringify(expectedIds)
  ) {
    errors.push(
      "Evaluator candidate source id order drifted from A1-EVAL-001 through B2-EVAL-150.",
    );
  }
  const missingIds = expectedIds.filter((id) => !manifestIds.has(id));
  const unexpectedIds = [...manifestIds].filter(
    (id) => !expectedIds.includes(id),
  );
  if (missingIds.length > 0 || unexpectedIds.length > 0) {
    errors.push(
      `Evaluator review packet id selection drift: missing [${missingIds.join(
        ", ",
      )}], unexpected [${unexpectedIds.join(", ")}].`,
    );
  }
  if (
    JSON.stringify(manifestOrder) !==
    JSON.stringify(actualOrder.map((candidate) => candidate.id))
  ) {
    errors.push(
      "Evaluator review packet case order drifted from source order.",
    );
  }
  if (actualById.size !== EVALUATOR_REVIEW_PACKET_TOTAL) {
    errors.push(
      `Evaluator candidate sources contain ${actualById.size}/600 unique cases.`,
    );
  }
  for (const level of EVALUATOR_REVIEW_PACKET_LEVELS) {
    if (casesPerLevel[level] !== EVALUATOR_REVIEW_PACKET_PER_LEVEL) {
      errors.push(
        `Evaluator review packet has ${casesPerLevel[level]}/150 cases for ${level}.`,
      );
    }
    for (const category of EVALUATOR_REVIEW_PACKET_CATEGORIES) {
      if (
        categoriesPerLevel[level][category] !==
        EVALUATOR_REVIEW_PACKET_PER_CATEGORY_PER_LEVEL
      ) {
        errors.push(
          `Evaluator review packet has ${categoriesPerLevel[level][category]}/10 ${level} cases for ${category}.`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    totalSourceFiles: sourceFiles.length,
    totalCases: cases.length,
    casesPerLevel,
    categoriesPerLevel,
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
        "quality/evaluator-corpus/qualified-human-review-packet.json",
      ),
      "utf8",
    ),
  ) as unknown;
  const report = await verifyEvaluatorReviewPacket(manifest, repositoryRoot);
  if (!report.ok) {
    console.error(report.errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Evaluator review packet verified: ${report.totalCases} cases across ${report.totalSourceFiles} files, 150 per A1/A2/B1/B2 and 10 per category per level; status ${EVALUATOR_REVIEW_PACKET_STATUS}.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
