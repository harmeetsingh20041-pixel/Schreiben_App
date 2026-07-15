begin;

select plan(26);

select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.practice_attempt_result_is_terminal(text,text,text,timestamptz,text,integer,integer,numeric,numeric,text,numeric,boolean,integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'service_role',
      'app_private.practice_attempt_result_is_terminal(text,text,text,timestamptz,text,integer,integer,numeric,numeric,text,numeric,boolean,integer)',
      'EXECUTE'
    )
    and (
      select not routine.prosecdef
        and routine.provolatile = 'i'
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
      from pg_proc routine
      where routine.oid =
        'app_private.practice_attempt_result_is_terminal(text,text,text,timestamptz,text,integer,integer,numeric,numeric,text,numeric,boolean,integer)'::regprocedure
    )
    and has_function_privilege(
      'authenticated',
      'public.get_practice_assignment_summary_internal(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.get_practice_assignment_summary_internal(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.get_practice_assignment_summary_internal(uuid)',
      'EXECUTE'
    )
    and (
      select routine.prosecdef
        and routine.provolatile = 's'
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
      from pg_proc routine
      where routine.oid =
        'public.get_practice_assignment_summary_internal(uuid)'::regprocedure
    )
    and has_function_privilege(
      'authenticated',
      'api.get_practice_assignment_summary(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'api.get_practice_assignment_summary(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_practice_assignment_summary(uuid)',
      'EXECUTE'
    )
    and (
      select not routine.prosecdef
        and routine.provolatile = 's'
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
      from pg_proc routine
      where routine.oid =
        'api.get_practice_assignment_summary(uuid)'::regprocedure
    )
    and pg_get_functiondef(
      'app_private.get_practice_assignment_review_internal(uuid)'::regprocedure
    ) like '%practice_attempt_result_is_terminal(%',
  'the canonical predicate is private and the stable API reaches its narrow definer bridge only through an invoker boundary'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.submit_practice_attempt(uuid,integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'api.submit_practice_attempt(uuid,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.submit_practice_attempt(uuid,integer)',
      'EXECUTE'
    )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'api.submit_practice_attempt(uuid,integer)'::regprocedure
    )
    and (
      select routine.provolatile = 'v'
      from pg_proc routine
      where routine.oid =
        'api.submit_practice_attempt(uuid,integer)'::regprocedure
    ),
  'the revision-safe submit remains a volatile authenticated security-invoker command'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'd6111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12f-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12F Owner"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd6222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12f-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12F Teacher"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd6333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase12f-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12F Student"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd6444444-4444-4444-8444-444444444444',
    'authenticated', 'authenticated', 'phase12f-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12F Outsider"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd6555555-5555-4555-8555-555555555555',
    'authenticated', 'authenticated', 'phase12f-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12F Administrator"}'::jsonb,
    now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'd6111111-1111-4111-8111-111111111111',
    'Phase 12F Owner',
    'phase12f-owner@example.test',
    'student'
  ),
  (
    'd6222222-2222-4222-8222-222222222222',
    'Phase 12F Teacher',
    'phase12f-teacher@example.test',
    'student'
  ),
  (
    'd6333333-3333-4333-8333-333333333333',
    'Phase 12F Student',
    'phase12f-student@example.test',
    'student'
  ),
  (
    'd6444444-4444-4444-8444-444444444444',
    'Phase 12F Outsider',
    'phase12f-outsider@example.test',
    'student'
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

-- The Auth synchronization trigger creates a student profile. Replace only
-- this transaction-owned fixture row to exercise the platform-admin path.
delete from public.profiles
where id = 'd6555555-5555-4555-8555-555555555555';

insert into public.profiles (id, full_name, email, global_role)
values (
  'd6555555-5555-4555-8555-555555555555',
  'Phase 12F Administrator',
  'phase12f-admin@example.test',
  'platform_admin'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd6666666-6666-4666-8666-666666666666',
  'Phase 12F Workspace',
  'phase-12f-workspace',
  'd6111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'd6111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd6666666-6666-4666-8666-666666666666',
  'd6111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'd6666666-6666-4666-8666-666666666666',
    'd6222222-2222-4222-8222-222222222222',
    'teacher'
  ),
  (
    'd6666666-6666-4666-8666-666666666666',
    'd6333333-3333-4333-8333-333333333333',
    'student'
  );

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'd6777777-7777-4777-8777-777777777777',
  'phase-12f-provisional-score',
  'Phase 12F provisional score',
  'B1',
  'Transactional fixture for provisional worksheet result visibility.'
);

insert into public.practice_tests (
  id,
  workspace_id,
  grammar_topic_id,
  level,
  difficulty,
  title,
  description,
  created_by_ai,
  teacher_reviewed,
  visibility,
  created_by,
  generation_source,
  quality_status
)
values (
  'd6888888-8888-4888-8888-888888888888',
  'd6666666-6666-4666-8666-666666666666',
  'd6777777-7777-4777-8777-777777777777',
  'B1',
  'medium',
  'Phase 12F mixed worksheet',
  'Contains one deterministic item and one semantic item.',
  false,
  true,
  'workspace',
  'd6111111-1111-4111-8111-111111111111',
  'manual_import',
  'approved'
);

insert into public.practice_test_questions (
  id,
  practice_test_id,
  question_number,
  question_type,
  evaluation_mode,
  prompt,
  options,
  correct_answer,
  accepted_answers,
  rubric,
  answer_contract_version,
  explanation
)
values
  (
    'd6999999-9999-4999-8999-999999999999',
    'd6888888-8888-4888-8888-888888888888',
    1,
    'multiple_choice',
    'local_exact',
    'Welcher Artikel passt: Ich sehe ___ Hund?',
    '["den","dem","der"]'::jsonb,
    'den',
    '["den"]'::jsonb,
    null,
    1,
    'The direct masculine object uses den.'
  ),
  (
    'd6aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'd6888888-8888-4888-8888-888888888888',
    2,
    'mini_writing',
    'open_evaluation',
    'Schreibe einen kurzen Satz mit weil.',
    null,
    'Ich bleibe zu Hause, weil ich krank bin.',
    '[]'::jsonb,
    '{"criteria":["Award one point for a coherent weil-clause with the finite verb at the end."],"sample_answer":"Ich bleibe zu Hause, weil ich krank bin."}'::jsonb,
    1,
    'A weil-clause places the finite verb at the end.'
  );

insert into public.practice_tests (
  id,
  workspace_id,
  grammar_topic_id,
  level,
  difficulty,
  title,
  description,
  created_by_ai,
  teacher_reviewed,
  visibility,
  created_by,
  generation_source,
  quality_status
)
values (
  'd6000000-0000-4000-8000-000000000010',
  'd6666666-6666-4666-8666-666666666666',
  'd6777777-7777-4777-8777-777777777777',
  'B1',
  'easy',
  'Phase 12F objective worksheet',
  'Contains only one deterministic item.',
  false,
  true,
  'workspace',
  'd6111111-1111-4111-8111-111111111111',
  'manual_import',
  'approved'
);

insert into public.practice_test_questions (
  id,
  practice_test_id,
  question_number,
  question_type,
  evaluation_mode,
  prompt,
  options,
  correct_answer,
  accepted_answers,
  rubric,
  answer_contract_version,
  explanation
)
values (
  'd6000000-0000-4000-8000-000000000011',
  'd6000000-0000-4000-8000-000000000010',
  1,
  'multiple_choice',
  'local_exact',
  'Welcher Artikel passt: Ich helfe ___ Mann?',
  '["dem","den","der"]'::jsonb,
  'dem',
  '["dem"]'::jsonb,
  null,
  1,
  'The indirect masculine object uses dem.'
);

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  source,
  status,
  assigned_by,
  assigned_at,
  started_at,
  completed_at,
  generation_status
)
values
  (
    'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'd6666666-6666-4666-8666-666666666666',
    'd6333333-3333-4333-8333-333333333333',
    'd6777777-7777-4777-8777-777777777777',
    'd6888888-8888-4888-8888-888888888888',
    'teacher_assigned',
    'completed',
    'd6222222-2222-4222-8222-222222222222',
    now() - interval '2 minutes',
    now() - interval '2 minutes',
    now() - interval '1 minute',
    'ready'
  ),
  (
    'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'd6666666-6666-4666-8666-666666666666',
    'd6333333-3333-4333-8333-333333333333',
    'd6777777-7777-4777-8777-777777777777',
    'd6888888-8888-4888-8888-888888888888',
    'teacher_assigned',
    'unlocked',
    'd6222222-2222-4222-8222-222222222222',
    now(),
    null,
    null,
    'ready'
  ),
  (
    'd6ffffff-ffff-4fff-8fff-ffffffffffff',
    'd6666666-6666-4666-8666-666666666666',
    'd6222222-2222-4222-8222-222222222222',
    'd6777777-7777-4777-8777-777777777777',
    'd6888888-8888-4888-8888-888888888888',
    'teacher_assigned',
    'completed',
    'd6111111-1111-4111-8111-111111111111',
    now(),
    now(),
    now(),
    'ready'
  ),
  (
    'd6000000-0000-4000-8000-000000000012',
    'd6666666-6666-4666-8666-666666666666',
    'd6333333-3333-4333-8333-333333333333',
    'd6777777-7777-4777-8777-777777777777',
    'd6000000-0000-4000-8000-000000000010',
    'teacher_assigned',
    'passed',
    'd6222222-2222-4222-8222-222222222222',
    now(),
    now(),
    now(),
    'ready'
  );

insert into public.practice_test_attempts (
  id,
  practice_test_id,
  student_id,
  workspace_id,
  answers,
  score,
  max_score,
  assignment_id,
  status,
  started_at,
  submitted_at,
  score_percent,
  passed,
  evaluation_status,
  evaluation_error,
  evaluation_version,
  score_points,
  max_score_points,
  scoring_version
)
values (
  'd6cccccc-cccc-4ccc-8ccc-cccccccccccc',
  'd6888888-8888-4888-8888-888888888888',
  'd6333333-3333-4333-8333-333333333333',
  'd6666666-6666-4666-8666-666666666666',
  '[{"question_id":"d6999999-9999-4999-8999-999999999999","answer":"den"},{"question_id":"d6aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","answer":"Ich bleibe zu Hause, weil ich bin krank."}]'::jsonb,
  1,
  2,
  'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'submitted',
  now() - interval '2 minutes',
  now() - interval '1 minute',
  50,
  false,
  'queued',
  'provider_timeout_private_detail',
  1,
  1,
  2,
  'phase_12f_provisional_v1'
), (
  'd6000000-0000-4000-8000-000000000001',
  'd6888888-8888-4888-8888-888888888888',
  'd6222222-2222-4222-8222-222222222222',
  'd6666666-6666-4666-8666-666666666666',
  '[{"question_id":"d6999999-9999-4999-8999-999999999999","answer":"den"},{"question_id":"d6aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","answer":"Ich bleibe zu Hause, weil ich bin krank."}]'::jsonb,
  1,
  2,
  'd6ffffff-ffff-4fff-8fff-ffffffffffff',
  'submitted',
  now(),
  now(),
  50,
  false,
  'queued',
  'manager_owned_private_detail',
  1,
  1,
  2,
  'phase_12f_manager_preview_v1'
), (
  'd6000000-0000-4000-8000-000000000013',
  'd6000000-0000-4000-8000-000000000010',
  'd6333333-3333-4333-8333-333333333333',
  'd6666666-6666-4666-8666-666666666666',
  '[{"question_id":"d6000000-0000-4000-8000-000000000011","answer":"dem"}]'::jsonb,
  1,
  1,
  'd6000000-0000-4000-8000-000000000012',
  'checked',
  now(),
  now(),
  100,
  true,
  'not_needed',
  null,
  0,
  1,
  1,
  'phase_12f_objective_v1'
);

update public.student_practice_assignments
set latest_attempt_id = 'd6cccccc-cccc-4ccc-8ccc-cccccccccccc'
where id = 'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

update public.student_practice_assignments
set latest_attempt_id = 'd6000000-0000-4000-8000-000000000001'
where id = 'd6ffffff-ffff-4fff-8fff-ffffffffffff';

update public.practice_test_attempts
set evaluation_completed_at = now(),
    completed_at = now()
where id = 'd6000000-0000-4000-8000-000000000013';

update public.student_practice_assignments
set latest_attempt_id = 'd6000000-0000-4000-8000-000000000013'
where id = 'd6000000-0000-4000-8000-000000000012';

insert into public.practice_attempt_question_reviews (
  id,
  attempt_id,
  assignment_id,
  workspace_id,
  student_id,
  question_id,
  review_status,
  points_awarded,
  max_points,
  evaluator_source,
  feedback_text,
  corrected_answer,
  model_answer,
  short_reason
)
values (
  'd6dddddd-dddd-4ddd-8ddd-dddddddddddd',
  'd6cccccc-cccc-4ccc-8ccc-cccccccccccc',
  'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'd6666666-6666-4666-8666-666666666666',
  'd6333333-3333-4333-8333-333333333333',
  'd6aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'incorrect',
  0,
  1,
  'manual',
  'Phase 12F private provisional feedback.',
  'Ich bleibe zu Hause, weil ich krank bin.',
  'Ich bleibe zu Hause, weil ich krank bin.',
  'The stored review must remain private while evaluation is queued.'
);

create temporary table phase_12f_state (
  practice_revision integer,
  submit_result jsonb
) on commit drop;
insert into phase_12f_state default values;
grant select, update on phase_12f_state to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'd6333333-3333-4333-8333-333333333333',
  true
);
set local role authenticated;

select ok(
  (
    select payload ->> 'latest_attempt_status' = 'submitted'
      and payload ->> 'evaluation_status' = 'queued'
      and payload ->> 'score' is null
      and payload ->> 'max_score' is null
      and payload ->> 'score_points' is null
      and payload ->> 'max_score_points' is null
      and payload ->> 'scoring_version' is null
      and payload ->> 'evaluation_error' is null
      and payload ->> 'score_percent' is null
      and payload ->> 'passed' is null
    from (
      select api.get_practice_assignment_summary(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) as payload
    ) summary
  ),
  'a student summary exposes pending state but masks every provisional grade field'
);

select ok(
  (
    select item ->> 'evaluation_status' = 'queued'
      and item ->> 'score' is null
      and item ->> 'max_score' is null
      and item ->> 'score_points' is null
      and item ->> 'max_score_points' is null
      and item ->> 'scoring_version' is null
      and item ->> 'evaluation_error' is null
      and item ->> 'score_percent' is null
      and item ->> 'passed' is null
    from jsonb_array_elements(
      api.list_student_practice_assignments_page(
        'd6666666-6666-4666-8666-666666666666',
        'd6333333-3333-4333-8333-333333333333',
        100,
        null,
        null
      ) -> 'items'
    ) item
    where item ->> 'id' = 'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ),
  'the student list uses the same masked pending-result contract'
);

select ok(
  (
    select payload ->> 'latest_attempt_status' = 'checked'
      and payload ->> 'evaluation_status' = 'not_needed'
      and (payload ->> 'score_points')::numeric = 1
      and (payload ->> 'max_score_points')::numeric = 1
      and payload ->> 'scoring_version' = 'phase_12f_objective_v1'
      and (payload ->> 'score_percent')::numeric = 100
      and payload ->> 'passed' = 'true'
    from (
      select api.get_practice_assignment_summary(
        'd6000000-0000-4000-8000-000000000012'
      ) as payload
    ) summary
  ),
  'a coherent objective-only not-needed result remains visible to its student'
);

select ok(
  (
    select payload ->> 'review_status' = 'submitted_for_review'
      and payload ->> 'score_points' is null
      and payload ->> 'max_score_points' is null
      and payload ->> 'scoring_version' is null
      and payload ->> 'evaluation_error' is null
      and payload ->> 'feedback_text' is null
      and payload ->> 'corrected_answer' is null
    from (
      select api.get_practice_assignment_review(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) -> 1 as payload
    ) review
  ),
  'the student review also hides provisional aggregates and semantic feedback'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  'd6222222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select ok(
  (
    select (payload ->> 'score_points')::numeric = 1
      and (payload ->> 'max_score_points')::numeric = 2
      and payload ->> 'scoring_version' = 'phase_12f_provisional_v1'
      and payload ->> 'evaluation_error' = 'provider_timeout_private_detail'
      and (payload ->> 'score_percent')::numeric = 50
      and payload ->> 'passed' = 'false'
      and api.get_practice_assignment_summary(
        'd6ffffff-ffff-4fff-8fff-ffffffffffff'
      ) ->> 'evaluation_error' = 'manager_owned_private_detail'
    from (
      select api.get_practice_assignment_summary(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) as payload
    ) summary
  ),
  'manager authority retains raw recovery detail even when the manager is also the assignment student'
);

select ok(
  (
    select (item ->> 'score_points')::numeric = 1
      and item ->> 'scoring_version' = 'phase_12f_provisional_v1'
      and item ->> 'evaluation_error' = 'provider_timeout_private_detail'
    from jsonb_array_elements(
      api.list_student_practice_assignments_page(
        'd6666666-6666-4666-8666-666666666666',
        'd6333333-3333-4333-8333-333333333333',
        100,
        null,
        null
      ) -> 'items'
    ) item
    where item ->> 'id' = 'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ),
  'teacher list recovery detail remains available without another read path'
);

select ok(
  (
    select payload ->> 'feedback_text' =
        'Phase 12F private provisional feedback.'
      and (payload ->> 'score_points')::numeric = 1
      and payload ->> 'scoring_version' = 'phase_12f_provisional_v1'
    from (
      select api.get_practice_assignment_review(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) -> 1 as payload
    ) review
  ),
  'teacher review recovery detail remains available while the attempt is queued'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  'd6555555-5555-4555-8555-555555555555',
  true
);
set local role authenticated;

select is(
  api.get_practice_assignment_summary(
    'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) ->> 'evaluation_error',
  'provider_timeout_private_detail'::text,
  'a platform administrator retains raw recovery detail without membership'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  'd6444444-4444-4444-8444-444444444444',
  true
);
set local role authenticated;

select throws_ok(
  $$
    select api.get_practice_assignment_summary(
      'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
  $$,
  'P0002',
  'practice_assignment_not_found',
  'an unrelated authenticated user cannot discover the assignment summary'
);

reset role;
update public.practice_test_attempts
set
  evaluation_status = 'evaluating',
  evaluation_started_at = now(),
  evaluation_error = null
where id = 'd6cccccc-cccc-4ccc-8ccc-cccccccccccc';

select set_config(
  'request.jwt.claim.sub',
  'd6333333-3333-4333-8333-333333333333',
  true
);
set local role authenticated;

select ok(
  (
    select payload ->> 'evaluation_status' = 'evaluating'
      and payload ->> 'score_points' is null
      and payload ->> 'scoring_version' is null
      and payload ->> 'evaluation_error' is null
      and payload ->> 'score_percent' is null
      and payload ->> 'passed' is null
    from (
      select api.get_practice_assignment_summary(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) as payload
    ) summary
  ),
  'an evaluating attempt remains grade-private while progress stays visible'
);

reset role;
update public.practice_test_attempts
set
  evaluation_status = 'failed',
  evaluation_error = 'provider_failed_with_private_payload'
where id = 'd6cccccc-cccc-4ccc-8ccc-cccccccccccc';

set local role authenticated;

select ok(
  (
    select payload ->> 'evaluation_status' = 'failed'
      and payload ->> 'evaluation_error' = 'evaluation_failed'
      and payload ->> 'score_points' is null
      and payload ->> 'scoring_version' is null
      and payload ->> 'score_percent' is null
      and payload ->> 'passed' is null
    from (
      select api.get_practice_assignment_summary(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) as payload
    ) summary
  ),
  'a failed attempt exposes only a stable safe error code and no provisional grade'
);

reset role;
update public.practice_test_attempts
set
  status = 'checked',
  evaluation_status = 'queued',
  evaluation_error = null
where id = 'd6cccccc-cccc-4ccc-8ccc-cccccccccccc';

set local role authenticated;

select ok(
  (
    select payload ->> 'latest_attempt_status' = 'checked'
      and payload ->> 'evaluation_status' = 'queued'
      and payload ->> 'score_points' is null
      and payload ->> 'scoring_version' is null
      and payload ->> 'score_percent' is null
      and payload ->> 'passed' is null
    from (
      select api.get_practice_assignment_summary(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) as payload
    ) summary
  ),
  'checked alone does not reveal a result while semantic evaluation is queued'
);

reset role;
update public.student_practice_assignments
set status = 'passed'
where id = 'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

update public.practice_test_attempts
set
  evaluation_status = 'not_needed',
  evaluation_error = null,
  evaluation_completed_at = now(),
  score = 2,
  max_score = 2,
  score_points = 2,
  max_score_points = 2,
  score_percent = 100,
  passed = true,
  scoring_version = 'phase_12f_final_v1'
where id = 'd6cccccc-cccc-4ccc-8ccc-cccccccccccc';

set local role authenticated;

select ok(
  (
    select payload ->> 'evaluation_status' = 'not_needed'
      and payload ->> 'score_points' is null
      and payload ->> 'scoring_version' is null
      and payload ->> 'score_percent' is null
      and payload ->> 'passed' is null
    from (
      select api.get_practice_assignment_summary(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) as payload
    ) summary
  ),
  'not-needed cannot release a mixed worksheet that contains semantic questions'
);

reset role;
update public.practice_test_attempts
set
  evaluation_status = 'completed',
  score_points = 1,
  max_score_points = 2,
  score_percent = 100
where id = 'd6cccccc-cccc-4ccc-8ccc-cccccccccccc';

set local role authenticated;

select ok(
  (
    select payload ->> 'score_points' is null
      and payload ->> 'scoring_version' is null
      and payload ->> 'score_percent' is null
      and payload ->> 'passed' is null
      and api.get_practice_assignment_review(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) -> 1 ->> 'review_status' = 'submitted_for_review'
    from (
      select api.get_practice_assignment_summary(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) as payload
    ) summary
  ),
  'completed enums cannot release internally inconsistent points or review detail'
);

reset role;
update public.practice_test_attempts
set score_points = 2
where id = 'd6cccccc-cccc-4ccc-8ccc-cccccccccccc';

set local role authenticated;

select ok(
  (
    select (payload ->> 'score_points')::numeric = 2
      and (payload ->> 'max_score_points')::numeric = 2
      and payload ->> 'scoring_version' = 'phase_12f_final_v1'
      and (payload ->> 'score_percent')::numeric = 100
      and payload ->> 'passed' = 'true'
    from (
      select api.get_practice_assignment_summary(
        'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ) as payload
    ) summary
  ),
  'a checked and completed attempt reveals the coherent final student result'
);

select ok(
  (
    select (item ->> 'score_points')::numeric = 2
      and (item ->> 'score_percent')::numeric = 100
      and item ->> 'passed' = 'true'
    from jsonb_array_elements(
      api.list_student_practice_assignments_page(
        'd6666666-6666-4666-8666-666666666666',
        'd6333333-3333-4333-8333-333333333333',
        100,
        null,
        null
      ) -> 'items'
    ) item
    where item ->> 'id' = 'd6bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ),
  'the terminal result becomes visible through the student list as well'
);

with saved as (
  select *
  from api.save_practice_draft(
    'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '[{"question_id":"d6999999-9999-4999-8999-999999999999","answer":"den"},{"question_id":"d6aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","answer":"Ich bleibe zu Hause, weil ich krank bin."}]'::jsonb,
    0
  )
)
update pg_temp.phase_12f_state state
set practice_revision = saved.saved_revision
from saved;

with saved as (
  select *
  from api.save_practice_draft(
    'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '[{"question_id":"d6999999-9999-4999-8999-999999999999","answer":"den"},{"question_id":"d6aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","answer":"Ich bleibe zu Hause, weil ich heute krank bin."}]'::jsonb,
    1
  )
)
update pg_temp.phase_12f_state state
set practice_revision = saved.saved_revision
from saved;

select is(
  (select practice_revision from phase_12f_state),
  2,
  'the second assignment has a genuinely superseding worksheet draft revision'
);

select throws_ok(
  $$
    select api.submit_practice_attempt(
      'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      1
    )
  $$,
  'PT412',
  'draft_revision_conflict',
  'a stale worksheet revision returns a non-retryable precondition conflict'
);

reset role;

select ok(
  exists (
    select 1
    from app_private.practice_drafts draft
    where draft.assignment_id = 'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      and draft.revision = 2
  )
    and not exists (
      select 1
      from public.practice_test_attempts attempt
      where attempt.assignment_id = 'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    ),
  'a revision conflict rolls back without deleting the draft or creating an attempt'
);

set local role authenticated;

update pg_temp.phase_12f_state
set submit_result = api.submit_practice_attempt(
  'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  2
);

select ok(
  (
    select submit_result ->> 'id' =
        'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      and submit_result ->> 'status' = 'completed'
      and submit_result ->> 'latest_attempt_id' is not null
      and submit_result ->> 'latest_attempt_status' = 'submitted'
      and submit_result ->> 'evaluation_status' = 'queued'
      and submit_result ->> 'score' is null
      and submit_result ->> 'score_points' is null
      and submit_result ->> 'scoring_version' is null
      and submit_result ->> 'score_percent' is null
      and submit_result ->> 'passed' is null
    from phase_12f_state
  ),
  'atomic submit observes the new attempt but returns no provisional student grade'
);

reset role;

select ok(
  not exists (
    select 1
    from app_private.practice_drafts draft
    where draft.assignment_id = 'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  )
    and (
      select count(*) = 1
      from public.practice_test_attempts attempt
      where attempt.assignment_id = 'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    )
    and exists (
      select 1
      from app_private.async_jobs job
      where job.entity_id = (
        select (submit_result ->> 'latest_attempt_id')::uuid
        from phase_12f_state
        )
        and job.job_kind = 'worksheet_answer_evaluation'
        and job.status = 'queued'
    ),
  'attempt creation, durable job enqueue, and draft deletion commit atomically'
);

set local role authenticated;

select is(
  api.submit_practice_attempt(
    'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    2
  ),
  (select submit_result from phase_12f_state),
  'an exact lost-response replay returns the same safe submitted read model'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.practice_test_attempts attempt
    where attempt.assignment_id = 'd6eeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ),
  1,
  'the exact replay cannot create a duplicate attempt'
);

delete from public.workspace_members membership
where membership.workspace_id = 'd6666666-6666-4666-8666-666666666666'
  and membership.user_id = 'd6333333-3333-4333-8333-333333333333';

select set_config(
  'request.jwt.claim.sub',
  'd6333333-3333-4333-8333-333333333333',
  true
);
set local role authenticated;

select throws_ok(
  $$
    select api.get_practice_assignment_summary(
      'd6000000-0000-4000-8000-000000000012'
    )
  $$,
  '42501',
  'active_membership_required',
  'offboarding immediately removes a former student from known worksheet results'
);

reset role;

select * from finish();

rollback;
