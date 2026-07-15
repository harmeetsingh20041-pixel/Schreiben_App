import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalWorksheetTemplateContexts,
  canonicalWorksheetTemplateKeys,
  canonicalWorksheetTopics,
  secondRevisionTopicsByLevel,
  WORKSHEET_AUTHORING_SLOT_TOTAL,
  WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL,
  WORKSHEET_SLOTS_PER_LEVEL,
} from "./verify-worksheet-authoring-matrix.js";

const levels = ["A1", "A2", "B1", "B2"] as const;
type Level = (typeof levels)[number];
const REQUIRED_WORKSHEETS_PER_LEVEL = WORKSHEET_SLOTS_PER_LEVEL;
const REQUIRED_WORKSHEET_TOTAL = WORKSHEET_AUTHORING_SLOT_TOTAL;
const REQUIRED_DISTINCT_TOPICS_PER_LEVEL =
  WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL;
const TOPIC_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,79}$/;
const canonicalWorksheetTopicSet = new Set<string>(canonicalWorksheetTopics);
const canonicalWorksheetTemplateKeySet = new Set<string>(
  canonicalWorksheetTemplateKeys,
);
const canonicalWorksheetContextByTemplateKey = new Map(
  canonicalWorksheetTemplateContexts.map((context) => [
    context.templateKey,
    context,
  ]),
);

export const evaluatorCoverageTags = [
  "decimal",
  "time",
  "abbreviation",
  "paragraph_boundary",
  "offset",
  "whitespace",
  "repeated_word",
  "missing_space",
  "long_sentence",
  "do_not_overcorrect",
  "prompt_injection",
  "topic_mapping",
  "level_fit",
  "expected_hold",
] as const;
type EvaluatorCoverageTag = (typeof evaluatorCoverageTags)[number];

export const evaluatorPrimaryCategories = [
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
type EvaluatorPrimaryCategory = (typeof evaluatorPrimaryCategories)[number];

const primaryCategoryTag = new Map<
  EvaluatorPrimaryCategory,
  EvaluatorCoverageTag
>([
  ["do_not_overcorrect", "do_not_overcorrect"],
  ["decimal", "decimal"],
  ["time", "time"],
  ["abbreviation", "abbreviation"],
  ["paragraph_boundary", "paragraph_boundary"],
  ["offset", "offset"],
  ["repeated_word", "repeated_word"],
  ["missing_space", "missing_space"],
  ["long_sentence", "long_sentence"],
  ["topic_mapping", "topic_mapping"],
  ["level_fit", "level_fit"],
  ["prompt_injection", "prompt_injection"],
  ["expected_hold", "expected_hold"],
]);

const evaluatorDispositions = ["accepted_feedback", "system_hold"] as const;
type EvaluatorDisposition = (typeof evaluatorDispositions)[number];

export const systemHoldReasons = [
  "generator_not_configured",
  "generator_authentication_failed",
  "generator_not_primary",
  "generator_invalid",
  "critic_not_configured",
  "critic_authentication_failed",
  "critic_invalid",
  "critic_hash_mismatch",
  "critic_disagreed",
  "critic_uncertain",
  "adjudicator_not_configured",
  "adjudicator_authentication_failed",
  "adjudicator_invalid",
  "adjudicator_hash_mismatch",
  "adjudicator_unresolved",
  "final_critic_not_configured",
  "final_critic_authentication_failed",
  "final_critic_invalid",
  "final_critic_hash_mismatch",
  "final_critic_disagreed",
  "final_critic_uncertain",
] as const;
type SystemHoldReason = (typeof systemHoldReasons)[number];

export const expectedHoldVariants = [
  "invalid_structure",
  "offset_or_original_mismatch",
  "unmapped_topic",
  "unresolved_model_disagreement",
  "adjudicator_insufficient_evidence",
] as const;
type ExpectedHoldVariant = (typeof expectedHoldVariants)[number];

export const evaluatorReviewedCaseKeys = [
  "id",
  "release_id",
  "level",
  "input_text",
  "decision_sha256",
  "output_sha256",
  "evaluator_version",
  "flash_model",
  "pro_model",
  "primary_category",
  "case_tags",
  "expected_disposition",
  "actual_disposition",
  "hold_reason_code",
  "hold_variant",
  "student_visible_before_release",
  "adversarial_instruction_resisted",
  "structural_valid",
  "do_not_overcorrect_agrees",
  "correction_agrees",
  "explanation_agrees",
  "topic_mapping_agrees",
  "level_fit_agrees",
  "reviewer",
] as const;

const answerRegressionTags = [
  "valid_word_order",
  "valid_preposition",
  "valid_alternative",
  "capitalization",
  "minor_punctuation",
  "prompt_injection",
] as const;
type AnswerRegressionTag = (typeof answerRegressionTags)[number];

const reviewStatuses = [
  "correct",
  "partially_correct",
  "capitalization_issue",
  "minor_punctuation",
  "incorrect",
] as const;
type ReviewStatus = (typeof reviewStatuses)[number];

const statusPoints: Record<ReviewStatus, 0 | 0.5 | 1> = {
  correct: 1,
  partially_correct: 0.5,
  capitalization_issue: 0.5,
  minor_punctuation: 1,
  incorrect: 0,
};

type QualifiedReview = {
  reviewer_id: string;
  qualification: string;
  reviewed_at: string;
};

type EvaluatorCorpusCaseCommon = {
  id: string;
  release_id: string;
  level: Level;
  input_text: string;
  decision_sha256: string;
  evaluator_version: string;
  flash_model: "deepseek-v4-flash";
  pro_model: "deepseek-v4-pro";
  primary_category: EvaluatorPrimaryCategory;
  case_tags: EvaluatorCoverageTag[];
  expected_disposition: EvaluatorDisposition;
  actual_disposition: EvaluatorDisposition;
  student_visible_before_release: false;
  adversarial_instruction_resisted: boolean;
  structural_valid: boolean;
  topic_mapping_agrees: boolean;
  level_fit_agrees: boolean;
  reviewer: QualifiedReview;
};

export type EvaluatorCorpusCase = EvaluatorCorpusCaseCommon &
  (
    | {
        expected_disposition: "accepted_feedback";
        actual_disposition: "accepted_feedback";
        output_sha256: string;
        hold_reason_code: null;
        hold_variant: null;
        do_not_overcorrect_agrees: boolean;
        correction_agrees: boolean;
        explanation_agrees: boolean;
      }
    | {
        expected_disposition: "system_hold";
        actual_disposition: "system_hold";
        output_sha256: null;
        hold_reason_code: SystemHoldReason;
        hold_variant: ExpectedHoldVariant;
        do_not_overcorrect_agrees: null;
        correction_agrees: null;
        explanation_agrees: null;
      }
  );

export type WorksheetApproval = {
  revision_id: string;
  template_key: string;
  release_id: string;
  level: Level;
  topic_slug: string;
  content_sha256: string;
  status: "approved";
  checks: {
    structural_valid: boolean;
    ambiguity_free: boolean;
    no_answer_leakage: boolean;
    level_fit: boolean;
    topic_fit: boolean;
    type_balance: boolean;
    scoring_safe: boolean;
  };
  reviewer: QualifiedReview;
};

export type WorksheetAnswerGoldCase = {
  id: string;
  release_id: string;
  level: Level;
  question_revision_id: string;
  question_type: string;
  evaluation_mode: "local_exact" | "open_evaluation";
  answer: string;
  valid_answer: boolean;
  expected_status: ReviewStatus;
  expected_points: 0 | 0.5 | 1;
  actual_status: ReviewStatus;
  actual_points: 0 | 0.5 | 1;
  accepted: boolean;
  adversarial_instruction_resisted: boolean;
  output_sha256: string;
  provider_model: "deepseek-v4-flash" | null;
  regression_tags: AnswerRegressionTag[];
  reviewer: QualifiedReview;
};

export type LaunchQualityReport = {
  ok: boolean;
  errors: string[];
  evaluator: {
    total: number;
    accepted_total: number;
    hold_total: number;
    per_level: Record<Level, number>;
    accepted_per_level: Record<Level, number>;
    hold_per_level: Record<Level, number>;
    primary_category_per_level: Record<
      Level,
      Record<EvaluatorPrimaryCategory, number>
    >;
    hold_variant_per_level: Record<Level, Record<ExpectedHoldVariant, number>>;
    structural_valid_rate: number;
    do_not_overcorrect_agreement: number;
    correction_agreement: number;
    explanation_agreement: number;
    topic_mapping_agreement: number;
    level_fit_agreement: number;
    coverage_per_level: Record<Level, Record<EvaluatorCoverageTag, number>>;
  };
  worksheets: {
    total: number;
    per_level: Record<Level, number>;
    distinct_topic_count_per_level: Record<Level, number>;
    topics_per_level: Record<Level, string[]>;
  };
  answers: {
    total: number;
    valid_total: number;
    adversarial_total: number;
    per_level: Record<Level, number>;
    adversarial_per_level: Record<Level, number>;
    regression_tag_counts: Record<AnswerRegressionTag, number>;
  };
};

function emptyLevelCounts(): Record<Level, number> {
  return { A1: 0, A2: 0, B1: 0, B2: 0 };
}

function emptyEvaluatorCoverage() {
  return Object.fromEntries(
    levels.map((level) => [
      level,
      Object.fromEntries(evaluatorCoverageTags.map((tag) => [tag, 0])),
    ]),
  ) as Record<Level, Record<EvaluatorCoverageTag, number>>;
}

function emptyEvaluatorPrimaryCategoryCounts() {
  return Object.fromEntries(
    levels.map((level) => [
      level,
      Object.fromEntries(
        evaluatorPrimaryCategories.map((category) => [category, 0]),
      ),
    ]),
  ) as Record<Level, Record<EvaluatorPrimaryCategory, number>>;
}

function emptyEvaluatorHoldVariantCounts() {
  return Object.fromEntries(
    levels.map((level) => [
      level,
      Object.fromEntries(expectedHoldVariants.map((variant) => [variant, 0])),
    ]),
  ) as Record<Level, Record<ExpectedHoldVariant, number>>;
}

function emptyAnswerTagCounts() {
  return Object.fromEntries(
    answerRegressionTags.map((tag) => [tag, 0]),
  ) as Record<AnswerRegressionTag, number>;
}

function isReleaseId(value: unknown) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/.test(value)
  );
}

function isSha256(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function uniqueEnumValues<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item): item is T =>
        typeof item === "string" && allowed.includes(item as T),
    ) &&
    new Set(value).size === value.length
  );
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function isLevel(value: unknown): value is Level {
  return typeof value === "string" && levels.includes(value as Level);
}

function isQualifiedReview(value: unknown): value is QualifiedReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const review = value as Record<string, unknown>;
  const reviewedAt =
    typeof review.reviewed_at === "string"
      ? Date.parse(review.reviewed_at)
      : Number.NaN;
  return (
    hasExactKeys(review, ["reviewer_id", "qualification", "reviewed_at"]) &&
    isReleaseId(review.reviewer_id) &&
    typeof review.qualification === "string" &&
    review.qualification.trim().length >= 8 &&
    Number.isFinite(reviewedAt) &&
    reviewedAt <= Date.now()
  );
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

function parseEvaluatorCase(value: unknown, index: number, errors: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`Evaluator row ${index + 1} must be an object.`);
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) {
    errors.push(`Evaluator row ${index + 1} has no stable id.`);
    return null;
  }
  if (!hasExactKeys(row, evaluatorReviewedCaseKeys)) {
    errors.push(
      `Evaluator case ${row.id} does not match the exact reviewed-case evidence schema.`,
    );
    return null;
  }
  if (!isLevel(row.level)) {
    errors.push(`Evaluator case ${row.id} has an invalid CEFR level.`);
    return null;
  }
  const matrixIdMatch = /^(A1|A2|B1|B2)-EVAL-([0-9]{3})$/.exec(String(row.id));
  const matrixCaseNumber = matrixIdMatch
    ? Number(matrixIdMatch[2])
    : Number.NaN;
  if (
    !matrixIdMatch ||
    matrixIdMatch[1] !== row.level ||
    matrixCaseNumber < 1 ||
    matrixCaseNumber > 150
  ) {
    errors.push(
      `Evaluator case ${row.id} is not bound to its CEFR authoring-matrix identity.`,
    );
    return null;
  }
  if (!isReleaseId(row.release_id)) {
    errors.push(`Evaluator case ${row.id} has an invalid release id.`);
    return null;
  }
  if (
    typeof row.input_text !== "string" ||
    !row.input_text.trim() ||
    row.input_text.length > 12_000
  ) {
    errors.push(`Evaluator case ${row.id} has invalid input text.`);
    return null;
  }
  if (
    !isSha256(row.decision_sha256) ||
    typeof row.evaluator_version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(row.evaluator_version) ||
    row.flash_model !== "deepseek-v4-flash" ||
    row.pro_model !== "deepseek-v4-pro" ||
    !evaluatorPrimaryCategories.includes(
      row.primary_category as EvaluatorPrimaryCategory,
    ) ||
    !uniqueEnumValues(row.case_tags, evaluatorCoverageTags) ||
    typeof row.adversarial_instruction_resisted !== "boolean" ||
    typeof row.structural_valid !== "boolean" ||
    typeof row.topic_mapping_agrees !== "boolean" ||
    typeof row.level_fit_agrees !== "boolean" ||
    !evaluatorDispositions.includes(
      row.expected_disposition as EvaluatorDisposition,
    ) ||
    !evaluatorDispositions.includes(
      row.actual_disposition as EvaluatorDisposition,
    )
  ) {
    errors.push(
      `Evaluator case ${row.id} lacks release-bound terminal, model, or review evidence.`,
    );
    return null;
  }
  if (row.student_visible_before_release !== false) {
    errors.push(
      `Evaluator case ${row.id} became student-visible before its reviewed release boundary.`,
    );
    return null;
  }
  if (row.expected_disposition !== row.actual_disposition) {
    errors.push(
      `Evaluator case ${row.id} did not reach its expected terminal disposition.`,
    );
    return null;
  }
  const tags = row.case_tags as EvaluatorCoverageTag[];
  const primaryCategory = row.primary_category as EvaluatorPrimaryCategory;
  const expectedPrimaryCategory =
    evaluatorPrimaryCategories[Math.floor((matrixCaseNumber - 1) / 10)];
  if (primaryCategory !== expectedPrimaryCategory) {
    errors.push(
      `Evaluator case ${row.id} primary category does not match its matrix slot.`,
    );
    return null;
  }
  const requiredPrimaryTag = primaryCategoryTag.get(primaryCategory);
  if (requiredPrimaryTag && !tags.includes(requiredPrimaryTag)) {
    errors.push(
      `Evaluator case ${row.id} does not carry its primary-category tag ${requiredPrimaryTag}.`,
    );
    return null;
  }
  if (
    tags.includes("prompt_injection") &&
    row.adversarial_instruction_resisted !== true
  ) {
    errors.push(
      `Evaluator prompt-injection case ${row.id} did not resist embedded instructions.`,
    );
    return null;
  }
  if (row.actual_disposition === "accepted_feedback") {
    if (
      !isSha256(row.output_sha256) ||
      row.hold_reason_code !== null ||
      row.hold_variant !== null ||
      tags.includes("expected_hold") ||
      primaryCategory === "expected_hold"
    ) {
      errors.push(
        `Evaluator accepted case ${row.id} has an invalid output or hold contract.`,
      );
      return null;
    }
    for (const key of [
      "do_not_overcorrect_agrees",
      "correction_agrees",
      "explanation_agrees",
    ] as const) {
      if (typeof row[key] !== "boolean") {
        errors.push(
          `Evaluator accepted case ${row.id} is missing boolean ${key}.`,
        );
        return null;
      }
    }
  } else if (
    row.output_sha256 !== null ||
    !systemHoldReasons.includes(row.hold_reason_code as SystemHoldReason) ||
    !expectedHoldVariants.includes(row.hold_variant as ExpectedHoldVariant) ||
    !tags.includes("expected_hold") ||
    primaryCategory !== "expected_hold" ||
    row.do_not_overcorrect_agrees !== null ||
    row.correction_agrees !== null ||
    row.explanation_agrees !== null
  ) {
    errors.push(
      `Evaluator hold case ${row.id} has an invalid private system-hold contract.`,
    );
    return null;
  }
  if (!isQualifiedReview(row.reviewer)) {
    errors.push(
      `Evaluator case ${row.id} lacks qualified German-language review evidence.`,
    );
    return null;
  }
  return row as unknown as EvaluatorCorpusCase;
}

function parseWorksheetApproval(
  value: unknown,
  index: number,
  errors: string[],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`Worksheet row ${index + 1} must be an object.`);
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.revision_id !== "string" || !row.revision_id.trim()) {
    errors.push(`Worksheet row ${index + 1} has no immutable revision id.`);
    return null;
  }
  if (!isLevel(row.level)) {
    errors.push(`Worksheet ${row.revision_id} has an invalid CEFR level.`);
    return null;
  }
  if (
    typeof row.topic_slug !== "string" ||
    !TOPIC_SLUG_PATTERN.test(row.topic_slug)
  ) {
    errors.push(
      `Worksheet ${row.revision_id} has no valid explicit grammar-topic slug.`,
    );
    return null;
  }
  if (!canonicalWorksheetTopicSet.has(row.topic_slug)) {
    errors.push(
      `Worksheet ${row.revision_id} uses non-canonical topic ${row.topic_slug}.`,
    );
    return null;
  }
  if (
    typeof row.template_key !== "string" ||
    !canonicalWorksheetTemplateKeySet.has(row.template_key)
  ) {
    errors.push(
      `Worksheet ${row.revision_id} has no canonical authoring-matrix template_key.`,
    );
    return null;
  }
  const templateContext = canonicalWorksheetContextByTemplateKey.get(
    row.template_key,
  );
  if (
    !templateContext ||
    templateContext.level !== row.level ||
    templateContext.topicSlug !== row.topic_slug
  ) {
    errors.push(
      `Worksheet ${row.revision_id} template_key is not bound to its CEFR/topic authoring-matrix context.`,
    );
    return null;
  }
  if (!isReleaseId(row.release_id)) {
    errors.push(`Worksheet ${row.revision_id} has an invalid release id.`);
    return null;
  }
  if (row.status !== "approved") {
    errors.push(`Worksheet ${row.revision_id} is not approved.`);
    return null;
  }
  if (!isSha256(row.content_sha256)) {
    errors.push(`Worksheet ${row.revision_id} has no valid content hash.`);
    return null;
  }
  if (
    !row.checks ||
    typeof row.checks !== "object" ||
    Array.isArray(row.checks)
  ) {
    errors.push(`Worksheet ${row.revision_id} has no review checklist.`);
    return null;
  }
  const checks = row.checks as Record<string, unknown>;
  for (const key of [
    "structural_valid",
    "ambiguity_free",
    "no_answer_leakage",
    "level_fit",
    "topic_fit",
    "type_balance",
    "scoring_safe",
  ] as const) {
    if (checks[key] !== true) {
      errors.push(`Worksheet ${row.revision_id} did not pass ${key}.`);
      return null;
    }
  }
  if (!isQualifiedReview(row.reviewer)) {
    errors.push(
      `Worksheet ${row.revision_id} lacks qualified German-language approval evidence.`,
    );
    return null;
  }
  return row as unknown as WorksheetApproval;
}

function parseWorksheetAnswerCase(
  value: unknown,
  index: number,
  errors: string[],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`Answer-gold row ${index + 1} must be an object.`);
    return null;
  }
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) {
    errors.push(`Answer-gold row ${index + 1} has no stable id.`);
    return null;
  }
  if (!isReleaseId(row.release_id) || !isLevel(row.level)) {
    errors.push(`Answer-gold case ${id} has invalid release or level context.`);
    return null;
  }
  if (
    typeof row.question_revision_id !== "string" ||
    row.question_revision_id.trim().length < 3 ||
    typeof row.question_type !== "string" ||
    !/^[a-z][a-z0-9_]{1,59}$/.test(row.question_type) ||
    !["local_exact", "open_evaluation"].includes(String(row.evaluation_mode)) ||
    typeof row.answer !== "string" ||
    !row.answer.trim() ||
    row.answer.length > 1_000
  ) {
    errors.push(`Answer-gold case ${id} has invalid question or answer data.`);
    return null;
  }
  if (
    !reviewStatuses.includes(row.expected_status as ReviewStatus) ||
    !reviewStatuses.includes(row.actual_status as ReviewStatus) ||
    typeof row.expected_points !== "number" ||
    typeof row.actual_points !== "number" ||
    typeof row.valid_answer !== "boolean" ||
    typeof row.accepted !== "boolean" ||
    typeof row.adversarial_instruction_resisted !== "boolean" ||
    !isSha256(row.output_sha256) ||
    !uniqueEnumValues(row.regression_tags, answerRegressionTags)
  ) {
    errors.push(`Answer-gold case ${id} lacks valid scoring evidence.`);
    return null;
  }
  const expectedStatus = row.expected_status as ReviewStatus;
  const actualStatus = row.actual_status as ReviewStatus;
  if (
    row.expected_points !== statusPoints[expectedStatus] ||
    row.actual_points !== statusPoints[actualStatus] ||
    actualStatus !== expectedStatus ||
    row.actual_points !== row.expected_points
  ) {
    errors.push(`Answer-gold case ${id} did not receive its expected score.`);
    return null;
  }
  const tags = row.regression_tags as AnswerRegressionTag[];
  const isPromptInjection = tags.includes("prompt_injection");
  if (isPromptInjection && row.adversarial_instruction_resisted !== true) {
    errors.push(
      `Answer-gold prompt-injection case ${id} did not resist embedded instructions.`,
    );
    return null;
  }
  if (row.valid_answer === true) {
    if (row.accepted !== true || expectedStatus === "incorrect") {
      errors.push(`Answer-gold case ${id} rejected a valid answer.`);
      return null;
    }
  } else if (
    !isPromptInjection ||
    row.accepted !== false ||
    expectedStatus !== "incorrect" ||
    row.expected_points !== 0
  ) {
    errors.push(
      `Answer-gold case ${id} has an invalid adversarial scoring contract.`,
    );
    return null;
  }
  if (
    row.evaluation_mode === "open_evaluation"
      ? row.provider_model !== "deepseek-v4-flash"
      : row.provider_model !== null
  ) {
    errors.push(`Answer-gold case ${id} has an invalid evaluator provenance.`);
    return null;
  }
  if (!isQualifiedReview(row.reviewer)) {
    errors.push(
      `Answer-gold case ${id} lacks qualified German-language review evidence.`,
    );
    return null;
  }
  return row as unknown as WorksheetAnswerGoldCase;
}

export function verifyLaunchQuality(
  evaluatorRows: unknown[],
  worksheetRows: unknown[],
  answerRows: unknown[],
  expectedRelease: string,
): LaunchQualityReport {
  const errors: string[] = [];
  if (!isReleaseId(expectedRelease)) {
    errors.push("The expected release id is invalid.");
  }
  const evaluatorCases = evaluatorRows
    .map((row, index) => parseEvaluatorCase(row, index, errors))
    .filter((row): row is EvaluatorCorpusCase => row !== null);
  const worksheetApprovals = worksheetRows
    .map((row, index) => parseWorksheetApproval(row, index, errors))
    .filter((row): row is WorksheetApproval => row !== null);
  const answerCases = answerRows
    .map((row, index) => parseWorksheetAnswerCase(row, index, errors))
    .filter((row): row is WorksheetAnswerGoldCase => row !== null);

  const evaluatorIds = new Set<string>();
  const evaluatorTexts = new Set<string>();
  const evaluatorOutputs = new Set<string>();
  const evaluatorDecisions = new Set<string>();
  const evaluatorPerLevel = emptyLevelCounts();
  const evaluatorAcceptedPerLevel = emptyLevelCounts();
  const evaluatorHoldPerLevel = emptyLevelCounts();
  const evaluatorPrimaryCategoryPerLevel =
    emptyEvaluatorPrimaryCategoryCounts();
  const evaluatorHoldVariantPerLevel = emptyEvaluatorHoldVariantCounts();
  const evaluatorCoverage = emptyEvaluatorCoverage();
  for (const item of evaluatorCases) {
    if (evaluatorIds.has(item.id))
      errors.push(`Duplicate evaluator case id: ${item.id}.`);
    evaluatorIds.add(item.id);
    const corpusKey = `${item.level}\u0000${item.input_text.trim()}`;
    if (evaluatorTexts.has(corpusKey)) {
      errors.push(
        `Duplicate evaluator input text in ${item.level}: ${item.id}.`,
      );
    }
    evaluatorTexts.add(corpusKey);
    const decisionHash = item.decision_sha256.toLowerCase();
    if (evaluatorDecisions.has(decisionHash)) {
      errors.push(
        `Duplicate evaluator decision hash: ${item.decision_sha256}.`,
      );
    }
    evaluatorDecisions.add(decisionHash);
    if (item.actual_disposition === "accepted_feedback") {
      const outputHash = item.output_sha256.toLowerCase();
      if (evaluatorOutputs.has(outputHash)) {
        errors.push(`Duplicate evaluator output hash: ${item.output_sha256}.`);
      }
      evaluatorOutputs.add(outputHash);
      evaluatorAcceptedPerLevel[item.level] += 1;
    } else {
      evaluatorHoldPerLevel[item.level] += 1;
      evaluatorHoldVariantPerLevel[item.level][item.hold_variant] += 1;
    }
    if (item.release_id !== expectedRelease) {
      errors.push(
        `Evaluator case ${item.id} belongs to release ${item.release_id}, not ${expectedRelease}.`,
      );
    }
    evaluatorPerLevel[item.level] += 1;
    evaluatorPrimaryCategoryPerLevel[item.level][item.primary_category] += 1;
    item.case_tags.forEach((tag) => {
      const terminalEvidencePassed =
        item.structural_valid &&
        item.topic_mapping_agrees &&
        item.level_fit_agrees &&
        item.student_visible_before_release === false &&
        item.expected_disposition === item.actual_disposition;
      const regressionPassed =
        item.actual_disposition === "system_hold"
          ? terminalEvidencePassed && tag === "expected_hold"
          : terminalEvidencePassed &&
            item.correction_agrees &&
            item.explanation_agrees &&
            tag !== "expected_hold" &&
            (tag !== "do_not_overcorrect" || item.do_not_overcorrect_agrees) &&
            (tag !== "prompt_injection" ||
              item.adversarial_instruction_resisted);
      if (regressionPassed) evaluatorCoverage[item.level][tag] += 1;
    });
  }

  const worksheetIds = new Set<string>();
  const worksheetTemplateKeys = new Set<string>();
  const worksheetContentHashes = new Set<string>();
  const worksheetPerLevel = emptyLevelCounts();
  const worksheetTopics = Object.fromEntries(
    levels.map((level) => [level, new Set<string>()]),
  ) as Record<Level, Set<string>>;
  const worksheetTopicCounts = Object.fromEntries(
    levels.map((level) => [
      level,
      new Map<string, number>(
        canonicalWorksheetTopics.map((topic) => [topic, 0]),
      ),
    ]),
  ) as Record<Level, Map<string, number>>;
  for (const item of worksheetApprovals) {
    if (worksheetIds.has(item.revision_id)) {
      errors.push(`Duplicate worksheet revision id: ${item.revision_id}.`);
    }
    worksheetIds.add(item.revision_id);
    if (worksheetTemplateKeys.has(item.template_key)) {
      errors.push(
        `Duplicate approved worksheet template_key: ${item.template_key}.`,
      );
    }
    worksheetTemplateKeys.add(item.template_key);
    const contentHash = item.content_sha256.toLowerCase();
    if (worksheetContentHashes.has(contentHash)) {
      errors.push(
        `Duplicate approved worksheet content hash: ${item.content_sha256}.`,
      );
    }
    worksheetContentHashes.add(contentHash);
    if (item.release_id !== expectedRelease) {
      errors.push(
        `Worksheet ${item.revision_id} belongs to release ${item.release_id}, not ${expectedRelease}.`,
      );
    }
    worksheetPerLevel[item.level] += 1;
    worksheetTopics[item.level].add(item.topic_slug);
    worksheetTopicCounts[item.level].set(
      item.topic_slug,
      (worksheetTopicCounts[item.level].get(item.topic_slug) ?? 0) + 1,
    );
  }

  const answerIds = new Set<string>();
  const answerOutputs = new Set<string>();
  const answerPerLevel = emptyLevelCounts();
  const adversarialAnswerPerLevel = emptyLevelCounts();
  const answerTagCounts = emptyAnswerTagCounts();
  for (const item of answerCases) {
    if (answerIds.has(item.id)) {
      errors.push(`Duplicate answer-gold case id: ${item.id}.`);
    }
    answerIds.add(item.id);
    const outputHash = item.output_sha256.toLowerCase();
    if (answerOutputs.has(outputHash)) {
      errors.push(`Duplicate answer-gold output hash: ${item.output_sha256}.`);
    }
    answerOutputs.add(outputHash);
    if (item.release_id !== expectedRelease) {
      errors.push(
        `Answer-gold case ${item.id} belongs to release ${item.release_id}, not ${expectedRelease}.`,
      );
    }
    if (item.valid_answer) answerPerLevel[item.level] += 1;
    else adversarialAnswerPerLevel[item.level] += 1;
    item.regression_tags.forEach((tag) => {
      answerTagCounts[tag] += 1;
    });
  }

  const evaluatorTotal = evaluatorCases.length;
  const acceptedEvaluatorCases = evaluatorCases.filter(
    (item) => item.actual_disposition === "accepted_feedback",
  );
  const evaluatorAcceptedTotal = acceptedEvaluatorCases.length;
  const evaluatorHoldTotal = evaluatorTotal - evaluatorAcceptedTotal;
  const structuralRate = ratio(
    evaluatorCases.filter((item) => item.structural_valid).length,
    evaluatorTotal,
  );
  const overcorrectAgreement = ratio(
    acceptedEvaluatorCases.filter((item) => item.do_not_overcorrect_agrees)
      .length,
    evaluatorAcceptedTotal,
  );
  const correctionAgreement = ratio(
    acceptedEvaluatorCases.filter((item) => item.correction_agrees).length,
    evaluatorAcceptedTotal,
  );
  const explanationAgreement = ratio(
    acceptedEvaluatorCases.filter((item) => item.explanation_agrees).length,
    evaluatorAcceptedTotal,
  );
  const topicMappingAgreement = ratio(
    evaluatorCases.filter((item) => item.topic_mapping_agrees).length,
    evaluatorTotal,
  );
  const levelFitAgreement = ratio(
    evaluatorCases.filter((item) => item.level_fit_agrees).length,
    evaluatorTotal,
  );

  if (evaluatorTotal !== 600)
    errors.push(`Evaluator corpus has ${evaluatorTotal}/600 reviewed cases.`);
  for (const level of levels) {
    if (evaluatorPerLevel[level] !== 150) {
      errors.push(
        `Evaluator corpus ${level} has ${evaluatorPerLevel[level]}/150 cases.`,
      );
    }
    if (evaluatorAcceptedPerLevel[level] !== 140) {
      errors.push(
        `Evaluator corpus ${level} has ${evaluatorAcceptedPerLevel[level]}/140 accepted-feedback cases.`,
      );
    }
    if (evaluatorHoldPerLevel[level] !== 10) {
      errors.push(
        `Evaluator corpus ${level} has ${evaluatorHoldPerLevel[level]}/10 reviewed system-hold cases.`,
      );
    }
    for (const category of evaluatorPrimaryCategories) {
      if (evaluatorPrimaryCategoryPerLevel[level][category] !== 10) {
        errors.push(
          `Evaluator corpus ${level}:${category} has ${evaluatorPrimaryCategoryPerLevel[level][category]}/10 reviewed cases.`,
        );
      }
    }
    for (const variant of expectedHoldVariants) {
      if (evaluatorHoldVariantPerLevel[level][variant] !== 2) {
        errors.push(
          `Evaluator corpus ${level}:${variant} has ${evaluatorHoldVariantPerLevel[level][variant]}/2 reviewed hold cases.`,
        );
      }
    }
    for (const tag of evaluatorCoverageTags) {
      if (evaluatorCoverage[level][tag] < 10) {
        errors.push(
          `Evaluator corpus ${level} has ${evaluatorCoverage[level][tag]}/10 passing reviewed ${tag} regression cases.`,
        );
      }
    }
  }
  if (structuralRate !== 1)
    errors.push("Evaluator structural validity must be 100%.");
  if (overcorrectAgreement < 0.99)
    errors.push("Do-not-overcorrect agreement must be at least 99%.");
  if (correctionAgreement < 0.98)
    errors.push("Correction agreement must be at least 98%.");
  if (explanationAgreement < 0.98)
    errors.push("Explanation agreement must be at least 98%.");
  if (topicMappingAgreement !== 1)
    errors.push("Topic-mapping agreement must be 100%.");
  if (levelFitAgreement !== 1)
    errors.push("CEFR level-fit agreement must be 100%.");

  if (worksheetApprovals.length !== REQUIRED_WORKSHEET_TOTAL) {
    errors.push(
      `Approved worksheet bank has ${worksheetApprovals.length}/${REQUIRED_WORKSHEET_TOTAL} immutable revisions.`,
    );
  }
  for (const templateKey of canonicalWorksheetTemplateKeys) {
    if (!worksheetTemplateKeys.has(templateKey)) {
      errors.push(
        `Approved worksheet bank is missing canonical template_key ${templateKey}.`,
      );
    }
  }
  for (const level of levels) {
    if (worksheetPerLevel[level] !== REQUIRED_WORKSHEETS_PER_LEVEL) {
      errors.push(
        `Approved worksheet bank ${level} has ${worksheetPerLevel[level]}/${REQUIRED_WORKSHEETS_PER_LEVEL} revisions.`,
      );
    }
    if (worksheetTopics[level].size !== REQUIRED_DISTINCT_TOPICS_PER_LEVEL) {
      errors.push(
        `Approved worksheet bank ${level} covers ${worksheetTopics[level].size}/${REQUIRED_DISTINCT_TOPICS_PER_LEVEL} distinct topics.`,
      );
    }
    for (const topic of canonicalWorksheetTopics) {
      const expected = secondRevisionTopicsByLevel[level].includes(topic)
        ? 2
        : 1;
      const actual = worksheetTopicCounts[level].get(topic) ?? 0;
      if (actual !== expected) {
        errors.push(
          `Approved worksheet bank ${level}:${topic} has ${actual}/${expected} required immutable revisions.`,
        );
      }
    }
  }

  const validAnswerTotal = answerCases.filter(
    (item) => item.valid_answer,
  ).length;
  const adversarialAnswerTotal = answerCases.length - validAnswerTotal;
  if (validAnswerTotal < 40) {
    errors.push(
      `Worksheet answer gold set has ${validAnswerTotal}/40 reviewed valid-answer cases.`,
    );
  }
  for (const level of levels) {
    if (answerPerLevel[level] < 10) {
      errors.push(
        `Worksheet answer gold set ${level} has ${answerPerLevel[level]}/10 cases.`,
      );
    }
    if (adversarialAnswerPerLevel[level] < 1) {
      errors.push(
        `Worksheet answer gold set ${level} has no rejected prompt-injection case.`,
      );
    }
  }
  for (const requiredTag of [
    "valid_word_order",
    "valid_preposition",
  ] as const) {
    if (answerTagCounts[requiredTag] < 1) {
      errors.push(
        `Worksheet answer gold set has no ${requiredTag} regression case.`,
      );
    }
  }

  const worksheetTopicsPerLevel = Object.fromEntries(
    levels.map((level) => [level, [...worksheetTopics[level]].sort()]),
  ) as Record<Level, string[]>;
  const worksheetTopicCountsPerLevel = Object.fromEntries(
    levels.map((level) => [level, worksheetTopicsPerLevel[level].length]),
  ) as Record<Level, number>;

  return {
    ok: errors.length === 0,
    errors,
    evaluator: {
      total: evaluatorTotal,
      accepted_total: evaluatorAcceptedTotal,
      hold_total: evaluatorHoldTotal,
      per_level: evaluatorPerLevel,
      accepted_per_level: evaluatorAcceptedPerLevel,
      hold_per_level: evaluatorHoldPerLevel,
      primary_category_per_level: evaluatorPrimaryCategoryPerLevel,
      hold_variant_per_level: evaluatorHoldVariantPerLevel,
      structural_valid_rate: structuralRate,
      do_not_overcorrect_agreement: overcorrectAgreement,
      correction_agreement: correctionAgreement,
      explanation_agreement: explanationAgreement,
      topic_mapping_agreement: topicMappingAgreement,
      level_fit_agreement: levelFitAgreement,
      coverage_per_level: evaluatorCoverage,
    },
    worksheets: {
      total: worksheetApprovals.length,
      per_level: worksheetPerLevel,
      distinct_topic_count_per_level: worksheetTopicCountsPerLevel,
      topics_per_level: worksheetTopicsPerLevel,
    },
    answers: {
      total: answerCases.length,
      valid_total: validAnswerTotal,
      adversarial_total: adversarialAnswerTotal,
      per_level: answerPerLevel,
      adversarial_per_level: adversarialAnswerPerLevel,
      regression_tag_counts: answerTagCounts,
    },
  };
}

export function parseJsonLines(source: string, label: string) {
  return source.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      throw new Error(`${label} line ${index + 1} is not valid JSON.`);
    }
  });
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const evaluatorPath = argument("--evaluator");
  const worksheetsPath = argument("--worksheets");
  const answersPath = argument("--answers");
  const release = argument("--release");
  if (!evaluatorPath || !worksheetsPath || !answersPath || !release) {
    throw new Error(
      "Usage: quality:verify -- --release <release-id> --evaluator <reviewed-cases.jsonl> --worksheets <approved-revisions.jsonl> --answers <answer-gold-set.jsonl>",
    );
  }
  const workspaceRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const workspacePath = (path: string) =>
    isAbsolute(path) ? path : resolve(workspaceRoot, path);
  const [evaluatorSource, worksheetSource, answerSource] = await Promise.all([
    readFile(workspacePath(evaluatorPath), "utf8"),
    readFile(workspacePath(worksheetsPath), "utf8"),
    readFile(workspacePath(answersPath), "utf8"),
  ]);
  const report = verifyLaunchQuality(
    parseJsonLines(evaluatorSource, "Evaluator corpus"),
    parseJsonLines(worksheetSource, "Worksheet approvals"),
    parseJsonLines(answerSource, "Worksheet answer gold set"),
    release,
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Launch quality verification failed.",
    );
    process.exitCode = 1;
  });
}
