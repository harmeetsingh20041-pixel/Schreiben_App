begin;

select plan(13);

-- SEC-011: prove the active teacher roster and join-request read models can
-- traverse beyond the hosted Data API's 1,000-row default without client-side
-- filtering. The ten newest rows are deliberate filter decoys: applying LIMIT
-- before the search/class/status predicates would make the first page fail.
select ok(
  to_regprocedure(
    'api.list_workspace_students_filtered_page(uuid,text,uuid,text,integer,timestamptz,uuid)'
  ) is not null
    and to_regprocedure(
      'api.list_workspace_join_requests_filtered_page(uuid,text,text,uuid,integer,timestamptz,uuid)'
    ) is not null
    and not (
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
  'the current filtered teacher pages exist and retain caller-privilege execution'
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
values (
  '00000000-0000-0000-0000-000000000000',
  'ec111111-1111-4111-8111-111111111111',
  'authenticated',
  'authenticated',
  'sec011-teacher@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"SEC-011 Teacher"}'::jsonb,
  now(),
  now()
);

create temporary table sec_011_students (
  ordinal integer primary key,
  student_id uuid not null unique,
  membership_id uuid not null unique,
  batch_assignment_id uuid not null unique,
  request_id uuid not null unique,
  email text not null unique,
  full_name text not null,
  request_name text not null,
  is_target boolean not null
) on commit drop;

insert into sec_011_students (
  ordinal,
  student_id,
  membership_id,
  batch_assignment_id,
  request_id,
  email,
  full_name,
  request_name,
  is_target
)
select
  ordinal,
  md5('sec-011-student-' || ordinal)::uuid,
  md5('sec-011-membership-' || ordinal)::uuid,
  md5('sec-011-batch-assignment-' || ordinal)::uuid,
  md5('sec-011-join-request-' || ordinal)::uuid,
  case
    when ordinal <= 1005 then
      format('sec011-target-%s@example.test', lpad(ordinal::text, 4, '0'))
    else
      format('sec011-decoy-%s@example.test', lpad(ordinal::text, 4, '0'))
  end,
  case
    when ordinal <= 1005 then
      format('SEC011 Target Student %s', lpad(ordinal::text, 4, '0'))
    else
      format('SEC011 Decoy Student %s', lpad(ordinal::text, 4, '0'))
  end,
  case
    when ordinal <= 1005 then
      format('SEC011 Target Request %s', lpad(ordinal::text, 4, '0'))
    else
      format('SEC011 Decoy Request %s', lpad(ordinal::text, 4, '0'))
  end,
  ordinal <= 1005
from generate_series(1, 1015) ordinal;

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
select
  '00000000-0000-0000-0000-000000000000',
  student.student_id,
  'authenticated',
  'authenticated',
  student.email,
  '',
  timestamptz '2026-07-01 00:00:00+00',
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', student.full_name),
  timestamptz '2026-07-01 00:00:00+00'
    + make_interval(secs => student.ordinal),
  timestamptz '2026-07-01 00:00:00+00'
    + make_interval(secs => student.ordinal)
from sec_011_students student;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'ec113333-3333-4333-8333-333333333333',
  'SEC-011 Large Pagination Workspace',
  'sec-011-large-pagination-workspace',
  'ec111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'ec111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (
  id,
  workspace_id,
  user_id,
  role,
  created_at
)
values (
  'ec116666-6666-4666-8666-666666666666',
  'ec113333-3333-4333-8333-333333333333',
  'ec111111-1111-4111-8111-111111111111',
  'owner',
  timestamptz '2026-07-01 00:00:00+00'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (
  id,
  workspace_id,
  user_id,
  role,
  created_at
)
select
  student.membership_id,
  'ec113333-3333-4333-8333-333333333333',
  student.student_id,
  'student',
  timestamptz '2026-07-01 00:00:00+00'
    + make_interval(secs => student.ordinal)
from sec_011_students student;

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  is_active,
  created_by
)
values
  (
    'ec114444-4444-4444-8444-444444444444',
    'ec113333-3333-4333-8333-333333333333',
    'SEC-011 Target A2 Class',
    'A2',
    true,
    'ec111111-1111-4111-8111-111111111111'
  ),
  (
    'ec115555-5555-4555-8555-555555555555',
    'ec113333-3333-4333-8333-333333333333',
    'SEC-011 Decoy B1 Class',
    'B1',
    true,
    'ec111111-1111-4111-8111-111111111111'
  );

insert into public.batch_students (
  id,
  workspace_id,
  batch_id,
  student_id,
  created_at
)
select
  student.batch_assignment_id,
  'ec113333-3333-4333-8333-333333333333',
  case
    when student.is_target then 'ec114444-4444-4444-8444-444444444444'::uuid
    else 'ec115555-5555-4555-8555-555555555555'::uuid
  end,
  student.student_id,
  timestamptz '2026-07-01 00:00:00+00'
    + make_interval(secs => student.ordinal)
from sec_011_students student;

insert into public.batch_join_requests (
  id,
  workspace_id,
  batch_id,
  student_id,
  status,
  requested_at,
  decided_by,
  decided_at,
  student_email,
  student_name
)
select
  student.request_id,
  'ec113333-3333-4333-8333-333333333333',
  case
    when student.is_target then 'ec114444-4444-4444-8444-444444444444'::uuid
    else 'ec115555-5555-4555-8555-555555555555'::uuid
  end,
  student.student_id,
  case when student.is_target then 'pending' else 'rejected' end,
  timestamptz '2026-07-01 00:00:00+00'
    + make_interval(secs => student.ordinal),
  case
    when student.is_target then null
    else 'ec111111-1111-4111-8111-111111111111'::uuid
  end,
  case
    when student.is_target then null
    else timestamptz '2026-07-02 00:00:00+00'
  end,
  student.email,
  student.request_name
from sec_011_students student;

select ok(
  (select count(*) from sec_011_students) = 1015
    and (select count(*) from sec_011_students where is_target) = 1005
    and (select count(*) from sec_011_students where not is_target) = 10
    and (
      select count(*)
      from public.workspace_members membership
      where membership.workspace_id = 'ec113333-3333-4333-8333-333333333333'
        and membership.role = 'student'
    ) = 1015
    and (
      select count(*)
      from public.batch_join_requests request
      where request.workspace_id = 'ec113333-3333-4333-8333-333333333333'
    ) = 1015,
  'the isolated fixture has 1,005 target rows plus ten newer filter decoys'
);

create temporary table sec_011_roster_pages (
  page_number integer primary key,
  payload jsonb not null
) on commit drop;

create temporary table sec_011_request_pages (
  page_number integer primary key,
  payload jsonb not null
) on commit drop;

grant select, insert on table sec_011_roster_pages to authenticated;
grant select, insert on table sec_011_request_pages to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'ec111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'ec111111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with recursive pages(page_number, payload) as (
  select
    1,
    api.list_workspace_students_filtered_page(
      'ec113333-3333-4333-8333-333333333333',
      'sec011 target student',
      'ec114444-4444-4444-8444-444444444444',
      'A2',
      100,
      null,
      null
    )
  union all
  select
    prior.page_number + 1,
    api.list_workspace_students_filtered_page(
      'ec113333-3333-4333-8333-333333333333',
      'sec011 target student',
      'ec114444-4444-4444-8444-444444444444',
      'A2',
      100,
      (prior.payload #>> '{next_cursor,created_at}')::timestamptz,
      (prior.payload #>> '{next_cursor,id}')::uuid
    )
  from pages prior
  where (prior.payload ->> 'has_more')::boolean
    and prior.page_number < 20
)
insert into pg_temp.sec_011_roster_pages (page_number, payload)
select page_number, payload
from pages;

with recursive pages(page_number, payload) as (
  select
    1,
    api.list_workspace_join_requests_filtered_page(
      'ec113333-3333-4333-8333-333333333333',
      'pending',
      'sec011 target request',
      'ec114444-4444-4444-8444-444444444444',
      100,
      null,
      null
    )
  union all
  select
    prior.page_number + 1,
    api.list_workspace_join_requests_filtered_page(
      'ec113333-3333-4333-8333-333333333333',
      'pending',
      'sec011 target request',
      'ec114444-4444-4444-8444-444444444444',
      100,
      (prior.payload #>> '{next_cursor,requested_at}')::timestamptz,
      (prior.payload #>> '{next_cursor,id}')::uuid
    )
  from pages prior
  where (prior.payload ->> 'has_more')::boolean
    and prior.page_number < 20
)
insert into pg_temp.sec_011_request_pages (page_number, payload)
select page_number, payload
from pages;

reset role;

select ok(
  (select count(*) from sec_011_roster_pages) = 11
    and (
      select bool_and((page.payload ->> 'schema_version')::integer = 1)
      from sec_011_roster_pages page
    )
    and (
      select bool_and((page.payload ->> 'total_count')::integer = 1005)
      from sec_011_roster_pages page
    )
    and (
      select sum((page.payload ->> 'returned_count')::integer)
      from sec_011_roster_pages page
    ) = 1005
    and (
      select bool_and(
        (page.payload ->> 'returned_count')::integer = 100
        and (page.payload ->> 'has_more')::boolean
        and page.payload -> 'next_cursor' <> 'null'::jsonb
      )
      from sec_011_roster_pages page
      where page.page_number <= 10
    )
    and (
      select
        (page.payload ->> 'returned_count')::integer = 5
        and not (page.payload ->> 'has_more')::boolean
        and page.payload -> 'next_cursor' = 'null'::jsonb
      from sec_011_roster_pages page
      where page.page_number = 11
    ),
  'the roster traverses all 1,005 matches across eleven truthful keyset pages'
);

select ok(
  (
    select count(*)
    from sec_011_roster_pages page
    cross join lateral jsonb_array_elements(page.payload -> 'items') item
  ) = 1005
    and (
      select count(distinct (item ->> 'id')::uuid)
      from sec_011_roster_pages page
      cross join lateral jsonb_array_elements(page.payload -> 'items') item
    ) = 1005
    and (
      select count(distinct item ->> 'membership_id')
      from sec_011_roster_pages page
      cross join lateral jsonb_array_elements(page.payload -> 'items') item
    ) = 1005,
  'the complete roster traversal has no duplicate student or membership IDs'
);

select results_eq(
  $$
    select (item ->> 'id')::uuid
    from sec_011_roster_pages page
    cross join lateral jsonb_array_elements(page.payload -> 'items') item
    order by 1
  $$,
  $$
    select student.student_id
    from sec_011_students student
    where student.is_target
    order by student.student_id
  $$,
  'the roster traversal contains every exact target student and no decoy'
);

select ok(
  (
    select bool_and(
      item ->> 'name' like 'SEC011 Target Student %'
      and item ->> 'email' like 'sec011-target-%@example.test'
      and jsonb_array_length(item -> 'batches') = 1
      and item #>> '{batches,0,batch_id}' =
        'ec114444-4444-4444-8444-444444444444'
      and item #>> '{batches,0,level}' = 'A2'
    )
    from sec_011_roster_pages page
    cross join lateral jsonb_array_elements(page.payload -> 'items') item
  )
    and (
      select count(*)
      from (
        select membership.id
        from public.workspace_members membership
        join public.profiles profile on profile.id = membership.user_id
        where membership.workspace_id = 'ec113333-3333-4333-8333-333333333333'
          and membership.role = 'student'
        order by membership.created_at desc, membership.id desc
        limit 10
      ) newest_unfiltered
      join public.workspace_members membership
        on membership.id = newest_unfiltered.id
      join public.profiles profile on profile.id = membership.user_id
      where profile.full_name like 'SEC011 Decoy Student %'
    ) = 10,
  'roster search, class, and level predicates execute before the page limit'
);

select ok(
  not exists (
    select 1
    from sec_011_roster_pages page
    where page.page_number <= 10
      and (
        page.payload #>> '{next_cursor,id}' is distinct from
          page.payload #>> array[
            'items',
            ((page.payload ->> 'returned_count')::integer - 1)::text,
            'membership_id'
          ]
        or (page.payload #>> '{next_cursor,created_at}')::timestamptz
          is distinct from (
            select membership.created_at
            from public.workspace_members membership
            where membership.id =
              (page.payload #>> '{next_cursor,id}')::uuid
          )
      )
  ),
  'every nonterminal roster cursor names the exact last row of its page'
);

select ok(
  (select count(*) from sec_011_request_pages) = 11
    and (
      select bool_and((page.payload ->> 'schema_version')::integer = 1)
      from sec_011_request_pages page
    )
    and (
      select bool_and((page.payload ->> 'total_count')::integer = 1005)
      from sec_011_request_pages page
    )
    and (
      select sum((page.payload ->> 'returned_count')::integer)
      from sec_011_request_pages page
    ) = 1005
    and (
      select bool_and(
        (page.payload ->> 'returned_count')::integer = 100
        and (page.payload ->> 'has_more')::boolean
        and page.payload -> 'next_cursor' <> 'null'::jsonb
      )
      from sec_011_request_pages page
      where page.page_number <= 10
    )
    and (
      select
        (page.payload ->> 'returned_count')::integer = 5
        and not (page.payload ->> 'has_more')::boolean
        and page.payload -> 'next_cursor' = 'null'::jsonb
      from sec_011_request_pages page
      where page.page_number = 11
    ),
  'join requests traverse all 1,005 matches across eleven truthful keyset pages'
);

select ok(
  (
    select count(*)
    from sec_011_request_pages page
    cross join lateral jsonb_array_elements(page.payload -> 'items') item
  ) = 1005
    and (
      select count(distinct (item ->> 'id')::uuid)
      from sec_011_request_pages page
      cross join lateral jsonb_array_elements(page.payload -> 'items') item
    ) = 1005,
  'the complete join-request traversal has no duplicate request IDs'
);

select results_eq(
  $$
    select (item ->> 'id')::uuid
    from sec_011_request_pages page
    cross join lateral jsonb_array_elements(page.payload -> 'items') item
    order by 1
  $$,
  $$
    select student.request_id
    from sec_011_students student
    where student.is_target
    order by student.request_id
  $$,
  'the request traversal contains every exact pending target and no decoy'
);

select ok(
  (
    select bool_and(
      item ->> 'status' = 'pending'
      and item ->> 'student_name' like 'SEC011 Target Request %'
      and item ->> 'student_email' like 'sec011-target-%@example.test'
      and item ->> 'batch_id' = 'ec114444-4444-4444-8444-444444444444'
      and item ->> 'batch_level' = 'A2'
    )
    from sec_011_request_pages page
    cross join lateral jsonb_array_elements(page.payload -> 'items') item
  )
    and (
      select count(*)
      from (
        select request.id
        from public.batch_join_requests request
        where request.workspace_id = 'ec113333-3333-4333-8333-333333333333'
        order by request.requested_at desc, request.id desc
        limit 10
      ) newest_unfiltered
      join public.batch_join_requests request on request.id = newest_unfiltered.id
      where request.status = 'rejected'
        and request.student_name like 'SEC011 Decoy Request %'
    ) = 10,
  'request status, search, and class predicates execute before the page limit'
);

select ok(
  not exists (
    select 1
    from sec_011_request_pages page
    where page.page_number <= 10
      and (
        page.payload #>> '{next_cursor,id}' is distinct from
          page.payload #>> array[
            'items',
            ((page.payload ->> 'returned_count')::integer - 1)::text,
            'id'
          ]
        or (page.payload #>> '{next_cursor,requested_at}')::timestamptz
          is distinct from (
            page.payload #>> array[
              'items',
              ((page.payload ->> 'returned_count')::integer - 1)::text,
              'requested_at'
            ]
          )::timestamptz
      )
  ),
  'every nonterminal request cursor names the exact last row of its page'
);

select ok(
  not exists (
    select 1
    from sec_011_roster_pages current_page
    join sec_011_roster_pages next_page
      on next_page.page_number = current_page.page_number + 1
    where (
      next_page.payload #>> '{items,0,membership_id}'
    ) = (
      current_page.payload #>> array[
        'items',
        ((current_page.payload ->> 'returned_count')::integer - 1)::text,
        'membership_id'
      ]
    )
  )
    and not exists (
      select 1
      from sec_011_request_pages current_page
      join sec_011_request_pages next_page
        on next_page.page_number = current_page.page_number + 1
      where next_page.payload #>> '{items,0,id}' =
        current_page.payload #>> array[
          'items',
          ((current_page.payload ->> 'returned_count')::integer - 1)::text,
          'id'
        ]
    ),
  'exclusive keyset cursors never repeat a page boundary row'
);

select * from finish();
rollback;
