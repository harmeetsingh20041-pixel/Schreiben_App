-- Phase 7F-A submit safety fix:
-- The Phase 7F-A open-evaluation migration accidentally tightened the internal
-- question_id UUID regex to 8-4-4-12 instead of the standard 8-4-4-4-12 shape.
-- Valid worksheet submissions then passed the outer submit guard but failed
-- inside the unchecked scoring function with the generic "answers invalid" error.

do $$
declare
  function_sql text;
  fixed_function_sql text;
  bad_uuid_regex text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  good_uuid_regex text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  select pg_get_functiondef(
    'app_private.submit_practice_attempt_internal_phase_7d2_unchecked(uuid,jsonb)'::regprocedure
  )
  into function_sql;

  fixed_function_sql := replace(function_sql, bad_uuid_regex, good_uuid_regex);

  if fixed_function_sql = function_sql then
    raise notice 'Practice submit UUID validation already uses the standard UUID shape.';
    return;
  end if;

  execute fixed_function_sql;
end;
$$;
