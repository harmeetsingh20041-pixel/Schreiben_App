-- Shared-staging-safe OpenAI worksheet provenance probe. Its application
-- queries are read-only; pgTAP needs temporary transaction-local tables. It
-- creates no jobs, claims no queue messages, and the final rollback retains
-- no schema or application data.
begin;

select plan(12);

select ok(
  to_regprocedure(
    'app_private.normalize_worksheet_generation_provenance(jsonb)'
  ) is not null,
  'private provenance normalizer exists'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.practice_tests'::regclass
      and constraint_row.conname = 'practice_tests_generation_source_check'
      and constraint_row.convalidated
      and pg_get_constraintdef(constraint_row.oid) like '%openai%'
  ),
  'validated practice-test source constraint permits truthful OpenAI rows'
);

select ok(
  exists (
    select 1
    from pg_proc routine
    where routine.oid =
      'app_private.normalize_worksheet_generation_provenance(jsonb)'::regprocedure
      and routine.provolatile = 'i'
      and not routine.prosecdef
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting = any (array['search_path=', 'search_path=""'])
      )
  ),
  'normalizer is immutable, invoker-safe, and path-pinned'
);

select ok(
  has_function_privilege(
    'service_role',
    'app_private.normalize_worksheet_generation_provenance(jsonb)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.normalize_worksheet_generation_provenance(jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.normalize_worksheet_generation_provenance(jsonb)',
      'EXECUTE'
    ),
  'only the worker service can normalize provider provenance'
);

select ok(
  to_regclass('app_private.worksheet_generation_completions') is not null
    and (
      select relrowsecurity
      from pg_class
      where oid = 'app_private.worksheet_generation_completions'::regclass
    )
    and not has_table_privilege(
      'service_role',
      'app_private.worksheet_generation_completions',
      'SELECT'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.worksheet_generation_completions',
      'SELECT'
    )
    and (
      select count(*) = 2
      from pg_constraint constraint_row
      where constraint_row.conrelid =
          'app_private.worksheet_generation_completions'::regclass
        and constraint_row.contype = 'f'
        and constraint_row.confdeltype = 'r'
    )
    and exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid =
          'app_private.worksheet_generation_completions'::regclass
        and trigger_row.tgname = 'worksheet_generation_completions_immutable'
        and not trigger_row.tgisinternal
    ),
  'private fingerprint ledger is RLS-protected, immutable, and delete-restricted'
);

select is(
  app_private.worksheet_generation_payload_sha256(
    '{"schema_version":1,"mode":"generated"}'::jsonb
  ),
  app_private.worksheet_generation_payload_sha256(
    '{"mode":"generated","schema_version":1}'::jsonb
  ),
  'database payload digest is canonical across JSON object key order'
);

select ok(
  exists (
    select 1
    from pg_proc routine
    where routine.oid =
        'app_private.lock_worksheet_generation_completion(uuid)'::regprocedure
      and routine.prosecdef
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
          'app_private.assert_or_record_worksheet_generation_completion(uuid,uuid,jsonb,boolean)'::regprocedure
        and routine.prosecdef
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting = any (array['search_path=', 'search_path=""'])
        )
    )
    and has_function_privilege(
      'service_role',
      'app_private.assert_or_record_worksheet_generation_completion(uuid,uuid,jsonb,boolean)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.assert_or_record_worksheet_generation_completion(uuid,uuid,jsonb,boolean)',
      'EXECUTE'
    ),
  'path-pinned definer helpers expose only exact service-role fingerprint operations'
);

with base as (
  select jsonb_build_object(
    'schema_version', 1,
    'mode', 'generated',
    'generation_source', 'openai',
    'generator_model', 'gpt-5.4-mini-2026-03-17',
    'questions', jsonb_build_array(
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
    ),
    'source_mix', jsonb_build_object(
      'mode', 'openai',
      'deepseek_count', 0,
      'fallback_count', 8
    )
  ) worksheet
), candidate as (
  select
    worksheet,
    app_private.worksheet_candidate_sha256(worksheet) candidate_sha256,
    jsonb_build_object(
      'ambiguity_free', true,
      'no_answer_leakage', true,
      'duplicate_free', true,
      'level_fit', true,
      'topic_fit', true,
      'type_balance', true,
      'scoring_safe', true
    ) checks,
    jsonb_build_object(
      'mini_lesson_scope_accurate', true,
      'learner_cues_semantically_aligned', true,
      'examples_rubrics_consistent', true
    ) content_checks
  from base
), critic_bases as (
  select
    worksheet,
    candidate_sha256,
    checks,
    content_checks,
    jsonb_build_object(
      'provider', 'deepseek',
      'model', 'deepseek-v4-flash',
      'candidate_sha256', candidate_sha256,
      'approved', true,
      'checks', checks,
      'content_checks', content_checks,
      'rejection_reasons', '[]'::jsonb
    ) deepseek_critic,
    jsonb_build_object(
      'provider', 'openai',
      'model', 'gpt-5.4-2026-03-05',
      'candidate_sha256', candidate_sha256,
      'approved', true,
      'checks', checks,
      'content_checks', content_checks,
      'rejection_reasons', '[]'::jsonb
    ) openai_critic
  from candidate
), payload as (
  select jsonb_set(
    worksheet,
    '{validation}',
    jsonb_build_object(
      'deterministic', true,
      'independent_model', true,
      'critic_model', 'deepseek-v4-flash',
      'candidate_sha256', candidate_sha256,
      'critics', jsonb_build_object(
        'deepseek', deepseek_critic || jsonb_build_object(
          'verdict_sha256',
          app_private.worksheet_critic_verdict_sha256(deepseek_critic)
        ),
        'openai', openai_critic || jsonb_build_object(
          'verdict_sha256',
          app_private.worksheet_critic_verdict_sha256(openai_critic)
        )
      ),
      'attempt_count', 1,
      'checks', checks,
      'rejection_reasons', '[]'::jsonb
    )
  ) worksheet
  from critic_bases
), normalized as (
  select result.*
  from payload
  cross join lateral app_private.normalize_worksheet_generation_provenance(
    payload.worksheet
  ) result
)
select ok(
  provider_source = 'openai'
    and legacy_worksheet ->> 'generation_source' = 'deepseek'
    and legacy_worksheet #>> '{source_mix,mode}' = 'deepseek'
    and provider_metadata #>> '{source_mix,mode}' = 'openai'
    and provider_metadata #>> '{validation,critic_model}' =
      'deepseek-v4-flash'
    and provider_metadata #>> '{validation,critics,openai,model}' =
      'gpt-5.4-2026-03-05',
  'pinned OpenAI generator and critic provenance normalize truthfully'
)
from normalized;

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'generated',
        'generation_source', 'openai',
        'generator_model', 'gpt-5.4-mini',
        'questions', jsonb_build_array(
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
        ),
        'source_mix', jsonb_build_object(
          'mode', 'openai',
          'deepseek_count', 0,
          'fallback_count', 8
        ),
        'validation', jsonb_build_object(
          'critic_model', 'gpt-5.4-2026-03-05'
        )
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'legacy single-critic generated payloads fail closed without mutation'
);

select ok(
  exists (
    select 1
    from pg_proc routine
    join pg_language language_row on language_row.oid = routine.prolang
    where routine.oid =
      'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)'::regprocedure
      and language_row.lanname = 'sql'
      and not routine.prosecdef
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting = any (array['search_path=', 'search_path=""'])
      )
      and position(
        'app_private.complete_worksheet_generation_phase_13g' in routine.prosrc
      ) > 0
  )
    and exists (
      select 1
      from pg_proc routine
      join pg_language language_row on language_row.oid = routine.prolang
      where routine.oid =
        'app_private.complete_worksheet_generation_phase_13g(uuid,bigint,uuid,jsonb)'::regprocedure
        and language_row.lanname = 'plpgsql'
        and routine.prosecdef
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting = any (array['search_path=', 'search_path=""'])
        )
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
        and has_function_privilege(
          'service_role',
          'app_private.complete_worksheet_generation_phase_13g(uuid,bigint,uuid,jsonb)',
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
    )
    and exists (
      select 1
      from pg_proc routine
      join pg_language language_row on language_row.oid = routine.prolang
      where routine.oid =
        'app_private.complete_worksheet_generation_phase_12r(uuid,bigint,uuid,jsonb)'::regprocedure
        and language_row.lanname = 'plpgsql'
        and routine.prosecdef
        and position('app_private.assert_service_role' in routine.prosrc) > 0
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting = any (array['search_path=', 'search_path=""'])
        )
        and has_function_privilege(
          'service_role',
          'app_private.complete_worksheet_generation_phase_12r(uuid,bigint,uuid,jsonb)',
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
        )
    ),
  'api completion is an invoker-only facade over the level-fit guard and sealed provenance definer'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)',
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
    ),
  'truthful completion adapter remains service-only'
);

select ok(
  (
    select position(
      'app_private.normalize_worksheet_generation_provenance_v2' in routine.prosrc
    ) > 0
      and position('public.complete_worksheet_generation' in routine.prosrc) > 0
      and position(
        'app_private.lock_worksheet_generation_completion' in routine.prosrc
      ) > 0
      and position(
        'app_private.assert_or_record_worksheet_generation_completion_v2' in routine.prosrc
      ) > 0
      and position(
        'api.complete_worksheet_generation_openai_legacy' in routine.prosrc
      ) > 0
      and position('selected_job_status = ''succeeded''' in routine.prosrc) > 0
      and position(
        'app_private.worksheet_generation_completions_v2' in routine.prosrc
      ) > 0
      and position(
        'worksheet ->> ''generation_source'' = ''openai''' in routine.prosrc
      ) > 0
      and position('not completion_was_succeeded' in routine.prosrc) > 0
      and position(
        'generation_metadata = normalized.provider_metadata' in routine.prosrc
      ) > 0
    from pg_proc routine
    where routine.oid =
      'app_private.complete_worksheet_generation_phase_12r(uuid,bigint,uuid,jsonb)'::regprocedure
  ),
  'private adapter locks, validates current evidence or exact legacy replay, and never rewrites succeeded provenance'
);

select * from finish(true);
rollback;
