begin;

-- Shared-staging-safe: every write is fixture-scoped and rolls back. This test
-- never purges a queue or deletes unrelated jobs.

select plan(48);

select ok(
  to_regprocedure(
    'app_private.assert_writing_input_contract(text,boolean)'
  ) is not null,
  'the shared V1 writing-input contract exists'
);

select ok(
  exists (
    select 1
    from pg_proc routine
    where routine.oid =
      'app_private.assert_writing_input_contract(text,boolean)'::regprocedure
      and routine.prosecdef
      and exists (
        select 1
        from unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting ~ '^search_path=(""|)$'
      )
  )
    and not has_function_privilege(
      'authenticated',
      'app_private.assert_writing_input_contract(text,boolean)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.assert_writing_input_contract(text,boolean)',
      'EXECUTE'
    ),
  'the shared validator is a pinned private definer with no gateway grant'
);

select ok(
  pg_get_functiondef(
    'app_private.assert_writing_draft_content(text,boolean)'::regprocedure
  ) like '%assert_writing_input_contract(value, allow_blank)%',
  'draft saving delegates to the shared V1 contract'
);

select ok(
  pg_get_functiondef(
    'app_private.create_writing_submission_internal(text,uuid,uuid,text,boolean)'::regprocedure
  ) like '%assert_writing_input_contract(answer_text, false)%',
  'direct and draft-backed submission delegate to the same V1 contract'
);

select lives_ok(
  $$
    select app_private.assert_writing_input_contract(repeat('a', 4000), false)
  $$,
  'exactly 4,000 Unicode characters are accepted'
);

select throws_ok(
  $$
    select app_private.assert_writing_input_contract(repeat('a', 4001), false)
  $$,
  '22023',
  'writing_text_too_long',
  '4,001 characters are rejected before enqueueing'
);

select lives_ok(
  $$
    select app_private.assert_writing_input_contract(repeat('🙂', 4000), false)
  $$,
  'the 4,000-character boundary counts Unicode code points rather than bytes'
);

select throws_ok(
  $$
    select app_private.assert_writing_input_contract(repeat('🙂', 4001), false)
  $$,
  '22023',
  'writing_text_too_long',
  'the Unicode boundary rejects the 4,001st code point'
);

select is(
  app_private.writing_feedback_unit_count((
    select string_agg(
      format('Heute lerne ich Wort Nummer %s gut.', unit_number),
      ' '
    )
    from generate_series(1, 40) unit_number
  )),
  40,
  'the exact 40-unit fixture is segmented as expected'
);

select lives_ok(
  $$
    select app_private.assert_writing_input_contract((
      select string_agg(
        format('Heute lerne ich Wort Nummer %s gut.', unit_number),
        ' '
      )
      from generate_series(1, 40) unit_number
    ), false)
  $$,
  'exactly 40 German-aware feedback units are accepted'
);

select is(
  app_private.writing_feedback_unit_count((
    select string_agg(
      format('Heute lerne ich Wort Nummer %s gut.', unit_number),
      ' '
    )
    from generate_series(1, 41) unit_number
  )),
  41,
  'the 41-unit rejection fixture is segmented as expected'
);

select throws_ok(
  $$
    select app_private.assert_writing_input_contract((
      select string_agg(
        format('Heute lerne ich Wort Nummer %s gut.', unit_number),
        ' '
      )
      from generate_series(1, 41) unit_number
    ), false)
  $$,
  '22023',
  'writing_too_many_units',
  'the 41st feedback unit is rejected before enqueueing'
);

select throws_ok(
  $$
    select *
    from app_private.create_writing_submission_internal(
      'free_text',
      null,
      null,
      repeat('a', 4001),
      false
    )
  $$,
  '22023',
  'writing_text_too_long',
  'the submission creator returns the stable 4,001-character error before any write'
);

select throws_ok(
  $$
    select *
    from app_private.create_writing_submission_internal(
      'free_text',
      null,
      null,
      (
        select string_agg(
          format('Heute lerne ich Wort Nummer %s gut.', unit_number),
          ' '
        )
        from generate_series(1, 41) unit_number
      ),
      false
    )
  $$,
  '22023',
  'writing_too_many_units',
  'the submission creator returns the stable 41-unit error before any write'
);

select lives_ok(
  $$
    select app_private.assert_writing_draft_content('', true)
  $$,
  'an existing draft may still be cleared intentionally'
);

select throws_ok(
  $$
    select app_private.assert_writing_draft_content('', false)
  $$,
  '22023',
  'writing_text_required',
  'a blank draft cannot be submitted'
);

select throws_ok(
  $$
    select app_private.assert_writing_draft_content('', null)
  $$,
  '22023',
  'writing_text_required',
  'a null allow-blank flag fails closed'
);

select throws_ok(
  $$
    select app_private.assert_writing_input_contract('Hallo' || chr(1), false)
  $$,
  '22023',
  'writing_text_invalid',
  'unsupported control characters remain rejected by the shared contract'
);

select ok(
  to_regprocedure(
    'app_private.assert_feedback_completion_text_limits(jsonb)'
  ) is not null
    and not has_function_privilege(
      'authenticated',
      'app_private.assert_feedback_completion_text_limits(jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app_private.assert_feedback_completion_text_limits(jsonb)',
      'EXECUTE'
    ),
  'the feedback text-limit validator is private and not gateway callable'
);

select ok(
  pg_get_functiondef(
    'app_private.validate_feedback_draft_size()'::regprocedure
  ) like '%assert_feedback_completion_text_limits(new.content)%',
  'feedback-draft persistence delegates to the database-aligned text limits'
);

select lives_ok(
  $$
    select app_private.assert_feedback_completion_text_limits(
      jsonb_build_object(
        'overall_summary', repeat('s', 8000),
        'corrected_text', repeat('c', 4000),
        'lines', jsonb_build_array(jsonb_build_object(
          'original_line', 'a',
          'corrected_line', repeat('c', 4000),
          'status', 'correct',
          'short_explanation', repeat('e', 4000),
          'detailed_explanation', repeat('d', 8000),
          'changed_parts', '[]'::jsonb
        )),
        'grammar_topics', jsonb_build_array(jsonb_build_object(
          'simple_explanation', repeat('t', 4000)
        ))
      )
    )
  $$,
  'database feedback fields accept every exact V1 boundary'
);

select throws_ok(
  $$
    select app_private.assert_feedback_completion_text_limits(
      jsonb_build_object(
        'overall_summary', repeat('s', 8001),
        'corrected_text', 'a',
        'lines', jsonb_build_array(jsonb_build_object(
          'original_line', 'a', 'corrected_line', 'a', 'status', 'correct',
          'short_explanation', '', 'detailed_explanation', '',
          'changed_parts', '[]'::jsonb
        )),
        'grammar_topics', '[]'::jsonb
      )
    )
  $$,
  '22023',
  'feedback_text_limits_invalid',
  'the 8,001st summary character is rejected'
);

select throws_ok(
  $$
    select app_private.assert_feedback_completion_text_limits(
      jsonb_build_object(
        'overall_summary', 'summary', 'corrected_text', 'b',
        'lines', jsonb_build_array(jsonb_build_object(
          'original_line', 'a', 'corrected_line', 'b',
          'status', 'minor_issue',
          'short_explanation', repeat('e', 4001),
          'detailed_explanation', '', 'changed_parts', '[]'::jsonb
        )),
        'grammar_topics', '[]'::jsonb
      )
    )
  $$,
  '22023',
  'feedback_text_limits_invalid',
  'the 4,001st student-facing explanation character is rejected'
);

select throws_ok(
  $$
    select app_private.assert_feedback_completion_text_limits(
      jsonb_build_object(
        'overall_summary', 'summary', 'corrected_text', 'b',
        'lines', jsonb_build_array(jsonb_build_object(
          'original_line', 'a', 'corrected_line', 'b',
          'status', 'minor_issue', 'short_explanation', 'explain',
          'detailed_explanation', repeat('d', 8001),
          'changed_parts', '[]'::jsonb
        )),
        'grammar_topics', '[]'::jsonb
      )
    )
  $$,
  '22023',
  'feedback_text_limits_invalid',
  'the 8,001st detailed-explanation character is rejected'
);

select throws_ok(
  $$
    select app_private.assert_feedback_completion_text_limits(
      jsonb_build_object(
        'overall_summary', 'summary', 'corrected_text', 'b',
        'lines', jsonb_build_array(jsonb_build_object(
          'original_line', 'a', 'corrected_line', 'b',
          'status', 'minor_issue', 'short_explanation', '   ',
          'detailed_explanation', 'internal detail',
          'changed_parts', '[]'::jsonb
        )),
        'grammar_topics', '[]'::jsonb
      )
    )
  $$,
  '22023',
  'feedback_text_limits_invalid',
  'an issue cannot substitute internal detail for student-facing explanation'
);

select throws_ok(
  $$
    select app_private.assert_feedback_completion_text_limits(
      jsonb_build_object(
        'overall_summary', 'summary', 'corrected_text', 'a',
        'lines', jsonb_build_array(jsonb_build_object(
          'original_line', 'a', 'corrected_line', 'a', 'status', 'correct',
          'short_explanation', '', 'detailed_explanation', '',
          'changed_parts', '[]'::jsonb
        )),
        'grammar_topics', jsonb_build_array(jsonb_build_object(
          'simple_explanation', repeat('t', 4001)
        ))
      )
    )
  $$,
  '22023',
  'feedback_text_limits_invalid',
  'the 4,001st topic-explanation character is rejected'
);

select lives_ok(
  $$
    select app_private.assert_feedback_completion_text_limits(
      jsonb_build_object(
        'overall_summary', 'summary',
        'corrected_text', repeat('a', 40),
        'lines', (
          select jsonb_agg(jsonb_build_object(
            'original_line', 'a', 'corrected_line', 'a', 'status', 'correct',
            'short_explanation', '', 'detailed_explanation', '',
            'changed_parts', '[]'::jsonb
          ))
          from generate_series(1, 40)
        ),
        'grammar_topics', '[]'::jsonb
      )
    )
  $$,
  'the database accepts exactly 40 durable feedback lines'
);

select throws_ok(
  $$
    select app_private.assert_feedback_completion_text_limits(
      jsonb_build_object(
        'overall_summary', 'summary',
        'corrected_text', repeat('a', 41),
        'lines', (
          select jsonb_agg(jsonb_build_object(
            'original_line', 'a', 'corrected_line', 'a', 'status', 'correct',
            'short_explanation', '', 'detailed_explanation', '',
            'changed_parts', '[]'::jsonb
          ))
          from generate_series(1, 41)
        ),
        'grammar_topics', '[]'::jsonb
      )
    )
  $$,
  '22023',
  'feedback_text_limits_invalid',
  'the database rejects the 41st durable feedback line'
);

-- The following fixture-scoped transaction calls the same authenticated RPCs
-- as the browser without mutating unrelated queue or job state.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'd2111111-1111-4111-8111-111111111111',
    'authenticated', 'authenticated', 'phase12d-teacher@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12D Teacher"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd2222222-2222-4222-8222-222222222222',
    'authenticated', 'authenticated', 'phase12d-student@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Phase 12D Student"}'::jsonb, now(), now()
  );

insert into public.workspaces (id, name, slug, owner_id)
values (
  'd2333333-3333-4333-8333-333333333333',
  'Phase 12D Workspace', 'phase-12d-workspace',
  'd2111111-1111-4111-8111-111111111111'
);

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    'd2333333-3333-4333-8333-333333333333',
    'd2111111-1111-4111-8111-111111111111', 'teacher'
  ),
  (
    'd2333333-3333-4333-8333-333333333333',
    'd2222222-2222-4222-8222-222222222222', 'student'
  );

insert into public.batches (
  id, workspace_id, name, level, is_active, feedback_mode
)
values (
  'd2444444-4444-4444-8444-444444444444',
  'd2333333-3333-4333-8333-333333333333',
  'Phase 12D A2', 'A2', true, 'immediate'
);

insert into public.batch_students (id, batch_id, student_id, workspace_id)
values (
  'd2555555-5555-4555-8555-555555555555',
  'd2444444-4444-4444-8444-444444444444',
  'd2222222-2222-4222-8222-222222222222',
  'd2333333-3333-4333-8333-333333333333'
);

insert into public.questions (
  id, workspace_id, title, prompt, level, topic, task_type, is_active
)
values (
  'd2666666-6666-4666-8666-666666666666',
  'd2333333-3333-4333-8333-333333333333',
  'Phase 12D writing', 'Schreibe einen kurzen Text.',
  'A2', 'Alltag', 'writing', true
);

create temporary table phase_12d_state (
  singleton boolean primary key default true check (singleton),
  exact_submission_id uuid,
  forty_submission_id uuid,
  draft_id uuid,
  draft_revision integer,
  recovered_submission_id uuid
) on commit drop;
insert into phase_12d_state default values;
grant select, update on phase_12d_state to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'd2222222-2222-4222-8222-222222222222',
    'role', 'authenticated'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  'd2222222-2222-4222-8222-222222222222',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

with submitted as (
  select *
  from api.submit_writing(
    'd2444444-4444-4444-8444-444444444444',
    'free_text', null, repeat('a', 4000)
  )
)
update pg_temp.phase_12d_state state
set exact_submission_id = submitted.submission_id
from submitted
where state.singleton;

select ok(
  (select exact_submission_id is not null from phase_12d_state),
  'an authenticated direct submit accepts exactly 4,000 characters'
);

reset role;
select is(
  (
    select submission.original_text
    from public.submissions submission
    where submission.id = (
      select exact_submission_id from phase_12d_state where singleton
    )
  ),
  repeat('a', 4000),
  'the exact direct submission is stored without trimming or truncation'
);
set local role authenticated;

select throws_ok(
  $$
    select * from api.submit_writing(
      'd2444444-4444-4444-8444-444444444444',
      'free_text', null, repeat('a', 4001)
    )
  $$,
  '22023', 'writing_text_too_long',
  'authenticated direct submit rejects the 4,001st character'
);

reset role;
select ok(
  (select count(*) from public.submissions
   where student_id = 'd2222222-2222-4222-8222-222222222222') = 1
    and (select count(*) from app_private.async_jobs
         where requested_by = 'd2222222-2222-4222-8222-222222222222') = 1
    and (
      select count(*)
      from app_private.async_jobs job
      join pgmq.q_writing_evaluation queue
        on queue.msg_id = job.queue_message_id
      where job.requested_by = 'd2222222-2222-4222-8222-222222222222'
    ) = 1
    and (select submission_count
         from app_private.writing_submission_batch_daily_usage
         where workspace_id = 'd2333333-3333-4333-8333-333333333333'
           and batch_id = 'd2444444-4444-4444-8444-444444444444'
           and student_id = 'd2222222-2222-4222-8222-222222222222'
           and usage_day = app_private.india_writing_usage_day(now())) = 1,
  'a rejected direct submit creates no row, quota use, job, or queue message'
);
set local role authenticated;

with saved as (
  select * from api.save_writing_draft(
    null,
    'd2444444-4444-4444-8444-444444444444',
    'free_text', null, repeat('d', 4000), 0
  )
)
update pg_temp.phase_12d_state state
set draft_id = saved.saved_draft_id,
    draft_revision = saved.saved_revision
from saved
where state.singleton;

select ok(
  (select draft_id is not null and draft_revision = 1 from phase_12d_state),
  'authenticated draft save accepts exactly 4,000 characters'
);

select is(
  (
    select "text"
    from api.get_writing_draft(
      (select draft_id from phase_12d_state where singleton)
    )
  ),
  repeat('d', 4000),
  'the exact draft is returned without truncation at revision one'
);

select throws_ok(
  format(
    'select * from api.save_writing_draft(%L,%L,%L,null,repeat(''x'',4001),1)',
    (select draft_id from phase_12d_state where singleton),
    'd2444444-4444-4444-8444-444444444444',
    'free_text'
  ),
  '22023', 'writing_text_too_long',
  'updating a draft rejects the 4,001st character'
);

select ok(
  (
    select "text" = repeat('d', 4000) and revision = 1
    from api.get_writing_draft(
      (select draft_id from phase_12d_state where singleton)
    )
  ),
  'a rejected draft update preserves the prior content and revision'
);

select throws_ok(
  $$
    select * from api.save_writing_draft(
      null,
      'd2444444-4444-4444-8444-444444444444',
      'workspace_question',
      'd2666666-6666-4666-8666-666666666666',
      repeat('x', 4001), 0
    )
  $$,
  '22023', 'writing_text_too_long',
  'a new authenticated draft also rejects the 4,001st character'
);

reset role;
select is(
  (
    select count(*)::integer
    from app_private.writing_drafts draft
    where draft.student_id = 'd2222222-2222-4222-8222-222222222222'
  ),
  1,
  'a rejected new draft save creates no private draft row'
);
set local role authenticated;

with submitted as (
  select * from api.submit_writing(
    'd2444444-4444-4444-8444-444444444444',
    'free_text', null,
    (
      select string_agg(
        format('Heute lerne ich Wort Nummer %s gut.', unit_number),
        ' '
      )
      from generate_series(1, 40) unit_number
    )
  )
)
update pg_temp.phase_12d_state state
set forty_submission_id = submitted.submission_id
from submitted
where state.singleton;

select ok(
  (select forty_submission_id is not null from phase_12d_state),
  'the authenticated submit path accepts exactly 40 feedback units'
);

select throws_ok(
  $$
    select * from api.submit_writing(
      'd2444444-4444-4444-8444-444444444444',
      'free_text', null,
      (
        select string_agg(
          format('Heute lerne ich Wort Nummer %s gut.', unit_number),
          ' '
        )
        from generate_series(1, 41) unit_number
      )
    )
  $$,
  '22023', 'writing_too_many_units',
  'the authenticated submit path rejects the 41st feedback unit'
);

reset role;
select ok(
  (select count(*) from public.submissions
   where student_id = 'd2222222-2222-4222-8222-222222222222') = 2
    and (select count(*) from app_private.async_jobs
         where requested_by = 'd2222222-2222-4222-8222-222222222222') = 2
    and (
      select count(*)
      from app_private.async_jobs job
      join pgmq.q_writing_evaluation queue
        on queue.msg_id = job.queue_message_id
      where job.requested_by = 'd2222222-2222-4222-8222-222222222222'
    ) = 2
    and (select submission_count
         from app_private.writing_submission_batch_daily_usage
         where workspace_id = 'd2333333-3333-4333-8333-333333333333'
           and batch_id = 'd2444444-4444-4444-8444-444444444444'
           and student_id = 'd2222222-2222-4222-8222-222222222222'
           and usage_day = app_private.india_writing_usage_day(now())) = 2,
  'the rejected 41-unit submission creates no durable side effects'
);

insert into app_private.writing_drafts (
  id, workspace_id, student_id, batch_id, source_type, source_id,
  content, revision
)
values (
  'd2777777-7777-4777-8777-777777777777',
  'd2333333-3333-4333-8333-333333333333',
  'd2222222-2222-4222-8222-222222222222',
  'd2444444-4444-4444-8444-444444444444',
  'workspace_question', 'd2666666-6666-4666-8666-666666666666',
  repeat('l', 4001), 1
);
set local role authenticated;

select throws_ok(
  $$
    select * from api.submit_writing_draft(
      'd2777777-7777-4777-8777-777777777777', 1
    )
  $$,
  '22023', 'writing_text_too_long',
  'draft-backed submit rejects a legacy 4,001-character draft'
);

reset role;
select ok(
  exists (
    select 1 from app_private.writing_drafts draft
    where draft.id = 'd2777777-7777-4777-8777-777777777777'
      and draft.content = repeat('l', 4001)
      and draft.revision = 1
  ),
  'a rejected legacy draft submission preserves its content and revision'
);

select ok(
  (select count(*) from public.submissions
   where student_id = 'd2222222-2222-4222-8222-222222222222') = 2
    and (select count(*) from app_private.async_jobs
         where requested_by = 'd2222222-2222-4222-8222-222222222222') = 2
    and (
      select count(*)
      from app_private.async_jobs job
      join pgmq.q_writing_evaluation queue
        on queue.msg_id = job.queue_message_id
      where job.requested_by = 'd2222222-2222-4222-8222-222222222222'
    ) = 2
    and (select submission_count
         from app_private.writing_submission_batch_daily_usage
         where workspace_id = 'd2333333-3333-4333-8333-333333333333'
           and batch_id = 'd2444444-4444-4444-8444-444444444444'
           and student_id = 'd2222222-2222-4222-8222-222222222222'
           and usage_day = app_private.india_writing_usage_day(now())) = 2,
  'a rejected legacy draft submission consumes no quota, job, or message'
);
set local role authenticated;

with saved as (
  select * from api.save_writing_draft(
    'd2777777-7777-4777-8777-777777777777',
    'd2444444-4444-4444-8444-444444444444',
    'workspace_question',
    'd2666666-6666-4666-8666-666666666666',
    repeat('r', 4000), 1
  )
)
update pg_temp.phase_12d_state state
set draft_revision = saved.saved_revision
from saved
where state.singleton;

select ok(
  (
    select revision = 2 and "text" = repeat('r', 4000)
    from api.get_writing_draft('d2777777-7777-4777-8777-777777777777')
  ),
  'a legacy oversized draft can be recovered by shrinking it to the V1 bound'
);

with submitted as (
  select * from api.submit_writing_draft(
    'd2777777-7777-4777-8777-777777777777', 2
  )
)
update pg_temp.phase_12d_state state
set recovered_submission_id = submitted.submission_id
from submitted
where state.singleton;

select ok(
  (select recovered_submission_id is not null from phase_12d_state)
    and not exists (
      select 1
      from api.get_writing_draft('d2777777-7777-4777-8777-777777777777')
    ),
  'the recovered draft submits successfully and is deleted atomically'
);

reset role;
select is(
  (
    select submission.original_text
    from public.submissions submission
    where submission.id = (
      select recovered_submission_id from phase_12d_state where singleton
    )
  ),
  repeat('r', 4000),
  'the recovered draft submission preserves all 4,000 characters'
);

select ok(
  (select count(*) from public.submissions
   where student_id = 'd2222222-2222-4222-8222-222222222222') = 3
    and (select count(*) from app_private.async_jobs
         where requested_by = 'd2222222-2222-4222-8222-222222222222') = 3
    and (
      select count(*)
      from app_private.async_jobs job
      join pgmq.q_writing_evaluation queue
        on queue.msg_id = job.queue_message_id
      where job.requested_by = 'd2222222-2222-4222-8222-222222222222'
    ) = 3
    and (select submission_count
         from app_private.writing_submission_batch_daily_usage
         where workspace_id = 'd2333333-3333-4333-8333-333333333333'
           and batch_id = 'd2444444-4444-4444-8444-444444444444'
           and student_id = 'd2222222-2222-4222-8222-222222222222'
           and usage_day = app_private.india_writing_usage_day(now())) = 3,
  'only the three accepted writings consume quota and queue work'
);

select * from finish();
rollback;
