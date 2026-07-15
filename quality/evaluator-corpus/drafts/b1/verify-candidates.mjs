#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const directory = new URL("./", import.meta.url);
const categories = [
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
];
const tagsByCategory = {
  do_not_overcorrect: ["do_not_overcorrect", "offset"],
  correction_accuracy: ["offset"],
  explanation_accuracy: ["offset"],
  decimal: ["decimal", "offset"],
  time: ["time", "offset"],
  abbreviation: ["abbreviation", "offset"],
  paragraph_boundary: ["paragraph_boundary", "whitespace", "offset"],
  offset: ["offset"],
  repeated_word: ["repeated_word", "offset"],
  missing_space: ["missing_space", "whitespace", "offset"],
  long_sentence: ["long_sentence", "offset"],
  topic_mapping: ["topic_mapping", "offset"],
  level_fit: ["level_fit", "do_not_overcorrect", "offset"],
  prompt_injection: ["prompt_injection"],
  expected_hold: ["expected_hold"],
};
const topicMapping = [
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
];
const canonicalTopics = new Set([
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
const holdVariants = [
  "invalid_structure",
  "offset_or_original_mismatch",
  "unmapped_topic",
  "unresolved_model_disagreement",
  "adjudicator_insufficient_evidence",
];
const holdReasons = new Set([
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
]);
const holdFixtureContracts = [
  {
    variant: "invalid_structure",
    allowedReasonCodes: ["generator_invalid"],
    faultFixture:
      "generator_flash_pro_and_gemini_return_invalid_feedback",
  },
  {
    variant: "invalid_structure",
    allowedReasonCodes: ["critic_invalid"],
    faultFixture: "critic_returns_decision_without_required_checks",
  },
  {
    variant: "offset_or_original_mismatch",
    allowedReasonCodes: ["critic_hash_mismatch"],
    faultFixture: "critic_original_text_hash_does_not_match",
  },
  {
    variant: "offset_or_original_mismatch",
    allowedReasonCodes: ["final_critic_hash_mismatch"],
    faultFixture: "final_critic_original_text_hash_mismatch",
  },
  {
    variant: "unmapped_topic",
    allowedReasonCodes: ["generator_invalid"],
    faultFixture: "generator_unmapped_topic_after_repair_attempt",
  },
  {
    variant: "unmapped_topic",
    allowedReasonCodes: ["adjudicator_invalid"],
    faultFixture: "adjudicator_unmapped_topic_after_resolution",
  },
  {
    variant: "unresolved_model_disagreement",
    allowedReasonCodes: ["adjudicator_unresolved"],
    faultFixture: "adjudicator_cannot_resolve_provider_disagreement",
  },
  {
    variant: "unresolved_model_disagreement",
    allowedReasonCodes: ["final_critic_uncertain"],
    faultFixture: "final_critic_uncertain_after_adjudication",
  },
  {
    variant: "adjudicator_insufficient_evidence",
    allowedReasonCodes: ["adjudicator_unresolved"],
    faultFixture: "adjudicator_missing_bound_supporting_evidence",
  },
  {
    variant: "adjudicator_insufficient_evidence",
    allowedReasonCodes: ["adjudicator_unresolved"],
    faultFixture: "adjudicator_returns_insufficient_evidence",
  },
];
const expectedStatusCounts = {
  correct: 26,
  acceptable_for_level: 14,
  minor_issue: 58,
  major_issue: 42,
};
const topKeys = [
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
];
const feedbackKeys = [
  "corrected_text",
  "line_status",
  "short_explanation",
  "changes",
];
const changeKeys = ["source_start", "source_end", "from", "to"];
const holdKeys = ["variant", "allowed_reason_codes", "fault_fixture"];
const forbiddenEvidenceKeys = new Set([
  "release_id",
  "actual_disposition",
  "decision_sha256",
  "output_sha256",
  "evaluator_version",
  "flash_model",
  "pro_model",
  "reviewer",
  "reviewer_id",
  "qualification",
  "reviewed_at",
  "structural_valid",
  "do_not_overcorrect_agrees",
  "correction_agrees",
  "explanation_agrees",
  "topic_mapping_agrees",
  "level_fit_agrees",
  "student_visible_before_release",
]);

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}
function unicodeSlice(value, start, end) {
  return Array.from(value).slice(start, end).join("");
}
function collectForbidden(value, path = "row", output = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      collectForbidden(child, `${path}[${index}]`, output),
    );
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenEvidenceKeys.has(key)) output.push(`${path}.${key}`);
      collectForbidden(child, `${path}.${key}`, output);
    }
  }
  return output;
}
function hasPiiLikeText(value) {
  return (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value) ||
    /\bhttps?:\/\//i.test(value) ||
    /\b(?:\+?\d[\s()./-]*){8,}\b/.test(value) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(
      value,
    )
  );
}

const names = (await readdir(directory))
  .filter((name) => name.endsWith("-candidates.jsonl"))
  .sort();
const rows = [];
const errors = [];
for (const name of names) {
  const source = await readFile(new URL(name, directory), "utf8");
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      rows.push(JSON.parse(lines[index]));
    } catch (error) {
      errors.push(`${name}:${index + 1} invalid JSON: ${error.message}`);
    }
  }
}
if (rows.length !== 150)
  errors.push(`Expected 150 rows, found ${rows.length}.`);
const seenIds = new Set();
const seenInputs = new Set();
const categoryCounts = Object.fromEntries(categories.map((c) => [c, 0]));
const variantCounts = Object.fromEntries(holdVariants.map((v) => [v, 0]));
const statusCounts = Object.fromEntries(
  Object.keys(expectedStatusCounts).map((status) => [status, 0]),
);
let accepted = 0;
let held = 0;

for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index];
  const label = row?.id ?? `row ${index + 1}`;
  if (!exactKeys(row, topKeys)) {
    errors.push(`${label} does not have the exact candidate keys.`);
    continue;
  }
  const expectedId = `B1-EVAL-${String(index + 1).padStart(3, "0")}`;
  const expectedCategory = categories[Math.floor(index / 10)];
  if (row.id !== expectedId) errors.push(`${label} expected id ${expectedId}.`);
  if (seenIds.has(row.id)) errors.push(`${label} duplicates an id.`);
  seenIds.add(row.id);
  if (row.level !== "B1" || row.expected_level !== "B1") {
    errors.push(`${label} is not bound to B1.`);
  }
  if (row.primary_category !== expectedCategory) {
    errors.push(`${label} expected category ${expectedCategory}.`);
  } else categoryCounts[expectedCategory] += 1;
  if (
    JSON.stringify(row.case_tags) !==
    JSON.stringify(tagsByCategory[expectedCategory])
  ) {
    errors.push(`${label} has category-tag drift.`);
  }
  if (
    row.candidate_schema_version !== 1 ||
    row.draft_status !== "candidate_unreviewed" ||
    row.counts_as_launch_evidence !== false
  ) {
    errors.push(`${label} fabricates or weakens candidate-only state.`);
  }
  if (
    typeof row.input_text !== "string" ||
    !row.input_text.trim() ||
    Array.from(row.input_text).length > 4000
  ) {
    errors.push(`${label} has invalid input text.`);
  } else {
    const normalized = row.input_text.normalize("NFC");
    if (seenInputs.has(normalized))
      errors.push(`${label} duplicates input text.`);
    seenInputs.add(normalized);
    if (hasPiiLikeText(row.input_text))
      errors.push(`${label} contains PII-like text.`);
  }
  const forbidden = collectForbidden(row);
  if (forbidden.length)
    errors.push(`${label} contains release evidence: ${forbidden.join(", ")}.`);
  if (
    row.expected_topic_slug !== null &&
    !canonicalTopics.has(row.expected_topic_slug)
  ) {
    errors.push(`${label} has a non-canonical expected topic.`);
  }
  const injectionExpected = expectedCategory === "prompt_injection";
  if (row.adversarial_instruction_must_be_ignored !== injectionExpected) {
    errors.push(`${label} has the wrong adversarial-instruction expectation.`);
  }

  if (expectedCategory === "expected_hold") {
    held += 1;
    if (
      row.expected_disposition !== "system_hold" ||
      row.expected_feedback !== null ||
      !exactKeys(row.expected_hold, holdKeys)
    ) {
      errors.push(`${label} does not define a private expected hold.`);
      continue;
    }
    const expectedContract = holdFixtureContracts[index - 140];
    const expectedVariant = holdVariants[Math.floor((index - 140) / 2)];
    if (
      !expectedContract ||
      expectedContract.variant !== expectedVariant ||
      row.expected_hold.variant !== expectedContract.variant
    ) {
      errors.push(`${label} expected hold variant ${expectedVariant}.`);
    } else variantCounts[expectedVariant] += 1;
    if (
      !Array.isArray(row.expected_hold.allowed_reason_codes) ||
      row.expected_hold.allowed_reason_codes.length === 0 ||
      new Set(row.expected_hold.allowed_reason_codes).size !==
        row.expected_hold.allowed_reason_codes.length ||
      row.expected_hold.allowed_reason_codes.some(
        (code) => !holdReasons.has(code),
      )
    ) {
      errors.push(`${label} has invalid allowed hold reasons.`);
    }
    if (
      typeof row.expected_hold.fault_fixture !== "string" ||
      !/^[a-z0-9][a-z0-9_]{4,79}$/.test(row.expected_hold.fault_fixture)
    ) {
      errors.push(`${label} has an invalid fault fixture.`);
    }
    if (
      !expectedContract ||
      JSON.stringify(row.expected_hold.allowed_reason_codes) !==
        JSON.stringify(expectedContract.allowedReasonCodes) ||
      row.expected_hold.fault_fixture !== expectedContract.faultFixture
    ) {
      errors.push(`${label} drifts from its deterministic hold fixture.`);
    }
    if (row.expected_topic_slug !== null) {
      errors.push(`${label} assigns a topic to a private system hold.`);
    }
    continue;
  }

  accepted += 1;
  if (
    row.expected_disposition !== "accepted_feedback" ||
    row.expected_hold !== null ||
    !exactKeys(row.expected_feedback, feedbackKeys)
  ) {
    errors.push(`${label} does not define accepted candidate feedback.`);
    continue;
  }
  const feedback = row.expected_feedback;
  if (
    typeof feedback.corrected_text !== "string" ||
    typeof feedback.short_explanation !== "string" ||
    feedback.short_explanation.trim().length < 18 ||
    !["correct", "acceptable_for_level", "minor_issue", "major_issue"].includes(
      feedback.line_status,
    ) ||
    !Array.isArray(feedback.changes)
  ) {
    errors.push(`${label} has an invalid feedback expectation.`);
    continue;
  }
  statusCounts[feedback.line_status] += 1;
  let cursor = 0;
  let rebuilt = "";
  for (const change of feedback.changes) {
    if (
      !exactKeys(change, changeKeys) ||
      !Number.isInteger(change.source_start) ||
      !Number.isInteger(change.source_end) ||
      change.source_start < cursor ||
      change.source_end < change.source_start ||
      typeof change.from !== "string" ||
      typeof change.to !== "string" ||
      unicodeSlice(row.input_text, change.source_start, change.source_end) !==
        change.from
    ) {
      errors.push(
        `${label} has an invalid or overlapping Unicode change span.`,
      );
      cursor = -1;
      break;
    }
    rebuilt +=
      unicodeSlice(row.input_text, cursor, change.source_start) + change.to;
    cursor = change.source_end;
  }
  if (cursor >= 0) {
    rebuilt += unicodeSlice(row.input_text, cursor);
    if (rebuilt !== feedback.corrected_text) {
      errors.push(`${label} changes do not reconstruct corrected_text.`);
    }
  }
  if (
    feedback.changes.length === 0 &&
    feedback.corrected_text !== row.input_text
  ) {
    errors.push(`${label} changes text without a declared span.`);
  }
  if (
    feedback.changes.length === 0 &&
    !["correct", "acceptable_for_level"].includes(feedback.line_status)
  ) {
    errors.push(`${label} has an issue status without a correction.`);
  }
  if (
    feedback.changes.length > 0 &&
    !["minor_issue", "major_issue"].includes(feedback.line_status)
  ) {
    errors.push(`${label} has correction spans without an issue status.`);
  }
  if (
    ["minor_issue", "major_issue"].includes(feedback.line_status) &&
    row.expected_topic_slug === null
  ) {
    errors.push(`${label} has an issue status without a canonical topic.`);
  }
  if (
    ["do_not_overcorrect", "level_fit"].includes(expectedCategory) &&
    (feedback.changes.length !== 0 ||
      feedback.corrected_text !== row.input_text)
  ) {
    errors.push(`${label} overcorrects a preservation case.`);
  }
  if (expectedCategory === "decimal" && !/\d+[,.]\d+/u.test(row.input_text)) {
    errors.push(`${label} does not exercise decimal punctuation.`);
  }
  if (
    expectedCategory === "time" &&
    !/\b\d{1,2}[.:]\d{2}\s*Uhr\b/u.test(row.input_text)
  ) {
    errors.push(`${label} does not exercise a clock-time token.`);
  }
  if (
    expectedCategory === "abbreviation" &&
    !/(?:\b\p{L}{1,4}\.|(?:\p{L}\.){2,})/iu.test(row.input_text)
  ) {
    errors.push(`${label} does not exercise an abbreviation token.`);
  }
  if (
    expectedCategory === "paragraph_boundary" &&
    !row.input_text.includes("\n\n")
  ) {
    errors.push(`${label} does not contain the planned paragraph boundary.`);
  }
  if (
    expectedCategory === "repeated_word" &&
    !/\b(\p{L}+)\s+\1\b/iu.test(row.input_text)
  ) {
    errors.push(`${label} does not contain an immediate repeated word.`);
  }
  if (
    expectedCategory === "repeated_word" &&
    row.expected_topic_slug !== "sentence-structure"
  ) {
    errors.push(`${label} must map the repeated token to sentence-structure.`);
  }
  if (
    expectedCategory === "missing_space" &&
    (feedback.changes.length !== 1 ||
      feedback.changes[0].from !== "" ||
      feedback.changes[0].to !== " ")
  ) {
    errors.push(`${label} is not an exact one-space insertion regression.`);
  }
  if (
    expectedCategory === "long_sentence" &&
    Array.from(row.input_text).length < 120
  ) {
    errors.push(`${label} is too short for the long-sentence allocation.`);
  }
  if (
    expectedCategory === "offset" &&
    (feedback.changes.length === 0 ||
      !/[^\x00-\x7f]/u.test(
        unicodeSlice(
          row.input_text,
          0,
          feedback.changes[feedback.changes.length - 1].source_end,
        ),
      ))
  ) {
    errors.push(`${label} does not exercise Unicode offset fidelity.`);
  }
  if (
    expectedCategory === "prompt_injection" &&
    (feedback.changes.length === 0 ||
      !/(?:ignor|system|modell|regel|anweisung|punktzahl|lehrkraft|lösung|behaupte|fehlerfrei)/iu.test(
        row.input_text,
      ))
  ) {
    errors.push(`${label} does not exercise embedded-instruction resistance.`);
  }
  if (expectedCategory === "prompt_injection") {
    const closingQuote = row.input_text.lastIndexOf("“");
    const protectedEnd =
      closingQuote < 0
        ? -1
        : Array.from(row.input_text.slice(0, closingQuote + 1)).length;
    if (
      closingQuote < 0 ||
      feedback.changes.some((change) => change.source_start < protectedEnd)
    ) {
      errors.push(
        `${label} changes or fails to preserve the quoted instruction.`,
      );
    }
  }
  if (expectedCategory === "topic_mapping") {
    const expectedTopic = topicMapping[index - 110];
    if (row.expected_topic_slug !== expectedTopic) {
      errors.push(`${label} expected topic ${expectedTopic}.`);
    }
  }
  if (
    expectedCategory === "paragraph_boundary" &&
    feedback.corrected_text.split("\n\n").length !==
      row.input_text.split("\n\n").length
  ) {
    errors.push(`${label} changes a paragraph boundary.`);
  }
}
if (accepted !== 140 || held !== 10) {
  errors.push(`Expected 140 accepted and 10 holds, found ${accepted}/${held}.`);
}
for (const category of categories) {
  if (categoryCounts[category] !== 10) {
    errors.push(`${category} has ${categoryCounts[category]}/10 candidates.`);
  }
}
for (const variant of holdVariants) {
  if (variantCounts[variant] !== 2) {
    errors.push(`${variant} has ${variantCounts[variant]}/2 candidates.`);
  }
}
const astralOffsetCases = rows.filter(
  (row) =>
    row.primary_category === "offset" &&
    typeof row.input_text === "string" &&
    /[\u{10000}-\u{10ffff}]/u.test(row.input_text),
).length;
if (astralOffsetCases < 1) {
  errors.push("The offset corpus lacks an astral Unicode code-point case.");
}
for (const [status, expectedCount] of Object.entries(expectedStatusCounts)) {
  if (statusCounts[status] !== expectedCount) {
    errors.push(
      `${status} has ${statusCounts[status]}/${expectedCount} candidates.`,
    );
  }
}
const report = {
  ok: errors.length === 0,
  errors,
  files: names,
  total: rows.length,
  accepted,
  held,
  category_counts: categoryCounts,
  hold_variant_counts: variantCounts,
  line_status_counts: statusCounts,
  astral_offset_cases: astralOffsetCases,
  candidate_only: true,
  human_reviewed: false,
  counts_as_launch_evidence: false,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
