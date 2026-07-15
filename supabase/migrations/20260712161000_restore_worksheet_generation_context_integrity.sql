-- Restore the immutable class-context boundary after Phase 13F replaced the
-- worksheet loader for canonical-withdrawal handling.  The public worker path
-- remains api (SECURITY INVOKER) -> app_private (SECURITY DEFINER); only the
-- private helper changes, and valid version-one snapshots retain the exact
-- Phase 13G behavior.

create or replace function app_private.get_worksheet_generation_context_phase_13g(
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
declare
  selected_context record;
begin
  perform app_private.assert_service_role();

  -- Phase 12K deliberately refuses to reconstruct this provenance from live
  -- class membership.  A legacy or missing snapshot must yield no worker
  -- context even if a privileged caller invokes the loader directly.
  if not exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.id = target_assignment_id
      and assignment.class_context_version = 1
      and assignment.class_context_integrity in (
        'writing_snapshot', 'teacher_verified'
      )
  ) then
    return;
  end if;

  select context.*
  into selected_context
  from app_private.get_worksheet_generation_context_before_phase_13g(
    target_assignment_id
  ) context;

  if selected_context.assignment_id is null then
    return;
  end if;

  if selected_context.certified_template_revision_id is null
    and exists (
      select 1
      from public.student_practice_assignments assignment
      join app_private.practice_topic_level_assignment_gates gate
        on gate.grammar_topic_id = assignment.grammar_topic_id
       and gate.worksheet_level = assignment.worksheet_level
      where assignment.id = selected_context.assignment_id
        and assignment.source in ('weakness_auto', 'adaptive_repeat')
        and assignment.resolution_cycle_id is not null
        and not exists (
          select 1
          from app_private.practice_level_fit_opt_ins opt_in
          where opt_in.cycle_id = assignment.resolution_cycle_id
            and opt_in.grammar_topic_id = assignment.grammar_topic_id
            and opt_in.worksheet_level = assignment.worksheet_level
        )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'practice_level_fit_provider_generation_not_approved';
  end if;

  return query select
    selected_context.assignment_id,
    selected_context.workspace_id,
    selected_context.grammar_topic_id,
    selected_context.attached_practice_test_id,
    selected_context.assignment_status,
    selected_context.batch_id,
    selected_context.batch_name,
    selected_context.worksheet_level,
    selected_context.topic_name,
    selected_context.topic_slug,
    selected_context.topic_level,
    selected_context.topic_description,
    selected_context.reusable_practice_test_id,
    selected_context.certified_template_revision_id;
end;
$$;

-- The historical helper remains callable by the new definer as its owner, but
-- is no longer a second service-role entrypoint that could bypass the restored
-- integrity predicate.
revoke all on function
  app_private.get_worksheet_generation_context_before_phase_13g(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  app_private.get_worksheet_generation_context_phase_13g(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.get_worksheet_generation_context_phase_13g(uuid)
to service_role;

comment on function app_private.get_worksheet_generation_context_phase_13g(uuid)
is 'Service-only worksheet context loader. It rejects missing, legacy, or unverified immutable class context before canonical-bank or provider resolution.';

notify pgrst, 'reload schema';
