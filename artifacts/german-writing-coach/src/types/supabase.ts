export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      batch_join_requests: {
        Row: {
          batch_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          requested_at: string
          status: string
          student_email: string
          student_id: string
          student_name: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          batch_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          requested_at?: string
          status?: string
          student_email: string
          student_id: string
          student_name?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          batch_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          requested_at?: string
          status?: string
          student_email?: string
          student_id?: string
          student_name?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "batch_join_requests_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_join_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_join_requests_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_join_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      batch_students: {
        Row: {
          batch_id: string
          created_at: string
          id: string
          student_id: string
          workspace_id: string
        }
        Insert: {
          batch_id: string
          created_at?: string
          id?: string
          student_id: string
          workspace_id: string
        }
        Update: {
          batch_id?: string
          created_at?: string
          id?: string
          student_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "batch_students_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_students_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batch_students_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      batches: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          feedback_delay_max_minutes: number
          feedback_delay_min_minutes: number
          feedback_mode: string
          id: string
          is_active: boolean
          join_code: string
          join_code_enabled: boolean
          join_requires_approval: boolean
          level: string
          name: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          feedback_delay_max_minutes?: number
          feedback_delay_min_minutes?: number
          feedback_mode?: string
          id?: string
          is_active?: boolean
          join_code: string
          join_code_enabled?: boolean
          join_requires_approval?: boolean
          level: string
          name: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          feedback_delay_max_minutes?: number
          feedback_delay_min_minutes?: number
          feedback_mode?: string
          id?: string
          is_active?: boolean
          join_code?: string
          join_code_enabled?: boolean
          join_requires_approval?: boolean
          level?: string
          name?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "batches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batches_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      global_questions: {
        Row: {
          created_at: string
          created_by: string | null
          estimated_minutes: number | null
          expected_word_max: number | null
          expected_word_min: number | null
          id: string
          is_active: boolean
          level: string
          prompt: string
          sort_order: number | null
          source_key: string | null
          source_label: string | null
          task_type: string
          title: string
          topic: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          estimated_minutes?: number | null
          expected_word_max?: number | null
          expected_word_min?: number | null
          id?: string
          is_active?: boolean
          level: string
          prompt: string
          sort_order?: number | null
          source_key?: string | null
          source_label?: string | null
          task_type: string
          title: string
          topic: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          estimated_minutes?: number | null
          expected_word_max?: number | null
          expected_word_min?: number | null
          id?: string
          is_active?: boolean
          level?: string
          prompt?: string
          sort_order?: number | null
          source_key?: string | null
          source_label?: string | null
          task_type?: string
          title?: string
          topic?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "global_questions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      grammar_topics: {
        Row: {
          created_at: string
          description: string | null
          id: string
          level: string
          name: string
          slug: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          level?: string
          name: string
          slug: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          level?: string
          name?: string
          slug?: string
        }
        Relationships: []
      }
      practice_test_attempts: {
        Row: {
          answers: Json
          completed_at: string | null
          created_at: string
          feedback: Json | null
          id: string
          max_score: number
          practice_test_id: string
          score: number
          student_id: string
          workspace_id: string
        }
        Insert: {
          answers?: Json
          completed_at?: string | null
          created_at?: string
          feedback?: Json | null
          id?: string
          max_score?: number
          practice_test_id: string
          score?: number
          student_id: string
          workspace_id: string
        }
        Update: {
          answers?: Json
          completed_at?: string | null
          created_at?: string
          feedback?: Json | null
          id?: string
          max_score?: number
          practice_test_id?: string
          score?: number
          student_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "practice_test_attempts_practice_test_id_fkey"
            columns: ["practice_test_id"]
            isOneToOne: false
            referencedRelation: "practice_tests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "practice_test_attempts_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "practice_test_attempts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      practice_test_questions: {
        Row: {
          correct_answer: string
          created_at: string
          explanation: string | null
          id: string
          options: Json | null
          practice_test_id: string
          prompt: string
          question_number: number
          question_type: string
        }
        Insert: {
          correct_answer: string
          created_at?: string
          explanation?: string | null
          id?: string
          options?: Json | null
          practice_test_id: string
          prompt: string
          question_number: number
          question_type?: string
        }
        Update: {
          correct_answer?: string
          created_at?: string
          explanation?: string | null
          id?: string
          options?: Json | null
          practice_test_id?: string
          prompt?: string
          question_number?: number
          question_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "practice_test_questions_practice_test_id_fkey"
            columns: ["practice_test_id"]
            isOneToOne: false
            referencedRelation: "practice_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      practice_tests: {
        Row: {
          created_at: string
          created_by: string | null
          created_by_ai: boolean
          description: string | null
          difficulty: string
          grammar_topic_id: string
          id: string
          level: string
          teacher_reviewed: boolean
          title: string
          updated_at: string
          visibility: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          created_by_ai?: boolean
          description?: string | null
          difficulty: string
          grammar_topic_id: string
          id?: string
          level: string
          teacher_reviewed?: boolean
          title: string
          updated_at?: string
          visibility?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          created_by_ai?: boolean
          description?: string | null
          difficulty?: string
          grammar_topic_id?: string
          id?: string
          level?: string
          teacher_reviewed?: boolean
          title?: string
          updated_at?: string
          visibility?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "practice_tests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "practice_tests_grammar_topic_id_fkey"
            columns: ["grammar_topic_id"]
            isOneToOne: false
            referencedRelation: "grammar_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "practice_tests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          global_role: string
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          global_role?: string
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          global_role?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      questions: {
        Row: {
          created_at: string
          created_by: string | null
          estimated_minutes: number | null
          expected_word_max: number | null
          expected_word_min: number | null
          id: string
          is_active: boolean
          level: string
          prompt: string
          task_type: string
          title: string
          topic: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          estimated_minutes?: number | null
          expected_word_max?: number | null
          expected_word_min?: number | null
          id?: string
          is_active?: boolean
          level: string
          prompt: string
          task_type?: string
          title: string
          topic: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          estimated_minutes?: number | null
          expected_word_max?: number | null
          expected_word_min?: number | null
          id?: string
          is_active?: boolean
          level?: string
          prompt?: string
          task_type?: string
          title?: string
          topic?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "questions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      student_grammar_stats: {
        Row: {
          grammar_topic_id: string
          id: string
          last_seen_at: string | null
          practice_unlocked: boolean
          student_id: string
          total_correct_after_practice: number
          total_major_issues: number
          total_minor_issues: number
          updated_at: string
          weakness_level: string
          workspace_id: string
        }
        Insert: {
          grammar_topic_id: string
          id?: string
          last_seen_at?: string | null
          practice_unlocked?: boolean
          student_id: string
          total_correct_after_practice?: number
          total_major_issues?: number
          total_minor_issues?: number
          updated_at?: string
          weakness_level?: string
          workspace_id: string
        }
        Update: {
          grammar_topic_id?: string
          id?: string
          last_seen_at?: string | null
          practice_unlocked?: boolean
          student_id?: string
          total_correct_after_practice?: number
          total_major_issues?: number
          total_minor_issues?: number
          updated_at?: string
          weakness_level?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "student_grammar_stats_grammar_topic_id_fkey"
            columns: ["grammar_topic_id"]
            isOneToOne: false
            referencedRelation: "grammar_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_grammar_stats_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_grammar_stats_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      student_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          batch_id: string | null
          created_at: string
          email: string
          expires_at: string | null
          id: string
          invited_by: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          batch_id?: string | null
          created_at?: string
          email: string
          expires_at?: string | null
          id?: string
          invited_by?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          batch_id?: string | null
          created_at?: string
          email?: string
          expires_at?: string | null
          id?: string
          invited_by?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "student_invitations_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_invitations_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "student_invitations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      submission_grammar_topics: {
        Row: {
          count: number
          created_at: string
          grammar_topic_id: string
          id: string
          severity: string
          simple_explanation: string | null
          submission_id: string
        }
        Insert: {
          count?: number
          created_at?: string
          grammar_topic_id: string
          id?: string
          severity: string
          simple_explanation?: string | null
          submission_id: string
        }
        Update: {
          count?: number
          created_at?: string
          grammar_topic_id?: string
          id?: string
          severity?: string
          simple_explanation?: string | null
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_grammar_topics_grammar_topic_id_fkey"
            columns: ["grammar_topic_id"]
            isOneToOne: false
            referencedRelation: "grammar_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_grammar_topics_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      submission_lines: {
        Row: {
          changed_parts: Json
          corrected_line: string
          created_at: string
          detailed_explanation: string | null
          grammar_topic_id: string | null
          id: string
          line_number: number
          original_line: string
          short_explanation: string | null
          status: string
          submission_id: string
        }
        Insert: {
          changed_parts?: Json
          corrected_line: string
          created_at?: string
          detailed_explanation?: string | null
          grammar_topic_id?: string | null
          id?: string
          line_number: number
          original_line: string
          short_explanation?: string | null
          status: string
          submission_id: string
        }
        Update: {
          changed_parts?: Json
          corrected_line?: string
          created_at?: string
          detailed_explanation?: string | null
          grammar_topic_id?: string | null
          id?: string
          line_number?: number
          original_line?: string
          short_explanation?: string | null
          status?: string
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "submission_lines_grammar_topic_id_fkey"
            columns: ["grammar_topic_id"]
            isOneToOne: false
            referencedRelation: "grammar_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submission_lines_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      submissions: {
        Row: {
          ai_model: string | null
          batch_id: string | null
          checked_at: string | null
          corrected_text: string | null
          created_at: string
          feedback_completed_at: string | null
          feedback_error: string | null
          feedback_mode: string | null
          feedback_scheduled_at: string | null
          feedback_started_at: string | null
          global_question_id: string | null
          id: string
          level_detected: string | null
          mode: string
          original_text: string
          overall_summary: string | null
          question_id: string | null
          question_source: string | null
          status: string
          student_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          ai_model?: string | null
          batch_id?: string | null
          checked_at?: string | null
          corrected_text?: string | null
          created_at?: string
          feedback_completed_at?: string | null
          feedback_error?: string | null
          feedback_mode?: string | null
          feedback_scheduled_at?: string | null
          feedback_started_at?: string | null
          global_question_id?: string | null
          id?: string
          level_detected?: string | null
          mode: string
          original_text: string
          overall_summary?: string | null
          question_id?: string | null
          question_source?: string | null
          status?: string
          student_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          ai_model?: string | null
          batch_id?: string | null
          checked_at?: string | null
          corrected_text?: string | null
          created_at?: string
          feedback_completed_at?: string | null
          feedback_error?: string | null
          feedback_mode?: string | null
          feedback_scheduled_at?: string | null
          feedback_started_at?: string | null
          global_question_id?: string | null
          id?: string
          level_detected?: string | null
          mode?: string
          original_text?: string
          overall_summary?: string | null
          question_id?: string | null
          question_source?: string | null
          status?: string
          student_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "submissions_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_global_question_id_fkey"
            columns: ["global_question_id"]
            isOneToOne: false
            referencedRelation: "global_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "submissions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      teacher_notes: {
        Row: {
          created_at: string
          id: string
          note: string
          submission_id: string
          teacher_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          note: string
          submission_id: string
          teacher_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          note?: string
          submission_id?: string
          teacher_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "teacher_notes_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teacher_notes_teacher_id_fkey"
            columns: ["teacher_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          id: string
          role: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_workspace_invitation: {
        Args: { invitation_id: string }
        Returns: {
          accepted_invitation_id: string
          batch_id: string
          batch_student_id: string
          membership_id: string
          workspace_id: string
        }[]
      }
      approve_batch_join_request: {
        Args: { request_id: string }
        Returns: {
          approved_request_id: string
          batch_id: string
          batch_student_id: string
          membership_id: string
          status: string
          student_id: string
          workspace_id: string
        }[]
      }
      create_teacher_workspace: {
        Args: { workspace_name?: string }
        Returns: {
          membership_id: string
          workspace_id: string
        }[]
      }
      create_writing_submission: {
        Args: {
          answer_text: string
          save_as_draft?: boolean
          target_batch_id: string
          target_question_id: string
          target_question_source: string
        }
        Returns: {
          feedback_mode: string
          feedback_scheduled_at: string
          submission_id: string
        }[]
      }
      has_workspace_role: {
        Args: { allowed_roles: string[]; target_workspace_id: string }
        Returns: boolean
      }
      invite_student_by_email: {
        Args: { target_batch_id?: string; target_email: string }
        Returns: {
          batch_id: string
          batch_student_id: string
          invitation_id: string
          invitation_status: string
          membership_id: string
          student_id: string
          workspace_id: string
        }[]
      }
      is_platform_admin: { Args: never; Returns: boolean }
      is_workspace_member: {
        Args: { target_workspace_id: string }
        Returns: boolean
      }
      reject_batch_join_request: {
        Args: { request_id: string }
        Returns: {
          batch_id: string
          rejected_request_id: string
          status: string
          student_id: string
          workspace_id: string
        }[]
      }
      request_join_batch_by_code: {
        Args: { join_code: string }
        Returns: {
          batch_id: string
          batch_name: string
          level: string
          request_id: string
          requires_approval: boolean
          status: string
          workspace_id: string
        }[]
      }
      rotate_batch_join_code: {
        Args: { target_batch_id: string }
        Returns: {
          batch_id: string
          join_code: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
