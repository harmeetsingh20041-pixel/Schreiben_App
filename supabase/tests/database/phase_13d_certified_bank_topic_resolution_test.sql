begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(12);

create or replace function pg_temp.phase_13d_require_passing_tap(result text)
returns text
language plpgsql
as $$
begin
  if result !~ '^ok [0-9]+' then
    raise exception using
      errcode = 'P0001',
      message = 'phase_13d_tap_assertion_failed',
      detail = result;
  end if;
  return result;
end;
$$;

create temporary table phase_13d_draft_topic_pairs (
  ordinal integer primary key,
  worksheet_level text not null,
  topic_slug text not null,
  display_name text not null
) on commit drop;

insert into phase_13d_draft_topic_pairs (
  ordinal,
  worksheet_level,
  topic_slug,
  display_name
)
values
  (1, 'A1', 'adjective-endings', 'Adjektivendungen'),
  (2, 'A1', 'akkusativ', 'Akkusativ'),
  (3, 'A1', 'akkusativ', 'Akkusativ'),
  (4, 'A1', 'articles', 'Articles'),
  (5, 'A1', 'articles', 'Articles'),
  (6, 'A1', 'capitalization', 'Großschreibung'),
  (7, 'A1', 'coherence', 'Textzusammenhang'),
  (8, 'A1', 'conjugation', 'Konjugation'),
  (9, 'A1', 'conjugation', 'Konjugation'),
  (10, 'A1', 'conjunctions', 'Konjunktionen'),
  (11, 'A1', 'connectors', 'Konnektoren'),
  (12, 'A1', 'dativ', 'Dativ'),
  (13, 'A1', 'future-tense', 'Futur'),
  (14, 'A1', 'genitiv', 'Genitiv'),
  (15, 'A1', 'infinitive-zu', 'Infinitiv mit zu'),
  (16, 'A1', 'konjunktiv', 'Konjunktiv in höflichen Wendungen'),
  (17, 'A1', 'modal-verbs', 'Modalverben'),
  (18, 'A1', 'modal-verbs', 'Modalverben'),
  (19, 'A1', 'negation', 'Verneinung'),
  (20, 'A1', 'negation', 'Verneinung'),
  (21, 'A1', 'nominativ', 'Nominativ'),
  (22, 'A1', 'nominativ', 'Nominativ'),
  (23, 'A1', 'passive-voice', 'Passiv'),
  (24, 'A1', 'perfekt', 'Perfekt'),
  (25, 'A1', 'plural-forms', 'Pluralformen'),
  (26, 'A1', 'plusquamperfekt', 'Plusquamperfekt'),
  (27, 'A1', 'praeteritum', 'Präteritum'),
  (28, 'A1', 'prepositions', 'Präpositionen'),
  (29, 'A1', 'prepositions', 'Präpositionen'),
  (30, 'A1', 'pronouns', 'Pronomen'),
  (31, 'A1', 'punctuation', 'Zeichensetzung'),
  (32, 'A1', 'question-formation', 'Fragebildung'),
  (33, 'A1', 'question-formation', 'Fragebildung'),
  (34, 'A1', 'reflexive-verbs', 'Reflexive Verben'),
  (35, 'A1', 'register', 'Formell und informell'),
  (36, 'A1', 'relative-clauses', 'Einfache Relativsätze'),
  (37, 'A1', 'sentence-structure', 'Satzbau'),
  (38, 'A1', 'separable-verbs', 'Trennbare Verben'),
  (39, 'A1', 'spelling', 'Rechtschreibung'),
  (40, 'A1', 'subject-verb-agreement', 'Subjekt-Verb-Kongruenz'),
  (41, 'A1', 'subject-verb-agreement', 'Subjekt-Verb-Kongruenz'),
  (42, 'A1', 'subordinate-clauses', 'Einfache Nebensätze'),
  (43, 'A1', 'task-fulfilment', 'Aufgabenerfüllung'),
  (44, 'A1', 'verb-position', 'Verbposition'),
  (45, 'A1', 'verb-position', 'Verbposition'),
  (46, 'A1', 'word-order', 'Wortstellung'),
  (47, 'A2', 'adjective-endings', 'Adjective endings'),
  (48, 'A2', 'adjective-endings', 'Adjective endings'),
  (49, 'A2', 'akkusativ', 'Akkusativ'),
  (50, 'A2', 'articles', 'Artikel'),
  (51, 'A2', 'capitalization', 'Groß- und Kleinschreibung'),
  (52, 'A2', 'coherence', 'Textzusammenhang'),
  (53, 'A2', 'conjugation', 'Konjugation'),
  (54, 'A2', 'conjunctions', 'Conjunctions'),
  (55, 'A2', 'conjunctions', 'Conjunctions'),
  (56, 'A2', 'connectors', 'Konnektoren'),
  (57, 'A2', 'dativ', 'Dativ'),
  (58, 'A2', 'dativ', 'Dativ'),
  (59, 'A2', 'future-tense', 'Futur I'),
  (60, 'A2', 'genitiv', 'Genitiv'),
  (61, 'A2', 'infinitive-zu', 'Infinitiv mit zu'),
  (62, 'A2', 'konjunktiv', 'Konjunktiv II'),
  (63, 'A2', 'modal-verbs', 'Modalverben'),
  (64, 'A2', 'negation', 'Negation'),
  (65, 'A2', 'nominativ', 'Nominativ'),
  (66, 'A2', 'passive-voice', 'Passiv'),
  (67, 'A2', 'perfekt', 'Perfekt'),
  (68, 'A2', 'perfekt', 'Perfekt'),
  (69, 'A2', 'plural-forms', 'Plural forms'),
  (70, 'A2', 'plural-forms', 'Plural forms'),
  (71, 'A2', 'plusquamperfekt', 'Plusquamperfekt'),
  (72, 'A2', 'praeteritum', 'Präteritum'),
  (73, 'A2', 'prepositions', 'Prepositions'),
  (74, 'A2', 'prepositions', 'Prepositions'),
  (75, 'A2', 'pronouns', 'Pronouns'),
  (76, 'A2', 'pronouns', 'Pronouns'),
  (77, 'A2', 'punctuation', 'Zeichensetzung'),
  (78, 'A2', 'question-formation', 'Fragebildung'),
  (79, 'A2', 'reflexive-verbs', 'Reflexive verbs'),
  (80, 'A2', 'reflexive-verbs', 'Reflexive verbs'),
  (81, 'A2', 'register', 'Register'),
  (82, 'A2', 'relative-clauses', 'Relativsätze'),
  (83, 'A2', 'sentence-structure', 'Satzstruktur'),
  (84, 'A2', 'separable-verbs', 'Separable verbs'),
  (85, 'A2', 'separable-verbs', 'Separable verbs'),
  (86, 'A2', 'spelling', 'Rechtschreibung'),
  (87, 'A2', 'subject-verb-agreement', 'Subjekt-Verb-Kongruenz'),
  (88, 'A2', 'subordinate-clauses', 'Nebensätze'),
  (89, 'A2', 'task-fulfilment', 'Aufgabenerfüllung'),
  (90, 'A2', 'verb-position', 'Verbposition'),
  (91, 'A2', 'word-order', 'Word order'),
  (92, 'A2', 'word-order', 'Word order'),
  (93, 'B1', 'adjective-endings', 'Adjektivendungen'),
  (94, 'B1', 'adjective-endings', 'Adjektivendungen'),
  (95, 'B1', 'akkusativ', 'Akkusativ'),
  (96, 'B1', 'articles', 'Artikel'),
  (97, 'B1', 'capitalization', 'Groß- und Kleinschreibung'),
  (98, 'B1', 'coherence', 'Textzusammenhang'),
  (99, 'B1', 'conjugation', 'Konjugation'),
  (100, 'B1', 'conjunctions', 'Konjunktionen'),
  (101, 'B1', 'connectors', 'Konnektoren'),
  (102, 'B1', 'connectors', 'Konnektoren'),
  (103, 'B1', 'dativ', 'Dativ'),
  (104, 'B1', 'future-tense', 'Futur I'),
  (105, 'B1', 'future-tense', 'Futur I'),
  (106, 'B1', 'genitiv', 'Genitiv'),
  (107, 'B1', 'genitiv', 'Genitiv'),
  (108, 'B1', 'infinitive-zu', 'Infinitiv mit zu'),
  (109, 'B1', 'infinitive-zu', 'Infinitiv mit zu'),
  (110, 'B1', 'konjunktiv', 'Konjunktiv II'),
  (111, 'B1', 'modal-verbs', 'Modalverben'),
  (112, 'B1', 'negation', 'Negation'),
  (113, 'B1', 'nominativ', 'Nominativ'),
  (114, 'B1', 'passive-voice', 'Passiv'),
  (115, 'B1', 'passive-voice', 'Passiv'),
  (116, 'B1', 'perfekt', 'Perfekt'),
  (117, 'B1', 'plural-forms', 'Pluralformen'),
  (118, 'B1', 'plusquamperfekt', 'Plusquamperfekt'),
  (119, 'B1', 'plusquamperfekt', 'Plusquamperfekt'),
  (120, 'B1', 'praeteritum', 'Präteritum'),
  (121, 'B1', 'praeteritum', 'Präteritum'),
  (122, 'B1', 'prepositions', 'Präpositionen'),
  (123, 'B1', 'pronouns', 'Pronomen'),
  (124, 'B1', 'punctuation', 'Zeichensetzung'),
  (125, 'B1', 'question-formation', 'Fragebildung'),
  (126, 'B1', 'reflexive-verbs', 'Reflexive Verben'),
  (127, 'B1', 'register', 'Sprachregister'),
  (128, 'B1', 'relative-clauses', 'Relativsätze'),
  (129, 'B1', 'relative-clauses', 'Relativsätze'),
  (130, 'B1', 'sentence-structure', 'Satzbau'),
  (131, 'B1', 'separable-verbs', 'Trennbare Verben'),
  (132, 'B1', 'spelling', 'Rechtschreibung'),
  (133, 'B1', 'subject-verb-agreement', 'Subjekt-Verb-Kongruenz'),
  (134, 'B1', 'subordinate-clauses', 'Nebensätze'),
  (135, 'B1', 'subordinate-clauses', 'Nebensätze'),
  (136, 'B1', 'task-fulfilment', 'Aufgabenerfüllung'),
  (137, 'B1', 'verb-position', 'Verbposition'),
  (138, 'B1', 'word-order', 'Wortstellung'),
  (139, 'B2', 'adjective-endings', 'Adjektivendungen'),
  (140, 'B2', 'akkusativ', 'Akkusativ'),
  (141, 'B2', 'articles', 'Artikelgebrauch'),
  (142, 'B2', 'capitalization', 'Groß- und Kleinschreibung'),
  (143, 'B2', 'coherence', 'Kohärenz'),
  (144, 'B2', 'coherence', 'Kohärenz'),
  (145, 'B2', 'conjugation', 'Konjugation'),
  (146, 'B2', 'conjunctions', 'Konjunktionen'),
  (147, 'B2', 'connectors', 'Konnektoren'),
  (148, 'B2', 'connectors', 'Konnektoren'),
  (149, 'B2', 'dativ', 'Dativ'),
  (150, 'B2', 'future-tense', 'Zukunftsformen'),
  (151, 'B2', 'genitiv', 'Genitiv'),
  (152, 'B2', 'infinitive-zu', 'Infinitiv mit zu'),
  (153, 'B2', 'konjunktiv', 'Konjunktiv'),
  (154, 'B2', 'konjunktiv', 'Konjunktiv'),
  (155, 'B2', 'modal-verbs', 'Modalverben'),
  (156, 'B2', 'negation', 'Negation'),
  (157, 'B2', 'nominativ', 'Nominativ'),
  (158, 'B2', 'passive-voice', 'Passiv'),
  (159, 'B2', 'passive-voice', 'Passiv'),
  (160, 'B2', 'perfekt', 'Perfekt'),
  (161, 'B2', 'plural-forms', 'Pluralformen'),
  (162, 'B2', 'plusquamperfekt', 'Plusquamperfekt'),
  (163, 'B2', 'praeteritum', 'Präteritum'),
  (164, 'B2', 'prepositions', 'Präpositionen'),
  (165, 'B2', 'pronouns', 'Pronomen'),
  (166, 'B2', 'punctuation', 'Zeichensetzung'),
  (167, 'B2', 'punctuation', 'Zeichensetzung'),
  (168, 'B2', 'question-formation', 'Fragebildung'),
  (169, 'B2', 'reflexive-verbs', 'Reflexive Verben'),
  (170, 'B2', 'register', 'Register'),
  (171, 'B2', 'register', 'Register'),
  (172, 'B2', 'relative-clauses', 'Relativsätze'),
  (173, 'B2', 'relative-clauses', 'Relativsätze'),
  (174, 'B2', 'sentence-structure', 'Satzstruktur'),
  (175, 'B2', 'separable-verbs', 'Trennbare Verben'),
  (176, 'B2', 'spelling', 'Rechtschreibung'),
  (177, 'B2', 'subject-verb-agreement', 'Subjekt-Verb-Kongruenz'),
  (178, 'B2', 'subordinate-clauses', 'Nebensätze'),
  (179, 'B2', 'subordinate-clauses', 'Nebensätze'),
  (180, 'B2', 'task-fulfilment', 'Aufgabenerfüllung'),
  (181, 'B2', 'task-fulfilment', 'Aufgabenerfüllung'),
  (182, 'B2', 'verb-position', 'Verbstellung'),
  (183, 'B2', 'word-order', 'Wortstellung'),
  (184, 'B2', 'word-order', 'Wortstellung');

select pg_temp.phase_13d_require_passing_tap(ok(
  to_regprocedure(
    'app_private.resolve_worksheet_bank_topic_id(text,text,text)'
  ) is not null
    and not has_function_privilege(
      'anon',
      'app_private.resolve_worksheet_bank_topic_id(text,text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.resolve_worksheet_bank_topic_id(text,text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.resolve_worksheet_bank_topic_id(text,text,text)',
      'EXECUTE'
    ),
  'the closed worksheet-bank resolver exists and remains Postgres-only'
));

select pg_temp.phase_13d_require_passing_tap(is(
  (select count(*) from phase_13d_draft_topic_pairs),
  184::bigint,
  'the regression contains every current A1-B2 draft slug/name pair'
));

select pg_temp.phase_13d_require_passing_tap(results_eq(
  $$
    select fixture.worksheet_level, count(*)::bigint
    from phase_13d_draft_topic_pairs fixture
    group by fixture.worksheet_level
    order by fixture.worksheet_level
  $$,
  $$
    values
      ('A1'::text, 46::bigint),
      ('A2'::text, 46::bigint),
      ('B1'::text, 46::bigint),
      ('B2'::text, 46::bigint)
  $$,
  'the 184-pair snapshot covers 46 drafts at each CEFR level'
));

select pg_temp.phase_13d_require_passing_tap(ok(
  (select count(distinct fixture.topic_slug)
   from phase_13d_draft_topic_pairs fixture) = 36
    and not exists (
      select 1
      from phase_13d_draft_topic_pairs fixture
      left join app_private.grammar_topic_contracts contract
        on contract.slug = fixture.topic_slug
      where contract.slug is null
    ),
  'the draft snapshot uses exactly the 36-topic closed canonical slug set'
));

select pg_temp.phase_13d_require_passing_tap(is(
  (
    select count(*)
    from phase_13d_draft_topic_pairs fixture
    join public.grammar_topics topic
      on topic.id = app_private.resolve_worksheet_bank_topic_id(
        fixture.topic_slug,
        fixture.display_name,
        fixture.worksheet_level
      )
    where lower(topic.name) <> lower(fixture.display_name)
  ),
  123::bigint,
  'the fixture exercises all 123 localized display-name cases rather than only canonical English names'
));

select pg_temp.phase_13d_require_passing_tap(is(
  (
    select count(*)
    from phase_13d_draft_topic_pairs fixture
    join public.grammar_topics topic
      on topic.id = app_private.resolve_worksheet_bank_topic_id(
        fixture.topic_slug,
        fixture.display_name,
        fixture.worksheet_level
      )
    where topic.slug = fixture.topic_slug
      and topic.level in (fixture.worksheet_level, 'A1_A2')
  ),
  184::bigint,
  'all 184 canonical slugs resolve their closed topic regardless of localized display name'
));

select pg_temp.phase_13d_require_passing_tap(is(
  app_private.resolve_worksheet_bank_topic_id(
    'invented-topic',
    'Articles',
    'A1'
  ),
  null::uuid,
  'an unknown supplied slug cannot fall back to a matching known display name'
));

select pg_temp.phase_13d_require_passing_tap(ok(
  app_private.resolve_worksheet_bank_topic_id(
    null,
    'Articles',
    'A1'
  ) is not null,
  'legacy name-only payloads retain exact closed-topic resolution'
));

create or replace function pg_temp.phase_13d_payload(
  topic_slug text,
  topic_name text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'title', 'Phase 13D localized topic publication',
    'description', 'Transaction-only canonical topic-resolution regression.',
    'level', 'A1',
    'grammar_topic', jsonb_build_object(
      'slug', topic_slug,
      'name', topic_name
    ),
    'difficulty', 'easy',
    'visibility', 'private',
    'source', 'manual_import',
    'source_label', 'Phase 13D pgTAP fixture',
    'tags', jsonb_build_array('topic-resolution', 'a1', topic_slug),
    'mini_lesson', jsonb_build_object(
      'short_explanation', 'German nouns use an article.',
      'key_rule', 'Choose the article that matches the noun.',
      'correct_examples', jsonb_build_array('Das ist der Dienstplan.'),
      'common_mistake_warning', 'Do not guess the article from English.',
      'what_to_revise', 'Review common article and noun pairs.'
    ),
    'questions', jsonb_build_array(
      jsonb_build_object(
        'question_number', 1,
        'question_type', 'multiple_choice',
        'prompt', 'Wähle den richtigen Artikel: ___ Dienstplan ist neu.',
        'options', jsonb_build_array('Der', 'Die', 'Das'),
        'correct_answer', 'Der',
        'accepted_answers', jsonb_build_array('Der'),
        'rubric', null,
        'answer_contract_version', 1,
        'explanation', 'Dienstplan is masculine, so the article is der.',
        'evaluation_mode', 'local_exact'
      ),
      jsonb_build_object(
        'question_number', 2,
        'question_type', 'multiple_choice',
        'prompt', 'Wähle den richtigen Artikel: ___ Übergabe beginnt.',
        'options', jsonb_build_array('Der', 'Die', 'Das'),
        'correct_answer', 'Die',
        'accepted_answers', jsonb_build_array('Die'),
        'rubric', null,
        'answer_contract_version', 1,
        'explanation', 'Übergabe is feminine, so the article is die.',
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
    '236a3731-8499-4d2b-b87b-0ce4b41d46d8',
    'authenticated',
    'authenticated',
    'phase13d-certifier@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13D Certifier"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '6bcc0333-356d-47d2-975a-5191145f3dae',
    'authenticated',
    'authenticated',
    'phase13d-releaser@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13D Releaser"}'::jsonb,
    now(),
    now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    '236a3731-8499-4d2b-b87b-0ce4b41d46d8',
    'Phase 13D Certifier',
    'phase13d-certifier@example.test',
    'student'
  ),
  (
    '6bcc0333-356d-47d2-975a-5191145f3dae',
    'Phase 13D Releaser',
    'phase13d-releaser@example.test',
    'student'
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email;

insert into app_private.practice_worksheet_bank_reviewers (
  user_id,
  qualification,
  can_certify,
  can_release,
  verified_by
)
values
  (
    '236a3731-8499-4d2b-b87b-0ce4b41d46d8',
    'Qualified German-language worksheet reviewer',
    true,
    false,
    '236a3731-8499-4d2b-b87b-0ce4b41d46d8'
  ),
  (
    '6bcc0333-356d-47d2-975a-5191145f3dae',
    'Qualified educational release controller',
    false,
    true,
    '236a3731-8499-4d2b-b87b-0ce4b41d46d8'
  );

create temporary table phase_13d_fixture as
select
  pg_temp.phase_13d_payload(
    'articles',
    'Artikelgebrauch'
  ) as worksheet,
  '{
    "structural_valid":true,
    "ambiguity_free":true,
    "no_answer_leakage":true,
    "level_fit":true,
    "topic_fit":true,
    "type_balance":true,
    "scoring_safe":true
  }'::jsonb as checklist;

create temporary table phase_13d_published as
select *
from app_private.publish_certified_worksheet_template(
  'phase13d.a1.articles.localized',
  (select worksheet from phase_13d_fixture),
  '236a3731-8499-4d2b-b87b-0ce4b41d46d8',
  '6bcc0333-356d-47d2-975a-5191145f3dae',
  (select checklist from phase_13d_fixture),
  'Qualified localized-name transaction review.',
  'Qualified localized-name transaction release.'
);

select pg_temp.phase_13d_require_passing_tap(ok(
  exists (
    select 1
    from phase_13d_published published
    join app_private.practice_worksheet_templates template
      on template.id = published.template_id
    join public.grammar_topics topic
      on topic.id = template.grammar_topic_id
    where topic.slug = 'articles'
      and topic.level in ('A1', 'A1_A2')
      and published.created
  ),
  'the real atomic publisher accepts a localized display name and persists the canonical slug topic'
));

select pg_temp.phase_13d_require_passing_tap(ok(
  exists (
    select 1
    from phase_13d_published published
    join app_private.practice_worksheet_template_revisions revision
      on revision.id = published.revision_id
    where revision.import_payload_sha256 = pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          (select worksheet from phase_13d_fixture)::text,
          'UTF8'
        )
      ),
      'hex'
    )
  ),
  'topic resolution preserves the exact localized source payload audit hash'
));

select pg_temp.phase_13d_require_passing_tap(throws_ok(
  $$
    select *
    from app_private.publish_certified_worksheet_template(
      'phase13d.a1.unknown',
      pg_temp.phase_13d_payload('invented-topic', 'Articles'),
      '236a3731-8499-4d2b-b87b-0ce4b41d46d8',
      '6bcc0333-356d-47d2-975a-5191145f3dae',
      '{
        "structural_valid":true,
        "ambiguity_free":true,
        "no_answer_leakage":true,
        "level_fit":true,
        "topic_fit":true,
        "type_balance":true,
        "scoring_safe":true
      }'::jsonb,
      'Qualified unknown-topic transaction review.',
      'Qualified unknown-topic transaction release.'
    )
  $$,
  'P0002',
  'worksheet_bank_topic_not_found',
  'the real atomic publisher rejects an unknown slug even when its display name is known'
));

select pg_temp.phase_13d_require_passing_tap(ok(
  pg_get_functiondef(
    'app_private.publish_certified_worksheet_template(text,jsonb,uuid,uuid,jsonb,text,text)'::regprocedure
  ) like '%resolve_worksheet_bank_topic_id%',
  'the production publisher delegates topic selection to the closed canonical resolver'
));

select * from finish();
rollback;
