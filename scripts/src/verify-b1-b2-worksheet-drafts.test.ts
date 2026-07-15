import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  verifyWorksheetDrafts,
  worksheetCrossQuestionAnswerLeakages,
  type WorksheetDraftInput,
} from "./verify-a1-worksheet-drafts.js";
import { validateWorksheet } from "./import-practice-worksheet.js";

const matrix = JSON.parse(
  await readFile(
    new URL(
      "../../quality/worksheet-bank/authoring-matrix.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as unknown;

async function checkedInDrafts(level: "A1" | "A2" | "B1" | "B2") {
  const directory = new URL(
    `../../quality/worksheet-bank/drafts/${level.toLowerCase()}/`,
    import.meta.url,
  );
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return await Promise.all(
    names.map(
      async (fileName): Promise<WorksheetDraftInput> => ({
        fileName,
        value: JSON.parse(
          await readFile(new URL(fileName, directory), "utf8"),
        ) as unknown,
      }),
    ),
  );
}

function mapStrings(
  value: unknown,
  transform: (value: string) => string,
): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) {
    return value.map((entry) => mapStrings(entry, transform));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        mapStrings(entry, transform),
      ]),
    );
  }
  return value;
}

for (const level of ["B1", "B2"] as const) {
  test(`the complete 46-slot ${level} draft portfolio stays valid`, async () => {
    const drafts = await checkedInDrafts(level);
    const report = verifyWorksheetDrafts(matrix, drafts, level);

    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
    assert.equal(report.totalDrafts, 46);
    assert.equal(report.importerValidDrafts, 46);
    assert.equal(report.templateKeys.length, 46);
    assert.equal(Object.keys(report.draftsPerTopic).length, 36);
    assert.equal(
      Object.values(report.draftsPerTopic).filter((count) => count === 1)
        .length,
      26,
    );
    assert.equal(
      Object.values(report.draftsPerTopic).filter((count) => count === 2)
        .length,
      10,
    );
  });
}

test("B1 verification rejects mini-lesson answer leakage", async () => {
  const drafts = structuredClone(await checkedInDrafts("B1")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const worksheet = drafts[0].value as {
    mini_lesson: { correct_examples: string[] };
    questions: Array<{ correct_answer: string }>;
  };
  worksheet.mini_lesson.correct_examples[0] =
    worksheet.questions[0].correct_answer;

  const report = verifyWorksheetDrafts(matrix, drafts, "B1");

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /mini-lesson leaks answers/);
});

test("B2 verification rejects mini-lesson answer leakage", async () => {
  const drafts = structuredClone(await checkedInDrafts("B2")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const worksheet = drafts[0].value as {
    mini_lesson: { correct_examples: string[] };
    questions: Array<{ correct_answer: string }>;
  };
  worksheet.mini_lesson.correct_examples[0] =
    worksheet.questions[0].correct_answer;

  const report = verifyWorksheetDrafts(matrix, drafts, "B2");

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /mini-lesson leaks answers/);
});

test("B2 verification rejects the ambiguous Konjunktiv-I prompt", async () => {
  const drafts = structuredClone(await checkedInDrafts("B2")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b2-konjunktiv-r2.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{ question_number: number; prompt: string }>;
  };
  const question = worksheet.questions.find(
    (candidate) => candidate.question_number === 1,
  );
  assert(question);
  question.prompt =
    "Welche indirekte Wiedergabe der Aussage „Ich habe den Bericht geprüft“ ist korrekt?";

  const report = verifyWorksheetDrafts(matrix, drafts, "B2");

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /known B2 ambiguity/);
});

test("B2 verification rejects a long exact answer exposed by another question", async () => {
  const drafts = structuredClone(await checkedInDrafts("B2")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b2-future-tense-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{
      question_number: number;
      prompt: string;
      correct_answer: string;
      accepted_answers: string[];
    }>;
  };
  const question = worksheet.questions.find(
    (candidate) => candidate.question_number === 5,
  );
  assert(question);
  question.prompt =
    "Wortbank: [abgeschlossen, abgeschlossen haben, abschließen]. Ergänze Futur II: Bis Monatsende werden wir die Auswertung ___.";
  question.correct_answer = "abgeschlossen haben";
  question.accepted_answers = ["abgeschlossen haben"];

  const report = verifyWorksheetDrafts(matrix, drafts, "B2");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /exposes complete answers in other pre-answer questions/,
  );
});

test("B1 verification rejects an Akkusativ transformation whose rubric exceeds its instruction", async () => {
  const drafts = structuredClone(await checkedInDrafts("B1")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b1-akkusativ-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{ question_number: number; prompt: string }>;
  };
  const question = worksheet.questions.find(
    (candidate) => candidate.question_number === 9,
  );
  assert(question);
  question.prompt =
    "Ersetze das wiederholte Akkusativobjekt im zweiten Satz durch ein Pronomen: Die Juristin liest den Vertrag. Danach unterschreibt die Juristin den Vertrag.";

  const report = verifyWorksheetDrafts(matrix, drafts, "B1");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /Q9 instruction asks only for the object while its rubric also requires subject replacement/,
  );
});

test("the audited B2 ambiguity and wording repairs stay applied", async () => {
  const drafts = await checkedInDrafts("B2");
  const byName = new Map(drafts.map((draft) => [draft.fileName, draft.value]));
  const worksheet = (fileName: string) => {
    const value = byName.get(fileName);
    assert(value, `missing ${fileName}`);
    return value as {
      mini_lesson: {
        key_rule: string;
        correct_examples: string[];
        common_mistake_warning: string;
      };
      questions: Array<{
        question_number: number;
        prompt: string;
        options: string[];
        correct_answer: string;
        accepted_answers: string[];
      }>;
    };
  };
  const question = (fileName: string, questionNumber: number) => {
    const value = worksheet(fileName).questions.find(
      (candidate) => candidate.question_number === questionNumber,
    );
    assert(value, `missing ${fileName} Q${questionNumber}`);
    return value;
  };

  assert.match(
    question("v1-b2-capitalization-r1.json", 1).prompt,
    /vollständig korrekt groß- und kleingeschrieben/,
  );
  assert.doesNotMatch(
    question("v1-b2-negation-r1.json", 3).options.join("\n"),
    /findet heute nicht statt, sondern morgen/,
  );
  assert.match(
    question("v1-b2-pronouns-r1.json", 3).correct_answer,
    /mit dem Arzt; dieser/,
  );
  assert.equal(question("v1-b2-pronouns-r1.json", 7).correct_answer, "denen");
  assert.match(
    question("v1-b2-register-r2.json", 4).prompt,
    /ausdrücklich den Konjunktiv I/,
  );
  const genitiveQuestion = question("v1-b2-genitiv-r1.json", 7);
  assert.equal(genitiveQuestion.correct_answer, "ihres kritischen Zustands");
  assert.match(genitiveQuestion.prompt, /technische Anlage/);
  assert.doesNotMatch(genitiveQuestion.prompt, /Patient|Beobachtung/i);
  assert.equal(question("v1-b2-konjunktiv-r1.json", 7).correct_answer, "wären");
  assert.doesNotMatch(
    question("v1-b2-konjunktiv-r1.json", 7).prompt,
    /___ ihr Plätze bekommen/,
  );
  assert.equal(
    question("v1-b2-word-order-r2.json", 6).correct_answer,
    "es uns",
  );
  assert.match(
    worksheet("v1-b2-conjunctions-r1.json").mini_lesson.common_mistake_warning,
    /nicht zusätzlich mit „aber“/,
  );
  assert.match(
    worksheet("v1-b2-plusquamperfekt-r1.json").mini_lesson.key_rule,
    /hatte ändern müssen/,
  );
  assert.doesNotMatch(
    worksheet("v1-b2-negation-r1.json").mini_lesson.correct_examples.join("\n"),
    /durchaus nicht unvermeidbar|keineswegs unvermeidbar/,
  );

  const serialized = JSON.stringify([
    worksheet("v1-b2-infinitive-zu-r1.json"),
    worksheet("v1-b2-nominativ-r1.json"),
    worksheet("v1-b2-connectors-r2.json"),
    worksheet("v1-b2-passive-voice-r1.json"),
    worksheet("v1-b2-task-fulfilment-r1.json"),
    worksheet("v1-b2-task-fulfilment-r2.json"),
    worksheet("v1-b2-punctuation-r2.json"),
  ]);
  for (const staleWording of [
    "ausdrücklich begleitende Unterlassung",
    "auf die Praxis",
    "einen erfahrenen Intensivpfleger",
    "Absprachen über erreichbare Zeiten",
    "Offene Zugriffsrechte",
    "vorgesehene Verwaltungsaufgaben",
    "In der Gesamtbewertung",
    "einen paarigen Gedankenstrich",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(staleWording));
  }
});

test("the launch bank keeps the final B1/B2 content and nursing-transfer repairs", async () => {
  const b1Drafts = await checkedInDrafts("B1");
  const b2Drafts = await checkedInDrafts("B2");
  const b1ByName = new Map(
    b1Drafts.map((draft) => [draft.fileName, draft.value]),
  );
  const b2ByName = new Map(
    b2Drafts.map((draft) => [draft.fileName, draft.value]),
  );
  const question = (
    drafts: Map<string, unknown>,
    fileName: string,
    questionNumber: number,
  ) => {
    const worksheet = drafts.get(fileName) as
      | {
          questions: Array<{
            question_number: number;
            prompt: string;
            options: string[];
            correct_answer: string;
            accepted_answers: string[];
            explanation: string;
          }>;
        }
      | undefined;
    assert(worksheet, `missing ${fileName}`);
    const value = worksheet.questions.find(
      (candidate) => candidate.question_number === questionNumber,
    );
    assert(value, `missing ${fileName} Q${questionNumber}`);
    return value;
  };

  const punctuation = question(b2ByName, "v1-b2-punctuation-r2.json", 9);
  assert.match(punctuation.prompt, /Gedankenstrichpaar/);
  assert.match(punctuation.correct_answer, /– darin waren sich alle einig –/);

  const deadline = question(b2ByName, "v1-b2-prepositions-r1.json", 5);
  assert.match(deadline.prompt, /innerhalb.*eines Monats/);
  assert.doesNotMatch(deadline.prompt, /30 Tage/);

  const passivePerfect = question(b2ByName, "v1-b2-infinitive-zu-r1.json", 10);
  assert.match(passivePerfect.prompt, /Passiv-Perfektinfinitiv/);
  assert.match(passivePerfect.correct_answer, /informiert worden zu sein/);
  assert.equal(passivePerfect.options[2], passivePerfect.correct_answer);
  assert.deepEqual(passivePerfect.accepted_answers, [
    passivePerfect.correct_answer,
  ]);
  assert.match(passivePerfect.explanation, /Partizip II.*worden.*zu sein/);
  assert.notEqual(
    passivePerfect.prompt,
    question(b2ByName, "v1-b2-infinitive-zu-r1.json", 8).prompt,
  );

  const coherence = [1, 2, 3, 8].flatMap(
    (questionNumber) =>
      question(b1ByName, "v1-b1-coherence-r1.json", questionNumber).options,
  );
  const serializedCoherence = coherence.join("\n");
  for (const staleDistractor of [
    "Vorher ist anschließend",
    "Mittagessen heute besonders gut",
    "Dieser findet jene irgendwann darin",
    "Schließlich war vorher die Pflegekraft vollständig",
  ]) {
    assert.doesNotMatch(serializedCoherence, new RegExp(staleDistractor));
  }

  const nursingTransferFiles = [
    "v1-b2-capitalization-r1.json",
    "v1-b2-coherence-r2.json",
    "v1-b2-connectors-r1.json",
    "v1-b2-connectors-r2.json",
    "v1-b2-konjunktiv-r1.json",
    "v1-b2-konjunktiv-r2.json",
    "v1-b2-negation-r1.json",
    "v1-b2-passive-voice-r1.json",
    "v1-b2-passive-voice-r2.json",
    "v1-b2-perfekt-r1.json",
    "v1-b2-punctuation-r1.json",
    "v1-b2-question-formation-r1.json",
    "v1-b2-relative-clauses-r1.json",
    "v1-b2-spelling-r1.json",
    "v1-b2-verb-position-r1.json",
    "v1-b2-word-order-r1.json",
  ];
  for (const fileName of nursingTransferFiles) {
    const worksheet = b2ByName.get(fileName);
    assert(worksheet, `missing ${fileName}`);
    assert.match(
      JSON.stringify(worksheet),
      /pflege/iu,
      `${fileName} lacks a privacy-safe nursing-transfer context`,
    );
  }
});

test("B2 verification rejects the second valid modal purpose clause", async () => {
  const drafts = structuredClone(await checkedInDrafts("B2")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b2-infinitive-zu-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{ question_number: number; options: string[] }>;
  };
  const question = worksheet.questions.find(
    (item) => item.question_number === 9,
  );
  assert(question);
  question.options[1] =
    "Die Pflegedienstleitung führt kurze Übergaben ein, um Informationsverluste vermeiden zu können.";

  const report = verifyWorksheetDrafts(matrix, drafts, "B2");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /second grammatical purpose clause with a modal infinitive/,
  );
});

test("B2 verification rejects connector blanks without an exact relation cue", async () => {
  const drafts = structuredClone(await checkedInDrafts("B2")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b2-connectors-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{ question_number: number; prompt: string }>;
  };
  const question = worksheet.questions.find(
    (item) => item.question_number === 5,
  );
  assert(question);
  question.prompt = question.prompt.replace(
    "Ergänze den unerwarteten Gegensatz",
    "Ergänze passend",
  );

  const report = verifyWorksheetDrafts(matrix, drafts, "B2");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /Q5 lacks an explicit connector-relation cue/,
  );
});

test("B2 verification rejects a punctuation explanation that drops its own commas", async () => {
  const drafts = structuredClone(await checkedInDrafts("B2")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b2-punctuation-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{ question_number: number; explanation: string }>;
  };
  const question = worksheet.questions.find(
    (item) => item.question_number === 8,
  );
  assert(question);
  question.explanation =
    "Der eingeschobene Relativsatz den die Arbeitsgruppe entwickelt hat muss auf beiden Seiten mit Kommas abgegrenzt werden.";

  const report = verifyWorksheetDrafts(matrix, drafts, "B2");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /fails to delimit the cited relative clause correctly/,
  );
});

test("B2 verification rejects the static-versus-moving Wechselpräposition shortcut", async () => {
  const drafts = structuredClone(await checkedInDrafts("B2")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b2-dativ-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    mini_lesson: { key_rule: string };
  };
  worksheet.mini_lesson.key_rule =
    "Unterscheide bei Wechselpräpositionen zwischen statischem Ort und gerichteter Bewegung.";

  const report = verifyWorksheetDrafts(matrix, drafts, "B2");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /overgeneralizes Wechselpräpositionen as static versus moving/,
  );
});

test("B2 verification rejects a blanket auxiliary-final Plusquamperfekt warning", async () => {
  const drafts = structuredClone(await checkedInDrafts("B2")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b2-plusquamperfekt-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    mini_lesson: { common_mistake_warning: string };
  };
  worksheet.mini_lesson.common_mistake_warning =
    "Stelle im Nebensatz das Hilfsverb immer ans Ende.";

  const report = verifyWorksheetDrafts(matrix, drafts, "B2");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /omits the Ersatzinfinitiv auxiliary-order exception/,
  );
});

test("B2 verification rejects an elementary one-token r1 tail", async () => {
  const drafts = structuredClone(await checkedInDrafts("B2")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b2-register-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{
      question_number: number;
      question_type: string;
      prompt: string;
      options: string[];
      correct_answer: string;
      accepted_answers: string[];
      rubric: null;
      evaluation_mode: string;
    }>;
  };
  const question = worksheet.questions.find(
    (item) => item.question_number === 10,
  );
  assert(question);
  question.question_type = "fill_blank";
  question.prompt =
    "Wortbank: [Sie | du | ihr]. Ergänze die formelle Bitte: Könnten ___ mir helfen?";
  question.options = [];
  question.correct_answer = "Sie";
  question.accepted_answers = ["Sie"];
  question.rubric = null;
  question.evaluation_mode = "local_exact";

  const report = verifyWorksheetDrafts(matrix, drafts, "B2");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /Q10 does not retain a deterministic full-sentence B2 transfer task/,
  );
});

test("the audited B1 accuracy and answer-design repairs stay applied", async () => {
  const drafts = await checkedInDrafts("B1");
  const byName = new Map(drafts.map((draft) => [draft.fileName, draft.value]));
  const worksheet = (fileName: string) => {
    const value = byName.get(fileName);
    assert(value, `missing ${fileName}`);
    return value as {
      mini_lesson: { what_to_revise: string };
      questions: Array<{
        question_number: number;
        prompt: string;
        options: string[];
        correct_answer: string;
        accepted_answers: string[];
      }>;
    };
  };
  const question = (fileName: string, questionNumber: number) => {
    const value = worksheet(fileName).questions.find(
      (candidate) => candidate.question_number === questionNumber,
    );
    assert(value, `missing ${fileName} Q${questionNumber}`);
    return value;
  };

  assert.match(
    worksheet("v1-b1-adjective-endings-r2.json").mini_lesson.what_to_revise,
    /gemischte Endungen nach kein- und mein-Wörtern/,
  );
  assert.match(
    question("v1-b1-genitiv-r1.json", 7).prompt,
    /standardsprachlich mit Genitiv/,
  );
  assert.deepEqual(question("v1-b1-connectors-r2.json", 5).accepted_answers, [
    "sodass",
  ]);
  assert.match(
    question("v1-b1-connectors-r2.json", 5).prompt,
    /zusammengeschriebene Form/,
  );
  assert.deepEqual(
    question("v1-b1-infinitive-zu-r1.json", 6).accepted_answers,
    ["kennenzulernen"],
  );
  assert.match(
    question("v1-b1-infinitive-zu-r1.json", 6).prompt,
    /zusammengeschriebenen Form/,
  );
  assert.doesNotMatch(
    question("v1-b1-future-tense-r1.json", 5).prompt,
    /wirst du,/,
  );
  assert.doesNotMatch(
    question("v1-b1-praeteritum-r2.json", 4).prompt,
    /werteten aus/,
  );
  assert.match(
    question("v1-b1-separable-verbs-r1.json", 9).prompt,
    /Wir fahren mit dem Bus.*Der Zug fällt heute aus/,
  );
  assert.equal(
    question("v1-b1-capitalization-r1.json", 1).correct_answer,
    "Bitte beachten Sie Folgendes im neuen Dienstplan.",
  );
  const capitalizationRecognition = question(
    "v1-b1-capitalization-r1.json",
    10,
  );
  assert.match(capitalizationRecognition.correct_answer, /Beim Planen/);
  assert.match(capitalizationRecognition.correct_answer, /Ihre Rückmeldung/);
  assert.match(capitalizationRecognition.correct_answer, /Ich danke Ihnen/);
  assert.doesNotMatch(
    question("v1-b1-conjunctions-r1.json", 10).correct_answer,
    /damit alle informiert waren/,
  );
  const articleRecognition = question("v1-b1-articles-r1.json", 10);
  assert.match(articleRecognition.correct_answer, /eine neue Regelung/);
  assert.match(articleRecognition.correct_answer, /Die Regelung/);
  assert.match(articleRecognition.correct_answer, /mit den Pflegekräften/);
  assert.match(
    question("v1-b1-infinitive-zu-r2.json", 1).correct_answer,
    /zusammenzufassen/,
  );
  assert.equal(
    question("v1-b1-infinitive-zu-r2.json", 7).correct_answer,
    "einzuarbeiten",
  );
  assert.match(
    question("v1-b1-pronouns-r1.json", 10).correct_answer,
    /Pflegefachkraft/,
  );
  assert.match(
    question("v1-b1-passive-voice-r2.json", 10).correct_answer,
    /Dienstplan ist bereits besprochen worden/,
  );

  const familiarColleague = question("v1-b1-register-r1.json", 3);
  assert.match(familiarColleague.prompt, /freundliche Bitte/);
  assert.equal(
    familiarColleague.correct_answer,
    "Hallo Mira, kannst du morgen meine Frühbesprechung übernehmen?",
  );
  assert.deepEqual(familiarColleague.options, [
    "Hallo Mira, du musst morgen meine Frühbesprechung übernehmen.",
    familiarColleague.correct_answer,
    "Sehr geehrte Frau Meier, wären Sie zur Übernahme meiner Frühbesprechung bereit?",
  ]);

  const replacementRequest = question("v1-b1-task-fulfilment-r1.json", 5);
  assert.match(replacementRequest.prompt, /konkrete Bitte.*Ersatztermin/);
  assert.equal(
    replacementRequest.correct_answer,
    "Könnten Sie mir bitte einen neuen Termin nennen",
  );
  assert.deepEqual(replacementRequest.accepted_answers, [
    replacementRequest.correct_answer,
  ]);
  const replacementBank = replacementRequest.prompt.match(
    /Wortbank: \[([^\]]+)\]/,
  );
  assert(replacementBank);
  const replacementChoices = replacementBank[1].split(", ");
  assert.deepEqual(replacementChoices, [
    replacementRequest.correct_answer,
    "Könnten Sie mir den Grund für die Terminänderung nennen",
    "Ich wäre Ihnen für eine Rückmeldung dankbar",
  ]);
  const replacementDistractors = replacementChoices.filter(
    (choice) => choice !== replacementRequest.correct_answer,
  );
  assert.equal(replacementDistractors.length, 2);
  for (const distractor of replacementDistractors) {
    assert.doesNotMatch(
      distractor,
      /(?:Ersatztermin|neuen Termin|anderen Termin|Termine verfügbar)/i,
    );
  }

  const strengthened = JSON.stringify([
    ...worksheet("v1-b1-register-r1.json").questions.slice(0, 7),
    ...worksheet("v1-b1-task-fulfilment-r1.json").questions.slice(3, 7),
  ]);
  for (const staleDistractor of [
    "Schick mir mal schnell",
    "alles vermasselt",
    "Kannste",
    "Pass bloß auf",
    "Bis denne",
    "Das Wetter ist heute schön",
    "Der Kurs hat mehrere Räume",
  ]) {
    assert.doesNotMatch(strengthened, new RegExp(staleDistractor));
  }
});

test("B1 pronoun Q8 keeps form and order recognition aligned", async () => {
  const drafts = await checkedInDrafts("B1");
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b1-pronouns-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{
      question_number: number;
      prompt: string;
      question_type: string;
      evaluation_mode: string;
      options: string[];
      correct_answer: string;
      accepted_answers: string[];
      explanation: string;
      rubric: { criteria: string[]; sample_answer: string } | null;
    }>;
  };
  const question = worksheet.questions.find(
    (candidate) => candidate.question_number === 8,
  );
  assert(question);
  assert.match(question.prompt, /das falsche Pronomen und die Reihenfolge/);
  assert.equal(
    question.correct_answer,
    "Die Projektleiterin erklärt der neuen Kollegin den Vertrag. Sie erklärt ihn ihr ausführlich.",
  );
  assert.equal(question.question_type, "multiple_choice");
  assert.equal(question.evaluation_mode, "local_exact");
  assert.equal(question.rubric, null);
  assert.deepEqual(question.accepted_answers, [question.correct_answer]);
  assert.equal(
    question.options.filter((option) => option === question.correct_answer)
      .length,
    1,
  );
  assert.match(question.explanation, /Akkusativpronomen.*vor/);
});

test("B1 pronoun lesson keeps an unambiguous ordinary surname", async () => {
  const drafts = await checkedInDrafts("B1");
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b1-pronouns-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    mini_lesson: { correct_examples: string[] };
  };
  assert.deepEqual(worksheet.mini_lesson.correct_examples, [
    "Der Bericht ist fertig. Ich schicke ihn heute ab.",
    "Frau Weber braucht Hilfe. Wir erklären ihr den Ablauf.",
  ]);
});

test("B1 task-fulfilment Q8 remains a safe append-only recognition task", async () => {
  const drafts = await checkedInDrafts("B1");
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b1-task-fulfilment-r1.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{
      question_number: number;
      prompt: string;
      question_type: string;
      evaluation_mode: string;
      options: string[];
      correct_answer: string;
      accepted_answers: string[];
      rubric: { criteria: string[]; sample_answer: string } | null;
    }>;
  };
  const question = worksheet.questions.find(
    (candidate) => candidate.question_number === 8,
  );
  assert(question);
  assert.match(question.prompt, /ausschließlich um die noch fehlende Bitte/);
  assert.match(question.prompt, /vorhandenen Sätze unverändert/);
  assert.equal(
    question.correct_answer,
    "In der Dokumentation war ein falscher Wert. Ich habe ihn korrigiert. Könnten Sie mir bitte kurz bestätigen, dass Sie die Korrektur gesehen haben?",
  );
  assert.equal(question.question_type, "multiple_choice");
  assert.equal(question.evaluation_mode, "local_exact");
  assert.equal(question.rubric, null);
  assert.deepEqual(question.accepted_answers, [question.correct_answer]);
  assert.equal(
    question.options.filter((option) => option === question.correct_answer)
      .length,
    1,
  );
  assert.doesNotMatch(
    JSON.stringify({
      prompt: question.prompt,
      correct_answer: question.correct_answer,
    }),
    /Blutdruck|erneuten Kontrolle|bestätigten Wert/,
  );
});

test("all 184 checked-in drafts have no cross-question answer leakage", async () => {
  const errors: string[] = [];
  let fileCount = 0;
  for (const level of ["A1", "A2", "B1", "B2"] as const) {
    const drafts = await checkedInDrafts(level);
    for (const draft of drafts) {
      fileCount += 1;
      const worksheet = validateWorksheet(draft.value);
      for (const leakage of worksheetCrossQuestionAnswerLeakages(worksheet)) {
        errors.push(
          `${draft.fileName}: Q${leakage.visibleQuestionNumber} exposes Q${leakage.answerQuestionNumber}`,
        );
      }
    }
  }

  assert.equal(fileCount, 184);
  assert.deepEqual(errors, []);
});

test("B1 verification rejects omitted free-text spelling variants without an explicit spelling constraint", async () => {
  const drafts = structuredClone(await checkedInDrafts("B1")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b1-connectors-r2.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{
      question_number: number;
      prompt: string;
      accepted_answers: string[];
    }>;
  };
  const question = worksheet.questions.find(
    (candidate) => candidate.question_number === 5,
  );
  assert(question);
  question.prompt = question.prompt.replace(
    "Verwende die zusammengeschriebene Form und ",
    "",
  );
  question.accepted_answers = ["sodass"];

  const report = verifyWorksheetDrafts(matrix, drafts, "B1");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /omits required free-text orthographic variants/,
  );
});

test("B1 verification rejects a negated joined-spelling instruction", async () => {
  const drafts = structuredClone(await checkedInDrafts("B1")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b1-connectors-r2.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{
      question_number: number;
      prompt: string;
      accepted_answers: string[];
    }>;
  };
  const question = worksheet.questions.find(
    (candidate) => candidate.question_number === 5,
  );
  assert(question);
  question.prompt = question.prompt.replace(
    "Verwende die zusammengeschriebene Form",
    "Nicht: Verwende die zusammengeschriebene Form",
  );
  question.accepted_answers = ["sodass"];

  const report = verifyWorksheetDrafts(matrix, drafts, "B1");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /omits required free-text orthographic variants/,
  );
});

test("B1 verification rejects an incidental joined-spelling mention", async () => {
  const drafts = structuredClone(await checkedInDrafts("B1")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b1-connectors-r2.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{
      question_number: number;
      prompt: string;
      accepted_answers: string[];
    }>;
  };
  const question = worksheet.questions.find(
    (candidate) => candidate.question_number === 5,
  );
  assert(question);
  question.prompt = question.prompt.replace(
    "Verwende die zusammengeschriebene Form und ergänze den Folgekonnektor",
    "Die zusammengeschriebene Form steht nur im Hinweis. Ergänze den Folgekonnektor",
  );
  question.accepted_answers = ["sodass"];

  const report = verifyWorksheetDrafts(matrix, drafts, "B1");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /omits required free-text orthographic variants/,
  );
});

test("B1 verification rejects a known defensible multiple-choice distractor", async () => {
  const drafts = structuredClone(await checkedInDrafts("B1")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b1-adjective-endings-r2.json",
  );
  assert(target);
  const worksheet = target.value as {
    questions: Array<{ question_number: number; options: string[] }>;
  };
  const question = worksheet.questions.find(
    (candidate) => candidate.question_number === 2,
  );
  assert(question);
  question.options[1] = "mit frischem zubereiteten Essen";

  const report = verifyWorksheetDrafts(matrix, drafts, "B1");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /reintroduces known scoring ambiguity/,
  );
});

test("B1 verification rejects advanced infinitive markers in the B1 repair worksheet", async () => {
  const drafts = structuredClone(await checkedInDrafts("B1")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  const target = drafts.find(
    (draft) => draft.fileName === "v1-b1-infinitive-zu-r2.json",
  );
  assert(target);
  const worksheet = target.value as {
    mini_lesson: { short_explanation: string };
  };
  worksheet.mini_lesson.short_explanation += " Perfektinfinitiv.";

  const report = verifyWorksheetDrafts(matrix, drafts, "B1");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /reintroduces above-safe-B1 infinitive constructions/,
  );
});

test("B1 verification rejects an underrepresented adult-nurse context portfolio", async () => {
  const drafts = structuredClone(await checkedInDrafts("B1")) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  for (const draft of drafts) {
    draft.value = mapStrings(draft.value, (value) =>
      value.replace(
        /pflegekräfte|pflegekraft|pflegeteam|pflegestation|stationsleitung|krankenhaus|übergabe|dienstplan|schicht|ärztin|arzt|patientin|patient|dokumentation/giu,
        "Arbeitskontext",
      ),
    ) as Record<string, unknown>;
  }

  const report = verifyWorksheetDrafts(matrix, drafts, "B1");

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /adult-nurse context questions/);
});
