import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  validateWorksheet,
  type WorksheetImport,
} from "./import-practice-worksheet.js";
import {
  secondRevisionTopicsByLevel,
  WORKSHEET_SLOTS_PER_LEVEL,
} from "./verify-worksheet-authoring-matrix.js";
import { worksheetChoiceOrderErrors } from "./worksheet-choice-order.js";

const expectedTopLevelKeys = [
  "draft_metadata",
  "title",
  "level",
  "grammar_topic",
  "difficulty",
  "visibility",
  "source",
  "source_label",
  "tags",
  "mini_lesson",
  "questions",
] as const;

const expectedMetadataKeys = [
  "schema_version",
  "slot_id",
  "template_key",
  "revision_number",
  "revision_objective_id",
  "revision_objective_category",
  "revision_objective",
  "authoring_status",
  "certification_status",
  "approval_status",
] as const;

const forbiddenEvidenceKeys = new Set([
  "bank_certification",
  "reviewer",
  "reviewer_id",
  "reviewed_by",
  "reviewed_at",
  "approved_by",
  "certified_by",
  "review_notes",
  "release_notes",
]);

const b1NurseContextTerms = [
  "arzt",
  "ärzt",
  "dienstplan",
  "dokumentation",
  "krankenhaus",
  "patient",
  "pflege",
  "schicht",
  "station",
  "übergabe",
] as const;

const requiredFreeTextOrthographicVariants = new Map<string, string[]>([
  ["sodass", ["sodass", "so dass"]],
  ["so dass", ["sodass", "so dass"]],
  ["kennenzulernen", ["kennenzulernen", "kennen zu lernen"]],
  ["kennen zu lernen", ["kennenzulernen", "kennen zu lernen"]],
]);

export type WorksheetDraftLevel = "A1" | "A2" | "B1" | "B2";

type MatrixSlot = {
  slot_id: string;
  template_key: string;
  level: WorksheetDraftLevel;
  topic_slug: string;
  revision_number: 1 | 2;
  revision_objective_id: string;
  revision_objective_category: string;
  revision_objective: string;
  difficulty: "easy" | "medium" | "hard";
  planned_question_count: number;
  question_type_plan: Record<string, number>;
  evaluation_mode_plan: {
    local_exact: number;
    open_evaluation: number;
  };
  import_contract: {
    source: "manual_import";
    visibility_before_certification: "private";
    answer_contract_version: 1;
    max_open_evaluation_questions: 3;
  };
  authoring_status: "not_started";
};

export type WorksheetDraftInput = {
  fileName: string;
  value: unknown;
};

export type WorksheetDraftReport = {
  ok: boolean;
  errors: string[];
  totalDrafts: number;
  importerValidDrafts: number;
  draftsPerTopic: Record<string, number>;
  templateKeys: string[];
};

export type A1WorksheetDraftReport = WorksheetDraftReport;

function record(value: unknown, label: string, errors: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  return value as Record<string, unknown>;
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

function normalize(value: string) {
  return value
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("de-DE")
    .replace(/\s+/g, " ");
}

function normalizeForLeakComparison(value: string) {
  return normalize(value).replace(/[.!?…]+(?=(?:["'»“”’\)\]]*)$)/u, "");
}

function containsNurseContext(value: unknown) {
  const normalized = normalize(collectStrings(value).join(" "));
  return b1NurseContextTerms.some((term) => normalized.includes(term));
}

function lessonAnswerLeakNumbers(worksheet: WorksheetImport) {
  const examples = worksheet.mini_lesson.correct_examples.map(
    normalizeForLeakComparison,
  );
  const otherLessonSurfaces = [
    worksheet.mini_lesson.short_explanation,
    worksheet.mini_lesson.key_rule,
    worksheet.mini_lesson.common_mistake_warning,
    worksheet.mini_lesson.what_to_revise,
  ].map(normalizeForLeakComparison);
  return worksheet.questions
    .filter((question) => {
      const answer = normalizeForLeakComparison(question.correct_answer);
      const completedPrompt = normalizeForLeakComparison(
        question.prompt.replace(/_{3,}/g, question.correct_answer),
      );
      return (
        examples.some(
          (example) =>
            example === answer ||
            (example.length >= 10 && completedPrompt.includes(example)) ||
            (answer.length >= 10 &&
              (example.includes(answer) || answer.includes(example))),
        ) ||
        (answer.length >= 16 &&
          answer.includes(" ") &&
          otherLessonSurfaces.some((surface) => surface.includes(answer)))
      );
    })
    .map((question) => question.question_number);
}

export type CrossQuestionAnswerLeakage = {
  answerQuestionNumber: number;
  visibleQuestionNumber: number;
};

/**
 * Finds complete answers exposed by another question before evaluation. Short
 * constrained answers are intentionally omitted because closed word-bank and
 * fixed-expression practice necessarily repeats small forms. Complete semantic
 * answers and long multiword exact answers are high-signal leaks.
 */
export function worksheetCrossQuestionAnswerLeakages(
  worksheet: WorksheetImport,
): CrossQuestionAnswerLeakage[] {
  const leakages: CrossQuestionAnswerLeakage[] = [];
  for (const answerQuestion of worksheet.questions) {
    const answer = normalizeForLeakComparison(answerQuestion.correct_answer);
    const isHighSignalAnswer =
      (answerQuestion.evaluation_mode === "open_evaluation" &&
        answer.length >= 10) ||
      (answerQuestion.evaluation_mode === "local_exact" &&
        answer.length >= 16 &&
        answer.includes(" "));
    if (!isHighSignalAnswer) continue;

    for (const visibleQuestion of worksheet.questions) {
      if (visibleQuestion === answerQuestion) continue;
      const visibleSurfaces = [
        visibleQuestion.prompt,
        ...visibleQuestion.options,
      ].map(normalizeForLeakComparison);
      if (visibleSurfaces.some((surface) => surface.includes(answer))) {
        leakages.push({
          answerQuestionNumber: answerQuestion.question_number,
          visibleQuestionNumber: visibleQuestion.question_number,
        });
      }
    }
  }
  return leakages;
}

/**
 * Recognition questions must not print their complete accepted sentence in the
 * setup and then ask the learner to select that same sentence from the choices.
 * Short forms are deliberately excluded because a closed word bank or quoted
 * source must expose them to define many constrained tasks.
 */
function ownPromptCompleteAnswerLeakNumbers(worksheet: WorksheetImport) {
  return worksheet.questions
    .filter((question) => {
      if (
        question.question_type !== "multiple_choice" ||
        question.evaluation_mode !== "local_exact"
      ) {
        return false;
      }
      const answer = normalizeForLeakComparison(question.correct_answer);
      const prompt = normalizeForLeakComparison(question.prompt);
      return (
        answer.length >= 16 && answer.includes(" ") && prompt.includes(answer)
      );
    })
    .map((question) => question.question_number);
}

function missingOrthographicVariants(worksheet: WorksheetImport) {
  const missing: string[] = [];
  for (const question of worksheet.questions) {
    if (
      question.question_type !== "fill_blank" ||
      question.evaluation_mode !== "local_exact"
    ) {
      continue;
    }
    const required = requiredFreeTextOrthographicVariants.get(
      normalize(question.correct_answer),
    );
    if (!required) continue;
    const accepted = new Set(question.accepted_answers.map(normalize));
    const prompt = normalize(question.prompt);
    const visibleBank = (
      extractVisibleClosedWordBank(question.prompt) ?? []
    ).map(normalize);
    const canonical = normalize(question.correct_answer);
    const explicitlyRequiresCanonicalJoinedSpelling =
      /^(?:wortbank|wortliste):? \[[^\]]+\]\. (?:verwende die zusammengeschriebene form und ergänze|ergänze mit der zusammengeschriebenen form:)/u.test(
        prompt,
      ) &&
      accepted.size === 1 &&
      accepted.has(canonical) &&
      visibleBank.includes(canonical) &&
      required.filter((variant) => visibleBank.includes(normalize(variant)))
        .length === 1;
    if (explicitlyRequiresCanonicalJoinedSpelling) {
      continue;
    }
    const absent = required.filter(
      (variant) =>
        !accepted.has(normalize(variant)) ||
        !prompt.includes(normalize(variant)),
    );
    if (absent.length > 0) {
      missing.push(`Q${question.question_number}: ${absent.join(", ")}`);
    }
  }
  return missing;
}

function extractVisibleClosedWordBank(prompt: string) {
  const match = prompt.match(
    /(?:wortbank|wortliste)\s*[:：]?\s*(?:\[([^\]]+)\]|\(([^)]+)\))/iu,
  );
  if (!match) return null;
  const choices = (match[1] ?? match[2] ?? "")
    .split(/[,;|/]/)
    .map((choice) => choice.normalize("NFC").trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (
    choices.length < 2 ||
    choices.length > 6 ||
    new Set(choices.map(normalize)).size !== choices.length
  ) {
    return null;
  }
  return choices;
}

function missingFoundationClosedWordBanks(worksheet: WorksheetImport) {
  return worksheet.questions
    .filter((question) => {
      if (
        question.question_type !== "fill_blank" ||
        question.evaluation_mode !== "local_exact"
      ) {
        return false;
      }
      const bank = extractVisibleClosedWordBank(question.prompt);
      if (!bank) return true;
      const bankKeys = new Set(bank.map(normalize));
      return question.accepted_answers.some(
        (answer) => !bankKeys.has(normalize(answer)),
      );
    })
    .map((question) => question.question_number);
}

function knownA1ContentRegressions(
  templateKey: string,
  worksheet: WorksheetImport,
) {
  const regressions: string[] = [];
  const question = (number: number) =>
    worksheet.questions.find(
      (candidate) => candidate.question_number === number,
    );
  const rubricText = (number: number) =>
    normalize(question(number)?.rubric?.criteria.join(" ") ?? "");

  if (templateKey === "v1-a1-passive-voice-r1") {
    const q4Prompt = normalize(question(4)?.prompt ?? "");
    if (
      !q4Prompt.includes("vorgangspassiv") ||
      !q4Prompt.includes("kochvorgang") ||
      !normalize(worksheet.mini_lesson.key_rule).includes("zustand")
    ) {
      regressions.push(
        "Q4 does not disambiguate Vorgangspassiv from a valid ist-result state",
      );
    }
    const q1Surfaces = new Set(
      [question(1)?.correct_answer, ...(question(1)?.options ?? [])]
        .filter((value): value is string => typeof value === "string")
        .map(normalize),
    );
    if (
      question(7)?.correct_answer &&
      q1Surfaces.has(normalize(question(7)!.correct_answer))
    ) {
      regressions.push("Q1 leaks Q7's complete corrected sentence");
    }
  }

  if (templateKey === "v1-a1-capitalization-r1") {
    for (const number of [1, 2]) {
      const optionContents = (question(number)?.options ?? []).map((option) =>
        normalize(option).replace(/^variante [a-z]:\s*/u, ""),
      );
      if (optionContents.length < 3 || new Set(optionContents).size !== 1) {
        regressions.push(
          `Q${number} changes sentence content instead of isolating capitalization`,
        );
      }
    }
    if (!normalize(question(3)?.prompt ?? "").includes("formelle anrede")) {
      regressions.push(
        "Q3 does not distinguish formal Sie from a valid lowercase third-person sie question",
      );
    }
    for (const number of [4, 5]) {
      if (
        !normalize(question(number)?.prompt ?? "").includes(
          "korrekt großgeschriebenen nomen",
        )
      ) {
        regressions.push(
          `Q${number} does not make capitalization necessary to solve the task`,
        );
      }
    }
  }

  if (templateKey === "v1-a1-adjective-endings-r1") {
    const q8Prompt = normalize(question(8)?.prompt ?? "");
    const q8Explanation = normalize(question(8)?.explanation ?? "");
    if (
      q8Prompt.includes("ein neues diensthandy") ||
      !q8Explanation.includes("neutralen nomen") ||
      !q8Explanation.includes("endung -es")
    ) {
      regressions.push(
        "Q8 reveals the target adjective form or does not explain the neutral -es ending",
      );
    }
  }

  if (templateKey === "v1-a1-nominativ-r1") {
    const q8 = question(8);
    const preservesFlexibleOrder =
      q8?.evaluation_mode === "open_evaluation"
        ? rubricText(8).includes("in hamburg wohnt meine schwester")
        : normalize(q8?.prompt ?? "").includes("subjekt im nominativ") &&
          normalize(q8?.correct_answer ?? "") === "meine kollegin";
    if (!preservesFlexibleOrder) {
      regressions.push(
        "Q8 neither accepts flexible nominative sentence order nor isolates subject recognition",
      );
    }
  }

  if (templateKey === "v1-a1-register-r1") {
    const q7 = question(7);
    const preservesProfessionalTitle =
      q7?.evaluation_mode === "open_evaluation"
        ? rubricText(7).includes("andere passende formelle begrüßung") &&
          rubricText(7).includes("frau dr. keller") &&
          normalize(q7.correct_answer).includes("frau dr. keller. könnten sie")
        : normalize(q7?.prompt ?? "").includes("frau dr. keller") &&
          normalize(q7?.correct_answer ?? "").includes(
            "frau dr. keller. könnten sie",
          );
    if (!preservesProfessionalTitle) {
      regressions.push(
        "Q7 does not preserve the professional title in its formality contract",
      );
    }
  }

  if (templateKey === "v1-a1-konjunktiv-r1") {
    const warning = normalize(worksheet.mini_lesson.common_mistake_warning);
    if (!warning.includes("wenn") || !warning.includes("weiteres verb folgt")) {
      regressions.push(
        "mini-lesson falsely implies that möchte always requires another verb",
      );
    }
  }

  if (
    templateKey === "v1-a1-reflexive-verbs-r1" &&
    !normalize(question(6)?.prompt ?? "").includes("wir setzen ___")
  ) {
    regressions.push(
      "Q6 uses a reciprocal treffen-uns meaning under a same-person reflexive lesson",
    );
  }

  if (templateKey === "v1-a1-coherence-r1") {
    const answers = [4, 5, 6].map((number) =>
      normalize(question(number)?.correct_answer ?? ""),
    );
    const expectedBanks = new Map<number, string[]>([
      [4, ["fahrrad", "frühstück", "bett"]],
      [5, ["arbeit", "jacke", "suppe"]],
      [6, ["büro", "café", "bett"]],
    ]);
    const wordBanksAreGrammaticallyCompatible = [...expectedBanks].every(
      ([number, expected]) => {
        const actual = extractVisibleClosedWordBank(
          question(number)?.prompt ?? "",
        );
        return (
          actual !== null &&
          actual.length === expected.length &&
          expected.every((choice) => actual.map(normalize).includes(choice))
        );
      },
    );
    const contextPromptsAreSpecific =
      normalize(question(1)?.prompt ?? "").includes("derselben person") &&
      normalize(question(2)?.prompt ?? "").includes(
        "start einer deutschstunde",
      ) &&
      normalize(question(3)?.prompt ?? "").includes("morgens beginnt");
    if (
      !normalize(worksheet.mini_lesson.key_rule).includes("thema") ||
      answers.join("|") !== "frühstück|arbeit|bett" ||
      !wordBanksAreGrammaticallyCompatible ||
      !contextPromptsAreSpecific
    ) {
      regressions.push(
        "Q1-Q6 do not isolate coherence with specific contexts and grammatically compatible choices",
      );
    }
  }

  if (
    templateKey === "v1-a1-modal-verbs-r2" &&
    !(question(2)?.options ?? []).some((option) =>
      normalize(option).includes("müssen zusammen essen"),
    )
  ) {
    regressions.push(
      "Q2 lacks a grammatical meaning-based distractor for the shared wish",
    );
  }

  if (templateKey === "v1-a1-question-formation-r2") {
    if (
      !(question(2)?.options ?? []).some((option) =>
        normalize(option).includes("wann hilft dir deine kollegin"),
      )
    ) {
      regressions.push("Q2 contains an ungrammatical time-question distractor");
    }
    if (
      !normalize(question(5)?.prompt ?? "").includes("___ ist dein deutschkurs")
    ) {
      regressions.push("Q5 uses an unnatural Deutschkurs question");
    }
  }

  if (templateKey === "v1-a1-question-formation-r1") {
    for (const number of [2, 8]) {
      const task = normalize(question(number)?.prompt ?? "");
      if (
        !task.includes("neutrale standardsprachliche") ||
        !task.includes("verb") ||
        !task.includes("subjekt")
      ) {
        regressions.push(
          `Q${number} does not exclude marked contrastive or echo-question order`,
        );
      }
    }
  }

  if (templateKey === "v1-a1-word-order-r1") {
    const task = normalize(question(7)?.prompt ?? "");
    if (
      !task.includes("neutrale standardsprachliche") ||
      !task.includes("subjekt direkt nach")
    ) {
      regressions.push(
        "Q7 does not exclude a grammatical marked object-before-subject order",
      );
    }
  }

  if (templateKey === "v1-a1-plural-forms-r1") {
    const q7Prompt = normalize(question(7)?.prompt ?? "");
    const q8Prompt = normalize(question(8)?.prompt ?? "");
    if (/(?:^|\s)betten(?:\s|[.,!?])/u.test(q7Prompt)) {
      regressions.push("Q7 gives away the target plural Betten in its setup");
    }
    if (/(?:^|\s)formulare(?:\s|[.,!?])/u.test(q8Prompt)) {
      regressions.push(
        "Q8 gives away the target plural Formulare in its setup",
      );
    }
  }

  if (templateKey === "v1-a1-separable-verbs-r1") {
    const q8Explanation = normalize(question(8)?.explanation ?? "");
    if (
      !q8Explanation.includes("ravi") ||
      !q8Explanation.includes("ruft") ||
      !q8Explanation.includes("an")
    ) {
      regressions.push(
        "Q8 explanation does not match the answer's third-person form ruft ... an",
      );
    }
  }

  if (
    templateKey === "v1-a1-prepositions-r1" &&
    !normalize(question(4)?.prompt ?? "").includes(
      "wir haben ___ montag deutschkurs",
    )
  ) {
    regressions.push("Q4 uses an unnatural weekday course sentence");
  }

  if (templateKey === "v1-a1-spelling-r1") {
    const q8 = question(8);
    const testsSpelling =
      q8?.evaluation_mode === "open_evaluation"
        ? normalize(q8.prompt).includes("adrese") &&
          rubricText(8).includes("adrese") &&
          rubricText(8).includes("adresse")
        : normalize(q8?.prompt ?? "").includes("schreibweise") &&
          normalize(q8?.correct_answer ?? "") === "adresse" &&
          (q8?.options ?? []).some((option) => normalize(option) === "adrese");
    if (!testsSpelling) {
      regressions.push("Q8 does not require the learner to identify Adresse");
    }
  }

  if (
    templateKey === "v1-a1-articles-r1" &&
    !normalize(question(4)?.prompt ?? "").includes(
      "___ medikament ist für frau keller",
    )
  ) {
    regressions.push("Q4 lacks the reviewed professional medication context");
  }

  if (templateKey === "v1-a1-praeteritum-r1") {
    if (
      normalize(question(3)?.correct_answer ?? "") !== "war" ||
      !normalize(question(3)?.prompt ?? "").includes("meine kollegin") ||
      normalize(question(6)?.correct_answer ?? "") !== "hatten" ||
      !normalize(question(6)?.prompt ?? "").includes("wir ___ am freitag")
    ) {
      regressions.push(
        "Q3 and Q6 exceed the A1 Präteritum scope of sein and haben",
      );
    }
  }

  return regressions;
}

function knownA2ContentRegressions(
  templateKey: string,
  worksheet: WorksheetImport,
) {
  const regressions: string[] = [];
  const question = (number: number) =>
    worksheet.questions.find(
      (candidate) => candidate.question_number === number,
    );
  const prompt = (number: number) => normalize(question(number)?.prompt ?? "");
  const rubric = (number: number) =>
    normalize(question(number)?.rubric?.criteria.join(" ") ?? "");
  const answer = (number: number) =>
    normalize(question(number)?.correct_answer ?? "");
  const explanation = (number: number) =>
    normalize(question(number)?.explanation ?? "");

  if (
    templateKey === "v1-a2-genitiv-r1" &&
    !prompt(1).includes("einzelnen zimmer")
  ) {
    regressions.push(
      "Q1 does not exclude the valid genitive-plural option der Zimmer",
    );
  }
  if (templateKey === "v1-a2-capitalization-r1") {
    if (!prompt(2).includes("vollständige satz")) {
      regressions.push(
        "Q2 asks only about a nominalization although several options capitalize their nominalization correctly",
      );
    }
    if (
      !prompt(7).includes("korrigiere") ||
      !prompt(7).includes("bewahrt alle wörter")
    ) {
      regressions.push(
        "Q7 does not require a capitalization-only correction that preserves every word",
      );
    }
    const source = question(7)?.prompt.match(/„([^“]+)“/u)?.[1] ?? "";
    const sourceContent = normalize(source).replace(/[.!?]+$/u, "");
    const answerContent = answer(7)
      .replace(/^variante [a-z]:\s*/u, "")
      .replace(/[.!?]+$/u, "");
    if (!sourceContent || sourceContent !== answerContent) {
      regressions.push(
        "Q7 changes lexical content instead of preserving the capitalization source",
      );
    }
  }
  if (templateKey === "v1-a2-conjunctions-r2") {
    if (!prompt(4).includes("kontrolle geschieht vor")) {
      regressions.push(
        "Q4 does not distinguish bevor from the grammatical obwohl distractor",
      );
    }
    if (
      !rubric(8).includes("vor oder nach") &&
      !rubric(8).includes("vorangestellt oder nachgestellt")
    ) {
      regressions.push("Q8 rubric rejects a valid afterposed obwohl clause");
    }
  }
  if (
    templateKey === "v1-a2-connectors-r1" &&
    !prompt(1).includes("welcher satz")
  ) {
    regressions.push(
      "Q1 asks for a connector although every option is a sentence",
    );
  }
  if (templateKey === "v1-a2-nominativ-r1") {
    const q6Explanation = explanation(6);
    if (
      q6Explanation.includes("handelnd") ||
      !q6Explanation.includes("subjekt des satzes")
    ) {
      regressions.push("Q6 incorrectly describes the non-agent Kurs as acting");
    }
  }
  if (templateKey === "v1-a2-prepositions-r2") {
    const q2 = question(2);
    if (
      answer(2) !== "am" ||
      !q2?.options.some((option) => normalize(option) === "am") ||
      !explanation(2).includes("an dem") ||
      !explanation(2).includes("am")
    ) {
      regressions.push(
        "Q2 does not teach the natural contracted form am Sprachkurs",
      );
    }
  }
  if (templateKey === "v1-a2-punctuation-r1") {
    const expectedLiteralAnswers = new Map([
      [3, ":"],
      [4, "?"],
      [5, "."],
    ]);
    const nonLiteralQuestions = [...expectedLiteralAnswers].filter(
      ([number, expected]) => answer(number) !== expected,
    );
    if (nonLiteralQuestions.length > 0) {
      regressions.push(
        `Q${nonLiteralQuestions.map(([number]) => number).join(" and Q")} tests punctuation names instead of literal marks`,
      );
    }
  }
  if (templateKey === "v1-a2-task-fulfilment-r1") {
    const q6Answer = answer(6);
    const q8Answer = answer(8);
    if (
      !prompt(6).includes("sehr geehrte frau klein") ||
      !q6Answer.includes("sehr geehrte frau klein")
    ) {
      regressions.push(
        "Q6 does not preserve a standard complete formal salutation",
      );
    }
    const q8HasCompleteClosing =
      question(8)?.evaluation_mode === "open_evaluation"
        ? rubric(8).includes("vollständigen abschluss")
        : prompt(8).includes("vollständige formelle nachricht") &&
          explanation(8).includes("vollständigen abschluss");
    if (
      !prompt(8).includes("absender anil") ||
      !q8Answer.includes("sehr geehrte frau weber") ||
      !q8Answer.includes("mit freundlichen grüßen") ||
      !q8Answer.endsWith("anil") ||
      !q8HasCompleteClosing
    ) {
      regressions.push("Q8 does not model a complete signed formal message");
    }
  }
  if (templateKey === "v1-a2-passive-voice-r1") {
    if (
      !prompt(3).includes("vorgangspassiv") ||
      !prompt(3).includes("präsens") ||
      !prompt(4).includes("vorgangspassiv") ||
      !prompt(4).includes("präsens") ||
      !prompt(6).includes("vorgangspassiv") ||
      !prompt(6).includes("präsens")
    ) {
      regressions.push(
        "Q3, Q4, or Q6 permits a valid Zustandspassiv or past-tense answer outside the exact-scoring key",
      );
    }
    if (!prompt(8).includes("lasse die handelnde person weg")) {
      regressions.push(
        "Q8 says the agent is optional while its rubric requires omission",
      );
    }
  }
  if (
    templateKey === "v1-a2-relative-clauses-r1" &&
    (!prompt(8).includes("zweiten satz") ||
      !prompt(8).includes("in den ersten satz"))
  ) {
    regressions.push(
      "Q8 permits two valid relative-clause transformations while its rubric accepts only one",
    );
  }
  if (templateKey === "v1-a2-reflexive-verbs-r1") {
    if (!prompt(3).includes("nicht eine andere person")) {
      regressions.push("Q3 permits the grammatical non-reflexive ihn reading");
    }
    if (
      !prompt(4).includes("bereiten wir ___") ||
      !prompt(4).includes("übergabe")
    ) {
      regressions.push(
        "Q4 does not use a genuinely reflexive professional context",
      );
    }
  }
  if (
    templateKey === "v1-a2-reflexive-verbs-r2" &&
    !prompt(5).includes("keine andere person")
  ) {
    regressions.push(
      "Q5 permits a transitive jemanden fuer etwas interessieren reading",
    );
  }
  if (
    templateKey === "v1-a2-coherence-r1" &&
    !prompt(4).includes("lehrerin selbst")
  ) {
    regressions.push(
      "Q4 claims an unequivocal reference without identifying the teacher as actor",
    );
  }
  if (templateKey === "v1-a2-spelling-r1") {
    const rule = normalize(worksheet.mini_lesson.key_rule);
    if (!rule.includes("stimmlosen s-laut") || !rule.includes("doppellaut")) {
      regressions.push("mini-lesson gives an incomplete s/ss/ß rule");
    }
    if (!prompt(7).includes("fehlerhaften wortbilder")) {
      regressions.push(
        "Q7 supplies every spelling and tests only copying or word order",
      );
    }
  }
  if (templateKey === "v1-a2-plural-forms-r2") {
    const keyRule = normalize(worksheet.mini_lesson.key_rule);
    const leakedQuestionNumbers = [1, 4].filter((number) => {
      const answer = normalize(question(number)?.correct_answer ?? "");
      return answer.length > 0 && keyRule.includes(answer);
    });
    if (leakedQuestionNumbers.length > 0) {
      regressions.push(
        `mini-lesson key rule gives away plural answers for Q${leakedQuestionNumbers.join(" and Q")}`,
      );
    }
  }
  if (
    templateKey === "v1-a2-pronouns-r2" &&
    !prompt(6).includes("einzelne frau")
  ) {
    regressions.push(
      "Q6 does not distinguish a singular feminine ihr correction from plural ihnen",
    );
  }
  if (templateKey === "v1-a2-separable-verbs-r2") {
    if (!prompt(4).includes("die kollegin")) {
      regressions.push(
        "Q4 leaves sentence-initial Sie ambiguous between singular and plural forms",
      );
    }
    if (
      !prompt(5).includes("konjugierte form") ||
      prompt(5).includes("verbstamm")
    ) {
      regressions.push("Q5 calls the finite conjugated form kommt a verb stem");
    }
  }
  if (templateKey === "v1-a2-question-formation-r1") {
    if (
      !prompt(8).includes("neutrale standardsprachliche") ||
      !prompt(8).includes("verb") ||
      !prompt(8).includes("subjekt")
    ) {
      regressions.push(
        "Q8 does not exclude grammatical echo or marked contrastive question order",
      );
    }
  }
  if (
    templateKey === "v1-a2-konjunktiv-r1" &&
    (!prompt(6).includes("besonders höfliche") ||
      !prompt(6).includes("konjunktiv-ii"))
  ) {
    regressions.push(
      "Q6 asks only for politeness although indicative Haben Sie is also polite",
    );
  }
  return regressions;
}

function knownB1AmbiguityRegressions(
  templateKey: string,
  worksheet: WorksheetImport,
) {
  const regressions: string[] = [];
  const question = (number: number) =>
    worksheet.questions.find(
      (candidate) => candidate.question_number === number,
    );
  if (
    templateKey === "v1-b1-adjective-endings-r2" &&
    question(2)?.options.some(
      (option) => normalize(option) === "mit frischem zubereiteten essen",
    )
  ) {
    regressions.push(
      "Q2 reintroduces a defensible mixed-inflection distractor",
    );
  }
  if (
    templateKey === "v1-b1-passive-voice-r2" &&
    !normalize(question(7)?.prompt ?? "").includes("vorgangspassiv")
  ) {
    regressions.push(
      "Q7 does not disambiguate Vorgangspassiv from Zustandspassiv",
    );
  }
  if (
    templateKey === "v1-b1-relative-clauses-r1" &&
    !normalize(question(9)?.prompt ?? "").includes("in der")
  ) {
    regressions.push("Q9 does not identify the required in-der target form");
  }
  if (
    templateKey === "v1-b1-relative-clauses-r2" &&
    !normalize(question(9)?.prompt ?? "").includes("über das")
  ) {
    regressions.push("Q9 does not identify the required über-das target form");
  }
  if (["v1-b1-connectors-r1", "v1-b1-connectors-r2"].includes(templateKey)) {
    const rule = normalize(worksheet.mini_lesson.key_rule);
    if (!rule.includes("vorfeld") || !rule.includes("mittelfeld")) {
      regressions.push(
        "mini-lesson does not distinguish connector placement in Vorfeld and Mittelfeld",
      );
    }
  }
  if (templateKey === "v1-b1-connectors-r2") {
    const q9Rubric = normalize(question(9)?.rubric?.criteria.join(" ") ?? "");
    if (!q9Rubric.includes("vor oder nach")) {
      regressions.push(
        "Q9 rubric does not accept both valid obwohl clause orders",
      );
    }
  }
  if (templateKey === "v1-b1-akkusativ-r1") {
    const q9Prompt = normalize(question(9)?.prompt ?? "");
    if (
      !q9Prompt.includes("wiederholte subjekt") ||
      !q9Prompt.includes("wiederholte akkusativobjekt")
    ) {
      regressions.push(
        "Q9 instruction asks only for the object while its rubric also requires subject replacement",
      );
    }
  }
  return regressions;
}

function knownB2ContentRegressions(
  templateKey: string,
  worksheet: WorksheetImport,
) {
  const regressions: string[] = [];
  const question = (number: number) =>
    worksheet.questions.find(
      (candidate) => candidate.question_number === number,
    );
  if (templateKey === "v1-b2-konjunktiv-r2") {
    const prompt = normalize(question(1)?.prompt ?? "");
    if (!prompt.includes("neutral") || !prompt.includes("konjunktiv i")) {
      regressions.push(
        "Q1 does not distinguish neutral Konjunktiv I from a defensible doubtful Konjunktiv II reading",
      );
    }
  }
  if (/\s\d+$/u.test(worksheet.title)) {
    regressions.push("visible title ends in an internal revision number");
  }
  if (templateKey.endsWith("-r1")) {
    const tail = question(10);
    const acceptedAnswers = tail?.accepted_answers ?? [];
    const correctAnswer = tail?.correct_answer ?? "";
    const answerWordCount = normalize(correctAnswer).split(" ").filter(Boolean)
      .length;
    if (
      !tail ||
      tail.question_type !== "multiple_choice" ||
      tail.evaluation_mode !== "local_exact" ||
      tail.options.length !== 4 ||
      tail.rubric !== null ||
      acceptedAnswers.length !== 1 ||
      acceptedAnswers[0] !== correctAnswer ||
      tail.options.filter((option) => option === correctAnswer).length !== 1 ||
      answerWordCount < 8 ||
      /wortbank/iu.test(tail.prompt)
    ) {
      regressions.push(
        "Q10 does not retain a deterministic full-sentence B2 transfer task",
      );
    }
  }
  if (templateKey === "v1-b2-infinitive-zu-r1") {
    const q9Options = question(9)?.options.map(normalize) ?? [];
    if (
      q9Options.some((option) =>
        option.includes("um informationsverluste vermeiden zu können")
      )
    ) {
      regressions.push(
        "Q9 includes a second grammatical purpose clause with a modal infinitive",
      );
    }
  }
  if (templateKey === "v1-b2-connectors-r1") {
    const requiredPromptCues = new Map([
      [5, ["unerwarteten gegensatz"]],
      [6, ["zusätzliche", "ohne ursache-folge"]],
      [7, ["direkten gegensatz"]],
    ]);
    for (const [number, cues] of requiredPromptCues) {
      const prompt = normalize(question(number)?.prompt ?? "");
      if (cues.some((cue) => !prompt.includes(cue))) {
        regressions.push(
          `Q${number} lacks an explicit connector-relation cue for exact scoring`,
        );
      }
    }
  }
  if (templateKey === "v1-b2-punctuation-r1") {
    const explanation = question(8)?.explanation ?? "";
    if (!explanation.includes("„den die Arbeitsgruppe entwickelt hat“")) {
      regressions.push(
        "Q8 explanation fails to delimit the cited relative clause correctly",
      );
    }
  }
  if (templateKey === "v1-b2-dativ-r1") {
    const lesson = normalize([
      worksheet.mini_lesson.short_explanation,
      worksheet.mini_lesson.key_rule,
    ].join(" "));
    if (
      lesson.includes("statischem ort") ||
      lesson.includes("statische ortsangabe") ||
      lesson.includes("gerichteter bewegung") ||
      !lesson.includes("bewegung innerhalb") ||
      !lesson.includes("ziel") ||
      !lesson.includes("ortswechsel")
    ) {
      regressions.push(
        "mini-lesson overgeneralizes Wechselpräpositionen as static versus moving",
      );
    }
  }
  if (templateKey === "v1-b2-plusquamperfekt-r1") {
    const warning = normalize(
      worksheet.mini_lesson.common_mistake_warning,
    );
    if (
      !warning.includes("ersatzinfinitiv") ||
      !warning.includes("hatte ändern müssen") ||
      !warning.includes("gewöhnlichen nebensatz")
    ) {
      regressions.push(
        "mini-lesson warning omits the Ersatzinfinitiv auxiliary-order exception",
      );
    }
  }
  if (templateKey === "v1-b2-register-r1") {
    const content = normalize(
      worksheet.questions.slice(0, 9).map((item) =>
        `${item.prompt} ${item.correct_answer}`
      ).join(" "),
    );
    for (const required of [
      "unter bezugnahme",
      "kleinen stichprobe",
      "nach derzeitigem stand",
      "tätigkeitsnachweis",
    ]) {
      if (!content.includes(required)) {
        regressions.push(
          `register foundation loses B2 professional-language marker: ${required}`,
        );
      }
    }
  }
  if (templateKey === "v1-b2-subordinate-clauses-r1") {
    const lesson = normalize(worksheet.mini_lesson.key_rule);
    for (const required of ["zumal", "obgleich", "sofern", "indem", "nachdem"]) {
      if (!lesson.includes(required)) {
        regressions.push(
          `subordinate-clause foundation loses B2 relation marker: ${required}`,
        );
      }
    }
    if (!normalize(question(1)?.correct_answer ?? "").includes(
      "geprüft werden mussten"
    )) {
      regressions.push(
        "subordinate-clause foundation loses its complex Modalpassiv transfer",
      );
    }
  }
  return regressions;
}

function contentFingerprint(worksheet: WorksheetImport) {
  return createHash("sha256").update(JSON.stringify(worksheet)).digest("hex");
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value))
    value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectStrings(item, output));
  }
  return output;
}

function collectForbiddenKeys(
  value: unknown,
  path = "worksheet",
  output: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectForbiddenKeys(item, `${path}[${index}]`, output),
    );
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenEvidenceKeys.has(key)) output.push(`${path}.${key}`);
      collectForbiddenKeys(child, `${path}.${key}`, output);
    }
  }
  return output;
}

function containsPiiLikeText(values: string[]) {
  const combined = values.join("\n");
  return (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(combined) ||
    /\bhttps?:\/\//i.test(combined) ||
    /\b(?:\+?\d[\s()./-]*){8,}\b/.test(combined) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(
      combined,
    )
  );
}

function normalizeQuestionTypeCounts(worksheet: WorksheetImport) {
  const counts: Record<string, number> = {};
  for (const question of worksheet.questions) {
    counts[question.question_type] = (counts[question.question_type] ?? 0) + 1;
  }
  return counts;
}

function sameCountMap(
  actual: Record<string, number>,
  expected: Record<string, number>,
) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function parseSlots(
  matrix: unknown,
  level: WorksheetDraftLevel,
  errors: string[],
) {
  const root = record(matrix, "authoring matrix", errors);
  if (!root || !Array.isArray(root.slots)) {
    errors.push("Authoring matrix must contain slots.");
    return [];
  }
  const slots = root.slots.filter(
    (slot): slot is MatrixSlot =>
      Boolean(slot) &&
      typeof slot === "object" &&
      !Array.isArray(slot) &&
      (slot as Record<string, unknown>).level === level,
  );
  if (slots.length !== WORKSHEET_SLOTS_PER_LEVEL) {
    errors.push(
      `Authoring matrix has ${slots.length}/${WORKSHEET_SLOTS_PER_LEVEL} ${level} slots.`,
    );
  }
  return slots;
}

export function verifyWorksheetDrafts(
  matrix: unknown,
  draftInputs: WorksheetDraftInput[],
  level: WorksheetDraftLevel,
): WorksheetDraftReport {
  const errors: string[] = [];
  const slots = parseSlots(matrix, level, errors);
  const slotsByTemplate = new Map(
    slots.map((slot) => [slot.template_key, slot]),
  );
  const seenTemplates = new Set<string>();
  const seenTitles = new Set<string>();
  const seenPrompts = new Set<string>();
  const seenFingerprints = new Set<string>();
  const promptSetsByTopic = new Map<string, Map<number, Set<string>>>();
  const lessonFingerprintsByTopic = new Map<string, Map<number, string>>();
  const draftsPerTopic: Record<string, number> = {};
  let b1NurseContextQuestions = 0;
  let importerValidDrafts = 0;

  if (draftInputs.length !== WORKSHEET_SLOTS_PER_LEVEL) {
    errors.push(
      `Draft directory has ${draftInputs.length}/${WORKSHEET_SLOTS_PER_LEVEL} JSON files for ${level}.`,
    );
  }

  for (const input of draftInputs) {
    const fileLabel = input.fileName;
    const root = record(input.value, fileLabel, errors);
    if (!root) continue;
    if (!hasExactKeys(root, expectedTopLevelKeys)) {
      errors.push(
        `${fileLabel} must contain exactly the draft/importer top-level keys.`,
      );
      continue;
    }
    const metadata = record(
      root.draft_metadata,
      `${fileLabel}.draft_metadata`,
      errors,
    );
    if (!metadata) continue;
    if (!hasExactKeys(metadata, expectedMetadataKeys)) {
      errors.push(
        `${fileLabel} draft_metadata has unsupported or missing fields.`,
      );
      continue;
    }
    const templateKey =
      typeof metadata.template_key === "string" ? metadata.template_key : "";
    const slot = slotsByTemplate.get(templateKey);
    if (!slot) {
      errors.push(
        `${fileLabel} does not reference a canonical ${level} matrix slot.`,
      );
      continue;
    }
    if (basename(fileLabel) !== `${templateKey}.json`) {
      errors.push(
        `${fileLabel} filename does not match template_key ${templateKey}.`,
      );
    }
    if (seenTemplates.has(templateKey)) {
      errors.push(`Duplicate ${level} draft template_key: ${templateKey}.`);
    }
    seenTemplates.add(templateKey);
    if (
      metadata.schema_version !== 1 ||
      metadata.slot_id !== slot.slot_id ||
      metadata.revision_number !== slot.revision_number ||
      metadata.revision_objective_id !== slot.revision_objective_id ||
      metadata.revision_objective_category !==
        slot.revision_objective_category ||
      metadata.revision_objective !== slot.revision_objective ||
      metadata.authoring_status !== "draft_unapproved" ||
      metadata.certification_status !== "not_certified" ||
      metadata.approval_status !== "unapproved"
    ) {
      errors.push(
        `${fileLabel} draft metadata does not exactly match its unapproved slot.`,
      );
    }

    const forbiddenKeys = collectForbiddenKeys(root);
    if (forbiddenKeys.length > 0) {
      errors.push(
        `${fileLabel} contains forbidden review/certification fields: ${forbiddenKeys.join(", ")}.`,
      );
    }
    if (containsPiiLikeText(collectStrings(root))) {
      errors.push(
        `${fileLabel} contains PII-like email, URL, phone, or UUID text.`,
      );
    }

    let worksheet: WorksheetImport;
    try {
      worksheet = validateWorksheet(root);
      importerValidDrafts += 1;
    } catch (error) {
      errors.push(
        `${fileLabel} fails importer validation: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (
      worksheet.level !== level ||
      worksheet.grammar_topic.slug !== slot.topic_slug ||
      worksheet.difficulty !== slot.difficulty ||
      worksheet.visibility !== "private" ||
      worksheet.source !== "manual_import" ||
      worksheet.source_label !==
        `V1 ${level} draft worksheet; unapproved and not certified`
    ) {
      errors.push(
        `${fileLabel} does not match its ${level} topic/difficulty/private draft contract.`,
      );
    }
    const requiredTags = [
      level.toLocaleLowerCase("de-DE"),
      slot.topic_slug,
      "draft",
      "unapproved",
      "not-certified",
      slot.revision_objective_id,
    ];
    const normalizedTags = new Set(worksheet.tags.map(normalize));
    if (requiredTags.some((tag) => !normalizedTags.has(normalize(tag)))) {
      errors.push(
        `${fileLabel} is missing required draft/topic/objective tags.`,
      );
    }
    if (worksheet.questions.length !== slot.planned_question_count) {
      errors.push(
        `${fileLabel} has ${worksheet.questions.length}/${slot.planned_question_count} questions.`,
      );
    }
    if (
      slot.revision_number === 1 &&
      worksheet.questions.some(
        (question) =>
          question.evaluation_mode !== "local_exact" ||
          !["multiple_choice", "fill_blank"].includes(question.question_type),
      )
    ) {
      errors.push(
        `${fileLabel} foundation r1 must remain provider-independent and locally scorable using only multiple-choice or constrained fill-blank questions.`,
      );
    }
    const questionTypeCounts = normalizeQuestionTypeCounts(worksheet);
    if (!sameCountMap(questionTypeCounts, slot.question_type_plan)) {
      errors.push(
        `${fileLabel} question-type balance does not match its matrix slot.`,
      );
    }
    const localExact = worksheet.questions.filter(
      (question) => question.evaluation_mode === "local_exact",
    ).length;
    const openEvaluation = worksheet.questions.length - localExact;
    if (
      localExact !== slot.evaluation_mode_plan.local_exact ||
      openEvaluation !== slot.evaluation_mode_plan.open_evaluation ||
      openEvaluation > slot.import_contract.max_open_evaluation_questions
    ) {
      errors.push(
        `${fileLabel} evaluation-mode balance does not match its matrix slot.`,
      );
    }
    if (
      worksheet.questions.some(
        (question) =>
          question.explanation.trim().length < 18 ||
          (question.evaluation_mode === "open_evaluation" &&
            (!question.rubric || question.rubric.criteria.length < 2)),
      )
    ) {
      errors.push(
        `${fileLabel} has an under-specified explanation or semantic rubric.`,
      );
    }
    const choiceOrderErrors = worksheetChoiceOrderErrors(root);
    if (choiceOrderErrors.length > 0) {
      errors.push(
        `${fileLabel} has non-deterministic or collapsed answer positions: ${choiceOrderErrors.join("; ")}.`,
      );
    }
    const lessonLeakNumbers = lessonAnswerLeakNumbers(worksheet);
    if (lessonLeakNumbers.length > 0) {
      errors.push(
        `${fileLabel} mini-lesson leaks answers for questions ${lessonLeakNumbers.join(", ")}.`,
      );
    }
    const crossQuestionLeakages =
      worksheetCrossQuestionAnswerLeakages(worksheet);
    if (crossQuestionLeakages.length > 0) {
      errors.push(
        `${fileLabel} exposes complete answers in other pre-answer questions: ${crossQuestionLeakages
          .map(
            (leakage) =>
              `Q${leakage.visibleQuestionNumber} exposes Q${leakage.answerQuestionNumber}`,
          )
          .join("; ")}.`,
      );
    }
    if (slot.revision_number === 1) {
      const ownPromptLeakNumbers =
        ownPromptCompleteAnswerLeakNumbers(worksheet);
      if (ownPromptLeakNumbers.length > 0) {
        errors.push(
          `${fileLabel} repeats complete accepted answers in their own pre-answer prompts: ${ownPromptLeakNumbers.join(", ")}.`,
        );
      }
      const missingClosedBanks = missingFoundationClosedWordBanks(worksheet);
      if (missingClosedBanks.length > 0) {
        errors.push(
          `${fileLabel} has local_exact fills without a complete visible closed word bank: ${missingClosedBanks.join(", ")}.`,
        );
      }
    }
    if (level === "A1") {
      const contentRegressions = knownA1ContentRegressions(
        templateKey,
        worksheet,
      );
      if (contentRegressions.length > 0) {
        errors.push(
          `${fileLabel} reintroduces a known A1 content/scoring regression: ${contentRegressions.join("; ")}.`,
        );
      }
    }
    if (level === "A2") {
      const contentRegressions = knownA2ContentRegressions(
        templateKey,
        worksheet,
      );
      if (contentRegressions.length > 0) {
        errors.push(
          `${fileLabel} reintroduces a known A2 content/scoring regression: ${contentRegressions.join("; ")}.`,
        );
      }
    }
    if (level === "B1") {
      const missingVariants = missingOrthographicVariants(worksheet);
      if (missingVariants.length > 0) {
        errors.push(
          `${fileLabel} omits required free-text orthographic variants: ${missingVariants.join("; ")}.`,
        );
      }
      const ambiguityRegressions = knownB1AmbiguityRegressions(
        templateKey,
        worksheet,
      );
      if (ambiguityRegressions.length > 0) {
        errors.push(
          `${fileLabel} reintroduces known scoring ambiguity: ${ambiguityRegressions.join("; ")}.`,
        );
      }
      const nurseContextCount = worksheet.questions.filter((question) =>
        containsNurseContext(question),
      ).length;
      b1NurseContextQuestions += nurseContextCount;
      if (nurseContextCount < 2) {
        errors.push(
          `${fileLabel} has ${nurseContextCount}/10 adult-nurse context questions; at least 2 are required for distributed target-audience fit.`,
        );
      }
      if (templateKey === "v1-b1-infinitive-zu-r2") {
        const combined = normalize(collectStrings(worksheet).join(" "));
        const unsafeAdvancedMarkers = [
          "perfektinfinitiv",
          "passivinfinitiv",
          "worden zu sein",
        ].filter((marker) => combined.includes(marker));
        if (unsafeAdvancedMarkers.length > 0) {
          errors.push(
            `${fileLabel} reintroduces above-safe-B1 infinitive constructions: ${unsafeAdvancedMarkers.join(", ")}.`,
          );
        }
      }
    }
    if (level === "B2") {
      const contentRegressions = knownB2ContentRegressions(
        templateKey,
        worksheet,
      );
      if (contentRegressions.length > 0) {
        errors.push(
          `${fileLabel} reintroduces known B2 ambiguity: ${contentRegressions.join("; ")}.`,
        );
      }
    }
    const titleKey = normalize(worksheet.title);
    if (seenTitles.has(titleKey))
      errors.push(`Duplicate ${level} draft title: ${worksheet.title}.`);
    seenTitles.add(titleKey);
    const fingerprint = contentFingerprint(worksheet);
    if (seenFingerprints.has(fingerprint)) {
      errors.push(
        `${fileLabel} duplicates another worksheet's normalized content.`,
      );
    }
    seenFingerprints.add(fingerprint);
    const promptKeys = new Set(
      worksheet.questions.map((question) => normalize(question.prompt)),
    );
    for (const prompt of promptKeys) {
      if (seenPrompts.has(prompt))
        errors.push(`${fileLabel} duplicates a prompt used in another draft.`);
      seenPrompts.add(prompt);
    }
    const revisions = promptSetsByTopic.get(slot.topic_slug) ?? new Map();
    revisions.set(slot.revision_number, promptKeys);
    promptSetsByTopic.set(slot.topic_slug, revisions);
    const lessonRevisions =
      lessonFingerprintsByTopic.get(slot.topic_slug) ?? new Map();
    lessonRevisions.set(
      slot.revision_number,
      normalize(JSON.stringify(worksheet.mini_lesson)),
    );
    lessonFingerprintsByTopic.set(slot.topic_slug, lessonRevisions);
    draftsPerTopic[slot.topic_slug] =
      (draftsPerTopic[slot.topic_slug] ?? 0) + 1;
  }

  for (const slot of slots) {
    if (!seenTemplates.has(slot.template_key)) {
      errors.push(
        `${level}:${slot.topic_slug} is missing ${
          slot.revision_number === 1 ? "foundation r1" : "second revision r2"
        } draft ${slot.template_key}.`,
      );
    }
  }
  for (const [topic, revisions] of promptSetsByTopic) {
    const first = revisions.get(1);
    const second = revisions.get(2);
    if (!first || !second) continue;
    const overlap = [...first].filter((prompt) => second.has(prompt));
    if (overlap.length > 0) {
      errors.push(`${topic} r1/r2 reuse ${overlap.length} question prompts.`);
    }
  }
  if (level === "A2") {
    for (const topic of secondRevisionTopicsByLevel.A2) {
      const lessons = lessonFingerprintsByTopic.get(topic);
      if (lessons?.get(1) === lessons?.get(2)) {
        errors.push(
          `A2:${topic} r2 reuses the complete r1 mini-lesson instead of adding transfer/error-repair progression.`,
        );
      }
    }
  }
  for (const topic of new Set(slots.map((slot) => slot.topic_slug))) {
    const expected = secondRevisionTopicsByLevel[level].includes(topic) ? 2 : 1;
    if (draftsPerTopic[topic] !== expected) {
      errors.push(
        `${level}:${topic} has ${draftsPerTopic[topic] ?? 0}/${expected} authored revisions.`,
      );
    }
  }
  const b1PlannedQuestionTotal = slots.reduce(
    (total, slot) => total + slot.planned_question_count,
    0,
  );
  const b1MinimumNurseContexts = Math.ceil(b1PlannedQuestionTotal * 0.25);
  const b1MaximumNurseContexts = Math.floor(b1PlannedQuestionTotal * 0.35);
  if (
    level === "B1" &&
    (b1NurseContextQuestions < b1MinimumNurseContexts ||
      b1NurseContextQuestions > b1MaximumNurseContexts)
  ) {
    errors.push(
      `B1 drafts have ${b1NurseContextQuestions}/${b1PlannedQuestionTotal} adult-nurse context questions; the complete 46-slot portfolio requires ${b1MinimumNurseContexts}-${b1MaximumNurseContexts} (25-35%).`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    totalDrafts: draftInputs.length,
    importerValidDrafts,
    draftsPerTopic,
    templateKeys: [...seenTemplates].sort(),
  };
}

export function verifyA1WorksheetDrafts(
  matrix: unknown,
  draftInputs: WorksheetDraftInput[],
): A1WorksheetDraftReport {
  return verifyWorksheetDrafts(matrix, draftInputs, "A1");
}

async function main() {
  const argument = (name: string) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const workspaceRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const inputPath = (value: string) =>
    isAbsolute(value) ? value : resolve(workspaceRoot, value);
  const matrixPath = argument("--matrix");
  const draftsPath = argument("--dir");
  const level = (argument("--level") ?? "A1") as WorksheetDraftLevel;
  if (!matrixPath || !draftsPath) {
    throw new Error(
      "Usage: worksheet-drafts:verify -- --matrix <authoring-matrix.json> --dir <draft-directory> [--level A1|A2|B1|B2]",
    );
  }
  if (!["A1", "A2", "B1", "B2"].includes(level)) {
    throw new Error("--level must be A1, A2, B1, or B2.");
  }
  const directory = inputPath(draftsPath);
  const fileNames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const [matrix, draftInputs] = await Promise.all([
    readFile(inputPath(matrixPath), "utf8").then(
      (source) => JSON.parse(source) as unknown,
    ),
    Promise.all(
      fileNames.map(async (fileName) => ({
        fileName,
        value: JSON.parse(
          await readFile(resolve(directory, fileName), "utf8"),
        ) as unknown,
      })),
    ),
  ]);
  const report = verifyWorksheetDrafts(matrix, draftInputs, level);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
