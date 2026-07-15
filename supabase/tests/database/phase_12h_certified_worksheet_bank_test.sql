begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(38);

create or replace function pg_temp.phase_12h_dual_rejected_candidate(
  source_candidate jsonb
)
returns jsonb
language plpgsql
as $$
declare
  candidate_sha256 text :=
    app_private.worksheet_candidate_sha256(source_candidate);
  content_checks jsonb := jsonb_build_object(
    'mini_lesson_scope_accurate', true,
    'learner_cues_semantically_aligned', true,
    'examples_rubrics_consistent', true
  );
  deepseek_critic jsonb;
  gemini_critic jsonb;
  deepseek_reason text :=
    'DeepSeek found an ambiguous exact-scoring task.';
  gemini_reason text :=
    'Gemini found that the same task is not scoring-safe.';
begin
  deepseek_critic := jsonb_build_object(
    'provider', 'deepseek',
    'model', 'deepseek-v4-flash',
    'candidate_sha256', candidate_sha256,
    'approved', false,
    'checks', jsonb_build_object(
      'ambiguity_free', false,
      'no_answer_leakage', true,
      'duplicate_free', true,
      'level_fit', true,
      'topic_fit', true,
      'type_balance', true,
      'scoring_safe', true
    ),
    'content_checks', content_checks,
    'rejection_reasons', jsonb_build_array(deepseek_reason)
  );
  deepseek_critic := deepseek_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(deepseek_critic)
  );

  gemini_critic := jsonb_build_object(
    'provider', 'gemini',
    'model', 'gemini-3.1-flash-lite',
    'candidate_sha256', candidate_sha256,
    'approved', false,
    'checks', jsonb_build_object(
      'ambiguity_free', true,
      'no_answer_leakage', true,
      'duplicate_free', true,
      'level_fit', true,
      'topic_fit', true,
      'type_balance', true,
      'scoring_safe', false
    ),
    'content_checks', content_checks,
    'rejection_reasons', jsonb_build_array(gemini_reason)
  );
  gemini_critic := gemini_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(gemini_critic)
  );

  return source_candidate || jsonb_build_object(
    'validation', jsonb_build_object(
      'deterministic', true,
      'independent_model', false,
      'critic_model', 'deepseek-v4-flash',
      'candidate_sha256', candidate_sha256,
      'critics', jsonb_build_object(
        'deepseek', deepseek_critic,
        'gemini', gemini_critic
      ),
      'attempt_count', 2,
      'checks', jsonb_build_object(
        'ambiguity_free', false,
        'no_answer_leakage', true,
        'duplicate_free', true,
        'level_fit', true,
        'topic_fit', true,
        'type_balance', true,
        'scoring_safe', false
      ),
      'content_checks', content_checks,
      'rejection_reasons', jsonb_build_array(
        deepseek_reason,
        gemini_reason
      )
    )
  );
end;
$$;

select ok(
  to_regclass('app_private.practice_worksheet_templates') is not null
    and to_regclass('app_private.practice_worksheet_template_revisions') is not null
    and to_regclass('app_private.practice_worksheet_template_questions') is not null
    and to_regclass('app_private.practice_worksheet_template_reviews') is not null
    and to_regclass('app_private.practice_worksheet_template_releases') is not null
    and to_regclass('app_private.practice_worksheet_bank_reviewers') is not null
    and not exists (
      select 1 from app_private.practice_worksheet_bank_reviewers
    )
    and not exists (
      select 1 from app_private.practice_worksheet_template_revisions
    ),
  'the private canonical bank exists and deliberately seeds no reviewers or content'
);

select ok(
  not has_table_privilege('anon', 'app_private.practice_worksheet_templates', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.practice_worksheet_templates', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.practice_worksheet_templates', 'SELECT')
    and not has_table_privilege('anon', 'app_private.practice_worksheet_template_revisions', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.practice_worksheet_template_reviews', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.practice_worksheet_template_releases', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.worksheet_generation_rejections', 'SELECT'),
  'browser and service roles cannot read the canonical bank or rejected provider payloads directly'
);

select ok(
  not has_function_privilege(
    'anon',
    'app_private.publish_certified_worksheet_template(text,jsonb,uuid,uuid,jsonb,text,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.publish_certified_worksheet_template(text,jsonb,uuid,uuid,jsonb,text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.publish_certified_worksheet_template(text,jsonb,uuid,uuid,jsonb,text,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.clone_released_worksheet_template_internal(uuid,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.select_released_worksheet_template_internal(uuid,uuid,uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.clone_released_worksheet_template_internal(uuid,uuid)',
      'EXECUTE'
    ),
  'certification is Postgres-only while workers receive only the narrow select and clone bridges'
);

select ok(
  not app_private.worksheet_review_checklist_is_complete(
    '{"structural_valid":true}'::jsonb
  )
    and not app_private.worksheet_template_payload_is_structurally_valid(
      '{"questions":{"not":"an array"}}'::jsonb
    )
    and not app_private.worksheet_template_payload_is_structurally_valid(
      jsonb_build_object(
        'questions', jsonb_build_array(jsonb_build_object(
          'question_number', repeat('9', 200)
        ))
      )
    ),
  'malformed provider/import payloads fail closed without escaping database errors'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'b1211111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12h-certifier@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12H Certifier"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12h-releaser@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12H Releaser"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1233333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase12h-unqualified@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12H Unqualified"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1244444-4444-4444-8444-444444444444',
    'authenticated', 'authenticated', 'phase12h-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12H Student"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1255555-5555-4555-8555-555555555555',
    'authenticated', 'authenticated', 'phase12h-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12H Outsider"}'::jsonb,
    now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'b1211111-1111-4111-8111-111111111111',
    'Phase 12H Certifier', 'phase12h-certifier@example.test', 'student'
  ),
  (
    'b1222222-2222-4222-8222-222222222222',
    'Phase 12H Releaser', 'phase12h-releaser@example.test', 'student'
  ),
  (
    'b1233333-3333-4333-8333-333333333333',
    'Phase 12H Unqualified', 'phase12h-unqualified@example.test', 'student'
  ),
  (
    'b1244444-4444-4444-8444-444444444444',
    'Phase 12H Student', 'phase12h-student@example.test', 'student'
  ),
  (
    'b1255555-5555-4555-8555-555555555555',
    'Phase 12H Outsider', 'phase12h-outsider@example.test', 'student'
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'b1266666-6666-4666-8666-666666666666',
  'Phase 12H Workspace',
  'phase-12h-certified-bank',
  'b1211111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1211111-1111-4111-8111-111111111111', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'b1266666-6666-4666-8666-666666666666',
  'b1211111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'b1266666-6666-4666-8666-666666666666',
  'b1244444-4444-4444-8444-444444444444',
  'student'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by
)
values (
  'b1277777-7777-4777-8777-777777777777',
  'b1266666-6666-4666-8666-666666666666',
  'Phase 12H A2 Class',
  'A2', true,
  'b1211111-1111-4111-8111-111111111111'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  'b1266666-6666-4666-8666-666666666666',
  'b1277777-7777-4777-8777-777777777777',
  'b1244444-4444-4444-8444-444444444444'
);

-- The Phase 13D resolver accepts only closed canonical slugs. Register this
-- rollback-only fixture explicitly instead of relying on display-name fallback.
insert into app_private.grammar_topic_contracts (slug, display_name)
values ('phase-12h-prepositions', 'Phase 12H Prepositions');

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'b1288888-8888-4888-8888-888888888888',
  'phase-12h-prepositions',
  'Phase 12H Prepositions',
  'A1_A2',
  'A deterministic test topic for the certified worksheet bank.'
);

insert into app_private.practice_worksheet_bank_reviewers (
  user_id, qualification, can_certify, can_release, verified_by
)
values
  (
    'b1211111-1111-4111-8111-111111111111',
    'Qualified German-language worksheet reviewer',
    true, false,
    'b1211111-1111-4111-8111-111111111111'
  ),
  (
    'b1222222-2222-4222-8222-222222222222',
    'Qualified educational release controller',
    false, true,
    'b1211111-1111-4111-8111-111111111111'
  );

create temporary table phase_12h_fixture (
  worksheet jsonb not null,
  checklist jsonb not null
);

insert into phase_12h_fixture (worksheet, checklist)
values (
  $worksheet$
  {
    "title":"A2 Certified Preposition Practice",
    "description":"Practise common German prepositional phrases safely.",
    "level":"A2",
    "grammar_topic":{
      "slug":"phase-12h-prepositions",
      "name":"Phase 12H Prepositions"
    },
    "difficulty":"medium",
    "visibility":"workspace",
    "source":"manual_import",
    "source_label":"Phase 12H pgTAP corpus",
    "tags":["A2","prepositions"],
    "mini_lesson":{
      "short_explanation":"German verbs often use a fixed preposition.",
      "key_rule":"Learn the verb and its preposition together.",
      "correct_examples":["Ich warte auf den Bus."],
      "common_mistake_warning":"Do not translate each preposition literally.",
      "what_to_revise":"Review fixed verb-preposition pairs."
    },
    "questions":[
      {
        "question_number":1,
        "question_type":"multiple_choice",
        "prompt":"Choose the correct option: Ich warte ___ den Bus.",
        "options":["auf","mit","bei"],
        "correct_answer":"auf",
        "accepted_answers":["auf"],
        "rubric":null,
        "answer_contract_version":1,
        "explanation":"The fixed phrase is auf den Bus warten.",
        "evaluation_mode":"local_exact"
      },
      {
        "question_number":2,
        "question_type":"fill_blank",
        "prompt":"Use the closed word bank [mit, bei, für]. Complete: Wir fahren ___ dem Zug.",
        "options":[],
        "correct_answer":"mit",
        "accepted_answers":["mit"],
        "rubric":null,
        "answer_contract_version":1,
        "explanation":"Use mit for a means of transport.",
        "evaluation_mode":"local_exact"
      },
      {
        "question_number":3,
        "question_type":"sentence_correction",
        "prompt":"Correct this sentence: Ich warte für den Bus.",
        "options":[],
        "correct_answer":"Ich warte auf den Bus.",
        "accepted_answers":[],
        "rubric":{
          "criteria":["Replace für with auf and preserve the intended meaning."],
          "sample_answer":"Ich warte auf den Bus."
        },
        "answer_contract_version":1,
        "explanation":"Warten takes auf in this phrase.",
        "evaluation_mode":"open_evaluation"
      }
    ]
  }
  $worksheet$::jsonb,
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb
);

select ok(
  app_private.worksheet_template_payload_is_structurally_valid(
    (select worksheet from phase_12h_fixture)
  ),
  'the complete certified worksheet fixture passes the positive structural contract before publication'
);

create temporary table phase_12h_state (
  template_id uuid,
  revision_one_id uuid,
  review_one_id uuid,
  release_one_id uuid,
  hash_one text,
  clone_one_id uuid,
  revision_two_id uuid,
  hash_two text,
  fallback_assignment_id uuid,
  fallback_job_id uuid,
  fallback_message_id bigint,
  fallback_payload jsonb,
  fallback_clone_id uuid
);
insert into phase_12h_state default values;
grant select, update on phase_12h_state to authenticated, service_role;

select throws_ok(
  $$
    select *
    from app_private.publish_certified_worksheet_template(
      'phase12h.a2.prepositions',
      (select worksheet from phase_12h_fixture),
      'b1233333-3333-4333-8333-333333333333',
      'b1222222-2222-4222-8222-222222222222',
      (select checklist from phase_12h_fixture),
      'Qualified review notes.',
      'Qualified release notes.'
    )
  $$,
  '42501',
  'worksheet_bank_reviewer_not_qualified',
  'an unqualified account cannot certify a worksheet'
);

select throws_ok(
  $$
    select *
    from app_private.publish_certified_worksheet_template(
      'phase12h.a2.prepositions',
      (select worksheet from phase_12h_fixture),
      'b1211111-1111-4111-8111-111111111111',
      'b1211111-1111-4111-8111-111111111111',
      (select checklist from phase_12h_fixture),
      'Qualified review notes.',
      'Qualified release notes.'
    )
  $$,
  '42501',
  'worksheet_bank_releaser_not_qualified',
  'the same person cannot self-release unless that separate entitlement is explicitly granted'
);

select throws_ok(
  $$
    select *
    from app_private.publish_certified_worksheet_template(
      'phase12h.a2.prepositions',
      (select worksheet from phase_12h_fixture),
      'b1211111-1111-4111-8111-111111111111',
      'b1222222-2222-4222-8222-222222222222',
      '{"structural_valid":true}'::jsonb,
      'Qualified review notes.',
      'Qualified release notes.'
    )
  $$,
  '22023',
  'worksheet_bank_publish_invalid',
  'an incomplete review checklist cannot create an approval'
);

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase12h.a2.prepositions',
    (select worksheet from phase_12h_fixture),
    'b1211111-1111-4111-8111-111111111111',
    'b1222222-2222-4222-8222-222222222222',
    (select checklist from phase_12h_fixture),
    'Qualified review notes.',
    'Qualified release notes.'
  )
)
update phase_12h_state state
set template_id = published.template_id,
    revision_one_id = published.revision_id,
    review_one_id = published.review_id,
    release_one_id = published.release_id,
    hash_one = published.content_sha256
from published;

select ok(
  (select revision_one_id is not null from phase_12h_state),
  'the qualified publisher creates one canonical revision atomically'
);

select ok(
  exists (
    select 1
    from phase_12h_state state
    join app_private.practice_worksheet_template_revisions revision
      on revision.id = state.revision_one_id
    join app_private.practice_worksheet_template_reviews review
      on review.id = state.review_one_id
    join app_private.practice_worksheet_template_releases release
      on release.id = state.release_one_id
    where revision.state = 'released'
      and revision.revision_number = 1
      and review.revision_id = revision.id
      and release.revision_id = revision.id
      and revision.content_sha256 = state.hash_one
      and review.content_sha256 = state.hash_one
      and release.content_sha256 = state.hash_one
      and app_private.practice_worksheet_template_revision_sha256(revision.id) = state.hash_one
  ),
  'release, review, revision, and DB-recomputed content hashes all agree'
);

insert into app_private.practice_topic_level_assignment_gates (
  grammar_topic_id,
  worksheet_level,
  reason_code,
  rationale
)
values (
  'b1288888-8888-4888-8888-888888888888',
  'A2',
  'level_fit_approval_required',
  'Transaction-only proof that a qualified exact-level release satisfies the assignment gate.'
);

select ok(
  app_private.practice_topic_level_gate_satisfied(
    'b1288888-8888-4888-8888-888888888888',
    'A2',
    null
  ),
  'a complete qualified and hash-bound level-fit release satisfies a restricted context without teacher workload'
);

select is(
  (
    select published.revision_id
    from app_private.publish_certified_worksheet_template(
      'phase12h.a2.prepositions',
      (select worksheet from phase_12h_fixture),
      'b1211111-1111-4111-8111-111111111111',
      'b1222222-2222-4222-8222-222222222222',
      (select checklist from phase_12h_fixture),
      'Qualified review notes.',
      'Qualified release notes.'
    ) published
  ),
  (select revision_one_id from phase_12h_state),
  'publishing identical content is idempotent'
);

select throws_ok(
  format(
    'insert into app_private.practice_worksheet_template_reviews '
      || '(revision_id, reviewer_id, decision, checklist, notes, content_sha256) '
      || 'select %L, %L, %L, checklist, %L, %L from phase_12h_fixture',
    (select revision_one_id from phase_12h_state),
    'b1211111-1111-4111-8111-111111111111',
    'approved',
    'Bypass review notes.',
    (select hash_one from phase_12h_state)
  ),
  '55000',
  'worksheet_bank_attestation_publisher_required',
  'direct review attestation inserts cannot bypass the publisher'
);

select throws_ok(
  format(
    'update app_private.practice_worksheet_templates set template_key = %L where id = %L',
    'phase12h.changed.key',
    (select template_id from phase_12h_state)
  ),
  '55000',
  'worksheet_bank_history_immutable',
  'canonical template identity is immutable'
);

select throws_ok(
  format(
    'update app_private.practice_worksheet_template_revisions set title = %L where id = %L',
    'Changed title',
    (select revision_one_id from phase_12h_state)
  ),
  '55000',
  'worksheet_bank_revision_immutable',
  'released revision content is immutable'
);

select throws_ok(
  format(
    'update app_private.practice_worksheet_template_reviews set notes = %L where id = %L',
    'Changed review notes.',
    (select review_one_id from phase_12h_state)
  ),
  '55000',
  'worksheet_bank_history_immutable',
  'review attestations are immutable'
);

select throws_ok(
  format(
    'delete from app_private.practice_worksheet_template_releases where id = %L',
    (select release_one_id from phase_12h_state)
  ),
  '55000',
  'worksheet_bank_history_immutable',
  'release attestations cannot be deleted'
);

set local role service_role;
update phase_12h_state state
set clone_one_id = public.clone_released_worksheet_template_internal(
  'b1266666-6666-4666-8666-666666666666',
  state.revision_one_id
);
reset role;

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'b12bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'phase-12h-reuse-ledger',
  'Phase 12H Reuse Ledger',
  'A2',
  'A dedicated topic for exact reusable completion replay coverage.'
);

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by, mini_lesson,
  generation_source, quality_status
)
values
  (
    'b12ccccc-cccc-4ccc-8ccc-cccccccccccc',
    'b1266666-6666-4666-8666-666666666666',
    'b12bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'A2', 'easy', 'Phase 12H Reuse A', 'First reusable revision.',
    false, true, 'workspace',
    'b1211111-1111-4111-8111-111111111111',
    '{"short_explanation":"Choose the correct article.","key_rule":"Use the case required by the sentence.","correct_examples":["Ich sehe den Mann."],"common_mistake_warning":"Check the noun gender and case.","what_to_revise":"Review masculine accusative articles."}'::jsonb,
    'manual_import', 'approved'
  ),
  (
    'b12ddddd-dddd-4ddd-8ddd-dddddddddddd',
    'b1266666-6666-4666-8666-666666666666',
    'b12bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'A2', 'easy', 'Phase 12H Reuse B', 'Second reusable revision.',
    false, true, 'workspace',
    'b1211111-1111-4111-8111-111111111111',
    '{"short_explanation":"Choose the correct article.","key_rule":"Use the case required by the sentence.","correct_examples":["Ich sehe den Mann."],"common_mistake_warning":"Check the noun gender and case.","what_to_revise":"Review masculine accusative articles."}'::jsonb,
    'manual_import', 'approved'
  );

insert into public.practice_test_questions (
  practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
values
  (
    'b12ccccc-cccc-4ccc-8ccc-cccccccccccc',
    1, 'multiple_choice', 'local_exact',
    'Choose the correct article: Ich sehe ___ Mann.',
    '["den","dem","der"]'::jsonb,
    'den', '["den"]'::jsonb, null, 1,
    'The masculine accusative article is den.'
  ),
  (
    'b12ddddd-dddd-4ddd-8ddd-dddddddddddd',
    1, 'multiple_choice', 'local_exact',
    'Choose the correct article: Er hilft ___ Mann.',
    '["den","dem","der"]'::jsonb,
    'dem', '["dem"]'::jsonb, null, 1,
    'The masculine dative article is dem.'
  );

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, generation_status, batch_id,
  worksheet_level, class_context_version, class_context_integrity
)
values (
  'b12eeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'b1266666-6666-4666-8666-666666666666',
  'b1244444-4444-4444-8444-444444444444',
  'b12bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  null,
  'manual', 'unlocked',
  'b1211111-1111-4111-8111-111111111111',
  'idle',
  'b1277777-7777-4777-8777-777777777777',
  'A2', 1, 'teacher_verified'
);

create temporary table phase_12h_reuse_state (
  job_id uuid,
  message_id bigint,
  completed_test_id uuid
);
insert into phase_12h_reuse_state default values;
grant select, update on phase_12h_reuse_state to authenticated, service_role;

-- Current request paths attach eligible workspace material before paid work.
-- Seed one explicit historical durable job so this section continues to test
-- the completion ledger and exact replay boundary rather than request policy.
update public.student_practice_assignments assignment
set
  generation_version = 1,
  generation_status = 'queued',
  generation_started_at = null,
  generation_completed_at = null,
  generation_error = null
where assignment.id = 'b12eeeee-eeee-4eee-8eee-eeeeeeeeeeee';

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'worksheet_generation',
    'b12eeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    1,
    'phase-12h-reuse-completion-ledger',
    'b1244444-4444-4444-8444-444444444444',
    0
  )
)
update pg_temp.phase_12h_reuse_state state
set job_id = enqueued.job_id
from enqueued;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
with claimed as (
  select *
  from api.claim_async_jobs(
    'worksheet_generation',
    'b12fffff-ffff-4fff-8fff-ffffffffffff',
    1,
    240
  )
)
update pg_temp.phase_12h_reuse_state state
set job_id = claimed.job_id,
    message_id = claimed.queue_message_id
from claimed
where claimed.entity_id = 'b12eeeee-eeee-4eee-8eee-eeeeeeeeeeee';

with completed as (
  select *
  from api.complete_worksheet_generation(
    (select job_id from pg_temp.phase_12h_reuse_state),
    (select message_id from pg_temp.phase_12h_reuse_state),
    'b12fffff-ffff-4fff-8fff-ffffffffffff',
    '{"schema_version":1,"mode":"reuse","reusable_practice_test_id":"b12ccccc-cccc-4ccc-8ccc-cccccccccccc"}'::jsonb
  )
)
update pg_temp.phase_12h_reuse_state state
set completed_test_id = completed.practice_test_id
from completed;
reset role;

select ok(
  exists (
    select 1
    from phase_12h_reuse_state state
    join app_private.worksheet_generation_completions_v2 completion
      on completion.job_id = state.job_id
    where state.completed_test_id = 'b12ccccc-cccc-4ccc-8ccc-cccccccccccc'
      and completion.practice_test_id = state.completed_test_id
      and completion.completion_mode = 'reuse'
      and completion.evidence_version = 2
      and completion.provider_source is null
      and completion.payload_sha256 =
        app_private.worksheet_generation_payload_sha256(
          '{"schema_version":1,"mode":"reuse","reusable_practice_test_id":"b12ccccc-cccc-4ccc-8ccc-cccccccccccc"}'::jsonb
        )
  ),
  'a succeeded reuse completion records its exact reusable ID in the canonical replay ledger'
);

set local role service_role;
select is(
  (
    select completed.practice_test_id
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_12h_reuse_state),
      (select message_id from pg_temp.phase_12h_reuse_state),
      'b12fffff-ffff-4fff-8fff-ffffffffffff',
      '{"schema_version":1,"mode":"reuse","reusable_practice_test_id":"b12ccccc-cccc-4ccc-8ccc-cccccccccccc"}'::jsonb
    ) completed
  ),
  'b12ccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
  'an exact succeeded reuse delivery is idempotent'
);

select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_12h_reuse_state),
      (select message_id from pg_temp.phase_12h_reuse_state),
      'b12fffff-ffff-4fff-8fff-ffffffffffff',
      '{"schema_version":1,"mode":"reuse","reusable_practice_test_id":"b12ddddd-dddd-4ddd-8ddd-dddddddddddd"}'::jsonb
    )
  $$,
  '55000',
  'Worksheet completion replay does not match persisted result.',
  'a succeeded reuse job rejects a changed reusable worksheet ID'
);
reset role;

select ok(
  exists (
    select 1
    from phase_12h_state state
    join public.practice_tests test on test.id = state.clone_one_id
    where test.workspace_id = 'b1266666-6666-4666-8666-666666666666'
      and test.worksheet_template_revision_id = state.revision_one_id
      and test.worksheet_template_release_id = state.release_one_id
      and test.approval_source = 'certified_template_bank'
      and test.generation_source = 'certified_bank'
      and test.quality_status = 'approved'
      and test.template_content_sha256 = state.hash_one
      and app_private.practice_test_content_sha256(test.id) = state.hash_one
  ),
  'the service bridge creates an approved exact-hash workspace clone with explicit provenance'
);

select is(
  public.clone_released_worksheet_template_internal(
    'b1266666-6666-4666-8666-666666666666',
    (select revision_one_id from phase_12h_state)
  ),
  (select clone_one_id from phase_12h_state),
  'repeating a clone request returns the same per-workspace worksheet'
);

select throws_ok(
  format(
    'update public.practice_tests set title = %L where id = %L',
    'Mutated clone',
    (select clone_one_id from phase_12h_state)
  ),
  '55000',
  'certified_template_clone_immutable',
  'a certified workspace clone cannot be changed'
);

select throws_ok(
  format(
    'update public.practice_test_questions set prompt = %L where practice_test_id = %L and question_number = 1',
    'Mutated certified question prompt.',
    (select clone_one_id from phase_12h_state)
  ),
  '55000',
  'certified_template_question_immutable',
  'questions copied from a certified revision cannot be changed'
);

select is(
  public.select_released_worksheet_template_internal(
    'b1266666-6666-4666-8666-666666666666',
    'b1244444-4444-4444-8444-444444444444',
    'b1288888-8888-4888-8888-888888888888',
    'A2'
  ),
  (select revision_one_id from phase_12h_state),
  'selection uses the exact workspace, active student, topic, and CEFR context'
);

insert into public.student_practice_assignments (
  workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, generation_status, batch_id, worksheet_level,
  class_context_version, class_context_integrity, completed_at
)
select
  'b1266666-6666-4666-8666-666666666666',
  'b1244444-4444-4444-8444-444444444444',
  'b1288888-8888-4888-8888-888888888888',
  state.clone_one_id,
  'manual', 'completed', 'b1211111-1111-4111-8111-111111111111', 'ready',
  'b1277777-7777-4777-8777-777777777777', 'A2', 1,
  'teacher_verified', now()
from phase_12h_state state;

select is(
  public.select_released_worksheet_template_internal(
    'b1266666-6666-4666-8666-666666666666',
    'b1244444-4444-4444-8444-444444444444',
    'b1288888-8888-4888-8888-888888888888',
    'A2'
  ),
  (select revision_one_id from phase_12h_state),
  'after the exact context is exhausted, the released revision remains safely reusable'
);

with published as (
  select *
  from app_private.publish_certified_worksheet_template(
    'phase12h.a2.prepositions',
    jsonb_set(
      (select worksheet from phase_12h_fixture),
      '{title}',
      to_jsonb('A2 Certified Preposition Practice Revision 2'::text)
    ),
    'b1211111-1111-4111-8111-111111111111',
    'b1222222-2222-4222-8222-222222222222',
    (select checklist from phase_12h_fixture),
    'Qualified second review notes.',
    'Qualified second release notes.'
  )
)
update phase_12h_state state
set revision_two_id = published.revision_id,
    hash_two = published.content_sha256
from published;

select ok(
  exists (
    select 1
    from phase_12h_state state
    join app_private.practice_worksheet_template_revisions revision
      on revision.id = state.revision_two_id
    where revision.template_id = state.template_id
      and revision.revision_number = 2
      and revision.state = 'released'
      and revision.content_sha256 = state.hash_two
      and state.hash_two <> state.hash_one
  )
    and (
      select count(*) = 2
      from app_private.practice_worksheet_template_revisions revision
      where revision.template_id = (select template_id from phase_12h_state)
    ),
  'changed educational content creates a new immutable revision without replacing history'
);

select is(
  public.select_released_worksheet_template_internal(
    'b1266666-6666-4666-8666-666666666666',
    'b1244444-4444-4444-8444-444444444444',
    'b1288888-8888-4888-8888-888888888888',
    'A2'
  ),
  (select revision_two_id from phase_12h_state),
  'after prior practice, the next unseen certified revision is eligible'
);

select ok(
  public.select_released_worksheet_template_internal(
    'b1266666-6666-4666-8666-666666666666',
    'b1244444-4444-4444-8444-444444444444',
    'b1288888-8888-4888-8888-888888888888',
    'B2'
  ) is null
    and public.select_released_worksheet_template_internal(
      'b1266666-6666-4666-8666-666666666666',
      'b1255555-5555-4555-8555-555555555555',
      'b1288888-8888-4888-8888-888888888888',
      'A2'
    ) is null,
  'wrong-level and nonmember contexts cannot select bank content'
);

-- Preserve this historical selector test by explicitly simulating a damaged
-- pre-guard database state. Normal reviewer updates cannot create it.
alter table app_private.practice_worksheet_bank_reviewers
disable trigger practice_worksheet_bank_reviewers_guard_coverage;
update app_private.practice_worksheet_bank_reviewers
set active = false
where user_id = 'b1211111-1111-4111-8111-111111111111';
alter table app_private.practice_worksheet_bank_reviewers
enable trigger practice_worksheet_bank_reviewers_guard_coverage;

select is(
  public.select_released_worksheet_template_internal(
    'b1266666-6666-4666-8666-666666666666',
    'b1244444-4444-4444-8444-444444444444',
    'b1288888-8888-4888-8888-888888888888',
    'A2'
  ),
  null::uuid,
  'revoking a qualification immediately removes its canonical revisions from eligibility'
);

update app_private.practice_worksheet_bank_reviewers
set active = true
where user_id = 'b1211111-1111-4111-8111-111111111111';

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, generation_status, batch_id,
  worksheet_level, class_context_version, class_context_integrity
)
values (
  'b1299999-9999-4999-8999-999999999999',
  'b1266666-6666-4666-8666-666666666666',
  'b1244444-4444-4444-8444-444444444444',
  'b1288888-8888-4888-8888-888888888888',
  null,
  'manual', 'unlocked',
  'b1211111-1111-4111-8111-111111111111',
  'idle',
  'b1277777-7777-4777-8777-777777777777',
  'A2', 1, 'teacher_verified'
);

update phase_12h_state
set fallback_assignment_id = 'b1299999-9999-4999-8999-999999999999';

-- The normal browser path now attaches certified content synchronously. Keep a
-- separate pre-existing durable job fixture so this suite still proves the
-- worker completion/rejection ledger boundary and exact replay semantics.
update public.student_practice_assignments assignment
set
  generation_version = 1,
  generation_status = 'queued',
  generation_started_at = null,
  generation_completed_at = null,
  generation_error = null
where assignment.id = 'b1299999-9999-4999-8999-999999999999';

with enqueued as (
  select *
  from app_private.enqueue_async_job(
    'worksheet_generation',
    'b1299999-9999-4999-8999-999999999999',
    1,
    'phase-12h-certified-worker-boundary',
    'b1244444-4444-4444-8444-444444444444',
    0
  )
)
update phase_12h_state state
set fallback_job_id = enqueued.job_id
from enqueued;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from api.claim_async_jobs(
    'worksheet_generation',
    'b12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    1,
    240
  )
)
update pg_temp.phase_12h_state state
set fallback_job_id = claimed.job_id,
    fallback_message_id = claimed.queue_message_id
from claimed
where claimed.entity_id = state.fallback_assignment_id;

reset role;

select ok(
  (select fallback_job_id is not null and fallback_message_id is not null
   from phase_12h_state),
  'the exact-context assignment reaches one durable processing job'
);

set local role service_role;
select is(
  (
    select context.certified_template_revision_id
    from api.get_worksheet_generation_context(
      'b1299999-9999-4999-8999-999999999999'
    ) context
  ),
  (select revision_two_id from pg_temp.phase_12h_state),
  'generation context prefers the next unseen certified revision from the frozen A2 class snapshot'
);
reset role;

update phase_12h_state state
set fallback_payload = jsonb_build_object(
  'schema_version', 1,
  'mode', 'certified_bank',
  'template_revision_id', state.revision_two_id,
  'fallback_reason', 'candidates_rejected',
  'rejected_candidates', jsonb_build_array(jsonb_build_object(
    'attempt_number', 2,
    'provider', 'deepseek',
    'model', 'deepseek-v4-pro',
    'rejection_reasons', jsonb_build_array(
      'DeepSeek found an ambiguous exact-scoring task.',
      'Gemini found that the same task is not scoring-safe.'
    ),
    'candidate', pg_temp.phase_12h_dual_rejected_candidate(jsonb_build_object(
      'schema_version', 1,
      'mode', 'generated',
      'generation_source', 'deepseek',
      'generator_model', 'deepseek-v4-pro',
      'title', 'Rejected A2 Provider Candidate',
      'level', 'A2',
      'difficulty', 'medium',
      'description', 'A structurally valid candidate held after independent rejection.',
      'mini_lesson', fixture.worksheet -> 'mini_lesson',
      'questions', fixture.worksheet -> 'questions',
      'source_mix', jsonb_build_object(
        'mode', 'deepseek', 'deepseek_count', 3, 'gemini_count', 0
      )
    ))
  ))
)
from phase_12h_fixture fixture;

set local role service_role;
with completed as (
  select *
  from api.complete_worksheet_generation(
    (select fallback_job_id from pg_temp.phase_12h_state),
    (select fallback_message_id from pg_temp.phase_12h_state),
    'b12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select fallback_payload from pg_temp.phase_12h_state)
  )
)
update pg_temp.phase_12h_state state
set fallback_clone_id = completed.practice_test_id
from completed;
reset role;

select ok(
  exists (
    select 1
    from phase_12h_state state
    join public.student_practice_assignments assignment
      on assignment.id = state.fallback_assignment_id
    join public.practice_tests test on test.id = state.fallback_clone_id
    join app_private.async_jobs job on job.id = state.fallback_job_id
    where assignment.practice_test_id = test.id
      and assignment.generation_status = 'ready'
      and test.worksheet_template_revision_id = state.revision_two_id
      and test.approval_source = 'certified_template_bank'
      and job.status = 'succeeded'
  ),
  'completion atomically attaches the certified clone and reaches a valid terminal job state'
);

select ok(
  exists (
    select 1
    from phase_12h_state state
    join app_private.worksheet_bank_fallback_events event
      on event.job_id = state.fallback_job_id
    join app_private.worksheet_generation_rejections rejection
      on rejection.fallback_event_id = event.id
    where event.assignment_id = state.fallback_assignment_id
      and event.template_revision_id = state.revision_two_id
      and event.cloned_practice_test_id = state.fallback_clone_id
      and event.fallback_reason = 'candidates_rejected'
      and event.rejection_count = 1
      and event.completion_payload_sha256 = encode(
        sha256(convert_to(state.fallback_payload::text, 'UTF8')),
        'hex'
      )
      and rejection.attempt_number = 2
      and rejection.candidate_sha256 = encode(
        sha256(convert_to(rejection.candidate::text, 'UTF8')),
        'hex'
      )
  ),
  'rejected provider content remains private with DB-recomputed payload and candidate hashes'
);

select ok(
  exists (
    select 1
    from phase_12h_state state
    join pgmq.a_worksheet_generation archived
      on archived.msg_id = state.fallback_message_id
  )
    and not exists (
      select 1
      from phase_12h_state state
      join pgmq.q_worksheet_generation live
        on live.msg_id = state.fallback_message_id
    ),
  'the fallback completion archives the durable queue message without leaving a live duplicate'
);

set local role service_role;
select is(
  (
    select completed.practice_test_id
    from api.complete_worksheet_generation(
      (select fallback_job_id from pg_temp.phase_12h_state),
      (select fallback_message_id from pg_temp.phase_12h_state),
      'b12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      (select fallback_payload from pg_temp.phase_12h_state)
    ) completed
  ),
  (select fallback_clone_id from pg_temp.phase_12h_state),
  'an identical bank completion delivery is idempotent'
);

select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select fallback_job_id from pg_temp.phase_12h_state),
      (select fallback_message_id from pg_temp.phase_12h_state),
      'b12aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      jsonb_set(
        (select fallback_payload from pg_temp.phase_12h_state),
        '{fallback_reason}',
        '"provider_exhausted"'::jsonb
      )
    )
  $$,
  '55000',
  'worksheet_bank_completion_replay_mismatch',
  'a non-identical replay cannot rewrite the terminal fallback evidence'
);
reset role;

select ok(
  exists (
    select 1
    from pg_indexes index_info
    where index_info.schemaname = 'public'
      and index_info.indexname = 'student_practice_assignments_one_active_topic_idx'
      and index_info.indexdef like '%WHERE (status = ANY%'
  )
    and exists (
      select 1
      from pg_trigger trigger_info
      where trigger_info.tgrelid = 'app_private.worksheet_bank_fallback_events'::regclass
        and trigger_info.tgname = 'worksheet_bank_fallback_events_immutable'
        and not trigger_info.tgisinternal
    )
    and exists (
      select 1
      from pg_trigger trigger_info
      where trigger_info.tgrelid = 'public.practice_tests'::regclass
        and trigger_info.tgname = 'practice_tests_prevent_used_mutation'
        and trigger_info.tgenabled = 'O'
        and not trigger_info.tgisinternal
    )
    and exists (
      select 1
      from pg_trigger trigger_info
      where trigger_info.tgrelid = 'app_private.worksheet_generation_rejections'::regclass
        and trigger_info.tgname = 'worksheet_generation_rejections_immutable'
        and not trigger_info.tgisinternal
    ),
  'the one-active-assignment invariant and immutable private fallback quarantine remain enforced'
);

select * from finish(true);

rollback;
