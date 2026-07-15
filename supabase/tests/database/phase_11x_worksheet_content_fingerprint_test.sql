begin;

select plan(14);

select ok(
  to_regprocedure('app_private.practice_test_content_sha256(uuid)') is not null
    and (
      select routine.provolatile = 's'
        and not routine.prosecdef
        and routine.prorettype = 'text'::regtype
      from pg_proc as routine
      where routine.oid = 'app_private.practice_test_content_sha256(uuid)'::regprocedure
    ),
  'worksheet fingerprint is a stable security-invoker function returning text only'
);

select ok(
  has_function_privilege(
    'postgres',
    'app_private.practice_test_content_sha256(uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'app_private.practice_test_content_sha256(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.practice_test_content_sha256(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.practice_test_content_sha256(uuid)',
      'EXECUTE'
    ),
  'only the database owner can execute the private release-evidence helper'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  'ec111111-1111-4111-8111-111111111111',
  'authenticated',
  'authenticated',
  'phase11x-owner@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Phase 11X Owner"}'::jsonb,
  now(),
  now()
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  'ed111111-1111-4111-8111-111111111111',
  'Phase 11X Workspace',
  'phase-11x-workspace',
  'ec111111-1111-4111-8111-111111111111'
);

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    'ea111111-1111-4111-8111-111111111111',
    'phase-11x-prepositions',
    'Phase 11X Prepositions',
    'A2',
    'Primary fingerprint fixture topic.'
  ),
  (
    'ea222222-2222-4222-8222-222222222222',
    'phase-11x-word-order',
    'Phase 11X Word Order',
    'A2',
    'Alternate fingerprint fixture topic.'
  );

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by, mini_lesson,
  generation_source, quality_status, quality_notes, reviewed_by, reviewed_at,
  generator_model, generation_metadata, created_at, updated_at
)
values
  (
    'eb111111-1111-4111-8111-111111111111',
    'ed111111-1111-4111-8111-111111111111',
    'ea111111-1111-4111-8111-111111111111',
    'A2',
    'medium',
    'Phase 11X Worksheet',
    'Persisted worksheet description.',
    false,
    true,
    'workspace',
    'ec111111-1111-4111-8111-111111111111',
    '{"key_rule":"Use the correct preposition.","short_explanation":"Prepositions belong to phrases.","correct_examples":["Ich warte auf den Bus."],"common_mistake_warning":"Do not translate literally.","what_to_revise":"Review fixed phrases."}'::jsonb,
    'manual_import',
    'approved',
    'content_sha256=stale-note-value',
    'ec111111-1111-4111-8111-111111111111',
    now() - interval '2 days',
    null,
    null,
    now() - interval '3 days',
    now() - interval '2 days'
  ),
  (
    'eb222222-2222-4222-8222-222222222222',
    'ed111111-1111-4111-8111-111111111111',
    'ea111111-1111-4111-8111-111111111111',
    'A2',
    'medium',
    'Phase 11X Worksheet',
    'Persisted worksheet description.',
    true,
    false,
    'private',
    null,
    '{"what_to_revise":"Review fixed phrases.","correct_examples":["Ich warte auf den Bus."],"short_explanation":"Prepositions belong to phrases.","common_mistake_warning":"Do not translate literally.","key_rule":"Use the correct preposition."}'::jsonb,
    'deepseek',
    'needs_review',
    'unrelated mutable metadata',
    null,
    null,
    'metadata-only-model',
    '{"validation":{"deterministic":false}}'::jsonb,
    now(),
    now()
  );

insert into public.practice_test_questions (
  id, practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation, created_at
)
values
  (
    'ee111111-1111-4111-8111-111111111111',
    'eb111111-1111-4111-8111-111111111111',
    1,
    'fill_blank',
    'local_exact',
    'Nutze die geschlossene Wortbank (zum, zu dem): Ich gehe ___ Arzt.',
    null,
    'zum',
    '["zum","zu dem"]'::jsonb,
    null,
    1,
    'Both the contracted and expanded preposition forms are valid.',
    now() - interval '3 days'
  ),
  (
    'ee222222-2222-4222-8222-222222222222',
    'eb111111-1111-4111-8111-111111111111',
    2,
    'word_order',
    'open_evaluation',
    'Put the words in order: heute / ich / lerne / Deutsch',
    null,
    'Heute lerne ich Deutsch.',
    '[]'::jsonb,
    '{"criteria":["Use every supplied word."],"sample_answer":"Heute lerne ich Deutsch."}'::jsonb,
    1,
    'The conjugated verb occupies position two.',
    now() - interval '3 days'
  ),
  (
    'ee333333-3333-4333-8333-333333333333',
    'eb222222-2222-4222-8222-222222222222',
    1,
    'fill_blank',
    'local_exact',
    'Nutze die geschlossene Wortbank (zum, zu dem): Ich gehe ___ Arzt.',
    null,
    'zum',
    '["zum","zu dem"]'::jsonb,
    null,
    1,
    'Both the contracted and expanded preposition forms are valid.',
    now()
  ),
  (
    'ee444444-4444-4444-8444-444444444444',
    'eb222222-2222-4222-8222-222222222222',
    2,
    'word_order',
    'open_evaluation',
    'Put the words in order: heute / ich / lerne / Deutsch',
    null,
    'Heute lerne ich Deutsch.',
    '[]'::jsonb,
    '{"sample_answer":"Heute lerne ich Deutsch.","criteria":["Use every supplied word."]}'::jsonb,
    1,
    'The conjugated verb occupies position two.',
    now()
  );

create temporary table phase_11x_fingerprint_state (
  baseline text not null
) on commit drop;

insert into phase_11x_fingerprint_state (baseline)
select app_private.practice_test_content_sha256(
  'eb111111-1111-4111-8111-111111111111'
);

select matches(
  (select baseline from phase_11x_fingerprint_state),
  '^[a-f0-9]{64}$',
  'the helper returns a lowercase SHA-256 digest and no worksheet content'
);

select is(
  app_private.practice_test_content_sha256(
    'eb222222-2222-4222-8222-222222222222'
  ),
  (select baseline from phase_11x_fingerprint_state),
  'different row IDs, timestamps, provenance, and JSON object key order keep identical educational content stable'
);

savepoint phase_11x_prompt;
update public.practice_test_questions
set prompt = 'Nutze die geschlossene Wortbank (zum, zu dem): Wir gehen ___ Arzt.'
where id = 'ee111111-1111-4111-8111-111111111111';
select isnt(
  app_private.practice_test_content_sha256('eb111111-1111-4111-8111-111111111111'),
  (select baseline from phase_11x_fingerprint_state),
  'a prompt change alters the digest'
);
rollback to savepoint phase_11x_prompt;

savepoint phase_11x_answers;
update public.practice_test_questions
set accepted_answers = '["zu dem","zum"]'::jsonb
where id = 'ee111111-1111-4111-8111-111111111111';
select isnt(
  app_private.practice_test_content_sha256('eb111111-1111-4111-8111-111111111111'),
  (select baseline from phase_11x_fingerprint_state),
  'an accepted-answer change alters the digest'
);
rollback to savepoint phase_11x_answers;

savepoint phase_11x_rubric;
update public.practice_test_questions
set rubric = '{"criteria":["Use every supplied word.","Keep the verb second."],"sample_answer":"Heute lerne ich Deutsch."}'::jsonb
where id = 'ee222222-2222-4222-8222-222222222222';
select isnt(
  app_private.practice_test_content_sha256('eb111111-1111-4111-8111-111111111111'),
  (select baseline from phase_11x_fingerprint_state),
  'a rubric change alters the digest'
);
rollback to savepoint phase_11x_rubric;

savepoint phase_11x_explanation;
update public.practice_test_questions
set explanation = 'A changed student-facing explanation.'
where id = 'ee111111-1111-4111-8111-111111111111';
select isnt(
  app_private.practice_test_content_sha256('eb111111-1111-4111-8111-111111111111'),
  (select baseline from phase_11x_fingerprint_state),
  'an explanation change alters the digest'
);
rollback to savepoint phase_11x_explanation;

savepoint phase_11x_lesson;
update public.practice_tests
set mini_lesson = jsonb_set(
  mini_lesson,
  '{key_rule}',
  '"Use a newly revised rule."'::jsonb
)
where id = 'eb111111-1111-4111-8111-111111111111';
select isnt(
  app_private.practice_test_content_sha256('eb111111-1111-4111-8111-111111111111'),
  (select baseline from phase_11x_fingerprint_state),
  'a mini-lesson change alters the digest'
);
rollback to savepoint phase_11x_lesson;

savepoint phase_11x_level;
update public.practice_tests
set level = 'B1'
where id = 'eb111111-1111-4111-8111-111111111111';
select isnt(
  app_private.practice_test_content_sha256('eb111111-1111-4111-8111-111111111111'),
  (select baseline from phase_11x_fingerprint_state),
  'a CEFR level change alters the digest'
);
rollback to savepoint phase_11x_level;

savepoint phase_11x_topic;
update public.practice_tests
set grammar_topic_id = 'ea222222-2222-4222-8222-222222222222'
where id = 'eb111111-1111-4111-8111-111111111111';
select isnt(
  app_private.practice_test_content_sha256('eb111111-1111-4111-8111-111111111111'),
  (select baseline from phase_11x_fingerprint_state),
  'a grammar-topic change alters the digest'
);
rollback to savepoint phase_11x_topic;

savepoint phase_11x_order;
update public.practice_test_questions
set question_number = 99
where id = 'ee111111-1111-4111-8111-111111111111';
update public.practice_test_questions
set question_number = 1
where id = 'ee222222-2222-4222-8222-222222222222';
update public.practice_test_questions
set question_number = 2
where id = 'ee111111-1111-4111-8111-111111111111';
select isnt(
  app_private.practice_test_content_sha256('eb111111-1111-4111-8111-111111111111'),
  (select baseline from phase_11x_fingerprint_state),
  'changing the ordered question sequence alters the digest'
);
rollback to savepoint phase_11x_order;

savepoint phase_11x_metadata;
update public.practice_tests
set
  created_by_ai = true,
  teacher_reviewed = false,
  visibility = 'private',
  created_by = null,
  generation_source = 'deepseek',
  quality_status = 'needs_review',
  quality_notes = 'content_sha256=' || repeat('0', 64),
  reviewed_by = null,
  reviewed_at = null,
  generator_model = 'metadata-only-model',
  generation_metadata = '{"validation":{"deterministic":false}}'::jsonb,
  updated_at = now()
where id = 'eb111111-1111-4111-8111-111111111111';
select is(
  app_private.practice_test_content_sha256('eb111111-1111-4111-8111-111111111111'),
  (select baseline from phase_11x_fingerprint_state),
  'metadata-only changes and a stale quality-notes hash do not alter the digest'
);
rollback to savepoint phase_11x_metadata;

select is(
  app_private.practice_test_content_sha256(
    'eb999999-9999-4999-8999-999999999999'
  ),
  null,
  'an unknown revision returns no digest or content'
);

select * from finish();

rollback;
