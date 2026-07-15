-- Phase 11Y: preserve RPC-only browser mutations after direct table DML was
-- revoked in Phase 11V.
--
-- The exposed api schema remains SECURITY INVOKER. Privileged writes live in
-- non-exposed, explicitly-authorized SECURITY DEFINER implementations. This
-- keeps authenticated users unable to write tables directly while restoring
-- the reviewed teacher class, task, and assignment commands.

alter function api.create_workspace_batch(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) set schema public;
alter function public.create_workspace_batch(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) rename to create_workspace_batch_internal;

alter function api.update_workspace_batch(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) set schema public;
alter function public.update_workspace_batch(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) rename to update_workspace_batch_internal;

alter function api.set_batch_active(uuid, uuid, boolean) set schema public;
alter function public.set_batch_active(uuid, uuid, boolean)
  rename to set_batch_active_internal;

alter function api.create_workspace_question(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) set schema public;
alter function public.create_workspace_question(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) rename to create_workspace_question_internal;

alter function api.update_workspace_question(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) set schema public;
alter function public.update_workspace_question(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) rename to update_workspace_question_internal;

alter function api.set_question_active(uuid, uuid, boolean) set schema public;
alter function public.set_question_active(uuid, uuid, boolean)
  rename to set_question_active_internal;

alter function api.assign_student_to_batch(uuid, uuid, uuid) set schema public;
alter function public.assign_student_to_batch(uuid, uuid, uuid)
  rename to assign_student_to_batch_internal;

alter function api.remove_student_batch_assignment(uuid, uuid)
  set schema public;
alter function public.remove_student_batch_assignment(uuid, uuid)
  rename to remove_student_batch_assignment_internal;

alter function public.create_workspace_batch_internal(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) security definer;
alter function public.update_workspace_batch_internal(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) security definer;
alter function public.set_batch_active_internal(uuid, uuid, boolean)
  security definer;
alter function public.create_workspace_question_internal(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) security definer;
alter function public.update_workspace_question_internal(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) security definer;
alter function public.set_question_active_internal(uuid, uuid, boolean)
  security definer;
alter function public.assign_student_to_batch_internal(uuid, uuid, uuid)
  security definer;
alter function public.remove_student_batch_assignment_internal(uuid, uuid)
  security definer;

-- Keep the write contract aligned with the existing database constraint and
-- every task type offered by the teacher UI.
create or replace function public.create_workspace_question_internal(
  target_workspace_id uuid,
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text,
  question_task_type text,
  question_expected_word_min integer default null,
  question_expected_word_max integer default null,
  question_estimated_minutes integer default null,
  question_is_active boolean default true
)
returns table (question_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  created_id uuid;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_workspace_id is null
    or question_title is null or length(btrim(question_title)) not between 1 and 240
    or question_prompt is null or length(btrim(question_prompt)) not between 1 and 12000
    or question_level not in ('A1', 'A2', 'B1', 'B2')
    or question_topic is null or length(btrim(question_topic)) not between 1 and 160
    or question_task_type not in (
      'email',
      'message',
      'description',
      'opinion',
      'apology',
      'invitation',
      'formal_letter',
      'free_text',
      'writing'
    )
    or (question_expected_word_min is not null and question_expected_word_min not between 0 and 5000)
    or (question_expected_word_max is not null and question_expected_word_max not between 0 and 5000)
    or (
      question_expected_word_min is not null
      and question_expected_word_max is not null
      and question_expected_word_min > question_expected_word_max
    )
    or (question_estimated_minutes is not null and question_estimated_minutes not between 0 and 1440)
  then
    raise exception using errcode = '22023', message = 'invalid_question';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  insert into public.questions (
    workspace_id,
    created_by,
    title,
    prompt,
    level,
    topic,
    task_type,
    expected_word_min,
    expected_word_max,
    estimated_minutes,
    is_active
  ) values (
    target_workspace_id,
    actor_id,
    btrim(question_title),
    btrim(question_prompt),
    question_level,
    btrim(question_topic),
    question_task_type,
    question_expected_word_min,
    question_expected_word_max,
    question_estimated_minutes,
    coalesce(question_is_active, true)
  )
  returning id into created_id;

  return query select created_id;
end;
$$;

create or replace function public.update_workspace_question_internal(
  target_workspace_id uuid,
  target_question_id uuid,
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text,
  question_task_type text,
  question_expected_word_min integer default null,
  question_expected_word_max integer default null,
  question_estimated_minutes integer default null,
  question_is_active boolean default true
)
returns table (question_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_question_id is null
    or target_workspace_id is null
    or question_title is null or length(btrim(question_title)) not between 1 and 240
    or question_prompt is null or length(btrim(question_prompt)) not between 1 and 12000
    or question_level not in ('A1', 'A2', 'B1', 'B2')
    or question_topic is null or length(btrim(question_topic)) not between 1 and 160
    or question_task_type not in (
      'email',
      'message',
      'description',
      'opinion',
      'apology',
      'invitation',
      'formal_letter',
      'free_text',
      'writing'
    )
    or (question_expected_word_min is not null and question_expected_word_min not between 0 and 5000)
    or (question_expected_word_max is not null and question_expected_word_max not between 0 and 5000)
    or (
      question_expected_word_min is not null
      and question_expected_word_max is not null
      and question_expected_word_min > question_expected_word_max
    )
    or (question_estimated_minutes is not null and question_estimated_minutes not between 0 and 1440)
  then
    raise exception using errcode = '22023', message = 'invalid_question';
  end if;

  if not public.is_platform_admin()
    and not public.has_workspace_role(target_workspace_id, array['owner', 'teacher'])
  then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  update public.questions question
  set
    title = btrim(question_title),
    prompt = btrim(question_prompt),
    level = question_level,
    topic = btrim(question_topic),
    task_type = question_task_type,
    expected_word_min = question_expected_word_min,
    expected_word_max = question_expected_word_max,
    estimated_minutes = question_estimated_minutes,
    is_active = coalesce(question_is_active, true)
  where question.id = target_question_id
    and question.workspace_id = target_workspace_id
  returning question.id into updated_id;

  if updated_id is null then
    raise exception using errcode = 'P0002', message = 'question_not_found';
  end if;

  return query select updated_id;
end;
$$;

revoke all on function public.create_workspace_batch_internal(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.update_workspace_batch_internal(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.set_batch_active_internal(uuid, uuid, boolean)
from public, anon, authenticated, service_role;
revoke all on function public.create_workspace_question_internal(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.update_workspace_question_internal(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.set_question_active_internal(uuid, uuid, boolean)
from public, anon, authenticated, service_role;
revoke all on function public.assign_student_to_batch_internal(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.remove_student_batch_assignment_internal(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function public.create_workspace_batch_internal(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) to authenticated, service_role;
grant execute on function public.update_workspace_batch_internal(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) to authenticated, service_role;
grant execute on function public.set_batch_active_internal(uuid, uuid, boolean)
to authenticated, service_role;
grant execute on function public.create_workspace_question_internal(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) to authenticated, service_role;
grant execute on function public.update_workspace_question_internal(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) to authenticated, service_role;
grant execute on function public.set_question_active_internal(uuid, uuid, boolean)
to authenticated, service_role;
grant execute on function public.assign_student_to_batch_internal(uuid, uuid, uuid)
to authenticated, service_role;
grant execute on function public.remove_student_batch_assignment_internal(uuid, uuid)
to authenticated, service_role;

create or replace function api.create_workspace_batch(
  target_workspace_id uuid,
  batch_name text,
  batch_level text,
  batch_description text default null,
  batch_is_active boolean default true,
  batch_join_code_enabled boolean default true,
  batch_feedback_mode text default 'teacher_review_only',
  batch_feedback_delay_min_minutes integer default 15,
  batch_feedback_delay_max_minutes integer default 180
)
returns table (batch_id uuid)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.create_workspace_batch_internal(
    target_workspace_id,
    batch_name,
    batch_level,
    batch_description,
    batch_is_active,
    batch_join_code_enabled,
    batch_feedback_mode,
    batch_feedback_delay_min_minutes,
    batch_feedback_delay_max_minutes
  );
$$;

create or replace function api.update_workspace_batch(
  target_workspace_id uuid,
  target_batch_id uuid,
  batch_name text,
  batch_level text,
  batch_description text default null,
  batch_is_active boolean default true,
  batch_join_code_enabled boolean default true,
  batch_feedback_mode text default 'teacher_review_only',
  batch_feedback_delay_min_minutes integer default 15,
  batch_feedback_delay_max_minutes integer default 180
)
returns table (batch_id uuid)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.update_workspace_batch_internal(
    target_workspace_id,
    target_batch_id,
    batch_name,
    batch_level,
    batch_description,
    batch_is_active,
    batch_join_code_enabled,
    batch_feedback_mode,
    batch_feedback_delay_min_minutes,
    batch_feedback_delay_max_minutes
  );
$$;

create or replace function api.set_batch_active(
  target_workspace_id uuid,
  target_batch_id uuid,
  target_is_active boolean
)
returns table (batch_id uuid, is_active boolean)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.set_batch_active_internal(
    target_workspace_id,
    target_batch_id,
    target_is_active
  );
$$;

create or replace function api.create_workspace_question(
  target_workspace_id uuid,
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text,
  question_task_type text,
  question_expected_word_min integer default null,
  question_expected_word_max integer default null,
  question_estimated_minutes integer default null,
  question_is_active boolean default true
)
returns table (question_id uuid)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.create_workspace_question_internal(
    target_workspace_id,
    question_title,
    question_prompt,
    question_level,
    question_topic,
    question_task_type,
    question_expected_word_min,
    question_expected_word_max,
    question_estimated_minutes,
    question_is_active
  );
$$;

create or replace function api.update_workspace_question(
  target_workspace_id uuid,
  target_question_id uuid,
  question_title text,
  question_prompt text,
  question_level text,
  question_topic text,
  question_task_type text,
  question_expected_word_min integer default null,
  question_expected_word_max integer default null,
  question_estimated_minutes integer default null,
  question_is_active boolean default true
)
returns table (question_id uuid)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.update_workspace_question_internal(
    target_workspace_id,
    target_question_id,
    question_title,
    question_prompt,
    question_level,
    question_topic,
    question_task_type,
    question_expected_word_min,
    question_expected_word_max,
    question_estimated_minutes,
    question_is_active
  );
$$;

create or replace function api.set_question_active(
  target_workspace_id uuid,
  target_question_id uuid,
  target_is_active boolean
)
returns table (question_id uuid, is_active boolean)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.set_question_active_internal(
    target_workspace_id,
    target_question_id,
    target_is_active
  );
$$;

create or replace function api.assign_student_to_batch(
  target_workspace_id uuid,
  target_student_id uuid,
  target_batch_id uuid
)
returns table (assignment_id uuid, created boolean)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.assign_student_to_batch_internal(
    target_workspace_id,
    target_student_id,
    target_batch_id
  );
$$;

create or replace function api.remove_student_batch_assignment(
  target_workspace_id uuid,
  target_assignment_id uuid
)
returns table (assignment_id uuid, removed boolean)
language sql
security invoker
set search_path = ''
as $$
  select *
  from public.remove_student_batch_assignment_internal(
    target_workspace_id,
    target_assignment_id
  );
$$;

revoke all on function api.create_workspace_batch(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function api.update_workspace_batch(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function api.set_batch_active(uuid, uuid, boolean)
from public, anon, authenticated, service_role;
revoke all on function api.create_workspace_question(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function api.update_workspace_question(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function api.set_question_active(uuid, uuid, boolean)
from public, anon, authenticated, service_role;
revoke all on function api.assign_student_to_batch(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function api.remove_student_batch_assignment(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function api.create_workspace_batch(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) to authenticated, service_role;
grant execute on function api.update_workspace_batch(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) to authenticated, service_role;
grant execute on function api.set_batch_active(uuid, uuid, boolean)
to authenticated, service_role;
grant execute on function api.create_workspace_question(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) to authenticated, service_role;
grant execute on function api.update_workspace_question(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) to authenticated, service_role;
grant execute on function api.set_question_active(uuid, uuid, boolean)
to authenticated, service_role;
grant execute on function api.assign_student_to_batch(uuid, uuid, uuid)
to authenticated, service_role;
grant execute on function api.remove_student_batch_assignment(uuid, uuid)
to authenticated, service_role;

comment on function api.create_workspace_batch(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) is 'Invoker-only browser facade for authorized class creation.';
comment on function api.create_workspace_question(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) is 'Invoker-only browser facade for authorized A1-B2 writing-task creation.';

notify pgrst, 'reload schema';
