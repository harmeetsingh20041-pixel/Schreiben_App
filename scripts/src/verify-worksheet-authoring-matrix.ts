import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const worksheetLevels = ["A1", "A2", "B1", "B2"] as const;
export type WorksheetLevel = (typeof worksheetLevels)[number];
type Difficulty = "easy" | "medium" | "hard";

export const canonicalWorksheetTopics = [
  "articles",
  "nominativ",
  "akkusativ",
  "dativ",
  "genitiv",
  "adjective-endings",
  "pronouns",
  "plural-forms",
  "conjugation",
  "subject-verb-agreement",
  "verb-position",
  "word-order",
  "sentence-structure",
  "question-formation",
  "negation",
  "modal-verbs",
  "separable-verbs",
  "reflexive-verbs",
  "prepositions",
  "conjunctions",
  "connectors",
  "subordinate-clauses",
  "relative-clauses",
  "infinitive-zu",
  "perfekt",
  "praeteritum",
  "plusquamperfekt",
  "future-tense",
  "passive-voice",
  "konjunktiv",
  "spelling",
  "capitalization",
  "punctuation",
  "register",
  "coherence",
  "task-fulfilment",
] as const;

export const secondRevisionTopicsByLevel: Record<
  WorksheetLevel,
  readonly string[]
> = {
  A1: [
    "articles",
    "nominativ",
    "akkusativ",
    "conjugation",
    "subject-verb-agreement",
    "verb-position",
    "question-formation",
    "negation",
    "modal-verbs",
    "prepositions",
  ],
  A2: [
    "dativ",
    "adjective-endings",
    "pronouns",
    "plural-forms",
    "separable-verbs",
    "reflexive-verbs",
    "prepositions",
    "conjunctions",
    "perfekt",
    "word-order",
  ],
  B1: [
    "genitiv",
    "adjective-endings",
    "subordinate-clauses",
    "relative-clauses",
    "infinitive-zu",
    "praeteritum",
    "plusquamperfekt",
    "future-tense",
    "passive-voice",
    "connectors",
  ],
  B2: [
    "konjunktiv",
    "passive-voice",
    "relative-clauses",
    "subordinate-clauses",
    "connectors",
    "coherence",
    "register",
    "punctuation",
    "task-fulfilment",
    "word-order",
  ],
};

export type WorksheetRevisionNumber = 1 | 2;

export type CanonicalWorksheetTemplateContext = {
  templateKey: string;
  level: WorksheetLevel;
  topicSlug: (typeof canonicalWorksheetTopics)[number];
  revisionNumber: WorksheetRevisionNumber;
};

export function canonicalWorksheetTemplateKey(
  level: WorksheetLevel,
  topicSlug: string,
  revisionNumber: WorksheetRevisionNumber,
) {
  return `v1-${level.toLowerCase()}-${topicSlug}-r${revisionNumber}`;
}

/**
 * The exact immutable launch-bank identities represented by the checked-in
 * authoring matrix. Release gates use this list rather than accepting aggregate
 * per-topic counts, which cannot distinguish two copies of one revision from
 * the required r1/r2 pair.
 */
export const canonicalWorksheetTemplateContexts: readonly CanonicalWorksheetTemplateContext[] =
  worksheetLevels.flatMap((level) =>
    canonicalWorksheetTopics.flatMap((topicSlug) => {
      const revisions: WorksheetRevisionNumber[] = secondRevisionTopicsByLevel[
        level
      ].includes(topicSlug)
        ? [1, 2]
        : [1];
      return revisions.map(
        (revisionNumber): CanonicalWorksheetTemplateContext => ({
          templateKey: canonicalWorksheetTemplateKey(
            level,
            topicSlug,
            revisionNumber,
          ),
          level,
          topicSlug,
          revisionNumber,
        }),
      );
    }),
  );

export const canonicalWorksheetTemplateKeys: readonly string[] =
  canonicalWorksheetTemplateContexts.map((context) => context.templateKey);

// The evaluator authoring matrix intentionally keeps its focused ten-topic
// sampling plan. Worksheet foundation coverage is broader and is enforced
// against canonicalWorksheetTopics below.
export const requiredTopicsByLevel = secondRevisionTopicsByLevel;

export const WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL =
  canonicalWorksheetTopics.length;
export const WORKSHEET_SECOND_REVISIONS_PER_LEVEL = 10;
export const WORKSHEET_SLOTS_PER_LEVEL =
  WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL +
  WORKSHEET_SECOND_REVISIONS_PER_LEVEL;
export const WORKSHEET_FOUNDATION_CONTEXT_TOTAL =
  WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL * worksheetLevels.length;
export const WORKSHEET_SECOND_REVISION_TOTAL =
  WORKSHEET_SECOND_REVISIONS_PER_LEVEL * worksheetLevels.length;
export const WORKSHEET_AUTHORING_SLOT_TOTAL =
  WORKSHEET_FOUNDATION_CONTEXT_TOTAL + WORKSHEET_SECOND_REVISION_TOTAL;

const closedTopicContract = new Set<string>(canonicalWorksheetTopics);

const questionTypes = [
  "multiple_choice",
  "fill_blank",
  "sentence_correction",
  "word_order",
  "transformation",
  "rewrite_sentence",
  "mini_writing",
] as const;
type QuestionType = (typeof questionTypes)[number];

type SlotPlan = {
  difficulty: Difficulty;
  questionCount: number;
  questionTypes: Partial<Record<QuestionType, number>>;
  localExact: number;
  openEvaluation: number;
};

const requiredPlan: Record<WorksheetLevel, Record<1 | 2, SlotPlan>> = {
  A1: {
    1: {
      difficulty: "easy",
      questionCount: 8,
      questionTypes: {
        multiple_choice: 3,
        fill_blank: 3,
        sentence_correction: 1,
        word_order: 1,
      },
      localExact: 6,
      openEvaluation: 2,
    },
    2: {
      difficulty: "medium",
      questionCount: 8,
      questionTypes: {
        multiple_choice: 2,
        fill_blank: 3,
        sentence_correction: 1,
        word_order: 2,
      },
      localExact: 5,
      openEvaluation: 3,
    },
  },
  A2: {
    1: {
      difficulty: "easy",
      questionCount: 8,
      questionTypes: {
        multiple_choice: 2,
        fill_blank: 3,
        sentence_correction: 1,
        word_order: 1,
        transformation: 1,
      },
      localExact: 5,
      openEvaluation: 3,
    },
    2: {
      difficulty: "medium",
      questionCount: 8,
      questionTypes: {
        multiple_choice: 3,
        fill_blank: 2,
        sentence_correction: 1,
        word_order: 1,
        transformation: 1,
      },
      localExact: 5,
      openEvaluation: 3,
    },
  },
  B1: {
    1: {
      difficulty: "medium",
      questionCount: 10,
      questionTypes: {
        multiple_choice: 3,
        fill_blank: 4,
        sentence_correction: 1,
        transformation: 1,
        mini_writing: 1,
      },
      localExact: 7,
      openEvaluation: 3,
    },
    2: {
      difficulty: "hard",
      questionCount: 10,
      questionTypes: {
        multiple_choice: 3,
        fill_blank: 4,
        word_order: 1,
        rewrite_sentence: 1,
        mini_writing: 1,
      },
      localExact: 7,
      openEvaluation: 3,
    },
  },
  B2: {
    1: {
      difficulty: "medium",
      questionCount: 10,
      questionTypes: {
        multiple_choice: 3,
        fill_blank: 4,
        sentence_correction: 1,
        transformation: 1,
        mini_writing: 1,
      },
      localExact: 7,
      openEvaluation: 3,
    },
    2: {
      difficulty: "hard",
      questionCount: 10,
      questionTypes: {
        multiple_choice: 3,
        fill_blank: 4,
        word_order: 1,
        rewrite_sentence: 1,
        mini_writing: 1,
      },
      localExact: 7,
      openEvaluation: 3,
    },
  },
};

function isProviderIndependentFoundationPlan(
  value: unknown,
  questionCount: number,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const counts = value as Record<string, unknown>;
  const keys = Object.keys(counts).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "fill_blank" ||
    keys[1] !== "multiple_choice"
  ) {
    return false;
  }
  const fillBlank = counts.fill_blank;
  const multipleChoice = counts.multiple_choice;
  return (
    Number.isInteger(fillBlank) &&
    Number.isInteger(multipleChoice) &&
    Number(fillBlank) >= 2 &&
    Number(multipleChoice) >= 2 &&
    Number(fillBlank) + Number(multipleChoice) === questionCount
  );
}

export type WorksheetAuthoringMatrixReport = {
  ok: boolean;
  errors: string[];
  totalSlots: number;
  slotsPerLevel: Record<WorksheetLevel, number>;
  topicsPerLevel: Record<WorksheetLevel, string[]>;
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
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, i) => key !== keys[i])
  ) {
    errors.push(`${label} must contain exactly: ${keys.join(", ")}.`);
    return false;
  }
  return true;
}

function sameStringArray(value: unknown, expected: readonly string[]) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function sameCountMap(
  value: unknown,
  expected: Partial<Record<QuestionType, number>>,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every(
      (key) =>
        Number.isInteger(actual[key]) &&
        actual[key] === expected[key as QuestionType],
    )
  );
}

function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const values = map.get(key) ?? new Set<V>();
  values.add(value);
  map.set(key, values);
}

export function verifyWorksheetAuthoringMatrix(
  value: unknown,
): WorksheetAuthoringMatrixReport {
  const errors: string[] = [];
  const slotsPerLevel = { A1: 0, A2: 0, B1: 0, B2: 0 };
  const topicSets: Record<WorksheetLevel, Set<string>> = {
    A1: new Set(),
    A2: new Set(),
    B1: new Set(),
    B2: new Set(),
  };
  const root = record(value, "matrix", errors);
  if (!root)
    return {
      ok: false,
      errors,
      totalSlots: 0,
      slotsPerLevel,
      topicsPerLevel: { A1: [], A2: [], B1: [], B2: [] },
    };

  exactKeys(
    root,
    [
      "schema_version",
      "matrix_id",
      "artifact_kind",
      "closed_topic_contract_version",
      "required_counts",
      "phase_12h_contract",
      "non_evidence_declaration",
      "slots",
    ],
    "matrix",
    errors,
  );
  if (
    root.schema_version !== 2 ||
    root.matrix_id !== "schreiben-v1-launch-worksheet-authoring-v2" ||
    root.artifact_kind !== "draft_authoring_plan" ||
    root.closed_topic_contract_version !== "phase-11a-v1"
  ) {
    errors.push("Matrix identity/version contract is invalid.");
  }

  const counts = record(root.required_counts, "required_counts", errors);
  if (
    counts &&
    exactKeys(
      counts,
      [
        "total_slots",
        "foundation_slots",
        "second_revision_slots",
        "slots_per_level",
        "foundation_slots_per_level",
        "second_revision_slots_per_level",
        "distinct_topics_per_level",
      ],
      "required_counts",
      errors,
    ) &&
    (counts.total_slots !== WORKSHEET_AUTHORING_SLOT_TOTAL ||
      counts.foundation_slots !== WORKSHEET_FOUNDATION_CONTEXT_TOTAL ||
      counts.second_revision_slots !== WORKSHEET_SECOND_REVISION_TOTAL ||
      counts.slots_per_level !== WORKSHEET_SLOTS_PER_LEVEL ||
      counts.foundation_slots_per_level !==
        WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL ||
      counts.second_revision_slots_per_level !==
        WORKSHEET_SECOND_REVISIONS_PER_LEVEL ||
      counts.distinct_topics_per_level !==
        WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL)
  ) {
    errors.push(
      "Required counts must remain 184 total: 144 foundation contexts plus 40 second revisions, with 46 slots and 36 distinct topics per level.",
    );
  }

  const phase = record(root.phase_12h_contract, "phase_12h_contract", errors);
  if (phase) {
    exactKeys(
      phase,
      [
        "template_key_pattern",
        "allowed_levels",
        "allowed_difficulties",
        "allowed_question_types",
        "allowed_evaluation_modes",
        "answer_contract_version",
        "maximum_open_evaluation_questions",
      ],
      "phase_12h_contract",
      errors,
    );
    if (
      phase.template_key_pattern !== "^[a-z0-9][a-z0-9._-]{5,119}$" ||
      !sameStringArray(phase.allowed_levels, worksheetLevels) ||
      !sameStringArray(phase.allowed_difficulties, [
        "easy",
        "medium",
        "hard",
      ]) ||
      !sameStringArray(phase.allowed_question_types, questionTypes) ||
      !sameStringArray(phase.allowed_evaluation_modes, [
        "local_exact",
        "open_evaluation",
      ]) ||
      phase.answer_contract_version !== 1 ||
      phase.maximum_open_evaluation_questions !== 3
    ) {
      errors.push("Phase 12H/import contract metadata drifted.");
    }
  }

  const declaration = record(
    root.non_evidence_declaration,
    "non_evidence_declaration",
    errors,
  );
  if (declaration) {
    const keys = [
      "contains_worksheet_questions",
      "contains_answers_or_rubrics",
      "contains_human_approvals",
      "counts_as_launch_approval_evidence",
      "may_be_imported_directly",
    ];
    exactKeys(declaration, keys, "non_evidence_declaration", errors);
    if (keys.some((key) => declaration[key] !== false))
      errors.push(
        "Draft matrix must not contain content, approvals, or importable evidence.",
      );
  }

  const slots = Array.isArray(root.slots) ? root.slots : [];
  if (!Array.isArray(root.slots)) errors.push("slots must be an array.");
  if (slots.length !== WORKSHEET_AUTHORING_SLOT_TOTAL) {
    errors.push(
      `Matrix has ${slots.length}/${WORKSHEET_AUTHORING_SLOT_TOTAL} slots.`,
    );
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const pairObjectives = new Map<string, Set<string>>();
  const pairObjectiveTexts = new Map<string, Set<string>>();
  const pairRevisions = new Map<string, Set<number>>();

  slots.forEach((raw, index) => {
    const label = `slot ${index + 1}`;
    const slot = record(raw, label, errors);
    if (!slot) return;
    if (
      !exactKeys(
        slot,
        [
          "slot_id",
          "template_key",
          "level",
          "topic_slug",
          "revision_number",
          "revision_objective_id",
          "revision_objective_category",
          "revision_objective",
          "difficulty",
          "planned_question_count",
          "question_type_plan",
          "evaluation_mode_plan",
          "import_contract",
          "authoring_status",
        ],
        label,
        errors,
      )
    )
      return;
    if (!worksheetLevels.includes(slot.level as WorksheetLevel)) {
      errors.push(`${label} has an invalid level.`);
      return;
    }
    const level = slot.level as WorksheetLevel;
    const topic = typeof slot.topic_slug === "string" ? slot.topic_slug : "";
    const revision = slot.revision_number;
    if (!closedTopicContract.has(topic)) {
      errors.push(`${label} has a non-canonical topic.`);
    }
    if (revision !== 1 && revision !== 2)
      errors.push(`${label} revision_number must be 1 or 2.`);
    if (revision === 2 && !secondRevisionTopicsByLevel[level].includes(topic)) {
      errors.push(
        `${label} adds a second revision outside the retained ${level} ten-topic plan.`,
      );
    }
    const expectedId = `${level}-${topic}-r${revision}`;
    const expectedKey =
      revision === 1 || revision === 2
        ? canonicalWorksheetTemplateKey(level, topic, revision)
        : "";
    if (slot.slot_id !== expectedId || ids.has(expectedId))
      errors.push(`${label} has an invalid or duplicate slot_id.`);
    else ids.add(expectedId);
    if (
      slot.template_key !== expectedKey ||
      keys.has(expectedKey) ||
      !/^[a-z0-9][a-z0-9._-]{5,119}$/.test(expectedKey)
    )
      errors.push(
        `${label} has an invalid or duplicate Phase 12H template_key.`,
      );
    else keys.add(expectedKey);
    const objectiveId =
      revision === 1
        ? "controlled-recognition-and-application"
        : "transfer-error-repair-and-production";
    const objectiveCategory =
      revision === 1 ? "controlled_application" : "transfer_and_repair";
    if (
      slot.revision_objective_id !== objectiveId ||
      slot.revision_objective_category !== objectiveCategory ||
      typeof slot.revision_objective !== "string" ||
      slot.revision_objective.trim().length < 24
    )
      errors.push(`${label} has an invalid revision objective.`);
    const pair = `${level}:${topic}`;
    addToSetMap(pairObjectives, pair, String(slot.revision_objective_id));
    addToSetMap(
      pairObjectiveTexts,
      pair,
      typeof slot.revision_objective === "string"
        ? slot.revision_objective.trim()
        : "",
    );
    addToSetMap(pairRevisions, pair, Number(revision));
    if (revision === 1 || revision === 2) {
      const plan = requiredPlan[level][revision];
      const questionTypePlanIsValid =
        revision === 1
          ? isProviderIndependentFoundationPlan(
              slot.question_type_plan,
              plan.questionCount,
            )
          : sameCountMap(slot.question_type_plan, plan.questionTypes);
      if (
        slot.difficulty !== plan.difficulty ||
        slot.planned_question_count !== plan.questionCount ||
        !questionTypePlanIsValid
      )
        errors.push(
          `${label} violates the CEFR question-type/difficulty plan.`,
        );
      const modes = record(
        slot.evaluation_mode_plan,
        `${label}.evaluation_mode_plan`,
        errors,
      );
      if (modes) {
        exactKeys(
          modes,
          ["local_exact", "open_evaluation"],
          `${label}.evaluation_mode_plan`,
          errors,
        );
        const expectedLocalExact =
          revision === 1 ? plan.questionCount : plan.localExact;
        const expectedOpenEvaluation = revision === 1 ? 0 : plan.openEvaluation;
        if (
          modes.local_exact !== expectedLocalExact ||
          modes.open_evaluation !== expectedOpenEvaluation ||
          Number(modes.open_evaluation) > 3 ||
          Number(modes.local_exact) + Number(modes.open_evaluation) !==
            plan.questionCount
        )
          errors.push(`${label} violates the scoring-mode balance.`);
      }
    }
    const importContract = record(
      slot.import_contract,
      `${label}.import_contract`,
      errors,
    );
    if (importContract) {
      exactKeys(
        importContract,
        [
          "source",
          "visibility_before_certification",
          "answer_contract_version",
          "max_open_evaluation_questions",
        ],
        `${label}.import_contract`,
        errors,
      );
      if (
        importContract.source !== "manual_import" ||
        importContract.visibility_before_certification !== "private" ||
        importContract.answer_contract_version !== 1 ||
        importContract.max_open_evaluation_questions !== 3
      )
        errors.push(`${label} is not aligned to the Phase 12H importer.`);
    }
    if (slot.authoring_status !== "not_started")
      errors.push(
        `${label} must remain not_started until real content is authored.`,
      );
    slotsPerLevel[level] += 1;
    topicSets[level].add(topic);
  });

  for (const level of worksheetLevels) {
    if (slotsPerLevel[level] !== WORKSHEET_SLOTS_PER_LEVEL) {
      errors.push(
        `${level} has ${slotsPerLevel[level]}/${WORKSHEET_SLOTS_PER_LEVEL} slots.`,
      );
    }
    const actualTopics = [...topicSets[level]].sort();
    const requiredTopics = [...canonicalWorksheetTopics].sort();
    if (
      actualTopics.length !== WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL ||
      actualTopics.some((topic, i) => topic !== requiredTopics[i])
    ) {
      errors.push(
        `${level} topic coverage does not match all ${WORKSHEET_FOUNDATION_CONTEXTS_PER_LEVEL} canonical topics.`,
      );
    }
    for (const topic of canonicalWorksheetTopics) {
      const pair = `${level}:${topic}`;
      const revisions = pairRevisions.get(pair);
      const objectives = pairObjectives.get(pair);
      const objectiveTexts = pairObjectiveTexts.get(pair);
      if (!revisions?.has(1)) {
        errors.push(`${pair} is missing required foundation revision r1.`);
      }
      const expectsSecondRevision =
        secondRevisionTopicsByLevel[level].includes(topic);
      const expectedRevisionCount = expectsSecondRevision ? 2 : 1;
      if (
        (expectsSecondRevision && !revisions?.has(2)) ||
        (!expectsSecondRevision && revisions?.has(2)) ||
        revisions?.size !== expectedRevisionCount ||
        objectives?.size !== expectedRevisionCount ||
        objectiveTexts?.size !== expectedRevisionCount
      ) {
        errors.push(
          expectsSecondRevision
            ? `${pair} must retain foundation r1 and second revision r2 with two distinct objective IDs and texts.`
            : `${pair} must contain exactly one foundation r1 objective until a second revision is explicitly planned.`,
        );
      }
    }
  }

  const topicsPerLevel = Object.fromEntries(
    worksheetLevels.map((level) => [level, [...topicSets[level]].sort()]),
  ) as Record<WorksheetLevel, string[]>;
  return {
    ok: errors.length === 0,
    errors,
    totalSlots: slots.length,
    slotsPerLevel,
    topicsPerLevel,
  };
}

async function main() {
  const index = process.argv.indexOf("--file");
  const file = index >= 0 ? process.argv[index + 1] : "";
  if (!file) {
    throw new Error(
      "Usage: worksheet-matrix:verify -- --file <authoring-matrix.json>",
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
  const report = verifyWorksheetAuthoringMatrix(value);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
