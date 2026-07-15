begin;

select plan(14);

select ok(
  to_regprocedure(
    'api.list_workspace_batches_page(uuid,integer,timestamptz,uuid)'
  ) is not null
    and to_regprocedure(
      'api.list_workspace_batches_page(uuid,integer,timestamptz,uuid,text,text)'
    ) is not null,
  'the filtered batch page is backward compatible with the original signature'
);

select ok(
  not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.list_workspace_batches_page(uuid,integer,timestamptz,uuid,text,text)'::regprocedure
  )
    and exists (
      select 1
      from pg_proc routine,
      lateral unnest(coalesce(routine.proconfig, array[]::text[])) setting
      where routine.oid =
        'api.list_workspace_batches_page(uuid,integer,timestamptz,uuid,text,text)'::regprocedure
        and setting ~ '^search_path=(""|)$'
    ),
  'the filtered page uses caller privileges and an empty search path'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.list_workspace_batches_page(uuid,integer,timestamptz,uuid,text,text)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'api.list_workspace_batches_page(uuid,integer,timestamptz,uuid,text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.list_workspace_batches_page(uuid,integer,timestamptz,uuid,text,text)',
      'EXECUTE'
    ),
  'only authenticated application callers can use the filtered batch page'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'e1111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase13q-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13Q Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'e1222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase13q-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 13Q Outsider"}'::jsonb, now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'e1111111-1111-4111-8111-111111111111',
    'Phase 13Q Teacher', 'phase13q-teacher@example.test', 'teacher'
  ),
  (
    'e1222222-2222-4222-8222-222222222222',
    'Phase 13Q Outsider', 'phase13q-outsider@example.test', 'student'
  )
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'e1333333-3333-4333-8333-333333333333',
  'Phase 13Q Workspace',
  'phase-13q-workspace',
  'e1111111-1111-4111-8111-111111111111'
);

select set_config('app.allow_workspace_owner_insert', 'on', true);
insert into public.workspace_members (workspace_id, user_id, role)
values (
  'e1333333-3333-4333-8333-333333333333',
  'e1111111-1111-4111-8111-111111111111',
  'owner'
);
select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.batches (
  id, workspace_id, name, level, is_active, created_by, created_at
)
select
  ('e1444444-4444-4444-8444-' || lpad(ordinal::text, 12, '0'))::uuid,
  'e1333333-3333-4333-8333-333333333333'::uuid,
  format('Phase 13Q Class %s', ordinal),
  case when ordinal % 2 = 0 then 'A2' else 'A1' end,
  ordinal <= 13,
  'e1111111-1111-4111-8111-111111111111'::uuid,
  now() - make_interval(secs => ordinal)
from generate_series(1, 15) ordinal;

create temporary table phase_13q_pages (
  singleton boolean primary key default true check (singleton),
  first_page jsonb,
  second_page jsonb
) on commit drop;
insert into phase_13q_pages default values;
grant select, update on table phase_13q_pages to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'e1111111-1111-4111-8111-111111111111',
  true
);
set local role authenticated;

update pg_temp.phase_13q_pages
set first_page = api.list_workspace_batches_page(
  'e1333333-3333-4333-8333-333333333333', 12, null, null, 'active', null
);

update pg_temp.phase_13q_pages pages
set second_page = api.list_workspace_batches_page(
  'e1333333-3333-4333-8333-333333333333',
  12,
  (pages.first_page -> 'next_cursor' ->> 'created_at')::timestamptz,
  (pages.first_page -> 'next_cursor' ->> 'id')::uuid,
  'active',
  null
);

select ok(
  (first_page ->> 'total_count')::integer = 13
    and (first_page ->> 'unfiltered_total_count')::integer = 15,
  'status filtering happens before the exact total while inventory count remains explicit'
)
from pg_temp.phase_13q_pages;

select ok(
  (first_page ->> 'returned_count')::integer = 12
    and (first_page ->> 'has_more')::boolean
    and first_page -> 'next_cursor' is not null
    and not exists (
      select 1
      from jsonb_array_elements(first_page -> 'items') item
      where not (item ->> 'is_active')::boolean
    ),
  'the first page is bounded and contains only active classes'
)
from pg_temp.phase_13q_pages;

select ok(
  (second_page ->> 'total_count')::integer = 13
    and (second_page ->> 'returned_count')::integer = 1
    and not (second_page ->> 'has_more')::boolean,
  'the next cursor exposes the final active class without a hidden cap'
)
from pg_temp.phase_13q_pages;

select ok(
  not exists (
    select first_item ->> 'id'
    from jsonb_array_elements(first_page -> 'items') first_item
    intersect
    select second_item ->> 'id'
    from jsonb_array_elements(second_page -> 'items') second_item
  ),
  'keyset pages do not duplicate classes'
)
from pg_temp.phase_13q_pages;

select ok(
  (
    api.list_workspace_batches_page(
      'e1333333-3333-4333-8333-333333333333', 12, null, null, 'active', 'A2'
    ) ->> 'total_count'
  )::integer = 6
    and not exists (
      select 1
      from jsonb_array_elements(
        api.list_workspace_batches_page(
          'e1333333-3333-4333-8333-333333333333', 12, null, null, 'active', 'A2'
        ) -> 'items'
      ) item
      where item ->> 'level' <> 'A2'
    ),
  'CEFR filtering happens before counting and pagination'
);

select ok(
  (
    api.list_workspace_batches_page(
      'e1333333-3333-4333-8333-333333333333', 12, null, null, 'inactive', null
    ) ->> 'total_count'
  )::integer = 2
    and not exists (
      select 1
      from jsonb_array_elements(
        api.list_workspace_batches_page(
          'e1333333-3333-4333-8333-333333333333', 12, null, null, 'inactive', null
        ) -> 'items'
      ) item
      where (item ->> 'is_active')::boolean
    ),
  'archived filtering returns only archived classes and its exact count'
);

select is(
  (
    api.list_workspace_batches_page(
      'e1333333-3333-4333-8333-333333333333', 100, null, null, 'all', null
    ) ->> 'total_count'
  )::integer,
  15,
  'the explicit all filter preserves the complete inventory'
);

select is(
  (
    api.list_workspace_batches_page(
      'e1333333-3333-4333-8333-333333333333', 100, null, null
    ) ->> 'total_count'
  )::integer,
  15,
  'the original overload remains behaviorally compatible'
);

select throws_ok(
  $$select api.list_workspace_batches_page(
    'e1333333-3333-4333-8333-333333333333', 12, null, null, 'unknown', null
  )$$,
  '22023',
  'invalid_batch_status',
  'unknown status filters fail with a stable code'
);

select throws_ok(
  $$select api.list_workspace_batches_page(
    'e1333333-3333-4333-8333-333333333333', 12, null, null, 'active', 'C1'
  )$$,
  '22023',
  'invalid_batch_level',
  'unsupported CEFR filters fail with a stable code'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  'e1222222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select throws_ok(
  $$select api.list_workspace_batches_page(
    'e1333333-3333-4333-8333-333333333333', 12, null, null, 'active', null
  )$$,
  '42501',
  'permission_denied',
  'an outsider cannot enumerate filtered class pages'
);

select * from finish();
rollback;
