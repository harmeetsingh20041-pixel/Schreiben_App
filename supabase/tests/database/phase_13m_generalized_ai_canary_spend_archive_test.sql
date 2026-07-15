begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

select ok(
  to_regprocedure(
    'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'
  ) is not null
    and to_regprocedure(
      'public.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'
    ) is not null
    and to_regprocedure(
      'api.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'
    ) is not null,
  'the private implementation and service facade chain exist'
);

select ok(
  (
    select column_row.column_default =
      '''writing_live_canary_cleanup''::text'
    from information_schema.columns column_row
    where column_row.table_schema = 'app_private'
      and column_row.table_name = 'ai_canary_spend_archive'
      and column_row.column_name = 'archive_source'
  )
    and exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
          'app_private.ai_canary_spend_archive'::regclass
        and constraint_row.conname =
          'ai_canary_spend_archive_archive_source_check'
        and pg_get_constraintdef(constraint_row.oid) like
          '%writing_live_canary_cleanup%'
        and pg_get_constraintdef(constraint_row.oid) like
          '%worksheet_live_canary_cleanup%'
    )
    and exists (
      select 1
      from information_schema.columns column_row
      where column_row.table_schema = 'app_private'
        and column_row.table_name = 'ai_canary_spend_archive'
        and column_row.column_name = 'archive_run_id'
        and column_row.data_type = 'uuid'
    )
    and exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
          'app_private.ai_canary_spend_archive'::regclass
        and constraint_row.conname =
          'ai_canary_spend_archive_run_source_check'
        and pg_get_constraintdef(constraint_row.oid) like
          '%archive_run_id%'
    ),
  'the writing default remains stable while worksheet rows gain immutable run linkage'
);

select ok(
  has_function_privilege(
    'service_role',
    'api.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)',
      'EXECUTE'
    )
    and (
      select not routine.prosecdef
        and 'search_path=""' = any(routine.proconfig)
      from pg_proc routine
      where routine.oid =
        'api.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
    )
    and (
      select routine.prosecdef
        and 'search_path=""' = any(routine.proconfig)
      from pg_proc routine
      where routine.oid =
        'public.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
    ),
  'only service role reaches the fixed-search-path definer boundary'
);

select ok(
  to_regprocedure(
    'api.archive_writing_live_canary_spend(uuid,text,uuid)'
  ) is not null
    and has_function_privilege(
      'service_role',
      'api.archive_writing_live_canary_spend(uuid,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'api.archive_writing_live_canary_spend(uuid,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.archive_writing_live_canary_spend(uuid,text,uuid)',
      'EXECUTE'
    ),
  'the existing writing-live archive signature and ACL remain unchanged'
);

select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid = 'app_private.ai_canary_spend_archive'::regclass
  )
    and exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid =
          'app_private.ai_canary_spend_archive'::regclass
        and trigger_row.tgname = 'ai_canary_spend_archive_immutable'
        and not trigger_row.tgisinternal
    )
    and not exists (
      select 1
      from information_schema.columns column_row
      where column_row.table_schema = 'app_private'
        and column_row.table_name = 'ai_canary_spend_archive'
        and column_row.column_name in (
          'email',
          'student_id',
          'user_id',
          'original_text',
          'prompt',
          'response',
          'answer_text',
          'content',
          'worksheet_content'
        )
    )
    and not exists (
      select 1
      from unnest(array['anon', 'authenticated', 'service_role']) role_name
      where has_table_privilege(
        role_name,
        'app_private.ai_canary_spend_archive',
        'SELECT,INSERT,UPDATE,DELETE'
      )
    ),
  'the detached ledger remains content-free, immutable, RLS-protected, and directly private'
);

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
    'e1511111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase13m-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13M Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e1522222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase13m-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13M Student"}'::jsonb,
    now(),
    now()
  );

set local session_replication_role = replica;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'e1300000-0000-4000-8000-000000000001',
  'V1 worksheet live e1300000',
  'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
  'e1511111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (id, workspace_id, user_id, role)
values
  (
    'e1533333-3333-4333-8333-333333333331',
    'e1300000-0000-4000-8000-000000000001',
    'e1511111-1111-4111-8111-111111111111',
    'teacher'
  ),
  (
    'e1533333-3333-4333-8333-333333333332',
    'e1300000-0000-4000-8000-000000000001',
    'e1522222-2222-4222-8222-222222222222',
    'student'
  );

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  feedback_mode,
  is_active,
  join_requires_approval
)
values (
  'e1300000-0000-4000-8000-000000000004',
  'e1300000-0000-4000-8000-000000000001',
  'Worksheet live class e1300000',
  'A2',
  'e1511111-1111-4111-8111-111111111111',
  'immediate',
  true,
  true
);

insert into public.batch_students (
  id, batch_id, student_id, workspace_id
)
values (
  'e1555555-5555-4555-8555-555555555555',
  'e1300000-0000-4000-8000-000000000004',
  'e1522222-2222-4222-8222-222222222222',
  'e1300000-0000-4000-8000-000000000001'
);

insert into public.grammar_topics (
  id, slug, name, level, description
)
values
  (
    'e1300000-0000-4000-8000-000000000008',
    'e2e-worksheet-provider-canary',
    'Akkusativ',
    'A2',
    'Synthetic staging canary for focused A2 accusative-case practice.'
  ),
  (
    'e1588888-8888-4888-8888-888888888882',
    'phase13m-bank-topic',
    'Artikel',
    'A1_A2',
    'Rollback-only bank topic.'
  ),
  (
    'e1588888-8888-4888-8888-888888888883',
    'phase13m-extra-topic',
    'Satzbau',
    'A1_A2',
    'Rollback-only out-of-scope topic.'
  );

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  source,
  status,
  assigned_by,
  generation_status,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity
)
values
  (
    'e1300000-0000-4000-8000-000000000006',
    'e1300000-0000-4000-8000-000000000001',
    'e1522222-2222-4222-8222-222222222222',
    'e1300000-0000-4000-8000-000000000008',
    'manual',
    'unlocked',
    'e1511111-1111-4111-8111-111111111111',
    'idle',
    'e1300000-0000-4000-8000-000000000004',
    'A2',
    1,
    'teacher_verified'
  ),
  (
    'e1599999-9999-4999-8999-999999999999',
    'e1300000-0000-4000-8000-000000000001',
    'e1522222-2222-4222-8222-222222222222',
    'e1588888-8888-4888-8888-888888888883',
    'manual',
    'unlocked',
    'e1511111-1111-4111-8111-111111111111',
    'idle',
    'e1300000-0000-4000-8000-000000000004',
    'A2',
    1,
    'teacher_verified'
  );

set local session_replication_role = origin;

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $sql$
    select *
    from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '42501',
  'permission denied for function archive_worksheet_live_canary_spend',
  'an authenticated browser cannot archive canary spend'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select *
    from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-not-the-fixture',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_identity_mismatch',
  'the service API rejects a non-exact workspace identity'
);

select throws_ok(
  $sql$
    select *
    from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_assignment_scope_invalid',
  'an unrelated assignment makes the isolated fixture fail closed'
);

reset role;
set local session_replication_role = replica;
delete from public.student_practice_assignments
where id = 'e1599999-9999-4999-8999-999999999999';

insert into app_private.async_jobs (
  id,
  queue_name,
  job_kind,
  entity_id,
  entity_version,
  idempotency_key,
  status,
  attempt_count,
  completed_at
)
values (
  'e15ccccc-cccc-4ccc-8ccc-ccccccccccc0',
  'worksheet_generation',
  'worksheet_generation',
  'e1300000-0000-4000-8000-000000000007',
  1,
  'phase13m-orphan-bank-generation',
  'succeeded',
  1,
  now()
);
set local session_replication_role = origin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select *
    from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_job_scope_invalid',
  'a bank job cannot exist when the optional fixed bank assignment is absent'
);

reset role;
delete from app_private.async_jobs
where id = 'e15ccccc-cccc-4ccc-8ccc-ccccccccccc0';

create temporary table phase_13m_queue_state (
  message_id bigint primary key
) on commit drop;
insert into pg_temp.phase_13m_queue_state (message_id)
select sent.message_id
from pgmq.send(
  'worksheet_generation',
  jsonb_build_object(
    'job_id', 'e15ccccc-cccc-4ccc-8ccc-ccccccccccc0'::uuid,
    'job_kind', 'worksheet_generation',
    'entity_id', 'e1300000-0000-4000-8000-000000000007'::uuid,
    'entity_version', 1
  ),
  0
) sent(message_id);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select *
    from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_queue_scope_invalid',
  'orphan queue evidence for an absent bank assignment fails closed'
);

reset role;
delete from pgmq.q_worksheet_generation queue
where queue.msg_id = (
  select message_id from pg_temp.phase_13m_queue_state
);

create temporary table phase_13m_archive_receipts (
  receipt_kind text primary key,
  archived_reservation_count bigint not null,
  newly_archived_count bigint not null,
  replayed boolean not null
) on commit drop;
grant select, insert on pg_temp.phase_13m_archive_receipts to service_role;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

insert into pg_temp.phase_13m_archive_receipts
select 'empty', receipt.*
from api.archive_worksheet_live_canary_spend(
  'e1300000-0000-4000-8000-000000000001',
  'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
  'e1300000-0000-4000-8000-000000000004',
  'e1300000-0000-4000-8000-000000000006',
  'e1300000-0000-4000-8000-000000000007'
) receipt;

reset role;

select is(
  (
    select jsonb_build_array(
      receipt.archived_reservation_count,
      receipt.newly_archived_count,
      receipt.replayed
    )
    from pg_temp.phase_13m_archive_receipts receipt
    where receipt.receipt_kind = 'empty'
  ),
  '[0,0,false]'::jsonb,
  'an exact installed provider fixture with no spend is a harmless no-op'
);

set local session_replication_role = replica;

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  source,
  status,
  assigned_by,
  generation_status,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity
)
values (
  'e1300000-0000-4000-8000-000000000007',
  'e1300000-0000-4000-8000-000000000001',
  'e1522222-2222-4222-8222-222222222222',
  'e1588888-8888-4888-8888-888888888882',
  'manual',
  'unlocked',
  'e1511111-1111-4111-8111-111111111111',
  'ready',
  'e1300000-0000-4000-8000-000000000004',
  'A2',
  1,
  'teacher_verified'
);

insert into public.practice_tests (
  id,
  workspace_id,
  grammar_topic_id,
  level,
  difficulty,
  title,
  created_by_ai,
  teacher_reviewed,
  visibility,
  created_by,
  generation_source,
  quality_status
)
values
  (
    'e15aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'e1300000-0000-4000-8000-000000000001',
    'e1300000-0000-4000-8000-000000000008',
    'A2',
    'medium',
    'Phase 13M provider worksheet',
    true,
    false,
    'private',
    'e1511111-1111-4111-8111-111111111111',
    'deepseek',
    'approved'
  ),
  (
    'e15aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    'e1300000-0000-4000-8000-000000000001',
    'e1588888-8888-4888-8888-888888888882',
    'A2',
    'medium',
    'Phase 13M bank worksheet',
    false,
    true,
    'private',
    'e1511111-1111-4111-8111-111111111111',
    'manual',
    'approved'
  );

update public.student_practice_assignments assignment
set practice_test_id = case assignment.id
  when 'e1300000-0000-4000-8000-000000000006'::uuid
    then 'e15aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
  else 'e15aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid
end
where assignment.id in (
  'e1300000-0000-4000-8000-000000000006',
  'e1300000-0000-4000-8000-000000000007'
);

insert into public.practice_test_attempts (
  id,
  practice_test_id,
  student_id,
  workspace_id,
  assignment_id,
  answers,
  score,
  max_score,
  status,
  evaluation_status,
  evaluation_version,
  started_at,
  submitted_at,
  completed_at
)
values (
  'e15bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'e15aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'e1522222-2222-4222-8222-222222222222',
  'e1300000-0000-4000-8000-000000000001',
  'e1300000-0000-4000-8000-000000000006',
  '[]'::jsonb,
  0,
  0,
  'checked',
  'completed',
  1,
  now(),
  now(),
  now()
);

insert into app_private.async_jobs (
  id,
  queue_name,
  job_kind,
  entity_id,
  entity_version,
  idempotency_key,
  status,
  attempt_count,
  completed_at
)
values
  (
    'e15ccccc-cccc-4ccc-8ccc-ccccccccccc1',
    'worksheet_generation',
    'worksheet_generation',
    'e1300000-0000-4000-8000-000000000006',
    1,
    'phase13m-generation',
    'queued',
    0,
    null
  ),
  (
    'e15ccccc-cccc-4ccc-8ccc-ccccccccccc2',
    'worksheet_answer_evaluation',
    'worksheet_answer_evaluation',
    'e15bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    1,
    'phase13m-answer',
    'succeeded',
    1,
    now()
  );

set local session_replication_role = origin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select *
    from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_job_active',
  'archival fails closed while either scoped worksheet job is active'
);

reset role;
set local session_replication_role = replica;

update app_private.async_jobs job
set
  status = 'succeeded',
  attempt_count = 1,
  completed_at = now()
where job.id = 'e15ccccc-cccc-4ccc-8ccc-ccccccccccc1';

select set_config('app.ai_spend_transition', 'on', true);
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
  cached_input_rate_microusd_per_million,
  input_rate_microusd_per_million,
  output_rate_microusd_per_million,
  reserved_microusd,
  state,
  actual_microusd,
  billed_input_tokens,
  billed_output_tokens,
  billed_cached_input_tokens,
  billed_uncached_input_tokens,
  cache_metadata_present,
  release_reason,
  usage_estimated,
  expires_at,
  finalized_at,
  released_at
)
values
  (
    'e15ddddd-dddd-4ddd-8ddd-ddddddddddd1',
    'e15ccccc-cccc-4ccc-8ccc-ccccccccccc1',
    1,
    'phase13m.generation',
    'e1300000-0000-4000-8000-000000000001',
    'e1522222-2222-4222-8222-222222222222',
    date_trunc('month', timezone('UTC', now()))::date,
    'deepseek',
    'deepseek-v4-flash',
    'worksheet_generation',
    2800,
    100000,
    200000,
    300000,
    'finalized',
    1200,
    1000,
    500,
    0,
    1000,
    false,
    null,
    false,
    now() + interval '15 minutes',
    now(),
    null
  ),
  (
    'e15ddddd-dddd-4ddd-8ddd-ddddddddddd2',
    'e15ccccc-cccc-4ccc-8ccc-ccccccccccc2',
    1,
    'phase13m.answer',
    'e1300000-0000-4000-8000-000000000001',
    'e1522222-2222-4222-8222-222222222222',
    date_trunc('month', timezone('UTC', now()))::date,
    'gemini',
    'gemini-3.1-flash-lite',
    'worksheet_answer_evaluation',
    100000,
    100000,
    200000,
    100000,
    'reserved',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    false,
    now() + interval '15 minutes',
    null,
    null
  );
select set_config('app.ai_spend_transition', 'off', true);

set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select *
    from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_spend_not_terminal',
  'a terminal job cannot archive a still-reserved provider call'
);

reset role;
select set_config('app.ai_spend_transition', 'on', true);
update app_private.ai_spend_reservations reservation
set
  state = 'released',
  release_reason = 'provider_not_called',
  released_at = now()
where reservation.id = 'e15ddddd-dddd-4ddd-8ddd-ddddddddddd2';
select set_config('app.ai_spend_transition', 'off', true);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

insert into pg_temp.phase_13m_archive_receipts
select 'first', receipt.*
from api.archive_worksheet_live_canary_spend(
  'e1300000-0000-4000-8000-000000000001',
  'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
  'e1300000-0000-4000-8000-000000000004',
  'e1300000-0000-4000-8000-000000000006',
  'e1300000-0000-4000-8000-000000000007'
) receipt;

reset role;

select is(
  (
    select jsonb_build_array(
      receipt.archived_reservation_count,
      receipt.newly_archived_count,
      receipt.replayed
    )
    from pg_temp.phase_13m_archive_receipts receipt
    where receipt.receipt_kind = 'first'
  ),
  '[2,2,false]'::jsonb,
  'the first archive receipt reports every generation and answer reservation'
);

select ok(
  not exists (
    select 1
    from app_private.ai_spend_reservations reservation
    where reservation.workspace_id =
      'e1300000-0000-4000-8000-000000000001'
  )
    and (
      select count(*) = 2
        and count(*) filter (
          where archived.archive_source =
            'worksheet_live_canary_cleanup'
        ) = 2
        and count(*) filter (where archived.state = 'finalized') = 1
        and count(*) filter (where archived.state = 'released') = 1
        and count(distinct archived.archive_run_id) = 1
        and count(*) filter (where archived.archive_run_id is null) = 0
        and count(distinct archived.original_job_id) = 2
        and sum(archived.actual_microusd) = 1200
      from app_private.ai_canary_spend_archive archived
      where archived.original_workspace_id =
        'e1300000-0000-4000-8000-000000000001'
        and archived.original_reservation_id in (
          'e15ddddd-dddd-4ddd-8ddd-ddddddddddd1',
          'e15ddddd-dddd-4ddd-8ddd-ddddddddddd2'
        )
    ),
  'copy-before-delete preserves immutable terminal spend with truthful source'
);

select ok(
  (
    select count(*) = 2
      and count(*) filter (where entry.state = 'finalized') = 1
      and count(*) filter (where entry.state = 'released') = 1
      and sum(entry.actual_microusd) = 1200
    from app_private.ai_spend_accounting_entries() entry
    where entry.workspace_id =
      'e1300000-0000-4000-8000-000000000001'
      and entry.reservation_id in (
        'e15ddddd-dddd-4ddd-8ddd-ddddddddddd1',
        'e15ddddd-dddd-4ddd-8ddd-ddddddddddd2'
      )
  ),
  'the shared accounting union still counts detached worksheet spend exactly once'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

insert into pg_temp.phase_13m_archive_receipts
select 'replay', receipt.*
from api.archive_worksheet_live_canary_spend(
  'e1300000-0000-4000-8000-000000000001',
  'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
  'e1300000-0000-4000-8000-000000000004',
  'e1300000-0000-4000-8000-000000000006',
  'e1300000-0000-4000-8000-000000000007'
) receipt;

reset role;

select is(
  (
    select jsonb_build_array(
      receipt.archived_reservation_count,
      receipt.newly_archived_count,
      receipt.replayed
    )
    from pg_temp.phase_13m_archive_receipts receipt
    where receipt.receipt_kind = 'replay'
  ),
  '[2,0,true]'::jsonb,
  'an exact replay is explicit and never duplicates spend evidence'
);

select throws_ok(
  $sql$
    update app_private.ai_canary_spend_archive
    set archived_at = archived_at + interval '1 second'
    where original_workspace_id =
      'e1300000-0000-4000-8000-000000000001'
      and original_reservation_id in (
        'e15ddddd-dddd-4ddd-8ddd-ddddddddddd1',
        'e15ddddd-dddd-4ddd-8ddd-ddddddddddd2'
      )
  $sql$,
  '55000',
  'ai_canary_spend_archive_immutable',
  'worksheet-live archive rows remain immutable'
);

-- Finish the first browser cleanup while deliberately retaining only detached
-- accounting evidence. The second run reuses the exact deterministic fixture
-- IDs but creates new job and reservation identities.
set local session_replication_role = replica;

delete from public.practice_test_attempts attempt
where attempt.id = 'e15bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
delete from public.student_practice_assignments assignment
where assignment.id in (
  'e1300000-0000-4000-8000-000000000006',
  'e1300000-0000-4000-8000-000000000007'
);
delete from public.practice_tests test
where test.id in (
  'e15aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'e15aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
);
delete from app_private.async_jobs job
where job.id in (
  'e15ccccc-cccc-4ccc-8ccc-ccccccccccc1',
  'e15ccccc-cccc-4ccc-8ccc-ccccccccccc2'
);
delete from public.batch_students enrollment
where enrollment.workspace_id =
  'e1300000-0000-4000-8000-000000000001';
delete from public.workspace_members membership
where membership.workspace_id =
  'e1300000-0000-4000-8000-000000000001';
delete from public.batches batch
where batch.workspace_id =
  'e1300000-0000-4000-8000-000000000001';
delete from public.workspaces workspace
where workspace.id = 'e1300000-0000-4000-8000-000000000001';
delete from public.grammar_topics topic
where topic.id in (
  'e1300000-0000-4000-8000-000000000008',
  'e1588888-8888-4888-8888-888888888882',
  'e1588888-8888-4888-8888-888888888883'
);

set local session_replication_role = origin;

select ok(
  not exists (
    select 1
    from public.workspaces workspace
    where workspace.id = 'e1300000-0000-4000-8000-000000000001'
  )
    and not exists (
      select 1
      from app_private.async_jobs job
      where job.id in (
        'e15ccccc-cccc-4ccc-8ccc-ccccccccccc1',
        'e15ccccc-cccc-4ccc-8ccc-ccccccccccc2'
      )
    )
    and (
      select count(*) = 2
        and count(distinct archived.archive_run_id) = 1
      from app_private.ai_canary_spend_archive archived
      where archived.original_workspace_id =
        'e1300000-0000-4000-8000-000000000001'
        and archived.original_reservation_id in (
          'e15ddddd-dddd-4ddd-8ddd-ddddddddddd1',
          'e15ddddd-dddd-4ddd-8ddd-ddddddddddd2'
        )
    ),
  'cycle one deletes its live fixture while immutable run-linked spend survives'
);

set local session_replication_role = replica;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'e1300000-0000-4000-8000-000000000001',
  'V1 worksheet live e1300000',
  'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
  'e1511111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (id, workspace_id, user_id, role)
values
  (
    'e1633333-3333-4333-8333-333333333331',
    'e1300000-0000-4000-8000-000000000001',
    'e1511111-1111-4111-8111-111111111111',
    'teacher'
  ),
  (
    'e1633333-3333-4333-8333-333333333332',
    'e1300000-0000-4000-8000-000000000001',
    'e1522222-2222-4222-8222-222222222222',
    'student'
  );

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  feedback_mode,
  is_active,
  join_requires_approval
)
values (
  'e1300000-0000-4000-8000-000000000004',
  'e1300000-0000-4000-8000-000000000001',
  'Worksheet live class e1300000',
  'A2',
  'e1511111-1111-4111-8111-111111111111',
  'immediate',
  true,
  true
);

insert into public.batch_students (
  id, batch_id, student_id, workspace_id
)
values (
  'e1655555-5555-4555-8555-555555555555',
  'e1300000-0000-4000-8000-000000000004',
  'e1522222-2222-4222-8222-222222222222',
  'e1300000-0000-4000-8000-000000000001'
);

insert into public.grammar_topics (
  id, slug, name, level, description
)
values
  (
    'e1300000-0000-4000-8000-000000000008',
    'e2e-worksheet-provider-canary',
    'Akkusativ',
    'A2',
    'Synthetic staging canary for focused A2 accusative-case practice.'
  ),
  (
    'e1688888-8888-4888-8888-888888888882',
    'phase13m-bank-topic-cycle-two',
    'Artikel',
    'A1_A2',
    'Rollback-only second-cycle bank topic.'
  );

insert into public.practice_tests (
  id,
  workspace_id,
  grammar_topic_id,
  level,
  difficulty,
  title,
  created_by_ai,
  teacher_reviewed,
  visibility,
  created_by,
  generation_source,
  quality_status
)
values
  (
    'e16aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'e1300000-0000-4000-8000-000000000001',
    'e1300000-0000-4000-8000-000000000008',
    'A2',
    'medium',
    'Phase 13M provider worksheet cycle two',
    true,
    false,
    'private',
    'e1511111-1111-4111-8111-111111111111',
    'deepseek',
    'approved'
  ),
  (
    'e16aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    'e1300000-0000-4000-8000-000000000001',
    'e1688888-8888-4888-8888-888888888882',
    'A2',
    'medium',
    'Phase 13M bank worksheet cycle two',
    false,
    true,
    'private',
    'e1511111-1111-4111-8111-111111111111',
    'manual',
    'approved'
  );

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  practice_test_id,
  source,
  status,
  assigned_by,
  generation_status,
  batch_id,
  worksheet_level,
  class_context_version,
  class_context_integrity
)
values
  (
    'e1300000-0000-4000-8000-000000000006',
    'e1300000-0000-4000-8000-000000000001',
    'e1522222-2222-4222-8222-222222222222',
    'e1300000-0000-4000-8000-000000000008',
    'e16aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'manual',
    'unlocked',
    'e1511111-1111-4111-8111-111111111111',
    'ready',
    'e1300000-0000-4000-8000-000000000004',
    'A2',
    1,
    'teacher_verified'
  ),
  (
    'e1300000-0000-4000-8000-000000000007',
    'e1300000-0000-4000-8000-000000000001',
    'e1522222-2222-4222-8222-222222222222',
    'e1688888-8888-4888-8888-888888888882',
    'e16aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    'manual',
    'unlocked',
    'e1511111-1111-4111-8111-111111111111',
    'ready',
    'e1300000-0000-4000-8000-000000000004',
    'A2',
    1,
    'teacher_verified'
  );

insert into public.practice_test_attempts (
  id,
  practice_test_id,
  student_id,
  workspace_id,
  assignment_id,
  answers,
  score,
  max_score,
  status,
  evaluation_status,
  evaluation_version,
  started_at,
  submitted_at,
  completed_at
)
values (
  'e16bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'e16aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'e1522222-2222-4222-8222-222222222222',
  'e1300000-0000-4000-8000-000000000001',
  'e1300000-0000-4000-8000-000000000006',
  '[]'::jsonb,
  0,
  0,
  'checked',
  'completed',
  2,
  now(),
  now(),
  now()
);

insert into app_private.async_jobs (
  id,
  queue_name,
  job_kind,
  entity_id,
  entity_version,
  idempotency_key,
  status,
  attempt_count,
  completed_at
)
values
  (
    'e16ccccc-cccc-4ccc-8ccc-ccccccccccc1',
    'worksheet_generation',
    'worksheet_generation',
    'e1300000-0000-4000-8000-000000000006',
    2,
    'phase13m-generation-cycle-two',
    'succeeded',
    1,
    now()
  ),
  (
    'e16ccccc-cccc-4ccc-8ccc-ccccccccccc2',
    'worksheet_answer_evaluation',
    'worksheet_answer_evaluation',
    'e16bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    2,
    'phase13m-answer-cycle-two',
    'succeeded',
    1,
    now()
  );

select set_config('app.ai_spend_transition', 'on', true);
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
  cached_input_rate_microusd_per_million,
  input_rate_microusd_per_million,
  output_rate_microusd_per_million,
  reserved_microusd,
  state,
  actual_microusd,
  billed_input_tokens,
  billed_output_tokens,
  billed_cached_input_tokens,
  billed_uncached_input_tokens,
  cache_metadata_present,
  release_reason,
  usage_estimated,
  expires_at,
  finalized_at,
  released_at
)
values
  (
    'e16ddddd-dddd-4ddd-8ddd-ddddddddddd1',
    'e16ccccc-cccc-4ccc-8ccc-ccccccccccc1',
    2,
    'phase13m.generation.cycle-two',
    'e1300000-0000-4000-8000-000000000001',
    'e1522222-2222-4222-8222-222222222222',
    date_trunc('month', timezone('UTC', now()))::date,
    'deepseek',
    'deepseek-v4-flash',
    'worksheet_generation',
    2800,
    100000,
    200000,
    400000,
    'finalized',
    2200,
    1500,
    700,
    0,
    1500,
    false,
    null,
    false,
    now() + interval '15 minutes',
    now(),
    null
  ),
  (
    'e16ddddd-dddd-4ddd-8ddd-ddddddddddd2',
    'e16ccccc-cccc-4ccc-8ccc-ccccccccccc2',
    2,
    'phase13m.answer.cycle-two',
    'e1300000-0000-4000-8000-000000000001',
    'e1522222-2222-4222-8222-222222222222',
    date_trunc('month', timezone('UTC', now()))::date,
    'gemini',
    'gemini-3.1-flash-lite',
    'worksheet_answer_evaluation',
    100000,
    100000,
    200000,
    100000,
    'released',
    null,
    null,
    null,
    null,
    null,
    null,
    'provider_not_called',
    false,
    now() + interval '15 minutes',
    null,
    now()
  );
select set_config('app.ai_spend_transition', 'off', true);

set local session_replication_role = origin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

insert into pg_temp.phase_13m_archive_receipts
select 'second', receipt.*
from api.archive_worksheet_live_canary_spend(
  'e1300000-0000-4000-8000-000000000001',
  'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
  'e1300000-0000-4000-8000-000000000004',
  'e1300000-0000-4000-8000-000000000006',
  'e1300000-0000-4000-8000-000000000007'
) receipt;

reset role;

select is(
  (
    select jsonb_build_array(
      receipt.archived_reservation_count,
      receipt.newly_archived_count,
      receipt.replayed
    )
    from pg_temp.phase_13m_archive_receipts receipt
    where receipt.receipt_kind = 'second'
  ),
  '[2,2,false]'::jsonb,
  'cycle two archives only its new reservations despite historical rows'
);

select ok(
  (
    select count(*) = 4
      and count(distinct archived.archive_run_id) = 2
      and count(*) filter (
        where archived.archive_source = 'worksheet_live_canary_cleanup'
      ) = 4
      and count(*) filter (where archived.state = 'finalized') = 2
      and count(*) filter (where archived.state = 'released') = 2
      and count(distinct archived.original_job_id) = 4
      and sum(archived.actual_microusd) = 3400
      and not exists (
        select 1
        from app_private.ai_canary_spend_archive per_run
        where per_run.original_workspace_id =
          'e1300000-0000-4000-8000-000000000001'
          and per_run.original_reservation_id in (
            'e15ddddd-dddd-4ddd-8ddd-ddddddddddd1',
            'e15ddddd-dddd-4ddd-8ddd-ddddddddddd2',
            'e16ddddd-dddd-4ddd-8ddd-ddddddddddd1',
            'e16ddddd-dddd-4ddd-8ddd-ddddddddddd2'
          )
        group by per_run.archive_run_id
        having count(*) <> 2
      )
    from app_private.ai_canary_spend_archive archived
    where archived.original_workspace_id =
      'e1300000-0000-4000-8000-000000000001'
      and archived.original_reservation_id in (
        'e15ddddd-dddd-4ddd-8ddd-ddddddddddd1',
        'e15ddddd-dddd-4ddd-8ddd-ddddddddddd2',
        'e16ddddd-dddd-4ddd-8ddd-ddddddddddd1',
        'e16ddddd-dddd-4ddd-8ddd-ddddddddddd2'
      )
  ),
  'four immutable rows remain truthfully partitioned across two canary runs'
);

select ok(
  (
    select count(*) = 4
      and count(*) filter (where entry.state = 'finalized') = 2
      and count(*) filter (where entry.state = 'released') = 2
      and count(distinct entry.job_id) = 4
      and sum(entry.reserved_microusd) = 900000
      and sum(entry.actual_microusd) = 3400
    from app_private.ai_spend_accounting_entries() entry
    where entry.workspace_id =
      'e1300000-0000-4000-8000-000000000001'
      and entry.reservation_id in (
        'e15ddddd-dddd-4ddd-8ddd-ddddddddddd1',
        'e15ddddd-dddd-4ddd-8ddd-ddddddddddd2',
        'e16ddddd-dddd-4ddd-8ddd-ddddddddddd1',
        'e16ddddd-dddd-4ddd-8ddd-ddddddddddd2'
      )
  ),
  'accounting totals include both deleted runs exactly once'
);

set local session_replication_role = replica;

delete from public.practice_test_attempts attempt
where attempt.id = 'e16bbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
delete from public.student_practice_assignments assignment
where assignment.id in (
  'e1300000-0000-4000-8000-000000000006',
  'e1300000-0000-4000-8000-000000000007'
);
delete from public.practice_tests test
where test.id in (
  'e16aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'e16aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
);
delete from app_private.async_jobs job
where job.id in (
  'e16ccccc-cccc-4ccc-8ccc-ccccccccccc1',
  'e16ccccc-cccc-4ccc-8ccc-ccccccccccc2'
);
delete from public.batch_students enrollment
where enrollment.workspace_id =
  'e1300000-0000-4000-8000-000000000001';
delete from public.workspace_members membership
where membership.workspace_id =
  'e1300000-0000-4000-8000-000000000001';
delete from public.batches batch
where batch.workspace_id =
  'e1300000-0000-4000-8000-000000000001';
delete from public.workspaces workspace
where workspace.id = 'e1300000-0000-4000-8000-000000000001';
delete from public.grammar_topics topic
where topic.id in (
  'e1300000-0000-4000-8000-000000000008',
  'e1688888-8888-4888-8888-888888888882'
);

set local session_replication_role = origin;

select ok(
  not exists (
    select 1
    from public.workspaces workspace
    where workspace.id = 'e1300000-0000-4000-8000-000000000001'
  )
    and not exists (
      select 1
      from public.student_practice_assignments assignment
      where assignment.id in (
        'e1300000-0000-4000-8000-000000000006',
        'e1300000-0000-4000-8000-000000000007'
      )
    )
    and not exists (
      select 1
      from app_private.async_jobs job
      where job.id in (
        'e15ccccc-cccc-4ccc-8ccc-ccccccccccc1',
        'e15ccccc-cccc-4ccc-8ccc-ccccccccccc2',
        'e16ccccc-cccc-4ccc-8ccc-ccccccccccc1',
        'e16ccccc-cccc-4ccc-8ccc-ccccccccccc2'
      )
    )
    and not exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.workspace_id =
        'e1300000-0000-4000-8000-000000000001'
    )
    and (
      select count(*) = 4
      from app_private.ai_canary_spend_archive archived
      where archived.original_workspace_id =
        'e1300000-0000-4000-8000-000000000001'
        and archived.original_reservation_id in (
          'e15ddddd-dddd-4ddd-8ddd-ddddddddddd1',
          'e15ddddd-dddd-4ddd-8ddd-ddddddddddd2',
          'e16ddddd-dddd-4ddd-8ddd-ddddddddddd1',
          'e16ddddd-dddd-4ddd-8ddd-ddddddddddd2'
        )
    ),
  'cycle two leaves no live fixture or spend residue while history remains'
);

select ok(
  position(
    'pg_try_advisory_xact_lock'
    in pg_get_functiondef(
      'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
    )
  ) > 0
    and position(
      'paid-job-entity'
      in pg_get_functiondef(
        'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    and position(
      'worksheet_generation'
      in pg_get_functiondef(
        'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    and position(
      'worksheet_answer_evaluation'
      in pg_get_functiondef(
        'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    and position(
      'job.entity_version = reservation.entity_version'
      in pg_get_functiondef(
        'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    and position(
      'job.entity_version = archived.entity_version'
      in pg_get_functiondef(
        'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0
    and position(
      'e1300000-0000-4000-8000-000000000008'
      in pg_get_functiondef(
        'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
      )
    ) > 0,
  'the implementation hard-binds and version-fences both paid worksheet job kinds'
);

select * from finish(true);
rollback;
