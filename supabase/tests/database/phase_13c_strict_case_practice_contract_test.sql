begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(6);

create or replace function pg_temp.phase_13c_require_passing_tap(result text)
returns text
language plpgsql
as $$
begin
  if result !~ '^ok [0-9]+' then
    raise exception using
      errcode = 'P0001',
      message = 'phase_13c_tap_assertion_failed',
      detail = result;
  end if;
  return result;
end;
$$;

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
values (
  '00000000-0000-0000-0000-000000000000',
  'd13c1111-1111-4111-8111-111111111111',
  'authenticated',
  'authenticated',
  'phase13c-owner@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Phase 13C Owner"}'::jsonb,
  now(),
  now()
);

insert into public.profiles (id, full_name, email, global_role)
values (
  'd13c1111-1111-4111-8111-111111111111',
  'Phase 13C Owner',
  'phase13c-owner@example.test',
  'student'
)
on conflict (id) do update
set
  full_name = excluded.full_name,
  email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd13c2222-2222-4222-8222-222222222222',
  'Phase 13C Workspace',
  'phase-13c-strict-case',
  'd13c1111-1111-4111-8111-111111111111'
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
  generation_source,
  quality_status
)
select
  'd13c3333-3333-4333-8333-333333333333',
  'd13c2222-2222-4222-8222-222222222222',
  topic.id,
  'A2',
  'easy',
  'Phase 13C capitalization fixture',
  'Transaction-only strict-case regression.',
  false,
  false,
  'private',
  'fixture',
  'unreviewed'
from public.grammar_topics topic
where topic.slug = 'capitalization'
limit 1;

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
  generation_source,
  quality_status
)
select
  'd13c4444-4444-4444-8444-444444444444',
  'd13c2222-2222-4222-8222-222222222222',
  topic.id,
  'A2',
  'easy',
  'Phase 13C relaxed fixture',
  'Transaction-only relaxed-case regression.',
  false,
  false,
  'private',
  'fixture',
  'unreviewed'
from public.grammar_topics topic
where topic.slug = 'articles'
limit 1;

select pg_temp.phase_13c_require_passing_tap(is(
  app_private.normalize_practice_contract_value(' Pflege ', true),
  'Pflege',
  'strict answer-contract normalization preserves capitalization'
));

select pg_temp.phase_13c_require_passing_tap(is(
  app_private.normalize_practice_contract_value(' Pflege ', false),
  'pflege',
  'ordinary answer-contract normalization remains case-insensitive'
));

select pg_temp.phase_13c_require_passing_tap(ok(
  not has_function_privilege(
    'authenticated',
    'app_private.normalize_practice_contract_value(text,boolean)',
    'EXECUTE'
  ),
  'the strict normalizer remains private'
));

insert into public.practice_test_questions (
  id,
  practice_test_id,
  question_number,
  question_type,
  prompt,
  options,
  correct_answer,
  accepted_answers,
  rubric,
  answer_contract_version,
  explanation,
  evaluation_mode
)
values (
  'd13c5555-5555-4555-8555-555555555555',
  'd13c3333-3333-4333-8333-333333333333',
  1,
  'multiple_choice',
  'Welche Schreibweise des Nomens ist korrekt? Wähle die richtige Form.',
  '["Pflege","pflege","PFLEGE"]'::jsonb,
  'Pflege',
  '["Pflege"]'::jsonb,
  null,
  1,
  'Nomen werden großgeschrieben.',
  'local_exact'
);

select pg_temp.phase_13c_require_passing_tap(ok(
  exists (
    select 1
    from public.practice_test_questions question
    where question.id = 'd13c5555-5555-4555-8555-555555555555'
  ),
  'a capitalization worksheet may use case-distinct exact choices'
));

select pg_temp.phase_13c_require_passing_tap(is(
  app_private.practice_answer_review_status_any(
    'pflege',
    'Pflege',
    '["Pflege"]'::jsonb,
    true
  ),
  'incorrect',
  'wrong capitalization remains incorrect during strict local scoring'
));

create or replace function pg_temp.phase_13c_relaxed_case_options_rejected()
returns boolean
language plpgsql
as $$
begin
  insert into public.practice_test_questions (
    id,
    practice_test_id,
    question_number,
    question_type,
    prompt,
    options,
    correct_answer,
    accepted_answers,
    rubric,
    answer_contract_version,
    explanation,
    evaluation_mode
  )
  values (
    'd13c6666-6666-4666-8666-666666666666',
    'd13c4444-4444-4444-8444-444444444444',
    1,
    'multiple_choice',
    'Wähle den passenden Artikel für das Nomen in diesem Satz aus.',
    '["Pflege","pflege","PFLEGE"]'::jsonb,
    'Pflege',
    '["Pflege"]'::jsonb,
    null,
    1,
    'Case-only choices are not valid for an ordinary topic.',
    'local_exact'
  );
  return false;
exception
  when invalid_parameter_value then return true;
end;
$$;

select pg_temp.phase_13c_require_passing_tap(ok(
  pg_temp.phase_13c_relaxed_case_options_rejected(),
  'case-only distractors stay rejected for non-strict topics'
));

select * from finish(true);
rollback;
