-- Phase 6B: batch-level feedback timing modes and per-submission scheduling.
-- Existing batches default to teacher_review_only to preserve Phase 6A behavior.

alter table public.batches
add column if not exists feedback_mode text not null default 'teacher_review_only',
add column if not exists feedback_delay_min_minutes integer not null default 15,
add column if not exists feedback_delay_max_minutes integer not null default 180;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'batches_feedback_mode_check'
      and conrelid = 'public.batches'::regclass
  ) then
    alter table public.batches
    add constraint batches_feedback_mode_check
    check (feedback_mode in ('immediate', 'automatic_delayed', 'teacher_review_only'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'batches_feedback_delay_range_check'
      and conrelid = 'public.batches'::regclass
  ) then
    alter table public.batches
    add constraint batches_feedback_delay_range_check
    check (
      feedback_delay_min_minutes >= 0
      and feedback_delay_max_minutes >= feedback_delay_min_minutes
      and feedback_delay_max_minutes <= 10080
    );
  end if;
end $$;

alter table public.submissions
add column if not exists feedback_mode text,
add column if not exists feedback_scheduled_at timestamptz,
add column if not exists feedback_started_at timestamptz,
add column if not exists feedback_completed_at timestamptz,
add column if not exists feedback_error text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'submissions_feedback_mode_check'
      and conrelid = 'public.submissions'::regclass
  ) then
    alter table public.submissions
    add constraint submissions_feedback_mode_check
    check (
      feedback_mode is null
      or feedback_mode in ('immediate', 'automatic_delayed', 'teacher_review_only')
    );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'submissions_feedback_schedule_shape_check'
      and conrelid = 'public.submissions'::regclass
  ) then
    alter table public.submissions
    add constraint submissions_feedback_schedule_shape_check
    check (
      status = 'draft'
      or feedback_mode is null
      or feedback_mode <> 'automatic_delayed'
      or feedback_scheduled_at is not null
    );
  end if;
end $$;

create index if not exists submissions_status_feedback_scheduled_idx
on public.submissions (status, feedback_scheduled_at)
where feedback_scheduled_at is not null;

create index if not exists submissions_workspace_status_feedback_scheduled_idx
on public.submissions (workspace_id, status, feedback_scheduled_at)
where feedback_scheduled_at is not null;

create index if not exists batches_workspace_feedback_mode_idx
on public.batches (workspace_id, feedback_mode);

drop function if exists public.create_writing_submission(text, uuid, uuid, text, boolean);
drop function if exists app_private.create_writing_submission_internal(text, uuid, uuid, text, boolean);

create or replace function app_private.create_writing_submission_internal(
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
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := (select auth.uid());
  clean_source text := lower(nullif(btrim(target_question_source), ''));
  clean_text text := nullif(btrim(answer_text), '');
  batch_record public.batches%rowtype;
  workspace_question public.questions%rowtype;
  global_question public.global_questions%rowtype;
  selected_workspace_id uuid;
  selected_batch_id uuid;
  selected_feedback_mode text;
  selected_feedback_scheduled_at timestamptz;
  selected_min_delay integer;
  selected_max_delay integer;
  selected_delay_minutes integer;
  new_submission_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required.';
  end if;

  if clean_source is null or clean_source not in ('workspace_question', 'global_question', 'free_text') then
    raise exception 'Invalid question source.';
  end if;

  if clean_text is null then
    raise exception 'Writing text is required.';
  end if;

  if char_length(clean_text) > 12000 then
    raise exception 'Writing text is too long. Please keep it under 12000 characters.';
  end if;

  if clean_source = 'free_text' and target_question_id is not null then
    raise exception 'Free writing cannot include a question id.';
  end if;

  if clean_source in ('workspace_question', 'global_question') and target_question_id is null then
    raise exception 'A question id is required.';
  end if;

  if target_batch_id is not null then
    select b.*
    into batch_record
    from public.batches b
    join public.batch_students bs on bs.batch_id = b.id
    where b.id = target_batch_id
      and bs.student_id = caller_id
      and bs.workspace_id = b.workspace_id
      and b.is_active = true
    limit 1;

    if batch_record.id is null then
      raise exception 'You are not assigned to this active batch.';
    end if;
  end if;

  if clean_source = 'workspace_question' then
    select q.*
    into workspace_question
    from public.questions q
    where q.id = target_question_id
      and q.is_active = true;

    if workspace_question.id is null then
      raise exception 'Workspace question was not found or is inactive.';
    end if;

    if batch_record.id is null then
      select b.*
      into batch_record
      from public.batch_students bs
      join public.batches b on b.id = bs.batch_id
      where bs.student_id = caller_id
        and bs.workspace_id = workspace_question.workspace_id
        and b.workspace_id = workspace_question.workspace_id
        and b.level = workspace_question.level
        and b.is_active = true
      order by bs.created_at desc
      limit 1;
    end if;

    if batch_record.id is null then
      raise exception 'You are not assigned to a matching active batch for this question.';
    end if;

    if batch_record.workspace_id <> workspace_question.workspace_id then
      raise exception 'This question does not belong to your selected batch workspace.';
    end if;

    if batch_record.level <> workspace_question.level then
      raise exception 'This question level does not match your selected batch.';
    end if;

    selected_workspace_id := workspace_question.workspace_id;
    selected_batch_id := batch_record.id;
  elsif clean_source = 'global_question' then
    select gq.*
    into global_question
    from public.global_questions gq
    where gq.id = target_question_id
      and gq.is_active = true;

    if global_question.id is null then
      raise exception 'Global question was not found or is inactive.';
    end if;

    if batch_record.id is null then
      select b.*
      into batch_record
      from public.batch_students bs
      join public.batches b on b.id = bs.batch_id
      where bs.student_id = caller_id
        and b.level = global_question.level
        and b.is_active = true
      order by bs.created_at desc
      limit 1;
    end if;

    if batch_record.id is null then
      raise exception 'You are not assigned to a matching active batch for this global question.';
    end if;

    if batch_record.level <> global_question.level then
      raise exception 'This global question level does not match your selected batch.';
    end if;

    selected_workspace_id := batch_record.workspace_id;
    selected_batch_id := batch_record.id;
  else
    if batch_record.id is null then
      select b.*
      into batch_record
      from public.batch_students bs
      join public.batches b on b.id = bs.batch_id
      where bs.student_id = caller_id
        and b.is_active = true
      order by bs.created_at desc
      limit 1;
    end if;

    if batch_record.id is null then
      raise exception 'Join a batch before submitting free writing.';
    end if;

    selected_workspace_id := batch_record.workspace_id;
    selected_batch_id := batch_record.id;
  end if;

  if not save_as_draft then
    selected_feedback_mode := coalesce(batch_record.feedback_mode, 'teacher_review_only');
    selected_min_delay := coalesce(batch_record.feedback_delay_min_minutes, 15);
    selected_max_delay := coalesce(batch_record.feedback_delay_max_minutes, 180);

    if selected_feedback_mode = 'immediate' then
      selected_feedback_scheduled_at := now();
    elsif selected_feedback_mode = 'automatic_delayed' then
      selected_delay_minutes := selected_min_delay + floor(random() * (selected_max_delay - selected_min_delay + 1))::integer;
      selected_feedback_scheduled_at := now() + make_interval(mins => selected_delay_minutes);
    else
      selected_feedback_scheduled_at := null;
    end if;
  end if;

  insert into public.submissions (
    workspace_id,
    student_id,
    batch_id,
    question_id,
    global_question_id,
    question_source,
    mode,
    original_text,
    status,
    feedback_mode,
    feedback_scheduled_at
  )
  values (
    selected_workspace_id,
    caller_id,
    selected_batch_id,
    case when clean_source = 'workspace_question' then target_question_id else null end,
    case when clean_source = 'global_question' then target_question_id else null end,
    clean_source,
    case when clean_source = 'free_text' then 'free_text' else 'predefined_question' end,
    clean_text,
    case when save_as_draft then 'draft' else 'submitted' end,
    selected_feedback_mode,
    selected_feedback_scheduled_at
  )
  returning id into new_submission_id;

  submission_id := new_submission_id;
  feedback_mode := selected_feedback_mode;
  feedback_scheduled_at := selected_feedback_scheduled_at;
  return next;
end;
$$;

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
language sql
security invoker
set search_path = public, pg_temp
as $$
  select *
  from app_private.create_writing_submission_internal(
    target_question_source,
    target_question_id,
    target_batch_id,
    answer_text,
    save_as_draft
  );
$$;

revoke all on function app_private.create_writing_submission_internal(text, uuid, uuid, text, boolean) from public, anon;
grant execute on function app_private.create_writing_submission_internal(text, uuid, uuid, text, boolean) to authenticated;

revoke all on function public.create_writing_submission(text, uuid, uuid, text, boolean) from public, anon;
grant execute on function public.create_writing_submission(text, uuid, uuid, text, boolean) to authenticated;
