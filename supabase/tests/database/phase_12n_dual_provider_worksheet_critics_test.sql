begin;

select plan(30);

create temporary table phase_12n_payloads (
  name text primary key,
  payload jsonb not null
) on commit drop;

create or replace function pg_temp.phase_12n_dual_payload(
  source_payload jsonb,
  deepseek_failed_check text default null,
  openai_failed_check text default null
)
returns jsonb
language plpgsql
as $$
declare
  candidate_sha256 text;
  passing_checks jsonb := jsonb_build_object(
    'ambiguity_free', true,
    'no_answer_leakage', true,
    'duplicate_free', true,
    'level_fit', true,
    'topic_fit', true,
    'type_balance', true,
    'scoring_safe', true
  );
  deepseek_checks jsonb := passing_checks;
  openai_checks jsonb := passing_checks;
  combined_checks jsonb;
  deepseek_reasons jsonb := '[]'::jsonb;
  openai_reasons jsonb := '[]'::jsonb;
  deepseek_critic jsonb;
  openai_critic jsonb;
  deepseek_approved boolean := deepseek_failed_check is null;
  openai_approved boolean := openai_failed_check is null;
  check_name text;
begin
  if deepseek_failed_check is not null then
    deepseek_checks := jsonb_set(
      deepseek_checks,
      array[deepseek_failed_check],
      'false'::jsonb
    );
    deepseek_reasons := jsonb_build_array(
      case deepseek_failed_check
        when 'ambiguity_free' then 'The exact answer remains ambiguous.'
        when 'level_fit' then 'The tasks exceed the requested CEFR level.'
        else 'DeepSeek rejected the candidate.'
      end
    );
  end if;
  if openai_failed_check is not null then
    openai_checks := jsonb_set(
      openai_checks,
      array[openai_failed_check],
      'false'::jsonb
    );
    openai_reasons := jsonb_build_array(
      case openai_failed_check
        when 'no_answer_leakage' then 'One prompt leaks its answer.'
        when 'level_fit' then 'The tasks exceed the requested CEFR level.'
        else 'OpenAI rejected the candidate.'
      end
    );
  end if;

  combined_checks := '{}'::jsonb;
  foreach check_name in array array[
    'ambiguity_free',
    'no_answer_leakage',
    'duplicate_free',
    'level_fit',
    'topic_fit',
    'type_balance',
    'scoring_safe'
  ]
  loop
    combined_checks := combined_checks || jsonb_build_object(
      check_name,
      (deepseek_checks ->> check_name)::boolean and
        (openai_checks ->> check_name)::boolean
    );
  end loop;

  candidate_sha256 := app_private.worksheet_candidate_sha256(source_payload);
  deepseek_critic := jsonb_build_object(
    'provider', 'deepseek',
    'model', 'deepseek-v4-flash',
    'candidate_sha256', candidate_sha256,
    'approved', deepseek_approved,
    'checks', deepseek_checks,
    'rejection_reasons', deepseek_reasons
  );
  deepseek_critic := deepseek_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(deepseek_critic)
  );
  openai_critic := jsonb_build_object(
    'provider', 'openai',
    'model', 'gpt-5.4-2026-03-05',
    'candidate_sha256', candidate_sha256,
    'approved', openai_approved,
    'checks', openai_checks,
    'rejection_reasons', openai_reasons
  );
  openai_critic := openai_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(openai_critic)
  );

  return jsonb_set(
    source_payload,
    '{validation}',
    jsonb_build_object(
      'deterministic', true,
      'independent_model', deepseek_approved and openai_approved,
      'critic_model', 'deepseek-v4-flash',
      'candidate_sha256', candidate_sha256,
      'critics', jsonb_build_object(
        'deepseek', deepseek_critic,
        'openai', openai_critic
      ),
      'attempt_count', 1,
      'checks', combined_checks,
      'rejection_reasons', deepseek_reasons || openai_reasons
    )
  );
end;
$$;

insert into phase_12n_payloads (name, payload)
values
  (
    'deepseek_approved',
    pg_temp.phase_12n_dual_payload(
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'generated',
        'generation_source', 'deepseek',
        'generator_model', 'deepseek-v4-pro',
        'title', 'Akkusativ A1',
        'questions', jsonb_build_array(
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
        ),
        'source_mix', jsonb_build_object(
          'mode', 'deepseek',
          'deepseek_count', 8,
          'fallback_count', 0
        )
      )
    )
  ),
  (
    'openai_approved',
    pg_temp.phase_12n_dual_payload(
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'generated',
        'generation_source', 'openai',
        'generator_model', 'gpt-5.4-mini-2026-03-17',
        'title', 'Akkusativ A1',
        'questions', jsonb_build_array(
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
        ),
        'source_mix', jsonb_build_object(
          'mode', 'openai',
          'deepseek_count', 0,
          'fallback_count', 8
        )
      )
    )
  ),
  (
    'disagreement',
    pg_temp.phase_12n_dual_payload(
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'generated',
        'generation_source', 'deepseek',
        'generator_model', 'deepseek-v4-pro',
        'title', 'Rejected Akkusativ A1',
        'questions', jsonb_build_array(
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
        ),
        'source_mix', jsonb_build_object(
          'mode', 'deepseek',
          'deepseek_count', 8,
          'fallback_count', 0
        )
      ),
      'ambiguity_free',
      'no_answer_leakage'
    )
  );

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
  'canonical candidate, verdict, and dual-critic validators exist'
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
  'dual-critic validation is immutable, invoker-safe, and path-pinned'
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
  'only the worker service can call the private dual-critic validator'
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
  'the legacy worksheet completion engine is not directly executable'
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
  'the service-only API facade delegates through the level-fit guard to the provenance adapter'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $$
    select *
    from public.complete_worksheet_generation(
      '00000000-0000-0000-0000-000000000001'::uuid,
      1,
      '00000000-0000-0000-0000-000000000002'::uuid,
      '{"schema_version":1,"mode":"generated"}'::jsonb
    )
  $$,
  '42501',
  'permission denied for function complete_worksheet_generation',
  'service-role callers cannot bypass provenance through the legacy engine'
);

select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      '00000000-0000-0000-0000-000000000001'::uuid,
      1,
      '00000000-0000-0000-0000-000000000002'::uuid,
      '{"schema_version":1,"mode":"generated"}'::jsonb
    )
  $$,
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'the permitted API path reaches dual validation before job mutation'
);

reset role;

select throws_ok(
  $$
    select *
    from public.complete_worksheet_generation(
      '00000000-0000-0000-0000-000000000001'::uuid,
      1,
      '00000000-0000-0000-0000-000000000002'::uuid,
      '{"schema_version":1,"mode":"generated"}'::jsonb
    )
  $$,
  '02000',
  'Worksheet generation job not found.',
  'owner-only Phase 9 transaction regressions can still exercise the internal engine'
);

select set_config('request.jwt.claim.role', '', true);

select ok(
  exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'app_private'
      and column_row.table_name = 'worksheet_generation_completions'
      and column_row.column_name = 'candidate_sha256'
  )
    and exists (
      select 1
      from information_schema.columns column_row
      where column_row.table_schema = 'app_private'
        and column_row.table_name = 'worksheet_generation_completions'
        and column_row.column_name = 'deepseek_verdict_sha256'
    )
    and exists (
      select 1
      from information_schema.columns column_row
      where column_row.table_schema = 'app_private'
        and column_row.table_name = 'worksheet_generation_completions'
        and column_row.column_name = 'openai_verdict_sha256'
    ),
  'immutable completion evidence has exact candidate and both verdict hashes'
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
  'completion ledger enforces the dual-critic evidence shape'
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
  'database candidate hash exactly matches the Edge canonical JSON fixture'
);

select is(
  app_private.canonical_jsonb_text('{"b":2,"a":1}'::jsonb),
  '{"a":1,"b":2}',
  'canonical JSON orders object keys independently of input order'
);

select is(
  app_private.worksheet_candidate_sha256(
    (select payload from phase_12n_payloads where name = 'deepseek_approved')
  ),
  (
    select payload #>> '{validation,candidate_sha256}'
    from phase_12n_payloads
    where name = 'deepseek_approved'
  ),
  'candidate digest excludes validation metadata and recomputes exactly'
);

select lives_ok(
  $$
    select app_private.assert_dual_worksheet_critics(
      (select payload from pg_temp.phase_12n_payloads
       where name = 'deepseek_approved')
    )
  $$,
  'two coherent approvals validate successfully'
);

select ok(
  (
    select normalized.provider_source = 'openai'
      and normalized.legacy_worksheet ->> 'generation_source' = 'deepseek'
      and normalized.provider_metadata
        #>> '{validation,critics,deepseek,model}' = 'deepseek-v4-flash'
      and normalized.provider_metadata
        #>> '{validation,critics,openai,model}' = 'gpt-5.4-2026-03-05'
    from app_private.normalize_worksheet_generation_provenance(
      (select payload from phase_12n_payloads where name = 'openai_approved')
    ) normalized
  ),
  'OpenAI-generated candidates retain both critics and require DeepSeek evidence'
);

select lives_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      (select payload from pg_temp.phase_12n_payloads
       where name = 'disagreement')
    )
  $$,
  'coherent disagreement remains valid private quarantine evidence'
);

select ok(
  (
    select payload #>> '{validation,independent_model}' = 'false'
      and payload #>> '{validation,checks,ambiguity_free}' = 'false'
      and payload #>> '{validation,checks,no_answer_leakage}' = 'false'
      and jsonb_array_length(payload #> '{validation,rejection_reasons}') = 2
    from phase_12n_payloads
    where name = 'disagreement'
  ),
  'ambiguity and answer-leakage disagreement cannot be labeled approved'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12n_payloads
         where name = 'deepseek_approved'),
        '{validation,critics}',
        jsonb_build_object(
          'deepseek', (
            select payload #> '{validation,critics,deepseek}'
            from pg_temp.phase_12n_payloads
            where name = 'deepseek_approved'
          )
        )
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'a missing OpenAI critic fails closed'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12n_payloads
         where name = 'deepseek_approved'),
        '{title}',
        '"Relabeled candidate"'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_candidate_hash_mismatch',
  'candidate content cannot change after either critic verdict'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12n_payloads
         where name = 'deepseek_approved'),
        '{validation,critics,openai,verdict_sha256}',
        to_jsonb(repeat('0', 64))
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_evidence_invalid',
  'an OpenAI verdict hash cannot be replaced'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12n_payloads
         where name = 'deepseek_approved'),
        '{validation,critics,openai,model}',
        '"gpt-5.4"'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_evidence_invalid',
  'the OpenAI critic cannot be relabeled to an alias'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12n_payloads
         where name = 'deepseek_approved'),
        '{validation,critics,deepseek,candidate_sha256}',
        to_jsonb(repeat('f', 64))
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_evidence_invalid',
  'both critic verdicts must bind the same candidate hash'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12n_payloads
         where name = 'deepseek_approved'),
        '{validation,critics,deepseek,checks,level_fit}',
        'false'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_evidence_invalid',
  'an approved verdict cannot contain a failed CEFR check'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12n_payloads
         where name = 'disagreement'),
        '{validation,checks,ambiguity_free}',
        'true'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'combined checks cannot conceal one critic rejection'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12n_payloads
         where name = 'disagreement'),
        '{validation,rejection_reasons}',
        '[]'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'top-level rejection reasons must match both immutable verdicts'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12n_payloads
         where name = 'disagreement'),
        '{validation,independent_model}',
        'true'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'disagreement cannot be promoted to independent approval'
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
  'legacy single-critic payloads can no longer auto-release'
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
  'exact replay compares candidate and both critic verdict hashes'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.worksheet_generation_completions'::regclass
      and trigger_row.tgname = 'worksheet_generation_completions_immutable'
      and not trigger_row.tgisinternal
  ),
  'dual-critic completion evidence remains immutable'
);

select is(
  (
    select count(*)::integer
    from app_private.worksheet_generation_completions completion
    where completion.dual_critic_version not in (0, 1)
  ),
  0,
  'no completion ledger row has an unsupported dual-critic version'
);

select * from finish(true);
rollback;
