begin;

select plan(14);

select ok(
  to_regprocedure(
    'api.list_workspace_students_filtered_page(uuid,text,uuid,text,integer,timestamptz,uuid)'
  ) is not null
    and to_regprocedure(
      'api.list_workspace_join_requests_filtered_page(uuid,text,text,uuid,integer,timestamptz,uuid)'
    ) is not null,
  'filtered roster and join-request pages have stable API signatures'
);

select ok(
  not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.list_workspace_students_filtered_page(uuid,text,uuid,text,integer,timestamptz,uuid)'::regprocedure
  )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'api.list_workspace_join_requests_filtered_page(uuid,text,text,uuid,integer,timestamptz,uuid)'::regprocedure
    ),
  'teacher list pages use caller privileges'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.list_workspace_students_filtered_page(uuid,text,uuid,text,integer,timestamptz,uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'api.list_workspace_students_filtered_page(uuid,text,uuid,text,integer,timestamptz,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.list_workspace_students_filtered_page(uuid,text,uuid,text,integer,timestamptz,uuid)',
      'EXECUTE'
    ),
  'only authenticated application callers can enter the filtered roster API'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'fa111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11n-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11N Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fa222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase11n-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11N Outsider"}'::jsonb, now(), now()
  );

create temporary table phase_11n_students (
  ordinal integer primary key,
  id uuid not null unique,
  email text not null unique,
  full_name text not null
) on commit drop;

insert into phase_11n_students (ordinal, id, email, full_name)
select
  ordinal,
  ('fa000000-0000-4000-8000-' || lpad(ordinal::text, 12, '0'))::uuid,
  format('phase11n-student-%s@example.test', ordinal),
  case when ordinal <= 15
    then format('Alpha Student %s', ordinal)
    else format('Beta Student %s', ordinal)
  end
from generate_series(1, 30) ordinal;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000',
  student.id,
  'authenticated',
  'authenticated',
  student.email,
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', student.full_name),
  now() - make_interval(secs => student.ordinal),
  now() - make_interval(secs => student.ordinal)
from phase_11n_students student;

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'fa111111-1111-4111-8111-111111111111',
    'Phase 11N Teacher', 'phase11n-teacher@example.test', 'student'
  ),
  (
    'fa222222-2222-4222-8222-222222222222',
    'Phase 11N Outsider', 'phase11n-outsider@example.test', 'student'
  )
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into public.profiles (id, full_name, email, global_role)
select student.id, student.full_name, student.email, 'student'
from phase_11n_students student
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'fa333333-3333-4333-8333-333333333333',
  'Phase 11N Workspace',
  'phase-11n-workspace',
  'fa111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'fa111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role, created_at)
values (
  'fa333333-3333-4333-8333-333333333333',
  'fa111111-1111-4111-8111-111111111111',
  'owner',
  now()
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role, created_at)
select
  'fa333333-3333-4333-8333-333333333333',
  student.id,
  'student',
  now() - make_interval(secs => student.ordinal)
from phase_11n_students student;

insert into public.batches (id, workspace_id, name, level, is_active, created_by)
values
  (
    'fa444444-4444-4444-8444-444444444444',
    'fa333333-3333-4333-8333-333333333333',
    'Alpha A1 Class', 'A1', true,
    'fa111111-1111-4111-8111-111111111111'
  ),
  (
    'fa555555-5555-4555-8555-555555555555',
    'fa333333-3333-4333-8333-333333333333',
    'Beta B1 Class', 'B1', true,
    'fa111111-1111-4111-8111-111111111111'
  );

insert into public.batch_students (workspace_id, student_id, batch_id)
select
  'fa333333-3333-4333-8333-333333333333',
  student.id,
  case when student.ordinal <= 15
    then 'fa444444-4444-4444-8444-444444444444'::uuid
    else 'fa555555-5555-4555-8555-555555555555'::uuid
  end
from phase_11n_students student;

insert into public.batch_join_requests (
  workspace_id,
  batch_id,
  student_id,
  status,
  requested_at,
  student_email,
  student_name
)
select
  'fa333333-3333-4333-8333-333333333333',
  case when student.ordinal <= 15
    then 'fa444444-4444-4444-8444-444444444444'::uuid
    else 'fa555555-5555-4555-8555-555555555555'::uuid
  end,
  student.id,
  'pending',
  now() - make_interval(secs => student.ordinal),
  student.email,
  case when student.ordinal <= 12
    then format('Request Alpha %s', student.ordinal)
    else format('Request Beta %s', student.ordinal)
  end
from phase_11n_students student;

create temporary table phase_11n_pages (
  singleton boolean primary key default true check (singleton),
  roster_first jsonb,
  roster_second jsonb,
  request_first jsonb,
  request_second jsonb
) on commit drop;
insert into phase_11n_pages default values;
grant select, update on table phase_11n_pages to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fa111111-1111-4111-8111-111111111111', true);
set local role authenticated;

update pg_temp.phase_11n_pages
set roster_first = api.list_workspace_students_filtered_page(
  'fa333333-3333-4333-8333-333333333333',
  'alpha',
  'fa444444-4444-4444-8444-444444444444',
  'A1',
  10,
  null,
  null
);

update pg_temp.phase_11n_pages pages
set roster_second = api.list_workspace_students_filtered_page(
  'fa333333-3333-4333-8333-333333333333',
  'alpha',
  'fa444444-4444-4444-8444-444444444444',
  'A1',
  10,
  (pages.roster_first #>> '{next_cursor,created_at}')::timestamptz,
  (pages.roster_first #>> '{next_cursor,id}')::uuid
);

update pg_temp.phase_11n_pages
set request_first = api.list_workspace_join_requests_filtered_page(
  'fa333333-3333-4333-8333-333333333333',
  'pending',
  'request alpha',
  null,
  10,
  null,
  null
);

update pg_temp.phase_11n_pages pages
set request_second = api.list_workspace_join_requests_filtered_page(
  'fa333333-3333-4333-8333-333333333333',
  'pending',
  'request alpha',
  null,
  10,
  (pages.request_first #>> '{next_cursor,requested_at}')::timestamptz,
  (pages.request_first #>> '{next_cursor,id}')::uuid
);

select throws_ok(
  $$select api.list_workspace_students_filtered_page(
    'fa333333-3333-4333-8333-333333333333',
    '',
    'fa222222-2222-4222-8222-222222222222',
    null,
    25,
    null,
    null
  )$$,
  '22023',
  'invalid_student_roster_filter',
  'a foreign or nonexistent class filter fails closed'
);

select throws_ok(
  $$select api.list_workspace_join_requests_filtered_page(
    'fa333333-3333-4333-8333-333333333333',
    'unknown',
    '',
    null,
    25,
    null,
    null
  )$$,
  '22023',
  'invalid_join_request_page',
  'an unsupported request status fails closed'
);

reset role;

select ok(
  (
    select
      (roster_first ->> 'total_count')::integer = 15
      and (roster_first ->> 'returned_count')::integer = 10
      and (roster_first ->> 'has_more')::boolean
    from phase_11n_pages
  ),
  'student name, class, and level filters run before the first page limit'
);

select ok(
  (
    select
      (roster_second ->> 'returned_count')::integer = 5
      and not (roster_second ->> 'has_more')::boolean
    from phase_11n_pages
  ),
  'the second filtered roster page reaches every remaining match'
);

select is(
  (
    select count(distinct item ->> 'id')::integer
    from phase_11n_pages pages
    cross join lateral jsonb_array_elements(
      (pages.roster_first -> 'items') || (pages.roster_second -> 'items')
    ) item
  ),
  15,
  'filtered roster traversal contains no duplicates or omissions'
);

select ok(
  (
    select bool_and(
      item ->> 'name' like 'Alpha Student %'
      and item #>> '{batches,0,batch_id}' = 'fa444444-4444-4444-8444-444444444444'
    )
    from phase_11n_pages pages
    cross join lateral jsonb_array_elements(
      (pages.roster_first -> 'items') || (pages.roster_second -> 'items')
    ) item
  ),
  'every returned roster row satisfies the authorized server filters'
);

select ok(
  (
    select
      (request_first ->> 'total_count')::integer = 12
      and (request_first ->> 'returned_count')::integer = 10
      and (request_first ->> 'has_more')::boolean
    from phase_11n_pages
  ),
  'pending request search runs before the first page limit'
);

select ok(
  (
    select
      (request_second ->> 'returned_count')::integer = 2
      and not (request_second ->> 'has_more')::boolean
    from phase_11n_pages
  ),
  'the request keyset reaches the final matches and terminates'
);

select is(
  (
    select count(distinct item ->> 'id')::integer
    from phase_11n_pages pages
    cross join lateral jsonb_array_elements(
      (pages.request_first -> 'items') || (pages.request_second -> 'items')
    ) item
  ),
  12,
  'filtered request traversal contains no duplicates or omissions'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fa222222-2222-4222-8222-222222222222', true);
set local role authenticated;

select throws_ok(
  $$select api.list_workspace_students_filtered_page(
    'fa333333-3333-4333-8333-333333333333',
    '', null, null, 25, null, null
  )$$,
  '42501',
  'permission_denied',
  'an unrelated authenticated user cannot search another workspace roster'
);

select throws_ok(
  $$select api.list_workspace_join_requests_filtered_page(
    'fa333333-3333-4333-8333-333333333333',
    'pending', '', null, 25, null, null
  )$$,
  '42501',
  'permission_denied',
  'an unrelated authenticated user cannot enumerate join requests'
);

reset role;

select * from finish();
rollback;
