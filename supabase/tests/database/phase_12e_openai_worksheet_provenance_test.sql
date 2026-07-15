-- ISOLATED/DISPOSABLE DATABASE ONLY.
-- This full fixture calls claim_async_jobs(..., batch_size => 1), so it can
-- claim an unrelated queue message on shared staging. Use the separate
-- phase_12e_openai_worksheet_provenance_shared_probe.sql for shared-staging
-- catalog/normalizer verification, then prove the completion path with a
-- specifically created staging assignment through the real API/UI flow.
begin;

select plan(50);

create temporary table phase_12e_payloads (
  name text primary key,
  payload jsonb not null
) on commit drop;

create or replace function pg_temp.phase_12e_dualize_payload(
  source_payload jsonb
)
returns jsonb
language plpgsql
as $$
declare
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
  openai_critic jsonb;
  attempt_count integer := coalesce(
    nullif(source_payload #>> '{validation,attempt_count}', '')::integer,
    1
  );
begin
  candidate_sha256 := app_private.worksheet_candidate_sha256(source_payload);
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
  openai_critic := jsonb_build_object(
    'provider', 'openai',
    'model', 'gpt-5.4-2026-03-05',
    'candidate_sha256', candidate_sha256,
    'approved', true,
    'checks', checks,
    'content_checks', content_checks,
    'rejection_reasons', '[]'::jsonb
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
      'independent_model', true,
      'critic_model', 'deepseek-v4-flash',
      'candidate_sha256', candidate_sha256,
      'critics', jsonb_build_object(
        'deepseek', deepseek_critic,
        'openai', openai_critic
      ),
      'attempt_count', attempt_count,
      'checks', checks,
      'rejection_reasons', '[]'::jsonb
    )
  );
end;
$$;

-- New worksheet generations use the Phase 12R v2 evidence contract. The
-- helper above deliberately preserves the historical OpenAI aggregate shape
-- and fallback_count contract, while each sealed critic verdict carries the
-- content attestations now required by the shared verdict validator.
create or replace function pg_temp.phase_12e_v2_dualize_payload(
  source_payload jsonb
)
returns jsonb
language plpgsql
as $$
declare
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
  attempt_count integer := coalesce(
    nullif(source_payload #>> '{validation,attempt_count}', '')::integer,
    1
  );
begin
  candidate_sha256 := app_private.worksheet_candidate_sha256(source_payload);
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
    'model', 'gemini-3.1-flash-lite',
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
    source_payload,
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
      'attempt_count', attempt_count,
      'checks', checks,
      'content_checks', content_checks,
      'rejection_reasons', '[]'::jsonb
    )
  );
end;
$$;

insert into phase_12e_payloads (name, payload)
values
  (
    'deepseek',
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
  ),
  (
    'openai',
    jsonb_build_object(
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
      ),
      'validation', jsonb_build_object(
        'deterministic', true,
        'independent_model', true,
        'critic_model', 'gpt-5.4-2026-03-05'
      )
    )
  );

update phase_12e_payloads
set payload = pg_temp.phase_12e_dualize_payload(payload);

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
  'provenance normalization is immutable, invoker-safe, and path-pinned'
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
  'only the worksheet worker service can normalize provider provenance'
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
      'service_role',
      'app_private.worksheet_generation_completions',
      'INSERT'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.worksheet_generation_completions',
      'UPDATE'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.worksheet_generation_completions',
      'DELETE'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.worksheet_generation_completions',
      'SELECT'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.worksheet_generation_completions',
      'INSERT'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.worksheet_generation_completions',
      'UPDATE'
    )
    and not has_table_privilege(
      'authenticated',
      'app_private.worksheet_generation_completions',
      'DELETE'
    )
    and (
      select count(*) = 2
      from pg_constraint constraint_row
      where constraint_row.conrelid =
          'app_private.worksheet_generation_completions'::regclass
        and constraint_row.contype = 'f'
        and constraint_row.confdeltype = 'r'
    ),
  'completion fingerprints are private, RLS-enabled, and cannot cascade away'
);

select ok(
  to_regprocedure(
    'app_private.worksheet_generation_payload_sha256(jsonb)'
  ) is not null
    and to_regprocedure(
      'app_private.lock_worksheet_generation_completion(uuid)'
    ) is not null
    and to_regprocedure(
      'app_private.assert_or_record_worksheet_generation_completion(uuid,uuid,jsonb,boolean)'
    ) is not null
    and exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid =
          'app_private.worksheet_generation_completions'::regclass
        and trigger_row.tgname = 'worksheet_generation_completions_immutable'
        and not trigger_row.tgisinternal
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
  'service-only hash ledger helpers and immutable trigger are installed'
);

select is(
  app_private.worksheet_generation_payload_sha256(
    '{"schema_version":1,"mode":"generated"}'::jsonb
  ),
  app_private.worksheet_generation_payload_sha256(
    '{"mode":"generated","schema_version":1}'::jsonb
  ),
  'database payload hash is canonical across JSON object key order'
);

select is(
  (
    select normalized.legacy_worksheet
    from app_private.normalize_worksheet_generation_provenance(
      (select payload from phase_12e_payloads where name = 'deepseek')
    ) normalized
  ),
  (select payload from phase_12e_payloads where name = 'deepseek'),
  'pinned DeepSeek provenance passes through unchanged'
);

select is(
  (
    select normalized.provider_source
    from app_private.normalize_worksheet_generation_provenance(
      (select payload from phase_12e_payloads where name = 'openai')
    ) normalized
  ),
  'openai',
  'pinned OpenAI generation retains its actual provider source'
);

select ok(
  (
    select normalized.legacy_worksheet ->> 'generation_source' = 'deepseek'
      and normalized.legacy_worksheet ->> 'generator_model' =
        'gpt-5.4-mini-2026-03-17'
      and normalized.legacy_worksheet #>> '{source_mix,mode}' = 'deepseek'
      and normalized.legacy_worksheet #>> '{source_mix,deepseek_count}' = '8'
      and normalized.legacy_worksheet #>> '{source_mix,fallback_count}' = '0'
    from app_private.normalize_worksheet_generation_provenance(
      (select payload from phase_12e_payloads where name = 'openai')
    ) normalized
  ),
  'OpenAI payload receives only a transaction-local legacy envelope'
);

select ok(
  (
    select normalized.provider_metadata #>> '{source_mix,mode}' = 'openai'
      and normalized.provider_metadata #>> '{source_mix,deepseek_count}' = '0'
      and normalized.provider_metadata #>> '{source_mix,fallback_count}' = '8'
      and normalized.provider_metadata #>> '{validation,critic_model}' =
        'deepseek-v4-flash'
      and normalized.provider_metadata
        #>> '{validation,critics,openai,model}' = 'gpt-5.4-2026-03-05'
      and normalized.provider_metadata
        #> '{validation,critics,deepseek,content_checks}' =
          jsonb_build_object(
            'mini_lesson_scope_accurate', true,
            'learner_cues_semantically_aligned', true,
            'examples_rubrics_consistent', true
          )
      and normalized.provider_metadata
        #> '{validation,critics,openai,content_checks}' =
          jsonb_build_object(
            'mini_lesson_scope_accurate', true,
            'learner_cues_semantically_aligned', true,
            'examples_rubrics_consistent', true
          )
    from app_private.normalize_worksheet_generation_provenance(
      (select payload from phase_12e_payloads where name = 'openai')
    ) normalized
  ),
  'original OpenAI generator and critic provenance is preserved for persistence'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12e_payloads where name = 'openai'),
        '{generator_model}',
        '"gpt-5.4-mini"'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_candidate_hash_mismatch',
  'an unpinned OpenAI generator alias is rejected before completion'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12e_payloads where name = 'openai'),
        '{source_mix,fallback_count}',
        '7'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_candidate_hash_mismatch',
  'OpenAI question provenance counts cannot be understated'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12e_payloads where name = 'openai'),
        '{source_mix,spoofed_provider}',
        '"deepseek"'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_candidate_hash_mismatch',
  'extra source metadata cannot smuggle a contradictory provider'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12e_payloads where name = 'deepseek'),
        '{generator_model}',
        '"gpt-5.4-mini-2026-03-17"'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_candidate_hash_mismatch',
  'an OpenAI model cannot be mislabeled as DeepSeek generation'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance(
      jsonb_set(
        (select payload from pg_temp.phase_12e_payloads where name = 'openai'),
        '{validation,critic_model}',
        '"gpt-5.4"'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_dual_critic_validation_invalid',
  'an unpinned critic alias is rejected'
);

select is(
  (
    select normalized.legacy_worksheet
    from app_private.normalize_worksheet_generation_provenance(
      '{"schema_version":1,"mode":"reuse","reusable_practice_test_id":"11111111-1111-4111-8111-111111111111"}'::jsonb
    ) normalized
  ),
  '{"schema_version":1,"mode":"reuse","reusable_practice_test_id":"11111111-1111-4111-8111-111111111111"}'::jsonb,
  'reuse completions retain the established idempotent path unchanged'
);

select throws_ok(
  $$
    select *
    from app_private.normalize_worksheet_generation_provenance('[]'::jsonb)
  $$,
  '22023',
  'Worksheet completion payload is invalid.',
  'non-object completion payloads fail before any public mutation'
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
      and position('generation_metadata = normalized.provider_metadata' in routine.prosrc) > 0
    from pg_proc routine
    where routine.oid =
      'app_private.complete_worksheet_generation_phase_12r(uuid,bigint,uuid,jsonb)'::regprocedure
  ),
  'private adapter validates current evidence or exact legacy replay before immutable completion'
);

select ok(
  exists (
    select 1
    from pg_proc routine
    where routine.oid =
      'public.complete_worksheet_generation(uuid,bigint,uuid,jsonb)'::regprocedure
      and position('selected_job.status = ''succeeded''' in routine.prosrc) > 0
  ),
  'legacy transactional completion keeps its succeeded redelivery branch'
);

-- Full transactional completion fixture. Every mutation is enclosed by this
-- file's outer transaction and is rolled back at the end.
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'd1111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase12e-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12E Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd2222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase12e-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12E Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd3333333-3333-4333-8333-333333333333',
  'Phase 12E Workspace',
  'phase-12e-openai-provenance',
  'd1111111-1111-4111-8111-111111111111'
);

select set_config(
  'request.jwt.claim.sub',
  'd1111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);
insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'd3333333-3333-4333-8333-333333333333',
    'd1111111-1111-4111-8111-111111111111',
    'owner'
  ),
  (
    'd3333333-3333-4333-8333-333333333333',
    'd2222222-2222-4222-8222-222222222222',
    'student'
  );
select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by
)
values (
  'd3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'd3333333-3333-4333-8333-333333333333',
  'Phase 12E A1 Class',
  'A1',
  true,
  'd1111111-1111-4111-8111-111111111111'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  'd3333333-3333-4333-8333-333333333333',
  'd3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'd2222222-2222-4222-8222-222222222222'
);

insert into public.grammar_topics (id, slug, name, level, description)
values
  (
    'd4444444-4444-4444-8444-444444444444',
    'phase-12e-akkusativ',
    'Phase 12E Akkusativ',
    'A1',
    'Transactional OpenAI worksheet provenance test topic.'
  ),
  (
    'd4444444-4444-4444-8444-444444444445',
    'phase-12e-deepseek-akkusativ',
    'Phase 12E DeepSeek Akkusativ',
    'A1',
    'Transactional DeepSeek replay-mismatch test topic.'
  );

-- Seed only the immutable adaptive-cycle snapshots that this transactional
-- provenance fixture needs. Assignment and worker mutations below continue to
-- run with all production triggers enabled.
set local session_replication_role = replica;

insert into app_private.practice_resolution_cycles (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  cycle_number,
  state,
  state_reason,
  evidence_start_sequence,
  evidence_through_sequence,
  minor_issue_count,
  major_issue_count,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity
)
values
  (
    'd4c11111-1111-4111-8111-111111111111',
    'd3333333-3333-4333-8333-333333333333',
    'd2222222-2222-4222-8222-222222222222',
    'd4444444-4444-4444-8444-444444444444',
    1,
    'unlocked',
    'weakness_threshold_reached',
    1,
    0,
    0,
    0,
    'd3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified'
  ),
  (
    'd4c22222-2222-4222-8222-222222222222',
    'd3333333-3333-4333-8333-333333333333',
    'd2222222-2222-4222-8222-222222222222',
    'd4444444-4444-4444-8444-444444444445',
    1,
    'unlocked',
    'weakness_threshold_reached',
    1,
    0,
    0,
    0,
    'd3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified'
  );

set local session_replication_role = origin;

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity,
  resolution_cycle_id,
  resolution_cycle_number,
  evidence_cutoff_sequence,
  source,
  status,
  assigned_by,
  generation_status
)
values
  (
    'd5555555-5555-4555-8555-555555555555',
    'd3333333-3333-4333-8333-333333333333',
    'd2222222-2222-4222-8222-222222222222',
    'd4444444-4444-4444-8444-444444444444',
    null,
    'd3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'd4c11111-1111-4111-8111-111111111111',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'd1111111-1111-4111-8111-111111111111',
    'idle'
  ),
  (
    'd5555555-5555-4555-8555-555555555556',
    'd3333333-3333-4333-8333-333333333333',
    'd2222222-2222-4222-8222-222222222222',
    'd4444444-4444-4444-8444-444444444445',
    null,
    'd3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A1',
    1,
    'teacher_verified',
    'd4c22222-2222-4222-8222-222222222222',
    1,
    0,
    'weakness_auto',
    'unlocked',
    'd1111111-1111-4111-8111-111111111111',
    'idle'
  );

update app_private.practice_resolution_cycles cycle
set
  active_assignment_id = fixture.assignment_id,
  evidence_frozen_at = now(),
  state_reason = 'worksheet_ready'
from (
  values
    (
      'd4c11111-1111-4111-8111-111111111111'::uuid,
      'd5555555-5555-4555-8555-555555555555'::uuid
    ),
    (
      'd4c22222-2222-4222-8222-222222222222'::uuid,
      'd5555555-5555-4555-8555-555555555556'::uuid
    )
) as fixture(cycle_id, assignment_id)
where cycle.id = fixture.cycle_id;

create temporary table phase_12e_state (
  singleton boolean primary key default true check (singleton),
  job_id uuid,
  message_id bigint,
  response_assignment_id uuid,
  response_test_id uuid,
  response_generation_status text,
  response_quality_status text,
  deepseek_job_id uuid,
  deepseek_message_id bigint,
  deepseek_test_id uuid
) on commit drop;

insert into phase_12e_state default values;
grant select, update on table phase_12e_state to authenticated, service_role;

insert into phase_12e_payloads (name, payload)
select
  'gemini_full',
  jsonb_build_object(
    'schema_version', 1,
    'mode', 'generated',
    'generation_source', 'gemini',
    'level', 'A1',
    'difficulty', 'easy',
    'title', 'Akkusativ mit sicheren Antworten',
    'description', 'A validated eight-question A1 Akkusativ worksheet.',
    'generator_model', 'gemini-3.1-flash-lite',
    'mini_lesson', jsonb_build_object(
      'short_explanation', 'Der Akkusativ markiert oft das direkte Objekt.',
      'key_rule', 'Das männliche direkte Objekt verwendet häufig den oder einen.',
      'correct_examples', jsonb_build_array('Ich sehe den Hund.'),
      'common_mistake_warning', 'Verwechsle den Akkusativ nicht mit dem Dativ.',
      'what_to_revise', 'Wiederhole bestimmte und unbestimmte Artikel.'
    ),
    'questions', (
      select jsonb_agg(
        case
          when question_number <= 3 then jsonb_build_object(
            'question_number', question_number,
            'question_type', 'multiple_choice',
            'evaluation_mode', 'local_exact',
            'prompt', format(
              'Welche Form passt in Aufgabe %s als direktes Objekt?',
              question_number
            ),
            'options', jsonb_build_array('den', 'dem', 'der'),
            'correct_answer', 'den',
            'accepted_answers', jsonb_build_array('den'),
            'rubric', null,
            'explanation', 'Das männliche direkte Objekt steht im Akkusativ.'
          )
          when question_number <= 7 then jsonb_build_object(
            'question_number', question_number,
            'question_type', 'fill_blank',
            'evaluation_mode', 'local_exact',
            'prompt', format(
              'Ergänze in Aufgabe %s mit dem bestimmten Artikel: Ich sehe ___ Hund.',
              question_number
            ),
            'options', '[]'::jsonb,
            'correct_answer', 'den',
            'accepted_answers', jsonb_build_array('den'),
            'rubric', null,
            'explanation', 'Der bestimmte männliche Akkusativartikel lautet den.'
          )
          else jsonb_build_object(
            'question_number', question_number,
            'question_type', 'sentence_correction',
            'evaluation_mode', 'open_evaluation',
            'prompt', 'Korrigiere vollständig: Ich sehen den Hund jeden Tag.',
            'options', '[]'::jsonb,
            'correct_answer', 'Ich sehe den Hund jeden Tag.',
            'accepted_answers', '[]'::jsonb,
            'rubric', jsonb_build_object(
              'criteria', jsonb_build_array(
                'Conjugate sehen for ich and preserve the sentence meaning.'
              ),
              'sample_answer', 'Ich sehe den Hund jeden Tag.'
            ),
            'explanation', 'Das Verb sehen muss zur ersten Person Singular passen.'
          )
        end
        order by question_number
      )
      from generate_series(1, 8) question_number
    ),
    'source_mix', jsonb_build_object(
      'mode', 'gemini',
      'deepseek_count', 0,
      'gemini_count', 8
    ),
    'validation', jsonb_build_object(
      'deterministic', true,
      'independent_model', true,
      'critic_model', 'deepseek-v4-flash',
      'attempt_count', 2,
      'checks', jsonb_build_object(
        'ambiguity_free', true,
        'no_answer_leakage', true,
        'duplicate_free', true,
        'level_fit', true,
        'topic_fit', true,
        'type_balance', true,
        'scoring_safe', true
      ),
      'rejection_reasons', '[]'::jsonb
    )
  );

insert into phase_12e_payloads (name, payload)
select
  'deepseek_full',
  payload || jsonb_build_object(
    'generation_source', 'deepseek',
    'generator_model', 'deepseek-v4-pro',
    'source_mix', jsonb_build_object(
      'mode', 'deepseek',
      'deepseek_count', 8,
      'gemini_count', 0
    ),
    'validation', (payload -> 'validation') || jsonb_build_object(
      'critic_model', 'deepseek-v4-flash',
      'attempt_count', 1
    )
  )
from phase_12e_payloads
where name = 'gemini_full';

update phase_12e_payloads
set payload = pg_temp.phase_12e_v2_dualize_payload(payload)
where name in ('gemini_full', 'deepseek_full');

grant select on table phase_12e_payloads to service_role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd2222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd2222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    'd5555555-5555-4555-8555-555555555555'
  )
)
update pg_temp.phase_12e_state state
set job_id = requested.job_id
from requested
where state.singleton;

reset role;
update phase_12e_state state
set message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.job_id;

select ok(
  (select job_id is not null and message_id is not null from phase_12e_state),
  'student request creates one durable Gemini-capable generation job'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'worksheet_generation',
    'd6666666-6666-4666-8666-666666666666',
    1,
    225
  )
)
update pg_temp.phase_12e_state state
set job_id = claimed.job_id,
    message_id = claimed.queue_message_id
from claimed
where state.singleton;

reset role;
select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.id = (select job_id from phase_12e_state)
      and job.entity_id = 'd5555555-5555-4555-8555-555555555555'
      and job.status = 'processing'
      and assignment.generation_status = 'generating'
  ),
  'service worker claims the exact generation job before completion'
);

set local role service_role;
select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_12e_state),
      (select message_id from pg_temp.phase_12e_state),
      'd6666666-6666-4666-8666-666666666666',
      jsonb_set(
        (select payload from pg_temp.phase_12e_payloads where name = 'gemini_full'),
        '{generator_model}',
        '"gemini-3.1-flash-lite-latest"'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_candidate_hash_mismatch',
  'spoofed Gemini provenance is rejected before transactional completion'
);
reset role;

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.id = (select job_id from phase_12e_state)
      and job.status = 'processing'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'generating'
      and exists (
        select 1
        from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
      and not exists (
        select 1
        from public.practice_tests test
        where test.generation_job_id = job.id
      )
      and not exists (
        select 1
        from app_private.worksheet_generation_completions_v2 completion
        where completion.job_id = job.id
      )
  ),
  'spoof rejection leaves job, assignment, queue, and worksheet rows unchanged'
);

set local role service_role;
select lives_ok(
  $test$
    do $body$
    begin
      begin
        perform *
        from api.complete_worksheet_generation(
          (select job_id from pg_temp.phase_12e_state),
          (select message_id from pg_temp.phase_12e_state),
          'd6666666-6666-4666-8666-666666666666',
          (select payload from pg_temp.phase_12e_payloads where name = 'gemini_full')
        );
        if not exists (
          select 1
          from public.practice_tests test
          where test.generation_job_id = (select job_id from pg_temp.phase_12e_state)
            and test.generation_source = 'gemini'
            and test.generator_model = 'gemini-3.1-flash-lite'
            and test.generation_metadata #>> '{source_mix,mode}' = 'gemini'
        ) then
          raise exception 'phase12e_gemini_provenance_not_restored';
        end if;
        raise exception 'phase12e_forced_rollback';
      exception when raise_exception then
        if sqlerrm <> 'phase12e_forced_rollback' then
          raise;
        end if;
      end;
    end;
    $body$
  $test$,
  'valid Gemini completion restores truthful provenance inside one transaction'
);
reset role;

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join public.student_practice_assignments assignment
      on assignment.id = job.entity_id
    where job.id = (select job_id from phase_12e_state)
      and job.status = 'processing'
      and assignment.practice_test_id is null
      and assignment.generation_status = 'generating'
      and exists (
        select 1
        from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
      and not exists (
        select 1
        from public.practice_tests test
        where test.generation_job_id = job.id
      )
      and not exists (
        select 1
        from app_private.worksheet_generation_completions_v2 completion
        where completion.job_id = job.id
      )
  ),
  'forced rollback removes every Gemini completion-side mutation and archive'
);

set local role service_role;
select lives_ok(
  $$
    with completed as (
      select *
      from api.complete_worksheet_generation(
        (select job_id from pg_temp.phase_12e_state),
        (select message_id from pg_temp.phase_12e_state),
        'd6666666-6666-4666-8666-666666666666',
        (select payload from pg_temp.phase_12e_payloads where name = 'gemini_full')
      )
    )
    update pg_temp.phase_12e_state state
    set response_assignment_id = completed.assignment_id,
        response_test_id = completed.practice_test_id,
        response_generation_status = completed.generation_status,
        response_quality_status = completed.quality_status
    from completed
    where state.singleton
  $$,
  'valid Gemini payload completes through the current api worker contract'
);
reset role;

select ok(
  (
    select response_assignment_id = 'd5555555-5555-4555-8555-555555555555'
      and response_test_id is not null
      and response_generation_status = 'ready'
      and response_quality_status = 'approved'
    from phase_12e_state
  ),
  'independently validated Gemini worksheet returns one ready approved result'
);

select ok(
  exists (
    select 1
    from public.practice_tests test
    where test.id = (select response_test_id from phase_12e_state)
      and test.generation_source = 'gemini'
      and test.generator_model = 'gemini-3.1-flash-lite'
      and test.generation_metadata #>> '{schema_version}' = '2'
      and test.generation_metadata #>> '{source_mix,mode}' = 'gemini'
      and test.generation_metadata #>> '{source_mix,deepseek_count}' = '0'
      and test.generation_metadata #>> '{source_mix,gemini_count}' = '8'
      and test.generation_metadata #>> '{validation,critic_model}' =
        'deepseek-v4-flash'
      and test.generation_metadata
        #>> '{validation,critics,deepseek,model}' = 'deepseek-v4-flash'
      and test.generation_metadata
        #>> '{validation,critics,gemini,model}' = 'gemini-3.1-flash-lite'
      and test.generation_metadata #>> '{validation,independent_model}' = 'true'
  ),
  'persisted revision truthfully records pinned Gemini generator and dual-critic metadata'
);

select ok(
  exists (
    select 1
    from app_private.worksheet_generation_completions_v2 completion
    where completion.job_id = (select job_id from phase_12e_state)
      and completion.practice_test_id =
        (select response_test_id from phase_12e_state)
      and completion.completion_mode = 'generated'
      and completion.evidence_version = 2
      and completion.provider_source = 'gemini'
      and completion.generator_model = 'gemini-3.1-flash-lite'
      and completion.primary_critic_provider = 'deepseek'
      and completion.primary_critic_model = 'deepseek-v4-flash'
      and completion.primary_verdict_sha256 =
        (select payload #>> '{validation,critics,deepseek,verdict_sha256}'
         from phase_12e_payloads where name = 'gemini_full')
      and completion.secondary_critic_provider = 'gemini'
      and completion.secondary_critic_model = 'gemini-3.1-flash-lite'
      and completion.secondary_verdict_sha256 =
        (select payload #>> '{validation,critics,gemini,verdict_sha256}'
         from phase_12e_payloads where name = 'gemini_full')
      and completion.candidate_sha256 =
        (select payload #>> '{validation,candidate_sha256}'
         from phase_12e_payloads where name = 'gemini_full')
      and completion.provider_metadata #>> '{source_mix,mode}' = 'gemini'
      and completion.payload_sha256 =
        app_private.worksheet_generation_payload_sha256(
          (select payload from phase_12e_payloads where name = 'gemini_full')
        )
      and completion.content_sha256 =
        app_private.practice_test_content_sha256(completion.practice_test_id)
  ),
  'first Gemini completion records canonical v2 dual-critic and content hashes'
);

select ok(
  exists (
    select 1
    from public.student_practice_assignments assignment
    where assignment.id = 'd5555555-5555-4555-8555-555555555555'
      and assignment.practice_test_id = (select response_test_id from phase_12e_state)
      and assignment.generation_status = 'ready'
      and assignment.generation_error is null
  )
    and (
      select count(*) = 8
      from public.practice_test_questions question
      where question.practice_test_id = (select response_test_id from phase_12e_state)
    ),
  'exactly one validated eight-question worksheet is attached to the assignment'
);

select ok(
  exists (
    select 1
    from app_private.async_jobs job
    join pgmq.a_worksheet_generation archive
      on archive.msg_id = job.queue_message_id
    where job.id = (select job_id from phase_12e_state)
      and job.status = 'succeeded'
      and not exists (
        select 1
        from pgmq.q_worksheet_generation queue
        where queue.msg_id = job.queue_message_id
      )
  ),
  'successful Gemini completion archives its queue message after persistence'
);

set local role service_role;
select lives_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_12e_state),
      (select message_id from pg_temp.phase_12e_state),
      'd6666666-6666-4666-8666-666666666666',
      (select payload from pg_temp.phase_12e_payloads where name = 'gemini_full')
    )
  $$,
  'idempotent Gemini redelivery returns the existing completed revision'
);
reset role;

select ok(
  (
    select count(*) = 1
    from public.practice_tests test
    where test.generation_job_id = (select job_id from phase_12e_state)
  )
    and (
      select count(*) = 8
      from public.practice_test_questions question
      where question.practice_test_id = (select response_test_id from phase_12e_state)
    ),
  'idempotent replay creates no duplicate worksheet or questions'
);

select ok(
  (
    select count(*) = 1
      and min(payload_sha256) = max(payload_sha256)
      and min(content_sha256) = max(content_sha256)
    from app_private.worksheet_generation_completions_v2 completion
    where completion.job_id = (select job_id from phase_12e_state)
  ),
  'exact Gemini replay leaves the private v2 completion evidence unchanged'
);

set local role service_role;
select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_12e_state),
      (select message_id from pg_temp.phase_12e_state),
      'd6666666-6666-4666-8666-666666666666',
      '{"schema_version":1,"mode":"reuse","reusable_practice_test_id":"11111111-1111-4111-8111-111111111111"}'::jsonb
    )
  $$,
  '55000',
  'Worksheet completion replay does not match persisted result.',
  'generated completion cannot bypass exact replay with a reuse envelope'
);
reset role;

update public.practice_test_questions question
set prompt = 'Privileged content drift fixture.'
where question.practice_test_id = (select response_test_id from phase_12e_state)
  and question.question_number = 1;

set local role service_role;
select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_12e_state),
      (select message_id from pg_temp.phase_12e_state),
      'd6666666-6666-4666-8666-666666666666',
      (select payload from pg_temp.phase_12e_payloads where name = 'gemini_full')
    )
  $$,
  '55000',
  'Worksheet completion replay does not match persisted result.',
  'exact payload replay rejects drift in currently persisted worksheet content'
);
reset role;

update public.practice_test_questions question
set prompt = payload.payload #>> '{questions,0,prompt}'
from phase_12e_payloads payload
where payload.name = 'gemini_full'
  and question.practice_test_id = (select response_test_id from phase_12e_state)
  and question.question_number = 1;

set local role service_role;
select lives_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_12e_state),
      (select message_id from pg_temp.phase_12e_state),
      'd6666666-6666-4666-8666-666666666666',
      (select payload from pg_temp.phase_12e_payloads where name = 'gemini_full')
    )
  $$,
  'restoring the exact persisted content restores exact replay eligibility'
);
reset role;

set local role service_role;
select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_12e_state),
      (select message_id from pg_temp.phase_12e_state),
      'd6666666-6666-4666-8666-666666666666',
      (select payload from pg_temp.phase_12e_payloads where name = 'deepseek_full')
    )
  $$,
  '55000',
  'Worksheet completion replay does not match persisted result.',
  'Gemini to DeepSeek replay is rejected without relabeling the worksheet'
);

select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_12e_state),
      (select message_id from pg_temp.phase_12e_state),
      'd6666666-6666-4666-8666-666666666666',
      jsonb_set(
        (select payload from pg_temp.phase_12e_payloads where name = 'gemini_full'),
        '{title}',
        '"Changed replay title"'::jsonb
      )
    )
  $$,
  '22023',
  'worksheet_candidate_hash_mismatch',
  'same-provider replay with changed educational content is rejected'
);

select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select job_id from pg_temp.phase_12e_state),
      (select message_id from pg_temp.phase_12e_state),
      'd6666666-6666-4666-8666-666666666666',
      jsonb_set(
        (select payload from pg_temp.phase_12e_payloads where name = 'gemini_full'),
        '{validation,attempt_count}',
        '1'::jsonb
      )
    )
  $$,
  '55000',
  'Worksheet completion replay does not match persisted result.',
  'same-provider replay with changed validation provenance is rejected'
);
reset role;

select ok(
  exists (
    select 1
    from public.practice_tests test
    join app_private.worksheet_generation_completions_v2 completion
      on completion.practice_test_id = test.id
    where completion.job_id = (select job_id from phase_12e_state)
      and test.id = (select response_test_id from phase_12e_state)
      and test.generation_source = 'gemini'
      and test.generator_model = 'gemini-3.1-flash-lite'
      and test.generation_metadata = completion.provider_metadata
      and completion.payload_sha256 =
        app_private.worksheet_generation_payload_sha256(
          (select payload from phase_12e_payloads where name = 'gemini_full')
        )
      and completion.content_sha256 =
        app_private.practice_test_content_sha256(test.id)
  )
    and (
      select count(*) = 8
      from public.practice_test_questions question
      where question.practice_test_id = (select response_test_id from phase_12e_state)
    ),
  'every rejected Gemini replay leaves public content and private v2 evidence unchanged'
);

select throws_ok(
  $$
    update app_private.worksheet_generation_completions_v2
    set generator_model = 'deepseek-v4-pro'
    where job_id = (select job_id from pg_temp.phase_12e_state)
  $$,
  '55000',
  'Worksheet generation completion evidence is immutable.',
  'committed completion evidence cannot be updated'
);

select throws_ok(
  $$
    delete from app_private.worksheet_generation_completions_v2
    where job_id = (select job_id from pg_temp.phase_12e_state)
  $$,
  '55000',
  'Worksheet generation completion evidence is immutable.',
  'committed completion evidence cannot be deleted'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd2222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd2222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    'd5555555-5555-4555-8555-555555555556'
  )
)
update pg_temp.phase_12e_state state
set deepseek_job_id = requested.job_id
from requested
where state.singleton;

reset role;
update phase_12e_state state
set deepseek_message_id = job.queue_message_id
from app_private.async_jobs job
where job.id = state.deepseek_job_id;

select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

with claimed as (
  select *
  from public.claim_async_jobs(
    'worksheet_generation',
    'd6666666-6666-4666-8666-666666666666',
    1,
    225
  )
)
update pg_temp.phase_12e_state state
set deepseek_job_id = claimed.job_id,
    deepseek_message_id = claimed.queue_message_id
from claimed
where state.singleton;

select lives_ok(
  $$
    with completed as (
      select *
      from api.complete_worksheet_generation(
        (select deepseek_job_id from pg_temp.phase_12e_state),
        (select deepseek_message_id from pg_temp.phase_12e_state),
        'd6666666-6666-4666-8666-666666666666',
        (select payload from pg_temp.phase_12e_payloads where name = 'deepseek_full')
      )
    )
    update pg_temp.phase_12e_state state
    set deepseek_test_id = completed.practice_test_id
    from completed
    where state.singleton
  $$,
  'pinned DeepSeek completion records its own immutable fingerprint evidence'
);
reset role;

select ok(
  exists (
    select 1
    from public.practice_tests test
    join app_private.worksheet_generation_completions_v2 completion
      on completion.practice_test_id = test.id
    where completion.job_id = (select deepseek_job_id from phase_12e_state)
      and test.id = (select deepseek_test_id from phase_12e_state)
      and test.generation_source = 'deepseek'
      and test.generator_model = 'deepseek-v4-pro'
      and test.generation_metadata #>> '{schema_version}' = '2'
      and test.generation_metadata #>> '{source_mix,mode}' = 'deepseek'
      and test.generation_metadata #>> '{source_mix,deepseek_count}' = '8'
      and test.generation_metadata #>> '{source_mix,gemini_count}' = '0'
      and test.generation_metadata #>> '{validation,critic_model}' =
        'deepseek-v4-flash'
      and test.generation_metadata
        #>> '{validation,critics,gemini,model}' = 'gemini-3.1-flash-lite'
      and completion.provider_source = 'deepseek'
      and completion.completion_mode = 'generated'
      and completion.evidence_version = 2
      and completion.generator_model = 'deepseek-v4-pro'
      and completion.primary_critic_provider = 'deepseek'
      and completion.primary_critic_model = 'deepseek-v4-flash'
      and completion.secondary_critic_provider = 'gemini'
      and completion.secondary_critic_model = 'gemini-3.1-flash-lite'
      and completion.primary_verdict_sha256 =
        (select payload #>> '{validation,critics,deepseek,verdict_sha256}'
         from phase_12e_payloads where name = 'deepseek_full')
      and completion.secondary_verdict_sha256 =
        (select payload #>> '{validation,critics,gemini,verdict_sha256}'
         from phase_12e_payloads where name = 'deepseek_full')
      and completion.candidate_sha256 =
        (select payload #>> '{validation,candidate_sha256}'
         from phase_12e_payloads where name = 'deepseek_full')
      and completion.payload_sha256 =
        app_private.worksheet_generation_payload_sha256(
          (select payload from phase_12e_payloads where name = 'deepseek_full')
        )
      and completion.content_sha256 =
        app_private.practice_test_content_sha256(test.id)
  ),
  'DeepSeek worksheet and v2 fingerprint retain exact dual-critic provenance'
);

set local role service_role;
select throws_ok(
  $$
    select *
    from api.complete_worksheet_generation(
      (select deepseek_job_id from pg_temp.phase_12e_state),
      (select deepseek_message_id from pg_temp.phase_12e_state),
      'd6666666-6666-4666-8666-666666666666',
      (select payload from pg_temp.phase_12e_payloads where name = 'gemini_full')
    )
  $$,
  '55000',
  'Worksheet completion replay does not match persisted result.',
  'DeepSeek to Gemini replay is rejected without relabeling the worksheet'
);
reset role;

select ok(
  exists (
    select 1
    from public.practice_tests test
    join app_private.worksheet_generation_completions_v2 completion
      on completion.practice_test_id = test.id
    where completion.job_id = (select deepseek_job_id from phase_12e_state)
      and test.id = (select deepseek_test_id from phase_12e_state)
      and test.generation_source = 'deepseek'
      and test.generator_model = 'deepseek-v4-pro'
      and completion.provider_source = 'deepseek'
      and completion.payload_sha256 =
        app_private.worksheet_generation_payload_sha256(
          (select payload from phase_12e_payloads where name = 'deepseek_full')
        )
      and completion.content_sha256 =
        app_private.practice_test_content_sha256(test.id)
  ),
  'rejected DeepSeek replay leaves its worksheet and v2 evidence unchanged'
);

select * from finish(true);
rollback;
