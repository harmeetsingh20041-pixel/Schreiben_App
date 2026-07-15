begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(15);

select ok(
  exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'app_private'
      and column_info.table_name = 'worksheet_generation_checkpoints'
      and column_info.column_name = 'deepseek_critic_evidence'
      and column_info.data_type = 'jsonb'
  )
    and exists (
      select 1
      from information_schema.columns column_info
      where column_info.table_schema = 'app_private'
        and column_info.table_name = 'worksheet_generation_checkpoints'
        and column_info.column_name = 'gemini_critic_evidence'
        and column_info.data_type = 'jsonb'
    ),
  'both provider verdict checkpoints are private JSONB columns'
);

with evidence_without_hash as (
  select jsonb_build_object(
    'provider', 'deepseek',
    'model', 'deepseek-v4-flash',
    'candidate_sha256', repeat('a', 64),
    'approved', true,
    'checks', jsonb_build_object(
      'ambiguity_free', true,
      'no_answer_leakage', true,
      'duplicate_free', true,
      'level_fit', true,
      'topic_fit', true,
      'type_balance', true,
      'scoring_safe', true
    ),
    'content_checks', jsonb_build_object(
      'mini_lesson_scope_accurate', true,
      'learner_cues_semantically_aligned', true,
      'examples_rubrics_consistent', true
    ),
    'rejection_reasons', '[]'::jsonb
  ) as payload
), evidence as (
  select payload || jsonb_build_object(
    'verdict_sha256', encode(
      sha256(convert_to(app_private.canonical_jsonb_text(payload), 'UTF8')),
      'hex'
    )
  ) as payload
  from evidence_without_hash
)
select ok(
  app_private.is_valid_worksheet_checkpoint_critic(
    payload,
    'deepseek',
    'deepseek-v4-flash',
    repeat('a', 64)
  ),
  'an exact normalized DeepSeek verdict validates'
)
from evidence;

with evidence_without_hash as (
  select jsonb_build_object(
    'provider', 'deepseek',
    'model', 'deepseek-v4-flash',
    'candidate_sha256', repeat('a', 64),
    'approved', true,
    'checks', jsonb_build_object(
      'ambiguity_free', true,
      'no_answer_leakage', true,
      'duplicate_free', true,
      'level_fit', true,
      'topic_fit', true,
      'type_balance', true,
      'scoring_safe', true
    ),
    'content_checks', jsonb_build_object(
      'mini_lesson_scope_accurate', true,
      'learner_cues_semantically_aligned', true,
      'examples_rubrics_consistent', true
    ),
    'rejection_reasons', '[]'::jsonb
  ) as payload
), evidence as (
  select payload || jsonb_build_object(
    'verdict_sha256', encode(
      sha256(convert_to(app_private.canonical_jsonb_text(payload), 'UTF8')),
      'hex'
    )
  ) as payload
  from evidence_without_hash
)
select ok(
  not app_private.is_valid_worksheet_checkpoint_critic(
    payload,
    'deepseek',
    'deepseek-v4-flash',
    repeat('b', 64)
  ),
  'candidate-hash mismatch cannot replay persisted evidence'
)
from evidence;

select ok(
  to_regprocedure(
    'api.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'
  ) is not null
    and to_regprocedure(
      'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'
    ) is not null,
  'service facade and private critic checkpoint implementation exist'
);

select ok(
  (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
  )
    and (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ),
  'API facade and private implementation are security definers with fixed search paths'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'api.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)',
      'EXECUTE'
    ),
  'service_role can invoke only the facade, while browser roles can invoke neither path'
);

select ok(
  not exists (
    select 1
    from unnest(array['anon', 'authenticated', 'service_role']) role_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) privilege_name
    where has_table_privilege(
      role_name,
      'app_private.worksheet_generation_checkpoints',
      privilege_name
    )
  )
    and not exists (
      select 1
      from pg_policy policy
      where policy.polrelid =
        'app_private.worksheet_generation_checkpoints'::regclass
    ),
  'partial verdict content has no direct service or browser table path'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'app_private.worksheet_generation_checkpoints'::regclass
      and trigger_row.tgname =
        'worksheet_generation_checkpoints_guard_partial_critics'
      and not trigger_row.tgisinternal
  ),
  'checkpoint transitions are guarded by a partial-critic trigger'
);

select ok(
  (
    select pg_get_functiondef(routine.oid)
    from pg_proc routine
    where routine.oid =
      'app_private.guard_worksheet_partial_critics()'::regprocedure
  ) ilike '%new.stage = ''completion''%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.guard_worksheet_partial_critics()'::regprocedure
    ) ilike '%worksheet_checkpoint_dual_critic_evidence_required%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.guard_worksheet_partial_critics()'::regprocedure
    ) ilike '%new.stage = ''repair_generation''%',
  'one critic can neither finalize nor authorize semantic repair'
);

select ok(
  (
    select pg_get_functiondef(routine.oid)
    from pg_proc routine
    where routine.oid =
      'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
  ) ilike '%assert_active_worksheet_generation_lease%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%candidate_sha256 <> target_candidate_sha256%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%for update%',
  'writer locks and revalidates the exact lease, version, stage, and candidate'
);

select ok(
  (
    select pg_get_functiondef(routine.oid)
    from pg_proc routine
    where routine.oid =
      'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
  ) ilike '%app_private.ai_spend_reservations%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%call_purpose <> ''worksheet_critique''%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%target_candidate_attempt is null%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%worksheet_generation:job_%candidate_%:critique%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%expected_retry_call_key := expected_primary_call_key || ''_retry''%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%spend_reservation.state is distinct from ''reserved''%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%spend_reservation.state is distinct from ''finalized''%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%spend_finalization.replayed is distinct from was_replayed%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%finalize_ai_spend_reservation%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure
    ) ilike '%was_replayed%',
  'one transaction binds exact critic call identity and reservation state, persists evidence, finalizes usage, and supports exact replay'
);

select ok(
  (
    select pg_get_functiondef(routine.oid)
    from pg_proc routine
    where routine.oid =
      'app_private.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)'::regprocedure
  ) ilike '%assert_active_worksheet_generation_lease%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)'::regprocedure
    ) ilike '%checkpoint.deepseek_critic_evidence%'
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)'::regprocedure
    ) ilike '%checkpoint.gemini_critic_evidence%',
  'retry loader returns only exact-lease private evidence for both critics'
);

select ok(
  (
    select count(*) = 3
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.worksheet_generation_checkpoints'::regclass
      and constraint_row.conname in (
        'worksheet_generation_checkpoints_deepseek_critic_check',
        'worksheet_generation_checkpoints_gemini_critic_check',
        'worksheet_generation_checkpoints_partial_critic_stage_check'
      )
  ),
  'provider evidence and stage binding are enforced by table constraints'
);

select ok(
  not has_function_privilege(
    'anon',
    'api.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'api.get_worksheet_generation_checkpoint(uuid,bigint,uuid,integer)',
      'EXECUTE'
    ),
  'extended checkpoint loader remains service-only'
);

select ok(
  (
    select count(*) = 2
    from pg_trigger trigger_row
    where trigger_row.tgname in (
      'async_jobs_cleanup_worksheet_generation_checkpoint',
      'practice_assignments_cleanup_worksheet_generation_checkpoint'
    )
      and not trigger_row.tgisinternal
  )
    and (
      select pg_get_functiondef(routine.oid)
      from pg_proc routine
      where routine.oid =
        'app_private.cleanup_worksheet_generation_checkpoint()'::regprocedure
    ) ilike '%delete from app_private.worksheet_generation_checkpoints%',
  'terminal, superseded, and offboarded work deletes partial critic content with its checkpoint row'
);

select * from finish(true);
rollback;
