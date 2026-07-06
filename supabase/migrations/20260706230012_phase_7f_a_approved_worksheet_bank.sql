-- Phase 7F-A: approved worksheet bank source metadata.
-- Curated/manual worksheets are stored in practice_tests with practice_test_questions
-- and should be selected before provider-generated worksheets.

alter table public.practice_tests
drop constraint if exists practice_tests_generation_source_check;

alter table public.practice_tests
add constraint practice_tests_generation_source_check
check (generation_source in (
  'manual',
  'manual_import',
  'teacher_created',
  'deepseek',
  'fixture',
  'system_fallback'
));

alter table public.practice_tests
drop constraint if exists practice_tests_quality_status_check;

alter table public.practice_tests
add constraint practice_tests_quality_status_check
check (quality_status in (
  'unreviewed',
  'approved',
  'passed',
  'failed',
  'needs_review'
));

create index if not exists practice_tests_phase7f_source_priority_idx
on public.practice_tests (
  workspace_id,
  grammar_topic_id,
  level,
  visibility,
  generation_source,
  quality_status,
  teacher_reviewed,
  created_at desc
);
