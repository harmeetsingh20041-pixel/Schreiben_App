begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

select ok(
  to_regprocedure(
    'app_private.practice_answer_review_status_any(text,text,jsonb,boolean,uuid)'
  ) is not null
    and to_regprocedure(
      'app_private.practice_answer_review_status_with_policy(text,text,boolean,boolean)'
    ) is not null,
  'topic-aware punctuation scoring helpers exist'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.practice_answer_review_status_any(text,text,jsonb,boolean,uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'app_private.practice_answer_review_status_with_policy(text,text,boolean,boolean)',
      'EXECUTE'
    ),
  'punctuation scoring helpers are not browser-callable'
);

select ok(
  app_private.is_practice_topic_punctuation_scoring(
    'Zeichensetzung',
    'punctuation'
  ),
  'the canonical punctuation topic uses strict punctuation scoring'
);

select is(
  app_private.practice_answer_review_status_with_policy(
    'Kommst du morgen.',
    'Kommst du morgen?',
    false,
    false
  ),
  'minor_punctuation'::text,
  'ordinary non-punctuation practice preserves punctuation-only full credit'
);

select is(
  app_private.practice_review_status_points('minor_punctuation'),
  1.00::numeric,
  'ordinary minor-punctuation credit remains unchanged'
);

select is(
  app_private.practice_answer_review_status_with_policy(
    'pflege',
    'Pflege',
    false,
    false
  ),
  'capitalization_issue'::text,
  'ordinary capitalization partial credit remains unchanged'
);

select is(
  app_private.practice_review_status_points('capitalization_issue'),
  0.50::numeric,
  'ordinary capitalization points remain unchanged'
);

select is(
  app_private.practice_answer_review_status_with_policy(
    'Pflege.',
    'Pflege?',
    true,
    false
  ),
  'minor_punctuation'::text,
  'case-strict non-punctuation topics preserve their historical punctuation tolerance'
);

select is(
  app_private.practice_answer_review_status_any(
    '.',
    '?',
    '["?"]'::jsonb,
    false,
    (select topic.id from public.grammar_topics topic where topic.slug = 'punctuation')
  ),
  'incorrect'::text,
  'literal period cannot satisfy a literal question-mark answer'
);

select is(
  app_private.practice_answer_review_status_any(
    '!',
    '?',
    '["?"]'::jsonb,
    false,
    (select topic.id from public.grammar_topics topic where topic.slug = 'punctuation')
  ),
  'incorrect'::text,
  'literal exclamation mark cannot satisfy a literal question-mark answer'
);

select is(
  app_private.practice_answer_review_status_any(
    'Kommst du morgen.',
    'Kommst du morgen?',
    '["Kommst du morgen?"]'::jsonb,
    false,
    (select topic.id from public.grammar_topics topic where topic.slug = 'punctuation')
  ),
  'incorrect'::text,
  'a full-sentence period cannot satisfy the question-mark version'
);

select is(
  app_private.practice_review_status_points(
    app_private.practice_answer_review_status_any(
      'Kommst du morgen.',
      'Kommst du morgen?',
      '["Kommst du morgen?"]'::jsonb,
      false,
      (select topic.id from public.grammar_topics topic where topic.slug = 'punctuation')
    )
  ),
  0.00::numeric,
  'wrong punctuation receives zero rather than full credit'
);

select is(
  app_private.practice_answer_review_status_any(
    'Kommst du morgen?',
    'Kommst du morgen?',
    '["Kommst du morgen?"]'::jsonb,
    false,
    (select topic.id from public.grammar_topics topic where topic.slug = 'punctuation')
  ),
  'correct'::text,
  'the exact punctuation-bearing answer still receives full credit'
);

select * from finish(true);
rollback;
