import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseJsonLines } from "./verify-launch-quality.js";
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
const dispositions = [
  "reusable",
  "quarantined",
  "retired",
  "historical_only",
  "unresolved",
] as const;
const qualityStatuses = [
  "draft",
  "approved",
  "needs_review",
  "failed",
] as const;
const visibilities = ["private", "workspace"] as const;
const difficulties = ["easy", "medium", "hard"] as const;
const MAX_EVIDENCE_AGE_MS = 36 * 60 * 60_000;
const REQUIRED_CANONICAL_BANK_TOTAL = WORKSHEET_AUTHORING_SLOT_TOTAL;
const REQUIRED_CANONICAL_BANK_PER_LEVEL = WORKSHEET_SLOTS_PER_LEVEL;
const REQUIRED_DISTINCT_TOPICS_PER_LEVEL =
  WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const SOURCE_PATTERN = /^[a-z][a-z0-9_]{1,59}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
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

type Level = (typeof levels)[number];
type Disposition = (typeof dispositions)[number];
type QualityStatus = (typeof qualityStatuses)[number];
type Visibility = (typeof visibilities)[number];
type Difficulty = (typeof difficulties)[number];

export type ProductionWorksheetInventoryRow = {
  revision_id: string;
  level: Level;
  generation_source: string;
  generator_model: string | null;
  approval_source: string | null;
  created_by_ai: boolean;
  teacher_reviewed: boolean;
  visibility: Visibility;
  quality_status: QualityStatus;
  content_sha256: string;
  answer_contract_v1: boolean;
  has_student_use: boolean;
  system_validation_passed: boolean;
  reviewed_by_present: boolean;
  reviewed_at_present: boolean;
  worksheet_model_cache_revision_id: string | null;
  model_cache_content_sha256: string | null;
  disposition: Disposition;
};

export type ProductionModelValidatedWorksheetCacheRow = {
  revision_id: string;
  level: Level;
  topic_slug: string;
  difficulty: Difficulty;
  generator_provider: string;
  generator_model: string;
  validation_profile: "mcq_safe_v1";
  deterministic_validation_passed: boolean;
  independent_model_validation_passed: boolean;
  source_practice_test_id: string;
  source_completion_job_id: string;
  candidate_sha256: string;
  primary_critic_provider: string;
  primary_critic_model: string;
  primary_verdict_sha256: string;
  secondary_critic_provider: string;
  secondary_critic_model: string;
  secondary_verdict_sha256: string;
  content_sha256: string;
  recomputed_content_sha256: string | null;
  promoted_at: string;
  withdrawn: boolean;
  is_current: boolean;
  immutable_controls_present: boolean;
};

export type ProductionCanonicalWorksheetBankRow = {
  revision_id: string;
  template_id: string;
  template_key: string;
  level: Level;
  topic_slug: string;
  state: "released";
  content_sha256: string;
  recomputed_content_sha256: string | null;
  review_id: string | null;
  reviewer_id: string | null;
  review_decision: string | null;
  review_checklist_complete: boolean;
  review_content_sha256: string | null;
  reviewed_at: string | null;
  reviewer_qualified: boolean;
  bank_release_id: string | null;
  release_review_id: string | null;
  released_by: string | null;
  release_content_sha256: string | null;
  released_at: string | null;
  releaser_qualified: boolean;
  immutable_controls_present: boolean;
};

export type ProductionWorksheetInventoryEvidence = {
  schema_version: 4;
  hash_origin: "db_recomputed_v1";
  app_release: string;
  project_ref: string;
  collected_at: string;
  rows: ProductionWorksheetInventoryRow[];
  canonical_bank: ProductionCanonicalWorksheetBankRow[];
  model_validated_cache: ProductionModelValidatedWorksheetCacheRow[];
};

type WorksheetApproval = {
  revision_id: string;
  template_key: string;
  release_id: string;
  level: Level;
  topic_slug: string;
  content_sha256: string;
};

export type ProductionWorksheetInventoryReport = {
  ok: boolean;
  errors: string[];
  app_release: string;
  project_ref: string;
  approved_manifest_total: number;
  approved_manifest_template_key_total: number;
  approved_manifest_per_level: Record<Level, number>;
  canonical_bank_total: number;
  canonical_bank_template_key_total: number;
  canonical_bank_per_level: Record<Level, number>;
  canonical_bank_distinct_topic_count_per_level: Record<Level, number>;
  canonical_bank_topics_per_level: Record<Level, string[]>;
  production_total: number;
  human_reusable_total: number;
  certified_clone_total: number;
  system_validated_reusable_total: number;
  model_validated_cache_total: number;
  model_validated_cache_active_total: number;
  model_validated_cache_withdrawn_total: number;
  model_validated_cache_invalid_total: number;
  model_validated_cache_clone_total: number;
  teacher_reviewed_generated_total: number;
  quarantined_total: number;
  retired_total: number;
  historical_only_total: number;
  unresolved_total: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    errors.push(
      `${label} contains unsupported field(s): ${unexpected.join(", ")}.`,
    );
  }
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function isLevel(value: unknown): value is Level {
  return typeof value === "string" && levels.includes(value as Level);
}

function emptyLevelCounts(): Record<Level, number> {
  return { A1: 0, A2: 0, B1: 0, B2: 0 };
}

function parseApproval(
  value: unknown,
  index: number,
  expectedRelease: string,
  now: Date,
  errors: string[],
): WorksheetApproval | null {
  const label = `Worksheet approval ${index + 1}`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  hasOnlyKeys(
    value,
    [
      "revision_id",
      "template_key",
      "release_id",
      "level",
      "topic_slug",
      "content_sha256",
      "status",
      "checks",
      "reviewer",
    ],
    label,
    errors,
  );
  if (!UUID_PATTERN.test(String(value.revision_id))) {
    errors.push(`${label} must use the immutable production revision UUID.`);
    return null;
  }
  if (
    value.release_id !== expectedRelease ||
    !isLevel(value.level) ||
    typeof value.topic_slug !== "string" ||
    !TOPIC_SLUG_PATTERN.test(value.topic_slug)
  ) {
    errors.push(`${label} has mismatched release, CEFR, or topic context.`);
    return null;
  }
  if (!canonicalWorksheetTopicSet.has(value.topic_slug)) {
    errors.push(`${label} uses non-canonical topic ${value.topic_slug}.`);
    return null;
  }
  if (
    typeof value.template_key !== "string" ||
    !canonicalWorksheetTemplateKeySet.has(value.template_key)
  ) {
    errors.push(`${label} has no canonical authoring-matrix template_key.`);
    return null;
  }
  const templateContext = canonicalWorksheetContextByTemplateKey.get(
    value.template_key,
  );
  if (
    !templateContext ||
    templateContext.level !== value.level ||
    templateContext.topicSlug !== value.topic_slug
  ) {
    errors.push(`${label} template_key contradicts its CEFR/topic context.`);
    return null;
  }
  if (
    value.status !== "approved" ||
    !SHA256_PATTERN.test(String(value.content_sha256))
  ) {
    errors.push(`${label} is not an approved content-hashed revision.`);
    return null;
  }
  if (!isRecord(value.checks)) {
    errors.push(`${label} has no deterministic review checklist.`);
    return null;
  }
  const checks = value.checks;
  const requiredChecks = [
    "structural_valid",
    "ambiguity_free",
    "no_answer_leakage",
    "level_fit",
    "topic_fit",
    "type_balance",
    "scoring_safe",
  ];
  hasOnlyKeys(checks, requiredChecks, `${label} checks`, errors);
  if (requiredChecks.some((key) => checks[key] !== true)) {
    errors.push(`${label} did not pass every required review check.`);
    return null;
  }
  if (!isRecord(value.reviewer)) {
    errors.push(`${label} has no qualified reviewer attestation.`);
    return null;
  }
  hasOnlyKeys(
    value.reviewer,
    ["reviewer_id", "qualification", "reviewed_at"],
    `${label} reviewer`,
    errors,
  );
  const reviewedAt = value.reviewer.reviewed_at;
  if (
    typeof value.reviewer.reviewer_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value.reviewer.reviewer_id) ||
    typeof value.reviewer.qualification !== "string" ||
    value.reviewer.qualification.trim().length < 8 ||
    !isTimestamp(reviewedAt) ||
    Date.parse(reviewedAt) > now.getTime()
  ) {
    errors.push(`${label} has an invalid or future reviewer attestation.`);
    return null;
  }
  return {
    revision_id: String(value.revision_id),
    template_key: value.template_key,
    release_id: expectedRelease,
    level: value.level,
    topic_slug: value.topic_slug,
    content_sha256: String(value.content_sha256).toLowerCase(),
  };
}

function expectedDisposition(
  row: Omit<ProductionWorksheetInventoryRow, "disposition">,
): Disposition {
  const reusable =
    row.visibility === "workspace" &&
    row.quality_status === "approved" &&
    row.generation_source !== "system_fallback" &&
    row.answer_contract_v1;
  if (reusable) return "reusable";
  if (row.visibility === "private" && row.quality_status === "needs_review") {
    return "quarantined";
  }
  if (row.visibility === "private" && row.quality_status === "failed") {
    return "retired";
  }
  if (row.has_student_use) return "historical_only";
  return "unresolved";
}

function parseInventoryRow(
  value: unknown,
  index: number,
  errors: string[],
): ProductionWorksheetInventoryRow | null {
  const label = `Production worksheet ${index + 1}`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  const keys = [
    "revision_id",
    "level",
    "generation_source",
    "generator_model",
    "approval_source",
    "created_by_ai",
    "teacher_reviewed",
    "visibility",
    "quality_status",
    "content_sha256",
    "answer_contract_v1",
    "has_student_use",
    "system_validation_passed",
    "reviewed_by_present",
    "reviewed_at_present",
    "worksheet_model_cache_revision_id",
    "model_cache_content_sha256",
    "disposition",
  ] as const;
  hasOnlyKeys(value, keys, label, errors);
  if (
    !UUID_PATTERN.test(String(value.revision_id)) ||
    !isLevel(value.level) ||
    typeof value.generation_source !== "string" ||
    !SOURCE_PATTERN.test(value.generation_source) ||
    !isNullableModel(value.generator_model) ||
    !isNullableSource(value.approval_source) ||
    typeof value.created_by_ai !== "boolean" ||
    typeof value.teacher_reviewed !== "boolean" ||
    !visibilities.includes(value.visibility as Visibility) ||
    !qualityStatuses.includes(value.quality_status as QualityStatus) ||
    !SHA256_PATTERN.test(String(value.content_sha256)) ||
    typeof value.answer_contract_v1 !== "boolean" ||
    typeof value.has_student_use !== "boolean" ||
    typeof value.system_validation_passed !== "boolean" ||
    typeof value.reviewed_by_present !== "boolean" ||
    typeof value.reviewed_at_present !== "boolean" ||
    !isNullableUuid(value.worksheet_model_cache_revision_id) ||
    !isNullableSha256(value.model_cache_content_sha256) ||
    !dispositions.includes(value.disposition as Disposition)
  ) {
    errors.push(`${label} has an invalid content-free inventory contract.`);
    return null;
  }
  const row = {
    revision_id: String(value.revision_id),
    level: value.level,
    generation_source: value.generation_source,
    generator_model: value.generator_model,
    approval_source: value.approval_source,
    created_by_ai: value.created_by_ai,
    teacher_reviewed: value.teacher_reviewed,
    visibility: value.visibility as Visibility,
    quality_status: value.quality_status as QualityStatus,
    content_sha256: String(value.content_sha256).toLowerCase(),
    answer_contract_v1: value.answer_contract_v1,
    has_student_use: value.has_student_use,
    system_validation_passed: value.system_validation_passed,
    reviewed_by_present: value.reviewed_by_present,
    reviewed_at_present: value.reviewed_at_present,
    worksheet_model_cache_revision_id: value.worksheet_model_cache_revision_id,
    model_cache_content_sha256:
      value.model_cache_content_sha256?.toLowerCase() ?? null,
    disposition: value.disposition as Disposition,
  } satisfies ProductionWorksheetInventoryRow;
  if (
    (row.worksheet_model_cache_revision_id === null) !==
    (row.model_cache_content_sha256 === null)
  ) {
    errors.push(
      `${label} has an incomplete model-validated cache provenance link.`,
    );
    return null;
  }
  if (row.disposition !== expectedDisposition(row)) {
    errors.push(
      `${label} has a disposition that contradicts its database state.`,
    );
    return null;
  }
  return row;
}

function isNullableUuid(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && UUID_PATTERN.test(value))
  );
}

function isNullableSource(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && SOURCE_PATTERN.test(value))
  );
}

function isNullableModel(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && MODEL_PATTERN.test(value))
  );
}

function isNullableSha256(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && SHA256_PATTERN.test(value))
  );
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function modelCacheEvidenceIsCoherent(
  row: ProductionModelValidatedWorksheetCacheRow,
) {
  return (
    row.primary_critic_provider !== row.secondary_critic_provider &&
    row.deterministic_validation_passed &&
    row.independent_model_validation_passed &&
    row.candidate_sha256 !== row.content_sha256 &&
    row.recomputed_content_sha256 === row.content_sha256 &&
    row.is_current !== row.withdrawn &&
    row.immutable_controls_present
  );
}

function parseModelValidatedCacheRow(
  value: unknown,
  index: number,
  errors: string[],
): ProductionModelValidatedWorksheetCacheRow | null {
  const label = `Model-validated worksheet cache revision ${index + 1}`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  const keys = [
    "revision_id",
    "level",
    "topic_slug",
    "difficulty",
    "generator_provider",
    "generator_model",
    "validation_profile",
    "deterministic_validation_passed",
    "independent_model_validation_passed",
    "source_practice_test_id",
    "source_completion_job_id",
    "candidate_sha256",
    "primary_critic_provider",
    "primary_critic_model",
    "primary_verdict_sha256",
    "secondary_critic_provider",
    "secondary_critic_model",
    "secondary_verdict_sha256",
    "content_sha256",
    "recomputed_content_sha256",
    "promoted_at",
    "withdrawn",
    "is_current",
    "immutable_controls_present",
  ] as const;
  hasOnlyKeys(value, keys, label, errors);
  if (
    !UUID_PATTERN.test(String(value.revision_id)) ||
    !isLevel(value.level) ||
    typeof value.topic_slug !== "string" ||
    !TOPIC_SLUG_PATTERN.test(value.topic_slug) ||
    !difficulties.includes(value.difficulty as Difficulty) ||
    !["deepseek", "gemini"].includes(String(value.generator_provider)) ||
    !MODEL_PATTERN.test(String(value.generator_model)) ||
    value.validation_profile !== "mcq_safe_v1" ||
    typeof value.deterministic_validation_passed !== "boolean" ||
    typeof value.independent_model_validation_passed !== "boolean" ||
    !UUID_PATTERN.test(String(value.source_practice_test_id)) ||
    !UUID_PATTERN.test(String(value.source_completion_job_id)) ||
    !SHA256_PATTERN.test(String(value.candidate_sha256)) ||
    value.primary_critic_provider !== "deepseek" ||
    !MODEL_PATTERN.test(String(value.primary_critic_model)) ||
    !SHA256_PATTERN.test(String(value.primary_verdict_sha256)) ||
    value.secondary_critic_provider !== "gemini" ||
    !MODEL_PATTERN.test(String(value.secondary_critic_model)) ||
    !SHA256_PATTERN.test(String(value.secondary_verdict_sha256)) ||
    !SHA256_PATTERN.test(String(value.content_sha256)) ||
    !isNullableSha256(value.recomputed_content_sha256) ||
    !isTimestamp(value.promoted_at) ||
    typeof value.withdrawn !== "boolean" ||
    typeof value.is_current !== "boolean" ||
    typeof value.immutable_controls_present !== "boolean"
  ) {
    errors.push(`${label} has an invalid content-free cache contract.`);
    return null;
  }
  if (!canonicalWorksheetTopicSet.has(value.topic_slug)) {
    errors.push(`${label} uses non-canonical topic ${value.topic_slug}.`);
    return null;
  }
  const row = {
    revision_id: String(value.revision_id),
    level: value.level,
    topic_slug: value.topic_slug,
    difficulty: value.difficulty as Difficulty,
    generator_provider: String(value.generator_provider),
    generator_model: String(value.generator_model),
    validation_profile: "mcq_safe_v1",
    deterministic_validation_passed: value.deterministic_validation_passed,
    independent_model_validation_passed:
      value.independent_model_validation_passed,
    source_practice_test_id: String(value.source_practice_test_id),
    source_completion_job_id: String(value.source_completion_job_id),
    candidate_sha256: String(value.candidate_sha256).toLowerCase(),
    primary_critic_provider: String(value.primary_critic_provider),
    primary_critic_model: String(value.primary_critic_model),
    primary_verdict_sha256: String(value.primary_verdict_sha256).toLowerCase(),
    secondary_critic_provider: String(value.secondary_critic_provider),
    secondary_critic_model: String(value.secondary_critic_model),
    secondary_verdict_sha256: String(
      value.secondary_verdict_sha256,
    ).toLowerCase(),
    content_sha256: String(value.content_sha256).toLowerCase(),
    recomputed_content_sha256:
      value.recomputed_content_sha256?.toLowerCase() ?? null,
    promoted_at: value.promoted_at,
    withdrawn: value.withdrawn,
    is_current: value.is_current,
    immutable_controls_present: value.immutable_controls_present,
  } satisfies ProductionModelValidatedWorksheetCacheRow;
  if (!modelCacheEvidenceIsCoherent(row)) {
    errors.push(
      `${label} lacks coherent independent validation, immutable controls, or content-hash evidence.`,
    );
  }
  return row;
}

function parseCanonicalBankRow(
  value: unknown,
  index: number,
  errors: string[],
): ProductionCanonicalWorksheetBankRow | null {
  const label = `Canonical worksheet revision ${index + 1}`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  const keys = [
    "revision_id",
    "template_id",
    "template_key",
    "level",
    "topic_slug",
    "state",
    "content_sha256",
    "recomputed_content_sha256",
    "review_id",
    "reviewer_id",
    "review_decision",
    "review_checklist_complete",
    "review_content_sha256",
    "reviewed_at",
    "reviewer_qualified",
    "bank_release_id",
    "release_review_id",
    "released_by",
    "release_content_sha256",
    "released_at",
    "releaser_qualified",
    "immutable_controls_present",
  ] as const;
  hasOnlyKeys(value, keys, label, errors);
  if (
    !UUID_PATTERN.test(String(value.revision_id)) ||
    !UUID_PATTERN.test(String(value.template_id)) ||
    typeof value.template_key !== "string" ||
    !canonicalWorksheetTemplateKeySet.has(value.template_key) ||
    !isLevel(value.level) ||
    typeof value.topic_slug !== "string" ||
    !TOPIC_SLUG_PATTERN.test(value.topic_slug) ||
    value.state !== "released" ||
    !SHA256_PATTERN.test(String(value.content_sha256)) ||
    !isNullableSha256(value.recomputed_content_sha256) ||
    !isNullableUuid(value.review_id) ||
    !isNullableUuid(value.reviewer_id) ||
    (value.review_decision !== null &&
      typeof value.review_decision !== "string") ||
    typeof value.review_checklist_complete !== "boolean" ||
    !isNullableSha256(value.review_content_sha256) ||
    !isNullableTimestamp(value.reviewed_at) ||
    typeof value.reviewer_qualified !== "boolean" ||
    !isNullableUuid(value.bank_release_id) ||
    !isNullableUuid(value.release_review_id) ||
    !isNullableUuid(value.released_by) ||
    !isNullableSha256(value.release_content_sha256) ||
    !isNullableTimestamp(value.released_at) ||
    typeof value.releaser_qualified !== "boolean" ||
    typeof value.immutable_controls_present !== "boolean"
  ) {
    errors.push(`${label} has an invalid content-free certification contract.`);
    return null;
  }
  if (!canonicalWorksheetTopicSet.has(value.topic_slug)) {
    errors.push(`${label} uses non-canonical topic ${value.topic_slug}.`);
    return null;
  }
  const templateContext = canonicalWorksheetContextByTemplateKey.get(
    value.template_key,
  );
  if (
    !templateContext ||
    templateContext.level !== value.level ||
    templateContext.topicSlug !== value.topic_slug
  ) {
    errors.push(`${label} template_key contradicts its CEFR/topic context.`);
    return null;
  }
  return {
    revision_id: String(value.revision_id),
    template_id: String(value.template_id),
    template_key: value.template_key,
    level: value.level,
    topic_slug: value.topic_slug,
    state: "released",
    content_sha256: String(value.content_sha256).toLowerCase(),
    recomputed_content_sha256:
      value.recomputed_content_sha256?.toLowerCase() ?? null,
    review_id: value.review_id,
    reviewer_id: value.reviewer_id,
    review_decision: value.review_decision,
    review_checklist_complete: value.review_checklist_complete,
    review_content_sha256: value.review_content_sha256?.toLowerCase() ?? null,
    reviewed_at: value.reviewed_at,
    reviewer_qualified: value.reviewer_qualified,
    bank_release_id: value.bank_release_id,
    release_review_id: value.release_review_id,
    released_by: value.released_by,
    release_content_sha256: value.release_content_sha256?.toLowerCase() ?? null,
    released_at: value.released_at,
    releaser_qualified: value.releaser_qualified,
    immutable_controls_present: value.immutable_controls_present,
  };
}

function parseEvidence(
  value: unknown,
  expectedRelease: string,
  expectedProjectRef: string,
  now: Date,
  errors: string[],
) {
  if (!isRecord(value)) {
    errors.push("Production worksheet inventory evidence must be an object.");
    return null;
  }
  hasOnlyKeys(
    value,
    [
      "schema_version",
      "hash_origin",
      "app_release",
      "project_ref",
      "collected_at",
      "rows",
      "canonical_bank",
      "model_validated_cache",
    ],
    "Production worksheet inventory evidence",
    errors,
  );
  if (
    value.schema_version !== 4 ||
    value.hash_origin !== "db_recomputed_v1" ||
    value.app_release !== expectedRelease ||
    value.project_ref !== expectedProjectRef ||
    !isTimestamp(value.collected_at) ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.canonical_bank) ||
    !Array.isArray(value.model_validated_cache)
  ) {
    errors.push(
      "Production worksheet inventory evidence has invalid release, project, time, or row context.",
    );
    return null;
  }
  const collectedAt = Date.parse(value.collected_at);
  const age = now.getTime() - collectedAt;
  if (age < 0 || age > MAX_EVIDENCE_AGE_MS) {
    errors.push(
      "Production worksheet inventory evidence is future-dated or stale.",
    );
  }
  return {
    rows: value.rows
      .map((row, index) => parseInventoryRow(row, index, errors))
      .filter((row): row is ProductionWorksheetInventoryRow => row !== null),
    canonicalBank: value.canonical_bank
      .map((row, index) => parseCanonicalBankRow(row, index, errors))
      .filter(
        (row): row is ProductionCanonicalWorksheetBankRow => row !== null,
      ),
    modelValidatedCache: value.model_validated_cache
      .map((row, index) => parseModelValidatedCacheRow(row, index, errors))
      .filter(
        (row): row is ProductionModelValidatedWorksheetCacheRow => row !== null,
      ),
  };
}

export function verifyProductionWorksheetInventory(
  approvalRows: unknown[],
  evidenceValue: unknown,
  expectedRelease: string,
  expectedProjectRef: string,
  now = new Date(),
): ProductionWorksheetInventoryReport {
  const errors: string[] = [];
  if (!RELEASE_PATTERN.test(expectedRelease))
    errors.push("Expected release id is invalid.");
  if (!PROJECT_REF_PATTERN.test(expectedProjectRef))
    errors.push("Expected project ref is invalid.");

  const approvals = approvalRows
    .map((row, index) =>
      parseApproval(row, index, expectedRelease, now, errors),
    )
    .filter((row): row is WorksheetApproval => row !== null);
  const evidence = parseEvidence(
    evidenceValue,
    expectedRelease,
    expectedProjectRef,
    now,
    errors,
  );
  const inventory = evidence?.rows ?? [];
  const canonicalBank = evidence?.canonicalBank ?? [];
  const modelValidatedCache = evidence?.modelValidatedCache ?? [];
  const approvalPerLevel = emptyLevelCounts();
  const approvalTopicCounts = Object.fromEntries(
    levels.map((level) => [
      level,
      new Map<string, number>(
        canonicalWorksheetTopics.map((topic) => [topic, 0]),
      ),
    ]),
  ) as Record<Level, Map<string, number>>;
  const approvalById = new Map<string, WorksheetApproval>();
  const approvalByTemplateKey = new Map<string, WorksheetApproval>();
  const approvalHashes = new Set<string>();
  for (const approval of approvals) {
    if (approvalById.has(approval.revision_id)) {
      errors.push(
        `Duplicate approved worksheet revision: ${approval.revision_id}.`,
      );
    }
    if (approvalHashes.has(approval.content_sha256)) {
      errors.push(
        `Duplicate approved worksheet content hash: ${approval.content_sha256}.`,
      );
    }
    if (approvalByTemplateKey.has(approval.template_key)) {
      errors.push(
        `Duplicate approved worksheet template_key: ${approval.template_key}.`,
      );
    }
    approvalById.set(approval.revision_id, approval);
    approvalByTemplateKey.set(approval.template_key, approval);
    approvalHashes.add(approval.content_sha256);
    approvalPerLevel[approval.level] += 1;
    approvalTopicCounts[approval.level].set(
      approval.topic_slug,
      (approvalTopicCounts[approval.level].get(approval.topic_slug) ?? 0) + 1,
    );
  }
  for (const level of levels) {
    if (approvalPerLevel[level] !== REQUIRED_CANONICAL_BANK_PER_LEVEL) {
      errors.push(
        `Qualified worksheet manifest ${level} has ${approvalPerLevel[level]}/${REQUIRED_CANONICAL_BANK_PER_LEVEL} revisions.`,
      );
    }
    for (const topic of canonicalWorksheetTopics) {
      const expected = secondRevisionTopicsByLevel[level].includes(topic)
        ? 2
        : 1;
      const actual = approvalTopicCounts[level].get(topic) ?? 0;
      if (actual !== expected) {
        errors.push(
          `Qualified worksheet manifest ${level}:${topic} has ${actual}/${expected} required revisions.`,
        );
      }
    }
  }
  if (approvals.length !== REQUIRED_CANONICAL_BANK_TOTAL) {
    errors.push(
      `Qualified worksheet manifest has ${approvals.length}/${REQUIRED_CANONICAL_BANK_TOTAL} canonical revisions.`,
    );
  }
  for (const templateKey of canonicalWorksheetTemplateKeys) {
    if (!approvalByTemplateKey.has(templateKey)) {
      errors.push(
        `Qualified worksheet manifest is missing canonical template_key ${templateKey}.`,
      );
    }
  }

  const canonicalById = new Map<string, ProductionCanonicalWorksheetBankRow>();
  const canonicalByTemplateKey = new Map<
    string,
    ProductionCanonicalWorksheetBankRow
  >();
  const canonicalByHash = new Map<
    string,
    ProductionCanonicalWorksheetBankRow
  >();
  const canonicalReviewIds = new Set<string>();
  const canonicalReleaseIds = new Set<string>();
  const canonicalPerLevel = emptyLevelCounts();
  const canonicalTopics = Object.fromEntries(
    levels.map((level) => [level, new Set<string>()]),
  ) as Record<Level, Set<string>>;
  const canonicalTopicCounts = Object.fromEntries(
    levels.map((level) => [
      level,
      new Map<string, number>(
        canonicalWorksheetTopics.map((topic) => [topic, 0]),
      ),
    ]),
  ) as Record<Level, Map<string, number>>;

  for (const row of canonicalBank) {
    if (canonicalById.has(row.revision_id)) {
      errors.push(
        `Duplicate canonical worksheet revision: ${row.revision_id}.`,
      );
      continue;
    }
    if (canonicalByHash.has(row.content_sha256)) {
      errors.push(
        `Duplicate canonical worksheet content hash: ${row.content_sha256}.`,
      );
    }
    if (canonicalByTemplateKey.has(row.template_key)) {
      errors.push(
        `Duplicate canonical worksheet template_key: ${row.template_key}.`,
      );
    }
    canonicalById.set(row.revision_id, row);
    canonicalByTemplateKey.set(row.template_key, row);
    canonicalByHash.set(row.content_sha256, row);
    canonicalPerLevel[row.level] += 1;
    canonicalTopics[row.level].add(row.topic_slug);
    canonicalTopicCounts[row.level].set(
      row.topic_slug,
      (canonicalTopicCounts[row.level].get(row.topic_slug) ?? 0) + 1,
    );

    if (row.review_id && canonicalReviewIds.has(row.review_id)) {
      errors.push(`Duplicate canonical worksheet review: ${row.review_id}.`);
    }
    if (row.review_id) canonicalReviewIds.add(row.review_id);
    if (row.bank_release_id && canonicalReleaseIds.has(row.bank_release_id)) {
      errors.push(
        `Duplicate canonical worksheet release: ${row.bank_release_id}.`,
      );
    }
    if (row.bank_release_id) canonicalReleaseIds.add(row.bank_release_id);

    const hashChainMatches =
      row.recomputed_content_sha256 === row.content_sha256 &&
      row.review_content_sha256 === row.content_sha256 &&
      row.release_content_sha256 === row.content_sha256;
    const reviewAndReleaseMatch =
      row.review_id !== null &&
      row.reviewer_id !== null &&
      row.review_decision === "approved" &&
      row.review_checklist_complete &&
      row.reviewed_at !== null &&
      row.reviewer_qualified &&
      row.bank_release_id !== null &&
      row.release_review_id === row.review_id &&
      row.released_by !== null &&
      row.released_at !== null &&
      row.releaser_qualified &&
      Date.parse(row.reviewed_at ?? "") <= Date.parse(row.released_at ?? "");
    if (
      !hashChainMatches ||
      !reviewAndReleaseMatch ||
      !row.immutable_controls_present
    ) {
      errors.push(
        `Canonical worksheet ${row.revision_id} lacks coherent immutable qualified review, release, or hash evidence.`,
      );
    }

    const approval = approvalById.get(row.revision_id);
    if (
      !approval ||
      approval.template_key !== row.template_key ||
      approval.level !== row.level ||
      approval.topic_slug !== row.topic_slug ||
      approval.content_sha256 !== row.content_sha256
    ) {
      errors.push(
        `Canonical worksheet ${row.revision_id} does not exactly match its qualified launch approval.`,
      );
    }
  }

  if (canonicalBank.length !== REQUIRED_CANONICAL_BANK_TOTAL) {
    errors.push(
      `Released canonical worksheet bank has ${canonicalBank.length}/${REQUIRED_CANONICAL_BANK_TOTAL} revisions.`,
    );
  }
  for (const templateKey of canonicalWorksheetTemplateKeys) {
    if (!canonicalByTemplateKey.has(templateKey)) {
      errors.push(
        `Released canonical worksheet bank is missing template_key ${templateKey}.`,
      );
    }
  }
  for (const level of levels) {
    if (canonicalPerLevel[level] !== REQUIRED_CANONICAL_BANK_PER_LEVEL) {
      errors.push(
        `Released canonical worksheet bank ${level} has ${canonicalPerLevel[level]}/${REQUIRED_CANONICAL_BANK_PER_LEVEL} revisions.`,
      );
    }
    if (canonicalTopics[level].size !== REQUIRED_DISTINCT_TOPICS_PER_LEVEL) {
      errors.push(
        `Released canonical worksheet bank ${level} covers ${canonicalTopics[level].size}/${REQUIRED_DISTINCT_TOPICS_PER_LEVEL} distinct topics.`,
      );
    }
    for (const topic of canonicalWorksheetTopics) {
      const expected = secondRevisionTopicsByLevel[level].includes(topic)
        ? 2
        : 1;
      const actual = canonicalTopicCounts[level].get(topic) ?? 0;
      if (actual !== expected) {
        errors.push(
          `Released canonical worksheet bank ${level}:${topic} has ${actual}/${expected} required revisions.`,
        );
      }
    }
  }

  for (const approval of approvals) {
    if (!canonicalById.has(approval.revision_id)) {
      errors.push(
        `Approved canonical worksheet ${approval.revision_id} is absent from production bank evidence.`,
      );
    }
  }

  const modelCacheById = new Map<
    string,
    ProductionModelValidatedWorksheetCacheRow
  >();
  const modelCacheByContentHash = new Map<
    string,
    ProductionModelValidatedWorksheetCacheRow
  >();
  const modelCacheSourceIds = new Set<string>();
  let activeModelCache = 0;
  let withdrawnModelCache = 0;
  let invalidModelCache = 0;
  for (const row of modelValidatedCache) {
    if (modelCacheById.has(row.revision_id)) {
      errors.push(
        `Duplicate model-validated worksheet cache revision: ${row.revision_id}.`,
      );
      continue;
    }
    if (modelCacheByContentHash.has(row.content_sha256)) {
      errors.push(
        `Duplicate model-validated worksheet cache content hash: ${row.content_sha256}.`,
      );
    }
    if (modelCacheSourceIds.has(row.source_practice_test_id)) {
      errors.push(
        `Duplicate model-validated worksheet cache source revision: ${row.source_practice_test_id}.`,
      );
    }
    modelCacheById.set(row.revision_id, row);
    modelCacheByContentHash.set(row.content_sha256, row);
    modelCacheSourceIds.add(row.source_practice_test_id);
    if (row.withdrawn) withdrawnModelCache += 1;
    else if (modelCacheEvidenceIsCoherent(row)) activeModelCache += 1;
    else invalidModelCache += 1;
    if (Date.parse(row.promoted_at) > now.getTime()) {
      errors.push(
        `Model-validated worksheet cache revision ${row.revision_id} is future-dated.`,
      );
    }
  }

  const inventoryById = new Map<string, ProductionWorksheetInventoryRow>();
  let humanReusable = 0;
  let certifiedClones = 0;
  let systemReusable = 0;
  let modelValidatedCacheClones = 0;
  let teacherReviewedGenerated = 0;
  let quarantined = 0;
  let retired = 0;
  let historicalOnly = 0;
  let unresolved = 0;

  for (const row of inventory) {
    if (inventoryById.has(row.revision_id)) {
      errors.push(
        `Duplicate production worksheet revision: ${row.revision_id}.`,
      );
      continue;
    }
    inventoryById.set(row.revision_id, row);
    if (row.disposition === "quarantined") quarantined += 1;
    if (row.disposition === "retired") retired += 1;
    if (row.disposition === "historical_only") historicalOnly += 1;
    if (row.disposition === "unresolved") {
      unresolved += 1;
      errors.push(
        `Production worksheet ${row.revision_id} has no safe disposition.`,
      );
    }

    if (
      row.teacher_reviewed &&
      (!row.reviewed_by_present || !row.reviewed_at_present)
    ) {
      errors.push(
        `Production worksheet ${row.revision_id} has incomplete reviewer provenance.`,
      );
    }
    const isHumanBank =
      !row.created_by_ai &&
      ["manual_import", "teacher_created"].includes(row.generation_source);
    const cacheRevision = row.worksheet_model_cache_revision_id
      ? modelCacheById.get(row.worksheet_model_cache_revision_id)
      : undefined;
    if (
      row.worksheet_model_cache_revision_id !== null &&
      (!cacheRevision ||
        row.model_cache_content_sha256 !== cacheRevision.content_sha256 ||
        row.content_sha256 !== cacheRevision.content_sha256 ||
        row.level !== cacheRevision.level ||
        row.generation_source !== cacheRevision.generator_provider ||
        row.generator_model !== cacheRevision.generator_model)
    ) {
      errors.push(
        `Model-validated cache clone ${row.revision_id} does not reconcile to its immutable cache revision.`,
      );
    }

    if (
      row.disposition === "reusable" &&
      row.worksheet_model_cache_revision_id !== null
    ) {
      modelValidatedCacheClones += 1;
      if (
        !cacheRevision ||
        !modelCacheEvidenceIsCoherent(cacheRevision) ||
        cacheRevision.withdrawn ||
        !row.created_by_ai ||
        row.teacher_reviewed ||
        row.reviewed_by_present ||
        row.reviewed_at_present ||
        !row.system_validation_passed ||
        row.approval_source !== "independent_model_validation" ||
        row.generation_source === "certified_bank"
      ) {
        errors.push(
          `Model-validated cache clone ${row.revision_id} is not a truthful active unreviewed model-cache copy.`,
        );
      }
    } else if (
      row.disposition === "reusable" &&
      !row.created_by_ai &&
      row.generation_source === "certified_bank"
    ) {
      certifiedClones += 1;
      const canonical = canonicalByHash.get(row.content_sha256);
      if (
        row.approval_source !== "certified_template_bank" ||
        !row.teacher_reviewed ||
        !row.reviewed_by_present ||
        !row.reviewed_at_present ||
        !canonical ||
        canonical.level !== row.level
      ) {
        errors.push(
          `Certified worksheet clone ${row.revision_id} does not reconcile to the released canonical bank.`,
        );
      }
    } else if (row.disposition === "reusable" && isHumanBank) {
      humanReusable += 1;
      errors.push(
        `Reusable workspace worksheet ${row.revision_id} is outside the certified canonical bank path.`,
      );
    } else if (row.disposition === "reusable" && row.created_by_ai) {
      if (!["deepseek", "gemini"].includes(row.generation_source)) {
        errors.push(
          `Reusable generated worksheet ${row.revision_id} has an unsupported source.`,
        );
      } else if (row.system_validation_passed) {
        systemReusable += 1;
      } else if (
        row.teacher_reviewed &&
        row.reviewed_by_present &&
        row.reviewed_at_present
      ) {
        teacherReviewedGenerated += 1;
      } else {
        errors.push(
          `Reusable generated worksheet ${row.revision_id} has neither independent validation nor teacher approval.`,
        );
      }
    } else if (row.disposition === "reusable") {
      errors.push(
        `Reusable legacy worksheet ${row.revision_id} is outside an approved content path.`,
      );
    }
  }

  const topicsPerLevel = Object.fromEntries(
    levels.map((level) => [level, [...canonicalTopics[level]].sort()]),
  ) as Record<Level, string[]>;
  const distinctTopicCountPerLevel = Object.fromEntries(
    levels.map((level) => [level, topicsPerLevel[level].length]),
  ) as Record<Level, number>;

  return {
    ok: errors.length === 0,
    errors,
    app_release: expectedRelease,
    project_ref: expectedProjectRef,
    approved_manifest_total: approvals.length,
    approved_manifest_template_key_total: approvalByTemplateKey.size,
    approved_manifest_per_level: approvalPerLevel,
    canonical_bank_total: canonicalBank.length,
    canonical_bank_template_key_total: canonicalByTemplateKey.size,
    canonical_bank_per_level: canonicalPerLevel,
    canonical_bank_distinct_topic_count_per_level: distinctTopicCountPerLevel,
    canonical_bank_topics_per_level: topicsPerLevel,
    production_total: inventory.length,
    human_reusable_total: humanReusable,
    certified_clone_total: certifiedClones,
    system_validated_reusable_total: systemReusable,
    model_validated_cache_total: modelValidatedCache.length,
    model_validated_cache_active_total: activeModelCache,
    model_validated_cache_withdrawn_total: withdrawnModelCache,
    model_validated_cache_invalid_total: invalidModelCache,
    model_validated_cache_clone_total: modelValidatedCacheClones,
    teacher_reviewed_generated_total: teacherReviewedGenerated,
    quarantined_total: quarantined,
    retired_total: retired,
    historical_only_total: historicalOnly,
    unresolved_total: unresolved,
  };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const approvalsPath = argument("--approvals");
  const inventoryPath = argument("--inventory");
  const release = argument("--release");
  const projectRef = argument("--project-ref");
  const reportOutput = argument("--report-output");
  if (!approvalsPath || !inventoryPath || !release || !projectRef) {
    throw new Error(
      "Usage: worksheet-inventory:verify -- --release <release> --project-ref <ref> --approvals <approved-revisions.jsonl> --inventory <production-inventory.json> [--report-output <report.json>]",
    );
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const workspacePath = (path: string) =>
    isAbsolute(path) ? path : resolve(root, path);
  const [approvalSource, inventorySource] = await Promise.all([
    readFile(workspacePath(approvalsPath), "utf8"),
    readFile(workspacePath(inventoryPath), "utf8"),
  ]);
  const report = verifyProductionWorksheetInventory(
    parseJsonLines(approvalSource, "Worksheet approvals"),
    JSON.parse(inventorySource) as unknown,
    release,
    projectRef,
  );
  if (reportOutput) {
    await writeFile(
      workspacePath(reportOutput),
      `${JSON.stringify(report, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Worksheet inventory verification failed."}\n`,
    );
    process.exitCode = 1;
  });
}
