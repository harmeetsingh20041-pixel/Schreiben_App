export type Status = "correct" | "acceptable_a1_a2" | "minor_issue" | "major_issue" | "unclear";

export interface ChangedPart {
  from: string;
  to: string;
  reason: string;
}

export interface CorrectionLine {
  line_number: number;
  original_line: string;
  corrected_line: string;
  status: Status;
  changed_parts: ChangedPart[];
  short_explanation: string;
  grammar_topic: string;
}

export interface AIResponse {
  submission_id: string;
  overall_summary: string;
  level_detected: "A1" | "A2";
  lines: CorrectionLine[];
}

export interface Question {
  id: string;
  title: string;
  level: "A1" | "A2";
  topic: string;
  prompt: string;
  expected_word_range: string;
  estimated_time: string;
  active: boolean;
}

export interface Student {
  id: string;
  name: string;
  email: string;
  batchId: string;
  total_submissions: number;
  last_active: string;
  weak_topics: string[];
}

export interface Batch {
  id: string;
  name: string;
  student_count: number;
  submission_count: number;
  avg_correction_count: number;
}

export interface Submission {
  id: string;
  studentId: string;
  questionId: string | null;
  date: string;
  status: "Reviewed" | "Pending" | "Not reviewed";
  main_grammar_issues: string[];
  number_of_corrections: number;
  original_answer: string;
  ai_response: AIResponse;
  teacher_note?: string;
}

export interface GrammarTopicInfo {
  topic: string;
  explanation: string;
}

export interface PracticeExercise {
  id: string;
  topic: string;
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
}
