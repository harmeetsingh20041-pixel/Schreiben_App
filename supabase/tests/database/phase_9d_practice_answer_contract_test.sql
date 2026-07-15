begin;

select plan(18);

select ok(
  to_regprocedure(
    'app_private.is_practice_question_locally_scorable(text,text,text,jsonb)'
  ) is not null
    and to_regprocedure(
      'app_private.practice_answer_review_status_any(text,text,jsonb,boolean)'
    ) is not null,
  'versioned accepted-answer scoring helpers exist'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.is_practice_question_locally_scorable(text,text,text,jsonb)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'app_private.practice_answer_review_status_any(text,text,jsonb,boolean)',
      'EXECUTE'
    ),
  'accepted-answer scoring helpers are not browser-callable'
);

select ok(
  app_private.is_practice_question_locally_scorable(
    'multiple_choice',
    'dem',
    'local_exact',
    '["dem"]'::jsonb
  ),
  'a contracted multiple-choice question is locally scorable'
);

select ok(
  app_private.is_practice_question_locally_scorable(
    'fill_blank',
    'zum',
    'local_exact',
    '["zum", "zu dem"]'::jsonb
  ),
  'a constrained fill with a complete accepted-answer set is locally scorable'
);

select ok(
  not app_private.is_practice_question_locally_scorable(
    'fill_blank',
    'zum',
    'local_exact',
    '[]'::jsonb
  ),
  'a fill without an accepted-answer contract fails closed'
);

select ok(
  not app_private.is_practice_question_locally_scorable(
    'word_order',
    'Heute gehe ich zum Arzt.',
    'local_exact',
    '["Heute gehe ich zum Arzt."]'::jsonb
  ),
  'a flexible word-order task cannot opt into exact-string scoring'
);

select is(
  app_private.practice_answer_review_status_any(
    'zu dem',
    'zum',
    '["zum", "zu dem"]'::jsonb,
    false
  ),
  'correct',
  'a valid noncanonical preposition form receives full credit'
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
    'd9011111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase9d-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9D Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd9022222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase9d-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 9D Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd9033333-3333-4333-8333-333333333333',
  'Phase 9D Workspace',
  'phase-9d-workspace',
  'd9011111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'd9011111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd9033333-3333-4333-8333-333333333333',
  'd9011111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd9033333-3333-4333-8333-333333333333',
  'd9022222-2222-4222-8222-222222222222',
  'student'
);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'd9044444-4444-4444-8444-444444444444',
  'phase-9d-prepositions',
  'Phase 9D Prepositions',
  'A2',
  'A reset-safe answer-contract fixture.'
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
values
  (
    'd9100000-0000-4000-8000-000000000000',
    'd9033333-3333-4333-8333-333333333333',
    'd9044444-4444-4444-8444-444444444444',
    'A2',
    'easy',
    'Accepted preposition forms',
    'A constrained exact-scoring contract.',
    false,
    true,
    'workspace',
    'd9011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  ),
  (
    'd9200000-0000-4000-8000-000000000000',
    'd9033333-3333-4333-8333-333333333333',
    'd9044444-4444-4444-8444-444444444444',
    'A2',
    'medium',
    'Semantic word order',
    'A rubric-scored flexible contract.',
    false,
    true,
    'workspace',
    'd9011111-1111-4111-8111-111111111111',
    'manual_import',
    'approved'
  );

select lives_ok(
  $$
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
    ) values (
      'd9111111-1111-4111-8111-111111111111',
      'd9100000-0000-4000-8000-000000000000',
      1,
      'fill_blank',
      'local_exact',
      'Nutze die geschlossene Wortbank (zum, zu dem): Ich gehe ___ Arzt.',
      null,
      'zum',
      '["zum", "zu dem"]'::jsonb,
      null,
      1,
      'Both contracted and expanded forms are accepted by this closed task.'
    )
  $$,
  'a constrained fill with explicit alternatives is accepted'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, correct_answer, accepted_answers, answer_contract_version
    ) values (
      'd9100000-0000-4000-8000-000000000000', 2, 'fill_blank', 'local_exact',
      'Nutze die geschlossene Wortbank (zum, zu dem): Wir gehen ___ Arzt.',
      'zum', '[]'::jsonb, 1
    )
  $$,
  '22023',
  'Exact-scoring contract is invalid.',
  'a local fill without accepted answers is rejected'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, correct_answer, accepted_answers, answer_contract_version
    ) values (
      'd9100000-0000-4000-8000-000000000000', 2, 'fill_blank', 'local_exact',
      'Ergänze ein passendes Wort: Wir gehen ___ Arzt.',
      'zum', '["zum"]'::jsonb, 1
    )
  $$,
  '22023',
  'Fill-blank answer contract is ambiguous.',
  'a generic fill prompt cannot claim exact scoring'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, correct_answer, accepted_answers, answer_contract_version
    ) values (
      'd9100000-0000-4000-8000-000000000000', 2, 'fill_blank', 'local_exact',
      'Nutze die geschlossene Wortbank (zum, zu dem): Wir gehen ___ Arzt.',
      'zum', '["zum", " ZUM "]'::jsonb, 1
    )
  $$,
  '22023',
  'Accepted answers are invalid or duplicated.',
  'normalized duplicate accepted answers are rejected'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, correct_answer, accepted_answers, rubric, answer_contract_version
    ) values (
      'd9200000-0000-4000-8000-000000000000', 1, 'mini_writing', 'open_evaluation',
      'Schreibe einen vollständigen Beispielsatz.',
      'manual_review', '[]'::jsonb,
      '{"criteria":["Write a complete German sentence."],"sample_answer":null}'::jsonb,
      1
    )
  $$,
  '22023',
  'Manual-review sentinels are not valid answers.',
  'manual-review sentinel answers are rejected'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, correct_answer, accepted_answers, rubric, answer_contract_version
    ) values (
      'd9200000-0000-4000-8000-000000000000', 1, 'word_order', 'open_evaluation',
      'Ordne die Wörter zu einem vollständigen Satz.',
      'Heute gehe ich zum Arzt.', '[]'::jsonb, null, 1
    )
  $$,
  '22023',
  'Semantic-evaluation rubric is invalid.',
  'a flexible question without a real rubric is rejected'
);

select lives_ok(
  $$
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
    ) values (
      'd9211111-1111-4111-8111-111111111111',
      'd9200000-0000-4000-8000-000000000000',
      1,
      'word_order',
      'open_evaluation',
      'Ordne die Wörter zu einem vollständigen Satz.',
      null,
      'Heute gehe ich zum Arzt.',
      '[]'::jsonb,
      '{"criteria":["Use a valid German main clause with the finite verb in position two."],"sample_answer":"Heute gehe ich zum Arzt."}'::jsonb,
      1,
      'Other valid placements may also receive semantic credit.'
    )
  $$,
  'a flexible question with a genuine rubric/sample contract is accepted'
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
  generation_status
)
values (
  'd9300000-0000-4000-8000-000000000000',
  'd9033333-3333-4333-8333-333333333333',
  'd9022222-2222-4222-8222-222222222222',
  'd9044444-4444-4444-8444-444444444444',
  'd9100000-0000-4000-8000-000000000000',
  'manual',
  'unlocked',
  'd9011111-1111-4111-8111-111111111111',
  'ready'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd9022222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd9022222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

update public.practice_tests
set quality_status = 'needs_review'
where id = 'd9100000-0000-4000-8000-000000000000';

set local role authenticated;

select throws_ok(
  $$
    select *
    from public.submit_practice_attempt(
      'd9300000-0000-4000-8000-000000000000',
      jsonb_build_array(jsonb_build_object(
        'question_id', 'd9111111-1111-4111-8111-111111111111',
        'answer', 'zu dem'
      ))
    )
  $$,
  '55000',
  'practice_worksheet_requires_review',
  'an unapproved worksheet cannot create a new student attempt'
);

reset role;

update public.practice_tests
set quality_status = 'approved'
where id = 'd9100000-0000-4000-8000-000000000000';

-- Recreate one legacy pre-contract row without taking a table-wide trigger
-- lock or changing trigger state for other shared-staging sessions.
set local session_replication_role = replica;
update public.practice_test_questions
set answer_contract_version = 0
where id = 'd9111111-1111-4111-8111-111111111111';
set local session_replication_role = origin;

set local role authenticated;
select throws_ok(
  $$
    select *
    from public.submit_practice_attempt(
      'd9300000-0000-4000-8000-000000000000',
      jsonb_build_array(jsonb_build_object(
        'question_id', 'd9111111-1111-4111-8111-111111111111',
        'answer', 'zu dem'
      ))
    )
  $$,
  '55000',
  'practice_worksheet_requires_review',
  'a pre-contract worksheet cannot reach the legacy exact scorer'
);

reset role;

set local session_replication_role = replica;
update public.practice_test_questions
set answer_contract_version = 1
where id = 'd9111111-1111-4111-8111-111111111111';
set local session_replication_role = origin;

set local role authenticated;

select ok(
  exists (
    select 1
    from public.submit_practice_attempt(
      'd9300000-0000-4000-8000-000000000000',
      jsonb_build_array(jsonb_build_object(
        'question_id', 'd9111111-1111-4111-8111-111111111111',
        'answer', 'zu dem'
      ))
    ) submitted
    where submitted.status = 'passed'
      and submitted.score = 1
      and submitted.max_score = 1
      and submitted.score_percent = 100
      and submitted.passed
  ),
  'the public submit path awards full credit for every contracted valid answer'
);

reset role;

select ok(
  exists (
    select 1
    from public.practice_test_attempts attempt
    where attempt.assignment_id = 'd9300000-0000-4000-8000-000000000000'
      and attempt.status = 'checked'
      and attempt.evaluation_status = 'not_needed'
      and attempt.score_points = 1
      and attempt.max_score_points = 1
      and attempt.score_percent = 100
      and attempt.passed
  ),
  'accepted-alternative scoring persists a correct terminal attempt without provider work'
);

select * from finish();
rollback;
