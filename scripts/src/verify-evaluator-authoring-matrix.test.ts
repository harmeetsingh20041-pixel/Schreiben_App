import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifyEvaluatorAuthoringMatrix } from "./verify-evaluator-authoring-matrix.js";

const checkedInMatrix = JSON.parse(
  await readFile(
    new URL(
      "../../quality/evaluator-corpus/authoring-matrix.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown>;

type MutableMatrix = Record<string, unknown> & {
  acceptance_targets: Record<string, unknown>;
  current_release_contract: Record<string, unknown>;
  non_evidence_declaration: Record<string, unknown>;
  category_definitions: Array<Record<string, unknown>>;
  special_allocations: {
    topic_mapping_topics_by_level: Record<string, string[]>;
    expected_hold_variants: Array<Record<string, unknown>>;
  };
  allocation_template: {
    template_id: string;
    blocks: Array<Record<string, unknown>>;
  };
  level_allocations: Array<Record<string, unknown>>;
};

function cloneMatrix() {
  return structuredClone(checkedInMatrix) as MutableMatrix;
}

function expectFailure(
  mutate: (matrix: MutableMatrix) => void,
  pattern: RegExp,
) {
  const matrix = cloneMatrix();
  mutate(matrix);
  const report = verifyEvaluatorAuthoringMatrix(matrix);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), pattern);
}

test("checked-in evaluator matrix implies exactly 600 balanced A1-B2 slots", () => {
  const report = verifyEvaluatorAuthoringMatrix(checkedInMatrix);

  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.totalSlots, 600);
  assert.deepEqual(report.slotsPerLevel, {
    A1: 150,
    A2: 150,
    B1: 150,
    B2: 150,
  });
  for (const level of ["A1", "A2", "B1", "B2"] as const) {
    assert.equal(Object.keys(report.categorySlotsPerLevel[level]).length, 15);
    assert(
      Object.values(report.categorySlotsPerLevel[level]).every(
        (count) => count === 10,
      ),
    );
    assert.deepEqual(report.evidenceStreamSlotsPerLevel[level], {
      reviewed_feedback_case: 140,
      reviewed_hold_case: 10,
    });
    assert(
      Object.values(report.coverageTagSlotsPerLevel[level]).every(
        (count) => count >= 10,
      ),
    );
  }
});

test("rejects a missing CEFR allocation", () => {
  expectFailure((matrix) => {
    matrix.level_allocations.pop();
  }, /3\/4 CEFR level allocations|B2 has 0\/150|450\/600 unique case ids/);
});

test("rejects a category range gap, overlap, or quota drift", () => {
  expectFailure((matrix) => {
    const block = matrix.allocation_template.blocks[1];
    block.first_case_number = 10;
    block.slot_count = 11;
  }, /drifted from its contiguous 10-slot allocation|Duplicate implied evaluator case id|correction_accuracy has 11\/10 slots/);
});

test("rejects deterministic category metadata drift", () => {
  expectFailure((matrix) => {
    matrix.category_definitions[13].planned_case_tags = ["offset"];
    matrix.category_definitions[13].expected_pipeline_disposition =
      "system_hold";
  }, /category definition 14 drifted from its deterministic category contract/);
});

test("rejects missing current coverage tags or weaker quality targets", () => {
  expectFailure((matrix) => {
    matrix.current_release_contract.coverage_tags = ["offset"];
    matrix.acceptance_targets.correction_agreement_minimum = 0.5;
  }, /Current release-evidence mapping drifted|acceptance targets drifted/);
});

test("rejects non-canonical or incomplete topic-mapping allocations", () => {
  expectFailure((matrix) => {
    matrix.special_allocations.topic_mapping_topics_by_level.A1[0] =
      "unknown-topic";
    matrix.special_allocations.topic_mapping_topics_by_level.B2.pop();
  }, /A1 topic-mapping allocation|B2 topic-mapping allocation/);
});

test("rejects missing expected-hold variants or a non-hold disposition", () => {
  expectFailure((matrix) => {
    matrix.special_allocations.expected_hold_variants[0].slots_per_level = 1;
    matrix.category_definitions[14].expected_pipeline_disposition =
      "accepted_feedback";
  }, /2-per-level hold plan|allocate 9\/10|category definition 15 drifted/);
});

test("rejects duplicate implied case identities", () => {
  expectFailure((matrix) => {
    matrix.level_allocations[1].level = "A1";
    matrix.level_allocations[1].case_id_prefix = "A1-EVAL";
  }, /level allocation 2 drifted|Duplicate implied evaluator case id|A1 has 300\/150/);
});

test("rejects case content, outputs, attestations, or launch-evidence claims", () => {
  expectFailure((matrix) => {
    matrix.cases = [];
    matrix.authoring_status = "reviewed";
    matrix.non_evidence_declaration.contains_input_text = true;
    matrix.non_evidence_declaration.counts_as_launch_evidence = true;
  }, /matrix must contain exactly|draft status must remain fixed|must contain no cases, outputs, reviews, approvals, or launch evidence/);
});
