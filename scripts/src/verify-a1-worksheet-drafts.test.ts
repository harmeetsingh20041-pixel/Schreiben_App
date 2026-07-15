import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  verifyA1WorksheetDrafts,
  type WorksheetDraftInput,
} from "./verify-a1-worksheet-drafts.js";

const matrix = JSON.parse(
  await readFile(
    new URL(
      "../../quality/worksheet-bank/authoring-matrix.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as unknown;
const draftDirectory = new URL(
  "../../quality/worksheet-bank/drafts/a1/",
  import.meta.url,
);
const draftFileNames = (await readdir(draftDirectory))
  .filter((fileName) => fileName.endsWith(".json"))
  .sort();
const checkedInDrafts: WorksheetDraftInput[] = await Promise.all(
  draftFileNames.map(async (fileName) => ({
    fileName,
    value: JSON.parse(
      await readFile(new URL(fileName, draftDirectory), "utf8"),
    ) as unknown,
  })),
);
const scriptsPackage = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const rootPackage = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

function cloneDrafts() {
  return structuredClone(checkedInDrafts) as Array<{
    fileName: string;
    value: Record<string, unknown> & {
      draft_metadata: Record<string, unknown>;
      questions: Array<Record<string, unknown>>;
    };
  }>;
}

function draftByTemplate(
  drafts: ReturnType<typeof cloneDrafts>,
  templateKey: string,
) {
  const draft = drafts.find(
    (candidate) => candidate.value.draft_metadata.template_key === templateKey,
  );
  assert.ok(draft, `Missing fixture ${templateKey}`);
  return draft.value;
}

function questionByNumber(
  draft: ReturnType<typeof draftByTemplate>,
  questionNumber: number,
) {
  const question = draft.questions.find(
    (candidate) => candidate.question_number === questionNumber,
  );
  assert.ok(question, `Missing question ${questionNumber}`);
  return question;
}

function expectFailure(
  mutate: (drafts: ReturnType<typeof cloneDrafts>) => void,
  pattern: RegExp,
) {
  const drafts = cloneDrafts();
  mutate(drafts);
  const report = verifyA1WorksheetDrafts(matrix, drafts);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), pattern);
}

test("the complete 46-slot A1 draft portfolio stays valid", () => {
  const report = verifyA1WorksheetDrafts(matrix, checkedInDrafts);

  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.totalDrafts, 46);
  assert.equal(report.importerValidDrafts, 46);
  assert.equal(report.templateKeys.length, 46);
  assert.equal(Object.keys(report.draftsPerTopic).length, 36);
  assert.equal(
    Object.values(report.draftsPerTopic).filter((count) => count === 1).length,
    26,
  );
  assert.equal(
    Object.values(report.draftsPerTopic).filter((count) => count === 2).length,
    10,
  );
});

test("every A1 foundation remains provider-independent", () => {
  const foundations = checkedInDrafts.filter((draft) =>
    draft.fileName.endsWith("-r1.json"),
  ) as Array<{ value: { questions: Array<Record<string, unknown>> } }>;
  assert.equal(foundations.length, 36);
  for (const foundation of foundations) {
    assert.equal(
      foundation.value.questions.every(
        (question) =>
          question.evaluation_mode === "local_exact" &&
          ["multiple_choice", "fill_blank"].includes(
            String(question.question_type),
          ),
      ),
      true,
    );
  }
});

test("rejects reintroducing a provider-dependent A1 foundation task", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-articles-r1");
    const question = questionByNumber(draft, 8);
    question.question_type = "sentence_correction";
    question.prompt = "Korrigiere den Satz: Das ist einen Fahrrad.";
    question.options = [];
    question.correct_answer = "Das ist ein Fahrrad.";
    question.accepted_answers = [];
    question.evaluation_mode = "open_evaluation";
    question.rubric = {
      criteria: [
        "Ersetze den falschen Artikel durch ein.",
        "Behalte den vollständigen Satz und die Zeichensetzung.",
      ],
      sample_answer: "Das ist ein Fahrrad.",
    };
  }, /foundation r1 must remain provider-independent/);
});

test("all four worksheet verification shortcuts bind the matrix and level directory", () => {
  for (const level of ["a1", "a2", "b1", "b2"] as const) {
    const scriptName = `${level}-worksheet-drafts:verify`;
    const command = scriptsPackage.scripts[scriptName];
    assert.ok(command, `Missing scripts package shortcut ${scriptName}`);
    assert.match(
      command,
      /--matrix quality\/worksheet-bank\/authoring-matrix\.json/,
    );
    assert.match(
      command,
      new RegExp(`--dir quality/worksheet-bank/drafts/${level}(?:\\s|$)`),
    );
    assert.match(
      command,
      new RegExp(`--level ${level.toUpperCase()}(?:\\s|$)`),
    );
    assert.equal(
      rootPackage.scripts[scriptName],
      `pnpm --dir scripts ${scriptName}`,
    );
  }
});

test("the portfolio matrix shortcuts work without undocumented arguments", () => {
  assert.match(
    scriptsPackage.scripts["worksheet-matrix:verify"],
    /--file quality\/worksheet-bank\/authoring-matrix\.json(?:\s|$)/,
  );
  assert.match(
    scriptsPackage.scripts["evaluator-matrix:verify"],
    /--file quality\/evaluator-corpus\/authoring-matrix\.json(?:\s|$)/,
  );
  assert.equal(
    rootPackage.scripts["worksheet-matrix:verify"],
    "pnpm --dir scripts worksheet-matrix:verify",
  );
  assert.equal(
    rootPackage.scripts["evaluator-matrix:verify"],
    "pnpm --dir scripts evaluator-matrix:verify",
  );
});

test("rejects A1 mini-lesson answer leakage", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-articles-r1");
    const lesson = draft.mini_lesson as { correct_examples: string[] };
    lesson.correct_examples[0] = questionByNumber(draft, 1)
      .correct_answer as string;
  }, /mini-lesson leaks answers/);
});

test("rejects a missing matrix draft", () => {
  expectFailure((drafts) => {
    drafts.pop();
  }, /45\/46 JSON files for A1|A1:word-order is missing foundation r1|A1:word-order has 0\/1 authored revisions/);
});

test("rejects fabricated approval or certification state", () => {
  expectFailure((drafts) => {
    drafts[0].value.draft_metadata.approval_status = "approved";
    drafts[0].value.bank_certification = {
      reviewer_id: "invented-reviewer",
    };
  }, /top-level keys|metadata does not exactly match|forbidden review\/certification/);
});

test("rejects an incomplete accepted-answer contract", () => {
  expectFailure((drafts) => {
    const exactQuestion = drafts[0].value.questions.find(
      (question) => question.evaluation_mode === "local_exact",
    )!;
    exactQuestion.accepted_answers = [];
  }, /fails importer validation.*accepted_answers/);
});

test("rejects a weak or missing semantic rubric", () => {
  expectFailure((drafts) => {
    const semanticQuestion = draftByTemplate(
      drafts,
      "v1-a1-articles-r2",
    ).questions.find(
      (question) => question.evaluation_mode === "open_evaluation",
    )!;
    semanticQuestion.rubric = {
      criteria: ["Too short"],
      sample_answer: semanticQuestion.correct_answer,
    };
  }, /under-specified explanation or semantic rubric/);
});

test("rejects question-type and evaluation-mode balance drift", () => {
  expectFailure((drafts) => {
    drafts[0].value.questions[0].question_type = "fill_blank";
    drafts[0].value.questions[0].options = [];
  }, /fails importer validation|question-type balance/);
});

test("rejects duplicate prompts across draft revisions", () => {
  expectFailure((drafts) => {
    drafts[1].value.questions[0].prompt = drafts[0].value.questions[0].prompt;
  }, /duplicates a prompt used in another draft|reuse 1 question prompts/);
});

test("rejects PII-like content in any draft field", () => {
  expectFailure((drafts) => {
    drafts[0].value.questions[0].explanation = "Kontakt: pupil@example.test";
  }, /contains PII-like email/);
});

test("rejects a filename that does not match its template key", () => {
  expectFailure((drafts) => {
    drafts[0].fileName = "wrong-a1-draft.json";
  }, /filename does not match template_key/);
});

test("rejects an exact A1 fill without a visible closed word bank", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-articles-r1");
    questionByNumber(draft, 4).prompt =
      "Setze den bestimmten Artikel im Nominativ für das neutrale Nomen Medikament ein: ___ Medikament liegt hier.";
  }, /local_exact fills without a complete visible closed word bank: 4/);
});

test("rejects a complete accepted sentence repeated in its own foundation prompt", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-conjugation-r1");
    const question = questionByNumber(draft, 7);
    question.prompt = `Welche Aussage ist richtig? ${String(question.correct_answer)}`;
  }, /repeats complete accepted answers in their own pre-answer prompts: 7/);
});

test("rejects an A1 adjective task that reveals the target form", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-adjective-endings-r1");
    questionByNumber(draft, 8).prompt =
      "Ravi braucht ein neues Diensthandy. Welche vollständige Form ist richtig?";
  }, /Q8 reveals the target adjective form/);
});

test("rejects an A1 adjective explanation without the neutral -es rule", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-adjective-endings-r1");
    questionByNumber(draft, 8).explanation =
      "Nach ein bekommt das Adjektiv hier eine passende Endung.";
  }, /Q8 reveals the target adjective form or does not explain the neutral -es ending/);
});

test("rejects marked A1 yes-no question order in either reviewed item", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-question-formation-r1");
    questionByNumber(draft, 2).prompt =
      "Welche Ja-Nein-Frage ist grammatisch möglich?";
    questionByNumber(draft, 8).prompt = "Welche Frage passt zum Gespräch?";
  }, /Q2 does not exclude marked contrastive or echo-question order.*Q8 does not exclude marked contrastive or echo-question order/);
});

test("rejects a marked object-before-subject order in the A1 standard-order task", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-word-order-r1");
    questionByNumber(draft, 7).prompt =
      "Welche Reihenfolge beginnt mit Am Morgen?";
  }, /Q7 does not exclude a grammatical marked object-before-subject order/);
});

test("rejects target A1 plurals leaked in the setup", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-plural-forms-r1");
    questionByNumber(draft, 7).prompt =
      "Asha braucht zwei Betten. Welche vollständige Aussage ist korrekt?";
    questionByNumber(draft, 8).prompt =
      "Ravi braucht drei Formulare. Welche vollständige Aussage ist korrekt?";
  }, /Q7 gives away the target plural Betten.*Q8 gives away the target plural Formulare/);
});

test("rejects a separable-verb explanation with the wrong person form", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-separable-verbs-r1");
    questionByNumber(draft, 8).explanation =
      "Im Aussagesatz steht der Verbstamm an Position zwei und an am Satzende: Ich rufe die Praxis an.";
  }, /Q8 explanation does not match the answer's third-person form ruft \.\.\. an/);
});

test("rejects the ambiguous A1 passive wird-or-ist fixture", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-passive-voice-r1");
    (draft.mini_lesson as Record<string, unknown>).key_rule =
      "Achte auf die Gruppe wird oder werden plus Partizip: Die Tür wird geschlossen.";
    questionByNumber(draft, 4).prompt =
      "Wortbank: [wird | werden | ist]. Ergänze: Das Essen ___ gekocht.";
  }, /Q4 does not disambiguate Vorgangspassiv/);
});

test("rejects a passive correction leaked verbatim by an earlier option", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-passive-voice-r1");
    const leakedAnswer = questionByNumber(draft, 1).correct_answer as string;
    const question = questionByNumber(draft, 7);
    const options = question.options as string[];
    const priorAnswer = question.correct_answer as string;
    question.options = options.map((option) =>
      option === priorAnswer ? leakedAnswer : option,
    );
    question.correct_answer = leakedAnswer;
    question.accepted_answers = [leakedAnswer];
  }, /Q1 leaks Q7's complete corrected sentence/);
});

test("rejects the ambiguous lowercase-sie capitalization fixture", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-capitalization-r1");
    questionByNumber(draft, 3).prompt =
      "Welche höfliche Frage ist richtig geschrieben?";
  }, /Q3 does not distinguish formal Sie/);
});

test("rejects Q4 capitalization fill solvable without capitalization", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-capitalization-r1");
    questionByNumber(draft, 4).prompt =
      "Wortbank: [Küche | Garten | Balkon]. Ergänze das Nomen: Der Raum zum Kochen heißt ___.";
  }, /Q4 does not make capitalization necessary/);
});

test("rejects Q5 capitalization fill solvable without capitalization", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-capitalization-r1");
    questionByNumber(draft, 5).prompt =
      "Wortbank: [Montag | Januar | Morgen]. Ergänze den Wochentag: Der erste Arbeitstag der Woche ist ___.";
  }, /Q5 does not make capitalization necessary/);
});

test("rejects capitalization choices that change sentence content", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-capitalization-r1");
    const question = questionByNumber(draft, 1);
    question.options = [
      "Variante A: Morgen Arbeite ich im großen Krankenhaus.",
      "Variante B: Morgen arbeite ich im Krankenhaus.",
      "Variante C: morgen arbeite ich im krankenhaus.",
    ];
  }, /Q1 changes sentence content instead of isolating capitalization/);
});

test("rejects a nominative fallback that no longer isolates the subject", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-nominativ-r1");
    questionByNumber(draft, 8).prompt =
      "Welche Wortgruppe passt zum Satz über die Klinik?";
  }, /Q8 neither accepts flexible nominative sentence order nor isolates subject recognition/);
});

test("rejects a register task without the reviewed professional title", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-register-r1");
    questionByNumber(draft, 7).prompt =
      "Asha schreibt ihrer neuen Pflegedienstleitung Frau Keller. Welche Nachricht ist für diesen formellen Kontakt am passendsten?";
  }, /Q7 does not preserve the professional title in its formality contract/);
});

test("rejects the overgeneralized möchte lesson warning", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-konjunktiv-r1");
    (draft.mini_lesson as Record<string, unknown>).common_mistake_warning =
      "Nach ‚möchte‘ steht ein weiteres Verb als Infinitiv, nicht als konjugierte Form.";
  }, /mini-lesson falsely implies that möchte always requires another verb/);
});

test("rejects a reciprocal treffen-uns task in the reflexive lesson", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-reflexive-verbs-r1");
    questionByNumber(draft, 6).prompt =
      "Wortbank: [uns | euch | sich]. Ergänze: Wir treffen ___ vor dem Kurs.";
  }, /Q6 uses a reciprocal treffen-uns meaning/);
});

test("rejects coherence tasks with grammar-only word-bank cues", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-coherence-r1");
    questionByNumber(draft, 4).prompt =
      "Bedeutung: Der zweite Satz bleibt beim Thema Frühstück. Wortbank: [hungrig | Frühstück | frühstücken]. Ergänze: Ich gehe in die Küche. Dort mache ich mein ___.";
  }, /Q1-Q6 do not isolate coherence with specific contexts and grammatically compatible choices/);
});

test("rejects a malformed modal meaning distractor", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-modal-verbs-r2");
    const question = questionByNumber(draft, 2);
    question.options = [
      "Die Kolleginnen möchten zusammen essen.",
      "Die Kolleginnen möchte zusammen essen.",
      "Die Kolleginnen möchten zusammen essen sie.",
    ];
  }, /Q2 lacks a grammatical meaning-based distractor/);
});

test("rejects an ungrammatical A1 time-question distractor", () => {
  expectFailure((drafts) => {
    const questionDraft = draftByTemplate(
      drafts,
      "v1-a1-question-formation-r2",
    );
    const question = questionByNumber(questionDraft, 2);
    question.options = [
      "Wann hilft dir heute?",
      "Wer hilft dir heute?",
      "Was hilft dir heute?",
    ];
  }, /Q2 contains an ungrammatical time-question distractor/);
});

test("rejects an unnatural A1 Deutschkurs question", () => {
  expectFailure((drafts) => {
    const questionDraft = draftByTemplate(
      drafts,
      "v1-a1-question-formation-r2",
    );
    questionByNumber(questionDraft, 5).prompt =
      "Wortbank: [Wann, Wo, Wie]. Setze das passende Fragewort ein: ___ hast du Deutschkurs? Am Dienstag.";
  }, /Q5 uses an unnatural Deutschkurs question/);
});

test("rejects an unnatural A1 weekday course sentence", () => {
  expectFailure((drafts) => {
    const prepositionDraft = draftByTemplate(drafts, "v1-a1-prepositions-r1");
    questionByNumber(prepositionDraft, 4).prompt =
      "Wortbank: [aus, am, um]. Setze die Präposition ein: Der Deutschkurs ist ___ Montag.";
  }, /Q4 uses an unnatural weekday course sentence/);
});

test("rejects a spelling task that supplies the corrected word", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-spelling-r1");
    questionByNumber(draft, 8).prompt =
      "Ordne die richtig geschriebenen Wörter: Meine / Adresse / ist / noch / nicht / bekannt / .";
  }, /Q8 does not require the learner to identify Adresse/);
});

test("rejects loss of the reviewed professional article context", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-articles-r1");
    questionByNumber(draft, 4).prompt =
      "Bedeutung: bestimmter Artikel im Nominativ für das neutrale Nomen Medikament. Wortbank: [Das | Der | Die]. Ergänze: ___ Medikament liegt hier.";
  }, /Q4 lacks the reviewed professional medication context/);
});

test("rejects Präteritum content beyond A1 sein and haben", () => {
  expectFailure((drafts) => {
    const draft = draftByTemplate(drafts, "v1-a1-praeteritum-r1");
    const question = questionByNumber(draft, 3);
    question.prompt = "Welche Präteritumform von ‚können‘ passt?";
    question.options = ["konnte", "kann", "gekonnt"];
    question.correct_answer = "konnte";
    question.accepted_answers = ["konnte"];
  }, /Q3 and Q6 exceed the A1 Präteritum scope of sein and haben/);
});
