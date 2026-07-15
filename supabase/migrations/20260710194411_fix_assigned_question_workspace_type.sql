-- Keep the assigned-question JSON shape uniform across workspace and global
-- questions. PostgreSQL resolves UNION column types before JSON conversion, so
-- both branches must expose workspace_id as text.
create or replace function api.list_student_assigned_questions(target_student_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
stable
as $$
declare
  actor_id uuid := (select auth.uid());
  result jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if target_student_id is null then
    raise exception using errcode = '22023', message = 'student_required';
  end if;

  if actor_id <> target_student_id and not public.is_platform_admin() then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  with active_contexts as materialized (
    select
      assignment.workspace_id,
      assignment.batch_id,
      batch.name as batch_name,
      batch.level
    from public.batch_students assignment
    join public.batches batch
      on batch.id = assignment.batch_id
      and batch.workspace_id = assignment.workspace_id
    join public.workspace_members membership
      on membership.workspace_id = assignment.workspace_id
      and membership.user_id = assignment.student_id
      and membership.role = 'student'
    where assignment.student_id = target_student_id
      and batch.is_active
  ),
  assigned_questions as (
    select
      question.id,
      question.workspace_id::text as workspace_id,
      'workspace'::text as source,
      context.batch_id,
      context.batch_name,
      question.title,
      question.prompt,
      question.level,
      question.topic,
      question.task_type,
      question.expected_word_min,
      question.expected_word_max,
      question.estimated_minutes,
      question.is_active,
      question.created_by,
      question.created_at,
      question.updated_at
    from active_contexts context
    join public.questions question
      on question.workspace_id = context.workspace_id
      and question.level = context.level
      and question.is_active

    union all

    select
      question.id,
      'global'::text as workspace_id,
      'global'::text as source,
      context.batch_id,
      context.batch_name,
      question.title,
      question.prompt,
      question.level,
      question.topic,
      question.task_type,
      question.expected_word_min,
      question.expected_word_max,
      question.estimated_minutes,
      question.is_active,
      question.created_by,
      question.created_at,
      question.updated_at
    from active_contexts context
    join public.global_questions question
      on question.level = context.level
      and question.is_active
  )
  select coalesce(
    jsonb_agg(
      to_jsonb(assigned_question)
      order by assigned_question.batch_name,
        assigned_question.source,
        assigned_question.created_at desc,
        assigned_question.id
    ),
    '[]'::jsonb
  )
  into result
  from assigned_questions assigned_question;

  return result;
end;
$$;

revoke all on function api.list_student_assigned_questions(uuid)
from public, anon, authenticated, service_role;
grant execute on function api.list_student_assigned_questions(uuid)
to authenticated, service_role;

comment on function api.list_student_assigned_questions(uuid) is
  'Returns explicit batch-scoped writing tasks with a uniform text workspace identifier for workspace and global questions.';

notify pgrst, 'reload schema';
