-- Shared-staging-safe Phase 12N catalog and hash probe. Its application
-- queries are read-only; pgTAP itself needs temporary transaction-local
-- tables, and the final rollback retains no schema, jobs, or worksheet data.
begin;

select plan(14);

select ok(
  to_regprocedure('app_private.canonical_jsonb_text(jsonb)') is not null
    and to_regprocedure(
      'app_private.worksheet_candidate_sha256(jsonb)'
    ) is not null
    and to_regprocedure(
      'app_private.worksheet_critic_verdict_sha256(jsonb)'
    ) is not null
    and to_regprocedure(
      'app_private.assert_dual_worksheet_critics(jsonb)'
    ) is not null,
  'Phase 12N canonical hash and dual-validator functions exist'
);

select ok(
  exists (
    select 1
    from pg_proc routine
    where routine.oid =
      'app_private.assert_dual_worksheet_critics(jsonb)'::regprocedure
      and routine.provolatile = 'i'
      and not routine.prosecdef
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting = any (array['search_path=', 'search_path=""'])
      )
  ),
  'dual validation is immutable, invoker-safe, and path-pinned'
);

select ok(
  has_function_privilege(
    'service_role',
    'app_private.assert_dual_worksheet_critics(jsonb)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.assert_dual_worksheet_critics(jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.assert_dual_worksheet_critics(jsonb)',
      'EXECUTE'
    ),
  'browser roles cannot invoke the private dual-critic validator'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    ),
  'shared staging exposes no direct legacy completion bypass'
);

select ok(
  exists (
    select 1
    from pg_proc routine
    where routine.oid =
      'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)'::regprocedure
      and not routine.prosecdef
      and position(
        'app_private.complete_worksheet_generation_phase_13g' in routine.prosrc
      ) > 0
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting = any (array['search_path=', 'search_path=""'])
      )
  )
    and exists (
    select 1
    from pg_proc routine
    where routine.oid =
      'app_private.complete_worksheet_generation_phase_13g(uuid,bigint,uuid,jsonb)'::regprocedure
      and routine.prosecdef
      and position('app_private.assert_service_role' in routine.prosrc) > 0
      and position(
        'selected_assignment.source in (''weakness_auto'', ''adaptive_repeat'')'
          in routine.prosrc
      ) > 0
      and position(
        'selected_assignment.resolution_cycle_id is not null' in routine.prosrc
      ) > 0
      and position(
        'app_private.practice_topic_level_assignment_gates' in routine.prosrc
      ) > 0
      and position(
        'app_private.practice_level_fit_opt_ins' in routine.prosrc
      ) > 0
      and position(
        'coalesce(worksheet ->> ''mode'', '''') <> ''certified_bank'''
          in routine.prosrc
      ) > 0
      and position(
        'practice_level_fit_provider_generation_not_approved' in routine.prosrc
      ) > 0
      and position(
        'app_private.complete_worksheet_generation_phase_12r' in routine.prosrc
      ) > 0
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting = any (array['search_path=', 'search_path=""'])
      )
  )
    and exists (
    select 1
    from pg_proc routine
    where routine.oid =
      'app_private.complete_worksheet_generation_phase_12r(uuid,bigint,uuid,jsonb)'::regprocedure
      and routine.prosecdef
      and position('app_private.assert_service_role' in routine.prosrc) > 0
      and position(
        'app_private.normalize_worksheet_generation_provenance_v2'
          in routine.prosrc
      ) > 0
      and position('public.complete_worksheet_generation' in routine.prosrc) > 0
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting = any (array['search_path=', 'search_path=""'])
      )
  )
    and has_function_privilege(
      'service_role',
      'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'app_private.complete_worksheet_generation_phase_13g(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'app_private.complete_worksheet_generation_phase_12r(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.complete_worksheet_generation_phase_13g(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.complete_worksheet_generation_phase_13g(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.complete_worksheet_generation_phase_12r(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.complete_worksheet_generation_phase_12r(uuid,bigint,uuid,jsonb)',
      'EXECUTE'
    ),
  'shared staging keeps one service-only invoker facade over the level-fit guard and provenance adapter'
);

select ok(
  (
    select count(*) = 6
    from information_schema.columns column_row
    where column_row.table_schema = 'app_private'
      and column_row.table_name = 'worksheet_generation_completions'
      and column_row.column_name in (
        'dual_critic_version',
        'candidate_sha256',
        'deepseek_critic_model',
        'deepseek_verdict_sha256',
        'openai_critic_model',
        'openai_verdict_sha256'
      )
  ),
  'completion ledger exposes all six private dual-critic evidence columns'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_generation_completions'::regclass
      and constraint_row.conname =
        'worksheet_generation_completions_dual_critic_check'
  ),
  'completion ledger has the dual-critic shape constraint'
);

select is(
  app_private.worksheet_candidate_sha256(
    '{
      "schema_version": 1,
      "mode": "generated",
      "title": "Ä A1",
      "questions": [{"n": 1, "ok": true}],
      "source_mix": {
        "mode": "deepseek",
        "deepseek_count": 1,
        "fallback_count": 0
      },
      "validation": {}
    }'::jsonb
  ),
  '8b005785045705926215bff5c3f0a572d28f3896c94c6e9727a37e257a0f0599',
  'database candidate hash matches the Edge canonical JSON fixture'
);

select is(
  app_private.canonical_jsonb_text('{"b":2,"a":1}'::jsonb),
  '{"a":1,"b":2}',
  'canonical JSON output is stable across object-key order'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'generated',
        'generation_source', 'deepseek',
        'generator_model', 'deepseek-v4-pro',
        'questions', jsonb_build_array(
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
        ),
        'source_mix', jsonb_build_object(
          'mode', 'deepseek',
          'deepseek_count', 8,
          'fallback_count', 0
        ),
        'validation', jsonb_build_object(
          'deterministic', true,
          'independent_model', true,
          'critic_model', 'deepseek-v4-flash'
        )
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'legacy single-critic payloads cannot normalize on shared staging'
);

select is(
  (
    select normalized.legacy_worksheet
    from app_private.normalize_worksheet_generation_provenance(
      '{
        "schema_version": 1,
        "mode": "reuse",
        "reusable_practice_test_id": "11111111-1111-4111-8111-111111111111"
      }'::jsonb
    ) normalized
  ),
  '{
    "schema_version": 1,
    "mode": "reuse",
    "reusable_practice_test_id": "11111111-1111-4111-8111-111111111111"
  }'::jsonb,
  'human-certified and approved reuse fast paths remain unchanged'
);

select ok(
  (
    select position('assert_dual_worksheet_critics' in routine.prosrc) > 0
    from pg_proc routine
    where routine.oid =
      'app_private.normalize_worksheet_generation_provenance(jsonb)'::regprocedure
  ),
  'the final provenance normalizer always invokes dual validation'
);

select ok(
  (
    select position('expected_deepseek_verdict_sha256' in routine.prosrc) > 0
      and position('expected_openai_verdict_sha256' in routine.prosrc) > 0
      and position('expected_candidate_sha256' in routine.prosrc) > 0
    from pg_proc routine
    where routine.oid =
      'app_private.assert_or_record_worksheet_generation_completion(uuid,uuid,jsonb,boolean)'::regprocedure
  ),
  'exact replay compares both verdict hashes and the candidate hash'
);

select ok(
  not has_table_privilege(
    'service_role',
    'app_private.worksheet_generation_completions',
    'SELECT'
  )
    and not has_table_privilege(
      'authenticated',
      'app_private.worksheet_generation_completions',
      'SELECT'
    )
    and exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid =
        'app_private.worksheet_generation_completions'::regclass
        and trigger_row.tgname = 'worksheet_generation_completions_immutable'
        and not trigger_row.tgisinternal
    ),
  'raw candidate and verdict evidence remains private and immutable'
);

select * from finish(true);
rollback;
