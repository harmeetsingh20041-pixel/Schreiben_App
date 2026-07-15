-- Phase 12P: make objective-only worksheet submission a coherent terminal
-- state at the moment the local score is committed.
--
-- The Phase 7F submitter already sets status=checked, assignment=passed/failed,
-- and evaluation_status=not_needed for a fully local worksheet, but it left
-- evaluation_completed_at null. Phase 12F/12L correctly require that timestamp
-- before exposing a grade, so otherwise a valid objective score stays masked
-- forever. Patch only the active legacy submitter and only its checked,
-- objective-only terminal branch.

do $phase_12p_patch_objective_completion$
declare
  target_function constant regprocedure :=
    'app_private.submit_practice_attempt_internal_phase_7d2_unchecked(uuid,jsonb)'::regprocedure;
  function_sql text;
  patched_sql text;
  old_fragment constant text := E'    evaluation_completed_at = null,\n    evaluation_error = null,';
  new_fragment constant text := E'    evaluation_completed_at = case\n      when next_evaluation_status = ''not_needed''\n        and next_attempt_status = ''checked''\n        and next_assignment_status in (''passed'', ''failed'')\n      then completed_time\n      else null\n    end,\n    evaluation_error = null,';
  first_anchor_position integer;
begin
  select pg_catalog.pg_get_functiondef(target_function)
  into function_sql;

  first_anchor_position := pg_catalog.strpos(function_sql, old_fragment);
  if function_sql is null
    or first_anchor_position = 0
    or pg_catalog.strpos(
      pg_catalog.substr(
        function_sql,
        first_anchor_position + pg_catalog.length(old_fragment)
      ),
      old_fragment
    ) > 0
  then
    raise exception using
      errcode = '55000',
      message = 'phase_12p_objective_completion_anchor_changed';
  end if;

  patched_sql := pg_catalog.replace(function_sql, old_fragment, new_fragment);
  if patched_sql = function_sql then
    raise exception using
      errcode = '55000',
      message = 'phase_12p_objective_completion_patch_failed';
  end if;

  execute patched_sql;

  select pg_catalog.pg_get_functiondef(target_function)
  into function_sql;
  if pg_catalog.strpos(function_sql, new_fragment) = 0
    or pg_catalog.strpos(function_sql, old_fragment) > 0
  then
    raise exception using
      errcode = '55000',
      message = 'phase_12p_objective_completion_not_persisted';
  end if;
end;
$phase_12p_patch_objective_completion$;

comment on function app_private.submit_practice_attempt_internal_phase_7d2_unchecked(
  uuid, jsonb
) is
  'Legacy transactional practice scorer patched through Phase 12P: checked objective-only submissions persist their terminal evaluation timestamp atomically.';
