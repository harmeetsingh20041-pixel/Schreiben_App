insert into public.grammar_topics (slug, name, level, description)
values
  ('articles', 'Articles', 'A1_A2', 'German nouns use der, die, das and article forms change by case.'),
  ('dativ', 'Dativ', 'A1_A2', 'Dativ marks indirect objects and follows common prepositions such as mit, nach, bei, von, zu.'),
  ('akkusativ', 'Akkusativ', 'A1_A2', 'Akkusativ marks direct objects and follows common prepositions such as fuer, durch, gegen, ohne, um.'),
  ('verb-position', 'Verb position', 'A1_A2', 'Main clauses place the conjugated verb in position 2; subordinate clauses often move it to the end.'),
  ('perfekt', 'Perfekt', 'A1_A2', 'Perfekt uses haben or sein plus a past participle to describe completed actions.'),
  ('prepositions', 'Prepositions', 'A1_A2', 'German prepositions determine case and connect sentence parts.'),
  ('word-order', 'Word order', 'A1_A2', 'German sentence order should stay simple and level-appropriate for A1/A2 learners.'),
  ('conjugation', 'Conjugation', 'A1_A2', 'Verb endings change by subject, tense, and irregular verb patterns.'),
  ('spelling', 'Spelling', 'A1_A2', 'Spelling issues include missing letters, capitalization, umlauts, and common typos.'),
  ('sentence-structure', 'Sentence structure', 'A1_A2', 'Sentence structure covers missing words, unclear meaning, and malformed clauses.')
on conflict (slug, level) do update
set
  name = excluded.name,
  description = excluded.description;
