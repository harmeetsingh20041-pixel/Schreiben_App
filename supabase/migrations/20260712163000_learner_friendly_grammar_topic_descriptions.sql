-- Grammar-topic descriptions are shown to students and are also supplied as
-- curriculum context to worksheet generation. The original closed-contract
-- marker was implementation language, not learner-facing guidance.

do $learner_friendly_topic_descriptions$
declare
  updated_count integer;
begin
  with descriptions(slug, description) as (
    values
    ('articles', 'Practice definite and indefinite articles that match a noun''s gender, number, and case.'),
    ('nominativ', 'Practice subject forms and the articles and pronouns used in the nominative case.'),
    ('akkusativ', 'Practice direct-object forms and the articles and pronouns used in the accusative case.'),
    ('dativ', 'Practice indirect-object forms and the articles and pronouns used in the dative case.'),
    ('genitiv', 'Practice expressing possession and relationships with the genitive case.'),
    ('adjective-endings', 'Practice adjective endings that match the article, case, gender, and number.'),
    ('pronouns', 'Practice choosing clear personal, possessive, demonstrative, and relative pronouns.'),
    ('prepositions', 'Practice selecting German prepositions and the case or meaning each context requires.'),
    ('conjugation', 'Practice changing verb forms to match the subject, tense, and sentence context.'),
    ('subject-verb-agreement', 'Practice making every finite verb agree with its subject in person and number.'),
    ('verb-position', 'Practice placing the finite verb correctly in main clauses, questions, and subordinate clauses.'),
    ('word-order', 'Practice arranging sentence parts in a natural and grammatically correct German order.'),
    ('sentence-structure', 'Practice building complete German clauses and connecting their parts clearly.'),
    ('modal-verbs', 'Practice modal verbs and the infinitive structure that completes their meaning.'),
    ('separable-verbs', 'Practice when separable verb prefixes split from the verb and when they stay attached.'),
    ('reflexive-verbs', 'Practice reflexive verbs with the correct reflexive pronoun and sentence pattern.'),
    ('infinitive-zu', 'Practice infinitive clauses with zu and the word order they require.'),
    ('perfekt', 'Practice talking about completed events with haben or sein and the past participle.'),
    ('praeteritum', 'Practice common simple-past forms and their use in narration and formal writing.'),
    ('plusquamperfekt', 'Practice showing that one past event happened before another past event.'),
    ('future-tense', 'Practice expressing future plans, predictions, and completed future actions.'),
    ('passive-voice', 'Practice focusing on an action or result with German passive constructions.'),
    ('konjunktiv', 'Practice polite requests, hypothetical situations, wishes, and reported speech with the Konjunktiv.'),
    ('subordinate-clauses', 'Practice subordinate conjunctions and placing the finite verb at the end of the clause.'),
    ('relative-clauses', 'Practice adding information with relative pronouns and relative-clause word order.'),
    ('conjunctions', 'Practice joining words and clauses with conjunctions that fit the intended relationship.'),
    ('connectors', 'Practice linking ideas with connectors for cause, contrast, sequence, and result.'),
    ('negation', 'Practice choosing and positioning nicht, kein, and other negative expressions.'),
    ('question-formation', 'Practice yes-or-no questions, W-questions, and indirect questions with correct word order.'),
    ('plural-forms', 'Practice common German plural patterns together with the correct plural article and verb form.'),
    ('capitalization', 'Practice German capitalization, especially nouns and words at the beginning of a sentence.'),
    ('spelling', 'Practice accurate German spelling, including common letter combinations and umlauts.'),
    ('punctuation', 'Practice commas, full stops, quotation marks, and other punctuation that makes meaning clear.'),
    ('coherence', 'Practice organizing sentences so ideas follow logically and references remain clear.'),
    ('register', 'Practice choosing wording and tone that fit formal, informal, professional, and everyday situations.'),
      ('task-fulfilment', 'Practice answering every part of a writing task with the required detail and format.')
  )
  update public.grammar_topics topic
  set description = descriptions.description
  from descriptions
  where topic.slug = descriptions.slug;

  get diagnostics updated_count = row_count;
  if updated_count <> 36 then
    raise exception using
      errcode = '55000',
      message = 'learner_friendly_topic_description_count_invalid';
  end if;
end;
$learner_friendly_topic_descriptions$;

comment on column public.grammar_topics.description is
  'Learner-facing curriculum summary. It must not contain internal persistence, validation, provider, or prompt instructions.';
