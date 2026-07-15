-- Phase 11E: resumable writing and worksheet drafts with optimistic locking.
-- Draft content is private and never exposed as a Data API table. Browser
-- access is limited to narrow, owner-scoped API functions.

create table if not exists app_private.writing_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  batch_id uuid not null references public.batches(id) on delete cascade,
  source_type text not null check (
    source_type in ('workspace_question', 'global_question', 'free_text')
  ),
  source_id uuid,
  content text not null,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint writing_drafts_source_id_check check (
    (source_type = 'free_text' and source_id is null)
    or (source_type <> 'free_text' and source_id is not null)
  )
);

create unique index if not exists writing_drafts_context_unique_idx
on app_private.writing_drafts (
  student_id,
  batch_id,
  source_type,
  coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

create index if not exists writing_drafts_student_updated_idx
on app_private.writing_drafts (student_id, workspace_id, updated_at desc, id desc);

create table if not exists app_private.practice_drafts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null unique
    references public.student_practice_assignments(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  answers jsonb not null default '[]'::jsonb,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint practice_drafts_answers_array_check
    check (jsonb_typeof(answers) = 'array')
);

create index if not exists practice_drafts_student_updated_idx
on app_private.practice_drafts (student_id, workspace_id, updated_at desc, id desc);

alter table app_private.writing_drafts enable row level security;
alter table app_private.practice_drafts enable row level security;

revoke all on table app_private.writing_drafts
from public, anon, authenticated, service_role;
revoke all on table app_private.practice_drafts
from public, anon, authenticated, service_role;

drop trigger if exists writing_drafts_set_updated_at
on app_private.writing_drafts;
create trigger writing_drafts_set_updated_at
before update on app_private.writing_drafts
for each row execute function public.set_updated_at();

drop trigger if exists practice_drafts_set_updated_at
on app_private.practice_drafts;
create trigger practice_drafts_set_updated_at
before update on app_private.practice_drafts
for each row execute function public.set_updated_at();

create or replace function app_private.assert_writing_draft_context(
  target_batch_id uuid,
  target_source_type text,
  target_source_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_batch public.batches%rowtype;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if target_batch_id is null
    or target_source_type not in ('workspace_question', 'global_question', 'free_text')
  then
    raise exception using errcode = '22023', message = 'writing_context_invalid';
  end if;

  select batch.*
  into selected_batch
  from public.batches batch
  join public.batch_students assignment
    on assignment.batch_id = batch.id
   and assignment.workspace_id = batch.workspace_id
   and assignment.student_id = caller_id
  join public.workspace_members membership
    on membership.workspace_id = batch.workspace_id
   and membership.user_id = caller_id
   and membership.role = 'student'
  where batch.id = target_batch_id
    and batch.is_active
  for share of batch;

  if selected_batch.id is null then
    raise exception using errcode = '42501', message = 'active_class_membership_required';
  end if;

  if target_source_type = 'free_text' then
    if target_source_id is not null then
      raise exception using errcode = '22023', message = 'writing_context_invalid';
    end if;
  elsif target_source_type = 'workspace_question' then
    if target_source_id is null or not exists (
      select 1
      from public.questions question
      where question.id = target_source_id
        and question.workspace_id = selected_batch.workspace_id
        and question.level = selected_batch.level
        and question.is_active
    ) then
      raise exception using errcode = '22023', message = 'writing_question_unavailable';
    end if;
  elsif target_source_id is null or not exists (
    select 1
    from public.global_questions question
    where question.id = target_source_id
      and question.level = selected_batch.level
      and question.is_active
  ) then
    raise exception using errcode = '22023', message = 'writing_question_unavailable';
  end if;

  return selected_batch.workspace_id;
end;
$$;

revoke all on function app_private.assert_writing_draft_context(uuid, text, uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.assert_writing_draft_content(
  value text,
  allow_blank boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if value is null or (not allow_blank and value !~ '[^[:space:]]') then
    raise exception using errcode = '22023', message = 'writing_text_required';
  end if;
  if regexp_replace(value, E'[\t\n\r]', '', 'g') ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'writing_text_invalid';
  end if;
  if char_length(value) > 12000 then
    raise exception using errcode = '22023', message = 'writing_text_too_long';
  end if;
  if app_private.writing_feedback_unit_count(value) > 120 then
    raise exception using errcode = '22023', message = 'writing_too_many_units';
  end if;
end;
$$;

revoke all on function app_private.assert_writing_draft_content(text, boolean)
from public, anon, authenticated, service_role;

create or replace function api.save_writing_draft(
  draft_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  "text" text,
  expected_revision integer
)
returns table (
  saved_draft_id uuid,
  workspace_id uuid,
  saved_revision integer,
  saved_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  selected_workspace_id uuid;
  selected_draft app_private.writing_drafts%rowtype;
begin
  selected_workspace_id := app_private.assert_writing_draft_context(
    batch_id,
    source_type,
    source_id
  );
  perform app_private.assert_writing_draft_content("text", true);

  if draft_id is null then
    if coalesce(expected_revision, 0) <> 0 then
      raise exception using errcode = '40001', message = 'draft_revision_conflict';
    end if;
    begin
      insert into app_private.writing_drafts (
        workspace_id,
        student_id,
        batch_id,
        source_type,
        source_id,
        content
      ) values (
        selected_workspace_id,
        caller_id,
        batch_id,
        source_type,
        source_id,
        "text"
      )
      returning * into selected_draft;
    exception when unique_violation then
      raise exception using errcode = '40001', message = 'draft_revision_conflict';
    end;
  else
    select draft.*
    into selected_draft
    from app_private.writing_drafts draft
    where draft.id = draft_id
      and draft.student_id = caller_id
    for update;

    if selected_draft.id is null then
      raise exception using errcode = 'P0002', message = 'draft_not_found';
    end if;
    if selected_draft.revision <> expected_revision then
      raise exception using errcode = '40001', message = 'draft_revision_conflict';
    end if;

    update app_private.writing_drafts draft
    set
      workspace_id = selected_workspace_id,
      batch_id = $2,
      source_type = $3,
      source_id = $4,
      content = $5,
      revision = draft.revision + 1
    where draft.id = selected_draft.id
    returning * into selected_draft;
  end if;

  return query
  select
    selected_draft.id,
    selected_draft.workspace_id,
    selected_draft.revision,
    selected_draft.updated_at;
end;
$$;

create or replace function api.get_writing_draft(target_draft_id uuid)
returns table (
  draft_id uuid,
  workspace_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  "text" text,
  revision integer,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    draft.id,
    draft.workspace_id,
    draft.batch_id,
    draft.source_type,
    draft.source_id,
    draft.content,
    draft.revision,
    draft.updated_at
  from app_private.writing_drafts draft
  where draft.id = target_draft_id
    and draft.student_id = (select auth.uid());
$$;

create or replace function api.list_my_writing_drafts(
  target_workspace_id uuid,
  page_size integer default 25
)
returns table (
  draft_id uuid,
  batch_id uuid,
  source_type text,
  source_id uuid,
  preview text,
  character_count integer,
  revision integer,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    draft.id,
    draft.batch_id,
    draft.source_type,
    draft.source_id,
    left(regexp_replace(draft.content, '[[:space:]]+', ' ', 'g'), 160),
    char_length(draft.content),
    draft.revision,
    draft.updated_at
  from app_private.writing_drafts draft
  where draft.student_id = (select auth.uid())
    and draft.workspace_id = target_workspace_id
    and exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = target_workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
  order by draft.updated_at desc, draft.id desc
  limit greatest(1, least(coalesce(page_size, 25), 100));
$$;

create or replace function api.submit_writing_draft(
  target_draft_id uuid,
  expected_revision integer
)
returns table (
  submission_id uuid,
  evaluation_status text,
  release_status text,
  release_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_draft app_private.writing_drafts%rowtype;
  created record;
begin
  select draft.*
  into selected_draft
  from app_private.writing_drafts draft
  where draft.id = target_draft_id
    and draft.student_id = (select auth.uid())
  for update;

  if selected_draft.id is null then
    raise exception using errcode = 'P0002', message = 'draft_not_found';
  end if;
  if selected_draft.revision <> expected_revision then
    raise exception using errcode = '40001', message = 'draft_revision_conflict';
  end if;

  perform app_private.assert_writing_draft_context(
    selected_draft.batch_id,
    selected_draft.source_type,
    selected_draft.source_id
  );
  perform app_private.assert_writing_draft_content(selected_draft.content, false);

  select submitted.*
  into created
  from public.create_writing_submission(
    selected_draft.source_type,
    selected_draft.source_id,
    selected_draft.batch_id,
    selected_draft.content,
    false
  ) submitted;

  delete from app_private.writing_drafts draft
  where draft.id = selected_draft.id;

  return query
  select
    submission.id,
    submission.evaluation_status,
    submission.release_status,
    submission.release_at
  from public.submissions submission
  where submission.id = created.submission_id;
end;
$$;

create or replace function app_private.assert_practice_draft_context(
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
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  select assignment.*
  into selected_assignment
  from public.student_practice_assignments assignment
  where assignment.id = target_assignment_id
    and assignment.student_id = (select auth.uid())
  for update;

  if selected_assignment.id is null then
    raise exception using errcode = 'P0002', message = 'practice_assignment_not_found';
  end if;
  if selected_assignment.status not in ('unlocked', 'in_progress')
    or selected_assignment.generation_status <> 'ready'
    or selected_assignment.practice_test_id is null
    or not exists (
      select 1
      from public.workspace_members membership
      where membership.workspace_id = selected_assignment.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.role = 'student'
    )
  then
    raise exception using errcode = '55000', message = 'practice_assignment_inactive';
  end if;
  return selected_assignment;
end;
$$;

revoke all on function app_private.assert_practice_draft_context(uuid)
from public, anon, authenticated, service_role;

create or replace function app_private.assert_practice_draft_answers(
  target_practice_test_id uuid,
  submitted_answers jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if submitted_answers is null
    or jsonb_typeof(submitted_answers) <> 'array'
    or jsonb_array_length(submitted_answers) > 50
    or octet_length(submitted_answers::text) > 60000
    or exists (
      select 1
      from jsonb_array_elements(submitted_answers) answer_item
      where jsonb_typeof(answer_item) <> 'object'
        or not (answer_item ?& array['question_id', 'answer'])
        or coalesce(answer_item ->> 'question_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(answer_item -> 'answer') <> 'string'
        or char_length(answer_item ->> 'answer') > 1000
        or not exists (
          select 1
          from public.practice_test_questions question
          where question.id = (answer_item ->> 'question_id')::uuid
            and question.practice_test_id = target_practice_test_id
        )
    )
    or (
      select count(*) <> count(distinct answer_item ->> 'question_id')
      from jsonb_array_elements(submitted_answers) answer_item
    )
  then
    raise exception using errcode = '22023', message = 'practice_answers_invalid';
  end if;
end;
$$;

revoke all on function app_private.assert_practice_draft_answers(uuid, jsonb)
from public, anon, authenticated, service_role;

create or replace function api.save_practice_draft(
  target_assignment_id uuid,
  submitted_answers jsonb,
  expected_revision integer
)
returns table (
  draft_id uuid,
  assignment_id uuid,
  saved_revision integer,
  answers jsonb,
  saved_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_assignment public.student_practice_assignments%rowtype;
  selected_draft app_private.practice_drafts%rowtype;
begin
  selected_assignment := app_private.assert_practice_draft_context(target_assignment_id);
  perform app_private.assert_practice_draft_answers(
    selected_assignment.practice_test_id,
    submitted_answers
  );

  select draft.*
  into selected_draft
  from app_private.practice_drafts draft
  where draft.assignment_id = target_assignment_id
    and draft.student_id = (select auth.uid())
  for update;

  if selected_draft.id is null then
    if coalesce(expected_revision, 0) <> 0 then
      raise exception using errcode = '40001', message = 'draft_revision_conflict';
    end if;
    insert into app_private.practice_drafts (
      assignment_id,
      workspace_id,
      student_id,
      answers
    ) values (
      selected_assignment.id,
      selected_assignment.workspace_id,
      selected_assignment.student_id,
      submitted_answers
    )
    returning * into selected_draft;
  else
    if selected_draft.revision <> expected_revision then
      raise exception using errcode = '40001', message = 'draft_revision_conflict';
    end if;
    update app_private.practice_drafts draft
    set answers = submitted_answers,
        revision = draft.revision + 1
    where draft.id = selected_draft.id
    returning * into selected_draft;
  end if;

  update public.student_practice_assignments assignment
  set status = 'in_progress',
      started_at = coalesce(assignment.started_at, now())
  where assignment.id = selected_assignment.id
    and assignment.status = 'unlocked';

  return query
  select
    selected_draft.id,
    selected_draft.assignment_id,
    selected_draft.revision,
    selected_draft.answers,
    selected_draft.updated_at;
end;
$$;

create or replace function api.get_practice_draft(target_assignment_id uuid)
returns table (
  draft_id uuid,
  assignment_id uuid,
  revision integer,
  answers jsonb,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    draft.id,
    draft.assignment_id,
    draft.revision,
    draft.answers,
    draft.updated_at
  from app_private.practice_drafts draft
  join public.student_practice_assignments assignment
    on assignment.id = draft.assignment_id
  join public.workspace_members membership
    on membership.workspace_id = draft.workspace_id
   and membership.user_id = (select auth.uid())
   and membership.role = 'student'
  where draft.assignment_id = target_assignment_id
    and draft.student_id = (select auth.uid())
    and assignment.student_id = (select auth.uid());
$$;

create or replace function api.submit_practice_attempt(
  target_assignment_id uuid,
  expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_assignment public.student_practice_assignments%rowtype;
  selected_draft app_private.practice_drafts%rowtype;
  submitted_result jsonb;
begin
  selected_assignment := app_private.assert_practice_draft_context(target_assignment_id);

  select draft.*
  into selected_draft
  from app_private.practice_drafts draft
  where draft.assignment_id = target_assignment_id
    and draft.student_id = (select auth.uid())
  for update;

  if selected_draft.id is null then
    raise exception using errcode = 'P0002', message = 'draft_not_found';
  end if;
  if selected_draft.revision <> expected_revision then
    raise exception using errcode = '40001', message = 'draft_revision_conflict';
  end if;
  perform app_private.assert_practice_draft_answers(
    selected_assignment.practice_test_id,
    selected_draft.answers
  );

  select to_jsonb(result)
  into submitted_result
  from public.submit_practice_attempt(
    target_assignment_id,
    selected_draft.answers
  ) result;

  if submitted_result is null then
    raise exception using errcode = '55000', message = 'practice_submit_failed';
  end if;

  delete from app_private.practice_drafts draft
  where draft.id = selected_draft.id;

  return submitted_result;
end;
$$;

revoke all on function api.save_writing_draft(uuid, uuid, text, uuid, text, integer)
from public, anon;
revoke all on function api.get_writing_draft(uuid)
from public, anon;
revoke all on function api.list_my_writing_drafts(uuid, integer)
from public, anon;
revoke all on function api.submit_writing_draft(uuid, integer)
from public, anon;
revoke all on function api.save_practice_draft(uuid, jsonb, integer)
from public, anon;
revoke all on function api.get_practice_draft(uuid)
from public, anon;
revoke all on function api.submit_practice_attempt(uuid, integer)
from public, anon;

grant execute on function api.save_writing_draft(uuid, uuid, text, uuid, text, integer)
to authenticated;
grant execute on function api.get_writing_draft(uuid)
to authenticated;
grant execute on function api.list_my_writing_drafts(uuid, integer)
to authenticated;
grant execute on function api.submit_writing_draft(uuid, integer)
to authenticated;
grant execute on function api.save_practice_draft(uuid, jsonb, integer)
to authenticated;
grant execute on function api.get_practice_draft(uuid)
to authenticated;
grant execute on function api.submit_practice_attempt(uuid, integer)
to authenticated;
