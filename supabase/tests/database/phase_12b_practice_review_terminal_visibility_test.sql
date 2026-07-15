begin;

select plan(14);

select ok(
  (
    select routine.prosecdef
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
    from pg_proc routine
    where routine.oid =
      'app_private.get_practice_assignment_review_internal(uuid)'::regprocedure
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.get_practice_assignment_review_internal(uuid)',
      'EXECUTE'
    ),
  'the privileged review implementation is private and pins an empty search path'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.get_practice_assignment_review(uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'api.get_practice_assignment_review(uuid)',
      'EXECUTE'
    )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'api.get_practice_assignment_review(uuid)'::regprocedure
    ),
  'the exposed review API remains an authenticated security-invoker boundary'
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
    'b2111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12b-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12B Owner"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b2222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12b-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12B Teacher"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b2333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase12b-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12B Student"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b2444444-4444-4444-8444-444444444444',
    'authenticated', 'authenticated', 'phase12b-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12B Outsider"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b2455555-5555-4555-8555-555555555555',
    'authenticated', 'authenticated', 'phase12b-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12B Administrator"}'::jsonb,
    now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'b2111111-1111-4111-8111-111111111111',
    'Phase 12B Owner',
    'phase12b-owner@example.test',
    'student'
  ),
  (
    'b2222222-2222-4222-8222-222222222222',
    'Phase 12B Teacher',
    'phase12b-teacher@example.test',
    'student'
  ),
  (
    'b2333333-3333-4333-8333-333333333333',
    'Phase 12B Student',
    'phase12b-student@example.test',
    'student'
  ),
  (
    'b2444444-4444-4444-8444-444444444444',
    'Phase 12B Outsider',
    'phase12b-outsider@example.test',
    'student'
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

-- Auth synchronization deliberately creates every new profile as a student.
-- Replace only this transaction-owned fixture row so the test can exercise
-- the server-managed platform-admin path without weakening the update guard.
delete from public.profiles
where id = 'b2455555-5555-4555-8555-555555555555';

insert into public.profiles (id, full_name, email, global_role)
values (
  'b2455555-5555-4555-8555-555555555555',
  'Phase 12B Administrator',
  'phase12b-admin@example.test',
  'platform_admin'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  'b2555555-5555-4555-8555-555555555555',
  'Phase 12B Workspace',
  'phase-12b-workspace',
  'b2111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'b2111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'b2555555-5555-4555-8555-555555555555',
  'b2111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'b2555555-5555-4555-8555-555555555555',
    'b2222222-2222-4222-8222-222222222222',
    'teacher'
  ),
  (
    'b2555555-5555-4555-8555-555555555555',
    'b2333333-3333-4333-8333-333333333333',
    'student'
  );

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'b2666666-6666-4666-8666-666666666666',
  'phase-12b-terminal-visibility',
  'Phase 12B terminal visibility',
  'B1',
  'Transactional fixture for student worksheet review visibility.'
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
  'b2777777-7777-4777-8777-777777777777',
  'b2555555-5555-4555-8555-555555555555',
  'b2666666-6666-4666-8666-666666666666',
  'B1',
  'medium',
  'Phase 12B private review worksheet',
  'Contains one semantic question with a deliberately stale review row.',
  false,
  true,
  'workspace',
  'b2111111-1111-4111-8111-111111111111',
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
  'b2888888-8888-4888-8888-888888888888',
  'b2777777-7777-4777-8777-777777777777',
  1,
  'mini_writing',
  'open_evaluation',
  'Schreibe einen kurzen Satz mit weil.',
  null,
  'Ich bleibe zu Hause, weil ich krank bin.',
  '[]'::jsonb,
  '{"criteria":["Award one point for a coherent weil-clause with the finite verb at the end."],"sample_answer":"Ich bleibe zu Hause, weil ich krank bin."}'::jsonb,
  1,
  'A weil-clause places the finite verb at the end.'
), (
  'b28ccccc-cccc-4ccc-8ccc-cccccccccccc',
  'b2777777-7777-4777-8777-777777777777',
  2,
  'fill_blank',
  'local_exact',
  'Nutze die geschlossene Wortbank (zum, zu dem): Ich gehe ___ Arzt.',
  null,
  'zum',
  '["zum", "zu dem"]'::jsonb,
  null,
  1,
  'Both contracted and expanded forms are accepted by this closed task.'
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
values (
  'b2999999-9999-4999-8999-999999999999',
  'b2555555-5555-4555-8555-555555555555',
  'b2333333-3333-4333-8333-333333333333',
  'b2666666-6666-4666-8666-666666666666',
  'b2777777-7777-4777-8777-777777777777',
  'teacher_assigned',
  'completed',
  'b2222222-2222-4222-8222-222222222222',
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
  score_points,
  max_score_points,
  scoring_version
)
values (
  'b2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'b2777777-7777-4777-8777-777777777777',
  'b2333333-3333-4333-8333-333333333333',
  'b2555555-5555-4555-8555-555555555555',
  '[{"question_id":"b2888888-8888-4888-8888-888888888888","answer":"Ich bleibe zu Hause, weil ich bin krank."},{"question_id":"b28ccccc-cccc-4ccc-8ccc-cccccccccccc","answer":"zu dem"}]'::jsonb,
  0,
  1,
  'b2999999-9999-4999-8999-999999999999',
  'submitted',
  now(),
  now(),
  0,
  false,
  'queued',
  0,
  1,
  'phase_12b_partial_fixture_v1'
);

update public.student_practice_assignments
set latest_attempt_id = 'b2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
where id = 'b2999999-9999-4999-8999-999999999999';

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
  'b2bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'b2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'b2999999-9999-4999-8999-999999999999',
  'b2555555-5555-4555-8555-555555555555',
  'b2333333-3333-4333-8333-333333333333',
  'b2888888-8888-4888-8888-888888888888',
  'incorrect',
  0,
  1,
  'manual',
  'Phase 12B stale feedback must remain private.',
  'Ich bleibe zu Hause, weil ich krank bin.',
  'Ich bleibe zu Hause, weil es stark regnet.',
  'The stored review predates the current queued retry.'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'b2333333-3333-4333-8333-333333333333',
  true
);
set local role authenticated;

select ok(
  (
    select payload ->> 'latest_attempt_status' = 'submitted'
      and payload ->> 'evaluation_status' = 'queued'
      and payload ->> 'student_answer' =
        'Ich bleibe zu Hause, weil ich bin krank.'
      and payload ->> 'score' is null
      and payload ->> 'max_score' is null
      and payload ->> 'score_points' is null
      and payload ->> 'max_score_points' is null
      and payload ->> 'scoring_version' is null
      and payload ->> 'evaluation_error' is null
      and payload ->> 'score_percent' is null
      and payload ->> 'passed' is null
    from (
      select api.get_practice_assignment_review(
        'b2999999-9999-4999-8999-999999999999'
      ) -> 0 as payload
    ) review
  ),
  'a student retains safe answer and progress state while evaluation is queued'
);

select ok(
  (
    select payload ->> 'review_status' = 'submitted_for_review'
      and payload ->> 'is_correct' is null
      and payload ->> 'points_awarded' is null
      and payload ->> 'max_points' is null
      and payload ->> 'feedback_text' is null
      and payload ->> 'corrected_answer' is null
      and payload ->> 'model_answer' is null
      and payload ->> 'short_reason' is null
      and payload ->> 'evaluator_source' is null
      and payload ->> 'correct_answer' is null
      and payload ->> 'explanation' is null
    from (
      select api.get_practice_assignment_review(
        'b2999999-9999-4999-8999-999999999999'
      ) -> 0 as payload
    ) review
  ),
  'a queued student review masks every stale or private review field'
);

select ok(
  (
    select payload ->> 'review_status' = 'submitted_for_review'
      and payload ->> 'is_correct' is null
      and payload ->> 'points_awarded' is null
      and payload ->> 'max_points' is null
      and payload ->> 'correct_answer' is null
      and payload ->> 'explanation' is null
    from (
      select api.get_practice_assignment_review(
        'b2999999-9999-4999-8999-999999999999'
      ) -> 1 as payload
    ) review
  ),
  'a queued mixed attempt also masks locally derived answer details until the attempt is coherent'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  'b2111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

select ok(
  (
    select payload ->> 'review_status' = 'incorrect'
      and payload ->> 'feedback_text' =
        'Phase 12B stale feedback must remain private.'
      and payload ->> 'corrected_answer' =
        'Ich bleibe zu Hause, weil ich krank bin.'
      and payload ->> 'model_answer' =
        'Ich bleibe zu Hause, weil es stark regnet.'
      and payload ->> 'evaluator_source' = 'manual'
      and (payload ->> 'score_points')::numeric = 0
      and (payload ->> 'max_score_points')::numeric = 1
      and payload ->> 'scoring_version' = 'phase_12b_partial_fixture_v1'
    from (
      select api.get_practice_assignment_review(
        'b2999999-9999-4999-8999-999999999999'
      ) -> 0 as payload
    ) review
  ),
  'a workspace owner retains the partial-review preview needed for recovery'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  'b2222222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select is(
  api.get_practice_assignment_review(
    'b2999999-9999-4999-8999-999999999999'
  ) -> 0 ->> 'feedback_text',
  'Phase 12B stale feedback must remain private.'::text,
  'a workspace teacher retains the same operational preview'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  'b2455555-5555-4555-8555-555555555555',
  true
);
set local role authenticated;

select is(
  api.get_practice_assignment_review(
    'b2999999-9999-4999-8999-999999999999'
  ) -> 0 ->> 'feedback_text',
  'Phase 12B stale feedback must remain private.'::text,
  'a platform administrator retains recovery visibility without workspace membership'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  'b2444444-4444-4444-8444-444444444444',
  true
);
set local role authenticated;

select throws_ok(
  $$
    select api.get_practice_assignment_review(
      'b2999999-9999-4999-8999-999999999999'
    )
  $$,
  'P0002',
  'practice_assignment_not_found',
  'an unrelated authenticated user cannot discover or read the worksheet review'
);

reset role;

update public.practice_test_attempts
set status = 'checked'
where id = 'b2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

select set_config(
  'request.jwt.claim.sub',
  'b2333333-3333-4333-8333-333333333333',
  true
);
set local role authenticated;

select is(
  api.get_practice_assignment_review(
    'b2999999-9999-4999-8999-999999999999'
  ) -> 0 ->> 'review_status',
  'submitted_for_review'::text,
  'checked alone is insufficient while semantic evaluation remains queued'
);

reset role;

update public.practice_test_attempts
set
  evaluation_status = 'completed',
  evaluation_completed_at = now()
where id = 'b2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

-- The final visibility predicate also requires the assignment outcome to
-- agree with the persisted score. This fixture scored zero, so its coherent
-- terminal assignment state is failed rather than the legacy completed state.
update public.student_practice_assignments
set status = 'failed'
where id = 'b2999999-9999-4999-8999-999999999999';

set local role authenticated;

select ok(
  (
    select payload ->> 'status' = 'failed'
      and payload ->> 'latest_attempt_status' = 'checked'
      and payload ->> 'evaluation_status' = 'completed'
      and payload ->> 'review_status' = 'incorrect'
      and payload ->> 'feedback_text' =
        'Phase 12B stale feedback must remain private.'
      and payload ->> 'short_reason' =
        'The stored review predates the current queued retry.'
      and (payload ->> 'points_awarded')::numeric = 0
      and (payload ->> 'max_points')::numeric = 1
      and (payload ->> 'score_points')::numeric = 0
      and (payload ->> 'max_score_points')::numeric = 1
    from (
      select api.get_practice_assignment_review(
        'b2999999-9999-4999-8999-999999999999'
      ) -> 0 as payload
    ) review
  ),
  'a checked and completed student attempt reveals its coherent final review'
);

reset role;

update public.practice_test_attempts
set evaluation_status = 'not_needed'
where id = 'b2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

set local role authenticated;

select ok(
  (
    select payload ->> 'review_status' = 'submitted_for_review'
      and payload ->> 'evaluation_status' = 'not_needed'
      and payload ->> 'is_correct' is null
      and payload ->> 'points_awarded' is null
      and payload ->> 'max_points' is null
      and payload ->> 'score' is null
      and payload ->> 'max_score' is null
      and payload ->> 'score_points' is null
      and payload ->> 'max_score_points' is null
      and payload ->> 'scoring_version' is null
      and payload ->> 'score_percent' is null
      and payload ->> 'passed' is null
      and payload ->> 'correct_answer' is null
      and payload ->> 'explanation' is null
    from (
      select api.get_practice_assignment_review(
        'b2999999-9999-4999-8999-999999999999'
      ) -> 1 as payload
    ) review
  ),
  'not-needed cannot expose a local answer inside a mixed semantic worksheet'
);

select ok(
  (
    select payload ->> 'review_status' = 'submitted_for_review'
      and payload ->> 'is_correct' is null
      and payload ->> 'points_awarded' is null
      and payload ->> 'max_points' is null
      and payload ->> 'feedback_text' is null
      and payload ->> 'corrected_answer' is null
      and payload ->> 'model_answer' is null
      and payload ->> 'short_reason' is null
      and payload ->> 'evaluator_source' is null
    from (
      select api.get_practice_assignment_review(
        'b2999999-9999-4999-8999-999999999999'
      ) -> 0 as payload
    ) review
  ),
  'not-needed cannot expose stale semantic feedback for a mixed worksheet'
);

reset role;

update public.practice_test_attempts
set status = 'submitted'
where id = 'b2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

set local role authenticated;

select is(
  api.get_practice_assignment_review(
    'b2999999-9999-4999-8999-999999999999'
  ) -> 0 ->> 'review_status',
  'submitted_for_review'::text,
  'terminal evaluation alone is insufficient until the attempt is checked'
);

reset role;

select * from finish();

rollback;
