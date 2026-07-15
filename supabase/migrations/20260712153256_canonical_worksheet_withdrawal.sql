-- Canonical worksheet withdrawal and supersession.
--
-- A released bank revision is immutable, but launch operations still need a
-- safe way to stop assigning it if a qualified reviewer later finds a defect.
-- This migration adds one immutable, hash/revision-bound withdrawal record,
-- transitions the canonical revision from released to superseded, and keeps
-- every historical workspace clone and attempt intact. New selectors and the
-- central assignment guard exclude both the superseded revision and all of
-- its already-created workspace clones from future reuse.

create table app_private.practice_worksheet_template_withdrawals (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null unique,
  template_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  release_id uuid not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  withdrawn_by uuid not null
    references app_private.practice_worksheet_bank_reviewers(user_id)
    on delete restrict,
  reason text not null check (
    reason = btrim(reason)
    and length(reason) between 12 and 1000
  ),
  withdrawn_at timestamptz not null default now(),
  foreign key (revision_id, template_id)
    references app_private.practice_worksheet_template_revisions(id, template_id)
    on delete restrict,
  foreign key (release_id, revision_id)
    references app_private.practice_worksheet_template_releases(id, revision_id)
    on delete restrict
);

create index practice_worksheet_withdrawals_actor_time_idx
on app_private.practice_worksheet_template_withdrawals (
  withdrawn_by,
  withdrawn_at desc,
  id
);

alter table app_private.practice_worksheet_template_withdrawals
enable row level security;

revoke all on table app_private.practice_worksheet_template_withdrawals
from public, anon, authenticated, service_role;

create trigger practice_worksheet_template_withdrawals_immutable
before update or delete
on app_private.practice_worksheet_template_withdrawals
for each row execute function app_private.reject_worksheet_bank_history_mutation();

create or replace function app_private.guard_worksheet_template_withdrawal_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actual_content_hash text;
begin
  if current_setting('app.worksheet_bank_withdrawal_insert', true)
    is distinct from 'on'
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_operation_required';
  end if;

  actual_content_hash :=
    app_private.practice_worksheet_template_revision_sha256(new.revision_id);

  if new.reason is distinct from btrim(new.reason)
    or length(new.reason) not between 12 and 1000
    or actual_content_hash is null
    or new.content_sha256 is distinct from actual_content_hash
    or not exists (
      select 1
      from app_private.practice_worksheet_template_revisions revision
      where revision.id = new.revision_id
        and revision.template_id = new.template_id
        and revision.revision_number = new.revision_number
        and revision.state = 'released'
        and revision.content_sha256 = actual_content_hash
    )
    or not exists (
      select 1
      from app_private.practice_worksheet_template_releases release
      where release.id = new.release_id
        and release.revision_id = new.revision_id
        and release.content_sha256 = actual_content_hash
    )
    or not exists (
      select 1
      from app_private.practice_worksheet_bank_reviewers actor
      where actor.user_id = new.withdrawn_by
        and actor.active
        and actor.can_release
        and actor.verified_at <= now()
        and (actor.expires_at is null or actor.expires_at > now())
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_attestation_invalid';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_template_withdrawal_insert()
from public, anon, authenticated, service_role;

create trigger practice_worksheet_template_withdrawals_00_guard_insert
before insert
on app_private.practice_worksheet_template_withdrawals
for each row execute function app_private.guard_worksheet_template_withdrawal_insert();

-- Tighten the original revision guard as part of the protected withdrawal
-- boundary. A missing custom setting is SQL NULL, so `<> 'on'` would not enter
-- an IF branch; `IS DISTINCT FROM` makes the capability check fail closed.
-- Supersession additionally requires the exact audit row to exist first.
create or replace function app_private.guard_worksheet_template_revision_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_revision_immutable';
  end if;

  if new.id is distinct from old.id
    or new.template_id is distinct from old.template_id
    or new.revision_number is distinct from old.revision_number
    or new.difficulty is distinct from old.difficulty
    or new.title is distinct from old.title
    or new.description is distinct from old.description
    or new.mini_lesson is distinct from old.mini_lesson
    or new.source_label is distinct from old.source_label
    or new.tags is distinct from old.tags
    or new.import_payload_sha256 is distinct from old.import_payload_sha256
    or new.content_sha256 is distinct from old.content_sha256
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_revision_immutable';
  end if;

  if new.state is distinct from old.state then
    if current_setting('app.worksheet_bank_state_transition', true)
      is distinct from 'on'
      or (old.state, new.state) not in (
        ('draft', 'certified'),
        ('draft', 'rejected'),
        ('certified', 'released'),
        ('released', 'superseded')
      )
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_bank_state_transition_invalid';
    end if;

    if old.state = 'released'
      and new.state = 'superseded'
      and not exists (
        select 1
        from app_private.practice_worksheet_template_withdrawals withdrawal
        where withdrawal.revision_id = old.id
          and withdrawal.template_id = old.template_id
          and withdrawal.revision_number = old.revision_number
          and withdrawal.content_sha256 = old.content_sha256
      )
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_bank_withdrawal_attestation_required';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_worksheet_template_revision_mutation()
from public, anon, authenticated, service_role;

create or replace function app_private.withdraw_released_worksheet_template(
  target_revision_id uuid,
  expected_revision_number integer,
  expected_content_sha256 text,
  target_actor_id uuid,
  withdrawal_reason text
)
returns table (
  withdrawal_id uuid,
  revision_id uuid,
  revision_number integer,
  content_sha256 text,
  withdrawn_by uuid,
  withdrawn_at timestamptz,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_revision app_private.practice_worksheet_template_revisions%rowtype;
  selected_release app_private.practice_worksheet_template_releases%rowtype;
  selected_withdrawal app_private.practice_worksheet_template_withdrawals%rowtype;
  actual_content_hash text;
  clean_reason text := nullif(btrim(withdrawal_reason), '');
begin
  if target_revision_id is null
    or expected_revision_number is null
    or expected_revision_number < 1
    or expected_content_sha256 is null
    or expected_content_sha256 !~ '^[a-f0-9]{64}$'
    or target_actor_id is null
    or clean_reason is null
    or length(clean_reason) not between 12 and 1000
  then
    raise exception using
      errcode = '22023',
      message = 'worksheet_bank_withdrawal_invalid';
  end if;

  select revision.*
  into selected_revision
  from app_private.practice_worksheet_template_revisions revision
  where revision.id = target_revision_id
  for update;

  if selected_revision.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'worksheet_bank_revision_not_found';
  end if;

  actual_content_hash :=
    app_private.practice_worksheet_template_revision_sha256(selected_revision.id);

  select withdrawal.*
  into selected_withdrawal
  from app_private.practice_worksheet_template_withdrawals withdrawal
  where withdrawal.revision_id = selected_revision.id;

  -- An exact replay is safe after a client loses the first response. Any
  -- changed actor, reason, revision, release, or hash is a conflicting action.
  if selected_withdrawal.id is not null then
    if selected_revision.state <> 'superseded'
      or selected_withdrawal.template_id <> selected_revision.template_id
      or selected_withdrawal.revision_number <> expected_revision_number
      or selected_withdrawal.revision_number <> selected_revision.revision_number
      or selected_withdrawal.content_sha256 <> expected_content_sha256
      or selected_withdrawal.content_sha256 <> selected_revision.content_sha256
      or selected_withdrawal.content_sha256 is distinct from actual_content_hash
      or selected_withdrawal.withdrawn_by <> target_actor_id
      or selected_withdrawal.reason <> clean_reason
    then
      raise exception using
        errcode = '55000',
        message = 'worksheet_bank_withdrawal_replay_mismatch';
    end if;

    return query select
      selected_withdrawal.id,
      selected_withdrawal.revision_id,
      selected_withdrawal.revision_number,
      selected_withdrawal.content_sha256,
      selected_withdrawal.withdrawn_by,
      selected_withdrawal.withdrawn_at,
      false;
    return;
  end if;

  if selected_revision.state <> 'released' then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_revision_not_released';
  end if;

  if selected_revision.revision_number <> expected_revision_number
    or selected_revision.content_sha256 <> expected_content_sha256
  then
    raise exception using
      errcode = '40001',
      message = 'worksheet_bank_withdrawal_binding_mismatch';
  end if;

  if actual_content_hash is null
    or actual_content_hash is distinct from selected_revision.content_sha256
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_hash_mismatch';
  end if;

  select release.*
  into selected_release
  from app_private.practice_worksheet_template_releases release
  where release.revision_id = selected_revision.id
    and release.content_sha256 = selected_revision.content_sha256
  for share;

  if selected_release.id is null then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_release_invalid';
  end if;

  perform 1
  from app_private.practice_worksheet_bank_reviewers actor
  where actor.user_id = target_actor_id
    and actor.active
    and actor.can_release
    and actor.verified_at <= now()
    and (actor.expires_at is null or actor.expires_at > now())
  for share;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'worksheet_bank_withdrawal_actor_not_qualified';
  end if;

  perform set_config('app.worksheet_bank_withdrawal_insert', 'on', true);
  insert into app_private.practice_worksheet_template_withdrawals (
    revision_id,
    template_id,
    revision_number,
    release_id,
    content_sha256,
    withdrawn_by,
    reason
  ) values (
    selected_revision.id,
    selected_revision.template_id,
    selected_revision.revision_number,
    selected_release.id,
    selected_revision.content_sha256,
    target_actor_id,
    clean_reason
  )
  returning * into selected_withdrawal;

  perform set_config('app.worksheet_bank_state_transition', 'on', true);
  update app_private.practice_worksheet_template_revisions revision
  set state = 'superseded'
  where revision.id = selected_revision.id
    and revision.state = 'released';

  if not found then
    raise exception using
      errcode = '55000',
      message = 'worksheet_bank_withdrawal_state_conflict';
  end if;

  perform set_config('app.worksheet_bank_state_transition', 'off', true);
  perform set_config('app.worksheet_bank_withdrawal_insert', 'off', true);

  return query select
    selected_withdrawal.id,
    selected_withdrawal.revision_id,
    selected_withdrawal.revision_number,
    selected_withdrawal.content_sha256,
    selected_withdrawal.withdrawn_by,
    selected_withdrawal.withdrawn_at,
    true;
end;
$$;

revoke all on function app_private.withdraw_released_worksheet_template(
  uuid, integer, text, uuid, text
)
from public, anon, authenticated, service_role;

comment on function app_private.withdraw_released_worksheet_template(
  uuid, integer, text, uuid, text
) is
  'Postgres-only, retry-safe canonical worksheet withdrawal. It requires an active qualified releaser plus the exact immutable revision number and content SHA-256, records one immutable reason/actor attestation, and transitions released to superseded.';

-- Ordinary workspace worksheets remain reusable. A certified clone remains
-- reusable only while its exact canonical revision is still released and has
-- no withdrawal record, and while its release/hash bindings still agree.
create or replace function app_private.practice_test_canonical_revision_is_current(
  target_practice_test_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      test.worksheet_template_revision_id is null
      or exists (
        select 1
        from app_private.practice_worksheet_template_revisions revision
        join app_private.practice_worksheet_template_reviews review
          on review.revision_id = revision.id
         and review.decision = 'approved'
         and review.content_sha256 = revision.content_sha256
        join app_private.practice_worksheet_template_releases release
          on release.id = test.worksheet_template_release_id
         and release.revision_id = revision.id
         and release.review_id = review.id
         and release.content_sha256 = revision.content_sha256
        join app_private.practice_worksheet_bank_reviewers reviewer
          on reviewer.user_id = review.reviewer_id
         and reviewer.active
         and reviewer.can_certify
         and reviewer.verified_at <= review.reviewed_at
         and (
           reviewer.expires_at is null
           or reviewer.expires_at > review.reviewed_at
         )
        join app_private.practice_worksheet_bank_reviewers releaser
          on releaser.user_id = release.released_by
         and releaser.active
         and releaser.can_release
         and releaser.verified_at <= release.released_at
         and (
           releaser.expires_at is null
           or releaser.expires_at > release.released_at
         )
        where revision.id = test.worksheet_template_revision_id
          and revision.state = 'released'
          and revision.content_sha256 = test.template_content_sha256
          and not exists (
            select 1
            from app_private.practice_worksheet_template_withdrawals withdrawal
            where withdrawal.revision_id = revision.id
          )
      )
    from public.practice_tests test
    where test.id = target_practice_test_id
  ), false);
$$;

revoke all on function app_private.practice_test_canonical_revision_is_current(uuid)
from public, anon, authenticated, service_role;

-- Service workers need only this content-free boolean bridge while assembling
-- a generation context; no canonical bank row or withdrawal reason is exposed.
create or replace function public.practice_test_canonical_revision_is_current_internal(
  target_practice_test_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.practice_test_canonical_revision_is_current(
    target_practice_test_id
  );
$$;

revoke all on function public.practice_test_canonical_revision_is_current_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.practice_test_canonical_revision_is_current_internal(uuid)
to service_role;

comment on function public.practice_test_canonical_revision_is_current_internal(uuid)
is
  'Service-only content-free predicate. False excludes a withdrawn or superseded canonical workspace clone from every future generation reuse decision.';

-- Only an unlocked assignment with no start, draft, or attempt is safe to
-- detach lazily. Completed and genuinely in-progress evidence remains bound to
-- the historical clone for review and audit.
create or replace function app_private.practice_assignment_has_withdrawn_unstarted_clone(
  target_assignment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      assignment.status = 'unlocked'
      and assignment.started_at is null
      and assignment.latest_attempt_id is null
      and assignment.practice_test_id is not null
      and not app_private.practice_test_canonical_revision_is_current(
        assignment.practice_test_id
      )
      and exists (
        select 1
        from public.practice_tests worksheet
        where worksheet.id = assignment.practice_test_id
          and worksheet.worksheet_template_revision_id is not null
      )
      and not exists (
        select 1
        from app_private.practice_drafts draft
        where draft.assignment_id = assignment.id
      )
      and not exists (
        select 1
        from public.practice_test_attempts attempt
        where attempt.assignment_id = assignment.id
      )
    from public.student_practice_assignments assignment
    where assignment.id = target_assignment_id
  ), false);
$$;

revoke all on function
  app_private.practice_assignment_has_withdrawn_unstarted_clone(uuid)
from public, anon, authenticated, service_role;

create or replace function
  public.practice_assignment_has_withdrawn_unstarted_clone_internal(
    target_assignment_id uuid
  )
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.practice_assignment_has_withdrawn_unstarted_clone(
    target_assignment_id
  );
$$;

revoke all on function
  public.practice_assignment_has_withdrawn_unstarted_clone_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.practice_assignment_has_withdrawn_unstarted_clone_internal(uuid)
to service_role;

-- Prevent every future attachment path (worker completion, teacher action, or
-- direct privileged mutation) from reusing a withdrawn clone. Existing
-- assignment references remain untouched so historical attempts are retained.
create or replace function app_private.guard_withdrawn_canonical_practice_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_revision_id uuid;
  selected_revision_state text;
begin
  if new.practice_test_id is not null
    and (tg_op = 'INSERT' or new.practice_test_id is distinct from old.practice_test_id)
  then
    select test.worksheet_template_revision_id
    into selected_revision_id
    from public.practice_tests test
    where test.id = new.practice_test_id;

    if selected_revision_id is not null then
      -- Serialize a future attachment against withdrawal's FOR UPDATE lock.
      -- Whichever transaction obtains the revision lock first defines the
      -- boundary; an attachment waiting behind withdrawal sees superseded.
      select revision.state
      into selected_revision_state
      from app_private.practice_worksheet_template_revisions revision
      where revision.id = selected_revision_id
      for share;

      if selected_revision_state is distinct from 'released'
        or not app_private.practice_test_canonical_revision_is_current(
          new.practice_test_id
        )
      then
        raise exception using
          errcode = '55000',
          message = 'withdrawn_canonical_worksheet_not_reusable';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_withdrawn_canonical_practice_assignment()
from public, anon, authenticated, service_role;

create trigger student_practice_assignments_00_guard_withdrawn_template
before insert or update of practice_test_id
on public.student_practice_assignments
for each row execute function app_private.guard_withdrawn_canonical_practice_assignment();

-- A direct attempt insert is a final fail-closed boundary. It blocks only an
-- unstarted assignment; completed and already-started evidence is preserved.
create or replace function app_private.guard_withdrawn_canonical_practice_attempt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_revision_id uuid;
  selected_revision_state text;
begin
  select worksheet.worksheet_template_revision_id
  into selected_revision_id
  from public.practice_tests worksheet
  where worksheet.id = new.practice_test_id;

  if selected_revision_id is not null then
    select revision.state
    into selected_revision_state
    from app_private.practice_worksheet_template_revisions revision
    where revision.id = selected_revision_id
    for share;

    if selected_revision_state is distinct from 'released'
      or not app_private.practice_test_canonical_revision_is_current(
        new.practice_test_id
      )
    then
      -- A genuinely in-progress assignment may finish its preserved draft.
      -- A null assignment, a merely unlocked assignment, or a mismatched
      -- student/workspace/test binding cannot create a new withdrawn attempt.
      if new.assignment_id is null
        or not exists (
          select 1
          from public.student_practice_assignments assignment
          join app_private.practice_drafts draft
            on draft.assignment_id = assignment.id
           and draft.student_id = assignment.student_id
           and draft.workspace_id = assignment.workspace_id
          where assignment.id = new.assignment_id
            and assignment.practice_test_id = new.practice_test_id
            and assignment.student_id = new.student_id
            and assignment.workspace_id = new.workspace_id
            and assignment.status = 'in_progress'
            and assignment.started_at is not null
        )
      then
        raise exception using
          errcode = '55000',
          message = 'worksheet_withdrawn_replacement_required';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_withdrawn_canonical_practice_attempt()
from public, anon, authenticated, service_role;

create trigger practice_test_attempts_00_guard_withdrawn_template
before insert
on public.practice_test_attempts
for each row execute function app_private.guard_withdrawn_canonical_practice_attempt();

-- Preserve the mature summary implementation behind a wrapper. Students see
-- an unstarted withdrawn attachment as worksheet-less and ready to request a
-- replacement; managers retain the exact historical provenance for support.
alter function public.get_practice_assignment_summary_internal(uuid)
rename to get_practice_assignment_summary_internal_before_phase_13e;

revoke all on function
  public.get_practice_assignment_summary_internal_before_phase_13e(uuid)
from public, anon, authenticated, service_role;

create function public.get_practice_assignment_summary_internal(
  target_assignment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  selected_assignment public.student_practice_assignments%rowtype;
  payload jsonb;
begin
  payload := public.get_practice_assignment_summary_internal_before_phase_13e(
    target_assignment_id
  );

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id;

  if actor_id = selected_assignment.student_id
    and app_private.practice_assignment_has_withdrawn_unstarted_clone(
      selected_assignment.id
    )
  then
    payload := payload || jsonb_build_object(
      'practice_test_id', null,
      'worksheet_title', null,
      'worksheet_difficulty', null,
      'worksheet_mini_lesson', null,
      'question_count', 0,
      'generation_status', case
        when selected_assignment.generation_status in ('queued', 'generating')
          then selected_assignment.generation_status
        else 'idle'
      end,
      'generation_started_at', case
        when selected_assignment.generation_status = 'generating'
          then selected_assignment.generation_started_at
        else null
      end,
      'generation_completed_at', null,
      'generation_error', null
    );
  end if;

  return payload;
end;
$$;

revoke all on function public.get_practice_assignment_summary_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_practice_assignment_summary_internal(uuid)
to authenticated, service_role;

-- Authorize through the existing summary before blocking the content read, so
-- an outsider cannot use the withdrawal error as an assignment-existence oracle.
alter function app_private.get_practice_assignment_questions_internal(uuid)
rename to get_practice_assignment_questions_internal_before_phase_13e;

revoke all on function
  app_private.get_practice_assignment_questions_internal_before_phase_13e(uuid)
from public, anon, authenticated, service_role;

create function app_private.get_practice_assignment_questions_internal(
  target_assignment_id uuid
)
returns table (
  id uuid,
  question_number integer,
  question_type text,
  prompt text,
  options jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.get_practice_assignment_summary_internal(target_assignment_id);

  if app_private.practice_assignment_has_withdrawn_unstarted_clone(
    target_assignment_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_withdrawn_replacement_required';
  end if;

  return query
  select question.*
  from app_private.get_practice_assignment_questions_internal_before_phase_13e(
    target_assignment_id
  ) question;
end;
$$;

revoke all on function app_private.get_practice_assignment_questions_internal(uuid)
from public, anon, authenticated, service_role;
grant execute on function app_private.get_practice_assignment_questions_internal(uuid)
to authenticated;

-- Draft creation is another way to start practice. Keep the established
-- authorization, locking, and answer checks, then reject only the unstarted
-- withdrawn attachment.
alter function app_private.assert_practice_draft_context(uuid)
rename to assert_practice_draft_context_before_phase_13e;

revoke all on function app_private.assert_practice_draft_context_before_phase_13e(uuid)
from public, anon, authenticated, service_role;

create function app_private.assert_practice_draft_context(
  target_assignment_id uuid
)
returns public.student_practice_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_assignment public.student_practice_assignments%rowtype;
begin
  selected_assignment :=
    app_private.assert_practice_draft_context_before_phase_13e(
      target_assignment_id
    );

  if app_private.practice_assignment_has_withdrawn_unstarted_clone(
    selected_assignment.id
  ) then
    raise exception using
      errcode = '55000',
      message = 'worksheet_withdrawn_replacement_required';
  end if;

  return selected_assignment;
end;
$$;

revoke all on function app_private.assert_practice_draft_context(uuid)
from public, anon, authenticated, service_role;

-- Lazily repair one affected assignment when the student requests practice.
-- The assignment row is reused (so the one-active invariant is unchanged),
-- the old clone remains for history, and the established durable request path
-- creates/reuses the queue job. Its worker snapshot selects another certified
-- revision before attempting provider generation.
alter function public.request_practice_worksheet(uuid)
rename to request_practice_worksheet_before_phase_13e;

revoke all on function public.request_practice_worksheet_before_phase_13e(uuid)
from public, anon, authenticated, service_role;

create function public.request_practice_worksheet(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  job_id uuid,
  generation_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_assignment public.student_practice_assignments%rowtype;
begin
  -- The summary enforces the complete actor/workspace authorization contract.
  perform public.get_practice_assignment_summary_internal(target_assignment_id);

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
  for update;

  if app_private.practice_assignment_has_withdrawn_unstarted_clone(
    selected_assignment.id
  ) then
    update public.student_practice_assignments assignment
    set
      practice_test_id = null,
      generation_status = 'idle',
      generation_started_at = null,
      generation_completed_at = null,
      generation_error = null
    where assignment.id = selected_assignment.id;
  end if;

  return query
  select requested.*
  from public.request_practice_worksheet_before_phase_13e(
    target_assignment_id
  ) requested;
end;
$$;

revoke all on function public.request_practice_worksheet(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.request_practice_worksheet(uuid)
to authenticated;

-- The canonical selector already required state=released. Keep that invariant
-- and add the immutable withdrawal ledger as an independent fail-closed check.
create or replace function public.select_released_worksheet_template_internal(
  target_workspace_id uuid,
  target_student_id uuid,
  target_grammar_topic_id uuid,
  target_level text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select revision.id
  from app_private.practice_worksheet_template_revisions revision
  join app_private.practice_worksheet_templates template
    on template.id = revision.template_id
  join app_private.practice_worksheet_template_reviews review
    on review.revision_id = revision.id
   and review.decision = 'approved'
   and review.content_sha256 = revision.content_sha256
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
  left join lateral (
    select
      count(*)::bigint as use_count,
      max(coalesce(
        prior_assignment.completed_at,
        prior_assignment.started_at,
        prior_assignment.assigned_at
      )) as last_used_at
    from public.student_practice_assignments prior_assignment
    join public.practice_tests prior_test
      on prior_test.id = prior_assignment.practice_test_id
    where prior_assignment.workspace_id = target_workspace_id
      and prior_assignment.student_id = target_student_id
      and prior_test.worksheet_template_revision_id = revision.id
  ) usage on true
  where target_workspace_id is not null
    and target_student_id is not null
    and target_grammar_topic_id is not null
    and target_level in ('A1', 'A2', 'B1', 'B2')
    and revision.state = 'released'
    and template.grammar_topic_id = target_grammar_topic_id
    and template.level = target_level
    and not exists (
      select 1
      from app_private.practice_worksheet_template_withdrawals withdrawal
      where withdrawal.revision_id = revision.id
    )
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = target_student_id
        and membership.role = 'student'
    )
  order by
    case when usage.use_count = 0 then 0 else 1 end,
    usage.use_count,
    usage.last_used_at nulls first,
    case revision.difficulty when 'easy' then 1 when 'medium' then 2 else 3 end,
    release.released_at,
    revision.id
  limit 1;
$$;

revoke all on function public.select_released_worksheet_template_internal(
  uuid, uuid, uuid, text
)
from public, anon, authenticated, service_role;
grant execute on function public.select_released_worksheet_template_internal(
  uuid, uuid, uuid, text
)
to service_role;

comment on function public.select_released_worksheet_template_internal(
  uuid, uuid, uuid, text
) is
  'Service-only exact-context selector. It prefers unseen released certified revisions, then rotates reused revisions, while independently excluding every immutable withdrawal/supersession.';

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
  with selected_context as (
    select cycle.worksheet_level
    from app_private.practice_resolution_cycles cycle
    where cycle.workspace_id = target_workspace_id
      and cycle.student_id = target_student_id
      and cycle.grammar_topic_id = target_grammar_topic_id
      and cycle.resolved_at is null
      and cycle.class_context_version = 1
    order by cycle.cycle_number desc
    limit 1
  )
  select worksheet.id
  from public.practice_tests worksheet
  cross join selected_context context
  where worksheet.workspace_id = target_workspace_id
    and worksheet.grammar_topic_id = target_grammar_topic_id
    and worksheet.level = context.worksheet_level
    and worksheet.visibility = 'workspace'
    and worksheet.teacher_reviewed = true
    and worksheet.quality_status = 'approved'
    and worksheet.approval_source in (
      'workspace_human_review',
      'certified_template_bank'
    )
    and app_private.practice_test_canonical_revision_is_current(worksheet.id)
    and worksheet.difficulty in ('easy', 'medium')
    and exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = worksheet.id
    )
    and not exists (
      select 1
      from public.practice_test_questions question
      where question.practice_test_id = worksheet.id
        and question.answer_contract_version <> 1
    )
    and not exists (
      select 1
      from public.student_practice_assignments prior_assignment
      where prior_assignment.workspace_id = target_workspace_id
        and prior_assignment.student_id = target_student_id
        and prior_assignment.practice_test_id = worksheet.id
    )
  order by
    case worksheet.difficulty when 'easy' then 1 else 2 end,
    worksheet.created_at desc,
    worksheet.id
  limit 1;
$$;

revoke all on function app_private.select_practice_test_for_cycle(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

-- Preserve the service-only Phase 12H snapshot shape while excluding existing
-- clones whose canonical release was subsequently withdrawn.
create or replace function api.get_worksheet_generation_context(
  target_assignment_id uuid
)
returns table (
  assignment_id uuid,
  workspace_id uuid,
  grammar_topic_id uuid,
  attached_practice_test_id uuid,
  assignment_status text,
  batch_id uuid,
  batch_name text,
  worksheet_level text,
  topic_name text,
  topic_slug text,
  topic_level text,
  topic_description text,
  reusable_practice_test_id uuid,
  certified_template_revision_id uuid
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  perform app_private.assert_service_role();

  return query
  with assignment_context as (
    select
      assignment.id,
      assignment.workspace_id,
      assignment.student_id,
      assignment.grammar_topic_id,
      case
        when public.practice_assignment_has_withdrawn_unstarted_clone_internal(
          assignment.id
        ) then null
        else assignment.practice_test_id
      end as practice_test_id,
      assignment.status,
      assignment.batch_id,
      batch.name as batch_name,
      assignment.worksheet_level,
      assignment.class_context_version,
      topic.name,
      topic.slug,
      topic.level,
      topic.description
    from public.student_practice_assignments assignment
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    left join public.batches batch
      on batch.id = assignment.batch_id
     and batch.workspace_id = assignment.workspace_id
    where assignment.id = target_assignment_id
  )
  select
    context.id,
    context.workspace_id,
    context.grammar_topic_id,
    context.practice_test_id,
    context.status,
    context.batch_id,
    context.batch_name,
    context.worksheet_level,
    context.name,
    context.slug,
    context.level,
    context.description,
    reusable.id,
    certified.id
  from assignment_context context
  left join lateral (
    select worksheet.id
    from public.practice_tests worksheet
    where context.class_context_version = 1
      and worksheet.workspace_id = context.workspace_id
      and worksheet.grammar_topic_id = context.grammar_topic_id
      and worksheet.level = context.worksheet_level
      and worksheet.visibility = 'workspace'
      and worksheet.quality_status = 'approved'
      and worksheet.approval_source in (
        'workspace_human_review',
        'independent_model_validation',
        'certified_template_bank'
      )
      and worksheet.generation_source <> 'system_fallback'
      and public.practice_test_canonical_revision_is_current_internal(
        worksheet.id
      )
      and (context.practice_test_id is null or worksheet.id = context.practice_test_id)
      and exists (
        select 1
        from public.practice_test_questions contract_question
        where contract_question.practice_test_id = worksheet.id
          and contract_question.answer_contract_version = 1
      )
      and not exists (
        select 1
        from public.practice_test_questions contract_question
        where contract_question.practice_test_id = worksheet.id
          and contract_question.answer_contract_version <> 1
      )
      and not exists (
        select 1
        from public.student_practice_assignments prior
        where prior.workspace_id = context.workspace_id
          and prior.student_id = context.student_id
          and prior.practice_test_id = worksheet.id
          and prior.id <> context.id
      )
    order by worksheet.created_at desc, worksheet.id
    limit 1
  ) reusable on true
  left join lateral (
    select public.select_released_worksheet_template_internal(
      context.workspace_id,
      context.student_id,
      context.grammar_topic_id,
      context.worksheet_level
    ) as id
    where context.class_context_version = 1
      and context.practice_test_id is null
      and context.worksheet_level in ('A1', 'A2', 'B1', 'B2')
  ) certified on true;
end;
$$;

revoke all on function api.get_worksheet_generation_context(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.get_worksheet_generation_context(uuid)
to service_role;

comment on function api.get_worksheet_generation_context(uuid) is
  'Service-only generation snapshot using immutable class context. It excludes every withdrawn canonical revision and all existing workspace clones derived from one.';

notify pgrst, 'reload schema';
