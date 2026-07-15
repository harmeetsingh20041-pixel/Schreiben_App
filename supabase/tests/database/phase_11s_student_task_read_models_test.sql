begin;

select plan(19);

select ok(
  to_regprocedure(
    'api.list_student_assigned_questions_page(uuid,uuid,text,text,integer,timestamptz,text,uuid)'
  ) is not null
    and to_regprocedure(
      'api.get_student_released_feedback_summary(uuid,uuid,uuid)'
    ) is not null,
  'student task paging and released-feedback summary have stable API signatures'
);

select ok(
  not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'api.list_student_assigned_questions_page(uuid,uuid,text,text,integer,timestamptz,text,uuid)'::regprocedure
  )
    and not (
      select routine.prosecdef
      from pg_proc routine
      where routine.oid =
        'api.get_student_released_feedback_summary(uuid,uuid,uuid)'::regprocedure
    ),
  'both student read models execute with caller privileges'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.list_student_assigned_questions_page(uuid,uuid,text,text,integer,timestamptz,text,uuid)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'api.get_student_released_feedback_summary(uuid,uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.list_student_assigned_questions_page(uuid,uuid,text,text,integer,timestamptz,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'api.get_student_released_feedback_summary(uuid,uuid,uuid)',
      'EXECUTE'
    ),
  'only authenticated application callers can enter the new student read models'
);

select ok(
  to_regclass('public.questions_active_batch_level_page_idx') is not null
    and to_regclass('public.global_questions_active_level_page_idx') is not null
    and to_regclass('public.submissions_latest_workspace_task_idx') is not null
    and to_regclass('public.submissions_latest_global_task_idx') is not null
    and to_regclass('public.submissions_student_released_latest_idx') is not null,
  'task paging, exact latest-state lookup, and released-summary order are indexed'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'f9111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase11s-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11S Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'f9222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase11s-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11S Student"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'f9333333-3333-4333-8333-333333333333',
    'authenticated', 'authenticated', 'phase11s-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11S Outsider"}'::jsonb, now(), now()
  );

insert into public.profiles (id, full_name, email, global_role)
values
  (
    'f9111111-1111-4111-8111-111111111111',
    'Phase 11S Teacher', 'phase11s-teacher@example.test', 'student'
  ),
  (
    'f9222222-2222-4222-8222-222222222222',
    'Phase 11S Student', 'phase11s-student@example.test', 'student'
  ),
  (
    'f9333333-3333-4333-8333-333333333333',
    'Phase 11S Outsider', 'phase11s-outsider@example.test', 'student'
  )
on conflict (id) do update
set full_name = excluded.full_name, email = excluded.email;

insert into public.workspaces (id, name, slug, owner_id)
values (
  'f9444444-4444-4444-8444-444444444444',
  'Phase 11S Workspace',
  'phase-11s-workspace',
  'f9111111-1111-4111-8111-111111111111'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'f9111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'f9444444-4444-4444-8444-444444444444',
    'f9111111-1111-4111-8111-111111111111',
    'owner'
  );

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'f9444444-4444-4444-8444-444444444444',
    'f9222222-2222-4222-8222-222222222222',
    'student'
  );

insert into public.batches (id, workspace_id, name, level, is_active, created_by)
values
  (
    'f9555555-5555-4555-8555-555555555555',
    'f9444444-4444-4444-8444-444444444444',
    'Phase 11S A2 Main', 'A2', true,
    'f9111111-1111-4111-8111-111111111111'
  ),
  (
    'f9666666-6666-4666-8666-666666666666',
    'f9444444-4444-4444-8444-444444444444',
    'Phase 11S A2 Other', 'A2', true,
    'f9111111-1111-4111-8111-111111111111'
  );

insert into public.batch_students (workspace_id, student_id, batch_id)
values
  (
    'f9444444-4444-4444-8444-444444444444',
    'f9222222-2222-4222-8222-222222222222',
    'f9555555-5555-4555-8555-555555555555'
  ),
  (
    'f9444444-4444-4444-8444-444444444444',
    'f9222222-2222-4222-8222-222222222222',
    'f9666666-6666-4666-8666-666666666666'
  );

insert into public.questions (
  id, workspace_id, title, prompt, level, topic, task_type,
  expected_word_min, expected_word_max, estimated_minutes,
  is_active, created_by, created_at, updated_at
)
select
  ('f9000000-0000-4000-8001-' || lpad(ordinal::text, 12, '0'))::uuid,
  'f9444444-4444-4444-8444-444444444444',
  format('Phase11S Page Workspace %s', ordinal),
  format('Write synthetic task %s.', ordinal),
  'A2',
  format('Phase11S Page Topic %s', ordinal),
  'writing', 40, 90, 15, true,
  'f9111111-1111-4111-8111-111111111111',
  timestamptz '2026-07-10 12:00:00+00' - make_interval(secs => ordinal),
  timestamptz '2026-07-10 12:00:00+00' - make_interval(secs => ordinal)
from generate_series(1, 8) ordinal;

insert into public.global_questions (
  id, title, prompt, level, topic, task_type,
  expected_word_min, expected_word_max, estimated_minutes,
  is_active, created_by, created_at, updated_at
)
select
  ('f9000000-0000-4000-8002-' || lpad(ordinal::text, 12, '0'))::uuid,
  format('Phase11S Page Global %s', ordinal),
  format('Write global synthetic task %s.', ordinal),
  'A2',
  format('Phase11S Page Global Topic %s', ordinal),
  'writing', 40, 90, 15, true,
  'f9111111-1111-4111-8111-111111111111',
  timestamptz '2026-07-10 12:00:00+00' - make_interval(secs => ordinal + 8),
  timestamptz '2026-07-10 12:00:00+00' - make_interval(secs => ordinal + 8)
from generate_series(1, 4) ordinal;

-- Make the compatibility result exceed its hard ceiling independently of the
-- focused 12-row keyset fixture.
insert into public.questions (
  id, workspace_id, title, prompt, level, topic, task_type,
  is_active, created_by, created_at, updated_at
)
select
  ('f9000000-0000-4000-8003-' || lpad(ordinal::text, 12, '0'))::uuid,
  'f9444444-4444-4444-8444-444444444444',
  format('Phase11S Legacy %s', ordinal),
  'Compatibility-only synthetic task.',
  'A2', 'Phase11S Legacy', 'writing', true,
  'f9111111-1111-4111-8111-111111111111',
  timestamptz '2026-07-09 12:00:00+00' - make_interval(secs => ordinal),
  timestamptz '2026-07-09 12:00:00+00' - make_interval(secs => ordinal)
from generate_series(1, 105) ordinal;

insert into public.submissions (
  id, workspace_id, student_id, batch_id, question_id, global_question_id,
  question_source, mode, original_text, status, evaluation_status,
  release_status, feedback_mode, created_at, updated_at
)
values
  (
    'f9777777-0001-4777-8777-777777777777',
    'f9444444-4444-4444-8444-444444444444',
    'f9222222-2222-4222-8222-222222222222',
    'f9555555-5555-4555-8555-555555555555',
    'f9000000-0000-4000-8001-000000000001', null,
    'workspace_question', 'predefined_question', 'Older released synthetic writing.',
    'checked', 'ready', 'released', 'immediate',
    '2026-07-10 13:00:00+00', '2026-07-10 13:00:00+00'
  ),
  (
    'f9777777-0002-4777-8777-777777777777',
    'f9444444-4444-4444-8444-444444444444',
    'f9222222-2222-4222-8222-222222222222',
    'f9555555-5555-4555-8555-555555555555',
    'f9000000-0000-4000-8001-000000000001', null,
    'workspace_question', 'predefined_question', 'Newest failed synthetic writing.',
    'failed', 'failed', 'held', 'immediate',
    '2026-07-10 13:05:00+00', '2026-07-10 13:05:00+00'
  ),
  (
    'f9777777-0003-4777-8777-777777777777',
    'f9444444-4444-4444-8444-444444444444',
    'f9222222-2222-4222-8222-222222222222',
    'f9555555-5555-4555-8555-555555555555',
    'f9000000-0000-4000-8001-000000000002', null,
    'workspace_question', 'predefined_question', 'Teacher-held synthetic writing.',
    'checked', 'ready', 'held', 'teacher_review_only',
    '2026-07-10 13:06:00+00', '2026-07-10 13:06:00+00'
  ),
  (
    'f9777777-0004-4777-8777-777777777777',
    'f9444444-4444-4444-8444-444444444444',
    'f9222222-2222-4222-8222-222222222222',
    'f9555555-5555-4555-8555-555555555555',
    null, 'f9000000-0000-4000-8002-000000000001',
    'global_question', 'predefined_question', 'Released global synthetic writing.',
    'checked', 'ready', 'released', 'immediate',
    '2026-07-10 13:07:00+00', '2026-07-10 13:07:00+00'
  ),
  (
    'f9777777-0005-4777-8777-777777777777',
    'f9444444-4444-4444-8444-444444444444',
    'f9222222-2222-4222-8222-222222222222',
    'f9666666-6666-4666-8666-666666666666',
    'f9000000-0000-4000-8001-000000000001', null,
    'workspace_question', 'predefined_question', 'Other-class released writing.',
    'checked', 'ready', 'released', 'immediate',
    '2026-07-10 13:10:00+00', '2026-07-10 13:10:00+00'
  );

create temporary table phase_11s_pages (
  singleton boolean primary key default true check (singleton),
  first_page jsonb,
  second_page jsonb,
  third_page jsonb,
  legacy_items jsonb,
  released_summary jsonb
) on commit drop;
insert into phase_11s_pages default values;
grant select, update on table phase_11s_pages to authenticated;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'f9222222-2222-4222-8222-222222222222', true);
set local role authenticated;

update pg_temp.phase_11s_pages
set first_page = api.list_student_assigned_questions_page(
  'f9222222-2222-4222-8222-222222222222',
  'f9555555-5555-4555-8555-555555555555',
  'phase11s page', 'A2', 5, null, null, null
);

update pg_temp.phase_11s_pages pages
set second_page = api.list_student_assigned_questions_page(
  'f9222222-2222-4222-8222-222222222222',
  'f9555555-5555-4555-8555-555555555555',
  'phase11s page', 'A2', 5,
  (pages.first_page #>> '{next_cursor,created_at}')::timestamptz,
  pages.first_page #>> '{next_cursor,source}',
  (pages.first_page #>> '{next_cursor,id}')::uuid
);

update pg_temp.phase_11s_pages pages
set third_page = api.list_student_assigned_questions_page(
  'f9222222-2222-4222-8222-222222222222',
  'f9555555-5555-4555-8555-555555555555',
  'phase11s page', 'A2', 5,
  (pages.second_page #>> '{next_cursor,created_at}')::timestamptz,
  pages.second_page #>> '{next_cursor,source}',
  (pages.second_page #>> '{next_cursor,id}')::uuid
);

update pg_temp.phase_11s_pages
set legacy_items = api.list_student_assigned_questions(
  'f9222222-2222-4222-8222-222222222222'
);

update pg_temp.phase_11s_pages
set released_summary = api.get_student_released_feedback_summary(
  'f9444444-4444-4444-8444-444444444444',
  'f9222222-2222-4222-8222-222222222222',
  'f9555555-5555-4555-8555-555555555555'
);

select throws_ok(
  $$select api.list_student_assigned_questions_page(
    'f9222222-2222-4222-8222-222222222222',
    'f9555555-5555-4555-8555-555555555555',
    '', null, 5, now(), null, null
  )$$,
  '22023',
  'invalid_assigned_question_page',
  'an incomplete composite cursor fails closed'
);

select throws_ok(
  $$select api.list_student_assigned_questions_page(
    'f9222222-2222-4222-8222-222222222222',
    'f9999999-9999-4999-8999-999999999999',
    '', null, 5, null, null, null
  )$$,
  '42501',
  'permission_denied',
  'a student cannot select an unassigned class context'
);

reset role;

select ok(
  (
    select
      (first_page ->> 'total_count')::integer = 12
      and (first_page ->> 'returned_count')::integer = 5
      and (first_page ->> 'has_more')::boolean
      and first_page #>> '{next_cursor,source}' in ('workspace', 'global')
    from phase_11s_pages
  ),
  'search and level filters run before the first keyset page limit'
);

select ok(
  (
    select
      (second_page ->> 'total_count')::integer = 12
      and (second_page ->> 'returned_count')::integer = 5
      and (second_page ->> 'has_more')::boolean
    from phase_11s_pages
  ),
  'the second page continues with the complete three-part cursor'
);

select ok(
  (
    select
      (third_page ->> 'returned_count')::integer = 2
      and not (third_page ->> 'has_more')::boolean
      and third_page -> 'next_cursor' = 'null'::jsonb
    from phase_11s_pages
  ),
  'the final task page returns the remainder and terminates'
);

select is(
  (
    select count(distinct item ->> 'id')::integer
    from phase_11s_pages pages
    cross join lateral jsonb_array_elements(
      (pages.first_page -> 'items')
      || (pages.second_page -> 'items')
      || (pages.third_page -> 'items')
    ) item
  ),
  12,
  'keyset traversal returns every filtered task once'
);

select ok(
  (
    select bool_and(
      (item ->> 'batch_id')::uuid = 'f9555555-5555-4555-8555-555555555555'
      and item ->> 'workspace_id' = 'f9444444-4444-4444-8444-444444444444'
      and item ->> 'source' in ('workspace', 'global')
    )
    from phase_11s_pages pages
    cross join lateral jsonb_array_elements(
      (pages.first_page -> 'items')
      || (pages.second_page -> 'items')
      || (pages.third_page -> 'items')
    ) item
  ),
  'every task row carries the exact authorized class and workspace context'
);

select is(
  (
    select item ->> 'task_state'
    from phase_11s_pages pages
    cross join lateral jsonb_array_elements(
      (pages.first_page -> 'items')
      || (pages.second_page -> 'items')
      || (pages.third_page -> 'items')
    ) item
    where item ->> 'id' = 'f9000000-0000-4000-8001-000000000001'
      and item ->> 'source' = 'workspace'
  ),
  'failed',
  'the newest exact-class attempt wins even when it failed and another class is newer'
);

select is(
  (
    select item ->> 'task_state'
    from phase_11s_pages pages
    cross join lateral jsonb_array_elements(
      (pages.first_page -> 'items')
      || (pages.second_page -> 'items')
      || (pages.third_page -> 'items')
    ) item
    where item ->> 'id' = 'f9000000-0000-4000-8001-000000000002'
      and item ->> 'source' = 'workspace'
  ),
  'feedback_held',
  'teacher-held feedback remains visible on its assigned task'
);

select ok(
  (
    select
      item ->> 'task_state' = 'feedback_released'
      and item ->> 'latest_submission_id' = 'f9777777-0004-4777-8777-777777777777'
    from phase_11s_pages pages
    cross join lateral jsonb_array_elements(
      (pages.first_page -> 'items')
      || (pages.second_page -> 'items')
      || (pages.third_page -> 'items')
    ) item
    where item ->> 'id' = 'f9000000-0000-4000-8002-000000000001'
      and item ->> 'source' = 'global'
  ),
  'global task state uses the exact global-question submission key'
);

select is(
  (
    select item ->> 'task_state'
    from phase_11s_pages pages
    cross join lateral jsonb_array_elements(
      (pages.first_page -> 'items')
      || (pages.second_page -> 'items')
      || (pages.third_page -> 'items')
    ) item
    where item ->> 'id' = 'f9000000-0000-4000-8001-000000000003'
      and item ->> 'source' = 'workspace'
  ),
  'not_started',
  'a task without an exact submission remains available to start'
);

select is(
  (select jsonb_array_length(legacy_items) from phase_11s_pages),
  100,
  'the deprecated all-class compatibility array is hard capped at 100 rows'
);

select ok(
  (
    select
      (released_summary ->> 'released_count')::integer = 2
      and released_summary #>> '{latest_submission,id}' =
        'f9777777-0004-4777-8777-777777777777'
    from phase_11s_pages
  ),
  'released-feedback summary filters in SQL and returns only the latest released link'
);

select ok(
  (
    select
      (
        select count(*)
        from jsonb_object_keys(released_summary -> 'latest_submission')
      ) = 3
      and not (released_summary -> 'latest_submission' ? 'original_text')
      and not (released_summary -> 'latest_submission' ? 'feedback')
    from phase_11s_pages
  ),
  'dashboard summary exposes no writing or feedback content'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'f9333333-3333-4333-8333-333333333333', true);
set local role authenticated;

select throws_ok(
  $$select api.get_student_released_feedback_summary(
    'f9444444-4444-4444-8444-444444444444',
    'f9222222-2222-4222-8222-222222222222',
    'f9555555-5555-4555-8555-555555555555'
  )$$,
  '42501',
  'permission_denied',
  'an unrelated authenticated user cannot read another student summary'
);

reset role;

select * from finish();
rollback;
