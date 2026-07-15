begin;

-- Shared-staging-safe probe: catalog and immutable normalizer checks only.
-- It never claims a queue message or writes application rows.
select plan(16);

select has_table(
  'app_private',
  'worksheet_answer_completion_provenance',
  'private worksheet-answer completion provenance table exists'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conname =
      'practice_attempt_question_reviews_evaluator_source_check'
      and constraint_row.conrelid =
        'public.practice_attempt_question_reviews'::regclass
      and pg_get_constraintdef(constraint_row.oid) like '%openai%'
  ),
  'truthful OpenAI review source is allowed'
);

select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    join pg_namespace namespace_row
      on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'app_private'
      and relation.relname = 'worksheet_answer_completion_provenance'
  ),
  'private provenance table has row-level security enabled'
);

select ok(
  (
    select count(*) = 2 and bool_and(constraint_row.confdeltype = 'r')
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_answer_completion_provenance'::regclass
      and constraint_row.contype = 'f'
  ),
  'immutable provenance foreign keys use ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.worksheet_answer_completion_provenance'::regclass
      and trigger_row.tgname =
        'worksheet_answer_completion_provenance_immutable'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgfoid =
        'app_private.reject_worksheet_answer_completion_mutation()'::regprocedure
      and trigger_row.tgtype = 27
  ),
  'completion provenance has the BEFORE UPDATE OR DELETE immutable trigger'
);

select ok(
  not has_table_privilege(
    'service_role',
    'app_private.worksheet_answer_completion_provenance',
    'SELECT'
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.worksheet_answer_completion_provenance',
      'SELECT'
    )
    and not has_table_privilege(
      'anon',
      'app_private.worksheet_answer_completion_provenance',
      'SELECT'
    ),
  'completion hashes are not exposed to Data API roles'
);

select ok(
  to_regprocedure(
    'app_private.normalize_worksheet_answer_provenance(jsonb)'
  ) is not null
    and to_regprocedure(
      'app_private.complete_worksheet_answer_with_provenance(uuid,bigint,uuid,jsonb)'
    ) is not null,
  'normalization and replay-safe completion helpers exist'
);

select ok(
  (
    select count(*) = 3
      and bool_and(not routine.prosecdef)
      and bool_and(exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      ))
    from pg_proc routine
    where routine.oid in (
      'app_private.reject_worksheet_answer_completion_mutation()'::regprocedure,
      'app_private.normalize_worksheet_answer_provenance(jsonb)'::regprocedure,
      'api.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure
    )
  ),
  'immutable trigger, normalizer, and API adapter are invoker-safe and path-pinned'
);

select ok(
  not has_function_privilege(
    'service_role',
    'api.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'service_role',
      'app_private.complete_worksheet_answer_with_provenance(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'app_private.complete_worksheet_answer_phase_12r(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.complete_worksheet_answer_phase_12r(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.complete_worksheet_answer_phase_12r(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and exists (
      select 1
      from pg_proc routine
      where routine.oid =
        'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)'::regprocedure
        and not routine.prosecdef
        and position(
          'app_private.complete_worksheet_answer_phase_12r' in routine.prosrc
        ) > 0
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
    )
    and exists (
      select 1
      from pg_proc routine
      where routine.oid =
        'app_private.complete_worksheet_answer_phase_12r(uuid,bigint,uuid,jsonb,jsonb)'::regprocedure
        and routine.prosecdef
        and position('app_private.assert_service_role' in routine.prosrc) > 0
        and position(
          'app_private.complete_worksheet_answer_with_adjudication_v2'
            in routine.prosrc
        ) > 0
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
    ),
  'stale Phase 12I completion is sealed behind the current service-only adjudication boundary'
);

create temporary table phase_12i_probe_payloads (
  name text primary key,
  payload jsonb not null
) on commit drop;

insert into phase_12i_probe_payloads (name, payload)
values (
  'openai',
  jsonb_build_object(
    'schema_version', 1,
    'mode', 'evaluated',
    'evaluator_model', 'gpt-5.4-mini-2026-03-17',
    'reviews', jsonb_build_array(
      jsonb_build_object(
        'question_id', 'd1211111-1111-4111-8111-111111111111',
        'review_status', 'correct',
        'points_awarded', 1,
        'max_points', 1,
        'evaluator_source', 'openai',
        'feedback_text', 'Der Satz ist korrekt.',
        'corrected_answer', null,
        'model_answer', 'Ich helfe dem Mann.',
        'short_reason', 'Das Dativobjekt ist richtig.'
      )
    )
  )
);

insert into phase_12i_probe_payloads (name, payload)
select
  'deepseek',
  jsonb_set(
    jsonb_set(
      payload,
      '{evaluator_model}',
      to_jsonb('deepseek-v4-flash'::text)
    ),
    '{reviews,0,evaluator_source}',
    to_jsonb('deepseek'::text)
  )
from phase_12i_probe_payloads
where name = 'openai';

select ok(
  exists (
    select 1
    from app_private.normalize_worksheet_answer_provenance(
      (select payload from phase_12i_probe_payloads where name = 'openai')
    ) normalized
    where normalized.provider_source = 'openai'
      and normalized.evaluator_model = 'gpt-5.4-mini-2026-03-17'
      and normalized.legacy_result ->> 'evaluator_model' =
        'deepseek-v4-flash'
      and normalized.legacy_result #>> '{reviews,0,evaluator_source}' =
        'deepseek'
  ),
  'OpenAI result is pinned and translated only in the legacy copy'
);

select ok(
  exists (
    select 1
    from app_private.normalize_worksheet_answer_provenance(
      (select payload from phase_12i_probe_payloads where name = 'deepseek')
    ) normalized
    where normalized.provider_source = 'deepseek'
      and normalized.evaluator_model = 'deepseek-v4-flash'
      and normalized.legacy_result =
        (select payload from phase_12i_probe_payloads where name = 'deepseek')
  ),
  'DeepSeek result remains unchanged and pinned'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_answer_provenance(
      jsonb_set(
        (select payload from phase_12i_probe_payloads where name = 'openai'),
        '{evaluator_model}',
        to_jsonb('gpt-5.4-mini'::text)
      )
    )
  $$,
  '22023',
  'Worksheet answer evaluator provenance is invalid.',
  'unpinned OpenAI aliases fail closed'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_answer_provenance(
      (select payload - 'evaluator_model'
       from phase_12i_probe_payloads where name = 'openai')
    )
  $$,
  '22023',
  'Worksheet answer evaluator provenance is invalid.',
  'missing OpenAI evaluator model fails closed'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_answer_provenance(
      jsonb_set(
        (select payload from phase_12i_probe_payloads where name = 'openai'),
        '{evaluator_model}',
        'null'::jsonb
      )
    )
  $$,
  '22023',
  'Worksheet answer evaluator provenance is invalid.',
  'null OpenAI evaluator model fails closed'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_answer_provenance(
      jsonb_set(
        (select payload from phase_12i_probe_payloads where name = 'openai'),
        '{reviews}',
        (select payload -> 'reviews' from phase_12i_probe_payloads where name = 'openai')
          || (select payload -> 'reviews' from phase_12i_probe_payloads where name = 'deepseek')
      )
    )
  $$,
  '22023',
  'Worksheet answer evaluator provenance is invalid.',
  'mixed provider reviews fail closed'
);

select ok(
  pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        (select payload::text from phase_12i_probe_payloads where name = 'openai'),
        'UTF8'
      )
    ),
    'hex'
  ) = pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        (
          select jsonb_build_object(
            'reviews', payload -> 'reviews',
            'evaluator_model', payload -> 'evaluator_model',
            'mode', payload -> 'mode',
            'schema_version', payload -> 'schema_version'
          )::text
          from phase_12i_probe_payloads
          where name = 'openai'
        ),
        'UTF8'
      )
    ),
    'hex'
  ),
  'canonical hash ignores JSON object key order'
);

select * from finish();
rollback;
