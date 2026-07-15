-- Phase 12G replaced the adaptive-cycle guard while adding immutable class
-- context and accidentally dropped the Phase 11W transitions into the
-- teacher-support hold. The assignment transition trigger still emits
-- `locked` after the configured failed-worksheet limit, so the third failure
-- aborted instead of stopping automatic paid work.
--
-- Patch only those two state lists in the current function definition. Exact
-- anchors make the migration fail closed if a preceding migration changes the
-- guard, and preserve every identity, context-integrity, evidence, resolved
-- history, and timestamp rule already present in the function.
do $restore_practice_teacher_support_transition$
declare
  function_definition text;
  updated_definition text;
  unlocked_transition text := $old$
  elsif old.state = 'unlocked' and new.state not in ('unlocked', 'in_progress', 'improving', 'mastered') then
$old$;
  unlocked_transition_with_hold text := $new$
  elsif old.state = 'unlocked' and new.state not in ('locked', 'unlocked', 'in_progress', 'improving', 'mastered') then
$new$;
  in_progress_transition text := $old$
  elsif old.state = 'in_progress' and new.state not in ('in_progress', 'unlocked', 'improving', 'mastered') then
$old$;
  in_progress_transition_with_hold text := $new$
  elsif old.state = 'in_progress' and new.state not in ('locked', 'in_progress', 'unlocked', 'improving', 'mastered') then
$new$;
begin
  select pg_get_functiondef(
    'app_private.guard_practice_resolution_cycle_update()'::regprocedure
  )
  into function_definition;

  if function_definition is null
    or position(unlocked_transition in function_definition) = 0
    or position(in_progress_transition in function_definition) = 0
    or position('new.class_context_integrity' in function_definition) = 0
    or position('Practice cycle class context is immutable.' in function_definition) = 0
    or position('Resolved practice cycles are immutable.' in function_definition) = 0
    or position('Frozen practice evidence cannot change.' in function_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'practice_teacher_support_transition_anchor_changed';
  end if;

  updated_definition := replace(
    function_definition,
    unlocked_transition,
    unlocked_transition_with_hold
  );
  updated_definition := replace(
    updated_definition,
    in_progress_transition,
    in_progress_transition_with_hold
  );

  if updated_definition is not distinct from function_definition
    or position(unlocked_transition in updated_definition) > 0
    or position(in_progress_transition in updated_definition) > 0
    or position(unlocked_transition_with_hold in updated_definition) = 0
    or position(in_progress_transition_with_hold in updated_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'practice_teacher_support_transition_patch_failed';
  end if;

  execute updated_definition;
end;
$restore_practice_teacher_support_transition$;

revoke all on function app_private.guard_practice_resolution_cycle_update()
from public, anon, authenticated, service_role;

comment on function app_private.guard_practice_resolution_cycle_update() is
  'Protects immutable adaptive-cycle identity, class context, evidence, and resolved history while permitting the bounded-failure teacher-support hold.';
