begin;

select plan(5);

select has_function(
  'public',
  'practice_attempt_semantic_review_coverage_internal',
  array['uuid'],
  'terminal visibility has one actor-authorized semantic coverage helper'
);

select ok(
  (
    select routine.prosecdef
      and routine.provolatile = 's'
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
    from pg_proc routine
    where routine.oid =
      'public.practice_attempt_semantic_review_coverage_internal(uuid)'::regprocedure
  ),
  'the coverage helper is a stable definer with an empty search path'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.practice_attempt_semantic_review_coverage_internal(uuid)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.practice_attempt_semantic_review_coverage_internal(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.practice_attempt_semantic_review_coverage_internal(uuid)',
      'EXECUTE'
    ),
  'only authenticated actor reads and service recovery may derive coverage'
);

select ok(
  position(
    'practice_attempt_semantic_review_coverage_internal'
    in pg_get_functiondef(
      'public.get_practice_assignment_summary_internal_before_phase_13e(uuid)'::regprocedure
    )
  ) > 0
    and position(
      'question_stats.semantic_question_count'
      in pg_get_functiondef(
        'public.get_practice_assignment_summary_internal_before_phase_13e(uuid)'::regprocedure
      )
    ) = 0
    and position(
      'practice_attempt_semantic_review_coverage_internal'
      in pg_get_functiondef(
        'app_private.get_practice_assignment_review_internal(uuid)'::regprocedure
      )
    ) > 0,
  'both RPC read models derive terminal visibility from complete review coverage'
);

select ok(
  position(
    'practice_attempt_semantic_review_coverage_internal'
    in pg_get_viewdef('api.practice_test_attempts'::regclass, true)
  ) > 0,
  'the direct API attempt view uses the same fail-closed coverage boundary'
);

select * from finish(true);
rollback;
