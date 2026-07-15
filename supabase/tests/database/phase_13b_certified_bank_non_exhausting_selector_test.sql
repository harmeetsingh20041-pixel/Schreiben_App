begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(11);

create or replace function pg_temp.phase_13b_require_passing_tap(result text)
returns text
language plpgsql
as $$
begin
  if result !~ '^ok [0-9]+' then
    raise exception using
      errcode = 'P0001',
      message = 'phase_13b_tap_assertion_failed',
      detail = result;
  end if;
  return result;
end;
$$;

create or replace function pg_temp.phase_13b_worksheet_payload(
  worksheet_level text,
  topic_slug text,
  worksheet_title text,
  variant_label text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'title', worksheet_title,
    'description', 'Synthetic transaction-only certified selector regression.',
    'level', worksheet_level,
    'grammar_topic', jsonb_build_object('slug', topic_slug),
    'difficulty', 'easy',
    'visibility', 'private',
    'source', 'manual_import',
    'source_label', 'Phase 13B pgTAP fixture',
    'tags', jsonb_build_array('selector', lower(worksheet_level), topic_slug),
    'mini_lesson', jsonb_build_object(
      'short_explanation', 'German verbs can require a fixed preposition.',
      'key_rule', 'Learn the verb and its preposition together.',
      'correct_examples', jsonb_build_array('Ich warte auf den Bus.'),
      'common_mistake_warning', 'Do not translate fixed phrases word for word.',
      'what_to_revise', 'Review common verb-preposition pairs.'
    ),
    'questions', jsonb_build_array(
      jsonb_build_object(
        'question_number', 1,
        'question_type', 'multiple_choice',
        'prompt', format(
          'Wähle die richtige Form (%s): Ich warte ___ den Bus.',
          variant_label
        ),
        'options', jsonb_build_array('auf', 'mit', 'bei'),
        'correct_answer', 'auf',
        'accepted_answers', jsonb_build_array('auf'),
        'rubric', null,
        'answer_contract_version', 1,
        'explanation', 'The fixed phrase is auf den Bus warten.',
        'evaluation_mode', 'local_exact'
      ),
      jsonb_build_object(
        'question_number', 2,
        'question_type', 'multiple_choice',
        'prompt', format(
          'Wähle die richtige Form (%s): Wir fahren ___ dem Zug.',
          variant_label
        ),
        'options', jsonb_build_array('für', 'mit', 'ohne'),
        'correct_answer', 'mit',
        'accepted_answers', jsonb_build_array('mit'),
        'rubric', null,
        'answer_contract_version', 1,
        'explanation', 'Use mit for this means of transport.',
        'evaluation_mode', 'local_exact'
      )
    )
  );
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
values
  (
    '00000000-0000-0000-0000-000000000000',
    'd1311111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase13b-certifier@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13B Certifier"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1322222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase13b-releaser@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13B Releaser"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1333333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'phase13b-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13B Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1344444-4444-4444-8444-444444444444',
    'authenticated',
    'authenticated',
    'phase13b-outsider@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13B Outsider"}'::jsonb,
    now(),
    now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'd1311111-1111-4111-8111-111111111111',
    'Phase 13B Certifier',
    'phase13b-certifier@example.test',
    'student'
  ),
  (
    'd1322222-2222-4222-8222-222222222222',
    'Phase 13B Releaser',
    'phase13b-releaser@example.test',
    'student'
  ),
  (
    'd1333333-3333-4333-8333-333333333333',
    'Phase 13B Student',
    'phase13b-student@example.test',
    'student'
  ),
  (
    'd1344444-4444-4444-8444-444444444444',
    'Phase 13B Outsider',
    'phase13b-outsider@example.test',
    'student'
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd1355555-5555-4555-8555-555555555555',
  'Phase 13B Workspace',
  'phase-13b-certified-selector',
  'd1311111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'd1311111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd1355555-5555-4555-8555-555555555555',
  'd1311111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd1355555-5555-4555-8555-555555555555',
  'd1333333-3333-4333-8333-333333333333',
  'student'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into app_private.practice_worksheet_bank_reviewers (
  user_id,
  qualification,
  can_certify,
  can_release,
  verified_by
)
values
  (
    'd1311111-1111-4111-8111-111111111111',
    'Qualified German-language worksheet reviewer',
    true,
    false,
    'd1311111-1111-4111-8111-111111111111'
  ),
  (
    'd1322222-2222-4222-8222-222222222222',
    'Qualified educational release controller',
    false,
    true,
    'd1311111-1111-4111-8111-111111111111'
  );

create temporary table phase_13b_state (
  exact_one_revision_id uuid,
  exact_two_revision_id uuid,
  exact_one_clone_id uuid,
  exact_two_clone_id uuid
) on commit drop;

insert into phase_13b_state default values;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13b.a2.prepositions.one',
    pg_temp.phase_13b_worksheet_payload(
      'A2',
      'prepositions',
      'Phase 13B A2 Prepositions One',
      'Variante eins'
    ),
    'd1311111-1111-4111-8111-111111111111',
    'd1322222-2222-4222-8222-222222222222',
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified transaction-only selector review.',
    'Qualified transaction-only selector release.'
  )
)
update phase_13b_state state
set exact_one_revision_id = published.revision_id
from published;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13b.a2.prepositions.two',
    pg_temp.phase_13b_worksheet_payload(
      'A2',
      'prepositions',
      'Phase 13B A2 Prepositions Two',
      'Variante zwei'
    ),
    'd1311111-1111-4111-8111-111111111111',
    'd1322222-2222-4222-8222-222222222222',
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified transaction-only selector review.',
    'Qualified transaction-only selector release.'
  )
)
update phase_13b_state state
set exact_two_revision_id = published.revision_id
from published;

select pg_temp.phase_13b_require_passing_tap(ok(
  has_function_privilege(
    'service_role',
    'public.select_released_worksheet_template_internal(uuid,uuid,uuid,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'public.select_released_worksheet_template_internal(uuid,uuid,uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.select_released_worksheet_template_internal(uuid,uuid,uuid,text)',
      'EXECUTE'
    ),
  'the selector remains service-only'
));

select pg_temp.phase_13b_require_passing_tap(is(
  public.select_released_worksheet_template_internal(
    'd1355555-5555-4555-8555-555555555555',
    'd1344444-4444-4444-8444-444444444444',
    (select id from public.grammar_topics where slug = 'prepositions' and level = 'A1_A2'),
    'A2'
  ),
  null::uuid,
  'a profile without current student membership cannot select bank content'
));

select pg_temp.phase_13b_require_passing_tap(is(
  public.select_released_worksheet_template_internal(
    'd1355555-5555-4555-8555-555555555555',
    'd1333333-3333-4333-8333-333333333333',
    (select id from public.grammar_topics where slug = 'prepositions' and level = 'A1_A2'),
    'A1'
  ),
  null::uuid,
  'an A2 certified revision cannot satisfy an A1 worksheet context'
));

select pg_temp.phase_13b_require_passing_tap(is(
  public.select_released_worksheet_template_internal(
    'd1355555-5555-4555-8555-555555555555',
    'd1333333-3333-4333-8333-333333333333',
    (select id from public.grammar_topics where slug = 'articles' and level = 'A1_A2'),
    'A2'
  ),
  null::uuid,
  'an exact-level revision cannot satisfy a different grammar topic'
));

select pg_temp.phase_13b_require_passing_tap(ok(
  public.select_released_worksheet_template_internal(
    'd1355555-5555-4555-8555-555555555555',
    'd1333333-3333-4333-8333-333333333333',
    (select id from public.grammar_topics where slug = 'prepositions' and level = 'A1_A2'),
    'A2'
  ) in (
    (select exact_one_revision_id from phase_13b_state),
    (select exact_two_revision_id from phase_13b_state)
  ),
  'an unseen released revision is available in the exact topic and level context'
));

update phase_13b_state state
set exact_one_clone_id = public.clone_released_worksheet_template_internal(
      'd1355555-5555-4555-8555-555555555555',
      state.exact_one_revision_id
    ),
    exact_two_clone_id = public.clone_released_worksheet_template_internal(
      'd1355555-5555-4555-8555-555555555555',
      state.exact_two_revision_id
    );

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  source,
  status,
  assigned_at,
  started_at,
  completed_at
)
select
  'd1361111-1111-4111-8111-111111111111',
  'd1355555-5555-4555-8555-555555555555',
  'd1333333-3333-4333-8333-333333333333',
  topic.id,
  state.exact_one_clone_id,
  'manual',
  'passed',
  now() - interval '2 days 2 hours',
  now() - interval '2 days 1 hour',
  now() - interval '2 days'
from phase_13b_state state
cross join public.grammar_topics topic
where topic.slug = 'prepositions'
  and topic.level = 'A1_A2';

select pg_temp.phase_13b_require_passing_tap(is(
  public.select_released_worksheet_template_internal(
    'd1355555-5555-4555-8555-555555555555',
    'd1333333-3333-4333-8333-333333333333',
    (select id from public.grammar_topics where slug = 'prepositions' and level = 'A1_A2'),
    'A2'
  ),
  (select exact_two_revision_id from phase_13b_state),
  'an unseen exact-context revision is preferred over a previously used revision'
));

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  source,
  status,
  assigned_at,
  started_at,
  completed_at
)
select
  'd1362222-2222-4222-8222-222222222222',
  'd1355555-5555-4555-8555-555555555555',
  'd1333333-3333-4333-8333-333333333333',
  topic.id,
  state.exact_two_clone_id,
  'manual',
  'passed',
  now() - interval '10 days 2 hours',
  now() - interval '10 days 1 hour',
  now() - interval '10 days'
from phase_13b_state state
cross join public.grammar_topics topic
where topic.slug = 'prepositions'
  and topic.level = 'A1_A2';

select pg_temp.phase_13b_require_passing_tap(is(
  public.select_released_worksheet_template_internal(
    'd1355555-5555-4555-8555-555555555555',
    'd1333333-3333-4333-8333-333333333333',
    (select id from public.grammar_topics where slug = 'prepositions' and level = 'A1_A2'),
    'A2'
  ),
  (select exact_two_revision_id from phase_13b_state),
  'after exhaustion, equally used revisions rotate by least-recent use'
));

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  source,
  status,
  assigned_at,
  started_at,
  completed_at
)
select
  'd1363333-3333-4333-8333-333333333333',
  'd1355555-5555-4555-8555-555555555555',
  'd1333333-3333-4333-8333-333333333333',
  topic.id,
  state.exact_two_clone_id,
  'manual',
  'passed',
  now() - interval '1 day 2 hours',
  now() - interval '1 day 1 hour',
  now() - interval '1 day'
from phase_13b_state state
cross join public.grammar_topics topic
where topic.slug = 'prepositions'
  and topic.level = 'A1_A2';

select pg_temp.phase_13b_require_passing_tap(is(
  public.select_released_worksheet_template_internal(
    'd1355555-5555-4555-8555-555555555555',
    'd1333333-3333-4333-8333-333333333333',
    (select id from public.grammar_topics where slug = 'prepositions' and level = 'A1_A2'),
    'A2'
  ),
  (select exact_one_revision_id from phase_13b_state),
  'after exhaustion, the least-used revision wins before the recency tie-breaker'
));

-- Simulate a legacy damaged state; the current coverage trigger rejects this
-- transition in normal operation.
alter table app_private.practice_worksheet_bank_reviewers
disable trigger practice_worksheet_bank_reviewers_guard_coverage;
update app_private.practice_worksheet_bank_reviewers
set active = false
where user_id = 'd1311111-1111-4111-8111-111111111111';
alter table app_private.practice_worksheet_bank_reviewers
enable trigger practice_worksheet_bank_reviewers_guard_coverage;

select pg_temp.phase_13b_require_passing_tap(is(
  public.select_released_worksheet_template_internal(
    'd1355555-5555-4555-8555-555555555555',
    'd1333333-3333-4333-8333-333333333333',
    (select id from public.grammar_topics where slug = 'prepositions' and level = 'A1_A2'),
    'A2'
  ),
  null::uuid,
  'an inactive certifier makes its released revisions ineligible'
));

update app_private.practice_worksheet_bank_reviewers
set active = true
where user_id = 'd1311111-1111-4111-8111-111111111111';

-- Simulate a legacy damaged state; the current coverage trigger rejects this
-- transition in normal operation.
alter table app_private.practice_worksheet_bank_reviewers
disable trigger practice_worksheet_bank_reviewers_guard_coverage;
update app_private.practice_worksheet_bank_reviewers
set active = false
where user_id = 'd1322222-2222-4222-8222-222222222222';
alter table app_private.practice_worksheet_bank_reviewers
enable trigger practice_worksheet_bank_reviewers_guard_coverage;

select pg_temp.phase_13b_require_passing_tap(is(
  public.select_released_worksheet_template_internal(
    'd1355555-5555-4555-8555-555555555555',
    'd1333333-3333-4333-8333-333333333333',
    (select id from public.grammar_topics where slug = 'prepositions' and level = 'A1_A2'),
    'A2'
  ),
  null::uuid,
  'an inactive releaser makes its released revisions ineligible'
));

update app_private.practice_worksheet_bank_reviewers
set active = true
where user_id = 'd1322222-2222-4222-8222-222222222222';

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  source,
  status,
  assigned_at
)
select
  'd1371111-1111-4111-8111-111111111111',
  'd1355555-5555-4555-8555-555555555555',
  'd1333333-3333-4333-8333-333333333333',
  topic.id,
  state.exact_one_clone_id,
  'manual',
  'unlocked',
  now()
from phase_13b_state state
cross join public.grammar_topics topic
where topic.slug = 'prepositions'
  and topic.level = 'A1_A2';

create or replace function pg_temp.phase_13b_duplicate_active_rejected()
returns boolean
language plpgsql
as $$
begin
  insert into public.student_practice_assignments (
    id,
    workspace_id,
    student_id,
    grammar_topic_id,
    practice_test_id,
    source,
    status,
    assigned_at
  )
  select
    'd1372222-2222-4222-8222-222222222222',
    'd1355555-5555-4555-8555-555555555555',
    'd1333333-3333-4333-8333-333333333333',
    topic.id,
    state.exact_two_clone_id,
    'manual',
    'unlocked',
    now()
  from phase_13b_state state
  cross join public.grammar_topics topic
  where topic.slug = 'prepositions'
    and topic.level = 'A1_A2';
  return false;
exception
  when unique_violation then return true;
end;
$$;

select pg_temp.phase_13b_require_passing_tap(ok(
  pg_temp.phase_13b_duplicate_active_rejected(),
  'the one-active-assignment-per-student/topic invariant remains enforced'
));

select * from finish(true);
rollback;
