import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const matrixPath = join(here, "..", "..", "authoring-matrix.json");
const reviewedSchemaPath = join(here, "..", "..", "reviewed-case.schema.json");
const fileArgumentIndex = process.argv.indexOf("--file");
const explicitCandidatePath =
  fileArgumentIndex >= 0 ? process.argv[fileArgumentIndex + 1] : null;
if (fileArgumentIndex >= 0 && !explicitCandidatePath) {
  throw new Error(
    "Usage: node verify-candidates.mjs [--file <candidates.jsonl>]",
  );
}
const candidatesPath = explicitCandidatePath
  ? resolve(process.cwd(), explicitCandidatePath)
  : join(here, "candidates.jsonl");

const [matrix, reviewedSchema, rawJsonl] = await Promise.all([
  readFile(matrixPath, "utf8").then(JSON.parse),
  readFile(reviewedSchemaPath, "utf8").then(JSON.parse),
  readFile(candidatesPath, "utf8"),
]);

const errors = [];
const lines = rawJsonl.split(/\r?\n/u).filter(Boolean);
const candidates = lines
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      errors.push(`Line ${index + 1} is not valid JSON: ${error.message}`);
      return null;
    }
  })
  .filter(Boolean);

const expectedTopKeys = [
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
].sort();

const expectedFeedbackKeys = ["corrected_text", "changes"].sort();
const expectedChangeKeys = [
  "source_start",
  "source_end",
  "corrected_start",
  "corrected_end",
  "original_text",
  "corrected_text",
  "status",
  "grammar_topic",
  "explanation",
].sort();
const holdFixtureKeys = [
  "failure_stage",
  "candidate_failure",
  "permitted_hold_reason_codes",
].sort();

const forbiddenEvidenceKeys = new Set([
  "release_id",
  "decision_sha256",
  "output_sha256",
  "evaluator_version",
  "flash_model",
  "pro_model",
  "actual_disposition",
  "hold_reason_code",
  "student_visible_before_release",
  "adversarial_instruction_resisted",
  "structural_valid",
  "do_not_overcorrect_agrees",
  "correction_agrees",
  "explanation_agrees",
  "topic_mapping_agrees",
  "level_fit_agrees",
  "reviewer",
  "reviewer_id",
  "qualification",
  "reviewed_at",
  "approved",
  "approval",
  "certified",
  "certification",
]);

const allowedPreservationRequirements = new Set([
  "preserve_unrelated_text",
  "preserve_decimal_punctuation",
  "preserve_time_token",
  "preserve_abbreviation_token",
  "preserve_paragraph_breaks",
  "preserve_whitespace",
  "preserve_exact_unicode_offsets",
  "remove_only_duplicate_token",
  "insert_only_missing_space",
  "preserve_long_sentence_structure",
  "preserve_quoted_untrusted_text",
]);

const majorIssueCaseNumbers = new Set([
  16, 17, 22, 26, 27, 63, 70, 77, 103, 112, 116, 117,
]);

const allowedGrammarTopics = new Set([
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
]);

const hasExactKeys = (value, expected) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const collectKeys = (value, keys = []) => {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectKeys(child, keys);
  }
  return keys;
};

const collectStrings = (value, strings = []) => {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, strings);
    return strings;
  }
  if (!value || typeof value !== "object") return strings;
  for (const child of Object.values(value)) collectStrings(child, strings);
  return strings;
};

const unicodeCharacters = (value) => Array.from(value);
const unicodeCharacterLength = (value) => unicodeCharacters(value).length;
const sliceByUnicodeOffsets = (value, start, end) =>
  unicodeCharacters(value).slice(start, end).join("");
const replaceByUnicodeOffsets = (value, start, end, replacement) =>
  [
    ...unicodeCharacters(value).slice(0, start),
    ...unicodeCharacters(replacement),
    ...unicodeCharacters(value).slice(end),
  ].join("");

const uniqueStrings = (value) =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && item.length > 0) &&
  new Set(value).size === value.length;

const arraysEqual = (left, right) =>
  Array.isArray(left) &&
  left.length === right.length &&
  left.every((item, index) => item === right[index]);

const countOccurrences = (text, token) => text.split(token).length - 1;

const categoryBlocks = matrix.allocation_template.blocks;
const categoryDefinitions = new Map(
  matrix.category_definitions.map((definition) => [
    definition.category_id,
    definition,
  ]),
);
const a1TopicPlan = matrix.special_allocations.topic_mapping_topics_by_level.A1;
const holdVariantPlan = matrix.special_allocations.expected_hold_variants;
const allowedHoldReasons = new Set(
  reviewedSchema.properties.hold_reason_code.oneOf[0].enum,
);
const holdVariantContracts = {
  invalid_structure: {
    failure_stage: "generator",
    allowed_reasons: new Set(["generator_invalid"]),
  },
  offset_or_original_mismatch: {
    failure_stage: "generator",
    allowed_reasons: new Set(["generator_invalid"]),
  },
  unmapped_topic: {
    failure_stage: "generator",
    allowed_reasons: new Set(["generator_invalid"]),
  },
  unresolved_model_disagreement: {
    failure_stage: "final_critic",
    allowed_reasons: new Set([
      "critic_disagreed",
      "adjudicator_unresolved",
      "final_critic_disagreed",
      "final_critic_uncertain",
    ]),
  },
  adjudicator_insufficient_evidence: {
    failure_stage: "adjudicator",
    allowed_reasons: new Set(["adjudicator_invalid", "adjudicator_unresolved"]),
  },
};

const categoryForNumber = (number) =>
  categoryBlocks.find(
    (block) =>
      number >= block.first_case_number && number <= block.last_case_number,
  );

const categoryCounts = Object.fromEntries(
  categoryBlocks.map((block) => [block.category_id, 0]),
);
const holdVariantCounts = Object.fromEntries(
  holdVariantPlan.map((entry) => [entry.variant_id, 0]),
);
const idSet = new Set();
const inputSet = new Set();
let acceptedCount = 0;
let holdCount = 0;

for (const [index, candidate] of candidates.entries()) {
  const label = candidate?.id ?? `line ${index + 1}`;
  if (!hasExactKeys(candidate, expectedTopKeys)) {
    errors.push(`${label} does not have the exact candidate-draft shape.`);
    continue;
  }

  const recursiveKeys = collectKeys(candidate);
  const forbidden = recursiveKeys.find((key) => forbiddenEvidenceKeys.has(key));
  if (forbidden) {
    errors.push(
      `${label} contains forbidden release-evidence key ${forbidden}.`,
    );
  }

  const idMatch = /^A1-EVAL-(\d{3})$/u.exec(candidate.id);
  const number = idMatch ? Number(idMatch[1]) : Number.NaN;
  if (!idMatch || number < 1 || number > 150) {
    errors.push(`${label} has an invalid A1 matrix identity.`);
    continue;
  }
  if (number !== index + 1) {
    errors.push(`${label} is out of sequence at JSONL line ${index + 1}.`);
  }
  if (idSet.has(candidate.id)) errors.push(`${label} is duplicated.`);
  idSet.add(candidate.id);

  const block = categoryForNumber(number);
  const definition = block
    ? categoryDefinitions.get(block.category_id)
    : undefined;
  if (!block || !definition) {
    errors.push(`${label} has no matrix category allocation.`);
    continue;
  }
  categoryCounts[block.category_id] += 1;

  if (
    candidate.schema_version !== 1 ||
    candidate.level !== "A1" ||
    candidate.primary_category !== block.category_id ||
    candidate.authoring_status !== "candidate_unreviewed" ||
    candidate.release_evidence_eligible !== false ||
    candidate.must_remain_private_until_review !== true
  ) {
    errors.push(`${label} drifts from the unreviewed A1 candidate contract.`);
  }
  if (!arraysEqual(candidate.case_tags, definition.planned_case_tags)) {
    errors.push(`${label} case tags do not exactly match its matrix category.`);
  }
  if (
    typeof candidate.input_text !== "string" ||
    !candidate.input_text.trim() ||
    candidate.input_text.length > 4_000
  ) {
    errors.push(`${label} has invalid writing input.`);
  }
  if (inputSet.has(candidate.input_text)) {
    errors.push(`${label} duplicates another input text.`);
  }
  inputSet.add(candidate.input_text);
  const candidateStrings = collectStrings(candidate);
  if (
    candidateStrings.some(
      (value) =>
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value) ||
        /https?:\/\//iu.test(value) ||
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu.test(
          value,
        ) ||
        /(?:\+|00)\d[\d .()/-]{7,}\d/u.test(value) ||
        /\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/iu.test(value) ||
        /\b0\d{2,5}[ /.-]\d[\d /.-]{5,}\d\b/u.test(value),
    )
  ) {
    errors.push(`${label} contains PII-like or URL content in a draft field.`);
  }
  const authoredAssertionStrings = [
    ...(candidate.expected_feedback?.changes ?? []).map(
      (change) => change.explanation,
    ),
    candidate.hold_fixture?.candidate_failure,
  ].filter((value) => typeof value === "string");
  if (
    authoredAssertionStrings.some((value) =>
      /\b(?:reviewed|reviewer|qualified|approved|approval|certified|certification|attested|expert[- ]?verified)\b/iu.test(
        value,
      ),
    )
  ) {
    errors.push(`${label} contains a textual review or certification claim.`);
  }
  if (
    candidate.expected_adversarial_instruction_resisted !==
    candidate.case_tags.includes("prompt_injection")
  ) {
    errors.push(`${label} has an inconsistent prompt-injection expectation.`);
  }
  if (
    !uniqueStrings(candidate.expected_topic_slugs) ||
    !uniqueStrings(candidate.preservation_requirements) ||
    candidate.preservation_requirements.some(
      (item) => !allowedPreservationRequirements.has(item),
    )
  ) {
    errors.push(`${label} has invalid topics or preservation requirements.`);
  }

  if (candidate.expected_disposition === "accepted_feedback") {
    acceptedCount += 1;
    if (
      candidate.hold_variant !== null ||
      candidate.hold_fixture !== null ||
      !hasExactKeys(candidate.expected_feedback, expectedFeedbackKeys)
    ) {
      errors.push(`${label} has an invalid accepted-feedback draft boundary.`);
      continue;
    }
    const { corrected_text: correctedText, changes } =
      candidate.expected_feedback;
    if (typeof correctedText !== "string" || !Array.isArray(changes)) {
      errors.push(`${label} has malformed expected feedback.`);
      continue;
    }

    let reconstructed = candidate.input_text;
    let priorSourceEnd = -1;
    let priorCorrectedEnd = -1;
    let cumulativeCorrectedDelta = 0;
    const sourceCharacterCount = unicodeCharacterLength(candidate.input_text);
    const correctedCharacterCount = unicodeCharacterLength(correctedText);
    for (const change of changes) {
      if (!hasExactKeys(change, expectedChangeKeys)) {
        errors.push(`${label} has a change outside the exact draft shape.`);
        continue;
      }
      if (
        !Number.isInteger(change.source_start) ||
        !Number.isInteger(change.source_end) ||
        !Number.isInteger(change.corrected_start) ||
        !Number.isInteger(change.corrected_end) ||
        change.source_start < 0 ||
        change.source_end <= change.source_start ||
        change.source_end > sourceCharacterCount ||
        change.corrected_start < 0 ||
        change.corrected_end < change.corrected_start ||
        change.corrected_end > correctedCharacterCount ||
        change.source_start < priorSourceEnd ||
        change.corrected_start < priorCorrectedEnd
      ) {
        errors.push(
          `${label} has invalid or overlapping Unicode-character offsets.`,
        );
      }
      priorSourceEnd = change.source_end;
      priorCorrectedEnd = change.corrected_end;
      const expectedCorrectedStart =
        change.source_start + cumulativeCorrectedDelta;
      const expectedCorrectedEnd =
        expectedCorrectedStart + unicodeCharacterLength(change.corrected_text);
      if (
        change.corrected_start !== expectedCorrectedStart ||
        change.corrected_end !== expectedCorrectedEnd
      ) {
        errors.push(
          `${label} corrected offsets do not match the exact cumulative replacement position.`,
        );
      }
      cumulativeCorrectedDelta +=
        unicodeCharacterLength(change.corrected_text) -
        unicodeCharacterLength(change.original_text);
      if (
        sliceByUnicodeOffsets(
          candidate.input_text,
          change.source_start,
          change.source_end,
        ) !== change.original_text ||
        sliceByUnicodeOffsets(
          correctedText,
          change.corrected_start,
          change.corrected_end,
        ) !== change.corrected_text
      ) {
        errors.push(
          `${label} offsets do not bind the declared original/correction.`,
        );
      }
      if (
        !allowedGrammarTopics.has(change.grammar_topic) ||
        change.status !==
          (majorIssueCaseNumbers.has(number) ? "major_issue" : "minor_issue") ||
        typeof change.explanation !== "string" ||
        change.explanation.trim().length < 30 ||
        !change.original_text ||
        !change.corrected_text ||
        change.original_text === change.corrected_text
      ) {
        errors.push(`${label} has an incomplete expected correction contract.`);
      }
    }

    for (const change of [...changes].reverse()) {
      reconstructed = replaceByUnicodeOffsets(
        reconstructed,
        change.source_start,
        change.source_end,
        change.corrected_text,
      );
    }
    if (reconstructed !== correctedText) {
      errors.push(
        `${label} corrected text is not reconstructed by its changes.`,
      );
    }
    const derivedTopics = [
      ...new Set(changes.map((change) => change.grammar_topic)),
    ];
    if (!arraysEqual(candidate.expected_topic_slugs, derivedTopics)) {
      errors.push(`${label} topic slugs do not reconcile to expected changes.`);
    }

    if (
      ["do_not_overcorrect", "level_fit", "prompt_injection"].includes(
        candidate.primary_category,
      ) &&
      changes.length !== 0
    ) {
      errors.push(`${label} must remain unchanged for its primary category.`);
    }
    if (
      ["correction_accuracy", "explanation_accuracy", "topic_mapping"].includes(
        candidate.primary_category,
      ) &&
      changes.length !== 1
    ) {
      errors.push(`${label} must contain exactly one focused correction.`);
    }

    if (candidate.primary_category === "decimal") {
      const before = candidate.input_text.match(/\b\d+,\d+\b/gu) ?? [];
      const after = correctedText.match(/\b\d+,\d+\b/gu) ?? [];
      if (before.length === 0 || !arraysEqual(before, after)) {
        errors.push(`${label} does not preserve its comma-decimal tokens.`);
      }
    }
    if (candidate.primary_category === "time") {
      const before = candidate.input_text.match(/\b\d{1,2}[.:]\d{2}\b/gu) ?? [];
      const after = correctedText.match(/\b\d{1,2}[.:]\d{2}\b/gu) ?? [];
      if (before.length === 0 || !arraysEqual(before, after)) {
        errors.push(`${label} does not preserve its time token.`);
      }
    }
    if (candidate.primary_category === "abbreviation") {
      const abbreviationPattern =
        /\b(?:z\.[ \u00a0\u202f]?B\.|Dr\.|ca\.|Nr\.|Tel\.|usw\.|d\.[ \u00a0\u202f]?h\.|bzw\.|Prof\.|u\.[ \u00a0\u202f]?a\.)/gu;
      const before = candidate.input_text.match(abbreviationPattern) ?? [];
      const after = correctedText.match(abbreviationPattern) ?? [];
      if (before.length === 0 || !arraysEqual(before, after)) {
        errors.push(`${label} does not preserve its abbreviation token.`);
      }
    }
    if (
      candidate.primary_category === "paragraph_boundary" &&
      (countOccurrences(candidate.input_text, "\n\n") !== 1 ||
        countOccurrences(correctedText, "\n\n") !== 1)
    ) {
      errors.push(`${label} does not preserve exactly one paragraph boundary.`);
    }
    if (candidate.primary_category === "repeated_word") {
      if (
        changes.length !== 1 ||
        !/(\b[\p{L}]+\b)\s+\1/iu.test(changes[0]?.original_text ?? "")
      ) {
        errors.push(`${label} does not isolate one repeated-word defect.`);
      }
    }
    if (candidate.primary_category === "missing_space") {
      if (
        changes.length !== 1 ||
        changes[0].corrected_text.replaceAll(" ", "") !==
          changes[0].original_text.replaceAll(" ", "") ||
        countOccurrences(changes[0].corrected_text, " ") !==
          countOccurrences(changes[0].original_text, " ") + 1
      ) {
        errors.push(`${label} does not isolate one missing-space defect.`);
      }
    }
    if (
      candidate.primary_category === "long_sentence" &&
      candidate.input_text.length < 130
    ) {
      errors.push(
        `${label} is too short for the long-sentence regression block.`,
      );
    }
    if (candidate.primary_category === "prompt_injection") {
      if (
        !/[„“"]/u.test(candidate.input_text) ||
        !/(ignoriere|bewerte|gib|zeige|sende|ändere|markiere|prüfe|finde|schreib|mach|nutze|behandle)/iu.test(
          candidate.input_text,
        )
      ) {
        errors.push(
          `${label} lacks a concrete embedded adversarial instruction.`,
        );
      }
    }
  } else if (candidate.expected_disposition === "system_hold") {
    holdCount += 1;
    if (
      candidate.expected_feedback !== null ||
      candidate.expected_topic_slugs.length !== 0 ||
      candidate.preservation_requirements.length !== 0 ||
      !hasExactKeys(candidate.hold_fixture, holdFixtureKeys) ||
      !Object.hasOwn(holdVariantCounts, candidate.hold_variant)
    ) {
      errors.push(`${label} has an invalid expected private-hold draft.`);
      continue;
    }
    holdVariantCounts[candidate.hold_variant] += 1;
    const holdContract = holdVariantContracts[candidate.hold_variant];
    if (
      !["generator", "critic", "adjudicator", "final_critic"].includes(
        candidate.hold_fixture.failure_stage,
      ) ||
      typeof candidate.hold_fixture.candidate_failure !== "string" ||
      candidate.hold_fixture.candidate_failure.length < 30 ||
      !uniqueStrings(candidate.hold_fixture.permitted_hold_reason_codes) ||
      candidate.hold_fixture.permitted_hold_reason_codes.some(
        (reason) => !allowedHoldReasons.has(reason),
      ) ||
      !holdContract ||
      candidate.hold_fixture.failure_stage !== holdContract.failure_stage ||
      candidate.hold_fixture.permitted_hold_reason_codes.some(
        (reason) => !holdContract.allowed_reasons.has(reason),
      )
    ) {
      errors.push(`${label} has an invalid hold-fixture contract.`);
    }
  } else {
    errors.push(`${label} has an unsupported expected disposition.`);
  }
}

if (candidates.length !== 150 || idSet.size !== 150 || inputSet.size !== 150) {
  errors.push(
    `Expected 150 unique A1 cases and inputs; found ${candidates.length} rows, ${idSet.size} ids, and ${inputSet.size} inputs.`,
  );
}
if (acceptedCount !== 140 || holdCount !== 10) {
  errors.push(
    `Expected 140 accepted candidates and 10 holds; found ${acceptedCount} and ${holdCount}.`,
  );
}
for (const block of categoryBlocks) {
  if (categoryCounts[block.category_id] !== 10) {
    errors.push(
      `${block.category_id} has ${categoryCounts[block.category_id]} cases instead of 10.`,
    );
  }
}
for (const variant of holdVariantPlan) {
  if (holdVariantCounts[variant.variant_id] !== variant.slots_per_level) {
    errors.push(
      `${variant.variant_id} has ${holdVariantCounts[variant.variant_id]} holds instead of ${variant.slots_per_level}.`,
    );
  }
}
for (const [index, topic] of a1TopicPlan.entries()) {
  const candidate = candidates[110 + index];
  if (
    candidate?.id !== `A1-EVAL-${String(111 + index).padStart(3, "0")}` ||
    !arraysEqual(candidate.expected_topic_slugs, [topic])
  ) {
    errors.push(
      `A1 topic-mapping slot ${111 + index} must map exactly to ${topic}.`,
    );
  }
}

const result = {
  ok: errors.length === 0,
  errors,
  candidate_count: candidates.length,
  accepted_candidates: acceptedCount,
  expected_private_holds: holdCount,
  category_counts: categoryCounts,
  hold_variant_counts: holdVariantCounts,
  topic_mapping_topics: candidates
    .slice(110, 120)
    .map((candidate) => candidate.expected_topic_slugs[0]),
  contains_release_evidence: false,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
