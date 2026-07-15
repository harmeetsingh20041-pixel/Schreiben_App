begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(8);

create or replace function pg_temp.phase_13v_packet_payload()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'template_key', 'phase13v.a1.strict-payload',
    'source_file_path', 'quality/worksheet-bank/drafts/a1/phase13v.json',
    'source_sha256', repeat('a', 64),
    'worksheet', jsonb_build_object(
      'title', 'A1 Strict Packet Payload',
      'level', 'A1',
      'grammar_topic', jsonb_build_object(
        'slug', 'articles',
        'name', 'Artikel'
      ),
      'difficulty', 'easy',
      'visibility', 'private',
      'source', 'manual_import',
      'source_label', 'Qualified packet boundary regression fixture',
      'tags', jsonb_build_array('a1', 'articles', 'certified-bank'),
      'mini_lesson', jsonb_build_object(
        'short_explanation', 'Artikel müssen zum Nomen passen.',
        'key_rule', 'Der, die und das markieren das Genus im Nominativ.',
        'correct_examples', jsonb_build_array(
          'Der Tisch ist neu.',
          'Das Buch ist hier.'
        ),
        'common_mistake_warning', 'Lerne jedes Nomen mit seinem Artikel.',
        'what_to_revise', 'Wiederhole der, die und das.'
      ),
      'questions', jsonb_build_array(
        jsonb_build_object(
          'question_number', 1,
          'question_type', 'multiple_choice',
          'prompt', 'Wähle den richtigen Artikel: ___ Tisch ist neu.',
          'options', jsonb_build_array('Der', 'Die', 'Das'),
          'correct_answer', 'Der',
          'accepted_answers', jsonb_build_array('Der'),
          'rubric', null,
          'answer_contract_version', 1,
          'explanation', 'Tisch ist maskulin und braucht der.',
          'evaluation_mode', 'local_exact'
        ),
        jsonb_build_object(
          'question_number', 2,
          'question_type', 'fill_blank',
          'prompt', 'Wortbank [ist, sind, war]: Das Buch ___ hier.',
          'options', jsonb_build_array(),
          'correct_answer', 'ist',
          'accepted_answers', jsonb_build_array('ist'),
          'rubric', null,
          'answer_contract_version', 1,
          'explanation', 'Das Subjekt Buch steht im Singular.',
          'evaluation_mode', 'local_exact'
        )
      )
    )
  );
$$;

select ok(
  to_regprocedure(
    'app_private.worksheet_packet_payload_item_is_strictly_typed(jsonb)'
  ) is not null
    and not has_function_privilege(
      'authenticated',
      'app_private.worksheet_packet_payload_item_is_strictly_typed(jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.worksheet_packet_payload_item_is_strictly_typed(jsonb)',
      'EXECUTE'
    ),
  'the strict packet validator exists only behind the private owner boundary'
);

select ok(
  app_private.worksheet_packet_payload_item_is_strictly_typed(
    pg_temp.phase_13v_packet_payload()
  ),
  'a fully typed release-safe worksheet packet item is accepted'
);

select ok(
  not app_private.worksheet_packet_payload_item_is_strictly_typed(
    jsonb_set(
      pg_temp.phase_13v_packet_payload(),
      '{worksheet,questions,0,answer_contract_version}',
      'null'::jsonb
    )
  ),
  'a JSON-null answer contract version is rejected instead of normalized'
);

select ok(
  not app_private.worksheet_packet_payload_item_is_strictly_typed(
    jsonb_set(
      pg_temp.phase_13v_packet_payload(),
      '{worksheet,questions,0,answer_contract_version}',
      to_jsonb('1'::text)
    )
  ),
  'a string-encoded answer contract version is rejected'
);

select ok(
  not app_private.worksheet_packet_payload_item_is_strictly_typed(
    jsonb_set(
      pg_temp.phase_13v_packet_payload(),
      '{worksheet,questions,0,question_number}',
      to_jsonb('1'::text)
    )
  ),
  'a string-encoded question number is rejected'
);

select ok(
  not app_private.worksheet_packet_payload_item_is_strictly_typed(
    jsonb_set(
      pg_temp.phase_13v_packet_payload(),
      '{worksheet,questions,0,options,0}',
      'null'::jsonb
    )
  ),
  'a JSON-null multiple-choice option is rejected'
);

select ok(
  not app_private.worksheet_packet_payload_item_is_strictly_typed(
    jsonb_set(
      pg_temp.phase_13v_packet_payload(),
      '{worksheet,questions,0,question_type}',
      'null'::jsonb
    )
  ),
  'a JSON-null question type is rejected before a raw not-null error'
);

select ok(
  not app_private.worksheet_packet_payload_item_is_strictly_typed(
    jsonb_set(
      pg_temp.phase_13v_packet_payload(),
      '{worksheet,mini_lesson,key_rule}',
      'null'::jsonb
    )
  ),
  'a JSON-null instructional field is rejected'
);

select * from finish(true);
rollback;
