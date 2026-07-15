begin;

select plan(17);

select ok(
  to_regprocedure(
    'api.list_student_grammar_stats_page(uuid,uuid,integer,boolean,integer,integer,uuid)'
  ) is not null
    and to_regprocedure(
      'api.list_workspace_grammar_stats_keyset_page(uuid,integer,boolean,integer,integer,uuid)'
    ) is not null,
  'student and workspace grammar statistics expose stable keyset signatures'
);

select ok(
  not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.list_student_grammar_stats_page(uuid,uuid,integer,boolean,integer,integer,uuid)'::regprocedure
  )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'api.list_workspace_grammar_stats_keyset_page(uuid,integer,boolean,integer,integer,uuid)'::regprocedure
    ),
  'both exposed grammar-stat pages execute with caller privileges'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.list_student_grammar_stats_page(uuid,uuid,integer,boolean,integer,integer,uuid)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'api.list_workspace_grammar_stats_keyset_page(uuid,integer,boolean,integer,integer,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.list_workspace_grammar_stats_keyset_page(uuid,integer,boolean,integer,integer,uuid)',
      'EXECUTE'
    ),
  'authenticated callers alone can enter the paginated grammar-stat APIs'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'api.list_student_grammar_stats(uuid,uuid,integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'api.list_workspace_grammar_stats_page(uuid,integer,integer)',
      'EXECUTE'
    ),
  'legacy limit-only and OFFSET grammar-stat contracts are retired'
);

select ok(
  to_regclass('public.student_grammar_stats_student_priority_page_idx') is not null
    and to_regclass('public.student_grammar_stats_workspace_priority_page_idx') is not null,
  'keyset order has matching student and workspace indexes'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'fb111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11m-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11M Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fb333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase11m-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11M Outsider"}'::jsonb, now(), now()
  );

create temporary table phase_11m_students (
  ordinal integer primary key,
  id uuid not null unique,
  email text not null unique
) on commit drop;
grant select on table phase_11m_students to authenticated;

insert into phase_11m_students (ordinal, id, email)
select
  ordinal,
  (
    'fb000000-0000-4000-8000-' || lpad(ordinal::text, 12, '0')
  )::uuid,
  format('phase11m-student-%s@example.test', ordinal)
from generate_series(1, 6) ordinal;

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
  jsonb_build_object('full_name', format('Phase 11M Student %s', student.ordinal)),
  now(),
  now()
from phase_11m_students student;

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'fb111111-1111-4111-8111-111111111111',
    'Phase 11M Teacher', 'phase11m-teacher@example.test', 'student'
  ),
  (
    'fb333333-3333-4333-8333-333333333333',
    'Phase 11M Outsider', 'phase11m-outsider@example.test', 'student'
  )
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into public.profiles (id, full_name, email, global_role)
select
  student.id,
  format('Phase 11M Student %s', student.ordinal),
  student.email,
  'student'
from phase_11m_students student
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'fb222222-2222-4222-8222-222222222222',
  'Phase 11M Workspace',
  'phase-11m-workspace',
  'fb111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'fb111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'fb222222-2222-4222-8222-222222222222',
  'fb111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
select
  'fb222222-2222-4222-8222-222222222222',
  student.id,
  'student'
from phase_11m_students student;

insert into public.student_grammar_stats (
  workspace_id,
  student_id,
  grammar_topic_id,
  total_minor_issues,
  total_major_issues,
  total_correct_after_practice,
  weakness_level,
  practice_unlocked,
  last_seen_at,
  resolution_cycle_number,
  resolved_through_sequence,
  mastery_pass_count,
  state_reason
)
select
  'fb222222-2222-4222-8222-222222222222',
  student.id,
  topic.id,
  (student.ordinal + row_number() over (partition by student.id order by topic.slug))::integer % 7,
  (student.ordinal + row_number() over (partition by student.id order by topic.slug))::integer % 5,
  0,
  case
    when (student.ordinal + row_number() over (partition by student.id order by topic.slug))::integer % 2 = 0
      then 'unlocked'
    else 'locked'
  end,
  (student.ordinal + row_number() over (partition by student.id order by topic.slug))::integer % 2 = 0,
  now(),
  0,
  0,
  0,
  'phase_11m_fixture'
from phase_11m_students student
cross join (
  select topic.id, topic.slug
  from public.grammar_topics topic
  join app_private.grammar_topic_contracts contract on contract.slug = topic.slug
  where topic.level = 'A1_A2'
  order by topic.slug
  limit 36
) topic;

select is(
  (
    select count(*)::integer
    from public.student_grammar_stats stat
    where stat.workspace_id = 'fb222222-2222-4222-8222-222222222222'
  ),
  216,
  'the runtime fixture exceeds the former 80 and 200 row workspace caps'
);

create temporary table phase_11m_pages (
  singleton boolean primary key default true check (singleton),
  workspace_first jsonb,
  workspace_second jsonb,
  student_first jsonb,
  student_second jsonb
) on commit drop;
insert into phase_11m_pages default values;
grant select, update on table phase_11m_pages to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fb111111-1111-4111-8111-111111111111', true);
set local role authenticated;

update pg_temp.phase_11m_pages
set workspace_first = api.list_workspace_grammar_stats_keyset_page(
  'fb222222-2222-4222-8222-222222222222',
  200,
  null,
  null,
  null,
  null
);

update pg_temp.phase_11m_pages pages
set workspace_second = api.list_workspace_grammar_stats_keyset_page(
  'fb222222-2222-4222-8222-222222222222',
  200,
  (pages.workspace_first #>> '{next_cursor,practice_unlocked}')::boolean,
  (pages.workspace_first #>> '{next_cursor,total_major_issues}')::integer,
  (pages.workspace_first #>> '{next_cursor,total_minor_issues}')::integer,
  (pages.workspace_first #>> '{next_cursor,id}')::uuid
);

reset role;

select ok(
  (
    select
      (workspace_first ->> 'total_count')::integer = 216
      and (workspace_first ->> 'returned_count')::integer = 200
      and (workspace_first ->> 'has_more')::boolean
      and workspace_first -> 'next_cursor' is not null
    from phase_11m_pages
  ),
  'the first teacher page returns an exact total, full page, and keyset cursor'
);

select ok(
  (
    select
      (workspace_second ->> 'total_count')::integer = 216
      and (workspace_second ->> 'returned_count')::integer = 16
      and not (workspace_second ->> 'has_more')::boolean
      and workspace_second -> 'next_cursor' = 'null'::jsonb
    from phase_11m_pages
  ),
  'the second teacher page reaches every remaining focus area and terminates'
);

select is(
  (
    select count(distinct item ->> 'id')::integer
    from phase_11m_pages pages
    cross join lateral jsonb_array_elements(
      (pages.workspace_first -> 'items') || (pages.workspace_second -> 'items')
    ) item
  ),
  216,
  'workspace keyset traversal has no omissions or duplicate statistics'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  (select student.id::text from pg_temp.phase_11m_students student where student.ordinal = 1),
  true
);
set local role authenticated;

update pg_temp.phase_11m_pages
set student_first = api.list_student_grammar_stats_page(
  'fb222222-2222-4222-8222-222222222222',
  (select student.id from pg_temp.phase_11m_students student where student.ordinal = 1),
  20,
  null,
  null,
  null,
  null
);

update pg_temp.phase_11m_pages pages
set student_second = api.list_student_grammar_stats_page(
  'fb222222-2222-4222-8222-222222222222',
  (select student.id from pg_temp.phase_11m_students student where student.ordinal = 1),
  20,
  (pages.student_first #>> '{next_cursor,practice_unlocked}')::boolean,
  (pages.student_first #>> '{next_cursor,total_major_issues}')::integer,
  (pages.student_first #>> '{next_cursor,total_minor_issues}')::integer,
  (pages.student_first #>> '{next_cursor,id}')::uuid
);

select throws_ok(
  $$select api.list_student_grammar_stats_page(
    'fb222222-2222-4222-8222-222222222222',
    (select student.id from pg_temp.phase_11m_students student where student.ordinal = 2),
    20,
    null,
    null,
    null,
    null
  )$$,
  '42501',
  'permission_denied',
  'a student cannot enumerate another student focus profile'
);

select throws_ok(
  $$select api.list_student_grammar_stats_page(
    'fb222222-2222-4222-8222-222222222222',
    (select student.id from pg_temp.phase_11m_students student where student.ordinal = 1),
    20,
    true,
    null,
    null,
    null
  )$$,
  '22023',
  'invalid_grammar_stats_page_request',
  'partial student cursors fail closed'
);

reset role;

select ok(
  (
    select
      (student_first ->> 'total_count')::integer = 36
      and (student_first ->> 'returned_count')::integer = 20
      and (student_first ->> 'has_more')::boolean
    from phase_11m_pages
  ),
  'a student receives the exact first page of their own complete focus profile'
);

select ok(
  (
    select
      (student_second ->> 'returned_count')::integer = 16
      and not (student_second ->> 'has_more')::boolean
    from phase_11m_pages
  ),
  'student keyset traversal reaches the remaining closed-topic profile'
);

select is(
  (
    select count(distinct item ->> 'id')::integer
    from phase_11m_pages pages
    cross join lateral jsonb_array_elements(
      (pages.student_first -> 'items') || (pages.student_second -> 'items')
    ) item
  ),
  36,
  'student traversal returns every canonical topic once'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fb333333-3333-4333-8333-333333333333', true);
set local role authenticated;

select throws_ok(
  $$select api.list_workspace_grammar_stats_keyset_page(
    'fb222222-2222-4222-8222-222222222222',
    200,
    null,
    null,
    null,
    null
  )$$,
  '42501',
  'permission_denied',
  'an unrelated authenticated user cannot list a workspace focus profile'
);

reset role;

delete from public.workspace_members membership
using phase_11m_students student
where student.ordinal = 1
  and membership.workspace_id = 'fb222222-2222-4222-8222-222222222222'
  and membership.user_id = student.id;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  (select student.id::text from pg_temp.phase_11m_students student where student.ordinal = 1),
  true
);
set local role authenticated;

select throws_ok(
  $$select api.list_student_grammar_stats_page(
    'fb222222-2222-4222-8222-222222222222',
    (select student.id from pg_temp.phase_11m_students student where student.ordinal = 1),
    20,
    null,
    null,
    null,
    null
  )$$,
  '42501',
  'active_membership_required',
  'a stale student session cannot read focus areas after offboarding'
);

reset role;

select ok(
  (
    select (workspace_first #>> '{items,0,practice_unlocked}')::boolean
    from phase_11m_pages
  )
    and not (
      select (workspace_second #>> '{items,15,practice_unlocked}')::boolean
      from phase_11m_pages
    ),
  'the complete traversal preserves unlocked-first educational priority order'
);

select * from finish();
rollback;
