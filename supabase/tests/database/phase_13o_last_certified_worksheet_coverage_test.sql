begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

create or replace function pg_temp.phase_13o_worksheet_payload(
  topic_slug text,
  topic_name text,
  worksheet_level text,
  worksheet_title text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'title', worksheet_title,
    'description', 'Focused certified worksheet coverage regression material.',
    'level', worksheet_level,
    'grammar_topic', jsonb_build_object(
      'slug', topic_slug,
      'name', topic_name
    ),
    'difficulty', 'easy',
    'visibility', 'workspace',
    'source', 'manual_import',
    'source_label', 'Phase 13O pgTAP fixture',
    'tags', jsonb_build_array(worksheet_level, topic_slug),
    'mini_lesson', jsonb_build_object(
      'short_explanation', 'Read the complete sentence before choosing the form.',
      'key_rule', 'Use the target form only when the sentence requires it.',
      'correct_examples', jsonb_build_array(
        'Das ist das richtige Beispiel.',
        'Hier steht ein zweites richtiges Beispiel.'
      ),
      'common_mistake_warning', 'Do not choose from one isolated word.',
      'what_to_revise', 'Review the target form in complete sentences.'
    ),
    'questions', jsonb_build_array(
      jsonb_build_object(
        'question_number', 1,
        'question_type', 'multiple_choice',
        'prompt', 'Wähle die richtige Form: Das ist ___ richtige Beispiel.',
        'options', jsonb_build_array('das', 'dem', 'den'),
        'correct_answer', 'das',
        'accepted_answers', jsonb_build_array('das'),
        'rubric', null,
        'answer_contract_version', 1,
        'explanation', 'The nominative neuter form is das.',
        'evaluation_mode', 'local_exact'
      ),
      jsonb_build_object(
        'question_number', 2,
        'question_type', 'fill_blank',
        'prompt', 'Nutze die Wortbank [ist, sind, war]: Das Beispiel ___ klar.',
        'options', jsonb_build_array(),
        'correct_answer', 'ist',
        'accepted_answers', jsonb_build_array('ist'),
        'rubric', null,
        'answer_contract_version', 1,
        'explanation', 'The singular subject takes ist.',
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
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  fixture.user_id,
  'authenticated',
  'authenticated',
  fixture.email,
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', fixture.full_name),
  now(),
  now()
from (
  values
    (
      md5('phase-13o-certifier')::uuid,
      'phase-13o-certifier@example.test'::text,
      'Phase 13O Certifier'::text
    ),
    (
      md5('phase-13o-releaser')::uuid,
      'phase-13o-releaser@example.test'::text,
      'Phase 13O Releaser'::text
    ),
    (
      md5('phase-13o-withdrawer')::uuid,
      'phase-13o-withdrawer@example.test'::text,
      'Phase 13O Withdrawal Controller'::text
    )
) as fixture(user_id, email, full_name);

insert into public.profiles (id, full_name, email, global_role)
select fixture.user_id, fixture.full_name, fixture.email, 'student'
from (
  values
    (
      md5('phase-13o-certifier')::uuid,
      'Phase 13O Certifier'::text,
      'phase-13o-certifier@example.test'::text
    ),
    (
      md5('phase-13o-releaser')::uuid,
      'Phase 13O Releaser'::text,
      'phase-13o-releaser@example.test'::text
    ),
    (
      md5('phase-13o-withdrawer')::uuid,
      'Phase 13O Withdrawal Controller'::text,
      'phase-13o-withdrawer@example.test'::text
    )
) as fixture(user_id, full_name, email)
on conflict (id) do update
set
  full_name = excluded.full_name,
  email = excluded.email,
  global_role = excluded.global_role;

insert into app_private.grammar_topic_contracts (slug, display_name)
values
  ('phase-13o-coverage', 'Phase 13O Coverage'),
  ('phase-13o-wrong-topic', 'Phase 13O Wrong Topic'),
  ('phase-13o-duplicate-id', 'Phase 13O Duplicate ID');

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    md5('phase-13o-coverage-topic')::uuid,
    'phase-13o-coverage',
    'Phase 13O Coverage',
    'A1_A2',
    'Canonical topic used to prove exact CEFR coverage.'
  ),
  (
    md5('phase-13o-wrong-topic')::uuid,
    'phase-13o-wrong-topic',
    'Phase 13O Wrong Topic',
    'A1_A2',
    'Different canonical topic that must never satisfy coverage.'
  ),
  (
    md5('phase-13o-duplicate-id-base')::uuid,
    'phase-13o-duplicate-id',
    'Phase 13O Duplicate ID',
    'A1_A2',
    'Base canonical row for the same-slug identity regression.'
  );

insert into app_private.practice_worksheet_bank_reviewers (
  user_id,
  qualification,
  can_certify,
  can_release,
  verified_by
)
values
  (
    md5('phase-13o-certifier')::uuid,
    'Qualified German-language worksheet certifier',
    true,
    false,
    md5('phase-13o-certifier')::uuid
  ),
  (
    md5('phase-13o-releaser')::uuid,
    'Qualified worksheet release controller',
    false,
    true,
    md5('phase-13o-certifier')::uuid
  ),
  (
    md5('phase-13o-withdrawer')::uuid,
    'Independent qualified withdrawal controller',
    false,
    true,
    md5('phase-13o-certifier')::uuid
  );

create temporary table phase_13o_state (
  target_revision_id uuid,
  target_revision_number integer,
  target_content_sha256 text,
  replacement_revision_id uuid,
  replacement_revision_number integer,
  replacement_content_sha256 text,
  duplicate_target_revision_id uuid,
  duplicate_target_revision_number integer,
  duplicate_target_content_sha256 text,
  withdrawal_id uuid
) on commit drop;

insert into phase_13o_state default values;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13o.a1.coverage-target',
    pg_temp.phase_13o_worksheet_payload(
      'phase-13o-coverage',
      'Phase 13O Coverage',
      'A1',
      'A1 Coverage Target'
    ),
    md5('phase-13o-certifier')::uuid,
    md5('phase-13o-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13O target review.',
    'Qualified Phase 13O target release.'
  )
)
update phase_13o_state state
set target_revision_id = published.revision_id,
    target_content_sha256 = published.content_sha256
from published;

update phase_13o_state state
set target_revision_number = revision.revision_number
from app_private.practice_worksheet_template_revisions revision
where revision.id = state.target_revision_id;

select *
from app_private.publish_certified_worksheet_template(
  'phase13o.a1.wrong-topic',
  pg_temp.phase_13o_worksheet_payload(
    'phase-13o-wrong-topic',
    'Phase 13O Wrong Topic',
    'A1',
    'A1 Wrong Topic Release'
  ),
  md5('phase-13o-certifier')::uuid,
  md5('phase-13o-releaser')::uuid,
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb,
  'Qualified Phase 13O wrong-topic review.',
  'Qualified Phase 13O wrong-topic release.'
);

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13o.a1.duplicate-id-target',
    pg_temp.phase_13o_worksheet_payload(
      'phase-13o-duplicate-id',
      'Phase 13O Duplicate ID',
      'A1',
      'A1 Duplicate-ID Target'
    ),
    md5('phase-13o-certifier')::uuid,
    md5('phase-13o-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13O duplicate-ID target review.',
    'Qualified Phase 13O duplicate-ID target release.'
  )
)
update phase_13o_state state
set duplicate_target_revision_id = published.revision_id,
    duplicate_target_content_sha256 = published.content_sha256
from published;

update phase_13o_state state
set duplicate_target_revision_number = revision.revision_number
from app_private.practice_worksheet_template_revisions revision
where revision.id = state.duplicate_target_revision_id;

-- The public topic registry permits one row per slug/declared level. This
-- exact-A1 row shares the canonical slug with the A1_A2 row used above, but it
-- is a different assignment identity and therefore must not count as coverage.
insert into public.grammar_topics (id, slug, name, level, description)
values (
  md5('phase-13o-duplicate-id-exact-a1')::uuid,
  'phase-13o-duplicate-id',
  'Phase 13O Duplicate ID',
  'A1',
  'Exact-A1 duplicate slug row that must not cover the A1_A2 topic identity.'
);

select *
from app_private.publish_certified_worksheet_template(
  'phase13o.a1.duplicate-id-other',
  pg_temp.phase_13o_worksheet_payload(
    'phase-13o-duplicate-id',
    'Phase 13O Duplicate ID',
    'A1',
    'A1 Same-Slug Different-ID Release'
  ),
  md5('phase-13o-certifier')::uuid,
  md5('phase-13o-releaser')::uuid,
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb,
  'Qualified Phase 13O duplicate-ID alternate review.',
  'Qualified Phase 13O duplicate-ID alternate release.'
);

select ok(
  to_regprocedure(
    'app_private.withdraw_released_worksheet_template(uuid,integer,text,uuid,text)'
  ) is not null
    and not has_function_privilege(
      'anon',
      'app_private.withdraw_released_worksheet_template(uuid,integer,text,uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.withdraw_released_worksheet_template(uuid,integer,text,uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.withdraw_released_worksheet_template(uuid,integer,text,uuid,text)',
      'EXECUTE'
    ),
  'the coverage-guarded withdrawal remains a Postgres-only operation'
);

with definition as (
  select lower(pg_get_functiondef(
    'app_private.withdraw_released_worksheet_template(uuid,integer,text,uuid,text)'::regprocedure
  )) as body
)
select ok(
  position('pg_advisory_xact_lock' in body) > 0
    and position('pg_advisory_xact_lock' in body) < position('for update' in body)
    and body like '%target_grammar_topic_id%'
    and body like '%target_topic_slug%'
    and body like '%target_level%'
    and body like '%for share of%replacement_revision%replacement_release%',
  'one topic-level advisory lock precedes row locks and replacement attestations are share-locked'
)
from definition;

select ok(
  (
    select count(*) = 1
    from app_private.practice_worksheet_template_revisions revision
    join app_private.practice_worksheet_templates template
      on template.id = revision.template_id
    join public.grammar_topics topic on topic.id = template.grammar_topic_id
    where topic.slug = 'phase-13o-coverage'
      and template.level = 'A1'
      and revision.state = 'released'
  )
    and exists (
      select 1
      from app_private.practice_worksheet_template_revisions revision
      join app_private.practice_worksheet_templates template
        on template.id = revision.template_id
      join public.grammar_topics topic on topic.id = template.grammar_topic_id
      where topic.slug = 'phase-13o-wrong-topic'
        and template.level = 'A1'
        and revision.state = 'released'
    ),
  'the fixture starts with one exact release plus a released wrong-topic worksheet'
);

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select target_revision_id from phase_13o_state),
      (select target_revision_number from phase_13o_state),
      (select target_content_sha256 from phase_13o_state),
      md5('phase-13o-withdrawer')::uuid,
      'A wrong-topic release cannot preserve exact worksheet coverage.'
    )
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'a released worksheet for another topic cannot authorize withdrawal'
);

select *
from app_private.publish_certified_worksheet_template(
  'phase13o.a2.wrong-level',
  pg_temp.phase_13o_worksheet_payload(
    'phase-13o-coverage',
    'Phase 13O Coverage',
    'A2',
    'A2 Wrong Level Release'
  ),
  md5('phase-13o-certifier')::uuid,
  md5('phase-13o-releaser')::uuid,
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb,
  'Qualified Phase 13O wrong-level review.',
  'Qualified Phase 13O wrong-level release.'
);

select ok(
  exists (
    select 1
    from app_private.practice_worksheet_template_revisions revision
    join app_private.practice_worksheet_templates template
      on template.id = revision.template_id
    join public.grammar_topics topic on topic.id = template.grammar_topic_id
    where topic.slug = 'phase-13o-coverage'
      and template.level = 'A2'
      and revision.state = 'released'
  ),
  'the fixture contains a released worksheet for the right topic but wrong CEFR level'
);

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select target_revision_id from phase_13o_state),
      (select target_revision_number from phase_13o_state),
      (select target_content_sha256 from phase_13o_state),
      md5('phase-13o-withdrawer')::uuid,
      'A wrong-level release cannot preserve exact worksheet coverage.'
    )
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'a released worksheet for another CEFR level cannot authorize withdrawal'
);

select ok(
  not exists (
    select 1
    from app_private.practice_worksheet_template_withdrawals withdrawal
    where withdrawal.revision_id = (
      select target_revision_id from phase_13o_state
    )
  )
    and exists (
      select 1
      from app_private.practice_worksheet_template_revisions revision
      join phase_13o_state state on state.target_revision_id = revision.id
      where revision.state = 'released'
    ),
  'failed sole-release withdrawals leave no ledger row or state transition'
);

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select duplicate_target_revision_id from phase_13o_state),
      (select duplicate_target_revision_number from phase_13o_state),
      (select duplicate_target_content_sha256 from phase_13o_state),
      md5('phase-13o-withdrawer')::uuid,
      'A same-slug worksheet bound to another topic ID is not assignable coverage.'
    )
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'the same slug and CEFR level cannot substitute for a different grammar-topic ID'
);

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13o.a1.coverage-replacement',
    pg_temp.phase_13o_worksheet_payload(
      'phase-13o-coverage',
      'Phase 13O Coverage',
      'A1',
      'A1 Coverage Replacement'
    ),
    md5('phase-13o-certifier')::uuid,
    md5('phase-13o-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13O replacement review.',
    'Qualified Phase 13O replacement release.'
  )
)
update phase_13o_state state
set replacement_revision_id = published.revision_id,
    replacement_content_sha256 = published.content_sha256
from published;

update phase_13o_state state
set replacement_revision_number = revision.revision_number
from app_private.practice_worksheet_template_revisions revision
where revision.id = state.replacement_revision_id;

select ok(
  exists (
    select 1
    from phase_13o_state state
    join app_private.practice_worksheet_template_revisions replacement
      on replacement.id = state.replacement_revision_id
    join app_private.practice_worksheet_templates template
      on template.id = replacement.template_id
    join public.grammar_topics topic on topic.id = template.grammar_topic_id
    where replacement.id <> state.target_revision_id
      and replacement.state = 'released'
      and replacement.content_sha256 = state.replacement_content_sha256
      and replacement.content_sha256 =
        app_private.practice_worksheet_template_revision_sha256(replacement.id)
      and topic.slug = 'phase-13o-coverage'
      and template.level = 'A1'
  ),
  'a distinct released hash-valid replacement exists for the exact topic and level'
);

-- Simulate legacy inactive-attester damage. The dedicated Phase 13T suite
-- proves that a normal update is now rejected before this state can exist.
alter table app_private.practice_worksheet_bank_reviewers
disable trigger practice_worksheet_bank_reviewers_guard_coverage;
update app_private.practice_worksheet_bank_reviewers reviewer
set active = false
where reviewer.user_id = md5('phase-13o-certifier')::uuid;
alter table app_private.practice_worksheet_bank_reviewers
enable trigger practice_worksheet_bank_reviewers_guard_coverage;

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select target_revision_id from phase_13o_state),
      (select target_revision_number from phase_13o_state),
      (select target_content_sha256 from phase_13o_state),
      md5('phase-13o-withdrawer')::uuid,
      'An inactive replacement certifier cannot preserve assignable coverage.'
    )
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'a released replacement with an inactive certifier cannot authorize withdrawal'
);

update app_private.practice_worksheet_bank_reviewers reviewer
set active = true
where reviewer.user_id = md5('phase-13o-certifier')::uuid;

-- Simulate the corresponding legacy inactive-releaser state.
alter table app_private.practice_worksheet_bank_reviewers
disable trigger practice_worksheet_bank_reviewers_guard_coverage;
update app_private.practice_worksheet_bank_reviewers reviewer
set active = false
where reviewer.user_id = md5('phase-13o-releaser')::uuid;
alter table app_private.practice_worksheet_bank_reviewers
enable trigger practice_worksheet_bank_reviewers_guard_coverage;

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select target_revision_id from phase_13o_state),
      (select target_revision_number from phase_13o_state),
      (select target_content_sha256 from phase_13o_state),
      md5('phase-13o-withdrawer')::uuid,
      'An inactive replacement release signer cannot preserve assignable coverage.'
    )
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'a replacement signed by an inactive releaser cannot authorize withdrawal'
);

update app_private.practice_worksheet_bank_reviewers reviewer
set active = true
where reviewer.user_id = md5('phase-13o-releaser')::uuid;

with withdrawn as (
  select *
  from app_private.withdraw_released_worksheet_template(
    (select target_revision_id from phase_13o_state),
    (select target_revision_number from phase_13o_state),
    (select target_content_sha256 from phase_13o_state),
    md5('phase-13o-withdrawer')::uuid,
    'The exact replacement preserves certified worksheet coverage.'
  )
)
update phase_13o_state state
set withdrawal_id = withdrawn.withdrawal_id
from withdrawn
where withdrawn.created;

select ok(
  (select withdrawal_id is not null from phase_13o_state),
  'withdrawal succeeds when a distinct exact-context replacement exists'
);

select ok(
  exists (
    select 1
    from phase_13o_state state
    join app_private.practice_worksheet_template_revisions target
      on target.id = state.target_revision_id
    join app_private.practice_worksheet_template_revisions replacement
      on replacement.id = state.replacement_revision_id
    join app_private.practice_worksheet_template_withdrawals withdrawal
      on withdrawal.id = state.withdrawal_id
    where target.state = 'superseded'
      and replacement.state = 'released'
      and withdrawal.revision_id = target.id
  ),
  'the target is superseded with immutable evidence while the replacement stays released'
);

delete from app_private.grammar_topic_contracts contract
where contract.slug = 'phase-13o-coverage';

select ok(
  exists (
    select 1
    from app_private.withdraw_released_worksheet_template(
      (select target_revision_id from phase_13o_state),
      (select target_revision_number from phase_13o_state),
      (select target_content_sha256 from phase_13o_state),
      md5('phase-13o-withdrawer')::uuid,
      'The exact replacement preserves certified worksheet coverage.'
    ) replay
    join phase_13o_state state on state.withdrawal_id = replay.withdrawal_id
    where replay.created = false
  ),
  'an exact lost-response replay survives later contract drift without a new coverage decision'
);

insert into app_private.grammar_topic_contracts (slug, display_name)
values ('phase-13o-coverage', 'Phase 13O Coverage');

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select replacement_revision_id from phase_13o_state),
      (select replacement_revision_number from phase_13o_state),
      (select replacement_content_sha256 from phase_13o_state),
      md5('phase-13o-withdrawer')::uuid,
      'The final exact-context revision must remain available to students.'
    )
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'the serialized second withdrawal cannot remove the final active replacement'
);

select ok(
  (
    select count(*) = 1
    from app_private.practice_worksheet_template_revisions revision
    join app_private.practice_worksheet_templates template
      on template.id = revision.template_id
    join public.grammar_topics topic on topic.id = template.grammar_topic_id
    where topic.slug = 'phase-13o-coverage'
      and template.level = 'A1'
      and revision.state = 'released'
      and revision.content_sha256 =
        app_private.practice_worksheet_template_revision_sha256(revision.id)
      and not exists (
        select 1
        from app_private.practice_worksheet_template_withdrawals withdrawal
        where withdrawal.revision_id = revision.id
      )
  )
    and (
      select count(*) = 1
      from app_private.practice_worksheet_template_withdrawals withdrawal
      join phase_13o_state state
        on state.target_revision_id = withdrawal.revision_id
    ),
  'one exact released worksheet and one immutable withdrawal remain after every attempt'
);

select * from finish(true);
rollback;
