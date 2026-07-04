alter table public.submissions
add column if not exists global_question_id uuid references public.global_questions(id) on delete set null;

alter table public.submissions
add column if not exists question_source text;

update public.submissions
set question_source = case
  when question_id is not null then 'workspace_question'
  when mode = 'free_text' then 'free_text'
  else question_source
end
where question_source is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'submissions_question_source_check'
      and conrelid = 'public.submissions'::regclass
  ) then
    alter table public.submissions
    add constraint submissions_question_source_check
    check (
      question_source is null
      or question_source in ('workspace_question', 'global_question', 'free_text')
    );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'submissions_question_source_shape_check'
      and conrelid = 'public.submissions'::regclass
  ) then
    alter table public.submissions
    add constraint submissions_question_source_shape_check
    check (
      question_source is null
      or (
        question_source = 'workspace_question'
        and mode = 'predefined_question'
        and question_id is not null
        and global_question_id is null
      )
      or (
        question_source = 'global_question'
        and mode = 'predefined_question'
        and question_id is null
        and global_question_id is not null
      )
      or (
        question_source = 'free_text'
        and mode = 'free_text'
        and question_id is null
        and global_question_id is null
      )
    );
  end if;
end $$;

create index if not exists submissions_global_question_idx
on public.submissions (global_question_id)
where global_question_id is not null;

create index if not exists submissions_workspace_student_created_idx
on public.submissions (workspace_id, student_id, created_at desc);

drop policy if exists "submissions_insert_student" on public.submissions;
create policy "submissions_insert_student_valid_assignment"
on public.submissions for insert
to authenticated
with check (
  student_id = (select auth.uid())
  and char_length(btrim(original_text)) between 1 and 12000
  and status in ('draft', 'submitted')
  and corrected_text is null
  and overall_summary is null
  and ai_model is null
  and checked_at is null
  and level_detected is null
  and (
    public.is_platform_admin()
    or exists (
      select 1
      from public.batch_students bs
      join public.batches b on b.id = bs.batch_id
      where bs.student_id = (select auth.uid())
        and bs.workspace_id = submissions.workspace_id
        and bs.batch_id = submissions.batch_id
        and b.workspace_id = submissions.workspace_id
        and b.is_active = true
    )
  )
  and (
    (
      question_source = 'free_text'
      and mode = 'free_text'
      and question_id is null
      and global_question_id is null
    )
    or (
      question_source = 'workspace_question'
      and mode = 'predefined_question'
      and question_id is not null
      and global_question_id is null
      and exists (
        select 1
        from public.questions q
        join public.batches b on b.id = submissions.batch_id
        where q.id = submissions.question_id
          and q.workspace_id = submissions.workspace_id
          and q.is_active = true
          and b.workspace_id = submissions.workspace_id
          and b.level = q.level
      )
    )
    or (
      question_source = 'global_question'
      and mode = 'predefined_question'
      and question_id is null
      and global_question_id is not null
      and exists (
        select 1
        from public.global_questions gq
        join public.batches b on b.id = submissions.batch_id
        where gq.id = submissions.global_question_id
          and gq.is_active = true
          and b.level = gq.level
      )
    )
  )
);

drop policy if exists "submissions_update_owner_or_teacher" on public.submissions;
create policy "submissions_update_workspace_teacher"
on public.submissions for update
to authenticated
using (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
)
with check (
  public.is_platform_admin()
  or public.has_workspace_role(workspace_id, array['owner', 'teacher'])
);

create or replace function app_private.create_writing_submission_internal(
  target_question_source text,
  target_question_id uuid,
  target_batch_id uuid,
  answer_text text,
  save_as_draft boolean default false
)
returns table (submission_id uuid)
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

  insert into public.submissions (
    workspace_id,
    student_id,
    batch_id,
    question_id,
    global_question_id,
    question_source,
    mode,
    original_text,
    status
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
    case when save_as_draft then 'draft' else 'submitted' end
  )
  returning id into new_submission_id;

  submission_id := new_submission_id;
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
returns table (submission_id uuid)
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
