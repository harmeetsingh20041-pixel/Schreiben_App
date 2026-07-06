-- Phase 7E-1 stabilization: developer-safe worksheet generation diagnostics
-- and fallback source metadata. These diagnostics are service-side only and
-- must not be shown directly to students.

alter table public.practice_tests
drop constraint if exists practice_tests_generation_source_check;

alter table public.practice_tests
add constraint practice_tests_generation_source_check
check (generation_source in ('manual', 'deepseek', 'fixture', 'system_fallback'));

create table if not exists public.practice_generation_events (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.student_practice_assignments(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  grammar_topic_id uuid not null references public.grammar_topics(id) on delete cascade,
  attempt_number integer,
  stage text not null,
  safe_status text not null,
  developer_reason text,
  question_number integer,
  question_type text,
  created_at timestamptz not null default now(),
  constraint practice_generation_events_stage_check
    check (stage in ('reuse_lookup', 'provider_call', 'parse', 'validate', 'save', 'fallback')),
  constraint practice_generation_events_safe_status_check
    check (safe_status in ('started', 'failed', 'succeeded'))
);

create index if not exists practice_generation_events_assignment_idx
on public.practice_generation_events (assignment_id, created_at desc);

create index if not exists practice_generation_events_workspace_idx
on public.practice_generation_events (workspace_id, created_at desc);

alter table public.practice_generation_events enable row level security;

revoke all on public.practice_generation_events from public, anon, authenticated;
grant select, insert on public.practice_generation_events to service_role;
