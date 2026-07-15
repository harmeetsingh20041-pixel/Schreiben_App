begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

select ok(
  to_regprocedure(
    'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'
  ) is not null
    and to_regprocedure(
      'public.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'
    ) is not null
    and to_regprocedure(
      'api.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'
    ) is not null
    and (
      select routine.pronargs = 5
      from pg_proc routine
      where routine.oid =
        'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
    ),
  'the private, public, and api worksheet-live archive signatures remain five-argument compatible'
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
      select routine.prosecdef
        and 'search_path=""' = any(routine.proconfig)
      from pg_proc routine
      where routine.oid =
        'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
    )
    and (
      select routine.prosecdef
        and 'search_path=""' = any(routine.proconfig)
      from pg_proc routine
      where routine.oid =
        'public.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
    )
    and (
      select not routine.prosecdef
        and 'search_path=""' = any(routine.proconfig)
      from pg_proc routine
      where routine.oid =
        'api.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
    ),
  'only service_role reaches the unchanged fixed-search-path definer facade'
);

select ok(
  (
    select
      pg_get_functiondef(routine.oid) like
        '%selected_fixture_level not in (''A1'', ''A2'', ''B1'', ''B2'')%'
      and pg_get_functiondef(routine.oid) like
        '%from public.batches batch%for update nowait%'
      and pg_get_functiondef(routine.oid) like
        '%from public.grammar_topics topic%for update nowait%'
      and pg_get_functiondef(routine.oid) like
        '%from public.practice_tests test%for update nowait%'
      and pg_get_functiondef(routine.oid) like
        '%bank_topic.level <> ''B1_B2''%'
    from pg_proc routine
    where routine.oid =
      'app_private.archive_worksheet_live_canary_spend(uuid,text,uuid,uuid,uuid)'::regprocedure
  ),
  'the private implementation carries the all-level contract and deterministic batch/topic/test locks'
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
    'e1411111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase14e-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14E Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e1422222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase14e-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 14E Student"}'::jsonb,
    now(),
    now()
  );

set local session_replication_role = replica;

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    'e1300000-0000-4000-8000-000000000001',
    'V1 worksheet live e1300000',
    'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
    'e1411111-1111-4111-8111-111111111111'
  ),
  (
    'e1499999-9999-4999-8999-999999999999',
    'Phase 14E unrelated workspace',
    'phase-14e-unrelated-workspace',
    'e1411111-1111-4111-8111-111111111111'
  );

insert into public.workspace_members (id, workspace_id, user_id, role)
values
  (
    'e1433333-3333-4333-8333-333333333331',
    'e1300000-0000-4000-8000-000000000001',
    'e1411111-1111-4111-8111-111111111111',
    'teacher'
  ),
  (
    'e1433333-3333-4333-8333-333333333332',
    'e1300000-0000-4000-8000-000000000001',
    'e1422222-2222-4222-8222-222222222222',
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
  'A1',
  'e1411111-1111-4111-8111-111111111111',
  'immediate',
  true,
  true
);

insert into public.batch_students (
  id, batch_id, student_id, workspace_id
)
values (
  'e1455555-5555-4555-8555-555555555555',
  'e1300000-0000-4000-8000-000000000004',
  'e1422222-2222-4222-8222-222222222222',
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
    'A1',
    'Synthetic staging canary for focused A1 accusative-case practice.'
  ),
  (
    'e1488888-8888-4888-8888-888888888882',
    'phase14e-bank-topic',
    'Artikel',
    'A1_A2',
    'Rollback-only bank topic.'
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
    'e1422222-2222-4222-8222-222222222222',
    'e1300000-0000-4000-8000-000000000008',
    'manual',
    'unlocked',
    'e1411111-1111-4111-8111-111111111111',
    'ready',
    'e1300000-0000-4000-8000-000000000004',
    'A1',
    1,
    'teacher_verified'
  ),
  (
    'e1300000-0000-4000-8000-000000000007',
    'e1300000-0000-4000-8000-000000000001',
    'e1422222-2222-4222-8222-222222222222',
    'e1488888-8888-4888-8888-888888888882',
    'manual',
    'unlocked',
    'e1411111-1111-4111-8111-111111111111',
    'ready',
    'e1300000-0000-4000-8000-000000000004',
    'A1',
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
    'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'e1300000-0000-4000-8000-000000000001',
    'e1300000-0000-4000-8000-000000000008',
    'A1',
    'medium',
    'Phase 14E provider worksheet',
    true,
    false,
    'private',
    'e1411111-1111-4111-8111-111111111111',
    'deepseek',
    'approved'
  ),
  (
    'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    'e1300000-0000-4000-8000-000000000001',
    'e1488888-8888-4888-8888-888888888882',
    'A1',
    'medium',
    'Phase 14E bank worksheet',
    false,
    true,
    'private',
    'e1411111-1111-4111-8111-111111111111',
    'manual',
    'approved'
  );

update public.student_practice_assignments assignment
set practice_test_id = case assignment.id
  when 'e1300000-0000-4000-8000-000000000006'::uuid
    then 'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
  else 'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid
end
where assignment.id in (
  'e1300000-0000-4000-8000-000000000006',
  'e1300000-0000-4000-8000-000000000007'
);

set local session_replication_role = origin;

create function pg_temp.configure_phase_14e_fixture(
  target_level text,
  target_bank_topic_level text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.batches batch
  set level = target_level
  where batch.id = 'e1300000-0000-4000-8000-000000000004';

  update public.student_practice_assignments assignment
  set
    workspace_id = 'e1300000-0000-4000-8000-000000000001',
    student_id = 'e1422222-2222-4222-8222-222222222222',
    grammar_topic_id = case assignment.id
      when 'e1300000-0000-4000-8000-000000000006'::uuid
        then 'e1300000-0000-4000-8000-000000000008'::uuid
      else 'e1488888-8888-4888-8888-888888888882'::uuid
    end,
    source = 'manual',
    assigned_by = 'e1411111-1111-4111-8111-111111111111',
    batch_id = 'e1300000-0000-4000-8000-000000000004',
    worksheet_level = target_level,
    class_context_version = 1,
    class_context_integrity = 'teacher_verified',
    practice_test_id = case assignment.id
      when 'e1300000-0000-4000-8000-000000000006'::uuid
        then 'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
      else 'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'::uuid
    end
  where assignment.id in (
    'e1300000-0000-4000-8000-000000000006',
    'e1300000-0000-4000-8000-000000000007'
  );

  update public.grammar_topics topic
  set
    slug = 'e2e-worksheet-provider-canary',
    name = 'Akkusativ',
    level = target_level,
    description =
      'Synthetic staging canary for focused ' || target_level ||
        ' accusative-case practice.'
  where topic.id = 'e1300000-0000-4000-8000-000000000008';

  update public.grammar_topics topic
  set
    slug = 'phase14e-bank-topic',
    name = 'Artikel',
    level = target_bank_topic_level,
    description = 'Rollback-only bank topic.'
  where topic.id = 'e1488888-8888-4888-8888-888888888882';

  update public.practice_tests test
  set
    workspace_id = 'e1300000-0000-4000-8000-000000000001',
    grammar_topic_id = case test.id
      when 'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid
        then 'e1300000-0000-4000-8000-000000000008'::uuid
      else 'e1488888-8888-4888-8888-888888888882'::uuid
    end,
    level = target_level
  where test.workspace_id = 'e1300000-0000-4000-8000-000000000001';
end;
$$;

create temporary table phase_14e_archive_receipts (
  fixture_level text primary key,
  archived_reservation_count bigint not null,
  newly_archived_count bigint not null,
  replayed boolean not null
) on commit drop;
grant select, insert on pg_temp.phase_14e_archive_receipts to service_role;

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
  'an authenticated browser still cannot call the service-only archive'
);

reset role;

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('A1', 'A1_A2');
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
insert into pg_temp.phase_14e_archive_receipts
select 'A1', receipt.*
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
    from pg_temp.phase_14e_archive_receipts receipt
    where receipt.fixture_level = 'A1'
  ),
  '[0,0,false]'::jsonb,
  'A1 accepts an exact provider topic/test and the shared A1_A2 bank topic'
);

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('A2', 'A1_A2');
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
insert into pg_temp.phase_14e_archive_receipts
select 'A2', receipt.*
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
    from pg_temp.phase_14e_archive_receipts receipt
    where receipt.fixture_level = 'A2'
  ),
  '[0,0,false]'::jsonb,
  'A2 accepts an exact provider topic/test and the shared A1_A2 bank topic'
);

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('B1', 'B1');
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
insert into pg_temp.phase_14e_archive_receipts
select 'B1', receipt.*
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
    from pg_temp.phase_14e_archive_receipts receipt
    where receipt.fixture_level = 'B1'
  ),
  '[0,0,false]'::jsonb,
  'B1 accepts only exact-level provider, bank, and test context'
);

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('B2', 'B2');
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
insert into pg_temp.phase_14e_archive_receipts
select 'B2', receipt.*
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
    from pg_temp.phase_14e_archive_receipts receipt
    where receipt.fixture_level = 'B2'
  ),
  '[0,0,false]'::jsonb,
  'B2 accepts only exact-level provider, bank, and test context'
);

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('A2', 'A1_A2');
update public.student_practice_assignments assignment
set worksheet_level = 'A1'
where assignment.id = 'e1300000-0000-4000-8000-000000000006';
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select * from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_assignment_scope_invalid',
  'a provider assignment at the wrong CEFR level fails closed'
);
reset role;

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('A2', 'A1_A2');
update public.grammar_topics topic
set description = 'Wrong synthetic description.'
where topic.id = 'e1300000-0000-4000-8000-000000000008';
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select * from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_assignment_scope_invalid',
  'a provider topic with a non-exact dynamic description fails closed'
);
reset role;

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('A2', 'A1_A2');
update public.grammar_topics topic
set level = 'A1_A2'
where topic.id = 'e1300000-0000-4000-8000-000000000008';
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select * from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_assignment_scope_invalid',
  'the synthetic provider topic must use the exact fixture level'
);
reset role;

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('A2', 'A1_A2');
update public.practice_tests test
set level = 'A1'
where test.id = 'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select * from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_test_scope_invalid',
  'an attached practice test at the wrong level fails closed'
);
reset role;

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('B1', 'A1_A2');
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select * from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_assignment_scope_invalid',
  'B1 cannot reuse a broad family bank topic and therefore cannot admit B1_B2'
);
reset role;

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('A2', 'A1_A2');
update public.student_practice_assignments assignment
set workspace_id = 'e1499999-9999-4999-8999-999999999999'
where assignment.id = 'e1300000-0000-4000-8000-000000000006';
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select * from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_assignment_scope_invalid',
  'a fixed provider identity rebound to an unrelated workspace fails closed'
);
reset role;

set local session_replication_role = replica;
select pg_temp.configure_phase_14e_fixture('A2', 'A1_A2');

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
  'e14ccccc-cccc-4ccc-8ccc-ccccccccccc1',
  'worksheet_generation',
  'worksheet_generation',
  'e1300000-0000-4000-8000-000000000006',
  1,
  'phase14e-generation',
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
  expires_at
)
values (
  'e14ddddd-dddd-4ddd-8ddd-ddddddddddd1',
  'e14ccccc-cccc-4ccc-8ccc-ccccccccccc1',
  1,
  'phase14e.generation',
  'e1300000-0000-4000-8000-000000000001',
  'e1422222-2222-4222-8222-222222222222',
  date_trunc('month', timezone('UTC', now()))::date,
  'deepseek',
  'deepseek-v4-flash',
  'worksheet_generation',
  2800,
  100000,
  200000,
  300000,
  'reserved',
  now() + interval '15 minutes'
);
select set_config('app.ai_spend_transition', 'off', true);

set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $sql$
    select * from api.archive_worksheet_live_canary_spend(
      'e1300000-0000-4000-8000-000000000001',
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001',
      'e1300000-0000-4000-8000-000000000004',
      'e1300000-0000-4000-8000-000000000006',
      'e1300000-0000-4000-8000-000000000007'
    )
  $sql$,
  '55000',
  'worksheet_live_canary_spend_not_terminal',
  'a reserved provider call remains non-archivable even when its job is terminal'
);

reset role;

-- The browser cleanup also removes a model-cache chain when the fixed
-- provider worksheet was promoted before teardown. Exercise that destructive
-- boundary inside this rollback-only transaction. The resolver starts from
-- the fixed workspace/assignment/test identity; callers never provide a cache
-- revision ID. A separate workspace owns the sentinel chain.
set local session_replication_role = replica;

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
    'e1460000-0000-4000-8000-000000000010',
    'e1499999-9999-4999-8999-999999999999',
    'e1488888-8888-4888-8888-888888888882',
    'A2',
    'medium',
    'Phase 14E unrelated cache sentinel',
    true,
    false,
    'private',
    'e1411111-1111-4111-8111-111111111111',
    'deepseek',
    'approved'
  ),
  (
    'e1460000-0000-4000-8000-000000000020',
    'e1499999-9999-4999-8999-999999999999',
    'e1488888-8888-4888-8888-888888888882',
    'A2',
    'medium',
    'Phase 14E unrelated cache ambiguity source',
    true,
    false,
    'private',
    'e1411111-1111-4111-8111-111111111111',
    'deepseek',
    'approved'
  );

update public.student_practice_assignments assignment
set generation_version = 1
where assignment.id = 'e1300000-0000-4000-8000-000000000006';

update app_private.async_jobs job
set requested_by = 'e1422222-2222-4222-8222-222222222222'
where job.id = 'e14ccccc-cccc-4ccc-8ccc-ccccccccccc1';

update public.practice_tests test
set
  generated_from_assignment_id =
    'e1300000-0000-4000-8000-000000000006',
  generation_job_id = 'e14ccccc-cccc-4ccc-8ccc-ccccccccccc1',
  description =
    'Nine deterministic questions for exact A2 canary cache cleanup.',
  mini_lesson = '{
    "short_explanation":"Choose the only grammatically valid form.",
    "key_rule":"Use the sentence context.",
    "common_mistake_warning":"Check every option.",
    "what_to_revise":"Review the accusative form.",
    "correct_examples":["Ich sehe den Mann."]
  }'::jsonb,
  visibility = 'workspace',
  approval_source = 'independent_model_validation',
  generator_model = 'deepseek-v4-pro',
  generation_metadata = '{
    "schema_version":2,
    "validation":{
      "deterministic":true,
      "independent_model":true
    }
  }'::jsonb
where test.id = 'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

insert into public.practice_test_questions (
  practice_test_id,
  question_number,
  question_type,
  evaluation_mode,
  prompt,
  options,
  correct_answer,
  accepted_answers,
  rubric,
  answer_contract_version,
  explanation
)
select
  'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  question_number,
  'multiple_choice',
  'local_exact',
  format(
    'Welche Form ist in A2-Testsatz Nummer %s eindeutig richtig?',
    question_number
  ),
  jsonb_build_array(
    format('Antwort %sA', question_number),
    format('Antwort %sB', question_number),
    format('Antwort %sC', question_number)
  ),
  format('Antwort %sA', question_number),
  jsonb_build_array(format('Antwort %sA', question_number)),
  null,
  1,
  format(
    'Nur Antwort %sA erfüllt die eindeutige Bedingung.',
    question_number
  )
from generate_series(1, 9) question_number;

create temporary table phase_14e_target_cache_hash (
  content_sha256 text primary key
) on commit drop;

insert into pg_temp.phase_14e_target_cache_hash (content_sha256)
select app_private.practice_test_content_sha256(
  'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
);

insert into app_private.worksheet_generation_completions_v2 (
  job_id,
  practice_test_id,
  completion_mode,
  evidence_version,
  provider_source,
  generator_model,
  primary_critic_provider,
  primary_critic_model,
  primary_verdict_sha256,
  secondary_critic_provider,
  secondary_critic_model,
  secondary_verdict_sha256,
  candidate_sha256,
  provider_metadata,
  payload_sha256,
  content_sha256,
  completed_at
)
select
  'e14ccccc-cccc-4ccc-8ccc-ccccccccccc1',
  'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'generated',
  2,
  'deepseek',
  'deepseek-v4-pro',
  'deepseek',
  'deepseek-v4-flash',
  repeat('2', 64),
  'gemini',
  'gemini-3.1-flash-lite',
  repeat('3', 64),
  repeat('1', 64),
  '{
    "schema_version":2,
    "validation":{
      "deterministic":true,
      "independent_model":true
    }
  }'::jsonb,
  repeat('9', 64),
  cache_hash.content_sha256,
  '2026-07-14 00:00:00+00'
from pg_temp.phase_14e_target_cache_hash cache_hash;

insert into app_private.practice_worksheet_model_cache_revisions (
  id,
  grammar_topic_id,
  level,
  difficulty,
  title,
  description,
  mini_lesson,
  generator_provider,
  generator_model,
  validation_profile,
  validation_metadata,
  source_practice_test_id,
  source_completion_job_id,
  candidate_sha256,
  primary_critic_provider,
  primary_critic_model,
  primary_verdict_sha256,
  secondary_critic_provider,
  secondary_critic_model,
  secondary_verdict_sha256,
  content_sha256,
  promoted_at
)
values
  (
    'e1460000-0000-4000-8000-000000000001',
    'e1300000-0000-4000-8000-000000000008',
    'A2',
    'medium',
    'Phase 14E provider worksheet',
    'Nine deterministic questions for exact A2 canary cache cleanup.',
    '{
      "short_explanation":"Choose the only grammatically valid form.",
      "key_rule":"Use the sentence context.",
      "common_mistake_warning":"Check every option.",
      "what_to_revise":"Review the accusative form.",
      "correct_examples":["Ich sehe den Mann."]
    }'::jsonb,
    'deepseek',
    'deepseek-v4-pro',
    'mcq_safe_v1',
    '{"schema_version":1}'::jsonb,
    'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'e14ccccc-cccc-4ccc-8ccc-ccccccccccc1',
    repeat('1', 64),
    'deepseek',
    'deepseek-v4-flash',
    repeat('2', 64),
    'gemini',
    'gemini-3.1-flash-lite',
    repeat('3', 64),
    (
      select cache_hash.content_sha256
      from pg_temp.phase_14e_target_cache_hash cache_hash
    ),
    '2026-07-14 00:00:00+00'
  ),
  (
    'e1460000-0000-4000-8000-000000000011',
    'e1488888-8888-4888-8888-888888888882',
    'A2',
    'medium',
    'Phase 14E unrelated cache revision',
    'Unrelated sentinel cache revision.',
    '{"summary":"Artikel"}'::jsonb,
    'deepseek',
    'deepseek-v4-flash',
    'mcq_safe_v1',
    '{"schema_version":1,"sentinel":true}'::jsonb,
    'e1460000-0000-4000-8000-000000000010',
    'e1460000-0000-4000-8000-000000000111',
    repeat('5', 64),
    'deepseek',
    'deepseek-v4-flash',
    repeat('6', 64),
    'gemini',
    'gemini-3.5-flash',
    repeat('7', 64),
    repeat('8', 64),
    '2026-07-14 00:01:00+00'
  );

insert into app_private.practice_worksheet_model_cache_questions (
  id,
  revision_id,
  question_number,
  question_type,
  evaluation_mode,
  prompt,
  options,
  correct_answer,
  accepted_answers,
  rubric,
  answer_contract_version,
  explanation,
  created_at
)
values
  (
    'e1460000-0000-4000-8000-000000000002',
    'e1460000-0000-4000-8000-000000000001',
    1,
    'multiple_choice',
    'local_exact',
    'Welche Form ist in A2-Testsatz Nummer 1 eindeutig richtig?',
    '["Antwort 1A", "Antwort 1B", "Antwort 1C"]'::jsonb,
    'Antwort 1A',
    '["Antwort 1A"]'::jsonb,
    null,
    1,
    'Nur Antwort 1A erfüllt die eindeutige Bedingung.',
    '2026-07-14 00:00:01+00'
  ),
  (
    'e1460000-0000-4000-8000-000000000012',
    'e1460000-0000-4000-8000-000000000011',
    1,
    'multiple_choice',
    'local_exact',
    'Wähle den richtigen Artikel für das Nomen aus.',
    '["die", "das", "der"]'::jsonb,
    'die',
    '["die"]'::jsonb,
    null,
    1,
    'Der passende Artikel ist die.',
    '2026-07-14 00:01:01+00'
  );

insert into app_private.practice_worksheet_model_cache_questions (
  revision_id,
  question_number,
  question_type,
  evaluation_mode,
  prompt,
  options,
  correct_answer,
  accepted_answers,
  rubric,
  answer_contract_version,
  explanation,
  created_at
)
select
  'e1460000-0000-4000-8000-000000000001',
  question.question_number,
  question.question_type,
  question.evaluation_mode,
  question.prompt,
  question.options,
  question.correct_answer,
  question.accepted_answers,
  question.rubric,
  question.answer_contract_version,
  question.explanation,
  '2026-07-14 00:00:01+00'
from public.practice_test_questions question
where question.practice_test_id = 'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  and question.question_number between 2 and 9
order by question.question_number;

insert into app_private.practice_worksheet_model_cache_sources (
  source_practice_test_id,
  revision_id,
  source_completion_job_id,
  source_content_sha256,
  linked_at
)
values
  (
    'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'e1460000-0000-4000-8000-000000000001',
    'e14ccccc-cccc-4ccc-8ccc-ccccccccccc1',
    (
      select cache_hash.content_sha256
      from pg_temp.phase_14e_target_cache_hash cache_hash
    ),
    '2026-07-14 00:00:02+00'
  ),
  (
    'e1460000-0000-4000-8000-000000000010',
    'e1460000-0000-4000-8000-000000000011',
    'e1460000-0000-4000-8000-000000000111',
    repeat('8', 64),
    '2026-07-14 00:01:02+00'
  );

insert into app_private.practice_worksheet_model_cache_promotion_failures (
  source_practice_test_id,
  source_completion_job_id,
  failure_count,
  first_failed_at,
  last_attempt_at,
  next_retry_at,
  last_safe_error_code,
  resolved_at
)
values
  (
    'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'e14ccccc-cccc-4ccc-8ccc-ccccccccccc1',
    2,
    '2026-07-13 23:58:00+00',
    '2026-07-14 00:00:03+00',
    '2026-07-14 00:00:03+00',
    'model_cache_promotion_resolved',
    '2026-07-14 00:00:03+00'
  ),
  (
    'e1460000-0000-4000-8000-000000000010',
    'e1460000-0000-4000-8000-000000000111',
    1,
    '2026-07-14 00:00:30+00',
    '2026-07-14 00:01:03+00',
    '2026-07-14 00:01:03+00',
    'model_cache_promotion_resolved',
    '2026-07-14 00:01:03+00'
  );

set local session_replication_role = origin;

create temporary table phase_14e_cache_sentinel_snapshot (
  payload_bytes bytea not null
) on commit drop;

insert into pg_temp.phase_14e_cache_sentinel_snapshot (payload_bytes)
select convert_to(
  jsonb_build_object(
    'revision', (
      select to_jsonb(revision)
      from app_private.practice_worksheet_model_cache_revisions revision
      where revision.id = 'e1460000-0000-4000-8000-000000000011'
    ),
    'question', (
      select to_jsonb(question)
      from app_private.practice_worksheet_model_cache_questions question
      where question.id = 'e1460000-0000-4000-8000-000000000012'
    ),
    'source', (
      select to_jsonb(source_link)
      from app_private.practice_worksheet_model_cache_sources source_link
      where source_link.source_practice_test_id =
        'e1460000-0000-4000-8000-000000000010'
    ),
    'promotion_failure', (
      select to_jsonb(failure)
      from app_private.practice_worksheet_model_cache_promotion_failures failure
      where failure.source_practice_test_id =
        'e1460000-0000-4000-8000-000000000010'
    )
  )::text,
  'UTF8'
);

create function pg_temp.resolve_phase_14e_fixture_cache()
returns table (
  revision_id uuid,
  source_practice_test_id uuid,
  source_completion_job_id uuid,
  question_count bigint,
  promotion_failure_count bigint
)
language sql
stable
set search_path = ''
as $$
  select
    revision.id,
    source_link.source_practice_test_id,
    source_link.source_completion_job_id,
    (
      select count(*)
      from app_private.practice_worksheet_model_cache_questions question
      where question.revision_id = revision.id
    ),
    (
      select count(*)
      from app_private.practice_worksheet_model_cache_promotion_failures failure
      where failure.source_practice_test_id = source_test.id
        and failure.source_completion_job_id =
          source_link.source_completion_job_id
    )
  from public.workspaces workspace
  join public.batches batch
    on batch.workspace_id = workspace.id
  join public.student_practice_assignments assignment
    on assignment.workspace_id = workspace.id
   and assignment.batch_id = batch.id
  join public.grammar_topics topic
    on topic.id = assignment.grammar_topic_id
  join app_private.async_jobs job
    on job.entity_id = assignment.id
   and job.entity_version = assignment.generation_version
   and job.job_kind = 'worksheet_generation'
   and job.queue_name = 'worksheet_generation'
   and job.status = 'succeeded'
   and job.completed_at is not null
   and job.dead_at is null
   and job.worker_id is null
   and job.lease_expires_at is null
   and job.requested_by = assignment.student_id
  join app_private.worksheet_generation_completions_v2 completion
    on completion.job_id = job.id
   and completion.completion_mode = 'generated'
   and completion.evidence_version = 2
  join public.practice_tests source_test
    on source_test.id = completion.practice_test_id
   and source_test.id = assignment.practice_test_id
   and source_test.workspace_id = assignment.workspace_id
   and source_test.grammar_topic_id = assignment.grammar_topic_id
   and source_test.level = assignment.worksheet_level
   and source_test.generated_from_assignment_id = assignment.id
   and source_test.generation_job_id = job.id
   and source_test.generation_source = completion.provider_source
   and source_test.generator_model = completion.generator_model
   and source_test.generation_metadata is not distinct from
     completion.provider_metadata
   and source_test.quality_status = 'approved'
   and source_test.approval_source = 'independent_model_validation'
   and source_test.created_by_ai
   and not source_test.teacher_reviewed
   and source_test.visibility = 'workspace'
   and source_test.generation_metadata #>>
     '{validation,deterministic}' = 'true'
   and source_test.generation_metadata #>>
     '{validation,independent_model}' = 'true'
  join app_private.practice_worksheet_model_cache_sources source_link
    on source_link.source_practice_test_id = source_test.id
   and source_link.source_completion_job_id = completion.job_id
  join app_private.practice_worksheet_model_cache_revisions revision
    on revision.id = source_link.revision_id
   and revision.source_practice_test_id = source_test.id
   and revision.source_completion_job_id =
     source_link.source_completion_job_id
   and revision.generator_provider = completion.provider_source
   and revision.generator_model = completion.generator_model
   and revision.candidate_sha256 = completion.candidate_sha256
   and revision.primary_critic_provider =
     completion.primary_critic_provider
   and revision.primary_critic_model = completion.primary_critic_model
   and revision.primary_verdict_sha256 =
     completion.primary_verdict_sha256
   and revision.secondary_critic_provider =
     completion.secondary_critic_provider
   and revision.secondary_critic_model = completion.secondary_critic_model
   and revision.secondary_verdict_sha256 =
     completion.secondary_verdict_sha256
   and revision.content_sha256 = completion.content_sha256
   and source_link.source_content_sha256 = completion.content_sha256
  where workspace.id = 'e1300000-0000-4000-8000-000000000001'
    and workspace.slug =
      'e2e-worksheet-live-e1300000-0000-4000-8000-000000000001'
    and batch.id = 'e1300000-0000-4000-8000-000000000004'
    and batch.level in ('A1', 'A2', 'B1', 'B2')
    and assignment.id = 'e1300000-0000-4000-8000-000000000006'
    and assignment.worksheet_level = batch.level
    and topic.id = 'e1300000-0000-4000-8000-000000000008'
    and topic.slug = 'e2e-worksheet-provider-canary'
    and topic.level = batch.level
    and topic.description =
      'Synthetic staging canary for focused ' || batch.level ||
        ' accusative-case practice.'
    and revision.grammar_topic_id = topic.id
    and revision.level = batch.level
    and app_private.practice_worksheet_model_cache_revision_is_current(
      revision.id
    );
$$;

create function pg_temp.delete_phase_14e_fixture_cache()
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  selected record;
  selected_count bigint;
  deleted_count bigint := 0;
  affected_count bigint;
begin
  if current_setting('session_replication_role') <> 'replica' then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_cache_test_delete_guard_required';
  end if;

  select count(*)
  into selected_count
  from pg_temp.resolve_phase_14e_fixture_cache();

  if selected_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_cache_scope_ambiguous';
  end if;

  select *
  into selected
  from pg_temp.resolve_phase_14e_fixture_cache();

  if selected.question_count < 1
    or selected.promotion_failure_count > 1
    or (
      select count(*)
      from app_private.practice_worksheet_model_cache_sources source_link
      where source_link.revision_id = selected.revision_id
    ) <> 1
    or exists (
      select 1
      from public.practice_tests clone
      where clone.worksheet_model_cache_revision_id = selected.revision_id
    )
    or exists (
      select 1
      from app_private.practice_worksheet_model_cache_withdrawals withdrawal
      where withdrawal.revision_id = selected.revision_id
    )
    or exists (
      select 1
      from app_private.practice_worksheet_model_cache_attachment_events event
      where event.cache_revision_id = selected.revision_id
    )
    or exists (
      select 1
      from app_private.practice_worksheet_model_cache_recovery_failures failure
      where failure.cache_revision_id = selected.revision_id
    )
  then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_cache_scope_ambiguous';
  end if;

  delete from app_private.practice_worksheet_model_cache_promotion_failures failure
  where failure.source_practice_test_id = selected.source_practice_test_id
    and failure.source_completion_job_id = selected.source_completion_job_id;
  get diagnostics affected_count = row_count;
  deleted_count := deleted_count + affected_count;

  delete from app_private.practice_worksheet_model_cache_questions question
  where question.revision_id = selected.revision_id;
  get diagnostics affected_count = row_count;
  if affected_count <> selected.question_count then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_cache_delete_incomplete';
  end if;
  deleted_count := deleted_count + affected_count;

  delete from app_private.practice_worksheet_model_cache_sources source_link
  where source_link.source_practice_test_id =
      selected.source_practice_test_id
    and source_link.source_completion_job_id =
      selected.source_completion_job_id
    and source_link.revision_id = selected.revision_id;
  get diagnostics affected_count = row_count;
  if affected_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_cache_delete_incomplete';
  end if;
  deleted_count := deleted_count + affected_count;

  delete from app_private.practice_worksheet_model_cache_revisions revision
  where revision.id = selected.revision_id
    and revision.source_practice_test_id =
      selected.source_practice_test_id
    and revision.source_completion_job_id =
      selected.source_completion_job_id;
  get diagnostics affected_count = row_count;
  if affected_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'worksheet_live_cache_delete_incomplete';
  end if;

  return deleted_count + affected_count;
end;
$$;

select is(
  (
    select jsonb_build_array(
      scope.revision_id,
      scope.source_practice_test_id,
      scope.source_completion_job_id,
      scope.question_count,
      scope.promotion_failure_count
    )
    from pg_temp.resolve_phase_14e_fixture_cache() scope
  ),
  '[
    "e1460000-0000-4000-8000-000000000001",
    "e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "e14ccccc-cccc-4ccc-8ccc-ccccccccccc1",
    9,
    1
  ]'::jsonb,
  'the model-cache chain is derived from the exact fixed provider fixture'
);

set local session_replication_role = replica;
insert into app_private.practice_worksheet_model_cache_sources (
  source_practice_test_id,
  revision_id,
  source_completion_job_id,
  source_content_sha256,
  linked_at
)
values (
  'e1460000-0000-4000-8000-000000000020',
  'e1460000-0000-4000-8000-000000000001',
  'e1460000-0000-4000-8000-000000000121',
  repeat('4', 64),
  '2026-07-14 00:02:00+00'
);

select throws_ok(
  'select pg_temp.delete_phase_14e_fixture_cache()',
  '55000',
  'worksheet_live_cache_scope_ambiguous',
  'a revision shared with an unrelated source fails closed before deletion'
);

select is(
  (
    select count(*)
    from (
      select revision.id
      from app_private.practice_worksheet_model_cache_revisions revision
      where revision.id = 'e1460000-0000-4000-8000-000000000001'
      union all
      select question.id
      from app_private.practice_worksheet_model_cache_questions question
      where question.revision_id = 'e1460000-0000-4000-8000-000000000001'
      union all
      select source_link.source_practice_test_id
      from app_private.practice_worksheet_model_cache_sources source_link
      where source_link.revision_id = 'e1460000-0000-4000-8000-000000000001'
      union all
      select failure.source_practice_test_id
      from app_private.practice_worksheet_model_cache_promotion_failures failure
      where failure.source_practice_test_id =
        'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    ) preserved
  ),
  13::bigint,
  'the ambiguity rejection leaves every target and unrelated source row intact'
);

delete from app_private.practice_worksheet_model_cache_sources source_link
where source_link.source_practice_test_id =
  'e1460000-0000-4000-8000-000000000020';

select is(
  pg_temp.delete_phase_14e_fixture_cache(),
  12::bigint,
  'the exact fixture cache revision, source, questions, and failure are deleted'
);
set local session_replication_role = origin;

select ok(
  not exists (
    select 1
    from app_private.practice_worksheet_model_cache_revisions revision
    where revision.id = 'e1460000-0000-4000-8000-000000000001'
  )
    and not exists (
      select 1
      from app_private.practice_worksheet_model_cache_questions question
      where question.revision_id = 'e1460000-0000-4000-8000-000000000001'
    )
    and not exists (
      select 1
      from app_private.practice_worksheet_model_cache_sources source_link
      where source_link.source_practice_test_id =
        'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    )
    and not exists (
      select 1
      from app_private.practice_worksheet_model_cache_promotion_failures failure
      where failure.source_practice_test_id =
        'e14aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    ),
  'no target model-cache residue remains after the exact deletion'
);

select is(
  convert_to(
    jsonb_build_object(
      'revision', (
        select to_jsonb(revision)
        from app_private.practice_worksheet_model_cache_revisions revision
        where revision.id = 'e1460000-0000-4000-8000-000000000011'
      ),
      'question', (
        select to_jsonb(question)
        from app_private.practice_worksheet_model_cache_questions question
        where question.id = 'e1460000-0000-4000-8000-000000000012'
      ),
      'source', (
        select to_jsonb(source_link)
        from app_private.practice_worksheet_model_cache_sources source_link
        where source_link.source_practice_test_id =
          'e1460000-0000-4000-8000-000000000010'
      ),
      'promotion_failure', (
        select to_jsonb(failure)
        from app_private.practice_worksheet_model_cache_promotion_failures failure
        where failure.source_practice_test_id =
          'e1460000-0000-4000-8000-000000000010'
      )
    )::text,
    'UTF8'
  ),
  (
    select snapshot.payload_bytes
    from pg_temp.phase_14e_cache_sentinel_snapshot snapshot
  ),
  'the unrelated model-cache sentinel remains byte-for-byte unchanged'
);

select * from finish();
rollback;
