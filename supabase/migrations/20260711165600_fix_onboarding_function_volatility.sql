-- Phase 12O: align the onboarding reader's declared volatility with its
-- authorization dependency and remove one dead declaration. Phase 11I is
-- already applied on staging, so this is deliberately a forward-only repair.

-- This helper only reads the transaction snapshot: auth.uid(), workspace
-- membership, and the STABLE has_workspace_role helper. Marking it STABLE lets
-- the STABLE onboarding reader call it without an invalid volatility chain.
alter function app_private.assert_onboarding_context(uuid, text) stable;

create or replace function public.get_onboarding_progress_internal(
  target_workspace_id uuid,
  target_role text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  caller_id uuid;
  stored_steps text[] := array[]::text[];
  completed text[] := array[]::text[];
  checklist_steps text[];
  selected_revision integer := 0;
begin
  caller_id := app_private.assert_onboarding_context(
    target_workspace_id,
    target_role
  );

  select progress.completed_steps, progress.revision
  into stored_steps, selected_revision
  from app_private.onboarding_progress progress
  where progress.user_id = caller_id
    and progress.workspace_id = target_workspace_id
    and progress.role = target_role;

  stored_steps := coalesce(stored_steps, array[]::text[]);
  selected_revision := coalesce(selected_revision, 0);

  if target_role = 'teacher' then
    checklist_steps := array[
      'create_class',
      'choose_feedback_mode',
      'share_join_code',
      'review_first_submission'
    ]::text[];

    if 'create_class' = any(stored_steps) or exists (
      select 1
      from public.batches batch
      where batch.workspace_id = target_workspace_id
    ) then
      completed := array_append(completed, 'create_class');
    end if;

    if 'choose_feedback_mode' = any(stored_steps) or exists (
      select 1
      from public.batches batch
      where batch.workspace_id = target_workspace_id
        and batch.feedback_mode in (
          'immediate',
          'automatic_delayed',
          'teacher_review_only'
        )
    ) then
      completed := array_append(completed, 'choose_feedback_mode');
    end if;

    if 'share_join_code' = any(stored_steps) or exists (
      select 1
      from public.batch_join_requests request
      where request.workspace_id = target_workspace_id
    ) or exists (
      select 1
      from public.batch_students assignment
      where assignment.workspace_id = target_workspace_id
    ) then
      completed := array_append(completed, 'share_join_code');
    end if;

    -- The historical step identifier is retained for compatibility, but the
    -- V1 product task is now "check the first result", not "manually release
    -- the first result". Immediate and scheduled classes therefore complete
    -- this step after any safely released result; teacher-review classes still
    -- complete it after their first release through the same state contract.
    if 'review_first_submission' = any(stored_steps) or exists (
      select 1
      from public.submissions submission
      where submission.workspace_id = target_workspace_id
        and submission.evaluation_status = 'ready'
        and submission.release_status = 'released'
    ) then
      completed := array_append(completed, 'review_first_submission');
    end if;
  else
    checklist_steps := array[
      'join_class',
      'submit_writing',
      'review_feedback',
      'start_practice'
    ]::text[];

    if 'join_class' = any(stored_steps) or exists (
      select 1
      from public.batch_students assignment
      where assignment.workspace_id = target_workspace_id
        and assignment.student_id = caller_id
    ) then
      completed := array_append(completed, 'join_class');
    end if;

    if 'submit_writing' = any(stored_steps) or exists (
      select 1
      from public.submissions submission
      where submission.workspace_id = target_workspace_id
        and submission.student_id = caller_id
    ) then
      completed := array_append(completed, 'submit_writing');
    end if;

    if 'review_feedback' = any(stored_steps) then
      completed := array_append(completed, 'review_feedback');
    end if;

    if 'start_practice' = any(stored_steps) or exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.workspace_id = target_workspace_id
        and assignment.student_id = caller_id
        and (
          assignment.started_at is not null
          or assignment.latest_attempt_id is not null
          or assignment.status in ('in_progress', 'completed', 'passed', 'failed')
        )
    ) then
      completed := array_append(completed, 'start_practice');
    end if;
  end if;

  return jsonb_build_object(
    'role', target_role,
    'revision', selected_revision,
    'steps', to_jsonb(checklist_steps),
    'completed_steps', to_jsonb(completed),
    'completed_count', cardinality(completed),
    'total_count', cardinality(checklist_steps),
    'all_complete', cardinality(completed) = cardinality(checklist_steps),
    'next_step', (
      select candidate
      from unnest(checklist_steps) with ordinality ordered(candidate, position)
      where not candidate = any(completed)
      order by position
      limit 1
    )
  );
end;
$$;

-- CREATE OR REPLACE preserves ownership and ACLs. Repeat the reviewed Phase
-- 11I grants explicitly so privilege drift cannot hide inside this repair.
revoke all on function app_private.assert_onboarding_context(uuid, text)
from public, anon, authenticated, service_role;

revoke all on function public.get_onboarding_progress_internal(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.get_onboarding_progress_internal(uuid, text)
to authenticated;
