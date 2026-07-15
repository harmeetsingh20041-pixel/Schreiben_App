begin;

select plan(15);

select ok(
  to_regprocedure(
    'app_private.has_valid_practice_closed_word_bank(text,jsonb,boolean)'
  ) is not null
    and position(
      '[,;|/]' in pg_get_functiondef(
        'app_private.has_valid_practice_closed_word_bank(text,jsonb,boolean)'::regprocedure
      )
    ) > 0,
  'the database contract recognizes every canonical closed-bank separator'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  'e1350001-0001-4001-8001-000000000001',
  'authenticated',
  'authenticated',
  'phase13y-teacher@fixture.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Phase 13Y Teacher"}'::jsonb,
  now(),
  now()
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  'e1351001-0001-4001-8001-000000000001',
  'Phase 13Y Closed Word Banks',
  'phase-13y-closed-word-banks',
  'e1350001-0001-4001-8001-000000000001'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'e1350001-0001-4001-8001-000000000001',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'e1351001-0001-4001-8001-000000000001',
  'e1350001-0001-4001-8001-000000000001',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'e1352001-0001-4001-8001-000000000001',
  'phase-13y-word-bank-contract',
  'Phase 13Y Word Bank Contract',
  'A2',
  'Rollback-only database contract fixture.'
);

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title,
  description, created_by_ai, teacher_reviewed, visibility, created_by,
  generation_source, quality_status
)
values (
  'e1353001-0001-4001-8001-000000000001',
  'e1351001-0001-4001-8001-000000000001',
  'e1352001-0001-4001-8001-000000000001',
  'A2',
  'easy',
  'Phase 13Y closed-bank separators',
  'Exercises the canonical exact-scoring prompt contract.',
  false,
  true,
  'workspace',
  'e1350001-0001-4001-8001-000000000001',
  'manual_import',
  'approved'
);

select lives_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 1, 'fill_blank',
      'local_exact',
      'Wortbank: [mit, bei, für]. Ergänze: Ich fahre ___ dem Bus.',
      null, 'mit', '["mit"]'::jsonb, null, 1,
      'Mit marks the means of transport.'
    )
  $$,
  'comma-separated closed banks remain valid'
);

select lives_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 2, 'fill_blank',
      'local_exact',
      'Wortbank: [mit; bei; für]. Ergänze: Ich fahre ___ dem Bus.',
      null, 'mit', '["mit"]'::jsonb, null, 1,
      'Mit marks the means of transport.'
    )
  $$,
  'semicolon-separated closed banks are valid'
);

select lives_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 3, 'fill_blank',
      'local_exact',
      'Wortbank: [mit | bei | für]. Ergänze: Ich fahre ___ dem Bus.',
      null, 'mit', '["mit"]'::jsonb, null, 1,
      'Mit marks the means of transport.'
    )
  $$,
  'vertical-bar-separated closed banks are valid'
);

select lives_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 4, 'fill_blank',
      'local_exact',
      'Wortbank: [mit / bei / für]. Ergänze: Ich fahre ___ dem Bus.',
      null, 'mit', '["mit"]'::jsonb, null, 1,
      'Mit marks the means of transport.'
    )
  $$,
  'slash-separated closed banks are valid'
);

select lives_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 5, 'fill_blank',
      'local_exact',
      'Setze die passende Form von mitbringen ein: Die Gäste haben Salat ___.',
      null, 'mitgebracht', '["mitgebracht"]'::jsonb, null, 1,
      'The perfect participle is mitgebracht.'
    )
  $$,
  'a named German base-form constraint remains valid without a word bank'
);

select lives_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 6, 'fill_blank',
      'local_exact',
      'Geschlossene Wortbank (zum; zu dem; beim): Ich gehe ___ Arzt.',
      null, 'zum', '["zum"]'::jsonb, null, 1,
      'A parenthesized closed bank follows the same exact contract.'
    )
  $$,
  'parenthesized closed banks are valid'
);

select lives_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 7, 'fill_blank',
      'local_exact',
      'Wortbank: [zum | zu dem | beim]. Ergänze: Ich gehe ___ Arzt.',
      null, 'zum', '["zum", "zu dem"]'::jsonb, null, 1,
      'Every explicitly accepted equivalent is visible in the bank.'
    )
  $$,
  'multiple accepted answers may be bound to listed closed-bank choices'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 8, 'fill_blank',
      'local_exact',
      'Wortbank: [mit]. Ergänze: Ich fahre ___ dem Bus.',
      null, 'mit', '["mit"]'::jsonb, null, 1,
      'This malformed bank must not be accepted.'
    )
  $$,
  '22023',
  'Fill-blank answer contract is ambiguous.',
  'a one-choice label is not treated as a closed word bank'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 9, 'fill_blank',
      'local_exact',
      'Wortbank: [mit / ]. Ergänze: Ich fahre ___ dem Bus.',
      null, 'mit', '["mit"]'::jsonb, null, 1,
      'A blank bank choice must not be accepted.'
    )
  $$,
  '22023',
  'Fill-blank answer contract is ambiguous.',
  'a blank closed-bank choice fails closed'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 10, 'fill_blank',
      'local_exact',
      'Wortbank: [bei | für]. Ergänze: Ich fahre ___ dem Bus.',
      null, 'mit', '["mit"]'::jsonb, null, 1,
      'The accepted answer must be visible in the bank.'
    )
  $$,
  '22023',
  'Fill-blank answer contract is ambiguous.',
  'an accepted answer missing from the visible bank fails closed'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 11, 'fill_blank',
      'local_exact',
      'Setze die passende Form von: Die Gäste haben Salat ___.',
      null, 'mitgebracht', '["mitgebracht"]'::jsonb, null, 1,
      'A named-form prompt must actually name the source word.'
    )
  $$,
  '22023',
  'Fill-blank answer contract is ambiguous.',
  'a named-form prompt without a base word fails closed'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 12, 'fill_blank',
      'local_exact',
      'Ergänze ein passendes Wort: Ich fahre ___ dem Bus.',
      null, 'mit', '["mit"]'::jsonb, null, 1,
      'A generic prompt is not an exact-scoring contract.'
    )
  $$,
  '22023',
  'Fill-blank answer contract is ambiguous.',
  'a generic fill prompt still fails closed'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 13, 'fill_blank',
      'local_exact',
      'Wortbank: [mit | MIT]. Ergänze: Ich fahre ___ dem Bus.',
      null, 'mit', '["mit"]'::jsonb, null, 1,
      'Normalized duplicate choices must fail.'
    )
  $$,
  '22023',
  'Fill-blank answer contract is ambiguous.',
  'normalized duplicate closed-bank choices fail closed'
);

select throws_ok(
  $$
    insert into public.practice_test_questions (
      practice_test_id, question_number, question_type, evaluation_mode,
      prompt, options, correct_answer, accepted_answers, rubric,
      answer_contract_version, explanation
    ) values (
      'e1353001-0001-4001-8001-000000000001', 14, 'fill_blank',
      'local_exact',
      'Wortbank: [mit | bei | für | nach | vor | hinter | neben]. Ergänze: Ich fahre ___ dem Bus.',
      null, 'mit', '["mit"]'::jsonb, null, 1,
      'More than six choices must fail.'
    )
  $$,
  '22023',
  'Fill-blank answer contract is ambiguous.',
  'closed banks with more than six choices fail closed'
);

select * from finish(true);
rollback;
