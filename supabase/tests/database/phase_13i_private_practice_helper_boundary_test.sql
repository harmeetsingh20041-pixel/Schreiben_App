begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(4);

select ok(
  to_regprocedure(
    'app_private.get_practice_assignment_questions_internal(uuid)'
  ) is not null,
  'the private practice-question implementation exists'
);

select ok(
  not has_function_privilege(
    'anon',
    'app_private.get_practice_assignment_questions_internal(uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot execute the private implementation'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.get_practice_assignment_questions_internal(uuid)',
    'EXECUTE'
  ),
  'authenticated browser callers cannot execute the private implementation'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.get_practice_assignment_questions(uuid)',
    'EXECUTE'
  ),
  'authenticated callers retain the deliberate API facade'
);

select * from finish();
rollback;
