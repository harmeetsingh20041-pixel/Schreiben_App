begin;

select plan(38);

select has_schema(
  'api',
  'the deliberately exposed API schema exists'
);
select ok(
  has_schema_privilege('authenticated', 'api', 'USAGE'),
  'authenticated clients can use the API schema'
);
select ok(
  not has_schema_privilege('anon', 'api', 'USAGE'),
  'anonymous clients cannot use the application Data API'
);
select ok(
  not exists (
    select 1
    from pg_namespace namespace
    cross join lateral aclexplode(
      coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) privilege
    where namespace.nspname = 'api'
      and privilege.grantee = 0
      and privilege.privilege_type = 'USAGE'
  ),
  'PUBLIC has no implicit API schema access'
);

select has_view('api', 'profiles', 'api.profiles is an explicit view');
select has_view('api', 'workspaces', 'api.workspaces is an explicit view');
select has_view('api', 'workspace_members', 'api.workspace_members is an explicit view');
select has_view('api', 'batches', 'api.batches is an explicit view');
select has_view('api', 'batch_students', 'api.batch_students is an explicit view');
select has_view('api', 'questions', 'api.questions is an explicit view');
select has_view('api', 'global_questions', 'api.global_questions is an explicit view');
select has_view('api', 'grammar_topics', 'api.grammar_topics is an explicit view');
select has_view('api', 'submissions', 'api.submissions is an explicit view');
select has_view('api', 'submission_lines', 'api.submission_lines is an explicit view');
select has_view(
  'api',
  'submission_grammar_topics',
  'api.submission_grammar_topics is an explicit view'
);
select has_view(
  'api',
  'student_grammar_stats',
  'api.student_grammar_stats is an explicit view'
);
select has_view(
  'api',
  'batch_join_requests',
  'api.batch_join_requests is an explicit view'
);
select has_view(
  'api',
  'student_practice_assignments',
  'api.student_practice_assignments is an explicit view'
);
select has_view('api', 'practice_tests', 'api.practice_tests is an explicit view');
select has_view(
  'api',
  'practice_test_attempts',
  'api.practice_test_attempts is an explicit view'
);

select ok(
  not exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'api'
      and relation.relkind = 'v'
      and not (
        coalesce(relation.reloptions, array[]::text[])
          @> array['security_invoker=true', 'security_barrier=true']
      )
  ),
  'every exposed view is a security-invoker security-barrier view'
);
with expected_selectable_views(relation_oid) as (
  values ('api.practice_test_attempts'::regclass)
), actual_selectable_views(relation_oid) as (
  select relation.oid
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'api'
    and relation.relkind = 'v'
    and has_table_privilege(
      'authenticated', relation.oid, 'SELECT'
    )
)
select ok(
  (
    select array_agg(actual.relation_oid order by actual.relation_oid)
    from actual_selectable_views actual
  ) = (
    select array_agg(expected.relation_oid::oid order by expected.relation_oid::oid)
    from expected_selectable_views expected
  ),
  'authenticated SELECT is limited to the masked terminal practice-result view'
);
select ok(
  not exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'api'
      and relation.relkind = 'v'
      and has_table_privilege(
        'anon',
        format('%I.%I', namespace.nspname, relation.relname),
        'SELECT'
      )
  ),
  'anonymous receives SELECT on no API view'
);
select ok(
  not exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'api'
      and (
        (column_info.table_name = 'submissions' and column_info.column_name = 'ai_model')
        or (
          column_info.table_name = 'practice_test_attempts'
          and column_info.column_name in ('answers', 'feedback', 'evaluation_model')
        )
        or (
          column_info.table_name = 'practice_tests'
          and column_info.column_name = 'quality_notes'
        )
      )
  ),
  'provider metadata, answer blobs, and raw quality notes are absent'
);
select ok(
  to_regclass('api.practice_test_questions') is null
    and to_regclass('api.practice_attempt_question_reviews') is null
    and to_regclass('api.practice_generation_events') is null,
  'answer keys, detailed reviews, and generation diagnostics are not exposed'
);

select ok(
  to_regprocedure('api.get_auth_context()') is not null,
  'api.get_auth_context exists'
);
select ok(
  to_regprocedure('api.create_teacher_workspace(text)') is not null,
  'api.create_teacher_workspace exists'
);
select ok(
  to_regprocedure('api.list_workspace_batch_join_codes(uuid)') is not null,
  'api.list_workspace_batch_join_codes exists'
);
select ok(
  to_regprocedure('api.rotate_batch_join_code(uuid)') is not null,
  'api.rotate_batch_join_code exists'
);
select ok(
  to_regprocedure('api.request_batch_join(text)') is not null,
  'api.request_batch_join exists'
);
select ok(
  to_regprocedure('api.decide_batch_join(uuid,text)') is not null,
  'api.decide_batch_join exists'
);
select ok(
  to_regprocedure('api.offboard_student(uuid,uuid)') is not null,
  'api.offboard_student exists'
);
select ok(
  to_regprocedure('api.submit_writing(uuid,text,uuid,text)') is not null,
  'api.submit_writing exists'
);

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
  has_function_privilege('authenticated', 'api.get_auth_context()', 'EXECUTE')
    and has_function_privilege(
      'authenticated',
      'api.create_teacher_workspace(text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.list_workspace_batch_join_codes(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.rotate_batch_join_code(uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.request_batch_join(text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.decide_batch_join(uuid,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.offboard_student(uuid,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.submit_writing(uuid,text,uuid,text)',
      'EXECUTE'
    ),
  'authenticated receives EXECUTE only through the intended core API routines'
);
select ok(
  not has_function_privilege('anon', 'api.get_auth_context()', 'EXECUTE')
    and not has_function_privilege(
      'anon',
      'api.create_teacher_workspace(text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.list_workspace_batch_join_codes(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.rotate_batch_join_code(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.request_batch_join(text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.decide_batch_join(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.offboard_student(uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.submit_writing(uuid,text,uuid,text)',
      'EXECUTE'
    ),
  'anonymous receives EXECUTE on no application routine'
);
select ok(
  not exists (
    select 1
    from pg_default_acl defaults
    cross join lateral aclexplode(defaults.defaclacl) privilege
    left join pg_roles grantee on grantee.oid = privilege.grantee
    where defaults.defaclrole = 'postgres'::regrole
      and defaults.defaclnamespace in (
      'api'::regnamespace,
      'public'::regnamespace
    )
      and defaults.defaclobjtype in ('r', 'S', 'f')
      and (
        privilege.grantee = 0
        or grantee.rolname in ('anon', 'authenticated', 'service_role')
      )
  ),
  'future migration-owned public and API objects receive no implicit client grants'
);
select ok(
  (select count(*) from information_schema.views where table_schema = 'api') = 16,
  'the API schema exposes exactly the reviewed read-view allowlist'
);

select * from finish();
rollback;
