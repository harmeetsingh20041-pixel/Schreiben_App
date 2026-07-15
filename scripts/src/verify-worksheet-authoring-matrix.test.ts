import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalWorksheetTemplateContexts,
  canonicalWorksheetTemplateKeys,
  canonicalWorksheetTopics,
  requiredTopicsByLevel,
  secondRevisionTopicsByLevel,
  verifyWorksheetAuthoringMatrix,
  WORKSHEET_AUTHORING_SLOT_TOTAL,
  WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL,
  WORKSHEET_SLOTS_PER_LEVEL,
  worksheetLevels,
} from "./verify-worksheet-authoring-matrix.js";

const checkedInMatrix = JSON.parse(
  await readFile(
    new URL(
      "../../quality/worksheet-bank/authoring-matrix.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown>;

function cloneMatrix() {
  return structuredClone(checkedInMatrix) as Record<string, unknown> & {
    slots: Array<Record<string, unknown>>;
    phase_12h_contract: Record<string, unknown>;
    non_evidence_declaration: Record<string, unknown>;
  };
}

function expectFailure(
  mutate: (matrix: ReturnType<typeof cloneMatrix>) => void,
  pattern: RegExp,
) {
  const matrix = cloneMatrix();
  mutate(matrix);
  const report = verifyWorksheetAuthoringMatrix(matrix);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), pattern);
}

test("checked-in worksheet authoring matrix covers every level/topic foundation plus 40 retained second revisions", () => {
  const report = verifyWorksheetAuthoringMatrix(checkedInMatrix);

  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.totalSlots, WORKSHEET_AUTHORING_SLOT_TOTAL);
  assert.deepEqual(report.slotsPerLevel, {
    A1: WORKSHEET_SLOTS_PER_LEVEL,
    A2: WORKSHEET_SLOTS_PER_LEVEL,
    B1: WORKSHEET_SLOTS_PER_LEVEL,
    B2: WORKSHEET_SLOTS_PER_LEVEL,
  });
  for (const level of worksheetLevels) {
    assert.deepEqual(
      report.topicsPerLevel[level],
      [...canonicalWorksheetTopics].sort(),
    );
    assert.equal(report.topicsPerLevel[level].length, 36);
    assert.equal(secondRevisionTopicsByLevel[level].length, 10);
    assert.deepEqual(
      [...requiredTopicsByLevel[level]],
      [...secondRevisionTopicsByLevel[level]],
    );
  }
  assert.equal(WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL, 36);
  assert.equal(canonicalWorksheetTemplateKeys.length, 184);
  assert.equal(new Set(canonicalWorksheetTemplateKeys).size, 184);
  assert.deepEqual(
    (checkedInMatrix.slots as Array<{ template_key: string }>)
      .map((slot) => slot.template_key)
      .sort(),
    [...canonicalWorksheetTemplateKeys].sort(),
  );
  assert.deepEqual(
    canonicalWorksheetTemplateContexts.map((context) => ({
      template_key: context.templateKey,
      level: context.level,
      topic_slug: context.topicSlug,
      revision_number: context.revisionNumber,
    })),
    (checkedInMatrix.slots as Array<Record<string, unknown>>).map((slot) => ({
      template_key: slot.template_key,
      level: slot.level,
      topic_slug: slot.topic_slug,
      revision_number: slot.revision_number,
    })),
  );
});

test("rejects a missing slot and per-level coverage drift", () => {
  expectFailure((matrix) => {
    matrix.slots.pop();
  }, /183\/184 slots|B2 has 45\/46 slots|B2:task-fulfilment must retain foundation r1 and second revision r2/);
});

test("rejects a non-canonical topic", () => {
  expectFailure((matrix) => {
    matrix.slots[0].topic_slug = "invented-topic";
  }, /non-canonical topic/);
});

test("rejects duplicate revisions, objectives, and template identities", () => {
  expectFailure((matrix) => {
    const first = matrix.slots[0];
    const second = matrix.slots[1];
    second.revision_number = 1;
    second.revision_objective_id = first.revision_objective_id;
    second.revision_objective_category = first.revision_objective_category;
    second.revision_objective = first.revision_objective;
    second.slot_id = first.slot_id;
    second.template_key = first.template_key;
  }, /invalid or duplicate slot_id|invalid or duplicate Phase 12H template_key|must retain foundation r1 and second revision r2/);
});

test("rejects duplicate objective text even when objective IDs differ", () => {
  expectFailure((matrix) => {
    matrix.slots[1].revision_objective = matrix.slots[0].revision_objective;
  }, /two distinct objective IDs and texts/);
});

test("reports the exact missing foundation level/topic instead of accepting blind coverage", () => {
  expectFailure((matrix) => {
    const index = matrix.slots.findIndex(
      (slot) =>
        slot.level === "A1" &&
        slot.topic_slug === "plusquamperfekt" &&
        slot.revision_number === 1,
    );
    assert.notEqual(index, -1);
    matrix.slots.splice(index, 1);
  }, /A1:plusquamperfekt is missing required foundation revision r1/);
});

test("rejects an unplanned second revision outside the retained 40", () => {
  expectFailure((matrix) => {
    const foundation = matrix.slots.find(
      (slot) =>
        slot.level === "A1" &&
        slot.topic_slug === "plusquamperfekt" &&
        slot.revision_number === 1,
    )!;
    matrix.slots.push({
      ...structuredClone(foundation),
      slot_id: "A1-plusquamperfekt-r2",
      template_key: "v1-a1-plusquamperfekt-r2",
      revision_number: 2,
      revision_objective_id: "transfer-error-repair-and-production",
      revision_objective_category: "transfer_and_repair",
      revision_objective:
        "Repair and transfer Plusquamperfekt accurately in varied sentence contexts.",
    });
  }, /adds a second revision outside the retained A1 ten-topic plan/);
});

test("foundation revisions require a provider-independent local question mix", () => {
  const foundation = (
    checkedInMatrix.slots as Array<Record<string, unknown>>
  ).filter((slot) => slot.revision_number === 1);

  for (const slot of foundation) {
    const plan = slot.question_type_plan as Record<string, number>;
    const modes = slot.evaluation_mode_plan as Record<string, number>;
    assert.deepEqual(Object.keys(plan).sort(), [
      "fill_blank",
      "multiple_choice",
    ]);
    assert.ok(plan.fill_blank >= 2);
    assert.ok(plan.multiple_choice >= 2);
    assert.equal(modes.open_evaluation, 0);
    assert.equal(modes.local_exact, slot.planned_question_count);
  }
});

test("rejects CEFR difficulty or provider-dependent foundation drift", () => {
  expectFailure((matrix) => {
    matrix.slots[0].difficulty = "hard";
    matrix.slots[0].question_type_plan = {
      multiple_choice: 5,
      fill_blank: 2,
      mini_writing: 1,
    };
  }, /violates the CEFR question-type\/difficulty plan/);
});

test("rejects semantic scoring in a provider-independent foundation revision", () => {
  expectFailure((matrix) => {
    matrix.slots[0].evaluation_mode_plan = {
      local_exact: 7,
      open_evaluation: 1,
    };
  }, /violates the scoring-mode balance/);
});

test("retains the bounded semantic-scoring contract for second revisions", () => {
  expectFailure((matrix) => {
    const secondRevision = matrix.slots.find(
      (slot) => slot.revision_number === 2,
    )!;
    secondRevision.evaluation_mode_plan = {
      local_exact: Number(secondRevision.planned_question_count) - 4,
      open_evaluation: 4,
    };
  }, /violates the scoring-mode balance/);
});

test("rejects Phase 12H importer contract drift", () => {
  expectFailure((matrix) => {
    matrix.phase_12h_contract.answer_contract_version = 2;
    const contract = matrix.slots[0].import_contract as Record<string, unknown>;
    contract.source = "generated";
  }, /Phase 12H\/import contract metadata drifted|not aligned to the Phase 12H importer/);
});

test("rejects worksheet content, approvals, or authored-state claims", () => {
  expectFailure((matrix) => {
    matrix.slots[0].questions = [];
    matrix.slots[0].authoring_status = "approved";
    matrix.non_evidence_declaration.contains_human_approvals = true;
  }, /must contain exactly|must remain not_started|must not contain content, approvals, or importable evidence/);
});
