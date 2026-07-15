begin;

select plan(15);

select ok(
  to_regprocedure(
    'api.list_workspace_students_filtered_page(uuid,text,uuid,text,integer,timestamptz,uuid)'
  ) is not null
    and to_regprocedure(
      'api.get_teacher_dashboard_summary(uuid,uuid,integer)'
    ) is not null
    and to_regprocedure(
      'api.list_teacher_question_bank_page(uuid,text,text,text,text,text,text,integer,integer,timestamptz,uuid)'
    ) is not null,
  'bounded teacher read models expose stable API signatures'
);

select ok(
  not (select prosecdef from pg_proc where oid =
    'api.list_workspace_students_filtered_page(uuid,text,uuid,text,integer,timestamptz,uuid)'::regprocedure)
    and not (select prosecdef from pg_proc where oid =
      'api.get_teacher_dashboard_summary(uuid,uuid,integer)'::regprocedure)
    and not (select prosecdef from pg_proc where oid =
      'api.list_teacher_question_bank_page(uuid,text,text,text,text,text,text,integer,integer,timestamptz,uuid)'::regprocedure),
  'all teacher read models execute with caller privileges'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.get_teacher_dashboard_summary(uuid,uuid,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'api.list_teacher_question_bank_page(uuid,text,text,text,text,text,text,integer,integer,timestamptz,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_teacher_dashboard_summary(uuid,uuid,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.list_teacher_question_bank_page(uuid,text,text,text,text,text,text,integer,integer,timestamptz,uuid)',
      'EXECUTE'
    ),
  'only authenticated application callers can enter the new teacher APIs'
);

select ok(
  to_regclass('public.questions_workspace_bank_page_idx') is not null
    and to_regclass('public.global_questions_active_sort_page_idx') is not null,
  'question-bank ordering has matching source-specific indexes'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'fc111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11t-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11T Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fc222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase11t-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11T Student"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fc333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase11t-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11T Outsider"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fc444444-4444-4444-8444-444444444444',
    'authenticated', 'authenticated', 'phase11t-pending@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11T Pending"}'::jsonb, now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'fc111111-1111-4111-8111-111111111111',
    'Phase 11T Teacher', 'phase11t-teacher@example.test', 'student'
  ),
  (
    'fc222222-2222-4222-8222-222222222222',
    'Phase 11T Student', 'phase11t-student@example.test', 'student'
  ),
  (
    'fc333333-3333-4333-8333-333333333333',
    'Phase 11T Outsider', 'phase11t-outsider@example.test', 'student'
  ),
  (
    'fc444444-4444-4444-8444-444444444444',
    'Phase 11T Pending', 'phase11t-pending@example.test', 'student'
  )
on conflict (id) do update
set full_name = excluded.full_name,
    email = excluded.email,
    global_role = excluded.global_role;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'fc555555-5555-4555-8555-555555555555',
  'Phase 11T Workspace',
  'phase-11t-workspace',
  'fc111111-1111-4111-8111-111111111111'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'fc111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'fc111111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role, created_at)
values (
  'fc555555-5555-4555-8555-555555555555',
  'fc111111-1111-4111-8111-111111111111',
  'owner', now()
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role, created_at)
values (
  'fc555555-5555-4555-8555-555555555555',
  'fc222222-2222-4222-8222-222222222222',
  'student', now() - interval '1 minute'
);

select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (id, workspace_id, name, level, is_active, created_by)
values (
  'fc666666-6666-4666-8666-666666666666',
  'fc555555-5555-4555-8555-555555555555',
  'Phase 11T A2', 'A2', true,
  'fc111111-1111-4111-8111-111111111111'
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  'fc555555-5555-4555-8555-555555555555',
  'fc666666-6666-4666-8666-666666666666',
  'fc222222-2222-4222-8222-222222222222'
);

insert into public.batch_join_requests (
  workspace_id, batch_id, student_id, status, requested_at,
  student_email, student_name
)
values (
  'fc555555-5555-4555-8555-555555555555',
  'fc666666-6666-4666-8666-666666666666',
  'fc444444-4444-4444-8444-444444444444',
  'pending', now(), 'phase11t-pending@example.test', 'Phase 11T Pending'
);

insert into public.grammar_topics (id, slug, name, level, description)
values
  ('fc700000-0000-4000-8000-000000000001', 'phase11t-topic-1', 'Topic One', 'A2', 'One'),
  ('fc700000-0000-4000-8000-000000000002', 'phase11t-topic-2', 'Topic Two', 'A2', 'Two'),
  ('fc700000-0000-4000-8000-000000000003', 'phase11t-topic-3', 'Topic Three', 'A2', 'Three'),
  ('fc700000-0000-4000-8000-000000000004', 'phase11t-topic-4', 'Topic Four', 'A2', 'Four'),
  ('fc700000-0000-4000-8000-000000000005', 'phase11t-topic-5', 'Topic Mastered', 'A2', 'Five');

insert into public.student_grammar_stats (
  workspace_id, student_id, grammar_topic_id,
  total_minor_issues, total_major_issues, total_correct_after_practice,
  weakness_level, practice_unlocked, last_seen_at
)
values
  (
    'fc555555-5555-4555-8555-555555555555',
    'fc222222-2222-4222-8222-222222222222',
    'fc700000-0000-4000-8000-000000000001',
    2, 8, 0, 'unlocked', true, now()
  ),
  (
    'fc555555-5555-4555-8555-555555555555',
    'fc222222-2222-4222-8222-222222222222',
    'fc700000-0000-4000-8000-000000000002',
    3, 7, 0, 'in_progress', false, now()
  ),
  (
    'fc555555-5555-4555-8555-555555555555',
    'fc222222-2222-4222-8222-222222222222',
    'fc700000-0000-4000-8000-000000000003',
    4, 6, 0, 'locked', false, now()
  ),
  (
    'fc555555-5555-4555-8555-555555555555',
    'fc222222-2222-4222-8222-222222222222',
    'fc700000-0000-4000-8000-000000000004',
    5, 5, 1, 'improving', false, now()
  ),
  (
    'fc555555-5555-4555-8555-555555555555',
    'fc222222-2222-4222-8222-222222222222',
    'fc700000-0000-4000-8000-000000000005',
    9, 9, 3, 'mastered', false, now()
  );

insert into public.student_practice_assignments (
  id, workspace_id, student_id, grammar_topic_id, source, status, assigned_by
)
values (
  'fc800000-0000-4000-8000-000000000001',
  'fc555555-5555-4555-8555-555555555555',
  'fc222222-2222-4222-8222-222222222222',
  'fc700000-0000-4000-8000-000000000001',
  'teacher_assigned', 'in_progress',
  'fc111111-1111-4111-8111-111111111111'
);

insert into public.questions (
  id, workspace_id, title, prompt, level, topic, task_type,
  is_active, created_by, created_at
)
values
  (
    'fc900000-0000-4000-8000-000000000001',
    'fc555555-5555-4555-8555-555555555555',
    'Target newest', 'Target prompt one', 'A2', 'Alltag', 'email', true,
    'fc111111-1111-4111-8111-111111111111', now()
  ),
  (
    'fc900000-0000-4000-8000-000000000002',
    'fc555555-5555-4555-8555-555555555555',
    'Target older', 'Target prompt two', 'A2', 'Alltag', 'email', true,
    'fc111111-1111-4111-8111-111111111111', now() - interval '1 minute'
  ),
  (
    'fc900000-0000-4000-8000-000000000003',
    'fc555555-5555-4555-8555-555555555555',
    'Inactive opinion', 'Another prompt', 'B1', 'Meinung', 'opinion', false,
    'fc111111-1111-4111-8111-111111111111', now() - interval '2 minutes'
  );

insert into public.global_questions (
  id, source_key, sort_order, title, prompt, level, topic, task_type, is_active
)
values (
  'fca00000-0000-4000-8000-000000000001',
  'phase11t-global-1', 1, 'Global target', 'Global prompt',
  'A2', 'Global Topic', 'email', true
);

create temporary table phase_11t_results (
  singleton boolean primary key default true check (singleton),
  roster jsonb,
  dashboard jsonb,
  question_first jsonb,
  question_second jsonb,
  global_page jsonb
) on commit drop;
insert into phase_11t_results default values;
grant select, update on table phase_11t_results to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fc111111-1111-4111-8111-111111111111', true);
set local role authenticated;

update pg_temp.phase_11t_results
set roster = api.list_workspace_students_filtered_page(
  'fc555555-5555-4555-8555-555555555555', '', null, null, 25, null, null
),
dashboard = api.get_teacher_dashboard_summary(
  'fc555555-5555-4555-8555-555555555555',
  'fc666666-6666-4666-8666-666666666666',
  6
),
question_first = api.list_teacher_question_bank_page(
  'fc555555-5555-4555-8555-555555555555',
  'workspace', 'target', 'A2', 'Alltag', 'email', 'active', 1,
  null, null, null
),
global_page = api.list_teacher_question_bank_page(
  'fc555555-5555-4555-8555-555555555555',
  'global', 'global', 'A2', null, 'email', 'active', 12,
  null, null, null
);

update pg_temp.phase_11t_results
set question_second = api.list_teacher_question_bank_page(
  'fc555555-5555-4555-8555-555555555555',
  'workspace', 'target', 'A2', 'Alltag', 'email', 'active', 1,
  (question_first #>> '{next_cursor,sort_rank}')::integer,
  (question_first #>> '{next_cursor,created_at}')::timestamptz,
  (question_first #>> '{next_cursor,id}')::uuid
);

select throws_ok(
  $$select api.list_teacher_question_bank_page(
    'fc555555-5555-4555-8555-555555555555',
    'workspace', '', null, null, null, 'unknown', 12,
    null, null, null
  )$$,
  '22023',
  'invalid_teacher_question_page',
  'unsupported Content filters fail closed'
);

reset role;

select is(
  (
    select jsonb_array_length(roster #> '{items,0,weak_topics}')
    from phase_11t_results
  ),
  3,
  'the roster returns at most three confirmed focus areas for a visible student'
);

select ok(
  (
    select not exists (
      select 1
      from jsonb_array_elements(roster #> '{items,0,weak_topics}') topic
      where topic ->> 'weakness_level' = 'mastered'
    )
    from phase_11t_results
  ),
  'mastered topics are not presented as current weak areas'
);

select is(
  (
    select roster #>> '{items,0,weak_topics,0,active_practice,id}'
    from phase_11t_results
  ),
  'fc800000-0000-4000-8000-000000000001',
  'the enriched roster embeds only the active practice state for the focus topic'
);

select ok(
  (
    select
      (dashboard ->> 'student_count')::integer = 1
      and (dashboard ->> 'question_count')::integer = 3
      and (dashboard ->> 'pending_join_request_count')::integer = 1
    from phase_11t_results
  ),
  'the dashboard summary returns narrow class-aware counts without list scans'
);

select ok(
  (
    select
      jsonb_array_length(dashboard -> 'attention_items') <= 6
      and dashboard #>> '{attention_items,0,student_name}' = 'Phase 11T Student'
      and dashboard #>> '{attention_items,0,active_practice,id}' =
        'fc800000-0000-4000-8000-000000000001'
    from phase_11t_results
  ),
  'the dashboard attention projection is bounded and includes actionable practice state'
);

select ok(
  (
    select
      (question_first ->> 'total_count')::integer = 2
      and (question_first ->> 'returned_count')::integer = 1
      and (question_first ->> 'has_more')::boolean
      and question_first #>> '{next_cursor,sort_rank}' = '0'
      and question_first #>> '{next_cursor,id}' =
        question_first #>> '{items,0,id}'
    from phase_11t_results
  ),
  'Content filters are applied before the bounded first page'
);

select isnt(
  (select question_first #>> '{items,0,id}' from phase_11t_results),
  (select question_second #>> '{items,0,id}' from phase_11t_results),
  'successive Content pages do not repeat a writing task'
);

select ok(
  (
    select available.topic = 'Alltag'
    from phase_11t_results result
    cross join lateral jsonb_array_elements_text(
      result.question_first -> 'available_topics'
    ) available(topic)
    where available.topic = 'Alltag'
  ),
  'the page includes a bounded topic facet without returning the complete bank'
);

select is(
  (select global_page #>> '{items,0,source}' from phase_11t_results),
  'global',
  'the same filtered page contract serves the read-only global bank'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'fc333333-3333-4333-8333-333333333333', true);
set local role authenticated;

select throws_ok(
  $$select api.get_teacher_dashboard_summary(
    'fc555555-5555-4555-8555-555555555555', null, 6
  )$$,
  '42501',
  'permission_denied',
  'an unrelated authenticated user cannot read teacher dashboard data'
);

reset role;

select * from finish();
rollback;
