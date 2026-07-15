begin;

select plan(35);

select ok(
  (
    select
      array_position(ordered.names, 'feedback_drafts_01_prepare_issue_span_topics')
        < array_position(ordered.names, 'feedback_drafts_validate_content')
      and array_position(ordered.names, 'feedback_drafts_validate_content')
        < array_position(ordered.names, 'feedback_drafts_y_finalize_issue_span_topics')
      and array_position(ordered.names, 'feedback_drafts_y_finalize_issue_span_topics')
        < array_position(ordered.names, 'feedback_drafts_zz_independent_release_gate')
    from (
      select array_agg(trigger.tgname::text order by trigger.tgname) as names
      from pg_trigger trigger
      where trigger.tgrelid = 'app_private.feedback_drafts'::regclass
        and not trigger.tgisinternal
    ) ordered
  ),
  'v2 span normalization and summary derivation surround exact validation and precede the release hash gate'
);

select ok(
  not has_function_privilege(
    'anon',
    'app_private.prepare_writing_issue_span_topics()',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.prepare_writing_issue_span_topics()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.prepare_writing_issue_span_topics()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.finalize_writing_issue_span_topics()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.finalize_writing_issue_span_topics()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.finalize_writing_issue_span_topics()',
      'EXECUTE'
    ),
  'span normalization internals are not callable through browser or worker roles'
);

create temporary table phase_13u_feedback_harness (
  id integer generated always as identity primary key,
  state text not null default 'draft',
  content jsonb not null
);

create trigger phase_13u_a_prepare
before insert or update of content on phase_13u_feedback_harness
for each row execute function app_private.prepare_writing_issue_span_topics();

create trigger phase_13u_y_finalize
before insert or update of content on phase_13u_feedback_harness
for each row execute function app_private.finalize_writing_issue_span_topics();

insert into phase_13u_feedback_harness (content)
values (jsonb_build_object(
  'feedback_contract_version', 2,
  'overall_summary', 'Three distinct errors in one sentence.',
  'level_detected', 'A2',
  'corrected_text', 'Ich gebe dem Kind morgen das Buch.',
  'lines', jsonb_build_array(jsonb_build_object(
    'line_number', 1,
    'source_start', 0,
    'source_end', 34,
    'original_line', 'Ich gebe der Kind das Buch morgen.',
    'corrected_line', 'Ich gebe dem Kind morgen das Buch.',
    'status', 'major_issue',
    'changed_parts', jsonb_build_array(
      jsonb_build_object(
        'from', 'der',
        'to', 'dem',
        'reason', 'Article and case must agree.',
        'grammar_topics', jsonb_build_array('Articles', 'Dative', 'dativ'),
        'severity', 'major',
        'source_start', 9,
        'source_end', 12,
        'corrected_start', 9,
        'corrected_end', 12
      ),
      jsonb_build_object(
        'from', '',
        'to', 'morgen ',
        'reason', 'Put the time phrase before the object here.',
        'grammar_topics', jsonb_build_array('sentence-order'),
        'severity', 'minor',
        'source_start', 18,
        'source_end', 18,
        'corrected_start', 18,
        'corrected_end', 25
      ),
      jsonb_build_object(
        'from', ' morgen',
        'to', '',
        'reason', 'Remove the old time-phrase position.',
        'grammar_topics', jsonb_build_array('word-order'),
        'severity', 'minor',
        'source_start', 26,
        'source_end', 33,
        'corrected_start', 27,
        'corrected_end', 27
      )
    ),
    'short_explanation', 'Use the correct article and sentence order.',
    'detailed_explanation', '',
    'grammar_topic', 'Dative'
  )),
  'grammar_topics', '[]'::jsonb,
  'score_summary', '{}'::jsonb
));

select is(
  (select content -> 'grammar_topics' from phase_13u_feedback_harness where id = 1),
  '[
    {"topic":"articles","count":1,"minor_count":0,"major_count":1,"severity":"major","simple_explanation":"Article and case must agree."},
    {"topic":"dativ","count":1,"minor_count":0,"major_count":1,"severity":"major","simple_explanation":"Article and case must agree."},
    {"topic":"word-order","count":2,"minor_count":2,"major_count":0,"severity":"minor","simple_explanation":"Put the time phrase before the object here."}
  ]'::jsonb,
  'one sentence derives article case and word-order summaries from three issue spans'
);

select is(
  (select content #>> '{lines,0,grammar_topic}' from phase_13u_feedback_harness where id = 1),
  'articles',
  'the line-level topic is only the deterministic first-topic compatibility projection'
);

select is(
  (select content #> '{lines,0,changed_parts,0,grammar_topics}' from phase_13u_feedback_harness where id = 1),
  '["articles","dativ"]'::jsonb,
  'aliases within one span canonicalize and deduplicate without double-counting'
);

select is(
  (
    select (content #> '{lines,0,changed_parts,0}')
      - array['grammar_topics', 'severity', 'reason', 'from', 'to']
    from phase_13u_feedback_harness
    where id = 1
  ),
  '{"source_start":9,"source_end":12,"corrected_start":9,"corrected_end":12}'::jsonb,
  'normalization preserves the exact original and corrected Unicode offsets'
);

select is(
  (select content -> 'score_summary' from phase_13u_feedback_harness where id = 1),
  '{"correct_lines":0,"acceptable_lines":0,"minor_issues":0,"major_issues":1,"needs_review":0}'::jsonb,
  'sentence-level display scoring stays sentence-based while weaknesses are span-based'
);

insert into phase_13u_feedback_harness (content)
values (jsonb_build_object(
  'feedback_contract_version', 2,
  'lines', jsonb_build_array(jsonb_build_object(
    'status', 'minor_issue',
    'grammar_topic', '',
    'changed_parts', jsonb_build_array(
      jsonb_build_object('from', '', 'to', 'an ', 'reason', 'First.', 'grammar_topics', jsonb_build_array('Preposition'), 'severity', 'minor'),
      jsonb_build_object('from', '', 'to', 'auf ', 'reason', 'Second.', 'grammar_topics', jsonb_build_array('Präpositionen'), 'severity', 'minor'),
      jsonb_build_object('from', '', 'to', 'mit ', 'reason', 'Third.', 'grammar_topics', jsonb_build_array('prepositions'), 'severity', 'minor')
    )
  ))
));

select is(
  (select content #> '{grammar_topics,0}' from phase_13u_feedback_harness where id = 2),
  '{"topic":"prepositions","count":3,"minor_count":3,"major_count":0,"severity":"minor","simple_explanation":"First."}'::jsonb,
  'three separate same-topic spans count as three weakness occurrences'
);

insert into phase_13u_feedback_harness (content)
values ('{
  "feedback_contract_version":2,
  "lines":[{"status":"correct","grammar_topic":"","changed_parts":[]}]
}'::jsonb);

select is(
  (select content -> 'grammar_topics' from phase_13u_feedback_harness where id = 3),
  '[]'::jsonb,
  'positive lines cannot create weakness topics'
);

insert into phase_13u_feedback_harness (content)
values ('{
  "lines":[{"status":"minor_issue","grammar_topic":"prepositions","changed_parts":[]}],
  "grammar_topics":[{"topic":"prepositions","count":1,"severity":"minor"}],
  "score_summary":{"legacy":true}
}'::jsonb);

select is(
  (select content -> 'score_summary' from phase_13u_feedback_harness where id = 4),
  '{"legacy":true}'::jsonb,
  'legacy v1 drafts remain byte-semantically untouched by the v2 summary trigger'
);

select throws_ok(
  $$
    insert into phase_13u_feedback_harness (content)
    values ('{
      "feedback_contract_version":2,
      "lines":[{"status":"minor_issue","changed_parts":[{
        "from":"x","to":"y","reason":"Unknown.",
        "grammar_topics":["not-a-real-topic"],"severity":"minor"
      }]}]
    }'::jsonb)
  $$,
  '22023',
  'writing_feedback_v2_span_topic_unmapped',
  'an unmapped issue span fails closed before persistence'
);

select throws_ok(
  $$
    insert into phase_13u_feedback_harness (content)
    values ('{
      "feedback_contract_version":2,
      "lines":[{"status":"correct","grammar_topic":"articles","changed_parts":[]}]
    }'::jsonb)
  $$,
  '22023',
  'writing_feedback_v2_positive_topic_forbidden',
  'positive lines reject compatibility topics instead of creating evidence'
);

select throws_ok(
  $$
    insert into phase_13u_feedback_harness (content)
    values ('{
      "feedback_contract_version":2,
      "lines":[{"status":"minor_issue","changed_parts":[{
        "from":"x","to":"y","reason":"Major correction.",
        "grammar_topics":["articles"],"severity":"major"
      }]}]
    }'::jsonb)
  $$,
  '22023',
  'writing_feedback_v2_line_severity_contradiction',
  'line status cannot contradict the severities of its issue spans'
);

select throws_ok(
  $$
    update phase_13u_feedback_harness
    set content = content - 'feedback_contract_version'
    where id = 1
  $$,
  '22023',
  'writing_feedback_contract_downgrade_forbidden',
  'a persisted v2 draft cannot be downgraded to the lossy legacy contract'
);

select throws_ok(
  $$
    insert into phase_13u_feedback_harness (content)
    values (jsonb_build_object(
      'feedback_contract_version', 2,
      'lines', jsonb_build_array(jsonb_build_object(
        'status', 'minor_issue',
        'changed_parts', jsonb_build_array(jsonb_build_object(
          'from', 'x',
          'to', 'y',
          'reason', repeat('🙂', 4001),
          'grammar_topics', jsonb_build_array('articles'),
          'severity', 'minor'
        ))
      ))
    ))
  $$,
  '22023',
  'writing_feedback_v2_span_metadata_invalid',
  'a correction reason longer than 4,000 Unicode characters fails closed'
);

select throws_ok(
  $$
    insert into phase_13u_feedback_harness (content)
    values ('{
      "feedback_contract_version":2,
      "lines":[{"status":"minor_issue","changed_parts":[{
        "from":"x","to":"y","reason":"Too many topics.",
        "grammar_topics":[
          "articles","nominativ","akkusativ","dativ","genitiv",
          "prepositions","word-order"
        ],
        "severity":"minor"
      }]}]
    }'::jsonb)
  $$,
  '22023',
  'writing_feedback_v2_span_metadata_invalid',
  'a correction span cannot persist more than six grammar topics'
);

-- Real-table regression fixture. Keep this after the temporary unit harness:
-- every insert/update below traverses the complete feedback_drafts trigger
-- chain, exact-text validator, independent release gate, materializer, and
-- released-practice evidence trigger inside this rollback-only transaction.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '13a11111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase13u-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13U Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '13a22222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase13u-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13U Student"}'::jsonb, now(), now()
  );

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  revision,
  disabled_at,
  note
)
values (
  '13a11111-1111-4111-8111-111111111111'::uuid,
  true,
  1,
  1,
  null,
  'Phase 13U rollback-only teacher entitlement.'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  '13a33333-3333-4333-8333-333333333333',
  'Phase 13U Workspace',
  'phase-13u-writing-span-workspace',
  '13a11111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '13a11111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '13a33333-3333-4333-8333-333333333333',
  '13a11111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '13a33333-3333-4333-8333-333333333333',
  '13a22222-2222-4222-8222-222222222222',
  'student'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id, workspace_id, name, level, created_by, is_active,
  join_code_enabled, join_requires_approval, feedback_mode,
  feedback_delay_min_minutes, feedback_delay_max_minutes
)
values
  (
    '13a66666-6666-4666-8666-666666666666',
    '13a33333-3333-4333-8333-333333333333',
    'Phase 13U Immediate A2', 'A2',
    '13a11111-1111-4111-8111-111111111111', true, true, true,
    'immediate', 0, 0
  ),
  (
    '13a77777-7777-4777-8777-777777777777',
    '13a33333-3333-4333-8333-333333333333',
    'Phase 13U Scheduled A2', 'A2',
    '13a11111-1111-4111-8111-111111111111', true, true, true,
    'automatic_delayed', 1, 1
  ),
  (
    '13a88888-8888-4888-8888-888888888888',
    '13a33333-3333-4333-8333-333333333333',
    'Phase 13U Teacher A2', 'A2',
    '13a11111-1111-4111-8111-111111111111', true, true, true,
    'teacher_review_only', 0, 0
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    '13a33333-3333-4333-8333-333333333333',
    '13a66666-6666-4666-8666-666666666666',
    '13a22222-2222-4222-8222-222222222222'
  ),
  (
    '13a33333-3333-4333-8333-333333333333',
    '13a77777-7777-4777-8777-777777777777',
    '13a22222-2222-4222-8222-222222222222'
  ),
  (
    '13a33333-3333-4333-8333-333333333333',
    '13a88888-8888-4888-8888-888888888888',
    '13a22222-2222-4222-8222-222222222222'
  );

insert into public.submissions (
  id, workspace_id, student_id, batch_id, question_source, mode,
  original_text, status, feedback_mode, evaluation_status,
  release_status, release_at, feedback_scheduled_at
)
values
  (
    '13a44444-4444-4444-8444-444444444444',
    '13a33333-3333-4333-8333-333333333333',
    '13a22222-2222-4222-8222-222222222222',
    '13a66666-6666-4666-8666-666666666666',
    'free_text', 'free_text',
    E'🙂 Ich gebe der Kind das Buch.\u00a0\u00a0Ich gebe der Kind das Buch.',
    'checked', 'immediate', 'ready', 'held', null, null
  ),
  (
    '13b44444-4444-4444-8444-444444444444',
    '13a33333-3333-4333-8333-333333333333',
    '13a22222-2222-4222-8222-222222222222',
    '13a77777-7777-4777-8777-777777777777',
    'free_text', 'free_text',
    E'🙂 Ich gebe der Kind das Buch.\u00a0\u00a0Ich gebe der Kind das Buch.',
    'checked', 'automatic_delayed', 'ready', 'scheduled',
    '2000-01-01 00:00:00+00'::timestamptz,
    '2000-01-01 00:00:00+00'::timestamptz
  ),
  (
    '13c44444-4444-4444-8444-444444444444',
    '13a33333-3333-4333-8333-333333333333',
    '13a22222-2222-4222-8222-222222222222',
    '13a88888-8888-4888-8888-888888888888',
    'free_text', 'free_text', 'Ich gehe Schule.',
    'needs_review', 'teacher_review_only', 'needs_review', 'held', null, null
  ),
  (
    '13d44444-4444-4444-8444-444444444444',
    '13a33333-3333-4333-8333-333333333333',
    '13a22222-2222-4222-8222-222222222222',
    '13a88888-8888-4888-8888-888888888888',
    'free_text', 'free_text', 'Ich gehe Schule.',
    'needs_review', 'teacher_review_only', 'needs_review', 'held', null, null
  );

with context_source as (
  select *
  from (values
    (
      '13a44444-4444-4444-8444-444444444444'::uuid,
      '13a66666-6666-4666-8666-666666666666'::uuid,
      E'🙂 Ich gebe der Kind das Buch.\u00a0\u00a0Ich gebe der Kind das Buch.'
    ),
    (
      '13b44444-4444-4444-8444-444444444444'::uuid,
      '13a77777-7777-4777-8777-777777777777'::uuid,
      E'🙂 Ich gebe der Kind das Buch.\u00a0\u00a0Ich gebe der Kind das Buch.'
    ),
    (
      '13c44444-4444-4444-8444-444444444444'::uuid,
      '13a88888-8888-4888-8888-888888888888'::uuid,
      'Ich gehe Schule.'::text
    )
  ) fixture(submission_id, batch_id, original_text)
), hashed_context as (
  select
    fixture.*,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(fixture.original_text, 'UTF8')),
      'hex'
    ) as original_text_sha256
  from context_source fixture
)
insert into app_private.writing_evaluation_contexts (
  submission_id, context_version, workspace_id, student_id, batch_id,
  cefr_level, source_type, source_id, submission_mode, question_metadata,
  original_text_sha256, context_sha256
)
select
  context.submission_id,
  1,
  '13a33333-3333-4333-8333-333333333333',
  '13a22222-2222-4222-8222-222222222222',
  context.batch_id,
  'A2',
  'free_text',
  null,
  'free_text',
  '{}'::jsonb,
  context.original_text_sha256,
  app_private.writing_evaluation_context_sha256(
    context.submission_id,
    1::smallint,
    '13a33333-3333-4333-8333-333333333333',
    '13a22222-2222-4222-8222-222222222222',
    context.batch_id,
    'A2',
    'free_text',
    null,
    'free_text',
    '{}'::jsonb,
    context.original_text_sha256
  )
from hashed_context context;

with raw_feedback as (
  select jsonb_build_object(
    'feedback_contract_version', 2,
    'overall_summary',
      'Repeated dative corrections around an astral symbol and NBSP separator.',
    'level_detected', 'A2',
    'corrected_text',
      E'🙂 Ich gebe dem Kind das Buch.\u00a0\u00a0Ich gebe dem Kind das Buch.',
    'ai_model', 'deepseek-v4-flash',
    'score_summary', '{"untrusted":true}'::jsonb,
    'grammar_topics', '[]'::jsonb,
    'lines', jsonb_build_array(
      jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 29,
        'original_line', '🙂 Ich gebe der Kind das Buch.',
        'corrected_line', '🙂 Ich gebe dem Kind das Buch.',
        'status', 'major_issue',
        'changed_parts', jsonb_build_array(jsonb_build_object(
          'from', 'der',
          'to', 'dem',
          'reason', 'Use dative after this verb.',
          'grammar_topics', jsonb_build_array('Dative', 'Articles', 'dativ'),
          'severity', 'major',
          'source_start', 11,
          'source_end', 14,
          'corrected_start', 11,
          'corrected_end', 14
        )),
        'short_explanation', 'Use the correct dative article.',
        'detailed_explanation', '',
        'grammar_topic', 'Dative'
      ),
      jsonb_build_object(
        'line_number', 2,
        'source_start', 31,
        'source_end', 58,
        'original_line', 'Ich gebe der Kind das Buch.',
        'corrected_line', 'Ich gebe dem Kind das Buch.',
        'status', 'minor_issue',
        'changed_parts', jsonb_build_array(jsonb_build_object(
          'from', 'der',
          'to', 'dem',
          'reason', 'Repeat the dative article correction.',
          'grammar_topics', jsonb_build_array('dativ'),
          'severity', 'minor',
          'source_start', 40,
          'source_end', 43,
          'corrected_start', 9,
          'corrected_end', 12
        )),
        'short_explanation', 'Repeat the dative correction.',
        'detailed_explanation', '',
        'grammar_topic', 'Dative'
      )
    )
  ) as content
), targets as (
  select *
  from (values
    (
      '13a55555-5555-4555-8555-555555555555'::uuid,
      '13a44444-4444-4444-8444-444444444444'::uuid
    ),
    (
      '13b55555-5555-4555-8555-555555555555'::uuid,
      '13b44444-4444-4444-8444-444444444444'::uuid
    )
  ) fixture(draft_id, submission_id)
)
insert into app_private.feedback_drafts (
  id, submission_id, version, state, provider_model, content
)
select
  target.draft_id,
  target.submission_id,
  1,
  'draft',
  'deepseek-v4-flash',
  raw_feedback.content
from targets target
cross join raw_feedback;

select is(
  (
    select app_private.canonical_jsonb_sha256(draft.content)
    from app_private.feedback_drafts draft
    where draft.id = '13a55555-5555-4555-8555-555555555555'
  ),
  '14fd08a61590d730ab92da287b5e5ac8d0561d075d3866608a1f439bb85805c7',
  'the real trigger chain produces the fixed Edge-compatible v2 hash'
);

select ok(
  exists (
    select 1
    from app_private.feedback_drafts draft
    where draft.id = '13a55555-5555-4555-8555-555555555555'
      and draft.content ->> 'corrected_text' =
        E'🙂 Ich gebe dem Kind das Buch.\u00a0\u00a0Ich gebe dem Kind das Buch.'
      and draft.content #>> '{lines,0,changed_parts,0,from}' = 'der'
      and draft.content #>> '{lines,1,changed_parts,0,from}' = 'der'
      and (draft.content #>> '{lines,0,source_end}')::integer = 29
      and (draft.content #>> '{lines,1,source_start}')::integer = 31
      and draft.content #> '{lines,0,changed_parts,0,grammar_topics}' =
        '["articles","dativ"]'::jsonb
  ),
  'astral offsets, the NBSP separator, and both repeated spans survive normalization exactly'
);

insert into app_private.async_jobs (
  id, queue_name, job_kind, entity_id, entity_version,
  idempotency_key, status, completed_at
)
values
  (
    '13a99999-9999-4999-8999-999999999999',
    'writing_evaluation', 'writing_evaluation',
    '13a44444-4444-4444-8444-444444444444', 1,
    'phase13u:immediate:v1', 'succeeded', now()
  ),
  (
    '13b99999-9999-4999-8999-999999999999',
    'writing_evaluation', 'writing_evaluation',
    '13b44444-4444-4444-8444-444444444444', 1,
    'phase13u:scheduled:v1', 'succeeded', now()
  );

insert into app_private.writing_feedback_adjudications_v2 (
  job_id, submission_id, evaluation_version, feedback_version,
  schema_version, decision, reason_code, context_sha256,
  original_text_sha256, final_feedback_sha256, generator_provider,
  generator_model, candidate_feedback_sha256, candidate_release_sha256,
  critic_provider, critic_model, critic_verdict, critic_decision_sha256,
  accepted_provider, accepted_model
)
select
  fixture.job_id,
  fixture.submission_id,
  1,
  1,
  2,
  'accepted_model_feedback',
  'critic_approved',
  context.context_sha256,
  context.original_text_sha256,
  app_private.canonical_jsonb_sha256(draft.content),
  'deepseek',
  'deepseek-v4-flash',
  repeat('a', 64),
  app_private.canonical_jsonb_sha256(draft.content),
  'gemini',
  'gemini-3.1-flash-lite',
  'approved',
  repeat('b', 64),
  'deepseek',
  'deepseek-v4-flash'
from (values
  (
    '13a99999-9999-4999-8999-999999999999'::uuid,
    '13a44444-4444-4444-8444-444444444444'::uuid,
    '13a55555-5555-4555-8555-555555555555'::uuid
  ),
  (
    '13b99999-9999-4999-8999-999999999999'::uuid,
    '13b44444-4444-4444-8444-444444444444'::uuid,
    '13b55555-5555-4555-8555-555555555555'::uuid
  )
) fixture(job_id, submission_id, draft_id)
join app_private.feedback_drafts draft on draft.id = fixture.draft_id
join app_private.writing_evaluation_contexts context
  on context.submission_id = fixture.submission_id;

select lives_ok(
  $$
    select app_private.materialize_feedback_draft(
      '13a44444-4444-4444-8444-444444444444',
      '13a55555-5555-4555-8555-555555555555',
      null
    )
  $$,
  'independently evidenced immediate feedback auto-releases through the real materializer'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    join app_private.feedback_drafts draft
      on draft.submission_id = submission.id
    where submission.id = '13a44444-4444-4444-8444-444444444444'
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'released'
      and submission.corrected_text =
        E'🙂 Ich gebe dem Kind das Buch.\u00a0\u00a0Ich gebe dem Kind das Buch.'
      and draft.state = 'released'
      and draft.released_by is null
  ),
  'the immediate automatic release is complete and preserves the exact corrected writing'
);

select is(
  (
    select jsonb_object_agg(
      grammar_topic.slug,
      jsonb_build_object(
        'minor', evidence.minor_issue_count,
        'major', evidence.major_issue_count
      )
    )
    from app_private.practice_weakness_evidence evidence
    join public.grammar_topics grammar_topic
      on grammar_topic.id = evidence.grammar_topic_id
    where evidence.feedback_draft_id =
      '13a55555-5555-4555-8555-555555555555'
  ),
  '{
    "articles":{"minor":0,"major":1},
    "dativ":{"minor":1,"major":1}
  }'::jsonb,
  'immediate adaptive evidence keeps exact per-span minor and major counts'
);

select is(
  app_private.release_due_feedback_internal(1),
  1,
  'the due scheduled recovery path auto-releases one evidenced v2 draft'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    join app_private.feedback_drafts draft
      on draft.submission_id = submission.id
    where submission.id = '13b44444-4444-4444-8444-444444444444'
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'released'
      and submission.release_at = '2000-01-01 00:00:00+00'::timestamptz
      and draft.state = 'released'
      and draft.released_by is null
  ),
  'the scheduled automatic release reaches a complete student-visible state'
);

select is(
  (
    select jsonb_object_agg(
      grammar_topic.slug,
      jsonb_build_object(
        'minor', evidence.minor_issue_count,
        'major', evidence.major_issue_count
      )
    )
    from app_private.practice_weakness_evidence evidence
    join public.grammar_topics grammar_topic
      on grammar_topic.id = evidence.grammar_topic_id
    where evidence.feedback_draft_id =
      '13b55555-5555-4555-8555-555555555555'
  ),
  '{
    "articles":{"minor":0,"major":1},
    "dativ":{"minor":1,"major":1}
  }'::jsonb,
  'scheduled adaptive evidence keeps exact per-span minor and major counts'
);

insert into app_private.feedback_drafts (
  id, submission_id, version, state, provider_model, content
)
values (
  '13c55555-5555-4555-8555-555555555555',
  '13c44444-4444-4444-8444-444444444444',
  1,
  'needs_review',
  'deepseek-v4-flash',
  jsonb_build_object(
    'overall_summary', 'A teacher should review this legacy feedback.',
    'level_detected', 'A2',
    'corrected_text', 'Ich gehe zur Schule.',
    'ai_model', 'deepseek-v4-flash',
    'score_summary', '{}'::jsonb,
    'grammar_topics', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 16,
      'original_line', 'Ich gehe Schule.',
      'corrected_line', 'Ich gehe zur Schule.',
      'status', 'minor_issue',
      'changed_parts', jsonb_build_array(jsonb_build_object(
        'from', '',
        'to', 'zur ',
        'reason', 'Provider destination explanation.',
        'source_start', 9,
        'source_end', 9,
        'corrected_start', 9,
        'corrected_end', 13
      )),
      'short_explanation', 'Use zur before Schule.',
      'detailed_explanation', '',
      'grammar_topic', 'Preposition'
    ))
  )
);

insert into app_private.feedback_drafts (
  id, submission_id, version, state, provider_model, content
)
values (
  '13d55555-5555-4555-8555-555555555555',
  '13d44444-4444-4444-8444-444444444444',
  1,
  'draft',
  'deepseek-v4-flash',
  jsonb_build_object(
    'feedback_contract_version', 2,
    'overall_summary', 'Teacher working-copy regression.',
    'level_detected', 'A2',
    'corrected_text', 'Ich gehe zur Schule.',
    'ai_model', 'deepseek-v4-flash',
    'score_summary', '{}'::jsonb,
    'grammar_topics', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 16,
      'original_line', 'Ich gehe Schule.',
      'corrected_line', 'Ich gehe zur Schule.',
      'status', 'minor_issue',
      'changed_parts', jsonb_build_array(jsonb_build_object(
        'from', '',
        'to', 'zur ',
        'reason', 'Complete initial reason.',
        'grammar_topics', jsonb_build_array('prepositions'),
        'severity', 'minor',
        'source_start', 9,
        'source_end', 9,
        'corrected_start', 9,
        'corrected_end', 13
      )),
      'short_explanation', 'Use zur before Schule.',
      'detailed_explanation', '',
      'grammar_topic', 'prepositions'
    ))
  )
);

select ok(
  not (
    select draft.content ? 'feedback_contract_version'
    from app_private.feedback_drafts draft
    where draft.id = '13c55555-5555-4555-8555-555555555555'
  ),
  'a real legacy draft remains v1 until an authorized teacher edits it'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '13a11111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '13a11111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $$
    select api.update_feedback_draft(
      '13c55555-5555-4555-8555-555555555555',
      jsonb_build_object(
        'feedback_contract_version', 2,
        'overall_summary', 'Teacher-approved destination correction.',
        'level_detected', 'A2',
        'corrected_text', 'Ich gehe zur Schule.',
        'ai_model', 'deepseek-v4-flash',
        'score_summary', '{}'::jsonb,
        'grammar_topics', '[]'::jsonb,
        'lines', jsonb_build_array(jsonb_build_object(
          'line_number', 1,
          'source_start', 0,
          'source_end', 16,
          'original_line', 'Ich gehe Schule.',
          'corrected_line', 'Ich gehe zur Schule.',
          'status', 'minor_issue',
          'changed_parts', jsonb_build_array(jsonb_build_object(
            'from', '',
            'to', 'zur ',
            'reason', 'Teacher-approved destination preposition.',
            'grammar_topics', jsonb_build_array('Preposition'),
            'severity', 'minor',
            'source_start', 9,
            'source_end', 9,
            'corrected_start', 9,
            'corrected_end', 13
          )),
          'short_explanation', 'Use zur before Schule.',
          'detailed_explanation', '',
          'grammar_topic', 'Preposition'
        ))
      ),
      1
    )
  $$,
  'an authorized teacher upgrades a real v1 draft through the revision-safe RPC'
);

select lives_ok(
  $$
    select api.update_feedback_draft(
      '13d55555-5555-4555-8555-555555555555',
      jsonb_build_object(
        'feedback_contract_version', 2,
        'overall_summary', 'Teacher working-copy regression.',
        'level_detected', 'A2',
        'corrected_text', 'Ich gehe zur Schule.',
        'ai_model', 'deepseek-v4-flash',
        'score_summary', '{}'::jsonb,
        'grammar_topics', '[]'::jsonb,
        'lines', jsonb_build_array(jsonb_build_object(
          'line_number', 1,
          'source_start', 0,
          'source_end', 16,
          'original_line', 'Ich gehe Schule.',
          'corrected_line', 'Ich gehe zur Schule.',
          'status', 'minor_issue',
          'changed_parts', jsonb_build_array(jsonb_build_object(
            'from', '',
            'to', 'zur ',
            'reason', '',
            'grammar_topics', '[]'::jsonb,
            'severity', null,
            'source_start', 9,
            'source_end', 9,
            'corrected_start', 9,
            'corrected_end', 13
          )),
          'short_explanation', 'Use zur before Schule.',
          'detailed_explanation', '',
          'grammar_topic', ''
        ))
      ),
      1
    )
  $$,
  'an authorized teacher can save unfinished span metadata as a private working copy'
);

reset role;

select ok(
  exists (
    select 1
    from app_private.feedback_drafts draft
    where draft.id = '13c55555-5555-4555-8555-555555555555'
      and draft.revision = 2
      and draft.state = 'draft'
      and draft.content ->> 'feedback_contract_version' = '2'
      and draft.content #>> '{lines,0,changed_parts,0,reason}' =
        'Teacher-approved destination preposition.'
      and draft.content #>> '{grammar_topics,0,simple_explanation}' =
        'Teacher-approved destination preposition.'
  ),
  'the teacher-edited exact-span reason becomes the authoritative persisted topic explanation'
);

select ok(
  exists (
    select 1
    from app_private.feedback_drafts draft
    join public.submissions submission on submission.id = draft.submission_id
    where draft.id = '13d55555-5555-4555-8555-555555555555'
      and draft.revision = 2
      and draft.state = 'needs_review'
      and submission.status = 'needs_review'
      and submission.evaluation_status = 'needs_review'
      and submission.release_status = 'held'
      and draft.content #>> '{lines,0,changed_parts,0,reason}' = ''
      and draft.content #> '{lines,0,changed_parts,0,grammar_topics}' = '[]'::jsonb
      and draft.content #> '{lines,0,changed_parts,0,severity}' = 'null'::jsonb
  ),
  'unfinished metadata stays private and keeps the submission in the teacher review queue'
);

select throws_ok(
  $$
    update app_private.feedback_drafts
    set state = 'draft'
    where id = '13d55555-5555-4555-8555-555555555555'
  $$,
  '55000',
  'writing_feedback_incomplete_private_draft',
  'an incomplete private working copy cannot be promoted by a state-only update'
);

set local role authenticated;

select throws_ok(
  $$
    select api.release_feedback(
      '13d44444-4444-4444-8444-444444444444',
      '13d55555-5555-4555-8555-555555555555'
    )
  $$,
  '55000',
  'Feedback must be fully reviewed before release.',
  'the release RPC rejects incomplete private working copies'
);

select lives_ok(
  $$
    select api.release_feedback(
      '13c44444-4444-4444-8444-444444444444',
      '13c55555-5555-4555-8555-555555555555'
    )
  $$,
  'the authenticated teacher releases the upgraded v2 draft atomically'
);

reset role;

select ok(
  exists (
    select 1
    from app_private.feedback_drafts draft
    join public.submissions submission on submission.id = draft.submission_id
    join public.submission_lines line on line.submission_id = submission.id
    where draft.id = '13c55555-5555-4555-8555-555555555555'
      and draft.state = 'released'
      and draft.released_by = '13a11111-1111-4111-8111-111111111111'
      and submission.release_status = 'released'
      and line.changed_parts #>> '{0,reason}' =
        'Teacher-approved destination preposition.'
  ),
  'teacher release materializes the edited reason for students and records the human approver'
);

select ok(
  position(
    'release_status = ''released''' in pg_get_viewdef('api.submission_lines'::regclass, true)
  ) > 0
    and position(
      'release_status = ''released''' in pg_get_viewdef('api.submission_grammar_topics'::regclass, true)
    ) > 0,
  'student feedback lines and derived topic summaries remain release-gated'
);

select ok(
  position(
    'minor_count' in pg_get_functiondef(
      'app_private.capture_released_practice_evidence()'::regprocedure
    )
  ) > 0
    and position(
      'major_count' in pg_get_functiondef(
        'app_private.capture_released_practice_evidence()'::regprocedure
      )
    ) > 0
    and position(
      'writing_evaluation_context_sha256' in pg_get_functiondef(
        'app_private.capture_released_practice_evidence()'::regprocedure
      )
    ) > 0,
  'released v2 evidence keeps exact minor-major counts and immutable writing context checks'
);

select * from finish(true);

rollback;
