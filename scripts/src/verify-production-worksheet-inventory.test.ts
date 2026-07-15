import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  collectProductionWorksheetInventory,
  PRODUCTION_WORKSHEET_INVENTORY_QUERY,
  sanitizeCollectedCanonicalBankRows,
  sanitizeCollectedModelValidatedCacheRows,
  sanitizeCollectedWorksheetRows,
} from "./collect-production-worksheet-inventory.js";
import {
  verifyProductionWorksheetInventory,
  type ProductionCanonicalWorksheetBankRow,
  type ProductionModelValidatedWorksheetCacheRow,
  type ProductionWorksheetInventoryEvidence,
  type ProductionWorksheetInventoryRow,
} from "./verify-production-worksheet-inventory.js";
import {
  canonicalWorksheetTemplateKey,
  canonicalWorksheetTopics,
  secondRevisionTopicsByLevel,
} from "./verify-worksheet-authoring-matrix.js";

const RELEASE = "release-2026-07-11";
const PROJECT_REF = "abcde1ghijklmnopqrst";
const NOW = new Date("2026-07-11T18:00:00.000Z");
const COLLECTED_AT = "2026-07-11T17:00:00.000Z";
const levels = ["A1", "A2", "B1", "B2"] as const;
const worksheetContexts: Array<{
  level: (typeof levels)[number];
  topic_slug: string;
  revision: 1 | 2;
}> = levels.flatMap((level) =>
  canonicalWorksheetTopics.flatMap((topic) => {
    const revisions: readonly (1 | 2)[] = secondRevisionTopicsByLevel[
      level
    ].includes(topic)
      ? [1, 2]
      : [1];
    return revisions.map((revision) => ({
      level,
      topic_slug: topic,
      revision,
    }));
  }),
);

function worksheetContext(index: number) {
  return (
    worksheetContexts[index - 1] ?? {
      level: "B2" as const,
      topic_slug: "task-fulfilment",
      revision: 2,
    }
  );
}

function uuid(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function hash(index: number) {
  return index.toString(16).padStart(64, "0");
}

function approval(index: number) {
  const context = worksheetContext(index);
  return {
    revision_id: uuid(index),
    template_key: canonicalWorksheetTemplateKey(
      context.level,
      context.topic_slug,
      context.revision,
    ),
    release_id: RELEASE,
    level: context.level,
    topic_slug: String(context.topic_slug),
    content_sha256: hash(index),
    status: "approved",
    checks: {
      structural_valid: true,
      ambiguity_free: true,
      no_answer_leakage: true,
      level_fit: true,
      topic_fit: true,
      type_balance: true,
      scoring_safe: true,
    },
    reviewer: {
      reviewer_id: "qualified-reviewer-2026",
      qualification: "Qualified German language educator",
      reviewed_at: "2026-07-10T12:00:00.000Z",
    },
  };
}

function canonicalBankRow(
  index: number,
  overrides: Partial<ProductionCanonicalWorksheetBankRow> = {},
): ProductionCanonicalWorksheetBankRow {
  const context = worksheetContext(index);
  return {
    revision_id: uuid(index),
    template_id: uuid(1_000 + index),
    template_key: canonicalWorksheetTemplateKey(
      context.level,
      context.topic_slug,
      context.revision,
    ),
    level: context.level,
    topic_slug: context.topic_slug,
    state: "released",
    content_sha256: hash(index),
    recomputed_content_sha256: hash(index),
    review_id: uuid(2_000 + index),
    reviewer_id: uuid(9_001),
    review_decision: "approved",
    review_checklist_complete: true,
    review_content_sha256: hash(index),
    reviewed_at: "2026-07-10T12:00:00.000Z",
    reviewer_qualified: true,
    bank_release_id: uuid(3_000 + index),
    release_review_id: uuid(2_000 + index),
    released_by: uuid(9_002),
    release_content_sha256: hash(index),
    released_at: "2026-07-10T12:05:00.000Z",
    releaser_qualified: true,
    immutable_controls_present: true,
    ...overrides,
  };
}

function inventoryRow(
  index: number,
  overrides: Partial<ProductionWorksheetInventoryRow> = {},
): ProductionWorksheetInventoryRow {
  const level = worksheetContext(index).level;
  return {
    revision_id: uuid(index),
    level,
    generation_source: "manual_import",
    generator_model: null,
    approval_source: "teacher_review",
    created_by_ai: false,
    teacher_reviewed: true,
    visibility: "workspace",
    quality_status: "approved",
    content_sha256: hash(index),
    answer_contract_v1: true,
    has_student_use: false,
    system_validation_passed: false,
    reviewed_by_present: true,
    reviewed_at_present: true,
    worksheet_model_cache_revision_id: null,
    model_cache_content_sha256: null,
    disposition: "reusable",
    ...overrides,
  };
}

function modelValidatedCacheRow(
  index: number,
  overrides: Partial<ProductionModelValidatedWorksheetCacheRow> = {},
): ProductionModelValidatedWorksheetCacheRow {
  const context = worksheetContext(index);
  return {
    revision_id: uuid(5_000 + index),
    level: context.level,
    topic_slug: context.topic_slug,
    difficulty: "medium",
    generator_provider: "deepseek",
    generator_model: "deepseek-v4-pro",
    validation_profile: "mcq_safe_v1",
    deterministic_validation_passed: true,
    independent_model_validation_passed: true,
    source_practice_test_id: uuid(7_000 + index),
    source_completion_job_id: uuid(8_000 + index),
    candidate_sha256: hash(5_000 + index),
    primary_critic_provider: "deepseek",
    primary_critic_model: "deepseek-v4-flash",
    primary_verdict_sha256: hash(6_000 + index),
    secondary_critic_provider: "gemini",
    secondary_critic_model: "gemini-3.1-flash-lite",
    secondary_verdict_sha256: hash(7_000 + index),
    content_sha256: hash(8_000 + index),
    recomputed_content_sha256: hash(8_000 + index),
    promoted_at: "2026-07-11T16:00:00.000Z",
    withdrawn: false,
    is_current: true,
    immutable_controls_present: true,
    ...overrides,
  };
}

function validEvidence(): {
  approvals: ReturnType<typeof approval>[];
  evidence: ProductionWorksheetInventoryEvidence;
} {
  const approvals = Array.from({ length: 184 }, (_, index) =>
    approval(index + 1),
  );
  const canonicalBank = Array.from({ length: 184 }, (_, index) =>
    canonicalBankRow(index + 1),
  );
  const modelValidatedCache = [modelValidatedCacheRow(1)];
  const rows = [
    inventoryRow(81, {
      generation_source: "deepseek",
      generator_model: "deepseek-v4-pro",
      approval_source: "independent_model_validation",
      created_by_ai: true,
      teacher_reviewed: false,
      system_validation_passed: true,
    }),
    inventoryRow(82, {
      generation_source: "deepseek",
      generator_model: "deepseek-v4-pro",
      approval_source: null,
      created_by_ai: true,
      teacher_reviewed: false,
      visibility: "private",
      quality_status: "needs_review",
      answer_contract_v1: true,
      system_validation_passed: false,
      reviewed_by_present: false,
      reviewed_at_present: false,
      disposition: "quarantined",
    }),
    inventoryRow(83, {
      generation_source: "legacy_import",
      approval_source: null,
      created_by_ai: false,
      teacher_reviewed: false,
      visibility: "private",
      quality_status: "approved",
      answer_contract_v1: false,
      has_student_use: true,
      reviewed_by_present: false,
      reviewed_at_present: false,
      disposition: "historical_only",
    }),
    inventoryRow(84, {
      generation_source: "deepseek",
      generator_model: "deepseek-v4-pro",
      created_by_ai: true,
      teacher_reviewed: true,
      system_validation_passed: false,
      reviewed_by_present: true,
      reviewed_at_present: true,
    }),
    inventoryRow(85, {
      generation_source: "gemini",
      generator_model: "gemini-3.1-flash-lite",
      approval_source: "independent_model_validation",
      created_by_ai: true,
      teacher_reviewed: false,
      system_validation_passed: true,
      reviewed_by_present: false,
      reviewed_at_present: false,
    }),
    inventoryRow(86, {
      level: "A1",
      generation_source: "certified_bank",
      approval_source: "certified_template_bank",
      created_by_ai: false,
      teacher_reviewed: true,
      content_sha256: hash(1),
      system_validation_passed: false,
    }),
    inventoryRow(87, {
      level: modelValidatedCache[0].level,
      generation_source: modelValidatedCache[0].generator_provider,
      generator_model: modelValidatedCache[0].generator_model,
      approval_source: "independent_model_validation",
      created_by_ai: true,
      teacher_reviewed: false,
      content_sha256: modelValidatedCache[0].content_sha256,
      system_validation_passed: true,
      reviewed_by_present: false,
      reviewed_at_present: false,
      worksheet_model_cache_revision_id: modelValidatedCache[0].revision_id,
      model_cache_content_sha256: modelValidatedCache[0].content_sha256,
    }),
  ];
  return {
    approvals,
    evidence: {
      schema_version: 4,
      hash_origin: "db_recomputed_v1",
      app_release: RELEASE,
      project_ref: PROJECT_REF,
      collected_at: COLLECTED_AT,
      rows,
      canonical_bank: canonicalBank,
      model_validated_cache: modelValidatedCache,
    },
  };
}

test("passes only when all 184 qualified level/topic revisions exactly match production", () => {
  const { approvals, evidence } = validEvidence();
  const report = verifyProductionWorksheetInventory(
    approvals,
    evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );

  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.approved_manifest_total, 184);
  assert.equal(report.approved_manifest_template_key_total, 184);
  assert.deepEqual(report.approved_manifest_per_level, {
    A1: 46,
    A2: 46,
    B1: 46,
    B2: 46,
  });
  assert.equal(report.canonical_bank_total, 184);
  assert.equal(report.canonical_bank_template_key_total, 184);
  assert.deepEqual(report.canonical_bank_per_level, {
    A1: 46,
    A2: 46,
    B1: 46,
    B2: 46,
  });
  assert.deepEqual(report.canonical_bank_distinct_topic_count_per_level, {
    A1: 36,
    A2: 36,
    B1: 36,
    B2: 36,
  });
  assert.equal(report.human_reusable_total, 0);
  assert.equal(report.certified_clone_total, 1);
  assert.equal(report.system_validated_reusable_total, 2);
  assert.equal(report.model_validated_cache_total, 1);
  assert.equal(report.model_validated_cache_active_total, 1);
  assert.equal(report.model_validated_cache_withdrawn_total, 0);
  assert.equal(report.model_validated_cache_invalid_total, 0);
  assert.equal(report.model_validated_cache_clone_total, 1);
  assert.equal(report.teacher_reviewed_generated_total, 1);
  assert.equal(report.quarantined_total, 1);
  assert.equal(report.historical_only_total, 1);
});

test("rejects a missing, changed, or extra released canonical revision", () => {
  const missing = validEvidence();
  missing.evidence.canonical_bank = missing.evidence.canonical_bank.filter(
    (row) => row.revision_id !== uuid(1),
  );
  const missingReport = verifyProductionWorksheetInventory(
    missing.approvals,
    missing.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(missingReport.ok, false);
  assert(
    missingReport.errors.some((error) =>
      error.includes("absent from production bank evidence"),
    ),
  );

  const changed = validEvidence();
  changed.evidence.canonical_bank[0].content_sha256 = hash(999);
  const changedReport = verifyProductionWorksheetInventory(
    changed.approvals,
    changed.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(changedReport.ok, false);
  assert(
    changedReport.errors.some((error) =>
      error.includes("does not exactly match"),
    ),
  );

  const extra = validEvidence();
  extra.evidence.canonical_bank.push(canonicalBankRow(190));
  const extraReport = verifyProductionWorksheetInventory(
    extra.approvals,
    extra.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(extraReport.ok, false);
  assert(extraReport.errors.some((error) => error.includes("185/184")));
});

test("rejects broken qualification, immutable controls, release links, or hash chains", () => {
  const mutations: Array<(row: ProductionCanonicalWorksheetBankRow) => void> = [
    (row) => {
      row.reviewer_qualified = false;
    },
    (row) => {
      row.releaser_qualified = false;
    },
    (row) => {
      row.immutable_controls_present = false;
    },
    (row) => {
      row.release_review_id = uuid(8_888);
    },
    (row) => {
      row.review_content_sha256 = hash(999);
    },
    (row) => {
      row.release_content_sha256 = hash(999);
    },
    (row) => {
      row.recomputed_content_sha256 = hash(999);
    },
  ];

  for (const mutate of mutations) {
    const { approvals, evidence } = validEvidence();
    mutate(evidence.canonical_bank[0]);
    const report = verifyProductionWorksheetInventory(
      approvals,
      evidence,
      RELEASE,
      PROJECT_REF,
      NOW,
    );
    assert.equal(report.ok, false);
    assert(
      report.errors.some((error) => error.includes("lacks coherent immutable")),
      report.errors.join("\n"),
    );
  }
});

test("requires exact per-level counts and approval topic reconciliation", () => {
  const shifted = validEvidence();
  shifted.evidence.canonical_bank[0].level = "A2";
  shifted.evidence.canonical_bank[0].template_key = "v1-a2-articles-r1";
  const shiftedReport = verifyProductionWorksheetInventory(
    shifted.approvals,
    shifted.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(shiftedReport.ok, false);
  assert(shiftedReport.errors.some((error) => error.includes("A1 has 45/46")));
  assert(shiftedReport.errors.some((error) => error.includes("A2 has 47/46")));

  const topicMismatch = validEvidence();
  topicMismatch.approvals[0].topic_slug = "different-topic";
  const topicReport = verifyProductionWorksheetInventory(
    topicMismatch.approvals,
    topicMismatch.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(topicReport.ok, false);
  assert(
    topicReport.errors.some((error) =>
      error.includes("does not exactly match"),
    ),
  );

  const narrowCoverage = validEvidence();
  const missingSpelling = narrowCoverage.evidence.canonical_bank.find(
    (row) => row.level === "A1" && row.topic_slug === "spelling",
  );
  assert(missingSpelling);
  missingSpelling.topic_slug = "articles";
  const matchingApproval = narrowCoverage.approvals.find(
    (approval) => approval.revision_id === missingSpelling.revision_id,
  );
  assert(matchingApproval);
  matchingApproval.topic_slug = missingSpelling.topic_slug;
  const narrowReport = verifyProductionWorksheetInventory(
    narrowCoverage.approvals,
    narrowCoverage.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(narrowReport.ok, false);
  assert(narrowReport.errors.some((error) => error.includes("covers 35/36")));
  assert(
    narrowReport.errors.some((error) =>
      error.includes("A1:spelling has 0/1 required revisions"),
    ),
  );
});

test("requires every exact canonical template_key in approvals and production", () => {
  const duplicateApproval = validEvidence();
  duplicateApproval.approvals[1].template_key =
    duplicateApproval.approvals[0].template_key;
  const duplicateApprovalReport = verifyProductionWorksheetInventory(
    duplicateApproval.approvals,
    duplicateApproval.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(duplicateApprovalReport.ok, false);
  assert(
    duplicateApprovalReport.errors.some((error) =>
      error.includes("Duplicate approved worksheet template_key"),
    ),
  );
  assert(
    duplicateApprovalReport.errors.some((error) =>
      error.includes("missing canonical template_key v1-a1-articles-r2"),
    ),
  );

  const duplicateProduction = validEvidence();
  duplicateProduction.evidence.canonical_bank[1].template_key =
    duplicateProduction.evidence.canonical_bank[0].template_key;
  const duplicateProductionReport = verifyProductionWorksheetInventory(
    duplicateProduction.approvals,
    duplicateProduction.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(duplicateProductionReport.ok, false);
  assert(
    duplicateProductionReport.errors.some((error) =>
      error.includes("Duplicate canonical worksheet template_key"),
    ),
  );
  assert(
    duplicateProductionReport.errors.some((error) =>
      error.includes(
        "Released canonical worksheet bank is missing template_key v1-a1-articles-r2",
      ),
    ),
  );
});

test("rejects a template_key whose level or topic context contradicts the row", () => {
  const { approvals, evidence } = validEvidence();
  approvals[0].template_key = "v1-a2-articles-r1";
  evidence.canonical_bank[0].template_key = "v1-a2-articles-r1";
  const report = verifyProductionWorksheetInventory(
    approvals,
    evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(report.ok, false);
  assert(
    report.errors.some((error) =>
      error.includes("template_key contradicts its CEFR/topic context"),
    ),
  );
});

test("keeps automatic system validation separate from human approval", () => {
  const { approvals, evidence } = validEvidence();
  evidence.canonical_bank[0].reviewer_qualified = false;
  const report = verifyProductionWorksheetInventory(
    approvals,
    evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );

  assert.equal(report.ok, false);
  assert.equal(report.system_validated_reusable_total, 2);
  assert(
    report.errors.some((error) => error.includes("lacks coherent immutable")),
  );
});

test("counts model-validated cache copies separately from human-certified copies", () => {
  const valid = validEvidence();
  const validReport = verifyProductionWorksheetInventory(
    valid.approvals,
    valid.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(validReport.ok, true, validReport.errors.join("\n"));
  assert.equal(validReport.canonical_bank_total, 184);
  assert.equal(validReport.certified_clone_total, 1);
  assert.equal(validReport.model_validated_cache_total, 1);
  assert.equal(validReport.model_validated_cache_clone_total, 1);
  assert.equal(validReport.system_validated_reusable_total, 2);

  const mislabeled = validEvidence();
  const cacheClone = mislabeled.evidence.rows.find(
    (row) => row.worksheet_model_cache_revision_id !== null,
  );
  assert(cacheClone);
  cacheClone.generation_source = "certified_bank";
  cacheClone.created_by_ai = false;
  cacheClone.teacher_reviewed = true;
  cacheClone.reviewed_by_present = true;
  cacheClone.reviewed_at_present = true;
  const mislabeledReport = verifyProductionWorksheetInventory(
    mislabeled.approvals,
    mislabeled.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(mislabeledReport.ok, false);
  assert.equal(mislabeledReport.certified_clone_total, 1);
  assert.equal(mislabeledReport.model_validated_cache_clone_total, 1);
  assert(
    mislabeledReport.errors.some((error) =>
      error.includes("truthful active unreviewed model-cache copy"),
    ),
  );
});

test("rejects withdrawn, mismatched, or weak model-cache evidence", () => {
  const withdrawn = validEvidence();
  withdrawn.evidence.model_validated_cache[0].withdrawn = true;
  withdrawn.evidence.model_validated_cache[0].is_current = false;
  const withdrawnReport = verifyProductionWorksheetInventory(
    withdrawn.approvals,
    withdrawn.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(withdrawnReport.ok, false);
  assert.equal(withdrawnReport.model_validated_cache_active_total, 0);
  assert.equal(withdrawnReport.model_validated_cache_withdrawn_total, 1);
  assert(
    withdrawnReport.errors.some((error) =>
      error.includes("truthful active unreviewed model-cache copy"),
    ),
  );

  const mismatched = validEvidence();
  const mismatchedClone = mismatched.evidence.rows.find(
    (row) => row.worksheet_model_cache_revision_id !== null,
  );
  assert(mismatchedClone);
  mismatchedClone.model_cache_content_sha256 = hash(9_999);
  const mismatchedReport = verifyProductionWorksheetInventory(
    mismatched.approvals,
    mismatched.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(mismatchedReport.ok, false);
  assert(
    mismatchedReport.errors.some((error) =>
      error.includes("does not reconcile to its immutable cache revision"),
    ),
  );

  const weak = validEvidence();
  weak.evidence.model_validated_cache[0].independent_model_validation_passed = false;
  const weakReport = verifyProductionWorksheetInventory(
    weak.approvals,
    weak.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(weakReport.ok, false);
  assert.equal(weakReport.model_validated_cache_active_total, 0);
  assert.equal(weakReport.model_validated_cache_invalid_total, 1);
  assert(
    weakReport.errors.some((error) =>
      error.includes("lacks coherent independent validation"),
    ),
  );
});

test("rejects generated or legacy reusable content without a safe approval path", () => {
  const generated = validEvidence();
  const generatedRow = generated.evidence.rows.find(
    (row) => row.revision_id === uuid(81),
  );
  assert(generatedRow);
  generatedRow.system_validation_passed = false;
  const generatedReport = verifyProductionWorksheetInventory(
    generated.approvals,
    generated.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(generatedReport.ok, false);
  assert(
    generatedReport.errors.some((error) =>
      error.includes("neither independent validation"),
    ),
  );

  const legacy = validEvidence();
  legacy.evidence.rows.push(
    inventoryRow(91, {
      generation_source: "legacy_import",
      teacher_reviewed: false,
      reviewed_by_present: false,
      reviewed_at_present: false,
    }),
  );
  const legacyReport = verifyProductionWorksheetInventory(
    legacy.approvals,
    legacy.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(legacyReport.ok, false);
  assert(
    legacyReport.errors.some((error) =>
      error.includes("outside an approved content path"),
    ),
  );
});

test("rejects unresolved dispositions and stale or mismatched evidence", () => {
  const unresolved = validEvidence();
  unresolved.evidence.rows.push(
    inventoryRow(92, {
      visibility: "private",
      quality_status: "draft",
      teacher_reviewed: false,
      reviewed_by_present: false,
      reviewed_at_present: false,
      disposition: "unresolved",
    }),
  );
  const unresolvedReport = verifyProductionWorksheetInventory(
    unresolved.approvals,
    unresolved.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(unresolvedReport.ok, false);
  assert.equal(unresolvedReport.unresolved_total, 1);

  const stale = validEvidence();
  stale.evidence.collected_at = "2026-07-09T00:00:00.000Z";
  const staleReport = verifyProductionWorksheetInventory(
    stale.approvals,
    stale.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(staleReport.ok, false);
  assert(staleReport.errors.some((error) => error.includes("stale")));

  const mismatch = validEvidence();
  mismatch.evidence.project_ref = "zzzzzzzzzzzzzzzzzzzz";
  const mismatchReport = verifyProductionWorksheetInventory(
    mismatch.approvals,
    mismatch.evidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(mismatchReport.ok, false);
});

test("rejects legacy inventory evidence that trusted note-derived hashes", () => {
  const { approvals, evidence } = validEvidence();
  const legacyEvidence = {
    ...evidence,
    schema_version: 1,
  };
  const report = verifyProductionWorksheetInventory(
    approvals,
    legacyEvidence,
    RELEASE,
    PROJECT_REF,
    NOW,
  );

  assert.equal(report.ok, false);
  assert(
    report.errors.some((error) =>
      error.includes("invalid release, project, time, or row context"),
    ),
  );

  const wrongOriginReport = verifyProductionWorksheetInventory(
    approvals,
    { ...evidence, hash_origin: "quality_notes" },
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(wrongOriginReport.ok, false);

  const schemaTwoWithoutTemplateIdentity = {
    ...evidence,
    schema_version: 2,
    canonical_bank: evidence.canonical_bank.map(
      ({ template_key: _templateKey, ...row }) => row,
    ),
  };
  const schemaTwoReport = verifyProductionWorksheetInventory(
    approvals,
    schemaTwoWithoutTemplateIdentity,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(schemaTwoReport.ok, false);
  assert(
    schemaTwoReport.errors.some((error) =>
      error.includes("invalid release, project, time, or row context"),
    ),
  );

  const schemaThreeWithoutCache = {
    schema_version: 3,
    hash_origin: evidence.hash_origin,
    app_release: evidence.app_release,
    project_ref: evidence.project_ref,
    collected_at: evidence.collected_at,
    rows: evidence.rows,
    canonical_bank: evidence.canonical_bank,
  };
  const schemaThreeReport = verifyProductionWorksheetInventory(
    approvals,
    schemaThreeWithoutCache,
    RELEASE,
    PROJECT_REF,
    NOW,
  );
  assert.equal(schemaThreeReport.ok, false);
  assert(
    schemaThreeReport.errors.some((error) =>
      error.includes("invalid release, project, time, or row context"),
    ),
  );
});

test("collector uses one read-only content-free query and strips extra fields", async () => {
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /database|practice_tests/i,
  );
  assert.doesNotMatch(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /question\.prompt|student_answer|corrected_text|quality_notes/,
  );
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /app_private\.practice_test_content_sha256\(test\.id\)/,
  );
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /practice_worksheet_template_revision_sha256\(revision\.id\)/,
  );
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /practice_worksheet_template_releases/,
  );
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /template\.template_key::text as template_key/,
  );
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /practice_worksheet_model_cache_revisions/,
  );
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /practice_worksheet_model_cache_revision_sha256\(revision\.id\)/,
  );
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /worksheet_model_cache_revision_id/,
  );
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /revision\.primary_verdict_sha256/,
  );
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /revision\.secondary_verdict_sha256/,
  );
  assert.match(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /practice_worksheet_model_cache_revision_is_current\(revision\.id\)/,
  );
  assert.doesNotMatch(
    PRODUCTION_WORKSHEET_INVENTORY_QUERY,
    /primary_critic_verdict_sha256|secondary_critic_verdict_sha256/,
  );
  assert.match(PRODUCTION_WORKSHEET_INVENTORY_QUERY, /gemini-3\.1-flash-lite/);
  assert.match(PRODUCTION_WORKSHEET_INVENTORY_QUERY, /gemini-3\.5-flash/);
  assert.match(PRODUCTION_WORKSHEET_INVENTORY_QUERY, /gemini-2\.5-flash/);
  const row = inventoryRow(1);
  const canonical = canonicalBankRow(1);
  const modelCache = modelValidatedCacheRow(1);
  const responseValue = [
    {
      inventory: {
        rows: [
          {
            ...row,
            title: "must not survive",
            prompt: "must not survive",
            accepted_answers: ["must not survive"],
            rubric: { sample_answer: "must not survive" },
            explanation: "must not survive",
            mini_lesson: { key_rule: "must not survive" },
            quality_notes: `content_sha256=${hash(999)}`,
          },
        ],
        canonical_bank: [
          {
            ...canonical,
            title: "must not survive",
            description: "must not survive",
            mini_lesson: { key_rule: "must not survive" },
            questions: [{ prompt: "must not survive" }],
            qualification: "must not survive",
          },
        ],
        model_validated_cache: [
          {
            ...modelCache,
            title: "must not survive",
            description: "must not survive",
            mini_lesson: { key_rule: "must not survive" },
            questions: [{ prompt: "must not survive" }],
            validation_metadata: { provider_payload: "must not survive" },
          },
        ],
      },
    },
  ];
  const sanitized = sanitizeCollectedWorksheetRows(responseValue);
  const sanitizedCanonical = sanitizeCollectedCanonicalBankRows(responseValue);
  const sanitizedModelCache =
    sanitizeCollectedModelValidatedCacheRows(responseValue);
  assert.deepEqual(sanitized, [row]);
  assert.deepEqual(sanitizedCanonical, [canonical]);
  assert.deepEqual(sanitizedModelCache, [modelCache]);
  assert.equal(
    "title" in (sanitized[0] as unknown as Record<string, unknown>),
    false,
  );
  assert.equal(
    "quality_notes" in (sanitized[0] as unknown as Record<string, unknown>),
    false,
  );
  assert.equal(
    "questions" in
      (sanitizedCanonical[0] as unknown as Record<string, unknown>),
    false,
  );
  assert.equal(
    "validation_metadata" in
      (sanitizedModelCache[0] as unknown as Record<string, unknown>),
    false,
  );

  let request: RequestInit | undefined;
  const evidence = await collectProductionWorksheetInventory({
    accessToken: "test-access-token",
    appRelease: RELEASE,
    projectRef: PROJECT_REF,
    collectedAt: COLLECTED_AT,
    fetchImpl: async (_url, init) => {
      request = init;
      return new Response(JSON.stringify(responseValue), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(evidence.rows.length, 1);
  assert.equal(evidence.canonical_bank.length, 1);
  assert.equal(evidence.model_validated_cache.length, 1);
  assert.equal(evidence.schema_version, 4);
  assert.equal(evidence.hash_origin, "db_recomputed_v1");
  assert.equal(request?.method, "POST");
  assert.equal(request?.redirect, "error");
  assert.match(String(request?.body), /practice_tests/);
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /test-access-token|must not survive/,
  );
});

test("collector cache contract matches the migration's exact schema names", async () => {
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/20260713153000_model_validated_worksheet_cache.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const name of [
    "practice_worksheet_model_cache_revisions",
    "practice_worksheet_model_cache_questions",
    "practice_worksheet_model_cache_withdrawals",
    "worksheet_model_cache_revision_id",
    "model_cache_content_sha256",
    "primary_verdict_sha256",
    "secondary_verdict_sha256",
    "practice_worksheet_model_cache_revision_sha256",
    "practice_worksheet_model_cache_revision_is_current",
    "practice_worksheet_model_cache_revisions_immutable",
    "practice_worksheet_model_cache_questions_immutable",
    "practice_worksheet_model_cache_withdrawals_immutable",
  ]) {
    assert.match(migration, new RegExp(`\\b${name}\\b`), name);
    assert.match(
      PRODUCTION_WORKSHEET_INVENTORY_QUERY,
      new RegExp(`\\b${name}\\b`),
      name,
    );
  }
});

test("collector fails closed when canonical bank or model-cache evidence is absent", async () => {
  await assert.rejects(
    collectProductionWorksheetInventory({
      accessToken: "test-access-token",
      appRelease: RELEASE,
      projectRef: PROJECT_REF,
      collectedAt: COLLECTED_AT,
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              inventory: { rows: [] },
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    }),
    /response is malformed/,
  );

  await assert.rejects(
    collectProductionWorksheetInventory({
      accessToken: "test-access-token",
      appRelease: RELEASE,
      projectRef: PROJECT_REF,
      collectedAt: COLLECTED_AT,
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              inventory: { rows: [], canonical_bank: [] },
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    }),
    /response is malformed/,
  );
});
