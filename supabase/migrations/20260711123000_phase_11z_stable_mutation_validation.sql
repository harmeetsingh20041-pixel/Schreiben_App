-- Phase 11Z: keep null enum inputs on the stable browser error contract.
--
-- PostgreSQL's three-valued logic makes `value not in (...)` evaluate to NULL
-- for a NULL value. The Phase 11Y write bodies therefore relied on table
-- NOT NULL errors for four enum fields. Keep those already-deployed bodies
-- immutable, place a narrow authorized validation boundary in front of them,
-- and preserve the exposed SECURITY INVOKER API wrappers.

alter function public.create_workspace_batch_internal(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) rename to create_workspace_batch_write_internal;

alter function public.update_workspace_batch_internal(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) rename to update_workspace_batch_write_internal;

alter function public.create_workspace_question_internal(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) rename to create_workspace_question_write_internal;

alter function public.update_workspace_question_internal(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) rename to update_workspace_question_write_internal;

create or replace function public.create_workspace_batch_internal(
  target_workspace_id uuid,
  batch_name text,
  batch_level text,
  batch_description text default null,
  batch_is_active boolean default true,
  batch_join_code_enabled boolean default true,
  batch_feedback_mode text default 'immediate',
  batch_feedback_delay_min_minutes integer default 15,
  batch_feedback_delay_max_minutes integer default 180
)
returns table (batch_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if batch_level is null or batch_feedback_mode is null then
    raise exception using errcode = '22023', message = 'invalid_batch';
  end if;

  return query
  select *
  from public.create_workspace_batch_write_internal(
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
end;
$$;

create or replace function public.update_workspace_batch_internal(
  target_workspace_id uuid,
  target_batch_id uuid,
  batch_name text,
  batch_level text,
  batch_description text default null,
  batch_is_active boolean default true,
  batch_join_code_enabled boolean default true,
  batch_feedback_mode text default 'immediate',
  batch_feedback_delay_min_minutes integer default 15,
  batch_feedback_delay_max_minutes integer default 180
)
returns table (batch_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if batch_level is null or batch_feedback_mode is null then
    raise exception using errcode = '22023', message = 'invalid_batch';
  end if;

  return query
  select *
  from public.update_workspace_batch_write_internal(
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
end;
$$;

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
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if question_level is null or question_task_type is null then
    raise exception using errcode = '22023', message = 'invalid_question';
  end if;

  return query
  select *
  from public.create_workspace_question_write_internal(
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
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;
  if question_level is null or question_task_type is null then
    raise exception using errcode = '22023', message = 'invalid_question';
  end if;

  return query
  select *
  from public.update_workspace_question_write_internal(
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
end;
$$;

revoke all on function public.create_workspace_batch_write_internal(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.update_workspace_batch_write_internal(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.create_workspace_question_write_internal(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.update_workspace_question_write_internal(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;

revoke all on function public.create_workspace_batch_internal(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.update_workspace_batch_internal(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function public.create_workspace_question_internal(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.update_workspace_question_internal(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;

grant execute on function public.create_workspace_batch_internal(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) to authenticated, service_role;
grant execute on function public.update_workspace_batch_internal(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) to authenticated, service_role;
grant execute on function public.create_workspace_question_internal(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) to authenticated, service_role;
grant execute on function public.update_workspace_question_internal(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) to authenticated, service_role;

-- Recreate the SQL wrappers after the internal rename so their dependencies
-- resolve only to the validated internal boundaries.
create or replace function api.create_workspace_batch(
  target_workspace_id uuid,
  batch_name text,
  batch_level text,
  batch_description text default null,
  batch_is_active boolean default true,
  batch_join_code_enabled boolean default true,
  batch_feedback_mode text default 'immediate',
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
  batch_feedback_mode text default 'immediate',
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

revoke all on function api.create_workspace_batch(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function api.update_workspace_batch(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) from public, anon, authenticated, service_role;
revoke all on function api.create_workspace_question(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function api.update_workspace_question(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) from public, anon, authenticated, service_role;

grant execute on function api.create_workspace_batch(
  uuid, text, text, text, boolean, boolean, text, integer, integer
) to authenticated, service_role;
grant execute on function api.update_workspace_batch(
  uuid, uuid, text, text, text, boolean, boolean, text, integer, integer
) to authenticated, service_role;
grant execute on function api.create_workspace_question(
  uuid, text, text, text, text, text, integer, integer, integer, boolean
) to authenticated, service_role;
grant execute on function api.update_workspace_question(
  uuid, uuid, text, text, text, text, text, integer, integer, integer, boolean
) to authenticated, service_role;

notify pgrst, 'reload schema';
