begin;

select plan(35);

select ok(
  to_regprocedure(
    'api.list_workspace_submissions_page(uuid,uuid,uuid,text,text,integer,timestamptz,uuid)'
  ) is not null
    and to_regprocedure(
      'api.list_student_submissions_page(uuid,uuid,uuid,text,text,integer,timestamptz,uuid)'
    ) is not null
    and to_regprocedure('api.get_submission_detail(uuid)') is not null,
  'all submission read-model routines have stable signatures'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    where routine.oid in (
      'api.list_workspace_submissions_page(uuid,uuid,uuid,text,text,integer,timestamptz,uuid)'::regprocedure,
      'api.list_student_submissions_page(uuid,uuid,uuid,text,text,integer,timestamptz,uuid)'::regprocedure,
      'api.get_submission_detail(uuid)'::regprocedure
    )
      and routine.prosecdef
  ),
  'submission read models remain security invoker'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    where routine.oid in (
      'api.list_workspace_submissions_page(uuid,uuid,uuid,text,text,integer,timestamptz,uuid)'::regprocedure,
      'api.list_student_submissions_page(uuid,uuid,uuid,text,text,integer,timestamptz,uuid)'::regprocedure,
      'api.get_submission_detail(uuid)'::regprocedure
    )
      and not exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
  ),
  'every submission read model pins an empty search path'
);

select ok(
  has_function_privilege(
    'authenticated',
    'api.list_workspace_submissions_page(uuid,uuid,uuid,text,text,integer,timestamptz,uuid)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'api.list_student_submissions_page(uuid,uuid,uuid,text,text,integer,timestamptz,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.get_submission_detail(uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.list_workspace_submissions_page(uuid,uuid,uuid,text,text,integer,timestamptz,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.list_student_submissions_page(uuid,uuid,uuid,text,text,integer,timestamptz,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'api.get_submission_detail(uuid)',
      'EXECUTE'
    ),
  'authenticated clients receive explicit execution while anonymous clients do not'
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
    'a0111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase10a-teacher-a@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 10A Teacher A"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a0222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase10a-student-a@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 10A Student A"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a0333333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'phase10a-student-b@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 10A Student B"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a0444444-4444-4444-8444-444444444444',
    'authenticated',
    'authenticated',
    'phase10a-teacher-b@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 10A Teacher B"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    'a1111111-1111-4111-8111-111111111111',
    'Phase 10A Workspace A',
    'phase-10a-workspace-a',
    'a0111111-1111-4111-8111-111111111111'
  ),
  (
    'a1222222-2222-4222-8222-222222222222',
    'Phase 10A Workspace B',
    'phase-10a-workspace-b',
    'a0444444-4444-4444-8444-444444444444'
  );

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'a0111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a1111111-1111-4111-8111-111111111111',
  'a0111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'a1111111-1111-4111-8111-111111111111',
    'a0222222-2222-4222-8222-222222222222',
    'student'
  ),
  (
    'a1111111-1111-4111-8111-111111111111',
    'a0333333-3333-4333-8333-333333333333',
    'student'
  );

select set_config(
  'request.jwt.claim.sub',
  'a0444444-4444-4444-8444-444444444444',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a1222222-2222-4222-8222-222222222222',
  'a0444444-4444-4444-8444-444444444444',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  is_active,
  join_code_enabled,
  join_requires_approval,
  feedback_mode,
  feedback_delay_min_minutes,
  feedback_delay_max_minutes
)
values
  (
    'a2111111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'Phase 10A Batch A1',
    'A1',
    'a0111111-1111-4111-8111-111111111111',
    true,
    true,
    true,
    'immediate',
    0,
    0
  ),
  (
    'a2222222-2222-4222-8222-222222222222',
    'a1111111-1111-4111-8111-111111111111',
    'Phase 10A Batch A2',
    'A2',
    'a0111111-1111-4111-8111-111111111111',
    true,
    true,
    true,
    'immediate',
    0,
    0
  ),
  (
    'a2333333-3333-4333-8333-333333333333',
    'a1222222-2222-4222-8222-222222222222',
    'Phase 10A Batch B',
    'B1',
    'a0444444-4444-4444-8444-444444444444',
    true,
    true,
    true,
    'immediate',
    0,
    0
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    'a1111111-1111-4111-8111-111111111111',
    'a2111111-1111-4111-8111-111111111111',
    'a0222222-2222-4222-8222-222222222222'
  ),
  (
    'a1111111-1111-4111-8111-111111111111',
    'a2222222-2222-4222-8222-222222222222',
    'a0222222-2222-4222-8222-222222222222'
  ),
  (
    'a1111111-1111-4111-8111-111111111111',
    'a2111111-1111-4111-8111-111111111111',
    'a0333333-3333-4333-8333-333333333333'
  );

insert into public.questions (
  id,
  workspace_id,
  title,
  prompt,
  level,
  topic,
  task_type,
  is_active,
  created_by
)
values (
  'a3111111-1111-4111-8111-111111111111',
  'a1111111-1111-4111-8111-111111111111',
  'Phase 10A Writing Task',
  'Write two sentences about learning German.',
  'A2',
  'Learning',
  'writing',
  true,
  'a0111111-1111-4111-8111-111111111111'
);

insert into public.grammar_topics (id, slug, name, level, description)
values (
  'a4111111-1111-4111-8111-111111111111',
  'phase-10a-word-order',
  'Phase 10A Word Order',
  'A2',
  'Fixture topic for submission read-model tests.'
);

insert into app_private.grammar_topic_aliases (alias_slug, canonical_slug)
values ('phase-10a-word-order', 'word-order')
on conflict (alias_slug) do update
set canonical_slug = excluded.canonical_slug;

insert into public.submissions (
  id,
  workspace_id,
  student_id,
  batch_id,
  question_id,
  question_source,
  mode,
  original_text,
  corrected_text,
  overall_summary,
  level_detected,
  status,
  feedback_mode,
  feedback_error,
  evaluation_status,
  release_status,
  checked_at,
  created_at,
  updated_at
)
values
  (
    'a5111111-1111-4111-8111-111111111111',
    'a1111111-1111-4111-8111-111111111111',
    'a0222222-2222-4222-8222-222222222222',
    'a2111111-1111-4111-8111-111111111111',
    null,
    'free_text',
    'free_text',
    'Ich lerne Deutsch.',
    'Ich lerne Deutsch.',
    'Released feedback summary.',
    'A2',
    'checked',
    'immediate',
    null,
    'ready',
    'released',
    '2026-01-06 10:01:00+00',
    '2026-01-06 10:00:00+00',
    '2026-01-06 10:01:00+00'
  ),
  (
    'a5222222-2222-4222-8222-222222222222',
    'a1111111-1111-4111-8111-111111111111',
    'a0222222-2222-4222-8222-222222222222',
    'a2111111-1111-4111-8111-111111111111',
    null,
    'free_text',
    'free_text',
    'Processing submission.',
    null,
    null,
    null,
    'checking',
    'immediate',
    null,
    'processing',
    'held',
    null,
    '2026-01-05 10:00:00+00',
    '2026-01-05 10:00:00+00'
  ),
  (
    'a5333333-3333-4333-8333-333333333333',
    'a1111111-1111-4111-8111-111111111111',
    'a0222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    null,
    'free_text',
    'free_text',
    'Released A2 batch submission.',
    'Released A2 batch submission.',
    'A2 feedback summary.',
    'A2',
    'checked',
    'immediate',
    null,
    'ready',
    'released',
    '2026-01-05 10:01:00+00',
    '2026-01-05 10:00:00+00',
    '2026-01-05 10:01:00+00'
  ),
  (
    'a5444444-4444-4444-8444-444444444444',
    'a1111111-1111-4111-8111-111111111111',
    'a0222222-2222-4222-8222-222222222222',
    'a2111111-1111-4111-8111-111111111111',
    null,
    'free_text',
    'free_text',
    'Held submission with private feedback.',
    null,
    null,
    null,
    'needs_review',
    'teacher_review_only',
    null,
    'needs_review',
    'held',
    null,
    '2026-01-04 10:00:00+00',
    '2026-01-04 10:00:00+00'
  ),
  (
    'a5555555-5555-4555-8555-555555555555',
    'a1111111-1111-4111-8111-111111111111',
    'a0222222-2222-4222-8222-222222222222',
    'a2111111-1111-4111-8111-111111111111',
    null,
    'free_text',
    'free_text',
    'Failed submission.',
    null,
    null,
    null,
    'failed',
    'immediate',
    'provider raw failure detail',
    'failed',
    'held',
    null,
    '2026-01-03 10:00:00+00',
    '2026-01-03 10:00:00+00'
  ),
  (
    'a5666666-6666-4666-8666-666666666666',
    'a1111111-1111-4111-8111-111111111111',
    'a0222222-2222-4222-8222-222222222222',
    'a2222222-2222-4222-8222-222222222222',
    'a3111111-1111-4111-8111-111111111111',
    'workspace_question',
    'predefined_question',
    'A response to the assigned task.',
    'A response to the assigned task.',
    'Task feedback summary.',
    'A2',
    'checked',
    'immediate',
    null,
    'ready',
    'released',
    '2026-01-02 10:01:00+00',
    '2026-01-02 10:00:00+00',
    '2026-01-02 10:01:00+00'
  ),
  (
    'a5777777-7777-4777-8777-777777777777',
    'a1111111-1111-4111-8111-111111111111',
    'a0333333-3333-4333-8333-333333333333',
    'a2111111-1111-4111-8111-111111111111',
    null,
    'free_text',
    'free_text',
    'Second student submission.',
    'Second student submission.',
    'Second student feedback.',
    'A1',
    'checked',
    'immediate',
    null,
    'ready',
    'released',
    '2026-01-01 10:01:00+00',
    '2026-01-01 10:00:00+00',
    '2026-01-01 10:01:00+00'
  ),
  (
    'a5888888-8888-4888-8888-888888888888',
    'a1222222-2222-4222-8222-222222222222',
    'a0444444-4444-4444-8444-444444444444',
    'a2333333-3333-4333-8333-333333333333',
    null,
    'free_text',
    'free_text',
    'Other workspace submission.',
    'Other workspace submission.',
    'Other workspace feedback.',
    'B1',
    'checked',
    'immediate',
    null,
    'ready',
    'released',
    '2026-01-07 10:01:00+00',
    '2026-01-07 10:00:00+00',
    '2026-01-07 10:01:00+00'
  );

insert into public.submission_lines (
  submission_id,
  line_number,
  original_line,
  corrected_line,
  status,
  changed_parts,
  short_explanation,
  detailed_explanation,
  grammar_topic_id,
  source_start,
  source_end
)
values
  (
    'a5111111-1111-4111-8111-111111111111',
    1,
    'Ich lerne Deutsch.',
    'Ich lerne Deutsch.',
    'correct',
    '[]'::jsonb,
    'Released explanation.',
    'Released detailed explanation.',
    null,
    0,
    18
  ),
  (
    'a5444444-4444-4444-8444-444444444444',
    1,
    'Held submission with private feedback.',
    'CHILD_HELD_SECRET',
    'major_issue',
    '[{"from":"Held submission with private feedback.","to":"CHILD_HELD_SECRET","reason":"Private","source_start":0,"source_end":38,"corrected_start":0,"corrected_end":17}]'::jsonb,
    'CHILD_HELD_EXPLANATION_SECRET',
    'CHILD_HELD_DETAIL_SECRET',
    'a4111111-1111-4111-8111-111111111111',
    0,
    38
  );

insert into public.submission_grammar_topics (
  submission_id,
  grammar_topic_id,
  count,
  severity,
  simple_explanation
)
values
  (
    'a5111111-1111-4111-8111-111111111111',
    'a4111111-1111-4111-8111-111111111111',
    1,
    'minor',
    'Released topic explanation.'
  ),
  (
    'a5444444-4444-4444-8444-444444444444',
    'a4111111-1111-4111-8111-111111111111',
    1,
    'major',
    'CHILD_HELD_TOPIC_SECRET'
  );

insert into app_private.feedback_drafts (
  submission_id,
  version,
  state,
  content,
  provider_model
)
values (
  'a5444444-4444-4444-8444-444444444444',
  1,
  'needs_review',
  '{
    "private_marker": "PRIVATE_DRAFT_SECRET",
    "level_detected": "A2",
    "overall_summary": "PRIVATE_DRAFT_SECRET",
    "corrected_text": "CHILD_HELD_SECRET",
    "lines": [
      {
        "line_number": 1,
        "source_start": 0,
        "source_end": 38,
        "original_line": "Held submission with private feedback.",
        "corrected_line": "CHILD_HELD_SECRET",
        "status": "major_issue",
        "grammar_topic": "word-order",
        "changed_parts": [
          {
            "from": "Held submission with private feedback.",
            "to": "CHILD_HELD_SECRET",
            "reason": "Private",
            "source_start": 0,
            "source_end": 38,
            "corrected_start": 0,
            "corrected_end": 17
          }
        ],
        "short_explanation": "CHILD_HELD_EXPLANATION_SECRET",
        "detailed_explanation": "CHILD_HELD_DETAIL_SECRET"
      }
    ]
  }'::jsonb,
  'fixture-model'
);

create temporary table phase_10a_state (
  singleton boolean primary key default true check (singleton),
  teacher_page_one jsonb,
  teacher_page_two jsonb,
  student_held_detail jsonb,
  student_released_detail jsonb,
  teacher_held_detail jsonb
) on commit drop;

insert into phase_10a_state default values;
grant select, update on table phase_10a_state to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a0111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'a0111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.list_workspace_submissions_page(
      target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
      requested_page_size => 0
    )
  $$,
  '22023',
  'Page size must be between 1 and 100.',
  'workspace pagination rejects a zero page size'
);

select throws_ok(
  $$
    select api.list_workspace_submissions_page(
      target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
      requested_page_size => 101
    )
  $$,
  '22023',
  'Page size must be between 1 and 100.',
  'workspace pagination rejects an excessive page size'
);

select throws_ok(
  $$
    select api.list_workspace_submissions_page(
      target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
      cursor_created_at => '2026-01-01 00:00:00+00'
    )
  $$,
  '22023',
  'Both cursor fields are required together.',
  'pagination rejects a partial cursor'
);

select throws_ok(
  $$
    select api.list_workspace_submissions_page(
      target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
      target_evaluation_status => 'unknown'
    )
  $$,
  '22023',
  'Evaluation status filter is invalid.',
  'pagination rejects an invalid evaluation status'
);

select throws_ok(
  $$
    select api.list_workspace_submissions_page(
      target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
      target_release_status => 'private'
    )
  $$,
  '22023',
  'Release status filter is invalid.',
  'pagination rejects an invalid release status'
);

select throws_ok(
  $$
    select api.list_workspace_submissions_page(
      target_workspace_id => 'a1222222-2222-4222-8222-222222222222'
    )
  $$,
  '42501',
  'Permission denied.',
  'a teacher cannot list another workspace'
);

select throws_ok(
  $$
    select api.get_submission_detail('a5888888-8888-4888-8888-888888888888')
  $$,
  '42501',
  'Submission not found or access denied.',
  'a teacher cannot open another workspace submission'
);

update pg_temp.phase_10a_state
set teacher_page_one = api.list_workspace_submissions_page(
  target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
  requested_page_size => 2
)
where singleton;

update pg_temp.phase_10a_state
set teacher_page_two = api.list_workspace_submissions_page(
  target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
  requested_page_size => 2,
  cursor_created_at => (teacher_page_one #>> '{next_cursor,created_at}')::timestamptz,
  cursor_id => (teacher_page_one #>> '{next_cursor,id}')::uuid
)
where singleton;

select is(
  (select (teacher_page_one ->> 'total_count')::integer from pg_temp.phase_10a_state),
  7,
  'the teacher page reports an exact total independent of page size'
);

select ok(
  (
    select (teacher_page_one ->> 'returned_count')::integer = 2
      and (teacher_page_one ->> 'has_more')::boolean
      and teacher_page_one -> 'next_cursor' is not null
    from pg_temp.phase_10a_state
  ),
  'the first teacher page exposes bounded keyset metadata'
);

select is(
  (select (teacher_page_two ->> 'total_count')::integer from pg_temp.phase_10a_state),
  7,
  'the exact total remains stable on the second page'
);

select is(
  (
    select count(*)::integer
    from pg_temp.phase_10a_state state
    cross join lateral jsonb_array_elements(state.teacher_page_one -> 'items') first_item
    join lateral jsonb_array_elements(state.teacher_page_two -> 'items') second_item
      on first_item ->> 'id' = second_item ->> 'id'
  ),
  0,
  'adjacent keyset pages contain no duplicate submissions'
);

select is(
  (
    select string_agg(item ->> 'id', ',' order by page_number, item_number)
    from pg_temp.phase_10a_state state
    cross join lateral (
      select 1 as page_number, item, item_number
      from jsonb_array_elements(state.teacher_page_one -> 'items')
        with ordinality page(item, item_number)
      union all
      select 2 as page_number, item, item_number
      from jsonb_array_elements(state.teacher_page_two -> 'items')
        with ordinality page(item, item_number)
    ) ordered_items
  ),
  concat_ws(
    ',',
    'a5111111-1111-4111-8111-111111111111',
    'a5333333-3333-4333-8333-333333333333',
    'a5222222-2222-4222-8222-222222222222',
    'a5444444-4444-4444-8444-444444444444'
  ),
  'created-at ties remain stable through the UUID cursor tiebreaker'
);

select ok(
  (
    select (page ->> 'total_count')::integer = 1
      and page #>> '{items,0,id}' = 'a5777777-7777-4777-8777-777777777777'
    from (
      select api.list_workspace_submissions_page(
        target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
        target_student_id => 'a0333333-3333-4333-8333-333333333333',
        requested_page_size => 1
      ) as page
    ) filtered
  ),
  'the teacher student filter executes before pagination'
);

select ok(
  (
    select (page ->> 'total_count')::integer = 2
      and page #>> '{items,1,id}' = 'a5666666-6666-4666-8666-666666666666'
      and page #>> '{items,1,question_title}' = 'Phase 10A Writing Task'
      and page #>> '{items,1,batch_name}' = 'Phase 10A Batch A2'
    from (
      select api.list_workspace_submissions_page(
        target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
        target_batch_id => 'a2222222-2222-4222-8222-222222222222',
        requested_page_size => 10
      ) as page
    ) filtered
  ),
  'batch filtering finds older rows and returns joined task and batch labels'
);

select ok(
  (
    select (page ->> 'total_count')::integer = 1
      and page #>> '{items,0,id}' = 'a5222222-2222-4222-8222-222222222222'
    from (
      select api.list_workspace_submissions_page(
        target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
        target_evaluation_status => 'processing',
        requested_page_size => 10
      ) as page
    ) filtered
  ),
  'evaluation filtering executes before pagination'
);

select is(
  (
    select (api.list_workspace_submissions_page(
      target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
      target_release_status => 'held',
      requested_page_size => 10
    ) ->> 'total_count')::integer
  ),
  3,
  'release filtering has an exact filtered total'
);

select ok(
  (
    select (page ->> 'total_count')::integer = 0
      and page -> 'items' = '[]'::jsonb
      and not (page ->> 'has_more')::boolean
    from (
      select api.list_workspace_submissions_page(
        target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
        target_batch_id => 'a2222222-2222-4222-8222-222222222222',
        target_evaluation_status => 'failed',
        target_release_status => 'released',
        requested_page_size => 10
      ) as page
    ) filtered
  ),
  'an empty filtered page still returns an exact zero total and page metadata'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a0222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'a0222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.list_student_submissions_page(
      target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
      target_student_id => 'a0222222-2222-4222-8222-222222222222',
      requested_page_size => 101
    )
  $$,
  '22023',
  'Page size must be between 1 and 100.',
  'student pagination enforces the same strict page-size bound'
);

select throws_ok(
  $$
    select api.list_student_submissions_page(
      target_workspace_id => 'a1222222-2222-4222-8222-222222222222',
      target_student_id => 'a0222222-2222-4222-8222-222222222222'
    )
  $$,
  '42501',
  'Permission denied.',
  'a student cannot list a workspace where membership is absent'
);

select throws_ok(
  $$
    select api.list_student_submissions_page(
      target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
      target_student_id => 'a0333333-3333-4333-8333-333333333333'
    )
  $$,
  '42501',
  'Permission denied.',
  'a student cannot impersonate another student history query'
);

select is(
  (
    select (api.list_student_submissions_page(
      target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
      target_student_id => 'a0222222-2222-4222-8222-222222222222',
      requested_page_size => 2
    ) ->> 'total_count')::integer
  ),
  6,
  'student history returns the exact owner total rather than a client cap'
);

select ok(
  (
    select (page ->> 'total_count')::integer = 2
      and page #>> '{items,0,id}' = 'a5333333-3333-4333-8333-333333333333'
      and page #>> '{items,1,id}' = 'a5666666-6666-4666-8666-666666666666'
    from (
      select api.list_student_submissions_page(
        target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
        target_student_id => 'a0222222-2222-4222-8222-222222222222',
        target_batch_id => 'a2222222-2222-4222-8222-222222222222',
        target_evaluation_status => 'ready',
        target_release_status => 'released',
        requested_page_size => 10
      ) as page
    ) filtered
  ),
  'student batch, evaluation, and release filters all execute before pagination'
);

select ok(
  (
    select item ? 'original_text_excerpt'
      and not item ? 'original_text'
      and not item ? 'corrected_text'
      and not item ? 'overall_summary'
      and not item ? 'feedback'
    from (
      select api.list_student_submissions_page(
        target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
        target_student_id => 'a0222222-2222-4222-8222-222222222222',
        requested_page_size => 1
      ) #> '{items,0}' as item
    ) list_item
  ),
  'list rows expose only excerpts and never detail feedback payloads'
);

update pg_temp.phase_10a_state
set student_held_detail = api.get_submission_detail(
      'a5444444-4444-4444-8444-444444444444'
    ),
    student_released_detail = api.get_submission_detail(
      'a5111111-1111-4111-8111-111111111111'
    )
where singleton;

select ok(
  (
    select student_held_detail -> 'feedback' = 'null'::jsonb
      and student_held_detail #> '{submission,corrected_text}' = 'null'::jsonb
      and student_held_detail #> '{submission,overall_summary}' = 'null'::jsonb
    from pg_temp.phase_10a_state
  ),
  'students receive no parent or child feedback for an unreleased submission'
);

select ok(
  (
    select student_held_detail::text not like '%CHILD_HELD_%'
      and student_held_detail::text not like '%PRIVATE_DRAFT_SECRET%'
    from pg_temp.phase_10a_state
  ),
  'unreleased public child rows and private feedback drafts cannot leak to students'
);

select ok(
  (
    select jsonb_array_length(student_released_detail #> '{feedback,lines}') = 1
      and jsonb_array_length(student_released_detail #> '{feedback,grammar_topics}') = 1
      and student_released_detail #>> '{feedback,lines,0,short_explanation}' = 'Released explanation.'
      and student_released_detail #>> '{submission,corrected_text}' = 'Ich lerne Deutsch.'
    from pg_temp.phase_10a_state
  ),
  'released feedback is visible to the owning student in one detail result'
);

select throws_ok(
  $$
    select api.get_submission_detail('a5777777-7777-4777-8777-777777777777')
  $$,
  '42501',
  'Submission not found or access denied.',
  'a student cannot open another student submission'
);

select ok(
  (
    -- This fixture predates the immutable writing-context ledger.  Reading it
    -- must not project the current editable task title as historical truth.
    select detail #>> '{submission,question_title}' = 'Historical writing task'
      and detail #>> '{submission,batch_name}' = 'Phase 10A Batch A2'
      and detail #>> '{submission,student_email}' = 'phase10a-student-a@example.test'
    from (
      select api.get_submission_detail(
        'a5666666-6666-4666-8666-666666666666'
      ) as detail
    ) read_model
  ),
  'legacy submission detail uses a safe task label plus batch and student labels'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a0111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'a0111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

update pg_temp.phase_10a_state
set teacher_held_detail = api.get_submission_detail(
  'a5444444-4444-4444-8444-444444444444'
)
where singleton;

select ok(
  (
    select jsonb_array_length(teacher_held_detail #> '{feedback,lines}') = 1
      and teacher_held_detail #>> '{feedback,lines,0,corrected_line}' = 'CHILD_HELD_SECRET'
      and teacher_held_detail::text not like '%PRIVATE_DRAFT_SECRET%'
    from pg_temp.phase_10a_state
  ),
  'teachers can inspect the current allowed child state without exposing private draft storage'
);

reset role;
delete from public.workspace_members
where workspace_id = 'a1111111-1111-4111-8111-111111111111'
  and user_id = 'a0222222-2222-4222-8222-222222222222';

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'a0222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'a0222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.list_student_submissions_page(
      target_workspace_id => 'a1111111-1111-4111-8111-111111111111',
      target_student_id => 'a0222222-2222-4222-8222-222222222222'
    )
  $$,
  '42501',
  'Permission denied.',
  'stale student membership cannot list preserved submission history'
);

select throws_ok(
  $$
    select api.get_submission_detail('a5111111-1111-4111-8111-111111111111')
  $$,
  '42501',
  'Submission not found or access denied.',
  'stale student membership cannot open preserved submission detail'
);

reset role;
select * from finish();
rollback;
