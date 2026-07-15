begin;

select plan(20);

select ok(
  pg_get_functiondef(
    'app_private.enqueue_async_job(text,uuid,integer,text,uuid,integer)'::regprocedure
  ) like '%as sent(message_id)%'
    and pg_get_functiondef(
      'app_private.reconcile_async_job(uuid)'::regprocedure
    ) like '%as sent(message_id)%'
    and pg_get_functiondef(
      'public.fail_async_job(uuid,bigint,uuid,text,boolean)'::regprocedure
    ) like '%as sent(message_id)%'
    and not exists (
      select 1
      from pg_proc routine
      join pg_namespace namespace on namespace.oid = routine.pronamespace
      where routine.prokind = 'f'
        and namespace.nspname in ('public', 'api', 'app_private')
        and pg_get_functiondef(routine.oid) like '%sent.send%'
    ),
  'all live pgmq send paths use an explicit scalar result alias'
);

select ok(
  to_regprocedure('api.claim_async_jobs(text,uuid,integer,integer)') is not null
    and to_regprocedure('api.fail_async_job(uuid,bigint,uuid,text,boolean)') is not null
    and to_regprocedure('api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)') is not null
    and to_regprocedure('api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)') is not null
    and to_regprocedure('api.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)') is not null
    and to_regprocedure('api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)') is not null
    and to_regprocedure('api.reconcile_async_jobs(text)') is not null,
  'all current and sealed legacy worker lifecycle routines have api facade signatures'
);

select ok(
  to_regprocedure('api.get_writing_evaluation_context(uuid)') is not null
    and to_regprocedure('api.get_worksheet_generation_context(uuid)') is not null
    and to_regprocedure('api.get_worksheet_answer_evaluation_context(uuid)') is not null
    and to_regprocedure('api.is_worksheet_answer_evaluation_current(uuid,integer)') is not null,
  'all durable worker data loads have api facade signatures'
);

select ok(
  has_function_privilege('service_role', 'api.claim_async_jobs(text,uuid,integer,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'api.fail_async_job(uuid,bigint,uuid,text,boolean)', 'EXECUTE')
    and has_function_privilege('service_role', 'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('service_role', 'api.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'api.reconcile_async_jobs(text)', 'EXECUTE'),
  'service_role uses the adjudicated answer facade and cannot call its sealed legacy predecessor'
);

select ok(
  not has_function_privilege('authenticated', 'api.claim_async_jobs(text,uuid,integer,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'api.fail_async_job(uuid,bigint,uuid,text,boolean)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'api.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'api.reconcile_async_jobs(text)', 'EXECUTE'),
  'authenticated browser sessions cannot execute worker lifecycle routines'
);

select ok(
  not has_function_privilege('anon', 'api.claim_async_jobs(text,uuid,integer,integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.fail_async_job(uuid,bigint,uuid,text,boolean)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.complete_writing_evaluation(uuid,bigint,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.complete_worksheet_generation(uuid,bigint,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.complete_worksheet_answer_evaluation(uuid,bigint,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.complete_worksheet_answer_adjudication(uuid,bigint,uuid,jsonb,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.reconcile_async_jobs(text)', 'EXECUTE'),
  'anonymous browser sessions cannot execute worker lifecycle routines'
);

select ok(
  has_function_privilege('service_role', 'api.get_writing_evaluation_context(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'api.get_worksheet_generation_context(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'api.get_worksheet_answer_evaluation_context(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'api.is_worksheet_answer_evaluation_current(uuid,integer)', 'EXECUTE'),
  'service_role can execute every narrow worker data loader'
);

select ok(
  not has_function_privilege('authenticated', 'api.get_writing_evaluation_context(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'api.get_worksheet_generation_context(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'api.get_worksheet_answer_evaluation_context(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'api.is_worksheet_answer_evaluation_current(uuid,integer)', 'EXECUTE'),
  'authenticated browser sessions cannot load worker-only data'
);

select ok(
  not has_function_privilege('anon', 'api.get_writing_evaluation_context(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.get_worksheet_generation_context(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.get_worksheet_answer_evaluation_context(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'api.is_worksheet_answer_evaluation_current(uuid,integer)', 'EXECUTE'),
  'anonymous browser sessions cannot load worker-only data'
);

select ok(
  (
    select count(*) = 1
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'api'
      and routine.prosecdef
  )
    and exists (
      select 1
      from pg_proc routine
      join pg_namespace namespace on namespace.oid = routine.pronamespace
      where routine.oid =
        'api.complete_worksheet_generation_openai_legacy(uuid,bigint,uuid,jsonb)'::regprocedure
        and namespace.nspname = 'api'
        and routine.prosecdef
        and exists (
          select 1
          from unnest(coalesce(routine.proconfig, array[]::text[])) setting
          where setting ~ '^search_path=(""|)$'
        )
        and not has_function_privilege(
          'anon', routine.oid, 'EXECUTE'
        )
        and not has_function_privilege(
          'authenticated', routine.oid, 'EXECUTE'
        )
        and not has_function_privilege(
          'service_role', routine.oid, 'EXECUTE'
        )
        and not exists (
          select 1
          from aclexplode(coalesce(
            routine.proacl,
            acldefault('f', routine.proowner)
          )) privilege
          where privilege.grantee = 0
            and privilege.privilege_type = 'EXECUTE'
        )
    ),
  'the only exposed definer is the sealed no-grant historical worksheet replay bridge'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'api'
      and routine.proname in (
        'claim_async_jobs',
        'fail_async_job',
        'complete_writing_evaluation',
        'complete_worksheet_generation',
        'complete_worksheet_answer_evaluation',
        'complete_worksheet_answer_adjudication',
        'complete_worksheet_generation_openai_legacy',
        'reconcile_async_jobs',
        'get_writing_evaluation_context',
        'get_worksheet_generation_context',
        'get_worksheet_answer_evaluation_context',
        'is_worksheet_answer_evaluation_current'
      )
      and not exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
  ),
  'every worker api routine pins an empty search_path'
);

select ok(
  to_regclass('api.practice_test_questions') is null
    and to_regclass('api.practice_attempt_question_reviews') is null
    and to_regclass('api.async_jobs') is null
    and to_regclass('api.feedback_drafts') is null,
  'answer keys, reviews, queue metadata, and private drafts are not exposed as relations'
);

select ok(
  position(
    '''accepted_answers'', ptq.accepted_answers' in
    pg_get_functiondef('api.get_worksheet_answer_evaluation_context(uuid)'::regprocedure)
  ) > 0
    and position(
      '''rubric'', ptq.rubric' in
      pg_get_functiondef('api.get_worksheet_answer_evaluation_context(uuid)'::regprocedure)
    ) > 0
    and position(
      '''answer_contract_version'', ptq.answer_contract_version' in
      pg_get_functiondef('api.get_worksheet_answer_evaluation_context(uuid)'::regprocedure)
    ) > 0,
  'the service-only answer loader returns the complete versioned answer contract'
);

select ok(
  position(
    'app_private.get_worksheet_generation_context_phase_13g' in
    pg_get_functiondef('api.get_worksheet_generation_context(uuid)'::regprocedure)
  ) > 0
    and position(
      'app_private.get_worksheet_generation_context_before_phase_13g' in
      pg_get_functiondef(
        'app_private.get_worksheet_generation_context_phase_13g(uuid)'::regprocedure
      )
    ) > 0
    and position(
      'contract_question.answer_contract_version <> 1' in
      pg_get_functiondef(
        'app_private.get_worksheet_generation_context_before_phase_13g(uuid)'::regprocedure
      )
    ) > 0,
  'approved worksheet reuse excludes obsolete answer contracts'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  (
    select count(*)
    from api.get_writing_evaluation_context(
      '10000000-0000-4000-8000-000000000001'::uuid
    )
  ),
  0::bigint,
  'service_role can call the writing loader through api when no row exists'
);

select is(
  (
    select count(*)
    from api.get_worksheet_generation_context(
      '10000000-0000-4000-8000-000000000002'::uuid
    )
  ),
  0::bigint,
  'service_role can call the generation loader through api when no row exists'
);

select is(
  (
    select count(*)
    from api.get_worksheet_answer_evaluation_context(
      '10000000-0000-4000-8000-000000000003'::uuid
    )
  ),
  0::bigint,
  'service_role can call the answer loader through api when no row exists'
);

select is(
  api.is_worksheet_answer_evaluation_current(
    '10000000-0000-4000-8000-000000000004'::uuid,
    1
  ),
  false,
  'service_role current-attempt check safely rejects a missing attempt'
);

reset role;

-- Writing jobs now fail closed unless their submission has the immutable
-- evaluator context captured by the submission transaction. Build the
-- smallest complete writing fixture here instead of bypassing that guard.
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
    '10b11111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase10b-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 10B Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10b22222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase10b-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 10B Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  '10b33333-3333-4333-8333-333333333333',
  'Phase 10B Workspace',
  'phase-10b-worker-facades',
  '10b11111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  '10b11111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '10b33333-3333-4333-8333-333333333333',
  '10b11111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '10b33333-3333-4333-8333-333333333333',
  '10b22222-2222-4222-8222-222222222222',
  'student'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  is_active,
  join_code_enabled,
  join_requires_approval,
  feedback_mode,
  feedback_delay_min_minutes,
  feedback_delay_max_minutes
)
values (
  '10b44444-4444-4444-8444-444444444444',
  '10b33333-3333-4333-8333-333333333333',
  'Phase 10B Immediate',
  'A2',
  '10b11111-1111-4111-8111-111111111111',
  true,
  true,
  true,
  'immediate',
  0,
  0
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  '10b33333-3333-4333-8333-333333333333',
  '10b44444-4444-4444-8444-444444444444',
  '10b22222-2222-4222-8222-222222222222'
);

insert into public.submissions (
  id,
  workspace_id,
  student_id,
  batch_id,
  question_source,
  mode,
  original_text,
  status,
  evaluation_status,
  evaluation_version,
  release_status
)
values (
  '10b00000-0000-4000-8000-000000000003',
  '10b33333-3333-4333-8333-333333333333',
  '10b22222-2222-4222-8222-222222222222',
  '10b44444-4444-4444-8444-444444444444',
  'free_text',
  'free_text',
  'Ich lerne Deutsch.',
  'submitted',
  'processing',
  1,
  'held'
);

do $$
begin
  perform app_private.capture_writing_evaluation_context(
    '10b00000-0000-4000-8000-000000000003'
  );
end;
$$;

create temporary table phase_10b_retry_state (
  job_id uuid primary key,
  worker_id uuid not null,
  original_message_id bigint not null
) on commit drop;

insert into phase_10b_retry_state (
  job_id,
  worker_id,
  original_message_id
)
select
  '10b00000-0000-4000-8000-000000000001'::uuid,
  '10b00000-0000-4000-8000-000000000002'::uuid,
  sent.message_id
from pgmq.send(
  'writing_evaluation',
  jsonb_build_object(
    'job_id', '10b00000-0000-4000-8000-000000000001'::uuid,
    'job_kind', 'writing_evaluation',
    'entity_id', '10b00000-0000-4000-8000-000000000003'::uuid,
    'entity_version', 1
  ),
  0
) as sent(message_id);

insert into app_private.async_jobs (
  id,
  queue_name,
  job_kind,
  entity_id,
  entity_version,
  idempotency_key,
  status,
  attempt_count,
  queue_message_id,
  worker_id,
  available_at,
  lease_expires_at,
  first_started_at,
  last_started_at
)
select
  state.job_id,
  'writing_evaluation',
  'writing_evaluation',
  '10b00000-0000-4000-8000-000000000003'::uuid,
  1,
  'phase-10b-retry-alias-smoke',
  'processing',
  1,
  state.original_message_id,
  state.worker_id,
  now(),
  now() + interval '5 minutes',
  now(),
  now()
from phase_10b_retry_state state;

grant select on table phase_10b_retry_state to service_role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  (
    select failed.status
    from api.fail_async_job(
      '10b00000-0000-4000-8000-000000000001',
      (select original_message_id from pg_temp.phase_10b_retry_state),
      '10b00000-0000-4000-8000-000000000002',
      'phase_10b_retryable',
      true
    ) failed
  ),
  'retry'::text,
  'a retryable worker failure reaches the durable retry state'
);

reset role;

select ok(
  (
    select
      job.queue_message_id is not null
      and job.queue_message_id <> state.original_message_id
      and app_private.queue_message_exists(
        job.queue_name,
        job.queue_message_id
      )
      and job.last_error_code = 'phase_10b_retryable'
    from app_private.async_jobs job
    join phase_10b_retry_state state on state.job_id = job.id
  ),
  'retry persistence stores a distinct live replacement queue message'
);

select * from finish();
rollback;
