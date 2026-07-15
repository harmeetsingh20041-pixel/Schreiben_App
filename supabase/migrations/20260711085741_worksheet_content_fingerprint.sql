-- Release-integrity fingerprint for immutable worksheet educational content.
-- The digest is computed from persisted rows, never from mutable review notes.

create or replace function app_private.practice_test_content_sha256(
  target_practice_test_id uuid
)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, public
as $function$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'worksheet', pg_catalog.jsonb_build_object(
            'level', test.level,
            'grammar_topic', pg_catalog.jsonb_build_object(
              'slug', topic.slug,
              'name', topic.name
            ),
            'difficulty', test.difficulty,
            'title', test.title,
            'description', test.description,
            'mini_lesson', test.mini_lesson
          ),
          'questions', coalesce(
            (
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'question_number', question.question_number,
                  'question_type', question.question_type,
                  'evaluation_mode', question.evaluation_mode,
                  'prompt', question.prompt,
                  'options', question.options,
                  'correct_answer', question.correct_answer,
                  'accepted_answers', question.accepted_answers,
                  'rubric', question.rubric,
                  'answer_contract_version', question.answer_contract_version,
                  'explanation', question.explanation
                )
                order by question.question_number
              )
              from public.practice_test_questions as question
              where question.practice_test_id = test.id
            ),
            '[]'::jsonb
          )
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
  from public.practice_tests as test
  join public.grammar_topics as topic
    on topic.id = test.grammar_topic_id
  where test.id = target_practice_test_id;
$function$;

revoke all on function app_private.practice_test_content_sha256(uuid)
from public, anon, authenticated, service_role;

grant execute on function app_private.practice_test_content_sha256(uuid)
to postgres;

comment on function app_private.practice_test_content_sha256(uuid) is
  'Returns only the deterministic SHA-256 digest of persisted worksheet educational content; identifiers, timestamps, provenance, review state, and quality notes are excluded.';
