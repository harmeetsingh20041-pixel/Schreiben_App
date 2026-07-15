export interface Question {
  id: string;
  title: string;
  level: "A1" | "A2" | "B1" | "B2";
  topic: string;
  prompt: string;
  expected_word_range: string;
  estimated_time: string;
  active: boolean;
  source?: "workspace" | "global";
  workspace_id?: string | null;
  batch_id?: string | null;
}
