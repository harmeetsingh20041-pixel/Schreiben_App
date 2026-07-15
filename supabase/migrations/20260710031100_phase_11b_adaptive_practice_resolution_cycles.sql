-- Phase 11B: adaptive-practice resolution cycles.
--
-- Released feedback is copied into an append-only evidence ledger. Each
-- worksheet freezes the highest evidence sequence it is intended to resolve,
-- so a later release can never be erased by an older practice pass.

create table if not exists app_private.practice_weakness_evidence (
  evidence_sequence bigint generated always as identity primary key,
  source_kind text not null
    check (source_kind in ('feedback_draft', 'legacy_release')),
  source_release_id uuid not null,
  feedback_draft_id uuid references app_private.feedback_drafts(id) on delete restrict,
  submission_id uuid not null references public.submissions(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  grammar_topic_id uuid not null references public.grammar_topics(id) on delete restrict,
  minor_issue_count integer not null default 0 check (minor_issue_count >= 0),
  major_issue_count integer not null default 0 check (major_issue_count >= 0),
  released_at timestamptz not null,
  captured_at timestamptz not null default now(),
  unique (source_kind, source_release_id, grammar_topic_id),
  check (minor_issue_count > 0 or major_issue_count > 0),
  check (
    (source_kind = 'feedback_draft' and feedback_draft_id = source_release_id)
    or (source_kind = 'legacy_release' and feedback_draft_id is null)
  )
);

create index if not exists practice_weakness_evidence_topic_sequence_idx
on app_private.practice_weakness_evidence (
  workspace_id,
  student_id,
  grammar_topic_id,
  evidence_sequence
);

create table if not exists app_private.practice_resolution_cycles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  grammar_topic_id uuid not null references public.grammar_topics(id) on delete restrict,
  cycle_number integer not null check (cycle_number > 0),
  state text not null
    check (state in ('locked', 'unlocked', 'in_progress', 'improving', 'mastered')),
  state_reason text not null check (length(state_reason) between 1 and 80),
  evidence_start_sequence bigint not null check (evidence_start_sequence > 0),
  evidence_through_sequence bigint not null check (evidence_through_sequence >= 0),
  minor_issue_count integer not null default 0 check (minor_issue_count >= 0),
  major_issue_count integer not null default 0 check (major_issue_count >= 0),
  evidence_frozen_at timestamptz,
  active_assignment_id uuid references public.student_practice_assignments(id) on delete set null,
  resolution_assignment_id uuid references public.student_practice_assignments(id) on delete restrict,
  resolution_attempt_id uuid references public.practice_test_attempts(id) on delete restrict,
  resolution_outcome text check (resolution_outcome is null or resolution_outcome = 'passed'),
  resolved_through_sequence bigint check (resolved_through_sequence is null or resolved_through_sequence >= 0),
  mastery_pass_number integer not null default 0 check (mastery_pass_number >= 0),
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, student_id, grammar_topic_id, cycle_number),
  check (evidence_through_sequence >= evidence_start_sequence - 1),
  check (
    (
      state in ('locked', 'unlocked', 'in_progress')
      and resolved_at is null
      and resolution_outcome is null
      and resolved_through_sequence is null
    )
    or (
      state in ('improving', 'mastered')
      and resolved_at is not null
      and resolution_outcome = 'passed'
      and resolved_through_sequence is not null
    )
  )
);

create unique index if not exists practice_resolution_cycles_one_open_topic_idx
on app_private.practice_resolution_cycles (workspace_id, student_id, grammar_topic_id)
where resolved_at is null;

create index if not exists practice_resolution_cycles_topic_history_idx
on app_private.practice_resolution_cycles (
  workspace_id,
  student_id,
  grammar_topic_id,
  cycle_number desc
);

create table if not exists app_private.practice_resolution_cycle_events (
  event_sequence bigint generated always as identity primary key,
  cycle_id uuid not null references app_private.practice_resolution_cycles(id) on delete restrict,
  event_type text not null check (event_type in (
    'cycle_opened',
    'evidence_refreshed',
    'assignment_created',
    'assignment_started',
    'assignment_failed',
    'assignment_cancelled',
    'cycle_resolved',
    'migration_backfill'
  )),
  from_state text,
  to_state text not null,
  evidence_through_sequence bigint not null check (evidence_through_sequence >= 0),
  assignment_id uuid references public.student_practice_assignments(id) on delete restrict,
  attempt_id uuid references public.practice_test_attempts(id) on delete restrict,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists practice_resolution_cycle_events_cycle_idx
on app_private.practice_resolution_cycle_events (cycle_id, event_sequence);

alter table app_private.practice_weakness_evidence enable row level security;
alter table app_private.practice_resolution_cycles enable row level security;
alter table app_private.practice_resolution_cycle_events enable row level security;

revoke all on table app_private.practice_weakness_evidence
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_resolution_cycles
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_resolution_cycle_events
from public, anon, authenticated, service_role;
revoke all on all sequences in schema app_private
from public, anon, authenticated, service_role;

alter table public.student_practice_assignments
  add column if not exists resolution_cycle_id uuid
    references app_private.practice_resolution_cycles(id) on delete restrict,
  add column if not exists resolution_cycle_number integer,
  add column if not exists evidence_cutoff_sequence bigint;

alter table public.student_practice_assignments
  drop constraint if exists student_practice_assignments_resolution_cycle_number_check,
  add constraint student_practice_assignments_resolution_cycle_number_check
    check (resolution_cycle_number is null or resolution_cycle_number > 0),
  drop constraint if exists student_practice_assignments_evidence_cutoff_check,
  add constraint student_practice_assignments_evidence_cutoff_check
    check (evidence_cutoff_sequence is null or evidence_cutoff_sequence >= 0),
  drop constraint if exists student_practice_assignments_resolution_shape_check,
  add constraint student_practice_assignments_resolution_shape_check
    check (
      (resolution_cycle_id is null and resolution_cycle_number is null and evidence_cutoff_sequence is null)
      or
      (resolution_cycle_id is not null and resolution_cycle_number is not null and evidence_cutoff_sequence is not null)
    );

create unique index if not exists student_practice_assignments_one_active_cycle_idx
on public.student_practice_assignments (
  workspace_id,
  student_id,
  grammar_topic_id,
  resolution_cycle_id
)
where resolution_cycle_id is not null
  and status in ('unlocked', 'in_progress', 'completed');

create unique index if not exists student_practice_assignments_one_repeat_child_idx
on public.student_practice_assignments (previous_assignment_id)
where previous_assignment_id is not null
  and source = 'adaptive_repeat'
  and status <> 'cancelled';

alter table public.student_grammar_stats
  add column if not exists resolution_cycle_id uuid
    references app_private.practice_resolution_cycles(id) on delete restrict,
  add column if not exists resolution_cycle_number integer not null default 0,
  add column if not exists resolved_through_sequence bigint not null default 0,
  add column if not exists mastery_pass_count integer not null default 0,
  add column if not exists state_reason text;

alter table public.student_grammar_stats
  drop constraint if exists student_grammar_stats_weakness_level_check;

update public.student_grammar_stats
set
  weakness_level = case
    when weakness_level in ('improving', 'mastered') then weakness_level
    when practice_unlocked or weakness_level = 'unlocked' then 'unlocked'
    else 'locked'
  end,
  practice_unlocked = case
    when weakness_level in ('improving', 'mastered') then false
    else practice_unlocked or weakness_level = 'unlocked'
  end,
  state_reason = coalesce(state_reason, 'migration_pending_reconciliation');

alter table public.student_grammar_stats
  add constraint student_grammar_stats_weakness_level_check
    check (weakness_level in ('locked', 'unlocked', 'in_progress', 'improving', 'mastered')),
  drop constraint if exists student_grammar_stats_resolution_cycle_number_check,
  add constraint student_grammar_stats_resolution_cycle_number_check
    check (resolution_cycle_number >= 0),
  drop constraint if exists student_grammar_stats_resolved_through_check,
  add constraint student_grammar_stats_resolved_through_check
    check (resolved_through_sequence >= 0),
  drop constraint if exists student_grammar_stats_mastery_pass_count_check,
  add constraint student_grammar_stats_mastery_pass_count_check
    check (mastery_pass_count >= 0),
  drop constraint if exists student_grammar_stats_state_reason_check,
  add constraint student_grammar_stats_state_reason_check
    check (state_reason is null or length(state_reason) between 1 and 80),
  drop constraint if exists student_grammar_stats_unlock_shape_check,
  add constraint student_grammar_stats_unlock_shape_check
    check (practice_unlocked = (weakness_level = 'unlocked'));

create index if not exists student_grammar_stats_resolution_state_idx
on public.student_grammar_stats (
  workspace_id,
  student_id,
  weakness_level,
  resolution_cycle_number desc
);

create or replace function app_private.reject_adaptive_history_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Adaptive-practice history is immutable.';
end;
$$;

revoke all on function app_private.reject_adaptive_history_mutation()
from public, anon, authenticated, service_role;

drop trigger if exists practice_weakness_evidence_immutable
on app_private.practice_weakness_evidence;
create trigger practice_weakness_evidence_immutable
before update or delete on app_private.practice_weakness_evidence
for each row execute function app_private.reject_adaptive_history_mutation();

drop trigger if exists practice_resolution_cycle_events_immutable
on app_private.practice_resolution_cycle_events;
create trigger practice_resolution_cycle_events_immutable
before update or delete on app_private.practice_resolution_cycle_events
for each row execute function app_private.reject_adaptive_history_mutation();

create or replace function app_private.guard_practice_resolution_cycle_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.workspace_id <> new.workspace_id
    or old.student_id <> new.student_id
    or old.grammar_topic_id <> new.grammar_topic_id
    or old.cycle_number <> new.cycle_number
    or old.evidence_start_sequence <> new.evidence_start_sequence
  then
    raise exception using errcode = '55000', message = 'Practice cycle identity is immutable.';
  end if;

  if old.resolved_at is not null and new is distinct from old then
    raise exception using errcode = '55000', message = 'Resolved practice cycles are immutable.';
  end if;

  if new.evidence_through_sequence < old.evidence_through_sequence then
    raise exception using errcode = '55000', message = 'Practice evidence cutoff cannot move backwards.';
  end if;

  if old.evidence_frozen_at is not null and (
    new.evidence_through_sequence <> old.evidence_through_sequence
    or new.minor_issue_count <> old.minor_issue_count
    or new.major_issue_count <> old.major_issue_count
  ) then
    raise exception using errcode = '55000', message = 'Frozen practice evidence cannot change.';
  end if;

  if old.state = 'locked' and new.state not in ('locked', 'unlocked') then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  elsif old.state = 'unlocked' and new.state not in ('unlocked', 'in_progress', 'improving', 'mastered') then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  elsif old.state = 'in_progress' and new.state not in ('in_progress', 'unlocked', 'improving', 'mastered') then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function app_private.guard_practice_resolution_cycle_update()
from public, anon, authenticated, service_role;

drop trigger if exists practice_resolution_cycles_guard
on app_private.practice_resolution_cycles;
create trigger practice_resolution_cycles_guard
before update on app_private.practice_resolution_cycles
for each row execute function app_private.guard_practice_resolution_cycle_update();

create or replace function app_private.guard_practice_assignment_cycle_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
begin
  if tg_op = 'UPDATE' and old.resolution_cycle_id is not null and (
    new.resolution_cycle_id is distinct from old.resolution_cycle_id
    or new.resolution_cycle_number is distinct from old.resolution_cycle_number
    or new.evidence_cutoff_sequence is distinct from old.evidence_cutoff_sequence
  ) then
    raise exception using errcode = '55000', message = 'Practice assignment cycle context is immutable.';
  end if;

  if new.resolution_cycle_id is null then
    return new;
  end if;

  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.id = new.resolution_cycle_id;

  if selected_cycle.id is null
    or selected_cycle.workspace_id <> new.workspace_id
    or selected_cycle.student_id <> new.student_id
    or selected_cycle.grammar_topic_id <> new.grammar_topic_id
    or selected_cycle.cycle_number <> new.resolution_cycle_number
    or selected_cycle.evidence_through_sequence <> new.evidence_cutoff_sequence
  then
    raise exception using errcode = '55000', message = 'Practice assignment cycle context is invalid.';
  end if;

  if current_user in ('anon', 'authenticated')
    and (tg_op = 'INSERT' or old.resolution_cycle_id is null)
  then
    raise exception using errcode = '42501', message = 'Practice cycle context is server managed.';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_practice_assignment_cycle_identity()
from public, anon, authenticated, service_role;

drop trigger if exists student_practice_assignments_cycle_identity_guard
on public.student_practice_assignments;
create trigger student_practice_assignments_cycle_identity_guard
before insert or update of
  resolution_cycle_id,
  resolution_cycle_number,
  evidence_cutoff_sequence
on public.student_practice_assignments
for each row execute function app_private.guard_practice_assignment_cycle_identity();

create or replace function app_private.record_practice_cycle_event(
  target_cycle_id uuid,
  target_event_type text,
  target_from_state text,
  target_to_state text,
  target_assignment_id uuid default null,
  target_attempt_id uuid default null,
  target_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cutoff bigint;
begin
  select cycle.evidence_through_sequence
  into selected_cutoff
  from app_private.practice_resolution_cycles cycle
  where cycle.id = target_cycle_id;

  if selected_cutoff is null then
    raise exception using errcode = '02000', message = 'Practice cycle was not found.';
  end if;

  insert into app_private.practice_resolution_cycle_events (
    cycle_id,
    event_type,
    from_state,
    to_state,
    evidence_through_sequence,
    assignment_id,
    attempt_id,
    details
  ) values (
    target_cycle_id,
    target_event_type,
    target_from_state,
    target_to_state,
    selected_cutoff,
    target_assignment_id,
    target_attempt_id,
    coalesce(target_details, '{}'::jsonb)
  );
end;
$$;

revoke all on function app_private.record_practice_cycle_event(
  uuid, text, text, text, uuid, uuid, jsonb
) from public, anon, authenticated, service_role;

create or replace function app_private.capture_released_practice_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state <> 'released' then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.state = 'released' then
    return new;
  end if;

  insert into app_private.practice_weakness_evidence (
    source_kind,
    source_release_id,
    feedback_draft_id,
    submission_id,
    workspace_id,
    student_id,
    grammar_topic_id,
    minor_issue_count,
    major_issue_count,
    released_at
  )
  select
    'feedback_draft',
    new.id,
    new.id,
    submission.id,
    submission.workspace_id,
    submission.student_id,
    topic.grammar_topic_id,
    case when topic.severity = 'minor' then topic.count else 0 end,
    case when topic.severity in ('major', 'mixed') then topic.count else 0 end,
    coalesce(new.released_at, now())
  from public.submissions submission
  join public.submission_grammar_topics topic
    on topic.submission_id = submission.id
  where submission.id = new.submission_id
    and submission.release_status = 'released'
    and topic.count > 0
  on conflict (source_kind, source_release_id, grammar_topic_id) do nothing;

  return new;
end;
$$;

revoke all on function app_private.capture_released_practice_evidence()
from public, anon, authenticated, service_role;

drop trigger if exists feedback_drafts_capture_practice_evidence
on app_private.feedback_drafts;
create trigger feedback_drafts_capture_practice_evidence
after insert or update of state on app_private.feedback_drafts
for each row execute function app_private.capture_released_practice_evidence();

-- Seed the immutable ledger from already released feedback in one chronological
-- stream. Sequence order is the resolution boundary, so a two-pass backfill
-- (drafts first, legacy rows second) could let an older practice pass resolve a
-- newer release accidentally.
insert into app_private.practice_weakness_evidence (
  source_kind,
  source_release_id,
  feedback_draft_id,
  submission_id,
  workspace_id,
  student_id,
  grammar_topic_id,
  minor_issue_count,
  major_issue_count,
  released_at
)
with candidate_evidence as (
  select
    'feedback_draft'::text as source_kind,
    draft.id as source_release_id,
    draft.id as feedback_draft_id,
    submission.id as submission_id,
    submission.workspace_id,
    submission.student_id,
    topic.grammar_topic_id,
    case when topic.severity = 'minor' then topic.count else 0 end as minor_issue_count,
    case when topic.severity in ('major', 'mixed') then topic.count else 0 end as major_issue_count,
    coalesce(
      draft.released_at,
      submission.checked_at,
      submission.updated_at,
      submission.created_at
    ) as released_at
  from app_private.feedback_drafts draft
  join public.submissions submission on submission.id = draft.submission_id
  join public.submission_grammar_topics topic on topic.submission_id = submission.id
  where draft.state = 'released'
    and submission.release_status = 'released'
    and topic.count > 0

  union all

  select
    'legacy_release'::text,
    submission.id,
    null::uuid,
    submission.id,
    submission.workspace_id,
    submission.student_id,
    topic.grammar_topic_id,
    case when topic.severity = 'minor' then topic.count else 0 end,
    case when topic.severity in ('major', 'mixed') then topic.count else 0 end,
    coalesce(submission.checked_at, submission.updated_at, submission.created_at)
  from public.submissions submission
  join public.submission_grammar_topics topic on topic.submission_id = submission.id
  where submission.release_status = 'released'
    and topic.count > 0
    and not exists (
      select 1
      from app_private.feedback_drafts draft
      where draft.submission_id = submission.id
        and draft.state = 'released'
    )
)
select
  evidence.source_kind,
  evidence.source_release_id,
  evidence.feedback_draft_id,
  evidence.submission_id,
  evidence.workspace_id,
  evidence.student_id,
  evidence.grammar_topic_id,
  evidence.minor_issue_count,
  evidence.major_issue_count,
  evidence.released_at
from candidate_evidence evidence
order by
  evidence.released_at,
  evidence.source_release_id,
  evidence.grammar_topic_id
on conflict (source_kind, source_release_id, grammar_topic_id) do nothing;

create or replace function app_private.select_practice_test_for_cycle(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid
)
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  with selected_level as (
    select coalesce(
      case when topic.level in ('A1', 'A2', 'B1', 'B2') then topic.level end,
      (
        select batch.level
        from public.batch_students membership
        join public.batches batch
          on batch.id = membership.batch_id
         and batch.workspace_id = membership.workspace_id
        where membership.workspace_id = target_workspace_id
          and membership.student_id = target_student_id
          and batch.is_active = true
        order by membership.created_at desc, membership.id desc
        limit 1
      ),
      'A2'
    ) as level
    from public.grammar_topics topic
    where topic.id = target_grammar_topic_id
  )
  select worksheet.id
  from public.practice_tests worksheet
  cross join selected_level
  where worksheet.workspace_id = target_workspace_id
    and worksheet.grammar_topic_id = target_grammar_topic_id
    and worksheet.level = selected_level.level
    and worksheet.visibility = 'workspace'
    and worksheet.teacher_reviewed = true
    and worksheet.quality_status = 'approved'
    and worksheet.difficulty in ('easy', 'medium')
  order by
    case when exists (
      select 1
      from public.student_practice_assignments prior_assignment
      where prior_assignment.workspace_id = target_workspace_id
        and prior_assignment.student_id = target_student_id
        and prior_assignment.practice_test_id = worksheet.id
    ) then 1 else 0 end,
    case worksheet.difficulty when 'easy' then 1 else 2 end,
    worksheet.created_at desc,
    worksheet.id
  limit 1;
$$;

revoke all on function app_private.select_practice_test_for_cycle(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.sync_practice_topic_stats_internal(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_cycle app_private.practice_resolution_cycles%rowtype;
  latest_cycle app_private.practice_resolution_cycles%rowtype;
  resolved_cutoff bigint := 0;
  unresolved_minor integer := 0;
  unresolved_major integer := 0;
  latest_evidence_at timestamptz;
  derived_state text := 'locked';
  derived_reason text := 'below_unlock_threshold';
  pass_count integer := 0;
begin
  select cycle.*
  into current_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.workspace_id = target_workspace_id
    and cycle.student_id = target_student_id
    and cycle.grammar_topic_id = target_grammar_topic_id
    and cycle.resolved_at is null
  order by cycle.cycle_number desc
  limit 1;

  select cycle.*
  into latest_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.workspace_id = target_workspace_id
    and cycle.student_id = target_student_id
    and cycle.grammar_topic_id = target_grammar_topic_id
  order by cycle.cycle_number desc
  limit 1;

  select
    coalesce(max(cycle.resolved_through_sequence), 0),
    coalesce(max(cycle.mastery_pass_number), 0)
  into resolved_cutoff, pass_count
  from app_private.practice_resolution_cycles cycle
  where cycle.workspace_id = target_workspace_id
    and cycle.student_id = target_student_id
    and cycle.grammar_topic_id = target_grammar_topic_id
    and cycle.resolved_at is not null;

  select
    coalesce(sum(evidence.minor_issue_count), 0)::integer,
    coalesce(sum(evidence.major_issue_count), 0)::integer,
    max(evidence.released_at)
  into unresolved_minor, unresolved_major, latest_evidence_at
  from app_private.practice_weakness_evidence evidence
  where evidence.workspace_id = target_workspace_id
    and evidence.student_id = target_student_id
    and evidence.grammar_topic_id = target_grammar_topic_id
    and evidence.evidence_sequence > resolved_cutoff;

  if current_cycle.id is not null then
    derived_state := current_cycle.state;
    derived_reason := current_cycle.state_reason;
  elsif latest_cycle.id is not null then
    derived_state := latest_cycle.state;
    derived_reason := latest_cycle.state_reason;
  elsif unresolved_minor = 0 and unresolved_major = 0 then
    delete from public.student_grammar_stats stats
    where stats.workspace_id = target_workspace_id
      and stats.student_id = target_student_id
      and stats.grammar_topic_id = target_grammar_topic_id;
    return;
  end if;

  insert into public.student_grammar_stats as stats (
    workspace_id,
    student_id,
    grammar_topic_id,
    total_minor_issues,
    total_major_issues,
    total_correct_after_practice,
    weakness_level,
    practice_unlocked,
    last_seen_at,
    updated_at,
    resolution_cycle_id,
    resolution_cycle_number,
    resolved_through_sequence,
    mastery_pass_count,
    state_reason
  ) values (
    target_workspace_id,
    target_student_id,
    target_grammar_topic_id,
    unresolved_minor,
    unresolved_major,
    pass_count,
    derived_state,
    derived_state = 'unlocked',
    latest_evidence_at,
    now(),
    coalesce(current_cycle.id, latest_cycle.id),
    coalesce(current_cycle.cycle_number, latest_cycle.cycle_number, 0),
    resolved_cutoff,
    pass_count,
    derived_reason
  )
  on conflict on constraint student_grammar_stats_workspace_id_student_id_grammar_topic_key
  do update set
    total_minor_issues = excluded.total_minor_issues,
    total_major_issues = excluded.total_major_issues,
    total_correct_after_practice = greatest(
      stats.total_correct_after_practice,
      excluded.total_correct_after_practice
    ),
    weakness_level = excluded.weakness_level,
    practice_unlocked = excluded.practice_unlocked,
    last_seen_at = excluded.last_seen_at,
    updated_at = now(),
    resolution_cycle_id = excluded.resolution_cycle_id,
    resolution_cycle_number = excluded.resolution_cycle_number,
    resolved_through_sequence = excluded.resolved_through_sequence,
    mastery_pass_count = excluded.mastery_pass_count,
    state_reason = excluded.state_reason;
end;
$$;

revoke all on function app_private.sync_practice_topic_stats_internal(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.ensure_practice_cycle_assignment_internal(
  target_cycle_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  previous_assignment public.student_practice_assignments%rowtype;
  selected_practice_test_id uuid;
  new_assignment_id uuid;
  new_state text;
  next_repeat_number integer := 0;
begin
  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.id = target_cycle_id
  for update;

  if selected_cycle.id is null
    or selected_cycle.resolved_at is not null
    or selected_cycle.state = 'locked'
  then
    return null;
  end if;

  if not exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = selected_cycle.workspace_id
      and member.user_id = selected_cycle.student_id
      and member.role = 'student'
  ) then
    return null;
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.resolution_cycle_id = selected_cycle.id
    and assignment.status in ('unlocked', 'in_progress', 'completed')
  order by assignment.assigned_at desc, assignment.id desc
  limit 1
  for update;

  if selected_assignment.id is null then
    select assignment.*
    into selected_assignment
    from public.student_practice_assignments assignment
    where assignment.workspace_id = selected_cycle.workspace_id
      and assignment.student_id = selected_cycle.student_id
      and assignment.grammar_topic_id = selected_cycle.grammar_topic_id
      and assignment.status in ('unlocked', 'in_progress', 'completed')
    order by assignment.assigned_at desc, assignment.id desc
    limit 1
    for update;

    if selected_assignment.id is not null
      and selected_assignment.resolution_cycle_id is null
    then
      update public.student_practice_assignments assignment
      set
        resolution_cycle_id = selected_cycle.id,
        resolution_cycle_number = selected_cycle.cycle_number,
        evidence_cutoff_sequence = selected_cycle.evidence_through_sequence
      where assignment.id = selected_assignment.id
      returning assignment.* into selected_assignment;
    elsif selected_assignment.id is not null
      and selected_assignment.resolution_cycle_id <> selected_cycle.id
    then
      raise exception using
        errcode = '55000',
        message = 'A different practice cycle already has the active assignment.';
    end if;
  end if;

  if selected_assignment.id is null then
    select assignment.*
    into previous_assignment
    from public.student_practice_assignments assignment
    where assignment.workspace_id = selected_cycle.workspace_id
      and assignment.student_id = selected_cycle.student_id
      and assignment.grammar_topic_id = selected_cycle.grammar_topic_id
      and assignment.status in ('passed', 'failed', 'cancelled')
    order by
      coalesce(assignment.completed_at, assignment.updated_at, assignment.assigned_at) desc,
      assignment.id desc
    limit 1;

    select coalesce(max(assignment.repeat_number), -1) + 1
    into next_repeat_number
    from public.student_practice_assignments assignment
    where assignment.workspace_id = selected_cycle.workspace_id
      and assignment.student_id = selected_cycle.student_id
      and assignment.grammar_topic_id = selected_cycle.grammar_topic_id;
    next_repeat_number := greatest(next_repeat_number, selected_cycle.cycle_number - 1, 0);

    selected_practice_test_id := app_private.select_practice_test_for_cycle(
      selected_cycle.workspace_id,
      selected_cycle.student_id,
      selected_cycle.grammar_topic_id
    );

    begin
      insert into public.student_practice_assignments (
        workspace_id,
        student_id,
        grammar_topic_id,
        practice_test_id,
        source,
        status,
        assigned_by,
        previous_assignment_id,
        previous_attempt_id,
        repeat_number,
        adaptive_reason,
        adaptive_status,
        generation_status,
        resolution_cycle_id,
        resolution_cycle_number,
        evidence_cutoff_sequence
      ) values (
        selected_cycle.workspace_id,
        selected_cycle.student_id,
        selected_cycle.grammar_topic_id,
        selected_practice_test_id,
        case when selected_cycle.cycle_number = 1 and previous_assignment.id is null
          then 'weakness_auto'
          else 'adaptive_repeat'
        end,
        'unlocked',
        null,
        previous_assignment.id,
        previous_assignment.latest_attempt_id,
        next_repeat_number,
        case
          when previous_assignment.status = 'failed' then 'failed_previous_worksheet'
          else 'recurring_released_weakness'
        end,
        case when selected_cycle.cycle_number = 1 and previous_assignment.id is null
          then null
          else 'repeat_unlocked'
        end,
        case when selected_practice_test_id is null then 'idle' else 'ready' end,
        selected_cycle.id,
        selected_cycle.cycle_number,
        selected_cycle.evidence_through_sequence
      )
      returning id into new_assignment_id;
    exception
      when unique_violation then
        select assignment.id
        into new_assignment_id
        from public.student_practice_assignments assignment
        where assignment.workspace_id = selected_cycle.workspace_id
          and assignment.student_id = selected_cycle.student_id
          and assignment.grammar_topic_id = selected_cycle.grammar_topic_id
          and assignment.status in ('unlocked', 'in_progress', 'completed')
        order by assignment.assigned_at desc, assignment.id desc
        limit 1;
    end;

    if new_assignment_id is null then
      raise exception using
        errcode = '55000',
        message = 'Practice cycle could not establish an active assignment.';
    end if;

    select assignment.*
    into selected_assignment
    from public.student_practice_assignments assignment
    where assignment.id = new_assignment_id;

    if selected_assignment.resolution_cycle_id is null then
      update public.student_practice_assignments assignment
      set
        resolution_cycle_id = selected_cycle.id,
        resolution_cycle_number = selected_cycle.cycle_number,
        evidence_cutoff_sequence = selected_cycle.evidence_through_sequence
      where assignment.id = selected_assignment.id
      returning assignment.* into selected_assignment;
    end if;

    perform app_private.record_practice_cycle_event(
      selected_cycle.id,
      'assignment_created',
      selected_cycle.state,
      'unlocked',
      selected_assignment.id,
      null,
      jsonb_build_object('source', selected_assignment.source)
    );
  end if;

  new_state := case selected_assignment.status
    when 'in_progress' then 'in_progress'
    when 'completed' then 'in_progress'
    else 'unlocked'
  end;

  update app_private.practice_resolution_cycles cycle
  set
    active_assignment_id = selected_assignment.id,
    evidence_frozen_at = coalesce(cycle.evidence_frozen_at, now()),
    state = new_state,
    state_reason = case new_state
      when 'in_progress' then 'worksheet_in_progress'
      else 'worksheet_ready'
    end
  where cycle.id = selected_cycle.id;

  return selected_assignment.id;
end;
$$;

revoke all on function app_private.ensure_practice_cycle_assignment_internal(uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.reconcile_practice_topic_internal(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_cycle app_private.practice_resolution_cycles%rowtype;
  current_assignment public.student_practice_assignments%rowtype;
  unresolved_start bigint;
  unresolved_through bigint;
  unresolved_minor integer := 0;
  unresolved_major integer := 0;
  resolved_cutoff bigint := 0;
  prior_mastery_passes integer := 0;
  next_cycle_number integer := 1;
  next_state text;
  next_reason text;
begin
  if target_workspace_id is null
    or target_student_id is null
    or target_grammar_topic_id is null
  then
    raise exception using errcode = '22023', message = 'Practice topic context is required.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(':', target_workspace_id, target_student_id, target_grammar_topic_id),
      0
    )
  );

  select
    coalesce(max(cycle.resolved_through_sequence), 0),
    coalesce(max(cycle.mastery_pass_number), 0),
    coalesce(max(cycle.cycle_number), 0) + 1
  into resolved_cutoff, prior_mastery_passes, next_cycle_number
  from app_private.practice_resolution_cycles cycle
  where cycle.workspace_id = target_workspace_id
    and cycle.student_id = target_student_id
    and cycle.grammar_topic_id = target_grammar_topic_id;

  select
    min(evidence.evidence_sequence),
    max(evidence.evidence_sequence),
    coalesce(sum(evidence.minor_issue_count), 0)::integer,
    coalesce(sum(evidence.major_issue_count), 0)::integer
  into unresolved_start, unresolved_through, unresolved_minor, unresolved_major
  from app_private.practice_weakness_evidence evidence
  where evidence.workspace_id = target_workspace_id
    and evidence.student_id = target_student_id
    and evidence.grammar_topic_id = target_grammar_topic_id
    and evidence.evidence_sequence > resolved_cutoff;

  select cycle.*
  into current_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.workspace_id = target_workspace_id
    and cycle.student_id = target_student_id
    and cycle.grammar_topic_id = target_grammar_topic_id
    and cycle.resolved_at is null
  order by cycle.cycle_number desc
  limit 1
  for update;

  if current_cycle.id is null and unresolved_through is not null then
    next_state := case
      when unresolved_major >= 1 or unresolved_minor >= 3 then 'unlocked'
      else 'locked'
    end;
    next_reason := case next_state
      when 'unlocked' then 'weakness_threshold_reached'
      else 'below_unlock_threshold'
    end;

    insert into app_private.practice_resolution_cycles (
      workspace_id,
      student_id,
      grammar_topic_id,
      cycle_number,
      state,
      state_reason,
      evidence_start_sequence,
      evidence_through_sequence,
      minor_issue_count,
      major_issue_count,
      mastery_pass_number
    ) values (
      target_workspace_id,
      target_student_id,
      target_grammar_topic_id,
      next_cycle_number,
      next_state,
      next_reason,
      unresolved_start,
      unresolved_through,
      unresolved_minor,
      unresolved_major,
      prior_mastery_passes
    )
    returning * into current_cycle;

    perform app_private.record_practice_cycle_event(
      current_cycle.id,
      'cycle_opened',
      null,
      current_cycle.state,
      null,
      null,
      jsonb_build_object('cycle_number', current_cycle.cycle_number)
    );
  elsif current_cycle.id is not null and current_cycle.evidence_frozen_at is null then
    next_state := case
      when unresolved_major >= 1 or unresolved_minor >= 3 then 'unlocked'
      else 'locked'
    end;
    next_reason := case next_state
      when 'unlocked' then 'weakness_threshold_reached'
      else 'below_unlock_threshold'
    end;

    if current_cycle.evidence_through_sequence is distinct from unresolved_through
      or current_cycle.minor_issue_count is distinct from unresolved_minor
      or current_cycle.major_issue_count is distinct from unresolved_major
      or current_cycle.state is distinct from next_state
      or current_cycle.state_reason is distinct from next_reason
    then
      update app_private.practice_resolution_cycles cycle
      set
        evidence_start_sequence = coalesce(unresolved_start, cycle.evidence_start_sequence),
        evidence_through_sequence = coalesce(unresolved_through, cycle.evidence_through_sequence),
        minor_issue_count = unresolved_minor,
        major_issue_count = unresolved_major,
        state = next_state,
        state_reason = next_reason
      where cycle.id = current_cycle.id
      returning * into current_cycle;

      perform app_private.record_practice_cycle_event(
        current_cycle.id,
        'evidence_refreshed',
        null,
        current_cycle.state,
        null,
        null,
        jsonb_build_object(
          'minor_issue_count', current_cycle.minor_issue_count,
          'major_issue_count', current_cycle.major_issue_count
        )
      );
    end if;
  end if;

  if current_cycle.id is not null then
    select assignment.*
    into current_assignment
    from public.student_practice_assignments assignment
    where assignment.id = current_cycle.active_assignment_id;

    if current_assignment.id is not null
      and current_assignment.status in ('in_progress', 'completed')
      and current_cycle.state <> 'in_progress'
    then
      update app_private.practice_resolution_cycles cycle
      set state = 'in_progress', state_reason = 'worksheet_in_progress'
      where cycle.id = current_cycle.id
      returning * into current_cycle;
    elsif current_assignment.id is not null
      and current_assignment.status = 'unlocked'
      and current_cycle.state <> 'unlocked'
    then
      update app_private.practice_resolution_cycles cycle
      set state = 'unlocked', state_reason = 'worksheet_ready'
      where cycle.id = current_cycle.id
      returning * into current_cycle;
    end if;

    if current_cycle.state in ('unlocked', 'in_progress') then
      perform app_private.ensure_practice_cycle_assignment_internal(current_cycle.id);
    end if;
  end if;

  perform app_private.sync_practice_topic_stats_internal(
    target_workspace_id,
    target_student_id,
    target_grammar_topic_id
  );

  return current_cycle.id;
end;
$$;

revoke all on function app_private.reconcile_practice_topic_internal(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

-- Backfill only evidence that existed when a historical passing assignment was
-- assigned. Feedback released while that worksheet was in progress remains
-- unresolved and will open a later cycle.
do $$
declare
  topic_context record;
  passed_assignment record;
  previous_cutoff bigint;
  next_cutoff bigint;
  next_start bigint;
  cycle_minor integer;
  cycle_major integer;
  next_cycle_number integer;
  next_mastery_pass integer;
  inserted_cycle_id uuid;
  resolved_state text;
begin
  for topic_context in
    select distinct
      evidence.workspace_id,
      evidence.student_id,
      evidence.grammar_topic_id
    from app_private.practice_weakness_evidence evidence
  loop
    previous_cutoff := 0;
    next_cycle_number := 0;
    next_mastery_pass := 0;

    for passed_assignment in
      select
        assignment.id,
        assignment.latest_attempt_id,
        assignment.assigned_at,
        coalesce(
          assignment.completed_at,
          assignment.updated_at,
          assignment.assigned_at
        ) as completed_at
      from public.student_practice_assignments assignment
      where assignment.workspace_id = topic_context.workspace_id
        and assignment.student_id = topic_context.student_id
        and assignment.grammar_topic_id = topic_context.grammar_topic_id
        and assignment.status = 'passed'
      order by
        coalesce(assignment.completed_at, assignment.updated_at, assignment.assigned_at),
        assignment.id
    loop
      select
        min(evidence.evidence_sequence),
        max(evidence.evidence_sequence),
        coalesce(sum(evidence.minor_issue_count), 0)::integer,
        coalesce(sum(evidence.major_issue_count), 0)::integer
      into next_start, next_cutoff, cycle_minor, cycle_major
      from app_private.practice_weakness_evidence evidence
      where evidence.workspace_id = topic_context.workspace_id
        and evidence.student_id = topic_context.student_id
        and evidence.grammar_topic_id = topic_context.grammar_topic_id
        and evidence.evidence_sequence > previous_cutoff
        and evidence.released_at <= passed_assignment.assigned_at;

      if next_cutoff is null then
        continue;
      end if;

      next_cycle_number := next_cycle_number + 1;
      next_mastery_pass := next_mastery_pass + 1;
      resolved_state := case
        when next_mastery_pass >= 2 then 'mastered'
        else 'improving'
      end;

      insert into app_private.practice_resolution_cycles (
        workspace_id,
        student_id,
        grammar_topic_id,
        cycle_number,
        state,
        state_reason,
        evidence_start_sequence,
        evidence_through_sequence,
        minor_issue_count,
        major_issue_count,
        evidence_frozen_at,
        resolution_assignment_id,
        resolution_attempt_id,
        resolution_outcome,
        resolved_through_sequence,
        mastery_pass_number,
        opened_at,
        resolved_at
      ) values (
        topic_context.workspace_id,
        topic_context.student_id,
        topic_context.grammar_topic_id,
        next_cycle_number,
        resolved_state,
        case resolved_state
          when 'mastered' then 'repeated_resolution_passed'
          else 'first_resolution_passed'
        end,
        next_start,
        next_cutoff,
        cycle_minor,
        cycle_major,
        passed_assignment.assigned_at,
        passed_assignment.id,
        passed_assignment.latest_attempt_id,
        'passed',
        next_cutoff,
        next_mastery_pass,
        passed_assignment.assigned_at,
        passed_assignment.completed_at
      )
      returning id into inserted_cycle_id;

      update public.student_practice_assignments assignment
      set
        resolution_cycle_id = inserted_cycle_id,
        resolution_cycle_number = next_cycle_number,
        evidence_cutoff_sequence = next_cutoff
      where assignment.id = passed_assignment.id;

      perform app_private.record_practice_cycle_event(
        inserted_cycle_id,
        'migration_backfill',
        'in_progress',
        resolved_state,
        passed_assignment.id,
        passed_assignment.latest_attempt_id,
        jsonb_build_object('resolved_through_sequence', next_cutoff)
      );

      previous_cutoff := next_cutoff;
    end loop;
  end loop;
end;
$$;

create or replace function app_private.resolve_practice_cycle_internal(
  target_assignment_id uuid,
  target_attempt_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_assignment public.student_practice_assignments%rowtype;
  selected_attempt public.practice_test_attempts%rowtype;
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  next_mastery_pass integer;
  resolved_state text;
begin
  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if selected_assignment.id is null
    or selected_assignment.resolution_cycle_id is null
  then
    return null;
  end if;

  select attempt.*
  into selected_attempt
  from public.practice_test_attempts attempt
  where attempt.id = target_attempt_id
    and attempt.assignment_id = selected_assignment.id;

  if selected_assignment.status <> 'passed'
    or selected_attempt.id is null
    or selected_attempt.passed is distinct from true
    or selected_assignment.evidence_cutoff_sequence is null
  then
    raise exception using
      errcode = '55000',
      message = 'Only a verified passing attempt can resolve practice evidence.';
  end if;

  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.id = selected_assignment.resolution_cycle_id
  for update;

  if selected_cycle.id is null then
    raise exception using errcode = '55000', message = 'Practice cycle was not found.';
  end if;

  if selected_cycle.resolved_at is not null then
    return selected_cycle.id;
  end if;

  if selected_assignment.evidence_cutoff_sequence <> selected_cycle.evidence_through_sequence
    or selected_assignment.resolution_cycle_number <> selected_cycle.cycle_number
  then
    raise exception using errcode = '55000', message = 'Practice evidence cutoff changed.';
  end if;

  next_mastery_pass := selected_cycle.mastery_pass_number + 1;
  resolved_state := case when next_mastery_pass >= 2 then 'mastered' else 'improving' end;

  update app_private.practice_resolution_cycles cycle
  set
    state = resolved_state,
    state_reason = case resolved_state
      when 'mastered' then 'repeated_resolution_passed'
      else 'first_resolution_passed'
    end,
    active_assignment_id = null,
    evidence_frozen_at = coalesce(cycle.evidence_frozen_at, selected_assignment.assigned_at),
    resolution_assignment_id = selected_assignment.id,
    resolution_attempt_id = selected_attempt.id,
    resolution_outcome = 'passed',
    resolved_through_sequence = selected_assignment.evidence_cutoff_sequence,
    mastery_pass_number = next_mastery_pass,
    resolved_at = coalesce(selected_assignment.completed_at, now())
  where cycle.id = selected_cycle.id;

  perform app_private.record_practice_cycle_event(
    selected_cycle.id,
    'cycle_resolved',
    selected_cycle.state,
    resolved_state,
    selected_assignment.id,
    selected_attempt.id,
    jsonb_build_object(
      'resolved_through_sequence', selected_assignment.evidence_cutoff_sequence,
      'mastery_pass_number', next_mastery_pass
    )
  );

  perform app_private.reconcile_practice_topic_internal(
    selected_assignment.workspace_id,
    selected_assignment.student_id,
    selected_assignment.grammar_topic_id
  );

  return selected_cycle.id;
end;
$$;

revoke all on function app_private.resolve_practice_cycle_internal(uuid, uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.on_practice_assignment_cycle_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  event_type text;
begin
  if new.resolution_cycle_id is null
    or new.status is not distinct from old.status
  then
    return new;
  end if;

  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.id = new.resolution_cycle_id
  for update;

  if selected_cycle.id is null or selected_cycle.resolved_at is not null then
    return new;
  end if;

  if new.status in ('in_progress', 'completed') then
    update app_private.practice_resolution_cycles cycle
    set
      active_assignment_id = new.id,
      state = 'in_progress',
      state_reason = case new.status
        when 'completed' then 'feedback_evaluation_pending'
        else 'worksheet_in_progress'
      end
    where cycle.id = selected_cycle.id;

    perform app_private.record_practice_cycle_event(
      selected_cycle.id,
      'assignment_started',
      selected_cycle.state,
      'in_progress',
      new.id,
      new.latest_attempt_id,
      jsonb_build_object('assignment_status', new.status)
    );
  elsif new.status = 'passed' then
    perform app_private.resolve_practice_cycle_internal(new.id, new.latest_attempt_id);
  elsif new.status in ('failed', 'cancelled') then
    event_type := case new.status
      when 'failed' then 'assignment_failed'
      else 'assignment_cancelled'
    end;

    update app_private.practice_resolution_cycles cycle
    set
      active_assignment_id = null,
      state = 'unlocked',
      state_reason = case new.status
        when 'failed' then 'retry_after_failed_assignment'
        else 'replacement_assignment_required'
      end
    where cycle.id = selected_cycle.id;

    perform app_private.record_practice_cycle_event(
      selected_cycle.id,
      event_type,
      selected_cycle.state,
      'unlocked',
      new.id,
      new.latest_attempt_id,
      '{}'::jsonb
    );

    perform app_private.reconcile_practice_topic_internal(
      new.workspace_id,
      new.student_id,
      new.grammar_topic_id
    );
  end if;

  perform app_private.sync_practice_topic_stats_internal(
    new.workspace_id,
    new.student_id,
    new.grammar_topic_id
  );

  return new;
end;
$$;

revoke all on function app_private.on_practice_assignment_cycle_transition()
from public, anon, authenticated, service_role;

drop trigger if exists student_practice_assignments_cycle_transition
on public.student_practice_assignments;
create trigger student_practice_assignments_cycle_transition
after update of status on public.student_practice_assignments
for each row execute function app_private.on_practice_assignment_cycle_transition();

create or replace function app_private.on_practice_evidence_inserted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.reconcile_practice_topic_internal(
    new.workspace_id,
    new.student_id,
    new.grammar_topic_id
  );
  return new;
end;
$$;

revoke all on function app_private.on_practice_evidence_inserted()
from public, anon, authenticated, service_role;

drop trigger if exists practice_weakness_evidence_reconcile
on app_private.practice_weakness_evidence;
create trigger practice_weakness_evidence_reconcile
after insert on app_private.practice_weakness_evidence
for each row execute function app_private.on_practice_evidence_inserted();

create or replace function app_private.guard_adaptive_stats_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if exists (
    select 1
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = new.workspace_id
      and cycle.student_id = new.student_id
      and cycle.grammar_topic_id = new.grammar_topic_id
  ) then
    perform app_private.reconcile_practice_topic_internal(
      new.workspace_id,
      new.student_id,
      new.grammar_topic_id
    );
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_adaptive_stats_state()
from public, anon, authenticated, service_role;

drop trigger if exists student_grammar_stats_adaptive_state_guard
on public.student_grammar_stats;
create trigger student_grammar_stats_adaptive_state_guard
after insert or update on public.student_grammar_stats
for each row execute function app_private.guard_adaptive_stats_state();

-- Replace the cumulative historical refresher. Only evidence after the latest
-- resolved cutoff contributes to the active weakness state.
create or replace function public.refresh_student_grammar_stats(
  target_workspace_id uuid,
  target_student_id uuid
)
returns table (
  id uuid,
  workspace_id uuid,
  student_id uuid,
  grammar_topic_id uuid,
  grammar_topic_name text,
  grammar_topic_slug text,
  total_minor_issues integer,
  total_major_issues integer,
  total_correct_after_practice integer,
  weakness_level text,
  practice_unlocked boolean,
  last_seen_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  topic_context record;
begin
  if target_workspace_id is null or target_student_id is null then
    raise exception using errcode = '22023', message = 'Workspace and student are required.';
  end if;

  if jwt_role <> 'service_role' then
    if actor_id is null then
      raise exception using errcode = '28000', message = 'Authentication required.';
    end if;

    if actor_id <> target_student_id
      and not public.is_platform_admin()
      and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
    then
      raise exception using errcode = '42501', message = 'Permission denied.';
    end if;
  end if;

  if not exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = target_workspace_id
      and member.user_id = target_student_id
      and member.role = 'student'
  ) then
    raise exception using errcode = '42501', message = 'Student is not a member of this workspace.';
  end if;

  for topic_context in
    select context.grammar_topic_id
    from (
      select evidence.grammar_topic_id
      from app_private.practice_weakness_evidence evidence
      where evidence.workspace_id = target_workspace_id
        and evidence.student_id = target_student_id
      union
      select stats.grammar_topic_id
      from public.student_grammar_stats stats
      where stats.workspace_id = target_workspace_id
        and stats.student_id = target_student_id
      union
      select cycle.grammar_topic_id
      from app_private.practice_resolution_cycles cycle
      where cycle.workspace_id = target_workspace_id
        and cycle.student_id = target_student_id
    ) context
  loop
    perform app_private.reconcile_practice_topic_internal(
      target_workspace_id,
      target_student_id,
      topic_context.grammar_topic_id
    );
  end loop;

  return query
  select
    stats.id,
    stats.workspace_id,
    stats.student_id,
    stats.grammar_topic_id,
    topic.name,
    topic.slug,
    stats.total_minor_issues,
    stats.total_major_issues,
    stats.total_correct_after_practice,
    stats.weakness_level,
    stats.practice_unlocked,
    stats.last_seen_at,
    stats.updated_at
  from public.student_grammar_stats stats
  join public.grammar_topics topic on topic.id = stats.grammar_topic_id
  where stats.workspace_id = target_workspace_id
    and stats.student_id = target_student_id
  order by
    case stats.weakness_level
      when 'unlocked' then 1
      when 'in_progress' then 2
      when 'locked' then 3
      when 'improving' then 4
      else 5
    end,
    stats.total_major_issues desc,
    stats.total_minor_issues desc,
    topic.name;
end;
$$;

revoke all on function public.refresh_student_grammar_stats(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.refresh_student_grammar_stats(uuid, uuid)
to service_role;

create or replace function app_private.ensure_student_practice_assignment_internal(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid
)
returns table (
  assignment_id uuid,
  workspace_id uuid,
  student_id uuid,
  grammar_topic_id uuid,
  grammar_topic_name text,
  grammar_topic_slug text,
  practice_test_id uuid,
  worksheet_title text,
  worksheet_level text,
  worksheet_difficulty text,
  status text,
  source text,
  assigned_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  latest_attempt_id uuid,
  latest_attempt_status text,
  score integer,
  max_score integer,
  score_percent numeric,
  passed boolean,
  question_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_assignment_id uuid;
  selected_state text;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if target_workspace_id is null
    or target_student_id is null
    or target_grammar_topic_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'Workspace, student, and grammar topic are required.';
  end if;

  if caller_id <> target_student_id
    and not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  if not exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = target_workspace_id
      and member.user_id = target_student_id
      and member.role = 'student'
  ) then
    raise exception using errcode = '42501', message = 'Student is not a member of this workspace.';
  end if;

  perform app_private.reconcile_practice_topic_internal(
    target_workspace_id,
    target_student_id,
    target_grammar_topic_id
  );

  select
    assignment.id,
    stats.weakness_level
  into selected_assignment_id, selected_state
  from public.student_grammar_stats stats
  left join lateral (
    select active.id
    from public.student_practice_assignments active
    where active.workspace_id = stats.workspace_id
      and active.student_id = stats.student_id
      and active.grammar_topic_id = stats.grammar_topic_id
      and active.status in ('unlocked', 'in_progress', 'completed')
    order by active.assigned_at desc, active.id desc
    limit 1
  ) assignment on true
  where stats.workspace_id = target_workspace_id
    and stats.student_id = target_student_id
    and stats.grammar_topic_id = target_grammar_topic_id;

  if selected_assignment_id is null then
    if selected_state is null or selected_state = 'locked' then
      raise exception using
        errcode = '42501',
        message = 'Practice is not unlocked for this grammar topic.';
    end if;

    raise exception using
      errcode = '55000',
      message = 'Practice assignment is not available.';
  end if;

  return query
  select *
  from app_private.practice_assignment_summary(selected_assignment_id);
end;
$$;

revoke all on function app_private.ensure_student_practice_assignment_internal(uuid, uuid, uuid)
from public, anon;
grant execute on function app_private.ensure_student_practice_assignment_internal(uuid, uuid, uuid)
to authenticated;

create or replace view api.student_grammar_stats
with (security_invoker = true, security_barrier = true)
as
select
  stats.id,
  stats.workspace_id,
  stats.student_id,
  stats.grammar_topic_id,
  stats.total_minor_issues,
  stats.total_major_issues,
  stats.total_correct_after_practice,
  stats.weakness_level,
  stats.practice_unlocked,
  stats.last_seen_at,
  stats.updated_at,
  stats.resolution_cycle_id,
  stats.resolution_cycle_number,
  stats.resolved_through_sequence,
  stats.mastery_pass_count,
  stats.state_reason
from public.student_grammar_stats stats;

create or replace view api.student_practice_assignments
with (security_invoker = true, security_barrier = true)
as
select
  assignment.id,
  assignment.workspace_id,
  assignment.student_id,
  assignment.grammar_topic_id,
  assignment.practice_test_id,
  assignment.status,
  assignment.source,
  assignment.assigned_by,
  assignment.assigned_at,
  assignment.started_at,
  assignment.completed_at,
  assignment.latest_attempt_id,
  assignment.generation_status,
  assignment.generation_started_at,
  assignment.generation_completed_at,
  case when assignment.generation_error is null then null else 'generation_failed' end
    as generation_error,
  assignment.previous_assignment_id,
  assignment.previous_attempt_id,
  assignment.repeat_number,
  assignment.adaptive_reason,
  assignment.adaptive_status,
  assignment.updated_at,
  assignment.resolution_cycle_id,
  assignment.resolution_cycle_number,
  assignment.evidence_cutoff_sequence
from public.student_practice_assignments assignment;

-- Reconcile the chronological backfill and attach any legacy active assignment
-- to its cycle. This runs before the migration commits, so constraints and
-- derived state become visible atomically.
do $$
declare
  topic_context record;
begin
  for topic_context in
    select distinct
      context.workspace_id,
      context.student_id,
      context.grammar_topic_id
    from (
      select
        evidence.workspace_id,
        evidence.student_id,
        evidence.grammar_topic_id
      from app_private.practice_weakness_evidence evidence
      union
      select
        stats.workspace_id,
        stats.student_id,
        stats.grammar_topic_id
      from public.student_grammar_stats stats
      union
      select
        cycle.workspace_id,
        cycle.student_id,
        cycle.grammar_topic_id
      from app_private.practice_resolution_cycles cycle
    ) context
  loop
    perform app_private.reconcile_practice_topic_internal(
      topic_context.workspace_id,
      topic_context.student_id,
      topic_context.grammar_topic_id
    );
  end loop;
end;
$$;
