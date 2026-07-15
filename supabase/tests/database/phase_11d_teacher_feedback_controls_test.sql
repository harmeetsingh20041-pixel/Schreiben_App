begin;

select plan(37);

select ok(
  to_regprocedure('api.get_feedback_draft(uuid)') is not null
    and to_regprocedure('api.update_feedback_draft(uuid,jsonb,integer)') is not null
    and to_regprocedure('api.release_feedback(uuid,uuid)') is not null
    and to_regprocedure(
      'api.list_feedback_review_queue_page(uuid,text,integer,timestamptz,uuid)'
    ) is not null,
  'teacher feedback APIs have stable public signatures'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    where routine.oid in (
      'api.get_feedback_draft(uuid)'::regprocedure,
      'api.update_feedback_draft(uuid,jsonb,integer)'::regprocedure,
      'api.release_feedback(uuid,uuid)'::regprocedure,
      'api.list_feedback_review_queue_page(uuid,text,integer,timestamptz,uuid)'::regprocedure
    )
      and routine.prosecdef
  ),
  'teacher feedback API wrappers remain security invokers'
);

select ok(
  not exists (
    select 1
    from pg_proc routine
    where routine.oid in (
      'api.get_feedback_draft(uuid)'::regprocedure,
      'api.update_feedback_draft(uuid,jsonb,integer)'::regprocedure,
      'api.release_feedback(uuid,uuid)'::regprocedure,
      'api.list_feedback_review_queue_page(uuid,text,integer,timestamptz,uuid)'::regprocedure
    )
      and not exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
  ),
  'every feedback API pins an empty search path'
);

select ok(
  has_function_privilege('authenticated', 'api.get_feedback_draft(uuid)', 'EXECUTE')
    and has_function_privilege(
      'authenticated',
      'api.update_feedback_draft(uuid,jsonb,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.release_feedback(uuid,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'api.list_feedback_review_queue_page(uuid,text,integer,timestamptz,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege('anon', 'api.get_feedback_draft(uuid)', 'EXECUTE')
    and not has_function_privilege(
      'anon',
      'api.update_feedback_draft(uuid,jsonb,integer)',
      'EXECUTE'
    )
    and not has_function_privilege('anon', 'api.release_feedback(uuid,uuid)', 'EXECUTE'),
  'only authenticated callers can reach the teacher feedback API surface'
);

select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'app_private.feedback_draft_events'::regclass)
    and not has_table_privilege(
      'authenticated',
      'app_private.feedback_draft_events',
      'SELECT'
    )
    and not has_table_privilege(
      'service_role',
      'app_private.feedback_draft_events',
      'SELECT'
    ),
  'the append-only teacher audit trail is private with RLS defense in depth'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'app_private.feedback_drafts'::regclass
      and tgname = 'feedback_drafts_prevent_final_update'
      and not tgisinternal
  ),
  'final feedback versions have an immutability trigger'
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
    'd0111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase11d-teacher-a@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11D Teacher A"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd0222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase11d-student-a@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11D Student A"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd0333333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'phase11d-teacher-b@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11D Teacher B"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd0444444-4444-4444-8444-444444444444',
    'authenticated',
    'authenticated',
    'phase11d-student-b@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 11D Student B"}'::jsonb,
    now(),
    now()
  );

insert into app_private.teacher_entitlements (
  user_id,
  active,
  max_workspaces,
  note
)
values
  (
    'd0111111-1111-4111-8111-111111111111',
    true,
    1,
    'Phase 11D teacher A fixture.'
  ),
  (
    'd0333333-3333-4333-8333-333333333333',
    true,
    1,
    'Phase 11D teacher B fixture.'
  );

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    'd1111111-1111-4111-8111-111111111111',
    'Phase 11D Workspace A',
    'phase-11d-workspace-a',
    'd0111111-1111-4111-8111-111111111111'
  ),
  (
    'd1222222-2222-4222-8222-222222222222',
    'Phase 11D Workspace B',
    'phase-11d-workspace-b',
    'd0333333-3333-4333-8333-333333333333'
  );

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claim.sub',
  'd0111111-1111-4111-8111-111111111111',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd1111111-1111-4111-8111-111111111111',
  'd0111111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);
select set_config(
  'request.jwt.claim.sub',
  'd0333333-3333-4333-8333-333333333333',
  true
);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'd1222222-2222-4222-8222-222222222222',
  'd0333333-3333-4333-8333-333333333333',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'd1111111-1111-4111-8111-111111111111',
    'd0222222-2222-4222-8222-222222222222',
    'student'
  ),
  (
    'd1222222-2222-4222-8222-222222222222',
    'd0444444-4444-4444-8444-444444444444',
    'student'
  );

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
    'd2111111-1111-4111-8111-111111111111',
    'd1111111-1111-4111-8111-111111111111',
    'Phase 11D Teacher Review',
    'A2',
    'd0111111-1111-4111-8111-111111111111',
    true,
    true,
    true,
    'teacher_review_only',
    0,
    0
  ),
  (
    'd2222222-2222-4222-8222-222222222222',
    'd1222222-2222-4222-8222-222222222222',
    'Phase 11D Other Workspace',
    'A2',
    'd0333333-3333-4333-8333-333333333333',
    true,
    true,
    true,
    'teacher_review_only',
    0,
    0
  );

insert into public.batch_students (workspace_id, batch_id, student_id)
values
  (
    'd1111111-1111-4111-8111-111111111111',
    'd2111111-1111-4111-8111-111111111111',
    'd0222222-2222-4222-8222-222222222222'
  ),
  (
    'd1222222-2222-4222-8222-222222222222',
    'd2222222-2222-4222-8222-222222222222',
    'd0444444-4444-4444-8444-444444444444'
  );

insert into public.submissions (
  id,
  workspace_id,
  student_id,
  batch_id,
  mode,
  original_text,
  status,
  feedback_mode,
  evaluation_status,
  release_status,
  feedback_scheduled_at,
  release_at,
  created_at,
  updated_at
)
values
  (
    'd3111111-1111-4111-8111-111111111111',
    'd1111111-1111-4111-8111-111111111111',
    'd0222222-2222-4222-8222-222222222222',
    'd2111111-1111-4111-8111-111111111111',
    'free_text',
    'Ich gehe Schule.',
    'checked',
    'teacher_review_only',
    'ready',
    'held',
    null,
    null,
    '2026-07-10 10:03:00+00',
    '2026-07-10 10:03:00+00'
  ),
  (
    'd3222222-2222-4222-8222-222222222222',
    'd1111111-1111-4111-8111-111111111111',
    'd0222222-2222-4222-8222-222222222222',
    'd2111111-1111-4111-8111-111111111111',
    'free_text',
    'Ich sehe Hund.',
    'needs_review',
    'immediate',
    'needs_review',
    'held',
    null,
    null,
    '2026-07-10 10:02:00+00',
    '2026-07-10 10:02:00+00'
  ),
  (
    'd3333333-3333-4333-8333-333333333333',
    'd1111111-1111-4111-8111-111111111111',
    'd0222222-2222-4222-8222-222222222222',
    'd2111111-1111-4111-8111-111111111111',
    'free_text',
    'Provider failure.',
    'failed',
    'immediate',
    'failed',
    'held',
    null,
    null,
    '2026-07-10 10:01:00+00',
    '2026-07-10 10:01:00+00'
  ),
  (
    'd3444444-4444-4444-8444-444444444444',
    'd1222222-2222-4222-8222-222222222222',
    'd0444444-4444-4444-8444-444444444444',
    'd2222222-2222-4222-8222-222222222222',
    'free_text',
    'Andere Klasse.',
    'checked',
    'teacher_review_only',
    'ready',
    'held',
    null,
    null,
    '2026-07-10 10:04:00+00',
    '2026-07-10 10:04:00+00'
  ),
  (
    'd3555555-5555-4555-8555-555555555555',
    'd1111111-1111-4111-8111-111111111111',
    'd0222222-2222-4222-8222-222222222222',
    'd2111111-1111-4111-8111-111111111111',
    'free_text',
    'Geplante Rueckmeldung.',
    'checked',
    'automatic_delayed',
    'ready',
    'scheduled',
    '2026-07-10 09:59:00+00',
    '2026-07-10 09:59:00+00',
    '2026-07-10 10:00:00+00',
    '2026-07-10 10:00:00+00'
  ),
  (
    'd3666666-6666-4666-8666-666666666666',
    'd1111111-1111-4111-8111-111111111111',
    'd0222222-2222-4222-8222-222222222222',
    'd2111111-1111-4111-8111-111111111111',
    'free_text',
    'Gerade faellige Rueckmeldung.',
    'checked',
    'automatic_delayed',
    'ready',
    'scheduled',
    now() - interval '30 seconds',
    now() - interval '30 seconds',
    '2026-07-10 10:00:30+00',
    '2026-07-10 10:00:30+00'
  );

insert into app_private.feedback_drafts (
  id,
  submission_id,
  version,
  state,
  content,
  provider_model
)
values
  (
    'd4111111-1111-4111-8111-111111111111',
    'd3111111-1111-4111-8111-111111111111',
    1,
    'draft',
    jsonb_build_object(
      'overall_summary', 'Add the missing preposition.',
      'level_detected', 'A2',
      'corrected_text', 'Ich gehe zur Schule.',
      'ai_model', 'phase-11d-fixture',
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 16,
        'original_line', 'Ich gehe Schule.',
        'corrected_line', 'Ich gehe zur Schule.',
        'status', 'minor_issue',
        'changed_parts', jsonb_build_array(jsonb_build_object(
          'from', '',
          'to', 'zur ',
          'reason', 'A preposition is required.',
          'source_start', 9,
          'source_end', 9,
          'corrected_start', 9,
          'corrected_end', 13
        )),
        'short_explanation', 'Use zur before Schule.',
        'detailed_explanation', 'The destination needs a prepositional phrase.',
        'grammar_topic', 'prepositions'
      )),
      'grammar_topics', '[]'::jsonb,
      'score_summary', '{}'::jsonb
    ),
    'phase-11d-fixture'
  ),
  (
    'd4222222-2222-4222-8222-222222222222',
    'd3222222-2222-4222-8222-222222222222',
    1,
    'needs_review',
    jsonb_build_object(
      'overall_summary', 'The evaluator was not certain.',
      'level_detected', 'A2',
      'corrected_text', 'Ich sehe Hund.',
      'ai_model', 'phase-11d-fixture',
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 14,
        'original_line', 'Ich sehe Hund.',
        'corrected_line', 'Ich sehe Hund.',
        'status', 'unclear',
        'changed_parts', '[]'::jsonb,
        'short_explanation', 'A teacher must decide whether an article is required.',
        'detailed_explanation', '',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb,
      'score_summary', '{}'::jsonb
    ),
    'phase-11d-fixture'
  ),
  (
    'd4333333-3333-4333-8333-333333333333',
    'd3444444-4444-4444-8444-444444444444',
    1,
    'draft',
    jsonb_build_object(
      'overall_summary', 'No changes are needed.',
      'level_detected', 'A2',
      'corrected_text', 'Andere Klasse.',
      'ai_model', 'phase-11d-fixture',
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 14,
        'original_line', 'Andere Klasse.',
        'corrected_line', 'Andere Klasse.',
        'status', 'correct',
        'changed_parts', '[]'::jsonb,
        'short_explanation', '',
        'detailed_explanation', '',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb,
      'score_summary', '{}'::jsonb
    ),
    'phase-11d-fixture'
  ),
  (
    'd4444444-4444-4444-8444-444444444444',
    'd3555555-5555-4555-8555-555555555555',
    1,
    'draft',
    jsonb_build_object(
      'overall_summary', 'Validated scheduled feedback.',
      'level_detected', 'A2',
      'corrected_text', 'Geplante Rueckmeldung.',
      'ai_model', 'phase-11d-fixture',
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 22,
        'original_line', 'Geplante Rueckmeldung.',
        'corrected_line', 'Geplante Rueckmeldung.',
        'status', 'correct',
        'changed_parts', '[]'::jsonb,
        'short_explanation', '',
        'detailed_explanation', '',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb,
      'score_summary', '{}'::jsonb
    ),
    'phase-11d-fixture'
  ),
  (
    'd4555555-5555-4555-8555-555555555555',
    'd3666666-6666-4666-8666-666666666666',
    1,
    'draft',
    jsonb_build_object(
      'overall_summary', 'Validated scheduled feedback within the normal release window.',
      'level_detected', 'A2',
      'corrected_text', 'Gerade faellige Rueckmeldung.',
      'ai_model', 'phase-11d-fixture',
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 29,
        'original_line', 'Gerade faellige Rueckmeldung.',
        'corrected_line', 'Gerade faellige Rueckmeldung.',
        'status', 'correct',
        'changed_parts', '[]'::jsonb,
        'short_explanation', '',
        'detailed_explanation', '',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb,
      'score_summary', '{}'::jsonb
    ),
    'phase-11d-fixture'
  );

create temporary table phase_11d_state (
  singleton boolean primary key default true check (singleton),
  draft_read jsonb,
  queue_page_one jsonb,
  queue_page_two jsonb,
  updated_draft jsonb,
  unresolved_draft jsonb,
  released_feedback jsonb
) on commit drop;

insert into phase_11d_state default values;
grant select, update on table phase_11d_state to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0333333-3333-4333-8333-333333333333',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'd0333333-3333-4333-8333-333333333333', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.list_feedback_review_queue_page(
      'd1111111-1111-4111-8111-111111111111'
    )
  $$,
  '42501',
  'Permission denied.',
  'a teacher cannot list another workspace review queue'
);

select throws_ok(
  $$
    select api.get_feedback_draft('d3111111-1111-4111-8111-111111111111')
  $$,
  '42501',
  'Submission not found or access denied.',
  'a teacher cannot read another workspace private draft'
);

select throws_ok(
  $$
    select api.update_feedback_draft(
      'd4111111-1111-4111-8111-111111111111',
      '{}'::jsonb,
      1
    )
  $$,
  '42501',
  'Feedback version not found or access denied.',
  'a teacher cannot update another workspace private draft'
);

select throws_ok(
  $$
    select api.release_feedback(
      'd3111111-1111-4111-8111-111111111111',
      'd4111111-1111-4111-8111-111111111111'
    )
  $$,
  '42501',
  'Feedback version not found or access denied.',
  'a teacher cannot release another workspace private draft'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'd0222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.get_feedback_draft('d3111111-1111-4111-8111-111111111111')
  $$,
  '42501',
  'Submission not found or access denied.',
  'a student cannot read a private feedback draft from their own workspace'
);

select throws_ok(
  $$
    select api.list_feedback_review_queue_page(
      'd1111111-1111-4111-8111-111111111111'
    )
  $$,
  '42501',
  'Permission denied.',
  'a student cannot list the teacher feedback exception queue in their own workspace'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'd0111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.list_feedback_review_queue_page(
      'd1111111-1111-4111-8111-111111111111',
      'not-valid'
    )
  $$,
  '22023',
  'Review reason is invalid.',
  'the review queue rejects unknown reasons'
);

select throws_ok(
  $$
    select api.list_feedback_review_queue_page(
      'd1111111-1111-4111-8111-111111111111',
      requested_page_size => 101
    )
  $$,
  '22023',
  'Page size must be between 1 and 100.',
  'the review queue enforces its maximum page size'
);

select throws_ok(
  $$
    select api.list_feedback_review_queue_page(
      'd1111111-1111-4111-8111-111111111111',
      cursor_created_at => '2026-07-10 10:00:00+00'
    )
  $$,
  '22023',
  'Both cursor fields are required together.',
  'the review queue rejects a partial cursor'
);

update pg_temp.phase_11d_state
set draft_read = api.get_feedback_draft('d3111111-1111-4111-8111-111111111111')
where singleton;

select ok(
  (
    select draft_read ->> 'schema_version' = '1'
      and draft_read #>> '{draft,id}' = 'd4111111-1111-4111-8111-111111111111'
      and draft_read #>> '{draft,state}' = 'draft'
      and draft_read #>> '{draft,content,overall_summary}' = 'Add the missing preposition.'
    from pg_temp.phase_11d_state
  ),
  'an authorized teacher receives the current private draft'
);

select ok(
  (
    select jsonb_array_length(draft_read -> 'topic_options') = 36
      and exists (
        select 1
        from jsonb_array_elements(draft_read -> 'topic_options') option
        where option ->> 'slug' = 'prepositions'
      )
    from pg_temp.phase_11d_state
  ),
  'the draft read returns the closed editable topic set'
);

update pg_temp.phase_11d_state
set queue_page_one = api.list_feedback_review_queue_page(
  'd1111111-1111-4111-8111-111111111111',
  requested_page_size => 2
)
where singleton;

update pg_temp.phase_11d_state
set queue_page_two = api.list_feedback_review_queue_page(
  'd1111111-1111-4111-8111-111111111111',
  requested_page_size => 2,
  cursor_created_at => (queue_page_one #>> '{next_cursor,created_at}')::timestamptz,
  cursor_id => (queue_page_one #>> '{next_cursor,id}')::uuid
)
where singleton;

select ok(
  (
    select (queue_page_one ->> 'total_count')::integer = 4
      and (queue_page_one ->> 'returned_count')::integer = 2
      and (queue_page_one ->> 'has_more')::boolean
      and queue_page_one -> 'next_cursor' is not null
    from pg_temp.phase_11d_state
  ),
  'the review queue reports an exact total and bounded first page'
);

select ok(
  (
    select (queue_page_two ->> 'returned_count')::integer = 2
      and not (queue_page_two ->> 'has_more')::boolean
      and not exists (
        select 1
        from jsonb_array_elements(queue_page_one -> 'items') first_item
        join jsonb_array_elements(queue_page_two -> 'items') second_item
          on first_item ->> 'id' = second_item ->> 'id'
      )
    from pg_temp.phase_11d_state
  ),
  'adjacent review queue pages contain no duplicate submissions'
);

select ok(
  (
    select page ->> 'total_count' = '1'
      and page #>> '{items,0,id}' = 'd3222222-2222-4222-8222-222222222222'
      and page #>> '{items,0,review_reason}' = 'uncertain'
    from (
      select api.list_feedback_review_queue_page(
        'd1111111-1111-4111-8111-111111111111',
        'uncertain'
      ) as page
    ) filtered
  ),
  'review-reason filtering happens before pagination'
);

select ok(
  (
    select page ->> 'total_count' = '1'
      and page #>> '{items,0,id}' = 'd3555555-5555-4555-8555-555555555555'
      and page #>> '{items,0,review_reason}' = 'overdue_scheduled'
      and page #>> '{items,0,error_code}' = 'scheduled_release_overdue'
      and page #>> '{items,0,feedback_version_id}' =
        'd4444444-4444-4444-8444-444444444444'
    from (
      select api.list_feedback_review_queue_page(
        'd1111111-1111-4111-8111-111111111111',
        'overdue_scheduled'
      ) as page
    ) filtered
  ),
  'an overdue validated scheduled release is visible as a one-click rescue exception'
);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(
      api.list_feedback_review_queue_page(
        'd1111111-1111-4111-8111-111111111111'
      ) -> 'items'
    ) item
    where item ->> 'id' = 'd3666666-6666-4666-8666-666666666666'
  ),
  'a just-due scheduled release stays out of the exception queue during the normal 60-second recovery window'
);

update pg_temp.phase_11d_state state
set updated_draft = api.update_feedback_draft(
  'd4111111-1111-4111-8111-111111111111',
  jsonb_set(
    jsonb_set(
      state.draft_read #> '{draft,content}',
      '{overall_summary}',
      to_jsonb('The teacher confirmed the preposition correction.'::text)
    ),
    '{grammar_topics}',
    '[{"topic":"prepositions","count":99,"severity":"major","simple_explanation":"forged"}]'::jsonb
  ),
  1
)
where singleton;

select ok(
  (
    select updated_draft #>> '{draft,state}' = 'draft'
      and updated_draft #>> '{draft,revision}' = '2'
      and updated_draft #>> '{draft,content,grammar_topics,0,count}' = '1'
      and updated_draft #>> '{draft,content,grammar_topics,0,severity}' = 'minor'
    from pg_temp.phase_11d_state
  ),
  'a revision-safe edit is validated and topic counts are re-derived server-side'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = 'd3111111-1111-4111-8111-111111111111'
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'held'
      and submission.corrected_text is null
      and submission.overall_summary is null
  ),
  'editing keeps feedback private and explicitly held until teacher release'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.feedback_draft_events event
    where event.feedback_draft_id = 'd4111111-1111-4111-8111-111111111111'
      and event.event_type = 'teacher_edited'
  ),
  1,
  'the successful teacher edit is appended to the private audit trail'
);

set local role authenticated;

select throws_ok(
  $$
    select api.update_feedback_draft(
      'd4111111-1111-4111-8111-111111111111',
      (select draft_read #> '{draft,content}' from pg_temp.phase_11d_state),
      1
    )
  $$,
  '40001',
  'Feedback changed while you were editing. Refresh and try again.',
  'a stale teacher edit cannot overwrite a newer revision'
);

update pg_temp.phase_11d_state state
set unresolved_draft = api.update_feedback_draft(
  'd4222222-2222-4222-8222-222222222222',
  api.get_feedback_draft(
    'd3222222-2222-4222-8222-222222222222'
  ) #> '{draft,content}',
  1
)
where singleton;

select ok(
  (
    select unresolved_draft #>> '{draft,state}' = 'needs_review'
      and exists (
        select 1
        from public.submissions submission
        where submission.id = 'd3222222-2222-4222-8222-222222222222'
          and submission.evaluation_status = 'needs_review'
          and submission.release_status = 'held'
      )
    from pg_temp.phase_11d_state
  ),
  'an unresolved uncertain line remains explicitly held after an edit'
);

select throws_ok(
  $$
    select api.release_feedback(
      'd3222222-2222-4222-8222-222222222222',
      'd4222222-2222-4222-8222-222222222222'
    )
  $$,
  '55000',
  'Feedback must be fully reviewed before release.',
  'uncertain feedback cannot be released'
);

update pg_temp.phase_11d_state
set released_feedback = api.release_feedback(
  'd3111111-1111-4111-8111-111111111111',
  'd4111111-1111-4111-8111-111111111111'
)
where singleton;

select ok(
  (
    select released_feedback ->> 'state' = 'released'
      and released_feedback ->> 'release_status' = 'released'
      and released_feedback ->> 'feedback_revision' = '3'
      and released_feedback ->> 'released_at' is not null
    from pg_temp.phase_11d_state
  ),
  'teacher approval and release return the committed terminal state'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = 'd3111111-1111-4111-8111-111111111111'
      and submission.status = 'checked'
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'released'
      and submission.corrected_text = 'Ich gehe zur Schule.'
      and submission.overall_summary = 'The teacher confirmed the preposition correction.'
  ),
  'release atomically materializes the selected feedback into the submission'
);

select ok(
  exists (
    select 1
    from public.submission_lines line
    join public.grammar_topics topic on topic.id = line.grammar_topic_id
    where line.submission_id = 'd3111111-1111-4111-8111-111111111111'
      and line.source_start = 0
      and line.source_end = 16
      and line.corrected_line = 'Ich gehe zur Schule.'
      and topic.slug = 'prepositions'
  )
    and exists (
      select 1
      from public.submission_grammar_topics summary
      join public.grammar_topics topic on topic.id = summary.grammar_topic_id
      where summary.submission_id = 'd3111111-1111-4111-8111-111111111111'
        and topic.slug = 'prepositions'
        and summary.count = 1
        and summary.severity = 'minor'
    ),
  'released lines preserve source offsets and server-derived topic severity'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd0222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select ok(
  (
    select detail #>> '{submission,evaluation_status}' = 'ready'
      and detail #>> '{submission,release_status}' = 'released'
      and detail #>> '{submission,corrected_text}' = 'Ich gehe zur Schule.'
      and detail #>> '{submission,overall_summary}' =
        'The teacher confirmed the preposition correction.'
      and jsonb_typeof(detail -> 'feedback') = 'object'
      and jsonb_array_length(detail #> '{feedback,lines}') = 1
      and jsonb_array_length(detail #> '{feedback,grammar_topics}') = 1
      and detail #>> '{feedback,lines,0,corrected_line}' =
        'Ich gehe zur Schule.'
      and detail #>> '{feedback,grammar_topics,0,topic_slug}' =
        'prepositions'
    from api.get_submission_detail(
      'd3111111-1111-4111-8111-111111111111'
    ) detail
  ),
  'the exact student immediately reads ready released materialized feedback through the public detail RPC'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0444444-4444-4444-8444-444444444444',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd0444444-4444-4444-8444-444444444444',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.get_submission_detail(
      'd3111111-1111-4111-8111-111111111111'
    )
  $$,
  '42501',
  'Submission not found or access denied.',
  'an unrelated student cannot read another student released feedback'
);

reset role;

select ok(
  (
    select count(*) = 3
      and count(*) filter (where event_type = 'teacher_edited') = 1
      and count(*) filter (where event_type = 'teacher_approved') = 1
      and count(*) filter (where event_type = 'teacher_released') = 1
    from app_private.feedback_draft_events event
    where event.feedback_draft_id = 'd4111111-1111-4111-8111-111111111111'
  ),
  'edit, approval, and release remain independently auditable'
);

select throws_ok(
  $$
    update app_private.feedback_drafts
    set content = content
    where id = 'd4111111-1111-4111-8111-111111111111'
  $$,
  '55000',
  'Final feedback versions are immutable.',
  'a released feedback version cannot be rewritten even by privileged code'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd0111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config('request.jwt.claim.sub', 'd0111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  api.get_feedback_draft('d3111111-1111-4111-8111-111111111111') -> 'draft',
  'null'::jsonb,
  'the released version is no longer returned as an editable current draft'
);

select is(
  (
    api.list_feedback_review_queue_page(
      'd1111111-1111-4111-8111-111111111111'
    ) ->> 'total_count'
  )::integer,
  3,
  'a released submission disappears from the teacher review queue'
);

select * from finish();
rollback;
