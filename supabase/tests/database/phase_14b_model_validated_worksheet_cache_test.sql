begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

-- This is intentionally a shared-staging-safe contract test. It exercises the
-- pure validation predicate directly and otherwise proves the catalog/source
-- boundaries without claiming queue messages or reading learner content.
select plan(59);

select ok(
  to_regclass('app_private.practice_worksheet_model_cache_revisions') is not null
    and to_regclass('app_private.practice_worksheet_model_cache_questions') is not null
    and to_regclass('app_private.practice_worksheet_model_cache_sources') is not null
    and to_regclass('app_private.practice_worksheet_model_cache_withdrawals') is not null
    and to_regclass('app_private.practice_worksheet_model_cache_attachment_events') is not null
    and to_regclass('app_private.practice_worksheet_model_cache_promotion_failures') is not null
    and to_regclass('app_private.practice_worksheet_model_cache_recovery_failures') is not null,
  'the model-validated cache and its operational ledgers are separate private relations'
);

select ok(
  (
    select count(*) = 7 and bool_and(relation.relrowsecurity)
    from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'app_private'
      and relation.relname in (
        'practice_worksheet_model_cache_revisions',
        'practice_worksheet_model_cache_questions',
        'practice_worksheet_model_cache_sources',
        'practice_worksheet_model_cache_withdrawals',
        'practice_worksheet_model_cache_attachment_events',
        'practice_worksheet_model_cache_promotion_failures',
        'practice_worksheet_model_cache_recovery_failures'
      )
  ),
  'every cache relation enables RLS as defense in depth'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'app_private.practice_worksheet_model_cache_revisions',
      'app_private.practice_worksheet_model_cache_questions',
      'app_private.practice_worksheet_model_cache_sources',
      'app_private.practice_worksheet_model_cache_withdrawals',
      'app_private.practice_worksheet_model_cache_attachment_events',
      'app_private.practice_worksheet_model_cache_promotion_failures',
      'app_private.practice_worksheet_model_cache_recovery_failures'
    ]) relation_name
    cross join unnest(array['anon', 'authenticated', 'service_role']) role_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege_name
    where has_table_privilege(role_name, relation_name, privilege_name)
  ),
  'no Data API role has direct cache-table privileges'
);

select ok(
  not exists (
    select 1
    from information_schema.tables table_row
    where table_row.table_schema = 'api'
      and table_row.table_name like '%model_cache%'
  ),
  'the exposed API schema contains no model-cache table'
);

select ok(
  (
    select count(*) = 10
    from information_schema.columns column_row
    where column_row.table_schema = 'app_private'
      and column_row.table_name = 'practice_worksheet_model_cache_revisions'
      and column_row.column_name in (
        'source_practice_test_id', 'source_completion_job_id',
        'candidate_sha256', 'primary_critic_provider',
        'primary_critic_model', 'primary_verdict_sha256',
        'secondary_critic_provider', 'secondary_critic_model',
        'secondary_verdict_sha256', 'content_sha256'
      )
  )
    and (
      select count(*) = 4
      from information_schema.columns column_row
      where column_row.table_schema = 'app_private'
        and column_row.table_name = 'practice_worksheet_model_cache_sources'
        and column_row.column_name in (
          'source_practice_test_id', 'revision_id',
          'source_completion_job_id', 'source_content_sha256'
        )
    ),
  'cache revisions and every deduplicated source retain exact immutable provenance'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conname = 'practice_tests_model_cache_clone_shape_check'
      and constraint_row.conrelid = 'public.practice_tests'::regclass
  )
    and to_regclass('public.practice_tests_one_model_cache_clone_per_workspace_idx') is not null
    and exists (
      select 1
      from information_schema.columns column_row
      where column_row.table_schema = 'public'
        and column_row.table_name = 'practice_tests'
        and column_row.column_name = 'worksheet_model_cache_revision_id'
    )
    and exists (
      select 1
      from information_schema.columns column_row
      where column_row.table_schema = 'public'
        and column_row.table_name = 'practice_tests'
        and column_row.column_name = 'model_cache_content_sha256'
    ),
  'workspace clones have truthful provenance columns, shape enforcement, and one-clone uniqueness'
);

select ok(
  (
    select count(*) = 8
    from pg_trigger trigger_row
    where not trigger_row.tgisinternal
      and trigger_row.tgname in (
        'practice_worksheet_model_cache_revisions_00_guard',
        'practice_worksheet_model_cache_questions_00_guard',
        'practice_worksheet_model_cache_sources_00_guard',
        'practice_worksheet_model_cache_revisions_immutable',
        'practice_worksheet_model_cache_questions_immutable',
        'practice_worksheet_model_cache_sources_immutable',
        'practice_worksheet_model_cache_withdrawals_00_guard',
        'practice_worksheet_model_cache_withdrawals_immutable'
      )
  ),
  'promotion rows, questions, source links, and withdrawals are guarded and append-only'
);

select ok(
  exists (
    select 1 from pg_trigger trigger_row
    where trigger_row.tgname = 'practice_worksheet_model_cache_attachment_events_00_guard'
      and not trigger_row.tgisinternal
  )
    and exists (
      select 1 from pg_trigger trigger_row
      where trigger_row.tgname = 'practice_worksheet_model_cache_attachment_events_immutable'
        and not trigger_row.tgisinternal
    ),
  'request, terminal, and recovery attachment evidence is guarded and immutable'
);

select ok(
  to_regprocedure('api.promote_model_validated_worksheet(uuid)') is not null
    and to_regprocedure('app_private.practice_test_has_current_unlinked_model_evidence(uuid)') is not null
    and to_regprocedure('api.withdraw_model_validated_worksheet_cache(uuid,text,uuid,text)') is not null
    and to_regprocedure('api.promote_pending_model_validated_worksheets(integer)') is not null
    and to_regprocedure('api.try_complete_current_model_cache_fallback(uuid,bigint,uuid,text,jsonb)') is not null
    and to_regprocedure('api.recover_current_model_cache_assignments(integer)') is not null
    and to_regprocedure('public.request_practice_worksheet(uuid)') is not null
    and to_regprocedure('public.request_practice_worksheet_before_model_cache(uuid)') is not null
    and to_regprocedure('public.request_practice_worksheet_before_phase_13f(uuid)') is not null
    and to_regprocedure('public.request_practice_worksheet_before_phase_14b_paid(uuid)') is not null,
  'promotion, withdrawal, terminal rescue, recovery, and request signatures are stable'
);

select ok(
  (
    select bool_and(
      has_function_privilege('service_role', procedure_oid, 'EXECUTE')
      and not has_function_privilege('authenticated', procedure_oid, 'EXECUTE')
      and not has_function_privilege('anon', procedure_oid, 'EXECUTE')
    )
    from unnest(array[
      'api.promote_model_validated_worksheet(uuid)'::regprocedure,
      'api.withdraw_model_validated_worksheet_cache(uuid,text,uuid,text)'::regprocedure,
      'api.promote_pending_model_validated_worksheets(integer)'::regprocedure,
      'api.try_complete_current_model_cache_fallback(uuid,bigint,uuid,text,jsonb)'::regprocedure,
      'api.recover_current_model_cache_assignments(integer)'::regprocedure
    ]) procedure_oid
  ),
  'only service workers can enter cache administration and recovery APIs'
);

select ok(
  has_function_privilege(
    'authenticated', 'public.request_practice_worksheet(uuid)', 'EXECUTE'
  )
    and not has_function_privilege(
      'anon', 'public.request_practice_worksheet(uuid)', 'EXECUTE'
    )
    and not has_function_privilege(
      'service_role', 'public.request_practice_worksheet(uuid)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.request_practice_worksheet_before_model_cache(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.request_practice_worksheet_before_phase_13f(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.request_practice_worksheet_before_phase_14b_paid(uuid)',
      'EXECUTE'
    ),
  'students enter only the authenticated request wrapper, never an internal predecessor directly'
);

select ok(
  (
    select bool_and(procedure_row.prosecdef)
      and bool_and(procedure_row.proconfig @> array['search_path=""']::text[])
    from pg_proc procedure_row
    where procedure_row.oid in (
      'app_private.promote_model_validated_worksheet(uuid)'::regprocedure,
      'api.promote_model_validated_worksheet(uuid)'::regprocedure,
      'api.withdraw_model_validated_worksheet_cache(uuid,text,uuid,text)'::regprocedure,
      'app_private.select_model_validated_worksheet_cache(uuid,uuid,uuid,text,uuid,boolean)'::regprocedure,
      'app_private.clone_model_validated_worksheet_cache(uuid,uuid,uuid)'::regprocedure,
      'app_private.practice_test_has_current_unlinked_model_evidence(uuid)'::regprocedure,
      'public.request_practice_worksheet(uuid)'::regprocedure,
      'public.request_practice_worksheet_before_model_cache(uuid)'::regprocedure,
      'public.request_practice_worksheet_before_phase_13f(uuid)'::regprocedure,
      'public.request_practice_worksheet_before_phase_14b_paid(uuid)'::regprocedure,
      'api.try_complete_current_model_cache_fallback(uuid,bigint,uuid,text,jsonb)'::regprocedure,
      'api.promote_pending_model_validated_worksheets(integer)'::regprocedure,
      'app_private.attach_current_model_cache_for_recovery(uuid)'::regprocedure,
      'api.recover_current_model_cache_assignments(integer)'::regprocedure
    )
  ),
  'all privileged cache boundaries are definers with an empty search path'
);

select ok(
  app_private.model_cache_validation_checks_pass(
    '{"checks":{"ambiguity_free":true,"no_answer_leakage":true,"duplicate_free":true,"level_fit":true,"topic_fit":true,"type_balance":true,"scoring_safe":true},"content_checks":{"mini_lesson_scope_accurate":true,"learner_cues_semantically_aligned":true,"examples_rubrics_consistent":true}}'::jsonb
  ),
  'the cache validator accepts only a complete ten-check approval'
);

select ok(
  not app_private.model_cache_validation_checks_pass(
    '{"checks":{"ambiguity_free":true,"no_answer_leakage":true,"duplicate_free":true,"level_fit":true,"topic_fit":true,"type_balance":true,"scoring_safe":true}}'::jsonb
  )
    and not app_private.model_cache_validation_checks_pass(
      '{"checks":{"ambiguity_free":"true","no_answer_leakage":"true","duplicate_free":"true","level_fit":"true","topic_fit":"true","type_balance":"true","scoring_safe":"true"},"content_checks":{"mini_lesson_scope_accurate":"true","learner_cues_semantically_aligned":"true","examples_rubrics_consistent":"true"}}'::jsonb
    ),
  'missing content checks and string-typed booleans cannot qualify cache material'
);

select ok(
  not app_private.model_cache_validation_checks_pass(
    '{"checks":{"ambiguity_free":true,"no_answer_leakage":true,"duplicate_free":true,"level_fit":true,"topic_fit":true,"type_balance":true,"scoring_safe":true},"content_checks":{"mini_lesson_scope_accurate":false,"learner_cues_semantically_aligned":true,"examples_rubrics_consistent":true}}'::jsonb
  ),
  'an inaccurate mini-lesson cannot qualify cache material'
);

select ok(
  not app_private.model_cache_validation_checks_pass(
    '{"checks":{"ambiguity_free":true,"no_answer_leakage":true,"duplicate_free":true,"level_fit":true,"topic_fit":true,"type_balance":true,"scoring_safe":true},"content_checks":{"mini_lesson_scope_accurate":true,"learner_cues_semantically_aligned":false,"examples_rubrics_consistent":true}}'::jsonb
  ),
  'misaligned learner cues cannot qualify cache material'
);

select ok(
  not app_private.model_cache_validation_checks_pass(
    '{"checks":{"ambiguity_free":true,"no_answer_leakage":true,"duplicate_free":true,"level_fit":true,"topic_fit":true,"type_balance":true,"scoring_safe":true},"content_checks":{"mini_lesson_scope_accurate":true,"learner_cues_semantically_aligned":true,"examples_rubrics_consistent":false}}'::jsonb
  ),
  'inconsistent examples or rubrics cannot qualify cache material'
);

select ok(
  (
    select definition ~ 'model_cache_validation_checks_pass\(validation\)'
      and definition ~ 'model_cache_validation_checks_pass\(deepseek_critic\)'
      and definition ~ 'model_cache_validation_checks_pass\(gemini_critic\)'
    from (
      select pg_get_functiondef(
        'app_private.promote_model_validated_worksheet(uuid)'::regprocedure
      ) definition
    ) source
  ),
  'promotion independently requires all ordinary and content checks overall and from both critics'
);

select ok(
  (
    select definition like '%worksheet_generation_completions_v2%'
      and definition like '%completion.candidate_sha256%'
      and definition like '%completion.primary_verdict_sha256%'
      and definition like '%completion.secondary_verdict_sha256%'
      and definition like '%practice_test_content_sha256%'
      and definition like '%worksheet_critic_verdict_sha256%'
      and definition like '%insert into app_private.practice_worksheet_model_cache_sources%'
      and definition like '%source_link.source_practice_test_id = source_test.id%'
    from (
      select pg_get_functiondef(
        'app_private.promote_model_validated_worksheet(uuid)'::regprocedure
      ) definition
    ) source
  ),
  'promotion binds every source to immutable completion, candidate, critic, revision, and educational hashes'
);

select ok(
  (
    select position('pg_advisory_xact_lock' in definition) > 0
      and position('pg_advisory_xact_lock' in definition)
        < position('from public.practice_tests test' in definition)
      and position('from app_private.practice_worksheet_model_cache_sources source_link' in definition)
        < position('validation := source_test.generation_metadata' in definition)
    from (
      select pg_get_functiondef(
        'app_private.promote_model_validated_worksheet(uuid)'::regprocedure
      ) definition
    ) source
  ),
  'source-scoped advisory locking serializes promotion before the existing-revision re-read'
);

select ok(
  (
    select definition like '%if existing_revision_id is not null then%'
      and definition like '%practice_worksheet_model_cache_sources source_link%'
      and definition like '%source_link.source_completion_job_id = completion.job_id%'
      and definition like '%source_link.source_content_sha256 =%'
      and definition like '%model_cache_existing_source_mismatch%'
      and definition like '%practice_worksheet_model_cache_revision_is_current(%'
      and definition like '%return existing_revision_id;%'
      and position('return existing_revision_id;' in definition)
        < position('insert into app_private.practice_worksheet_model_cache_revisions' in definition)
    from (
      select pg_get_functiondef(
        'app_private.promote_model_validated_worksheet(uuid)'::regprocedure
      ) definition
    ) source
  ),
  'promotion replay returns one revision only for the exact current source and completion link'
);

select ok(
  (
    select definition like '%worksheet_generation_completions_v2%'
      and definition like '%practice_worksheet_model_cache_revision_sha256%'
      and definition like '%practice_worksheet_model_cache_withdrawals%'
      and definition like '%case when revision.level = ''A2'' then 9 else 8 end%'
    from (
      select pg_get_functiondef(
        'app_private.practice_worksheet_model_cache_revision_is_current(uuid)'::regprocedure
      ) definition
    ) source
  ),
  'current cache evidence rechecks completion provenance, content hash, withdrawal, and question count'
);

select ok(
  (
    select canonical_definition like '%worksheet_model_cache_revision_id%'
      and canonical_definition like '%practice_worksheet_model_cache_revision_is_current%'
      and canonical_definition like '%approval_source is distinct from ''independent_model_validation''%'
      and canonical_definition like '%practice_test_has_current_unlinked_model_evidence%'
      and canonical_definition like '%reviewer.expires_at > greatest(review.reviewed_at, now())%'
      and canonical_definition like '%releaser.expires_at > greatest(release.released_at, now())%'
      and canonical_definition like '%practice_worksheet_template_revision_sha256(%'
      and evidence_definition like '%worksheet_generation_completions_v2%'
      and evidence_definition like '%practice_test_content_sha256%'
      and evidence_definition like '%job.entity_id = test.generated_from_assignment_id%'
      and evidence_definition like '%completion.provider_metadata = test.generation_metadata%'
      and evidence_definition like '%model_cache_validation_checks_pass%'
      and evidence_definition like '%worksheet_critic_verdict_sha256%'
      and evidence_definition like '%jsonb_typeof(evidence.validation -> ''attempt_count'') = ''number''%'
    from (
      select
        pg_get_functiondef(
          'app_private.practice_test_canonical_revision_is_current(uuid)'::regprocedure
        ) canonical_definition,
        pg_get_functiondef(
          'app_private.practice_test_has_current_unlinked_model_evidence(uuid)'::regprocedure
        ) evidence_definition
    ) source
  ),
  'canonical current accepts only linked or exact typed 7+3 model evidence while preserving human/canonical checks'
);

select ok(
  (
    select definition like '%public.workspace_members%'
      and definition like '%membership.role = ''student''%'
      and definition like '%practice_topic_level_gate_satisfied%'
      and definition like '%practice_worksheet_model_cache_revision_is_current%'
      and definition like '%coalesce(allow_reuse, false)%'
    from (
      select pg_get_functiondef(
        'app_private.select_model_validated_worksheet_cache(uuid,uuid,uuid,text,uuid,boolean)'::regprocedure
      ) definition
    ) source
  ),
  'selection requires exact student membership, level gate, current evidence, and unseen-first reuse policy'
);

select ok(
  position(
    'practice_worksheet_model_cache' in
    pg_get_functiondef(
      'app_private.practice_topic_level_gate_satisfied(uuid,text,uuid)'::regprocedure
    )
  ) = 0,
  'the thirteen restricted low-CEFR contexts are not bypassed by changing the existing gate'
);

select ok(
  (
    select definition like '%model-cache-withdrawal:%'
      and definition like '%model-cache-clone:%'
      and definition like '%practice_topic_level_gate_satisfied%'
      and definition like '%practice_worksheet_model_cache_revision_is_current%'
      and definition like '%practice_test_content_sha256%'
      and definition like '%test.workspace_id = target_workspace_id%'
      and definition like '%test.worksheet_model_cache_revision_id = selected_revision.id%'
      and definition like '%return existing_test.id%'
    from (
      select pg_get_functiondef(
        'app_private.clone_model_validated_worksheet_cache(uuid,uuid,uuid)'::regprocedure
      ) definition
    ) source
  ),
  'clone creation is withdrawal-safe, gate-safe, hash-checked, and workspace-idempotent'
);

select ok(
  (
    select definition like '%approval_source%independent_model_validation%'
      and definition like '%teacher_reviewed%false%'
      and definition like '%worksheet_model_cache_revision_id%selected_revision.id%'
      and definition like '%model_cache_content_sha256%'
    from (
      select pg_get_functiondef(
        'app_private.clone_model_validated_worksheet_cache(uuid,uuid,uuid)'::regprocedure
      ) definition
    ) source
  ),
  'clones truthfully retain model validation without claiming teacher or certified-bank approval'
);

select ok(
  (
    select position('request_practice_worksheet_before_model_cache' in public_definition) > 0
      and position('select_released_worksheet_template_internal' in phase_13f_definition) > 0
      and position('request_practice_worksheet_before_phase_13f' in phase_13f_definition) > 0
      and position('select_model_validated_worksheet_cache' in free_definition) > 0
      and position('request_practice_worksheet_before_phase_14b_paid' in free_definition) > 0
      and position('consume_ai_paid_work_budget' in free_definition) = 0
      and position('enqueue_async_job' in free_definition) = 0
    from (
      select
        pg_get_functiondef(
          'public.request_practice_worksheet(uuid)'::regprocedure
        ) public_definition,
        pg_get_functiondef(
          'public.request_practice_worksheet_before_model_cache(uuid)'::regprocedure
        ) phase_13f_definition,
        pg_get_functiondef(
          'public.request_practice_worksheet_before_phase_13f(uuid)'::regprocedure
        ) free_definition
    ) source
  ),
  'request order is certified bank, free workspace/cache material, then paid enqueue only on a true miss'
);

select ok(
  (
    select definition like '%test.workspace_id = selected_assignment.workspace_id%'
      and definition like '%test.quality_status = ''approved''%'
      and definition like '%test.worksheet_model_cache_revision_id is null%'
      and definition like '%job.status in (''queued'', ''retry'', ''processing'')%'
      and definition like '%job.lease_expires_at > now()%'
    from (
      select pg_get_functiondef(
        'public.request_practice_worksheet_before_phase_13f(uuid)'::regprocedure
      ) definition
    ) source
  ),
  'request-time cache reuse preserves same-workspace approved priority and never steals a live lease'
);

select ok(
  (
    select definition like '%pgmq.archive%'
      and definition like '%status = ''dead''%'
      and definition like '%workspace_worksheet_attached%'
      and definition like '%model_cache_attached%'
      and definition like '%generation_status = ''ready''%'
      and definition like '%practice_worksheet_model_cache_attachment_events%'
    from (
      select pg_get_functiondef(
        'public.request_practice_worksheet_before_phase_13f(uuid)'::regprocedure
      ) definition
    ) source
  ),
  'a synchronous cache hit safely terminalizes its durable job and records a truthful ready attachment atomically'
);

select ok(
  (
    select definition ~* 'on\s+conflict\s+do\s+nothing'
      and definition !~* 'on\s+conflict\s*\(\s*attachment_source\s*,\s*assignment_id\s*,\s*cloned_practice_test_id'
    from (
      select pg_get_functiondef(
        'public.request_practice_worksheet_before_phase_13f(uuid)'::regprocedure
      ) definition
    ) source
  ),
  'request-time cache attachment is idempotent without colliding with PL/pgSQL output-column names'
);

select ok(
  (
    select definition like '%selected_job.status <> ''processing''%'
      and definition like '%selected_job.queue_message_id is distinct from target_queue_message_id%'
      and definition like '%selected_job.worker_id is distinct from target_worker_id%'
      and definition like '%selected_job.lease_expires_at <= now()%'
      and definition like '%practice_topic_level_gate_satisfied%'
      and definition like '%if selected_job.status = ''succeeded'' then%'
    from (
      select pg_get_functiondef(
        'api.try_complete_current_model_cache_fallback(uuid,bigint,uuid,text,jsonb)'::regprocedure
      ) definition
    ) source
  ),
  'terminal rescue requires the exact active lease and gate while supporting exact succeeded replay'
);

select ok(
  (
    select definition like '%status = ''succeeded''%'
      and definition like '%pgmq.archive%'
      and definition like '%generation_started_at = null%'
      and definition like '%attachment_source%terminal_worker%'
      and definition like '%rejected_candidates_sha256%'
    from (
      select pg_get_functiondef(
        'api.try_complete_current_model_cache_fallback(uuid,bigint,uuid,text,jsonb)'::regprocedure
      ) definition
    ) source
  ),
  'terminal rescue completes the job, archives the queue message, and stores content-free rejection provenance'
);

select ok(
  (
    select definition like '%least(greatest(coalesce(max_worksheets, 25), 0), 50)%'
      and definition like '%limit clean_limit * 4%'
      and definition like '%failure_count < 5%'
      and definition like '%interval ''1 minute''%'
      and definition like '%interval ''5 minutes''%'
      and definition like '%interval ''15 minutes''%'
      and definition like '%interval ''30 minutes''%'
      and definition like '%promote_model_validated_worksheet%'
      and definition like '%practice_worksheet_model_cache_sources%'
      and definition like '%source_link.source_practice_test_id = test.id%'
    from (
      select pg_get_functiondef(
        'api.promote_pending_model_validated_worksheets(integer)'::regprocedure
      ) definition
    ) source
  ),
  'pending promotion is bounded, non-starving, idempotent, and exponentially retried'
);

select ok(
  (
    select definition like '%practice_topic_level_gate_satisfied%'
      and definition like '%lease_expires_at > now()%'
      and definition like '%select_model_validated_worksheet_cache%'
      and definition like '%clone_model_validated_worksheet_cache%'
      and definition like '%pgmq.archive%'
      and definition like '%attachment_source%recovery_sweep%'
    from (
      select pg_get_functiondef(
        'app_private.attach_current_model_cache_for_recovery(uuid)'::regprocedure
      ) definition
    ) source
  ),
  'recovery attaches only current gated cache material without racing a live provider worker'
);

select ok(
  (
    select definition like '%expected_content_sha256%'
      and definition like '%profile.global_role = ''platform_admin''%'
      and definition like '%model-cache-withdrawal:%'
      and definition like '%model_cache_withdrawal_replay_mismatch%'
      and definition like '%''created'', false%'
      and definition like '%''created'', true%'
    from (
      select pg_get_functiondef(
        'api.withdraw_model_validated_worksheet_cache(uuid,text,uuid,text)'::regprocedure
      ) definition
    ) source
  ),
  'withdrawal is hash-bound, platform-admin-only, serialized, and replay-safe'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'app_private'
      and column_row.table_name = 'practice_worksheet_model_cache_attachment_events'
      and column_row.column_name in (
        'text', 'prompt', 'answer', 'writing', 'candidate', 'provider_payload',
        'rejection_reasons'
      )
  ),
  'attachment evidence contains identifiers, counters, and hashes but no learner or provider payload'
);

select ok(
  (
    select definition like '%question.question_type <> ''multiple_choice''%'
      and definition like '%question.evaluation_mode <> ''local_exact''%'
      and definition like '%jsonb_typeof(validation -> ''attempt_count'') is distinct from ''number''%'
      and definition like '%validation ->> ''attempt_count'' not in (''1'', ''2'')%'
      and definition like '%jsonb_array_length(question.options) not between 3 and 4%'
      and definition like '%jsonb_array_length(question.accepted_answers) <> 1%'
      and definition like '%question.rubric is not null%'
    from (
      select pg_get_functiondef(
        'app_private.promote_model_validated_worksheet(uuid)'::regprocedure
      ) definition
    ) source
  ),
  'only typed one-or-two-attempt deterministic mcq_safe contracts can enter the reusable cache'
);

select ok(
  (
    select definition like '%failure_count < 5%'
      and definition like '%least(greatest(coalesce(max_assignments, 25), 0), 50)%'
      and definition like '%attach_current_model_cache_for_recovery%'
      and definition like '%interval ''1 minute''%'
      and definition like '%interval ''5 minutes''%'
      and definition like '%interval ''15 minutes''%'
      and definition like '%interval ''30 minutes''%'
      and definition like '%exit when processed_count >= clean_limit;%'
      and regexp_count(
        definition,
        'processed_count := processed_count \+ 1'
      ) = 1
      and regexp_count(
        definition,
        'attempted_count := attempted_count \+ 1'
      ) = 2
      and position(
        'processed_count := processed_count + 1' in definition
      ) < position(
        'attach_current_model_cache_for_recovery(candidate.id)' in definition
      )
      and definition like '%''attempted'', attempted_count%'
      and definition like '%''succeeded'', succeeded_count%'
      and definition like '%''failed'', failed_count%'
    from (
      select pg_get_functiondef(
        'api.recover_current_model_cache_assignments(integer)'::regprocedure
      ) definition
    ) source
  ),
  'every recovery invocation, including false/deferred, consumes one requested bound and retains truthful retry state'
);

select ok(
  (
    select current_definition like '%practice_worksheet_model_cache_withdrawals%'
      and material_definition like '%worksheet_model_cache_revision_id%'
      and material_definition like '%practice_worksheet_model_cache_sources%'
      and material_definition like '%source_link.source_content_sha256%'
      and material_definition like '%practice_worksheet_model_cache_revision_is_current%'
      and unstarted_definition like '%worksheet.worksheet_model_cache_revision_id is not null%'
      and unstarted_definition like '%practice_worksheet_model_cache_sources%'
      and unstarted_definition like '%worksheet.approval_source = ''independent_model_validation''%'
      and assignment_guard_definition like '%model-cache-withdrawal:%'
      and assignment_guard_definition like '%practice_worksheet_model_cache_sources%'
      and assignment_guard_definition like '%practice_test_canonical_revision_is_current%'
      and attempt_guard_definition like '%model-cache-withdrawal:%'
      and attempt_guard_definition like '%practice_worksheet_model_cache_sources%'
      and attempt_guard_definition like '%selected_independent_model%'
      and attempt_guard_definition like '%assignment.status = ''in_progress''%'
      and selector_definition like '%practice_worksheet_model_cache_revision_is_current%'
      and clone_definition like '%practice_worksheet_model_cache_revision_is_current%'
      and request_definition like '%select_model_validated_worksheet_cache%'
      and terminal_definition like '%select_model_validated_worksheet_cache%'
      and recovery_definition like '%select_model_validated_worksheet_cache%'
    from (
      select
        pg_get_functiondef(
          'app_private.practice_worksheet_model_cache_revision_is_current(uuid)'::regprocedure
        ) current_definition,
        pg_get_functiondef(
          'app_private.practice_test_canonical_revision_is_current(uuid)'::regprocedure
        ) material_definition,
        pg_get_functiondef(
          'app_private.practice_assignment_has_withdrawn_unstarted_clone(uuid)'::regprocedure
        ) unstarted_definition,
        pg_get_functiondef(
          'app_private.guard_withdrawn_canonical_practice_assignment()'::regprocedure
        ) assignment_guard_definition,
        pg_get_functiondef(
          'app_private.guard_withdrawn_canonical_practice_attempt()'::regprocedure
        ) attempt_guard_definition,
        pg_get_functiondef(
          'app_private.select_model_validated_worksheet_cache(uuid,uuid,uuid,text,uuid,boolean)'::regprocedure
        ) selector_definition,
        pg_get_functiondef(
          'app_private.clone_model_validated_worksheet_cache(uuid,uuid,uuid)'::regprocedure
        ) clone_definition,
        pg_get_functiondef(
          'public.request_practice_worksheet_before_phase_13f(uuid)'::regprocedure
        ) request_definition,
        pg_get_functiondef(
          'api.try_complete_current_model_cache_fallback(uuid,bigint,uuid,text,jsonb)'::regprocedure
        ) terminal_definition,
        pg_get_functiondef(
          'app_private.attach_current_model_cache_for_recovery(uuid)'::regprocedure
        ) recovery_definition
    ) source
  ),
  'a withdrawal invalidates new selector, clone, request, terminal-rescue, and recovery use'
);

select ok(
  not has_function_privilege(
    'service_role',
    'app_private.select_model_validated_worksheet_cache(uuid,uuid,uuid,text,uuid,boolean)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'service_role',
      'app_private.clone_model_validated_worksheet_cache(uuid,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.practice_worksheet_model_cache_revision_sha256(uuid)',
      'EXECUTE'
    ),
  'private selection, cloning, and hash helpers cannot be called directly through the Data API'
);

-- Rollback-only behavioral fixture. It proves that cache delivery happens
-- before paid quota consumption and that one withdrawal invalidates a clone
-- plus every content-deduplicated source while preserving an actual draft.
create temporary table phase_14b_state (
  topic_id uuid,
  source_hash text,
  revision_id uuid,
  clone_id uuid,
  request_job_id uuid,
  request_status text,
  fresh_queue_message_id bigint,
  fresh_practice_test_id uuid,
  fresh_payload jsonb,
  fresh_tamper_rejected boolean,
  workspace_usage_before integer,
  student_usage_before integer,
  first_withdrawal jsonb,
  replay_withdrawal jsonb
) on commit drop;

insert into phase_14b_state default values;
grant select, update on phase_14b_state to authenticated, service_role;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'b1400000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'phase14b-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14B Admin"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1400000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'phase14b-target@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14B Target"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1400000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'phase14b-progress@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14B Progress"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1400000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'phase14b-source@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14B Source"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1400000-0000-4000-8000-000000000005',
    'authenticated', 'authenticated', 'phase14b-fresh@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14B Fresh"}'::jsonb, now(), now()
  );

delete from public.profiles
where id in (
  'b1400000-0000-4000-8000-000000000001',
  'b1400000-0000-4000-8000-000000000002',
  'b1400000-0000-4000-8000-000000000003',
  'b1400000-0000-4000-8000-000000000004',
  'b1400000-0000-4000-8000-000000000005'
);

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'b1400000-0000-4000-8000-000000000001',
    'Phase 14B Admin', 'phase14b-admin@example.test', 'platform_admin'
  ),
  (
    'b1400000-0000-4000-8000-000000000002',
    'Phase 14B Target', 'phase14b-target@example.test', 'student'
  ),
  (
    'b1400000-0000-4000-8000-000000000003',
    'Phase 14B Progress', 'phase14b-progress@example.test', 'student'
  ),
  (
    'b1400000-0000-4000-8000-000000000004',
    'Phase 14B Source', 'phase14b-source@example.test', 'student'
  ),
  (
    'b1400000-0000-4000-8000-000000000005',
    'Phase 14B Fresh', 'phase14b-fresh@example.test', 'student'
  );

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    'b1400000-0000-4000-8000-000000000101',
    'Phase 14B Source Workspace', 'phase-14b-source-workspace',
    'b1400000-0000-4000-8000-000000000001'
  ),
  (
    'b1400000-0000-4000-8000-000000000102',
    'Phase 14B Target Workspace', 'phase-14b-target-workspace',
    'b1400000-0000-4000-8000-000000000001'
  );

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'b1400000-0000-4000-8000-000000000001', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'b1400000-0000-4000-8000-000000000101',
    'b1400000-0000-4000-8000-000000000001', 'owner'
  ),
  (
    'b1400000-0000-4000-8000-000000000102',
    'b1400000-0000-4000-8000-000000000001', 'owner'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'b1400000-0000-4000-8000-000000000102',
    'b1400000-0000-4000-8000-000000000002', 'student'
  ),
  (
    'b1400000-0000-4000-8000-000000000102',
    'b1400000-0000-4000-8000-000000000003', 'student'
  ),
  (
    'b1400000-0000-4000-8000-000000000101',
    'b1400000-0000-4000-8000-000000000004', 'student'
  ),
  (
    'b1400000-0000-4000-8000-000000000101',
    'b1400000-0000-4000-8000-000000000005', 'student'
  ),
  (
    'b1400000-0000-4000-8000-000000000102',
    'b1400000-0000-4000-8000-000000000005', 'student'
  );

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by
)
values
  (
    'b1400000-0000-4000-8000-000000000201',
    'b1400000-0000-4000-8000-000000000101',
    'Phase 14B Source B2 Class', 'B2', true,
    'b1400000-0000-4000-8000-000000000001'
  ),
  (
    'b1400000-0000-4000-8000-000000000202',
    'b1400000-0000-4000-8000-000000000102',
    'Phase 14B Target B2 Class', 'B2', true,
    'b1400000-0000-4000-8000-000000000001'
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    'b1400000-0000-4000-8000-000000000101',
    'b1400000-0000-4000-8000-000000000201',
    'b1400000-0000-4000-8000-000000000004'
  ),
  (
    'b1400000-0000-4000-8000-000000000101',
    'b1400000-0000-4000-8000-000000000201',
    'b1400000-0000-4000-8000-000000000005'
  ),
  (
    'b1400000-0000-4000-8000-000000000102',
    'b1400000-0000-4000-8000-000000000202',
    'b1400000-0000-4000-8000-000000000002'
  ),
  (
    'b1400000-0000-4000-8000-000000000102',
    'b1400000-0000-4000-8000-000000000202',
    'b1400000-0000-4000-8000-000000000003'
  ),
  (
    'b1400000-0000-4000-8000-000000000102',
    'b1400000-0000-4000-8000-000000000202',
    'b1400000-0000-4000-8000-000000000005'
  );

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'b1400000-0000-4000-8000-000000000301',
  'phase14b-cache-fixture', 'Phase 14B Cache Fixture', 'B2',
  'Rollback-only model-cache contract fixture.'
);

update phase_14b_state
set topic_id = 'b1400000-0000-4000-8000-000000000301';

-- Completion jobs are bound to immutable assignment/class context. Create
-- the source assignments before their succeeded job rows so this rollback-
-- only fixture exercises the same guard as live worksheet generation.
insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, generation_status, generation_version,
  generation_started_at, batch_id, worksheet_level,
  class_context_version, class_context_integrity
)
values
  (
    'b1400000-0000-4000-8000-000000000501',
    'b1400000-0000-4000-8000-000000000101',
    'b1400000-0000-4000-8000-000000000004',
    'b1400000-0000-4000-8000-000000000301', null,
    'manual', 'completed', 'b1400000-0000-4000-8000-000000000001',
    'generating', 1, now(),
    'b1400000-0000-4000-8000-000000000201', 'B2',
    1, 'teacher_verified'
  ),
  (
    'b1400000-0000-4000-8000-000000000502',
    'b1400000-0000-4000-8000-000000000101',
    'b1400000-0000-4000-8000-000000000005',
    'b1400000-0000-4000-8000-000000000301', null,
    'manual', 'completed', 'b1400000-0000-4000-8000-000000000001',
    'generating', 1, now(),
    'b1400000-0000-4000-8000-000000000201', 'B2',
    1, 'teacher_verified'
  );

insert into app_private.async_jobs (
  id, queue_name, job_kind, entity_id, entity_version, idempotency_key,
  status, completed_at, requested_by
)
values
  (
    'b1400000-0000-4000-8000-000000000401',
    'worksheet_generation', 'worksheet_generation',
    'b1400000-0000-4000-8000-000000000501', 1,
    'phase14b-source-one', 'succeeded', now(),
    'b1400000-0000-4000-8000-000000000001'
  ),
  (
    'b1400000-0000-4000-8000-000000000402',
    'worksheet_generation', 'worksheet_generation',
    'b1400000-0000-4000-8000-000000000502', 1,
    'phase14b-source-two', 'succeeded', now(),
    'b1400000-0000-4000-8000-000000000001'
  );

insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by, mini_lesson,
  generation_source, quality_status, generator_model, generation_metadata,
  generation_job_id
)
values
  (
    'b1400000-0000-4000-8000-000000000501',
    'b1400000-0000-4000-8000-000000000101',
    'b1400000-0000-4000-8000-000000000301',
    'B2', 'medium', 'Phase 14B Reusable Worksheet',
    'Eight deterministic questions used to test safe cache delivery.',
    true, false, 'workspace', null,
    '{"short_explanation":"Choose the only grammatically valid form.","key_rule":"Use the sentence context.","common_mistake_warning":"Check every option.","what_to_revise":"Review the target form.","correct_examples":["Das Beispiel ist korrekt."]}'::jsonb,
    'deepseek', 'approved', 'deepseek-v4-pro', '{}'::jsonb,
    'b1400000-0000-4000-8000-000000000401'
  ),
  (
    'b1400000-0000-4000-8000-000000000502',
    'b1400000-0000-4000-8000-000000000101',
    'b1400000-0000-4000-8000-000000000301',
    'B2', 'medium', 'Phase 14B Reusable Worksheet',
    'Eight deterministic questions used to test safe cache delivery.',
    true, false, 'workspace', null,
    '{"short_explanation":"Choose the only grammatically valid form.","key_rule":"Use the sentence context.","common_mistake_warning":"Check every option.","what_to_revise":"Review the target form.","correct_examples":["Das Beispiel ist korrekt."]}'::jsonb,
    'deepseek', 'approved', 'deepseek-v4-pro', '{}'::jsonb,
    'b1400000-0000-4000-8000-000000000402'
  );

insert into public.practice_test_questions (
  practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
select
  source_id,
  question_number,
  'multiple_choice',
  'local_exact',
  format('Welche Form ist in Testsatz Nummer %s eindeutig korrekt?', question_number),
  jsonb_build_array(
    format('Antwort %sA', question_number),
    format('Antwort %sB', question_number),
    format('Antwort %sC', question_number)
  ),
  format('Antwort %sA', question_number),
  jsonb_build_array(format('Antwort %sA', question_number)),
  null,
  1,
  format('Nur Antwort %sA erfüllt die eindeutige Bedingung.', question_number)
from unnest(array[
  'b1400000-0000-4000-8000-000000000501'::uuid,
  'b1400000-0000-4000-8000-000000000502'::uuid
]) source_id
cross join generate_series(1, 8) question_number;

update phase_14b_state state
set source_hash = app_private.practice_test_content_sha256(
  'b1400000-0000-4000-8000-000000000501'
);

insert into app_private.worksheet_generation_completions_v2 (
  job_id, practice_test_id, completion_mode, evidence_version,
  provider_source, generator_model,
  primary_critic_provider, primary_critic_model, primary_verdict_sha256,
  secondary_critic_provider, secondary_critic_model, secondary_verdict_sha256,
  candidate_sha256, provider_metadata, payload_sha256, content_sha256
)
select
  fixture.job_id,
  fixture.practice_test_id,
  'generated', 2,
  'deepseek', 'deepseek-v4-pro',
  'deepseek', 'deepseek-v4-flash', repeat('a', 64),
  'gemini', 'gemini-3.1-flash-lite', repeat('b', 64),
  repeat('c', 64), '{}'::jsonb, repeat('d', 64), state.source_hash
from phase_14b_state state
cross join (values
  (
    'b1400000-0000-4000-8000-000000000401'::uuid,
    'b1400000-0000-4000-8000-000000000501'::uuid
  ),
  (
    'b1400000-0000-4000-8000-000000000402'::uuid,
    'b1400000-0000-4000-8000-000000000502'::uuid
  )
) fixture(job_id, practice_test_id);

select set_config('app.model_cache_promotion', 'on', true);

insert into app_private.practice_worksheet_model_cache_revisions (
  id, grammar_topic_id, level, difficulty, title, description, mini_lesson,
  generator_provider, generator_model, validation_metadata,
  source_practice_test_id, source_completion_job_id, candidate_sha256,
  primary_critic_provider, primary_critic_model, primary_verdict_sha256,
  secondary_critic_provider, secondary_critic_model, secondary_verdict_sha256,
  content_sha256
)
select
  'b1400000-0000-4000-8000-000000000601',
  state.topic_id, 'B2', 'medium', 'Phase 14B Reusable Worksheet',
  'Eight deterministic questions used to test safe cache delivery.',
  '{"short_explanation":"Choose the only grammatically valid form.","key_rule":"Use the sentence context.","common_mistake_warning":"Check every option.","what_to_revise":"Review the target form.","correct_examples":["Das Beispiel ist korrekt."]}'::jsonb,
  'deepseek', 'deepseek-v4-pro',
  '{"attempt_count":1,"checks":{"ambiguity_free":true,"no_answer_leakage":true,"duplicate_free":true,"level_fit":true,"topic_fit":true,"type_balance":true,"scoring_safe":true},"content_checks":{"mini_lesson_scope_accurate":true,"learner_cues_semantically_aligned":true,"examples_rubrics_consistent":true}}'::jsonb,
  'b1400000-0000-4000-8000-000000000501',
  'b1400000-0000-4000-8000-000000000401',
  repeat('c', 64), 'deepseek', 'deepseek-v4-flash', repeat('a', 64),
  'gemini', 'gemini-3.1-flash-lite', repeat('b', 64), state.source_hash
from phase_14b_state state;

insert into app_private.practice_worksheet_model_cache_questions (
  revision_id, question_number, question_type, evaluation_mode, prompt,
  options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
select
  'b1400000-0000-4000-8000-000000000601',
  question.question_number, question.question_type, question.evaluation_mode,
  question.prompt, question.options, question.correct_answer,
  question.accepted_answers, question.rubric,
  question.answer_contract_version, question.explanation
from public.practice_test_questions question
where question.practice_test_id = 'b1400000-0000-4000-8000-000000000501'
order by question.question_number;

insert into app_private.practice_worksheet_model_cache_sources (
  source_practice_test_id, revision_id, source_completion_job_id,
  source_content_sha256
)
select
  fixture.practice_test_id,
  'b1400000-0000-4000-8000-000000000601',
  fixture.job_id,
  state.source_hash
from phase_14b_state state
cross join (values
  (
    'b1400000-0000-4000-8000-000000000501'::uuid,
    'b1400000-0000-4000-8000-000000000401'::uuid
  ),
  (
    'b1400000-0000-4000-8000-000000000502'::uuid,
    'b1400000-0000-4000-8000-000000000402'::uuid
  )
) fixture(practice_test_id, job_id);

select set_config('app.model_cache_promotion', 'off', true);

update phase_14b_state state
set revision_id = 'b1400000-0000-4000-8000-000000000601',
    clone_id = app_private.clone_model_validated_worksheet_cache(
      'b1400000-0000-4000-8000-000000000102',
      'b1400000-0000-4000-8000-000000000601',
      null
    );

-- This row has the old approval label and a superficially valid objective
-- question, but no mandatory 7+3 source link. It must never beat the cache.
insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by, mini_lesson,
  generation_source, quality_status, generator_model, generation_metadata
)
values (
  'b1400000-0000-4000-8000-000000000503',
  'b1400000-0000-4000-8000-000000000102',
  'b1400000-0000-4000-8000-000000000301',
  'B2', 'easy', 'Phase 14B Legacy Model Worksheet',
  'Legacy independent-model material without explicit content checks.',
  true, false, 'workspace', null,
  '{"short_explanation":"Legacy evidence.","key_rule":"Legacy evidence.","common_mistake_warning":"Legacy evidence.","what_to_revise":"Legacy evidence.","correct_examples":["Legacy example."]}'::jsonb,
  'deepseek', 'approved', 'deepseek-v4-pro',
  '{"validation":{"deterministic":true,"independent_model":true,"checks":{"ambiguity_free":true,"no_answer_leakage":true,"duplicate_free":true,"level_fit":true,"topic_fit":true,"type_balance":true,"scoring_safe":true}}}'::jsonb
);

insert into public.practice_test_questions (
  practice_test_id, question_number, question_type, evaluation_mode,
  prompt, options, correct_answer, accepted_answers, rubric,
  answer_contract_version, explanation
)
values (
  'b1400000-0000-4000-8000-000000000503', 1,
  'multiple_choice', 'local_exact',
  'Welche Legacy-Antwort wäre formal auswählbar?',
  '["Antwort A","Antwort B","Antwort C"]'::jsonb,
  'Antwort A', '["Antwort A"]'::jsonb, null, 1,
  'Formal gültig, aber ohne neue Inhaltsprüfungen nicht wiederverwendbar.'
);

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, practice_test_id,
  source, status, assigned_by, generation_status, batch_id,
  worksheet_level, class_context_version, class_context_integrity, started_at
)
values
  (
    'b1400000-0000-4000-8000-000000000701',
    'b1400000-0000-4000-8000-000000000102',
    'b1400000-0000-4000-8000-000000000002',
    'b1400000-0000-4000-8000-000000000301',
    'b1400000-0000-4000-8000-000000000503',
    'manual', 'unlocked', 'b1400000-0000-4000-8000-000000000001',
    'ready', 'b1400000-0000-4000-8000-000000000202',
    'B2', 1, 'teacher_verified', null
  ),
  (
    'b1400000-0000-4000-8000-000000000702',
    'b1400000-0000-4000-8000-000000000102',
    'b1400000-0000-4000-8000-000000000003',
    'b1400000-0000-4000-8000-000000000301',
    (select clone_id from phase_14b_state),
    'manual', 'in_progress', 'b1400000-0000-4000-8000-000000000001',
    'ready', 'b1400000-0000-4000-8000-000000000202',
    'B2', 1, 'teacher_verified', now()
  ),
  (
    'b1400000-0000-4000-8000-000000000703',
    'b1400000-0000-4000-8000-000000000101',
    'b1400000-0000-4000-8000-000000000004',
    'b1400000-0000-4000-8000-000000000301',
    'b1400000-0000-4000-8000-000000000501',
    'manual', 'unlocked', 'b1400000-0000-4000-8000-000000000001',
    'ready', 'b1400000-0000-4000-8000-000000000201',
    'B2', 1, 'teacher_verified', null
  ),
  (
    'b1400000-0000-4000-8000-000000000704',
    'b1400000-0000-4000-8000-000000000102',
    'b1400000-0000-4000-8000-000000000005',
    'b1400000-0000-4000-8000-000000000301', null,
    'manual', 'unlocked', 'b1400000-0000-4000-8000-000000000001',
    'generating', 'b1400000-0000-4000-8000-000000000202',
    'B2', 1, 'teacher_verified', null
  );

insert into app_private.practice_drafts (
  assignment_id, workspace_id, student_id, answers
)
values (
  'b1400000-0000-4000-8000-000000000702',
  'b1400000-0000-4000-8000-000000000102',
  'b1400000-0000-4000-8000-000000000003',
  '[]'::jsonb
);

select ok(
  app_private.practice_assignment_has_withdrawn_unstarted_clone(
    'b1400000-0000-4000-8000-000000000701'
  )
    and not app_private.practice_test_canonical_revision_is_current(
      'b1400000-0000-4000-8000-000000000503'
    ),
  'an existing unstarted legacy independent-model assignment is replacement-required'
);

insert into app_private.ai_workspace_daily_usage (
  workspace_id, usage_day, generation_job_count
)
select
  'b1400000-0000-4000-8000-000000000102',
  (now() at time zone 'UTC')::date,
  limits.max_generation_jobs_per_workspace_day
from app_private.ai_paid_work_limits limits
where limits.singleton;

insert into app_private.ai_student_daily_usage (
  workspace_id, student_id, usage_day, generation_job_count
)
select
  'b1400000-0000-4000-8000-000000000102',
  'b1400000-0000-4000-8000-000000000002',
  (now() at time zone 'UTC')::date,
  limits.max_generation_jobs_per_student_workspace_day
from app_private.ai_paid_work_limits limits
where limits.singleton;

update phase_14b_state state
set workspace_usage_before = workspace_usage.generation_job_count,
    student_usage_before = student_usage.generation_job_count
from app_private.ai_workspace_daily_usage workspace_usage,
     app_private.ai_student_daily_usage student_usage
where workspace_usage.workspace_id = 'b1400000-0000-4000-8000-000000000102'
  and workspace_usage.usage_day = (now() at time zone 'UTC')::date
  and student_usage.workspace_id = workspace_usage.workspace_id
  and student_usage.student_id = 'b1400000-0000-4000-8000-000000000002'
  and student_usage.usage_day = workspace_usage.usage_day;

select set_config(
  'request.jwt.claims',
  '{"sub":"b1400000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', 'b1400000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with requested as (
  select *
  from api.request_practice_worksheet(
    'b1400000-0000-4000-8000-000000000701'
  )
)
update phase_14b_state state
set request_job_id = requested.job_id,
    request_status = requested.generation_status
from requested;

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '{}', true);

select ok(
  exists (
    select 1
    from phase_14b_state state
    where state.source_hash = app_private.practice_test_content_sha256(
        'b1400000-0000-4000-8000-000000000502'
      )
      and app_private.practice_worksheet_model_cache_revision_is_current(
        state.revision_id
      )
      and (
        select count(*)
        from app_private.practice_worksheet_model_cache_sources source_link
        where source_link.revision_id = state.revision_id
      ) = 2
      and app_private.practice_test_canonical_revision_is_current(
        'b1400000-0000-4000-8000-000000000501'
      )
      and app_private.practice_test_canonical_revision_is_current(
        'b1400000-0000-4000-8000-000000000502'
      )
      and not app_private.practice_test_canonical_revision_is_current(
        'b1400000-0000-4000-8000-000000000503'
      )
  ),
  'two linked sources are current while an unlinked legacy model row is quarantined'
);

select ok(
  exists (
    select 1
    from phase_14b_state state
    join public.student_practice_assignments assignment
      on assignment.id = 'b1400000-0000-4000-8000-000000000701'
    join app_private.practice_worksheet_model_cache_attachment_events event
      on event.assignment_id = assignment.id
     and event.cache_revision_id = state.revision_id
     and event.cloned_practice_test_id = state.clone_id
     and event.attachment_source = 'request'
    where state.request_status = 'ready'
      and state.request_job_id is null
      and assignment.practice_test_id = state.clone_id
      and assignment.generation_status = 'ready'
      and not exists (
        select 1
        from app_private.async_jobs job
        where job.job_kind = 'worksheet_generation'
          and job.entity_id = assignment.id
      )
  ),
  'an authenticated request replaces legacy material with the safe cache without a paid job'
);

select ok(
  exists (
    select 1
    from phase_14b_state state
    join app_private.ai_workspace_daily_usage workspace_usage
      on workspace_usage.workspace_id = 'b1400000-0000-4000-8000-000000000102'
     and workspace_usage.usage_day = (now() at time zone 'UTC')::date
    join app_private.ai_student_daily_usage student_usage
      on student_usage.workspace_id = workspace_usage.workspace_id
     and student_usage.student_id = 'b1400000-0000-4000-8000-000000000002'
     and student_usage.usage_day = workspace_usage.usage_day
    where workspace_usage.generation_job_count = state.workspace_usage_before
      and student_usage.generation_job_count = state.student_usage_before
  ),
  'cache delivery succeeds at exhausted generation quota without consuming either counter'
);

-- Exercise the real completion facade before promotion links the worksheet.
-- This is the exact ordering that the assignment attachment guard must allow.
create or replace function pg_temp.phase_14b_approved_candidate(
  candidate jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  candidate_hash text := app_private.worksheet_candidate_sha256(candidate);
  passing_checks jsonb := jsonb_build_object(
    'ambiguity_free', true,
    'no_answer_leakage', true,
    'duplicate_free', true,
    'level_fit', true,
    'topic_fit', true,
    'type_balance', true,
    'scoring_safe', true
  );
  passing_content_checks jsonb := jsonb_build_object(
    'mini_lesson_scope_accurate', true,
    'learner_cues_semantically_aligned', true,
    'examples_rubrics_consistent', true
  );
  deepseek_critic jsonb;
  gemini_critic jsonb;
begin
  deepseek_critic := jsonb_build_object(
    'provider', 'deepseek',
    'model', 'deepseek-v4-flash',
    'candidate_sha256', candidate_hash,
    'approved', true,
    'checks', passing_checks,
    'content_checks', passing_content_checks,
    'rejection_reasons', '[]'::jsonb
  );
  deepseek_critic := deepseek_critic || jsonb_build_object(
    'verdict_sha256',
    app_private.worksheet_critic_verdict_sha256(deepseek_critic)
  );

  gemini_critic := jsonb_build_object(
    'provider', 'gemini',
    'model', 'gemini-3.1-flash-lite',
    'candidate_sha256', candidate_hash,
    'approved', true,
    'checks', passing_checks,
    'content_checks', passing_content_checks,
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
      'candidate_sha256', candidate_hash,
      'critics', jsonb_build_object(
        'deepseek', deepseek_critic,
        'gemini', gemini_critic
      ),
      'attempt_count', 1,
      'checks', passing_checks,
      'content_checks', passing_content_checks,
      'rejection_reasons', '[]'::jsonb
    )
  );
end;
$$;

update phase_14b_state
set fresh_payload = pg_temp.phase_14b_approved_candidate(
  jsonb_build_object(
    'schema_version', 1,
    'mode', 'generated',
    'generation_source', 'deepseek',
    'level', 'B2',
    'difficulty', 'medium',
    'title', 'Phase 14B Fresh Generated Worksheet',
    'description',
      'Eight exact questions proving the pre-promotion completion window.',
    'generator_model', 'deepseek-v4-pro',
    'mini_lesson', jsonb_build_object(
      'short_explanation',
        'Wähle in jedem Satz die einzige grammatisch passende Form.',
      'key_rule',
        'Prüfe Satzfunktion und Kontext, bevor du eine Form auswählst.',
      'common_mistake_warning',
        'Eine ähnlich klingende Form ist nicht automatisch grammatisch richtig.',
      'what_to_revise',
        'Wiederhole die Zielstruktur anhand eindeutiger Kontexte.',
      'correct_examples',
        jsonb_build_array('Das Beispiel ist eindeutig korrekt.')
    ),
    'source_mix', jsonb_build_object(
      'mode', 'deepseek',
      'deepseek_count', 8,
      'gemini_count', 0
    ),
    'questions', (
      select jsonb_agg(
        jsonb_build_object(
          'question_number', question_number,
          'question_type', 'multiple_choice',
          'evaluation_mode', 'local_exact',
          'prompt', format(
            'Welche Form passt eindeutig in den B2-Testsatz Nummer %s?',
            question_number
          ),
          'options', jsonb_build_array(
            format('Form %sA', question_number),
            format('Form %sB', question_number),
            format('Form %sC', question_number)
          ),
          'correct_answer', format('Form %sA', question_number),
          'accepted_answers', jsonb_build_array(
            format('Form %sA', question_number)
          ),
          'rubric', null,
          'explanation', format(
            'Nur Form %sA erfüllt die eindeutige Satzbedingung.',
            question_number
          )
        )
        order by question_number
      )
      from generate_series(1, 8) question_number
    )
  )
);

update public.student_practice_assignments assignment
set
  generation_version = 1,
  generation_started_at = now()
where assignment.id = 'b1400000-0000-4000-8000-000000000704';

with sent as (
  select pgmq.send(
    'worksheet_generation',
    jsonb_build_object(
      'job_id', 'b1400000-0000-4000-8000-000000000403'::uuid,
      'job_kind', 'worksheet_generation',
      'entity_id', 'b1400000-0000-4000-8000-000000000704'::uuid,
      'entity_version', 1
    ),
    0
  ) as queue_message_id
)
update phase_14b_state state
set fresh_queue_message_id = sent.queue_message_id
from sent;

insert into app_private.async_jobs (
  id, queue_name, job_kind, entity_id, entity_version, idempotency_key,
  status, attempt_count, queue_message_id, worker_id, available_at,
  lease_expires_at, first_started_at, last_started_at, requested_by
)
select
  'b1400000-0000-4000-8000-000000000403',
  'worksheet_generation', 'worksheet_generation',
  'b1400000-0000-4000-8000-000000000704', 1,
  'phase14b-fresh-generated', 'processing', 1,
  state.fresh_queue_message_id,
  'b1400000-0000-4000-8000-000000000901', now(),
  now() + interval '5 minutes', now(), now(),
  'b1400000-0000-4000-8000-000000000001'
from phase_14b_state state;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$
    with completed as (
      select *
      from api.complete_worksheet_generation(
        'b1400000-0000-4000-8000-000000000403',
        (select fresh_queue_message_id from phase_14b_state),
        'b1400000-0000-4000-8000-000000000901',
        (select fresh_payload from phase_14b_state)
      )
    )
    update phase_14b_state state
    set fresh_practice_test_id = completed.practice_test_id
    from completed
    where completed.assignment_id =
        'b1400000-0000-4000-8000-000000000704'
      and completed.generation_status = 'ready'
      and completed.quality_status = 'approved'
  $$,
  'the production completion facade succeeds before cache promotion links the worksheet'
);

reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '{}', true);

select ok(
  exists (
    select 1
    from phase_14b_state state
    join public.student_practice_assignments assignment
      on assignment.id = 'b1400000-0000-4000-8000-000000000704'
    join public.practice_tests worksheet
      on worksheet.id = state.fresh_practice_test_id
    join app_private.async_jobs job
      on job.id = 'b1400000-0000-4000-8000-000000000403'
    where assignment.practice_test_id = worksheet.id
      and assignment.generation_status = 'ready'
      and worksheet.generated_from_assignment_id = assignment.id
      and worksheet.approval_source = 'independent_model_validation'
      and job.status = 'succeeded'
      and not exists (
        select 1
        from app_private.practice_worksheet_model_cache_sources source_link
        where source_link.source_practice_test_id = worksheet.id
      )
      and app_private.practice_test_has_current_unlinked_model_evidence(
        worksheet.id
      )
      and app_private.practice_test_canonical_revision_is_current(worksheet.id)
  ),
  'fresh exact 7+3 completion evidence is current during the unlinked promotion window'
);

update public.practice_tests worksheet
set title = worksheet.title || ' tampered'
where worksheet.id = (
  select fresh_practice_test_id from phase_14b_state
);

update phase_14b_state state
set fresh_tamper_rejected = not
  app_private.practice_test_has_current_unlinked_model_evidence(
    state.fresh_practice_test_id
  );

update public.practice_tests worksheet
set title = 'Phase 14B Fresh Generated Worksheet'
where worksheet.id = (
  select fresh_practice_test_id from phase_14b_state
);

select ok(
  (select fresh_tamper_rejected from phase_14b_state)
    and app_private.practice_test_has_current_unlinked_model_evidence(
      (select fresh_practice_test_id from phase_14b_state)
    ),
  'post-completion content tampering fails closed and exact restoration requalifies evidence'
);

select lives_ok(
  $$
    insert into public.practice_test_attempts (
      id, practice_test_id, student_id, workspace_id, assignment_id,
      answers, score, max_score, status, completed_at, evaluation_status
    ) values (
      'b1400000-0000-4000-8000-000000000804',
      (select fresh_practice_test_id from phase_14b_state),
      'b1400000-0000-4000-8000-000000000005',
      'b1400000-0000-4000-8000-000000000102',
      'b1400000-0000-4000-8000-000000000704',
      '[]'::jsonb, 0, 0, 'checked', now(), 'not_needed'
    )
  $$,
  'a student can start the fresh generated worksheet before cache promotion'
);

-- Create the ordinary destination only after the request assertion so it
-- cannot outrank the cache in the same-workspace reuse branch.
insert into public.practice_tests (
  id, workspace_id, grammar_topic_id, level, difficulty, title, description,
  created_by_ai, teacher_reviewed, visibility, created_by,
  generation_source, quality_status
)
values (
  'b1400000-0000-4000-8000-000000000504',
  'b1400000-0000-4000-8000-000000000102',
  'b1400000-0000-4000-8000-000000000301',
  'B2', 'easy', 'Phase 14B Ordinary Worksheet',
  'Mutation-control destination.', false, true, 'workspace',
  'b1400000-0000-4000-8000-000000000001',
  'teacher_created', 'approved'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

update phase_14b_state state
set first_withdrawal = api.withdraw_model_validated_worksheet_cache(
  state.revision_id,
  state.source_hash,
  'b1400000-0000-4000-8000-000000000001',
  'Phase 14B verified withdrawal reason.'
);

update phase_14b_state state
set replay_withdrawal = api.withdraw_model_validated_worksheet_cache(
  state.revision_id,
  state.source_hash,
  'b1400000-0000-4000-8000-000000000001',
  'Phase 14B verified withdrawal reason.'
);

select throws_ok(
  $$
    select api.withdraw_model_validated_worksheet_cache(
      (select revision_id from phase_14b_state),
      (select source_hash from phase_14b_state),
      'b1400000-0000-4000-8000-000000000001',
      'Phase 14B different withdrawal reason.'
    )
  $$,
  '55000',
  'model_cache_withdrawal_replay_mismatch',
  'withdrawal replay rejects a changed actor or reason contract'
);

reset role;
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '{}', true);

select ok(
  (select first_withdrawal ->> 'created' = 'true' from phase_14b_state)
    and (select replay_withdrawal ->> 'created' = 'false' from phase_14b_state)
    and app_private.practice_test_canonical_revision_is_current(
      'b1400000-0000-4000-8000-000000000504'
    ),
  'withdrawal replay is idempotent and ordinary human-reviewed material remains current'
);

select ok(
  exists (
    select 1
    from phase_14b_state state
    where not app_private.practice_worksheet_model_cache_revision_is_current(
        state.revision_id
      )
      and not app_private.practice_test_canonical_revision_is_current(
        'b1400000-0000-4000-8000-000000000501'
      )
      and not app_private.practice_test_canonical_revision_is_current(
        'b1400000-0000-4000-8000-000000000502'
      )
      and not app_private.practice_test_canonical_revision_is_current(
        state.clone_id
      )
      and app_private.select_model_validated_worksheet_cache(
        'b1400000-0000-4000-8000-000000000102',
        'b1400000-0000-4000-8000-000000000002',
        state.topic_id,
        'B2',
        null,
        true
      ) is null
  ),
  'one withdrawal invalidates the shared revision, both sources, clone, and selector'
);

select throws_ok(
  $$
    select app_private.clone_model_validated_worksheet_cache(
      'b1400000-0000-4000-8000-000000000102',
      (select revision_id from phase_14b_state),
      null
    )
  $$,
  'P0002',
  'model_cache_revision_not_available',
  'a withdrawn revision cannot be cloned again'
);

select ok(
  app_private.practice_assignment_has_withdrawn_unstarted_clone(
    'b1400000-0000-4000-8000-000000000701'
  )
    and app_private.practice_assignment_has_withdrawn_unstarted_clone(
      'b1400000-0000-4000-8000-000000000703'
    ),
  'unstarted withdrawn cache-clone and reverse-source assignments are both detected'
);

select throws_ok(
  $$
    update public.student_practice_assignments
    set practice_test_id = 'b1400000-0000-4000-8000-000000000502'
    where id = 'b1400000-0000-4000-8000-000000000703'
  $$,
  '55000',
  'withdrawn_canonical_worksheet_not_reusable',
  'future attachment of a deduplicated withdrawn source is blocked'
);

select throws_ok(
  $$
    insert into public.practice_test_attempts (
      id, practice_test_id, student_id, workspace_id, assignment_id,
      answers, score, max_score, status, completed_at, evaluation_status
    ) values (
      'b1400000-0000-4000-8000-000000000801',
      (select clone_id from phase_14b_state),
      'b1400000-0000-4000-8000-000000000002',
      'b1400000-0000-4000-8000-000000000102',
      'b1400000-0000-4000-8000-000000000701',
      '[]'::jsonb, 0, 0, 'checked', now(), 'not_needed'
    )
  $$,
  '55000',
  'worksheet_withdrawn_replacement_required',
  'a new attempt cannot start against the withdrawn cache clone'
);

select throws_ok(
  $$
    insert into public.practice_test_attempts (
      id, practice_test_id, student_id, workspace_id, assignment_id,
      answers, score, max_score, status, completed_at, evaluation_status
    ) values (
      'b1400000-0000-4000-8000-000000000802',
      'b1400000-0000-4000-8000-000000000501',
      'b1400000-0000-4000-8000-000000000004',
      'b1400000-0000-4000-8000-000000000101',
      'b1400000-0000-4000-8000-000000000703',
      '[]'::jsonb, 0, 0, 'checked', now(), 'not_needed'
    )
  $$,
  '55000',
  'worksheet_withdrawn_replacement_required',
  'a new attempt cannot start against any withdrawn reverse-linked source'
);

select lives_ok(
  $$
    insert into public.practice_test_attempts (
      id, practice_test_id, student_id, workspace_id, assignment_id,
      answers, score, max_score, status, completed_at, evaluation_status
    ) values (
      'b1400000-0000-4000-8000-000000000803',
      (select clone_id from phase_14b_state),
      'b1400000-0000-4000-8000-000000000003',
      'b1400000-0000-4000-8000-000000000102',
      'b1400000-0000-4000-8000-000000000702',
      '[]'::jsonb, 0, 0, 'checked', now(), 'not_needed'
    )
  $$,
  'an actual in-progress autosaved draft may finish its historical clone'
);

select throws_ok(
  $$
    update public.practice_test_questions
    set practice_test_id = 'b1400000-0000-4000-8000-000000000504'
    where practice_test_id = (select clone_id from phase_14b_state)
      and question_number = 1
  $$,
  '55000',
  'model_cache_clone_immutable',
  'a question cannot be moved out of an immutable cache clone'
);

select * from finish();
rollback;
