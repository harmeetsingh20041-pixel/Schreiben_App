import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { canonicalWorksheetTemplateContexts } from "./verify-worksheet-authoring-matrix";

type Level = "A1" | "A2" | "B1" | "B2";
type Difficulty = "easy" | "medium" | "hard";
type WorksheetSource = "manual_import" | "teacher_created";
type EvaluationMode = "local_exact" | "open_evaluation";

type MiniLesson = {
  short_explanation: string;
  key_rule: string;
  correct_examples: string[];
  common_mistake_warning: string;
  what_to_revise: string;
};

export type QuestionRubric = {
  criteria: string[];
  sample_answer: string;
};

export type ImportQuestion = {
  question_number: number;
  question_type: string;
  prompt: string;
  options: string[];
  correct_answer: string;
  accepted_answers: string[];
  rubric: QuestionRubric | null;
  answer_contract_version: 1;
  explanation: string;
  evaluation_mode: EvaluationMode;
};

export type WorksheetImport = {
  title: string;
  level: Level;
  grammar_topic: {
    slug?: string;
    name?: string;
  };
  difficulty: Difficulty;
  visibility: "workspace" | "private";
  source: WorksheetSource;
  source_label?: string;
  tags: string[];
  mini_lesson: MiniLesson;
  questions: ImportQuestion[];
};

export type WorksheetBankCertification = {
  review_checklist: {
    structural_valid: true;
    ambiguity_free: true;
    no_answer_leakage: true;
    level_fit: true;
    topic_fit: true;
    type_balance: true;
    scoring_safe: true;
  };
  review_notes: string;
  release_notes: string;
};

type CliArgs = {
  file: string;
  workspaceId: string;
  createdBy: string | null;
  dryRun: boolean;
  linkedDb: boolean;
  publishToBank: boolean;
  templateKey: string;
  bankReviewedBy: string | null;
  bankReleasedBy: string | null;
};

const levels = new Set(["A1", "A2", "B1", "B2"]);
const difficulties = new Set(["easy", "medium", "hard"]);
const sources = new Set(["manual_import", "teacher_created"]);
const localExactTypes = new Set(["multiple_choice", "fill_blank"]);
const openEvaluationTypes = new Set([
  "fill_blank",
  "sentence_correction",
  "word_order",
  "transformation",
  "rewrite_sentence",
  "mini_writing",
]);
const manualReviewSentinels = new Set([
  "manual_review",
  "manual review",
  "open_review",
  "flexible_review",
  "requires_review",
]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const templateKeyPattern = /^[a-z0-9][a-z0-9._-]{5,119}$/;
const bankChecklistKeys = [
  "structural_valid",
  "ambiguity_free",
  "no_answer_leakage",
  "level_fit",
  "topic_fit",
  "type_balance",
  "scoring_safe",
] as const;
const blockedArtifactStatuses = new Set([
  "draft",
  "draft_unapproved",
  "not_certified",
  "uncertified",
  "unapproved",
]);
const artifactStatusKeys = new Set([
  "authoring_status",
  "certification_status",
  "approval_status",
]);
const artifactProvenanceKeys = new Set([
  "provenance",
  "source_label",
  "source_provenance",
]);
const canonicalWorksheetContextByTemplateKey = new Map(
  canonicalWorksheetTemplateContexts.map((context) => [
    context.templateKey,
    context,
  ]),
);

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  pnpm --dir scripts import:practice-worksheet --file <json> --workspace-id <uuid> --dry-run",
      "  pnpm --dir scripts import:practice-worksheet --file <json> --workspace-id <uuid> --created-by <active-owner-or-teacher-profile-id> --linked-db",
      "  pnpm --dir scripts import:practice-worksheet --file <json-with-bank-certification> --workspace-id <uuid> --publish-to-bank --template-key <stable-key> --bank-reviewed-by <qualified-profile-id> --bank-released-by <qualified-profile-id> --linked-db",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    file: "",
    workspaceId: "",
    createdBy: null,
    dryRun: false,
    linkedDb: false,
    publishToBank: false,
    templateKey: "",
    bankReviewedBy: null,
    bankReleasedBy: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      args.file = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--workspace-id") {
      args.workspaceId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--created-by") {
      args.createdBy = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--linked-db") {
      args.linkedDb = true;
      continue;
    }
    if (arg === "--publish-to-bank") {
      args.publishToBank = true;
      continue;
    }
    if (arg === "--template-key") {
      args.templateKey = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--bank-reviewed-by") {
      args.bankReviewedBy = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--bank-released-by") {
      args.bankReleasedBy = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    usage();
  }

  if (!args.file || !args.workspaceId) usage();
  if (!uuidPattern.test(args.workspaceId)) {
    throw new Error("--workspace-id must be a UUID.");
  }
  if (args.createdBy && !uuidPattern.test(args.createdBy)) {
    throw new Error("--created-by must be a UUID.");
  }
  if (args.bankReviewedBy && !uuidPattern.test(args.bankReviewedBy)) {
    throw new Error("--bank-reviewed-by must be a UUID.");
  }
  if (args.bankReleasedBy && !uuidPattern.test(args.bankReleasedBy)) {
    throw new Error("--bank-released-by must be a UUID.");
  }
  if (args.publishToBank) {
    if (!templateKeyPattern.test(args.templateKey)) {
      throw new Error(
        "--template-key must be a stable 6-120 character lowercase bank key.",
      );
    }
    if (!args.bankReviewedBy || !args.bankReleasedBy) {
      throw new Error(
        "--bank-reviewed-by and --bank-released-by are required for --publish-to-bank.",
      );
    }
    if (args.createdBy) {
      throw new Error(
        "--created-by is for workspace-only imports; bank publication uses the explicit reviewer and releaser IDs.",
      );
    }
  } else if (args.templateKey || args.bankReviewedBy || args.bankReleasedBy) {
    throw new Error("Bank publication flags require --publish-to-bank.");
  }
  if (args.linkedDb && !args.dryRun && !args.publishToBank && !args.createdBy) {
    throw new Error(
      "--created-by is required for --linked-db and must identify an active owner or teacher in the target workspace.",
    );
  }
  return args;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function cleanString(value: unknown, maxLength = 1000) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

function normalizeArtifactStatus(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s-]+/g, "_");
}

function containsBlockedArtifactMarker(value: string) {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ");
  return (
    /\b(?:draft|unapproved|uncertified)\b/.test(normalized) ||
    /\bnot certified\b/.test(normalized)
  );
}

/**
 * Prevent an authoring draft from crossing a real import/publication boundary.
 * Structural dry-run validation intentionally remains separate so unfinished
 * worksheets can still be checked locally before qualified review.
 */
export function assertWorksheetArtifactEligibleForWrite(value: unknown) {
  const visited = new WeakSet<object>();

  const inspect = (current: unknown, path: string): void => {
    if (
      typeof current === "string" &&
      blockedArtifactStatuses.has(normalizeArtifactStatus(current))
    ) {
      throw new Error(
        `Worksheet artifact is not eligible for import or publication: ${path} retains the blocked marker ${JSON.stringify(current)}. Local --dry-run validation is allowed, but a certified release artifact must use release-safe provenance.`,
      );
    }
    if (!current || typeof current !== "object") return;
    if (visited.has(current)) return;
    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach((entry, index) => inspect(entry, `${path}[${index}]`));
      return;
    }

    for (const [key, entry] of Object.entries(current)) {
      const normalizedKey = normalizeArtifactStatus(key);
      const entryPath = `${path}.${key}`;
      if (
        artifactStatusKeys.has(normalizedKey) &&
        typeof entry === "string" &&
        blockedArtifactStatuses.has(normalizeArtifactStatus(entry))
      ) {
        throw new Error(
          `Worksheet artifact is not eligible for import or publication: ${entryPath} is ${JSON.stringify(entry)}. Local --dry-run validation is allowed, but a qualified review and certified release artifact are required before a real write.`,
        );
      }
      if (
        typeof entry === "string" &&
        blockedArtifactStatuses.has(normalizeArtifactStatus(entry))
      ) {
        throw new Error(
          `Worksheet artifact is not eligible for import or publication: ${entryPath} retains the blocked marker ${JSON.stringify(entry)}. Local --dry-run validation is allowed, but a certified release artifact must use release-safe provenance.`,
        );
      }
      if (
        artifactProvenanceKeys.has(normalizedKey) &&
        typeof entry === "string" &&
        containsBlockedArtifactMarker(entry)
      ) {
        throw new Error(
          `Worksheet artifact is not eligible for import or publication: ${entryPath} retains draft, unapproved, or not-certified provenance. Local --dry-run validation is allowed, but a certified release artifact must use release-safe provenance.`,
        );
      }
      inspect(entry, entryPath);
      if (normalizedKey === "draft_metadata") {
        throw new Error(
          `Worksheet artifact is not eligible for import or publication: ${entryPath} is draft provenance. Local --dry-run validation is allowed, but a certified release artifact must not retain draft metadata.`,
        );
      }
    }
  };

  inspect(value, "worksheet");
}

export function assertCertifiedWorksheetMatrixIdentity(args: {
  worksheet: WorksheetImport;
  templateKey: string;
}) {
  if (
    !args.worksheet.source_label ||
    args.worksheet.source_label.length < 8 ||
    containsBlockedArtifactMarker(args.worksheet.source_label)
  ) {
    throw new Error(
      "Certified bank publication requires a release-safe source_label of at least 8 characters with no draft, unapproved, or not-certified provenance.",
    );
  }

  const context = canonicalWorksheetContextByTemplateKey.get(args.templateKey);
  if (!context) {
    throw new Error(
      `Certified bank template_key ${JSON.stringify(args.templateKey)} is not present in quality/worksheet-bank/authoring-matrix.json.`,
    );
  }

  const topicSlug = args.worksheet.grammar_topic.slug;
  if (
    args.worksheet.level !== context.level ||
    topicSlug !== context.topicSlug
  ) {
    throw new Error(
      `Certified bank matrix identity mismatch: template_key ${JSON.stringify(args.templateKey)} requires level ${context.level} and grammar_topic.slug ${JSON.stringify(context.topicSlug)}; received level ${args.worksheet.level} and grammar_topic.slug ${JSON.stringify(topicSlug ?? null)}.`,
    );
  }
}

export function validateBankCertification(
  value: unknown,
): WorksheetBankCertification {
  const worksheetRecord = asRecord(value, "worksheet");
  const certification = asRecord(
    worksheetRecord.bank_certification,
    "bank_certification",
  );
  const certificationKeys = Object.keys(certification).sort();
  const expectedCertificationKeys = [
    "release_notes",
    "review_checklist",
    "review_notes",
  ];
  if (
    certificationKeys.length !== expectedCertificationKeys.length ||
    certificationKeys.some(
      (key, index) => key !== expectedCertificationKeys[index],
    )
  ) {
    throw new Error(
      "bank_certification must contain only review_checklist, review_notes, and release_notes.",
    );
  }

  const checklist = asRecord(
    certification.review_checklist,
    "bank_certification.review_checklist",
  );
  const actualChecklistKeys = Object.keys(checklist).sort();
  const expectedChecklistKeys = [...bankChecklistKeys].sort();
  if (
    actualChecklistKeys.length !== expectedChecklistKeys.length ||
    actualChecklistKeys.some(
      (key, index) => key !== expectedChecklistKeys[index],
    ) ||
    bankChecklistKeys.some((key) => checklist[key] !== true)
  ) {
    throw new Error(
      "bank_certification.review_checklist must contain exactly the seven required checks, all explicitly true.",
    );
  }

  const reviewNotes = cleanString(certification.review_notes, 1000);
  const releaseNotes = cleanString(certification.release_notes, 1000);
  if (reviewNotes.length < 8 || releaseNotes.length < 8) {
    throw new Error(
      "bank_certification review_notes and release_notes must each contain 8-1000 characters.",
    );
  }

  return {
    review_checklist: Object.fromEntries(
      bankChecklistKeys.map((key) => [key, true]),
    ) as WorksheetBankCertification["review_checklist"],
    review_notes: reviewNotes,
    release_notes: releaseNotes,
  };
}

function normalizeText(value: string) {
  return value
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("de-DE")
    .replace(/\s+/g, " ");
}

function normalizePromptKey(value: string) {
  return normalizeText(value).replace(/[_\W]+/g, "");
}

function normalizeQuestionType(value: unknown) {
  const raw = cleanString(value, 60)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return raw === "correction" ? "sentence_correction" : raw;
}

function containsForbiddenStudentText(value: string) {
  return /\b(deepseek|ai model|language model|chatgpt|answer key|scoring metadata|automatic ai correction|manual[_ -]?review)\b/i.test(
    value,
  );
}

function assertNoForbiddenText(label: string, values: string[]) {
  const combined = values.join(" ");
  if (containsForbiddenStudentText(combined)) {
    throw new Error(
      `${label} contains forbidden student-facing internal text.`,
    );
  }
}

function isManualReviewSentinel(value: string) {
  return manualReviewSentinels.has(normalizeText(value));
}

function validateStringArray(args: {
  value: unknown;
  label: string;
  minItems: number;
  maxItems: number;
  maxLength: number;
}) {
  if (!Array.isArray(args.value)) {
    throw new Error(`${args.label} must be an array of plain strings.`);
  }
  if (args.value.length < args.minItems || args.value.length > args.maxItems) {
    throw new Error(
      `${args.label} must contain ${args.minItems}-${args.maxItems} entries.`,
    );
  }

  const values = args.value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`${args.label} must contain only plain strings.`);
    }
    const normalized = entry.normalize("NFC").trim().replace(/\s+/g, " ");
    if (!normalized || normalized.length > args.maxLength) {
      throw new Error(
        `${args.label} entries must be 1-${args.maxLength} characters.`,
      );
    }
    if (isManualReviewSentinel(normalized)) {
      throw new Error(
        `${args.label} must not contain a manual-review sentinel.`,
      );
    }
    return normalized;
  });

  if (new Set(values.map(normalizeText)).size !== values.length) {
    throw new Error(
      `${args.label} entries must be unique after normalization.`,
    );
  }
  return values;
}

function validateAcceptedAnswers(
  value: unknown,
  questionNumber: number,
  required: boolean,
) {
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(
        `Question ${questionNumber}: accepted_answers is required for local_exact fill_blank questions.`,
      );
    }
    return [];
  }
  return validateStringArray({
    value,
    label: `Question ${questionNumber}: accepted_answers`,
    minItems: required ? 1 : 0,
    maxItems: 12,
    maxLength: 160,
  });
}

function validateRubric(
  value: unknown,
  questionNumber: number,
): QuestionRubric {
  const record = asRecord(value, `Question ${questionNumber}: rubric`);
  const criteria = validateStringArray({
    value: record.criteria,
    label: `Question ${questionNumber}: rubric.criteria`,
    minItems: 1,
    maxItems: 6,
    maxLength: 240,
  });
  if (typeof record.sample_answer !== "string") {
    throw new Error(
      `Question ${questionNumber}: rubric.sample_answer must be a real sample answer.`,
    );
  }
  const sampleAnswer = record.sample_answer
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ");
  if (
    !sampleAnswer ||
    sampleAnswer.length > 500 ||
    isManualReviewSentinel(sampleAnswer)
  ) {
    throw new Error(
      `Question ${questionNumber}: rubric.sample_answer must be a real 1-500 character answer, not a sentinel.`,
    );
  }
  assertNoForbiddenText(`Question ${questionNumber} rubric`, [
    ...criteria,
    sampleAnswer,
  ]);
  return { criteria, sample_answer: sampleAnswer };
}

function extractClosedWordBank(prompt: string) {
  const match = prompt.match(
    /(?:closed\s+)?(?:word\s+bank|word\s+list|wortbank|wortliste)\s*[:：]?\s*(?:\[([^\]]+)\]|\(([^)]+)\))/iu,
  );
  if (!match) return null;
  const choices = (match[1] ?? match[2] ?? "")
    .split(/[,;|/]/)
    .map((choice) => choice.normalize("NFC").trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (
    choices.length < 2 ||
    new Set(choices.map(normalizeText)).size !== choices.length
  ) {
    return null;
  }
  return choices;
}

function isConstrainedFillPrompt(prompt: string, acceptedAnswers: string[]) {
  const articleConstraint =
    /\b(?:definite|indefinite|possessive)\s+article\b/i.test(prompt) ||
    /\b(?:bestimmt\w*|unbestimmt\w*|possessiv\w*)\s+artikel\b/iu.test(prompt);
  const namedBaseFormConstraint =
    /\b(?:correct|inflected|conjugated)\s+form\s+of\s+["'„“]?\p{L}[\p{L}-]*/iu.test(
      prompt,
    ) ||
    /\b(?:richtig\w*|passend\w*|konjugiert\w*|dekliniert\w*)\s+form\s+(?:von|des\s+wortes)\s+["'„“]?\p{L}[\p{L}-]*/iu.test(
      prompt,
    );
  if (articleConstraint || namedBaseFormConstraint) return true;

  const wordBank = extractClosedWordBank(prompt);
  if (!wordBank) return false;
  const wordBankKeys = new Set(wordBank.map(normalizeText));
  return acceptedAnswers.every((answer) =>
    wordBankKeys.has(normalizeText(answer)),
  );
}

function validateMiniLesson(value: unknown): MiniLesson {
  const record = asRecord(value, "mini_lesson");
  const miniLesson = {
    short_explanation: cleanString(record.short_explanation, 500),
    key_rule: cleanString(record.key_rule, 400),
    correct_examples: Array.isArray(record.correct_examples)
      ? record.correct_examples
          .map((example) => cleanString(example, 180))
          .filter(Boolean)
          .slice(0, 2)
      : [],
    common_mistake_warning: cleanString(record.common_mistake_warning, 300),
    what_to_revise: cleanString(record.what_to_revise, 300),
  };

  if (
    !miniLesson.short_explanation ||
    !miniLesson.key_rule ||
    miniLesson.correct_examples.length === 0
  ) {
    throw new Error(
      "mini_lesson must include short_explanation, key_rule, and at least one correct example.",
    );
  }
  assertNoForbiddenText("mini_lesson", [
    miniLesson.short_explanation,
    miniLesson.key_rule,
    ...miniLesson.correct_examples,
    miniLesson.common_mistake_warning,
    miniLesson.what_to_revise,
  ]);
  return miniLesson;
}

function validateOptions(value: unknown, questionNumber: number) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `Question ${questionNumber}: options must be an array of plain strings.`,
    );
  }
  const options = value.map((option) => {
    if (typeof option !== "string") {
      throw new Error(
        `Question ${questionNumber}: options must not contain objects or hidden metadata.`,
      );
    }
    const cleaned = cleanString(option, 160);
    if (!cleaned)
      throw new Error(
        `Question ${questionNumber}: options must not contain blank strings.`,
      );
    return cleaned;
  });
  if (new Set(options.map(normalizeText)).size !== options.length) {
    throw new Error(
      `Question ${questionNumber}: options must not be duplicated.`,
    );
  }
  assertNoForbiddenText(`Question ${questionNumber} options`, options);
  return options;
}

function validateLocalExactQuestion(question: ImportQuestion) {
  if (!localExactTypes.has(question.question_type)) {
    throw new Error(
      `Question ${question.question_number}: ${question.question_type} is not a local_exact question type.`,
    );
  }
  if (!question.correct_answer) {
    throw new Error(
      `Question ${question.question_number}: local_exact questions need a correct_answer.`,
    );
  }

  if (question.question_type === "multiple_choice") {
    if (question.options.length < 3 || question.options.length > 6) {
      throw new Error(
        `Question ${question.question_number}: multiple_choice needs 3-6 options.`,
      );
    }
    const matchCount = question.options
      .map(normalizeText)
      .filter(
        (option) => option === normalizeText(question.correct_answer),
      ).length;
    if (matchCount !== 1) {
      throw new Error(
        `Question ${question.question_number}: multiple_choice correct answer must appear exactly once.`,
      );
    }
    if (
      question.accepted_answers.length !== 1 ||
      normalizeText(question.accepted_answers[0]) !==
        normalizeText(question.correct_answer)
    ) {
      throw new Error(
        `Question ${question.question_number}: multiple_choice accepted_answers must contain only the canonical correct_answer.`,
      );
    }
  }

  if (question.question_type === "fill_blank") {
    const underscoreRuns = question.prompt.match(/_+/g) ?? [];
    if (
      underscoreRuns.length !== 1 ||
      underscoreRuns[0] !== "___" ||
      /\[blank\]|\(\s*blank\s*\)/i.test(question.prompt)
    ) {
      throw new Error(
        `Question ${question.question_number}: fill_blank must include exactly one ___ marker.`,
      );
    }
    const adjacentHint = question.prompt.match(
      /___\s*(?:\[([^\]]+)\]|\(([^)]+)\))/u,
    );
    const adjacentHintKey = adjacentHint
      ? normalizeText(adjacentHint[1] ?? adjacentHint[2] ?? "")
      : "";
    if (
      adjacentHintKey &&
      question.accepted_answers.some(
        (answer) => normalizeText(answer) === adjacentHintKey,
      )
    ) {
      throw new Error(
        `Question ${question.question_number}: fill_blank leaks an accepted answer next to the blank.`,
      );
    }
    const canonicalKey = normalizeText(question.correct_answer);
    if (
      !question.accepted_answers.some(
        (answer) => normalizeText(answer) === canonicalKey,
      )
    ) {
      throw new Error(
        `Question ${question.question_number}: accepted_answers must contain the canonical correct_answer.`,
      );
    }
    if (!isConstrainedFillPrompt(question.prompt, question.accepted_answers)) {
      throw new Error(
        `Question ${question.question_number}: local_exact fill_blank must name an article/base-form constraint or provide a closed word bank containing every accepted answer.`,
      );
    }
  }
}

export function validateQuestion(
  value: unknown,
  index: number,
): ImportQuestion {
  const record = asRecord(value, `questions[${index}]`);
  const questionNumber = Number(record.question_number ?? index + 1);
  if (!Number.isInteger(questionNumber) || questionNumber <= 0) {
    throw new Error(
      `Question ${index + 1}: question_number must be a positive integer.`,
    );
  }

  const questionType = normalizeQuestionType(
    record.question_type ?? record.type,
  );
  const evaluationMode = cleanString(
    record.evaluation_mode,
    40,
  ) as EvaluationMode;
  const rawCorrectAnswer =
    record.correct_answer ?? record.answer_key ?? record.answer;
  if (
    rawCorrectAnswer !== undefined &&
    rawCorrectAnswer !== null &&
    typeof rawCorrectAnswer !== "string"
  ) {
    throw new Error(
      `Question ${questionNumber}: correct_answer must be a plain string.`,
    );
  }
  let correctAnswer = cleanString(rawCorrectAnswer, 500);
  if (isManualReviewSentinel(correctAnswer)) {
    throw new Error(
      `Question ${questionNumber}: correct_answer must be a real answer, not a manual-review sentinel.`,
    );
  }

  const rubric =
    evaluationMode === "open_evaluation"
      ? validateRubric(record.rubric, questionNumber)
      : null;
  if (rubric) {
    if (!correctAnswer) correctAnswer = rubric.sample_answer;
    if (normalizeText(correctAnswer) !== normalizeText(rubric.sample_answer)) {
      throw new Error(
        `Question ${questionNumber}: correct_answer and rubric.sample_answer must describe the same canonical sample.`,
      );
    }
  } else if (record.rubric !== undefined && record.rubric !== null) {
    throw new Error(
      `Question ${questionNumber}: local_exact questions must not include a semantic rubric.`,
    );
  }

  const acceptedAnswers =
    questionType === "fill_blank" && evaluationMode === "local_exact"
      ? validateAcceptedAnswers(record.accepted_answers, questionNumber, true)
      : questionType === "multiple_choice" && evaluationMode === "local_exact"
        ? validateAcceptedAnswers(
            record.accepted_answers ?? [correctAnswer],
            questionNumber,
            true,
          )
        : validateAcceptedAnswers(
            record.accepted_answers,
            questionNumber,
            false,
          );

  const question: ImportQuestion = {
    question_number: questionNumber,
    question_type: questionType,
    prompt: cleanString(record.prompt, 800),
    options: validateOptions(record.options, questionNumber),
    correct_answer: correctAnswer,
    accepted_answers: acceptedAnswers,
    rubric,
    answer_contract_version: 1,
    explanation: cleanString(record.explanation, 600),
    evaluation_mode: evaluationMode,
  };

  if (!question.prompt || question.prompt.length < 12) {
    throw new Error(
      `Question ${question.question_number}: prompt is too short.`,
    );
  }
  if (!question.explanation) {
    throw new Error(
      `Question ${question.question_number}: explanation is required.`,
    );
  }
  assertNoForbiddenText(`Question ${question.question_number}`, [
    question.prompt,
    question.explanation,
    ...question.options,
  ]);
  if (
    question.question_type !== "multiple_choice" &&
    question.options.length > 0
  ) {
    throw new Error(
      `Question ${question.question_number}: only multiple_choice questions may include options.`,
    );
  }

  if (question.evaluation_mode === "local_exact") {
    validateLocalExactQuestion(question);
  } else if (question.evaluation_mode === "open_evaluation") {
    if (!openEvaluationTypes.has(question.question_type)) {
      throw new Error(
        `Question ${question.question_number}: ${question.question_type} cannot use open_evaluation.`,
      );
    }
    if (question.accepted_answers.length > 0) {
      throw new Error(
        `Question ${question.question_number}: semantic questions must use rubric criteria, not accepted_answers.`,
      );
    }
    if (!question.rubric || !question.correct_answer) {
      throw new Error(
        `Question ${question.question_number}: open_evaluation requires a rubric and real sample answer.`,
      );
    }
  } else {
    throw new Error(
      `Question ${question.question_number}: evaluation_mode must be local_exact or open_evaluation.`,
    );
  }

  return question;
}

export function validateWorksheet(value: unknown): WorksheetImport {
  const record = asRecord(value, "worksheet");
  const topic = asRecord(record.grammar_topic, "grammar_topic");
  const level = cleanString(record.level, 2);
  const difficulty = cleanString(record.difficulty, 12);
  const source = cleanString(record.source, 40);
  const visibility = cleanString(record.visibility, 20) || "workspace";

  if (!levels.has(level)) throw new Error("level must be A1, A2, B1, or B2.");
  if (!difficulties.has(difficulty))
    throw new Error("difficulty must be easy, medium, or hard.");
  if (!sources.has(source))
    throw new Error("source must be manual_import or teacher_created.");
  if (!["workspace", "private"].includes(visibility)) {
    throw new Error(
      "visibility must be workspace or private in the current schema.",
    );
  }

  const worksheet = {
    title: cleanString(record.title, 120),
    level: level as Level,
    grammar_topic: {
      slug: cleanString(topic.slug, 80) || undefined,
      name: cleanString(topic.name, 120) || undefined,
    },
    difficulty: difficulty as Difficulty,
    visibility: visibility as "workspace" | "private",
    source: source as WorksheetSource,
    source_label: cleanString(record.source_label, 120) || undefined,
    tags: Array.isArray(record.tags)
      ? record.tags
          .map((tag) => cleanString(tag, 60))
          .filter(Boolean)
          .slice(0, 20)
      : [],
    mini_lesson: validateMiniLesson(record.mini_lesson),
    questions: Array.isArray(record.questions)
      ? record.questions.map(validateQuestion)
      : [],
  };

  if (!worksheet.title) throw new Error("title is required.");
  if (!worksheet.grammar_topic.slug && !worksheet.grammar_topic.name) {
    throw new Error("grammar_topic.slug or grammar_topic.name is required.");
  }
  if (worksheet.questions.length < 2 || worksheet.questions.length > 20) {
    throw new Error("question count must be between 2 and 20.");
  }
  if (
    new Set(worksheet.questions.map((question) => question.question_number))
      .size !== worksheet.questions.length
  ) {
    throw new Error("question_number values must be unique.");
  }
  if (
    worksheet.questions.some(
      (question, index) => question.question_number !== index + 1,
    )
  ) {
    throw new Error(
      "question_number values must be contiguous and ordered from 1.",
    );
  }
  const promptKeys = worksheet.questions.map((question) =>
    normalizePromptKey(question.prompt),
  );
  if (new Set(promptKeys).size !== promptKeys.length) {
    throw new Error("question prompts must not be duplicated.");
  }
  const openQuestionCount = worksheet.questions.filter(
    (question) => question.evaluation_mode === "open_evaluation",
  ).length;
  if (openQuestionCount > 3) {
    throw new Error(
      "A worksheet may contain at most 3 open_evaluation questions.",
    );
  }
  assertNoForbiddenText("worksheet", [worksheet.title]);
  return worksheet;
}

function sqlLiteral(value: string | null) {
  if (value === null) return "null";
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized.includes("$worksheet_json$")) {
    throw new Error("Import JSON contains a reserved SQL delimiter.");
  }
  return `$worksheet_json$${serialized}$worksheet_json$::jsonb`;
}

function worksheetImportFingerprint(worksheet: WorksheetImport) {
  return createHash("sha256").update(JSON.stringify(worksheet)).digest("hex");
}

function buildQualityNotes(worksheet: WorksheetImport) {
  const parts = [
    worksheet.source_label ? `source_label=${worksheet.source_label}` : null,
    worksheet.tags.length > 0 ? `tags=${worksheet.tags.join(",")}` : null,
    `questions=${worksheet.questions.length}`,
    "answer_contract_version=1",
    `import_payload_sha256=${worksheetImportFingerprint(worksheet)}`,
    "validated_by=practice-worksheet-import",
  ].filter(Boolean);
  return parts.join("; ");
}

export function buildLinkedDbSql(args: {
  worksheet: WorksheetImport;
  workspaceId: string;
  createdBy: string | null;
}) {
  const worksheetJson = sqlJson(args.worksheet);
  const qualityNotes = buildQualityNotes(args.worksheet);
  return `
do $worksheet_import$
declare
  import_doc jsonb := ${worksheetJson};
  selected_topic_id uuid;
  saved_test_id uuid;
  requested_slug text := nullif(import_doc #>> '{grammar_topic,slug}', '');
  requested_name text := nullif(import_doc #>> '{grammar_topic,name}', '');
  target_workspace_id uuid := ${sqlLiteral(args.workspaceId)}::uuid;
  target_created_by uuid := ${args.createdBy ? `${sqlLiteral(args.createdBy)}::uuid` : "null"};
  target_quality_notes text := ${sqlLiteral(qualityNotes)};
begin
  perform pg_advisory_xact_lock(hashtextextended(
    concat(target_workspace_id::text, ':', import_doc->>'source', ':', import_doc->>'title', ':', target_quality_notes),
    0
  ));

  if not exists (
    select 1
    from public.workspaces w
    where w.id = target_workspace_id
  ) then
    raise exception 'Target workspace does not exist.';
  end if;

  if target_created_by is null then
    raise exception 'A reviewer profile is required before an imported worksheet can be approved.';
  end if;

  -- workspace_members rows are the active-membership boundary: offboarding
  -- deletes the row while preserving the teacher's historical worksheet data.
  perform 1
    from public.profiles reviewer
    join public.workspace_members reviewer_membership
      on reviewer_membership.user_id = reviewer.id
    where reviewer.id = target_created_by
      and reviewer_membership.workspace_id = target_workspace_id
      and reviewer_membership.role in ('owner', 'teacher')
    for share of reviewer, reviewer_membership;

  if not found then
    raise exception 'Reviewer must be an active owner or teacher in the target workspace.';
  end if;

  select gt.id
  into selected_topic_id
  from public.grammar_topics gt
  where (requested_slug is null or lower(gt.slug) = lower(requested_slug))
    and (requested_name is null or lower(gt.name) = lower(requested_name))
    and gt.level in (import_doc->>'level', 'A1_A2')
  order by
    case when gt.level = import_doc->>'level' then 0 when gt.level = 'A1_A2' then 1 else 2 end,
    gt.created_at asc
  limit 1;

  if selected_topic_id is null then
    raise exception 'No grammar topic matched worksheet import slug/name.';
  end if;

  select pt.id
  into saved_test_id
  from public.practice_tests pt
  where pt.workspace_id = target_workspace_id
    and pt.grammar_topic_id = selected_topic_id
    and pt.level = import_doc->>'level'
    and pt.title = import_doc->>'title'
    and pt.generation_source = import_doc->>'source'
    and pt.quality_notes = target_quality_notes
  order by pt.created_at desc
  limit 1;

  if saved_test_id is null then
    insert into public.practice_tests (
      workspace_id,
      grammar_topic_id,
      level,
      difficulty,
      title,
      description,
      created_by_ai,
      teacher_reviewed,
      visibility,
      created_by,
      mini_lesson,
      generation_source,
      quality_status,
      quality_notes,
      reviewed_by,
      reviewed_at
    )
    values (
      target_workspace_id,
      selected_topic_id,
      import_doc->>'level',
      import_doc->>'difficulty',
      import_doc->>'title',
      import_doc #>> '{mini_lesson,short_explanation}',
      false,
      true,
      import_doc->>'visibility',
      target_created_by,
      import_doc->'mini_lesson',
      import_doc->>'source',
      'approved',
      target_quality_notes,
      target_created_by,
      now()
    )
    returning id into saved_test_id;

    insert into public.practice_test_questions (
      practice_test_id,
      question_number,
      question_type,
      evaluation_mode,
      prompt,
      options,
      correct_answer,
      accepted_answers,
      rubric,
      answer_contract_version,
      explanation
    )
    select
      saved_test_id,
      (question->>'question_number')::integer,
      question->>'question_type',
      question->>'evaluation_mode',
      question->>'prompt',
      case
        when jsonb_array_length(coalesce(question->'options', '[]'::jsonb)) > 0 then question->'options'
        else null
      end,
      question->>'correct_answer',
      coalesce(question->'accepted_answers', '[]'::jsonb),
      nullif(question->'rubric', 'null'::jsonb),
      (question->>'answer_contract_version')::integer,
      question->>'explanation'
    from jsonb_array_elements(import_doc->'questions') as question
    order by (question->>'question_number')::integer;
  end if;
end
$worksheet_import$;

select
  pt.id as practice_test_id,
  pt.title,
  gt.name as grammar_topic_name,
  pt.level,
  pt.generation_source,
  pt.quality_status,
  app_private.practice_test_content_sha256(pt.id) as content_sha256,
  count(ptq.id)::integer as question_count
from public.practice_tests pt
join public.grammar_topics gt on gt.id = pt.grammar_topic_id
left join public.practice_test_questions ptq on ptq.practice_test_id = pt.id
where pt.workspace_id = ${sqlLiteral(args.workspaceId)}::uuid
  and pt.title = ${sqlLiteral(args.worksheet.title)}
  and pt.generation_source = ${sqlLiteral(args.worksheet.source)}
  and pt.quality_notes = ${sqlLiteral(qualityNotes)}
group by pt.id, gt.name
order by pt.created_at desc
limit 1;
`.trim();
}

export function buildCertifiedBankLinkedDbSql(args: {
  worksheet: WorksheetImport;
  certification: WorksheetBankCertification;
  workspaceId: string;
  templateKey: string;
  reviewedBy: string;
  releasedBy: string;
}) {
  if (!uuidPattern.test(args.workspaceId)) {
    throw new Error("workspaceId must be a UUID.");
  }
  if (
    !uuidPattern.test(args.reviewedBy) ||
    !uuidPattern.test(args.releasedBy)
  ) {
    throw new Error("Qualified bank reviewer and releaser IDs must be UUIDs.");
  }
  if (!templateKeyPattern.test(args.templateKey)) {
    throw new Error("templateKey is not a valid canonical bank key.");
  }
  assertWorksheetArtifactEligibleForWrite(args.worksheet);
  assertCertifiedWorksheetMatrixIdentity({
    worksheet: args.worksheet,
    templateKey: args.templateKey,
  });

  return `
with published as materialized (
  select *
  from app_private.publish_certified_worksheet_template(
    ${sqlLiteral(args.templateKey)},
    ${sqlJson(args.worksheet)},
    ${sqlLiteral(args.reviewedBy)}::uuid,
    ${sqlLiteral(args.releasedBy)}::uuid,
    ${sqlJson(args.certification.review_checklist)},
    ${sqlLiteral(args.certification.review_notes)},
    ${sqlLiteral(args.certification.release_notes)}
  )
), cloned as materialized (
  select
    published.*,
    app_private.clone_released_worksheet_template(
      ${sqlLiteral(args.workspaceId)}::uuid,
      published.revision_id
    ) as practice_test_id
  from published
)
select
  cloned.template_id,
  cloned.revision_id,
  cloned.review_id,
  cloned.release_id,
  cloned.practice_test_id,
  cloned.content_sha256,
  cloned.created as revision_created,
  test.approval_source,
  test.generation_source,
  test.quality_status,
  app_private.practice_test_content_sha256(test.id) as cloned_content_sha256
from cloned
join public.practice_tests test on test.id = cloned.practice_test_id;
`.trim();
}

function runLinkedDbImport(args: {
  worksheet: WorksheetImport;
  workspaceId: string;
  createdBy: string | null;
}) {
  const sql = buildLinkedDbSql(args);
  const pnpm = process.env.PNPM_BIN || "pnpm";
  const result = spawnSync(
    pnpm,
    ["dlx", "supabase@2.109.1", "db", "query", "--linked", sql],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `supabase db query failed with exit code ${result.status ?? "unknown"}.`,
    );
  }
}

function runCertifiedBankLinkedDbImport(args: {
  worksheet: WorksheetImport;
  certification: WorksheetBankCertification;
  workspaceId: string;
  templateKey: string;
  reviewedBy: string;
  releasedBy: string;
}) {
  const sql = buildCertifiedBankLinkedDbSql(args);
  const pnpm = process.env.PNPM_BIN || "pnpm";
  const result = spawnSync(
    pnpm,
    ["dlx", "supabase@2.109.1", "db", "query", "--linked", sql],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `supabase db query failed with exit code ${result.status ?? "unknown"}.`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const rawJson = await readFile(args.file, "utf8");
  const parsedWorksheet = JSON.parse(rawJson) as unknown;
  const worksheet = validateWorksheet(parsedWorksheet);

  if (!args.dryRun) {
    assertWorksheetArtifactEligibleForWrite(parsedWorksheet);
  }

  const bankCertification = args.publishToBank
    ? validateBankCertification(parsedWorksheet)
    : null;

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: true,
          title: worksheet.title,
          level: worksheet.level,
          source: worksheet.source,
          question_count: worksheet.questions.length,
          publish_to_bank: args.publishToBank,
          certification_ready: bankCertification !== null,
          approval_recorded: false,
          approval_message: "Dry run only; no worksheet approval was recorded.",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args.linkedDb) {
    if (args.publishToBank) {
      if (!bankCertification || !args.bankReviewedBy || !args.bankReleasedBy) {
        throw new Error("Certified bank import context is incomplete.");
      }
      runCertifiedBankLinkedDbImport({
        worksheet,
        certification: bankCertification,
        workspaceId: args.workspaceId,
        templateKey: args.templateKey,
        reviewedBy: args.bankReviewedBy,
        releasedBy: args.bankReleasedBy,
      });
      return;
    }
    runLinkedDbImport({
      worksheet,
      workspaceId: args.workspaceId,
      createdBy: args.createdBy,
    });
    return;
  }

  throw new Error(
    "Non-transactional REST imports are disabled. Use --linked-db after a successful --dry-run.",
  );
}

const isMainModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;

if (isMainModule) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : "Practice worksheet import failed.";
    console.error(message);
    process.exitCode = 1;
  });
}
