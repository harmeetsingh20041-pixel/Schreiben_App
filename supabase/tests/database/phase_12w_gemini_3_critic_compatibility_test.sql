begin;

select plan(22);

create or replace function pg_temp.phase_12w_worksheet(
  gemini_model text
)
returns jsonb
language plpgsql
as $$
declare
  candidate jsonb := jsonb_build_object(
    'schema_version', 1,
    'mode', 'generated',
    'generation_source', 'deepseek',
    'generator_model', 'deepseek-v4-pro',
    'title', 'A1 critic compatibility probe',
    'questions', jsonb_build_array(jsonb_build_object('n', 1, 'ok', true)),
    'source_mix', jsonb_build_object(
      'mode', 'deepseek',
      'deepseek_count', 1,
      'gemini_count', 0
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
    'model', gemini_model,
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

select has_function(
  'app_private',
  'enforce_current_writing_critic_insert',
  array[]::text[],
  'the current writing-critic insert gate exists'
);

select has_function(
  'app_private',
  'enforce_current_worksheet_critic_insert',
  array[]::text[],
  'the current worksheet-critic insert gate exists'
);

select lives_ok(
  $$select app_private.assert_worksheet_critics_v2(
    pg_temp.phase_12w_worksheet('gemini-3.5-flash')
  )$$,
  'historical Gemini 3.5 worksheet critic evidence remains replay-valid'
);

select lives_ok(
  $$select app_private.assert_worksheet_critics_v2(
    pg_temp.phase_12w_worksheet('gemini-2.5-flash')
  )$$,
  'historical Gemini 2.5 worksheet evidence remains replay-valid'
);

select throws_ok(
  $$select app_private.assert_worksheet_critics_v2(
    pg_temp.phase_12w_worksheet('gemini-3.4-flash')
  )$$,
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'an unapproved Gemini critic model fails closed'
);

select is(
  (
    select jsonb_agg(jsonb_build_array(
      call_purpose,
      input_rate_microusd_per_million,
      output_rate_microusd_per_million,
      maximum_reservation_microusd
    ) order by call_purpose)
    from app_private.ai_model_cost_policies policy
    where policy.provider_name = 'gemini'
      and policy.model_name = 'gemini-3.5-flash'
      and policy.call_purpose in ('writing_critique', 'worksheet_critique')
  ),
  '[["worksheet_critique",1500000,9000000,150000],
    ["writing_critique",1500000,9000000,150000]]'::jsonb,
  'both historical Gemini 3.5 critic policies remain exact'
);

select is(
  (
    select count(*)
    from app_private.ai_model_cost_policies policy
    where policy.provider_name = 'gemini'
      and policy.model_name = 'gemini-2.5-flash'
      and policy.call_purpose in ('writing_critique', 'worksheet_critique')
  ),
  2::bigint,
  'historical cost-policy evidence remains append-only'
);

select is(
  obj_description('app_private.ai_spend_global_policy'::regclass, 'pg_class'),
  'Singleton USD 225 monthly hard cap and emergency stop. No browser or service role may mutate it directly.',
  'the operator-facing hard-cap comment matches the live USD 225 policy'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_record
    where trigger_record.tgrelid =
      'app_private.writing_feedback_adjudications_v2'::regclass
      and trigger_record.tgname =
        'writing_feedback_adjudications_v2_current_critic'
      and trigger_record.tgenabled = 'O'
  ),
  'the live writing-evidence table enforces its current critic on insert'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_record
    where trigger_record.tgrelid =
      'app_private.worksheet_generation_completions_v2'::regclass
      and trigger_record.tgname =
        'worksheet_generation_completions_v2_current_critic'
      and trigger_record.tgenabled = 'O'
  ),
  'the live worksheet-evidence table enforces its current critic on insert'
);

create temporary table phase_12w_writing_trigger_probe (
  generator_provider text,
  generator_model text,
  critic_provider text,
  critic_model text,
  final_critic_provider text,
  final_critic_model text,
  accepted_provider text,
  accepted_model text
);
create trigger phase_12w_writing_trigger_probe_gate
before insert on phase_12w_writing_trigger_probe
for each row execute function
  app_private.enforce_current_writing_critic_insert();

select lives_ok(
  $$insert into phase_12w_writing_trigger_probe (
      critic_provider, critic_model
    ) values ('gemini', 'gemini-3.1-flash-lite')$$,
  'new Gemini Flash Lite writing evidence passes the live insert gate'
);

select throws_ok(
  $$insert into phase_12w_writing_trigger_probe (
      critic_provider, critic_model
    ) values ('gemini', 'gemini-2.5-flash')$$,
  '22023',
  'writing_adjudication_critic_model_retired',
  'new Gemini 2.5 writing evidence is rejected'
);

select lives_ok(
  $$insert into phase_12w_writing_trigger_probe (
      critic_provider, critic_model
    ) values ('deepseek', 'deepseek-v4-pro')$$,
  'DeepSeek cross-provider recovery evidence is unaffected'
);

create temporary table phase_12w_worksheet_trigger_probe (
  completion_mode text,
  provider_source text,
  generator_model text,
  secondary_critic_model text
);
create trigger phase_12w_worksheet_trigger_probe_gate
before insert on phase_12w_worksheet_trigger_probe
for each row execute function
  app_private.enforce_current_worksheet_critic_insert();

select lives_ok(
  $$insert into phase_12w_worksheet_trigger_probe values (
    'generated', 'gemini', 'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite'
  )$$,
  'new Gemini Flash Lite worksheet evidence passes the live insert gate'
);

select throws_ok(
  $$insert into phase_12w_worksheet_trigger_probe values (
    'generated', 'deepseek', 'deepseek-v4-pro', 'gemini-2.5-flash'
  )$$,
  '22023',
  'worksheet_secondary_critic_model_retired',
  'new Gemini 2.5 worksheet evidence is rejected'
);

select lives_ok(
  $$insert into phase_12w_worksheet_trigger_probe values
    ('reuse', null, null, null)$$,
  'provider-free worksheet reuse remains unaffected'
);

select throws_ok(
  $$insert into app_private.ai_model_cost_policies (
    provider_name,
    model_name,
    call_purpose,
    input_rate_microusd_per_million,
    output_rate_microusd_per_million,
    maximum_reservation_microusd
  ) values (
    'gemini', 'gemini-unapproved', 'writing_critique', 1, 1, 1
  )$$,
  '55000',
  'ai_spend_evidence_immutable',
  'cost-policy evidence remains immutable after the migration'
);

select ok(
  not has_function_privilege(
    'anon',
    'app_private.enforce_current_writing_critic_insert()',
    'execute'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.enforce_current_writing_critic_insert()',
      'execute'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.enforce_current_writing_critic_insert()',
      'execute'
    ),
  'the writing insert-gate helper has no direct API grant'
);

select ok(
  not has_function_privilege(
    'anon',
    'app_private.enforce_current_worksheet_critic_insert()',
    'execute'
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.enforce_current_worksheet_critic_insert()',
      'execute'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.enforce_current_worksheet_critic_insert()',
      'execute'
    ),
  'the worksheet insert-gate helper has no direct API grant'
);

select ok(
  (
    select pg_get_constraintdef(constraint_record.oid)
      like '%gemini-2.5-flash%'
      and pg_get_constraintdef(constraint_record.oid)
        like '%gemini-3.5-flash%'
    from pg_constraint constraint_record
    where constraint_record.conrelid =
      'app_private.writing_feedback_adjudications_v2'::regclass
      and constraint_record.conname =
        'writing_feedback_adjudications_v2_critic_shape_check'
  ),
  'the writing table preserves both exact historical and current provenance'
);

select ok(
  (
    select pg_get_constraintdef(constraint_record.oid)
      like '%gemini-2.5-flash%'
      and pg_get_constraintdef(constraint_record.oid)
        like '%gemini-3.5-flash%'
    from pg_constraint constraint_record
    where constraint_record.conrelid =
      'app_private.worksheet_generation_completions_v2'::regclass
      and constraint_record.conname =
        'worksheet_generation_completions_v2_shape_check'
  ),
  'the worksheet table preserves both exact historical and current provenance'
);

select is(
  (
    select count(*)
    from app_private.ai_model_cost_policies policy
    where policy.provider_name = 'gemini'
      and policy.model_name = 'gemini-3.4-flash'
  ),
  0::bigint,
  'no unreviewed Gemini model has a spend policy'
);

select * from finish();
rollback;
