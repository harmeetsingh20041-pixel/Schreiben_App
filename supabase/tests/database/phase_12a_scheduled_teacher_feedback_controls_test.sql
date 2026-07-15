begin;

select plan(15);

select ok(
  to_regprocedure(
    'app_private.prevent_scheduled_feedback_teacher_mutation()'
  ) is not null,
  'the scheduled-feedback mutation guard exists'
);

select ok(
  exists (
    select 1
    from pg_proc routine
    where routine.oid =
      'app_private.prevent_scheduled_feedback_teacher_mutation()'::regprocedure
      and routine.prosecdef
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.prevent_scheduled_feedback_teacher_mutation()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.prevent_scheduled_feedback_teacher_mutation()',
      'EXECUTE'
    ),
  'the private guard is a pinned definer routine with no gateway execute grant'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_record
    where trigger_record.tgrelid = 'app_private.feedback_drafts'::regclass
      and trigger_record.tgname =
        'feedback_drafts_guard_scheduled_teacher_mutation'
      and not trigger_record.tgisinternal
      and (trigger_record.tgtype & 2) = 2
      and (trigger_record.tgtype & 16) = 16
  ),
  'the guard runs before every feedback-draft update'
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
    '12a11111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase12a-teacher@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12A Teacher"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '12a22222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase12a-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12A Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  '12a33333-3333-4333-8333-333333333333',
  'Phase 12A Workspace',
  'phase-12a-scheduled-feedback-controls',
  '12a11111-1111-4111-8111-111111111111'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '12a11111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '12a11111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('app.allow_workspace_owner_insert', 'on', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '12a33333-3333-4333-8333-333333333333',
  '12a11111-1111-4111-8111-111111111111',
  'owner'
);

select set_config('app.allow_workspace_owner_insert', 'off', true);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '12a33333-3333-4333-8333-333333333333',
  '12a22222-2222-4222-8222-222222222222',
  'student'
);

insert into public.batches (
  id,
  workspace_id,
  name,
  level,
  created_by,
  is_active,
  feedback_mode,
  feedback_delay_min_minutes,
  feedback_delay_max_minutes
)
values (
  '12a34444-4444-4444-8444-444444444444',
  '12a33333-3333-4333-8333-333333333333',
  'Phase 12A A2',
  'A2',
  '12a11111-1111-4111-8111-111111111111',
  true,
  'automatic_delayed',
  30,
  30
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  '12a33333-3333-4333-8333-333333333333',
  '12a34444-4444-4444-8444-444444444444',
  '12a22222-2222-4222-8222-222222222222'
);

select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.submissions (
  id,
  workspace_id,
  student_id,
  batch_id,
  mode,
  question_source,
  original_text,
  status,
  feedback_mode,
  feedback_scheduled_at,
  evaluation_status,
  release_status,
  release_at
)
values
  (
    '12a41111-1111-4111-8111-111111111111',
    '12a33333-3333-4333-8333-333333333333',
    '12a22222-2222-4222-8222-222222222222',
    '12a34444-4444-4444-8444-444444444444',
    'free_text',
    'free_text',
    'Alles gut.',
    'checked',
    'automatic_delayed',
    now() + interval '30 minutes',
    'ready',
    'scheduled',
    now() + interval '30 minutes'
  ),
  (
    '12a42222-2222-4222-8222-222222222222',
    '12a33333-3333-4333-8333-333333333333',
    '12a22222-2222-4222-8222-222222222222',
    '12a34444-4444-4444-8444-444444444444',
    'free_text',
    'free_text',
    'Alles gut.',
    'checked',
    'teacher_review_only',
    null,
    'ready',
    'held',
    null
  ),
  (
    '12a43333-3333-4333-8333-333333333333',
    '12a33333-3333-4333-8333-333333333333',
    '12a22222-2222-4222-8222-222222222222',
    '12a34444-4444-4444-8444-444444444444',
    'free_text',
    'free_text',
    'Alles gut.',
    'needs_review',
    'automatic_delayed',
    now() + interval '30 minutes',
    'needs_review',
    'held',
    null
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
    '12a51111-1111-4111-8111-111111111111',
    '12a41111-1111-4111-8111-111111111111',
    1,
    'draft',
    jsonb_build_object(
      'overall_summary', 'The writing is correct.',
      'level_detected', 'A2',
      'corrected_text', 'Alles gut.',
      'ai_model', 'deepseek-v4-flash',
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 10,
        'original_line', 'Alles gut.',
        'corrected_line', 'Alles gut.',
        'status', 'correct',
        'changed_parts', '[]'::jsonb,
        'short_explanation', '',
        'detailed_explanation', '',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb,
      'score_summary', '{}'::jsonb
    ),
    'deepseek-v4-flash'
  ),
  (
    '12a52222-2222-4222-8222-222222222222',
    '12a42222-2222-4222-8222-222222222222',
    1,
    'draft',
    jsonb_build_object(
      'overall_summary', 'The writing is correct.',
      'level_detected', 'A2',
      'corrected_text', 'Alles gut.',
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 10,
        'original_line', 'Alles gut.',
        'corrected_line', 'Alles gut.',
        'status', 'correct',
        'changed_parts', '[]'::jsonb,
        'short_explanation', '',
        'detailed_explanation', '',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb,
      'score_summary', '{}'::jsonb
    ),
    'phase-12a-fixture'
  ),
  (
    '12a53333-3333-4333-8333-333333333333',
    '12a43333-3333-4333-8333-333333333333',
    1,
    'needs_review',
    jsonb_build_object(
      'overall_summary', 'A teacher must decide this line.',
      'level_detected', 'A2',
      'corrected_text', 'Alles gut.',
      'lines', jsonb_build_array(jsonb_build_object(
        'line_number', 1,
        'source_start', 0,
        'source_end', 10,
        'original_line', 'Alles gut.',
        'corrected_line', 'Alles gut.',
        'status', 'unclear',
        'changed_parts', '[]'::jsonb,
        'short_explanation', 'A teacher must decide whether a change is needed.',
        'detailed_explanation', '',
        'grammar_topic', ''
      )),
      'grammar_topics', '[]'::jsonb,
      'score_summary', '{}'::jsonb
    ),
    'phase-12a-fixture'
  );

with source_context as (
  select
    submission.*,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(submission.original_text, 'UTF8')
      ),
      'hex'
    ) as original_text_sha256
  from public.submissions submission
  where submission.id = '12a41111-1111-4111-8111-111111111111'
)
insert into app_private.writing_evaluation_contexts (
  submission_id,
  context_version,
  workspace_id,
  student_id,
  batch_id,
  cefr_level,
  source_type,
  source_id,
  submission_mode,
  question_metadata,
  original_text_sha256,
  context_sha256
)
select
  context.id,
  1,
  context.workspace_id,
  context.student_id,
  context.batch_id,
  'A2',
  'free_text',
  null,
  'free_text',
  '{}'::jsonb,
  context.original_text_sha256,
  app_private.writing_evaluation_context_sha256(
    context.id,
    1::smallint,
    context.workspace_id,
    context.student_id,
    context.batch_id,
    'A2',
    'free_text',
    null,
    'free_text',
    '{}'::jsonb,
    context.original_text_sha256
  )
from source_context context;

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
  '12a61111-1111-4111-8111-111111111111',
  'writing_evaluation',
  'writing_evaluation',
  '12a41111-1111-4111-8111-111111111111',
  1,
  'phase12a:writing:12a41111-1111-4111-8111-111111111111:1',
  'succeeded',
  1,
  now()
);

insert into app_private.writing_feedback_adjudications_v2 (
  job_id,
  submission_id,
  evaluation_version,
  feedback_version,
  schema_version,
  decision,
  reason_code,
  context_sha256,
  original_text_sha256,
  final_feedback_sha256,
  generator_provider,
  generator_model,
  candidate_feedback_sha256,
  candidate_release_sha256,
  critic_provider,
  critic_model,
  critic_verdict,
  critic_decision_sha256,
  accepted_provider,
  accepted_model
)
select
  '12a61111-1111-4111-8111-111111111111',
  draft.submission_id,
  1,
  draft.version,
  2,
  'accepted_model_feedback',
  'critic_approved',
  context.context_sha256,
  context.original_text_sha256,
  app_private.canonical_jsonb_sha256(draft.content),
  'deepseek',
  'deepseek-v4-flash',
  app_private.canonical_jsonb_sha256(draft.content),
  app_private.canonical_jsonb_sha256(draft.content),
  'gemini',
  'gemini-3.1-flash-lite',
  'approved',
  repeat('a', 64),
  'deepseek',
  'deepseek-v4-flash'
from app_private.feedback_drafts draft
join app_private.writing_evaluation_contexts context
  on context.submission_id = draft.submission_id
where draft.id = '12a51111-1111-4111-8111-111111111111';

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '12a11111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '12a11111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  api.get_feedback_draft(
    '12a41111-1111-4111-8111-111111111111'
  ) #>> '{draft,id}',
  '12a51111-1111-4111-8111-111111111111',
  'a teacher can read the normal scheduled draft for a read-only preview'
);

select throws_ok(
  $$
    select api.update_feedback_draft(
      '12a51111-1111-4111-8111-111111111111',
      jsonb_set(
        api.get_feedback_draft(
          '12a41111-1111-4111-8111-111111111111'
        ) #> '{draft,content}',
        '{overall_summary}',
        to_jsonb('An early teacher edit.'::text)
      ),
      1
    )
  $$,
  '55000',
  'Scheduled feedback is read-only until its automatic release.',
  'a teacher cannot edit normal scheduled feedback'
);

select is(
  (
    api.get_feedback_draft(
      '12a41111-1111-4111-8111-111111111111'
    ) #>> '{draft,revision}'
  )::integer,
  1,
  'a rejected scheduled edit leaves the draft revision unchanged'
);

select throws_ok(
  $$
    select api.release_feedback(
      '12a41111-1111-4111-8111-111111111111',
      '12a51111-1111-4111-8111-111111111111'
    )
  $$,
  '55000',
  'Scheduled feedback is read-only until its automatic release.',
  'a teacher cannot release normal scheduled feedback early'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = '12a41111-1111-4111-8111-111111111111'
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'scheduled'
      and submission.corrected_text is null
  ),
  'rejected teacher actions preserve the private scheduled state'
);

select ok(
  api.update_feedback_draft(
    '12a52222-2222-4222-8222-222222222222',
    jsonb_set(
      api.get_feedback_draft(
        '12a42222-2222-4222-8222-222222222222'
      ) #> '{draft,content}',
      '{overall_summary}',
      to_jsonb('The teacher reviewed this feedback.'::text)
    ),
    1
  ) #>> '{draft,revision}' = '2',
  'teacher-review feedback remains editable while held'
);

select ok(
  api.release_feedback(
    '12a42222-2222-4222-8222-222222222222',
    '12a52222-2222-4222-8222-222222222222'
  ) ->> 'release_status' = 'released',
  'teacher-review feedback still supports approval and release'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = '12a42222-2222-4222-8222-222222222222'
      and submission.release_status = 'released'
      and submission.corrected_text = 'Alles gut.'
  ),
  'teacher-review release still materializes complete feedback atomically'
);

select ok(
  api.update_feedback_draft(
    '12a53333-3333-4333-8333-333333333333',
    api.get_feedback_draft(
      '12a43333-3333-4333-8333-333333333333'
    ) #> '{draft,content}',
    1
  ) #>> '{draft,state}' = 'needs_review',
  'uncertain delayed feedback remains editable after it is held for a teacher'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = '12a43333-3333-4333-8333-333333333333'
      and submission.evaluation_status = 'needs_review'
      and submission.release_status = 'held'
  ),
  'reviewing uncertain delayed feedback cannot restore the automatic schedule'
);

reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select lives_ok(
  $$
    select app_private.materialize_feedback_draft(
      '12a41111-1111-4111-8111-111111111111',
      '12a51111-1111-4111-8111-111111111111',
      null
    )
  $$,
  'the internal automatic release path is not blocked by the teacher guard'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = '12a41111-1111-4111-8111-111111111111'
      and submission.release_status = 'released'
      and submission.corrected_text = 'Alles gut.'
  ),
  'automatic release still materializes the scheduled feedback'
);

select * from finish();
rollback;
