create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text not null,
  global_role text not null default 'student'
    check (global_role in ('platform_admin', 'teacher', 'student')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'teacher', 'student')),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create table public.batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  level text not null check (level in ('A1', 'A2', 'B1', 'B2')),
  description text,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.batch_students (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (batch_id, student_id)
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  prompt text not null,
  level text not null check (level in ('A1', 'A2', 'B1', 'B2')),
  topic text not null,
  task_type text not null default 'writing'
    check (task_type in ('writing', 'email', 'free_text', 'opinion', 'description')),
  expected_word_min integer check (expected_word_min is null or expected_word_min >= 0),
  expected_word_max integer check (expected_word_max is null or expected_word_max >= 0),
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes >= 0),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    expected_word_min is null
    or expected_word_max is null
    or expected_word_min <= expected_word_max
  )
);

create table public.grammar_topics (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  level text not null default 'A1_A2'
    check (level in ('A1', 'A2', 'B1', 'B2', 'A1_A2')),
  description text,
  created_at timestamptz not null default now(),
  unique (slug, level)
);

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  batch_id uuid references public.batches(id) on delete set null,
  question_id uuid references public.questions(id) on delete set null,
  mode text not null check (mode in ('predefined_question', 'free_text')),
  original_text text not null,
  corrected_text text,
  overall_summary text,
  level_detected text check (level_detected is null or level_detected in ('A1', 'A2', 'B1', 'B2')),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'checked', 'needs_review', 'failed')),
  ai_model text,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.submission_lines (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  original_line text not null,
  corrected_line text not null,
  status text not null
    check (status in ('correct', 'acceptable_a1_a2', 'minor_issue', 'major_issue', 'unclear')),
  changed_parts jsonb not null default '[]'::jsonb,
  short_explanation text,
  detailed_explanation text,
  grammar_topic_id uuid references public.grammar_topics(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (submission_id, line_number)
);

create table public.submission_grammar_topics (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  grammar_topic_id uuid not null references public.grammar_topics(id) on delete cascade,
  count integer not null default 0 check (count >= 0),
  severity text not null check (severity in ('minor', 'major', 'mixed')),
  simple_explanation text,
  created_at timestamptz not null default now(),
  unique (submission_id, grammar_topic_id)
);

create table public.student_grammar_stats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  grammar_topic_id uuid not null references public.grammar_topics(id) on delete cascade,
  total_minor_issues integer not null default 0 check (total_minor_issues >= 0),
  total_major_issues integer not null default 0 check (total_major_issues >= 0),
  total_correct_after_practice integer not null default 0 check (total_correct_after_practice >= 0),
  weakness_level text not null default 'tracking'
    check (weakness_level in ('tracking', 'weak', 'unlocked', 'improving', 'mastered')),
  practice_unlocked boolean not null default false,
  last_seen_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, student_id, grammar_topic_id)
);

create table public.practice_tests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  grammar_topic_id uuid not null references public.grammar_topics(id) on delete cascade,
  level text not null check (level in ('A1', 'A2', 'B1', 'B2')),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  title text not null,
  description text,
  created_by_ai boolean not null default false,
  teacher_reviewed boolean not null default false,
  visibility text not null default 'workspace' check (visibility in ('workspace', 'private')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.practice_test_questions (
  id uuid primary key default gen_random_uuid(),
  practice_test_id uuid not null references public.practice_tests(id) on delete cascade,
  question_number integer not null check (question_number > 0),
  question_type text not null default 'multiple_choice',
  prompt text not null,
  options jsonb,
  correct_answer text not null,
  explanation text,
  created_at timestamptz not null default now(),
  unique (practice_test_id, question_number)
);

create table public.practice_test_attempts (
  id uuid primary key default gen_random_uuid(),
  practice_test_id uuid not null references public.practice_tests(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  answers jsonb not null default '[]'::jsonb,
  score integer not null default 0 check (score >= 0),
  max_score integer not null default 0 check (max_score >= 0),
  feedback jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (score <= max_score)
);

create table public.teacher_notes (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index profiles_email_idx on public.profiles (lower(email));
create index workspaces_owner_id_idx on public.workspaces (owner_id);
create index workspace_members_user_id_idx on public.workspace_members (user_id);
create index workspace_members_workspace_role_idx on public.workspace_members (workspace_id, role);
create index batches_workspace_active_idx on public.batches (workspace_id, is_active);
create index batch_students_student_workspace_idx on public.batch_students (student_id, workspace_id);
create index questions_workspace_active_idx on public.questions (workspace_id, is_active);
create index questions_workspace_level_idx on public.questions (workspace_id, level);
create index submissions_student_created_idx on public.submissions (student_id, created_at desc);
create index submissions_workspace_created_idx on public.submissions (workspace_id, created_at desc);
create index submissions_workspace_status_idx on public.submissions (workspace_id, status);
create index submission_lines_submission_line_idx on public.submission_lines (submission_id, line_number);
create index submission_grammar_topics_topic_idx on public.submission_grammar_topics (grammar_topic_id);
create index student_grammar_stats_student_idx on public.student_grammar_stats (student_id, practice_unlocked);
create index student_grammar_stats_workspace_topic_idx on public.student_grammar_stats (workspace_id, grammar_topic_id, weakness_level);
create index practice_tests_reuse_idx on public.practice_tests (workspace_id, grammar_topic_id, level, difficulty, visibility);
create index practice_test_attempts_student_idx on public.practice_test_attempts (workspace_id, student_id, completed_at desc);
create index teacher_notes_submission_idx on public.teacher_notes (submission_id, created_at desc);
create index usage_events_user_type_created_idx on public.usage_events (workspace_id, user_id, event_type, created_at desc);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function public.set_updated_at();

create trigger batches_set_updated_at
before update on public.batches
for each row execute function public.set_updated_at();

create trigger questions_set_updated_at
before update on public.questions
for each row execute function public.set_updated_at();

create trigger submissions_set_updated_at
before update on public.submissions
for each row execute function public.set_updated_at();

create trigger practice_tests_set_updated_at
before update on public.practice_tests
for each row execute function public.set_updated_at();

create trigger teacher_notes_set_updated_at
before update on public.teacher_notes
for each row execute function public.set_updated_at();

create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.global_role = 'platform_admin'
  );
$$;

create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_workspace_role(target_workspace_id uuid, allowed_roles text[])
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = (select auth.uid())
      and wm.role = any(allowed_roles)
  );
$$;

revoke all on function public.is_platform_admin() from public, anon;
revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.has_workspace_role(uuid, text[]) from public, anon;

grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, text[]) to authenticated;

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.batches enable row level security;
alter table public.batch_students enable row level security;
alter table public.questions enable row level security;
alter table public.grammar_topics enable row level security;
alter table public.submissions enable row level security;
alter table public.submission_lines enable row level security;
alter table public.submission_grammar_topics enable row level security;
alter table public.student_grammar_stats enable row level security;
alter table public.practice_tests enable row level security;
alter table public.practice_test_questions enable row level security;
alter table public.practice_test_attempts enable row level security;
alter table public.teacher_notes enable row level security;
alter table public.usage_events enable row level security;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

create policy "profiles_select_self_workspace_or_admin"
on public.profiles for select
to authenticated
using (
  id = (select auth.uid())
  or public.is_platform_admin()
  or exists (
    select 1
    from public.workspace_members viewer
    join public.workspace_members target
      on target.workspace_id = viewer.workspace_id
    where viewer.user_id = (select auth.uid())
      and viewer.role in ('owner', 'teacher')
      and target.user_id = profiles.id
  )
);

create policy "profiles_insert_self"
on public.profiles for insert
to authenticated
with check (id = (select auth.uid()));

create policy "profiles_update_self"
on public.profiles for update
to authenticated
using (id = (select auth.uid()) or public.is_platform_admin())
with check (id = (select auth.uid()) or public.is_platform_admin());

create policy "workspaces_select_members"
on public.workspaces for select
to authenticated
using (public.is_platform_admin() or public.is_workspace_member(id));

create policy "workspaces_insert_owner"
on public.workspaces for insert
to authenticated
with check (owner_id = (select auth.uid()) or public.is_platform_admin());

create policy "workspaces_update_owner"
on public.workspaces for update
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(id, array['owner']))
with check (public.is_platform_admin() or public.has_workspace_role(id, array['owner']));

create policy "workspace_members_select_self_or_workspace_teacher"
on public.workspace_members for select
to authenticated
using (
  public.is_platform_admin()
  or user_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

create policy "workspace_members_manage_workspace_teacher"
on public.workspace_members for all
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']))
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));

create policy "batches_select_members"
on public.batches for select
to authenticated
using (public.is_platform_admin() or public.is_workspace_member(workspace_id));

create policy "batches_manage_teachers"
on public.batches for all
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']))
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));

create policy "batch_students_select_members"
on public.batch_students for select
to authenticated
using (
  public.is_platform_admin()
  or student_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

create policy "batch_students_manage_teachers"
on public.batch_students for all
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']))
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));

create policy "questions_select_workspace_members"
on public.questions for select
to authenticated
using (public.is_platform_admin() or public.is_workspace_member(workspace_id));

create policy "questions_manage_teachers"
on public.questions for all
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']))
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));

create policy "grammar_topics_select_authenticated"
on public.grammar_topics for select
to authenticated
using (true);

create policy "grammar_topics_manage_admin"
on public.grammar_topics for all
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

create policy "submissions_select_owner_or_teacher"
on public.submissions for select
to authenticated
using (
  public.is_platform_admin()
  or student_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

create policy "submissions_insert_student"
on public.submissions for insert
to authenticated
with check (
  student_id = (select auth.uid())
  and public.is_workspace_member(workspace_id)
);

create policy "submissions_update_owner_or_teacher"
on public.submissions for update
to authenticated
using (
  public.is_platform_admin()
  or student_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
)
with check (
  public.is_platform_admin()
  or student_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

create policy "submission_lines_select_parent_visible"
on public.submission_lines for select
to authenticated
using (
  exists (
    select 1
    from public.submissions s
    where s.id = submission_lines.submission_id
      and (
        public.is_platform_admin()
        or s.student_id = (select auth.uid())
        or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
      )
  )
);

create policy "submission_grammar_topics_select_parent_visible"
on public.submission_grammar_topics for select
to authenticated
using (
  exists (
    select 1
    from public.submissions s
    where s.id = submission_grammar_topics.submission_id
      and (
        public.is_platform_admin()
        or s.student_id = (select auth.uid())
        or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
      )
  )
);

create policy "student_grammar_stats_select_owner_or_teacher"
on public.student_grammar_stats for select
to authenticated
using (
  public.is_platform_admin()
  or student_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

create policy "practice_tests_select_workspace_members"
on public.practice_tests for select
to authenticated
using (public.is_platform_admin() or public.is_workspace_member(workspace_id));

create policy "practice_tests_manage_teachers"
on public.practice_tests for all
to authenticated
using (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']))
with check (public.is_platform_admin() or public.has_workspace_role(workspace_id, array['owner', 'teacher']));

create policy "practice_test_questions_select_parent_visible"
on public.practice_test_questions for select
to authenticated
using (
  exists (
    select 1
    from public.practice_tests pt
    where pt.id = practice_test_questions.practice_test_id
      and (public.is_platform_admin() or public.is_workspace_member(pt.workspace_id))
  )
);

create policy "practice_test_questions_manage_teachers"
on public.practice_test_questions for all
to authenticated
using (
  exists (
    select 1
    from public.practice_tests pt
    where pt.id = practice_test_questions.practice_test_id
      and (public.is_platform_admin() or public.has_workspace_role(pt.workspace_id, array['owner', 'teacher']))
  )
)
with check (
  exists (
    select 1
    from public.practice_tests pt
    where pt.id = practice_test_questions.practice_test_id
      and (public.is_platform_admin() or public.has_workspace_role(pt.workspace_id, array['owner', 'teacher']))
  )
);

create policy "practice_test_attempts_select_owner_or_teacher"
on public.practice_test_attempts for select
to authenticated
using (
  public.is_platform_admin()
  or student_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

create policy "practice_test_attempts_insert_student"
on public.practice_test_attempts for insert
to authenticated
with check (
  student_id = (select auth.uid())
  and public.is_workspace_member(workspace_id)
);

create policy "teacher_notes_select_submission_visible"
on public.teacher_notes for select
to authenticated
using (
  exists (
    select 1
    from public.submissions s
    where s.id = teacher_notes.submission_id
      and (
        public.is_platform_admin()
        or s.student_id = (select auth.uid())
        or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
      )
  )
);

create policy "teacher_notes_manage_teachers"
on public.teacher_notes for all
to authenticated
using (
  exists (
    select 1
    from public.submissions s
    where s.id = teacher_notes.submission_id
      and (public.is_platform_admin() or public.has_workspace_role(s.workspace_id, array['owner', 'teacher']))
  )
)
with check (
  exists (
    select 1
    from public.submissions s
    where s.id = teacher_notes.submission_id
      and (public.is_platform_admin() or public.has_workspace_role(s.workspace_id, array['owner', 'teacher']))
  )
);

create policy "usage_events_select_owner_or_teacher"
on public.usage_events for select
to authenticated
using (
  public.is_platform_admin()
  or user_id = (select auth.uid())
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

create policy "usage_events_insert_self"
on public.usage_events for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_workspace_member(workspace_id)
);
