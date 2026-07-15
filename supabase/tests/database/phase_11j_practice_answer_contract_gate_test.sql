begin;

select plan(4);

select ok(
  to_regprocedure('api.submit_practice_attempt(uuid,jsonb)') is not null
    and not has_function_privilege(
      'authenticated',
      'api.submit_practice_attempt(uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.submit_practice_attempt(uuid,jsonb)',
      'EXECUTE'
    ),
  'the legacy raw-answer API overload is not browser executable'
);

select ok(
  to_regprocedure('api.submit_practice_attempt(uuid,integer)') is not null
    and has_function_privilege(
      'authenticated',
      'api.submit_practice_attempt(uuid,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.submit_practice_attempt(uuid,integer)',
      'EXECUTE'
    ),
  'the revision-safe practice submit API remains authenticated-only'
);

select ok(
  to_regprocedure(
    'public.submit_practice_attempt_phase_11j_unchecked(uuid,jsonb)'
  ) is not null
    and not has_function_privilege(
      'authenticated',
      'public.submit_practice_attempt_phase_11j_unchecked(uuid,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'public.submit_practice_attempt(uuid,jsonb)',
      'EXECUTE'
    ),
  'only the validated non-exposed wrapper can reach the legacy submit body'
);

select ok(
  to_regprocedure(
    'app_private.assert_practice_assignment_answer_contract(uuid)'
  ) is not null
    and not has_function_privilege(
      'authenticated',
      'app_private.assert_practice_assignment_answer_contract(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.assert_practice_assignment_answer_contract(uuid)',
      'EXECUTE'
    ),
  'the worksheet contract assertion remains private'
);

select * from finish();
rollback;
