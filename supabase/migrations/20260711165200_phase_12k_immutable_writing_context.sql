-- Phase 12K: freeze the evaluator context in the submission transaction.
--
-- The durable queue deliberately carries only an entity id and version.  A
-- retry must therefore resolve every pedagogical input from this immutable
-- private snapshot, never from a class, question, or membership that a
-- teacher may have changed after the student submitted the writing.

create or replace function app_private.writing_evaluation_context_sha256(
  target_submission_id uuid,
  target_context_version smallint,
  target_workspace_id uuid,
  target_student_id uuid,
  target_batch_id uuid,
  target_cefr_level text,
  target_source_type text,
  target_source_id uuid,
  target_submission_mode text,
  target_question_metadata jsonb,
  target_original_text_sha256 text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        jsonb_build_object(
          'schema_version', target_context_version,
          'submission_id', target_submission_id,
          'workspace_id', target_workspace_id,
          'student_id', target_student_id,
          'batch_id', target_batch_id,
          'cefr_level', target_cefr_level,
          'source_type', target_source_type,
          'source_id', target_source_id,
          'submission_mode', target_submission_mode,
          'question_metadata', target_question_metadata,
          'original_text_sha256', target_original_text_sha256
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
$$;

revoke all on function app_private.writing_evaluation_context_sha256(
  uuid, smallint, uuid, uuid, uuid, text, text, uuid, text, jsonb, text
)
from public, anon, authenticated, service_role;

create table if not exists app_private.writing_evaluation_contexts (
  submission_id uuid primary key
    references public.submissions(id) on delete restrict,
  context_version smallint not null default 1
    check (context_version = 1),
  workspace_id uuid not null
    references public.workspaces(id) on delete restrict,
  student_id uuid not null
    references public.profiles(id) on delete restrict,
  batch_id uuid not null
    references public.batches(id) on delete restrict,
  cefr_level text not null check (cefr_level in ('A1', 'A2', 'B1', 'B2')),
  source_type text not null
    check (source_type in ('workspace_question', 'global_question', 'free_text')),
  source_id uuid,
  submission_mode text not null
    check (submission_mode in ('predefined_question', 'free_text')),
  question_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(question_metadata) = 'object'),
  original_text_sha256 text not null
    check (original_text_sha256 ~ '^[0-9a-f]{64}$'),
  context_sha256 text not null
    check (context_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null default now(),
  constraint writing_evaluation_context_source_shape_check check (
    (
      source_type = 'free_text'
      and source_id is null
      and submission_mode = 'free_text'
      and question_metadata = '{}'::jsonb
    )
    or (
      source_type in ('workspace_question', 'global_question')
      and source_id is not null
      and submission_mode = 'predefined_question'
      and nullif(btrim(question_metadata ->> 'title'), '') is not null
      and nullif(btrim(question_metadata ->> 'prompt'), '') is not null
      and question_metadata ->> 'level' = cefr_level
      and nullif(btrim(question_metadata ->> 'topic'), '') is not null
      and nullif(btrim(question_metadata ->> 'task_type'), '') is not null
    )
  ),
  constraint writing_evaluation_context_hash_check check (
    context_sha256 = app_private.writing_evaluation_context_sha256(
      submission_id,
      context_version,
      workspace_id,
      student_id,
      batch_id,
      cefr_level,
      source_type,
      source_id,
      submission_mode,
      question_metadata,
      original_text_sha256
    )
  )
);

create index if not exists writing_evaluation_context_identity_idx
on app_private.writing_evaluation_contexts (
  workspace_id,
  student_id,
  batch_id,
  captured_at desc
);

alter table app_private.writing_evaluation_contexts enable row level security;
revoke all on table app_private.writing_evaluation_contexts
from public, anon, authenticated, service_role;
grant select on table app_private.writing_evaluation_contexts to service_role;
grant execute on function app_private.writing_evaluation_context_sha256(
  uuid, smallint, uuid, uuid, uuid, text, text, uuid, text, jsonb, text
) to service_role;

create table if not exists app_private.writing_evaluation_context_holds (
  submission_id uuid primary key
    references public.submissions(id) on delete restrict,
  hold_reason text not null check (hold_reason in ('legacy_context_missing')),
  observed_evaluation_status text,
  observed_release_status text,
  held_at timestamptz not null default now()
);

alter table app_private.writing_evaluation_context_holds enable row level security;
revoke all on table app_private.writing_evaluation_context_holds
from public, anon, authenticated, service_role;

-- Phase 12G ran before immutable writing snapshots existed. Label every
-- already-promoted evidence/cycle/assignment as legacy-unverified by default;
-- only the triggers below may create a verified context after this point.
alter table app_private.practice_weakness_evidence
  add column if not exists class_context_integrity text not null
    default 'legacy_unverified'
    check (class_context_integrity in (
      'legacy_unverified', 'writing_snapshot', 'teacher_verified'
    ));

alter table app_private.practice_resolution_cycles
  add column if not exists class_context_integrity text not null
    default 'legacy_unverified'
    check (class_context_integrity in (
      'legacy_unverified', 'writing_snapshot', 'teacher_verified'
    ));

alter table public.student_practice_assignments
  add column if not exists class_context_integrity text not null
    default 'legacy_unverified'
    check (class_context_integrity in (
      'legacy_unverified', 'writing_snapshot', 'teacher_verified'
    ));

create or replace function app_private.reject_writing_context_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'writing_evaluation_context_immutable';
end;
$$;

revoke all on function app_private.reject_writing_context_mutation()
from public, anon, authenticated, service_role;

drop trigger if exists writing_evaluation_contexts_immutable
on app_private.writing_evaluation_contexts;
create trigger writing_evaluation_contexts_immutable
before update or delete on app_private.writing_evaluation_contexts
for each row execute function app_private.reject_writing_context_mutation();

drop trigger if exists writing_evaluation_context_holds_immutable
on app_private.writing_evaluation_context_holds;
create trigger writing_evaluation_context_holds_immutable
before update or delete on app_private.writing_evaluation_context_holds
for each row execute function app_private.reject_writing_context_mutation();

-- Lock every editable source row before the legacy creator validates it. This
-- closes the inter-statement race where a teacher could change/archive a class
-- or task after validation but before snapshot capture.
create or replace function app_private.lock_writing_submission_source_context(
  target_batch_id uuid,
  target_source_type text,
  target_source_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_source_type text := lower(nullif(btrim(target_source_type), ''));
  selected_batch public.batches%rowtype;
  selected_membership public.batch_students%rowtype;
  selected_question public.questions%rowtype;
  selected_global_question public.global_questions%rowtype;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  select batch.*
  into selected_batch
  from public.batches batch
  where batch.id = target_batch_id
    and batch.is_active = true
    and batch.level in ('A1', 'A2', 'B1', 'B2')
  for share;

  if selected_batch.id is null then
    raise exception using errcode = '42501', message = 'writing_batch_context_invalid';
  end if;

  select membership.*
  into selected_membership
  from public.batch_students membership
  where membership.batch_id = selected_batch.id
    and membership.workspace_id = selected_batch.workspace_id
    and membership.student_id = caller_id
  for share;

  if selected_membership.id is null then
    raise exception using errcode = '42501', message = 'writing_batch_membership_missing';
  end if;

  if selected_source_type = 'workspace_question' then
    select question.*
    into selected_question
    from public.questions question
    where question.id = target_source_id
      and question.workspace_id = selected_batch.workspace_id
      and question.level = selected_batch.level
      and question.is_active = true
    for share;

    if selected_question.id is null then
      raise exception using errcode = '55000', message = 'writing_question_context_invalid';
    end if;
  elsif selected_source_type = 'global_question' then
    select question.*
    into selected_global_question
    from public.global_questions question
    where question.id = target_source_id
      and question.level = selected_batch.level
      and question.is_active = true
    for share;

    if selected_global_question.id is null then
      raise exception using errcode = '55000', message = 'writing_question_context_invalid';
    end if;
  elsif selected_source_type = 'free_text' then
    if target_source_id is not null then
      raise exception using errcode = '22023', message = 'writing_free_text_context_invalid';
    end if;
  else
    raise exception using errcode = '22023', message = 'writing_source_context_invalid';
  end if;
end;
$$;

revoke all on function app_private.lock_writing_submission_source_context(
  uuid, text, uuid
)
from public, anon, authenticated, service_role;

create or replace function app_private.capture_writing_evaluation_context(
  target_submission_id uuid
)
returns app_private.writing_evaluation_contexts
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_submission public.submissions%rowtype;
  selected_batch public.batches%rowtype;
  selected_membership public.batch_students%rowtype;
  selected_question public.questions%rowtype;
  selected_global_question public.global_questions%rowtype;
  selected_source_id uuid;
  selected_question_metadata jsonb := '{}'::jsonb;
  selected_original_text_sha256 text;
  selected_context_sha256 text;
  existing_context app_private.writing_evaluation_contexts%rowtype;
  created_context app_private.writing_evaluation_contexts%rowtype;
begin
  if target_submission_id is null then
    raise exception using errcode = '22023', message = 'submission_id_required';
  end if;

  select submission.*
  into selected_submission
  from public.submissions submission
  where submission.id = target_submission_id
  for update;

  if selected_submission.id is null then
    raise exception using errcode = '02000', message = 'submission_not_found';
  end if;

  select context.*
  into existing_context
  from app_private.writing_evaluation_contexts context
  where context.submission_id = selected_submission.id;

  if existing_context.submission_id is not null then
    if existing_context.workspace_id is distinct from selected_submission.workspace_id
      or existing_context.student_id is distinct from selected_submission.student_id
      or existing_context.batch_id is distinct from selected_submission.batch_id
      or existing_context.source_type is distinct from selected_submission.question_source
      or existing_context.source_id is distinct from (case
        when selected_submission.question_source = 'workspace_question'
          then selected_submission.question_id
        when selected_submission.question_source = 'global_question'
          then selected_submission.global_question_id
        else null
      end)
      or existing_context.submission_mode is distinct from selected_submission.mode
      or existing_context.original_text_sha256 is distinct from pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(selected_submission.original_text, 'UTF8')
        ),
        'hex'
      )
      or existing_context.context_sha256 is distinct from
        app_private.writing_evaluation_context_sha256(
          existing_context.submission_id,
          existing_context.context_version,
          existing_context.workspace_id,
          existing_context.student_id,
          existing_context.batch_id,
          existing_context.cefr_level,
          existing_context.source_type,
          existing_context.source_id,
          existing_context.submission_mode,
          existing_context.question_metadata,
          existing_context.original_text_sha256
        )
    then
      raise exception using errcode = '55000', message = 'writing_evaluation_context_mismatch';
    end if;
    return existing_context;
  end if;

  if selected_submission.status <> 'submitted'
    or selected_submission.batch_id is null
    or selected_submission.question_source not in (
      'workspace_question', 'global_question', 'free_text'
    )
  then
    raise exception using errcode = '55000', message = 'writing_evaluation_context_not_submittable';
  end if;

  select batch.*
  into selected_batch
  from public.batches batch
  where batch.id = selected_submission.batch_id
    and batch.workspace_id = selected_submission.workspace_id
    and batch.is_active = true
    and batch.level in ('A1', 'A2', 'B1', 'B2')
  for share;

  if selected_batch.id is null then
    raise exception using errcode = '55000', message = 'writing_batch_context_invalid';
  end if;

  select membership.*
  into selected_membership
  from public.batch_students membership
  where membership.batch_id = selected_batch.id
    and membership.workspace_id = selected_batch.workspace_id
    and membership.student_id = selected_submission.student_id
  for share;

  if selected_membership.id is null then
    raise exception using errcode = '42501', message = 'writing_batch_membership_missing';
  end if;

  if selected_submission.question_source = 'workspace_question' then
    select question.*
    into selected_question
    from public.questions question
    where question.id = selected_submission.question_id
      and question.workspace_id = selected_submission.workspace_id
      and question.is_active = true
    for share;

    if selected_question.id is null
      or selected_question.level is distinct from selected_batch.level
    then
      raise exception using errcode = '55000', message = 'writing_question_context_invalid';
    end if;

    selected_source_id := selected_question.id;
    selected_question_metadata := jsonb_build_object(
      'title', selected_question.title,
      'prompt', selected_question.prompt,
      'level', selected_question.level,
      'topic', selected_question.topic,
      'task_type', selected_question.task_type,
      'expected_word_min', selected_question.expected_word_min,
      'expected_word_max', selected_question.expected_word_max,
      'estimated_minutes', selected_question.estimated_minutes
    );
  elsif selected_submission.question_source = 'global_question' then
    select question.*
    into selected_global_question
    from public.global_questions question
    where question.id = selected_submission.global_question_id
      and question.is_active = true
    for share;

    if selected_global_question.id is null
      or selected_global_question.level is distinct from selected_batch.level
    then
      raise exception using errcode = '55000', message = 'writing_question_context_invalid';
    end if;

    selected_source_id := selected_global_question.id;
    selected_question_metadata := jsonb_build_object(
      'title', selected_global_question.title,
      'prompt', selected_global_question.prompt,
      'level', selected_global_question.level,
      'topic', selected_global_question.topic,
      'task_type', selected_global_question.task_type,
      'expected_word_min', selected_global_question.expected_word_min,
      'expected_word_max', selected_global_question.expected_word_max,
      'estimated_minutes', selected_global_question.estimated_minutes
    );
  else
    if selected_submission.question_id is not null
      or selected_submission.global_question_id is not null
      or selected_submission.mode <> 'free_text'
    then
      raise exception using errcode = '55000', message = 'writing_free_text_context_invalid';
    end if;
  end if;

  selected_original_text_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(selected_submission.original_text, 'UTF8')
    ),
    'hex'
  );
  selected_context_sha256 := app_private.writing_evaluation_context_sha256(
    selected_submission.id,
    1::smallint,
    selected_submission.workspace_id,
    selected_submission.student_id,
    selected_batch.id,
    selected_batch.level,
    selected_submission.question_source,
    selected_source_id,
    selected_submission.mode,
    selected_question_metadata,
    selected_original_text_sha256
  );

  insert into app_private.writing_evaluation_contexts (
    submission_id,
    context_version,
    workspace_id,
    student_id,
    batch_id,
    cefr_level,
    source_type,
    source_id,
    submission_mode,
    question_metadata,
    original_text_sha256,
    context_sha256
  ) values (
    selected_submission.id,
    1,
    selected_submission.workspace_id,
    selected_submission.student_id,
    selected_batch.id,
    selected_batch.level,
    selected_submission.question_source,
    selected_source_id,
    selected_submission.mode,
    selected_question_metadata,
    selected_original_text_sha256,
    selected_context_sha256
  )
  returning * into created_context;

  return created_context;
end;
$$;

revoke all on function app_private.capture_writing_evaluation_context(uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.guard_snapshotted_submission_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from app_private.writing_evaluation_contexts context
    where context.submission_id = old.id
  ) and (
    new.workspace_id is distinct from old.workspace_id
    or new.student_id is distinct from old.student_id
    or new.batch_id is distinct from old.batch_id
    or new.question_source is distinct from old.question_source
    or new.question_id is distinct from old.question_id
    or new.global_question_id is distinct from old.global_question_id
    or new.mode is distinct from old.mode
    or new.original_text is distinct from old.original_text
  ) then
    raise exception using
      errcode = '55000',
      message = 'writing_submission_context_immutable';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_snapshotted_submission_identity()
from public, anon, authenticated, service_role;

drop trigger if exists submissions_guard_snapshotted_identity
on public.submissions;
create trigger submissions_guard_snapshotted_identity
before update of
  workspace_id,
  student_id,
  batch_id,
  question_source,
  question_id,
  global_question_id,
  mode,
  original_text
on public.submissions
for each row execute function app_private.guard_snapshotted_submission_identity();

create or replace function app_private.guard_writing_job_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.job_kind = 'worksheet_generation' then
    if not exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.id = new.entity_id
        and assignment.generation_version = new.entity_version
        and assignment.class_context_version = 1
        and assignment.class_context_integrity in (
          'writing_snapshot', 'teacher_verified'
        )
        and assignment.batch_id is not null
        and assignment.worksheet_level in ('A1', 'A2', 'B1', 'B2')
    ) then
      raise exception using
        errcode = '55000',
        message = 'worksheet_class_context_required';
    end if;
    return new;
  end if;

  if new.job_kind <> 'writing_evaluation' then
    return new;
  end if;

  if not exists (
    select 1
    from app_private.writing_evaluation_contexts context
    join public.submissions submission
      on submission.id = context.submission_id
     and submission.workspace_id = context.workspace_id
     and submission.student_id = context.student_id
     and submission.batch_id = context.batch_id
     and submission.question_source = context.source_type
     and submission.mode = context.submission_mode
    where context.submission_id = new.entity_id
      and new.entity_version = submission.evaluation_version
      and context.source_id is not distinct from case
        when context.source_type = 'workspace_question' then submission.question_id
        when context.source_type = 'global_question' then submission.global_question_id
        else null
      end
      and context.original_text_sha256 = pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(submission.original_text, 'UTF8')
        ),
        'hex'
      )
      and context.context_sha256 =
        app_private.writing_evaluation_context_sha256(
          context.submission_id,
          context.context_version,
          context.workspace_id,
          context.student_id,
          context.batch_id,
          context.cefr_level,
          context.source_type,
          context.source_id,
          context.submission_mode,
          context.question_metadata,
          context.original_text_sha256
        )
  ) then
    raise exception using
      errcode = '55000',
      message = 'writing_evaluation_context_missing';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_writing_job_context()
from public, anon, authenticated, service_role;

drop trigger if exists async_jobs_guard_writing_context
on app_private.async_jobs;
create trigger async_jobs_guard_writing_context
before insert on app_private.async_jobs
for each row execute function app_private.guard_writing_job_context();

-- This is the single submission transaction used by direct and draft-backed
-- browser submissions.  Snapshot creation, quota use, entity state, job row,
-- and PGMQ message either commit together or all roll back together.
create or replace function public.create_writing_submission(
  target_question_source text,
  target_question_id uuid,
  target_batch_id uuid,
  answer_text text,
  save_as_draft boolean default false
)
returns table (
  submission_id uuid,
  feedback_mode text,
  feedback_scheduled_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  created_submission record;
  selected_workspace_id uuid;
  selected_student_id uuid;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'Authentication required.';
  end if;

  if target_batch_id is null then
    raise exception using errcode = '22023', message = 'Select a batch before submitting writing.';
  end if;

  if not coalesce(save_as_draft, false) then
    perform app_private.lock_writing_submission_source_context(
      target_batch_id,
      target_question_source,
      target_question_id
    );
  end if;

  select created.*
  into created_submission
  from app_private.create_writing_submission_internal(
    target_question_source,
    target_question_id,
    target_batch_id,
    answer_text,
    save_as_draft
  ) created;

  if not coalesce(save_as_draft, false) then
    select submission.workspace_id, submission.student_id
    into selected_workspace_id, selected_student_id
    from public.submissions submission
    where submission.id = created_submission.submission_id;

    if selected_workspace_id is null or selected_student_id <> caller_id then
      raise exception using errcode = '42501', message = 'permission_denied';
    end if;

    perform app_private.capture_writing_evaluation_context(
      created_submission.submission_id
    );

    perform app_private.consume_writing_submission_quota(
      selected_workspace_id,
      selected_student_id
    );

    update public.submissions submission
    set
      evaluation_status = 'queued',
      release_status = case
        when created_submission.feedback_mode = 'automatic_delayed' then 'scheduled'
        else 'held'
      end,
      release_at = case
        when created_submission.feedback_mode = 'automatic_delayed'
          then created_submission.feedback_scheduled_at
        else null
      end,
      evaluation_version = greatest(submission.evaluation_version, 1),
      feedback_started_at = null,
      feedback_completed_at = null,
      feedback_error = null
    where submission.id = created_submission.submission_id;

    perform *
    from app_private.enqueue_async_job(
      'writing_evaluation',
      created_submission.submission_id,
      1,
      format('writing:%s:%s', created_submission.submission_id, 1),
      caller_id,
      0
    );
  end if;

  return query
  select
    created_submission.submission_id,
    created_submission.feedback_mode,
    created_submission.feedback_scheduled_at;
end;
$$;

revoke all on function public.create_writing_submission(
  text, uuid, uuid, text, boolean
)
from public, anon;
grant execute on function public.create_writing_submission(
  text, uuid, uuid, text, boolean
)
to authenticated;

-- Never manufacture a historical snapshot from today's class membership or
-- editable question rows.  Existing rows are explicitly marked so operators
-- can distinguish retained history from V1 snapshot-backed submissions.
insert into app_private.writing_evaluation_context_holds (
  submission_id,
  hold_reason,
  observed_evaluation_status,
  observed_release_status
)
select
  submission.id,
  'legacy_context_missing',
  submission.evaluation_status,
  submission.release_status
from public.submissions submission
where submission.status <> 'draft'
  and not exists (
    select 1
    from app_private.writing_evaluation_contexts context
    where context.submission_id = submission.id
  )
on conflict (submission_id) do nothing;

do $phase_12k_hold_ambiguous_writing_jobs$
declare
  selected_job record;
begin
  for selected_job in
    select job.id, job.queue_name, job.queue_message_id, job.entity_id
    from app_private.async_jobs job
    where job.job_kind = 'writing_evaluation'
      and job.status in ('queued', 'retry', 'processing')
      and not exists (
        select 1
        from app_private.writing_evaluation_contexts context
        where context.submission_id = job.entity_id
      )
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
      completed_at = null,
      dead_at = now(),
      last_error_code = 'writing_evaluation_context_missing'
    where job.id = selected_job.id;

    update public.submissions submission
    set
      status = 'failed',
      evaluation_status = 'failed',
      release_status = 'held',
      release_at = null,
      feedback_completed_at = now(),
      feedback_error = 'writing_evaluation_context_missing'
    where submission.id = selected_job.entity_id
      and submission.evaluation_status in ('queued', 'processing');
  end loop;
end;
$phase_12k_hold_ambiguous_writing_jobs$;

-- Quarantine every Phase 12G class snapshot that was promoted before a
-- writing-context hash existed. Used historical attempts remain readable, but
-- no existing or future worksheet job may consume their unverified context.
do $phase_12k_cancel_legacy_practice_jobs$
declare
  selected_job record;
begin
  for selected_job in
    select job.id, job.queue_name, job.queue_message_id, job.entity_id
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.job_kind = 'worksheet_generation'
      and job.status in ('queued', 'retry', 'processing')
      and assignment.class_context_integrity = 'legacy_unverified'
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
      completed_at = null,
      dead_at = now(),
      last_error_code = 'worksheet_class_context_required'
    where job.id = selected_job.id;

    update public.student_practice_assignments assignment
    set
      generation_status = 'failed',
      generation_completed_at = coalesce(
        assignment.generation_completed_at,
        now()
      ),
      generation_error = 'worksheet_class_context_required'
    where assignment.id = selected_job.entity_id
      and assignment.practice_test_id is null
      and assignment.latest_attempt_id is null;
  end loop;
end;
$phase_12k_cancel_legacy_practice_jobs$;

drop trigger if exists student_practice_assignments_cycle_identity_guard
on public.student_practice_assignments;
drop trigger if exists practice_resolution_cycles_guard
on app_private.practice_resolution_cycles;

update public.student_practice_assignments assignment
set
  batch_id = null,
  worksheet_level = null,
  class_context_version = 0,
  class_context_integrity = 'legacy_unverified',
  generation_status = 'failed',
  generation_completed_at = coalesce(assignment.generation_completed_at, now()),
  generation_error = 'worksheet_class_context_required'
where assignment.class_context_integrity = 'legacy_unverified'
  and assignment.status = 'unlocked'
  and assignment.practice_test_id is null
  and assignment.latest_attempt_id is null;

update app_private.practice_resolution_cycles cycle
set
  batch_id = null,
  worksheet_level = null,
  class_context_version = 0,
  class_context_integrity = 'legacy_unverified',
  state_reason = 'writing_context_snapshot_required',
  updated_at = now()
where cycle.class_context_integrity = 'legacy_unverified'
  and cycle.class_context_version = 1
  and cycle.resolved_at is null
  and not exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.resolution_cycle_id = cycle.id
      and (
        assignment.practice_test_id is not null
        or assignment.latest_attempt_id is not null
      )
  );

create trigger practice_resolution_cycles_guard
before update on app_private.practice_resolution_cycles
for each row execute function app_private.guard_practice_resolution_cycle_update();

-- Raw writing still lives in exactly one place.  This loader returns it from
-- submissions only after both its hash and every identity field match the
-- immutable context.  It never joins live batches or question tables.
create or replace function api.get_writing_evaluation_context(
  target_submission_id uuid
)
returns table (
  submission_id uuid,
  workspace_id uuid,
  original_text text,
  submission_status text,
  submission_mode text,
  submission_level text,
  batch_level text,
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text
)
language plpgsql
security invoker
set search_path = ''
stable
as $$
begin
  if current_user <> 'service_role' then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  return query
  select
    submission.id,
    context.workspace_id,
    submission.original_text,
    submission.status,
    context.submission_mode,
    submission.level_detected,
    context.cefr_level,
    nullif(context.question_metadata ->> 'title', ''),
    nullif(context.question_metadata ->> 'prompt', ''),
    nullif(context.question_metadata ->> 'level', ''),
    nullif(context.question_metadata ->> 'topic', '')
  from app_private.writing_evaluation_contexts context
  join public.submissions submission
    on submission.id = context.submission_id
   and submission.workspace_id = context.workspace_id
   and submission.student_id = context.student_id
   and submission.batch_id = context.batch_id
   and submission.question_source = context.source_type
   and submission.mode = context.submission_mode
  where context.submission_id = target_submission_id
    and context.source_id is not distinct from case
      when context.source_type = 'workspace_question' then submission.question_id
      when context.source_type = 'global_question' then submission.global_question_id
      else null
    end
    and context.original_text_sha256 = pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(submission.original_text, 'UTF8')
      ),
      'hex'
    )
    and context.context_sha256 =
      app_private.writing_evaluation_context_sha256(
        context.submission_id,
        context.context_version,
        context.workspace_id,
        context.student_id,
        context.batch_id,
        context.cefr_level,
        context.source_type,
        context.source_id,
        context.submission_mode,
        context.question_metadata,
        context.original_text_sha256
      );
end;
$$;

revoke all on function api.get_writing_evaluation_context(uuid)
from public, anon, authenticated;
grant execute on function api.get_writing_evaluation_context(uuid)
to service_role;

-- Actor-authorized historical task projection.  This narrow definer prevents
-- browser roles from receiving app_private table access while ensuring the
-- detail screen shows the same frozen task the evaluator actually used.
create or replace function public.get_writing_display_context_internal(
  target_submission_id uuid
)
returns table (
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text,
  batch_level text,
  context_status text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  is_service_role boolean := current_user = 'service_role'
    or jwt_role = 'service_role';
  selected_submission public.submissions%rowtype;
begin
  if target_submission_id is null then
    raise exception using errcode = '22023', message = 'Submission is required.';
  end if;

  select submission.*
  into selected_submission
  from public.submissions submission
  where submission.id = target_submission_id;

  if selected_submission.id is null then
    raise exception using
      errcode = '42501',
      message = 'Submission not found or access denied.';
  end if;

  if not is_service_role and (
    actor_id is null
    or not (
      public.is_platform_admin()
      or public.has_workspace_role(
        selected_submission.workspace_id,
        array['owner', 'teacher']
      )
      or (
        actor_id = selected_submission.student_id
        and exists (
          select 1
          from public.workspace_members membership
          where membership.workspace_id = selected_submission.workspace_id
            and membership.user_id = actor_id
            and membership.role = 'student'
        )
      )
    )
  ) then
    raise exception using errcode = '42501', message = 'Permission denied.';
  end if;

  return query
  select
    case
      when context.source_type = 'free_text' then 'Free Writing'
      else nullif(context.question_metadata ->> 'title', '')
    end,
    nullif(context.question_metadata ->> 'prompt', ''),
    nullif(context.question_metadata ->> 'level', ''),
    nullif(context.question_metadata ->> 'topic', ''),
    context.cefr_level,
    'snapshotted'::text
  from app_private.writing_evaluation_contexts context
  where context.submission_id = selected_submission.id
    and context.workspace_id = selected_submission.workspace_id
    and context.student_id = selected_submission.student_id
    and context.batch_id = selected_submission.batch_id
    and context.source_type = selected_submission.question_source
    and context.submission_mode = selected_submission.mode
    and context.source_id is not distinct from case
      when context.source_type = 'workspace_question'
        then selected_submission.question_id
      when context.source_type = 'global_question'
        then selected_submission.global_question_id
      else null
    end
    and context.original_text_sha256 = pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(selected_submission.original_text, 'UTF8')
      ),
      'hex'
    )
    and context.context_sha256 =
      app_private.writing_evaluation_context_sha256(
        context.submission_id,
        context.context_version,
        context.workspace_id,
        context.student_id,
        context.batch_id,
        context.cefr_level,
        context.source_type,
        context.source_id,
        context.submission_mode,
        context.question_metadata,
        context.original_text_sha256
      );

  if found then
    return;
  end if;

  -- Historical rows remain viewable, but editable live question/class values
  -- are never presented as if they were the original task.
  return query
  select
    case
      when selected_submission.question_source = 'free_text' then 'Free Writing'
      else 'Historical writing task'
    end,
    null::text,
    null::text,
    null::text,
    null::text,
    'legacy_context_missing'::text;
end;
$$;

revoke all on function public.get_writing_display_context_internal(uuid)
from public, anon;
grant execute on function public.get_writing_display_context_internal(uuid)
to authenticated, service_role;

do $phase_12k_patch_submission_detail$
declare
  function_definition text;
  declaration_fragment text := $old$
  selected_submission public.submissions%rowtype;
  submission_json jsonb;
$old$;
  declaration_replacement text := $new$
  selected_submission public.submissions%rowtype;
  historical_task_context record;
  submission_json jsonb;
$new$;
  load_fragment text := $old$
  feedback_visible := is_service_role
$old$;
  load_replacement text := $new$
  select display_context.*
  into historical_task_context
  from public.get_writing_display_context_internal(
    target_submission_id
  ) display_context;

  feedback_visible := is_service_role
$new$;
  question_fragment text := $old$
    'question_title', coalesce(
      (select question.title from public.questions question where question.id = selected_submission.question_id),
      (select question.title from public.global_questions question where question.id = selected_submission.global_question_id),
      'Free Writing'
    ),
    'question_prompt', coalesce(
      (select question.prompt from public.questions question where question.id = selected_submission.question_id),
      (select question.prompt from public.global_questions question where question.id = selected_submission.global_question_id)
    ),
    'question_level', coalesce(
      (select question.level from public.questions question where question.id = selected_submission.question_id),
      (select question.level from public.global_questions question where question.id = selected_submission.global_question_id)
    ),
    'question_topic', coalesce(
      (select question.topic from public.questions question where question.id = selected_submission.question_id),
      (select question.topic from public.global_questions question where question.id = selected_submission.global_question_id)
    ),
$old$;
  question_replacement text := $new$
    'question_title', historical_task_context.question_title,
    'question_prompt', historical_task_context.question_prompt,
    'question_level', historical_task_context.question_level,
    'question_topic', historical_task_context.question_topic,
$new$;
  batch_level_fragment text := $old$
    'batch_level', (
      select batch.level
      from public.batches batch
      where batch.id = selected_submission.batch_id
    ),
$old$;
  batch_level_replacement text := $new$
    'batch_level', historical_task_context.batch_level,
$new$;
begin
  select pg_get_functiondef(
    'api.get_submission_detail(uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(declaration_fragment in function_definition) = 0
    or position(load_fragment in function_definition) = 0
    or position(question_fragment in function_definition) = 0
    or position(batch_level_fragment in function_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'submission_snapshot_projection_anchor_changed';
  end if;

  function_definition := replace(
    function_definition,
    declaration_fragment,
    declaration_replacement
  );
  function_definition := replace(
    function_definition,
    load_fragment,
    load_replacement
  );
  function_definition := replace(
    function_definition,
    question_fragment,
    question_replacement
  );
  function_definition := replace(
    function_definition,
    batch_level_fragment,
    batch_level_replacement
  );
  execute function_definition;
end;
$phase_12k_patch_submission_detail$;

-- Future adaptive-practice evidence carries the same tamper-evident writing
-- snapshot.  Version zero is retained only to label pre-12K history; it is
-- never promoted by reading a current class or question.
alter table app_private.practice_weakness_evidence
  add column if not exists writing_context_version smallint not null default 0,
  add column if not exists writing_context_sha256 text;

alter table app_private.practice_weakness_evidence
  drop constraint if exists practice_weakness_evidence_writing_context_check,
  add constraint practice_weakness_evidence_writing_context_check check (
    (
      writing_context_version = 0
      and writing_context_sha256 is null
      and (
        source_kind <> 'feedback_draft'
        or class_context_integrity = 'legacy_unverified'
      )
    )
    or (
      writing_context_version = 1
      and source_kind = 'feedback_draft'
      and class_context_integrity = 'writing_snapshot'
      and submission_id is not null
      and writing_context_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  drop constraint if exists practice_weakness_evidence_integrity_source_check,
  add constraint practice_weakness_evidence_integrity_source_check check (
    source_kind <> 'legacy_release'
    or class_context_integrity = 'legacy_unverified'
  );

create or replace function app_private.populate_practice_evidence_class_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_context app_private.writing_evaluation_contexts%rowtype;
  selected_assignment public.student_practice_assignments%rowtype;
begin
  if new.source_kind = 'feedback_draft' then
    select context.*
    into selected_context
    from app_private.writing_evaluation_contexts context
    where context.submission_id = new.submission_id
      and context.workspace_id = new.workspace_id
      and context.student_id = new.student_id
      and context.context_sha256 =
        app_private.writing_evaluation_context_sha256(
          context.submission_id,
          context.context_version,
          context.workspace_id,
          context.student_id,
          context.batch_id,
          context.cefr_level,
          context.source_type,
          context.source_id,
          context.submission_mode,
          context.question_metadata,
          context.original_text_sha256
        );

    if selected_context.submission_id is null then
      raise exception using
        errcode = '55000',
        message = 'writing_evaluation_context_missing';
    end if;

    new.batch_id := selected_context.batch_id;
    new.evidence_level := selected_context.cefr_level;
    new.writing_context_version := selected_context.context_version;
    new.writing_context_sha256 := selected_context.context_sha256;
    new.class_context_integrity := 'writing_snapshot';
  elsif new.source_kind = 'teacher_score_override' then
    select assignment.*
    into selected_assignment
    from app_private.practice_teacher_actions action
    join public.student_practice_assignments assignment
      on assignment.id = action.assignment_id
     and assignment.workspace_id = action.workspace_id
     and assignment.student_id = action.student_id
     and assignment.grammar_topic_id = action.grammar_topic_id
    where action.id = new.teacher_action_id
      and action.workspace_id = new.workspace_id
      and action.student_id = new.student_id
      and action.grammar_topic_id = new.grammar_topic_id
      and assignment.class_context_version = 1;

    if selected_assignment.id is null then
      raise exception using
        errcode = '55000',
        message = 'practice_teacher_action_context_missing';
    end if;

    new.batch_id := selected_assignment.batch_id;
    new.evidence_level := selected_assignment.worksheet_level;
    new.writing_context_version := 0;
    new.writing_context_sha256 := null;
    new.class_context_integrity := selected_assignment.class_context_integrity;
  else
    -- A legacy release has no trustworthy submission-time context.  Keeping
    -- it version zero is explicit and forces any new cycle to teacher recovery.
    new.batch_id := null;
    new.evidence_level := null;
    new.writing_context_version := 0;
    new.writing_context_sha256 := null;
    new.class_context_integrity := 'legacy_unverified';
  end if;

  return new;
end;
$$;

revoke all on function app_private.populate_practice_evidence_class_context()
from public, anon, authenticated, service_role;

drop trigger if exists practice_weakness_evidence_class_context
on app_private.practice_weakness_evidence;
create trigger practice_weakness_evidence_class_context
before insert on app_private.practice_weakness_evidence
for each row execute function app_private.populate_practice_evidence_class_context();

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
    batch_id,
    evidence_level,
    writing_context_version,
    writing_context_sha256,
    minor_issue_count,
    major_issue_count,
    released_at
  )
  select
    'feedback_draft',
    new.id,
    new.id,
    submission.id,
    context.workspace_id,
    context.student_id,
    topic.grammar_topic_id,
    context.batch_id,
    context.cefr_level,
    context.context_version,
    context.context_sha256,
    case when topic.severity = 'minor' then topic.count else 0 end,
    case when topic.severity in ('major', 'mixed') then topic.count else 0 end,
    coalesce(new.released_at, now())
  from app_private.writing_evaluation_contexts context
  join public.submissions submission
    on submission.id = context.submission_id
   and submission.workspace_id = context.workspace_id
   and submission.student_id = context.student_id
   and submission.batch_id = context.batch_id
  join public.submission_grammar_topics topic
    on topic.submission_id = submission.id
  where submission.id = new.submission_id
    and submission.release_status = 'released'
    and context.context_sha256 =
      app_private.writing_evaluation_context_sha256(
        context.submission_id,
        context.context_version,
        context.workspace_id,
        context.student_id,
        context.batch_id,
        context.cefr_level,
        context.source_type,
        context.source_id,
        context.submission_mode,
        context.question_metadata,
        context.original_text_sha256
      )
    and topic.count > 0
  on conflict (source_kind, source_release_id, grammar_topic_id) do nothing;

  return new;
end;
$$;

revoke all on function app_private.capture_released_practice_evidence()
from public, anon, authenticated, service_role;

-- A new cycle accepts only snapshot-backed writing evidence or a score
-- override that already inherited an immutable assignment snapshot.
create or replace function app_private.populate_practice_cycle_class_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select
    evidence.batch_id,
    evidence.evidence_level,
    evidence.class_context_integrity
  into
    new.batch_id,
    new.worksheet_level,
    new.class_context_integrity
  from app_private.practice_weakness_evidence evidence
  where evidence.workspace_id = new.workspace_id
    and evidence.student_id = new.student_id
    and evidence.grammar_topic_id = new.grammar_topic_id
    and evidence.evidence_sequence between
      new.evidence_start_sequence and new.evidence_through_sequence
    and evidence.batch_id is not null
    and evidence.evidence_level in ('A1', 'A2', 'B1', 'B2')
    and evidence.class_context_integrity in (
      'writing_snapshot', 'teacher_verified'
    )
    and (
      (
        evidence.source_kind = 'feedback_draft'
        and evidence.writing_context_version = 1
        and evidence.writing_context_sha256 ~ '^[0-9a-f]{64}$'
      )
      or evidence.source_kind = 'teacher_score_override'
    )
  order by evidence.evidence_sequence desc
  limit 1;

  if new.batch_id is null then
    new.worksheet_level := null;
    new.class_context_version := 0;
    new.class_context_integrity := 'legacy_unverified';
    return new;
  end if;

  if new.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
    or not exists (
      select 1
      from public.batches batch
      where batch.id = new.batch_id
        and batch.workspace_id = new.workspace_id
    )
  then
    raise exception using
      errcode = '22023',
      message = 'Practice cycle class context is invalid.';
  end if;

  new.class_context_version := 1;
  return new;
end;
$$;

revoke all on function app_private.populate_practice_cycle_class_context()
from public, anon, authenticated, service_role;

drop trigger if exists practice_resolution_cycles_populate_class_context
on app_private.practice_resolution_cycles;
create trigger practice_resolution_cycles_populate_class_context
before insert on app_private.practice_resolution_cycles
for each row execute function app_private.populate_practice_cycle_class_context();

do $phase_12k_patch_cycle_integrity_guard$
declare
  function_definition text;
  immutable_fragment text := $old$
  if old.class_context_version = 1 and (
    new.class_context_version <> old.class_context_version
    or new.batch_id is distinct from old.batch_id
$old$;
  immutable_replacement text := $new$
  if old.class_context_version = 1 and (
    new.class_context_version <> old.class_context_version
    or new.class_context_integrity is distinct from old.class_context_integrity
    or new.batch_id is distinct from old.batch_id
$new$;
  promotion_fragment text := $old$
    if new.batch_id is null
      or new.worksheet_level is null
$old$;
  promotion_replacement text := $new$
    if new.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
      or new.batch_id is null
      or new.worksheet_level is null
$new$;
begin
  select pg_get_functiondef(
    'app_private.guard_practice_resolution_cycle_update()'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(immutable_fragment in function_definition) = 0
    or position(promotion_fragment in function_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'practice_cycle_integrity_guard_anchor_changed';
  end if;

  function_definition := replace(
    function_definition,
    immutable_fragment,
    immutable_replacement
  );
  function_definition := replace(
    function_definition,
    promotion_fragment,
    promotion_replacement
  );
  execute function_definition;
end;
$phase_12k_patch_cycle_integrity_guard$;

-- The existing teacher recovery remains the sole promotion from an ambiguous
-- historical shell. Record that explicit choice as audited teacher provenance.
do $phase_12k_patch_teacher_context_recovery$
declare
  function_definition text;
  cycle_fragment text := $old$
        class_context_version = 1,
        state_reason = 'teacher_class_context_resolved'
$old$;
  cycle_replacement text := $new$
        class_context_version = 1,
        class_context_integrity = 'teacher_verified',
        state_reason = 'teacher_class_context_resolved'
$new$;
  assignment_fragment text := $old$
      class_context_version = 1,
      generation_status = next_generation_status,
$old$;
  assignment_replacement text := $new$
      class_context_version = 1,
      class_context_integrity = 'teacher_verified',
      generation_status = next_generation_status,
$new$;
begin
  select pg_get_functiondef(
    'public.resolve_practice_assignment_class_context_internal(uuid,uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(cycle_fragment in function_definition) = 0
    or position(assignment_fragment in function_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'teacher_context_recovery_anchor_changed';
  end if;

  function_definition := replace(
    function_definition,
    cycle_fragment,
    cycle_replacement
  );
  function_definition := replace(
    function_definition,
    assignment_fragment,
    assignment_replacement
  );
  execute function_definition;
end;
$phase_12k_patch_teacher_context_recovery$;

-- Students cannot request or reuse material from a pre-12K inferred context.
do $phase_12k_patch_practice_request_integrity$
declare
  function_definition text;
  original_fragment text := $old$
  if selected_assignment.class_context_version <> 1
    or selected_assignment.batch_id is null
$old$;
  replacement_fragment text := $new$
  if selected_assignment.class_context_version <> 1
    or selected_assignment.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
    or selected_assignment.batch_id is null
$new$;
begin
  select pg_get_functiondef(
    'public.request_practice_worksheet(uuid)'::regprocedure
  ) into function_definition;

  if function_definition is null
    or position(original_fragment in function_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'practice_request_integrity_anchor_changed';
  end if;

  execute replace(
    function_definition,
    original_fragment,
    replacement_fragment
  );
end;
$phase_12k_patch_practice_request_integrity$;

-- Phase 12H selectors and the worker loader must also reject legacy provenance
-- even if a privileged caller bypasses the browser request routine.
do $phase_12k_patch_phase_12h_context_consumers$
declare
  selector_definition text;
  loader_definition text;
  selector_fragment text := $old$
      and cycle.class_context_version = 1
$old$;
  selector_replacement text := $new$
      and cycle.class_context_version = 1
      and cycle.class_context_integrity in (
        'writing_snapshot', 'teacher_verified'
      )
$new$;
  loader_select_fragment text := $old$
      assignment.class_context_version,
      topic.name,
$old$;
  loader_select_replacement text := $new$
      assignment.class_context_version,
      assignment.class_context_integrity,
      topic.name,
$new$;
  loader_tail_fragment text := $old$
  ) certified on true;
$old$;
  loader_tail_replacement text := $new$
  ) certified on true
  where context.class_context_integrity in (
    'writing_snapshot', 'teacher_verified'
  );
$new$;
begin
  select pg_get_functiondef(
    'app_private.select_practice_test_for_cycle(uuid,uuid,uuid)'::regprocedure
  ) into selector_definition;
  select pg_get_functiondef(
    'api.get_worksheet_generation_context(uuid)'::regprocedure
  ) into loader_definition;

  if selector_definition is null
    or position(selector_fragment in selector_definition) = 0
    or loader_definition is null
    or position(loader_select_fragment in loader_definition) = 0
    or position(loader_tail_fragment in loader_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'phase_12h_context_consumer_anchor_changed';
  end if;

  execute replace(
    selector_definition,
    selector_fragment,
    selector_replacement
  );
  loader_definition := replace(
    loader_definition,
    loader_select_fragment,
    loader_select_replacement
  );
  loader_definition := replace(
    loader_definition,
    loader_tail_fragment,
    loader_tail_replacement
  );
  execute loader_definition;
end;
$phase_12k_patch_phase_12h_context_consumers$;

-- Assignment creation validates the batch identity and frozen level shape but
-- intentionally does not compare against the batch's current editable level.
create or replace function app_private.guard_practice_assignment_cycle_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_cycle app_private.practice_resolution_cycles%rowtype;
  previous_assignment public.student_practice_assignments%rowtype;
begin
  if tg_op = 'UPDATE' and old.resolution_cycle_id is not null and (
    new.resolution_cycle_id is distinct from old.resolution_cycle_id
    or new.resolution_cycle_number is distinct from old.resolution_cycle_number
    or new.evidence_cutoff_sequence is distinct from old.evidence_cutoff_sequence
  ) then
    raise exception using errcode = '55000', message = 'Practice assignment cycle context is immutable.';
  end if;

  if tg_op = 'UPDATE'
    and new.class_context_integrity is distinct from old.class_context_integrity
    and new.class_context_version = old.class_context_version
  then
    raise exception using
      errcode = '55000',
      message = 'Practice assignment class context is immutable.';
  end if;

  if tg_op = 'UPDATE' and old.class_context_version = 1 and (
    new.class_context_version <> old.class_context_version
    or new.class_context_integrity is distinct from old.class_context_integrity
    or new.batch_id is distinct from old.batch_id
    or new.worksheet_level is distinct from old.worksheet_level
  ) then
    raise exception using errcode = '55000', message = 'Practice assignment class context is immutable.';
  end if;

  if new.resolution_cycle_id is not null then
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

    if selected_cycle.class_context_version = 1
      and selected_cycle.class_context_integrity in (
        'writing_snapshot', 'teacher_verified'
      )
    then
      new.batch_id := selected_cycle.batch_id;
      new.worksheet_level := selected_cycle.worksheet_level;
      new.class_context_version := 1;
      new.class_context_integrity := selected_cycle.class_context_integrity;
    else
      new.batch_id := null;
      new.worksheet_level := null;
      new.class_context_version := 0;
      new.class_context_integrity := 'legacy_unverified';
      new.generation_status := 'failed';
      new.generation_completed_at := coalesce(new.generation_completed_at, now());
      new.generation_error := 'worksheet_class_context_required';
    end if;

    if current_user in ('anon', 'authenticated')
      and (tg_op = 'INSERT' or old.resolution_cycle_id is null)
    then
      raise exception using errcode = '42501', message = 'Practice cycle context is server managed.';
    end if;
  elsif new.class_context_version = 0
    and new.previous_assignment_id is not null
  then
    select assignment.*
    into previous_assignment
    from public.student_practice_assignments assignment
    where assignment.id = new.previous_assignment_id
      and assignment.workspace_id = new.workspace_id
      and assignment.student_id = new.student_id
      and assignment.grammar_topic_id = new.grammar_topic_id;

    if previous_assignment.class_context_version = 1
      and previous_assignment.class_context_integrity in (
        'writing_snapshot', 'teacher_verified'
      )
    then
      new.batch_id := previous_assignment.batch_id;
      new.worksheet_level := previous_assignment.worksheet_level;
      new.class_context_version := 1;
      new.class_context_integrity :=
        previous_assignment.class_context_integrity;
    elsif previous_assignment.resolution_cycle_id is not null then
      select cycle.*
      into selected_cycle
      from app_private.practice_resolution_cycles cycle
      where cycle.id = previous_assignment.resolution_cycle_id;

      if selected_cycle.class_context_version = 1
        and selected_cycle.class_context_integrity in (
          'writing_snapshot', 'teacher_verified'
        )
      then
        new.batch_id := selected_cycle.batch_id;
        new.worksheet_level := selected_cycle.worksheet_level;
        new.class_context_version := 1;
        new.class_context_integrity := selected_cycle.class_context_integrity;
      end if;
    end if;
  end if;

  if new.class_context_version = 1 then
    if new.class_context_integrity not in (
      'writing_snapshot', 'teacher_verified'
    )
      or new.worksheet_level not in ('A1', 'A2', 'B1', 'B2')
      or not exists (
        select 1
        from public.batches batch
        where batch.id = new.batch_id
          and batch.workspace_id = new.workspace_id
      )
    then
      raise exception using errcode = '22023', message = 'Practice assignment class context is invalid.';
    end if;

    if new.resolution_cycle_id is null
      and (tg_op = 'INSERT' or old.class_context_version = 0)
      and not exists (
        select 1
        from public.batch_students membership
        where membership.workspace_id = new.workspace_id
          and membership.batch_id = new.batch_id
          and membership.student_id = new.student_id
      )
    then
      raise exception using errcode = '42501', message = 'Student class assignment is required.';
    end if;
  elsif tg_op = 'INSERT' and new.resolution_cycle_id is null then
    new.batch_id := null;
    new.worksheet_level := null;
    new.class_context_version := 0;
    new.class_context_integrity := 'legacy_unverified';
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
  evidence_cutoff_sequence,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity
on public.student_practice_assignments
for each row execute function app_private.guard_practice_assignment_cycle_identity();

comment on table app_private.writing_evaluation_contexts is
  'Immutable submission-time evaluator context. Raw student writing remains only in public.submissions; this table stores its SHA-256 binding.';
comment on table app_private.writing_evaluation_context_holds is
  'Explicit hold ledger for historical submissions that predate the immutable evaluator-context contract; no live membership inference is permitted.';
comment on function api.get_writing_evaluation_context(uuid) is
  'Service-only writing loader backed exclusively by the immutable submission-time context and exact original-text hash.';

notify pgrst, 'reload schema';
