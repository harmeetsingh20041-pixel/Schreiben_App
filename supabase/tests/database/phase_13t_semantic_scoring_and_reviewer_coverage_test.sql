begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(18);

create or replace function pg_temp.phase_13t_worksheet_payload(
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
    'description', 'Focused reviewer coverage regression material.',
    'level', worksheet_level,
    'grammar_topic', jsonb_build_object(
      'slug', topic_slug,
      'name', topic_name
    ),
    'difficulty', 'easy',
    'visibility', 'workspace',
    'source', 'manual_import',
    'source_label', 'Phase 13T pgTAP fixture',
    'tags', jsonb_build_array(worksheet_level, topic_slug),
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
    (md5('phase-13t-owner')::uuid, 'phase-13t-owner@example.test'::text, 'Phase 13T Owner'::text),
    (md5('phase-13t-student')::uuid, 'phase-13t-student@example.test'::text, 'Phase 13T Student'::text),
    (md5('phase-13t-certifier-one')::uuid, 'phase-13t-certifier-one@example.test'::text, 'Phase 13T Certifier One'::text),
    (md5('phase-13t-releaser-one')::uuid, 'phase-13t-releaser-one@example.test'::text, 'Phase 13T Releaser One'::text),
    (md5('phase-13t-certifier-two')::uuid, 'phase-13t-certifier-two@example.test'::text, 'Phase 13T Certifier Two'::text),
    (md5('phase-13t-releaser-two')::uuid, 'phase-13t-releaser-two@example.test'::text, 'Phase 13T Releaser Two'::text)
) as fixture(user_id, email, full_name);

insert into public.profiles (id, full_name, email, global_role)
select fixture.user_id, fixture.full_name, fixture.email, 'student'
from (
  values
    (md5('phase-13t-owner')::uuid, 'Phase 13T Owner'::text, 'phase-13t-owner@example.test'::text),
    (md5('phase-13t-student')::uuid, 'Phase 13T Student'::text, 'phase-13t-student@example.test'::text),
    (md5('phase-13t-certifier-one')::uuid, 'Phase 13T Certifier One'::text, 'phase-13t-certifier-one@example.test'::text),
    (md5('phase-13t-releaser-one')::uuid, 'Phase 13T Releaser One'::text, 'phase-13t-releaser-one@example.test'::text),
    (md5('phase-13t-certifier-two')::uuid, 'Phase 13T Certifier Two'::text, 'phase-13t-certifier-two@example.test'::text),
    (md5('phase-13t-releaser-two')::uuid, 'Phase 13T Releaser Two'::text, 'phase-13t-releaser-two@example.test'::text)
) as fixture(user_id, full_name, email)
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  md5('phase-13t-workspace')::uuid,
  'Phase 13T Workspace',
  'phase-13t-workspace',
  md5('phase-13t-owner')::uuid
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', md5('phase-13t-owner')::uuid::text, true);
select set_config('app.allow_workspace_owner_insert', 'on', true);
insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13t-workspace')::uuid,
  md5('phase-13t-owner')::uuid,
  'owner'
);
select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  md5('phase-13t-workspace')::uuid,
  md5('phase-13t-student')::uuid,
  'student'
);

insert into public.batches (
  id, workspace_id, name, level, feedback_mode, is_active, created_by
)
values (
  md5('phase-13t-batch')::uuid,
  md5('phase-13t-workspace')::uuid,
  'Phase 13T A2 Class',
  'A2',
  'immediate',
  true,
  md5('phase-13t-owner')::uuid
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  md5('phase-13t-workspace')::uuid,
  md5('phase-13t-batch')::uuid,
  md5('phase-13t-student')::uuid
);

reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claim.sub', '', true);

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by,
  generation_source, quality_status
)
select
  fixture.test_id,
  md5('phase-13t-workspace')::uuid,
  topic.id,
  'A2',
  'medium',
  fixture.title,
  'Semantic target-score persistence regression.',
  false,
  true,
  'workspace',
  md5('phase-13t-owner')::uuid,
  'manual_import',
  'approved'
from (
  values
    (md5('phase-13t-punctuation-test')::uuid, 'punctuation'::text, 'Phase 13T Punctuation'),
    (md5('phase-13t-capitalization-test')::uuid, 'capitalization'::text, 'Phase 13T Capitalization')
) as fixture(test_id, topic_slug, title)
join lateral (
  select selected_topic.id
  from public.grammar_topics selected_topic
  where selected_topic.slug = fixture.topic_slug
  order by selected_topic.id
  limit 1
) topic on true;

insert into public.practice_test_questions (
  id, practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
values
  (
    md5('phase-13t-punctuation-question')::uuid,
    md5('phase-13t-punctuation-test')::uuid,
    1,
    'transformation',
    'open_evaluation',
    'Schreibe die Frage mit dem richtigen Satzzeichen neu.',
    null,
    'Kommst du morgen?',
    '[]'::jsonb,
    '{"criteria":["Use the correct question mark."],"sample_answer":"Kommst du morgen?"}'::jsonb,
    1,
    'A direct question ends with a question mark.'
  ),
  (
    md5('phase-13t-capitalization-question')::uuid,
    md5('phase-13t-capitalization-test')::uuid,
    1,
    'transformation',
    'open_evaluation',
    'Schreibe den Satz mit korrekter Großschreibung neu.',
    null,
    'Die Pflege ist wichtig.',
    '[]'::jsonb,
    '{"criteria":["Capitalize the noun Pflege."],"sample_answer":"Die Pflege ist wichtig."}'::jsonb,
    1,
    'German nouns begin with a capital letter.'
  );

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  batch_id, worksheet_level, class_context_version, class_context_integrity,
  source, status, assigned_by, assigned_at, completed_at, generation_status
)
select
  fixture.assignment_id,
  md5('phase-13t-workspace')::uuid,
  md5('phase-13t-student')::uuid,
  test.grammar_topic_id,
  test.id,
  md5('phase-13t-batch')::uuid,
  'A2',
  1,
  'teacher_verified',
  'manual',
  'completed',
  md5('phase-13t-owner')::uuid,
  now(),
  now(),
  'ready'
from (
  values
    (md5('phase-13t-punctuation-assignment')::uuid, md5('phase-13t-punctuation-test')::uuid),
    (md5('phase-13t-capitalization-assignment')::uuid, md5('phase-13t-capitalization-test')::uuid)
) as fixture(assignment_id, test_id)
join public.practice_tests test on test.id = fixture.test_id;

insert into public.practice_test_attempts (
  id, practice_test_id, student_id, workspace_id, assignment_id, answers,
  score, max_score, score_points, max_score_points, score_percent, passed,
  scoring_version, evaluation_status, evaluation_version,
  evaluation_started_at, status, started_at, submitted_at, completed_at
)
values
  (
    md5('phase-13t-punctuation-attempt')::uuid,
    md5('phase-13t-punctuation-test')::uuid,
    md5('phase-13t-student')::uuid,
    md5('phase-13t-workspace')::uuid,
    md5('phase-13t-punctuation-assignment')::uuid,
    jsonb_build_array(jsonb_build_object(
      'question_id', md5('phase-13t-punctuation-question')::uuid,
      'answer', 'Kommst du morgen.'
    )),
    0, 1, 0, 1, 0, null, 'phase_12l_provisional',
    'evaluating', 1, now(), 'submitted', now(), now(), now()
  ),
  (
    md5('phase-13t-capitalization-attempt')::uuid,
    md5('phase-13t-capitalization-test')::uuid,
    md5('phase-13t-student')::uuid,
    md5('phase-13t-workspace')::uuid,
    md5('phase-13t-capitalization-assignment')::uuid,
    jsonb_build_array(jsonb_build_object(
      'question_id', md5('phase-13t-capitalization-question')::uuid,
      'answer', 'Die pflege ist wichtig.'
    )),
    0, 1, 0, 1, 0, null, 'phase_12l_provisional',
    'evaluating', 1, now(), 'submitted', now(), now(), now()
  );

select ok(
  to_regprocedure('app_private.guard_semantic_target_review_status()') is not null
    and to_regprocedure(
      'app_private.guard_worksheet_bank_reviewer_coverage()'
    ) is not null
    and not has_function_privilege(
      'authenticated',
      'app_private.guard_semantic_target_review_status()',
      'EXECUTE'
    ),
  'both private persistence guards exist and stay outside browser authority'
);

select throws_ok(
  $$
    insert into public.practice_attempt_question_reviews (
      attempt_id, assignment_id, workspace_id, student_id, question_id,
      review_status, points_awarded, max_points, evaluator_source,
      feedback_text, short_reason
    ) values (
      md5('phase-13t-punctuation-attempt')::uuid,
      md5('phase-13t-punctuation-assignment')::uuid,
      md5('phase-13t-workspace')::uuid,
      md5('phase-13t-student')::uuid,
      md5('phase-13t-punctuation-question')::uuid,
      'minor_punctuation', 1, 1, 'teacher',
      'Das Zielsatzzeichen ist falsch.',
      'Das Fragezeichen fehlt.'
    )
  $$,
  '22023',
  'semantic_target_review_status_invalid',
  'a punctuation target cannot receive incidental punctuation credit'
);

select lives_ok(
  $$
    insert into public.practice_attempt_question_reviews (
      attempt_id, assignment_id, workspace_id, student_id, question_id,
      review_status, points_awarded, max_points, evaluator_source,
      feedback_text, short_reason
    ) values (
      md5('phase-13t-punctuation-attempt')::uuid,
      md5('phase-13t-punctuation-assignment')::uuid,
      md5('phase-13t-workspace')::uuid,
      md5('phase-13t-student')::uuid,
      md5('phase-13t-punctuation-question')::uuid,
      'incorrect', 0, 1, 'teacher',
      'Das Zielsatzzeichen ist falsch.',
      'Das Fragezeichen fehlt.'
    )
  $$,
  'the same punctuation target persists with truthful zero credit'
);

select throws_ok(
  $$
    insert into public.practice_attempt_question_reviews (
      attempt_id, assignment_id, workspace_id, student_id, question_id,
      review_status, points_awarded, max_points, evaluator_source,
      feedback_text, short_reason
    ) values (
      md5('phase-13t-capitalization-attempt')::uuid,
      md5('phase-13t-capitalization-assignment')::uuid,
      md5('phase-13t-workspace')::uuid,
      md5('phase-13t-student')::uuid,
      md5('phase-13t-capitalization-question')::uuid,
      'capitalization_issue', 0.5, 1, 'teacher',
      'Die Zielgroßschreibung ist falsch.',
      'Das Nomen muss großgeschrieben werden.'
    )
  $$,
  '22023',
  'semantic_target_review_status_invalid',
  'a capitalization target cannot receive incidental capitalization credit'
);

select lives_ok(
  $$
    insert into public.practice_attempt_question_reviews (
      attempt_id, assignment_id, workspace_id, student_id, question_id,
      review_status, points_awarded, max_points, evaluator_source,
      feedback_text, short_reason
    ) values (
      md5('phase-13t-capitalization-attempt')::uuid,
      md5('phase-13t-capitalization-assignment')::uuid,
      md5('phase-13t-workspace')::uuid,
      md5('phase-13t-student')::uuid,
      md5('phase-13t-capitalization-question')::uuid,
      'incorrect', 0, 1, 'teacher',
      'Die Zielgroßschreibung ist falsch.',
      'Das Nomen muss großgeschrieben werden.'
    )
  $$,
  'the same capitalization target persists with truthful zero credit'
);

select throws_ok(
  $$
    insert into public.practice_attempt_question_reviews (
      attempt_id, assignment_id, workspace_id, student_id, question_id,
      review_status, points_awarded, max_points, evaluator_source,
      feedback_text, short_reason
    ) values (
      md5('phase-13t-capitalization-attempt')::uuid,
      md5('phase-13t-punctuation-assignment')::uuid,
      md5('phase-13t-workspace')::uuid,
      md5('phase-13t-student')::uuid,
      md5('phase-13t-punctuation-question')::uuid,
      'incorrect', 0, 1, 'teacher',
      'Der Versuch und die Aufgabe passen nicht zusammen.',
      'Ungültiger Versuchskontext.'
    )
  $$,
  '55000',
  'semantic_review_target_context_invalid',
  'a semantic review cannot borrow a question from another assignment attempt'
);

select throws_ok(
  $$
    update public.practice_attempt_question_reviews
    set points_awarded = 1
    where attempt_id = md5('phase-13t-punctuation-attempt')::uuid
      and question_id = md5('phase-13t-punctuation-question')::uuid
  $$,
  '22023',
  'semantic_review_status_points_invalid',
  'a points-only update cannot turn an incorrect answer into full credit'
);

select throws_ok(
  $$
    update public.practice_attempt_question_reviews
    set max_points = 2
    where attempt_id = md5('phase-13t-punctuation-attempt')::uuid
      and question_id = md5('phase-13t-punctuation-question')::uuid
  $$,
  '22023',
  'semantic_review_status_points_invalid',
  'semantic review rows retain the one-point worksheet scoring contract'
);

select throws_ok(
  $$
    update public.practice_attempt_question_reviews
    set review_status = 'submitted_for_review'
    where attempt_id = md5('phase-13t-punctuation-attempt')::uuid
      and question_id = md5('phase-13t-punctuation-question')::uuid
  $$,
  '22023',
  'semantic_review_status_points_invalid',
  'an ungraded sentinel cannot be persisted as a completed semantic review'
);

alter table public.practice_attempt_question_reviews
disable trigger practice_attempt_reviews_guard_target_status;
update public.practice_attempt_question_reviews
set points_awarded = 1
where attempt_id = md5('phase-13t-punctuation-attempt')::uuid
  and question_id = md5('phase-13t-punctuation-question')::uuid;

select throws_ok(
  $$select app_private.assert_semantic_review_integrity_precondition()$$,
  '23514',
  'semantic_review_integrity_precondition_failed',
  'the deployment precondition exposes historical semantic scoring damage'
);

update public.practice_attempt_question_reviews
set points_awarded = 0
where attempt_id = md5('phase-13t-punctuation-attempt')::uuid
  and question_id = md5('phase-13t-punctuation-question')::uuid;
alter table public.practice_attempt_question_reviews
enable trigger practice_attempt_reviews_guard_target_status;

insert into app_private.grammar_topic_contracts (slug, display_name)
values
  ('phase-13t-coverage', 'Phase 13T Coverage'),
  ('phase-13t-wrong-topic', 'Phase 13T Wrong Topic');

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    md5('phase-13t-coverage-topic')::uuid,
    'phase-13t-coverage',
    'Phase 13T Coverage',
    'A1_A2',
    'Exact-context reviewer coverage fixture.'
  ),
  (
    md5('phase-13t-wrong-topic')::uuid,
    'phase-13t-wrong-topic',
    'Phase 13T Wrong Topic',
    'A1_A2',
    'Wrong-topic reviewer coverage fixture.'
  );

insert into app_private.practice_worksheet_bank_reviewers (
  user_id, qualification, can_certify, can_release, verified_by
)
values
  (
    md5('phase-13t-certifier-one')::uuid,
    'Qualified German-language worksheet certifier one',
    true, false, md5('phase-13t-owner')::uuid
  ),
  (
    md5('phase-13t-releaser-one')::uuid,
    'Qualified worksheet release controller one',
    false, true, md5('phase-13t-owner')::uuid
  ),
  (
    md5('phase-13t-certifier-two')::uuid,
    'Independent German-language worksheet certifier two',
    true, false, md5('phase-13t-owner')::uuid
  ),
  (
    md5('phase-13t-releaser-two')::uuid,
    'Independent worksheet release controller two',
    false, true, md5('phase-13t-owner')::uuid
  );

select *
from app_private.publish_certified_worksheet_template(
  'phase13t.a1.coverage-primary',
  pg_temp.phase_13t_worksheet_payload(
    'phase-13t-coverage',
    'Phase 13T Coverage',
    'A1',
    'A1 Primary Coverage'
  ),
  md5('phase-13t-certifier-one')::uuid,
  md5('phase-13t-releaser-one')::uuid,
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb,
  'Qualified Phase 13T primary review.',
  'Qualified Phase 13T primary release.'
);

select throws_ok(
  $$
    update app_private.practice_worksheet_bank_reviewers
    set active = false
    where user_id = md5('phase-13t-certifier-one')::uuid
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'the sole certifier cannot remove the final exact-context coverage'
);

select throws_ok(
  $$
    update app_private.practice_worksheet_bank_reviewers
    set active = false
    where user_id = md5('phase-13t-releaser-one')::uuid
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'the sole releaser cannot remove the final exact-context coverage'
);

select *
from app_private.publish_certified_worksheet_template(
  'phase13t.a2.wrong-level',
  pg_temp.phase_13t_worksheet_payload(
    'phase-13t-coverage',
    'Phase 13T Coverage',
    'A2',
    'A2 Wrong-Level Coverage'
  ),
  md5('phase-13t-certifier-two')::uuid,
  md5('phase-13t-releaser-two')::uuid,
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb,
  'Qualified Phase 13T wrong-level review.',
  'Qualified Phase 13T wrong-level release.'
);

select throws_ok(
  $$
    update app_private.practice_worksheet_bank_reviewers
    set can_certify = false
    where user_id = md5('phase-13t-certifier-one')::uuid
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'a replacement at another CEFR level cannot authorize certifier revocation'
);

select *
from app_private.publish_certified_worksheet_template(
  'phase13t.a1.wrong-topic',
  pg_temp.phase_13t_worksheet_payload(
    'phase-13t-wrong-topic',
    'Phase 13T Wrong Topic',
    'A1',
    'A1 Wrong-Topic Coverage'
  ),
  md5('phase-13t-certifier-two')::uuid,
  md5('phase-13t-releaser-two')::uuid,
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb,
  'Qualified Phase 13T wrong-topic review.',
  'Qualified Phase 13T wrong-topic release.'
);

select throws_ok(
  $$
    update app_private.practice_worksheet_bank_reviewers
    set can_release = false
    where user_id = md5('phase-13t-releaser-one')::uuid
  $$,
  '55000',
  'worksheet_bank_last_active_coverage_required',
  'a replacement for another topic cannot authorize releaser revocation'
);

select *
from app_private.publish_certified_worksheet_template(
  'phase13t.a1.coverage-replacement',
  pg_temp.phase_13t_worksheet_payload(
    'phase-13t-coverage',
    'Phase 13T Coverage',
    'A1',
    'A1 Independent Coverage Replacement'
  ),
  md5('phase-13t-certifier-two')::uuid,
  md5('phase-13t-releaser-two')::uuid,
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb,
  'Qualified Phase 13T independent replacement review.',
  'Qualified Phase 13T independent replacement release.'
);

select lives_ok(
  $$
    update app_private.practice_worksheet_bank_reviewers
    set active = false
    where user_id = md5('phase-13t-certifier-one')::uuid
  $$,
  'certifier revocation succeeds after an independent exact replacement exists'
);

select lives_ok(
  $$
    update app_private.practice_worksheet_bank_reviewers
    set active = false
    where user_id = md5('phase-13t-releaser-one')::uuid
  $$,
  'releaser revocation succeeds after an independent exact replacement exists'
);

select ok(
  exists (
    select 1
    from app_private.practice_worksheet_template_revisions revision
    join app_private.practice_worksheet_templates template
      on template.id = revision.template_id
    join public.grammar_topics topic on topic.id = template.grammar_topic_id
    join app_private.practice_worksheet_template_reviews review
      on review.revision_id = revision.id
     and review.content_sha256 = revision.content_sha256
    join app_private.practice_worksheet_template_releases release
      on release.revision_id = revision.id
     and release.review_id = review.id
     and release.content_sha256 = revision.content_sha256
    join app_private.practice_worksheet_bank_reviewers reviewer
      on reviewer.user_id = review.reviewer_id
     and reviewer.active
     and reviewer.can_certify
    join app_private.practice_worksheet_bank_reviewers releaser
      on releaser.user_id = release.released_by
     and releaser.active
     and releaser.can_release
    where topic.id = md5('phase-13t-coverage-topic')::uuid
      and topic.slug = 'phase-13t-coverage'
      and template.level = 'A1'
      and revision.state = 'released'
      and revision.content_sha256 =
        app_private.practice_worksheet_template_revision_sha256(revision.id)
      and not exists (
        select 1
        from app_private.practice_worksheet_template_withdrawals withdrawal
        where withdrawal.revision_id = revision.id
      )
  ),
  'one exact released hash-valid independently attested worksheet remains selectable'
);

select ok(
  not exists (
    select 1
    from public.practice_attempt_question_reviews review
    join public.student_practice_assignments assignment
      on assignment.id = review.assignment_id
    join public.grammar_topics topic on topic.id = assignment.grammar_topic_id
    where (topic.slug = 'punctuation' and review.review_status = 'minor_punctuation')
       or (topic.slug = 'capitalization' and review.review_status = 'capitalization_issue')
  ),
  'no target-topic incidental-credit row persisted after rejected writes'
);

select * from finish(true);
rollback;
