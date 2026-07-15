begin;

select plan(5);

create temporary table expected_phase_13k_topics (slug text primary key) on commit drop;
insert into expected_phase_13k_topics (slug)
values
  ('adjective-endings'), ('akkusativ'), ('articles'), ('capitalization'),
  ('coherence'), ('conjugation'), ('conjunctions'), ('connectors'), ('dativ'),
  ('future-tense'), ('genitiv'), ('infinitive-zu'), ('konjunktiv'),
  ('modal-verbs'), ('negation'), ('nominativ'), ('passive-voice'), ('perfekt'),
  ('plural-forms'), ('plusquamperfekt'), ('praeteritum'), ('prepositions'),
  ('pronouns'), ('punctuation'), ('question-formation'), ('reflexive-verbs'),
  ('register'), ('relative-clauses'), ('sentence-structure'),
  ('separable-verbs'), ('spelling'), ('subject-verb-agreement'),
  ('subordinate-clauses'), ('task-fulfilment'), ('verb-position'), ('word-order');

select is(
  (
    select count(*)::integer
    from expected_phase_13k_topics expected
    join public.grammar_topics topic using (slug)
    where nullif(btrim(topic.description), '') is not null
  ),
  36,
  'all closed A1-B2 topics have learner-facing curriculum descriptions'
);

select is(
  (
    select count(distinct topic.description)::integer
    from expected_phase_13k_topics expected
    join public.grammar_topics topic using (slug)
  ),
  36,
  'each closed topic has a distinct explanation of the skill being practised'
);

select ok(
  not exists (
    select 1
    from expected_phase_13k_topics expected
    join public.grammar_topics topic using (slug)
    where topic.description ~* '(closed contract|persist|deterministic|provider|prompt|internal)'
  ),
  'student-visible topic descriptions contain no implementation language'
);

select ok(
  not exists (
    select 1
    from expected_phase_13k_topics expected
    join public.grammar_topics topic using (slug)
    where length(topic.description) not between 45 and 180
  ),
  'topic guidance remains concise enough for student practice cards'
);

select results_eq(
  $$
    select topic.slug, topic.description
    from public.grammar_topics topic
    where topic.slug in ('articles', 'konjunktiv', 'word-order')
    order by topic.slug
  $$,
  $$
    values
      (
        'articles'::text,
        'Practice definite and indefinite articles that match a noun''s gender, number, and case.'::text
      ),
      (
        'konjunktiv'::text,
        'Practice polite requests, hypothetical situations, wishes, and reported speech with the Konjunktiv.'::text
      ),
      (
        'word-order'::text,
        'Practice arranging sentence parts in a natural and grammatically correct German order.'::text
      )
  $$,
  'representative learner descriptions retain their exact reviewed wording'
);

select * from finish(true);
rollback;
