-- Phase 7F-A review safety fix:
-- The submit scorer UUID validation was corrected in the previous migration,
-- but the post-submit review RPC still had one answer-map regex with the
-- non-standard 8-4-4-12 UUID shape. That could make saved student answers look
-- blank in review even after a successful submission.

do $$
declare
  target_function regprocedure;
  function_sql text;
  fixed_function_sql text;
  bad_uuid_regex text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  good_uuid_regex text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  foreach target_function in array array[
    'app_private.submit_practice_attempt_internal_phase_7d2_unchecked(uuid,jsonb)'::regprocedure,
    'app_private.get_practice_assignment_review_internal(uuid)'::regprocedure
  ]
  loop
    select pg_get_functiondef(target_function)
    into function_sql;

    fixed_function_sql := replace(function_sql, bad_uuid_regex, good_uuid_regex);

    if fixed_function_sql = function_sql then
      raise notice '% already uses the standard UUID shape.', target_function::text;
    else
      execute fixed_function_sql;
      raise notice '% UUID validation corrected.', target_function::text;
    end if;
  end loop;
end;
$$;
