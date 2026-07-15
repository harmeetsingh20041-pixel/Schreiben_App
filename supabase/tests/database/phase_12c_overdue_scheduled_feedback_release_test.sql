begin;

-- DISPOSABLE DATABASE ONLY: this test intentionally exercises the global
-- release_due_feedback_internal consumer for both race orders. Do not execute
-- it against a shared staging database that may contain unrelated overdue rows.

select plan(20);

create or replace function pg_temp.phase_12c_feedback_content()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
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
  );
$$;

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
    '12c11111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'phase12c-teacher-a@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12C Teacher A"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '12c22222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'phase12c-teacher-b@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12C Teacher B"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '12c33333-3333-4333-8333-333333333333',
    'authenticated',
    'authenticated',
    'phase12c-student@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12C Student"}'::jsonb,
    now(),
    now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values
  (
    '12c44444-4444-4444-8444-444444444444',
    'Phase 12C Workspace A',
    'phase-12c-overdue-scheduled-a',
    '12c11111-1111-4111-8111-111111111111'
  ),
  (
    '12c55555-5555-4555-8555-555555555555',
    'Phase 12C Workspace B',
    'phase-12c-overdue-scheduled-b',
    '12c22222-2222-4222-8222-222222222222'
  );

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    '12c44444-4444-4444-8444-444444444444',
    '12c11111-1111-4111-8111-111111111111',
    'teacher'
  ),
  (
    '12c55555-5555-4555-8555-555555555555',
    '12c22222-2222-4222-8222-222222222222',
    'teacher'
  );

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '12c44444-4444-4444-8444-444444444444',
  '12c33333-3333-4333-8333-333333333333',
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
  '12c56666-6666-4666-8666-666666666666',
  '12c44444-4444-4444-8444-444444444444',
  'Phase 12C A2',
  'A2',
  '12c11111-1111-4111-8111-111111111111',
  true,
  'automatic_delayed',
  30,
  30
);

insert into public.batch_students (workspace_id, batch_id, student_id)
values (
  '12c44444-4444-4444-8444-444444444444',
  '12c56666-6666-4666-8666-666666666666',
  '12c33333-3333-4333-8333-333333333333'
);

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
    '12c61111-1111-4111-8111-111111111111',
    '12c44444-4444-4444-8444-444444444444',
    '12c33333-3333-4333-8333-333333333333',
    '12c56666-6666-4666-8666-666666666666',
    'free_text',
    'free_text',
    'Alles gut.',
    'checked',
    'automatic_delayed',
    now() - interval '5 minutes',
    'ready',
    'scheduled',
    now() - interval '5 minutes'
  ),
  (
    '12c62222-2222-4222-8222-222222222222',
    '12c44444-4444-4444-8444-444444444444',
    '12c33333-3333-4333-8333-333333333333',
    '12c56666-6666-4666-8666-666666666666',
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
    '12c63333-3333-4333-8333-333333333333',
    '12c44444-4444-4444-8444-444444444444',
    '12c33333-3333-4333-8333-333333333333',
    '12c56666-6666-4666-8666-666666666666',
    'free_text',
    'free_text',
    'Alles gut.',
    'checked',
    'automatic_delayed',
    now() + interval '30 minutes',
    'ready',
    'scheduled',
    now() + interval '30 minutes'
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
    '12c71111-1111-4111-8111-111111111111',
    '12c61111-1111-4111-8111-111111111111',
    1,
    'draft',
    pg_temp.phase_12c_feedback_content(),
    'deepseek-v4-flash'
  ),
  (
    '12c72222-2222-4222-8222-222222222222',
    '12c62222-2222-4222-8222-222222222222',
    1,
    'draft',
    pg_temp.phase_12c_feedback_content(),
    'deepseek-v4-flash'
  ),
  (
    '12c73333-3333-4333-8333-333333333333',
    '12c63333-3333-4333-8333-333333333333',
    1,
    'draft',
    pg_temp.phase_12c_feedback_content(),
    'deepseek-v4-flash'
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
  where submission.id = '12c63333-3333-4333-8333-333333333333'
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
  '12c81111-1111-4111-8111-111111111111',
  'writing_evaluation',
  'writing_evaluation',
  '12c63333-3333-4333-8333-333333333333',
  1,
  'phase12c:writing:12c63333-3333-4333-8333-333333333333:1',
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
  '12c81111-1111-4111-8111-111111111111',
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
  repeat('b', 64),
  'deepseek',
  'deepseek-v4-flash'
from app_private.feedback_drafts draft
join app_private.writing_evaluation_contexts context
  on context.submission_id = draft.submission_id
where draft.id = '12c73333-3333-4333-8333-333333333333';

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '12c11111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '12c11111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.release_feedback(
      '12c62222-2222-4222-8222-222222222222',
      '12c72222-2222-4222-8222-222222222222'
    )
  $$,
  '55000',
  'Scheduled feedback is read-only until its automatic release.',
  'a teacher still cannot release scheduled feedback before its due time'
);

select throws_ok(
  $$
    select api.update_feedback_draft(
      '12c72222-2222-4222-8222-222222222222',
      jsonb_set(
        api.get_feedback_draft(
          '12c62222-2222-4222-8222-222222222222'
        ) #> '{draft,content}',
        '{overall_summary}',
        to_jsonb('An early edit that must remain blocked.'::text)
      ),
      1
    )
  $$,
  '55000',
  'Scheduled feedback is read-only until its automatic release.',
  'a teacher still cannot edit scheduled feedback before its due time'
);

select throws_ok(
  $$
    select api.update_feedback_draft(
      '12c71111-1111-4111-8111-111111111111',
      jsonb_set(
        api.get_feedback_draft(
          '12c61111-1111-4111-8111-111111111111'
        ) #> '{draft,content}',
        '{overall_summary}',
        to_jsonb('An overdue edit that must remain blocked.'::text)
      ),
      1
    )
  $$,
  '55000',
  'Overdue scheduled feedback can be released but not edited.',
  'an overdue scheduled draft remains immutable'
);

select is(
  (
    api.get_feedback_draft(
      '12c61111-1111-4111-8111-111111111111'
    ) #>> '{draft,revision}'
  )::integer,
  1,
  'a rejected overdue edit leaves the draft revision unchanged'
);

reset role;

select throws_ok(
  $$
    update app_private.feedback_drafts draft
    set submission_id = '12c62222-2222-4222-8222-222222222222'
    where draft.id = '12c71111-1111-4111-8111-111111111111'
  $$,
  '55000',
  'Feedback version identity is immutable.',
  'authenticated execution cannot swap the submission identity before authorization'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '12c33333-3333-4333-8333-333333333333',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '12c33333-3333-4333-8333-333333333333',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.release_feedback(
      '12c61111-1111-4111-8111-111111111111',
      '12c71111-1111-4111-8111-111111111111'
    )
  $$,
  '42501',
  'Feedback version not found or access denied.',
  'a student cannot use the overdue rescue for their own submission'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '12c22222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '12c22222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $$
    select api.release_feedback(
      '12c61111-1111-4111-8111-111111111111',
      '12c71111-1111-4111-8111-111111111111'
    )
  $$,
  '42501',
  'Feedback version not found or access denied.',
  'an overdue deadline does not bypass cross-workspace authorization'
);

reset role;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '12c11111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '12c11111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  api.release_feedback(
    '12c61111-1111-4111-8111-111111111111',
    '12c71111-1111-4111-8111-111111111111'
  ) ->> 'release_status',
  'released',
  'an authorized teacher can rescue validated scheduled feedback after it is due'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = '12c61111-1111-4111-8111-111111111111'
      and submission.status = 'checked'
      and submission.evaluation_status = 'ready'
      and submission.release_status = 'released'
      and submission.corrected_text = 'Alles gut.'
      and submission.overall_summary = 'The writing is correct.'
  ),
  'the overdue rescue atomically materializes the complete feedback'
);

select is(
  (
    select count(*)::integer
    from public.submission_lines line
    where line.submission_id = '12c61111-1111-4111-8111-111111111111'
  ),
  1,
  'the overdue rescue exposes the complete validated line set'
);

reset role;

select ok(
  (
    select count(*) = 2
      and count(*) filter (where event_type = 'teacher_approved') = 1
      and count(*) filter (where event_type = 'teacher_released') = 1
      and bool_and(actor_id = '12c11111-1111-4111-8111-111111111111')
    from app_private.feedback_draft_events event
    where event.feedback_draft_id = '12c71111-1111-4111-8111-111111111111'
  ),
  'the manual rescue retains its authorized approval and release audit trail'
);

set local role authenticated;

select is(
  api.release_feedback(
    '12c61111-1111-4111-8111-111111111111',
    '12c71111-1111-4111-8111-111111111111'
  ) ->> 'release_status',
  'released',
  'repeating the manual rescue returns the existing terminal result'
);

reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select is(
  (
    select count(*)::integer
    from app_private.feedback_draft_events event
    where event.feedback_draft_id = '12c71111-1111-4111-8111-111111111111'
  ),
  2,
  'an idempotent repeated rescue does not duplicate audit events'
);

select is(
  app_private.release_due_feedback_internal(100),
  0,
  'the automatic release worker safely skips feedback already rescued by a teacher'
);

update public.submissions submission
set
  feedback_scheduled_at = now() - interval '1 minute',
  release_at = now() - interval '1 minute'
where submission.id = '12c63333-3333-4333-8333-333333333333';

select is(
  app_private.release_due_feedback_internal(100),
  1,
  'the automatic worker can win the release race and release exactly one due draft'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    join app_private.feedback_drafts draft
      on draft.submission_id = submission.id
    where submission.id = '12c63333-3333-4333-8333-333333333333'
      and submission.release_status = 'released'
      and submission.corrected_text = 'Alles gut.'
      and draft.state = 'released'
      and draft.released_by is null
  ),
  'the automatic winner commits one complete system release'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '12c11111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '12c11111-1111-4111-8111-111111111111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select is(
  api.release_feedback(
    '12c63333-3333-4333-8333-333333333333',
    '12c73333-3333-4333-8333-333333333333'
  ) ->> 'release_status',
  'released',
  'a teacher arriving after the automatic winner receives an idempotent result'
);

reset role;

select is(
  (
    select count(*)::integer
    from app_private.feedback_draft_events event
    where event.feedback_draft_id = '12c73333-3333-4333-8333-333333333333'
  ),
  0,
  'an automatic winner does not fabricate teacher audit events'
);

select ok(
  exists (
    select 1
    from public.submissions submission
    where submission.id = '12c62222-2222-4222-8222-222222222222'
      and submission.release_status = 'scheduled'
      and submission.corrected_text is null
  ),
  'future scheduled feedback remains private throughout both race orders'
);

select is(
  (
    select count(*)::integer
    from public.submissions submission
    where submission.release_status = 'scheduled'
      and submission.release_at <= now()
      and submission.id in (
        '12c61111-1111-4111-8111-111111111111',
        '12c63333-3333-4333-8333-333333333333'
      )
  ),
  0,
  'neither release race leaves an overdue scheduled row behind'
);

select * from finish();
rollback;
