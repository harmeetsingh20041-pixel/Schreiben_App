import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  requiredTopicsByLevel,
  worksheetLevels as evaluatorLevels,
  type WorksheetLevel as EvaluatorLevel,
} from "./verify-worksheet-authoring-matrix.js";

const coverageTags = [
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
type CoverageTag = (typeof coverageTags)[number];

const agreementFields = [
  "structural_valid",
  "do_not_overcorrect_agrees",
  "correction_agrees",
  "explanation_agrees",
  "adversarial_instruction_resisted",
  "topic_mapping_agrees",
  "level_fit_agrees",
] as const;

const reviewDimensions = [
  "structural_validity",
  "do_not_overcorrect",
  "correction_accuracy",
  "explanation_accuracy",
  "format_fidelity",
  "offset_fidelity",
  "paragraph_fidelity",
  "whitespace_fidelity",
  "topic_mapping",
  "level_fit",
  "adversarial_resistance",
  "hold_behavior",
] as const;
type ReviewDimension = (typeof reviewDimensions)[number];

type CategoryContract = {
  categoryId: string;
  plannedCaseTags: readonly CoverageTag[];
  requiredReviewDimensions: readonly ReviewDimension[];
  expectedPipelineDisposition: "accepted_feedback" | "system_hold";
  evidenceStream: "reviewed_feedback_case" | "reviewed_hold_case";
  requiresReleaseContractExtension: boolean;
};

const categoryContracts: readonly CategoryContract[] = [
  {
    categoryId: "do_not_overcorrect",
    plannedCaseTags: ["do_not_overcorrect", "offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "do_not_overcorrect",
      "correction_accuracy",
      "explanation_accuracy",
      "offset_fidelity",
      "level_fit",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "correction_accuracy",
    plannedCaseTags: ["offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "correction_accuracy",
      "explanation_accuracy",
      "offset_fidelity",
      "topic_mapping",
      "level_fit",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "explanation_accuracy",
    plannedCaseTags: ["offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "correction_accuracy",
      "explanation_accuracy",
      "offset_fidelity",
      "topic_mapping",
      "level_fit",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "decimal",
    plannedCaseTags: ["decimal", "offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "format_fidelity",
      "offset_fidelity",
      "correction_accuracy",
      "explanation_accuracy",
      "level_fit",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "time",
    plannedCaseTags: ["time", "offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "format_fidelity",
      "offset_fidelity",
      "correction_accuracy",
      "explanation_accuracy",
      "level_fit",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "abbreviation",
    plannedCaseTags: ["abbreviation", "offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "format_fidelity",
      "offset_fidelity",
      "correction_accuracy",
      "explanation_accuracy",
      "level_fit",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "paragraph_boundary",
    plannedCaseTags: ["paragraph_boundary", "whitespace", "offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "paragraph_fidelity",
      "whitespace_fidelity",
      "offset_fidelity",
      "correction_accuracy",
      "explanation_accuracy",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "offset",
    plannedCaseTags: ["offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "offset_fidelity",
      "correction_accuracy",
      "explanation_accuracy",
      "topic_mapping",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "repeated_word",
    plannedCaseTags: ["repeated_word", "offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "correction_accuracy",
      "explanation_accuracy",
      "offset_fidelity",
      "do_not_overcorrect",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "missing_space",
    plannedCaseTags: ["missing_space", "whitespace", "offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "whitespace_fidelity",
      "offset_fidelity",
      "correction_accuracy",
      "explanation_accuracy",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "long_sentence",
    plannedCaseTags: ["long_sentence", "offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "correction_accuracy",
      "explanation_accuracy",
      "offset_fidelity",
      "do_not_overcorrect",
      "level_fit",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "topic_mapping",
    plannedCaseTags: ["topic_mapping", "offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "correction_accuracy",
      "explanation_accuracy",
      "offset_fidelity",
      "topic_mapping",
      "level_fit",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "level_fit",
    plannedCaseTags: ["level_fit", "do_not_overcorrect", "offset"],
    requiredReviewDimensions: [
      "structural_validity",
      "do_not_overcorrect",
      "correction_accuracy",
      "explanation_accuracy",
      "topic_mapping",
      "level_fit",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "prompt_injection",
    plannedCaseTags: ["prompt_injection"],
    requiredReviewDimensions: [
      "structural_validity",
      "adversarial_resistance",
      "correction_accuracy",
      "explanation_accuracy",
      "level_fit",
    ],
    expectedPipelineDisposition: "accepted_feedback",
    evidenceStream: "reviewed_feedback_case",
    requiresReleaseContractExtension: false,
  },
  {
    categoryId: "expected_hold",
    plannedCaseTags: ["expected_hold"],
    requiredReviewDimensions: [
      "structural_validity",
      "adversarial_resistance",
      "offset_fidelity",
      "topic_mapping",
      "hold_behavior",
    ],
    expectedPipelineDisposition: "system_hold",
    evidenceStream: "reviewed_hold_case",
    requiresReleaseContractExtension: false,
  },
] as const;

const expectedHoldVariants = [
  "invalid_structure",
  "offset_or_original_mismatch",
  "unmapped_topic",
  "unresolved_model_disagreement",
  "adjudicator_insufficient_evidence",
] as const;

type EvidenceStream = CategoryContract["evidenceStream"];

export type EvaluatorAuthoringMatrixReport = {
  ok: boolean;
  errors: string[];
  totalSlots: number;
  slotsPerLevel: Record<EvaluatorLevel, number>;
  categorySlotsPerLevel: Record<EvaluatorLevel, Record<string, number>>;
  evidenceStreamSlotsPerLevel: Record<
    EvaluatorLevel,
    Record<EvidenceStream, number>
  >;
  coverageTagSlotsPerLevel: Record<EvaluatorLevel, Record<CoverageTag, number>>;
};

function record(value: unknown, label: string, errors: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  errors: string[],
) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    errors.push(`${label} must contain exactly: ${required.join(", ")}.`);
    return false;
  }
  return true;
}

function sameArray(value: unknown, expected: readonly string[]) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function emptyLevelCounts() {
  return { A1: 0, A2: 0, B1: 0, B2: 0 };
}

function emptyCategoryCounts() {
  return Object.fromEntries(
    evaluatorLevels.map((level) => [
      level,
      Object.fromEntries(
        categoryContracts.map((category) => [category.categoryId, 0]),
      ),
    ]),
  ) as Record<EvaluatorLevel, Record<string, number>>;
}

function emptyEvidenceStreamCounts() {
  return Object.fromEntries(
    evaluatorLevels.map((level) => [
      level,
      { reviewed_feedback_case: 0, reviewed_hold_case: 0 },
    ]),
  ) as Record<EvaluatorLevel, Record<EvidenceStream, number>>;
}

function emptyCoverageCounts() {
  return Object.fromEntries(
    evaluatorLevels.map((level) => [
      level,
      Object.fromEntries(coverageTags.map((tag) => [tag, 0])),
    ]),
  ) as Record<EvaluatorLevel, Record<CoverageTag, number>>;
}

function emptyReport(errors: string[]): EvaluatorAuthoringMatrixReport {
  return {
    ok: false,
    errors,
    totalSlots: 0,
    slotsPerLevel: emptyLevelCounts(),
    categorySlotsPerLevel: emptyCategoryCounts(),
    evidenceStreamSlotsPerLevel: emptyEvidenceStreamCounts(),
    coverageTagSlotsPerLevel: emptyCoverageCounts(),
  };
}

export function verifyEvaluatorAuthoringMatrix(
  value: unknown,
): EvaluatorAuthoringMatrixReport {
  const errors: string[] = [];
  const slotsPerLevel = emptyLevelCounts();
  const categorySlotsPerLevel = emptyCategoryCounts();
  const evidenceStreamSlotsPerLevel = emptyEvidenceStreamCounts();
  const coverageTagSlotsPerLevel = emptyCoverageCounts();
  const root = record(value, "matrix", errors);
  if (!root) return emptyReport(errors);

  exactKeys(
    root,
    [
      "schema_version",
      "matrix_id",
      "artifact_kind",
      "authoring_status",
      "required_counts",
      "slot_identity_contract",
      "acceptance_targets",
      "current_release_contract",
      "non_evidence_declaration",
      "category_definitions",
      "special_allocations",
      "allocation_template",
      "level_allocations",
    ],
    "matrix",
    errors,
  );
  if (
    root.schema_version !== 1 ||
    root.matrix_id !== "schreiben-v1-evaluator-corpus-authoring-v1" ||
    root.artifact_kind !== "draft_authoring_plan" ||
    root.authoring_status !== "not_started"
  ) {
    errors.push("Matrix identity and draft status must remain fixed.");
  }

  const counts = record(root.required_counts, "required_counts", errors);
  if (counts) {
    exactKeys(
      counts,
      [
        "total_slots",
        "slots_per_level",
        "primary_category_count",
        "slots_per_category_per_level",
        "reviewed_feedback_slots_per_level",
        "reviewed_hold_slots_per_level",
      ],
      "required_counts",
      errors,
    );
    if (
      counts.total_slots !== 600 ||
      counts.slots_per_level !== 150 ||
      counts.primary_category_count !== 15 ||
      counts.slots_per_category_per_level !== 10 ||
      counts.reviewed_feedback_slots_per_level !== 140 ||
      counts.reviewed_hold_slots_per_level !== 10
    ) {
      errors.push("Required corpus counts must remain 600/150/15/10/140/10.");
    }
  }

  const identity = record(
    root.slot_identity_contract,
    "slot_identity_contract",
    errors,
  );
  if (identity) {
    exactKeys(
      identity,
      [
        "case_id_pattern",
        "case_number_width",
        "first_case_number",
        "last_case_number",
        "allocation_template_id",
      ],
      "slot_identity_contract",
      errors,
    );
    if (
      identity.case_id_pattern !== "^(A1|A2|B1|B2)-EVAL-[0-9]{3}$" ||
      identity.case_number_width !== 3 ||
      identity.first_case_number !== 1 ||
      identity.last_case_number !== 150 ||
      identity.allocation_template_id !== "balanced-150-v1"
    ) {
      errors.push("Slot identity contract drifted.");
    }
  }

  const targets = record(root.acceptance_targets, "acceptance_targets", errors);
  if (targets) {
    exactKeys(
      targets,
      [
        "structural_validity_rate",
        "do_not_overcorrect_agreement_minimum",
        "correction_agreement_minimum",
        "explanation_agreement_minimum",
        "topic_mapping_agreement",
        "level_fit_agreement",
        "minimum_reviewed_hold_slots_per_level",
      ],
      "acceptance_targets",
      errors,
    );
    if (
      targets.structural_validity_rate !== 1 ||
      targets.do_not_overcorrect_agreement_minimum !== 0.99 ||
      targets.correction_agreement_minimum !== 0.98 ||
      targets.explanation_agreement_minimum !== 0.98 ||
      targets.topic_mapping_agreement !== 1 ||
      targets.level_fit_agreement !== 1 ||
      targets.minimum_reviewed_hold_slots_per_level !== 10
    ) {
      errors.push("Evaluator acceptance targets drifted from the V1 gate.");
    }
  }

  const release = record(
    root.current_release_contract,
    "current_release_contract",
    errors,
  );
  if (release) {
    exactKeys(
      release,
      [
        "target_artifact",
        "coverage_tags",
        "agreement_fields",
        "allocation_evidence_fields",
        "terminal_evidence_fields",
      ],
      "current_release_contract",
      errors,
    );
    if (
      release.target_artifact !== "reviewed-cases.jsonl" ||
      !sameArray(release.coverage_tags, coverageTags) ||
      !sameArray(release.agreement_fields, agreementFields) ||
      !sameArray(release.allocation_evidence_fields, [
        "primary_category",
        "case_tags",
      ]) ||
      !sameArray(release.terminal_evidence_fields, [
        "expected_disposition",
        "actual_disposition",
        "decision_sha256",
        "hold_reason_code",
        "hold_variant",
        "student_visible_before_release",
      ])
    ) {
      errors.push("Current release-evidence mapping drifted.");
    }
  }

  const declaration = record(
    root.non_evidence_declaration,
    "non_evidence_declaration",
    errors,
  );
  if (declaration) {
    const declarationKeys = [
      "contains_input_text",
      "contains_expected_or_actual_output",
      "contains_output_hashes",
      "contains_reviewer_attestations",
      "contains_approvals",
      "counts_as_launch_evidence",
      "may_be_used_as_release_corpus",
    ];
    exactKeys(declaration, declarationKeys, "non_evidence_declaration", errors);
    if (declarationKeys.some((key) => declaration[key] !== false)) {
      errors.push(
        "Authoring matrix must contain no cases, outputs, reviews, approvals, or launch evidence.",
      );
    }
  }

  const definitions = Array.isArray(root.category_definitions)
    ? root.category_definitions
    : [];
  if (!Array.isArray(root.category_definitions)) {
    errors.push("category_definitions must be an array.");
  }
  if (definitions.length !== categoryContracts.length) {
    errors.push(
      `Matrix has ${definitions.length}/${categoryContracts.length} category definitions.`,
    );
  }
  const definitionIds = new Set<string>();
  definitions.forEach((raw, index) => {
    const label = `category definition ${index + 1}`;
    const definition = record(raw, label, errors);
    if (!definition) return;
    exactKeys(
      definition,
      [
        "category_id",
        "slots_per_level",
        "planned_case_tags",
        "required_review_dimensions",
        "expected_pipeline_disposition",
        "evidence_stream",
        "requires_release_contract_extension",
      ],
      label,
      errors,
    );
    const expected = categoryContracts[index];
    if (!expected) return;
    if (
      definition.category_id !== expected.categoryId ||
      definition.slots_per_level !== 10 ||
      !sameArray(definition.planned_case_tags, expected.plannedCaseTags) ||
      !sameArray(
        definition.required_review_dimensions,
        expected.requiredReviewDimensions,
      ) ||
      definition.expected_pipeline_disposition !==
        expected.expectedPipelineDisposition ||
      definition.evidence_stream !== expected.evidenceStream ||
      definition.requires_release_contract_extension !==
        expected.requiresReleaseContractExtension
    ) {
      errors.push(`${label} drifted from its deterministic category contract.`);
    }
    const id = String(definition.category_id);
    if (definitionIds.has(id))
      errors.push(`Duplicate category definition: ${id}.`);
    definitionIds.add(id);
  });

  const special = record(
    root.special_allocations,
    "special_allocations",
    errors,
  );
  if (special) {
    exactKeys(
      special,
      ["topic_mapping_topics_by_level", "expected_hold_variants"],
      "special_allocations",
      errors,
    );
    const topicPlans = record(
      special.topic_mapping_topics_by_level,
      "topic_mapping_topics_by_level",
      errors,
    );
    if (topicPlans) {
      exactKeys(
        topicPlans,
        evaluatorLevels,
        "topic_mapping_topics_by_level",
        errors,
      );
      for (const level of evaluatorLevels) {
        if (!sameArray(topicPlans[level], requiredTopicsByLevel[level])) {
          errors.push(
            `${level} topic-mapping allocation must cover its exact 10 canonical topics.`,
          );
        }
      }
    }
    const holdVariants = Array.isArray(special.expected_hold_variants)
      ? special.expected_hold_variants
      : [];
    if (!Array.isArray(special.expected_hold_variants)) {
      errors.push("expected_hold_variants must be an array.");
    }
    if (holdVariants.length !== expectedHoldVariants.length) {
      errors.push("Expected-hold allocation must contain five variants.");
    }
    let holdSlotsPerLevel = 0;
    holdVariants.forEach((raw, index) => {
      const label = `expected-hold variant ${index + 1}`;
      const variant = record(raw, label, errors);
      if (!variant) return;
      exactKeys(variant, ["variant_id", "slots_per_level"], label, errors);
      if (
        variant.variant_id !== expectedHoldVariants[index] ||
        variant.slots_per_level !== 2
      ) {
        errors.push(`${label} drifted from the 2-per-level hold plan.`);
      }
      holdSlotsPerLevel += Number(variant.slots_per_level) || 0;
    });
    if (holdSlotsPerLevel !== 10) {
      errors.push(
        `Expected-hold variants allocate ${holdSlotsPerLevel}/10 slots per level.`,
      );
    }
  }

  const template = record(
    root.allocation_template,
    "allocation_template",
    errors,
  );
  const blocks =
    template && Array.isArray(template.blocks) ? template.blocks : [];
  if (template) {
    exactKeys(
      template,
      ["template_id", "blocks"],
      "allocation_template",
      errors,
    );
    if (template.template_id !== "balanced-150-v1") {
      errors.push("Allocation template id drifted.");
    }
    if (!Array.isArray(template.blocks)) {
      errors.push("allocation_template.blocks must be an array.");
    }
  }
  if (blocks.length !== categoryContracts.length) {
    errors.push(`Allocation template has ${blocks.length}/15 category blocks.`);
  }
  const normalizedBlocks: Array<{
    categoryId: string;
    first: number;
    last: number;
    count: number;
  }> = [];
  blocks.forEach((raw, index) => {
    const label = `allocation block ${index + 1}`;
    const block = record(raw, label, errors);
    if (!block) return;
    exactKeys(
      block,
      ["category_id", "first_case_number", "last_case_number", "slot_count"],
      label,
      errors,
    );
    const expected = categoryContracts[index];
    const expectedFirst = index * 10 + 1;
    const expectedLast = expectedFirst + 9;
    if (
      !expected ||
      block.category_id !== expected.categoryId ||
      block.first_case_number !== expectedFirst ||
      block.last_case_number !== expectedLast ||
      block.slot_count !== 10 ||
      Number(block.last_case_number) - Number(block.first_case_number) + 1 !==
        Number(block.slot_count)
    ) {
      errors.push(`${label} drifted from its contiguous 10-slot allocation.`);
    }
    normalizedBlocks.push({
      categoryId: String(block.category_id),
      first: Number(block.first_case_number),
      last: Number(block.last_case_number),
      count: Number(block.slot_count),
    });
  });

  const levels = Array.isArray(root.level_allocations)
    ? root.level_allocations
    : [];
  if (!Array.isArray(root.level_allocations)) {
    errors.push("level_allocations must be an array.");
  }
  if (levels.length !== evaluatorLevels.length) {
    errors.push(`Matrix has ${levels.length}/4 CEFR level allocations.`);
  }
  const impliedCaseIds = new Set<string>();
  levels.forEach((raw, index) => {
    const label = `level allocation ${index + 1}`;
    const allocation = record(raw, label, errors);
    if (!allocation) return;
    exactKeys(
      allocation,
      ["level", "case_id_prefix", "allocation_template_id", "slot_count"],
      label,
      errors,
    );
    const level = evaluatorLevels[index];
    if (
      allocation.level !== level ||
      allocation.case_id_prefix !== `${level}-EVAL` ||
      allocation.allocation_template_id !== "balanced-150-v1" ||
      allocation.slot_count !== 150
    ) {
      errors.push(`${label} drifted from its exact 150-slot CEFR contract.`);
    }
    if (!evaluatorLevels.includes(allocation.level as EvaluatorLevel)) return;
    const actualLevel = allocation.level as EvaluatorLevel;
    for (const block of normalizedBlocks) {
      const category = categoryContracts.find(
        (candidate) => candidate.categoryId === block.categoryId,
      );
      if (!category) continue;
      categorySlotsPerLevel[actualLevel][block.categoryId] += block.count;
      evidenceStreamSlotsPerLevel[actualLevel][category.evidenceStream] +=
        block.count;
      for (const tag of category.plannedCaseTags) {
        coverageTagSlotsPerLevel[actualLevel][tag] += block.count;
      }
      for (
        let caseNumber = block.first;
        caseNumber <= block.last;
        caseNumber += 1
      ) {
        const caseId = `${String(allocation.case_id_prefix)}-${String(caseNumber).padStart(3, "0")}`;
        if (!/^(A1|A2|B1|B2)-EVAL-[0-9]{3}$/.test(caseId)) {
          errors.push(`${label} implies an invalid case id: ${caseId}.`);
        }
        if (impliedCaseIds.has(caseId)) {
          errors.push(`Duplicate implied evaluator case id: ${caseId}.`);
        }
        impliedCaseIds.add(caseId);
        slotsPerLevel[actualLevel] += 1;
      }
    }
  });

  for (const level of evaluatorLevels) {
    if (slotsPerLevel[level] !== 150) {
      errors.push(
        `${level} has ${slotsPerLevel[level]}/150 implied case slots.`,
      );
    }
    for (const category of categoryContracts) {
      if (categorySlotsPerLevel[level][category.categoryId] !== 10) {
        errors.push(
          `${level}:${category.categoryId} has ${categorySlotsPerLevel[level][category.categoryId]}/10 slots.`,
        );
      }
    }
    if (
      evidenceStreamSlotsPerLevel[level].reviewed_feedback_case !== 140 ||
      evidenceStreamSlotsPerLevel[level].reviewed_hold_case !== 10
    ) {
      errors.push(
        `${level} evidence streams must remain 140 feedback/10 hold.`,
      );
    }
    for (const tag of coverageTags) {
      if (coverageTagSlotsPerLevel[level][tag] < 10) {
        errors.push(`${level} has fewer than 10 planned ${tag} tag slots.`);
      }
    }
  }
  if (impliedCaseIds.size !== 600) {
    errors.push(`Matrix implies ${impliedCaseIds.size}/600 unique case ids.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    totalSlots: impliedCaseIds.size,
    slotsPerLevel,
    categorySlotsPerLevel,
    evidenceStreamSlotsPerLevel,
    coverageTagSlotsPerLevel,
  };
}

async function main() {
  const index = process.argv.indexOf("--file");
  const file = index >= 0 ? process.argv[index + 1] : "";
  if (!file) {
    throw new Error(
      "Usage: evaluator-matrix:verify -- --file <authoring-matrix.json>",
    );
  }
  const fromCurrentDirectory = resolve(file);
  const fromRepositoryRoot = resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
    file,
  );
  const inputFile =
    isAbsolute(file) || existsSync(fromCurrentDirectory)
      ? fromCurrentDirectory
      : fromRepositoryRoot;
  const value = JSON.parse(await readFile(inputFile, "utf8")) as unknown;
  const report = verifyEvaluatorAuthoringMatrix(value);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
