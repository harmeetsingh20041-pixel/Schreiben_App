-- Low-CEFR productive-practice gate.
--
-- Canonical grammar topics intentionally use the broad A1_A2 metadata row,
-- while adaptive practice freezes the learner's actual class level on the
-- resolution cycle. Do not therefore infer pedagogical level fit from
-- grammar_topics.level. These thirteen exact topic/worksheet-level contexts
-- were held by the qualified-source launch-bank audit and need
-- either an immutable qualified worksheet-bank release or an explicit,
-- audited teacher opt-in before the ordinary weakness_auto/adaptive_repeat
-- path may create productive practice.

create table app_private.practice_topic_level_assignment_gates (
  grammar_topic_id uuid not null
    references public.grammar_topics(id) on delete restrict,
  worksheet_level text not null check (worksheet_level in ('A1', 'A2', 'B1', 'B2')),
  gate_kind text not null default 'explicit_or_qualified'
    check (gate_kind = 'explicit_or_qualified'),
  reason_code text not null check (reason_code = 'level_fit_approval_required'),
  rationale text not null check (length(btrim(rationale)) between 8 and 500),
  created_at timestamptz not null default now(),
  primary key (grammar_topic_id, worksheet_level)
);

insert into app_private.practice_topic_level_assignment_gates (
  grammar_topic_id,
  worksheet_level,
  reason_code,
  rationale
)
select
  topic.id,
  restricted.worksheet_level,
  'level_fit_approval_required',
  restricted.rationale
from (
  values
    (
      'adjective-endings'::text,
      'A1'::text,
      'A1 adjective-ending productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'future-tense'::text,
      'A1'::text,
      'A1 future-tense productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'genitiv'::text,
      'A1'::text,
      'A1 Genitiv productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'infinitive-zu'::text,
      'A1'::text,
      'A1 infinitive-with-zu productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'konjunktiv'::text,
      'A1'::text,
      'A1 Konjunktiv productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'passive-voice'::text,
      'A1'::text,
      'A1 passive-voice productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'plusquamperfekt'::text,
      'A1'::text,
      'A1 Plusquamperfekt productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'praeteritum'::text,
      'A1'::text,
      'A1 Präteritum productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'reflexive-verbs'::text,
      'A1'::text,
      'A1 reflexive-verb productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'relative-clauses'::text,
      'A1'::text,
      'A1 relative-clause productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'subordinate-clauses'::text,
      'A1'::text,
      'A1 subordinate-clause productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'genitiv'::text,
      'A2'::text,
      'A2 Genitiv productive practice requires explicit or qualified level-fit approval.'::text
    ),
    (
      'plusquamperfekt'::text,
      'A2'::text,
      'A2 Plusquamperfekt productive practice requires explicit or qualified level-fit approval.'::text
    )
) as restricted(topic_slug, worksheet_level, rationale)
join public.grammar_topics topic on topic.slug = restricted.topic_slug
on conflict (grammar_topic_id, worksheet_level) do update
set
  gate_kind = excluded.gate_kind,
  reason_code = excluded.reason_code,
  rationale = excluded.rationale;

do $$
declare
  seeded_gate_count integer;
begin
  select count(*)::integer
  into seeded_gate_count
  from app_private.practice_topic_level_assignment_gates;

  if seeded_gate_count <> 13 then
    raise exception using
      errcode = '55000',
      message = 'practice_level_fit_gate_seed_incomplete';
  end if;
end;
$$;

create table app_private.practice_level_fit_opt_ins (
  cycle_id uuid primary key
    references app_private.practice_resolution_cycles(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  grammar_topic_id uuid not null references public.grammar_topics(id) on delete restrict,
  batch_id uuid not null references public.batches(id) on delete restrict,
  worksheet_level text not null check (worksheet_level in ('A1', 'A2', 'B1', 'B2')),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 8 and 1000),
  created_at timestamptz not null default now()
);

create table app_private.practice_level_fit_reconciliation_failures (
  cycle_id uuid primary key
    references app_private.practice_resolution_cycles(id) on delete cascade,
  failure_count integer not null default 0 check (failure_count between 0 and 5),
  next_retry_at timestamptz not null default now(),
  last_error_code text not null
    check (last_error_code in (
      'practice_level_fit_reconcile_failed',
      'practice_level_fit_reconcile_busy'
    )),
  last_attempt_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Assignment status changes are committed by many independent RPCs. Updating
-- the adaptive cycle synchronously from an AFTER trigger would hold the
-- assignment row before acquiring the topic advisory/cycle locks, which is the
-- inverse of ordinary reconciliation and can deadlock. A tiny content-free
-- outbox makes that transition durable while the recovery worker applies it in
-- the canonical advisory -> cycle -> assignment order.
alter table public.student_practice_assignments
  add column if not exists status_revision bigint not null default 0;

create table app_private.practice_assignment_cycle_transition_jobs (
  id uuid primary key default gen_random_uuid(),
  transition_sequence bigint generated always as identity unique,
  assignment_id uuid not null
    references public.student_practice_assignments(id) on delete restrict,
  status_revision bigint not null check (status_revision > 0),
  -- Deliberately no FK: the AFTER status trigger must never lock the cycle
  -- parent while it already owns the assignment row. The processor validates
  -- the immutable cycle/context snapshot before applying any transition.
  resolution_cycle_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  grammar_topic_id uuid not null
    references public.grammar_topics(id) on delete restrict,
  previous_status text not null,
  target_status text not null,
  -- Likewise avoid an attempt-parent lock in the browser mutation; the
  -- processor locks and validates the attempt snapshot before the assignment.
  latest_attempt_id uuid,
  failure_count integer not null default 0 check (failure_count between 0 and 3),
  next_retry_at timestamptz not null default now(),
  last_error_code text check (
    last_error_code is null
    or last_error_code = 'practice_cycle_transition_failed'
  ),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (assignment_id, status_revision),
  check (previous_status in (
    'unlocked', 'in_progress', 'completed', 'passed', 'failed', 'cancelled'
  )),
  check (target_status in (
    'unlocked', 'in_progress', 'completed', 'passed', 'failed', 'cancelled'
  )),
  check (previous_status <> target_status)
);

create index practice_level_fit_opt_ins_actor_created_idx
on app_private.practice_level_fit_opt_ins (actor_id, created_at desc, cycle_id);

create index practice_cycles_level_fit_gate_idx
on app_private.practice_resolution_cycles (id)
where resolved_at is null
  and state = 'locked'
  and state_reason in (
    'level_fit_approval_required',
    'active_class_context_required'
  );

create index practice_assignment_cycle_transition_jobs_claim_idx
on app_private.practice_assignment_cycle_transition_jobs (
  next_retry_at,
  transition_sequence
)
where processed_at is null and failure_count < 3;

create index practice_assignment_cycle_transition_jobs_topic_order_idx
on app_private.practice_assignment_cycle_transition_jobs (
  workspace_id,
  student_id,
  grammar_topic_id,
  transition_sequence
)
where processed_at is null;

alter table app_private.practice_topic_level_assignment_gates enable row level security;
alter table app_private.practice_level_fit_opt_ins enable row level security;
alter table app_private.practice_level_fit_reconciliation_failures enable row level security;
alter table app_private.practice_assignment_cycle_transition_jobs enable row level security;

revoke all on table app_private.practice_topic_level_assignment_gates
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_level_fit_opt_ins
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_level_fit_reconciliation_failures
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_assignment_cycle_transition_jobs
from public, anon, authenticated, service_role;

create trigger practice_topic_level_assignment_gates_immutable
before update or delete on app_private.practice_topic_level_assignment_gates
for each row execute function app_private.reject_adaptive_history_mutation();

create trigger practice_level_fit_opt_ins_immutable
before update or delete on app_private.practice_level_fit_opt_ins
for each row execute function app_private.reject_adaptive_history_mutation();

create trigger practice_level_fit_reconciliation_failures_set_updated_at
before update on app_private.practice_level_fit_reconciliation_failures
for each row execute function public.set_updated_at();

create trigger practice_assignment_cycle_transition_jobs_set_updated_at
before update on app_private.practice_assignment_cycle_transition_jobs
for each row execute function public.set_updated_at();

create or replace function app_private.practice_topic_level_gate_satisfied(
  target_grammar_topic_id uuid,
  target_worksheet_level text,
  target_cycle_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    not exists (
      select 1
      from app_private.practice_topic_level_assignment_gates gate
      where gate.grammar_topic_id = target_grammar_topic_id
        and gate.worksheet_level = target_worksheet_level
    )
    or (
      target_cycle_id is not null
      and exists (
        select 1
        from app_private.practice_level_fit_opt_ins opt_in
        where opt_in.cycle_id = target_cycle_id
          and opt_in.grammar_topic_id = target_grammar_topic_id
          and opt_in.worksheet_level = target_worksheet_level
      )
    )
    or exists (
      select 1
      from app_private.practice_worksheet_templates template
      join app_private.practice_worksheet_template_revisions revision
        on revision.template_id = template.id
       and revision.state = 'released'
      join app_private.practice_worksheet_template_reviews review
        on review.revision_id = revision.id
       and review.decision = 'approved'
       and review.content_sha256 = revision.content_sha256
       and app_private.worksheet_review_checklist_is_complete(review.checklist)
      join app_private.practice_worksheet_template_releases release
        on release.revision_id = revision.id
       and release.review_id = review.id
       and release.content_sha256 = revision.content_sha256
      join app_private.practice_worksheet_bank_reviewers reviewer
        on reviewer.user_id = review.reviewer_id
       and reviewer.active
       and reviewer.can_certify
       and reviewer.verified_at <= review.reviewed_at
       and (reviewer.expires_at is null or reviewer.expires_at > review.reviewed_at)
      join app_private.practice_worksheet_bank_reviewers releaser
        on releaser.user_id = release.released_by
       and releaser.active
       and releaser.can_release
       and releaser.verified_at <= release.released_at
       and (releaser.expires_at is null or releaser.expires_at > release.released_at)
      where template.grammar_topic_id = target_grammar_topic_id
        and template.level = target_worksheet_level
    ),
    false
  );
$$;

revoke all on function app_private.practice_topic_level_gate_satisfied(
  uuid, text, uuid
)
from public, anon, authenticated, service_role;

create or replace function app_private.practice_class_context_is_active(
  target_workspace_id uuid,
  target_student_id uuid,
  target_batch_id uuid,
  target_worksheet_level text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.workspace_members workspace_membership
    join public.batches batch
      on batch.id = target_batch_id
     and batch.workspace_id = target_workspace_id
     and batch.is_active
    join public.batch_students class_membership
      on class_membership.workspace_id = target_workspace_id
     and class_membership.batch_id = target_batch_id
     and class_membership.student_id = target_student_id
    where workspace_membership.workspace_id = target_workspace_id
      and workspace_membership.user_id = target_student_id
      and workspace_membership.role = 'student'
      and target_worksheet_level in ('A1', 'A2', 'B1', 'B2')
  ), false);
$$;

revoke all on function app_private.practice_class_context_is_active(
  uuid, uuid, uuid, text
)
from public, anon, authenticated, service_role;

create or replace function app_private.lock_active_practice_class_context(
  target_workspace_id uuid,
  target_student_id uuid,
  target_batch_id uuid,
  target_worksheet_level text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  selected_role text;
  selected_class_assignment_id uuid;
  selected_batch_active boolean;
begin
  if target_workspace_id is null
    or target_student_id is null
    or target_batch_id is null
    or target_worksheet_level not in ('A1', 'A2', 'B1', 'B2')
  then
    return false;
  end if;

  -- The mutation order is workspace membership -> batch -> class membership.
  -- FOR SHARE conflicts with offboarding, transfer, role changes and class
  -- deactivation, so the loser must revalidate after the winner commits.
  select membership.role
  into selected_role
  from public.workspace_members membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = target_student_id
  for share;

  if selected_role is distinct from 'student' then
    return false;
  end if;

  select batch.is_active
  into selected_batch_active
  from public.batches batch
  where batch.id = target_batch_id
    and batch.workspace_id = target_workspace_id
  for share;

  if not coalesce(selected_batch_active, false) then
    return false;
  end if;

  select assignment.id
  into selected_class_assignment_id
  from public.batch_students assignment
  where assignment.workspace_id = target_workspace_id
    and assignment.batch_id = target_batch_id
    and assignment.student_id = target_student_id
  for share;

  return selected_class_assignment_id is not null;
end;
$$;

revoke all on function app_private.lock_active_practice_class_context(
  uuid, uuid, uuid, text
)
from public, anon, authenticated, service_role;

create or replace function app_private.practice_cycle_has_active_class_context(
  target_cycle_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      cycle.class_context_version = 1
      and app_private.practice_class_context_is_active(
        cycle.workspace_id,
        cycle.student_id,
        cycle.batch_id,
        cycle.worksheet_level
      )
    from app_private.practice_resolution_cycles cycle
    where cycle.id = target_cycle_id
  ), false);
$$;

revoke all on function app_private.practice_cycle_has_active_class_context(uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.guard_practice_level_fit_opt_in_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
begin
  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.id = new.cycle_id;

  if selected_cycle.id is null
    or new.workspace_id is distinct from selected_cycle.workspace_id
    or new.student_id is distinct from selected_cycle.student_id
    or new.grammar_topic_id is distinct from selected_cycle.grammar_topic_id
    or new.batch_id is distinct from selected_cycle.batch_id
    or new.worksheet_level is distinct from selected_cycle.worksheet_level
  then
    raise exception using
      errcode = '23514',
      message = 'practice_level_fit_opt_in_context_mismatch';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_practice_level_fit_opt_in_context()
from public, anon, authenticated, service_role;

create trigger practice_level_fit_opt_ins_context_guard
before insert on app_private.practice_level_fit_opt_ins
for each row execute function app_private.guard_practice_level_fit_opt_in_context();

create or replace function app_private.guard_practice_cycle_level_fit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- An already-started historical assignment is preserved. Every new cycle
  -- reaches this trigger before an assignment exists, and a cancelled/failed
  -- assignment clears active_assignment_id before trying to unlock again.
  if new.class_context_version = 1
    and new.state = 'unlocked'
    and new.active_assignment_id is null
  then
    if not app_private.lock_active_practice_class_context(
      new.workspace_id,
      new.student_id,
      new.batch_id,
      new.worksheet_level
    ) then
      new.state := 'locked';
      new.state_reason := 'active_class_context_required';
    elsif not app_private.practice_topic_level_gate_satisfied(
      new.grammar_topic_id,
      new.worksheet_level,
      new.id
    ) then
      new.state := 'locked';
      new.state_reason := 'level_fit_approval_required';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_practice_cycle_level_fit()
from public, anon, authenticated, service_role;

drop trigger if exists practice_resolution_cycles_zz_level_fit_gate
on app_private.practice_resolution_cycles;
create trigger practice_resolution_cycles_zz_level_fit_gate
before insert or update of
  state,
  state_reason,
  active_assignment_id,
  grammar_topic_id,
  worksheet_level,
  class_context_version
on app_private.practice_resolution_cycles
for each row execute function app_private.guard_practice_cycle_level_fit();

create or replace function app_private.guard_practice_assignment_level_fit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  entering_automatic_practice boolean;
begin
  entering_automatic_practice := tg_op = 'INSERT'
    or old.source not in ('weakness_auto', 'adaptive_repeat')
    or old.status not in ('unlocked', 'in_progress', 'completed')
    or old.grammar_topic_id is distinct from new.grammar_topic_id
    or old.worksheet_level is distinct from new.worksheet_level
    or old.resolution_cycle_id is distinct from new.resolution_cycle_id;

  if entering_automatic_practice
    and new.source in ('weakness_auto', 'adaptive_repeat')
    and new.status in ('unlocked', 'in_progress', 'completed')
    and new.class_context_version = 1
  then
    if new.resolution_cycle_id is null
      or (
        tg_op = 'INSERT'
        and not app_private.lock_active_practice_class_context(
          new.workspace_id,
          new.student_id,
          new.batch_id,
          new.worksheet_level
        )
      )
      or (
        tg_op = 'UPDATE'
        and not app_private.practice_class_context_is_active(
          new.workspace_id,
          new.student_id,
          new.batch_id,
          new.worksheet_level
        )
      )
    then
      raise exception using
        errcode = '23514',
        message = 'practice_active_class_context_required';
    elsif not app_private.practice_topic_level_gate_satisfied(
      new.grammar_topic_id,
      new.worksheet_level,
      new.resolution_cycle_id
    ) then
      raise exception using
        errcode = '23514',
        message = 'practice_level_fit_approval_required';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_practice_assignment_level_fit()
from public, anon, authenticated, service_role;

drop trigger if exists student_practice_assignments_zz_level_fit_gate
on public.student_practice_assignments;
create trigger student_practice_assignments_zz_level_fit_gate
before insert or update of
  source,
  status,
  grammar_topic_id,
  worksheet_level,
  resolution_cycle_id,
  class_context_version
on public.student_practice_assignments
for each row execute function app_private.guard_practice_assignment_level_fit();

-- Wrap the existing assignment selector so every caller that already owns the
-- topic advisory lock obtains cycle -> class-context locks before it can touch
-- any assignment row. This closes the offboard/transfer inversion without
-- duplicating the mature selection/reuse implementation.
alter function app_private.ensure_practice_cycle_assignment_internal(uuid)
rename to ensure_practice_cycle_assignment_core_internal;

revoke all on function app_private.ensure_practice_cycle_assignment_core_internal(uuid)
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
  selected_assignment_id uuid;
  selected_assignment_status text;
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

  if selected_cycle.class_context_version = 1
    and not app_private.lock_active_practice_class_context(
      selected_cycle.workspace_id,
      selected_cycle.student_id,
      selected_cycle.batch_id,
      selected_cycle.worksheet_level
    )
  then
    update app_private.practice_resolution_cycles cycle
    set
      state = 'locked',
      state_reason = 'active_class_context_required',
      active_assignment_id = null
    where cycle.id = selected_cycle.id;
    return null;
  end if;

  selected_assignment_id :=
    app_private.ensure_practice_cycle_assignment_core_internal(
      selected_cycle.id
    );

  if selected_assignment_id is not null then
    select assignment.status
    into selected_assignment_status
    from public.student_practice_assignments assignment
    where assignment.id = selected_assignment_id;

    if selected_assignment_status = 'completed' then
      update app_private.practice_resolution_cycles cycle
      set
        state = 'in_progress',
        state_reason = 'feedback_evaluation_pending'
      where cycle.id = selected_cycle.id
        and cycle.resolved_at is null;
    end if;
  end if;

  return selected_assignment_id;
end;
$$;

revoke all on function app_private.ensure_practice_cycle_assignment_internal(uuid)
from public, anon, authenticated, service_role;

create or replace function public.opt_in_restricted_practice_internal(
  target_cycle_id uuid,
  opt_in_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  calling_actor_id uuid := (select auth.uid());
  clean_reason text := nullif(
    regexp_replace(btrim(opt_in_reason), '[[:space:]]+', ' ', 'g'),
    ''
  );
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  selected_assignment_id uuid;
  selected_state text;
  actor_workspace_role text;
begin
  if calling_actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_cycle_id is null
    or clean_reason is null
    or length(clean_reason) not between 8 and 1000
  then
    raise exception using errcode = '22023', message = 'invalid_level_fit_opt_in';
  end if;

  -- Authorize before taking any row/advisory lock. Unauthorized and missing
  -- UUIDs intentionally share one response so this RPC cannot be used as a
  -- cross-workspace cycle-existence oracle.
  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.id = target_cycle_id
    and (
      public.is_platform_admin()
      or public.has_workspace_role(
        cycle.workspace_id,
        array['owner', 'teacher']
      )
    );

  if selected_cycle.id is null then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  -- Match reconciliation's advisory -> cycle -> class-context lock order.
  perform pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(
        ':',
        selected_cycle.workspace_id,
        selected_cycle.student_id,
        selected_cycle.grammar_topic_id
      ),
      0
    )
  );

  select cycle.*
  into selected_cycle
  from app_private.practice_resolution_cycles cycle
  where cycle.id = target_cycle_id
    and (
      public.is_platform_admin()
      or public.has_workspace_role(
        cycle.workspace_id,
        array['owner', 'teacher']
      )
    )
  for update;

  if selected_cycle.id is null then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if not public.is_platform_admin() then
    select membership.role
    into actor_workspace_role
    from public.workspace_members membership
    where membership.workspace_id = selected_cycle.workspace_id
      and membership.user_id = calling_actor_id
    for share;

    if actor_workspace_role is null
      or actor_workspace_role not in ('owner', 'teacher')
    then
      raise exception using errcode = '42501', message = 'permission_denied';
    end if;
  end if;

  if not app_private.lock_active_practice_class_context(
    selected_cycle.workspace_id,
    selected_cycle.student_id,
    selected_cycle.batch_id,
    selected_cycle.worksheet_level
  ) then
    raise exception using
      errcode = '42501',
      message = 'active_class_membership_required';
  end if;

  -- A client may lose the first successful response. Preserve one immutable
  -- decision and return its existing assignment instead of treating a safe
  -- retry as a second approval attempt.
  if exists (
    select 1
    from app_private.practice_level_fit_opt_ins opt_in
    where opt_in.cycle_id = selected_cycle.id
      and (
        opt_in.actor_id is distinct from calling_actor_id
        or opt_in.reason is distinct from clean_reason
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'level_fit_opt_in_conflict';
  elsif exists (
    select 1
    from app_private.practice_level_fit_opt_ins opt_in
    where opt_in.cycle_id = selected_cycle.id
      and opt_in.actor_id = calling_actor_id
      and opt_in.reason = clean_reason
  ) then
    select cycle.active_assignment_id, cycle.state
    into selected_assignment_id, selected_state
    from app_private.practice_resolution_cycles cycle
    where cycle.id = selected_cycle.id
      and cycle.resolved_at is null
      and cycle.state in ('unlocked', 'in_progress');

    if selected_assignment_id is null then
      perform app_private.reconcile_practice_topic_internal(
        selected_cycle.workspace_id,
        selected_cycle.student_id,
        selected_cycle.grammar_topic_id
      );

      select cycle.active_assignment_id, cycle.state
      into selected_assignment_id, selected_state
      from app_private.practice_resolution_cycles cycle
      where cycle.id = selected_cycle.id
        and cycle.resolved_at is null
        and cycle.state in ('unlocked', 'in_progress');
    end if;

    if selected_assignment_id is null then
      raise exception using errcode = '55000', message = 'level_fit_opt_in_failed';
    end if;

    return jsonb_build_object(
      'schema_version', 1,
      'cycle_id', selected_cycle.id,
      'assignment_id', selected_assignment_id,
      'state', selected_state,
      'approval_source', 'teacher_opt_in'
    );
  end if;

  if selected_cycle.resolved_at is not null
    or selected_cycle.class_context_version <> 1
    or selected_cycle.batch_id is null
    or selected_cycle.worksheet_level is null
    or selected_cycle.state <> 'locked'
    or selected_cycle.state_reason <> 'level_fit_approval_required'
    or selected_cycle.active_assignment_id is not null
    or not (
      selected_cycle.major_issue_count >= 1
      or selected_cycle.minor_issue_count >= 3
    )
    or not exists (
      select 1
      from app_private.practice_topic_level_assignment_gates gate
      where gate.grammar_topic_id = selected_cycle.grammar_topic_id
        and gate.worksheet_level = selected_cycle.worksheet_level
    )
  then
    raise exception using errcode = '55000', message = 'level_fit_opt_in_not_available';
  end if;

  insert into app_private.practice_level_fit_opt_ins (
    cycle_id,
    workspace_id,
    student_id,
    grammar_topic_id,
    batch_id,
    worksheet_level,
    actor_id,
    reason
  ) values (
    selected_cycle.id,
    selected_cycle.workspace_id,
    selected_cycle.student_id,
    selected_cycle.grammar_topic_id,
    selected_cycle.batch_id,
    selected_cycle.worksheet_level,
    calling_actor_id,
    clean_reason
  )
  on conflict (cycle_id) do nothing;

  perform app_private.reconcile_practice_topic_internal(
    selected_cycle.workspace_id,
    selected_cycle.student_id,
    selected_cycle.grammar_topic_id
  );

  select cycle.active_assignment_id, cycle.state
  into selected_assignment_id, selected_state
  from app_private.practice_resolution_cycles cycle
  where cycle.id = selected_cycle.id
    and cycle.resolved_at is null
    and cycle.state in ('unlocked', 'in_progress');

  if selected_assignment_id is null then
    raise exception using errcode = '55000', message = 'level_fit_opt_in_failed';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'cycle_id', selected_cycle.id,
    'assignment_id', selected_assignment_id,
    'state', selected_state,
    'approval_source', 'teacher_opt_in'
  );
end;
$$;

revoke all on function public.opt_in_restricted_practice_internal(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.opt_in_restricted_practice_internal(uuid, text)
to authenticated;

create or replace function api.opt_in_restricted_practice(
  target_cycle_id uuid,
  opt_in_reason text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.opt_in_restricted_practice_internal(
    target_cycle_id,
    opt_in_reason
  );
$$;

revoke all on function api.opt_in_restricted_practice(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function api.opt_in_restricted_practice(uuid, text)
to authenticated;

create or replace function app_private.reconcile_eligible_level_fit_cycles(
  max_cycles integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cycle record;
  clean_limit integer := least(greatest(coalesce(max_cycles, 25), 0), 25);
  attempted_count integer := 0;
  succeeded_count integer := 0;
  failed_count integer := 0;
  deferred_count integer := 0;
  exhausted_count integer := 0;
  stored_state text;
  stored_reason text;
  stored_assignment_id uuid;
begin
  if clean_limit = 0 then
    return jsonb_build_object(
      'schema_version', 1,
      'attempted', 0,
      'succeeded', 0,
      'failed', 0,
      'deferred', 0,
      'exhausted', 0
    );
  end if;

  -- Release stays O(1): the independent recovery tick discovers only the
  -- bounded set of still-locked cycles whose qualified evidence now exists.
  -- Each learner context is isolated in its own exception block, so one stale
  -- or corrupt cycle can never roll back a global worksheet-bank release.
  for selected_cycle in
    select
      cycle.id,
      cycle.workspace_id,
      cycle.student_id,
      cycle.grammar_topic_id,
      cycle.batch_id,
      cycle.worksheet_level,
      cycle.state_reason
    from app_private.practice_resolution_cycles cycle
    left join app_private.practice_level_fit_reconciliation_failures failure
      on failure.cycle_id = cycle.id
    where cycle.resolved_at is null
      and cycle.state = 'locked'
      and cycle.state_reason in (
        'level_fit_approval_required',
        'active_class_context_required'
      )
      and app_private.practice_cycle_has_active_class_context(cycle.id)
      and (
        cycle.state_reason = 'active_class_context_required'
        or app_private.practice_topic_level_gate_satisfied(
          cycle.grammar_topic_id,
          cycle.worksheet_level,
          cycle.id
        )
      )
      and coalesce(failure.failure_count, 0) < 5
      and coalesce(failure.next_retry_at, now()) <= now()
    order by cycle.id
    limit clean_limit * 4
  loop
    exit when attempted_count >= clean_limit;

    -- Reconciliation owns this exact advisory key before it ever locks the
    -- cycle row. A busy learner is deferred without waiting or inverting the
    -- lock order used by evidence ingestion and the teacher opt-in RPC.
    if not pg_try_advisory_xact_lock(
      hashtextextended(
        concat_ws(
          ':',
          selected_cycle.workspace_id,
          selected_cycle.student_id,
          selected_cycle.grammar_topic_id
        ),
        0
      )
    ) then
      insert into app_private.practice_level_fit_reconciliation_failures (
        cycle_id,
        failure_count,
        next_retry_at,
        last_error_code,
        last_attempt_at
      ) values (
        selected_cycle.id,
        0,
        now() + interval '5 seconds',
        'practice_level_fit_reconcile_busy',
        now()
      )
      on conflict (cycle_id) do update
      set
        next_retry_at = greatest(
          app_private.practice_level_fit_reconciliation_failures.next_retry_at,
          now() + interval '5 seconds'
        ),
        last_error_code = 'practice_level_fit_reconcile_busy',
        last_attempt_at = now();
      deferred_count := deferred_count + 1;
      continue;
    end if;

    attempted_count := attempted_count + 1;
    begin
      perform 1
      from app_private.practice_resolution_cycles cycle
      where cycle.id = selected_cycle.id
        and cycle.resolved_at is null
        and cycle.state = 'locked'
        and cycle.state_reason in (
          'level_fit_approval_required',
          'active_class_context_required'
        )
      for update;

      if not found then
        delete from app_private.practice_level_fit_reconciliation_failures failure
        where failure.cycle_id = selected_cycle.id;
        succeeded_count := succeeded_count + 1;
        continue;
      end if;

      if not app_private.lock_active_practice_class_context(
        selected_cycle.workspace_id,
        selected_cycle.student_id,
        selected_cycle.batch_id,
        selected_cycle.worksheet_level
      ) then
        raise exception using
          errcode = '55000',
          message = 'practice_level_fit_reconcile_context_changed';
      end if;

      -- Frozen cycles are not reopened by the base evidence reconciler. Ask
      -- the gate to normalize the exact locked cycle under the canonical lock
      -- chain, then attach one assignment only if it really becomes unlocked.
      update app_private.practice_resolution_cycles cycle
      set
        state = 'unlocked',
        state_reason = 'weakness_threshold_reached'
      where cycle.id = selected_cycle.id
        and cycle.resolved_at is null
        and cycle.active_assignment_id is null
        and cycle.state = 'locked'
      returning cycle.state, cycle.state_reason, cycle.active_assignment_id
      into stored_state, stored_reason, stored_assignment_id;

      if stored_state = 'unlocked' then
        stored_assignment_id :=
          app_private.ensure_practice_cycle_assignment_internal(selected_cycle.id);
      end if;

      perform app_private.sync_practice_topic_stats_internal(
        selected_cycle.workspace_id,
        selected_cycle.student_id,
        selected_cycle.grammar_topic_id
      );

      select cycle.state, cycle.state_reason, cycle.active_assignment_id
      into stored_state, stored_reason, stored_assignment_id
      from app_private.practice_resolution_cycles cycle
      where cycle.id = selected_cycle.id
        and cycle.resolved_at is null;

      if not (
        stored_state in ('unlocked', 'in_progress')
        and stored_assignment_id is not null
      ) and not (
        selected_cycle.state_reason = 'active_class_context_required'
        and stored_state = 'locked'
        and stored_reason = 'level_fit_approval_required'
        and stored_assignment_id is null
      ) then
        raise exception using
          errcode = '55000',
          message = 'practice_level_fit_reconcile_incomplete';
      end if;

      delete from app_private.practice_level_fit_reconciliation_failures failure
      where failure.cycle_id = selected_cycle.id;
      succeeded_count := succeeded_count + 1;
    exception when others then
      insert into app_private.practice_level_fit_reconciliation_failures (
        cycle_id,
        failure_count,
        next_retry_at,
        last_error_code,
        last_attempt_at
      ) values (
        selected_cycle.id,
        1,
        now() + interval '30 seconds',
        'practice_level_fit_reconcile_failed',
        now()
      )
      on conflict (cycle_id) do update
      set
        failure_count = least(
          5,
          app_private.practice_level_fit_reconciliation_failures.failure_count + 1
        ),
        next_retry_at = now() + (
          interval '30 seconds' * power(
            2,
            least(
              5,
              app_private.practice_level_fit_reconciliation_failures.failure_count
            )
          )
        ),
        last_error_code = 'practice_level_fit_reconcile_failed',
        last_attempt_at = now();
      failed_count := failed_count + 1;
    end;
  end loop;

  select count(*)::integer
  into exhausted_count
  from app_private.practice_level_fit_reconciliation_failures failure
  join app_private.practice_resolution_cycles cycle
    on cycle.id = failure.cycle_id
   and cycle.resolved_at is null
   and cycle.state = 'locked'
   and cycle.state_reason in (
     'level_fit_approval_required',
     'active_class_context_required'
   )
  where failure.failure_count >= 5
    and app_private.practice_cycle_has_active_class_context(cycle.id)
    and (
      cycle.state_reason = 'active_class_context_required'
      or app_private.practice_topic_level_gate_satisfied(
        cycle.grammar_topic_id,
        cycle.worksheet_level,
        cycle.id
      )
    );

  return jsonb_build_object(
    'schema_version', 1,
    'attempted', attempted_count,
    'succeeded', succeeded_count,
    'failed', failed_count,
    'deferred', deferred_count,
    'exhausted', exhausted_count
  );
end;
$$;

revoke all on function app_private.reconcile_eligible_level_fit_cycles(integer)
from public, anon, authenticated, service_role;
grant execute on function app_private.reconcile_eligible_level_fit_cycles(integer)
to service_role;

create or replace function api.reconcile_eligible_level_fit_cycles(
  max_cycles integer default 25
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select app_private.reconcile_eligible_level_fit_cycles(max_cycles);
$$;

revoke all on function api.reconcile_eligible_level_fit_cycles(integer)
from public, anon, authenticated, service_role;
grant execute on function api.reconcile_eligible_level_fit_cycles(integer)
to service_role;

create or replace function app_private.reset_level_fit_reconciliation_failure(
  target_cycle_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer := 0;
begin
  if target_cycle_id is null then
    return false;
  end if;

  delete from app_private.practice_level_fit_reconciliation_failures failure
  where failure.cycle_id = target_cycle_id;
  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

revoke all on function app_private.reset_level_fit_reconciliation_failure(uuid)
from public, anon, authenticated, service_role;
grant execute on function app_private.reset_level_fit_reconciliation_failure(uuid)
to service_role;

create or replace function api.reset_level_fit_reconciliation_failure(
  target_cycle_id uuid
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select app_private.reset_level_fit_reconciliation_failure(target_cycle_id);
$$;

revoke all on function api.reset_level_fit_reconciliation_failure(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.reset_level_fit_reconciliation_failure(uuid)
to service_role;

create or replace function app_private.set_practice_assignment_status_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status_revision := 0;
  elsif new.status is distinct from old.status then
    new.status_revision := old.status_revision + 1;
  else
    new.status_revision := old.status_revision;
  end if;
  return new;
end;
$$;

revoke all on function app_private.set_practice_assignment_status_revision()
from public, anon, authenticated, service_role;

drop trigger if exists student_practice_assignments_status_revision
on public.student_practice_assignments;
create trigger student_practice_assignments_status_revision
before insert or update of status, status_revision
on public.student_practice_assignments
for each row execute function app_private.set_practice_assignment_status_revision();

-- The trigger is intentionally append-only and lock-free beyond the assignment
-- row PostgreSQL already owns. Cycle work is performed by the service recovery
-- processor after commit, never synchronously in a browser mutation.
create or replace function app_private.on_practice_assignment_cycle_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.resolution_cycle_id is not null
    and new.status is distinct from old.status
  then
    insert into app_private.practice_assignment_cycle_transition_jobs (
      assignment_id,
      status_revision,
      resolution_cycle_id,
      workspace_id,
      student_id,
      grammar_topic_id,
      previous_status,
      target_status,
      latest_attempt_id
    ) values (
      new.id,
      new.status_revision,
      new.resolution_cycle_id,
      new.workspace_id,
      new.student_id,
      new.grammar_topic_id,
      old.status,
      new.status,
      new.latest_attempt_id
    )
    on conflict (assignment_id, status_revision) do nothing;
  end if;

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

create or replace function app_private.process_practice_cycle_transition_jobs(
  max_jobs integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job record;
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
  selected_attempt public.practice_test_attempts%rowtype;
  clean_limit integer := least(greatest(coalesce(max_jobs, 50), 0), 50);
  attempted_count integer := 0;
  succeeded_count integer := 0;
  failed_count integer := 0;
  deferred_count integer := 0;
  exhausted_count integer := 0;
  stale_exhausted_count integer := 0;
  failed_assignment_count integer := 0;
  max_failed_assignments integer := 3;
  next_state text;
  next_reason text;
  stored_state text;
  stored_reason text;
  next_mastery_pass integer;
  resolved_state text;
begin
  if clean_limit = 0 then
    return jsonb_build_object(
      'schema_version', 1,
      'attempted', 0,
      'succeeded', 0,
      'failed', 0,
      'deferred', 0,
      'exhausted', 0
    );
  end if;

  -- A terminally exhausted row is a manual-review barrier only while it still
  -- describes the assignment's current revision. Once a later status revision
  -- has committed, the old row is provably superseded and must not permanently
  -- block the authoritative tail. This settlement has no cycle or statistics
  -- side effects; it only closes immutable stale delivery history.
  with stale_exhausted as (
    select job.id
    from app_private.practice_assignment_cycle_transition_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.assignment_id
     and assignment.workspace_id = job.workspace_id
     and assignment.student_id = job.student_id
     and assignment.grammar_topic_id = job.grammar_topic_id
    where job.processed_at is null
      and job.failure_count >= 3
      and assignment.status_revision > job.status_revision
    order by job.transition_sequence
    limit clean_limit
    for update of job skip locked
  )
  update app_private.practice_assignment_cycle_transition_jobs job
  set processed_at = now(), last_error_code = null
  from stale_exhausted stale
  where job.id = stale.id;
  get diagnostics stale_exhausted_count = row_count;
  attempted_count := stale_exhausted_count;
  succeeded_count := stale_exhausted_count;

  for selected_job in
    select job.*
    from app_private.practice_assignment_cycle_transition_jobs job
    where job.processed_at is null
      and job.failure_count < 3
      and job.next_retry_at <= now()
      and not exists (
        select 1
        from app_private.practice_assignment_cycle_transition_jobs earlier
        where earlier.workspace_id = job.workspace_id
          and earlier.student_id = job.student_id
          and earlier.grammar_topic_id = job.grammar_topic_id
          and earlier.processed_at is null
          and earlier.transition_sequence < job.transition_sequence
      )
    order by job.transition_sequence
    limit clean_limit * 4
    for update skip locked
  loop
    exit when attempted_count >= clean_limit;

    if not pg_try_advisory_xact_lock(
      hashtextextended(
        concat_ws(
          ':',
          selected_job.workspace_id,
          selected_job.student_id,
          selected_job.grammar_topic_id
        ),
        0
      )
    ) then
      update app_private.practice_assignment_cycle_transition_jobs job
      set next_retry_at = greatest(job.next_retry_at, now() + interval '5 seconds')
      where job.id = selected_job.id;
      deferred_count := deferred_count + 1;
      continue;
    end if;

    attempted_count := attempted_count + 1;
    begin
      select cycle.*
      into selected_cycle
      from app_private.practice_resolution_cycles cycle
      where cycle.id = selected_job.resolution_cycle_id
      for update;

      if selected_cycle.id is null
        or selected_cycle.workspace_id is distinct from selected_job.workspace_id
        or selected_cycle.student_id is distinct from selected_job.student_id
        or selected_cycle.grammar_topic_id is distinct from selected_job.grammar_topic_id
      then
        raise exception using
          errcode = '55000',
          message = 'practice_cycle_transition_context_invalid';
      end if;

      if selected_cycle.resolved_at is not null then
        update app_private.practice_assignment_cycle_transition_jobs job
        set processed_at = now(), last_error_code = null
        where job.id = selected_job.id;
        succeeded_count := succeeded_count + 1;
        continue;
      end if;

      if selected_cycle.class_context_version = 1 then
        -- The result may be false after offboarding. Existing started/history
        -- transitions still settle; only replacement creation requires true.
        perform app_private.lock_active_practice_class_context(
          selected_cycle.workspace_id,
          selected_cycle.student_id,
          selected_cycle.batch_id,
          selected_cycle.worksheet_level
        );
      end if;

      select assignment.*
      into selected_assignment
      from public.student_practice_assignments assignment
      where assignment.id = selected_job.assignment_id
      for update;

      if selected_assignment.id is null
        or selected_assignment.resolution_cycle_id is distinct from selected_cycle.id
        or selected_assignment.workspace_id is distinct from selected_job.workspace_id
        or selected_assignment.student_id is distinct from selected_job.student_id
        or selected_assignment.grammar_topic_id is distinct from selected_job.grammar_topic_id
        or selected_assignment.status_revision < selected_job.status_revision
      then
        raise exception using
          errcode = '55000',
          message = 'practice_cycle_transition_assignment_invalid';
      end if;

      -- Only the revision that still matches the locked assignment may change
      -- adaptive state. Older durable rows remain immutable audit history but
      -- are superseded by a later status committed before recovery. Replaying
      -- their side effects could create a replacement before a pass, or let a
      -- mutable override poison and barrier the true final transition.
      if selected_assignment.status_revision > selected_job.status_revision then
        update app_private.practice_assignment_cycle_transition_jobs job
        set processed_at = now(), last_error_code = null
        where job.id = selected_job.id;
        succeeded_count := succeeded_count + 1;
        continue;
      end if;

      if selected_assignment.status is distinct from selected_job.target_status then
        raise exception using
          errcode = '55000',
          message = 'practice_cycle_transition_revision_mismatch';
      end if;

      if selected_job.target_status in ('in_progress', 'completed') then
        update app_private.practice_resolution_cycles cycle
        set
          active_assignment_id = selected_assignment.id,
          state = 'in_progress',
          state_reason = case selected_job.target_status
            when 'completed' then 'feedback_evaluation_pending'
            else 'worksheet_in_progress'
          end
        where cycle.id = selected_cycle.id;

        perform app_private.record_practice_cycle_event(
          selected_cycle.id,
          'assignment_started',
          selected_cycle.state,
          'in_progress',
          selected_assignment.id,
          selected_job.latest_attempt_id,
          jsonb_build_object(
            'assignment_status', selected_job.target_status,
            'status_revision', selected_job.status_revision
          )
        );
      elsif selected_job.target_status = 'passed' then
        selected_attempt := null;
        if selected_job.latest_attempt_id is not null then
          -- The attempt was committed before this durable transition became
          -- visible. A plain snapshot read avoids introducing an
          -- assignment/attempt lock inversion with both completion paths.
          select attempt.*
          into selected_attempt
          from public.practice_test_attempts attempt
          where attempt.id = selected_job.latest_attempt_id;
        end if;

        if selected_attempt.id is null
          or selected_attempt.assignment_id is distinct from selected_assignment.id
          or selected_attempt.passed is distinct from true
          or selected_assignment.evidence_cutoff_sequence is null
          or selected_assignment.evidence_cutoff_sequence
            is distinct from selected_cycle.evidence_through_sequence
          or selected_assignment.resolution_cycle_number
            is distinct from selected_cycle.cycle_number
        then
          raise exception using
            errcode = '55000',
            message = 'practice_cycle_transition_pass_invalid';
        end if;

        next_mastery_pass := selected_cycle.mastery_pass_number + 1;
        resolved_state := case
          when next_mastery_pass >= 2 then 'mastered'
          else 'improving'
        end;

        update app_private.practice_resolution_cycles cycle
        set
          state = resolved_state,
          state_reason = case resolved_state
            when 'mastered' then 'repeated_resolution_passed'
            else 'first_resolution_passed'
          end,
          active_assignment_id = null,
          evidence_frozen_at = coalesce(
            cycle.evidence_frozen_at,
            selected_assignment.assigned_at
          ),
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
            'resolved_through_sequence',
            selected_assignment.evidence_cutoff_sequence,
            'mastery_pass_number', next_mastery_pass,
            'status_revision', selected_job.status_revision
          )
        );

        perform app_private.reconcile_practice_topic_internal(
          selected_job.workspace_id,
          selected_job.student_id,
          selected_job.grammar_topic_id
        );
      elsif selected_job.target_status in ('failed', 'cancelled') then
        if selected_job.target_status = 'failed' then
          select limits.max_failed_assignments_per_resolution_cycle
          into max_failed_assignments
          from app_private.ai_paid_work_limits limits
          where limits.singleton;

          select count(*)::integer
          into failed_assignment_count
          from public.student_practice_assignments assignment
          where assignment.resolution_cycle_id = selected_cycle.id
            and assignment.status = 'failed';
        else
          failed_assignment_count := 0;
        end if;

        next_state := case
          when selected_job.target_status = 'failed'
            and failed_assignment_count >= coalesce(max_failed_assignments, 3)
          then 'locked'
          else 'unlocked'
        end;
        next_reason := case
          when next_state = 'locked' then 'teacher_support_required'
          when selected_job.target_status = 'failed'
          then 'retry_after_failed_assignment'
          else 'replacement_assignment_required'
        end;

        update app_private.practice_resolution_cycles cycle
        set
          active_assignment_id = null,
          state = next_state,
          state_reason = next_reason
        where cycle.id = selected_cycle.id
        returning cycle.state, cycle.state_reason
        into stored_state, stored_reason;

        perform app_private.record_practice_cycle_event(
          selected_cycle.id,
          case selected_job.target_status
            when 'failed' then 'assignment_failed'
            else 'assignment_cancelled'
          end,
          selected_cycle.state,
          stored_state,
          selected_assignment.id,
          selected_job.latest_attempt_id,
          jsonb_build_object(
            'failed_assignment_count', failed_assignment_count,
            'teacher_support_required',
              stored_reason = 'teacher_support_required',
            'stored_state_reason', stored_reason,
            'status_revision', selected_job.status_revision
          )
        );

        if stored_state = 'unlocked'
          and app_private.practice_cycle_has_active_class_context(selected_cycle.id)
        then
          perform app_private.reconcile_practice_topic_internal(
            selected_job.workspace_id,
            selected_job.student_id,
            selected_job.grammar_topic_id
          );
        end if;
      end if;

      perform app_private.sync_practice_topic_stats_internal(
        selected_job.workspace_id,
        selected_job.student_id,
        selected_job.grammar_topic_id
      );

      update app_private.practice_assignment_cycle_transition_jobs job
      set
        processed_at = now(),
        last_error_code = null
      where job.id = selected_job.id;
      succeeded_count := succeeded_count + 1;
    exception when others then
      update app_private.practice_assignment_cycle_transition_jobs job
      set
        failure_count = least(3, job.failure_count + 1),
        next_retry_at = now() + case
          when job.failure_count = 0 then interval '15 seconds'
          else interval '60 seconds'
        end,
        last_error_code = 'practice_cycle_transition_failed'
      where job.id = selected_job.id;
      failed_count := failed_count + 1;
    end;
  end loop;

  select count(*)::integer
  into exhausted_count
  from app_private.practice_assignment_cycle_transition_jobs job
  join app_private.practice_resolution_cycles cycle
    on cycle.id = job.resolution_cycle_id
   and cycle.resolved_at is null
  where job.processed_at is null
    and job.failure_count >= 3;

  return jsonb_build_object(
    'schema_version', 1,
    'attempted', attempted_count,
    'succeeded', succeeded_count,
    'failed', failed_count,
    'deferred', deferred_count,
    'exhausted', exhausted_count
  );
end;
$$;

revoke all on function app_private.process_practice_cycle_transition_jobs(integer)
from public, anon, authenticated, service_role;
grant execute on function app_private.process_practice_cycle_transition_jobs(integer)
to service_role;

create or replace function api.process_practice_cycle_transition_jobs(
  max_jobs integer default 50
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select app_private.process_practice_cycle_transition_jobs(max_jobs);
$$;

revoke all on function api.process_practice_cycle_transition_jobs(integer)
from public, anon, authenticated, service_role;
grant execute on function api.process_practice_cycle_transition_jobs(integer)
to service_role;

-- A teacher may correct the terminal score of a third failed assignment after
-- its resolution cycle has already entered teacher-support lock. The durable
-- transition worker must be able to apply that authoritative pass without
-- weakening the ordinary locked-cycle state machine. Permit the locked ->
-- improving/mastered transition only when the row is atomically closed with
-- the complete, internally validated pass-resolution shape.
create or replace function app_private.guard_practice_resolution_cycle_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  valid_locked_pass_resolution boolean := false;
begin
  if old.workspace_id <> new.workspace_id
    or old.student_id <> new.student_id
    or old.grammar_topic_id <> new.grammar_topic_id
    or old.cycle_number <> new.cycle_number
    or old.evidence_start_sequence <> new.evidence_start_sequence
  then
    raise exception using errcode = '55000', message = 'Practice cycle identity is immutable.';
  end if;

  if old.class_context_version = 1 and (
    new.class_context_version <> old.class_context_version
    or new.class_context_integrity is distinct from old.class_context_integrity
    or new.batch_id is distinct from old.batch_id
    or new.worksheet_level is distinct from old.worksheet_level
  ) then
    raise exception using errcode = '55000', message = 'Practice cycle class context is immutable.';
  end if;

  if old.class_context_version = 0 and new.class_context_version = 1 then
    if new.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
      or new.batch_id is null
      or new.worksheet_level is null
      or new.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
    then
      raise exception using errcode = '22023', message = 'Practice cycle class context is invalid.';
    end if;
  elsif new.class_context_version <> old.class_context_version then
    raise exception using errcode = '55000', message = 'Practice cycle class context transition is invalid.';
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

  valid_locked_pass_resolution :=
    old.state = 'locked'
    and new.state in ('improving', 'mastered')
    and new.resolved_at is not null
    and new.resolution_outcome = 'passed'
    and new.resolution_assignment_id is not null
    and new.resolution_attempt_id is not null
    and new.resolved_through_sequence is not null
    and new.resolved_through_sequence = new.evidence_through_sequence
    and new.active_assignment_id is null
    and new.evidence_frozen_at is not null
    and new.mastery_pass_number = old.mastery_pass_number + 1
    and new.state = case
      when new.mastery_pass_number >= 2 then 'mastered'
      else 'improving'
    end
    and new.state_reason = case
      when new.mastery_pass_number >= 2 then 'repeated_resolution_passed'
      else 'first_resolution_passed'
    end;

  if old.state = 'locked'
    and new.state not in ('locked', 'unlocked')
    and not valid_locked_pass_resolution
  then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  elsif old.state = 'unlocked'
    and new.state not in ('locked', 'unlocked', 'in_progress', 'improving', 'mastered')
  then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  elsif old.state = 'in_progress'
    and new.state not in ('locked', 'in_progress', 'unlocked', 'improving', 'mastered')
  then
    raise exception using errcode = '55000', message = 'Invalid practice cycle transition.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function app_private.guard_practice_resolution_cycle_update()
from public, anon, authenticated, service_role;

create or replace function app_private.reset_practice_cycle_transition_job(
  target_job_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  reset_count integer := 0;
begin
  if target_job_id is null then
    return false;
  end if;

  update app_private.practice_assignment_cycle_transition_jobs job
  set
    failure_count = 0,
    next_retry_at = now(),
    last_error_code = null
  where job.id = target_job_id
    and job.processed_at is null;
  get diagnostics reset_count = row_count;
  return reset_count > 0;
end;
$$;

revoke all on function app_private.reset_practice_cycle_transition_job(uuid)
from public, anon, authenticated, service_role;
grant execute on function app_private.reset_practice_cycle_transition_job(uuid)
to service_role;

create or replace function api.reset_practice_cycle_transition_job(
  target_job_id uuid
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select app_private.reset_practice_cycle_transition_job(target_job_id);
$$;

revoke all on function api.reset_practice_cycle_transition_job(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.reset_practice_cycle_transition_job(uuid)
to service_role;

create or replace function app_private.cancel_untouched_practice_class_assignments(
  target_workspace_id uuid,
  target_student_id uuid,
  target_batch_id uuid,
  safe_error_code text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_job record;
  cancelled_count integer := 0;
  clean_error_code text := case safe_error_code
    when 'class_membership_removed' then safe_error_code
    when 'class_inactive' then safe_error_code
    else 'class_context_inactive'
  end;
begin
  for selected_job in
    select job.id, job.queue_name, job.queue_message_id
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.job_kind = 'worksheet_generation'
      and job.status in ('queued', 'retry', 'processing')
      and assignment.workspace_id = target_workspace_id
      and assignment.student_id = target_student_id
      and assignment.batch_id = target_batch_id
      and assignment.source in ('weakness_auto', 'adaptive_repeat')
      and assignment.status = 'unlocked'
      and assignment.started_at is null
      and assignment.latest_attempt_id is null
    order by job.id
    for update of job
  loop
    if selected_job.queue_message_id is not null then
      perform pgmq.archive(
        selected_job.queue_name,
        selected_job.queue_message_id
      );
    end if;

    update app_private.async_jobs job
    set
      status = 'dead',
      worker_id = null,
      lease_expires_at = null,
      dead_at = now(),
      last_error_code = clean_error_code
    where job.id = selected_job.id;
  end loop;

  update public.student_practice_assignments assignment
  set
    status = 'cancelled',
    completed_at = coalesce(assignment.completed_at, now()),
    generation_status = case
      when assignment.generation_status in ('queued', 'generating')
      then 'failed'
      else assignment.generation_status
    end,
    generation_completed_at = case
      when assignment.generation_status in ('queued', 'generating')
      then now()
      else assignment.generation_completed_at
    end,
    generation_error = case
      when assignment.generation_status in ('queued', 'generating')
      then clean_error_code
      else assignment.generation_error
    end
  where assignment.workspace_id = target_workspace_id
    and assignment.student_id = target_student_id
    and assignment.batch_id = target_batch_id
    and assignment.class_context_version = 1
    and assignment.source in ('weakness_auto', 'adaptive_repeat')
    and assignment.status = 'unlocked'
    and assignment.started_at is null
    and assignment.latest_attempt_id is null;
  get diagnostics cancelled_count = row_count;
  return cancelled_count;
end;
$$;

revoke all on function app_private.cancel_untouched_practice_class_assignments(
  uuid, uuid, uuid, text
)
from public, anon, authenticated, service_role;

create or replace function app_private.on_practice_class_membership_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.cancel_untouched_practice_class_assignments(
    old.workspace_id,
    old.student_id,
    old.batch_id,
    'class_membership_removed'
  );
  return old;
end;
$$;

revoke all on function app_private.on_practice_class_membership_deleted()
from public, anon, authenticated, service_role;

drop trigger if exists batch_students_cancel_untouched_practice
on public.batch_students;
create trigger batch_students_cancel_untouched_practice
after delete on public.batch_students
for each row execute function app_private.on_practice_class_membership_deleted();

create or replace function app_private.on_practice_batch_activity_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_student record;
begin
  if old.is_active and not new.is_active then
    for selected_student in
      select distinct assignment.student_id
      from public.student_practice_assignments assignment
      where assignment.workspace_id = new.workspace_id
        and assignment.batch_id = new.id
        and assignment.class_context_version = 1
        and assignment.source in ('weakness_auto', 'adaptive_repeat')
        and assignment.status = 'unlocked'
        and assignment.started_at is null
        and assignment.latest_attempt_id is null
      order by assignment.student_id
    loop
      perform app_private.cancel_untouched_practice_class_assignments(
        new.workspace_id,
        selected_student.student_id,
        new.id,
        'class_inactive'
      );
    end loop;
  elsif not old.is_active and new.is_active then
    delete from app_private.practice_level_fit_reconciliation_failures failure
    using app_private.practice_resolution_cycles cycle
    where failure.cycle_id = cycle.id
      and cycle.workspace_id = new.workspace_id
      and cycle.batch_id = new.id
      and cycle.resolved_at is null
      and cycle.state = 'locked'
      and cycle.state_reason = 'active_class_context_required';
  end if;
  return new;
end;
$$;

revoke all on function app_private.on_practice_batch_activity_changed()
from public, anon, authenticated, service_role;

drop trigger if exists batches_reconcile_practice_activity
on public.batches;
create trigger batches_reconcile_practice_activity
after update of is_active on public.batches
for each row
when (old.is_active is distinct from new.is_active)
execute function app_private.on_practice_batch_activity_changed();

create or replace function app_private.on_practice_class_membership_inserted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from app_private.practice_level_fit_reconciliation_failures failure
  using app_private.practice_resolution_cycles cycle
  where failure.cycle_id = cycle.id
    and cycle.workspace_id = new.workspace_id
    and cycle.student_id = new.student_id
    and cycle.batch_id = new.batch_id
    and cycle.resolved_at is null
    and cycle.state = 'locked'
    and cycle.state_reason = 'active_class_context_required';
  return new;
end;
$$;

revoke all on function app_private.on_practice_class_membership_inserted()
from public, anon, authenticated, service_role;

drop trigger if exists batch_students_reset_practice_recovery
on public.batch_students;
create trigger batch_students_reset_practice_recovery
after insert on public.batch_students
for each row execute function app_private.on_practice_class_membership_inserted();

-- Class transfer previously locked the source batch_students row before the
-- learner's workspace membership, the reverse of the class-context gate. A
-- small wrapper serializes transfer at the membership row before the mature
-- atomic transfer implementation touches either class.
alter function public.transfer_student_class_internal(uuid, uuid, uuid, uuid)
rename to transfer_student_class_core_internal;

revoke all on function public.transfer_student_class_core_internal(
  uuid, uuid, uuid, uuid
)
from public, anon, authenticated, service_role;

create or replace function public.transfer_student_class_internal(
  target_workspace_id uuid,
  target_student_id uuid,
  source_assignment_id uuid,
  target_batch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_role text;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_workspace_id is null
    or target_student_id is null
    or source_assignment_id is null
    or target_batch_id is null
  then
    raise exception using errcode = '22023', message = 'class_transfer_context_required';
  end if;
  if not public.is_platform_admin()
    and not public.has_workspace_role(
      target_workspace_id,
      array['owner', 'teacher']
    )
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select membership.role
  into selected_role
  from public.workspace_members membership
  where membership.workspace_id = target_workspace_id
    and membership.user_id = target_student_id
  for update;

  if selected_role is distinct from 'student' then
    raise exception using
      errcode = '55000',
      message = 'active_student_membership_required';
  end if;

  return public.transfer_student_class_core_internal(
    target_workspace_id,
    target_student_id,
    source_assignment_id,
    target_batch_id
  );
end;
$$;

revoke all on function public.transfer_student_class_internal(
  uuid, uuid, uuid, uuid
)
from public, anon, authenticated, service_role;
grant execute on function public.transfer_student_class_internal(
  uuid, uuid, uuid, uuid
)
to authenticated;

create or replace function api.transfer_student_class(
  target_workspace_id uuid,
  target_student_id uuid,
  source_assignment_id uuid,
  target_batch_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.transfer_student_class_internal(
    target_workspace_id,
    target_student_id,
    source_assignment_id,
    target_batch_id
  );
$$;

revoke all on function api.transfer_student_class(uuid, uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function api.transfer_student_class(uuid, uuid, uuid, uuid)
to authenticated;

-- Safely withdraw only untouched automatic assignments that predate this
-- policy. Started or completed work remains immutable historical evidence.
update public.student_practice_assignments assignment
set
  status = 'cancelled',
  completed_at = coalesce(assignment.completed_at, now())
where assignment.source in ('weakness_auto', 'adaptive_repeat')
  and assignment.status = 'unlocked'
  and assignment.started_at is null
  and assignment.latest_attempt_id is null
  and assignment.class_context_version = 1
  and (
    not app_private.practice_class_context_is_active(
      assignment.workspace_id,
      assignment.student_id,
      assignment.batch_id,
      assignment.worksheet_level
    )
    or (
      exists (
        select 1
        from app_private.practice_topic_level_assignment_gates gate
        where gate.grammar_topic_id = assignment.grammar_topic_id
          and gate.worksheet_level = assignment.worksheet_level
      )
      and not app_private.practice_topic_level_gate_satisfied(
        assignment.grammar_topic_id,
        assignment.worksheet_level,
        assignment.resolution_cycle_id
      )
    )
  );

-- Fire the central gate for any pre-existing eligible cycle that did not yet
-- own an assignment, then refresh its derived student-facing state.
update app_private.practice_resolution_cycles cycle
set state = cycle.state
where cycle.resolved_at is null
  and cycle.state = 'unlocked'
  and cycle.active_assignment_id is null
  and cycle.class_context_version = 1
  and (
    not app_private.practice_cycle_has_active_class_context(cycle.id)
    or not app_private.practice_topic_level_gate_satisfied(
      cycle.grammar_topic_id,
      cycle.worksheet_level,
      cycle.id
    )
  );

do $$
declare
  selected_cycle record;
begin
  for selected_cycle in
    select cycle.workspace_id, cycle.student_id, cycle.grammar_topic_id
    from app_private.practice_resolution_cycles cycle
    where cycle.resolved_at is null
      and cycle.state = 'locked'
      and cycle.state_reason in (
        'level_fit_approval_required',
        'active_class_context_required'
      )
    order by cycle.id
  loop
    perform app_private.sync_practice_topic_stats_internal(
      selected_cycle.workspace_id,
      selected_cycle.student_id,
      selected_cycle.grammar_topic_id
    );
  end loop;
end;
$$;

comment on table app_private.practice_topic_level_assignment_gates is
  'Migration-owned exact topic and frozen CEFR contexts that cannot enter automatic productive practice without explicit teacher opt-in or an immutable qualified worksheet-bank level-fit release.';
comment on table app_private.practice_level_fit_opt_ins is
  'Immutable per-cycle teacher decisions allowing a restricted low-CEFR productive-practice assignment.';
comment on table app_private.practice_level_fit_reconciliation_failures is
  'Private bounded retry/backoff state for isolated level-fit cycle reconciliation; no student content or raw database errors are stored.';
comment on table app_private.practice_assignment_cycle_transition_jobs is
  'Private content-free durable outbox for assignment status transitions. Recovery applies each transition in monotonic topic order without holding browser mutations on cycle locks.';
comment on function api.opt_in_restricted_practice(uuid, text) is
  'Teacher-only audited opt-in for one threshold-qualified restricted practice cycle.';
comment on function api.reconcile_eligible_level_fit_cycles(integer) is
  'Service-only bounded recovery sweep. It reconciles eligible active class contexts independently so a bad learner cycle cannot roll back worksheet-bank release.';
comment on function api.process_practice_cycle_transition_jobs(integer) is
  'Service-only bounded transition outbox processor using advisory, cycle, class-context, then assignment lock order with three attempts and safe backoff.';

notify pgrst, 'reload schema';
