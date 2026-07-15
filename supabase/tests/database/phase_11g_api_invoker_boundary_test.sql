begin;

select plan(11);

with expected_definers(routine_oid, service_role_execute) as (
  values
    (
      'api.complete_worksheet_generation_openai_legacy(uuid,bigint,uuid,jsonb)'::regprocedure,
      false
    ),
    (
      'api.get_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,integer,integer)'::regprocedure,
      true
    ),
    (
      'api.get_worksheet_answer_provider_checkpoints(uuid,bigint,uuid,uuid,integer,text,text,text,integer,integer)'::regprocedure,
      true
    ),
    ('api.promote_model_validated_worksheet(uuid)'::regprocedure, true),
    ('api.promote_pending_model_validated_worksheets(integer)'::regprocedure, true),
    ('api.recover_current_certified_worksheet_assignments(integer)'::regprocedure, true),
    ('api.recover_current_model_cache_assignments(integer)'::regprocedure, true),
    ('api.reset_worksheet_bank_terminal_rescue_failure(uuid,uuid)'::regprocedure, true),
    (
      'api.save_worksheet_answer_adjudication_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure,
      true
    ),
    (
      'api.save_worksheet_answer_provider_checkpoint(uuid,bigint,uuid,uuid,integer,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint,integer,integer)'::regprocedure,
      true
    ),
    (
      'api.save_worksheet_generation_critic_evidence(uuid,bigint,uuid,integer,smallint,text,text,text,text,jsonb,text,text,bigint,bigint,bigint,bigint)'::regprocedure,
      true
    ),
    (
      'api.try_complete_current_certified_worksheet_bank_fallback(uuid,bigint,uuid,text,jsonb)'::regprocedure,
      true
    ),
    (
      'api.try_complete_current_model_cache_fallback(uuid,bigint,uuid,text,jsonb)'::regprocedure,
      true
    ),
    (
      'api.withdraw_model_validated_worksheet_cache(uuid,text,uuid,text)'::regprocedure,
      true
    )
), actual_definers(routine_oid) as (
  select routine.oid
  from pg_proc routine
  join pg_namespace namespace on namespace.oid = routine.pronamespace
  where namespace.nspname = 'api'
    and routine.prosecdef
)
select ok(
  (
    select array_agg(actual.routine_oid order by actual.routine_oid)
    from actual_definers actual
  ) = (
    select array_agg(expected.routine_oid::oid order by expected.routine_oid::oid)
    from expected_definers expected
  )
    and not exists (
      select 1
      from expected_definers expected
      join pg_proc routine on routine.oid = expected.routine_oid
      where not exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
        or has_function_privilege(
          'anon', expected.routine_oid, 'EXECUTE'
        )
        or has_function_privilege(
          'authenticated', expected.routine_oid, 'EXECUTE'
        )
        or has_function_privilege(
          'service_role', expected.routine_oid, 'EXECUTE'
        ) is distinct from expected.service_role_execute
        or exists (
          select 1
          from aclexplode(
            coalesce(routine.proacl, acldefault('f', routine.proowner))
          ) privilege
          where privilege.grantee = 0
            and privilege.privilege_type = 'EXECUTE'
        )
    ),
  'only the exact sealed service boundaries retain definer authority and reviewed grants'
);

select ok(
  to_regprocedure('public.get_feedback_draft_internal(uuid)') is not null
    and to_regprocedure(
      'public.update_feedback_draft_internal(uuid,jsonb,integer)'
    ) is not null
    and to_regprocedure('public.release_feedback_internal(uuid,uuid)') is not null
    and to_regprocedure(
      'public.list_feedback_review_queue_page_internal(uuid,text,integer,timestamptz,uuid)'
    ) is not null
    and to_regprocedure(
      'public.save_writing_draft_internal(uuid,uuid,text,uuid,text,integer)'
    ) is not null
    and to_regprocedure('public.get_writing_draft_internal(uuid)') is not null
    and to_regprocedure(
      'public.get_writing_draft_by_context_internal(uuid,uuid,text,uuid)'
    ) is not null
    and to_regprocedure(
      'public.list_my_writing_drafts_internal(uuid,integer)'
    ) is not null
    and to_regprocedure(
      'public.submit_writing_draft_internal(uuid,integer)'
    ) is not null
    and to_regprocedure(
      'public.save_practice_draft_internal(uuid,jsonb,integer)'
    ) is not null
    and to_regprocedure('public.get_practice_draft_internal(uuid)') is not null
    and to_regprocedure(
      'public.submit_practice_draft_internal(uuid,integer)'
    ) is not null
    and to_regprocedure(
      'public.record_recovery_heartbeat_internal(uuid)'
    ) is not null
    and to_regprocedure('public.get_recovery_health_internal()') is not null,
  'privileged bodies live behind non-exposed internal entry points'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'public.get_feedback_draft_internal(uuid)'::regprocedure,
      'public.update_feedback_draft_internal(uuid,jsonb,integer)'::regprocedure,
      'public.release_feedback_internal(uuid,uuid)'::regprocedure,
      'public.list_feedback_review_queue_page_internal(uuid,text,integer,timestamptz,uuid)'::regprocedure,
      'public.save_writing_draft_internal(uuid,uuid,text,uuid,text,integer)'::regprocedure,
      'public.get_writing_draft_internal(uuid)'::regprocedure,
      'public.get_writing_draft_by_context_internal(uuid,uuid,text,uuid)'::regprocedure,
      'public.list_my_writing_drafts_internal(uuid,integer)'::regprocedure,
      'public.submit_writing_draft_internal(uuid,integer)'::regprocedure,
      'public.save_practice_draft_internal(uuid,jsonb,integer)'::regprocedure,
      'public.get_practice_draft_internal(uuid)'::regprocedure,
      'public.submit_practice_draft_internal(uuid,integer)'::regprocedure,
      'public.record_recovery_heartbeat_internal(uuid)'::regprocedure,
      'public.get_recovery_health_internal()'::regprocedure
    ]) as expected(internal_oid)
    join pg_proc routine on routine.oid = expected.internal_oid
    where not routine.prosecdef
      or not exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
  ),
  'every non-exposed implementation retains definer authority and an empty search path'
);

with draft_boundary(routine_oid) as (
  values
    ('api.save_writing_draft(uuid,uuid,text,uuid,text,integer)'::regprocedure),
    ('api.submit_writing_draft(uuid,integer)'::regprocedure),
    ('api.save_practice_draft(uuid,jsonb,integer)'::regprocedure),
    ('api.submit_practice_attempt(uuid,integer)'::regprocedure)
)
select ok(
  not exists (
    select 1
    from draft_boundary boundary
    join pg_proc routine on routine.oid = boundary.routine_oid
    join pg_language language on language.oid = routine.prolang
    where routine.prosecdef
      or language.lanname <> 'plpgsql'
      or not exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
      or lower(pg_get_functiondef(routine.oid)) not like
        '%when sqlstate ''40001''%'
      or lower(pg_get_functiondef(routine.oid)) not like
        '%if sqlerrm = ''draft_revision_conflict''%'
      or lower(pg_get_functiondef(routine.oid)) not like
        '%errcode = ''pt412''%'
      or lower(pg_get_functiondef(routine.oid)) !~
        'raise;[[:space:]]*end;'
  ),
  'draft wrappers are invoker PL/pgSQL boundaries that narrowly translate conflicts and otherwise rethrow'
);

with draft_boundary(routine_oid) as (
  values
    ('api.save_writing_draft(uuid,uuid,text,uuid,text,integer)'::regprocedure),
    ('api.submit_writing_draft(uuid,integer)'::regprocedure),
    ('api.save_practice_draft(uuid,jsonb,integer)'::regprocedure),
    ('api.submit_practice_attempt(uuid,integer)'::regprocedure)
)
select ok(
  not exists (
    select 1
    from draft_boundary boundary
    join pg_proc routine on routine.oid = boundary.routine_oid
    where not has_function_privilege(
        'authenticated', boundary.routine_oid, 'EXECUTE'
      )
      or has_function_privilege('anon', boundary.routine_oid, 'EXECUTE')
      or exists (
        select 1
        from aclexplode(
          coalesce(routine.proacl, acldefault('f', routine.proowner))
        ) privilege
        where privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE'
      )
  ),
  'draft conflict wrappers remain authenticated-only with no anonymous or PUBLIC execute grant'
);

with rate_boundary(routine_oid, expected_messages) as (
  values
    (
      'api.submit_writing(uuid,text,uuid,text)'::regprocedure,
      array[
        'writing_daily_quota_exceeded',
        'writing_monthly_quota_exceeded',
        'workspace_ai_daily_budget_exceeded',
        'student_ai_daily_budget_exceeded',
        'student_ai_monthly_budget_exceeded'
      ]::text[]
    ),
    (
      'api.submit_writing_draft(uuid,integer)'::regprocedure,
      array[
        'writing_daily_quota_exceeded',
        'writing_monthly_quota_exceeded',
        'workspace_ai_daily_budget_exceeded',
        'student_ai_daily_budget_exceeded',
        'student_ai_monthly_budget_exceeded'
      ]::text[]
    ),
    (
      'api.submit_practice_attempt(uuid,integer)'::regprocedure,
      array[
        'workspace_ai_daily_budget_exceeded',
        'student_ai_daily_budget_exceeded'
      ]::text[]
    ),
    (
      'api.retry_writing_evaluation(uuid)'::regprocedure,
      array[
        'writing_manual_retry_limit_exceeded',
        'workspace_ai_daily_budget_exceeded',
        'student_ai_daily_budget_exceeded',
        'student_ai_monthly_budget_exceeded'
      ]::text[]
    ),
    (
      'api.request_practice_worksheet(uuid)'::regprocedure,
      array[
        'worksheet_generation_retry_limit_exceeded',
        'workspace_ai_daily_budget_exceeded',
        'student_ai_daily_budget_exceeded'
      ]::text[]
    ),
    (
      'api.retry_practice_attempt_evaluation(uuid)'::regprocedure,
      array[
        'practice_manual_retry_limit_exceeded',
        'workspace_ai_daily_budget_exceeded',
        'student_ai_daily_budget_exceeded'
      ]::text[]
    ),
    (
      'api.request_batch_join(text)'::regprocedure,
      array['batch_join_attempt_rate_limited']::text[]
    )
)
select ok(
  not exists (
    select 1
    from rate_boundary boundary
    join pg_proc routine on routine.oid = boundary.routine_oid
    join pg_language language on language.oid = routine.prolang
    where routine.prosecdef
      or language.lanname <> 'plpgsql'
      or not exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
      or lower(pg_get_functiondef(routine.oid)) not like
        '%when sqlstate ''54000''%'
      or lower(pg_get_functiondef(routine.oid)) not like
        '%errcode = ''pt429''%'
      or lower(pg_get_functiondef(routine.oid)) !~
        'raise;[[:space:]]*end;'
      or exists (
        select 1
        from unnest(boundary.expected_messages) expected(message)
        where position(
          expected.message in lower(pg_get_functiondef(routine.oid))
        ) = 0
      )
      or exists (
        select 1
        from unnest(array[
          'writing_daily_quota_exceeded',
          'writing_monthly_quota_exceeded',
          'workspace_ai_daily_budget_exceeded',
          'student_ai_daily_budget_exceeded',
          'student_ai_monthly_budget_exceeded',
          'writing_manual_retry_limit_exceeded',
          'worksheet_generation_retry_limit_exceeded',
          'practice_manual_retry_limit_exceeded',
          'batch_join_attempt_rate_limited'
        ]::text[]) known(message)
        where (
          position(known.message in lower(pg_get_functiondef(routine.oid))) > 0
        ) <> (known.message = any(boundary.expected_messages))
      )
  ),
  'browser rate-limit wrappers narrowly translate their exact allowlists and rethrow unknown 54000 errors'
);

with rate_boundary(routine_oid) as (
  values
    ('api.submit_writing(uuid,text,uuid,text)'::regprocedure),
    ('api.submit_writing_draft(uuid,integer)'::regprocedure),
    ('api.submit_practice_attempt(uuid,integer)'::regprocedure),
    ('api.retry_writing_evaluation(uuid)'::regprocedure),
    ('api.request_practice_worksheet(uuid)'::regprocedure),
    ('api.retry_practice_attempt_evaluation(uuid)'::regprocedure),
    ('api.request_batch_join(text)'::regprocedure)
)
select ok(
  not exists (
    select 1
    from rate_boundary boundary
    join pg_proc routine on routine.oid = boundary.routine_oid
    where not has_function_privilege(
        'authenticated', boundary.routine_oid, 'EXECUTE'
      )
      or has_function_privilege('anon', boundary.routine_oid, 'EXECUTE')
      or exists (
        select 1
        from aclexplode(
          coalesce(routine.proacl, acldefault('f', routine.proowner))
        ) privilege
        where privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE'
      )
  ),
  'browser rate-limit wrappers remain authenticated-only with no anonymous or PUBLIC execute grant'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'api.get_feedback_draft(uuid)',
      'api.update_feedback_draft(uuid,jsonb,integer)',
      'api.release_feedback(uuid,uuid)',
      'api.list_feedback_review_queue_page(uuid,text,integer,timestamptz,uuid)',
      'api.save_writing_draft(uuid,uuid,text,uuid,text,integer)',
      'api.get_writing_draft(uuid)',
      'api.get_writing_draft_by_context(uuid,uuid,text,uuid)',
      'api.list_my_writing_drafts(uuid,integer)',
      'api.submit_writing_draft(uuid,integer)',
      'api.save_practice_draft(uuid,jsonb,integer)',
      'api.get_practice_draft(uuid)',
      'api.submit_practice_attempt(uuid,integer)',
      'public.get_feedback_draft_internal(uuid)',
      'public.update_feedback_draft_internal(uuid,jsonb,integer)',
      'public.release_feedback_internal(uuid,uuid)',
      'public.list_feedback_review_queue_page_internal(uuid,text,integer,timestamptz,uuid)',
      'public.save_writing_draft_internal(uuid,uuid,text,uuid,text,integer)',
      'public.get_writing_draft_internal(uuid)',
      'public.get_writing_draft_by_context_internal(uuid,uuid,text,uuid)',
      'public.list_my_writing_drafts_internal(uuid,integer)',
      'public.submit_writing_draft_internal(uuid,integer)',
      'public.save_practice_draft_internal(uuid,jsonb,integer)',
      'public.get_practice_draft_internal(uuid)',
      'public.submit_practice_draft_internal(uuid,integer)'
    ]) as expected(signature)
    where not has_function_privilege(
      'authenticated',
      expected.signature,
      'EXECUTE'
    )
  ),
  'authenticated wrappers can delegate to every intended non-exposed implementation'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'api.get_feedback_draft(uuid)',
      'api.update_feedback_draft(uuid,jsonb,integer)',
      'api.release_feedback(uuid,uuid)',
      'api.list_feedback_review_queue_page(uuid,text,integer,timestamptz,uuid)',
      'api.save_writing_draft(uuid,uuid,text,uuid,text,integer)',
      'api.get_writing_draft(uuid)',
      'api.get_writing_draft_by_context(uuid,uuid,text,uuid)',
      'api.list_my_writing_drafts(uuid,integer)',
      'api.submit_writing_draft(uuid,integer)',
      'api.save_practice_draft(uuid,jsonb,integer)',
      'api.get_practice_draft(uuid)',
      'api.submit_practice_attempt(uuid,integer)',
      'public.get_feedback_draft_internal(uuid)',
      'public.update_feedback_draft_internal(uuid,jsonb,integer)',
      'public.release_feedback_internal(uuid,uuid)',
      'public.list_feedback_review_queue_page_internal(uuid,text,integer,timestamptz,uuid)',
      'public.save_writing_draft_internal(uuid,uuid,text,uuid,text,integer)',
      'public.get_writing_draft_internal(uuid)',
      'public.get_writing_draft_by_context_internal(uuid,uuid,text,uuid)',
      'public.list_my_writing_drafts_internal(uuid,integer)',
      'public.submit_writing_draft_internal(uuid,integer)',
      'public.save_practice_draft_internal(uuid,jsonb,integer)',
      'public.get_practice_draft_internal(uuid)',
      'public.submit_practice_draft_internal(uuid,integer)'
    ]) as expected(signature)
    where has_function_privilege('anon', expected.signature, 'EXECUTE')
  ),
  'anonymous callers receive no wrapper or internal teacher/draft capability'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.record_recovery_heartbeat(uuid)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.record_recovery_heartbeat_internal(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'api.get_recovery_health()',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.get_recovery_health_internal()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.record_recovery_heartbeat(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.record_recovery_heartbeat_internal(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.get_recovery_health()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.get_recovery_health_internal()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_recovery_health()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.get_recovery_health_internal()',
      'EXECUTE'
    ),
  'recovery wrappers and implementations remain service-only'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'api'
      and not exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
  ),
  'every exposed API routine pins an empty search path'
);

select * from finish();
rollback;
