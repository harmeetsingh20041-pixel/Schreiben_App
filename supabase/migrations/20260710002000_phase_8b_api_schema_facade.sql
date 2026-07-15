-- Phase 8B: introduce a deliberately exposed, least-privilege API facade.
--
-- Staging keeps public + api exposed until every Edge Function and importer
-- has moved away from unqualified public routes. The clean production project
-- will expose only api after those server paths are migrated and verified.

create schema if not exists api;

revoke all on schema api from public, anon, authenticated, service_role;
grant usage on schema api to authenticated, service_role;

alter default privileges for role postgres in schema api
  revoke select, insert, update, delete, truncate, references, trigger
  on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema api
  revoke usage, select, update
  on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema api
  revoke execute on functions from public, anon, authenticated, service_role;

-- New public objects must also be explicitly granted. Existing grants are
-- narrowed below only after the api client cutover has passed in staging.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete, truncate, references, trigger
  on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select, update
  on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;

-- Read projections are explicit-column, security-invoker views. Base-table
-- grants and RLS remain authoritative; no view executes with its owner's
-- privileges. Sensitive provider payloads, answer blobs, and raw errors are
-- intentionally absent.

create or replace view api.profiles
with (security_invoker = true, security_barrier = true)
as
select p.id, p.full_name, p.email
from public.profiles p;

create or replace view api.workspaces
with (security_invoker = true, security_barrier = true)
as
select w.id, w.name, w.slug
from public.workspaces w;

create or replace view api.workspace_members
with (security_invoker = true, security_barrier = true)
as
select wm.id, wm.workspace_id, wm.user_id, wm.role, wm.created_at
from public.workspace_members wm;

create or replace view api.batches
with (security_invoker = true, security_barrier = true)
as
select
  b.id,
  b.workspace_id,
  b.name,
  b.level,
  b.description,
  b.is_active,
  b.join_code_enabled,
  b.join_requires_approval,
  b.feedback_mode,
  b.feedback_delay_min_minutes,
  b.feedback_delay_max_minutes,
  b.created_by,
  b.created_at,
  b.updated_at
from public.batches b;

create or replace view api.batch_students
with (security_invoker = true, security_barrier = true)
as
select bs.id, bs.workspace_id, bs.batch_id, bs.student_id, bs.created_at
from public.batch_students bs;

create or replace view api.questions
with (security_invoker = true, security_barrier = true)
as
select
  q.id,
  q.workspace_id,
  q.title,
  q.prompt,
  q.level,
  q.topic,
  q.task_type,
  q.expected_word_min,
  q.expected_word_max,
  q.estimated_minutes,
  q.is_active,
  q.created_by,
  q.created_at,
  q.updated_at
from public.questions q;

create or replace view api.global_questions
with (security_invoker = true, security_barrier = true)
as
select
  q.id,
  q.title,
  q.prompt,
  q.level,
  q.topic,
  q.task_type,
  q.expected_word_min,
  q.expected_word_max,
  q.estimated_minutes,
  q.is_active,
  q.sort_order,
  q.source_key,
  q.source_label,
  q.created_by,
  q.created_at,
  q.updated_at
from public.global_questions q;

create or replace view api.grammar_topics
with (security_invoker = true, security_barrier = true)
as
select gt.id, gt.name, gt.slug, gt.description, gt.level, gt.created_at
from public.grammar_topics gt;

-- Students may see their submission state, but correction content remains
-- masked until the current checked/released state. Teachers in the submission
-- workspace retain review visibility. Phase 3 will replace this temporary
-- checked-state projection with immutable released feedback versions.
create or replace view api.submissions
with (security_invoker = true, security_barrier = true)
as
select
  s.id,
  s.workspace_id,
  s.student_id,
  s.batch_id,
  s.question_id,
  s.global_question_id,
  s.question_source,
  s.mode,
  s.original_text,
  s.status,
  case
    when s.status = 'checked'
      or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
    then s.corrected_text
    else null
  end as corrected_text,
  case
    when s.status = 'checked'
      or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
    then s.overall_summary
    else null
  end as overall_summary,
  case
    when s.status = 'checked'
      or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
    then s.level_detected
    else null
  end as level_detected,
  case
    when s.status = 'checked'
      or public.has_workspace_role(s.workspace_id, array['owner', 'teacher'])
    then s.checked_at
    else null
  end as checked_at,
  s.feedback_mode,
  s.feedback_scheduled_at,
  s.feedback_started_at,
  s.feedback_completed_at,
  case when s.feedback_error is null then null else 'feedback_failed' end
    as feedback_error,
  s.created_at,
  s.updated_at
from public.submissions s;

create or replace view api.submission_lines
with (security_invoker = true, security_barrier = true)
as
select
  sl.id,
  sl.submission_id,
  sl.line_number,
  sl.original_line,
  sl.corrected_line,
  sl.status,
  sl.grammar_topic_id,
  sl.short_explanation,
  sl.detailed_explanation,
  sl.changed_parts,
  sl.created_at
from public.submission_lines sl
join public.submissions s on s.id = sl.submission_id
where
  s.status = 'checked'
  or public.has_workspace_role(s.workspace_id, array['owner', 'teacher']);

create or replace view api.submission_grammar_topics
with (security_invoker = true, security_barrier = true)
as
select
  sgt.id,
  sgt.submission_id,
  sgt.grammar_topic_id,
  sgt.count,
  sgt.severity,
  sgt.simple_explanation,
  sgt.created_at
from public.submission_grammar_topics sgt
join public.submissions s on s.id = sgt.submission_id
where
  s.status = 'checked'
  or public.has_workspace_role(s.workspace_id, array['owner', 'teacher']);

create or replace view api.student_grammar_stats
with (security_invoker = true, security_barrier = true)
as
select
  sgs.id,
  sgs.workspace_id,
  sgs.student_id,
  sgs.grammar_topic_id,
  sgs.total_minor_issues,
  sgs.total_major_issues,
  sgs.total_correct_after_practice,
  sgs.weakness_level,
  sgs.practice_unlocked,
  sgs.last_seen_at,
  sgs.updated_at
from public.student_grammar_stats sgs;

create or replace view api.batch_join_requests
with (security_invoker = true, security_barrier = true)
as
select
  bjr.id,
  bjr.workspace_id,
  bjr.batch_id,
  bjr.student_id,
  bjr.student_email,
  bjr.student_name,
  bjr.status,
  bjr.requested_at,
  bjr.decided_at,
  bjr.decided_by,
  bjr.created_at,
  bjr.updated_at
from public.batch_join_requests bjr;

create or replace view api.student_practice_assignments
with (security_invoker = true, security_barrier = true)
as
select
  spa.id,
  spa.workspace_id,
  spa.student_id,
  spa.grammar_topic_id,
  spa.practice_test_id,
  spa.status,
  spa.source,
  spa.assigned_by,
  spa.assigned_at,
  spa.started_at,
  spa.completed_at,
  spa.latest_attempt_id,
  spa.generation_status,
  spa.generation_started_at,
  spa.generation_completed_at,
  case when spa.generation_error is null then null else 'generation_failed' end
    as generation_error,
  spa.previous_assignment_id,
  spa.previous_attempt_id,
  spa.repeat_number,
  spa.adaptive_reason,
  spa.adaptive_status,
  spa.updated_at
from public.student_practice_assignments spa;

create or replace view api.practice_tests
with (security_invoker = true, security_barrier = true)
as
select
  pt.id,
  pt.workspace_id,
  pt.grammar_topic_id,
  pt.title,
  pt.level,
  pt.difficulty,
  pt.mini_lesson,
  pt.visibility,
  pt.quality_status,
  pt.teacher_reviewed,
  pt.created_by_ai,
  pt.generation_source,
  pt.created_at,
  pt.updated_at
from public.practice_tests pt;

create or replace view api.practice_test_attempts
with (security_invoker = true, security_barrier = true)
as
select
  pta.id,
  pta.workspace_id,
  pta.student_id,
  pta.practice_test_id,
  pta.assignment_id,
  pta.status,
  pta.started_at,
  pta.submitted_at,
  pta.completed_at,
  pta.score,
  pta.max_score,
  pta.score_percent,
  pta.passed,
  pta.score_points,
  pta.max_score_points,
  pta.scoring_version,
  pta.evaluation_status,
  pta.evaluation_started_at,
  pta.evaluation_completed_at,
  case when pta.evaluation_error is null then null else 'evaluation_failed' end
    as evaluation_error,
  pta.created_at
from public.practice_test_attempts pta;

revoke all on all tables in schema api
  from public, anon, authenticated, service_role;

grant select on
  api.profiles,
  api.workspaces,
  api.workspace_members,
  api.batches,
  api.batch_students,
  api.questions,
  api.global_questions,
  api.grammar_topics,
  api.submissions,
  api.submission_lines,
  api.submission_grammar_topics,
  api.student_grammar_stats,
  api.batch_join_requests,
  api.student_practice_assignments,
  api.practice_tests,
  api.practice_test_attempts
to authenticated, service_role;

-- Core V1 mutation aliases. These are invoker wrappers around already-reviewed
-- authorization boundaries; the exposed api schema contains no definer
-- routines.

create or replace function api.get_auth_context()
returns table (
  user_id uuid,
  full_name text,
  email text,
  global_role text,
  teacher_entitled boolean,
  teacher_workspace_count integer,
  teacher_workspace_limit integer,
  can_create_teacher_workspace boolean,
  memberships jsonb
)
language sql
security invoker
set search_path = ''
stable
as $$
  select * from public.get_auth_context();
$$;

create or replace function api.create_teacher_workspace(
  workspace_name text default 'My German Class'
)
returns table (workspace_id uuid, membership_id uuid)
language sql
security invoker
set search_path = ''
as $$
  select * from public.create_teacher_workspace(workspace_name);
$$;

create or replace function api.list_workspace_batch_join_codes(
  workspace_id uuid
)
returns table (
  batch_id uuid,
  join_code text,
  join_code_enabled boolean,
  join_requires_approval boolean
)
language sql
security invoker
set search_path = ''
stable
as $$
  select *
  from public.list_workspace_batch_join_codes(workspace_id);
$$;

create or replace function api.rotate_batch_join_code(target_batch_id uuid)
returns table (batch_id uuid, join_code text)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.rotate_batch_join_code(target_batch_id);
$$;

create or replace function api.request_batch_join(code text)
returns table (
  request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  batch_name text,
  level text,
  status text,
  requires_approval boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.request_join_batch_by_code(code);
$$;

create or replace function api.decide_batch_join(
  join_request_id uuid,
  decision text
)
returns table (
  request_id uuid,
  workspace_id uuid,
  batch_id uuid,
  student_id uuid,
  status text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  clean_decision text := lower(btrim(decision));
begin
  if clean_decision = 'approved' then
    return query
    select
      result.approved_request_id,
      result.workspace_id,
      result.batch_id,
      result.student_id,
      result.status
    from public.approve_batch_join_request(join_request_id) result;
    return;
  end if;

  if clean_decision = 'rejected' then
    return query
    select
      result.rejected_request_id,
      result.workspace_id,
      result.batch_id,
      result.student_id,
      result.status
    from public.reject_batch_join_request(join_request_id) result;
    return;
  end if;

  raise exception using
    errcode = '22023',
    message = 'Decision must be approved or rejected.';
end;
$$;

create or replace function api.offboard_student(
  student_id uuid,
  workspace_id uuid
)
returns table (
  removed_batch_assignments integer,
  cancelled_join_requests integer,
  membership_removed boolean
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.offboard_student(student_id, workspace_id);
$$;

create or replace function api.submit_writing(
  batch_id uuid,
  source_type text,
  source_id uuid,
  "text" text
)
returns table (
  submission_id uuid,
  evaluation_status text,
  release_status text,
  release_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select
    created.submission_id,
    'queued'::text,
    case
      when created.feedback_mode = 'automatic_delayed' then 'scheduled'::text
      else 'held'::text
    end,
    case
      when created.feedback_mode = 'automatic_delayed'
        then created.feedback_scheduled_at
      else null
    end
  from public.create_writing_submission(
    $2,
    $3,
    $1,
    $4,
    false
  ) created;
$$;

revoke all on all functions in schema api
  from public, anon, authenticated, service_role;

grant execute on function api.get_auth_context()
  to authenticated, service_role;
grant execute on function api.create_teacher_workspace(text)
  to authenticated, service_role;
grant execute on function api.list_workspace_batch_join_codes(uuid)
  to authenticated, service_role;
grant execute on function api.rotate_batch_join_code(uuid)
  to authenticated, service_role;
grant execute on function api.request_batch_join(text)
  to authenticated, service_role;
grant execute on function api.decide_batch_join(uuid, text)
  to authenticated, service_role;
grant execute on function api.offboard_student(uuid, uuid)
  to authenticated, service_role;
grant execute on function api.submit_writing(uuid, text, uuid, text)
  to authenticated, service_role;

comment on schema api is
  'Deliberately exposed V1 Data API facade. Objects require explicit grants.';
