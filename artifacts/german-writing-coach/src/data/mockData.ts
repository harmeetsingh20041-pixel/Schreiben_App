import { AIResponse, Question, Student, Batch, Submission } from "../types";

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
  }
];

export const MOCK_BATCHES: Batch[] = [
  { id: "b1", name: "A2 Morning Batch", student_count: 12, submission_count: 45, avg_correction_count: 3 },
  { id: "b2", name: "A2 Evening Batch", student_count: 15, submission_count: 38, avg_correction_count: 4 },
  { id: "b3", name: "A1 Beginner Batch", student_count: 10, submission_count: 22, avg_correction_count: 2 },
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
