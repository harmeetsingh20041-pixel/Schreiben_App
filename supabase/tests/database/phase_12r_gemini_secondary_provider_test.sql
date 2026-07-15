begin;

select plan(57);

create or replace function pg_temp.phase_12r_gemini_candidate(
  source_name text default 'deepseek',
  source_mix_mode jsonb default null,
  deepseek_count_value jsonb default null,
  gemini_count_value jsonb default null
)
returns jsonb
language plpgsql
as $$
declare
  candidate jsonb := jsonb_build_object(
    'schema_version', 1,
    'mode', 'generated',
    'generation_source', source_name,
    'generator_model', case source_name
      when 'deepseek' then 'deepseek-v4-pro'
      when 'gemini' then 'gemini-3.1-flash-lite'
      else 'gpt-5.4-mini-2026-03-17'
    end,
    'title', 'Ä A1',
    'questions', jsonb_build_array(jsonb_build_object('n', 1, 'ok', true)),
    'source_mix', jsonb_build_object(
      'mode', case when source_mix_mode is null
        then to_jsonb(source_name) else source_mix_mode end,
      'deepseek_count', case when deepseek_count_value is null
        then to_jsonb(case when source_name = 'deepseek' then 1 else 0 end)
        else deepseek_count_value end,
      'gemini_count', case when gemini_count_value is null
        then to_jsonb(case when source_name = 'deepseek' then 0 else 1 end)
        else gemini_count_value end
    ),
    'validation', '{}'::jsonb
  );
  candidate_sha256 text;
  checks jsonb := jsonb_build_object(
    'ambiguity_free', true,
    'no_answer_leakage', true,
    'duplicate_free', true,
    'level_fit', true,
    'topic_fit', true,
    'type_balance', true,
    'scoring_safe', true
  );
  content_checks jsonb := jsonb_build_object(
    'mini_lesson_scope_accurate', true,
    'learner_cues_semantically_aligned', true,
    'examples_rubrics_consistent', true
  );
  deepseek_critic jsonb;
  gemini_critic jsonb;
begin
  candidate_sha256 := app_private.worksheet_candidate_sha256(candidate);
  deepseek_critic := jsonb_build_object(
    'provider', 'deepseek',
    'model', 'deepseek-v4-flash',
    'candidate_sha256', candidate_sha256,
    'approved', true,
    'checks', checks,
    'content_checks', content_checks,
    'rejection_reasons', '[]'::jsonb
  );
  deepseek_critic := deepseek_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(deepseek_critic)
  );
  gemini_critic := jsonb_build_object(
    'provider', 'gemini',
    'model', 'gemini-2.5-flash',
    'candidate_sha256', candidate_sha256,
    'approved', true,
    'checks', checks,
    'content_checks', content_checks,
    'rejection_reasons', '[]'::jsonb
  );
  gemini_critic := gemini_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(gemini_critic)
  );

  return jsonb_set(
    candidate,
    '{validation}',
    jsonb_build_object(
      'deterministic', true,
      'independent_model', true,
      'critic_model', 'deepseek-v4-flash',
      'candidate_sha256', candidate_sha256,
      'critics', jsonb_build_object(
        'deepseek', deepseek_critic,
        'gemini', gemini_critic
      ),
      'attempt_count', 1,
      'checks', checks,
      'content_checks', content_checks,
      'rejection_reasons', '[]'::jsonb
    )
  );
end;
$$;

select ok(
  to_regclass('app_private.writing_feedback_adjudications_v2') is not null
    and to_regclass(
      'app_private.worksheet_generation_completions_v2'
    ) is not null
    and to_regclass(
      'app_private.worksheet_answer_completion_provenance_v2'
    ) is not null
    and to_regclass(
      'app_private.worksheet_answer_adjudication_evidence_v2'
    ) is not null
    and to_regclass('app_private.ai_model_cost_policies') is not null
    and to_regclass('app_private.ai_spend_global_policy') is not null
    and to_regclass('app_private.ai_workspace_monthly_budgets') is not null
    and to_regclass('app_private.ai_budget_change_audit') is not null
    and to_regclass('app_private.ai_spend_reservations') is not null,
  'all Gemini-v2 provenance and spend-control tables exist'
);

select ok(
  (
    select count(*) = 9 and bool_and(relation.relrowsecurity)
    from pg_class relation
    where relation.oid in (
      'app_private.writing_feedback_adjudications_v2'::regclass,
      'app_private.worksheet_generation_completions_v2'::regclass,
      'app_private.worksheet_answer_completion_provenance_v2'::regclass,
      'app_private.worksheet_answer_adjudication_evidence_v2'::regclass,
      'app_private.ai_model_cost_policies'::regclass,
      'app_private.ai_spend_global_policy'::regclass,
      'app_private.ai_workspace_monthly_budgets'::regclass,
      'app_private.ai_budget_change_audit'::regclass,
      'app_private.ai_spend_reservations'::regclass
    )
  ),
  'every new private table has RLS defense in depth'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'app_private.writing_feedback_adjudications_v2',
      'app_private.worksheet_generation_completions_v2',
      'app_private.worksheet_answer_completion_provenance_v2',
      'app_private.worksheet_answer_adjudication_evidence_v2',
      'app_private.ai_model_cost_policies',
      'app_private.ai_spend_global_policy',
      'app_private.ai_workspace_monthly_budgets',
      'app_private.ai_budget_change_audit',
      'app_private.ai_spend_reservations'
    ]) relation_name
    cross join unnest(array['anon', 'authenticated', 'service_role']) role_name
    where has_table_privilege(role_name, relation_name, 'SELECT')
       or has_table_privilege(role_name, relation_name, 'INSERT')
       or has_table_privilege(role_name, relation_name, 'UPDATE')
       or has_table_privilege(role_name, relation_name, 'DELETE')
  ),
  'browser and service roles have no direct private-table privileges'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'app_private'
      and column_row.table_name in (
        'writing_feedback_adjudications_v2',
        'worksheet_generation_completions_v2',
        'worksheet_answer_completion_provenance_v2',
        'worksheet_answer_adjudication_evidence_v2',
        'ai_spend_reservations',
        'ai_budget_change_audit'
      )
      and column_row.column_name ~
        '(student_text|original_text|prompt|response|answer_text|worksheet_content|feedback_content)'
      and column_row.column_name !~ '_sha256$'
  ),
  'new ledgers contain no student text, prompts, responses, or educational bodies'
);

select ok(
  to_regclass('app_private.writing_feedback_adjudications') is not null
    and to_regclass('app_private.worksheet_generation_completions') is not null
    and to_regclass(
      'app_private.worksheet_answer_completion_provenance'
    ) is not null
    and to_regclass(
      'app_private.worksheet_answer_adjudication_evidence'
    ) is not null,
  'immutable legacy OpenAI evidence remains available for exact history'
);

select ok(
  (
    select pg_get_constraintdef(constraint_row.oid) like '%gemini%'
      and pg_get_constraintdef(constraint_row.oid) like '%openai%'
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.practice_tests'::regclass
      and constraint_row.conname = 'practice_tests_generation_source_check'
  )
    and (
      select pg_get_constraintdef(constraint_row.oid) like '%gemini%'
        and pg_get_constraintdef(constraint_row.oid) like '%openai%'
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'public.practice_attempt_question_reviews'::regclass
        and constraint_row.conname =
          'practice_attempt_question_reviews_evaluator_source_check'
    ),
  'public provenance constraints preserve history and admit truthful Gemini'
);

select ok(
  to_regprocedure(
    'app_private.record_or_assert_writing_adjudication_v2(uuid,bigint,uuid,jsonb)'
  ) is not null
    and to_regprocedure(
      'app_private.assert_worksheet_critics_v2(jsonb)'
    ) is not null
    and to_regprocedure(
      'app_private.complete_worksheet_generation_phase_12r(uuid,bigint,uuid,jsonb)'
    ) is not null
    and to_regprocedure(
      'app_private.complete_worksheet_answer_phase_12r(uuid,bigint,uuid,jsonb,jsonb)'
    ) is not null
    and to_regprocedure(
      'api.reserve_ai_spend(uuid,integer,text,text,text,text,bigint,integer)'
    ) is not null
    and to_regprocedure(
      'api.finalize_ai_spend_reservation(uuid,bigint,bigint)'
    ) is not null
    and to_regprocedure(
      'api.release_ai_spend_reservation(uuid,text)'
    ) is not null,
  'all v2 completion and spend RPC contracts exist'
);

select ok(
  (
    select count(*) = 6 and bool_and(not routine.prosecdef)
    from pg_proc routine
    where routine.oid in (
      'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)'::regprocedure,
      'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)'::regprocedure,
      'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)'::regprocedure,
      'api.reserve_ai_spend(uuid,integer,text,text,text,text,bigint,integer)'::regprocedure,
      'api.finalize_ai_spend_reservation(uuid,bigint,bigint)'::regprocedure,
      'api.release_ai_spend_reservation(uuid,text)'::regprocedure
    )
  ),
  'exposed API facades remain security invokers'
);

select ok(
  (
    select count(*) = 6 and bool_and(routine.prosecdef)
    from pg_proc routine
    where routine.oid in (
      'app_private.record_or_assert_writing_adjudication_v2(uuid,bigint,uuid,jsonb)'::regprocedure,
      'app_private.complete_worksheet_generation_phase_12r(uuid,bigint,uuid,jsonb)'::regprocedure,
      'app_private.complete_worksheet_answer_with_adjudication_v2(uuid,bigint,uuid,jsonb,jsonb)'::regprocedure,
      'app_private.reserve_ai_spend(uuid,integer,text,text,text,text,bigint,integer)'::regprocedure,
      'app_private.finalize_ai_spend_reservation(uuid,bigint,bigint)'::regprocedure,
      'app_private.release_ai_spend_reservation(uuid,text)'::regprocedure
    )
  ),
  'only private implementations own elevated transactional privileges'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.reserve_ai_spend(uuid,integer,text,text,text,text,bigint,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'api.finalize_ai_spend_reservation(uuid,bigint,bigint)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'api.release_ai_spend_reservation(uuid,text)',
      'EXECUTE'
    ),
  'the worker service can use every spend transition facade'
);

select ok(
  not exists (
    select 1
    from unnest(array['anon', 'authenticated']) role_name
    cross join unnest(array[
      'api.reserve_ai_spend(uuid,integer,text,text,text,text,bigint,integer)',
      'api.finalize_ai_spend_reservation(uuid,bigint,bigint)',
      'api.release_ai_spend_reservation(uuid,text)'
    ]) function_name
    where has_function_privilege(role_name, function_name, 'EXECUTE')
  )
    and not has_function_privilege(
      'anon', 'api.get_ai_spend_health(uuid)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'api.get_ai_spend_health(uuid)', 'EXECUTE'
    ),
  'browser roles cannot reserve, finalize, or release provider spend'
);

select ok(
  not has_function_privilege(
    'service_role',
    'api.complete_worksheet_generation_openai_legacy(uuid,bigint,uuid,jsonb)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'service_role',
      'api.complete_worksheet_answer_adjudication_openai_legacy(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.complete_worksheet_answer_with_adjudication(uuid,bigint,uuid,jsonb,jsonb)',
      'EXECUTE'
    ),
  'stale OpenAI completion facades are not worker-callable'
);

select is(
  (select count(*)::integer from app_private.ai_model_cost_policies),
  20,
  'the append-only provider/model/purpose history has twenty rows'
);

select ok(
  not exists (
    select 1
    from app_private.ai_model_cost_policies policy
    where policy.provider_name = 'openai'
       or policy.model_name like 'gpt-%'
  ),
  'no new OpenAI model can receive a spend reservation'
);

select is(
  (
    select jsonb_agg(jsonb_build_array(
      provider_name,
      model_name,
      call_purpose,
      input_rate_microusd_per_million,
      output_rate_microusd_per_million,
      maximum_reservation_microusd
    ) order by provider_name, model_name, call_purpose)
    from app_private.ai_model_cost_policies
  ),
  '[
    ["deepseek","deepseek-v4-flash","worksheet_answer_evaluation",140000,280000,50000],
    ["deepseek","deepseek-v4-flash","worksheet_critique",140000,280000,50000],
    ["deepseek","deepseek-v4-flash","writing_generation",140000,280000,75000],
    ["deepseek","deepseek-v4-pro","worksheet_answer_adjudication",435000,870000,50000],
    ["deepseek","deepseek-v4-pro","worksheet_generation",435000,870000,100000],
    ["deepseek","deepseek-v4-pro","writing_adjudication",435000,870000,75000],
    ["deepseek","deepseek-v4-pro","writing_generation",435000,870000,100000],
    ["gemini","gemini-2.5-flash","worksheet_critique",300000,2500000,75000],
    ["gemini","gemini-2.5-flash","writing_critique",300000,2500000,75000],
    ["gemini","gemini-3.1-flash-lite","worksheet_answer_evaluation",250000,1500000,50000],
    ["gemini","gemini-3.1-flash-lite","worksheet_critique",250000,1500000,150000],
    ["gemini","gemini-3.1-flash-lite","worksheet_generation",250000,1500000,200000],
    ["gemini","gemini-3.1-flash-lite","writing_critique",250000,1500000,150000],
    ["gemini","gemini-3.1-flash-lite","writing_final_critique",250000,1500000,150000],
    ["gemini","gemini-3.1-flash-lite","writing_generation",250000,1500000,300000],
    ["gemini","gemini-3.5-flash","worksheet_critique",1500000,9000000,150000],
    ["gemini","gemini-3.5-flash","worksheet_generation",1500000,9000000,200000],
    ["gemini","gemini-3.5-flash","writing_critique",1500000,9000000,150000],
    ["gemini","gemini-3.5-flash","writing_final_critique",1500000,9000000,150000],
    ["gemini","gemini-3.5-flash","writing_generation",1500000,9000000,300000]
  ]'::jsonb,
  'rates and conservative per-call caps match the approved cost matrix'
);

select is(
  (
    select jsonb_build_array(
      monthly_limit_microusd,
      default_workspace_monthly_limit_microusd,
      emergency_stop
    )
    from app_private.ai_spend_global_policy
    where singleton
  ),
  '[225000000,100000000,false]'::jsonb,
  'global hard cap is USD 225 and new workspaces default to USD 100'
);

select is(
  app_private.ai_spend_cost_microusd(1000, 1000, 1500000, 9000000),
  10500::bigint,
  'Gemini 3.5 standard-rate metering rounds billed input and output upward'
);

select is(
  app_private.ai_spend_cost_microusd(1000, 1000, 140000, 280000),
  420::bigint,
  'DeepSeek Flash cache-miss metering is deterministic and conservative'
);

select is(
  app_private.worksheet_candidate_sha256(jsonb_build_object(
    'schema_version', 1,
    'mode', 'generated',
    'title', 'Ä A1',
    'questions', jsonb_build_array(jsonb_build_object('n', 1, 'ok', true)),
    'source_mix', jsonb_build_object(
      'mode', 'deepseek',
      'deepseek_count', 1,
      'gemini_count', 0
    ),
    'validation', '{}'::jsonb
  )),
  '59b8b6c89067adf4fdfea8eaed03c8db6f615a5e304a07c21114597874c4b0fd',
  'database candidate hashing matches the Gemini Edge fixture byte-for-byte'
);

select lives_ok(
  $$select app_private.assert_worksheet_critics_v2(
    pg_temp.phase_12r_gemini_candidate()
  )$$,
  'a correctly hash-bound DeepSeek/Gemini critic pair passes'
);

select is(
  (
    select jsonb_build_object(
      'source', normalized.provider_source,
      'model', normalized.legacy_worksheet ->> 'generator_model',
      'legacy_mix', normalized.legacy_worksheet -> 'source_mix',
      'truthful_mix', normalized.provider_metadata -> 'source_mix'
    )
    from app_private.normalize_worksheet_generation_provenance_v2(
      pg_temp.phase_12r_gemini_candidate()
    ) normalized
  ),
  '{
    "source":"deepseek",
    "model":"deepseek-v4-pro",
    "legacy_mix":{"mode":"deepseek","deepseek_count":1,"fallback_count":0},
    "truthful_mix":{"mode":"deepseek","deepseek_count":1,"gemini_count":0}
  }'::jsonb,
  'normalization changes only the transaction-local legacy envelope'
);

select throws_ok(
  $$select app_private.assert_worksheet_critics_v2(
    jsonb_set(
      pg_temp.phase_12r_gemini_candidate(),
      '{title}',
      to_jsonb('tampered'::text)
    )
  )$$,
  '22023',
  'worksheet_candidate_hash_mismatch',
  'candidate mutation after criticism fails closed'
);

select throws_ok(
  $$select * from app_private.normalize_worksheet_generation_provenance_v2(
    pg_temp.phase_12r_gemini_candidate('openai')
  )$$,
  '22023',
  'Generated worksheet provenance is invalid.',
  'new OpenAI generator provenance is rejected'
);

select throws_ok(
  $$select app_private.assert_worksheet_critics_v2(
    jsonb_set(
      pg_temp.phase_12r_gemini_candidate(),
      '{validation,critic_model}',
      'null'::jsonb
    )
  )$$,
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'JSON null cannot bypass the pinned worksheet critic model'
);

select throws_ok(
  $$select * from app_private.normalize_worksheet_generation_provenance_v2(
    pg_temp.phase_12r_gemini_candidate('deepseek', 'null'::jsonb)
  )$$,
  '22023',
  'Generated worksheet provenance is invalid.',
  'JSON null cannot bypass the truthful worksheet source-mix mode'
);

select throws_ok(
  $$select * from app_private.normalize_worksheet_generation_provenance_v2(
    pg_temp.phase_12r_gemini_candidate(
      'deepseek',
      to_jsonb('deepseek'::text),
      '999999999999999999999999999999999999999999999999'::jsonb,
      '0'::jsonb
    )
  )$$,
  '22023',
  'Generated worksheet provenance is invalid.',
  'oversized source counts fail with the stable provenance contract error'
);

select ok(
  app_private.valid_worksheet_answer_source_map_v2(
    '[
      {"question_id":"12111111-1111-4111-8111-111111111111","provider_source":"deepseek"},
      {"question_id":"12222222-2222-4222-8222-222222222222","provider_source":"gemini"}
    ]'::jsonb,
    array[
      '12111111-1111-4111-8111-111111111111'::uuid,
      '12222222-2222-4222-8222-222222222222'::uuid
    ]
  ),
  'answer source maps accept exact DeepSeek/Gemini question coverage'
);

select ok(
  not app_private.valid_worksheet_answer_source_map_v2(
    '[
      {"question_id":"12111111-1111-4111-8111-111111111111","provider_source":"openai"}
    ]'::jsonb,
    array['12111111-1111-4111-8111-111111111111'::uuid]
  ),
  'answer source maps reject new OpenAI evidence'
);

select ok(
  (
    select count(*) = 8
    from pg_trigger trigger_row
    where trigger_row.tgname in (
      'writing_feedback_adjudications_v2_immutable',
      'worksheet_generation_completions_v2_immutable',
      'worksheet_answer_completion_provenance_v2_immutable',
      'worksheet_answer_adjudication_evidence_v2_immutable',
      'ai_model_cost_policies_immutable',
      'ai_budget_change_audit_immutable',
      'ai_spend_reservations_guard',
      'ai_workspace_monthly_budgets_prepare'
    )
      and not trigger_row.tgisinternal
  ),
  'provenance, pricing, reservations, and budget history are mutation-guarded'
);

select ok(
  (
    select count(*) = 8 and bool_and(constraint_row.confdeltype = 'r')
    from pg_constraint constraint_row
    where constraint_row.conrelid in (
      'app_private.writing_feedback_adjudications_v2'::regclass,
      'app_private.worksheet_generation_completions_v2'::regclass,
      'app_private.worksheet_answer_completion_provenance_v2'::regclass,
      'app_private.worksheet_answer_adjudication_evidence_v2'::regclass
    )
      and constraint_row.contype = 'f'
  ),
  'all v2 evidence foreign keys preserve history with ON DELETE RESTRICT'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.ai_spend_reservations'::regclass
      and constraint_row.contype = 'u'
      and pg_get_constraintdef(constraint_row.oid) like
        '%job_id, entity_version, call_key%'
  )
    and exists (
      select 1
      from pg_indexes index_row
      where index_row.schemaname = 'app_private'
        and index_row.indexname = 'ai_spend_reservations_workspace_month_idx'
    ),
  'spend reservations are job/version/call idempotent and budget-indexed'
);

select ok(
  (
    select count(*) = 4
    from pg_trigger trigger_row
    where trigger_row.tgname in (
      'ai_spend_global_policy_prepare',
      'ai_workspace_monthly_budgets_prepare',
      'ai_spend_global_policy_audit',
      'ai_workspace_monthly_budgets_audit'
    )
      and not trigger_row.tgisinternal
  ),
  'every operator budget override increments revision and creates audit history'
);

select ok(
  not has_table_privilege(
    'service_role', 'app_private.ai_spend_global_policy', 'UPDATE'
  )
    and not has_table_privilege(
      'service_role', 'app_private.ai_workspace_monthly_budgets', 'UPDATE'
    ),
  'teachers and workers cannot raise monthly caps'
);

select ok(
  (
    select count(*) = 2
      and bool_or(input_names = array[
        'target_reservation_id',
        'target_billed_input_tokens',
        'target_billed_output_tokens'
      ])
      and bool_or(input_names = array[
        'target_reservation_id',
        'target_billed_input_tokens',
        'target_billed_output_tokens',
        'target_billed_cached_input_tokens',
        'target_billed_uncached_input_tokens'
      ])
    from (
      select
        parameter_row.specific_name,
        array_agg(
          parameter_row.parameter_name::text
          order by parameter_row.ordinal_position
        ) as input_names
      from information_schema.parameters parameter_row
      where parameter_row.specific_schema = 'api'
        and parameter_row.specific_name like
          'finalize_ai_spend_reservation_%'
        and parameter_row.parameter_mode = 'IN'
      group by parameter_row.specific_name
    ) overload
  ),
  'legacy and cache-aware finalization overloads expose stable target-prefixed billed-token arguments'
);

select ok(
  (
    select count(*) = 2
      and bool_and(output_names = array[
        'reservation_id', 'state', 'reserved_microusd',
        'actual_microusd', 'billed_input_tokens',
        'billed_output_tokens', 'finalized_at', 'replayed'
      ])
    from (
      select
        parameter_row.specific_name,
        array_agg(
          parameter_row.parameter_name::text
          order by parameter_row.ordinal_position
        ) as output_names
      from information_schema.parameters parameter_row
      where parameter_row.specific_schema = 'api'
        and parameter_row.specific_name like
          'finalize_ai_spend_reservation_%'
        and parameter_row.parameter_mode = 'OUT'
      group by parameter_row.specific_name
    ) overload
  ),
  'both finalization overloads return the documented idempotent accounting receipt'
);

select ok(
  obj_description(
    'app_private.ai_spend_reservations'::regclass,
    'pg_class'
  ) like '%no raw student content or provider payloads%'
    and obj_description(
      'app_private.ai_workspace_monthly_budgets'::regclass,
      'pg_class'
    ) like '%USD 100%',
  'catalog comments preserve privacy and conservative-default operator guidance'
);

select ok(
  to_regprocedure('api.get_ai_spend_health(uuid)') is not null
    and to_regprocedure('app_private.get_ai_spend_health(uuid)') is not null
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid = 'api.get_ai_spend_health(uuid)'::regprocedure
    )
    and (
      select routine.prosecdef and routine.provolatile = 's'
      from pg_proc routine
      where routine.oid =
        'app_private.get_ai_spend_health(uuid)'::regprocedure
    ),
  'spend health keeps an invoker API over one stable private definer'
);

select ok(
  has_function_privilege(
    'service_role', 'api.get_ai_spend_health(uuid)', 'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated', 'api.get_ai_spend_health(uuid)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'api.get_ai_spend_health(uuid)', 'EXECUTE'
    )
    and not exists (
      select 1
      from information_schema.parameters parameter_row
      where parameter_row.specific_schema = 'api'
        and parameter_row.specific_name like 'get_ai_spend_health_%'
        and parameter_row.parameter_mode = 'OUT'
        and parameter_row.parameter_name in (
          'job_id', 'entity_id', 'student_id', 'submission_id',
          'assignment_id', 'attempt_id', 'call_key'
        )
    ),
  'health is service-only and exposes no job or student identifiers'
);

select is(
  app_private.ai_spend_cost_microusd(
    10000000, 10000000, 100000000, 100000000
  ),
  2000000000::bigint,
  'maximum accepted token and rate bounds remain within bigint'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'd1200000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated',
    'phase12r-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12R Teacher"}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd1200000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated',
    'phase12r-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12R Student"}'::jsonb,
    now(), now()
  );

do $phase_12r_profile$
begin
  if (
    select count(*)
    from public.profiles profile
    where profile.id in (
      'd1200000-0000-4000-8000-000000000001',
      'd1200000-0000-4000-8000-000000000003'
    )
  ) <> 2 then
    raise exception 'phase_12r_auth_profile_trigger_missing';
  end if;
end;
$phase_12r_profile$;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd1200000-0000-4000-8000-000000000002',
  'Phase 12R Spend Workspace',
  'phase-12r-spend-workspace',
  'd1200000-0000-4000-8000-000000000001'
);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'd1200000-0000-4000-8000-000000000002',
    'd1200000-0000-4000-8000-000000000001',
    'teacher'
  ),
  (
    'd1200000-0000-4000-8000-000000000002',
    'd1200000-0000-4000-8000-000000000003',
    'student'
  );

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode
)
values (
  'd1200000-0000-4000-8000-000000000004',
  'd1200000-0000-4000-8000-000000000002',
  'Phase 12R A2', 'A2', true, 'immediate'
);

insert into public.batch_students (
  id, batch_id, student_id, workspace_id
)
values (
  'd1200000-0000-4000-8000-000000000006',
  'd1200000-0000-4000-8000-000000000004',
  'd1200000-0000-4000-8000-000000000003',
  'd1200000-0000-4000-8000-000000000002'
);

create temporary table phase_12r_spend_state (
  singleton boolean primary key default true check (singleton),
  submission_id uuid,
  job_id uuid
) on commit drop;

insert into phase_12r_spend_state default values;
grant select, update on phase_12r_spend_state
to authenticated, service_role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd1200000-0000-4000-8000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd1200000-0000-4000-8000-000000000003',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'd1200000-0000-4000-8000-000000000004',
    'free_text',
    null,
    'Phase 12R metering fixture.'
  )
)
update pg_temp.phase_12r_spend_state state
set submission_id = submitted.submission_id
from submitted
where state.singleton;

reset role;

update phase_12r_spend_state state
set job_id = job.id
from app_private.async_jobs job
where job.job_kind = 'writing_evaluation'
  and job.entity_id = state.submission_id;

do $phase_12r_job$
begin
  if (select job_id from phase_12r_spend_state) is null then
    raise exception 'phase_12r_spend_job_missing';
  end if;
end;
$phase_12r_job$;

update app_private.async_jobs job
set
  status = 'processing',
  attempt_count = 1,
  worker_id = 'd1200000-0000-4000-8000-000000000005',
  lease_expires_at = now() + interval '5 minutes',
  first_started_at = coalesce(job.first_started_at, now()),
  last_started_at = now(),
  available_at = now()
where job.id = (select job_id from phase_12r_spend_state);

insert into app_private.ai_workspace_monthly_budgets (
  workspace_id, billing_month, monthly_limit_microusd
)
values (
  'd1200000-0000-4000-8000-000000000002',
  date_trunc('month', timezone('UTC', now()))::date,
  1000000
);

create temporary table phase_12r_spend_receipts (
  call_key text primary key,
  reservation_id uuid not null,
  state text not null,
  reserved_microusd bigint not null,
  workspace_remaining_microusd bigint not null,
  global_remaining_microusd bigint not null,
  expires_at timestamptz not null,
  replayed boolean not null
) on commit drop;

grant select, insert, update, delete on phase_12r_spend_receipts
to service_role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $$select *
    from app_private.complete_certified_worksheet_bank_fallback(
      'd1200000-0000-4000-8000-000000000010',
      1,
      'd1200000-0000-4000-8000-000000000005',
      jsonb_build_object(
        'schema_version', 'null'::jsonb,
        'mode', 'certified_bank',
        'template_revision_id',
          'd1200000-0000-4000-8000-000000000011',
        'fallback_reason', 'approved_bank_preferred',
        'rejected_candidates', '[]'::jsonb
      )
    )$$,
  '22023',
  'worksheet_bank_completion_payload_invalid',
  'JSON null cannot bypass the certified-bank schema version'
);

select throws_ok(
  $$select *
    from app_private.complete_certified_worksheet_bank_fallback(
      'd1200000-0000-4000-8000-000000000010',
      1,
      'd1200000-0000-4000-8000-000000000005',
      jsonb_build_object(
        'schema_version', 2,
        'mode', 'certified_bank',
        'template_revision_id',
          'd1200000-0000-4000-8000-000000000011',
        'fallback_reason', 'approved_bank_preferred',
        'rejected_candidates', '[]'::jsonb
      )
    )$$,
  '22023',
  'worksheet_bank_completion_payload_invalid',
  'unsupported certified-bank schema versions fail closed'
);

select throws_ok(
  $$select *
    from app_private.complete_certified_worksheet_bank_fallback(
      'd1200000-0000-4000-8000-000000000010',
      1,
      'd1200000-0000-4000-8000-000000000005',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'certified_bank',
        'template_revision_id',
          'd1200000-0000-4000-8000-000000000011',
        'fallback_reason', 'candidates_rejected',
        'rejected_candidates', jsonb_build_array(jsonb_build_object(
          'attempt_number', 1,
          'provider', 'deepseek',
          'model', 'deepseek-v4-pro',
          'rejection_reasons', jsonb_build_array('critic_rejected'),
          'candidate', jsonb_build_object(
            'schema_version', 'null'::jsonb,
            'mode', 'generated',
            'generation_source', 'deepseek',
            'generator_model', 'deepseek-v4-pro',
            'validation', jsonb_build_object(
              'independent_model', false,
              'rejection_reasons', jsonb_build_array('critic_rejected')
            )
          )
        ))
      )
    )$$,
  '22023',
  'worksheet_bank_rejected_candidate_invalid',
  'JSON null cannot enter immutable rejected-candidate provenance'
);

select throws_ok(
  $$select *
    from app_private.complete_worksheet_answer_with_adjudication_v2(
      'd1200000-0000-4000-8000-000000000020',
      1,
      'd1200000-0000-4000-8000-000000000005',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'evaluated',
        'evaluator_model', 'deepseek-v4-flash',
        'reviews', jsonb_build_array(jsonb_build_object(
          'question_id', 'd1200000-0000-4000-8000-000000000021',
          'evaluator_source', 'deepseek'
        ))
      ),
      jsonb_build_object(
        'schema_version', 2,
        'deepseek_model', 'null'::jsonb,
        'gemini_model', 'gemini-3.1-flash-lite',
        'adjudication_mode', 'agreement',
        'selected_provider_source', 'deepseek',
        'selected_question_sources', jsonb_build_array(jsonb_build_object(
          'question_id', 'd1200000-0000-4000-8000-000000000021',
          'provider_source', 'deepseek'
        )),
        'deepseek_result_sha256', repeat('a', 64),
        'gemini_result_sha256', repeat('b', 64),
        'pro_model', 'null'::jsonb,
        'pro_result_sha256', 'null'::jsonb
      )
    )$$,
  '22023',
  'semantic_adjudication_invalid',
  'JSON null answer-evaluator models fail with the stable contract error'
);

select throws_ok(
  $$select *
    from app_private.complete_worksheet_answer_with_adjudication_v2(
      'd1200000-0000-4000-8000-000000000020',
      1,
      'd1200000-0000-4000-8000-000000000005',
      jsonb_build_object(
        'schema_version', 1,
        'mode', 'evaluated',
        'evaluator_model', 'null'::jsonb,
        'reviews', jsonb_build_array(jsonb_build_object(
          'question_id', 'd1200000-0000-4000-8000-000000000021',
          'evaluator_source', 'system',
          'review_status', 'null'::jsonb,
          'points_awarded', 0,
          'max_points', 1
        ))
      ),
      'null'::jsonb
    )$$,
  '22023',
  'system_blank_review_invalid',
  'JSON null system-review status cannot bypass deterministic scoring rules'
);

reset role;

-- Shared staging may already contain finalized canary spend. Give the fixture
-- deterministic headroom before exercising its workspace-cap assertions; the
-- later global-cap block pins its own exact boundary, and the outer rollback
-- restores the operational policy and audit rows.
update app_private.ai_spend_global_policy
set monthly_limit_microusd = least(
  10000000000::bigint,
  10000000::bigint + coalesce((
    select sum(case
      when entry.state = 'reserved'
        then entry.reserved_microusd
      when entry.state = 'finalized'
        then entry.actual_microusd
      else 0
    end)
    from app_private.ai_spend_accounting_entries() entry
    where entry.billing_month =
      date_trunc('month', timezone('UTC', now()))::date
  ), 0)
)
where singleton;

-- Preserve a pre-retirement reservation as immutable history. The bypass is
-- limited to this single historical seed; every API call below still runs
-- through the production reservation and transition boundaries.
set local session_replication_role = replica;

insert into app_private.ai_spend_reservations (
  id,
  job_id,
  entity_version,
  call_key,
  workspace_id,
  student_id,
  billing_month,
  provider_name,
  model_name,
  call_purpose,
  input_rate_microusd_per_million,
  cached_input_rate_microusd_per_million,
  output_rate_microusd_per_million,
  reserved_microusd,
  expires_at
)
values (
  'd1200000-0000-4000-8000-000000000030',
  (select job_id from pg_temp.phase_12r_spend_state),
  1,
  'main.critic',
  'd1200000-0000-4000-8000-000000000002',
  'd1200000-0000-4000-8000-000000000003',
  date_trunc('month', timezone('UTC', now()))::date,
  'gemini',
  'gemini-2.5-flash',
  'writing_critique',
  300000,
  300000,
  2500000,
  75000,
  now() + interval '15 minutes'
);

set local session_replication_role = origin;

set local role service_role;

insert into pg_temp.phase_12r_spend_receipts
select 'main.critic', receipt.*
from api.reserve_ai_spend(
  (select job_id from pg_temp.phase_12r_spend_state),
  1,
  'main.critic',
  'gemini',
  'gemini-2.5-flash',
  'writing_critique',
  75000,
  900
) receipt;

select is(
  (
    select jsonb_build_array(state, reserved_microusd, replayed)
    from pg_temp.phase_12r_spend_receipts
    where call_key = 'main.critic'
  ),
  '["reserved",75000,true]'::jsonb,
  'an exact historical reservation replay returns its conservative maximum'
);

select is(
  (
    select jsonb_build_array(
      replay.reservation_id = recorded.reservation_id,
      replay.state,
      replay.replayed
    )
    from api.reserve_ai_spend(
      (select job_id from pg_temp.phase_12r_spend_state),
      1,
      'main.critic',
      'gemini',
      'gemini-2.5-flash',
      'writing_critique',
      75000,
      900
    ) replay
    cross join pg_temp.phase_12r_spend_receipts recorded
    where recorded.call_key = 'main.critic'
  ),
  '[true,"reserved",true]'::jsonb,
  'an exact reservation retry reuses the original receipt'
);

select throws_ok(
  $$select * from api.reserve_ai_spend(
    (select job_id from pg_temp.phase_12r_spend_state),
    1,
    'main.critic',
    'deepseek',
    'deepseek-v4-pro',
    'writing_adjudication',
    75000,
    900
  )$$,
  '55000',
  'ai_spend_reservation_conflict',
  'a reused call key cannot change its provider contract'
);

select is(
  (
    select jsonb_build_array(state, actual_microusd, replayed)
    from api.finalize_ai_spend_reservation(
      (
        select reservation_id
        from pg_temp.phase_12r_spend_receipts
        where call_key = 'main.critic'
      ),
      1000,
      1000
    )
  ),
  '["finalized",2800,false]'::jsonb,
  'finalization calculates billed cost from the snapshotted rates'
);

select is(
  (
    select jsonb_build_array(state, actual_microusd, replayed)
    from api.finalize_ai_spend_reservation(
      (
        select reservation_id
        from pg_temp.phase_12r_spend_receipts
        where call_key = 'main.critic'
      ),
      1000,
      1000
    )
  ),
  '["finalized",2800,true]'::jsonb,
  'an exact finalization retry returns the immutable receipt'
);

select throws_ok(
  $$select * from api.finalize_ai_spend_reservation(
    (
      select reservation_id
      from pg_temp.phase_12r_spend_receipts
      where call_key = 'main.critic'
    ),
    1001,
    1000
  )$$,
  '55000',
  'ai_spend_reservation_conflict',
  'a finalized receipt rejects different token totals'
);

insert into pg_temp.phase_12r_spend_receipts
select 'main.release', receipt.*
from api.reserve_ai_spend(
  (select job_id from pg_temp.phase_12r_spend_state),
  1,
  'main.release',
  'deepseek',
  'deepseek-v4-flash',
  'writing_generation',
  75000,
  900
) receipt;

select is(
  (
    select jsonb_build_array(state, replayed)
    from api.release_ai_spend_reservation(
      (
        select reservation_id
        from pg_temp.phase_12r_spend_receipts
        where call_key = 'main.release'
      ),
      'provider_not_called'
    )
  ),
  '["released",false]'::jsonb,
  'an unbilled provider call releases its reservation'
);

select is(
  (
    select jsonb_build_array(state, replayed)
    from api.release_ai_spend_reservation(
      (
        select reservation_id
        from pg_temp.phase_12r_spend_receipts
        where call_key = 'main.release'
      ),
      'provider_not_called'
    )
  ),
  '["released",true]'::jsonb,
  'an exact release retry returns the immutable receipt'
);

select throws_ok(
  $$select * from api.release_ai_spend_reservation(
    (
      select reservation_id
      from pg_temp.phase_12r_spend_receipts
      where call_key = 'main.release'
    ),
    'superseded'
  )$$,
  '55000',
  'ai_spend_reservation_conflict',
  'a released receipt rejects a different release reason'
);

select throws_ok(
  $$select * from api.finalize_ai_spend_reservation(
    (
      select reservation_id
      from pg_temp.phase_12r_spend_receipts
      where call_key = 'main.critic'
    ),
    9223372036854775807::bigint,
    0
  )$$,
  '22023',
  'ai_spend_contract_invalid',
  'token totals outside the bounded metering contract fail safely'
);

insert into pg_temp.phase_12r_spend_receipts
select 'workspace.cap.1', receipt.*
from api.reserve_ai_spend(
  (select job_id from pg_temp.phase_12r_spend_state), 1,
  'workspace.cap.1', 'gemini', 'gemini-3.1-flash-lite',
  'writing_generation', 300000, 900
) receipt;

insert into pg_temp.phase_12r_spend_receipts
select 'workspace.cap.2', receipt.*
from api.reserve_ai_spend(
  (select job_id from pg_temp.phase_12r_spend_state), 1,
  'workspace.cap.2', 'gemini', 'gemini-3.1-flash-lite',
  'writing_generation', 300000, 900
) receipt;

insert into pg_temp.phase_12r_spend_receipts
select 'workspace.cap.3', receipt.*
from api.reserve_ai_spend(
  (select job_id from pg_temp.phase_12r_spend_state), 1,
  'workspace.cap.3', 'gemini', 'gemini-3.1-flash-lite',
  'writing_generation', 300000, 900
) receipt;

select throws_ok(
  $$select * from api.reserve_ai_spend(
    (select job_id from pg_temp.phase_12r_spend_state), 1,
    'workspace.cap.4', 'gemini', 'gemini-3.1-flash-lite',
    'writing_generation', 300000, 900
  )$$,
  '53000',
  'ai_spend_workspace_budget_exceeded',
  'workspace reservations cannot cross the audited monthly hard cap'
);

do $phase_12r_release_workspace$
declare
  reserved_row record;
begin
  for reserved_row in
    select reservation_id
    from pg_temp.phase_12r_spend_receipts
    where call_key like 'workspace.cap.%'
  loop
    perform 1
    from api.release_ai_spend_reservation(
      reserved_row.reservation_id,
      'superseded'
    );
  end loop;
end;
$phase_12r_release_workspace$;

reset role;

update app_private.ai_workspace_monthly_budgets
set monthly_limit_microusd = 10000000
where workspace_id = 'd1200000-0000-4000-8000-000000000002'
  and billing_month = date_trunc('month', timezone('UTC', now()))::date;

update app_private.ai_spend_global_policy
set monthly_limit_microusd = 1000000 + coalesce((
  select sum(case
    when entry.state = 'reserved'
      then entry.reserved_microusd
    when entry.state = 'finalized'
      then entry.actual_microusd
    else 0
  end)
  from app_private.ai_spend_accounting_entries() entry
  where entry.billing_month =
    date_trunc('month', timezone('UTC', now()))::date
), 0)
where singleton;

set local role service_role;

insert into pg_temp.phase_12r_spend_receipts
select 'global.cap.1', receipt.*
from api.reserve_ai_spend(
  (select job_id from pg_temp.phase_12r_spend_state), 1,
  'global.cap.1', 'gemini', 'gemini-3.1-flash-lite',
  'writing_generation', 300000, 900
) receipt;

insert into pg_temp.phase_12r_spend_receipts
select 'global.cap.2', receipt.*
from api.reserve_ai_spend(
  (select job_id from pg_temp.phase_12r_spend_state), 1,
  'global.cap.2', 'gemini', 'gemini-3.1-flash-lite',
  'writing_generation', 300000, 900
) receipt;

insert into pg_temp.phase_12r_spend_receipts
select 'global.cap.3', receipt.*
from api.reserve_ai_spend(
  (select job_id from pg_temp.phase_12r_spend_state), 1,
  'global.cap.3', 'gemini', 'gemini-3.1-flash-lite',
  'writing_generation', 300000, 900
) receipt;

select throws_ok(
  $$select * from api.reserve_ai_spend(
    (select job_id from pg_temp.phase_12r_spend_state), 1,
    'global.cap.4', 'gemini', 'gemini-3.1-flash-lite',
    'writing_generation', 300000, 900
  )$$,
  '53000',
  'ai_spend_global_budget_exceeded',
  'global reservations cannot cross the singleton monthly hard cap'
);

reset role;

update app_private.ai_spend_global_policy
set monthly_limit_microusd = 225000000
where singleton;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select ok(
  (
    select count(*) = 1
      and bool_and(workspace_id is null)
      and bool_and(global_monthly_limit_microusd = 225000000)
      and bool_and(jsonb_typeof(provider_model_purpose_totals) = 'array')
    from api.get_ai_spend_health(null::uuid)
  ),
  'global health returns one content-free aggregate without a workspace id'
);

reset role;

select * from finish();
rollback;
