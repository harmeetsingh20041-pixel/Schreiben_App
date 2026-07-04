import { AIResponse, Question, Student, Batch, Submission, PracticeExercise } from "../types";

export const MOCK_QUESTIONS: Question[] = [
  {
    id: "q1",
    title: "Einladung zur Geburtstagsparty",
    level: "A1",
    topic: "Einladung",
    prompt: "Schreiben Sie eine kurze E-Mail an Ihren Freund. Laden Sie ihn zu Ihrer Geburtstagsparty ein.",
    expected_word_range: "30-50",
    estimated_time: "10 mins",
    active: true,
  },
  {
    id: "q2",
    title: "Mein Lieblingshobby",
    level: "A2",
    topic: "Hobby",
    prompt: "Schreiben Sie über Ihr Lieblingshobby.",
    expected_word_range: "50-80",
    estimated_time: "15 mins",
    active: true,
  },
  {
    id: "q3",
    title: "Meine Familie",
    level: "A1",
    topic: "Familie",
    prompt: "Beschreiben Sie Ihre Familie.",
    expected_word_range: "30-50",
    estimated_time: "10 mins",
    active: true,
  },
  {
    id: "q4",
    title: "Entschuldigung an die Lehrerin",
    level: "A2",
    topic: "Entschuldigung",
    prompt: "Schreiben Sie eine Entschuldigung an Ihre Lehrerin, weil Sie nicht zum Kurs kommen können.",
    expected_word_range: "40-60",
    estimated_time: "10 mins",
    active: true,
  },
  {
    id: "q5",
    title: "Mein letzter Urlaub",
    level: "A2",
    topic: "Reise",
    prompt: "Schreiben Sie über Ihren letzten Urlaub.",
    expected_word_range: "60-100",
    estimated_time: "20 mins",
    active: true,
  },
  {
    id: "q6",
    title: "Nach der Telefonnummer fragen",
    level: "A1",
    topic: "Alltag",
    prompt: "Schreiben Sie eine Nachricht an Ihren Freund und fragen Sie nach seiner Telefonnummer.",
    expected_word_range: "20-40",
    estimated_time: "5 mins",
    active: true,
  },
  {
    id: "q7",
    title: "Mein Alltag",
    level: "A1",
    topic: "Alltag",
    prompt: "Schreiben Sie über Ihren Alltag.",
    expected_word_range: "40-60",
    estimated_time: "15 mins",
    active: true,
  },
  {
    id: "q8",
    title: "Ist Sport wichtig?",
    level: "A2",
    topic: "Meinung schreiben",
    prompt: "Schreiben Sie eine kurze Meinung: Ist Sport wichtig?",
    expected_word_range: "50-80",
    estimated_time: "15 mins",
    active: true,
  },
  {
    id: "q9",
    title: "Meinung zu Online-Unterricht",
    level: "B1",
    topic: "Argumentation",
    prompt: "Schreiben Sie Ihre Meinung zu Online-Unterricht. Nennen Sie Vorteile, Nachteile und ein Beispiel.",
    expected_word_range: "100-140",
    estimated_time: "25 mins",
    active: true,
  },
  {
    id: "q10",
    title: "Formelle Beschwerde",
    level: "B2",
    topic: "Formeller Brief",
    prompt: "Schreiben Sie eine formelle Beschwerde über einen schlechten Service. Achten Sie auf Struktur und höflichen Ton.",
    expected_word_range: "140-180",
    estimated_time: "35 mins",
    active: true,
  }
];

export const MOCK_BATCHES: Batch[] = [
  { id: "b1", name: "A2 Morning Batch", level: "A2", student_count: 12, submission_count: 45, avg_correction_count: 3 },
  { id: "b2", name: "B1 Evening Batch", level: "B1", student_count: 15, submission_count: 38, avg_correction_count: 4 },
  { id: "b3", name: "A1 Beginner Batch", level: "A1", student_count: 10, submission_count: 22, avg_correction_count: 2 },
  { id: "b4", name: "B2 Writing Lab", level: "B2", student_count: 6, submission_count: 14, avg_correction_count: 5 },
];

export const MOCK_STUDENTS: Student[] = [
  { id: "s1", name: "Rahul Sharma", email: "rahul@example.com", batchId: "b1", total_submissions: 12, last_active: "2 days ago", weak_topics: ["Dativ/Akkusativ", "Verb position"] },
  { id: "s2", name: "Ananya Verma", email: "ananya@example.com", batchId: "b1", total_submissions: 15, last_active: "1 day ago", weak_topics: ["Perfekt", "Articles"] },
  { id: "s3", name: "Priya Singh", email: "priya@example.com", batchId: "b2", total_submissions: 8, last_active: "5 days ago", weak_topics: ["Prepositions"] },
  { id: "s4", name: "Aman Gupta", email: "aman@example.com", batchId: "b3", total_submissions: 5, last_active: "Today", weak_topics: ["Articles", "Verb position"] },
  { id: "s5", name: "Saloni Mehta", email: "saloni@example.com", batchId: "b3", total_submissions: 7, last_active: "3 days ago", weak_topics: ["Dativ/Akkusativ"] },
];

export const MOCK_AI_RESPONSE: AIResponse = {
  submission_id: "sub-mock-1",
  overall_summary: "You did a good job expressing your thoughts! Just pay a little attention to Dativ and verb positions. Keep it up!",
  level_detected: "A1",
  lines: [
    {
      line_number: 1,
      original_line: "Ich habe meinen Mutter ein Geschenk gegeben.",
      corrected_line: "Ich habe meiner Mutter ein Geschenk gegeben.",
      status: "minor_issue",
      changed_parts: [{ from: "meinen", to: "meiner", reason: "After 'geben', the person receiving something is usually in Dativ." }],
      short_explanation: "After 'geben', the person receiving something is usually in Dativ. 'Die Mutter' becomes 'meiner Mutter'.",
      grammar_topic: "Dativ"
    },
    {
      line_number: 2,
      original_line: "Ich spiele gern Badminton im Park.",
      corrected_line: "Ich spiele gern Badminton im Park.",
      status: "correct",
      changed_parts: [],
      short_explanation: "Correct. No correction needed.",
      grammar_topic: "Word order"
    },
    {
      line_number: 3,
      original_line: "Gestern ich bin ins Kino gegangen.",
      corrected_line: "Gestern bin ich ins Kino gegangen.",
      status: "minor_issue",
      changed_parts: [{ from: "ich bin", to: "bin ich", reason: "When the sentence starts with 'Gestern', the verb comes in position 2." }],
      short_explanation: "When the sentence starts with 'Gestern', the verb comes in position 2.",
      grammar_topic: "Verb position"
    },
    {
      line_number: 4,
      original_line: "Ich habe gehen Schule.",
      corrected_line: "Ich bin zur Schule gegangen.",
      status: "major_issue",
      changed_parts: [{ from: "habe gehen Schule", to: "bin zur Schule gegangen", reason: "The original sentence is not grammatically clear." }],
      short_explanation: "The original sentence is not grammatically clear. For movement in the past, use 'bin ... gegangen'.",
      grammar_topic: "Perfekt"
    }
  ]
};

export const GRAMMAR_TOPIC_INFO: Record<string, string> = {
  "Dativ": "The Dativ case is used for the indirect object (the receiver of an action). Certain prepositions (aus, bei, mit, nach, seit, von, zu) always require Dativ.",
  "Akkusativ": "The Akkusativ case is used for the direct object (the thing being acted upon). Certain prepositions (durch, für, gegen, ohne, um) always require Akkusativ.",
  "Dativ/Akkusativ": "Distinguishing between Dativ and Akkusativ is essential. Use Dativ for 'where?' (location) and Akkusativ for 'where to?' (movement) with two-way prepositions.",
  "Verb position": "In main clauses, the conjugated verb is always in position 2. In subordinate clauses (starting with weil, dass, wenn), the verb goes to the very end.",
  "Perfekt": "The Perfekt tense is formed with 'haben' or 'sein' + the past participle. Use 'sein' for verbs of movement or change of state, and 'haben' for most other verbs.",
  "Word order": "Standard word order follows Time - Manner - Place (TeKaMoLo). Time expressions usually come right after the verb in position 2.",
  "Articles": "Nouns in German have genders (der, die, das) which change based on their role in the sentence (Nominativ, Akkusativ, Dativ).",
  "Prepositions": "Prepositions connect words and determine the case of the noun that follows them."
};

export const PRACTICE_EXERCISES: PracticeExercise[] = [
  {
    id: "pe1",
    topic: "Dativ/Akkusativ",
    question: "Ich gebe ____ Mutter das Buch.",
    options: ["meine", "meiner", "meinen"],
    correctAnswer: "meiner",
    explanation: "The verb 'geben' requires a Dativ indirect object. 'Die Mutter' (feminine) becomes 'der Mutter' in Dativ, so it is 'meiner Mutter'."
  },
  {
    id: "pe2",
    topic: "Dativ/Akkusativ",
    question: "Wir gehen durch ____ Park.",
    options: ["der", "den", "dem"],
    correctAnswer: "den",
    explanation: "The preposition 'durch' always takes the Akkusativ. 'Der Park' (masculine) becomes 'den Park'."
  },
  {
    id: "pe3",
    topic: "Dativ/Akkusativ",
    question: "Das Bild hängt an ____ Wand.",
    options: ["die", "der", "den"],
    correctAnswer: "der",
    explanation: "'an' is a two-way preposition. Because the picture is already hanging there (location, 'wo?'), it takes the Dativ: 'der Wand'."
  },
  {
    id: "pe4",
    topic: "Verb position",
    question: "Gestern ____ ich ins Kino gegangen.",
    options: ["ich bin", "bin ich", "bin"],
    correctAnswer: "bin ich",
    explanation: "Since 'Gestern' takes position 1, the verb 'bin' must be in position 2, followed by the subject 'ich'."
  },
  {
    id: "pe5",
    topic: "Verb position",
    question: "Ich bleibe zu Hause, weil ich krank ____.",
    options: ["bin", "ich bin", "bin ich"],
    correctAnswer: "bin",
    explanation: "'weil' introduces a subordinate clause, pushing the conjugated verb 'bin' to the very end of the sentence."
  },
  {
    id: "pe6",
    topic: "Verb position",
    question: "Am Wochenende ____ wir oft Fußball.",
    options: ["wir spielen", "spielen wir", "spielen"],
    correctAnswer: "spielen wir",
    explanation: "Time element 'Am Wochenende' is in position 1, so the verb 'spielen' takes position 2, followed by 'wir'."
  },
  {
    id: "pe7",
    topic: "Perfekt",
    question: "Wir ____ gestern Pizza gegessen.",
    options: ["sind", "haben", "hatten"],
    correctAnswer: "haben",
    explanation: "'essen' does not indicate a movement from A to B or a change of state, so it forms the Perfekt with 'haben'."
  },
  {
    id: "pe8",
    topic: "Perfekt",
    question: "Wann ____ du nach Berlin gefahren?",
    options: ["hast", "bist", "warst"],
    correctAnswer: "bist",
    explanation: "'fahren' is a verb of movement from one place to another, so it forms the Perfekt with 'sein' (here: 'bist')."
  },
  {
    id: "pe9",
    topic: "Perfekt",
    question: "Ich habe das Buch auf den Tisch ____.",
    options: ["gelegen", "gelegt", "legen"],
    correctAnswer: "gelegt",
    explanation: "The past participle of 'legen' (to put/lay) is 'gelegt'."
  }
];

export const MOCK_SUBMISSIONS: Submission[] = [
  {
    id: "sub1",
    studentId: "s1",
    questionId: "q5",
    date: "2023-10-25",
    status: "Reviewed",
    main_grammar_issues: ["Perfekt", "Dativ"],
    number_of_corrections: 2,
    original_answer: "Ich habe meinen Mutter ein Geschenk gegeben.\nIch spiele gern Badminton im Park.\nGestern ich bin ins Kino gegangen.\nIch habe gehen Schule.",
    ai_response: MOCK_AI_RESPONSE,
    teacher_note: "Watch out for the Perfekt tense, Rahul. Let's practice it tomorrow."
  },
  {
    id: "sub2",
    studentId: "s1",
    questionId: "q1",
    date: "2023-10-20",
    status: "Reviewed",
    main_grammar_issues: ["Verb position"],
    number_of_corrections: 1,
    original_answer: "Hallo! Ich lade dich ein zu meiner Party.",
    ai_response: { ...MOCK_AI_RESPONSE, lines: [], overall_summary: "Very good invitation!" }
  }
];
