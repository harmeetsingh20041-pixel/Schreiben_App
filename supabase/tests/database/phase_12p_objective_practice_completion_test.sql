begin;

-- Shared-staging-safe rollback test for the real browser draft/submit path.
select plan(15);

select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'app_private.submit_practice_attempt_internal_phase_7d2_unchecked(uuid,jsonb)'::regprocedure
    ),
    E'evaluation_completed_at = case\n      when next_evaluation_status = ''not_needed''\n        and next_attempt_status = ''checked''\n        and next_assignment_status in (''passed'', ''failed'')'
  ) > 0,
  'the active local scorer persists a completion time only for coherent objective terminals'
);

select ok(
  lower(pg_catalog.pg_get_viewdef('api.practice_test_attempts'::regclass, true))
    like '%evaluation_completed_at is not null%',
  'the student attempt view still requires a persisted terminal completion time'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'c1211111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12p-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12P Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c1222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12p-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12P Student"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c1233333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase12p-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12P Outsider"}'::jsonb, now(), now()
  );

-- The active Auth trigger owns profile creation. Reuse those rows so this
-- rollback-only browser-path fixture exercises the same lifecycle as a real
-- signup instead of attempting a second, impossible profile insert.
do $phase_12p_profiles$
begin
  if (
    select count(*)
    from public.profiles profile
    where profile.id in (
      'c1211111-1111-4111-8111-111111111111',
      'c1222222-2222-4222-8222-222222222222',
      'c1233333-3333-4333-8333-333333333333'
    )
  ) <> 3 then
    raise exception 'phase_12p_auth_profile_trigger_missing';
  end if;

  update public.profiles profile
  set global_role = 'student'
  where profile.id in (
    'c1211111-1111-4111-8111-111111111111',
    'c1222222-2222-4222-8222-222222222222',
    'c1233333-3333-4333-8333-333333333333'
  );
end;
$phase_12p_profiles$;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'c1244444-4444-4444-8444-444444444444',
  'Phase 12P Workspace', 'phase-12p-workspace',
  'c1211111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'c1211111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);
insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c1244444-4444-4444-8444-444444444444',
  'c1211111-1111-4111-8111-111111111111',
  'owner'
);
select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c1244444-4444-4444-8444-444444444444',
  'c1222222-2222-4222-8222-222222222222',
  'student'
);

insert into public.batches (
  id, workspace_id, name, level, feedback_mode, is_active, created_by
)
values (
  'c1255555-5555-4555-8555-555555555555',
  'c1244444-4444-4444-8444-444444444444',
  'Phase 12P A1 Class', 'A1', 'immediate', true,
  'c1211111-1111-4111-8111-111111111111'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  'c1244444-4444-4444-8444-444444444444',
  'c1255555-5555-4555-8555-555555555555',
  'c1222222-2222-4222-8222-222222222222'
);

reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claim.sub', '', true);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'c1266666-6666-4666-8666-666666666666',
  'phase-12p-present-tense', 'Phase 12P Present Tense', 'A1',
  'Rollback-only objective worksheet fixture.'
);

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by,
  generation_source, quality_status
)
values (
  'c1277777-7777-4777-8777-777777777777',
  'c1244444-4444-4444-8444-444444444444',
  'c1266666-6666-4666-8666-666666666666',
  'A1', 'easy', 'Phase 12P objective worksheet',
  'Two deterministic local questions.', false, true, 'workspace',
  'c1211111-1111-4111-8111-111111111111', 'manual_import', 'approved'
);

insert into public.practice_test_questions (
  id, practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
values
  (
    'c1288888-8888-4888-8888-888888888888',
    'c1277777-7777-4777-8777-777777777777',
    1, 'multiple_choice', 'local_exact',
    'Welcher Artikel passt: Ich sehe ___ Tisch?',
    '["den","die","das"]'::jsonb, 'den', '["den"]'::jsonb,
    null, 1, 'Tisch ist ein maskulines Akkusativobjekt.'
  ),
  (
    'c1299999-9999-4999-8999-999999999999',
    'c1277777-7777-4777-8777-777777777777',
    2, 'fill_blank', 'local_exact',
    'Wortbank: [geht, gehen, gehst]. Setze die richtige Form ein: Er ___ nach Hause.',
    '[]'::jsonb, 'geht', '["geht"]'::jsonb,
    null, 1, 'Zu er gehört die Form geht.'
  );

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  batch_id, worksheet_level, class_context_version, class_context_integrity,
  source, status, assigned_by, assigned_at, generation_status
)
values (
  'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'c1244444-4444-4444-8444-444444444444',
  'c1222222-2222-4222-8222-222222222222',
  'c1266666-6666-4666-8666-666666666666',
  'c1277777-7777-4777-8777-777777777777',
  'c1255555-5555-4555-8555-555555555555', 'A1', 1,
  'teacher_verified', 'manual', 'unlocked',
  'c1211111-1111-4111-8111-111111111111', now(), 'ready'
);

create temporary table phase_12p_results (
  name text primary key,
  payload jsonb not null
) on commit drop;
grant select, insert on phase_12p_results to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'c1222222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select ok(
  api.get_practice_assignment_summary(
    'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) -> 'score' = 'null'::jsonb
    and api.get_practice_assignment_summary(
      'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ) -> 'latest_attempt_id' = 'null'::jsonb,
  'no objective score is visible before the student submits'
);

select lives_ok(
  $$
    insert into phase_12p_results (name, payload)
    select 'draft', to_jsonb(saved)
    from api.save_practice_draft(
      'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '[{"question_id":"c1288888-8888-4888-8888-888888888888","answer":"den"},{"question_id":"c1299999-9999-4999-8999-999999999999","answer":"geht"}]'::jsonb,
      0
    ) saved
  $$,
  'the student can save a complete objective-only draft'
);

select lives_ok(
  $$
    insert into phase_12p_results (name, payload)
    values (
      'submit',
      api.submit_practice_attempt(
        'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        1
      )
    )
  $$,
  'the real objective-only draft submission completes atomically'
);

select ok(
  (select payload from phase_12p_results where name = 'submit') @>
    '{"id":"c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"passed","latest_attempt_status":"checked","evaluation_status":"not_needed","score":2,"max_score":2,"score_points":2.00,"max_score_points":2.00,"score_percent":100.00,"passed":true}'::jsonb,
  'the submit response immediately exposes the coherent final objective score'
);

select is(
  api.submit_practice_attempt(
    'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1
  ),
  (select payload from phase_12p_results where name = 'submit'),
  'an exact objective-only submit replay returns the same safe read model'
);

select throws_ok(
  $$
    select api.submit_practice_attempt(
      'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      2
    )
  $$,
  'PT412',
  'draft_revision_conflict',
  'a changed draft revision returns a non-retryable precondition conflict'
);

select ok(
  exists (
    select 1
    from api.practice_test_attempts attempt
    where attempt.assignment_id = 'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and attempt.status = 'checked'
      and attempt.evaluation_status = 'not_needed'
      and attempt.evaluation_completed_at is not null
      and attempt.score = 2
      and attempt.max_score = 2
      and attempt.score_points = 2
      and attempt.max_score_points = 2
      and attempt.score_percent = 100
      and attempt.passed
      and attempt.evaluation_error is null
  ),
  'the student attempt view exposes the score only with its terminal timestamp'
);

reset role;

select ok(
  exists (
    select 1
    from public.student_practice_assignments assignment
    join public.practice_test_attempts attempt
      on attempt.id = assignment.latest_attempt_id
    where assignment.id = 'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and assignment.status = 'passed'
      and attempt.status = 'checked'
      and attempt.evaluation_status = 'not_needed'
      and attempt.evaluation_completed_at is not null
      and attempt.evaluation_completed_at = attempt.completed_at
      and attempt.submitted_at = attempt.completed_at
      and attempt.submit_draft_revision = 1
      and attempt.answers =
        '[{"question_id":"c1288888-8888-4888-8888-888888888888","answer":"den"},{"question_id":"c1299999-9999-4999-8999-999999999999","answer":"geht"}]'::jsonb
  ),
  'the database stores one coherent objective terminal and the exact submitted answers'
);

select ok(
  (
    select count(*) = 1
    from public.practice_test_attempts attempt
    where attempt.assignment_id = 'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  )
    and not exists (
      select 1
      from app_private.practice_drafts draft
      where draft.assignment_id = 'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    and not exists (
      select 1
      from app_private.async_jobs job
      join public.practice_test_attempts attempt on attempt.id = job.entity_id
      where attempt.assignment_id = 'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ),
  'replay creates no second attempt, leaves no draft, and queues no AI job'
);

select throws_ok(
  $$
    update public.practice_test_attempts
    set answers = '[]'::jsonb
    where assignment_id = 'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  $$,
  '55000',
  'submitted_practice_answers_immutable',
  'objective answers cannot be rewritten after terminal submission'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'api'
      and column_info.table_name = 'practice_test_attempts'
      and column_info.column_name in ('answers', 'feedback')
  ),
  'the browser attempt view never exposes raw answers or internal scoring feedback'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'c1233333-3333-4333-8333-333333333333',
  true
);
set local role authenticated;

select ok(
  not exists (
    select 1
    from api.practice_test_attempts attempt
    where attempt.assignment_id = 'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  'an unrelated authenticated user cannot see the objective attempt'
);

select throws_ok(
  $$
    select api.get_practice_assignment_summary(
      'c12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  $$,
  'P0002',
  'practice_assignment_not_found',
  'an unrelated authenticated user cannot probe the objective assignment summary'
);

reset role;

select * from finish(true);
rollback;
