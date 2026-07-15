import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  verifyWorksheetDrafts,
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
  "../../quality/worksheet-bank/drafts/a2/",
  import.meta.url,
);
const fileNames = (await readdir(draftDirectory))
  .filter((fileName) => fileName.endsWith(".json"))
  .sort();
const drafts: WorksheetDraftInput[] = await Promise.all(
  fileNames.map(async (fileName) => ({
    fileName,
    value: JSON.parse(
      await readFile(new URL(fileName, draftDirectory), "utf8"),
    ) as unknown,
  })),
);

function cloneDrafts() {
  return structuredClone(drafts) as Array<{
    fileName: string;
    value: Record<string, unknown> & {
      draft_metadata: Record<string, unknown>;
      mini_lesson: Record<string, unknown>;
      questions: Array<Record<string, unknown>>;
    };
  }>;
}

function draftByTemplate(changed: ReturnType<typeof cloneDrafts>, key: string) {
  return changed.find(
    (draft) => draft.value.draft_metadata.template_key === key,
  )!.value;
}

function questionByNumber(
  draft: ReturnType<typeof draftByTemplate>,
  number: number,
) {
  return draft.questions.find(
    (question) => question.question_number === number,
  )!;
}

function expectFailure(
  mutate: (changed: ReturnType<typeof cloneDrafts>) => void,
  pattern: RegExp,
) {
  const changed = cloneDrafts();
  mutate(changed);
  const report = verifyWorksheetDrafts(matrix, changed, "A2");
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), pattern);
}

test("the complete 46-slot A2 draft portfolio stays valid", () => {
  const report = verifyWorksheetDrafts(matrix, drafts, "A2");

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

test("every A2 foundation remains provider-independent", () => {
  const foundations = drafts.filter((draft) =>
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

test("rejects reintroducing a provider-dependent A2 foundation task", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-articles-r1");
    const question = questionByNumber(draft, 8);
    question.question_type = "sentence_correction";
    question.prompt = "Korrigiere den Artikel: Ich sehe die Mann.";
    question.options = [];
    question.correct_answer = "Ich sehe den Mann.";
    question.accepted_answers = [];
    question.evaluation_mode = "open_evaluation";
    question.rubric = {
      criteria: [
        "Ersetze die durch den passenden Akkusativartikel.",
        "Behalte den vollständigen Satz und die Zeichensetzung.",
      ],
      sample_answer: "Ich sehe den Mann.",
    };
  }, /foundation r1 must remain provider-independent/);
});

test("rejects A2 mini-lesson answer leakage", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-plural-forms-r2");
    const lesson = draft.mini_lesson as { correct_examples: string[] };
    lesson.correct_examples[0] = questionByNumber(draft, 1)
      .correct_answer as string;
  }, /mini-lesson leaks answers/);
});

test("rejects a complete answer leaked by an A2 key rule", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-pronouns-r2");
    draft.mini_lesson.key_rule = questionByNumber(draft, 8)
      .correct_answer as string;
  }, /mini-lesson leaks answers/);
});

test("rejects a complete lesson answer leak without terminal punctuation", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-pronouns-r2");
    draft.mini_lesson.key_rule = String(
      questionByNumber(draft, 8).correct_answer,
    ).replace(/[.!?…]+$/u, "");
  }, /mini-lesson leaks answers/);
});

test("rejects short worksheet-specific plural answers in the A2 key rule", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-plural-forms-r2");
    draft.mini_lesson.key_rule =
      "Lerne unregelmäßige und fremde Plurale als Einheit: das Museum – die Museen, das Zentrum – die Zentren.";
  }, /mini-lesson key rule gives away plural answers/);
});

test("rejects an underspecified singular feminine pronoun correction", () => {
  expectFailure((changed) => {
    questionByNumber(draftByTemplate(changed, "v1-a2-pronouns-r2"), 6).prompt =
      "Korrigiere den Kasus des Pronomens: Das Geschenk gehört sie.";
  }, /singular feminine ihr correction/);
});

test("rejects an ambiguous sentence-initial Sie separable-verb subject", () => {
  expectFailure((changed) => {
    questionByNumber(
      draftByTemplate(changed, "v1-a2-separable-verbs-r2"),
      4,
    ).prompt =
      "Wortbank: [bringen, bringt, bringst]. Setze die konjugierte Form von mitbringen ein: Sie ___ einen Salat mit.";
  }, /sentence-initial Sie ambiguous/);
});

test("rejects finite separable-verb forms mislabeled as stems", () => {
  expectFailure((changed) => {
    questionByNumber(
      draftByTemplate(changed, "v1-a2-separable-verbs-r2"),
      5,
    ).prompt =
      "Wortbank: [kommst, kommen, kommt]. Setze den konjugierten Verbstamm von zurückkommen ein: Mein Bruder ___ am Sonntag zurück.";
  }, /finite conjugated form kommt a verb stem/);
});

test("A2 verification rejects a draft carrying A1 release labeling", () => {
  const changed = structuredClone(drafts) as Array<{
    fileName: string;
    value: Record<string, unknown>;
  }>;
  changed[0].value.source_label =
    "V1 A1 draft worksheet; unapproved and not certified";

  const report = verifyWorksheetDrafts(matrix, changed, "A2");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /does not match its A2 topic\/difficulty\/private draft contract/,
  );
});

test("A2 verification rejects an omitted canonical slot", () => {
  const report = verifyWorksheetDrafts(matrix, drafts.slice(1), "A2");

  assert.equal(report.ok, false);
  assert.match(
    report.errors.join("\n"),
    /45\/46 JSON files for A2|A2:adjective-endings is missing foundation r1|A2:adjective-endings has 1\/2 authored revisions/,
  );
});

test("rejects the ambiguous singular-or-plural genitive fixture", () => {
  expectFailure((changed) => {
    questionByNumber(draftByTemplate(changed, "v1-a2-genitiv-r1"), 1).prompt =
      "Welche Genitivgruppe drückt Zugehörigkeit korrekt aus?";
  }, /Q1 does not exclude the valid genitive-plural option/);
});

test("rejects a capitalization question with several valid options", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-capitalization-r1");
    questionByNumber(draft, 2).prompt =
      "Welche Nominalisierung ist korrekt geschrieben?";
  }, /Q2 asks only about a nominalization/);
});

test("rejects a capitalization task that supplies every capitalization", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-capitalization-r1");
    questionByNumber(draft, 7).prompt =
      "Ordne die Teile und erhalte die korrekte Schreibung: [Am Morgen / liest / die Ärztin / den Bericht].";
  }, /Q7 does not require a capitalization-only correction/);
});

test("rejects an A2 capitalization correction that drops source words", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-capitalization-r1");
    questionByNumber(draft, 7).prompt =
      "Korrigiere nur die Groß- und Kleinschreibung in „am morgen liest die pflegekraft den bericht.“; bewahrt alle Wörter und ihre Reihenfolge.";
  }, /Q7 changes lexical content instead of preserving the capitalization source/);
});

test("rejects A2 foundation exact fills without visible closed word banks", () => {
  expectFailure((changed) => {
    const perfekt = draftByTemplate(changed, "v1-a2-perfekt-r1");
    questionByNumber(perfekt, 3).prompt =
      "Setze die passende Form von spielen ein: Wir haben gestern Fußball ___.";
    const plurals = draftByTemplate(changed, "v1-a2-plural-forms-r1");
    questionByNumber(plurals, 3).prompt =
      "Setze die richtige Form von Kind ein: Im Garten spielen viele ___.";
  }, /v1-a2-perfekt-r1\.json has local_exact fills without a complete visible closed word bank: 3[\s\S]*v1-a2-plural-forms-r1\.json has local_exact fills without a complete visible closed word bank: 3/);
});

test("rejects an ambiguous conjunction cue", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-conjunctions-r2");
    questionByNumber(draft, 4).prompt =
      "Wortbank: [bevor, obwohl, denn]. Setze ein: Ich kontrolliere die Tür, ___ ich das Haus verlasse.";
  }, /Q4 does not distinguish bevor/);
});

test("rejects a conjunction rubric that excludes afterposed clauses", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-conjunctions-r2");
    const rubric = questionByNumber(draft, 8).rubric as Record<string, unknown>;
    rubric.criteria = [
      "Beginne mit Obwohl und setze hat ans Ende des Nebensatzes.",
      "Übernimm beide Aussagen und setze hilft nach dem Komma an die erste Stelle des Hauptsatzes.",
    ];
  }, /Q8 rubric rejects a valid afterposed/);
});

test("rejects a passive prompt that makes agent omission optional", () => {
  expectFailure((changed) => {
    questionByNumber(
      draftByTemplate(changed, "v1-a2-passive-voice-r1"),
      8,
    ).prompt =
      "Forme ins Passiv um; die handelnde Person muss nicht genannt werden: Das Team prüft den Bericht.";
  }, /Q8 says the agent is optional/);
});

test("rejects a reflexive washing prompt with a non-reflexive reading", () => {
  expectFailure((changed) => {
    const first = draftByTemplate(changed, "v1-a2-reflexive-verbs-r1");
    questionByNumber(first, 3).prompt =
      "Wortbank: [sich, ihm, ihn]. Setze ein: Er wäscht ___ vor dem Frühstück.";
  }, /grammatical non-reflexive/);
});

test("rejects a reciprocal prompt in a reflexive worksheet", () => {
  expectFailure((changed) => {
    const first = draftByTemplate(changed, "v1-a2-reflexive-verbs-r1");
    questionByNumber(first, 4).prompt =
      "Wortbank: [uns, euch, sich]. Setze ein: Wir treffen ___ nach dem Unterricht.";
  }, /genuinely reflexive professional context/);
});

test("rejects an interessieren prompt with a transitive reading", () => {
  expectFailure((changed) => {
    questionByNumber(
      draftByTemplate(changed, "v1-a2-reflexive-verbs-r2"),
      5,
    ).prompt =
      "Wortbank: [sich, ihm, ihn]. Setze ein: Er interessiert ___ seit Kurzem für Fotografie.";
  }, /transitive jemanden/);
});

test("rejects an uncontracted teilnehmen answer", () => {
  expectFailure((changed) => {
    const prepositions = draftByTemplate(changed, "v1-a2-prepositions-r2");
    const prepositionQuestion = questionByNumber(prepositions, 2);
    prepositionQuestion.correct_answer = "an dem";
    prepositionQuestion.accepted_answers = ["an dem"];
    prepositionQuestion.options = [
      "an dem",
      "auf den",
      "für einen",
      "über den",
    ];
    prepositionQuestion.explanation =
      "Teilnehmen verbindet sich mit an und dem Dativ; daher heißt es an dem Sprachkurs.";
  }, /natural contracted form/);
});

test("rejects an explanation that calls a non-agent subject acting", () => {
  expectFailure((changed) => {
    questionByNumber(
      draftByTemplate(changed, "v1-a2-nominativ-r1"),
      6,
    ).explanation =
      "Kurs ist das handelnde Subjekt und steht deshalb im Nominativ.";
  }, /non-agent Kurs/);
});

test("rejects a connector prompt that mislabels sentence options", () => {
  expectFailure((changed) => {
    questionByNumber(
      draftByTemplate(changed, "v1-a2-connectors-r1"),
      1,
    ).prompt = "Welcher Konnektor drückt einen Gegensatz korrekt aus?";
  }, /every option is a sentence/);
});

test("rejects a punctuation label instead of a literal colon", () => {
  expectFailure((changed) => {
    const punctuation = draftByTemplate(changed, "v1-a2-punctuation-r1");
    const question = questionByNumber(punctuation, 3);
    question.prompt =
      "Wortbank: [Komma, Punkt, Fragezeichen]. Welches Zeichen fehlt? Ich weiß ___ dass du heute arbeitest.";
    question.correct_answer = "Komma";
    question.accepted_answers = ["Komma"];
  }, /Q3 tests punctuation names instead of literal marks/);
});

test("rejects a punctuation label instead of a literal question mark", () => {
  expectFailure((changed) => {
    const punctuation = draftByTemplate(changed, "v1-a2-punctuation-r1");
    const question = questionByNumber(punctuation, 4);
    question.prompt =
      "Wortbank: [Punkt, Komma, Fragezeichen]. Welches Zeichen fehlt? Wann beginnt die Übergabe ___";
    question.correct_answer = "Fragezeichen";
    question.accepted_answers = ["Fragezeichen"];
  }, /Q4 tests punctuation names instead of literal marks/);
});

test("rejects a punctuation label instead of a literal period", () => {
  expectFailure((changed) => {
    const punctuation = draftByTemplate(changed, "v1-a2-punctuation-r1");
    const question = questionByNumber(punctuation, 5);
    question.prompt =
      "Wortbank: [Komma, Punkt, Fragezeichen]. Welches Zeichen fehlt? Die Übergabe beginnt um sieben Uhr ___";
    question.correct_answer = "Punkt";
    question.accepted_answers = ["Punkt"];
  }, /Q5 tests punctuation names instead of literal marks/);
});

test("rejects an incomplete formal salutation model", () => {
  expectFailure((changed) => {
    const task = draftByTemplate(changed, "v1-a2-task-fulfilment-r1");
    questionByNumber(task, 6).prompt =
      "Welche vollständige Nachricht enthält die Absage, den Grund und die Bitte um das Material?";
  }, /standard complete formal salutation/);
});

test("rejects exact-scored passive prompts with valid alternate tense or state answers", () => {
  expectFailure((changed) => {
    const passive = draftByTemplate(changed, "v1-a2-passive-voice-r1");
    questionByNumber(passive, 3).prompt =
      "Wortbank: [ist, wird, werden]. Ergänze: Die Rechnung ___ heute bezahlt.";
    questionByNumber(passive, 4).prompt =
      "Wortbank: [werden, wird, wurden]. Ergänze: Die Zimmer ___ täglich gelüftet.";
  }, /Q3, Q4, or Q6 permits a valid Zustandspassiv or past-tense answer/);
});

test("rejects an ambiguous A2 passive Q6 state reading", () => {
  expectFailure((changed) => {
    const passive = draftByTemplate(changed, "v1-a2-passive-voice-r1");
    questionByNumber(passive, 6).prompt =
      "Wähle die passende Form: Der Termin ___ gerade per E-Mail bestätigt.";
  }, /Q3, Q4, or Q6 permits a valid Zustandspassiv or past-tense answer/);
});

test("rejects an A2 yes-no question prompt that permits an echo question", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-question-formation-r1");
    questionByNumber(draft, 8).prompt =
      "Welche Frage kann man in diesem Gespräch stellen?";
  }, /Q8 does not exclude grammatical echo or marked contrastive question order/);
});

test("rejects an A2 politeness task that does not require Konjunktiv II", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-konjunktiv-r1");
    questionByNumber(draft, 6).prompt =
      "Welche höfliche Frage passt im Gespräch mit Frau Keller?";
  }, /Q6 asks only for politeness although indicative Haben Sie is also polite/);
});

test("rejects a relative-clause transformation that leaves two valid directions", () => {
  expectFailure((changed) => {
    questionByNumber(
      draftByTemplate(changed, "v1-a2-relative-clauses-r1"),
      8,
    ).prompt =
      "Verbinde die Sätze mit einem Relativsatz: Die Apotheke ist geschlossen. Die Apotheke liegt am Bahnhof.";
  }, /Q8 permits two valid relative-clause transformations/);
});

test("rejects an unsigned formal-message model", () => {
  expectFailure((changed) => {
    const task = draftByTemplate(changed, "v1-a2-task-fulfilment-r1");
    const q8 = questionByNumber(task, 8);
    q8.prompt =
      "Welche Nachricht enthält die Zusage für Mittwoch, die Ankunft um 14 Uhr und die Raumfrage?";
  }, /complete signed formal message/);
});

test("rejects a vague coherence reference", () => {
  expectFailure((changed) => {
    questionByNumber(draftByTemplate(changed, "v1-a2-coherence-r1"), 4).prompt =
      "Wortbank: [Sie, Er, Es]. Ergänze den eindeutigen Bezug: Die Lehrerin erklärt die Aufgabe. ___ gibt auch ein Beispiel.";
  }, /Q4 claims an unequivocal reference/);
});

test("rejects incomplete spelling guidance", () => {
  expectFailure((changed) => {
    const spelling = draftByTemplate(changed, "v1-a2-spelling-r1");
    spelling.mini_lesson.key_rule =
      "Präge dir häufige Wortbilder ein; nach langem Vokal steht häufig ß.";
  }, /mini-lesson gives an incomplete s\/ss\/ß rule/);
});

test("rejects a spelling task that supplies every spelling", () => {
  expectFailure((changed) => {
    const spelling = draftByTemplate(changed, "v1-a2-spelling-r1");
    questionByNumber(spelling, 7).prompt =
      "Ordne alle korrekt geschriebenen Teile zu einem Satz: [Meine Kollegin / kommt / vielleicht / am Mittwoch / wieder].";
  }, /Q7 supplies every spelling/);
});

test("rejects complete A2 r1 mini-lesson reuse in a second revision", () => {
  expectFailure((changed) => {
    const first = draftByTemplate(changed, "v1-a2-dativ-r1");
    const second = draftByTemplate(changed, "v1-a2-dativ-r2");
    second.mini_lesson = structuredClone(first.mini_lesson);
  }, /A2:dativ r2 reuses the complete r1 mini-lesson/);
});

test("rejects first-position answer collapse", () => {
  expectFailure((changed) => {
    const draft = draftByTemplate(changed, "v1-a2-articles-r1");
    for (const question of draft.questions) {
      if (question.question_type !== "multiple_choice") continue;
      const options = question.options as string[];
      const correct = question.correct_answer as string;
      question.options = [
        correct,
        ...options.filter((option) => option !== correct),
      ];
    }
  }, /non-deterministic or collapsed answer positions/);
});
