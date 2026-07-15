export const WRITING_LIVE_TOPIC_SLUGS = [
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

export type WritingLiveLevel = "A1" | "A2" | "B1" | "B2";

export type WritingLiveCorrectionGroup = Readonly<{
  id: string;
  anyOf: readonly string[];
}>;

export type WritingLiveReliabilityCase = Readonly<{
  id: string;
  level: WritingLiveLevel;
  mistakeProfile: "correct" | "light" | "medium" | "heavy";
  text: string;
  expectedIssueRange: readonly [number, number];
  expectedTopics: readonly (typeof WRITING_LIVE_TOPIC_SLUGS)[number][];
  minimumExpectedTopicHits?: number;
  requiredCorrectionGroups?: readonly WritingLiveCorrectionGroup[];
  forbiddenUncorrectedSubstrings?: readonly string[];
}>;

/**
 * Fixed, fictional A1-B2 corpus for the paid live-writing reliability check.
 * The runner accepts only an array index; arbitrary writing is never accepted
 * through environment variables or retained in Playwright artifacts.
 */
export const WRITING_LIVE_RELIABILITY_CORPUS = [
  {
    id: "a1-correct-routine",
    level: "A1",
    mistakeProfile: "correct",
    text: "Ich heiße Mira und wohne seit sechs Monaten in Köln. Von Montag bis Freitag arbeite ich in einem kleinen Café. Morgens fahre ich mit dem Bus zur Arbeit. Am Nachmittag lerne ich Deutsch, und abends koche ich oft mit meiner Freundin. Am Wochenende besuche ich gern den Markt am Rhein. Dort kaufe ich Obst, Brot und manchmal frische Blumen.",
    expectedIssueRange: [0, 0],
    expectedTopics: [],
  },
  {
    id: "a1-cases-agreement",
    level: "A1",
    mistakeProfile: "medium",
    text: "Seit zwei Woche wohne ich in eine kleine Wohnung in Bonn. Die Küche sind hell, und mein Bruder besucht mich oft. Am Sonntag wir kochen zusammen indische Essen. Danach trinken wir ein Tee und hören Musik. Meine Nachbarin kommt manchmal auch, weil sie unser Essen sehr gern mag. Später räumen wir die Küche auf und sprechen über unsere Arbeit.",
    expectedIssueRange: [5, 9],
    expectedTopics: [
      "plural-forms",
      "dativ",
      "articles",
      "adjective-endings",
      "subject-verb-agreement",
      "verb-position",
      "akkusativ",
    ],
  },
  {
    id: "a1-word-order-separable",
    level: "A1",
    mistakeProfile: "heavy",
    text: "Morgens ich stehe um sieben Uhr aufstehen. Danach muss ich mein Uniform anziehen und schnell frühstücken. Ich fahre mit Bus zur Klinik, weil meine Arbeit beginnt um acht Uhr. Kann du mir sagen, wann der nächste Bus fährt? Am Abend ich rufe an meine Mutter und erzähle ihr von meinem Tag. Danach sehe ich noch kurz fern und gehe schlafen.",
    expectedIssueRange: [6, 11],
    expectedTopics: [
      "verb-position",
      "separable-verbs",
      "conjugation",
      "articles",
      "dativ",
      "subordinate-clauses",
      "subject-verb-agreement",
    ],
  },
  {
    id: "a1-perfekt-time",
    level: "A1",
    mistakeProfile: "medium",
    text: "Gestern habe ich zu Supermarkt gegangen. Ich habe Äpfel, Milch und ein Brot gekaufen. An der Kasse habe ich meine Geld vergessen, deshalb bin ich schnell nach Hause gelauft. Später kam ich zurück. Der Verkäufer war freundlich und gibt mir meine Einkaufstasche. Um 18.30 Uhr war ich wieder zu Hause. Dann habe ich Nudeln gekocht und mit meinem Mitbewohner gegessen.",
    expectedIssueRange: [5, 9],
    expectedTopics: [
      "perfekt",
      "prepositions",
      "articles",
      "conjugation",
      "praeteritum",
    ],
  },
  {
    id: "a1-spacing-capitalization",
    level: "A1",
    mistakeProfile: "heavy",
    text: "liebe Anna,wie geht es dir?ich habe nächste Woche Geburstag und möchte dich einladen.Die Party ist am samstag bei mir zu Hause,sie beginnt um 19.00 uhr. Kannst du bitte Getränke mitbringen ich brauche noch wasser und Saft. Meine Schwester macht einen Kuchen und wir hören musik. Bitte sag mir bis donnerstag Bescheid.Viele grüße von deiner Freundin Nila",
    expectedIssueRange: [10, 20],
    expectedTopics: ["capitalization", "punctuation", "spelling"],
  },
  {
    id: "a2-correct-learning",
    level: "A2",
    mistakeProfile: "correct",
    text: "Seit einem Jahr besuche ich zweimal pro Woche einen Deutschkurs. Obwohl ich nach der Arbeit oft müde bin, gehe ich gern dorthin. Unsere Lehrerin erklärt die Grammatik mit vielen Beispielen, z. B. aus kurzen Gesprächen im Alltag. Zu Hause wiederhole ich neue Wörter und schreibe kleine Nachrichten. Am Wochenende sehe ich manchmal einen deutschen Film mit Untertiteln. So verstehe ich jede Woche ein bisschen mehr.",
    expectedIssueRange: [0, 0],
    expectedTopics: [],
  },
  {
    id: "a2-perfekt-auxiliaries",
    level: "A2",
    mistakeProfile: "light",
    text: "Letztes Wochenende bin ich meine Tante besucht. Sie ist gerade umgezogen und hat noch viele Kisten. Am Samstag haben wir früh anfangen und zuerst die Küche eingerichtet. Ich habe die Lampen aufgehängt, und meine Cousine hat ein Regal gebaut. Danach sind wir Pizza bestellt. Am Sonntag war ich müde, aber ich habe trotzdem mit dem Auto nach Hause gefahren. Vorher habe ich noch den Müll hinausgebracht.",
    expectedIssueRange: [4, 7],
    expectedTopics: ["perfekt", "conjugation"],
  },
  {
    id: "a2-subordinate-connectors",
    level: "A2",
    mistakeProfile: "medium",
    text: "Ich lerne Deutsch weil ich später in Deutschland arbeiten möchte. Wenn ich nach Deutschland komme, ich möchte zuerst einen Intensivkurs besuchen. Meine Lehrerin sagt, dass ich soll jeden Tag laut sprechen. Obwohl die Grammatik manchmal schwierig ist, aber ich übe weiter. Ich hoffe das ich bald sicherer werde, weil ich will in einem Krankenhaus arbeiten. Außerdem höre ich Podcasts, damit ich neue Wörter schneller lernen kann.",
    expectedIssueRange: [5, 9],
    expectedTopics: [
      "punctuation",
      "verb-position",
      "subordinate-clauses",
      "conjunctions",
      "connectors",
    ],
  },
  {
    id: "a2-reflexive-prepositions",
    level: "A2",
    mistakeProfile: "light",
    text: "Ich interessiere mich für deutsche Filme und gehe oft ins Kino. Jeden Freitag treffe ich mit meinen Freunden vor dem Bahnhof. Wir erinnern uns gern über unseren ersten gemeinsamen Filmabend. Letzte Woche habe ich mich über einen neuen Filmkurs angemeldet. Der Kurs beginnt am Montag, deshalb freue ich mich schon darauf. Ich muss mich noch um die genaue Uhrzeit informieren. Danach können wir uns im Café treffen.",
    expectedIssueRange: [3, 6],
    expectedTopics: ["reflexive-verbs", "prepositions"],
  },
  {
    id: "a2-endings-code-switch",
    level: "A2",
    mistakeProfile: "medium",
    text: "Im neuen Sprachkurs sind zwölf internationale Teilnehmer. Unsere freundlich Lehrerin sagt manchmal „Please work in pairs“ und gibt uns jeden Tag interessante Aufgaben. Zwei polnische Student fragen oft „What does this word mean?“, aber sie versuchen danach auf Deutsch weiterzusprechen. Die Übungen im Buch ist manchmal lang. Wir arbeiten deshalb oft in kleine Gruppen. Am Ende der Woche schreiben alle Teilnehmer einen kurzen Text. Diese Texte hilft uns, unsere häufigsten Fehler zu erkennen.",
    expectedIssueRange: [5, 12],
    expectedTopics: [
      "adjective-endings",
      "plural-forms",
      "subject-verb-agreement",
      "dativ",
    ],
  },
  {
    id: "b1-correct-workplace",
    level: "B1",
    mistakeProfile: "correct",
    text: "Vor drei Monaten habe ich begonnen, in einer Seniorenresidenz zu arbeiten. Anfangs war ich unsicher, weil viele Abläufe neu für mich waren. Meine Kolleginnen erklärten mir jedoch geduldig, wie die Dokumentation funktioniert. Inzwischen übernehme ich mehrere Aufgaben selbstständig. Besonders wichtig finde ich die Gespräche mit den Bewohnerinnen und Bewohnern. Wenn jemand Sorgen hat, nehme ich mir Zeit und höre aufmerksam zu. Dadurch lerne ich jeden Tag etwas Neues.",
    expectedIssueRange: [0, 0],
    expectedTopics: [],
  },
  {
    id: "b1-repeated-verbs-word-order",
    level: "B1",
    mistakeProfile: "medium",
    text: "Viele Menschen arbeiten inzwischen regelmäßig von zu Hause. Obwohl Homeoffice spart Zeit, fühlen fühlen sich einige Beschäftigte allein. Außerdem man kann private und berufliche Aufgaben schwer trennen trennen. Wenn die Kommunikation nicht klar ist, Missverständnisse entstehen entstehen schnell. Einerseits bietet die Arbeit zu Hause mehr Ruhe, andererseits fehlt manchen der direkte Austausch. Deshalb Unternehmen sollten feste Besprechungen planen, damit ihre Mitarbeiter bleiben motiviert bleiben und wichtige Informationen rechtzeitig erhalten.",
    expectedIssueRange: [8, 14],
    expectedTopics: [
      "subordinate-clauses",
      "verb-position",
      "word-order",
      "connectors",
    ],
  },
  {
    id: "b1-relative-pronouns",
    level: "B1",
    mistakeProfile: "medium",
    text: "Die Kollegin, die ich gestern geholfen habe, hat mir ein Fachbuch gegeben, den sie sehr nützlich findet. Der Autor, dessen Artikel ich schon kenne, beschreibt Methoden, mit die man schwierige Gespräche führen kann. Besonders hilfreich fand ich das Kapitel, in der Konflikte im Team erklärt werden. Es richtet sich an Menschen, deren Muttersprache nicht Deutsch sind. Ich werde das Buch meinem Freund leihen, welcher nächste Woche eine neue Stelle beginnt.",
    expectedIssueRange: [5, 8],
    expectedTopics: [
      "relative-clauses",
      "dativ",
      "akkusativ",
      "prepositions",
      "subject-verb-agreement",
    ],
  },
  {
    id: "b1-narrative-tenses",
    level: "B1",
    mistakeProfile: "light",
    text: "Als ich am Bahnhof angekommen war, fuhr der Zug schon ab. Ich hatte die Abfahrtszeit falsch gelesen, obwohl ich sie am Vorabend kontrollierte. Deshalb musste ich ein neues Ticket kaufen. Während ich wartete, habe ich meine Schwester angerufen und erklärte ihr die Situation. Sie sagte, sie kommt mit dem Auto. Nachdem sie am Bahnhof angekommen ist, gingen wir gemeinsam frühstücken. Später konnte ich einen anderen Zug nehmen und erreichte mein Ziel.",
    expectedIssueRange: [3, 6],
    expectedTopics: ["praeteritum", "plusquamperfekt", "perfekt", "coherence"],
  },
  {
    id: "b1-passive-infinitive",
    level: "B1",
    mistakeProfile: "medium",
    text: "In unserem Wohnhaus werden nächste Woche alle Fenster austauschen. Die Verwaltung hat angekündigt, moderne Fenster zu einbauen. Um die Arbeiten schneller beenden, müssen wir die Fensterbänke vorher leeren. Die Bewohner wurden außerdem gebeten, zerbrechliche Gegenstände frei zu halten. Möbel sollen mit Folie geschützt werden. Ich hoffe, dass die Firma alles schafft pünktlich zu erledigen, damit wir die Räume am Abend wieder normal benutzen können.",
    expectedIssueRange: [4, 8],
    expectedTopics: [
      "passive-voice",
      "infinitive-zu",
      "separable-verbs",
      "subordinate-clauses",
      "word-order",
    ],
  },
  {
    id: "b2-correct-argument",
    level: "B2",
    mistakeProfile: "correct",
    text: "Digitale Fortbildungen können den Berufsalltag deutlich erleichtern, sofern sie sinnvoll in die Arbeitszeit integriert werden. Besonders hilfreich sind kurze Module, die konkrete Probleme aus der Praxis aufgreifen. Dennoch ersetzt ein Onlinekurs weder den Austausch im Team noch eine sorgfältige Begleitung durch erfahrene Kolleginnen und Kollegen. Entscheidend ist daher eine ausgewogene Kombination: Theoretische Inhalte lassen sich flexibel online bearbeiten; komplexe Situationen sollten dagegen gemeinsam reflektiert werden. Unter diesen Bedingungen profitieren sowohl die Beschäftigten als auch die Einrichtung langfristig von dem Angebot.",
    expectedIssueRange: [0, 0],
    expectedTopics: [],
  },
  {
    id: "b2-passive-system",
    level: "B2",
    mistakeProfile: "medium",
    text: "Im vergangenen Jahr wurde in unserer Klinik ein neues Dokumentationssystem eingeführt worden. Vor der Einführung mussten alle Mitarbeitenden geschult geworden. Zunächst wurden viele Fehler von der Software verursacht, weil die Einstellungen nicht sorgfältig geprüft wurden. Mittlerweile kann das System zuverlässig benutzt geworden. Die Daten müssen jedoch täglich kontrolliert werden, damit Unstimmigkeiten früh erkannt werden. Falls ein Ausfall auftritt, wird ein Ersatzverfahren aktiviert und die zuständige IT-Abteilung sofort informieren. Es wird erwartet, dass dadurch weniger Berichte verspätet abgeschlossen werden müssen.",
    expectedIssueRange: [4, 7],
    expectedTopics: ["passive-voice", "modal-verbs", "conjugation"],
  },
  {
    id: "b2-konjunktiv-register",
    level: "B2",
    mistakeProfile: "medium",
    text: "Wenn die Stadt mehr Nachtbusse einsetzen würde, hätten viele Beschäftigte weniger Schwierigkeiten, pünktlich nach Hause zu kommen. An Ihrer Stelle hätte ich die Fahrpläne früher veröffentlicht. Der Sprecher behauptete jedoch, die Nachfrage ist zu gering. Es wäre sinnvoll, wenn die Verwaltung die tatsächliche Nutzung prüfen würde. Ohne eine Umfrage könnten die Verantwortlichen keine verlässliche Entscheidung treffen. Ich wünschte, der zuständige Ausschuss nimmt die Anliegen der Schichtarbeitenden ernster. Hätte der Ausschuss früher reagiert, würde die Situation heute weniger angespannt gewesen sein. Ich bitte Sie deshalb, dass den Vorschlag erneut zu prüfen.",
    expectedIssueRange: [4, 7],
    expectedTopics: [
      "konjunktiv",
      "infinitive-zu",
      "sentence-structure",
      "register",
    ],
  },
  {
    id: "b2-relative-genitive",
    level: "B2",
    mistakeProfile: "heavy",
    text: "Die Pflegeeinrichtung, dessen neues Weiterbildungskonzept gestern vorgestellt wurde, arbeitet mit mehreren regionalen Partner zusammen. Ein Teil des Programms richtet sich an Mitarbeitende, deren beruflichen Abschlüsse im Ausland erworben wurden. Die Kurse, für denen sich besonders viele Beschäftigte interessieren, verbinden Fachsprache mit praktischen Übungen. Besonders erfolgreich ist das Modul, dessen praktischen Aufgaben reale Gespräche simulieren. Die Rückmeldungen jener Teilnehmenden, die das gesamte Programm abgeschlossen haben, sind überwiegend positiv. Aufgrund die steigende Nachfrage soll das Angebot erweitert werden.",
    expectedIssueRange: [6, 9],
    expectedTopics: [
      "relative-clauses",
      "genitiv",
      "dativ",
      "adjective-endings",
      "prepositions",
    ],
  },
  {
    id: "b2-punctuation-structure",
    level: "B2",
    mistakeProfile: "medium",
    text: "Die Digitalisierung verändert den Pflegealltag dennoch sie löst nicht automatisch jedes Problem. Zum einen ermöglicht sie einen schnelleren Informationsaustausch, zum anderen entstehen neue Abhängigkeiten von stabilen Netzwerken. Entscheidend ist nicht nur welche Technik eingesetzt wird sondern auch, wie gut die Beschäftigten vorbereitet sind. Werden sie zu spät beteiligt können selbst nützliche Systeme auf Widerstand stoßen. Im Bezug auf den Datenschutz braucht jede Einrichtung klare Regeln. Verantwortlich für die Umsetzung sind sowohl die Leitung als auch jedes einzelne Teams. Entscheidungen sollten deshalb transparent dokumentiert und regelmäßig überprüft werden.",
    expectedIssueRange: [5, 9],
    expectedTopics: [
      "punctuation",
      "prepositions",
      "sentence-structure",
      "nominativ",
      "adjective-endings",
    ],
  },
] as const satisfies readonly WritingLiveReliabilityCase[];

/**
 * A fixed regression outside the 20-case sampling corpus. Its source-owned
 * correction contract proves the exact teacher-reported A1 letter without
 * accepting arbitrary student text through environment variables.
 */
export const WRITING_LIVE_REGRESSION_CASES = {
  "a1-user-letter-regression": {
    id: "a1-user-letter-regression",
    level: "A1",
    mistakeProfile: "heavy",
    text: `Hallo Anna,

ich hoffe du geht gut. Es tut mir leid aber ich kann nicht kommen am Wochenende. Meine Mutter ist bisschen krank und ich muss bleiben zu Hause. Ich wollte dich sehen aber leider geht es nicht. Vielleicht wir treffen nächste Mittwoch oder Freitag? Ich habe dann mehr Zeit und wir können zusammen Kaffee trinken oder spazieren gehen im Park. Bitte sag mir welche Tag ist gut für dich. Ich freue mich sehr dich wieder sehen. Schreib mir bitte bald. Viele Grüße und pass auf dich. Bis bald.

Liebe Grüße
Kashish`,
    expectedIssueRange: [9, 24],
    expectedTopics: [
      "conjugation",
      "subject-verb-agreement",
      "punctuation",
      "word-order",
      "articles",
      "adjective-endings",
      "reflexive-verbs",
      "separable-verbs",
      "subordinate-clauses",
    ],
    minimumExpectedTopicHits: 3,
    requiredCorrectionGroups: [
      {
        id: "idiomatic-greeting",
        anyOf: [
          "ich hoffe, dir geht es gut",
          "ich hoffe, es geht dir gut",
          "ich hoffe, dass es dir gut geht",
        ],
      },
      { id: "leid-comma", anyOf: ["Es tut mir leid, aber"] },
      {
        id: "weekend-word-order",
        anyOf: [
          "am Wochenende nicht kommen",
          "am Wochenende leider nicht kommen",
        ],
      },
      { id: "bisschen-article", anyOf: ["ein bisschen krank"] },
      { id: "bleiben-word-order", anyOf: ["zu Hause bleiben"] },
      {
        id: "sehen-comma",
        anyOf: ["dich sehen, aber", "dich zwar sehen, aber"],
      },
      {
        id: "treffen-word-order",
        anyOf: ["Vielleicht treffen wir uns", "Vielleicht können wir uns"],
      },
      { id: "mittwoch-ending", anyOf: ["nächsten Mittwoch"] },
      {
        id: "indirect-question-comma",
        anyOf: ["Bitte sag mir, welcher Tag", "Bitte sag mir, welcher Termin"],
      },
      {
        id: "indirect-question-order",
        anyOf: [
          "welcher Tag gut für dich ist",
          "welcher Tag für dich gut ist",
          "welcher Tag dir passt",
          "welcher Termin dir passt",
        ],
      },
      {
        id: "freue-comma",
        anyOf: [
          "Ich freue mich sehr, dich",
          "Ich freue mich sehr darauf, dich",
          "Ich würde mich sehr freuen, dich",
          "Ich würde mich sehr darauf freuen, dich",
        ],
      },
      { id: "wiederzusehen", anyOf: ["dich wiederzusehen"] },
      {
        id: "aufpassen",
        anyOf: ["pass auf dich auf", "pass gut auf dich auf"],
      },
    ],
    forbiddenUncorrectedSubstrings: [
      "du geht",
      "nicht kommen am Wochenende",
      "ist bisschen krank",
      "muss bleiben zu Hause",
      "sehen aber",
      "Vielleicht wir treffen",
      "nächste Mittwoch",
      "mir welche Tag",
      "welche Tag",
      "wieder sehen",
    ],
  },
} as const satisfies Readonly<Record<string, WritingLiveReliabilityCase>>;

export type WritingLiveRegressionId =
  keyof typeof WRITING_LIVE_REGRESSION_CASES;

export function writingLiveReliabilityCase(
  rawIndex: string | undefined,
  rawRegressionId?: string,
) {
  const regressionId = rawRegressionId?.trim() ?? "";
  if (regressionId) {
    if (rawIndex?.trim()) {
      throw new Error(
        "E2E_LIVE_WRITING_CASE_INDEX and E2E_LIVE_WRITING_REGRESSION_ID are mutually exclusive.",
      );
    }
    if (!(regressionId in WRITING_LIVE_REGRESSION_CASES)) {
      throw new Error(
        "E2E_LIVE_WRITING_REGRESSION_ID must name a source-owned live-writing regression.",
      );
    }
    return WRITING_LIVE_REGRESSION_CASES[
      regressionId as WritingLiveRegressionId
    ];
  }
  const value = rawIndex?.trim() ?? "0";
  if (!/^(?:[0-9]|1[0-9])$/.test(value)) {
    throw new Error(
      "E2E_LIVE_WRITING_CASE_INDEX must be an integer from 0 through 19.",
    );
  }
  const selected = WRITING_LIVE_RELIABILITY_CORPUS[Number(value)];
  if (!selected) {
    throw new Error("The requested live-writing reliability case is missing.");
  }
  return selected;
}
