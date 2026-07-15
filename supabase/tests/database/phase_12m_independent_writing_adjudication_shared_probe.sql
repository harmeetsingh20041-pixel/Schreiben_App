begin;

-- Shared-staging-safe and read-only: catalog/function-definition assertions
-- only. It never claims a queue message or reads student/provider content.
select plan(15);

select has_table(
  'app_private',
  'writing_feedback_adjudications',
  'private independent-writing provenance ledger exists'
);

select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'app_private'
      and relation.relname = 'writing_feedback_adjudications'
  ),
  'provenance ledger has row-level security enabled'
);

select ok(
  (
    select count(*) = 2 and bool_and(constraint_row.confdeltype = 'r')
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.writing_feedback_adjudications'::regclass
      and constraint_row.contype = 'f'
  ),
  'both provenance foreign keys use ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.writing_feedback_adjudications'::regclass
      and trigger_row.tgname = 'writing_feedback_adjudications_immutable'
      and not trigger_row.tgisinternal
      and trigger_row.tgfoid =
        'app_private.reject_writing_adjudication_mutation()'::regprocedure
      and trigger_row.tgtype = 27
  ),
  'provenance has the exact immutable BEFORE UPDATE OR DELETE trigger'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'app_private.feedback_drafts'::regclass
      and trigger_row.tgname = 'feedback_drafts_zz_independent_release_gate'
      and not trigger_row.tgisinternal
      and trigger_row.tgfoid =
        'app_private.require_independent_writing_release()'::regprocedure
      and trigger_row.tgtype = 23
  ),
  'feedback drafts have the exact automatic-release evidence gate'
);

select ok(
  not has_table_privilege(
    'service_role',
    'app_private.writing_feedback_adjudications',
    'SELECT'
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.writing_feedback_adjudications',
      'SELECT'
    )
    and not has_table_privilege(
      'anon',
      'app_private.writing_feedback_adjudications',
      'SELECT'
    ),
  'no Data API role can read the private evidence ledger'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'app_private'
      and column_row.table_name = 'writing_feedback_adjudications'
      and (
        column_row.data_type in ('json', 'jsonb')
        or column_row.column_name ~ '(original_text|student_text|prompt|response|feedback_content)$'
      )
  ),
  'the ledger has no raw writing, prompt, response, or feedback-body column'
);

select ok(
  to_regprocedure('app_private.canonical_jsonb_text(jsonb)') is not null
    and to_regprocedure('app_private.canonical_jsonb_sha256(jsonb)') is not null
    and to_regprocedure(
      'app_private.record_or_assert_writing_adjudication(uuid,bigint,uuid,jsonb)'
    ) is not null
    and to_regprocedure('api.get_writing_adjudication_context(uuid)') is not null,
  'canonical hashing, replay guard, and service hash loader exist'
);

select ok(
  (
    select count(*) = 5
      and bool_and(not routine.prosecdef)
      and bool_and(exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      ))
    from pg_proc routine
    where routine.oid in (
      'app_private.canonical_jsonb_text(jsonb)'::regprocedure,
      'app_private.canonical_jsonb_sha256(jsonb)'::regprocedure,
      'app_private.reject_writing_adjudication_mutation()'::regprocedure,
      'api.get_writing_adjudication_context(uuid)'::regprocedure,
      'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure
    )
  ),
  'hashing, immutable trigger, and loader are invoker-safe and path-pinned'
);

select ok(
  (
    select count(*) = 4
      and bool_and(routine.prosecdef)
      and bool_and(exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      ))
    from pg_proc routine
    where routine.oid in (
      'app_private.record_or_assert_writing_adjudication(uuid,bigint,uuid,jsonb)'::regprocedure,
      'app_private.require_independent_writing_release()'::regprocedure,
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure,
      'public.complete_writing_evaluation_legacy_internal(uuid,bigint,uuid,jsonb)'::regprocedure
    )
  ),
  'the four completion/release boundaries are definer-safe and path-pinned'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'api.get_writing_adjudication_context(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_writing_adjudication_context(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.complete_writing_evaluation_legacy_internal(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    ),
  'API and stale public signatures are gated while the legacy body is closed'
);

select is(
  app_private.canonical_jsonb_sha256('{"b":2,"a":1}'::jsonb),
  '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
  'database canonical JSON hashing matches the Edge contract'
);

select is(
  app_private.canonical_jsonb_sha256(jsonb_build_object(
    'overall_summary', E'Grüße – korrekt.\nZweite Zeile',
    'level_detected', 'A2',
    'corrected_text', E'Das ist richtig.\n\nHeute übe ich.',
    'ai_model', 'deepseek-v4-flash',
    'lines', jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'source_start', 0,
      'source_end', 16,
      'original_line', 'Das ist richtig.',
      'corrected_line', 'Das ist richtig.',
      'status', 'correct',
      'changed_parts', '[]'::jsonb,
      'short_explanation', '',
      'detailed_explanation', '',
      'grammar_topic', ''
    )),
    'grammar_topics', '[]'::jsonb
  )),
  '0bd696d3dd38e0dc816e827ca4bf4f3de1d19420600aa16da1d4948a94dba1ed',
  'representative Unicode and newline feedback hashes match Edge'
);

select ok(
  position(
    'record_or_assert_writing_adjudication' in pg_get_functiondef(
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure
    )
  ) < position(
    'complete_writing_evaluation_legacy_internal' in pg_get_functiondef(
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure
    )
  )
    and pg_get_functiondef(
      'public.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure
    ) like '%feedback - ''evaluation_evidence''%',
  'stale-compatible completion records evidence before legacy materialization'
);

select ok(
  pg_get_function_result(
    'api.get_writing_adjudication_context(uuid)'::regprocedure
  ) like '%context_version%'
    and pg_get_function_result(
      'api.get_writing_adjudication_context(uuid)'::regprocedure
    ) like '%context_sha256%'
    and pg_get_function_result(
      'api.get_writing_adjudication_context(uuid)'::regprocedure
    ) like '%original_text_sha256%'
    and pg_get_function_result(
      'api.get_writing_adjudication_context(uuid)'::regprocedure
    ) not like '%original_text text%',
  'the supplemental loader returns hashes and never raw writing'
);

select * from finish();
rollback;
