export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type GlobalRole = "platform_admin" | "teacher" | "student";
export type WorkspaceRole = "owner" | "teacher" | "student";
export type Level = "A1" | "A2" | "B1" | "B2";
export type SubmissionMode = "predefined_question" | "free_text";
export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "checking"
  | "checked"
  | "needs_review"
  | "failed";
export type CorrectionStatus =
  | "correct"
  | "acceptable_for_level"
  | "acceptable_a1_a2"
  | "minor_issue"
  | "major_issue"
  | "unclear";
export type TopicSeverity = "minor" | "major" | "mixed";
export type WeaknessLevel =
  | "tracking"
  | "weak"
  | "unlocked"
  | "improving"
  | "mastered";
export type PracticeDifficulty = "easy" | "medium" | "hard";
export type PracticeVisibility = "workspace" | "private";

export interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  global_role: GlobalRole;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
}

export interface Batch {
  id: string;
  workspace_id: string;
  name: string;
  level: Level;
  description: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BatchStudent {
  id: string;
  workspace_id: string;
  batch_id: string;
  student_id: string;
  created_at: string;
}

export interface Question {
  id: string;
  workspace_id: string;
  title: string;
  prompt: string;
  level: Level;
  topic: string;
  task_type: string;
  expected_word_min: number | null;
  expected_word_max: number | null;
  estimated_minutes: number | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GrammarTopic {
  id: string;
  slug: string;
  name: string;
  level: Level | "A1_A2";
  description: string | null;
  created_at: string;
}

export interface Submission {
  id: string;
  workspace_id: string;
  student_id: string;
  batch_id: string | null;
  question_id: string | null;
  mode: SubmissionMode;
  original_text: string;
  corrected_text: string | null;
  overall_summary: string | null;
  level_detected: Level | null;
  status: SubmissionStatus;
  ai_model: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubmissionLine {
  id: string;
  submission_id: string;
  line_number: number;
  original_line: string;
  corrected_line: string;
  status: CorrectionStatus;
  changed_parts: Json;
  short_explanation: string | null;
  detailed_explanation: string | null;
  grammar_topic_id: string | null;
  created_at: string;
}

export interface SubmissionGrammarTopic {
  id: string;
  submission_id: string;
  grammar_topic_id: string;
  count: number;
  severity: TopicSeverity;
  simple_explanation: string | null;
  created_at: string;
}

export interface StudentGrammarStat {
  id: string;
  workspace_id: string;
  student_id: string;
  grammar_topic_id: string;
  total_minor_issues: number;
  total_major_issues: number;
  total_correct_after_practice: number;
  weakness_level: WeaknessLevel;
  practice_unlocked: boolean;
  last_seen_at: string | null;
  updated_at: string;
}

export interface PracticeTest {
  id: string;
  workspace_id: string;
  grammar_topic_id: string;
  level: Level;
  difficulty: PracticeDifficulty;
  title: string;
  description: string | null;
  created_by_ai: boolean;
  teacher_reviewed: boolean;
  visibility: PracticeVisibility;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PracticeTestQuestion {
  id: string;
  practice_test_id: string;
  question_number: number;
  question_type: string;
  prompt: string;
  options: Json | null;
  correct_answer: string;
  explanation: string | null;
  created_at: string;
}

export interface PracticeTestAttempt {
  id: string;
  practice_test_id: string;
  student_id: string;
  workspace_id: string;
  answers: Json;
  score: number;
  max_score: number;
  feedback: Json | null;
  completed_at: string | null;
  created_at: string;
}

export interface TeacherNote {
  id: string;
  submission_id: string;
  teacher_id: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface UsageEvent {
  id: string;
  workspace_id: string;
  user_id: string;
  event_type: string;
  metadata: Json;
  created_at: string;
}
