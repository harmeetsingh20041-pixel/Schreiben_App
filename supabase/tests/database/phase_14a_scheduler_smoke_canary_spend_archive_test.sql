begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

select ok(
  to_regprocedure(
    'app_private.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)'
  ) is not null
    and to_regprocedure(
      'public.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)'
    ) is null
    and to_regprocedure(
      'api.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)'
    ) is null
    and has_function_privilege(
      'service_role',
      'app_private.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app_private.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app_private.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)',
      'EXECUTE'
    )
    and (
      select routine.prosecdef
        and 'search_path=""' = any(routine.proconfig)
      from pg_proc routine
      where routine.oid =
        'app_private.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)'
          ::regprocedure
    )
    and position(
      'pg_try_advisory_xact_lock'
      in pg_get_functiondef(
        'app_private.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)'
          ::regprocedure
      )
    ) > 0
    and position(
      'paid-job-entity'
      in pg_get_functiondef(
        'app_private.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)'
          ::regprocedure
      )
    ) > 0
    and position(
      'job.queue_name = ''writing_evaluation'''
      in pg_get_functiondef(
        'app_private.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)'
          ::regprocedure
      )
    ) > 0
    and position(
      'job.queue_name = ''worksheet_generation'''
      in pg_get_functiondef(
        'app_private.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)'
          ::regprocedure
      )
    ) > 0
    and position(
      'job.queue_name = ''worksheet_answer_evaluation'''
      in pg_get_functiondef(
        'app_private.archive_scheduler_smoke_canary_spend(uuid,text,uuid,uuid)'
          ::regprocedure
      )
    ) > 0,
  'the private service definer also serializes paid entities and validates queue-kind mappings'
);

select ok(
  exists (
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
        and pg_get_constraintdef(constraint_row.oid) like
          '%scheduler_smoke_canary_cleanup%'
    )
    and exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
          'app_private.ai_canary_spend_archive'::regclass
        and constraint_row.conname =
          'ai_canary_spend_archive_run_source_check'
        and pg_get_constraintdef(constraint_row.oid) like
          '%writing_live_canary_cleanup%'
        and pg_get_constraintdef(constraint_row.oid) like
          '%worksheet_live_canary_cleanup%'
        and pg_get_constraintdef(constraint_row.oid) like
          '%scheduler_smoke_canary_cleanup%'
        and lower(pg_get_constraintdef(constraint_row.oid)) like
          '%archive_run_id is not null%'
    )
    and not exists (
      select 1
      from information_schema.columns column_row
      where column_row.table_schema = 'app_private'
        and column_row.table_name = 'ai_canary_spend_archive'
        and column_row.column_name = 'original_student_id'
    ),
  'scheduler rows require run linkage without adding student identity to the detached ledger'
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
      from unnest(array['anon', 'authenticated', 'service_role']) role_name
      where has_table_privilege(
        role_name,
        'app_private.ai_canary_spend_archive',
        'SELECT,INSERT,UPDATE,DELETE'
      )
    )
    and position(
      'new.student_id := selected_student_id'
      in pg_get_functiondef(
        'app_private.enforce_ai_spend_fair_share()'::regprocedure
      )
    ) > 0
    and position(
      'new.cached_input_rate_microusd_per_million'
      in pg_get_functiondef(
        'app_private.enforce_ai_spend_fair_share()'::regprocedure
      )
    ) > 0
    and position(
      'ai_spend_student_fair_share_exceeded'
      in pg_get_functiondef(
        'app_private.enforce_ai_spend_fair_share()'::regprocedure
      )
    ) = 0
    and position(
      'ai_canary_spend_archive'
      in pg_get_functiondef(
        'app_private.enforce_ai_spend_fair_share()'::regprocedure
      )
    ) = 0,
  'archive immutability and active-student spend attribution remain unchanged'
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
    '14a11111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase14a-owner@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14A Owner"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '14a22222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase14a-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14A Student"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '14a33333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'phase14a-other@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14A Other"}'::jsonb,
    now(),
    now()
  );

set local session_replication_role = replica;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'da208b06-9087-40d8-8304-d9a4662e3d86',
  'Scheduler Smoke Test Workspace',
  'scheduler-smoke-test-workspace-0b23d636',
  '14a11111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (id, workspace_id, user_id, role)
values
  (
    '14a44444-4444-4444-8444-444444444441',
    'da208b06-9087-40d8-8304-d9a4662e3d86',
    '14a11111-1111-4111-8111-111111111111',
    'owner'
  ),
  (
    '14a44444-4444-4444-8444-444444444442',
    'da208b06-9087-40d8-8304-d9a4662e3d86',
    '14a22222-2222-4222-8222-222222222222',
    'student'
  );

insert into public.grammar_topics (id, slug, name, level, description)
values (
  '14a55555-5555-4555-8555-555555555555',
  'phase14a-scheduler-smoke',
  'Scheduler smoke topic',
  'A1_A2',
  'Rollback-only scheduler archive scope.'
);

insert into public.student_practice_assignments (
  id,
  workspace_id,
  student_id,
  grammar_topic_id,
  source,
  status,
  assigned_by,
  generation_status
)
values (
  '14a66666-6666-4666-8666-666666666666',
  'da208b06-9087-40d8-8304-d9a4662e3d86',
  '14a22222-2222-4222-8222-222222222222',
  '14a55555-5555-4555-8555-555555555555',
  'manual',
  'unlocked',
  '14a11111-1111-4111-8111-111111111111',
  'idle'
);

insert into public.submissions (
  id,
  workspace_id,
  student_id,
  question_source,
  mode,
  original_text,
  status,
  feedback_mode,
  evaluation_status,
  release_status,
  checked_at
)
values
  (
    '14a77777-7777-4777-8777-777777777771',
    'da208b06-9087-40d8-8304-d9a4662e3d86',
    '14a22222-2222-4222-8222-222222222222',
    'free_text',
    'free_text',
    'Ich lerne Deutsch.',
    'checked',
    'immediate',
    'ready',
    'released',
    now()
  ),
  (
    '14a77777-7777-4777-8777-777777777772',
    'da208b06-9087-40d8-8304-d9a4662e3d86',
    '14a22222-2222-4222-8222-222222222222',
    'free_text',
    'free_text',
    'Heute arbeite ich.',
    'checked',
    'immediate',
    'ready',
    'released',
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
    '14a88888-8888-4888-8888-888888888881',
    'writing_evaluation',
    'writing_evaluation',
    '14a77777-7777-4777-8777-777777777771',
    1,
    'phase14a:scheduler:writing-one',
    'succeeded',
    1,
    now()
  ),
  (
    '14a88888-8888-4888-8888-888888888882',
    'writing_evaluation',
    'writing_evaluation',
    '14a77777-7777-4777-8777-777777777772',
    1,
    'phase14a:scheduler:writing-two',
    'succeeded',
    1,
    now()
  ),
  (
    '14a88888-8888-4888-8888-888888888883',
    'worksheet_generation',
    'worksheet_generation',
    '14a66666-6666-4666-8666-666666666666',
    1,
    'phase14a:scheduler:worksheet',
    'succeeded',
    1,
    now()
  );

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
    '14a99999-9999-4999-8999-999999999991',
    '14a88888-8888-4888-8888-888888888881',
    1,
    'scheduler.primary',
    'da208b06-9087-40d8-8304-d9a4662e3d86',
    '14a22222-2222-4222-8222-222222222222',
    date_trunc('month', timezone('UTC', now()))::date,
    'deepseek',
    'deepseek-v4-flash',
    'writing_generation',
    2800,
    140000,
    280000,
    75000,
    'finalized',
    60000,
    1000,
    200,
    200,
    800,
    true,
    null,
    false,
    now() + interval '15 minutes',
    now(),
    null
  ),
  (
    '14a99999-9999-4999-8999-999999999992',
    '14a88888-8888-4888-8888-888888888882',
    1,
    'scheduler.historical',
    'da208b06-9087-40d8-8304-d9a4662e3d86',
    '14a22222-2222-4222-8222-222222222222',
    date_trunc('month', timezone('UTC', now()))::date,
    'gemini',
    'gemini-3.5-flash',
    'writing_critique',
    250000,
    1500000,
    9000000,
    75000,
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

set local session_replication_role = origin;

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role service_role;

select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '42501',
  'Permission denied.',
  'a non-service JWT cannot use the private definer even through a service database role'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-deadbeef',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_identity_mismatch',
  'the hard-bound workspace identity rejects even a regex-valid different slug'
);

select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a33333-3333-4333-8333-333333333333',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_identity_mismatch',
  'the requested student must be the fixture current student member'
);

reset role;
set local session_replication_role = replica;
insert into public.workspace_members (id, workspace_id, user_id, role)
values (
  '14a44444-4444-4444-8444-444444444443',
  'da208b06-9087-40d8-8304-d9a4662e3d86',
  '14a33333-3333-4333-8333-333333333333',
  'student'
);
set local session_replication_role = origin;
set local role service_role;

select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_identity_mismatch',
  'an additional current member makes the exact two-member fixture fail closed'
);

reset role;
set local session_replication_role = replica;
delete from public.workspace_members
where id = '14a44444-4444-4444-8444-444444444443';
update app_private.ai_spend_reservations
set student_id = '14a33333-3333-4333-8333-333333333333'
where id = '14a99999-9999-4999-8999-999999999991';
set local session_replication_role = origin;
set local role service_role;

select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_spend_scope_invalid',
  'a receipt attributed to another student is rejected before copy'
);

reset role;
set local session_replication_role = replica;
update app_private.ai_spend_reservations
set
  student_id = '14a22222-2222-4222-8222-222222222222',
  call_purpose = 'worksheet_critique'
where id = '14a99999-9999-4999-8999-999999999991';
set local session_replication_role = origin;
set local role service_role;

select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_spend_scope_invalid',
  'a valid purpose attached to the wrong job kind is rejected as scope drift'
);

reset role;
set local session_replication_role = replica;
update app_private.ai_spend_reservations
set call_purpose = 'writing_generation'
where id = '14a99999-9999-4999-8999-999999999991';
update app_private.async_jobs
set status = 'queued', completed_at = null, attempt_count = 0
where id = '14a88888-8888-4888-8888-888888888881';
set local session_replication_role = origin;
set local role service_role;

select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_job_active',
  'a nonterminal scoped job prevents archival'
);

reset role;
set local session_replication_role = replica;
update app_private.async_jobs
set status = 'succeeded', completed_at = now(), attempt_count = 1
where id = '14a88888-8888-4888-8888-888888888881';
insert into app_private.worksheet_generation_checkpoints (
  job_id,
  assignment_id,
  entity_version,
  stage,
  candidate_attempt,
  completion_payload_sha256,
  completion_payload
)
values (
  '14a88888-8888-4888-8888-888888888883',
  '14a66666-6666-4666-8666-666666666666',
  1,
  'completion',
  1,
  repeat('a', 64),
  '{}'::jsonb
);
set local session_replication_role = origin;
set local role service_role;

select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_checkpoint_pending',
  'a leftover provider checkpoint prevents archival'
);

reset role;
delete from app_private.worksheet_generation_checkpoints
where job_id = '14a88888-8888-4888-8888-888888888883';

create temporary table phase_14a_queue_message (
  message_id bigint primary key
) on commit drop;
insert into pg_temp.phase_14a_queue_message (message_id)
select sent.message_id
from pgmq.send(
  'writing_evaluation',
  jsonb_build_object(
    'job_id', '14a88888-8888-4888-8888-888888888881'::uuid,
    'job_kind', 'writing_evaluation',
    'entity_id', '14a77777-7777-4777-8777-777777777771'::uuid,
    'entity_version', 1
  ),
  0
) sent(message_id);

set local role service_role;
select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_queue_pending',
  'an active queue message prevents archival even for a terminal job row'
);

reset role;
delete from pgmq.q_writing_evaluation queued
where queued.msg_id = (
  select message_id from pg_temp.phase_14a_queue_message
);

set local session_replication_role = replica;
update app_private.ai_spend_reservations
set
  state = 'reserved',
  release_reason = null,
  released_at = null
where id = '14a99999-9999-4999-8999-999999999992';
set local session_replication_role = origin;
set local role service_role;

select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_spend_not_terminal',
  'a still-reserved receipt prevents archival despite a terminal job'
);

reset role;
set local session_replication_role = replica;
update app_private.ai_spend_reservations
set
  state = 'released',
  release_reason = 'provider_not_called',
  released_at = now()
where id = '14a99999-9999-4999-8999-999999999992';
set local session_replication_role = origin;

insert into app_private.ai_canary_spend_archive (
  original_reservation_id,
  original_job_id,
  entity_version,
  call_key,
  original_workspace_id,
  billing_month,
  provider_name,
  model_name,
  call_purpose,
  input_rate_microusd_per_million,
  output_rate_microusd_per_million,
  reserved_microusd,
  state,
  actual_microusd,
  billed_input_tokens,
  billed_output_tokens,
  release_reason,
  usage_estimated,
  expires_at,
  created_at,
  finalized_at,
  released_at,
  archive_source,
  archive_run_id
)
select
  '14ab9999-9999-4999-8999-999999999991',
  reservation.job_id,
  reservation.entity_version,
  'scheduler.archive.drift',
  reservation.workspace_id,
  reservation.billing_month,
  reservation.provider_name,
  reservation.model_name,
  'worksheet_critique',
  reservation.input_rate_microusd_per_million,
  reservation.output_rate_microusd_per_million,
  reservation.reserved_microusd,
  reservation.state,
  reservation.actual_microusd,
  reservation.billed_input_tokens,
  reservation.billed_output_tokens,
  reservation.release_reason,
  reservation.usage_estimated,
  reservation.expires_at,
  reservation.created_at,
  reservation.finalized_at,
  reservation.released_at,
  'scheduler_smoke_canary_cleanup',
  '14ac0000-0000-4000-8000-000000000001'
from app_private.ai_spend_reservations reservation
where reservation.id = '14a99999-9999-4999-8999-999999999991';

set local role service_role;
select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000001'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_archive_scope_invalid',
  'an archived receipt whose purpose no longer maps to its exact terminal job fails closed'
);

reset role;
set local session_replication_role = replica;
delete from app_private.ai_canary_spend_archive
where original_reservation_id =
  '14ab9999-9999-4999-8999-999999999991';
set local session_replication_role = origin;

create temporary table phase_14a_archive_receipts (
  receipt_kind text primary key,
  archived_reservation_count bigint not null,
  newly_archived_count bigint not null,
  replayed boolean not null
) on commit drop;
grant select, insert on pg_temp.phase_14a_archive_receipts to service_role;

set local role service_role;
insert into pg_temp.phase_14a_archive_receipts
select 'first', receipt.*
from app_private.archive_scheduler_smoke_canary_spend(
  'da208b06-9087-40d8-8304-d9a4662e3d86',
  'scheduler-smoke-test-workspace-0b23d636',
  '14a22222-2222-4222-8222-222222222222',
  '14aa0000-0000-4000-8000-000000000001'
) receipt;
reset role;

select is(
  (
    select jsonb_build_array(
      receipt.archived_reservation_count,
      receipt.newly_archived_count,
      receipt.replayed
    )
    from pg_temp.phase_14a_archive_receipts receipt
    where receipt.receipt_kind = 'first'
  ),
  '[2,2,false]'::jsonb,
  'the first run reports every active receipt copied exactly once'
);

select ok(
  not exists (
      select 1
      from app_private.ai_spend_reservations reservation
      where reservation.workspace_id =
        'da208b06-9087-40d8-8304-d9a4662e3d86'
    )
    and (
      select count(*) = 2
        and count(*) filter (
          where archived.archive_source =
            'scheduler_smoke_canary_cleanup'
        ) = 2
        and count(*) filter (
          where archived.archive_run_id =
            '14aa0000-0000-4000-8000-000000000001'
        ) = 2
        and count(*) filter (where archived.state = 'finalized') = 1
        and count(*) filter (where archived.state = 'released') = 1
        and count(*) filter (
          where archived.model_name = 'gemini-3.5-flash'
        ) = 1
        and sum(archived.actual_microusd) = 60000
      from app_private.ai_canary_spend_archive archived
      where archived.original_workspace_id =
        'da208b06-9087-40d8-8304-d9a4662e3d86'
    )
    and (
      select count(*) = 3
        and count(*) filter (where job.status = 'succeeded') = 3
      from app_private.async_jobs job
      where job.id in (
        '14a88888-8888-4888-8888-888888888881',
        '14a88888-8888-4888-8888-888888888882',
        '14a88888-8888-4888-8888-888888888883'
      )
    ),
  'copy-before-delete removes only active receipts and preserves terminal jobs plus historical model truth'
);

select ok(
  (
    select count(*) = 2
      and sum(entry.reserved_microusd) = 150000
      and sum(entry.actual_microusd) = 60000
      and count(*) filter (where entry.state = 'finalized') = 1
      and count(*) filter (where entry.state = 'released') = 1
    from app_private.ai_spend_accounting_entries() entry
    where entry.workspace_id =
      'da208b06-9087-40d8-8304-d9a4662e3d86'
  ),
  'the existing accounting union preserves global and workspace spend exactly once'
);

set local role service_role;
select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000002'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_archive_run_conflict',
  'an arbitrary new run ID cannot masquerade as replay when only archived rows remain'
);

reset role;
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
  usage_estimated,
  expires_at,
  finalized_at
)
values (
  '14a99999-9999-4999-8999-999999999991',
  '14a88888-8888-4888-8888-888888888881',
  1,
  'scheduler.primary',
  'da208b06-9087-40d8-8304-d9a4662e3d86',
  '14a22222-2222-4222-8222-222222222222',
  date_trunc('month', timezone('UTC', now()))::date,
  'deepseek',
  'deepseek-v4-flash',
  'writing_generation',
  2800,
  140000,
  280000,
  75000,
  'finalized',
  60000,
  1000,
  200,
  200,
  800,
  true,
  false,
  now() + interval '15 minutes',
  now()
);
set local session_replication_role = origin;
set local role service_role;

select throws_ok(
  $sql$
    select *
    from app_private.archive_scheduler_smoke_canary_spend(
      'da208b06-9087-40d8-8304-d9a4662e3d86',
      'scheduler-smoke-test-workspace-0b23d636',
      '14a22222-2222-4222-8222-222222222222',
      '14aa0000-0000-4000-8000-000000000002'
    )
  $sql$,
  '55000',
  'scheduler_smoke_canary_spend_overlap',
  'an active receipt whose immutable archive ID already exists is rejected as overlap'
);

reset role;
set local session_replication_role = replica;
delete from app_private.ai_spend_reservations
where id = '14a99999-9999-4999-8999-999999999991';
set local session_replication_role = origin;
set local role service_role;

insert into pg_temp.phase_14a_archive_receipts
select 'replay', receipt.*
from app_private.archive_scheduler_smoke_canary_spend(
  'da208b06-9087-40d8-8304-d9a4662e3d86',
  'scheduler-smoke-test-workspace-0b23d636',
  '14a22222-2222-4222-8222-222222222222',
  '14aa0000-0000-4000-8000-000000000001'
) receipt;
reset role;

select is(
  (
    select jsonb_build_array(
      receipt.archived_reservation_count,
      receipt.newly_archived_count,
      receipt.replayed
    )
    from pg_temp.phase_14a_archive_receipts receipt
    where receipt.receipt_kind = 'replay'
  ),
  '[2,0,true]'::jsonb,
  'the exact workspace and run ID replay explicitly without duplication'
);

select throws_ok(
  $sql$
    update app_private.ai_canary_spend_archive
    set archived_at = archived_at + interval '1 second'
    where original_workspace_id =
      'da208b06-9087-40d8-8304-d9a4662e3d86'
  $sql$,
  '55000',
  'ai_canary_spend_archive_immutable',
  'scheduler archive rows remain immutable after exact replay'
);

select * from finish();
rollback;
