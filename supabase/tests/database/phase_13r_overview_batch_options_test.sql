begin;

select plan(12);

select ok(
  to_regprocedure(
    'api.list_workspace_batch_options(uuid,integer,timestamptz,uuid,text)'
  ) is not null,
  'the bounded Overview batch-options RPC exists'
);

select ok(
  not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.list_workspace_batch_options(uuid,integer,timestamptz,uuid,text)'::regprocedure
  )
    and exists (
      select 1
      from pg_proc routine,
      lateral unnest(coalesce(routine.proconfig, array[]::text[])) setting
      where routine.oid =
        'api.list_workspace_batch_options(uuid,integer,timestamptz,uuid,text)'::regprocedure
        and setting ~ '^search_path=(""|)$'
    ),
  'the bounded reader uses caller privileges and an empty search path'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.list_workspace_batch_options(uuid,integer,timestamptz,uuid,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'api.list_workspace_batch_options(uuid,integer,timestamptz,uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.list_workspace_batch_options(uuid,integer,timestamptz,uuid,text)',
      'EXECUTE'
    ),
  'only authenticated application callers can use the bounded reader'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'e2111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase13r-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13R Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e2222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase13r-member@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13R Student Member"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e2555555-5555-4555-8555-555555555555',
    'authenticated', 'authenticated', 'phase13r-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13R Outsider"}'::jsonb, now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'e2111111-1111-4111-8111-111111111111',
    'Phase 13R Teacher', 'phase13r-teacher@example.test', 'teacher'
  ),
  (
    'e2222222-2222-4222-8222-222222222222',
    'Phase 13R Student Member', 'phase13r-member@example.test', 'student'
  ),
  (
    'e2555555-5555-4555-8555-555555555555',
    'Phase 13R Outsider', 'phase13r-outsider@example.test', 'student'
  )
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  note
)
values (
  'e2111111-1111-4111-8111-111111111111',
  true,
  1,
  'Phase 13R entitled teacher fixture.'
);

insert into public.workspaces (id, name, slug, owner_id)
values (
  'e2333333-3333-4333-8333-333333333333',
  'Phase 13R Workspace',
  'phase-13r-workspace',
  'e2111111-1111-4111-8111-111111111111'
);

select set_config(
  'request.jwt.claim.sub',
  'e2111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);
insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'e2333333-3333-4333-8333-333333333333',
    'e2111111-1111-4111-8111-111111111111',
    'owner'
  ),
  (
    'e2333333-3333-4333-8333-333333333333',
    'e2222222-2222-4222-8222-222222222222',
    'student'
  );
select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by, created_at
)
values
  (
    'e2444444-4444-4444-8444-000000000001',
    'e2333333-3333-4333-8333-333333333333',
    'Old archived class', 'A1', false,
    'e2111111-1111-4111-8111-111111111111', now() - interval '3 minutes'
  ),
  (
    'e2444444-4444-4444-8444-000000000002',
    'e2333333-3333-4333-8333-333333333333',
    'Middle active class', 'A2', true,
    'e2111111-1111-4111-8111-111111111111', now() - interval '2 minutes'
  ),
  (
    'e2444444-4444-4444-8444-000000000003',
    'e2333333-3333-4333-8333-333333333333',
    'Newest active class', 'B1', true,
    'e2111111-1111-4111-8111-111111111111', now() - interval '1 minute'
  );

create temporary table phase_13r_result (
  singleton boolean primary key default true check (singleton),
  first_page jsonb,
  second_page jsonb,
  search_page jsonb
) on commit drop;
insert into phase_13r_result default values;
grant select, update on table phase_13r_result to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'e2111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

update pg_temp.phase_13r_result
set first_page = api.list_workspace_batch_options(
  'e2333333-3333-4333-8333-333333333333', 2, null, null, ''
);

update pg_temp.phase_13r_result result
set second_page = api.list_workspace_batch_options(
  'e2333333-3333-4333-8333-333333333333',
  2,
  (result.first_page -> 'next_cursor' ->> 'created_at')::timestamptz,
  (result.first_page -> 'next_cursor' ->> 'id')::uuid,
  ''
);

update pg_temp.phase_13r_result
set search_page = api.list_workspace_batch_options(
  'e2333333-3333-4333-8333-333333333333', 2, null, null, 'ARCHIVED'
);

select is(
  (first_page ->> 'schema_version')::integer,
  1,
  'the compact response is explicitly versioned'
)
from pg_temp.phase_13r_result;

select ok(
  (first_page ->> 'unfiltered_total_count')::integer = 3
    and (first_page ->> 'total_count')::integer = 3
    and (first_page ->> 'returned_count')::integer = 2
    and (first_page ->> 'page_size')::integer = 2
    and (first_page ->> 'has_more')::boolean
    and first_page -> 'next_cursor' is not null,
  'the first compact page is bounded and reports the exact inventory'
)
from pg_temp.phase_13r_result;

select ok(
  (search_page ->> 'unfiltered_total_count')::integer = 3
    and (search_page ->> 'total_count')::integer = 1
    and (search_page ->> 'returned_count')::integer = 1
    and search_page -> 'items' -> 0 ->> 'name' = 'Old archived class',
  'server search is case-insensitive without changing the exact workspace total'
)
from pg_temp.phase_13r_result;

select ok(
  not exists (
    select 1
    from jsonb_array_elements(first_page -> 'items') item,
    lateral jsonb_object_keys(item) key
    where key not in ('id', 'name', 'level', 'is_active')
  )
    and not exists (
      select 1
      from jsonb_array_elements(first_page -> 'items') item
      where (
        select count(*)
        from jsonb_object_keys(item)
      ) <> 4
    ),
  'options expose only id, name, level, and active status'
)
from pg_temp.phase_13r_result;

select is(
  first_page -> 'items' -> 0 ->> 'name',
  'Newest active class',
  'options keep deterministic newest-first ordering'
)
from pg_temp.phase_13r_result;

select ok(
  (second_page ->> 'total_count')::integer = 3
    and (second_page ->> 'returned_count')::integer = 1
    and not (second_page ->> 'has_more')::boolean
    and second_page -> 'items' -> 0 ->> 'name' = 'Old archived class'
    and not (second_page -> 'items' -> 0 ->> 'is_active')::boolean
    and not exists (
      select first_item ->> 'id'
      from jsonb_array_elements(first_page -> 'items') first_item
      intersect
      select second_item ->> 'id'
      from jsonb_array_elements(second_page -> 'items') second_item
    ),
  'the next page exposes archived options without duplicate keys'
)
from pg_temp.phase_13r_result;

select throws_ok(
  $$select api.list_workspace_batch_options(
    'e2333333-3333-4333-8333-333333333333', 101, null, null, ''
  )$$,
  '22023',
  'invalid_page_size',
  'oversized compact pages fail with a stable code'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  'e2222222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select throws_ok(
  $$select api.list_workspace_batch_options(
    'e2333333-3333-4333-8333-333333333333', 100, null, null, ''
  )$$,
  '42501',
  'permission_denied',
  'a student member cannot enumerate teacher class options'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  'e2555555-5555-4555-8555-555555555555',
  true
);
set local role authenticated;

select throws_ok(
  $$select api.list_workspace_batch_options(
    'e2333333-3333-4333-8333-333333333333', 100, null, null, ''
  )$$,
  '42501',
  'permission_denied',
  'an unrelated outsider cannot enumerate teacher class options'
);

select * from finish(true);
rollback;
