begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

create or replace function pg_temp.phase_13u_worksheet_payload(
  worksheet_title text,
  worksheet_difficulty text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'title', worksheet_title,
    'description', 'Current reviewer qualification regression material.',
    'level', 'A1',
    'grammar_topic', jsonb_build_object(
      'slug', 'phase-13u-current-qualification',
      'name', 'Phase 13U Current Qualification'
    ),
    'difficulty', worksheet_difficulty,
    'visibility', 'workspace',
    'source', 'manual_import',
    'source_label', 'Phase 13U pgTAP fixture',
    'tags', jsonb_build_array('A1', 'current-qualification'),
    'mini_lesson', jsonb_build_object(
      'short_explanation', 'Read the complete sentence before choosing.',
      'key_rule', 'Use the target form only where the sentence requires it.',
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
    (md5('phase-13u-owner')::uuid, 'phase-13u-owner@example.test'::text, 'Phase 13U Owner'::text),
    (md5('phase-13u-student')::uuid, 'phase-13u-student@example.test'::text, 'Phase 13U Student'::text),
    (md5('phase-13u-primary-certifier')::uuid, 'phase-13u-primary-certifier@example.test'::text, 'Phase 13U Primary Certifier'::text),
    (md5('phase-13u-primary-releaser')::uuid, 'phase-13u-primary-releaser@example.test'::text, 'Phase 13U Primary Releaser'::text),
    (md5('phase-13u-expiring-certifier')::uuid, 'phase-13u-expiring-certifier@example.test'::text, 'Phase 13U Expiring Certifier'::text),
    (md5('phase-13u-expiring-releaser')::uuid, 'phase-13u-expiring-releaser@example.test'::text, 'Phase 13U Expiring Releaser'::text),
    (md5('phase-13u-current-certifier')::uuid, 'phase-13u-current-certifier@example.test'::text, 'Phase 13U Current Certifier'::text),
    (md5('phase-13u-current-releaser')::uuid, 'phase-13u-current-releaser@example.test'::text, 'Phase 13U Current Releaser'::text)
) as fixture(user_id, email, full_name);

insert into public.profiles (id, full_name, email, global_role)
select fixture.user_id, fixture.full_name, fixture.email, 'student'
from (
  values
    (md5('phase-13u-owner')::uuid, 'Phase 13U Owner'::text, 'phase-13u-owner@example.test'::text),
    (md5('phase-13u-student')::uuid, 'Phase 13U Student'::text, 'phase-13u-student@example.test'::text),
    (md5('phase-13u-primary-certifier')::uuid, 'Phase 13U Primary Certifier'::text, 'phase-13u-primary-certifier@example.test'::text),
    (md5('phase-13u-primary-releaser')::uuid, 'Phase 13U Primary Releaser'::text, 'phase-13u-primary-releaser@example.test'::text),
    (md5('phase-13u-expiring-certifier')::uuid, 'Phase 13U Expiring Certifier'::text, 'phase-13u-expiring-certifier@example.test'::text),
    (md5('phase-13u-expiring-releaser')::uuid, 'Phase 13U Expiring Releaser'::text, 'phase-13u-expiring-releaser@example.test'::text),
    (md5('phase-13u-current-certifier')::uuid, 'Phase 13U Current Certifier'::text, 'phase-13u-current-certifier@example.test'::text),
    (md5('phase-13u-current-releaser')::uuid, 'Phase 13U Current Releaser'::text, 'phase-13u-current-releaser@example.test'::text)
) as fixture(user_id, full_name, email)
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  md5('phase-13u-workspace')::uuid,
  'Phase 13U Workspace',
  'phase-13u-workspace',
  md5('phase-13u-owner')::uuid
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', md5('phase-13u-owner')::uuid::text, true);
select set_config('app.allow_workspace_owner_insert', 'on', true);
insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13u-workspace')::uuid,
  md5('phase-13u-owner')::uuid,
  'owner'
);
select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13u-workspace')::uuid,
  md5('phase-13u-student')::uuid,
  'student'
);

reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claim.sub', '', true);

insert into app_private.grammar_topic_contracts (slug, display_name)
values (
  'phase-13u-current-qualification',
  'Phase 13U Current Qualification'
);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  md5('phase-13u-topic')::uuid,
  'phase-13u-current-qualification',
  'Phase 13U Current Qualification',
  'A1_A2',
  'Current reviewer qualification regression topic.'
);

insert into app_private.practice_topic_level_assignment_gates (
  grammar_topic_id,
  worksheet_level,
  reason_code,
  rationale
)
values (
  md5('phase-13u-topic')::uuid,
  'A1',
  'level_fit_approval_required',
  'Phase 13U requires a currently qualified exact worksheet release.'
);

insert into app_private.practice_worksheet_bank_reviewers (
  user_id,
  qualification,
  can_certify,
  can_release,
  verified_by,
  verified_at,
  expires_at
)
values
  (
    md5('phase-13u-primary-certifier')::uuid,
    'Qualified German-language primary worksheet certifier',
    true,
    false,
    md5('phase-13u-owner')::uuid,
    now() - interval '3 days',
    null
  ),
  (
    md5('phase-13u-primary-releaser')::uuid,
    'Qualified primary worksheet release controller',
    false,
    true,
    md5('phase-13u-owner')::uuid,
    now() - interval '3 days',
    null
  ),
  (
    md5('phase-13u-expiring-certifier')::uuid,
    'Qualified time-limited German-language worksheet certifier',
    true,
    false,
    md5('phase-13u-owner')::uuid,
    now() - interval '3 days',
    now() + interval '1 day'
  ),
  (
    md5('phase-13u-expiring-releaser')::uuid,
    'Qualified time-limited worksheet release controller',
    false,
    true,
    md5('phase-13u-owner')::uuid,
    now() - interval '3 days',
    now() + interval '1 day'
  ),
  (
    md5('phase-13u-current-certifier')::uuid,
    'Independent currently qualified German-language certifier',
    true,
    false,
    md5('phase-13u-owner')::uuid,
    now() - interval '3 days',
    null
  ),
  (
    md5('phase-13u-current-releaser')::uuid,
    'Independent currently qualified worksheet release controller',
    false,
    true,
    md5('phase-13u-owner')::uuid,
    now() - interval '3 days',
    null
  );

create temporary table phase_13u_state (
  primary_revision_id uuid,
  primary_revision_number integer,
  primary_content_sha256 text,
  expiring_revision_id uuid,
  expiring_clone_id uuid,
  current_revision_id uuid
) on commit drop;

insert into phase_13u_state default values;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13u.a1.primary',
    pg_temp.phase_13u_worksheet_payload(
      'A1 Current Qualification Primary',
      'medium'
    ),
    md5('phase-13u-primary-certifier')::uuid,
    md5('phase-13u-primary-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13U primary review.',
    'Qualified Phase 13U primary release.'
  )
)
update phase_13u_state state
set primary_revision_id = published.revision_id,
    primary_content_sha256 = published.content_sha256
from published;

update phase_13u_state state
set primary_revision_number = revision.revision_number
from app_private.practice_worksheet_template_revisions revision
where revision.id = state.primary_revision_id;

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13u.a1.expiring',
    pg_temp.phase_13u_worksheet_payload(
      'A1 Time-Limited Qualification',
      'easy'
    ),
    md5('phase-13u-expiring-certifier')::uuid,
    md5('phase-13u-expiring-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13U time-limited review.',
    'Qualified Phase 13U time-limited release.'
  )
)
update phase_13u_state state
set expiring_revision_id = published.revision_id
from published;

update phase_13u_state state
set expiring_clone_id = app_private.clone_released_worksheet_template(
  md5('phase-13u-workspace')::uuid,
  state.expiring_revision_id
);

select ok(
  to_regprocedure(
    'app_private.practice_test_canonical_revision_is_current(uuid)'
  ) is not null
    and to_regprocedure(
      'app_private.clone_released_worksheet_template(uuid,uuid)'
    ) is not null
    and to_regprocedure(
      'app_private.guard_worksheet_bank_reviewer_coverage()'
    ) is not null
    and not has_function_privilege(
      'authenticated',
      'app_private.clone_released_worksheet_template(uuid,uuid)',
      'EXECUTE'
    ),
  'current-qualification bank guards exist and stay outside browser authority'
);

select is(
  public.select_released_worksheet_template_internal(
    md5('phase-13u-workspace')::uuid,
    md5('phase-13u-student')::uuid,
    md5('phase-13u-topic')::uuid,
    'A1'
  ),
  (select expiring_revision_id from phase_13u_state),
  'the easier time-limited revision is selectable while both attestations are current'
);

select ok(
  app_private.practice_test_canonical_revision_is_current(
    (select expiring_clone_id from phase_13u_state)
  ),
  'a canonical workspace clone is current before its attestations expire'
);

select ok(
  app_private.practice_topic_level_gate_satisfied(
    md5('phase-13u-topic')::uuid,
    'A1',
    null
  ),
  'a restricted topic-level gate is satisfied while exact bank attestations are current'
);

-- Simulate wall-clock advancement without retaining fixtures outside this
-- rollback-only pgTAP transaction. The immutable attestations are moved into
-- the historical past, then the qualification expiry is placed between those
-- attestation timestamps and transaction now(). Ordinary application writes
-- cannot perform either mutation; trigger bypass is test-local only.
alter table app_private.practice_worksheet_template_reviews
disable trigger practice_worksheet_template_reviews_immutable;
update app_private.practice_worksheet_template_reviews review
set reviewed_at = now() - interval '2 hours'
where review.revision_id = (
  select expiring_revision_id from phase_13u_state
);
alter table app_private.practice_worksheet_template_reviews
enable trigger practice_worksheet_template_reviews_immutable;

alter table app_private.practice_worksheet_template_releases
disable trigger practice_worksheet_template_releases_immutable;
update app_private.practice_worksheet_template_releases release
set released_at = now() - interval '2 hours'
where release.revision_id = (
  select expiring_revision_id from phase_13u_state
);
alter table app_private.practice_worksheet_template_releases
enable trigger practice_worksheet_template_releases_immutable;

alter table app_private.practice_worksheet_bank_reviewers
disable trigger practice_worksheet_bank_reviewers_guard_coverage;
update app_private.practice_worksheet_bank_reviewers reviewer
set expires_at = now() - interval '1 hour'
where reviewer.user_id in (
  md5('phase-13u-expiring-certifier')::uuid,
  md5('phase-13u-expiring-releaser')::uuid
);
alter table app_private.practice_worksheet_bank_reviewers
enable trigger practice_worksheet_bank_reviewers_guard_coverage;

select throws_ok(
  $$
    select *
    from app_private.publish_certified_worksheet_template(
      'phase13u.a1.expiring',
      pg_temp.phase_13u_worksheet_payload(
        'A1 Time-Limited Qualification',
        'easy'
      ),
      md5('phase-13u-current-certifier')::uuid,
      md5('phase-13u-current-releaser')::uuid,
      '{
        "structural_valid":true,
        "ambiguity_free":true,
        "no_answer_leakage":true,
        "level_fit":true,
        "topic_fit":true,
        "type_balance":true,
        "scoring_safe":true
      }'::jsonb,
      'Qualified Phase 13U replay review.',
      'Qualified Phase 13U replay release.'
    )
  $$,
  '55000',
  'worksheet_bank_existing_revision_invalid',
  'current substitute actors cannot replay a revision whose immutable original attesters expired'
);

with definition as (
  select lower(pg_get_functiondef(
    'app_private.publish_certified_worksheet_packet(text,text,jsonb)'::regprocedure
  )) as body
)
select ok(
  body like '%reviewer.expires_at > greatest(selected_reviewed_at, now())%'
    and body like '%releaser.expires_at > greatest(selected_release_authorized_at, now())%',
  'packet publication cannot backdate manifest timestamps around current actor expiry'
)
from definition;

alter table app_private.practice_worksheet_bank_reviewers
disable trigger practice_worksheet_bank_reviewers_guard_coverage;
update app_private.practice_worksheet_bank_reviewers reviewer
set active = false
where reviewer.user_id = md5('phase-13u-primary-certifier')::uuid;
alter table app_private.practice_worksheet_bank_reviewers
enable trigger practice_worksheet_bank_reviewers_guard_coverage;

select ok(
  not app_private.practice_topic_level_gate_satisfied(
    md5('phase-13u-topic')::uuid,
    'A1',
    null
  ),
  'an expired release cannot keep a restricted topic-level generation gate open'
);

update app_private.practice_worksheet_bank_reviewers reviewer
set active = true
where reviewer.user_id = md5('phase-13u-primary-certifier')::uuid;

select is(
  public.select_released_worksheet_template_internal(
    md5('phase-13u-workspace')::uuid,
    md5('phase-13u-student')::uuid,
    md5('phase-13u-topic')::uuid,
    'A1'
  ),
  (select primary_revision_id from phase_13u_state),
  'an expired attestation is excluded even when its revision would otherwise rank first'
);

select ok(
  not app_private.practice_test_canonical_revision_is_current(
    (select expiring_clone_id from phase_13u_state)
  ),
  'an existing canonical clone stops being reusable after reviewer qualification expires'
);

select throws_ok(
  $$
    select app_private.clone_released_worksheet_template(
      md5('phase-13u-workspace')::uuid,
      (select expiring_revision_id from phase_13u_state)
    )
  $$,
  '55000',
  'worksheet_bank_release_hash_mismatch',
  'idempotent clone reuse cannot revive a revision signed by expired attesters'
);

select throws_ok(
  $$
    select *
    from app_private.withdraw_released_worksheet_template(
      (select primary_revision_id from phase_13u_state),
      (select primary_revision_number from phase_13u_state),
      (select primary_content_sha256 from phase_13u_state),
      md5('phase-13u-primary-releaser')::uuid,
      'An expired replacement cannot preserve current worksheet coverage.'
    )
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'withdrawal cannot count a historically valid but currently expired replacement'
);

select throws_ok(
  $$
    update app_private.practice_worksheet_bank_reviewers
    set active = false
    where user_id = md5('phase-13u-primary-certifier')::uuid
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'reviewer mutation cannot count an expired replacement certifier'
);

select throws_ok(
  $$
    update app_private.practice_worksheet_bank_reviewers
    set active = false
    where user_id = md5('phase-13u-primary-releaser')::uuid
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'reviewer mutation cannot count an expired replacement releaser'
);

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase13u.a1.current-alternative',
    pg_temp.phase_13u_worksheet_payload(
      'A1 Current Independent Alternative',
      'hard'
    ),
    md5('phase-13u-current-certifier')::uuid,
    md5('phase-13u-current-releaser')::uuid,
    '{
      "structural_valid":true,
      "ambiguity_free":true,
      "no_answer_leakage":true,
      "level_fit":true,
      "topic_fit":true,
      "type_balance":true,
      "scoring_safe":true
    }'::jsonb,
    'Qualified Phase 13U independent current review.',
    'Qualified Phase 13U independent current release.'
  )
)
update phase_13u_state state
set current_revision_id = published.revision_id
from published;

select lives_ok(
  $$
    do $updates$
    begin
      update app_private.practice_worksheet_bank_reviewers
      set active = false
      where user_id = md5('phase-13u-primary-certifier')::uuid;

      update app_private.practice_worksheet_bank_reviewers
      set active = true
      where user_id = md5('phase-13u-primary-certifier')::uuid;

      update app_private.practice_worksheet_bank_reviewers
      set active = false
      where user_id = md5('phase-13u-primary-releaser')::uuid;

      update app_private.practice_worksheet_bank_reviewers
      set active = true
      where user_id = md5('phase-13u-primary-releaser')::uuid;

      update app_private.practice_worksheet_bank_reviewers
      set active = false
      where user_id = md5('phase-13u-primary-certifier')::uuid;
    end;
    $updates$
  $$,
  'reviewer and releaser changes succeed after a currently qualified exact alternative exists'
);

select is(
  public.select_released_worksheet_template_internal(
    md5('phase-13u-workspace')::uuid,
    md5('phase-13u-student')::uuid,
    md5('phase-13u-topic')::uuid,
    'A1'
  ),
  (select current_revision_id from phase_13u_state),
  'selection falls through to the currently qualified alternative, never the expired revision'
);

update app_private.practice_worksheet_bank_reviewers reviewer
set active = true
where reviewer.user_id = md5('phase-13u-primary-certifier')::uuid;

alter table app_private.practice_worksheet_template_questions
disable trigger practice_worksheet_template_questions_immutable;
update app_private.practice_worksheet_template_questions question
set prompt = question.prompt || ' Bitte sorgfältig prüfen.'
where question.revision_id = (
    select primary_revision_id from phase_13u_state
  )
  and question.question_number = 1;
alter table app_private.practice_worksheet_template_questions
enable trigger practice_worksheet_template_questions_immutable;

select is(
  public.select_released_worksheet_template_internal(
    md5('phase-13u-workspace')::uuid,
    md5('phase-13u-student')::uuid,
    md5('phase-13u-topic')::uuid,
    'A1'
  ),
  (select current_revision_id from phase_13u_state),
  'a hash-damaged top-ranked revision is skipped in favor of a valid current alternative'
);

select * from finish(true);
rollback;
